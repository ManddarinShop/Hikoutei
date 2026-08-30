#!/usr/bin/env node
/**
 * Reconcile the root `hikoutei` dist with the bundled private leaf packages
 * (P8-B publishing fix, generalized for P8-D2 phases 1 + 2).
 *
 * Publishing model (owner-approved): exactly ONE npm package is published,
 * `hikoutei`. `@hikoutei/contracts`, `@hikoutei/storage`, `@hikoutei/sheets`,
 * `@hikoutei/sync-engine`, `@hikoutei/composition`, and `@hikoutei/cli` stay
 * `private: true` (never published) and are NOT runtime dependencies of
 * `hikoutei`. Their compiled output is therefore BUNDLED into the root
 * artifact:
 *
 *   1. Each leaf's dist subtree is copied into `dist/<destDir>` so the leaves
 *      ship inside the root package (`files: ["dist"]`):
 *        - packages/hikoutei-contracts/dist          -> dist/contracts/**
 *        - packages/hikoutei-storage/dist/…/src/{storage,persistence,orm,sync}
 *              -> dist/{storage,persistence,orm,sync}/**  (the subpaths the
 *                 `@hikoutei/storage/<sub>` specifiers name; the package's
 *                 transient dist mirror of reached-in sibling-package sources
 *                 is NOT copied)
 *        - packages/hikoutei-sheets/dist/…/src/sheets -> dist/sheets/**
 *        - packages/hikoutei-sync-engine/dist/…/src   -> dist/sync-engine/**
 *        - packages/hikoutei-composition/dist/…/src  -> dist/composition/**
 *        - packages/hikoutei-cli/dist/…/src            -> dist/cli/**
 *          (the published `bin` entry: dist/cli/index.js must exist here)
 *   2. Every `@hikoutei/{contracts,storage,sheets,sync-engine,composition,cli}/…`
 *      specifier inside root dist is rewritten to the correct RELATIVE
 *      specifier, computed per-file with `path.posix.relative` from the
 *      file's own dist-directory depth. Rewrites apply to both `.js` (runtime)
 *      and `.d.ts` (published types).
 *   3. P8-D2 PHASE 2: the transitional `@hikoutei-app-src` bridge is GONE.
 *      No source tree may emit that specifier; if any dist file still
 *      contains the literal, the guards below fail the build (tripwire).
 *   4. LEAF SELF-CONSISTENCY: the leaf packages' own dists must RUNTIME-load
 *      standalone too (workspace consumers import `@hikoutei/<pkg>/<sub>`
 *      directly, outside the root bundle). Cross-package specifiers stay BARE
 *      in leaf dists and resolve through the workspace links in node_modules;
 *      every RELATIVE specifier inside a leaf dist (including the transient
 *      reached-in-source mirrors the cross-mapped tsconfigs emit) must
 *      resolve inside that same leaf dist.
 *
 * Guards (script fails the build when violated):
 *   - After rewriting, NO `.js`/`.d.ts` file anywhere inside root `dist/`
 *     may still contain a bundled-leaf or `@hikoutei-app-src` literal.
 *   - Mirror check: every module-internal (relative) import/export specifier
 *     in any root-dist file must resolve to an existing file inside root
 *     `dist/` — this subsumes the leaf-internal mirror checks and rejects
 *     any surviving pointer into a source tree (nothing outside dist ships).
 *
 * Externals: bare specifiers of packages the ROOT declares
 * (`@hikoutei/ikisaki`, `@hikoutei/kohkai`, `zod`, `@mikro-orm/*`,
 * `@googleapis/*`, `google-auth-library`) keep resolving from the root
 * `node_modules` at consumer-install time. The bundled cli's `hikoutei`
 * self-reference resolves through the published package's own `exports`.
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

// Leaf bundle table: [specifierPrefix, source dist subtree (repo-relative),
// destination dir (dist-relative; "" = bundle onto the dist root, preserving
// the src-relative layout the `@hikoutei/<pkg>/<sub>` specifiers name), the
// subtrees of that src emission to copy].
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
    // package's tsconfig.json — cross-map rootDir "../.."); the useful
    // subtrees are the package's own src emissions. P8-D2 phase 2 cycle
    // break adds the storage-hosted persistence glue (orm/**, sync/**).
    distSrc: "packages/hikoutei-storage/dist/packages/hikoutei-storage/src",
    destDir: "",
    copySubtrees: ["storage", "persistence", "orm", "sync"],
  },
  {
    prefix: "@hikoutei/sheets",
    distSrc: "packages/hikoutei-sheets/dist/packages/hikoutei-sheets/src",
    destDir: "",
    copySubtrees: ["sheets"],
  },
  {
    // P8-D2 phase 2: the engine, composition, and cli dists bundle under
    // their own destDir so the published bin (dist/cli/index.js) and the
    // `@hikoutei/sync-engine/<sub>` specifier subpaths each land exactly
    // where the rewritten specifiers point.
    prefix: "@hikoutei/sync-engine",
    distSrc: "packages/hikoutei-sync-engine/dist/packages/hikoutei-sync-engine/src",
    destDir: "sync-engine",
    copySubtrees: [""],
  },
  {
    prefix: "@hikoutei/composition",
    // Composition cross-maps the leaf sources (transient mirrors are NOT
    // bundled), so its own emission lives under the repo-root-relative
    // packages/…/src subtree like the other cross-mapped leaves.
    distSrc: "packages/hikoutei-composition/dist/packages/hikoutei-composition/src",
    destDir: "composition",
    copySubtrees: [""],
  },
  {
    prefix: "@hikoutei/cli",
    // The cli tsconfig spans the repo root for its `hikoutei` source map;
    // only the package's own emission subtree is bundled (onto dist/cli/** —
    // the published bin path).
    distSrc: "packages/hikoutei-cli/dist/packages/hikoutei-cli/src",
    destDir: "cli",
    copySubtrees: [""],
  },
];

// All bundled private-package specifiers rewritten to relative paths inside
// the root dist (and checked by the dist guards below).
const LEAF_PREFIXES = "contracts|storage|sheets|sync-engine|composition|cli";
const LEAF_SPECIFIER_RE = new RegExp(
  `(['"])(@hikoutei\\/(?:${LEAF_PREFIXES}))(?:\\/([^'"]+))?\\1`,
);

// Tripwire only: the removed phase-1/phase-2 transitional bridge specifier
// must not appear in any dist file (no rewrite path uses it).
const BRIDGE_LITERAL_RE = /@hikoutei-app-src/;

// Leaf packages whose own dist must stay standalone-loadable (relative
// specifiers resolve inside it; the removed bridge literal never appears).
const LEAF_PACKAGES = [
  { name: "@hikoutei/storage", distDir: "packages/hikoutei-storage/dist" },
  { name: "@hikoutei/sheets", distDir: "packages/hikoutei-sheets/dist" },
  { name: "@hikoutei/sync-engine", distDir: "packages/hikoutei-sync-engine/dist" },
  { name: "@hikoutei/composition", distDir: "packages/hikoutei-composition/dist" },
];

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

/** LEAF SELF-CONSISTENCY PASS: verify each bundled leaf's own dist loads
 * standalone. The removed `@hikoutei-app-src` bridge literal must appear
 * nowhere, and every relative specifier (including inside the transient
 * reached-in-source mirrors the cross-mapped tsconfigs emit) must resolve
 * inside the leaf dist. Cross-package specifiers stay bare and resolve
 * through the workspace links in node_modules at runtime. */
