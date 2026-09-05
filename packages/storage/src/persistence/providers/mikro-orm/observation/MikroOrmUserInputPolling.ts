/**
 * Polls User_Input projections and applies accepted edits to the local entity
 * table through the observation writer.
 *
 * The provider is treated as an untrusted observation source: only rows with a
 * known SQLite business key and literal/blank cells are promoted. Canonical
 * state, field revisions, conflict candidates, and the System_State outbox
 * remain the durable source of truth.
 */

import type {
  ReadSyncTableRowsRequest,
  SyncObservedSnapshot,
  SyncSheetsObservationProvider,
  SyncTableRowsResult,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  emptySyncTimingOperationCounts,
  SYNC_TIMING_SCOPES,
  type SyncTimingSink,
} from "@hikoutei/storage/sync/telemetry/syncTiming.js";
import {
  isSyncSheetsRowChecksReader,
  isSyncSheetsTableReader,
  observeSyncSnapshots,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import type {
  ReadSyncRowChecksRequest,
  SyncRowChecksResult,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  SYNC_PROJECTIONS,
  SYNC_SNAPSHOT_READ_MODES,
} from "@hikoutei/contracts/sheets/constants.js";
import type {
  TypedSheetsEntityMapping,
  TypedSheetsEntityMappingRegistry,
} from "@hikoutei/contracts/sync-orm/mapping/contracts.js";

import {
  requireTypedSheetsEntityProjection,
  typedSheetsEntityProjectionHeaders,
} from "@hikoutei/contracts/sync-orm/mapping/projection.js";
import {
  createTypedSheetsEntityMappingRegistry,
} from "@hikoutei/contracts/sync-orm/mapping/registry.js";

import { resolveTypedSheetsEntityWriterOptions } from "@hikoutei/storage/orm/persistence/flush/flushCoordinator.js";
import type {
  ResolvedWriterOptions,
  TypedSheetsEntityWriterOptions,
} from "@hikoutei/storage/orm/persistence/support/contracts.js";
import {
  claimWriterLeaseWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  writerLeaseHeartbeatStaleBoundMs,
  type FencingContext,
} from "@hikoutei/ikisaki";
import type { PersistObservedRowInput } from "../../../../storage/state/observation/observationWriter.js";
import type {
  SqlStorageAdapter,
} from "@hikoutei/contracts/storage/sql.js";
import {
  TypedSheetsOrmError,
  TYPED_SHEETS_ORM_ERROR_CODES,
} from "@hikoutei/contracts/sync-orm/errors.js";

import type { MikroOrmSqliteAdapter } from "../storage/MikroOrmSqliteAdapter.js";
import {
  readMappedPollingRows,
} from "./MikroOrmUserInputPollingSql.js";
import {
  buildPollingState,
  type MappedPollingState,
} from "./MikroOrmUserInputPollingState.js";
import {
  inspectSnapshot,
  type InvalidRow,
  type PreparedRow,
  type SheetAccumulator,
} from "./MikroOrmUserInputPollingInspection.js";
import { inspectFastPollingTable } from "./MikroOrmUserInputPollingFastPath.js";
import {
  CHECKS_POLLING_DECISION_KINDS,
  inspectChecksPollingTable,
  toRowChecksRequest,
} from "./MikroOrmUserInputPollingChecks.js";
import {
  persistInvalidPollingRows,
  persistPreparedRows,
} from "./MikroOrmUserInputPollingPersistence.js";
import {
  retryOpenMappedConflictsWithAdapter,
} from "@hikoutei/storage/sync/inbound/autoSystemConflictResolution.js";
// P8-C sole-source: all re-exports below (invalid reasons, poll modes,
// report shapes) live in the contracts leaf (userInputPolling.ts); this
// module only re-exports them so existing adapter-internal and test import
// paths stay valid (contracts → adapter is the allowed direction).
export {
  MAPPED_USER_INPUT_POLL_MODES,
  MAPPED_USER_INPUT_INVALID_REASONS,
} from "@hikoutei/contracts/sheets/userInputPolling.js";
export type {
  MappedUserInputPollingMode,
  MappedUserInputPollingSheetReport,
  MappedUserInputPollingReport,
  MappedUserInputInvalidReason,
} from "@hikoutei/contracts/sheets/userInputPolling.js";
import type {
  MappedUserInputPollingMode,
  MappedUserInputPollingSheetReport,
  MappedUserInputPollingReport,
} from "@hikoutei/contracts/sheets/userInputPolling.js";
import { MAPPED_USER_INPUT_POLL_MODES } from "@hikoutei/contracts/sheets/userInputPolling.js";

/** Options for the provider-specific first inbound worker slice. */
export interface PollMappedUserInputWithMikroOrmOptions {
  readonly storage: MikroOrmSqliteAdapter;
  readonly provider: SyncSheetsObservationProvider;
  readonly mappings: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[];
  readonly writer: TypedSheetsEntityWriterOptions;
  readonly physicalSheetIds?: readonly string[];
  /** Full preserves the historical path; adaptive uses the values-only preflight. */
  readonly mode?: MappedUserInputPollingMode;
  /** Forces all selected mappings through the metadata-preserving path. */
  readonly forceFull?: boolean;
  /**
   * Safety-scan cadence lag supplied by the adaptive coordinator. Defaults to
   * zero so non-safety, adaptive, and direct calls report a safe no-lag value.
   */
  readonly safetyScanLagMs?: number;
  /** Optional diagnostics sink for inbound polling phases; never root-facing. */
  readonly onTiming?: SyncTimingSink;
}

/** Metrics that distinguish the cheap preflight from metadata-preserving work. */
interface PollingPassMetrics {
  readonly mode: MappedUserInputPollingMode;
  readonly safetyFullScan: boolean;
  readonly safetyScanLagMs: number;
  readonly fullMetadataTables: number;
  readonly fastPathRowsScanned: number;
  readonly fastPathChangedRows: number;
}

/**
 * Inbound polling phases reported through {@link SyncTimingSink}.
 *
 * Polling observes Sheets without append/update/delete work, so every phase
 * reports empty operation kinds and zeroed counts. Phase names are stable so
 * traces and benchmarks can be compared across builds.
 */
export const POLLING_TIMING_PHASES = {
  CANONICAL_STATE_READ: "canonical_state_read",
  VALUES_ONLY_READ: "values_only_read",
  /** Narrow identity + anchor + check-column band read (the check-column gate). */
  ROW_CHECKS_READ: "row_checks_read",
  FAST_COMPARISON: "fast_comparison",
  FULL_METADATA_OBSERVATION: "full_metadata_observation",
  PERSISTENCE: "persistence",
  POLLING_TOTAL: "polling_total",
  /**
   * Safety-scan cadence lag, reported once per forced full scan. Unlike the
   * other phases, durationMs carries the overdue lag (not an elapsed span).
   */
  SAFETY_SCAN_LAG: "safety_scan_lag",
} as const;

/**
 * Observes mapped User_Input tabs and applies each established row
 * independently. New rows are intentionally left for the insert workflow.
 * Adaptive passes only use values-only reads to find candidates; every
 * candidate still enters the existing full metadata inspector before writes.
 */
export async function pollMappedUserInputWithMikroOrm(
  options: PollMappedUserInputWithMikroOrmOptions,
): Promise<MappedUserInputPollingReport> {
  const startedAt = Date.now();
  const timingSink = options.onTiming;
  const requestedMode = options.mode ?? MAPPED_USER_INPUT_POLL_MODES.FULL;
  const mappings = selectMappings(options.mappings, options.physicalSheetIds);
  const safetyScanLagMs = options.safetyScanLagMs ?? 0;
  if (mappings.length === 0) {
    const report = emptyReport(startedAt, {
      mode: requestedMode,
      safetyFullScan: options.forceFull === true,
      safetyScanLagMs,
      fullMetadataTables: 0,
      fastPathRowsScanned: 0,
      fastPathChangedRows: 0,
    });
    emitPollingTiming(timingSink, POLLING_TIMING_PHASES.POLLING_TOTAL, report.elapsedMs);
    return report;
  }

  // Report the safety-scan cadence lag before any remote work so a safety scan
  // that fails before producing a report still records how overdue it was. The
  // original failure then propagates and the caller keeps its deadline unchanged.
  if (options.forceFull === true) {
    emitPollingTiming(timingSink, POLLING_TIMING_PHASES.SAFETY_SCAN_LAG, safetyScanLagMs);
  }

  const stateReadStartedAt = Date.now();
  const state = await readMappedPollingState(options.storage, mappings);
  emitPollingTiming(
    timingSink,
    POLLING_TIMING_PHASES.CANONICAL_STATE_READ,
    Date.now() - stateReadStartedAt,
  );
  const accumulators = mappings.map((mapping) => createAccumulator(mapping));
  const canUseAdaptivePath = requestedMode === MAPPED_USER_INPUT_POLL_MODES.ADAPTIVE &&
    options.forceFull !== true &&
    isSyncSheetsTableReader(options.provider);

  // Check-column gate (preferred adaptive preflight): when the provider can
  // answer the narrow row-check read, poll ONLY the identity + anchor +
  // check column
  // bands, diff each row against the expected check derived from canonical
  // state, and re-read (metadata-preserving, one batched band request) only
  // the mismatched rows. Tables the gate cannot prove — no provisioned check
  // column (legacy mixed mode) or any identity/canonical anomaly — escalate
  // to the historical whole-table observation UNCHANGED, so every conflict
  // outcome the full read produced is produced here too.
  if (canUseAdaptivePath && isSyncSheetsRowChecksReader(options.provider)) {
    return await pollWithRowChecksGate(
      options,
      options.provider,
      mappings,
      accumulators,
      state,
      startedAt,
      safetyScanLagMs,
    );
  }

  if (canUseAdaptivePath) {
    const valuesReadStartedAt = Date.now();
    const fastResults = await options.provider.readRowsBatch(mappings.map(toTableRowsRequest));
    emitPollingTiming(
      timingSink,
      POLLING_TIMING_PHASES.VALUES_ONLY_READ,
      Date.now() - valuesReadStartedAt,
    );
    assertTableReadCount(fastResults, mappings.length);
    const fullMappings: TypedSheetsEntityMapping[] = [];
    const fullAccumulators: SheetAccumulator[] = [];
    let fastPathRowsScanned = 0;
    let fastPathChangedRows = 0;

    const fastComparisonStartedAt = Date.now();
    for (const [index, mapping] of mappings.entries()) {
      const result = fastResults[index];
      const accumulator = accumulators[index];
      if (result === undefined || accumulator === undefined) continue;
      const decision = inspectFastPollingTable(mapping, result, state);
      fastPathRowsScanned += decision.rowsScanned;
      fastPathChangedRows += decision.changedRows;
      if (decision.needsFullMetadata) {
        fullMappings.push(mapping);
        fullAccumulators.push(accumulator);
        accumulator.rowsScanned = 0;
      } else {
        accumulator.rowsScanned = decision.rowsScanned;
      }
    }
    emitPollingTiming(
      timingSink,
      POLLING_TIMING_PHASES.FAST_COMPARISON,
      Date.now() - fastComparisonStartedAt,
    );

    if (fullMappings.length === 0) {
      await retryDeferredConflicts(options, mappings);
      const report = createPollingReport(startedAt, accumulators, {
        mode: MAPPED_USER_INPUT_POLL_MODES.ADAPTIVE,
        safetyFullScan: false,
        safetyScanLagMs,
        fullMetadataTables: 0,
        fastPathRowsScanned,
        fastPathChangedRows,
      });
      emitPollingTiming(timingSink, POLLING_TIMING_PHASES.POLLING_TOTAL, report.elapsedMs);
      return report;
    }

    const observationStartedAt = Date.now();
    const observed = await observeSyncSnapshots(
      options.provider,
      fullMappings.map(toSnapshotRequest),
    );
    emitPollingTiming(
      timingSink,
      POLLING_TIMING_PHASES.FULL_METADATA_OBSERVATION,
      Date.now() - observationStartedAt,
    );
    assertObservationCount(observed, fullMappings.length);
    const prepared = prepareObservedRows(
      fullMappings,
      observed,
      state,
      fullAccumulators,
    );
    const persistenceStartedAt = Date.now();
    const observedInputs = await persistPreparedRowsIfNeeded(
      options,
      state,
      prepared.preparedRows,
      prepared.invalidRows,
      fullAccumulators,
    );
    emitPollingTiming(
      timingSink,
      POLLING_TIMING_PHASES.PERSISTENCE,
      Date.now() - persistenceStartedAt,
    );
    await retryDeferredConflicts(options, mappings);
    const report = createPollingReport(startedAt, accumulators, {
      mode: MAPPED_USER_INPUT_POLL_MODES.ADAPTIVE,
      safetyFullScan: false,
      safetyScanLagMs,
      fullMetadataTables: fullMappings.length,
      fastPathRowsScanned,
      fastPathChangedRows,
    });
    emitPollingTiming(timingSink, POLLING_TIMING_PHASES.POLLING_TOTAL, report.elapsedMs);
    return report;
  }

  const observationStartedAt = Date.now();
  const observed = await observeSyncSnapshots(
    options.provider,
    mappings.map(toSnapshotRequest),
  );
  emitPollingTiming(
    timingSink,
    POLLING_TIMING_PHASES.FULL_METADATA_OBSERVATION,
    Date.now() - observationStartedAt,
  );
  assertObservationCount(observed, mappings.length);
  const prepared = prepareObservedRows(mappings, observed, state, accumulators);
  const persistenceStartedAt = Date.now();
  const observedInputs = await persistPreparedRowsIfNeeded(
    options,
    state,
    prepared.preparedRows,
    prepared.invalidRows,
    accumulators,
  );
  emitPollingTiming(
    timingSink,
    POLLING_TIMING_PHASES.PERSISTENCE,
    Date.now() - persistenceStartedAt,
  );
  await retryDeferredConflicts(options, mappings);
  const report = createPollingReport(startedAt, accumulators, {
    mode: MAPPED_USER_INPUT_POLL_MODES.FULL,
    safetyFullScan: options.forceFull === true,
    safetyScanLagMs,
    fullMetadataTables: mappings.length,
    fastPathRowsScanned: 0,
    fastPathChangedRows: 0,
  });
  emitPollingTiming(timingSink, POLLING_TIMING_PHASES.POLLING_TOTAL, report.elapsedMs);
  return report;
}

function assertObservationCount(
  observed: readonly SyncObservedSnapshot[],
  expectedCount: number,
): void {
  if (observed.length === expectedCount) return;
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
    "User_Input observation result count does not match the requested mappings.",
  );
}

