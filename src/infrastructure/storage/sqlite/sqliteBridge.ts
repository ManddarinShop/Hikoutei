/**
 * SQLite driver bridge for `node:sqlite` that vitest/vite-node can resolve.
 *
 * vite-node does not yet recognize `node:sqlite` as a built-in module. Loading
 * it through Node's `createRequire` leaves the specifier to the runtime while
 * keeping the storage type boundary independent from its declaration files.
 */

import { createRequire } from "node:module";
import { STORAGE_ERROR_CODES, StorageError } from "../errors.js";

interface DatabaseSyncOpenOptions {
  readonly readOnly?: boolean;
}

type DatabaseSyncConstructor = new (path: string, options?: DatabaseSyncOpenOptions) => DatabaseSyncLike;

let cached: DatabaseSyncConstructor | null = null;

// Keep the specifier outside a statically analyzable import so vite-node leaves
// Node's experimental/built-in sqlite module untouched.
const nodeSqliteSpecifier: string = "node:sqlite";
const requireAtRuntime = createRequire(import.meta.url);

export async function openDatabase(path: string): Promise<DatabaseSyncLike> {
  const DatabaseSync = await getDatabaseSync();
  return new DatabaseSync(path);
}

/** Opens an existing SQLite backup without granting this process write access. */
export async function openReadOnlyDatabase(path: string): Promise<DatabaseSyncLike> {
  const DatabaseSync = await getDatabaseSync();
  return new DatabaseSync(path, { readOnly: true });
}

/**
 * Runs one outer writer transaction with SQLite's immediate write reservation.
 *
 * Call this only at a writer-RPC boundary, never from code that is already in a
 * transaction. Nested storage helpers use savepoints so a failed substep rolls
 * back without exposing a partial canonical or outbox mutation.
 */
export function withImmediateTransaction<T>(db: DatabaseSyncLike, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    db.exec("COMMIT");
    return value;
  } catch (error: unknown) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original error; a failed rollback only adds diagnostic noise.
    }
    throw error;
  }
}

/** Lazy-loaded DatabaseSync constructor. */
export async function getDatabaseSync(): Promise<
  DatabaseSyncConstructor
> {
  if (cached !== null) {
    return cached;
  }

  const mod: unknown = requireAtRuntime(nodeSqliteSpecifier);
  if (!hasDatabaseSyncConstructor(mod)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SQLITE_RUNTIME_UNAVAILABLE,
      "SQLite-authoritative storage requires a Node.js runtime that provides node:sqlite.",
    );
  }

  cached = mod.DatabaseSync;
  return cached;
}

/**
 * Minimal type description of DatabaseSync that the storage layer and tests
 * use. This avoids importing the real type from `node:sqlite` at the type
 * level, which would also trigger vite-node resolution.
 */
export interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

export interface StatementLike {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = unknown>(...params: unknown[]): T | undefined;
  all<T = unknown>(...params: unknown[]): T[];
}

function hasDatabaseSyncConstructor(value: unknown): value is {
  readonly DatabaseSync: DatabaseSyncConstructor;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "DatabaseSync" in value &&
    typeof (value as { readonly DatabaseSync: unknown }).DatabaseSync === "function"
  );
}
