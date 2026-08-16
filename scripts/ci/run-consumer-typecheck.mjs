#!/usr/bin/env node
/**
 * Runs the installed-consumer TypeScript typecheck for the public API.
 *
 * CI-only verification infrastructure (never shipped: `files: ["dist"]`
 * excludes `scripts/`). The JS runtime smokes never compile an external
 * consumer against the packed `dist/index.d.ts`; this checker closes that gap:
 *
 *   1. It copies the checked-in `consumer-typecheck.ts` (the single source of
 *      the public type/import guards) into the throwaway consumer directory.
 *   2. It runs the TypeScript compiler INSTALLED inside that consumer
 *      directory (`node_modules/typescript/bin/tsc`) with `--noEmit`, so the
 *      compile resolves `import "hikoutei"` against the INSTALLED packed
 *      tarball, never against repository source.
 *   3. It fails unless the consumer directory actually contains the installed
 *      `hikoutei` package, so a miswired workflow cannot silently compile
 *      against a stale node_modules or the repo tree.
 *
 * The consumer is expected to have been created with `npm init` and to have
 * installed the packed tarballs plus `typescript` (and the package's peer
 * dependencies) before this script runs. The checked-in consumer source is
 * typechecked only; nothing executes and no Google credentials are required.
 *
 * Usage: node scripts/ci/run-consumer-typecheck.mjs --consumer-dir <dir>
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));

function usage() {
  console.error("usage: node scripts/ci/run-consumer-typecheck.mjs --consumer-dir <dir>");
  process.exit(2);
}

const args = process.argv.slice(2);
let consumerDirArg;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--consumer-dir") {
    consumerDirArg = args[index + 1];
    index += 1;
  } else if (arg?.startsWith("--consumer-dir=")) {
    consumerDirArg = arg.slice("--consumer-dir=".length);
  } else {
    usage();
  }
}
if (consumerDirArg === undefined || consumerDirArg === "") usage();

const consumerDir = resolve(consumerDirArg);
if (!existsSync(consumerDir)) {
  console.error(`::error::consumer directory not found: ${consumerDir}`);
  process.exit(1);
}

// Sanity: the consumer must contain the package installed FROM THE TARBALL.
// Without this, a workflow miswire could compile against a stale or linked
// node_modules and silently skip the packed dist/index.d.ts.
if (!existsSync(join(consumerDir, "node_modules", "hikoutei", "package.json"))) {
  console.error(
    `::error::installed hikoutei package not found in ${consumerDir}/node_modules; ` +
      "install the packed tarball into the consumer before running this checker",
  );
  process.exit(1);
}

const tscEntry = join(consumerDir, "node_modules", "typescript", "bin", "tsc");
if (!existsSync(tscEntry)) {
  console.error(
    `::error::TypeScript compiler not found at ${tscEntry}; ` +
      "install typescript into the consumer before running this checker",
  );
  process.exit(1);
}

const consumerSource = join(scriptDir, "consumer-typecheck.ts");
copyFileSync(consumerSource, join(consumerDir, "consumer-typecheck.ts"));

try {
  // `process.execPath` runs the compiler's JS entry directly, so this works
  // regardless of platform .bin shims. Flags mirror the public-contract
  // typecheck: strict, bundler resolution, no emit, no execution.
  execFileSync(
    process.execPath,
    [
      tscEntry,
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "es2022",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "consumer-typecheck.ts",
    ],
    { cwd: consumerDir, stdio: "inherit" },
  );
} catch (error) {
  console.error("::error::installed-consumer TypeScript typecheck failed");
  process.exit(1);
}

console.log("Installed-consumer TypeScript typecheck: OK");
