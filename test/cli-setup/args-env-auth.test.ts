/**
 * Unit tests for the `hikoutei setup` CLI.
 *
 * Every test runs against the real production modules with injected fakes:
 * a recording gcloud runner, a fake tokeninfo validator, a fake human-token
 * sheet API, and a fake SA verifier — so nothing touches gcloud, the
 * network, or real Google resources. The fake runner simulates gcloud's
 * key-file side effect so the flow's chmod-600 step is exercised
 * realistically.
 */

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import {
  spawnSync,
} from "node:child_process";
import {
  generateKeyPairSync,
} from "node:crypto";
import {
  basename,
  join,
} from "node:path";
import {
  Readable,
} from "node:stream";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OUTPUT_FILE_NAME,
  DEFAULT_SA_NAME,
  parseSetupArgs,
  SETUP_HELP_TEXT,
} from "@hikoutei/cli/args.js";
import {
  acquireSetupLock,
  checkStateCompatibility,
  isValidCreationMarker,
  isValidGcpProjectId,
  isValidKeyMarker,
  isValidServiceAccountName,
  loadSetupState,
  parseServiceAccountKeyJson,
  readServiceAccountKeyCredentialSecurely,
  readServiceAccountKeySecurely,
  releaseSetupLock,
  saveSetupState,
  serviceAccountEmail,
  SERVICE_ACCOUNT_KEY_FILE_MODE,
  SERVICE_ACCOUNT_KEY_ID_PATTERN,
  SETUP_STATE_FILE_NAME,
  SETUP_STATE_TEMP_SUFFIX,
  SETUP_STATE_VERSION,
  setupLockPath,
  setupStateTempPath,
  uniqueSetupStateTempPath,
  validateSetupState,
  type KeyFileFs,
  type LockFs,
  type SetupState,
  type SetupStateLoadFs,
  type SetupStateWriteFs,
} from "@hikoutei/cli/checkpoint.js";
import {
  confirmSetup,
} from "@hikoutei/cli/confirm.js";
import {
  SETUP_ERROR_CODES,
} from "@hikoutei/cli/errors.js";
import {
  GcloudRunner,
  GcloudRunResult,
} from "@hikoutei/cli/gcloudRunner.js";
import {
  checkHumanDriveAccess,
  createTokeninfoValidator,
  DRIVE_ACCESS_COMMAND,
  DRIVE_FILE_SCOPE,
  DRIVE_SCOPE,
  extractTokenInfo,
  GOOGLE_ACCOUNT_EMAIL_PATTERN,
  hasDriveScope,
  isValidGoogleAccountEmail,
  TOKENINFO_URL,
  type TokenInfo,
  type TokenValidator,
} from "@hikoutei/cli/humanAuth.js";
import {
  createSaAccessVerifier,
  isRetryableVerifyError,
  requireSpreadsheetId,
  SA_VERIFY_RETRY_DELAYS_MS,
  type SaAccessCredentials,
  type Sleeper,
  type SpreadsheetGetClient,
} from "@hikoutei/cli/saVerify.js";
import {
  buildDriveFileCreateRequest,
  ensureSaWriterPermission,
  extractDriveFileCreateResult,
  extractDriveFileMetadata,
  extractMarkerFileList,
  extractMarkerFileListPage,
  extractPermissionList,
  extractPermissionListPage,
  HIKOUTEI_SETUP_MARKER_KEY,
  listAllMarkerFiles,
  MAX_MARKER_FILE_LIST_PAGES,
  MAX_PERMISSION_LIST_PAGES,
  planSaWriterAction,
  SPREADSHEET_MIME_TYPE,
  spreadsheetEditUrl,
  type DriveFileListApi,
  type DrivePermissionApi,
} from "@hikoutei/cli/sheetsFactory.js";
import {
  KEY_STAGE_PLACEHOLDER,
} from "@hikoutei/cli/keyProvision.js";
import {
  atomicWritePrivateFile,
  formatPlan,
  generateProjectId,
  planSetupCommands,
  SETUP_ENV_KEYS,
  writeSetupEnvFile,
  type RunSetupOptions,
} from "@hikoutei/cli/setupFlow.js";

import {
  makeTempDir,
  FAKE_TOKEN,
  FAKE_OWNER,
  SPREADSHEET_ID,
  SPREADSHEET_URL,
  VALID_KEY_MARKER,
  FIXED_KEY_ID,
  validKeyJson,
  keyResourceName,
  RSA_PRIVATE_KEY_PEM,
  SECRET_JWT,
  SECRET_KEY_MATERIAL,
  SECRET_AUTHORIZATION,
  failed,
  gcloudCommands,
} from "../support/cliSetupHarness.js";

/**
 * Entries in `dir` whose name starts with the state file name plus the temp
 * suffix (`.tmp...`): any leftover checkpoint temp artifact of a save.
 */
function tempLeftovers(dir: string, statePath: string): string[] {
  const base = basename(statePath);
  return readdirSync(dir).filter((name) => name.startsWith(`${base}${SETUP_STATE_TEMP_SUFFIX}`));
}

/** Well-formed creation marker (UUID v4) used in checkpoint fixtures. */
const VALID_MARKER = "123e4567-e89b-42d3-a456-426614174000";

/** Fake regular-file stats for injected key-reader filesystems. */
function fakeRegularFileStats(): Stats {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    mode: 0o100644,
    dev: 1,
    ino: 42,
  } as unknown as Stats;
}

/** Fake FIFO stats for injected key-reader filesystems. */
function fakeFifoStats(): Stats {
  return {
    isFile: () => false,
    isSymbolicLink: () => false,
    mode: 0o010644,
    dev: 1,
    ino: 43,
  } as unknown as Stats;
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

  it("rejects option-like and malformed --project/--sa-name values in BOTH forms (--flag value and --flag=value)", () => {
    // The space form treats an option-like value as a missing value: a flag
    // can never be the value of another flag.
    for (const argv of [
      ["--project", "--flag"],
      ["--sa-name", "--flag"],
    ]) {
      const result = parseSetupArgs(argv);
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.failure.code).toBe(SETUP_ERROR_CODES.INVALID_ARGS);
        expect(result.failure.message).toContain("requires a value");
      }
    }
    // The equals form previously bypassed the leading-dash check: an
    // option-like value (for example `--project=--flag`) must be rejected
    // by the strict identifier format before it can reach gcloud, an API,
    // or a file.
    for (const argv of [
      ["--project=--flag"],
      ["--project=--yes"],
      ["--project=--dry-run"],
      ["--sa-name=--flag"],
      ["--sa-name=--yes"],
    ]) {
      const result = parseSetupArgs(argv);
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.failure.code).toBe(SETUP_ERROR_CODES.INVALID_ARGS);
        expect(result.failure.message).toContain("invalid value");
      }
    }
    // Malformed identifiers are rejected too: too short, uppercase,
    // leading/trailing hyphen, digits-first, and non-identifier characters.
    for (const bad of [
      "a",
      "abc",
      "Abc-1",
      "-abc-1",
      "abc-",
      "1abc",
      "abc def",
      "abc\nSECRET",
      "",
    ]) {
      const project = parseSetupArgs(["--project", bad]);
      expect(project.status).toBe("invalid");
      if (project.status === "invalid") {
        expect(project.failure.code).toBe(SETUP_ERROR_CODES.INVALID_ARGS);
      }
      const sa = parseSetupArgs([`--sa-name=${bad}`]);
      expect(sa.status).toBe("invalid");
      if (sa.status === "invalid") {
        expect(sa.failure.code).toBe(SETUP_ERROR_CODES.INVALID_ARGS);
      }
    }
    // Valid identifiers keep working in both forms.
    expect(parseSetupArgs(["--project", "my-proj"]).status).toBe("valid");
    expect(parseSetupArgs(["--project=my-proj"]).status).toBe("valid");
    expect(parseSetupArgs(["--sa-name", "sync-sa"]).status).toBe("valid");
    expect(parseSetupArgs(["--sa-name=sync-sa"]).status).toBe("valid");
    expect(parseSetupArgs(["--sa-name=hikoutei-sa"]).status).toBe("valid");
  });

  it("rejects positional arguments other than a leading setup token", () => {
    const result = parseSetupArgs(["--yes", "extra"]);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.failure.message).toContain("extra");
    }
  });

  it("returns help text that documents the Drive-scope prerequisite", () => {
    for (const argv of [["--help"], ["-h"], ["--yes", "--help"]]) {
      const result = parseSetupArgs(argv);
      expect(result.status).toBe("help");
      if (result.status === "help") {
        expect(result.helpText).toBe(SETUP_HELP_TEXT);
        expect(result.helpText).toContain("gcloud auth login");
        expect(result.helpText).toContain("--enable-gdrive-access");
        expect(result.helpText).toContain("--dry-run");
        expect(result.helpText).toContain("--project");
        expect(result.helpText).toContain(SETUP_STATE_FILE_NAME);
        // Starting fresh requires removing BOTH checkpoint and key (or
        // passing --project); the help never suggests deleting cloud resources.
        expect(result.helpText).toContain("BOTH the");
        expect(result.helpText).toContain("--project <id>");
        expect(result.helpText).not.toContain("delete that file");
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
    validateToken: { async validate() { throw new Error("planning must not validate tokens"); } },
    createHumanApi: () => { throw new Error("planning must not create sheet APIs"); },
    verifySaAccess: { async verify() { throw new Error("planning must not verify"); } },
    projectId: undefined,
    saName: "hikoutei-sa",
    spreadsheetTitle: undefined,
    keyPath: "/tmp/hikoutei-service-account.json",
    outputPath: "/tmp/.env",
    statePath: "/tmp/.hikoutei-setup-state.json",
    dryRun: true,
  };

  it("lists the exact gcloud sequence for a fresh setup including both API enables", () => {
    const slug = generateProjectId(1_700_000_000_000, () => 0.5);
    const plan = planSetupCommands(options, slug);
    expect(gcloudCommands(plan)).toStrictEqual([
      ["--version"],
      ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"],
      ["auth", "print-access-token"],
      ["projects", "create", slug],
      ["config", "set", "project", slug],
      ["services", "enable", "sheets.googleapis.com", "drive.googleapis.com", "--project", slug],
      ["iam", "service-accounts", "list", "--project", slug, "--format=value(email)"],
      ["iam", "service-accounts", "create", "hikoutei-sa", "--project", slug, "--display-name", "hikoutei setup"],
      ["iam", "service-accounts", "keys", "list", "--managed-by=user", "--format=value(name)", "--iam-account", serviceAccountEmail("hikoutei-sa", slug), "--project", slug],
      ["iam", "service-accounts", "keys", "create", KEY_STAGE_PLACEHOLDER, "--iam-account", serviceAccountEmail("hikoutei-sa", slug), "--project", slug],
    ]);
  });

  it("describes the scope check, marker write-ahead, human create, SA share/verify, lock, checkpoint and env", () => {
    const plan = planSetupCommands(options, "hikoutei-abc123-0000");
    const labels = plan
      .filter((c) => c.kind === "api" || c.kind === "file")
      .map((c) => (c.kind === "api" ? c.label : `${c.label} ${c.outcome}`));
    expect(labels.join("\n")).toContain("tokeninfo");
    expect(labels.join("\n")).toContain("drive.files.create");
    expect(labels.join("\n")).toContain("appProperties creation marker");
    expect(labels.join("\n")).toContain("share hikoutei-sa@hikoutei-abc123-0000.iam.gserviceaccount.com as writer");
    expect(labels.join("\n")).toContain("drive.files.get ownership check");
    expect(labels.join("\n")).toContain("spreadsheets.get");
    expect(labels.join("\n")).toContain("acquire exclusive setup lock");
    expect(labels.join("\n")).toContain("release setup lock");
    expect(labels.join("\n")).toContain("/tmp/.hikoutei-setup-state.json");
    expect(labels.join("\n")).toContain("/tmp/.env");
    // The plan must not claim exact-id idempotency or SA ownership.
    expect(plan.some((c) => c.kind === "api" && c.outcome.includes("service account owns"))).toBe(false);
    expect(labels.join("\n")).not.toContain("generateIds");
    // The dry-run key create uses an explicit non-copyable staging
    // placeholder, never the final key path as the gcloud destination, and
    // the plan previews the write-ahead baseline and key_ready checkpoint.
    const keyCreate = gcloudCommands(plan).find((c) => c[0] === "iam" && c[3] === "create");
    expect(keyCreate?.[4]).toBe(KEY_STAGE_PLACEHOLDER);
    expect(keyCreate?.includes("/tmp/hikoutei-service-account.json")).toBe(false);
    expect(gcloudCommands(plan).some((c) => c[0] === "iam" && c[3] === "list")).toBe(true);
    expect(labels.join("\n")).toContain("key_create_started");
    expect(labels.join("\n")).toContain("key_ready");
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
    expect(rendered).toContain("$ gcloud auth print-access-token");
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
    const inode = statSync(outputPath).ino;
    const result = writeSetupEnvFile(outputPath, credentialsPath, spreadsheetUrl);
    expect(result).toStrictEqual({ created: false, modified: false });
    // Unchanged 0600 content is never rewritten: same inode, still 0600.
    expect(statSync(outputPath).ino).toBe(inode);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
  });

  it("atomically repairs an unchanged 0644 file: exact content, fresh 0600 inode, modified true", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    const content = [
      "FOO=bar",
      `${SETUP_ENV_KEYS.CREDENTIALS}=${credentialsPath}`,
      `${SETUP_ENV_KEYS.SPREADSHEET_URL}=${spreadsheetUrl}`,
      "",
    ].join("\n");
    writeFileSync(outputPath, content, { encoding: "utf8", mode: 0o644 });
    expect(statSync(outputPath).mode & 0o777).toBe(0o644);
    const inodeBefore = statSync(outputPath).ino;

    const result = writeSetupEnvFile(outputPath, credentialsPath, spreadsheetUrl);
    expect(result).toStrictEqual({ created: false, modified: true });
    // The exact content is preserved byte-for-byte.
    expect(readFileSync(outputPath, "utf8")).toBe(content);
    // The output names a fresh verified-0600 inode (atomic replacement,
    // never a pathname chmod of the existing inode).
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(statSync(outputPath).ino).not.toBe(inodeBefore);
    expect(readdirSync(dir).some((name) => name.startsWith(".hikoutei-env-"))).toBe(false);
  });

  it("repairs an unsafe mode without touching an unrelated hardlink sharing the old inode", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    const otherLink = join(dir, "unrelated.env");
    const content = [
      "FOO=bar",
      `${SETUP_ENV_KEYS.CREDENTIALS}=${credentialsPath}`,
      `${SETUP_ENV_KEYS.SPREADSHEET_URL}=${spreadsheetUrl}`,
      "",
    ].join("\n");
    writeFileSync(outputPath, content, { encoding: "utf8", mode: 0o644 });
    linkSync(outputPath, otherLink);
    const sharedInode = statSync(outputPath).ino;
    expect(statSync(otherLink).ino).toBe(sharedInode);

    const result = writeSetupEnvFile(outputPath, credentialsPath, spreadsheetUrl);
    expect(result).toStrictEqual({ created: false, modified: true });
    // The output path now names a fresh verified-0600 inode...
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(statSync(outputPath).ino).not.toBe(sharedInode);
    // ...while the unrelated hardlink keeps the old inode, content, and
    // mode: the repair never chmods or writes through the other name.
    expect(statSync(otherLink).ino).toBe(sharedInode);
    expect(statSync(otherLink).mode & 0o777).toBe(0o644);
    expect(readFileSync(otherLink, "utf8")).toBe(content);
  });

  it("refuses to follow an existing symlink at the output path", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    const target = join(dir, "elsewhere.env");
    writeFileSync(target, "existing-content", "utf8");
    symlinkSync(target, outputPath);

    expect(() => writeSetupEnvFile(outputPath, credentialsPath, spreadsheetUrl)).toThrow(/symlink/);
    // Neither the symlink nor its target changed.
    expect(lstatSync(outputPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("existing-content");
  });

  it("refuses an output that aliases the key file by inode before reading it", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    const keyPath = join(dir, "key.json");
    writeFileSync(keyPath, SECRET_KEY_MATERIAL, "utf8");
    linkSync(keyPath, outputPath);

    expect(() => writeSetupEnvFile(outputPath, keyPath, spreadsheetUrl)).toThrow(/reserved/);
    // The key contents were never read or modified through the alias.
    expect(readFileSync(keyPath, "utf8")).toBe(SECRET_KEY_MATERIAL);
    expect(readFileSync(outputPath, "utf8")).toBe(SECRET_KEY_MATERIAL);
  });

  it("refuses a directory at the output path without touching it", () => {
    const dir = makeTempDir();
    const outputDir = join(dir, "env-dir");
    mkdirSync(outputDir, { mode: 0o700 });
    writeFileSync(join(outputDir, "keep.txt"), "kept", "utf8");

    expect(() => writeSetupEnvFile(outputDir, credentialsPath, spreadsheetUrl)).toThrow(/not a regular file/);
    // The directory and its contents are untouched.
    expect(statSync(outputDir).isDirectory()).toBe(true);
    expect(readFileSync(join(outputDir, "keep.txt"), "utf8")).toBe("kept");
  });

  it("refuses a FIFO at the output path without opening or reading it (no blocking)", (ctx) => {
    if ((constants as { O_NONBLOCK?: number }).O_NONBLOCK === undefined) {
      ctx.skip();
      return;
    }
    const dir = makeTempDir();
    const fifoPath = join(dir, "fifo.env");
    // Bounded: mkfifo itself runs with a hard timeout; the open/read path
    // uses O_NONBLOCK so it can never block on the FIFO.
    const mkfifo = spawnSync("mkfifo", [fifoPath], { timeout: 5000 });
    if (mkfifo.status !== 0) {
      // mkfifo is unavailable on this platform: skip instead of failing.
      ctx.skip();
      return;
    }

    expect(() => writeSetupEnvFile(fifoPath, credentialsPath, spreadsheetUrl)).toThrow(/not a regular file/);
    // The FIFO was never read (no writer ever appeared) and is untouched.
    expect(lstatSync(fifoPath).isFIFO()).toBe(true);
  });

  it("writes with mode 0600 through a private temp file and leaves no leftovers", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    writeSetupEnvFile(outputPath, credentialsPath, spreadsheetUrl);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).some((name) => name.startsWith(".hikoutei-env-"))).toBe(false);
  });
});

