/**
 * Orchestration for `hikoutei setup`.
 *
 * `runSetup` is the pure-ish core of the CLI: it receives injected gcloud
 * runner, token validator, human-token sheet API factory, and service-account
 * verifier, and drives the bootstrap sequence (preflight, Drive-scoped human
 * auth, exclusive setup lock, checkpoint, project, API enable, service
 * account, key, human-owned spreadsheet, SA writer share, SA access verify,
 * .env, complete checkpoint) and returns an explicit result union. Nothing
 * here reads process state; the thin entry in `setup.ts` resolves defaults
 * and prints output. `--dry-run` builds the exact command plan: it performs
 * only read-only local path-safety resolution (the reserved-path collision
 * check) and never invokes a subprocess, the network, or the cloud, and
 * never mutates the filesystem (no lock, checkpoint, key, or .env writes).
 *
 * The spreadsheet is created by the logged-in human account (service accounts
 * cannot own Workspace assets) and shared with the service account as a
 * writer. The access token exists only in memory: it is never written to the
 * checkpoint, the .env file, or any message. Drive `files.generateIds` ids
 * cannot create Google Workspace files, so creation uses an honest
 * marker-based write-ahead contract instead: a local opaque creation marker
 * (a UUID) is generated and persisted as `spreadsheet_create_started` BEFORE
 * the one and only remote create attempt, and that same create request
 * carries the marker as a private `appProperties` entry. A lost response or
 * failed create is reconciled by querying Drive for that exact marker; when
 * the outcome cannot be confirmed the run fails with `sheet_create_uncertain`
 * and NEVER creates a second spreadsheet — the next run reconciles the
 * started state by marker again. The spreadsheet URL is derived from the id
 * and never stored. Sharing is a write-ahead too: `spreadsheet_share_started`
 * (spreadsheet id + keyOrigin, no shareOrigin) is persisted BEFORE the
 * idempotent writer-permission ensure can create/upgrade the permission,
 * and `spreadsheet_shared` only after the ensure completes — a crash
 * between the remote permission mutation and that write leaves
 * `spreadsheet_share_started` and resumes safely; a loaded
 * share-started state conservatively persists `shareOrigin: "fresh"`
 * (the prior attempt may have created/upgraded before crashing) so the
 * 403/404 propagation retries are preserved.
 *
 * An exclusive setup lock (`<state>.lock`) is acquired after the human
 * Drive-scope preflight and held through the whole run, so concurrent runs
 * cannot double-create cloud resources; the lock is an EMPTY DIRECTORY
 * created with `mkdir` (mode 0700) and released with `rmdir` on every exit.
 * A crash leaves the empty directory behind for manual removal only; it is
 * never removed automatically. The service-account key is created by
 * gcloud under a REAL write-ahead state: the flow lists the user-managed
 * keys of the service account, persists a `key_create_started` checkpoint
 * (UUID marker + baseline) BEFORE the single gcloud key create, and the
 * marker derives a deterministic private sibling staging directory so a
 * crash at any key boundary resumes by reconciliation instead of creating
 * a second key (an unmatched cloud key fails with `key_create_uncertain`;
 * nothing is ever deleted automatically). The key is validated in the
 * staging directory and installed at the final key path with an atomic
 * same-filesystem hard link, so the final path is never pointed at by
 * gcloud and a planted entry there fails closed (`key_create_failed`)
 * instead of being overwritten; reused keys are enforced to owner-only
 * mode 0600 through one secure descriptor. Whether the key was CREATED
 * by the setup or REUSED is persisted as the non-secret `keyOrigin`
 * discriminant from `key_ready` onward, so a resumed run keeps the
 * verify-phase propagation freshness (Invalid JWT Signature retries)
 * without conflating it with the current run's reuse summary. The `.env`
 * write is also atomic (unique private temp file + rename) and never
 * reads or follows a symlink/hardlink alias of the key or checkpoint.
 * Automatic setup runs on macOS and Linux; on Windows a non-dry-run fails
 * with `unsupported_platform` before any subprocess, network, cloud,
 * lock, checkpoint, key, or env mutation, and manual setup remains
 * available.
 */

import { basename, dirname, join } from "node:path";
import {
  acquireSetupLock,
  checkStateCompatibility,
  generateCreationMarker,
  isValidGcpProjectId,
  isValidServiceAccountName,
  loadSetupState,
  releaseSetupLock,
  saveSetupState,
  serviceAccountEmail,
  SERVICE_ACCOUNT_KEY_FILE_MODE,
  SETUP_STATE_VERSION,
  setupLockPath,
  setupStateTempPath,
  type KeyOrigin,
  type LockFs,
  type ProjectMode,
  type SetupPoolEntry,
  type SetupState,
  type ShareOrigin,
} from "./checkpoint.js";
import { MAX_SETUP_SA_COUNT, parseSaCount } from "./args.js";
import { SETUP_ERROR_CODES, carrierCode, setupFailure, type SetupErrorCode, type SetupFailure } from "./errors.js";
import { describeGcloudFailure, errorResult, outcomeOf, type PlannedCommand, type SetupErrorResult } from "./flowResult.js";
import {
  atomicWritePrivateFile,
  revalidateSetupPaths,
  SETUP_ENV_KEYS,
  writeSetupEnvFile,
  type EnvFileWriteResult,
} from "./envFileWriter.js";
import { findSetupPathCollision, type SetupPathCollision } from "./setupPathCollision.js";
import {
  readServiceAccountKeyCredentialSecurely,
  readServiceAccountKeySecurely,
} from "./keyMaterial.js";

// Compat re-exports: the extracted modules are the canonical homes; the
// setupFlow import path is kept stable for existing importers.
export { writeSetupEnvFile, atomicWritePrivateFile, SETUP_ENV_KEYS } from "./envFileWriter.js";
export { findSetupPathCollision, type SetupPathCollision } from "./setupPathCollision.js";
import { createSafeRunner, type GcloudRunner, type GcloudRunResult } from "./gcloudRunner.js";
import {
  boundedCheckReporter,
  POOL_EXPANSION_PHASE,
  safeProgressSink,
  SETUP_PROGRESS_OPERATIONS,
  type SetupProgressPhase,
  type SetupProgressSink,
} from "./setupProgress.js";
import {
  checkHumanDriveAccess,
  DRIVE_ACCESS_COMMAND,
  type HumanAuthResult,
  type TokenValidator,
} from "./humanAuth.js";
import {
  KEY_STAGE_PLACEHOLDER,
  listUserManagedServiceAccountKeys,
  realSleeper,
  settleServiceAccountKey,
  type Sleeper,
} from "./keyProvision.js";
import { httpStatusOf, safeReasonOf } from "./sdkError.js";
import type { SaAccessVerifier } from "./saVerify.js";
import type {
  HumanSheetApi,
  HumanSheetApiFactory,
  MarkerFileInfo,
  ShareOutcome,
  SpreadsheetCreateResult,
} from "./sheetsFactory.js";
import { HIKOUTEI_SETUP_MARKER_KEY, SPREADSHEET_MIME_TYPE, spreadsheetEditUrl } from "./sheetsFactory.js";

/** Default service-account key file name, resolved against the current directory. */
export const DEFAULT_KEY_FILE_NAME = "hikoutei-service-account.json";

/** Prefix of the default spreadsheet title (`hikoutei-sync-<project>`). */
export const DEFAULT_SPREADSHEET_TITLE_PREFIX = "hikoutei-sync";

/** Service-account key file permission after setup (owner read/write only). */
export const KEY_FILE_MODE = SERVICE_ACCOUNT_KEY_FILE_MODE;

/** Options for one setup run; paths are absolute and resolved by the entry. */
export interface RunSetupOptions {
  readonly runner: GcloudRunner;
  /** Validates the user access token through tokeninfo (Drive scope check). */
  readonly validateToken: TokenValidator;
  /** Builds the human-token Sheets/Drive API for a run. */
  readonly createHumanApi: HumanSheetApiFactory;
  /** Verifies the service-account key can read the spreadsheet (with retries). */
  readonly verifySaAccess: SaAccessVerifier;
  /** Existing project id, or undefined to create `hikoutei-<slug>`. */
  readonly projectId: string | undefined;
  readonly saName: string;
  /** Spreadsheet title override; defaults to `hikoutei-sync-<project>`. */
  readonly spreadsheetTitle: string | undefined;
  /** Absolute service-account key path. */
  readonly keyPath: string;
  /** Absolute .env output path. */
  readonly outputPath: string;
  /** Absolute setup checkpoint path (`.hikoutei-setup-state.json`). */
  readonly statePath: string;
  readonly dryRun: boolean;
  /**
   * Service accounts to provision as a credential pool. Defaults to 1
   * (single-SA behavior, unchanged); N > 1 provisions `<saName>-<i>`
   * accounts after the primary flow, sharing the same spreadsheet and
   * recorded in `HIKOUTEI_SYNC_CREDENTIALS`. Values outside 1..10 are an
   * `invalid_args` usage error. Resuming with a smaller count keeps every
   * existing pool entry (the pool never shrinks); the summary reports the
   * actual pool size.
   */
  readonly saCount?: number;
  /**
   * Optional progress sink for the CLI renderer. When omitted the run is
   * unaffected; when present a throwing callback is swallowed so progress
   * can never change the setup result, the mutation order, or the exit
   * code. Internal CLI machinery only — never part of the public API.
   */
  readonly progress?: SetupProgressSink;
  /** Filesystem operations for the exclusive setup lock; injectable for tests. */
  readonly lockFs?: LockFs;
  /** Platform of the run; defaults to `process.platform`. A non-dry-run on
   * `win32` is refused with `unsupported_platform` before any subprocess,
   * network, cloud, lock, checkpoint, key, or env mutation (Windows cannot
   * guarantee no-follow or owner-only ACL semantics); dry runs remain pure
   * on every platform. Injectable so tests can exercise the gate on macOS.
   */
  readonly platform?: string;
  /**
   * Timer for the bounded key-settlement propagation poll; defaults to a
   * real `setTimeout` sleeper so production actually waits. Injectable so
   * tests are instant.
   */
  readonly sleeper?: Sleeper;
}

/** One planned or executed step of the setup flow. */
export type { PlannedCommand } from "./flowResult.js";

/** The error branch of a setup result. */
export type { SetupErrorResult } from "./flowResult.js";

