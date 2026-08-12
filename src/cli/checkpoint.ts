/**
 * Idempotency checkpoint and exclusive setup lock for `hikoutei setup`.
 *
 * The setup flow mutates Google Cloud resources, so an interrupted run must
 * resume from the same project and spreadsheet instead of creating
 * duplicates. The checkpoint is a versioned JSON file (default
 * `.hikoutei-setup-state.json`) written atomically (unique per-run temp
 * file + rename) with mode 0600. It never contains tokens or key material — only identities,
 * paths, the spreadsheet id, a non-secret creation marker, and the
 * non-secret key provenance discriminant (`keyOrigin`).
 *
 * Statuses form a strict progression:
 * - `project_selected`: the project id is decided (persisted before project
 *   creation) and no key or spreadsheet exists yet.
 * - `key_create_started`: a local opaque key marker (a UUID) and a sorted/
 *   deduplicated baseline of the pre-existing user-managed service-account
 *   key resource names were persisted BEFORE the single gcloud key create.
 *   The marker derives a deterministic private sibling staging path, so a
 *   crash at any key boundary (before gcloud, after the remote/local
 *   create, after the hardlink install, before/after staged cleanup, before
 *   `key_ready`) resumes by reconciling the staged and/or final key file
 *   against the current user-managed key list. Only the invocation that
 *   just persisted this state may issue the one key create; every resume
 *   is reconcile-only and NEVER creates, even when no stage/final/delta is
 *   visible — a lagging IAM key list must never permit a duplicate. When
 *   no credential and no post-baseline key are visible, the resume polls
 *   the key list plus staged/final evidence through a bounded propagation
 *   window and then fails with `key_create_uncertain` (nothing is deleted
 *   automatically and the create is never retried); the user inspects the
 *   cloud keys and intentionally resets the key checkpoint to start
 *   fresh.
 * - `key_ready`: the service-account key was secured (owner-only mode 0600),
 *   validated, and installed at the final key path; spreadsheet creation
 *   follows. Every later status implies key readiness: a missing key in
 *   `key_ready` or later is invalid. `key_ready` and every later status
 *   carry `keyOrigin` — a non-secret discriminant recording whether the
 *   key was CREATED by this setup run or REUSED from a pre-existing
 *   credential — so a resumed run keeps the verify-phase freshness
 *   evidence (new keys get the Invalid JWT Signature propagation retry)
 *   without conflating it with the current run's reuse summary.
 * - `spreadsheet_create_started`: a local opaque creation marker (a UUID)
 *   was generated and persisted BEFORE the single remote create attempt.
 *   The create request carries the marker as a private Drive `appProperties`
 *   entry, so a crash between the remote create and the next checkpoint
 *   write is reconciled on resume by querying Drive for that exact marker.
 *   Setup NEVER creates a second spreadsheet from this state: an unknown
 *   outcome fails with `sheet_create_uncertain` and is reconciled on the
 *   next run. A create rejected up front (HTTP 400/403) with zero marker
 *   matches rolls back to `key_ready` (preserving `keyOrigin`) and fails
 *   with `sheet_create_failed` so the next run starts a fresh marker after
 *   the user fixes the issue.
 * - `spreadsheet_created`: the spreadsheet id was persisted immediately
 *   after creation, before any sharing step.
 * - `spreadsheet_share_started`: the share write-ahead. The spreadsheet id
 *   and `keyOrigin` were persisted BEFORE the idempotent writer-permission
 *   ensure could create or upgrade the service account's permission. The
 *   final `shareOrigin` is deliberately absent: the attempt outcome is not
 *   known yet, so a stored shareOrigin here is contradictory. A crash or
 *   failure between the remote permission mutation and the
 *   `spreadsheet_shared` write leaves this status; the next run reruns
 *   the idempotent ensure/ownership verification and persists a
 *   conservative `shareOrigin: "fresh"` when this status was LOADED
 *   (the prior attempt may have created/upgraded before crashing) — a
 *   false-positive fresh only adds bounded 403/404 retries and is safe.
 * - `spreadsheet_shared`: the service account was granted writer access and
 *   Drive metadata was verified.
 * - `complete`: the `.env` file was written; the state is retained so reruns
 *   stay no-ops. Starting fresh requires removing both the checkpoint and
 *   the key file (or passing the matching `--project` for recovery).
 *
 * The spreadsheet URL is never stored: it is derived deterministically from
 * the spreadsheet id, so a stored URL can never disagree with the id.
 * `projectMode` records whether the project was explicit (`--project`) or
 * generated (`hikoutei-<slug>`); resume behavior differs between the two.
 *
 * This module also validates an existing service-account key file: a key may
 * only be reused when its `project_id` and `client_email` match the project
 * and service account of the current run, and its `private_key` must parse
 * as an RSA private key (the key material itself is never returned).
 *
 * The exclusive setup lock (`<state>.lock`) prevents concurrent runs: it is
 * an EMPTY DIRECTORY created with `mkdir` (mode 0700) and removed with
 * `rmdir`. The atomic create-or-fail semantics of `mkdir` mean a second
 * process can never acquire while the owner holds the lock, and no metadata
 * is stored inside (none is needed — there is no read-then-delete ownership
 * race between cooperating setup processes because the directory stays
 * non-removable and non-reacquirable until the owner atomically removes it).
 * EEXIST (any pre-existing entry: file, directory, or symlink) fails with
 * `setup_in_progress` and the entry is never touched; any other acquire
 * failure is a distinct lock failure (`setup_lock_failed`). A crash leaves
 * the empty directory behind — it is never removed automatically, and
 * manual removal is required only when the user is certain no setup is
 * running. The owner releases by removing the exact directory it created
 * (device/inode verified), so a replacement acquired after release is never
 * deleted.
 */

import { createPrivateKey, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { dirname } from "node:path";

/** Default checkpoint file name, resolved against the current directory. */
export const SETUP_STATE_FILE_NAME = ".hikoutei-setup-state.json";

/**
 * Derives the canonical service-account email for a name and project.
 *
 * The single source of truth for the `sa@<project>.iam.gserviceaccount.com`
 * identity: the setup flow derives the email it creates/uses from here, and
 * checkpoint validation requires any stored `saEmail` to equal this exact
 * derivation, so an attacker-controlled or corrupted checkpoint can never
 * introduce a different service-account identity.
 */
export function serviceAccountEmail(saName: string, projectId: string): string {
  return `${saName}@${projectId}.iam.gserviceaccount.com`;
}

/** Current checkpoint schema version; a different version is `setup_state_invalid`. */
export const SETUP_STATE_VERSION = 1;

/** Checkpoint file permission after write (owner read/write only). */
export const SETUP_STATE_FILE_MODE = 0o600;

/** Suffix of checkpoint temp files; the reserved base name used by path checks. */
export const SETUP_STATE_TEMP_SUFFIX = ".tmp";

/** Suffix of the exclusive setup lock path (`<state>.lock`). */
export const SETUP_LOCK_SUFFIX = ".lock";

/** Service-account key file permission after setup (owner read/write only). */
export const SERVICE_ACCOUNT_KEY_FILE_MODE = 0o600;

/**
 * Restricted format of a service-account key id (`private_key_id`).
 *
 * Google user-managed service-account key ids are 16 lowercase hex digits;
 * the pattern accepts 16-40 hex digits so the setup never rejects a valid
 * key, while still refusing arbitrary payload text. The key id is NOT
 * secret: it is the last segment of the key's IAM resource name
 * (`projects/<project>/serviceAccounts/<email>/keys/<id>`) and is used to
 * match a local key file against the cloud key list during reconciliation.
 */
export const SERVICE_ACCOUNT_KEY_ID_PATTERN = /^[0-9a-fA-F]{16,40}$/;

/**
 * Restricted format of a creation marker: a lowercase UUID v4 as produced by
 * `node:crypto` `randomUUID`. The marker is used inside a Drive `files.list`
 * query and as a Drive `appProperties` value, so the format is validated
 * before it ever reaches the API.
 */
export const CREATION_MARKER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Restricted format of a Drive file or permission id.
 *
 * Drive ids are opaque URL-safe identifiers (ASCII alphanumerics, `_`, and
 * `-`). Anything else — whitespace, control characters, newlines, or any
 * other character — is refused at the untrusted SDK boundary before the id
 * can reach a URL, the `.env` file, a summary, or a command label.
 */
export const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** True when the value is a non-empty URL-safe Drive id. */
export function isValidDriveId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && DRIVE_ID_PATTERN.test(value);
}

