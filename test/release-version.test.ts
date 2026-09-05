import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareStableVersions,
  computeReleaseVersion,
  normalizeStableBaseVersion,
} from "../scripts/ci/release-version.mjs";
import { parseNpmViewDistTagResult } from "../scripts/ci/read-npm-dist-tag.mjs";

const scriptPath = fileURLToPath(
  new URL("../scripts/ci/release-version.mjs", import.meta.url),
);

function run(...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
}

describe("computeReleaseVersion", () => {
  it("increments the patch for develop releases", () => {
    expect(computeReleaseVersion({ baseVersion: "0.3.0", bump: "patch" })).toStrictEqual({
      status: "valid",
      version: "0.3.1",
    });
  });

  it("increments patch values without losing decimal width", () => {
    expect(computeReleaseVersion({ baseVersion: "0.0.9", bump: "patch" })).toStrictEqual({
      status: "valid",
      version: "0.0.10",
    });
  });

  it("increments the minor for main releases and resets patch", () => {
    expect(computeReleaseVersion({ baseVersion: "0.3.1", bump: "minor" })).toStrictEqual({
      status: "valid",
      version: "0.4.0",
    });
  });

  it("increments minor values without losing decimal width", () => {
    expect(computeReleaseVersion({ baseVersion: "1.9.9", bump: "minor" })).toStrictEqual({
      status: "valid",
      version: "1.10.0",
    });
  });

  it("supports large numeric components without floating-point rounding", () => {
    expect(
      computeReleaseVersion({
        baseVersion: "9007199254740991.9007199254740991.9007199254740991",
        bump: "patch",
      }),
    ).toStrictEqual({
      status: "valid",
      version: "9007199254740991.9007199254740991.9007199254740992",
    });
  });

  it("rejects prerelease and build metadata", () => {
    for (const baseVersion of ["0.3.0-beta.1", "0.3.0+sha.abc", "v0.3.0"]) {
      expect(computeReleaseVersion({ baseVersion, bump: "patch" })).toMatchObject({
        status: "invalid",
        code: "invalid_base_version",
      });
    }
  });

  it("rejects malformed numeric versions", () => {
    for (const baseVersion of ["0.3", "0.3.0.0", "0.3.x", "0.03.0", "0..3", ""]) {
      expect(computeReleaseVersion({ baseVersion, bump: "patch" })).toMatchObject({
        status: "invalid",
        code: "invalid_base_version",
      });
    }
  });

  it("rejects unsupported bump names", () => {
    expect(computeReleaseVersion({ baseVersion: "0.3.0", bump: "major" })).toMatchObject({
      status: "invalid",
      code: "invalid_bump",
    });
  });
});

describe("normalizeStableBaseVersion", () => {
  it("passes a numeric stable version through unchanged", () => {
    expect(normalizeStableBaseVersion("0.9.30")).toStrictEqual({
      status: "valid",
      version: "0.9.30",
    });
  });

  it("strips the dev prerelease suffix so the main workflow can minor-bump", () => {
    expect(normalizeStableBaseVersion("0.9.31-dev.7")).toStrictEqual({
      status: "valid",
      version: "0.9.31",
    });
  });

  it("keeps large numeric components exact", () => {
    expect(normalizeStableBaseVersion("9007199254740993.0.0-dev.1")).toStrictEqual({
      status: "valid",
      version: "9007199254740993.0.0",
    });
  });

  it("rejects foreign prerelease, build metadata, and malformed input", () => {
    for (const value of ["0.9.31-beta.1", "0.9.31+sha.abc", "0.9.31-dev.", "0.9", "v0.9.31", ""]) {
      expect(normalizeStableBaseVersion(value)).toMatchObject({
        status: "invalid",
        code: "invalid_base_version",
      });
    }
  });

  it("rejects non-string input", () => {
    expect(normalizeStableBaseVersion(undefined)).toMatchObject({ status: "invalid" });
  });
});

describe("compareStableVersions", () => {
  it("orders numeric versions for a release channel", () => {
    expect(compareStableVersions("0.3.1", "0.3.2")).toStrictEqual({
      status: "valid",
      comparison: -1,
    });
    expect(compareStableVersions("0.4.0", "0.3.9")).toStrictEqual({
      status: "valid",
      comparison: 1,
    });
    expect(compareStableVersions("0.3.1", "0.3.1")).toStrictEqual({
      status: "valid",
      comparison: 0,
    });
  });

  it("rejects prerelease values in the channel guard", () => {
    expect(compareStableVersions("0.3.1-beta.1", "0.3.2")).toMatchObject({
      status: "invalid",
      code: "invalid_base_version",
    });
  });
});

