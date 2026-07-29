/**
 * Polls User_Input projections and applies accepted edits to the local entity
 * table through the observation writer.
 *
 * The gateway is treated as an untrusted observation source: only rows with a
 * known SQLite business key and literal/blank cells are promoted. Canonical
 * state, field revisions, conflict candidates, and the System_State outbox
 * remain the durable source of truth.
 */

import {
  APPLICABILITY_KINDS,
  CANONICAL_RESOLUTION_STATUSES,
  CELL_OBSERVATION_KINDS,
  CONFLICT_STATUSES,
  FIELD_OWNERSHIPS,
  PRESENCE_KINDS,
  ROW_BINDING_STATES,
  ROW_OPERATIONS,
  computeEventKey,
  computeRowHash,
  evaluateBatch,
  stableHash,
  type CanonicalEntityState,
  type CanonicalResolution,
  type EvaluationContext,
  type CanonicalFieldState,
  type NormalizedCell,
  type NormalizedRowField,
  type ObservedEditBatch,
  type ObservedExistingRowChange,
  type Presence,
  type RowBindingContext,
  type RowEvaluationResult,
  type SyncConflict,
} from "../../../../../domain/index.js";
import type {
  SyncGatewaySnapshot,
  SyncObservedSnapshot,
  SyncSheetObservationGateway,
  SyncSnapshotCell,
  SyncSnapshotRow,
} from "../../../../../application/sync/gateway/syncGateway.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
  SYNC_GATEWAY_PROTOCOL_VERSIONS,
  SYNC_GATEWAY_SNAPSHOT_READ_MODES,
} from "../../../../../application/sync/gateway/constants.js";
import {
  observeSyncSnapshots,
} from "../../../../../application/sync/gateway/syncGateway.js";
import type {
  TypedSheetsEntityFieldMapping,
  TypedSheetsEntityMapping,
  TypedSheetsEntityMappingRegistry,
} from "../../../../../application/orm/mapping/entityMapping.js";
import {
  createTypedSheetsEntityMappingRegistry,
  createTypedSheetsEntityOwnershipManifest,
  requireTypedSheetsEntityProjection,
  typedSheetsEntityProjectionHeaders,
} from "../../../../../application/orm/mapping/entityMapping.js";
import {
  projectionEffects,
} from "../../../../../application/orm/persistence/projection/projectionEffects.js";
import { resolveTypedSheetsEntityWriterOptions } from "../../../../../application/orm/persistence/flush/flushCoordinator.js";
import { identifiedValue } from "../../../../../application/orm/persistence/support/helpers.js";
import type {
  ResolvedWriterOptions,
  TypedSheetsEntityWriterOptions,
} from "../../../../../application/orm/persistence/support/contracts.js";
import {
  claimWriterLeaseWithAdapter,
  createTypedSheetsPersistenceContext,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type BusinessKeyChange,
  type CanonicalRowMutation,
  type FencingContext,
  type PersistObservedRowInput,
  type PersistObservedRowResult,
} from "../../../../../infrastructure/storage/index.js";
import { OBSERVATION_WRITE_RESULT_KINDS } from "../../../../../infrastructure/storage/state/observation/observationConstants.js";
import { auditJson } from "../../../../../infrastructure/storage/state/observation/observationAudit.js";
import {
  parseNormalizedCell,
  requireConflictStatus,
} from "../../../../../infrastructure/storage/state/resolution/resolutionWriterHelpers.js";
import type { SqlStorageAdapter } from "../../../../../adapter/persistence/contracts/sql.js";
import { TypedSheetsOrmError, TYPED_SHEETS_ORM_ERROR_CODES } from "../../../../../application/orm/errors.js";
import type { MikroOrmSqliteAdapter } from "../storage/MikroOrmSqliteAdapter.js";
import { persistMappedObservedRowWithMikroOrm } from "./MikroOrmMappedObservation.js";
import { NORMALIZED_CELL_KINDS } from "../../../../../shared/encoding/constants.js";

/** Stable reasons for a User_Input row that cannot enter the evaluator. */
export const MAPPED_USER_INPUT_INVALID_REASONS = {
  UNKNOWN_BUSINESS_KEY: "unknown_business_key",
  DUPLICATE_BUSINESS_KEY: "duplicate_business_key",
  NON_LITERAL_CELL: "non_literal_cell",
  MISSING_CELL: "missing_cell",
  INVALID_CELL: "invalid_cell",
  MISSING_CANONICAL_STATE: "missing_canonical_state",
  PRIMARY_KEY_MUTATION: "primary_key_mutation",
} as const;

export type MappedUserInputInvalidReason =
  (typeof MAPPED_USER_INPUT_INVALID_REASONS)[keyof typeof MAPPED_USER_INPUT_INVALID_REASONS];

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

interface RowBindingSqlRow {
  readonly row_binding_id: string;
  readonly logical_sheet_id: string;
  readonly anchor_reference: string;
  readonly entity_id: string | null;
  readonly state: string;
  readonly candidate_epoch: number;
}

interface EntitySqlRow {
  readonly entity_id: string;
  readonly entity_revision: number;
  readonly status: string;
}

interface EntityFieldSqlRow {
  readonly entity_id: string;
  readonly field_name: string;
  readonly normalized_value: string;
  readonly field_revision: number;
}

