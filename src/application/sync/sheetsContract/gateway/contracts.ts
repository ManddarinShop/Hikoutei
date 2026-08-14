import type {
  ApplySyncEffectsRequest,
  ApplySyncEffectsResult,
  EnsureSyncRowAnchorsRequest,
  EnsureSyncRowAnchorsResult,
  FastAppendRowsRequest,
  FastAppendRowsResult,
  ReadSyncEffectPostconditionsRequest,
  SyncEffectPostconditionResult,
  ReadSyncSnapshotRequest,
  ReadSyncTableRowsRequest,
  SyncEffectPostcondition,
  SyncObservedSnapshot,
  SyncSheetsObservationBatchProvider,
  SyncSheetsTableReader,
  SyncSheetsProvider,
  SyncSheetsSnapshot,
  SyncTableRowsResult,
} from "../syncSheets.js";
import type {
  SyncSheetsProvisionRoute,
  SyncSheetsProvisioner,
} from "../sheetsProvisioning.js";

/** Wire protocol version shared by gateway clients and the singleton server. */
export const SYNC_SHEETS_GATEWAY_PROTOCOL_VERSION = 1 as const;

/** Operations exposed by the gateway; SDK/provider internals stay server-side. */
export const SYNC_SHEETS_GATEWAY_OPERATION_KINDS = {
  FAST_APPEND_ROWS: "effects.fast_append_rows",
  APPLY_EFFECTS: "effects.apply_effects",
  READ_EFFECT_POSTCONDITION: "effects.read_effect_postcondition",
  READ_EFFECT_POSTCONDITIONS: "effects.read_effect_postconditions",
  ENSURE_ROW_ANCHORS: "observation.ensure_row_anchors",
  READ_SNAPSHOT: "observation.read_snapshot",
  OBSERVE_SNAPSHOT: "observation.observe_snapshot",
  OBSERVE_SNAPSHOTS: "observation.observe_snapshots",
  READ_ROWS: "table_reader.read_rows",
  READ_ROWS_BATCH: "table_reader.read_rows_batch",
  PROVISION_REGISTRY: "provisioner.provision_registry",
} as const;

export type SyncSheetsGatewayOperation =
  (typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS)[keyof typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS];

/** Server-side capability set; all facets must be backed by one coordinator. */
export interface SyncSheetsGatewayPorts {
  readonly effects: SyncSheetsProvider;
  readonly observation: SyncSheetsObservationBatchProvider;
  readonly tableReader: SyncSheetsTableReader;
  readonly provisioner: SyncSheetsProvisioner;
}

/** Fencing credentials issued by the singleton gateway owner. */
export interface SyncSheetsGatewayLease {
  readonly gatewayId: string;
  readonly spreadsheetId: string;
  readonly leaseEpoch: number;
  readonly leaseToken: string;
  readonly expiresAt: number;
}

/** Versioned request envelope suitable for a future IPC transport. */
export interface SyncSheetsGatewayRequest<
  Operation extends SyncSheetsGatewayOperation,
  Payload,
> {
  readonly protocolVersion: typeof SYNC_SHEETS_GATEWAY_PROTOCOL_VERSION;
  readonly gatewayId: string;
  readonly spreadsheetId: string;
  readonly leaseEpoch: number;
  readonly leaseToken: string;
  readonly clientId: string;
  readonly requestId: string;
  readonly operation: Operation;
  readonly payload: Payload;
}

export type GatewayRequest<
  Operation extends SyncSheetsGatewayOperation,
  Payload,
> = SyncSheetsGatewayRequest<Operation, Payload>;

export type FastAppendRowsGatewayRequest = GatewayRequest<
  typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.FAST_APPEND_ROWS,
  FastAppendRowsRequest
>;
export type ApplyEffectsGatewayRequest = GatewayRequest<
  typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.APPLY_EFFECTS,
  ApplySyncEffectsRequest
>;
export type ReadEffectPostconditionGatewayRequest = GatewayRequest<
  typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_EFFECT_POSTCONDITION,
  ReadSyncEffectPostconditionsRequest["effects"][number]
>;
export type ReadEffectPostconditionsGatewayRequest = GatewayRequest<
  typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_EFFECT_POSTCONDITIONS,
  ReadSyncEffectPostconditionsRequest
>;
export type EnsureRowAnchorsGatewayRequest = GatewayRequest<
  typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.ENSURE_ROW_ANCHORS,
  EnsureSyncRowAnchorsRequest
>;
export type ReadSnapshotGatewayRequest = GatewayRequest<
  typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_SNAPSHOT,
  ReadSyncSnapshotRequest
>;
export type ObserveSnapshotGatewayRequest = GatewayRequest<
  typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.OBSERVE_SNAPSHOT,
  ReadSyncSnapshotRequest
>;
export type ObserveSnapshotsGatewayRequest = GatewayRequest<
  typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.OBSERVE_SNAPSHOTS,
  readonly ReadSyncSnapshotRequest[]
>;
export type ReadRowsGatewayRequest = GatewayRequest<
  typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_ROWS,
  ReadSyncTableRowsRequest
>;
export type ReadRowsBatchGatewayRequest = GatewayRequest<
  typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_ROWS_BATCH,
  readonly ReadSyncTableRowsRequest[]
>;
export type ProvisionRegistryGatewayRequest = GatewayRequest<
  typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.PROVISION_REGISTRY,
  readonly SyncSheetsProvisionRoute[]
>;

/** Typed service interface implemented by an in-process or future IPC server. */
export interface SyncSheetsGatewayService {
  fastAppendRows(request: FastAppendRowsGatewayRequest): Promise<FastAppendRowsResult>;
  applyEffects(request: ApplyEffectsGatewayRequest): Promise<ApplySyncEffectsResult>;
  readEffectPostcondition(request: ReadEffectPostconditionGatewayRequest): Promise<SyncEffectPostcondition>;
  readEffectPostconditions(request: ReadEffectPostconditionsGatewayRequest): Promise<readonly SyncEffectPostconditionResult[]>;
  ensureRowAnchors(request: EnsureRowAnchorsGatewayRequest): Promise<EnsureSyncRowAnchorsResult>;
  readSnapshot(request: ReadSnapshotGatewayRequest): Promise<SyncSheetsSnapshot>;
  observeSnapshot(request: ObserveSnapshotGatewayRequest): Promise<SyncObservedSnapshot>;
  observeSnapshots(request: ObserveSnapshotsGatewayRequest): Promise<readonly SyncObservedSnapshot[]>;
  readRows(request: ReadRowsGatewayRequest): Promise<SyncTableRowsResult>;
  readRowsBatch(request: ReadRowsBatchGatewayRequest): Promise<readonly SyncTableRowsResult[]>;
  provisionRegistry(request: ProvisionRegistryGatewayRequest): ReturnType<SyncSheetsProvisioner["provisionRegistry"]>;
}
