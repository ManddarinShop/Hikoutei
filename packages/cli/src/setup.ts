#!/usr/bin/env node
/**
 * `hikoutei setup` CLI entry.
 *
 * The orchestration is split into a thin `main()` that wires production
 * dependencies (gcloud runner, token validator, sheet factory, SA verifier,
 * interactive login runner) and a testable {@link runSetupCli} that owns the
 * sequence: resolve paths, reject canonical path collisions, ask for the
 * one-time y/N confirmation (skipped by `--yes`/`--dry-run`), run setup, and
 * on an auth preflight failure offer a single interactive Enter-to-login
 * handoff into `gcloud auth login` before retrying exactly once (interactive
 * TTY only, never in CI/`--yes`/`--dry-run`). Exit codes:
 * 0 success, 2 argument errors, 1 runtime failures. Errors are printed as
 * `hikoutei-setup:<code>: <message>` for machine consumption, and key
 * material and the user access token are never printed.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSetupArgs, type SetupOptions } from "./args.js";
import { SETUP_STATE_FILE_NAME } from "./checkpoint.js";
import { confirmSetup, promptLoginHandoff } from "./confirm.js";
import {
  SETUP_ARG_ERROR_EXIT_CODE,
  SETUP_ERROR_CODES,
  SETUP_RUNTIME_ERROR_EXIT_CODE,
} from "./errors.js";
import { errorResult } from "./flowResult.js";
import {
  createGcloudRunner,
  createInteractiveLoginRunner,
  type GcloudLoginResult,
  type GcloudLoginRunner,
} from "./gcloudRunner.js";
import { createTokeninfoValidator, type TokenValidator } from "./humanAuth.js";
import { type Sleeper } from "./keyProvision.js";
import { createSaAccessVerifier, type SaAccessVerifier } from "./saVerify.js";
import { safeReasonOf } from "./sdkError.js";
import {
  createHumanSheetApiFactory,
  type HumanSheetApiFactory,
} from "./sheetsFactory.js";
import {
  createSetupProgressRenderer,
  isCiEnvironment,
  type SetupProgressController,
} from "./setupProgress.js";
import {
  DEFAULT_KEY_FILE_NAME,
  findSetupPathCollision,
  formatPlan,
  formatSummary,
  runSetup,
  type RunSetupOptions,
  type SetupResult,
} from "./setupFlow.js";

/** Pure parameters for one setup attempt (no injected infrastructure). */
export interface RunSetupParams {
  readonly projectId: string | undefined;
  readonly saName: string;
  readonly spreadsheetTitle: string | undefined;
  readonly keyPath: string;
  readonly outputPath: string;
  readonly statePath: string;
  readonly dryRun: boolean;
}

/**
 * Runs one setup attempt.
 *
 * Infrastructure (gcloud runner, token validator, sheet factory, SA verifier)
 * is closed over by the caller, so {@link runSetupCli} can be tested with a
 * scripted callable that returns auth preflight failures and successes
 * without wiring up the full harness.
 */
export type RunSetupCallable = (params: RunSetupParams) => Promise<SetupResult>;

/** Terminal line source for the CLI; `process.stdin` in production. */
export interface CliStdin extends AsyncIterable<string> {
  /** True when stdin is attached to a terminal (gates the login handoff). */
  readonly isTTY?: boolean;
}

/** Terminal output sink; `process.stdout` in production. */
export interface CliStdout {
  /** True when stdout is attached to a terminal (gates the login handoff). */
  readonly isTTY?: boolean;
  readonly write: (text: string) => void;
}

/** Diagnostic output sink; `process.stderr` in production. */
export interface CliStderr {
  readonly write: (text: string) => void;
}

