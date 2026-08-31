/**
 * Existing-sheet adoption (MVP Phase 1 — dry-run introspection).
 *
 * Reads one foreign spreadsheet tab (never provisioned by this library) and
 * produces a binding report against an entity's User_Input route: which
 * sheet columns bind to which entity properties by header NAME (position
 * and order are irrelevant), which columns are ignored, which entity fields
 * have no column, whether the bound columns are contiguous (fast bulk write
 * path) or segmented (per-segment write requests), and whether a usable
 * business-key (PK) column exists.
 *
 * The analysis is PURE: headers + rows in, report out. No network, no
 * SQLite, no mutation. The only sheet mutation the full adoption will ever
 * perform is appending system columns (`__hikoutei_row_id`, and the PK
 * column when it must be generated) — never a rewrite of existing cells
 * (design D2/D4, `design/existing-sheet-adoption-design.md`).
 *
 * Startup contract (D5, fail-closed): dry-run analysis runs BEFORE any
 * provisioning mutation and BEFORE any supervisor starts; the service does
 * not enter its running state until a later milestone completes the seeding.
 */

import {
  columnLetters,
  quoteA1SheetName,
} from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import type { GoogleSheetsApiTransport } from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import type {
  GoogleSheetsApiProviderOptions,
} from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import type {
  ResolvedHikouteiEntityDescriptor,
} from "../../../api/entity.js";
import {
  SYNC_SERVICE_ERROR_CODES,
  SyncServiceError,
} from "../errors.js";
import { randomUUID } from "node:crypto";
import type {
  InternalSyncProjectionConfig,
} from "../contracts.js";
import type {
  RegisteredSyncProjectionDefinition,
} from "@hikoutei/contracts/sheets/sheetsProvisioning.js";

/**
 * Thrown instead of starting the sync service when `adopt.mode === "dry-run"`.
 * Carries the complete read-only report; the spreadsheet was not mutated.
 */
export class ExistingSheetAdoptionDryRunReportError extends SyncServiceError {
  public readonly report: ExistingSheetAdoptionRunReport;

  public constructor(report: ExistingSheetAdoptionRunReport, message: string) {
    super(SYNC_SERVICE_ERROR_CODES.ADOPTION_DRY_RUN_REPORT, message);
    this.report = report;
  }
}

/** Per-entity adoption request from the service options. */
export interface ExistingSheetAdoptionEntitySpec {
  /** The existing tab that becomes this entity's User_Input route (D1). */
  readonly tabName: string;
  /**
   * Sheet header that carries the business key. `"auto"` (or absent) prefers
   * the column matching the entity's primary-key property and falls back to
   * appending a generated PK column (D4).
   */
  readonly identityFrom?: string | "auto";
  /**
   * Explicit header → property binding for sheets whose headers differ from
   * the entity's property names (design §12, C1: adoption-only). Mapped
   * headers take precedence over name matching; unmapped headers keep the
   * name-binding/ignore rules. The map must cover headers that EXIST in the
   * tab and properties that ARE declared; a mapped PK header absorbs the D4
   * alias (identityFrom may name the mapped header).
   */
  readonly columnMap?: Readonly<Record<string, string>>;
}

/** Top-level adoption startup spec. */
export interface ExistingSheetAdoptionSpec {
  readonly mode: "dry-run" | "adopt";
  readonly entities: Readonly<Record<string, ExistingSheetAdoptionEntitySpec>>;
}

/** One bound column: entity property → sheet column. */
export interface ExistingSheetAdoptionColumnBinding {
  readonly field: string;
  /** 0-based column index in the sheet. */
  readonly columnIndex: number;
  readonly columnLetter: string;
  readonly header: string;
  /**
   * When the binding came from `columnMap`, the sheet header it was mapped
   * FROM (the map key). The exact-header expectation for this column is this
   * value instead of `field` (design §12).
   */
  readonly mappedFromHeader?: string;
}

export type ExistingSheetAdoptionProblemSeverity = "error" | "warning";

export interface ExistingSheetAdoptionProblem {
  readonly severity: ExistingSheetAdoptionProblemSeverity;
  readonly code:
    | "MISSING_IDENTITY_COLUMN"
    | "DUPLICATE_HEADER"
    | "MISSING_FIELD"
    | "DUPLICATE_IDENTITY_VALUE"
    | "EMPTY_IDENTITY_VALUE"
    | "NO_PK_CANDIDATE"
    | "TAB_NOT_FOUND"
    | "EMPTY_TAB"
    | "COLUMN_SEGMENTATION"
    | "COLUMN_OCCUPIED"
    | "DECLARATION_ORDER_MISMATCH"
    | "NO_BOUND_COLUMNS"
    | "EXACT_HEADER_MISMATCH"
    | "IDENTITY_ALIAS_UNSUPPORTED"
    | "COLUMN_MAP_UNKNOWN_PROPERTY"
    | "COLUMN_MAP_DUPLICATE_PROPERTY"
    | "COLUMN_MAP_UNKNOWN_HEADER";
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number | readonly string[] | readonly number[]>>;
}

/** One contiguous run of bound column indices. */
export interface ExistingSheetAdoptionColumnSegment {
  readonly startColumnIndex: number;
  readonly endColumnIndex: number;
}

