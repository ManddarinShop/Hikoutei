/**
 * Focused unit tests for the runner's optional System_State readiness reader
 * resolution (`resolveSystemStateReadinessReader`).
 *
 * The readiness helper is an OPTIONAL internal capability: feature/runtime
 * branches ship `packages/sync-engine/src/sync/service/systemStateReadiness.ts`, but
 * base branches (such as `develop`) that have not merged the feature work do
 * not. The runner must keep working there, degrading to an immediate-ready
 * no-op instead of failing to load, while still rethrowing real source or
 * runtime failures whenever the module IS present — never masking a real bug
 * with a stale dist copy or a broad catch-and-fallback. When the source module
 * is absent it returns the immediate-ready no-op even if a stale dist copy
 * happens to exist; dist fallback is reserved for the source-present
 * plain-Node unsupported-TS-loader case.
 *
 * These tests drive the resolver through injected dependency stubs so no real
 * repository file is read and the module-absent branch is exercised directly.
 */

import { describe, expect, it, vi } from "vitest";
import { resolveSystemStateReadinessReader } from "../scripts/ci/local-soak/runner.mjs";

describe("resolveSystemStateReadinessReader (optional capability)", () => {
  it("returns an immediate-ready no-op when the module is absent (source and dist missing)", async () => {
    // Simulates a base branch without the feature file: the module is absent
    // from BOTH source and dist, so there is nothing real to load.
    const reader = await resolveSystemStateReadinessReader({
      sourceExists: () => false,
      distExists: () => false,
      loadSource: () => Promise.reject(new Error("source module not found")),
      loadDist: () => Promise.reject(new Error("dist module not found")),
      canFallBackToDist: () => false,
    });
    // The no-op never touches the runtime and reports ready immediately.
    const touched = vi.fn();
    expect(reader(touched)).toEqual({ status: "ready" });
    expect(touched).not.toHaveBeenCalled();
  });

  it("still uses the real reader when the module is present", async () => {
    const realReader = (runtime: { readonly draining: boolean }) => (
      runtime.draining ? { status: "draining" } : { status: "ready" }
    );
    const reader = await resolveSystemStateReadinessReader({
      sourceExists: () => true,
      distExists: () => false,
      loadSource: () => Promise.resolve({ readRuntimeSystemStateReadiness: realReader }),
      loadDist: () => Promise.reject(new Error("dist should not load")),
      canFallBackToDist: () => true,
    });
    expect(reader({ draining: true })).toEqual({ status: "draining" });
    expect(reader({ draining: false })).toEqual({ status: "ready" });
  });

  it("falls back to the built dist module for the EXPECTED plain-Node unsupported-TS-loader shape when the source is present", async () => {
    // Plain node strips types but cannot resolve the source's internal `./x.js`
    // specifier, so the load fails with the repo's specific ERR_MODULE_NOT_FOUND
    // shape: an internal `.js` under the source tree, imported from the `.ts`
    // source. That is the one legitimate fallback case.
    const sourceUrl = "/repo/packages/sync-engine/src/sync/service/systemStateReadiness.ts";
    const expectedError = Object.assign(
      new Error(
        "Cannot find module '/repo/packages/sync-engine/src/sync/service/systemStateReadiness.js' imported from " +
          sourceUrl,
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    const distReader = () => ({ status: "ready" });
    const reader = await resolveSystemStateReadinessReader({
      sourceURL: sourceUrl, // source `.ts` present, fails only on the unsupported loader
      sourceExists: () => true,
      distExists: () => true,
      loadSource: () => Promise.reject(expectedError),
      loadDist: () => Promise.resolve({ readRuntimeSystemStateReadiness: distReader }),
      canFallBackToDist: () => true, // plain-Node CLI case
    });
    expect(reader({})).toEqual({ status: "ready" });
  });

  it("rethrows a source-present runtime failure even with dist present and plain-Node fallback allowed", async () => {
    // A real runtime throw from the loaded `.ts` source is NOT the
    // unsupported-loader shape, so it must rethrow even though a stale dist
    // copy exists and canFallBackToDist() is true — never masked.
    const sourceUrl = "/repo/packages/sync-engine/src/sync/service/systemStateReadiness.ts";
    const runtimeError = new Error("boom at runtime");
    const loadDist = vi.fn();
    await expect(
      resolveSystemStateReadinessReader({
        sourceURL: sourceUrl,
        sourceExists: () => true,
        distExists: () => true, // stale dist exists but must not mask the bug
        loadSource: () => Promise.reject(runtimeError),
        loadDist: () => Promise.resolve({ readRuntimeSystemStateReadiness: () => ({ status: "ready" }) }),
        canFallBackToDist: () => true,
      }),
    ).rejects.toBe(runtimeError);
    expect(loadDist).not.toHaveBeenCalled();
  });

  it("rethrows a missing bare dependency even with dist present and plain-Node fallback allowed", async () => {
    // A REAL dependency failure: ERR_MODULE_NOT_FOUND for a bare package, not
    // for an internal `.js` under the source tree — must rethrow, never masked
    // by a stale dist copy.
    const sourceUrl = "/repo/packages/sync-engine/src/sync/service/systemStateReadiness.ts";
    const depError = Object.assign(
      new Error("Cannot find package 'some-missing-pkg' imported from " + sourceUrl),
      { code: "ERR_MODULE_NOT_FOUND", name: "Error" },
    );
    const loadDist = vi.fn();
    await expect(
      resolveSystemStateReadinessReader({
        sourceURL: sourceUrl,
        sourceExists: () => true,
        distExists: () => true,
        loadSource: () => Promise.reject(depError),
        loadDist: () => Promise.resolve({ readRuntimeSystemStateReadiness: () => ({ status: "ready" }) }),
        canFallBackToDist: () => true,
      }),
    ).rejects.toBe(depError);
    expect(loadDist).not.toHaveBeenCalled();
  });

  it("returns the immediate-ready no-op when the source is absent even if a stale dist copy exists (never loads it)", async () => {
    // A dist file left over from a different branch/feature layer must not be
    // loaded when the source module is absent: the no-op is returned and the
    // stale dist is never touched.
    const loadDist = vi.fn(() => Promise.reject(new Error("stale dist must not be loaded")));
    const reader = await resolveSystemStateReadinessReader({
      sourceExists: () => false, // module absent from this branch
      distExists: () => true, // a stale dist copy exists
      loadSource: () => Promise.reject(new Error("source module not found")),
      loadDist,
      canFallBackToDist: () => true, // would allow dist fallback in plain Node
    });
    const touched = vi.fn();
    expect(reader(touched)).toEqual({ status: "ready" });
    expect(touched).not.toHaveBeenCalled();
    expect(loadDist).not.toHaveBeenCalled();
  });

  it("rethrows a real source/runtime failure when the module exists (never masks it)", async () => {
    const realError = new Error("systemStateReadiness failed to compile");
    await expect(
      resolveSystemStateReadinessReader({
        sourceExists: () => true, // the module IS present — this is a real bug
        distExists: () => false,
        loadSource: () => Promise.reject(realError),
        loadDist: () => Promise.reject(new Error("dist should not load")),
        canFallBackToDist: () => false, // Vitest: no dist fallback
      }),
    ).rejects.toBe(realError);
  });

  it("rethrows under Vitest (no dist fallback) even when dist exists, avoiding stale-dist masking", async () => {
    const realError = new Error("source compile failure under Vitest");
    await expect(
      resolveSystemStateReadinessReader({
        sourceExists: () => true,
        distExists: () => true, // a stale dist copy exists but must not mask the bug
        loadSource: () => Promise.reject(realError),
        loadDist: () => Promise.resolve({ readRuntimeSystemStateReadiness: () => ({ status: "ready" }) }),
        canFallBackToDist: () => false, // VITEST=true: no dist masking
      }),
    ).rejects.toBe(realError);
  });
});
