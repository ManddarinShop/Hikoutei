#!/usr/bin/env node
/**
 * Calculate the next stable SemVer for an automated branch release.
 *
 * The develop workflow uses a patch bump and the main workflow uses a minor
 * bump. The helper deliberately accepts only a numeric MAJOR.MINOR.PATCH base
 * so prerelease or build metadata cannot silently enter the release train.
 */
import { fileURLToPath } from "node:url";
import process from "node:process";

const RELEASE_VERSION_ERROR_CODES = {
  INVALID_BASE_VERSION: "invalid_base_version",
  INVALID_BUMP: "invalid_bump",
};
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_BUMPS = new Set(["patch", "minor"]);

/**
 * Computes the next release version without reading or mutating package files.
 *
 * @param {{ baseVersion: unknown, bump: unknown }} input
 * @returns {{ status: "valid", version: string } | { status: "invalid", code: string, reason: string }}
 */
export function computeReleaseVersion({ baseVersion, bump }) {
  if (typeof baseVersion !== "string" || STABLE_VERSION_PATTERN.test(baseVersion) === false) {
    return {
      status: "invalid",
      code: RELEASE_VERSION_ERROR_CODES.INVALID_BASE_VERSION,
      reason: `base version must be numeric MAJOR.MINOR.PATCH: ${String(baseVersion)}`,
    };
  }
  if (typeof bump !== "string" || RELEASE_BUMPS.has(bump) === false) {
    return {
      status: "invalid",
      code: RELEASE_VERSION_ERROR_CODES.INVALID_BUMP,
      reason: `bump must be patch or minor: ${String(bump)}`,
    };
  }

  const match = STABLE_VERSION_PATTERN.exec(baseVersion);
  if (match === null) {
    return {
      status: "invalid",
      code: RELEASE_VERSION_ERROR_CODES.INVALID_BASE_VERSION,
      reason: `base version must be numeric MAJOR.MINOR.PATCH: ${baseVersion}`,
    };
  }

  const major = BigInt(match[1]);
  const minor = BigInt(match[2]);
  const patch = BigInt(match[3]);
  if (bump === "patch") return { status: "valid", version: `${major}.${minor}.${patch + 1n}` };
  return { status: "valid", version: `${major}.${minor + 1n}.0` };
}

/** Parses the CLI's explicit key=value arguments. */
function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (argument.startsWith("--base-version=")) {
      values.baseVersion = argument.slice("--base-version=".length);
    } else if (argument.startsWith("--bump=")) {
      values.bump = argument.slice("--bump=".length);
    } else {
      return { status: "invalid", code: "invalid_arguments", reason: `unexpected argument: ${argument}` };
    }
  }
  if (values.baseVersion === undefined || values.bump === undefined) {
    return {
      status: "invalid",
      code: "missing_arguments",
      reason: "--base-version and --bump are required",
    };
  }
  return { status: "valid", value: values };
}

/** Runs the release-version command used by GitHub Actions. */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.status === "invalid") {
    process.stderr.write(`release-version:${parsed.code}: ${parsed.reason}\n`);
    return 2;
  }

  const result = computeReleaseVersion(parsed.value);
  if (result.status === "invalid") {
    process.stderr.write(`release-version:${result.code}: ${result.reason}\n`);
    return 1;
  }
  process.stdout.write(`${result.version}\n`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
