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

/** Untrusted row shape returned by a SQL driver before column promotion. */
export type SqlRow = Readonly<Record<string, unknown>>;

/** Decoder used to promote one untrusted SQL row into a storage contract. */
export type SqlRowDecoder<Row extends object> = (row: SqlRow, index?: number) => Row;

/** Promotes a raw SQL result through an explicit row decoder. */
export function decodeSqlRow<Row extends object>(
  value: unknown,
  decoder: SqlRowDecoder<Row>,
  label = "SQL row",
): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return decoder(value as SqlRow);
}

/** Promotes every raw SQL result through one explicit row decoder. */
export function decodeSqlRows<Row extends object>(
  values: readonly unknown[],
  decoder: SqlRowDecoder<Row>,
  label = "SQL rows",
): readonly Row[] {
  return values.map((value, index) => decodeSqlRow(value, decoder, `${label}[${index}]`));
}

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
  /**
   * Returns every raw object row produced by a query.
   *
   * Callers should request `SqlRow` and use `decodeSqlRows()` before passing
   * values into storage/domain contracts; the generic is retained for adapter
   * compatibility while migrations move callers to explicit promotion.
   */
  all<Row extends object>(sql: string, parameters?: readonly SqlParameter[]): Promise<readonly Row[]>;

  /** Returns the first raw object row, or undefined when no row matches. */
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
