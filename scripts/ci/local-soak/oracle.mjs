/**
 * Deterministic in-memory oracle for soak query verification.
 *
 * Mirrors the public EntityManager query semantics exactly:
 * - operators eq/ne/gt/gte/lt/lte/in/nin plus string-only like,
 * - null semantics of the normalizer: eq:null maps to is_null; ne:null and
 *   nin containing null map to is_not_null (null rows excluded); only ne
 *   and nin with NON-null operands keep the nullable-field widening that
 *   passes null rows,
 * - like mapped to SQLite LIKE (ASCII case-insensitive, `%` and `_`),
 * - orderBy with the primary-key ascending tiebreaker the normalizer
 *   appends whenever the caller does not include it,
 * - limit/offset paging with `limit 0` returning an empty page and
 *   out-of-range offsets returning an empty page (never an error).
 *
 * Dates are canonical ISO-8601 strings in SQLite and Date objects in the
 * public API; the oracle compares them by epoch millis, which is order-
 * equivalent to ISO text comparison.
 */

const OPERATOR_NAMES = new Set([
  "eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "like",
]);

/**
 * @typedef {{ kind: "create" }} — see applyMutation for the mutation shapes.
 * Mutations: { op: "insert", entity, row }
 *            { op: "update", entity, id, patch }
 *            { op: "delete", entity, id }
 *            { op: "replace", entity, id, row }  (upsert: sets the row to
 *              exactly these values, inserting when the id is new — used by
 *              forkIsolation creates and human-edit probes)
 */

/** One soak table's live rows keyed by primary key. */
class OracleTable {
  /** @param {string} entityName @param {string} primaryKey */
  constructor(entityName, primaryKey) {
    this.entityName = entityName;
    this.primaryKey = primaryKey;
    /** @type {Map<string, Record<string, unknown>>} */
    this.rows = new Map();
  }
}

/** Builds one oracle bound to a set of entity field plans. */
export class SoakOracle {
  /**
   * @param {Record<string, Record<string, { type: string, primary?: boolean, nullable?: boolean }>>} fieldPlans
   */
  constructor(fieldPlans) {
    /** @type {Map<string, OracleTable>} */
    this.tables = new Map();
    this.fieldPlans = fieldPlans;
    for (const entityName of Object.keys(fieldPlans)) {
      const primaryKey = Object.entries(fieldPlans[entityName])
        .find(([, spec]) => spec.primary)?.[0];
      if (primaryKey === undefined) {
        throw new Error(`entity ${entityName} has no primary field in its plan`);
      }
      this.tables.set(entityName, new OracleTable(entityName, primaryKey));
    }
  }

  /** Applies one mutation; returns true when the visible state changed. */
  applyMutation(mutation) {
    const table = this.requireTable(mutation.entity);
    switch (mutation.op) {
      case "insert":
        if (table.rows.has(mutation.row[table.primaryKey])) {
          throw new Error(`oracle duplicate insert on ${mutation.entity}`);
        }
        table.rows.set(String(mutation.row[table.primaryKey]), { ...mutation.row });
        return true;
      case "update": {
        const row = table.rows.get(String(mutation.id));
        if (row === undefined) return false;
        Object.assign(row, mutation.patch);
        return true;
      }
      case "delete":
        return table.rows.delete(String(mutation.id));
      case "replace": {
        // Upsert: forkIsolation creates a brand-new row and then replaces
        // it, so a missing id must be inserted, not silently skipped (a
        // skipped insert would desync the oracle from SQLite by exactly the
        // rows the workload creates this way).
        table.rows.set(String(mutation.id), { ...mutation.row });
        return true;
      }
      default:
        throw new Error(`unknown oracle mutation: ${mutation?.op}`);
    }
  }

  /** Live row ids for one entity (unordered). */
  ids(entityName) {
    return [...this.requireTable(entityName).rows.keys()];
  }

  /** Live row count for one entity. */
  size(entityName) {
    return this.requireTable(entityName).rows.size;
  }

