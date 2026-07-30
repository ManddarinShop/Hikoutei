/**
 * Projection-effect planning for mapped entity lifecycle changes.
 *
 * This module derives system-state and user-input effects from the SQLite
 * baseline. It does not execute them; the outbox worker remains responsible
 * for materializing effects in Apps Script.
 */

import {
  FIELD_OWNERSHIPS,
  type NormalizedCell,
} from "../../../../domain/index.js";
import { NORMALIZED_CELL_KINDS } from "../../../../shared/encoding/constants.js";
import { SYNC_GATEWAY_PROJECTIONS } from "../../../sync/gateway/constants.js";
import {
  computeSyncVisibleHash,
} from "../../../sync/gateway/syncGateway.js";
import {
  createCandidateReconcileEffect,
  createSystemProjectionEffect,
  createUserInputDeleteEffect,
} from "../../../sync/outbound/projection/ProjectionEffectFactory.js";
import type { NewEffect } from "../support/contracts.js";
import {
  MAPPED_EFFECT_TARGET_KINDS,
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
} from "../../mapping/entityMapping.js";
import { requireMappedRoute, projectionBaseline } from "./projectionBaseline.js";
import {
  absentValue,
  applicableValue,
  identifiedValue,
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
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
  changeKind: TypedSheetsEntityChange["kind"],
  changedFields: readonly TypedSheetsEntityFieldMapping[],
  commitId: string,
  targetEntityRevision: number,
  options: ProjectionEffectsOptions = {},
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
      fields: systemFields,
      createIfMissing: systemBaseline.createIfMissing,
      expectedVisibleRevision: systemBaseline.expectedVisibleRevision,
      expectedVisibleHash: systemBaseline.expectedVisibleHash,
      targetEntityRevision: applicableValue(targetEntityRevision),
      streamSequence: systemBaseline.streamSequence,
    }),
  ];

  if (options.includeUserProjection === false) return effects;

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
    fields: userFields,
    createIfMissing: userBaseline.createIfMissing,
    expectedVisibleRevision: userBaseline.expectedVisibleRevision,
    expectedVisibleHash: userBaseline.expectedVisibleHash,
    targetEntityRevision: applicableValue(targetEntityRevision),
    streamSequence: userBaseline.streamSequence,
  }));
  return effects;
}

/** Controls which projection effects are emitted for one canonical commit. */
export interface ProjectionEffectsOptions {
  /** Skip User_Input reconciliation when the change originated from User_Input. */
  readonly includeUserProjection?: boolean;
}
