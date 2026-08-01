import { describe, expect, it } from "vitest";
import { parseRootApiOptions } from "../scripts/ci/root-api-options.mjs";

// Save and restore the env vars the parser reads at call time so the default
// behavior is deterministic regardless of the host process environment.
function withEnv(overrides: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("parseRootApiOptions", () => {
  it("rejects a bare option whose value is the next option (missing value)", () => {
    // The headline hardening case: `--output --summary=foo` must not silently
    // swallow `--summary=foo` as the output path.
    expect(() => parseRootApiOptions(["--output", "--summary=foo"])).toThrow(
      /option --output requires a non-empty value/,
    );
    expect(() => parseRootApiOptions(["--summary", "--output=bar"])).toThrow(
      /option --summary requires a non-empty value/,
    );
  });

  it("rejects a bare option followed by a bare option token", () => {
    expect(() => parseRootApiOptions(["--output", "--summary"])).toThrow(
      /option --output requires a non-empty value/,
    );
  });

  it("rejects a bare option with no following argument", () => {
    expect(() => parseRootApiOptions(["--output"])).toThrow(
      /option --output requires a non-empty value/,
    );
    expect(() => parseRootApiOptions(["--summary"])).toThrow(
      /option --summary requires a non-empty value/,
    );
  });

  it("rejects an empty value in the --key=value form", () => {
    expect(() => parseRootApiOptions(["--output="])).toThrow(
      /option --output requires a non-empty value/,
    );
  });

  it("rejects an empty value in the bare form", () => {
    expect(() => parseRootApiOptions(["--output", ""])).toThrow(
      /option --output requires a non-empty value/,
    );
  });

  it("accepts a value containing `=` in the --key=value form", () => {
    expect(parseRootApiOptions(["--output=foo=bar"]).output).toBe("foo=bar");
    expect(parseRootApiOptions(["--summary=a=b=c"]).summary).toBe("a=b=c");
  });

  it("accepts a value containing `=` in the bare form", () => {
    expect(parseRootApiOptions(["--output", "foo=bar"]).output).toBe("foo=bar");
  });

  it("does not treat a single-dash value as a following option", () => {
    // A leading single dash is not an option token, so it is a literal value.
    expect(parseRootApiOptions(["--output", "-"]).output).toBe("-");
  });

  it("accepts both options in the --key=value form", () => {
    withEnv(
      { HIKOUTEI_CI_OUTPUT: undefined, GITHUB_STEP_SUMMARY: undefined },
      () => {
        const options = parseRootApiOptions([
          "--output=/tmp/a.json",
          "--summary=/tmp/b.md",
        ]);
        expect(options.output).toBe("/tmp/a.json");
        expect(options.summary).toBe("/tmp/b.md");
      },
    );
  });

  it("accepts both options in the bare form", () => {
    withEnv(
      { HIKOUTEI_CI_OUTPUT: undefined, GITHUB_STEP_SUMMARY: undefined },
      () => {
        const options = parseRootApiOptions([
          "--output",
          "/tmp/a.json",
          "--summary",
          "/tmp/b.md",
        ]);
        expect(options.output).toBe("/tmp/a.json");
        expect(options.summary).toBe("/tmp/b.md");
      },
    );
  });

  it("falls back to env defaults when no option is given", () => {
    withEnv(
      {
        HIKOUTEI_CI_OUTPUT: "/env/out.json",
        GITHUB_STEP_SUMMARY: "/env/summary.md",
      },
      () => {
        const options = parseRootApiOptions([]);
        expect(options.output).toBe("/env/out.json");
        expect(options.summary).toBe("/env/summary.md");
      },
    );
  });

  it("uses a temp output path and undefined summary when nothing is set", () => {
    withEnv(
      { HIKOUTEI_CI_OUTPUT: undefined, GITHUB_STEP_SUMMARY: undefined },
      () => {
        const options = parseRootApiOptions([]);
        expect(options.output).toMatch(/hikoutei-root-api-smoke-result\.json$/);
        expect(options.summary).toBeUndefined();
      },
    );
  });

  it("rejects an unknown option", () => {
    expect(() => parseRootApiOptions(["--bogus=1"])).toThrow(/unknown option/);
    expect(() => parseRootApiOptions(["--bogus", "1"])).toThrow(/unknown option/);
  });
});
