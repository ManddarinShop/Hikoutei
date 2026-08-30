/**
 * Retryable runtime close contract tests.
 *
 * A failed `close()` must leave the runtime RETRYABLE (a later close()
 * genuinely re-runs the full cleanup) while concurrent close() calls share
 * one single-flight attempt, and a successful close must be terminal and
 * idempotent. The original failure is always rethrown unchanged to every
 * caller of the failed attempt.
 */

import { describe, expect, it } from "vitest";

import { defineTypedSheetsEntity } from "../src/index.js";
import { getEntityDescriptor } from "../src/api/entity.js";
import { createInternalHikoutei } from "../src/api/Hikoutei.js";
import type { ScalarEntityPersistenceProvider } from "@hikoutei/contracts/storage/scalar.js";
import { ScriptedCloseProvider } from "./support/scriptedCloseProvider.js";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: { id: { type: "string", primary: true }, name: { type: "string" } },
});

/**
 * Provider with scripted close behavior: `close()` fails the first
 * `failuresBeforeSuccess` calls with the recorded original error, then
 * succeeds. Call counts are recorded so tests can assert that a retry
 * genuinely re-invokes the provider cleanup.

/** Builds a runtime over a scripted provider with an optional beforeClose. */
function openScriptedRuntime(provider: ScalarEntityPersistenceProvider, beforeClose?: () => Promise<void>) {
  const descriptor = getEntityDescriptor(User);
  return createInternalHikoutei(provider, new Map([[descriptor.name, descriptor]]), beforeClose);
}

