/**
 * Pure translation from MikroORM changesets to the adapter-neutral lifecycle
 * contract. No database writes or EntityManager state changes happen here.
 */

import { ChangeSetType } from "@mikro-orm/core";
import type { ChangeSet, FlushEventArgs } from "@mikro-orm/core";

import {
  primaryKeyPresence,
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
  type TypedSheetsEntityChange,
  type TypedSheetsEntityChangeKind,
} from "../../../../orm/api/contracts.js";

/**
 * Collects one effective change per entity from MikroORM's early and regular
 * changesets. A create-then-delete pair cancels before the planner sees it.
 */
export function collectMikroOrmFlushChanges(
  args: FlushEventArgs,
): readonly TypedSheetsEntityChange[] {
  const changesByEntity = new Map<object, TypedSheetsEntityChange>();
  for (const changeSet of args.uow.getChangeSets()) {
    const next = toTypedSheetsEntityChange(changeSet);
    const current = changesByEntity.get(next.entity);
    if (current === undefined) {
      changesByEntity.set(next.entity, next);
      continue;
    }
    if (
      current.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE &&
      next.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE
    ) {
      changesByEntity.delete(next.entity);
      continue;
    }
    changesByEntity.set(next.entity, mergeMikroOrmEntityChanges(current, next));
  }
  return [...changesByEntity.values()];
}

/** Converts one MikroORM changeset into the public lifecycle shape. */
export function toTypedSheetsEntityChange(
  changeSet: ChangeSet<object>,
): TypedSheetsEntityChange {
  return {
    kind: toTypedSheetsChangeKind(changeSet.type),
    entityName: changeSet.meta.className,
    entity: changeSet.entity,
    primaryKey: primaryKeyPresence(changeSet.getSerializedPrimaryKey()),
    payload: { ...changeSet.payload },
  };
}

/** Coalesces multiple changesets for one entity without mutating either input. */
export function mergeMikroOrmEntityChanges(
  current: TypedSheetsEntityChange,
  next: TypedSheetsEntityChange,
): TypedSheetsEntityChange {
  const kind = next.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE
    ? TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE
    : current.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE
      ? TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE
      : next.kind;
  return {
    ...next,
    kind,
    payload: kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE
      ? next.payload
      : { ...current.payload, ...next.payload },
  };
}

/** Maps every MikroORM changeset type to our closed lifecycle set. */
export function toTypedSheetsChangeKind(
  changeSetType: ChangeSetType,
): TypedSheetsEntityChangeKind {
  switch (changeSetType) {
    case ChangeSetType.CREATE:
      return TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE;
    case ChangeSetType.UPDATE:
    case ChangeSetType.UPDATE_EARLY:
      return TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE;
    case ChangeSetType.DELETE:
    case ChangeSetType.DELETE_EARLY:
      return TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE;
  }
}
