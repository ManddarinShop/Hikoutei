/**
 * Unit tests for the `hikoutei setup` CLI.
 *
 * Every test runs against the real production modules with an injected fake
 * gcloud runner (recording commands, returning scripted results) and a fake
 * spreadsheet creator, so nothing touches gcloud, the network, or real Google
 * resources. The fake runner simulates gcloud's key-file side effect so the
 * flow's chmod-600 step is exercised realistically.
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_OUTPUT_FILE_NAME,
  DEFAULT_SA_NAME,
  parseSetupArgs,
  SETUP_HELP_TEXT,
} from "../src/cli/args.js";
import { confirmSetup } from "../src/cli/confirm.js";
import { SETUP_ERROR_CODES } from "../src/cli/errors.js";
import type { GcloudRunner, GcloudRunResult } from "../src/cli/gcloudRunner.js";
import {
  extractSpreadsheetCreateResult,
  spreadsheetEditUrl,
  type SpreadsheetCreateRequest,
  type SpreadsheetCreator,
} from "../src/cli/sheetsFactory.js";
import {
  DEFAULT_KEY_FILE_NAME,
  defaultSpreadsheetTitle,
  formatPlan,
  formatSummary,
  generateProjectId,
  planSetupCommands,
  runSetup,
  serviceAccountEmail,
  SETUP_ENV_KEYS,
  writeSetupEnvFile,
  type PlannedCommand,
  type RunSetupOptions,
  type SetupResult,
} from "../src/cli/setupFlow.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hikoutei-setup-test-"));
  tempDirs.push(dir);
  return dir;
}

/** Fake gcloud runner that records every invocation and scripts responses. */
function createRecordingRunner(
  script?: (args: readonly string[]) => GcloudRunResult,
): { runner: GcloudRunner; calls: readonly string[][] } {
  const calls: string[][] = [];
  const runner: GcloudRunner = {
    async run(args: readonly string[]): Promise<GcloudRunResult> {
      calls.push([...args]);
      if (script !== undefined) {
        return script(args);
      }
      return { status: "ok", stdout: "", stderr: "" };
    },
  };
  return { runner, calls };
}

/** Scripted runner for a fully fresh setup (everything is created). */
function freshSetupScript(keyPath: string): (args: readonly string[]) => GcloudRunResult {
  return (args: readonly string[]): GcloudRunResult => {
    if (args[0] === "--version") {
      return { status: "ok", stdout: "Google Cloud SDK 500.0.0\n", stderr: "" };
    }
    if (args[0] === "auth") {
      return { status: "ok", stdout: "user@example.com\n", stderr: "" };
    }
    if (args[0] === "iam" && args[2] === "keys") {
      // gcloud would write the key file; simulate that side effect so the
      // flow's chmod-600 step has a real file to secure.
      writeFileSync(args[4] as string, "{\"private_key\":\"fake\"}", "utf8");
      return { status: "ok", stdout: "", stderr: "" };
    }
    return { status: "ok", stdout: "", stderr: "" };
  };
}

function failed(status: number, stderr: string): GcloudRunResult {
  return { status: "failed", code: status, stdout: "", stderr };
}

interface SetupHarness {
  readonly keyPath: string;
  readonly outputPath: string;
  readonly calls: readonly string[][];
  readonly created: SpreadsheetCreateRequest[];
  run(options?: Partial<RunSetupOptions>): Promise<SetupResult>;
}

function createHarness(dir: string, script?: (args: readonly string[]) => GcloudRunResult): SetupHarness {
  const keyPath = join(dir, DEFAULT_KEY_FILE_NAME);
  const outputPath = join(dir, ".env");
  const { runner, calls } = createRecordingRunner(script ?? freshSetupScript(keyPath));
  const created: SpreadsheetCreateRequest[] = [];
  const createSpreadsheet: SpreadsheetCreator = async (request) => {
    created.push(request);
    return {
      spreadsheetId: "spreadsheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-123/edit",
    };
  };
  return {
    keyPath,
    outputPath,
    calls,
    created,
    run(options = {}) {
      return runSetup({
        runner,
        createSpreadsheet,
        projectId: undefined,
        saName: "hikoutei-sa",
        spreadsheetTitle: undefined,
        keyPath,
        outputPath,
        dryRun: false,
        ...options,
      });
    },
  };
}

