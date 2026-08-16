/**
 * Minimal `.env` loader for the MCP server's zero-config onboarding.
 *
 * Reuses the file written by `hikoutei setup` (simple `KEY=VALUE` lines) so a
 * user can point an MCP client at a directory that already has credentials
 * and a spreadsheet URL. Deliberately tiny: no interpolation, no multiline
 * values, no shell semantics. Values already present in `process.env` always
 * win — the file only fills gaps, mirroring common MCP client behavior.
 */

import { readFile } from "node:fs/promises";

/** Result of loading one env file. */
export interface LoadEnvFileResult {
  /** Number of variables applied into the target env (gap-fills only). */
  readonly applied: number;
  /** Names already present in the target env and therefore skipped. */
  readonly skipped: readonly string[];
}

/**
 * Parses raw `.env` content into key/value pairs.
 *
 * Handles blank lines, full-line `#` comments, optional surrounding single
 * or double quotes, and trims whitespace around keys and unquoted values.
 * Exported for tests; production code uses {@link loadEnvFile}.
 */
export function parseEnvFileContent(content: string): Readonly<Record<string, string>> {
  const parsed: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (key === "") continue;
    parsed[key] = unquote(line.slice(equals + 1).trim());
  }
  return parsed;
}

/** Removes one matching pair of surrounding quotes, preserving inner text. */
function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Loads a `.env` file into `target` without overriding existing entries.
 *
 * A missing file is not an error: the result reports `applied: 0`. An
 * unreadable-but-present file rejects so misconfiguration fails closed.
 */
export async function loadEnvFile(
  path: string,
  target: Record<string, string | undefined>,
): Promise<LoadEnvFileResult> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return { applied: 0, skipped: [] };
    }
    throw error;
  }
  const parsed = parseEnvFileContent(content);
  const skipped: string[] = [];
  let applied = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] !== undefined && target[key] !== "") {
      skipped.push(key);
      continue;
    }
    target[key] = value;
    applied += 1;
  }
  return { applied, skipped };
}

/** True when the error is a Node system error with the given code. */
function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
