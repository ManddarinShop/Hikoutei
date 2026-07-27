/**
 * Public lifecycle contracts for the typed-sheets ORM facade.
 *
 * They intentionally describe our entity lifecycle rather than any concrete
 * ORM implementation, so a SQLite execution adapter can change without
 * changing the application's `em.persist()` / `em.flush()` workflow.
 */

import {
  PRESENCE_KINDS,
  type Presence,
} from "../../core/state/index.js";
import type { SqlExecutor } from "../adapters/contracts.js";

/** Constructor accepted by the initial entity-style public API. */
export interface TypedSheetsEntityClass<Entity extends object> {
  new (...arguments_: never[]): Entity;
}

/** Stable entity reference accepted by our EntityManager facade. */
export type TypedSheetsEntityReference<Entity extends object> =
  | string
  | TypedSheetsEntityClass<Entity>;

/** Values used when creating one entity through `em.create()`. */
export type TypedSheetsEntityData<Entity extends object> = Readonly<Partial<Entity>>;

/** Equality filter accepted by the initial `find()` and `findOne()` surface. */
export type TypedSheetsEntityFilter<Entity extends object> = Readonly<Partial<Entity>>;

/** Read options intentionally supported by the initial public entity API. */
export interface TypedSheetsFindOptions {
  readonly limit?: number;
  readonly offset?: number;
}

/** Entity-manager fork behavior supported without leaking the underlying ORM. */
export interface TypedSheetsForkOptions {
  /** Starts the fork with an empty identity map when the execution engine supports it. */
  readonly clear?: boolean;
}

/** Callback invoked by one entity execution engine immediately before it writes. */
export type TypedSheetsEntityFlushListener = (
  context: TypedSheetsFlushContext,
) => Promise<void>;

/**
 * Replaceable internal execution engine for the typed-sheets EntityManager.
 *
 * This is the only extension point an ORM-specific integration must implement.
 * It deliberately uses typed-sheets lifecycle types, never MikroORM types.
 */
export interface TypedSheetsEntityEngine {
  /** Opens an isolated manager for one request, job, or unit of work. */
  fork(): TypedSheetsEntityEngineManager;
  /** Releases resources owned by the underlying SQLite execution engine. */
  close(force?: boolean): Promise<void>;
}

/** Internal manager operations required to implement the public entity lifecycle. */
export interface TypedSheetsEntityEngineManager {
  fork(options?: TypedSheetsForkOptions): TypedSheetsEntityEngineManager;
  create<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    data: TypedSheetsEntityData<Entity>,
  ): Entity;
  find<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    where: TypedSheetsEntityFilter<Entity>,
    options?: TypedSheetsFindOptions,
  ): Promise<readonly Entity[]>;
  findOne<Entity extends object>(
    entityName: TypedSheetsEntityReference<Entity>,
    where: TypedSheetsEntityFilter<Entity>,
    options?: TypedSheetsFindOptions,
  ): Promise<Entity | null>;
  persist<Entity extends object>(entity: Entity | Iterable<Entity>): void;
  remove<Entity extends object>(entity: Entity | Iterable<Entity>): void;
  flush(): Promise<void>;
  transactional<Result>(
    operation: (entityManager: TypedSheetsEntityEngineManager) => Promise<Result>,
  ): Promise<Result>;
  clear(): void;
  isInTransaction(): boolean;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** Registers the typed-sheets plan to run in the engine's active flush transaction. */
  onFlush(listener: TypedSheetsEntityFlushListener): void;
}

/** Runtime values for durable entity changes observed during one flush. */
export const TYPED_SHEETS_ENTITY_CHANGE_KINDS = {
  CREATE: "create",
  UPDATE: "update",
  DELETE: "delete",
} as const;

/** Closed set of entity lifecycle changes handled by the typed-sheets ORM. */
export type TypedSheetsEntityChangeKind =
  (typeof TYPED_SHEETS_ENTITY_CHANGE_KINDS)[keyof typeof TYPED_SHEETS_ENTITY_CHANGE_KINDS];

/**
 * One entity change collected from a single `flush()` operation.
 *
 * `primaryKey` is absent only when the underlying entity engine has not yet
 * assigned a key. A Sheets mapping that requires a stable row identity must
 * reject that case before it writes canonical state or an effect.
 */
export interface TypedSheetsEntityChange {
  readonly kind: TypedSheetsEntityChangeKind;
  readonly entityName: string;
  readonly entity: object;
  readonly primaryKey: Presence<string>;
  /** Changed scalar values for updates and persisted values for inserts. */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** Context available to the typed-sheets sync planner during an entity flush. */
export interface TypedSheetsFlushContext {
  /** All entity changes in the current Unit of Work(작업 단위). */
  readonly changes: readonly TypedSheetsEntityChange[];
  /** SQL executor bound to the same transaction as the entity writes. */
  readonly sql: SqlExecutor;
}

/**
 * Converts durable entity changes into typed-sheets canonical and outbox work.
 *
 * The coordinator runs before entity rows are flushed, but within the same
 * SQLite transaction. Throwing aborts both the entity write and every
 * typed-sheets write scheduled through `context.sql`.
 */
export interface TypedSheetsFlushCoordinator {
  onFlush(context: TypedSheetsFlushContext): Promise<void>;
}

/** Converts a database-generated primary-key value into the public presence contract. */
export function primaryKeyPresence(primaryKey: string | null): Presence<string> {
  return primaryKey === null
    ? { kind: PRESENCE_KINDS.ABSENT }
    : { kind: PRESENCE_KINDS.PRESENT, value: primaryKey };
}
