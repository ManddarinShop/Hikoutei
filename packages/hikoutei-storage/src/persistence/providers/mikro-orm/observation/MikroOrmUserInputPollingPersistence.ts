/** Turns prepared User_Input changes into evaluator and storage mutations. */

import {
  CANONICAL_RESOLUTION_STATUSES,
  FIELD_OWNERSHIPS,
  ROW_BINDING_STATES,
  ROW_OPERATIONS,
} from "@hikoutei/contracts/domain/model/constants.js";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "@hikoutei/contracts/state/constants.js";
import {
  computeEventKey,
  computeRowHash,
} from "@hikoutei/contracts/domain/evaluate/identity.js";
import { evaluateBatch } from "@hikoutei/contracts/domain/evaluate/evaluateBatch.js";
import { stableHash } from "@hikoutei/contracts/encoding/stableEncode.js";
import type {
  CanonicalEntityState,
  CanonicalResolution,
  CanonicalFieldState,
  ObservedEditBatch,
  RowBindingContext,
} from "@hikoutei/contracts/domain/model/types.js";
import type {
  NormalizedCell,
} from "@hikoutei/contracts/encoding/types.js";
import type { Presence } from "@hikoutei/contracts/state/types.js";
import type { RowEvaluationResult } from "@hikoutei/contracts/domain/evaluate/contracts.js";
import { QUARANTINE_REASONS } from "@hikoutei/contracts/domain/model/constants.js";
import {
  SYNC_PROJECTIONS,
} from "@hikoutei/contracts/sheets/constants.js";
import type {
  TypedSheetsEntityMapping,
} from "@hikoutei/contracts/sync-orm/mapping/contracts.js";
import {
  createTypedSheetsEntityOwnershipManifest,
  requireTypedSheetsEntityProjection,
} from "@hikoutei/contracts/sync-orm/mapping/projection.js";

import { projectionEffects } from "@hikoutei-app-src/application/orm/persistence/projection/projectionEffects.js";
import { identifiedValue } from "@hikoutei-app-src/application/orm/persistence/support/helpers.js";
import type { ResolvedWriterOptions } from "@hikoutei-app-src/application/orm/persistence/support/contracts.js";
import {
  persistPollingQuarantineWithSql,
  POLLING_QUARANTINE_WRITE_RESULT_KINDS,
  type PollingQuarantineInput,
} from "../../../../storage/state/observation/observationQuarantine.js";
import {
  OBSERVED_PROJECTION_EVIDENCE_SOURCES,
} from "../../../../storage/state/observation/observationTypes.js";
import {
  type BusinessKeyChange,
  type CanonicalRowMutation,
  type PersistObservedRowInput,
  type PersistObservedRowResult,
} from "../../../../storage/state/observation/observationWriter.js";
import {
  readMappedCanonicalFieldsWithSql,
} from "../../../../storage/state/mapped/mappedPersistenceSql.js";
import type { FencingContext } from "@hikoutei/ikisaki";
import { OBSERVATION_WRITE_RESULT_KINDS } from "../../../../storage/state/observation/observationConstants.js";
import { auditJson } from "../../../../storage/state/observation/observationAudit.js";
import type { MikroOrmSqliteAdapter } from "../storage/MikroOrmSqliteAdapter.js";
import { persistMappedObservedRowWithMikroOrm } from "./MikroOrmMappedObservation.js";
import {
  type InvalidRow,
  type PreparedRow,
  type SheetAccumulator,
} from "./MikroOrmUserInputPollingInspection.js";
import {
  type EntityStateRecord,
  type MappedPollingState,
  type RowBindingStateRecord,
} from "./MikroOrmUserInputPollingState.js";
import {
  TypedSheetsOrmError,
  TYPED_SHEETS_ORM_ERROR_CODES,
} from "@hikoutei/contracts/sync-orm/errors.js";


