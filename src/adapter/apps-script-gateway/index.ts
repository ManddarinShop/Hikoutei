/** Signed adapter tools for the registry-bound Apps Script sync gateway. */

export {
  APPS_SCRIPT_OPERATION_NAMES,
} from "./constants.js";
export type { AppsScriptOperationName } from "./constants.js";

export {
  canonicalSyncJson,
  syncSha256Hex,
} from "./syncProtocol.js";
export type {
  SyncJsonValue,
} from "./syncProtocol.js";
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
} from "./codeGsProtocol.js";
export type {
  AppsScriptOperationWire,
  AppsScriptOperationPayload,
  AppsScriptOperationSigningFields,
  AppsScriptOperationEnvelope,
  CreateAppsScriptOperationEnvelopeOptions,
} from "./codeGsProtocol.js";
export { AppsScriptOperationClient } from "./operationClient.js";
export { createFastAppendRowsOperation } from "./fastAppendOperation.js";
export { createReadTableRowsOperation } from "./tableReadOperation.js";
export {
  createApplyEffectsOperation,
  createReadEffectPostconditionOperation,
  createReadEffectPostconditionsOperation,
} from "./effectOperation.js";
export {
  createEnsureRowAnchorsOperation,
  createObserveSnapshotOperation,
  createReadSnapshotOperation,
} from "./observationOperation.js";
export { AppsScriptOperationSyncGateway } from "./operationSyncGateway.js";
export type {
  AppsScriptOperationDefinition,
  AnyAppsScriptOperationDefinition,
  AppsScriptOperationGateway,
  AppsScriptOperationResult,
  AppsScriptOperationResults,
  AppsScriptOperationClientOptions,
  AppsScriptOperationRequestEvent,
} from "./operationClient.js";
export type {
  AppsScriptFastAppendOperationArgs,
  AppsScriptFastAppendOperationRequest,
  AppsScriptFastAppendOperation,
} from "./fastAppendOperation.js";
export type {
  AppsScriptApplyEffectsOperationArgs,
  AppsScriptApplyEffectsOperationRequest,
  AppsScriptReadEffectPostconditionOperationArgs,
  AppsScriptReadEffectPostconditionsOperationArgs,
} from "./effectOperation.js";
export type {
  AppsScriptEnsureRowAnchorsOperationArgs,
  AppsScriptObserveSnapshotOperationArgs,
  AppsScriptReadSnapshotOperationArgs,
} from "./observationOperation.js";
export type {
  AppsScriptReadTableRowsRequest,
} from "./tableReadOperation.js";
export type {
  AppsScriptOperationProjectionStatus,
  AppsScriptOperationSyncGatewayOptions,
} from "./operationSyncGateway.js";