interface BusinessKeySqlRow {
  readonly logical_sheet_id: string;
  readonly field_name: string;
  readonly normalized_key: string;
  readonly entity_id: string;
  readonly state: string;
}

interface ConflictSqlRow {
  readonly conflict_id: string;
  readonly conflict_group_id: string | null;
  readonly event_id: string;
  readonly logical_sheet_id: string;
  readonly entity_id: string;
  readonly row_binding_id: string;
  readonly field_name: string;
  readonly user_value: string;
  readonly user_base_revision: number;
  readonly canonical_value_at_detection: string;
  readonly canonical_revision_at_detection: number;
  readonly current_canonical_value: string;
  readonly current_canonical_revision: number;
  readonly candidate_epoch: number;
  readonly status: string;
  readonly resolution_command_id: string | null;
}

interface VisibleStateSqlRow {
  readonly physical_sheet_id: string;
  readonly row_binding_id: string;
  readonly confirmed_visible_revision: number;
  readonly confirmed_entity_revision: number | null;
}

interface VisibleProjectionState {
  readonly confirmedVisibleRevision: number;
  readonly confirmedEntityRevision: number | null;
}

interface MappedPollingState {
  readonly bindingsByEntityId: ReadonlyMap<string, ReadonlyMap<string, RowBindingStateRecord>>;
  readonly entitiesById: ReadonlyMap<string, EntityStateRecord>;
  readonly businessKeysByLogicalAndField: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, string>>>;
  readonly conflictsByBindingAndField: ReadonlyMap<string, ReadonlyMap<string, SyncConflict>>;
  readonly visibleRevisionsByPhysicalAndBinding: ReadonlyMap<string, ReadonlyMap<string, VisibleProjectionState>>;
}

interface RowBindingStateRecord {
  readonly rowBindingId: string;
  readonly logicalSheetId: string;
  readonly anchorReference: string;
  readonly entityId: string | null;
  readonly state: RowBindingContext["bindingState"];
  readonly candidateEpoch: number;
}

interface EntityStateRecord {
  readonly entityId: string;
  readonly entityRevision: number;
  readonly status: "active" | "tombstoned";
  readonly fields: ReadonlyMap<string, CanonicalFieldRecord>;
}

interface CanonicalFieldRecord {
  readonly value: NormalizedCell;
  readonly fieldRevision: number;
}

interface PreparedRow {
  readonly mapping: TypedSheetsEntityMapping;
  readonly snapshot: SyncGatewaySnapshot;
  readonly snapshotHash: string;
  readonly snapshotRow: SyncSnapshotRow;
  readonly binding: RowBindingStateRecord;
  readonly canonical: EntityStateRecord;
  readonly row: ObservedExistingRowChange;
}

interface InvalidRow {
  readonly mapping: TypedSheetsEntityMapping;
  readonly rowNumber: number;
  readonly reason: MappedUserInputInvalidReason;
}

interface SheetAccumulator {
  readonly mapping: TypedSheetsEntityMapping;
  rowsScanned: number;
  changedRows: number;
  appliedRows: number;
  conflictRows: number;
  quarantinedRows: number;
  duplicateRows: number;
  staleRows: number;
  fencedRows: number;
  invalidRows: number;
  unknownBusinessKeyRows: number;
  duplicateBusinessKeyRows: number;
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
  if (observed.length !== mappings.length) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "User_Input observation result count does not match the requested mappings.",
    );
  }

  const state = await readMappedPollingState(options.storage, mappings);
  const accumulators = mappings.map((mapping) => createAccumulator(mapping));
  const preparedRows: PreparedRow[] = [];
  for (const [index, mapping] of mappings.entries()) {
    const observation = observed[index];
    if (observation === undefined) continue;
    const accumulator = accumulators[index]!;
    const invalidRows = inspectSnapshot(
      mapping,
      observation,
      state,
      accumulator,
      preparedRows,
    );
    accumulator.invalidRows += invalidRows.length;
  }

  if (preparedRows.length > 0) {
    const writer = resolveTypedSheetsEntityWriterOptions(options.writer);
    const now = writer.now();
    const claim = await claimWriterLeaseWithAdapter(options.storage, {
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
    const fence: FencingContext = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now,
    };
    await persistPreparedRows(options.storage, writer, fence, state, preparedRows, accumulators);
  }

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
    readMode: SYNC_GATEWAY_SNAPSHOT_READ_MODES.USER_INPUT,
  } as const;
}

