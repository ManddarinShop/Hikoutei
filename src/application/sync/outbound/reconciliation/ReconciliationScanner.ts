/**
 * Periodic reconciliation scanner for the System_State projection.
 *
 * SQLite is the canonical state; the Sheet is a projection that may drift when
 * the fast-append path skips per-effect CAS, when a spreadsheet owner edits a
 * protected tab, or when a response is lost. This scanner compares the durable
 * desired state against one provider snapshot per scan and, for every drift, it
 * enqueues a normal system_projection effect on the existing outbox. The effect
 * worker then applies the correction through the same slow path (with CAS) used
 * by regular writes, so reconciliation never writes to the Sheet directly.
 *
 * Scope is intentionally limited to System_State in v1: that projection is
 * protected and hidden, so the canonical state is always authoritative and a
 * drift is always a repair target. User_Input reconciliation remains the
 * responsibility of the candidate/conflict pipeline.
 *
 * This module owns the scan lifecycle and orchestration only. Drift detection
 * lives in diff.ts, correction effect generation in repair.ts, and the shared
 * contracts/SQL helpers in shared.ts.
 */

import { randomUUID } from "node:crypto";
import { POSITIVE_SAFE_INTEGER_MINIMUM } from "../../../../domain/index.js";
import {
  appendPendingEffectsWithAdapter,
  claimWriterLeaseWithAdapter,
  requireRegisteredSyncSheetWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type FencingContext,
} from "../../../../infrastructure/storage/index.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../../../infrastructure/storage/errors.js";
import type { SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import {
  observeSyncSnapshot,
  type SyncSheetsSnapshot,
  type SyncSheetsProvider,
} from "../../sheetsContract/syncSheets.js";
import {
  SYNC_PROJECTIONS,
  SYNC_SNAPSHOT_READ_MODES,
} from "../../sheetsContract/constants.js";
import {
  DEFAULT_RECONCILIATION_LEASE_MS,
  DEFAULT_RECONCILIATION_ROLE,
  DEFAULT_SYSTEM_TOMBSTONE_FIELD,
  readDesiredSystemState,
  type DesiredRow,
  type ReconciliationIdFactory,
  type ScanContext,
} from "./shared.js";
import {
  computeDrifts,
  countExtraRows,
  countMatchedRows,
} from "./diff.js";
import { buildCorrectionEffects } from "./repair.js";

export type { ReconciliationIdFactory } from "./shared.js";

/** Construction options for a single reconciliation scan. */
export interface RunReconciliationScanOptions {
  readonly storage: SqlStorageAdapter;
  readonly provider: SyncSheetsProvider;
  /** Physical sheet id of the System_State projection to reconcile. */
  readonly physicalSheetId: string;
  /** Logical sheet id owning the entity row bindings. */
  readonly logicalSheetId: string;
  /**
   * Schema-declared field list for the System_State projection. The scanner
   * reads exactly these fields per row and ignores anything else in the Sheet.
   */
  readonly systemFields: readonly string[];
  /**
   * Field name that encodes a tombstone (soft delete) on the System_State
   * projection. Defaults to `_deleted`; tombstoned rows are dropped from the
   * desired state and re-created if the Sheet still exposes them.
   */
  readonly tombstoneField?: string;
  /** Schema version shared by every System_State effect produced here. */
  readonly schemaVersion: number;
  /** Reconciler writer identity. */
  readonly writerId: string;
  /** Injectable clock and id source for deterministic tests. */
  readonly now?: () => number;
  readonly createId?: ReconciliationIdFactory;
  /** Override the reconciler lease role or duration. */
  readonly writerRole?: string;
  readonly leaseDurationMs?: number;
  /** Observability hook invoked once after the scan settles. */
  readonly onReport?: (report: ReconciliationScanReport) => void;
}

/** Observable outcome of one reconciliation scan. */
export interface ReconciliationScanReport {
  readonly physicalSheetId: string;
  readonly snapshotRowsScanned: number;
  readonly desiredRowsScanned: number;
  readonly matchedRows: number;
  readonly driftedRows: number;
  readonly missingRows: number;
  readonly extraRows: number;
  readonly effectsEnqueued: number;
  readonly fenceClaimed: boolean;
}

/**
 * Runs one reconciliation scan and enqueues correction effects for drift.
 *
 * The scan never writes to the Sheet. It only reads a snapshot and inserts
 * effects into the durable outbox; the existing effect worker applies them.
 */
export async function runReconciliationScan(
  options: RunReconciliationScanOptions,
): Promise<ReconciliationScanReport> {
  validateOptions(options);

  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const tombstoneField = options.tombstoneField ?? (
    options.systemFields.includes(DEFAULT_SYSTEM_TOMBSTONE_FIELD)
      ? DEFAULT_SYSTEM_TOMBSTONE_FIELD
      : undefined
  );
  const role = options.writerRole ?? DEFAULT_RECONCILIATION_ROLE;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_RECONCILIATION_LEASE_MS;

  const report: ReconciliationScanReport = await scanAndEnqueue({
    storage: options.storage,
    provider: options.provider,
    physicalSheetId: options.physicalSheetId,
    logicalSheetId: options.logicalSheetId,
    systemFields: options.systemFields,
    tombstoneField,
    schemaVersion: options.schemaVersion,
    writerId: options.writerId,
    now,
    createId,
    role,
    leaseDurationMs,
  });

  try {
    options.onReport?.(report);
  } catch {
    // Observability callbacks must never fail the scan.
  }
  return report;
}

async function scanAndEnqueue(context: ScanContext): Promise<ReconciliationScanReport> {
  const sheet = await requireRegisteredSyncSheetWithAdapter(
    context.storage,
    context.physicalSheetId,
  );
  if (sheet.projection !== SYNC_PROJECTIONS.SYSTEM_STATE) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "reconciliation scanner only supports the system_state projection",
    );
  }

  const snapshotRequest = {
    physicalSheetId: context.physicalSheetId,
    sheetName: sheet.tabName,
    registeredRange: sheet.registeredRange,
    projection: SYNC_PROJECTIONS.SYSTEM_STATE,
    schemaVersion: sheet.schemaVersion,
    readMode: SYNC_SNAPSHOT_READ_MODES.FULL,
  } as const;
  // Fast append intentionally skips metadata. Reconciliation is the lazy
  // repair point that assigns stable anchors before comparing the snapshot.
  const observed = await observeSyncSnapshot(context.provider, snapshotRequest);
  const snapshot = observed.snapshot;

  const desired = await readDesiredSystemState(context);
  const drifts = computeDrifts({
    snapshot,
    desired,
    systemFields: context.systemFields,
    sheet,
  });

  if (drifts.length === 0) {
    return freezeReport(context.physicalSheetId, snapshot, desired, {
      matched: countMatchedRows(snapshot, desired, sheet.businessKeyField),
      drifted: 0,
      missing: 0,
      extra: countExtraRows(snapshot, desired, sheet.businessKeyField),
      effects: 0,
      fenceClaimed: false,
    });
  }

  const fence = await claimReconcilerFence(context);
  if (fence === null) {
    return freezeReport(context.physicalSheetId, snapshot, desired, {
      matched: countMatchedRows(snapshot, desired, sheet.businessKeyField),
      drifted: drifts.filter((drift) => drift.kind === "drifted").length,
      missing: drifts.filter((drift) => drift.kind === "missing").length,
      extra: 0,
      effects: 0,
      fenceClaimed: false,
    });
  }

  const effects = await buildCorrectionEffects(context, sheet, drifts);
  if (effects.length === 0) {
    return freezeReport(context.physicalSheetId, snapshot, desired, {
      matched: countMatchedRows(snapshot, desired, sheet.businessKeyField),
      drifted: drifts.filter((drift) => drift.kind === "drifted").length,
      missing: drifts.filter((drift) => drift.kind === "missing").length,
      extra: countExtraRows(snapshot, desired, sheet.businessKeyField),
      effects: 0,
      fenceClaimed: true,
    });
  }

  const enqueued = await appendPendingEffectsWithAdapter(context.storage, fence, effects);
  if (!enqueued) {
    return freezeReport(context.physicalSheetId, snapshot, desired, {
      matched: countMatchedRows(snapshot, desired, sheet.businessKeyField),
      drifted: drifts.filter((drift) => drift.kind === "drifted").length,
      missing: drifts.filter((drift) => drift.kind === "missing").length,
      extra: countExtraRows(snapshot, desired, sheet.businessKeyField),
      effects: 0,
      fenceClaimed: true,
    });
  }

  return freezeReport(context.physicalSheetId, snapshot, desired, {
    matched: countMatchedRows(snapshot, desired, sheet.businessKeyField),
    drifted: drifts.filter((drift) => drift.kind === "drifted").length,
    missing: drifts.filter((drift) => drift.kind === "missing").length,
    extra: countExtraRows(snapshot, desired, sheet.businessKeyField),
    effects: effects.length,
    fenceClaimed: true,
  });
}

