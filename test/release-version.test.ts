import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeReleaseVersion } from "../scripts/ci/release-version.mjs";

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

  it("rejects missing or unexpected arguments as usage errors", () => {
    const missing = run("--base-version=0.3.0");
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("release-version:missing_arguments:");

    const unexpected = run("--base-version=0.3.0", "--bump=patch", "--extra=yes");
    expect(unexpected.status).toBe(2);
    expect(unexpected.stderr).toContain("release-version:invalid_arguments:");
  });
});
