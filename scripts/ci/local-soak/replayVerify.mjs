import { SOAK_FIELD_PLANS } from "./entities.mjs";
import { rowValuesEqual } from "./executor.mjs";
import { probeOverrideCandidates } from "./replayPlan.mjs";

/**
 * Builds the DB-backed probe evidence set for a replay window from the
 * observed authority rows.
 *
 * A structurally valid ok probe is trusted for the replay oracle mutation
 * ONLY when the SQLite authority contains the deterministic human-edit
 * value for that exact cycle/table/field: the candidate's main row must
 * exist and carry `human-edit-c<cycle>` in the candidate's deterministic
 * field. Anything else (row missing, value absent, value altered) is
 * missing evidence — the probe claim is not backed by the authority and
 * the resume fails closed instead of trusting it.
 *
 * @param {object} args { state, activeEntities, cycleByNumber,
 *   inFlightCycle, observedByTable }.
 * @returns {Set<string>} granted evidence keys (`probeEvidenceKey`).
 */
export function buildProbeEvidence({ state, activeEntities, cycleByNumber, inFlightCycle, observedByTable }) {
  const replayThrough = inFlightCycle ?? state.lastCompletedCycle;
  const candidates = probeOverrideCandidates(state, activeEntities, cycleByNumber, replayThrough);
  const evidence = new Set();
  for (const [key, candidate] of candidates) {
    const observed = observedByTable.get(candidate.entry.tableName);
    const row = observed === undefined ? undefined : observed.get(String(candidate.mainId));
    if (row !== undefined && row[candidate.field] === candidate.value) {
      evidence.add(key);
    }
  }
  return evidence;
}

/**
 * Fails a DB-backed resume closed when a structurally valid ok probe
 * record is NOT backed by the SQLite authority.
 *
 * The runner records an ok probe only after the deterministic human edit
 * was accepted by SQLite, so an ok probe without the authority evidence
 * (forged record with adjusted counters, unchanged DB) is tampered
 * history: the replay oracle must never be mutated by it and the exact
 * proof must never pass. The failure message stays redacted — cycle
 * number and table name only, never the field, value, or id.
 *
 * @param {object} replay replay built with a `probeEvidence` set.
 * @returns {void} throws when any candidate lacked the evidence.
 */
export function requireProbeEvidenceOrFail(replay) {
  if (replay.ungrantedProbeOverrides.length === 0) return;
  const { cycle, tableName } = replay.ungrantedProbeOverrides[0];
  throw new Error(
    `--resume failed: cycle ${cycle} records an ok probe for table ${tableName} ` +
    "that is not backed by the SQLite authority: the deterministic " +
    "human-edit evidence for that exact cycle/table is missing from " +
    "soak.sqlite (an ok probe always leaves the edited value in the " +
    "authority); the probe record is forged or tampered history",
  );
}

/**
 * True when an observed interrupted-cycle row matches one of the allowed
 * deterministic contents for its id across the prefix-cycle plans.
 *
 * The main row may be caught pre- or post-patch (the prologue update is a
 * separate flush) and an actor row may be caught at any committed stage
 * its operation can legitimately leave behind: actor rows therefore carry
 * the operation's full deterministic candidate set (the two-flush
 * forkIsolation op contributes its pre-patch AND post-patch row, every
 * other creating op exactly one row). Any content outside the bound
 * candidates is rejected — never a plausible interrupted prefix.
 *
 * @param {object[]} prefixPlans per-table prefix-cycle plans.
 * @param {string} id observed row id.
 * @param {object} row observed plain row.
 * @param {object} fieldPlan entity field plan.
 * @returns {boolean}
 */
export function matchAllowedPrefixRow(prefixPlans, id, row, fieldPlan) {
  for (const plan of prefixPlans) {
    if (String(plan.mainId) === id) {
      const contents = [plan.mainPre, plan.mainPost];
      if (plan.probeOverride !== undefined) {
        contents.push({ ...plan.mainPost, [plan.probeOverride.field]: plan.probeOverride.value });
      }
      return contents.some((content) => rowValuesEqual(content, row, fieldPlan));
    }
    if (String(plan.churnId) === id) {
      return rowValuesEqual(plan.churnRow, row, fieldPlan);
    }
    const actorContents = plan.actorRows.get(id);
    if (actorContents !== undefined) {
      return actorContents.some((content) => rowValuesEqual(content, row, fieldPlan));
    }
  }
  return false;
}

/** Rebuilds the oracle from SQLite (the authority) after a resume. */
export async function rebuildOracleFromSqlite(hikoutei, oracle, activeEntities, tokenByEntity, progress) {
  const em = hikoutei.em.fork();
  for (const entry of activeEntities) {
    const token = tokenByEntity.get(entry.name);
    const rows = await em.find(token, {});
    for (const row of rows) {
      const plain = {};
      for (const [field, spec] of Object.entries(SOAK_FIELD_PLANS[entry.name])) {
        plain[field] = row[field] ?? null;
        if (spec.type === "date" && plain[field] instanceof Date === false) {
          plain[field] = plain[field] === null ? null : new Date(plain[field]);
        }
      }
      oracle.applyMutation({ op: "insert", entity: entry.name, row: plain });
    }
  }
  progress(`oracle rebuilt from sqlite (${activeEntities.map((entry) => entry.name).length} tables)`);
}
