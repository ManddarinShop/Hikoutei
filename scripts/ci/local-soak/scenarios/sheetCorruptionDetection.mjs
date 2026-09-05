/**
 * Scenario: sheet corruption detection and reporting (#194).
 *
 * Hypothesis: duplicated identities, cell-shifted rows, and missing
 * required fields in a User_Input tab are SHEET CORRUPTION that must at
 * least be DETECTED and reported. The library is known NOT to repair any
 * tab's corruption (issue #194), so this harness-diagnostic scenario
 * injects a corrupted shape into the dedicated row's tab, re-reads the tab
 * through the same direct-Sheet read seam, and judges whether the
 * corruption was DETECTED. Detection is the SUCCESS outcome (recorded as
 * one expected error with `repaired: false` as the defect evidence); an
 * injected corruption that the read seam fails to surface is the guard
 * deficiency this scenario hunts (failures=1). NO code in this scenario —
 * and no code anywhere — repairs or compensates the injected corruption.
 *
 * The action uses only the public EntityManager (for the dedicated
 * authority row) and the direct-Sheet observation seam (for injection,
 * detection, and cleanup); it runs only in live mode.
 */
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../entities.mjs";
import { identityShiftedTransientResult, isIdentityShiftedEvidence, stableErrorTag } from "../errors.mjs";
import { generateRow } from "../operations.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { SCENARIO_OBSERVE_POLL_MS, SCENARIO_OBSERVE_TIMEOUT_MS } from "../constants.mjs";
import { boundedSleep } from "../timing.mjs";

/** Stable scenario id recorded in redacted artifacts. */
export const id = "sheet-corruption-detection";
/** Data scenario: overlaps the data/base workload, not lifecycle-gated. */
export const kind = "data";
/**
 * Allowed execution windows: only the two STABLE windows (a fresh tab
 * right after the prologue, and the settled tab after the actors) — a
 * concurrent injection would race the actors' appends and truthfully skip
 * most of the time, so it is not composed.
 */
