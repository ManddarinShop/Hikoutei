/**
 * Dist fallback and internal-logger-reset resolution for the soak runner.
 * Leaf module: depends only on Node builtins and source/dist file URLs.
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const resetHikouteiInternalLoggerForTests = await importInternalLoggerReset();

/**
 * True only when a plain `node` process may consider a source `.ts` load
 * failure eligible for dist fallback, i.e. the Vitest/Vite TS loader is
 * absent (under Vitest the source is ALWAYS expected to load, so any failure
 * there is a real source compile/runtime bug and must never be routed to a
 * stale dist copy).
 *
 * This is purely the ENVIRONMENT gate: it says nothing about whether a
 * specific error may fall back. The error-shape decision lives in
 * `isExpectedPlainNodeTsLoaderFailure`; a caller must require BOTH to fall
 * back, so a real source compile/runtime/dependency failure is never masked.
 *
 * @returns {boolean} true in a plain-Node CLI process (Vitest unset), false
 *   when Vitest is active.
 */
export function shouldFallBackToDistOnSourceFailure() {
  return process.env.VITEST !== "true";
}

/**
 * Normalises a file URL, URL object, or filesystem path string to a plain
 * path for comparison inside `isExpectedPlainNodeTsLoaderFailure`. Never
 * throws: an unparseable value is returned unchanged.
 *
 * @param {unknown} value a file URL, URL object, or path string.
 * @returns {string} the normalised path.
 */
function toPathname(value) {
  const str = String(value);
  if (str.startsWith("file://")) {
    try {
      return fileURLToPath(str);
    } catch {
      return str;
    }
  }
  return str;
}

/**
 * True only when a `.ts` source-module load failure is the EXPECTED
 * plain-Node unsupported-TS-loader shape that may legitimately fall back to
 * the built dist module. Every other source-load failure returns false, so
 * the caller rethrows instead of masking the bug with a stale dist copy.
 *
 * Two shapes are accepted:
 *
 * - `ERR_UNKNOWN_FILE_EXTENSION` naming this exact `.ts` source URL: plain
 *   `node` has no TypeScript loader for the file at all. When the error
 *   carries a `url` it must be exactly this source (a conflicting URL is
 *   rejected); when no `url` is present the error must be the canonical Node
 *   unknown-`.ts`-extension message naming this exact source path, so an
 *   arbitrary code-shaped runtime error that merely mentions the path can
 *   never pass; and
 * - this repository's plain-Node `ERR_MODULE_NOT_FOUND` shape: type
 *   stripping starts the source but cannot map its internal `./x.js`
 *   specifiers onto `.ts` files, so the missing module is an internal `.js`
 *   file UNDER the source tree and the error is explicitly raised while
 *   loading the `.ts` source (its importer is the source URL).
 *
 * Every other code/name/message — a real dependency failure (a bare/package
 * `ERR_MODULE_NOT_FOUND`), a source syntax error
 * (`ERR_INVALID_TYPESCRIPT_SYNTAX`/`SyntaxError`), a runtime throw, or an
 * unrelated loader error — returns false.
 *
 * @param {unknown} error the source-module load exception.
 * @param {URL | string} sourceURL the `.ts` source URL that was being loaded.
 * @returns {boolean} true only for the expected plain-Node unsupported-loader
 *   failure.
 */
