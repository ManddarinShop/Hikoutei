import { randomUUID } from "node:crypto";

import type {
  ApplySyncEffectsRequest,
  ApplySyncEffectsResult,
  EnsureSyncRowAnchorsRequest,
  EnsureSyncRowAnchorsResult,
  FastAppendRowsRequest,
  FastAppendRowsResult,
  ReadSyncEffectPostconditionsRequest,
  ReadSyncSnapshotRequest,
  ReadSyncTableRowsRequest,
  SyncEffectPostcondition,
  SyncEffectPostconditionResult,
  SyncObservedSnapshot,
  SyncProjectionEffect,
  SyncSheetsObservationBatchProvider,
  SyncSheetsProvider,
  SyncSheetsSnapshot,
  SyncSheetsTableReader,
  SyncTableRowsResult,
} from "../syncSheets.js";
import type {
  SyncSheetsProvisionRoute,
  SyncSheetsProvisioner,
} from "../sheetsProvisioning.js";
import {
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS,
  SYNC_SHEETS_GATEWAY_PROTOCOL_VERSION,
  type GatewayRequest,
  type SyncSheetsGatewayLease,
  type SyncSheetsGatewayService,
} from "./contracts.js";
import {
  SYNC_SHEETS_GATEWAY_ERROR_CODES,
  SyncSheetsGatewayError,
} from "./errors.js";
import { requireGatewayText } from "./schemas.js";

/**
 * Client-side capability facade for the versioned Sheets gateway service.
 *
 * It contains no Google provider or coordinator. Every call carries the
 * gateway lease and a request identity so a future IPC transport can preserve
 * the same protocol and fencing checks.
 */
export class SyncSheetsGatewayClient
  implements SyncSheetsProvider, SyncSheetsTableReader, SyncSheetsObservationBatchProvider, SyncSheetsProvisioner {
  private readonly service: SyncSheetsGatewayService;
  private readonly clientId: string;
  private readonly renewLeaseFn: ((leaseToken: string) => SyncSheetsGatewayLease) | undefined;
  private lease: SyncSheetsGatewayLease;

  public constructor(
    service: SyncSheetsGatewayService,
    lease: SyncSheetsGatewayLease,
    clientId: string,
    renewLeaseFn?: (leaseToken: string) => SyncSheetsGatewayLease,
  ) {
    this.service = service;
    this.lease = { ...lease };
    this.clientId = requireGatewayText(clientId, "Sheets gateway clientId");
    this.renewLeaseFn = renewLeaseFn;
  }

  /** Updates credentials after the owning server renews its lease. */
  public updateLease(lease: SyncSheetsGatewayLease): void {
    if (lease.gatewayId !== this.lease.gatewayId || lease.spreadsheetId !== this.lease.spreadsheetId) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
        "cannot replace a Sheets gateway client lease for another gateway",
      );
    }
    this.lease = { ...lease };
  }

  public async fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    return this.service.fastAppendRows(this.envelope(
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.FAST_APPEND_ROWS,
      request,
    ));
  }

  public async applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    return this.service.applyEffects(this.envelope(
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.APPLY_EFFECTS,
      request,
    ));
  }

  public async readEffectPostcondition(effect: SyncProjectionEffect): Promise<SyncEffectPostcondition> {
    return this.service.readEffectPostcondition(this.envelope(
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_EFFECT_POSTCONDITION,
      effect,
    ));
  }

  public async readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncEffectPostconditionResult[]> {
    return this.service.readEffectPostconditions(this.envelope(
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_EFFECT_POSTCONDITIONS,
      request,
    ));
  }

  public async ensureRowAnchors(
    request: EnsureSyncRowAnchorsRequest,
  ): Promise<EnsureSyncRowAnchorsResult> {
    return this.service.ensureRowAnchors(this.envelope(
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.ENSURE_ROW_ANCHORS,
      request,
    ));
  }

  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncSheetsSnapshot> {
    return this.service.readSnapshot(this.envelope(
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_SNAPSHOT,
      request,
    ));
  }

  public async observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot> {
    return this.service.observeSnapshot(this.envelope(
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.OBSERVE_SNAPSHOT,
      request,
    ));
  }

  public async observeSnapshots(
    requests: readonly ReadSyncSnapshotRequest[],
  ): Promise<readonly SyncObservedSnapshot[]> {
    return this.service.observeSnapshots(this.envelope(
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.OBSERVE_SNAPSHOTS,
      requests,
    ));
  }

  public async readRows(request: ReadSyncTableRowsRequest): Promise<SyncTableRowsResult> {
    return this.service.readRows(this.envelope(
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_ROWS,
      request,
    ));
  }

  public async readRowsBatch(
    requests: readonly ReadSyncTableRowsRequest[],
  ): Promise<readonly SyncTableRowsResult[]> {
    return this.service.readRowsBatch(this.envelope(
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_ROWS_BATCH,
      requests,
    ));
  }

  public async provisionRegistry(
    registrations: readonly SyncSheetsProvisionRoute[],
  ): ReturnType<SyncSheetsProvisioner["provisionRegistry"]> {
    return this.service.provisionRegistry(this.envelope(
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.PROVISION_REGISTRY,
      registrations,
    ));
  }

  private envelope<
    Operation extends (typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS)[keyof typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS],
    Payload,
  >(
    operation: Operation,
    payload: Payload,
  ): GatewayRequest<Operation, Payload> {
    if (this.renewLeaseFn !== undefined) {
      this.lease = this.renewLeaseFn(this.lease.leaseToken);
    }
    return {
      protocolVersion: SYNC_SHEETS_GATEWAY_PROTOCOL_VERSION,
      gatewayId: this.lease.gatewayId,
      spreadsheetId: this.lease.spreadsheetId,
      leaseEpoch: this.lease.leaseEpoch,
      leaseToken: this.lease.leaseToken,
      clientId: this.clientId,
      requestId: `${this.clientId}:${randomUUID()}`,
      operation,
      payload,
    } as GatewayRequest<Operation, Payload>;
  }
}
