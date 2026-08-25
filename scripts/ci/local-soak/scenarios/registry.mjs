/**
 * Scenario registry for the soak attack-injection scheduler.
 *
 * Explicitly registers every attack scenario module. The scheduler and the
 * cycle executor consume ONLY this registry's contract — they never import a
 * scenario directly and never depend on scenario internals. Adding or
 * removing a scenario is a single registry edit.
 *
 * Each attack scenario lands in its own PR by adding its module here (a
 * single registry edit); the scheduler and executor are already
 * scenario-agnostic.
 */

import * as invalidHumanInput from "./invalidHumanInput.mjs";
import * as localHumanWriteRace from "./localHumanWriteRace.mjs";
import * as deleteRecreateRace from "./deleteRecreateRace.mjs";
import * as pendingDeliveryReopen from "./pendingDeliveryReopen.mjs";
import * as multiFieldHumanEdit from "./multi-field-human-edit.mjs";
import * as deleteRecreateHumanEdit from "./deleteRecreateHumanEdit.mjs";
import * as humanEditPublicDelete from "./human-edit-public-delete.mjs";
import * as humanInsertDuplicateId from "./human-insert-duplicate-id.mjs";
import * as humanDeleteRow from "./human-delete-row.mjs";
import * as noOpHumanEdit from "./no-op-human-edit.mjs";
import * as sheetCorruptionDetection from "./sheetCorruptionDetection.mjs";

/**
 * Every registered scenario, in stable registration order. Each entry is a
 * scenario module exposing `id`, `kind`, `allowedPhases`, `TAG`, `plan`,
 * `execute`, and where applicable `recover`. Scenario modules never import
 * one another. Add a scenario by importing its module here and appending it
 * to this array.
 */
export const SCENARIO_REGISTRY = Object.freeze([
  invalidHumanInput,
  localHumanWriteRace,
  deleteRecreateRace,
  pendingDeliveryReopen,
  multiFieldHumanEdit,
  deleteRecreateHumanEdit,
  humanEditPublicDelete,
  humanInsertDuplicateId,
  humanDeleteRow,
  noOpHumanEdit,
  sheetCorruptionDetection,
]);

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
