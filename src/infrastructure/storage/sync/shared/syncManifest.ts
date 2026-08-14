/**
 * Durable worker-facing projection manifest validation.
 *
 * The registry remains the writer-owned source of truth. This module promotes
 * its persisted route, ordered headers, and ownership JSON into a contract that
 * an external worker may safely consume without the host's in-memory mapping.
 */

import type { SqlExecutor, SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import {
  readRegisteredSyncSheetsWithAdapter,
  readRegisteredSyncSheetsWithSql,
  requireRegisteredSyncSheetWithAdapter,
  requireRegisteredSyncSheetWithSql,
  type RegisteredSyncSheet,
} from "./syncRegistry.js";

/** A validated route plus its parsed ownership manifest. */
export interface DurableSyncManifest {
  readonly route: RegisteredSyncSheet;
  readonly ownershipManifest: Readonly<Record<string, unknown>>;
}

/** Validates one persisted route before an external worker uses it. */
export function requireDurableSyncManifest(
  route: RegisteredSyncSheet,
): DurableSyncManifest {
  if (route.projectionHeaders.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      `sync manifest ${route.physicalSheetId} has no persisted projection headers`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(route.ownershipManifestJson);
  } catch {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      `sync manifest ${route.physicalSheetId} has malformed ownership metadata`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      `sync manifest ${route.physicalSheetId} ownership metadata must be an object`,
    );
  }
  return {
    route,
    ownershipManifest: parsed as Readonly<Record<string, unknown>>,
  };
}

/** Reads and validates one complete worker manifest through an active SQL context. */
export async function requireDurableSyncManifestWithSql(
  sql: SqlExecutor,
  physicalSheetId: string,
): Promise<DurableSyncManifest> {
  return requireDurableSyncManifest(
    await requireRegisteredSyncSheetWithSql(sql, physicalSheetId),
  );
}

/** Reads and validates one complete worker manifest through an adapter. */
export async function requireDurableSyncManifestWithAdapter(
  storage: SqlStorageAdapter,
  physicalSheetId: string,
): Promise<DurableSyncManifest> {
  return requireDurableSyncManifest(
    await requireRegisteredSyncSheetWithAdapter(storage, physicalSheetId),
  );
}

/** Reads every enabled complete worker manifest through an active SQL context. */
export async function readDurableSyncManifestsWithSql(
  sql: SqlExecutor,
): Promise<readonly DurableSyncManifest[]> {
  return (await readRegisteredSyncSheetsWithSql(sql)).map(requireDurableSyncManifest);
}

/** Reads every enabled complete worker manifest through an adapter. */
export async function readDurableSyncManifestsWithAdapter(
  storage: SqlStorageAdapter,
): Promise<readonly DurableSyncManifest[]> {
  return (await readRegisteredSyncSheetsWithAdapter(storage)).map(requireDurableSyncManifest);
}