async function readMappedPollingState(
  storage: SqlStorageAdapter,
  mappings: readonly TypedSheetsEntityMapping[],
): Promise<MappedPollingState> {
  const logicalSheetIds = unique(mappings.map((mapping) => mapping.logicalSheetId));
  const physicalSheetIds = unique(mappings.map((mapping) => requireTypedSheetsEntityProjection(
    mapping,
    SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
  ).physicalSheetId));
  return storage.read(async ({ sql }) => {
    const bindings = await sql.all<RowBindingSqlRow>(
      `SELECT row_binding_id, logical_sheet_id, anchor_reference, entity_id, state, candidate_epoch
       FROM row_binding
       WHERE logical_sheet_id IN (${placeholders(logicalSheetIds)})`,
      logicalSheetIds,
    );
    const entityIds = unique(bindings.flatMap((binding) =>
      binding.entity_id === null ? [] : [binding.entity_id],
    ));
    const entities = entityIds.length === 0
      ? []
      : await sql.all<EntitySqlRow>(
        `SELECT entity_id, entity_revision, status
         FROM entity_state
         WHERE entity_id IN (${placeholders(entityIds)})`,
        entityIds,
      );
    const fields = entityIds.length === 0
      ? []
      : await sql.all<EntityFieldSqlRow>(
        `SELECT entity_id, field_name, normalized_value, field_revision
         FROM entity_field_state
         WHERE entity_id IN (${placeholders(entityIds)})`,
        entityIds,
      );
    const businessKeys = await sql.all<BusinessKeySqlRow>(
      `SELECT logical_sheet_id, field_name, normalized_key, entity_id, state
       FROM business_key_index
       WHERE logical_sheet_id IN (${placeholders(logicalSheetIds)})`,
      logicalSheetIds,
    );
    const bindingIds = bindings.map((binding) => binding.row_binding_id);
    const conflicts = bindingIds.length === 0
      ? []
      : await sql.all<ConflictSqlRow>(
        `SELECT conflict_id, conflict_group_id, event_id, logical_sheet_id, entity_id,
                row_binding_id, field_name, user_value, user_base_revision,
                canonical_value_at_detection, canonical_revision_at_detection,
                current_canonical_value, current_canonical_revision, candidate_epoch,
                status, resolution_command_id
         FROM sync_conflict
         WHERE row_binding_id IN (${placeholders(bindingIds)})
           AND status IN ('${CONFLICT_STATUSES.OPEN}', '${CONFLICT_STATUSES.NEEDS_REBASE}')`,
        bindingIds,
      );
    const visible = await sql.all<VisibleStateSqlRow>(
      `SELECT physical_sheet_id, row_binding_id, confirmed_visible_revision,
              confirmed_entity_revision
       FROM sheet_visible_state
       WHERE projection = ? AND physical_sheet_id IN (${placeholders(physicalSheetIds)})`,
      [SYNC_GATEWAY_PROJECTIONS.USER_INPUT, ...physicalSheetIds],
    );
    return buildPollingState(bindings, entities, fields, businessKeys, conflicts, visible);
  });
}

function buildPollingState(
  bindingRows: readonly RowBindingSqlRow[],
  entityRows: readonly EntitySqlRow[],
  fieldRows: readonly EntityFieldSqlRow[],
  businessKeyRows: readonly BusinessKeySqlRow[],
  conflictRows: readonly ConflictSqlRow[],
  visibleRows: readonly VisibleStateSqlRow[],
): MappedPollingState {
  const fieldsByEntity = new Map<string, Map<string, CanonicalFieldRecord>>();
  for (const row of fieldRows) {
    const fields = fieldsByEntity.get(row.entity_id) ?? new Map();
    fields.set(row.field_name, {
      value: parseNormalizedCell(row.normalized_value, `${row.entity_id}.${row.field_name}`),
      fieldRevision: row.field_revision,
    });
    fieldsByEntity.set(row.entity_id, fields);
  }

  const entitiesById = new Map<string, EntityStateRecord>();
  for (const row of entityRows) {
    if (row.status !== "active" && row.status !== "tombstoned") {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
        `unknown canonical entity status: ${row.status}.`,
      );
    }
    entitiesById.set(row.entity_id, {
      entityId: row.entity_id,
      entityRevision: row.entity_revision,
      status: row.status,
      fields: fieldsByEntity.get(row.entity_id) ?? new Map(),
    });
  }

  const bindingsByEntityId = new Map<string, Map<string, RowBindingStateRecord>>();
  for (const row of bindingRows) {
    if (!isRowBindingState(row.state)) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
        `unknown row binding state: ${row.state}.`,
      );
    }
    const record: RowBindingStateRecord = {
      rowBindingId: row.row_binding_id,
      logicalSheetId: row.logical_sheet_id,
      anchorReference: row.anchor_reference,
      entityId: row.entity_id,
      state: row.state,
      candidateEpoch: row.candidate_epoch,
    };
    if (row.entity_id !== null) {
      const byEntityId = bindingsByEntityId.get(row.logical_sheet_id) ?? new Map();
      byEntityId.set(row.entity_id, record);
      bindingsByEntityId.set(row.logical_sheet_id, byEntityId);
    }
  }

  const businessKeysByLogicalAndField = new Map<string, Map<string, Map<string, string>>>();
  for (const row of businessKeyRows) {
    if (row.state !== "active") continue;
    const byField = businessKeysByLogicalAndField.get(row.logical_sheet_id) ?? new Map();
    const byKey = byField.get(row.field_name) ?? new Map();
    byKey.set(row.normalized_key, row.entity_id);
    byField.set(row.field_name, byKey);
    businessKeysByLogicalAndField.set(row.logical_sheet_id, byField);
  }

  const conflictsByBindingAndField = new Map<string, Map<string, SyncConflict>>();
  for (const row of conflictRows) {
    const byField = conflictsByBindingAndField.get(row.row_binding_id) ?? new Map();
    byField.set(row.field_name, {
      conflictId: row.conflict_id,
      conflictGroupId: nullablePresence(row.conflict_group_id),
      eventId: row.event_id,
      rowBindingId: row.row_binding_id,
      entityId: row.entity_id,
      fieldName: row.field_name,
      userValue: parseNormalizedCell(row.user_value, `${row.conflict_id}.user_value`),
      userBaseRevision: row.user_base_revision,
      canonicalValueAtDetection: parseNormalizedCell(
        row.canonical_value_at_detection,
        `${row.conflict_id}.canonical_value_at_detection`,
      ),
      canonicalRevisionAtDetection: row.canonical_revision_at_detection,
      currentCanonicalValue: parseNormalizedCell(
        row.current_canonical_value,
        `${row.conflict_id}.current_canonical_value`,
      ),
      currentCanonicalRevision: row.current_canonical_revision,
      candidateEpoch: row.candidate_epoch,
      status: requireConflictStatus(row.status),
      resolutionCommandId: nullablePresence(row.resolution_command_id),
    });
    conflictsByBindingAndField.set(row.row_binding_id, byField);
  }

  const visibleRevisionsByPhysicalAndBinding = new Map<string, Map<string, VisibleProjectionState>>();
  for (const row of visibleRows) {
    const byBinding = visibleRevisionsByPhysicalAndBinding.get(row.physical_sheet_id) ?? new Map();
    byBinding.set(row.row_binding_id, {
      confirmedVisibleRevision: row.confirmed_visible_revision,
      confirmedEntityRevision: row.confirmed_entity_revision,
    });
    visibleRevisionsByPhysicalAndBinding.set(row.physical_sheet_id, byBinding);
  }
  return {
    bindingsByEntityId,
    entitiesById,
    businessKeysByLogicalAndField,
    conflictsByBindingAndField,
    visibleRevisionsByPhysicalAndBinding,
  };
}