/** Outcome summary returned for a successful (non-dry-run) setup. */
export interface SetupSummary {
  readonly projectId: string;
  /** Human account that owns the spreadsheet (from the validated token). */
  readonly ownerEmail: string;
  readonly serviceAccountEmail: string;
  readonly keyPath: string;
  readonly spreadsheetId: string;
  readonly spreadsheetUrl: string;
  readonly spreadsheetTitle: string;
  readonly outputPath: string;
  /** Absolute checkpoint path; status reflects the persisted progression. */
  readonly statePath: string;
  readonly stateStatus: string;
  readonly envFileCreated: boolean;
  readonly envFileModified: boolean;
  readonly projectReused: boolean;
  readonly serviceAccountReused: boolean;
  readonly keyReused: boolean;
  /** How the SA writer permission was ensured; `unchanged` when resumed past sharing. */
  readonly saWriterRole: ShareOutcome["writerRole"] | "unchanged";
  /** True when this run resumed from an existing checkpoint. */
  readonly resumed: boolean;
  /** Provisioned pool size (1 for single-SA runs). */
  readonly poolSize: number;
  /** Key paths of the provisioned pool, entry 1 first ([keyPath] for N=1). */
  readonly poolPaths: readonly string[];
  /**
   * Pool entries kept from a previous run (absent/0 for fresh runs and
   * N=1). A resume never removes entries, so resuming with a smaller
   * `--sa-count` reports the actual (larger) pool with this kept count.
   */
  readonly poolKeptEntries?: number;
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
  | SetupErrorResult;

const AUTH_LIST_ARGS = ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"] as const;

/** gcloud error text that signals an already-existing project on create. */
const PROJECT_ALREADY_EXISTS_MARKER = "already exists";

/** gcloud error text that signals a missing project on describe (classified internally, never surfaced). */
const PROJECT_NOT_FOUND_MARKER = "not found";

/** Default spreadsheet title for a project. */
export function defaultSpreadsheetTitle(projectId: string): string {
  return `${DEFAULT_SPREADSHEET_TITLE_PREFIX}-${projectId}`;
}

/**
 * Setup phases a checkpoint status guarantees as already complete.
 *
 * Resume semantics: `project_selected` guarantees nothing (the project is
 * only decided, not yet verified), and the in-progress write-ahead states
 * (`key_create_started`, `spreadsheet_create_started`,
 * `spreadsheet_share_started`) guarantee everything BEFORE the phase they
 * started but not the phase itself. The cloud-auth and Drive-access phases
 * are NEVER checkpoint-complete — every run re-runs them fresh — and the
 * output phase is never checkpoint-complete because the `.env` write runs
 * on every successful run (even a `complete` resume rewrites `.env`).
 */
function checkpointCompletedPhases(status: SetupState["status"]): readonly SetupProgressPhase[] {
  switch (status) {
    case "project_selected":
      return [];
    case "key_create_started":
      return ["project", "apis", "service_account"];
    case "key_ready":
    case "spreadsheet_create_started":
      return ["project", "apis", "service_account", "service_account_key"];
    case "spreadsheet_created":
    case "spreadsheet_share_started":
      return ["project", "apis", "service_account", "service_account_key", "spreadsheet"];
    case "spreadsheet_shared":
      return ["project", "apis", "service_account", "service_account_key", "spreadsheet", "share"];
    case "complete":
      return [
        "project",
        "apis",
        "service_account",
        "service_account_key",
        "spreadsheet",
        "share",
        "sa_access",
      ];
  }
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
 * Pure: does not execute anything and performs no filesystem mutation — no
 * subprocess, network, or cloud calls, and no lock/checkpoint/key/.env
 * writes. The caller has already run the read-only reserved-path collision
 * resolution before planning, so a dry run may perform read-only local
 * path-safety checks but never reads checkpoint or key file contents.
 * Each step carries a simulated outcome so `--dry-run` previews the scope
 * check, the exclusive setup lock, both API enables, the marker write-ahead
 * and human-owned sheet creation, SA share/verify, checkpoint, and .env
 * write.
 */
export function planSetupCommands(options: RunSetupOptions, slug: string): readonly PlannedCommand[] {
  const projectId = options.projectId ?? slug;
  const email = serviceAccountEmail(options.saName, projectId);
  const title = options.spreadsheetTitle ?? defaultSpreadsheetTitle(projectId);
  const lockPath = setupLockPath(options.statePath);
  const commands: PlannedCommand[] = [
    { kind: "gcloud", command: ["--version"], outcome: "gcloud is installed" },
    { kind: "gcloud", command: [...AUTH_LIST_ARGS], outcome: "an active account is logged in" },
    {
      kind: "gcloud",
      command: ["auth", "print-access-token"],
      outcome: "user access token retrieved (kept in memory only)",
    },
    {
      kind: "api",
      label: "POST oauth2.googleapis.com/tokeninfo",
      outcome: "Drive scope verified for the active account",
    },
    {
      kind: "file",
      label: `acquire exclusive setup lock ${lockPath}`,
      outcome:
        "held through setup; released on every exit (an existing lock directory is never removed automatically; a crash leaves it for manual removal)",
    },
  ];
  if (options.projectId !== undefined) {
    commands.push({
      kind: "gcloud",
      command: ["projects", "describe", options.projectId],
      outcome: "project verified (an explicit project is never created)",
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
      command: ["services", "enable", "sheets.googleapis.com", "drive.googleapis.com", "--project", projectId],
      outcome: "Sheets and Drive APIs enabled (idempotent)",
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
        "list",
        "--managed-by=user",
        "--format=value(name)",
        "--iam-account",
        email,
        "--project",
        projectId,
      ],
      outcome:
        "pre-existing user-managed keys recorded as a write-ahead baseline (persisted as key_create_started before any key create; only the invocation that just persisted it may issue the one create; a crashed run reconciles the staged/final key against the current list, polls the key list plus staged/final evidence through a bounded window on reconcile-only resumes, and never creates a duplicate key)",
    },
    {
      kind: "gcloud",
      command: [
        "iam",
        "service-accounts",
        "keys",
        "create",
        KEY_STAGE_PLACEHOLDER,
        "--iam-account",
        email,
        "--project",
        projectId,
      ],
      outcome:
        `key created in a private staging directory (shown as a per-run placeholder), validated there ` +
        `(JSON/RSA/project/email), and installed atomically at ${options.keyPath} with owner-only mode 600; ` +
        `the staged link is removed only after the install is verified (reused when the file already exists). ` +
        `Only the invocation that just persisted the key_create_started checkpoint issues this one create; ` +
        `resumed runs are reconcile-only and poll key list + staged/final evidence (2, 4, 8, 16, 30, 30, 30 s) ` +
        `before failing with key_create_uncertain — the create is never retried automatically and an unmatched ` +
        `cloud key is never deleted`,
    },
    {
      kind: "file",
      label: `checkpoint ${options.statePath}`,
      outcome:
        "status key_create_started persisted before the key create, key_ready right after the key is secured, " +
        "and spreadsheet_share_started before the SA writer permission is ensured (never key material; the " +
        "non-secret keyOrigin and shareOrigin discriminants are persisted from key_ready/spreadsheet_shared " +
        "onward so a resumed run keeps verify freshness)",
    },
    {
      kind: "api",
      label: `drive.files.create (title "${title}", mime ${SPREADSHEET_MIME_TYPE}, private appProperties creation marker) with the active user token`,
      outcome: "creation marker persisted as spreadsheet_create_started before the single create attempt",
    },
    {
      kind: "api",
      label: `drive.permissions: share ${email} as writer`,
      outcome:
        "writer role reused, upgraded, or created without a notification email (a spreadsheet_share_started " +
        "checkpoint is persisted before the permission mutation and spreadsheet_shared after it, so a crash " +
        "between them resumes the idempotent ensure and never creates a second spreadsheet)",
    },
    {
      kind: "api",
      label: "drive.files.get ownership check",
      outcome: "active user is owner and the service account is a writer",
    },
    {
      kind: "api",
      label: `spreadsheets.get with the ${email} key`,
      outcome: "service-account access verified (retried on transient propagation)",
    },
    {
      kind: "file",
      label: `write ${options.statePath}`,
      outcome: "setup checkpoint persisted atomically with mode 600; never contains tokens or keys",
    },
    {
      kind: "file",
      label: `write ${options.outputPath}`,
      outcome:
        "GOOGLE_APPLICATION_CREDENTIALS and HIKOUTEI_SYNC_SPREADSHEET_URL set; unrelated lines preserved; written atomically via a private temp file + rename, never through a symlink alias",
    },
    {
      kind: "file",
      label: `release setup lock ${lockPath}`,
      outcome: "released",
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

/** Renders the human summary; never includes key contents or tokens. */
export function formatSummary(summary: SetupSummary): string {
  const envState = summary.envFileCreated
    ? "created"
    : summary.envFileModified
      ? "updated"
      : "unchanged";
  const lines = [
    "Hikoutei setup complete.",
    `  project:              ${summary.projectId} (${summary.projectReused ? "reused" : "created"})`,
    `  human owner:          ${summary.ownerEmail}`,
    `  service account:      ${summary.serviceAccountEmail} (${summary.serviceAccountReused ? "reused" : "created"})`,
    `  service account key:  ${summary.keyPath} (${summary.keyReused ? "reused" : "created"})`,
    `  SA writer role:       ${summary.saWriterRole}`,
    `  spreadsheet:          ${summary.spreadsheetTitle} (${summary.spreadsheetId})`,
    `  spreadsheet URL:      ${summary.spreadsheetUrl}`,
    `  checkpoint:           ${summary.statePath} (${summary.stateStatus}${summary.resumed ? ", resumed" : ""})`,
    `  env file:             ${summary.outputPath} (${envState})`,
  ];
  // Pool lines appear only for multi-SA runs, so N=1 output is unchanged.
  if (summary.poolSize > 1) {
    const kept = summary.poolKeptEntries ?? 0;
    lines.push(
      `  credential pool:      ${summary.poolSize} service accounts${kept > 0 ? ` (kept: ${kept} existing)` : ""}`,
      `  credential pool keys: ${summary.poolPaths.join(",")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Runs the full setup bootstrap.
 *
 * In dry-run mode returns the command plan after the read-only reserved-path
 * collision resolution, without invoking the runner or mutating the
 * filesystem: no subprocess, network, or cloud calls, and no lock,
 * checkpoint, key, or .env writes. Otherwise the sequence is: path collision
 * check (rejects `--output` aliasing the key/checkpoint/temp/lock paths
 * before anything runs), preflight (gcloud present, active account), human
 * auth (Drive scope verified through tokeninfo, memory-only token), exclusive
 * setup lock (held until every exit), checkpoint load (resume skips
 * completed work; mismatches fail with `setup_state_conflict`), project
 * verify/create (checkpoint persisted before creation; an explicit project
 * is never created, a resumed generated project is described first and
 * created only when confirmed absent), `config set project`, enable the
 * Sheets and Drive APIs, service account list/create, staged key create
 * (gcloud writes a private sibling staging path, the staged key is
 * validated there and atomically hard-linked to the final path with mode
 * 600; an existing validated key is reused; only the invocation that just
 * persisted the fresh key_create_started checkpoint may create — resumed
 * key states are reconcile-only and poll through a bounded propagation
 * window before key_create_uncertain), marker write-ahead + human-owned
 * spreadsheet creation (the creation marker is persisted as
 * `spreadsheet_create_started` BEFORE the single create attempt; a lost
 * response is reconciled by querying Drive for that marker and a second
 * create is never attempted), SA writer share + Drive ownership verification
 * (a `spreadsheet_share_started` write-ahead is persisted before the
 * idempotent permission ensure and `spreadsheet_shared` after it),
 * SA-key access verification with retries (propagation retries only for
 * resources created this run, tracked by the persisted keyOrigin and
 * shareOrigin discriminants), the .env write, and finally the `complete`
 * checkpoint. Every phase maps to a stable error code on failure; key
 * material and the access token are never included in messages.
 */
export async function runSetup(options: RunSetupOptions): Promise<SetupResult> {
  // The current run's identifiers are validated against the canonical GCP
  // formats BEFORE any subprocess, API call, or file mutation: an
  // option-like or malformed `--project`/`--sa-name` (for example
  // `--project=--flag`) is rejected at the runtime boundary too, not only
  // by the CLI parser, so no caller can ever reach gcloud or the
  // filesystem with an invalid identifier.
  if (options.projectId !== undefined && !isValidGcpProjectId(options.projectId)) {
    return errorResult(
      SETUP_ERROR_CODES.INVALID_ARGS,
      `invalid --project value: GCP project ids must start with a lowercase letter and contain ` +
        `only lowercase letters, digits, and hyphens (6-30 characters)`,
    );
  }
  if (!isValidServiceAccountName(options.saName)) {
    return errorResult(
      SETUP_ERROR_CODES.INVALID_ARGS,
      `invalid --sa-name value: service-account names must start with a lowercase letter and ` +
        `contain only lowercase letters, digits, and hyphens (6-30 characters)`,
    );
  }
  // Fail closed on a programmatic out-of-range pool size (the CLI parser
  // already enforces 1..10): the pool expansion below trusts this bound.
  if (
    options.saCount !== undefined &&
    (!Number.isSafeInteger(options.saCount) || options.saCount < 1 || options.saCount > MAX_SETUP_SA_COUNT)
  ) {
    return errorResult(
      SETUP_ERROR_CODES.INVALID_ARGS,
      `invalid sa-count value: expected a positive integer between 1 and ${MAX_SETUP_SA_COUNT}`,
    );
  }
  // Reject canonical path collisions before anything else runs: `--output`
  // must never alias the key, checkpoint, checkpoint temp, or lock path, and
  // the key must never alias the checkpoint, temp, or lock. This is a usage
  // error, not a runtime failure.
  const collision = findSetupPathCollision({
    keyPath: options.keyPath,
    outputPath: options.outputPath,
    statePath: options.statePath,
  });
  if (collision.status === "collision") {
    return errorResult(SETUP_ERROR_CODES.INVALID_ARGS, collision.message);
  }

  if (options.dryRun) {
    return {
      status: "ok",
      dryRun: true,
      commands: planSetupCommands(options, options.projectId ?? generateProjectId()),
    };
  }

  // Platform gate: Windows cannot guarantee no-follow opens or owner-only
  // ACLs, so automatic setup is refused BEFORE any subprocess, network,
  // cloud, lock, checkpoint, key, or env mutation. Dry runs remain pure on
  // every platform and are not gated.
  if ((options.platform ?? process.platform) === "win32") {
    return errorResult(
      SETUP_ERROR_CODES.UNSUPPORTED_PLATFORM,
      "automatic hikoutei setup currently runs on macOS and Linux only; on Windows, set up the " +
        "project, service account, key, and spreadsheet manually (Google Cloud console + a shared " +
        "spreadsheet) and set GOOGLE_APPLICATION_CREDENTIALS and HIKOUTEI_SYNC_SPREADSHEET_URL " +
        "yourself",
    );
  }

  const executed: PlannedCommand[] = [];
  // Every gcloud invocation of the flow goes through the safe runner: a
  // throwing invocation becomes a sanitized failed result so each phase
  // maps it to its stable code and arbitrary thrown text (which may carry
  // secrets) never reaches a message or the CLI `unexpected` handler.
  const runner = createSafeRunner(options.runner);
  const keySleeper = options.sleeper ?? realSleeper;
  // The progress sink is swallowed-safe: an absent sink or a throwing
  // renderer callback never affects the setup result or mutation order.
  const progress = safeProgressSink(options.progress);

  // Preflight: gcloud must exist and an active account must be logged in.
  progress.report({ type: "phase_started", phase: "cloud_auth" });
  progress.report({ type: "operation_started", phase: "cloud_auth", operation: SETUP_PROGRESS_OPERATIONS.GCLOUD_PRESENCE });
  const version = await runner.run(["--version"]);
  progress.report({ type: "operation_completed", phase: "cloud_auth", operation: SETUP_PROGRESS_OPERATIONS.GCLOUD_PRESENCE });
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

  progress.report({ type: "operation_started", phase: "cloud_auth", operation: SETUP_PROGRESS_OPERATIONS.ACTIVE_ACCOUNT });
  const auth = await runner.run([...AUTH_LIST_ARGS]);
  progress.report({ type: "operation_completed", phase: "cloud_auth", operation: SETUP_PROGRESS_OPERATIONS.ACTIVE_ACCOUNT });
  executed.push({ kind: "gcloud", command: [...AUTH_LIST_ARGS], outcome: outcomeOf(auth, "active account found") });
  if (auth.status !== "ok") {
    // Both auth-list failure branches (invocation failure here, empty list
    // below) must point non-interactive/CI/non-TTY users at the exact
    // Drive-enabled re-login command, never the bare `gcloud auth login`.
    // Only a missing gcloud binary keeps the install guidance; everything
    // else is an account problem a Drive-enabled login fixes. The failure
    // description is status-only: raw stdout/stderr (which can carry tokens)
    // is never forwarded.
    const failure = describeGcloudFailure(auth);
    const guidance =
      auth.status === "not_found"
        ? "install it from https://cloud.google.com/sdk and try again"
        : `run \`gcloud ${DRIVE_ACCESS_COMMAND.join(" ")}\` and try again`;
    return errorResult(
      SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN,
      `could not list active gcloud accounts: ${failure}; ${guidance}`,
    );
  }
  if (auth.stdout.trim() === "") {
    return errorResult(
      SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN,
      // Reuse the shared exact re-login command so non-interactive/CI/non-TTY
      // guidance matches the Drive-scope guidance (docs/policy require the
      // Drive-enabled login, never the bare `gcloud auth login`).
      `no active gcloud account; run \`gcloud ${DRIVE_ACCESS_COMMAND.join(" ")}\` and try again`,
    );
  }
  progress.report({ type: "phase_completed", phase: "cloud_auth", source: "run" });

  // Human auth: retrieve the user token and require Drive scope BEFORE any
  // cloud or file mutation. The token stays in memory for this run only.
  progress.report({ type: "phase_started", phase: "drive_access" });
  progress.report({ type: "operation_started", phase: "drive_access", operation: SETUP_PROGRESS_OPERATIONS.DRIVE_SCOPE });
  const human = await checkHumanDriveAccess(runner, options.validateToken);
  progress.report({ type: "operation_completed", phase: "drive_access", operation: SETUP_PROGRESS_OPERATIONS.DRIVE_SCOPE });
  executed.push({
    kind: "gcloud",
    command: ["auth", "print-access-token"],
    outcome: human.status === "ok" ? "Drive scope verified for the active account" : "failed",
  });
  if (human.status === "error") {
    return errorResult(human.code, human.message);
  }
  executed.push({
    kind: "api",
    label: "POST oauth2.googleapis.com/tokeninfo",
    outcome: `access token valid for ${human.ownerEmail} (memory only)`,
  });
  progress.report({ type: "phase_completed", phase: "drive_access", source: "run" });

  // Exclusive setup lock: acquired after the human preflight, before any
  // checkpoint/cloud/file mutation, and released on every exit (success,
  // error, or throw). An existing lock entry — file, directory, or symlink —
  // is never removed or replaced automatically; the run fails without
  // mutating anything.
  const lockPath = setupLockPath(options.statePath);
  const lock = acquireSetupLock(lockPath, options.lockFs);
  if (lock.status === "busy") {
    return errorResult(SETUP_ERROR_CODES.SETUP_IN_PROGRESS, lock.message);
  }
  if (lock.status === "failed") {
    // A filesystem failure other than EEXIST (EACCES, ENOENT, ...) is a
    // distinct lock failure, never a busy/setup_in_progress verdict.
    return errorResult(SETUP_ERROR_CODES.SETUP_LOCK_FAILED, lock.message);
  }
  try {
    return await runSetupLocked(options, executed, human, runner, keySleeper, progress);
  } finally {
    releaseSetupLock(lockPath, lock.identity, options.lockFs);
  }
}

/**
 * The locked body of the setup run.
 *
 * Runs with the exclusive setup lock held; every return path releases the
 * lock in `runSetup`'s `finally`. See `runSetup` for the full sequence.
 * `runner` is the safe-wrapped runner and `keySleeper` the propagation
 * poll timer established by `runSetup`.
 */
async function runSetupLocked(
  options: RunSetupOptions,
  executed: PlannedCommand[],
  human: HumanAuthResult & { readonly status: "ok" },
  runner: GcloudRunner,
  keySleeper: Sleeper,
  progress: SetupProgressSink,
): Promise<SetupResult> {
  const accessToken = human.accessToken;
  const ownerEmail = human.ownerEmail;

  // Checkpoint: load and validate; resume skips completed work, mismatched
  // owner/options/key metadata fails before any mutation.
  const checkpointResult = loadSetupState(options.statePath);
  if (checkpointResult.status === "invalid") {
    return errorResult(SETUP_ERROR_CODES.SETUP_STATE_INVALID, checkpointResult.message);
  }
  const checkpoint = checkpointResult.status === "loaded" ? checkpointResult.state : undefined;

  // Report the resume context once: the phases a checkpoint guarantees as
  // already complete. cloud_auth and drive_access are never
  // checkpoint-complete (every run re-runs them fresh), and the output phase
  // is never checkpoint-complete (the .env write runs on every success).
  if (checkpoint !== undefined) {
    progress.report({
      type: "resumed",
      completedFromCheckpoint: checkpointCompletedPhases(checkpoint.status),
    });
  }

  // Key file: on resume it must exist and match the checkpoint once the
  // key phase was reached (key_ready and later); a `key_create_started`
  // checkpoint defers key handling to the reconciliation step because the
  // final key may legitimately not exist yet. Without a checkpoint an
  // existing key must match an explicit --project, otherwise setup fails
  // before creating a new project. Existing keys are read through the
  // secure descriptor boundary, which enforces owner-only mode 0600 (a
  // 0644 reused key is corrected), refuses symlinks and non-regular files,
  // and never exposes key material.
  let keyReused = false;
  if (checkpoint !== undefined) {
    const compatibility = checkStateCompatibility(checkpoint, {
      projectId: options.projectId,
      saName: options.saName,
      spreadsheetTitle: options.spreadsheetTitle,
      keyPath: options.keyPath,
      ownerEmail,
    });
    if (compatibility.status === "conflict") {
      return errorResult(SETUP_ERROR_CODES.SETUP_STATE_CONFLICT, compatibility.message);
    }
    if (checkpoint.status !== "key_create_started") {
      const keyResult = readServiceAccountKeySecurely(options.keyPath);
      if (keyResult.status === "invalid") {
        return errorResult(SETUP_ERROR_CODES.SETUP_STATE_INVALID, keyResult.message);
      }
      if (keyResult.status === "ok") {
        // Compare against the COMPUTED expected email (derived from the
        // checkpoint's own saName/projectId), never against an
        // attacker-controlled stored saEmail field.
        const expectedEmail = serviceAccountEmail(checkpoint.saName, checkpoint.projectId);
        if (
          keyResult.metadata.projectId !== checkpoint.projectId ||
          keyResult.metadata.clientEmail !== expectedEmail
        ) {
          return errorResult(
            SETUP_ERROR_CODES.SETUP_STATE_CONFLICT,
            `the key file ${options.keyPath} belongs to ${keyResult.metadata.clientEmail} ` +
              `(project ${keyResult.metadata.projectId}); the setup state expects ` +
              `${expectedEmail} in project ${checkpoint.projectId}`,
          );
        }
        keyReused = true;
      } else if (checkpoint.status !== "project_selected") {
        // The key phase was already reached in a previous run; the key file
        // cannot disappear between runs.
        return errorResult(
          SETUP_ERROR_CODES.SETUP_STATE_INVALID,
          `the key file ${options.keyPath} recorded in the setup state is missing`,
        );
      }
    }
  } else {
    const keyResult = readServiceAccountKeySecurely(options.keyPath);
    if (keyResult.status === "invalid") {
      return errorResult(SETUP_ERROR_CODES.SETUP_STATE_INVALID, keyResult.message);
    }
    if (keyResult.status === "ok") {
      if (options.projectId === undefined) {
        return errorResult(
          SETUP_ERROR_CODES.SETUP_STATE_CONFLICT,
          `a key file exists at ${options.keyPath} but no setup state and no --project ` +
            `were given; pass --project <id> or remove the key file to start fresh`,
        );
      }
      const expectedEmail = serviceAccountEmail(options.saName, options.projectId);
      if (
        keyResult.metadata.projectId !== options.projectId ||
        keyResult.metadata.clientEmail !== expectedEmail
      ) {
        return errorResult(
          SETUP_ERROR_CODES.SETUP_STATE_CONFLICT,
          `the key file ${options.keyPath} belongs to ${keyResult.metadata.clientEmail} ` +
            `(project ${keyResult.metadata.projectId}); expected ${expectedEmail} in project ` +
            `${options.projectId}`,
        );
      }
      keyReused = true;
    }
  }

  // Project: resume the checkpoint project, verify an explicit one, or create
  // `hikoutei-<slug>` idempotently (checkpoint persisted before creation).
  // The EFFECTIVE mode is `explicit` whenever the current invocation supplies
  // `--project` (a matching one passed the compatibility check above): an
  // explicit option is recovery intent, never permission to create, so even a
  // generated-mode checkpoint resumed with a matching `--project` is
  // describe-only and NEVER creates. The STORED mode is preserved for
  // checkpoint history; only the effective mode governs this invocation.
  const projectMode: ProjectMode =
    options.projectId !== undefined ? "explicit" : (checkpoint?.projectMode ?? "generated");
  const persistProjectMode: ProjectMode = checkpoint?.projectMode ?? projectMode;
  const needsProjectPhase = checkpoint === undefined || checkpoint.status === "project_selected";
  let projectId: string;
  let projectReused = false;
  if (needsProjectPhase) {
    progress.report({ type: "phase_started", phase: "project" });
  }
  if (!needsProjectPhase) {
    projectId = checkpoint.projectId;
    // Resuming past project selection: the project was decided (and created
    // or verified) by an earlier run, so this run reused it.
    projectReused = true;
  } else if (projectMode === "explicit") {
    const requested = checkpoint?.projectId ?? options.projectId;
    if (requested === undefined) {
      return errorResult(
        SETUP_ERROR_CODES.PROJECT_NOT_FOUND,
        "no project id is available for this setup run; pass --project <id>",
      );
    }
    progress.report({ type: "operation_started", phase: "project", operation: SETUP_PROGRESS_OPERATIONS.PROJECT_VERIFY });
    const describe = await runner.run(["projects", "describe", requested]);
    progress.report({ type: "operation_completed", phase: "project", operation: SETUP_PROGRESS_OPERATIONS.PROJECT_VERIFY });
    executed.push({
      kind: "gcloud",
      command: ["projects", "describe", requested],
      outcome: outcomeOf(describe, "project verified"),
    });
    if (describe.status !== "ok") {
      // A matching --project is recovery intent only: when the describe
      // cannot confirm the project (missing or denied), setup fails with
      // project_not_found and never calls projects create.
      return errorResult(
        SETUP_ERROR_CODES.PROJECT_NOT_FOUND,
        `project "${requested}" could not be verified: ${describeGcloudFailure(describe)}`,
      );
    }
    projectId = requested;
    // An explicit project verified by describe exists and was never created
    // by this run: it is reused.
    projectReused = true;
    if (checkpoint === undefined) {
      const saveError = persistState(
        options,
        executed,
        projectState(options, projectId, ownerEmail, titleOf(options, projectId, undefined), "explicit"),
      );
      if (saveError !== null) {
        return saveError;
      }
    }
  } else {
    projectId = checkpoint?.projectId ?? generateProjectId();
    if (checkpoint === undefined) {
      // Persist the decided id BEFORE creation so a crash mid-create resumes
      // the same project instead of creating a second one.
      const saveError = persistState(
        options,
        executed,
        projectState(options, projectId, ownerEmail, titleOf(options, projectId, undefined), "generated"),
      );
      if (saveError !== null) {
        return saveError;
      }
      progress.report({ type: "operation_started", phase: "project", operation: SETUP_PROGRESS_OPERATIONS.PROJECT_CREATE });
      const createOutcome = await createProjectOnce(runner, executed, projectId);
      progress.report({ type: "operation_completed", phase: "project", operation: SETUP_PROGRESS_OPERATIONS.PROJECT_CREATE });
      if (createOutcome.status === "error") {
        return createOutcome.error;
      }
      projectReused = createOutcome.reused;
    } else {
      // Resume of a generated project (reached only when this invocation
      // supplies no explicit --project): describe first; reuse when present;
      // create only when the describe confirms the project is absent. With a
      // matching --project the effective mode is explicit, so this branch
      // never runs for it and projects create is never called.
      progress.report({ type: "operation_started", phase: "project", operation: SETUP_PROGRESS_OPERATIONS.PROJECT_VERIFY });
      const describe = await runner.run(["projects", "describe", projectId]);
      progress.report({ type: "operation_completed", phase: "project", operation: SETUP_PROGRESS_OPERATIONS.PROJECT_VERIFY });
      executed.push({
        kind: "gcloud",
        command: ["projects", "describe", projectId],
        outcome: outcomeOf(describe, "project state determined"),
      });
      if (describe.status === "ok") {
        projectReused = true;
      } else if (describe.status === "failed" && describe.stderr.includes(PROJECT_NOT_FOUND_MARKER)) {
        progress.report({ type: "operation_started", phase: "project", operation: SETUP_PROGRESS_OPERATIONS.PROJECT_CREATE });
        const createOutcome = await createProjectOnce(runner, executed, projectId);
        progress.report({ type: "operation_completed", phase: "project", operation: SETUP_PROGRESS_OPERATIONS.PROJECT_CREATE });
        if (createOutcome.status === "error") {
          return createOutcome.error;
        }
        projectReused = createOutcome.reused;
      } else {
        return errorResult(
          SETUP_ERROR_CODES.PROJECT_CREATE_FAILED,
          `could not determine whether project "${projectId}" exists: ${describeGcloudFailure(describe)}`,
        );
      }
    }
  }

  // The spreadsheet title comes from the checkpoint when resuming (an
  // explicit --spreadsheet-title still wins and conflicting values were
  // already rejected by checkStateCompatibility).
  const title = titleOf(options, projectId, checkpoint);
  const email = serviceAccountEmail(options.saName, projectId);
  let serviceAccountReused = false;

  if (needsProjectPhase) {
    progress.report({ type: "operation_started", phase: "project", operation: SETUP_PROGRESS_OPERATIONS.PROJECT_SELECT });
    const configSet = await runner.run(["config", "set", "project", projectId]);
    progress.report({ type: "operation_completed", phase: "project", operation: SETUP_PROGRESS_OPERATIONS.PROJECT_SELECT });
    executed.push({
      kind: "gcloud",
      command: ["config", "set", "project", projectId],
      outcome: outcomeOf(configSet, "default project selected"),
    });
    if (configSet.status !== "ok") {
      return errorResult(
        SETUP_ERROR_CODES.PROJECT_SELECT_FAILED,
        `could not select project "${projectId}": ${describeGcloudFailure(configSet)}`,
      );
    }
    progress.report({ type: "phase_completed", phase: "project", source: "run" });
    progress.report({ type: "phase_started", phase: "apis" });

    progress.report({ type: "operation_started", phase: "apis", operation: SETUP_PROGRESS_OPERATIONS.API_ENABLE });
    const enable = await runner.run([
      "services",
      "enable",
      "sheets.googleapis.com",
      "drive.googleapis.com",
      "--project",
      projectId,
    ]);
    progress.report({ type: "operation_completed", phase: "apis", operation: SETUP_PROGRESS_OPERATIONS.API_ENABLE });
    executed.push({
      kind: "gcloud",
      command: ["services", "enable", "sheets.googleapis.com", "drive.googleapis.com", "--project", projectId],
      outcome: outcomeOf(enable, "Sheets and Drive APIs enabled"),
    });
    if (enable.status !== "ok") {
      return errorResult(
        SETUP_ERROR_CODES.API_ENABLE_FAILED,
        `could not enable sheets.googleapis.com and drive.googleapis.com: ${describeGcloudFailure(enable)}`,
      );
    }
    progress.report({ type: "phase_completed", phase: "apis", source: "run" });
    progress.report({ type: "phase_started", phase: "service_account" });

    // Service account: reuse by email when it already exists.
    const ensured = await ensureServiceAccount(runner, executed, progress, "service_account", {
      projectId,
      saName: options.saName,
      saEmail: email,
    });
    if (ensured.status === "error") {
      return ensured.error;
    }
    serviceAccountReused = ensured.reused;
    progress.report({ type: "phase_completed", phase: "service_account", source: "run" });
  }

  // Key: reuse an existing validated key file, or run the write-ahead
  // create. `key_create_started` resumes by RECONCILING only — the
  // deterministic staged and/or final key is checked against the current
  // user-managed key list and the outcome is polled through the bounded
  // propagation window; a resumed state NEVER creates (an unmatched
  // post-baseline key fails with `key_create_uncertain`; see
  // keyProvision.ts). A fresh or
  // `project_selected` run records the baseline and key marker as
  // `key_create_started`, then creates only at the deterministic staging
  // path. Every path persists `key_ready` immediately after the key is
  // secured, before the spreadsheet phase; spreadsheet statuses imply key
  // readiness. The key phase only EXECUTES WORK when a key must be
  // created or reconciled this run; a resume past `key_ready` already
  // validated and reused the key (marked complete by the resume event).
  // Progress-wise the phase REPORTS on every run the checkpoint does not
  // already guarantee as complete (a key_ready-or-later status does): a
  // fresh run or a `project_selected` resume that reuses an existing key
  // performs no settle/create work, but the phase still starts and
  // completes so the validating tracker keeps phase order and the later
  // phases stay visible. Emitting these events for a checkpoint-guaranteed
  // key phase would be rejected by the tracker and must never double-count
  // it, so the two flags are deliberately separate.
  const keyPhaseGuaranteedByCheckpoint =
    checkpoint !== undefined &&
    checkpoint.status !== "project_selected" &&
    checkpoint.status !== "key_create_started";
  const keyPhaseReports = !keyPhaseGuaranteedByCheckpoint;
  const keyWorkRuns = checkpoint?.status === "key_create_started" || !keyReused;
  const keySettleReporter = boundedCheckReporter(progress, "service_account_key", "key_settlement");
  if (keyPhaseReports) {
    progress.report({ type: "phase_started", phase: "service_account_key" });
  }
  if (keyWorkRuns) {
    if (checkpoint?.status === "key_create_started") {
      // A resumed checkpoint is RECONCILE-ONLY: the create was already issued
      // (or not) by the run that persisted it, so this invocation must never
      // create, even when no stage/final/delta is visible; it polls through
      // the bounded propagation window instead (see keyProvision.ts).
      const settled = await settleServiceAccountKey(runner, executed, {
        keyPath: options.keyPath,
        projectId,
        saEmail: email,
        keyMarker: checkpoint.keyMarker,
        baseline: checkpoint.keyBaseline,
        createPermission: "reconcile",
        sleeper: keySleeper,
        onSettleProgress: keySettleReporter,
      });
      if (settled.status === "error") {
        return settled.error;
      }
      keyReused = settled.keyReused;
    } else {
      // Fresh (or project_selected resume without a key): this branch only
      // runs when the key was NOT reused (keyWorkRuns is true and the
      // checkpoint is not key_create_started).
      progress.report({ type: "operation_started", phase: "service_account_key", operation: SETUP_PROGRESS_OPERATIONS.KEY_LIST });
      const keyList = await listUserManagedServiceAccountKeys(runner, executed, {
        projectId,
        saEmail: email,
        purpose: "baseline",
      });
      progress.report({ type: "operation_completed", phase: "service_account_key", operation: SETUP_PROGRESS_OPERATIONS.KEY_LIST });
      if (keyList.status === "error") {
        return keyList.error;
      }
      const keyMarker = generateCreationMarker();
      const saveError = persistState(
        options,
        executed,
        keyStartedState(options, projectId, ownerEmail, title, email, persistProjectMode, keyMarker, keyList.names),
      );
      if (saveError !== null) {
        return saveError;
      }
      // This invocation JUST persisted the fresh checkpoint, so it is the
      // only one allowed to issue the single key create (fresh permission).
      const settled = await settleServiceAccountKey(runner, executed, {
        keyPath: options.keyPath,
        projectId,
        saEmail: email,
        keyMarker,
        baseline: keyList.names,
        createPermission: "fresh",
        sleeper: keySleeper,
        onSettleProgress: keySettleReporter,
      });
      if (settled.status === "error") {
        return settled.error;
      }
      keyReused = settled.keyReused;
    }
  }
  // Key provenance for the verify phase: whether the key was CREATED by
  // the setup (vs reused from a pre-existing credential). The checkpoint
  // persists it from key_ready onward, so a key created by an earlier run
  // of the same setup keeps its propagation freshness across resumes (the
  // verify phase must still retry Invalid JWT Signature for it); a
  // pre-secure checkpoint or fresh run derives it from the settled
  // reuse verdict. This is deliberately separate from the summary's
  // `keyReused`, which stays a CURRENT-run fact (this run found an
  // existing key file) and never conflates reuse with propagation
  // evidence.
  let keyOrigin: KeyOrigin;
  if (
    checkpoint !== undefined &&
    checkpoint.status !== "project_selected" &&
    checkpoint.status !== "key_create_started"
  ) {
    keyOrigin = checkpoint.keyOrigin;
  } else {
    keyOrigin = keyReused ? "reused" : "created";
  }
  if (
    checkpoint === undefined ||
    checkpoint.status === "project_selected" ||
    checkpoint.status === "key_create_started"
  ) {
    const saveError = persistState(
      options,
      executed,
      keyReadyState(options, projectId, ownerEmail, title, email, persistProjectMode, keyOrigin),
    );
    if (saveError !== null) {
      return saveError;
    }
  }
  if (keyPhaseReports) {
    progress.report({ type: "phase_completed", phase: "service_account_key", source: "run" });
  }

  // Spreadsheet: generate a local opaque creation marker and persist it as
  // `spreadsheet_create_started` BEFORE the one and only remote create
  // attempt, which carries the marker as a private `appProperties` entry.
  // A lost response or failed create is reconciled by querying Drive for
  // that exact marker; a second create is never attempted from the started
  // state. Resuming a started state reconciles by marker only.
  const api = options.createHumanApi(accessToken);
  let spreadsheet: SpreadsheetCreateResult;
  // Spreadsheet phase reporting: a status from `spreadsheet_created`
  // onward is checkpoint-guaranteed complete (the `resumed` event already
  // marked it), so this run must NOT re-emit its start/completion — the
  // validating tracker would reject the duplicates and the count must
  // never double-count. `spreadsheet_create_started` (and every earlier
  // status) leaves the phase current: the create/reconcile work actually
  // runs there, so the phase still reports start/completion as a run
  // phase. Derived from the same checkpoint-phase list the `resumed`
  // event uses, so the reporting decision and the resume list can never
  // drift apart.
  const spreadsheetPhaseGuaranteedByCheckpoint =
    checkpoint !== undefined && checkpointCompletedPhases(checkpoint.status).includes("spreadsheet");
  const spreadsheetPhaseReports = !spreadsheetPhaseGuaranteedByCheckpoint;
  if (spreadsheetPhaseReports) {
    progress.report({ type: "phase_started", phase: "spreadsheet" });
  }
  // Spreadsheet statuses imply key readiness; `key_create_started` and
  // `key_ready` both start (or continue) spreadsheet creation from a fresh
  // marker. Only a spreadsheet status resumes by marker or by stored id.
  const resumeSpreadsheet =
    checkpoint !== undefined &&
    (checkpoint.status === "spreadsheet_create_started" ||
      checkpoint.status === "spreadsheet_created" ||
      checkpoint.status === "spreadsheet_share_started" ||
      checkpoint.status === "spreadsheet_shared" ||
      checkpoint.status === "complete");
  if (resumeSpreadsheet) {
    if (checkpoint.status === "spreadsheet_create_started") {
      progress.report({ type: "operation_started", phase: "spreadsheet", operation: SETUP_PROGRESS_OPERATIONS.SHEET_RECONCILE });
      const reconciled = await reconcileSpreadsheetByMarker(api, options, executed, {
        projectId,
        ownerEmail,
        saEmail: email,
        title,
        marker: checkpoint.creationMarker,
        projectMode: persistProjectMode,
        keyOrigin,
      });
      progress.report({ type: "operation_completed", phase: "spreadsheet", operation: SETUP_PROGRESS_OPERATIONS.SHEET_RECONCILE });
      if (reconciled.status === "error") {
        return reconciled.error;
      }
      spreadsheet = reconciled.spreadsheet;
    } else {
      spreadsheet = { spreadsheetId: checkpoint.spreadsheetId };
    }
  } else {
    const marker = generateCreationMarker();
    const saveError = persistState(
      options,
      executed,
      startedState(options, projectId, ownerEmail, title, email, persistProjectMode, marker, keyOrigin),
    );
    if (saveError !== null) {
      return saveError;
    }
    progress.report({ type: "operation_started", phase: "spreadsheet", operation: SETUP_PROGRESS_OPERATIONS.SHEET_CREATE });
    const ensured = await createSpreadsheetWithMarker(api, options, executed, {
      projectId,
      ownerEmail,
      saEmail: email,
      title,
      marker,
      projectMode: persistProjectMode,
      keyOrigin,
    });
    progress.report({ type: "operation_completed", phase: "spreadsheet", operation: SETUP_PROGRESS_OPERATIONS.SHEET_CREATE });
    if (ensured.status === "error") {
      return ensured.error;
    }
    spreadsheet = ensured.spreadsheet;
  }
  if (spreadsheetPhaseReports) {
    progress.report({ type: "phase_completed", phase: "spreadsheet", source: "run" });
  }

  // Share: ensure the service account is a writer and verify Drive metadata.
  // The share is a write-ahead: `spreadsheet_share_started` (spreadsheet id
  // + keyOrigin, no shareOrigin) is persisted BEFORE the idempotent ensure
  // can create/upgrade the permission, and `spreadsheet_shared` only after
  // the ensure completes — a crash between the remote permission mutation
  // and that write leaves the started state and resumes safely. A resume
  // that LOADED the started state reruns the idempotent ensure/ownership
  // verification (never a second spreadsheet) and conservatively persists
  // `shareOrigin: "fresh"` even when the replay reports reused, because
  // the prior attempt may have created/upgraded before crashing;
  // created/upgraded is always fresh. A false-positive fresh only adds
  // bounded 403/404 retries and is safe.
  let saWriterRole: ShareOutcome["writerRole"] | "unchanged" = "unchanged";
  const alreadyShared =
    checkpoint !== undefined &&
    (checkpoint.status === "spreadsheet_shared" || checkpoint.status === "complete");
  if (!alreadyShared) {
    progress.report({ type: "phase_started", phase: "share" });
  }
  // Share provenance for the verify phase: whether the SA writer permission
  // was created/upgraded by the setup (fresh) or reused. Persisted from
  // `spreadsheet_shared` onward so a resumed shared-but-unverified state
  // keeps its 403/404 propagation retries; a resumed state never guesses
  // from the current run's "unchanged" role.
  let shareOrigin: ShareOrigin;
  if (alreadyShared) {
    shareOrigin = checkpoint.shareOrigin;
  } else {
    // True when THIS invocation loaded an existing share-started
    // checkpoint (vs just persisting one now): the prior attempt may have
    // mutated the permission before crashing, so a reused replay must not
    // downgrade the provenance to reused.
    const shareStartedLoaded =
      checkpoint !== undefined && checkpoint.status === "spreadsheet_share_started";
    if (!shareStartedLoaded) {
      const saveError = persistState(
        options,
        executed,
        spreadsheetState(
          options,
          projectId,
          ownerEmail,
          title,
          email,
          spreadsheet,
          "spreadsheet_share_started",
          persistProjectMode,
          keyOrigin,
        ),
      );
      if (saveError !== null) {
        return saveError;
      }
    }
    let outcome: ShareOutcome;
    progress.report({ type: "operation_started", phase: "share", operation: SETUP_PROGRESS_OPERATIONS.SHARE });
    try {
      outcome = await api.ensureSaWriter({
        spreadsheetId: spreadsheet.spreadsheetId,
        saEmail: email,
        ownerEmail,
      });
    } catch (error) {
      return errorResult(
        SETUP_ERROR_CODES.SHEET_SHARE_FAILED,
        `could not share spreadsheet ${spreadsheet.spreadsheetId} with ${email}: ${safeReasonOf(error)}`,
      );
    }
    progress.report({ type: "operation_completed", phase: "share", operation: SETUP_PROGRESS_OPERATIONS.SHARE });
    saWriterRole = outcome.writerRole;
    shareOrigin =
      outcome.writerRole === "created" || outcome.writerRole === "upgraded" || shareStartedLoaded
        ? "fresh"
        : "reused";
    executed.push({
      kind: "api",
      label: `drive: share ${email} as writer on ${spreadsheet.spreadsheetId}`,
      outcome: `role ${saWriterRole}; ownership verified`,
    });
    const saveError = persistState(
      options,
      executed,
      spreadsheetState(
        options,
        projectId,
        ownerEmail,
        title,
        email,
        spreadsheet,
        "spreadsheet_shared",
        persistProjectMode,
        keyOrigin,
        shareOrigin,
      ),
    );
    if (saveError !== null) {
      return saveError;
    }
  }
  if (!alreadyShared) {
    progress.report({ type: "phase_completed", phase: "share", source: "run" });
  }

  // SA verify: the key must read the spreadsheet (retried only for
  // propagation-class failures of resources created THIS run) before .env
  // is written. The validated key credential is promoted into memory at the
  // secure descriptor boundary and handed to the verifier IN MEMORY: the
  // verifier never reopens the key pathname, so a mid-run replacement of
  // the key file cannot redirect verification to a different credential.
  const saVerifyReporter = boundedCheckReporter(progress, "sa_access", "sa_access");
  if (checkpoint?.status !== "complete") {
    progress.report({ type: "phase_started", phase: "sa_access" });
    const keyCredential = readServiceAccountKeyCredentialSecurely(options.keyPath);
    if (keyCredential.status === "absent") {
      return errorResult(
        SETUP_ERROR_CODES.SA_ACCESS_VERIFY_FAILED,
        `the service-account key file ${options.keyPath} recorded in the setup state is missing`,
      );
    }
    if (keyCredential.status === "invalid") {
      return errorResult(
        SETUP_ERROR_CODES.SA_ACCESS_VERIFY_FAILED,
        `could not read the service-account key at ${options.keyPath}: ${keyCredential.message}`,
      );
    }
    if (
      keyCredential.credentials.projectId !== projectId ||
      keyCredential.credentials.clientEmail !== email
    ) {
      // A foreign credential planted at the key path is refused at the
      // secure boundary; the verify phase never runs with it.
      return errorResult(
        SETUP_ERROR_CODES.SA_ACCESS_VERIFY_FAILED,
        `the service-account key at ${options.keyPath} belongs to ` +
          `${keyCredential.credentials.clientEmail} (project ` +
          `${keyCredential.credentials.projectId}); expected ${email} in project ${projectId}`,
      );
    }
    try {
      await options.verifySaAccess.verify({
        keyPath: options.keyPath,
        spreadsheetId: spreadsheet.spreadsheetId,
        // Propagation evidence comes from the persisted keyOrigin and
        // shareOrigin discriminants, NOT from this run's reuse summary: a
        // key created or a share granted by an earlier run of the same
        // setup still needs its propagation retries (Invalid JWT Signature
        // for a fresh key, 403/404 for a fresh share).
        keyFresh: keyOrigin === "created",
        shareFresh: shareOrigin === "fresh",
        onVerifyProgress: saVerifyReporter,
        // In-memory validated credentials for the run: the private key
        // exists only in process memory and is never stored or logged.
        credentials: {
          client_email: keyCredential.credentials.clientEmail,
          private_key: keyCredential.credentials.privateKey,
        },
      });
    } catch (error) {
      return errorResult(
        SETUP_ERROR_CODES.SA_ACCESS_VERIFY_FAILED,
        `could not verify service-account access to the spreadsheet: ${safeReasonOf(error)}`,
      );
    }
    executed.push({
      kind: "api",
      label: `spreadsheets.get with the ${email} key`,
      outcome: "service-account access verified",
    });
    progress.report({ type: "phase_completed", phase: "sa_access", source: "run" });
  }

  // .env: update only the two managed keys, preserving unrelated lines. The
  // spreadsheet URL is derived from the id — never trusted from storage.
  // Revalidate the reserved paths immediately before this write so an alias
  // planted mid-run can never redirect the .env write onto the key or the
  // checkpoint.
  const envPreflight = revalidateSetupPaths(options);
  if (envPreflight !== null) {
    return envPreflight;
  }
  progress.report({ type: "phase_started", phase: "output" });
  progress.report({ type: "operation_started", phase: "output", operation: SETUP_PROGRESS_OPERATIONS.ENV_WRITE });
  let envResult: EnvFileWriteResult;
  try {
    envResult = writeSetupEnvFile(
      options.outputPath,
      options.keyPath,
      spreadsheetEditUrl(spreadsheet.spreadsheetId),
      [options.statePath, setupLockPath(options.statePath), setupStateTempPath(options.statePath)],
    );
  } catch (error) {
    return errorResult(
      carrierCode(error) ?? SETUP_ERROR_CODES.OUTPUT_WRITE_FAILED,
      `could not write ${options.outputPath}: ${messageOf(error)}`,
    );
  }
  progress.report({ type: "operation_completed", phase: "output", operation: SETUP_PROGRESS_OPERATIONS.ENV_WRITE });

  // Complete checkpoint: retained so reruns stay no-ops. Starting fresh
  // requires removing BOTH the checkpoint and the key file (or passing the
  // matching --project to recover); cloud resources are never deleted.
  if (checkpoint?.status !== "complete") {
    progress.report({ type: "operation_started", phase: "output", operation: SETUP_PROGRESS_OPERATIONS.CHECKPOINT_PERSIST });
    const saveError = persistState(
      options,
      executed,
      spreadsheetState(
        options,
        projectId,
        ownerEmail,
        title,
        email,
        spreadsheet,
        "complete",
        persistProjectMode,
        keyOrigin,
        shareOrigin,
      ),
    );
    progress.report({ type: "operation_completed", phase: "output", operation: SETUP_PROGRESS_OPERATIONS.CHECKPOINT_PERSIST });
    if (saveError !== null) {
      return saveError;
    }
  }
  progress.report({ type: "phase_completed", phase: "output", source: "run" });

  const baseSummary = {
    projectId,
    ownerEmail,
    serviceAccountEmail: email,
    keyPath: options.keyPath,
    spreadsheetId: spreadsheet.spreadsheetId,
    spreadsheetUrl: spreadsheetEditUrl(spreadsheet.spreadsheetId),
    spreadsheetTitle: title,
    outputPath: options.outputPath,
    statePath: options.statePath,
    stateStatus: "complete",
    envFileCreated: envResult.created,
    envFileModified: envResult.modified,
    projectReused,
    serviceAccountReused: needsProjectPhase ? serviceAccountReused : true,
    keyReused,
    saWriterRole,
    resumed: checkpoint !== undefined,
  };
  // Single-SA runs return exactly as before (no pool checkpoint key, no
  // pool env line, no pool progress); the pool expansion below runs only
  // when more than one service account was requested.
  const saCount = options.saCount ?? 1;
  if (saCount <= 1) {
    return {
      status: "ok",
      dryRun: false,
      commands: executed,
      summary: { ...baseSummary, poolSize: 1, poolPaths: [options.keyPath] },
    };
  }
  const expanded = await expandCredentialPool(runner, executed, progress, api, options, keySleeper, {
    projectId,
    spreadsheetId: spreadsheet.spreadsheetId,
    title,
    ownerEmail,
    primaryEmail: email,
    projectMode: persistProjectMode,
    keyOrigin,
    shareOrigin,
    saCount,
  });
  if (expanded.status === "error") {
    return expanded.error;
  }
  return {
    status: "ok",
    dryRun: false,
    commands: executed,
    summary: {
      ...baseSummary,
      envFileModified: envResult.modified || expanded.envModified,
      poolSize: expanded.pool.length,
      poolPaths: expanded.pool.map((entry) => entry.keyPath),
      poolKeptEntries: expanded.keptPoolEntries,
    },
  };
}

/**
 * Runs one `gcloud projects create` attempt and classifies the outcome.
 *
 * A create that reports "already exists" counts as reused (the idempotent
 * recovery path); any other failure is an error with a status-only message.
 */
async function createProjectOnce(
  runner: GcloudRunner,
  executed: PlannedCommand[],
  projectId: string,
): Promise<{ readonly status: "ok"; readonly reused: boolean } | { readonly status: "error"; readonly error: SetupErrorResult }> {
  const create = await runner.run(["projects", "create", projectId]);
  if (create.status !== "ok") {
    if (create.status === "failed" && create.stderr.includes(PROJECT_ALREADY_EXISTS_MARKER)) {
      executed.push({
        kind: "gcloud",
        command: ["projects", "create", projectId],
        outcome: "reused (project already exists)",
      });
      return { status: "ok", reused: true };
    }
    return {
      status: "error",
      error: errorResult(
        SETUP_ERROR_CODES.PROJECT_CREATE_FAILED,
        `could not create project "${projectId}": ${describeGcloudFailure(create)}`,
      ),
    };
  }
  executed.push({ kind: "gcloud", command: ["projects", "create", projectId], outcome: "created" });
  return { status: "ok", reused: false };
}

/**
 * Ensures one service account exists: reuse by email when it already
 * exists, create it otherwise.
 *
 * Shared verbatim by the primary flow and the credential-pool expansion:
 * the same list/create commands, outcomes, and `sa_create_failed` codes
 * run under the caller's phase (the primary `service_account` phase or
 * `pool_expansion`), so the primary path emits byte-identical events.
 */
async function ensureServiceAccount(
  runner: GcloudRunner,
  executed: PlannedCommand[],
  progress: SetupProgressSink,
  phase: SetupProgressPhase,
  input: { readonly projectId: string; readonly saName: string; readonly saEmail: string },
): Promise<{ readonly status: "ok"; readonly reused: boolean } | { readonly status: "error"; readonly error: SetupErrorResult }> {
  progress.report({ type: "operation_started", phase, operation: SETUP_PROGRESS_OPERATIONS.SA_LIST });
  const saList = await runner.run(["iam", "service-accounts", "list", "--project", input.projectId, "--format=value(email)"]);
  progress.report({ type: "operation_completed", phase, operation: SETUP_PROGRESS_OPERATIONS.SA_LIST });
  executed.push({
    kind: "gcloud",
    command: ["iam", "service-accounts", "list", "--project", input.projectId, "--format=value(email)"],
    outcome: outcomeOf(saList, "service account lookup complete"),
  });
  if (saList.status !== "ok") {
    return {
      status: "error",
      error: errorResult(SETUP_ERROR_CODES.SA_CREATE_FAILED, `could not list service accounts: ${describeGcloudFailure(saList)}`),
    };
  }
  const existingEmails = saList.stdout.split("\n").map((line) => line.trim());
  if (existingEmails.includes(input.saEmail)) {
    return { status: "ok", reused: true };
  }
  progress.report({ type: "operation_started", phase, operation: SETUP_PROGRESS_OPERATIONS.SA_CREATE });
  const saCreate = await runner.run([
    "iam",
    "service-accounts",
    "create",
    input.saName,
    "--project",
    input.projectId,
    "--display-name",
    "hikoutei setup",
  ]);
  progress.report({ type: "operation_completed", phase, operation: SETUP_PROGRESS_OPERATIONS.SA_CREATE });
  executed.push({
    kind: "gcloud",
    command: [
      "iam",
      "service-accounts",
      "create",
      input.saName,
      "--project",
      input.projectId,
      "--display-name",
      "hikoutei setup",
    ],
    outcome: outcomeOf(saCreate, "service account created"),
  });
  if (saCreate.status !== "ok") {
    return {
      status: "error",
      error: errorResult(
        SETUP_ERROR_CODES.SA_CREATE_FAILED,
        `could not create service account "${input.saName}": ${describeGcloudFailure(saCreate)}`,
      ),
    };
  }
  return { status: "ok", reused: false };
}

/**
 * Derives the key path for pool entry `index` (2-based) next to the
 * primary key path, mirroring the primary naming: `name-2.json` beside
 * `name.json` (or `name-2` beside an extensionless `name`). The directory
 * is preserved and no existing file is ever touched here.
 */
export function poolKeyPath(primaryKeyPath: string, index: number): string {
  const base = basename(primaryKeyPath);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  return join(dirname(primaryKeyPath), `${stem}-${index}${ext}`);
}

/** Prompt text for the interactive service-account count question. */
export const SA_COUNT_PROMPT = "Service accounts to create? [1]: ";

/** Reads one line of prompt input; null on end-of-input. Injectable for tests. */
export type SaCountLineReader = () => Promise<string | null>;

/** Inputs for resolving the service-account count of a run. */
export interface ResolveSaCountOptions {
  /** Parsed `--sa-count` value, or undefined when the flag was not given. */
  readonly saCount: number | undefined;
  readonly yes: boolean;
  readonly dryRun: boolean;
  /** True when the session is an interactive terminal (stdin and stdout TTY). */
  readonly isTTY: boolean;
  /** Writes the prompt text; required when prompting. */
  readonly write?: (text: string) => void;
  /** Reads one input line; required when prompting. */
  readonly readLine?: SaCountLineReader;
}

/** Outcome of resolving the service-account count of a run. */
export type SaCountResolution =
  | { readonly status: "ok"; readonly saCount: number }
  | { readonly status: "invalid"; readonly failure: SetupFailure };

/**
 * Resolves how many service accounts to provision.
 *
 * `--yes`, `--dry-run`, and non-TTY sessions never prompt and use the
 * flag (default 1). An interactive TTY session without `--sa-count` asks
 * once (`Service accounts to create? [1]: `): an empty answer means 1, a
 * valid 1..10 integer wins, and invalid input re-asks exactly once before
 * failing with an `invalid_args` usage error. End-of-input on the first
 * read counts as empty (1); end-of-input on the re-ask fails closed with
 * an `invalid_args` usage error (a typo followed by Ctrl-D must never
 * silently provision 1). A missing line reader degrades to the default
 * without prompting.
 */
export async function resolveSaCountForSetup(options: ResolveSaCountOptions): Promise<SaCountResolution> {
  if (options.yes || options.dryRun || !options.isTTY || options.saCount !== undefined) {
    return { status: "ok", saCount: options.saCount ?? 1 };
  }
  const readLine = options.readLine;
  if (readLine === undefined) {
    return { status: "ok", saCount: 1 };
  }
  const write = options.write ?? ((): void => undefined);
  const invalidArgs = (detail: string): SaCountResolution => ({
    status: "invalid",
    failure: setupFailure(
      SETUP_ERROR_CODES.INVALID_ARGS,
      `invalid service-account count: ${detail}; run with --sa-count <n> (1-${MAX_SETUP_SA_COUNT}) or --yes`,
    ),
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    write(SA_COUNT_PROMPT);
    const line = await readLine();
    if (line === null) {
      if (attempt === 0) {
        return { status: "ok", saCount: 1 };
      }
      return invalidArgs("no input on retry");
    }
    const trimmed = line.trim();
    if (trimmed === "") {
      return { status: "ok", saCount: 1 };
    }
    const parsed = parseSaCount(trimmed);
    if (parsed.status === "ok") {
      return { status: "ok", saCount: parsed.saCount };
    }
    if (attempt === 1) {
      return invalidArgs(parsed.message);
    }
  }
  // Unreachable: the loop above returns on every path.
  return { status: "ok", saCount: 1 };
}

/** Context the pool expansion inherits from the completed primary flow. */
interface PoolExpansionContext {
  readonly projectId: string;
  readonly spreadsheetId: string;
  readonly title: string;
  readonly ownerEmail: string;
  /** Canonical email of the primary service account (pool entry 1). */
  readonly primaryEmail: string;
  readonly projectMode: ProjectMode;
  readonly keyOrigin: KeyOrigin;
  readonly shareOrigin: ShareOrigin;
  readonly saCount: number;
}

/** Outcome of the credential-pool expansion. */
type PoolExpansionResult =
  | { readonly status: "ok"; readonly pool: readonly SetupPoolEntry[]; readonly envModified: boolean; readonly keptPoolEntries: number }
  | { readonly status: "error"; readonly error: SetupErrorResult };

/**
 * Provisions the additional credential-pool accounts (entries 2..N).
 *
 * Runs after the primary flow reached `complete`: for each missing entry
 * it ensures the `<saName>-<i>` service account exists (the same
 * ensure/create path as the primary), issues its key with the same
 * settlement loop (`settleServiceAccountKey` with `fresh` permission and
 * its own marker/baseline), grants it writer access, verifies access with
 * the same verifier, and persists the entry to the `complete` checkpoint
 * IMMEDIATELY — a mid-pool failure keeps entries 1..i-1 so the resume
 * skips them. Failures use the same error codes as the primary path.
 * Finally the `.env` file is rewritten with the comma-separated
 * `HIKOUTEI_SYNC_CREDENTIALS` pool line. The bounded key/verify progress
 * reporters stay unwired here (the tracker hosts one bounded kind per
 * phase): only generic operation events are emitted under
 * `pool_expansion`, which never advances the overall ten-phase count.
 *
 * // ponytail: no per-pool-SA key write-ahead checkpoint; a crash between
 * // a pool key create and its pool-entry persist leaves an orphaned cloud
 * // key that the retry treats as baseline (fails uncertain, never
 * // duplicates silently). Persist per-SA key markers if this ever matters.
 */
async function expandCredentialPool(
  runner: GcloudRunner,
  executed: PlannedCommand[],
  progress: SetupProgressSink,
  api: HumanSheetApi,
  options: RunSetupOptions,
  keySleeper: Sleeper,
  context: PoolExpansionContext,
): Promise<PoolExpansionResult> {
  progress.report({ type: "phase_started", phase: POOL_EXPANSION_PHASE });
  // The primary flow just persisted `complete`; reload it as the
  // append-reconcile base (saCount is a run option, never a checkpoint
  // conflict: entries already present are skipped).
  const reloaded = loadSetupState(options.statePath);
  if (reloaded.status !== "loaded" || reloaded.state.status !== "complete") {
    return {
      status: "error",
      error: errorResult(
        SETUP_ERROR_CODES.SETUP_STATE_INVALID,
        `the setup state at ${options.statePath} is not complete; remove it and rerun setup`,
      ),
    };
  }
  const primaryEntry: SetupPoolEntry = {
    saName: options.saName,
    saEmail: context.primaryEmail,
    keyPath: options.keyPath,
  };
  const storedPool = reloaded.state.pool;
  if (storedPool !== undefined) {
    const first = storedPool[0];
    if (
      first === undefined ||
      first.saName !== primaryEntry.saName ||
      first.saEmail !== primaryEntry.saEmail ||
      first.keyPath !== primaryEntry.keyPath
    ) {
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.SETUP_STATE_INVALID,
          `the credential pool in ${options.statePath} does not start with the primary service account; ` +
            `remove the setup state and rerun setup`,
        ),
      };
    }
  }
  // Keep-all resume: resuming with a smaller --sa-count never removes
  // entries — the loop below only appends missing entries 2..N, so the
  // pool only grows and the summary reports the actual (larger) size.
  const keptPoolEntries = storedPool?.length ?? 0;
  const pool: SetupPoolEntry[] = storedPool !== undefined ? [...storedPool] : [primaryEntry];

  for (let index = pool.length + 1; index <= context.saCount; index += 1) {
    const saName = `${options.saName}-${index}`;
    if (!isValidServiceAccountName(saName)) {
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.INVALID_ARGS,
          `service-account name "${options.saName}" is too long to expand into a ${context.saCount}-account ` +
            `pool ("${saName}" is not a valid service-account name); use a shorter --sa-name`,
        ),
      };
    }
    const saEmail = serviceAccountEmail(saName, context.projectId);
    const keyPath = poolKeyPath(options.keyPath, index);

    const ensured = await ensureServiceAccount(runner, executed, progress, POOL_EXPANSION_PHASE, {
      projectId: context.projectId,
      saName,
      saEmail,
    });
    if (ensured.status === "error") {
      return ensured;
    }

    progress.report({ type: "operation_started", phase: POOL_EXPANSION_PHASE, operation: SETUP_PROGRESS_OPERATIONS.KEY_LIST });
    const keyList = await listUserManagedServiceAccountKeys(runner, executed, {
      projectId: context.projectId,
      saEmail,
      purpose: "baseline",
    });
    progress.report({ type: "operation_completed", phase: POOL_EXPANSION_PHASE, operation: SETUP_PROGRESS_OPERATIONS.KEY_LIST });
    if (keyList.status === "error") {
      return { status: "error", error: keyList.error };
    }
    const settled = await settleServiceAccountKey(runner, executed, {
      keyPath,
      projectId: context.projectId,
      saEmail,
      keyMarker: generateCreationMarker(),
      baseline: keyList.names,
      createPermission: "fresh",
      sleeper: keySleeper,
    });
    if (settled.status === "error") {
      return settled;
    }

    progress.report({ type: "operation_started", phase: POOL_EXPANSION_PHASE, operation: SETUP_PROGRESS_OPERATIONS.SHARE });
    let outcome: ShareOutcome;
    try {
      outcome = await api.ensureSaWriter({
        spreadsheetId: context.spreadsheetId,
        saEmail,
        ownerEmail: context.ownerEmail,
      });
    } catch (error) {
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.SHEET_SHARE_FAILED,
          `could not share spreadsheet ${context.spreadsheetId} with ${saEmail}: ${safeReasonOf(error)}`,
        ),
      };
    }
    progress.report({ type: "operation_completed", phase: POOL_EXPANSION_PHASE, operation: SETUP_PROGRESS_OPERATIONS.SHARE });
    executed.push({
      kind: "api",
      label: `drive: share ${saEmail} as writer on ${context.spreadsheetId}`,
      outcome: `role ${outcome.writerRole}; ownership verified`,
    });

    const keyCredential = readServiceAccountKeyCredentialSecurely(keyPath);
    if (keyCredential.status === "absent") {
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.SA_ACCESS_VERIFY_FAILED,
          `the service-account key file ${keyPath} recorded in the setup state is missing`,
        ),
      };
    }
    if (keyCredential.status === "invalid") {
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.SA_ACCESS_VERIFY_FAILED,
          `could not read the service-account key at ${keyPath}: ${keyCredential.message}`,
        ),
      };
    }
    if (keyCredential.credentials.projectId !== context.projectId || keyCredential.credentials.clientEmail !== saEmail) {
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.SA_ACCESS_VERIFY_FAILED,
          `the service-account key at ${keyPath} belongs to ` +
            `${keyCredential.credentials.clientEmail} (project ` +
            `${keyCredential.credentials.projectId}); expected ${saEmail} in project ${context.projectId}`,
        ),
      };
    }
    try {
      await options.verifySaAccess.verify({
        keyPath,
        spreadsheetId: context.spreadsheetId,
        keyFresh: !settled.keyReused,
        shareFresh: outcome.writerRole === "created" || outcome.writerRole === "upgraded",
        credentials: {
          client_email: keyCredential.credentials.clientEmail,
          private_key: keyCredential.credentials.privateKey,
        },
      });
    } catch (error) {
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.SA_ACCESS_VERIFY_FAILED,
          `could not verify service-account access to the spreadsheet: ${safeReasonOf(error)}`,
        ),
      };
    }
    executed.push({
      kind: "api",
      label: `spreadsheets.get with the ${saEmail} key`,
      outcome: "service-account access verified",
    });

    // Persisted IMMEDIATELY: a later failure keeps this entry and the
    // resume skips it.
    pool.push({ saName, saEmail, keyPath });
    progress.report({ type: "operation_started", phase: POOL_EXPANSION_PHASE, operation: SETUP_PROGRESS_OPERATIONS.CHECKPOINT_PERSIST });
    const completeState = spreadsheetState(
      options,
      context.projectId,
      context.ownerEmail,
      context.title,
      context.primaryEmail,
      { spreadsheetId: context.spreadsheetId },
      "complete",
      context.projectMode,
      context.keyOrigin,
      context.shareOrigin,
    );
    if (completeState.status !== "complete") {
      // Unreachable: the builder returns the requested status; fail
      // closed rather than persist a wrong-status checkpoint.
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.SETUP_STATE_INVALID,
          `could not persist the credential pool in ${options.statePath}; remove the setup state and rerun setup`,
        ),
      };
    }
    const saveError = persistState(options, executed, { ...completeState, pool: [...pool] });
    progress.report({ type: "operation_completed", phase: POOL_EXPANSION_PHASE, operation: SETUP_PROGRESS_OPERATIONS.CHECKPOINT_PERSIST });
    if (saveError !== null) {
      return { status: "error", error: saveError };
    }
  }

  progress.report({ type: "operation_started", phase: POOL_EXPANSION_PHASE, operation: SETUP_PROGRESS_OPERATIONS.ENV_WRITE });
  let envModified = false;
  try {
    const poolWrite = writeSetupEnvFile(
      options.outputPath,
      options.keyPath,
      spreadsheetEditUrl(context.spreadsheetId),
      [options.statePath, setupLockPath(options.statePath), setupStateTempPath(options.statePath)],
      pool.map((entry) => entry.keyPath),
    );
    envModified = poolWrite.modified;
  } catch (error) {
    return {
      status: "error",
      error: errorResult(
        carrierCode(error) ?? SETUP_ERROR_CODES.OUTPUT_WRITE_FAILED,
        `could not write ${options.outputPath}: ${messageOf(error)}`,
      ),
    };
  }
  progress.report({ type: "operation_completed", phase: POOL_EXPANSION_PHASE, operation: SETUP_PROGRESS_OPERATIONS.ENV_WRITE });
  progress.report({ type: "phase_completed", phase: POOL_EXPANSION_PHASE, source: "run" });
  return { status: "ok", pool, envModified, keptPoolEntries };
}

