/**
 * Shared gateway contract for the SQLite-authoritative sync runtime.
 *
 * The contract deliberately contains normalized values and visible business
 * keys, never Google SDK objects or physical row numbers. Both the fake
 * gateway and the Apps Script client implement this boundary so fault tests
 * exercise the same compare-and-set semantics as a deployed gateway.
 */

import {
  type CellObservationKind,
  type EffectKind,
  type EffectTargetKind,
  type NormalizedCell,
} from "../../../domain/index.js";
import type { Presence } from "../../../shared/state/types.js";
import type { RegisteredProjection } from "../../../infrastructure/storage/sync/shared/syncRegistry.js";
import {
  type SyncGatewayEffectResultStatus,
  type SyncGatewayFastAppendStatus,
  type SyncGatewayPostconditionMode,
  type SyncGatewayPostconditionDisposition,
  type SyncGatewayPostconditionStatus,
  type SyncGatewayProtocolVersion,
  type SyncGatewaySnapshotReadMode,
} from "./constants.js";
import type { SyncGatewayTiming } from "../telemetry/syncTiming.js";
import type { SyncProjectionEffectPayload } from "./syncGatewayEffectPayload.js";

export {
  computeSyncVisibleHash,
  parseSyncProjectionEffectPayload,
  serializeSyncProjectionEffectPayload,
} from "./syncGatewayEffectPayload.js";
export type { SyncProjectionEffectPayload } from "./syncGatewayEffectPayload.js";

/** Projections supported by the v1 sync gateway. */
export type SyncProjection = RegisteredProjection;

/** Effect classes whose compare-and-set behavior differs at the gateway. */
export type SyncEffectKind = EffectKind;

/** Physical kind and normalized value for one observed Sheet cell. */
export interface SyncSnapshotCell {
  readonly cellKind: CellObservationKind;
  readonly normalizedCell: NormalizedCell;
}

/** One physical row read from a registered projection, matched by its ID cell. */
export interface SyncSnapshotRow {
  readonly rowNumber: number;
  readonly cells: Readonly<Record<string, SyncSnapshotCell>>;
}

/** Lock-free normalized snapshot returned by a gateway. */
export interface SyncGatewaySnapshot {
  readonly protocolVersion: SyncGatewayProtocolVersion;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  readonly rows: readonly SyncSnapshotRow[];
}

/** Lock-free snapshot request. */
export interface ReadSyncSnapshotRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  /** Full cells for reconciliation, or literal values for polling. */
  readonly readMode?: SyncGatewaySnapshotReadMode;
}

/** Result of one combined projection observation. */
export interface SyncObservedSnapshot {
  readonly snapshot: SyncGatewaySnapshot;
  /** Optional diagnostic phases returned by newer observation gateways. */
  readonly timing?: SyncGatewayTiming;
}

/** Optional batch observation capability used to share one remote request. */
export interface SyncSheetObservationBatchGateway extends SyncSheetObservationGateway {
  observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot>;
  observeSnapshots(
    requests: readonly ReadSyncSnapshotRequest[],
  ): Promise<readonly SyncObservedSnapshot[]>;
}

/** Returns whether a gateway supports the one-request observation path. */
export function isSyncSheetObservationBatchGateway(
  gateway: SyncSheetObservationGateway,
): gateway is SyncSheetObservationBatchGateway {
  const candidate = gateway as Partial<SyncSheetObservationBatchGateway>;
  return typeof candidate.observeSnapshot === "function" &&
    typeof candidate.observeSnapshots === "function";
}

/** Reads one snapshot with one combined request when the gateway supports it. */
export async function observeSyncSnapshot(
  gateway: SyncSheetObservationGateway,
  request: ReadSyncSnapshotRequest,
): Promise<SyncObservedSnapshot> {
  if (isSyncSheetObservationBatchGateway(gateway)) {
    return gateway.observeSnapshot(request);
  }
  const snapshot = await gateway.readSnapshot(request);
  return { snapshot };
}

/** Reads several snapshots through one remote operation when available. */
export async function observeSyncSnapshots(
  gateway: SyncSheetObservationGateway,
  requests: readonly ReadSyncSnapshotRequest[],
): Promise<readonly SyncObservedSnapshot[]> {
  if (isSyncSheetObservationBatchGateway(gateway)) {
    return gateway.observeSnapshots(requests);
  }
  const results: SyncObservedSnapshot[] = [];
  for (const request of requests) {
    results.push(await observeSyncSnapshot(gateway, request));
  }
  return results;
}

/** Gateway-ready view of one durable outbox row. */
export interface SyncGatewayEffect {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly effectKind: SyncEffectKind;
  readonly physicalSheetId: string;
  readonly projection: SyncProjection;
  readonly targetKind: EffectTargetKind;
  readonly targetId: string;
  readonly rowBindingId: Presence<string>;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly repairGuardHash: Presence<string>;
  readonly payload: SyncProjectionEffectPayload;
}

/** Per-effect terminal/non-terminal gateway result. */
export interface SyncGatewayEffectResult {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly status: SyncGatewayEffectResultStatus;
  readonly visibleRevision: Presence<number>;
  readonly visibleHash: Presence<string>;
  readonly reason: Presence<string>;
  readonly postcondition: SyncGatewayPostconditionStatus;
}

/** Gateway batch request. All effects must target the same physical sheet. */
export interface ApplySyncEffectsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly effects: readonly SyncGatewayEffect[];
  /**
   * Defaults to inline verification for compatibility. The worker explicitly
   * selects deferred verification so recovery/reconciliation owns read-back.
   */
  readonly postconditionMode?: SyncGatewayPostconditionMode;
}

