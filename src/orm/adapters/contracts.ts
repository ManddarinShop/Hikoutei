/**
 * Adapter-neutral asynchronous SQL primitives used by the sync storage layer.
 *
 * The core and storage packages depend on these contracts instead of a
 * particular ORM. An adapter may implement them with MikroORM today and a
 * different persistence library later without changing sync semantics.
 */

/** Values accepted as bound parameters by the SQLite-backed adapters. */
export type SqlParameter = string | number | bigint | boolean | Uint8Array | null;

/** A generated identifier returned by a database mutation when one exists. */
export type SqlGeneratedId = string | number | bigint;

/** Observable outcome of one SQL data-definition or data-mutation statement. */
export interface SqlMutationResult {
  /** Number of rows changed by the statement. */
  readonly changes: number;
  /** Present only when the database reports a generated primary-key value. */
  readonly lastInsertId?: SqlGeneratedId;
}

/**
 * Executes SQL through the active persistence context.
 *
 * Callers must pass parameters separately from SQL text. The implementation
 * keeps this executor bound to the current transaction when one exists.
 */
export interface SqlExecutor {
  /** Returns every row produced by a query. */
  all<Row extends object>(sql: string, parameters?: readonly SqlParameter[]): Promise<readonly Row[]>;

  /** Returns the first query row, or undefined when no row matches. */
  get<Row extends object>(sql: string, parameters?: readonly SqlParameter[]): Promise<Row | undefined>;

  /** Runs a statement that changes schema or persisted state. */
  run(sql: string, parameters?: readonly SqlParameter[]): Promise<SqlMutationResult>;
}

/** The adapter-neutral context available to one storage operation. */
export interface SqlStorageContext {
  readonly sql: SqlExecutor;
}

/**
 * Owns SQL execution contexts for one SQLite-backed typed-sheets runtime.
 *
 * `transaction()` is the only outer write boundary. Every user-entity write,
 * canonical-state mutation, and outbox append that belongs together must use
 * the `sql` executor supplied to the callback.
 */
export interface SqlStorageAdapter {
  /** Runs a read using a fresh persistence context with no reused identity map. */
  read<T>(operation: (context: SqlStorageContext) => Promise<T>): Promise<T>;

  /** Runs one atomic write transaction and rolls all callback work back on failure. */
  transaction<T>(operation: (context: SqlStorageContext) => Promise<T>): Promise<T>;
}