/**
 * Canonical GCP project id format.
 *
 * GCP project ids are 6-30 characters of lowercase ASCII letters, digits,
 * and hyphens, must start with a lowercase letter, and must not end with a
 * hyphen. The setup flow passes project ids to `gcloud` and stores them in
 * the checkpoint, so the format is enforced at the CLI boundary AND at the
 * checkpoint boundary: an option-like or malformed identifier (for example
 * `--project=--flag`) is rejected before any subprocess, API call, or file
 * mutation.
 */
export const GCP_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/**
 * Canonical service-account name format.
 *
 * GCP service-account names follow the same 6-30 character shape as
 * project ids (lowercase letters, digits, and hyphens; lowercase-letter
 * start; alphanumeric end). The name derives the canonical
 * `sa@<project>.iam.gserviceaccount.com` identity, so the format is
 * enforced at the CLI boundary AND at the checkpoint boundary: an
 * option-like or malformed name is rejected before any subprocess, API
 * call, or file mutation.
 */
export const SERVICE_ACCOUNT_NAME_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** True when the value is a well-formed GCP project id. */
export function isValidGcpProjectId(value: unknown): value is string {
  return typeof value === "string" && GCP_PROJECT_ID_PATTERN.test(value);
}

/** True when the value is a well-formed service-account name. */
export function isValidServiceAccountName(value: unknown): value is string {
  return typeof value === "string" && SERVICE_ACCOUNT_NAME_PATTERN.test(value);
}

/** True when the value is a well-formed creation marker (UUID v4). */
export function isValidCreationMarker(value: unknown): value is string {
  return typeof value === "string" && CREATION_MARKER_PATTERN.test(value);
}

/**
 * True when the value is a well-formed key marker (UUID v4).
 *
 * The key marker shares the restricted UUID v4 format with the spreadsheet
 * creation marker (both are opaque locally generated ids that later appear
 * in paths or API queries), but it is a distinct domain value: it derives
 * the deterministic private staging path of the service-account key and is
 * stored only in `key_create_started` checkpoints.
 */
export function isValidKeyMarker(value: unknown): value is string {
  return typeof value === "string" && CREATION_MARKER_PATTERN.test(value);
}

/** Atomic checkpoint temp path for a state file. */
export function setupStateTempPath(statePath: string): string {
  return `${statePath}${SETUP_STATE_TEMP_SUFFIX}`;
}

/**
 * Unique per-invocation checkpoint temp path (PID + random UUID).
 *
 * Every save uses a fresh sibling name, so a crashed run leaves only an
 * inert orphan that never blocks the next save. The reserved base name
 * (`setupStateTempPath`) is retained for the path-collision checks as
 * defense in depth: no setup artifact may ever live at the fixed
 * `<state>.tmp` name, but saves must not depend on clearing it.
 */
export function uniqueSetupStateTempPath(statePath: string): string {
  return `${setupStateTempPath(statePath)}-${process.pid}-${randomUUID()}`;
}

/** Exclusive setup lock path for a state file. */
export function setupLockPath(statePath: string): string {
  return `${statePath}${SETUP_LOCK_SUFFIX}`;
}

/** How the project was decided; drives resume behavior. */
export type ProjectMode = "explicit" | "generated";

/**
 * Whether the service-account key was created by this setup or pre-existed.
 *
 * A non-secret provenance discriminant persisted from `key_ready` onward:
 * `created` means the key at the recorded path was provisioned by the setup
 * run (or its crashed predecessor, recovered through the key write-ahead
 * reconciliation); `reused` means the credential pre-existed the setup
 * (matched by identity). The verify phase retries Invalid JWT Signature
 * propagation only for `created` keys, and the value survives resumes via
 * the checkpoint.
 */
export type KeyOrigin = "created" | "reused";

/**
 * Whether the service-account writer permission was granted by this setup
 * or pre-existed.
 *
 * A non-secret provenance discriminant persisted from `spreadsheet_shared`
 * onward: `fresh` means the writer permission was created or upgraded by
 * this setup run; `reused` means an existing writer/owner permission was
 * reused. The verify phase retries 403/404 propagation failures only for
 * `fresh` shares, and the value survives resumes via the checkpoint so a
 * shared-but-unverified state keeps its propagation evidence.
 */
export type ShareOrigin = "fresh" | "reused";

/** Progression statuses of a setup run; later statuses mean earlier work is done. */
export type SetupStateStatus =
  | "project_selected"
  | "key_create_started"
  | "key_ready"
  | "spreadsheet_create_started"
  | "spreadsheet_created"
  | "spreadsheet_share_started"
  | "spreadsheet_shared"
  | "complete";

/** Fields shared by every checkpoint status. */
interface SetupStateCommon {
  readonly version: typeof SETUP_STATE_VERSION;
  readonly projectId: string;
  /** `explicit` when `--project` was given; `generated` when `hikoutei-<slug>` was decided. */
  readonly projectMode: ProjectMode;
  /** Email of the human account that owns the spreadsheet (from tokeninfo). */
  readonly ownerEmail: string;
  readonly saName: string;
  readonly saEmail: string;
  readonly keyPath: string;
  readonly spreadsheetTitle: string;
}

/**
 * Runtime-validated checkpoint state.
 *
 * The discriminated union makes the spreadsheet fields unrepresentable
 * before the spreadsheet exists: `spreadsheet_create_started` carries only
 * the creation marker, and only `spreadsheet_created` and later statuses
 * carry the spreadsheet id. `key_create_started` carries only the key
 * marker (deriving the deterministic staging path) and the sorted/
 * deduplicated baseline of pre-existing user-managed key resource names;
 * `key_ready` and later statuses carry no key fields — a key checkpoint
 * never stores key material — but DO carry `keyOrigin`, the non-secret
 * provenance discriminant that preserves verify freshness across resumes.
 * `spreadsheet_share_started` is the share write-ahead: it carries the
 * spreadsheet id and `keyOrigin` but NO `shareOrigin` (the permission
 * mutation may not have happened yet). `spreadsheet_shared` and
 * `complete` additionally carry `shareOrigin`, the non-secret provenance
 * of the SA writer permission, so a resumed shared-but-unverified state
 * keeps its 403/404 propagation freshness. The URL is never stored — it
 * is derived deterministically from the id.
 */
export type SetupState =
  | (SetupStateCommon & { readonly status: "project_selected" })
  | (SetupStateCommon & {
    readonly status: "key_create_started";
    /** UUID marker deriving the deterministic private staging path of the key. */
    readonly keyMarker: string;
    /** Sorted/deduplicated baseline of pre-existing user-managed key resource names. */
    readonly keyBaseline: readonly string[];
  })
  | (SetupStateCommon & { readonly status: "key_ready"; readonly keyOrigin: KeyOrigin })
  | (SetupStateCommon & {
    readonly status: "spreadsheet_create_started";
    readonly creationMarker: string;
    readonly keyOrigin: KeyOrigin;
  })
  | (SetupStateCommon & {
    readonly status: "spreadsheet_created" | "spreadsheet_share_started";
    readonly spreadsheetId: string;
    readonly keyOrigin: KeyOrigin;
  })
  | (SetupStateCommon & {
    readonly status: "spreadsheet_shared" | "complete";
    readonly spreadsheetId: string;
    readonly keyOrigin: KeyOrigin;
    /**
     * Non-secret provenance of the SA writer permission; required once the
     * share step is done so a resumed shared-but-unverified state keeps its
     * 403/404 propagation freshness.
     */
    readonly shareOrigin: ShareOrigin;
  });

