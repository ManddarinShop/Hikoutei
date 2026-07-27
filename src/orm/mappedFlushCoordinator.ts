/**
 * Built-in entity flush planner for typed-sheets mappings.
 *
 * It turns durable entity lifecycle changes into canonical SQLite mutations and
 * ordered Sheets outbox effects in the same transaction as the execution
 * engine's entity write. The planner is adapter-neutral: it only receives the
 * transaction-bound `SqlExecutor` exposed by our ORM facade.
 */

import { randomUUID } from "node:crypto";

import {
  APPLICABILITY_KINDS,
  EMPTY_STRING_LENGTH_ZERO,
  FIELD_OWNERSHIPS,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  PRESENCE_KINDS,
  ROW_OPERATIONS,
  stableHash,
  type Applicability,
  type EffectStatus,
  type EffectTargetKind,
  type NormalizedCell,
  type Presence,
} from "../core/index.js";
import {
  NORMALIZED_CELL_KINDS,
} from "../core/encoding/constants.js";
import { ROW_BINDING_STATES } from "../core/model/constants.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
} from "../runtime/gateway/constants.js";
import {
  computeSyncVisibleHash,
  parseSyncProjectionEffectPayload,
} from "../runtime/gateway/syncGateway.js";
import {
  createCandidateReconcileEffect,
  createSystemProjectionEffect,
  createUserInputDeleteEffect,
} from "../runtime/projection/ProjectionEffectFactory.js";
import {
  CANONICAL_COMMIT_RESULT_KINDS,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  claimWriterLeaseWithSql,
  commitCanonicalChangesWithSql,
  registerSyncSheetWithSql,
  requireRegisteredSyncSheetWithSql,
  type CanonicalCommitInput,
  type CanonicalFieldWrite,
  type FencingContext,
  type NewEffect,
  type RegisteredSyncSheet,
} from "../storage/index.js";
import type { SqlExecutor, SqlStorageAdapter } from "./adapters/contracts.js";
import type { RegisteredSyncProjectionDefinition } from "../runtime/gateway/SyncGatewayBootstrap.js";
import {
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
  type TypedSheetsEntityChange,
  type TypedSheetsFlushContext,
  type TypedSheetsFlushCoordinator,
} from "./contracts.js";
import {
  createTypedSheetsEntityMappingRegistry,
  createTypedSheetsMappedProjectionDefinitions,
  encodeTypedSheetsEntity,
  requireTypedSheetsEntityProjection,
  typedSheetsEntityAnchor,
  typedSheetsEntityId,
  typedSheetsEntityRowBindingId,
  type TypedSheetsEntityFieldMapping,
  type TypedSheetsEntityMapping,
  type TypedSheetsEntityMappingRegistry,
} from "./entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "./errors.js";
import {
  SYNC_TIMING_OPERATION_KINDS,
  SYNC_TIMING_SCOPES,
  type SyncTimingOperationCounts,
  type SyncTimingOperationKind,
  type SyncTimingSink,
} from "../runtime/telemetry/syncTiming.js";

const DEFAULT_MAPPED_WRITER_ROLE = "typed-sheets-entity-writer";
const DEFAULT_MAPPED_WRITER_LEASE_DURATION_MS = 60_000;

const MAPPED_EFFECT_TARGET_KINDS = {
  ENTITY: "entity",
  PROJECTION_ROW: "projection_row",
} as const satisfies Record<string, EffectTargetKind>;

const MAPPED_EFFECT_STATUSES = {
  PENDING: "pending",
  PROCESSING: "processing",
  APPLIED: "applied",
} as const satisfies Record<string, EffectStatus>;

const READ_ROW_BINDING_SQL = `
  SELECT logical_sheet_id, anchor_reference, entity_id, state
  FROM row_binding
  WHERE row_binding_id = ?
`;

const INSERT_ACTIVE_ROW_BINDING_SQL = `
  INSERT INTO row_binding (
    row_binding_id, logical_sheet_id, anchor_reference, entity_id, state
  ) VALUES (?, ?, ?, ?, ?)
`;

const TOMBSTONE_ACTIVE_ROW_BINDING_SQL = `
  UPDATE row_binding
  SET state = ?
  WHERE row_binding_id = ? AND logical_sheet_id = ? AND entity_id = ? AND state = ?
`;

const READ_ACTIVE_CANONICAL_ENTITY_SQL = `
  SELECT entity_revision
  FROM entity_state
  WHERE entity_id = ? AND status = 'active'
`;

const READ_CANONICAL_FIELD_REVISIONS_SQL = `
  SELECT field_name, field_revision
  FROM entity_field_state
  WHERE entity_id = ?
`;

const READ_ACTIVE_BUSINESS_KEY_SQL = `
  SELECT entity_id, normalized_key
  FROM business_key_index
  WHERE logical_sheet_id = ? AND field_name = ? AND entity_id = ? AND state = 'active'
`;

const READ_BUSINESS_KEY_OWNER_SQL = `
  SELECT entity_id
  FROM business_key_index
  WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ? AND state = 'active'
`;

