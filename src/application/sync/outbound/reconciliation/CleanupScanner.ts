/**
 * Periodic cleanup scanner for the User_Input projection.
 *
 * SQLite is the authority and User_Input is the human input surface; when
 * that surface is corrupted (duplicated business keys or anchors, empty-ID
 * rows, orphan rows) the scan rewrites the tab from SQLite canonical state:
 * bound rows get full-row candidate_reconcile rewrites carrying canonical
 * values, and every surplus row (duplicates beyond the kept row, empty-ID
 * rows, orphans) gets a `user_input_delete` effect carrying the full observed
 * row as its compare-and-set guard. Bound-row corrections stream under the
 * binding key (`projection-row:<sheet>:<binding>`) shared with flush
 * projections and resolution reconciles, so the resolution's
 * supersede-and-replan covers them; unbound rows keep the physical anchor as
 * their stream key. A binding with an OPEN/NEEDS_REBASE conflict (durable
 * active candidate pointer) is never planned: the candidate evidence is
 * re-read after the snapshot and again before effect building, and the
 * conflicted row converges exclusively through resolution. All corrections
 * flow through the durable outbox and the effect worker's CAS-guarded slow
 * path, so cleanup never mutates the Sheet directly and can never touch a
 * row that a human or candidate pipeline changed concurrently.
 *
 * Duplicated-anchor groups are converged one row per scan because the real
 * provider only resolves the first row per anchor value; the group's rewrite
 * is deferred until the group is down to one row. Scope mirrors the
 * System_State reconciliation scanner: one snapshot read, one fenced writer
 * lease, and corrections that flow through the durable outbox. A re-scan of a
 * converged tab enqueues nothing.
 */

