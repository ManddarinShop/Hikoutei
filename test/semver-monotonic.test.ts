import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("orders the legacy dev counter numerically, not lexically", () => {
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

  it("treats a legacy dev prerelease as above its stable base on the dev channel", () => {
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

  it("treats a -dev prerelease as below its same-triple stable", () => {
    expect(compareDevChannelVersions("0.10.1-dev", "0.10.1")).toStrictEqual({
      status: "valid",
      comparison: -1,
    });
    expect(compareDevChannelVersions("0.10.1", "0.10.1-dev")).toStrictEqual({
      status: "valid",
      comparison: 1,
    });
    expect(compareDevChannelVersions("0.10.1-dev", "0.10.1-dev")).toStrictEqual({
      status: "valid",
      comparison: 0,
    });
  });

  it("follows the triple when stable and prerelease triples differ", () => {
    expect(compareDevChannelVersions("0.10.1-dev", "0.10.0")).toStrictEqual({
      status: "valid",
      comparison: 1,
    });
    expect(compareDevChannelVersions("0.10.1-dev", "0.10.2")).toStrictEqual({
      status: "valid",
      comparison: -1,
    });
    expect(compareDevChannelVersions("0.10.1-dev", "0.10.2-dev.1")).toStrictEqual({
      status: "valid",
      comparison: -1,
    });
    expect(compareDevChannelVersions("0.10.2-dev", "0.10.1-dev.99")).toStrictEqual({
      status: "valid",
      comparison: 1,
    });
  });

  it("orders -dev below legacy -dev.N on the same triple", () => {
    expect(compareDevChannelVersions("0.10.1-dev", "0.10.1-dev.1")).toStrictEqual({
      status: "valid",
      comparison: -1,
    });
  });

  it("supports large numeric components without floating-point rounding", () => {
    expect(
      compareDevChannelVersions(
        "9007199254740993.0.0-dev.9007199254740993",
        "9007199254740993.0.0-dev.9007199254740992",
      ),
    ).toStrictEqual({ status: "valid", comparison: 1 });
    expect(
      compareDevChannelVersions("9007199254740993.0.0-dev", "9007199254740993.0.0"),
    ).toStrictEqual({ status: "valid", comparison: -1 });
  });

  it("rejects malformed or foreign-prerelease versions", () => {
    for (const value of ["0.9.31-beta.1", "0.9", "v0.9.31", "0.9.31-dev.x", "0.10.1.DEV", "0.10.1.dev", ""]) {
      expect(compareDevChannelVersions(value, "0.10.1-dev")).toMatchObject({
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

  it("orders the new -dev form monotonically without moving backward", () => {
    expect(isMonotonicDevChannelUpdate("0.10.1-dev", "0.10.2-dev")).toStrictEqual({
      status: "valid",
      monotonic: true,
    });
    expect(isMonotonicDevChannelUpdate("0.10.2-dev", "0.10.1-dev")).toStrictEqual({
      status: "valid",
      monotonic: false,
    });
    expect(isMonotonicDevChannelUpdate("0.10.1-dev", "0.10.1-dev")).toStrictEqual({
      status: "valid",
      monotonic: true,
    });
    // A -dev prerelease is below its same-triple stable, so stable is forward.
    expect(isMonotonicDevChannelUpdate("0.10.1-dev", "0.10.1")).toStrictEqual({
      status: "valid",
      monotonic: true,
    });
    expect(isMonotonicDevChannelUpdate("0.10.1", "0.10.1-dev")).toStrictEqual({
      status: "valid",
      monotonic: false,
    });
  });

  it("fails closed on unparsable input", () => {
    expect(isMonotonicDevChannelUpdate("garbage", "0.10.1-dev")).toMatchObject({
      status: "invalid",
      code: "invalid_version",
    });
  });
});

describe("resolveDevelopTag", () => {
  it("resolves a -dev tag to the full version string", () => {
    expect(resolveDevelopTag("develop-v0.10.1-dev")).toStrictEqual({
      status: "valid",
      version: "0.10.1-dev",
    });
  });

  it("rejects legacy -dev.N tags so the two formats never mix", () => {
    const result = resolveDevelopTag("develop-v0.9.31-dev.2");
    expect(result.status).toBe("invalid");
    expect((result as { reason: string }).reason).toContain("-dev.N");
  });

  it("rejects plain develop-vX.Y.Z tags so they cannot publish stable versions", () => {
    const result = resolveDevelopTag("develop-v0.10.1");
    expect(result.status).toBe("invalid");
    expect((result as { reason: string }).reason).toContain("-dev");
  });

  it("rejects malformed tags", () => {
    for (const tag of ["develop-v0.9", "develop-v0.10.1-dev.1.2", "release-v0.10.1-dev", ""]) {
      expect(resolveDevelopTag(tag)).toMatchObject({ status: "invalid" });
    }
  });
});

describe("computeNextDevVersion", () => {
  it("marches the patch from latest when the dev tag is absent", () => {
    expect(computeNextDevVersion("0.10.0", "")).toStrictEqual({
      status: "valid",
      version: "0.10.1-dev",
    });
    expect(computeNextDevVersion({ latest: "0.10.0", currentDev: "" })).toStrictEqual({
      status: "valid",
      version: "0.10.1-dev",
    });
  });

  it("marches from latest when the dev triple is behind or equal", () => {
    // Behind (legacy form): triple 0.9.9 <= latest 0.10.0.
    expect(computeNextDevVersion("0.10.0", "0.9.9-dev.5")).toStrictEqual({
      status: "valid",
      version: "0.10.1-dev",
    });
    // Equal triple (stable dev value): still marches from latest.
    expect(computeNextDevVersion("0.10.0", "0.10.0")).toStrictEqual({
      status: "valid",
      version: "0.10.1-dev",
    });
    // Equal triple (new form at the latest patch): marches from latest.
    expect(computeNextDevVersion("0.10.0", "0.10.0-dev")).toStrictEqual({
      status: "valid",
      version: "0.10.1-dev",
    });
  });

  it("marches from the dev triple when it is ahead of latest", () => {
    expect(computeNextDevVersion("0.10.0", "0.10.1-dev")).toStrictEqual({
      status: "valid",
      version: "0.10.2-dev",
    });
    // Legacy ahead form contributes only its triple.
    expect(computeNextDevVersion("0.10.0", "0.10.2-dev.3")).toStrictEqual({
      status: "valid",
      version: "0.10.3-dev",
    });
    expect(computeNextDevVersion("0.10.0", "0.10.5-dev")).toStrictEqual({
      status: "valid",
      version: "0.10.6-dev",
    });
  });

  it("migrates the legacy dev tag 0.9.33-dev.4 to 0.9.34-dev with no counter carry", () => {
    expect(computeNextDevVersion("0.9.33", "0.9.33-dev.4")).toStrictEqual({
      status: "valid",
      version: "0.9.34-dev",
    });
    // The triple decides: the legacy value sorts below the migrated version.
    expect(compareDevChannelVersions("0.9.33-dev.4", "0.9.34-dev")).toStrictEqual({
      status: "valid",
      comparison: -1,
    });
    // Steady state after migration marches the patch again.
    expect(computeNextDevVersion("0.9.33", "0.9.34-dev")).toStrictEqual({
      status: "valid",
      version: "0.9.35-dev",
    });
  });

  it("supports large numeric components without floating-point rounding", () => {
    expect(computeNextDevVersion("9007199254740993.0.0", "")).toStrictEqual({
      status: "valid",
      version: "9007199254740993.0.1-dev",
    });
  });

  it("fails closed on a malformed latest or dev tag value", () => {
    expect(computeNextDevVersion("0.10.0-dev.1", "")).toMatchObject({
      status: "invalid",
      code: "invalid_version",
    });
    expect(computeNextDevVersion("0.10.0", "0.10.1-beta.4")).toMatchObject({
      status: "invalid",
      code: "invalid_version",
    });
    expect(computeNextDevVersion("0.10.0", "0.10.1.dev")).toMatchObject({
      status: "invalid",
      code: "invalid_version",
    });
    expect(computeNextDevVersion("", "")).toMatchObject({ status: "invalid" });
  });
});

describe("computed dev versions are real npm versions", () => {
  // npm's prerelease rule: numeric triple + hyphen + dot-separated
  // identifiers of [0-9A-Za-z-], each non-empty (numeric identifiers carry
  // no leading zeroes). The old `X.Y.Z.dev` dot form has no hyphen, so it
  // can never pack or publish — this helper pins the rule that caught it.
  const NPM_PRERELEASE_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9A-Za-z-]*))*)$/;

  function isNpmValidPrerelease(value: unknown): boolean {
    return typeof value === "string" && NPM_PRERELEASE_PATTERN.test(value);
  }

  it("pins the npm prerelease rule against known-valid and known-invalid versions", () => {
    for (const valid of ["0.10.1-dev", "0.9.34-dev", "1.0.0-alpha.1"]) {
      expect(isNpmValidPrerelease(valid)).toBe(true);
    }
    for (const invalid of ["0.10.1.dev", "1.0", "0.10.1", "v0.10.1-dev", "0.10.1-", "0.10.1-dev..1", ""]) {
      expect(isNpmValidPrerelease(invalid)).toBe(false);
    }
  });

  it("emits only npm-valid prereleases, including the legacy migration step", () => {
    const cases: Array<[string, string]> = [
      ["0.10.0", ""],
      ["0.10.0", "0.10.1-dev"],
      ["0.9.33", "0.9.33-dev.4"],
      ["0.10.0", "0.10.2-dev.3"],
    ];
    for (const [latest, currentDev] of cases) {
      const result = computeNextDevVersion(latest, currentDev);
      expect(result.status).toBe("valid");
      expect(isNpmValidPrerelease((result as { version: string }).version)).toBe(true);
    }
  });

  it(
    "survives a real `npm version` in a throwaway package (no registry, no git)",
    { timeout: 30_000 },
    () => {
      const next = computeNextDevVersion("0.9.33", "0.9.33-dev.4");
      expect(next).toStrictEqual({ status: "valid", version: "0.9.34-dev" });
      const version = (next as { version: string }).version;
      const dir = mkdtempSync(join(tmpdir(), "hikoutei-dev-version-"));
      try {
        writeFileSync(
          join(dir, "package.json"),
          `${JSON.stringify({ name: "hikoutei-dev-smoke", version: "0.0.0" })}\n`,
        );
        const applied = spawnSync("npm", ["version", version, "--no-git-tag-version"], {
          cwd: dir,
          encoding: "utf8",
        });
        expect(applied.status).toBe(0);
        const written = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          version: string;
        };
        expect(written.version).toBe(version);
        // The old dot form must fail the same command: this is the bug that
        // motivated the hyphen form.
        const dotForm = spawnSync("npm", ["version", "0.10.1.dev", "--no-git-tag-version"], {
          cwd: dir,
          encoding: "utf8",
        });
        expect(dotForm.status).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("semver-monotonic CLI", () => {
  it("resolves a -dev tag and prints the version", () => {
    const result = run("--resolve-tag=develop-v0.10.1-dev");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.10.1-dev\n");
  });

  it("rejects a legacy -dev.N tag with a machine-readable error", () => {
    const result = run("--resolve-tag=develop-v0.9.31-dev.2");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("semver-monotonic:invalid_tag:");
    expect(result.stderr).toContain("-dev.N");
  });

  it("rejects a plain develop tag with a machine-readable error", () => {
    const result = run("--resolve-tag=develop-v0.10.1");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("semver-monotonic:invalid_tag:");
    expect(result.stderr).toContain("-dev");
  });

  it("exits 0 for monotonic and 1 for backward channel moves", () => {
    const forward = run("--monotonic", "--current=0.10.1-dev", "--target=0.10.2-dev");
    expect(forward.status).toBe(0);
    const equal = run("--monotonic", "--current=0.10.1-dev", "--target=0.10.1-dev");
    expect(equal.status).toBe(0);
    const backward = run("--monotonic", "--current=0.10.2-dev", "--target=0.10.1-dev");
    expect(backward.status).toBe(1);
    expect(backward.stderr).toContain("semver-monotonic:channel_backward:");
  });

  it("exits 3 (not the backward 1) for malformed --monotonic input", () => {
    const invalidCurrent = run("--monotonic", "--current=not-a-version", "--target=0.10.1-dev");
    expect(invalidCurrent.status).toBe(3);
    expect(invalidCurrent.stderr).toContain("semver-monotonic:invalid_version:");
    const invalidTarget = run("--monotonic", "--current=0.10.0", "--target=0.10.1-beta.1");
    expect(invalidTarget.status).toBe(3);
    expect(invalidTarget.stderr).toContain("semver-monotonic:invalid_version:");
  });

  it("compares >=2^53 components without Number precision loss", () => {
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

  it("computes the next dev version from latest and current dev", () => {
    const result = run("--next-dev", "--latest=0.10.0", "--current-dev=0.10.1-dev");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.10.2-dev\n");
    const fresh = run("--next-dev", "--latest=0.10.0", "--current-dev=");
    expect(fresh.status).toBe(0);
    expect(fresh.stdout).toBe("0.10.1-dev\n");
  });

  it("migrates the legacy dev tag through the CLI", () => {
    const result = run("--next-dev", "--latest=0.9.33", "--current-dev=0.9.33-dev.4");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.9.34-dev\n");
  });

  it("rejects missing or unexpected arguments as usage errors", () => {
    const noMode = run("--current=0.10.0", "--target=0.10.1-dev");
    expect(noMode.status).toBe(2);
    expect(noMode.stderr).toContain("semver-monotonic:missing_arguments:");

    const unexpected = run("--extra=yes");
    expect(unexpected.status).toBe(2);
    expect(unexpected.stderr).toContain("semver-monotonic:invalid_arguments:");
  });
});
