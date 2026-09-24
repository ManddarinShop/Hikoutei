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
import { randomBytes } from "node:crypto";

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

/** Expected device/inode identity of the staging directory at `cwd`. */
export interface GcloudCwdIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** Extra options for one gcloud invocation. */
export interface GcloudRunOptions {
  /**
   * Working directory of the subprocess. Only the key create sets it, to
   * run with a RELATIVE `key.json` destination from the staging
   * directory. When `cwdIdentity` and `cwdFd` are present, the runner
   * launches an isolated Node wrapper (`process.execPath`) that `chdir`s
   * into the pathname and verifies `statSync('.')` against the pinned
   * descriptor and expected identity before invoking `gcloud` with no
   * `cwd` option. Pinning the fd prevents inode reuse from validating a
   * replacement. The parent process CWD is never changed. Other callers omit
   * these fields and run
   * `gcloud` directly (see `keyProvision.ts`).
   */
  readonly cwd?: string;
  /**
   * Expected staging identity captured by `prepareStageDir`. Only
   * meaningful with `cwd`; the key-create call always sets it with `cwdFd`.
   */
  readonly cwdIdentity?: GcloudCwdIdentity;
  /** Open staging-directory descriptor kept alive through the child launch. */
  readonly cwdFd?: number;
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
      // Only the key create sets the verified CWD fields; every other
      // caller runs gcloud directly below with no wrapper involved.
      if (options?.cwd !== undefined && options.cwdIdentity !== undefined) {
        if (options.cwdFd === undefined) {
          return Promise.resolve({ status: "failed", code: null, stdout: "", stderr: "" });
        }
        return runKeyCreateInVerifiedCwd(args, options.cwd, options.cwdIdentity, options.cwdFd);
      }
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

/**
 * Runs one gcloud invocation with its CWD bound to a verified directory
 * object instead of a re-resolved pathname.
 *
 * The parent process CWD is never changed: a small isolated Node child
 * (via `process.execPath`, no shell) `chdir`s into the staging pathname,
 * compares `statSync('.')` with `fstatSync(3)` for the inherited pinned
 * descriptor and the expected identity, then only on an exact match spawns
 * `gcloud` with no `cwd` option so it inherits the wrapper's object-bound
 * directory. A pathname replacement cannot pass by reusing the old inode.
 *
 * Control reporting never parses ordinary gcloud output: the wrapper
 * appends one trailer line carrying a per-call random token
 * (`<token> status=<word>[ code=<n>]`) to its stderr, and the gcloud
 * child is spawned WITHOUT the token in its environment so its own
 * output cannot forge the trailer. stdout is gcloud stdout verbatim;
 * stderr minus the trailer is gcloud stderr verbatim.
 */
function runKeyCreateInVerifiedCwd(
  args: readonly string[],
  stageDir: string,
  expected: GcloudCwdIdentity,
  stageFd: number,
): Promise<GcloudRunResult> {
  // Per-call random token so only this invocation's wrapper can report
  // its control statuses; gcloud output cannot guess it (and never
  // receives it via the environment).
  const token = randomBytes(16).toString("hex");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        STAGE_CWD_WRAPPER_SCRIPT,
        stageDir,
        String(expected.dev),
        String(expected.ino),
        JSON.stringify([...args]),
        token,
      ],
      {
        stdio: ["ignore", "pipe", "pipe", stageFd],
        // No `cwd` or `env` override: the wrapper starts in the caller's
        // environment and receives the pinned directory at fd 3.
      },
    );
    let stdout = "";
    let stderr = "";
    let spawnError: NodeJS.ErrnoException | null = null;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.on("close", (exitCode: number | null) => {
      const parsed = parseStageWrapperTrailer(stderr, token);
      if (parsed === null) {
        // The wrapper crashed or its output was truncated: fail closed
        // with the same shape as a spawn failure. Never report
        // `not_found` here; that status is reserved for the wrapper's
        // explicit gcloud-missing trailer.
        const code =
          typeof exitCode === "number"
            ? exitCode
            : spawnError !== null && typeof spawnError.code === "number"
              ? spawnError.code
              : null;
        resolve({ status: "failed", code, stdout, stderr });
        return;
      }
      const gcloudStderr = stderr.slice(0, parsed.trailerIndex);
      if (parsed.status === "cwd_mismatch" || parsed.status === "wrapper_error") {
        // The pathname did not name the pinned directory when the wrapper
        // bound its CWD: gcloud was never invoked.
        resolve({ status: "failed", code: null, stdout: "", stderr: "" });
        return;
      }
      if (parsed.status === "not_found") {
        resolve({ status: "not_found" });
        return;
      }
      if (parsed.status === "spawn_error") {
        resolve({ status: "failed", code: null, stdout, stderr: gcloudStderr });
        return;
      }
      if (parsed.status === "ok") {
        resolve({ status: "ok", stdout, stderr: gcloudStderr });
        return;
      }
      resolve({ status: "failed", code: parsed.code, stdout, stderr: gcloudStderr });
    });
  });
}