  /** Live row snapshot (defensive copy) for one id. */
  row(entityName, id) {
    const row = this.requireTable(entityName).rows.get(String(id));
    return row === undefined ? undefined : { ...row };
  }

  /**
   * Evaluates one query against the in-memory state.
   *
   * @param {string} entityName
   * @param {{ where?: Record<string, unknown>, orderBy?: Record<string, "asc"|"desc">, limit?: number, offset?: number }} query
   * @returns {{ ids: string[], total: number }} ordered ids and the
   *   pre-paging total.
   */
  query(entityName, query) {
    const table = this.requireTable(entityName);
    const plan = this.fieldPlans[entityName];
    const where = query.where ?? {};
    const rows = [...table.rows.values()].filter((row) =>
      matchesFilter(row, plan, where)
    );
    const orderBy = resolvedOrderBy(plan, query.orderBy, {
      paged: query.limit !== undefined || query.offset !== undefined,
    });
    const primaryKey = table.primaryKey;
    const sorted = [...rows].sort((left, right) => compareRows(left, right, orderBy, primaryKey, plan));
    const total = sorted.length;
    const offset = query.offset ?? 0;
    const limit = query.limit;
    const paged = limit === undefined
      ? sorted.slice(offset)
      : sorted.slice(offset, offset + limit);
    return { ids: paged.map((row) => String(row[primaryKey])), total };
  }
}

/** Requires the oracle table for one entity name. */
SoakOracle.prototype.requireTable = function requireTable(entityName) {
  const table = this.tables.get(entityName);
  if (table === undefined) throw new Error(`unknown oracle entity: ${entityName}`);
  return table;
};

/** True when a row satisfies every field condition of the filter. */
function matchesFilter(row, plan, where) {
  for (const [field, condition] of Object.entries(where)) {
    const spec = plan[field];
    if (spec === undefined) {
      throw new Error(`unknown filter field ${field}`);
    }
    if (isOperatorCondition(condition)) {
      if (!matchesOperatorCondition(row[field], spec, condition)) return false;
    } else if (condition === null) {
      if (row[field] !== null) return false;
    } else if (!compareEqual(row[field], condition)) {
      return false;
    }
  }
  return true;
}

/** Detects an operator-object condition (any known operator key, non-empty). */
function isOperatorCondition(condition) {
  if (condition === null || typeof condition !== "object" || condition instanceof Date) {
    return false;
  }
  const keys = Object.keys(condition);
  return keys.length > 0 && keys.every((key) => OPERATOR_NAMES.has(key));
}

/** Evaluates one operator-object condition against a stored value. */
function matchesOperatorCondition(stored, spec, condition) {
  for (const [operator, operand] of Object.entries(condition)) {
    switch (operator) {
      case "eq":
        if (operand === null) {
          if (stored !== null) return false;
        } else if (stored === null || !compareEqual(stored, operand)) return false;
        break;
      case "ne":
        if (operand === null) {
          // Normalizer: ne:null maps to is_not_null, so null rows are
          // excluded even on nullable fields.
          if (stored === null) return false;
          break;
        }
        // Normalizer: ne on a nullable field passes null rows; on a
        // non-nullable field a stored null never occurs.
        if (stored !== null && compareEqual(stored, operand)) return false;
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte":
        if (stored === null || !compareOrdered(stored, operand, operator)) return false;
        break;
      case "in": {
        const values = operand ?? [];
        const matches = stored !== null &&
          values.some((value) => value !== null && compareEqual(stored, value));
        if (!matches && !(stored === null && values.includes(null))) return false;
        break;
      }
      case "nin": {
        const values = operand ?? [];
        if (values.includes(null)) {
          // Normalizer: a null member maps to is_not_null, so null rows are
          // excluded even on nullable fields (they cannot be "not in" a set
          // that contains null).
          if (stored === null) return false;
        } else if (stored === null) {
          // Normalizer: nin without null passes null rows only when the
          // field is nullable (non-nullable fields cannot hold null anyway).
          if (!spec.nullable) return false;
          continue;
        }
        if (values.some((value) => value !== null && compareEqual(stored, value))) {
          return false;
        }
        break;
      }
      case "like":
        if (typeof stored !== "string") return false;
        if (!sqlLikeMatch(stored, String(operand))) return false;
        break;
      default:
        throw new Error(`unknown operator: ${operator}`);
    }
  }
  return true;
}

