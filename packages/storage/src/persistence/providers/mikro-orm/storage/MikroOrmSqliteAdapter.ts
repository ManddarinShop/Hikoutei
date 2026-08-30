import type {
  AnyEntity,
  EntityClass,
  EntitySchema,
  QueryResult,
} from "@mikro-orm/core";
import { FlushMode } from "@mikro-orm/core";
import {
  MikroORM,
  NodeSqliteDialect,
  SqliteDriver,
} from "@mikro-orm/sql";
import type { Options, SqlEntityManager } from "@mikro-orm/sql";

import { isRecord } from "@hikoutei/contracts/encoding/typeGuards.js";
import type {
  SqlExecutor,
  SqlGeneratedId,
  SqlRow,
  SqlMutationResult,
  SqlParameter,
  SqlStorageAdapter,
  SqlStorageContext,
} from "@hikoutei/contracts/storage/sql.js";

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
  /** SQLite file path, exact `:memory:`, or a `:memory:`-prefixed value (normalized to in-memory). */
  readonly dbName: string;
  /** Application entities managed by the dedicated Sheets-side MikroORM instance. */
  readonly entities: readonly MikroOrmSqliteEntity[];
  /** Optional MikroORM settings that do not select a different database or driver. */
  readonly configuration?: MikroOrmSqliteConfiguration;
}

/** Explicit native mutation capability used only by the inbound observation bridge. */
export interface MikroOrmNativeEntityWriter {
  findOne(entityName: unknown, where: Record<string, unknown>): Promise<object | null>;
  insert(entityName: unknown, data: Record<string, unknown>): Promise<unknown>;
  nativeUpdate(
    entityName: unknown,
    where: Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<number>;
  nativeDelete(entityName: unknown, where: Record<string, unknown>): Promise<number>;
}

/**
 * Adapter-specific transaction context for code that intentionally needs
 * MikroORM entity lifecycle operations alongside typed-sheets storage SQL.
 *
 * Core storage must use `sql`; `entityManager` and `nativeWriter` are explicit
 * escape hatches for integration code and never appear in the adapter-neutral contract.
 */
export interface MikroOrmSqliteTransaction extends SqlStorageContext {
  readonly entityManager: MikroOrmSqliteEntityManager;
  /** Explicit native mutation capability used by inbound observation writes. */
  readonly nativeWriter: MikroOrmNativeEntityWriter;
}

/**
 * Connects typed-sheets storage SQL to one MikroORM-managed SQLite database.
 *
 * The adapter never opens a second `node:sqlite` connection. Raw storage SQL
 * and MikroORM entity changes therefore share the same transaction context.
 */
export class MikroOrmSqliteAdapter implements SqlStorageAdapter {
  constructor(private readonly orm: MikroOrmSqlite) {}

  /** Creates a clean manager for one provider read or lifecycle transaction. */
  forkEntityManager(): MikroOrmSqliteEntityManager {
    return this.orm.em.fork({ clear: true, flushMode: FlushMode.COMMIT });
  }

  /** Creates a SQL executor bound to the supplied manager's active transaction. */
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
    return this.orm.em.transactional(
      async (entityManager) => operation(createMikroOrmTransaction(entityManager)),
      { clear: true, flushMode: FlushMode.COMMIT },
    );
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
  // `node:sqlite` treats ONLY the exact string ":memory:" as an in-memory
  // database. A suffixed name like ":memory:<uuid>" is opened as a real
  // file in the current working directory, so normalize any ":memory:*"
  // spelling (but not "file::memory:" URIs) down to the exact marker.
  const dbName = options.dbName.startsWith(":memory:") && !options.dbName.startsWith("file::memory:")
    ? ":memory:"
    : options.dbName;
  const orm = await MikroORM.init({
    ...options.configuration,
    driver: SqliteDriver,
    dbName,
    driverOptions: new NodeSqliteDialect(dbName),
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
    nativeWriter: createMikroOrmNativeEntityWriter(entityManager),
    sql: new MikroOrmSqlExecutor(entityManager),
  };
}

/** Adapts native MikroORM writes without pretending the public manager has them. */
function createMikroOrmNativeEntityWriter(
  entityManager: MikroOrmSqliteEntityManager,
): MikroOrmNativeEntityWriter {
  return {
    async findOne(entityName, where) {
      const result: unknown = await Reflect.apply(
        entityManager.findOne,
        entityManager,
        [entityName, where],
      );
      if (result === null) return null;
      if (typeof result !== "object") {
        throw new TypeError("MikroORM findOne result must be an entity object or null");
      }
      return result;
    },
    insert(entityName, data) {
      return Reflect.apply(entityManager.insert, entityManager, [entityName, data]);
    },
    async nativeUpdate(entityName, where, data) {
      const result: unknown = await Reflect.apply(
        entityManager.nativeUpdate,
        entityManager,
        [entityName, where, data],
      );
      if (typeof result !== "number" || !Number.isSafeInteger(result)) {
        throw new TypeError("MikroORM nativeUpdate result must be a safe integer");
      }
      return result;
    },
    async nativeDelete(entityName, where) {
      const result: unknown = await Reflect.apply(
        entityManager.nativeDelete,
        entityManager,
        [entityName, where],
      );
      if (typeof result !== "number" || !Number.isSafeInteger(result)) {
        throw new TypeError("MikroORM nativeDelete result must be a safe integer");
      }
      return result;
    },
  };
}

/** Maps the transaction-aware MikroORM raw-query API to the neutral SQL contract. */
class MikroOrmSqlExecutor implements SqlExecutor {
  constructor(private readonly entityManager: MikroOrmSqliteEntityManager) {}

  async all<Row extends object>(
    sql: string,
    parameters: readonly SqlParameter[] = [],
  ): Promise<readonly Row[]> {
    const rows = await this.entityManager.execute<readonly SqlRow[]>(sql, [...parameters], "all");
    if (!Array.isArray(rows) || !rows.every(isRecord)) {
      throw new TypeError("SQL all result must be an array of object rows");
    }
    return rows as readonly Row[];
  }

  async get<Row extends object>(
    sql: string,
    parameters: readonly SqlParameter[] = [],
  ): Promise<Row | undefined> {
    const row = await this.entityManager.execute(sql, [...parameters], "get");
    if (row !== undefined && !isRecord(row)) {
      throw new TypeError("SQL get result must be an object row");
    }
    return row as Row | undefined;
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
