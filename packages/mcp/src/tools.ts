/**
 * The hikoutei-mcp tool surface: eight read/write tools over the public
 * Hikoutei EntityManager plus the read-only sync observability subpath.
 *
 * Every tool call forks a request-local manager (`em.fork()`), mirroring the
 * documented application workflow. Agents read and write the local SQLite
 * authority; Google Sheets delivery stays asynchronous and is observable
 * through `get_sync_status` / `list_conflicts`. Failures are returned as
 * `isError` results with stable `hikoutei:<code>` text so the calling model
 * can self-correct instead of treating the tool as broken.
 */

import {
  HikouteiError,
  type Hikoutei,
  type HikouteiEntity,
} from "hikoutei";
import {
  listHikouteiConflicts,
  readHikouteiSyncStatus,
} from "hikoutei/internal/sync-status";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  serializeRecord,
  validateOrderBy,
  validatePrimaryId,
  validateRecordData,
  validateWhereFilter,
  type ToolEntityInfo,
} from "./values.js";

/** Default page size for find_records. */
export const DEFAULT_FIND_LIMIT = 50;
/** Hard page-size ceiling for find_records; protects the model's context. */
export const MAX_FIND_LIMIT = 500;
/** Default conflict page size for list_conflicts. */
export const DEFAULT_CONFLICT_LIMIT = 50;

/** Runtime wiring every tool handler reads from. */
export interface HikouteiToolContext {
  /** Open Hikoutei runtime (may be sync-enabled via the environment). */
  readonly hikoutei: Hikoutei;
  /** SQLite path the runtime was opened with; used by status reads. */
  readonly dbName: string;
  /** Validated entity metadata by entity name. */
  readonly entityInfos: ReadonlyMap<string, ToolEntityInfo>;
  /** Entity tokens by entity name, for EntityManager calls. */
  readonly tokens: ReadonlyMap<string, HikouteiEntity<object>>;
}

