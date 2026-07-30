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
  type NewEffect,
  type RegisteredSyncSheet,
} from "../support/contracts.js";
import {
  MAPPED_EFFECT_STATUSES,
  MAPPED_EFFECT_TARGET_KINDS,
  type ProjectionBaseline,
  type ResolvedWriterOptions,
} from "../support/contracts.js";
import {
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
  type TypedSheetsPersistenceContext,
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
  persistence: TypedSheetsPersistenceContext,
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
  const systemRoute = await requireMappedRoute(persistence, mapping, systemProjection);
  const systemTarget = {
    targetKind: MAPPED_EFFECT_TARGET_KINDS.ENTITY,
    targetId: entityId,
  } as const;
  const systemBaseline = await projectionBaseline(
    persistence,
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

  const userRoute = await requireMappedRoute(persistence, mapping, userProjection);
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
    persistence,
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
  persistence: TypedSheetsPersistenceContext,
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjectionMapping,
): Promise<RegisteredSyncSheet> {
  const route = await persistence.requireRegisteredSyncSheet(projection.physicalSheetId);
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
  persistence: TypedSheetsPersistenceContext,
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjectionMapping,
  rowBindingId: string,
  targetKind: EffectTargetKind,
  targetId: string,
): Promise<ProjectionBaseline> {
  const latest = await persistence.readLatestProjectionEffect(
    mapping.logicalSheetId,
    targetKind,
    targetId,
  );
  if (latest !== undefined) {
    if (
      latest.physicalSheetId !== projection.physicalSheetId ||
      latest.projection !== projection.projection ||
      !isPositiveSafeInteger(latest.streamSequence)
    ) {
      throwProjectionBlocked(mapping, projection, "latest target effect has incompatible routing");
    }
    const streamSequence = latest.streamSequence + 1;
    if (!isPositiveSafeInteger(streamSequence)) {
      throwProjectionBlocked(mapping, projection, "projection stream sequence overflowed");
    }
    if (
      latest.status === MAPPED_EFFECT_STATUSES.PENDING ||
      latest.status === MAPPED_EFFECT_STATUSES.PROCESSING
    ) {
      if (!isNonNegativeSafeInteger(latest.expectedVisibleRevision)) {
        throwProjectionBlocked(mapping, projection, "latest effect has an invalid expected visible revision");
      }
      const expectedVisibleRevision = latest.expectedVisibleRevision + 1;
      if (!isNonNegativeSafeInteger(expectedVisibleRevision)) {
        throwProjectionBlocked(mapping, projection, "projection visible revision overflowed");
      }
      const payload = parseSyncProjectionEffectPayload(latest.payloadJson);
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
      persistence,
      mapping,
      projection,
      rowBindingId,
      streamSequence,
    );
  }

  return projectionBaselineFromConfirmedState(
    persistence,
    mapping,
    projection,
    rowBindingId,
    POSITIVE_SAFE_INTEGER_MINIMUM,
  );
}

/** Reads the last confirmed visible state when no effect is currently queued. */
export async function projectionBaselineFromConfirmedState(
  persistence: TypedSheetsPersistenceContext,
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjectionMapping,
  rowBindingId: string,
  streamSequence: number,
): Promise<ProjectionBaseline> {
  const visible = await persistence.readVisibleProjectionState(
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
    !isNonNegativeSafeInteger(visible.confirmedVisibleRevision) ||
    visible.confirmedSnapshotHash.length === EMPTY_STRING_LENGTH_ZERO
  ) {
    throwProjectionBlocked(mapping, projection, "confirmed visible state is invalid");
  }
  return {
    expectedVisibleRevision: visible.confirmedVisibleRevision,
    expectedVisibleHash: visible.confirmedSnapshotHash,
    createIfMissing: false,
    streamSequence,
  };
}
