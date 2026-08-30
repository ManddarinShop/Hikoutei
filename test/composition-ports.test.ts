/**
 * Focused tests for the sync-engine composition ports registry (P8-C).
 *
 * Contract under test (`packages/hikoutei-sync-engine/src/sync/service/compositionPorts.ts` +
 * `packages/hikoutei-composition/src/index.ts`):
 *
 * 1. Importing the composition-root module registers only a lazy LOADER
 *    THUNK: the sync-engine module graph (MikroORM / Google SDK adapters)
 *    must NOT start loading at module-evaluation time — the dynamic import
 *    fires on the first `requireSyncEnginePorts()` call (engine bootstrap).
 * 2. `requireSyncEnginePorts()` memoizes the resolved ports: concurrent and
 *    sequential callers share one promise (the loader runs at most once per
 *    registration).
 * 3. Unregistered state fails closed with the stable `SyncServiceError`
 *    (`STARTUP_FAILED`) and the documented wiring message.
 *
 * Each test uses `vi.resetModules()` so the module-level registry state is
 * exercised from a fresh instantiation.
 */

import { describe, expect, it, vi } from "vitest";

import { SYNC_SERVICE_ERROR_CODES } from "@hikoutei/sync-engine/sync/service/errors.js";
import type { SyncServiceError as SyncServiceErrorType } from "@hikoutei/sync-engine/sync/service/errors.js";
import {
  requireSyncEnginePorts,
  type SyncEngineCompositionPorts,
} from "@hikoutei/sync-engine/sync/service/compositionPorts.js";

const WIRING_MESSAGE =
  "hikoutei internal sync engine is not wired: the composition root (src/composition) must be loaded through the public API entrypoints before a sync service can open.";

function sentinelPorts(): SyncEngineCompositionPorts {
  // The registry treats ports opaquely; a placeholder object with the one
  // required method shape is enough for memoization assertions.
  return {
    planMappedRuntime: () => {
      throw new Error("not wired in this test");
    },
  } as unknown as SyncEngineCompositionPorts;
}

describe("sync-engine composition ports registry", () => {
  it("root composition import registers the thunk WITHOUT loading the sync-engine graph", async () => {
    vi.resetModules();
    const composition = await import("@hikoutei/composition/index.js");
    void composition;
    // Importing the composition root stores only the loader thunk: the seam
    // must report "registered" (thunk present, NEVER invoked), not "loaded".
    const { syncEnginePortsLoadState: freshState } =
      await import("@hikoutei/sync-engine/sync/service/compositionPorts.js");
    expect(freshState()).toBe("registered");
  });

  it("first requireSyncEnginePorts() invocation fires the lazy load exactly once", async () => {
    vi.resetModules();
    let loaderCalls = 0;
    const { registerSyncEnginePorts, requireSyncEnginePorts: requireFresh, syncEnginePortsLoadState } =
      await import("@hikoutei/sync-engine/sync/service/compositionPorts.js");
    const sentinel = sentinelPorts();
    registerSyncEnginePorts(() => {
      loaderCalls += 1;
      return Promise.resolve(sentinel);
    });

    // Concurrent callers share one promise → one loader invocation.
    const [a, b, c] = [
      requireFresh(),
      requireFresh(),
      requireFresh(),
    ];
    expect(a).toBe(b);
    expect(b).toBe(c);
    await expect(a).resolves.toBe(sentinel);
    expect(loaderCalls).toBe(1);
    expect(syncEnginePortsLoadState()).toBe("loaded");

    // Sequential callers reuse the memoized promise (never re-run the thunk).
    await expect(requireFresh()).resolves.toBe(sentinel);
    expect(loaderCalls).toBe(1);
  });

  it("unregistered registry throws the stable SyncServiceError with the wiring message", async () => {
    vi.resetModules();
    const { requireSyncEnginePorts: requireFresh, syncEnginePortsLoadState } =
      await import("@hikoutei/sync-engine/sync/service/compositionPorts.js");
    // Pull the error class from the SAME module instantiation that throws
    // (vi.resetModules() gives fresh bindings, so instanceof must compare
    // within one instantiation).
    const { SyncServiceError } = await import(
      "@hikoutei/sync-engine/sync/service/errors.js"
    );
    expect(syncEnginePortsLoadState()).toBe("unregistered");
    let caught: unknown;
    try {
      requireFresh();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SyncServiceError);
    expect((caught as SyncServiceErrorType).code).toBe(
      SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
    );
    expect((caught as SyncServiceErrorType).message).toBe(WIRING_MESSAGE);
  });
});

describe("sync-engine local-runtime port (P8-D2 phase 2)", () => {
  it("composition-root import registers the local-runtime thunk WITHOUT loading it",
    async () => {
      vi.resetModules();
      const composition = await import("@hikoutei/composition/index.js");
      void composition;
      const { syncEngineLocalRuntimeLoadState } = await import(
        "@hikoutei/sync-engine/sync/service/compositionPorts.js"
      );
      // The light thunk is stored but never invoked at registration time, so
      // the composition root's local-runtime seam reports "registered".
      expect(syncEngineLocalRuntimeLoadState()).toBe("registered");
    });

  it("requireSyncEngineLocalRuntime() memoizes the resolved factory",
    async () => {
      vi.resetModules();
      let loaderCalls = 0;
      const {
        registerSyncEngineLocalRuntime,
        requireSyncEngineLocalRuntime,
        syncEngineLocalRuntimeLoadState,
      } = await import(
        "@hikoutei/sync-engine/sync/service/compositionPorts.js"
      );
      const sentinel = (() => {
        throw new Error("not wired in this test");
      }) satisfies import("@hikoutei/sync-engine/sync/service/compositionPorts.js").SyncEngineLocalRuntimeFactory;
      registerSyncEngineLocalRuntime(() => {
        loaderCalls += 1;
        return Promise.resolve(sentinel);
      });
      const [a, b] = [
        requireSyncEngineLocalRuntime(),
        requireSyncEngineLocalRuntime(),
      ];
      expect(a).toBe(b);
      await expect(a).resolves.toBe(sentinel);
      expect(loaderCalls).toBe(1);
      expect(syncEngineLocalRuntimeLoadState()).toBe("loaded");
      await expect(requireSyncEngineLocalRuntime()).resolves.toBe(sentinel);
      expect(loaderCalls).toBe(1);
    });

  it("unregistered local-runtime seam fails closed with the wiring message",
    async () => {
      vi.resetModules();
      const { requireSyncEngineLocalRuntime, syncEngineLocalRuntimeLoadState } =
        await import(
          "@hikoutei/sync-engine/sync/service/compositionPorts.js"
        );
      const { SyncServiceError } = await import(
        "@hikoutei/sync-engine/sync/service/errors.js"
      );
      expect(syncEngineLocalRuntimeLoadState()).toBe("unregistered");
      let caught: unknown;
      try {
        requireSyncEngineLocalRuntime();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SyncServiceError);
      expect((caught as SyncServiceErrorType).code).toBe(
        SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
      );
      expect((caught as SyncServiceErrorType).message).toBe(WIRING_MESSAGE);
    });
});