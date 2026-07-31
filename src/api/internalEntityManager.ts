/**
 * Public engine-neutral entity manager.
 *
 * The manager owns request-local lifecycle semantics: a fresh identity map and
 * original snapshots via its scalar Unit of Work. It exposes the familiar
 * `fork()` / `create()` / `find()` / `persist()` / `remove()` / `flush()` /
 * `transactional()` workflow without referencing any ORM, raw SQL executor, or
 * provider type. Dirty tracking is computed by Hikoutei against snapshots, so
 * a loaded entity can be mutated and flushed without engine dirty tracking.
 */

import { getEntityDescriptor, type HikouteiEntity } from "./entity.js";
import type { ResolvedHikouteiEntityDescriptor } from "./entity.js";
import type { EntityManager, HikouteiFindOptions } from "./EntityManager.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "./errors.js";
import type {
  ScalarEntityPersistenceProvider,
  ScalarEntityQuery,
  ScalarEntityRow,
  ScalarEntityTransaction,
  ScalarEntityValue,
} from "../adapter/persistence/contracts/scalar.js";
import {
  readEntityValues,
  ScalarEntityUnitOfWork,
  type ScalarEntityFlushPlan,
} from "../application/orm/persistence/scalar/unitOfWork.js";

/** Internal Unit-of-Work implementation behind the public interface. */
class EntityManagerImpl implements EntityManager {
  private readonly unitOfWork: ScalarEntityUnitOfWork;
  private readonly entityDescriptors: WeakMap<object, ResolvedHikouteiEntityDescriptor>;
  private readonly identityMap = new Map<string, object>();
  private activeTransaction: ScalarEntityTransaction | undefined;

  constructor(
    private readonly provider: ScalarEntityPersistenceProvider,
    private readonly descriptors: ReadonlyMap<string, ResolvedHikouteiEntityDescriptor>,
    unitOfWork?: ScalarEntityUnitOfWork,
  ) {
    this.unitOfWork = unitOfWork ?? new ScalarEntityUnitOfWork();
    this.entityDescriptors = new WeakMap();
  }


  /** Opens an isolated manager with its own identity map and snapshots. */
  fork(): EntityManager {
    return new EntityManagerImpl(this.provider, this.descriptors);
  }

