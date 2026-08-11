/**
 * Orchestration for `hikoutei setup`.
 *
 * `runSetup` is the pure-ish core of the CLI: it receives an injected gcloud
 * runner and spreadsheet creator, drives the bootstrap sequence (preflight,
 * project, API enable, service account, key, spreadsheet, .env), and returns
 * an explicit result union. Nothing here reads process state; the thin entry
 * in `setup.ts` resolves defaults and prints output. `--dry-run` builds the
 * exact command plan without invoking the runner or touching the filesystem.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { SETUP_ERROR_CODES, type SetupErrorCode } from "./errors.js";
import type { GcloudRunner, GcloudRunResult } from "./gcloudRunner.js";
import type { SpreadsheetCreator, SpreadsheetCreateResult } from "./sheetsFactory.js";

/** Default service-account key file name, resolved against the current directory. */
export const DEFAULT_KEY_FILE_NAME = "hikoutei-service-account.json";

/** Prefix of the default spreadsheet title (`hikoutei-sync-<project>`). */
export const DEFAULT_SPREADSHEET_TITLE_PREFIX = "hikoutei-sync";

/** Service-account key file permission after setup (owner read/write only). */
export const KEY_FILE_MODE = 0o600;

/** Options for one setup run; paths are absolute and resolved by the entry. */
export interface RunSetupOptions {
  readonly runner: GcloudRunner;
  readonly createSpreadsheet: SpreadsheetCreator;
  /** Existing project id, or undefined to create `hikoutei-<slug>`. */
  readonly projectId: string | undefined;
  readonly saName: string;
  /** Spreadsheet title override; defaults to `hikoutei-sync-<project>`. */
  readonly spreadsheetTitle: string | undefined;
  /** Absolute service-account key path. */
  readonly keyPath: string;
  /** Absolute .env output path. */
  readonly outputPath: string;
  readonly dryRun: boolean;
}

/** One planned or executed step of the setup flow. */
export type PlannedCommand =
  | { readonly kind: "gcloud"; readonly command: readonly string[]; readonly outcome: string }
  | { readonly kind: "api"; readonly label: string; readonly outcome: string }
  | { readonly kind: "file"; readonly label: string; readonly outcome: string };

/** Outcome summary returned for a successful (non-dry-run) setup. */
export interface SetupSummary {
  readonly projectId: string;
  readonly serviceAccountEmail: string;
  readonly keyPath: string;
  readonly spreadsheetId: string;
  readonly spreadsheetUrl: string;
  readonly spreadsheetTitle: string;
  readonly outputPath: string;
  readonly envFileCreated: boolean;
  readonly envFileModified: boolean;
  readonly projectReused: boolean;
  readonly serviceAccountReused: boolean;
  readonly keyReused: boolean;
}

/** Discriminated result of a setup run. */
export type SetupResult =
  | {
    readonly status: "ok";
    readonly dryRun: false;
    readonly summary: SetupSummary;
    readonly commands: readonly PlannedCommand[];
  }
  | { readonly status: "ok"; readonly dryRun: true; readonly commands: readonly PlannedCommand[] }
  | { readonly status: "error"; readonly code: SetupErrorCode; readonly message: string };

const AUTH_LIST_ARGS = ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"] as const;

/** gcloud error text that signals an already-existing project on create. */
const PROJECT_ALREADY_EXISTS_MARKER = "already exists";

/** Derives the service-account email for a name and project. */
export function serviceAccountEmail(saName: string, projectId: string): string {
  return `${saName}@${projectId}.iam.gserviceaccount.com`;
}

/** Default spreadsheet title for a project. */
export function defaultSpreadsheetTitle(projectId: string): string {
  return `${DEFAULT_SPREADSHEET_TITLE_PREFIX}-${projectId}`;
}

/**
 * Generates a `hikoutei-<timestamp>-<random>` project id.
 *
 * The timestamp base-36 component sorts lexically and the random suffix makes
 * parallel runs collision-resistant; if the id already exists the flow reuses
 * the project instead of failing.
 */