function inspectSnapshot(
  mapping: TypedSheetsEntityMapping,
  observed: SyncObservedSnapshot,
  state: MappedPollingState,
  accumulator: SheetAccumulator,
  preparedRows: PreparedRow[],
): readonly InvalidRow[] {
  const snapshot = observed.snapshot;
  const projection = requireTypedSheetsEntityProjection(
    mapping,
    SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
  );
  const expectedHeaders = typedSheetsEntityProjectionHeaders(
    mapping,
    SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
  );
  validateSnapshotRoute(mapping, snapshot, expectedHeaders, projection);
  const observedSnapshotHash = snapshotHash(snapshot);
  const businessKeyField = mapping.businessKey;
  const duplicateBusinessKeys = duplicateBusinessKeysForSnapshot(snapshot, businessKeyField);
  const byBusinessKey = state.businessKeysByLogicalAndField
    .get(mapping.logicalSheetId)
    ?.get(businessKeyField.fieldName) ?? new Map();
  const byEntityId = state.bindingsByEntityId.get(mapping.logicalSheetId) ?? new Map();
  const visibleByBinding = state.visibleRevisionsByPhysicalAndBinding.get(projection.physicalSheetId)
    ?? new Map();
  const invalidRows: InvalidRow[] = [];

  for (const snapshotRow of snapshot.rows) {
    accumulator.rowsScanned += 1;
    const identityCell = snapshotRow.cells[businessKeyField.fieldName];
    const identityValidation = validateSnapshotCell(businessKeyField, identityCell);
    if (identityValidation !== undefined) {
      invalidRows.push({
        mapping,
        rowNumber: snapshotRow.rowNumber,
        reason: identityValidation,
      });
      continue;
    }
    const identity = identityCell?.normalizedCell;
    if (identity === null || identity === undefined) {
      invalidRows.push({
        mapping,
        rowNumber: snapshotRow.rowNumber,
        reason: MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL,
      });
      continue;
    }
    const normalizedBusinessKey = stableHash(identity);
    if (duplicateBusinessKeys.has(normalizedBusinessKey)) {
      accumulator.duplicateBusinessKeyRows += 1;
      invalidRows.push({
        mapping,
        rowNumber: snapshotRow.rowNumber,
        reason: MAPPED_USER_INPUT_INVALID_REASONS.DUPLICATE_BUSINESS_KEY,
      });
      continue;
    }
    const entityId = byBusinessKey.get(normalizedBusinessKey);
    if (entityId === undefined) {
      accumulator.unknownBusinessKeyRows += 1;
      invalidRows.push({
        mapping,
        rowNumber: snapshotRow.rowNumber,
        reason: MAPPED_USER_INPUT_INVALID_REASONS.UNKNOWN_BUSINESS_KEY,
      });
      continue;
    }
    const binding = byEntityId.get(entityId);
    if (binding === undefined || binding.entityId === null) {
      accumulator.unknownBusinessKeyRows += 1;
      invalidRows.push({
        mapping,
        rowNumber: snapshotRow.rowNumber,
        reason: MAPPED_USER_INPUT_INVALID_REASONS.UNKNOWN_BUSINESS_KEY,
      });
      continue;
    }
    const canonical = state.entitiesById.get(binding.entityId);
    if (binding.state !== ROW_BINDING_STATES.ACTIVE || canonical === undefined || canonical.status !== "active") {
      invalidRows.push({
        mapping,
        rowNumber: snapshotRow.rowNumber,
        reason: MAPPED_USER_INPUT_INVALID_REASONS.MISSING_CANONICAL_STATE,
      });
      continue;
    }
    const visibleState = visibleByBinding.get(binding.rowBindingId);
    const row = normalizeExistingRow(
      mapping,
      snapshotRow,
      binding,
      canonical,
      visibleState,
    );
    if (row.kind === "invalid") {
      invalidRows.push({ mapping, rowNumber: snapshotRow.rowNumber, reason: row.reason });
      continue;
    }
    if (row.kind === "unchanged") continue;
    accumulator.changedRows += 1;
    preparedRows.push({
      mapping,
      snapshot,
      snapshotHash: observedSnapshotHash,
      snapshotRow,
      binding,
      canonical,
      row: row.row,
    });
  }
  return invalidRows;
}

