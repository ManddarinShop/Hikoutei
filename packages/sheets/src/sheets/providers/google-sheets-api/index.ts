/**
 * Internal exports for the direct Google Sheets API provider.
 *
 * This module is intentionally NOT re-exported from `src/index.ts`: it is the
 * internal full sync provider used by the sync service bootstrap, not
 * application API.
 */

export { GoogleSheetsApiSyncProvider } from "./GoogleSheetsApiSyncProvider.js";
export type {
  GoogleSheetsApiSyncProviderOptions,
  GoogleSheetsApiProviderOptions,
  GoogleSheetsApiRequestEvent,
} from "./GoogleSheetsApiSyncProvider.js";
export {
  GoogleSheetsApiHttpTransport,
  classifyGoogleSheetsApiError,
  isRetryableTransportStatus,
} from "./transport/googleSheetsApiTransport.js";
export type {
  GoogleSheetsApiTransport,
  GoogleSheetsApiGetSpreadsheetRequest,
  GoogleSheetsApiBatchUpdateRequest,
  GoogleSheetsApiWriteRequest,
  GoogleSheetsApiCell,
  GoogleSheetsApiCellRow,
  GoogleSheetsApiHttpTransportOptions,
} from "./transport/googleSheetsApiTransport.js";
export { RequestStartLimiter } from "@hikoutei/ikisaki";
export {
  GOOGLE_SHEETS_API_DEFAULTS,
  GOOGLE_SHEETS_API_SCOPES,
} from "./constants.js";
export {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
} from "./errors.js";
export type { GoogleSheetsApiTransportErrorCode } from "./errors.js";
