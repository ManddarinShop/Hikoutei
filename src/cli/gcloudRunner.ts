/**
 * gcloud subprocess runner for `hikoutei setup`.
 *
 * All gcloud invocations go through the `GcloudRunner` interface so unit
 * tests can inject a fake runner that records commands and returns scripted
 * results without touching the real CLI or the network. The production
 * implementation shells out with `node:child_process` `execFile`; a missing
 * binary is reported distinctly (`not_found`) from a failed invocation.
 */

import { execFile } from "node:child_process";

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