type NormalizedRowResult =
  | { readonly kind: "unchanged" }
  | { readonly kind: "invalid"; readonly reason: MappedUserInputInvalidReason }
  | { readonly kind: "changed"; readonly row: ObservedExistingRowChange };

function normalizeExistingRow(
  mapping: TypedSheetsEntityMapping,
  snapshotRow: SyncSnapshotRow,
  binding: RowBindingStateRecord,
  canonical: EntityStateRecord,
  visibleState: VisibleProjectionState | undefined,
): NormalizedRowResult {
  const beforeFields = new Map<string, NormalizedRowField>();
  const afterFields = new Map<string, NormalizedRowField>();
  const changes: ObservedExistingRowChange["fields"] extends readonly (infer Field)[] ? Field[] : never = [];
  let changed = false;
  const userFields = mapping.fields.filter((field) => field.ownership === FIELD_OWNERSHIPS.USER);
  // The current schema records the entity revision visible when the row was
  // last materialized, but not each field revision. If canonical state has
  // advanced since then, force a field-level conflict rather than accepting a
  // candidate whose exact field baseline cannot be reconstructed safely.
  const forceConflict = visibleState === undefined ||
    visibleState.confirmedEntityRevision === null ||
    visibleState.confirmedEntityRevision < canonical.entityRevision;
  for (const field of userFields) {
    const canonicalField = canonical.fields.get(field.fieldName);
    if (canonicalField === undefined) {
      return { kind: "invalid", reason: MAPPED_USER_INPUT_INVALID_REASONS.MISSING_CANONICAL_STATE };
    }
    const observedCell = snapshotRow.cells[field.fieldName];
    const validation = validateSnapshotCell(field, observedCell);
    if (validation !== undefined) return { kind: "invalid", reason: validation };
    const nextValue = observedCell!.normalizedCell;
    const baseFieldRevision = {
      kind: APPLICABILITY_KINDS.APPLICABLE,
      value: forceConflict ? 0 : canonicalField.fieldRevision,
    } as const;
    beforeFields.set(field.fieldName, {
      fieldName: field.fieldName,
      cell: canonicalField.value,
      baseFieldRevision,
    });
    afterFields.set(field.fieldName, {
      fieldName: field.fieldName,
      cell: nextValue,
      baseFieldRevision,
    });
    if (stableHash(canonicalField.value) === stableHash(nextValue)) continue;
    if (field.property === mapping.primaryKey) {
      return { kind: "invalid", reason: MAPPED_USER_INPUT_INVALID_REASONS.PRIMARY_KEY_MUTATION };
    }
    changed = true;
    changes.push({
      fieldName: field.fieldName,
      previousValue: canonicalField.value,
      nextValue,
      baseFieldRevision: forceConflict ? 0 : canonicalField.fieldRevision,
    });
  }
  if (!changed) return { kind: "unchanged" };
  return {
    kind: "changed",
    row: {
      rowBindingId: binding.rowBindingId,
      operation: ROW_OPERATIONS.UPDATE,
      beforeRow: { rowBindingId: binding.rowBindingId, fields: beforeFields },
      afterRow: { rowBindingId: binding.rowBindingId, fields: afterFields },
      baseVisibleRevision: visibleState?.confirmedVisibleRevision ?? 0,
      baseEntityRevision: canonical.entityRevision,
      fields: changes,
    },
  };
}

function validateSnapshotCell(
  field: TypedSheetsEntityFieldMapping,
  cell: SyncSnapshotCell | undefined,
): MappedUserInputInvalidReason | undefined {
  if (cell === undefined) return MAPPED_USER_INPUT_INVALID_REASONS.MISSING_CELL;
  if (cell.cellKind !== CELL_OBSERVATION_KINDS.LITERAL && cell.cellKind !== CELL_OBSERVATION_KINDS.BLANK) {
    return MAPPED_USER_INPUT_INVALID_REASONS.NON_LITERAL_CELL;
  }
  if (cell.cellKind === CELL_OBSERVATION_KINDS.BLANK && cell.normalizedCell !== null) {
    return MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL;
  }
  const value = cell.normalizedCell;
  if (value === null) {
    return field.required ? MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL : undefined;
  }
  if (value.kind !== field.cellKind) return MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL;
  switch (value.kind) {
    case NORMALIZED_CELL_KINDS.STRING:
      return field.required && value.value.length === 0
        ? MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL
        : undefined;
    case NORMALIZED_CELL_KINDS.NUMBER:
      return Number.isFinite(value.value) ? undefined : MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL;
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return undefined;
    case NORMALIZED_CELL_KINDS.DATE:
      return isCanonicalDate(value.value) ? undefined : MAPPED_USER_INPUT_INVALID_REASONS.INVALID_CELL;
  }
}

