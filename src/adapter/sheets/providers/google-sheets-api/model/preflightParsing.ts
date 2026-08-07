/**
 * Runtime guards that promote untrusted `spreadsheets.get` payloads into
 * typed internal structures.
 *
 * Every SDK response arrives at this boundary as `unknown`; each parser
 * validates shape field by field and fails closed through
 * `invalidProviderState` before any planner, builder, or repository logic
 * runs. The exported cell-value helpers (`apiStringValue`/`apiNumberValue`)
 * are shared by the header and receipt readers.
 */

import { invalidProviderState } from "../errors.js";
import type {
  ParsedGridData,
  ParsedMergedCell,
  ParsedRowData,
  ParsedRowMetadata,
  ParsedSheet,
  ParsedSpreadsheetDocument,
} from "./preflightContext.js";

/** Promotes an untrusted `spreadsheets.get` body with runtime guards. */
export function parseSpreadsheetDocument(
  value: unknown,
  label: string,
): ParsedSpreadsheetDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidProviderState(`${label} response must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.sheets)) {
    invalidProviderState(`${label} response must contain a sheets array`);
  }
  const grids = new Map<number, ParsedGridData>();
  const sheets = record.sheets.map((entry, index) => {
    const sheet = parseSheetEntry(entry, `${label} sheets[${index}]`);
    // Grid data is nested under each sheet entry in the API response and is
    // identified by the parent sheet's properties.sheetId (GridData itself
    // carries no sheetId).
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
        (entry as Record<string, unknown>).data !== undefined) {
      parseGridDataArray(
        (entry as Record<string, unknown>).data,
        sheet.sheetId,
        `${label} sheets[${index}].data`,
        grids,
      );
    }
    return sheet;
  });
  return { sheets, grids };
}

/**
 * Promotes an enumeration-only `spreadsheets.get` body (sheet properties,
 * no grid data) with runtime guards.
 */
export function parseSheetPropertiesDocument(
  value: unknown,
  label: string,
): readonly ParsedSheet[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidProviderState(`${label} response must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.sheets)) {
    invalidProviderState(`${label} response must contain a sheets array`);
  }
  return record.sheets.map((entry, index) =>
    parseSheetEntry(entry, `${label} sheets[${index}]`),
  );
}

/** Validates one REST sheet entry's properties (sheetId, title, hidden). */
function parseSheetEntry(value: unknown, label: string): ParsedSheet {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidProviderState(`${label} must be an object`);
  }
  const sheet = value as Record<string, unknown>;
  const properties = sheet.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    invalidProviderState(`${label}.properties must be an object`);
  }
  const propertyRecord = properties as Record<string, unknown>;
  const sheetId = propertyRecord.sheetId;
  const title = propertyRecord.title;
  if (typeof sheetId !== "number" || !Number.isSafeInteger(sheetId)) {
    invalidProviderState(`${label}.properties.sheetId is invalid`);
  }
  if (typeof title !== "string" || title.length === 0) {
    invalidProviderState(`${label}.properties.title is invalid`);
  }
  const hidden = propertyRecord.hidden;
  if (hidden !== undefined && typeof hidden !== "boolean") {
    invalidProviderState(`${label}.properties.hidden is invalid`);
  }
  const gridProperties = propertyRecord.gridProperties;
  const grid = gridProperties === undefined
    ? undefined
    : (() => {
      if (gridProperties === null || typeof gridProperties !== "object" || Array.isArray(gridProperties)) {
        invalidProviderState(`${label}.properties.gridProperties is invalid`);
      }
      const gridRecord = gridProperties as Record<string, unknown>;
      return {
        rowCount: optionalPositiveInteger(gridRecord.rowCount, `${label}.properties.gridProperties.rowCount`),
        columnCount: optionalPositiveInteger(gridRecord.columnCount, `${label}.properties.gridProperties.columnCount`),
      };
    })();
  // Merged regions are a sheet-level `merges` GridRange array in the API
  // response (GridData carries no mergedCells field), requested only by the
  // observation mask; other masks omit the field entirely.
  const merges = parseMergedCells(sheet.merges, `${label}.merges`);
  return {
    sheetId,
    title,
    hidden: hidden === true,
    ...(grid === undefined ? {} : { gridProperties: grid }),
    ...(merges === undefined ? {} : { merges }),
  };
}

function optionalPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    invalidProviderState(`${label} is invalid`);
  }
  return value;
}