/**
 * Runs one check-column-gated adaptive polling pass.
 *
 * One narrow band read (identity + anchor + check columns only,
 * values-only mask)
 * preflights every mapped User_Input tab; rows whose computed check
 * mismatches the value derived from canonical SQLite state (with no
 * in-flight delivery of our own write) receive a targeted, metadata-
 * preserving band observation, and identity/anchor/canonical anomalies
 * receive the historical whole-table observation. A fully clean pass
 * therefore never reads a single data column — the gate's whole purpose
 * (measured ~490 B/row of identity+anchor+check bands versus ~1.25 KB/row
 * for the whole-table metadata read it replaces; the live pre-fix polling
 * pass measured 2.95 MB).
 * Every accepted decision path still funnels into the UNCHANGED inspector,
 * evaluator, and persistence code, so conflict semantics cannot drift.
 */
async function pollWithRowChecksGate(
  options: PollMappedUserInputWithMikroOrmOptions,
  provider: Parameters<typeof observeSyncSnapshots>[0] & {
    readRowChecksBatch(
      requests: readonly ReadSyncRowChecksRequest[],
    ): Promise<readonly SyncRowChecksResult[]>;
  },
  mappings: readonly TypedSheetsEntityMapping[],
  accumulators: readonly SheetAccumulator[],
  state: MappedPollingState,
  startedAt: number,
  safetyScanLagMs: number,
): Promise<MappedUserInputPollingReport> {
  const timingSink = options.onTiming;
  const checksReadStartedAt = Date.now();
  const checkResults = await provider.readRowChecksBatch(
    mappings.map(toRowChecksRequest),
  );
  emitPollingTiming(
    timingSink,
    POLLING_TIMING_PHASES.ROW_CHECKS_READ,
    Date.now() - checksReadStartedAt,
  );
  assertRowChecksCount(checkResults, mappings.length);

  const fullMappings: TypedSheetsEntityMapping[] = [];
  const fullAccumulators: SheetAccumulator[] = [];
  const targeted: {
    readonly mapping: TypedSheetsEntityMapping;
    readonly accumulator: SheetAccumulator;
    readonly rowNumbers: readonly number[];
  }[] = [];
  let checksRowsScanned = 0;
  let checksChangedRows = 0;
  const comparisonStartedAt = Date.now();
  for (const [index, mapping] of mappings.entries()) {
    const result = checkResults[index];
    const accumulator = accumulators[index];
    if (result === undefined || accumulator === undefined) continue;
    const decision = inspectChecksPollingTable(mapping, result, state);
    checksRowsScanned += decision.rowsScanned;
    checksChangedRows += decision.changedRows;
    if (
      decision.kind === CHECKS_POLLING_DECISION_KINDS.ESCALATE ||
      decision.kind === CHECKS_POLLING_DECISION_KINDS.TARGETED
    ) {
      // The inspector counts the rows it actually scans (the whole table
      // for an escalation, the targeted bands for a mismatch), exactly the
      // way the values-only preflight resets its scan count before an
      // escalation.
      accumulator.rowsScanned = 0;
    } else {
      accumulator.rowsScanned = decision.rowsScanned;
    }
    if (decision.kind === CHECKS_POLLING_DECISION_KINDS.ESCALATE) {
      fullMappings.push(mapping);
      fullAccumulators.push(accumulator);
    } else if (decision.kind === CHECKS_POLLING_DECISION_KINDS.TARGETED) {
      targeted.push({
        mapping,
        accumulator,
        rowNumbers: decision.rowNumbers,
      });
    }
  }
  emitPollingTiming(
    timingSink,
    POLLING_TIMING_PHASES.FAST_COMPARISON,
    Date.now() - comparisonStartedAt,
  );

  const preparedRows: PreparedRow[] = [];
  const invalidRows: InvalidRow[] = [];
  if (fullMappings.length > 0) {
    const observationStartedAt = Date.now();
    const observed = await observeSyncSnapshots(
      options.provider,
      fullMappings.map(toSnapshotRequest),
    );
    emitPollingTiming(
      timingSink,
      POLLING_TIMING_PHASES.FULL_METADATA_OBSERVATION,
      Date.now() - observationStartedAt,
    );
    assertObservationCount(observed, fullMappings.length);
    const prepared = prepareObservedRows(
      fullMappings,
      observed,
      state,
      fullAccumulators,
    );
    preparedRows.push(...prepared.preparedRows);
    invalidRows.push(...prepared.invalidRows);
  }
  if (targeted.length > 0) {
    // ONE batched observation request carries every targeted tab; each tab
    // is read as its header row plus contiguous row bands over the
    // mismatched rows only (multi-range band, metadata-preserving mask).
    const observationStartedAt = Date.now();
    const observed = await observeSyncSnapshots(
      options.provider,
      targeted.map((entry) => ({
        ...toSnapshotRequest(entry.mapping),
        rowNumbers: entry.rowNumbers,
      })),
    );
    emitPollingTiming(
      timingSink,
      POLLING_TIMING_PHASES.FULL_METADATA_OBSERVATION,
      Date.now() - observationStartedAt,
    );
    assertObservationCount(observed, targeted.length);
    const prepared = prepareObservedRows(
      targeted.map((entry) => entry.mapping),
      observed,
      state,
      targeted.map((entry) => entry.accumulator),
    );
    preparedRows.push(...prepared.preparedRows);
    invalidRows.push(...prepared.invalidRows);
  }

  const persistenceStartedAt = Date.now();
  await persistPreparedRowsIfNeeded(
    options,
    state,
    preparedRows,
    invalidRows,
    [...accumulators],
  );
  emitPollingTiming(
    timingSink,
    POLLING_TIMING_PHASES.PERSISTENCE,
    Date.now() - persistenceStartedAt,
  );
  await retryDeferredConflicts(options, mappings);
  const report = createPollingReport(startedAt, accumulators, {
    mode: MAPPED_USER_INPUT_POLL_MODES.ADAPTIVE,
    safetyFullScan: false,
    safetyScanLagMs,
    fullMetadataTables: fullMappings.length + targeted.length,
    fastPathRowsScanned: checksRowsScanned,
    fastPathChangedRows: checksChangedRows,
  });
  emitPollingTiming(timingSink, POLLING_TIMING_PHASES.POLLING_TOTAL, report.elapsedMs);
  return report;
}