const INSERT_ACTIVE_BUSINESS_KEY_SQL = `
  INSERT INTO business_key_index (
    logical_sheet_id, field_name, normalized_key, entity_id, state
  ) VALUES (?, ?, ?, ?, 'active')
`;

const RETIRE_ACTIVE_BUSINESS_KEY_SQL = `
  UPDATE business_key_index
  SET state = 'inactive'
  WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ?
    AND entity_id = ? AND state = 'active'
`;

const RETIRE_ENTITY_BUSINESS_KEYS_SQL = `
  UPDATE business_key_index
  SET state = 'inactive'
  WHERE logical_sheet_id = ? AND entity_id = ? AND state = 'active'
`;

const READ_VISIBLE_PROJECTION_STATE_SQL = `
  SELECT confirmed_snapshot_hash, confirmed_visible_revision
  FROM sheet_visible_state
  WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ?
`;

const READ_LATEST_PROJECTION_EFFECT_SQL = `
  SELECT physical_sheet_id, projection, status, payload_json,
         expected_visible_revision, expected_visible_hash, stream_sequence
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = ? AND target_id = ?
  ORDER BY stream_sequence DESC
  LIMIT 1
`;

/** Writer identity used to fence mapped entity lifecycle commits. */
export interface TypedSheetsEntityWriterOptions {
  /** Stable process or service identity that owns mapped entity writes. */
  readonly writerId: string;
  /** Lease role. It may differ from the effect worker's role. */
  readonly role?: string;
  /** Writer lease length in milliseconds. */
  readonly leaseDurationMs?: number;
  /** Injectable clock used for deterministic tests and fencing. */
  readonly now?: () => number;
  /** Injectable opaque-ID source used for commit and effect identities. */
  readonly createId?: () => string;
  /** Optional diagnostics sink for append/update/delete flush phases. */
  readonly onTiming?: SyncTimingSink;
}

/** Options for deriving a built-in flush coordinator from mapping metadata. */
export interface CreateMappedTypedSheetsFlushCoordinatorOptions {
  readonly mappings: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[];
  readonly writer: TypedSheetsEntityWriterOptions;
}

/** A registered route with headers ready for Apps Script control-plane provisioning. */
export interface RegisteredTypedSheetsMappedProjection {
  readonly mapping: TypedSheetsEntityMapping;
  readonly sheet: RegisteredSyncSheet;
  readonly headers: readonly string[];
}

interface ResolvedWriterOptions {
  readonly writerId: string;
  readonly role: string;
  readonly leaseDurationMs: number;
  readonly now: () => number;
  readonly createId: () => string;
  readonly onTiming: SyncTimingSink | undefined;
}

interface RowBindingSqlRow {
  readonly logical_sheet_id: string;
  readonly anchor_reference: string;
  readonly entity_id: string | null;
  readonly state: string;
}

interface CanonicalEntitySqlRow {
  readonly entity_revision: number;
}

interface CanonicalFieldRevisionSqlRow {
  readonly field_name: string;
  readonly field_revision: number;
}

interface ActiveBusinessKeySqlRow {
  readonly entity_id: string;
  readonly normalized_key: string;
}

interface BusinessKeyOwnerSqlRow {
  readonly entity_id: string;
}

interface VisibleProjectionSqlRow {
  readonly confirmed_snapshot_hash: string;
  readonly confirmed_visible_revision: number;
}

interface LatestProjectionEffectSqlRow {
  readonly physical_sheet_id: string;
  readonly projection: string;
  readonly status: EffectStatus;
  readonly payload_json: string;
  readonly expected_visible_revision: number;
  readonly expected_visible_hash: string;
  readonly stream_sequence: number;
}

interface ProjectionBaseline {
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly createIfMissing: boolean;
  readonly streamSequence: number;
}

interface MappedChangePlan {
  readonly mapping: TypedSheetsEntityMapping;
  readonly change: TypedSheetsEntityChange;
  readonly changedFields: readonly TypedSheetsEntityFieldMapping[];
}

/**
 * Creates the built-in planner that makes `em.persist()` / `em.flush()` durable
 * in the entity table, canonical state, business-key index, and Sheets outbox
 * together.
 */
export function createMappedTypedSheetsFlushCoordinator(
  options: CreateMappedTypedSheetsFlushCoordinatorOptions,
): TypedSheetsFlushCoordinator {
  const mappings = mappingRegistry(options.mappings);
  const writer = resolveWriterOptions(options.writer);

  return {
    async onFlush(context: TypedSheetsFlushContext): Promise<void> {
      const flushStartedAt = Date.now();
      const plans = collectMappedChanges(mappings, context.changes);
      if (plans.length === 0) return;

      const operationCounts = countsForPlans(plans);

      const leaseStartedAt = Date.now();
      const now = writer.now();
      const claim = await claimWriterLeaseWithSql(context.sql, {
        role: writer.role,
        writerId: writer.writerId,
        leaseDurationMs: writer.leaseDurationMs,
        now,
      });
      if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
        throw new TypedSheetsOrmError(
          TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
          `mapped entity writer lease is unavailable: ${claim.reason}.`,
        );
      }
      emitTiming(writer, {
        scope: SYNC_TIMING_SCOPES.ORM_FLUSH,
        phase: "writer_lease_claim",
        durationMs: Date.now() - leaseStartedAt,
        operationKinds: operationKindsForCounts(operationCounts),
        operationCounts,
      });

      const fence: FencingContext = {
        role: claim.lease.role,
        writerEpoch: claim.lease.writerEpoch,
        fencingToken: claim.lease.fencingToken,
        now,
      };
      for (const plan of plans) {
        await applyMappedChange(context.sql, fence, writer, plan);
      }
      emitTiming(writer, {
        scope: SYNC_TIMING_SCOPES.ORM_FLUSH,
        phase: "flush_total",
        durationMs: Date.now() - flushStartedAt,
        operationKinds: operationKindsForCounts(operationCounts),
        operationCounts,
      });
    },
  };
}