export interface ExistingSheetAdoptionEntityReport {
  readonly entityName: string;
  readonly tabName: string;
  /** `"ready"` = adoption may proceed; `"blocked"` = at least one error. */
  readonly status: "ready" | "blocked";
  readonly sheetHeaders: readonly string[];
  readonly totalRows: number;
  readonly emptyRows: number;
  readonly bindings: readonly ExistingSheetAdoptionColumnBinding[];
  readonly ignoredColumns: readonly { readonly columnLetter: string; readonly header: string }[];
  readonly missingFields: readonly string[];
  readonly contiguity: "contiguous" | "segmented";
  readonly segments: readonly ExistingSheetAdoptionColumnSegment[];
  readonly pk: {
    readonly source: "existing-column" | "auto-generate";
    /** Sheet header of the PK column when sourced from an existing column. */
    readonly column?: string;
    readonly generatedCount?: number;
    readonly duplicates?: readonly { readonly value: string; readonly rowNumbers: readonly number[] }[];
  };
  readonly columnsToBeAdded: readonly string[];
  readonly tabsToProvision: readonly string[];
  readonly problems: readonly ExistingSheetAdoptionProblem[];
}

export interface ExistingSheetAdoptionRunReport {
  readonly mode: "dry-run";
  readonly ok: boolean;
  readonly entities: readonly ExistingSheetAdoptionEntityReport[];
}

/** Raw foreign-tab content handed to the analyzer (already read). */
export interface ExistingSheetTabSnapshot {
  readonly headers: readonly string[];
  /** Data rows below the header row; every cell is a raw string or empty. */
  readonly rows: readonly (readonly (string | undefined)[])[];
}

function isEmptyRow(row: readonly (string | undefined)[]): boolean {
  return row.every((cell) => cell === undefined || cell === "");
}

interface BoundField {
  readonly field: string;
  readonly columnIndex: number;
  readonly header: string;
  readonly primary: boolean;
  readonly nullable: boolean;
}

interface AnalyzeInput {
  readonly entityName: string;
  readonly tabName: string;
  readonly snapshot: ExistingSheetTabSnapshot;
  readonly descriptor: ResolvedHikouteiEntityDescriptor;
  readonly userOwnedFields: readonly string[];
  readonly identityFrom: string | "auto" | undefined;
  readonly columnMap?: Readonly<Record<string, string>> | undefined;
  readonly systemStateTabName: string;
  readonly syncConflictsTabName: string;
}

/**
 * Pure per-entity adoption analysis. Headers + rows in, report out —
 * no I/O, no mutation. Deterministic: identical input always yields an
 * identical report.
 */
