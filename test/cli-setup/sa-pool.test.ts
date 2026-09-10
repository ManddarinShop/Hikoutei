/**
 * Unit tests for the multi-SA credential pool (`--sa-count`) in
 * `hikoutei setup`.
 *
 * Same fake-runner pattern as the other setup suites: a recording gcloud
 * runner (with per-service-account key state and a key-file side effect),
 * a fake tokeninfo validator, a fake human-token sheet API, and a fake SA
 * verifier — nothing touches gcloud, the network, or real Google
 * resources.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_SETUP_SA_COUNT,
  parseSetupArgs,
  SETUP_HELP_TEXT,
} from "@hikoutei/cli/args.js";
import {
  checkStateCompatibility,
  loadSetupState,
  saveSetupState,
  serviceAccountEmail,
  SETUP_STATE_FILE_NAME,
  SETUP_STATE_VERSION,
  validateSetupState,
  type SetupState,
} from "@hikoutei/cli/checkpoint.js";
import { SETUP_ERROR_CODES } from "@hikoutei/cli/errors.js";
import type { GcloudRunner, GcloudRunResult } from "@hikoutei/cli/gcloudRunner.js";
import { DRIVE_SCOPE, type TokenValidator } from "@hikoutei/cli/humanAuth.js";
import type { SaAccessVerifier } from "@hikoutei/cli/saVerify.js";
import {
  POOL_EXPANSION_PHASE,
  SETUP_PROGRESS_PHASE_COUNT,
  SetupProgressTracker,
  type SetupProgressEvent,
} from "@hikoutei/cli/setupProgress.js";
import type {
  HumanSheetApiFactory,
  MarkerFileInfo,
  ShareOutcome,
} from "@hikoutei/cli/sheetsFactory.js";
import { spreadsheetEditUrl } from "@hikoutei/cli/sheetsFactory.js";
import {
  DEFAULT_KEY_FILE_NAME,
  formatSummary,
  poolKeyPath,
  resolveSaCountForSetup,
  runSetup,
  SA_COUNT_PROMPT,
  SETUP_ENV_KEYS,
  writeSetupEnvFile,
  type RunSetupOptions,
  type SetupResult,
  type SetupSummary,
} from "@hikoutei/cli/setupFlow.js";
import { runSetupCli, type RunSetupCallable } from "@hikoutei/cli/setup.js";

import {
  tempDirs,
  makeTempDir,
  FAKE_TOKEN,
  FAKE_OWNER,
  FIXED_KEY_ID,
  validKeyJson,
  keyResourceName,
  expectError,
} from "../support/cliSetupHarness.js";

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("parseSetupArgs --sa-count", () => {
  it("leaves saCount absent by default (default 1, never prompts downstream)", () => {
    const result = parseSetupArgs([]);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.options.saCount).toBeUndefined();
      expect("saCount" in result.options).toBe(false);
    }
  });

  it("accepts 1..10 in both --flag value and --flag=value forms", () => {
    for (const argv of [["--sa-count", "1"], ["--sa-count", "10"], ["--sa-count=3"]]) {
      const result = parseSetupArgs(argv);
      expect(result.status).toBe("valid");
      if (result.status === "valid") {
        expect(result.options.saCount).toBe(Number(argv[argv.length - 1]?.split("=").pop()));
      }
    }
  });

  it("rejects 0, negative, non-integer, and non-numeric values with invalid_args", () => {
    for (const argv of [
      ["--sa-count", "0"],
      ["--sa-count", "-2"],
      ["--sa-count", "2.5"],
      ["--sa-count", "abc"],
      ["--sa-count", ""],
    ]) {
      const result = parseSetupArgs(argv);
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.failure.code).toBe(SETUP_ERROR_CODES.INVALID_ARGS);
      }
    }
  });

  it("rejects values above the cap with the quota-exhaustion usage error", () => {
    const result = parseSetupArgs(["--sa-count", "11"]);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.failure.code).toBe(SETUP_ERROR_CODES.INVALID_ARGS);
      expect(result.failure.message).toBe(
        `sa-count is capped at ${MAX_SETUP_SA_COUNT} to avoid accidental quota exhaustion`,
      );
    }
    expect(MAX_SETUP_SA_COUNT).toBe(10);
  });

  it("documents --sa-count in the help text", () => {
    expect(SETUP_HELP_TEXT).toContain("--sa-count");
    expect(SETUP_HELP_TEXT).toContain("HIKOUTEI_SYNC_CREDENTIALS");
    expect(SETUP_HELP_TEXT).toContain("never removed");
  });
});

describe("resolveSaCountForSetup (interactive prompt)", () => {
  /** Reader over a scripted line queue; records prompt writes. */
  function scriptedReader(lines: ReadonlyArray<string | null>): {
    readLine: () => Promise<string | null>;
    prompts: () => number;
  } {
    let reads = 0;
    let prompts = 0;
    return {
      readLine: async () => {
        reads += 1;
        return lines[Math.min(reads - 1, lines.length - 1)] ?? null;
      },
      prompts: () => prompts,
    };
  }

  it("never prompts with --yes, --dry-run, non-TTY, or an explicit flag", async () => {
    const throwing = (): Promise<string | null> => {
      throw new Error("must not prompt");
    };
    for (const options of [
      { saCount: undefined, yes: true, dryRun: false, isTTY: true },
      { saCount: undefined, yes: false, dryRun: true, isTTY: true },
      { saCount: undefined, yes: false, dryRun: false, isTTY: false },
      { saCount: 3, yes: false, dryRun: false, isTTY: true },
      { saCount: 1, yes: false, dryRun: false, isTTY: true },
    ]) {
      const resolved = await resolveSaCountForSetup({ ...options, readLine: throwing });
      expect(resolved).toStrictEqual({ status: "ok", saCount: options.saCount ?? 1 });
    }
  });

  it("treats empty input and end-of-input as 1", async () => {
    for (const lines of [[""], ["   "], [null]]) {
      const writes: string[] = [];
      const reader = scriptedReader(lines);
      const resolved = await resolveSaCountForSetup({
        saCount: undefined,
        yes: false,
        dryRun: false,
        isTTY: true,
        write: (text) => writes.push(text),
        readLine: reader.readLine,
      });
      expect(resolved).toStrictEqual({ status: "ok", saCount: 1 });
      expect(writes).toStrictEqual([SA_COUNT_PROMPT]);
    }
    expect(SA_COUNT_PROMPT).toBe("Service accounts to create? [1]: ");
  });

  it("accepts a valid count on the first answer", async () => {
    const writes: string[] = [];
    const reader = scriptedReader(["3"]);
    const resolved = await resolveSaCountForSetup({
      saCount: undefined,
      yes: false,
      dryRun: false,
      isTTY: true,
      write: (text) => writes.push(text),
      readLine: reader.readLine,
    });
    expect(resolved).toStrictEqual({ status: "ok", saCount: 3 });
    expect(writes).toStrictEqual([SA_COUNT_PROMPT]);
  });

  it("re-asks once after invalid input, then accepts a valid answer", async () => {
    const writes: string[] = [];
    const reader = scriptedReader(["banana", "2"]);
    const resolved = await resolveSaCountForSetup({
      saCount: undefined,
      yes: false,
      dryRun: false,
      isTTY: true,
      write: (text) => writes.push(text),
      readLine: reader.readLine,
    });
    expect(resolved).toStrictEqual({ status: "ok", saCount: 2 });
    expect(writes).toStrictEqual([SA_COUNT_PROMPT, SA_COUNT_PROMPT]);
  });

  it("fails with a usage error after two invalid answers", async () => {
    const reader = scriptedReader(["0", "99"]);
    const resolved = await resolveSaCountForSetup({
      saCount: undefined,
      yes: false,
      dryRun: false,
      isTTY: true,
      write: () => undefined,
      readLine: reader.readLine,
    });
    expect(resolved.status).toBe("invalid");
    if (resolved.status === "invalid") {
      expect(resolved.failure.code).toBe(SETUP_ERROR_CODES.INVALID_ARGS);
    }
  });

  it("fails closed on invalid input followed by end-of-input (no silent default)", async () => {
    const writes: string[] = [];
    const reader = scriptedReader(["banana", null]);
    const resolved = await resolveSaCountForSetup({
      saCount: undefined,
      yes: false,
      dryRun: false,
      isTTY: true,
      write: (text) => writes.push(text),
      readLine: reader.readLine,
    });
    expect(resolved.status).toBe("invalid");
    if (resolved.status === "invalid") {
      expect(resolved.failure.code).toBe(SETUP_ERROR_CODES.INVALID_ARGS);
    }
    expect(writes).toStrictEqual([SA_COUNT_PROMPT, SA_COUNT_PROMPT]);
  });
});

