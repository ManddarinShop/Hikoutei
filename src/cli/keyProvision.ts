/**
 * Service-account key write-ahead provisioning and reconciliation for
 * `hikoutei setup`.
 *
 * The key create is a real typed write-ahead state, not an ad-hoc nullable
 * shape: before the first gcloud key create the flow lists the user-managed
 * keys of the service account (`gcloud iam service-accounts keys list
 * --managed-by=user`, which keeps the list to user-owned keys only) with a
 * stable machine-readable format (`--format=value(name)`), validates the
 * output, and persists a checkpoint
 * status `key_create_started` carrying a UUID key marker and the sorted/
 * deduplicated baseline of pre-existing key resource names. The marker
 * derives a DETERMINISTIC private sibling staging directory
 * (`.hikoutei-key-stage-<marker>`), so a crash at any boundary — before
 * gcloud, after the remote/local create, after the atomic hardlink install,
 * before/after staged cleanup, before `key_ready` — resumes by reconciling
 * the staged and/or final key file against the current user-managed key
 * list instead of creating a second key.
 *
 * Reconciliation rules (fail closed, never auto-delete a cloud key or a
 * local credential):
 * - a staged key that validates (JSON/RSA/project/email and non-secret
 *   `private_key_id`) and corresponds to an ACTIVE user-managed key is
 *   installed/recovered without creating another;
 * - a final key that validates and is active finishes cleanup and promotes;
 * - every current post-baseline key must be represented by a securely
 *   validated local credential: an unmatched delta entry (a cloud key this
 *   setup neither created nor can identify) fails with
 *   `key_create_uncertain` BEFORE any install, cleanup, or promotion;
 * - only the same invocation that JUST persisted a fresh
 *   `key_create_started` checkpoint may issue the ONE key create; any
 *   invocation loaded from an existing `key_create_started` checkpoint is
 *   reconcile-only and NEVER creates, even when no stage/final/delta is
 *   visible;
 * - after the ONE fresh create call (whatever its result), and on every
 *   reconcile-only resume, the flow performs an immediate post-create
 *   settlement check and then re-checks `keys list` plus staged/final
 *   evidence after the schedule 2, 4, 8, 16, 30, 30, 30 seconds — exactly
 *   eight post-create evidence checks, at most 120 seconds of waiting. If
 *   a recoverable credential or cloud key appears it is settled; if all
 *   checks still show no local credential and no post-baseline key, the
 *   run stays `key_create_uncertain` and the create is NEVER retried
 *   automatically — a user who has verified/removed an orphan must
 *   intentionally reset the key checkpoint rather than have setup guess;
 * - an invalid, mismatched, or inactive staged/final file fails closed and
 *   is retained securely (never blindly removed).
 *
 * gcloud nonzero/throw/lost-result cases are treated the same way: the
 * deterministic stage and the current key list are inspected, and any only
 * credential for an active key is preserved. A thrown keys-list invocation
 * fails with the sanitized `key_create_failed` (baseline) or
 * `key_create_uncertain` (resume/reconcile) code; a thrown key-create
 * invocation is reconciled exactly like a lost result. Thrown or stream
 * text is never forwarded.
 *
 * The deterministic staging directory is owner-only (0700) before gcloud
 * may write a credential into it: a pre-existing directory is verified as
 * a plain directory and its mode enforced through a no-follow descriptor;
 * unsafe types or permission failures reject the run without touching
 * foreign entries. The key create runs gcloud with a RELATIVE `key.json`
 * destination from the staging directory as the subprocess working
 * directory (runner `cwd`), with the staging directory re-verified
 * (type/mode/identity through a no-follow descriptor) IMMEDIATELY before
 * the spawn; the credential write is thereby bound to the validated
 * private staging directory for cooperating setup actors, and a
 * replacement at the staging pathname is never silently trusted. The same parent validation runs BEFORE the staged key is ever read during reconciliation: `key.json` is never inspected,
 * opened, chmod'ed, or read unless its deterministic parent is absent or a
 * plain directory verified/secured to 0700 through the no-follow
 * descriptor, and a symlinked or non-directory stage parent fails closed
 * with `key_create_failed` before the key list, create, install, or
 * cleanup can run (the foreign target is never followed, chmod'ed, or
 * read). The install step re-verifies the stage directory identity
 * captured at inspection before the atomic hard link.
 *
 * Staged cleanup happens only after a verified installation and is
 * ownership-bound and crash-resumable: the final key path is verified with
 * lstat (a final symlink is refused), the deterministic stage directory is
 * atomically quarantined to a deterministic private cleanup sibling path
 * (derived from the same persisted key marker) with the device/inode
 * captured before the rename verified after it, and the staged entry is
 * re-checked inside the quarantined 0700 directory as a regular file with
 * the same device/inode as the no-follow final key immediately before its
 * unlink; only that owned link is unlinked and only the then-empty owned
 * directory is rmdir'd. A crash at any boundary resumes: a crash-left
 * cleanup directory with the matching staged hardlink is finished, an
 * empty cleanup directory is rmdir'd, and an absent stage + cleanup pair
 * means the cleanup already completed. Both existing at once fails closed.
 * Foreign or non-empty entries are preserved (fail closed, never deleted
 * recursively). Node offers no literal unlinkat without a raw libuv
 * binding, so this quarantine + post-rename identity design is the
 * permitted boundary for the unlink race: the setup lock is held for the
 * whole run (a second setup process cannot acquire it concurrently), and
 * the cleanup path is derived from the persisted marker, so only runs
 * resuming THIS checkpoint ever touch the quarantined directory. If
 * cleanup cannot be confirmed the run fails safely with the
 * `key_create_started` checkpoint retained, so a resume never creates a
 * new key.
 *
 * Key material never appears in messages, results, or the checkpoint; only
 * paths, the non-secret key id, and resource names are referenced.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  isServiceAccountKeyResourceName,
  readServiceAccountKeySecurely,
  type SecureKeyReadResult,
  type ServiceAccountKeyMetadata,
} from "./checkpoint.js";
import { SETUP_ERROR_CODES } from "./errors.js";
import { describeGcloudFailure, errorResult, outcomeOf, type PlannedCommand, type SetupErrorResult } from "./flowResult.js";
import type { GcloudRunner, GcloudRunResult } from "./gcloudRunner.js";

/** Prefix of the deterministic private sibling staging directory for a key. */
export const KEY_STAGE_DIR_PREFIX = ".hikoutei-key-stage-";

/**
 * Prefix of the deterministic private sibling cleanup directory for a key.
 *
 * The cleanup path is derived from the SAME persisted key marker as the
 * staging path (never an unrecoverable random name), so a crash between
 * the quarantine rename and the staged unlink/rmdir resumes on the next
 * run without losing track of the quarantined directory.
 */
export const KEY_CLEANUP_DIR_PREFIX = ".hikoutei-key-cleanup-";

/** File name of the staged key inside the staging directory. */
export const KEY_STAGE_FILE_NAME = "key.json";

/**
 * Dry-run placeholder for the gcloud key create destination.
 *
 * The real staging path is derived from a per-run UUID marker and is never
 * promised byte-for-byte in a plan; the placeholder makes it explicit that
 * the final key path is never the gcloud destination.
 */
