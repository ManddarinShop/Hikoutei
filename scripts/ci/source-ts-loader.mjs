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

export async function resolve(specifier, context, nextResolve) {
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