/**
 * Registers every mapping route under one writer fence.
 *
 * The return value can be passed directly to the existing gateway provisioning
 * helper, so users never need to duplicate route names or header lists in Apps
 * Script configuration.
 */
export async function registerTypedSheetsEntityMappings(
  storage: SqlStorageAdapter,
  mappingsInput: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[],
  writerInput: TypedSheetsEntityWriterOptions,
): Promise<readonly RegisteredTypedSheetsMappedProjection[]> {
  const mappings = mappingRegistry(mappingsInput);
  const writer = resolveWriterOptions(writerInput);
  const definitions = createTypedSheetsMappedProjectionDefinitions(mappings.mappings);

  return storage.transaction(async ({ sql }) => {
    const now = writer.now();
    const claim = await claimWriterLeaseWithSql(sql, {
      role: writer.role,
      writerId: writer.writerId,
      leaseDurationMs: writer.leaseDurationMs,
      now,
    });
    if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
        `mapped projection registration lease is unavailable: ${claim.reason}.`,
      );
    }
    const fence: FencingContext = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now,
    };

    const registered: RegisteredTypedSheetsMappedProjection[] = [];
    for (const definition of definitions) {
      const result = await registerSyncSheetWithSql(sql, fence, definition.registration);
      if (result.kind !== "registered") {
        throw new TypedSheetsOrmError(
          TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
          `writer lease was lost while registering ${definition.projection.physicalSheetId}.`,
        );
      }
      registered.push({
        mapping: definition.mapping,
        sheet: result.sheet,
        headers: definition.headers,
      });
    }
    return registered;
  });
}

/** Converts registered mapping routes into existing gateway provisioning definitions. */
export function registeredTypedSheetsProjectionDefinitions(
  registrations: readonly RegisteredTypedSheetsMappedProjection[],
): readonly RegisteredSyncProjectionDefinition[] {
  return registrations.map(({ sheet, headers }) => ({ sheet, headers }));
}

function collectMappedChanges(
  mappings: TypedSheetsEntityMappingRegistry,
  changes: readonly TypedSheetsEntityChange[],
): readonly MappedChangePlan[] {
  const plans: MappedChangePlan[] = [];
  for (const change of changes) {
    const mapping = mappings.findByEntityName(change.entityName);
    if (mapping === undefined) continue;
    const changedFields = changedMappingFields(mapping, change);
    if (
      change.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE &&
      changedFields.length === 0
    ) continue;
    plans.push({ mapping, change, changedFields });
  }
  return plans;
}

function changedMappingFields(
  mapping: TypedSheetsEntityMapping,
  change: TypedSheetsEntityChange,
): readonly TypedSheetsEntityFieldMapping[] {
  if (change.kind !== TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE) return mapping.fields;
  if (hasOwn(change.payload, mapping.primaryKey)) {
    const nextPrimaryKey = change.payload[mapping.primaryKey];
    const entityId = typedSheetsEntityId(mapping, change.entity);
    if (nextPrimaryKey !== entityId) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_MUTATION,
        `${mapping.entityName}.${mapping.primaryKey} cannot change after it is mapped to Sheets.`,
      );
    }
  }
  return mapping.fields.filter((field) => hasOwn(change.payload, field.property));
}

