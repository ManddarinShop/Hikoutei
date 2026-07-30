/** Turns prepared User_Input changes into evaluator and storage mutations. */

import {
  APPLICABILITY_KINDS,
  CANONICAL_RESOLUTION_STATUSES,
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
  type CanonicalFieldState,
  type NormalizedCell,
  type ObservedEditBatch,
  type Presence,
  type RowBindingContext,
  type RowEvaluationResult,
} from "../../../../../domain/index.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
} from "../../../../../application/sync/gateway/constants.js";
import {
  createTypedSheetsEntityOwnershipManifest,
  requireTypedSheetsEntityProjection,
  type TypedSheetsEntityMapping,
} from "../../../../../application/orm/mapping/entityMapping.js";
import { projectionEffects } from "../../../../../application/orm/persistence/projection/projectionEffects.js";
import { identifiedValue } from "../../../../../application/orm/persistence/support/helpers.js";
import type { ResolvedWriterOptions } from "../../../../../application/orm/persistence/support/contracts.js";
import {
  createTypedSheetsPersistenceContext,
  type BusinessKeyChange,
  type CanonicalRowMutation,
  type FencingContext,
  type PersistObservedRowInput,
  type PersistObservedRowResult,
} from "../../../../../infrastructure/storage/index.js";
import { OBSERVATION_WRITE_RESULT_KINDS } from "../../../../../infrastructure/storage/state/observation/observationConstants.js";
import { auditJson } from "../../../../../infrastructure/storage/state/observation/observationAudit.js";
import type { MikroOrmSqliteAdapter } from "../storage/MikroOrmSqliteAdapter.js";
import { persistMappedObservedRowWithMikroOrm } from "./MikroOrmMappedObservation.js";
import {
  type PreparedRow,
  type SheetAccumulator,
} from "./MikroOrmUserInputPollingInspection.js";
import {
  type EntityStateRecord,
  type MappedPollingState,
  type RowBindingStateRecord,
} from "./MikroOrmUserInputPollingState.js";
import { TypedSheetsOrmError, TYPED_SHEETS_ORM_ERROR_CODES } from "../../../../../application/orm/errors.js";

/** Persists each prepared row independently under the claimed writer fence. */
export async function persistPreparedRows(
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
  const evaluation = evaluateBatch(
    batch,
    evaluationContext(prepared.mapping, prepared.binding, prepared.canonical, state),
  ).rowResults[0];
  if (evaluation === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "User_Input evaluation did not return a row result.",
    );
  }
  const canonical = await canonicalMutationFor(storage, writer, prepared, evaluation);
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
): import("../../../../../domain/index.js").EvaluationContext {
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
