/** Selects and validates mapped entity changes before lifecycle persistence. */

import {
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
  type TypedSheetsEntityChange,
} from "../../api/contracts.js";
import {
  typedSheetsEntityId,
  type TypedSheetsEntityFieldMapping,
  type TypedSheetsEntityMapping,
  type TypedSheetsEntityMappingRegistry,
} from "../../mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";
import type { MappedChangePlan } from "../support/contracts.js";

/** Builds lifecycle plans for mapped changes and skips unrelated/no-op changes. */
export function collectMappedChanges(
  mappings: TypedSheetsEntityMappingRegistry,
  changes: readonly TypedSheetsEntityChange[],
): readonly MappedChangePlan[] {
  const plans: MappedChangePlan[] = [];
  for (const change of changes) {
    const mapping = mappings.findByEntityName(change.entityName);
    if (mapping === undefined) continue;
    const changedFields = changedMappingFields(mapping, change);
    if (
      change.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE &&
      changedFields.length === 0
    ) continue;
    plans.push({ mapping, change, changedFields });
  }
  return plans;
}

function changedMappingFields(
  mapping: TypedSheetsEntityMapping,
  change: TypedSheetsEntityChange,
): readonly TypedSheetsEntityFieldMapping[] {
  if (change.kind !== TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE) return mapping.fields;
  assertPrimaryKeyUnchanged(mapping, change);
  return mapping.fields.filter((field) => hasOwn(change.payload, field.property));
}

function assertPrimaryKeyUnchanged(
  mapping: TypedSheetsEntityMapping,
  change: TypedSheetsEntityChange,
): void {
  if (!hasOwn(change.payload, mapping.primaryKey)) return;
  const nextPrimaryKey = change.payload[mapping.primaryKey];
  const entityId = typedSheetsEntityId(mapping, change.entity);
  if (nextPrimaryKey !== entityId) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_MUTATION,
      `${mapping.entityName}.${mapping.primaryKey} cannot change after it is mapped to Sheets.`,
    );
  }
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
