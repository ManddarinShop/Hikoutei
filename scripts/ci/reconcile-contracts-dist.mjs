#!/usr/bin/env node
/**
 * Reconcile the root `hikoutei` dist with the bundled `@hikoutei/contracts`
 * leaf package (P8-B publishing fix).
 *
 * Publishing model (owner-approved): exactly ONE npm package is published,
 * `hikoutei`. `@hikoutei/contracts` stays `private: true` (never published)
 * and is NOT a runtime dependency of `hikoutei`. The leaf's compiled output
 * is therefore BUNDLED into the root artifact:
 *
 *   1. `packages/hikoutei-contracts/dist/**` is copied into `dist/contracts/**`
 *      so the leaf ships inside the root package (`files: ["dist"]`).
 *   2. Every `"@hikoutei/contracts/xxx.js"` specifier inside the root dist
 *      (emitted from `src/`) is rewritten to the correct RELATIVE specifier
 *      into `./contracts/xxx.js`, computed per-file with `path.posix.relative`
 *      from the file's own dist-directory depth (e.g. `dist/index.js` ->
 *      `./contracts/xxx.js`, `dist/adapter/sheets/x.js` ->
 *      `../../../contracts/xxx.js`).
 *      Rewrites apply to both `.js` (runtime) and `.d.ts` (published types;
 *      the leaf's own `.d.ts` files ship alongside, so TS resolution works).
 *
 * Guards (script fails the build when violated):
 *   - After rewriting, NO `.js`/`.d.ts` file anywhere inside root `dist/`
 *     (including the bundled copy) may still contain an
 *     `@hikoutei/contracts` literal.
 *   - Mirror check: every module-internal (relative) import/export specifier
 *     in the copied leaf files must resolve to an existing file inside
 *     `dist/contracts/` (leaf-internal relative wiring must survive the copy).
 *
 * Dependencies declared by the leaf itself (`@hikoutei/kohkai`, `zod`) are
 * ALSO dependencies of the root package, so their bare specifiers keep
 * resolving from the root `node_modules` at consumer-install time.
 *
 * Usage: node scripts/ci/reconcile-contracts-dist.mjs   (run right after
 * `tsc -p tsconfig.build.json` in the root `build` script)
 */
import { cp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// fileURLToPath keeps the repo root correct on Windows too (a raw
// new URL().pathname produces a leading '/C:/...' there).
const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const rootDist = path.join(repoRoot, "dist");
const leafDist = path.join(repoRoot, "packages", "hikoutei-contracts", "dist");
const bundledDist = path.join(rootDist, "contracts");
const BUNDLED_POSIX_DIR = "contracts";
const CONTRACTS_PACKAGE_PREFIX = "@hikoutei/contracts";

/** Recursively collect file paths (absolute) under `dir` for `suffixes`. */
async function walkFiles(dir, suffixes = null) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full, suffixes)));
    else if (entry.isFile() && (!suffixes || suffixes.some((s) => entry.name.endsWith(s)))) {
      out.push(full);
    }
  }
  return out;
}

/** Rewrite every quoted `@hikoutei/contracts[/<subpath>]` specifier to the
 * relative specifier from the file's own directory into `contracts/<subpath>`.
 * Depth is computed per-file with `path.posix.relative` on the file's
 * dist-relative POSIX directory — never by blind string prefixing. */
