import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeBetaVersion } from "../scripts/ci/beta-version.mjs";

const scriptPath = fileURLToPath(
  new URL("../scripts/ci/beta-version.mjs", import.meta.url),
);

describe("computeBetaVersion", () => {
  it("produces a beta prerelease from a clean numeric version", () => {
    expect(
      computeBetaVersion({ baseVersion: "0.3.0", runId: "30560831639", runAttempt: "1" }),
    ).toStrictEqual({ status: "valid", version: "0.3.0-beta.b30560831639.1" });
  });

  it("strips a prerelease suffix before computing the beta tag", () => {
    expect(
      computeBetaVersion({ baseVersion: "0.3.0-beta.1", runId: "42", runAttempt: "1" }),
    ).toStrictEqual({ status: "valid", version: "0.3.0-beta.b42.1" });

    // Build metadata after a prerelease is also dropped (strips at the first
    // `-` or `+` separator).
    expect(
      computeBetaVersion({ baseVersion: "0.3.1-dev+sha.2", runId: "7", runAttempt: "3" }),
    ).toStrictEqual({ status: "valid", version: "0.3.1-beta.b7.3" });
  });

  it("strips build metadata when there is no prerelease suffix", () => {
    expect(
      computeBetaVersion({ baseVersion: "0.3.0+sha.abc", runId: "5", runAttempt: "2" }),
    ).toStrictEqual({ status: "valid", version: "0.3.0-beta.b5.2" });

    expect(
      computeBetaVersion({ baseVersion: "1.2.3+20250101", runId: "9", runAttempt: "4" }),
    ).toStrictEqual({ status: "valid", version: "1.2.3-beta.b9.4" });
  });

  it("coerces numeric run id and attempt inputs", () => {
    expect(
      computeBetaVersion({ baseVersion: "1.2.3", runId: 9, runAttempt: 2 }),
    ).toStrictEqual({ status: "valid", version: "1.2.3-beta.b9.2" });
  });

  it("rejects malformed base versions", () => {
    const malformed = [
      "0.3",
      "0.3.0.0",
      "0.3.x",
      "v0.3.0",
      "0..3",
      "0.3.0.",
      "abc",
    ];
    for (const baseVersion of malformed) {
      const result = computeBetaVersion({ baseVersion, runId: "1", runAttempt: "1" });
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.reason).toMatch(/numeric MAJOR.MINOR.PATCH semver/);
      }
    }
  });

  it("rejects an empty or non-string base version with its own reason", () => {
    const empty = computeBetaVersion({
      baseVersion: "",
      runId: "1",
      runAttempt: "1",
    });
    expect(empty).toMatchObject({
      status: "invalid",
      reason: "baseVersion must be a non-empty string",
    });

    const notString = computeBetaVersion({
      baseVersion: undefined as unknown as string,
      runId: "1",
      runAttempt: "1",
    });
    expect(notString.status).toBe("invalid");
  });

  it("rejects a base version whose stripped core is still non-numeric", () => {
    const result = computeBetaVersion({
      baseVersion: "0.x.0-prerelease",
      runId: "1",
      runAttempt: "1",
    });
    expect(result).toMatchObject({ status: "invalid" });
  });

  it("rejects non-numeric run id or attempt", () => {
    expect(
      computeBetaVersion({ baseVersion: "0.3.0", runId: "abc", runAttempt: "1" }).status,
    ).toBe("invalid");
    expect(
      computeBetaVersion({ baseVersion: "0.3.0", runId: "1", runAttempt: "-1" }).status,
    ).toBe("invalid");
    expect(
      computeBetaVersion({ baseVersion: "0.3.0", runId: "1", runAttempt: "1.5" }).status,
    ).toBe("invalid");
  });
});

describe("beta-version CLI", () => {
  // Run the actual script as a subprocess so the test exercises the exact
  // invocation the workflow uses, including stdout formatting and exit codes.
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf-8" });

  it("prints the beta version to stdout and exits 0 for the exact workflow invocation", () => {
    const result = run(
      "--base-version=0.3.0",
      "--run-id=30560831639",
      "--run-attempt=1",
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.3.0-beta.b30560831639.1\n");
    expect(result.stderr).toBe("");
  });

  it("strips a prerelease suffix in the CLI output", () => {
    const result = run(
      "--base-version=0.3.0-beta.1",
      "--run-id=42",
      "--run-attempt=1",
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.3.0-beta.b42.1\n");
  });

  it("strips build-only metadata in the CLI output", () => {
    const result = run(
      "--base-version=0.3.0+sha.abc",
      "--run-id=5",
      "--run-attempt=2",
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.3.0-beta.b5.2\n");
  });

  it("exits 1 and writes nothing to stdout for an invalid base version", () => {
    const result = run("--base-version=0.3", "--run-id=1", "--run-attempt=1");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("numeric MAJOR.MINOR.PATCH semver");
  });

  it("exits 1 for a non-numeric run id", () => {
    const result = run(
      "--base-version=0.3.0",
      "--run-id=abc",
      "--run-attempt=1",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("runId must be a non-negative integer");
  });

  it("exits 2 when a required flag is missing", () => {
    const result = run("--base-version=0.3.0", "--run-id=1");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "--base-version, --run-id, and --run-attempt are required",
    );
    expect(result.stdout).toBe("");
  });

  it("exits 2 for an unexpected argument", () => {
    const result = run(
      "--base-version=0.3.0",
      "--run-id=1",
      "--run-attempt=1",
      "--bogus=1",
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unexpected argument");
  });
});
