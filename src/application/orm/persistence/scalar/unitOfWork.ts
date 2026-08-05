/**
 * Engine-neutral scalar entity Unit of Work.
 *
 * Hikoutei owns entity lifecycle semantics here rather than delegating to an
 * ORM's dirty tracking. The Unit of Work keeps a request-local identity map and
 * the original snapshot of every managed entity, computes a dirty diff against
 * those snapshots at flush time, and owns the insert/update/delete change plan.
 *
 * The change plan is pure data over the provider-neutral persistence contract,
 * so the same lifecycle works whether SQLite is reached through node:sqlite,
 * MikroORM, or a future Prisma adapter.
 */

import type { ResolvedHikouteiEntityDescriptor } from "../../../../api/entity.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "../../../../api/errors.js";
import type {
  ScalarEntityDelete,
  ScalarEntityInsert,
  ScalarEntityUpdate,
  ScalarEntityValue,
} from "../../../../adapter/persistence/contracts/scalar.js";

/** Lifecycle state of one managed entity inside a Unit of Work. */
export type ScalarManagedEntityState = "new" | "clean" | "removed";

/** One managed entity entry tracked by the Unit of Work. */
interface ManagedEntity {
  readonly descriptor: ResolvedHikouteiEntityDescriptor;
  readonly entity: object;
  snapshot: Readonly<Record<string, ScalarEntityValue>>;
  state: ScalarManagedEntityState;
}

/** In-memory checkpoint used to restore the common UoW after transaction rollback. */
export interface ScalarEntityUnitOfWorkCheckpoint {
  readonly entries: readonly {
    readonly descriptor: ResolvedHikouteiEntityDescriptor;
    readonly entity: object;
    readonly snapshot: Readonly<Record<string, ScalarEntityValue>>;
    readonly state: ScalarManagedEntityState;
  }[];
}

/** Discriminated change planned for one managed entity during a flush. */
export type PlannedScalarChange =
  | { readonly kind: "insert"; readonly entry: ManagedEntity; readonly row: ScalarEntityInsert }
  | { readonly kind: "update"; readonly entry: ManagedEntity; readonly row: ScalarEntityUpdate }
  | { readonly kind: "delete"; readonly entry: ManagedEntity; readonly row: ScalarEntityDelete };

/** Ordered insert/update/delete plan collected from one flush. */
export interface ScalarEntityFlushPlan {
  readonly changes: readonly PlannedScalarChange[];
}

/**
 * Request-local identity map and change tracker.
 *
 * One `EntityManager.fork()` owns its own Unit of Work so concurrent requests
 * never share identity maps or dirty snapshots.
 */
export class ScalarEntityUnitOfWork {
  private readonly entries = new Map<object, ManagedEntity>();

  /** Tracks a newly created entity so its first flush emits an insert. */
  manageNew(
    descriptor: ResolvedHikouteiEntityDescriptor,
    entity: object,
  ): void {
    this.entries.set(entity, {
      descriptor,
      entity,
      // New entities are validated when the insert plan is collected. Keeping
      // an empty snapshot here lets create() remain a construction operation
      // while flush() remains the durable validation boundary.
      snapshot: {},
      state: "new",
    });
  }

  /** Tracks an entity loaded from storage so mutations diff against its snapshot. */
  manageLoaded(
    descriptor: ResolvedHikouteiEntityDescriptor,
    entity: object,
    snapshot: Readonly<Record<string, ScalarEntityValue>>,
  ): void {
    this.entries.set(entity, { descriptor, entity, snapshot, state: "clean" });
  }

  /** Returns whether an entity instance is currently tracked by this Unit of Work. */
  has(entity: object): boolean {
    return this.entries.has(entity);
  }

  /** Captures lifecycle state before an outer transaction can roll back. */
  checkpoint(): ScalarEntityUnitOfWorkCheckpoint {
    return {
      entries: [...this.entries.values()].map((entry) => ({
        descriptor: entry.descriptor,
        entity: entry.entity,
        snapshot: { ...entry.snapshot },
        state: entry.state,
      })),
    };
  }

  /** Restores the lifecycle state captured before a failed transaction. */
  restore(checkpoint: ScalarEntityUnitOfWorkCheckpoint): void {
    this.entries.clear();
    for (const entry of checkpoint.entries) {
      this.entries.set(entry.entity, {
        descriptor: entry.descriptor,
        entity: entry.entity,
        snapshot: entry.snapshot,
        state: entry.state,
      });
    }
  }

  /** Marks a tracked entity (or registers a new one) for the next flush. */
  persist(descriptor: ResolvedHikouteiEntityDescriptor, entity: object): void {
    const existing = this.entries.get(entity);
    if (existing === undefined) {
      this.manageNew(descriptor, entity);
      return;
    }
    if (existing.state === "removed") {
      existing.state = "clean";
    }
  }

  /** Marks a tracked entity for removal; cancels an unflushed insert instead. */
  remove(entity: object): void {
    const existing = this.entries.get(entity);
    if (existing === undefined) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.UNMANAGED_ENTITY,
        "remove() was called with an entity that is not managed by this EntityManager.",
      );
    }
    if (existing.state === "new") {
      this.entries.delete(entity);
      return;
    }
    existing.state = "removed";
  }

  /**
   * Builds the insert/update/delete plan from the current identity map.
   *
   * Throws a typed error when a primary key is missing or when a tracked entity
   * mutated its primary key, which is immutable after creation.
   */
  collectFlushPlan(): ScalarEntityFlushPlan {
    const changes: PlannedScalarChange[] = [];
    for (const entry of this.entries.values()) {
      const change = planChange(entry);
      if (change !== undefined) changes.push(change);
    }
    return { changes };
  }

  /** Resets snapshots and drops committed entries after a successful flush. */
  afterFlush(plan: ScalarEntityFlushPlan): void {
    for (const change of plan.changes) {
      const { entry } = change;
      if (change.kind === "delete") {
        this.entries.delete(entry.entity);
        continue;
      }
      entry.snapshot = readEntityValues(entry.descriptor, entry.entity);
      entry.state = "clean";
    }
  }

  /** Drops every managed entity without writing anything. */
  clear(): void {
    this.entries.clear();
  }
}

