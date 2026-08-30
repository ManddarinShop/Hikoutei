import { describe, expect, it } from "vitest";

import { SyncPollingSupervisor } from "@hikoutei/sync-engine/sync/service/SyncPollingSupervisor.js";

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
});