export function analyzeExistingSheetAdoptionEntity(
  input: AnalyzeInput,
): ExistingSheetAdoptionEntityReport {
  const { entityName, tabName, snapshot, descriptor, userOwnedFields } = input;
  const problems: ExistingSheetAdoptionProblem[] = [];
  const headers = snapshot.headers;
  const rows = snapshot.rows;

  // Empty-tab gate: a tab without a usable header row cannot bind anything.
  // Emitted explicitly so "ready" can never mean "nothing was there" (the
  // declared-but-previously-unemitted EMPTY_TAB stop condition).
  const usableHeaders = headers.filter((header) => header.trim() !== "");
  if (usableHeaders.length === 0) {
    problems.push({
      severity: "error",
      code: "EMPTY_TAB",
      message: `Tab "${tabName}" has no header row; adoption cannot bind any field.`,
      detail: { tabName },
    });
    return {
      entityName,
      tabName,
      status: "blocked",
      sheetHeaders: [...headers],
      totalRows: rows.length,
      emptyRows: rows.filter(isEmptyRow).length,
      bindings: [],
      ignoredColumns: [],
      missingFields: [],
      contiguity: "contiguous",
      segments: [],
      pk: { source: "auto-generate" },
      columnsToBeAdded: ["__hikoutei_row_id"],
      tabsToProvision: [input.systemStateTabName, input.syncConflictsTabName],
      problems,
    };
  }

  // Name binding (D2): property name === sheet header (trimmed), position and
  // order irrelevant. The binding set is the entity's user-owned fields —
  // those are the headers a User_Input projection carries (plus the row-id
  // system column). Duplicate normalized headers fail closed: a second
  // column with the same name makes binding ambiguous, so they never bind.
  const headerIndexByName = new Map<string, number>();
  const duplicateHeaderColumns = new Map<string, number[]>();
  headers.forEach((header, index) => {
    const normalized = header.trim();
    if (normalized === "") return;
    const seen = headerIndexByName.get(normalized);
    if (seen === undefined) {
      headerIndexByName.set(normalized, index);
    } else {
      const group = duplicateHeaderColumns.get(normalized);
      if (group === undefined) duplicateHeaderColumns.set(normalized, [seen, index]);
      else group.push(index);
    }
  });
  for (const [name, columns] of duplicateHeaderColumns) {
    problems.push({
      severity: "error",
      code: "DUPLICATE_HEADER",
      message: `Tab "${tabName}" has ${columns.length} columns named "${name}"; rename one before adopting.`,
      detail: { column: name, columns: columns.map((index) => columnLetters(index + 1)) },
    });
  }
  const ambiguousNames = new Set(duplicateHeaderColumns.keys());

  const propertyByName = new Map(descriptor.properties.map((p) => [p.name, p]));
  const fields = userOwnedFields.length > 0 ? userOwnedFields : descriptor.properties.map((p) => p.name);
  const primaryKey = descriptor.primaryKey;

  // columnMap validation + resolution (design §12): explicit header → property
  // bindings take precedence over name matching. The map must reference
  // headers that EXIST (uniquely) in the tab and properties that ARE declared
  // user-owned; two headers mapping to one property is ambiguous and fails.
  const columnMap = input.columnMap;
  const headerByField = new Map<string, { header: string; index: number }>();
  if (columnMap !== undefined) {
    const propertyByHeader = new Map<string, string>();
    for (const [header, property] of Object.entries(columnMap)) {
      if (propertyByName.get(property) === undefined) {
        problems.push({
          severity: "error",
          code: "COLUMN_MAP_UNKNOWN_PROPERTY",
          message: `columnMap maps header "${header}" to property "${property}", which the entity "${entityName}" does not declare.`,
          detail: { header, property },
        });
        continue;
      }
      if (propertyByHeader.get(header) !== undefined) {
        continue; // duplicate key is impossible in a Record; kept for clarity
      }
      if (propertyByHeader.size > 0 && [...propertyByHeader.values()].includes(property)) {
        problems.push({
          severity: "error",
          code: "COLUMN_MAP_DUPLICATE_PROPERTY",
          message: `columnMap maps two headers ("${[...propertyByHeader.entries()].find(([, p]) => p === property)?.[0] ?? ""}", "${header}") to the same property "${property}"; the binding would be ambiguous.`,
          detail: { property, header },
        });
        continue;
      }
      const index = headerIndexByName.get(header.trim());
      if (index === undefined || ambiguousNames.has(header.trim())) {
        problems.push({
          severity: "error",
          code: "COLUMN_MAP_UNKNOWN_HEADER",
          message: ambiguousNames.has(header.trim())
            ? `columnMap references header "${header}", which appears more than once in tab "${tabName}".`
            : `columnMap references header "${header}", which does not exist in tab "${tabName}" (check for typos; the report lists every unmapped header).`,
          detail: { header },
        });
        continue;
      }
      propertyByHeader.set(header, property);
      headerByField.set(property, { header, index });
    }
  }

  // PK resolution (D4) runs FIRST: the identity column participates in the
  // binding set, so every derived state (bindings, ignored columns, segments,
  // contiguity) is computed from the FINAL binding set. An explicit
  // identityFrom column binds the primary-key field even when its header
  // name differs from the property name.
  const explicitIdentity = input.identityFrom !== undefined && input.identityFrom !== "auto"
    ? input.identityFrom
    : undefined;
  let pkSource: "existing-column" | "auto-generate";
  let pkColumnIndex: number | undefined;
  let pkHeader: string | undefined;

  if (explicitIdentity !== undefined) {
    const index = headerIndexByName.get(explicitIdentity);
    if (index === undefined || ambiguousNames.has(explicitIdentity)) {
      problems.push({
        severity: "error",
        code: "MISSING_IDENTITY_COLUMN",
        message: ambiguousNames.has(explicitIdentity)
          ? `identityFrom column "${explicitIdentity}" is duplicated in tab "${tabName}"; the identity column must be unique.`
          : `identityFrom column "${explicitIdentity}" does not exist in tab "${tabName}".`,
        detail: { column: explicitIdentity },
      });
      pkSource = "auto-generate";
    } else {
      pkSource = "existing-column";
      pkColumnIndex = index;
      pkHeader = headers[index]!;
    }
  } else {
    // "auto": the PK property's column — via columnMap (§12) first, then the
    // exact name match (D2).
    const mapped = headerByField.get(primaryKey);
    if (mapped !== undefined) {
      pkSource = "existing-column";
      pkColumnIndex = mapped.index;
      pkHeader = headers[mapped.index]!;
    } else {
      const index = headerIndexByName.get(primaryKey);
      if (index !== undefined && !ambiguousNames.has(primaryKey)) {
        pkSource = "existing-column";
        pkColumnIndex = index;
        pkHeader = headers[index]!;
      } else {
        pkSource = "auto-generate";
        problems.push({
          severity: "warning",
          code: "NO_PK_CANDIDATE",
          message: `No column matches the primary key "${primaryKey}". Adoption will append a generated PK column.`,
          detail: { primaryKey },
        });
      }
    }
  }

  const bindings: ExistingSheetAdoptionColumnBinding[] = [];
  const missingFields: string[] = [];
  const generatedPk = pkSource === "auto-generate";
  for (const field of fields) {
    if (generatedPk && field === primaryKey) {
      // The appended PK column resolves the primary field (D4); it is not a
      // binding gap.
      continue;
    }
    if (field === primaryKey && pkColumnIndex !== undefined) {
      const mapped = headerByField.get(field);
      bindings.push({
        field,
        columnIndex: pkColumnIndex,
        columnLetter: columnLetters(pkColumnIndex + 1),
        header: pkHeader!,
        ...(mapped === undefined ? {} : { mappedFromHeader: mapped.header }),
      });
      continue;
    }
    const mapped = headerByField.get(field);
    if (mapped !== undefined) {
      // columnMap binding (§12): explicit header → property. Precedence over
      // name matching; the report carries the mapped-from header so consumers
      // (and the exact-header gate) know the sheet's real header.
      bindings.push({
        field,
        columnIndex: mapped.index,
        columnLetter: columnLetters(mapped.index + 1),
        header: headers[mapped.index]!,
        mappedFromHeader: mapped.header,
      });
      continue;
    }
    const index = headerIndexByName.get(field);
    const property = propertyByName.get(field);
    if (index === undefined || property === undefined || ambiguousNames.has(field)) {
      missingFields.push(field);
      continue;
    }
    bindings.push({
      field,
      columnIndex: index,
      columnLetter: columnLetters(index + 1),
      header: headers[index]!,
    });
  }
  bindings.sort((a, b) => a.columnIndex - b.columnIndex);

  // Derived state is computed from the FINAL binding set, so a custom
  // identity column is never simultaneously bound and ignored.
  const boundIndices = new Set(bindings.map((binding) => binding.columnIndex));
  const ignoredColumns = headers
    .map((header, index) => ({ header, columnLetter: columnLetters(index + 1), index }))
    .filter((column) => !boundIndices.has(column.index))
    .map(({ header, columnLetter }) => ({ columnLetter, header }));

  // Contiguity (D3): contiguous bindings keep the single bulk write path;
  // otherwise writes must be segmented per column run.
  const sortedIndices = [...boundIndices].sort((a, b) => a - b);
  const segments: ExistingSheetAdoptionColumnSegment[] = [];
  for (const index of sortedIndices) {
    const last = segments.at(-1);
    if (last !== undefined && index === last.endColumnIndex + 1) {
      segments[segments.length - 1] = { startColumnIndex: last.startColumnIndex, endColumnIndex: index };
    } else {
      segments.push({ startColumnIndex: index, endColumnIndex: index });
    }
  }
  const contiguity: "contiguous" | "segmented" = segments.length <= 1 ? "contiguous" : "segmented";

  // Identity duplicate / empty analysis on the resolved PK column.
  const duplicates: { value: string; rowNumbers: number[] }[] = [];
  const emptyIdentityRows: number[] = [];
  if (pkColumnIndex !== undefined) {
    const byValue = new Map<string, number[]>();
    rows.forEach((row, rowIndex) => {
      if (isEmptyRow(row)) return;
      const value = row[pkColumnIndex!]?.trim() ?? "";
      if (value === "") {
        emptyIdentityRows.push(rowIndex + 2); // 1-based, below the header row
        return;
      }
      const seen = byValue.get(value);
      if (seen === undefined) byValue.set(value, [rowIndex + 2]);
      else seen.push(rowIndex + 2);
    });
    for (const [value, rowNumbers] of byValue) {
      if (rowNumbers.length > 1) duplicates.push({ value, rowNumbers });
    }
    if (duplicates.length > 0) {
      problems.push({
        severity: "error",
        code: "DUPLICATE_IDENTITY_VALUE",
        message: `${duplicates.length} duplicated identity value(s) in column "${pkHeader ?? ""}".`,
        detail: { duplicates: duplicates.slice(0, 20).map((d) => d.value) },
      });
    }
    if (emptyIdentityRows.length > 0) {
      problems.push({
        severity: "error",
        code: "EMPTY_IDENTITY_VALUE",
        message: `${emptyIdentityRows.length} row(s) have an empty identity value.`,
        detail: { rowNumbers: emptyIdentityRows.slice(0, 50) },
      });
    }
  }

  // Missing-field classification (D2). When the PK is auto-generated (D4),
  // the appended PK column resolves the primary field, so it is not a gap.
  for (const field of missingFields) {
    if (generatedPk && field === primaryKey) continue;
    const property = propertyByName.get(field);
    const severity = property === undefined || property.primary || !property.nullable
      ? "error"
      : "warning";
    problems.push({
      severity,
      code: "MISSING_FIELD",
      message: `Entity field "${field}" has no matching column in tab "${tabName}".`,
      detail: { field },
    });
  }

  const hasErrors = problems.some((problem) => problem.severity === "error");
  const columnsToBeAdded = ["__hikoutei_row_id"];
  if (pkSource === "auto-generate") columnsToBeAdded.push(primaryKey);

  return {
    entityName,
    tabName,
    status: hasErrors ? "blocked" : "ready",
    sheetHeaders: [...headers],
    totalRows: rows.length,
    emptyRows: rows.filter(isEmptyRow).length,
    bindings,
    ignoredColumns: headers
      .map((header, index) => ({ header, columnLetter: columnLetters(index + 1) }))
      .filter((_, index) => !boundIndices.has(index)),
    missingFields,
    contiguity,
    segments,
    pk: {
      source: pkSource,
      ...(pkHeader === undefined ? {} : { column: pkHeader }),
      ...(pkSource === "auto-generate" ? { generatedCount: rows.filter((row) => !isEmptyRow(row)).length } : {}),
      ...(duplicates.length > 0 ? { duplicates } : {}),
    },
    columnsToBeAdded,
    tabsToProvision: [input.systemStateTabName, input.syncConflictsTabName],
    problems,
  };
}

