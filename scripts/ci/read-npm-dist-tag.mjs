#!/usr/bin/env node
/**
 * Read one npm dist-tag while distinguishing an absent tag/package from a
 * registry failure. Release workflows must fail closed on network/auth errors
 * instead of treating them as a first publication. Accepted values are stable
 * `X.Y.Z`, legacy develop-channel prereleases `X.Y.Z-dev.N` (migration reads),
 * and new develop-channel prereleases `X.Y.Z-dev`.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

/** Accepted dist-tag value: stable `X.Y.Z`, legacy `X.Y.Z-dev.N`, or new `X.Y.Z-dev`. */
const CHANNEL_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)((?:-dev\.(0|[1-9]\d*))|(-dev))?$/;

/**
 * @param {{ status: number | null, stdout: string, stderr: string }} result
 * @returns {{ status: "found", version: string } | { status: "missing" } | { status: "failed", code: string, reason: string }}
 */
export function parseNpmViewDistTagResult(result) {
  const stdout = result.stdout.trim();
  if (result.status === 0) {
    if (stdout === "" || stdout === "null" || stdout === "undefined") {
      return { status: "missing" };
    }
    try {
      const value = JSON.parse(stdout);
      // A nonempty JSON string alone is not proof of a usable tag value:
      // only channel versions count as `found`; anything else is malformed
      // output and must fail closed, never surface as a version.
      if (typeof value === "string" && CHANNEL_VERSION_PATTERN.test(value)) {
        return { status: "found", version: value };
      }
    } catch {
      // Some npm versions print a plain value even with --json. Apply the
      // same explicit validation used for the JSON string form.
      if (CHANNEL_VERSION_PATTERN.test(stdout)) {
        return { status: "found", version: stdout };
      }
    }
    return {
      status: "failed",
      code: "invalid_npm_view_output",
      reason: `npm view returned an unsupported value: ${stdout}`,
    };
  }

  try {
    const payload = JSON.parse(stdout);
    if (payload?.error?.code === "E404") return { status: "missing" };
  } catch {
    // A non-JSON failure is always operational and must fail closed.
  }
  return {
    status: "failed",
    code: "npm_view_failed",
    reason: result.stderr.trim() || `npm view exited with status ${String(result.status)}`,
  };
}

/** Reads a public package dist-tag from npm or throws on operational failure. */
export function readNpmDistTag(packageName, tag) {
  const result = spawnSync(
    "npm",
    ["view", packageName, `dist-tags.${tag}`, "--json", "--registry=https://registry.npmjs.org"],
    { encoding: "utf8" },
  );
  if (result.error !== undefined) throw result.error;
  const parsed = parseNpmViewDistTagResult({
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
  if (parsed.status === "failed") {
    throw new Error(`read-npm-dist-tag:${parsed.code}: ${parsed.reason}`);
  }
  return parsed.status === "found" ? parsed.version : "";
}

function parseArgs(argv) {
  const values = {};
  for (const argument of argv) {
    if (argument.startsWith("--package=")) {
      values.packageName = argument.slice("--package=".length);
    } else if (argument.startsWith("--tag=")) {
      values.tag = argument.slice("--tag=".length);
    } else {
      return { status: "invalid", reason: `unexpected argument: ${argument}` };
    }
  }
  if (values.packageName === undefined || values.tag === undefined) {
    return { status: "invalid", reason: "--package and --tag are required" };
  }
  return { status: "valid", value: values };
}

/** CLI entry point used by release publish workflows. */
export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.status === "invalid") {
    process.stderr.write(`read-npm-dist-tag:invalid_arguments: ${parsed.reason}\n`);
    return 2;
  }
  try {
    process.stdout.write(`${readNpmDistTag(parsed.value.packageName, parsed.value.tag)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