export const allowedPhases = ["after-prologue", "after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "sheet-corruption-detection";

/**
 * The corrupted shapes this scenario can inject and detect.
 *
 * Each kind is a pure SHAPE (string comparison only — never a value or
 * id comparison): a second row carrying an already-present identity, a
 * row whose cells are pushed one column right (identity column left
 * blank), or a required field cell left blank on the dedicated row.
 */
export const CORRUPTION_KINDS = Object.freeze([
  "duplicate-identity",
  "shifted-cell",
  "missing-field",
]);

/**
 * Deterministic plan for one cycle: entity, a dedicated corruption-target
 * id, a target required field, and the corrupted shape to inject. Pure
 * function of (seed, cycle) — reads no external run state.
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/corruptionKind/target.
 */
export function plan({ cycle, order, rng, activeEntities }) {
  // The plan's target entity must be in the ACTIVE subset (a --tables run
  // activates only some entities), so a plan never points at an inactive
  // entity. Falls back to the full entity order when no subset is given.
  const pool = activeEntities !== undefined && activeEntities.length > 0
    ? activeEntities
    : SOAK_ENTITY_ORDER;
  const entry = pool[rng.int(pool.length)];
  const abbreviation = entry.name.replace(/^Soak/, "").toLowerCase();
  // Only non-primary, non-nullable fields are eligible: the injected
  // "missing field" shape blanks a REQUIRED cell (a nullable cell may
  // legitimately be blank, so it is never a corruption shape).
  const candidates = Object.entries(SOAK_FIELD_PLANS[entry.name])
    .filter(([, spec]) => !spec.primary && spec.nullable !== true);
  const [field] = candidates[rng.int(candidates.length)];
  return {
    tag: TAG,
    // Short deterministic jitter so the injection lands while the tab is
    // not frozen at a fixed point.
    jitterMs: 1 + rng.int(50),
    corruptionKind: CORRUPTION_KINDS[rng.int(CORRUPTION_KINDS.length)],
    target: {
      entityName: entry.name,
      // A DEDICATED corruption-target id (outside the actor/prologue
      // space), deterministic per (seed, cycle): never a raw or secret
      // value.
      dedicatedId: `corrupt-${abbreviation}-c${cycle}-${order}`,
      field,
    },
  };
}

/** True when a display cell is blank (undefined/null/""). */
function isBlankCellValue(value) {
  return value === undefined || value === null || value === "";
}

/** Normalizes one display cell to its string form (blank stays ""). */
function normalizeCell(value) {
  return value === undefined || value === null ? "" : String(value);
}

/**
 * Pure tab-shape corruption detector (string comparison only).
 *
 * Judges a tab's rows for the #194 corrupted shapes and returns ONLY a
 * verdict — no id, value, or payload ever escapes. Priority order:
 * malformed/missing header, then a non-blank row whose identity column is
 * blank (cells pushed — `shifted-cell`), then a repeated non-blank
 * identity (`duplicate-identity`), then (only when an anchor `identity`
 * and `requiredFields` are supplied) a blank required field cell on the
 * anchor row (`missing-field`). A fully-blank tab or a tab whose rows all
 * carry unique non-blank identities with filled required fields is
 * `clean`.
 *
 * The verdict carries `detected: true, repaired: false`: this scenario
 * only detects and reports — repair is the open #194 defect and is never
 * performed by any code.
 *
 * @param {readonly unknown[][]} rows tab rows including the header row.
 * @param {{ identity?: string, requiredFields?: readonly string[] }} [scope]
 *   optional anchor identity and required field headers.
 * @returns {{ status: "clean" } |
 *   { status: "detected", kind: string, detected: true, repaired: false }}
 */
export function detectCorruption(rows, scope = {}) {
  const detected = (kind) => ({ status: "detected", kind, detected: true, repaired: false });
  const headers = Array.isArray(rows) ? rows[0] : undefined;
  if (!Array.isArray(headers)) return detected("malformed-header");
  const seen = new Set();
  for (const header of headers) {
    if (typeof header !== "string" || header.trim() === "") return detected("malformed-header");
    if (seen.has(header)) return detected("malformed-header");
    seen.add(header);
  }
  const idColumn = headers.indexOf("id");
  if (idColumn < 0) return detected("missing-header");
  for (const field of scope.requiredFields ?? []) {
    if (headers.indexOf(field) < 0) return detected("missing-header");
  }
  // Row shape: a non-blank row with a blank/non-string identity is the
  // pushed/shifted-cell shape; a repeated identity is the duplicate shape.
  const byId = new Map();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!Array.isArray(row)) return detected("shifted-cell");
    if (row.every(isBlankCellValue)) continue;
    const rawId = row[idColumn];
    if (typeof rawId !== "string" || rawId.trim() === "") return detected("shifted-cell");
    byId.set(rawId, (byId.get(rawId) ?? 0) + 1);
  }
  for (const count of byId.values()) {
    if (count > 1) return detected("duplicate-identity");
  }
  // A blank required field cell on the ANCHOR identity row only (never on
  // arbitrary rows: nullable fields are legitimately blank and actors may
  // legitimately leave cells empty mid-projection).
  if (scope.identity !== undefined && (scope.requiredFields ?? []).length > 0) {
    const anchorRow = rows.find((entry, index) =>
      index > 0 && Array.isArray(entry) && entry[idColumn] === scope.identity);
    if (anchorRow !== undefined) {
      for (const field of scope.requiredFields ?? []) {
        const column = headers.indexOf(field);
        if (column >= 0 && isBlankCellValue(anchorRow[column])) return detected("missing-field");
      }
    }
  }
  return { status: "clean" };
}

/**
 * Live action: creates a DEDICATED corruption-target row through the
 * public API, injects one corrupted shape into its User_Input tab through
 * the direct-Sheet seam, then re-reads the tab through the SAME read seam
 * and judges whether the corruption was DETECTED. Detection is the
 * expected outcome (one expected error, `repaired: false` — the #194
 * defect evidence); a read that fails to surface the injected corruption
 * is the guard deficiency (failures=1). The injected rows/cells and the
 * dedicated authority row are removed in a GUARANTEED finally path so the
 * final SQLite state matches the deterministic replay — cleanup of the
 * scenario's OWN fixtures is not a repair of the corruption.
 *
 * @param {{ plan: object, context: object }} input plan + live context.
 * @returns {Promise<object>} { status, expectedErrors, failures, cleanupFailures?, reason? }.
 */