describe("writeSetupEnvFile credential pool", () => {
  it("writes no pool line for a single-SA run", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    const result = writeSetupEnvFile(outputPath, "/tmp/key.json", "https://docs.google.com/spreadsheets/d/abc/edit");
    expect(result).toStrictEqual({ created: true, modified: true });
    expect(readFileSync(outputPath, "utf8")).toBe(
      `${SETUP_ENV_KEYS.CREDENTIALS}=/tmp/key.json\n${SETUP_ENV_KEYS.SPREADSHEET_URL}=https://docs.google.com/spreadsheets/d/abc/edit\n`,
    );
    expect(readFileSync(outputPath, "utf8")).not.toContain("HIKOUTEI_SYNC_CREDENTIALS");
  });

  it("writes a comma-joined pool line with no spaces for N=3", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    const pool = ["/tmp/k1.json", "/tmp/k2.json", "/tmp/k3.json"];
    writeSetupEnvFile(outputPath, pool[0] as string, "https://docs.google.com/spreadsheets/d/abc/edit", [], pool);
    expect(readFileSync(outputPath, "utf8")).toBe(
      `${SETUP_ENV_KEYS.CREDENTIALS}=/tmp/k1.json\n` +
        `${SETUP_ENV_KEYS.SPREADSHEET_URL}=https://docs.google.com/spreadsheets/d/abc/edit\n` +
        `${SETUP_ENV_KEYS.CREDENTIAL_POOL}=/tmp/k1.json,/tmp/k2.json,/tmp/k3.json\n`,
    );
    // Idempotent: the same content is not rewritten.
    const second = writeSetupEnvFile(
      outputPath,
      pool[0] as string,
      "https://docs.google.com/spreadsheets/d/abc/edit",
      [],
      pool,
    );
    expect(second).toStrictEqual({ created: false, modified: false });
  });

  it("removes a stale pool line on a single-SA rewrite", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    writeFileSync(
      outputPath,
      `${SETUP_ENV_KEYS.CREDENTIALS}=/tmp/k1.json\n${SETUP_ENV_KEYS.CREDENTIAL_POOL}=/tmp/k1.json,/tmp/k2.json\n`,
      "utf8",
    );
    const result = writeSetupEnvFile(
      outputPath,
      "/tmp/k1.json",
      "https://docs.google.com/spreadsheets/d/abc/edit",
    );
    expect(result.modified).toBe(true);
    expect(readFileSync(outputPath, "utf8")).not.toContain("HIKOUTEI_SYNC_CREDENTIALS");
  });
});