describe("retryable runtime close", () => {
  it("leaves a failed close retryable and rethrows the ORIGINAL failure", async () => {
    const provider = new ScriptedCloseProvider(1);
    const runtime = openScriptedRuntime(provider);

    await expect(runtime.close()).rejects.toBe(provider.originalCloseError);
    expect(provider.closeCalls).toBe(1);

    // A second close() genuinely re-runs the provider cleanup and succeeds.
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(provider.closeCalls).toBe(2);
  });

  it("makes a successful close terminal and idempotent", async () => {
    const provider = new ScriptedCloseProvider(0);
    const runtime = openScriptedRuntime(provider);

    await runtime.close();
    expect(provider.closeCalls).toBe(1);
    // Later calls resolve immediately without touching the provider again.
    await runtime.close();
    await runtime.close();
    expect(provider.closeCalls).toBe(1);
  });

  it("shares one attempt between concurrent close calls (single-flight)", async () => {
    const provider = new ScriptedCloseProvider(0);
    const runtime = openScriptedRuntime(provider);

    // Both callers await the SAME in-flight attempt: provider cleanup runs
    // exactly once and both resolve.
    await expect(Promise.all([runtime.close(), runtime.close(), runtime.close()]))
      .resolves.toEqual([undefined, undefined, undefined]);
    expect(provider.closeCalls).toBe(1);
  });

  it("propagates the same original failure to every concurrent caller and stays retryable", async () => {
    const provider = new ScriptedCloseProvider(1);
    const runtime = openScriptedRuntime(provider);

    const results = await Promise.allSettled([runtime.close(), runtime.close()]);
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("rejected");
    if (results[0]?.status === "rejected" && results[1]?.status === "rejected") {
      // The shared attempt rejects with the ORIGINAL provider error, never a
      // wrapped or second synthetic failure.
      expect(results[0].reason).toBe(provider.originalCloseError);
      expect(results[1].reason).toBe(provider.originalCloseError);
    }
    // Exactly one cleanup attempt ran; the runtime remains retryable.
    expect(provider.closeCalls).toBe(1);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(provider.closeCalls).toBe(2);
  });

  it("retries the full cleanup including a failed beforeClose hook", async () => {
    const provider = new ScriptedCloseProvider(0);
    let beforeCloseCalls = 0;
    const beforeClose = async () => {
      beforeCloseCalls += 1;
      if (beforeCloseCalls === 1) throw new Error("scripted-before-close-failure");
    };
    const runtime = openScriptedRuntime(provider, beforeClose);

    await expect(runtime.close()).rejects.toThrow("scripted-before-close-failure");
    expect(provider.closeCalls).toBe(1);
    // The retry re-runs the beforeClose hook AND the provider close.
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(beforeCloseCalls).toBe(2);
    expect(provider.closeCalls).toBe(2);
  });

  it("aggregates a beforeClose failure with a provider failure on one attempt", async () => {
    const provider = new ScriptedCloseProvider(1);
    const beforeClose = async () => {
      throw new Error("scripted-before-close-failure");
    };
    const runtime = openScriptedRuntime(provider, beforeClose);

    await expect(runtime.close()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [
        expect.objectContaining({ message: "scripted-before-close-failure" }),
        provider.originalCloseError,
      ],
    });
    // The runtime stays retryable after the aggregate failure: the retry
    // genuinely re-runs the full cleanup (the provider close now succeeds,
    // but the still-failing beforeClose hook fails the attempt again).
    await expect(runtime.close()).rejects.toThrow("scripted-before-close-failure");
    expect(provider.closeCalls).toBe(2);
  });

  it("returns to open after EVERY failure: repeated failures stay retryable until success", async () => {
    // Regression for the explicit state machine: a failed performClose()
    // must transition closing -> open (not linger in "closing"), so two
    // consecutive failures are each followed by a GENUINE re-run of the
    // provider cleanup, and the third attempt still runs it again.
    const provider = new ScriptedCloseProvider(2);
    const runtime = openScriptedRuntime(provider);

    await expect(runtime.close()).rejects.toBe(provider.originalCloseError);
    await expect(runtime.close()).rejects.toBe(provider.originalCloseError);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(provider.closeCalls).toBe(3);
  });

  it("re-runs BOTH hooks on the retry after an aggregate failure", async () => {
    // A first attempt where beforeClose AND the provider both fail must
    // leave the runtime retryable: the second attempt re-runs the
    // beforeClose hook AND the provider cleanup, and succeeds when both
    // stop failing. This proves the aggregate failure path also returns
    // the state to open instead of terminal-closing or lingering.
    const provider = new ScriptedCloseProvider(1);
    let beforeCloseCalls = 0;
    const beforeClose = async () => {
      beforeCloseCalls += 1;
      if (beforeCloseCalls === 1) throw new Error("scripted-before-close-failure");
    };
    const runtime = openScriptedRuntime(provider, beforeClose);

    await expect(runtime.close()).rejects.toMatchObject({ name: "AggregateError" });
    expect(provider.closeCalls).toBe(1);
    expect(beforeCloseCalls).toBe(1);
    // The retry re-runs both hooks and completes the close.
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(provider.closeCalls).toBe(2);
    expect(beforeCloseCalls).toBe(2);
    // The successful close is terminal: a later call touches nothing.
    await runtime.close();
    expect(provider.closeCalls).toBe(2);
    expect(beforeCloseCalls).toBe(2);
  });

  it("resolves a synchronous reentrant close from a beforeClose hook without a second cleanup", async () => {
    // MEDIUM 5: the close slot is reserved BEFORE beforeClose runs, so a
    // close hook that synchronously calls close() again must never start a
    // second concurrent cleanup. The reentrant call (made from within the
    // ACTIVE hook) resolves immediately — the close is already owned by
    // the outer attempt — and cleanup runs exactly once.
    const provider = new ScriptedCloseProvider(0);
    let reentrant: Promise<void> | undefined;
    let reentrantSeen = 0;
    const runtime = openScriptedRuntime(provider, async () => {
      reentrantSeen += 1;
      // Synchronous reentrant call from within the hook: it must settle
      // immediately (never await the pending outer attempt).
      reentrant = runtime.close();
    });

    await expect(runtime.close()).resolves.toBeUndefined();
    // Exactly ONE cleanup attempt: the reentrant call never started a
    // second performClose.
    expect(provider.closeCalls).toBe(1);
    expect(reentrantSeen).toBe(1);
    // The reentrant caller settled without waiting for the outer attempt.
    await expect(reentrant).resolves.toBeUndefined();
    // The successful close stays terminal.
    await runtime.close();
    expect(provider.closeCalls).toBe(1);
  });

  it("an outer close failure still reaches the outer caller and stays retryable", async () => {
    // MEDIUM 5: on a failing attempt, the hook-internal reentrant call
    // resolves immediately, but the OUTER close() rejects with the ORIGINAL
    // provider error, and the runtime remains retryable — the next close()
    // genuinely re-runs the cleanup.
    const provider = new ScriptedCloseProvider(1);
    let reentrant: Promise<void> | undefined;
    const runtime = openScriptedRuntime(provider, async () => {
      reentrant = runtime.close();
    });

    await expect(runtime.close()).rejects.toBe(provider.originalCloseError);
    expect(provider.closeCalls).toBe(1);
    // The hook-internal call resolved immediately (no self-deadlock, no
    // shared-attempt rejection leaking into the hook).
    await expect(reentrant).resolves.toBeUndefined();
    // The failed attempt released the slot and returned to open: the
    // retry genuinely re-runs the provider cleanup.
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(provider.closeCalls).toBe(2);
  });

  it("settles an AWAITED reentrant close from a beforeClose hook without self-deadlock", async () => {
    // MEDIUM 5 regression: awaiting runtime.close() from INSIDE the active
    // beforeClose hook previously returned the pending attempt promise,
    // which cannot settle until the hook returns — a guaranteed deadlock.
    // The hook-internal call must resolve immediately so the outer close
    // completes the cleanup exactly once.
    const provider = new ScriptedCloseProvider(0);
    let hookCalls = 0;
    const runtime = openScriptedRuntime(provider, async () => {
      hookCalls += 1;
      await runtime.close();
    });

    // The close settles (with a generous vitest timeout as the regression
    // guard: the pre-fix code hung forever here).
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(provider.closeCalls).toBe(1);
    expect(hookCalls).toBe(1);
    // Terminal idempotence is preserved.
    await runtime.close();
    await runtime.close();
    expect(provider.closeCalls).toBe(1);
    expect(hookCalls).toBe(1);
  });

  it("keeps an awaited-reentrant close retryable when the provider close fails", async () => {
    // MEDIUM 5: with an awaited reentrant hook call AND a failing provider
    // close, the outer close rejects with the ORIGINAL error, the runtime
    // returns to retryable open, and the retry re-runs BOTH the hook (its
    // awaited reentrant call resolves immediately again) and the provider
    // cleanup — never a deadlock, never a masked failure.
    const provider = new ScriptedCloseProvider(1);
    let hookCalls = 0;
    const runtime = openScriptedRuntime(provider, async () => {
      hookCalls += 1;
      await runtime.close();
    });

    await expect(runtime.close()).rejects.toBe(provider.originalCloseError);
    expect(provider.closeCalls).toBe(1);
    expect(hookCalls).toBe(1);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(hookCalls).toBe(2);
    expect(provider.closeCalls).toBe(2);
  });

  it("treats a throw-undefined beforeClose hook as a failed retryable close", async () => {
    // MEDIUM 3: boolean failure flags, never `error !== undefined` — a
    // hook that throws `undefined` must keep the attempt FAILED and
    // retryable instead of being treated as a success.
    const provider = new ScriptedCloseProvider(0);
    let beforeCloseCalls = 0;
    const runtime = openScriptedRuntime(provider, async () => {
      beforeCloseCalls += 1;
      if (beforeCloseCalls === 1) {
        throw undefined; // a thrown non-Error value
      }
    });

    await expect(runtime.close()).rejects.toBeUndefined();
    expect(provider.closeCalls).toBe(1);
    expect(beforeCloseCalls).toBe(1);
    // The failure was not masked as success: the retry re-runs BOTH hooks
    // and succeeds, proving the first attempt really was retryable.
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(beforeCloseCalls).toBe(2);
    expect(provider.closeCalls).toBe(2);
  });

  it("treats a throw-undefined provider close as a failed retryable close", async () => {
    // MEDIUM 3: the same boolean-flag contract applies to the provider
    // close — a provider that rejects with `undefined` (never an Error)
    // must still leave the runtime retryable and never count as success.
    const provider = new ScriptedCloseProvider(1);
    // Override the scripted error with a literal `undefined` rejection on
    // the first call.
    const throwingProvider = new Proxy(provider, {
      get(target, property, receiver) {
        if (property === "close") {
          return async () => {
            target.closeCalls += 1;
            if (target.closeCalls === 1) throw undefined;
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const runtime = openScriptedRuntime(throwingProvider);

    await expect(runtime.close()).rejects.toBeUndefined();
    expect(throwingProvider.closeCalls).toBe(1);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(throwingProvider.closeCalls).toBe(2);
  });

  it("aggregate failure preserves a non-Error hook value alongside the provider error", async () => {
    // Luna: when the beforeClose hook throws a non-Error value (undefined /
    // null are legitimate thrown values) AND the provider close also fails,
    // the AggregateError must preserve BOTH original failure values in its
    // errors array — the hook's thrown value must never be replaced by a
    // synthetic Error, so diagnostics can inspect exactly what each stage
    // threw.
    for (const thrownValue of [undefined, null]) {
      const provider = new ScriptedCloseProvider(1);
      let beforeCloseCalls = 0;
      const beforeClose = async () => {
        beforeCloseCalls += 1;
        if (beforeCloseCalls === 1) throw thrownValue;
      };
      const runtime = openScriptedRuntime(provider, beforeClose);

      const error = await runtime.close().then(
        () => {
          throw new Error("close() must reject when both stages fail");
        },
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(AggregateError);
      const aggregate = error as AggregateError;
      // The ORIGINAL failure values are preserved verbatim: the hook's
      // thrown undefined/null sits in errors[0] (never a synthesized
      // Error), the provider's original error in errors[1].
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors[0]).toBe(thrownValue);
      expect(aggregate.errors[1]).toBe(provider.originalCloseError);

      // Retryable semantics are unchanged: the next close() re-runs BOTH
      // stages and succeeds when both stop failing.
      await expect(runtime.close()).resolves.toBeUndefined();
      expect(beforeCloseCalls).toBe(2);
      expect(provider.closeCalls).toBe(2);
    }
  });
});
