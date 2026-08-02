/**
 * Polls User_Input projections and applies accepted edits to the local entity
 * table through the observation writer.
 *
 * The gateway is treated as an untrusted observation source: only rows with a
 * known SQLite business key and literal/blank cells are promoted. Canonical
 * state, field revisions, conflict candidates, and the System_State outbox
 * remain the durable source of truth.
 */

import type {
  SyncObservedSnapshot,
  SyncSheetObservationGateway,
} from "../../../../../application/sync/gateway/syncGateway.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
  SYNC_GATEWAY_SNAPSHOT_READ_MODES,
} from "../../../../../application/sync/gateway/constants.js";
import {
  observeSyncSnapshots,
} from "../../../../../application/sync/gateway/syncGateway.js";
import type {
  TypedSheetsEntityMapping,
  TypedSheetsEntityMappingRegistry,
} from "../../../../../application/orm/mapping/entityMapping.js";
import {
  createTypedSheetsEntityMappingRegistry,
  requireTypedSheetsEntityProjection,
} from "../../../../../application/orm/mapping/entityMapping.js";
import { resolveTypedSheetsEntityWriterOptions } from "../../../../../application/orm/persistence/flush/flushCoordinator.js";
import type {
  ResolvedWriterOptions,
  TypedSheetsEntityWriterOptions,
} from "../../../../../application/orm/persistence/support/contracts.js";
import {
  claimWriterLeaseWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type FencingContext,
} from "../../../../../infrastructure/storage/index.js";
import type {
  SqlStorageAdapter,
} from "../../../../../adapter/persistence/contracts/sql.js";
import { TypedSheetsOrmError, TYPED_SHEETS_ORM_ERROR_CODES } from "../../../../../application/orm/errors.js";
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
import {
  persistInvalidPollingRows,
  persistPreparedRows,
} from "./MikroOrmUserInputPollingPersistence.js";
export { MAPPED_USER_INPUT_INVALID_REASONS } from "./MikroOrmUserInputPollingInspection.js";
export type { MappedUserInputInvalidReason } from "./MikroOrmUserInputPollingInspection.js";

/** Per-projection result of one polling pass. */
export interface MappedUserInputPollingSheetReport {
  readonly physicalSheetId: string;
  readonly logicalSheetId: string;
  readonly rowsScanned: number;
  readonly changedRows: number;
  readonly appliedRows: number;
  readonly conflictRows: number;
  readonly quarantinedRows: number;
  readonly duplicateRows: number;
  readonly staleRows: number;
  readonly fencedRows: number;
  readonly invalidRows: number;
  readonly unknownBusinessKeyRows: number;
  readonly duplicateBusinessKeyRows: number;
}

/** Aggregate result for one inbound polling pass. */
export interface MappedUserInputPollingReport {
  readonly elapsedMs: number;
  readonly sheets: readonly MappedUserInputPollingSheetReport[];
  readonly rowsScanned: number;
  readonly changedRows: number;
  readonly appliedRows: number;
  readonly conflictRows: number;
  readonly quarantinedRows: number;
  readonly duplicateRows: number;
  readonly staleRows: number;
  readonly fencedRows: number;
  readonly invalidRows: number;
  readonly unknownBusinessKeyRows: number;
  readonly duplicateBusinessKeyRows: number;
}

/** Options for the provider-specific first inbound worker slice. */
export interface PollMappedUserInputWithMikroOrmOptions {
  readonly storage: MikroOrmSqliteAdapter;
  readonly gateway: SyncSheetObservationGateway;
  readonly mappings: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[];
  readonly writer: TypedSheetsEntityWriterOptions;
  readonly physicalSheetIds?: readonly string[];
}

/**
 * Observes mapped User_Input tabs and applies each established row
 * independently. New rows are intentionally left for the insert workflow.
 */
export async function pollMappedUserInputWithMikroOrm(
  options: PollMappedUserInputWithMikroOrmOptions,
): Promise<MappedUserInputPollingReport> {
  const startedAt = Date.now();
  const mappings = selectMappings(options.mappings, options.physicalSheetIds);
  if (mappings.length === 0) return emptyReport(startedAt);

  const requests = mappings.map(toSnapshotRequest);
  const observed = await observeSyncSnapshots(options.gateway, requests);
  assertObservationCount(observed, mappings.length);
  const state = await readMappedPollingState(options.storage, mappings);
  const accumulators = mappings.map((mapping) => createAccumulator(mapping));
  const prepared = prepareObservedRows(mappings, observed, state, accumulators);
  await persistPreparedRowsIfNeeded(
    options,
    state,
    prepared.preparedRows,
    prepared.invalidRows,
    accumulators,
  );
  return createPollingReport(startedAt, accumulators);
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
): Promise<void> {
  if (preparedRows.length === 0 && invalidRows.length === 0) return;
  const writer = resolveTypedSheetsEntityWriterOptions(options.writer);
  const fence = await claimMappedInboundWriterLease(options.storage, writer);
  await persistInvalidPollingRows(
    options.storage,
    writer,
    fence,
    invalidRows,
    accumulators,
  );
  await persistPreparedRows(
    options.storage,
    writer,
    fence,
    state,
    preparedRows,
    accumulators,
  );
}

async function claimMappedInboundWriterLease(
  storage: MikroOrmSqliteAdapter,
  writer: ResolvedWriterOptions,
): Promise<FencingContext> {
  const now = writer.now();
  const claim = await claimWriterLeaseWithAdapter(storage, {
    role: writer.role,
    writerId: writer.writerId,
    leaseDurationMs: writer.leaseDurationMs,
    now,
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
): MappedUserInputPollingReport {
  const sheets = accumulators.map(toSheetReport);
  return {
    elapsedMs: Date.now() - startedAt,
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
      (candidate) => candidate.projection === SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
    );
    return projection !== undefined && (selected === undefined || selected.has(projection.physicalSheetId));
  });
}

function toSnapshotRequest(mapping: TypedSheetsEntityMapping) {
  const projection = requireTypedSheetsEntityProjection(
    mapping,
    SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
  );
  return {
    physicalSheetId: projection.physicalSheetId,
    sheetName: projection.tabName,
    registeredRange: projection.registeredRange,
    projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
    schemaVersion: mapping.schemaVersion,
    // Polling must retain formula/merge/error metadata so invalid cells are
    // quarantined instead of being mistaken for literal user edits.
    readMode: SYNC_GATEWAY_SNAPSHOT_READ_MODES.FULL,
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
      SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
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

function emptyReport(startedAt: number): MappedUserInputPollingReport {
  return {
    elapsedMs: Date.now() - startedAt,
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
