#!/usr/bin/env node
/**
 * Reconcile the root `hikoutei` dist with the bundled private leaf packages
 * (P8-B publishing fix, generalized for P8-D2 phase 1).
 *
 * Publishing model (owner-approved): exactly ONE npm package is published,
 * `hikoutei`. `@hikoutei/contracts`, `@hikoutei/storage` and
 * `@hikoutei/sheets` stay `private: true` (never published) and are NOT
 * runtime dependencies of `hikoutei`. Their compiled output is therefore
 * BUNDLED into the root artifact:
 *
 *   1. Each leaf's dist subtree is copied into `dist/<destDir>` so the leaves
 *      ship inside the root package (`files: ["dist"]`):
 *        - packages/hikoutei-contracts/dist          -> dist/contracts/**
 *        - packages/hikoutei-storage/dist/…/src/{storage,persistence}
 *              -> dist/{storage,persistence}/**  (the subpaths the
 *                 `@hikoutei/storage/<sub>` specifiers name; the package's
 *                 transient dist/src/** emission of reached-in root-src
 *                 modules is NOT copied)
 *        - packages/hikoutei-sheets/dist/…/src/sheets -> dist/sheets/**
 *   2. Every `"@hikoutei/{contracts,storage,sheets}/xxx.js"` specifier inside
 *      root dist is rewritten to the correct RELATIVE specifier, computed
 *      per-file with `path.posix.relative` from the file's own
 *      dist-directory depth. Rewrites apply to both `.js` (runtime) and
 *      `.d.ts` (published types).
 *   3. P8-D2 PHASE 2 TRANSITIONAL: the moved storage/sheets sources import
 *      root src through the `@hikoutei-app-src` pseudo-package specifier.
 *      Inside the bundled copies those become relative specifiers onto the
 *      root dist mirror of their `<sub>` target (dist mirrors src 1:1).
 *      Phase 2 severs those imports and this mapping can be deleted.
 *   4. P8-D2 PHASE 1 LEAF SELF-CONSISTENCY (Terra fix): the LEAF packages'
 *      own dists must RUNTIME-load standalone too (workspace consumers
 *      import `@hikoutei/{storage,sheets}/<sub>` directly, outside the root
 *      bundle). Every `@hikoutei-app-src/<sub>` specifier inside leaf-dist
 *      `.js` files is rewritten — same depth-exact mechanism as (2) — onto
 *      the leaf's own transient `dist/src/<sub>` mirror (the reached-in
 *      root-src emission the leaf's transitional
 *      `rootDir: "../.."` tsconfig already produces).
 *      Deliberately NOT rewritten: leaf-dist `.d.ts` files. Their alias
 *      imports are the single-type-identity mechanism every tsconfig in the
 *      repo maps back onto the root src tree (a healed relative pointer
 *      would make the mirror d.ts copies distinct declarations and clash
 *      with the compiling sources — ts2345 in the public-surface audit).
 *      Phase 2 severs the alias in sources and deletes this pass with it.
 *
 * Guards (script fails the build when violated):
 *   - After rewriting, NO `.js`/`.d.ts` file anywhere inside root `dist/`
 *     may still contain an `@hikoutei/{contracts,storage,sheets}` or
 *     `@hikoutei-app-src` literal.
 *   - Mirror check: every module-internal (relative) import/export specifier
 *     in any root-dist file must resolve to an existing file inside root
 *     `dist/` — this subsumes the old leaf-internal mirror check and rejects
 *     any surviving pointer into root src (nothing outside dist ships).
 *
 * Externals: bare specifiers of packages the ROOT declares
 * (`@hikoutei/ikisaki`, `@hikoutei/kohkai`, `zod`, `@mikro-orm/*`,
 * `@googleapis/*`, `google-auth-library`) keep resolving from the root
 * `node_modules` at consumer-install time.
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

// Leaf bundle table: [specifierPrefix, source dist subtree (repo-relative,
// null = no copy), destination dir (dist-relative; "" = bundle onto the dist
// root, preserving the src-relative layout the `@hikoutei/<pkg>/<sub>`
// specifiers name), the subtrees of that src emission to copy].
const BUNDLES = [
  {
    prefix: "@hikoutei/contracts",
    distSrc: "packages/hikoutei-contracts/dist",
    destDir: "contracts",
    copySubtrees: [""],
  },
  {
    prefix: "@hikoutei/storage",
    // The storage package tsconfig emits relative to the repo root (see the
    // package's tsconfig.json — transitional rootDir "../.."); the useful
    // subtrees are the package's own src emissions.
    distSrc: "packages/hikoutei-storage/dist/packages/hikoutei-storage/src",
    destDir: "",
    copySubtrees: ["storage", "persistence"],
  },
  {
    prefix: "@hikoutei/sheets",
    distSrc: "packages/hikoutei-sheets/dist/packages/hikoutei-sheets/src",
    destDir: "",
    copySubtrees: ["sheets"],
  },
  {
    // P8-D2 phase 2 transitional bridge specifier (no dist of its own; its
    // specifiers are remapped onto the root dist mirror of the target).
    prefix: "@hikoutei-app-src",
    destDir: "",
    copySubtrees: [],
  },
];

const LEAF_SPECIFIER_RE =
  /(['"])(@hikoutei\/(?:contracts|storage|sheets)|@hikoutei-app-src)(?:\/([^'"]+))?\1/;

// Leaf packages whose own dist must be self-consistent (loadable standalone
// via the workspace `@hikoutei/<name>` specifier). Their transitional
// `@hikoutei-app-src/*` imports are rewritten onto the leaf's own
// `dist/src/**` mirror — the reached-in root-src modules their transitional
// rootDir-spanning tsconfig already emits.
const LEAF_PACKAGES = [
  { name: "@hikoutei/storage", distDir: "packages/hikoutei-storage/dist" },
  { name: "@hikoutei/sheets", distDir: "packages/hikoutei-sheets/dist" },
];

const APP_SRC_RE = /(['\"])(@hikoutei-app-src)(?:\/([^'\"]+))?\1/g;
const APP_SRC_LITERAL_RE = /@hikoutei-app-src/;

/** Recursively collect file paths (absolute) under `dir`. */
async function walkFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(full)));
    else if (entry.isFile()) out.push(full);
    else if (entry.isSymbolicLink()) { /* dist is never pnpm-linked */ }
  }
  return out;
}