export async function execute({ plan, context }) {
  const client = context.live.client;
  const spreadsheetId = context.live.spreadsheetId;
  const tabName = `${plan.target.entityName}_Input`;
  const token = context.tokenByEntity.get(plan.target.entityName);
  const expected = new Set(context.activeEntities.map((entry) => entry.name));
  if (token === undefined || !expected.has(plan.target.entityName)) {
    return { status: "skipped", expectedErrors: 0, failures: 0, reason: "local-mode" };
  }
  const fieldPlan = SOAK_FIELD_PLANS[plan.target.entityName];
  const em = context.em.fork();
  const rng = new SeededRandom(deriveSeed(context.seed, context.cycle * 829 + 101));
  const critical = (action) => context.oracleLock === undefined
    ? action()
    : context.oracleLock.withLock(action);
  let cleanupFailures = 0;
  // Stable diagnostic kinds for every failure site (allowlisted, never raw
  // text) so a failed record says WHICH invariant fired.
  const failureKinds = new Set();
  let result;
  // The exact raw writes used for the injected EXTRA row (duplicate-identity
  // and shifted-cell only; missing-field writes into the dedicated row
  // itself and needs no extra-row cleanup). Cleanup re-locates the injected
  // row BY CONTENT before deleting it, so a live row that raced into the
  // coordinate is never removed.
  let injectedWrites = null;
  try {
    // A DEDICATED corruption-target row, created through the public API and
    // mirrored into the oracle under the shared lock, so the injected
    // corruption, detection, and cleanup never touch an actor-owned row and
    // never need synchronization with the concurrent actors.
    const row = { id: plan.target.dedicatedId, ...generateRow(rng, fieldPlan) };
    await critical(async () => {
      em.persist(em.create(token, row));
      await em.flush();
      context.oracle?.applyMutation({ op: "insert", entity: plan.target.entityName, row });
    });
    // Bounded projection readiness: the dedicated row must first be
    // projected into the tab (the raw injection targets the blank row
    // directly below it). If it never appears, record a truthful skip and
    // never attempt a doomed injection.
    if (!(await awaitInputProjection(client, spreadsheetId, tabName, plan, context))) {
      result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "projection-not-ready" };
    } else {
      // Narrowed transient scope: ONLY a rejection of a direct write below
      // (`mutateInputCell` / `injectInputCells`) may classify as the
      // expected `identity-shifted-transient` (via `writeTransient`). Reads
      // (projection readiness, snapshot, verification, detection) and setup
      // rethrow to the normal failure path — a read error is never transient.
      let writeTransient;
      await boundedSleep(plan.jitterMs ?? 0, context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER);
      if (plan.corruptionKind === "missing-field") {
        // Injection through the GUARDED identity-resolved write seam:
        // writing an empty string into a required non-primary field cell.
        // The guarded postcondition proves the blank landed on the
        // intended identity row, so a successful call IS the
        // injection-observable evidence.
        try {
          await client.mutateInputCell({
            spreadsheetId,
            tabName,
            identity: plan.target.dedicatedId,
            headerName: plan.target.field,
            value: "",
            deadlineAtMs: context.deadlineAtMs,
          });
        } catch (error) {
          // A direct-write rejection with the fail-closed
          // `identity_shifted` evidence is an EXPECTED TRANSIENT of the
          // multi-writer soak (a concurrent actor shifted the tab; the seam
          // proved no silent overwrite): a truthful skip, never a failure.
          // Any other write rejection rethrows to the failure path.
          if (isIdentityShiftedEvidence(error)) {
            writeTransient = identityShiftedTransientResult(error);
          } else {
            throw error;
          }
        }
      } else {
        // Injection through the RAW corruption seam: copy the dedicated
        // row's cells into the first blank row directly below it — an
        // identical second copy (duplicate identity) or a copy shifted one
        // column right (identity column left blank — the pushed-cell
        // shape). The raw seam requires every target cell to be blank, so
        // a live actor row at the target is never overwritten (it fails
        // closed and the scenario records a truthful skip).
        const snapshot = await client.readTabRows(spreadsheetId, tabName, {
          deadlineAtMs: context.deadlineAtMs,
        });
        const sourceIndex = findDedicatedRowIndex(snapshot, plan.target.dedicatedId);
        const targetIndex = findBlankRowBelow(snapshot, sourceIndex);
        if (sourceIndex === null || targetIndex === null) {
          result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "injection-not-observable" };
        } else {
          const source = snapshot[sourceIndex];
          const writes = plan.corruptionKind === "duplicate-identity"
            ? source.map((value, columnIndex) => ({ rowIndex: targetIndex, columnIndex, value }))
            : source.map((value, columnIndex) => ({ rowIndex: targetIndex, columnIndex: columnIndex + 1, value }));
          try {
            await client.injectInputCells({
              spreadsheetId,
              tabName,
              writes,
              deadlineAtMs: context.deadlineAtMs,
            });
          } catch (error) {
            // Same narrowed scope as the guarded write above: only an exact
            // `identity_shifted` injection rejection is the expected
            // transient (a concurrent actor occupied the blank coordinate;
            // the seam proved no silent overwrite). Any other rejection
            // rethrows to the failure path.
            if (isIdentityShiftedEvidence(error)) {
              writeTransient = identityShiftedTransientResult(error);
            } else {
              throw error;
            }
          }
          if (writeTransient === undefined) {
            injectedWrites = writes;
            // Injection-observable evidence for the raw seam: the injected
            // cells must be readable back before a clean detection read can
            // be called a miss (without this proof an unchanged read proves
            // nothing).
            const verifyRows = await client.readTabRows(spreadsheetId, tabName, {
              deadlineAtMs: context.deadlineAtMs,
            });
            if (!hasInjectedRow(verifyRows, writes)) {
              result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "injection-not-observable" };
            }
          }
        }
      }
      if (writeTransient !== undefined) {
        result = writeTransient;
      }
      if (result === undefined) {
        // A SEPARATE detection read: the read seam itself must surface the
        // injected corruption. A read that misses it is the guard
        // deficiency this scenario hunts.
        const detectRows = await client.readTabRows(spreadsheetId, tabName, {
          deadlineAtMs: context.deadlineAtMs,
        });
        const verdict = detectCorruption(detectRows, {
          identity: plan.target.dedicatedId,
          requiredFields: [plan.target.field],
        });
        if (verdict.status === "detected") {
          // DETECTED = scenario success (the expected outcome): the
          // corruption is reported as one expected error and `repaired:
          // false` stays as the #194 defect evidence — no code repaired
          // anything.
          result = {
            status: "ok",
            expectedErrors: 1,
            failures: 0,
            reason: `corruption-detected-${verdict.kind}`,
          };
        } else {
          // INJECTED but NOT DETECTED: the guard missed the corruption it
          // must surface — the real defect this scenario catches.
          failureKinds.add("corruption-missed");
          result = { status: "failed", expectedErrors: 0, failures: 1, reason: "corruption-missed" };
        }
      }
    }
  } catch (error) {
    // Only the direct writes above (`mutateInputCell` / `injectInputCells`)
    // may classify as the expected transient (handled inline); every other
    // throw — reads, detection, setup — is a real scenario error, never a
    // transient.
    result = {
      status: "failed",
      expectedErrors: 0,
      failures: 1,
      reason: "scenario-error",
      reasonTag: stableErrorTag(error),
    };
  } finally {
    // GUARANTEED cleanup, split into INDEPENDENT guarded steps so a
    // failure in one never prevents the others; each cleanup failure is
    // counted exactly once and never masks the original outcome.
    // Step 1: remove the injected EXTRA row (duplicate/shifted only),
    // re-located BY CONTENT so a live row that raced into the coordinate
    // is never deleted.
    if (injectedWrites !== null) {
      try {
        const rows = await client.readTabRows(spreadsheetId, tabName, {
          deadlineAtMs: context.deadlineAtMs,
        });
        const injectedIndex = findInjectedRowIndex(rows, injectedWrites);
        if (injectedIndex !== null) {
          await client.deleteInputRowAt({
            spreadsheetId,
            tabName,
            rowIndex: injectedIndex,
            deadlineAtMs: context.deadlineAtMs,
          });
        }
      } catch {
        cleanupFailures += 1;
        failureKinds.add("cleanup-delete-failed");
      }
    }
    // Step 2: remove the dedicated row from the tab by identity. A
    // `missing_identity` (row already gone) is not a cleanup failure.
    try {
      await client.deleteInputRow({
        spreadsheetId,
        tabName,
        identity: plan.target.dedicatedId,
        deadlineAtMs: context.deadlineAtMs,
      });
    } catch (error) {
      if (error?.statusClass !== "missing_identity") {
        cleanupFailures += 1;
        failureKinds.add("cleanup-delete-failed");
      }
    }
    // Step 3: remove the dedicated row from the authority + oracle mirror
    // so SQLite and the oracle stay symmetric even when a tab step failed.
    try {
      await critical(async () => {
        const rows = await em.find(token, { id: plan.target.dedicatedId });
        for (const dedicatedRow of rows) em.remove(dedicatedRow);
        await em.flush();
        context.oracle?.applyMutation({ op: "delete", entity: plan.target.entityName, id: plan.target.dedicatedId });
      });
    } catch {
      cleanupFailures += 1;
      failureKinds.add("cleanup-delete-failed");
    }
  }
  const kinds = [...failureKinds].sort();
  if (cleanupFailures > 0) {
    return {
      status: "failed",
      expectedErrors: result?.expectedErrors ?? 0,
      failures: (result?.failures ?? 0) + cleanupFailures,
      cleanupFailures,
      reason: result?.reason ?? "scenario-error",
      ...(result?.reasonTag !== undefined ? { reasonTag: result.reasonTag } : {}),
      ...(kinds.length > 0 ? { failureKinds: kinds } : {}),
    };
  }
  return {
    ...result,
    cleanupFailures: 0,
    ...(kinds.length > 0 ? { failureKinds: kinds } : {}),
  };
}

