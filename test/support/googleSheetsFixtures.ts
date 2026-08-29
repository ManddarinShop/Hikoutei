/**
 * Shared fixtures for the Google Sheets API provider test family
 * (`google-sheets-api-*.test.ts`, `env-sync-autostart`, and the
 * provider-response-classification suite).
 */

/**
 * The three _System tab headers the sync worker manages: the business `id`
 * key, the delivery `status`, and the soft-delete sentinel column.
 */
export const SYSTEM_HEADERS = ["id", "status", "__typed_sheets_deleted"] as const;