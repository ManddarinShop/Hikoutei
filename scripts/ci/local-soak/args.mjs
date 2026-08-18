/**
 * CLI parsing and validation for the local multi-table soak runner.
 *
 * Enforces the documented contract:
 * - `--duration-hours` must satisfy 0 < hours <= 24 (6 and 24 are the
 *   documented execution values),
 * - `--interval-seconds`, `--actors`, `--operations-per-actor`,
 *   `--max-consecutive-failures` must be positive integers,
 * - `--tables` must select a non-empty subset of the six soak tables,
 * - `--log-file` and `--output-dir` must be non-empty relative-or-absolute
 *   paths (the runner never echoes their contents to stdout).
 *
 * Redaction contract: validation errors name the OFFENDING OPTION and the
 * documented constraint only — never the raw value. A value may be a path,
 * URL, or email (for example a pasted `--log-file` or `--tables` entry), so
 * echoing it to stderr could leak it into CI logs. Unknown flags print the
 * flag name without any `--flag=value` payload, and a BARE unknown token
 * (a URL, path, email, or credential passed without its option) is rejected
 * with a FIXED stable message that contains no part of the token.
 */

/** Documented maximum soak duration in hours. */
export const MAX_DURATION_HOURS = 24;

/** Default option values matching the approved plan. */
export const DEFAULT_SOAK_OPTIONS = Object.freeze({
  durationHours: 24,
  intervalSeconds: 300,
  actors: 4,
  operationsPerActor: 20,
  tables: undefined, // all six
  seed: undefined, // parsed by prng.parseSeed with its own default
  maxConsecutiveFailures: 5,
  logFile: undefined,
  resume: false,
  cleanupOnly: false,
  outputDir: undefined,
});

/** All table names accepted by `--tables` (comma separated). */
export const SOAK_TABLE_NAMES = Object.freeze([
  "soak_customers",
  "soak_orders",
  "soak_inventory_items",
  "soak_tasks",
  "soak_audit_events",
  "soak_feature_flags",
]);

/**
 * Shape a token must have before its NAME may appear in an error message:
 * `--` plus an ASCII letter and only letters, digits, and hyphens. A token
 * that does not match (a bare URL/path/email/credential, a malformed or
 * `--`-prefixed value) is rejected with the fixed stable message instead
 * of being echoed.
 */
const SAFE_FLAG_NAME_PATTERN = /^--[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Parses the soak CLI arguments.
 *
 * Accepts both `--flag value` and `--flag=value` forms. Unknown flags throw
 * with the offending token.
 *
 * @param {readonly string[]} argv
 * @returns {ReturnType<typeof finalizeOptions>}
 */
export function parseSoakArgs(argv) {
  const options = { ...DEFAULT_SOAK_OPTIONS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    // Split at the FIRST `=` only: a valid value may itself contain `=`
    // (for example a path like `soak/run=1/final=log.txt`), so the value
    // is everything after the first separator, never truncated at a later
    // one.
    const equalsIndex = token.indexOf("=");
    const key = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
    const value = inlineValue !== undefined ? inlineValue : argv[index + 1];
    const requireValue = () => {
      if (inlineValue === undefined) {
        if (index + 1 >= argv.length) {
          throw new Error(`option ${key} requires a value`);
        }
        index += 1;
      }
      if (String(value).trim() === "") {
        throw new Error(`option ${key} requires a non-empty value`);
      }
      return String(value);
    };
    switch (key) {
      case "--duration-hours":
        options.durationHours = parsePositiveNumber(requireValue(), key, MAX_DURATION_HOURS);
        break;
      case "--interval-seconds":
        options.intervalSeconds = parseNonNegativeNumber(requireValue(), key);
        break;
      case "--actors":
        options.actors = parsePositiveInt(requireValue(), key, 64);
        break;
      case "--operations-per-actor":
        options.operationsPerActor = parsePositiveInt(requireValue(), key, 1000);
        break;
      case "--tables": {
        const raw = requireValue();
        options.tables = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
        break;
      }      case "--seed":
        options.seed = requireValue();
        break;
      case "--max-consecutive-failures":
        options.maxConsecutiveFailures = parsePositiveInt(requireValue(), key, 1000);
        break;
      case "--log-file":
        options.logFile = requireValue();
        break;
      case "--output-dir":
        options.outputDir = requireValue();
        break;
      case "--resume":
      case "--cleanup-only":
        if (inlineValue !== undefined || (value !== undefined && !String(value).startsWith("--"))) {
          throw new Error(`option ${key} does not take a value`);
        }
        if (key === "--resume") options.resume = true;
        else options.cleanupOnly = true;
        break;
      default:
        // Only a WELL-FORMED flag name is echoed, never a value payload and
        // never a bare unknown token: a bare token can itself be a path,
        // URL, email, or credential (for example a pasted value that was
        // not attached to its option), so echoing it to stderr could leak
        // it into CI logs. A bare token gets the FIXED stable message with
        // no value of any kind.
        if (SAFE_FLAG_NAME_PATTERN.test(key)) {
          throw new Error(`unknown option: ${key}`);
        }
        throw new Error("unknown option: unexpected argument (not a recognized --option)");
    }
  }
  return finalizeOptions(options);
}

/**
 * Validates cross-field constraints and applies derived defaults.
 * @param {typeof DEFAULT_SOAK_OPTIONS & { tables?: string[] | undefined, seed?: string | undefined }} options
 */
export function finalizeOptions(options) {
  const durationMs = options.durationHours * 3_600_000;
  if (!(durationMs > 0) || durationMs > MAX_DURATION_HOURS * 3_600_000) {
    throw new Error(
      `--duration-hours must be greater than 0 and at most ${MAX_DURATION_HOURS} (received ${options.durationHours})`,
    );
  }
  if (options.tables !== undefined) {
    if (options.tables.length === 0) {
      throw new Error("--tables must name at least one soak table");
    }
    const known = new Set(SOAK_TABLE_NAMES);
    for (const table of options.tables) {
      if (!known.has(table)) {
        // The raw entry is never echoed: it could be a URL, email, or path.
        throw new Error(
          `--tables must only name known soak tables: ${SOAK_TABLE_NAMES.join(", ")}`,
        );
      }
    }
    if (new Set(options.tables).size !== options.tables.length) {
      throw new Error("--tables must not repeat a table");
    }
  }
  if (options.resume && options.outputDir === undefined) {
    throw new Error("--resume requires --output-dir from the interrupted run");
  }
  return {
    ...options,
    durationMs,
    resolvedTables: options.tables === undefined
      ? [...SOAK_TABLE_NAMES]
      : options.tables,
  };
}

/** Parses a positive finite number with an upper bound (hours). */
function parsePositiveNumber(raw, label, upperBound) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > upperBound) {
    // The raw value is never echoed (it could be a path, URL, or email).
    throw new Error(`${label} must be a number in (0, ${upperBound}]`);
  }
  return value;
}

/** Parses a non-negative finite number (interval; 0 = no wait between cycles). */
function parseNonNegativeNumber(raw, label) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return value;
}

/** Parses a positive integer with an explicit inclusive upper bound. */
function parsePositiveInt(raw, label, upperBound) {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const value = Number(raw);
  if (value < 1 || value > upperBound) {
    throw new Error(`${label} must be in [1, ${upperBound}]`);
  }
  return value;
}