/** One managed column of the adopted User_Input tab. */
export interface ExistingSheetAdoptionManagedColumn {
  readonly field: string;
  readonly columnIndex: number;
  readonly header: string;
}

/** Computed layout for one adopted entity (adopt mode). */
export interface ExistingSheetAdoptionLayout {
  readonly entityName: string;
  readonly tabName: string;
  readonly managedColumns: readonly ExistingSheetAdoptionManagedColumn[];
  /** The `__hikoutei_row_id` system column (last managed column + 1). */
  readonly rowIdColumnIndex: number;
  /** The PK column (existing within the span, or the appended one). */
  readonly pkColumnIndex: number;
  readonly pkGenerated: boolean;
  /** The PK column's header (existing header text, or the PK property name when generated). */
  readonly pkHeader: string;
  /** Registered range override for the User_Input route, e.g. `B:F`. */
  readonly registeredRange: string;
  /** Columns appended by adoption: row-id, and the PK when generated. */
  readonly appendedColumns: readonly { readonly columnIndex: number; readonly header: string }[];
}

/** Extracts the adopt-mode layout from the dry-run report + snapshot. */
export function computeExistingSheetAdoptionLayout(input: {
  readonly entityName: string;
  readonly tabName: string;
  readonly report: ExistingSheetAdoptionEntityReport;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly (string | undefined)[])[];
  readonly descriptor: { readonly properties: readonly { readonly name: string; readonly primary: boolean }[] };
  readonly userOwnedFields: readonly string[];
}): { readonly layout: ExistingSheetAdoptionLayout; readonly extraProblems: readonly ExistingSheetAdoptionProblem[] } {
  const { report } = input;
  const extraProblems: ExistingSheetAdoptionProblem[] = [];
  const managed = [...report.bindings].sort((a, b) => a.columnIndex - b.columnIndex);
  if (managed.length === 0) {
    extraProblems.push({
      severity: "error",
      code: "NO_BOUND_COLUMNS",
      message: `adoption layout for "${input.entityName}" has no bound columns.`,
    });
    return {
      layout: {
        entityName: input.entityName,
        tabName: input.tabName,
        managedColumns: [],
        rowIdColumnIndex: input.headers.length,
        pkColumnIndex: input.headers.length,
        pkGenerated: report.pk.source === "auto-generate",
        pkHeader: input.descriptor.properties.find((property) => property.primary)!.name,
        registeredRange: `A:${columnLetters(input.headers.length + 1)}`,
        appendedColumns: [],
      },
      extraProblems,
    };
  }
  const firstManaged = managed[0]!.columnIndex;
  const lastManaged = managed.at(-1)!.columnIndex;
  if (report.contiguity === "segmented") {
    extraProblems.push({
      severity: "error",
      code: "COLUMN_SEGMENTATION",
      message: `adoption (MVP) requires the managed columns of tab "${input.tabName}" to be contiguous; ignored columns must sit left of the managed block. Move them and retry.`,
      detail: { segments: report.segments.map((segment) => `${columnLetters(segment.startColumnIndex + 1)}:${columnLetters(segment.endColumnIndex + 1)}`) },
    });
  }

  const pkProperty = input.descriptor.properties.find((property) => property.primary)!.name;
  const pkGenerated = report.pk.source === "auto-generate";
  // The generated PK column is appended right after the managed span; the
  // row-id column follows it (or directly follows the managed span when the
  // PK column already exists). Both appended columns must be free: an
  // occupant would mean an ignored column gets overwritten.
  const pkColumnIndex = pkGenerated
    ? lastManaged + 1
    : managed.find((column) => column.field === pkProperty)!.columnIndex;
  const rowIdColumnIndex = pkGenerated ? pkColumnIndex + 1 : lastManaged + 1;
  const appendedColumns = [
    ...(pkGenerated ? [{ columnIndex: pkColumnIndex, header: pkProperty }] : []),
    { columnIndex: rowIdColumnIndex, header: "__hikoutei_row_id" },
  ];
  for (const column of appendedColumns) {
    const occupant = input.headers[column.columnIndex]?.trim();
    // Idempotent retry: a header that already IS the expected system header
    // means a previous adoption attempt wrote it — treat the column as
    // already applied. Its data cells (row ids / generated PK values) were
    // written too, so they are expected and must not block the retry.
    if (occupant === column.header) continue;
    if (occupant !== undefined && occupant !== "") {
      extraProblems.push({
        severity: "error",
        code: "COLUMN_OCCUPIED",
        message: `adoption column "${column.header}" (column ${columnLetters(column.columnIndex + 1)}) must be free, but tab "${input.tabName}" has "${occupant}" there.`,
        detail: { column: column.header, occupant },
      });
      continue;
    }
    // A blank header does NOT make the column free: applyAdoptionSystemColumns
    // would overwrite any data sitting below it. Every data cell at the
    // appended index must be empty.
    const dataRowNumbers: number[] = [];
    input.rows.forEach((row, rowIndex) => {
      const cell = row[column.columnIndex];
      if (cell !== undefined && cell !== "") dataRowNumbers.push(rowIndex + 2);
    });
    if (dataRowNumbers.length > 0) {
      extraProblems.push({
        severity: "error",
        code: "COLUMN_OCCUPIED",
        message: `adoption column "${column.header}" (column ${columnLetters(column.columnIndex + 1)}) must be free, but tab "${input.tabName}" has data below an empty header at row(s) ${dataRowNumbers.slice(0, 20).join(",")}.`,
        detail: { column: column.header, rowNumbers: dataRowNumbers.slice(0, 50) },
      });
    }
  }

  // Declaration-order check: the sheet's managed headers, read left to
  // right, must equal the projection header order — the User_Input
  // machinery is positional over the registered range. A generated PK is
  // appended last, so it must be declared last among the user-owned fields.
  const declaredUserOwned = input.descriptor.properties
    .filter((property) => input.userOwnedFields.includes(property.name))
    .map((property) => property.name);
  const expectedSheetOrder = pkGenerated
    ? [...declaredUserOwned.filter((name) => name !== pkProperty), pkProperty]
    : declaredUserOwned;
  const sheetManagedOrder = managed.map((column) => column.field);
  // A generated PK is NOT a sheet column yet: the analyzer deliberately omits
  // it from the bindings, so it must join the comparison as the VIRTUAL
  // appended column after all bound managed columns — otherwise the order
  // could never match and generated-PK adoption would be blocked forever.
  const comparedSheetOrder = pkGenerated
    ? [...sheetManagedOrder, pkProperty]
    : sheetManagedOrder;
  if (comparedSheetOrder.join("\u0000") !== expectedSheetOrder.join("\u0000")) {
    extraProblems.push({
      severity: "error",
      code: "DECLARATION_ORDER_MISMATCH",
      message: `adoption (MVP) requires tab "${input.tabName}" columns in the entity's declaration order. Expected [${expectedSheetOrder.join(", ")}] but found [${comparedSheetOrder.join(", ")}]. Reorder the entity properties (or the columns) and retry.`,
      detail: { expected: expectedSheetOrder, found: comparedSheetOrder },
    });
  }

  return {
    layout: {
      entityName: input.entityName,
      tabName: input.tabName,
      managedColumns: managed.map((column) => ({ field: column.field, columnIndex: column.columnIndex, header: column.header })),
      rowIdColumnIndex,
      pkColumnIndex,
      pkGenerated,
      pkHeader: pkGenerated ? pkProperty : report.pk.column ?? "",
      registeredRange: `${columnLetters(firstManaged + 1)}:${columnLetters(rowIdColumnIndex + 1)}`,
      appendedColumns,
    },
    extraProblems,
  };
}


