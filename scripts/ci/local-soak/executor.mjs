/**
 * Executes planned soak operations through the public EntityManager.
 *
 * Each executor returns one redacted record: `{ kind, table, status,
 * code?, reason?, counts?, durationMs }` where `status` is `ok`,
 * `expected_error`, or `failed`. Raw field values, ids, and error messages
 * never enter the records — they stay in the process memory only. Failures
 * carry a stable redacted `reason` category from FAILURE_REASON_CODES plus,
 * for library errors, the stable HikouteiError `code`.
 *
 * Expected validation failures assert the documented stable code from
 * `HIKOUTEI_ERROR_CODES`; anything else (or any unexpected throw) marks the
 * operation `failed`, which the runner counts toward the consecutive
 * failure stop.
 */

import { HIKOUTEI_ERROR_CODES } from "hikoutei";
import {
  EXPECTED_ERROR_CODES,
  FAILURE_REASON_CODES,
  KNOWN_STABLE_CODES,
  sanitizeStableCode,
} from "./redact.mjs";

// Re-exported from redact.mjs so existing executor imports stay valid; the
// allowlists and sanitizers live next to the other artifact redactors.
export { EXPECTED_ERROR_CODES, FAILURE_REASON_CODES, KNOWN_STABLE_CODES, sanitizeStableCode };

/**
 * Executor-owned assertion failure carrying a stable redacted category.
 * The message exists for process-memory debugging only and is never
 * recorded in artifacts.
 */
export class SoakAssertionError extends Error {
  constructor(reasonCode, message) {
    super(message);
    this.name = "SoakAssertionError";
    this.reasonCode = reasonCode;
  }
}

/**
 * Executes one planned operation.
 *
 * @param {object} op planned operation from planActorOperation().
 * @param {object} ctx { em, oracle, tokenByEntity, fieldPlans }
 * @returns {Promise<{ status: "ok"|"expected_error"|"failed", code?: string, detail?: Record<string, number> }>}
 */