/** Context injected into {@link runSetupCli}; production values come from `main()`. */
export interface RunSetupCliContext {
  readonly options: SetupOptions;
  readonly cwd: string;
  /** Runs one setup attempt with all real/fake infrastructure closed over. */
  readonly runSetup: RunSetupCallable;
  /** Runs the interactive `gcloud auth login` handoff attached to the terminal. */
  readonly loginRunner: GcloudLoginRunner;
  readonly stdin: CliStdin;
  readonly stdout: CliStdout;
  readonly stderr: CliStderr;
  /**
   * True when the session runs in an automation environment (a non-empty
   * `CI` value). Gates the interactive login handoff so a CI pseudo-TTY
   * can never prompt, hang, or spawn the browser login; production main
   * passes the real process CI state via {@link isCiEnvironment}.
   * Optional so scripted tests that do not exercise the handoff run
   * unchanged (absent means not CI).
   */
  readonly isCi?: boolean;
  /**
   * Optional progress controller (the stderr renderer in production). When
   * present it is suspended before the inherited `gcloud auth login`
   * handoff, marked failed on a final error, and finished on success. Tests
   * that drive a scripted `runSetup` callable omit it.
   */
  readonly progress?: SetupProgressController;
  /**
   * Releases the shared stdin after every prompt and the inherited gcloud
   * login have finished; called exactly once on every setup outcome
   * (collision, declined confirmation, success, dry run, errors, login
   * cancel/failure, and retries). Optional so tests that do not exercise
   * the lifecycle run unchanged.
   *
   * The confirmation and login-handoff prompts read `process.stdin` through
   * its async iterator WITHOUT calling the iterator's `return()` so the two
   * sequential prompts share one stream; that open iterator keeps an internal
   * listener on the Readable and would hold the process alive after setup
   * finishes. The production finalizer destroys `process.stdin` to release
   * it. It is invoked from a `finally` AFTER the inherited login subprocess
   * (which needs the live terminal) resolves, never before it.
   */
  readonly finalizeStdin?: () => void;
}

/** Auth preflight failures that a fresh `gcloud auth login` can fix. */
const AUTH_RETRY_CODES: ReadonlySet<string> = new Set([
  SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN,
  SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED,
]);

/**
 * Orchestrates the setup CLI: path resolution, collision guard, one-time
 * confirmation, the setup run, and the optional interactive login handoff.
 *
 * The handoff runs ONLY when the first attempt fails with an auth preflight
 * error (`gcloud_not_logged_in` or `gcloud_drive_access_required`) AND the
 * session is a real interactive terminal (`stdin.isTTY && stdout.isTTY`) AND
 * the session is not an automation run (`isCi` absent/false; production
 * passes the non-empty `CI` environment state, so a CI pseudo-TTY can never
 * prompt or spawn the browser login) AND neither `--yes` nor `--dry-run`
 * was given. The preflight runs before any
 * lock, checkpoint, cloud, or file mutation, so retrying after a successful
 * login cannot create duplicate resources. The login is attempted at most
 * once and the setup retried at most once; if the retry still lacks the
 * scope, the original sanitized error is reported with no further login.
 *
 * @returns the process exit code (0 success, 2 argument collision, 1 failure).
 */
export async function runSetupCli(context: RunSetupCliContext): Promise<number> {
  const { options } = context;
  const cwd = context.cwd;
  const keyPath = resolve(cwd, DEFAULT_KEY_FILE_NAME);
  const outputPath = resolve(cwd, options.output);
  const statePath = resolve(cwd, SETUP_STATE_FILE_NAME);

  // Reject canonical path collisions (--output aliasing the key or the
  // checkpoint, symlink aliases included) BEFORE asking for confirmation or
  // running anything. The runtime flow repeats this guard for defense in
  // depth.
  //
  // The whole sequence is wrapped in try/finally so the shared stdin is
  // finalized exactly once on every outcome (collision, declined
  // confirmation, success, dry run, errors, and login cancel/failure). The
  // finalizer runs AFTER the inherited `gcloud auth login` subprocess
  // resolves, so the terminal stays live for the user's browser login.
  try {
    const collision = findSetupPathCollision({ keyPath, outputPath, statePath });
    if (collision.status === "collision") {
      context.stderr.write(`hikoutei-setup:${SETUP_ERROR_CODES.INVALID_ARGS}: ${collision.message}\n`);
      context.stderr.write("Run `hikoutei setup --help` for usage.\n");
      return SETUP_ARG_ERROR_EXIT_CODE;
    }

    // One-time resource confirmation; skipped by --yes/--dry-run. The login
    // retry never repeats this confirmation.
    const confirmed = await confirmSetup({
      yes: options.yes,
      dryRun: options.dryRun,
      input: context.stdin,
      output: context.stdout,
    });
    if (confirmed.status === "declined") {
      context.stdout.write("Setup aborted. Pass --yes to run without confirmation.\n");
      return SETUP_RUNTIME_ERROR_EXIT_CODE;
    }

    const params: RunSetupParams = {
      projectId: options.projectId,
      saName: options.saName,
      spreadsheetTitle: options.spreadsheetTitle,
      keyPath,
      outputPath,
      statePath,
      dryRun: options.dryRun,
    };

    let result = await context.runSetup(params);

    // Interactive login handoff: only the auth preflight failures a fresh
    // `gcloud auth login` can fix, only on a real terminal, never for
    // --yes/--dry-run/CI. Because the preflight precedes every mutation,
    // the single retry cannot double-create resources.
    if (
      result.status === "error" &&
      AUTH_RETRY_CODES.has(result.code) &&
      !options.dryRun &&
      !options.yes &&
      !context.isCi &&
      context.stdin.isTTY === true &&
      context.stdout.isTTY === true
    ) {
      // Clear the in-place progress block and stop its animation timer so
      // the inherited gcloud login subprocess owns the terminal cleanly.
      context.progress?.suspend();
      const handoff = await promptLoginHandoff({ input: context.stdin, output: context.stdout });
      if (handoff.status === "proceed") {
        const login = await context.loginRunner.runInteractiveLogin();
        if (login.status === "ok") {
          // The suspension is over: the retry owns the progress block and
          // the terminal again, and a later failure must be labeled
          // against the retry's own tracker state — never the phase the
          // first attempt died in.
          context.progress?.resume();
          // Exactly one retry with the same options and the same progress
          // controller; no second confirmation and no login loop. The retry
          // re-emits phase events, so the block redraws after suspend.
          result = await context.runSetup(params);
        } else {
          result = errorResult(SETUP_ERROR_CODES.GCLOUD_LOGIN_FAILED, describeLoginFailure(login));
        }
      }
    }

    if (result.status === "error") {
      // Mark the in-progress phase failed (the flow returns a stable error
      // result but never knows it is the final attempt — the login retry
      // may have just rescued an auth preflight failure).
      context.progress?.fail(result.code);
      context.stderr.write(`hikoutei-setup:${result.code}: ${result.message}\n`);
      return SETUP_RUNTIME_ERROR_EXIT_CODE;
    }
    if (result.dryRun) {
      context.stdout.write(
        "Hikoutei setup dry run (read-only path-safety checks only; no subprocess, network, cloud, or file mutations). Planned steps:\n",
      );
      context.stdout.write(`${formatPlan(result.commands)}\n`);
      return 0;
    }
    // Render the final 100% block and release any animation timer before
    // the success summary (progress is on stderr; the summary on stdout).
    context.progress?.finish();
    context.stdout.write(`${formatSummary(result.summary)}\n`);
    return 0;
  } finally {
    // Release the shared stdin after all prompts and the inherited gcloud
    // login have finished. The prompts read process.stdin through its async
    // iterator WITHOUT calling return() (so the confirmation and the login
    // handoff share one stream), leaving an internal listener that would
    // hold the process alive; the injected finalizer destroys the stream
    // here. No-op when the context provides none (tests, non-prompt paths).
    context.finalizeStdin?.();
  }
}