  /**
   * Creates a managed entity instance from initial data without writing it.
   *
   * The instance is tracked as a pending insert until the next `flush()`.
   */
  create<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    data: Readonly<Partial<Entity>>,
  ): Entity {
    const descriptor = this.requireDescriptor(entity);
    const instance = buildEntityInstance(
      descriptor,
      data as Readonly<Record<string, unknown>>,
    ) as Entity;
    this.entityDescriptors.set(instance as object, descriptor);
    this.unitOfWork.manageNew(descriptor, instance as unknown as Record<string, unknown>);
    this.rememberIdentity(descriptor, instance as unknown as Record<string, unknown>);
    return instance;
  }

  /** Reads every entity matching an equality filter from the local authority. */
  async find<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where: Readonly<Partial<Entity>> = {} as Readonly<Partial<Entity>>,
    options?: HikouteiFindOptions,
  ): Promise<readonly Entity[]> {
    const descriptor = this.requireDescriptor(entity);
    const query = toQuery(descriptor, where, options);
    const rows = this.activeTransaction === undefined
      ? await this.provider.read(query)
      : await this.activeTransaction.read(query);
    return rows.map((row) => this.materialize(descriptor, row)) as Entity[];
  }

  /** Reads one entity matching an equality filter, or null when none match. */
  async findOne<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where: Readonly<Partial<Entity>>,
  ): Promise<Entity | null> {
    const matches = await this.find(entity, where, { limit: 1 });
    return matches[0] ?? null;
  }

  /** Marks one entity or iterable of entities for insertion or update at flush. */
  persist<Entity extends object>(input: Entity | Iterable<Entity>): this {
    for (const entity of toEntities(input)) {
      const descriptor = this.resolveDescriptorFor(entity);
      this.entityDescriptors.set(entity as object, descriptor);
      this.unitOfWork.persist(descriptor, entity as unknown as Record<string, unknown>);
      this.rememberIdentity(descriptor, entity as unknown as Record<string, unknown>);
    }
    return this;
  }

  /** Marks one entity or iterable of entities for removal at the next flush. */
  remove<Entity extends object>(input: Entity | Iterable<Entity>): this {
    for (const entity of toEntities(input)) {
      this.unitOfWork.remove(entity as object);
    }
    return this;
  }

  /**
   * Commits every pending insert, update, and delete in one provider transaction.
   *
   * When called inside `transactional()` the writes join that transaction;
   * otherwise the manager opens and commits its own transaction. The provider
   * flushes its scheduled work before snapshots advance, so a canonical or
   * outbox failure leaves the Unit of Work retryable.
   */
  async flush(): Promise<void> {
    const plan = this.unitOfWork.collectFlushPlan();
    if (plan.changes.length === 0) return;

    if (this.activeTransaction !== undefined) {
      await applyFlushPlan(this.activeTransaction, plan);
      await this.activeTransaction.flush();
      this.completeFlush(plan);
      return;
    }

    await this.provider.beginTransaction(async (transaction) => {
      await applyFlushPlan(transaction, plan);
      await transaction.flush();
    });
    this.completeFlush(plan);
  }

  /**
   * Runs entity work in one transaction and flushes pending changes on success.
   *
   * The callback receives the same manager; explicit flushes join the active
   * transaction, while an implicit final flush keeps the lifecycle contract
   * useful for short transactional workflows.
   */
  async transactional<Result>(
    operation: (entityManager: EntityManager) => Promise<Result>,
  ): Promise<Result> {
    const checkpoint = this.unitOfWork.checkpoint();
    const identityCheckpoint = new Map(this.identityMap);
    try {
      return await this.provider.beginTransaction(async (transaction) => {
        const previousTransaction = this.activeTransaction;
        this.activeTransaction = transaction;
        try {
          const result = await operation(this);
          const plan = this.unitOfWork.collectFlushPlan();
          if (plan.changes.length > 0) {
            await applyFlushPlan(transaction, plan);
            await transaction.flush();
            this.completeFlush(plan);
          }
          return result;
        } finally {
          this.activeTransaction = previousTransaction;
        }
      });
    } catch (error: unknown) {
      // A provider can reject after an explicit inner flush (for example when
      // the outer callback throws). Restore both snapshots and identity keys so
      // the caller can inspect/fix the entity and retry the transaction.
      this.unitOfWork.restore(checkpoint);
      this.identityMap.clear();
      for (const [key, entity] of identityCheckpoint) this.identityMap.set(key, entity);
      throw error;
    }
  }

  /** Detaches every managed entity from this manager. */
  clear(): void {
    this.unitOfWork.clear();
    this.identityMap.clear();
  }

  private completeFlush(plan: ScalarEntityFlushPlan): void {
    this.unitOfWork.afterFlush(plan);
    for (const change of plan.changes) {
      if (change.kind === "delete") {
        this.identityMap.delete(identityKey(change.entry.descriptor, change.entry.entity));
      }
    }
  }

  private requireDescriptor<Entity extends object>(
    entity: HikouteiEntity<Entity>,
  ): ResolvedHikouteiEntityDescriptor {
    const entityDescriptor = getEntityDescriptor(entity);
    const descriptor = this.descriptors.get(entityDescriptor.name);
    if (descriptor === undefined) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.UNREGISTERED_ENTITY,
        `entity "${entityDescriptor.name}" was not registered with createTypedSheets().`,
      );
    }
    return descriptor;
  }

  private resolveDescriptorFor(entity: object): ResolvedHikouteiEntityDescriptor {
    const known = this.entityDescriptors.get(entity);
    if (known !== undefined) return known;
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.UNMANAGED_ENTITY,
      "persist() was called with an entity that was not created or loaded by this EntityManager.",
    );
  }

  private materialize(
    descriptor: ResolvedHikouteiEntityDescriptor,
    row: ScalarEntityRow,
  ): object {
    const existing = this.identityMap.get(identityKey(descriptor, row));
    if (existing !== undefined) return existing;

    const instance: Record<string, unknown> = {};
    for (const property of descriptor.properties) {
      instance[property.name] = row[property.name] ?? null;
    }
    this.entityDescriptors.set(instance, descriptor);
    this.identityMap.set(identityKey(descriptor, instance), instance);
    this.unitOfWork.manageLoaded(
      descriptor,
      instance,
      readEntityValues(descriptor, instance),
    );
    return instance;
  }

  private rememberIdentity(
    descriptor: ResolvedHikouteiEntityDescriptor,
    entity: Readonly<Record<string, unknown>>,
  ): void {
    const primaryKey = entity[descriptor.primaryKey];
    if (typeof primaryKey === "string" && primaryKey.length > 0) {
      this.identityMap.set(identityKey(descriptor, entity), entity);
    }
  }
}

