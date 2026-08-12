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
  mkdtempSync,
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
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_OUTPUT_FILE_NAME,
  DEFAULT_SA_NAME,
  parseSetupArgs,
  SETUP_HELP_TEXT,
} from "../src/cli/args.js";
import {
  acquireSetupLock,
  checkStateCompatibility,
  fsyncParentDirectory,
  isValidCreationMarker,
  isValidDriveId,
  isValidGcpProjectId,
  isValidKeyMarker,
  isValidServiceAccountName,
  isServiceAccountKeyResourceName,
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
} from "../src/cli/checkpoint.js";
import { confirmSetup } from "../src/cli/confirm.js";
import { SETUP_ERROR_CODES } from "../src/cli/errors.js";
import type { GcloudRunner, GcloudRunResult } from "../src/cli/gcloudRunner.js";
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
} from "../src/cli/humanAuth.js";
import {
  createSaAccessVerifier,
  isRetryableVerifyError,
  requireSpreadsheetId,
  SA_VERIFY_RETRY_DELAYS_MS,
  type SaAccessCredentials,
  type SaAccessVerifier,
  type Sleeper,
  type SpreadsheetGetClient,
} from "../src/cli/saVerify.js";
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
  type HumanSheetApi,
  type HumanSheetApiFactory,
  type MarkerFileInfo,
  type ShareOutcome,
} from "../src/cli/sheetsFactory.js";
import { safeError, safeReasonOf } from "../src/cli/sdkError.js";
import { createSafeRunner } from "../src/cli/gcloudRunner.js";
import {
  KEY_LIST_COMMAND,
  KEY_SETTLE_POLL_DELAYS_MS,
  KEY_STAGE_PLACEHOLDER,
  cleanupOwnedStage,
  keyCleanupDir,
  keyResourceNameFor,
  keyStageDir,
  normalizeUserManagedKeyLine,
  parseUserManagedKeyList,
  prepareStageDir,
  stagedKeyPath,
  type KeyCleanupFs,
} from "../src/cli/keyProvision.js";
import {
  atomicWritePrivateFile,
  DEFAULT_KEY_FILE_NAME,
  defaultSpreadsheetTitle,
  findSetupPathCollision,
  formatPlan,
  formatSummary,
  generateProjectId,
  planSetupCommands,
  runSetup,
  SETUP_ENV_KEYS,
  writeSetupEnvFile,
  type PlannedCommand,
  type RunSetupOptions,
  type SetupResult,
} from "../src/cli/setupFlow.js";

const tempDirs: string[] = [];
/**
 * Models gcloud's key-list side effect: once the fake keys create has
 * succeeded, the fake keys list reports the created key as a user-managed
 * key of the service account. Reset per test in `afterEach`.
 */
let fakeKeyCreated = false;
afterEach(() => {
  fakeKeyCreated = false;
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

/**
 * Entries in `dir` whose name starts with the state file name plus the temp
 * suffix (`.tmp...`): any leftover checkpoint temp artifact of a save.
 */
function tempLeftovers(dir: string, statePath: string): string[] {
  const base = basename(statePath);
  return readdirSync(dir).filter((name) => name.startsWith(`${base}${SETUP_STATE_TEMP_SUFFIX}`));
}

const FAKE_TOKEN = "ya29.fake-secret-access-token";
const FAKE_OWNER = "owner@example.com";
const SPREADSHEET_ID = "spreadsheet-123";
const SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;
/** Spreadsheet id returned by the fake `drive.files.create`. */
const CREATED_SHEET_ID = "created-sheet-001";
const CREATED_SHEET_URL = spreadsheetEditUrl(CREATED_SHEET_ID);
/** Well-formed creation marker (UUID v4) used in checkpoint fixtures. */
const VALID_MARKER = "123e4567-e89b-42d3-a456-426614174000";
/** Well-formed key marker (UUID v4) used in checkpoint fixtures. */
const VALID_KEY_MARKER = "a0b1c2d3-e89b-42d3-a456-426614174000";
/** Non-secret `private_key_id` written into key fixtures. */
const FIXED_KEY_ID = "f5e4d3c2b1a09876";
/** Non-secret `private_key_id` of the UNEXPECTED key in uncertain fixtures. */
const FOREIGN_KEY_ID = "aabbccddeeff0011";

/** Valid key JSON for a project/email with the fixed non-secret key id. */
function validKeyJson(projectId: string, saEmail: string, keyId: string = FIXED_KEY_ID): string {
  return JSON.stringify({
    type: "service_account",
    project_id: projectId,
    client_email: saEmail,
    private_key_id: keyId,
    private_key: RSA_PRIVATE_KEY_PEM,
  });
}

/** IAM resource name of a user-managed key for the fake keys list. */
function keyResourceName(projectId: string, saEmail: string, keyId: string): string {
  return `projects/${projectId}/serviceAccounts/${saEmail}/keys/${keyId}`;
}

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

/** A real RSA PKCS#8 private key so key crypto prevalidation passes. */
const RSA_PRIVATE_KEY_PEM = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDzU9xBlhiQQZTc",
  "U9WUp4QrTIaAYrY1z7tLRHjSaShxXVdrnzy6v9b52BBAN8/MPkIvcdOc36v1GRVi",
  "PZQxO+mmkdoKnEgQgX4JRnmfJv2SAICb5cqCqxUncaYK4AM+toQK0h0sPBJt62Zs",
  "eVtufRZ5oGmvspj550LCRGY9X1NU2jD1CvzNNYF+4LaVnYhZ+nFmNVi1Y9uCpp8V",
  "Aj+HUmgYjeW+sIp59xYRac0yJfbXWa6uQ9FL3FZ6sWgRRUmmVH6olEIFBJoaoqxc",
  "BzNoqRdy1W88NiKYULC2J6z3XRmoHXAcCOh+AJcCT+sqs9kKo3JQFmxStng5GJT2",
  "RStIC0B7AgMBAAECggEAH4f78EHPgA4HiL+SWzeT8HpzqXphKzr2hcvjLjzzQTF7",
  "zRXu7DJE3M5rWK8CzfA5amWBKwBvC41LEJZzOCgP4IZg72QOEJl/KBuKUh3e2QcY",
  "o1sVMXaTALAA+MLLmNpU5QQSRLOqHbVV6fOV7gzmly860so9eZDGvV7YstZB+aol",
  "4eNPf4aA0gnMhg+ghZFUnn7jsg2Kx7Cfr+cFmfhdGugluOcdbyoRB7Ox3+8Dqaaj",
  "hqHTQL4rQe5QJWjlkyyqP/4smqgl4AHnFv1irOAH2APGBc/v1FMdcfvIskqB5Sdi",
  "L6lA0HORmzfs22I30BEsei21Iz86YZPjR7BpUbrt9QKBgQD9R7WOmH5LEBtuUi+a",
  "LGi1PvKRSmIYKKwIPPFEAmYMmX7ecPqH/7mWMVcHF3nLqMjHB68VVHKftqsznLtv",
  "Kmz+yqyOwSbdW4qH2qss/E2jXVZaTwRBxb87bD0/qFxPVKBP0r3PMeNlOCF7qiCJ",
  "gNXhex00HtL7IPro+KZRlTWqvQKBgQD18MpsekIm7/NAGTkR6Hutx6DDUfMpyinf",
  "ytOjiyJQNtcus1jiSkQBOzFOwl5JwhzvRN93HW1cgsZfRLaePROSmMGnwU3IUTHx",
  "cbchj3Bd8RBFNwypLvZEd5epGPLEhLxvESLurqi6/2pI4M8FQRhxVezOPz3ymjH+",
  "TBhkSE/nlwKBgGqtUE/t9IuDDjqqDPifqb5k89+z95r7TnHt0SR26ip2YBQqe6ra",
  "T31t7JzFC3x265HAr8KJHfodAwCrC9rngJ7UGFfMDKWBD9jmheBdqAmdn2hMDZvy",
  "QPgzP5zXOYIEP70/Isjo10Djol6mqiugAvWEWCmCrhQtsOB9Efgco0z1AoGBAOtO",
  "MW4uXwKAC10lhMvUghiXagHWc29lREEg/vJ3WSIkBidhYsZHRd9jsd5n6uxo82Qd",
  "oiyGFC8x0/gsdwjY6NQWoRoOwYvJ253lLdDHOzw2O1ntvIhWLTr+rTUVcJiDYwJl",
  "A+YXZ8paO2d0571gNbGiA0qliXCHBRQH3EJ+SS0LAoGBAJWK4S9E2+FVJvxCtKqM",
  "kIwF0dSxFZSHkGan67L8tF18RzrEcxaCyp0zxeXrzmBNsQS0K1R/O1p9K5uNSRvv",
  "eHeCyhop3p7u7u3275UQ2sZdszepulZkPRhX7AFT2XSvpypJMtg8NtH+8T35GQ73",
  "KD2qEH9Vvl0NOHREgI/Z9jb+",
  "-----END PRIVATE KEY-----",
].join("\n");

/** Adversarial secret payloads that must never reach CLI/result strings. */
const SECRET_JWT =
  "eyJhbGciOiJSUzI1NiIsImtpZCI6ImtleS0xIn0.eyJzdWIiOiJzYS0xQHByb2ouaWFtLmdzZXJ2aWNlYWNjb3VudC5jb20ifQ.signature";
const SECRET_KEY_MATERIAL = `-----BEGIN PRIVATE KEY-----\nSECRETKEYMATERIAL\n-----END PRIVATE KEY-----`;
const SECRET_AUTHORIZATION = "Authorization: Bearer ya29.secret-credential";

/** Fake gcloud runner that records every invocation and scripts responses. */
function createRecordingRunner(
  script?: (args: readonly string[], options?: { readonly cwd?: string }) => GcloudRunResult,
): {
  runner: GcloudRunner;
  calls: readonly string[][];
  callOptions: Array<{ readonly cwd?: string }>;
} {
  const calls: string[][] = [];
  const callOptions: Array<{ readonly cwd?: string }> = [];
  const runner: GcloudRunner = {
    async run(args: readonly string[], options?: { readonly cwd?: string }): Promise<GcloudRunResult> {
      calls.push([...args]);
      callOptions.push(options?.cwd === undefined ? {} : { cwd: options.cwd });
      if (script !== undefined) {
        return script(args, options);
      }
      return { status: "ok", stdout: "", stderr: "" };
    },
  };
  return { runner, calls, callOptions };
}

/** Scripted runner for a fully fresh setup (everything is created). */
function freshSetupScript(keyPath: string): (args: readonly string[], options?: { readonly cwd?: string }) => GcloudRunResult {
  return (args: readonly string[], options?: { readonly cwd?: string }): GcloudRunResult => {
    if (args[0] === "--version") {
      return { status: "ok", stdout: "Google Cloud SDK 500.0.0\n", stderr: "" };
    }
    if (args[0] === "auth" && args[1] === "list") {
      return { status: "ok", stdout: `${FAKE_OWNER}\n`, stderr: "" };
    }
    if (args[0] === "auth" && args[1] === "print-access-token") {
      return { status: "ok", stdout: `${FAKE_TOKEN}\n`, stderr: "" };
    }
    if (args[0] === "iam" && args[2] === "keys" && args[3] === "list") {
      // A successful fake create made the key a real user-managed key. The
      // executed command carries --iam-account at index 7 and --project at
      // index 9 (after --managed-by/--format).
      if (fakeKeyCreated) {
        const iamAccount = args[7] as string;
        const projectId = iamAccount.split("@")[1]?.replace(".iam.gserviceaccount.com", "") ?? "unknown";
        return {
          status: "ok",
          stdout: `${keyResourceName(projectId, iamAccount, FIXED_KEY_ID)}\n`,
          stderr: "",
        };
      }
      return { status: "ok", stdout: "", stderr: "" };
    }
    if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
      // gcloud would write the key file; simulate that side effect with a
      // structurally valid service-account key (real RSA PEM, non-secret
      // private_key_id) so the flow's secure validation and 0600 steps have
      // a real file to work with. Production runs the create with the
      // staging directory as the subprocess cwd and a RELATIVE key.json
      // destination, so the fake writes relative to that cwd.
      fakeKeyCreated = true;
      const iamAccount = args[6] as string;
      const projectId = iamAccount.split("@")[1]?.replace(".iam.gserviceaccount.com", "") ?? "unknown";
      const destination =
        options?.cwd === undefined ? (args[4] as string) : join(options.cwd, args[4] as string);
      writeFileSync(destination, validKeyJson(projectId, iamAccount, FIXED_KEY_ID), "utf8");
      return { status: "ok", stdout: "", stderr: "" };
    }
    return { status: "ok", stdout: "", stderr: "" };
  };
}

function failed(status: number, stderr: string): GcloudRunResult {
  return { status: "failed", code: status, stdout: "", stderr };
}

/** Mutable behaviors for the human sheet API and SA verifier fakes. */
interface Harness {
  readonly keyPath: string;
  readonly outputPath: string;
  readonly statePath: string;
  readonly calls: readonly string[][];
  readonly callOptions: Array<{ readonly cwd?: string }>;
  created: { readonly title: string; readonly marker: string }[];
  createdSheetId: string;
  lookupCalls: string[];
  lookupResult: (marker: string) => readonly MarkerFileInfo[];
  lookupError: Error | undefined;
  /** Hook invoked inside the fake create so tests can assert the started checkpoint exists BEFORE the create call. */
  beforeCreate: (() => void) | undefined;
  /** Hook invoked inside the fake SA verify so tests can plant mid-run aliases before the .env write. */
  beforeVerify: (() => void) | undefined;
  shares: { readonly spreadsheetId: string; readonly saEmail: string; readonly ownerEmail: string }[];
  humanTokens: string[];
  verifyCalls: Array<{
    readonly keyPath: string;
    readonly spreadsheetId: string;
    readonly keyFresh: boolean;
    readonly shareFresh: boolean;
    readonly credentials: { readonly client_email: string; readonly private_key: string };
  }>;
  shareOutcome: ShareOutcome;
  /** When set, the fake share simulate a crash right after the remote permission mutation. */
  crashAfterShareMutation: boolean;
  createError: Error | undefined;
  shareError: Error | undefined;
  verifyError: Error | undefined;
  tokenInfo: TokenInfo;
  tokenValidatorError: Error | undefined;
  runnerScript: ((args: readonly string[], options?: { readonly cwd?: string }) => GcloudRunResult) | undefined;
  /** Delays requested from the key-settlement propagation poll sleeper. */
  sleepCalls: number[];
  run(options?: Partial<RunSetupOptions>): Promise<SetupResult>;
}

function createHarness(dir: string): Harness {
  const keyPath = join(dir, DEFAULT_KEY_FILE_NAME);
  const outputPath = join(dir, ".env");
  const statePath = join(dir, SETUP_STATE_FILE_NAME);

  // All fakes read and write through the returned harness object, so tests
  // can flip behaviors between runs (failures, token info, scripts).
  const { runner, calls, callOptions } = createRecordingRunner((args, options) =>
    (harness.runnerScript ?? freshSetupScript(keyPath))(args, options),
  );
  const validateToken: TokenValidator = {
    async validate(_token: string): Promise<TokenInfo> {
      if (harness.tokenValidatorError !== undefined) {
        throw harness.tokenValidatorError;
      }
      return harness.tokenInfo;
    },
  };
  const createHumanApi: HumanSheetApiFactory = (accessToken) => {
    harness.humanTokens.push(accessToken);
    return {
      async createSpreadsheet(request: { title: string; marker: string }) {
        harness.beforeCreate?.();
        harness.created.push({ title: request.title, marker: request.marker });
        if (harness.createError !== undefined) {
          throw harness.createError;
        }
        return { spreadsheetId: harness.createdSheetId };
      },
      async findSpreadsheetByMarker(marker: string) {
        harness.lookupCalls.push(marker);
        if (harness.lookupError !== undefined) {
          throw harness.lookupError;
        }
        return harness.lookupResult(marker);
      },
      async ensureSaWriter(request: { spreadsheetId: string; saEmail: string; ownerEmail: string }) {
        harness.shares.push(request);
        if (harness.shareError !== undefined) {
          throw harness.shareError;
        }
        if (harness.crashAfterShareMutation) {
          // Simulate a crash right after the remote permission mutation but
          // before the spreadsheet_shared checkpoint write: planting a
          // symlink alias at the output path makes the next checkpoint
          // write fail closed, leaving the run at the share write-ahead
          // boundary (spreadsheet_share_started).
          symlinkSync(harness.keyPath, harness.outputPath);
        }
        return harness.shareOutcome;
      },
    };
  };
  const verifySaAccess: SaAccessVerifier = {
    async verify(request: {
      keyPath: string;
      spreadsheetId: string;
      keyFresh: boolean;
      shareFresh: boolean;
      credentials: { readonly client_email: string; readonly private_key: string };
    }): Promise<void> {
      harness.verifyCalls.push(request);
      if (harness.beforeVerify !== undefined) {
        harness.beforeVerify();
      }
      if (harness.verifyError !== undefined) {
        throw harness.verifyError;
      }
    },
  };

  const harness: Harness = {
    keyPath,
    outputPath,
    statePath,
    calls,
    callOptions,
    created: [],
    createdSheetId: CREATED_SHEET_ID,
    lookupCalls: [],
    lookupResult: () => [],
    lookupError: undefined,
    beforeCreate: undefined,
    beforeVerify: undefined,
    shares: [],
    humanTokens: [],
    verifyCalls: [],
    shareOutcome: { writerRole: "created" },
    crashAfterShareMutation: false,
    createError: undefined,
    shareError: undefined,
    verifyError: undefined,
    tokenInfo: { email: FAKE_OWNER, scope: DRIVE_SCOPE },
    tokenValidatorError: undefined,
    runnerScript: undefined,
    sleepCalls: [],
    run(options = {}) {
      return runSetup({
        runner,
        validateToken,
        createHumanApi,
        verifySaAccess,
        projectId: undefined,
        saName: "hikoutei-sa",
        spreadsheetTitle: undefined,
        keyPath,
        outputPath,
        statePath,
        dryRun: false,
        // Instant sleeper: the bounded key-settlement propagation poll must
        // never make tests wait; every requested delay is recorded so tests
        // can assert the exact schedule.
        sleeper: {
          async sleep(ms: number): Promise<void> {
            harness.sleepCalls.push(ms);
          },
        },
        ...options,
      });
    },
  };
  return harness;
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

/** Reads the checkpoint file and parses it for assertions. */
function readState(statePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
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

describe("setup path collisions", () => {
  it("rejects --output aliasing the key path before any gcloud call or file write", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(harness.keyPath, "precious-key-content", "utf8");

    const result = await harness.run({ outputPath: harness.keyPath });
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    if (result.status === "error") {
      expect(result.message).toContain("--output");
    }
    // Nothing ran and nothing was overwritten.
    expect(harness.calls).toHaveLength(0);
    expect(harness.created).toHaveLength(0);
    expect(harness.humanTokens).toHaveLength(0);
    expect(existsSync(harness.statePath)).toBe(false);
    expect(readFileSync(harness.keyPath, "utf8")).toBe("precious-key-content");
  });

  it("rejects --output aliasing the checkpoint path before any gcloud call", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(harness.statePath, "{\"kept\":true}", "utf8");

    const result = await harness.run({ outputPath: harness.statePath });
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    if (result.status === "error") {
      expect(result.message).toContain("--output");
    }
    expect(harness.calls).toHaveLength(0);
    expect(readFileSync(harness.statePath, "utf8")).toBe('{"kept":true}');
  });

  it("rejects a key path that aliases the checkpoint path", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ keyPath: harness.statePath });
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects symlink aliases of the key path", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(harness.keyPath, "keep-me", "utf8");
    const alias = join(dir, "alias.env");
    symlinkSync(harness.keyPath, alias);

    const result = await harness.run({ outputPath: alias });
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    expect(harness.calls).toHaveLength(0);
    expect(readFileSync(harness.keyPath, "utf8")).toBe("keep-me");
  });

  it("rejects --output aliasing the checkpoint temp path before any gcloud call", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const tempPath = setupStateTempPath(harness.statePath);
    writeFileSync(tempPath, "stale-temp", "utf8");

    const result = await harness.run({ outputPath: tempPath });
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    expect(harness.calls).toHaveLength(0);
    expect(readFileSync(tempPath, "utf8")).toBe("stale-temp");
  });

  it("rejects --output aliasing the setup lock path before any gcloud call", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const lockPath = setupLockPath(harness.statePath);
    writeFileSync(lockPath, "{ \"pid\": 1 }", "utf8");

    const result = await harness.run({ outputPath: lockPath });
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects a key path that aliases the setup lock path", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const lockPath = setupLockPath(harness.statePath);
    const result = await harness.run({ keyPath: lockPath });
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    expect(harness.calls).toHaveLength(0);
  });

  it("rejects a dangling symlink at --output that targets the key path", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // The key path does not exist yet, so the alias is a dangling symlink;
    // writing through it would create the key file at the reserved path.
    const alias = join(dir, "alias.env");
    symlinkSync(harness.keyPath, alias);

    const result = await harness.run({ outputPath: alias });
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    if (result.status === "error") {
      expect(result.message).toContain("service-account key path");
    }
    expect(harness.calls).toHaveLength(0);
    expect(existsSync(harness.keyPath)).toBe(false);
  });

  it("rejects a hardlink alias of the key path by device/inode", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const realFile = join(dir, "real.env");
    writeFileSync(realFile, "shared-content", "utf8");
    linkSync(realFile, harness.keyPath);

    const result = await harness.run({ outputPath: realFile });
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    expect(harness.calls).toHaveLength(0);
    expect(readFileSync(harness.keyPath, "utf8")).toBe("shared-content");
  });

  it("rejects an output symlink pointing at a hardlink of the key by resolved identity", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // Luna attack shape: the key path is a hardlink of a real file, and the
    // output path is a symlink to that same real file. Canonical paths
    // differ (the symlink resolves to the real file's own name, not the key
    // path), so only a stat-based identity comparison on the RESOLVED
    // targets catches the alias.
    const realFile = join(dir, "real-target.env");
    writeFileSync(realFile, "attack-target-content", "utf8");
    linkSync(realFile, harness.keyPath);
    symlinkSync(realFile, harness.outputPath);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    if (result.status === "error") {
      expect(result.message).toContain("--output");
    }
    // No cloud/API mutation and no overwrite of the shared inode.
    expect(harness.calls).toHaveLength(0);
    expect(harness.created).toHaveLength(0);
    expect(harness.humanTokens).toHaveLength(0);
    expect(existsSync(harness.statePath)).toBe(false);
    expect(readFileSync(realFile, "utf8")).toBe("attack-target-content");
    expect(readFileSync(harness.keyPath, "utf8")).toBe("attack-target-content");
  });

  it("rejects a case alias of a reserved path on case-insensitive platforms", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const caseKey = join(dir, "CaseKey.json");
    const caseOutput = join(dir, "casekey.json");
    writeFileSync(caseKey, "case-content", "utf8");

    if (process.platform === "darwin" || process.platform === "win32") {
      // On case-insensitive filesystems the two spellings name the SAME
      // file, so the preflight must reject the run before any gcloud call.
      const result = await harness.run({ keyPath: caseKey, outputPath: caseOutput });
      expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
      expect(harness.calls).toHaveLength(0);
    } else {
      // Case-sensitive platform: the two spellings are distinct files, so
      // the pure collision check accepts them. A full setup run is NOT
      // attempted here: the fixture key content is intentionally not a
      // real service-account key, which would fail the run for an
      // unrelated reason.
      expect(
        findSetupPathCollision({
          keyPath: caseKey,
          outputPath: caseOutput,
          statePath: harness.statePath,
        }),
      ).toStrictEqual({ status: "ok" });
    }
  });

  it("accepts distinct key/checkpoint/output paths", () => {
    expect(
      findSetupPathCollision({
        keyPath: "/tmp/a/hikoutei-service-account.json",
        outputPath: "/tmp/a/.env",
        statePath: "/tmp/a/.hikoutei-setup-state.json",
      }),
    ).toStrictEqual({ status: "ok" });
  });
});