/**
 * Describes a failed interactive login with exit status only.
 *
 * The login subprocess streams are inherited by the user's terminal, so there
 * is no captured stderr or token to leak; the message is status-only and
 * always points at the exact manual re-login command.
 */
function describeLoginFailure(login: GcloudLoginResult): string {
  if (login.status === "not_found") {
    return "gcloud CLI was not found on PATH; install it from https://cloud.google.com/sdk and try again";
  }
  if (login.status === "spawn_error") {
    return (
      "could not start `gcloud auth login`; run `gcloud auth login --enable-gdrive-access --force` " +
      "manually and rerun setup"
    );
  }
  if (login.status === "failed") {
    return (
      `gcloud auth login exited with status ${login.code === null ? "unknown" : String(login.code)}; ` +
      "run `gcloud auth login --enable-gdrive-access --force` manually and rerun setup"
    );
  }
  // Unreachable: the caller only invokes this helper when login was not ok.
  return "gcloud auth login did not complete; run `gcloud auth login --enable-gdrive-access --force` manually and rerun setup";
}

/** Real `setTimeout` sleeper for the bounded SA access verification poll. */
const realSleeper: Sleeper = {
  sleep(ms: number): Promise<void> {
    return new Promise((resolveSleep) => {
      setTimeout(resolveSleep, ms);
    });
  },
};

/**
 * Pure ESM entrypoint guard: true only when `entryArg` resolves (following
 * symlinks) to the same file as `moduleUrl`.
 *
 * In CommonJS the bin would use `require.main === module`; in this package's
 * pure-ESM layout (`"type": "module"`) this realpath comparison is the robust
 * equivalent. `npx hikoutei` runs the published bin through a symlink, so the
 * realpath step resolves `.bin/hikoutei` to `dist/cli/setup.js` and matches
 * `import.meta.url`. When this module is imported — for example by the unit
 * tests importing `runSetupCli` — the entry argument is the test runner binary
 * and never matches, so `main()` is not executed and nothing parses argv,
 * writes CLI errors, or mutates `process.exitCode` on import.
 */
export function isModuleMainEntry(entryArg: string | undefined, moduleUrl: string): boolean {
  if (entryArg === undefined) {
    return false;
  }
  try {
    return realpathSync(entryArg) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    // `entryArg` points at a missing/unreadable path, or `moduleUrl` is not a
    // file URL: never treat an unresolvable entry as the main module.
    return false;
  }
}

