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
import type { EntityManager } from "./EntityManager.js";
import type {
  HikouteiFilter,
  HikouteiFindOneOptions,
  HikouteiFindOptions,
} from "./query.js";
import {
  normalizeEntityFindOneQuery,
  normalizeEntityQuery,
} from "./queryNormalization.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "./errors.js";
import type {
  ScalarEntityCountQuery,
  ScalarEntityPersistenceProvider,
  ScalarEntityQuery,
  ScalarEntityReader,
  ScalarEntityRow,
  ScalarEntityTransaction,
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
    const instance = promoteManagedEntity<Entity>(buildEntityInstance(descriptor, data));
    this.entityDescriptors.set(instance, descriptor);
    this.unitOfWork.manageNew(descriptor, instance);
    this.rememberIdentity(descriptor, instance);
    return instance;
  }

  /** Reads every entity matching one validated local query. */
  async find<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where?: HikouteiFilter<Entity>,
    options?: HikouteiFindOptions<Entity>,
  ): Promise<readonly Entity[]> {
    const descriptor = this.requireDescriptor(entity);
    const query = normalizeEntityQuery(descriptor, where ?? {}, options);
    const reader = this.activeTransaction ?? this.provider;
    const rows = await reader.read(query);
    return this.materializeRows<Entity>(descriptor, rows);
  }

  /** Reads one entity matching a validated query, or null when none match. */
  async findOne<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where: HikouteiFilter<Entity>,
    options?: HikouteiFindOneOptions<Entity>,
  ): Promise<Entity | null> {
    const descriptor = this.requireDescriptor(entity);
    const query = normalizeEntityFindOneQuery(descriptor, where, options);
    const reader = this.activeTransaction ?? this.provider;
    const rows = await reader.read(query);
    const row = rows[0];
    return row === undefined
      ? null
      : promoteManagedEntity<Entity>(this.materialize(descriptor, row));
  }

  /** Counts all rows matching a validated filter without changing the identity map. */
  async count<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where?: HikouteiFilter<Entity>,
  ): Promise<number> {
    const descriptor = this.requireDescriptor(entity);
    const query = countQuery(normalizeEntityQuery(descriptor, where ?? {}, undefined));
    const reader = this.activeTransaction ?? this.provider;
    return reader.count(query);
  }

  /** Reads one page and its unpaged total from the same SQLite snapshot. */
  async findAndCount<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where?: HikouteiFilter<Entity>,
    options?: HikouteiFindOptions<Entity>,
  ): Promise<readonly [readonly Entity[], number]> {
    const descriptor = this.requireDescriptor(entity);
    const query = normalizeEntityQuery(descriptor, where ?? {}, options);
    const operation = async (
      reader: ScalarEntityReader,
    ): Promise<readonly [readonly ScalarEntityRow[], number]> => {
      const rows = await reader.read(query);
      const total = await reader.count(countQuery(query));
      return [rows, total];
    };
    const [rows, total] = this.activeTransaction === undefined
      ? await this.provider.readSnapshot(operation)
      : await operation(this.activeTransaction);
    return [this.materializeRows<Entity>(descriptor, rows), total];
  }

  /** Marks one entity or iterable of entities for insertion or update at flush. */
  persist<Entity extends object>(input: Entity | Iterable<Entity>): this {
    for (const entity of toEntities(input)) {
      const descriptor = this.resolveDescriptorFor(entity);
      this.entityDescriptors.set(entity, descriptor);
      this.unitOfWork.persist(descriptor, entity);
      this.rememberIdentity(descriptor, entity);
    }
    return this;
  }

  /** Marks one entity or iterable of entities for removal at the next flush. */
  remove<Entity extends object>(input: Entity | Iterable<Entity>): this {
    for (const entity of toEntities(input)) {
      this.unitOfWork.remove(entity);
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

  private materializeRows<Entity extends object>(
    descriptor: ResolvedHikouteiEntityDescriptor,
    rows: readonly ScalarEntityRow[],
  ): readonly Entity[] {
    return rows.map((row) =>
      promoteManagedEntity<Entity>(this.materialize(descriptor, row)),
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
    entity: object,
  ): void {
    const primaryKey = Reflect.get(entity, descriptor.primaryKey);
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
  data: object,
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
      instance[property.name] = Reflect.get(data, property.name);
    } else if (property.nullable) {
      instance[property.name] = null;
    }
  }
  return instance;
}

function countQuery(query: ScalarEntityQuery): ScalarEntityCountQuery {
  return {
    tableName: query.tableName,
    primaryKeyColumn: query.primaryKeyColumn,
    predicate: query.predicate,
  };
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

function isIterable<Entity extends object>(value: Entity | Iterable<Entity>): value is Iterable<Entity> {
  return typeof Reflect.get(value, Symbol.iterator) === "function";
}

function identityKey(
  descriptor: ResolvedHikouteiEntityDescriptor,
  entity: object,
): string {
  return JSON.stringify([
    descriptor.name,
    String(Reflect.get(entity, descriptor.primaryKey)),
  ]);
}

/** Bridges the runtime object to the descriptor's phantom public entity type. */
function promoteManagedEntity<Entity extends object>(value: object): Entity {
  return value as Entity;
}