describe("runSetup — mid-run reserved-path revalidation", () => {
  it("fails closed when an alias appears after preflight and before a checkpoint write", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // The initial preflight passes; an alias from the output path to the
    // key path is planted right before the spreadsheet create, so the next
    // checkpoint write (spreadsheet_created) must detect it and fail.
    harness.beforeCreate = () => {
      symlinkSync(harness.keyPath, harness.outputPath);
    };

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    if (result.status === "error") {
      expect(result.message).toContain("changed during the run");
    }
    // The write-ahead state is retained; nothing after the create happened.
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    // The planted alias is still a symlink (no .env write happened) and the
    // key content was never overwritten through it.
    expect(lstatSync(harness.outputPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(harness.keyPath, "utf8")).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
    // The lock is still released on the error path.
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
  });

  it("fails closed when an alias appears after the share checkpoint and before the .env write", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // The alias appears during the SA verify — after the spreadsheet_shared
    // checkpoint passed revalidation — so the .env preflight must catch it.
    harness.beforeVerify = () => {
      symlinkSync(harness.keyPath, harness.outputPath);
    };

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    if (result.status === "error") {
      expect(result.message).toContain("changed during the run");
    }
    // Verify ran, but the .env write and the complete checkpoint did not.
    expect(harness.verifyCalls).toHaveLength(1);
    expect(readState(harness.statePath).status).toBe("spreadsheet_shared");
    expect(lstatSync(harness.outputPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(harness.keyPath, "utf8")).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
  });

  it("fails closed when a hardlink of the key is planted at the output before the .env write", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // The alias appears during the SA verify: the output path becomes a
    // hardlink of the key file, so the .env preflight must detect the same
    // inode and refuse.
    harness.beforeVerify = () => {
      linkSync(harness.keyPath, harness.outputPath);
    };

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.INVALID_ARGS);
    if (result.status === "error") {
      expect(result.message).toContain("changed during the run");
    }
    // The shared key inode is byte-identical; no env content reached it.
    expect(readFileSync(harness.keyPath, "utf8")).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(readState(harness.statePath).status).toBe("spreadsheet_shared");
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
  });

  it("fails closed when a symlink is planted at the output before the .env write", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // A symlink to a NON-reserved file: the path check passes, but the
    // secure writer refuses to read or follow an existing symlink, so the
    // write fails closed instead of writing through the alias.
    const decoy = join(dir, "decoy.env");
    writeFileSync(decoy, "decoy-content", "utf8");
    harness.beforeVerify = () => {
      symlinkSync(decoy, harness.outputPath);
    };

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.OUTPUT_WRITE_FAILED);
    // The symlink entry and its target are untouched; the key is intact.
    expect(lstatSync(harness.outputPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(decoy, "utf8")).toBe("decoy-content");
    expect(readFileSync(harness.keyPath, "utf8")).not.toContain("GOOGLE_APPLICATION_CREDENTIALS");
    expect(readState(harness.statePath).status).toBe("spreadsheet_shared");
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
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

describe("secret leakage hardening", () => {
  it("safeReasonOf exposes only HTTP status and whitelisted constructed reasons", () => {
    expect(safeReasonOf(new Error(`boom ${SECRET_JWT}`))).toBe("unknown failure");
    expect(safeReasonOf(new Error(SECRET_KEY_MATERIAL))).toBe("unknown failure");
    expect(safeReasonOf({ response: { status: 403 } })).toBe("HTTP 403");
    expect(safeReasonOf(safeError("spreadsheets.get response is missing a spreadsheet id"))).toBe(
      "spreadsheets.get response is missing a spreadsheet id",
    );
  });

  it("never forwards arbitrary sheet API error messages into the result", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error(`create failed: ${SECRET_JWT} ${SECRET_KEY_MATERIAL}`);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).not.toContain(SECRET_JWT);
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
      expect(result.message).not.toContain("SECRETKEYMATERIAL");
      expect(result.message).toContain("no second spreadsheet will be created");
    }
  });

  it("never forwards marker lookup error text into the result", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error("response lost");
    harness.lookupError = new Error(`lookup failed: ${SECRET_JWT} ${SECRET_AUTHORIZATION}`);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).not.toContain(SECRET_JWT);
      expect(result.message).not.toContain("Authorization");
      expect(result.message).toContain("marker lookup failed");
    }
  });

  it("never forwards token validator error text into the result", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.tokenValidatorError = new Error(`validation failed: ${SECRET_JWT} ${SECRET_AUTHORIZATION}`);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.USER_TOKEN_FAILED);
    if (result.status === "error") {
      expect(result.message).not.toContain(SECRET_JWT);
      expect(result.message).not.toContain("Authorization");
      expect(result.message).not.toContain(FAKE_TOKEN);
      expect(result.message).toContain("unknown failure");
    }
  });

  it("never forwards SA verifier error text into the result", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.verifyError = new Error(`verify failed: ${SECRET_KEY_MATERIAL} ${SECRET_JWT}`);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SA_ACCESS_VERIFY_FAILED);
    if (result.status === "error") {
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
      expect(result.message).not.toContain(SECRET_JWT);
    }
  });

  it("fails setup with the sanitized path-only message when the key cannot be opened (flow level)", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(harness.keyPath, validKeyJson("proj-1", "sa@proj-1.iam.gserviceaccount.com"), "utf8");
    chmodSync(harness.keyPath, 0o000);
    try {
      if (typeof process.geteuid === "function" && process.geteuid() === 0) {
        // Root bypasses file permissions; the injected unit tests cover
        // the sanitization on every platform.
        return;
      }
      // The real filesystem open fails with EACCES; its raw text must
      // never reach the user-facing result — only the stable path-only
      // message may.
      const result = await harness.run();
      expectError(result, SETUP_ERROR_CODES.SETUP_STATE_INVALID);
      if (result.status === "error") {
        expect(result.message).toBe(`could not open ${harness.keyPath}`);
        expect(result.message).not.toContain("EACCES");
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("BEGIN PRIVATE KEY");
        expect(serialized).not.toContain(SECRET_JWT);
      }
    } finally {
      // Restore so the temp-dir cleanup can remove the key file.
      chmodSync(harness.keyPath, 0o600);
    }
  });

  it("never forwards gcloud stderr/stdout into project-phase failure messages", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) =>
      args[0] === "projects" && args[1] === "create"
        ? failed(1, `ERROR: ${SECRET_JWT}\n${SECRET_AUTHORIZATION}`)
        : freshSetupScript(harness.keyPath)(args, options);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.PROJECT_CREATE_FAILED);
    if (result.status === "error") {
      expect(result.message).not.toContain(SECRET_JWT);
      expect(result.message).not.toContain("Authorization");
      expect(result.message).toContain("status 1");
    }
  });

  it("keeps secrets out of the checkpoint, .env, and summary on success", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;

    const combined = [
      readFileSync(harness.statePath, "utf8"),
      readFileSync(harness.outputPath, "utf8"),
      formatSummary(result.summary),
    ].join("\n");
    expect(combined).not.toContain(FAKE_TOKEN);
    expect(combined).not.toContain("private_key");
    expect(combined).not.toContain("BEGIN PRIVATE KEY");
    expect(combined).not.toContain("Authorization");
  });

  it("never forwards JSON.parse exception text from a malformed checkpoint into the flow result or CLI output", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(
      harness.statePath,
      `{ "version": 1, "status": ${FAKE_TOKEN}, "key": "${SECRET_KEY_MATERIAL.replaceAll("\n", "\\n")}" }`,
      "utf8",
    );
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_INVALID);
    if (result.status === "error") {
      expect(result.message).toBe(`${harness.statePath} is not valid JSON`);
      // The formatted CLI error line carries no snippet or sentinel.
      const formatted = `hikoutei-setup:${result.code}: ${result.message}`;
      expect(formatted).not.toContain(FAKE_TOKEN);
      expect(formatted).not.toContain("BEGIN PRIVATE KEY");
      expect(formatted).not.toContain("SECRETKEYMATERIAL");
    }
    // The malformed checkpoint was rejected before any project/iam/service
    // subprocess, sheet API call, or SA verify.
    expect(harness.calls.some((c) => c[0] === "projects" || c[0] === "iam" || c[0] === "services")).toBe(false);
    expect(harness.created).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
  });

  it("never forwards JSON.parse exception text from a malformed key file into the flow result", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(
      harness.keyPath,
      `{ "private_key": "${SECRET_KEY_MATERIAL.replaceAll("\n", "\\n")}", "x": ${FAKE_TOKEN} }`,
      "utf8",
    );
    const result = await harness.run({ projectId: "existing-proj" });
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_INVALID);
    if (result.status === "error") {
      expect(result.message).toBe(`${harness.keyPath} is not valid JSON`);
      expect(result.message).not.toContain(FAKE_TOKEN);
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
      expect(result.message).not.toContain("SECRETKEYMATERIAL");
    }
    // The malformed key was rejected before any project/iam/service
    // subprocess or sheet API call.
    expect(harness.calls.some((c) => c[0] === "projects" || c[0] === "iam" || c[0] === "services")).toBe(false);
    expect(existsSync(harness.statePath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
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

describe("runSetup — fresh setup", () => {
  it("runs the full sequence: human auth, both APIs, human-owned sheet, share, verify, checkpoint, env", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // Prove the started checkpoint exists BEFORE the single create attempt.
    harness.beforeCreate = () => {
      expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    };
    // Prove the key write-ahead checkpoint exists BEFORE the gcloud key
    // create (the baseline list is recorded first).
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
        expect(readState(harness.statePath).status).toBe("key_create_started");
        const state = readState(harness.statePath);
        expect(isValidKeyMarker(state.keyMarker)).toBe(true);
        expect(state.keyBaseline).toStrictEqual([]);
        expect("private_key" in state).toBe(false);
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const result = await harness.run();

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;

    const commands = gcloudCommands(result.commands);
    expect(commands).toHaveLength(12);
    expect(commands[0]).toStrictEqual(["--version"]);
    expect(commands[1]).toStrictEqual(["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]);
    expect(commands[2]).toStrictEqual(["auth", "print-access-token"]);
    const slug = commands[3]?.[2] as string;
    expect(slug).toMatch(/^hikoutei-[a-z0-9]+-[a-z0-9]{4}$/);
    expect(commands[3]).toStrictEqual(["projects", "create", slug]);
    expect(commands[4]).toStrictEqual(["config", "set", "project", slug]);
    expect(commands[5]).toStrictEqual(["services", "enable", "sheets.googleapis.com", "drive.googleapis.com", "--project", slug]);
    expect(commands[6]).toStrictEqual(["iam", "service-accounts", "list", "--project", slug, "--format=value(email)"]);
    expect(commands[7]).toStrictEqual(["iam", "service-accounts", "create", "hikoutei-sa", "--project", slug, "--display-name", "hikoutei setup"]);
    // The keys list (write-ahead baseline) precedes the key create; the
    // reconciliation lists around the create prove no post-baseline key
    // appeared before the create and that the created key is active.
    expect(commands[8]).toStrictEqual(["iam", "service-accounts", "keys", "list", "--managed-by=user", "--format=value(name)", "--iam-account", serviceAccountEmail("hikoutei-sa", slug), "--project", slug]);
    expect(commands[9]).toStrictEqual(commands[8]);
    // The gcloud key create runs with a RELATIVE key.json destination from
    // the private sibling staging directory as the subprocess cwd (NEVER
    // the final key path); the staged key is installed afterwards.
    const keyCommand = commands[10] as readonly string[];
    expect(keyCommand).toStrictEqual([
      "iam",
      "service-accounts",
      "keys",
      "create",
      "key.json",
      "--iam-account",
      serviceAccountEmail("hikoutei-sa", slug),
      "--project",
      slug,
    ]);
    // The create invocation carried the validated staging directory as the
    // subprocess working directory, and that directory is a private
    // sibling of the final key path (never the key path itself).
    const createCallIndex = harness.calls.findIndex(
      (c) => c[0] === "iam" && c[2] === "keys" && c[3] === "create",
    );
    expect(createCallIndex).toBeGreaterThanOrEqual(0);
    const createCwd = harness.callOptions[createCallIndex]?.cwd;
    expect(createCwd).toBeDefined();
    if (createCwd !== undefined) {
      expect(dirname(createCwd)).toBe(dirname(harness.keyPath));
      expect(basename(createCwd)).toMatch(/^\.hikoutei-key-stage-/);
      expect(createCwd).not.toBe(harness.keyPath);
    }
    expect(commands[11]).toStrictEqual(commands[8]);
    expect(harness.calls.map((c) => c.join(" "))).toEqual(commands.map((c) => c.join(" ")));
    // The staging directory was removed after the atomic install.
    expect(readdirSync(dir).some((name) => name.startsWith(".hikoutei-key-stage-"))).toBe(false);

    // key_ready was persisted after the key was secured and BEFORE the
    // spreadsheet create (the create's checkpoint entry follows it).
    const keyReadyStep = result.commands.findIndex(
      (c) => c.kind === "file" && c.outcome.includes("key_ready"),
    );
    const sheetCreateStep = result.commands.findIndex(
      (c) => c.kind === "api" && c.label.includes("drive.files.create"),
    );
    expect(keyReadyStep).toBeGreaterThanOrEqual(0);
    expect(keyReadyStep).toBeLessThan(sheetCreateStep);
    expect(
      result.commands.some((c) => c.kind === "file" && c.outcome.includes("key_create_started")),
    ).toBe(true);

    // The human API receives the memory-only token and creates exactly once
    // with a fresh creation marker (never a client-supplied id).
    expect(harness.humanTokens).toStrictEqual([FAKE_TOKEN]);
    expect(harness.created).toHaveLength(1);
    const created = harness.created[0] as { title: string; marker: string };
    expect(created.title).toBe(`hikoutei-sync-${slug}`);
    expect(isValidCreationMarker(created.marker)).toBe(true);
    // No marker lookup was needed on the happy path.
    expect(harness.lookupCalls).toHaveLength(0);
    expect(harness.shares).toStrictEqual([
      {
        spreadsheetId: CREATED_SHEET_ID,
        saEmail: serviceAccountEmail("hikoutei-sa", slug),
        ownerEmail: FAKE_OWNER,
      },
    ]);
    // The verifier received the in-memory credentials promoted from the
    // secured key file (never a path reopen).
    const state = readState(harness.statePath);
    expect(harness.verifyCalls).toStrictEqual([
      {
        keyPath: harness.keyPath,
        spreadsheetId: CREATED_SHEET_ID,
        keyFresh: true,
        shareFresh: true,
        credentials: {
          client_email: serviceAccountEmail("hikoutei-sa", state.projectId as string),
          private_key: RSA_PRIVATE_KEY_PEM,
        },
      },
    ]);

    // Summary carries identities, roles, checkpoint, and env.
    expect(result.summary).toMatchObject({
      projectId: slug,
      ownerEmail: FAKE_OWNER,
      serviceAccountEmail: serviceAccountEmail("hikoutei-sa", slug),
      keyPath: harness.keyPath,
      spreadsheetId: CREATED_SHEET_ID,
      spreadsheetUrl: CREATED_SHEET_URL,
      outputPath: harness.outputPath,
      statePath: harness.statePath,
      stateStatus: "complete",
      envFileCreated: true,
      envFileModified: true,
      projectReused: false,
      serviceAccountReused: false,
      keyReused: false,
      saWriterRole: "created",
      resumed: false,
    });

    // Checkpoint: complete status, correct identities, mode 0600, the URL is
    // derived (never stored), and never any token or key material.
    expect(state).toMatchObject({
      version: SETUP_STATE_VERSION,
      status: "complete",
      projectId: slug,
      projectMode: "generated",
      ownerEmail: FAKE_OWNER,
      saName: "hikoutei-sa",
      saEmail: serviceAccountEmail("hikoutei-sa", slug),
      keyPath: harness.keyPath,
      spreadsheetTitle: `hikoutei-sync-${slug}`,
      spreadsheetId: CREATED_SHEET_ID,
    });
    expect("spreadsheetUrl" in state).toBe(false);
    expect("creationMarker" in state).toBe(false);
    expect("keyMarker" in state).toBe(false);
    expect("keyBaseline" in state).toBe(false);
    // The non-secret key provenance discriminant survives to completion.
    expect(state.keyOrigin).toBe("created");
    expect(statSync(harness.statePath).mode & 0o777).toBe(0o600);
    const stateText = readFileSync(harness.statePath, "utf8");
    expect(stateText).not.toContain(FAKE_TOKEN);
    expect(stateText).not.toContain("private_key");
    expect(stateText).not.toContain("BEGIN PRIVATE KEY");

    // .env contains the two managed keys (URL derived from the id) and no token.
    const envText = readFileSync(harness.outputPath, "utf8");
    expect(envText).toBe(
      `${SETUP_ENV_KEYS.CREDENTIALS}=${harness.keyPath}\n${SETUP_ENV_KEYS.SPREADSHEET_URL}=${CREATED_SHEET_URL}\n`,
    );
    expect(envText).not.toContain(FAKE_TOKEN);

    // Key file exists with mode 600.
    expect(existsSync(harness.keyPath)).toBe(true);
    expect(statSync(harness.keyPath).mode & 0o777).toBe(0o600);

    // The exclusive lock was released on exit.
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);

    // The fake runner's side effects never escape the temp directory: no
    // command-shaped artifact may appear in the working directory.
    expect(readdirSync(".").some((name) => name.startsWith("--managed-by"))).toBe(false);
  });

  it("uses a custom spreadsheet title when given", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ spreadsheetTitle: "My Custom Sheet" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(harness.created[0]?.title).toBe("My Custom Sheet");
    expect(result.summary.spreadsheetTitle).toBe("My Custom Sheet");
    expect(readState(harness.statePath).spreadsheetTitle).toBe("My Custom Sheet");
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
    // An explicit project verified by describe exists: the summary reports
    // it as reused, never created.
    expect(result.summary.projectReused).toBe(true);
    expect(readState(harness.statePath).projectMode).toBe("explicit");
  });
});

describe("runSetup — spreadsheet marker reconciliation", () => {
  /** A marker-query result that matches the flow's marker for a run. */
  function matchingLookup(
    spreadsheetId: string,
    name: string,
    overrides: Partial<MarkerFileInfo> = {},
  ): (marker: string) => readonly MarkerFileInfo[] {
    return (marker) => [
      {
        spreadsheetId,
        name,
        mimeType: SPREADSHEET_MIME_TYPE,
        appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: marker },
        ...overrides,
      },
    ];
  }

  it("reconciles a create whose response was lost by the exact marker and never creates twice", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error("connection reset while creating");
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    // The started checkpoint (with the marker) is retained.
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    const marker = readState(harness.statePath).creationMarker as string;
    expect(isValidCreationMarker(marker)).toBe(true);
    expect(harness.created).toHaveLength(1);
    expect(harness.created[0]?.marker).toBe(marker);
    expect(harness.lookupCalls).toStrictEqual([marker]);

    // The remote file now exists with that marker: recovery by marker, no
    // second create.
    const slug = harness.calls.find((c) => c[0] === "projects")?.[2] as string;
    harness.lookupResult = matchingLookup(CREATED_SHEET_ID, `hikoutei-sync-${slug}`);
    const second = await harness.run();
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    expect(second.summary.spreadsheetId).toBe(CREATED_SHEET_ID);
    expect(second.summary.resumed).toBe(true);
    expect(harness.created).toHaveLength(1);
    expect(harness.lookupCalls).toStrictEqual([marker, marker]);
    expect(readState(harness.statePath).status).toBe("complete");
    expect(readState(harness.statePath).spreadsheetId).toBe(CREATED_SHEET_ID);
  });

  it("keeps spreadsheet_create_started and fails with sheet_create_uncertain when the marker lookup finds nothing", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error("quota exceeded");

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).toContain("no second spreadsheet will be created");
      expect(result.message).toContain("inspect Drive");
    }
    const state = readState(harness.statePath);
    expect(state.status).toBe("spreadsheet_create_started");
    expect(isValidCreationMarker(state.creationMarker)).toBe(true);
    expect(harness.lookupCalls).toHaveLength(1);
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    expect(existsSync(harness.outputPath)).toBe(false);
    // The lock is released even on the error path.
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
  });

  it("resumes a started state with one marker match and recovers without creating", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error("quota exceeded");
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    const marker = readState(harness.statePath).creationMarker as string;
    const title = readState(harness.statePath).spreadsheetTitle as string;

    harness.createError = undefined;
    harness.lookupResult = matchingLookup(CREATED_SHEET_ID, title);
    const second = await harness.run();
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    expect(second.summary.spreadsheetId).toBe(CREATED_SHEET_ID);
    expect(second.summary.resumed).toBe(true);
    // Exactly one create attempt across both runs; the resume reconciled by
    // marker only.
    expect(harness.created).toHaveLength(1);
    expect(harness.lookupCalls).toStrictEqual([marker, marker]);
    expect(harness.shares).toHaveLength(1);
    expect(readState(harness.statePath).status).toBe("complete");
  });

  it("never creates from a started state with zero matches (uncertain again)", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error("quota exceeded");
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);

    harness.createError = undefined;
    const second = await harness.run();
    expectError(second, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    // No create was attempted on resume and the state is retained.
    expect(harness.created).toHaveLength(1);
    expect(harness.shares).toHaveLength(0);
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
  });

  it("fails with a conflict-style uncertain error on ambiguous (>1) marker matches", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error("quota exceeded");
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    const marker = readState(harness.statePath).creationMarker as string;
    const title = readState(harness.statePath).spreadsheetTitle as string;

    harness.lookupResult = (m) => [
      { spreadsheetId: "sheet-a", name: title, mimeType: SPREADSHEET_MIME_TYPE, appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: m } },
      { spreadsheetId: "sheet-b", name: title, mimeType: SPREADSHEET_MIME_TYPE, appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: m } },
    ];
    const second = await harness.run();
    expectError(second, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (second.status === "error") {
      expect(second.message).toContain("more than one file carries");
    }
    expect(harness.created).toHaveLength(1);
    expect(harness.lookupCalls).toStrictEqual([marker, marker]);
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
  });

  it("rejects non-spreadsheet, wrong-name, and wrong-marker matches without creating", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error("quota exceeded");
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    const marker = readState(harness.statePath).creationMarker as string;
    const title = readState(harness.statePath).spreadsheetTitle as string;

    // Non-spreadsheet mime type.
    harness.lookupResult = matchingLookup(CREATED_SHEET_ID, title, { mimeType: "application/vnd.google-apps.document" });
    let result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).toContain("not a spreadsheet");
    }

    // Wrong name.
    harness.lookupResult = matchingLookup(CREATED_SHEET_ID, "Some Other Sheet");
    result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).toContain("different name");
    }

    // Wrong marker (does not carry the expected appProperties value).
    harness.lookupResult = (m) => [
      { spreadsheetId: CREATED_SHEET_ID, name: title, mimeType: SPREADSHEET_MIME_TYPE, appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: "00000000-0000-4000-8000-000000000000" } },
    ];
    result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).toContain("does not carry the expected marker");
    }

    // Never created a second spreadsheet across all resume attempts.
    expect(harness.created).toHaveLength(1);
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
  });

  it("treats an unavailable marker lookup as uncertain without creating", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error("response lost");
    harness.lookupError = new Error("drive API down");

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).toContain("marker lookup failed");
    }
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    expect(harness.created).toHaveLength(1);
  });

  it("resumes a custom spreadsheet title from the checkpoint instead of re-defaulting", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error("quota exceeded");
    const first = await harness.run({ spreadsheetTitle: "My Custom Sheet" });
    expectError(first, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    expect(readState(harness.statePath).spreadsheetTitle).toBe("My Custom Sheet");
    const marker = readState(harness.statePath).creationMarker as string;

    // Resume without --spreadsheet-title: the stored title wins and the
    // recovered match must carry that same name.
    harness.lookupResult = matchingLookup(CREATED_SHEET_ID, "My Custom Sheet");
    const second = await harness.run();
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    expect(second.summary.spreadsheetTitle).toBe("My Custom Sheet");
    expect(harness.created).toHaveLength(1);
    expect(harness.lookupCalls).toStrictEqual([marker, marker]);
  });

  it("rolls a rejected 400/403 create with zero marker matches back to key_ready with sheet_create_failed, and a rerun creates once with a new marker", async () => {
    for (const status of [400, 403]) {
      // The module-level fake key-created flag is shared across iterations:
      // reset it so each iteration starts from a truly fresh key baseline.
      fakeKeyCreated = false;
      const dir = makeTempDir();
      const harness = createHarness(dir);
      const rejected = new Error("request refused") as Error & { response?: { status: number } };
      rejected.response = { status };
      harness.createError = rejected;
      const first = await harness.run();
      expectError(first, SETUP_ERROR_CODES.SHEET_CREATE_FAILED);
      if (first.status === "error") {
        expect(first.message).toContain(`HTTP ${status}`);
        expect(first.message).toContain("nothing was created");
        expect(first.message).toContain("rerun setup");
      }
      // The rejection is known non-mutating and the marker lookup confirmed
      // zero matches: the checkpoint rolls back to key_ready so the next
      // run starts a fresh marker instead of reconciling forever.
      expect(readState(harness.statePath).status).toBe("key_ready");
      expect(harness.created).toHaveLength(1);
      expect(harness.lookupCalls).toHaveLength(1);
      const marker1 = harness.created[0]?.marker as string;
      expect(isValidCreationMarker(marker1)).toBe(true);
      expect(harness.shares).toHaveLength(0);
      expect(existsSync(harness.outputPath)).toBe(false);

      // Rerun after the user fixes the issue: a NEW marker is generated and
      // exactly one create attempt happens.
      harness.createError = undefined;
      const second = await harness.run();
      expect(second.status).toBe("ok");
      if (second.status !== "ok" || second.dryRun) return;
      expect(harness.created).toHaveLength(2);
      const marker2 = harness.created[1]?.marker as string;
      expect(isValidCreationMarker(marker2)).toBe(true);
      expect(marker2).not.toBe(marker1);
      expect(second.summary.spreadsheetId).toBe(CREATED_SHEET_ID);
      expect(readState(harness.statePath).status).toBe("complete");
      // The rollback preserved the created-key provenance: the rerun keeps
      // Invalid JWT Signature propagation retries enabled.
      expect(harness.verifyCalls[harness.verifyCalls.length - 1]).toMatchObject({ keyFresh: true });
    }
  });

  it("preserves keyFresh=true across a resume when the key was created by the setup", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error("response lost");
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    // The started checkpoint records the key as created by the setup.
    expect(readState(harness.statePath).keyOrigin).toBe("created");

    const marker = readState(harness.statePath).creationMarker as string;
    const title = readState(harness.statePath).spreadsheetTitle as string;
    harness.createError = undefined;
    harness.lookupResult = matchingLookup(CREATED_SHEET_ID, title);
    const second = await harness.run();
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    // Propagation evidence survives the resume: even though the CURRENT run
    // reused the key file (summary keyReused=true), the key was created by
    // the setup, so the verify phase keeps the Invalid JWT Signature
    // retries.
    expect(second.summary.keyReused).toBe(true);
    expect(harness.verifyCalls[harness.verifyCalls.length - 1]).toMatchObject({ keyFresh: true });
    expect(readState(harness.statePath).status).toBe("complete");
    expect(readState(harness.statePath).keyOrigin).toBe("created");
  });

  it("recovers a rejected 403 create whose marker match already exists", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const rejected = new Error("permission denied") as Error & { response?: { status: number } };
    rejected.response = { status: 403 };
    harness.createError = rejected;
    harness.lookupResult = matchingLookup(CREATED_SHEET_ID, "Fixed Title");

    const result = await harness.run({ spreadsheetTitle: "Fixed Title" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    // The marker match proves the spreadsheet exists: promoted normally,
    // never a second create.
    expect(harness.created).toHaveLength(1);
    expect(result.summary.spreadsheetId).toBe(CREATED_SHEET_ID);
    expect(readState(harness.statePath).status).toBe("complete");
  });

  it("keeps spreadsheet_create_started and returns sheet_create_uncertain when the 400/403 marker lookup fails or is ambiguous", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const rejected = new Error("bad request") as Error & { response?: { status: number } };
    rejected.response = { status: 400 };
    harness.createError = rejected;

    // Lookup failure: unknown outcome, started state retained.
    harness.lookupError = new Error("drive API down");
    let result = await harness.run({ spreadsheetTitle: "Fixed Title" });
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).toContain("marker lookup failed");
    }
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    expect(harness.created).toHaveLength(1);

    // Ambiguous (>1) matches: still uncertain, still retained.
    harness.lookupError = undefined;
    harness.lookupResult = (m) => [
      { spreadsheetId: "sheet-a", name: "Fixed Title", mimeType: SPREADSHEET_MIME_TYPE, appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: m } },
      { spreadsheetId: "sheet-b", name: "Fixed Title", mimeType: SPREADSHEET_MIME_TYPE, appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: m } },
    ];
    result = await harness.run({ spreadsheetTitle: "Fixed Title" });
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).toContain("more than one file");
    }
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    // Exactly one create across both runs; never a second spreadsheet.
    expect(harness.created).toHaveLength(1);
  });

  it("flow-level: a 400/403 create with an empty first page (token present) and a later-page match never rolls back to key_ready", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);

    // Production-shaped paginated lookup over scripted pages: page 1 is
    // empty but carries a continuation token; the exact match arrives on
    // page 2. A single-page reader would report zero matches and roll the
    // checkpoint back to key_ready, so the next run would create a SECOND
    // spreadsheet with a fresh marker.
    const requests: Array<{ q: string; spaces: string; fields: string; pageSize: number; pageToken?: string }> = [];
    let lastMarker = "";
    const listApi: DriveFileListApi = {
      async list(request) {
        requests.push(request);
        if (request.pageToken === undefined) {
          return { data: { files: [], nextPageToken: "tok-1" , incompleteSearch: false } };
        }
        return {
          data: {
            files: [
              {
                id: "sheet-late",
                name: "Fixed Title",
                mimeType: SPREADSHEET_MIME_TYPE,
                appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: lastMarker },
              },
            ],
            incompleteSearch: false,
          },
        };
      },
    };
    const rejected = new Error("request refused") as Error & { response?: { status: number } };
    rejected.response = { status: 400 };
    let created = 0;
    const humanApi: HumanSheetApi = {
      async createSpreadsheet(request: { title: string; marker: string }) {
        created += 1;
        lastMarker = request.marker;
        throw rejected;
      },
      async findSpreadsheetByMarker(marker: string): Promise<readonly MarkerFileInfo[]> {
        // The REAL production pagination over the scripted pages.
        return listAllMarkerFiles(listApi, marker);
      },
      async ensureSaWriter() {
        return { writerRole: "created" };
      },
    };
    const run = (): Promise<SetupResult> =>
      harness.run({ spreadsheetTitle: "Fixed Title", createHumanApi: () => humanApi });

    const first = await run();
    // The later-page match recovers the sheet: the run completes as if the
    // create had succeeded — the checkpoint is NEVER rolled back to
    // key_ready and no second spreadsheet is created.
    expect(first.status).toBe("ok");
    if (first.status !== "ok" || first.dryRun) return;
    expect(first.summary.spreadsheetId).toBe("sheet-late");
    expect(readState(harness.statePath).status).toBe("complete");
    expect(created).toBe(1);
    // Both pages were walked with the exact query and fields; only the
    // follow-up request carries the continuation token.
    expect(requests).toHaveLength(2);
    expect(requests[0]).toStrictEqual({
      q: `appProperties has { key='hikouteiSetupMarker' and value='${lastMarker}' }`,
      spaces: "drive",
      fields: "files(id,name,mimeType,appProperties),nextPageToken,incompleteSearch",
      pageSize: 10,
    });
    expect(requests[1]).toStrictEqual({
      q: `appProperties has { key='hikouteiSetupMarker' and value='${lastMarker}' }`,
      spaces: "drive",
      fields: "files(id,name,mimeType,appProperties),nextPageToken,incompleteSearch",
      pageSize: 10,
      pageToken: "tok-1",
    });
  });

  it("flow-level: a 400/403 create with an incompleteSearch marker lookup stays uncertain — never rolls back and never creates again", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);

    // The create is rejected up front (HTTP 400) and the marker lookup
    // reports `incompleteSearch: true`: the server could not fully search
    // the corpus, so the aggregated "zero matches" verdict cannot be
    // trusted. The flow must fail closed with `sheet_create_uncertain` and
    // RETAIN the started checkpoint — never roll back to key_ready (which
    // would let the next run create a second spreadsheet with a fresh
    // marker) and never issue a second create.
    const rejected = new Error("request refused") as Error & { response?: { status: number } };
    rejected.response = { status: 400 };
    let created = 0;
    const humanApi: HumanSheetApi = {
      async createSpreadsheet() {
        created += 1;
        throw rejected;
      },
      async findSpreadsheetByMarker(marker: string): Promise<readonly MarkerFileInfo[]> {
        // The REAL production pagination over an incomplete-search page.
        return listAllMarkerFiles(
          {
            async list() {
              return { data: { files: [], incompleteSearch: true } };
            },
          },
          marker,
        );
      },
      async ensureSaWriter() {
        return { writerRole: "created" };
      },
    };

    const first = await harness.run({ spreadsheetTitle: "Fixed Title", createHumanApi: () => humanApi });
    expectError(first, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (first.status === "error") {
      expect(first.message).toContain("no second spreadsheet will be created");
    }
    // The started checkpoint is retained (no rollback to key_ready) and
    // exactly ONE create attempt happened (never a second).
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    expect(created).toBe(1);

    // A rerun reconciles the same marker and stays uncertain; the create is
    // never repeated.
    const second = await harness.run({ spreadsheetTitle: "Fixed Title", createHumanApi: () => humanApi });
    expectError(second, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    expect(created).toBe(1);
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
  });

  it("flow-level: duplicates found on a later page after an empty first page keep the started state; the next run reconciles instead of creating a second Sheet", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);

    // Page 1 is empty with a continuation token; page 2 carries TWO exact
    // marker matches. The aggregated result is ambiguous, so the flow must
    // keep `spreadsheet_create_started` and stay uncertain — NEVER roll
    // back to key_ready (which would let the next run create a second
    // spreadsheet with a fresh marker).
    const requests: Array<{ pageToken?: string }> = [];
    let lastMarker = "";
    const listApi: DriveFileListApi = {
      async list(request) {
        requests.push(request);
        if (request.pageToken === undefined) {
          return { data: { files: [], nextPageToken: "tok-1" , incompleteSearch: false } };
        }
        return {
          data: {
            files: [
              {
                id: "sheet-a",
                name: "Fixed Title",
                mimeType: SPREADSHEET_MIME_TYPE,
                appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: lastMarker },
              },
              {
                id: "sheet-b",
                name: "Fixed Title",
                mimeType: SPREADSHEET_MIME_TYPE,
                appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: lastMarker },
              },
            ],
            incompleteSearch: false,
          },
        };
      },
    };
    const rejected = new Error("request refused") as Error & { response?: { status: number } };
    rejected.response = { status: 403 };
    let created = 0;
    const humanApi: HumanSheetApi = {
      async createSpreadsheet(request: { title: string; marker: string }) {
        created += 1;
        lastMarker = request.marker;
        throw rejected;
      },
      async findSpreadsheetByMarker(marker: string): Promise<readonly MarkerFileInfo[]> {
        return listAllMarkerFiles(listApi, marker);
      },
      async ensureSaWriter() {
        return { writerRole: "created" };
      },
    };
    const run = (): Promise<SetupResult> =>
      harness.run({ spreadsheetTitle: "Fixed Title", createHumanApi: () => humanApi });

    const first = await run();
    expectError(first, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    if (first.status === "error") {
      expect(first.message).toContain("more than one file");
      expect(first.message).toContain("no second spreadsheet will be created");
    }
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    expect(created).toBe(1);
    // Both pages were walked before the outcome was decided.
    expect(requests).toHaveLength(2);

    // The next run reconciles by marker (both pages again) and NEVER
    // issues a second create: same marker, same ambiguity, zero creates.
    const second = await run();
    expectError(second, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    expect(created).toBe(1);
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    expect(readState(harness.statePath).creationMarker).toBe(lastMarker);
    expect(requests).toHaveLength(4);
  });
});

