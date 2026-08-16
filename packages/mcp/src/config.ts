/**
 * Loader and validator for `hikoutei.config.json`, the MCP server's entity
 * declaration file.
 *
 * The file is plain JSON so non-TypeScript users (the typical Claude Desktop
 * audience) can author it. Every field is validated with runtime guards and
 * failures report precise fixes; validation deliberately mirrors the rules of
 * `defineTypedSheetsEntity()` (SQL identifiers, reserved tables, exactly one
 * primary key, no duplicate names/tables) so a config accepted here also
 * passes the library boundary.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Search order for the config file: CLI flag, env var, then CWD default. */
export const HIKOUTEI_MCP_CONFIG_FILE_NAME = "hikoutei.config.json";
/** Env var pointing at an explicit config path. */
export const HIKOUTEI_MCP_CONFIG_ENV = "HIKOUTEI_MCP_CONFIG";
/** CLI flag consumed by {@link resolveConfigPath}. */
export const CONFIG_FLAG = "--config";

/** Scalar property types accepted in the config file. */
export type HikouteiMcpScalarType = "string" | "number" | "boolean" | "date";

/** One declared property. */
export interface HikouteiMcpPropertyConfig {
  readonly type: HikouteiMcpScalarType;
  readonly primary?: boolean;
  readonly nullable?: boolean;
}

/** One declared entity. */
export interface HikouteiMcpEntityConfig {
  readonly name: string;
  readonly tableName: string;
  readonly properties: Readonly<Record<string, HikouteiMcpPropertyConfig>>;
}

/** Fully validated config file value. */
export interface HikouteiMcpConfig {
  readonly entities: readonly HikouteiMcpEntityConfig[];
}

/** Discriminated loader result; callers must branch on `status`. */
export type HikouteiMcpConfigLoadResult =
  | { readonly status: "valid"; readonly config: HikouteiMcpConfig; readonly sourcePath: string }
  | { readonly status: "invalid"; readonly reason: string };

const SCALAR_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean", "date"]);
const ALLOWED_PROPERTY_KEYS: ReadonlySet<string> = new Set(["type", "primary", "nullable"]);
const ALLOWED_ENTITY_KEYS: ReadonlySet<string> = new Set(["name", "tableName", "properties"]);
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolves which config file to use: `--config <path>` flag, then the
 * `HIKOUTEI_MCP_CONFIG` env var, then `./hikoutei.config.json` in the CWD.
 *
 * Returns the resolved absolute path, or `null` when no candidate exists.
 * An explicitly requested path that cannot be read is reported by
 * {@link loadHikouteiMcpConfig}, not here.
 */
export function resolveConfigPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const flagIndex = argv.indexOf(CONFIG_FLAG);
  if (flagIndex >= 0) {
    const flagged = argv[flagIndex + 1];
    if (flagged !== undefined && flagged !== "") return resolve(flagged);
  }
  const fromEnv = env[HIKOUTEI_MCP_CONFIG_ENV];
  if (fromEnv !== undefined && fromEnv.trim() !== "") return resolve(fromEnv.trim());
  return resolve(HIKOUTEI_MCP_CONFIG_FILE_NAME);
}

/**
 * Loads and validates the config file at `path`.
 *
 * Never throws for user errors: every problem (unparseable JSON, wrong
 * envelope, bad identifiers, missing or duplicate primary keys, duplicate
 * entity names or tables, unknown keys) comes back as
 * `{ status: "invalid", reason }` with a corrective message. Only unexpected
 * I/O errors propagate.
 */