describe("checkpoint state file", () => {
  function projectState(overrides: Record<string, unknown> = {}): SetupState {
    return {
      version: SETUP_STATE_VERSION,
      status: "project_selected",
      projectId: "hikoutei-proj",
      projectMode: "generated",
      ownerEmail: FAKE_OWNER,
      saName: "hikoutei-sa",
      saEmail: "hikoutei-sa@hikoutei-proj.iam.gserviceaccount.com",
      keyPath: "/tmp/hikoutei-service-account.json",
      spreadsheetTitle: "hikoutei-sync-hikoutei-proj",
      ...overrides,
    } as unknown as SetupState;
  }

  function startedState(overrides: Record<string, unknown> = {}): SetupState {
    return {
      ...projectState(),
      status: "spreadsheet_create_started",
      creationMarker: VALID_MARKER,
      keyOrigin: "created",
      ...overrides,
    } as unknown as SetupState;
  }

  function keyStartedState(overrides: Record<string, unknown> = {}): SetupState {
    return {
      ...projectState(),
      status: "key_create_started",
      keyMarker: VALID_KEY_MARKER,
      keyBaseline: [],
      ...overrides,
    } as unknown as SetupState;
  }

  function keyReadyState(overrides: Record<string, unknown> = {}): SetupState {
    return { ...projectState(), status: "key_ready", keyOrigin: "created", ...overrides } as unknown as SetupState;
  }

  function spreadsheetState(overrides: Record<string, unknown> = {}): SetupState {
    const status = (overrides.status as string | undefined) ?? "spreadsheet_created";
    const base = {
      ...projectState(),
      status,
      spreadsheetId: SPREADSHEET_ID,
      keyOrigin: "created",
      ...overrides,
    };
    // spreadsheet_shared and complete carry the required shareOrigin
    // provenance discriminant; earlier statuses reject it.
    if (status === "spreadsheet_shared" || status === "complete") {
      const shareOrigin = "shareOrigin" in overrides ? overrides.shareOrigin : "fresh";
      return { ...base, shareOrigin } as unknown as SetupState;
    }
    return base as unknown as SetupState;
  }

  it("validates every status of the discriminated union", () => {
    expect(validateSetupState(projectState())).toStrictEqual(projectState());
    expect(validateSetupState(keyStartedState())).toStrictEqual(keyStartedState());
    expect(validateSetupState(keyReadyState())).toStrictEqual(keyReadyState());
    expect(validateSetupState(startedState())).toStrictEqual(startedState());
    expect(validateSetupState(spreadsheetState())).toStrictEqual(spreadsheetState());
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_share_started" }))).toStrictEqual(
      spreadsheetState({ status: "spreadsheet_share_started" }),
    );
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_shared" }))).toStrictEqual(
      spreadsheetState({ status: "spreadsheet_shared" }),
    );
    expect(validateSetupState(spreadsheetState({ status: "complete" }))).toStrictEqual(
      spreadsheetState({ status: "complete" }),
    );
  });

  it("requires the stored saEmail to equal the canonical derivation for EVERY status", () => {
    const foreign = "attacker@evil-project.iam.gserviceaccount.com";
    // A foreign/different-SA email is refused in every status: project
    // selected, key started, key ready, sheet create started, sheet
    // created, share started, shared, and complete.
    expect(validateSetupState(projectState({ saEmail: foreign }))).toBeNull();
    expect(validateSetupState(keyStartedState({ saEmail: foreign }))).toBeNull();
    expect(validateSetupState(keyReadyState({ saEmail: foreign }))).toBeNull();
    expect(validateSetupState(startedState({ saEmail: foreign }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ saEmail: foreign }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_share_started", saEmail: foreign }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_shared", saEmail: foreign }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "complete", saEmail: foreign }))).toBeNull();
    // A different saName or projectId also breaks the derivation, and an
    // empty email is refused like any other missing field.
    expect(validateSetupState(projectState({ saName: "other-sa" }))).toBeNull();
    expect(validateSetupState(projectState({ projectId: "other-proj" }))).toBeNull();
    expect(validateSetupState(projectState({ saEmail: "" }))).toBeNull();
    // The canonical derived email still validates, including on the
    // latest statuses that carry key/share provenance.
    expect(validateSetupState(spreadsheetState({ status: "complete" }))).not.toBeNull();
    expect(
      validateSetupState(
        spreadsheetState({ status: "complete", saEmail: "hikoutei-sa@hikoutei-proj.iam.gserviceaccount.com" }),
      ),
    ).not.toBeNull();
  });

  it("validates the key marker and the sorted/deduplicated key baseline", () => {
    const saEmail = "hikoutei-sa@hikoutei-proj.iam.gserviceaccount.com";
    const baseline = [
      keyResourceName("hikoutei-proj", saEmail, "0000000000000001"),
      keyResourceName("hikoutei-proj", saEmail, "0000000000000002"),
    ];
    expect(validateSetupState(keyStartedState({ keyBaseline: baseline }))).toStrictEqual(
      keyStartedState({ keyBaseline: baseline }),
    );
    // Empty baseline (no pre-existing keys) is valid.
    expect(validateSetupState(keyStartedState({ keyBaseline: [] }))).toStrictEqual(
      keyStartedState({ keyBaseline: [] }),
    );
    // Unsorted, duplicated, empty-string, wrong-project, and non-name
    // entries are all refused.
    expect(validateSetupState(keyStartedState({ keyBaseline: [...baseline].reverse() }))).toBeNull();
    expect(validateSetupState(keyStartedState({ keyBaseline: [...baseline, baseline[0]] }))).toBeNull();
    expect(validateSetupState(keyStartedState({ keyBaseline: [...baseline, ""] }))).toBeNull();
    expect(
      validateSetupState(
        keyStartedState({
          keyBaseline: [keyResourceName("other-proj", saEmail, "0000000000000003")],
        }),
      ),
    ).toBeNull();
    expect(validateSetupState(keyStartedState({ keyBaseline: ["not-a-resource-name"] }))).toBeNull();
    expect(validateSetupState(keyStartedState({ keyBaseline: "nope" }))).toBeNull();
    expect(validateSetupState(keyStartedState({ keyBaseline: [42] }))).toBeNull();
  });

  it("rejects malformed payloads", () => {
    expect(validateSetupState(null)).toBeNull();
    expect(validateSetupState([])).toBeNull();
    expect(validateSetupState({})).toBeNull();
    expect(validateSetupState({ ...projectState(), version: 2 })).toBeNull();
    expect(validateSetupState({ ...projectState(), status: "done" })).toBeNull();
    expect(validateSetupState({ ...projectState(), projectId: "" })).toBeNull();
    expect(validateSetupState({ ...projectState(), ownerEmail: 42 })).toBeNull();
    // An option-like or malformed project id / service-account name in a
    // stored checkpoint is invalid for EVERY status: the identifiers drive
    // gcloud commands and derive the canonical SA email, so a malformed
    // stored value must never be promoted.
    for (const bad of ["--flag", "-abc", "Abc-1", "a", "1abc", "abc def", "abc\nSECRET", ""]) {
      expect(validateSetupState(projectState({ projectId: bad }))).toBeNull();
      expect(validateSetupState(projectState({ saName: bad }))).toBeNull();
      expect(validateSetupState(startedState({ projectId: bad }))).toBeNull();
      expect(validateSetupState(spreadsheetState({ status: "complete", saName: bad }))).toBeNull();
    }
    // The canonical guards themselves agree with the pattern.
    expect(isValidGcpProjectId("hikoutei-proj")).toBe(true);
    expect(isValidGcpProjectId("--flag")).toBe(false);
    expect(isValidServiceAccountName("hikoutei-sa")).toBe(true);
    expect(isValidServiceAccountName("--flag")).toBe(false);
    expect(validateSetupState({ ...projectState(), projectMode: "inferred" })).toBeNull();
    expect(validateSetupState(projectState({ spreadsheetId: SPREADSHEET_ID }))).toBeNull();
    expect(validateSetupState(projectState({ creationMarker: VALID_MARKER }))).toBeNull();
    // Pre-key states carrying key fields are contradictory.
    expect(validateSetupState(projectState({ keyMarker: VALID_KEY_MARKER }))).toBeNull();
    expect(validateSetupState(projectState({ keyBaseline: [] }))).toBeNull();
    // The key started state carries only the key marker and baseline.
    expect(validateSetupState(keyStartedState({ keyMarker: "" }))).toBeNull();
    expect(validateSetupState(keyStartedState({ keyMarker: "not-a-uuid" }))).toBeNull();
    expect(validateSetupState(keyStartedState({ keyMarker: "123e4567-e89b-52d3-a456-426614174000" }))).toBeNull();
    expect(validateSetupState(keyStartedState({ creationMarker: VALID_MARKER }))).toBeNull();
    expect(validateSetupState(keyStartedState({ spreadsheetId: SPREADSHEET_ID }))).toBeNull();
    // key_ready carries no key or spreadsheet fields at all.
    expect(validateSetupState(keyReadyState({ keyMarker: VALID_KEY_MARKER }))).toBeNull();
    expect(validateSetupState(keyReadyState({ keyBaseline: [] }))).toBeNull();
    expect(validateSetupState(keyReadyState({ creationMarker: VALID_MARKER }))).toBeNull();
    expect(validateSetupState(keyReadyState({ spreadsheetId: SPREADSHEET_ID }))).toBeNull();
    // keyOrigin is REQUIRED from key_ready onward (both values accepted,
    // anything else refused) and rejected in the pre-secure statuses.
    expect(validateSetupState(keyReadyState({ keyOrigin: "reused" }))).not.toBeNull();
    expect(validateSetupState(keyReadyState({ keyOrigin: undefined }))).toBeNull();
    expect(validateSetupState(keyReadyState({ keyOrigin: "unknown" }))).toBeNull();
    expect(validateSetupState(projectState({ keyOrigin: "created" }))).toBeNull();
    expect(validateSetupState(keyStartedState({ keyOrigin: "created" }))).toBeNull();
    expect(validateSetupState(startedState({ keyOrigin: undefined }))).toBeNull();
    expect(validateSetupState(startedState({ keyOrigin: "created" }))).not.toBeNull();
    expect(validateSetupState(spreadsheetState({ keyOrigin: undefined }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "complete", keyOrigin: "reused" }))).not.toBeNull();
    // The started state carries the marker but never a file id.
    expect(validateSetupState(startedState({ creationMarker: "" }))).toBeNull();
    expect(validateSetupState(startedState({ creationMarker: "not-a-uuid" }))).toBeNull();
    expect(validateSetupState(startedState({ creationMarker: "123e4567-e89b-52d3-a456-426614174000" }))).toBeNull();
    expect(validateSetupState(startedState({ spreadsheetId: SPREADSHEET_ID }))).toBeNull();
    // Spreadsheet states imply key readiness: key fields are contradictory.
    expect(validateSetupState(startedState({ keyMarker: VALID_KEY_MARKER }))).toBeNull();
    expect(validateSetupState(startedState({ keyBaseline: [] }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ spreadsheetId: "" }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ spreadsheetId: undefined }))).toBeNull();
    // A Drive id must be a non-empty URL-safe identifier; anything with
    // whitespace, control characters, or other punctuation is refused.
    expect(validateSetupState(spreadsheetState({ spreadsheetId: "a b" }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ spreadsheetId: "a\nSECRET" }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ spreadsheetId: "a\u0000b" }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ spreadsheetId: "a/b" }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ spreadsheetId: "a.b" }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ spreadsheetId: "a:b" }))).toBeNull();
    // The markers are only meaningful while their create is in flight.
    expect(validateSetupState(spreadsheetState({ creationMarker: VALID_MARKER }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ keyMarker: VALID_KEY_MARKER }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ keyBaseline: [] }))).toBeNull();
    // shareOrigin is REQUIRED from spreadsheet_shared onward (both values
    // accepted, anything else refused) and rejected in every earlier
    // status (it is unknown until the share step runs).
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_shared" }))).not.toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "complete", shareOrigin: "reused" }))).not.toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_shared", shareOrigin: undefined }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_shared", shareOrigin: "unknown" }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "complete", shareOrigin: 42 }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_shared", shareOrigin: null }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ shareOrigin: "fresh" }))).toBeNull();
    expect(validateSetupState(projectState({ shareOrigin: "fresh" }))).toBeNull();
    expect(validateSetupState(keyStartedState({ shareOrigin: "fresh" }))).toBeNull();
    expect(validateSetupState(keyReadyState({ shareOrigin: "fresh" }))).toBeNull();
    expect(validateSetupState(startedState({ shareOrigin: "fresh" }))).toBeNull();
    // spreadsheet_share_started is the share WRITE-AHEAD: it carries the
    // spreadsheet id and keyOrigin, but never a shareOrigin (the outcome of
    // the permission mutation is not known yet) and never any marker.
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_share_started" }))).not.toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_share_started", shareOrigin: "fresh" }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_share_started", shareOrigin: "reused" }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_share_started", spreadsheetId: undefined }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_share_started", keyOrigin: undefined }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "spreadsheet_share_started", creationMarker: VALID_MARKER }))).toBeNull();
  });

  it("validates key markers with the restricted UUID v4 format", () => {
    expect(isValidKeyMarker(VALID_KEY_MARKER)).toBe(true);
    expect(isValidKeyMarker("123e4567-e89b-52d3-a456-426614174000")).toBe(false);
    expect(isValidKeyMarker("not-a-uuid")).toBe(false);
    expect(isValidKeyMarker(42)).toBe(false);
  });

  it("rejects a stored spreadsheetUrl for every status (the URL is derived from the id)", () => {
    expect(validateSetupState(projectState({ spreadsheetUrl: SPREADSHEET_URL }))).toBeNull();
    expect(validateSetupState(startedState({ spreadsheetUrl: SPREADSHEET_URL }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ spreadsheetUrl: SPREADSHEET_URL }))).toBeNull();
    expect(validateSetupState(spreadsheetState({ status: "complete", spreadsheetUrl: SPREADSHEET_URL }))).toBeNull();
    // The promoted state never carries a URL key at all.
    const state = validateSetupState(spreadsheetState());
    expect(state).not.toBeNull();
    expect("spreadsheetUrl" in (state as SetupState)).toBe(false);
  });

  it("validates creation markers with the restricted UUID v4 format", () => {
    expect(isValidCreationMarker(VALID_MARKER)).toBe(true);
    expect(isValidCreationMarker("123e4567-e89b-42d3-a456-42661417400G")).toBe(false);
    expect(isValidCreationMarker("123e4567-e89b-52d3-a456-426614174000")).toBe(false);
    expect(isValidCreationMarker("123e4567-e89b-42d3-7456-426614174000")).toBe(false);
    expect(isValidCreationMarker("")).toBe(false);
    expect(isValidCreationMarker(42)).toBe(false);
    expect(isValidCreationMarker(undefined)).toBe(false);
  });

  it("loads none/invalid/loaded states", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    expect(loadSetupState(statePath)).toStrictEqual({ status: "none" });

    writeFileSync(statePath, "{ not json", "utf8");
    const invalid = loadSetupState(statePath);
    expect(invalid.status).toBe("invalid");
    if (invalid.status === "invalid") {
      expect(invalid.message).toContain(statePath);
    }

    writeFileSync(statePath, JSON.stringify(projectState()), "utf8");
    expect(loadSetupState(statePath)).toStrictEqual({ status: "loaded", state: projectState() });
  });

  it("never forwards JSON.parse exception text for a malformed checkpoint (token-like and key-like sentinels)", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    // Node's JSON.parse failure text can include a snippet of the input,
    // so malformed checkpoints containing token-like or key-like text must
    // produce only the fixed path diagnostic.
    writeFileSync(statePath, `{ "version": 1, "status": ${FAKE_TOKEN} }`, "utf8");
    expect(loadSetupState(statePath)).toStrictEqual({
      status: "invalid",
      message: `${statePath} is not valid JSON`,
    });

    writeFileSync(
      statePath,
      `{ "private_key": "${SECRET_KEY_MATERIAL.replaceAll("\n", "\\n")}", "x": ${FAKE_TOKEN} }`,
      "utf8",
    );
    const result = loadSetupState(statePath);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.message).toBe(`${statePath} is not valid JSON`);
      expect(result.message).not.toContain(FAKE_TOKEN);
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
      expect(result.message).not.toContain("SECRETKEYMATERIAL");
    }
  });

  it("refuses a symlink at the checkpoint path without following it", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    const victim = join(dir, "victim.json");
    writeFileSync(victim, JSON.stringify(projectState()), "utf8");
    symlinkSync(victim, statePath);
    const result = loadSetupState(statePath);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.message).toContain("symlink");
    }
    // The alias target was never read or modified.
    expect(readFileSync(victim, "utf8")).toBe(JSON.stringify(projectState()));
  });

  it("refuses a directory at the checkpoint path", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    mkdirSync(statePath);
    const result = loadSetupState(statePath);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.message).toContain("not a regular file");
    }
  });

  it("refuses a FIFO at the checkpoint path without blocking (POSIX)", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    const made = spawnSync("mkfifo", [statePath]);
    if (made.status !== 0 || made.error !== undefined) {
      // The platform cannot create FIFOs (e.g. Windows): the non-regular
      // refusal is still covered by the directory/symlink tests and the
      // injected descriptor-replacement test below.
      return;
    }
    const result = loadSetupState(statePath);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.message).toContain("not a regular file");
    }
    // The FIFO was never opened, read, or replaced.
    expect(lstatSync(statePath).isFIFO()).toBe(true);
  });

  it("fails closed when the checkpoint is replaced by a non-regular entry between lstat and open", () => {
    const statePath = join(makeTempDir(), SETUP_STATE_FILE_NAME);
    const closed: number[] = [];
    let reads = 0;
    const fs: SetupStateLoadFs = {
      // lstat claims a regular file, but the opened descriptor is a
      // non-regular entry (e.g. a FIFO planted mid-run): the load must
      // refuse BEFORE reading a single byte.
      lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, dev: 1, ino: 42 }),
      openSync: () => 99,
      fstatSync: () => ({ isFile: () => false, dev: 1, ino: 43 }),
      readFileSync: () => {
        reads += 1;
        throw new Error("must never read a non-regular descriptor");
      },
      closeSync: (fd) => {
        closed.push(fd);
      },
    };
    const result = loadSetupState(statePath, fs);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.message).toContain("not a regular file");
    }
    expect(reads).toBe(0);
    expect(closed).toStrictEqual([99]);
  });

  it("fails closed when the checkpoint is replaced by a DIFFERENT regular file between lstat and open", () => {
    const statePath = join(makeTempDir(), SETUP_STATE_FILE_NAME);
    const closed: number[] = [];
    let reads = 0;
    const fs: SetupStateLoadFs = {
      // lstat observed one inode; the opened descriptor is a DIFFERENT
      // regular file (a swapped alias). The dev/ino binding must refuse it
      // BEFORE a single byte is read.
      lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, dev: 1, ino: 42 }),
      openSync: () => 99,
      fstatSync: () => ({ isFile: () => true, dev: 1, ino: 7 }),
      readFileSync: () => {
        reads += 1;
        throw new Error("must never read a replaced descriptor");
      },
      closeSync: (fd) => {
        closed.push(fd);
      },
    };
    const result = loadSetupState(statePath, fs);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.message).toContain("changed while loading");
    }
    expect(reads).toBe(0);
    expect(closed).toStrictEqual([99]);
  });

  it("maps ELOOP/EMLINK from the no-follow open to a symlink refusal", () => {
    const statePath = join(makeTempDir(), SETUP_STATE_FILE_NAME);
    const fs: SetupStateLoadFs = {
      lstatSync: () => ({ isSymbolicLink: () => false, isFile: () => true, dev: 1, ino: 42 }),
      openSync: () => {
        const error = new Error("too many levels of symbolic links") as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      },
      fstatSync: () => ({ isFile: () => true, dev: 1, ino: 42 }),
      readFileSync: () => {
        throw new Error("must never read after an ELOOP open");
      },
      closeSync: () => {},
    };
    const result = loadSetupState(statePath, fs);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.message).toContain("symlink");
    }
  });

  it("opens the checkpoint with no-follow non-blocking flags and reads through the descriptor", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    writeFileSync(statePath, JSON.stringify(projectState()), "utf8");
    const openFlags: number[] = [];
    const fs: SetupStateLoadFs = {
      lstatSync,
      openSync: (path, flags) => {
        openFlags.push(flags);
        return openSync(path, flags);
      },
      fstatSync,
      readFileSync,
      closeSync,
    };
    expect(loadSetupState(statePath, fs)).toStrictEqual({ status: "loaded", state: projectState() });
    const expected =
      constants.O_RDONLY |
      ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0) |
      ((constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0);
    expect(openFlags).toStrictEqual([expected]);
  });

  it("saves atomically with mode 0600 and no temp leftovers", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    saveSetupState(statePath, projectState());
    expect(existsSync(statePath)).toBe(true);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(tempLeftovers(dir, statePath)).toHaveLength(0);

    saveSetupState(statePath, spreadsheetState());
    const loaded = loadSetupState(statePath);
    expect(loaded).toStrictEqual({ status: "loaded", state: spreadsheetState() });
    expect(tempLeftovers(dir, statePath)).toHaveLength(0);
  });

  it("applies and verifies 0600 through the still-open temp descriptor and never pathname-chmods", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    let pathnameChmodCalls = 0;
    const fs: SetupStateWriteFs = {
      // Deliberately broad create mode: only the descriptor fchmod can make
      // the final file owner-only, proving the mode is applied on the
      // still-open descriptor rather than by the open-mode alone.
      openSync: (path, flags, mode) => openSync(path, flags, 0o666),
      fstatSync,
      fchmodSync,
      writeSync,
      fsyncSync,
      closeSync,
      lstatSync,
      unlinkSync,
      renameSync,
      openDirSync: (path, flags) => openSync(path, flags),
      fsyncDirSync: fsyncSync,
      chmodSync() {
        pathnameChmodCalls += 1;
        throw new Error("pathname chmod must never be used by the private temp write");
      },
    };
    saveSetupState(statePath, projectState(), undefined, fs);
    // The pathname chmod was never called and the descriptor-verified mode
    // is owner-only despite the broad create mode.
    expect(pathnameChmodCalls).toBe(0);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(loadSetupState(statePath)).toStrictEqual({ status: "loaded", state: projectState() });
    expect(tempLeftovers(dir, statePath)).toHaveLength(0);
  });

  it("loops on short writes until every UTF-8 byte is written (checkpoint, multibyte content)", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    // Multibyte title: a partial write may split a UTF-8 character mid-way,
    // so the write-all loop must resume at the exact byte offset.
    const state = projectState({ spreadsheetTitle: "hikoutei-π-日本語-слава" });
    const fs: SetupStateWriteFs = {
      openSync,
      fstatSync,
      fchmodSync,
      writeSync: (fd, buffer, offset, length, position) =>
        writeSync(fd, buffer, offset, Math.min(length, 7), position),
      fsyncSync,
      closeSync,
      lstatSync,
      unlinkSync,
      renameSync,
      openDirSync: (path, flags) => openSync(path, flags),
      fsyncDirSync: fsyncSync,
      chmodSync() {
        throw new Error("pathname chmod must never be used by the private temp write");
      },
    };
    saveSetupState(statePath, state, undefined, fs);
    expect(loadSetupState(statePath)).toStrictEqual({ status: "loaded", state });
    expect(tempLeftovers(dir, statePath)).toHaveLength(0);
  });

  it("fails safely on a zero-progress checkpoint write: no rename, destination unchanged, owned temp removed", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    saveSetupState(statePath, projectState());
    const destinationBefore = readFileSync(statePath, "utf8");
    const fs: SetupStateWriteFs = {
      openSync,
      fstatSync,
      fchmodSync,
      writeSync: () => 0,
      fsyncSync,
      closeSync,
      lstatSync,
      unlinkSync,
      renameSync,
      openDirSync: (path, flags) => openSync(path, flags),
      fsyncDirSync: fsyncSync,
      chmodSync() {
        throw new Error("pathname chmod must never be used by the private temp write");
      },
    };
    expect(() => saveSetupState(statePath, spreadsheetState(), undefined, fs)).toThrow();
    // The destination was NOT renamed or replaced and the owned temp inode
    // was cleaned up.
    expect(readFileSync(statePath, "utf8")).toBe(destinationBefore);
    expect(tempLeftovers(dir, statePath)).toHaveLength(0);
  });

  it("treats negative, non-integer, and over-remaining write counts as safe failures (checkpoint)", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    for (const written of [-1, 2.5, Number.POSITIVE_INFINITY]) {
      const fs: SetupStateWriteFs = {
        openSync,
        fstatSync,
        fchmodSync,
        writeSync: () => written,
        fsyncSync,
        closeSync,
        lstatSync,
        unlinkSync,
        renameSync,
        openDirSync: (path, flags) => openSync(path, flags),
        fsyncDirSync: fsyncSync,
        chmodSync() {
          throw new Error("pathname chmod must never be used by the private temp write");
        },
      };
      expect(() => saveSetupState(statePath, projectState(), undefined, fs)).toThrow();
      expect(existsSync(statePath)).toBe(false);
      expect(tempLeftovers(dir, statePath)).toHaveLength(0);
    }
    // More bytes than remain is a protocol failure, never a loop advance.
    const over: SetupStateWriteFs = {
      openSync,
      fstatSync,
      fchmodSync,
      writeSync: (_fd, _buffer, _offset, length) => length + 1,
      fsyncSync,
      closeSync,
      lstatSync,
      unlinkSync,
      renameSync,
      openDirSync: (path, flags) => openSync(path, flags),
      fsyncDirSync: fsyncSync,
      chmodSync() {
        throw new Error("pathname chmod must never be used by the private temp write");
      },
    };
    expect(() => saveSetupState(statePath, projectState(), undefined, over)).toThrow();
    expect(existsSync(statePath)).toBe(false);
    expect(tempLeftovers(dir, statePath)).toHaveLength(0);
  });

  it("cleans up the owned temp and rethrows when the post-write close fails (checkpoint); no rename, no double-close", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    saveSetupState(statePath, projectState());
    const destinationBefore = readFileSync(statePath, "utf8");
    let closeCalls = 0;
    const fs: SetupStateWriteFs = {
      openSync,
      fstatSync,
      fchmodSync,
      writeSync,
      fsyncSync,
      closeSync: (fd) => {
        closeCalls += 1;
        closeSync(fd); // The real close happens; then the failure is injected once.
        throw new Error("simulated close failure");
      },
      lstatSync,
      unlinkSync,
      renameSync: () => {
        throw new Error("rename must never run after a failed close");
      },
      openDirSync: (path, flags) => openSync(path, flags),
      fsyncDirSync: fsyncSync,
      chmodSync() {
        throw new Error("pathname chmod must never be used by the private temp write");
      },
    };
    expect(() => saveSetupState(statePath, spreadsheetState(), undefined, fs)).toThrow(
      /simulated close failure/,
    );
    // Exactly one close attempt (never a double-close), the destination was
    // not renamed or replaced, and the owned temp inode was removed.
    expect(closeCalls).toBe(1);
    expect(readFileSync(statePath, "utf8")).toBe(destinationBefore);
    expect(tempLeftovers(dir, statePath)).toHaveLength(0);
  });

  it("fsyncs the containing directory after the rename (durability) with no-follow flags and one close", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    const dirOpens: Array<{ path: string; flags: number }> = [];
    const dirFsyncs: number[] = [];
    const dirCloses: number[] = [];
    const fs: SetupStateWriteFs = {
      openSync,
      fstatSync,
      fchmodSync,
      writeSync,
      fsyncSync,
      closeSync: (fd) => {
        // Record the directory close (the fd that was fsynced as a
        // directory) before the real close runs.
        if (dirFsyncs.includes(fd) && !dirCloses.includes(fd)) {
          dirCloses.push(fd);
        }
        closeSync(fd);
      },
      lstatSync,
      unlinkSync,
      renameSync,
      openDirSync: (path, flags) => {
        dirOpens.push({ path, flags });
        return openSync(path, flags);
      },
      fsyncDirSync: (fd) => {
        dirFsyncs.push(fd);
        fsyncSync(fd);
      },
      chmodSync() {
        throw new Error("pathname chmod must never be used by the private temp write");
      },
    };
    saveSetupState(statePath, projectState(), undefined, fs);
    // The containing directory was opened AFTER the rename with the
    // no-follow + directory flags, fsynced once, and closed once.
    expect(dirOpens).toStrictEqual([
      {
        path: dir,
        flags:
          constants.O_RDONLY |
          ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0) |
          ((constants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0),
      },
    ]);
    expect(dirFsyncs).toHaveLength(1);
    expect(dirCloses).toStrictEqual([dirFsyncs[0]]);
    expect(loadSetupState(statePath)).toStrictEqual({ status: "loaded", state: projectState() });
    expect(tempLeftovers(dir, statePath)).toHaveLength(0);
  });

  it("reports a directory-fsync failure after the rename WITHOUT deleting the destination (next run sees the checkpoint)", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    let unlinkCalls = 0;
    let dirFsyncs = 0;
    const fs: SetupStateWriteFs = {
      openSync,
      fstatSync,
      fchmodSync,
      writeSync,
      fsyncSync,
      closeSync,
      lstatSync,
      unlinkSync: (path) => {
        unlinkCalls += 1;
        unlinkSync(path);
      },
      renameSync,
      openDirSync: (path, flags) => openSync(path, flags),
      fsyncDirSync: () => {
        dirFsyncs += 1;
        throw new Error("simulated directory fsync failure");
      },
      chmodSync() {
        throw new Error("pathname chmod must never be used by the private temp write");
      },
    };
    expect(() => saveSetupState(statePath, projectState(), undefined, fs)).toThrow(
      /simulated directory fsync failure/,
    );
    // The rename was NOT rolled back: the destination holds the new
    // checkpoint (the write-ahead must never be destroyed by a failed
    // durability step) and nothing of ours was unlinked.
    expect(loadSetupState(statePath)).toStrictEqual({ status: "loaded", state: projectState() });
    expect(dirFsyncs).toBe(1);
    expect(unlinkCalls).toBe(0);
    expect(tempLeftovers(dir, statePath)).toHaveLength(0);
  });

  it("applies and verifies 0600 through the still-open descriptor for the env temp write", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    let pathnameChmodCalls = 0;
    const fs: SetupStateWriteFs = {
      openSync: (path, flags, mode) => openSync(path, flags, 0o666),
      fstatSync,
      fchmodSync,
      writeSync,
      fsyncSync,
      closeSync,
      lstatSync,
      unlinkSync,
      renameSync,
      openDirSync: (path, flags) => openSync(path, flags),
      fsyncDirSync: fsyncSync,
      chmodSync() {
        pathnameChmodCalls += 1;
        throw new Error("pathname chmod must never be used by the private temp write");
      },
    };
    atomicWritePrivateFile(outputPath, "GOOGLE_APPLICATION_CREDENTIALS=/tmp/key.json\n", fs);
    expect(pathnameChmodCalls).toBe(0);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(outputPath, "utf8")).toBe("GOOGLE_APPLICATION_CREDENTIALS=/tmp/key.json\n");
  });

  it("loops on short writes until every UTF-8 byte is written (env, multibyte content)", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    // Multibyte credentials path: the env writer must work at the byte
    // level so a partial write can never corrupt the UTF-8 content.
    const content = `GOOGLE_APPLICATION_CREDENTIALS=/tmp/키-파일.json\nHIKOUTEI_SYNC_SPREADSHEET_URL=${SPREADSHEET_URL}\n`;
    const fs: SetupStateWriteFs = {
      openSync,
      fstatSync,
      fchmodSync,
      writeSync: (fd, buffer, offset, length, position) =>
        writeSync(fd, buffer, offset, Math.min(length, 5), position),
      fsyncSync,
      closeSync,
      lstatSync,
      unlinkSync,
      renameSync,
      openDirSync: (path, flags) => openSync(path, flags),
      fsyncDirSync: fsyncSync,
      chmodSync() {
        throw new Error("pathname chmod must never be used by the private temp write");
      },
    };
    atomicWritePrivateFile(outputPath, content, fs);
    expect(readFileSync(outputPath, "utf8")).toBe(content);
    expect(readdirSync(dir).some((name) => name.startsWith(".hikoutei-env-"))).toBe(false);
  });

  it("fails safely on a zero-progress env write: no rename, destination unchanged, owned temp removed", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    writeFileSync(outputPath, "PREEXISTING=1\n", "utf8");
    const fs: SetupStateWriteFs = {
      openSync,
      fstatSync,
      fchmodSync,
      writeSync: () => 0,
      fsyncSync,
      closeSync,
      lstatSync,
      unlinkSync,
      renameSync,
      openDirSync: (path, flags) => openSync(path, flags),
      fsyncDirSync: fsyncSync,
      chmodSync() {
        throw new Error("pathname chmod must never be used by the private temp write");
      },
    };
    expect(() => atomicWritePrivateFile(outputPath, "NEW=2\n", fs)).toThrow();
    // The destination is untouched and the owned temp was cleaned up.
    expect(readFileSync(outputPath, "utf8")).toBe("PREEXISTING=1\n");
    expect(readdirSync(dir).some((name) => name.startsWith(".hikoutei-env-"))).toBe(false);
  });

  it("cleans up the owned temp and rethrows when the post-write close fails (env); no rename, no double-close", () => {
    const dir = makeTempDir();
    const outputPath = join(dir, ".env");
    let closeCalls = 0;
    const fs: SetupStateWriteFs = {
      openSync,
      fstatSync,
      fchmodSync,
      writeSync,
      fsyncSync,
      closeSync: (fd) => {
        closeCalls += 1;
        closeSync(fd); // The real close happens; then the failure is injected once.
        throw new Error("simulated close failure");
      },
      lstatSync,
      unlinkSync,
      renameSync: () => {
        throw new Error("rename must never run after a failed close");
      },
      openDirSync: (path, flags) => openSync(path, flags),
      fsyncDirSync: fsyncSync,
      chmodSync() {
        throw new Error("pathname chmod must never be used by the private temp write");
      },
    };
    expect(() => atomicWritePrivateFile(outputPath, "NEW=2\n", fs)).toThrow(/simulated close failure/);
    // Exactly one close attempt (never a double-close), the destination
    // stays absent, the owned temp inode was removed, and rename never ran.
    expect(closeCalls).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith(".hikoutei-env-"))).toBe(false);
  });

  it("uses a unique per-run temp name so a crash orphan never blocks the next save", () => {
    const statePath = "/tmp/state.json";
    const a = uniqueSetupStateTempPath(statePath);
    const b = uniqueSetupStateTempPath(statePath);
    expect(a).not.toBe(b);
    expect(a.startsWith(`${statePath}${SETUP_STATE_TEMP_SUFFIX}`)).toBe(true);
    expect(a).toContain(String(process.pid));

    // Two sequential saves both succeed and leave no leftovers behind.
    const dir = makeTempDir();
    const realState = join(dir, SETUP_STATE_FILE_NAME);
    saveSetupState(realState, projectState());
    saveSetupState(realState, spreadsheetState());
    expect(tempLeftovers(dir, realState)).toHaveLength(0);
  });

  it("is not blocked by a stale fixed .tmp entry left by a crashed older run", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    const fixedTemp = setupStateTempPath(statePath);
    writeFileSync(fixedTemp, "stale-orphan", "utf8");

    // Unique per-run temp names make a stale fixed-name orphan inert: the
    // save proceeds and never requires the user to clear .tmp entries.
    saveSetupState(statePath, projectState());
    expect(loadSetupState(statePath)).toStrictEqual({ status: "loaded", state: projectState() });
    expect(readFileSync(fixedTemp, "utf8")).toBe("stale-orphan");
  });

  it("fails safely when a symlink already exists at the temp path (never follows or removes it)", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "attacker-target", "utf8");
    // A symlink at the temp path pointing at a reserved file: the atomic
    // save must refuse to write through the alias, leave it in place, and
    // fail safely instead of unlinking or following it. The explicit temp
    // path injects the planted entry; production saves use unique names.
    const tempPath = setupStateTempPath(statePath);
    symlinkSync(victim, tempPath);

    expect(() => saveSetupState(statePath, projectState(), tempPath)).toThrow();
    // The alias and its target are untouched; the checkpoint was not written.
    expect(readFileSync(victim, "utf8")).toBe("attacker-target");
    expect(lstatSync(tempPath).isSymbolicLink()).toBe(true);
    expect(existsSync(statePath)).toBe(false);
  });

  it("fails safely when a hardlink already exists at the temp path (never truncates or removes it)", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    const other = join(dir, "other-file.txt");
    writeFileSync(other, "hardlink-content", "utf8");
    // A hardlink at the temp path shares an inode with another file: an
    // overwrite would corrupt the other name, so the save must refuse and
    // leave both entries untouched. The explicit temp path injects the
    // planted entry; production saves use unique names.
    const tempPath = setupStateTempPath(statePath);
    linkSync(other, tempPath);

    expect(() => saveSetupState(statePath, projectState(), tempPath)).toThrow();
    expect(readFileSync(other, "utf8")).toBe("hardlink-content");
    expect(readFileSync(tempPath, "utf8")).toBe("hardlink-content");
    expect(statSync(tempPath).nlink).toBe(2);
    expect(existsSync(statePath)).toBe(false);
  });

  it("fails safely when a regular file already exists at the temp path (never overwrites it)", () => {
    const dir = makeTempDir();
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    // A planted real temp file is never silently overwritten: exclusive
    // acquisition fails and the file stays intact. The explicit temp path
    // injects the planted entry; production saves use unique names.
    const tempPath = setupStateTempPath(statePath);
    writeFileSync(tempPath, "leftover-temp", "utf8");

    expect(() => saveSetupState(statePath, projectState(), tempPath)).toThrow();
    expect(readFileSync(tempPath, "utf8")).toBe("leftover-temp");
    expect(existsSync(statePath)).toBe(false);
  });

  it("detects owner, project, sa-name, title, and key-path conflicts", () => {
    const state = spreadsheetState({ status: "complete" });
    const base = {
      projectId: undefined,
      saName: "hikoutei-sa",
      spreadsheetTitle: undefined,
      keyPath: "/tmp/hikoutei-service-account.json",
      ownerEmail: FAKE_OWNER,
    };
    expect(checkStateCompatibility(state, base)).toStrictEqual({ status: "ok" });
    expect(checkStateCompatibility(state, { ...base, ownerEmail: "other@example.com" }).status).toBe("conflict");
    expect(checkStateCompatibility(state, { ...base, projectId: "other-proj" }).status).toBe("conflict");
    expect(checkStateCompatibility(state, { ...base, saName: "other-sa" }).status).toBe("conflict");
    expect(checkStateCompatibility(state, { ...base, spreadsheetTitle: "Other Title" }).status).toBe("conflict");
    expect(checkStateCompatibility(state, { ...base, keyPath: "/other/key.json" }).status).toBe("conflict");
    // Matching explicit values are accepted.
    expect(
      checkStateCompatibility(state, {
        ...base,
        projectId: state.projectId,
        spreadsheetTitle: state.spreadsheetTitle,
      }),
    ).toStrictEqual({ status: "ok" });
    // Malformed CURRENT-RUN identifiers (option-like or invalid formats)
    // are refused as conflicts — defense in depth below the CLI parser.
    expect(checkStateCompatibility(state, { ...base, saName: "--flag" }).status).toBe("conflict");
    expect(checkStateCompatibility(state, { ...base, projectId: "--flag" }).status).toBe("conflict");
    expect(checkStateCompatibility(state, { ...base, projectId: "a" }).status).toBe("conflict");
  });

  it("validates service-account key metadata through the secure reader without exposing key material", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    writeFileSync(keyPath, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");
    expect(readServiceAccountKeySecurely(keyPath)).toStrictEqual({
      status: "ok",
      metadata: {
        projectId: "proj-1",
        clientEmail: "sa@proj-1.iam.gserviceaccount.com",
        keyId: FIXED_KEY_ID,
      },
    });
    // The descriptor-based read enforced owner-only mode 0600.
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    // A missing file is absent, not invalid.
    expect(readServiceAccountKeySecurely(join(dir, "missing.json"))).toStrictEqual({ status: "absent" });

    writeFileSync(
      keyPath,
      `{ "private_key": "${SECRET_KEY_MATERIAL.replaceAll("\n", "\\n")}", "x": ${FAKE_TOKEN} }`,
      "utf8",
    );
    const malformed = readServiceAccountKeySecurely(keyPath);
    expect(malformed).toStrictEqual({ status: "invalid", message: `${keyPath} is not valid JSON` });

    writeFileSync(keyPath, JSON.stringify({ type: "user", project_id: "p", client_email: "e", private_key: "k", private_key_id: FIXED_KEY_ID }), "utf8");
    expect(readServiceAccountKeySecurely(keyPath).status).toBe("invalid");

    writeFileSync(keyPath, JSON.stringify({ type: "service_account", project_id: "", client_email: "e", private_key: "k", private_key_id: FIXED_KEY_ID }), "utf8");
    expect(readServiceAccountKeySecurely(keyPath).status).toBe("invalid");

    // Missing or malformed private_key_id is rejected (the key id is the
    // non-secret link between the local file and the cloud key resource).
    writeFileSync(
      keyPath,
      JSON.stringify({ type: "service_account", project_id: "p", client_email: "e", private_key: RSA_PRIVATE_KEY_PEM }),
      "utf8",
    );
    expect(readServiceAccountKeySecurely(keyPath).status).toBe("invalid");
    writeFileSync(
      keyPath,
      JSON.stringify({ type: "service_account", project_id: "p", client_email: "e", private_key: RSA_PRIVATE_KEY_PEM, private_key_id: "not-hex" }),
      "utf8",
    );
    expect(readServiceAccountKeySecurely(keyPath).status).toBe("invalid");
    expect(SERVICE_ACCOUNT_KEY_ID_PATTERN.test(FIXED_KEY_ID)).toBe(true);
  });

  it("rejects symlinks, non-regular files, and chmod failures with owner-only enforcement", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    const victim = join(dir, "victim.json");
    writeFileSync(victim, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");

    // A symlink at the key path is refused; the target is untouched.
    symlinkSync(victim, keyPath);
    const symlinkResult = readServiceAccountKeySecurely(keyPath);
    expect(symlinkResult.status).toBe("invalid");
    if (symlinkResult.status === "invalid") {
      expect(symlinkResult.message).toContain("symlink");
      expect(symlinkResult.message).not.toContain("BEGIN PRIVATE KEY");
    }
    expect(readFileSync(victim, "utf8")).toBe(validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"));
    rmSync(keyPath, { force: true });

    // A directory at the key path is not a regular file and is refused.
    mkdirSync(keyPath, { mode: 0o700 });
    expect(readServiceAccountKeySecurely(keyPath).status).toBe("invalid");
    rmdirSync(keyPath);

    // A chmod failure fails closed before any content is promoted.
    writeFileSync(keyPath, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");
    const failingFs: KeyFileFs = {
      lstatSync,
      openSync,
      fchmodSync() {
        const error = new Error("EACCES") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
      fstatSync,
      readFileSync,
      closeSync,
    };
    const chmodResult = readServiceAccountKeySecurely(keyPath, failingFs);
    expect(chmodResult.status).toBe("invalid");
    if (chmodResult.status === "invalid") {
      expect(chmodResult.message).toContain("owner-only");
      expect(chmodResult.message).not.toContain("BEGIN PRIVATE KEY");
    }
  });

  it("returns invalid instead of throwing when the descriptor fstat or read fails (no thrown-text leak)", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    writeFileSync(keyPath, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");

    // A thrown fstat failure becomes a fixed invalid result, never an
    // uncaught throw and never a message carrying the thrown text.
    const fstatFs: KeyFileFs = {
      lstatSync,
      openSync,
      fchmodSync,
      fstatSync: () => {
        throw new Error(`fstat exploded ${SECRET_JWT} ${SECRET_KEY_MATERIAL}`);
      },
      readFileSync: () => {
        throw new Error("must never read after an fstat failure");
      },
      closeSync,
    };
    expect(readServiceAccountKeySecurely(keyPath, fstatFs)).toStrictEqual({
      status: "invalid",
      message: `could not verify owner-only permissions on ${keyPath}`,
    });

    // A thrown descriptor read failure is sanitized the same way.
    const readFs: KeyFileFs = {
      lstatSync,
      openSync,
      fchmodSync,
      fstatSync,
      readFileSync: () => {
        throw new Error(`read exploded ${SECRET_JWT} ${SECRET_KEY_MATERIAL}`);
      },
      closeSync,
    };
    expect(readServiceAccountKeySecurely(keyPath, readFs)).toStrictEqual({
      status: "invalid",
      message: `could not read ${keyPath}`,
    });
  });

  it("sanitizes lstat and open failures to stable path-only messages (no thrown-text leak, no stray calls)", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");

    // A thrown lstat failure (any non-ENOENT code) becomes a fixed invalid
    // result. The thrown text — even when it carries token/JWT/private-key
    // sentinels — must never reach the result, and open is never attempted.
    let openCalls = 0;
    const lstatFs: KeyFileFs = {
      lstatSync: () => {
        const error = new Error(`lstat exploded ${SECRET_JWT} ${SECRET_KEY_MATERIAL} ${FAKE_TOKEN}`) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
      openSync: (path, flags) => {
        openCalls += 1;
        return openSync(path, flags);
      },
      fchmodSync,
      fstatSync,
      readFileSync,
      closeSync,
    };
    const lstatResult = readServiceAccountKeySecurely(keyPath, lstatFs);
    expect(lstatResult).toStrictEqual({ status: "invalid", message: `could not inspect ${keyPath}` });
    expect(openCalls).toBe(0);
    const lstatSerialized = JSON.stringify(lstatResult);
    expect(lstatSerialized).not.toContain(SECRET_JWT);
    expect(lstatSerialized).not.toContain("BEGIN PRIVATE KEY");
    expect(lstatSerialized).not.toContain("SECRETKEYMATERIAL");
    expect(lstatSerialized).not.toContain(FAKE_TOKEN);
    expect(lstatSerialized).not.toContain("lstat exploded");

    // A thrown open failure (not ELOOP/EMLINK) becomes a fixed invalid
    // result. There is no descriptor to close, so close is never called
    // and nothing is read or chmod'ed.
    writeFileSync(keyPath, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");
    const closed: number[] = [];
    const openFs: KeyFileFs = {
      lstatSync,
      openSync: () => {
        const error = new Error(`open exploded ${SECRET_JWT} ${SECRET_KEY_MATERIAL}`) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
      fchmodSync: () => {
        throw new Error("must never chmod after an open failure");
      },
      fstatSync: () => {
        throw new Error("must never fstat after an open failure");
      },
      readFileSync: () => {
        throw new Error("must never read after an open failure");
      },
      closeSync: (fd) => {
        closed.push(fd);
      },
    };
    const openResult = readServiceAccountKeySecurely(keyPath, openFs);
    expect(openResult).toStrictEqual({ status: "invalid", message: `could not open ${keyPath}` });
    expect(closed).toHaveLength(0);
    const openSerialized = JSON.stringify(openResult);
    expect(openSerialized).not.toContain(SECRET_JWT);
    expect(openSerialized).not.toContain("BEGIN PRIVATE KEY");
    expect(openSerialized).not.toContain("SECRETKEYMATERIAL");
    expect(openSerialized).not.toContain("open exploded");

    // The safe ELOOP/EMLINK classification still maps to the symlink
    // refusal with no thrown-text forwarding.
    const loopFs: KeyFileFs = {
      lstatSync,
      openSync: () => {
        const error = new Error(`symlink loop ${SECRET_JWT}`) as NodeJS.ErrnoException;
        error.code = "ELOOP";
        throw error;
      },
      fchmodSync,
      fstatSync,
      readFileSync,
      closeSync,
    };
    const loopResult = readServiceAccountKeySecurely(keyPath, loopFs);
    expect(loopResult.status).toBe("invalid");
    if (loopResult.status === "invalid") {
      expect(loopResult.message).toContain("symlink");
      expect(loopResult.message).not.toContain(SECRET_JWT);
    }
  });

  it("closes the descriptor exactly once when the secured read fails", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    writeFileSync(keyPath, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");
    const closed: number[] = [];
    const fs: KeyFileFs = {
      lstatSync,
      openSync,
      fchmodSync,
      fstatSync,
      readFileSync: () => {
        throw new Error("read exploded");
      },
      closeSync: (fd) => {
        closed.push(fd);
        closeSync(fd);
      },
    };
    const result = readServiceAccountKeySecurely(keyPath, fs);
    expect(result.status).toBe("invalid");
    expect(closed).toHaveLength(1);
  });

  it("does not let a close failure override the safe invalid result or leak close text", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    writeFileSync(keyPath, "{ nope", "utf8");
    const fs: KeyFileFs = {
      lstatSync,
      openSync,
      fchmodSync,
      fstatSync,
      readFileSync: (fd, encoding) => readFileSync(fd, encoding),
      closeSync: (fd) => {
        closeSync(fd);
        throw new Error(`close exploded ${SECRET_JWT}`);
      },
    };
    expect(readServiceAccountKeySecurely(keyPath, fs)).toStrictEqual({
      status: "invalid",
      message: `${keyPath} is not valid JSON`,
    });
  });

  it("opens the key with O_RDONLY|O_NOFOLLOW|O_NONBLOCK (where defined)", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    writeFileSync(keyPath, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");
    let capturedFlags: number | undefined;
    const fs: KeyFileFs = {
      lstatSync,
      openSync: (path, flags) => {
        capturedFlags = flags;
        return openSync(path, flags);
      },
      fchmodSync,
      fstatSync,
      readFileSync,
      closeSync,
    };
    expect(readServiceAccountKeySecurely(keyPath, fs).status).toBe("ok");
    // O_RDONLY plus O_NOFOLLOW and O_NONBLOCK wherever the platform
    // defines them: a FIFO replacement between the lstat check and the
    // open must return from the open instead of blocking.
    const expected =
      constants.O_RDONLY |
      ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0) |
      ((constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0);
    expect(capturedFlags).toBe(expected);
  });

  it("refuses a FIFO or directory swapped in after the lstat check: no chmod, no read, one close", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    writeFileSync(keyPath, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");

    // Injected FIFO descriptor: the lstat check claimed a regular file
    // and the open "succeeded", but the descriptor is a FIFO. It must be
    // refused by the immediate descriptor fstat BEFORE any fchmod or read,
    // and the descriptor must be closed exactly once.
    const fifoClosed: number[] = [];
    const fifoFs: KeyFileFs = {
      lstatSync: () => fakeRegularFileStats(),
      openSync: () => 41,
      fchmodSync: () => {
        throw new Error(`must never chmod a FIFO ${SECRET_KEY_MATERIAL}`);
      },
      fstatSync: () => fakeFifoStats(),
      readFileSync: () => {
        throw new Error(`must never read a FIFO ${SECRET_KEY_MATERIAL}`);
      },
      closeSync: (fd) => {
        fifoClosed.push(fd);
      },
    };
    expect(readServiceAccountKeySecurely(keyPath, fifoFs)).toStrictEqual({
      status: "invalid",
      message: `${keyPath} is not a regular file; remove it and retry`,
    });
    expect(fifoClosed).toStrictEqual([41]);

    // Real directory replacement: the open actually opens a directory, so
    // the descriptor fstat refuses it and the directory's mode is never
    // changed through this descriptor.
    const dirPath = join(dir, "dir-replacement");
    mkdirSync(dirPath, { mode: 0o755 });
    const dirFs: KeyFileFs = {
      lstatSync: () => fakeRegularFileStats(),
      openSync,
      fchmodSync: () => {
        throw new Error(`must never chmod a directory replacement ${SECRET_JWT}`);
      },
      fstatSync,
      readFileSync: () => {
        throw new Error(`must never read a directory replacement ${SECRET_JWT}`);
      },
      closeSync,
    };
    const dirResult = readServiceAccountKeySecurely(dirPath, dirFs);
    expect(dirResult.status).toBe("invalid");
    if (dirResult.status === "invalid") {
      expect(dirResult.message).toContain("not a regular file");
      expect(dirResult.message).not.toContain(SECRET_JWT);
    }
    expect(statSync(dirPath).mode & 0o777).toBe(0o755);
  });

  it("refuses a DIFFERENT regular file swapped in after the lstat check: no chmod, no read, one close", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    writeFileSync(keyPath, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");

    // Injected replacement: the lstat observed one inode, but the opened
    // descriptor is a DIFFERENT regular file. The dev/ino binding must
    // refuse it BEFORE any fchmod or read, and the descriptor must be
    // closed exactly once.
    const closed: number[] = [];
    const fs: KeyFileFs = {
      lstatSync: () => fakeRegularFileStats(),
      openSync: () => 55,
      fchmodSync: () => {
        throw new Error(`must never chmod a replaced file ${SECRET_KEY_MATERIAL}`);
      },
      fstatSync: () => ({ ...fakeRegularFileStats(), ino: 999 }),
      readFileSync: () => {
        throw new Error(`must never read a replaced file ${SECRET_JWT}`);
      },
      closeSync: (fd) => {
        closed.push(fd);
      },
    };
    expect(readServiceAccountKeySecurely(keyPath, fs)).toStrictEqual({
      status: "invalid",
      message: `${keyPath} changed while being read; remove it and retry`,
    });
    expect(closed).toStrictEqual([55]);
  });

  it("promotes validated key credentials into memory through the secure boundary (never key material in results)", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    writeFileSync(keyPath, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");
    const result = readServiceAccountKeyCredentialSecurely(keyPath);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.credentials).toStrictEqual({
        projectId: "proj-1",
        clientEmail: "sa@proj-1.iam.gserviceaccount.com",
        privateKey: RSA_PRIVATE_KEY_PEM,
      });
    }
    // The metadata reader agrees with the credential reader (same boundary).
    expect(readServiceAccountKeySecurely(keyPath)).toStrictEqual({
      status: "ok",
      metadata: {
        projectId: "proj-1",
        clientEmail: "sa@proj-1.iam.gserviceaccount.com",
        keyId: FIXED_KEY_ID,
      },
    });
    // The descriptor read enforced owner-only mode 0600.
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    // Absent and invalid map identically to the metadata reader.
    expect(readServiceAccountKeyCredentialSecurely(join(dir, "missing.json"))).toStrictEqual({
      status: "absent",
    });
    writeFileSync(keyPath, `{ "private_key": "${SECRET_KEY_MATERIAL.replaceAll("\n", "\\n")}" }`, "utf8");
    const malformed = readServiceAccountKeyCredentialSecurely(keyPath);
    expect(malformed.status).toBe("invalid");
    if (malformed.status === "invalid") {
      // Never key material, never raw parse text.
      expect(malformed.message).not.toContain("BEGIN PRIVATE KEY");
      expect(malformed.message).not.toContain("SECRETKEYMATERIAL");
    }
    // A symlink is refused the same way.
    rmSync(keyPath, { force: true });
    const victim = join(dir, "victim.json");
    writeFileSync(victim, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");
    symlinkSync(victim, keyPath);
    expect(readServiceAccountKeyCredentialSecurely(keyPath).status).toBe("invalid");
  });

  it("returns promptly on a real FIFO at the key path (never blocks)", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    try {
      spawnSync("mkfifo", [keyPath], { stdio: "ignore" });
    } catch {
      return; // platform without mkfifo: nothing to exercise
    }
    if (!existsSync(keyPath)) {
      return; // mkfifo unavailable or failed: skip on this platform
    }
    const started = Date.now();
    const result = readServiceAccountKeySecurely(keyPath);
    // The lstat type check refuses the FIFO outright (and O_NONBLOCK would
    // keep a mid-run FIFO swap from blocking the open): never a hang.
    expect(result.status).toBe("invalid");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("corrects a reused 0644 key to 0600 through the descriptor", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    writeFileSync(keyPath, validKeyJson("existing-proj", "hikoutei-sa@existing-proj.iam.gserviceaccount.com"), {
      encoding: "utf8",
      mode: 0o644,
    });
    expect(statSync(keyPath).mode & 0o777).toBe(0o644);
    const result = readServiceAccountKeySecurely(keyPath);
    expect(result.status).toBe("ok");
    // The mode was corrected through the open descriptor, not via a
    // separate check-then-chmod sequence.
    expect(statSync(keyPath).mode & 0o777).toBe(SERVICE_ACCOUNT_KEY_FILE_MODE);
  });

  it("rejects non-empty malformed private keys and non-RSA key types before any mutation", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    const base = {
      type: "service_account",
      project_id: "proj-1",
      client_email: "sa@proj-1.iam.gserviceaccount.com",
      private_key_id: FIXED_KEY_ID,
    };

    // Non-empty but malformed PEM: must be rejected by the crypto check.
    writeFileSync(
      keyPath,
      JSON.stringify({
        ...base,
        private_key: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key-material\n-----END PRIVATE KEY-----\n",
      }),
      "utf8",
    );
    const malformed = readServiceAccountKeySecurely(keyPath);
    expect(malformed.status).toBe("invalid");
    if (malformed.status === "invalid") {
      // The failure message never includes the key material.
      expect(malformed.message).not.toContain("not-a-real-key-material");
    }

    // A valid but non-RSA (EC) key is rejected too.
    const { privateKey: ecPem } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(
      keyPath,
      JSON.stringify({
        ...base,
        private_key: ecPem.export({ type: "pkcs8", format: "pem" }).toString().trim(),
      }),
      "utf8",
    );
    expect(readServiceAccountKeySecurely(keyPath).status).toBe("invalid");

    // Valid RSA metadata that belongs to a different project is still
    // returned; the flow rejects the mismatch before any mutation.
    writeFileSync(keyPath, JSON.stringify({ ...base, private_key: RSA_PRIVATE_KEY_PEM }), "utf8");
    expect(readServiceAccountKeySecurely(keyPath)).toStrictEqual({
      status: "ok",
      metadata: {
        projectId: "proj-1",
        clientEmail: "sa@proj-1.iam.gserviceaccount.com",
        keyId: FIXED_KEY_ID,
      },
    });
  });

  it("parses the raw key JSON without filesystem access", () => {
    const ok = parseServiceAccountKeyJson(validKeyJson("p", "sa@p.iam.gserviceaccount.com"), "fixture");
    expect(ok).toStrictEqual({
      status: "ok",
      metadata: { projectId: "p", clientEmail: "sa@p.iam.gserviceaccount.com", keyId: FIXED_KEY_ID },
    });
    expect(parseServiceAccountKeyJson("{ bad", "fixture").status).toBe("invalid");
    expect(parseServiceAccountKeyJson("null", "fixture").status).toBe("invalid");

    // Malformed key JSON carrying token-like and key-like text must never
    // leak the parse exception text (Node's JSON.parse failures can include
    // a snippet of the input).
    const malformed = `{ "private_key": "${SECRET_KEY_MATERIAL.replaceAll("\n", "\\n")}", "x": ${FAKE_TOKEN} }`;
    const sentinelResult = parseServiceAccountKeyJson(malformed, "fixture");
    expect(sentinelResult).toStrictEqual({ status: "invalid", message: "fixture is not valid JSON" });
  });
});

