/**
 * Cross-runtime reentrancy and close-attempt lifetime contract tests.
 *
 * MEDIUM 5: the reentrancy exemption for a beforeClose hook is scoped to
 * the OWNING runtime. A hook on runtime A may self-call A.close() without
 * deadlock, but a close() on runtime B made from inside A's hook is an
 * ORDINARY concurrent call and must share B's single in-flight attempt —
 * the global AsyncLocalStorage marker this suite guards against skipped
 * B's attempt entirely.
 *
 * MEDIUM: the single-flight closeAttempt slot is held until the process
 * logger drain completes. A close() that lands while the first attempt is
 * still draining must await the SAME attempt (never start a second
 * cleanup), a failed attempt stays retryable after the slot release, and
 * a throwing drain is fail-open: it never masks the close outcome and the
 * slot is still released in the final safe step.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { defineTypedSheetsEntity } from "../src/index.js";
import { getEntityDescriptor } from "@hikoutei/sync-engine/api/entity.js";
import { createInternalHikoutei } from "../src/api/Hikoutei.js";
import type { ScalarEntityPersistenceProvider } from "@hikoutei/contracts/storage/scalar.js";
import { ScriptedCloseProvider } from "./support/scriptedCloseProvider.js";

/**
 * Test-only controls for the mocked process logger drain: `holdDrain`
 * gates the next drain call (released through `pendingDrains`), and
 * `drainReject` makes every drain call reject (fail-open verification).
 */
const loggerHooks = vi.hoisted(() => ({
  holdDrain: false,
  drainReject: false,
  pendingDrains: [] as Array<() => void>,
  drainCalls: 0,
}));

// Mock the ENGINE module path directly: since P8-D2 the runtime core lives
// in `@hikoutei/sync-engine` and imports its sibling observability module
// relatively, so mocking the root re-export shim would not reach it.
vi.mock("@hikoutei/sync-engine/shared/observability/internalLog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hikoutei/sync-engine/shared/observability/internalLog.js")>();
  return {
    ...actual,
    getHikouteiInternalLogger: () => ({
      enabled: false,
      level: "info" as const,
      filePath: undefined,
      log: () => false,
      drain: () => {
        loggerHooks.drainCalls += 1;
        if (loggerHooks.drainReject) {
          return Promise.reject(new Error("scripted-drain-failure"));
        }
        if (!loggerHooks.holdDrain) return Promise.resolve();
        return new Promise<void>((resolve) => {
          loggerHooks.pendingDrains.push(resolve);
        });
      },
    }),
  };
});

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: { id: { type: "string", primary: true }, name: { type: "string" } },
});

/** Provider whose FIRST close() blocks on a test-released gate. */
class GatedCloseProvider implements ScalarEntityPersistenceProvider {
  closeCalls = 0;
  readonly originalCloseError = new Error("scripted-provider-close-failure");
  private readonly gates: Array<() => void> = [];
  constructor(private readonly failFirst: boolean) {}

  /** Releases the FIRST gated close() call (later calls never gate). */
  releaseClose(): void {
    const release = this.gates.shift();
    if (release === undefined) {
      throw new Error("no gated provider close is pending");
    }
    release();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeCalls === 1) {
      await new Promise<void>((resolve) => {
        this.gates.push(resolve);
      });
    }
    if (this.closeCalls === 1 && this.failFirst) {
      throw this.originalCloseError;
    }
  }

  async beginTransaction(): Promise<never> {
    throw new Error("unused in close tests");
  }
  async read(): Promise<never> {
    throw new Error("unused in close tests");
  }
  async count(): Promise<never> {
    throw new Error("unused in close tests");
  }
  async readSnapshot(): Promise<never> {
    throw new Error("unused in close tests");
  }
}

/**
 * Provider with scripted close behavior: `close()` fails the first
 * `failuresBeforeSuccess` calls with the recorded original error, then
 * succeeds.

/** Builds a runtime over a scripted provider with an optional beforeClose. */
function openRuntime(provider: ScalarEntityPersistenceProvider, beforeClose?: () => Promise<void>) {
  const descriptor = getEntityDescriptor(User);
  return createInternalHikoutei(provider, new Map([[descriptor.name, descriptor]]), beforeClose);
}

/** Gates the NEXT logger drain call; returns the release function. */
function holdNextDrain(): () => void {
  loggerHooks.holdDrain = true;
  return () => {
    const release = loggerHooks.pendingDrains.shift();
    if (release !== undefined) release();
    loggerHooks.holdDrain = false;
  };
}

/** Lets all pending microtasks and immediate callbacks settle. */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  loggerHooks.drainCalls = 0;
  loggerHooks.pendingDrains.length = 0;
  loggerHooks.holdDrain = false;
});