/** Result of loading the checkpoint file from disk. */
export type LoadSetupStateResult =
  | { readonly status: "none" }
  | { readonly status: "loaded"; readonly state: SetupState }
  | { readonly status: "invalid"; readonly message: string };

/** Inputs the current run is compared against a loaded checkpoint. */
export interface StateCompatibilityInput {
  /** Explicit `--project`, or undefined when the checkpoint project is used. */
  readonly projectId: string | undefined;
  readonly saName: string;
  /** Explicit `--spreadsheet-title`, or undefined to accept the stored title. */
  readonly spreadsheetTitle: string | undefined;
  readonly keyPath: string;
  readonly ownerEmail: string;
}

/** Result of comparing a run against a loaded checkpoint. */
export type StateCompatibility =
  | { readonly status: "ok" }
  | { readonly status: "conflict"; readonly message: string };

/** Validated metadata of a service-account key JSON file. */
export interface ServiceAccountKeyMetadata {
  readonly projectId: string;
  readonly clientEmail: string;
  /** Non-secret `private_key_id`; matches the last segment of the IAM key resource name. */
  readonly keyId: string;
}

/**
 * Result of reading and validating a service-account key file.
 *
 * Only the descriptor-based secure reader is used; the plain pathname
 * reader was removed because a check-then-read sequence cannot be secured
 * against a mid-read alias swap.
 */
export type KeyMetadataResult =
  | { readonly status: "ok"; readonly metadata: ServiceAccountKeyMetadata }
  | { readonly status: "invalid"; readonly message: string };

/**
 * Result of the secure, descriptor-based key file read.
 *
 * `absent` means the path does not exist (the caller decides whether a
 * missing key is valid for the current checkpoint status); `invalid` means
 * the path exists but is not a regular file, could not be secured to mode
 * 0600, or does not parse as a service-account key for any project.
 */
export type SecureKeyReadResult =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly metadata: ServiceAccountKeyMetadata }
  | { readonly status: "invalid"; readonly message: string };

/**
 * Filesystem operations the secure checkpoint load uses; injectable for
 * tests (replacement-descriptor coverage without a racy real swap).
 *
 * Both `lstatSync` and `fstatSync` expose the device/inode so the load can
 * BIND the opened descriptor to the entry the lstat verified: a file
 * replaced between the type check and the open is refused before a single
 * byte is read.
 */
export interface SetupStateLoadFs {
  lstatSync(path: string): {
    isSymbolicLink(): boolean;
    isFile(): boolean;
    readonly dev: number;
    readonly ino: number;
  };
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): {
    isFile(): boolean;
    readonly dev: number;
    readonly ino: number;
  };
  readFileSync(fd: number, encoding: "utf8"): string;
  closeSync(fd: number): void;
}

/** The default filesystem for the secure checkpoint load. */
const defaultSetupStateLoadFs: SetupStateLoadFs = {
  lstatSync,
  openSync: (path, flags) => openSync(path, flags),
  fstatSync,
  readFileSync,
  closeSync,
};

/**
 * Loads and validates the checkpoint file through ONE descriptor boundary.
 *
 * A missing file is `none` (fresh run); a file that cannot be inspected,
 * opened, read, parsed, or validated is `invalid` so the flow can fail with
 * `setup_state_invalid` instead of guessing. The entry is lstat-verified as
 * a regular file first (a symlink is refused outright; directories, FIFOs,
 * sockets, and devices are refused too, so a FIFO can never block), then
 * opened with `O_NOFOLLOW` (where the platform defines it — a symlink
 * swapped in between the type check and the open fails with ELOOP/EMLINK
 * and is refused) plus `O_NONBLOCK` (where the platform defines it), and
 * the descriptor is fstat-verified as a regular file with the SAME
 * device/inode the lstat observed BEFORE a single byte is read — covering
 * a non-regular OR replaced entry between the lstat check and the open
 * and preventing a FIFO open/read from blocking. The descriptor is
 * closed in a `finally`. Error messages never include file contents.
 */
export function loadSetupState(
  statePath: string,
  fs: SetupStateLoadFs = defaultSetupStateLoadFs,
): LoadSetupStateResult {
  let lst: ReturnType<SetupStateLoadFs["lstatSync"]> | undefined;
  try {
    lst = fs.lstatSync(statePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "none" };
    }
    return { status: "invalid", message: `could not inspect ${statePath}: ${messageOf(error)}` };
  }
  if (lst.isSymbolicLink()) {
    return {
      status: "invalid",
      message: `refusing to follow a symlink at ${statePath}; remove it and retry`,
    };
  }
  if (!lst.isFile()) {
    // Directories, FIFOs, sockets, and devices are never opened or read: a
    // FIFO open without O_NONBLOCK would block indefinitely.
    return {
      status: "invalid",
      message: `${statePath} is not a regular file; remove it and retry`,
    };
  }
  let fd: number;
  try {
    fd = fs.openSync(statePath, constants.O_RDONLY | noFollowFlag() | nonBlockFlag());
  } catch (error) {
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
      // The entry became a symlink between the lstat check and the open
      // (or the platform lacks O_NOFOLLOW): refuse rather than follow.
      return {
        status: "invalid",
        message: `refusing to follow a symlink at ${statePath}; remove it and retry`,
      };
    }
    return { status: "invalid", message: `could not open ${statePath}: ${messageOf(error)}` };
  }
  let raw: string;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      // A non-regular entry replaced the checkpoint between the lstat check
      // and the open (e.g. a FIFO planted mid-run): refuse without reading
      // it (O_NONBLOCK made the open return instead of blocking on a FIFO).
      return {
        status: "invalid",
        message: `${statePath} is not a regular file; remove it and retry`,
      };
    }
    if (stat.dev !== lst.dev || stat.ino !== lst.ino) {
      // The descriptor is NOT the file the lstat verified: the entry was
      // replaced between the type check and the open. Refuse before a
      // single byte is read — a swapped alias must never contribute
      // checkpoint contents.
      return {
        status: "invalid",
        message: `${statePath} changed while loading; remove it and retry`,
      };
    }
    raw = fs.readFileSync(fd, "utf8");
  } catch (error) {
    return { status: "invalid", message: `could not read ${statePath}: ${messageOf(error)}` };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The read/validation error is the one to report.
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never forward the parse exception text: Node's JSON.parse failures
    // can include a snippet of the input, and the checkpoint is an
    // untrusted file that may contain token-like or key-like text.
    return { status: "invalid", message: `${statePath} is not valid JSON` };
  }

  const state = validateSetupState(parsed);
  if (state === null) {
    return {
      status: "invalid",
      message: `${statePath} does not match the setup state schema (version ${SETUP_STATE_VERSION})`,
    };
  }
  return { status: "loaded", state };
}

/**
 * Validates an untrusted checkpoint payload and promotes it into `SetupState`.
 *
 * Returns `null` when the payload is not a record, has the wrong version, a
 * missing/empty field, an unknown status, or spreadsheet fields missing from
 * a status that requires them. A stored `spreadsheetUrl` is rejected for
 * every status (the URL is derived from the id, so a stored one can only
 * disagree); a `creationMarker` outside `spreadsheet_create_started` and a
 * `spreadsheetId` before `spreadsheet_created` are contradictory and
 * rejected too.
 */