describe("checkpoint credential pool", () => {
  /** Minimal complete state for a project; pool added via overrides. */
  function completeState(projectId: string, overrides: Record<string, unknown> = {}): SetupState {
    return {
      version: SETUP_STATE_VERSION,
      status: "complete",
      projectId,
      projectMode: "generated",
      ownerEmail: FAKE_OWNER,
      saName: "hikoutei-sa",
      saEmail: serviceAccountEmail("hikoutei-sa", projectId),
      keyPath: "/tmp/hikoutei-service-account.json",
      spreadsheetTitle: `hikoutei-sync-${projectId}`,
      spreadsheetId: "sheet-1",
      keyOrigin: "created",
      shareOrigin: "fresh",
      ...overrides,
    } as SetupState;
  }

  function poolEntry(projectId: string, index: number): { saName: string; saEmail: string; keyPath: string } {
    const saName = index === 1 ? "hikoutei-sa" : `hikoutei-sa-${index}`;
    return {
      saName,
      saEmail: serviceAccountEmail(saName, projectId),
      keyPath: index === 1 ? "/tmp/hikoutei-service-account.json" : `/tmp/hikoutei-service-account-${index}.json`,
    };
  }

  it("round-trips a pool through save/load", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    const projectId = "pool-proj";
    const state = completeState(projectId, { pool: [poolEntry(projectId, 1), poolEntry(projectId, 2)] });
    saveSetupState(statePath, state);
    const loaded = loadSetupState(statePath);
    expect(loaded.status).toBe("loaded");
    if (loaded.status === "loaded") {
      expect(loaded.state).toStrictEqual(state);
    }
  });

  it("keeps single-SA checkpoints unchanged (no pool key)", () => {
    const projectId = "pool-proj";
    const validated = validateSetupState(JSON.parse(JSON.stringify(completeState(projectId))));
    expect(validated).not.toBeNull();
    expect(validated).toStrictEqual(completeState(projectId));
    if (validated === null) return;
    expect("pool" in (validated as unknown as Record<string, unknown>)).toBe(false);
  });

  it("rejects empty pools, foreign emails, entry-1 mismatches, and pre-complete pools", () => {
    const projectId = "pool-proj";
    expect(validateSetupState(completeState(projectId, { pool: [] }))).toBeNull();
    expect(
      validateSetupState(
        completeState(projectId, {
          pool: [poolEntry(projectId, 1), { ...poolEntry(projectId, 2), saEmail: "evil@x.iam.gserviceaccount.com" }],
        }),
      ),
    ).toBeNull();
    expect(
      validateSetupState(
        completeState(projectId, {
          pool: [{ ...poolEntry(projectId, 1), keyPath: "/tmp/other.json" }, poolEntry(projectId, 2)],
        }),
      ),
    ).toBeNull();
    expect(
      validateSetupState({ ...completeState(projectId), status: "spreadsheet_shared", pool: [poolEntry(projectId, 1)] }),
    ).toBeNull();
  });

  it("treats saCount as a run option: a stored pool never conflicts", () => {
    const projectId = "pool-proj";
    const validated = validateSetupState(
      completeState(projectId, { pool: [poolEntry(projectId, 1), poolEntry(projectId, 2)] }),
    );
    expect(validated).not.toBeNull();
    if (validated === null) return;
    // Compatibility has no saCount input at all: fewer, equal, or more
    // accounts all resume against the stored pool.
    expect(
      checkStateCompatibility(validated, {
        projectId: undefined,
        saName: "hikoutei-sa",
        spreadsheetTitle: undefined,
        keyPath: "/tmp/hikoutei-service-account.json",
        ownerEmail: FAKE_OWNER,
      }),
    ).toStrictEqual({ status: "ok" });
  });
});