/**
 * Describes a failed gcloud invocation with phase context and exit status
 * only.
 *
 * Raw stdout/stderr can carry tokens, key material, or other secrets, so
 * stream content is never forwarded; classification (such as the
 * already-exists or not-found markers) stays internal to the flow.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves the spreadsheet title for this run.
 *
 * An explicit `--spreadsheet-title` always wins (conflicting stored values
 * were already rejected); otherwise a resumed checkpoint contributes its
 * stored title — the default is only computed for a fresh run, so a
 * checkpoint created with a custom title is never re-defaulted.
 */
function titleOf(options: RunSetupOptions, projectId: string, checkpoint: SetupState | undefined): string {
  if (options.spreadsheetTitle !== undefined) {
    return options.spreadsheetTitle;
  }
  if (checkpoint !== undefined) {
    return checkpoint.spreadsheetTitle;
  }
  return defaultSpreadsheetTitle(projectId);
}

/** Builds the `project_selected` checkpoint for a decided project id. */
function projectState(
  options: RunSetupOptions,
  projectId: string,
  ownerEmail: string,
  title: string,
  projectMode: ProjectMode,
): SetupState {
  return {
    version: SETUP_STATE_VERSION,
    status: "project_selected",
    projectId,
    projectMode,
    ownerEmail,
    saName: options.saName,
    saEmail: serviceAccountEmail(options.saName, projectId),
    keyPath: options.keyPath,
    spreadsheetTitle: title,
  };
}