function expectError(result: SetupResult, code: string): void {
  expect(result.status).toBe("error");
  if (result.status === "error") {
    expect(result.code).toBe(code);
  }
}

function gcloudCommands(commands: readonly PlannedCommand[]): readonly string[][] {
  return commands.filter((c) => c.kind === "gcloud").map((c) => [...c.command]);
}

describe("parseSetupArgs", () => {
  it("accepts all flags with space-separated values", () => {
    const result = parseSetupArgs([
      "--project",
      "my-proj",
      "--sa-name",
      "sync-sa",
      "--spreadsheet-title",
      "My Sheet",
      "--output",
      "custom.env",
      "--yes",
      "--dry-run",
    ]);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.options).toStrictEqual({
        projectId: "my-proj",
        saName: "sync-sa",
        spreadsheetTitle: "My Sheet",
        output: "custom.env",
        yes: true,
        dryRun: true,
      });
    }
  });

  it("accepts --flag=value form and a leading `setup` token (npm bin invocation)", () => {
    const result = parseSetupArgs(["setup", "--project=my-proj", "--output=o.env", "--yes"]);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.options.projectId).toBe("my-proj");
      expect(result.options.output).toBe("o.env");
      expect(result.options.yes).toBe(true);
    }
  });

  it("applies defaults when no flags are given", () => {
    const result = parseSetupArgs([]);
    expect(result.status).toBe("valid");
    if (result.status === "valid") {
      expect(result.options).toStrictEqual({
        saName: DEFAULT_SA_NAME,
        output: DEFAULT_OUTPUT_FILE_NAME,
        yes: false,
        dryRun: false,
      });
    }
  });

  it("rejects unknown flags with invalid_args", () => {
    const result = parseSetupArgs(["--frobnicate"]);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.failure.code).toBe(SETUP_ERROR_CODES.INVALID_ARGS);
      expect(result.failure.message).toContain("--frobnicate");
    }
  });

  it("rejects a flag with a missing value", () => {
    for (const argv of [["--project"], ["--sa-name"], ["--spreadsheet-title"], ["--output"]]) {
      const result = parseSetupArgs(argv);
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.failure.code).toBe(SETUP_ERROR_CODES.INVALID_ARGS);
      }
    }
  });

  it("rejects an empty value", () => {
    for (const argv of [["--project="], ["--sa-name="], ["--output="]]) {
      const result = parseSetupArgs(argv);
      expect(result.status).toBe("invalid");
    }
  });

  it("rejects positional arguments other than a leading setup token", () => {
    const result = parseSetupArgs(["--yes", "extra"]);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.failure.message).toContain("extra");
    }
  });

  it("returns help text for --help and -h anywhere in argv", () => {
    for (const argv of [["--help"], ["-h"], ["--yes", "--help"]]) {
      const result = parseSetupArgs(argv);
      expect(result.status).toBe("help");
      if (result.status === "help") {
        expect(result.helpText).toBe(SETUP_HELP_TEXT);
        expect(result.helpText).toContain("--dry-run");
        expect(result.helpText).toContain("--project");
      }
    }
  });
});

describe("generateProjectId", () => {
  it("produces a gcloud-compatible hikoutei slug with timestamp and random parts", () => {
    const id = generateProjectId();
    expect(id).toMatch(/^hikoutei-[a-z0-9]+-[a-z0-9]{4}$/);
    expect(id.length).toBeLessThanOrEqual(30);
  });

  it("varies the suffix across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      seen.add(generateProjectId());
    }
    expect(seen.size).toBe(50);
  });
});