/** Persists invalid polling evidence without mutating canonical entity state. */
export async function persistInvalidPollingRows(
  storage: MikroOrmSqliteAdapter,
  writer: ResolvedWriterOptions,
  fence: FencingContext,
  rows: readonly InvalidRow[],
  accumulators: readonly SheetAccumulator[],
): Promise<void> {
  for (const invalid of rows) {
    const projection = requireTypedSheetsEntityProjection(
      invalid.mapping,
      SYNC_PROJECTIONS.USER_INPUT,
    );
    const payloadJson = auditJson({
      snapshotHash: invalid.snapshot.snapshotHash,
      rowNumber: invalid.rowNumber,
      reason: invalid.reason,
      row: invalid.snapshotRow,
    });
    const fieldsJson = auditJson(Object.fromEntries(
      Object.entries(invalid.snapshotRow.cells).map(([fieldName, cell]) => [
        fieldName,
        cell.normalizedCell,
      ]),
    ));
    const input: PollingQuarantineInput = {
      logicalSheetId: invalid.mapping.logicalSheetId,
      physicalSheetId: projection.physicalSheetId,
      rowBindingId: `polling:${projection.physicalSheetId}:${invalid.rowNumber}`,
      rowEvidenceHash: stableHash({
        physicalSheetId: projection.physicalSheetId,
        rowNumber: invalid.rowNumber,
        reason: invalid.reason,
        row: auditJson(invalid.snapshotRow),
      }),
      reason: toQuarantineReason(invalid.reason),
      beforeRowJson: null,
      afterRowJson: payloadJson,
      fieldsJson,
      payloadJson,
      detectedAt: writer.now(),
    };
    const result = await storage.transaction(({ sql }) =>
      persistPollingQuarantineWithSql(sql, fence, input));
    const accumulator = accumulators.find((candidate) => candidate.mapping === invalid.mapping);
    if (accumulator === undefined) continue;
    switch (result.kind) {
      case POLLING_QUARANTINE_WRITE_RESULT_KINDS.INSERTED:
        accumulator.quarantinedRows += 1;
        continue;
      case POLLING_QUARANTINE_WRITE_RESULT_KINDS.DUPLICATE:
        accumulator.duplicateRows += 1;
        continue;
      case POLLING_QUARANTINE_WRITE_RESULT_KINDS.FENCED_OUT:
        accumulator.fencedRows += 1;
        return;
    }
  }
}

/** Persists each prepared row independently under the claimed writer fence. */
export async function persistPreparedRows(
  storage: MikroOrmSqliteAdapter,
  writer: ResolvedWriterOptions,
  fence: FencingContext,
  state: MappedPollingState,
  rows: readonly PreparedRow[],
  accumulators: readonly SheetAccumulator[],
): Promise<readonly PersistObservedRowInput[]> {
  const observedInputs: PersistObservedRowInput[] = [];
  for (const [index, prepared] of rows.entries()) {
    const accumulator = accumulators.find((candidate) => candidate.mapping === prepared.mapping);
    if (accumulator === undefined) continue;
    const input = await createPersistInput(storage, writer, state, prepared);
    const result = await persistMappedObservedRowWithMikroOrm(storage, {
      mappings: [prepared.mapping],
      fence,
      writer,
      input,
    });
    // A newly persisted observation is authoritative for canonical mutation.
    // A duplicate observation is not a new mutation, but its just-read remote
    // visible revision/hash is still valid evidence for a deferred system-wins
    // retry. Stale, quarantined, and fenced-out inputs cannot influence that
    // retry because their evidence was not accepted by the writer boundary.
    if (isObservationEvidenceUsableForDeferredResolution(result)) {
      observedInputs.push(input);
    }
    classifyResult(accumulator, result);
    if (result.kind === OBSERVATION_WRITE_RESULT_KINDS.FENCED_OUT) {
      accumulator.fencedRows += rows.length - index - 1;
      return observedInputs;
    }
  }
  return observedInputs;
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
    projection: SYNC_PROJECTIONS.USER_INPUT,
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
      SYNC_PROJECTIONS.USER_INPUT,
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
  const canonical = await canonicalMutationFor(writer, prepared, evaluation);
  const observedAt = writer.now();
  return {
    physicalSheetId: payload.physicalSheetId,
    observedProjection: {
      source: prepared.snapshotRow.visibleRevision.kind === PRESENCE_KINDS.PRESENT
        ? OBSERVED_PROJECTION_EVIDENCE_SOURCES.REMOTE
        : OBSERVED_PROJECTION_EVIDENCE_SOURCES.SYNTHETIC,
      visibleRevision: prepared.snapshotRow.visibleRevision.kind === PRESENCE_KINDS.PRESENT
        ? prepared.snapshotRow.visibleRevision.value
        : prepared.row.baseVisibleRevision + 1,
      visibleHash: observedVisibleHash(prepared),
      ...(prepared.row.baseVisibleHash === undefined ? {} : {
        baseline: {
          visibleRevision: prepared.row.baseVisibleRevision,
          visibleHash: prepared.row.baseVisibleHash,
        },
      }),
    },
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
): import("@hikoutei/contracts/domain/evaluate/contracts.js").EvaluationContext {
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
  const changedFields = prepared.mapping.fields.filter((field) => acceptedByField.has(field.fieldName));
  const effectsFactory = async (
    sql: import("@hikoutei/contracts/storage/sql.js").SqlExecutor,
    result: { readonly entityRevision: number },
  ) => projectionEffects(
    sql,
    writer,
    prepared.mapping,
    prepared.canonical.entityId,
    prepared.binding.rowBindingId,
    prepared.binding.anchorReference,
    await readMappedCanonicalFieldsWithSql(sql, prepared.canonical.entityId),
    "update",
    changedFields,
    commitId,
    result.entityRevision,
    { includeUserProjection: false },
  );
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
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
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
        effects: [],
        effectsFactory,
      },
      businessKeyChanges,
    },
  };
}