/** One tool call outcome, shaped as an MCP CallToolResult payload. */
export interface HikouteiToolOutcome {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** Tool names exposed on the MCP surface. */
export const HIKOUTEI_MCP_TOOLS = [
  "list_entities",
  "create_record",
  "find_records",
  "get_record",
  "update_record",
  "delete_record",
  "get_sync_status",
  "list_conflicts",
] as const;

/** Tool name union. */
export type HikouteiMcpToolName = (typeof HIKOUTEI_MCP_TOOLS)[number];

/** Builds the static tool advertisement for `tools/list`. */
export function buildToolDefinitions(
  entityInfos: ReadonlyMap<string, ToolEntityInfo>,
): readonly Tool[] {
  const entityNames = [...entityInfos.keys()];
  const entityEnum = {
    type: "string" as const,
    enum: entityNames,
    description: "Entity name declared in hikoutei.config.json.",
  };
  return [
    {
      name: "list_entities",
      description:
        "List the entities declared for this hikoutei runtime with their fields, types, and primary keys.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "create_record",
      description:
        "Create one record in the local SQLite authority. Delivery to the Google Sheet is asynchronous; check get_sync_status afterwards. All non-nullable fields are required; dates are ISO 8601 strings.",
      inputSchema: {
        type: "object",
        properties: {
          entity: entityEnum,
          data: {
            type: "object",
            description: "Field values for the new record, keyed by property name.",
          },
        },
        required: ["entity", "data"],
        additionalProperties: false,
      },
    },
    {
      name: "find_records",
      description:
        "Find records in the local SQLite authority. `where` maps field names to a value (equality) or an operator object: eq, ne, gt, gte, lt, lte, in, nin, like.",
      inputSchema: {
        type: "object",
        properties: {
          entity: entityEnum,
          where: {
            type: "object",
            description: 'Filter, e.g. {"name": {"like": "Ada"}} or {"age": {"gte": 30}}.',
          },
          limit: { type: "integer", minimum: 1, maximum: MAX_FIND_LIMIT },
          offset: { type: "integer", minimum: 0 },
          orderBy: {
            type: "object",
            description: 'Sort map, e.g. {"name": "asc"}.',
            additionalProperties: { type: "string", enum: ["asc", "desc"] },
          },
        },
        required: ["entity"],
        additionalProperties: false,
      },
    },
    {
      name: "get_record",
      description: "Fetch one record by its primary key from the local SQLite authority.",
      inputSchema: {
        type: "object",
        properties: {
          entity: entityEnum,
          id: {
            type: ["string", "number"],
            description: "Primary-key value of the record.",
          },
        },
        required: ["entity", "id"],
        additionalProperties: false,
      },
    },
    {
      name: "update_record",
      description:
        "Update one record by primary key (partial data; the primary key itself is immutable). Changes commit to SQLite first; the Sheet projection follows asynchronously.",
      inputSchema: {
        type: "object",
        properties: {
          entity: entityEnum,
          id: { type: ["string", "number"], description: "Primary-key value of the record." },
          data: {
            type: "object",
            description: "Fields to change, keyed by property name.",
          },
        },
        required: ["entity", "id", "data"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_record",
      description: "Delete one record by primary key from the local SQLite authority.",
      inputSchema: {
        type: "object",
        properties: {
          entity: entityEnum,
          id: { type: ["string", "number"], description: "Primary-key value of the record." },
        },
        required: ["entity", "id"],
        additionalProperties: false,
      },
    },
    {
      name: "get_sync_status",
      description:
        "Report whether sync is enabled, which spreadsheet is bound (ID only), pending/failed Sheet effect counts, and unresolved conflict counts. In local-only mode returns {mode: \"local\"}.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "list_conflicts",
      description:
        "List unresolved conflicts where a human edited the Sheet and hikoutei kept SQLite authoritative. Read-only in v1: report these to the human; do not attempt automated resolution.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: MAX_FIND_LIMIT },
        },
        additionalProperties: false,
      },
    },
  ];
}

/**
 * Dispatches one MCP tool call against the runtime.
 *
 * Unknown tool names and invalid arguments come back as `isError` outcomes
 * with corrective text; they never throw, so the transport stays alive.
 */
export async function callHikouteiTool(
  context: HikouteiToolContext,
  name: string,
  args: unknown,
): Promise<HikouteiToolOutcome> {
  try {
    switch (name) {
      case "list_entities":
        return await handleListEntities(context);
      case "create_record":
        return await handleCreateRecord(context, args);
      case "find_records":
        return await handleFindRecords(context, args);
      case "get_record":
        return await handleGetRecord(context, args);
      case "update_record":
        return await handleUpdateRecord(context, args);
      case "delete_record":
        return await handleDeleteRecord(context, args);
      case "get_sync_status":
        return await handleGetSyncStatus(context);
      case "list_conflicts":
        return await handleListConflicts(context, args);
      default:
        return errorOutcome(`unknown tool "${name}"; available: ${HIKOUTEI_MCP_TOOLS.join(", ")}.`);
    }
  } catch (error: unknown) {
    return errorOutcome(formatToolError(error));
  }
}

/** list_entities: entity metadata from the validated config. */
async function handleListEntities(context: HikouteiToolContext): Promise<HikouteiToolOutcome> {
  const entities = [...context.entityInfos.values()].map((entity) => ({
    name: entity.name,
    tableName: entity.tableName,
    primaryKey: entity.primaryKey,
    properties: [...entity.properties.values()].map((property) => ({
      name: property.name,
      type: property.type,
      primary: property.primary,
      nullable: property.nullable,
    })),
  }));
  return okOutcome({ entities });
}

/** create_record: fork, create, persist, flush, return the stored row. */
async function handleCreateRecord(
  context: HikouteiToolContext,
  args: unknown,
): Promise<HikouteiToolOutcome> {
  const parsed = requireArgs(args);
  const entity = requireEntity(context, parsed.entity);
  const data = validateRecordData(entity, parsed.data, "create");
  if (data.status === "invalid") return errorOutcome(data.reason);
  const em = context.hikoutei.em.fork();
  const created = em.create(requireToken(context, entity.name), data.value);
  em.persist(created);
  await em.flush();
  return okOutcome({ record: serializeRecord(entity, created as Record<string, unknown>) });
}

/** find_records: paged, filtered read. */
async function handleFindRecords(
  context: HikouteiToolContext,
  args: unknown,
): Promise<HikouteiToolOutcome> {
  const parsed = requireArgs(args);
  const entity = requireEntity(context, parsed.entity);
  const options = parsePaging(parsed, entity);
  if (options.status === "invalid") return errorOutcome(options.reason);
  const rows = await context.hikoutei.em
    .fork()
    .find(
      requireToken(context, entity.name),
      options.where as never,
      { limit: options.limit, offset: options.offset, orderBy: options.orderBy } as never,
    );
  return okOutcome({
    entity: entity.name,
    count: rows.length,
    rows: rows.map((row) => serializeRecord(entity, row as Record<string, unknown>)),
  });
}

/** get_record: single read by primary key. */
async function handleGetRecord(
  context: HikouteiToolContext,
  args: unknown,
): Promise<HikouteiToolOutcome> {
  const parsed = requireArgs(args);
  const entity = requireEntity(context, parsed.entity);
  const id = validatePrimaryId(entity, parsed.id);
  if (id.status === "invalid") return errorOutcome(id.reason);
  const row = await context.hikoutei.em
    .fork()
    .findOne(requireToken(context, entity.name), { [entity.primaryKey]: id.value } as never);
  if (row === null) {
    return okOutcome({ record: null, found: false });
  }
  return okOutcome({ record: serializeRecord(entity, row as Record<string, unknown>), found: true });
}

/** update_record: managed-instance mutation by primary key. */
async function handleUpdateRecord(
  context: HikouteiToolContext,
  args: unknown,
): Promise<HikouteiToolOutcome> {
  const parsed = requireArgs(args);
  const entity = requireEntity(context, parsed.entity);
  const id = validatePrimaryId(entity, parsed.id);
  if (id.status === "invalid") return errorOutcome(id.reason);
  const data = validateRecordData(entity, parsed.data, "update");
  if (data.status === "invalid") return errorOutcome(data.reason);
  const em = context.hikoutei.em.fork();
  const row = await em.findOne(
    requireToken(context, entity.name),
    { [entity.primaryKey]: id.value } as never,
  );
  if (row === null) {
    return errorOutcome(
      `no "${entity.name}" record with ${entity.primaryKey}=${JSON.stringify(id.value)}.`,
    );
  }
  Object.assign(row as Record<string, unknown>, data.value);
  em.persist(row);
  await em.flush();
  return okOutcome({ record: serializeRecord(entity, row as Record<string, unknown>) });
}

/** delete_record: remove by primary key. */
async function handleDeleteRecord(
  context: HikouteiToolContext,
  args: unknown,
): Promise<HikouteiToolOutcome> {
  const parsed = requireArgs(args);
  const entity = requireEntity(context, parsed.entity);
  const id = validatePrimaryId(entity, parsed.id);
  if (id.status === "invalid") return errorOutcome(id.reason);
  const em = context.hikoutei.em.fork();
  const row = await em.findOne(
    requireToken(context, entity.name),
    { [entity.primaryKey]: id.value } as never,
  );
  if (row === null) {
    return errorOutcome(
      `no "${entity.name}" record with ${entity.primaryKey}=${JSON.stringify(id.value)}.`,
    );
  }
  em.remove(row);
  await em.flush();
  return okOutcome({ deleted: true, id: id.value });
}

/** get_sync_status: read-only observability over the SQLite authority. */
async function handleGetSyncStatus(context: HikouteiToolContext): Promise<HikouteiToolOutcome> {
  const status = await readHikouteiSyncStatus({ dbName: context.dbName });
  return okOutcome(status);
}

/** list_conflicts: newest unresolved conflicts first, read-only. */
async function handleListConflicts(
  context: HikouteiToolContext,
  args: unknown,
): Promise<HikouteiToolOutcome> {
  const parsed = requireArgs(args);
  const limit = resolveOptionalLimit(parsed.limit);
  if (limit.status === "invalid") return errorOutcome(limit.reason);
  const conflicts = await listHikouteiConflicts({ dbName: context.dbName, limit: limit.value });
  return okOutcome({ conflicts });
}

/** Validates the outer args envelope every tool receives. */
function requireArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ToolUsageError("tool arguments must be a JSON object.");
  }
  return args as Record<string, unknown>;
}

