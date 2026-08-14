import { describe, expect, it } from "vitest";

import { SyncTaskSupervisor } from "../src/application/sync/service/SyncTaskSupervisor.js";

describe("SyncTaskSupervisor", () => {
  it("coalesces passes and drains an in-flight reconciliation task on stop", async () => {
    let resolvePass!: () => void;
    const pendingPass = new Promise<void>((resolve) => {
      resolvePass = resolve;
    });
    const supervisor = new SyncTaskSupervisor({
      name: "reconciliation",
      runPass: () => pendingPass,
    });

    const first = supervisor.runOnce();
    const second = supervisor.runOnce();
    expect(second).toBe(first);

    let stopped = false;
    const stopping = supervisor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolvePass();
    await first;
    await stopping;
    expect(stopped).toBe(true);
    await expect(supervisor.runOnce()).rejects.toThrow(
      "sync reconciliation supervisor is stopped",
    );
  });
});
