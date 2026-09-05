import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  compareDevChannelVersions,
  computeNextDevVersion,
  isMonotonicDevChannelUpdate,
  resolveDevelopTag,
} from "../scripts/ci/semver-monotonic.mjs";

const scriptPath = fileURLToPath(
  new URL("../scripts/ci/semver-monotonic.mjs", import.meta.url),
);

function run(...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
}

describe("compareDevChannelVersions", () => {
  it("orders the dev counter numerically, not lexically", () => {
    expect(compareDevChannelVersions("0.9.31-dev.9", "0.9.31-dev.10")).toStrictEqual({
      status: "valid",
      comparison: -1,
    });
    expect(compareDevChannelVersions("0.9.31-dev.2", "0.9.31-dev.2")).toStrictEqual({
      status: "valid",
      comparison: 0,
    });
  });

  it("compares the base triple before the dev counter", () => {
    expect(compareDevChannelVersions("0.9.31-dev.99", "0.9.32-dev.1")).toStrictEqual({
      status: "valid",
      comparison: -1,
    });
    expect(compareDevChannelVersions("1.0.0-dev.1", "0.9.31-dev.99")).toStrictEqual({
      status: "valid",
      comparison: 1,
    });
  });

  it("treats a dev prerelease as above its stable base on the dev channel", () => {
    expect(compareDevChannelVersions("0.9.31", "0.9.31-dev.1")).toStrictEqual({
      status: "valid",
      comparison: -1,
    });
    expect(compareDevChannelVersions("0.9.31-dev.1", "0.9.31")).toStrictEqual({
      status: "valid",
      comparison: 1,
    });
    expect(compareDevChannelVersions("0.9.31", "0.9.31")).toStrictEqual({
      status: "valid",
      comparison: 0,
    });
  });

  it("supports large numeric components without floating-point rounding", () => {
    expect(
      compareDevChannelVersions(
        "9007199254740993.0.0-dev.9007199254740993",
        "9007199254740993.0.0-dev.9007199254740992",
      ),
    ).toStrictEqual({ status: "valid", comparison: 1 });
  });

  it("rejects malformed or foreign-prerelease versions", () => {
    for (const value of ["0.9.31-beta.1", "0.9", "v0.9.31", "0.9.31-dev.x", ""]) {
      expect(compareDevChannelVersions(value, "0.9.31-dev.1")).toMatchObject({
        status: "invalid",
        code: "invalid_version",
      });
    }
  });
});

describe("isMonotonicDevChannelUpdate", () => {
  it("allows forward and equal targets but refuses regressions", () => {
    expect(isMonotonicDevChannelUpdate("0.9.31-dev.9", "0.9.31-dev.10")).toStrictEqual({
      status: "valid",
      monotonic: true,
    });
    expect(isMonotonicDevChannelUpdate("0.9.31-dev.10", "0.9.31-dev.9")).toStrictEqual({
      status: "valid",
      monotonic: false,
    });
    // Equal versions are allowed: the repair path re-points the channel tag.
    expect(isMonotonicDevChannelUpdate("0.9.31-dev.3", "0.9.31-dev.3")).toStrictEqual({
      status: "valid",
      monotonic: true,
    });
    // The stable base stays monotonic while its own prereleases advance.
    expect(isMonotonicDevChannelUpdate("0.9.31", "0.9.31-dev.1")).toStrictEqual({
      status: "valid",
      monotonic: true,
    });
  });

  it("fails closed on unparsable input", () => {
    expect(isMonotonicDevChannelUpdate("garbage", "0.9.31-dev.1")).toMatchObject({
      status: "invalid",
      code: "invalid_version",
    });
  });
});

describe("resolveDevelopTag", () => {
  it("resolves a dev prerelease tag to the full version string", () => {
    expect(resolveDevelopTag("develop-v0.9.31-dev.2")).toStrictEqual({
      status: "valid",
      version: "0.9.31-dev.2",
    });
  });

  it("rejects plain develop-vX.Y.Z tags so they cannot publish stable versions", () => {
    const result = resolveDevelopTag("develop-v0.9.31");
    expect(result.status).toBe("invalid");
    expect((result as { reason: string }).reason).toContain("-dev.N");
  });

  it("rejects malformed tags", () => {
    for (const tag of ["develop-v0.9", "develop-v0.9.31-dev.", "release-v0.9.31-dev.1", ""]) {
      expect(resolveDevelopTag(tag)).toMatchObject({ status: "invalid" });
    }
  });
});