export const KEY_STAGE_PLACEHOLDER = "<private-key-staging-dir>/key.json";

/** Stable argv for listing the user-managed keys of a service account. */
export const KEY_LIST_COMMAND = [
  "iam",
  "service-accounts",
  "keys",
  "list",
  // `--managed-by` accepts only `user`, `system`, or `any`; `user` keeps
  // the list to user-managed keys (system keys are Google-owned and must
  // never be touched or matched by setup).
  "--managed-by=user",
  "--format=value(name)",
] as const;

/** Deterministic private sibling staging directory for a key marker. */
export function keyStageDir(keyPath: string, keyMarker: string): string {
  return join(dirname(keyPath), `${KEY_STAGE_DIR_PREFIX}${keyMarker}`);
}

/** Deterministic private sibling cleanup directory for a key marker. */
export function keyCleanupDir(keyPath: string, keyMarker: string): string {
  return join(dirname(keyPath), `${KEY_CLEANUP_DIR_PREFIX}${keyMarker}`);
}

/** Deterministic staged key path for a key marker. */
export function stagedKeyPath(keyPath: string, keyMarker: string): string {
  return join(keyStageDir(keyPath, keyMarker), KEY_STAGE_FILE_NAME);
}

/** IAM resource name of a user-managed key with the given non-secret id. */
export function keyResourceNameFor(projectId: string, saEmail: string, keyId: string): string {
  return `projects/${projectId}/serviceAccounts/${saEmail}/keys/${keyId.toLowerCase()}`;
}

/**
 * Parses and validates the machine-readable output of the keys list
 * command.
 *
 * Every non-empty line must be a user-managed key resource name for the
 * expected project and service account; anything else is refused (the
 * caller treats the list as unusable). Each accepted name is normalized
 * (the hex key-id segment is case-folded) so baseline comparisons and
 * local-file matching against `keyResourceNameFor` are exact regardless of
 * the id casing gcloud emits. The returned list is sorted and
 * deduplicated so it can be stored as a checkpoint baseline.
 */
export function parseUserManagedKeyList(
  stdout: string,
  projectId: string,
  saEmail: string,
): readonly string[] | null {
  const names: string[] = [];
  for (const line of stdout.split("\n")) {
    const name = line.trim();
    if (name === "") {
      continue;
    }
    if (!isServiceAccountKeyResourceName(name, projectId, saEmail)) {
      return null;
    }
    // Rebuild from the validated segments with the key id case-folded; the
    // project and email segments are already exact string matches.
    const parts = name.split("/");
    names.push(`projects/${parts[1]}/serviceAccounts/${parts[3]}/keys/${(parts[5] ?? "").toLowerCase()}`);
  }
  return [...new Set(names)].sort();
}

/**
 * Lists the user-managed keys of the service account and validates the
 * output; never forwards raw gcloud stream content.
 *
 * A thrown runner (spawn failure, transport error) is treated exactly like
 * a failed invocation: the run fails with the purpose-appropriate stable
 * code (`key_create_failed` for a baseline, `key_create_uncertain` for a
 * reconcile) and no secret-bearing text ever reaches the message.
 */
export async function listUserManagedServiceAccountKeys(
  runner: GcloudRunner,
  executed: PlannedCommand[],
  input: { readonly projectId: string; readonly saEmail: string; readonly purpose: "baseline" | "reconcile" },
): Promise<{ readonly status: "ok"; readonly names: readonly string[] } | { readonly status: "error"; readonly error: SetupErrorResult }> {
  const command = [
    ...KEY_LIST_COMMAND,
    "--iam-account",
    input.saEmail,
    "--project",
    input.projectId,
  ];
  const failCode =
    input.purpose === "baseline" ? SETUP_ERROR_CODES.KEY_CREATE_FAILED : SETUP_ERROR_CODES.KEY_CREATE_UNCERTAIN;
  let result: GcloudRunResult;
  try {
    result = await runner.run(command);
  } catch {
    // The invocation threw (spawn/transport failure): the outcome is
    // unknown, and for a reconcile the checkpoint/stage must be preserved
    // for the next run. The thrown text is never forwarded.
    return {
      status: "error",
      error: errorResult(
        failCode,
        `gcloud could not list the user-managed keys of ${input.saEmail}; nothing was created or ` +
          `deleted — rerun setup`,
      ),
    };
  }
  if (result.status !== "ok") {
    return {
      status: "error",
      error: errorResult(
        failCode,
        `could not list user-managed service-account keys for ${input.saEmail}: ${describeGcloudFailure(result)}; ` +
          `nothing was created or deleted — rerun setup`,
      ),
    };
  }
  const names = parseUserManagedKeyList(result.stdout, input.projectId, input.saEmail);
  if (names === null) {
    return {
      status: "error",
      error: errorResult(
        failCode,
        `gcloud returned an unreadable list of user-managed keys for ${input.saEmail}; nothing was created or deleted — rerun setup`,
      ),
    };
  }
  executed.push({
    kind: "gcloud",
    command,
    outcome: `${names.length} user-managed key(s) listed (${input.purpose})`,
  });
  return { status: "ok", names };
}

/**
 * Delays in milliseconds between the post-create key-settlement checks.
 *
 * After the ONE fresh key create (whatever its result) — and on every
 * reconcile-only resume — the flow performs an immediate post-create
 * settlement check and then re-checks `keys list` plus staged/final
 * evidence after these seven delays: exactly eight post-create evidence
 * checks in total, at most 120 seconds of waiting. This is the same
 * safety-class schedule the SA access verify phase uses.
 */
export const KEY_SETTLE_POLL_DELAYS_MS = [2000, 4000, 8000, 16000, 30000, 30000, 30000] as const;

/** Injectable timer used between key-settlement propagation checks. */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

/** Production sleeper: waits with `setTimeout` so the bounded poll actually waits. */
export const realSleeper: Sleeper = {
  sleep(ms: number): Promise<void> {
    return new Promise((resolveSleep) => {
      setTimeout(resolveSleep, ms);
    });
  },
};

/** Inputs shared by the key create/reconcile helpers. */
interface KeySettleInput {
  readonly keyPath: string;
  readonly projectId: string;
  readonly saEmail: string;
  /** Key marker persisted in the `key_create_started` checkpoint. */
  readonly keyMarker: string;
  /** Baseline of pre-existing user-managed key resource names from the checkpoint. */
  readonly baseline: readonly string[];
  /**
   * `fresh`: this invocation JUST persisted the `key_create_started`
   * checkpoint and may issue the ONE key-create call. `reconcile`: the
   * invocation loaded the checkpoint from an existing file and must never
   * issue a create, even when no stage/final/delta is visible.
   */
  readonly createPermission: KeyCreatePermission;
  /** Timer for the bounded propagation poll; injectable so tests are instant. */
  readonly sleeper: Sleeper;
}

/**
 * Whether this invocation may issue the single key create.
 *
 * Explicit fresh-vs-reconcile semantics: a lagging IAM key list must never
 * permit a duplicate, so only the invocation that just persisted a fresh
 * `key_create_started` checkpoint may create; every resume is
 * reconcile-only.
 */
export type KeyCreatePermission = "fresh" | "reconcile";