export function generateProjectId(now: number = Date.now(), random: () => number = Math.random): string {
  const timestampPart = now.toString(36);
  const randomPart = Math.floor(random() * 36 ** 4).toString(36).padStart(4, "0");
  return `hikoutei-${timestampPart}-${randomPart}`;
}

/**
 * Builds the exact command plan for a dry run.
 *
 * Pure: does not execute anything and does not touch the filesystem. Each
 * step carries a simulated outcome so `--dry-run` previews both the fresh
 * path and the reuse branches.
 */
export function planSetupCommands(options: RunSetupOptions, slug: string): readonly PlannedCommand[] {
  const projectId = options.projectId ?? slug;
  const email = serviceAccountEmail(options.saName, projectId);
  const title = options.spreadsheetTitle ?? defaultSpreadsheetTitle(projectId);
  const commands: PlannedCommand[] = [
    { kind: "gcloud", command: ["--version"], outcome: "gcloud is installed" },
    { kind: "gcloud", command: [...AUTH_LIST_ARGS], outcome: "an active account is logged in" },
  ];
  if (options.projectId !== undefined) {
    commands.push({
      kind: "gcloud",
      command: ["projects", "describe", options.projectId],
      outcome: "project verified",
    });
  } else {
    commands.push({
      kind: "gcloud",
      command: ["projects", "create", slug],
      outcome: "project created (reused when it already exists)",
    });
  }
  commands.push(
    {
      kind: "gcloud",
      command: ["config", "set", "project", projectId],
      outcome: "default project selected",
    },
    {
      kind: "gcloud",
      command: ["services", "enable", "sheets.googleapis.com", "--project", projectId],
      outcome: "Sheets API enabled (idempotent)",
    },
    {
      kind: "gcloud",
      command: ["iam", "service-accounts", "list", "--project", projectId, "--format=value(email)"],
      outcome: "no matching service account; create follows",
    },
    {
      kind: "gcloud",
      command: [
        "iam",
        "service-accounts",
        "create",
        options.saName,
        "--project",
        projectId,
        "--display-name",
        "hikoutei setup",
      ],
      outcome: "service account created (reused when it already exists)",
    },
    {
      kind: "gcloud",
      command: [
        "iam",
        "service-accounts",
        "keys",
        "create",
        options.keyPath,
        "--iam-account",
        email,
        "--project",
        projectId,
      ],
      outcome: `key written to ${options.keyPath} with mode 600 (reused when the file already exists)`,
    },
    {
      kind: "api",
      label: `spreadsheets.create (title "${title}") with the new service-account key`,
      outcome: `spreadsheet owned by ${email}; no sharing step required`,
    },
    {
      kind: "file",
      label: `write ${options.outputPath}`,
      outcome: "GOOGLE_APPLICATION_CREDENTIALS and HIKOUTEI_SYNC_SPREADSHEET_URL set; unrelated lines preserved",
    },
  );
  return commands;
}

/** Renders a plan or executed-command list for `--dry-run` output. */
export function formatPlan(commands: readonly PlannedCommand[]): string {
  return commands
    .map((step) => {
      switch (step.kind) {
        case "gcloud":
          return `$ gcloud ${step.command.join(" ")}\n  # ${step.outcome}`;
        case "api":
          return `$ ${step.label}\n  # ${step.outcome}`;
        case "file":
          return `# ${step.label}: ${step.outcome}`;
      }
    })
    .join("\n");
}

