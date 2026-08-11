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

/** Runs gcloud with the given arguments and returns the process outcome. */
export interface GcloudRunner {
  run(args: readonly string[]): Promise<GcloudRunResult>;
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
    run(args: readonly string[]): Promise<GcloudRunResult> {
      return new Promise((resolve) => {
        execFile(
          GCLOUD_BINARY,
          [...args],
          { encoding: "utf8", maxBuffer: MAX_BUFFER_BYTES },
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
