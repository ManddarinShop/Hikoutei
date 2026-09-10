#!/usr/bin/env node
/**
 * Dev-channel semver helpers for the develop release train.
 *
 * The develop channel publishes prereleases `X.Y.(Z+k)-dev` under the npm `dev`
 * dist-tag — the patch marches forward from the stable line with a fixed bare
 * `-dev` suffix. Examples: latest `0.10.0` → dev `0.10.1-dev`, then
 * `0.10.2-dev`, ... Dev versions read as "ahead of stable" instead of a
 * prerelease attached to the stable triple; semver still excludes them from
 * `^` ranges. `latest` belongs exclusively to the main/stable channel.
 *
 * The OLD `-dev.N` form (`X.Y.Z-dev.N`, tag `develop-vX.Y.Z-dev.N`) is no
 * longer published and is REJECTED fail-closed by the resolve steps — the two
 * formats must never mix; an old-format tag aborts with a clear message. The
 * comparator still READS old values for migration: rule 1 uses their numeric
 * triple only as a "triple <= L or > L" input.
 *
 * Ordering on the dev channel compares the numeric X.Y.Z triple first; a
 * `-dev` prerelease is BELOW its same-triple stable (`0.10.1-dev < 0.10.1`);
 * stable-vs-prerelease on different triples follows the triple. Same-triple
 * legacy `-dev.N` prereleases still compare ABOVE stable (migration reads)
 * and order numerically among themselves, so `0.9.31-dev.10` still sorts above
 * `0.9.31-dev.9`.
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

/** Accepts stable `X.Y.Z`, legacy `X.Y.Z-dev.N`, and new `X.Y.Z-dev`; nothing else. */
const CHANNEL_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)((-dev\.(0|[1-9]\d*))|(-dev))?$/;

/** Develop release tag: `develop-vX.Y.Z-dev` (the `-dev` suffix is mandatory). */
const DEVELOP_TAG_PATTERN =
  /^develop-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-dev)$/;
/** Legacy tag form, rejected fail-closed: `develop-vX.Y.Z-dev.N`. */
const LEGACY_DEVELOP_TAG_PATTERN =
  /^develop-v[0-9]+\.[0-9]+\.[0-9]+-dev\.[0-9]+$/;
/** Plain stable-looking tag, rejected fail-closed: `develop-vX.Y.Z`. */
const PLAIN_DEVELOP_TAG_PATTERN =
  /^develop-v[0-9]+\.[0-9]+\.[0-9]+$/;

function parseChannelVersion(value) {
  if (typeof value !== "string") return null;
  const match = CHANNEL_VERSION_PATTERN.exec(value);
  if (match === null) return null;
  const suffix = match[4];
  if (suffix === undefined) {
    return {
      major: BigInt(match[1]),
      minor: BigInt(match[2]),
      patch: BigInt(match[3]),
      dev: null,
      bareDev: false,
    };
  }
  if (suffix === "-dev") {
    return {
      major: BigInt(match[1]),
      minor: BigInt(match[2]),
      patch: BigInt(match[3]),
      dev: null,
      bareDev: true,
    };
  }
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    dev: BigInt(match[6]),
    bareDev: false,
  };
}

/** Extracts the numeric triple of a parsed channel version. */
function versionTriple(parsed) {
  return { major: parsed.major, minor: parsed.minor, patch: parsed.patch };
}

function invalid(reason) {
  return {
    status: "invalid",
    code: SEMVER_MONOTONIC_ERROR_CODES.INVALID_VERSION,
    reason,
  };
}