describe("confirmSetup", () => {
  function capturingOutput(): { output: { write: (text: string) => void }; text: () => string } {
    let text = "";
    return {
      output: { write: (chunk: string) => { text += chunk; } },
      text: () => text,
    };
  }

  it("confirms immediately with --yes without reading input", async () => {
    const { output, text } = capturingOutput();
    const result = await confirmSetup({ yes: true, dryRun: false, input: Readable.from(["n\n"]), output });
    expect(result).toStrictEqual({ status: "confirmed" });
    expect(text()).toBe("");
  });

  it("confirms immediately in dry-run mode without reading input", async () => {
    const { output } = capturingOutput();
    const result = await confirmSetup({ yes: false, dryRun: true, input: Readable.from(["n\n"]), output });
    expect(result).toStrictEqual({ status: "confirmed" });
  });

  it("confirms on y/yes answers", async () => {
    for (const answer of ["y\n", "yes\n", "Y\n", "YES\n"]) {
      const { output, text } = capturingOutput();
      const result = await confirmSetup({ yes: false, dryRun: false, input: Readable.from([answer]), output });
      expect(result).toStrictEqual({ status: "confirmed" });
      expect(text()).toContain("Continue?");
    }
  });

  it("declines on any other answer", async () => {
    for (const answer of ["n\n", "no\n", "\n", "maybe\n"]) {
      const result = await confirmSetup({ yes: false, dryRun: false, input: Readable.from([answer]), output: { write: () => undefined } });
      expect(result).toStrictEqual({ status: "declined" });
    }
  });

  it("declines on end of input", async () => {
    const result = await confirmSetup({ yes: false, dryRun: false, input: Readable.from([]), output: { write: () => undefined } });
    expect(result).toStrictEqual({ status: "declined" });
  });
});

describe("planSetupCommands", () => {
  const options: RunSetupOptions = {
    runner: { async run() { throw new Error("planning must not run commands"); } },
    createSpreadsheet: async () => { throw new Error("planning must not create sheets"); },
    projectId: undefined,
    saName: "hikoutei-sa",
    spreadsheetTitle: undefined,
    keyPath: "/tmp/hikoutei-service-account.json",
    outputPath: "/tmp/.env",
    dryRun: true,
  };

  it("lists the exact gcloud sequence for a fresh setup", () => {
    const slug = generateProjectId(1_700_000_000_000, () => 0.5);
    const plan = planSetupCommands(options, slug);
    expect(gcloudCommands(plan)).toStrictEqual([
      ["--version"],
      ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
      ["projects", "create", slug],
      ["config", "set", "project", slug],
      ["services", "enable", "sheets.googleapis.com", "--project", slug],
      ["iam", "service-accounts", "list", "--project", slug, "--format=value(email)"],
      ["iam", "service-accounts", "create", "hikoutei-sa", "--project", slug, "--display-name", "hikoutei setup"],
      ["iam", "service-accounts", "keys", "create", "/tmp/hikoutei-service-account.json", "--iam-account", serviceAccountEmail("hikoutei-sa", slug), "--project", slug],
    ]);
    expect(plan.some((c) => c.kind === "api")).toBe(true);
    expect(plan.some((c) => c.kind === "file")).toBe(true);
  });

  it("verifies an explicit project instead of creating one", () => {
    const plan = planSetupCommands({ ...options, projectId: "existing-proj" }, "ignored");
    const commands = gcloudCommands(plan);
    expect(commands).toContainEqual(["projects", "describe", "existing-proj"]);
    expect(commands.some((c) => c[0] === "projects" && c[1] === "create")).toBe(false);
  });

  it("formats the plan as shell lines with outcomes", () => {
    const rendered = formatPlan(planSetupCommands(options, "hikoutei-abc123-0000"));
    expect(rendered).toContain("$ gcloud --version");
    expect(rendered).toContain("$ gcloud projects create hikoutei-abc123-0000");
    expect(rendered).toContain("# project created (reused when it already exists)");
  });
});

