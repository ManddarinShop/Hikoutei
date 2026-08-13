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

import type { SqlExecutor } from "./sql.js";

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
  readonly entityName: string;
  readonly tableName: string;
  readonly primaryKeyColumn: string;
  /** Column-to-value map for every declared property of the entity. */
  readonly values: Readonly<Record<string, ScalarEntityValue>>;
}

/** A changed row to update inside one scalar entity table. */
export interface ScalarEntityUpdate {
  readonly entityName: string;
  readonly tableName: string;
  readonly primaryKeyColumn: string;
  readonly primaryKeyValue: ScalarEntityValue;
  /** Complete post-update row used by canonical and projection planning. */
  readonly values: Readonly<Record<string, ScalarEntityValue>>;
  /** Only the columns whose values changed since the loaded snapshot. */
  readonly changedValues: Readonly<Record<string, ScalarEntityValue>>;
}

/** A row to delete from one scalar entity table by primary key. */
export interface ScalarEntityDelete {
  readonly entityName: string;
  readonly tableName: string;
  readonly primaryKeyColumn: string;
  readonly primaryKeyValue: ScalarEntityValue;
  /** Complete persisted row snapshot used for delete canonical evidence. */
  readonly values: Readonly<Record<string, ScalarEntityValue>>;
}

/** Runtime operation tags used by the provider-neutral flush plan. */
export const SCALAR_ENTITY_CHANGE_KINDS = {
  INSERT: "insert",
  UPDATE: "update",
  DELETE: "delete",
} as const;

/** One lifecycle row operation promoted from Hikoutei's Unit of Work. */
export type ScalarEntityFlushChange =
  | { readonly kind: typeof SCALAR_ENTITY_CHANGE_KINDS.INSERT; readonly row: ScalarEntityInsert }
  | { readonly kind: typeof SCALAR_ENTITY_CHANGE_KINDS.UPDATE; readonly row: ScalarEntityUpdate }
  | { readonly kind: typeof SCALAR_ENTITY_CHANGE_KINDS.DELETE; readonly row: ScalarEntityDelete };

/** SQL context used by a provider to plan canonical and outbox work. */
export interface ScalarEntityFlushContext {
  readonly changes: readonly ScalarEntityFlushChange[];
  readonly sql: SqlExecutor;
}

/** Callback for sync-aware providers to plan work before entity SQL is flushed. */
export interface ScalarEntityFlushCoordinator {
  onFlush(context: ScalarEntityFlushContext): Promise<void>;
}

/** Non-null scalar comparison represented independently from any ORM syntax. */
export interface ScalarEntityComparisonPredicate {
  readonly kind: "comparison";
  readonly field: string;
  readonly operator: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
  readonly value: Exclude<ScalarEntityValue, null>;
}

/** Non-empty set membership predicate after public-array validation. */
export interface ScalarEntitySetPredicate {
  readonly kind: "set";
  readonly field: string;
  readonly operator: "in" | "nin";
  readonly values: readonly Exclude<ScalarEntityValue, null>[];
}

/** SQLite LIKE predicate over one validated string field and pattern. */
export interface ScalarEntityLikePredicate {
  readonly kind: "like";
  readonly field: string;
  readonly pattern: string;
}

/** Explicit nullable-field predicate that avoids SQL three-valued ambiguity. */
export interface ScalarEntityNullPredicate {
  readonly kind: "null";
  readonly field: string;
  readonly operator: "is_null" | "is_not_null";
}

/** Query constant produced by empty filters and empty membership sets. */
export interface ScalarEntityConstantPredicate {
  readonly kind: "constant";
  readonly value: boolean;
}

/** Internal logical group used only after public field filters are validated. */
export interface ScalarEntityPredicateGroup {
  readonly kind: "all" | "any";
  readonly predicates: readonly ScalarEntityPredicate[];
}

/** Provider-neutral query predicate promoted from the public filter boundary. */
export type ScalarEntityPredicate =
  | ScalarEntityComparisonPredicate
  | ScalarEntitySetPredicate
  | ScalarEntityLikePredicate
  | ScalarEntityNullPredicate
  | ScalarEntityConstantPredicate
  | ScalarEntityPredicateGroup;

/** One normalized sort key in deterministic precedence order. */
export interface ScalarEntityOrder {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

/** Validated filter shared by collection reads and count queries. */
export interface ScalarEntityCountQuery {
  readonly tableName: string;
  readonly primaryKeyColumn: string;
  readonly predicate: ScalarEntityPredicate;
}

/** Validated filter, ordering, and paging for one scalar entity read. */
export interface ScalarEntityQuery extends ScalarEntityCountQuery {
  readonly orderBy: readonly ScalarEntityOrder[];
  readonly limit?: number;
  readonly offset?: number;
}

/** One scalar entity row returned by a read. */
export type ScalarEntityRow = Readonly<Record<string, ScalarEntityValue>>;

/** Read operations available both outside and inside provider transactions. */
export interface ScalarEntityReader {
  read(query: ScalarEntityQuery): Promise<readonly ScalarEntityRow[]>;
  /** Returns the unpaged number of rows matching the query predicate. */
  count(query: ScalarEntityCountQuery): Promise<number>;
}

/**
 * Write surface available inside one atomic transaction.
 *
 * Inserts, updates, and deletes run against the active transaction so a single
 * `flush()` either commits every entity row or rolls them all back.
 */
export interface ScalarEntityTransaction extends ScalarEntityReader {
  insert(row: ScalarEntityInsert): Promise<void>;
  update(row: ScalarEntityUpdate): Promise<void>;
  delete(row: ScalarEntityDelete): Promise<void>;
  /**
   * Flushes provider-scheduled entity, canonical-state, and outbox work before
   * the common UoW advances snapshots. The enclosing transaction must still be
   * able to roll all of it back if the caller later rejects.
   */
  flush(): Promise<void>;
}

/**
 * Replaceable local persistence engine behind the public EntityManager.
 *
 * `beginTransaction` is the only outer write boundary. A provider must keep
 * every insert/update/delete and its associated canonical/outbox writes in the
 * callback within one SQLite transaction and roll the whole callback back when
 * it rejects.
 */
export interface ScalarEntityPersistenceProvider extends ScalarEntityReader {
  /** Runs one atomic transaction and rolls back every write on rejection. */
  beginTransaction<Result>(
    work: (transaction: ScalarEntityTransaction) => Promise<Result>,
  ): Promise<Result>;
  /** Runs read operations against one consistent persistence snapshot. */
  readSnapshot<Result>(
    work: (reader: ScalarEntityReader) => Promise<Result>,
  ): Promise<Result>;
  /** Releases resources owned by the underlying SQLite connection. */
  close(): Promise<void>;
}