/**
 * Compares two dev-channel versions (stable `X.Y.Z`, legacy `X.Y.Z-dev.N`,
 * or new `X.Y.Z-dev`).
 *
 * The numeric triple decides first; on the same triple a `-dev` prerelease is
 * below stable, stable is below legacy `-dev.N`, and `-dev.N` counters compare
 * numerically.
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
      `versions must be X.Y.Z, X.Y.Z-dev.N, or X.Y.Z-dev: ${String(left)} / ${String(right)}`,
    );
  }
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] < b[key]) return { status: "valid", comparison: -1 };
    if (a[key] > b[key]) return { status: "valid", comparison: 1 };
  }
  // Same triple: `-dev` < stable < `-dev.N` (legacy readers); `-dev.N`
  // counters compare numerically.
  const rankOf = (v) => (v.bareDev ? 0 : v.dev === null ? 1 : 2);
  const rankA = rankOf(a);
  const rankB = rankOf(b);
  if (rankA < rankB) return { status: "valid", comparison: -1 };
  if (rankA > rankB) return { status: "valid", comparison: 1 };
  if (a.dev !== null && b.dev !== null) {
    if (a.dev < b.dev) return { status: "valid", comparison: -1 };
    if (a.dev > b.dev) return { status: "valid", comparison: 1 };
  }
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
 * Resolves a `develop-vX.Y.Z-dev` release tag to its full prerelease version.
 * Plain `develop-vX.Y.Z` tags and legacy `develop-vX.Y.Z-dev.N` tags are
 * rejected fail-closed so the two formats never mix on the dev channel.
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
  if (match !== null) {
    return { status: "valid", version: match[1] };
  }
  if (LEGACY_DEVELOP_TAG_PATTERN.test(tag)) {
    return {
      status: "invalid",
      code: SEMVER_MONOTONIC_ERROR_CODES.INVALID_TAG,
      reason:
        `old develop tag format rejected: ${tag} uses -dev.N; the develop channel now ` +
        "publishes X.Y.Z-dev (e.g. develop-v0.10.1-dev)",
    };
  }
  if (PLAIN_DEVELOP_TAG_PATTERN.test(tag)) {
    return {
      status: "invalid",
      code: SEMVER_MONOTONIC_ERROR_CODES.INVALID_TAG,
      reason:
        `develop releases must be -dev prereleases; tag ${tag} carries no ` +
        "`-dev` suffix and would publish a stable-looking version on the dev channel",
    };
  }
  return {
    status: "invalid",
    code: SEMVER_MONOTONIC_ERROR_CODES.INVALID_TAG,
    reason: `Develop release tag must be develop-vX.Y.Z-dev: ${tag}`,
  };
}

/**
 * Computes the next `X.Y.(Z+k)-dev` version from the published `latest` triple
 * and the current `dev` dist-tag value. The `-dev` suffix is fixed (no
 * counter); component math is BigInt-safe.
 *
 * - D absent → `(L.major, L.minor, L.patch+1)-dev`.
 * - D's triple > L → `(D.major, D.minor, D.patch+1)-dev`.
 * - Else (D's triple <= L) → `(L.major, L.minor, L.patch+1)-dev`.
 *
 * D's numeric triple is the X.Y.Z prefix of a stable, legacy `-dev.N`, or new
 * `-dev` value. Accepts both positional `(latest, currentDev)` and object
 * `{ latest, currentDev }` input.
 *
 * @param {unknown} latestOrInput published `latest` triple, or `{ latest, currentDev }`
 * @param {unknown} [currentDevArg] current `dev` dist-tag value (absent = "")
 * @returns {{ status: "valid", version: string } | { status: "invalid", code: string, reason: string }}
 */
export function computeNextDevVersion(latestOrInput, currentDevArg) {
  let latest;
  let currentDev;
  if (
    currentDevArg === undefined &&
    typeof latestOrInput === "object" &&
    latestOrInput !== null
  ) {
    latest = latestOrInput.latest;
    currentDev = latestOrInput.currentDev;
  } else {
    latest = latestOrInput;
    currentDev = currentDevArg;
  }
  if (typeof latest !== "string") {
    return invalid(`latest version must be numeric X.Y.Z: ${String(latest)}`);
  }
  const base = parseChannelVersion(latest.trim());
  if (base === null || base.dev !== null || base.bareDev) {
    return invalid(`latest version must be numeric X.Y.Z: ${String(latest)}`);
  }
  const currentRaw = typeof currentDev === "string" ? currentDev.trim() : "";
  const baseTriple = versionTriple(base);
  let anchor = baseTriple;
  if (currentRaw !== "") {
    const current = parseChannelVersion(currentRaw);
    if (current === null) {
      return invalid(`current dev dist-tag is not a channel version: ${currentRaw}`);
    }
    const currentTriple = versionTriple(current);
    let greater = false;
    for (const key of ["major", "minor", "patch"]) {
      if (currentTriple[key] > baseTriple[key]) {
        greater = true;
        break;
      }
      if (currentTriple[key] < baseTriple[key]) break;
    }
    if (greater) anchor = currentTriple;
  }
  return {
    status: "valid",
    version: `${anchor.major}.${anchor.minor}.${anchor.patch + 1n}-dev`,
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
    } else if (argument.startsWith("--latest=")) {
      values.latest = argument.slice("--latest=".length);
    } else if (argument.startsWith("--base-version=")) {
      values.baseVersion = argument.slice("--base-version=".length);
    } else if (argument.startsWith("--current-dev=")) {
      values.currentDev = argument.slice("--current-dev=".length);
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
    const latest = values.latest ?? values.baseVersion;
    if (latest === undefined) {
      process.stderr.write("semver-monotonic:missing_arguments: --next-dev requires --latest\n");
      return 2;
    }
    if (values.latest !== undefined && values.baseVersion !== undefined) {
      process.stderr.write("semver-monotonic:invalid_arguments: --latest and --base-version are mutually exclusive\n");
      return 2;
    }
    if (values.currentDev !== undefined && values.currentDevTag !== undefined) {
      process.stderr.write("semver-monotonic:invalid_arguments: --current-dev and --current-dev-tag are mutually exclusive\n");
      return 2;
    }
    const result = computeNextDevVersion(
      latest,
      values.currentDev ?? values.currentDevTag ?? "",
    );
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