/** Outcome of settling the key state. */
export type KeySettleOutcome =
  | { readonly status: "ok"; readonly keyReused: boolean }
  | { readonly status: "error"; readonly error: SetupErrorResult };

/**
 * Settles (or performs) the service-account key create and settles the
 * key state.
 *
 * Inspects the deterministic staged key and the final key with the secure
 * descriptor read (regular file, no-follow, owner-only mode 0600 enforced),
 * lists and validates the current user-managed keys, and applies the
 * reconciliation rules documented at the top of this module. `fresh`
 * permission issues exactly ONE create attempt, and only when this
 * invocation JUST persisted the `key_create_started` checkpoint; every
 * other path is reconcile-only and never creates. The first pass is the
 * pre-create evidence check (and, for `fresh`, carries the one create).
 * When no credential and no post-baseline key are visible after it, an
 * IMMEDIATE post-create settlement check runs, followed by one check
 * after each of the seven `KEY_SETTLE_POLL_DELAYS_MS` delays — exactly
 * eight post-create evidence checks — and if nothing appears the run
 * stays `key_create_uncertain`; the create is never retried
 * automatically. Every other outcome fails closed with the checkpoint
 * retained. Returns `keyReused` so the caller can preserve accurate
 * keyFresh/keyReused summary and verify-retry semantics (a key whose
 * resource was in the baseline pre-existed this setup; a recovered or
 * freshly created key did not).
 */
export async function settleServiceAccountKey(
  runner: GcloudRunner,
  executed: PlannedCommand[],
  input: KeySettleInput,
): Promise<KeySettleOutcome> {
  const freshCreateJustIssued = input.createPermission === "fresh";
  // First pass: the pre-create evidence check, and for `fresh` permission
  // the ONE and only key create. A reconcile-only resume uses it as the
  // immediate evidence check.
  const first = await settleKeyPass(runner, executed, input, !freshCreateJustIssued);
  if (first.status !== "retry") {
    return first;
  }
  // Post-create settlement, bounded by `KEY_SETTLE_POLL_DELAYS_MS`:
  // - fresh: the create was JUST issued, so an IMMEDIATE post-create
  //   staged/final + keys-list settlement check runs first, then one check
  //   after each of the seven scheduled delays — exactly eight post-create
  //   evidence checks;
  // - reconcile: the first pass above already was the immediate check, so
  //   only the seven delayed checks remain (still an immediate check plus
  //   seven delayed checks on the resume).
  // The create is NEVER retried automatically.
  let lastExhausted = first.exhausted;
  if (freshCreateJustIssued) {
    const immediate = await settleKeyPass(runner, executed, input, true);
    if (immediate.status !== "retry") {
      return immediate;
    }
    lastExhausted = immediate.exhausted;
  }
  for (let check = 0; ; check += 1) {
    const delay = KEY_SETTLE_POLL_DELAYS_MS[check];
    if (delay === undefined) {
      // No recoverable credential and no post-baseline key on any check: a
      // created key may still be propagating, but the bounded window is
      // exhausted — the outcome is uncertain. The create is never retried.
      return { status: "error", error: lastExhausted };
    }
    await input.sleeper.sleep(delay);
    const pass = await settleKeyPass(runner, executed, input, true);
    if (pass.status !== "retry") {
      return pass;
    }
    lastExhausted = pass.exhausted;
  }
}

/** Result of one key-settlement pass. */
type SettlePassResult =
  | { readonly status: "ok"; readonly keyReused: boolean }
  | { readonly status: "error"; readonly error: SetupErrorResult }
  | {
    readonly status: "retry";
    /** Error to return when the bounded propagation window is exhausted. */
    readonly exhausted: SetupErrorResult;
  };

/**
 * One settlement pass: validate the staged parent, read staged/final
 * evidence, list the current user-managed keys, and apply the
 * reconciliation rules.
 *
 * The deterministic staging directory is inspected and secured to 0700
 * BEFORE any staged `key.json` is opened, chmod'ed, or read and BEFORE the
 * key list runs; a symlinked/non-directory/unsafe stage parent fails
 * closed with `key_create_failed` so the foreign target is never followed,
 * chmod'ed, or read and no key list/create/install/cleanup happens.
 *
 * Returns `retry` only when the state may legitimately improve within the
 * propagation window: a credential exists but is not yet visible in the
 * key list, or no credential and no post-baseline key exist at all (the
 * created key may still be propagating). Every definite obstacle (invalid
 * or identity-mismatched files, two different local keys, an unmatched
 * post-baseline key) fails immediately.
 */