export interface ExistingSheetAdoptionStartupPlanEntity {
  readonly entityName: string;
  readonly tabName: string;
  readonly entityTableName: string;
  readonly sheetId: number;
  readonly tabTitle: string;
  readonly layout: ExistingSheetAdoptionLayout;
  readonly rowIdColumnIndex: number;
  readonly pkAppend?: { readonly columnIndex: number; readonly header: string };
  readonly dataRows: readonly { readonly rowIndex: number; readonly pkValue: string }[];
}

export interface ExistingSheetAdoptionStartupPlan {
  readonly report: ExistingSheetAdoptionRunReport;
  readonly entities: readonly ExistingSheetAdoptionStartupPlanEntity[];
}

/**
 * §12 columnMap: attaches the adopted route's PHYSICAL header row (the
 * legacy headers) to the matching projection definition, positionally
 * parallel to the canonical field-name headers. The alignment holds by
 * construction: the C4 declaration-order gate forces the managed column
 * order to equal the field declaration order, and an appended generated-PK
 * column carries the property name itself as its header (no translation).
 * Provisioning, observation, and the writer read this single source —
 * three-way drift is structurally impossible.
 */
export function withAdoptedPhysicalHeaders(
  definitions: readonly RegisteredSyncProjectionDefinition[],
  plan: ExistingSheetAdoptionStartupPlan,
): readonly RegisteredSyncProjectionDefinition[] {
  const physicalByTab = new Map(
    plan.entities.map((entity) => [
      entity.tabTitle,
      new Map(entity.layout.managedColumns.map((column) => [column.field, column.header])),
    ]),
  );
  return definitions.map((definition) => {
    const byField = physicalByTab.get(definition.sheet.tabName);
    if (byField === undefined || definition.sheet.projection !== "user_input") {
      return definition;
    }
    return {
      ...definition,
      // An unbound user-owned field can only be the appended generated PK,
      // whose column header IS the property name (no translation).
      physicalHeaders: definition.headers.map((field) => byField.get(field) ?? field),
    };
  });
}