function assertRowChecksCount(
  results: readonly SyncRowChecksResult[],
  expectedCount: number,
): void {
  if (results.length === expectedCount) return;
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
    "User_Input row-check result count does not match the requested mappings.",
  );
}

function assertTableReadCount(
  results: readonly SyncTableRowsResult[],
  expectedCount: number,
): void {
  if (results.length === expectedCount) return;
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
    "User_Input values-only result count does not match the requested mappings.",
  );
}

/**
 * Emits one inbound polling phase. Timing is diagnostic only: a faulty sink
 * must never change canonical reads, observation, or persisted edits. Polling
 * observes Sheets without append/update/delete work, so every phase reports
 * empty operation kinds and zeroed counts.
 */
function emitPollingTiming(
  sink: SyncTimingSink | undefined,
  phase: string,
  durationMs: number,
): void {
  if (sink === undefined) return;
  try {
    sink({
      scope: SYNC_TIMING_SCOPES.POLLING,
      phase,
      durationMs,
      operationKinds: [],
      operationCounts: emptySyncTimingOperationCounts(),
    });
  } catch {
    // Diagnostics must never abort inbound polling.
  }
}

function prepareObservedRows(
  mappings: readonly TypedSheetsEntityMapping[],
  observed: readonly SyncObservedSnapshot[],
  state: MappedPollingState,
  accumulators: readonly SheetAccumulator[],
): { readonly preparedRows: readonly PreparedRow[]; readonly invalidRows: readonly InvalidRow[] } {
  const preparedRows: PreparedRow[] = [];
  const invalidRows: InvalidRow[] = [];
  for (const [index, mapping] of mappings.entries()) {
    const observation = observed[index];
    const accumulator = accumulators[index];
    if (observation === undefined || accumulator === undefined) continue;
    const invalidSnapshotRows = inspectSnapshot(
      mapping,
      observation,
      state,
      accumulator,
      preparedRows,
    );
    accumulator.invalidRows += invalidSnapshotRows.length;
    invalidRows.push(...invalidSnapshotRows);
  }
  return { preparedRows, invalidRows };
}