describe("poolKeyPath", () => {
  it("mirrors the primary naming next to the primary path", () => {
    expect(poolKeyPath("/tmp/hikoutei-service-account.json", 2)).toBe("/tmp/hikoutei-service-account-2.json");
    expect(poolKeyPath("/tmp/custom-key.json", 10)).toBe("/tmp/custom-key-10.json");
    expect(poolKeyPath("/tmp/extensionless", 2)).toBe("/tmp/extensionless-2");
  });
});

/** Mutable per-SA cloud state for the pool fake runner. */
interface PoolFakeCloud {
  readonly serviceAccounts: Set<string>;
  readonly keys: Set<string>;
}

function createPoolRunner(cloud: PoolFakeCloud): {
  runner: GcloudRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const projectOf = (args: readonly string[]): string => {
    const index = args.indexOf("--project");
    return args[index + 1] as string;
  };
  const runner: GcloudRunner = {
    async run(args: readonly string[], options?: { readonly cwd?: string }): Promise<GcloudRunResult> {
      calls.push([...args]);
      if (args[0] === "--version") {
        return { status: "ok", stdout: "Google Cloud SDK 500.0.0\n", stderr: "" };
      }
      if (args[0] === "auth" && args[1] === "list") {
        return { status: "ok", stdout: `${FAKE_OWNER}\n`, stderr: "" };
      }
      if (args[0] === "auth" && args[1] === "print-access-token") {
        return { status: "ok", stdout: `${FAKE_TOKEN}\n`, stderr: "" };
      }
      if (args[0] === "projects" && args[1] === "describe") {
        return { status: "ok", stdout: "", stderr: "" };
      }
      if (args[0] === "iam" && args[1] === "service-accounts" && args[2] === "list") {
        return { status: "ok", stdout: [...cloud.serviceAccounts].join("\n"), stderr: "" };
      }
      if (args[0] === "iam" && args[1] === "service-accounts" && args[2] === "create") {
        const name = args[3] as string;
        cloud.serviceAccounts.add(serviceAccountEmail(name, projectOf(args)));
        return { status: "ok", stdout: "", stderr: "" };
      }
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "list") {
        const email = args[args.indexOf("--iam-account") + 1] as string;
        const names = [...cloud.keys].filter((name) => name.includes(`/serviceAccounts/${email}/`));
        return { status: "ok", stdout: names.length === 0 ? "" : `${names.join("\n")}\n`, stderr: "" };
      }
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
        const email = args[args.indexOf("--iam-account") + 1] as string;
        const projectId = projectOf(args);
        const destination =
          options?.cwd === undefined ? (args[4] as string) : join(options.cwd, args[4] as string);
        writeFileSync(destination, validKeyJson(projectId, email, FIXED_KEY_ID), "utf8");
        cloud.keys.add(keyResourceName(projectId, email, FIXED_KEY_ID));
        return { status: "ok", stdout: "", stderr: "" };
      }
      return { status: "ok", stdout: "", stderr: "" };
    },
  };
  return { runner, calls };
}