async function settleKeyPass(
  runner: GcloudRunner,
  executed: PlannedCommand[],
  input: KeySettleInput,
  createIssued: boolean,
): Promise<SettlePassResult> {
  const staged = stagedKeyPath(input.keyPath, input.keyMarker);
  const finalResult = readServiceAccountKeySecurely(input.keyPath);
  // The staged key is only ever read through a validated private parent:
  // the deterministic staging directory must be absent (the normal fresh
  // or crash boundary) or a plain directory secured to owner-only 0700
  // BEFORE any staged child is inspected, opened, chmod'ed, or read. A
  // symlink/non-directory/unsafe parent fails closed with
  // `key_create_failed` BEFORE the key list, create, install, or cleanup
  // can run, and the foreign target is never followed, chmod'ed, or read
  // (and no other key is ever created).
  const stagedParent = inspectStagedKeyParent(input.keyPath, input.keyMarker);
  if (stagedParent.status === "error") {
    return { status: "error", error: stagedParent.error };
  }
  const stagedResult =
    stagedParent.status === "absent"
      ? ({ status: "absent" } as const)
      : readServiceAccountKeySecurely(staged);

  const current = await listUserManagedServiceAccountKeys(runner, executed, {
    projectId: input.projectId,
    saEmail: input.saEmail,
    purpose: "reconcile",
  });
  if (current.status === "error") {
    return current;
  }
  const currentNames = current.names;
  // Post-baseline keys: created by the started run (or by a concurrent
  // actor); any entry here that no local credential matches is unmatched.
  const delta = currentNames.filter((name) => !input.baseline.includes(name));
  const isActive = (metadata: ServiceAccountKeyMetadata): boolean =>
    currentNames.includes(keyResourceNameFor(input.projectId, input.saEmail, metadata.keyId));
  const isForThisSetup = (metadata: ServiceAccountKeyMetadata): boolean =>
    metadata.projectId === input.projectId && metadata.clientEmail === input.saEmail;

  // A local credential only counts when it belongs to THIS project and
  // service account; a mismatched one is an obstacle, never a recovery
  // source (and never something to delete).
  const finalIdentityMismatch =
    finalResult.status === "ok" && !isForThisSetup(finalResult.metadata)
      ? `the key file at ${input.keyPath} belongs to ${finalResult.metadata.clientEmail} ` +
        `(project ${finalResult.metadata.projectId}); expected ${input.saEmail} in project ${input.projectId}`
      : null;
  const stagedIdentityMismatch =
    stagedResult.status === "ok" && !isForThisSetup(stagedResult.metadata)
      ? `the staged key at ${staged} belongs to ${stagedResult.metadata.clientEmail} ` +
        `(project ${stagedResult.metadata.projectId}); expected ${input.saEmail} in project ${input.projectId}`
      : null;

  // An identity-mismatched local file blocks progress until the user
  // removes it; it is never treated as a recovery source.
  if (finalIdentityMismatch !== null) {
    return {
      status: "error",
      error: localGuidanceError(
        delta,
        finalIdentityMismatch,
        `remove it after confirming it is not needed and rerun setup`,
      ),
    };
  }
  if (stagedIdentityMismatch !== null) {
    return {
      status: "error",
      error: localGuidanceError(
        delta,
        stagedIdentityMismatch,
        `remove the staging directory after confirming it is not needed and rerun setup`,
      ),
    };
  }

  // EVERY post-baseline key must be represented by a securely validated
  // local credential: an unmatched delta entry is a cloud key this setup
  // neither created nor can identify, so install/cleanup/promotion must
  // not proceed. The checkpoint, local credentials, and the stage are
  // retained; no cloud delete and no new create happens.
  const localKeyNames = new Set<string>();
  if (finalResult.status === "ok") {
    localKeyNames.add(keyResourceNameFor(input.projectId, input.saEmail, finalResult.metadata.keyId));
  }
  if (stagedResult.status === "ok") {
    localKeyNames.add(keyResourceNameFor(input.projectId, input.saEmail, stagedResult.metadata.keyId));
  }
  const unmatchedDelta = delta.filter((name) => !localKeyNames.has(name));
  if (unmatchedDelta.length > 0) {
    return {
      status: "error",
      error: uncertainResult(
        `a new user-managed service-account key appeared for ${input.saEmail} that no local key ` +
          `file represents; setup will not create another key and nothing was deleted — inspect ` +
          `the user-managed keys of ${input.saEmail} in the Google Cloud console, remove the ` +
          `unexpected key if it was created by mistake, and rerun setup`,
      ),
    };
  }

  // Two different valid local credentials: ambiguous, never auto-delete.
  if (finalResult.status === "ok" && stagedResult.status === "ok") {
    if (finalResult.metadata.keyId !== stagedResult.metadata.keyId) {
      return {
        status: "error",
        error: uncertainResult(
          `both the key file at ${input.keyPath} and the staged key at ${staged} exist but are ` +
            `different keys; setup will not create or delete anything — inspect the service-account ` +
            `keys and remove one of the local files, then rerun setup`,
        ),
      };
    }
    if (isActive(finalResult.metadata)) {
      // The final (and its staged hardlink) is the created key: finish
      // cleanup and promote.
      const cleaned = cleanupOwnedStage(input.keyPath, input.keyMarker);
      if (cleaned !== null) {
        return { status: "error", error: cleaned };
      }
      return { status: "ok", keyReused: baselineIncludes(input, finalResult.metadata) };
    }
    // The only local credential is not visible in the key list yet: it may
    // still be propagating, so poll within the bounded window.
    return {
      status: "retry",
      exhausted: localGuidanceError(
        delta,
        `the key file at ${input.keyPath} does not correspond to an active service-account key`,
        `remove it after confirming it is not needed and rerun setup`,
      ),
    };
  }

  // A staged key that validates and is ACTIVE is the only local copy of
  // the created key: install/recover it without creating another. This
  // runs before the final-path checks so a planted/invalid final is
  // reported as an install obstacle with recovery guidance.
  if (stagedResult.status === "ok" && isActive(stagedResult.metadata)) {
    if (stagedParent.status !== "present") {
      // Unreachable: an `ok` staged result is only ever produced through a
      // validated present parent.
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.KEY_CREATE_FAILED,
          `the staged key at ${staged} could not be attributed to its staging directory; ` +
            `nothing was created or deleted — rerun setup`,
        ),
      };
    }
    // Re-verify the stage directory is still the exact directory that was
    // inspected and secured above: a replacement between the inspection
    // and the atomic hard link must fail closed and never redirect the
    // install onto a foreign target.
    const stillSecure = recheckStagedKeyParent(input.keyPath, input.keyMarker, stagedParent);
    if (stillSecure !== null) {
      return { status: "error", error: stillSecure };
    }
    const installed = installStagedKey(input.keyPath, staged);
    if (installed !== null) {
      return { status: "error", error: installed };
    }
    executed.push({
      kind: "file",
      label: `install staged service-account key at ${input.keyPath}`,
      outcome: "atomic hard link installed from the staged key; staged link removed after verification",
    });
    const verified = readServiceAccountKeySecurely(input.keyPath);
    if (verified.status !== "ok" || verified.metadata.keyId !== stagedResult.metadata.keyId) {
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.KEY_CREATE_FAILED,
          `the installed key at ${input.keyPath} could not be verified; nothing was created or deleted — rerun setup`,
        ),
      };
    }
    const cleaned = cleanupOwnedStage(input.keyPath, input.keyMarker);
    if (cleaned !== null) {
      return { status: "error", error: cleaned };
    }
    return { status: "ok", keyReused: baselineIncludes(input, stagedResult.metadata) };
  }

  // The final path is occupied by something unusable; it is never
  // overwritten or deleted.
  if (finalResult.status === "invalid") {
    return {
      status: "error",
      error: localGuidanceError(
        delta,
        `the key file at ${input.keyPath} exists but is not a valid service-account key for this setup`,
        `remove it after confirming it is not needed and rerun setup`,
      ),
    };
  }

  // A staged file that is not a valid key is retained (never deleted) and
  // blocks progress until the user resolves it.
  if (stagedResult.status === "invalid") {
    return {
      status: "error",
      error: localGuidanceError(
        delta,
        `the staged key at ${staged} is not a valid service-account key`,
        `remove the staging directory after confirming it is not needed and rerun setup`,
      ),
    };
  }

  // Final key exists and validates.
  if (finalResult.status === "ok") {
    if (isActive(finalResult.metadata)) {
      const cleaned = cleanupOwnedStage(input.keyPath, input.keyMarker);
      if (cleaned !== null) {
        return { status: "error", error: cleaned };
      }
      return { status: "ok", keyReused: baselineIncludes(input, finalResult.metadata) };
    }
    // The final credential is not visible in the key list yet: it may
    // still be propagating, so poll within the bounded window.
    return {
      status: "retry",
      exhausted: localGuidanceError(
        delta,
        `the key file at ${input.keyPath} does not correspond to an active service-account key`,
        `remove it after confirming it is not needed and rerun setup`,
      ),
    };
  }

  // Staged key exists, validates, and belongs to this setup but is not
  // active: retained, fail closed after the propagation window (it may
  // still be appearing in the list).
  if (stagedResult.status === "ok") {
    return {
      status: "retry",
      exhausted: localGuidanceError(
        delta,
        `the staged key at ${staged} does not correspond to an active service-account key`,
        `remove the staging directory after confirming it is not needed and rerun setup`,
      ),
    };
  }

  // No local credential at all.
  if (delta.length > 0) {
    return {
      status: "error",
      error: uncertainResult(
        `a new user-managed service-account key appeared for ${input.saEmail} but no matching key ` +
          `file exists locally; setup will not create another key and nothing was deleted — inspect ` +
          `the user-managed keys of ${input.saEmail} in the Google Cloud console, remove the ` +
          `unexpected key if it was created by mistake, and rerun setup`,
      ),
    };
  }
  if (input.createPermission === "fresh" && !createIssued) {
    // Only the invocation that JUST persisted the fresh checkpoint may
    // issue the single create; a resume NEVER reaches this branch.
    const prepared = prepareStageDir(input.keyPath, input.keyMarker);
    if (prepared.status === "error") {
      return { status: "error", error: prepared.error };
    }
    // The gcloud create runs with the staging directory as the subprocess
    // working directory and a RELATIVE `key.json` destination, so the
    // credential write is bound to the validated private directory instead
    // of a pathname that could be swapped mid-run. Immediately before the
    // spawn, the directory is re-verified (no-follow descriptor, type,
    // identity, owner-only mode) against the identity captured by
    // prepareStageDir: a replacement is never silently trusted.
    const stageDir = keyStageDir(input.keyPath, input.keyMarker);
    const stillSecure = verifyStageDirBeforeSubprocess(stageDir, prepared);
    if (stillSecure !== null) {
      return { status: "error", error: stillSecure };
    }
    const keyCreateCommand = [
      "iam",
      "service-accounts",
      "keys",
      "create",
      // Relative destination resolved against the validated staging cwd.
      KEY_STAGE_FILE_NAME,
      "--iam-account",
      input.saEmail,
      "--project",
      input.projectId,
    ] as const;
    let keyCreate: GcloudRunResult;
    try {
      keyCreate = await runner.run(keyCreateCommand, { cwd: stageDir });
    } catch {
      // The invocation threw (spawn/transport failure) after gcloud may or
      // may not have written the staged key. Treat it as a lost result and
      // poll the deterministic stage + current key list below instead of
      // bubbling an unexpected error; the thrown text is never forwarded.
      keyCreate = { status: "failed", code: null, stdout: "", stderr: "" };
    }
    executed.push({
      kind: "gcloud",
      command: keyCreateCommand,
      outcome: outcomeOf(keyCreate, `key staged; validation and atomic install at ${input.keyPath} follow`),
    });
  }
  // The one create was issued (or this is a reconcile-only resume): wait
  // for the created key to propagate into the key list / staged evidence
  // through the bounded window. The create is NEVER retried automatically.
  return { status: "retry", exhausted: noLocalKeyEvidenceError(input.saEmail) };
}