describe("computeNextDevVersion", () => {
  it("starts the counter at 1 when the dev tag is absent", () => {
    expect(computeNextDevVersion({ baseVersion: "0.9.31", currentDevTag: "" })).toStrictEqual({
      status: "valid",
      version: "0.9.31-dev.1",
    });
  });

  it("increments the counter within the same base triple", () => {
    expect(
      computeNextDevVersion({ baseVersion: "0.9.31", currentDevTag: "0.9.31-dev.7" }),
    ).toStrictEqual({ status: "valid", version: "0.9.31-dev.8" });
    expect(
      computeNextDevVersion({ baseVersion: "0.9.31", currentDevTag: "0.9.31-dev.9" }),
    ).toStrictEqual({ status: "valid", version: "0.9.31-dev.10" });
  });

  it("restarts the counter when the base triple moves", () => {
    expect(
      computeNextDevVersion({ baseVersion: "0.9.32", currentDevTag: "0.9.31-dev.7" }),
    ).toStrictEqual({ status: "valid", version: "0.9.32-dev.1" });
    // Migration case: the dev tag still holds a stable-looking version.
    expect(
      computeNextDevVersion({ baseVersion: "0.9.31", currentDevTag: "0.9.31" }),
    ).toStrictEqual({ status: "valid", version: "0.9.31-dev.1" });
  });

  it("fails closed on a malformed base or dev tag value", () => {
    expect(
      computeNextDevVersion({ baseVersion: "0.9.31-dev.1", currentDevTag: "" }),
    ).toMatchObject({ status: "invalid", code: "invalid_version" });
    expect(
      computeNextDevVersion({ baseVersion: "0.9.31", currentDevTag: "0.9.31-beta.4" }),
    ).toMatchObject({ status: "invalid", code: "invalid_version" });
  });
});

describe("semver-monotonic CLI", () => {
  it("resolves a dev tag and prints the version", () => {
    const result = run("--resolve-tag=develop-v0.9.31-dev.2");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.9.31-dev.2\n");
  });

  it("rejects a plain develop tag with a machine-readable error", () => {
    const result = run("--resolve-tag=develop-v0.9.31");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("semver-monotonic:invalid_tag:");
    expect(result.stderr).toContain("-dev.N");
  });

  it("exits 0 for monotonic and 1 for backward channel moves", () => {
    const forward = run("--monotonic", "--current=0.9.31-dev.9", "--target=0.9.31-dev.10");
    expect(forward.status).toBe(0);
    const equal = run("--monotonic", "--current=0.9.31-dev.4", "--target=0.9.31-dev.4");
    expect(equal.status).toBe(0);
    const backward = run("--monotonic", "--current=0.9.31-dev.10", "--target=0.9.31-dev.9");
    expect(backward.status).toBe(1);
    expect(backward.stderr).toContain("semver-monotonic:channel_backward:");
  });

  it("exits 3 (not the backward 1) for malformed --monotonic input", () => {
    // Regression for the develop-version base probe: exit 1 previously
    // conflated "backward" (safe to keep the local base) with "invalid
    // version" (must abort), so a stderr-suppressing caller could continue
    // on unparsable registry output. Invalid input gets its own exit code.
    const invalidCurrent = run("--monotonic", "--current=not-a-version", "--target=0.9.31-dev.1");
    expect(invalidCurrent.status).toBe(3);
    expect(invalidCurrent.stderr).toContain("semver-monotonic:invalid_version:");
    const invalidTarget = run("--monotonic", "--current=0.9.31", "--target=0.9.31-beta.1");
    expect(invalidTarget.status).toBe(3);
    expect(invalidTarget.stderr).toContain("semver-monotonic:invalid_version:");
  });

  it("compares >=2^53 components without Number precision loss", () => {
    // Regression for the develop-version base selection: an inline
    // Number()-based compare collapsed both triples to 9007199254740992 and
    // called the backward move monotonic (exit 0), letting a stale base win.
    const forward = run(
      "--monotonic",
      "--current=9007199254740992.0.0",
      "--target=9007199254740993.0.0",
    );
    expect(forward.status).toBe(0);
    const backward = run(
      "--monotonic",
      "--current=9007199254740993.0.0",
      "--target=9007199254740992.0.0",
    );
    expect(backward.status).toBe(1);
    expect(backward.stderr).toContain("semver-monotonic:channel_backward:");
  });

  it("computes the next dev version", () => {
    const result = run("--next-dev", "--base-version=0.9.31", "--current-dev-tag=0.9.31-dev.3");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.9.31-dev.4\n");
    const fresh = run("--next-dev", "--base-version=0.9.31", "--current-dev-tag=");
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toBe("0.9.31-dev.1\n");
  });

  it("rejects missing or unexpected arguments as usage errors", () => {
    const noMode = run("--current=0.9.31", "--target=0.9.32");
    expect(noMode.status).toBe(2);
    expect(noMode.stderr).toContain("semver-monotonic:missing_arguments:");

    const unexpected = run("--extra=yes");
    expect(unexpected.status).toBe(2);
    expect(unexpected.stderr).toContain("semver-monotonic:invalid_arguments:");
  });
});
