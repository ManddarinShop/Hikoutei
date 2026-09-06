/**
 * gcloud subprocess runner for `hikoutei setup`.
 *
 * All gcloud invocations go through the `GcloudRunner` interface so unit
 * tests can inject a fake runner that records commands and returns scripted
 * results without touching the real CLI or the network. The production
 * implementation shells out with `node:child_process` `execFile`; a missing
 * binary is reported distinctly (`not_found`) from a failed invocation.
 */

import { execFile, spawn } from "node:child_process";

/** Outcome of one gcloud invocation. */
export type GcloudRunResult =
  | { readonly status: "ok"; readonly stdout: string; readonly stderr: string }
  | { readonly status: "not_found" }
  | {
    readonly status: "failed";
    /** Process exit code, or null when the process could not be spawned. */
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
  };

/** Extra options for one gcloud invocation. */
export interface GcloudRunOptions {
  /**
   * Working directory of the subprocess. The key create uses it to run
   * with a RELATIVE `key.json` destination from the validated private
   * staging directory, so the credential write is bound to the staging
   * directory the flow verified instead of a pathname that could be
   * swapped mid-run.
   */
  readonly cwd?: string;
}

/** Runs gcloud with the given arguments and returns the process outcome. */
export interface GcloudRunner {
  run(args: readonly string[], options?: GcloudRunOptions): Promise<GcloudRunResult>;
}

/**
 * Wraps a runner so a throwing invocation becomes a sanitized failed result.
 *
 * Every gcloud invocation in the setup flow goes through this one cycle-free
 * adapter: a rejected promise (spawn/transport failure) is reduced to
 * `{ status: "failed", code: null, stdout: "", stderr: "" }` so each phase
 * maps it to its stable error code (`user_token_failed`, project/API/SA/key
 * codes, ...) instead of a CLI `unexpected`. The thrown text may carry
 * tokens or key material and is never forwarded. Deliberate stderr
 * classification (such as the already-exists marker) still works because
 * non-thrown results pass through unchanged.
 */
export function createSafeRunner(runner: GcloudRunner): GcloudRunner {
  return {
    async run(args: readonly string[], options?: GcloudRunOptions): Promise<GcloudRunResult> {
      try {
        return await runner.run(args, options);
      } catch {
        // The invocation threw (spawn/transport failure): the outcome is
        // unknown, and the thrown text is never forwarded.
        return { status: "failed", code: null, stdout: "", stderr: "" };
      }
    },
  };
}

const GCLOUD_BINARY = "gcloud";
const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Exact `gcloud auth login` arguments used for the interactive handoff.
 *
 * These mirror {@link DRIVE_ACCESS_COMMAND} in `humanAuth.ts`; the constant
 * is duplicated here so `gcloudRunner` (which `humanAuth` imports) stays free
 * of a runtime import cycle. `--enable-gdrive-access` grants the Drive scope
 * needed to create and own the spreadsheet; `--force` refreshes the cached
 * credentials of an already-logged-in account that lacks the scope.
 */
export const LOGIN_ARGS = ["auth", "login", "--enable-gdrive-access", "--force"] as const;

/**
 * Sanitized outcome of the interactive `gcloud auth login` handoff.
 *
 * Only the process exit result is exposed: stdout, stderr, and any access
 * token stay in the user's own gcloud credential store and are never
 * captured, stored, checkpointed, or forwarded by Hikoutei.
 */
export type GcloudLoginResult =
  | { readonly status: "ok" }
  | { readonly status: "not_found" }
  | { readonly status: "spawn_error" }
  | { readonly status: "failed"; readonly code: number | null };

/**
 * Minimal child-process surface the login runner observes.
 *
 * The real `spawn` returns a `ChildProcess`; tests inject a fake that emits
 * `error`/`exit`. Only the two lifecycle events the runner maps to a sanitized
 * result are required.
 */
export interface LoginChildProcess {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/** Spawns the login subprocess; injectable so tests assert the exact command and stdio. */
export type LoginSpawner = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: "inherit" },
) => LoginChildProcess;

/** Runs the interactive `gcloud auth login` handoff attached to the terminal. */
export interface GcloudLoginRunner {
  runInteractiveLogin(): Promise<GcloudLoginResult>;
}

/**
 * Production interactive login runner.
 *
 * Spawns `gcloud auth login --enable-gdrive-access --force` with the terminal
 * streams inherited (`stdio: "inherit"`) so the user completes the browser
 * OAuth flow in their own gcloud session and Hikoutei never touches the
 * resulting token. Only the exit outcome is reduced to a sanitized result:
 * `ENOENT` (gcloud not installed) is `not_found`, any other spawn failure is
 * `spawn_error`, a non-zero exit is `failed` with the exit code, and a clean
 * exit is `ok`. The runner resolves exactly once even if both `error` and
 * `exit` arrive.
 *
 * @param spawner Process spawner; defaults to Node's `spawn`. Injectable so
 *   tests assert the exact command and the inherited stdio without spawning.
 */
export function createInteractiveLoginRunner(spawner: LoginSpawner = spawnAsLoginSpawner): GcloudLoginRunner {
  return {
    runInteractiveLogin(): Promise<GcloudLoginResult> {
      return new Promise((resolve) => {
        let settled = false;
        const finish = (result: GcloudLoginResult): void => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(result);
        };
        const child = spawner(GCLOUD_BINARY, LOGIN_ARGS, { stdio: "inherit" });
        child.on("error", (error: NodeJS.ErrnoException) => {
          // The subprocess could not be started. `ENOENT` means gcloud is
          // absent from PATH; anything else is an opaque spawn failure.
          // The error text may carry transport detail and is never forwarded.
          finish(error.code === "ENOENT" ? { status: "not_found" } : { status: "spawn_error" });
        });
        child.on("exit", (code: number | null) => {
          finish(code === 0 ? { status: "ok" } : { status: "failed", code });
        });
      });
    },
  };
}

/** Default spawner backed by Node's `child_process.spawn`. */
function spawnAsLoginSpawner(
  command: string,
  args: readonly string[],
  options: { readonly stdio: "inherit" },
): LoginChildProcess {
  return spawn(command, [...args], options);
}

/**
 * Production runner: executes `gcloud <args>` with `execFile`.
 *
 * `not_found` is returned when the binary is absent from PATH so the preflight
 * can produce a clear "install gcloud" error instead of a generic failure.
 */
export function createGcloudRunner(): GcloudRunner {
  return {
    run(args: readonly string[], options?: GcloudRunOptions): Promise<GcloudRunResult> {
      return new Promise((resolve) => {
        execFile(
          GCLOUD_BINARY,
          [...args],
          {
            encoding: "utf8",
            maxBuffer: MAX_BUFFER_BYTES,
            ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
          },
          (error: unknown, stdout: string, stderr: string) => {
            if (error === null) {
              resolve({ status: "ok", stdout, stderr });
              return;
            }
            const errno = error as NodeJS.ErrnoException;
            if (errno.code === "ENOENT") {
              resolve({ status: "not_found" });
              return;
            }
            const code = typeof errno.code === "number" ? errno.code : null;
            resolve({ status: "failed", code, stdout, stderr });
          },
        );
      });
    },
  };
}
