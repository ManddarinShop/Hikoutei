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
import {
  describeErrorForInternalLog,
  logHikouteiInternalEvent,
} from "../shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "../shared/observability/logEvents.js";
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
    try {
      const instance = promoteManagedEntity<Entity>(buildEntityInstance(descriptor, data));
      this.entityDescriptors.set(instance, descriptor);
      this.unitOfWork.manageNew(descriptor, instance);
      this.rememberIdentity(descriptor, instance);
      return instance;
    } catch (error: unknown) {
      logLifecycleFailure(descriptor.tableName, error);
      throw error;
    }
  }

  /** Reads every entity matching one validated local query. */
  async find<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where?: HikouteiFilter<Entity>,
    options?: HikouteiFindOptions<Entity>,
  ): Promise<readonly Entity[]> {
    const descriptor = this.requireDescriptor(entity);
    try {
      const query = normalizeEntityQuery(descriptor, effectiveFilter(where), options);
      const reader = this.activeTransaction ?? this.provider;
      const rows = await reader.read(query);
      return this.materializeRows<Entity>(descriptor, rows);
    } catch (error: unknown) {
      logQueryFailure(descriptor.tableName, error);
      throw error;
    }
  }

  /** Reads one entity matching a validated query, or null when none match. */
  async findOne<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where: HikouteiFilter<Entity>,
    options?: HikouteiFindOneOptions<Entity>,
  ): Promise<Entity | null> {
    const descriptor = this.requireDescriptor(entity);
    try {
      const query = normalizeEntityFindOneQuery(descriptor, where, options);
      const reader = this.activeTransaction ?? this.provider;
      const rows = await reader.read(query);
      const row = rows[0];
      return row === undefined
        ? null
        : promoteManagedEntity<Entity>(this.materialize(descriptor, row));
    } catch (error: unknown) {
      logQueryFailure(descriptor.tableName, error);
      throw error;
    }
  }

  /** Counts all rows matching a validated filter without changing the identity map. */
  async count<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where?: HikouteiFilter<Entity>,
  ): Promise<number> {
    const descriptor = this.requireDescriptor(entity);
    try {
      const query = countQuery(normalizeEntityQuery(descriptor, effectiveFilter(where), undefined));
      const reader = this.activeTransaction ?? this.provider;
      return await reader.count(query);
    } catch (error: unknown) {
      logQueryFailure(descriptor.tableName, error);
      throw error;
    }
  }

  /** Reads one page and its unpaged total from the same SQLite snapshot. */
  async findAndCount<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where?: HikouteiFilter<Entity>,
    options?: HikouteiFindOptions<Entity>,
  ): Promise<readonly [readonly Entity[], number]> {
    const descriptor = this.requireDescriptor(entity);
    try {
      const query = normalizeEntityQuery(descriptor, effectiveFilter(where), options);
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
    } catch (error: unknown) {
      logQueryFailure(descriptor.tableName, error);
      throw error;
    }
  }

  /** Marks one entity or iterable of entities for insertion or update at flush. */
  persist<Entity extends object>(input: Entity | Iterable<Entity>): this {
    try {
      for (const entity of toEntities(input)) {
        const descriptor = this.resolveDescriptorFor(entity);
        this.entityDescriptors.set(entity, descriptor);
        this.unitOfWork.persist(descriptor, entity);
        this.rememberIdentity(descriptor, entity);
      }
      return this;
    } catch (error: unknown) {
      logLifecycleFailure(undefined, error);
      throw error;
    }
  }

  /** Marks one entity or iterable of entities for removal at the next flush. */
  remove<Entity extends object>(input: Entity | Iterable<Entity>): this {
    try {
      for (const entity of toEntities(input)) {
        const canceledInsert = this.unitOfWork.remove(entity);
        if (canceledInsert) this.forgetIdentity(entity);
      }
      return this;
    } catch (error: unknown) {
      // Removal can reject for unmanaged/unknown entities; the public error
      // is rethrown unchanged after the redacted boundary record.
      logLifecycleFailure(undefined, error);
      throw error;
    }
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
    const startedAt = Date.now();
    // Inside transactional() an explicit flush joins the active transaction;
    // only the transactional boundary logs so a joined-flush failure is never
    // reported twice.
    const joinsActiveTransaction = this.activeTransaction !== undefined;
    let plan: ScalarEntityFlushPlan | undefined;
    let changedTableCount = 0;
    try {
      // Flush-plan collection validates every pending change (primary keys,
      // identity conflicts, unmanaged entities); failures are boundary
      // records here, rethrown unchanged.
      plan = this.unitOfWork.collectFlushPlan();
      if (plan.changes.length === 0) return;
      changedTableCount = new Set(
        plan.changes.map((change) => change.row.tableName),
      ).size;
      const flushPlan = plan;

      if (this.activeTransaction !== undefined) {
        await applyFlushPlan(this.activeTransaction, flushPlan);
        await this.activeTransaction.flush();
        this.completeFlush(flushPlan);
        return;
      }

      await this.provider.beginTransaction(async (transaction) => {
        await applyFlushPlan(transaction, flushPlan);
        await transaction.flush();
      });
      this.completeFlush(flushPlan);
    } catch (error: unknown) {
      if (!joinsActiveTransaction) {
        logHikouteiInternalEvent({
          event: HIKOUTEI_LOG_EVENTS.EM_FLUSH_FAILED,
          level: "error",
          component: HIKOUTEI_LOG_COMPONENTS.ENTITY_MANAGER,
          ...describeErrorForInternalLog(error),
          durationMs: Date.now() - startedAt,
          counts: { changes: plan?.changes.length ?? 0, tables: changedTableCount },
        });
      }
      throw error;
    }
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
    this.unitOfWork.beginRecovery(checkpoint);
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
      // the outer callback throws). Restore snapshots, values, and identity
      // keys so entities loaded inside the failed callback remain retryable.
      logHikouteiInternalEvent({
        event: HIKOUTEI_LOG_EVENTS.EM_TRANSACTIONAL_FAILED,
        level: "error",
        component: HIKOUTEI_LOG_COMPONENTS.ENTITY_MANAGER,
        ...describeErrorForInternalLog(error),
      });
      this.unitOfWork.restore(checkpoint);
      this.identityMap.clear();
      for (const [key, entity] of identityCheckpoint) this.identityMap.set(key, entity);
      for (const { descriptor, entity } of this.unitOfWork.managedEntities()) {
        this.rememberIdentity(descriptor, entity);
      }
      throw error;
    } finally {
      this.unitOfWork.endRecovery(checkpoint);
    }
  }

  /** Detaches every managed entity from this manager. */
  clear(): void {
    this.unitOfWork.clear();
    this.identityMap.clear();
  }

  private completeFlush(plan: ScalarEntityFlushPlan): void {
    this.unitOfWork.afterFlush(plan);
    this.identityMap.clear();
    for (const { descriptor, entity } of this.unitOfWork.managedEntities()) {
      this.rememberIdentity(descriptor, entity);
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
    this.unitOfWork.manageLoaded(
      descriptor,
      instance,
      readEntityValues(descriptor, instance),
    );
    this.rememberIdentity(descriptor, instance);
    return instance;
  }

  private rememberIdentity(
    descriptor: ResolvedHikouteiEntityDescriptor,
    entity: object,
  ): void {
    this.forgetIdentity(entity);
    if (!this.unitOfWork.isPrimaryKeyStable(entity)) return;
    const primaryKey = Reflect.get(entity, descriptor.primaryKey);
    if (typeof primaryKey === "string" && primaryKey.length > 0) {
      const key = identityKey(descriptor, entity);
      const existing = this.identityMap.get(key);
      if (existing !== undefined && existing !== entity) {
        throw new HikouteiError(
          HIKOUTEI_ERROR_CODES.ENTITY_IDENTITY_CONFLICT,
          `entity identity ${descriptor.name}:${primaryKey} is already managed by this EntityManager.`,
        );
      }
      this.identityMap.set(key, entity);
    }
  }

  private forgetIdentity(entity: object): void {
    for (const [key, candidate] of this.identityMap) {
      if (candidate === entity) this.identityMap.delete(key);
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

/** Logs one read-path failure with a sanitized table scope (fail-open). */
function logQueryFailure(tableName: string, error: unknown): void {
  logHikouteiInternalEvent({
    event: HIKOUTEI_LOG_EVENTS.EM_QUERY_FAILED,
    level: "warn",
    component: HIKOUTEI_LOG_COMPONENTS.ENTITY_MANAGER,
    table: tableName,
    ...describeErrorForInternalLog(error),
  });
}

/** Logs one lifecycle validation failure (create/persist) (fail-open). */
function logLifecycleFailure(tableName: string | undefined, error: unknown): void {
  logHikouteiInternalEvent({
    event: HIKOUTEI_LOG_EVENTS.EM_LIFECYCLE_INVALID,
    level: "warn",
    component: HIKOUTEI_LOG_COMPONENTS.ENTITY_MANAGER,
    ...(tableName === undefined ? {} : { table: tableName }),
    ...describeErrorForInternalLog(error),
  });
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

/**
 * Returns the empty filter only when `where` is omitted so `find(Entity)` keeps
 * its match-all behavior; an explicit `null` is passed through untouched so
 * `normalizeFilter` rejects it with `INVALID_QUERY` instead of being coerced
 * into a broad read. The value is handed to the normalizer's `unknown`
 * boundary, which owns validation.
 */
function effectiveFilter<Entity extends object>(
  where: HikouteiFilter<Entity> | undefined,
): unknown {
  return where === undefined ? {} : where;
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