describe("cross-runtime reentrant close (runtime identity)", () => {
  it(
    "a close() on runtime B from inside A's hook awaits B's in-flight attempt",
    async () => {
      // MEDIUM 5 regression: the GLOBAL hook marker treated ANY close()
      // from inside ANY hook as reentrant, so B's in-flight attempt was
      // skipped and the hook-internal call resolved immediately. With the
      // runtime-identity context, B's close() is an ordinary concurrent
      // call: it shares B's single-flight attempt.
      const providerB = new GatedCloseProvider(false);
      const b = openRuntime(providerB);
      // Runtime A's own provider close is NOT gated: only B's in-flight
      // attempt is held, so the test isolates the cross-runtime await.
      const providerA = new ScriptedCloseProvider(0);
      let hookBCall: Promise<void> | undefined;
      let hookASelfCall: Promise<void> | undefined;
      let selfCallSettled = false;
      const a = openRuntime(providerA, async () => {
        // Self-call: reentrant for THIS runtime, resolves immediately.
        hookASelfCall = a.close();
        void hookASelfCall.then(() => {
          selfCallSettled = true;
        });
        // Cross-runtime call: NOT reentrant — must await B's attempt.
        hookBCall = b.close();
      });

      // B's attempt is in flight (its provider close is gated) while A's
      // hook runs.
      const bClose = b.close();
      const aClose = a.close();
      await tick();

      // The self-call already settled (no self-deadlock)...
      expect(selfCallSettled).toBe(true);
      // ...but the cross-runtime call is still pending on B's attempt.
      let hookBCallSettled = false;
      void hookBCall!.then(() => {
        hookBCallSettled = true;
      });
      await tick();
      expect(hookBCallSettled).toBe(false);

      // B's close completes; only then does the hook-internal B.close()
      // settle, and A's close completes after its hook returns.
      providerB.releaseClose();
      await expect(bClose).resolves.toBeUndefined();
      await expect(hookBCall).resolves.toBeUndefined();
      await expect(aClose).resolves.toBeUndefined();

      // Exactly one cleanup attempt on each runtime.
      expect(providerB.closeCalls).toBe(1);
      expect(providerA.closeCalls).toBe(1);
    },
  );

  it(
    "a cross-runtime close() from A's hook observes B's ORIGINAL failure and fails A's close",
    async () => {
      // The cross-runtime call is not exempted: it receives B's original
      // rejection (never a skip), and since the hook awaits it, A's close
      // attempt fails with the SAME original error. Both runtimes stay
      // retryable afterwards.
      const providerB = new GatedCloseProvider(true);
      const b = openRuntime(providerB);
      const providerA = new ScriptedCloseProvider(0);
      let hookBCall: Promise<void> | undefined;
      const a = openRuntime(providerA, async () => {
        hookBCall = b.close();
        await hookBCall;
      });

      const bClose = b.close();
      const aClose = a.close();
      await tick();
      providerB.releaseClose();

      await expect(bClose).rejects.toBe(providerB.originalCloseError);
      await expect(hookBCall).rejects.toBe(providerB.originalCloseError);
      await expect(aClose).rejects.toBe(providerB.originalCloseError);
      expect(providerB.closeCalls).toBe(1);
      expect(providerA.closeCalls).toBe(1);

      // Both runtimes remain retryable after the failed attempts.
      await expect(b.close()).resolves.toBeUndefined();
      expect(providerB.closeCalls).toBe(2);
      await expect(a.close()).resolves.toBeUndefined();
      expect(providerA.closeCalls).toBe(2);
    },
  );
});