/**
 * Index of the first data row (i >= 1) whose identity cell equals
 * `identity`, resolving the id column FROM THE HEADER ROW (never assuming
 * it is column 0). Returns `null` when the tab has no readable id header.
 */
function findDedicatedRowIndex(rows, identity) {
  const headers = Array.isArray(rows) ? rows[0] : undefined;
  const idColumn = Array.isArray(headers) ? headers.indexOf("id") : -1;
  if (idColumn < 0) return null;
  for (let index = 1; index < rows.length; index += 1) {
    if (Array.isArray(rows[index]) && rows[index][idColumn] === identity) return index;
  }
  return null;
}

/**
 * Index of the first fully-blank data row STRICTLY BELOW `sourceIndex`
 * (scanning one row past the current grid, where a raw write may extend).
 * Returns `null` when the source row is unknown or no blank row exists
 * below it (actors raced into every slot — the scenario skips truthfully
 * and never overwrites a live row).
 */
function findBlankRowBelow(rows, sourceIndex) {
  if (sourceIndex === null) return null;
  for (let index = sourceIndex + 1; index <= rows.length; index += 1) {
    const row = rows[index];
    if (row === undefined || row === null || (Array.isArray(row) && row.every(isBlankCellValue))) {
      return index;
    }
  }
  return null;
}