/** Resolves and validates the `entity` argument. */
function requireEntity(context: HikouteiToolContext, name: unknown): ToolEntityInfo {
  if (typeof name !== "string") {
    throw new ToolUsageError("entity must be a string.");
  }
  const entity = context.entityInfos.get(name);
  if (entity === undefined) {
    throw new ToolUsageError(
      `unknown entity "${name}"; declared: ${[...context.entityInfos.keys()].join(", ")}.`,
    );
  }
  return entity;
}

/** Resolves the registered token for an entity name. */
function requireToken(context: HikouteiToolContext, name: string): HikouteiEntity<object> {
  const token = context.tokens.get(name);
  if (token === undefined) {
    throw new ToolUsageError(`entity "${name}" has no registered token.`);
  }
  return token;
}

/** Parses where/limit/offset/orderBy for find_records. */
function parsePaging(
  parsed: Record<string, unknown>,
  entity: ToolEntityInfo,
):
  | { readonly status: "valid"; readonly where: unknown; readonly limit: number; readonly offset: number; readonly orderBy: unknown }
  | { readonly status: "invalid"; readonly reason: string } {
  if (parsed.where !== undefined) {
    const where = validateWhereFilter(entity, parsed.where);
    if (where.status === "invalid") return { status: "invalid", reason: where.reason };
    return finishPaging(parsed, entity, where.value);
  }
  return finishPaging(parsed, entity, undefined);
}

