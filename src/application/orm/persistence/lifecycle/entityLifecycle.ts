/**
 * Applies one mapped entity lifecycle change to canonical SQLite state.
 *
 * Each operation prepares its projection effects first, then commits canonical
 * state and its outbox entries through the storage transaction boundary.
 */

import {
  APPLICABILITY_KINDS,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  ROW_OPERATIONS,
  stableHash,
  type NormalizedCell,
  type Presence,
} from "../../../../domain/index.js";
import { SYNC_TIMING_SCOPES } from "../../../sync/telemetry/syncTiming.js";
import {
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
} from "../../api/contracts.js";
import {
  encodeTypedSheetsEntity,
  typedSheetsEntityAnchor,
  typedSheetsEntityRowBindingId,
  type TypedSheetsEntityFieldMapping,
  type TypedSheetsEntityMapping,
} from "../../mapping/entityMapping.js";
import type { TypedSheetsPersistenceContext } from "../../api/contracts.js";
import type { FencingContext, CanonicalFieldWrite, CanonicalCommitInput } from "../support/contracts.js";
import type { ResolvedWriterOptions, MappedChangePlan } from "../support/contracts.js";
import {
  claimBusinessKey,
  retireEntityBusinessKeys,
  rotateBusinessKey,
} from "../support/businessKeys.js";
import {
  canonicalFieldRevisions,
  insertActiveRowBinding,
  requireActiveCanonicalEntityRevision,
  requireActiveRowBinding,
  requireAppliedCanonicalCommit,
  tombstoneActiveRowBinding,
} from "../support/canonicalState.js";
import { projectionEffects } from "../projection/projectionEffects.js";
import {
  countsForOperationKind,
  emitTiming,
  timingOperationKind,
} from "../support/timing.js";
import {
  identifiedValue,
  presentValue,
  requireChangeEntityId,
  requireEncodedField,
} from "../support/helpers.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";

/** Applies one mapped change and emits append/update/delete phase timings. */
export async function applyMappedChange(
  persistence: TypedSheetsPersistenceContext,
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
      persistence,
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
      persistence,
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
      persistence,
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
  persistence: TypedSheetsPersistenceContext,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  rowBindingId: string,
  anchor: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): Promise<void> {
  await insertActiveRowBinding(persistence, mapping, rowBindingId, entityId, anchor);
  const commitId = identifiedValue("commit", writer);
  const effects = await projectionEffects(
    persistence,
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
  await requireAppliedCanonicalCommit(persistence, fence, commit);
  await claimBusinessKey(persistence, mapping, entityId, encodedEntity);
}

async function updateMappedEntity(
  persistence: TypedSheetsPersistenceContext,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  rowBindingId: string,
  anchor: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
  changedFields: readonly TypedSheetsEntityFieldMapping[],
): Promise<void> {
  await requireActiveRowBinding(persistence, mapping, rowBindingId, entityId, anchor);
  const entityRevision = await requireActiveCanonicalEntityRevision(persistence, mapping, entityId);
  const fieldRevisions = await canonicalFieldRevisions(persistence, entityId);
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
    persistence,
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
  await requireAppliedCanonicalCommit(persistence, fence, commit);
  if (changedFields.some((field) => field.fieldName === mapping.businessKey.fieldName)) {
    await rotateBusinessKey(persistence, mapping, entityId, encodedEntity);
  }
}

async function deleteMappedEntity(
  persistence: TypedSheetsPersistenceContext,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  rowBindingId: string,
  anchor: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): Promise<void> {
  await requireActiveRowBinding(persistence, mapping, rowBindingId, entityId, anchor);
  const entityRevision = await requireActiveCanonicalEntityRevision(persistence, mapping, entityId);
  const nextEntityRevision = entityRevision + 1;
  const commitId = identifiedValue("commit", writer);
  const effects = await projectionEffects(
    persistence,
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
  await requireAppliedCanonicalCommit(persistence, fence, commit);
  await tombstoneActiveRowBinding(persistence, mapping, rowBindingId, entityId);
  await retireEntityBusinessKeys(persistence, mapping, entityId);
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
