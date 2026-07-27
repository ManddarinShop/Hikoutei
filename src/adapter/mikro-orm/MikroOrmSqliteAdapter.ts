import type {
  AnyEntity,
  EntityClass,
  EntitySchema,
  QueryResult,
} from "@mikro-orm/core";
import {
  MikroORM,
  NodeSqliteDialect,
  SqliteDriver,
} from "@mikro-orm/sql";
import type { Options, SqlEntityManager } from "@mikro-orm/sql";

import type {
  SqlExecutor,
  SqlGeneratedId,
  SqlMutationResult,
  SqlParameter,
  SqlStorageAdapter,
  SqlStorageContext,
} from "../orm/contracts.js";

/** MikroORM entity-manager type used by the Node SQLite dialect. */
export type MikroOrmSqliteEntityManager = SqlEntityManager<SqliteDriver>;

/** MikroORM root instance configured with the generic Node SQLite driver. */
export type MikroOrmSqlite = MikroORM<SqliteDriver, MikroOrmSqliteEntityManager>;

/** Entity metadata accepted by the SQLite-backed MikroORM integration. */
export type MikroOrmSqliteEntity = string | EntityClass<AnyEntity> | EntitySchema;

/** Optional MikroORM settings owned by the host application. */
export type MikroOrmSqliteConfiguration = Omit<
  Partial<Options<SqliteDriver>>,
  "dbName" | "driver" | "driverOptions" | "entities"
>;

/** Inputs for creating the SQLite ORM instance that typed-sheets will use. */
export interface InitializeMikroOrmSqliteAdapterOptions {
  /** SQLite database path, URI, or `:memory:` database name. */
  readonly dbName: string;
  /** Application entities managed by the dedicated Sheets-side MikroORM instance. */
  readonly entities: readonly MikroOrmSqliteEntity[];
  /** Optional MikroORM settings that do not select a different database or driver. */
  readonly configuration?: MikroOrmSqliteConfiguration;
}

/**
 * Adapter-specific transaction context for code that intentionally needs
 * MikroORM entity lifecycle operations alongside typed-sheets storage SQL.
 *
 * Core storage must use `sql`; `entityManager` is an explicit escape hatch for
 * integration code and never appears in the adapter-neutral contract.
 */
export interface MikroOrmSqliteTransaction extends SqlStorageContext {
  readonly entityManager: MikroOrmSqliteEntityManager;
}

/**
 * Connects typed-sheets storage SQL to one MikroORM-managed SQLite database.
 *
 * The adapter never opens a second `node:sqlite` connection. Raw storage SQL
 * and MikroORM entity changes therefore share the same transaction context.
 */
export class MikroOrmSqliteAdapter implements SqlStorageAdapter {
  constructor(private readonly orm: MikroOrmSqlite) {}

  /** Creates an isolated MikroORM manager for one typed-sheets EntityManager facade. */
  forkEntityManager(): MikroOrmSqliteEntityManager {
    return this.orm.em.fork();
  }

  /**
   * Creates a SQL executor bound to the supplied manager's current transaction.
   *
   * This is adapter-specific plumbing for the typed-sheets ORM facade; callers
   * should use the facade rather than mixing raw entity and sync writes.
   */
  createSqlExecutor(entityManager: MikroOrmSqliteEntityManager): SqlExecutor {
    return new MikroOrmSqlExecutor(entityManager);
  }

  /** Runs a read through a fresh EntityManager to avoid stale identity-map state. */
  async read<T>(operation: (context: SqlStorageContext) => Promise<T>): Promise<T> {
    const entityManager = this.forkEntityManager();
    return operation(createStorageContext(entityManager));
  }

  /** Runs adapter-neutral storage work in one MikroORM transaction. */
  async transaction<T>(operation: (context: SqlStorageContext) => Promise<T>): Promise<T> {
    return this.transactional(async (context) => operation(context));
  }

  /**
   * Runs integration work that needs both the active MikroORM EntityManager and
   * the transaction-bound storage SQL executor.
   */
  async transactional<T>(
    operation: (context: MikroOrmSqliteTransaction) => Promise<T>,
  ): Promise<T> {
    return this.orm.em.transactional(async (entityManager) => {
      return operation(createMikroOrmTransaction(entityManager));
    });
  }

  /** Closes the SQLite connection owned by this adapter. */
  async close(force = false): Promise<void> {
    await this.orm.close(force);
  }

  /**
   * Creates missing entity tables and applies only non-destructive entity-schema updates.
   *
   * This is intentionally explicit instead of running during adapter creation:
   * a production process must opt into changing its SQLite schema at startup.
   */
  async migrateEntitySchema(): Promise<void> {
    await this.orm.schema.update({
      safe: true,
      dropTables: false,
    });
  }
}

/** Creates a typed-sheets storage adapter around an application-owned MikroORM instance. */
export function createMikroOrmSqliteAdapter(orm: MikroOrmSqlite): MikroOrmSqliteAdapter {
  return new MikroOrmSqliteAdapter(orm);
}

/**
 * Opens the dedicated SQLite MikroORM instance used for Sheets-backed entities.
 *
 * This intentionally creates a separate ORM from any application-owned MySQL
 * instance, so Sheet entities cannot accidentally write to the primary database.
 */
export async function initializeMikroOrmSqliteAdapter(
  options: InitializeMikroOrmSqliteAdapterOptions,
): Promise<MikroOrmSqliteAdapter> {
  const orm = await MikroORM.init({
    ...options.configuration,
    driver: SqliteDriver,
    dbName: options.dbName,
    driverOptions: new NodeSqliteDialect(options.dbName),
    entities: [...options.entities],
  });
  return new MikroOrmSqliteAdapter(orm);
}

function createStorageContext(entityManager: MikroOrmSqliteEntityManager): SqlStorageContext {
  return { sql: new MikroOrmSqlExecutor(entityManager) };
}

function createMikroOrmTransaction(
  entityManager: MikroOrmSqliteEntityManager,
): MikroOrmSqliteTransaction {
  return {
    entityManager,
    sql: new MikroOrmSqlExecutor(entityManager),
  };
}

/** Maps the transaction-aware MikroORM raw-query API to the neutral SQL contract. */
class MikroOrmSqlExecutor implements SqlExecutor {
  constructor(private readonly entityManager: MikroOrmSqliteEntityManager) {}

  async all<Row extends object>(
    sql: string,
    parameters: readonly SqlParameter[] = [],
  ): Promise<readonly Row[]> {
    const rows = await this.entityManager.execute(sql, [...parameters], "all");
    return rows as unknown as readonly Row[];
  }

  async get<Row extends object>(
    sql: string,
    parameters: readonly SqlParameter[] = [],
  ): Promise<Row | undefined> {
    const row = await this.entityManager.execute(sql, [...parameters], "get");
    return row as unknown as Row | undefined;
  }

  async run(
    sql: string,
    parameters: readonly SqlParameter[] = [],
  ): Promise<SqlMutationResult> {
    const result = await this.entityManager.execute<QueryResult>(sql, [...parameters], "run");
    return toSqlMutationResult(result);
  }
}

function toSqlMutationResult(result: QueryResult): SqlMutationResult {
  if (isSqlGeneratedId(result.insertId)) {
    return {
      changes: result.affectedRows,
      lastInsertId: result.insertId,
    };
  }

  return { changes: result.affectedRows };
}

function isSqlGeneratedId(value: unknown): value is SqlGeneratedId {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint";
}