/** Builds the `key_create_started` checkpoint for a key marker + baseline. */
function keyStartedState(
  options: RunSetupOptions,
  projectId: string,
  ownerEmail: string,
  title: string,
  saEmail: string,
  projectMode: ProjectMode,
  keyMarker: string,
  keyBaseline: readonly string[],
): SetupState {
  return {
    version: SETUP_STATE_VERSION,
    status: "key_create_started",
    projectId,
    projectMode,
    ownerEmail,
    saName: options.saName,
    saEmail,
    keyPath: options.keyPath,
    spreadsheetTitle: title,
    keyMarker,
    keyBaseline: [...keyBaseline],
  };
}

/** Builds the `key_ready` checkpoint (key secured; spreadsheet creation follows). */
function keyReadyState(
  options: RunSetupOptions,
  projectId: string,
  ownerEmail: string,
  title: string,
  saEmail: string,
  projectMode: ProjectMode,
  keyOrigin: KeyOrigin,
): SetupState {
  return {
    version: SETUP_STATE_VERSION,
    status: "key_ready",
    projectId,
    projectMode,
    ownerEmail,
    saName: options.saName,
    saEmail,
    keyPath: options.keyPath,
    spreadsheetTitle: title,
    keyOrigin,
  };
}

/** Builds a spreadsheet-bearing checkpoint (`spreadsheet_created` and later). */
function spreadsheetState(
  options: RunSetupOptions,
  projectId: string,
  ownerEmail: string,
  title: string,
  saEmail: string,
  spreadsheet: SpreadsheetCreateResult,
  status: "spreadsheet_created" | "spreadsheet_share_started" | "spreadsheet_shared" | "complete",
  projectMode: ProjectMode,
  keyOrigin: KeyOrigin,
  shareOrigin?: ShareOrigin,
): SetupState {
  if (status === "spreadsheet_created" || status === "spreadsheet_share_started") {
    // The share step has not completed: shareOrigin is unknown —
    // `spreadsheet_share_started` is the write-ahead persisted BEFORE the
    // permission ensure, so it never carries a shareOrigin.
    return {
      version: SETUP_STATE_VERSION,
      status,
      projectId,
      projectMode,
      ownerEmail,
      saName: options.saName,
      saEmail,
      keyPath: options.keyPath,
      spreadsheetTitle: title,
      spreadsheetId: spreadsheet.spreadsheetId,
      keyOrigin,
    };
  }
  // spreadsheet_shared and complete require the share provenance so a
  // resumed shared-but-unverified state keeps its 403/404 retries.
  if (shareOrigin === undefined) {
    // survey §c (I): invariant — unreachable through the flow; guards the
    // discriminated union shape (shareOrigin is required for shared/complete
    // statuses only, and the flow never reaches this branch).
    throw new Error(`shareOrigin is required for the ${status} checkpoint`);
  }
  return {
    version: SETUP_STATE_VERSION,
    status,
    projectId,
    projectMode,
    ownerEmail,
    saName: options.saName,
    saEmail,
    keyPath: options.keyPath,
    spreadsheetTitle: title,
    spreadsheetId: spreadsheet.spreadsheetId,
    keyOrigin,
    shareOrigin,
  };
}