/** True when the metadata's key resource was already in the baseline. */
function baselineIncludes(input: KeySettleInput, metadata: ServiceAccountKeyMetadata): boolean {
  return input.baseline.includes(keyResourceNameFor(input.projectId, input.saEmail, metadata.keyId));
}

/**
 * Builds a local-obstacle error whose code depends on whether an
 * unmatched post-baseline key exists: `key_create_uncertain` when it does
 * (the outcome is ambiguous), `key_create_failed` otherwise.
 */
function localGuidanceError(
  delta: readonly string[],
  obstacle: string,
  guidance: string,
): SetupErrorResult {
  if (delta.length > 0) {
    return uncertainResult(
      `${obstacle} and a new user-managed key appeared; setup will not create another key and ` +
        `nothing was deleted — inspect the user-managed keys in the Google Cloud console and ` +
        `rerun setup`,
    );
  }
  return errorResult(SETUP_ERROR_CODES.KEY_CREATE_FAILED, `${obstacle}; ${guidance}`);
}

/**
 * Builds the stable `key_create_uncertain` failure for the exhausted
 * propagation window: no local credential and no post-baseline key ever
 * appeared, so the user must inspect the cloud and intentionally reset
 * the key checkpoint rather than have setup guess.
 */
function noLocalKeyEvidenceError(saEmail: string): SetupErrorResult {
  return uncertainResult(
    `no service-account key file for ${saEmail} could be found and no new key appeared in the ` +
      `user-managed key list within the propagation window; setup will not create another key and ` +
      `nothing was deleted — inspect the user-managed keys of ${saEmail} in the Google Cloud ` +
      `console, remove any unexpected key, and if no key exists remove the setup state file (and ` +
      `the key file if present) to reset the key checkpoint, then rerun setup`,
  );
}

/** Builds the stable `key_create_uncertain` failure for an unknown key state. */
function uncertainResult(message: string): SetupErrorResult {
  return errorResult(SETUP_ERROR_CODES.KEY_CREATE_UNCERTAIN, message);
}

/** Owner-only permission of the key staging directory. */
const KEY_STAGE_DIR_MODE = 0o700;

/**
 * Creates the deterministic staging directory (mode 0700) and returns its
 * identity.
 *
 * A pre-existing entry is accepted only when it is a real directory (a
 * crash between the checkpoint write and the create leaves an empty owned
 * directory that is reused); anything else is refused and left untouched.
 * Before gcloud may write a credential into the directory its permissions
 * are enforced to owner-only 0700 through a no-follow descriptor where the
 * platform supports it (the mode is applied and verified on the open
 * descriptor, never via a check-then-chmod path race), and any unsafe
 * type/permission failure rejects the run without touching foreign
 * entries. The returned device/inode is the identity the pre-subprocess
 * re-verification compares against. Exported so tests can exercise the
 * pre-existing-directory security path directly (it is only reachable
 * from the one fresh create).
 */
export function prepareStageDir(keyPath: string, keyMarker: string): PreparedStageDir {
  const stageDir = keyStageDir(keyPath, keyMarker);
  try {
    mkdirSync(stageDir, { mode: KEY_STAGE_DIR_MODE });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EEXIST") {
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.KEY_CREATE_FAILED,
          `could not create a private staging directory for the service-account key: ${messageOf(error)}`,
        ),
      };
    }
    const secured = secureExistingStageDir(stageDir, defaultKeyCleanupFs, "staging directory");
    return secured.status === "ok"
      ? { status: "ok", dev: secured.dev, ino: secured.ino }
      : { status: "error", error: secured.error };
  }
  // Freshly created: capture the identity (device/inode) so the
  // pre-subprocess verification can prove the directory at the staging
  // path is still the one this invocation created.
  try {
    const stat = lstatSync(stageDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      // The directory we just created was replaced before it could be
      // verified: fail closed and never touch the replacement.
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.KEY_CREATE_FAILED,
          `the staging directory ${stageDir} is not a plain directory; remove it after ` +
            `confirming it is not needed and rerun setup`,
        ),
      };
    }
    return { status: "ok", dev: stat.dev, ino: stat.ino };
  } catch (error) {
    return {
      status: "error",
      error: errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `could not verify the staging directory ${stageDir}: ${messageOf(error)}; remove it ` +
          `after confirming it is not needed and rerun setup`,
      ),
    };
  }
}

/**
 * Result of preparing the deterministic staging directory.
 *
 * `ok` carries the prepared directory's device/inode so the subprocess
 * pre-verification can prove the path still names the exact directory this
 * invocation created/secured.
 */
export type PreparedStageDir =
  | { readonly status: "ok"; readonly dev: number; readonly ino: number }
  | { readonly status: "error"; readonly error: SetupErrorResult };