function validateSnapshotRoute(
  mapping: TypedSheetsEntityMapping,
  snapshot: SyncGatewaySnapshot,
  expectedHeaders: readonly string[],
  projection: ReturnType<typeof requireTypedSheetsEntityProjection>,
): void {
  if (
    snapshot.protocolVersion !== SYNC_GATEWAY_PROTOCOL_VERSIONS.V1 ||
    snapshot.sheetName !== projection.tabName ||
    snapshot.registeredRange !== projection.registeredRange ||
    snapshot.projection !== SYNC_GATEWAY_PROJECTIONS.USER_INPUT ||
    snapshot.schemaVersion !== mapping.schemaVersion ||
    snapshot.headers.length !== expectedHeaders.length ||
    snapshot.headers.some((header, index) => header !== expectedHeaders[index])
  ) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `User_Input snapshot does not match the registered route ${projection.physicalSheetId}.`,
    );
  }
}

async function persistPreparedRows(
  storage: MikroOrmSqliteAdapter,
  writer: ResolvedWriterOptions,
  fence: FencingContext,
  state: MappedPollingState,
  rows: readonly PreparedRow[],
  accumulators: readonly SheetAccumulator[],
): Promise<void> {
  for (const [index, prepared] of rows.entries()) {
    const accumulator = accumulators.find((candidate) => candidate.mapping === prepared.mapping);
    if (accumulator === undefined) continue;
    const input = await createPersistInput(storage, writer, state, prepared);
    const result = await persistMappedObservedRowWithMikroOrm(storage, {
      mappings: [prepared.mapping],
      fence,
      input,
    });
    classifyResult(accumulator, result);
    if (result.kind === OBSERVATION_WRITE_RESULT_KINDS.FENCED_OUT) {
      accumulator.fencedRows += rows.length - index - 1;
      return;
    }
  }
}

async function createPersistInput(
  storage: MikroOrmSqliteAdapter,
  writer: ResolvedWriterOptions,
  state: MappedPollingState,
  prepared: PreparedRow,
): Promise<PersistObservedRowInput> {
  const batch: ObservedEditBatch = {
    batchId: `batch:user_input:${prepared.mapping.logicalSheetId}:${prepared.snapshotHash}`,
    source: "polling",
    sheetId: prepared.mapping.logicalSheetId,
    projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
    schemaVersion: prepared.mapping.schemaVersion,
    atomicity: "row_independent",
    baseSnapshotHash: prepared.snapshotHash,
    ingressActorId: writer.writerId,
    editorActorId: { kind: PRESENCE_KINDS.ABSENT },
    editorActorSource: "unavailable",
    rows: [prepared.row],
  };
  const rowHashBefore = computeRowHash(prepared.row.rowBindingId, prepared.row.beforeRow.fields);
  const rowHashAfter = computeRowHash(prepared.row.rowBindingId, prepared.row.afterRow.fields);
  const payload = {
    batchId: batch.batchId,
    physicalSheetId: requireTypedSheetsEntityProjection(
      prepared.mapping,
      SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
    ).physicalSheetId,
    rowNumber: prepared.snapshotRow.rowNumber,
    physicalAnchor: prepared.snapshotRow.physicalAnchor,
    row: prepared.row,
  };
  const payloadJson = auditJson(payload);
  const payloadHash = stableHash({ payloadJson });
  const observationKey = stableHash({
    source: "polling",
    physicalSheetId: payload.physicalSheetId,
    snapshotHash: prepared.snapshotHash,
    rowBindingId: prepared.row.rowBindingId,
    afterRowHash: rowHashAfter,
  });
  const eventKey = computeEventKey({
    schemaVersion: batch.schemaVersion,
    sheetId: batch.sheetId,
    projection: batch.projection,
    rowBindingId: prepared.row.rowBindingId,
    baseVisibleRevision: prepared.row.baseVisibleRevision,
    baseSnapshotHash: batch.baseSnapshotHash,
    operation: prepared.row.operation,
    beforeRowHash: rowHashBefore,
    afterRowHash: rowHashAfter,
    changedFields: prepared.row.fields.map((field) => ({
      fieldName: field.fieldName,
      candidateEpoch: state.conflictsByBindingAndField.get(prepared.row.rowBindingId)?.get(field.fieldName)?.candidateEpoch
        ?? prepared.binding.candidateEpoch,
      beforeHash: stableHash(field.previousValue),
      afterHash: stableHash(field.nextValue),
      nextValue: field.nextValue,
      baseFieldRevision: field.baseFieldRevision,
    })),
  });
  const evaluation = evaluateBatch(batch, evaluationContext(prepared.mapping, prepared.binding, prepared.canonical, state)).rowResults[0];
  if (evaluation === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "User_Input evaluation did not return a row result.",
    );
  }
  const canonical = await canonicalMutationFor(
    storage,
    writer,
    prepared,
    evaluation,
  );
  const observedAt = writer.now();
  return {
    physicalSheetId: payload.physicalSheetId,
    batch,
    rowIndex: 0,
    observation: {
      observationId: identifiedValue("observation", writer),
      observationKey,
      payloadJson,
      payloadHash,
      detectedAt: observedAt,
      receivedAt: observedAt,
      ingressActorId: writer.writerId,
      editorActorId: { kind: PRESENCE_KINDS.ABSENT },
      editorActorSource: "unavailable",
    },
    event: {
      kind: PRESENCE_KINDS.PRESENT,
      value: { eventKey, payloadHash },
    },
    evaluation,
    canonical,
    effects: [],
  };
}