function rewriteSpecifiers(source, fileRelToDist) {
  const fileDirPosix = path.posix.dirname(fileRelToDist.split(path.sep).join(path.posix.sep));
  return source.replace(
    /(['"])@hikoutei\/contracts(?:\/([^'"]+))?\1/g,
    (_match, quote, subpath) => {
      const target = subpath
        ? `${BUNDLED_POSIX_DIR}/${subpath}`
        : `${BUNDLED_POSIX_DIR}/index.js`;
      let rel = path.posix.relative(fileDirPosix, target);
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${quote}${rel}${quote}`;
    },
  );
}

/** Mirror check helper: does a dist/contracts-relative specifier resolve to
 * an existing bundled file? */
function makeResolver(bundledRelPaths) {
  const bundledSet = new Set(bundledRelPaths);
  return (posixRelPath) => {
    const candidates = posixRelPath.endsWith(".js")
      ? [posixRelPath]
      : [posixRelPath, `${posixRelPath}.js`, `${posixRelPath}/index.js`];
    return candidates.some((c) => bundledSet.has(c));
  };
}

/** Extract relative (module-internal) specifiers a bundled file references. */
function extractRelativeSpecifiers(source) {
  const specs = new Set();
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\bexport\s+\*\s+from\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    specs.add(match[1]);
  }
  return [...specs];
}

async function main() {
  // 0. Sanity: both dist trees must exist.
  for (const dir of [rootDist, leafDist]) {
    const ok = await stat(dir).then((s) => s.isDirectory()).catch(() => false);
    if (!ok) {
      console.error(`[reconcile-contracts] FAIL: missing dist tree: ${path.relative(repoRoot, dir)}`);
      process.exit(1);
    }
  }

  // 1. Reset the bundled leaf copy, then copy leaf dist INTO root dist/contracts.
  await rm(bundledDist, { recursive: true, force: true });
  await cp(leafDist, bundledDist, { recursive: true });

  const bundledRelPaths = (await walkFiles(bundledDist)).map((p) =>
    path.relative(rootDist, p).split(path.sep).join(path.posix.sep),
  );
  const resolveBundled = makeResolver(bundledRelPaths);

  // 2. Rewrite specifiers in every emitted-from-src .js/.d.ts under root
  //    dist (everything EXCEPT the bundled dist/contracts subtree).
  const emitFiles = (await walkFiles(rootDist)).filter(
    (abs) =>
      !abs.startsWith(bundledDist + path.sep) &&
      (abs.endsWith(".js") || abs.endsWith(".d.ts")),
  );
  let rewrittenFiles = 0;
  let rewrittenSpecifiers = 0;
  for (const abs of emitFiles) {
    const relToDist = path.relative(rootDist, abs);
    const source = await readFile(abs, "utf8");
    const occurrences = source.match(/['"]@hikoutei\/contracts(?:\/[^'"]+)?['"]/g);
    if (!occurrences) continue;
    await writeFile(abs, rewriteSpecifiers(source, relToDist), "utf8");
    rewrittenFiles += 1;
    rewrittenSpecifiers += occurrences.length;
  }

  // 3. Guard A: no `@hikoutei/contracts` literal may remain anywhere in root
  //    dist (.js + .d.ts, including the bundled leaf copy).
  const offenders = [];
  for (const abs of await walkFiles(rootDist)) {
    if (!(abs.endsWith(".js") || abs.endsWith(".d.ts"))) continue;
    const source = await readFile(abs, "utf8");
    if (source.includes(CONTRACTS_PACKAGE_PREFIX)) offenders.push(path.relative(repoRoot, abs));
  }
  if (offenders.length > 0) {
    console.error(
      `[reconcile-contracts] FAIL: unresolved ${CONTRACTS_PACKAGE_PREFIX} literals remain in root dist (${offenders.length} file(s)):`,
    );
    for (const f of offenders) console.error(`  - ${f}`);
    process.exit(1);
  }

  // 4. Guard B (mirror check): leaf-internal RELATIVE imports must resolve
  //    inside the bundled copy. Bare (package) specifiers (kohkai/zod)
  //    intentionally stay external — the root package declares them.
  const broken = [];
  for (const rel of bundledRelPaths) {
    if (!rel.endsWith(".js") && !rel.endsWith(".d.ts")) continue;
    const dirPosix = path.posix.dirname(rel);
    const source = await readFile(path.join(rootDist, rel), "utf8");
    for (const spec of extractRelativeSpecifiers(source)) {
      const target = path.posix.normalize(path.posix.join(dirPosix, spec));
      if (!resolveBundled(target)) broken.push(`${rel} -> ${spec}`);
    }
  }
  if (broken.length > 0) {
    console.error(
      `[reconcile-contracts] FAIL: leaf-internal relative imports do not resolve in dist/contracts (${broken.length}):`,
    );
    for (const b of broken) console.error(`  - ${b}`);
    process.exit(1);
  }

  console.log(
    `[reconcile-contracts] OK: bundled ${bundledRelPaths.length} leaf file(s) into dist/contracts; ` +
      `rewrote ${rewrittenSpecifiers} specifier(s) across ${rewrittenFiles} root dist file(s); ` +
      `0 remaining ${CONTRACTS_PACKAGE_PREFIX} literals; leaf-relative imports all resolve.`,
  );
}

main();