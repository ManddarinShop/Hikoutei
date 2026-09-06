/**
 * Step-1 protocol import-boundary gate for the `@hikoutei/ikisaki` kernel.
 *
 * The kernel is provider-neutral: no file under `packages/ikisaki/src/` may
 * import entity/Sheets state, storage, sync-engine/provider code, or the
 * Google SDKs. Shared primitives (`contracts/state`, `contracts/encoding`,
 * `contracts/identity`) stay usable as `import type` only; `zod` stays a
 * runtime dependency for the pure validation parsers. The test reads the
 * kernel sources and fails on violation.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const kernelSrc = resolve(here, "..", "packages", "ikisaki", "src");

/** Runtime imports from these specifiers are always a boundary violation. */
const DENIED_RUNTIME_PREFIXES = [
  "@hikoutei/storage",
  "@hikoutei/sheets",
  "@hikoutei/sync-engine",
  "@hikoutei/composition",
  "@hikoutei/cli",
  "googleapis",
  "@googleapis/",
  "google-auth-library",
];

/** `contracts` leaves that are never shared (entity/Sheets/provider state). */
const DENIED_CONTRACTS_PREFIXES = [
  "@hikoutei/contracts/sheets",
  "@hikoutei/contracts/domain",
  "@hikoutei/contracts/api",
  "@hikoutei/contracts/storage",
];

/**
 * Shared primitives the audit classifies as kernel-safe
 * (`encoding/*, state/*, identity/*`): `import type` only, never runtime.
 */
const SHARED_TYPE_ONLY_PREFIXES = [
  "@hikoutei/contracts/encoding",
  "@hikoutei/contracts/state",
  "@hikoutei/contracts/identity",
];

/** Runtime externals the kernel legitimately depends on. */
const ALLOWED_RUNTIME = new Set(["zod"]);

interface KernelImport {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/** Collects every `.ts` file under a directory, recursively. */
function collectSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSources(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

/** Strips line/block comments so commented imports never count. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

/** Extracts (specifier, type-only) pairs from static and dynamic imports. */
function extractImports(source: string): KernelImport[] {
  const text = stripComments(source);
  const found: KernelImport[] = [];
  const staticPattern =
    /(?:import|export)\s+(type\s+)?(?:[^"';)]*?\sfrom\s*)?["']([^"']+)["']/g;
  for (let match = staticPattern.exec(text); match !== null; match = staticPattern.exec(text)) {
    const specifier = match[2] as string;
    // A bare `import "./x.js"` side-effect import has no `from`; only the
    // `import type ... from` / `export type ... from` forms are type-only.
    found.push({ specifier, typeOnly: match[1] !== undefined });
  }
  const dynamicPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let match = dynamicPattern.exec(text); match !== null; match = dynamicPattern.exec(text)) {
    found.push({ specifier: match[1] as string, typeOnly: false });
  }
  return found;
}

/** Returns true for kernel-internal or platform specifiers (always legal). */
function isInternalSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("node:") ||
    specifier === "@hikoutei/ikisaki" ||
    specifier.startsWith("@hikoutei/ikisaki/")
  );
}

/** Returns a violation description, or undefined when the import is legal. */
function checkImport(imp: KernelImport): string | undefined {
  const { specifier, typeOnly } = imp;
  if (isInternalSpecifier(specifier) || ALLOWED_RUNTIME.has(specifier)) {
    return undefined;
  }
  if (typeOnly && SHARED_TYPE_ONLY_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    return undefined;
  }
  if (DENIED_CONTRACTS_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    return `forbidden contracts import ${JSON.stringify(specifier)}`;
  }
  if (
    specifier === "@hikoutei/contracts" ||
    specifier.startsWith("@hikoutei/contracts/") ||
    DENIED_RUNTIME_PREFIXES.some((prefix) => specifier.startsWith(prefix))
  ) {
    return typeOnly
      ? `type-only import of non-shared leaf ${JSON.stringify(specifier)}`
      : `forbidden runtime import ${JSON.stringify(specifier)}`;
  }
  return undefined;
}

describe("ikisaki protocol import boundary", () => {
  it("keeps provider/Sheets/entity imports out of packages/ikisaki/src", () => {
    const violations: string[] = [];
    for (const file of collectSources(kernelSrc)) {
      const source = readFileSync(file, "utf8");
      for (const imp of extractImports(source)) {
        const reason = checkImport(imp);
        if (reason !== undefined) {
          violations.push(`${relative(kernelSrc, file)}: ${reason}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