/** Records shares/verifies across pool runs; fails shares for listed emails. */
interface PoolHarness {
  readonly keyPath: string;
  readonly outputPath: string;
  readonly statePath: string;
  readonly calls: string[][];
  readonly shares: { readonly saEmail: string }[];
  readonly verifyCalls: { readonly keyPath: string; readonly keyFresh: boolean; readonly shareFresh: boolean }[];
  readonly events: SetupProgressEvent[];
  failShareFor: Set<string>;
  run(options?: Partial<RunSetupOptions>): Promise<SetupResult>;
}

function createPoolHarness(dir: string, cloud: PoolFakeCloud): PoolHarness {
  const keyPath = join(dir, DEFAULT_KEY_FILE_NAME);
  const outputPath = join(dir, ".env");
  const statePath = join(dir, SETUP_STATE_FILE_NAME);
  const { runner, calls } = createPoolRunner(cloud);
  const harness: PoolHarness = {
    keyPath,
    outputPath,
    statePath,
    calls,
    shares: [],
    verifyCalls: [],
    events: [],
    failShareFor: new Set<string>(),
    run(options = {}) {
      const eventsSink = {
        report: (event: SetupProgressEvent): void => {
          harness.events.push(event);
        },
      };
      const validateToken: TokenValidator = {
        async validate() {
          return { email: FAKE_OWNER, scope: DRIVE_SCOPE };
        },
      };
      const granted = new Set<string>();
      const createHumanApi: HumanSheetApiFactory = () => ({
        async createSpreadsheet() {
          return { spreadsheetId: "pool-sheet-1" };
        },
        async findSpreadsheetByMarker(): Promise<readonly MarkerFileInfo[]> {
          return [];
        },
        async ensureSaWriter(request: { spreadsheetId: string; saEmail: string; ownerEmail: string }): Promise<ShareOutcome> {
          if (harness.failShareFor.has(request.saEmail)) {
            throw new Error("share failed");
          }
          harness.shares.push({ saEmail: request.saEmail });
          const outcome: ShareOutcome = granted.has(request.saEmail) ? { writerRole: "reused" } : { writerRole: "created" };
          granted.add(request.saEmail);
          return outcome;
        },
      });
      const verifySaAccess: SaAccessVerifier = {
        async verify(request): Promise<void> {
          harness.verifyCalls.push({
            keyPath: request.keyPath,
            keyFresh: request.keyFresh,
            shareFresh: request.shareFresh,
          });
        },
      };
      return runSetup({
        runner,
        validateToken,
        createHumanApi,
        verifySaAccess,
        projectId: "pool-proj",
        saName: "hikoutei-sa",
        spreadsheetTitle: undefined,
        keyPath,
        outputPath,
        statePath,
        dryRun: false,
        progress: eventsSink,
        sleeper: { async sleep(): Promise<void> {} },
        ...options,
      });
    },
  };
  return harness;
}

/** Emails referenced by gcloud key commands (create/list carry --iam-account). */
function keyCommandEmails(calls: readonly string[][]): string[] {
  return calls
    .filter((c) => c[0] === "iam" && c[2] === "keys")
    .map((c) => c[c.indexOf("--iam-account") + 1] as string);
}