export async function executeActorOperation(op, ctx) {
  const token = ctx.tokenByEntity.get(op.entityName);
  const fieldPlan = ctx.fieldPlans[op.entityName];
  const oracle = ctx.oracle;
  const em = ctx.em;
  const startedAt = Date.now();
  const finishOk = (counts = {}) => ({ status: "ok", counts, durationMs: Date.now() - startedAt });
  const finishExpected = (code) => ({ status: "expected_error", code, durationMs: Date.now() - startedAt });
  try {
    switch (op.kind) {
      case "create": {
        // Replay reconciliation: a create whose deterministic id already
        // exists (committed by the interrupted run) is accepted when its
        // content matches; a content mismatch is a real failure.
        if (ctx.reconcile === true &&
            (await reconcileExistingRow(ctx, op.entityName, op.mutateId, { id: op.mutateId, ...op.row }))) {
          return finishOk({ reconciled: 1 });
        }
        const entity = em.create(token, { id: op.mutateId, ...op.row });
        em.persist(entity);
        await em.flush();
        oracle.applyMutation({ op: "insert", entity: op.entityName, row: { id: op.mutateId, ...op.row } });
        return finishOk();
      }
      case "update": {
        const loaded = await em.findOne(token, { id: op.updateTarget });
        if (loaded === null) {
          // Actor-scoped row may not exist yet this cycle: create instead so
          // the deterministic final state still contains the id.
          const entity = em.create(token, { id: op.mutateId, ...rowForCreate(op, fieldPlan) });
          em.persist(entity);
          await em.flush();
          oracle.applyMutation({ op: "insert", entity: op.entityName, row: { id: op.mutateId, ...rowForCreate(op, fieldPlan) } });
          return finishOk();
        }
        Object.assign(loaded, op.patch);
        em.persist(loaded);
        await em.flush();
        oracle.applyMutation({ op: "update", entity: op.entityName, id: op.updateTarget, patch: op.patch });
        return finishOk();
      }
      case "delete": {
        const loaded = await em.findOne(token, { id: op.deleteTarget });
        if (loaded === null) return finishOk({ skipped: 1 });
        em.remove(loaded);
        await em.flush();
        oracle.applyMutation({ op: "delete", entity: op.entityName, id: op.deleteTarget });
        return finishOk();
      }
      case "batchPersist": {
        const rows = [{ id: op.mutateId, ...op.row }, ...op.extraRows.map((row, index) => ({
          id: `${op.mutateId}-x${index}`,
          ...row,
        }))];
        if (ctx.reconcile === true) {
          // Replay reconciliation: each row of the batch is inserted only
          // when absent; already-committed rows are accepted when their
          // content matches (the interrupted run's batch flush was atomic,
          // but per-row tolerance keeps the contract robust).
          const toInsert = [];
          let reconciled = 0;
          for (const row of rows) {
            if (await reconcileExistingRow(ctx, op.entityName, row.id, row)) {
              reconciled += 1;
            } else {
              toInsert.push(row);
            }
          }
          if (toInsert.length > 0) {
            const entities = toInsert.map((row) => em.create(token, row));
            em.persist(entities);
            await em.flush();
            for (const row of toInsert) {
              oracle.applyMutation({ op: "insert", entity: op.entityName, row });
            }
          }
          return finishOk({ inserted: toInsert.length, reconciled });
        }
        const entities = rows.map((row) => em.create(token, row));
        em.persist(entities);
        await em.flush();
        for (const row of rows) {
          oracle.applyMutation({ op: "insert", entity: op.entityName, row });
        }
        return finishOk({ inserted: rows.length });
      }
      case "noOpFlush": {
        await em.flush();
        return finishOk();
      }
      case "findFiltered": {
        const rows = await em.find(token, op.filter);
        assertIdSetMatches(oracle, op, rows, fieldPlan);
        return finishOk({ matched: rows.length });
      }
      case "findPaged": {
        const rows = await em.find(token, op.filter, {
          orderBy: op.orderBy,
          limit: op.limit,
          offset: op.offset,
        });
        const expected = oracle.query(op.entityName, {
          where: op.filter,
          orderBy: op.orderBy,
          limit: op.limit,
          offset: op.offset,
        });
        const actualIds = rows.map((row) => String(row.id));
        if (JSON.stringify(actualIds) !== JSON.stringify(expected.ids)) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.QUERY_MISMATCH,
            `paged result mismatch on ${op.entityName}: expected ${expected.ids.length} ids in order, received ${actualIds.length}`,
          );
        }
        return finishOk({ matched: rows.length });
      }
      case "findOne": {
        const row = await em.findOne(token, { id: op.lookupId });
        const expectedRow = oracle.row(op.entityName, op.lookupId);
        if ((row === null) !== (expectedRow === undefined)) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.PRESENCE_MISMATCH,
            `findOne presence mismatch on ${op.entityName}`,
          );
        }
        if (row !== null && expectedRow !== undefined) {
          assertRowMatches(expectedRow, row, fieldPlan);
        }
        return finishOk({ found: row === null ? 0 : 1 });
      }
      case "count": {
        const expected = oracle.query(op.entityName, { where: op.filter });
        const actual = await em.count(token, op.filter);
        if (actual !== expected.total) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.QUERY_MISMATCH,
            `count mismatch on ${op.entityName}: expected ${expected.total}, received ${actual}`,
          );
        }
        return finishOk({ count: actual });
      }
      case "findAndCount": {
        const expected = oracle.query(op.entityName, { where: op.filter });
        const [rows, total] = await em.findAndCount(token, op.filter);
        const actualIds = new Set(rows.map((row) => String(row.id)));
        const expectedIds = new Set(expected.ids);
        if (actualIds.size !== expectedIds.size || total !== expected.total) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.QUERY_MISMATCH,
            `findAndCount mismatch on ${op.entityName}: expected ${expected.total}, received ${total}`,
          );
        }
        for (const id of expectedIds) {
          if (!actualIds.has(id)) {
            throw new SoakAssertionError(
              FAILURE_REASON_CODES.QUERY_MISMATCH,
              `findAndCount missing id on ${op.entityName}`,
            );
          }
        }
        return finishOk({ count: total });
      }
      case "limitZero": {
        const rows = await em.find(token, {}, { limit: 0, orderBy: { id: "asc" } });
        if (rows.length !== 0) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.QUERY_MISMATCH,
            `limit 0 must return an empty page on ${op.entityName}`,
          );
        }
        return finishOk();
      }
      case "offsetOnly": {
        const offset = 2;
        const rows = await em.find(token, {}, { offset, orderBy: { id: "asc" } });
        const expected = oracle.query(op.entityName, { orderBy: { id: "asc" }, offset });
        const actualIds = rows.map((row) => String(row.id));
        if (JSON.stringify(actualIds) !== JSON.stringify(expected.ids)) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.QUERY_MISMATCH,
            `offset-only page mismatch on ${op.entityName}`,
          );
        }
        return finishOk({ matched: rows.length });
      }
      case "offsetOutOfRange": {
        const offset = oracle.size(op.entityName) + 50;
        const rows = await em.find(token, {}, { offset, orderBy: { id: "asc" } });
        if (rows.length !== 0) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.QUERY_MISMATCH,
            `out-of-range offset must return an empty page on ${op.entityName}`,
          );
        }
        return finishOk();
      }
      case "transactionalCommit": {
        if (ctx.reconcile === true &&
            (await reconcileExistingRow(ctx, op.entityName, op.mutateId, { id: op.mutateId, ...op.row }))) {
          return finishOk({ reconciled: 1 });
        }
        const inserted = await em.transactional(async (manager) => {
          const entity = manager.create(token, { id: op.mutateId, ...op.row });
          manager.persist(entity);
          await manager.flush();
          return true;
        });
        oracle.applyMutation({ op: "insert", entity: op.entityName, row: { id: op.mutateId, ...op.row } });
        return finishOk({ committed: inserted ? 1 : 0 });
      }
      case "transactionalRollback": {
        // The leak check compares SQLite counts on both sides through fresh
        // forks so it never depends on oracle bookkeeping: a rolled-back
        // insert must not be visible in either store.
        const checkFork = ctx.rootEm.fork();
        const before = await checkFork.count(token, {});
        let threw = false;
        try {
          await em.transactional(async (manager) => {
            const entity = manager.create(token, { id: op.mutateId, ...op.row });
            manager.persist(entity);
            await manager.flush();
            throw new Error("soak-intentional-rollback");
          });
        } catch (error) {
          threw = error instanceof Error && error.message === "soak-intentional-rollback";
          if (!threw) throw error;
        }
        if (!threw) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.ROLLBACK_VERIFICATION,
            "transactional callback must rethrow the intentional failure",
          );
        }
        // The transactional fork's identity map may still hold the
        // rolled-back instance, so verification always goes through a fresh
        // fork that must not observe the rolled-back insert.
        const reloaded = await checkFork.findOne(token, { id: op.mutateId });
        if (reloaded !== null) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.ROLLBACK_VERIFICATION,
            "rolled-back insert must not be visible",
          );
        }
        const after = await checkFork.count(token, {});
        if (after !== before) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.ROLLBACK_VERIFICATION,
            `rollback leaked rows on ${op.entityName}: ${before} -> ${after}`,
          );
        }
        return finishOk({ rolledBack: 1 });
      }
      case "expectedInvalidField": {
        let code;
        try {
          em.create(token, { id: op.mutateId, notAField: "x" });
        } catch (error) {
          code = error?.code;
        }
        return expectCode(code, EXPECTED_ERROR_CODES.invalidField, finishExpected);
      }
      case "expectedLikeOnNumber": {
        const numberField = Object.entries(fieldPlan).find(([, spec]) =>
          spec.type === "number")?.[0];
        if (numberField === undefined) return finishOk({ skipped: 1 });
        let code;
        try {
          await em.find(token, { [numberField]: { like: "3%" } });
        } catch (error) {
          code = error?.code;
        }
        return expectCode(code, EXPECTED_ERROR_CODES.invalidQuery, finishExpected);
      }
      case "expectedUnmanagedPersist": {
        let code;
        try {
          em.persist({ id: "unmanaged" });
        } catch (error) {
          code = error?.code;
        }
        return expectCode(code, EXPECTED_ERROR_CODES.unmanagedEntity, finishExpected);
      }
      case "expectedNegativeOffset": {
        let code;
        try {
          await em.find(token, {}, { offset: -1 });
        } catch (error) {
          code = error?.code;
        }
        return expectCode(code, EXPECTED_ERROR_CODES.invalidField, finishExpected);
      }
      case "forkIsolation": {
        let created;
        let reconciled = 0;
        if (ctx.reconcile === true) {
          // Replay reconciliation: the interrupted run may have committed
          // the row pre-patch or post-patch; both deterministic shapes are
          // accepted, and the patch is re-applied below (idempotent).
          const existing = ctx.oracle.row(op.entityName, op.mutateId);
          if (existing !== undefined) {
            const postPatchRow = { id: op.mutateId, ...op.row, ...op.patch };
            if (!rowValuesEqual({ id: op.mutateId, ...op.row }, existing, fieldPlan) &&
                !rowValuesEqual(postPatchRow, existing, fieldPlan)) {
              throw new SoakAssertionError(
                FAILURE_REASON_CODES.RECONCILE_MISMATCH,
                `reconcile mismatch on forkIsolation for ${op.entityName}`,
              );
            }
            reconciled = 1;
          }
        }
        const forkA = ctx.rootEm.fork();
        const forkB = ctx.rootEm.fork();
        if (reconciled === 0) {
          created = forkA.create(token, { id: op.mutateId, ...op.row });
          forkA.persist(created);
          await forkA.flush();
        }
        // forkB must observe the committed row but own an independent
        // instance; mutating it must not change forkA's snapshot mid-flight.
        const inB = await forkB.findOne(token, { id: op.mutateId });
        if (inB === null) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.IDENTITY_CONTRACT,
            "forkB must observe the committed row",
          );
        }
        if (created !== undefined && inB === created) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.IDENTITY_CONTRACT,
            "forks must not share instances",
          );
        }
        Object.assign(inB, op.patch);
        forkB.persist(inB);
        await forkB.flush();
        const oracleRow = { id: op.mutateId, ...op.row, ...op.patch };
        oracle.applyMutation({ op: "replace", entity: op.entityName, id: op.mutateId, row: oracleRow });
        const verify = await ctx.rootEm.fork().findOne(token, { id: op.mutateId });
        if (verify === null) {
          throw new SoakAssertionError(
            FAILURE_REASON_CODES.IDENTITY_CONTRACT,
            "fork update must be visible to a fresh fork",
          );
        }
        assertRowMatches(oracleRow, verify, fieldPlan);
        return finishOk({ isolated: 1, ...(reconciled === 1 ? { reconciled: 1 } : {}) });
      }
      default:
        throw new SoakAssertionError(
          FAILURE_REASON_CODES.UNKNOWN_OPERATION,
          `unknown operation kind: ${op.kind}`,
        );
    }
  } catch (error) {
    return {
      status: "failed",
      code: typeof error?.code === "string" ? sanitizeStableCode(error.code) : undefined,
      reason: error instanceof SoakAssertionError
        ? error.reasonCode
        : FAILURE_REASON_CODES.UNEXPECTED_THROW,
      durationMs: Date.now() - startedAt,
    };
  }
}