async function applyMappedChange(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  plan: MappedChangePlan,
): Promise<void> {
  const changeStartedAt = Date.now();
  const { mapping, change, changedFields } = plan;
  const operationKind = timingOperationKind(change.kind);
  const entityId = requireChangeEntityId(mapping, change);
  const rowBindingId = typedSheetsEntityRowBindingId(mapping, entityId);
  const anchor = typedSheetsEntityAnchor(mapping, entityId);
  const preparationStartedAt = Date.now();
  const encodedEntity = encodeTypedSheetsEntity(mapping, change.entity);
  emitTiming(writer, {
    scope: SYNC_TIMING_SCOPES.ORM_FLUSH,
    phase: "entity_prepare",
    durationMs: Date.now() - preparationStartedAt,
    operationKinds: [operationKind],
    operationCounts: countsForOperationKind(operationKind),
  });

  const canonicalStartedAt = Date.now();
  if (change.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE) {
    await createMappedEntity(
      sql,
      fence,
      writer,
      mapping,
      entityId,
      rowBindingId,
      anchor,
      encodedEntity,
    );
  } else if (change.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE) {
    await updateMappedEntity(
      sql,
      fence,
      writer,
      mapping,
      entityId,
      rowBindingId,
      anchor,
      encodedEntity,
      changedFields,
    );
  } else {
    await deleteMappedEntity(
      sql,
      fence,
      writer,
      mapping,
      entityId,
      rowBindingId,
      anchor,
      encodedEntity,
    );
  }
  emitTiming(writer, {
    scope: SYNC_TIMING_SCOPES.ORM_FLUSH,
    phase: "canonical_outbox_commit",
    durationMs: Date.now() - canonicalStartedAt,
    operationKinds: [operationKind],
    operationCounts: countsForOperationKind(operationKind),
  });
  emitTiming(writer, {
    scope: SYNC_TIMING_SCOPES.ORM_FLUSH,
    phase: "entity_change_total",
    durationMs: Date.now() - changeStartedAt,
    operationKinds: [operationKind],
    operationCounts: countsForOperationKind(operationKind),
  });
}

async function createMappedEntity(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  rowBindingId: string,
  anchor: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): Promise<void> {
  await insertActiveRowBinding(sql, mapping, rowBindingId, entityId, anchor);
  const commitId = identifiedValue("commit", writer);
  const effects = await projectionEffects(
    sql,
    writer,
    mapping,
    entityId,
    rowBindingId,
    anchor,
    encodedEntity,
    TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE,
    mapping.fields,
    commitId,
    POSITIVE_SAFE_INTEGER_MINIMUM,
  );
  const commit: CanonicalCommitInput = {
    kind: ROW_OPERATIONS.INSERT,
    entityId,
    acceptedSnapshotHash: acceptedSnapshotHash(entityId, encodedEntity),
    fields: mapping.fields.map((field) => ({
      fieldName: field.fieldName,
      value: requireEncodedField(encodedEntity, field),
      expectedFieldRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
      ownership: field.ownership,
    })),
    effects,
  };
  await requireAppliedCanonicalCommit(sql, fence, commit);
  await claimBusinessKey(sql, mapping, entityId, encodedEntity);
}

async function updateMappedEntity(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  rowBindingId: string,
  anchor: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
  changedFields: readonly TypedSheetsEntityFieldMapping[],
): Promise<void> {
  await requireActiveRowBinding(sql, mapping, rowBindingId, entityId, anchor);
  const entityRevision = await requireActiveCanonicalEntityRevision(sql, mapping, entityId);
  const fieldRevisions = await canonicalFieldRevisions(sql, entityId);
  const fields: CanonicalFieldWrite[] = changedFields.map((field) => {
    const expectedFieldRevision = fieldRevisions.get(field.fieldName);
    if (expectedFieldRevision === undefined) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
        `${mapping.entityName}.${field.property} has no canonical field revision.`,
      );
    }
    return {
      fieldName: field.fieldName,
      value: requireEncodedField(encodedEntity, field),
      expectedFieldRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: expectedFieldRevision },
      ownership: field.ownership,
    };
  });
  const nextEntityRevision = entityRevision + 1;
  const commitId = identifiedValue("commit", writer);
  const effects = await projectionEffects(
    sql,
    writer,
    mapping,
    entityId,
    rowBindingId,
    anchor,
    encodedEntity,
    TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE,
    changedFields,
    commitId,
    nextEntityRevision,
  );
  const commit: CanonicalCommitInput = {
    kind: ROW_OPERATIONS.UPDATE,
    entityId,
    acceptedSnapshotHash: acceptedSnapshotHash(entityId, encodedEntity),
    fields,
    effects,
  };
  await requireAppliedCanonicalCommit(sql, fence, commit);
  if (changedFields.some((field) => field.fieldName === mapping.businessKey.fieldName)) {
    await rotateBusinessKey(sql, mapping, entityId, encodedEntity);
  }
}

async function deleteMappedEntity(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  rowBindingId: string,
  anchor: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): Promise<void> {
  await requireActiveRowBinding(sql, mapping, rowBindingId, entityId, anchor);
  const entityRevision = await requireActiveCanonicalEntityRevision(sql, mapping, entityId);
  const nextEntityRevision = entityRevision + 1;
  const commitId = identifiedValue("commit", writer);
  const effects = await projectionEffects(
    sql,
    writer,
    mapping,
    entityId,
    rowBindingId,
    anchor,
    encodedEntity,
    TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE,
    [],
    commitId,
    nextEntityRevision,
  );
  const commit: CanonicalCommitInput = {
    kind: ROW_OPERATIONS.DELETE,
    entityId,
    acceptedSnapshotHash: acceptedSnapshotHash(entityId, encodedEntity),
    expectedEntityRevision: entityRevision,
    effects,
  };
  await requireAppliedCanonicalCommit(sql, fence, commit);
  const tombstoned = await sql.run(TOMBSTONE_ACTIVE_ROW_BINDING_SQL, [
    ROW_BINDING_STATES.TOMBSTONED,
    rowBindingId,
    mapping.logicalSheetId,
    entityId,
    ROW_BINDING_STATES.ACTIVE,
  ]);
  if (tombstoned.changes !== 1) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
      `could not tombstone the row binding for ${mapping.entityName}:${entityId}.`,
    );
  }
  const retired = await sql.run(RETIRE_ENTITY_BUSINESS_KEYS_SQL, [mapping.logicalSheetId, entityId]);
  if (retired.changes !== 1) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `could not retire the business key for ${mapping.entityName}:${entityId}.`,
    );
  }
}

