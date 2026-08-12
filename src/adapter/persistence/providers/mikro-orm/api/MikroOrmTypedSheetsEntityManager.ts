/**
 * MikroORM EntityManager bridge for the adapter-neutral typed-sheets engine.
 *
 * Stateful delegation stays in this class. Changeset normalization is kept in
 * `MikroOrmFlushChanges.ts` so the lifecycle contract can be tested separately
 * from transaction and identity-map behavior.
 */

import type { FlushEventArgs } from "@mikro-orm/core";

import type {
  TypedSheetsEntityClass,
  TypedSheetsEntityData,
  TypedSheetsEntityEngineManager,
  TypedSheetsEntityFilter,
  TypedSheetsEntityFlushListener,
  TypedSheetsEntityReference,
  TypedSheetsFindOptions,
  TypedSheetsQueryOptions,
  TypedSheetsForkOptions,
} from "../../../../../application/orm/api/contracts.js";
import type { ScalarEntityPredicate } from "../../../contracts/scalar.js";
import { collectMikroOrmFlushChanges } from "../storage/MikroOrmFlushChanges.js";
import type {
  MikroOrmSqliteAdapter,
  MikroOrmSqliteEntityManager,
} from "../storage/MikroOrmSqliteAdapter.js";

/**
 * Adapts one forked MikroORM manager to the typed-sheets engine contract.
 *
 * The subscriber is scoped to this manager instance and ignores events from
 * other forks, preventing a request-local flush plan from leaking across
 * identity maps or transactions.
 */