async function checkLeafDist(leaf) {
  const leafDist = path.join(repoRoot, leaf.distDir);
  const ok = await stat(leafDist).then((s) => s.isDirectory()).catch(() => false);
  if (!ok) {
    console.error(`[reconcile] FAIL: missing leaf dist tree: ${leaf.distDir}`);
    process.exit(1);
  }
  const rels = (await walkFiles(leafDist)).map(
    (abs) => path.relative(leafDist, abs).split(path.sep).join(path.posix.sep),
  );

  // 1. Tripwire: the removed bridge must be gone from the leaf entirely.
  const bridgeOffenders = [];
  for (const rel of rels) {
    if (!(rel.endsWith(".js") || rel.endsWith(".d.ts"))) continue;
    const source = await readFile(path.join(leafDist, rel), "utf8");
    if (BRIDGE_LITERAL_RE.test(source)) bridgeOffenders.push(rel);
  }
  if (bridgeOffenders.length > 0) {
    console.error(
      `[reconcile] FAIL: @hikoutei-app-src literals remain in ${leaf.distDir} (${bridgeOffenders.length} file(s)):`,
    );
    for (const f of bridgeOffenders) console.error(`  - ${f}`);
    process.exit(1);
  }

  // 2. Mirror check: every relative specifier inside the leaf dist must
  //    resolve to an existing file inside it (checked across .js AND .d.ts
  //    so type resolution stays structurally valid too).
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
      new RegExp(`['"]@hikoutei\\/(?:${LEAF_PREFIXES})(?:\\/[^'"]+)?['"]`, "g"),
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

  // 3. Guard A: no UNRESOLVED LEAF SPECIFIER and no removed-bridge literal
  //    may remain anywhere in root dist (.js + .d.ts, including the bundled
  //    copies). Only the quoted-specifier form is flagged for leaf prefixes —
  //    bare @hikoutei/... mentions in comments (e.g. logEvents.ts provenance
  //    notes) are not imports. The bridge literal has NO legitimate dist
  //    appearance at all, so it is a plain literal tripwire.
  const offenders = [];
  for (const rel of allDistFiles) {
    if (!(rel.endsWith(".js") || rel.endsWith(".d.ts"))) continue;
    const source = await readFile(path.join(rootDist, rel), "utf8");
    if (
      new RegExp(`(['"])@hikoutei\\/(?:${LEAF_PREFIXES})(?:\\/[^'"]+)?\\1`).test(source) ||
      BRIDGE_LITERAL_RE.test(source)
    ) {
      offenders.push(rel);
    }
  }
  if (offenders.length > 0) {
    console.error(
      `[reconcile] FAIL: unresolved @hikoutei/{${LEAF_PREFIXES}} or removed-bridge literals remain in root dist (${offenders.length} file(s)):`,
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

  // 5. Leaf self-consistency (standalone-loadability + bridge tripwire per
  //    bundled leaf; runs after root bundling so nothing mutates depths).
  for (const leaf of LEAF_PACKAGES) {
    await checkLeafDist(leaf);
  }

  console.log(
    `[reconcile] OK: leaf dists self-consistent (${LEAF_PACKAGES.map((l) => l.name).join(", ")}); ` +
      `bundled leaf dists into dist {${BUNDLES.filter((b) => b.distSrc)
        .map((b) => `${b.prefix}=>${b.copySubtrees.map((s) => `dist/${[b.destDir, s].filter(Boolean).join("/")}`).join(",")}`)
        .join("; ")}}; ` +
      `rewrote ${rewrittenSpecifiers} package specifier(s) across ${rewrittenFiles} file(s); ` +
      `remapped ${remappedSpecifiers} transitional /src/ pointer(s); ` +
      `0 remaining leaf literals; all relative imports resolve inside dist.`,
  );
}

main();