async function projectionEffects(
  sql: SqlExecutor,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  rowBindingId: string,
  anchor: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
  changeKind: TypedSheetsEntityChange["kind"],
  changedFields: readonly TypedSheetsEntityFieldMapping[],
  commitId: string,
  targetEntityRevision: number,
): Promise<readonly NewEffect[]> {
  const systemProjection = requireTypedSheetsEntityProjection(
    mapping,
    SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
  );
  const systemRoute = await requireMappedRoute(sql, mapping, systemProjection);
  const systemTarget = {
    targetKind: MAPPED_EFFECT_TARGET_KINDS.ENTITY,
    targetId: entityId,
  } as const;
  const systemBaseline = await projectionBaseline(
    sql,
    mapping,
    systemProjection,
    rowBindingId,
    systemTarget.targetKind,
    systemTarget.targetId,
  );
  const systemFields: Record<string, NormalizedCell> = {
    ...encodedEntity,
    [mapping.tombstoneFieldName]: {
      kind: NORMALIZED_CELL_KINDS.BOOLEAN,
      value: changeKind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE,
    },
  };
  const effects: NewEffect[] = [
    createSystemProjectionEffect({
      effectId: identifiedValue("effect", writer),
      commitId,
      logicalSheetId: mapping.logicalSheetId,
      physicalSheetId: systemRoute.physicalSheetId,
      sheetName: systemRoute.tabName,
      registeredRange: systemRoute.registeredRange,
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: mapping.schemaVersion,
      targetKind: systemTarget.targetKind,
      targetId: systemTarget.targetId,
      rowBindingId: presentValue(rowBindingId),
      conflictId: absentValue(),
      targetAnchor: anchor,
      fields: systemFields,
      createIfMissing: systemBaseline.createIfMissing,
      expectedVisibleRevision: systemBaseline.expectedVisibleRevision,
      expectedVisibleHash: systemBaseline.expectedVisibleHash,
      targetEntityRevision: applicableValue(targetEntityRevision),
      streamSequence: systemBaseline.streamSequence,
    }),
  ];

  const userProjection = mapping.projections.find(
    (projection) => projection.projection === SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
  );
  if (userProjection === undefined) return effects;
  const shouldReconcileUserInput = userProjection !== undefined &&
    changeKind !== TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE &&
    (changeKind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE ||
      changedFields.some((field) => field.ownership === FIELD_OWNERSHIPS.USER));
  if (
    changeKind !== TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE &&
    !shouldReconcileUserInput
  ) return effects;

  const userRoute = await requireMappedRoute(sql, mapping, userProjection);
  const userFields = Object.fromEntries(
    mapping.fields
      .filter((field) => field.ownership === FIELD_OWNERSHIPS.USER)
      .map((field) => [field.fieldName, requireEncodedField(encodedEntity, field)]),
  ) as Record<string, NormalizedCell>;
  const userTarget = {
    targetKind: MAPPED_EFFECT_TARGET_KINDS.PROJECTION_ROW,
    targetId: projectionRowTargetId(userProjection.physicalSheetId, rowBindingId),
  } as const;
  const userBaseline = await projectionBaseline(
    sql,
    mapping,
    userProjection,
    rowBindingId,
    userTarget.targetKind,
    userTarget.targetId,
  );
  if (changeKind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE) {
    const userFieldHash = computeSyncVisibleHash(userFields);
    if (userFieldHash !== userBaseline.expectedVisibleHash) {
      throwProjectionBlocked(
        mapping,
        userProjection,
        "the User_Input row does not match the entity fields selected for deletion",
      );
    }
    effects.push(createUserInputDeleteEffect({
      effectId: identifiedValue("effect", writer),
      commitId,
      logicalSheetId: mapping.logicalSheetId,
      physicalSheetId: userRoute.physicalSheetId,
      sheetName: userRoute.tabName,
      registeredRange: userRoute.registeredRange,
      schemaVersion: mapping.schemaVersion,
      targetKind: userTarget.targetKind,
      targetId: userTarget.targetId,
      rowBindingId: presentValue(rowBindingId),
      conflictId: absentValue(),
      targetAnchor: anchor,
      fields: userFields,
      createIfMissing: false,
      expectedVisibleRevision: userBaseline.expectedVisibleRevision,
      expectedVisibleHash: userBaseline.expectedVisibleHash,
      targetEntityRevision: applicableValue(targetEntityRevision),
      streamSequence: userBaseline.streamSequence,
    }));
    return effects;
  }
  effects.push(createCandidateReconcileEffect({
    effectId: identifiedValue("effect", writer),
    commitId,
    logicalSheetId: mapping.logicalSheetId,
    physicalSheetId: userRoute.physicalSheetId,
    sheetName: userRoute.tabName,
    registeredRange: userRoute.registeredRange,
    schemaVersion: mapping.schemaVersion,
    targetKind: userTarget.targetKind,
    targetId: userTarget.targetId,
    rowBindingId: presentValue(rowBindingId),
    conflictId: absentValue(),
    targetAnchor: anchor,
    fields: userFields,
    createIfMissing: userBaseline.createIfMissing,
    expectedVisibleRevision: userBaseline.expectedVisibleRevision,
    expectedVisibleHash: userBaseline.expectedVisibleHash,
    targetEntityRevision: applicableValue(targetEntityRevision),
    streamSequence: userBaseline.streamSequence,
  }));
  return effects;
}