async function persistPreparedRowsIfNeeded(
  options: PollMappedUserInputWithMikroOrmOptions,
  state: MappedPollingState,
  preparedRows: readonly PreparedRow[],
  invalidRows: readonly InvalidRow[],
  accumulators: readonly SheetAccumulator[],
): Promise<readonly PersistObservedRowInput[]> {
  if (preparedRows.length === 0 && invalidRows.length === 0) return [];
  const writer = resolveTypedSheetsEntityWriterOptions(options.writer);
  const fence = await claimMappedInboundWriterLease(options.storage, writer);
  await persistInvalidPollingRows(
    options.storage,
    writer,
    fence,
    invalidRows,
    accumulators,
  );
  return persistPreparedRows(
    options.storage,
    writer,
    fence,
    state,
    preparedRows,
    accumulators,
  );
}

/** Retries OPEN conflicts whose previous system-wins attempt was deferred. */
async function retryDeferredConflicts(
  options: PollMappedUserInputWithMikroOrmOptions,
  mappings: readonly TypedSheetsEntityMapping[],
): Promise<void> {
  await retryOpenMappedConflictsWithAdapter(
    options.storage,
    mappings,
    resolveTypedSheetsEntityWriterOptions(options.writer),
  );
}

async function claimMappedInboundWriterLease(
  storage: MikroOrmSqliteAdapter,
  writer: ResolvedWriterOptions,
): Promise<FencingContext> {
  const now = writer.now();
  // Mapped-role claim; mirror this site in expireRuntimeWriterLeases (SyncServiceBootstrap).
  // Stale-heartbeat takeover evidence keeps a crash-restart from blocking
  // inbound polling for the full lease window.
  const claim = await claimWriterLeaseWithAdapter(storage, {
    role: writer.role,
    writerId: writer.writerId,
    leaseDurationMs: writer.leaseDurationMs,
    now,
    heartbeatStaleBeforeMs: writerLeaseHeartbeatStaleBoundMs(now),
  });
  if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
      `mapped inbound writer lease is unavailable: ${claim.reason}.`,
    );
  }
  return {
    role: claim.lease.role,
    writerEpoch: claim.lease.writerEpoch,
    fencingToken: claim.lease.fencingToken,
    now,
  };
}