export function isExpectedPlainNodeTsLoaderFailure(error, sourceURL) {
  if (typeof error !== "object" || error === null) return false;
  const code = typeof error.code === "string" ? error.code : "";
  const message = typeof error.message === "string" ? error.message : "";
  const sourcePath = toPathname(sourceURL);
  if (code === "ERR_UNKNOWN_FILE_EXTENSION") {
    // Only accept when the loader rejected this exact `.ts` source file. The
    // plain-Node unsupported-TS-loader error names the file it rejected via
    // its `url` property; when that URL is present it must be THIS source and
    // nothing else decides the outcome. A conflicting `url` (an error about
    // some other file that happens to carry the same code) is rejected
    // outright instead of being passed on the strength of message text.
    const hasUrl =
      error.url !== undefined ||
      Object.prototype.hasOwnProperty.call(error, "url");
    if (hasUrl) {
      // A present-but-malformed `url` (a non-string, or an empty string) is
      // explicit evidence the error is NOT the canonical loader shape, even
      // when the message looks canonical — treat it as a hard rejection
      // rather than falling back to the no-`url` message branch and masking
      // an arbitrary runtime error.
      if (typeof error.url !== "string" || error.url === "") return false;
      return toPathname(error.url) === sourcePath;
    }
    // With no `url` present or defined, require the canonical Node loader
    // message shape for an
    // unknown `.ts` extension naming this exact source: `Unknown file
    // extension ".ts" for <sourcePath>`. The exact first-line match is
    // deliberate — a bare `message.includes(sourcePath)` is too broad and
    // would let an arbitrary code-shaped runtime error that merely mentions
    // the source path pass as the expected loader failure.
    const firstLine = message.split("\n", 1)[0] ?? "";
    return firstLine === `Unknown file extension ".ts" for ${sourcePath}`;
  }
  if (code === "ERR_MODULE_NOT_FOUND" && error?.name === "Error") {
    // Expected repo shape: "Cannot find module '<abs>/<src>/x.js' imported
    // from <this .ts source>". Reject package/bare-specifier forms
    // ("Cannot find package ...") and any importer that is not the `.ts`
    // source. Only the first message line is inspected so a trailing hint
    // never changes the decision.
    const firstLine = message.split("\n", 1)[0] ?? "";
    const match = /^Cannot find module '([^']+)' imported from (.+)$/.exec(firstLine);
    if (!match) return false;
    const missing = match[1];
    const importer = match[2];
    if (!missing.endsWith(".js")) return false;
    // The error is only from loading THIS `.ts` source when the importer is
    // exactly the source URL being loaded.
    if (toPathname(importer) !== sourcePath) return false;
    // The missing specifier must be an internal `.js` file UNDER the source
    // tree — a sibling/descendant of the `.ts` source's own directory.
    const sourceDir = path.dirname(sourcePath);
    const missingPath = toPathname(missing);
    if (
      missingPath === sourceDir ||
      !missingPath.startsWith(`${sourceDir}${path.sep}`)
    ) {
      return false;
    }
    return true;
  }
  return false;
}

async function importInternalLoggerReset() {
  // The source module is addressed by its absolute file URL (the same file
  // Vite serves for the aliased library imports), resolved from this runner's
  // own URL. Declared here so the catch can evaluate the loader-failure
  // predicate against it.
  const sourceUrl = new URL(
    "../../../src/shared/observability/internalLog.ts",
    import.meta.url,
  );
  try {
    // Vitest loads the library from TypeScript source (the `hikoutei`
    // alias maps to src/index.ts), so the reset must target that exact
    // source module instance — a dist copy would keep a stale cached
    // logger bound to the previous run's file.
    const srcModule = await import(sourceUrl.href);
    return srcModule.resetHikouteiInternalLoggerForTests;
  } catch (error) {
    // The source module can only load under Vitest; in the plain-Node CLI
    // (the runner's real production path) it is never loadable, which is the
    // expected unsupported-TS-loader case and falls back to the built dist
    // module. Under Vitest any source failure is a real bug and is rethrown.
    // In plain Node only the EXPECTED unsupported-loader error shape (this
    // exact `.ts` source failing to load) may fall back — a real source
    // compile/runtime/dependency error is rethrown, never masked by a stale
    // dist.
    if (
      !shouldFallBackToDistOnSourceFailure() ||
      !isExpectedPlainNodeTsLoaderFailure(error, sourceUrl)
    ) {
      throw error;
    }
    const distModule = await import("../../../dist/shared/observability/internalLog.js");
    return distModule.resetHikouteiInternalLoggerForTests;
  }
}

// Cross-module helpers split out of the monolithic runner.
// Logger reset consumed by the runner's env pin/restore wrapper.
export {
  resetHikouteiInternalLoggerForTests,
};