function evaluationContext(
  mapping: TypedSheetsEntityMapping,
  binding: RowBindingStateRecord,
  canonical: EntityStateRecord,
  state: MappedPollingState,
): EvaluationContext {
  const canonicalFields = new Map<string, CanonicalFieldState>();
  for (const field of mapping.fields) {
    const current = canonical.fields.get(field.fieldName);
    if (current === undefined) continue;
    canonicalFields.set(field.fieldName, {
      fieldName: field.fieldName,
      value: current.value,
      fieldRevision: current.fieldRevision,
      ownership: field.ownership,
    });
  }
  const businessKey = state.businessKeysByLogicalAndField
    .get(mapping.logicalSheetId)
    ?.get(mapping.businessKey.fieldName);
  const businessKeyValue = businessKey === undefined
    ? stableHash(canonical.fields.get(mapping.businessKey.fieldName)?.value ?? null)
    : [...businessKey.entries()].find(([, entityId]) => entityId === binding.entityId)?.[0]
      ?? stableHash(canonical.fields.get(mapping.businessKey.fieldName)?.value ?? null);
  const canonicalState: CanonicalEntityState = {
    entityId: canonical.entityId,
    entityRevision: canonical.entityRevision,
    businessKey: businessKeyValue,
    fields: canonicalFields,
  };
  if (binding.entityId === null || binding.state !== ROW_BINDING_STATES.ACTIVE) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `active User_Input observation has an invalid binding ${binding.rowBindingId}.`,
    );
  }
  const bindingContext: RowBindingContext = {
    rowBindingId: binding.rowBindingId,
    bindingState: ROW_BINDING_STATES.ACTIVE,
    candidateEpoch: binding.candidateEpoch,
    entityId: binding.entityId,
    businessKey: businessKeyValue,
  };
  const activeKeys = state.businessKeysByLogicalAndField.get(mapping.logicalSheetId)
    ?.get(mapping.businessKey.fieldName) ?? new Map<string, string>();
  const conflicts = state.conflictsByBindingAndField.get(binding.rowBindingId) ?? new Map();
  return {
    manifest: createTypedSheetsEntityOwnershipManifest(mapping),
    canonicalByBindingId: new Map([[binding.rowBindingId, {
      status: CANONICAL_RESOLUTION_STATUSES.AVAILABLE,
      entity: canonicalState,
    } satisfies CanonicalResolution]]),
    bindingByBindingId: new Map([[binding.rowBindingId, bindingContext]]),
    activeConflictsByBindingAndField: new Map([[binding.rowBindingId, conflicts]]),
    businessKeyEntityIdsByField: new Map([[mapping.businessKey.fieldName, activeKeys]]),
    schemaVersion: mapping.schemaVersion,
  };
}

