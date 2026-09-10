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
/** A develop-channel prerelease carrying the numeric stable base to release: legacy `-dev.N` or new bare `-dev`. */
const DEV_BASE_VERSION_PATTERN =
  /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-dev\.[0-9]+|-dev)$/;
const RELEASE_BUMPS = new Set(["patch", "minor"]);

function parseStableVersion(value) {
  if (typeof value !== "string") return null;
  const match = STABLE_VERSION_PATTERN.exec(value);
  if (match === null) return null;
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
  };
}

/**
 * Normalizes a manifest version to the numeric base the stable train bumps.
 *
 * A develop→main merge can leave `X.Y.Z-dev.N` (legacy) or `X.Y.Z-dev`
 * (current) in the committed manifest; the stable release must bump its
 * numeric base, so the caller normalizes here before the strict
 * `computeReleaseVersion` path (which stays numeric-only). Foreign
 * prerelease/build metadata is rejected fail-closed.
 *
 * @param {unknown} value
 * @returns {{ status: "valid", version: string } | { status: "invalid", code: string, reason: string }}
 */
export function normalizeStableBaseVersion(value) {
  if (typeof value === "string") {
    if (STABLE_VERSION_PATTERN.test(value)) {
      return { status: "valid", version: value };
    }
    const match = DEV_BASE_VERSION_PATTERN.exec(value);
    if (match !== null) {
      return { status: "valid", version: match[1] };
    }
  }
  return {
    status: "invalid",
    code: RELEASE_VERSION_ERROR_CODES.INVALID_BASE_VERSION,
    reason: `base version must be numeric X.Y.Z, X.Y.Z-dev.N, or X.Y.Z-dev: ${String(value)}`,
  };
}

/**
 * Computes the next release version without reading or mutating package files.
 *
 * @param {{ baseVersion: unknown, bump: unknown }} input
 * @returns {{ status: "valid", version: string } | { status: "invalid", code: string, reason: string }}
 */
export function computeReleaseVersion({ baseVersion, bump }) {
  const parsed = parseStableVersion(baseVersion);
  if (parsed === null) {
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

  if (bump === "patch") return { status: "valid", version: `${parsed.major}.${parsed.minor}.${parsed.patch + 1n}` };
  return { status: "valid", version: `${parsed.major}.${parsed.minor + 1n}.0` };
}

/**
 * Compares two numeric stable versions for monotonic npm dist-tag updates.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {{ status: "valid", comparison: -1 | 0 | 1 } | { status: "invalid", code: string, reason: string }}
 */
export function compareStableVersions(left, right) {
  const leftVersion = parseStableVersion(left);
  const rightVersion = parseStableVersion(right);
  if (leftVersion === null || rightVersion === null) {
    return {
      status: "invalid",
      code: RELEASE_VERSION_ERROR_CODES.INVALID_BASE_VERSION,
      reason: `versions must be numeric MAJOR.MINOR.PATCH: ${String(left)} / ${String(right)}`,
    };
  }

  for (const component of ["major", "minor", "patch"]) {
    if (leftVersion[component] < rightVersion[component]) return { status: "valid", comparison: -1 };
    if (leftVersion[component] > rightVersion[component]) return { status: "valid", comparison: 1 };
  }
  return { status: "valid", comparison: 0 };
}

/** Parses the CLI's explicit key=value arguments. */
function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (argument.startsWith("--base-version=")) {
      values.baseVersion = argument.slice("--base-version=".length);
    } else if (argument.startsWith("--bump=")) {
      values.bump = argument.slice("--bump=".length);
    } else if (argument.startsWith("--normalize-base=")) {
      values.normalizeBase = argument.slice("--normalize-base=".length);
    } else {
      return { status: "invalid", code: "invalid_arguments", reason: `unexpected argument: ${argument}` };
    }
  }
  if (values.normalizeBase !== undefined) {
    if (values.baseVersion !== undefined || values.bump !== undefined) {
      return {
        status: "invalid",
        code: "invalid_arguments",
        reason: "--normalize-base runs alone; it cannot be combined with --base-version/--bump",
      };
    }
    return { status: "valid", value: values };
  }
  if (values.baseVersion === undefined || values.bump === undefined) {
    return {
      status: "invalid",
      code: "missing_arguments",
      reason: "--normalize-base or both --base-version and --bump are required",
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

  if (parsed.value.normalizeBase !== undefined) {
    const result = normalizeStableBaseVersion(parsed.value.normalizeBase);
    if (result.status === "invalid") {
      process.stderr.write(`release-version:${result.code}: ${result.reason}\n`);
      return 1;
    }
    process.stdout.write(`${result.version}\n`);
    return 0;
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
