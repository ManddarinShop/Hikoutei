/**
 * Remote provider assembly for the internal sync service bootstrap.
 *
 * Owns the choice between an injected fake/in-process provider and the full
 * service-account Google Sheets API provider, wraps either in the shared
 * mutation-lane coordinator so writes and anchor observation share one lane,
 * and resolves the provisioner boundary used at startup. Provider options,
 * lane hooks, and provisioning failure classification are unchanged from the
 * single-module bootstrap.
 *
 * P8-C: the direct-mode provider is a concrete adapter — its construction
 * moved to the composition root (`packages/composition/src/syncEngine.ts`) and is
 * received here through the `SyncEngineCompositionPorts` closures; this
 * module names only contract types.
 */

import type {
  SyncEngineCompositionPorts,
} from "./compositionPorts.js";
import type {
  InternalSyncProvider,
  InternalSyncServiceOptions,
} from "./serviceOptions.js";
import type {
  GoogleSheetsApiRequestEvent,
} from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import type {
  RegisteredSyncProjectionDefinition,
  SyncSheetsProvisioner,
} from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import {
  CoordinatedSheetsProvider,
} from "@hikoutei/contracts/sheets/mutationCoordinator/CoordinatedSheetsProvider.js";
import {
  SYNC_SERVICE_ERROR_CODES,
  SyncServiceError,
} from "./errors.js";

export function createRemoteProvider(
  options: InternalSyncServiceOptions,
  definitions: readonly RegisteredSyncProjectionDefinition[],
  ports: SyncEngineCompositionPorts,
  // Optional request-telemetry sink (bootstrap-scoped aggregator). Chained
  // BEFORE any caller-supplied `googleSheetsApi.onRequest` (both sinks are
  // observational and fail-open, so ordering is not behavioral; the telemetry
  // sink is guaranteed non-throwing, so the user sink always runs).
  // keep their contract; the sink itself is fail-open.
  onRequest?: (event: GoogleSheetsApiRequestEvent) => void,
): {
  readonly provider: InternalSyncProvider;
  readonly provisioner: SyncSheetsProvisioner;
} {
  if (options.provider !== undefined) {
    // Injected fake/in-process provider: the coordinator wraps it exactly
    // like the real provider so writes and anchor observation share one
    // mutation lane; provisioning runs on the injected provisioner (or the
    // provider itself when it implements the provisioner boundary).
    const injected = options.provider;
    const provisioner = options.provisioner ??
      (isSyncSheetsProvisioner(injected) ? injected : undefined);
    if (provisioner === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.PROVIDER_UNAVAILABLE,
        "the injected sync provider does not provide projection provisioning.",
      );
    }
    const coordinated = new CoordinatedSheetsProvider({
      inner: injected,
      ...(options.coordinatorLaneKeyForPhysicalSheet === undefined
        ? {}
        : { mutationKeyForPhysicalSheet: options.coordinatorLaneKeyForPhysicalSheet }),
      ...(options.onCoordinatorLaneEvent === undefined
        ? {}
        : { onLaneEvent: options.onCoordinatorLaneEvent }),
    });
    return { provider: coordinated, provisioner };
  }
  // Preferred full-direct mode: ONE provider owns outbound effects,
  // provisioning, table reads, anchors, and snapshots. No Apps Script
  // object is constructed and no router is needed. The coordinator wraps
  // the provider so writes and anchor observation share one mutation lane;
  // provisioning runs at startup on the provider itself.
  const remoteProvider = ports.createDirectRemoteProvider({
    providerOptions: {
      ...options.googleSheetsApi,
      ...(onRequest === undefined
        ? {}
        : {
          onRequest: (event: GoogleSheetsApiRequestEvent) => {
            onRequest(event);
            options.googleSheetsApi?.onRequest?.(event);
          },
        }),
    },
    spreadsheetId: options.projections.spreadsheetId,
    definitions,
  }).provider;
  const coordinated = new CoordinatedSheetsProvider({
    inner: remoteProvider,
    ...(options.coordinatorLaneKeyForPhysicalSheet === undefined
      ? {}
      : { mutationKeyForPhysicalSheet: options.coordinatorLaneKeyForPhysicalSheet }),
    ...(options.onCoordinatorLaneEvent === undefined
      ? {}
      : { onLaneEvent: options.onCoordinatorLaneEvent }),
  });
  return {
    provider: coordinated,
    provisioner: remoteProvider,
  };
}

/** Returns whether a provider also implements the provisioner boundary. */
function isSyncSheetsProvisioner(
  provider: InternalSyncProvider,
): provider is InternalSyncProvider & SyncSheetsProvisioner {
  return "provisionRegistry" in provider &&
    typeof (provider as InternalSyncProvider & Record<"provisionRegistry", unknown>).provisionRegistry === "function";
}