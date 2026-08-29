/**
 * Type declarations for `scripts/ci/local-soak/schemaInspect.mjs`.
 *
 * Hand-written ESM helper consumed by the soak runner and by Vitest; these
 * declarations give the TypeScript test suite full type checking without
 * adding `scripts/**` to a `tsconfig` `include` set.
 */

/** Maps one camelCase property name to its snake_case SQLite column name. */
export function expectedColumnName(field: string): string;

/** Expected snake_case columns for one entity's field plan, in plan order. */
export function soakTableColumns(
  fieldPlan: Readonly<Record<string, unknown>>,
): string[];

/** Opens the SQLite authority READ-ONLY; returns table -> column names. */
export function inspectSqliteSchema(dbName: string): Record<string, string[]>;

/**
 * Missing table names and missing `table.column` entries of the observed
 * schema against the expected entity tables.
 */
export function missingSchemaEntries(
  observed: Record<string, string[]>,
  expected: ReadonlyArray<{ readonly tableName: string; readonly columns: string[] }>,
): { readonly tables: string[]; readonly columns: string[] };
