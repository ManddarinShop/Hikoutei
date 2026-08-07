/**
 * MikroORM bridge for applying accepted Sheet observations to mapped entities.
 *
 * It deliberately uses MikroORM's native write methods rather than the public
 * Unit of Work. The observation has already created its canonical and
 * outbox records, and replaying `onFlush` here would incorrectly schedule a
 * second outbound Sheets projection.
 */

import { PRESENCE_KINDS } from "../../../../../shared/state/index.js";
import {
  persistObservedRowWithSql,
  type CanonicalCommitInput,
  type FencingContext,
  type PersistObservedRowInput,
  type PersistObservedRowResult,
} from "../../../../../infrastructure/storage/index.js";
import { OBSERVATION_WRITE_RESULT_KINDS } from "../../../../../infrastructure/storage/state/observation/observationConstants.js";
import {
  createTypedSheetsEntityMappingRegistry,
  decodeTypedSheetsEntityField,
  requireTypedSheetsEntityField,
  typedSheetsCanonicalEntityId,
  typedSheetsEntityIdFromCanonical,
  type TypedSheetsEntityMapping,
  type TypedSheetsEntityMappingRegistry,
} from "../../../../../application/orm/mapping/entityMapping.js";
import {
  MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS,
  planMappedObservationEntityMutation,
} from "../../../../../application/orm/mapping/observationMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../../../../application/orm/errors.js";
import {
  autoResolveMappedConflictsWithSql,
} from "../../../../../application/sync/inbound/autoSystemConflictResolution.js";
import type { ResolvedWriterOptions } from "../../../../../application/orm/persistence/support/contracts.js";
import type {
  MikroOrmNativeEntityWriter,
  MikroOrmSqliteAdapter,
} from "../storage/MikroOrmSqliteAdapter.js";

/** Input for committing one pre-evaluated Sheet observation and its entity update together. */
export interface PersistMappedObservedRowOptions {
  readonly mappings: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[];
  readonly fence: FencingContext;
  readonly writer: ResolvedWriterOptions;
  readonly input: PersistObservedRowInput;
}

/**
 * Persists a normalized observation and the matching MikroORM entity mutation
 * in one SQLite transaction.
 *
 * Only a `persisted` observation with a present canonical commit can
 * change the entity table. Duplicate, quarantined, stale, fenced-out, and
 * conflict-only observations leave application entities untouched.
 */
export async function persistMappedObservedRowWithMikroOrm(
  storage: MikroOrmSqliteAdapter,
  options: PersistMappedObservedRowOptions,
): Promise<PersistObservedRowResult> {
  const mappings = mappingRegistry(options.mappings);
  const mapping = mappings.findByPhysicalSheetId(options.input.physicalSheetId);
  if (mapping === undefined || mapping.logicalSheetId !== options.input.batch.sheetId) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_MAPPING_NOT_FOUND,
      `no entity mapping is registered for observed sheet ${options.input.physicalSheetId}.`,
    );
  }

  return storage.transactional(async ({ nativeWriter, sql }) => {
    const result = await persistObservedRowWithSql(sql, options.fence, options.input);
    if (
      result.kind === OBSERVATION_WRITE_RESULT_KINDS.PERSISTED &&
      result.conflictIds.length > 0
    ) {
      await autoResolveMappedConflictsWithSql(
        sql,
        options.fence,
        options.writer,
        mapping,
        options.input,
        result.conflictIds,
      );
    }
    const canonical = options.input.canonical;
    if (
      result.kind !== OBSERVATION_WRITE_RESULT_KINDS.PERSISTED ||
      canonical.kind !== PRESENCE_KINDS.PRESENT
    ) {
      return result;
    }

    const entityId = await resolveObservationEntityId(
      nativeWriter,
      mapping,
      canonical.value.commit,
    );
    const mutation = planMappedObservationEntityMutation(
      mapping,
      canonical.value.commit,
      entityId,
    );
    await applyMappedMutation(
      nativeWriter,
      mapping,
      mutation,
    );
    return result;
  });
}

async function resolveObservationEntityId(
  entityManager: MikroOrmNativeEntityWriter,
  mapping: TypedSheetsEntityMapping,
  commit: CanonicalCommitInput,
): Promise<string> {
  if (commit.kind === "insert") {
    const primaryField = commit.fields.find((field) => field.fieldName === mapping.primaryKey);
    if (primaryField === undefined) {
      return typedSheetsEntityIdFromCanonical(mapping, commit.entityId);
    }
    const field = requireTypedSheetsEntityField(mapping, primaryField.fieldName);
    const value = decodeTypedSheetsEntityField(mapping, field, primaryField.value);
    if (typeof value !== "string" || value.length === 0) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_MISMATCH,
        `insert observation has an invalid ${mapping.entityName}.${mapping.primaryKey}.`,
      );
    }
    const expectedCanonical = typedSheetsCanonicalEntityId(mapping, value);
    if (commit.entityId !== value && commit.entityId !== expectedCanonical) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_MISMATCH,
        `${mapping.entityName}.${mapping.primaryKey} does not match the canonical entity ID.`,
      );
    }
    return value;
  }

  const candidate = typedSheetsEntityIdFromCanonical(mapping, commit.entityId);
  const canonical = commit.entityId;
  const candidateEntity = await entityManager.findOne(
    mapping.entity,
    { [mapping.primaryKey]: candidate },
  );
  const canonicalEntity = candidate === canonical
    ? candidateEntity
    : await entityManager.findOne(mapping.entity, { [mapping.primaryKey]: canonical });
  if (candidateEntity !== null && canonicalEntity !== null && candidate !== canonical) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.OBSERVATION_ENTITY_MUTATION_FAILED,
      `canonical identity ${canonical} is ambiguous for ${mapping.entityName}.`,
    );
  }
  if (candidateEntity !== null) return candidate;
  if (canonicalEntity !== null) return canonical;
  return candidate;
}

async function applyMappedMutation(
  entityManager: MikroOrmNativeEntityWriter,
  mapping: TypedSheetsEntityMapping,
  mutation: ReturnType<typeof planMappedObservationEntityMutation>,
): Promise<void> {
  switch (mutation.kind) {
    case MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.NONE:
      return;
    case MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.INSERT:
      await entityManager.insert(mapping.entity, { ...mutation.data });
      return;
    case MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.UPDATE:
      await requireExactlyOneMutation(
        entityManager.nativeUpdate(
          mapping.entity,
          { [mapping.primaryKey]: mutation.entityId },
          { ...mutation.data },
        ),
        mapping,
        mutation.entityId,
        "update",
      );
      return;
    case MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.DELETE:
      await requireExactlyOneMutation(
        entityManager.nativeDelete(mapping.entity, { [mapping.primaryKey]: mutation.entityId }),
        mapping,
        mutation.entityId,
        "delete",
      );
      return;
  }
}

async function requireExactlyOneMutation(
  mutation: Promise<number>,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  operation: "update" | "delete",
): Promise<void> {
  const changed = await mutation;
  if (changed === 1) return;
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.OBSERVATION_ENTITY_MUTATION_FAILED,
    `accepted observation could not ${operation} exactly one ${mapping.entityName}:${entityId}.`,
  );
}

function mappingRegistry(
  input: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[],
): TypedSheetsEntityMappingRegistry {
  if ("findByEntityName" in input) return input;
  return createTypedSheetsEntityMappingRegistry(input);
}
