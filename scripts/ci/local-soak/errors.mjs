/**
 * Stable redacted error description and tag helpers.
 * Depends only on the redaction allowlists.
 */
import { sanitizeErrorClass, sanitizeStableCode, sanitizeStatusClass } from "./redact.mjs";
import { SCENARIO_OBSERVE_POLL_MS, SCENARIO_OBSERVE_TIMEOUT_MS } from "./constants.mjs";
import { boundedSleep } from "./timing.mjs";

/** Extracts the error name and optional raw code/status class for sanitization. */
export function describeError(error) {
  const errorClass = error !== null && typeof error === "object" &&
    typeof error?.name === "string" && error.name.length > 0
    ? error.name
    : "unknown";
  const code = error !== null && typeof error === "object" &&
    typeof error?.code === "string"
    ? error.code
    : undefined;
  const statusClass = error !== null && typeof error === "object" &&
    typeof error?.statusClass === "string"
    ? error.statusClass
    : undefined;
  return { errorClass, code, statusClass };
}

/** Stable redacted tag for progress lines (never the raw message). */
export function stableErrorTag(error) {
  const described = describeError(error);
  // The class name passes the stable allowlist: a custom error class name
  // can embed a path, URL, or id-like token and must never reach stderr.
  const errorClass = sanitizeErrorClass(described.errorClass);
  const code = described.code === undefined ? undefined : sanitizeStableCode(described.code);
  const statusClass = described.statusClass === undefined
    ? undefined
    : sanitizeStatusClass(described.statusClass);
  // Prefer a known non-unknown code; otherwise a known non-unknown status
  // class; otherwise the class name only. A sanitized `unknown` code must
  // never shadow a valid status class.
  const stable =
    code !== undefined && code !== "unknown" ? code
    : statusClass !== undefined && statusClass !== "unknown" ? statusClass
    : undefined;
  return stable === undefined
    ? errorClass
    : `${errorClass} (${stable})`;
}

/**
 * True when a rejected direct human write carries EXACTLY the stable
 * `identity_shifted` evidence of the harness's fail-closed identity guard
 * (a `DirectSheetsError` whose statusClass — or a fake/test error whose
 * code — is `identity_shifted`).
 *
 * In the adversarial multi-writer soak environment a row shift between
 * the seam's snapshot read and its write is an EXPECTED TRANSIENT: other
 * concurrently-running scenarios mutate the same tabs, the seam proved no
 * silent success (it REFUSED to report success for the wrong identity),
 * and the race outcome is simply unobservable. Scenario modules branch on
 * this predicate BEFORE their non-stale failure counting and record a
 * truthful `identity-shifted-transient` skip instead of a real failure.
 * Duck-typed on the stable statusClass/code so the untrusted error's
 * message, ids, and payloads never reach a classification decision.
 *
 * @param {unknown} reason a rejected direct-write reason.
 * @returns {boolean}
 */
export function isIdentityShiftedEvidence(reason) {
  return reason !== null && typeof reason === "object" &&
    (reason?.statusClass === "identity_shifted" || reason?.code === "identity_shifted");
}

/**
 * The truthful redacted scenario record for a direct human-write rejection
 * whose evidence is exactly `identity_shifted`: a transient of the
 * multi-writer environment, never a failure. The scenario's guaranteed
 * finally cleanup still runs unchanged after this record is produced.
 *
 * @param {unknown} error the identity-shifted rejection reason.
 * @returns {{ status: "skipped", expectedErrors: number, failures: number,
 *   reason: string, reasonTag: string }}
 */
export function identityShiftedTransientResult(error) {
  return {
    status: "skipped",
    expectedErrors: 0,
    failures: 0,
    reason: "identity-shifted-transient",
    reasonTag: stableErrorTag(error),
  };
}

