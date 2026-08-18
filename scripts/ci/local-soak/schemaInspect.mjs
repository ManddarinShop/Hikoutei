/**
 * Read-only SQLite schema metadata inspection for the soak resume path.
 *
 * The soak runner's MUTATION path is exclusively the public
 * `createTypedSheets()` / EntityManager surface — no raw SQL. The only
 * raw-SQL access in the harness is this isolated, read-only metadata
 * inspection (`sqlite_master` + `PRAGMA table_info`), which never writes
 * to the database. The resume path inspects the EXISTING authority schema
 * BEFORE the runtime opens: a missing entity table or column must fail
 * the resume with a stable reason instead of being silently recreated by
 * the runtime's non-destructive schema update and then accepted with
 * zero expected rows (MEDIUM 4).
 *
 * Test-only by nature: this module exists for the CI/local soak harness
 * and is never imported by the library (`src/**`).
 *
 * `node:sqlite` is loaded through `process.getBuiltinModule` (the same
 * pattern as the soak tests and the ikisaki kernel tests) because the
 * vitest 1.6 module graph does not resolve `node:sqlite` as an import id.
 *
 * `node:sqlite` was unflagged in Node 22.13 (backported) and 23.4, so this
 * module requires Node >= 22.13. The package `engines.node` floor is kept at
 * >= 22.13 to match that availability (see root `package.json`). It needs no
 * separate dependency: the built-in API is the read-only inspection path used
 * here.
 */

/** Node's builtin SQLite constructor (loaded lazily; see file doc). */
function loadDatabaseSync() {
  return process.getBuiltinModule("node:sqlite").DatabaseSync;
}

/**
 * Maps one camelCase property name to its snake_case SQLite column name.
 *
 * Mirrors MikroORM's default `UnderscoreNamingStrategy` for the soak field
 * vocabulary (single camel humps such as `dueAt` -> `due_at`); the soak
 * field plans contain no digit/abbreviation sequences, so the simple
 * hump-splitting rule below is exact for them. The runner tests pin this
 * derivation against the REAL columns of a fresh authority, so a naming
 * drift between this mirror and the ORM fails loudly in CI.
 *
 * @param {string} field property name.
 * @returns {string} snake_case column name.
 */
export function expectedColumnName(field) {
  return field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * Expected snake_case columns for one entity's field plan, in plan order.
 *
 * @param {Readonly<Record<string, unknown>>} fieldPlan entity field plan.
 * @returns {string[]} expected column names.
 */
export function soakTableColumns(fieldPlan) {
  return Object.keys(fieldPlan).map(expectedColumnName);
}

/**
 * Opens the SQLite authority READ-ONLY and returns its table -> column map.
 *
 * Metadata only: `sqlite_master` for table names and `PRAGMA table_info`
 * for column names. The connection is opened read-only and closed before
 * returning, so this inspection can never mutate, lock, or create the
 * database (a missing file surfaces as an empty map; the resume path
 * rejects a missing/empty authority separately BEFORE calling this).
 *
 * @param {string} dbName absolute path of `soak.sqlite`.
 * @returns {Record<string, string[]>} observed table -> column names.
 */
export function inspectSqliteSchema(dbName) {
  const DatabaseSync = loadDatabaseSync();
  const database = new DatabaseSync(dbName, { readOnly: true });
  try {
    const observed = {};
    const tables = database.prepare(
      "select name from sqlite_master where type = 'table' " +
      "and name not like 'sqlite_%' order by name",
    ).all();
    for (const table of tables) {
      const name = String(table.name);
      const info = database.prepare(`pragma table_info(${quoteIdentifier(name)})`).all();
      observed[name] = info.map((row) => String(row.name));
    }
    return observed;
  } finally {
    database.close();
  }
}

/**
 * Compares the observed schema against the expected entity tables.
 *
 * Returns the missing table names and the missing `table.column` entries;
 * extra observed tables/columns are tolerated (the check exists to fail a
 * resume whose authority LOST schema, never to police additions).
 *
 * @param {Record<string, string[]>} observed observed table -> columns.
 * @param {ReadonlyArray<{ tableName: string, columns: string[] }>} expected expected entities.
 * @returns {{ tables: string[], columns: string[] }} missing entries.
 */
export function missingSchemaEntries(observed, expected) {
  const tables = [];
  const columns = [];
  for (const entry of expected) {
    const observedColumns = observed[entry.tableName];
    if (observedColumns === undefined) {
      tables.push(entry.tableName);
      continue;
    }
    for (const column of entry.columns) {
      if (!observedColumns.includes(column)) {
        columns.push(`${entry.tableName}.${column}`);
      }
    }
  }
  return { tables, columns };
}

/** Quotes one identifier for a PRAGMA statement (SQLite double-quote rule). */
function quoteIdentifier(name) {
  return `"${name.replace(/"/g, "\"\"")}"`;
}