/** Rewrite every quoted leaf specifier to the relative specifier from the
 * file's own directory into the bundle's destination. Depth is computed
 * per-file with `path.posix.relative` on the file's dist-relative POSIX
 * directory — never by blind string prefixing. */
function rewriteSpecifiers(source, fileRelToDist) {
  const fileDirPosix = path.posix.dirname(fileRelToDist.split(path.sep).join(path.posix.sep));
  return source.replace(
    new RegExp(LEAF_SPECIFIER_RE.source, "g"),
    (_match, quote, leafRaw, subpath) => {
      const bundle = BUNDLES.find((b) => b.prefix === leafRaw);
      const target = subpath
        ? `${bundle.destDir ? bundle.destDir + "/" : ""}${subpath}`
        : `${bundle.destDir ? bundle.destDir + "/" : ""}index.js`;
      let rel = path.posix.relative(fileDirPosix, target);
      if (!rel.startsWith(".")) rel = `./${rel}`;
      return `${quote}${rel}${quote}`;
    },
  );
}

/** Mirror check helper: does a dist-relative specifier resolve to an
 * existing file? */
function makeResolver(distRelPaths) {
  const distSet = new Set(distRelPaths);
  return (posixRelPath) => {
    const candidates = posixRelPath.endsWith(".js")
      ? [posixRelPath, `${posixRelPath.slice(0, -3)}.d.ts`]
      : posixRelPath.endsWith(".d.ts")
        ? [posixRelPath]
        : [posixRelPath, `${posixRelPath}.js`, `${posixRelPath}/index.js`, `${posixRelPath}/index.d.ts`];
    return candidates.some((c) => distSet.has(c));
  };
}

