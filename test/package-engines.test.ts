/**
 * Focused validation for the declared Node engine floor.
 *
 * The soak/schema-inspection harness and the persistence layer use
 * `node:sqlite`, which is only available unflagged from Node 22.13 (the
 * `--experimental-sqlite` flag requirement was removed in v22.13 and v23.4).
 * The package `engines.node` floor must not drop below that availability, or
 * a dependency-free post-install `node` run could `require` a missing builtin.
 *
 * This pins the root (and MCP workspace) engine floor to that availability so
 * the documented floor never silently regresses below what the code needs.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The first Node release where `node:sqlite` is available without a flag. */
const NODE_SQLITE_MINOR = 13; // 22.13.0
const NODE_SQLITE_MAJOR = 22;

/**
 * Numeric form of a semver-range floor entry such as ">=22.13".
 *
 * @param {string} floor semver range floor text, e.g. ">=22.13".
 * @returns {[number, number]} [major, minor] tuple.
 */
function floorMajorMinor(floor: string): [number, number] {
  const match = /^>=(\d+)\.(\d+)/.exec(floor);
  if (match === null) throw new Error(`unexpected engines floor: ${floor}`);
  return [Number(match[1]), Number(match[2])];
}

function readNodeFloor(packageJsonPath: string): string | undefined {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return pkg.engines?.node;
}

describe("Node engine floor versus node:sqlite availability", () => {
  it("root package.json engines.node floor is at least the node:sqlite availability", () => {
    const floor = readNodeFloor(resolve(repoRoot, "package.json"));
    expect(floor).toMatch(/^>=/);
    const [major, minor] = floorMajorMinor(floor as string);
    expect(major).toBeGreaterThanOrEqual(NODE_SQLITE_MAJOR);
    if (major === NODE_SQLITE_MAJOR) {
      expect(minor).toBeGreaterThanOrEqual(NODE_SQLITE_MINOR);
    }
  });

  it("the MCP workspace package.json engines.node floor matches too", () => {
    const floor = readNodeFloor(resolve(repoRoot, "packages/mcp/package.json"));
    expect(floor).toMatch(/^>=/);
    const [major, minor] = floorMajorMinor(floor as string);
    expect(major).toBeGreaterThanOrEqual(NODE_SQLITE_MAJOR);
    if (major === NODE_SQLITE_MAJOR) {
      expect(minor).toBeGreaterThanOrEqual(NODE_SQLITE_MINOR);
    }
  });
});