function createPollingReport(
  startedAt: number,
  accumulators: readonly SheetAccumulator[],
  metrics: PollingPassMetrics,
): MappedUserInputPollingReport {
  const sheets = accumulators.map(toSheetReport);
  return {
    elapsedMs: Date.now() - startedAt,
    mode: metrics.mode,
    safetyFullScan: metrics.safetyFullScan,
    safetyScanLagMs: metrics.safetyScanLagMs,
    fullMetadataTables: metrics.fullMetadataTables,
    fastPathRowsScanned: metrics.fastPathRowsScanned,
    fastPathChangedRows: metrics.fastPathChangedRows,
    sheets,
    rowsScanned: sum(sheets, (sheet) => sheet.rowsScanned),
    changedRows: sum(sheets, (sheet) => sheet.changedRows),
    appliedRows: sum(sheets, (sheet) => sheet.appliedRows),
    conflictRows: sum(sheets, (sheet) => sheet.conflictRows),
    quarantinedRows: sum(sheets, (sheet) => sheet.quarantinedRows),
    duplicateRows: sum(sheets, (sheet) => sheet.duplicateRows),
    staleRows: sum(sheets, (sheet) => sheet.staleRows),
    fencedRows: sum(sheets, (sheet) => sheet.fencedRows),
    invalidRows: sum(sheets, (sheet) => sheet.invalidRows),
    unknownBusinessKeyRows: sum(sheets, (sheet) => sheet.unknownBusinessKeyRows),
    duplicateBusinessKeyRows: sum(sheets, (sheet) => sheet.duplicateBusinessKeyRows),
  };
}