export function validateSetupState(value: unknown): SetupState | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.version !== SETUP_STATE_VERSION) {
    return null;
  }
  const status = value.status;
  if (
    status !== "project_selected" &&
    status !== "key_create_started" &&
    status !== "key_ready" &&
    status !== "spreadsheet_create_started" &&
    status !== "spreadsheet_created" &&
    status !== "spreadsheet_share_started" &&
    status !== "spreadsheet_shared" &&
    status !== "complete"
  ) {
    return null;
  }
  const common = extractCommonFields(value);
  if (common === null) {
    return null;
  }
  // The URL is derived from the id; a stored URL could disagree and is an
  // invalid shape for every status.
  if (value.spreadsheetUrl !== undefined) {
    return null;
  }
  if (status === "project_selected") {
    // A pre-key/pre-spreadsheet state carrying key or sheet fields is
    // contradictory (shareOrigin included: the share provenance is
    // unknown before the share step).
    if (
      value.spreadsheetId !== undefined ||
      value.creationMarker !== undefined ||
      value.keyMarker !== undefined ||
      value.keyBaseline !== undefined ||
      value.keyOrigin !== undefined ||
      value.shareOrigin !== undefined
    ) {
      return null;
    }
    return { ...common, status };
  }
  if (status === "key_create_started") {
    // The started state carries only the key marker and the baseline of
    // pre-existing user-managed key resource names; spreadsheet fields are
    // contradictory here, and keyOrigin is unknown until the key is
    // secured (a pre-secure state carrying it is a contradiction). Key
    // material is never stored.
    if (
      value.spreadsheetId !== undefined ||
      value.creationMarker !== undefined ||
      value.keyOrigin !== undefined ||
      value.shareOrigin !== undefined
    ) {
      return null;
    }
    const keyMarker = value.keyMarker;
    if (!isValidKeyMarker(keyMarker)) {
      return null;
    }
    const keyBaseline = value.keyBaseline;
    if (!isValidKeyBaseline(keyBaseline, common.projectId, common.saEmail)) {
      return null;
    }
    return { ...common, status, keyMarker, keyBaseline: [...keyBaseline] };
  }
  if (status === "key_ready") {
    // Key readiness is implied by this status and later: no key fields and
    // no spreadsheet fields may be carried, but the non-secret keyOrigin
    // provenance discriminant is REQUIRED from here on (the verify phase
    // depends on it across resumes). shareOrigin is unknown until the
    // share step, so a pre-share status carrying it is contradictory.
    if (
      value.spreadsheetId !== undefined ||
      value.creationMarker !== undefined ||
      value.keyMarker !== undefined ||
      value.keyBaseline !== undefined ||
      value.shareOrigin !== undefined
    ) {
      return null;
    }
    const keyOrigin = requireKeyOrigin(value.keyOrigin);
    if (keyOrigin === null) {
      return null;
    }
    return { ...common, status, keyOrigin };
  }
  if (status === "spreadsheet_create_started") {
    // The started state carries only the creation marker; the file id is
    // not known until the create response (or a marker reconciliation).
    // Key fields are contradictory: a spreadsheet state implies key
    // readiness. keyOrigin is required (see key_ready); shareOrigin is
    // unknown until the share step, so a pre-share state carrying it is
    // contradictory.
    if (
      value.spreadsheetId !== undefined ||
      value.keyMarker !== undefined ||
      value.keyBaseline !== undefined ||
      value.shareOrigin !== undefined
    ) {
      return null;
    }
    const creationMarker = value.creationMarker;
    if (!isValidCreationMarker(creationMarker)) {
      return null;
    }
    const keyOrigin = requireKeyOrigin(value.keyOrigin);
    if (keyOrigin === null) {
      return null;
    }
    return { ...common, status, creationMarker, keyOrigin };
  }
  const spreadsheetId = requireDriveId(value.spreadsheetId);
  if (spreadsheetId === null) {
    return null;
  }
  if (value.creationMarker !== undefined || value.keyMarker !== undefined || value.keyBaseline !== undefined) {
    // The markers are only meaningful while their create is in flight; a
    // spreadsheet-bearing status implies key readiness.
    return null;
  }
  const keyOrigin = requireKeyOrigin(value.keyOrigin);
  if (keyOrigin === null) {
    return null;
  }
  if (status === "spreadsheet_created" || status === "spreadsheet_share_started") {
    // The share step has not completed yet: a stored shareOrigin would be a
    // contradiction (the provenance is unknown until the permission is
    // ensured — `spreadsheet_share_started` is the write-ahead BEFORE that
    // ensure, so it must never carry a shareOrigin).
    if (value.shareOrigin !== undefined) {
      return null;
    }
    return { ...common, status, spreadsheetId, keyOrigin };
  }
  // spreadsheet_shared and complete: the share step is done, so the
  // non-secret shareOrigin provenance discriminant is REQUIRED (the verify
  // phase depends on it across resumes).
  const shareOrigin = requireShareOrigin(value.shareOrigin);
  if (shareOrigin === null) {
    return null;
  }
  return { ...common, status, spreadsheetId, keyOrigin, shareOrigin };
}

/** Promotes a validated `shareOrigin` value, or null when malformed. */
function requireShareOrigin(value: unknown): ShareOrigin | null {
  return value === "fresh" || value === "reused" ? value : null;
}

/** Requires a non-empty URL-safe Drive id for spreadsheet-bearing statuses. */
function requireDriveId(value: unknown): string | null {
  return isValidDriveId(value) ? value : null;
}

/** Promotes a validated `keyOrigin` value, or null when malformed. */
function requireKeyOrigin(value: unknown): KeyOrigin | null {
  return value === "created" || value === "reused" ? value : null;
}

/**
 * True when the value is a valid key baseline: an array of non-empty
 * service-account key resource names for THIS project and service account,
 * sorted strictly increasing (which also makes it deduplicated).
 */
function isValidKeyBaseline(value: unknown, projectId: string, saEmail: string): value is readonly string[] {
  if (!Array.isArray(value)) {
    return false;
  }
  let previous: string | undefined;
  for (const entry of value) {
    if (typeof entry !== "string" || !isServiceAccountKeyResourceName(entry, projectId, saEmail)) {
      return false;
    }
    if (previous !== undefined && entry <= previous) {
      // Not strictly increasing: unsorted or duplicated.
      return false;
    }
    previous = entry;
  }
  return true;
}

/**
 * True when a name is a user-managed service-account key resource name for
 * the given project and service account.
 *
 * The format is `projects/<project>/serviceAccounts/<email>/keys/<id>` with
 * a hex key id, as emitted by `gcloud iam service-accounts keys list
 * --format=value(name)`. The comparison uses exact string equality on the
 * project and email segments (no regex interpolation of user-controlled
 * text).
 */
export function isServiceAccountKeyResourceName(name: string, projectId: string, saEmail: string): boolean {
  const parts = name.split("/");
  return (
    parts.length === 6 &&
    parts[0] === "projects" &&
    parts[1] === projectId &&
    parts[2] === "serviceAccounts" &&
    parts[3] === saEmail &&
    parts[4] === "keys" &&
    SERVICE_ACCOUNT_KEY_ID_PATTERN.test(parts[5] ?? "")
  );
}

