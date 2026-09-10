/**
 * Pure `hikoutei infer` core: raw grid cells in, descriptor block out.
 *
 * The flow is injectable and network-free: the production CLI reads one tab
 * range through the Sheets API and hands the raw grid here; tests inject a
 * fake grid. Cell normalization ports the provider's getValues semantics
 * (formula cells resolve to their computed effective value, the canonical
 * DATE_TIME number format marks dates, blank stays null) so Sheets-provided
 * typed cell info wins over heuristics — there are no date-format guesses
 * beyond the canonical format the provider itself writes.
 *
 * Source parity notes: the canonical date pattern is byte-identical to
 * `GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT` and the serial math matches
 * `isoFromDateSerial` in the google-sheets-api provider's
 * `model/valueNormalization.ts`. A local port (not an import) keeps the CLI
 * runtime dependency-closed: `@hikoutei/sheets` is not a CLI dependency.
 *
 * Redaction contract: warnings carry COLUMN NAMES ONLY, never cell values.
 */

import {
  buildDescriptorFile,
  serializeDescriptorFile,
  type HikouteiDescriptorFile,
} from "@hikoutei/sync-engine/api/entity.js";

/** Machine-readable CLI error prefix, shared with inferMain.ts. */
export const INFER_ERROR_PREFIX = "hikoutei-infer";

/** Closed set of scalar kinds the inference can emit. */
export type InferScalarType = "string" | "number" | "boolean" | "date";

/** One normalized cell: `null` is an empty cell. */
export type InferCell =
  | null
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "date"; readonly value: string };

/** Raw tab grid handed to the inference (raw Sheets grid cell objects). */
export interface InferTabGrid {
  readonly tabName: string;
  /** Raw grid cells of the header row (rowData values entries). */
  readonly headerCells: readonly unknown[];
  /** Raw grid cells of sampled data rows (rowData values entries per row). */
  readonly dataCells: readonly (readonly unknown[])[];
}

/** Injectable tab sampler; production wraps the Sheets API, tests use fakes. */
export type InferTabReader = (input: {
  readonly spreadsheetId: string;
  readonly tabName: string;
  readonly limit: number;
}) => Promise<InferTabGrid>;

/** One column-name-only inference warning. */
export interface InferWarning {
  readonly column: string;
  readonly reason: string;
}

/** One headed column of a successful inference (feeds `--emit`). */
export interface InferColumn {
  /** Original sheet header, preserved for adopt's column mapping. */
  readonly header: string;
  /** camelCase entity property name derived from the header. */
  readonly property: string;
  /** Inferred scalar type (PK-normalized: a boolean/date PK reads string). */
  readonly type: InferScalarType;
  /** True for the single primary-key/business-key column. */
  readonly primary: boolean;
}

/** Successful inference: the TS block plus its summary. */
export interface InferDescriptorResult {
  readonly entityName: string;
  readonly tableName: string;
  readonly tsBlock: string;
  readonly summary: string;
  readonly warnings: readonly InferWarning[];
  readonly sampledRows: number;
  readonly columnCount: number;
  readonly distribution: Readonly<Record<InferScalarType, number>>;
  readonly pkProperty: string;
  /**
   * Headed columns in sheet order. `--emit` builds the descriptor file
   * from these, so the JSON file and the printed block always agree.
   */
  readonly columns: readonly InferColumn[];
}

/** Coded failure thrown by the pure inference (mapped to stderr + exit 1/2). */
export class InferError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InferError";
    this.code = code;
  }
}

/** Canonical UTC date pattern, byte-identical to the provider's own format. */
const INFER_CANONICAL_DATE_PATTERN = 'yyyy"-"mm"-"dd"T"hh:mm:ss.000"Z"';