export class MikroOrmSqliteTypedSheetsEntityManager
  implements TypedSheetsEntityEngineManager {
  private flushListener: TypedSheetsEntityFlushListener | undefined;

  constructor(
    private readonly storage: MikroOrmSqliteAdapter,
    private readonly entityManager: MikroOrmSqliteEntityManager,
  ) {
    this.entityManager.getEventManager().registerSubscriber({
      onFlush: async (args) => this.coordinateFlush(args),
    });
  }

  /** Creates a manager with an independent MikroORM identity map. */
  fork(options?: TypedSheetsForkOptions): TypedSheetsEntityEngineManager {
    const forked = options?.clear === undefined
      ? this.entityManager.fork()
      : this.entityManager.fork({ clear: options.clear });
    return new MikroOrmSqliteTypedSheetsEntityManager(this.storage, forked);
  }

  /** Delegates entity construction while keeping MikroORM types inside the adapter. */
  create<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    data: TypedSheetsEntityData<Entity>,
  ): Entity {
    if (typeof entityName === "string") {
      const metadata = this.entityManager.getMetadata().getByUniqueName(entityName);
      return this.entityManager.create(metadata.class, this.toMikroData(data), { partial: true });
    }
    return this.entityManager.create(entityName, this.toMikroData(data), { partial: true });
  }

  /** Converts public partial data into the untyped provider data boundary. */
  private toMikroData(data: object): Record<string, unknown> {
    return Object.fromEntries(Object.entries(data));
  }

  /** Reads a filtered entity collection through the local SQLite manager. */
  async find<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    where: TypedSheetsEntityFilter<Entity>,
    options?: TypedSheetsFindOptions,
  ): Promise<readonly Entity[]> {
    if (typeof entityName === "string") {
      const metadata = this.entityManager.getMetadata().getByUniqueName(entityName);
      return this.entityManager.find(metadata.class, where, options);
    }
    return this.entityManager.find(entityName, where, options);
  }

  /** Reads one filtered entity through the local SQLite manager. */
  async findOne<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    where: TypedSheetsEntityFilter<Entity>,
    options?: TypedSheetsFindOptions,
  ): Promise<Entity | null> {
    if (typeof entityName === "string") {
      const metadata = this.entityManager.getMetadata().getByUniqueName(entityName);
      return this.entityManager.findOne(metadata.class, where, options);
    }
    return this.entityManager.findOne(entityName, where, options);
  }

  /** Executes a validated neutral query after translating it to MikroORM-private syntax. */
  async findByQuery<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    predicate: ScalarEntityPredicate,
    primaryKeyColumn: string,
    options: TypedSheetsQueryOptions,
  ): Promise<readonly Entity[]> {
    const target = this.resolveEntityTarget(entityName);
    return this.entityManager.find(
      target,
      toMikroOrmFilter(predicate, primaryKeyColumn),
      toMikroOrmQueryOptions(options),
    );
  }

  /** Counts a validated neutral query without changing this manager's identity map. */
  async countByQuery<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    predicate: ScalarEntityPredicate,
    primaryKeyColumn: string,
  ): Promise<number> {
    const target = this.resolveEntityTarget(entityName);
    const result: unknown = await Reflect.apply(
      this.entityManager.count,
      this.entityManager,
      [target, toMikroOrmFilter(predicate, primaryKeyColumn)],
    );
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
      throw new TypeError("MikroORM count result must be a non-negative safe integer");
    }
    return result;
  }

  /** Marks one or more entities for MikroORM insertion or update. */
  persist<Entity extends object>(entity: Entity | Iterable<Entity>): void {
    this.entityManager.persist(entity);
  }

  /** Marks one or more entities for MikroORM removal. */
  remove<Entity extends object>(entity: Entity | Iterable<Entity>): void {
    this.entityManager.remove(entity);
  }

  /** Flushes the current MikroORM unit of work. */
  async flush(): Promise<void> {
    await this.entityManager.flush();
  }

  /** Runs work through MikroORM's transaction boundary. */
  async transactional<Result>(
    operation: (entityManager: TypedSheetsEntityEngineManager) => Promise<Result>,
  ): Promise<Result> {
    return this.entityManager.transactional(async (transactionalEntityManager) => {
      return operation(
        new MikroOrmSqliteTypedSheetsEntityManager(this.storage, transactionalEntityManager),
      );
    });
  }

  /** Clears MikroORM's request-local identity map. */
  clear(): void {
    this.entityManager.clear();
  }

  /** Reports whether this manager already owns a SQLite transaction. */
  isInTransaction(): boolean {
    return this.entityManager.isInTransaction();
  }

  /** Opens the explicit SQLite transaction used by the public facade. */
  async begin(): Promise<void> {
    await this.entityManager.begin();
  }

  /** Commits the explicit SQLite transaction used by the public facade. */
  async commit(): Promise<void> {
    await this.entityManager.commit();
  }

  /** Rolls back the explicit SQLite transaction used by the public facade. */
  async rollback(): Promise<void> {
    await this.entityManager.rollback();
  }

  /** Stores the planner that must share this manager's flush transaction. */
  onFlush(listener: TypedSheetsEntityFlushListener): void {
    this.flushListener = listener;
  }

  private resolveEntityTarget<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
  ): TypedSheetsEntityClass<Entity> {
    if (typeof entityName !== "string") return entityName;
    return this.entityManager.getMetadata().getByUniqueName(entityName)
      .class as TypedSheetsEntityClass<Entity>;
  }

  /** Converts a MikroORM flush event into one typed-sheets planning callback. */
  private async coordinateFlush(args: FlushEventArgs): Promise<void> {
    if (args.em !== this.entityManager) return;
    const listener = this.flushListener;
    if (listener === undefined) return;
    const changes = collectMikroOrmFlushChanges(args);
    if (changes.length === 0) return;
    await listener({
      changes,
      sql: this.storage.createSqlExecutor(this.entityManager),
    });
  }
}

function toMikroOrmQueryOptions(options: TypedSheetsQueryOptions): Record<string, unknown> {
  const orderBy = options.orderBy.map((order) => ({ [order.field]: order.direction }));
  return {
    ...(orderBy.length === 0 ? {} : { orderBy }),
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.offset === undefined ? {} : { offset: options.offset }),
  };
}

function toMikroOrmFilter(
  predicate: ScalarEntityPredicate,
  primaryKeyColumn = "id",
): Record<string, unknown> {
  switch (predicate.kind) {
    case "comparison":
      return { [predicate.field]: { [`$${predicate.operator}`]: predicate.value } };
    case "set":
      return { [predicate.field]: { [`$${predicate.operator}`]: [...predicate.values] } };
    case "like":
      return { [predicate.field]: { $like: predicate.pattern } };
    case "null":
      return predicate.operator === "is_null"
        ? { [predicate.field]: null }
        : { [predicate.field]: { $ne: null } };
    case "constant":
      return predicate.value ? {} : { [primaryKeyColumn]: { $in: [] } };
    case "all":
      return {
        $and: predicate.predicates.map((child) =>
          toMikroOrmFilter(child, primaryKeyColumn)
        ),
      };
    case "any":
      return {
        $or: predicate.predicates.map((child) =>
          toMikroOrmFilter(child, primaryKeyColumn)
        ),
      };
  }
}