/**
 * Loads the `node:sqlite` built-in without a module specifier (the same
 * pattern as `schemaInspect.mjs`, so bundlers and test runners never try
 * to resolve it as a package).
 *
 * @returns {new (location: string, options?: object) => object | null}
 */
function loadDatabaseSync() {
  const candidate = process?.getBuiltinModule;
  if (typeof candidate !== "function") return null;
  const module = candidate.call(process, "node:sqlite");
  return module?.DatabaseSync ?? null;
}

/**
 * Decodes one stored conflict cell into a plain scalar for comparison.
 *
 * Mirrors the library status reader's fallback: a normalized-cell JSON
 * payload (`{"kind": ..., "value": ...}`) decodes to its value, anything
 * else compares as its stored text. Already-decoded scalars (the
 * `queryConflictRows` test seam) pass through unchanged.
 *
 * @param {unknown} raw the stored `user_value` (or an injected summary's
 *   already-decoded `userValue`).
 * @returns {unknown} the plain scalar to compare against the expectation.
 */
function decodeConflictValue(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && "value" in parsed) {
      return parsed.value ?? null;
    }
  } catch {
    // Not JSON: compare as stored text below.
  }
  return text;
}

/**
 * Reads unresolved conflict evidence for one scenario observation.
 *
 * Production path: a read-only `node:sqlite` query over the SAME SQLite
 * authority the cycle executor wired as `context.dbName` (no public
 * EntityManager entity exists for `sync_conflict`, and the runner owns no
 * storage-adapter seam — the read-only file query is the narrowest
 * existing seam, mirroring `schemaInspect.mjs`). It coexists with the
 * running sync worker (WAL readers never block the writer) and never
 * writes. Test path: `context.queryConflictRows()` (the fake seam — unit
 * tests have no SQLite file). Neither path available (local mode, bare
 * fakes) yields no rows, preserving the row-only behavior.
 *
 * A failed read yields no rows (fail-safe toward the row-only outcome),
 * never a throw: missing conflict evidence must not itself fail a scenario.
 *
 * @param {object} context the scenario execution context.
 * @returns {Promise<Array<object>>} unresolved conflict rows (each with a
 *   field name, a user value, and a status — nothing else is consumed).
 */
async function readOpenConflictRows(context) {
  if (typeof context?.queryConflictRows === "function") {
    const rows = await context.queryConflictRows();
    return Array.isArray(rows) ? rows : [];
  }
  const dbName = context?.dbName;
  if (typeof dbName !== "string" || dbName.length === 0) return [];
  try {
    const DatabaseSync = loadDatabaseSync();
    if (DatabaseSync === null) return [];
    const database = new DatabaseSync(dbName, { readOnly: true });
    try {
      // Storage literals for the unresolved conflict lifecycle states (see
      // CONFLICT_STATUSES in the library contracts): an OPEN conflict is
      // recorded ingestion-as-conflict; NEEDS_REBASE is the same recorded
      // outcome awaiting rebase. Both are terminal conflict evidence.
      return database.prepare(
        "SELECT field_name, user_value, status FROM sync_conflict " +
        "WHERE status IN ('OPEN', 'NEEDS_REBASE')",
      ).all();
    } finally {
      database.close();
    }
  } catch {
    return [];
  }
}

/**
 * Suffix a conflict-recorded cleanup appends to the current canonical
 * string value to force a genuine same-field canonical advance.
 *
 * A same-value re-affirm CANNOT trigger the library's implicit system-wins
 * path: `shouldTriggerImplicitSystemWins` requires the committed value to
 * DIFFER from the conflict's stored canonical value (plus a strict revision
 * increase), so writing the canonical value back is a silent no-op that
 * leaves the blocking OPEN conflict in place. The suffixed value always
 * differs by construction (strictly longer), deterministically, with no new
 * randomness. Values are never recorded (compared, never stored).
 */
export const SYSTEM_WINS_RESOLVE_SUFFIX = "-syswin";

