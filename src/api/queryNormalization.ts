import type { ResolvedHikouteiEntityDescriptor } from "./entity.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "./errors.js";
import {
  HIKOUTEI_QUERY_OPERATORS,
  HIKOUTEI_SORT_DIRECTIONS,
  type HikouteiSortDirection,
} from "./query.js";
import type {
  ScalarEntityPredicate,
  ScalarEntityQuery,
  ScalarEntityValue,
  ScalarEntityOrder,
} from "../adapter/persistence/contracts/scalar.js";

/** Normalizes a public collection query after validating descriptor-owned fields and values. */
export function normalizeEntityQuery(
  descriptor: ResolvedHikouteiEntityDescriptor,
  where: unknown,
  options: unknown,
): ScalarEntityQuery {
  const normalizedOptions = normalizeFindOptions(options, true);
  return {
    tableName: descriptor.tableName,
    primaryKeyColumn: descriptor.primaryKey,
    predicate: normalizeFilter(descriptor, where),
    orderBy: normalizeOrderBy(descriptor, normalizedOptions.orderBy, {
      paged: normalizedOptions.limit !== undefined || normalizedOptions.offset !== undefined,
    }),
    ...(normalizedOptions.limit === undefined ? {} : { limit: normalizedOptions.limit }),
    ...(normalizedOptions.offset === undefined ? {} : { offset: normalizedOptions.offset }),
  };
}

/** Normalizes a public single-row query and applies an internal limit of one. */
export function normalizeEntityFindOneQuery(
  descriptor: ResolvedHikouteiEntityDescriptor,
  where: unknown,
  options: unknown,
): ScalarEntityQuery {
  const normalizedOptions = normalizeFindOptions(options, false);
  return {
    tableName: descriptor.tableName,
    primaryKeyColumn: descriptor.primaryKey,
    predicate: normalizeFilter(descriptor, where),
    orderBy: normalizeOrderBy(descriptor, normalizedOptions.orderBy, { paged: false }),
    limit: 1,
  };
}

interface NormalizedFindOptions {
  readonly orderBy: unknown;
  readonly limit: number | undefined;
  readonly offset: number | undefined;
}

function normalizeFindOptions(input: unknown, allowPaging: boolean): NormalizedFindOptions {
  if (input === undefined) {
    return { orderBy: undefined, limit: undefined, offset: undefined };
  }
  if (!isPlainRecord(input)) {
    throwInvalidQuery("query options must be an object.");
  }
  const allowed = allowPaging
    ? new Set(["orderBy", "limit", "offset"])
    : new Set(["orderBy"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throwInvalidQuery(`query option "${key}" is not supported here.`);
    }
  }
  const limit = input.limit;
  const offset = input.offset;
  requirePageValue(limit, "limit");
  requirePageValue(offset, "offset");
  return {
    orderBy: input.orderBy,
    limit: limit as number | undefined,
    offset: offset as number | undefined,
  };
}

function normalizeFilter(
  descriptor: ResolvedHikouteiEntityDescriptor,
  input: unknown,
): ScalarEntityPredicate {
  if (!isPlainRecord(input)) {
    throwInvalidQuery("query filter must be an object.");
  }
  const predicates: ScalarEntityPredicate[] = [];
  for (const [field, rawCondition] of Object.entries(input)) {
    const property = requireProperty(descriptor, field);
    if (isOperatorObject(rawCondition)) {
      predicates.push(...normalizeOperatorObject(descriptor, property, rawCondition));
    } else {
      const value = requirePropertyValue(descriptor, property, rawCondition, { allowNull: true });
      predicates.push(value === null
        ? { kind: "null", field, operator: "is_null" }
        : { kind: "comparison", field, operator: "eq", value });
    }
  }
  return combineAll(predicates);
}

function normalizeOperatorObject(
  descriptor: ResolvedHikouteiEntityDescriptor,
  property: ResolvedHikouteiEntityDescriptor["properties"][number],
  input: Readonly<Record<string, unknown>>,
): readonly ScalarEntityPredicate[] {
  const entries = Object.entries(input);
  if (entries.length === 0) {
    throwInvalidQuery(`filter operator object for "${property.name}" must not be empty.`);
  }
  const predicates: ScalarEntityPredicate[] = [];
  for (const [operator, operand] of entries) {
    if (!isQueryOperator(operator)) {
      throwInvalidQuery(`filter "${property.name}" has unknown operator "${operator}".`);
    }
    if (!isOperatorAllowed(property.type, operator)) {
      throwInvalidQuery(
        `operator "${operator}" is not valid for ${property.type} field "${property.name}".`,
      );
    }
    if (operator === "in" || operator === "nin") {
      predicates.push(normalizeSetPredicate(descriptor, property, operator, operand));
      continue;
    }
    if (operator === "like") {
      const value = requirePropertyValue(descriptor, property, operand, { allowNull: false });
      if (typeof value !== "string") {
        throwInvalidQuery(`operator "like" requires a string pattern for "${property.name}".`);
      }
      predicates.push({ kind: "like", field: property.name, pattern: value });
      continue;
    }
    const allowNull = operator === "eq" || operator === "ne";
    const value = requirePropertyValue(descriptor, property, operand, { allowNull });
    if (value === null) {
      predicates.push({
        kind: "null",
        field: property.name,
        operator: operator === "eq" ? "is_null" : "is_not_null",
      });
    } else if (operator === "ne" && property.nullable) {
      predicates.push({
        kind: "any",
        predicates: [
          { kind: "null", field: property.name, operator: "is_null" },
          { kind: "comparison", field: property.name, operator, value },
        ],
      });
    } else {
      predicates.push({ kind: "comparison", field: property.name, operator, value });
    }
  }
  return predicates;
}