async function requireMappedRoute(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  projection: ReturnType<typeof requireTypedSheetsEntityProjection>,
): Promise<RegisteredSyncSheet> {
  const route = await requireRegisteredSyncSheetWithSql(sql, projection.physicalSheetId);
  if (
    route.logicalSheetId !== mapping.logicalSheetId ||
    route.projection !== projection.projection ||
    route.schemaVersion !== mapping.schemaVersion
  ) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `registered route ${projection.physicalSheetId} does not match ${mapping.entityName}'s mapping.`,
    );
  }
  return route;
}

async function projectionBaseline(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  projection: ReturnType<typeof requireTypedSheetsEntityProjection>,
  rowBindingId: string,
  targetKind: EffectTargetKind,
  targetId: string,
): Promise<ProjectionBaseline> {
  const latest = await sql.get<LatestProjectionEffectSqlRow>(READ_LATEST_PROJECTION_EFFECT_SQL, [
    mapping.logicalSheetId,
    targetKind,
    targetId,
  ]);
  if (latest !== undefined) {
    if (
      latest.physical_sheet_id !== projection.physicalSheetId ||
      latest.projection !== projection.projection ||
      !isPositiveSafeInteger(latest.stream_sequence)
    ) {
      throwProjectionBlocked(mapping, projection, "latest target effect has incompatible routing");
    }
    const streamSequence = latest.stream_sequence + 1;
    if (!isPositiveSafeInteger(streamSequence)) {
      throwProjectionBlocked(mapping, projection, "projection stream sequence overflowed");
    }
    if (
      latest.status === MAPPED_EFFECT_STATUSES.PENDING ||
      latest.status === MAPPED_EFFECT_STATUSES.PROCESSING
    ) {
      if (!isNonNegativeSafeInteger(latest.expected_visible_revision)) {
        throwProjectionBlocked(mapping, projection, "latest effect has an invalid expected visible revision");
      }
      const expectedVisibleRevision = latest.expected_visible_revision + 1;
      if (!isNonNegativeSafeInteger(expectedVisibleRevision)) {
        throwProjectionBlocked(mapping, projection, "projection visible revision overflowed");
      }
      const payload = parseSyncProjectionEffectPayload(latest.payload_json);
      return {
        expectedVisibleRevision,
        expectedVisibleHash: payload.targetVisibleHash,
        createIfMissing: false,
        streamSequence,
      };
    }
    if (latest.status !== MAPPED_EFFECT_STATUSES.APPLIED) {
      throwProjectionBlocked(mapping, projection, `latest effect is ${latest.status}`);
    }
    return projectionBaselineFromConfirmedState(
      sql,
      mapping,
      projection,
      rowBindingId,
      streamSequence,
    );
  }

  return projectionBaselineFromConfirmedState(
    sql,
    mapping,
    projection,
    rowBindingId,
    POSITIVE_SAFE_INTEGER_MINIMUM,
  );
}

async function projectionBaselineFromConfirmedState(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  projection: ReturnType<typeof requireTypedSheetsEntityProjection>,
  rowBindingId: string,
  streamSequence: number,
): Promise<ProjectionBaseline> {
  const visible = await sql.get<VisibleProjectionSqlRow>(READ_VISIBLE_PROJECTION_STATE_SQL, [
    projection.physicalSheetId,
    projection.projection,
    rowBindingId,
  ]);
  if (visible === undefined) {
    return {
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      createIfMissing: true,
      streamSequence,
    };
  }
  if (
    !isNonNegativeSafeInteger(visible.confirmed_visible_revision) ||
    visible.confirmed_snapshot_hash.length === EMPTY_STRING_LENGTH_ZERO
  ) {
    throwProjectionBlocked(mapping, projection, "confirmed visible state is invalid");
  }
  return {
    expectedVisibleRevision: visible.confirmed_visible_revision,
    expectedVisibleHash: visible.confirmed_snapshot_hash,
    createIfMissing: false,
    streamSequence,
  };
}