/** Extracts the fields shared by every status; null when any is missing/empty. */
function extractCommonFields(value: Record<string, unknown>): SetupStateCommon | null {
  const projectId = requireValidGcpProjectId(value.projectId);
  const projectMode = value.projectMode === "explicit" || value.projectMode === "generated" ? value.projectMode : null;
  const ownerEmail = requireNonEmptyString(value.ownerEmail);
  const saName = requireValidServiceAccountName(value.saName);
  const saEmail = requireNonEmptyString(value.saEmail);
  const keyPath = requireNonEmptyString(value.keyPath);
  const spreadsheetTitle = requireNonEmptyString(value.spreadsheetTitle);
  if (
    projectId === null ||
    projectMode === null ||
    ownerEmail === null ||
    saName === null ||
    saEmail === null ||
    keyPath === null ||
    spreadsheetTitle === null
  ) {
    return null;
  }
  // The stored saEmail must equal the CANONICAL derivation from the stored
  // saName and projectId: a checkpoint that disagrees (attacker-controlled
  // or corrupted) is invalid for every status, so a stored email can never
  // redirect key validation, reconciliation, or sharing to a different
  // service account. The promoted state therefore carries the email only
  // after this equality validation passed.
  if (saEmail !== serviceAccountEmail(saName, projectId)) {
    return null;
  }
  return {
    version: SETUP_STATE_VERSION,
    projectId,
    projectMode,
    ownerEmail,
    saName,
    saEmail,
    keyPath,
    spreadsheetTitle,
  };
}

/**
 * Filesystem operations used by the atomic private temp write; injectable
 * for tests.
 *
 * `chmodSync` is included so an injected regression can prove the pathname
 * chmod is never used — production applies and verifies the owner-only mode
 * through the still-open temp descriptor instead.
 */
export interface SetupStateWriteFs {
  openSync(path: string, flags: number, mode: number): number;
  fstatSync(fd: number): Stats;
  fchmodSync(fd: number, mode: number): void;
  /**
   * Descriptor write at a byte offset; returns the actual byte count written.
   *
   * `position` is `null` to write at (and advance) the current file
   * position. The contract matches `fs.writeSync(fd, buffer, offset,
   * length, position)` so the node implementation is assignable directly.
   */
  writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  lstatSync(path: string): Stats;
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
  /**
   * Opens the containing directory of a just-renamed file for its
   * durability fsync, with `O_NOFOLLOW`/`O_DIRECTORY` where the platform
   * defines them.
   */
  openDirSync(path: string, flags: number): number;
  /** Fsyncs an open directory descriptor so a completed rename is durable. */
  fsyncDirSync(fd: number): void;
  /** Never called by production; present so tests can prove the pathname chmod is unused. */
  chmodSync(path: string, mode: number): void;
}

/**
 * The default filesystem for the private temp write; exported so callers
 * (and tests) can build an injected `SetupStateWriteFs` around the real
 * operations.
 */
export const defaultSetupStateWriteFs: SetupStateWriteFs = {
  openSync,
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
  chmodSync: () => {
    // Production never pathname-chmods a temp file; this default exists only
    // to satisfy the interface for callers that do not inject a test fs.
    throw new Error("pathname chmod is not used by the private temp write");
  },
};

/**
 * Writes every UTF-8 byte of `content` to the descriptor, looping on short
 * writes.
 *
 * Works at the Buffer/byte level, so a partial write that splits a
 * multibyte character is still resumed at the exact byte offset and the
 * final content is byte-identical. A write that reports 0, a negative
 * value, a non-integer, or more bytes than remain is a safe failure (the
 * loop can never spin forever). Throws when the content cannot be fully
 * written; callers map the throw to their write-failed error.
 */
export function writeAllSync(
  fd: number,
  content: string,
  write: SetupStateWriteFs["writeSync"],
): void {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = write(fd, buffer, offset, buffer.length - offset, null);
    if (!Number.isInteger(written) || written <= 0 || written > buffer.length - offset) {
      throw new Error("the write made no progress; nothing was written");
    }
    offset += written;
  }
}

/**
 * Writes the checkpoint atomically with mode 0600 and exclusive temp
 * acquisition.
 *
 * The content is written to a unique sibling temp file (PID + UUID by
 * default; an explicit `tempPath` is accepted for tests) created with
 * `O_CREAT|O_EXCL|O_WRONLY` plus `O_NOFOLLOW` where supported, then renamed
 * over the target so readers never observe a partial file. Because the temp
 * name is unique per invocation, a crashed run leaves only an inert orphan
 * that never blocks the next save. The exclusive create is the only
 * acquisition path: a pre-existing temp entry — symlink, hardlink, or
 * regular file — is NEVER followed, truncated, or unlinked; the save fails
 * safely and leaves it untouched. Owner-only mode 0600 is applied and
 * verified THROUGH the still-open temp descriptor (`fchmod` + `fstat` on
 * the descriptor) before the content is written and fsynced, so the mode is
 * guaranteed regardless of the process umask and no pathname `chmod` is
 * ever performed. The write happens through the opened descriptor, is
 * fsynced and closed, and the path is re-verified against the created inode
 * before the rename, so an alias swapped in after the open can never be
 * renamed onto the state path. Cleanup after a failed rename removes only
 * the temp inode this invocation created. Throws on filesystem failure;
 * the flow maps the throw to `setup_state_write_failed`.
 */
export function saveSetupState(
  statePath: string,
  state: SetupState,
  tempPath: string = uniqueSetupStateTempPath(statePath),
  fs: SetupStateWriteFs = defaultSetupStateWriteFs,
): void {
  const content = `${JSON.stringify(state, null, 2)}\n`;
  let fd: number;
  let tempDev = 0;
  let tempIno = 0;
  try {
    fd = fs.openSync(tempPath, exclusiveTempOpenFlags(), SETUP_STATE_FILE_MODE);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      // A pre-existing temp file (symlink, hardlink, or regular) is left
      // exactly as found: never unlink, truncate, or write through it.
      throw new Error(
        `a file already exists at the checkpoint temp path ${tempPath}; remove it and retry`,
      );
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    tempDev = stat.dev;
    tempIno = stat.ino;
    // Owner-only mode is applied and verified on the STILL-OPEN descriptor
    // before any content is written, so the final mode never depends on the
    // process umask and a pathname chmod race is impossible.
    fs.fchmodSync(fd, SETUP_STATE_FILE_MODE);
    const secured = fs.fstatSync(fd);
    if ((Number(secured.mode) & 0o777) !== SETUP_STATE_FILE_MODE) {
      throw new Error(
        `could not verify owner-only permissions on the checkpoint temp file ${tempPath}`,
      );
    }
    writeAllSync(fd, content, fs.writeSync);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // The write error is the one to report.
    }
    // Clean up only the temp inode this invocation created.
    removeOwnedTempFile(tempPath, tempDev, tempIno, fs);
    throw error;
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    // A close failure after a successful write/fsync still leaves the temp
    // inode this invocation created: remove it (identity-checked) and
    // rethrow. The rename must never run after a failed close, and the
    // descriptor is never closed twice.
    removeOwnedTempFile(tempPath, tempDev, tempIno, fs);
    throw error;
  }
  // Re-verify the temp path still names the inode we created before the
  // rename; a swapped alias must never be renamed onto the checkpoint path.
  if (!pathNamesInode(tempPath, tempDev, tempIno, fs)) {
    removeOwnedTempFile(tempPath, tempDev, tempIno, fs);
    throw new Error(
      `the checkpoint temp path ${tempPath} changed while saving; nothing was written`,
    );
  }
  try {
    // The mode was already applied and verified on the descriptor above;
    // NO pathname chmod is performed here (a swapped alias must never
    // receive a chmod or be renamed onto the checkpoint path).
    fs.renameSync(tempPath, statePath);
  } catch (error) {
    removeOwnedTempFile(tempPath, tempDev, tempIno, fs);
    throw error;
  }
  // The rename is durable only after the containing directory is fsynced:
  // without it, a power loss right after the rename could leave the old
  // entry (or nothing) at the checkpoint path even though the rename
  // returned. A failure here reports the save as FAILED without attempting
  // any rollback — the checkpoint is already in place and the next run
  // loads it (a claimed-unsafe rollback could destroy the only copy of the
  // write-ahead state).
  fsyncParentDirectory(dirname(statePath), fs);
}

