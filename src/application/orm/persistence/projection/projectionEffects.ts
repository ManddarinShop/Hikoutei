/**
 * Projection-effect planning for mapped entity lifecycle changes.
 *
 * This module derives system-state and user-input effects from the SQLite
 * baseline. It does not execute them; the outbox worker remains responsible
 * for materializing effects in Apps Script.
 */

import {
  EMPTY_STRING_LENGTH_ZERO,
  FIELD_OWNERSHIPS,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  type EffectTargetKind,
  type NormalizedCell,
} from "../../../../domain/index.js";
import { NORMALIZED_CELL_KINDS } from "../../../../shared/encoding/constants.js";
import { SYNC_GATEWAY_PROJECTIONS } from "../../../sync/gateway/constants.js";
import {
  computeSyncVisibleHash,
  parseSyncProjectionEffectPayload,
} from "../../../sync/gateway/syncGateway.js";
import {
  createCandidateReconcileEffect,
  createSystemProjectionEffect,
  createUserInputDeleteEffect,
} from "../../../sync/outbound/projection/ProjectionEffectFactory.js";
import {
  readMappedLatestProjectionEffectWithSql,
  readMappedVisibleProjectionStateWithSql,
  requireRegisteredSyncSheetWithSql,
} from "../../../../infrastructure/storage/index.js";
import type {
  NewEffect,
  RegisteredSyncSheet,
  SqlExecutor,
} from "../support/contracts.js";
import {
  MAPPED_EFFECT_STATUSES,
  MAPPED_EFFECT_TARGET_KINDS,
  type ProjectionBaseline,
  type ResolvedWriterOptions,
} from "../support/contracts.js";
import {
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
  type TypedSheetsEntityChange,
} from "../../api/contracts.js";
import {
  requireTypedSheetsEntityProjection,
  type TypedSheetsEntityFieldMapping,
  type TypedSheetsEntityMapping,
  type TypedSheetsEntityProjectionMapping,
} from "../../mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";
import {
  absentValue,
  applicableValue,
  identifiedValue,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  projectionRowTargetId,
  requireEncodedField,
  throwProjectionBlocked,
  presentValue,
} from "../support/helpers.js";

/** Plans all projection effects required by one mapped entity lifecycle change. */
export async function projectionEffects(
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

/** Loads and validates the registered route for a mapped projection. */
export async function requireMappedRoute(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjectionMapping,
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

/** Derives the next visible revision/hash from queued or confirmed state. */
export async function projectionBaseline(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjectionMapping,
  rowBindingId: string,
  targetKind: EffectTargetKind,
  targetId: string,
): Promise<ProjectionBaseline> {
  const latest = await readMappedLatestProjectionEffectWithSql(
    sql,
    mapping.logicalSheetId,
    targetKind,
    targetId,
  );
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

/** Reads the last confirmed visible state when no effect is currently queued. */
export async function projectionBaselineFromConfirmedState(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjectionMapping,
  rowBindingId: string,
  streamSequence: number,
): Promise<ProjectionBaseline> {
  const visible = await readMappedVisibleProjectionStateWithSql(
    sql,
    projection.physicalSheetId,
    projection.projection,
    rowBindingId,
  );
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
