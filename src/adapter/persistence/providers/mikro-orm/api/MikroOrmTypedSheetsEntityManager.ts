/**
 * MikroORM EntityManager bridge for the adapter-neutral typed-sheets engine.
 *
 * Stateful delegation stays in this class. Changeset normalization is kept in
 * `MikroOrmFlushChanges.ts` so the lifecycle contract can be tested separately
 * from transaction and identity-map behavior.
 */

import type { FlushEventArgs } from "@mikro-orm/core";

import type {
  TypedSheetsEntityData,
  TypedSheetsEntityEngineManager,
  TypedSheetsEntityFilter,
  TypedSheetsEntityFlushListener,
  TypedSheetsEntityReference,
  TypedSheetsFindOptions,
  TypedSheetsForkOptions,
} from "../../../../../application/orm/api/contracts.js";
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
    const fork = this.entityManager.fork.bind(this.entityManager) as TypedSheetsFork;
    return new MikroOrmSqliteTypedSheetsEntityManager(this.storage, fork(options));
  }

  /** Delegates entity construction while keeping MikroORM types inside the adapter. */
  create<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    data: TypedSheetsEntityData<Entity>,
  ): Entity {
    const create = this.entityManager.create.bind(this.entityManager) as TypedSheetsCreate;
    return create(entityName, data);
  }

  /** Reads a filtered entity collection through the local SQLite manager. */
  async find<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    where: TypedSheetsEntityFilter<Entity>,
    options?: TypedSheetsFindOptions,
  ): Promise<readonly Entity[]> {
    const find = this.entityManager.find.bind(this.entityManager) as TypedSheetsFind;
    return find(entityName, where, options);
  }

  /** Reads one filtered entity through the local SQLite manager. */
  async findOne<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    where: TypedSheetsEntityFilter<Entity>,
    options?: TypedSheetsFindOptions,
  ): Promise<Entity | null> {
    const findOne = this.entityManager.findOne.bind(this.entityManager) as TypedSheetsFindOne;
    return findOne(entityName, where, options);
  }

  /** Marks one or more entities for MikroORM insertion or update. */
  persist<Entity extends object>(entity: Entity | Iterable<Entity>): void {
    this.entityManager.persist(entity as never);
  }

  /** Marks one or more entities for MikroORM removal. */
  remove<Entity extends object>(entity: Entity | Iterable<Entity>): void {
    this.entityManager.remove(entity as never);
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

type TypedSheetsCreate = <Entity extends object>(
  entityName: TypedSheetsEntityReference<Entity>,
  data: TypedSheetsEntityData<Entity>,
) => Entity;

type TypedSheetsFind = <Entity extends object>(
  entityName: TypedSheetsEntityReference<Entity>,
  where: TypedSheetsEntityFilter<Entity>,
  options?: TypedSheetsFindOptions,
) => Promise<readonly Entity[]>;

type TypedSheetsFindOne = <Entity extends object>(
  entityName: TypedSheetsEntityReference<Entity>,
  where: TypedSheetsEntityFilter<Entity>,
  options?: TypedSheetsFindOptions,
) => Promise<Entity | null>;

type TypedSheetsFork = (
  options?: TypedSheetsForkOptions,
) => MikroOrmSqliteEntityManager;
