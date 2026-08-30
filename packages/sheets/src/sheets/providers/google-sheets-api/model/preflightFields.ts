/**
 * `spreadsheets.get` field masks used by the Google Sheets API provider.
 *
 * Each mask selects exactly the response fields one read path needs; keeping
 * the masks narrow bounds response size and parse cost. GridData has no
 * `sheetId` of its own; the parent sheet's `sheets.properties.sheetId`
 * identifies the grid. Row anchors are no longer developer metadata: they
 * live as cell values in the User_Input tab's last system column, so no mask
 * requests `rowMetadata.developerMetadata` anymore.
 */

/**
 * Preflight field mask: sheet identity plus grid values and formats.
 */
export const GOOGLE_SHEETS_API_PREFLIGHT_FIELDS = [
  "sheets.properties(sheetId,title,hidden),",
  "sheets.data(startRow,startColumn,",
  "rowData.values(userEnteredValue,userEnteredFormat.numberFormat,effectiveFormat.numberFormat))",
].join("");

/**
 * Enumeration field mask: sheet identity only.
 *
 * The enumeration call requests no ranges because a ranged
 * `spreadsheets.get` response only carries sheets intersecting the requested
 * ranges (hidden tabs included only when no ranges are given); the receipt
 * tab can therefore never be discovered from the ranged data call alone.
 */
export const GOOGLE_SHEETS_API_ENUMERATION_FIELDS =
  "sheets.properties(sheetId,title,hidden)";

/**
 * Provisioning enumeration mask: sheet identity plus grid dimensions.
 *
 * The grid dimensions let provisioning request the full used grid of an
 * existing tab (up to the sheet's actual last column) so "truly empty" is
 * judged against the whole tab, not just the registered range.
 */
export const GOOGLE_SHEETS_API_PROVISION_ENUMERATION_FIELDS =
  "sheets.properties(sheetId,title,hidden,gridProperties(rowCount,columnCount))";

/**
 * Provisioning data mask: values plus number formats for header checks.
 *
 * Anchors, merged ranges, and computed values are not needed to decide
 * whether an existing tab is empty or whether its header row matches.
 */
export const GOOGLE_SHEETS_API_PROVISION_FIELDS = [
  "sheets.properties(sheetId,title,hidden),",
  "sheets.data(startRow,startColumn,",
  "rowData.values(userEnteredValue,userEnteredFormat.numberFormat,effectiveFormat.numberFormat))",
].join("");

/**
 * Values-only table-read mask (getValues semantics).
 *
 * Includes computed values, formatted error strings, number formats, and
 * data-validation rules so formula cells resolve to their computed value,
 * error cells to their display string, and checkbox columns to their
 * blank/false rule.
 */
export const GOOGLE_SHEETS_API_VALUES_FIELDS = [
  "sheets.properties(sheetId,title,hidden),",
  "sheets.data(startRow,startColumn,",
  "rowData.values(userEnteredValue,effectiveValue,formattedValue,",
  "userEnteredFormat.numberFormat,effectiveFormat.numberFormat,dataValidation))",
].join("");

/**
 * Full observation mask: values, computed values, merged ranges.
 *
 * This is the metadata-preserving read used by snapshots and anchor
 * assignment. Merged regions live on the SHEET object as `sheets.merges`
 * (GridRange entries), NOT on GridData. Row anchors are cell values in the
 * User_Input tab's last column, so they arrive with `rowData.values`.
 */
export const GOOGLE_SHEETS_API_OBSERVATION_FIELDS = [
  "sheets.properties(sheetId,title,hidden),",
  "sheets.merges,",
  "sheets.data(startRow,startColumn,",
  "rowData.values(userEnteredValue,effectiveValue,formattedValue,",
  "userEnteredFormat.numberFormat,effectiveFormat.numberFormat,dataValidation))",
].join("");

/**
 * Lightweight observation mask: values and computed values only.
 *
 * Used by user_input polling reads, which never consult merged regions (the
 * lightweight branch has no merged map) or data-validation rules (the
 * checkbox-false blank rule comes from the checkboxHeaders config, not from
 * dataValidation). Keeping `sheets.merges` and `dataValidation` out of the
 * request makes the polling read cheaper.
 */
export const GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS = [
  "sheets.properties(sheetId,title,hidden),",
  "sheets.data(startRow,startColumn,",
  "rowData.values(userEnteredValue,effectiveValue,formattedValue,",
  "userEnteredFormat.numberFormat,effectiveFormat.numberFormat))",
].join("");
