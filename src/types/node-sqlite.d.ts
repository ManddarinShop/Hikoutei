/**
 * Minimal ambient typing for the `node:sqlite` built-in.
 *
 * The root `@types/node` major predates `node:sqlite` (Node 22.5+), while the
 * persistence engine already reaches SQLite through MikroORM's
 * `NodeSqliteDialect`, which uses the same built-in. This declaration covers
 * only the read-only surface used by `src/internal/syncStatus.ts`; when the
 * repository upgrades `@types/node` to a version that ships real
 * `node:sqlite` types, this file should be deleted.
 */

declare module "node:sqlite" {
  /** Prepared statement; results are `unknown` and narrowed by callers. */
  interface StatementSync {
    all(...anonymousParameters: unknown[]): unknown[];
    get(...anonymousParameters: unknown[]): unknown;
  }

  /** Options accepted by the `DatabaseSync` constructor. */
  interface DatabaseSyncOptions {
    readOnly?: boolean;
  }

  /** Synchronous SQLite connection over the Node built-in. */
  class DatabaseSync {
    constructor(location: string, options?: DatabaseSyncOptions);
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
