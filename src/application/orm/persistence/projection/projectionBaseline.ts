/**
 * Resolves the visible state baseline used by the next projection effect.
 *
 * This module owns the persistence reads and validation needed to establish
 * the expected Sheet revision/hash. Effect planning can therefore focus on
 * which projection should be emitted and leave queued-state rules here.
 */

import {
  EMPTY_STRING_LENGTH_ZERO,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  type EffectTargetKind,
} from "../../../../domain/index.js";
import { parseSyncProjectionEffectPayload } from "../../../sync/gateway/syncGateway.js";
import {
  MAPPED_EFFECT_STATUSES,
  type ProjectionBaseline,
  type RegisteredSyncSheet,
} from "../support/contracts.js";
import type { TypedSheetsPersistenceContext } from "../../api/contracts.js";
import type {
  TypedSheetsEntityMapping,
  TypedSheetsEntityProjectionMapping,
} from "../../mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";
import {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
  throwProjectionBlocked,
} from "../support/helpers.js";

type LatestProjectionEffect = NonNullable<
  Awaited<ReturnType<TypedSheetsPersistenceContext["readLatestProjectionEffect"]>>
>;

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
  if (latest === undefined) {
    return projectionBaselineFromConfirmedState(
      persistence,
      mapping,
      projection,
      rowBindingId,
      POSITIVE_SAFE_INTEGER_MINIMUM,
    );
  }

  assertCompatibleLatestEffect(mapping, projection, latest);
  const streamSequence = nextStreamSequence(mapping, projection, latest.streamSequence);
  if (
    latest.status === MAPPED_EFFECT_STATUSES.PENDING ||
    latest.status === MAPPED_EFFECT_STATUSES.PROCESSING
  ) {
    const expectedVisibleRevision = nextQueuedVisibleRevision(
      mapping,
      projection,
      latest.expectedVisibleRevision,
    );
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

function assertCompatibleLatestEffect(
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjectionMapping,
  latest: LatestProjectionEffect,
): void {
  if (
    latest.physicalSheetId !== projection.physicalSheetId ||
    latest.projection !== projection.projection ||
    !isPositiveSafeInteger(latest.streamSequence)
  ) {
    throwProjectionBlocked(mapping, projection, "latest target effect has incompatible routing");
  }
}

function nextStreamSequence(
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjectionMapping,
  current: number,
): number {
  const streamSequence = current + 1;
  if (!isPositiveSafeInteger(streamSequence)) {
    throwProjectionBlocked(mapping, projection, "projection stream sequence overflowed");
  }
  return streamSequence;
}

function nextQueuedVisibleRevision(
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjectionMapping,
  current: number,
): number {
  if (!isNonNegativeSafeInteger(current)) {
    throwProjectionBlocked(mapping, projection, "latest effect has an invalid expected visible revision");
  }
  const expectedVisibleRevision = current + 1;
  if (!isNonNegativeSafeInteger(expectedVisibleRevision)) {
    throwProjectionBlocked(mapping, projection, "projection visible revision overflowed");
  }
  return expectedVisibleRevision;
}
