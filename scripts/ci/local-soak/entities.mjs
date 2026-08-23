/**
 * Six independent scalar soak entities for the local multi-table runner.
 *
 * Every entity is a flat scalar table with a string primary key — no
 * relations, foreign keys, joins, or populate. `customerKey` on Order is an
 * opaque scalar string, never a reference. All tokens come from the public
 * `defineTypedSheetsEntity()` of the CURRENT LOCAL BUILD (imported through
 * the package self-reference `hikoutei`), never from npm.
 */

import { defineTypedSheetsEntity } from "hikoutei";

/**
 * Stable entity order used by the workload rotation and probes.
 * @type {readonly { name: string, tableName: string }[]}
 */
export const SOAK_ENTITY_ORDER = Object.freeze([
  { name: "SoakCustomer", tableName: "soak_customers" },
  { name: "SoakOrder", tableName: "soak_orders" },
  { name: "SoakInventoryItem", tableName: "soak_inventory_items" },
  { name: "SoakTask", tableName: "soak_tasks" },
  { name: "SoakAuditEvent", tableName: "soak_audit_events" },
  { name: "SoakFeatureFlag", tableName: "soak_feature_flags" },
]);

/** Field kinds the generator emits, keyed by entity name (synthetic values). */
export const SOAK_FIELD_PLANS = Object.freeze({
  SoakCustomer: Object.freeze({
    id: Object.freeze({ type: "string", primary: true }),
    name: Object.freeze({ type: "string" }),
    tier: Object.freeze({ type: "string" }),
    active: Object.freeze({ type: "boolean" }),
    signupAt: Object.freeze({ type: "date" }),
  }),
  SoakOrder: Object.freeze({
    id: Object.freeze({ type: "string", primary: true }),
    customerKey: Object.freeze({ type: "string" }),
    status: Object.freeze({ type: "string" }),
    total: Object.freeze({ type: "number" }),
    placedAt: Object.freeze({ type: "date" }),
    fulfilled: Object.freeze({ type: "boolean", nullable: true }),
  }),
  SoakInventoryItem: Object.freeze({
    id: Object.freeze({ type: "string", primary: true }),
    sku: Object.freeze({ type: "string" }),
    quantity: Object.freeze({ type: "number" }),
    reorderPoint: Object.freeze({ type: "number" }),
    warehouse: Object.freeze({ type: "string" }),
    updatedAt: Object.freeze({ type: "date", nullable: true }),
  }),
  SoakTask: Object.freeze({
    id: Object.freeze({ type: "string", primary: true }),
    title: Object.freeze({ type: "string" }),
    priority: Object.freeze({ type: "number" }),
    done: Object.freeze({ type: "boolean" }),
    dueAt: Object.freeze({ type: "date", nullable: true }),
    tag: Object.freeze({ type: "string", nullable: true }),
  }),
  SoakAuditEvent: Object.freeze({
    id: Object.freeze({ type: "string", primary: true }),
    action: Object.freeze({ type: "string" }),
    severity: Object.freeze({ type: "string" }),
    count: Object.freeze({ type: "number" }),
    occurredAt: Object.freeze({ type: "date" }),
  }),
  SoakFeatureFlag: Object.freeze({
    id: Object.freeze({ type: "string", primary: true }),
    enabled: Object.freeze({ type: "boolean" }),
    rolloutPercent: Object.freeze({ type: "number" }),
    description: Object.freeze({ type: "string", nullable: true }),
    updatedAt: Object.freeze({ type: "date" }),
  }),
});

/**
 * Builds the six soak entity tokens.
 *
 * `suffix` disambiguates entity names across independent soak runs that
 * share one registry; the table names stay fixed so the sandbox spreadsheet
 * and resume state stay stable across a 6h/24h pair of runs.
 *
 * @param {{ suffix?: string }} [options]
 * @returns {{ tokens: object[], byName: Map<string, object> }}
 */
export function buildSoakEntities(options = {}) {
  const suffix = options.suffix === undefined ? "" : String(options.suffix);
  const tokens = SOAK_ENTITY_ORDER.map((entry) => defineTypedSheetsEntity({
    name: `${entry.name}${suffix}`,
    tableName: entry.tableName,
    properties: entityProperties(entry.name),
  }));
  const byName = new Map(
    tokens.map((token, index) => [SOAK_ENTITY_ORDER[index].name, token]),
  );
  return { tokens, byName };
}

/**
 * Clones one entity's property plan into a fresh descriptor input.
 * @param {string} entityName
 */
function entityProperties(entityName) {
  const plan = SOAK_FIELD_PLANS[entityName];
  if (plan === undefined) throw new Error(`unknown soak entity: ${entityName}`);
  const properties = {};
  for (const [field, spec] of Object.entries(plan)) {
    properties[field] = { ...spec };
  }
  return properties;
}

/**
 * Returns the known soak projection table name for one entity name, or
 * `undefined` when the entity is not a registered soak entity.
 *
 * Used to derive the redacted, allowlisted `targetTable` proof a scenario
 * record carries (never a raw entity id/value or URL). The table name is a
 * fixed soak vocabulary entry, so it survives redaction unchanged and a
 * resume proof can bind a recorded scenario batch to the actual active
 * subset without ever recording raw ids. Unknown names return `undefined`
 * so callers omit the field rather than record an unvetted name.
 *
 * @param {string} entityName a soak entity name.
 * @returns {string | undefined} the entity's soak table name.
 */
export function soakTableNameForEntity(entityName) {
  return SOAK_ENTITY_ORDER.find((entry) => entry.name === entityName)?.tableName;
}

/**
 * Returns the mutable (non-primary) field metadata for one entity.
 * @param {string} entityName
 */
export function mutableFields(entityName) {
  const plan = SOAK_FIELD_PLANS[entityName];
  if (plan === undefined) throw new Error(`unknown soak entity: ${entityName}`);
  return Object.entries(plan)
    .filter(([field, spec]) => field !== "id" && !spec.primary)
    .map(([field, spec]) => ({ field, ...spec }));
}
