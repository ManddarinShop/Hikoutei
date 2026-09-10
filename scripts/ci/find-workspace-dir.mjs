/**
 * Workspace directory discovery for release/CI workflows.
 *
 * Package directories move (e.g. `packages/ikisaki` ->
 * `packages/protocol/ikisaki`) while package names and dependency edges stay
 * stable. Workflows must therefore locate workspaces by name/dependency
 * instead of hardcoding paths, or every directory move silently rots the
 * release pipeline (stale pins resolve the registry tarball instead of the
 * workspace link).
 *
 * CLI:
 *   --package=<name>   print the single workspace dir with that package
 *                       name (exit 1 unless exactly one matches).
 *   --with-dep=<name>  print manifest paths (one per line) carrying the
 *                       dependency in dependencies or devDependencies
 *                       (exit 1 on zero matches: a bump step that silently
 *                       updates nothing leaves stale pins behind).
 *   --root=<dir>       repository root to search under (default ".").
 *
 * Exit codes: 0 = success, 1 = no/ambiguous match, 2 = usage error.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SEARCH_ROOT = "packages";
const MAX_DEPTH = 3;
const SKIP_DIRS = new Set(["node_modules"]);

function toPosix(p) {
  return p.split(sep).join("/");
}

/** Collects { dir, manifest, pkg } for every workspace manifest under root. */
export function collectWorkspaceManifests(rootDir) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const sub = join(dir, entry.name);
      const manifest = join(sub, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg !== null && typeof pkg === "object") {
          found.push({ dir: toPosix(relative(rootDir, sub)), manifest: toPosix(relative(rootDir, manifest)), pkg });
        }
      } catch {
        // Not a parseable manifest; still descend (nested workspaces).
      }
      if (depth > 0) {
        walk(sub, depth - 1);
      }
    }
  };
  walk(join(rootDir, SEARCH_ROOT), MAX_DEPTH);
  return found;
}

/** Finds the single workspace dir whose package.json carries the name. */
export function findWorkspaceDirByPackageName(rootDir, name) {
  const matches = collectWorkspaceManifests(rootDir)
    .filter((m) => m.pkg.name === name)
    .map((m) => m.dir);
  if (matches.length !== 1) {
    return { status: "invalid", reason: `expected exactly one workspace named ${name}, found ${matches.length}` };
  }
  return { status: "valid", dir: matches[0] };
}

/** Lists manifests carrying dep in dependencies or devDependencies. */
export function findManifestsWithDep(rootDir, dep) {
  const matches = collectWorkspaceManifests(rootDir)
    .filter(
      (m) =>
        (m.pkg.dependencies !== null &&
          typeof m.pkg.dependencies === "object" &&
          dep in m.pkg.dependencies) ||
        (m.pkg.devDependencies !== null &&
          typeof m.pkg.devDependencies === "object" &&
          dep in m.pkg.devDependencies),
    )
    .map((m) => m.manifest);
  if (matches.length === 0) {
    return { status: "invalid", reason: `no workspace manifest depends on ${dep}` };
  }
  return { status: "valid", manifests: [...matches].sort() };
}

/** Runs the find-workspace-dir command used by GitHub Actions. */
export function main(argv = process.argv.slice(2)) {
  let packageName;
  let withDep;
  let root = ".";
  for (const argument of argv) {
    if (argument.startsWith("--package=")) {
      packageName = argument.slice("--package=".length);
    } else if (argument.startsWith("--with-dep=")) {
      withDep = argument.slice("--with-dep=".length);
    } else if (argument.startsWith("--root=")) {
      root = argument.slice("--root=".length);
    } else {
      process.stderr.write(`find-workspace-dir:invalid_arguments: unexpected argument: ${argument}\n`);
      return 2;
    }
  }
  if ((packageName === undefined) === (withDep === undefined)) {
    process.stderr.write("find-workspace-dir:missing_arguments: exactly one of --package or --with-dep is required\n");
    return 2;
  }
  if (packageName !== undefined) {
    const result = findWorkspaceDirByPackageName(root, packageName);
    if (result.status === "invalid") {
      process.stderr.write(`find-workspace-dir:no_match: ${result.reason}\n`);
      return 1;
    }
    process.stdout.write(`${result.dir}\n`);
    return 0;
  }
  const result = findManifestsWithDep(root, withDep);
  if (result.status === "invalid") {
    process.stderr.write(`find-workspace-dir:no_match: ${result.reason}\n`);
    return 1;
  }
  for (const manifest of result.manifests) {
    process.stdout.write(`${manifest}\n`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