describe("runSetup — idempotent reuse", () => {
  it("reuses a project whose creation reports already-exists", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "projects" && args[1] === "create") {
        return failed(1, "ERROR: (gcloud.projects.create) Project 'x' already exists.");
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const result = await harness.run();

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(result.summary.projectReused).toBe(true);
    expect(result.summary.projectId).toMatch(/^hikoutei-/);
    const commands = gcloudCommands(result.commands);
    expect(commands).toContainEqual(["config", "set", "project", result.summary.projectId]);
    expect(commands.some((c) => c[0] === "iam" && c[2] === "keys")).toBe(true);
  });

  it("reuses an existing service account by email", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "list") {
        const projectId = args[4] as string;
        return { status: "ok", stdout: `${serviceAccountEmail("hikoutei-sa", projectId)}\n`, stderr: "" };
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const result = await harness.run();

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(result.summary.serviceAccountReused).toBe(true);
    const commands = gcloudCommands(result.commands);
    expect(commands.some((c) => c[0] === "iam" && c[2] === "create")).toBe(false);
    expect(commands.some((c) => c[0] === "iam" && c[2] === "keys")).toBe(true);
  });

  it("reuses an existing key file when it matches the explicit project", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const keyFixture = validKeyJson("existing-proj", "hikoutei-sa@existing-proj.iam.gserviceaccount.com");
    // Real gcloud key files are created with mode 0600; simulate that.
    writeFileSync(harness.keyPath, keyFixture, { encoding: "utf8", mode: 0o600 });
    const result = await harness.run({ projectId: "existing-proj" });

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(result.summary.keyReused).toBe(true);
    // The explicit project was verified by describe: it is reused, never
    // created, so the summary reports it as reused.
    expect(result.summary.projectReused).toBe(true);
    const commands = gcloudCommands(result.commands);
    expect(commands.some((c) => c[0] === "iam" && c[2] === "keys")).toBe(false);
    // The existing key file was not overwritten.
    expect(readFileSync(harness.keyPath, "utf8")).toBe(keyFixture);
    expect(statSync(harness.keyPath).mode & 0o777).toBe(0o600);
  });
});