/** Extract relative (module-internal) specifiers a file references. */
function extractRelativeSpecifiers(source) {
  const specs = new Set();
  for (const match of source.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\bexport\s+\*\s+from\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g,
  )) {
    specs.add(match[1]);
  }
  return [...specs];
}

/** P8-D2 PHASE 1 LEAF SELF-CONSISTENCY PASS (Terra fix): rewrite every
 * `@hikoutei-app-src/<sub>` specifier inside the LEAF's own dist `.js` files
 * (runtime loads fail ERR_MODULE_NOT_FOUND on the unresolvable alias) to the
 * relative specifier into the leaf's `dist/src/<sub>` mirror, computed
 * per-file with `path.posix.relative` (never blind prefixing).
 * `.d.ts` files deliberately KEEP the alias: every tsconfig paths-maps
 * `@hikoutei-app-src/*` back onto the root src tree, preserving single type
 * identity — healing the d.ts mirror copies would create distinct
 * declarations that clash with the compiling sources (ts2345).
 * Guards: no alias literal may survive in the runtime emission, every alias
 * target must exist in the leaf's emission, and every relative specifier
 * inside the healed leaf dist must resolve inside it (the standalone-
 * loadability proof).
 *
 * NOTE: runs on the leaf dist IN PLACE, AFTER the root bundling pass —
 * healing beforehand would corrupt the copied subtrees' depths in root
 * dist, which recomputes them from the root-dist-relative position. */
async function healLeafDist(leaf) {
  const leafDist = path.join(repoRoot, leaf.distDir);
  const ok = await stat(leafDist).then((s) => s.isDirectory()).catch(() => false);
  if (!ok) {
    console.error(`[reconcile] FAIL: missing leaf dist tree: ${leaf.distDir}`);
    process.exit(1);
  }
  const rels = (await walkFiles(leafDist)).map(
    (abs) => path.relative(leafDist, abs).split(path.sep).join(path.posix.sep),
  );
  const leafSet = new Set(rels);
  // Runtime files only: the `.d.ts` emission keeps the transitional
  // `@hikoutei-app-src/*` alias by design (single type identity, see header).
  const emitFiles = rels.filter((rel) => rel.endsWith(".js"));

  // 1. Rewrite each `@hikoutei-app-src/<sub>` onto the leaf's dist/src mirror.
  let rewrittenFiles = 0, rewrittenSpecifiers = 0;
  for (const rel of emitFiles) {
    const abs = path.join(leafDist, rel);
    let source = await readFile(abs, "utf8");
    if (!APP_SRC_LITERAL_RE.test(source)) continue;
    APP_SRC_LITERAL_RE.lastIndex = 0;
    const fileDirPosix = path.posix.dirname(rel);
    source = source.replace(APP_SRC_RE, (_match, quote, _alias, subpath) => {
      // Transitional emit layout: reached-in root-src modules land at
      // `<leafDist>/src/<sub>` (the mirror of the root src tree).
      const target = subpath ? `src/${subpath}` : "src/index.js";
      if (!leafSet.has(target)) {
        console.error(
          `[reconcile] FAIL: ${leaf.name} ${rel} imports @hikoutei-app-src/` +
            `${subpath ?? "index.js"} but ${leaf.distDir}/${target} was not emitted — the leaf runtime dist cannot be made self-consistent.`,
        );
        process.exit(1);
      }
      let newSpec = path.posix.relative(fileDirPosix, target);
      if (!newSpec.startsWith(".")) newSpec = `./${newSpec}`;
      rewrittenSpecifiers += 1;
      return `${quote}${newSpec}${quote}`;
    });
    rewrittenFiles += 1;
    await writeFile(abs, source, "utf8");
  }

  // 2. Guard: no `@hikoutei-app-src` literal may remain in the leaf's
  //    RUNTIME dist (.js; the `.d.ts` emission intentionally keeps the
  //    alias until P8-D2 phase 2 — see the pass doc above).
  const unresolved = [];
  for (const rel of emitFiles) {
    const source = await readFile(path.join(leafDist, rel), "utf8");
    if (APP_SRC_LITERAL_RE.test(source)) unresolved.push(rel);
  }
  if (unresolved.length > 0) {
    console.error(
      `[reconcile] FAIL: unresolved @hikoutei-app-src literals remain in ${leaf.distDir} runtime files (${unresolved.length} file(s)):`,
    );
    for (const f of unresolved) console.error(`  - ${f}`);
    process.exit(1);
  }

  // 3. Mirror check: every relative specifier inside the healed leaf dist
  //    must resolve to an existing file inside the leaf dist (checked across
  //    .js AND .d.ts so type resolution stays structurally valid too).
  const resolveInLeaf = makeResolver(rels);
  const broken = [];
  for (const rel of rels.filter((r) => r.endsWith(".js") || r.endsWith(".d.ts"))) {
    const dirPosix = path.posix.dirname(rel);
    const source = await readFile(path.join(leafDist, rel), "utf8");
    for (const spec of extractRelativeSpecifiers(source)) {
      const target = path.posix.normalize(path.posix.join(dirPosix, spec));
      if (!resolveInLeaf(target)) broken.push(`${rel} -> ${spec}`);
    }
  }
  if (broken.length > 0) {
    console.error(
      `[reconcile] FAIL: ${broken.length} relative import(s) in ${leaf.distDir} do not resolve inside the leaf dist:`,
    );
    for (const b of broken.slice(0, 50)) console.error(`  - ${b}`);
    if (broken.length > 50) console.error(`  … and ${broken.length - 50} more`);
    process.exit(1);
  }
  return { rewrittenFiles, rewrittenSpecifiers };
}