/**
 * Open flags for the exclusive checkpoint temp create.
 *
 * `O_EXCL` alone already fails with EEXIST when the temp path exists in any
 * form (including a dangling symlink), so a pre-existing entry is never
 * followed; `O_NOFOLLOW` (where the platform defines it) adds defense in
 * depth. The file is created with mode 0600.
 */
function exclusiveTempOpenFlags(): number {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow;
}

/**
 * Open flags for the durability fsync of a containing directory.
 *
 * `O_RDONLY` with `O_DIRECTORY`/`O_NOFOLLOW` where the platform defines
 * them: only a real directory is opened and a symlink planted at the
 * parent path is never followed.
 */
function directoryFsyncOpenFlags(): number {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const directory = (constants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  return constants.O_RDONLY | noFollow | directory;
}

/**
 * Fsyncs the containing directory of a just-renamed file so the rename is
 * durable across power loss.
 *
 * POSIX rename durability requires the directory entry change to be
 * flushed to stable storage; a directory fsync after the rename makes the
 * write-ahead checkpoint (and the `.env` output) survive a power loss.
 * The directory is opened WITHOUT following symlinks (`O_NOFOLLOW`) and
 * with `O_DIRECTORY` where the platform defines them, fsynced through the
 * descriptor, and closed exactly once. Open/fsync/close failures throw a
 * sanitized error; the caller must NOT roll back a completed rename — the
 * destination is already in place and the next run sees it.
 */
export function fsyncParentDirectory(parentPath: string, fs: SetupStateWriteFs): void {
  let dirFd: number;
  try {
    dirFd = fs.openDirSync(parentPath, directoryFsyncOpenFlags());
  } catch (error) {
    throw new Error(
      `could not open the directory containing ${parentPath} to make the rename durable: ${messageOf(error)}`,
    );
  }
  let fsyncError: unknown;
  try {
    fs.fsyncDirSync(dirFd);
  } catch (error) {
    fsyncError = error;
  }
  let closeError: unknown;
  try {
    fs.closeSync(dirFd);
  } catch (error) {
    closeError = error;
  }
  if (fsyncError !== undefined) {
    throw new Error(`could not make the rename at ${parentPath} durable: ${messageOf(fsyncError)}`);
  }
  if (closeError !== undefined) {
    throw new Error(`could not finalize the directory sync for ${parentPath}: ${messageOf(closeError)}`);
  }
}

/** True when the path currently names exactly the given device/inode. */
function pathNamesInode(path: string, dev: number, ino: number, fs: SetupStateWriteFs): boolean {
  try {
    const stat = fs.lstatSync(path);
    return stat.dev === dev && stat.ino === ino;
  } catch {
    return false;
  }
}

/**
 * Removes the temp file only when it is still the inode this invocation
 * created; a replaced or foreign entry is never touched.
 */
function removeOwnedTempFile(tempPath: string, dev: number, ino: number, fs: SetupStateWriteFs): void {
  try {
    if (pathNamesInode(tempPath, dev, ino, fs)) {
      fs.unlinkSync(tempPath);
    }
  } catch {
    // Missing or already replaced: nothing of ours to clean up.
  }
}

/**
 * Checks a loaded checkpoint against the current run's options and the
 * active human account.
 *
 * A checkpoint is bound to one human owner, project, service-account name,
 * spreadsheet title, and key path; any mismatch means the user is trying to
 * reuse state for a different setup and gets `setup_state_conflict` instead
 * of silently reusing foreign resources. The current run's identifiers are
 * validated against the canonical GCP formats here as defense in depth
 * (the CLI entry already rejects malformed `--project`/`--sa-name` values
 * before anything runs): an option-like or malformed identifier is a
 * conflict, never a silent proceed.
 */
export function checkStateCompatibility(
  state: SetupState,
  input: StateCompatibilityInput,
): StateCompatibility {
  if (!isValidServiceAccountName(input.saName)) {
    return {
      status: "conflict",
      message: `the service-account name "${input.saName}" is not a valid GCP service-account name`,
    };
  }
  if (input.projectId !== undefined && !isValidGcpProjectId(input.projectId)) {
    return {
      status: "conflict",
      message: `the project id "${input.projectId}" is not a valid GCP project id`,
    };
  }
  if (state.ownerEmail !== input.ownerEmail) {
    return {
      status: "conflict",
      message:
        `the setup state was created by ${state.ownerEmail} but the active gcloud ` +
        `account is ${input.ownerEmail}`,
    };
  }
  if (input.projectId !== undefined && state.projectId !== input.projectId) {
    return {
      status: "conflict",
      message:
        `the setup state uses project "${state.projectId}" but --project ` +
        `${input.projectId} was given`,
    };
  }
  if (state.saName !== input.saName) {
    return {
      status: "conflict",
      message:
        `the setup state uses service-account name "${state.saName}" but --sa-name ` +
        `${input.saName} was given`,
    };
  }
  if (input.spreadsheetTitle !== undefined && state.spreadsheetTitle !== input.spreadsheetTitle) {
    return {
      status: "conflict",
      message:
        `the setup state uses spreadsheet title "${state.spreadsheetTitle}" but ` +
        `--spreadsheet-title ${input.spreadsheetTitle} was given`,
    };
  }
  if (state.keyPath !== input.keyPath) {
    return {
      status: "conflict",
      message: `the setup state records key path "${state.keyPath}" but this run uses ${input.keyPath}`,
    };
  }
  return { status: "ok" };
}

/**
 * Parses and validates raw service-account key JSON (no filesystem access).
 *
 * Shared by the secure descriptor read and by tests. The key material is
 * never returned; only the non-secret metadata is promoted. The validated
 * in-memory key material is available to the credential reader
 * (`readServiceAccountKeyCredentialSecurely`) for the SA verify phase.
 */
export function parseServiceAccountKeyJson(raw: string, sourceLabel: string): KeyMetadataResult {
  const result = parseServiceAccountKeyPayload(raw, sourceLabel);
  if (result.status === "invalid") {
    return result;
  }
  const { projectId, clientEmail, keyId } = result.payload;
  return { status: "ok", metadata: { projectId, clientEmail, keyId } };
}

/** Validated fields of a service-account key payload. */
interface ServiceAccountKeyPayload {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly keyId: string;
  readonly privateKey: string;
}

/** Result of parsing a raw key payload. */
type KeyPayloadResult =
  | { readonly status: "ok"; readonly payload: ServiceAccountKeyPayload }
  | { readonly status: "invalid"; readonly message: string };

/**
 * Parses and validates raw service-account key JSON, keeping the validated
 * private key in memory for the credential reader.
 *
 * The shared validation core of `parseServiceAccountKeyJson`: JSON shape,
 * RSA private key, project, client email, and non-secret key id. The
 * private key is only ever promoted into process memory (never into a
 * result, message, or the checkpoint); the metadata reader discards it and
 * the credential reader hands it to the SA access verifier for one run.
 */
function parseServiceAccountKeyPayload(raw: string, sourceLabel: string): KeyPayloadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never forward the parse exception text: Node's JSON.parse failures
    // can include a snippet of the input, and a key file is untrusted
    // (it may contain arbitrary text in place of key material).
    return { status: "invalid", message: `${sourceLabel} is not valid JSON` };
  }

  if (!isRecord(parsed)) {
    return { status: "invalid", message: `${sourceLabel} is not a service-account key file` };
  }
  const { type, project_id, client_email, private_key, private_key_id } = parsed;
  if (
    type !== "service_account" ||
    typeof project_id !== "string" ||
    project_id === "" ||
    typeof client_email !== "string" ||
    client_email === "" ||
    typeof private_key !== "string" ||
    private_key === "" ||
    typeof private_key_id !== "string" ||
    !SERVICE_ACCOUNT_KEY_ID_PATTERN.test(private_key_id)
  ) {
    return { status: "invalid", message: `${sourceLabel} is not a service-account key file` };
  }
  if (!isValidRsaPrivateKey(private_key)) {
    return { status: "invalid", message: `${sourceLabel} contains an invalid or non-RSA private key` };
  }
  return {
    status: "ok",
    payload: {
      projectId: project_id,
      clientEmail: client_email,
      keyId: private_key_id,
      privateKey: private_key,
    },
  };
}

