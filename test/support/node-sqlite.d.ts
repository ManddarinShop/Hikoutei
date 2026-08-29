/**
 * Minimal ambient types for the `node:sqlite` builtin.
 *
 * The root test project resolves @types/node 20.x, which predates
 * `node:sqlite` (added in Node 22.5 and typed in @types/node >= 22.5). The
 * soak tests only open SQLite handles to inspect table names, run
 * DDL/row-count statements, and read scalar counts, so only that surface
 * is declared here; the ikisaki kernel tests get the real declarations
 * from their nested @types/node 24.x.
 */
declare module "node:sqlite" {
  /** A prepared statement exposing the read-only surface used by tests. */
  export interface StatementSync {
    /** Executes the statement and returns every result row. */
    all(...parameters: unknown[]): Record<string, unknown>[];
    /** Executes a statement that returns no rows (DDL/DML). */
    run(...parameters: unknown[]): { readonly changes: number };
    /** Executes a statement and returns its first result row, if any. */
    get(...parameters: unknown[]): Record<string, unknown> | undefined;
  }

  /** A synchronous SQLite database handle. */
  export interface DatabaseSync {
    /** Prepares one SQL statement for execution. */
    prepare(sql: string): StatementSync;
    /** Closes the database connection. */
    close(): void;
  }

  /** Constructs a synchronous SQLite database handle for one file. */
  export const DatabaseSync: new (path: string) => DatabaseSync;
}