/** Equality across the public value model (Date compared by epoch). */
function compareEqual(stored, operand) {
  if (stored instanceof Date || operand instanceof Date) {
    return toComparable(stored) === toComparable(operand);
  }
  return stored === operand;
}

/** Applies one ordered comparison operator. */
function compareOrdered(stored, operand, operator) {
  const left = toComparable(stored);
  const right = toComparable(operand);
  if (left === null || right === null) return false;
  switch (operator) {
    case "gt": return left > right;
    case "gte": return left >= right;
    case "lt": return left < right;
    case "lte": return left <= right;
    default: throw new Error(`unknown ordered operator: ${operator}`);
  }
}

/** Reduces one value to a primitive comparable (epoch millis for dates). */
function toComparable(value) {
  if (value instanceof Date) return value.getTime();
  if (value === null || value === undefined) return null;
  return value;
}

/**
 * SQLite LIKE semantics for the ASCII soak data: `_` matches exactly one
 * character, `%` matches any run, and matching is ASCII case-insensitive.
 */
export function sqlLikeMatch(value, pattern) {
  let source = 0;
  let target = 0;
  let starAfter = -1;
  let starSource = -1;
  const v = value.toLowerCase();
  const p = pattern.toLowerCase();
  while (target < v.length) {
    if (source < p.length && (p[source] === "_" || p[source] === v[target])) {
      target += 1;
      source += 1;
    } else if (source < p.length && p[source] === "%") {
      starAfter = source;
      starSource = target;
      source += 1;
    } else if (starAfter !== -1) {
      source = starAfter + 1;
      starSource += 1;
      target = starSource;
    } else {
      return false;
    }
  }
  while (source < p.length && p[source] === "%") source += 1;
  return source === p.length;
}

/** Builds the effective orderBy list, mirroring the normalizer defaults. */
function resolvedOrderBy(plan, orderBy, options) {
  const primaryKey = Object.entries(plan).find(([, spec]) => spec.primary)?.[0];
  if (orderBy === undefined) {
    return options.paged ? [{ field: primaryKey, direction: "asc" }] : [];
  }
  const entries = Object.entries(orderBy);
  if (entries.length === 0) throw new Error("orderBy must not be empty");
  const resolved = entries.map(([field, direction]) => ({ field, direction }));
  if (!resolved.some((entry) => entry.field === primaryKey)) {
    resolved.push({ field: primaryKey, direction: "asc" });
  }
  return resolved;
}

/** Compares two rows by one resolved orderBy list (stable pk tiebreaker). */
function compareRows(left, right, orderBy, primaryKey, plan) {
  for (const entry of orderBy) {
    const result = compareByField(left, right, entry.field, plan);
    if (result !== 0) return entry.direction === "desc" ? -result : result;
  }
  return String(left[primaryKey]) < String(right[primaryKey]) ? -1
    : String(left[primaryKey]) > String(right[primaryKey]) ? 1
      : 0;
}

/** Field comparator with SQL-ish ordering (nulls first ascending). */
function compareByField(left, right, field, plan) {
  const spec = plan[field];
  if (spec === undefined) throw new Error(`unknown orderBy field ${field}`);
  const leftValue = toComparable(left[field]);
  const rightValue = toComparable(right[field]);
  if (leftValue === null && rightValue === null) return 0;
  if (leftValue === null) return -1;
  if (rightValue === null) return 1;
  if (typeof leftValue === "string" && typeof rightValue === "string") {
    return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
  }
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