/** Deterministic row payload for the update-fallback create path. */
function rowForCreate(op, fieldPlan) {
  // The update op may not carry a full row; synthesize one from the patch
  // and neutral defaults for any missing non-nullable field.
  const row = { ...op.patch };
  for (const [field, spec] of Object.entries(fieldPlan)) {
    if (spec.primary || row[field] !== undefined) continue;
    row[field] = spec.type === "number" ? 0
      : spec.type === "boolean" ? false
        : spec.type === "date" ? new Date(0)
          : "init";
    if (spec.nullable && spec.type === "date") row[field] = null;
  }
  return row;
}

/** Wraps one expected-code assertion into a redacted record. */
function expectCode(received, expected, finishExpected) {
  return received === expected
    ? finishExpected(received)
    : {
      status: "failed",
      code: typeof received === "string" ? sanitizeStableCode(received) : undefined,
      reason: FAILURE_REASON_CODES.UNEXPECTED_ERROR_CODE,
      durationMs: 0,
    };
}

/**
 * Replay reconciliation for one deterministic row.
 *
 * Returns true when the row already exists (committed by the interrupted
 * run) with content equal to the deterministic expectation — the insert is
 * skipped because the oracle, rebuilt from SQLite (the authority), already
 * mirrors it. A row that exists with DIFFERENT content is a real mismatch:
 * a stable failure, never a silent overwrite or duplicate.
 *
 * @returns {Promise<boolean>} true when the row is reconciled (no insert).
 */
