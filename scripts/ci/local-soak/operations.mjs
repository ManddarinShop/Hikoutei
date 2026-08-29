/**
 * Deterministic soak workload generation and execution.
 *
 * Every operation is planned from the seeded PRNG and executed ONLY through
 * the supported public EntityManager surface: `fork()`, `create()`, `find()`,
 * `findOne()`, `count()`, `findAndCount()`, `persist()`, `remove()`,
 * `flush()`, and `transactional()`. No internal provider, worker, or SQL API
 * is part of the mutation path.
 *
 * Determinism contract: the final oracle state after one cycle is identical
 * regardless of actor scheduling because (a) the shared prologue is
 * sequential and (b) concurrent actors touch disjoint, actor-scoped ids.
 */

import { deriveSeed, SeededRandom } from "./prng.mjs";

/** Neutral synthetic word pool for string fields (no emails, ids, or urls). */
const WORDS = Object.freeze([
  "amber", "basalt", "cobalt", "dune", "ember", "fjord", "garnet", "harbor",
  "indigo", "juniper", "kelp", "lumen", "moss", "nimbus", "onyx", "patch",
  "quartz", "ripple", "slate", "tundra", "umber", "verdant", "willow", "zephyr",
]);

/** Deterministic epoch base for generated dates (2024-01-01T00:00:00Z). */
const DATE_BASE_MS = 1_704_067_200_000;

/** Table abbreviations used inside deterministic ids. */
const TABLE_ABBREVIATIONS = {
  SoakCustomer: "cust",
  SoakOrder: "ord",
  SoakInventoryItem: "inv",
  SoakTask: "task",
  SoakAuditEvent: "audit",
  SoakFeatureFlag: "flag",
};

/**
 * Deterministic id for the shared per-cycle entities of one table.
 * `variant` distinguishes the long-lived row ("main") from the row deleted
 * within the same cycle ("churn").
 */
export function sharedEntityId(entityName, cycle, variant) {
  return `${TABLE_ABBREVIATIONS[entityName]}-${variant}-c${cycle}`;
}

/** Deterministic actor-scoped id (disjoint across actors by construction). */
export function actorEntityId(entityName, cycle, actor, opIndex) {
  return `${TABLE_ABBREVIATIONS[entityName]}-a${actor}-c${cycle}-o${opIndex}`;
}

/** Generates one deterministic synthetic value for a scalar field. */
export function generateValue(rng, spec) {
  if (spec.nullable && rng.chance(0.2)) return null;
  switch (spec.type) {
    case "string":
      return `${WORDS[rng.int(WORDS.length)]}-${rng.int(10_000)}`;
    case "number":
      return rng.int(2_000);
    case "boolean":
      return rng.chance(0.5);
    case "date":
      return new Date(DATE_BASE_MS + rng.int(31_536_000) * 1_000);
    default:
      throw new Error(`unsupported field type: ${spec.type}`);
  }
}

/** Builds a full row (all non-nullable fields) for one entity. */
export function generateRow(rng, fieldPlan) {
  const row = {};
  for (const [field, spec] of Object.entries(fieldPlan)) {
    if (spec.primary) continue;
    row[field] = generateValue(rng, spec);
  }
  return row;
}

/** Builds a partial update patch over 1-2 mutable fields. */
export function generatePatch(rng, fieldPlan) {
  const entries = Object.entries(fieldPlan).filter(([field, spec]) => !spec.primary);
  const patch = {};
  const count = Math.min(entries.length, 1 + (rng.chance(0.5) ? 1 : 0));
  for (let index = 0; index < count; index += 1) {
    const [field, spec] = entries[rng.int(entries.length)];
    patch[field] = generateValue(rng, spec);
  }
  return patch;
}

/**
 * Actor operation kinds. `expected_*` kinds assert the stable validation
 * error instead of a mutation.
 */
export const OPERATION_KINDS = Object.freeze([
  "create",
  "update",
  "delete",
  "batchPersist",
  "noOpFlush",
  "findFiltered",
  "findPaged",
  "findOne",
  "count",
  "findAndCount",
  "limitZero",
  "offsetOnly",
  "offsetOutOfRange",
  "transactionalCommit",
  "transactionalRollback",
  "expectedInvalidField",
  "expectedLikeOnNumber",
  "expectedUnmanagedPersist",
  "expectedNegativeOffset",
  "forkIsolation",
]);

/**
 * Plans one actor operation. The table rotation guarantees every table is
 * touched by the actor stream across a cycle regardless of the mix.
 */
