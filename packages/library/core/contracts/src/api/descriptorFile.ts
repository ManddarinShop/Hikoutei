/**
 * Versioned file form of an entity descriptor (`infer --emit`, startup
 * `descriptors`, `adopt --descriptor`).
 *
 * The sheet→DB loop closes to two steps: `infer --emit desc.json` writes
 * this file once, then `createTypedSheets({ descriptors })` and
 * `adopt --descriptor desc.json` consume it. The file is DATA, never code:
 * it is parsed as JSON, validated with the same rules
 * `defineTypedSheetsEntity` enforces, and registered through the same
 * builder — no codegen, no eval, no lifecycle bypass.
 *
 * Schema (v1):
 * ```json
 * {
 *   "hikouteiDescriptor": 1,
 *   "name": "Invoice",
 *   "tableName": "invoices",
 *   "properties": {
 *     "invoiceNo": { "header": "Invoice No", "type": "string", "primary": true },
 *     "total": { "header": "Total", "type": "number", "nullable": true }
 *   }
 * }
 * ```
 * Property keys are the camelCase entity property names; `header` preserves
 * the original sheet header so adopt can derive its header→property
 * columnMap without manual `--map` flags. `type`/`primary`/`nullable` carry
 * the exact `defineTypedSheetsEntity` property options (minus the `header`).
 */

import { isRecord } from "../encoding/typeGuards.js";
import {
  defineTypedSheetsEntity,
  resolveEntityDescriptor,
  type HikouteiEntity,
  type HikouteiEntityDescriptorInput,
  type HikouteiScalarType,
} from "./entity.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "./errors.js";

/** The only descriptor file version accepted by this build. */
export const HIKOUTEI_DESCRIPTOR_FILE_VERSION = 1 as const;

/** One property entry in a descriptor file: sheet header + scalar options. */
export interface HikouteiDescriptorFileProperty {
  /** Original sheet header; adopt derives its columnMap from these. */
  readonly header: string;
  /** Scalar value type stored in the entity table. */
  readonly type: HikouteiScalarType;
  /** Marks this field as the single primary-key/business-key column. */
  readonly primary?: boolean;
  /** Allows `null` values for this field. */
  readonly nullable?: boolean;
}

/** Versioned descriptor file shape: entity identity + headed properties. */
export interface HikouteiDescriptorFile {
  /** Schema version tag; must equal `HIKOUTEI_DESCRIPTOR_FILE_VERSION`. */
  readonly hikouteiDescriptor: typeof HIKOUTEI_DESCRIPTOR_FILE_VERSION;
  /** Stable entity name used by the manager and internal service mappings. */
  readonly name: string;
  /** SQLite table name that stores this entity's rows. */
  readonly tableName: string;
  /** Headed property declarations keyed by property name. */
  readonly properties: Readonly<Record<string, HikouteiDescriptorFileProperty>>;
}

/** One headed column used to build a descriptor file (e.g. from inference). */
export interface HikouteiDescriptorColumn {
  /** camelCase entity property name. */
  readonly property: string;
  /** Original sheet header preserved for adopt's column mapping. */
  readonly header: string;
  /** Inferred scalar type. */
  readonly type: HikouteiScalarType;
  /** True for the single primary-key/business-key column. */
  readonly primary: boolean;
}

/**
 * Builds a versioned descriptor file from headed columns.
 *
 * Pure constructor shared by `infer --emit`: the caller supplies the entity
 * identity plus one entry per sampled column, and the file preserves every
 * original header for the later `adopt --descriptor` columnMap.
 */
export function buildDescriptorFile(input: {
  readonly name: string;
  readonly tableName: string;
  readonly columns: readonly HikouteiDescriptorColumn[];
}): HikouteiDescriptorFile {
  const properties: Record<string, HikouteiDescriptorFileProperty> = {};
  for (const column of input.columns) {
    properties[column.property] = column.primary
      ? { header: column.header, type: column.type, primary: true }
      : { header: column.header, type: column.type };
  }
  return {
    hikouteiDescriptor: HIKOUTEI_DESCRIPTOR_FILE_VERSION,
    name: input.name,
    tableName: input.tableName,
    properties,
  };
}