/** True when one row displays every injected write at its coordinates. */
function matchesInjectedRow(row, writes) {
  if (!Array.isArray(row)) return false;
  for (const write of writes) {
    if (normalizeCell(row[write.columnIndex]) !== String(write.value)) return false;
  }
  return true;
}

/** True when any data row displays every injected write (injection landed). */
function hasInjectedRow(rows, writes) {
  return rows.some((row, index) => index > 0 && matchesInjectedRow(row, writes));
}

/** Index of the first data row matching the injected writes, or `null`. */
function findInjectedRowIndex(rows, writes) {
  for (let index = 1; index < rows.length; index += 1) {
    if (matchesInjectedRow(rows[index], writes)) return index;
  }
  return null;
}

/**
 * Bounded projection readiness: polls the direct-Sheet read seam until the
 * dedicated row's projection is observable in the tab.
 *
 * Returns `true` once the row is visible, or `false` when it never appears
 * within the bounded window (the caller records a truthful skip and never
 * attempts a doomed injection).
 *
 * @returns {Promise<boolean>}
 */
async function awaitInputProjection(client, spreadsheetId, tabName, plan, context) {
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  while (true) {
    if (Date.now() >= deadline) return false;
    const rows = await client.readTabRows(spreadsheetId, tabName, {
      deadlineAtMs: context.deadlineAtMs,
    });
    if (findDedicatedRowIndex(rows, plan.target.dedicatedId) !== null) return true;
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
}

/**
 * Deterministic, idempotent orphan recovery for this scenario's dedicated
 * row on a process-death resume.
 *
 * A run that dies before this scenario's guaranteed finally can leave the
 * deterministic dedicated `dedicatedId` row in the authority; the resume
 * replay would then reject it as a foreign id. This hook removes that
 * exact planned row (and only it) through the public EntityManager, so a
 * resume of an interrupted in-flight cycle never fails the DB proof over
 * an orphan. It is derived solely from the persisted seed/cycle plan
 * (same inputs -> same orphan id), is idempotent (removing a missing row
 * is a no-op), and is restart-safe. Never touches internal
 * storage/outbox.
 *
 * @param {{ plan: object, context: object }} input the deterministic plan
 *   and a recovery context exposing the public seams (`em`,
 *   `tokenByEntity`, `activeEntities`).
 * @returns {Promise<{ removed: number }>}
 */
export async function recover({ plan, context }) {
  const token = context.tokenByEntity.get(plan.target.entityName);
  const active = new Set(context.activeEntities.map((entry) => entry.name));
  if (token === undefined || !active.has(plan.target.entityName)) return { removed: 0 };
  const em = context.em.fork();
  const rows = await em.find(token, { id: plan.target.dedicatedId });
  let removed = 0;
  for (const row of rows) {
    em.remove(row);
    removed += 1;
  }
  if (removed > 0) await em.flush();
  return { removed };
}