describe("runSetup — checkpoint resume", () => {
  it("resumes a full run without creating a second spreadsheet and keeps env unchanged", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const first = await harness.run();
    expect(first.status).toBe("ok");
    const firstRunCallCount = harness.calls.length;

    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;

    // Nothing was re-created or re-verified on resume.
    expect(harness.created).toHaveLength(1);
    expect(harness.shares).toHaveLength(1);
    expect(harness.verifyCalls).toHaveLength(1);
    expect(harness.calls.slice(firstRunCallCount).map((c) => c.join(" "))).toEqual([
      "--version",
      "auth list --filter=status:ACTIVE --format=value(account)",
      "auth print-access-token",
    ]);
    expect(result.summary.resumed).toBe(true);
    expect(result.summary.saWriterRole).toBe("unchanged");
    expect(result.summary.serviceAccountReused).toBe(true);
    // Resuming past project selection means this run reused the project.
    expect(result.summary.projectReused).toBe(true);
    expect(result.summary.envFileModified).toBe(false);
    expect(readState(harness.statePath).status).toBe("complete");
  });

  it("resumes after a share failure: reuses the created sheet and shares once", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.shareError = new Error("drive API refused the permission");
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.SHEET_SHARE_FAILED);
    // Arbitrary API error text must not be forwarded; the reason is generic.
    if (first.status === "error") {
      expect(first.message).toContain("could not share spreadsheet");
      expect(first.message).not.toContain("drive API refused");
    }

    // The checkpoint was persisted right after creation
    // (spreadsheet_created) and then the share write-ahead
    // (spreadsheet_share_started) BEFORE the failed permission ensure.
    const state = readState(harness.statePath);
    expect(state.status).toBe("spreadsheet_share_started");
    expect(state.spreadsheetId).toBe(CREATED_SHEET_ID);
    expect(state.keyOrigin).toBe("created");
    expect("shareOrigin" in state).toBe(false);
    expect("spreadsheetUrl" in state).toBe(false);

    harness.shareError = undefined;
    const second = await harness.run();
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;

    // Exactly one spreadsheet create across both runs; the idempotent
    // share/ownership ensure ran once (failed) in the first run and once
    // (succeeded) in the second.
    expect(harness.created).toHaveLength(1);
    expect(harness.shares).toHaveLength(2);
    // The key was CREATED by the setup (keyOrigin persisted from run 1),
    // so the resumed verify keeps keyFresh=true and the Invalid JWT
    // Signature propagation retries, even though THIS run reused the key
    // file (summary keyReused stays a current-run fact). The verifier
    // receives the in-memory credentials promoted from the key file.
    expect(harness.verifyCalls).toStrictEqual([
      {
        keyPath: harness.keyPath,
        spreadsheetId: CREATED_SHEET_ID,
        keyFresh: true,
        shareFresh: true,
        credentials: {
          client_email: serviceAccountEmail("hikoutei-sa", state.projectId as string),
          private_key: RSA_PRIVATE_KEY_PEM,
        },
      },
    ]);
    expect(second.summary.resumed).toBe(true);
    expect(second.summary.saWriterRole).toBe("created");
    expect(readState(harness.statePath).status).toBe("complete");
  });

  it("keeps shareFresh=true on a resumed shared-but-unverified state from a prior fresh share", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    // Crash after the share persisted but before the SA access verify:
    // the checkpoint records shareOrigin fresh from the earlier run.
    writeFileSync(harness.keyPath, validKeyJson(projectId, saEmail), "utf8");
    writeFileSync(
      harness.statePath,
      JSON.stringify({
        version: SETUP_STATE_VERSION,
        status: "spreadsheet_shared",
        projectId,
        projectMode: "generated",
        ownerEmail: FAKE_OWNER,
        saName: "hikoutei-sa",
        saEmail,
        keyPath: harness.keyPath,
        spreadsheetTitle: `hikoutei-sync-${projectId}`,
        spreadsheetId: CREATED_SHEET_ID,
        keyOrigin: "created",
        shareOrigin: "fresh",
      }),
      "utf8",
    );

    const result = await harness.run({ projectId });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    // The share step was NOT re-run; the verify phase keeps the 403/404
    // propagation retries because the persisted shareOrigin is fresh. The
    // verifier receives the in-memory credentials promoted from the key.
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toStrictEqual([
      {
        keyPath: harness.keyPath,
        spreadsheetId: CREATED_SHEET_ID,
        keyFresh: true,
        shareFresh: true,
        credentials: { client_email: saEmail, private_key: RSA_PRIVATE_KEY_PEM },
      },
    ]);
    // The provenance discriminants survive into the complete checkpoint.
    const state = readState(harness.statePath);
    expect(state.status).toBe("complete");
    expect(state.keyOrigin).toBe("created");
    expect(state.shareOrigin).toBe("fresh");
  });

  it("passes shareFresh=false on a resumed shared-but-unverified state from a prior permission reuse", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeFileSync(harness.keyPath, validKeyJson(projectId, saEmail), "utf8");
    writeFileSync(
      harness.statePath,
      JSON.stringify({
        version: SETUP_STATE_VERSION,
        status: "spreadsheet_shared",
        projectId,
        projectMode: "generated",
        ownerEmail: FAKE_OWNER,
        saName: "hikoutei-sa",
        saEmail,
        keyPath: harness.keyPath,
        spreadsheetTitle: `hikoutei-sync-${projectId}`,
        spreadsheetId: CREATED_SHEET_ID,
        keyOrigin: "reused",
        shareOrigin: "reused",
      }),
      "utf8",
    );

    const result = await harness.run({ projectId });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(harness.shares).toHaveLength(0);
    // A reused share is NOT propagation-class: 403/404 must fail at once.
    expect(harness.verifyCalls).toStrictEqual([
      {
        keyPath: harness.keyPath,
        spreadsheetId: CREATED_SHEET_ID,
        keyFresh: false,
        shareFresh: false,
        credentials: { client_email: saEmail, private_key: RSA_PRIVATE_KEY_PEM },
      },
    ]);
    expect(readState(harness.statePath).shareOrigin).toBe("reused");
  });

  it("refuses a FOREIGN key planted before the SA verify: SA_ACCESS_VERIFY_FAILED and the verifier never runs", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // The key is VALID for this setup at the load-time identity check, then
    // an attacker replaces it with a foreign credential AFTER the load
    // check (simulated at the create hook, between the key phase and the
    // verify phase). The verify phase re-reads the key at the secure
    // boundary and must refuse the foreign credential BEFORE the verifier
    // can run with it.
    const projectId = "existing-proj";
    const saEmail = "hikoutei-sa@existing-proj.iam.gserviceaccount.com";
    writeFileSync(harness.keyPath, validKeyJson(projectId, saEmail), "utf8");
    harness.beforeCreate = () => {
      writeFileSync(
        harness.keyPath,
        validKeyJson("evil-proj", "evil@evil-proj.iam.gserviceaccount.com", FOREIGN_KEY_ID),
        "utf8",
      );
    };

    const result = await harness.run({ projectId });
    expectError(result, SETUP_ERROR_CODES.SA_ACCESS_VERIFY_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("belongs to");
      expect(result.message).toContain("evil-proj");
      // The private key material is never echoed.
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
      expect(result.message).not.toContain(FOREIGN_KEY_ID);
    }
    // The verifier never ran (the foreign credential was refused before it
    // could reach the Sheets client); the env file was NOT written and the
    // checkpoint stays at the shared state.
    expect(harness.verifyCalls).toHaveLength(0);
    expect(existsSync(harness.outputPath)).toBe(false);
    expect(readState(harness.statePath).status).toBe("spreadsheet_shared");
  });

  it("refuses a foreign key already present at a resumed spreadsheet_shared checkpoint before the verify phase", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    // The shared-but-unverified checkpoint expects THIS project/account,
    // but the key at the recorded path already belongs to a foreign
    // account: the load-time identity check must refuse it before the
    // verify phase (or any share/.env mutation) can run.
    writeFileSync(
      harness.keyPath,
      validKeyJson("evil-proj", "evil@evil-proj.iam.gserviceaccount.com", FOREIGN_KEY_ID),
      "utf8",
    );
    writeFileSync(
      harness.statePath,
      JSON.stringify({
        version: SETUP_STATE_VERSION,
        status: "spreadsheet_shared",
        projectId,
        projectMode: "generated",
        ownerEmail: FAKE_OWNER,
        saName: "hikoutei-sa",
        saEmail,
        keyPath: harness.keyPath,
        spreadsheetTitle: `hikoutei-sync-${projectId}`,
        spreadsheetId: CREATED_SHEET_ID,
        keyOrigin: "created",
        shareOrigin: "fresh",
      }),
      "utf8",
    );

    const result = await harness.run({ projectId });
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_CONFLICT);
    if (result.status === "error") {
      expect(result.message).toContain("belongs to");
      expect(result.message).toContain("evil-proj");
      expect(result.message).toContain("setup state expects");
      // The private key material is never echoed.
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
      expect(result.message).not.toContain(FOREIGN_KEY_ID);
    }
    // The verifier never ran, no share or .env write happened, and the
    // state is untouched.
    expect(harness.verifyCalls).toHaveLength(0);
    expect(harness.shares).toHaveLength(0);
    expect(existsSync(harness.outputPath)).toBe(false);
    expect(readState(harness.statePath).status).toBe("spreadsheet_shared");
    // The foreign key file itself is untouched.
    expect(readFileSync(harness.keyPath, "utf8")).toBe(
      validKeyJson("evil-proj", "evil@evil-proj.iam.gserviceaccount.com", FOREIGN_KEY_ID),
    );
  });

  it("persists shareOrigin fresh for a created/upgraded writer permission and reused for a reuse", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.shareOutcome = { writerRole: "created" };
    const created = await harness.run();
    expect(created.status).toBe("ok");
    if (created.status !== "ok" || created.dryRun) return;
    expect(readState(harness.statePath).shareOrigin).toBe("fresh");

    const reusedDir = makeTempDir();
    const reusedHarness = createHarness(reusedDir);
    reusedHarness.shareOutcome = { writerRole: "reused" };
    const reused = await reusedHarness.run();
    expect(reused.status).toBe("ok");
    if (reused.status !== "ok" || reused.dryRun) return;
    expect(readState(reusedHarness.statePath).shareOrigin).toBe("reused");
    // An upgraded writer permission is also a fresh share.
    const upgradedDir = makeTempDir();
    const upgradedHarness = createHarness(upgradedDir);
    upgradedHarness.shareOutcome = { writerRole: "upgraded" };
    const upgraded = await upgradedHarness.run();
    expect(upgraded.status).toBe("ok");
    if (upgraded.status !== "ok" || upgraded.dryRun) return;
    expect(readState(upgradedHarness.statePath).shareOrigin).toBe("fresh");
  });

  it("keeps shareFresh=false for truly pre-existing writer permission reuse in an uninterrupted flow", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // The writer permission already existed (reused) and nothing crashed:
    // the provenance must stay reused and the verify phase must NOT get
    // the 403/404 propagation retries.
    harness.shareOutcome = { writerRole: "reused" };
    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    const slug = readState(harness.statePath).projectId as string;
    expect(harness.verifyCalls).toStrictEqual([
      {
        keyPath: harness.keyPath,
        spreadsheetId: CREATED_SHEET_ID,
        keyFresh: true,
        shareFresh: false,
        credentials: {
          client_email: serviceAccountEmail("hikoutei-sa", slug),
          private_key: RSA_PRIVATE_KEY_PEM,
        },
      },
    ]);
    expect(readState(harness.statePath).shareOrigin).toBe("reused");
    expect(result.summary.saWriterRole).toBe("reused");
  });

  it("resumes from spreadsheet_share_started after a crash between the permission mutation and the shared checkpoint", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // Crash simulation: the permission mutation succeeded remotely, then
    // the spreadsheet_shared checkpoint write fails closed (a symlink
    // alias planted at the output path makes the next persist refuse).
    harness.crashAfterShareMutation = true;
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.INVALID_ARGS);
    // The run stopped at the share write-ahead: one spreadsheet created,
    // one permission ensure performed, and NO spreadsheet_shared write.
    const state = readState(harness.statePath);
    expect(state.status).toBe("spreadsheet_share_started");
    expect(state.spreadsheetId).toBe(CREATED_SHEET_ID);
    expect(state.keyOrigin).toBe("created");
    expect("shareOrigin" in state).toBe(false);
    expect(harness.created).toHaveLength(1);
    expect(harness.shares).toHaveLength(1);
    expect(harness.verifyCalls).toHaveLength(0);
    // The planted alias (the simulated crash artifact) sits at the output
    // path; nothing else was written.
    expect(lstatSync(harness.outputPath).isSymbolicLink()).toBe(true);

    // The user removes the planted alias; the rerun resumes from the share
    // write-ahead: the idempotent ensure/ownership verification runs again
    // (never a second spreadsheet) and — because this invocation LOADED
    // spreadsheet_share_started and the prior attempt may have
    // created/upgraded the permission before crashing — the persisted
    // shareOrigin is conservatively FRESH even though the replay reports a
    // reused writer role.
    rmSync(harness.outputPath, { force: true });
    harness.crashAfterShareMutation = false;
    harness.shareOutcome = { writerRole: "reused" };
    const second = await harness.run();
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    expect(harness.created).toHaveLength(1);
    expect(harness.shares).toHaveLength(2);
    expect(harness.verifyCalls).toStrictEqual([
      {
        keyPath: harness.keyPath,
        spreadsheetId: CREATED_SHEET_ID,
        keyFresh: true,
        shareFresh: true,
        credentials: {
          client_email: serviceAccountEmail("hikoutei-sa", state.projectId as string),
          private_key: RSA_PRIVATE_KEY_PEM,
        },
      },
    ]);
    expect(readState(harness.statePath).status).toBe("complete");
    expect(readState(harness.statePath).shareOrigin).toBe("fresh");
    expect(second.summary.resumed).toBe(true);
  });

  it("resumes a generated project by describing first and creates only when confirmed absent", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "projects" && args[1] === "create") {
        return failed(1, "ERROR: (gcloud.projects.create) Permission denied.");
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.PROJECT_CREATE_FAILED);

    // The decided project id was persisted BEFORE creation.
    const state = readState(harness.statePath);
    expect(state.status).toBe("project_selected");
    expect(state.projectMode).toBe("generated");
    const slug = state.projectId as string;
    expect(slug).toMatch(/^hikoutei-[a-z0-9]+-[a-z0-9]{4}$/);
    const firstRunCalls = harness.calls.length;

    // Resume: describe reports not found, so the create is the ONLY
    // mutating project step — and it reports already-exists, so the project
    // is reused.
    harness.runnerScript = (args, options) => {
      if (args[0] === "projects" && args[1] === "describe") {
        return failed(1, `ERROR: (gcloud.projects.describe) Project [${slug}] not found.`);
      }
      if (args[0] === "projects" && args[1] === "create") {
        return failed(1, `ERROR: (gcloud.projects.create) Project '${slug}' already exists.`);
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const second = await harness.run();
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    expect(second.summary.projectId).toBe(slug);
    expect(second.summary.projectReused).toBe(true);
    expect(harness.created).toHaveLength(1);
    const secondRunCalls = harness.calls.slice(firstRunCalls);
    expect(secondRunCalls.some((c) => c[0] === "projects" && c[1] === "describe")).toBe(true);
    expect(secondRunCalls.some((c) => c[0] === "projects" && c[1] === "create")).toBe(true);
  });

  it("resumes a generated project that already exists by describing first and never creating", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "projects" && args[1] === "create") {
        return failed(1, "ERROR: (gcloud.projects.create) Permission denied.");
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.PROJECT_CREATE_FAILED);
    const slug = readState(harness.statePath).projectId as string;
    const firstRunCalls = harness.calls.length;

    // Resume: describe succeeds (the project exists), so no create follows.
    harness.runnerScript = (args, options) => {
      if (args[0] === "projects" && args[1] === "describe") {
        return { status: "ok", stdout: "", stderr: "" };
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const second = await harness.run();
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    expect(second.summary.projectId).toBe(slug);
    expect(second.summary.projectReused).toBe(true);
    const secondRunCalls = harness.calls.slice(firstRunCalls);
    expect(secondRunCalls.some((c) => c[0] === "projects" && c[1] === "describe")).toBe(true);
    expect(secondRunCalls.some((c) => c[0] === "projects" && c[1] === "create")).toBe(false);
    expect(harness.created).toHaveLength(1);
  });

  it("never calls project create for an explicit project, on fresh runs or on resume", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // The project phase succeeds (describe ok) but the next phase fails, so
    // the project_selected checkpoint (explicit mode) is retained.
    harness.runnerScript = (args, options) => {
      if (args[0] === "config") {
        return failed(1, "cannot write config");
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const first = await harness.run({ projectId: "existing-proj" });
    expectError(first, SETUP_ERROR_CODES.PROJECT_SELECT_FAILED);
    expect(readState(harness.statePath).status).toBe("project_selected");
    expect(readState(harness.statePath).projectMode).toBe("explicit");

    // Resume with describe-only permission: describe succeeds, create is
    // never called, and the run completes.
    harness.runnerScript = undefined;
    const second = await harness.run({ projectId: "existing-proj" });
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    expect(second.summary.projectId).toBe("existing-proj");
    // An explicit describe-verified project and a resume past project
    // selection both mean the project was reused, never created.
    expect(second.summary.projectReused).toBe(true);
    // Across BOTH runs, project create never appears.
    expect(harness.calls.some((c) => c[0] === "projects" && c[1] === "create")).toBe(false);
    expect(harness.calls.filter((c) => c[0] === "projects" && c[1] === "describe")).toHaveLength(2);
  });

  it("treats a matching --project on a GENERATED checkpoint as explicit: describe not found => project_not_found and zero create calls", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // First run: generated project decided and persisted, but creation fails.
    harness.runnerScript = (args, options) => {
      if (args[0] === "projects" && args[1] === "create") {
        return failed(1, "ERROR: (gcloud.projects.create) Permission denied.");
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.PROJECT_CREATE_FAILED);
    const state = readState(harness.statePath);
    expect(state.status).toBe("project_selected");
    expect(state.projectMode).toBe("generated");
    const slug = state.projectId as string;
    const firstRunCalls = harness.calls.length;

    // Resume with the SAME --project while the project is gone: the explicit
    // option is recovery intent, not permission to create, so describe-only
    // semantics apply and a not-found describe fails without any create.
    harness.runnerScript = (args, options) => {
      if (args[0] === "projects" && args[1] === "describe") {
        return failed(1, `ERROR: (gcloud.projects.describe) Project [${slug}] not found.`);
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const second = await harness.run({ projectId: slug });
    expectError(second, SETUP_ERROR_CODES.PROJECT_NOT_FOUND);
    const secondRunCalls = harness.calls.slice(firstRunCalls);
    expect(secondRunCalls.some((c) => c[0] === "projects" && c[1] === "describe")).toBe(true);
    expect(secondRunCalls.some((c) => c[0] === "projects" && c[1] === "create")).toBe(false);
    // No spreadsheet work happened in the failed resume.
    expect(harness.created).toHaveLength(0);
    // The generated-mode checkpoint is retained unchanged (no state migration).
    const retained = readState(harness.statePath);
    expect(retained.status).toBe("project_selected");
    expect(retained.projectMode).toBe("generated");
    expect(retained.projectId).toBe(slug);
  });

  it("continues a GENERATED checkpoint with a matching --project when describe succeeds, never creating", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "projects" && args[1] === "create") {
        return failed(1, "ERROR: (gcloud.projects.create) Permission denied.");
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.PROJECT_CREATE_FAILED);
    const slug = readState(harness.statePath).projectId as string;
    const firstRunCalls = harness.calls.length;

    // Resume with the SAME --project and describe permission only: the run
    // continues to completion and projects create is never called.
    harness.runnerScript = (args, options) => {
      if (args[0] === "projects" && args[1] === "describe") {
        return { status: "ok", stdout: "", stderr: "" };
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const second = await harness.run({ projectId: slug });
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    expect(second.summary.projectId).toBe(slug);
    expect(second.summary.resumed).toBe(true);
    const secondRunCalls = harness.calls.slice(firstRunCalls);
    expect(secondRunCalls.some((c) => c[0] === "projects" && c[1] === "describe")).toBe(true);
    expect(secondRunCalls.some((c) => c[0] === "projects" && c[1] === "create")).toBe(false);
    // The run reused the (now confirmed) project and created the spreadsheet
    // exactly once across both runs.
    expect(harness.created).toHaveLength(1);
    expect(second.summary.spreadsheetId).toBe(CREATED_SHEET_ID);
    // The stored projectMode is preserved as generated for checkpoint history.
    const finalState = readState(harness.statePath);
    expect(finalState.status).toBe("complete");
    expect(finalState.projectMode).toBe("generated");
    expect(finalState.projectId).toBe(slug);
  });

  it("rejects owner, project, sa-name, title, and key-path mismatches as setup_state_conflict", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const first = await harness.run();
    expect(first.status).toBe("ok");

    // Different active human owner.
    harness.tokenInfo = { email: "other@example.com", scope: DRIVE_SCOPE };
    let result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_CONFLICT);
    if (result.status === "error") {
      expect(result.message).toContain("other@example.com");
    }

    harness.tokenInfo = { email: FAKE_OWNER, scope: DRIVE_SCOPE };
    result = await harness.run({ projectId: "other-proj" });
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_CONFLICT);

    result = await harness.run({ saName: "other-sa" });
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_CONFLICT);

    result = await harness.run({ spreadsheetTitle: "Other Title" });
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_CONFLICT);

    result = await harness.run({ keyPath: join(dir, "other-key.json") });
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_CONFLICT);
  });

  it("rejects a missing or mismatched key file on resume", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const first = await harness.run();
    expect(first.status).toBe("ok");

    rmSync(harness.keyPath, { force: true });
    let result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_INVALID);

    // Regenerate the key with the correct shape but wrong project.
    writeFileSync(
      harness.keyPath,
      validKeyJson("other-proj", "hikoutei-sa@other-proj.iam.gserviceaccount.com"),
      "utf8",
    );
    result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_CONFLICT);
    if (result.status === "error") {
      expect(result.message).toContain("other-proj");
    }
  });

  it("rejects malformed and wrong-version checkpoint files as setup_state_invalid", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const first = await harness.run();
    expect(first.status).toBe("ok");

    writeFileSync(harness.statePath, "{ not json", "utf8");
    let result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_INVALID);

    writeFileSync(harness.statePath, JSON.stringify({ version: 99, status: "complete" }), "utf8");
    result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_INVALID);
  });

  it("rejects a complete checkpoint with a foreign stored saEmail before cloud calls and leaves .env unchanged", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "hikoutei-proj";
    const foreignEmail = "attacker@evil-project.iam.gserviceaccount.com";
    // The local key MATCHES the stored (foreign) email and project: only
    // the checkpoint derivation check can catch this. The .env file
    // pre-exists so any write attempt would be observable.
    writeFileSync(harness.keyPath, validKeyJson(projectId, foreignEmail), "utf8");
    writeFileSync(harness.outputPath, "PREEXISTING=1\n", "utf8");
    writeFileSync(
      harness.statePath,
      JSON.stringify({
        version: SETUP_STATE_VERSION,
        status: "complete",
        projectId,
        projectMode: "generated",
        ownerEmail: FAKE_OWNER,
        saName: "hikoutei-sa",
        saEmail: foreignEmail,
        keyPath: harness.keyPath,
        spreadsheetTitle: `hikoutei-sync-${projectId}`,
        spreadsheetId: CREATED_SHEET_ID,
        keyOrigin: "created",
        shareOrigin: "fresh",
      }),
      "utf8",
    );

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_INVALID);
    // The checkpoint is rejected BEFORE any project/iam/service subprocess,
    // sheet API call, SA verify, or file mutation.
    expect(harness.calls.some((c) => c[0] === "projects" || c[0] === "iam" || c[0] === "services")).toBe(false);
    expect(harness.created).toHaveLength(0);
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    expect(readFileSync(harness.outputPath, "utf8")).toBe("PREEXISTING=1\n");
    expect(readState(harness.statePath).status).toBe("complete");
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
  });

  it("rejects a project_selected checkpoint with a foreign stored saEmail as setup_state_invalid", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(
      harness.statePath,
      JSON.stringify({
        version: SETUP_STATE_VERSION,
        status: "project_selected",
        projectId: "hikoutei-proj",
        projectMode: "generated",
        ownerEmail: FAKE_OWNER,
        saName: "hikoutei-sa",
        saEmail: "attacker@evil-project.iam.gserviceaccount.com",
        keyPath: harness.keyPath,
        spreadsheetTitle: "hikoutei-sync-hikoutei-proj",
      }),
      "utf8",
    );
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_INVALID);
    expect(harness.calls.some((c) => c[0] === "projects" || c[0] === "iam" || c[0] === "services")).toBe(false);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
    expect(readState(harness.statePath).status).toBe("project_selected");
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
  });
});