/**
 * Filesystem operations the secure key read uses; injectable for tests.
 */
export interface KeyFileFs {
  lstatSync(path: string): Stats;
  openSync(path: string, flags: number): number;
  fchmodSync(fd: number, mode: number): void;
  fstatSync(fd: number): Stats;
  readFileSync(fd: number, encoding: "utf8"): string;
  closeSync(fd: number): void;
}

const defaultKeyFileFs: KeyFileFs = {
  lstatSync,
  openSync,
  fchmodSync,
  fstatSync,
  readFileSync,
  closeSync,
};

/**
 * Securely reads an existing service-account key file through ONE
 * descriptor boundary and enforces owner-only mode 0600.
 *
 * A missing file is `absent`. An existing entry must be a regular file (a
 * symlink is refused outright; directories, FIFOs, and sockets are refused
 * too). The file is opened with `O_NOFOLLOW` (where the platform defines it
 * — a symlink swapped in between the type check and the open fails with
 * ELOOP/EMLINK and is refused) plus `O_NONBLOCK` (where the platform
 * defines it — a FIFO swapped in between the type check and the open
 * returns from the open instead of blocking), the descriptor is
 * fstat-verified as a regular file with the SAME device/inode the lstat
 * observed BEFORE any fchmod (a directory, FIFO, socket, device, or
 * replaced-file entry is refused with zero chmod and zero read calls), and
 * only then is mode 0600 applied THROUGH the open descriptor
 * with `fchmod` and the resulting mode verified on the same descriptor
 * before a single byte is read — never an existsSync/readFileSync
 * check-then-use sequence, so an alias planted mid-read cannot receive the
 * chmod or be read through. Only after the descriptor is secured is the
 * content parsed and validated (JSON shape, RSA private key, project,
 * client email, and non-secret key id). Any inspect/open/type/chmod/read/
 * parse failure fails closed with a stable path-only message that never
 * contains raw error text or key material, and the descriptor is closed
 * exactly once (a close failure never overrides the verdict). Supported
 * platforms (macOS/Linux) can
 * enforce owner-only modes; Windows automatic setup is refused before this
 * code runs.
 */
export function readServiceAccountKeySecurely(
  keyPath: string,
  fs: KeyFileFs = defaultKeyFileFs,
): SecureKeyReadResult {
  const result = readServiceAccountKeyPayloadSecurely(keyPath, fs);
  if (result.status === "absent" || result.status === "invalid") {
    return result;
  }
  const { projectId, clientEmail, keyId } = result.payload;
  return { status: "ok", metadata: { projectId, clientEmail, keyId } };
}

/**
 * Result of the secure, descriptor-based key credential read.
 *
 * Same descriptor boundary as `readServiceAccountKeySecurely`, but the
 * validated `private_key` is promoted into process memory for the SA
 * access verify phase: the verifier is given the credentials in memory and
 * NEVER reopens the key pathname, so a mid-run replacement cannot redirect
 * it. The key material exists only in memory for the run; it is never
 * returned by the setup result, never written to the checkpoint or `.env`,
 * and never included in any error message.
 */
export type SecureKeyCredentialReadResult =
  | { readonly status: "absent" }
  | {
    readonly status: "ok";
    readonly credentials: {
      readonly projectId: string;
      readonly clientEmail: string;
      readonly privateKey: string;
    };
  }
  | { readonly status: "invalid"; readonly message: string };

/**
 * Securely reads an existing service-account key file and promotes the
 * validated credential into process memory.
 *
 * Identical descriptor security to `readServiceAccountKeySecurely`
 * (regular file, no-follow, non-block, lstat/fstat inode binding, owner-only
 * 0600 through the descriptor before any read, sanitized failures), but
 * the returned credentials carry the validated `privateKey` so the SA
 * access verifier can authenticate from memory. The private key is only in
 * process memory for the run and never appears in results, messages, the
 * checkpoint, or the `.env` file.
 */
export function readServiceAccountKeyCredentialSecurely(
  keyPath: string,
  fs: KeyFileFs = defaultKeyFileFs,
): SecureKeyCredentialReadResult {
  const result = readServiceAccountKeyPayloadSecurely(keyPath, fs);
  if (result.status === "absent" || result.status === "invalid") {
    return result;
  }
  const { projectId, clientEmail, privateKey } = result.payload;
  return { status: "ok", credentials: { projectId, clientEmail, privateKey } };
}

/**
 * The secure descriptor read shared by the metadata and credential
 * readers; see `readServiceAccountKeySecurely` for the full contract.
 */
function readServiceAccountKeyPayloadSecurely(
  keyPath: string,
  fs: KeyFileFs,
): SecureKeyPayloadReadResult {
  let lst: ReturnType<typeof lstatSync> | undefined;
  try {
    lst = fs.lstatSync(keyPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "absent" };
    }
    // Generic path-only diagnostic: arbitrary thrown text from this
    // injected/filesystem stage (which may carry token or key sentinels)
    // must never reach the result.
    return { status: "invalid", message: `could not inspect ${keyPath}` };
  }
  if (lst === undefined) {
    // Unreachable: lstatSync either assigned or the catch returned above.
    return { status: "invalid", message: `could not inspect ${keyPath}` };
  }
  if (lst.isSymbolicLink()) {
    return {
      status: "invalid",
      message: `refusing to follow a symlink at ${keyPath}; remove it and retry`,
    };
  }
  if (!lst.isFile()) {
    return {
      status: "invalid",
      message: `${keyPath} is not a regular file; remove it and retry`,
    };
  }
  let fd: number;
  try {
    fd = fs.openSync(keyPath, constants.O_RDONLY | noFollowFlag() | nonBlockFlag());
  } catch (error) {
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
      return {
        status: "invalid",
        message: `refusing to follow a symlink at ${keyPath}; remove it and retry`,
      };
    }
    // Generic path-only diagnostic: arbitrary thrown text from this
    // injected/filesystem stage (which may carry token or key sentinels)
    // must never reach the result. There is no descriptor to close here.
    return { status: "invalid", message: `could not open ${keyPath}` };
  }
  try {
    // The descriptor is fstat-verified as a REGULAR FILE immediately after
    // the open and BEFORE any fchmod: a directory, FIFO, socket, or device
    // swapped in between the lstat check and the open (O_NONBLOCK made the
    // open return instead of blocking on a FIFO) is refused with zero
    // chmod and zero read calls, so a directory replacement never receives
    // a mode change through this descriptor.
    let stat: ReturnType<KeyFileFs["fstatSync"]>;
    try {
      stat = fs.fstatSync(fd);
    } catch {
      // Generic path-only diagnostic: arbitrary thrown text from this
      // injected/filesystem stage must never reach the result.
      return {
        status: "invalid",
        message: `could not verify owner-only permissions on ${keyPath}`,
      };
    }
    if (!stat.isFile()) {
      return {
        status: "invalid",
        message: `${keyPath} is not a regular file; remove it and retry`,
      };
    }
    if (lst.dev !== stat.dev || lst.ino !== stat.ino) {
      // The descriptor is NOT the file the lstat verified: the entry was
      // replaced between the type check and the open. Refuse BEFORE any
      // fchmod or read — a swapped alias must never receive the chmod or
      // contribute key material.
      return {
        status: "invalid",
        message: `${keyPath} changed while being read; remove it and retry`,
      };
    }
    // Only a verified regular file is secured: mode 0600 is applied
    // THROUGH the open descriptor and the resulting mode is verified on
    // the same descriptor before a single byte is read.
    try {
      fs.fchmodSync(fd, SERVICE_ACCOUNT_KEY_FILE_MODE);
    } catch {
      // Generic path-only diagnostic: arbitrary thrown text from this
      // injected/filesystem stage (or the injected chmod failure) must
      // never reach the result.
      return {
        status: "invalid",
        message: `could not secure ${keyPath} to owner-only mode`,
      };
    }
    try {
      stat = fs.fstatSync(fd);
    } catch {
      // Generic path-only diagnostic: arbitrary thrown text from this
      // injected/filesystem stage must never reach the result.
      return {
        status: "invalid",
        message: `could not verify owner-only permissions on ${keyPath}`,
      };
    }
    const mode = Number(stat.mode);
    if (!stat.isFile() || (mode & 0o777) !== SERVICE_ACCOUNT_KEY_FILE_MODE) {
      return {
        status: "invalid",
        message: `could not verify owner-only permissions on ${keyPath}`,
      };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(fd, "utf8");
    } catch {
      // Generic path-only diagnostic: the file is untrusted, so its read
      // failure text is never forwarded.
      return { status: "invalid", message: `could not read ${keyPath}` };
    }
    return parseServiceAccountKeyPayload(raw, keyPath);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The validation result is the one to report.
    }
  }
}