function toTableRowsRequest(mapping: TypedSheetsEntityMapping): ReadSyncTableRowsRequest {
  const projection = requireTypedSheetsEntityProjection(
    mapping,
    SYNC_PROJECTIONS.USER_INPUT,
  );
  return {
    physicalSheetId: projection.physicalSheetId,
    sheetName: projection.tabName,
    registeredRange: projection.registeredRange,
    projection: SYNC_PROJECTIONS.USER_INPUT,
    schemaVersion: mapping.schemaVersion,
    headers: typedSheetsEntityProjectionHeaders(
      mapping,
      SYNC_PROJECTIONS.USER_INPUT,
    ),
  };
}

function selectMappings(
  input: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[],
  physicalSheetIds: readonly string[] | undefined,
): readonly TypedSheetsEntityMapping[] {
  const registry = "findByEntityName" in input
    ? input
    : createTypedSheetsEntityMappingRegistry(input);
  const selected = physicalSheetIds === undefined
    ? undefined
    : new Set(physicalSheetIds);
  return registry.mappings.filter((mapping) => {
    const projection = mapping.projections.find(
      (candidate) => candidate.projection === SYNC_PROJECTIONS.USER_INPUT,
    );
    return projection !== undefined && (selected === undefined || selected.has(projection.physicalSheetId));
  });
}