describe("parseNpmViewDistTagResult", () => {
  it("accepts an existing tag", () => {
    expect(parseNpmViewDistTagResult({ status: 0, stdout: '"0.3.1"\n', stderr: "" })).toStrictEqual({
      status: "found",
      version: "0.3.1",
    });
  });

  it("accepts dev-channel prerelease tag values", () => {
    expect(parseNpmViewDistTagResult({ status: 0, stdout: '"0.9.31-dev.2"\n', stderr: "" })).toStrictEqual({
      status: "found",
      version: "0.9.31-dev.2",
    });
    // Plain (non-JSON) npm output must parse prerelease values too.
    expect(parseNpmViewDistTagResult({ status: 0, stdout: "0.9.31-dev.10\n", stderr: "" })).toStrictEqual({
      status: "found",
      version: "0.9.31-dev.10",
    });
  });

  it("accepts an absent tag or package as an empty channel", () => {
    expect(parseNpmViewDistTagResult({ status: 0, stdout: "\n", stderr: "" })).toStrictEqual({
      status: "missing",
    });
    expect(parseNpmViewDistTagResult({
      status: 1,
      stdout: '{"error":{"code":"E404"}}',
      stderr: "npm error code E404",
    })).toStrictEqual({ status: "missing" });
  });

  it("fails closed for registry and malformed-output errors", () => {
    expect(parseNpmViewDistTagResult({ status: 1, stdout: "", stderr: "network down" })).toMatchObject({
      status: "failed",
      code: "npm_view_failed",
    });
    expect(parseNpmViewDistTagResult({ status: 0, stdout: "not-a-version", stderr: "" })).toMatchObject({
      status: "failed",
      code: "invalid_npm_view_output",
    });
  });

  it("classifies unsupported tag values as malformed, never found", () => {
    // Regression for the develop-version base probe: a nonempty JSON string
    // used to count as `found` even when it was not a channel version, so
    // the downstream --monotonic compare received garbage.
    for (const stdout of ['"next"\n', '"0.9.31-beta.1"\n', '"v1.2.3"\n', '"0.9"\n']) {
      expect(parseNpmViewDistTagResult({ status: 0, stdout, stderr: "" })).toMatchObject({
        status: "failed",
        code: "invalid_npm_view_output",
      });
    }
    // Non-JSON (plain-value) output is validated against the same full
    // pattern, including the optional -dev.N prerelease.
    for (const stdout of ["latest\n", "0.9.31-beta.1\n", "0.9.31-dev.x\n"]) {
      expect(parseNpmViewDistTagResult({ status: 0, stdout, stderr: "" })).toMatchObject({
        status: "failed",
        code: "invalid_npm_view_output",
      });
    }
    // The plain-value fallback still accepts both valid channel forms.
    expect(parseNpmViewDistTagResult({ status: 0, stdout: "0.3.1\n", stderr: "" })).toStrictEqual({
      status: "found",
      version: "0.3.1",
    });
  });
});

describe("release-version CLI", () => {
  it("prints a patch release version for the develop workflow", () => {
    const result = run("--base-version=0.3.0", "--bump=patch");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.3.1\n");
    expect(result.stderr).toBe("");
  });

  it("prints a minor release version for the main workflow", () => {
    const result = run("--base-version=0.3.1", "--bump=minor");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.4.0\n");
    expect(result.stderr).toBe("");
  });

  it("rejects prerelease input with a machine-readable error", () => {
    const result = run("--base-version=0.3.0-beta.1", "--bump=patch");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("release-version:invalid_base_version:");
  });

  it("rejects an unknown bump with a machine-readable error", () => {
    const result = run("--base-version=0.3.0", "--bump=major");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("release-version:invalid_bump:");
  });

  it("normalizes a dev prerelease base for the main stable workflow", () => {
    const result = run("--normalize-base=0.9.31-dev.7");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.9.31\n");
    expect(result.stderr).toBe("");
  });

  it("rejects a non-dev prerelease in normalize mode fail-closed", () => {
    const result = run("--normalize-base=0.9.31-beta.1");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("release-version:invalid_base_version:");
  });

  it("rejects combining normalize mode with the strict bump path", () => {
    const result = run("--normalize-base=0.9.31-dev.7", "--bump=minor");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("release-version:invalid_arguments:");
  });

  it("rejects missing or unexpected arguments as usage errors", () => {
    const missing = run("--base-version=0.3.0");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("release-version:missing_arguments:");

    const unexpected = run("--base-version=0.3.0", "--bump=patch", "--extra=yes");
    expect(unexpected.status).toBe(2);
    expect(unexpected.stderr).toContain("release-version:invalid_arguments:");
  });
});