describe("writeSetupEnvFile", () => {
  const credentialsPath = "/abs/path/key.json";
  const spreadsheetUrl = "https://docs.google.com/spreadsheets/d/abc/edit";

  it("creates a fresh file with both managed keys", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    const result = writeSetupEnvFile(outputPath, credentialsPath, spreadsheetUrl);
    expect(result).toStrictEqual({ created: true, modified: true });
    expect(readFileSync(outputPath, "utf8")).toBe(
      `${SETUP_ENV_KEYS.CREDENTIALS}=${credentialsPath}\n${SETUP_ENV_KEYS.SPREADSHEET_URL}=${spreadsheetUrl}\n`,
    );
  });

  it("preserves unrelated lines and updates both managed keys in place", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    writeFileSync(
      outputPath,
      [
        "FOO=bar",
        `${SETUP_ENV_KEYS.CREDENTIALS}=/old/key.json`,
        "BAZ=qux",
        `${SETUP_ENV_KEYS.SPREADSHEET_URL}=https://old.example`,
        "LAST=line",
      ].join("\n") + "\n",
      "utf8",
    );
    const result = writeSetupEnvFile(outputPath, credentialsPath, spreadsheetUrl);
    expect(result).toStrictEqual({ created: false, modified: true });
    expect(readFileSync(outputPath, "utf8")).toBe(
      [
        "FOO=bar",
        "BAZ=qux",
        "LAST=line",
        `${SETUP_ENV_KEYS.CREDENTIALS}=${credentialsPath}`,
        `${SETUP_ENV_KEYS.SPREADSHEET_URL}=${spreadsheetUrl}`,
        "",
      ].join("\n"),
    );
  });

  it("does not rewrite an unchanged file", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    writeSetupEnvFile(outputPath, credentialsPath, spreadsheetUrl);
    const result = writeSetupEnvFile(outputPath, credentialsPath, spreadsheetUrl);
    expect(result).toStrictEqual({ created: false, modified: false });
  });

  it("normalizes a file without a trailing newline", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    writeFileSync(outputPath, "KEEP=1", "utf8");
    writeSetupEnvFile(outputPath, credentialsPath, spreadsheetUrl);
    expect(readFileSync(outputPath, "utf8")).toBe(
      `KEEP=1\n${SETUP_ENV_KEYS.CREDENTIALS}=${credentialsPath}\n${SETUP_ENV_KEYS.SPREADSHEET_URL}=${spreadsheetUrl}\n`,
    );
  });
});

describe("extractSpreadsheetCreateResult", () => {
  it("promotes a valid payload with a URL", () => {
    expect(
      extractSpreadsheetCreateResult({
        spreadsheetId: "abc",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/abc/edit",
      }),
    ).toStrictEqual({
      spreadsheetId: "abc",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/abc/edit",
    });
  });

  it("derives the URL when the payload omits it", () => {
    expect(extractSpreadsheetCreateResult({ spreadsheetId: "abc" })).toStrictEqual({
      spreadsheetId: "abc",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/abc/edit",
    });
  });

  it("rejects malformed payloads", () => {
    expect(() => extractSpreadsheetCreateResult(null)).toThrow();
    expect(() => extractSpreadsheetCreateResult({})).toThrow();
    expect(() => extractSpreadsheetCreateResult({ spreadsheetId: "" })).toThrow();
    expect(() => extractSpreadsheetCreateResult({ spreadsheetId: 42 })).toThrow();
  });

  it("builds edit URLs from ids", () => {
    expect(spreadsheetEditUrl("abc123")).toBe("https://docs.google.com/spreadsheets/d/abc123/edit");
  });
});