import { randomUUID } from "node:crypto";
import { POSITIVE_SAFE_INTEGER_MINIMUM } from "../../../../shared/constants.js";
import {
  claimWriterLeaseWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type FencingContext,
} from "@hikoutei/ikisaki";
import {
  requireRegisteredSyncSheetWithAdapter,
} from "../../../../infrastructure/storage/sync/shared/syncRegistry.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../../../infrastructure/storage/errors.js";
import type { SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import {
  observeSyncSnapshot,
  type SyncSheetsObservationProvider,
} from "../../sheetsContract/syncSheets.js";
import {
  SYNC_PROJECTIONS,
  SYNC_SNAPSHOT_READ_MODES,
} from "../../sheetsContract/constants.js";
import {
  DEFAULT_RECONCILIATION_LEASE_MS,
  DEFAULT_RECONCILIATION_ROLE,
  type ReconciliationIdFactory,
} from "./shared.js";
import { appendEffectsWithSupersedes } from "./enqueue.js";
import {
  buildCleanupEffects,
  classifyCleanupRows,
  decodeCleanupRows,
  readCleanupEvidence,
} from "./cleanup.js";

/** Construction options for a single User_Input cleanup scan. */
export interface RunCleanupScanOptions {
  readonly storage: SqlStorageAdapter;
  readonly provider: SyncSheetsObservationProvider;
  /** Physical sheet id of the User_Input projection to clean. */
  readonly physicalSheetId: string;
  /** Logical sheet id owning the row bindings and evidence. */
  readonly logicalSheetId: string;
  /**
   * Business-key header used to detect duplicated and orphan identities on
   * the User_Input tab. Must be one of the tab's headers.
   */
  readonly identityField: string;
  /** Schema version shared by every cleanup effect produced here. */
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
  readonly onReport?: (report: CleanupScanReport) => void;
}

/** Observable outcome of one User_Input cleanup scan. */
export interface CleanupScanReport {
  readonly physicalSheetId: string;
  readonly rowsScanned: number;
  readonly duplicateRows: number;
  readonly emptyIdRows: number;
  readonly extraRows: number;
  /** Rows rewritten from SQLite canonical state (full-row overwrite). */
  readonly rewrittenRows: number;
  readonly effectsEnqueued: number;
  readonly fenceClaimed: boolean;
}

/**
 * Runs one cleanup scan and enqueues CAS-carrying delete effects for every
 * surplus row. The scan never writes to the Sheet directly.
 */
export async function runUserInputCleanupScan(
  options: RunCleanupScanOptions,
): Promise<CleanupScanReport> {
  validateOptions(options);

  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const role = options.writerRole ?? DEFAULT_RECONCILIATION_ROLE;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_RECONCILIATION_LEASE_MS;

  const context = {
    storage: options.storage,
    provider: options.provider,
    physicalSheetId: options.physicalSheetId,
    logicalSheetId: options.logicalSheetId,
    identityField: options.identityField,
    schemaVersion: options.schemaVersion,
    writerId: options.writerId,
    now,
    createId,
    role,
    leaseDurationMs,
  } as const;

  const report = await scanAndEnqueue(context);

  try {
    options.onReport?.(report);
  } catch {
    // Observability callbacks must never fail the scan.
  }
  return report;
}

interface CleanupScanContext {
  readonly storage: SqlStorageAdapter;
  readonly provider: SyncSheetsObservationProvider;
  readonly physicalSheetId: string;
  readonly logicalSheetId: string;
  readonly identityField: string;
  readonly schemaVersion: number;
  readonly writerId: string;
  readonly now: () => number;
  readonly createId: ReconciliationIdFactory;
  readonly role: string;
  readonly leaseDurationMs: number;
}

async function scanAndEnqueue(context: CleanupScanContext): Promise<CleanupScanReport> {
  const sheet = await requireRegisteredSyncSheetWithAdapter(
    context.storage,
    context.physicalSheetId,
  );
  if (sheet.projection !== SYNC_PROJECTIONS.USER_INPUT) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "cleanup scanner only supports the user_input projection",
    );
  }

  const snapshotRequest = {
    physicalSheetId: context.physicalSheetId,
    sheetName: sheet.tabName,
    registeredRange: sheet.registeredRange,
    projection: SYNC_PROJECTIONS.USER_INPUT,
    schemaVersion: sheet.schemaVersion,
    readMode: SYNC_SNAPSHOT_READ_MODES.FULL,
  } as const;
  const observed = await observeSyncSnapshot(context.provider, snapshotRequest);

  const rows = decodeCleanupRows(observed.snapshot, context.identityField);
  const evidence = await readCleanupEvidence(
    context.storage,
    context.logicalSheetId,
    context.physicalSheetId,
  );
  const targets = classifyCleanupRows(rows, evidence);

  const counts = countTargets(targets);
  if (targets.length === 0) {
    return {
      physicalSheetId: context.physicalSheetId,
      rowsScanned: rows.length,
      duplicateRows: counts.duplicate,
      emptyIdRows: counts.emptyId,
      extraRows: counts.extra,
      rewrittenRows: counts.rewritten,
      effectsEnqueued: 0,
      fenceClaimed: false,
    };
  }

  const fence = await claimReconcilerFence(context);
  if (fence === null) {
    return {
      physicalSheetId: context.physicalSheetId,
      rowsScanned: rows.length,
      duplicateRows: counts.duplicate,
      emptyIdRows: counts.emptyId,
      extraRows: counts.extra,
      rewrittenRows: counts.rewritten,
      effectsEnqueued: 0,
      fenceClaimed: false,
    };
  }

  const plans = await buildCleanupEffects(
    {
      storage: context.storage,
      logicalSheetId: context.logicalSheetId,
      physicalSheetId: context.physicalSheetId,
      schemaVersion: context.schemaVersion,
      identityField: context.identityField,
      createId: context.createId,
    },
    sheet,
    targets,
  );
  if (plans.length === 0) {
    return {
      physicalSheetId: context.physicalSheetId,
      rowsScanned: rows.length,
      duplicateRows: counts.duplicate,
      emptyIdRows: counts.emptyId,
      extraRows: counts.extra,
      rewrittenRows: counts.rewritten,
      effectsEnqueued: 0,
      fenceClaimed: true,
    };
  }

  const enqueued = await appendEffectsWithSupersedes(context.storage, fence, plans);
  return {
    physicalSheetId: context.physicalSheetId,
    rowsScanned: rows.length,
    duplicateRows: counts.duplicate,
    emptyIdRows: counts.emptyId,
    extraRows: counts.extra,
    rewrittenRows: counts.rewritten,
    effectsEnqueued: enqueued ? plans.length : 0,
    fenceClaimed: true,
  };
}

async function claimReconcilerFence(context: CleanupScanContext): Promise<FencingContext | null> {
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

function countTargets(targets: readonly { readonly kind: string }[]): {
  readonly duplicate: number;
  readonly emptyId: number;
  readonly extra: number;
  readonly rewritten: number;
} {
  let duplicate = 0;
  let emptyId = 0;
  let extra = 0;
  let rewritten = 0;
  for (const target of targets) {
    if (target.kind === "duplicate") duplicate += 1;
    else if (target.kind === "empty_id") emptyId += 1;
    else if (target.kind === "extra") extra += 1;
    else rewritten += 1;
  }
  return { duplicate, emptyId, extra, rewritten };
}

function validateOptions(options: RunCleanupScanOptions): void {
  if (options.physicalSheetId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "cleanup scanner requires a physical sheet id",
    );
  }
  if (options.logicalSheetId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "cleanup scanner requires a logical sheet id",
    );
  }
  if (options.identityField.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "cleanup scanner requires an identity field",
    );
  }
  if (
    !Number.isSafeInteger(options.schemaVersion) ||
    options.schemaVersion < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "cleanup scanner schemaVersion must be a positive safe integer",
    );
  }
  if (options.writerId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "cleanup scanner writerId is required",
    );
  }
  if (
    options.leaseDurationMs !== undefined &&
    (!Number.isSafeInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < POSITIVE_SAFE_INTEGER_MINIMUM)
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "cleanup scanner leaseDurationMs must be a positive safe integer",
    );
  }
}
