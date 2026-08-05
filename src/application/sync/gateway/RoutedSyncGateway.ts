/**
 * Provider-neutral router composing a direct outbound provider with the
 * observation/provisioning provider.
 *
 * The router implements the same gateway boundary the worker and polling
 * already use, so no caller changes are required: outbound effect work
 * (fast append, applyEffects, postcondition reads) goes to the direct Google
 * Sheets provider, while anchor observation, snapshot/table reads, and
 * provisioning stay on the Apps Script gateway (or an injected gateway +
 * provisioner). The sync service bootstrap wraps the router in the
 * per-spreadsheet mutation coordinator so direct writes and anchor
 * observation share one in-process mutation lane.
 */

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
  SyncEffectWorkerFullGateway,
  SyncGatewayEffect,
  SyncGatewayEffectPostconditionResult,
  SyncGatewaySnapshot,
  SyncObservedSnapshot,
  SyncSheetGateway,
  SyncSheetTableReaderGateway,
  SyncTableRowsResult,
} from "./syncGateway.js";
import {
  observeSyncSnapshot,
  observeSyncSnapshots,
} from "./syncGateway.js";
import type {
  SyncGatewayProvisioner,
  SyncGatewayProvisionRoute,
} from "./SyncGatewayBootstrap.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "./errors.js";

/** Delegates for the routed gateway. */
export interface RoutedSyncGatewayOptions {
  /** Direct outbound provider: fast append, effects, postcondition reads. */
  readonly outbound: SyncEffectWorkerFullGateway;
  /** Observation provider: anchors, snapshots, table reads. */
  readonly observation: SyncSheetGateway & SyncSheetTableReaderGateway;
  /** Optional provisioning delegate; defaults to the observation provider. */
  readonly provisioner?: SyncGatewayProvisioner;
}

/**
 * @deprecated Legacy composition used only by the deprecated mixed
 * `googleApiWorker` bootstrap mode. The preferred `googleSheetsApi` mode
 * uses the full direct provider directly, so this router (and the Apps
 * Script observation half it routes to) is no longer needed for new setups.
 */
export class RoutedSyncGateway
  implements SyncSheetGateway, SyncSheetTableReaderGateway, SyncGatewayProvisioner {
  private readonly outbound: SyncEffectWorkerFullGateway;
  private readonly observation: SyncSheetGateway & SyncSheetTableReaderGateway;
  private readonly provisioner: SyncGatewayProvisioner;

  public constructor(options: RoutedSyncGatewayOptions) {
    this.outbound = options.outbound;
    this.observation = options.observation;
    const provisioner = options.provisioner ?? asProvisioner(options.observation);
    if (provisioner === undefined) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "the routed sync gateway needs a provisioning delegate",
      );
    }
    this.provisioner = provisioner;
  }

  /** Sends append-only rows through the direct outbound provider. */
  public fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    return this.outbound.fastAppendRows(request);
  }

  /** Sends regular effect writes through the direct outbound provider. */
  public applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    return this.outbound.applyEffects(request);
  }

  /** Reads one effect postcondition through the direct outbound provider. */
  public readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition> {
    return this.outbound.readEffectPostcondition(effect);
  }

  /** Reads a batch of postconditions through the direct outbound provider. */
  public readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncGatewayEffectPostconditionResult[]> {
    return this.outbound.readEffectPostconditions(request);
  }

  /** Ensures row anchors through the observation provider. */
  public ensureRowAnchors(
    request: EnsureSyncRowAnchorsRequest,
  ): Promise<EnsureSyncRowAnchorsResult> {
    return this.observation.ensureRowAnchors(request);
  }

  /** Reads snapshots through the observation provider. */
  public readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot> {
    return this.observation.readSnapshot(request);
  }

  /** Shares the observation provider's combined observation capability. */
  public observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot> {
    return observeSyncSnapshot(this.observation, request);
  }

  /** Shares one observation request across the supplied projections. */
  public observeSnapshots(
    requests: readonly ReadSyncSnapshotRequest[],
  ): Promise<readonly SyncObservedSnapshot[]> {
    return observeSyncSnapshots(this.observation, requests);
  }

  /** Reads one registered table through the observation provider. */
  public readRows(request: ReadSyncTableRowsRequest): Promise<SyncTableRowsResult> {
    return this.observation.readRows(request);
  }

  /** Reads several registered tables through the observation provider. */
  public readRowsBatch(
    requests: readonly ReadSyncTableRowsRequest[],
  ): Promise<readonly SyncTableRowsResult[]> {
    return this.observation.readRowsBatch(requests);
  }

  /** Provisions the registered projections through the provisioning delegate. */
  public provisionRegistry(
    registrations: readonly SyncGatewayProvisionRoute[],
  ): ReturnType<SyncGatewayProvisioner["provisionRegistry"]> {
    return this.provisioner.provisionRegistry(registrations);
  }
}

/** Returns the observation provider itself when it can provision. */
function asProvisioner(value: object): SyncGatewayProvisioner | undefined {
  return "provisionRegistry" in value && typeof value.provisionRegistry === "function"
    ? (value as SyncGatewayProvisioner)
    : undefined;
}
