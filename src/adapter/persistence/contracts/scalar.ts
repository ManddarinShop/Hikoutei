/**
 * Provider-neutral persistence contract for the engine-neutral entity runtime.
 *
 * This is the internal boundary the public `EntityManager` depends on. It
 * describes scalar entity tables and atomic row operations without referencing
 * any ORM, raw SQL executor, or provider implementation type. A future Prisma
 * adapter only needs to implement this contract; the application lifecycle and
 * the public API stay unchanged.
 *
 * The contract intentionally exposes no raw SQL surface. Sheet route setup is
 * separate from row reads, while a provider's transaction flush must still
 * include any canonical-state and durable-outbox work associated with a row
 * change. Those sync details remain provider-internal.
 */

/** Scalar value bound for one entity column. */
export type ScalarEntityValue = string | number | boolean | Date | null;

/** Storage affinity for one scalar entity column. */
export type ScalarEntityStorageType = "TEXT" | "REAL" | "INTEGER";

/** Definition of one scalar column derived from a validated entity descriptor. */
export interface ScalarEntityColumnDefinition {
  readonly name: string;
  readonly storageType: ScalarEntityStorageType;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
}

/** Definition of one scalar entity table derived from a validated descriptor. */
export interface ScalarEntityTableDefinition {
  readonly tableName: string;
  readonly primaryKeyColumn: string;
  readonly columns: readonly ScalarEntityColumnDefinition[];
}

/** A row to insert into one scalar entity table. */
export interface ScalarEntityInsert {
  readonly tableName: string;
  readonly primaryKeyColumn: string;
  /** Column-to-value map for every declared property of the entity. */
  readonly values: Readonly<Record<string, ScalarEntityValue>>;
}

/** A changed row to update inside one scalar entity table. */
export interface ScalarEntityUpdate {
  readonly tableName: string;
  readonly primaryKeyColumn: string;
  readonly primaryKeyValue: ScalarEntityValue;
  /** Only the columns whose values changed since the loaded snapshot. */
  readonly changedValues: Readonly<Record<string, ScalarEntityValue>>;
}

/** A row to delete from one scalar entity table by primary key. */
export interface ScalarEntityDelete {
  readonly tableName: string;
  readonly primaryKeyColumn: string;
  readonly primaryKeyValue: ScalarEntityValue;
}

/** Equality filter and paging for a scalar entity read. */
export interface ScalarEntityQuery {
  readonly tableName: string;
  readonly primaryKeyColumn: string;
  /** Equality filter on one or more declared columns. */
  readonly where: Readonly<Record<string, ScalarEntityValue>>;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Write surface available inside one atomic transaction.
 *
 * Inserts, updates, and deletes run against the active transaction so a single
 * `flush()` either commits every entity row or rolls them all back.
 */
export interface ScalarEntityTransaction {
  insert(row: ScalarEntityInsert): Promise<void>;
  update(row: ScalarEntityUpdate): Promise<void>;
  delete(row: ScalarEntityDelete): Promise<void>;
  /** Reads rows through the active transaction's view of the table. */
  read(query: ScalarEntityQuery): Promise<readonly ScalarEntityRow[]>;
  /**
   * Flushes provider-scheduled entity, canonical-state, and outbox work before
   * the common UoW advances snapshots. The enclosing transaction must still be
   * able to roll all of it back if the caller later rejects.
   */
  flush(): Promise<void>;
}

/** One scalar entity row returned by a read. */
export type ScalarEntityRow = Readonly<Record<string, ScalarEntityValue>>;

/**
 * Replaceable local persistence engine behind the public EntityManager.
 *
 * `beginTransaction` is the only outer write boundary. A provider must keep
 * every insert/update/delete and its associated canonical/outbox writes in the
 * callback within one SQLite transaction and roll the whole callback back when
 * it rejects.
 */
export interface ScalarEntityPersistenceProvider {
  /** Runs one atomic transaction and rolls back every write on rejection. */
  beginTransaction<Result>(
    work: (transaction: ScalarEntityTransaction) => Promise<Result>,
  ): Promise<Result>;
  /** Reads rows outside any transaction using a fresh persistence context. */
  read(query: ScalarEntityQuery): Promise<readonly ScalarEntityRow[]>;
  /** Releases resources owned by the underlying SQLite connection. */
  close(): Promise<void>;
}