async function reconcileExistingRow(ctx, entityName, id, expectedRow) {
  const existing = ctx.oracle.row(entityName, id);
  if (existing === undefined) return false;
  if (!rowValuesEqual(expectedRow, existing, ctx.fieldPlans[entityName])) {
    throw new SoakAssertionError(
      FAILURE_REASON_CODES.RECONCILE_MISMATCH,
      `reconcile mismatch on ${entityName} for existing row ${String(id)}`,
    );
  }
  return true;
}

/**
 * True when a live row's field values equal an expected deterministic row
 * (dates by epoch millis). Shared by prologue and executor reconciliation.
 */
export function rowValuesEqual(expectedRow, actualRow, fieldPlan) {
  try {
    assertRowMatches(expectedRow, actualRow, fieldPlan);
    return true;
  } catch (error) {
    if (error instanceof SoakAssertionError) return false;
    throw error;
  }
}

/** Compares an unordered id set against the oracle result. */
function assertIdSetMatches(oracle, op, rows, fieldPlan) {
  const expected = oracle.query(op.entityName, { where: op.filter });
  const actualIds = new Set(rows.map((row) => String(row.id)));
  const expectedIds = new Set(expected.ids);
  if (actualIds.size !== expectedIds.size) {
    throw new SoakAssertionError(
      FAILURE_REASON_CODES.QUERY_MISMATCH,
      `filtered find mismatch on ${op.entityName}: expected ${expectedIds.size}, received ${actualIds.size}`,
    );
  }
  for (const id of expectedIds) {
    if (!actualIds.has(id)) {
      throw new SoakAssertionError(
        FAILURE_REASON_CODES.QUERY_MISMATCH,
        `filtered find missing id on ${op.entityName}`,
      );
    }
  }
  void fieldPlan;
}

/** Field-by-field row comparison (dates by epoch millis). */
export function assertRowMatches(expectedRow, actualRow, fieldPlan) {
  for (const [field, spec] of Object.entries(fieldPlan)) {
    const expected = expectedRow[field] ?? null;
    const actual = actualRow[field] ?? null;
    if (spec.type === "date") {
      const expectedMs = expected instanceof Date ? expected.getTime() : null;
      const actualMs = actual instanceof Date ? actual.getTime() : null;
      if (expectedMs !== actualMs) {
        throw new SoakAssertionError(
          FAILURE_REASON_CODES.ROW_VALUE_MISMATCH,
          `row field ${field} date mismatch`,
        );
      }
    } else if (expected !== actual) {
      throw new SoakAssertionError(
        FAILURE_REASON_CODES.ROW_VALUE_MISMATCH,
        `row field ${field} value mismatch`,
      );
    }
  }
}