/** Builds the `spreadsheet_create_started` checkpoint for a creation marker. */
function startedState(
  options: RunSetupOptions,
  projectId: string,
  ownerEmail: string,
  title: string,
  saEmail: string,
  projectMode: ProjectMode,
  creationMarker: string,
  keyOrigin: KeyOrigin,
): SetupState {
  return {
    version: SETUP_STATE_VERSION,
    status: "spreadsheet_create_started",
    projectId,
    projectMode,
    ownerEmail,
    saName: options.saName,
    saEmail,
    keyPath: options.keyPath,
    spreadsheetTitle: title,
    creationMarker,
    keyOrigin,
  };
}

/** Context for the spreadsheet create/reconcile helpers. */
interface SpreadsheetContext {
  readonly projectId: string;
  readonly ownerEmail: string;
  readonly saEmail: string;
  readonly title: string;
  readonly marker: string;
  readonly projectMode: ProjectMode;
  /** Key provenance discriminant from the checkpoint; preserved by the 400/403 rollback. */
  readonly keyOrigin: KeyOrigin;
}

/** Outcome of the spreadsheet ensure helpers. */
type SpreadsheetEnsureResult =
  | { readonly status: "ok"; readonly spreadsheet: SpreadsheetCreateResult }
  | { readonly status: "error"; readonly error: SetupErrorResult };