describe("runSetup — fresh setup", () => {
  it("runs the full command sequence and writes .env and the key file", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run();

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;

    const commands = gcloudCommands(result.commands);
    expect(commands).toHaveLength(8);
    expect(commands[0]).toStrictEqual(["--version"]);
    expect(commands[1]).toStrictEqual(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]);
    const slug = commands[2]?.[2] as string;
    expect(slug).toMatch(/^hikoutei-[a-z0-9]+-[a-z0-9]{4}$/);
    expect(commands[2]).toStrictEqual(["projects", "create", slug]);
    expect(commands[3]).toStrictEqual(["config", "set", "project", slug]);
    expect(commands[4]).toStrictEqual(["services", "enable", "sheets.googleapis.com", "--project", slug]);
    expect(commands[5]).toStrictEqual(["iam", "service-accounts", "list", "--project", slug, "--format=value(email)"]);
    expect(commands[6]).toStrictEqual(["iam", "service-accounts", "create", "hikoutei-sa", "--project", slug, "--display-name", "hikoutei setup"]);
    expect(commands[7]).toStrictEqual([
      "iam",
      "service-accounts",
      "keys",
      "create",
      harness.keyPath,
      "--iam-account",
      serviceAccountEmail("hikoutei-sa", slug),
      "--project",
      slug,
    ]);
    expect(harness.calls.map((c) => c.join(" "))).toEqual(commands.map((c) => c.join(" ")));

    // Summary carries the derived identities.
    expect(result.summary).toMatchObject({
      projectId: slug,
      serviceAccountEmail: serviceAccountEmail("hikoutei-sa", slug),
      keyPath: harness.keyPath,
      spreadsheetId: "spreadsheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-123/edit",
      outputPath: harness.outputPath,
      envFileCreated: true,
      envFileModified: true,
      projectReused: false,
      serviceAccountReused: false,
      keyReused: false,
    });

    // Spreadsheet is created with the default title and the new key.
    expect(harness.created).toStrictEqual([
      { keyPath: harness.keyPath, title: `hikoutei-sync-${slug}` },
    ]);

    // .env contains the two managed keys with absolute paths.
    expect(readFileSync(harness.outputPath, "utf8")).toBe(
      `${SETUP_ENV_KEYS.CREDENTIALS}=${harness.keyPath}\n${SETUP_ENV_KEYS.SPREADSHEET_URL}=https://docs.google.com/spreadsheets/d/spreadsheet-123/edit\n`,
    );

    // Key file exists with mode 600.
    expect(existsSync(harness.keyPath)).toBe(true);
    expect(statSync(harness.keyPath).mode & 0o777).toBe(0o600);
  });

  it("uses a custom spreadsheet title when given", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ spreadsheetTitle: "My Custom Sheet" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(harness.created[0]?.title).toBe("My Custom Sheet");
    expect(result.summary.spreadsheetTitle).toBe("My Custom Sheet");
  });

  it("derives the service account email and title from an explicit project", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ projectId: "existing-proj" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;

    const commands = gcloudCommands(result.commands);
    expect(commands).toContainEqual(["projects", "describe", "existing-proj"]);
    expect(commands.some((c) => c[0] === "projects" && c[1] === "create")).toBe(false);
    expect(commands).toContainEqual(["config", "set", "project", "existing-proj"]);
    expect(harness.created[0]?.title).toBe("hikoutei-sync-existing-proj");
    expect(result.summary.serviceAccountEmail).toBe("hikoutei-sa@existing-proj.iam.gserviceaccount.com");
  });
});