/**
 * Plans the adoption startup (D5). Reads the foreign tab, runs the pure
 * analysis, and computes the layout — BEFORE any provisioning mutation:
 *
 * - `dry-run`: always throws {@link ExistingSheetAdoptionDryRunReportError}
 *   carrying the full report; the spreadsheet is untouched and the service
 *   never starts.
 * - `adopt`: a blocked report throws the same error; a ready report returns
 *   the startup plan (layout, appended columns, data rows) for the
 *   bootstrap's seeding phase.
 */
export async function planExistingSheetAdoptionStartup(input: {
  readonly adopt: ExistingSheetAdoptionSpec;
  readonly spreadsheetId: string;
  readonly transport: GoogleSheetsApiAdoptionReader;
  readonly descriptors: readonly ResolvedHikouteiEntityDescriptor[];
  readonly projections: InternalSyncProjectionConfig;
  readonly userOwnedFieldsByEntity: Readonly<Record<string, readonly string[]>>;
  readonly requestTimeoutMs?: number;
}): Promise<ExistingSheetAdoptionStartupPlan> {
  const descriptorByName = new Map(input.descriptors.map((descriptor) => [descriptor.name, descriptor]));
  const entityReports: ExistingSheetAdoptionEntityReport[] = [];
  const planEntities: ExistingSheetAdoptionStartupPlanEntity[] = [];

  for (const [entityName, spec] of Object.entries(input.adopt.entities)) {
    const descriptor = descriptorByName.get(entityName);
    if (descriptor === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        `adopt spec references unknown entity "${entityName}".`,
      );
    }
    const userInputRoute = input.projections.entities[entityName]?.userInput;
    if (userInputRoute === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        `adopt spec for entity "${entityName}" requires a userInput projection route (the existing tab becomes the User_Input route).`,
      );
    }
    if (spec.tabName !== userInputRoute.tabName) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        `adopt tabName "${spec.tabName}" must equal the userInput projection tab "${userInputRoute.tabName}" for entity "${entityName}".`,
      );
    }

    const tab = await resolveAdoptionTab(input.transport, input.spreadsheetId, spec.tabName, input.requestTimeoutMs);
    if (tab === undefined) {
      entityReports.push(blockedMissingTabReport(entityName, spec.tabName));
      continue;
    }
    const valuesResponse = await input.transport.getValues({
      spreadsheetId: input.spreadsheetId,
      range: adoptionTabRange(tab.title, tab.columnCount),
      ...(input.requestTimeoutMs === undefined ? {} : { timeoutMs: input.requestTimeoutMs }),
    });
    const raw = valuesResponse.values ?? [];
    const headers = (raw[0] ?? []).map((cell) => String(cell ?? ""));
    const rows = raw.slice(1).map((row) => row.map((cell) => (cell === null ? undefined : String(cell))));

    const reportEntity = analyzeExistingSheetAdoptionEntity({
      entityName,
      tabName: tab.title,
      snapshot: { headers, rows },
      descriptor,
      userOwnedFields: input.userOwnedFieldsByEntity[entityName] ?? [],
      identityFrom: spec.identityFrom,
      columnMap: spec.columnMap,
      systemStateTabName: input.projections.entities[entityName]!.systemState.tabName,
      syncConflictsTabName: input.projections.entities[entityName]!.syncConflicts.tabName,
    });
    // Adopt-mode layout blockers (segmentation, declaration order,
    // occupied append columns) and exact-header mismatches surface in the
    // REPORT so dry-run and adopt agree on readiness — never "dry-run
    // ready, adopt rejected".
    // D4 (as amended by §12/C2): identityFrom aliases are absorbed by
    // columnMap — an alias is allowed when the map binds that header to the
    // PK property. Without a map the alias still blocks.
    const identityAliasAllowed = spec.identityFrom !== undefined
      && spec.columnMap !== undefined
      && spec.columnMap[spec.identityFrom] === descriptor.primaryKey;
    const identityAliasProblems: ExistingSheetAdoptionProblem[] = [];
    if (spec.identityFrom !== undefined && spec.identityFrom !== "auto" && spec.identityFrom !== descriptor.primaryKey && !identityAliasAllowed) {
      identityAliasProblems.push({
        severity: "error",
        code: "IDENTITY_ALIAS_UNSUPPORTED",
        message: `adoption (MVP) requires the primary-key header of tab "${tab.title}" to equal the PK property "${descriptor.primaryKey}"; identityFrom aliases ("${spec.identityFrom}") are not supported yet.`,
        detail: { identityFrom: spec.identityFrom, primaryKey: descriptor.primaryKey },
      });
    }
    let finalEntity = reportEntity;
    if (identityAliasProblems.length > 0) {
      finalEntity = {
        ...reportEntity,
        status: "blocked",
        problems: [...reportEntity.problems, ...identityAliasProblems],
      };
    }
    if (finalEntity.status === "ready") {
      const { layout, extraProblems } = computeExistingSheetAdoptionLayout({
        entityName,
        tabName: tab.title,
        report: reportEntity,
        headers,
        rows,
        descriptor,
        userOwnedFields: input.userOwnedFieldsByEntity[entityName] ?? [],
      });
      const exactHeaderProblems: ExistingSheetAdoptionProblem[] = [];
      for (const binding of reportEntity.bindings) {
        // §12/C2: a columnMap-bound column's exact-header expectation is the
        // MAP KEY (the sheet's real header), not the property name.
        const expectedHeader = binding.mappedFromHeader ?? binding.field;
        if (binding.header !== expectedHeader) {
          exactHeaderProblems.push({
            severity: "error",
            code: "EXACT_HEADER_MISMATCH",
            message: `adoption (MVP) requires the header of column ${binding.columnLetter} to be exactly "${expectedHeader}", but tab "${tab.title}" has "${binding.header}".`,
            detail: { column: binding.columnLetter, header: binding.header, field: binding.field },
          });
        }
      }
      const layoutErrors = [
        ...extraProblems,
        ...exactHeaderProblems,
      ].filter((problem) => problem.severity === "error");
      if (layoutErrors.length > 0) {
        finalEntity = {
          ...reportEntity,
          status: "blocked",
          problems: [...reportEntity.problems, ...layoutErrors],
        };
      } else {
        const pkColumnIndex = reportEntity.pk.source === "existing-column" && reportEntity.pk.column !== undefined
          ? headers.indexOf(reportEntity.pk.column)
          : layout.pkColumnIndex;
        const dataRows: { rowIndex: number; pkValue: string }[] = [];
        rows.forEach((row, index) => {
          if (row.every((cell) => cell === undefined || cell === "")) return;
          const existing = pkColumnIndex >= 0 ? row[pkColumnIndex]?.trim() : undefined;
          dataRows.push({
            rowIndex: index + 1, // 0-based sheet row (header is row 0)
            pkValue: existing !== undefined && existing !== "" ? existing : `adopt_${randomUUID()}`,
          });
        });
        planEntities.push({
          entityName,
          tabName: tab.title,
          entityTableName: descriptor.tableName,
          sheetId: tab.sheetId,
          tabTitle: tab.title,
          layout,
          rowIdColumnIndex: layout.rowIdColumnIndex,
          ...(layout.pkGenerated
            ? { pkAppend: { columnIndex: layout.pkColumnIndex, header: descriptor.primaryKey } }
            : {}),
          dataRows,
        });
      }
    }
    entityReports.push(finalEntity);
  }

  const report: ExistingSheetAdoptionRunReport = {
    mode: "dry-run",
    ok: entityReports.every((entityReport) => entityReport.status === "ready"),
    entities: entityReports,
  };
  if (!report.ok || planEntities.length === 0) {
    throw new ExistingSheetAdoptionDryRunReportError(
      report,
      "existing-sheet adoption found blocking problems; nothing was mutated and no supervisor was started.",
    );
  }
  if (input.adopt.mode === "dry-run") {
    throw new ExistingSheetAdoptionDryRunReportError(
      report,
      "existing-sheet adoption dry-run passed; no supervisors were started and the spreadsheet was not mutated.",
    );
  }
  return { report, entities: planEntities };
}


