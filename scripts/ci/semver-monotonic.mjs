#!/usr/bin/env node
/**
 * Dev-channel semver helpers for the develop release train.
 *
 * The develop channel publishes prereleases `X.Y.Z-dev.N` under the npm `dev`
 * dist-tag; `latest` is reserved for the main/stable channel. Ordering on the
 * dev channel compares the numeric X.Y.Z triple first, then the `-dev.N`
 * counter numerically (so `0.9.31-dev.10` sorts above `0.9.31-dev.9`, which a
 * plain string or triple-only comparison gets wrong).
 *
 * Deliberate deviation from strict semver, scoped to this channel: a
 * `X.Y.Z-dev.N` prerelease compares GREATER than the plain base `X.Y.Z` (the
 * develop counter must keep moving forward when the channel migrates over an
 * existing stable tag value) and lower than the next `X.Y.(Z+1)` triple.
 *
 * The workflow-embedded bash delegates all comparison/parsing here so the
 * rules are unit-tested instead of re-implemented inline.
 *
 * CLI exit codes for `--monotonic`: 0 = forward/equal (monotonic), 1 =
 * backward channel move (a valid comparison the caller may fall back on), 3 =
 * invalid input (unparsable version; never safe to treat as "backward"), 2 =
 * usage error.
 */
import { fileURLToPath } from "node:url";
import process from "node:process";

const SEMVER_MONOTONIC_ERROR_CODES = {
  INVALID_VERSION: "invalid_version",
  INVALID_TAG: "invalid_tag",
  CHANNEL_BACKWARD: "channel_backward",
};

/** Accepts `X.Y.Z` and `X.Y.Z-dev.N`; nothing else. */
const CHANNEL_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev\.([0-9]+))?$/;

/** Develop release tag: `develop-vX.Y.Z-dev.N` (the suffix is mandatory). */
const DEVELOP_TAG_PATTERN =
  /^develop-v([0-9]+\.[0-9]+\.[0-9]+)(-dev\.([0-9]+))?$/;

function parseChannelVersion(value) {
  if (typeof value !== "string") return null;
  const match = CHANNEL_VERSION_PATTERN.exec(value);
  if (match === null) return null;
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    dev: match[4] === undefined ? null : BigInt(match[4]),
  };
}

function invalid(reason) {
  return {
    status: "invalid",
    code: SEMVER_MONOTONIC_ERROR_CODES.INVALID_VERSION,
    reason,
  };
}

/**
 * Compares two dev-channel versions (`X.Y.Z` or `X.Y.Z-dev.N`).
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {{ status: "valid", comparison: -1 | 0 | 1 } | { status: "invalid", code: string, reason: string }}
 */
export function compareDevChannelVersions(left, right) {
  const a = parseChannelVersion(left);
  const b = parseChannelVersion(right);
  if (a === null || b === null) {
    return invalid(
      `versions must be X.Y.Z or X.Y.Z-dev.N: ${String(left)} / ${String(right)}`,
    );
  }
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] < b[key]) return { status: "valid", comparison: -1 };
    if (a[key] > b[key]) return { status: "valid", comparison: 1 };
  }
  // Same triple: stable base < its -dev prereleases (channel rule, see header),
  // and prerelease counters compare numerically.
  if (a.dev === null && b.dev === null) return { status: "valid", comparison: 0 };
  if (a.dev === null) return { status: "valid", comparison: -1 };
  if (b.dev === null) return { status: "valid", comparison: 1 };
  if (a.dev < b.dev) return { status: "valid", comparison: -1 };
  if (a.dev > b.dev) return { status: "valid", comparison: 1 };
  return { status: "valid", comparison: 0 };
}

/**
 * True when publishing `target` will not move the dev channel behind
 * `current`. Equal versions are allowed (idempotent tag repair).
 *
 * @param {unknown} current
 * @param {unknown} target
 * @returns {{ status: "valid", monotonic: boolean } | { status: "invalid", code: string, reason: string }}
 */
export function isMonotonicDevChannelUpdate(current, target) {
  const comparison = compareDevChannelVersions(current, target);
  if (comparison.status === "invalid") return comparison;
  return { status: "valid", monotonic: comparison.comparison <= 0 };
}

/**
 * Resolves a `develop-vX.Y.Z-dev.N` release tag to its full prerelease
 * version. Plain `develop-vX.Y.Z` tags are rejected fail-closed so an
 * old-style tag cannot republish a stable-looking version on the dev channel.
 *
 * @param {unknown} tag
 * @returns {{ status: "valid", version: string } | { status: "invalid", code: string, reason: string }}
 */
export function resolveDevelopTag(tag) {
  if (typeof tag !== "string") {
    return {
      status: "invalid",
      code: SEMVER_MONOTONIC_ERROR_CODES.INVALID_TAG,
      reason: `tag must be a string: ${String(tag)}`,
    };
  }
  const match = DEVELOP_TAG_PATTERN.exec(tag);
  if (match === null) {
    return {
      status: "invalid",
      code: SEMVER_MONOTONIC_ERROR_CODES.INVALID_TAG,
      reason: `Develop release tag must be develop-vX.Y.Z-dev.N: ${tag}`,
    };
  }
  if (match[2] === undefined || match[2] === "") {
    return {
      status: "invalid",
      code: SEMVER_MONOTONIC_ERROR_CODES.INVALID_TAG,
      reason:
        `develop releases must be -dev.N prereleases; tag ${tag} carries no ` +
        "`-dev.N` suffix and would publish a stable-looking version on the dev channel",
    };
  }
  return { status: "valid", version: `${match[1]}${match[2]}` };
}