/**
 * Re-verifies the staging directory immediately before the gcloud
 * key-create subprocess.
 *
 * The directory is opened WITHOUT following symlinks and its type,
 * device/inode identity, and owner-only mode are verified THROUGH the
 * descriptor against the identity captured by `prepareStageDir`; only an
 * exact match is allowed to receive an `fchmod` (the directory is ours),
 * and the subprocess runs with that directory as its working directory and
 * a RELATIVE `key.json` destination, so the credential write is bound to
 * the validated private directory. A replacement — symlink, non-directory,
 * foreign directory, or mode failure — fails closed BEFORE the spawn and
 * is never chmod'ed, read, or written through.
 */
function verifyStageDirBeforeSubprocess(
  stageDir: string,
  expected: { readonly dev: number; readonly ino: number },
): SetupErrorResult | null {
  let fd: number;
  try {
    fd = openSync(stageDir, constants.O_RDONLY | noFollowFlag() | directoryFlag());
  } catch (error) {
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "ENOTDIR")) {
      return errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `the staging directory ${stageDir} is not a plain directory; remove it after confirming ` +
          `it is not needed and rerun setup`,
      );
    }
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not re-verify the staging directory ${stageDir}: ${messageOf(error)}; nothing was ` +
        `created or deleted — rerun setup`,
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) {
      return errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `the staging directory ${stageDir} was replaced before the key could be created; ` +
          `nothing was created or deleted — remove the replacement after confirming it is ` +
          `not needed and rerun setup`,
      );
    }
    if ((Number(stat.mode) & 0o777) !== KEY_STAGE_DIR_MODE) {
      // Identity-verified: the directory is the one this invocation
      // created/secured, so enforcing the owner-only mode is safe.
      fchmodSync(fd, KEY_STAGE_DIR_MODE);
      const secured = fstatSync(fd);
      if ((Number(secured.mode) & 0o777) !== KEY_STAGE_DIR_MODE) {
        return errorResult(
          SETUP_ERROR_CODES.KEY_CREATE_FAILED,
          `could not verify owner-only permissions on the staging directory ${stageDir}`,
        );
      }
    }
    return null;
  } catch (error) {
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not re-verify the staging directory ${stageDir}: ${messageOf(error)}; nothing was ` +
        `created or deleted — rerun setup`,
    );
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The security verdict is the one to report.
    }
  }
}

/**
 * Result of securing a pre-existing deterministic directory.
 *
 * `ok` carries the verified directory's device/inode so callers can
 * re-check identity later (e.g. immediately before an install).
 */
type SecuredDirectoryResult =
  | { readonly status: "ok"; readonly dev: number; readonly ino: number }
  | { readonly status: "error"; readonly error: SetupErrorResult };

/**
 * Verifies and secures a pre-existing deterministic directory.
 *
 * The entry must be a plain directory (a symlink or non-directory is
 * refused and left untouched). The directory is opened with `O_NOFOLLOW`
 * where the platform defines it, its type is confirmed on the descriptor,
 * and its mode is enforced to owner-only 0700 through `fchmod` on that
 * descriptor with the resulting mode verified before close — so a swap
 * between the type check and the chmod cannot redirect the chmod onto a
 * foreign target. Any open/type/chmod failure fails closed; entries inside
 * the directory are never touched. `label` names the directory kind in
 * messages ("staging directory" or "cleanup directory").
 */
function secureExistingStageDir(
  dirPath: string,
  fs: KeyCleanupFs,
  label: string,
): SecuredDirectoryResult {
  let fd: number;
  try {
    fd = fs.openSync(dirPath, constants.O_RDONLY | noFollowFlag() | directoryFlag());
  } catch (error) {
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "ENOTDIR")) {
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.KEY_CREATE_FAILED,
          `the ${label} ${dirPath} is not a plain directory; remove it after confirming it ` +
            `is not needed and rerun setup`,
        ),
      };
    }
    return {
      status: "error",
      error: errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `could not inspect the ${label} ${dirPath}: ${messageOf(error)}; remove it after ` +
          `confirming it is not needed and rerun setup`,
      ),
    };
  }
  try {
    let stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) {
      return {
        status: "error",
        error: errorResult(
          SETUP_ERROR_CODES.KEY_CREATE_FAILED,
          `the ${label} ${dirPath} is not a plain directory; remove it after confirming it ` +
            `is not needed and rerun setup`,
        ),
      };
    }
    if ((Number(stat.mode) & 0o777) !== KEY_STAGE_DIR_MODE) {
      try {
        fs.fchmodSync(fd, KEY_STAGE_DIR_MODE);
      } catch (error) {
        return {
          status: "error",
          error: errorResult(
            SETUP_ERROR_CODES.KEY_CREATE_FAILED,
            `could not secure the ${label} ${dirPath} to owner-only mode: ${messageOf(error)}; ` +
              `remove it after confirming it is not needed and rerun setup`,
          ),
        };
      }
      stat = fs.fstatSync(fd);
      if ((Number(stat.mode) & 0o777) !== KEY_STAGE_DIR_MODE) {
        return {
          status: "error",
          error: errorResult(
            SETUP_ERROR_CODES.KEY_CREATE_FAILED,
            `could not verify owner-only permissions on the ${label} ${dirPath}`,
          ),
        };
      }
    }
    return { status: "ok", dev: stat.dev, ino: stat.ino };
  } catch (error) {
    return {
      status: "error",
      error: errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `could not verify the ${label} ${dirPath}: ${messageOf(error)}`,
      ),
    };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The security verdict is the one to report.
    }
  }
}

/**
 * Result of inspecting the deterministic staging directory parent of the
 * staged key.
 */
type StagedKeyParent =
  | { readonly status: "absent" }
  | { readonly status: "present"; readonly dev: number; readonly ino: number }
  | { readonly status: "error"; readonly error: SetupErrorResult };

/**
 * Inspects the deterministic staging directory BEFORE any staged child is
 * touched.
 *
 * An absent stage is the normal fresh or crash boundary (`absent`). A
 * present entry must be a plain directory and is secured to owner-only
 * 0700 through the no-follow descriptor before the staged `key.json` may
 * be opened, chmod'ed, or read; the secured directory's device/inode is
 * returned so the install step can re-verify identity later. A symlink,
 * non-directory, or unsafe entry fails closed with `key_create_failed`
 * BEFORE the key list, create, install, or cleanup can run, and the
 * foreign target is never followed, chmod'ed, or read.
 */
function inspectStagedKeyParent(keyPath: string, keyMarker: string): StagedKeyParent {
  const stageDir = keyStageDir(keyPath, keyMarker);
  let lst: Stats | undefined;
  try {
    lst = lstatSync(stageDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "absent" };
    }
    return {
      status: "error",
      error: errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `could not inspect the staging directory ${stageDir}: ${messageOf(error)}; remove it ` +
          `after confirming it is not needed and rerun setup`,
      ),
    };
  }
  if (lst === undefined) {
    // Unreachable: lstatSync either assigned or the catch returned above.
    return { status: "absent" };
  }
  if (lst.isSymbolicLink() || !lst.isDirectory()) {
    return {
      status: "error",
      error: errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `the staging directory ${stageDir} is not a plain directory; remove it after confirming ` +
          `it is not needed and rerun setup`,
      ),
    };
  }
  const secured = secureExistingStageDir(stageDir, defaultKeyCleanupFs, "staging directory");
  if (secured.status === "error") {
    return { status: "error", error: secured.error };
  }
  return { status: "present", dev: secured.dev, ino: secured.ino };
}