export async function loadHikouteiMcpConfig(path: string): Promise<HikouteiMcpConfigLoadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return {
        status: "invalid",
        reason:
          `config file not found at ${path}. Create ${HIKOUTEI_MCP_CONFIG_FILE_NAME} ` +
          "(or pass --config / set HIKOUTEI_MCP_CONFIG) declaring at least one entity.",
      };
    }
    return { status: "invalid", reason: `could not read config file ${path}: ${messageOf(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    return { status: "invalid", reason: `config file ${path} is not valid JSON: ${messageOf(error)}` };
  }
  return validateConfig(parsed, path);
}

/** Validates the parsed JSON envelope and every entity declaration. */
function validateConfig(
  parsed: unknown,
  path: string,
): HikouteiMcpConfigLoadResult {
  const problems: string[] = [];
  if (!isRecord(parsed)) {
    return { status: "invalid", reason: `config file ${path} must contain a JSON object.` };
  }
  for (const key of Object.keys(parsed)) {
    if (key !== "entities") {
      problems.push(`unknown top-level key "${key}"; only "entities" is supported.`);
    }
  }
  const entitiesInput = parsed.entities;
  if (!Array.isArray(entitiesInput) || entitiesInput.length === 0) {
    return {
      status: "invalid",
      reason: `config file ${path} must declare "entities" as a non-empty array.`,
    };
  }

  const seenNames = new Set<string>();
  const seenTables = new Set<string>();
  const entities: HikouteiMcpEntityConfig[] = [];

  entitiesInput.forEach((entityInput: unknown, index: number) => {
    const label = `entities[${index}]`;
    if (!isRecord(entityInput)) {
      problems.push(`${label} must be an object.`);
      return;
    }
    for (const key of Object.keys(entityInput)) {
      if (!ALLOWED_ENTITY_KEYS.has(key)) {
        problems.push(`${label} has an unknown key "${key}"; allowed: name, tableName, properties.`);
      }
    }
    const name = requireIdentifier(entityInput.name, `${label}.name`, problems);
    const tableName = requireTableName(entityInput.tableName, `${label}.tableName`, problems);
    if (name !== null && seenNames.has(name)) {
      problems.push(`duplicate entity name "${name}"; every entity name must be unique.`);
    } else if (name !== null) {
      seenNames.add(name);
    }
    if (tableName !== null && seenTables.has(tableName)) {
      problems.push(
        `duplicate table name "${tableName}" (entity "${name ?? label}"); every entity needs its own table.`,
      );
    } else if (tableName !== null) {
      seenTables.add(tableName);
    }

    const propertiesInput = entityInput.properties;
    if (!isRecord(propertiesInput) || Object.keys(propertiesInput).length === 0) {
      problems.push(`${label}.properties must be a non-empty object of property descriptors.`);
      entities.push({
        name: name ?? "",
        tableName: tableName ?? "",
        properties: {},
      });
      return;
    }
    const properties = validateProperties(propertiesInput, `${label}.properties`, problems);
    const primaryCount = Object.values(properties).filter((property) => property.primary).length;
    if (primaryCount === 0) {
      problems.push(`${label} must declare exactly one "primary": true property; found none.`);
    } else if (primaryCount > 1) {
      problems.push(`${label} must declare exactly one "primary": true property; found ${primaryCount}.`);
    }
    entities.push({ name: name ?? "", tableName: tableName ?? "", properties });
  });

  if (problems.length > 0) {
    return { status: "invalid", reason: `invalid config file ${path}:\n- ${problems.join("\n- ")}` };
  }
  return { status: "valid", config: { entities }, sourcePath: path };
}

/** Validates one entity's property map, collecting problems instead of throwing. */
function validateProperties(
  propertiesInput: Record<string, unknown>,
  label: string,
  problems: string[],
): Record<string, HikouteiMcpPropertyConfig> {
  const properties: Record<string, HikouteiMcpPropertyConfig> = {};
  for (const [propertyName, options] of Object.entries(propertiesInput)) {
    const propertyLabel = `${label}."${propertyName}"`;
    if (!isRecord(options)) {
      problems.push(`${propertyLabel} must be an object with a "type".`);
      continue;
    }
    for (const key of Object.keys(options)) {
      if (!ALLOWED_PROPERTY_KEYS.has(key)) {
        problems.push(
          `${propertyLabel} has an unknown key "${key}"; allowed: type, primary, nullable.`,
        );
      }
    }
    if (typeof options.type !== "string" || !SCALAR_TYPES.has(options.type)) {
      problems.push(
        `${propertyLabel}.type must be one of "string", "number", "boolean", "date".`,
      );
      continue;
    }
    if (options.primary !== undefined && typeof options.primary !== "boolean") {
      problems.push(`${propertyLabel}.primary must be a boolean.`);
      continue;
    }
    if (options.nullable !== undefined && typeof options.nullable !== "boolean") {
      problems.push(`${propertyLabel}.nullable must be a boolean.`);
      continue;
    }
    if (options.primary === true && options.nullable === true) {
      problems.push(`${propertyLabel} cannot be both primary and nullable.`);
    }
    properties[propertyName] = {
      type: options.type as HikouteiMcpScalarType,
      primary: options.primary === true,
      nullable: options.nullable === true,
    };
  }
  return properties;
}

/** Adds a problem unless the value is a valid SQL identifier; returns it or null. */
function requireIdentifier(
  value: unknown,
  label: string,
  problems: string[],
): string | null {
  if (typeof value !== "string" || !SQL_IDENTIFIER_PATTERN.test(value)) {
    problems.push(`${label} must match ${SQL_IDENTIFIER_PATTERN}.`);
    return null;
  }
  return value;
}

/** Adds a problem for reserved table names; returns the name or null. */
function requireTableName(
  value: unknown,
  label: string,
  problems: string[],
): string | null {
  const tableName = requireIdentifier(value, label, problems);
  if (tableName === null) return null;
  const lower = tableName.toLowerCase();
  if (lower.startsWith("sqlite_")) {
    problems.push(`${label} "${tableName}" is reserved by SQLite.`);
    return null;
  }
  return tableName;
}

/** True when the error is a Node system error with the given code. */
function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/** True for a plain object (not an array or null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Best-effort human-readable message from an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