async function insertActiveRowBinding(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  rowBindingId: string,
  entityId: string,
  anchor: string,
): Promise<void> {
  const existing = await sql.get<RowBindingSqlRow>(READ_ROW_BINDING_SQL, [rowBindingId]);
  if (existing !== undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
      `row binding ${rowBindingId} already exists for ${mapping.entityName}:${entityId}.`,
    );
  }
  const inserted = await sql.run(INSERT_ACTIVE_ROW_BINDING_SQL, [
    rowBindingId,
    mapping.logicalSheetId,
    anchor,
    entityId,
    ROW_BINDING_STATES.ACTIVE,
  ]);
  if (inserted.changes !== 1) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
      `could not create the row binding for ${mapping.entityName}:${entityId}.`,
    );
  }
}

async function requireActiveRowBinding(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  rowBindingId: string,
  entityId: string,
  anchor: string,
): Promise<void> {
  const row = await sql.get<RowBindingSqlRow>(READ_ROW_BINDING_SQL, [rowBindingId]);
  if (
    row === undefined ||
    row.logical_sheet_id !== mapping.logicalSheetId ||
    row.anchor_reference !== anchor ||
    row.entity_id !== entityId ||
    row.state !== ROW_BINDING_STATES.ACTIVE
  ) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
      `active row binding is unavailable for ${mapping.entityName}:${entityId}.`,
    );
  }
}

async function requireActiveCanonicalEntityRevision(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
): Promise<number> {
  const entity = await sql.get<CanonicalEntitySqlRow>(READ_ACTIVE_CANONICAL_ENTITY_SQL, [entityId]);
  if (entity === undefined || !isPositiveSafeInteger(entity.entity_revision)) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `active canonical state is unavailable for ${mapping.entityName}:${entityId}.`,
    );
  }
  return entity.entity_revision;
}

async function canonicalFieldRevisions(
  sql: SqlExecutor,
  entityId: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await sql.all<CanonicalFieldRevisionSqlRow>(READ_CANONICAL_FIELD_REVISIONS_SQL, [entityId]);
  const revisions = new Map<string, number>();
  for (const row of rows) {
    if (isPositiveSafeInteger(row.field_revision)) {
      revisions.set(row.field_name, row.field_revision);
    }
  }
  return revisions;
}

async function requireAppliedCanonicalCommit(
  sql: SqlExecutor,
  fence: FencingContext,
  commit: CanonicalCommitInput,
): Promise<void> {
  const result = await commitCanonicalChangesWithSql(sql, fence, commit);
  if (result.kind === CANONICAL_COMMIT_RESULT_KINDS.APPLIED) return;
  if (result.kind === CANONICAL_COMMIT_RESULT_KINDS.FENCED_OUT) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
      "the mapped entity writer lease was lost before canonical state could commit.",
    );
  }
  if (result.kind === CANONICAL_COMMIT_RESULT_KINDS.STALE) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `canonical ${result.target} state became stale while planning an entity flush.`,
    );
  }
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
    `mapped canonical commit is invalid: ${result.reason}.`,
  );
}

async function claimBusinessKey(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): Promise<void> {
  const normalizedKey = businessKeyHash(mapping, encodedEntity);
  await ensureBusinessKeyOwner(sql, mapping, entityId, normalizedKey);
}

async function rotateBusinessKey(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): Promise<void> {
  const current = await sql.get<ActiveBusinessKeySqlRow>(READ_ACTIVE_BUSINESS_KEY_SQL, [
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    entityId,
  ]);
  if (current === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `business-key index is unavailable for ${mapping.entityName}:${entityId}.`,
    );
  }
  const nextNormalizedKey = businessKeyHash(mapping, encodedEntity);
  if (current.normalized_key === nextNormalizedKey) return;
  const retired = await sql.run(RETIRE_ACTIVE_BUSINESS_KEY_SQL, [
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    current.normalized_key,
    entityId,
  ]);
  if (retired.changes !== 1) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `could not retire the previous business key for ${mapping.entityName}:${entityId}.`,
    );
  }
  await ensureBusinessKeyOwner(sql, mapping, entityId, nextNormalizedKey);
}

async function ensureBusinessKeyOwner(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  normalizedKey: string,
): Promise<void> {
  const owner = await sql.get<BusinessKeyOwnerSqlRow>(READ_BUSINESS_KEY_OWNER_SQL, [
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    normalizedKey,
  ]);
  if (owner !== undefined) {
    if (owner.entity_id === entityId) return;
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `business key for ${mapping.entityName} is already owned by ${owner.entity_id}.`,
    );
  }
  const inserted = await sql.run(INSERT_ACTIVE_BUSINESS_KEY_SQL, [
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    normalizedKey,
    entityId,
  ]);
  if (inserted.changes !== 1) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `could not claim the business key for ${mapping.entityName}:${entityId}.`,
    );
  }
}

function businessKeyHash(
  mapping: TypedSheetsEntityMapping,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): string {
  return stableHash(requireEncodedField(encodedEntity, mapping.businessKey));
}

function acceptedSnapshotHash(
  entityId: string,
  fields: Readonly<Record<string, NormalizedCell>>,
): Presence<string> {
  return presentValue(stableHash({
    entityId,
    fields: Object.entries(fields)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fieldName, value]) => ({ fieldName, value })),
  }));
}

