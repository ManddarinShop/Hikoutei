/**
 * Shared preamble for the soak-runner split test files.
 *
 * Extracted verbatim from the preamble (lines 1-571) of the original
 * 4,880-line `test/soak-runner.test.ts` at commit 7ee9b7d. Every split file
 * imports these constants, the mocked Sheets client, the `describeLongSoak`
 * gate, the temp-dir hooks, and the deterministic helpers instead of
 * duplicating them.
 *
 * Vitest notes:
 * - `vi.mock`/`vi.hoisted` cannot live here: the runner's import chain
 *   (SyncServiceBootstrap -> remoteProvider -> googleSheetsApiTransport)
 *   imports `@googleapis/sheets` at module scope, so each test file must
 *   register its mocks (hoisted) before its own imports. The client is
 *   shared through the async mock factory's dynamic import below; with
 *   vitest's default per-file isolation the module is re-evaluated per
 *   test file, giving each file the same fresh client state the original
 *   single-file design had.
 * - Hooks must be registered by each test file; this module only exports
 *   the hook BODIES (`soakTestBeforeAll` etc.), which the test files wire
 *   into their own `beforeAll`/`beforeEach`/`afterEach`/`afterAll`.
 */


import { describe, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeOptions } from "../../scripts/ci/local-soak/args.mjs";
import { buildSoakEntities, SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../../scripts/ci/local-soak/entities.mjs";
import { SeededRandom, deriveSeed } from "../../scripts/ci/local-soak/prng.mjs";
import {
  generatePatch,
  generateRow,
  planActorOperation,
  sharedEntityId,
} from "../../scripts/ci/local-soak/operations.mjs";
import { SoakOracle } from "../../scripts/ci/local-soak/oracle.mjs";
import type { OracleFieldSpec } from "../../scripts/ci/local-soak/oracle.d.mts";
import { createTypedSheets, type HikouteiEntity } from "../../src/index.js";
import { resetHikouteiInternalLoggerForTests } from "@hikoutei/sync-engine/shared/observability/internalLog.js";

/**
 * True when the platform can create symlinks (used to skip the symlink
 * rejection regression tests on filesystems that cannot).
 */
export const SYMLINK_SUPPORTED = (() => {
  const probeDir = mkdtempSync(path.join(tmpdir(), "soak-runner-symlink-probe-"));
  try {
    const target = path.join(probeDir, "target.txt");
    writeFileSync(target, "probe", "utf8");
    symlinkSync(target, path.join(probeDir, "link.txt"));
    return existsSync(path.join(probeDir, "link.txt"));
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

/**
 * Stateful fake Google Sheets SDK client for the live-mode resume tests.
 *
 * Tracks the tabs sync provisioning creates (title + allocated sheet id) so
 * a SECOND live runtime open on the same SQLite registry sees the same

 * and the registry allowlist check would reject the open. Every tab is
 * empty (no header rows), so provisioning treats existing tabs as
 * "truly empty" and initializes their headers; live convergence/probe
 * phases then fail deterministically within the run budget (no request
 * hangs). Enumeration/properties reads list the stored tabs; grid reads
 * return their (empty) grids; value reads return stored rows.
 */
export const liveSoakSheetsClient = (() => {
  const tabs = new Map<string, { readonly sheetId: number; readonly rows: string[][] }>();
  let nextSheetId = 1;
  return {
    spreadsheets: {
      get: async (params: { fields?: string; ranges?: string[] }) => {
        const fields = params?.fields ?? "";
        const requestedTabs = (params?.ranges ?? []).map((range) =>
          range.replace(/^'/, "").split("!")[0]?.replace(/'$/, "") ?? "");
        const sheetEntries = requestedTabs
          .map((title) => {
            const tab = tabs.get(title);
            return tab === undefined ? undefined : { title, tab };
          })
          .filter((entry): entry is { title: string; tab: { readonly sheetId: number; readonly rows: string[][] } } => entry !== undefined);
        if (fields.includes("formattedValue")) {
          return {
            data: {
              sheets: sheetEntries.map(({ title, tab }) => ({
                properties: { sheetId: tab.sheetId, title },
                data: [{
                  startRow: 0,
                  startColumn: 0,
                  rowData: tab.rows.map((row) => ({
                    values: row.map((formattedValue) => ({ formattedValue })),
                  })),
                }],
              })),
            },
          };
        }
        if (fields.includes("data(")) {
          // Grid reads (provisioning/observation): stored tabs return
          // their grids so provisioning sees "truly empty" existing tabs.
          return {
            data: {
              sheets: sheetEntries.map(({ title, tab }) => ({
                properties: { sheetId: tab.sheetId, title },
                data: [{
                  startRow: 0,
                  startColumn: 0,
                  rowData: tab.rows.map((row) => ({
                    values: row.map((value) => ({ userEnteredValue: { stringValue: value } })),
                  })),
                }],
              })),
            },
          };
        }
        // Enumeration/properties reads: every tab known to this fake
        // spreadsheet, so provisioning reuses the stored physical ids.
        return {
          data: {
            sheets: [...tabs.entries()].map(([title, tab]) => ({
              properties: { sheetId: tab.sheetId, title },
            })),
          },
        };
      },
      batchUpdate: async (params: {
        requestBody?: {
          requests?: Array<{
            addSheet?: { properties?: { title?: string } };
          }>;
        };
      }) => {
        const requests = params?.requestBody?.requests ?? [];
        return {
          data: {
            replies: requests.map((request) => {
              if (request?.addSheet === undefined) return {};
              const title = request.addSheet.properties?.title ?? `sheet-${nextSheetId}`;
              let tab = tabs.get(title);
              if (tab === undefined) {
                tab = { sheetId: nextSheetId++, rows: [] };
                tabs.set(title, tab);
              }
              return { addSheet: { properties: { sheetId: tab.sheetId } } };
            }),
          },
        };
      },
    },
  };
})();

/**
 * Opt-in gate for the genuinely long soak/recovery suites in this file.
 *
 * Every group below that drives the real `runLocalMultiTableSoak` loop
 * (including the 60-cycle reopen cadence and resume/recovery paths) crosses
 * real SQLite/runtime opens and takes minutes in aggregate, which made a
 * plain Vitest run of this file time out. These groups are registered with
 * `describeLongSoak` and only execute when `SOAK_RUNNER_LONG=1` (see the
 * `test:soak` package script, which sets the flag portably across POSIX
 * and Windows shells through the `scripts/run-soak-long.mjs` launcher):
 *
 *   npm run test:soak
 *   SOAK_RUNNER_LONG=1 npx vitest run test/soak-runner.test.ts
 *
 * Focused/unit convergence, tombstone, batching, readiness, and
 * security/redaction asserts stay in the default `npm test` suite below; no
 * soak coverage is ever silently dropped, it is opt-in.
 */
export const describeLongSoak: ReturnType<typeof describe.runIf> = describe.runIf(
  process.env.SOAK_RUNNER_LONG === "1",
);

/** Short budget (0.003h) that comfortably crosses the cycle-60 reopen. */
export const SHORT_DURATION_HOURS = 0.003;

let dir: string | undefined;

/**
 * Creates the shared per-file temp dir. Mirrors the original top-level
 * `beforeAll` so each split file re-registers it with identical semantics
 * (one temp dir per test file).
 */
export async function soakTestBeforeAll(): Promise<void> {
  dir = await mkdtemp(path.join(tmpdir(), "soak-runner-"));
}

/**
 * Drops the cached runtime log singleton. Mirrors the original top-level
 * `beforeEach` (the runtime log file resolves lazily from process.env on
 * first use; the runner pins a per-run log path per process).
 */
export function soakTestBeforeEach(): void {
  resetHikouteiInternalLoggerForTests();
}

/** Clears runner-pinned log env vars. Mirrors the original `afterEach`. */
export function soakTestAfterEach(): void {
  delete process.env.HIKOUTEI_LOG_FILE;
  delete process.env.HIKOUTEI_LOG_LEVEL;
}

/** Removes the shared per-file temp dir. Mirrors the original `afterAll`. */
export async function soakTestAfterAll(): Promise<void> {
  if (dir !== undefined) {
    await rm(dir, { recursive: true, force: true });
    dir = undefined;
  }
}


export function requireDir(): string {
  return dir ?? (() => { throw new Error("soak-runner beforeAll must create the temp dir"); })();
}

export function shortOptions(overrides = {}) {
  const root = requireDir();
  return finalizeOptions({
    durationHours: SHORT_DURATION_HOURS,
    intervalSeconds: 0,
    actors: 2,
    operationsPerActor: 4,
    maxConsecutiveFailures: 3,
    seed: "0x5a0b",
    outputDir: path.join(root, "run-1"),
    ...overrides,
  });
}

/** Minimal VALID resume state fixture (local mode, one table). */
export function validResumeStateFixture() {
  return {
    version: 1,
    runId: "soak-abcd",
    seed: 20260814,
    mode: "local",
    startedAtMs: Date.now(),
    params: {
      seed: 20260814,
      durationMs: 7_200_000,
      intervalSeconds: 0,
      actors: 2,
      operationsPerActor: 4,
      resolvedTables: ["soak_tasks"],
      maxConsecutiveFailures: 5,
    },
    lastCompletedCycle: 3,
    cumulative: {
      operations: 96,
      expectedErrors: 0,
      failures: 0,
      retries: 0,
      probes: { total: 0, ok: 0, skipped: 0, failed: 0 },
      convergenceChecks: 0,
      convergenceFailed: 0,
    },
    tableRows: { soak_tasks: 4 },
  };
}

/**
 * Writes a shape-valid service-account credentials file so a live-mode
 * resume can pass the sync auto-start credentials boundary (the Google SDK
 * is mocked in this file, so no network or real credentials are involved).
 */
export async function writeSoakCredentialsFile(): Promise<string> {
  const credentialsPath = path.join(requireDir(), "soak-service-account.json");
  await writeFile(credentialsPath, JSON.stringify({
    type: "service_account",
    project_id: "soak-test",
    private_key_id: "k1",
    private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
    client_email: "soak@example.com",
    client_id: "1",
    token_uri: "https://oauth2.googleapis.com/token",
  }), "utf8");
  return credentialsPath;
}

/**
 * Plants one field value into the run's SQLite authority through the
 * PUBLIC EntityManager (no raw SQL), so the exact DB proof sees it.
 */
export async function plantSqliteValue(
  runDir: string,
  entry: { readonly name: string; readonly tableName: string },
  id: string,
  field: string,
  value: string,
): Promise<void> {
  const { tokens } = buildSoakEntities();
  const runtime = await createTypedSheets({
    dbName: path.join(runDir, "soak.sqlite"),
    entities: [...tokens] as unknown as readonly HikouteiEntity[],
  });
  try {
    const em = runtime.em.fork();
    const token = tokens[SOAK_ENTITY_ORDER.indexOf(entry)] as unknown as HikouteiEntity<{ id: string } & Record<string, unknown>>;
    const row = await em.findOne(token, { id });
    expect(row).not.toBeNull();
    if (row === null) throw new Error(`row ${id} not found in ${entry.tableName}`);
    (row as Record<string, unknown>)[field] = value;
    await em.flush();
  } finally {
    await runtime.close();
  }
}

/**
 * Plants several field values into the run's SQLite authority through the
 * PUBLIC EntityManager in ONE runtime session (no raw SQL), so the exact
 * DB proof sees them. Used to plant the deterministic human-edit evidence
 * for every ok probe of a fabricated live history.
 */
export async function plantSqliteValues(
  runDir: string,
  values: Array<{
    entry: { readonly name: string; readonly tableName: string };
    id: string;
    field: string;
    value: string;
  }>,
): Promise<void> {
  if (values.length === 0) return;
  const { tokens } = buildSoakEntities();
  const runtime = await createTypedSheets({
    dbName: path.join(runDir, "soak.sqlite"),
    entities: [...tokens] as unknown as readonly HikouteiEntity[],
  });
  try {
    const em = runtime.em.fork();
    for (const { entry, id, field, value } of values) {
      const entryIndex = SOAK_ENTITY_ORDER.findIndex((candidate) => candidate.name === entry.name);
      const token = tokens[entryIndex] as unknown as HikouteiEntity<{ id: string } & Record<string, unknown>>;
      const row = await em.findOne(token, { id });
      expect(row).not.toBeNull();
      if (row === null) throw new Error(`row ${id} not found in ${entry.tableName}`);
      (row as Record<string, unknown>)[field] = value;
    }
    await em.flush();
  } finally {
    await runtime.close();
  }
}

/**
 * Deterministic human-edit evidence values for every ok probe of a
 * fabricated live history: one (cycle, target, field, main-id, value) per
 * probe-cadence cycle that carries an ok probe section. Mirrors the
 * runner's exact probe rotation and value grammar.
 */
export async function plantedProbeEvidence(
  runDir: string,
  maxCycle: number,
): Promise<Array<{
  entry: { readonly name: string; readonly tableName: string };
  id: string;
  field: string;
  value: string;
}>> {
  const state = JSON.parse(await readFile(path.join(runDir, "state.json"), "utf8")) as {
    seed: number;
  };
  const seed = state.seed;
  const cyclesPath = path.join(runDir, "cycles.jsonl");
  const lines = (await readFile(cyclesPath, "utf8")).trim().split("\n");
  const evidence = [];
  for (const line of lines) {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.abort !== undefined) continue;
    const probe = record.probe as { status?: string } | undefined;
    if (probe?.status !== "ok") continue;
    const cycle = record.cycle as number;
    if (cycle > maxCycle) continue;
    const target = SOAK_ENTITY_ORDER[Math.floor(cycle / 10) % SOAK_ENTITY_ORDER.length]!;
    evidence.push({
      entry: target,
      id: sharedEntityId(target.name, cycle, "main"),
      field: deterministicProbeField(seed, target, cycle),
      value: `human-edit-c${cycle}`,
    });
  }
  return evidence;
}

/**
 * Creates ONE new row in the run's SQLite authority through the PUBLIC
 * EntityManager (no raw SQL), exactly like the interrupted run's own
 * committed work would have.
 */
export async function plantNewRow(
  runDir: string,
  entry: { readonly name: string; readonly tableName: string },
  row: Record<string, unknown>,
): Promise<void> {
  const { tokens } = buildSoakEntities();
  const runtime = await createTypedSheets({
    dbName: path.join(runDir, "soak.sqlite"),
    entities: [...tokens] as unknown as readonly HikouteiEntity[],
  });
  try {
    const em = runtime.em.fork();
    // Resolve the token by NAME: callers pass `{ name, tableName }`
    // literals that are not the SOAK_ENTITY_ORDER elements themselves.
    const entryIndex = SOAK_ENTITY_ORDER.findIndex((candidate) => candidate.name === entry.name);
    const token = tokens[entryIndex] as unknown as HikouteiEntity<{ id: string } & Record<string, unknown>>;
    em.persist(em.create(token, row));
    await em.flush();
  } finally {
    await runtime.close();
  }
}

/**
 * Deterministic FIRST forkIsolation operation of the soak workload.
 *
 * Replays the runner's exact deterministic generator (sequential prologue
 * + up-front actor planning + per-op final-state application) from the
 * stored seed/params and returns the first planned forkIsolation op with
 * its two committed-stage candidates: the PRE-PATCH row (the valid
 * committed state when the process died between the op's create flush and
 * its patch flush) and the POST-PATCH row (the completed stage). The scan
 * is a pure function of (seed, actors, operationsPerActor) — identical to
 * the runner's own replay, so the op the test plants is the exact op the
 * resumed run expects for that cycle.
 */
export function deterministicForkIsolationStage(
  seed: number,
  actors: number,
  opsPerActor: number,
): {
  readonly cycle: number;
  readonly entityName: string;
  readonly tableName: string;
  readonly mutateId: string;
  readonly prePatchRow: Record<string, unknown>;
  readonly postPatchRow: Record<string, unknown>;
} {
  const oracle = new SoakOracle(SOAK_FIELD_PLANS as Record<string, Record<string, OracleFieldSpec>>);
  for (let cycle = 1; ; cycle += 1) {
    for (let tableIndex = 0; tableIndex < SOAK_ENTITY_ORDER.length; tableIndex += 1) {
      const entry = SOAK_ENTITY_ORDER[tableIndex]!;
      const fieldPlan = SOAK_FIELD_PLANS[entry.name]!;
      const rng = new SeededRandom(deriveSeed(seed, cycle * 7919 + tableIndex));
      const mainId = sharedEntityId(entry.name, cycle, "main");
      const churnId = sharedEntityId(entry.name, cycle, "churn");
      const mainRow = { id: mainId, ...generateRow(rng, fieldPlan) };
      const churnRow = { id: churnId, ...generateRow(rng, fieldPlan) };
      const patch = generatePatch(rng, fieldPlan);
      oracle.applyMutation({ op: "insert", entity: entry.name, row: mainRow });
      oracle.applyMutation({ op: "insert", entity: entry.name, row: churnRow });
      oracle.applyMutation({ op: "update", entity: entry.name, id: mainId, patch });
      oracle.applyMutation({ op: "delete", entity: entry.name, id: churnId });
    }
    const plannedOps = [];
    for (let actor = 0; actor < actors; actor += 1) {
      for (let opIndex = 0; opIndex < opsPerActor; opIndex += 1) {
        const entry = SOAK_ENTITY_ORDER[(actor * opsPerActor + opIndex) % SOAK_ENTITY_ORDER.length]!;
        plannedOps.push(planActorOperation({
          seed,
          cycle,
          actor,
          opIndex,
          entityName: entry.name,
          fieldPlan: SOAK_FIELD_PLANS[entry.name]!,
          oracle,
        }));
      }
    }
    for (const op of plannedOps) {
      if (op.kind === "forkIsolation") {
        const prePatchRow = { id: op.mutateId, ...op.row };
        const postPatchRow = { ...prePatchRow, ...op.patch };
        const entry = SOAK_ENTITY_ORDER.find((candidate) => candidate.name === op.entityName)!;
        return {
          cycle,
          entityName: op.entityName,
          tableName: entry.tableName,
          mutateId: op.mutateId,
          prePatchRow,
          postPatchRow,
        };
      }
      applyPlannedFinalState(oracle, op);
    }
  }
}

/** Applies one planned op's deterministic FINAL state to the replay oracle. */
export function applyPlannedFinalState(
  oracle: SoakOracle,
  op: {
    readonly kind: string;
    readonly entityName: string;
    readonly mutateId: string;
    readonly row?: Record<string, unknown>;
    readonly extraRows?: Record<string, unknown>[];
    readonly patch?: Record<string, unknown>;
  },
): void {
  switch (op.kind) {
    case "create":
      oracle.applyMutation({ op: "insert", entity: op.entityName, row: { id: op.mutateId, ...op.row } });
      break;
    case "update": {
      const row: Record<string, unknown> = { ...op.patch };
      const fieldPlan = SOAK_FIELD_PLANS[op.entityName]!;
      for (const [field, spec] of Object.entries(fieldPlan)) {
        if (spec.primary || row[field] !== undefined) continue;
        row[field] = spec.type === "number" ? 0
          : spec.type === "boolean" ? false
            : spec.type === "date" ? new Date(0)
              : "init";
        if (spec.nullable && spec.type === "date") row[field] = null;
      }
      oracle.applyMutation({ op: "insert", entity: op.entityName, row: { id: op.mutateId, ...row } });
      break;
    }
    case "batchPersist":
      oracle.applyMutation({ op: "insert", entity: op.entityName, row: { id: op.mutateId, ...op.row } });
      oracle.applyMutation({ op: "insert", entity: op.entityName, row: { id: `${op.mutateId}-x0`, ...op.extraRows?.[0] } });
      oracle.applyMutation({ op: "insert", entity: op.entityName, row: { id: `${op.mutateId}-x1`, ...op.extraRows?.[1] } });
      break;
    case "transactionalCommit":
      oracle.applyMutation({ op: "insert", entity: op.entityName, row: { id: op.mutateId, ...op.row } });
      break;
    case "forkIsolation":
      oracle.applyMutation({ op: "insert", entity: op.entityName, row: { id: op.mutateId, ...op.row, ...op.patch } });
      break;
    default:
      break; // read-only / rolled-back / delete kinds leave no row
  }
}

/**
 * Deterministic editable string field the runner's probe would pick for
 * one cycle (the same rng/rotation as runHumanEditProbe).
 */
export function deterministicProbeField(
  seed: number,
  entry: { readonly name: string },
  cycle: number,
): string {
  const fieldPlan = SOAK_FIELD_PLANS[entry.name]!;
  const editableFields = Object.entries(fieldPlan)
    .filter(([, spec]) => !spec.primary && spec.type === "string")
    .map(([field]) => field);
  const rng = new SeededRandom(deriveSeed(seed, cycle * 31 + 7));
  return editableFields[rng.int(editableFields.length)]!;
}
