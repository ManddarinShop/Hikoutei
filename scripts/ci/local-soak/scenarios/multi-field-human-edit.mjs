/**
 * Scenario: a multi-field human edit raced against a public-API update.
 *
 * Hypothesis: a human edits 2+ fields of one row in a single atomic write
 * while the public API updates a DIFFERENT field of the same row. The worker
 * must apply all human field changes atomically (or as a consistent
 * observation) — it must NOT partially apply one field, silently lose one
 * field, or fabricate a false conflict. The scenario exposes partial field
 * application, multi-field CAS mismatch, and silent loss of one field.
 *
 * The race needs a live Sheets/observation seam plus the public EntityManager
 * fork, so it runs only in live mode; local mode records `skipped`.
 */
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../entities.mjs";
import { conflictRecordedForFields, identityShiftedTransientResult, isIdentityShiftedEvidence, stableErrorTag } from "../errors.mjs";
import { generateRow } from "../operations.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { isStaleConflictEvidence } from "../redact.mjs";
import { SCENARIO_OBSERVE_POLL_MS, SCENARIO_OBSERVE_TIMEOUT_MS, SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS } from "../constants.mjs";
import { boundedSleep, isDeadlineExpired } from "../timing.mjs";

/** Stable scenario id recorded in redacted artifacts. */
export const id = "multi-field-human-edit";
/** Data scenario: overlaps the data/base workload, not lifecycle-gated. */
export const kind = "data";
/** Raced against actors, or after them before convergence. */
export const allowedPhases = ["concurrent-with-actors", "after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "multi-field-human-edit";

/** Minimum non-primary string fields an entity needs to host a multi-field edit. */
const MIN_STRING_FIELDS = 2;

/**
 * Deterministic plan for one cycle: entity, the 2+ non-primary STRING fields
 * the human edits, the DISTINCT non-primary field the public API updates, a
 * deterministic human value set, and a barrier jitter. Pure function of
 * (seed, cycle) — reads no external run state.
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/humanFields/humanValues/target.
 */
export function plan({ cycle, order, rng, activeEntities }) {
  // MEDIUM 2: the plan's target entity must be in the ACTIVE subset (a
  // --tables run activates only some entities), so a plan never points at an
  // inactive entity. The eligible pool ALWAYS derives from the active subset
  // when one is given (never a fallback to an inactive entity); it is only
  // filtered by the 2+ non-primary string-field requirement. When the active
  // subset has no eligible entity, keep a deterministic plan over that subset
  // marked ineligible so `execute` truthfully skips.
  const basePool = activeEntities !== undefined && activeEntities.length > 0
    ? activeEntities
    : SOAK_ENTITY_ORDER;
  const pool = basePool.filter((entry) => stringFieldCount(entry.name) >= MIN_STRING_FIELDS);
  const eligible = pool.length > 0;
  const entry = eligible ? pool[rng.int(pool.length)] : basePool[rng.int(basePool.length)];
  const abbreviation = entry.name.replace(/^Soak/, "").toLowerCase();
  if (!eligible) {
    // No active entity can host a multi-field edit. Keep a deterministic plan
    // over the active subset whose execute truthfully skips — never fall back
    // to a non-active entity.
    return {
      tag: TAG,
      jitterMs: 1 + rng.int(80),
      eligible: false,
      humanFields: [],
      humanValues: {},
      target: {
        entityName: entry.name,
        field: "id",
        targetId: `multi-${abbreviation}-c${cycle}-${order}`,
      },
    };
  }
  const fieldPlan = SOAK_FIELD_PLANS[entry.name];
  const stringFields = Object.entries(fieldPlan).filter(([name, spec]) => !spec.primary && spec.type === "string");
  const humanCount = Math.min(stringFields.length, MIN_STRING_FIELDS + rng.int(2));
  const humanFields = pickDistinct(rng, stringFields, humanCount).map(([name]) => name);
  const publicCandidates = Object.entries(fieldPlan).filter(([name, spec]) => !spec.primary && !humanFields.includes(name));
  const [publicField] = publicCandidates[rng.int(publicCandidates.length)];
  const humanValues = {};
  for (const field of humanFields) {
    humanValues[field] = `human-multi-c${cycle}-${order}-${field}`;
  }
  return {
    tag: TAG,
    // Barrier jitter: the human multi-field edit lands deterministically
    // after the public-API update starts, so the race window is controlled.
    jitterMs: 1 + rng.int(80),
    eligible: true,
    humanFields,
    humanValues,
    target: {
      entityName: entry.name,
      // The field the public API updates — a DIFFERENT field from the human
      // fields, so the race is a public update of one field against a human
      // multi-field edit of the others.
      field: publicField,
      // Dedicated row: never the base `main`/actor rows.
      targetId: `multi-${abbreviation}-c${cycle}-${order}`,
    },
  };
}

/**
 * Live action: creates a DEDICATED race row, then races a public-API update
 * of ONE field against a direct multi-field human edit of the OTHER 2+
 * fields with a deterministic barrier + jitter. Each SQLite mutation is
 * paired with its oracle mirror/cleanup as a SHORT critical section under
 * the shared oracle lock, but the barrier jitter, the direct Sheet write,
 * and the allSettled classification run OUTSIDE the lock so concurrent
 * actors overlap them.
 *
 * Rejections are classified ONLY by EXACT stable CAS/stale/conflict
 * evidence: a rejected local write or human multi-field write is an expected
 * stale-write compare-and-set conflict only when its error carries one of
 * the exact guard/hash-mismatch codes; a validation, transport, or other
 * direct-write rejection is a real failure. An exact `identity_shifted`
 * rejection of the direct human write is the expected multi-writer
 * transient (a truthful `identity-shifted-transient` skip, never a failure).
 * The scenario then verifies the observable invariants: no duplicate rows
 * for the race id, and the human fields are not silently lost (a bounded
 * observation). A partial application (some human fields landed, others
 * not) is a failure; an ACCEPTED human write whose fields never land is
 * silent loss. The oracle is NEVER updated from an unproven winner — the
 * dedicated race row is removed (in a guaranteed finally path) so the final
 * SQLite state matches the deterministic replay.
 *
 * @param {{ plan: object, context: object }} input plan + live context.
 * @returns {Promise<object>} { status, expectedErrors, failures, cleanupFailures?, reason? }.
 */
export async function execute({ plan, context }) {
  const client = context.live.client;
  const em = context.em.fork();
  const token = context.tokenByEntity.get(plan.target.entityName);
  const expected = new Set(context.activeEntities.map((entry) => entry.name));
  if (token === undefined || !expected.has(plan.target.entityName)) {
    return { status: "skipped", expectedErrors: 0, failures: 0, reason: "local-mode" };
  }
  // No active entity can host a multi-field edit: the deterministic plan is
  // marked ineligible and execute truthfully skips (never an inactive target).
  if (plan.eligible === false) {
    return { status: "skipped", expectedErrors: 0, failures: 0, reason: "no-eligible-entity" };
  }
  const fieldPlan = SOAK_FIELD_PLANS[plan.target.entityName];
  const rng = new SeededRandom(deriveSeed(context.seed, context.cycle * 829 + 61));
  const tabName = `${plan.target.entityName}_Input`;
  const critical = (action) => context.oracleLock === undefined
    ? action()
    : context.oracleLock.withLock(action);
  let cleanupFailures = 0;
  let failures = 0;
  // Stable diagnostic kinds for each `failures += 1` site (allowlisted,
  // never raw text) so a failed record says WHICH invariant fired.
  const failureKinds = new Set();
  let humanLanded = "not-applied";
  let result;
  // True once the human multi-field write actually resolved (was accepted by
  // the direct seam). Used to distinguish a silent-loss failure (accepted
  // but no field landed) from an expected stale conflict (rejected, fields
  // keep their prior values).
  let humanAccepted = false;
  // True once the direct human multi-field write actually STARTED (a
  // deadline-crossed no-op never starts). A started write's remote outcome is
  // uncertain even when it rejects (it may have mutated before rejecting), so
  // the cleanup settle window must require complete landing proof for it.
  let humanStarted = false;
  try {
    // Critical section: create the DEDICATED race row and mirror it into the
    // oracle atomically against concurrent actor verification. The row keeps
    // the base actor/prologue rows and the harness oracle's expected state
    // untouched.
    await critical(async () => {
      const row = { id: plan.target.targetId, ...generateRow(rng, fieldPlan) };
      em.persist(em.create(token, row));
      await em.flush();
      context.oracle?.applyMutation({ op: "insert", entity: plan.target.entityName, row });
    });

    // Bounded projection readiness: do NOT start the direct multi-field
    // mutation (the human edit) until the dedicated row's projection is
    // observable via the existing bounded direct-Sheet reads. If the
    // projection never appears within the bound, record a truthful
    // `projection-not-ready` skip and clean up — never a doomed direct write.
    const projected = await awaitInputProjection(
      client, context.live.spreadsheetId, tabName, plan.target, context,
    );
    if (!projected) {
      result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "projection-not-ready" };
    } else {
      // Public-API update of ONE field starts first; the direct human
      // multi-field edit lands after the deterministic barrier + jitter, so
      // the race window is controlled. The public mutation's OWN SQLite
      // mutation runs as a short critical section, but the barrier jitter
      // and the direct Sheet write below run OUTSIDE the lock so concurrent
      // actors can overlap them. Mark the local promise handled immediately
      // so a rejection during the barrier sleep is never an unhandled
      // rejection; Promise.allSettled below still observes it.
      const publicSpec = fieldPlan[plan.target.field];
      const localValue = localValueFor(publicSpec, context.cycle);
      const localPromise = (async () => {
        return critical(async () => {
          const current = await em.findOne(token, { id: plan.target.targetId });
          if (current === null) return;
          current[plan.target.field] = localValue;
          await em.flush();
          // Mirror the committed local update into the oracle BEFORE
          // releasing the shared lock, so a concurrent actor verifying
          // against the oracle never sees the race row present in SQLite
          // but stale in the oracle.
          context.oracle?.applyMutation({
            op: "update",
            entity: plan.target.entityName,
            id: plan.target.targetId,
            patch: { [plan.target.field]: localValue },
          });
        });
      })();
      localPromise.catch(() => {});
      // MEDIUM 3: bound the barrier jitter by the run deadline so the human
      // write can never start after the budget expired (a bounded wait, never
      // an unconstrained sleep).
      const deadlineAt = context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER;
      await boundedSleep(plan.jitterMs, deadlineAt);
      // MEDIUM 4: after the bounded jitter the run deadline may have
      // expired. Never start the direct human write against an expired
      // budget: settle the local mutation and report a truthful skip/limited
      // outcome, and still clean the authority/oracle below. The human
      // promise is a no-op in that case so the allSettled classification
      // never counts an unstarted human write as a transport/direct-write
      // failure.
      // Clock-slop tolerant expiry check: the bounded jitter sleep can wake
      // up to ~1-2ms short of the nominal deadline, and a zero-tolerance
      // reading would flakily start the human write after the budget ended.
      const deadlineExpired = isDeadlineExpired(deadlineAt);
      // Track whether the direct human write actually STARTED. A deadline
      // crossing before the write begins is a truthful skip, never a silent
      // loss: the write never started, so an unstarted no-op must not set
      // `humanAccepted` (which would report silent loss for a write that
      // never ran).
      const humanPromise = deadlineExpired
        ? Promise.resolve(undefined)
        : (() => {
            humanStarted = true;
            return client.mutateInputCells({
              spreadsheetId: context.live.spreadsheetId,
              tabName,
              identity: plan.target.targetId,
              fields: plan.humanValues,
              deadlineAtMs: context.deadlineAtMs,
            });
          })();
      const [localResult, humanResult] = await Promise.allSettled([localPromise, humanPromise]);
      // Classify rejections ONLY by EXACT stale-write/CAS/conflict evidence
      // (a guard/hash mismatch on the raced row). A validation/transport
      // rejection is a real failure. The direct seam's fail-closed
      // `identity_shifted` evidence is an EXPECTED TRANSIENT of the
      // multi-writer soak (never counted as a failure): the seam proved no
      // silent success and the write outcome is unobservable, so the
      // scenario records a truthful skip below.
      if (localResult.status === "rejected" && !isStaleConflictEvidence(localResult.reason)) {
        failures += 1;
        failureKinds.add("local-rejection-non-stale");
      }
      let humanTransient;
      if (humanResult.status === "rejected") {
        // A rejected human multi-field write is expected ONLY on exact
        // CAS/stale evidence (the human edit targeted a row the local
        // update already shifted) or on the transient `identity_shifted`
        // guard; any transport/validation rejection is a real failure.
        if (isIdentityShiftedEvidence(humanResult.reason)) {
          humanTransient = identityShiftedTransientResult(humanResult.reason);
        } else if (!isStaleConflictEvidence(humanResult.reason)) {
          failures += 1;
          failureKinds.add("human-rejection-non-stale");
        }
      } else if (humanStarted) {
        // Only a write that actually started and resolved can be accepted.
        // A deadline-crossed no-op (humanStarted=false) is never an accepted
        // human write, so it cannot report silent loss.
        humanAccepted = true;
      }
      // Observable invariant: no duplicate rows for the race id (the race
      // must never produce duplicate projection rows). Read through a FRESH
      // fork so the identity-mapped write em never hides an inbound worker
      // projection of the raced row.
      const rows = await context.em.fork().find(token, { id: plan.target.targetId });
      if (rows.length > 1) {
        failures += 1;
        failureKinds.add("duplicate-rows");
      }
      // Bounded observation: the human fields must not be silently lost. A
      // partial application (some fields landed, others not) is a failure;
      // an ACCEPTED human write whose fields never land is silent loss.
      // When an earlier step already recorded a failure, the outcome is
      // settled and the observation only needs to bound its own work (no
      // async-landing wait), so it is passed the current failure count.
      const humanLandedNow = await observeHumanFields(context, token, plan, critical, humanAccepted, failures);
      humanLanded = humanLandedNow;
      // Conflict-recorded outcome: when an outbox effect for this binding was
      // in flight, the poll gate deliberately skips the row and the human
      // edit is ingested later as an OPEN sync_conflict — a VALID consistent
      // outcome per the hypothesis. Before counting a row-based
      // partial/silent-loss failure, every non-landed field is resolved
      // against the conflict records: landed OR conflict-recorded is
      // accounted, and only a field with NEITHER is lost.
      let conflictRecorded = false;
      if (humanLanded === "partial" || (humanLanded === "not-applied" && humanAccepted)) {
        const outcome = await resolveHumanFieldsOutcome(context, token, plan, critical);
        if (outcome === "landed") {
          humanLanded = "landed";
        } else if (outcome === "conflict-recorded") {
          conflictRecorded = true;
        } else if (humanLanded === "partial") {
          failures += 1;
          failureKinds.add("partial-landing");
        } else {
          failures += 1;
          failureKinds.add("silent-loss");
        }
      }
      result = failures > 0
        ? { status: "failed", expectedErrors: 0, failures, reason: "scenario-error" }
        : humanTransient !== undefined
          ? humanTransient
          : humanLanded === "landed"
          ? { status: "ok", expectedErrors: 0, failures: 0, reason: "race-winner-verified" }
          : conflictRecorded
          ? { status: "ok", expectedErrors: 0, failures: 0, reason: "conflict-recorded" }
          : deadlineExpired
            ? { status: "skipped", expectedErrors: 0, failures: 0, reason: "deadline-expired" }
            : { status: "skipped", expectedErrors: 0, failures: 0, reason: "winner-not-verified" };
    }
  } catch (error) {
    result = {
      status: "failed",
      expectedErrors: 0,
      failures: 1,
      reason: "scenario-error",
      reasonTag: stableErrorTag(error),
    };
  } finally {
    // Guaranteed cleanup: remove the dedicated race row and mirror the
    // delete so SQLite and the oracle stay symmetric even when the race,
    // an observation, or an authority read failed. A cleanup failure is
    // recorded separately (cleanupFailures) and never masks the original
    // failure.
    //
    // An ACCEPTED human write whose observation never confirmed may still
    // be mid-drain: deleting the row now would tombstone the binding under
    // an in-flight inbound observation (the observation/projection result
    // is not yet terminal). Wait a bounded window for the inbound
    // observation to land before the delete so the removal is ordered after
    // it. This is bounded and never changes the classification above; it
    // only stops the cleanup from racing an accepted-but-unconfirmed write.
    try {
      // Only delete the dedicated row when the settle window produced
      // durable/complete terminal evidence (the accepted write landed, or it
      // was rejected). When the proof times out the row is NOT deleted —
      // deleting would tombstone the binding under an in-flight inbound
      // observation (the #381 race) — and the leftover row is surfaced as a
      // cleanup failure instead of being silently removed.
      const safeToDelete = await settleTerminalBeforeCleanup(
        context, token, plan, critical, humanStarted, humanAccepted, humanLanded,
      );
      if (safeToDelete) {
        await critical(async () => {
          const rows = await em.find(token, { id: plan.target.targetId });
          for (const raceRow of rows) {
            em.remove(raceRow);
          }
          await em.flush();
          context.oracle?.applyMutation({ op: "delete", entity: plan.target.entityName, id: plan.target.targetId });
        });
      } else {
        cleanupFailures += 1;
        failureKinds.add("cleanup-proof-timeout");
      }
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
 * Bounded pre-delete settle for an accepted-but-unconfirmed human write.
 *
 * The inbound observation of a direct human edit lands asynchronously (via
 * the library's polling). If an accepted write was never confirmed landed,
 * deleting the dedicated row now would tombstone its binding while the
 * inbound observation/projection result is still in flight. This waits a
 * SMALL bounded window (a few settle reads, capped at the run deadline) for
 * the observation to land before the cleanup delete is ordered, so the
 * delete is never issued against a still-draining observation.
 *
 * Every settle read goes through a FRESH fork of the public EntityManager so
 * the identity-mapped write em never hides an inbound worker update. The
 * delete is allowed only on durable/complete terminal evidence: ALL human
 * fields landed (atomic application) across consecutive reads, every
 * non-landed field recorded as an OPEN sync_conflict (a recorded conflict IS
 * terminal — the ingestion completed as a conflict), or the write never
 * started (a truthful bounded skip). When the proof times out the caller
 * must NOT delete (returning false) — deleting would tombstone the binding
 * under an in-flight observation (the #381 race).
 *
 * @returns {Promise<boolean>} true when it is safe to delete the row
 *   (write never started, confirmed complete landing, or every non-landed
 *   field recorded as an OPEN conflict); false when the proof timed out
 *   and the row must be left in place.
 */
async function settleTerminalBeforeCleanup(
  context, token, plan, critical, humanStarted, humanAccepted, humanLanded,
) {
  // A write that never started (a deadline-crossed no-op) is a truthful
  // bounded skip: no remote mutation was ever ordered, so deleting the
  // dedicated row cannot recreate the #381 tombstone race.
  if (!humanStarted) return true;
  // A confirmed complete landing is terminal proof: all human fields landed
  // atomically, so the inbound observation is drained and the delete is safe.
  if (humanLanded === "landed") return true;
  // Immediate terminal proof before the bounded wait: a recorded OPEN
  // conflict is DURABLE evidence the ingestion already completed as a
  // conflict, so the cleanup delete is safe without spending the window
  // (the observation above may have consumed the whole deadline polling a
  // row the gate deliberately skips). The loop below still re-checks every
  // iteration for a conflict that lands DURING the settle window.
  const immediate = await resolveHumanFieldsOutcome(context, token, plan, critical);
  if (immediate !== "unresolved") return true;
  // Otherwise the remote outcome is uncertain: an accepted write may still be
  // mid-drain, a STARTED write may have rejected AFTER a remote mutation, or a
  // partial landing may precede later field landing. Require complete
  // consecutive landing proof before the delete is ordered.
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  let landedStreak = 0;
  while (Date.now() < deadline) {
    let landedFields = [];
    await critical(async () => {
      const row = await context.em.fork().findOne(token, { id: plan.target.targetId });
      if (row === null) return;
      landedFields = plan.humanFields.filter((field) => row[field] === plan.humanValues[field]);
    });
    // Require COMPLETE evidence: all human fields landed (atomic
    // application), confirmed across consecutive reads (durable) before the
    // cleanup delete is ordered. A partial landing is not terminal proof —
    // unless every non-landed field is recorded as an OPEN sync_conflict:
    // the conflict record is itself durable terminal proof (the ingestion
    // completed as a conflict), so the delete is ordered after it.
    if (landedFields.length === plan.humanFields.length) {
      landedStreak += 1;
      if (landedStreak >= SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS) return true;
    } else {
      const missing = plan.humanFields.filter((field) => !landedFields.includes(field));
      const recorded = await conflictRecordedForFields(
        context,
        missing.map((field) => ({ field, expectedValue: plan.humanValues[field] })),
      );
      if (missing.every((field) => recorded.has(field))) return true;
      landedStreak = 0;
    }
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
  // Proof timed out: the remote outcome was never confirmed landed. Do NOT
  // delete the row — deleting now would tombstone the binding under an
  // in-flight inbound observation or an uncertain remote outcome (the #381
  // race). The caller records a cleanup failure so the leftover row is
  // surfaced, never silently removed.
  return false;
}

/**
 * Resolves the terminal per-field outcome of the human multi-field edit.
 *
 * Reads the dedicated row once (fresh fork, under the shared lock) and
 * resolves every non-landed field against the OPEN sync_conflict records:
 *
 * - "landed": ALL human fields show their human values (a late landing
 *   the bounded observation may have just missed).
 * - "conflict-recorded": every non-landed field has an OPEN conflict
 *   record carrying the exact human value (landed OR conflicted covers
 *   every field — the consistent outcome).
 * - "unresolved": some field has NEITHER a row landing NOR a conflict
 *   record (genuinely lost).
 *
 * @returns {Promise<"landed" | "conflict-recorded" | "unresolved">}
 */
async function resolveHumanFieldsOutcome(context, token, plan, critical) {
  let landedFields = [];
  await critical(async () => {
    const row = await context.em.fork().findOne(token, { id: plan.target.targetId });
    if (row === null) return;
    landedFields = plan.humanFields.filter((field) => row[field] === plan.humanValues[field]);
  });
  if (landedFields.length === plan.humanFields.length) return "landed";
  const missing = plan.humanFields.filter((field) => !landedFields.includes(field));
  const recorded = await conflictRecordedForFields(
    context,
    missing.map((field) => ({ field, expectedValue: plan.humanValues[field] })),
  );
  return missing.every((field) => recorded.has(field)) ? "conflict-recorded" : "unresolved";
}

/**
 * Bounded observation of the dedicated row's human fields over the public
 * authority.
 *
 * Polls the authority (through the public EntityManager) until the human
 * fields settle on one state. The human edit lands asynchronously (via the
 * library's polling, up to one full polling round), so a positive state
 * (landed/partial) settles only across `SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS`
 * separated reads, and a still-"not-applied" row is polled until the
 * observation deadline rather than being settled early. Returns:
 *
 * - "landed": ALL human fields show their human values (atomic application).
 * - "partial": SOME but not all human fields show their human values
 *   (partial field application — a failure).
 * - "not-applied": NONE of the human fields show their human values by the
 *   deadline.
 *
 * Each poll acquires the shared oracle lock ONLY for the instant read (a
 * short critical section), so concurrent actors can overlap the sleeps
 * between polls.
 *
 * @returns {Promise<"landed" | "partial" | "not-applied" | "unobserved">}
 */
async function observeHumanFields(context, token, plan, critical, humanAccepted, alreadyFailed) {
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  let lastState;
  let streak = 0;
  while (true) {
    // The human write lands asynchronously (via the library's polling, up to
    // one full polling round). Settling on the first few "not-applied"
    // reads would misclassify a not-yet-applied write as silent loss and then
    // delete the row before polling ever reflects it. So only a POSITIVE
    // state (landed/partial) settles on the streak threshold; a still-
    // "not-applied" row keeps being polled until the observation deadline.
    if (Date.now() >= deadline) return lastState ?? "not-applied";
    let state = "not-applied";
    await critical(async () => {
      // Read through a FRESH fork so the identity-mapped write em never
      // hides an inbound worker update (the polling pipeline writes through
      // its own em; a reused em's identity map would return the stale cached
      // row and recreate the #381 false-failure race).
      const row = await context.em.fork().findOne(token, { id: plan.target.targetId });
      if (row === null) {
        state = "not-applied";
        return;
      }
      const landed = plan.humanFields.filter((field) => row[field] === plan.humanValues[field]);
      if (landed.length === plan.humanFields.length) state = "landed";
      else if (landed.length > 0) state = "partial";
      else state = "not-applied";
    });
    if (state === lastState) {
      streak += 1;
    } else {
      lastState = state;
      streak = 1;
    }
    // A REJECTED human write (humanAccepted=false) never lands, so its
    // "not-applied" state is final and settles on the streak threshold. An
    // already-failed scenario (alreadyFailed > 0) has its outcome decided,
    // so its observation likewise settles on the threshold instead of
    // waiting out the async-landing deadline. Only an ACCEPTED write in an
    // otherwise-clean scenario waits for the library's async polling to
    // reflect it, so its still-"not-applied" row is polled until the
    // deadline (a positive landed/partial always settles on the threshold).
    if ((state !== "not-applied" || !humanAccepted || alreadyFailed > 0) &&
        streak >= SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS) {
      return state;
    }
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
}

/**
 * Reads the display cells of the dedicated race row through the direct-Sheet
 * read seam.
 *
 * Returns `undefined` when the row's projection (or the id header) is not
 * yet present in the tab, so callers can distinguish "not projected yet"
 * from a real row.
 *
 * @returns {Promise<unknown[] | undefined>}
 */
async function readInputRow(client, spreadsheetId, tabName, target, context, deadlineAtMs) {
  const rows = await client.readTabRows(spreadsheetId, tabName, {
    deadlineAtMs: deadlineAtMs ?? context.deadlineAtMs,
  });
  const headers = rows[0] ?? [];
  const idColumn = headers.indexOf("id");
  if (idColumn < 0) return undefined;
  const cells = rows.find((entry, index) => index > 0 && entry[idColumn] === target.targetId);
  if (cells === undefined) return undefined;
  return cells;
}

/**
 * Bounded projection readiness: polls the direct-Sheet read seam until the
 * dedicated race row's projection is observable in the _Input tab.
 *
 * The human write's direct mutation seam requires the identity row to
 * already exist in the tab; the row is created in the authority and projected
 * by the sync worker asynchronously. Returns `true` once the row is visible,
 * or `false` when it never appears within the bounded window (the caller
 * records a truthful `projection-not-ready` skip and never starts a doomed
 * direct Sheet write).
 *
 * @returns {Promise<boolean>}
 */
async function awaitInputProjection(client, spreadsheetId, tabName, target, context) {
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  while (true) {
    if (Date.now() >= deadline) return false;
    // Pass the ACTIVE phase deadline to the read so a slow request cannot
    // outlive the phase just because the run budget is larger.
    const row = await readInputRow(client, spreadsheetId, tabName, target, context, deadline);
    // A slow read can resolve after the phase deadline (a request started
    // just before it): a projection observed only after the deadline is never
    // actionable within the active phase, so reject it and stop.
    if (Date.now() >= deadline) return false;
    if (row !== undefined) return true;
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
}

/**
 * Deterministic, idempotent orphan recovery for this scenario's dedicated
 * race row on a process-death resume.
 *
 * A run that dies before this scenario's guaranteed finally can leave the
 * deterministic dedicated `targetId` row in the authority; the resume replay
 * would reject it as a foreign id. This hook removes that exact planned row
 * (and only it) through the public EntityManager, so a resume of an
 * interrupted in-flight cycle never fails the DB proof over an orphan. It is
 * derived solely from the persisted seed/cycle plan (same inputs -> same
 * orphan id), is idempotent (removing a missing row is a no-op), and is
 * restart-safe. Never touches internal storage/outbox.
 *
 * @param {{ plan: object, context: object }} input the deterministic plan
 *   and a recovery context exposing the public seams (`em`, `tokenByEntity`,
 *   `activeEntities`).
 * @returns {Promise<{ removed: number }>}
 */
export async function recover({ plan, context }) {
  const token = context.tokenByEntity.get(plan.target.entityName);
  const active = new Set(context.activeEntities.map((entry) => entry.name));
  if (token === undefined || !active.has(plan.target.entityName)) return { removed: 0 };
  const em = context.em.fork();
  const rows = await em.find(token, { id: plan.target.targetId });
  let removed = 0;
  for (const row of rows) {
    em.remove(row);
    removed += 1;
  }
  if (removed > 0) await em.flush();
  return { removed };
}

/** Number of non-primary string fields an entity's plan exposes. */
function stringFieldCount(entityName) {
  const plan = SOAK_FIELD_PLANS[entityName];
  if (plan === undefined) return 0;
  return Object.values(plan).filter((spec) => !spec.primary && spec.type === "string").length;
}

/** Picks `count` distinct entries from `items` deterministically. */
function pickDistinct(rng, items, count) {
  const copy = [...items];
  const picked = [];
  for (let index = 0; index < count; index += 1) {
    picked.push(copy.splice(rng.int(copy.length), 1)[0]);
  }
  return picked;
}

/** Deterministic, type-valid local value for the public field's spec. */
function localValueFor(spec, cycle) {
  switch (spec.type) {
    case "string": return `local-${cycle}`;
    case "number": return cycle;
    case "boolean": return cycle % 2 === 0;
    case "date": return new Date(1_704_067_200_000 + cycle * 1000);
    default: return `local-${cycle}`;
  }
}
