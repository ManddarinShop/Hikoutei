import { describe, expect, it } from "vitest";

import { SyncPollingSupervisor } from "@hikoutei/sync-engine/sync/service/SyncPollingSupervisor.js";
import {
  SYNC_POLLING_ERROR_CODES,
  PollingSupervisorOptionsError,
} from "@hikoutei/sync-engine/sync/service/errors.js";

describe("SyncPollingSupervisor", () => {
  it("drains an externally triggered pass before stop resolves", async () => {
    let resolvePass!: () => void;
    const pendingPass = new Promise<void>((resolve) => {
      resolvePass = resolve;
    });
    const supervisor = new SyncPollingSupervisor({ runPass: () => pendingPass });
    const pass = supervisor.runOnce();
    await Promise.resolve();

    let stopped = false;
    const stopping = supervisor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolvePass();
    await pass;
    await stopping;
    expect(stopped).toBe(true);
  });

  it("rejects non-positive intervalMs with the typed error code", () => {
    expect.assertions(3);
    try {
      new SyncPollingSupervisor({ runPass: () => Promise.resolve(), intervalMs: 0 });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PollingSupervisorOptionsError);
      expect((error as PollingSupervisorOptionsError).code).toBe(
        SYNC_POLLING_ERROR_CODES.POSITIVE_INTEGER_REQUIRED,
      );
      expect((error as Error).message).toBe("poll interval must be a positive safe integer");
    }
  });

  it("rejects non-positive errorBackoffInitialMs with the typed error code", () => {
    expect.assertions(3);
    try {
      new SyncPollingSupervisor({
        runPass: () => Promise.resolve(),
        errorBackoffInitialMs: 0,
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PollingSupervisorOptionsError);
      expect((error as PollingSupervisorOptionsError).code).toBe(
        SYNC_POLLING_ERROR_CODES.POSITIVE_INTEGER_REQUIRED,
      );
      expect((error as Error).message).toBe("poll error backoff must be a positive safe integer");
    }
  });

  it("rejects non-positive errorBackoffMaxMs with the typed error code", () => {
    expect.assertions(3);
    try {
      new SyncPollingSupervisor({
        runPass: () => Promise.resolve(),
        errorBackoffMaxMs: 0,
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PollingSupervisorOptionsError);
      expect((error as PollingSupervisorOptionsError).code).toBe(
        SYNC_POLLING_ERROR_CODES.POSITIVE_INTEGER_REQUIRED,
      );
      expect((error as Error).message).toBe("poll maximum error backoff must be a positive safe integer");
    }
  });

  it("rejects errorBackoffMaxMs < errorBackoffInitialMs with the backoff order code", () => {
    expect.assertions(3);
    try {
      new SyncPollingSupervisor({
        runPass: () => Promise.resolve(),
        errorBackoffInitialMs: 5_000,
        errorBackoffMaxMs: 1_000,
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(PollingSupervisorOptionsError);
      expect((error as PollingSupervisorOptionsError).code).toBe(
        SYNC_POLLING_ERROR_CODES.BACKOFF_ORDER_INVALID,
      );
      expect((error as Error).message).toBe("poll maximum error backoff must be at least the initial backoff");
    }
  });
});
