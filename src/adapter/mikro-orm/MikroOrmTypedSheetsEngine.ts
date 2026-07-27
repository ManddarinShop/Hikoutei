/**
 * MikroORM implementation of the replaceable typed-sheets entity engine.
 *
 * MikroORM remains entirely behind this adapter: the application uses our
 * `TypedSheetsOrm` and `TypedSheetsEntityManager` contracts instead.
 */

import { ChangeSetType } from "@mikro-orm/core";
import type { ChangeSet, FlushEventArgs } from "@mikro-orm/core";

import {
  createTypedSheetsOrm as createTypedSheetsOrmFacade,
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
  primaryKeyPresence,
  type CreateTypedSheetsOrmOptions,
  type TypedSheetsEntityChange,
  type TypedSheetsEntityChangeKind,
  type TypedSheetsEntityData,
  type TypedSheetsEntityEngine,
  type TypedSheetsEntityEngineManager,
  type TypedSheetsEntityFilter,
  type TypedSheetsEntityFlushListener,
  type TypedSheetsEntityReference,
  type TypedSheetsFindOptions,
  type TypedSheetsForkOptions,
  type TypedSheetsOrm,
} from "../../orm/index.js";
import {
  initializeMikroOrmSqliteAdapter,
  type InitializeMikroOrmSqliteAdapterOptions,
  type MikroOrmSqliteEntityManager,
  MikroOrmSqliteAdapter,
} from "./MikroOrmSqliteAdapter.js";
import { migrateMikroOrmSqliteStorageSchema } from "./MikroOrmSqliteSchema.js";

/** Options for initializing a dedicated typed-sheets SQLite ORM instance. */
export interface InitializeTypedSheetsOrmOptions extends InitializeMikroOrmSqliteAdapterOptions {
  /** Plans canonical and Sheets outbox work for every durable entity flush. */
  readonly flushCoordinator: CreateTypedSheetsOrmOptions["flushCoordinator"];
}

/**
 * Wraps the MikroORM SQLite adapter as our replaceable entity execution engine.
 *
 * A future Drizzle or another ORM implementation only needs to implement the
 * same typed-sheets engine contract; application lifecycle calls stay stable.
 */
export class MikroOrmSqliteTypedSheetsEngine implements TypedSheetsEntityEngine {
  constructor(private readonly storage: MikroOrmSqliteAdapter) {}

  /** Opens a MikroORM-backed manager behind the typed-sheets engine boundary. */
  fork(): TypedSheetsEntityEngineManager {
    return new MikroOrmSqliteTypedSheetsEntityManager(
      this.storage,
      this.storage.forkEntityManager(),
    );
  }

  /** Closes the dedicated MikroORM SQLite connection. */
  async close(force = false): Promise<void> {
    await this.storage.close(force);
  }
}

/** Creates the replaceable typed-sheets engine backed by one MikroORM SQLite adapter. */
export function createMikroOrmSqliteTypedSheetsEngine(
  storage: MikroOrmSqliteAdapter,
): MikroOrmSqliteTypedSheetsEngine {
  return new MikroOrmSqliteTypedSheetsEngine(storage);
}

/** Creates our public entity facade around an existing MikroORM SQLite adapter. */
export function createTypedSheetsOrm(
  storage: MikroOrmSqliteAdapter,
  options: CreateTypedSheetsOrmOptions,
): TypedSheetsOrm {
  return createTypedSheetsOrmFacade(createMikroOrmSqliteTypedSheetsEngine(storage), options);
}

/**
 * Opens and migrates a dedicated SQLite runtime, then returns our public ORM facade.
 *
 * The explicit initializer is the entrypoint for applications that do not
 * already own the underlying MikroORM adapter.
 */
export async function initializeTypedSheetsOrm(
  options: InitializeTypedSheetsOrmOptions,
): Promise<TypedSheetsOrm> {
  const { flushCoordinator, ...adapterOptions } = options;
  const storage = await initializeMikroOrmSqliteAdapter(adapterOptions);
  try {
    await migrateMikroOrmSqliteStorageSchema(storage);
    return createTypedSheetsOrm(storage, { flushCoordinator });
  } catch (error: unknown) {
    await storage.close(true);
    throw error;
  }
}

/** MikroORM-specific manager implementation hidden behind our engine interface. */
class MikroOrmSqliteTypedSheetsEntityManager implements TypedSheetsEntityEngineManager {
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

  /** Delegates entity construction to MikroORM without exposing its types. */
  create<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    data: TypedSheetsEntityData<Entity>,
  ): Entity {
    const create = this.entityManager.create.bind(this.entityManager) as TypedSheetsCreate;
    return create(entityName, data);
  }

  /** Executes an equality-filtered entity read through the local SQLite manager. */
  async find<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    where: TypedSheetsEntityFilter<Entity>,
    options?: TypedSheetsFindOptions,
  ): Promise<readonly Entity[]> {
    const find = this.entityManager.find.bind(this.entityManager) as TypedSheetsFind;
    return find(entityName, where, options);
  }

  /** Executes one equality-filtered entity read through the local SQLite manager. */
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

  /** Flushes the current MikroORM Unit of Work(작업 단위). */
  async flush(): Promise<void> {
    await this.entityManager.flush();
  }

  /** Runs work through MikroORM's transaction boundary with another hidden engine manager. */
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

  /** Reports whether the current manager already owns a SQLite transaction. */
  isInTransaction(): boolean {
    return this.entityManager.isInTransaction();
  }

  /** Opens the explicit SQLite transaction used by the public flush facade. */
  async begin(): Promise<void> {
    await this.entityManager.begin();
  }

  /** Commits the explicit SQLite transaction used by the public flush facade. */
  async commit(): Promise<void> {
    await this.entityManager.commit();
  }

  /** Rolls back the explicit SQLite transaction used by the public flush facade. */
  async rollback(): Promise<void> {
    await this.entityManager.rollback();
  }

  /** Stores the typed-sheets planner that must share this manager's flush transaction. */
  onFlush(listener: TypedSheetsEntityFlushListener): void {
    this.flushListener = listener;
  }

  /** Converts MikroORM changes into our lifecycle contract before SQL entity writes occur. */
  private async coordinateFlush(args: FlushEventArgs): Promise<void> {
    if (args.em !== this.entityManager) return;
    const listener = this.flushListener;
    if (listener === undefined) return;
    const changes = collectFlushChanges(args);
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

/** Normalizes MikroORM's internal early changes into our public lifecycle set. */
function collectFlushChanges(args: FlushEventArgs): readonly TypedSheetsEntityChange[] {
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
    changesByEntity.set(next.entity, mergeEntityChanges(current, next));
  }
  return [...changesByEntity.values()];
}

/** Converts one MikroORM changeset into a typed-sheets lifecycle change. */
function toTypedSheetsEntityChange(changeSet: ChangeSet<object>): TypedSheetsEntityChange {
  return {
    kind: toTypedSheetsChangeKind(changeSet.type),
    entityName: changeSet.meta.className,
    entity: changeSet.entity,
    primaryKey: primaryKeyPresence(changeSet.getSerializedPrimaryKey()),
    payload: { ...changeSet.payload } as Readonly<Record<string, unknown>>,
  };
}

/** Coalesces one entity's early and regular changes into one public change. */
function mergeEntityChanges(
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

/** Maps every MikroORM changeset type to our create, update, or delete contract. */
function toTypedSheetsChangeKind(changeSetType: ChangeSetType): TypedSheetsEntityChangeKind {
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
