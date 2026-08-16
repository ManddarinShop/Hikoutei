/**
 * Value coercion and runtime guards between MCP tool input (JSON) and the
 * Hikoutei entity boundary.
 *
 * MCP arguments arrive as untyped JSON, so every field is validated against
 * the entity's declared properties before it reaches the EntityManager:
 * unknown fields, wrong scalar types, and bad operator names are rejected
 * with corrective messages instead of leaking storage errors. Dates cross
 * the boundary as ISO 8601 strings and become `Date` instances internally.
 */

import type { HikouteiMcpConfig, HikouteiMcpScalarType } from "./config.js";

/** One validated property view used by tool guards. */
export interface ToolPropertyInfo {
  readonly name: string;
  readonly type: HikouteiMcpScalarType;
  readonly primary: boolean;
  readonly nullable: boolean;
}

/** One validated entity view used by tool guards. */
export interface ToolEntityInfo {
  readonly name: string;
  readonly tableName: string;
  readonly primaryKey: string;
  readonly primaryType: HikouteiMcpScalarType;
  readonly properties: ReadonlyMap<string, ToolPropertyInfo>;
}

/** Result of validating one record payload. */
export type RecordDataValidation =
  | { readonly status: "valid"; readonly value: Readonly<Record<string, unknown>> }
  | { readonly status: "invalid"; readonly reason: string };

/** Query operators accepted in tool `where` filters. */
export const TOOL_QUERY_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "nin",
  "like",
] as const;

/** Operator names accepted in tool `where` filters. */
export type ToolQueryOperator = (typeof TOOL_QUERY_OPERATORS)[number];

/** Operators requiring string-typed properties. */
const STRING_ONLY_OPERATORS: ReadonlySet<string> = new Set(["like"]);

/** Operators requiring orderable properties (string, number, date). */
const ORDERABLE_TYPES: ReadonlySet<string> = new Set(["string", "number", "date"]);

/** Set operators expecting arrays of scalars. */
const SET_OPERATORS: ReadonlySet<string> = new Set(["in", "nin"]);

/**
 * Builds the per-entity guard metadata from a validated config.
 *
 * Exactly one primary property is guaranteed by config validation; the
 * lookup is total for names that came from the same config object.
 */
export function buildToolEntityInfos(config: HikouteiMcpConfig): ReadonlyMap<string, ToolEntityInfo> {
  const infos = new Map<string, ToolEntityInfo>();
  for (const entity of config.entities) {
    const properties = new Map<string, ToolPropertyInfo>();
    let primaryKey = "";
    let primaryType: HikouteiMcpScalarType = "string";
    for (const [name, property] of Object.entries(entity.properties)) {
      properties.set(name, {
        name,
        type: property.type,
        primary: property.primary === true,
        nullable: property.nullable === true,
      });
      if (property.primary) {
        primaryKey = name;
        primaryType = property.type;
      }
    }
    infos.set(entity.name, {
      name: entity.name,
      tableName: entity.tableName,
      primaryKey,
      primaryType,
      properties,
    });
  }
  return infos;
}

/** Validates and coerces a `data` payload for create or update. */
export function validateRecordData(
  entity: ToolEntityInfo,
  data: unknown,
  mode: "create" | "update",
): RecordDataValidation {
  if (!isRecord(data)) {
    return { status: "invalid", reason: "data must be a JSON object." };
  }
  const value: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [key, raw] of Object.entries(data)) {
    const property = entity.properties.get(key);
    if (property === undefined) {
      problems.push(
        `unknown field "${key}"; entity "${entity.name}" declares: ${describeProperties(entity)}.`,
      );
      continue;
    }
    if (mode === "update" && property.primary) {
      problems.push(
        `field "${key}" is the primary key of "${entity.name}" and cannot be updated.`,
      );
      continue;
    }
    const coerced = coerceScalar(property.type, property.nullable, raw, key);
    if (coerced === undefined) {
      if (isUndefined(raw)) {
        if (mode === "create" && !property.nullable) {
          problems.push(`field "${key}" is required (declare null explicitly for nullable fields).`);
        }
        continue;
      }
      problems.push(coercionProblem(property.type, key, raw));
      continue;
    }
    value[key] = coerced;
  }
  if (mode === "create") {
    for (const property of entity.properties.values()) {
      if (!property.nullable && !(property.name in data)) {
        problems.push(
          `field "${property.name}" (${property.type}) is required for create.`,
        );
      }
    }
    const primary = data[entity.primaryKey];
    if (isUndefined(primary) && !entity.properties.get(entity.primaryKey)?.nullable) {
      problems.push(`primary key "${entity.primaryKey}" is required for create.`);
    }
  }
  if (problems.length > 0) {
    return { status: "invalid", reason: problems.join(" ") };
  }
  return { status: "valid", value };
}

