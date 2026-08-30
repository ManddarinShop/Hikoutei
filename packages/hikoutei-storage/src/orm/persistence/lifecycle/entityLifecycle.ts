/**
 * Applies one mapped entity lifecycle change to canonical SQLite state.
 *
 * Each operation prepares its projection effects first, then commits canonical
 * state and its outbox entries through the storage transaction boundary.
 */

import {
  ROW_OPERATIONS,
} from "@hikoutei/contracts/domain/model/constants.js";
import {
  APPLICABILITY_KINDS,
} from "@hikoutei/contracts/state/constants.js";
import {
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "@hikoutei/contracts/constants.js";
import { stableHash } from "@hikoutei/contracts/encoding/stableEncode.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import type { Presence } from "@hikoutei/contracts/state/types.js";
import { SYNC_TIMING_SCOPES } from "../../../sync/telemetry/syncTiming.js";
import {
  SCALAR_ENTITY_CHANGE_KINDS,
} from "@hikoutei/contracts/storage/scalar.js";
import {
  encodeTypedSheetsEntityValues,
  typedSheetsCanonicalEntityId,
  typedSheetsEntityAnchor,
  typedSheetsEntityRowBindingId,
  type TypedSheetsEntityFieldMapping,
  type TypedSheetsEntityMapping,
} from "../../mapping/entityMapping.js";
import type { SqlExecutor } from "@hikoutei/contracts/storage/sql.js";
import { readMappedCanonicalFieldsWithSql } from "@hikoutei/storage/storage/state/mapped/mappedPersistenceSql.js";
import type { FencingContext, CanonicalFieldWrite, CanonicalCommitInput } from "../support/contracts.js";
import { CANONICAL_REACTIVATE_OPERATION } from "@hikoutei/storage/storage/state/canonical/canonicalCommit.js";
import type { ResolvedWriterOptions, MappedChangePlan } from "../support/contracts.js";
import {
  claimBusinessKey,
  retireEntityBusinessKeys,
  rotateBusinessKey,
} from "../support/businessKeys.js";
import {
  canonicalFieldRevisions,
  createRowBinding,
  existingCanonicalEntityId,
  requireActiveCanonicalEntityRevision,
  requireActiveRowBinding,
  requireAppliedCanonicalCommit,
  requireTombstonedCanonicalEntityRevision,
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
import { absentValue, presentValue } from "@hikoutei/contracts/state/index.js";
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
  const entityId = change.kind === SCALAR_ENTITY_CHANGE_KINDS.INSERT
    ? proposedCanonicalEntityId
    : await existingCanonicalEntityId(sql, mapping, rowBindingId, anchor) ?? proposedCanonicalEntityId;
  const preparationStartedAt = Date.now();
  const encodedEntity = encodeTypedSheetsEntityValues(mapping, change.row.values);
  emitTiming(writer, {
    scope: SYNC_TIMING_SCOPES.ORM_FLUSH,
    phase: "entity_prepare",
    durationMs: Date.now() - preparationStartedAt,
    operationKinds: [operationKind],
    operationCounts: countsForOperationKind(operationKind),
  });

  const canonicalStartedAt = Date.now();
  let commitId: string;
  if (change.kind === SCALAR_ENTITY_CHANGE_KINDS.INSERT) {
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
  } else if (change.kind === SCALAR_ENTITY_CHANGE_KINDS.UPDATE) {
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
  const binding = await createRowBinding(sql, mapping, rowBindingId, entityId, anchor);
  const commitId = identifiedValue("commit", writer);
  if (binding.kind === "reactivated") {
    await reactivateMappedEntity(
      sql,
      fence,
      writer,
      mapping,
      entityId,
      rowBindingId,
      anchor,
      encodedEntity,
      commitId,
      options,
    );
    return commitId;
  }
  const effects = await projectionEffects(
    sql,
    writer,
    mapping,
    entityId,
    rowBindingId,
    anchor,
    encodedEntity,
    SCALAR_ENTITY_CHANGE_KINDS.INSERT,
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

/**
 * Resurrects an exact tombstoned canonical identity with all fields advanced.
 *
 * A recreate of a previously-deleted primary key CAS-updates every mapped
 * field to `field_revision + 1` and flips the entity from tombstoned to
 * active with `entity_revision + 1`. Effects are planned for an INSERT so
 * System_State clears the tombstone flag and User_Input recreates the row
 * after its delete. Binding and business-key mutations happen outside the
 * canonical savepoint, so any stale CAS failure rolls back the whole outer
 * flush transaction instead of leaving a half-reactivated identity.
 */
async function reactivateMappedEntity(
  sql: SqlExecutor,
  fence: FencingContext,
  writer: ResolvedWriterOptions,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  rowBindingId: string,
  anchor: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
  commitId: string,
  options: { readonly suppressUserProjection?: boolean },
): Promise<void> {
  const tombstonedRevision = await requireTombstonedCanonicalEntityRevision(sql, mapping, entityId);
  const fieldRevisions = await canonicalFieldRevisions(sql, entityId);
  const fields: CanonicalFieldWrite[] = mapping.fields.map((field) => {
    const expectedFieldRevision = fieldRevisions.get(field.fieldName);
    if (expectedFieldRevision === undefined) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
        `${mapping.entityName}.${field.property} has no canonical field revision to advance.`,
      );
    }
    return {
      fieldName: field.fieldName,
      value: requireEncodedField(encodedEntity, field),
      expectedFieldRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: expectedFieldRevision },
      ownership: field.ownership,
    };
  });
  if (fields.length !== fieldRevisions.size) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `${mapping.entityName}:${entityId} has ambiguous canonical field state for recreation.`,
    );
  }
  const nextEntityRevision = tombstonedRevision + 1;
  const commit: CanonicalCommitInput = {
    kind: CANONICAL_REACTIVATE_OPERATION,
    entityId,
    acceptedSnapshotHash: acceptedSnapshotHash(entityId, encodedEntity),
    fields,
    expectedEntityRevision: tombstonedRevision,
    effects: [],
    effectsFactory: async () => {
      const canonicalFields = await readMappedCanonicalFieldsWithSql(sql, entityId);
      return projectionEffects(
        sql,
        writer,
        mapping,
        entityId,
        rowBindingId,
        anchor,
        canonicalFields,
        SCALAR_ENTITY_CHANGE_KINDS.INSERT,
        mapping.fields,
        commitId,
        nextEntityRevision,
        { includeUserProjection: !options.suppressUserProjection },
      );
    },
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
  const commit: CanonicalCommitInput = {
    kind: ROW_OPERATIONS.UPDATE,
    entityId,
    acceptedSnapshotHash: acceptedSnapshotHash(entityId, encodedEntity),
    fields,
    effects: [],
    effectsFactory: async () => {
      const canonicalFields = await readMappedCanonicalFieldsWithSql(sql, entityId);
      return projectionEffects(
        sql,
        writer,
        mapping,
        entityId,
        rowBindingId,
        anchor,
        canonicalFields,
        SCALAR_ENTITY_CHANGE_KINDS.UPDATE,
        changedFields,
        commitId,
        nextEntityRevision,
        { includeUserProjection: !options.suppressUserProjection },
      );
    },
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
  const commit: CanonicalCommitInput = {
    kind: ROW_OPERATIONS.DELETE,
    entityId,
    acceptedSnapshotHash: absentValue(),
    expectedEntityRevision: entityRevision,
    effects: [],
    effectsFactory: async (effectsSql, result) => {
      const canonicalFields = await readMappedCanonicalFieldsWithSql(effectsSql, entityId);
      const encodedCanonicalFields: Record<string, NormalizedCell> = {};
      for (const field of mapping.fields) {
        const value = canonicalFields[field.fieldName];
        if (value !== undefined) encodedCanonicalFields[field.fieldName] = value;
      }
      return projectionEffects(
        effectsSql,
        writer,
        mapping,
        entityId,
        rowBindingId,
        anchor,
        encodedCanonicalFields,
        SCALAR_ENTITY_CHANGE_KINDS.DELETE,
        [],
        commitId,
        result.entityRevision,
      );
    },
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