function toSnapshotRequest(mapping: TypedSheetsEntityMapping) {
  const projection = requireTypedSheetsEntityProjection(
    mapping,
    SYNC_PROJECTIONS.USER_INPUT,
  );
  return {
    physicalSheetId: projection.physicalSheetId,
    sheetName: projection.tabName,
    registeredRange: projection.registeredRange,
    projection: SYNC_PROJECTIONS.USER_INPUT,
    schemaVersion: mapping.schemaVersion,
    // Polling must retain formula/merge/error metadata so invalid cells are
    // quarantined instead of being mistaken for literal user edits.
    readMode: SYNC_SNAPSHOT_READ_MODES.FULL,
  } as const;
}

async function readMappedPollingState(
  storage: SqlStorageAdapter,
  mappings: readonly TypedSheetsEntityMapping[],
): Promise<MappedPollingState> {
  return storage.read(async ({ sql }) => {
    const rows = await readMappedPollingRows(sql, mappings);
    return buildPollingState(
      rows.bindings,
      rows.entities,
      rows.fields,
      rows.businessKeys,
      rows.conflicts,
      rows.visible,
      rows.pendingEffects,
    );
  });
}

function createAccumulator(mapping: TypedSheetsEntityMapping): SheetAccumulator {
  return {
    mapping,
    rowsScanned: 0,
    changedRows: 0,
    appliedRows: 0,
    conflictRows: 0,
    quarantinedRows: 0,
    duplicateRows: 0,
    staleRows: 0,
    fencedRows: 0,
    invalidRows: 0,
    unknownBusinessKeyRows: 0,
    duplicateBusinessKeyRows: 0,
  };
}