/** Minimal reader surface the adoption startup needs (satisfied by the real transport). */
export interface GoogleSheetsApiAdoptionReader {
  getSpreadsheet(request: {
    readonly spreadsheetId: string;
    readonly ranges: readonly string[];
    readonly fields: string;
    readonly timeoutMs?: number;
  }): Promise<unknown>;
  getValues(request: {
    readonly spreadsheetId: string;
    readonly range: string;
    readonly timeoutMs?: number;
  }): Promise<{ readonly values?: readonly (readonly (string | number | boolean | null)[])[] }>;
  batchUpdate(request: {
    readonly spreadsheetId: string;
    readonly requests: readonly unknown[];
  }): Promise<unknown>;
}

/**
 * Builds the full-tab read range for one foreign tab: the A1-quoted tab
 * name (embedded single quotes doubled) plus the grid-derived end column,
 * so tabs wider than the historical ZZ hard cap are read in full.
 */
export function adoptionTabRange(tabTitle: string, columnCount: number): string {
  const end = columnCount > 0 ? columnLetters(columnCount) : "A";
  return `${quoteA1SheetName(tabTitle)}!A1:${end}`;
}

/**
 * Resolves the foreign tab by case-insensitive title and returns its exact
 * title plus the grid column count (the full supported width, no hard cap).
 * Returns `undefined` when the tab does not exist.
 */