describe("close attempt slot lifetime (drain completes before release)", () => {
  it(
    "a detached setImmediate scheduled by the hook cannot bypass the close attempt once the hook ended",
    async () => {
      // Luna: the reentrancy exemption must be scoped to the hook's
      // EXECUTION WINDOW. A setImmediate scheduled by the hook retains the
      // AsyncLocalStorage store after the hook returns; without the
      // explicitly active marker cleared in finally, its close() would
      // take the reentrant fast path and resolve immediately while the
      // provider close (and the drain) is still in flight.
      const provider = new GatedCloseProvider(false);
      let immediateCloseSettled = false;
      const runtime = openRuntime(provider, async () => {
        setImmediate(() => {
          void runtime.close().then(() => {
            immediateCloseSettled = true;
          });
        });
      });

      const outer = runtime.close();
      // The immediate fires while the provider close is gated: with the
      // exemption leaked past the hook, it would have settled instantly.
      await tick();
      expect(immediateCloseSettled).toBe(false);
      expect(provider.closeCalls).toBe(1);

      // Only the shared attempt's completion (provider close + drain)
      // lets the detached callback's close() settle.
      provider.releaseClose();
      await outer;
      await tick();
      expect(immediateCloseSettled).toBe(true);
      expect(provider.closeCalls).toBe(1);
    },
  );

  it(
    "a detached promise callback scheduled by the hook awaits the same close/drain attempt",
    async () => {
      // Luna: same contract through a detached promise chain that runs
      // after a macrotask hop — long past the hook's execution window.
      const provider = new GatedCloseProvider(false);
      let detachedSettled = false;
      let chainCloseCalled = false;
      const runtime = openRuntime(provider, async () => {
        void Promise.resolve()
          .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
          .then(() => {
            chainCloseCalled = true;
            return runtime.close();
          })
          .then(() => {
            detachedSettled = true;
          });
      });

      const outer = runtime.close();
      // The detached chain calls close() only after its macrotask hop
      // (Node clamps setTimeout(0) to ~1ms, and setImmediate turns can
      // complete faster than that, so poll with real time) — while the
      // provider close is still gated.
      for (let attempt = 0; attempt < 20 && !chainCloseCalled; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      expect(chainCloseCalled).toBe(true);
      // With the exemption leaked past the hook, this close() would have
      // settled instantly; it must share the in-flight attempt instead.
      expect(detachedSettled).toBe(false);
      expect(provider.closeCalls).toBe(1);

      // Only the shared attempt's completion lets it settle.
      provider.releaseClose();
      await outer;
      await tick();
      expect(detachedSettled).toBe(true);
      expect(provider.closeCalls).toBe(1);
    },
  );

  it(
    "a close() during the drain of a FAILED attempt awaits the same attempt until drain completes",
    async () => {
      const provider = new ScriptedCloseProvider(1);
      const runtime = openRuntime(provider);
      const releaseDrain = holdNextDrain();

      // The attempt fails (provider close #1), then hangs at the held
      // logger drain: the slot must STAY reserved until the drain ends.
      const first = runtime.close();
      await tick();
      expect(loggerHooks.drainCalls).toBe(1);
      expect(provider.closeCalls).toBe(1);

      // MEDIUM regression: with the slot cleared BEFORE the drain, this
      // call started a SECOND provider cleanup while the first attempt
      // was still draining. The slot must be held, so the call shares the
      // SAME attempt — and because the shared attempt settles only after
      // the drain, the concurrent caller must NOT settle before the drain
      // completes (it observes the original rejection afterwards).
      let duringSettled = false;
      let duringError: unknown;
      const during = runtime.close().catch((error: unknown) => {
        duringError = error;
      }).then(() => {
        duringSettled = true;
      });
      await tick();
      expect(duringSettled).toBe(false);
      expect(provider.closeCalls).toBe(1); // no second cleanup during the drain

      // Only after the drain completes does the shared attempt settle:
      // both callers observe the ORIGINAL failure, and only then is the
      // slot released.
      releaseDrain();
      await expect(first).rejects.toBe(provider.originalCloseError);
      await during;
      expect(duringError).toBe(provider.originalCloseError);

      // The failed attempt is retryable: the next close() genuinely
      // re-runs the provider cleanup.
      await expect(runtime.close()).resolves.toBeUndefined();
      expect(provider.closeCalls).toBe(2);
    },
  );

  it(
    "a close() entering after performClose but during the drain awaits the same attempt until drain completes",
    async () => {
      // Luna: the shared closeAttempt represents the full close + drain
      // operation. A caller arriving after performClose() succeeded (the
      // runtime is already terminally marked) but while the final logger
      // drain is still running must await the SAME attempt until the
      // drain finishes — never resolve early on the closed fast path,
      // never touch the provider again.
      const provider = new ScriptedCloseProvider(0);
      const runtime = openRuntime(provider);
      const releaseDrain = holdNextDrain();

      const first = runtime.close();
      await tick();
      expect(loggerHooks.drainCalls).toBe(1);
      expect(provider.closeCalls).toBe(1);

      // The successful close is terminal, but the drain is still in
      // flight: the late caller shares the in-flight attempt and must not
      // settle until the drain completes.
      let duringSettled = false;
      const during = runtime.close().then(() => {
        duringSettled = true;
      });
      await tick();
      expect(duringSettled).toBe(false);
      expect(provider.closeCalls).toBe(1);

      // Releasing the drain settles the shared attempt: both callers
      // resolve together, with no second cleanup.
      releaseDrain();
      await expect(during).resolves.toBeUndefined();
      await expect(first).resolves.toBeUndefined();
      expect(provider.closeCalls).toBe(1);

      // After the full close + drain completed, the terminal fast path
      // resolves immediately.
      await expect(runtime.close()).resolves.toBeUndefined();
      expect(provider.closeCalls).toBe(1);
    },
  );

  it(
    "a throwing drain is fail-open: it never masks the close outcome and the slot is still released",
    async () => {
      loggerHooks.drainReject = true;
      try {
        // Failed attempt + throwing drain: the caller still observes the
        // ORIGINAL provider error, never the drain error.
        const provider = new ScriptedCloseProvider(1);
        const runtime = openRuntime(provider);
        await expect(runtime.close()).rejects.toBe(provider.originalCloseError);
        // The slot was released in the final safe step: the retry
        // genuinely re-runs the cleanup.
        await expect(runtime.close()).resolves.toBeUndefined();
        expect(provider.closeCalls).toBe(2);

        // Successful attempt + throwing drain: the close still resolves.
        const okProvider = new ScriptedCloseProvider(0);
        const okRuntime = openRuntime(okProvider);
        await expect(okRuntime.close()).resolves.toBeUndefined();
        await okRuntime.close();
        expect(okProvider.closeCalls).toBe(1);
      } finally {
        loggerHooks.drainReject = false;
      }
    },
  );
});