async function main() {
  // 0. Sanity: the root dist tree and every copying bundle subtree must exist.
  for (const dir of [rootDist, ...BUNDLES.filter((b) => b.distSrc).map((b) => path.join(repoRoot, b.distSrc))]) {
    const ok = await stat(dir).then((s) => s.isDirectory()).catch(() => false);
    if (!ok) {
      console.error(`[reconcile] FAIL: missing dist tree: ${path.relative(repoRoot, dir)}`);
      process.exit(1);
    }
  }

  // 1. Reset + copy each bundle's dist subtrees into root dist.
  for (const bundle of BUNDLES) {
    if (!bundle.distSrc) continue;
    for (const sub of bundle.copySubtrees) {
      const targetDir = path.join(rootDist, bundle.destDir, sub);
      await rm(targetDir, { recursive: true, force: true });
      await cp(path.join(repoRoot, bundle.distSrc, sub), targetDir, { recursive: true });
    }
  }

  const allDistFiles = (await walkFiles(rootDist)).map(
    (abs) => path.relative(rootDist, abs).split(path.sep).join(path.posix.sep),
  );
  const resolveInDist = makeResolver(allDistFiles);

  // 2. Rewrite leaf specifiers in EVERY root dist .js/.d.ts (including the
  //    freshly copied leaf files, which may point at `@hikoutei/contracts/…`).
  const emitFiles = allDistFiles.filter(
    (rel) => rel.endsWith(".js") || rel.endsWith(".d.ts"),
  );
  let rewrittenFiles = 0, rewrittenSpecifiers = 0, remappedSpecifiers = 0;
  for (const rel of emitFiles) {
    const abs = path.join(rootDist, rel);
    let source = await readFile(abs, "utf8");
    const occurrences = source.match(
      /['"](?:@hikoutei\/(?:contracts|storage|sheets)|@hikoutei-app-src)(?:\/[^'"]+)?['"]/g,
    );
    if (occurrences) {
      source = rewriteSpecifiers(source, rel);
      rewrittenFiles += 1;
      rewrittenSpecifiers += occurrences.length;
    }
    // Belt-and-braces: a relative specifier resolving OUTSIDE root dist would
    // point back into repo src (e.g. a surviving transitional relative
    // pointer); remap it onto the dist mirror of its `src/<rest>` target.
    const fileDirPosix = path.posix.dirname(rel);
    source = source.replace(/(['"])\.([^'"]*)\1/g, (whole, quote, rest) => {
      const spec = `.${rest}`;
      const resolvedAbs = path.resolve(rootDist, fileDirPosix, spec);
      const resolvedRelToRoot = path.relative(repoRoot, resolvedAbs).split(path.sep).join(path.posix.sep);
      if (resolvedRelToRoot.startsWith("..") || !resolvedRelToRoot.startsWith("src/")) {
        return whole; // stays inside dist (or repo): untouched
      }
      const target = resolvedRelToRoot.slice("src/".length);
      let newSpec = path.posix.relative(fileDirPosix, target);
      if (!newSpec.startsWith(".")) newSpec = `./${newSpec}`;
      remappedSpecifiers += 1;
      return `${quote}${newSpec}${quote}`;
    });
    await writeFile(abs, source, "utf8");
  }

  // 3. Guard A: no UNRESOLVED LEAF SPECIFIER may remain anywhere in root
  //    dist (.js + .d.ts, including the bundled copies). Only the
  //    quoted-specifier form is flagged — bare @hikoutei/... mentions in
  //    comments (e.g. logEvents.ts provenance notes) are not imports.
  const offenders = [];
  for (const rel of allDistFiles) {
    if (!(rel.endsWith(".js") || rel.endsWith(".d.ts"))) continue;
    const source = await readFile(path.join(rootDist, rel), "utf8");
    if (/(['\"])(?:@hikoutei\/(?:contracts|storage|sheets)|@hikoutei-app-src)(?:\/[^'\"]+)?\1/.test(source)) {
      offenders.push(rel);
    }
  }
  if (offenders.length > 0) {
    console.error(
      `[reconcile] FAIL: unresolved @hikoutei/{contracts,storage,sheets}/app-src literals remain in root dist (${offenders.length} file(s)):`,
    );
    for (const f of offenders) console.error(`  - ${f}`);
    process.exit(1);
  }

  // 4. Guard B: every relative specifier in a .js/.d.ts inside root dist must
  //    resolve to an existing file INSIDE root dist. This subsumes the old
  //    leaf-internal mirror check and rejects any surviving transitional
  //    pointer into root src.
  const broken = [];
  for (const rel of allDistFiles) {
    if (!(rel.endsWith(".js") || rel.endsWith(".d.ts"))) continue;
    const dirPosix = path.posix.dirname(rel);
    const source = await readFile(path.join(rootDist, rel), "utf8");
    for (const spec of extractRelativeSpecifiers(source)) {
      const target = path.posix.normalize(path.posix.join(dirPosix, spec));
      if (!resolveInDist(target)) broken.push(`${rel} -> ${spec}`);
    }
  }
  if (broken.length > 0) {
    console.error(
      `[reconcile] FAIL: ${broken.length} relative import(s) in root dist do not resolve inside dist:`,
    );
    for (const b of broken.slice(0, 50)) console.error(`  - ${b}`);
    if (broken.length > 50) console.error(`  … and ${broken.length - 50} more`);
    process.exit(1);
  }

  // 5. Leaf self-consistency (P8-D2 phase 1): heal the leaves' own dists in
  //    place, AFTER the root bundling pass (the copied subtrees were already
  //    depth-rewritten in step 2; healing them early would corrupt depths).
  const leafStats = [];
  for (const leaf of LEAF_PACKAGES) {
    const s = await healLeafDist(leaf);
    leafStats.push(
      `${leaf.name}: ${s.rewrittenSpecifiers} alias specifier(s) across ${s.rewrittenFiles} file(s)`,
    );
  }

  console.log(
    `[reconcile] OK: self-consistent leaf dists {${leafStats.join("; ")}}; bundled leaf dists into dist {${BUNDLES.filter((b) => b.distSrc)
      .map((b) => `${b.prefix}=>${b.copySubtrees.map((s) => `dist/${s || b.destDir}`).join(",")}`)
      .join("; ")}}; ` +
      `rewrote ${rewrittenSpecifiers} package specifier(s) across ${rewrittenFiles} file(s); ` +
      `remapped ${remappedSpecifiers} transitional /src/ pointer(s); ` +
      `0 remaining leaf literals; all relative imports resolve inside dist.`,
  );
}

main();