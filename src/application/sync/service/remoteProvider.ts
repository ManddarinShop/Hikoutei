/**
 * Remote provider assembly for the internal sync service bootstrap.
 *
 * Owns the choice between an injected fake/in-process provider and the full
 * service-account Google Sheets API provider, wraps either in the shared
 * mutation-lane coordinator so writes and anchor observation share one lane,
 * and resolves the provisioner boundary used at startup. Provider options,
 * lane hooks, and provisioning failure classification are unchanged from the
 * single-module bootstrap.
 */

import type {
  InternalSyncProvider,
  InternalSyncServiceOptions,
} from "./serviceOptions.js";
import type {
  RegisteredSyncProjectionDefinition,
  SyncSheetsProvisioner,
} from "../sheetsContract/sheetsProvisioning.js";
import type {
  SyncEffectWorkerProvider,
  SyncSheetsObservationProvider,
  SyncSheetsTableReader,
} from "../sheetsContract/syncSheets.js";
import {
  CoordinatedSheetsProvider,
} from "../sheetsContract/mutationCoordinator/CoordinatedSheetsProvider.js";
import {
  GoogleSheetsApiSyncProvider,
} from "../../../adapter/sheets/providers/google-sheets-api/index.js";
import {
  SYNC_SERVICE_ERROR_CODES,
  SyncServiceError,
} from "./errors.js";

/** Capability facets shared by the in-process sync workers. */
export interface SyncRemotePorts {
  /** Outbound effect and recovery operations only. */
  readonly effects: SyncEffectWorkerProvider;
  /** Metadata-preserving observation operations only. */
  readonly observation: SyncSheetsObservationProvider;
  /** Values-only table reads used by adaptive inbound polling. */
  readonly tableReader: SyncSheetsTableReader;
  /** Startup-only projection provisioning operations. */
  readonly provisioner: SyncSheetsProvisioner;
}

export function createRemoteProvider(
  options: InternalSyncServiceOptions,
  definitions: readonly RegisteredSyncProjectionDefinition[],
): SyncRemotePorts {
  if (options.provider !== undefined) {
    // Injected fake/in-process provider: the coordinator wraps it exactly
    // like the real provider so writes and anchor observation share one
    // mutation lane; provisioning runs on the injected provisioner (or the
    // provider itself when it implements the provisioner boundary).
    const injected = options.provider;
    requireInjectedProviderCapabilities(injected);
    const provisioner = options.provisioner ??
      (isSyncSheetsProvisioner(injected) ? injected : undefined);
    if (!isSyncSheetsProvisioner(provisioner)) {
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
    return {
      effects: coordinated,
      observation: coordinated,
      tableReader: coordinated,
      provisioner,
    };
  }
  // Preferred full-direct mode: ONE provider owns outbound effects,
  // provisioning, table reads, anchors, and snapshots. No Apps Script
  // object is constructed and no router is needed. The coordinator wraps
  // the provider so writes and anchor observation share one mutation lane;
  // provisioning runs at startup on the provider itself.
  const provider = new GoogleSheetsApiSyncProvider({
    ...options.googleSheetsApi,
    spreadsheetId: options.projections.spreadsheetId,
    definitions,
  });
  const coordinated = new CoordinatedSheetsProvider({
    inner: provider,
    ...(options.coordinatorLaneKeyForPhysicalSheet === undefined
      ? {}
      : { mutationKeyForPhysicalSheet: options.coordinatorLaneKeyForPhysicalSheet }),
    ...(options.onCoordinatorLaneEvent === undefined
      ? {}
      : { onLaneEvent: options.onCoordinatorLaneEvent }),
  });
  return {
    effects: coordinated,
    observation: coordinated,
    tableReader: coordinated,
    provisioner: provider,
  };
}

/** Returns whether a value implements the startup provisioning boundary. */
function isSyncSheetsProvisioner(
  provider: unknown,
): provider is InternalSyncProvider & SyncSheetsProvisioner {
  return isRecord(provider) && typeof provider.provisionRegistry === "function";
}

/** Validates injected provider capabilities before any worker can start. */
function requireInjectedProviderCapabilities(
  provider: unknown,
): asserts provider is InternalSyncProvider {
  const required = [
    "fastAppendRows",
    "applyEffects",
    "readEffectPostcondition",
    "readEffectPostconditions",
    "ensureRowAnchors",
    "readSnapshot",
    "readRows",
    "readRowsBatch",
  ] as const;
  if (!isRecord(provider)) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.PROVIDER_UNAVAILABLE,
      "the injected sync provider must be an object implementing every sync capability.",
    );
  }
  const missing = required.filter((method) => typeof provider[method] !== "function");
  if (missing.length > 0) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.PROVIDER_UNAVAILABLE,
      `the injected sync provider is missing required capability methods: ${missing.join(", ")}.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