function toQuarantineReason(
  reason: InvalidRow["reason"],
): (typeof QUARANTINE_REASONS)[keyof typeof QUARANTINE_REASONS] {
  switch (reason) {
    case "unknown_business_key":
    case "duplicate_business_key":
      return QUARANTINE_REASONS.AMBIGUOUS_IDENTITY;
    case "non_literal_cell":
    case "formula_cell":
      return QUARANTINE_REASONS.FORMULA_UNSUPPORTED;
    case "merged_cell":
      return QUARANTINE_REASONS.MERGED_CELL_UNSUPPORTED;
    case "error_cell":
      return QUARANTINE_REASONS.CELL_ERROR;
    case "missing_cell":
    case "invalid_cell":
      return QUARANTINE_REASONS.INVALID_CELL;
    case "missing_canonical_state":
    case "missing_visible_state":
      return QUARANTINE_REASONS.INVALID_SNAPSHOT_METADATA;
    case "primary_key_mutation":
      return QUARANTINE_REASONS.IDENTITY_TAMPERING;
  }
}

function observedVisibleHash(prepared: PreparedRow): string {
  if (prepared.snapshotRow.visibleHash.kind === PRESENCE_KINDS.PRESENT) {
    return prepared.snapshotRow.visibleHash.value;
  }
  return stableHash({
    fields: Object.entries(prepared.snapshotRow.cells)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([fieldName, cell]) => ({ fieldName, value: cell.normalizedCell })),
  });
}

export function isAuthoritativeObservationResult(
  result: PersistObservedRowResult,
): result is Extract<
  PersistObservedRowResult,
  { readonly kind: typeof OBSERVATION_WRITE_RESULT_KINDS.PERSISTED }
> {
  return result.kind === OBSERVATION_WRITE_RESULT_KINDS.PERSISTED;
}

/**
 * Identifies results whose current polling read may safely drive deferred
 * system-wins evidence. A duplicate means the observation is already durable,
 * not that the just-read visible baseline is obsolete; the provider CAS still
 * rejects a remote edit that occurs after this read.
 */
export function isObservationEvidenceUsableForDeferredResolution(
  result: PersistObservedRowResult,
): result is Extract<
  PersistObservedRowResult,
  { readonly kind: typeof OBSERVATION_WRITE_RESULT_KINDS.PERSISTED | typeof OBSERVATION_WRITE_RESULT_KINDS.DUPLICATE }
> {
  return result.kind === OBSERVATION_WRITE_RESULT_KINDS.PERSISTED ||
    result.kind === OBSERVATION_WRITE_RESULT_KINDS.DUPLICATE;
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