async function claimReconcilerFence(context: ScanContext): Promise<FencingContext | null> {
  const claim = await claimWriterLeaseWithAdapter(context.storage, {
    role: context.role,
    writerId: context.writerId,
    leaseDurationMs: context.leaseDurationMs,
    now: context.now(),
  });
  if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) return null;
  const lease = claim.lease;
  return {
    role: lease.role,
    writerEpoch: lease.writerEpoch,
    fencingToken: lease.fencingToken,
    now: context.now(),
  };
}

interface ReportDelta {
  readonly matched: number;
  readonly drifted: number;
  readonly missing: number;
  readonly extra: number;
  readonly effects: number;
  readonly fenceClaimed: boolean;
}

function freezeReport(
  physicalSheetId: string,
  snapshot: SyncSheetsSnapshot,
  desired: readonly DesiredRow[],
  delta: ReportDelta,
): ReconciliationScanReport {
  return {
    physicalSheetId,
    snapshotRowsScanned: snapshot.rows.length,
    desiredRowsScanned: desired.length,
    matchedRows: delta.matched,
    driftedRows: delta.drifted,
    missingRows: delta.missing,
    extraRows: delta.extra,
    effectsEnqueued: delta.effects,
    fenceClaimed: delta.fenceClaimed,
  };
}

function validateOptions(options: RunReconciliationScanOptions): void {
  if (options.physicalSheetId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "reconciliation scanner requires a physical sheet id",
    );
  }
  if (options.logicalSheetId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "reconciliation scanner requires a logical sheet id",
    );
  }
  if (options.systemFields.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "reconciliation scanner requires at least one system field",
    );
  }
  if (
    !Number.isSafeInteger(options.schemaVersion) ||
    options.schemaVersion < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "reconciliation scanner schemaVersion must be a positive safe integer",
    );
  }
  if (options.writerId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "reconciliation scanner writerId is required",
    );
  }
  if (
    options.leaseDurationMs !== undefined &&
    (!Number.isSafeInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < POSITIVE_SAFE_INTEGER_MINIMUM)
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "reconciliation scanner leaseDurationMs must be a positive safe integer",
    );
  }
}

// Re-export for callers that want the constants used as defaults.
export const RECONCILIATION_DEFAULTS = {
  ROLE: DEFAULT_RECONCILIATION_ROLE,
  LEASE_MS: DEFAULT_RECONCILIATION_LEASE_MS,
  TOMBSTONE_FIELD: DEFAULT_SYSTEM_TOMBSTONE_FIELD,
} as const;