describe("runSetup — idempotent reuse", () => {
  it("reuses a project whose creation reports already-exists", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) => {
      if (args[0] === "projects" && args[1] === "create") {
        return failed(1, "ERROR: (gcloud.projects.create) Project 'x' already exists.");
      }
      return freshSetupScript(harness.keyPath)(args);
    });
    const result = await harness.run();

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(result.summary.projectReused).toBe(true);
    expect(result.summary.projectId).toMatch(/^hikoutei-/);
    // The flow continues past the reused project.
    const commands = gcloudCommands(result.commands);
    expect(commands).toContainEqual(["config", "set", "project", result.summary.projectId]);
    expect(commands.some((c) => c[0] === "iam" && c[2] === "keys")).toBe(true);
  });

  it("reuses an existing service account by email", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) => {
      if (args[0] === "iam" && args[2] === "list") {
        const projectId = args[4] as string;
        return { status: "ok", stdout: `${serviceAccountEmail("hikoutei-sa", projectId)}\n`, stderr: "" };
      }
      return freshSetupScript(harness.keyPath)(args);
    });
    const result = await harness.run();

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(result.summary.serviceAccountReused).toBe(true);
    const commands = gcloudCommands(result.commands);
    expect(commands.some((c) => c[0] === "iam" && c[2] === "create")).toBe(false);
    expect(commands.some((c) => c[0] === "iam" && c[2] === "keys")).toBe(true);
  });

  it("reuses an existing key file without overwriting it", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(harness.keyPath, "keep-me", "utf8");
    const result = await harness.run();

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(result.summary.keyReused).toBe(true);
    const commands = gcloudCommands(result.commands);
    expect(commands.some((c) => c[0] === "iam" && c[2] === "keys")).toBe(false);
    expect(readFileSync(harness.keyPath, "utf8")).toBe("keep-me");
    expect(statSync(harness.keyPath).mode & 0o777).toBe(0o600);
  });

  it("runs a full-reuse setup with the minimal command set", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) => {
      if (args[0] === "projects" && args[1] === "create") {
        return failed(1, "Project 'x' already exists.");
      }
      if (args[0] === "iam" && args[2] === "list") {
        const projectId = args[4] as string;
        return { status: "ok", stdout: `${serviceAccountEmail("hikoutei-sa", projectId)}\n`, stderr: "" };
      }
      return freshSetupScript(harness.keyPath)(args);
    });
    writeFileSync(harness.keyPath, "existing-key", "utf8");
    const result = await harness.run();

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(result.summary.projectReused).toBe(true);
    expect(result.summary.serviceAccountReused).toBe(true);
    expect(result.summary.keyReused).toBe(true);
    const commands = gcloudCommands(result.commands);
    expect(commands).toHaveLength(6); // version, auth, create(failed->reused), config, enable, sa list
    expect(commands.some((c) => c[0] === "iam" && (c[2] === "create" || c[2] === "keys"))).toBe(false);
    expect(result.summary.envFileModified).toBe(true);
  });
});

describe("runSetup — dry run", () => {
  it("returns the command plan without executing anything", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ dryRun: true });

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || !result.dryRun) return;

    expect(harness.calls).toHaveLength(0);
    expect(harness.created).toHaveLength(0);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);

    const commands = gcloudCommands(result.commands);
    expect(commands[0]).toStrictEqual(["--version"]);
    const slug = commands[2]?.[2] as string;
    expect(slug).toMatch(/^hikoutei-[a-z0-9]+-[a-z0-9]{4}$/);
    expect(commands).toContainEqual(["projects", "create", slug]);
    expect(commands).toContainEqual(["config", "set", "project", slug]);
    expect(commands).toContainEqual(["services", "enable", "sheets.googleapis.com", "--project", slug]);
    expect(commands).toContainEqual([
      "iam",
      "service-accounts",
      "keys",
      "create",
      harness.keyPath,
      "--iam-account",
      serviceAccountEmail("hikoutei-sa", slug),
      "--project",
      slug,
    ]);
    expect(result.commands.some((c) => c.kind === "api")).toBe(true);
    expect(result.commands.some((c) => c.kind === "file")).toBe(true);
  });

  it("plans verification for an explicit project", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ dryRun: true, projectId: "existing-proj" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || !result.dryRun) return;
    const commands = gcloudCommands(result.commands);
    expect(commands).toContainEqual(["projects", "describe", "existing-proj"]);
    expect(commands.some((c) => c[0] === "projects" && c[1] === "create")).toBe(false);
  });
});