/**
 * Production stdin finalizer for `hikoutei setup`.
 *
 * The confirmation and login-handoff prompts read `process.stdin` through
 * its async iterator WITHOUT calling the iterator's `return()`, so the two
 * sequential prompts can share one stream. That open iterator keeps an
 * internal listener on the Readable and would hold the process alive after
 * setup finishes; pausing the stream does not drop that listener. Destroying
 * the stream after every prompt and the inherited `gcloud auth login`
 * subprocess (which needs the live terminal) have finished is the definitive
 * release and is safe on every outcome — TTY, piped, never-read, or already
 * ended. Guarded and idempotent so it never throws or double-releases.
 */
/**
 * Destroys the process stdin exactly once so the CLI process can exit after
 * a single-chunk confirmation read leaves the shared async iterator open.
 * Exported for the adopt CLI, which prompts over the same shared stdin.
 */
export function createStdinFinalizer(): () => void {
  let finalized = false;
  return () => {
    if (finalized) {
      return;
    }
    finalized = true;
    try {
      process.stdin.destroy();
    } catch {
      // Destroy can raise on some stream states; the process is exiting, so
      // the release is best-effort and never fatal.
    }
  };
}

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseSetupArgs(argv);

  if (parsed.status === "help") {
    process.stdout.write(`${parsed.helpText}\n`);
    return 0;
  }
  if (parsed.status === "invalid") {
    process.stderr.write(`hikoutei-setup:${parsed.failure.code}: ${parsed.failure.message}\n`);
    process.stderr.write("Run `hikoutei setup --help` for usage.\n");
    return parsed.failure.code === SETUP_ERROR_CODES.INVALID_ARGS
      ? SETUP_ARG_ERROR_EXIT_CODE
      : SETUP_RUNTIME_ERROR_EXIT_CODE;
  }

  const runner = createGcloudRunner();
  const validateToken = createTokeninfoValidator();
  const createHumanApi = createHumanSheetApiFactory();
  const verifySaAccess = createSaAccessVerifier({ sleeper: realSleeper });
  // The progress renderer writes step-by-step bars to stderr (TTY: an
  // in-place animated block; CI/non-TTY/NO_COLOR: one static line per
  // event). It is suspended before the inherited gcloud login, marked
  // failed on a final error, and finished on success by `runSetupCli`.
  const progress = createSetupProgressRenderer({
    output: process.stderr,
    isTty: process.stderr.isTTY === true,
  });

  // Production setup callable: closes over the real infrastructure so the
  // orchestration retry reuses one set of factories across attempts.
  const runSetupCallable: RunSetupCallable = (params): Promise<SetupResult> =>
    runSetup({
      runner,
      validateToken,
      createHumanApi,
      verifySaAccess,
      projectId: params.projectId,
      saName: params.saName,
      spreadsheetTitle: params.spreadsheetTitle,
      keyPath: params.keyPath,
      outputPath: params.outputPath,
      statePath: params.statePath,
      dryRun: params.dryRun,
      progress,
    } satisfies RunSetupOptions);

  return runSetupCli({
    options: parsed.options,
    cwd: process.cwd(),
    runSetup: runSetupCallable,
    loginRunner: createInteractiveLoginRunner(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    // The real process CI state: a CI pseudo-TTY must never trigger the
    // interactive login handoff (help/docs promise a manual login command
    // and one static progress line per event in CI).
    isCi: isCiEnvironment(process.env),
    progress,
    finalizeStdin: createStdinFinalizer(),
  });
}

/**
 * Runs the `hikoutei setup` CLI with the given argument vector. Exported for
 * the bin router (src/cli/index.ts) and tests; the argv has already had a
 * leading "setup" subcommand stripped when routed through the router.
 */
export async function runSetupMain(argv: readonly string[]): Promise<number> {
  return main(argv);
}

// ESM entrypoint guard: run main() only when this file is the process entry
// (the published bin or `node dist/cli/setup.js`), never when it is merely
// imported (for example by unit tests importing `runSetupCli`). This keeps
// imports free of side effects: no argv parsing, no CLI error output, and no
// `process.exitCode` mutation.
if (isModuleMainEntry(process.argv[1], import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      // The strict sanitizer: arbitrary thrown messages may carry tokens or
      // key material, so only whitelisted/HTTP reasons are ever printed.
      process.stderr.write(`hikoutei-setup:unexpected: ${safeReasonOf(error)}\n`);
      process.exitCode = SETUP_RUNTIME_ERROR_EXIT_CODE;
    });
}
