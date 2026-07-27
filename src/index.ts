/**
 * Public surface for the SQLite-authoritative sync foundation.
 *
 * The SQLite-authoritative sync bootstrap is explicitly service-side: it uses
 * a secret-bearing Apps Script client and must never be bundled into a browser.
 */

export * from "./core/index.js";
export * from "./orm/index.js";
export * from "./storage/index.js";
export type {
  SqlExecutor,
  SqlGeneratedId,
  SqlMutationResult,
  SqlParameter,
  SqlStorageAdapter,
  SqlStorageContext,
} from "./adapter/orm/index.js";
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
} from "./adapter/apps-script-gateway/index.js";
export type {
  AppsScriptOperationDefinition,
  AnyAppsScriptOperationDefinition,
  AppsScriptOperationGateway,
  AppsScriptOperationResult,
  AppsScriptOperationResults,
  AppsScriptOperationClientOptions,
  AppsScriptOperationRequestEvent,
  AppsScriptOperationName,
} from "./adapter/apps-script-gateway/index.js";
export type {
  AppsScriptFastAppendOperationArgs,
  AppsScriptFastAppendOperationRequest,
  AppsScriptFastAppendOperation,
} from "./adapter/apps-script-gateway/index.js";
export type {
  AppsScriptApplyEffectsOperationArgs,
  AppsScriptApplyEffectsOperationRequest,
  AppsScriptReadEffectPostconditionOperationArgs,
  AppsScriptReadEffectPostconditionsOperationArgs,
} from "./adapter/apps-script-gateway/index.js";
export type {
  AppsScriptEnsureRowAnchorsOperationArgs,
  AppsScriptObserveSnapshotOperationArgs,
  AppsScriptReadSnapshotOperationArgs,
  AppsScriptReadTableRowsRequest,
} from "./adapter/apps-script-gateway/index.js";
export type {
  AppsScriptOperationProjectionStatus,
  AppsScriptOperationSyncGatewayOptions,
} from "./adapter/apps-script-gateway/index.js";
export { provisionRegisteredSyncSheets } from "./runtime/gateway/SyncGatewayBootstrap.js";
export {
  createSyncEffectWorkerSupervisor,
  SyncEffectWorkerSupervisor,
} from "./runtime/effects/SyncEffectSupervisor.js";
export type {
  CreateSyncEffectWorkerSupervisorOptions,
  SyncEffectWorkerSupervisorReconciliationOptions,
  SyncEffectWorkerSupervisorLoopOptions,
  SyncEffectWorkerSupervisorWait,
} from "./runtime/effects/SyncEffectSupervisor.js";
export {
  runReconciliationScan,
} from "./runtime/operations/ReconciliationScanner.js";
export type {
  ReconciliationIdFactory,
  ReconciliationScanReport,
  RunReconciliationScanOptions,
} from "./runtime/operations/ReconciliationScanner.js";
export type {
  RegisteredSyncProjectionDefinition,
  SyncGatewayProvisionRoute,
  SyncGatewayProvisioner,
} from "./runtime/gateway/SyncGatewayBootstrap.js";
export {
  pollSimpleSheetRowsWithAdapter,
  SIMPLE_POLL_INVALID_REASONS,
  SIMPLE_POLL_ROW_KINDS,
} from "./runtime/projection/SimpleSheetPolling.js";
export type {
  SimplePollChangedRow,
  SimplePollInvalidReason,
  SimplePollRowKind,
  SimpleSheetPollingResult,
  SimpleSheetTablePollingResult,
} from "./runtime/projection/SimpleSheetPolling.js";
export type {
  SplitSyncGatewayOptions,
  SyncObservedSnapshot,
  SyncSheetObservationBatchGateway,
  SyncEffectWorkerGateway,
  SyncEffectWorkerFullGateway,
  SyncSheetObservationGateway,
  SyncSheetGateway,
  ReadSyncTableRowsRequest,
  SyncSheetTableReaderGateway,
  SyncTableRow,
  SyncTableRowsResult,
} from "./runtime/gateway/syncGateway.js";
export {
  observeSyncSnapshot,
  observeSyncSnapshots,
  SplitSyncGateway,
} from "./runtime/gateway/syncGateway.js";
export { SYNC_GATEWAY_SNAPSHOT_READ_MODES } from "./runtime/gateway/constants.js";
export type { SyncGatewaySnapshotReadMode } from "./runtime/gateway/constants.js";
export {
  SYNC_TIMING_OPERATION_KINDS,
  SYNC_TIMING_SCOPES,
  emptySyncTimingOperationCounts,
} from "./runtime/telemetry/syncTiming.js";
export type {
  SyncGatewayTiming,
  SyncGatewayTimingPhase,
  SyncTimingEvent,
  SyncTimingOperationCounts,
  SyncTimingOperationKind,
  SyncTimingScope,
  SyncTimingSink,
} from "./runtime/telemetry/syncTiming.js";