/**
 * Creates the spreadsheet with the creation marker and persists
 * `spreadsheet_created`.
 *
 * The `spreadsheet_create_started` checkpoint (carrying the marker) was
 * already persisted by the caller BEFORE this one and only create attempt.
 * When the create call throws, the outcome is reconciled by querying Drive
 * for the exact marker; a second create is never attempted. A known
 * non-mutating HTTP 400/403 rejection takes the rejection path: when the
 * marker lookup confirms no file exists, the checkpoint rolls back to
 * `key_ready` and the run fails with `sheet_create_failed` so a corrected
 * rerun starts a fresh marker; any other outcome stays uncertain.
 */
async function createSpreadsheetWithMarker(
  api: HumanSheetApi,
  options: RunSetupOptions,
  executed: PlannedCommand[],
  context: SpreadsheetContext,
): Promise<SpreadsheetEnsureResult> {
  let created: SpreadsheetCreateResult;
  try {
    created = await api.createSpreadsheet({ title: context.title, marker: context.marker });
  } catch (error) {
    const status = httpStatusOf(error);
    if (status === 400 || status === 403) {
      // A 400/403 is a known non-mutating rejection: the request never
      // created a file, so a marker-confirmed absence may safely roll back
      // to key_ready and fail with sheet_create_failed.
      return reconcileRejectedSheetCreate(api, options, executed, context, status);
    }
    return reconcileSpreadsheetByMarker(api, options, executed, context);
  }
  executed.push({
    kind: "api",
    label: `drive.files.create (title "${context.title}", mime ${SPREADSHEET_MIME_TYPE}, private appProperties creation marker) with the active user token`,
    outcome: `spreadsheet ${created.spreadsheetId} created`,
  });
  const saveError = persistState(
    options,
    executed,
    spreadsheetState(
      options,
      context.projectId,
      context.ownerEmail,
      context.title,
      context.saEmail,
      created,
      "spreadsheet_created",
      context.projectMode,
      context.keyOrigin,
    ),
  );
  if (saveError !== null) {
    return { status: "error", error: saveError };
  }
  return { status: "ok", spreadsheet: created };
}