/**
 * Validates a primary-key argument (`id`) against the entity's primary type.
 */
export function validatePrimaryId(
  entity: ToolEntityInfo,
  raw: unknown,
): { readonly status: "valid"; readonly value: string | number } | { readonly status: "invalid"; readonly reason: string } {
  if (entity.primaryType === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) return { status: "valid", value: raw };
    if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
      return { status: "valid", value: Number(raw) };
    }
    return {
      status: "invalid",
      reason: `id must be a number (primary key "${entity.primaryKey}" of "${entity.name}" is a number).`,
    };
  }
  if (typeof raw === "string" && raw !== "") return { status: "valid", value: raw };
  return {
    status: "invalid",
    reason: `id must be a non-empty string (primary key "${entity.primaryKey}" of "${entity.name}").`,
  };
}

/**
 * Validates a `where` filter and converts it into the library's operator
 * syntax (`{ field: { op: value } }`), coercing date strings to `Date`.
 */
export function validateWhereFilter(
  entity: ToolEntityInfo,
  where: unknown,
): { readonly status: "valid"; readonly value: Readonly<Record<string, unknown>> } | { readonly status: "invalid"; readonly reason: string } {
  if (!isRecord(where)) {
    return { status: "invalid", reason: "where must be a JSON object." };
  }
  const value: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(where)) {
    const property = entity.properties.get(key);
    if (property === undefined) {
      return {
        status: "invalid",
        reason: `unknown field "${key}"; entity "${entity.name}" declares: ${describeProperties(entity)}.`,
      };
    }
    if (isRecord(raw)) {
      const operatorEntry = buildOperatorFilter(property, key, raw);
      if (operatorEntry.status === "invalid") return operatorEntry;
      value[key] = operatorEntry.value;
      continue;
    }
    const coerced = coerceScalar(property.type, property.nullable, raw, key);
    if (coerced === undefined) {
      return { status: "invalid", reason: coercionProblem(property.type, key, raw) };
    }
    value[key] = coerced;
  }
  return { status: "valid", value };
}