async function resolveAdoptionTab(
  transport: GoogleSheetsApiAdoptionReader,
  spreadsheetId: string,
  tabName: string,
  timeoutMs: number | undefined,
): Promise<{ readonly title: string; readonly sheetId: number; readonly columnCount: number } | undefined> {
  const response = await transport.getSpreadsheet({
    spreadsheetId,
    ranges: [],
    fields: "sheets.properties(sheetId,title,gridProperties.columnCount)",
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }) as {
    sheets?: readonly {
      properties?: {
        sheetId?: number;
        title?: string;
        gridProperties?: { columnCount?: number }
      }
    }[]
  } | undefined;
  const wanted = tabName.trim().toLowerCase();
  const match = (response?.sheets ?? [])
    .map((sheet) => ({
      title: sheet.properties?.title ?? "",
      sheetId: sheet.properties?.sheetId,
      columnCount: sheet.properties?.gridProperties?.columnCount,
    }))
    .find((sheet) => sheet.title.trim().toLowerCase() === wanted);
  if (match === undefined || typeof match.sheetId !== "number") return undefined;
  return {
    title: match.title,
    sheetId: match.sheetId,
    // A foreign tab can exceed the API's grid defaults; a missing count falls
    // back to the historical 26-column window the reader previously used.
    columnCount: match.columnCount ?? 26,
  };
}

function blockedMissingTabReport(
  entityName: string,
  tabName: string,
): ExistingSheetAdoptionEntityReport {
  return {
    entityName,
    tabName,
    status: "blocked",
    sheetHeaders: [],
    totalRows: 0,
    emptyRows: 0,
    bindings: [],
    ignoredColumns: [],
    missingFields: [],
    contiguity: "contiguous",
    segments: [],
    pk: { source: "auto-generate" },
    columnsToBeAdded: ["__hikoutei_row_id"],
    tabsToProvision: [],
    problems: [{
      severity: "error",
      code: "TAB_NOT_FOUND",
      message: `Tab "${tabName}" does not exist in the spreadsheet.`,
      detail: { tabName },
    }],
  };
}

/**
 * Resolves the transport the adoption reader uses. Prefers the injected
 * transport when it exposes the raw `getValues` capability; otherwise builds
 * the real ADC-backed HTTP transport via the composition root (dry-run reads
 * a genuinely foreign tab, so no route registration exists yet). Injected
 * transports without the capability fail closed with a stable message
 * instead of guessing.
 *
 * P8-C: the concrete `GoogleSheetsApiHttpTransport` construction is
 * composition-owned wiring (`ports.createAdoptionReaderTransport`); the
 * capability validation stays engine-owned exactly as before.
 */
export function resolveAdoptionReaderTransport(
  options: GoogleSheetsApiProviderOptions | undefined,
  createTransport: (
    providerOptions: GoogleSheetsApiProviderOptions | undefined,
  ) => GoogleSheetsApiAdoptionReader,
): GoogleSheetsApiAdoptionReader {
  const injected = options?.transport;
  if (injected !== undefined) {
    const candidate = injected as GoogleSheetsApiTransport & Partial<GoogleSheetsApiAdoptionReader>;
    if (typeof candidate.getValues !== "function") {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
        "existing-sheet adoption dry-run requires a transport implementing getValues (raw spreadsheets.values.get).",
      );
    }
    return candidate as unknown as GoogleSheetsApiAdoptionReader;
  }
  return createTransport(options);
}

/** Replaces the adopted entities' declared User_Input range with the derived one. */
export function withAdoptionRegisteredRangeOverride(
  projections: InternalSyncProjectionConfig,
  plan: ExistingSheetAdoptionStartupPlan,
): InternalSyncProjectionConfig {
  const entities = { ...projections.entities };
  for (const entity of plan.entities) {
    const config = entities[entity.entityName];
    if (config?.userInput === undefined) continue;
    entities[entity.entityName] = {
      ...config,
      userInput: { ...config.userInput, registeredRange: entity.layout.registeredRange },
    };
  }
  return { ...projections, entities };
}

interface InternalSyncProjectionConfigLike {
  readonly spreadsheetId: string;
  readonly entities: Readonly<Record<string, {
    readonly systemState: { readonly tabName: string };
    readonly syncConflicts: { readonly tabName: string };
    readonly userInput?: { readonly tabName: string; readonly registeredRange: string };
    readonly userOwnedFields?: readonly string[];
  }>>;
}