/**
 * Reconciles an unknown spreadsheet create outcome by the creation marker.
 *
 * Queries Drive for the exact marker and requires exactly one result whose
 * mime type is a spreadsheet, whose name matches the expected title, and
 * whose `appProperties` still carry the marker before promoting to
 * `spreadsheet_created`. Zero, ambiguous, or unverifiable outcomes retain
 * the `spreadsheet_create_started` state and fail with the stable
 * `sheet_create_uncertain` error — deliberately favoring no automatic
 * duplicate over liveness when the outcome is unknowable.
 */
async function reconcileSpreadsheetByMarker(
  api: HumanSheetApi,
  options: RunSetupOptions,
  executed: PlannedCommand[],
  context: SpreadsheetContext,
): Promise<SpreadsheetEnsureResult> {
  let matches: readonly MarkerFileInfo[];
  try {
    matches = await api.findSpreadsheetByMarker(context.marker);
  } catch (error) {
    return uncertainCreateResult(
      `the spreadsheet creation outcome could not be confirmed (marker lookup failed: ${safeReasonOf(error)}); ` +
        `no second spreadsheet will be created — inspect Drive for a spreadsheet titled ` +
        `"${context.title}" and rerun setup`,
    );
  }
  return settleMarkerMatches(options, executed, context, matches);
}