/**
 * Deterministic system-wins advance for one current canonical value.
 *
 * Produces a value that always differs from `current` (the trigger
 * requirement above) while staying type-valid for the field: strings grow
 * the resolve suffix, numbers step, booleans flip, dates tick forward. The
 * row is deleted immediately after the conflicts clear, so this value is
 * transient; the human value stays preserved in the conflict audit trail.
 *
 * @param {unknown} current the current canonical (authority) value.
 * @returns {unknown} a deterministically different value of the same shape.
 */
export function systemWinsResolveValue(current) {
  if (typeof current === "string") return `${current}${SYSTEM_WINS_RESOLVE_SUFFIX}`;
  if (typeof current === "number") return current + 1;
  if (typeof current === "boolean") return !current;
  if (current instanceof Date) return new Date(current.getTime() + 1000);
  return `${String(current)}${SYSTEM_WINS_RESOLVE_SUFFIX}`;
}

/**
 * Resolves OPEN/NEEDS_REBASE conflicts on one dedicated race row via the
 * public EntityManager so the guaranteed cleanup can delete it.
 *
 * A conflict-recorded race row cannot be deleted directly: the mapped flush
 * guard fails a delete closed while ANY active candidate pointer exists
 * (`hasMappedRowActiveCandidateWithSql` blocks regardless of conflict
 * status, so NEEDS_REBASE still blocks). This advances every given field to
 * a deterministically different canonical value through a fresh fork and
 * flushes — the documented implicit system-wins trigger — then waits
 * (bounded) for the conflicts to leave the blocking query
 * (`conflictRecordedForFields` empty for these fields).
 *
 * The acknowledge_system command applies SYNCHRONOUSLY inside the resolve
 * flush transaction (conflict RESOLVED, candidate pointer cleared) in the
 * happy path, so the first poll already clears. Only a deferred command (a
 * processing/delivery_uncertain predecessor owns the conflict stream) needs
 * worker polling passes to apply — that is what the bounded wait covers.
 * The wait never outlives `context.deadlineAtMs` and never deletes through
 * a blocking conflict: expiry returns false and the caller must keep the
 * row and record `cleanup-unresolved-conflict`.
 *
 * Field names are scenario-known fixed vocab; values compared-not-recorded.
 *
 * @param {object} context the scenario execution context (`em`,
 *   `deadlineAtMs`, `dbName` or `queryConflictRows()`).
 * @param {object} options `{ token, targetId, fields, critical }`: the EM
 *   token, the dedicated row id, the conflicted fields in the same shape as
 *   `conflictRecordedForFields` input, and the shared oracle-lock runner.
 * @returns {Promise<boolean>} true when the conflicts cleared and the
 *   caller may delete; false when the bounded wait expired (keep the row).
 */
