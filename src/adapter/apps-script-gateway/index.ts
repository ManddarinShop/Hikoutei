/** Signed adapter tools for the registry-bound Apps Script sync gateway. */

export {
  APPS_SCRIPT_OPERATION_NAMES,
} from "./protocol/constants.js";
export type { AppsScriptOperationName } from "./protocol/constants.js";

export {
  canonicalSyncJson,
  syncSha256Hex,
} from "./protocol/syncProtocol.js";
export type {
  SyncJsonValue,
} from "./protocol/syncProtocol.js";
export {
  AppsScriptSyncGatewayError,
  SYNC_GATEWAY_CLIENT_ERROR_CODES,
} from "./errors.js";
export type { SyncGatewayClientErrorCode } from "./errors.js";
export {
  APPS_SCRIPT_OPERATION_PROTOCOL_VERSION,
  appsScriptOperationSigningInput,
  signAppsScriptOperationEnvelope,
  createAppsScriptOperationEnvelope,
} from "./protocol/codeGsProtocol.js";
export type {
  AppsScriptOperationWire,
  AppsScriptOperationPayload,
  AppsScriptOperationSigningFields,
  AppsScriptOperationEnvelope,
  CreateAppsScriptOperationEnvelopeOptions,
} from "./protocol/codeGsProtocol.js";
export { AppsScriptOperationClient } from "./transport/operationClient.js";
export { createFastAppendRowsOperation } from "./operations/fastAppendOperation.js";
export { createReadTableRowsOperation } from "./operations/tableReadOperation.js";
export {
  createApplyEffectsOperation,
  createReadEffectPostconditionOperation,
  createReadEffectPostconditionsOperation,
} from "./operations/effectOperation.js";
export {
  createEnsureRowAnchorsOperation,
  createObserveSnapshotOperation,
  createReadSnapshotOperation,
} from "./operations/observationOperation.js";
export { AppsScriptOperationSyncGateway } from "./transport/operationSyncGateway.js";
export type {
  AppsScriptOperationDefinition,
  AnyAppsScriptOperationDefinition,
  AppsScriptOperationGateway,
  AppsScriptOperationResult,
  AppsScriptOperationResults,
  AppsScriptOperationClientOptions,
  AppsScriptOperationRequestEvent,
} from "./transport/operationClient.js";
export type {
  AppsScriptFastAppendOperationArgs,
  AppsScriptFastAppendOperationRequest,
  AppsScriptFastAppendOperation,
} from "./operations/fastAppendOperation.js";
export type {
  AppsScriptApplyEffectsOperationArgs,
  AppsScriptApplyEffectsOperationRequest,
  AppsScriptReadEffectPostconditionOperationArgs,
  AppsScriptReadEffectPostconditionsOperationArgs,
} from "./operations/effectOperation.js";
export type {
  AppsScriptEnsureRowAnchorsOperationArgs,
  AppsScriptObserveSnapshotOperationArgs,
  AppsScriptReadSnapshotOperationArgs,
} from "./operations/observationOperation.js";
export type {
  AppsScriptReadTableRowsRequest,
} from "./operations/tableReadOperation.js";
export type {
  AppsScriptOperationProjectionStatus,
  AppsScriptOperationSyncGatewayOptions,
} from "./transport/operationSyncGateway.js";
