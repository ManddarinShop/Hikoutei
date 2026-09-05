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