describe("setup lock", () => {
  function lockPathFor(dir: string): string {
    return setupLockPath(join(dir, SETUP_STATE_FILE_NAME));
  }

  it("acquires and releases an empty 0700 directory exclusively", () => {
    const dir = makeTempDir();
    const lockPath = lockPathFor(dir);
    const lock = acquireSetupLock(lockPath);
    expect(lock.status).toBe("held");
    if (lock.status !== "held") return;

    expect(lstatSync(lockPath).isDirectory()).toBe(true);
    expect(statSync(lockPath).mode & 0o777).toBe(0o700);
    // The lock holds no metadata at all: an empty directory.
    expect(readdirSync(lockPath)).toHaveLength(0);

    // A second acquire while held is busy and never touches the lock.
    expect(acquireSetupLock(lockPath).status).toBe("busy");
    expect(lstatSync(lockPath).isDirectory()).toBe(true);
    expect(readdirSync(lockPath)).toHaveLength(0);

    releaseSetupLock(lockPath, lock.identity);
    expect(existsSync(lockPath)).toBe(false);
    // Releasing again (or with a stale identity) is a no-op.
    releaseSetupLock(lockPath, lock.identity);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("fails as busy for ANY pre-existing entry and keeps it untouched", () => {
    const dir = makeTempDir();
    const lockPath = lockPathFor(dir);
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "victim-content", "utf8");

    // Regular file at the lock path.
    writeFileSync(lockPath, "{ not json", "utf8");
    let lock = acquireSetupLock(lockPath);
    expect(lock.status).toBe("busy");
    if (lock.status === "busy") {
      expect(lock.message).toContain("another hikoutei setup appears to be running");
      expect(lock.message).toContain("lock directory");
      expect(lock.message).toContain("never removed automatically");
    }
    expect(readFileSync(lockPath, "utf8")).toBe("{ not json");

    // Symlink at the lock path (to a file): never followed or removed.
    rmSync(lockPath, { force: true });
    symlinkSync(victim, lockPath);
    lock = acquireSetupLock(lockPath);
    expect(lock.status).toBe("busy");
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim, "utf8")).toBe("victim-content");

    // Directory at the lock path (a live or crashed run's lock): the
    // existing lock is never read, removed, or replaced.
    rmSync(lockPath, { force: true });
    mkdirSync(lockPath, { mode: 0o700 });
    lock = acquireSetupLock(lockPath);
    expect(lock.status).toBe("busy");
    expect(lstatSync(lockPath).isDirectory()).toBe(true);
    expect(readdirSync(lockPath)).toHaveLength(0);
  });

  it("classifies EEXIST as busy and other mkdir failures as failed", () => {
    const dir = makeTempDir();
    const lockPath = lockPathFor(dir);
    const throwingFs = (code: string): LockFs => ({
      mkdirSync() {
        const error = new Error(code) as NodeJS.ErrnoException;
        error.code = code;
        throw error;
      },
      openSync() {
        throw new Error("unreachable");
      },
      fstatSync() {
        throw new Error("unreachable");
      },
      closeSync() {
        throw new Error("unreachable");
      },
      rmdirSync() {
        throw new Error("unreachable");
      },
    });

    const busy = acquireSetupLock(lockPath, throwingFs("EEXIST"));
    expect(busy.status).toBe("busy");
    if (busy.status === "busy") {
      expect(busy.message).toContain("another hikoutei setup");
    }

    // EACCES/ENOENT/EPERM/EROFS are lock FAILURES, never busy.
    for (const code of ["EACCES", "ENOENT", "EPERM", "EROFS"]) {
      const failed = acquireSetupLock(lockPath, throwingFs(code));
      expect(failed.status).toBe("failed");
      if (failed.status === "failed") {
        expect(failed.message).toContain("could not create the setup lock directory");
        expect(failed.message).not.toContain("another hikoutei setup");
      }
    }
  });

  it("fails closed when the created directory cannot be verified and removes it", () => {
    const dir = makeTempDir();
    const lockPath = lockPathFor(dir);
    let removed = false;
    let closed = 0;
    const failingFs: LockFs = {
      mkdirSync() {},
      openSync: () => 41,
      fstatSync() {
        throw new Error("stat failed");
      },
      closeSync() {
        closed += 1;
      },
      rmdirSync(path: string) {
        expect(path).toBe(lockPath);
        removed = true;
      },
    };
    const result = acquireSetupLock(lockPath, failingFs);
    expect(result.status).toBe("failed");
    expect(removed).toBe(true);
    // The opened descriptor is closed again on the failed acquire.
    expect(closed).toBe(1);
  });

  it("fails closed when the created directory cannot be opened and removes it", () => {
    const dir = makeTempDir();
    const lockPath = lockPathFor(dir);
    let removed = false;
    const failingFs: LockFs = {
      mkdirSync() {},
      openSync() {
        const error = new Error("EACCES") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      },
      fstatSync() {
        throw new Error("unreachable");
      },
      closeSync() {
        throw new Error("unreachable");
      },
      rmdirSync(path: string) {
        expect(path).toBe(lockPath);
        removed = true;
      },
    };
    const result = acquireSetupLock(lockPath, failingFs);
    expect(result.status).toBe("failed");
    expect(removed).toBe(true);
  });

  it("releases only the exact directory this run created (identity-verified)", () => {
    const dir = makeTempDir();
    const lockPath = lockPathFor(dir);
    const lock = acquireSetupLock(lockPath);
    expect(lock.status).toBe("held");
    if (lock.status !== "held") return;

    // A foreign actor replaced the lock directory with a new one; our
    // release must not delete the replacement. The held owner descriptor
    // pins the original inode, so the replacement can never match even on
    // filesystems that would otherwise recycle inode numbers after rmdir.
    rmdirSync(lockPath);
    mkdirSync(lockPath, { mode: 0o700 });
    releaseSetupLock(lockPath, lock.identity);
    expect(existsSync(lockPath)).toBe(true);
    expect(lstatSync(lockPath).isDirectory()).toBe(true);
  });

  it("never deletes a lock re-acquired after release by an earlier identity", () => {
    const dir = makeTempDir();
    const lockPath = lockPathFor(dir);
    const first = acquireSetupLock(lockPath);
    expect(first.status).toBe("held");
    if (first.status !== "held") return;
    releaseSetupLock(lockPath, first.identity);
    expect(existsSync(lockPath)).toBe(false);

    // A second process acquires a fresh lock after our release.
    const second = acquireSetupLock(lockPath);
    expect(second.status).toBe("held");
    if (second.status !== "held") return;

    // Releasing with the FIRST run's identity must not delete the second
    // process's lock: the first identity's owner descriptor was closed by
    // its own release, so ownership cannot be proven even if the
    // filesystem reused the first directory's device/inode numbers.
    releaseSetupLock(lockPath, first.identity);
    expect(existsSync(lockPath)).toBe(true);
    expect(lstatSync(lockPath).isDirectory()).toBe(true);

    releaseSetupLock(lockPath, second.identity);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("fails closed when the path descriptor differs from the owned descriptor (injected race)", () => {
    const dir = makeTempDir();
    const lockPath = lockPathFor(dir);
    // Acquire through a transparent wrapper around the real filesystem so
    // the test knows the exact descriptor number the registry holds for
    // this run: every operation is the production one (the real directory
    // is really created, opened, verified, and held), only the number is
    // captured.
    let ownedFd = -1;
    const acquireFs: LockFs = {
      mkdirSync: (path, options) => mkdirSync(path, options),
      openSync: (path, flags) => {
        ownedFd = openSync(path, flags);
        return ownedFd;
      },
      fstatSync,
      closeSync,
      rmdirSync,
    };
    const lock = acquireSetupLock(lockPath, acquireFs);
    expect(lock.status).toBe("held");
    if (lock.status !== "held") return;
    expect(ownedFd).toBeGreaterThanOrEqual(0);

    // Injected replacement: the lock path now opens as a DIFFERENT
    // directory than the owned descriptor refers to (a foreign lock
    // acquired after this run's directory was removed). Release must fail
    // closed — the replacement is never rmdir'd — and both descriptors
    // are closed again, exactly once each: first the path descriptor,
    // then the owned descriptor, whose number the test knows exactly. The
    // real owned descriptor is actually closed so the test leaks no
    // descriptor.
    let rmdirCalls = 0;
    const closed: number[] = [];
    // A fake path descriptor derived from the captured owned number, so
    // it is provably different from the real owned descriptor.
    const FAKE_PATH_FD = ownedFd + 4096;
    const fs: LockFs = {
      mkdirSync: () => {
        throw new Error("unreachable");
      },
      openSync: () => FAKE_PATH_FD,
      fstatSync: (fd: number) =>
        fd === FAKE_PATH_FD
          ? {
              // A guaranteed-different foreign directory identity.
              dev: lock.identity.dev + 1,
              ino: lock.identity.ino + 1,
              isDirectory: () => true,
            }
          : { dev: lock.identity.dev, ino: lock.identity.ino, isDirectory: () => true },
      closeSync: (fd: number) => {
        closed.push(fd);
        if (fd === ownedFd) {
          // Forward the real close exactly once so the held directory
          // descriptor the test acquired is not leaked; a second close of
          // the same descriptor would throw here and fail the test.
          closeSync(fd);
        } else if (fd !== FAKE_PATH_FD) {
          throw new Error(`release closed an unexpected descriptor ${fd}`);
        }
      },
      rmdirSync: () => {
        rmdirCalls += 1;
      },
    };
    releaseSetupLock(lockPath, lock.identity, fs);
    expect(rmdirCalls).toBe(0);
    // The fake path descriptor and the real owned descriptor are each
    // closed exactly once, in that order: the exact owned number proves
    // the second close is the owned descriptor (not a repeated path
    // close), and the strict array length proves neither is closed twice.
    expect(closed).toStrictEqual([FAKE_PATH_FD, ownedFd]);
    // The replacement (foreign) lock directory is still in place.
    expect(existsSync(lockPath)).toBe(true);
    expect(lstatSync(lockPath).isDirectory()).toBe(true);
    // The registry entry was dropped: releasing again with the same
    // identity (now stale) is a no-op that touches nothing — the real
    // owned descriptor is already closed and is never closed twice.
    releaseSetupLock(lockPath, lock.identity);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("fails closed when the lock path cannot be opened as a directory (replaced by a file/symlink)", () => {
    const dir = makeTempDir();
    const lockPath = lockPathFor(dir);
    const lock = acquireSetupLock(lockPath);
    expect(lock.status).toBe("held");
    if (lock.status !== "held") return;

    // Injected replacement: the path no longer opens as a directory (for
    // example a symlink planted at the lock path). Nothing is removed;
    // the owned descriptor is closed (and the registry entry dropped)
    // because the lock is gone either way.
    let rmdirCalls = 0;
    let closeCalls = 0;
    const fs: LockFs = {
      mkdirSync: () => {
        throw new Error("unreachable");
      },
      openSync: () => {
        const error = new Error("ENOTDIR") as NodeJS.ErrnoException;
        error.code = "ENOTDIR";
        throw error;
      },
      fstatSync: () => ({
        dev: lock.identity.dev,
        ino: lock.identity.ino,
        isDirectory: () => true,
      }),
      closeSync: (fd: number) => {
        closeCalls += 1;
        closeSync(fd);
      },
      rmdirSync: () => {
        rmdirCalls += 1;
      },
    };
    releaseSetupLock(lockPath, lock.identity, fs);
    expect(rmdirCalls).toBe(0);
    // Only the owned descriptor is closed; nothing was opened at the path.
    expect(closeCalls).toBe(1);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("closes the owned descriptor exactly once when its fstat fails (injected)", () => {
    const dir = makeTempDir();
    const lockPath = lockPathFor(dir);
    const lock = acquireSetupLock(lockPath);
    expect(lock.status).toBe("held");
    if (lock.status !== "held") return;

    // Injected failure: the owned descriptor's fstat throws (for example
    // the descriptor turned invalid mid-release). Ownership cannot be
    // proven, so the release fails closed — the path is never opened and
    // the lock directory is never removed — but the owned descriptor is
    // still closed exactly once BEFORE the registry entry is dropped, so
    // a still-valid descriptor never leaks.
    let rmdirCalls = 0;
    let opened = 0;
    let closeCalls = 0;
    const fs: LockFs = {
      mkdirSync: () => {
        throw new Error("unreachable");
      },
      openSync: () => {
        opened += 1;
        throw new Error("unreachable");
      },
      fstatSync: () => {
        throw new Error("owned descriptor fstat failed");
      },
      closeSync: (fd: number) => {
        closeCalls += 1;
        // Forward to the real close so the held directory descriptor the
        // test acquired is not leaked.
        closeSync(fd);
      },
      rmdirSync: () => {
        rmdirCalls += 1;
      },
    };
    releaseSetupLock(lockPath, lock.identity, fs);
    // Fail closed: the path was never opened and nothing was removed on
    // the unprovable identity.
    expect(opened).toBe(0);
    expect(rmdirCalls).toBe(0);
    // The owned descriptor is closed exactly once (no double close).
    expect(closeCalls).toBe(1);
    // The real lock directory is still in place.
    expect(existsSync(lockPath)).toBe(true);
    expect(lstatSync(lockPath).isDirectory()).toBe(true);

    // The registry entry was dropped: releasing again with the same
    // identity (now stale) is a no-op that touches nothing.
    releaseSetupLock(lockPath, lock.identity);
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe("human auth", () => {
  function runnerReturning(stdout: string): GcloudRunner {
    return {
      async run(args: readonly string[]): Promise<GcloudRunResult> {
        if (args[0] === "auth") {
          return { status: "ok", stdout, stderr: "" };
        }
        return { status: "ok", stdout: "", stderr: "" };
      },
    };
  }

  const okValidator: TokenValidator = {
    async validate(_token: string): Promise<TokenInfo> {
      return { email: FAKE_OWNER, scope: DRIVE_SCOPE };
    },
  };

  it("returns the memory-only token and owner when Drive scope is present", async () => {
    const result = await checkHumanDriveAccess(runnerReturning(`${FAKE_TOKEN}\n`), okValidator);
    expect(result).toStrictEqual({ status: "ok", accessToken: FAKE_TOKEN, ownerEmail: FAKE_OWNER });
  });

  it("accepts the drive.file scope as sufficient", () => {
    expect(hasDriveScope(`${DRIVE_SCOPE} https://www.googleapis.com/auth/spreadsheets`)).toBe(true);
    expect(hasDriveScope(`${DRIVE_FILE_SCOPE} https://www.googleapis.com/auth/spreadsheets`)).toBe(true);
    expect(hasDriveScope("https://www.googleapis.com/auth/spreadsheets")).toBe(false);
    expect(hasDriveScope("")).toBe(false);
  });

  it("fails with gcloud_drive_access_required and the exact re-login command when scope is missing", async () => {
    const validator: TokenValidator = {
      async validate() {
        return { email: FAKE_OWNER, scope: "https://www.googleapis.com/auth/spreadsheets" };
      },
    };
    const result = await checkHumanDriveAccess(runnerReturning(`${FAKE_TOKEN}\n`), validator);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.code).toBe(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED);
      expect(result.message).toContain(`gcloud ${DRIVE_ACCESS_COMMAND.join(" ")}`);
      expect(result.message).not.toContain(FAKE_TOKEN);
    }
  });

  it("fails with user_token_failed when the token cannot be validated", async () => {
    const failingValidator: TokenValidator = {
      async validate() {
        throw new Error("tokeninfo refused the token");
      },
    };
    const result = await checkHumanDriveAccess(runnerReturning(`${FAKE_TOKEN}\n`), failingValidator);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.code).toBe(SETUP_ERROR_CODES.USER_TOKEN_FAILED);
      expect(result.message).not.toContain(FAKE_TOKEN);
    }
  });

  it("fails with user_token_failed when token retrieval fails or is malformed", async () => {
    const failedRunner: GcloudRunner = {
      async run() {
        return failed(1, "auth failed");
      },
    };
    const notFoundRunner: GcloudRunner = {
      async run() {
        return { status: "not_found" };
      },
    };
    for (const runner of [failedRunner, notFoundRunner, runnerReturning(""), runnerReturning("line1\nline2\n")]) {
      const result = await checkHumanDriveAccess(runner, okValidator);
      expect(result.status).toBe("error");
      if (result.status === "error") {
        expect(result.code).toBe(SETUP_ERROR_CODES.USER_TOKEN_FAILED);
      }
    }
  });

  it("never forwards raw gcloud streams for token failures (status-only message)", async () => {
    // Even when stdout/stderr carry the token, a JWT, or credentials, the
    // failure message exposes only the exit status.
    const leakyRunner: GcloudRunner = {
      async run() {
        return failed(1, `${FAKE_TOKEN}\n${SECRET_JWT}\n${SECRET_AUTHORIZATION}`);
      },
    };
    const result = await checkHumanDriveAccess(leakyRunner, okValidator);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("status 1");
      expect(result.message).not.toContain(FAKE_TOKEN);
      expect(result.message).not.toContain(SECRET_JWT);
      expect(result.message).not.toContain("Authorization");
      expect(result.message).not.toContain("ya29");
    }

    const leakyStdoutRunner: GcloudRunner = {
      async run() {
        return { status: "failed", code: 1, stdout: `${SECRET_KEY_MATERIAL}\n${SECRET_AUTHORIZATION}`, stderr: "" };
      },
    };
    const stdoutResult = await checkHumanDriveAccess(leakyStdoutRunner, okValidator);
    expect(stdoutResult.status).toBe("error");
    if (stdoutResult.status === "error") {
      expect(stdoutResult.message).not.toContain("BEGIN PRIVATE KEY");
      expect(stdoutResult.message).not.toContain("Authorization");
    }
  });

  it("validates tokeninfo payloads with runtime guards", () => {
    expect(extractTokenInfo({ email: FAKE_OWNER, scope: DRIVE_SCOPE })).toStrictEqual({
      email: FAKE_OWNER,
      scope: DRIVE_SCOPE,
    });
    expect(() => extractTokenInfo(null)).toThrow();
    expect(() => extractTokenInfo({})).toThrow();
    expect(() => extractTokenInfo({ email: "", scope: DRIVE_SCOPE })).toThrow();
    expect(() => extractTokenInfo({ email: FAKE_OWNER, scope: "" })).toThrow();
    expect(() => extractTokenInfo({ email: 42, scope: DRIVE_SCOPE })).toThrow();
  });

  it("rejects control/secret-like emails with a strict printable format (never echoed)", async () => {
    // A strict dedicated email pattern: whitespace, control characters, and
    // newlines anywhere in the email are refused, so a control-bearing
    // email can never smuggle secret-like text into the checkpoint, a
    // summary, or a message.
    for (const email of [
      "owner@example.com\nSECRET",
      "owner@example.com\rSECRET",
      "owner@example.com\u0000SECRET",
      "owner@example.com\tSECRET",
      " owner@example.com",
      "owner@example.com ",
      "owner @example.com",
      "owner@example .com",
      "owner@@example.com",
      "@example.com",
      "owner@",
      "owner@example",
      "owner@.com",
      "owner@-example.com",
      "\u007fowner@example.com",
      "SECRET\nowner@example.com",
    ]) {
      expect(() => extractTokenInfo({ email, scope: DRIVE_SCOPE })).toThrow();
      expect(isValidGoogleAccountEmail(email)).toBe(false);
    }
    // The pattern is a dedicated email check: it matches ordinary Google
    // account emails (plus aliases) and nothing else.
    expect(GOOGLE_ACCOUNT_EMAIL_PATTERN.test(FAKE_OWNER)).toBe(true);
    expect(GOOGLE_ACCOUNT_EMAIL_PATTERN.test("first.last+tag@sub.example.co")).toBe(true);
    expect(isValidGoogleAccountEmail(FAKE_OWNER)).toBe(true);

    // The flow boundary refuses a malformed email from ANY validator
    // (the injectable one included) with user_token_failed and never
    // echoes the raw email.
    const evil = "owner@example.com\nSECRET-PAYLOAD";
    const evilValidator: TokenValidator = {
      async validate() {
        return { email: evil, scope: DRIVE_SCOPE };
      },
    };
    const result = await checkHumanDriveAccess(runnerReturning(`${FAKE_TOKEN}\n`), evilValidator);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.code).toBe(SETUP_ERROR_CODES.USER_TOKEN_FAILED);
      expect(result.message).not.toContain(evil);
      expect(result.message).not.toContain("SECRET-PAYLOAD");
    }
    // A control-bearing email from the flow validator is refused the same
    // way, and the valid owner still passes.
    const controlValidator: TokenValidator = {
      async validate() {
        return { email: "owner@example.com\u0000SECRET", scope: DRIVE_SCOPE };
      },
    };
    const control = await checkHumanDriveAccess(runnerReturning(`${FAKE_TOKEN}\n`), controlValidator);
    expect(control.status).toBe("error");
    if (control.status === "error") {
      expect(control.code).toBe(SETUP_ERROR_CODES.USER_TOKEN_FAILED);
    }
    const ok = await checkHumanDriveAccess(runnerReturning(`${FAKE_TOKEN}\n`), okValidator);
    expect(ok).toStrictEqual({ status: "ok", accessToken: FAKE_TOKEN, ownerEmail: FAKE_OWNER });
  });

  it("posts the token to tokeninfo and promotes the validated response", async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ email: FAKE_OWNER, scope: DRIVE_SCOPE }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const validator = createTokeninfoValidator(fetchImpl);
    const info = await validator.validate(FAKE_TOKEN);
    expect(info).toStrictEqual({ email: FAKE_OWNER, scope: DRIVE_SCOPE });
    expect(capturedUrl).toBe(TOKENINFO_URL);
    expect(capturedInit?.method).toBe("POST");
    expect(String(capturedInit?.body)).toBe(`access_token=${encodeURIComponent(FAKE_TOKEN)}`);
  });

  it("fails token validation on non-OK and malformed tokeninfo responses", async () => {
    const nonOkFetch: typeof fetch = async () => new Response("invalid_grant", { status: 400 });
    await expect(createTokeninfoValidator(nonOkFetch).validate(FAKE_TOKEN)).rejects.toThrow("HTTP 400");

    const malformedFetch: typeof fetch = async () =>
      new Response("{ not json", { status: 200, headers: { "content-type": "application/json" } });
    await expect(createTokeninfoValidator(malformedFetch).validate(FAKE_TOKEN)).rejects.toThrow();
  });
});