function parseGridDataArray(
  value: unknown,
  sheetId: number,
  label: string,
  grids: Map<number, ParsedGridData>,
): void {
  if (!Array.isArray(value)) {
    invalidProviderState(`${label} must be an array`);
  }
  if (grids.has(sheetId)) {
    invalidProviderState(`${label} contains a duplicate grid for one sheet`);
  }
  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      invalidProviderState(`${label}[${index}] must be an object`);
    }
    const data = entry as Record<string, unknown>;
    const startRow = optionalNonNegativeInteger(data.startRow, `${label}[${index}].startRow`);
    const startColumn = optionalNonNegativeInteger(
      data.startColumn,
      `${label}[${index}].startColumn`,
    );
    const rowData = parseRowData(data.rowData, `${label}[${index}].rowData`);
    const rowMetadata = parseRowMetadata(data.rowMetadata, `${label}[${index}].rowMetadata`);
    grids.set(sheetId, { startRow, startColumn, rowData, rowMetadata });
  });
}

/** Parses one sheet-level `merges` GridRange array with runtime guards. */
function parseMergedCells(
  value: unknown,
  label: string,
): readonly ParsedMergedCell[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalidProviderState(`${label} must be an array`);
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      invalidProviderState(`${label}[${index}] must be an object`);
    }
    const range = entry as Record<string, unknown>;
    const startRowIndex = optionalNonNegativeInteger(
      range.startRowIndex,
      `${label}[${index}].startRowIndex`,
    );
    const endRowIndex = optionalNonNegativeInteger(
      range.endRowIndex,
      `${label}[${index}].endRowIndex`,
    );
    const startColumnIndex = optionalNonNegativeInteger(
      range.startColumnIndex,
      `${label}[${index}].startColumnIndex`,
    );
    const endColumnIndex = optionalNonNegativeInteger(
      range.endColumnIndex,
      `${label}[${index}].endColumnIndex`,
    );
    if (endRowIndex <= startRowIndex || endColumnIndex <= startColumnIndex) {
      invalidProviderState(`${label}[${index}] is not a valid cell range`);
    }
    const sheetIdValue = range.sheetId;
    if (sheetIdValue !== undefined &&
        (typeof sheetIdValue !== "number" || !Number.isSafeInteger(sheetIdValue))) {
      invalidProviderState(`${label}[${index}].sheetId is invalid`);
    }
    return {
      ...(sheetIdValue === undefined ? {} : { sheetId: sheetIdValue }),
      startRowIndex,
      endRowIndex,
      startColumnIndex,
      endColumnIndex,
    };
  });
}

function parseRowData(value: unknown, label: string): readonly ParsedRowData[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidProviderState(`${label} must be an array`);
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      invalidProviderState(`${label}[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    if (row.values === undefined) return { values: [] };
    if (!Array.isArray(row.values)) {
      invalidProviderState(`${label}[${index}].values must be an array`);
    }
    return { values: row.values };
  });
}

function parseRowMetadata(value: unknown, label: string): readonly ParsedRowMetadata[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidProviderState(`${label} must be an array`);
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      invalidProviderState(`${label}[${index}] must be an object`);
    }
    const metadata = entry as Record<string, unknown>;
    if (metadata.developerMetadata === undefined) return { developerMetadata: [] };
    if (!Array.isArray(metadata.developerMetadata)) {
      invalidProviderState(`${label}[${index}].developerMetadata must be an array`);
    }
    return {
      developerMetadata: metadata.developerMetadata.map((item, itemIndex) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          invalidProviderState(
            `${label}[${index}].developerMetadata[${itemIndex}] must be an object`,
          );
        }
        const itemRecord = item as Record<string, unknown>;
        if (
          typeof itemRecord.metadataKey !== "string" ||
          itemRecord.metadataKey.length === 0
        ) {
          invalidProviderState(
            `${label}[${index}].developerMetadata[${itemIndex}].metadataKey is invalid`,
          );
        }
        if (
          itemRecord.metadataValue !== undefined &&
          typeof itemRecord.metadataValue !== "string"
        ) {
          invalidProviderState(
            `${label}[${index}].developerMetadata[${itemIndex}].metadataValue is invalid`,
          );
        }
        return {
          metadataKey: itemRecord.metadataKey,
          metadataValue: itemRecord.metadataValue === undefined ? "" : itemRecord.metadataValue,
        };
      }),
    };
  });
}

function optionalNonNegativeInteger(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidProviderState(`${label} is invalid`);
  }
  return value;
}

/** Reads the userEnteredValue.stringValue of one API cell with guards. */
export function apiStringValue(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const entered = record.userEnteredValue;
  if (entered === null || typeof entered !== "object") return undefined;
  const raw = (entered as Record<string, unknown>).stringValue;
  return typeof raw === "string" ? raw : undefined;
}

/** Reads the userEnteredValue.numberValue of one API cell with guards. */
export function apiNumberValue(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const entered = record.userEnteredValue;
  if (entered === null || typeof entered !== "object") return undefined;
  const raw = (entered as Record<string, unknown>).numberValue;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}
