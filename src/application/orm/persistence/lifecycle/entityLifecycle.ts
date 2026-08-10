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
  typedSheetsCanonicalEntityId,
  typedSheetsEntityAnchor,
  typedSheetsEntityRowBindingId,
  type TypedSheetsEntityFieldMapping,
  type TypedSheetsEntityMapping,
} from "../../mapping/entityMapping.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import type { FencingContext, CanonicalFieldWrite, CanonicalCommitInput } from "../support/contracts.js";
import type { ResolvedWriterOptions, MappedChangePlan } from "../support/contracts.js";
import {
  claimBusinessKey,
  retireEntityBusinessKeys,
  rotateBusinessKey,
} from "../support/businessKeys.js";
import {
  canonicalFieldRevisions,
  existingCanonicalEntityId,
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
  requireChangeEntityId,
  requireEncodedField,
} from "../support/helpers.js";
import { presentValue } from "../../../../shared/state/index.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";

/** Applies one mapped change and emits append/update/delete phase timings. */
export async function applyMappedChange(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  plan: MappedChangePlan,
  options: { readonly suppressUserProjection?: boolean } = {},
): Promise<{ readonly commitId: string }> {
  const changeStartedAt = Date.now();
  const { mapping, change, changedFields } = plan;
  const operationKind = timingOperationKind(change.kind);
  const visibleEntityId = requireChangeEntityId(mapping, change);
  const proposedCanonicalEntityId = typedSheetsCanonicalEntityId(mapping, visibleEntityId);
  const rowBindingId = typedSheetsEntityRowBindingId(mapping, visibleEntityId);
  const anchor = typedSheetsEntityAnchor(mapping, visibleEntityId);
  const entityId = change.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE
    ? proposedCanonicalEntityId
    : await existingCanonicalEntityId(sql, mapping, rowBindingId, anchor) ?? proposedCanonicalEntityId;
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
  let commitId: string;
  if (change.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE) {
    commitId = await createMappedEntity(
      sql,
      fence,
      writer,
      mapping,
      entityId,
      rowBindingId,
      anchor,
      encodedEntity,
      options,
    );
  } else if (change.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE) {
    commitId = await updateMappedEntity(
      sql,
      fence,
      writer,
      mapping,
      entityId,
      rowBindingId,
      anchor,
      encodedEntity,
      changedFields,
      options,
    );
  } else {
    commitId = await deleteMappedEntity(
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
  return { commitId };
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
  options: { readonly suppressUserProjection?: boolean },
): Promise<string> {
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
    { includeUserProjection: !options.suppressUserProjection },
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
  return commitId;
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
  options: { readonly suppressUserProjection?: boolean },
): Promise<string> {
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
    { includeUserProjection: !options.suppressUserProjection },
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
  return commitId;
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
): Promise<string> {
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
  await tombstoneActiveRowBinding(sql, mapping, rowBindingId, entityId);
  await retireEntityBusinessKeys(sql, mapping, entityId);
  return commitId;
}

function acceptedSnapshotHash(
  entityId: string,
  fields: Readonly<Record<string, NormalizedCell>>,
): Presence<string> {
  return presentValue(stableHash({
    entityId,
    fields: Object.entries(fields)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([fieldName, value]) => ({ fieldName, value })),
  }));
}