function toSheetReport(accumulator: SheetAccumulator): MappedUserInputPollingSheetReport {
  return {
    physicalSheetId: requireTypedSheetsEntityProjection(
      accumulator.mapping,
      SYNC_PROJECTIONS.USER_INPUT,
    ).physicalSheetId,
    logicalSheetId: accumulator.mapping.logicalSheetId,
    rowsScanned: accumulator.rowsScanned,
    changedRows: accumulator.changedRows,
    appliedRows: accumulator.appliedRows,
    conflictRows: accumulator.conflictRows,
    quarantinedRows: accumulator.quarantinedRows,
    duplicateRows: accumulator.duplicateRows,
    staleRows: accumulator.staleRows,
    fencedRows: accumulator.fencedRows,
    invalidRows: accumulator.invalidRows,
    unknownBusinessKeyRows: accumulator.unknownBusinessKeyRows,
    duplicateBusinessKeyRows: accumulator.duplicateBusinessKeyRows,
  };
}

function emptyReport(
  startedAt: number,
  metrics: PollingPassMetrics,
): MappedUserInputPollingReport {
  return {
    elapsedMs: Date.now() - startedAt,
    mode: metrics.mode,
    safetyFullScan: metrics.safetyFullScan,
    safetyScanLagMs: metrics.safetyScanLagMs,
    fullMetadataTables: metrics.fullMetadataTables,
    fastPathRowsScanned: metrics.fastPathRowsScanned,
    fastPathChangedRows: metrics.fastPathChangedRows,
    sheets: [],
    rowsScanned: 0,
    changedRows: 0,
    appliedRows: 0,
    conflictRows: 0,
    quarantinedRows: 0,
    duplicateRows: 0,
    staleRows: 0,
    fencedRows: 0,
    invalidRows: 0,
    unknownBusinessKeyRows: 0,
    duplicateBusinessKeyRows: 0,
  };
}

function sum<T>(values: readonly T[], read: (value: T) => number): number {
  return values.reduce((total, value) => total + read(value), 0);
}