/**
 * Re-verifies the staging directory identity captured by
 * `inspectStagedKeyParent` immediately before an install.
 *
 * A replacement between the parent inspection and the atomic hard link
 * (the cooperating-process/private-directory boundary available without
 * native bindings) fails closed and never redirects the link onto a
 * foreign target; the replacement is left untouched.
 */
function recheckStagedKeyParent(
  keyPath: string,
  keyMarker: string,
  expected: { readonly dev: number; readonly ino: number },
): SetupErrorResult | null {
  const stageDir = keyStageDir(keyPath, keyMarker);
  let lst: Stats | undefined;
  try {
    lst = lstatSync(stageDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `the staging directory ${stageDir} disappeared before the staged key could be ` +
          `installed; nothing was created or deleted — rerun setup`,
      );
    }
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not re-verify the staging directory ${stageDir}: ${messageOf(error)}; nothing was ` +
        `created or deleted — rerun setup`,
    );
  }
  if (
    lst === undefined ||
    lst.isSymbolicLink() ||
    !lst.isDirectory() ||
    lst.dev !== expected.dev ||
    lst.ino !== expected.ino
  ) {
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `the staging directory ${stageDir} was replaced while the staged key was being ` +
        `installed; nothing was created or deleted — remove the replacement after confirming ` +
        `it is not needed and rerun setup`,
    );
  }
  return null;
}

/** `O_NOFOLLOW` where the platform defines it, else 0. */
function noFollowFlag(): number {
  return (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

/** `O_DIRECTORY` where the platform defines it, else 0. */
function directoryFlag(): number {
  return (constants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
}

/**
 * Installs the staged key at the final path with an atomic hard link.
 *
 * `linkSync` never follows or replaces an existing destination (regular
 * file, symlink, or hardlink all fail with EEXIST), so a final path planted
 * mid-run stays byte-identical and fails closed; the staged key is retained
 * in that case so a later run can recover it.
 */
function installStagedKey(keyPath: string, staged: string): SetupErrorResult | null {
  try {
    linkSync(staged, keyPath);
    return null;
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `a service-account key file already exists at ${keyPath} and was not overwritten; remove it ` +
          `and rerun setup to recover the staged key`,
      );
    }
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not install the service-account key at ${keyPath}: ${messageOf(error)}`,
    );
  }
}

/**
 * Filesystem operations the ownership-bound stage cleanup uses; injectable
 * for tests (the stage-directory replacement race is simulated through the
 * injected `renameSync`).
 */
export interface KeyCleanupFs {
  lstatSync(path: string): Stats;
  renameSync(from: string, to: string): void;
  readdirSync(path: string): string[];
  unlinkSync(path: string): void;
  rmdirSync(path: string): void;
  openSync(path: string, flags: number): number;
  fchmodSync(fd: number, mode: number): void;
  fstatSync(fd: number): Stats;
  closeSync(fd: number): void;
}

const defaultKeyCleanupFs: KeyCleanupFs = {
  lstatSync,
  renameSync,
  readdirSync,
  unlinkSync,
  rmdirSync,
  openSync,
  fchmodSync,
  fstatSync,
  closeSync,
};

/**
 * Ownership-bound, crash-resumable staged cleanup, only after a verified
 * installation.
 *
 * The final key path is verified with lstat (never following a symlink) and
 * must be a regular file; a final symlink is refused and the staged
 * credential is retained. Before any deletion the deterministic stage
 * directory is atomically quarantined: renamed to the deterministic private
 * cleanup sibling path derived from the SAME persisted key marker (never an
 * unrecoverable random name), with the device/inode captured before the
 * rename re-verified after it — a source replaced between the capture and
 * the rename fails closed and nothing is deleted. Inside the quarantined
 * 0700 directory the staged entry is re-checked as a regular file with the
 * same device/inode as the no-follow final key immediately before its
 * unlink; any mismatch, foreign, or non-empty entry is preserved (the
 * directory is moved back to the stage path so the user finds the state
 * where the docs say it is). The empty quarantined directory is then
 * rmdir'd. Never recursive-delete.
 *
 * Crash-resume boundaries: a crash-left cleanup directory with the matching
 * staged hardlink is finished (verify against the no-follow final, unlink,
 * rmdir); an empty cleanup directory (crash after the staged unlink) is
 * rmdir'd; an absent stage + cleanup pair means the cleanup already
 * finished (success); both existing at once fails closed. The setup lock is
 * held for the whole run — a second cooperating setup process cannot
 * acquire it concurrently, so no other run can be touching these
 * deterministic paths — and Node offers no literal unlinkat without a raw
 * libuv binding, so this quarantine + post-rename identity design is the
 * permitted boundary for the pathname unlink race.
 */