describe("runSetup — failure mapping", () => {
  it("reports gcloud_missing when gcloud is not installed", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, () => ({ status: "not_found" }));
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.GCLOUD_MISSING);
  });

  it("reports gcloud_missing when gcloud --version fails", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) =>
      args[0] === "--version" ? failed(1, "gcloud is broken") : freshSetupScript(harness.keyPath)(args),
    );
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.GCLOUD_MISSING);
  });

  it("reports gcloud_not_logged_in when no active account exists", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) =>
      args[0] === "auth" ? { status: "ok", stdout: "", stderr: "No credentialed accounts." } : freshSetupScript(harness.keyPath)(args),
    );
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN);
  });

  it("reports gcloud_not_logged_in when auth list fails", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) =>
      args[0] === "auth" ? failed(1, "gcloud crashed") : freshSetupScript(harness.keyPath)(args),
    );
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN);
  });

  it("reports project_create_failed when project creation fails for another reason", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) =>
      args[0] === "projects" && args[1] === "create"
        ? failed(1, "ERROR: (gcloud.projects.create) Permission denied.")
        : freshSetupScript(harness.keyPath)(args),
    );
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.PROJECT_CREATE_FAILED);
  });

  it("reports project_not_found when an explicit project cannot be verified", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) =>
      args[0] === "projects" && args[1] === "describe"
        ? failed(1, "ERROR: (gcloud.projects.describe) Project [nope] not found.")
        : freshSetupScript(harness.keyPath)(args),
    );
    const result = await harness.run({ projectId: "nope" });
    expectError(result, SETUP_ERROR_CODES.PROJECT_NOT_FOUND);
  });

  it("reports project_select_failed when config set fails", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) =>
      args[0] === "config" ? failed(1, "cannot write config") : freshSetupScript(harness.keyPath)(args),
    );
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.PROJECT_SELECT_FAILED);
  });

  it("reports api_enable_failed when enabling the Sheets API fails", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) =>
      args[0] === "services" ? failed(1, "API enablement failed") : freshSetupScript(harness.keyPath)(args),
    );
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.API_ENABLE_FAILED);
  });

  it("reports sa_create_failed when listing service accounts fails", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) =>
      args[0] === "iam" && args[2] === "list" ? failed(1, "list failed") : freshSetupScript(harness.keyPath)(args),
    );
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SA_CREATE_FAILED);
  });

  it("reports sa_create_failed when creating the service account fails", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) =>
      args[0] === "iam" && args[2] === "create" ? failed(1, "create failed") : freshSetupScript(harness.keyPath)(args),
    );
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SA_CREATE_FAILED);
  });

  it("reports key_create_failed when key creation fails", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir, (args) =>
      args[0] === "iam" && args[2] === "keys" ? failed(1, "key create failed") : freshSetupScript(harness.keyPath)(args),
    );
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
  });

  it("reports sheet_create_failed when spreadsheet creation fails", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({
      createSpreadsheet: async () => {
        throw new Error("sheets API quota exceeded");
      },
    });
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_FAILED);
  });

  it("reports output_write_failed when the .env file cannot be written", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ outputPath: join(dir, "missing", ".env") });
    expectError(result, SETUP_ERROR_CODES.OUTPUT_WRITE_FAILED);
  });
});

describe("formatSummary", () => {
  it("prints identities and paths but never key contents", () => {
    const text = formatSummary({
      projectId: "hikoutei-abc",
      serviceAccountEmail: "hikoutei-sa@hikoutei-abc.iam.gserviceaccount.com",
      keyPath: "/tmp/hikoutei-service-account.json",
      spreadsheetId: "spreadsheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-123/edit",
      spreadsheetTitle: "hikoutei-sync-hikoutei-abc",
      outputPath: "/tmp/.env",
      envFileCreated: false,
      envFileModified: true,
      projectReused: false,
      serviceAccountReused: true,
      keyReused: false,
    });
    expect(text).toContain("hikoutei-abc");
    expect(text).toContain("hikoutei-sa@hikoutei-abc.iam.gserviceaccount.com");
    expect(text).toContain("https://docs.google.com/spreadsheets/d/spreadsheet-123/edit");
    expect(text).toContain("/tmp/.env (updated)");
    expect(text).not.toContain("private_key");
  });
});

describe("derived identity helpers", () => {
  it("derives service account emails and default titles", () => {
    expect(serviceAccountEmail("sa", "proj")).toBe("sa@proj.iam.gserviceaccount.com");
    expect(defaultSpreadsheetTitle("proj")).toBe("hikoutei-sync-proj");
  });
});