export async function resolveRecordedConflicts(context, { token, targetId, fields, critical }) {
  const wanted = Array.isArray(fields)
    ? fields.filter((entry) => entry !== null && typeof entry === "object" &&
      typeof entry.field === "string")
    : [];
  if (wanted.length === 0) return true;
  if (context?.em === undefined || typeof context.em.fork !== "function") return false;
  const run = typeof critical === "function" ? critical : (action) => action();
  let rowMissing = false;
  try {
    // Short critical section (no sleeps): the transient system-wins values
    // must never be observable to a concurrent actor verifying the oracle.
    await run(async () => {
      const resolver = context.em.fork();
      const row = await resolver.findOne(token, { id: targetId });
      if (row === null || row === undefined) {
        rowMissing = true;
        return;
      }
      for (const entry of wanted) {
        row[entry.field] = systemWinsResolveValue(row[entry.field]);
      }
      await resolver.flush();
    });
  } catch {
    // No canonical advance happened, so no trigger was planned and no
    // later poll can clear it: fail fast to the unresolved kind instead of
    // spending the bounded wait on a conflict that cannot move.
    return false;
  }
  if (rowMissing) return true;
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context?.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  while (true) {
    const recorded = await conflictRecordedForFields(context, wanted);
    if (wanted.every((entry) => !recorded.has(entry.field))) return true;
    if (Date.now() >= deadline) return false;
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
}

/**
 * Resolves which human fields were ingested as recorded conflicts.
 *
 * When an outbox effect for the same binding is in flight, the adaptive
 * poll's check-column gate deliberately skips the row and the human edit is
 * ingested only after the effect cycle completes — as an OPEN sync_conflict
 * carrying the human value. A row-based observation inside the effect window
 * would misclassify that outcome as silent loss; this helper lets the
 * observation accept the conflict-recorded outcome the scenario hypothesis
 * allows ("apply atomically OR record as a conflict").
 *
 * Matching is field-by-field: a field counts as recorded only when an
 * unresolved conflict row carries the same `field_name` AND its decoded
 * `user_value` string-equals the scenario's expected human value for that
 * field (the harness knows the injected values, so it compares against
 * them). The human values are deterministic per (cycle, order), so the
 * (field, value) pair already scopes the evidence to this scenario's row —
 * no row id is consumed. Only `field_name`/`user_value`/`status` are ever
 * read; raw values are compared, never recorded (the caller records only
 * the fixed `conflict-recorded` reason with an empty failureKinds channel).
 *
 * @param {object} context the scenario execution context (`dbName` for the
 *   read-only production query, or `queryConflictRows()` for the test seam).
 * @param {readonly { field: string, expectedValue: unknown }[]} fields the
 *   human fields with their expected human values.
 * @returns {Promise<Set<string>>} the subset of field names with a matching
 *   unresolved conflict record.
 */
export async function conflictRecordedForFields(context, fields) {
  const recorded = new Set();
  const wanted = Array.isArray(fields)
    ? fields.filter((entry) => entry !== null && typeof entry === "object" &&
      typeof entry.field === "string")
    : [];
  if (wanted.length === 0) return recorded;
  let rows;
  try {
    rows = await readOpenConflictRows(context);
  } catch {
    return recorded;
  }
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    // Both shapes are accepted: the injected test seam's camelCase conflict
    // summaries and the production query's snake_case storage rows.
    const fieldName = row.fieldName ?? row.field_name;
    if (typeof fieldName !== "string") continue;
    const status = row.status;
    if (status !== undefined && status !== "OPEN" && status !== "NEEDS_REBASE") continue;
    const userValue = decodeConflictValue(row.userValue ?? row.user_value);
    for (const entry of wanted) {
      if (entry.field === fieldName &&
          String(userValue ?? "") === String(entry.expectedValue ?? "")) {
        recorded.add(entry.field);
      }
    }
  }
  return recorded;
}

/**
 * Counts in-flight (blocking) outbox effects for one dedicated race row.
 *
 * A cleanup delete fails closed with `projection_outbox_blocked` while a
 * candidate effect for the row's binding is still in flight — even when NO
 * conflict sits on the row itself (a `race-winner-verified` verdict with
 * pending `candidate_reconcile` effects). Callers wait this count down via
 * {@link waitForBindingOutboxDrain} before deleting.
 *
 * Production path: a read-only `node:sqlite` query over the SAME SQLite
 * authority the cycle executor wired as `context.dbName` (the same narrow
 * read-only seam as `readOpenConflictRows`; WAL readers never block the
 * writer). The binding id is hash-minted and not derivable from the row
 * id, so it resolves through the `row_binding` table (`entity_id` is the
 * canonical id, which equals the visible row id under the default
 * mapping; the default `entity:<id>` anchor is the fallback). Only the
 * non-terminal blocking states count (`pending`, `processing`,
 * `delivery_uncertain`): terminal `failed`/`blocked_candidate` rows never
 * drain (the worker's own recovery owns them) and must not hang the wait.
 * Test path: `context.queryOutboxInflightCount(targetId)` (the fake seam —
 * unit tests have no SQLite file). Neither path available yields 0.
 *
 * Fail-safe toward delete: a failed read yields 0, never a throw —
 * unreadable outbox evidence must not itself fail a scenario. Only
 * binding ids are read; raw ids are compared, never recorded.
 *
 * @param {object} context the scenario execution context (`dbName` for the
 *   read-only production query, or `queryOutboxInflightCount()` for tests).
 * @param {string} targetId the dedicated race row id.
 * @returns {Promise<number>} in-flight effect count for the row's binding.
 */
