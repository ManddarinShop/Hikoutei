/**
 * Public entity-manager facade owned by typed-sheets.
 *
 * The facade keeps the application workflow stable while a replaceable
 * execution engine handles SQLite-specific persistence details underneath.
 */

import type {
  TypedSheetsEntityData,
  TypedSheetsEntityEngine,
  TypedSheetsEntityEngineManager,
  TypedSheetsEntityFilter,
  TypedSheetsEntityReference,
  TypedSheetsFindOptions,
  TypedSheetsForkOptions,
  TypedSheetsFlushCoordinator,
} from "./contracts.js";

/** Options for creating our public typed-sheets ORM around one execution engine. */
export interface CreateTypedSheetsOrmOptions {
  /** Plans canonical and Sheets outbox work for every durable entity flush. */
  readonly flushCoordinator: TypedSheetsFlushCoordinator;
}

/**
 * Root object for typed-sheets entity lifecycle operations.
 *
 * Its `em` property exposes our manager rather than an engine-specific one,
 * so application code cannot bypass the canonical and outbox flush plan.
 */
export class TypedSheetsOrm {
  /** Root entity manager; call `fork()` before request or job-local work. */
  readonly em: TypedSheetsEntityManager;

  constructor(
    private readonly engine: TypedSheetsEntityEngine,
    private readonly flushCoordinator: TypedSheetsFlushCoordinator,
  ) {
    this.em = this.createEntityManager(engine.fork());
  }

  /** Closes resources owned by the underlying SQLite execution engine. */
  async close(force = false): Promise<void> {
    await this.engine.close(force);
  }

  private createEntityManager(
    entityManager: TypedSheetsEntityEngineManager,
  ): TypedSheetsEntityManager {
    return new TypedSheetsEntityManager(entityManager, this.flushCoordinator);
  }
}

/** Creates our public entity facade around a replaceable SQLite execution engine. */
export function createTypedSheetsOrm(
  engine: TypedSheetsEntityEngine,
  options: CreateTypedSheetsOrmOptions,
): TypedSheetsOrm {
  return new TypedSheetsOrm(engine, options.flushCoordinator);
}

/**
 * Entity-manager facade with the familiar entity lifecycle method names.
 *
 * The current public subset intentionally focuses on lifecycle-safe reads and
 * `persist` / `remove` / `flush` operations while mapping metadata is built.
 */
export class TypedSheetsEntityManager {
  constructor(
    private readonly entityManager: TypedSheetsEntityEngineManager,
    private readonly flushCoordinator: TypedSheetsFlushCoordinator,
  ) {
    this.entityManager.onFlush(async (context) => this.flushCoordinator.onFlush(context));
  }

  /** Creates an isolated manager with its own identity map. */
  fork(options?: TypedSheetsForkOptions): TypedSheetsEntityManager {
    return new TypedSheetsEntityManager(
      this.entityManager.fork(options),
      this.flushCoordinator,
    );
  }

  /** Creates a managed entity instance without writing it until `flush()`. */
  create<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    data: TypedSheetsEntityData<Entity>,
  ): Entity {
    return this.entityManager.create(entityName, data);
  }

  /** Reads all entities matching one initial equality filter from SQLite. */
  async find<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    where: TypedSheetsEntityFilter<Entity>,
    options?: TypedSheetsFindOptions,
  ): Promise<readonly Entity[]> {
    return this.entityManager.find(entityName, where, options);
  }

  /** Reads one entity or returns null when no entity matches the filter. */
  async findOne<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    where: TypedSheetsEntityFilter<Entity>,
    options?: TypedSheetsFindOptions,
  ): Promise<Entity | null> {
    return this.entityManager.findOne(entityName, where, options);
  }

  /** Marks one entity or iterable of entities for insertion or update at the next flush. */
  persist<Entity extends object>(entity: Entity | Iterable<Entity>): this {
    this.entityManager.persist(entity);
    return this;
  }

  /** Marks one entity or iterable of entities for removal at the next flush. */
  remove<Entity extends object>(entity: Entity | Iterable<Entity>): this {
    this.entityManager.remove(entity);
    return this;
  }

  /**
   * Persists all pending entity changes with their typed-sheets sync plan.
   *
   * An existing transaction is reused. Otherwise this method opens a SQLite
   * transaction itself so entity rows and outbox work commit or roll back
   * together.
   */
  async flush(): Promise<void> {
    if (this.entityManager.isInTransaction()) {
      await this.entityManager.flush();
      return;
    }

    await this.entityManager.begin();
    try {
      await this.entityManager.flush();
      await this.entityManager.commit();
    } catch (error: unknown) {
      if (this.entityManager.isInTransaction()) {
        await this.entityManager.rollback();
      }
      throw error;
    }
  }

  /**
   * Runs entity work in one transaction and flushes it automatically on success.
   *
   * The callback receives another typed-sheets manager, so its flush still
   * coordinates canonical and Sheets outbox work.
   */
  async transactional<Result>(
    operation: (entityManager: TypedSheetsEntityManager) => Promise<Result>,
  ): Promise<Result> {
    return this.entityManager.transactional(async (transactionalEntityManager) => {
      const manager = new TypedSheetsEntityManager(
        transactionalEntityManager,
        this.flushCoordinator,
      );
      return operation(manager);
    });
  }

  /** Detaches every managed entity from this request or job-local manager. */
  clear(): void {
    this.entityManager.clear();
  }
}