describe("runSetup — existing key without a checkpoint", () => {
  function validKey(projectId: string): string {
    return validKeyJson(projectId, `hikoutei-sa@${projectId}.iam.gserviceaccount.com`);
  }

  it("fails before project creation when no --project is given", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(harness.keyPath, validKey("some-proj"), "utf8");

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_CONFLICT);
    if (result.status === "error") {
      expect(result.message).toContain("--project");
    }
    // No mutation happened: no project create and no checkpoint.
    expect(harness.calls.some((c) => c[0] === "projects")).toBe(false);
    expect(existsSync(harness.statePath)).toBe(false);
  });

  it("proceeds with key reuse when --project matches the key", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(harness.keyPath, validKey("existing-proj"), "utf8");

    const result = await harness.run({ projectId: "existing-proj" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(result.summary.keyReused).toBe(true);
    const commands = gcloudCommands(result.commands);
    expect(commands.some((c) => c[0] === "iam" && c[2] === "keys")).toBe(false);
    expect(commands).toContainEqual(["projects", "describe", "existing-proj"]);
  });

  it("fails when --project does not match the key", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(harness.keyPath, validKey("key-proj"), "utf8");

    const result = await harness.run({ projectId: "other-proj" });
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_CONFLICT);
    expect(harness.calls.some((c) => c[0] === "projects")).toBe(false);
  });

  it("fails with setup_state_invalid when the existing key is malformed", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(harness.keyPath, "{ nope", "utf8");

    const result = await harness.run({ projectId: "existing-proj" });
    expectError(result, SETUP_ERROR_CODES.SETUP_STATE_INVALID);
    expect(harness.calls.some((c) => c[0] === "projects")).toBe(false);
  });
});

describe("runSetup — dry run", () => {
  it("returns the command plan without executing anything or creating/modifying files", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ dryRun: true });

    expect(result.status).toBe("ok");
    if (result.status !== "ok" || !result.dryRun) return;

    expect(harness.calls).toHaveLength(0);
    expect(harness.created).toHaveLength(0);
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    expect(harness.humanTokens).toHaveLength(0);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
    expect(existsSync(harness.statePath)).toBe(false);

    const commands = gcloudCommands(result.commands);
    expect(commands[0]).toStrictEqual(["--version"]);
    expect(commands[2]).toStrictEqual(["auth", "print-access-token"]);
    const slug = commands[3]?.[2] as string;
    expect(slug).toMatch(/^hikoutei-[a-z0-9]+-[a-z0-9]{4}$/);
    expect(commands).toContainEqual(["projects", "create", slug]);
    expect(commands).toContainEqual(["config", "set", "project", slug]);
    expect(commands).toContainEqual(["services", "enable", "sheets.googleapis.com", "drive.googleapis.com", "--project", slug]);
    expect(commands).toContainEqual([
      "iam",
      "service-accounts",
      "keys",
      "list",
      "--managed-by=user",
      "--format=value(name)",
      "--iam-account",
      serviceAccountEmail("hikoutei-sa", slug),
      "--project",
      slug,
    ]);
    // The dry-run key create shows an explicit non-copyable staging
    // placeholder as the gcloud destination — never the final key path —
    // and the plan previews the write-ahead checkpoint statuses.
    expect(commands).toContainEqual([
      "iam",
      "service-accounts",
      "keys",
      "create",
      KEY_STAGE_PLACEHOLDER,
      "--iam-account",
      serviceAccountEmail("hikoutei-sa", slug),
      "--project",
      slug,
    ]);
    expect(
      commands.some(
        (c) => c[0] === "iam" && c[3] === "create" && c.includes(harness.keyPath),
      ),
    ).toBe(false);
    expect(result.commands.some((c) => c.kind === "file" && c.outcome.includes("key_create_started"))).toBe(true);
    expect(result.commands.some((c) => c.kind === "file" && c.outcome.includes("key_ready"))).toBe(true);
    expect(result.commands.some((c) => c.kind === "api" && c.label.includes("tokeninfo"))).toBe(true);
    expect(result.commands.some((c) => c.kind === "api" && c.label.includes("drive.files.create"))).toBe(true);
    expect(result.commands.some((c) => c.kind === "api" && c.label.includes("appProperties creation marker"))).toBe(true);
    expect(result.commands.some((c) => c.kind === "api" && c.label.includes("share"))).toBe(true);
    expect(result.commands.some((c) => c.kind === "api" && c.label.includes("ownership check"))).toBe(true);
    expect(result.commands.some((c) => c.kind === "api" && c.label.includes("spreadsheets.get"))).toBe(true);
    expect(result.commands.some((c) => c.kind === "file" && c.label.includes("acquire exclusive setup lock"))).toBe(true);
    expect(result.commands.some((c) => c.kind === "file" && c.label.includes("release setup lock"))).toBe(true);
    expect(result.commands.some((c) => c.kind === "file" && c.label.includes(harness.statePath))).toBe(true);
    expect(result.commands.some((c) => c.kind === "file" && c.label.includes(harness.outputPath))).toBe(true);
    expect(
      result.commands.some(
        (c) => (c.kind === "api" || c.kind === "file") && c.label.includes("generateIds"),
      ),
    ).toBe(false);
  });
});

