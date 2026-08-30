/**
 * Projection-effect planning for mapped entity lifecycle changes.
 *
 * This module derives system-state and user-input effects from the SQLite
 * baseline. It does not execute them; the outbox worker remains responsible
 * for materializing effects through the sync provider.
 */

import {
  FIELD_OWNERSHIPS,
  type EffectTargetKind,
} from "@hikoutei/contracts/domain/model/constants.js";
import {
  EMPTY_STRING_LENGTH_ZERO,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "@hikoutei/contracts/constants.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { NORMALIZED_CELL_KINDS } from "@hikoutei/contracts/encoding/constants.js";
import { SYNC_PROJECTIONS } from "@hikoutei/contracts/sheets/constants.js";
import {
  computeSyncVisibleHash,
  parseSyncProjectionEffectPayload,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  createCandidateReconcileEffect,
  createSystemProjectionEffect,
  createUserInputDeleteEffect,
} from "../../../sync/outbound/projection/ProjectionEffectFactory.js";
import {
  EFFECT_KINDS,
  EFFECT_STATUSES,
  isRecoverableEffectErrorCode,
} from "@hikoutei/ikisaki";
import {
  readMappedLatestProjectionEffectWithSql,
  readMappedVisibleProjectionStateWithSql,
} from "../../../../infrastructure/storage/state/mapped/mappedPersistenceSql.js";
import type { MappedLatestProjectionEffectSqlRow } from "../../../../infrastructure/storage/state/mapped/mappedPersistenceSql.js";
import {
  requireRegisteredSyncSheetWithSql,
} from "../../../../infrastructure/storage/sync/shared/syncRegistry.js";
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
  SCALAR_ENTITY_CHANGE_KINDS,
  type ScalarEntityFlushChange,
} from "@hikoutei/contracts/storage/scalar.js";
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
  identifiedValue,
  projectionRowTargetId,
  requireEncodedField,
  throwProjectionBlocked,
} from "../support/helpers.js";
import {
  absentValue,
  applicableValue,
  presentValue,
} from "@hikoutei/contracts/state/index.js";
import {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from "@hikoutei/contracts/validation.js";

/** Plans all projection effects required by one mapped entity lifecycle change. */
export async function projectionEffects(
  sql: SqlExecutor,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  rowBindingId: string,
  anchor: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
  changeKind: ScalarEntityFlushChange["kind"],
  changedFields: readonly TypedSheetsEntityFieldMapping[],
  commitId: string,
  targetEntityRevision: number,
  options: { readonly includeUserProjection?: boolean } = {},
): Promise<readonly NewEffect[]> {
  const systemProjection = requireTypedSheetsEntityProjection(
    mapping,
    SYNC_PROJECTIONS.SYSTEM_STATE,
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
      value: changeKind === SCALAR_ENTITY_CHANGE_KINDS.DELETE,
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
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
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
    (projection) => projection.projection === SYNC_PROJECTIONS.USER_INPUT,
  );
  if (userProjection === undefined) return effects;
  const shouldReconcileUserInput = options.includeUserProjection !== false &&
    userProjection !== undefined &&
    changeKind !== SCALAR_ENTITY_CHANGE_KINDS.DELETE &&
    (changeKind === SCALAR_ENTITY_CHANGE_KINDS.INSERT ||
      changedFields.some((field) => field.ownership === FIELD_OWNERSHIPS.USER));
  if (
    changeKind !== SCALAR_ENTITY_CHANGE_KINDS.DELETE &&
    !shouldReconcileUserInput
  ) return effects;

  const userRoute = await requireMappedRoute(sql, mapping, userProjection);
  const userFields = Object.fromEntries(
    mapping.fields
      .filter((field) => field.ownership === FIELD_OWNERSHIPS.USER)
      .map((field): readonly [string, NormalizedCell] => [
        field.fieldName,
        requireEncodedField(encodedEntity, field),
      ]),
  );
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
  if (changeKind === SCALAR_ENTITY_CHANGE_KINDS.DELETE) {
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

/**
 * Builds the recreate baseline when the newest User_Input effect is a delete.
 *
 * A physically deleted row must be recreated from an empty baseline: expected
 * visible revision 0 and empty hash, with create-if-missing so the provider
 * creates the row instead of mismatching its (gone) pre-delete hash. The
 * stream sequence still follows the delete as predecessor + 1. Queueing is
 * allowed while the delete is still in flight or failed recoverably; terminal
 * unsafe states stay fail-closed.
 */
function userInputRecreateBaseline(
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjectionMapping,
  latest: MappedLatestProjectionEffectSqlRow,
  streamSequence: number,
): ProjectionBaseline {
  const deletable =
    latest.status === EFFECT_STATUSES.PENDING ||
    latest.status === EFFECT_STATUSES.PROCESSING ||
    latest.status === EFFECT_STATUSES.DELIVERY_UNCERTAIN ||
    latest.status === EFFECT_STATUSES.APPLIED ||
    (latest.status === EFFECT_STATUSES.FAILED &&
      isRecoverableEffectErrorCode(latest.last_error_code));
  if (!deletable) {
    throwProjectionBlocked(mapping, projection, `latest user_input effect is ${latest.status}`);
  }
  return {
    expectedVisibleRevision: 0,
    expectedVisibleHash: "",
    createIfMissing: true,
    streamSequence,
  };
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
      projection.projection === SYNC_PROJECTIONS.USER_INPUT &&
      latest.effect_kind === EFFECT_KINDS.USER_INPUT_DELETE
    ) {
      return userInputRecreateBaseline(mapping, projection, latest, streamSequence);
    }
    if (
      latest.status === MAPPED_EFFECT_STATUSES.PENDING ||
      latest.status === MAPPED_EFFECT_STATUSES.PROCESSING
    ) {
      if (!isNonNegativeSafeInteger(latest.expected_visible_revision)) {
        throwProjectionBlocked(mapping, projection, "latest effect has an invalid expected visible revision");
      }
      // The in-flight effect may be a create-baseline repair (expected
      // revision 0) whose confirmation clamps the durable confirmed
      // revision forward (confirmed + 1) when it settles. A follower
      // planned against the repair's expected revision alone could then
      // confirm below the clamped revision and be rejected by the
      // visible-state upsert guard as a regression, wedging the stream.
      // Floor the follower revision at the last confirmed revision so the
      // chain stays monotonic; the hash still comes from the in-flight
      // effect's target because that is what the sheet will show after it
      // applies.
      const visible = await readMappedVisibleProjectionStateWithSql(
        sql,
        projection.physicalSheetId,
        projection.projection,
        rowBindingId,
      );
      if (visible !== undefined && !isNonNegativeSafeInteger(visible.confirmed_visible_revision)) {
        throwProjectionBlocked(mapping, projection, "confirmed visible state is invalid");
      }
      const expectedVisibleRevision = Math.max(
        latest.expected_visible_revision + 1,
        visible === undefined ? 0 : visible.confirmed_visible_revision,
      );
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
