/**
 * Installed-package public API surface scenario.
 *
 * This is the public-API verification counterpart to the installed root API
 * smoke (`run-root-api-scenario.mjs`) and the internal sync/provider E2E
 * (`run-api-scenario.mjs`). It imports ONLY the installed package root
 * entrypoint `hikoutei` — no internal package subpaths and no source imports —
 * and exercises the full public entity-lifecycle contract an application is
 * meant to use, at a 100-record scale:
 *
 *   defineTypedSheetsEntity() (2 entities) -> createTypedSheets() with the
 *     registry default and with the HIKOUTEI_DB_PATH env default (no args)
 *   create()/persist()/flush() for 100 records -> find()/findOne()/filter
 *   mutate + flush -> fresh-fork re-read (local SQLite authority)
 *   transactional() commit and rollback
 *   remove() 25 records -> fresh-fork count and absence checks
 *   close() idempotency
 *   ERR_PACKAGE_PATH_NOT_EXPORTED boundary guard for internal subpaths
 *
 * It uses in-memory and temp-file SQLite authorities with no Sheet
 * configuration. It never contacts Google Sheets, never needs credentials, and
 * never provisions remote tabs. A pass proves the packed, installed package's
 * public surface is usable by an external consumer end to end.
 *
 * Result JSON (written to `--output`):
 *
 *   { status: "passed", scenario, version, startedAt, durationMs, assertions, steps }
 *   { status: "failed", scenario, step, error, ... }
 *
 * `assertions` is the exact number of `assert.*` invocations executed across
 * all steps; work-only steps that perform no assert calls contribute 0 to the
 * total. The stdout summary prints the same number.
 *
 * Exit code is 0 on pass and 1 on failure; step progress is printed to stdout.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

// The only package import: the installed root entrypoint. No internal package
// subpaths, no source imports, no test fakes. `getRegisteredEntityTokens()`
// and other registry internals are intentionally never imported; the registry
// default is verified only through the public factory.
import {
  HIKOUTEI_ERROR_CODES,
  HIKOUTEI_SCALAR_TYPES,
  HikouteiError,
  createTypedSheets,
  defineTypedSheetsEntity,
} from "hikoutei";

// The option parser is a dependency-free helper so it can be unit-tested
// directly without importing the installed package.
import { parseRootApiOptions } from "./root-api-options.mjs";

const SCENARIO_VERSION = "v1";

// HIKOUTEI_SYNC_SPREADSHEET_URL would route createTypedSheets() into the sync
// auto-start bridge; this scenario is purely local. The variable is removed
// for the duration of the run and restored afterwards when it was set.
const SYNC_SPREADSHEET_URL_ENV = "HIKOUTEI_SYNC_SPREADSHEET_URL";
const DB_PATH_ENV = "HIKOUTEI_DB_PATH";

/**
 * Asserts that only the root `hikoutei` entrypoint is a published export.
 *
 * The internal `hikoutei/orm` and `hikoutei/mikro-orm` subpaths are not part of
 * the public contract; importing them from an installed package must fail with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 */