/** A batch may intentionally return only a prefix when its budget is exhausted. */
export interface ApplySyncEffectsResult {
  readonly results: readonly SyncGatewayEffectResult[];
  /** True only when the gateway intentionally stopped before the supplied suffix. */
  readonly hasMore: boolean;
  /** Optional phase timing returned by newer Code.gs deployments. */
  readonly timing?: SyncGatewayTiming;
}

/** Read-back classification used after a response is lost or a lease expires. */
export interface SyncEffectPostcondition {
  readonly disposition: SyncGatewayPostconditionDisposition;
  readonly visibleRevision: Presence<number>;
  readonly visibleHash: Presence<string>;
}

/** One effect identity paired with its read-back result in a recovery batch. */
export interface SyncGatewayEffectPostconditionResult {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly postcondition: SyncEffectPostcondition;
}

/** One row written through the fast-append path.
 *
 * This path is deliberately append-only. It does not carry a row anchor,
 * compare-and-set state, visible hash, receipt, or metadata instruction. A
 * response loss may therefore cause a later retry to append the row again;
 * reconciliation is the component that detects and repairs that drift.
 */
export interface FastAppendRow {
  readonly effectId: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
}

/** Per-effect result for one fast-append row. */
export interface FastAppendRowResult {
  readonly effectId: string;
  /** The row was included in the gateway's bulk write. */
  readonly status: SyncGatewayFastAppendStatus;
}

/** Bounded fast-append request for one System_State projection sheet. */
export interface FastAppendRowsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly rows: readonly FastAppendRow[];
}

/** Result of one bounded fast-append batch. */
export interface FastAppendRowsResult {
  readonly results: readonly FastAppendRowResult[];
  /** True when the gateway intentionally stopped before the supplied suffix. */
  readonly hasMore: boolean;
  /** Optional phase timing returned by newer Code.gs deployments. */
  readonly timing?: SyncGatewayTiming;
}

/** Request used to classify several response-loss effects with one Sheet read. */
export interface ReadSyncEffectPostconditionsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly effects: readonly SyncGatewayEffect[];
}

/** Fast append capability required for new System_State rows. */
export interface SyncEffectWorkerGateway {
  fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult>;
}

/**
 * Full effect capability required for regular updates, deletes, and recovery.
 *
 * A fast-only gateway can still run the worker when its outbox contains only
 * appendable System_State creates; regular effects are rejected explicitly.
 */
export interface SyncEffectWorkerFullGateway extends SyncEffectWorkerGateway {
  applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult>;
  readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition>;
  readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncGatewayEffectPostconditionResult[]>;
}

/** Read-only gateway capability used by polling and onEdit observation. */
export interface SyncSheetObservationGateway {
  readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot>;
}

/**
 * Full gateway boundary used by observation and reconciliation.
 *
 * It includes the full effect-worker capabilities plus the snapshot reads
 * required to observe user edits and repair projection drift.
 */
export interface SyncSheetGateway extends SyncEffectWorkerFullGateway, SyncSheetObservationGateway {}

/**
 * Dependencies for a gateway that routes append writes and full observation
 * work to separate remote capabilities.
 *
 * The fast gateway may be the thin operation-based Code.gs deployment, while
 * the full gateway may be a separately deployed observation/reconciliation
 * endpoint. Keeping this composition explicit prevents a fast-only endpoint
 * from being mistaken for a complete sync gateway.
 */
export interface SplitSyncGatewayOptions {
  readonly fastGateway: SyncEffectWorkerGateway;
  readonly fullGateway: SyncSheetGateway;
}

/**
 * Combines the low-latency append path with the full observation path.
 *
 * New System_State creates use `fastGateway`. Updates, deletes, response-loss
 * recovery, user-edit observation, and reconciliation use `fullGateway`.
 * Neither delegate is allowed to silently handle the other capability.
 */
export class SplitSyncGateway implements SyncSheetGateway {
  private readonly fastGateway: SyncEffectWorkerGateway;
  private readonly fullGateway: SyncSheetGateway;

  public constructor(options: SplitSyncGatewayOptions) {
    this.fastGateway = options.fastGateway;
    this.fullGateway = options.fullGateway;
  }

  /** Sends append-only System_State creates through the thin gateway. */
  public fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    return this.fastGateway.fastAppendRows(request);
  }

  /** Sends regular effect writes through the full gateway. */
  public applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    return this.fullGateway.applyEffects(request);
  }

  /** Reads one effect postcondition through the full gateway. */
  public readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition> {
    return this.fullGateway.readEffectPostcondition(effect);
  }

  /** Reads a batch of effect postconditions through the full gateway. */
  public readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncGatewayEffectPostconditionResult[]> {
    return this.fullGateway.readEffectPostconditions(request);
  }

  /** Reads snapshots through the full observation gateway. */
  public readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot> {
    return this.fullGateway.readSnapshot(request);
  }

  /** Shares the full gateway's combined observation capability when present. */
  public observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot> {
    return observeSyncSnapshot(this.fullGateway, request);
  }

  /** Shares one remote observation request across the supplied projections. */
  public observeSnapshots(
    requests: readonly ReadSyncSnapshotRequest[],
  ): Promise<readonly SyncObservedSnapshot[]> {
    return observeSyncSnapshots(this.fullGateway, requests);
  }
}
