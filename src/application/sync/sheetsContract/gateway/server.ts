import { randomUUID } from "node:crypto";

import type {
  ApplyEffectsGatewayRequest,
  EnsureRowAnchorsGatewayRequest,
  FastAppendRowsGatewayRequest,
  ObserveSnapshotGatewayRequest,
  ObserveSnapshotsGatewayRequest,
  ProvisionRegistryGatewayRequest,
  ReadEffectPostconditionGatewayRequest,
  ReadEffectPostconditionsGatewayRequest,
  ReadRowsBatchGatewayRequest,
  ReadRowsGatewayRequest,
  ReadSnapshotGatewayRequest,
  SyncSheetsGatewayLease,
  SyncSheetsGatewayOperation,
  SyncSheetsGatewayPorts,
  SyncSheetsGatewayRequest,
  SyncSheetsGatewayService,
} from "./contracts.js";
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
  SyncSheetsSnapshot,
  SyncTableRowsResult,
} from "../syncSheets.js";
import type { SyncSheetsProvisionRoute } from "../sheetsProvisioning.js";
import {
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS,
  SYNC_SHEETS_GATEWAY_PROTOCOL_VERSION,
} from "./contracts.js";
import {
  SYNC_SHEETS_GATEWAY_ERROR_CODES,
  SyncSheetsGatewayError,
} from "./errors.js";
import { SyncSheetsGatewayClient } from "./client.js";

const DEFAULT_GATEWAY_LEASE_MS = 60_000;
const activeGateways = new Map<string, string>();

type PayloadShape = "object" | "array";

/** Construction options for the one process-local gateway owner. */
export interface InProcessSyncSheetsGatewayServerOptions {
  readonly gatewayId: string;
  readonly spreadsheetId: string;
  /** All facets must come from one CoordinatedSheetsProvider instance. */
  readonly ports: SyncSheetsGatewayPorts;
  readonly leaseDurationMs?: number;
  readonly now?: () => number;
  readonly createLeaseToken?: () => string;
}

/**
 * In-process gateway server that owns one coordinated Sheets provider.
 *
 * The request envelope is deliberately transport-shaped: a later IPC server
 * can implement the same `SyncSheetsGatewayService` without exposing Google
 * SDK values or creating another process-local coordinator. The singleton map
 * is only a same-process guard; cross-process singleton/fencing belongs to the
 * future gateway deployment and must not be inferred from this map.
 */
export class InProcessSyncSheetsGatewayServer implements SyncSheetsGatewayService {
  private readonly gatewayId: string;
  private readonly spreadsheetId: string;
  private readonly ports: SyncSheetsGatewayPorts;
  private readonly leaseDurationMs: number;
  private readonly now: () => number;
  private readonly createLeaseToken: () => string;
  private lease: SyncSheetsGatewayLease;
  private readonly inFlightRequests = new Set<string>();
  private closed = false;