async function assertRootOnlyContract() {
  for (const subpath of ["orm", "mikro-orm"]) {
    await assert.rejects(
      () => import(`hikoutei/${subpath}`),
      (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
  }
}

async function main() {
  const options = parseRootApiOptions(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const startedClock = performance.now();
  const steps = [];
  let assertions = 0;
  let scenarioError;
  let failedStep;

  const measure = async (name, operation) => {
    const stepStartedAt = performance.now();
    try {
      const result = await operation();
      const durationMs = roundMs(performance.now() - stepStartedAt);
      steps.push({ name, durationMs, status: "passed" });
      process.stdout.write(`[step] ${name}: passed (${durationMs} ms)\n`);
      return result;
    } catch (error) {
      const durationMs = roundMs(performance.now() - stepStartedAt);
      steps.push({ name, durationMs, status: "failed", error: errorMessage(error) });
      process.stdout.write(`[step] ${name}: FAILED (${durationMs} ms)\n`);
      failedStep = name;
      throw error;
    }
  };

  let runtime;
  let envRuntime;
  let envDbPath;
  const originalEnv = {
    [DB_PATH_ENV]: process.env[DB_PATH_ENV],
    [SYNC_SPREADSHEET_URL_ENV]: process.env[SYNC_SPREADSHEET_URL_ENV],
  };
  delete process.env[SYNC_SPREADSHEET_URL_ENV];
  try {
    // The package boundary is checked first as a measured step so a rejection
    // is captured in the report like any other failed step.
    await measure("reject_internal_subpaths", async () => {
      await assertRootOnlyContract();
    });
    assertions += 2;

    // Two scalar entities keep the registry default and cross-entity table
    // isolation meaningful.
    const User = defineTypedSheetsEntity({
      name: "User",
      tableName: "users",
      properties: {
        id: { type: "string", primary: true },
        name: { type: "string" },
        active: { type: "boolean" },
      },
    });
    const Tag = defineTypedSheetsEntity({
      name: "Tag",
      tableName: "tags",
      properties: {
        id: { type: "string", primary: true },
        label: { type: "string" },
      },
    });
    await measure("define_entities", async () => {
      assert.notEqual(User, null);
      assert.notEqual(Tag, null);
      // Public surface completeness: the scalar-type and error-code constants
      // are root exports with stable values.
      assert.equal(HIKOUTEI_SCALAR_TYPES.STRING, "string");
      assert.equal(HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR, "invalid_entity_descriptor");
    });
    assertions += 4;

    // Registry default: omitting `entities` must resolve the tokens registered
    // by defineTypedSheetsEntity() at call time (the #172 default), verified
    // only through the public factory.
    runtime = await measure("open_runtime_registry_default", async () => {
      return createTypedSheets({ dbName: ":memory:" });
    });

    await measure("registry_default_entities_usable", async () => {
      const em = runtime.em.fork();
      // A findOne on a registered entity returns null; on an unregistered one
      // the manager throws UNREGISTERED_ENTITY. A null read therefore proves
      // the registry default resolved the User token without inserting a row
      // that would distort the bulk-count steps below.
      assert.equal(await em.findOne(User, { id: "reg-u1" }), null);
      // The Tag token is also resolved by the registry default; a full write/
      // read roundtrip proves both entities are usable.
      em.persist(em.create(Tag, { id: "reg-t1", label: "Registry Tag" }));
      await em.flush();
      const loadedTag = await em.findOne(Tag, { id: "reg-t1" });
      assert.notEqual(loadedTag, null);
      assert.equal(loadedTag.label, "Registry Tag");
    });
    assertions += 3;

    // The 100-record bulk lifecycle uses a fresh runtime so the users table
    // contains exactly the 100 u-* records and the counts stay unambiguous.
    await runtime.close();
    runtime = await measure("open_runtime_explicit_entities", async () => {
      return createTypedSheets({ dbName: ":memory:", entities: [User, Tag] });
    });

    // Env default: a no-argument createTypedSheets() must open the runtime at
    // the HIKOUTEI_DB_PATH path and use the registry entity set. The record is
    // written, the runtime is closed, and a fresh no-argument open reads the
    // record back from the file.
    await measure("open_runtime_env_default", async () => {
      const envDir = await mkdtemp(path.join(os.tmpdir(), "hikoutei-public-surface-"));
      envDbPath = path.join(envDir, "env-default.sqlite");
      process.env[DB_PATH_ENV] = envDbPath;

      envRuntime = await createTypedSheets();
      const em = envRuntime.em.fork();
      em.persist(em.create(User, { id: "env-u1", name: "Env Default", active: true }));
      await em.flush();
      await envRuntime.close();
      envRuntime = undefined;

      assert.equal(existsSync(envDbPath), true);

      // Reopen with the same env, still no arguments: the registry supplies the
      // entities and the env var supplies the SQLite path.
      envRuntime = await createTypedSheets();
      const reloaded = await envRuntime.em.fork().findOne(User, { id: "env-u1" });
      assert.notEqual(reloaded, null);
      assert.equal(reloaded.name, "Env Default");
      await envRuntime.close();
      envRuntime = undefined;
    });
    assertions += 3;

    await measure("reject_invalid_factory_options", async () => {
      // Public error surface: non-object options and blank dbName both reject
      // with the stable INVALID_ENTITY_DESCRIPTOR code.
      await assert.rejects(
        () => createTypedSheets(null),
        (error) =>
          error instanceof HikouteiError
          && error.code === HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      );
      await assert.rejects(
        () => createTypedSheets({ dbName: "   ", entities: [User] }),
        (error) =>
          error instanceof HikouteiError
          && error.code === HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      );
    });
    assertions += 2;

    // Bulk CRUD: 100 users created and persisted with ONE flush.
    const em = await measure("fork_manager", () => {
      const manager = runtime.em.fork();
      assert.equal(typeof manager.create, "function");
      assert.equal(typeof manager.persist, "function");
      assert.equal(typeof manager.findOne, "function");
      assert.equal(typeof manager.find, "function");
      assert.equal(typeof manager.remove, "function");
      assert.equal(typeof manager.flush, "function");
      assert.equal(typeof manager.transactional, "function");
      assert.equal(typeof manager.count, "function");
      assert.equal(typeof manager.findAndCount, "function");
      return manager;
    });
    assertions += 9;

    await measure("create_persist_100_records", async () => {
      for (let index = 0; index < 100; index += 1) {
        const id = `u-${String(index).padStart(3, "0")}`;
        const user = em.create(User, {
          id,
          name: `User-${String(index).padStart(3, "0")}`,
          active: index % 2 === 0,
        });
        em.persist(user);
      }
      await em.flush();
    });

    await measure("find_returns_all_100", async () => {
      const users = await em.find(User);
      assert.equal(users.length, 100);
    });
    assertions += 1;

    await measure("findone_spot_checks", async () => {
      for (const id of ["u-000", "u-049", "u-099"]) {
        const loaded = await em.findOne(User, { id });
        assert.notEqual(loaded, null);
        assert.equal(loaded.id, id);
        assert.equal(loaded.name, `User-${id.slice(2)}`);
      }
    });
    assertions += 9;

    await measure("find_with_filter", async () => {
      const active = await em.find(User, { active: true });
      assert.equal(active.length, 50);
      const named = await em.find(User, { name: "User-007" });
      assert.equal(named.length, 1);
      assert.equal(named[0].id, "u-007");
    });
    assertions += 3;

    await measure("rich_query_order_count", async () => {
      const rich = await em.find(
        User,
        {
          id: { gte: "u-010", lt: "u-020" },
          name: { like: "User-01_" },
          active: { in: [true, false] },
        },
        { orderBy: { name: "desc" }, limit: 3 },
      );
      assert.deepEqual(rich.map((user) => user.id), ["u-019", "u-018", "u-017"]);
      assert.equal(await em.count(User, { id: { in: ["u-001", "u-002", "missing"] } }), 2);

      const [page, total] = await em.findAndCount(
        User,
        { active: true, id: { nin: ["u-000"] } },
        { orderBy: { id: "asc" }, limit: 2, offset: 1 },
      );
      assert.deepEqual(page.map((user) => user.id), ["u-004", "u-006"]);
      assert.equal(total, 49);
    });
    assertions += 4;

    await measure("mutate_10_records", async () => {
      for (let index = 0; index < 10; index += 1) {
        const loaded = await em.findOne(User, { id: `u-${String(index).padStart(3, "0")}` });
        assert.notEqual(loaded, null);
        loaded.name = `${loaded.name} (updated)`;
        loaded.active = !loaded.active;
      }
      await em.flush();
    });
    assertions += 10;

    await measure("reread_mutations_from_fresh_fork", async () => {
      // A fresh fork reads from the local SQLite authority with a clean
      // identity map, proving the mutations were committed.
      const fresh = runtime.em.fork();
      for (let index = 0; index < 10; index += 1) {
        const loaded = await fresh.findOne(User, { id: `u-${String(index).padStart(3, "0")}` });
        assert.notEqual(loaded, null);
        assert.equal(loaded.name.endsWith("(updated)"), true);
        assert.equal(loaded.active, index % 2 !== 0);
      }
      const untouched = await fresh.findOne(User, { id: "u-010" });
      assert.notEqual(untouched, null);
      assert.equal(untouched.name, "User-010");
    });
    assertions += 32;

    await measure("transactional_commit", async () => {
      const result = await em.transactional(async (transactionalEm) => {
        transactionalEm.persist(
          transactionalEm.create(User, { id: "tx-commit", name: "Tx Commit", active: true }),
        );
        return "tx-result";
      });
      assert.equal(result, "tx-result");
      // A fresh fork reads the committed row from the local authority.
      const freshCommitted = await runtime.em.fork().findOne(User, { id: "tx-commit" });
      assert.notEqual(freshCommitted, null);
      assert.equal(freshCommitted.name, "Tx Commit");
      // Remove the committed record again (through this manager, which owns
      // the managed instance) so the users table returns to the exact
      // 100-record baseline the remove step counts from.
      const committed = await em.findOne(User, { id: "tx-commit" });
      assert.notEqual(committed, null);
      em.remove(committed);
      await em.flush();
    });
    assertions += 4;

    await measure("transactional_rollback", async () => {
      // The callback flushes explicitly before throwing so the rollback path
      // covers work that already reached the provider transaction.
      await assert.rejects(
        em.transactional(async (transactionalEm) => {
          transactionalEm.persist(
            transactionalEm.create(User, { id: "tx-rollback", name: "Tx Rollback", active: true }),
          );
          await transactionalEm.flush();
          throw new Error("rollback please");
        }),
        (error) => error instanceof Error && error.message === "rollback please",
      );
      assert.equal(await runtime.em.fork().findOne(User, { id: "tx-rollback" }), null);
      // The rollback added nothing: the users table is still at the 100-record
      // baseline (the committed tx-commit row was removed in the commit step).
      const users = await runtime.em.fork().find(User);
      assert.equal(users.length, 100);
    });
    assertions += 3;

    await measure("remove_25_records", async () => {
      for (let index = 0; index < 25; index += 1) {
        const loaded = await em.findOne(User, { id: `u-${String(index).padStart(3, "0")}` });
        assert.notEqual(loaded, null);
        em.remove(loaded);
      }
      await em.flush();
    });
    assertions += 25;

    await measure("findone_after_removal", async () => {
      const fresh = runtime.em.fork();
      const users = await fresh.find(User);
      assert.equal(users.length, 75);
      for (const id of ["u-000", "u-012", "u-024"]) {
        assert.equal(await fresh.findOne(User, { id }), null);
      }
      const kept = await fresh.findOne(User, { id: "u-099" });
      assert.notEqual(kept, null);
      assert.equal(kept.name, "User-099");
    });
    assertions += 6;

    await measure("close_idempotent", async () => {
      await runtime.close();
      await runtime.close();
      runtime = undefined;
    });
  } catch (error) {
    scenarioError = error;
  } finally {
    // Best-effort cleanup: close any runtime still open and restore the
    // process environment.
    for (const openRuntime of [runtime, envRuntime]) {
      if (openRuntime !== undefined) {
        try {
          await openRuntime.close();
        } catch {
          // The scenario error (if any) is the headline.
        }
      }
    }
    if (envDbPath !== undefined) {
      try {
        await rm(envDbPath, { force: true });
      } catch {
        // Best-effort temp cleanup.
      }
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const durationMs = roundMs(performance.now() - startedClock);
  const status = scenarioError === undefined ? "passed" : "failed";
  const report = {
    scenario: "installed-public-api-surface",
    version: SCENARIO_VERSION,
    status,
    startedAt,
    durationMs,
    assertions,
    steps,
    ...(scenarioError === undefined
      ? {}
      : { step: failedStep, error: errorMessage(scenarioError) }),
  };

  await writeJson(options.output, report);
  await writeSummary(options.summary, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${formatPassSummary(report)}\n`);

  if (scenarioError !== undefined) {
    process.exitCode = 1;
  }
}

function formatPassSummary(report) {
  const headline = report.status === "passed" ? "PASSED" : "FAILED";
  const steps = report.steps.map((step) => `  - ${step.name}: ${step.status} (${step.durationMs} ms)`).join("\n");
  return [
    `=== Hikoutei installed public API surface: ${headline} ===`,
    `Assertions: ${report.assertions} | Steps: ${report.steps.length} | Duration: ${report.durationMs} ms`,
    steps,
  ].join("\n");
}

async function writeSummary(summaryPath, report) {
  if (summaryPath === undefined) return;
  // Create the parent directory so a custom summary path (for example a
  // nested temp path) does not fail when appendFile cannot find it.
  await mkdir(path.dirname(summaryPath), { recursive: true });
  const lines = [
    "## Hikoutei installed public API surface",
    "",
    `- Status: **${report.status}**`,
    `- Total: ${report.durationMs} ms`,
    `- Assertions: ${report.assertions}`,
    "",
    "| Step | Duration (ms) | Status |",
    "| --- | ---: | --- |",
    ...report.steps.map((step) => `| ${step.name} | ${step.durationMs} | ${step.status} |`),
    "",
  ];
  await appendFile(summaryPath, `${lines.join("\n")}\n`);
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function errorMessage(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function writeJson(filePath, value) {
  if (filePath === undefined) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