/** Internal factory kept out of the root barrel so provider types do not leak. */
export function createEntityManager(
  provider: ScalarEntityPersistenceProvider,
  descriptors: ReadonlyMap<string, ResolvedHikouteiEntityDescriptor>,
): EntityManager {
  return new EntityManagerImpl(provider, descriptors);
}

function buildEntityInstance(
  descriptor: ResolvedHikouteiEntityDescriptor,
  data: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const declared = new Set(descriptor.properties.map((property) => property.name));
  for (const propertyName of Object.keys(data)) {
    if (!declared.has(propertyName)) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
        `"${propertyName}" is not a declared property of entity "${descriptor.name}".`,
      );
    }
  }
  const instance: Record<string, unknown> = {};
  for (const property of descriptor.properties) {
    if (Object.prototype.hasOwnProperty.call(data, property.name)) {
      instance[property.name] = data[property.name];
    } else if (property.nullable) {
      instance[property.name] = null;
    }
  }
  return instance;
}

function toQuery(
  descriptor: ResolvedHikouteiEntityDescriptor,
  where: Readonly<Record<string, unknown>>,
  options?: HikouteiFindOptions,
): ScalarEntityQuery {
  const filter: Record<string, ScalarEntityValue> = {};
  for (const [key, value] of Object.entries(where)) {
    const property = descriptor.properties.find((candidate) => candidate.name === key);
    if (property === undefined) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
        `"${key}" is not a declared property of entity "${descriptor.name}".`,
      );
    }
    filter[key] = requireFilterValue(descriptor, key, property, value);
  }
  requirePageValue(options?.limit, "limit");
  requirePageValue(options?.offset, "offset");
  return {
    tableName: descriptor.tableName,
    primaryKeyColumn: descriptor.primaryKey,
    where: filter,
    ...(options?.limit === undefined ? {} : { limit: options.limit }),
    ...(options?.offset === undefined ? {} : { offset: options.offset }),
  };
}

function requireFilterValue(
  descriptor: ResolvedHikouteiEntityDescriptor,
  key: string,
  property: ResolvedHikouteiEntityDescriptor["properties"][number],
  value: unknown,
): ScalarEntityValue {
  if (value === undefined) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      `filter "${key}" must not be undefined in entity "${descriptor.name}".`,
    );
  }
  if (value === null) {
    if (property.nullable) return null;
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      `filter "${key}" cannot be null in non-nullable entity "${descriptor.name}".`,
    );
  }
  if (property.type === "date") {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      `filter "${key}" expected a valid Date in entity "${descriptor.name}".`,
    );
  }
  if (typeof value !== property.type) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      `filter "${key}" expected ${property.type} but received ${typeof value}.`,
    );
  }
  if (property.type === "number" && !Number.isFinite(value)) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      `filter "${key}" must be a finite number.`,
    );
  }
  return value as ScalarEntityValue;
}

function requirePageValue(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      `${label} must be a non-negative safe integer.`,
    );
  }
}

async function applyFlushPlan(
  transaction: ScalarEntityTransaction,
  plan: ScalarEntityFlushPlan,
): Promise<void> {
  for (const change of plan.changes) {
    if (change.kind === "insert") {
      await transaction.insert(change.row);
    } else if (change.kind === "update") {
      await transaction.update(change.row);
    } else {
      await transaction.delete(change.row);
    }
  }
}

function toEntities<Entity extends object>(input: Entity | Iterable<Entity>): readonly Entity[] {
  if (isIterable(input)) {
    const collected: Entity[] = [];
    for (const entity of input) collected.push(entity);
    return collected;
  }
  return [input];
}

function isIterable<Entity>(value: Entity | Iterable<Entity>): value is Iterable<Entity> {
  return typeof (value as { readonly [Symbol.iterator]?: unknown })[Symbol.iterator] === "function";
}

function identityKey(
  descriptor: ResolvedHikouteiEntityDescriptor,
  entity: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify([
    descriptor.name,
    String(entity[descriptor.primaryKey]),
  ]);
}