describe("runSetup — failure mapping", () => {
  it("reports gcloud_missing when gcloud is not installed or broken", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = () => ({ status: "not_found" });
    expectError(await harness.run(), SETUP_ERROR_CODES.GCLOUD_MISSING);

    harness.runnerScript = (args, options) =>
      args[0] === "--version" ? failed(1, "gcloud is broken") : freshSetupScript(harness.keyPath)(args, options);
    expectError(await harness.run(), SETUP_ERROR_CODES.GCLOUD_MISSING);
  });

  it("maps a THROWN preflight invocation to gcloud_missing without leaking thrown text", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = () => {
      throw new Error(`spawn gcloud ENOENT ${SECRET_JWT} ${SECRET_AUTHORIZATION}`);
    };
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.GCLOUD_MISSING);
    if (result.status === "error") {
      // The thrown text (and any secret in it) never reaches the message.
      expect(result.message).not.toContain(SECRET_JWT);
      expect(result.message).not.toContain("Authorization");
      expect(result.message).toContain("status unknown");
    }
  });

  it("maps a THROWN auth-list invocation to gcloud_not_logged_in without leaking thrown text", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "auth" && args[1] === "list") {
        throw new Error(`auth list crashed ${SECRET_JWT}`);
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN);
    if (result.status === "error") {
      expect(result.message).not.toContain(SECRET_JWT);
      expect(result.message).not.toContain("auth list crashed");
    }
  });

  it("maps a THROWN token retrieval to user_token_failed without leaking thrown text", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "auth" && args[1] === "print-access-token") {
        throw new Error(`token command exploded ${SECRET_AUTHORIZATION}`);
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.USER_TOKEN_FAILED);
    if (result.status === "error") {
      expect(result.message).not.toContain("Authorization");
      expect(result.message).not.toContain(FAKE_TOKEN);
    }
  });

  it("maps a THROWN project describe to project_not_found without leaking thrown text", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "projects" && args[1] === "describe") {
        throw new Error(`describe crashed ${SECRET_JWT}`);
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const result = await harness.run({ projectId: "no-such-project-xyz" });
    expectError(result, SETUP_ERROR_CODES.PROJECT_NOT_FOUND);
    if (result.status === "error") {
      expect(result.message).not.toContain(SECRET_JWT);
      expect(result.message).toContain("status unknown");
    }
  });

  it("maps a THROWN services enable to api_enable_failed without leaking thrown text", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "services") {
        throw new Error(`enable crashed ${SECRET_KEY_MATERIAL}`);
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.API_ENABLE_FAILED);
    if (result.status === "error") {
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
      expect(result.message).not.toContain("SECRETKEYMATERIAL");
    }
  });

  it("maps a THROWN service-account list to sa_create_failed without leaking thrown text", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "list") {
        throw new Error(`sa list crashed ${SECRET_JWT}`);
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SA_CREATE_FAILED);
    if (result.status === "error") {
      expect(result.message).not.toContain(SECRET_JWT);
    }
  });

  it("createSafeRunner converts a throwing runner into a sanitized failed result", async () => {
    const throwing: GcloudRunner = {
      async run() {
        throw new Error(`spawn exploded ${SECRET_JWT} ${SECRET_KEY_MATERIAL}`);
      },
    };
    const safe = createSafeRunner(throwing);
    const result = await safe.run(["--version"]);
    expect(result).toStrictEqual({ status: "failed", code: null, stdout: "", stderr: "" });
    // Non-thrown results pass through unchanged (deliberate stderr
    // classification by the phases keeps working).
    const okRunner = createSafeRunner({
      async run() {
        return { status: "ok", stdout: "out", stderr: "err" };
      },
    });
    expect(await okRunner.run(["x"])).toStrictEqual({ status: "ok", stdout: "out", stderr: "err" });
  });

  it("reports gcloud_not_logged_in when no active account exists", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) =>
      args[0] === "auth" && args[1] === "list"
        ? { status: "ok", stdout: "", stderr: "No credentialed accounts." }
        : freshSetupScript(harness.keyPath)(args, options);
    expectError(await harness.run(), SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN);
  });

  it("reports user_token_failed when the token cannot be retrieved or validated", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) =>
      args[0] === "auth" && args[1] === "print-access-token"
        ? failed(1, "gcloud auth crashed")
        : freshSetupScript(harness.keyPath)(args, options);
    expectError(await harness.run(), SETUP_ERROR_CODES.USER_TOKEN_FAILED);

    harness.runnerScript = undefined;
    harness.tokenValidatorError = new Error("tokeninfo down");
    expectError(await harness.run(), SETUP_ERROR_CODES.USER_TOKEN_FAILED);
  });

  it("rejects an invalid --project or --sa-name at the runtime boundary before ANY mutation", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // The runtime boundary validates the canonical GCP formats even when a
    // caller bypasses the CLI parser: an invalid identifier must be
    // refused before any subprocess, API call, lock, checkpoint, or file
    // mutation.
    const invalidProject = await harness.run({ projectId: "BAD_PROJECT" });
    expectError(invalidProject, SETUP_ERROR_CODES.INVALID_ARGS);
    if (invalidProject.status === "error") {
      expect(invalidProject.message).toContain("invalid --project");
      expect(invalidProject.message).not.toContain("BAD_PROJECT");
    }

    const invalidSa = await harness.run({ saName: "Bad-Sa-Name" });
    expectError(invalidSa, SETUP_ERROR_CODES.INVALID_ARGS);
    if (invalidSa.status === "error") {
      expect(invalidSa.message).toContain("invalid --sa-name");
      expect(invalidSa.message).not.toContain("Bad-Sa-Name");
    }

    // Neither attempt mutated anything: no subprocess, no sheet API call,
    // no verify, no lock, no checkpoint, no key, no .env.
    expect(harness.calls).toHaveLength(0);
    expect(harness.humanTokens).toHaveLength(0);
    expect(harness.created).toHaveLength(0);
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
    expect(existsSync(harness.statePath)).toBe(false);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
  });

  it("reports gcloud_drive_access_required before any mutation when Drive scope is missing", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.tokenInfo = { email: FAKE_OWNER, scope: "https://www.googleapis.com/auth/spreadsheets" };

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED);
    if (result.status === "error") {
      expect(result.message).toContain("gcloud auth login --enable-gdrive-access --force");
      expect(result.message).not.toContain(FAKE_TOKEN);
    }
    // The check happens before any cloud or file mutation.
    expect(harness.calls.some((c) => c[0] === "projects" || c[0] === "services" || c[0] === "iam")).toBe(false);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(existsSync(harness.statePath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
  });

  it("reports project_create_failed when project creation fails for another reason", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) =>
      args[0] === "projects" && args[1] === "create"
        ? failed(1, "ERROR: (gcloud.projects.create) Permission denied.")
        : freshSetupScript(harness.keyPath)(args, options);
    expectError(await harness.run(), SETUP_ERROR_CODES.PROJECT_CREATE_FAILED);
  });

  it("reports project_not_found when an explicit project cannot be verified", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) =>
      args[0] === "projects" && args[1] === "describe"
        ? failed(1, "ERROR: (gcloud.projects.describe) Project [no-such-project-xyz] not found.")
        : freshSetupScript(harness.keyPath)(args, options);
    expectError(await harness.run({ projectId: "no-such-project-xyz" }), SETUP_ERROR_CODES.PROJECT_NOT_FOUND);
  });

  it("reports project_select_failed when config set fails", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) =>
      args[0] === "config" ? failed(1, "cannot write config") : freshSetupScript(harness.keyPath)(args, options);
    expectError(await harness.run(), SETUP_ERROR_CODES.PROJECT_SELECT_FAILED);
  });

  it("reports api_enable_failed when enabling the APIs fails", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) =>
      args[0] === "services" ? failed(1, "API enablement failed") : freshSetupScript(harness.keyPath)(args, options);
    expectError(await harness.run(), SETUP_ERROR_CODES.API_ENABLE_FAILED);
  });

  it("reports sa_create_failed when listing or creating the service account fails", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) =>
      args[0] === "iam" && args[2] === "list" ? failed(1, "list failed") : freshSetupScript(harness.keyPath)(args, options);
    expectError(await harness.run(), SETUP_ERROR_CODES.SA_CREATE_FAILED);

    harness.runnerScript = (args, options) =>
      args[0] === "iam" && args[2] === "create" ? failed(1, "create failed") : freshSetupScript(harness.keyPath)(args, options);
    expectError(await harness.run(), SETUP_ERROR_CODES.SA_CREATE_FAILED);
  });

  it("fails with key_create_uncertain after the poll schedule when the one fresh create fails and nothing appears", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) =>
      args[0] === "iam" && args[2] === "keys" && args[3] === "create"
        ? failed(1, "key create failed")
        : freshSetupScript(harness.keyPath)(args, options);
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).not.toContain("key create failed");
      expect(result.message).toContain("propagation window");
    }
    // The FRESH invocation issued its ONE create; the failed/lost result
    // was then settled with an IMMEDIATE post-create evidence check plus
    // one check after each of the seven scheduled delays (exactly eight
    // post-create evidence checks) and the create was NEVER retried
    // automatically.
    const createCalls = harness.calls.filter((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "create");
    const deleteCalls = harness.calls.filter((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "delete");
    expect(createCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(0);
    expect(harness.sleepCalls).toStrictEqual([...KEY_SETTLE_POLL_DELAYS_MS]);
    // Evidence-list call accounting for an exhausted fresh outcome: the
    // pre-create baseline list plus the pre-create pass list, then EXACTLY
    // eight post-create list calls (immediate + after 2, 4, 8, 16, 30, 30,
    // 30 s).
    const createIndex = harness.calls.findIndex(
      (c) => c[0] === "iam" && c[2] === "keys" && c[3] === "create",
    );
    const keyListCalls = harness.calls.filter((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "list");
    const preCreateLists = harness.calls
      .slice(0, createIndex)
      .filter((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "list");
    const postCreateLists = harness.calls
      .slice(createIndex + 1)
      .filter((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "list");
    expect(preCreateLists).toHaveLength(2);
    expect(postCreateLists).toHaveLength(8);
    expect(keyListCalls).toHaveLength(10);
    // Nothing was installed at the final path. The deterministic staging
    // directory may remain (cleanup happens only after a verified
    // installation); no staged key file exists and the checkpoint stays
    // key_create_started so a resume reconciles (never creates).
    expect(existsSync(harness.keyPath)).toBe(false);
    const marker = readState(harness.statePath).keyMarker as string;
    expect(existsSync(stagedKeyPath(harness.keyPath, marker))).toBe(false);
    expect(readState(harness.statePath).status).toBe("key_create_started");
    expect(isValidKeyMarker(marker)).toBe(true);
    // No spreadsheet work happened after the failed key phase.
    expect(harness.created).toHaveLength(0);
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    expect(existsSync(harness.outputPath)).toBe(false);
  });

  it("fails with key_create_failed when the final key path is planted mid-run and never overwrites it", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const planted = JSON.stringify({
      type: "user",
      project_id: "planted",
      client_email: "planted@example.com",
      private_key_id: FIXED_KEY_ID,
      private_key: "planted-material",
    });
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
        // gcloud writes the staged key; between staging and install a
        // concurrent actor plants the FINAL key path.
        const outcome = freshSetupScript(harness.keyPath)(args, options);
        writeFileSync(harness.keyPath, planted, "utf8");
        return outcome;
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    if (result.status === "error") {
      // The staged key is active (the create landed) but the planted final
      // blocks the atomic install: the run fails with recovery guidance and
      // the staged credential is retained.
      expect(result.message).toContain("already exists");
      expect(result.message).toContain("not overwritten");
      expect(result.message).toContain("recover the staged key");
      expect(result.message).not.toContain("planted-material");
    }
    // The planted file is byte-identical and no secret was installed over
    // it. The staged key is the ONLY local copy of the created cloud key,
    // so it is RETAINED for recovery: the next run installs it once the
    // planted file is removed, without creating a second key.
    expect(readFileSync(harness.keyPath, "utf8")).toBe(planted);
    const stageName = readdirSync(dir).find((name) => name.startsWith(".hikoutei-key-stage-"));
    expect(stageName).toBeDefined();
    const staged = stagedKeyPath(harness.keyPath, readState(harness.statePath).keyMarker as string);
    expect(existsSync(staged)).toBe(true);
    expect(statSync(staged).mode & 0o777).toBe(0o600);
    expect(harness.created).toHaveLength(0);
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    // The key write-ahead checkpoint was persisted before the key create.
    expect(readState(harness.statePath).status).toBe("key_create_started");
    expect(existsSync(harness.outputPath)).toBe(false);
  });

  it("recovers the retained staged key after the planted final path is removed", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const planted = JSON.stringify({
      type: "user",
      project_id: "planted",
      client_email: "planted@example.com",
      private_key_id: FIXED_KEY_ID,
      private_key: "planted-material",
    });
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
        const outcome = freshSetupScript(harness.keyPath)(args, options);
        writeFileSync(harness.keyPath, planted, "utf8");
        return outcome;
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const first = await harness.run();
    expectError(first, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    const state = readState(harness.statePath);
    expect(state.status).toBe("key_create_started");
    const marker = state.keyMarker as string;
    const slug = state.projectId as string;
    const saEmail = state.saEmail as string;
    const staged = stagedKeyPath(harness.keyPath, marker);
    expect(existsSync(staged)).toBe(true);

    // The user removes the planted file and reruns: the staged key is
    // installed WITHOUT a second key create (the fake keys list now shows
    // the key the first run's gcloud create actually created).
    rmSync(harness.keyPath, { force: true });
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "list") {
        return {
          status: "ok",
          stdout: `${keyResourceName(slug, saEmail, FIXED_KEY_ID)}\n`,
          stderr: "",
        };
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };
    const createCallsBefore = harness.calls.filter(
      (c) => c[0] === "iam" && c[2] === "keys" && c[3] === "create",
    ).length;
    const second = await harness.run();
    expect(second.status).toBe("ok");
    if (second.status !== "ok" || second.dryRun) return;
    const createCallsAfter = harness.calls.filter(
      (c) => c[0] === "iam" && c[2] === "keys" && c[3] === "create",
    ).length;
    // Exactly one create across BOTH runs; the resume recovered the staged
    // key and cleaned the stage up.
    expect(createCallsAfter).toBe(createCallsBefore);
    expect(readFileSync(harness.keyPath, "utf8")).toBe(validKeyJson(slug, saEmail));
    expect(existsSync(staged)).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith(".hikoutei-key-stage-"))).toBe(false);
    expect(readState(harness.statePath).status).toBe("complete");
    expect(second.summary.keyReused).toBe(false);
  });

  it("fails with key_create_failed when the staged key is invalid and retains it securely", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
        // Production runs the create with the staging directory as the
        // subprocess cwd and a RELATIVE key.json destination; the fake
        // writes into that cwd so the invalid content lands in the stage.
        const destination =
          options?.cwd === undefined ? (args[4] as string) : join(options.cwd, args[4] as string);
        writeFileSync(destination, "{ not a key", "utf8");
        return { status: "ok", stdout: "", stderr: "" };
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    expect(existsSync(harness.keyPath)).toBe(false);
    // The invalid staged file is retained (fail closed, never blindly
    // removed); the checkpoint stays key_create_started.
    const marker = readState(harness.statePath).keyMarker as string;
    const staged = stagedKeyPath(harness.keyPath, marker);
    expect(existsSync(staged)).toBe(true);
    expect(readFileSync(staged, "utf8")).toBe("{ not a key");
    expect(readState(harness.statePath).status).toBe("key_create_started");
    expect(harness.created).toHaveLength(0);
  });

  it("fails with key_create_failed when the staged key belongs to a different account and retains it", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
        // The fake writes the FOREIGN key into the staging cwd, mirroring
        // the relative key.json destination of the production runner.
        const destination =
          options?.cwd === undefined ? (args[4] as string) : join(options.cwd, args[4] as string);
        writeFileSync(
          destination,
          validKeyJson("other-proj", "other@other-proj.iam.gserviceaccount.com", FOREIGN_KEY_ID),
          "utf8",
        );
        return { status: "ok", stdout: "", stderr: "" };
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("other-proj");
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
      expect(result.message).not.toContain(FOREIGN_KEY_ID);
    }
    expect(existsSync(harness.keyPath)).toBe(false);
    // The mismatched staged key is retained securely (never deleted: it may
    // be the only local copy of a real credential for another account).
    const marker = readState(harness.statePath).keyMarker as string;
    expect(existsSync(stagedKeyPath(harness.keyPath, marker))).toBe(true);
    expect(readState(harness.statePath).status).toBe("key_create_started");
  });

  it("reports sheet_create_uncertain when the create outcome is unknown and retains the started state", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.createError = new Error("sheets API quota exceeded");
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN);
    // The started state (with the creation marker) is retained; a rerun
    // reconciles by marker and never creates a second spreadsheet.
    expect(existsSync(harness.statePath)).toBe(true);
    expect(readState(harness.statePath).status).toBe("spreadsheet_create_started");
    expect(isValidCreationMarker(readState(harness.statePath).creationMarker)).toBe(true);
    // No share, verify, or .env happened after the failed create.
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    expect(existsSync(harness.outputPath)).toBe(false);
  });

  it("reports sheet_share_failed when sharing fails, and keeps the spreadsheet_share_started write-ahead", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const permissionDenied = new Error("drive refused the permission");
    (permissionDenied as { response?: { status: number } }).response = { status: 403 };
    harness.shareError = permissionDenied;
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SHEET_SHARE_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("HTTP 403");
    }
    // The share write-ahead was persisted BEFORE the failed permission
    // ensure: the checkpoint stays spreadsheet_share_started (id + keyOrigin,
    // no shareOrigin — the mutation outcome is unknown) so a resume reruns
    // the idempotent ensure.
    const state = readState(harness.statePath);
    expect(state.status).toBe("spreadsheet_share_started");
    expect(state.spreadsheetId).toBe(CREATED_SHEET_ID);
    expect(state.keyOrigin).toBe("created");
    expect("shareOrigin" in state).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
  });

  it("delays the .env write until SA access is verified, and retains the shared checkpoint", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.verifyError = new Error("invalid_grant: Invalid JWT Signature");
    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SA_ACCESS_VERIFY_FAILED);

    // The env file was NOT written and the checkpoint records the shared state.
    expect(existsSync(harness.outputPath)).toBe(false);
    expect(readState(harness.statePath).status).toBe("spreadsheet_shared");
  });

  it("reports output_write_failed when the .env file cannot be written", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ outputPath: join(dir, "missing", ".env") });
    expectError(result, SETUP_ERROR_CODES.OUTPUT_WRITE_FAILED);
  });

  it("reports output_write_failed for a directory at the output path and leaves it untouched", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const outputDir = join(dir, "env-dir");
    mkdirSync(outputDir, { mode: 0o700 });
    writeFileSync(join(outputDir, "keep.txt"), "kept", "utf8");

    const result = await harness.run({ outputPath: outputDir });
    expectError(result, SETUP_ERROR_CODES.OUTPUT_WRITE_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("not a regular file");
    }
    // The directory and its contents are untouched and the checkpoint is
    // retained (spreadsheet_shared) so a rerun resumes after the fix.
    expect(statSync(outputDir).isDirectory()).toBe(true);
    expect(readFileSync(join(outputDir, "keep.txt"), "utf8")).toBe("kept");
    expect(readState(harness.statePath).status).toBe("spreadsheet_shared");
  });

  it("reports output_write_failed for a FIFO at the output path without blocking on it", async (ctx) => {
    if ((constants as { O_NONBLOCK?: number }).O_NONBLOCK === undefined) {
      ctx.skip();
      return;
    }
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const fifoPath = join(dir, "fifo.env");
    // Bounded: mkfifo runs with a hard timeout and the output open uses
    // O_NONBLOCK, so this test can never hang on the FIFO.
    const mkfifo = spawnSync("mkfifo", [fifoPath], { timeout: 5000 });
    if (mkfifo.status !== 0) {
      ctx.skip();
      return;
    }

    const result = await harness.run({ outputPath: fifoPath });
    expectError(result, SETUP_ERROR_CODES.OUTPUT_WRITE_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("not a regular file");
    }
    // The FIFO was never read or replaced; the checkpoint is retained.
    expect(lstatSync(fifoPath).isFIFO()).toBe(true);
    expect(readState(harness.statePath).status).toBe("spreadsheet_shared");
  });
});