/** Serializes a descriptor file to stable JSON (2-space, trailing newline). */
export function serializeDescriptorFile(file: HikouteiDescriptorFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Validates an unknown JSON value as a descriptor file.
 *
 * Checks the version tag and the header/type envelope here, then runs the
 * scalar core through `defineTypedSheetsEntity`'s own rules by promoting the
 * stripped input with `resolveEntityDescriptor` semantics: the returned file
 * is guaranteed to satisfy the builder, so a later
 * `defineTypedSheetsEntityFromDescriptorFile()` cannot fail on shape.
 * Throws a typed `HikouteiError` (`INVALID_ENTITY_DESCRIPTOR`) on a version
 * mismatch or any malformed field.
 */
export function parseDescriptorFile(value: unknown): HikouteiDescriptorFile {
  if (!isRecord(value)) {
    throwInvalid("descriptor file must be a JSON object.");
  }
  if (value.hikouteiDescriptor !== HIKOUTEI_DESCRIPTOR_FILE_VERSION) {
    throwInvalid(
      `unsupported descriptor version ${stringifyVersion(value.hikouteiDescriptor)}; this build reads version ${HIKOUTEI_DESCRIPTOR_FILE_VERSION}.`,
    );
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    throwInvalid("descriptor file name must be a non-empty string.");
  }
  if (typeof value.tableName !== "string" || value.tableName.trim() === "") {
    throwInvalid("descriptor file tableName must be a non-empty string.");
  }
  if (!isRecord(value.properties) || Object.keys(value.properties).length === 0) {
    throwInvalid("descriptor file properties must be an object keyed by property name.");
  }
  const properties: Record<string, HikouteiDescriptorFileProperty> = {};
  for (const [propertyName, entry] of Object.entries(value.properties)) {
    if (!isRecord(entry)) {
      throwInvalid(`descriptor property "${propertyName}" must be an object.`);
    }
    if (typeof entry.header !== "string" || entry.header.trim() === "") {
      throwInvalid(`descriptor property "${propertyName}" header must be a non-empty string.`);
    }
    if (!isScalarType(entry.type)) {
      throwInvalid(
        `descriptor property "${propertyName}" has an unsupported type; v1 supports only "string", "number", "boolean", and "date" scalars.`,
      );
    }
    if (entry.primary !== undefined && typeof entry.primary !== "boolean") {
      throwInvalid(`descriptor property "${propertyName}" primary must be a boolean.`);
    }
    if (entry.nullable !== undefined && typeof entry.nullable !== "boolean") {
      throwInvalid(`descriptor property "${propertyName}" nullable must be a boolean.`);
    }
    const allowed = new Set(["header", "type", "primary", "nullable"]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        throwInvalid(`descriptor property "${propertyName}" has an unsupported option "${key}".`);
      }
    }
    properties[propertyName] = {
      header: entry.header,
      type: entry.type,
      ...(entry.primary === undefined ? {} : { primary: entry.primary }),
      ...(entry.nullable === undefined ? {} : { nullable: entry.nullable }),
    };
  }
  const file: HikouteiDescriptorFile = {
    hikouteiDescriptor: HIKOUTEI_DESCRIPTOR_FILE_VERSION,
    name: value.name,
    tableName: value.tableName,
    properties,
  };
  // Run the scalar core through the builder's own validation so a parsed
  // file is guaranteed registrable (same rules, same error codes).
  resolveEntityDescriptor(descriptorFileToEntityInput(file));
  return file;
}

/**
 * Strips the file envelope (`hikouteiDescriptor`, `header`) down to the
 * plain builder input. The result flows through `defineTypedSheetsEntity`
 * unchanged, so file-registered entities take the exact same path as
 * code-registered ones (the token needs no TS types at runtime — only this
 * resolved descriptor object).
 */
export function descriptorFileToEntityInput(
  file: HikouteiDescriptorFile,
): HikouteiEntityDescriptorInput {
  const properties: Record<string, { type: HikouteiScalarType; primary?: boolean; nullable?: boolean }> = {};
  for (const [propertyName, entry] of Object.entries(file.properties)) {
    properties[propertyName] = {
      type: entry.type,
      ...(entry.primary === undefined ? {} : { primary: entry.primary }),
      ...(entry.nullable === undefined ? {} : { nullable: entry.nullable }),
    };
  }
  return { name: file.name, tableName: file.tableName, properties };
}

/**
 * Registers a descriptor file through the same builder code entities use.
 *
 * The JSON object is never evaluated: it is validated by
 * `parseDescriptorFile` (or structurally by the caller) and promoted to a
 * plain `HikouteiEntityDescriptorInput` before `defineTypedSheetsEntity`
 * validates and resolves it. The returned token is indistinguishable from a
 * code-registered one (CRUD, sync projection, adoption).
 */
export function defineTypedSheetsEntityFromDescriptorFile(
  file: HikouteiDescriptorFile,
): HikouteiEntity {
  return defineTypedSheetsEntity(descriptorFileToEntityInput(file));
}

/**
 * Derives adopt's header→property columnMap from the file's `header` fields.
 *
 * Replaces manual `--map Header=property` for the infer case: every headed
 * property contributes one `header → property` binding.
 */
export function descriptorFileColumnMap(
  file: HikouteiDescriptorFile,
): Record<string, string> {
  const columnMap: Record<string, string> = {};
  for (const [propertyName, entry] of Object.entries(file.properties)) {
    columnMap[entry.header] = propertyName;
  }
  return columnMap;
}

function isScalarType(value: unknown): value is HikouteiScalarType {
  return value === "string" || value === "number" || value === "boolean" || value === "date";
}

function stringifyVersion(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "unknown";
}

function throwInvalid(message: string): never {
  throw new HikouteiError(HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR, message);
}