/** Result of the shared secure payload read. */
type SecureKeyPayloadReadResult =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly payload: ServiceAccountKeyPayload }
  | { readonly status: "invalid"; readonly message: string };

/** `O_NOFOLLOW` where the platform defines it, else 0. */
function noFollowFlag(): number {
  return (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

/** `O_DIRECTORY` where the platform defines it, else 0. */
function directoryFlag(): number {
  return (constants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
}

/** `O_NONBLOCK` where the platform defines it, else 0. */
function nonBlockFlag(): number {
  return (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
}

/**
 * True when the PEM parses as an RSA private key.
 *
 * The parsed key object is discarded immediately; only the type verdict is
 * returned and the key material never leaves this function.
 */
function isValidRsaPrivateKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}

/** Filesystem operations the exclusive setup lock uses; injectable for tests. */
export interface LockFs {
  mkdirSync(path: string, options: { readonly mode: number }): void;
  lstatSync(path: string): {
    readonly dev: number;
    readonly ino: number;
    isDirectory(): boolean;
  };
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): {
    readonly dev: number;
    readonly ino: number;
    isDirectory(): boolean;
  };
  closeSync(fd: number): void;
  rmdirSync(path: string): void;
}

const defaultLockFs: LockFs = {
  mkdirSync,
  lstatSync,
  openSync,
  fstatSync,
  closeSync,
  rmdirSync,
};

/** Identity of the lock directory a run created (device/inode). */
export interface LockIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** Result of acquiring the exclusive setup lock. */
export type SetupLockResult =
  | { readonly status: "held"; readonly identity: LockIdentity }
  | { readonly status: "busy"; readonly message: string }
  | { readonly status: "failed"; readonly message: string };

/**
 * Acquires the exclusive setup lock as an EMPTY DIRECTORY (mode 0700).
 *
 * `mkdir` is atomic create-or-fail, so a second process can never acquire
 * while the owner holds the lock and no metadata needs to be stored inside
 * (none is). An EEXIST — a pre-existing file, directory, or symlink — is
 * `busy` (`setup_in_progress`) and the entry is never read, removed, or
 * replaced, regardless of what it is; automatic stale-lock takeover is
 * deliberately disabled because a probe-then-remove takeover is racy.
 * Any other acquire failure (EACCES, ENOENT, EROFS, ...) is `failed`
 * (`setup_lock_failed`), never `busy`. The returned identity is the
 * device/inode of the directory created; `releaseSetupLock` removes only
 * that exact directory, so a replacement acquired after release is never
 * deleted.
 */
export function acquireSetupLock(lockPath: string, fs: LockFs = defaultLockFs): SetupLockResult {
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return { status: "busy", message: busyLockMessage(lockPath) };
    }
    return {
      status: "failed",
      message: `could not create the setup lock directory ${lockPath}: ${messageOf(error)}`,
    };
  }
  try {
    const stat = fs.lstatSync(lockPath);
    return { status: "held", identity: { dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    // The directory we just created cannot be inspected; remove it and fail
    // closed rather than hold a lock of unknown identity.
    try {
      fs.rmdirSync(lockPath);
    } catch {
      // Best-effort; the acquire failure is the one to report.
    }
    return {
      status: "failed",
      message: `could not verify the setup lock directory ${lockPath}: ${messageOf(error)}`,
    };
  }
}

/**
 * Releases the setup lock by removing the exact directory this run created.
 *
 * The directory is opened WITHOUT following symlinks (`O_NOFOLLOW` where
 * the platform defines it) and its identity/type are verified THROUGH the
 * opened descriptor before the `rmdir`: a replacement lock acquired by
 * another process after this run's directory disappeared — or a symlink
 * planted at the path — is never deleted. Node offers no atomic
 * owner-bound directory removal (no `rmdirat`/`unlinkat` without a raw
 * libuv binding), so this descriptor-verified check-then-remove is the
 * strengthened boundary; the setup lock's own semantics (an empty
 * directory that is non-removable and non-reacquirable until the owner
 * removes it) keep cooperating setup runs from racing. On uncertain
 * identity the release FAILS CLOSED: a leftover lock directory simply
 * fails the next acquire with `busy` until removed manually. Never
 * throws; failures are ignored because a leftover lock directory is never
 * deleted on uncertain identity.
 */
export function releaseSetupLock(lockPath: string, identity: LockIdentity, fs: LockFs = defaultLockFs): void {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, constants.O_RDONLY | noFollowFlag() | directoryFlag());
  } catch {
    // Missing, or replaced by an entry that cannot be opened as a
    // directory (file, symlink, ...): nothing is removed on uncertain
    // identity.
    return;
  }
  let stat: { readonly dev: number; readonly ino: number; isDirectory(): boolean };
  try {
    stat = fs.fstatSync(fd);
  } catch {
    try {
      fs.closeSync(fd);
    } catch {
      // Best-effort; the release verdict is already decided.
    }
    return;
  }
  if (stat.dev !== identity.dev || stat.ino !== identity.ino || !stat.isDirectory()) {
    try {
      fs.closeSync(fd);
    } catch {
      // Best-effort; a foreign lock is not ours to touch.
    }
    return;
  }
  try {
    fs.rmdirSync(lockPath);
  } catch {
    // Best-effort release; a failed rmdir leaves a leftover lock, never a
    // wrong deletion.
  }
  try {
    fs.closeSync(fd);
  } catch {
    // Best-effort; the release verdict is already decided.
  }
}

/** Guidance for a busy lock; never includes any lock contents. */
function busyLockMessage(lockPath: string): string {
  return (
    `another hikoutei setup appears to be running (lock directory ${lockPath}); wait for ` +
    `it to finish. A leftover lock directory is never removed automatically: if you are ` +
    `certain no setup is running, remove the lock directory and retry`
  );
}

/** Generates a fresh creation marker for one setup run. */
export function generateCreationMarker(): string {
  return randomUUID();
}

function requireNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Requires a well-formed GCP project id (the canonical format guard). */
function requireValidGcpProjectId(value: unknown): string | null {
  return isValidGcpProjectId(value) ? value : null;
}

/** Requires a well-formed service-account name (the canonical format guard). */
function requireValidServiceAccountName(value: unknown): string | null {
  return isValidServiceAccountName(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
