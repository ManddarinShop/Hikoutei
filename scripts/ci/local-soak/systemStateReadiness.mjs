/**
 * Resolves the internal System_State readiness reader (source or dist).
 * Depends only on distFallback.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  isExpectedPlainNodeTsLoaderFailure,
  shouldFallBackToDistOnSourceFailure,
} from "./distFallback.mjs";

/**
 * Immediate-ready readiness reader used only when the internal System_State
 * readiness module is absent from this branch (feature/runtime work not yet
 * merged, e.g. `develop`). It reports `ready` at once so soak/tooling runs
 * keep working without the feature file; it never touches the runtime.
 *
 * @param {object} _runtime the current Hikoutei runtime (unused on this path).
 * @returns {{ status: "ready" }}
 */
function immediateReadyReadSystemStateReadiness(_runtime) {
  return { status: "ready" };
}

/** Absolute file URL of the source module (Vitest/Vite resolves this `.ts`). */
const SYSTEM_STATE_READINESS_SOURCE_URL = new URL(
  "../../../src/application/sync/service/systemStateReadiness.ts",
  import.meta.url,
);
/** Absolute file URL of the built dist module (plain-Node CLI resolves this). */
const SYSTEM_STATE_READINESS_DIST_URL = new URL(
  "../../../dist/application/sync/service/systemStateReadiness.js",
  import.meta.url,
);

/**
 * Default dependency implementations used at runner load time. Exposed as a
 * frozen object so a focused unit test can inject stubs that simulate a
 * module-absent branch (source AND dist missing) or a present-but-throwing
 * module without touching the real repository files.
 */
const systemStateReadinessLoad = Object.freeze({
  sourceURL: SYSTEM_STATE_READINESS_SOURCE_URL,
  distURL: SYSTEM_STATE_READINESS_DIST_URL,
  sourceExists: () => existsSync(fileURLToPath(SYSTEM_STATE_READINESS_SOURCE_URL)),
  distExists: () => existsSync(fileURLToPath(SYSTEM_STATE_READINESS_DIST_URL)),
  loadSource: () => import(SYSTEM_STATE_READINESS_SOURCE_URL.href),
  loadDist: () => import(SYSTEM_STATE_READINESS_DIST_URL.href),
  canFallBackToDist: shouldFallBackToDistOnSourceFailure,
});

/**
 * Resolves the internal System_State readiness reader (see the logger reset
 * above for the source-vs-dist resolution rules), treating the helper as an
 * OPTIONAL internal capability:
 *
 * - module present -> returns the real reader (the source `.ts` under Vitest,
 *   the built dist module in the plain-Node CLI);
 * - module ABSENT from this branch (feature/runtime work not merged, e.g.
 *   `develop`) -> returns the immediate-ready no-op, so soak/tooling runs
 *   never fail on the missing feature file. This holds REGARDLESS of whether
 *   a stale dist copy happens to exist: a dist file left over from a
 *   different branch/feature layer is never loaded when the source is absent;
 *   and
 * - module present but its source/runtime load throws -> rethrow. Only the
 *   expected plain-Node CLI source `.ts` load failure (plain-Node fallback
 *   allowed) falls back to dist; real source compile/runtime errors and any
 *   failure under Vitest are never masked by a stale dist copy.
 *
 * The controller module is deliberately NOT part of the package export
 * boundary, so the runner resolves the SAME module instance the library uses
 * per environment: both the source and dist targets are exact
 * repository-internal files, never a package subpath.
 *
 * @param {object} [deps] injectable dependencies for testing.
 * @returns {Promise<Function>} the resolved readiness reader function.
 */
export async function resolveSystemStateReadinessReader(deps = systemStateReadinessLoad) {
  const { loadSource, loadDist, sourceExists, distExists, canFallBackToDist, sourceURL } = deps;
  try {
    const srcModule = await loadSource();
    return srcModule.readRuntimeSystemStateReadiness;
  } catch (error) {
    // The source module is the authority. When it is ABSENT from this branch
    // (feature/runtime work not merged), degrade to the immediate-ready no-op
    // REGARDLESS of whether a stale dist copy exists — a dist file left over
    // from a different branch/feature layer must never be loaded here.
    if (!sourceExists()) {
      return immediateReadyReadSystemStateReadiness;
    }
    // The source module EXISTS, so its load failed. Only fall back to dist
    // when ALL THREE hold: plain-Node fallback is allowed (Vitest absent), a
    // dist copy exists, and the failure is the EXPECTED plain-Node
    // unsupported-TS-loader shape. Any real source compile/runtime/dependency
    // error — even with dist present — is rethrown below, never masked.
    if (
      canFallBackToDist() &&
      distExists() &&
      isExpectedPlainNodeTsLoaderFailure(error, sourceURL)
    ) {
      const distModule = await loadDist();
      return distModule.readRuntimeSystemStateReadiness;
    }
    // sourceExists() is true but the failure is either under Vitest (no dist
    // fallback), in a non-fallback env, or a REAL source compile/runtime/
    // dependency error that is not the expected plain-Node unsupported-loader
    // shape. Either way this is a REAL error and must be rethrown, never
    // hidden by a stale dist copy.
    throw error;
  }
}

/**
 * The readiness reader in effect for this process, resolved once at module
 * load. Absent on base branches that have not merged the feature/runtime
 * work, in which case it degrades to the immediate-ready no-op above.
 */
const readRuntimeSystemStateReadiness = await resolveSystemStateReadinessReader();

// Cross-module helpers split out of the monolithic runner.
// The resolved readiness reader consumed by probe.mjs.
export {
  readRuntimeSystemStateReadiness,
};