export function cleanupOwnedStage(
  keyPath: string,
  keyMarker: string,
  fs: KeyCleanupFs = defaultKeyCleanupFs,
): SetupErrorResult | null {
  const stageDir = keyStageDir(keyPath, keyMarker);
  const cleanupDir = keyCleanupDir(keyPath, keyMarker);

  // The final key path is verified WITHOUT following: a final symlink is
  // refused and the staged credential is retained.
  let finalLst: Stats | undefined;
  try {
    finalLst = fs.lstatSync(keyPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `the installed key at ${keyPath} is missing; rerun setup to finish`,
      );
    }
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not inspect the installed key at ${keyPath}: ${messageOf(error)}; rerun setup to finish`,
    );
  }
  if (finalLst === undefined) {
    // Unreachable (the catch returns); satisfies the type checker.
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not inspect the installed key at ${keyPath}; rerun setup to finish`,
    );
  }
  if (finalLst.isSymbolicLink() || !finalLst.isFile()) {
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `the installed key at ${keyPath} is not a regular file; nothing was deleted — remove it after ` +
        `confirming it is not needed and rerun setup to finish`,
    );
  }

  // Quarantine: capture the stage directory identity, atomically rename it
  // to the deterministic private cleanup sibling, and re-verify the moved
  // directory is the exact captured device/inode. A source replaced
  // between the capture and the rename fails closed and nothing is deleted.
  let stageLst: Stats | undefined;
  try {
    stageLst = fs.lstatSync(stageDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      stageLst = undefined;
    } else {
      return errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `could not inspect the staging directory ${stageDir}: ${messageOf(error)}; rerun setup to finish`,
      );
    }
  }
  let cleanupLst: Stats | undefined;
  try {
    cleanupLst = fs.lstatSync(cleanupDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      cleanupLst = undefined;
    } else {
      return errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `could not inspect the cleanup directory ${cleanupDir}: ${messageOf(error)}; rerun setup to finish`,
      );
    }
  }
  if (stageLst !== undefined && cleanupLst !== undefined) {
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `both the staging directory ${stageDir} and the cleanup directory ${cleanupDir} exist; ` +
        `remove one after confirming it is not needed and rerun setup`,
    );
  }
  if (stageLst !== undefined) {
    if (stageLst.isSymbolicLink() || !stageLst.isDirectory()) {
      return errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `the staging directory ${stageDir} is not a plain directory; remove it after confirming it ` +
          `is not needed and rerun setup`,
      );
    }
    const capturedDev = stageLst.dev;
    const capturedIno = stageLst.ino;
    try {
      fs.renameSync(stageDir, cleanupDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        // The stage directory vanished between the check and the rename:
        // nothing was quarantined; resume from whatever is at the cleanup
        // path below.
        stageLst = undefined;
      } else {
        return errorResult(
          SETUP_ERROR_CODES.KEY_CREATE_FAILED,
          `could not quarantine the staging directory ${stageDir}: ${messageOf(error)}; rerun setup to finish`,
        );
      }
    }
    if (stageLst !== undefined) {
      // Post-rename identity check: the directory now at the cleanup path
      // must be the exact one captured before the rename. The replacement
      // is left untouched (nothing is moved or deleted).
      let moved: Stats | undefined;
      try {
        moved = fs.lstatSync(cleanupDir);
      } catch (error) {
        return errorResult(
          SETUP_ERROR_CODES.KEY_CREATE_FAILED,
          `could not verify the quarantined directory ${cleanupDir}: ${messageOf(error)}; rerun setup to finish`,
        );
      }
      if (moved === undefined) {
        // Unreachable (the catch returns); satisfies the type checker.
        return errorResult(
          SETUP_ERROR_CODES.KEY_CREATE_FAILED,
          `could not verify the quarantined directory ${cleanupDir}; rerun setup to finish`,
        );
      }
      if (
        moved.dev !== capturedDev ||
        moved.ino !== capturedIno ||
        moved.isSymbolicLink() ||
        !moved.isDirectory()
      ) {
        return errorResult(
          SETUP_ERROR_CODES.KEY_CREATE_FAILED,
          `the staging directory ${stageDir} was replaced while cleaning up; nothing was deleted — ` +
            `inspect the cleanup directory ${cleanupDir} and rerun setup`,
        );
      }
      cleanupLst = moved;
    }
  }
  if (cleanupLst === undefined) {
    // Both the stage and cleanup directories are absent: the cleanup
    // already finished (or there was never anything staged).
    return null;
  }
  if (cleanupLst.isSymbolicLink() || !cleanupLst.isDirectory()) {
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `the cleanup directory ${cleanupDir} is not a plain directory; remove it after confirming it ` +
        `is not needed and rerun setup`,
    );
  }
  // The quarantined directory is enforced to owner-only 0700 through a
  // no-follow descriptor before its contents are touched (a crash-left
  // cleanup directory may carry loose modes from an interrupted run).
  const secured = secureExistingStageDir(cleanupDir, fs, "cleanup directory");
  if (secured.status === "error") {
    return secured.error;
  }

  let entries: readonly string[];
  try {
    entries = fs.readdirSync(cleanupDir);
  } catch (error) {
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not inspect the cleanup directory ${cleanupDir}: ${messageOf(error)}; rerun setup to finish`,
    );
  }
  if (entries.length === 0) {
    // Crash between the staged unlink and the rmdir: the empty quarantined
    // directory is removed now.
    try {
      fs.rmdirSync(cleanupDir);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      return errorResult(
        SETUP_ERROR_CODES.KEY_CREATE_FAILED,
        `could not remove the cleanup directory ${cleanupDir}: ${messageOf(error)}; rerun setup to finish`,
      );
    }
    return null;
  }
  if (entries.length !== 1 || entries[0] !== KEY_STAGE_FILE_NAME) {
    // Foreign or leftover entries are preserved (never deleted recursively
    // or individually); the directory is moved back to the stage path so
    // the user finds the state where the docs say it is.
    restoreQuarantine(cleanupDir, stageDir, fs);
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `the staging directory ${stageDir} still contains files; remove them after confirming and rerun setup`,
    );
  }
  const stagedInCleanup = join(cleanupDir, KEY_STAGE_FILE_NAME);
  // Recheck the staged entry immediately before its unlink: it must be a
  // regular file with the same device/inode as the no-follow final key.
  let stagedLst: Stats | undefined;
  try {
    stagedLst = fs.lstatSync(stagedInCleanup);
  } catch (error) {
    restoreQuarantine(cleanupDir, stageDir, fs);
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not inspect the staged key at ${stagedInCleanup}: ${messageOf(error)}; rerun setup to finish`,
    );
  }
  if (stagedLst === undefined) {
    // Unreachable (the catch returns); satisfies the type checker.
    restoreQuarantine(cleanupDir, stageDir, fs);
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not inspect the staged key at ${stagedInCleanup}; rerun setup to finish`,
    );
  }
  if (stagedLst.isSymbolicLink() || !stagedLst.isFile()) {
    restoreQuarantine(cleanupDir, stageDir, fs);
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `the staged key at ${stagedInCleanup} is not a regular file; remove it after confirming it is not ` +
        `needed and rerun setup`,
    );
  }
  let finalNow: Stats | undefined;
  try {
    finalNow = fs.lstatSync(keyPath);
  } catch (error) {
    restoreQuarantine(cleanupDir, stageDir, fs);
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not verify the installed key at ${keyPath}: ${messageOf(error)}; rerun setup to finish`,
    );
  }
  if (finalNow === undefined || stagedLst === undefined) {
    // Unreachable (the catch returns and stagedLst was guarded above);
    // satisfies the type checker.
    restoreQuarantine(cleanupDir, stageDir, fs);
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not verify the installed key at ${keyPath}; rerun setup to finish`,
    );
  }
  if (
    finalNow.isSymbolicLink() ||
    !finalNow.isFile() ||
    finalNow.dev !== stagedLst.dev ||
    finalNow.ino !== stagedLst.ino
  ) {
    restoreQuarantine(cleanupDir, stageDir, fs);
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `the staged key at ${stagedInCleanup} is not the installed key; remove it after confirming it is ` +
        `not needed and rerun setup`,
    );
  }
  try {
    fs.unlinkSync(stagedInCleanup);
  } catch (error) {
    restoreQuarantine(cleanupDir, stageDir, fs);
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not remove the staged key at ${stagedInCleanup}: ${messageOf(error)}; rerun setup to finish`,
    );
  }
  try {
    fs.rmdirSync(cleanupDir);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    // A non-empty quarantined directory after the owned unlink is foreign
    // or leftover state: fail closed with the checkpoint retained.
    return errorResult(
      SETUP_ERROR_CODES.KEY_CREATE_FAILED,
      `could not remove the cleanup directory ${cleanupDir}: ${messageOf(error)}; rerun setup to finish`,
    );
  }
  return null;
}

/**
 * Best-effort move of the quarantined directory back to the stage path.
 *
 * Used when a content-level failure (foreign entry, staged mismatch) must
 * fail closed: the user's state is restored to the documented stage path so
 * the next run (or the user) finds it where the docs say it is. A failed
 * restore leaves the deterministic cleanup directory in place, which the
 * next run resumes from — the cleanup path is derived from the same
 * persisted marker, so it can never be lost.
 */
function restoreQuarantine(cleanupDir: string, stageDir: string, fs: KeyCleanupFs): void {
  try {
    fs.renameSync(cleanupDir, stageDir);
  } catch {
    // Best-effort only; a failed restore is resumed from the cleanup path.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
