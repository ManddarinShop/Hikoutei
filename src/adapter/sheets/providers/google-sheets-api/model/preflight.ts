/**
 * Bulk preflight: a sheet enumeration call plus one bounded data read of the
 * target tab and receipt tab.
 *
 * The provider first enumerates every tab (no ranges, so hidden sheets are
 * returned), then reads the target grid (values, date formats, row-level
 * developer-metadata anchors) and the hidden receipt tab through the narrow
 * transport. Every untrusted SDK payload is validated with runtime guards
 * and promoted into a typed context the planner can mutate. Any drift —
 * header changes, duplicate anchors or identities, malformed receipts,
 * invalid cells — fails closed before a single mutation request is built.
 *
 * The enumeration and the data read are separate functions so the provider
 * can pace and report each transport request individually; the composite
 * `readPreflightContext` keeps the two-call sequence for non-pacing callers.
 *
 * This module is a barrel over the focused preflight modules:
 *
 * - `preflightFields` — the `GOOGLE_SHEETS_API_*_FIELDS` field masks
 * - `preflightParsing` — untrusted SDK response guards
 * - `preflightHeaders` — registered header validation
 * - `preflightRows` — row normalization, indexes, and sheet/grid lookup
 * - `preflightContext` — typed context types and context assembly
 *
 * The barrel keeps the historical import surface (`./preflight.js`) intact;
 * the additional exports of the split modules (parsing cell helpers, internal
 * sheet/grid lookup) are intentionally not re-exported here.
 */

export {
  GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
  GOOGLE_SHEETS_API_ENUMERATION_FIELDS,
  GOOGLE_SHEETS_API_PROVISION_ENUMERATION_FIELDS,
  GOOGLE_SHEETS_API_PROVISION_FIELDS,
  GOOGLE_SHEETS_API_VALUES_FIELDS,
  GOOGLE_SHEETS_API_OBSERVATION_FIELDS,
  GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS,
} from "./preflightFields.js";
export type {
  ParsedMergedCell,
  PreflightReceipt,
  PreflightRow,
  PreflightContext,
  PreflightRouteOptions,
  ParsedSheet,
  ParsedGridData,
  ParsedRowData,
  ParsedRowMetadata,
  ParsedCellNumberFormat,
} from "./preflightContext.js";
export {
  enumerateSheetProperties,
  readPreflightContext,
  readPreflightData,
  readReceipts,
} from "./preflightContext.js";
export {
  parseSpreadsheetDocument,
  parseSheetPropertiesDocument,
} from "./preflightParsing.js";
export {
  requireGridDataByTitle,
  readAnchorIndex,
  gridRowCells,
  apiCellNumberFormat,
} from "./preflightRows.js";
export {
  readRegisteredHeaders,
  gridHeaderCells,
} from "./preflightHeaders.js";