/** Validates one `{ op: operand }` object for a property. */
function buildOperatorFilter(
  property: ToolPropertyInfo,
  key: string,
  raw: Record<string, unknown>,
):
  | { readonly status: "valid"; readonly value: Readonly<Record<string, unknown>> }
  | { readonly status: "invalid"; readonly reason: string } {
  const operators = Object.keys(raw);
  if (operators.length === 0) {
    return { status: "invalid", reason: `where.${key} must not be an empty object.` };
  }
  const filter: Record<string, unknown> = {};
  for (const operator of operators) {
    if (!(TOOL_QUERY_OPERATORS as readonly string[]).includes(operator)) {
      return {
        status: "invalid",
        reason: `where.${key} uses unknown operator "${operator}"; supported: ${TOOL_QUERY_OPERATORS.join(", ")}.`,
      };
    }
    if (STRING_ONLY_OPERATORS.has(operator) && property.type !== "string") {
      return {
        status: "invalid",
        reason: `where.${key}.${operator} requires a string field; "${property.name}" is ${property.type}.`,
      };
    }
    if (!SET_OPERATORS.has(operator) && !ORDERABLE_TYPES.has(property.type) && operator !== "eq" && operator !== "ne") {
      return {
        status: "invalid",
        reason: `where.${key}.${operator} requires a string, number, or date field; "${property.name}" is ${property.type}.`,
      };
    }
    const operand = raw[operator];
    if (SET_OPERATORS.has(operator)) {
      if (!Array.isArray(operand) || operand.length === 0) {
        return {
          status: "invalid",
          reason: `where.${key}.${operator} must be a non-empty array.`,
        };
      }
      const items: unknown[] = [];
      for (const item of operand) {
        const coerced = coerceScalar(property.type, property.nullable, item, key);
        if (coerced === undefined) {
          return { status: "invalid", reason: coercionProblem(property.type, key, item) };
        }
        items.push(coerced);
      }
      filter[operator] = items;
      continue;
    }
    const coerced = coerceScalar(property.type, property.nullable, operand, key);
    if (coerced === undefined) {
      return { status: "invalid", reason: coercionProblem(property.type, key, operand) };
    }
    filter[operator] = coerced;
  }
  return { status: "valid", value: filter };
}

/**
 * Validates an `orderBy` argument into the library's sort map.
 */
export function validateOrderBy(
  entity: ToolEntityInfo,
  orderBy: unknown,
): { readonly status: "valid"; readonly value: Readonly<Record<string, "asc" | "desc">> } | { readonly status: "invalid"; readonly reason: string } {
  if (!isRecord(orderBy)) {
    return { status: "invalid", reason: "orderBy must be a JSON object." };
  }
  const value: Record<string, "asc" | "desc"> = {};
  for (const [key, direction] of Object.entries(orderBy)) {
    const property = entity.properties.get(key);
    if (property === undefined) {
      return {
        status: "invalid",
        reason: `unknown field "${key}"; entity "${entity.name}" declares: ${describeProperties(entity)}.`,
      };
    }
    if (direction !== "asc" && direction !== "desc") {
      return { status: "invalid", reason: `orderBy.${key} must be "asc" or "desc".` };
    }
    value[key] = direction;
  }
  return { status: "valid", value };
}

/**
 * Serializes one stored row for tool output: `Date` instances become ISO
 * strings; other scalars pass through unchanged.
 */
export function serializeRecord(
  entity: ToolEntityInfo,
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const serialized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    serialized[key] = value instanceof Date ? value.toISOString() : value;
  }
  return serialized;
}

/** Coerces one JSON scalar into its library-side value, or undefined. */
function coerceScalar(
  type: HikouteiMcpScalarType,
  nullable: boolean,
  raw: unknown,
  key: string,
): unknown {
  if (raw === null) {
    return nullable ? null : undefined;
  }
  switch (type) {
    case "string":
      return typeof raw === "string" ? raw : undefined;
    case "number":
      return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "date": {
      if (typeof raw !== "string" || raw.trim() === "") return undefined;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) return undefined;
      return parsed;
    }
  }
}

/** Human-readable coercion failure for one field. */
function coercionProblem(type: HikouteiMcpScalarType, key: string, raw: unknown): string {
  if (type === "date") {
    return `field "${key}" must be an ISO 8601 date-time string (got ${JSON.stringify(raw)}).`;
  }
  if (type === "number") {
    return `field "${key}" must be a finite number (got ${JSON.stringify(raw)}).`;
  }
  if (type === "boolean") {
    return `field "${key}" must be a boolean (got ${JSON.stringify(raw)}).`;
  }
  return `field "${key}" must be a string (got ${JSON.stringify(raw)}).`;
}

/** Compact property listing for error messages. */
function describeProperties(entity: ToolEntityInfo): string {
  return [...entity.properties.values()]
    .map((property) => `${property.name} (${property.type}${property.primary ? ", primary" : ""})`)
    .join(", ");
}

/** True for a plain object (not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True only for JavaScript `undefined`. */
function isUndefined(value: unknown): boolean {
  return value === undefined;
}
