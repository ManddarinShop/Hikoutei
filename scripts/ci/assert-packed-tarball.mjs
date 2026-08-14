#!/usr/bin/env node
/**
 * Asserts the contents of a packed `hikoutei` npm tarball.
 *
 * CI-only verification infrastructure (never shipped: `files: ["dist"]`
 * excludes `scripts/`). The packed tarball must contain exactly the built
 * `dist/**` tree plus the npm-mandatory metadata npm always adds
 * (`package.json`, `README*`, `LICENSE`/`LICENCE`) and nothing else. The
 * checker reads the ACTUAL tarball with `tar -tf`, so it cannot be fooled by
 * `npm pack --dry-run` output or by a stale source tree.
 *
 * It exits nonzero when:
 *   - a required entry is missing (`package/package.json`,
 *     `package/dist/index.js`, `package/dist/index.d.ts`, and the actual
 *     README/LICENSE names);
 *   - a repository or dev artifact (`src/`, `test/`, `scripts/`, `docs/`,
 *     `design/`, `packages/`, `tsconfig*`, config files, VCS files) leaked
 *     into the tarball;
 *   - an entry outside `dist/**` plus npm-mandatory metadata is present. The
 *     unexpected-entry check is the single source of truth, so a future leak
 *     is rejected even if its name is not enumerated in the forbidden list.
 *
 * Directory records (including the root `package/` entry) are normalized away
 * before validation, because tar writers and npm versions differ in whether
 * they store them.
 *
 * Usage: node scripts/ci/assert-packed-tarball.mjs <path-to-tarball>
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REQUIRED_ENTRIES = [
  "package/package.json",
  "package/dist/index.js",
  "package/dist/index.d.ts",
  "package/README.md",
  "package/LICENSE",
];

// Repository or development artifacts that must never ship. Each entry is
// matched as a path prefix; the unexpected-entry catch-all below remains the
// authoritative check, this list only produces clearer failure messages.
const FORBIDDEN_PREFIXES = [
  "package/src/",
  "package/test/",
  "package/scripts/",
  "package/docs/",
  "package/design/",
  "package/packages/",
  "package/tsconfig",
  "package/vitest.config",
  "package/vite.config",
  "package/.github/",
  "package/.git",
  "package/.eslintrc",
  "package/.prettier",
  "package/.editorconfig",
  "package/.nvmrc",
  "package/.npm",
  "package/.DS_Store",
];

const [tarballArg] = process.argv.slice(2);
if (tarballArg === undefined || tarballArg === "") {
  console.error("usage: node scripts/ci/assert-packed-tarball.mjs <path-to-tarball>");
  process.exit(2);
}
const tarball = resolve(tarballArg);
if (!existsSync(tarball)) {
  console.error(`::error::tarball not found: ${tarball}`);
  process.exit(1);
}

let listing;
try {
  listing = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" });
} catch (error) {
  console.error(`::error::failed to list tarball ${tarball}: ${String(error)}`);
  process.exit(1);
}

// Normalize each entry: strip a leading "./", and drop directory records
// (entries ending in "/" or the bare root "package") before validation.
const entries = listing
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => (line.startsWith("./") ? line.slice(2) : line))
  .filter((line) => line !== "package" && !line.endsWith("/"))
  .sort();

const failures = [];

for (const required of REQUIRED_ENTRIES) {
  if (!entries.includes(required)) {
    failures.push(`required entry missing: ${required}`);
  }
}

for (const forbidden of FORBIDDEN_PREFIXES) {
  const matches = entries.filter((entry) => entry.startsWith(forbidden));
  if (matches.length > 0) {
    failures.push(`forbidden artifact matched '${forbidden}':\n${matches.map((entry) => `  ${entry}`).join("\n")}`);
  }
}

const unexpected = [];
for (const entry of entries) {
  if (!entry.startsWith("package/")) {
    failures.push(`entry outside the package root: ${entry}`);
    continue;
  }
  const name = entry.slice("package/".length);
  if (name.startsWith("dist/")) continue;
  if (name === "package.json") continue;
  if (name === "LICENSE" || name === "LICENCE") continue;
  if (name.startsWith("README")) continue;
  unexpected.push(entry);
}
if (unexpected.length > 0) {
  failures.push(
    `unexpected entries outside dist/ and npm-mandatory metadata:\n${unexpected.map((entry) => `  ${entry}`).join("\n")}`,
  );
}

if (failures.length > 0) {
  console.error(`::error::packed tarball allowlist failed for ${tarball}:`);
  for (const failure of failures) {
    console.error(failure);
  }
  console.error("--- packed tarball contents ---");
  for (const entry of entries) {
    console.error(entry);
  }
  process.exit(1);
}

console.log(`Packed tarball allowlist: OK (${entries.length} file entries in ${tarball})`);
