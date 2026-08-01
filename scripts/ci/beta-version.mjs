#!/usr/bin/env node
/**
 * Compute the unique beta version for a `develop` push.
 *
 * Given the package.json version (for example `0.3.0` or a prerelease such as
 * `0.3.0-beta.1`), this strips any prerelease/build suffix, validates the
 * remaining `MAJOR.MINOR.PATCH` core is fully numeric, and appends the GitHub
 * `-beta.b<RUN_ID>.<RUN_ATTEMPT>` prerelease tail.
 *
 *   `0.3.0` + run 30560831639 attempt 1 -> `0.3.0-beta.b30560831639.1`
 *
 * This logic was extracted from `.github/workflows/beta-publish.yml` so the
 * calculation is unit-testable. The workflow still owns the side effect
 * (`npm version --no-git-tag-version`); this helper only derives the version
 * string. The numeric validation mirrors the previous inline shell check.
 */
import { fileURLToPath } from "node:url";
import process from "node:process";

/** Non-negative integer (leading zeros tolerated, matching the prior shell `^[0-9]+$`). */
const NON_NEGATIVE_INTEGER = /^\d+$/;
/** Fully numeric `MAJOR.MINOR.PATCH` core after any prerelease/build is stripped. */
const NUMERIC_VERSION_CORE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * Pure beta-version calculator.
 *
 * Returns an explicit valid/invalid result union so the CLI wrapper and tests
 * can branch on validity without relying on exceptions for malformed input.
 *
 * @param {{ baseVersion: string, runId: string | number, runAttempt: string | number }} input
 * @returns {{ status: "valid", version: string } | { status: "invalid", reason: string }}
 */
export function computeBetaVersion({ baseVersion, runId, runAttempt }) {
  if (typeof baseVersion !== "string" || baseVersion.length === 0) {
    return { status: "invalid", reason: "baseVersion must be a non-empty string" };
  }

  // Strip the first prerelease (`-`) or build-metadata (`+`) separator onward
  // before numeric validation. Stripping at either separator lets a version
  // that carries only build metadata (e.g. `0.3.0+sha.abc`) reduce to its
  // numeric core, matching how a prerelease suffix is handled.
  const core = baseVersion.split(/[-+]/)[0];
  const match = NUMERIC_VERSION_CORE.exec(core);
  if (match === null) {
    return {
      status: "invalid",
      reason: `package version must be a numeric MAJOR.MINOR.PATCH semver: ${core}`,
    };
  }

  const runIdText = String(runId);
  const runAttemptText = String(runAttempt);
  if (!NON_NEGATIVE_INTEGER.test(runIdText)) {
    return { status: "invalid", reason: `runId must be a non-negative integer: ${runIdText}` };
  }
  if (!NON_NEGATIVE_INTEGER.test(runAttemptText)) {
    return { status: "invalid", reason: `runAttempt must be a non-negative integer: ${runAttemptText}` };
  }

  const [, major, minor, patch] = match;
  return {
    status: "valid",
    version: `${major}.${minor}.${patch}-beta.b${runIdText}.${runAttemptText}`,
  };
}

/**
 * Parse the CLI flags `--base-version`, `--run-id`, and `--run-attempt`.
 *
 * @param {readonly string[]} argv
 * @returns {{ ok: true, value: { baseVersion?: string, runId?: string, runAttempt?: string } } | { ok: false, error: string }}
 */
function parseArgs(argv) {
  const value = {};
  for (const arg of argv) {
    if (arg.startsWith("--base-version=")) {
      value.baseVersion = arg.slice("--base-version=".length);
    } else if (arg.startsWith("--run-id=")) {
      value.runId = arg.slice("--run-id=".length);
    } else if (arg.startsWith("--run-attempt=")) {
      value.runAttempt = arg.slice("--run-attempt=".length);
    } else {
      return { ok: false, error: `unexpected argument: ${arg}` };
    }
  }
  return { ok: true, value };
}

/**
 * CLI entry point: parse flags, compute the beta version, print it to stdout,
 * and return the process exit code (0 success, 1 invalid input, 2 usage error).
 *
 * @param {readonly string[]} [argv]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`beta-version: ${parsed.error}\n`);
    return 2;
  }
  const { baseVersion, runId, runAttempt } = parsed.value;
  if (baseVersion === undefined || runId === undefined || runAttempt === undefined) {
    process.stderr.write(
      "beta-version: --base-version, --run-id, and --run-attempt are required\n",
    );
    return 2;
  }

  const result = computeBetaVersion({ baseVersion, runId, runAttempt });
  if (result.status === "invalid") {
    process.stderr.write(`beta-version: ${result.reason}\n`);
    return 1;
  }

  process.stdout.write(`${result.version}\n`);
  return 0;
}

// Run only when invoked directly as a script, never when imported by the test.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode);
}