function normalizedDatePattern(pattern: string): string {
  return pattern.replace(/["\s]/g, "");
}

const NORMALIZED_CANONICAL_DATE_PATTERN = normalizedDatePattern(INFER_CANONICAL_DATE_PATTERN);

/** True when a REST `CellFormat.numberFormat` object is the canonical date format. */
function isCanonicalDateFormat(format: unknown): boolean {
  if (format === null || typeof format !== "object" || Array.isArray(format)) return false;
  const record = format as Record<string, unknown>;
  if (record.type !== "DATE_TIME" || typeof record.pattern !== "string") return false;
  return normalizedDatePattern(record.pattern) === NORMALIZED_CANONICAL_DATE_PATTERN;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformedGrid(): InferError {
  return new InferError("malformed_grid", "the sheet grid has an unsupported cell shape");
}

/** Prefers the user-entered number format, falls back to the effective one. */
function cellNumberFormat(cell: Record<string, unknown>): unknown {
  const entered = cell.userEnteredFormat;
  if (isRecord(entered) && entered.numberFormat !== undefined) return entered.numberFormat;
  const effective = cell.effectiveFormat;
  if (isRecord(effective) && effective.numberFormat !== undefined) return effective.numberFormat;
  return undefined;
}

/** Display string of an error cell: formatted value, else the error message. */
function errorDisplayString(cell: Record<string, unknown>, owner: Record<string, unknown>): string {
  const formatted = cell.formattedValue;
  if (typeof formatted === "string" && formatted.length > 0) return formatted;
  const error = owner.errorValue;
  if (isRecord(error) && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  throw malformedGrid();
}

/** Normalizes one literal ExtendedValue; `null` is blank. */
function literalCell(value: Record<string, unknown>, format: unknown): InferCell {
  if (value.stringValue !== undefined) {
    if (typeof value.stringValue !== "string") throw malformedGrid();
    // An explicit empty string is blank (getValues semantics).
    return value.stringValue.length === 0 ? null : { kind: "string", value: value.stringValue.normalize("NFC") };
  }
  if (value.boolValue !== undefined) {
    if (typeof value.boolValue !== "boolean") throw malformedGrid();
    return { kind: "boolean", value: value.boolValue };
  }
  if (value.numberValue !== undefined) {
    if (typeof value.numberValue !== "number" || !Number.isFinite(value.numberValue)) throw malformedGrid();
    if (isCanonicalDateFormat(format)) {
      return { kind: "date", value: isoFromDateSerial(value.numberValue) };
    }
    return { kind: "number", value: value.numberValue };
  }
  if (Object.keys(value).length === 0) return null;
  throw malformedGrid();
}

/**
 * Normalizes one raw grid cell with getValues semantics: formula cells
 * resolve to their computed effective value, error cells to their display
 * string, literals keep their typed kind, blank cells become `null`.
 */
export function normalizeInferCell(cell: unknown): InferCell {
  if (cell === null || cell === undefined) return null;
  if (!isRecord(cell)) throw malformedGrid();
  const entered = isRecord(cell.userEnteredValue) ? cell.userEnteredValue : undefined;
  const effective = isRecord(cell.effectiveValue) ? cell.effectiveValue : undefined;
  const format = cellNumberFormat(cell);
  if (entered !== undefined && entered.formulaValue !== undefined) {
    if (effective === undefined) throw malformedGrid();
    if (effective.errorValue !== undefined) {
      return { kind: "string", value: errorDisplayString(cell, effective) };
    }
    return literalCell(effective, format);
  }
  if (entered !== undefined && entered.errorValue !== undefined) {
    return { kind: "string", value: errorDisplayString(cell, entered) };
  }
  if (entered === undefined) return null;
  return literalCell(entered, format);
}

/** Excel 1900-system serial (days since 1899-12-30 UTC) back to canonical ISO. */
function isoFromDateSerial(serial: number): string {
  return new Date(Math.round(Date.UTC(1899, 11, 30) + serial * 86_400_000)).toISOString();
}

/** Display text of one raw header cell; blank when empty. */
function headerTextOf(cell: unknown): string {
  if (!isRecord(cell)) return "";
  const formatted = cell.formattedValue;
  if (typeof formatted === "string") return formatted.trim();
  const entered = cell.userEnteredValue;
  if (isRecord(entered) && typeof entered.stringValue === "string") return entered.stringValue.trim();
  return "";
}

const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Splits display text into alphanumeric words. */
function wordsOf(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).filter((word) => word !== "");
}

/** Makes a camelCase property name, suffixed on collision (`name`, `name2`, ...). */
function toPropertyName(header: string, columnIndex: number, used: Set<string>): string {
  const words = wordsOf(header);
  let base = words.length === 0
    ? `field${columnIndex + 1}`
    : words
      .map((word, i) => (i === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1)))
      .join("");
  base = base.replace(/^[^A-Za-z_]+/, "");
  if (base === "" || !SQL_IDENTIFIER_PATTERN.test(base)) base = `field${columnIndex + 1}`;
  let name = base;
  let suffix = 2;
  while (used.has(name)) {
    name = `${base}${suffix}`;
    suffix += 1;
  }
  used.add(name);
  return name;
}

/** Derives the PascalCase entity name from the tab name. */
function toEntityName(tabName: string): string {
  const words = wordsOf(tabName);
  if (words.length === 0) return "InferredEntity";
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
  return SQL_IDENTIFIER_PATTERN.test(name) ? name : "InferredEntity";
}

/** Derives the snake_case table name from the tab name. */
function toTableName(tabName: string): string {
  const words = wordsOf(tabName);
  if (words.length === 0) return "inferred_entity";
  return words.map((word) => word.toLowerCase()).join("_");
}

/**
 * Infers the entity descriptor block from a raw tab grid.
 *
 * Throws `InferError`: `empty_tab` (no header row), `pk_not_found` (the
 * `--pk` header names no sampled column). Warnings carry column names only.
 */
export function inferFromGrid(
  grid: InferTabGrid,
  options: { readonly pkHeader?: string } = {},
): InferDescriptorResult {
  const headers = grid.headerCells.map((cell) => headerTextOf(cell));
  const usable = headers
    .map((header, index) => ({ header, index }))
    .filter((entry) => entry.header !== "");
  if (usable.length === 0) {
    throw new InferError("empty_tab", `Tab "${grid.tabName}" has no header row.`);
  }

  const rows = grid.dataCells.map((cells) => usable.map((entry) => normalizeInferCell(cells[entry.index])));
  const nonEmptyRows = rows.filter((cells) => cells.some((cell) => cell !== null));

  // Column kinds over the sampled non-empty cells; empty/mixed → string.
  const warnings: InferWarning[] = [];
  const types = new Map<number, InferScalarType>();
  const distribution: Record<InferScalarType, number> = { string: 0, number: 0, boolean: 0, date: 0 };
  usable.forEach((entry, position) => {
    const kinds = new Set<InferScalarType>();
    for (const cells of nonEmptyRows) {
      const cell = cells[position];
      if (cell !== null && cell !== undefined) kinds.add(cell.kind);
    }
    let type: InferScalarType;
    if (kinds.size === 0) {
      type = "string";
      warnings.push({ column: entry.header, reason: "empty column; defaulted to string" });
    } else if (kinds.size === 1) {
      type = [...kinds][0]!;
    } else {
      type = "string";
      warnings.push({ column: entry.header, reason: "mixed column types; defaulted to string" });
    }
    types.set(entry.index, type);
    distribution[type] += 1;
  });

  // PK: override header, else the first column. v1 PKs are string|number, so
  // a boolean/date PK column is emitted as string with a warning.
  const pkHeader = options.pkHeader ?? usable[0]!.header;
  const pkEntry = usable.find((entry) => entry.header === pkHeader);
  if (pkEntry === undefined) {
    throw new InferError(
      "pk_not_found",
      options.pkHeader === undefined
        ? `Tab "${grid.tabName}" has no usable first column.`
        : `PK header "${options.pkHeader}" names no column of tab "${grid.tabName}".`,
    );
  }
  let pkType = types.get(pkEntry.index)!;
  if (pkType !== "string" && pkType !== "number") {
    warnings.push({ column: pkEntry.header, reason: `PK type ${pkType} is not a v1 business key; emitted as string` });
    distribution[pkType] -= 1;
    distribution.string += 1;
    pkType = "string";
    types.set(pkEntry.index, "string");
  }

  const entityName = toEntityName(grid.tabName);
  const tableName = toTableName(grid.tabName);
  const used = new Set<string>();
  const props = usable.map((entry) => ({
    header: entry.header,
    name: toPropertyName(entry.header, entry.index, used),
    type: entry.index === pkEntry.index ? pkType : types.get(entry.index)!,
    primary: entry.index === pkEntry.index,
  }));

  const lines: string[] = [
    `import { defineTypedSheetsEntity } from "hikoutei";`,
    ``,
    `export const ${entityName} = defineTypedSheetsEntity({`,
    `  name: "${entityName}",`,
    `  tableName: "${tableName}",`,
    `  properties: {`,
  ];
  for (const prop of props) {
    lines.push(`    // ${JSON.stringify(prop.header.replace(/[\r\n]+/g, " "))}`);
    lines.push(
      prop.primary
        ? `    ${prop.name}: { type: "${prop.type}", primary: true },`
        : `    ${prop.name}: { type: "${prop.type}" },`,
    );
  }
  lines.push(`  },`);
  lines.push(`});`);

  const pkProp = props.find((prop) => prop.primary)!;
  const summaryLines = [
    `Tab "${grid.tabName}": ${nonEmptyRows.length} sampled rows, ${usable.length} columns.`,
    `Types: string=${distribution.string}, number=${distribution.number}, boolean=${distribution.boolean}, date=${distribution.date}.`,
    `PK: ${pkProp.name} (from header "${pkEntry.header}").`,
    warnings.length === 0
      ? `Warnings: (none).`
      : `Warnings:\n${warnings.map((warning) => `WARN "${warning.column}": ${warning.reason}.`).join("\n")}`,
  ];

  return {
    entityName,
    tableName,
    tsBlock: lines.join("\n"),
    summary: summaryLines.join("\n"),
    warnings,
    sampledRows: nonEmptyRows.length,
    columnCount: usable.length,
    distribution,
    pkProperty: pkProp.name,
    columns: props.map((prop) => ({
      header: prop.header,
      property: prop.name,
      type: prop.type,
      primary: prop.primary,
    })),
  };
}

/**
 * Builds the versioned descriptor file for an inference result.
 *
 * Pure and network-free: `--emit` serializes this file next to the printed
 * block, and the file's `header` fields later feed `adopt --descriptor`
 * without manual `--map` flags. Delegates to the contracts builder so the
 * file envelope has one owner; the scalar core matches the printed block
 * column-for-column (same `columns` source), so the two never disagree.
 */
export function inferResultToDescriptorFile(
  result: InferDescriptorResult,
): HikouteiDescriptorFile {
  return buildDescriptorFile({
    name: result.entityName,
    tableName: result.tableName,
    columns: result.columns.map((column) => ({
      property: column.property,
      header: column.header,
      type: column.type,
      primary: column.primary,
    })),
  });
}

/** Serializes an inference result to the stable descriptor-file JSON text. */
export function serializeInferDescriptorFile(result: InferDescriptorResult): string {
  return serializeDescriptorFile(inferResultToDescriptorFile(result));
}
