/**
 * Adapter-neutral conversion from an accepted canonical observation to an
 * application entity mutation.
 *
 * The storage writer remains responsible for validating and committing the
 * Sheet observation first. This helper only translates that already-approved
 * canonical result, so an ORM adapter cannot accidentally promote a conflict
 * or quarantined user edit into an entity-table write.
 */

import { ROW_OPERATIONS } from "../../../domain/index.js";
import type { CanonicalCommitInput } from "../../../infrastructure/storage/index.js";
import {
  decodeTypedSheetsEntityField,
  requireTypedSheetsEntityField,
  typedSheetsEntityIdFromCanonical,
  type TypedSheetsEntityMapping,
} from "./entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";

/** Runtime kinds of entity-table mutations derived from accepted observations. */
export const MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS = {
  NONE: "none",
  INSERT: "insert",
  UPDATE: "update",
  DELETE: "delete",
} as const;

/** A safe entity-table mutation derived only from a canonical commit. */
export type MappedObservationEntityMutation =
  | { readonly kind: typeof MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.NONE }
  | {
      readonly kind: typeof MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.INSERT;
      readonly entityId: string;
      readonly data: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: typeof MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.UPDATE;
      readonly entityId: string;
      readonly data: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: typeof MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.DELETE; readonly entityId: string };

/**
 * Translates one accepted canonical commit into a local entity-table mutation.
 *
 * Insert and update values come exclusively from canonical field writes, never
 * from a raw Sheet payload. This preserves the evaluator's per-field conflict
 * decision when an observation has both accepted and conflicting fields.
 */
export function planMappedObservationEntityMutation(
  mapping: TypedSheetsEntityMapping,
  commit: CanonicalCommitInput,
  entityIdOverride?: string,
): MappedObservationEntityMutation {
  const entityId = entityIdOverride ?? typedSheetsEntityIdFromCanonical(mapping, commit.entityId);
  if (commit.kind === ROW_OPERATIONS.DELETE) {
    return {
      kind: MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.DELETE,
      entityId,
    };
  }

  const data: Record<string, unknown> = {};
  if (commit.kind === ROW_OPERATIONS.INSERT) {
    data[mapping.primaryKey] = entityId;
  }

  for (const write of commit.fields) {
    const field = requireTypedSheetsEntityField(mapping, write.fieldName);
    const value = decodeTypedSheetsEntityField(mapping, field, write.value);
    if (field.property === mapping.primaryKey) {
      if (value !== entityId) {
        throw new TypedSheetsOrmError(
          TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_MISMATCH,
          `${mapping.entityName}.${mapping.primaryKey} does not match the canonical entity ID.`,
        );
      }
      data[field.property] = value;
      continue;
    }
    data[field.property] = value;
  }

  if (commit.kind === ROW_OPERATIONS.INSERT) {
    return {
      kind: MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.INSERT,
      entityId,
      data,
    };
  }
  return Object.keys(data).length === 0
    ? { kind: MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.NONE }
    : {
        kind: MAPPED_OBSERVATION_ENTITY_MUTATION_KINDS.UPDATE,
        entityId,
        data,
      };
}