export async function bindingOutboxInflightCount(context, targetId) {
  if (typeof targetId !== "string" || targetId.length === 0) return 0;
  if (typeof context?.queryOutboxInflightCount === "function") {
    try {
      const count = await context.queryOutboxInflightCount(targetId);
      return typeof count === "number" && Number.isFinite(count) && count > 0
        ? Math.floor(count)
        : 0;
    } catch {
      return 0;
    }
  }
  const dbName = context?.dbName;
  if (typeof dbName !== "string" || dbName.length === 0) return 0;
  try {
    const DatabaseSync = loadDatabaseSync();
    if (DatabaseSync === null) return 0;
    const database = new DatabaseSync(dbName, { readOnly: true });
    try {
      if (!tableExists(database, "row_binding") || !tableExists(database, "sheet_effect_outbox")) return 0;
      const bindings = database.prepare(
        "SELECT row_binding_id FROM row_binding WHERE entity_id = ? OR anchor_reference = ?",
      ).all(targetId, `entity:${targetId}`);
      const ids = bindings
        .map((row) => row?.row_binding_id)
        .filter((id) => typeof id === "string" && id.length > 0);
      if (ids.length === 0) return 0;
      const placeholders = ids.map(() => "?").join(",");
      const row = database.prepare(
        `SELECT COUNT(*) AS n FROM sheet_effect_outbox WHERE row_binding_id IN (${placeholders}) ` +
        "AND status IN ('pending','processing','delivery_uncertain')",
      ).get(...ids);
      const count = row?.n;
      return typeof count === "number" && Number.isFinite(count) && count > 0
        ? Math.floor(count)
        : 0;
    } finally {
      database.close();
    }
  } catch {
    return 0;
  }
}

/** True when one outbox table exists in the read-only authority. */
function tableExists(database, tableName) {
  try {
    const row = database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(tableName);
    return row !== undefined;
  } catch {
    return false;
  }
}

/**
 * Bounded wait for a dedicated race row's binding effects to leave the
 * blocking outbox states.
 *
 * Sits INSIDE the existing bounded cleanup phase: the deadline is the
 * earlier of the scenario settle window (`SCENARIO_OBSERVE_TIMEOUT_MS`)
 * and the run's hard deadline, so this wait shares the settle budget and
 * never adds an independent unbounded wait. Polls
 * {@link bindingOutboxInflightCount} until every binding id drains to 0.
 *
 * @param {object} context the scenario execution context (`deadlineAtMs`,
 *   `dbName` or `queryOutboxInflightCount()`).
 * @param {string | readonly string[]} targetIdOrIds the dedicated row
 *   id(s) whose bindings must drain (race + shifter rows).
 * @returns {Promise<boolean>} true when every binding drained (safe to
 *   delete); false when the budget expired with effects still in flight
 *   (keep the row, record `cleanup-outbox-busy`).
 */
export async function waitForBindingOutboxDrain(context, targetIdOrIds) {
  const ids = (Array.isArray(targetIdOrIds) ? targetIdOrIds : [targetIdOrIds])
    .filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return true;
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context?.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  while (true) {
    let inflight = 0;
    for (const id of ids) {
      inflight += await bindingOutboxInflightCount(context, id);
      if (inflight > 0) break;
    }
    if (inflight === 0) return true;
    if (Date.now() >= deadline) return false;
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
}