/** Parsed wrapper trailer plus where it starts in the wrapper stderr. */
interface StageWrapperTrailer {
  readonly status: string;
  readonly code: number | null;
  readonly trailerIndex: number;
}

/**
 * Finds this call's control trailer in the wrapper stderr.
 *
 * Returns null when the trailer is absent (wrapper crash/truncation).
 * Only the exact random token line is treated as control data; ordinary
 * gcloud output is never parsed.
 */
function parseStageWrapperTrailer(stderr: string, token: string): StageWrapperTrailer | null {
  const trailerIndex = stderr.lastIndexOf(token);
  if (trailerIndex < 0) {
    return null;
  }
  const trailer = stderr.slice(trailerIndex);
  const match = /^([0-9a-f]+) status=(\S+)(?: code=(\S+))?/.exec(trailer);
  if (match === null || match[1] !== token) {
    return null;
  }
  const status = match[2] as string;
  const rawCode = match[3];
  let code: number | null = null;
  if (rawCode !== undefined) {
    const numeric = Number(rawCode);
    code = Number.isInteger(numeric) ? numeric : null;
  }
  return { status, code, trailerIndex };
}

/**
 * Isolated wrapper evaluated by the child Node (`node -e`).
 *
 * Uses only portable built-ins (`node:fs`, `node:child_process`): chdir
 * into the staging pathname, compare `statSync('.')` with `fstatSync(3)`
 * and the expected identity, then only on an exact match spawn `gcloud`
 * with no `cwd` option (inheriting the object-bound CWD) and no shell. Control values
 * are passed as wrapper arguments, never added to or removed from the
 * inherited environment; the gcloud child receives the original env.
 * Written without template literals so the outer `node -e` string needs
 * no escaping of nested interpolation.
 */
const STAGE_CWD_WRAPPER_SCRIPT = [
  "'use strict';",
  "(() => {",
  "const fs = require('node:fs');",
  "const cp = require('node:child_process');",
  "const [stageDir, rawDev, rawIno, rawArgs, token] = process.argv.slice(1);",
  "const expectedDev = Number(rawDev);",
  "const expectedIno = Number(rawIno);",
  "let gcloudArgs;",
  "try { gcloudArgs = JSON.parse(rawArgs); }",
  "catch (e) { process.stderr.write(token + ' status=wrapper_error\\n'); return; }",
  "if (!Array.isArray(gcloudArgs)) { process.stderr.write(token + ' status=wrapper_error\\n'); return; }",
  "function report(suffix) { process.stderr.write(token + ' status=' + suffix + '\\n'); }",
  "try { process.chdir(stageDir); }",
  "catch (e) { report('cwd_mismatch'); return; }",
  "let st, pinned;",
  "try { st = fs.statSync('.'); pinned = fs.fstatSync(3); }",
  "catch (e) { report('cwd_mismatch'); return; }",
  "if (!st.isDirectory() || !pinned.isDirectory() || pinned.dev !== expectedDev || pinned.ino !== expectedIno || st.dev !== pinned.dev || st.ino !== pinned.ino) { report('cwd_mismatch'); return; }",
  "let result;",
  "try { result = cp.spawnSync('gcloud', gcloudArgs, { encoding: 'utf8', maxBuffer: 1048576 }); }",
  "catch (e) { report('spawn_error'); return; }",
  "if (result.stdout) process.stdout.write(result.stdout);",
  "if (result.stderr) process.stderr.write(result.stderr);",
  "if (result.error) {",
  "if (result.error.code === 'ENOENT') { report('not_found'); return; }",
  "report('spawn_error'); return;",
  "}",
  "if (result.status === 0) { report('ok'); return; }",
  "report('failed code=' + String(result.status));",
  "})();",
].join("\n");
