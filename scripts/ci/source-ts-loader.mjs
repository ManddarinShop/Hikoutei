/**
 * Minimal source loader for the repository-owned internal harness.
 *
 * The package does not ship private implementation modules. CI runs the
 * internal sync scenario against `src/**` instead, while this loader resolves
 * TypeScript's NodeNext `.js` specifiers to their source `.ts` files and uses
 * the repository's TypeScript dev dependency for type stripping.
 */

import { access, readFile } from "node:fs/promises";
import ts from "typescript";

// P8-D2 phase 1: the storage/sheets adapter trees live in workspace packages
// now; root-src modules import them by package specifier. During the
// transitional phase these resolve to the packages' TypeScript sources (same
// source-based model as the "./adapter/..." harness imports).
const PACKAGE_SRC = {
  // (Dir values are relative to this loader file in scripts/ci/; the loader
  // appends `/src/<sub>.ts` itself, so they name the PACKAGE dir — same
  // pattern as the `@hikoutei-app-src` repo-root entry below.)
  "@hikoutei/storage": "../../packages/hikoutei-storage",
  "@hikoutei/sheets": "../../packages/hikoutei-sheets",
  // P8-D2 phase 2 removes this transitional bridge.
  "@hikoutei-app-src": "../..",
};

export async function resolve(specifier, context, nextResolve) {
  for (const [name, dir] of Object.entries(PACKAGE_SRC)) {
    if (specifier === name || specifier.startsWith(name + "/")) {
      const sub = specifier.slice(name.length + 1);
      if (sub.endsWith(".js")) {
        const sourceUrl = new URL(`${dir}/src/${sub.slice(0, -3)}.ts`, import.meta.url);
        if (await exists(sourceUrl)) return { shortCircuit: true, url: sourceUrl.href };
      }
      break;
    }
  }
  if (specifier.endsWith(".js")) {
    const sourceSpecifier = `${specifier.slice(0, -3)}.ts`;
    const sourceUrl = specifier.startsWith("file:")
      ? new URL(sourceSpecifier)
      : new URL(sourceSpecifier, context.parentURL);
    if (sourceUrl.pathname.includes("/src/") && await exists(sourceUrl)) {
      return { shortCircuit: true, url: sourceUrl.href };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") && url.includes("/src/")) {
    const source = await readFile(new URL(url), "utf8");
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
        sourceMap: false,
      },
      fileName: url,
    });
    return {
      format: "module",
      shortCircuit: true,
      source: transpiled.outputText,
    };
  }
  return nextLoad(url, context);
}

async function exists(url) {
  try {
    await access(url);
    return true;
  } catch {
    return false;
  }
}