describe("sheets factory guards", () => {
  it("builds the create request with the marker in appProperties and asks for appProperties in fields", () => {
    const request = buildDriveFileCreateRequest("My Sheet", VALID_MARKER);
    expect(request.requestBody).toStrictEqual({
      name: "My Sheet",
      mimeType: SPREADSHEET_MIME_TYPE,
      appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: VALID_MARKER },
    });
    // The response fields must include appProperties so the create result
    // can be validated against the expected marker.
    expect(request.fields).toContain("appProperties");
    expect(request.fields).toContain("id");
    expect(request.fields).toContain("name");
    expect(request.fields).toContain("mimeType");
    // A malformed marker is refused before it reaches the request shape.
    expect(() => buildDriveFileCreateRequest("My Sheet", "not-a-marker")).toThrow();
  });

  it("promotes drive.files.create payloads: non-empty id, spreadsheet mime, matching name, exact marker", () => {
    const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: "abc",
      name: "My Sheet",
      mimeType: SPREADSHEET_MIME_TYPE,
      appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: VALID_MARKER },
      ...overrides,
    });
    expect(extractDriveFileCreateResult(payload(), "My Sheet", VALID_MARKER)).toStrictEqual({
      spreadsheetId: "abc",
    });
    // A non-spreadsheet mime type is a protocol violation.
    expect(() =>
      extractDriveFileCreateResult(payload({ mimeType: "application/vnd.google-apps.document" }), "My Sheet", VALID_MARKER),
    ).toThrow();
    // A mismatched name is a protocol violation too.
    expect(() =>
      extractDriveFileCreateResult(payload({ name: "Other" }), "My Sheet", VALID_MARKER),
    ).toThrow();
    expect(() => extractDriveFileCreateResult(null, "My Sheet", VALID_MARKER)).toThrow();
    expect(() =>
      extractDriveFileCreateResult(payload({ id: "" }), "My Sheet", VALID_MARKER),
    ).toThrow();
    expect(() =>
      extractDriveFileCreateResult(payload({ id: 42 }), "My Sheet", VALID_MARKER),
    ).toThrow();
    expect(() =>
      extractDriveFileCreateResult({ id: "abc", mimeType: SPREADSHEET_MIME_TYPE }, "My Sheet", VALID_MARKER),
    ).toThrow();
  });

  it("rejects missing, malformed, and wrong marker values in create responses without leaking them", () => {
    const payload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: "abc",
      name: "My Sheet",
      mimeType: SPREADSHEET_MIME_TYPE,
      appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: VALID_MARKER },
      ...overrides,
    });
    // Missing appProperties entirely.
    expect(() =>
      extractDriveFileCreateResult({ id: "abc", name: "My Sheet", mimeType: SPREADSHEET_MIME_TYPE }, "My Sheet", VALID_MARKER),
    ).toThrow(/appProperties marker/);
    // Malformed appProperties (not a record).
    expect(() =>
      extractDriveFileCreateResult(payload({ appProperties: "nope" }), "My Sheet", VALID_MARKER),
    ).toThrow(/appProperties/);
    expect(() =>
      extractDriveFileCreateResult(payload({ appProperties: [] }), "My Sheet", VALID_MARKER),
    ).toThrow(/appProperties/);
    // Missing marker key inside an otherwise valid record.
    expect(() =>
      extractDriveFileCreateResult(payload({ appProperties: {} }), "My Sheet", VALID_MARKER),
    ).toThrow(/expected marker/);
    // A different marker value is a protocol violation, never promoted.
    const wrong = "123e4567-e89b-42d3-a456-426614174999";
    expect(() =>
      extractDriveFileCreateResult(payload({ appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: wrong } }), "My Sheet", VALID_MARKER),
    ).toThrow(/expected marker/);
    // A non-string marker value is malformed too.
    expect(() =>
      extractDriveFileCreateResult(payload({ appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: 42 } }), "My Sheet", VALID_MARKER),
    ).toThrow(/expected marker/);

    // The guard messages never embed the marker, the title, or any secret.
    for (const data of [
      { id: "abc", name: "My Sheet", mimeType: SPREADSHEET_MIME_TYPE },
      payload({ appProperties: "nope" }),
      payload({ appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: wrong } }),
    ]) {
      try {
        extractDriveFileCreateResult(data, "My Sheet", VALID_MARKER);
        expect.unreachable("expected the guard to throw");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(VALID_MARKER);
        expect(message).not.toContain(wrong);
        expect(message).not.toContain("My Sheet");
      }
    }
  });

  it("promotes marker-query file lists and rejects malformed entries", () => {
    const entry = {
      id: "abc",
      name: "My Sheet",
      mimeType: SPREADSHEET_MIME_TYPE,
      appProperties: { hikouteiSetupMarker: VALID_MARKER },
    };
    expect(extractMarkerFileList({ files: [entry], incompleteSearch: false })).toStrictEqual([
      { spreadsheetId: "abc", name: "My Sheet", mimeType: SPREADSHEET_MIME_TYPE, appProperties: { hikouteiSetupMarker: VALID_MARKER } },
    ]);
    // appProperties may be absent; it promotes as an empty record.
    expect(extractMarkerFileList({ files: [{ id: "a", name: "n", mimeType: SPREADSHEET_MIME_TYPE }], incompleteSearch: false })).toStrictEqual([
      { spreadsheetId: "a", name: "n", mimeType: SPREADSHEET_MIME_TYPE, appProperties: {} },
    ]);
    expect(extractMarkerFileList({ files: [], incompleteSearch: false })).toStrictEqual([]);
    expect(() => extractMarkerFileList(null)).toThrow();
    expect(() => extractMarkerFileList({})).toThrow();
    expect(() => extractMarkerFileList({ files: "nope" })).toThrow();
    expect(() => extractMarkerFileList({ files: [null] })).toThrow();
    expect(() => extractMarkerFileList({ files: [{ id: "a" }] })).toThrow();
    expect(() => extractMarkerFileList({ files: [{ id: "a", name: "n" }] })).toThrow();
    expect(() => extractMarkerFileList({ files: [{ id: "a", name: "n", mimeType: 42 }] })).toThrow();
    expect(() => extractMarkerFileList({ files: [{ id: "a", name: "n", mimeType: "t", appProperties: "x" }] })).toThrow();
  });

  it("validates marker file list pages including the optional nextPageToken and the required incompleteSearch flag", () => {
    const entry = {
      id: "abc",
      name: "My Sheet",
      mimeType: SPREADSHEET_MIME_TYPE,
      appProperties: { hikouteiSetupMarker: VALID_MARKER },
    };
    expect(
      extractMarkerFileListPage({ files: [entry], nextPageToken: "tok-1", incompleteSearch: false }),
    ).toStrictEqual({
      files: [
        {
          spreadsheetId: "abc",
          name: "My Sheet",
          mimeType: SPREADSHEET_MIME_TYPE,
          appProperties: { hikouteiSetupMarker: VALID_MARKER },
        },
      ],
      nextPageToken: "tok-1",
      incompleteSearch: false,
    });
    expect(extractMarkerFileListPage({ files: [], incompleteSearch: false })).toStrictEqual({
      files: [],
      nextPageToken: undefined,
      incompleteSearch: false,
    });
    expect(
      extractMarkerFileListPage({ files: [], nextPageToken: undefined, incompleteSearch: false }),
    ).toStrictEqual({
      files: [],
      nextPageToken: undefined,
      incompleteSearch: false,
    });
    // The single-page wrapper still promotes the same entries.
    expect(extractMarkerFileList({ files: [entry], incompleteSearch: false })).toStrictEqual([
      {
        spreadsheetId: "abc",
        name: "My Sheet",
        mimeType: SPREADSHEET_MIME_TYPE,
        appProperties: { hikouteiSetupMarker: VALID_MARKER },
      },
    ]);
    expect(() => extractMarkerFileListPage(null)).toThrow();
    expect(() => extractMarkerFileListPage({})).toThrow();
    expect(() => extractMarkerFileListPage({ files: "nope" })).toThrow();
    expect(() => extractMarkerFileListPage({ files: [null] })).toThrow();
    // A malformed continuation token is refused as untrusted input.
    expect(() => extractMarkerFileListPage({ files: [], nextPageToken: 42, incompleteSearch: false })).toThrow();
    expect(() => extractMarkerFileListPage({ files: [], nextPageToken: "", incompleteSearch: false })).toThrow();
    expect(() => extractMarkerFileListPage({ files: [], nextPageToken: null, incompleteSearch: false })).toThrow();
  });

  it("fails closed on missing, true, and malformed incompleteSearch (never a partial-result verdict)", () => {
    // Drive's `incompleteSearch` flag must be EXACTLY false: a missing,
    // true, or malformed value means the server could not fully search the
    // corpus, so the aggregated result may be missing files and the marker
    // reconciliation must fail closed instead of deciding 0/1/many.
    for (const page of [
      { files: [] }, // missing
      { files: [], incompleteSearch: true },
      { files: [], incompleteSearch: "false" },
      { files: [], incompleteSearch: 0 },
      { files: [], incompleteSearch: null },
      { files: [], incompleteSearch: "yes" },
    ]) {
      expect(() => extractMarkerFileListPage(page)).toThrow();
      expect(() => extractMarkerFileList(page)).toThrow();
      // The failure never leaks the raw flag value.
      try {
        extractMarkerFileListPage(page);
        expect.unreachable("expected the guard to throw");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain("yes");
        expect(message).not.toContain(VALID_MARKER);
      }
    }
    // Exactly false promotes.
    expect(extractMarkerFileListPage({ files: [], incompleteSearch: false }).incompleteSearch).toBe(false);
  });

  /** A marker-query file entry carrying the exact marker. */
  function markerEntry(spreadsheetId: string): Record<string, unknown> {
    return {
      id: spreadsheetId,
      name: "My Sheet",
      mimeType: SPREADSHEET_MIME_TYPE,
      appProperties: { hikouteiSetupMarker: VALID_MARKER },
    };
  }

  /** Fake Drive file-list API over scripted `drive.files.list` pages. */
  function fakeMarkerListApi(pages: readonly unknown[]): {
    api: DriveFileListApi;
    requests: Array<{ q: string; spaces: string; fields: string; pageSize: number; pageToken?: string }>;
  } {
    const requests: Array<{ q: string; spaces: string; fields: string; pageSize: number; pageToken?: string }> = [];
    const queue = [...pages];
    const api: DriveFileListApi = {
      async list(request) {
        requests.push(request);
        const next = queue.shift();
        if (next instanceof Error) {
          throw next;
        }
        return { data: next };
      },
    };
    return { api, requests };
  }

  it("pages drive.files.list and finds the marker match only on page 2 (exact query, fields, and pageToken)", async () => {
    const { api, requests } = fakeMarkerListApi([
      { files: [], nextPageToken: "tok-1" , incompleteSearch: false },
      { files: [markerEntry("sheet-late")] , incompleteSearch: false },
    ]);
    expect(await listAllMarkerFiles(api, VALID_MARKER)).toStrictEqual([
      {
        spreadsheetId: "sheet-late",
        name: "My Sheet",
        mimeType: SPREADSHEET_MIME_TYPE,
        appProperties: { hikouteiSetupMarker: VALID_MARKER },
      },
    ]);
    // Every request carries the exact validated marker query and the
    // fields INCLUDING nextPageToken; only the follow-up request carries
    // the pageToken.
    expect(requests).toStrictEqual([
      {
        q: `appProperties has { key='hikouteiSetupMarker' and value='${VALID_MARKER}' }`,
        spaces: "drive",
        fields: "files(id,name,mimeType,appProperties),nextPageToken,incompleteSearch",
        pageSize: 10,
      },
      {
        q: `appProperties has { key='hikouteiSetupMarker' and value='${VALID_MARKER}' }`,
        spaces: "drive",
        fields: "files(id,name,mimeType,appProperties),nextPageToken,incompleteSearch",
        pageSize: 10,
        pageToken: "tok-1",
      },
    ]);
  });

  it("aggregates two exact marker matches split across pages (never a false single match)", async () => {
    const { api, requests } = fakeMarkerListApi([
      { files: [], nextPageToken: "tok-1" , incompleteSearch: false },
      { files: [markerEntry("sheet-a"), markerEntry("sheet-b")] , incompleteSearch: false },
    ]);
    const matches = await listAllMarkerFiles(api, VALID_MARKER);
    expect(matches.map((match) => match.spreadsheetId)).toStrictEqual(["sheet-a", "sheet-b"]);
    expect(requests).toHaveLength(2);
  });

  it("still aggregates a duplicate hidden on a later page when page 1 already matched", async () => {
    const { api } = fakeMarkerListApi([
      { files: [markerEntry("sheet-a")], nextPageToken: "tok-1" , incompleteSearch: false },
      { files: [markerEntry("sheet-b")] , incompleteSearch: false },
    ]);
    const matches = await listAllMarkerFiles(api, VALID_MARKER);
    expect(matches.map((match) => match.spreadsheetId)).toStrictEqual(["sheet-a", "sheet-b"]);
  });

  it("fails closed on a malformed marker page payload or continuation token without leaking it", async () => {
    for (const page of [{ files: "nope" }, { files: [], nextPageToken: 42, incompleteSearch: false }, { files: [], nextPageToken: "", incompleteSearch: false }]) {
      const { api } = fakeMarkerListApi([page]);
      await expect(listAllMarkerFiles(api, VALID_MARKER)).rejects.toThrow();
    }
    // A malformed entry on a LATER page is refused too.
    const { api } = fakeMarkerListApi([
      { files: [], nextPageToken: "tok-1" , incompleteSearch: false },
      { files: [{ id: "x" }] },
    ]);
    await expect(listAllMarkerFiles(api, VALID_MARKER)).rejects.toThrow();
  });

  it("never leaks continuation tokens or the marker in pagination failures", async () => {
    const { api } = fakeMarkerListApi([
      { files: [], nextPageToken: "tok-secret-1", incompleteSearch: false },
      { files: "nope" },
    ]);
    try {
      await listAllMarkerFiles(api, VALID_MARKER);
      expect.unreachable("expected the pagination to fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("tok-secret-1");
      expect(message).not.toContain(VALID_MARKER);
    }
  });

  it("stops on a repeated continuation token instead of looping forever", async () => {
    const { api, requests } = fakeMarkerListApi([
      { files: [], nextPageToken: "tok-1" , incompleteSearch: false },
      { files: [], nextPageToken: "tok-1" , incompleteSearch: false },
    ]);
    await expect(listAllMarkerFiles(api, VALID_MARKER)).rejects.toThrow();
    // The cycle guard fired after the second page: no infinite loop.
    expect(requests).toHaveLength(2);
  });

  it("fails closed beyond the hard page bound even with distinct tokens", async () => {
    const pages = Array.from({ length: MAX_MARKER_FILE_LIST_PAGES }, (_, index) => ({
      files: [],
      nextPageToken: `tok-${index}`,
      incompleteSearch: false,
    }));
    const { api, requests } = fakeMarkerListApi(pages);
    await expect(listAllMarkerFiles(api, VALID_MARKER)).rejects.toThrow();
    expect(requests).toHaveLength(MAX_MARKER_FILE_LIST_PAGES);
  });

  it("validates the marker before any API call", async () => {
    const { api, requests } = fakeMarkerListApi([]);
    await expect(listAllMarkerFiles(api, "not-a-uuid")).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("builds edit URLs from ids", () => {
    expect(spreadsheetEditUrl("abc123")).toBe("https://docs.google.com/spreadsheets/d/abc123/edit");
    expect(spreadsheetEditUrl("Abc_123-xYz")).toBe("https://docs.google.com/spreadsheets/d/Abc_123-xYz/edit");
  });

  it("refuses a malformed id in the edit URL builder without leaking it", () => {
    for (const id of ["", "a b", "a\nb", "a\tSECRET", "a\u0000b", "a\u0007b", "a/b", "a.b", "a:b", "a?b"]) {
      expect(() => spreadsheetEditUrl(id)).toThrow();
      if (id === "") {
        // The empty string is trivially contained in every message; the
        // non-empty raw ids below prove the no-leak property.
        continue;
      }
      try {
        spreadsheetEditUrl(id);
        expect.unreachable("expected the guard to throw");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain(id);
      }
    }
  });

  it("validates permission lists (identity types require emailAddress) and plans reuse/upgrade/create", () => {
    const permissions = [
      { id: "p1", emailAddress: "human@example.com", role: "owner", type: "user" as const },
      { id: "p2", emailAddress: "sa@proj.iam.gserviceaccount.com", role: "writer", type: "user" as const },
    ];
    expect(extractPermissionList({ permissions })).toStrictEqual(permissions);
    expect(() => extractPermissionList({})).toThrow();
    expect(() => extractPermissionList({ permissions: [{ id: "x" }] })).toThrow();
    expect(() => extractPermissionList({ permissions: "nope" })).toThrow();
    // A user-type entry without an email is malformed.
    expect(() =>
      extractPermissionList({ permissions: [{ id: "p5", role: "writer", type: "user" }] }),
    ).toThrow();

    expect(planSaWriterAction(permissions, "sa@proj.iam.gserviceaccount.com")).toStrictEqual({ action: "reuse" });
    expect(planSaWriterAction(permissions, "other@example.com")).toStrictEqual({ action: "create" });
    expect(
      planSaWriterAction(
        [{ id: "p9", emailAddress: "sa@proj.iam.gserviceaccount.com", role: "reader", type: "user" }],
        "sa@proj.iam.gserviceaccount.com",
      ),
    ).toStrictEqual({ action: "upgrade", permissionId: "p9" });
    // The human owner's own permission must not be mistaken for the SA.
    expect(planSaWriterAction([{ id: "p1", emailAddress: "human@example.com", role: "owner", type: "user" }], "sa@proj.iam.gserviceaccount.com")).toStrictEqual({ action: "create" });
  });

  /** Fake Drive permission API over scripted `permissions.list` pages. */
  function fakePermissionApi(pages: readonly unknown[]): {
    api: DrivePermissionApi;
    listRequests: Array<{ fileId: string; fields: string; pageToken?: string }>;
    updates: Array<{ fileId: string; permissionId: string; requestBody: { role: string } }>;
    creates: Array<{
      fileId: string;
      requestBody: { type: string; role: string; emailAddress: string };
      sendNotificationEmail: boolean;
    }>;
  } {
    const listRequests: Array<{ fileId: string; fields: string; pageToken?: string }> = [];
    const updates: Array<{ fileId: string; permissionId: string; requestBody: { role: string } }> = [];
    const creates: Array<{
      fileId: string;
      requestBody: { type: string; role: string; emailAddress: string };
      sendNotificationEmail: boolean;
    }> = [];
    const queue = [...pages];
    const api: DrivePermissionApi = {
      async list(request) {
        listRequests.push(request);
        const next = queue.shift();
        if (next instanceof Error) {
          throw next;
        }
        return { data: next };
      },
      async update(request) {
        updates.push(request);
      },
      async create(request) {
        creates.push(request);
      },
    };
    return { api, listRequests, updates, creates };
  }

  it("validates permission list pages including the optional nextPageToken", () => {
    const page = {
      permissions: [{ id: "p1", emailAddress: "sa@proj.iam.gserviceaccount.com", role: "writer", type: "user" }],
      nextPageToken: "tok-1",
    };
    expect(extractPermissionListPage(page)).toStrictEqual({
      permissions: [page.permissions[0]],
      nextPageToken: "tok-1",
    });
    expect(extractPermissionListPage({ permissions: [] })).toStrictEqual({
      permissions: [],
      nextPageToken: undefined,
    });
    expect(extractPermissionListPage({ permissions: [], nextPageToken: undefined })).toStrictEqual({
      permissions: [],
      nextPageToken: undefined,
    });
    // The single-page wrapper still promotes the same entries.
    expect(extractPermissionList(page)).toStrictEqual([page.permissions[0]]);
    expect(() => extractPermissionListPage(null)).toThrow();
    expect(() => extractPermissionListPage({})).toThrow();
    expect(() => extractPermissionListPage({ permissions: "nope" })).toThrow();
    // A malformed continuation token is refused as untrusted input.
    expect(() => extractPermissionListPage({ permissions: [], nextPageToken: 42 })).toThrow();
    expect(() => extractPermissionListPage({ permissions: [], nextPageToken: "" })).toThrow();
    expect(() => extractPermissionListPage({ permissions: [], nextPageToken: null })).toThrow();
  });

  it("pages permissions.list and reuses a writer found on a later page (zero create/update)", async () => {
    const { api, listRequests, updates, creates } = fakePermissionApi([
      { permissions: [{ id: "p-human", emailAddress: FAKE_OWNER, role: "owner", type: "user" }], nextPageToken: "tok-1" },
      { permissions: [{ id: "p-sa", emailAddress: "sa@proj.iam.gserviceaccount.com", role: "writer", type: "user" }] },
    ]);
    const outcome = await ensureSaWriterPermission(api, SPREADSHEET_ID, "sa@proj.iam.gserviceaccount.com");
    expect(outcome).toStrictEqual({ writerRole: "reused" });
    expect(updates).toHaveLength(0);
    expect(creates).toHaveLength(0);
    // Every request carries the file id and the fields INCLUDING
    // nextPageToken; only the follow-up request carries the pageToken.
    expect(listRequests).toStrictEqual([
      { fileId: SPREADSHEET_ID, fields: "permissions(id,emailAddress,role,type),nextPageToken" },
      { fileId: SPREADSHEET_ID, fields: "permissions(id,emailAddress,role,type),nextPageToken", pageToken: "tok-1" },
    ]);
  });

  it("upgrades a reader found on a later page (one update, zero creates)", async () => {
    const { api, updates, creates } = fakePermissionApi([
      { permissions: [], nextPageToken: "tok-1" },
      { permissions: [{ id: "p-reader", emailAddress: "sa@proj.iam.gserviceaccount.com", role: "reader", type: "user" }] },
    ]);
    const outcome = await ensureSaWriterPermission(api, SPREADSHEET_ID, "sa@proj.iam.gserviceaccount.com");
    expect(outcome).toStrictEqual({ writerRole: "upgraded" });
    expect(updates).toStrictEqual([
      { fileId: SPREADSHEET_ID, permissionId: "p-reader", requestBody: { role: "writer" } },
    ]);
    expect(creates).toHaveLength(0);
  });

  it("creates the permission only after the final page when the SA is absent everywhere", async () => {
    const { api, listRequests, creates } = fakePermissionApi([
      { permissions: [], nextPageToken: "tok-1" },
      { permissions: [], nextPageToken: "tok-2" },
      { permissions: [] },
    ]);
    const outcome = await ensureSaWriterPermission(api, SPREADSHEET_ID, "sa@proj.iam.gserviceaccount.com");
    expect(outcome).toStrictEqual({ writerRole: "created" });
    expect(creates).toStrictEqual([
      {
        fileId: SPREADSHEET_ID,
        requestBody: { type: "user", role: "writer", emailAddress: "sa@proj.iam.gserviceaccount.com" },
        sendNotificationEmail: false,
      },
    ]);
    expect(listRequests.map((request) => request.pageToken)).toStrictEqual([undefined, "tok-1", "tok-2"]);
  });

  it("fails closed on a malformed page payload or continuation token without leaking it", async () => {
    for (const page of [
      { permissions: "nope" },
      { permissions: [], nextPageToken: 42 },
      { permissions: [], nextPageToken: "" },
    ]) {
      const { api } = fakePermissionApi([page]);
      await expect(ensureSaWriterPermission(api, SPREADSHEET_ID, "sa@proj.iam.gserviceaccount.com")).rejects.toThrow();
    }
    // A malformed entry on a LATER page is refused too.
    const { api } = fakePermissionApi([
      { permissions: [], nextPageToken: "tok-1" },
      { permissions: [{ id: "x" }] },
    ]);
    await expect(ensureSaWriterPermission(api, SPREADSHEET_ID, "sa@proj.iam.gserviceaccount.com")).rejects.toThrow();
  });

  it("stops on a repeated continuation token instead of looping forever", async () => {
    const { api, listRequests } = fakePermissionApi([
      { permissions: [], nextPageToken: "tok-1" },
      { permissions: [], nextPageToken: "tok-1" },
    ]);
    await expect(ensureSaWriterPermission(api, SPREADSHEET_ID, "sa@proj.iam.gserviceaccount.com")).rejects.toThrow();
    // The cycle guard fired after the second page: no infinite loop.
    expect(listRequests).toHaveLength(2);
  });

  it("fails closed beyond the hard page bound even with distinct tokens", async () => {
    const pages = Array.from({ length: MAX_PERMISSION_LIST_PAGES }, (_, index) => ({
      permissions: [],
      nextPageToken: `tok-${index}`,
    }));
    const { api, listRequests } = fakePermissionApi(pages);
    await expect(ensureSaWriterPermission(api, SPREADSHEET_ID, "sa@proj.iam.gserviceaccount.com")).rejects.toThrow();
    // The bound fired before a 51st request could ever be issued.
    expect(listRequests).toHaveLength(MAX_PERMISSION_LIST_PAGES);
  });

  it("never mutates more than one duplicate target permission across pages", async () => {
    const { api, updates, creates } = fakePermissionApi([
      { permissions: [{ id: "p-sa-1", emailAddress: "sa@proj.iam.gserviceaccount.com", role: "reader", type: "user" }], nextPageToken: "tok-1" },
      { permissions: [{ id: "p-sa-2", emailAddress: "sa@proj.iam.gserviceaccount.com", role: "reader", type: "user" }] },
    ]);
    const outcome = await ensureSaWriterPermission(api, SPREADSHEET_ID, "sa@proj.iam.gserviceaccount.com");
    // The FIRST matching permission is upgraded exactly once; the duplicate
    // on the later page is left untouched (a create is never issued merely
    // because the target was absent from page 1).
    expect(outcome).toStrictEqual({ writerRole: "upgraded" });
    expect(updates).toStrictEqual([
      { fileId: SPREADSHEET_ID, permissionId: "p-sa-1", requestBody: { role: "writer" } },
    ]);
    expect(creates).toHaveLength(0);
  });

  it("permits permissions without emailAddress for non-identity types and ignores them in planning", () => {
    const anyone = { id: "p3", role: "reader", type: "anyone" };
    const domain = { id: "p4", role: "reader", type: "domain" };
    expect(extractPermissionList({ permissions: [anyone, domain] })).toStrictEqual([
      { id: "p3", role: "reader", type: "anyone", emailAddress: undefined },
      { id: "p4", role: "reader", type: "domain", emailAddress: undefined },
    ]);
    // Writer planning ignores unrelated entries safely and creates the SA permission.
    expect(planSaWriterAction([anyone as never, domain as never], "sa@proj.iam.gserviceaccount.com")).toStrictEqual({
      action: "create",
    });
  });

  it("validates drive file metadata for the ownership check", () => {
    const payload = {
      id: "abc",
      owners: [{ emailAddress: FAKE_OWNER }],
      permissions: [
        { id: "p1", emailAddress: "sa@proj.iam.gserviceaccount.com", role: "writer", type: "user" },
        { id: "p2", role: "reader", type: "anyone" },
      ],
    };
    expect(extractDriveFileMetadata(payload, "abc")).toStrictEqual({
      ownerEmails: [FAKE_OWNER],
      permissions: [
        { id: "p1", emailAddress: "sa@proj.iam.gserviceaccount.com", role: "writer", type: "user" },
        { id: "p2", role: "reader", type: "anyone", emailAddress: undefined },
      ],
    });
    expect(() => extractDriveFileMetadata(null, "abc")).toThrow();
    expect(() => extractDriveFileMetadata({ owners: [{}] }, "abc")).toThrow();
    expect(() => extractDriveFileMetadata({ owners: [{ emailAddress: FAKE_OWNER }] }, "abc")).toThrow();
    // The metadata must belong to the EXPECTED file: a missing id, a
    // mismatched id, or a malformed id is refused before any ownership
    // verdict.
    expect(() => extractDriveFileMetadata({ ...payload, id: "other" }, "abc")).toThrow();
    expect(() => extractDriveFileMetadata({ ...payload, id: "a\nSECRET" }, "abc")).toThrow();
    expect(() => extractDriveFileMetadata({ ...payload, id: "a b" }, "abc")).toThrow();
  });

  it("rejects malformed Drive ids at every untrusted SDK boundary (newline/control/space injection)", () => {
    const createPayload = (id: unknown): Record<string, unknown> => ({
      id,
      name: "My Sheet",
      mimeType: SPREADSHEET_MIME_TYPE,
      appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: VALID_MARKER },
    });
    for (const id of ["", "a b", "a\nb", "a\tb", "a\u0000b", "a/b", "a.b", "a:b", "a?b", 42, null, undefined]) {
      expect(() => extractDriveFileCreateResult(createPayload(id), "My Sheet", VALID_MARKER)).toThrow();
    }
    for (const id of ["a\nSECRET", " a", "a ", "a\u0007b"]) {
      expect(() => extractMarkerFileList({ files: [{ id, name: "n", mimeType: SPREADSHEET_MIME_TYPE }] })).toThrow();
    }
    for (const id of ["a\nSECRET", "a b", "a\u0000b"]) {
      expect(() => extractPermissionList({ permissions: [{ id, role: "writer", type: "user", emailAddress: "sa@x.iam.gserviceaccount.com" }] })).toThrow();
    }
    // URL-safe ids still promote normally.
    expect(extractDriveFileCreateResult(createPayload("Abc_123-xYz"), "My Sheet", VALID_MARKER)).toStrictEqual({
      spreadsheetId: "Abc_123-xYz",
    });
  });
});