/** Shared tail of parsePaging after the filter is known valid. */
function finishPaging(
  parsed: Record<string, unknown>,
  entity: ToolEntityInfo,
  where: unknown,
):
  | { readonly status: "valid"; readonly where: unknown; readonly limit: number; readonly offset: number; readonly orderBy: unknown }
  | { readonly status: "invalid"; readonly reason: string } {
  const limit = resolveOptionalLimit(parsed.limit ?? DEFAULT_FIND_LIMIT);
  if (limit.status === "invalid") return { status: "invalid", reason: limit.reason };
  const offset = resolveNonNegativeInteger(parsed.offset, "offset");
  if (offset.status === "invalid") return { status: "invalid", reason: offset.reason };
  let orderBy: unknown = undefined;
  if (parsed.orderBy !== undefined) {
    const order = validateOrderBy(entity, parsed.orderBy);
    if (order.status === "invalid") return { status: "invalid", reason: order.reason };
    orderBy = order.value;
  }
  return { status: "valid", where, limit: limit.value, offset: offset.value, orderBy };
}

/** Validates an optional positive integer with the given default applied by callers. */
function resolveOptionalLimit(
  raw: unknown,
): { readonly status: "valid"; readonly value: number } | { readonly status: "invalid"; readonly reason: string } {
  if (raw === undefined) return { status: "valid", value: DEFAULT_CONFLICT_LIMIT };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    return { status: "invalid", reason: "limit must be a positive integer." };
  }
  return { status: "valid", value: Math.min(raw, MAX_FIND_LIMIT) };
}

/** Validates an optional non-negative integer (offset). */
function resolveNonNegativeInteger(
  raw: unknown,
  label: string,
): { readonly status: "valid"; readonly value: number } | { readonly status: "invalid"; readonly reason: string } {
  if (raw === undefined) return { status: "valid", value: 0 };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return { status: "invalid", reason: `${label} must be a non-negative integer.` };
  }
  return { status: "valid", value: raw };
}

/** Formats tool failures with the stable code prefix. */
function formatToolError(error: unknown): string {
  if (error instanceof ToolUsageError) return error.message;
  if (error instanceof HikouteiError) {
    return `hikoutei:${error.code}: ${error.message}`;
  }
  return `hikoutei:unknown: ${error instanceof Error ? error.message : String(error)}`;
}

/** Success outcome with both text and structured payloads. */
function okOutcome(payload: unknown): HikouteiToolOutcome {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** Failure outcome; never throws so the transport stays alive. */
function errorOutcome(text: string): HikouteiToolOutcome {
  return { content: [{ type: "text", text }], isError: true };
}

/** Internal control-flow error for argument shape problems. */
class ToolUsageError extends Error {}