/** Renders the human summary; never includes key contents or secrets. */
export function formatSummary(summary: SetupSummary): string {
  const envState = summary.envFileCreated
    ? "created"
    : summary.envFileModified
      ? "updated"
      : "unchanged";
  return [
    "Hikoutei setup complete.",
    `  project:              ${summary.projectId} (${summary.projectReused ? "reused" : "created"})`,
    `  service account:      ${summary.serviceAccountEmail} (${summary.serviceAccountReused ? "reused" : "created"})`,
    `  service account key:  ${summary.keyPath} (${summary.keyReused ? "reused" : "created"})`,
    `  spreadsheet:          ${summary.spreadsheetTitle} (${summary.spreadsheetId})`,
    `  spreadsheet URL:      ${summary.spreadsheetUrl}`,
    `  env file:             ${summary.outputPath} (${envState})`,
  ].join("\n");
}

/**
 * Runs the full setup bootstrap.
 *
 * In dry-run mode returns the command plan without invoking the runner or
 * touching the filesystem. Otherwise the sequence is: preflight (gcloud
 * present, active account), project verify/create, `config set project`,
 * enable the Sheets API, service account list/create, key create (or reuse
 * an existing key file) with chmod 600, spreadsheet creation through the
 * injected creator, and finally the .env write. Every phase maps to a stable
 * error code on failure; key material is never included in messages.
 */
