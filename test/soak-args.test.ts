/**
 * Focused tests for the soak CLI argument parsing and validation.
 *
 * Covers the documented limits (max 24h, positive actors/operations,
 * non-negative interval), table selection, resume/cleanup flag contracts,
 * and unknown/invalid option rejection. No secrets are ever part of these
 * inputs; the runner itself never echoes option values to stdout.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SOAK_OPTIONS,
  finalizeOptions,
  MAX_DURATION_HOURS,
  parseSoakArgs,
  SOAK_TABLE_NAMES,
} from "../scripts/ci/local-soak/args.mjs";

describe("soak args: defaults and limits", () => {
  it("applies documented defaults for an empty argv", () => {
    const options = parseSoakArgs([]);
    expect(options.durationHours).toBe(DEFAULT_SOAK_OPTIONS.durationHours);
    expect(options.durationHours).toBe(24);
    expect(options.durationMs).toBe(24 * 3_600_000);
    expect(options.intervalSeconds).toBe(DEFAULT_SOAK_OPTIONS.intervalSeconds);
    expect(options.actors).toBe(DEFAULT_SOAK_OPTIONS.actors);
    expect(options.operationsPerActor).toBe(DEFAULT_SOAK_OPTIONS.operationsPerActor);
    expect(options.maxConsecutiveFailures).toBe(DEFAULT_SOAK_OPTIONS.maxConsecutiveFailures);
    expect(options.resume).toBe(false);
    expect(options.cleanupOnly).toBe(false);
    expect(options.resolvedTables).toEqual([...SOAK_TABLE_NAMES]);
  });

  it("accepts the documented 6h and 24h durations", () => {
    expect(parseSoakArgs(["--duration-hours", "6"]).durationMs).toBe(6 * 3_600_000);
    expect(parseSoakArgs(["--duration-hours=24"]).durationMs).toBe(24 * 3_600_000);
  });

  it("rejects durations above the 24h maximum and non-positive values", () => {
    for (const raw of ["25", "24.5", "0", "-1", "abc", "Infinity"]) {
      expect(() => parseSoakArgs(["--duration-hours", raw])).toThrow(
        /--duration-hours/,
      );
    }
  });

  it("accepts a zero interval (no wait between cycles)", () => {
    expect(parseSoakArgs(["--interval-seconds", "0"]).intervalSeconds).toBe(0);
  });

  it("rejects negative or malformed intervals, actors, and op counts", () => {
    expect(() => parseSoakArgs(["--interval-seconds", "-1"])).toThrow();
    expect(() => parseSoakArgs(["--actors", "0"])).toThrow();
    expect(() => parseSoakArgs(["--actors", "1.5"])).toThrow();
    expect(() => parseSoakArgs(["--operations-per-actor", "0"])).toThrow();
  });

  it("bounds actors and operations-per-actor to the documented ceilings", () => {
    expect(() => parseSoakArgs(["--actors", "65"])).toThrow(/--actors/);
    expect(() => parseSoakArgs(["--operations-per-actor", "1001"])).toThrow(
      /--operations-per-actor/,
    );
    expect(parseSoakArgs(["--actors", "64"]).actors).toBe(64);
    expect(parseSoakArgs(["--operations-per-actor", "1000"]).operationsPerActor).toBe(1000);
  });
});

describe("soak args: table selection", () => {
  it("resolves a comma-separated subset in order", () => {
    const options = parseSoakArgs(["--tables", "soak_tasks,soak_customers"]);
    expect(options.resolvedTables).toEqual(["soak_tasks", "soak_customers"]);
  });

  it("rejects unknown, empty, and duplicated tables", () => {
    expect(() => parseSoakArgs(["--tables", "soak_nope"])).toThrow(/known soak tables/);
    expect(() => parseSoakArgs(["--tables", ""])).toThrow(/non-empty/);
    expect(() => parseSoakArgs(["--tables", "soak_tasks,soak_tasks"])).toThrow(
      /must not repeat/,
    );
  });
});

describe("soak args: resume and cleanup flags", () => {
  it("requires --output-dir when resuming", () => {
    expect(() => parseSoakArgs(["--resume"])).toThrow(/--resume requires --output-dir/);
    const options = parseSoakArgs(["--resume", "--output-dir", "/tmp/run-1"]);
    expect(options.resume).toBe(true);
    expect(options.outputDir).toBe("/tmp/run-1");
  });

  it("rejects values attached to boolean flags", () => {
    expect(() => parseSoakArgs(["--resume", "yes"])).toThrow(/does not take a value/);
    expect(() => parseSoakArgs(["--cleanup-only=1"])).toThrow(/does not take a value/);
    expect(parseSoakArgs(["--cleanup-only"]).cleanupOnly).toBe(true);
  });

  it("allows a boolean flag followed by another option", () => {
    const options = parseSoakArgs([
      "--resume", "--duration-hours", "6", "--output-dir", "/tmp/run-1",
    ]);
    expect(options.resume).toBe(true);
    expect(options.durationHours).toBe(6);
  });
});

describe("soak args: output and log paths", () => {
  it("accepts relative or absolute output/log paths without echoing them", () => {
    const options = parseSoakArgs([
      "--output-dir", "./.local/soak/run-1",
      "--log-file", "/tmp/hikoutei-log.txt",
    ]);
    expect(options.outputDir).toBe("./.local/soak/run-1");
    expect(options.logFile).toBe("/tmp/hikoutei-log.txt");
    // The parsed result must not contain any secret-like content; the CLI
    // prints only the redacted summary, never raw option values.
    expect(JSON.stringify(options)).not.toMatch(/secret|credential|token/i);
  });

  it("rejects empty output/log path values", () => {
    expect(() => parseSoakArgs(["--output-dir", " "])).toThrow(/non-empty/);
    expect(() => parseSoakArgs(["--log-file", ""])).toThrow(/non-empty/);
  });

  it("preserves values containing multiple '=' (splits at the first '=' only)", () => {
    // Regression (Luna review): `--flag=value` must split at the FIRST `=`
    // only — a valid value that itself contains `=` (an output/log path or
    // name with an equals sign) must never be truncated.
    const options = parseSoakArgs([
      "--log-file=soak/run=1/final=log.txt",
      "--output-dir=tmp/soak=2/out=dir",
    ]);
    expect(options.logFile).toBe("soak/run=1/final=log.txt");
    expect(options.outputDir).toBe("tmp/soak=2/out=dir");
    // The same split rule applies to every value-carrying option.
    expect(parseSoakArgs(["--seed=0x=1f=2"]).seed).toBe("0x=1f=2");
    // Boolean flags still reject any attached value, including one with `=`.
    expect(() => parseSoakArgs(["--resume=a=b"])).toThrow(/does not take a value/);
  });
});

describe("soak args: error output redaction", () => {
  it("never echoes raw values that could be paths, URLs, emails, or tokens", () => {
    const secretValues = [
      "https://docs.google.com/spreadsheets/d/1AbC/edit",
      "service@project.iam.gserviceaccount.com",
      "/Users/me/.config/gcloud/application_default_credentials.json",
      "ya29.jwt-abcdefghijklmnop",
      "--flag=ya29.secret",
    ];
    const invalidCalls = [
      (value: string) => ["--duration-hours", value],
      (value: string) => ["--interval-seconds", value],
      (value: string) => ["--actors", value],
      (value: string) => ["--operations-per-actor", value],
      (value: string) => ["--max-consecutive-failures", value],
      (value: string) => ["--tables", value],
      // --seed is validated later by parseSeed (covered by its own test);
      // the parser itself stores it verbatim.
    ];
    for (const build of invalidCalls) {
      for (const secret of secretValues) {
        expect(() => parseSoakArgs(build(secret))).toThrow();
        try {
          parseSoakArgs(build(secret));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // The stable option tag is preserved; the raw value never is.
          expect(message).toMatch(/--[a-z-]+/);
          expect(message).not.toContain(secret);
          expect(message).not.toMatch(/docs\.google\.com|iam\.gserviceaccount|ya29|application_default_credentials/);
        }
      }
    }
  });

  it("echoes only the flag name for unknown options, never a value payload", () => {
    expect(() => parseSoakArgs(["--not-a-real-flag"])).toThrow(
      /unknown option: --not-a-real-flag/,
    );
    expect(() => parseSoakArgs(["--not-a-real-flag=https://secret.example/x"])).toThrow(
      /unknown option: --not-a-real-flag/,
    );
    try {
      parseSoakArgs(["--not-a-real-flag=https://secret.example/x"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("secret.example");
    }
  });

  it("rejects a BARE unknown token with a fixed message that never echoes the token", () => {
    // Regression (Luna review): a bare unknown token can itself be a
    // path, URL, email, or credential — a pasted value that was not
    // attached to its option. The error must be the FIXED stable message
    // with no part of the token in it, exactly like the value-payload
    // redaction for known options.
    const secretTokens = [
      "https://docs.google.com/spreadsheets/d/1AbC/edit",
      "service@project.iam.gserviceaccount.com",
      "/Users/me/.config/gcloud/application_default_credentials.json",
      "ya29.jwt-abcdefghijklmnop",
      "--=https://secret.example/x",
      "--secret_token=ya29.jwt",
    ];
    for (const token of secretTokens) {
      expect(() => parseSoakArgs([token]), token).toThrow(/unknown option/);
      try {
        parseSoakArgs([token]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message, token).toBe(
          "unknown option: unexpected argument (not a recognized --option)",
        );
        expect(message).not.toContain(token);
        expect(message).not.toMatch(
          /docs\.google\.com|iam\.gserviceaccount|ya29|application_default_credentials|secret_token/,
        );
      }
    }
  });

  it("keeps the seed parse error free of the raw value", async () => {
    const { parseSeed } = await import("../scripts/ci/local-soak/prng.mjs");
    const secret = "ya29.jwt-token@example.com";
    expect(() => parseSeed(secret)).toThrow(/--seed/);
    try {
      parseSeed(secret);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
    }
  });
});

describe("soak args: unknown options and value forms", () => {
  it("rejects options that require a value when none follows", () => {
    expect(() => parseSoakArgs(["--seed"])).toThrow(/requires a value/);
  });

  it("accepts the --flag=value form and passes the seed through", () => {
    const options = parseSoakArgs(["--seed=0x1f", "--max-consecutive-failures=3"]);
    expect(options.seed).toBe("0x1f");
    expect(options.maxConsecutiveFailures).toBe(3);
  });
});

describe("soak args: finalizeOptions cross-field validation", () => {
  it("re-validates the duration ceiling after manual construction", () => {
    expect(() => finalizeOptions({ durationHours: 48 })).toThrow(/at most 24/);
    expect(() => finalizeOptions({ durationHours: 0 })).toThrow(/greater than 0/);
  });

  it("applies derived durationMs and resolvedTables", () => {
    const options = finalizeOptions({
      durationHours: 6,
      tables: ["soak_tasks"],
    });
    expect(options.durationMs).toBe(6 * 3_600_000);
    expect(options.resolvedTables).toEqual(["soak_tasks"]);
  });

  it("documents the constant used by the CLI limit", () => {
    expect(MAX_DURATION_HOURS).toBe(24);
  });
});
