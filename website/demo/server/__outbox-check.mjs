// One-off: read demo server metrics from the SQLite authority + outbox.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { readHikouteiSyncStatus } = await import("hikoutei/internal/sync-status");

const status = await readHikouteiSyncStatus({ dbName: "./demo.sqlite" });
if (status.mode !== "sync") {
  console.log("mode: local");
} else {
  const { effects } = status;
  console.log(
    `outbox: pending=${effects.pending} processing=${effects.processing} uncertain=${effects.deliveryUncertain} failed=${effects.failed} conflicts_open=${status.conflicts.open}`,
  );
}