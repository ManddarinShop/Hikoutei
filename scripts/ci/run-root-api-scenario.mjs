/**
 * Installed-package root API smoke scenario.
 *
 * This is the public-API counterpart to the internal sync/provider end-to-end
 * scenario in `run-api-scenario.mjs`. It imports ONLY the installed package
 * root entrypoint `hikoutei` — no internal package subpaths and no source
 * imports — and drives the stable entity-lifecycle contract that an
 * application is meant to use:
 *
 *   defineTypedSheetsEntity() -> createTypedSheets() -> em.fork()
 *   create()/persist()/flush() -> findOne() verify
 *   mutate/flush/re-read (fresh fork from the local authority)
 *   remove()/flush() -> verify deletion
 *   hikoutei.close()
 *
 * It uses an in-memory SQLite authority (dbName `:memory:`) with no Sheet
 * configuration. It never contacts Google Sheets, never needs credentials, and
 * never provisions remote tabs. A pass proves the packed, installed package's
 * public root surface is usable by an external consumer end to end.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

// The only import: the installed package root entrypoint. No internal package
// subpaths, no source imports, no test fakes.
import {
  createTypedSheets,
  defineTypedSheetsEntity,
} from "hikoutei";

// The option parser is a dependency-free helper so it can be unit-tested
// directly without importing the installed package.
import { parseRootApiOptions } from "./root-api-options.mjs";

const SCENARIO_VERSION = "v1";

/**
 * Asserts that only the root `hikoutei` entrypoint is a published export.
 *
 * The internal `hikoutei/orm` and `hikoutei/mikro-orm` subpaths are not part of
 * the public contract; importing them from an installed package must fail with
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`. This guard documents that boundary directly
 * in the installed-consumer smoke rather than only in source-level tests.
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

  const measure = async (name, operation) => {
    const stepStartedAt = performance.now();
    try {
      const result = await operation();
      steps.push({
        name,
        durationMs: roundMs(performance.now() - stepStartedAt),
        status: "passed",
      });
      return result;
    } catch (error) {
      steps.push({
        name,
        durationMs: roundMs(performance.now() - stepStartedAt),
        status: "failed",
        error: errorMessage(error),
      });
      throw error;
    }
  };

  let runtime;
  try {
    // The package boundary is checked first as a measured step so a rejection
    // is captured in the JSON/summary report like any other failed step
    // rather than aborting the process before the report is written.
    await measure("reject_internal_subpaths", async () => {
      await assertRootOnlyContract();
    });
    assertions += 2;

    // A scalar entity with several scalar types keeps the smoke meaningful.
    const User = defineTypedSheetsEntity({
      name: "User",
      tableName: "users",
      properties: {
        id: { type: "string", primary: true },
        name: { type: "string" },
        count: { type: "number" },
        active: { type: "boolean" },
      },
    });

    runtime = await measure("open_runtime", async () => {
      // `:memory:` keeps the scenario self-contained. Sheet configuration is
      // intentionally absent because it belongs to the internal sync service.
      return createTypedSheets({
        dbName: ":memory:",
        entities: [User],
      });
    });
    assertions += 1;

    const em = await measure("fork_manager", () => {
      const manager = runtime.em.fork();
      assert.equal(typeof manager.create, "function");
      assert.equal(typeof manager.persist, "function");
      assert.equal(typeof manager.findOne, "function");
      assert.equal(typeof manager.remove, "function");
      assert.equal(typeof manager.flush, "function");
      assert.equal(typeof manager.count, "function");
      assert.equal(typeof manager.findAndCount, "function");
      return manager;
    });
    assertions += 7;

    const entityId = "u1";

    await measure("create_persist_flush", async () => {
      const user = em.create(User, { id: entityId, name: "Ada", count: 1, active: true });
      em.persist(user);
      await em.flush();
    });
    assertions += 1;

    await measure("findone_after_create", async () => {
      const loaded = await em.findOne(User, { id: entityId });
      assert.notEqual(loaded, null);
      assert.equal(loaded.id, entityId);
      assert.equal(loaded.name, "Ada");
      assert.equal(loaded.count, 1);
      assert.equal(loaded.active, true);
    });
    assertions += 5;

    await measure("rich_query_and_count", async () => {
      const matching = await em.find(User, {
        name: { like: "Ad%" },
        count: { gte: 1, lt: 2 },
        active: { in: [true] },
      }, { orderBy: { name: "asc" } });
      assert.equal(matching.length, 1);
      assert.equal(matching[0].id, entityId);
      assert.equal(await em.count(User, { name: { ne: "Grace" } }), 1);
      const [page, total] = await em.findAndCount(User, {}, { limit: 1 });
      assert.equal(page.length, 1);
      assert.equal(total, 1);
    });
    assertions += 5;

    await measure("identity_map", async () => {
      // Repeated reads through the same manager return the same instance:
      // the request-local identity map caches managed entities by primary key.
      const first = await em.findOne(User, { id: entityId });
      const second = await em.findOne(User, { id: entityId });
      assert.equal(first, second);
      // A fresh fork owns an independent identity map, so the same persisted
      // row materializes as a distinct instance.
      const other = await runtime.em.fork().findOne(User, { id: entityId });
      assert.notEqual(other, first);
    });
    assertions += 2;

    await measure("mutate_flush", async () => {
      const loaded = await em.findOne(User, { id: entityId });
      assert.notEqual(loaded, null);
      // Mutate scalars and flush without an explicit persist(); Hikoutei
      // dirty-tracks the loaded instance against its snapshot.
      loaded.name = "Ada Lovelace";
      loaded.count = 2;
      loaded.active = false;
      await em.flush();
    });
    assertions += 1;

    await measure("reread_after_update", async () => {
      // A fresh fork reads from the local SQLite authority with a clean
      // identity map, proving the mutation was committed.
      const fresh = await runtime.em.fork().findOne(User, { id: entityId });
      assert.notEqual(fresh, null);
      assert.equal(fresh.name, "Ada Lovelace");
      assert.equal(fresh.count, 2);
      assert.equal(fresh.active, false);
    });
    assertions += 4;

    await measure("remove_flush", async () => {
      const loaded = await em.findOne(User, { id: entityId });
      assert.notEqual(loaded, null);
      em.remove(loaded);
      await em.flush();
    });
    assertions += 1;

    await measure("findone_after_delete", async () => {
      // The removed entity left the manager's identity map and the local
      // SQLite authority, so both the same-manager and fresh-fork lookups
      // return null.
      assert.equal(await em.findOne(User, { id: entityId }), null);
      const fresh = await runtime.em.fork().findOne(User, { id: entityId });
      assert.equal(fresh, null);
    });
    assertions += 2;

    await measure("close_runtime", async () => {
      await runtime.close();
      runtime = undefined;
    });
    assertions += 1;
  } catch (error) {
    scenarioError = error;
  } finally {
    if (runtime !== undefined) {
      try {
        await runtime.close();
      } catch {
        // Best-effort cleanup; the scenario error (if any) is the headline.
      }
    }
  }

  const durationMs = roundMs(performance.now() - startedClock);
  const status = scenarioError === undefined ? "passed" : "failed";
  const report = {
    scenario: "installed-root-api-smoke",
    scenarioVersion: SCENARIO_VERSION,
    status,
    startedAt,
    durationMs,
    assertions,
    steps,
    error: scenarioError === undefined ? undefined : errorMessage(scenarioError),
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
    `=== Hikoutei installed root API smoke: ${headline} ===`,
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
    "## Hikoutei installed root API smoke",
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