  public constructor(options: InProcessSyncSheetsGatewayServerOptions) {
    this.gatewayId = requireText(options.gatewayId, "gatewayId");
    this.spreadsheetId = requireText(options.spreadsheetId, "spreadsheetId");
    this.ports = options.ports;
    this.leaseDurationMs = requirePositiveSafeInteger(
      options.leaseDurationMs ?? DEFAULT_GATEWAY_LEASE_MS,
      "gateway lease duration",
    );
    this.now = options.now ?? Date.now;
    this.createLeaseToken = options.createLeaseToken ?? randomUUID;
    if (activeGateways.has(this.spreadsheetId)) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.LEASE_CONFLICT,
        `a Sheets gateway is already active for spreadsheet ${this.spreadsheetId}`,
      );
    }
    this.lease = this.createLease();
    activeGateways.set(this.spreadsheetId, this.gatewayId);
  }

  /** Returns the current server lease for constructing a client session. */
  public getLease(): SyncSheetsGatewayLease {
    return { ...this.lease };
  }

  /** Creates another client session against this same serialized server. */
  public createClient(clientId: string): SyncSheetsGatewayClient {
    return new SyncSheetsGatewayClient(
      this,
      this.getLease(),
      clientId,
      (leaseToken) => this.renewLease(leaseToken),
    );
  }

  /** Extends the current lease without changing its fencing token or epoch. */
  public renewLease(leaseToken: string): SyncSheetsGatewayLease {
    this.assertUsable();
    if (leaseToken !== this.lease.leaseToken) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.LEASE_EXPIRED,
        "cannot renew a Sheets gateway lease with a stale token",
      );
    }
    this.lease = {
      ...this.lease,
      expiresAt: this.now() + this.leaseDurationMs,
    };
    return this.getLease();
  }

  /** Releases the singleton reservation and rejects all subsequent requests. */
  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (activeGateways.get(this.spreadsheetId) === this.gatewayId) {
      activeGateways.delete(this.spreadsheetId);
    }
  }

  public fastAppendRows(request: FastAppendRowsGatewayRequest) {
    return this.run<
      typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.FAST_APPEND_ROWS,
      FastAppendRowsRequest,
      FastAppendRowsResult
    >(
      request,
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.FAST_APPEND_ROWS,
      "object",
      (payload) => this.ports.effects.fastAppendRows(payload),
    );
  }

  public applyEffects(request: ApplyEffectsGatewayRequest) {
    return this.run<
      typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.APPLY_EFFECTS,
      ApplySyncEffectsRequest,
      ApplySyncEffectsResult
    >(
      request,
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.APPLY_EFFECTS,
      "object",
      (payload) => this.ports.effects.applyEffects(payload),
    );
  }

  public readEffectPostcondition(request: ReadEffectPostconditionGatewayRequest) {
    return this.run<
      typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_EFFECT_POSTCONDITION,
      SyncProjectionEffect,
      SyncEffectPostcondition
    >(
      request,
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_EFFECT_POSTCONDITION,
      "object",
      (payload) => this.ports.effects.readEffectPostcondition(payload),
    );
  }

  public readEffectPostconditions(request: ReadEffectPostconditionsGatewayRequest) {
    return this.run<
      typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_EFFECT_POSTCONDITIONS,
      ReadSyncEffectPostconditionsRequest,
      readonly SyncEffectPostconditionResult[]
    >(
      request,
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_EFFECT_POSTCONDITIONS,
      "object",
      (payload) => this.ports.effects.readEffectPostconditions(payload),
    );
  }

  public ensureRowAnchors(request: EnsureRowAnchorsGatewayRequest) {
    return this.run<
      typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.ENSURE_ROW_ANCHORS,
      EnsureSyncRowAnchorsRequest,
      EnsureSyncRowAnchorsResult
    >(
      request,
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.ENSURE_ROW_ANCHORS,
      "object",
      (payload) => this.ports.observation.ensureRowAnchors(payload),
    );
  }

  public readSnapshot(request: ReadSnapshotGatewayRequest) {
    return this.run<
      typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_SNAPSHOT,
      ReadSyncSnapshotRequest,
      SyncSheetsSnapshot
    >(
      request,
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_SNAPSHOT,
      "object",
      (payload) => this.ports.observation.readSnapshot(payload),
    );
  }

  public observeSnapshot(request: ObserveSnapshotGatewayRequest) {
    return this.run<
      typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.OBSERVE_SNAPSHOT,
      ReadSyncSnapshotRequest,
      SyncObservedSnapshot
    >(
      request,
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.OBSERVE_SNAPSHOT,
      "object",
      (payload) => this.ports.observation.observeSnapshot(payload),
    );
  }

  public observeSnapshots(request: ObserveSnapshotsGatewayRequest) {
    return this.run<
      typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.OBSERVE_SNAPSHOTS,
      readonly ReadSyncSnapshotRequest[],
      readonly SyncObservedSnapshot[]
    >(
      request,
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.OBSERVE_SNAPSHOTS,
      "array",
      (payload) => this.ports.observation.observeSnapshots(payload),
    );
  }

  public readRows(request: ReadRowsGatewayRequest) {
    return this.run<
      typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_ROWS,
      ReadSyncTableRowsRequest,
      SyncTableRowsResult
    >(
      request,
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_ROWS,
      "object",
      (payload) => this.ports.tableReader.readRows(payload),
    );
  }

  public readRowsBatch(request: ReadRowsBatchGatewayRequest) {
    return this.run<
      typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_ROWS_BATCH,
      readonly ReadSyncTableRowsRequest[],
      readonly SyncTableRowsResult[]
    >(
      request,
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_ROWS_BATCH,
      "array",
      (payload) => this.ports.tableReader.readRowsBatch(payload),
    );
  }

  public provisionRegistry(request: ProvisionRegistryGatewayRequest) {
    return this.run<
      typeof SYNC_SHEETS_GATEWAY_OPERATION_KINDS.PROVISION_REGISTRY,
      readonly SyncSheetsProvisionRoute[],
      Awaited<ReturnType<SyncSheetsGatewayPorts["provisioner"]["provisionRegistry"]>>
    >(
      request,
      SYNC_SHEETS_GATEWAY_OPERATION_KINDS.PROVISION_REGISTRY,
      "array",
      (payload) => this.ports.provisioner.provisionRegistry(payload),
    );
  }

  private createLease(): SyncSheetsGatewayLease {
    const leaseToken = requireText(this.createLeaseToken(), "gateway lease token");
    return {
      gatewayId: this.gatewayId,
      spreadsheetId: this.spreadsheetId,
      leaseEpoch: 1,
      leaseToken,
      expiresAt: this.now() + this.leaseDurationMs,
    };
  }

  private async run<Operation extends SyncSheetsGatewayOperation, Payload, Result>(
    request: unknown,
    operation: Operation,
    payloadShape: PayloadShape,
    task: (payload: Payload) => Promise<Result>,
  ): Promise<Result> {
    const checked = this.authorize<Operation, Payload>(request, operation, payloadShape);
    if (this.inFlightRequests.has(checked.requestId)) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.REQUEST_IN_FLIGHT,
        `gateway request is already in flight: ${checked.requestId}`,
      );
    }
    this.inFlightRequests.add(checked.requestId);
    try {
      return await task(checked.payload);
    } finally {
      this.inFlightRequests.delete(checked.requestId);
    }
  }

  private authorize<Operation extends SyncSheetsGatewayOperation, Payload>(
    value: unknown,
    operation: Operation,
    payloadShape: PayloadShape,
  ): SyncSheetsGatewayRequest<Operation, Payload> {
    this.assertUsable();
    if (!isRecord(value)) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
        "gateway request must be an object",
      );
    }
    if (value.protocolVersion !== SYNC_SHEETS_GATEWAY_PROTOCOL_VERSION) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.PROTOCOL_MISMATCH,
        `unsupported Sheets gateway protocol version: ${String(value.protocolVersion)}`,
      );
    }
    if (value.gatewayId !== this.gatewayId || value.spreadsheetId !== this.spreadsheetId) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
        "gateway request targets a different gateway or spreadsheet",
      );
    }
    if (value.operation !== operation) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
        `gateway request operation does not match ${operation}`,
      );
    }
    requireText(value.clientId, "clientId");
    requireText(value.requestId, "requestId");
    if (!Number.isSafeInteger(value.leaseEpoch) || value.leaseEpoch !== this.lease.leaseEpoch) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.LEASE_EXPIRED,
        "gateway request carries a stale lease epoch",
      );
    }
    if (value.leaseToken !== this.lease.leaseToken || this.now() >= this.lease.expiresAt) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.LEASE_EXPIRED,
        "Sheets gateway lease has expired or carries a stale token",
      );
    }
    const payloadIsArray = Array.isArray(value.payload);
    if ((payloadShape === "array" && !payloadIsArray) ||
      (payloadShape === "object" && !isRecord(value.payload))) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
        `gateway ${operation} payload has the wrong shape`,
      );
    }
    return value as unknown as SyncSheetsGatewayRequest<Operation, Payload>;
  }

  private assertUsable(): void {
    if (this.closed) {
      throw new SyncSheetsGatewayError(
        SYNC_SHEETS_GATEWAY_ERROR_CODES.UNAVAILABLE,
        "Sheets gateway is closed",
      );
    }
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SyncSheetsGatewayError(
      SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SyncSheetsGatewayError(
      SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