export async function runSetup(options: RunSetupOptions): Promise<SetupResult> {
  if (options.dryRun) {
    return {
      status: "ok",
      dryRun: true,
      commands: planSetupCommands(options, options.projectId ?? generateProjectId()),
    };
  }

  const executed: PlannedCommand[] = [];
  const { runner } = options;

  // Preflight: gcloud must exist and an active account must be logged in.
  const version = await runner.run(["--version"]);
  executed.push({ kind: "gcloud", command: ["--version"], outcome: outcomeOf(version, "gcloud is installed") });
  if (version.status === "not_found") {
    return errorResult(
      SETUP_ERROR_CODES.GCLOUD_MISSING,
      "gcloud CLI was not found on PATH; install it from https://cloud.google.com/sdk and try again",
    );
  }
  if (version.status === "failed") {
    return errorResult(SETUP_ERROR_CODES.GCLOUD_MISSING, `gcloud --version failed: ${describeGcloudFailure(version)}`);
  }

  const auth = await runner.run([...AUTH_LIST_ARGS]);
  executed.push({ kind: "gcloud", command: [...AUTH_LIST_ARGS], outcome: outcomeOf(auth, "active account found") });
  if (auth.status !== "ok") {
    return errorResult(
      SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN,
      `could not list active gcloud accounts: ${describeGcloudFailure(auth)}`,
    );
  }
  if (auth.stdout.trim() === "") {
    return errorResult(
      SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN,
      "no active gcloud account; run `gcloud auth login` first",
    );
  }

  // Project: verify an explicit one, or create `hikoutei-<slug>` idempotently.
  let projectId: string;
  let projectReused = false;
  if (options.projectId !== undefined) {
    const describe = await runner.run(["projects", "describe", options.projectId]);
    executed.push({
      kind: "gcloud",
      command: ["projects", "describe", options.projectId],
      outcome: outcomeOf(describe, "project verified"),
    });
    if (describe.status !== "ok") {
      return errorResult(
        SETUP_ERROR_CODES.PROJECT_NOT_FOUND,
        `project "${options.projectId}" could not be verified: ${describeGcloudFailure(describe)}`,
      );
    }
    projectId = options.projectId;
  } else {
    projectId = generateProjectId();
    const create = await runner.run(["projects", "create", projectId]);
    if (create.status !== "ok") {
      if (create.status === "failed" && create.stderr.includes(PROJECT_ALREADY_EXISTS_MARKER)) {
        projectReused = true;
        executed.push({ kind: "gcloud", command: ["projects", "create", projectId], outcome: "reused (project already exists)" });
      } else {
        return errorResult(
          SETUP_ERROR_CODES.PROJECT_CREATE_FAILED,
          `could not create project "${projectId}": ${describeGcloudFailure(create)}`,
        );
      }
    } else {
      executed.push({ kind: "gcloud", command: ["projects", "create", projectId], outcome: "created" });
    }
  }

  const configSet = await runner.run(["config", "set", "project", projectId]);
  executed.push({ kind: "gcloud", command: ["config", "set", "project", projectId], outcome: outcomeOf(configSet, "default project selected") });
  if (configSet.status !== "ok") {
    return errorResult(
      SETUP_ERROR_CODES.PROJECT_SELECT_FAILED,
      `could not select project "${projectId}": ${describeGcloudFailure(configSet)}`,
    );
  }

  const enable = await runner.run(["services", "enable", "sheets.googleapis.com", "--project", projectId]);
  executed.push({
    kind: "gcloud",
    command: ["services", "enable", "sheets.googleapis.com", "--project", projectId],
    outcome: outcomeOf(enable, "Sheets API enabled"),
  });
  if (enable.status !== "ok") {
    return errorResult(
      SETUP_ERROR_CODES.API_ENABLE_FAILED,
      `could not enable sheets.googleapis.com: ${describeGcloudFailure(enable)}`,
    );
  }

  // Service account: reuse by email when it already exists.
  const email = serviceAccountEmail(options.saName, projectId);
  let serviceAccountReused = false;
  const saList = await runner.run(["iam", "service-accounts", "list", "--project", projectId, "--format=value(email)"]);
  executed.push({
    kind: "gcloud",
    command: ["iam", "service-accounts", "list", "--project", projectId, "--format=value(email)"],
    outcome: outcomeOf(saList, "service account lookup complete"),
  });
  if (saList.status !== "ok") {
    return errorResult(SETUP_ERROR_CODES.SA_CREATE_FAILED, `could not list service accounts: ${describeGcloudFailure(saList)}`);
  }
  const existingEmails = saList.stdout.split("\n").map((line) => line.trim());
  if (existingEmails.includes(email)) {
    serviceAccountReused = true;
  } else {
    const saCreate = await runner.run([
      "iam",
      "service-accounts",
      "create",
      options.saName,
      "--project",
      projectId,
      "--display-name",
      "hikoutei setup",
    ]);
    executed.push({
      kind: "gcloud",
      command: [
        "iam",
        "service-accounts",
        "create",
        options.saName,
        "--project",
        projectId,
        "--display-name",
        "hikoutei setup",
      ],
      outcome: outcomeOf(saCreate, "service account created"),
    });
    if (saCreate.status !== "ok") {
      return errorResult(
        SETUP_ERROR_CODES.SA_CREATE_FAILED,
        `could not create service account "${options.saName}": ${describeGcloudFailure(saCreate)}`,
      );
    }
  }

  // Key: reuse an existing key file instead of overwriting it.
  let keyReused = false;
  if (existsSync(options.keyPath)) {
    keyReused = true;
  } else {
    const keyCreate = await runner.run([
      "iam",
      "service-accounts",
      "keys",
      "create",
      options.keyPath,
      "--iam-account",
      email,
      "--project",
      projectId,
    ]);
    executed.push({
      kind: "gcloud",
      command: [
        "iam",
        "service-accounts",
        "keys",
        "create",
        options.keyPath,
        "--iam-account",
        email,
        "--project",
        projectId,
      ],
      outcome: outcomeOf(keyCreate, "key created"),
    });
    if (keyCreate.status !== "ok") {
      return errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `could not create a service-account key for ${email}: ${describeGcloudFailure(keyCreate)}`,
      );
    }
  }
  try {
    chmodSync(options.keyPath, KEY_FILE_MODE);
  } catch (error) {
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not secure the key file ${options.keyPath}: ${messageOf(error)}`,
    );
  }

  // Spreadsheet: created with the new key, so the SA owns it.
  const title = options.spreadsheetTitle ?? defaultSpreadsheetTitle(projectId);
  let spreadsheet: SpreadsheetCreateResult;
  try {
    spreadsheet = await options.createSpreadsheet({ keyPath: options.keyPath, title });
  } catch (error) {
    return errorResult(
      SETUP_ERROR_CODES.SHEET_CREATE_FAILED,
      `could not create spreadsheet "${title}": ${messageOf(error)}`,
    );
  }

  // .env: update only the two managed keys, preserving unrelated lines.
  let envResult: EnvFileWriteResult;
  try {
    envResult = writeSetupEnvFile(options.outputPath, options.keyPath, spreadsheet.spreadsheetUrl);
  } catch (error) {
    return errorResult(
      SETUP_ERROR_CODES.OUTPUT_WRITE_FAILED,
      `could not write ${options.outputPath}: ${messageOf(error)}`,
    );
  }

  return {
    status: "ok",
    dryRun: false,
    commands: executed,
    summary: {
      projectId,
      serviceAccountEmail: email,
      keyPath: options.keyPath,
      spreadsheetId: spreadsheet.spreadsheetId,
      spreadsheetUrl: spreadsheet.spreadsheetUrl,
      spreadsheetTitle: title,
      outputPath: options.outputPath,
      envFileCreated: envResult.created,
      envFileModified: envResult.modified,
      projectReused,
      serviceAccountReused,
      keyReused,
    },
  };
}

/** The two .env keys the setup CLI manages. */
export const SETUP_ENV_KEYS = {
  CREDENTIALS: "GOOGLE_APPLICATION_CREDENTIALS",
  SPREADSHEET_URL: "HIKOUTEI_SYNC_SPREADSHEET_URL",
} as const;

/** Result of writing the .env output file. */
export interface EnvFileWriteResult {
  /** True when the file did not exist before this write. */
  readonly created: boolean;
  /** True when the file content changed (created or keys added/updated). */
  readonly modified: boolean;
}

function isManagedEnvLine(line: string): boolean {
  return (
    line.startsWith(`${SETUP_ENV_KEYS.CREDENTIALS}=`) ||
    line.startsWith(`${SETUP_ENV_KEYS.SPREADSHEET_URL}=`)
  );
}

/**
 * Writes or updates the .env output file.
 *
 * Reads the existing file (if any), keeps every unrelated line untouched,
 * replaces any existing managed key lines, appends the two managed keys, and
 * writes back only when the content changed. A missing file is created.
 * Throws on filesystem failure; the caller maps the throw to
 * `output_write_failed`.
 */
export function writeSetupEnvFile(
  outputPath: string,
  credentialsPath: string,
  spreadsheetUrl: string,
): EnvFileWriteResult {
  let existing = "";
  let created = false;
  try {
    existing = readFileSync(outputPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      created = true;
    } else {
      throw error;
    }
  }

  const rawLines = existing === "" ? [] : existing.split("\n");
  // A trailing empty element comes from the final newline; drop it so
  // unrelated content is preserved without a spurious blank line.
  const lines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
  const next = [
    ...lines.filter((line) => !isManagedEnvLine(line)),
    `${SETUP_ENV_KEYS.CREDENTIALS}=${credentialsPath}`,
    `${SETUP_ENV_KEYS.SPREADSHEET_URL}=${spreadsheetUrl}`,
  ];
  const content = `${next.join("\n")}\n`;
  const modified = created || content !== existing;
  if (modified) {
    writeFileSync(outputPath, content, "utf8");
  }
  return { created, modified };
}

function errorResult(code: SetupErrorCode, message: string): SetupResult {
  return { status: "error", code, message };
}

function outcomeOf(result: GcloudRunResult, okOutcome: string): string {
  if (result.status === "ok") {
    return okOutcome;
  }
  return `failed: ${describeGcloudFailure(result)}`;
}

function describeGcloudFailure(result: GcloudRunResult): string {
  if (result.status === "not_found") {
    return "gcloud CLI not found on PATH";
  }
  if (result.status === "failed") {
    return (
      firstNonEmptyLine(result.stderr) ??
      firstNonEmptyLine(result.stdout) ??
      `gcloud exited with status ${result.code === null ? "unknown" : String(result.code)}`
    );
  }
  return "unexpected gcloud outcome";
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }
  return undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