function planChange(entry: ManagedEntity): PlannedScalarChange | undefined {
  const { descriptor } = entry;
  if (entry.state === "new") {
    const values = readEntityValues(descriptor, entry.entity);
    requirePrimaryKeyValue(descriptor, values[descriptor.primaryKey]);
    return {
      kind: "insert",
      entry,
      row: {
        tableName: descriptor.tableName,
        primaryKeyColumn: descriptor.primaryKey,
        values,
      },
    };
  }
  if (entry.state === "removed") {
    return {
      kind: "delete",
      entry,
      row: {
        tableName: descriptor.tableName,
        primaryKeyColumn: descriptor.primaryKey,
        primaryKeyValue: snapshotPrimaryKey(descriptor, entry),
      },
    };
  }
  return planUpdateIfDirty(entry);
}

function planUpdateIfDirty(entry: ManagedEntity): PlannedScalarChange | undefined {
  const { descriptor, snapshot } = entry;
  const current = readEntityValues(descriptor, entry.entity);
  const snapshotPrimaryKeyValue = requirePrimaryKeyValue(descriptor, snapshot[descriptor.primaryKey]);
  const currentPrimaryKeyValue = current[descriptor.primaryKey];
  if (currentPrimaryKeyValue !== snapshotPrimaryKeyValue) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_MUTATION,
      `${descriptor.name}.${descriptor.primaryKey} cannot change after the entity is created.`,
    );
  }
  const changedValues = collectChangedValues(descriptor, snapshot, current);
  if (changedValues === undefined) return undefined;
  return {
    kind: "update",
    entry,
    row: {
      tableName: descriptor.tableName,
      primaryKeyColumn: descriptor.primaryKey,
      primaryKeyValue: snapshotPrimaryKeyValue,
      changedValues,
    },
  };
}

function collectChangedValues(
  descriptor: ResolvedHikouteiEntityDescriptor,
  snapshot: Readonly<Record<string, ScalarEntityValue>>,
  current: Readonly<Record<string, ScalarEntityValue>>,
): Readonly<Record<string, ScalarEntityValue>> | undefined {
  const changed: Record<string, ScalarEntityValue> = {};
  let hasChange = false;
  for (const property of descriptor.properties) {
    const before = snapshot[property.name] ?? null;
    const after = current[property.name] ?? null;
    if (!sameScalarValue(before, after)) {
      changed[property.name] = after;
      hasChange = true;
    }
  }
  return hasChange ? changed : undefined;
}

function sameScalarValue(before: ScalarEntityValue, after: ScalarEntityValue): boolean {
  if (before instanceof Date && after instanceof Date) {
    return before.getTime() === after.getTime();
  }
  return before === after;
}

function snapshotPrimaryKey(
  descriptor: ResolvedHikouteiEntityDescriptor,
  entry: ManagedEntity,
): ScalarEntityValue {
  return requirePrimaryKeyValue(descriptor, entry.snapshot[descriptor.primaryKey]);
}

function requirePrimaryKeyValue(
  descriptor: ResolvedHikouteiEntityDescriptor,
  value: ScalarEntityValue | undefined,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE,
      `${descriptor.name}.${descriptor.primaryKey} must be a non-empty string before flush.`,
    );
  }
  return value;
}

/** Reads the declared scalar values from one managed entity instance. */
export function readEntityValues(
  descriptor: ResolvedHikouteiEntityDescriptor,
  entity: object,
): Readonly<Record<string, ScalarEntityValue>> {
  const values: Record<string, ScalarEntityValue> = {};
  for (const property of descriptor.properties) {
    values[property.name] = readScalarValue(property, Reflect.get(entity, property.name));
  }
  return values;
}

function readScalarValue(
  property: ResolvedHikouteiEntityDescriptor["properties"][number],
  value: unknown,
): ScalarEntityValue {
  if (value === null || value === undefined) {
    if (property.nullable) return null;
    throw new HikouteiError(
      property.primary
        ? HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE
        : HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      `${property.name} is not nullable but was ${value === null ? "null" : "missing"}.`,
    );
  }

  switch (property.type) {
    case "date":
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw new HikouteiError(
          HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
          `${property.name} expected a valid Date but received ${typeof value}.`,
        );
      }
      return new Date(value.getTime());
    case "string":
      if (typeof value !== "string") {
        throw new HikouteiError(
          property.primary
            ? HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE
            : HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
          `${property.name} expected string but received ${typeof value}.`,
        );
      }
      if (property.primary && value.length === 0) {
        throw new HikouteiError(
          HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE,
          `${property.name} must be a non-empty string before flush.`,
        );
      }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new HikouteiError(
          property.primary
            ? HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE
            : HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
          `${property.name} expected a finite number but received ${typeof value}.`,
        );
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new HikouteiError(
          property.primary
            ? HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE
            : HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
          `${property.name} expected boolean but received ${typeof value}.`,
        );
      }
      return value;
  }
}