function requireEncodedField(
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
  field: TypedSheetsEntityFieldMapping,
): NormalizedCell {
  const value = encodedEntity[field.fieldName];
  if (value === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_MAPPED_FIELD_VALUE,
      `encoded value is unavailable for ${field.fieldName}.`,
    );
  }
  return value;
}

function requireChangeEntityId(
  mapping: TypedSheetsEntityMapping,
  change: TypedSheetsEntityChange,
): string {
  const entityId = typedSheetsEntityId(mapping, change.entity);
  if (change.primaryKey.kind !== PRESENCE_KINDS.PRESENT) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE,
      `${mapping.entityName} has no serialized primary key during flush.`,
    );
  }
  if (change.primaryKey.value !== entityId) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_MISMATCH,
      `${mapping.entityName} primary-key metadata does not match its entity property.`,
    );
  }
  return entityId;
}

function projectionRowTargetId(physicalSheetId: string, rowBindingId: string): string {
  return `projection-row:${physicalSheetId}:${rowBindingId}`;
}

function identifiedValue(prefix: string, writer: ResolvedWriterOptions): string {
  const value = writer.createId();
  if (value.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "mapped writer createId must return a non-empty value.",
    );
  }
  return `${prefix}:${value}`;
}

function mappingRegistry(
  input: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[],
): TypedSheetsEntityMappingRegistry {
  if ("findByEntityName" in input) return input;
  return createTypedSheetsEntityMappingRegistry(input);
}

function timingOperationKind(
  value: TypedSheetsEntityChange["kind"],
): SyncTimingOperationKind {
  if (value === TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE) {
    return SYNC_TIMING_OPERATION_KINDS.APPEND;
  }
  if (value === TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE) {
    return SYNC_TIMING_OPERATION_KINDS.UPDATE;
  }
  return SYNC_TIMING_OPERATION_KINDS.DELETE;
}

function countsForOperationKind(
  operationKind: SyncTimingOperationKind,
): SyncTimingOperationCounts {
  return {
    append: operationKind === SYNC_TIMING_OPERATION_KINDS.APPEND ? 1 : 0,
    update: operationKind === SYNC_TIMING_OPERATION_KINDS.UPDATE ? 1 : 0,
    delete: operationKind === SYNC_TIMING_OPERATION_KINDS.DELETE ? 1 : 0,
  };
}

function countsForPlans(plans: readonly MappedChangePlan[]): SyncTimingOperationCounts {
  return plans.reduce<SyncTimingOperationCounts>((counts, plan) => {
    const operationKind = timingOperationKind(plan.change.kind);
    return {
      append: counts.append + (operationKind === SYNC_TIMING_OPERATION_KINDS.APPEND ? 1 : 0),
      update: counts.update + (operationKind === SYNC_TIMING_OPERATION_KINDS.UPDATE ? 1 : 0),
      delete: counts.delete + (operationKind === SYNC_TIMING_OPERATION_KINDS.DELETE ? 1 : 0),
    };
  }, { append: 0, update: 0, delete: 0 });
}

function operationKindsForCounts(
  counts: SyncTimingOperationCounts,
): readonly SyncTimingOperationKind[] {
  return [
    ...(counts.append > 0 ? [SYNC_TIMING_OPERATION_KINDS.APPEND] : []),
    ...(counts.update > 0 ? [SYNC_TIMING_OPERATION_KINDS.UPDATE] : []),
    ...(counts.delete > 0 ? [SYNC_TIMING_OPERATION_KINDS.DELETE] : []),
  ];
}

function emitTiming(
  writer: ResolvedWriterOptions,
  event: Parameters<SyncTimingSink>[0],
): void {
  try {
    writer.onTiming?.(event);
  } catch {
    // Diagnostics must never abort the entity transaction.
  }
}

function resolveWriterOptions(options: TypedSheetsEntityWriterOptions): ResolvedWriterOptions {
  if (options.writerId.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "mapped writer ID is required.",
    );
  }
  const role = options.role ?? DEFAULT_MAPPED_WRITER_ROLE;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_MAPPED_WRITER_LEASE_DURATION_MS;
  if (role.length === EMPTY_STRING_LENGTH_ZERO ||
    !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < POSITIVE_SAFE_INTEGER_MINIMUM) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "mapped writer role and lease duration must be valid.",
    );
  }
  return {
    writerId: options.writerId,
    role,
    leaseDurationMs,
    now: options.now ?? (() => Date.now()),
    createId: options.createId ?? randomUUID,
    onTiming: options.onTiming,
  };
}

function presentValue<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function absentValue<T>(): Presence<T> {
  return { kind: PRESENCE_KINDS.ABSENT };
}

function applicableValue<T>(value: T): Applicability<T> {
  return { kind: APPLICABILITY_KINDS.APPLICABLE, value };
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= POSITIVE_SAFE_INTEGER_MINIMUM;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function throwProjectionBlocked(
  mapping: TypedSheetsEntityMapping,
  projection: ReturnType<typeof requireTypedSheetsEntityProjection>,
  reason: string,
): never {
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.PROJECTION_OUTBOX_BLOCKED,
    `${mapping.entityName} ${projection.projection} projection is blocked: ${reason}.`,
  );
}