describe("runSetup — key write-ahead reconciliation", () => {
  /** Writes a `key_create_started` checkpoint for the given project. */
  function writeKeyStartedCheckpoint(
    dir: string,
    keyPath: string,
    projectId: string,
    overrides: Record<string, unknown> = {},
  ): { statePath: string; saEmail: string; marker: string } {
    const statePath = join(dir, SETUP_STATE_FILE_NAME);
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeFileSync(
      statePath,
      JSON.stringify({
        version: SETUP_STATE_VERSION,
        status: "key_create_started",
        projectId,
        projectMode: "generated",
        ownerEmail: FAKE_OWNER,
        saName: "hikoutei-sa",
        saEmail,
        keyPath,
        spreadsheetTitle: `hikoutei-sync-${projectId}`,
        keyMarker: VALID_KEY_MARKER,
        keyBaseline: [],
        ...overrides,
      }),
      "utf8",
    );
    return { statePath, saEmail, marker: VALID_KEY_MARKER };
  }

  /** Scripts the keys list to report exactly the given key ids as active. */
  function listScript(
    keyPath: string,
    projectId: string,
    saEmail: string,
    keyIds: readonly string[],
  ): (args: readonly string[], options?: { readonly cwd?: string }) => GcloudRunResult {
    return (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "list") {
        // After a fake keys create succeeded, the created key is a real
        // user-managed key of the service account, so the scripted list
        // reports it too: the recursive reconciliation after a retried
        // create must see the created key as active. Tests that script a
        // fixed empty/foreign list and never run a create are unaffected
        // (fakeKeyCreated stays false).
        const ids = fakeKeyCreated && !keyIds.includes(FIXED_KEY_ID) ? [...keyIds, FIXED_KEY_ID] : keyIds;
        return {
          status: "ok",
          stdout: ids.map((id) => keyResourceName(projectId, saEmail, id)).join("\n"),
          stderr: "",
        };
      }
      return freshSetupScript(keyPath)(args, options);
    };
  }

  function keyCreateCalls(harness: Harness): number {
    return harness.calls.filter((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "create").length;
  }

  function keyDeleteCalls(harness: Harness): number {
    return harness.calls.filter((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "delete").length;
  }

  it("resumes with a valid active final key (crash after install) and promotes without creating", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    writeFileSync(harness.keyPath, validKeyJson(projectId, saEmail), "utf8");
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, [FIXED_KEY_ID]);

    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;

    // The final key was recovered: zero key creates and zero deletes; the
    // spreadsheet was created exactly once from the fresh key_ready state.
    expect(keyCreateCalls(harness)).toBe(0);
    expect(keyDeleteCalls(harness)).toBe(0);
    expect(harness.created).toHaveLength(1);
    expect(readState(harness.statePath).status).toBe("complete");
    expect(result.summary.keyReused).toBe(false);
    expect(statSync(harness.keyPath).mode & 0o777).toBe(0o600);
    // No project/SA recreation happened on resume.
    expect(harness.calls.some((c) => c[0] === "projects")).toBe(false);
    expect(harness.calls.some((c) => c[0] === "services")).toBe(false);
  });

  it("resumes with a staged+final hardlink (crash after the atomic install) and cleans the owned stage", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    // Simulate the crash-after-hardlink boundary: the staged key and the
    // final key are the SAME inode (linkSync), the stage cleanup never ran.
    mkdirSync(keyStageDir(harness.keyPath, VALID_KEY_MARKER), { mode: 0o700 });
    writeFileSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER), validKeyJson(projectId, saEmail), "utf8");
    linkSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER), harness.keyPath);
    expect(statSync(harness.keyPath).ino).toBe(statSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER)).ino);
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, [FIXED_KEY_ID]);

    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(keyCreateCalls(harness)).toBe(0);
    // The owned staged link was unlinked and the empty owned dir rmdir'd.
    expect(existsSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER))).toBe(false);
    expect(existsSync(keyStageDir(harness.keyPath, VALID_KEY_MARKER))).toBe(false);
    expect(readState(harness.statePath).status).toBe("complete");
  });

  it("resumes with only a staged active key (crash before install) and installs it without creating", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    mkdirSync(keyStageDir(harness.keyPath, VALID_KEY_MARKER), { mode: 0o700 });
    writeFileSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER), validKeyJson(projectId, saEmail), "utf8");
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, [FIXED_KEY_ID]);

    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(keyCreateCalls(harness)).toBe(0);
    expect(keyDeleteCalls(harness)).toBe(0);
    expect(readFileSync(harness.keyPath, "utf8")).toBe(validKeyJson(projectId, saEmail));
    expect(statSync(harness.keyPath).mode & 0o777).toBe(0o600);
    expect(existsSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER))).toBe(false);
    expect(readState(harness.statePath).status).toBe("complete");
  });

  it("is reconcile-only on resume with no credential and no delta: zero create/delete and uncertain after the exact poll schedule", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    // No staged or final credential and no post-baseline key: a resumed
    // invocation must NEVER create — a lagging IAM key list could hide the
    // key the earlier run already created. The bounded propagation poll
    // runs its full schedule and the run stays key_create_uncertain.
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, []);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).toContain("propagation window");
      expect(result.message).toContain("reset the key checkpoint");
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
    }
    expect(keyCreateCalls(harness)).toBe(0);
    expect(keyDeleteCalls(harness)).toBe(0);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
    expect(harness.created).toHaveLength(0);
    expect(readState(harness.statePath).status).toBe("key_create_started");
    // The poll used the documented bounded schedule: an initial check plus
    // 2, 4, 8, 16, 30, 30, 30 s (eight checks, at most 120 s of waiting).
    expect(harness.sleepCalls).toStrictEqual([...KEY_SETTLE_POLL_DELAYS_MS]);
    const keyListCalls = harness.calls.filter((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "list");
    expect(keyListCalls).toHaveLength(8);
  });

  it("removes a leftover EMPTY stage directory on resume (crash between unlink and rmdir)", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    // The staged link was already unlinked; the empty deterministic
    // directory survived the crash and must be rmdir'd, not left forever.
    mkdirSync(keyStageDir(harness.keyPath, VALID_KEY_MARKER), { mode: 0o700 });
    writeFileSync(harness.keyPath, validKeyJson(projectId, saEmail), "utf8");
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, [FIXED_KEY_ID]);

    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(keyCreateCalls(harness)).toBe(0);
    expect(existsSync(keyStageDir(harness.keyPath, VALID_KEY_MARKER))).toBe(false);
    expect(readState(harness.statePath).status).toBe("complete");
  });

  it("fails closed on a non-empty stage directory during cleanup and preserves its contents", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    const stageDir = keyStageDir(harness.keyPath, VALID_KEY_MARKER);
    mkdirSync(stageDir, { mode: 0o700 });
    writeFileSync(join(stageDir, "foreign.txt"), "not ours", "utf8");
    writeFileSync(harness.keyPath, validKeyJson(projectId, saEmail), "utf8");
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, [FIXED_KEY_ID]);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("still contains files");
    }
    // The foreign entry and the stage directory survive untouched; the
    // checkpoint stays started so the next run finishes the promotion.
    expect(readFileSync(join(stageDir, "foreign.txt"), "utf8")).toBe("not ours");
    expect(readState(harness.statePath).status).toBe("key_create_started");
    expect(harness.created).toHaveLength(0);
  });

  it("resumes a crash-left cleanup directory containing the matching staged hardlink", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    // Crash after the quarantine rename, before the staged unlink: the
    // deterministic cleanup directory holds the staged hardlink, the stage
    // directory is gone, and the final key is installed.
    const cleanupDir = keyCleanupDir(harness.keyPath, VALID_KEY_MARKER);
    mkdirSync(cleanupDir, { mode: 0o700 });
    writeFileSync(join(cleanupDir, "key.json"), validKeyJson(projectId, saEmail), "utf8");
    linkSync(join(cleanupDir, "key.json"), harness.keyPath);
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, [FIXED_KEY_ID]);

    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(keyCreateCalls(harness)).toBe(0);
    expect(keyDeleteCalls(harness)).toBe(0);
    // The cleanup dir was finished (verify against the no-follow final,
    // unlink the staged link, rmdir the empty dir).
    expect(existsSync(cleanupDir)).toBe(false);
    expect(readFileSync(harness.keyPath, "utf8")).toBe(validKeyJson(projectId, saEmail));
    expect(statSync(harness.keyPath).mode & 0o777).toBe(0o600);
    expect(readState(harness.statePath).status).toBe("complete");
  });

  it("resumes an empty crash-left cleanup directory and removes it", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    // Crash between the staged unlink and the rmdir inside the quarantined
    // directory: the empty cleanup dir is rmdir'd on resume.
    mkdirSync(keyCleanupDir(harness.keyPath, VALID_KEY_MARKER), { mode: 0o700 });
    writeFileSync(harness.keyPath, validKeyJson(projectId, saEmail), "utf8");
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, [FIXED_KEY_ID]);

    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(keyCreateCalls(harness)).toBe(0);
    expect(existsSync(keyCleanupDir(harness.keyPath, VALID_KEY_MARKER))).toBe(false);
    expect(readState(harness.statePath).status).toBe("complete");
  });

  it("preserves extra contents found in the quarantined cleanup directory and moves them back to the stage path", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    const cleanupDir = keyCleanupDir(harness.keyPath, VALID_KEY_MARKER);
    mkdirSync(cleanupDir, { mode: 0o700 });
    writeFileSync(join(cleanupDir, "key.json"), validKeyJson(projectId, saEmail), "utf8");
    writeFileSync(join(cleanupDir, "foreign.txt"), "not ours", "utf8");
    linkSync(join(cleanupDir, "key.json"), harness.keyPath);
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, [FIXED_KEY_ID]);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("still contains files");
    }
    // Nothing was deleted: the whole quarantined directory was moved back
    // to the deterministic stage path so the user finds the state where
    // the docs say it is; the checkpoint stays started.
    expect(existsSync(cleanupDir)).toBe(false);
    expect(readFileSync(join(keyStageDir(harness.keyPath, VALID_KEY_MARKER), "foreign.txt"), "utf8")).toBe("not ours");
    expect(readFileSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER), "utf8")).toBe(validKeyJson(projectId, saEmail));
    expect(readFileSync(harness.keyPath, "utf8")).toBe(validKeyJson(projectId, saEmail));
    expect(readState(harness.statePath).status).toBe("key_create_started");
  });

  it("refuses a final symlink during cleanup and retains the staged key", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, DEFAULT_KEY_FILE_NAME);
    const marker = VALID_KEY_MARKER;
    const stageDir = keyStageDir(keyPath, marker);
    mkdirSync(stageDir, { mode: 0o700 });
    const staged = stagedKeyPath(keyPath, marker);
    writeFileSync(staged, "key-content", "utf8");
    linkSync(staged, keyPath);
    // The final path is replaced by a symlink pointing at the staged file:
    // cleanup must refuse (no-follow) and must NOT unlink through it.
    unlinkSync(keyPath);
    symlinkSync(staged, keyPath);

    const error = cleanupOwnedStage(keyPath, marker);
    expect(error).not.toBeNull();
    if (error !== null) {
      expect(error.message).toContain("not a regular file");
    }
    // The staged credential is retained and the symlink is untouched.
    expect(readFileSync(staged, "utf8")).toBe("key-content");
    expect(lstatSync(keyPath).isSymbolicLink()).toBe(true);
    expect(existsSync(stageDir)).toBe(true);
  });

  it("detects a stage-directory replacement after the quarantine rename and deletes nothing", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, DEFAULT_KEY_FILE_NAME);
    const marker = VALID_KEY_MARKER;
    const stageDir = keyStageDir(keyPath, marker);
    const cleanupDir = keyCleanupDir(keyPath, marker);
    mkdirSync(stageDir, { mode: 0o700 });
    writeFileSync(join(stageDir, "key.json"), "staged-content", "utf8");
    writeFileSync(keyPath, "final-key", "utf8");
    const foreign = join(dir, "foreign-dir");
    mkdirSync(foreign, { mode: 0o700 });
    writeFileSync(join(foreign, "x.txt"), "foreign", "utf8");
    const fs: KeyCleanupFs = {
      lstatSync,
      renameSync(from, to) {
        if (from === stageDir) {
          // The source was replaced between the capture and the rename:
          // the rename moves the REPLACEMENT, so the post-rename identity
          // check must detect the mismatch and delete nothing.
          renameSync(foreign, to);
          return;
        }
        renameSync(from, to);
      },
      readdirSync,
      unlinkSync,
      rmdirSync,
      openSync,
      fchmodSync,
      fstatSync,
      closeSync,
    };
    const error = cleanupOwnedStage(keyPath, marker, fs);
    expect(error).not.toBeNull();
    if (error !== null) {
      expect(error.message).toContain("replaced while cleaning up");
    }
    // The original stage directory is untouched, the moved replacement is
    // intact at the cleanup path, and nothing was deleted.
    expect(readFileSync(join(stageDir, "key.json"), "utf8")).toBe("staged-content");
    expect(readFileSync(join(cleanupDir, "x.txt"), "utf8")).toBe("foreign");
    expect(readFileSync(keyPath, "utf8")).toBe("final-key");
  });

  it("fails closed when both the stage and cleanup directories exist", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, DEFAULT_KEY_FILE_NAME);
    const marker = VALID_KEY_MARKER;
    mkdirSync(keyStageDir(keyPath, marker), { mode: 0o700 });
    mkdirSync(keyCleanupDir(keyPath, marker), { mode: 0o700 });
    writeFileSync(keyPath, "final-key", "utf8");

    const error = cleanupOwnedStage(keyPath, marker);
    expect(error).not.toBeNull();
    if (error !== null) {
      expect(error.message).toContain("both the staging directory");
    }
    expect(existsSync(keyStageDir(keyPath, marker))).toBe(true);
    expect(existsSync(keyCleanupDir(keyPath, marker))).toBe(true);
    expect(readFileSync(keyPath, "utf8")).toBe("final-key");
  });

  it("enforces owner-only 0700 on a pre-existing stage directory before gcloud writes", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, DEFAULT_KEY_FILE_NAME);
    // A directory left with loose permissions (hand-chmod'd or copied) is
    // corrected to 0700 through the descriptor before the credential is
    // written into it. This path is reachable only from the one fresh
    // create, so it is exercised directly.
    const stageDir = keyStageDir(keyPath, VALID_KEY_MARKER);
    mkdirSync(stageDir, { mode: 0o755 });
    const prepared = prepareStageDir(keyPath, VALID_KEY_MARKER);
    expect(prepared.status).toBe("ok");
    if (prepared.status === "ok") {
      // The prepared identity matches the directory at the path.
      const stat = lstatSync(stageDir);
      expect(stat.dev).toBe(prepared.dev);
      expect(stat.ino).toBe(prepared.ino);
    }
    expect(statSync(stageDir).mode & 0o777).toBe(0o700);
  });

  it("rejects a symlink at the stage directory path without touching it", () => {
    const dir = makeTempDir();
    const keyPath = join(dir, DEFAULT_KEY_FILE_NAME);
    const stageDir = keyStageDir(keyPath, VALID_KEY_MARKER);
    const victim = join(dir, "victim-dir");
    mkdirSync(victim, { mode: 0o700 });
    symlinkSync(victim, stageDir);

    const prepared = prepareStageDir(keyPath, VALID_KEY_MARKER);
    expect(prepared.status).toBe("error");
    if (prepared.status === "error") {
      expect(prepared.error.message).toContain("not a plain directory");
    }
    // The symlink and its target are untouched.
    expect(lstatSync(stageDir).isSymbolicLink()).toBe(true);
    expect(existsSync(victim)).toBe(true);
  });

  it("refuses a symlinked staging directory before any key list, create, install, or cleanup", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    // A foreign directory holding a VALID key for this project sits behind
    // a symlink at the deterministic stage path. The parent must be
    // refused BEFORE the foreign key is read, chmod'ed, listed, installed,
    // or cleaned up — and no key is ever created.
    const foreign = join(dir, "foreign-stage");
    mkdirSync(foreign, { mode: 0o700 });
    const foreignKey = join(foreign, "key.json");
    writeFileSync(foreignKey, validKeyJson(projectId, saEmail), "utf8");
    chmodSync(foreignKey, 0o640);
    symlinkSync(foreign, keyStageDir(harness.keyPath, VALID_KEY_MARKER));

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("not a plain directory");
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
    }
    // No key list, create, or delete ever ran: the parent check precedes
    // the key list and every mutation.
    expect(harness.calls.filter((c) => c[0] === "iam" && c[2] === "keys")).toHaveLength(0);
    // The foreign key content and mode are untouched, the symlink is
    // untouched, nothing was installed, and the checkpoint stays started.
    expect(readFileSync(foreignKey, "utf8")).toBe(validKeyJson(projectId, saEmail));
    expect(statSync(foreignKey).mode & 0o777).toBe(0o640);
    expect(lstatSync(keyStageDir(harness.keyPath, VALID_KEY_MARKER)).isSymbolicLink()).toBe(true);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(readState(harness.statePath).status).toBe("key_create_started");
    expect(harness.created).toHaveLength(0);
  });

  it("fails closed when the staging directory is replaced DURING the key create: no foreign key read, chmod, or install", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // While the gcloud create "runs" (the fake runner is mid-subprocess),
    // an attacker replaces the validated staging directory with a symlink
    // to a foreign directory holding a VALID key for a foreign account.
    // The immediate post-create settlement must re-verify the parent
    // BEFORE the staged key is read, chmod'ed, listed, or installed.
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
        const stageDir = options?.cwd as string;
        rmSync(stageDir, { recursive: true, force: true });
        const foreign = join(dirname(stageDir), "foreign-stage");
        mkdirSync(foreign, { mode: 0o700 });
        const foreignKey = join(foreign, "key.json");
        writeFileSync(
          foreignKey,
          validKeyJson("evil-proj", "evil@evil-proj.iam.gserviceaccount.com", FOREIGN_KEY_ID),
          "utf8",
        );
        chmodSync(foreignKey, 0o640);
        symlinkSync(foreign, stageDir);
        return { status: "ok", stdout: "", stderr: "" };
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("not a plain directory");
      // The foreign credential was NEVER read: had it been, the identity
      // mismatch would surface its project in the message. Its key id and
      // private key material never appear either.
      expect(result.message).not.toContain("evil-proj");
      expect(result.message).not.toContain(FOREIGN_KEY_ID);
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
    }
    // Exactly ONE create was issued (the fresh baseline create); no delete,
    // and no re-list after the swap: the two list calls are the baseline
    // and the pass-1 pre-create evidence check, both BEFORE the create.
    expect(keyCreateCalls(harness)).toBe(1);
    expect(keyDeleteCalls(harness)).toBe(0);
    const listCalls = harness.calls.filter((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "list");
    expect(listCalls).toHaveLength(2);
    const createIndex = harness.calls.findIndex((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "create");
    expect(harness.calls.findIndex((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "list") < createIndex).toBe(true);
    expect(harness.calls.slice(createIndex + 1).some((c) => c[0] === "iam" && c[2] === "keys" && c[3] === "list")).toBe(false);
    expect(existsSync(harness.keyPath)).toBe(false);
    // The foreign key was never read, chmod'ed, or modified; the symlink
    // stays; the checkpoint stays started; nothing else happened.
    const foreign = join(dirname(keyStageDir(harness.keyPath, VALID_KEY_MARKER)), "foreign-stage");
    expect(readFileSync(join(foreign, "key.json"), "utf8")).toBe(
      validKeyJson("evil-proj", "evil@evil-proj.iam.gserviceaccount.com", FOREIGN_KEY_ID),
    );
    expect(statSync(join(foreign, "key.json")).mode & 0o777).toBe(0o640);
    const stageDir = keyStageDir(harness.keyPath, readState(harness.statePath).keyMarker as string);
    expect(lstatSync(stageDir).isSymbolicLink()).toBe(true);
    expect(readState(harness.statePath).status).toBe("key_create_started");
    expect(harness.created).toHaveLength(0);
    expect(harness.shares).toHaveLength(0);
    // The immediate post-create check failed without any poll delay.
    expect(harness.sleepCalls).toHaveLength(0);
  });

  it("refuses a non-directory entry at the staging directory path without touching it", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    // A regular file planted at the deterministic stage path is refused
    // before any staged child read and before the key list.
    const stageDir = keyStageDir(harness.keyPath, VALID_KEY_MARKER);
    writeFileSync(stageDir, "not a directory", "utf8");

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("not a plain directory");
      expect(result.message).not.toContain("not a directory");
    }
    expect(harness.calls.filter((c) => c[0] === "iam" && c[2] === "keys")).toHaveLength(0);
    expect(readFileSync(stageDir, "utf8")).toBe("not a directory");
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(readState(harness.statePath).status).toBe("key_create_started");
  });

  it("secures an existing 0755 staging directory to 0700 BEFORE the staged key is read", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    const stageDir = keyStageDir(harness.keyPath, VALID_KEY_MARKER);
    mkdirSync(stageDir, { mode: 0o755 });
    writeFileSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER), validKeyJson(projectId, saEmail), "utf8");
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "list") {
        // By the time the key list runs, the parent inspection has already
        // secured the stage directory to 0700 and read the staged key
        // through it.
        expect(statSync(stageDir).mode & 0o777).toBe(0o700);
      }
      return listScript(harness.keyPath, projectId, saEmail, [FIXED_KEY_ID])(args);
    };

    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(keyCreateCalls(harness)).toBe(0);
    // The staged key was installed, the owner-only stage directory was
    // cleaned up, and the final key is owner-only 0600.
    expect(readFileSync(harness.keyPath, "utf8")).toBe(validKeyJson(projectId, saEmail));
    expect(statSync(harness.keyPath).mode & 0o777).toBe(0o600);
    expect(existsSync(stageDir)).toBe(false);
    expect(readState(harness.statePath).status).toBe("complete");
  });

  it("reconciles a THROWN key-create invocation (lost result) instead of bubbling it", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
        // gcloud wrote the staged key but the runner itself threw (spawn
        // failure): the flow must reconcile the staged key against the
        // current list, never bubble the thrown text.
        freshSetupScript(harness.keyPath)(args, options);
        throw new Error(`spawn gcloud ENOENT ${SECRET_KEY_MATERIAL}`);
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };

    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(keyCreateCalls(harness)).toBe(1);
    expect(keyDeleteCalls(harness)).toBe(0);
    expect(existsSync(harness.keyPath)).toBe(true);
    expect(statSync(harness.keyPath).mode & 0o777).toBe(0o600);
    expect(result.summary.keyReused).toBe(false);
    expect(readState(harness.statePath).status).toBe("complete");
    expect(readdirSync(dir).some((name) => name.startsWith(".hikoutei-key-stage-"))).toBe(false);
  });

  it("returns key_create_failed (baseline) when the key list invocation throws", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "list") {
        throw new Error(`list exploded ${SECRET_JWT}`);
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    if (result.status === "error") {
      // The thrown text (and any secret in it) never reaches the message.
      expect(result.message).not.toContain(SECRET_JWT);
      expect(result.message).not.toContain("list exploded");
      expect(result.message).toContain("rerun setup");
    }
    // The baseline list happens AFTER the project phase checkpoint but
    // BEFORE the key checkpoint: nothing key-related was persisted or
    // created, and the retained project_selected checkpoint makes the
    // next run resume without re-creating the project.
    expect(keyCreateCalls(harness)).toBe(0);
    expect(readState(harness.statePath).status).toBe("project_selected");
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(harness.created).toHaveLength(0);
  });

  it("returns key_create_uncertain (reconcile) when the key list invocation throws on resume", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    writeFileSync(harness.keyPath, validKeyJson(projectId, saEmail), "utf8");
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "list") {
        throw new Error("connection reset");
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).not.toContain("connection reset");
    }
    // The checkpoint and the local credential are preserved for the next
    // run; no key was created and nothing was deleted.
    expect(readState(harness.statePath).status).toBe("key_create_started");
    expect(readFileSync(harness.keyPath, "utf8")).toBe(validKeyJson(projectId, saEmail));
    expect(keyCreateCalls(harness)).toBe(0);
    expect(keyDeleteCalls(harness)).toBe(0);
  });

  it("normalizes key resource names (case-folded key ids) when parsing the list output", () => {
    const projectId = "proj-1";
    const saEmail = "sa@proj-1.iam.gserviceaccount.com";
    const uppercase = keyResourceName(projectId, saEmail, FIXED_KEY_ID.toUpperCase());
    const parsed = parseUserManagedKeyList(`${uppercase}\n`, projectId, saEmail);
    // The id segment is case-folded so the baseline matches the normalized
    // local-file resource name exactly.
    expect(parsed).toStrictEqual([keyResourceName(projectId, saEmail, FIXED_KEY_ID)]);
    expect(parsed).toStrictEqual([keyResourceNameFor(projectId, saEmail, FIXED_KEY_ID)]);
    // A foreign project/email line is still refused after normalization.
    expect(parseUserManagedKeyList(`${keyResourceName("other-proj", saEmail, FIXED_KEY_ID)}\n`, projectId, saEmail)).toBeNull();
  });

  it("parses bare key ids emitted by newer gcloud (574+) as full resource names", () => {
    const projectId = "proj-1";
    const saEmail = "sa@proj-1.iam.gserviceaccount.com";
    // gcloud 574 emits only the bare 40-hex key id (the last segment of
    // the resource name) for `keys list --format=value(name)`. The list is
    // scoped to this service account and project by the command flags, so
    // the bare id is reconstructed into the canonical resource name.
    const bareId = "82bb5bd206111e9f6499afb82836712c27d335db";
    const parsed = parseUserManagedKeyList(`${bareId}\n`, projectId, saEmail);
    expect(parsed).toStrictEqual([keyResourceNameFor(projectId, saEmail, bareId)]);
    expect(parsed).toStrictEqual([
      `projects/${projectId}/serviceAccounts/${saEmail}/keys/${bareId}`,
    ]);
    // The shorter 16-hex form is accepted too.
    const shortBare = FIXED_KEY_ID;
    expect(parseUserManagedKeyList(`${shortBare}\n`, projectId, saEmail)).toStrictEqual([
      keyResourceNameFor(projectId, saEmail, shortBare),
    ]);
  });

  it("case-folds bare key ids so baseline comparisons are exact", () => {
    const projectId = "proj-1";
    const saEmail = "sa@proj-1.iam.gserviceaccount.com";
    const upperBare = FIXED_KEY_ID.toUpperCase();
    const parsed = parseUserManagedKeyList(`${upperBare}\n`, projectId, saEmail);
    expect(parsed).toStrictEqual([keyResourceNameFor(projectId, saEmail, FIXED_KEY_ID)]);
    // The reconstructed name carries the lowercased id (matches the
    // metadata-derived local-file resource name).
    expect(parsed?.[0]).toBe(
      `projects/${projectId}/serviceAccounts/${saEmail}/keys/${FIXED_KEY_ID}`,
    );
  });

  it("parses a mix of bare ids and full names, trimming/sorting/deduping the baseline", () => {
    const projectId = "proj-1";
    const saEmail = "sa@proj-1.iam.gserviceaccount.com";
    const a = "82bb5bd206111e9f6499afb82836712c27d335db";
    const b = "1122334455667788";
    // `a` appears twice (bare and via its full name) and `b` twice (bare
    // and as uppercased whitespace-padded bare): all dedupe to one entry
    // each, then sort.
    const stdout = [
      a,
      keyResourceName(projectId, saEmail, a),
      b,
      "",
      `  ${b.toUpperCase()}  `,
    ].join("\n");
    const parsed = parseUserManagedKeyList(stdout, projectId, saEmail);
    expect(parsed).toStrictEqual(
      [keyResourceNameFor(projectId, saEmail, a), keyResourceNameFor(projectId, saEmail, b)].sort(),
    );
  });

  it("refuses malformed bare ids and foreign resource names (fail closed)", () => {
    const projectId = "proj-1";
    const saEmail = "sa@proj-1.iam.gserviceaccount.com";
    // Too short / too long / non-hex bare ids are refused.
    expect(parseUserManagedKeyList(`1234567\n`, projectId, saEmail)).toBeNull();
    expect(parseUserManagedKeyList(`${"0".repeat(41)}\n`, projectId, saEmail)).toBeNull();
    expect(parseUserManagedKeyList(`zzzzzzzzzzzzzzzz\n`, projectId, saEmail)).toBeNull();
    // A full resource name for a foreign project or service account is
    // still refused (the foreign-key guard is preserved even though bare
    // ids are now accepted).
    expect(
      parseUserManagedKeyList(
        `${keyResourceName("other-proj", saEmail, FIXED_KEY_ID)}\n`,
        projectId,
        saEmail,
      ),
    ).toBeNull();
    // A well-shaped resource name for THIS account whose id segment is
    // malformed is refused too (not silently accepted as a bare id).
    expect(
      parseUserManagedKeyList(
        `projects/${projectId}/serviceAccounts/${saEmail}/keys/zz\n`,
        projectId,
        saEmail,
      ),
    ).toBeNull();
    // A valid bare id followed by a malformed line refuses the ENTIRE list
    // so a checkpoint baseline never silently drops a key.
    expect(
      parseUserManagedKeyList(`${FIXED_KEY_ID}\nnot-a-key-id\n`, projectId, saEmail),
    ).toBeNull();
  });

  it("normalizeUserManagedKeyLine reconstructs a bare id and refuses malformed input", () => {
    const projectId = "proj-1";
    const saEmail = "sa@proj-1.iam.gserviceaccount.com";
    // Bare id -> canonical resource name.
    expect(normalizeUserManagedKeyLine(FIXED_KEY_ID, projectId, saEmail)).toBe(
      keyResourceNameFor(projectId, saEmail, FIXED_KEY_ID),
    );
    // Full name -> canonical resource name (case-folded id).
    expect(
      normalizeUserManagedKeyLine(keyResourceName(projectId, saEmail, FIXED_KEY_ID.toUpperCase()), projectId, saEmail),
    ).toBe(keyResourceNameFor(projectId, saEmail, FIXED_KEY_ID));
    // Malformed / foreign lines are refused with an explicit null.
    expect(normalizeUserManagedKeyLine("not-a-key-id", projectId, saEmail)).toBeNull();
    expect(
      normalizeUserManagedKeyLine(keyResourceName("other-proj", saEmail, FIXED_KEY_ID), projectId, saEmail),
    ).toBeNull();
  });

  it("exposes a stable keys-list command contract", () => {
    // The command form is a stable machine-readable projection; the
    // bare-id vs full-name output variance is handled at the parser
    // boundary (`parseUserManagedKeyList`), not by changing the command.
    expect(KEY_LIST_COMMAND).toStrictEqual([
      "iam",
      "service-accounts",
      "keys",
      "list",
      "--managed-by=user",
      "--format=value(name)",
    ]);
  });

  it("passes keyFresh=false when the key pre-existed the setup", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    writeFileSync(
      harness.keyPath,
      validKeyJson("existing-proj", "hikoutei-sa@existing-proj.iam.gserviceaccount.com"),
      "utf8",
    );
    const result = await harness.run({ projectId: "existing-proj" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(result.summary.keyReused).toBe(true);
    expect(harness.verifyCalls).toStrictEqual([
      {
        keyPath: harness.keyPath,
        spreadsheetId: CREATED_SHEET_ID,
        keyFresh: false,
        shareFresh: true,
        credentials: {
          client_email: "hikoutei-sa@existing-proj.iam.gserviceaccount.com",
          private_key: RSA_PRIVATE_KEY_PEM,
        },
      },
    ]);
    // The provenance discriminant records the reuse for later resumes.
    expect(readState(harness.statePath).keyOrigin).toBe("reused");
  });

  it("fails with key_create_uncertain on an unmatched delta: zero create calls and zero cloud deletes", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    // A post-baseline key exists but no local credential matches it: the
    // outcome is ambiguous; setup never creates a second key and never
    // deletes anything.
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, [FOREIGN_KEY_ID]);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).toContain("inspect");
      expect(result.message).toContain("will not create another key");
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
      expect(result.message).not.toContain(FOREIGN_KEY_ID);
    }
    expect(keyCreateCalls(harness)).toBe(0);
    expect(keyDeleteCalls(harness)).toBe(0);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(readState(harness.statePath).status).toBe("key_create_started");
    const stateText = readFileSync(harness.statePath, "utf8");
    expect(stateText).not.toContain("private_key");
    expect(stateText).not.toContain("BEGIN PRIVATE KEY");
    // No share/verify/env happened after the failed key phase.
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    expect(existsSync(harness.outputPath)).toBe(false);
  });

  it("fails with key_create_uncertain when the staged key matches one delta entry but a second entry is unmatched", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    // Crash after the create: the staged key is the only local credential
    // and matches delta A (its own resource), but delta B is an additional
    // cloud key NO local credential represents — promotion must not
    // proceed; nothing is created, deleted, installed, or cleaned.
    const stageDir = keyStageDir(harness.keyPath, VALID_KEY_MARKER);
    mkdirSync(stageDir, { mode: 0o700 });
    writeFileSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER), validKeyJson(projectId, saEmail), "utf8");
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, [FIXED_KEY_ID, FOREIGN_KEY_ID]);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_UNCERTAIN);
    if (result.status === "error") {
      expect(result.message).toContain("no local key");
      expect(result.message).not.toContain(FOREIGN_KEY_ID);
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
    }
    expect(keyCreateCalls(harness)).toBe(0);
    expect(keyDeleteCalls(harness)).toBe(0);
    // The staged credential and its directory are preserved untouched.
    expect(existsSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER))).toBe(true);
    expect(existsSync(stageDir)).toBe(true);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(readState(harness.statePath).status).toBe("key_create_started");
    expect(harness.created).toHaveLength(0);
  });

  it("fails with key_create_uncertain when the final key matches one delta entry but a second entry is unmatched", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    // The final key is installed and active (delta A = its own resource),
    // but delta B is an unmatched cloud key: cleanup/promotion must not
    // proceed and the local credential stays in place.
    writeFileSync(harness.keyPath, validKeyJson(projectId, saEmail), "utf8");
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, [FIXED_KEY_ID, FOREIGN_KEY_ID]);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_UNCERTAIN);
    expect(keyCreateCalls(harness)).toBe(0);
    expect(keyDeleteCalls(harness)).toBe(0);
    expect(readFileSync(harness.keyPath, "utf8")).toBe(validKeyJson(projectId, saEmail));
    expect(readState(harness.statePath).status).toBe("key_create_started");
    expect(harness.created).toHaveLength(0);
  });

  it("settles a staged credential that becomes visible during the bounded poll without creating", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    // Crash after the create: the staged key exists, but the IAM key list
    // lags and only shows the created key on the third list call (after
    // the immediate reconcile check and the 2 s and 4 s delayed checks).
    mkdirSync(keyStageDir(harness.keyPath, VALID_KEY_MARKER), { mode: 0o700 });
    writeFileSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER), validKeyJson(projectId, saEmail), "utf8");
    let listCalls = 0;
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "list") {
        listCalls += 1;
        if (listCalls < 3) {
          return { status: "ok", stdout: "", stderr: "" };
        }
        return {
          status: "ok",
          stdout: `${keyResourceName(projectId, saEmail, FIXED_KEY_ID)}\n`,
          stderr: "",
        };
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };

    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(keyCreateCalls(harness)).toBe(0);
    expect(keyDeleteCalls(harness)).toBe(0);
    // The poll waited 2 s and 4 s before the key became visible (the
    // immediate reconcile check and the first delayed check saw nothing);
    // the staged credential was then installed and the stage cleaned up.
    expect(harness.sleepCalls).toStrictEqual([2000, 4000]);
    expect(readFileSync(harness.keyPath, "utf8")).toBe(validKeyJson(projectId, saEmail));
    expect(existsSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER))).toBe(false);
    expect(existsSync(keyStageDir(harness.keyPath, VALID_KEY_MARKER))).toBe(false);
    expect(readState(harness.statePath).status).toBe("complete");
  });

  it("installs a recoverable staged key when the gcloud create invocation failed after writing it", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) => {
      if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
        // gcloud wrote the staged key but the invocation failed (lost
        // result): the staged key is the only credential for the active key.
        freshSetupScript(harness.keyPath)(args, options);
        return failed(1, "connection reset");
      }
      return freshSetupScript(harness.keyPath)(args, options);
    };

    const result = await harness.run();
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(keyCreateCalls(harness)).toBe(1);
    expect(keyDeleteCalls(harness)).toBe(0);
    expect(existsSync(harness.keyPath)).toBe(true);
    expect(statSync(harness.keyPath).mode & 0o777).toBe(0o600);
    expect(result.summary.keyReused).toBe(false);
    expect(readState(harness.statePath).status).toBe("complete");
    expect(readdirSync(dir).some((name) => name.startsWith(".hikoutei-key-stage-"))).toBe(false);
  });

  it("fails closed on an inactive staged key and retains it securely", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const projectId = "resume-proj";
    const saEmail = serviceAccountEmail("hikoutei-sa", projectId);
    writeKeyStartedCheckpoint(dir, harness.keyPath, projectId);
    mkdirSync(keyStageDir(harness.keyPath, VALID_KEY_MARKER), { mode: 0o700 });
    writeFileSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER), validKeyJson(projectId, saEmail), "utf8");
    // The staged key's cloud resource no longer exists (delta empty): it is
    // retained, never deleted, and no new key is created.
    harness.runnerScript = listScript(harness.keyPath, projectId, saEmail, []);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("does not correspond to an active service-account key");
      expect(result.message).not.toContain("BEGIN PRIVATE KEY");
    }
    expect(keyCreateCalls(harness)).toBe(0);
    expect(existsSync(stagedKeyPath(harness.keyPath, VALID_KEY_MARKER))).toBe(true);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(readState(harness.statePath).status).toBe("key_create_started");
  });

  it("corrects a reused 0644 key to 0600 during a real run and refuses a symlink key", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const fixture = validKeyJson("existing-proj", "hikoutei-sa@existing-proj.iam.gserviceaccount.com");
    writeFileSync(harness.keyPath, fixture, { encoding: "utf8", mode: 0o644 });
    const result = await harness.run({ projectId: "existing-proj" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) return;
    expect(result.summary.keyReused).toBe(true);
    expect(statSync(harness.keyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(harness.keyPath, "utf8")).toBe(fixture);

    // A symlink at the key path is refused before any cloud or file
    // mutation; the symlink target is untouched.
    const symlinkDir = makeTempDir();
    const symlinkHarness = createHarness(symlinkDir);
    const victim = join(symlinkDir, "victim.json");
    writeFileSync(victim, fixture, "utf8");
    symlinkSync(victim, symlinkHarness.keyPath);
    const refused = await symlinkHarness.run({ projectId: "existing-proj" });
    expectError(refused, SETUP_ERROR_CODES.SETUP_STATE_INVALID);
    if (refused.status === "error") {
      expect(refused.message).toContain("symlink");
      expect(refused.message).not.toContain("BEGIN PRIVATE KEY");
    }
    expect(symlinkHarness.calls.some((c) => c[0] === "projects")).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe(fixture);
    expect(existsSync(symlinkHarness.statePath)).toBe(false);
  });

  it("refuses win32 non-dry-run with unsupported_platform before any subprocess, network, cloud, lock, or file mutation", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ platform: "win32" });
    expectError(result, SETUP_ERROR_CODES.UNSUPPORTED_PLATFORM);
    if (result.status === "error") {
      expect(result.message).toContain("macOS and Linux");
      expect(result.message).toContain("manual");
    }
    expect(harness.calls).toHaveLength(0);
    expect(harness.humanTokens).toHaveLength(0);
    expect(harness.created).toHaveLength(0);
    expect(existsSync(harness.statePath)).toBe(false);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
  });

  it("keeps win32 dry runs pure and successful", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ platform: "win32", dryRun: true });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || !result.dryRun) return;
    expect(harness.calls).toHaveLength(0);
    expect(harness.humanTokens).toHaveLength(0);
    expect(existsSync(harness.statePath)).toBe(false);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
    expect(gcloudCommands(result.commands).some((c) => c[0] === "iam" && c[3] === "create")).toBe(true);
  });

  it("runs normally on linux and darwin platforms", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ platform: "linux" });
    expect(result.status).toBe("ok");
  });
});

