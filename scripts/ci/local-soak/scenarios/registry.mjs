/**
 * Scenario registry for the soak attack-injection scheduler.
 *
 * Explicitly registers every attack scenario module. The scheduler and the
 * cycle executor consume ONLY this registry's contract — they never import a
 * scenario directly and never depend on scenario internals. Adding or
 * removing a scenario is a single registry edit.
 *
 * This PR ships the framework with an EMPTY registry (no attack scenarios
 * registered yet). Each attack scenario lands in its own later PR by adding
 * its module here plus a `scenarioVocabulary`/resume-schema entry where
 * applicable; the scheduler and executor are already scenario-agnostic.
 */

/**
 * Every registered scenario, in stable registration order. Each entry is a
 * scenario module exposing `id`, `kind`, `allowedPhases`, `TAG`, `plan`,
 * `execute`. Scenario modules never import one another. Empty until the
 * first scenario PR registers modules.
 */
export const SCENARIO_REGISTRY = Object.freeze([]);

/** Scenarios ordered by id for deterministic lookups. */
const BY_ID = new Map(SCENARIO_REGISTRY.map((scenario) => [scenario.id, scenario]));

/**
 * Returns a registered scenario module by its fixed id.
 *
 * @param {string} id a registered scenario id.
 * @returns {object} the scenario module, or `undefined` when unknown.
 */
export function getScenarioById(id) {
  return BY_ID.get(id);
}