export function planActorOperation({ seed, cycle, actor, opIndex, entityName, fieldPlan, oracle }) {
  const rng = new SeededRandom(deriveSeed(seed, (cycle + 1) * 100_000 + actor * 1_003 + opIndex * 101));
  const kinds = OPERATION_KINDS.filter((kind) => kind !== "delete" || oracle.size(entityName) > 4);
  const kind = kinds[rng.int(kinds.length)];
  const op = { kind, entityName, actor, opIndex, cycle };

  // Deterministic anchor ids for mutations (actor-scoped, disjoint).
  op.mutateId = actorEntityId(entityName, cycle, actor, opIndex);
  op.updateTarget = op.mutateId;
  op.deleteTarget = op.mutateId;
  op.lookupId = pickLookupId(rng, oracle, entityName);

  // Pre-generate the payload and query shapes so replay from the log of
  // (seed, cycle, actor, opIndex) reproduces the exact operation.
  if (kind === "create" || kind === "batchPersist" || kind === "transactionalCommit" ||
      kind === "transactionalRollback" || kind === "forkIsolation") {
    op.row = generateRow(rng, fieldPlan);
  }
  if (kind === "batchPersist") {
    op.extraRows = [generateRow(rng, fieldPlan), generateRow(rng, fieldPlan)];
  }
  if (kind === "update" || kind === "transactionalCommit") {
    op.patch = generatePatchFor(rng, fieldPlan, entityName);
  }
  if (kind === "forkIsolation") {
    op.patch = generatePatchFor(rng, fieldPlan, entityName);
  }
  if (kind === "findFiltered" || kind === "count" || kind === "findAndCount") {
    op.filter = generateFilter(rng, entityName, fieldPlan, oracle);
  }
  if (kind === "findPaged") {
    op.filter = generateFilter(rng, entityName, fieldPlan, oracle);
    op.orderBy = generateOrderBy(rng, fieldPlan);
    op.limit = 1 + rng.int(Math.max(1, Math.min(20, oracle.size(entityName))));
    op.offset = rng.int(5);
  }
  if (kind === "offsetOnly" || kind === "offsetOutOfRange" || kind === "limitZero") {
    op.orderBy = generateOrderBy(rng, fieldPlan);
  }
  return op;
}

/** Picks a deterministic existing id for lookups when the table has rows. */
function pickLookupId(rng, oracle, entityName) {
  const ids = oracle.ids(entityName);
  return ids.length === 0 ? sharedEntityId(entityName, 0, "main") : ids[rng.int(ids.length)];
}

/** Generates a filter exercising the supported operator families. */
export function generateFilter(rng, entityName, fieldPlan, oracle) {
  const entries = Object.entries(fieldPlan).filter(([field, spec]) =>
    !spec.primary && !(spec.type === "date" && rng.chance(0.3)));
  if (entries.length === 0) return {};
  const [field, spec] = entries[rng.int(entries.length)];
  // Anchor the operand to a live value so filters are selective but
  // non-empty; fall back to a synthetic value on empty tables.
  const anchorRow = oracle.row(entityName, pickLookupId(rng, oracle, entityName));
  const anchor = anchorRow?.[field] ?? generateValue(rng, spec);
  const filter = {};
  if (spec.type === "string") {
    const shape = rng.int(4);
    if (shape === 0) filter[field] = { eq: anchor };
    else if (shape === 1) filter[field] = { ne: anchor };
    else if (shape === 2) {
      filter[field] = { like: `%${String(anchor).split("-")[0]}%` };
    } else {
      filter[field] = { in: [anchor, generateValue(rng, spec)] };
    }
  } else if (spec.type === "number") {
    const shape = rng.int(4);
    if (shape === 0) filter[field] = { gt: Number(anchor) - 10 };
    else if (shape === 1) filter[field] = { lte: Number(anchor) + 10 };
    else if (shape === 2) filter[field] = { gte: Number(anchor) - 5, lt: Number(anchor) + 500 };
    else filter[field] = { nin: [Number(anchor)] };
  } else if (spec.type === "boolean") {
    filter[field] = { eq: anchor === true };
  } else if (spec.type === "date" && anchor instanceof Date) {
    filter[field] = { gte: new Date(anchor.getTime() - 3_600_000) };
  }
  // Occasionally add a second field to exercise multi-field conjunctions.
  if (entries.length > 1 && rng.chance(0.4)) {
    const [secondField, secondSpec] = entries[rng.int(entries.length)];
    if (secondField !== field && secondSpec.type !== "date") {
      const secondAnchor = anchorRow?.[secondField] ?? generateValue(rng, secondSpec);
      filter[secondField] = secondSpec.type === "string"
        ? { eq: secondAnchor }
        : secondSpec.type === "number"
          ? { gte: Number(secondAnchor) - 100 }
          : { eq: secondAnchor === true };
    }
  }
  return filter;
}

/** Generates an orderBy that always includes the primary key (deterministic). */
export function generateOrderBy(rng, fieldPlan) {
  const primaryKey = Object.entries(fieldPlan).find(([, spec]) => spec.primary)?.[0] ?? "id";
  const candidates = Object.entries(fieldPlan)
    .filter(([field, spec]) => !spec.primary && spec.type !== "boolean")
    .map(([field]) => field);
  if (candidates.length === 0 || rng.chance(0.4)) {
    return { [primaryKey]: rng.chance(0.5) ? "asc" : "desc" };
  }
  const field = candidates[rng.int(candidates.length)];
  return { [field]: rng.chance(0.5) ? "asc" : "desc", [primaryKey]: "asc" };
}

/** Patch generator bound to one entity's field plan. */
function generatePatchFor(rng, fieldPlan, entityName) {
  void entityName;
  return generatePatch(rng, fieldPlan);
}
