/** Thin-Gateway operations for normalized, ID-addressable Sheet snapshots. */

import type {
  ReadSyncSnapshotRequest,
  SyncObservedSnapshot,
  SyncGatewaySnapshot,
} from "../../../../../../application/sync/gateway/syncGateway.js";
import type { AppsScriptOperationDefinition } from "../../transport/operationClient.js";
import {
  decodeObservedSnapshot,
  decodeSnapshot,
  validateObservationRequest,
  type ObservationOperationRouteOptions,
} from "./observationOperationCodec.js";
import { OBSERVATION_OPERATION_SOURCE } from "./observationOperationScript.js";

const OBSERVATION_OPERATION_MODES = {
  READ_SNAPSHOT: "readSnapshot",
  OBSERVE_SNAPSHOT: "observeSnapshot",
} as const;

type ObservationOperationRequest = ReadSyncSnapshotRequest & ObservationOperationRouteOptions;

export type AppsScriptReadSnapshotOperationArgs = {
  readonly mode: typeof OBSERVATION_OPERATION_MODES.READ_SNAPSHOT;
} & ObservationOperationRequest;

export type AppsScriptObserveSnapshotOperationArgs = {
  readonly mode: typeof OBSERVATION_OPERATION_MODES.OBSERVE_SNAPSHOT;
} & ObservationOperationRequest;

/** Builds the normalized, read-only Sheet snapshot operation. */
export function createReadSnapshotOperation(
  request: ReadSyncSnapshotRequest & ObservationOperationRouteOptions,
): AppsScriptOperationDefinition<AppsScriptReadSnapshotOperationArgs, SyncGatewaySnapshot> {
  validateObservationRequest(request);
  return {
    fn: OBSERVATION_OPERATION_SOURCE,
    args: { mode: OBSERVATION_OPERATION_MODES.READ_SNAPSHOT, ...request },
    decode: decodeSnapshot,
  };
}

/** Builds one operation that observes a snapshot under one lock. */
export function createObserveSnapshotOperation(
  request: ReadSyncSnapshotRequest & ObservationOperationRouteOptions,
): AppsScriptOperationDefinition<
  AppsScriptObserveSnapshotOperationArgs,
  SyncObservedSnapshot
> {
  validateObservationRequest(request);
  return {
    fn: OBSERVATION_OPERATION_SOURCE,
    args: { mode: OBSERVATION_OPERATION_MODES.OBSERVE_SNAPSHOT, ...request },
    decode: decodeObservedSnapshot,
  };
}