/**
 * Computes the next `X.Y.Z-dev.N` version from the base triple and the
 * current `dev` dist-tag value. An absent dev tag, or a dev tag on a
 * different base triple, starts the counter at 1; otherwise the counter
 * increments within the base.
 *
 * @param {{ baseVersion: unknown, currentDevTag: unknown }} input
 * @returns {{ status: "valid", version: string } | { status: "invalid", code: string, reason: string }}
 */
export function computeNextDevVersion({ baseVersion, currentDevTag }) {
  const base = parseChannelVersion(baseVersion);
  if (base === null || base.dev !== null) {
    return invalid(`base version must be numeric X.Y.Z: ${String(baseVersion)}`);
  }
  const currentRaw = typeof currentDevTag === "string" ? currentDevTag.trim() : "";
  if (currentRaw === "") {
    return { status: "valid", version: `${base.major}.${base.minor}.${base.patch}-dev.1` };
  }
  const current = parseChannelVersion(currentRaw);
  if (current === null) {
    return invalid(`current dev dist-tag is not a channel version: ${currentRaw}`);
  }
  const sameBase =
    current.major === base.major && current.minor === base.minor && current.patch === base.patch;
  const nextCounter =
    sameBase && current.dev !== null ? current.dev + 1n : 1n;
  return {
    status: "valid",
    version: `${base.major}.${base.minor}.${base.patch}-dev.${nextCounter.toString()}`,
  };
}

/** Parses the CLI's explicit key=value arguments. */
function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (argument.startsWith("--resolve-tag=")) {
      values.resolveTag = argument.slice("--resolve-tag=".length);
    } else if (argument === "--monotonic") {
      values.monotonic = true;
    } else if (argument === "--next-dev") {
      values.nextDev = true;
    } else if (argument.startsWith("--current=")) {
      values.current = argument.slice("--current=".length);
    } else if (argument.startsWith("--target=")) {
      values.target = argument.slice("--target=".length);
    } else if (argument.startsWith("--base-version=")) {
      values.baseVersion = argument.slice("--base-version=".length);
    } else if (argument.startsWith("--current-dev-tag=")) {
      values.currentDevTag = argument.slice("--current-dev-tag=".length);
    } else {
      return { status: "invalid", reason: `unexpected argument: ${argument}` };
    }
  }
  return { status: "valid", value: values };
}

/** Runs the semver-monotonic command used by GitHub Actions. */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.status === "invalid") {
    process.stderr.write(`semver-monotonic:invalid_arguments: ${parsed.reason}\n`);
    return 2;
  }
  const values = parsed.value;

  if (values.resolveTag !== undefined) {
    const result = resolveDevelopTag(values.resolveTag);
    if (result.status === "invalid") {
      process.stderr.write(`semver-monotonic:${result.code}: ${result.reason}\n`);
      return 1;
    }
    process.stdout.write(`${result.version}\n`);
    return 0;
  }

  if (values.monotonic) {
    if (values.current === undefined || values.target === undefined) {
      process.stderr.write("semver-monotonic:missing_arguments: --monotonic requires --current and --target\n");
      return 2;
    }
    const result = isMonotonicDevChannelUpdate(values.current, values.target);
    if (result.status === "invalid") {
      // Distinct from the channel_backward exit 1: unparsable input must
      // never be conflated with the ordinary "local base is ahead" outcome,
      // because callers may safely keep their base on backward but must
      // abort on invalid.
      process.stderr.write(`semver-monotonic:${result.code}: ${result.reason}\n`);
      return 3;
    }
    if (!result.monotonic) {
      process.stderr.write(
        `semver-monotonic:${SEMVER_MONOTONIC_ERROR_CODES.CHANNEL_BACKWARD}: refusing to move the dev channel backward: current=${values.current} target=${values.target}\n`,
      );
      return 1;
    }
    process.stdout.write(`monotonic: current=${values.current} target=${values.target}\n`);
    return 0;
  }

  if (values.nextDev) {
    if (values.baseVersion === undefined) {
      process.stderr.write("semver-monotonic:missing_arguments: --next-dev requires --base-version\n");
      return 2;
    }
    const result = computeNextDevVersion({
      baseVersion: values.baseVersion,
      currentDevTag: values.currentDevTag ?? "",
    });
    if (result.status === "invalid") {
      process.stderr.write(`semver-monotonic:${result.code}: ${result.reason}\n`);
      return 1;
    }
    process.stdout.write(`${result.version}\n`);
    return 0;
  }

  process.stderr.write(
    "semver-monotonic:missing_arguments: one of --resolve-tag, --monotonic, --next-dev is required\n",
  );
  return 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