describe("SA access verifier", () => {
  function recordingSleeper(): { sleeper: Sleeper; delays: number[] } {
    const delays: number[] = [];
    return {
      sleeper: {
        async sleep(ms: number): Promise<void> {
          delays.push(ms);
        },
      },
      delays,
    };
  }

  /** Fake getClient whose `get` throws scripted errors, then succeeds. */
  function scriptedClient(errors: readonly unknown[]): {
    getClient: (credentials: SaAccessCredentials) => SpreadsheetGetClient;
    receivedCredentials: SaAccessCredentials[];
    attempts: () => number;
  } {
    const receivedCredentials: SaAccessCredentials[] = [];
    let index = 0;
    return {
      getClient(credentials: SaAccessCredentials): SpreadsheetGetClient {
        receivedCredentials.push(credentials);
        return {
          async get() {
            const error = errors[index];
            index += 1;
            if (error !== undefined) {
              throw error;
            }
            return { data: { spreadsheetId: SPREADSHEET_ID } };
          },
        };
      },
      receivedCredentials,
      attempts: () => index,
    };
  }

  /** In-memory credentials used by the verifier unit tests. */
  const TEST_CREDENTIALS: SaAccessCredentials = {
    client_email: "sa@proj-1.iam.gserviceaccount.com",
    private_key: RSA_PRIVATE_KEY_PEM,
  };
  const withCredentials = { credentials: TEST_CREDENTIALS };

  function httpError(status: number): Error {
    const error = new Error(`Request failed with status code ${status}`);
    (error as { response?: { status: number } }).response = { status };
    return error;
  }

  const fresh = { keyFresh: true, shareFresh: false };
  const reused = { keyFresh: false, shareFresh: false };

  it("retries invalid JWT signature on a fresh key and succeeds with the exact schedule", async () => {
    const { sleeper, delays } = recordingSleeper();
    const client = scriptedClient([
      new Error("invalid_grant: Invalid JWT Signature"),
      new Error("invalid_grant: Invalid JWT Signature"),
      new Error("invalid_grant: Invalid JWT Signature"),
    ]);
    const verifier = createSaAccessVerifier({ sleeper, getClient: client.getClient });
    await verifier.verify({ keyPath: "/tmp/key.json", spreadsheetId: SPREADSHEET_ID, ...fresh, ...withCredentials });
    expect(delays).toStrictEqual([2000, 4000, 8000]);
    expect(client.attempts()).toBe(4);
    expect(client.receivedCredentials).toStrictEqual([TEST_CREDENTIALS]);
  });

  it("does not retry invalid JWT signature on a reused key", async () => {
    const { sleeper, delays } = recordingSleeper();
    const client = scriptedClient([new Error("invalid_grant: Invalid JWT Signature")]);
    const verifier = createSaAccessVerifier({ sleeper, getClient: client.getClient });
    await expect(
      verifier.verify({ keyPath: "/tmp/key.json", spreadsheetId: SPREADSHEET_ID, ...reused, ...withCredentials }),
    ).rejects.toThrow();
    expect(delays).toStrictEqual([]);
    expect(client.attempts()).toBe(1);
  });

  it("does not treat generic invalid_grant/expired credentials as propagation", async () => {
    const { sleeper, delays } = recordingSleeper();
    const client = scriptedClient([new Error("invalid_grant: token has been expired")]);
    const verifier = createSaAccessVerifier({ sleeper, getClient: client.getClient });
    await expect(
      verifier.verify({ keyPath: "/tmp/key.json", spreadsheetId: SPREADSHEET_ID, ...fresh, ...withCredentials }),
    ).rejects.toThrow();
    expect(delays).toStrictEqual([]);
    expect(client.attempts()).toBe(1);
  });

  it("retries 403/404 only when the writer permission was created/upgraded this run", async () => {
    for (const error of [httpError(403), httpError(404)]) {
      // Fresh share: full eight-attempt schedule.
      const freshShare = recordingSleeper();
      const client = scriptedClient(Array(8).fill(error));
      const verifier = createSaAccessVerifier({ sleeper: freshShare.sleeper, getClient: client.getClient });
      await expect(
        verifier.verify({ keyPath: "/tmp/key.json", spreadsheetId: SPREADSHEET_ID, keyFresh: false, shareFresh: true, ...withCredentials }),
      ).rejects.toThrow();
      expect(freshShare.delays).toStrictEqual([...SA_VERIFY_RETRY_DELAYS_MS]);
      expect(client.attempts()).toBe(8);

      // Reused share: stop immediately.
      const { sleeper, delays } = recordingSleeper();
      const reusedClient = scriptedClient([error]);
      const reusedVerifier = createSaAccessVerifier({ sleeper, getClient: reusedClient.getClient });
      await expect(
        reusedVerifier.verify({ keyPath: "/tmp/key.json", spreadsheetId: SPREADSHEET_ID, ...reused, ...withCredentials }),
      ).rejects.toThrow();
      expect(delays).toStrictEqual([]);
      expect(reusedClient.attempts()).toBe(1);
    }
  });

  it("retries 429/5xx regardless of key/share freshness and exhausts the schedule", async () => {
    for (const error of [httpError(429), httpError(500), httpError(503)]) {
      const { sleeper, delays } = recordingSleeper();
      const client = scriptedClient(Array(8).fill(error));
      const verifier = createSaAccessVerifier({ sleeper, getClient: client.getClient });
      await expect(
        verifier.verify({ keyPath: "/tmp/key.json", spreadsheetId: SPREADSHEET_ID, ...reused, ...withCredentials }),
      ).rejects.toThrow();
      expect(delays).toStrictEqual([...SA_VERIFY_RETRY_DELAYS_MS]);
      expect(client.attempts()).toBe(8);
    }
  });

  it("fails immediately on permanent 4xx, network failures, malformed, and mismatched payloads", async () => {
    for (const error of [httpError(400), httpError(401), new Error("ENOTFOUND token.example")]) {
      const { sleeper, delays } = recordingSleeper();
      const client = scriptedClient([error]);
      const verifier = createSaAccessVerifier({ sleeper, getClient: client.getClient });
      await expect(
        verifier.verify({ keyPath: "/tmp/key.json", spreadsheetId: SPREADSHEET_ID, ...fresh, ...withCredentials }),
      ).rejects.toThrow();
      expect(delays).toStrictEqual([]);
      expect(client.attempts()).toBe(1);
    }

    // Malformed success payloads (missing and mismatched ids) fail at once.
    for (const data of [{}, { spreadsheetId: "other-sheet" }]) {
      const { sleeper, delays } = recordingSleeper();
      const rawClient = {
        getClient(): SpreadsheetGetClient {
          return { async get() { return { data }; } };
        },
      };
      const verifier = createSaAccessVerifier({ sleeper, getClient: rawClient.getClient });
      await expect(
        verifier.verify({ keyPath: "/tmp/key.json", spreadsheetId: SPREADSHEET_ID, ...fresh, ...withCredentials }),
      ).rejects.toThrow();
      expect(delays).toStrictEqual([]);
    }

    // A payload id with whitespace/control characters is malformed too.
    for (const data of [{ spreadsheetId: "a\nSECRET" }, { spreadsheetId: "a b" }, { spreadsheetId: "a\u0000b" }]) {
      expect(() => requireSpreadsheetId(data, SPREADSHEET_ID)).toThrow();
      const { sleeper, delays } = recordingSleeper();
      const rawClient = {
        getClient(): SpreadsheetGetClient {
          return { async get() { return { data }; } };
        },
      };
      const verifier = createSaAccessVerifier({ sleeper, getClient: rawClient.getClient });
      await expect(
        verifier.verify({ keyPath: "/tmp/key.json", spreadsheetId: SPREADSHEET_ID, ...fresh, ...withCredentials }),
      ).rejects.toThrow();
      expect(delays).toStrictEqual([]);
    }
  });

  it("classifies retryable errors by status and freshness context", () => {
    expect(isRetryableVerifyError(new Error("invalid_grant: Invalid JWT Signature"), fresh)).toBe(true);
    expect(isRetryableVerifyError(new Error("invalid_grant: Invalid JWT Signature"), reused)).toBe(false);
    expect(isRetryableVerifyError(new Error("invalid_grant: token has been expired"), fresh)).toBe(false);
    expect(isRetryableVerifyError(httpError(403), { keyFresh: false, shareFresh: true })).toBe(true);
    expect(isRetryableVerifyError(httpError(403), reused)).toBe(false);
    expect(isRetryableVerifyError(httpError(404), { keyFresh: false, shareFresh: true })).toBe(true);
    expect(isRetryableVerifyError(httpError(404), reused)).toBe(false);
    expect(isRetryableVerifyError(httpError(429), reused)).toBe(true);
    expect(isRetryableVerifyError(httpError(500), reused)).toBe(true);
    expect(isRetryableVerifyError(httpError(400), fresh)).toBe(false);
    expect(isRetryableVerifyError(new Error("ENOTFOUND"), fresh)).toBe(false);
  });

  it("succeeds on the first attempt without sleeping", async () => {
    const { sleeper, delays } = recordingSleeper();
    const client = scriptedClient([]);
    const verifier = createSaAccessVerifier({ sleeper, getClient: client.getClient });
    await verifier.verify({ keyPath: "/tmp/key.json", spreadsheetId: SPREADSHEET_ID, ...fresh, ...withCredentials });
    expect(delays).toStrictEqual([]);
    expect(client.attempts()).toBe(1);
  });

  it("rejects a malformed spreadsheet id BEFORE the client factory or the SDK is touched", async () => {
    for (const spreadsheetId of ["", "a b", "a\nb", "a\tb", "a\u0000b", "a/b", "a.b", "a:b", "a?b", 42, null, undefined]) {
      const { sleeper, delays } = recordingSleeper();
      const client = scriptedClient([]);
      const verifier = createSaAccessVerifier({ sleeper, getClient: client.getClient });
      await expect(
        verifier.verify({ keyPath: "/tmp/key.json", spreadsheetId: spreadsheetId as string, ...fresh, ...withCredentials }),
      ).rejects.toThrow();
      // Neither the client factory nor the SDK get() was ever called: the
      // raw id never reaches a request, a URL, or a message.
      expect(client.receivedCredentials).toStrictEqual([]);
      expect(client.attempts()).toBe(0);
      expect(delays).toStrictEqual([]);
    }
  });

  it("uses ONLY the in-memory validated credentials: replacing the key path after validation cannot redirect the verifier", async () => {
    // Read the credential through the secure descriptor boundary, then
    // REPLACE the file behind the validated path with a foreign credential:
    // the verifier must still authenticate with the validated in-memory
    // credentials (it never reopens the pathname), so the replacement
    // cannot redirect it.
    const dir = makeTempDir();
    const keyPath = join(dir, "key.json");
    writeFileSync(keyPath, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");
    const read = readServiceAccountKeyCredentialSecurely(keyPath);
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    writeFileSync(
      keyPath,
      validKeyJson("evil-proj", "evil@evil-proj.iam.gserviceaccount.com"),
      "utf8",
    );

    const { sleeper, delays } = recordingSleeper();
    const received: SaAccessCredentials[] = [];
    const verifier = createSaAccessVerifier({
      sleeper,
      getClient: (credentials) => {
        received.push(credentials);
        return {
          async get() {
            return { data: { spreadsheetId: SPREADSHEET_ID } };
          },
        };
      },
    });
    await verifier.verify({
      keyPath,
      spreadsheetId: SPREADSHEET_ID,
      keyFresh: false,
      shareFresh: false,
      credentials: {
        client_email: read.credentials.clientEmail,
        private_key: read.credentials.privateKey,
      },
    });
    // The client was built from the VALIDATED in-memory credentials of the
    // ORIGINAL key — never by reopening the (now replaced) path — and the
    // foreign credential never reached the client factory.
    expect(received).toStrictEqual([
      { client_email: "sa@proj-1.iam.gserviceaccount.com", private_key: RSA_PRIVATE_KEY_PEM },
    ]);
    expect(delays).toStrictEqual([]);
  });
});