async function canonicalMutationFor(
  storage: MikroOrmSqliteAdapter,
  writer: ResolvedWriterOptions,
  prepared: PreparedRow,
  evaluation: RowEvaluationResult,
): Promise<Presence<CanonicalRowMutation>> {
  if (evaluation.acceptedFields.length === 0) return { kind: PRESENCE_KINDS.ABSENT };
  const acceptedByField = new Map(evaluation.acceptedFields.map((field) => [field.fieldName, field]));
  const encodedEntity: Record<string, NormalizedCell> = {};
  for (const field of prepared.mapping.fields) {
    const accepted = acceptedByField.get(field.fieldName);
    const canonical = prepared.canonical.fields.get(field.fieldName);
    if (accepted !== undefined) encodedEntity[field.fieldName] = accepted.nextValue;
    else if (canonical !== undefined) encodedEntity[field.fieldName] = canonical.value;
    else {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
        `canonical field is missing for ${prepared.mapping.entityName}.${field.fieldName}.`,
      );
    }
  }
  const commitId = identifiedValue("commit", writer);
  const effects = await storage.read(({ sql }) => projectionEffects(
    createTypedSheetsPersistenceContext(sql),
    writer,
    prepared.mapping,
    prepared.canonical.entityId,
    prepared.binding.rowBindingId,
    prepared.binding.anchorReference,
    encodedEntity,
    "update",
    prepared.mapping.fields.filter((field) => acceptedByField.has(field.fieldName)),
    commitId,
    "nextEntityRevision" in evaluation ? evaluation.nextEntityRevision : prepared.canonical.entityRevision + 1,
    { includeUserProjection: false },
  ));
  const businessKeyChanges: BusinessKeyChange[] = [];
  const acceptedBusinessKey = acceptedByField.get(prepared.mapping.businessKey.fieldName);
  if (acceptedBusinessKey !== undefined) {
    const previousValue = prepared.canonical.fields.get(prepared.mapping.businessKey.fieldName)?.value;
    if (previousValue === undefined) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
        `business-key canonical field is missing for ${prepared.mapping.entityName}.`,
      );
    }
    businessKeyChanges.push({
      fieldName: prepared.mapping.businessKey.fieldName,
      previousNormalizedKey: { kind: PRESENCE_KINDS.PRESENT, value: stableHash(previousValue) },
      nextNormalizedKey: { kind: PRESENCE_KINDS.PRESENT, value: stableHash(acceptedBusinessKey.nextValue) },
    });
  }
  return {
    kind: PRESENCE_KINDS.PRESENT,
    value: {
      commitId,
      commit: {
        kind: ROW_OPERATIONS.UPDATE,
        entityId: prepared.canonical.entityId,
        acceptedSnapshotHash: {
          kind: PRESENCE_KINDS.PRESENT,
          value: stableHash({
            entityId: prepared.canonical.entityId,
            fields: Object.entries(encodedEntity)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([fieldName, value]) => ({ fieldName, value })),
          }),
        },
        fields: evaluation.acceptedFields.map((field) => ({
          fieldName: field.fieldName,
          value: field.nextValue,
          expectedFieldRevision: {
            kind: APPLICABILITY_KINDS.APPLICABLE,
            value: field.nextFieldRevision - 1,
          },
          ownership: prepared.mapping.fields.find((candidate) => candidate.fieldName === field.fieldName)?.ownership
            ?? FIELD_OWNERSHIPS.USER,
        })),
        effects,
      },
      businessKeyChanges,
    },
  };
}

function classifyResult(accumulator: SheetAccumulator, result: PersistObservedRowResult): void {
  switch (result.kind) {
    case OBSERVATION_WRITE_RESULT_KINDS.PERSISTED:
      if (result.outcome !== "conflict") accumulator.appliedRows += 1;
      if (result.outcome === "conflict" || result.conflictIds.length > 0) accumulator.conflictRows += 1;
      break;
    case OBSERVATION_WRITE_RESULT_KINDS.QUARANTINED:
      accumulator.quarantinedRows += 1;
      break;
    case OBSERVATION_WRITE_RESULT_KINDS.DUPLICATE:
      accumulator.duplicateRows += 1;
      break;
    case OBSERVATION_WRITE_RESULT_KINDS.STALE:
      accumulator.staleRows += 1;
      break;
    case OBSERVATION_WRITE_RESULT_KINDS.FENCED_OUT:
      accumulator.fencedRows += 1;
      break;
  }
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

/** Derives duplicate business-key values from the normalized snapshot contract. */
function duplicateBusinessKeysForSnapshot(
  snapshot: SyncGatewaySnapshot,
  businessKey: TypedSheetsEntityFieldMapping,
): ReadonlySet<string> {
  const rowsByBusinessKey = new Map<string, number[]>();
  for (const row of snapshot.rows) {
    const cell = row.cells[businessKey.fieldName];
    if (cell === undefined || cell.normalizedCell === null) continue;
    const rowNumbers = rowsByBusinessKey.get(stableHash(cell.normalizedCell)) ?? [];
    rowNumbers.push(row.rowNumber);
    rowsByBusinessKey.set(stableHash(cell.normalizedCell), rowNumbers);
  }
  return new Set(
    [...rowsByBusinessKey.entries()]
      .filter(([, rowNumbers]) => rowNumbers.length > 1)
      .map(([businessKey]) => businessKey),
  );
}

/** Computes a stable identity for one values-only observation pass. */
function snapshotHash(snapshot: SyncGatewaySnapshot): string {
  return stableHash({
    protocolVersion: snapshot.protocolVersion,
    sheetName: snapshot.sheetName,
    registeredRange: snapshot.registeredRange,
    projection: snapshot.projection,
    schemaVersion: snapshot.schemaVersion,
    headers: snapshot.headers,
    rows: snapshot.rows.map((row) => ({
      rowNumber: row.rowNumber,
      physicalAnchor: row.physicalAnchor,
      cells: Object.entries(row.cells)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fieldName, cell]) => ({
          fieldName,
          cellKind: cell.cellKind,
          normalizedCell: cell.normalizedCell,
        })),
    })),
  });
}

function placeholders(values: readonly string[]): string {
  if (values.length === 0) return "NULL";
  return values.map(() => "?").join(", ");
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function sum<T>(values: readonly T[], read: (value: T) => number): number {
  return values.reduce((total, value) => total + read(value), 0);
}

function isRowBindingState(value: string): value is RowBindingContext["bindingState"] {
  return value === ROW_BINDING_STATES.CANDIDATE ||
    value === ROW_BINDING_STATES.ACTIVE ||
    value === ROW_BINDING_STATES.TOMBSTONED ||
    value === ROW_BINDING_STATES.AMBIGUOUS;
}

function nullablePresence<T>(value: T | null): Presence<T> {
  return value === null
    ? { kind: PRESENCE_KINDS.ABSENT }
    : { kind: PRESENCE_KINDS.PRESENT, value };
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
