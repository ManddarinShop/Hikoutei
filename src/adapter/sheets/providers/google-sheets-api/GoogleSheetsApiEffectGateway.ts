/**
 * @deprecated Outbound-only alias of {@link GoogleSheetsApiSyncProvider}.
 *
 * The direct Google Sheets provider is now the FULL sync provider: it owns
 * outbound effects, provisioning, table reads, anchors, and snapshots. The
 * old outbound-only name is kept as a deprecated alias so existing imports
 * and the deprecated mixed bootstrap mode keep compiling; new code should
 * construct {@link GoogleSheetsApiSyncProvider} (or use the
 * `googleSheetsApi` bootstrap option) directly.
 */

import {
  GoogleSheetsApiSyncProvider,
  type GoogleSheetsApiProviderOptions,
  type GoogleSheetsApiSyncProviderOptions,
} from "./GoogleSheetsApiSyncProvider.js";

/** @deprecated Use {@link GoogleSheetsApiSyncProvider} instead. */
export const GoogleSheetsApiEffectGateway = GoogleSheetsApiSyncProvider;

/** @deprecated Instance type of {@link GoogleSheetsApiSyncProvider}. */
export type GoogleSheetsApiEffectGateway = GoogleSheetsApiSyncProvider;

/**
 * @deprecated Use `GoogleSheetsApiProviderOptions` (the full provider's
 * bootstrap-facing options) instead.
 */
export type GoogleSheetsApiEffectGatewayOptions = GoogleSheetsApiProviderOptions;

/**
 * @deprecated Use `GoogleSheetsApiSyncProviderOptions` (the full provider's
 * construction options) instead.
 */
export type GoogleSheetsApiEffectGatewayConstructionOptions =
  GoogleSheetsApiSyncProviderOptions;

export type { GoogleSheetsApiRequestEvent } from "./GoogleSheetsApiSyncProvider.js";
