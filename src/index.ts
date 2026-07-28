/**
 * Public surface for the SQLite-authoritative sync foundation.
 *
 * The SQLite-authoritative sync bootstrap is explicitly service-side: it uses
 * a secret-bearing Apps Script client and must never be bundled into a browser.
 */

export * from "./domain/index.js";
export * from "./application/index.js";
export * from "./infrastructure/index.js";
export type {
  SqlExecutor,
  SqlGeneratedId,
  SqlMutationResult,
  SqlParameter,
  SqlStorageAdapter,
  SqlStorageContext,
} from "./adapter/persistence/index.js";
export {
  AppsScriptSyncGatewayError,
  APPS_SCRIPT_OPERATION_NAMES,
  AppsScriptOperationClient,
  createApplyEffectsOperation,
  createEnsureRowAnchorsOperation,
  createObserveSnapshotOperation,
  createFastAppendRowsOperation,
  createReadEffectPostconditionOperation,
  createReadEffectPostconditionsOperation,
  createReadSnapshotOperation,
  createReadTableRowsOperation,
  AppsScriptOperationSyncGateway,
} from "./adapter/sheets/providers/apps-script-gateway/index.js";
export type {
  AppsScriptOperationDefinition,
  AnyAppsScriptOperationDefinition,
  AppsScriptOperationGateway,
  AppsScriptOperationResult,
  AppsScriptOperationResults,
  AppsScriptOperationClientOptions,
  AppsScriptOperationRequestEvent,
  AppsScriptOperationName,
} from "./adapter/sheets/providers/apps-script-gateway/index.js";
export type {
  AppsScriptFastAppendOperationArgs,
  AppsScriptFastAppendOperationRequest,
  AppsScriptFastAppendOperation,
} from "./adapter/sheets/providers/apps-script-gateway/index.js";
export type {
  AppsScriptApplyEffectsOperationArgs,
  AppsScriptApplyEffectsOperationRequest,
  AppsScriptReadEffectPostconditionOperationArgs,
  AppsScriptReadEffectPostconditionsOperationArgs,
} from "./adapter/sheets/providers/apps-script-gateway/index.js";
export type {
  AppsScriptEnsureRowAnchorsOperationArgs,
  AppsScriptObserveSnapshotOperationArgs,
  AppsScriptReadSnapshotOperationArgs,
  AppsScriptReadTableRowsRequest,
} from "./adapter/sheets/providers/apps-script-gateway/index.js";
export type {
  AppsScriptOperationProjectionStatus,
  AppsScriptOperationSyncGatewayOptions,
} from "./adapter/sheets/providers/apps-script-gateway/index.js";
