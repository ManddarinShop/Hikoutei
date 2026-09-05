/**
 * In-memory SQLite adapter for the consistency-queue kernel tests.
 *
 * Implements the kernel's adapter-neutral SQL port over `node:sqlite` so the
 * kernel tests need no host application, MikroORM, or network. Foreign keys
 * are disabled because the kernel DDL references host registry tables that
 * the kernel tests intentionally do not create.
 */

import type { SQLInputValue } from "node:sqlite";

import type {
  SqlExecutor,
  SqlMutationResult,
  SqlParameter,
  SqlStorageAdapter,
  SqlStorageContext,
} from "../../src/sql/sql.js";

/**
 * Loads the `node:sqlite` builtin outside the bundler's module graph.
 *
 * Vite/Vite-node only recognize `node:`-prefixed builtins that also exist
 * unprefixed in `module.builtinModules`; `node:sqlite` is listed prefixed
 * only, so a static import fails to load. `process.getBuiltinModule` returns
 * the builtin directly and keeps the kernel tests credential-free.
 *
 * `process.getBuiltinModule` requires Node >= 22.3; the root package.json
 * declares that floor in its `engines` field, and the host test suite has
 * the same runtime requirement.
 */
const nodeSqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
const { DatabaseSync } = nodeSqlite;

/** Adapter-owned SQLite fixture with the kernel tables applied. */
export class NodeSqliteTestAdapter implements SqlStorageAdapter {
  private readonly db: InstanceType<typeof DatabaseSync>;
  // A single shared connection cannot nest BEGIN blocks, so concurrent
  // worker paths (maxConcurrentUnits > 1) serialize their write
  // transactions here. This mirrors the WAL-mode real deployment where
  // overlapping short transactions queue on the writer lock instead of
  // failing; long remote dispatch never sits inside a transaction.
  private transactionTail: Promise<unknown> = Promise.resolve();

  constructor() {
    this.db = new DatabaseSync(":memory:", {
      enableForeignKeyConstraints: false,
    });
  }

  /** Runs one or more DDL statements outside any transaction. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Runs a read through the shared connection. */
  read<T>(operation: (context: SqlStorageContext) => Promise<T>): Promise<T> {
    return operation({ sql: new NodeSqliteExecutor(this.db) });
  }

  /** Runs one atomic write transaction; rolls all callback work back on failure. */
  async transaction<T>(operation: (context: SqlStorageContext) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.db.exec("BEGIN");
      try {
        const value = await operation({ sql: new NodeSqliteExecutor(this.db) });
        this.db.exec("COMMIT");
        return value;
      } catch (error: unknown) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    };
    const result = this.transactionTail.then(run, run);
    this.transactionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Closes the underlying connection. */
  close(): void {
    this.db.close();
  }
}

/** Binds the synchronous `node:sqlite` statement API to the async SQL port. */
class NodeSqliteExecutor implements SqlExecutor {
  constructor(private readonly db: InstanceType<typeof DatabaseSync>) {}

  async all<Row extends object>(
    sql: string,
    parameters: readonly SqlParameter[] = [],
  ): Promise<readonly Row[]> {
    const rows = this.db
      .prepare(sql)
      .all(...(parameters as readonly SQLInputValue[]));
    return rows as unknown as readonly Row[];
  }

  async get<Row extends object>(
    sql: string,
    parameters: readonly SqlParameter[] = [],
  ): Promise<Row | undefined> {
    return this.db
      .prepare(sql)
      .get(...(parameters as readonly SQLInputValue[])) as Row | undefined;
  }

  async run(
    sql: string,
    parameters: readonly SqlParameter[] = [],
  ): Promise<SqlMutationResult> {
    const result = this.db
      .prepare(sql)
      .run(...(parameters as readonly SQLInputValue[]));
    return {
      changes: Number(result.changes),
      lastInsertId: Number(result.lastInsertRowid),
    };
  }
}
