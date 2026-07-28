import type { SqlExecutor } from "../../../adapter/persistence/contracts/sql.js";

/** Runs a nested storage unit atomically inside the current async SQL transaction. */
export async function withSqlSavepoint<T>(
  sql: SqlExecutor,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  await sql.run(`SAVEPOINT ${name}`);
  try {
    const value = await operation();
    await sql.run(`RELEASE ${name}`);
    return value;
  } catch (error: unknown) {
    try {
      await rollbackSqlSavepoint(sql, name);
    } catch {
      // Preserve the original storage error when cleanup itself fails.
    }
    throw error;
  }
}

/** Rolls a named savepoint back and releases it from the current async SQL transaction. */
export async function rollbackSqlSavepoint(sql: SqlExecutor, name: string): Promise<void> {
  await sql.run(`ROLLBACK TO ${name}`);
  await sql.run(`RELEASE ${name}`);
}
