/**
 * Reserved-path collision predicates for `hikoutei setup`.
 *
 * Purely local filesystem checks run before any confirmation, runner
 * invocation, or API mutation: the setup file paths (service-account key,
 * --output, checkpoint, checkpoint temp, lock) must never canonically
 * resolve to one another. Extracted verbatim from the setup flow; no flow
 * state is consulted here.
 */

import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setupLockPath, setupStateTempPath } from "./checkpoint.js";

/**
 * Result of checking the setup file paths for canonical collisions.
 *
 * `--output` must never resolve to the service-account key path, the
 * checkpoint path, the checkpoint temp path (`<state>.tmp`), or the setup
 * lock path (`<state>.lock`), and the key path must never resolve to any of
 * the other reserved paths; writing one over the other would destroy the key,
 * the resume state, or the lock. The comparison uses canonical paths
 * (realpath of the nearest existing ancestor plus remaining segments, with
 * dangling symlink targets resolved by readlink), device/inode identity for
 * existing hardlinks, and case-folded equality on case-insensitive platforms
 * (macOS/Windows). Any aliasing rejects the run before confirmation, runner
 * invocation, or API mutation.
 */
export type SetupPathCollision =
  | { readonly status: "ok" }
  | { readonly status: "collision"; readonly message: string };

/**
 * Rejects canonical collisions among key, output, checkpoint, checkpoint
 * temp, and lock paths.
 *
 * Returns a stable structured usage error message when any two of the five
 * reserved paths resolve to the same file (symlink aliases, dangling symlink
 * targets, hardlinks, and case aliases on case-insensitive platforms
 * included); the caller maps it to `invalid_args`. This check is purely
 * local and runs before any confirmation or mutation.
 */
export function findSetupPathCollision(input: {
  readonly keyPath: string;
  readonly outputPath: string;
  readonly statePath: string;
}): SetupPathCollision {
  try {
    const candidates = [
      { label: "the service-account key path", path: input.keyPath },
      { label: "--output", path: input.outputPath },
      { label: "the setup checkpoint path", path: input.statePath },
      { label: "the setup checkpoint temp path", path: setupStateTempPath(input.statePath) },
      { label: "the setup lock path", path: setupLockPath(input.statePath) },
    ];
    const canonical = candidates.map(({ path }) => canonicalPath(path));
    const folded = caseFolded(canonical);
    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const a = candidates[i] as { readonly label: string; readonly path: string };
        const b = candidates[j] as { readonly label: string; readonly path: string };
        const same =
          canonical[i] === canonical[j] ||
          (folded !== null && folded[i] === folded[j]) ||
          sameFile(a.path, b.path);
        if (same) {
          return {
            status: "collision",
            message:
              `${a.label} ${a.path} resolves to ` +
              `${b.label} ${b.path}; choose different ` +
              `paths for --output, the key file, and the setup state`,
          };
        }
      }
    }
    return { status: "ok" };
  } catch (error) {
    // An unresolvable path (symlink cycle, permissions) must never run the
    // flow; fail closed with a stable usage error.
    return {
      status: "collision",
      message: `could not resolve the setup paths: ${messageOf(error)}; remove conflicting symlinks and retry`,
    };
  }
}

/**
 * Canonical form of a path for collision checks.
 *
 * Symlinks in existing ancestors (and in the leaf itself when it exists) are
 * resolved; not-yet-existing segments are appended verbatim so a future
 * write location is compared, not guessed at. A dangling symlink leaf is
 * resolved by `readlink` so its target participates in the comparison even
 * though it cannot be `realpath`-ed; symlink cycles fail the check.
 */
function canonicalPath(path: string): string {
  const resolved = resolve(path);
  const tail: string[] = [];
  let current = resolved;
  let hops = 0;
  for (;;) {
    hops += 1;
    if (hops > 100) {
      throw new Error(`symlink cycle while resolving ${path}`);
    }
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        const parent = dirname(current);
        if (parent === current) {
          break;
        }
        tail.unshift(basename(current));
        current = parent;
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      current = resolve(dirname(current), readlinkSync(current));
      continue;
    }
    break;
  }
  return join(realpathSync(current), ...tail);
}

/**
 * True when two existing paths are the same file by device/inode.
 *
 * The comparison follows symlinks (`stat`, not `lstat`): an output path
 * that is a symlink to a hardlink of the key file must be detected even
 * though the two spellings canonicalize to different paths, because writing
 * through the symlink would overwrite the shared inode. A zero inode
 * (Windows placeholders) never matches.
 */
function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino && sa.ino !== 0;
  } catch {
    return false;
  }
}

/**
 * Case-folded canonical paths on case-insensitive platforms.
 *
 * macOS (default) and Windows compare paths case-insensitively, so two
 * spellings can name one file; on case-sensitive platforms no folding is
 * applied and `null` is returned.
 */
function caseFolded(paths: readonly string[]): readonly string[] | null {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return null;
  }
  return paths.map((path) => path.toLowerCase());
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