describe("runSetup credential pool flow", () => {
  it("N=1 (default) writes no pool key, no pool env line, and no pool progress", async () => {
    const dir = makeTempDir();
    const harness = createPoolHarness(dir, { serviceAccounts: new Set(), keys: new Set() });
    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(result.summary.poolSize).toBe(1);
    expect(result.summary.poolPaths).toStrictEqual([harness.keyPath]);
    const state = JSON.parse(readFileSync(harness.statePath, "utf8")) as Record<string, unknown>;
    expect("pool" in state).toBe(false);
    expect(readFileSync(harness.outputPath, "utf8")).not.toContain("HIKOUTEI_SYNC_CREDENTIALS");
    expect(harness.events.some((e) => e.type === "phase_started" && e.phase === POOL_EXPANSION_PHASE)).toBe(false);
  });

  it("N=3 provisions 3 SAs/keys/shares/verifies and writes the pool env", async () => {
    const dir = makeTempDir();
    const harness = createPoolHarness(dir, { serviceAccounts: new Set(), keys: new Set() });
    const result = await harness.run({ saCount: 3 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;

    const primary = serviceAccountEmail("hikoutei-sa", "pool-proj");
    const second = serviceAccountEmail("hikoutei-sa-2", "pool-proj");
    const third = serviceAccountEmail("hikoutei-sa-3", "pool-proj");

    // Three service accounts created (list + create each).
    const saCreates = harness.calls.filter(
      (c) => c[0] === "iam" && c[1] === "service-accounts" && c[2] === "create",
    );
    expect(saCreates.map((c) => c[3])).toStrictEqual(["hikoutei-sa", "hikoutei-sa-2", "hikoutei-sa-3"]);
    // Three keys created, one per SA email.
    const keyCreates = harness.calls.filter((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "create");
    expect(keyCreates).toHaveLength(3);
    expect(keyCommandEmails(keyCreates)).toStrictEqual([primary, second, third]);
    // Three shares and three verifies.
    expect(harness.shares.map((s) => s.saEmail)).toStrictEqual([primary, second, third]);
    expect(harness.verifyCalls).toHaveLength(3);
    expect(harness.verifyCalls.map((v) => v.keyPath)).toStrictEqual([
      harness.keyPath,
      poolKeyPath(harness.keyPath, 2),
      poolKeyPath(harness.keyPath, 3),
    ]);
    for (const keyPath of [harness.keyPath, poolKeyPath(harness.keyPath, 2), poolKeyPath(harness.keyPath, 3)]) {
      expect(existsSync(keyPath)).toBe(true);
    }

    // Checkpoint pool: entry 1 duplicates the primary fields.
    const state = JSON.parse(readFileSync(harness.statePath, "utf8")) as {
      status: string;
      pool: { saName: string; saEmail: string; keyPath: string }[];
    };
    expect(state.status).toBe("complete");
    expect(state.pool).toStrictEqual([
      { saName: "hikoutei-sa", saEmail: primary, keyPath: harness.keyPath },
      { saName: "hikoutei-sa-2", saEmail: second, keyPath: poolKeyPath(harness.keyPath, 2) },
      { saName: "hikoutei-sa-3", saEmail: third, keyPath: poolKeyPath(harness.keyPath, 3) },
    ]);

    // Env: primary credentials plus the comma-joined pool (no spaces).
    const env = readFileSync(harness.outputPath, "utf8");
    expect(env).toBe(
      `${SETUP_ENV_KEYS.CREDENTIALS}=${harness.keyPath}\n` +
        `${SETUP_ENV_KEYS.SPREADSHEET_URL}=${spreadsheetEditUrl("pool-sheet-1")}\n` +
        `${SETUP_ENV_KEYS.CREDENTIAL_POOL}=${harness.keyPath},${poolKeyPath(harness.keyPath, 2)},${poolKeyPath(harness.keyPath, 3)}\n`,
    );

    // Summary carries the pool.
    expect(result.summary.poolSize).toBe(3);
    expect(result.summary.poolPaths).toStrictEqual([
      harness.keyPath,
      poolKeyPath(harness.keyPath, 2),
      poolKeyPath(harness.keyPath, 3),
    ]);
    const text = formatSummary(result.summary);
    expect(text).toContain("credential pool");
    expect(text).toContain("3 service accounts");

    // Progress: the pool phase ran without moving the ten-phase count.
    expect(
      harness.events.filter((e) => e.type === "phase_started" && e.phase === POOL_EXPANSION_PHASE),
    ).toHaveLength(1);
    expect(
      harness.events.filter(
        (e) => e.type === "phase_completed" && e.phase === POOL_EXPANSION_PHASE,
      ),
    ).toHaveLength(1);
    const tracker = new SetupProgressTracker();
    for (const event of harness.events) {
      tracker.apply(event);
    }
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
    expect(tracker.isComplete(POOL_EXPANSION_PHASE)).toBe(true);
  });

  it("resume mid-pool skips completed entries without redoing their cloud calls", async () => {
    const dir = makeTempDir();
    const cloud: PoolFakeCloud = { serviceAccounts: new Set(), keys: new Set() };
    const harness = createPoolHarness(dir, cloud);
    const third = serviceAccountEmail("hikoutei-sa-3", "pool-proj");
    harness.failShareFor.add(third);

    const first = await harness.run({ saCount: 3 });
    expectError(first, SETUP_ERROR_CODES.SHEET_SHARE_FAILED);
    // Entries 1..2 persisted; the primary .env (no pool line) still stands.
    const mid = JSON.parse(readFileSync(harness.statePath, "utf8")) as { pool: unknown[] };
    expect(mid.pool).toHaveLength(2);
    expect(readFileSync(harness.outputPath, "utf8")).not.toContain("HIKOUTEI_SYNC_CREDENTIALS");
    expect(harness.verifyCalls).toHaveLength(2);

    // Recover and resume: entry 2 is skipped, entry 3 completes.
    harness.failShareFor.clear();
    const callsBefore = harness.calls.length;
    const sharesBefore = harness.shares.length;
    const verifiesBefore = harness.verifyCalls.length;
    const second = await harness.run({ saCount: 3 });
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    const delta = harness.calls.slice(callsBefore);
    expect(delta.join("\n")).not.toContain("hikoutei-sa-2");
    expect(harness.shares.slice(sharesBefore).map((s) => s.saEmail)).toStrictEqual([third]);
    expect(harness.verifyCalls.slice(verifiesBefore)).toHaveLength(1);
    expect(second.summary.poolSize).toBe(3);
    expect(readFileSync(harness.outputPath, "utf8")).toContain(
      `${SETUP_ENV_KEYS.CREDENTIAL_POOL}=`,
    );
    const final = JSON.parse(readFileSync(harness.statePath, "utf8")) as { pool: unknown[] };
    expect(final.pool).toHaveLength(3);
  });

  it("resume with a smaller saCount keeps the full pool and reports kept entries", async () => {
    const dir = makeTempDir();
    const harness = createPoolHarness(dir, { serviceAccounts: new Set(), keys: new Set() });
    const first = await harness.run({ saCount: 3 });
    expect(first.status).toBe("ok");
    if (first.status !== "ok" || first.dryRun) return;
    expect(first.summary.poolSize).toBe(3);
    expect(first.summary.poolKeptEntries ?? 0).toBe(0);
    expect(formatSummary(first.summary)).not.toContain("kept:");

    // Resume asking for fewer accounts: nothing is removed, so the
    // summary reports the actual 3-account pool with the kept count.
    const second = await harness.run({ saCount: 2 });
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    expect(second.summary.poolSize).toBe(3);
    expect(second.summary.poolKeptEntries).toBe(3);
    expect(second.summary.poolPaths).toHaveLength(3);
    expect(formatSummary(second.summary)).toContain(
      "credential pool:      3 service accounts (kept: 3 existing)",
    );
    const final = JSON.parse(readFileSync(harness.statePath, "utf8")) as { pool: unknown[] };
    expect(final.pool).toHaveLength(3);
  });

  it("reuses an existing matching key file for a pool SA instead of creating", async () => {
    const dir = makeTempDir();
    const cloud: PoolFakeCloud = { serviceAccounts: new Set(), keys: new Set() };
    const harness = createPoolHarness(dir, cloud);
    // Pre-plant a valid key for SA-2 (same identity the pool would use).
    const secondEmail = serviceAccountEmail("hikoutei-sa-2", "pool-proj");
    const secondPath = poolKeyPath(harness.keyPath, 2);
    writeFileSync(secondPath, validKeyJson("pool-proj", secondEmail, FIXED_KEY_ID), "utf8");
    cloud.keys.add(keyResourceName("pool-proj", secondEmail, FIXED_KEY_ID));

    const result = await harness.run({ saCount: 2 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    // No key create for SA-2: only the primary key was created.
    const keyCreates = harness.calls.filter((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "create");
    expect(keyCreates).toHaveLength(1);
    expect(result.summary.poolSize).toBe(2);
    // The planted file was kept (reused, never overwritten).
    expect(JSON.parse(readFileSync(secondPath, "utf8")).client_email).toBe(secondEmail);
  });

  it("rejects an out-of-range saCount with invalid_args before any cloud call", async () => {
    const dir = makeTempDir();
    const harness = createPoolHarness(dir, { serviceAccounts: new Set(), keys: new Set() });
    const result = await harness.run({ saCount: 11 });
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    expect(harness.calls).toHaveLength(0);
    expect(existsSync(harness.statePath)).toBe(false);
  });
});

describe("setup progress pool phase", () => {
  /** Full ten-phase completion prefix so the pool phase may legally start. */
  function completeFixedPhases(tracker: SetupProgressTracker): void {
    const phases = [
      "cloud_auth",
      "drive_access",
      "project",
      "apis",
      "service_account",
      "service_account_key",
      "spreadsheet",
      "share",
      "sa_access",
      "output",
    ] as const;
    for (const phase of phases) {
      expect(tracker.apply({ type: "phase_started", phase })).toBe(true);
      expect(tracker.apply({ type: "phase_completed", phase, source: "run" })).toBe(true);
    }
  }

  it("accepts the pool phase after output without moving the overall count", () => {
    const tracker = new SetupProgressTracker();
    // Rejected before the fixed phases complete.
    expect(tracker.apply({ type: "phase_started", phase: POOL_EXPANSION_PHASE })).toBe(false);
    completeFixedPhases(tracker);
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
    expect(tracker.apply({ type: "phase_started", phase: POOL_EXPANSION_PHASE })).toBe(true);
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
    expect(tracker.apply({ type: "phase_completed", phase: POOL_EXPANSION_PHASE, source: "run" })).toBe(true);
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
    expect(tracker.isComplete(POOL_EXPANSION_PHASE)).toBe(true);
    // Duplicate completion is rejected.
    expect(tracker.apply({ type: "phase_completed", phase: POOL_EXPANSION_PHASE, source: "run" })).toBe(false);
  });
});

describe("runSetupCli service-account count wiring", () => {
  function capturingSink(): { write: (text: string) => void; text: () => string } {
    let text = "";
    return { write: (chunk: string) => { text += chunk; }, text: () => text };
  }

  function okSummary(): SetupSummary {
    return {
      projectId: "pool-proj",
      ownerEmail: FAKE_OWNER,
      serviceAccountEmail: serviceAccountEmail("hikoutei-sa", "pool-proj"),
      keyPath: "/tmp/hikoutei-service-account.json",
      spreadsheetId: "sheet-1",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      spreadsheetTitle: "hikoutei-sync-pool-proj",
      outputPath: "/tmp/.env",
      statePath: "/tmp/.hikoutei-setup-state.json",
      stateStatus: "complete",
      envFileCreated: true,
      envFileModified: true,
      projectReused: false,
      serviceAccountReused: false,
      keyReused: false,
      saWriterRole: "created",
      resumed: false,
      poolSize: 1,
      poolPaths: ["/tmp/hikoutei-service-account.json"],
    };
  }

  async function runCli(options: {
    saCount?: number;
    stdinChunks: readonly string[];
    isTTY: boolean;
  }): Promise<{ code: number; paramsSaCount: number | undefined; stdout: string; stderr: string }> {
    const dir = makeTempDir();
    let paramsSaCount: number | undefined;
    const runSetup: RunSetupCallable = async (params) => {
      paramsSaCount = params.saCount;
      return { status: "ok", dryRun: false, summary: okSummary(), commands: [] };
    };
    const chunks = [...options.stdinChunks];
    const stdin = {
      [Symbol.asyncIterator]: () => ({
        next: async () => (chunks.length === 0 ? { done: true as const, value: undefined } : { done: false as const, value: chunks.shift() as string }),
      }),
      isTTY: options.isTTY,
    };
    const stdout = capturingSink();
    const stderr = capturingSink();
    const code = await runSetupCli({
      options: {
        saName: "hikoutei-sa",
        ...(options.saCount !== undefined ? { saCount: options.saCount } : {}),
        output: ".env",
        yes: false,
        dryRun: false,
      },
      cwd: dir,
      runSetup,
      loginRunner: {
        async runInteractiveLogin() {
          throw new Error("login must not run");
        },
      },
      stdin,
      stdout: { ...stdout, isTTY: options.isTTY },
      stderr,
    });
    return { code, paramsSaCount, stdout: stdout.text(), stderr: stderr.text() };
  }

  it("prompts once on a TTY without --sa-count and passes the answer through", async () => {
    const result = await runCli({ stdinChunks: ["y\n", "3\n"], isTTY: true });
    expect(result.code).toBe(0);
    expect(result.paramsSaCount).toBe(3);
    expect(result.stdout).toContain("Service accounts to create?");
  });

  it("never prompts with --sa-count and passes the flag through", async () => {
    const result = await runCli({ saCount: 2, stdinChunks: ["y\n"], isTTY: true });
    expect(result.code).toBe(0);
    expect(result.paramsSaCount).toBe(2);
    expect(result.stdout).not.toContain("Service accounts to create?");
  });

  it("never prompts off-TTY and defaults to 1", async () => {
    // Off-TTY the confirmation still reads stdin (existing behavior), but
    // the count prompt never fires: the flag default (1) is used.
    const result = await runCli({ stdinChunks: ["y\n"], isTTY: false });
    expect(result.code).toBe(0);
    expect(result.paramsSaCount).toBe(1);
    expect(result.stdout).not.toContain("Service accounts to create?");
  });
});