/**
 * Reconciles a spreadsheet create that was rejected up front (HTTP 400/403).
 *
 * A 400/403 response means the request was refused BEFORE it could create
 * anything. When the marker lookup confirms zero matches, the checkpoint is
 * rolled back to `key_ready` and the run fails with `sheet_create_failed`:
 * the next run starts a fresh marker after the user fixes the issue (the
 * started state would otherwise reconcile the same absent marker forever).
 * A marker match promotes normally; a failed/ambiguous/malformed lookup
 * retains the started state and stays uncertain.
 */
async function reconcileRejectedSheetCreate(
  api: HumanSheetApi,
  options: RunSetupOptions,
  executed: PlannedCommand[],
  context: SpreadsheetContext,
  status: number,
): Promise<SpreadsheetEnsureResult> {
  let matches: readonly MarkerFileInfo[];
  try {
    matches = await api.findSpreadsheetByMarker(context.marker);
  } catch (error) {
    return uncertainCreateResult(
      `the spreadsheet creation outcome could not be confirmed (marker lookup failed: ${safeReasonOf(error)}); ` +
        `no second spreadsheet will be created — inspect Drive for a spreadsheet titled ` +
        `"${context.title}" and rerun setup`,
    );
  }
  if (matches.length === 0) {
    const saveError = persistState(
      options,
      executed,
      keyReadyState(
        options,
        context.projectId,
        context.ownerEmail,
        context.title,
        context.saEmail,
        context.projectMode,
        // The rollback preserves the key provenance discriminant: a key
        // created by this setup keeps its freshness so the retried run
        // still gets the Invalid JWT Signature propagation retries.
        context.keyOrigin,
      ),
    );
    if (saveError !== null) {
      return { status: "error", error: saveError };
    }
    return {
      status: "error",
      error: errorResult(
        SETUP_ERROR_CODES.SHEET_CREATE_FAILED,
        `the spreadsheet could not be created (HTTP ${status}); no file carries the setup creation ` +
          `marker, so nothing was created — fix the reported issue and rerun setup`,
      ),
    };
  }
  return settleMarkerMatches(options, executed, context, matches);
}

/**
 * Settles a validated marker lookup result.
 *
 * Exactly one fully matching file promotes to `spreadsheet_created`;
 * ambiguous or malformed matches retain the started state and stay
 * uncertain. Shared by the lost-response and rejected-create paths.
 */
async function settleMarkerMatches(
  options: RunSetupOptions,
  executed: PlannedCommand[],
  context: SpreadsheetContext,
  matches: readonly MarkerFileInfo[],
): Promise<SpreadsheetEnsureResult> {
  if (matches.length > 1) {
    return uncertainCreateResult(
      `more than one file carries the setup creation marker; no second spreadsheet will be created — ` +
        `remove the duplicates and rerun setup`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    // Unreachable after the length checks above; fail safe anyway.
    return uncertainCreateResult(
      `the spreadsheet creation outcome could not be confirmed (the marker lookup returned no usable file); ` +
        `no second spreadsheet will be created — inspect Drive and rerun setup`,
    );
  }
  if (match.mimeType !== SPREADSHEET_MIME_TYPE) {
    return uncertainCreateResult(
      `the file found by the setup creation marker is not a spreadsheet; no second spreadsheet will ` +
        `be created — inspect Drive and rerun setup`,
    );
  }
  if (match.name !== context.title) {
    return uncertainCreateResult(
      `the spreadsheet found by the setup creation marker has a different name than "${context.title}"; ` +
        `no second spreadsheet will be created — inspect Drive and rerun setup`,
    );
  }
  if (match.appProperties[HIKOUTEI_SETUP_MARKER_KEY] !== context.marker) {
    return uncertainCreateResult(
      `the file found by the setup creation marker does not carry the expected marker; no second ` +
        `spreadsheet will be created — inspect Drive and rerun setup`,
    );
  }
  executed.push({
    kind: "api",
    label: "drive.files.list by appProperties creation marker",
    outcome: `spreadsheet ${match.spreadsheetId} recovered by marker`,
  });
  const created: SpreadsheetCreateResult = { spreadsheetId: match.spreadsheetId };
  const saveError = persistState(
    options,
    executed,
    spreadsheetState(
      options,
      context.projectId,
      context.ownerEmail,
      context.title,
      context.saEmail,
      created,
      "spreadsheet_created",
      context.projectMode,
      context.keyOrigin,
    ),
  );
  if (saveError !== null) {
    return { status: "error", error: saveError };
  }
  return { status: "ok", spreadsheet: created };
}

/**
 * Builds the stable `sheet_create_uncertain` failure for an unknown create.
 *
 * The `spreadsheet_create_started` checkpoint is intentionally retained so
 * the next run reconciles by marker instead of creating a second sheet.
 */
function uncertainCreateResult(message: string): SpreadsheetEnsureResult {
  return { status: "error", error: errorResult(SETUP_ERROR_CODES.SHEET_CREATE_UNCERTAIN, message) };
}

/**
 * Writes the checkpoint atomically and records the step in the executed list.
 *
 * Returns an error result on filesystem failure, preserving carrier codes
 * (`SetupPathSafetyError`) and falling back to `setup_state_write_failed`
 * for other errors.
 */
function persistState(
  options: RunSetupOptions,
  executed: PlannedCommand[],
  state: SetupState,
): SetupErrorResult | null {
  // Fail closed if a reserved path alias appeared after the initial
  // preflight: the checkpoint write must never be redirected by a symlink
  // or hardlink that was not there when the run started.
  const revalidated = revalidateSetupPaths(options);
  if (revalidated !== null) {
    return revalidated;
  }
  try {
    saveSetupState(options.statePath, state);
  } catch (error) {
    return errorResult(
      carrierCode(error) ?? SETUP_ERROR_CODES.SETUP_STATE_WRITE_FAILED,
      `could not write ${options.statePath}: ${messageOf(error)}`,
    );
  }
  executed.push({
    kind: "file",
    label: `checkpoint ${options.statePath}`,
    outcome: `status ${state.status} persisted`,
  });
  return null;
}
