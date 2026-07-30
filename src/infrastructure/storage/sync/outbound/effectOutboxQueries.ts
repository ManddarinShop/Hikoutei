/** Read-only effect outbox queries used by worker scheduling and recovery. */

import type { SqlExecutor, SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import type { PendingEffect } from "./effectOutboxContracts.js";
import {
  COUNT_PENDING_OR_PROCESSING_EFFECTS_SQL,
  SELECT_PENDING_EFFECTS_BY_TARGET_SQL,
  SELECT_READY_EFFECTS_SQL,
} from "./effectOutboxSql.js";
import { validateReadyEffectLimit } from "./effectOutboxSupport.js";

/** Reads pending effects for one target stream in sequence order. */
export async function findPendingEffectsByTargetWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  targetKind: string,
  targetId: string,
): Promise<readonly PendingEffect[]> {
  return sql.all<PendingEffect>(SELECT_PENDING_EFFECTS_BY_TARGET_SQL, [
    logicalSheetId,
    targetKind,
    targetId,
  ]);
}

/** Reads one target stream through a fresh adapter read context. */
export async function findPendingEffectsByTargetWithAdapter(
  storage: SqlStorageAdapter,
  logicalSheetId: string,
  targetKind: string,
  targetId: string,
): Promise<readonly PendingEffect[]> {
  return storage.read(({ sql }) => {
    return findPendingEffectsByTargetWithSql(sql, logicalSheetId, targetKind, targetId);
  });
}

/** Reads bounded head-of-line effects across target streams. */
export async function listReadyEffectsWithSql(
  sql: SqlExecutor,
  limit: number,
): Promise<readonly PendingEffect[]> {
  validateReadyEffectLimit(limit);
  return sql.all<PendingEffect>(SELECT_READY_EFFECTS_SQL, [limit]);
}

/** Reads bounded head-of-line effects through a fresh adapter read context. */
export async function listReadyEffectsWithAdapter(
  storage: SqlStorageAdapter,
  limit: number,
): Promise<readonly PendingEffect[]> {
  return storage.read(({ sql }) => listReadyEffectsWithSql(sql, limit));
}

/** Returns whether normal outbox work remains pending or processing. */
export async function hasPendingOrProcessingEffectsWithSql(
  sql: SqlExecutor,
): Promise<boolean> {
  const row = await sql.get<{ count: number }>(COUNT_PENDING_OR_PROCESSING_EFFECTS_SQL);
  return row !== undefined && row.count > 0;
}

/** Checks outbox activity through a fresh adapter read context. */
export async function hasPendingOrProcessingEffectsWithAdapter(
  storage: SqlStorageAdapter,
): Promise<boolean> {
  return storage.read(({ sql }) => hasPendingOrProcessingEffectsWithSql(sql));
}
