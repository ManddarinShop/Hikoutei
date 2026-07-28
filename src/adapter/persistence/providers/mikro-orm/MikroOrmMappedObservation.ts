/**
 * MikroORM bridge for applying accepted Sheet observations to mapped entities.
 *
 * It deliberately uses MikroORM's native write methods rather than the public
 * Unit of Work(작업 단위). The observation has already created its canonical and
 * outbox records, and replaying `onFlush` here would incorrectly schedule a
 * second outbound Sheets projection.
 */

import { PRESENCE_KINDS } from "../../../../core/index.js";
import {
  persistObservedRowWithSql,
  type FencingContext,
  type PersistObservedRowInput,
  type PersistObservedRowResult,
} from "../../../../storage/index.js";
import { OBSERVATION_WRITE_RESULT_KINDS } from "../../../../storage/state/observationConstants.js";
import {
  createTypedSheetsEntityMappingRegistry,
  type TypedSheetsEntityMapping,
  type TypedSheetsEntityMappingRegistry,
} from "../../../../orm/mapping/entityMapping.js";
import {
  MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS,
  planMappedObservationEntityMutation,
} from "../../../../orm/mapping/observationMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../../../orm/errors.js";
import type { MikroOrmSqliteAdapter } from "./MikroOrmSqliteAdapter.js";

/** Input for committing one pre-evaluated Sheet observation and its entity update together. */
export interface PersistMappedObservedRowOptions {
  readonly mappings: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[];
  readonly fence: FencingContext;
  readonly input: PersistObservedRowInput;
}

interface MikroOrmNativeEntityWriter {
  insert(entityName: unknown, data: Record<string, unknown>): Promise<unknown>;
  nativeUpdate(
    entityName: unknown,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number>;
  nativeDelete(entityName: unknown, where: Record<string, unknown>): Promise<number>;
}

/**
 * Persists a normalized observation and the matching MikroORM entity mutation
 * in one SQLite transaction.
 *
 * Only a `persisted`(저장 완료) observation with a present canonical commit can
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

  return storage.transactional(async ({ entityManager, sql }) => {
    const result = await persistObservedRowWithSql(sql, options.fence, options.input);
    const canonical = options.input.canonical;
    if (
      result.kind !== OBSERVATION_WRITE_RESULT_KINDS.PERSISTED ||
      canonical.kind !== PRESENCE_KINDS.PRESENT
    ) {
      return result;
    }

    const mutation = planMappedObservationEntityMutation(
      mapping,
      canonical.value.commit,
    );
    await applyMappedMutation(
      entityManager as unknown as MikroOrmNativeEntityWriter,
      mapping,
      mutation,
    );
    return result;
  });
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