function normalizeSetPredicate(
  descriptor: ResolvedHikouteiEntityDescriptor,
  property: ResolvedHikouteiEntityDescriptor["properties"][number],
  operator: "in" | "nin",
  operand: unknown,
): ScalarEntityPredicate {
  if (!Array.isArray(operand)) {
    throwInvalidQuery(`operator "${operator}" requires an array for "${property.name}".`);
  }
  if (operand.length === 0) return { kind: "constant", value: operator === "nin" };

  const values: Array<Exclude<ScalarEntityValue, null>> = [];
  let containsNull = false;
  for (const rawValue of [...operand]) {
    const value = requirePropertyValue(descriptor, property, rawValue, { allowNull: true });
    if (value === null) containsNull = true;
    else values.push(value);
  }
  const setPredicate: ScalarEntityPredicate | undefined = values.length === 0
    ? undefined
    : { kind: "set", field: property.name, operator, values: [...values] };
  if (!containsNull) {
    if (operator === "nin" && property.nullable && setPredicate !== undefined) {
      return {
        kind: "any",
        predicates: [
          { kind: "null", field: property.name, operator: "is_null" },
          setPredicate,
        ],
      };
    }
    return setPredicate ?? { kind: "constant", value: operator === "nin" };
  }

  const nullPredicate: ScalarEntityPredicate = {
    kind: "null",
    field: property.name,
    operator: operator === "in" ? "is_null" : "is_not_null",
  };
  if (setPredicate === undefined) return nullPredicate;
  return operator === "in"
    ? { kind: "any", predicates: [nullPredicate, setPredicate] }
    : { kind: "all", predicates: [nullPredicate, setPredicate] };
}

function normalizeOrderBy(
  descriptor: ResolvedHikouteiEntityDescriptor,
  input: unknown,
  options: { readonly paged: boolean },
): readonly ScalarEntityOrder[] {
  if (input === undefined) {
    return options.paged
      ? [{ field: descriptor.primaryKey, direction: HIKOUTEI_SORT_DIRECTIONS.ASC }]
      : [];
  }
  if (!isPlainRecord(input)) throwInvalidQuery("orderBy must be an object.");
  const entries = Object.entries(input);
  if (entries.length === 0) throwInvalidQuery("orderBy must not be empty.");

  const orderBy: ScalarEntityOrder[] = [];
  for (const [field, direction] of entries) {
    requireProperty(descriptor, field);
    if (!isSortDirection(direction)) {
      throwInvalidQuery(`orderBy direction for "${field}" must be "asc" or "desc".`);
    }
    orderBy.push({ field, direction });
  }
  if (!orderBy.some((order) => order.field === descriptor.primaryKey)) {
    orderBy.push({ field: descriptor.primaryKey, direction: HIKOUTEI_SORT_DIRECTIONS.ASC });
  }
  return orderBy;
}

function combineAll(predicates: readonly ScalarEntityPredicate[]): ScalarEntityPredicate {
  if (predicates.length === 0) return { kind: "constant", value: true };
  if (predicates.length === 1) return predicates[0] as ScalarEntityPredicate;
  return { kind: "all", predicates: [...predicates] };
}

function requireProperty(
  descriptor: ResolvedHikouteiEntityDescriptor,
  field: string,
): ResolvedHikouteiEntityDescriptor["properties"][number] {
  const property = descriptor.properties.find((candidate) => candidate.name === field);
  if (property === undefined) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      `"${field}" is not a declared property of entity "${descriptor.name}".`,
    );
  }
  return property;
}

function requirePropertyValue(
  descriptor: ResolvedHikouteiEntityDescriptor,
  property: ResolvedHikouteiEntityDescriptor["properties"][number],
  value: unknown,
  options: { readonly allowNull: boolean },
): ScalarEntityValue {
  if (value === undefined) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      `filter "${property.name}" must not be undefined in entity "${descriptor.name}".`,
    );
  }
  if (value === null) {
    if (options.allowNull && property.nullable) return null;
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      `filter "${property.name}" cannot be null in this query for entity "${descriptor.name}".`,
    );
  }
  switch (property.type) {
    case "date":
      if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getTime());
      break;
    case "string":
      if (typeof value === "string") return value;
      break;
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return value;
      break;
    case "boolean":
      if (typeof value === "boolean") return value;
      break;
  }
  throw new HikouteiError(
    HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
    `filter "${property.name}" expected ${property.type} in entity "${descriptor.name}".`,
  );
}

function isOperatorAllowed(
  type: ResolvedHikouteiEntityDescriptor["properties"][number]["type"],
  operator: QueryOperator,
): boolean {
  if (operator === "eq" || operator === "ne" || operator === "in" || operator === "nin") {
    return true;
  }
  if (operator === "like") return type === "string";
  return type === "string" || type === "number" || type === "date";
}

type QueryOperator =
  (typeof HIKOUTEI_QUERY_OPERATORS)[keyof typeof HIKOUTEI_QUERY_OPERATORS];

function isQueryOperator(value: string): value is QueryOperator {
  return Object.values(HIKOUTEI_QUERY_OPERATORS).some((operator) => operator === value);
}

function isSortDirection(value: unknown): value is HikouteiSortDirection {
  return value === HIKOUTEI_SORT_DIRECTIONS.ASC || value === HIKOUTEI_SORT_DIRECTIONS.DESC;
}

function isOperatorObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return isPlainRecord(value) && !(value instanceof Date);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requirePageValue(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      `${label} must be a non-negative safe integer.`,
    );
  }
}

function throwInvalidQuery(message: string): never {
  throw new HikouteiError(HIKOUTEI_ERROR_CODES.INVALID_QUERY, message);
}
