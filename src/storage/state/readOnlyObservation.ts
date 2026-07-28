/**
 * Raw snapshot-ingestion ledger for the read-only Sheet integration phase.
 *
 * It persists authenticated snapshot evidence without creating a canonical
 * event or a Sheet effect.  Later evaluator work can consume the pending
 * observation receipt; a no-write shadow pass therefore never becomes a
 * hidden projection writer.
 */

import { withImmediateTransaction, type DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { STORAGE_ERROR_CODES, StorageError } from "../errors.js";
import {
  isFencingValid,
  isFencingValidWithAdapter,
  isFencingValidWithSql,
  type FencingContext,
} from "../sync/writerLease.js";
import { withSqlSavepoint } from "../sqlite/sqlTransaction.js";
import { PRESENCE_KINDS } from "../../core/state/constants.js";
import type { Presence } from "../../core/state/types.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../adapter/orm/contracts.js";

const READ_OBSERVATION_RECEIPT_SQL = `
  SELECT representative_payload_hash, event_id
  FROM observation_receipt
  WHERE logical_sheet_id = ? AND observation_key = ?
`;

const INSERT_EVENT_OBSERVATION_SQL = `
  INSERT INTO event_observation (
    observation_id, logical_sheet_id, physical_sheet_id, observation_key, event_id,
    source, payload_json, payload_hash, detected_at, received_at, ingress_actor_id,
    editor_actor_id, editor_actor_source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_OBSERVATION_RECEIPT_SQL = `
  INSERT INTO observation_receipt (
    logical_sheet_id, observation_key, representative_payload_hash,
    first_observation_id, last_observation_id, event_id, state,
    first_seen_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?)
`;

const UPDATE_OBSERVATION_RECEIPT_SQL = `
  UPDATE observation_receipt SET last_observation_id = ?, last_seen_at = ?
  WHERE logical_sheet_id = ? AND observation_key = ?
`;

const READ_REGISTERED_OBSERVATION_TARGET_SQL = `
  SELECT physical.enabled AS physical_enabled, physical.logical_sheet_id,
         logical.enabled AS logical_enabled
  FROM physical_sheet_registry AS physical
  JOIN sheet_registry AS logical ON logical.sheet_id = physical.logical_sheet_id
  WHERE physical.physical_sheet_id = ?
`;

/** One normalized snapshot evidence record captured from a registered projection. */
export interface ReadOnlySnapshotObservationInput {
  readonly observationId: string;
  readonly physicalSheetId: string;
  readonly logicalSheetId: string;
  readonly observationKey: string;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly source: "polling" | "onEdit";
  readonly detectedAt: number;
  readonly receivedAt: number;
  readonly ingressActorId: string;
  readonly editorActorId: Presence<string>;
  readonly editorActorSource: "google_active_user" | "unavailable";
}

/** Durable outcome of appending raw, not-yet-evaluated snapshot evidence. */
export type ReadOnlySnapshotObservationResult =
  | { readonly kind: "fenced_out" }
  | { readonly kind: "captured"; readonly observationId: string }
  | { readonly kind: "duplicate"; readonly observationId: string }
  | { readonly kind: "integrity_collision"; readonly observationId: string };

/**
 * Appends a snapshot occurrence and maintains its representative receipt.
 *
 * The same observation key/payload is retained as another occurrence for
 * audit; a different payload under the same key is never silently deduped.
 */
export function persistReadOnlySnapshotObservation(
  db: DatabaseSyncLike,
  fence: FencingContext,
  input: ReadOnlySnapshotObservationInput,
): ReadOnlySnapshotObservationResult {
  validateInput(input);
  if (!isFencingValid(db, fence)) return { kind: "fenced_out" };
  return withImmediateTransaction(db, () => {
    if (!isFencingValid(db, fence)) return { kind: "fenced_out" };
    ensureRegisteredTarget(db, input);
    const receipt = db.prepare(READ_OBSERVATION_RECEIPT_SQL)
      .get(input.logicalSheetId, input.observationKey) as ReceiptRow | undefined;
    const kind = receipt === undefined
      ? "captured"
      : receipt.representative_payload_hash === input.payloadHash
        ? "duplicate"
        : "integrity_collision";
    db.prepare(INSERT_EVENT_OBSERVATION_SQL).run(
      input.observationId,
      input.logicalSheetId,
      input.physicalSheetId,
      input.observationKey,
      receipt?.event_id ?? null,
      input.source,
      input.payloadJson,
      input.payloadHash,
      input.detectedAt,
      input.receivedAt,
      input.ingressActorId,
      input.editorActorId.kind === PRESENCE_KINDS.PRESENT
        ? input.editorActorId.value
        : null,
      input.editorActorSource,
    );
    if (receipt === undefined) {
      db.prepare(INSERT_OBSERVATION_RECEIPT_SQL).run(
        input.logicalSheetId,
        input.observationKey,
        input.payloadHash,
        input.observationId,
        input.observationId,
        input.receivedAt,
        input.receivedAt,
      );
    } else {
      db.prepare(UPDATE_OBSERVATION_RECEIPT_SQL)
        .run(input.observationId, input.receivedAt, input.logicalSheetId, input.observationKey);
    }
    return { kind, observationId: input.observationId };
  });
}

/**
 * Persists raw Sheet observation evidence through the active async adapter.
 *
 * This keeps the observation receipt and event-evidence insert in the same
 * adapter transaction used by the MikroORM-backed runtime. It does not
 * evaluate a user edit or create a projection effect.
 */
export async function persistReadOnlySnapshotObservationWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
  input: ReadOnlySnapshotObservationInput,
): Promise<ReadOnlySnapshotObservationResult> {
  validateInput(input);
  if (!(await isFencingValidWithAdapter(storage, fence))) return { kind: "fenced_out" };
  return storage.transaction(({ sql }) =>
    persistReadOnlySnapshotObservationWithSql(sql, fence, input));
}

/** Persists one raw observation occurrence inside an existing SQL transaction. */
export async function persistReadOnlySnapshotObservationWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: ReadOnlySnapshotObservationInput,
): Promise<ReadOnlySnapshotObservationResult> {
  validateInput(input);
  if (!(await isFencingValidWithSql(sql, fence))) return { kind: "fenced_out" };
  return withSqlSavepoint(sql, "persist_read_only_observation", async () => {
    if (!(await isFencingValidWithSql(sql, fence))) return { kind: "fenced_out" };
    await ensureRegisteredTargetWithSql(sql, input);
    const receipt = await sql.get<ReceiptRow>(READ_OBSERVATION_RECEIPT_SQL, [
      input.logicalSheetId,
      input.observationKey,
    ]);
    const kind = receipt === undefined
      ? "captured"
      : receipt.representative_payload_hash === input.payloadHash
        ? "duplicate"
        : "integrity_collision";
    await sql.run(INSERT_EVENT_OBSERVATION_SQL, [
      input.observationId,
      input.logicalSheetId,
      input.physicalSheetId,
      input.observationKey,
      receipt?.event_id ?? null,
      input.source,
      input.payloadJson,
      input.payloadHash,
      input.detectedAt,
      input.receivedAt,
      input.ingressActorId,
      input.editorActorId.kind === PRESENCE_KINDS.PRESENT
        ? input.editorActorId.value
        : null,
      input.editorActorSource,
    ]);
    if (receipt === undefined) {
      await sql.run(INSERT_OBSERVATION_RECEIPT_SQL, [
        input.logicalSheetId,
        input.observationKey,
        input.payloadHash,
        input.observationId,
        input.observationId,
        input.receivedAt,
        input.receivedAt,
      ]);
    } else {
      await sql.run(UPDATE_OBSERVATION_RECEIPT_SQL, [
        input.observationId,
        input.receivedAt,
        input.logicalSheetId,
        input.observationKey,
      ]);
    }
    return { kind, observationId: input.observationId };
  });
}

interface ReceiptRow {
  readonly representative_payload_hash: string;
  readonly event_id: string | null;
}

function ensureRegisteredTarget(db: DatabaseSyncLike, input: ReadOnlySnapshotObservationInput): void {
  const row = db.prepare(READ_REGISTERED_OBSERVATION_TARGET_SQL)
    .get(input.physicalSheetId) as {
    physical_enabled: number;
    logical_sheet_id: string;
    logical_enabled: number;
  } | undefined;
  if (row === undefined || row.physical_enabled !== 1 || row.logical_enabled !== 1 ||
    row.logical_sheet_id !== input.logicalSheetId) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "read-only snapshot target is not an enabled registered projection",
    );
  }
}

async function ensureRegisteredTargetWithSql(
  sql: SqlExecutor,
  input: ReadOnlySnapshotObservationInput,
): Promise<void> {
  const row = await sql.get<{
    readonly physical_enabled: number;
    readonly logical_sheet_id: string;
    readonly logical_enabled: number;
  }>(READ_REGISTERED_OBSERVATION_TARGET_SQL, [input.physicalSheetId]);
  if (row === undefined || row.physical_enabled !== 1 || row.logical_enabled !== 1 ||
    row.logical_sheet_id !== input.logicalSheetId) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "read-only snapshot target is not an enabled registered projection",
    );
  }
}

function validateInput(input: ReadOnlySnapshotObservationInput): void {
  for (const [label, value] of [
    ["observation ID", input.observationId],
    ["physical sheet ID", input.physicalSheetId],
    ["logical sheet ID", input.logicalSheetId],
    ["observation key", input.observationKey],
    ["payload JSON", input.payloadJson],
    ["payload hash", input.payloadHash],
    ["ingress actor ID", input.ingressActorId],
  ] as const) {
    if (value.length === 0) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_READ_ONLY_OBSERVATION,
        label + " is required",
      );
    }
  }
  if (input.source !== "polling" && input.source !== "onEdit") {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_READ_ONLY_OBSERVATION,
      "invalid observation source",
    );
  }
  for (const [label, value] of [["detectedAt", input.detectedAt], ["receivedAt", input.receivedAt]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_READ_ONLY_OBSERVATION,
        label + " must be a non-negative safe integer",
      );
    }
  }
  if (input.editorActorSource === "google_active_user" &&
    (input.editorActorId.kind !== PRESENCE_KINDS.PRESENT ||
      input.editorActorId.value.length === 0)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_READ_ONLY_OBSERVATION,
      "verified editor source requires an editor actor ID",
    );
  }
  if (input.editorActorSource === "unavailable" &&
    input.editorActorId.kind === PRESENCE_KINDS.PRESENT) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_READ_ONLY_OBSERVATION,
      "unavailable editor source cannot include an editor actor ID",
    );
  }
}