describe("runSetup — exclusive lock", () => {
  it("fails with setup_in_progress on lock contention after preflight only, with zero mutations", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // A concurrent invocation holds the lock (an empty lock directory).
    mkdirSync(setupLockPath(harness.statePath), { mode: 0o700 });

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_IN_PROGRESS);
    if (result.status === "error") {
      expect(result.message).toContain("another hikoutei setup appears to be running");
      expect(result.message).toContain("lock directory");
    }
    // Only the read-only preflight ran; no cloud/API/file mutation happened.
    expect(harness.calls.map((c) => c.join(" "))).toStrictEqual([
      "--version",
      "auth list --filter=status:ACTIVE --format=value(account)",
      "auth print-access-token",
    ]);
    expect(harness.humanTokens).toHaveLength(0);
    expect(harness.created).toHaveLength(0);
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    expect(harness.lookupCalls).toHaveLength(0);
    expect(existsSync(harness.statePath)).toBe(false);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
    // The foreign lock directory is untouched.
    expect(lstatSync(setupLockPath(harness.statePath)).isDirectory()).toBe(true);
  });

  it("fails with setup_in_progress for any pre-existing lock entry, file or directory", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const lockPath = setupLockPath(harness.statePath);
    // A stale-looking lock FILE (legacy leftover) blocks exactly like a
    // lock directory: the entry type is never inspected or trusted.
    writeFileSync(lockPath, "{ \"pid\": 999999 }", "utf8");
    let result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_IN_PROGRESS);
    expect(harness.calls).toHaveLength(3);
    expect(readFileSync(lockPath, "utf8")).toBe("{ \"pid\": 999999 }");

    rmSync(lockPath, { force: true });
    mkdirSync(lockPath, { mode: 0o700 });
    result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_IN_PROGRESS);
    expect(harness.created).toHaveLength(0);
    expect(lstatSync(lockPath).isDirectory()).toBe(true);
  });

  it("never takes over a leftover lock directory: setup_in_progress with zero mutations", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    // A lock directory left behind by a crashed run (no metadata inside,
    // nothing to probe) must still block the run: automatic stale-lock
    // takeover is racy and is disabled entirely.
    const lockPath = setupLockPath(harness.statePath);
    mkdirSync(lockPath, { mode: 0o700 });

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.SETUP_IN_PROGRESS);
    if (result.status === "error") {
      expect(result.message).toContain("never removed automatically");
    }
    // Only the read-only preflight ran; no cloud/API/file mutation happened
    // and the leftover lock directory survives untouched.
    expect(harness.calls.map((c) => c.join(" "))).toStrictEqual([
      "--version",
      "auth list --filter=status:ACTIVE --format=value(account)",
      "auth print-access-token",
    ]);
    expect(harness.humanTokens).toHaveLength(0);
    expect(harness.created).toHaveLength(0);
    expect(harness.shares).toHaveLength(0);
    expect(harness.verifyCalls).toHaveLength(0);
    expect(harness.lookupCalls).toHaveLength(0);
    expect(existsSync(harness.statePath)).toBe(false);
    expect(existsSync(harness.keyPath)).toBe(false);
    expect(existsSync(harness.outputPath)).toBe(false);
    expect(lstatSync(lockPath).isDirectory()).toBe(true);
  });

  it("reports setup_lock_failed (not setup_in_progress) when the lock directory cannot be created", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const failingFs: LockFs = {
      mkdirSync() {
        const error = new Error("EACCES") as NodeJS.ErrnoException;
        error.code = "EACCES";
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
    };

    const result = await harness.run({ lockFs: failingFs });
    expectError(result, SETUP_ERROR_CODES.SETUP_LOCK_FAILED);
    if (result.status === "error") {
      expect(result.message).toContain("could not create the setup lock directory");
      expect(result.message).not.toContain("another hikoutei setup");
    }
    // Only the read-only preflight ran; no cloud/API/file mutation happened.
    expect(harness.calls).toHaveLength(3);
    expect(harness.humanTokens).toHaveLength(0);
    expect(harness.created).toHaveLength(0);
    expect(existsSync(harness.statePath)).toBe(false);
    expect(existsSync(harness.keyPath)).toBe(false);
  });

  it("releases the lock on every error result", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    harness.runnerScript = (args, options) =>
      args[0] === "projects" && args[1] === "create"
        ? failed(1, "ERROR: (gcloud.projects.create) Permission denied.")
        : freshSetupScript(harness.keyPath)(args, options);

    const result = await harness.run();
    expectError(result, SETUP_ERROR_CODES.PROJECT_CREATE_FAILED);
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
  });

  it("releases the lock on a setup_state_conflict error", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const first = await harness.run();
    expect(first.status).toBe("ok");

    harness.tokenInfo = { email: "other@example.com", scope: DRIVE_SCOPE };
    const second = await harness.run();
    expectError(second, SETUP_ERROR_CODES.SETUP_STATE_CONFLICT);
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
  });

  it("creates no lock in dry-run mode", async () => {
    const dir = makeTempDir();
    const harness = createHarness(dir);
    const result = await harness.run({ dryRun: true });
    expect(result.status).toBe("ok");
    expect(existsSync(setupLockPath(harness.statePath))).toBe(false);
    expect(harness.calls).toHaveLength(0);
  });
});

describe("formatSummary", () => {
  it("prints owner, roles, checkpoint and paths but never key contents or tokens", () => {
    const text = formatSummary({
      projectId: "hikoutei-abc",
      ownerEmail: FAKE_OWNER,
      serviceAccountEmail: "hikoutei-sa@hikoutei-abc.iam.gserviceaccount.com",
      keyPath: "/tmp/hikoutei-service-account.json",
      spreadsheetId: "spreadsheet-123",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/spreadsheet-123/edit",
      spreadsheetTitle: "hikoutei-sync-hikoutei-abc",
      outputPath: "/tmp/.env",
      statePath: "/tmp/.hikoutei-setup-state.json",
      stateStatus: "complete",
      envFileCreated: false,
      envFileModified: true,
      projectReused: false,
      serviceAccountReused: true,
      keyReused: false,
      saWriterRole: "created",
      resumed: false,
    });
    expect(text).toContain("hikoutei-abc");
    expect(text).toContain(FAKE_OWNER);
    expect(text).toContain("hikoutei-sa@hikoutei-abc.iam.gserviceaccount.com");
    expect(text).toContain("SA writer role:       created");
    expect(text).toContain("https://docs.google.com/spreadsheets/d/spreadsheet-123/edit");
    expect(text).toContain("/tmp/.hikoutei-setup-state.json (complete)");
    expect(text).toContain("/tmp/.env (updated)");
    expect(text).not.toContain("private_key");
    expect(text).not.toContain(FAKE_TOKEN);
  });
});

describe("derived identity helpers", () => {
  it("derives service account emails and default titles", () => {
    expect(serviceAccountEmail("sa", "proj")).toBe("sa@proj.iam.gserviceaccount.com");
    expect(defaultSpreadsheetTitle("proj")).toBe("hikoutei-sync-proj");
  });
});

describe("setup artifact ignore rules", () => {
  const IGNORE_PATTERNS = [
    "hikoutei-service-account.json",
    ".hikoutei-setup-state.json",
    ".hikoutei-setup-state.json.tmp*",
    ".hikoutei-setup-state.json.lock",
    ".hikoutei-key-stage-*",
    ".hikoutei-key-cleanup-*",
    ".hikoutei-env-*",
  ] as const;

  // Concrete default/fixed artifact names: the default key, the checkpoint
  // with its reserved `.tmp` base and unique per-run variant, the lock, a
  // staged/cleanup key.json inside the deterministic private directories,
  // and an env temp file. A `git add .` must never pick any of these up.
  const ARTIFACT_EXAMPLES = [
    "hikoutei-service-account.json",
    "nested/app/hikoutei-service-account.json",
    ".hikoutei-setup-state.json",
    ".hikoutei-setup-state.json.tmp",
    ".hikoutei-setup-state.json.tmp-1234-a0b1c2d3-e89b-42d3-a456-426614174000",
    ".hikoutei-setup-state.json.lock",
    ".hikoutei-key-stage-a0b1c2d3-e89b-42d3-a456-426614174000/key.json",
    ".hikoutei-key-cleanup-a0b1c2d3-e89b-42d3-a456-426614174000/key.json",
    ".hikoutei-env-1234-a0b1c2d3-e89b-42d3-a456-426614174000.tmp",
  ] as const;

  it("lists a precise ignore pattern for every default setup artifact family", () => {
    const text = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    for (const pattern of IGNORE_PATTERNS) {
      expect(lines).toContain(pattern);
    }
  });

  it("protects the concrete default artifact names (git check-ignore, read-only)", () => {
    const gitignoreUrl = new URL("../.gitignore", import.meta.url);
    const repoRoot = dirname(fileURLToPath(gitignoreUrl));
    const paths = ARTIFACT_EXAMPLES.map((name) => join(repoRoot, name));
    const probe = spawnSync("git", ["check-ignore", "--no-index", "--", ...paths], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    if (probe.error !== undefined || probe.status === null) {
      // Not a git repository or git unavailable: the pattern-list
      // assertion above is the fallback proof.
      return;
    }
    // check-ignore prints exactly the paths that matched; every default
    // artifact example must be among them (exit code 0 only means at
    // least one matched, so the stdout membership check is the precise
    // assertion). The invocation is read-only and never modifies Git.
    const matched = probe.stdout.split("\n").filter((line) => line !== "");
    for (const path of paths) {
      expect(matched).toContain(path);
    }
  });
});

describe("package and entry regression", () => {
  it("maps the bin to dist/cli/setup.js with a node shebang", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin.hikoutei).toBe("./dist/cli/setup.js");

    const entry = readFileSync(new URL("../src/cli/setup.ts", import.meta.url), "utf8");
    expect(entry.split("\n")[0]).toBe("#!/usr/bin/env node");
  });
});
