/**
 * Hikoutei live reliability demo — backend.
 *
 * A plain Node/Express process that embeds Hikoutei exactly like a real
 * application:
 *
 *   - `createTypedSheets()` opens the local SQLite authority. When
 *     HIKOUTEI_SYNC_SPREADSHEET_URL + GOOGLE_APPLICATION_CREDENTIALS are set,
 *     the internal sync auto-start provisions the spreadsheet and runs the
 *     outbox worker + observation loop; otherwise the server runs in
 *     local-only mode and the demo still works (syncMode: "local").
 *
 *   - Sync-side numbers come from the read-only `hikoutei/internal/sync-status`
 *     reader (a WAL co-reader that never writes), polled once per snapshot.
 *     Projection completions are detected by diffing the pending outbox count.
 *
 *   - All demo writes flow through ONE serialized worker loop so SQLite never
 *     contends and `queueDepth` reflects true backpressure.
 *
 * HTTP surface:
 *   POST /api/burst    { count }   enqueue up to MAX_BURST writes
 *   GET  /api/stream   (SSE)       `snapshot` every 1s + `event` per stage
 *   POST /api/reset                reset measured metrics (database kept)
 *   GET  /api/health               liveness + sync mode
 *   GET  /api/sheet-link           demo spreadsheet URL (env) or null
 */

import express from "express";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";
import { readHikouteiSyncStatus } from "hikoutei/internal/sync-status";

const PORT = Number(process.env.PORT ?? 3101);
const DB_PATH = process.env.DEMO_DB_PATH ?? "./demo.sqlite";
const MAX_BURST = 5_000;
const SNAPSHOT_INTERVAL_MS = 1_000;
const THROUGHPUT_WINDOW_MS = 5_000;
const EVENT_THROTTLE_MS = 150;
const EVENT_BUFFER_LIMIT = 50;
const LATENCY_SAMPLE_LIMIT = 2_000;

const syncSpreadsheetConfigured = Boolean(
  process.env.HIKOUTEI_SYNC_SPREADSHEET_URL && process.env.HIKOUTEI_SYNC_SPREADSHEET_URL.trim() !== "",
);

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

const DemoRequest = defineTypedSheetsEntity({
  name: "DemoRequest",
  tableName: "demo_requests",
  properties: {
    id: { type: "string", primary: true },
    label: { type: "string" },
    amount: { type: "number" },
    processed: { type: "boolean" },
  },
});

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

console.log(`[demo] opening Hikoutei (sync: ${syncSpreadsheetConfigured ? "on" : "off"})...`);
const hikoutei = await createTypedSheets({ dbName: DB_PATH, entities: [DemoRequest] });
console.log(`[demo] Hikoutei ready — sync mode: ${syncSpreadsheetConfigured ? "sync" : "local"}`);

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let completedTotal = 0;

/** Completed flush durations (ms), rolling window. */
const latencySamples: number[] = [];
/** Flush completion timestamps for the ingest/min gauge. */
const ingestTimestamps: number[] = [];
/** Flush completion timestamps for the jobs/s gauge. */
const throughputTimestamps: number[] = [];

interface DemoEventMessage {
  id: string;
  tone: "success" | "info" | "brand" | "neutral" | "danger";
  title: string;
  detail: string;
  at: string;
}

const eventBuffer: DemoEventMessage[] = [];
const sseClients = new Set<express.Response>();

interface EffectCounts {
  pending: number;
  processing: number;
  deliveryUncertain: number;
  failed: number;
}

interface ConflictCounts {
  open: number;
  needsRebase: number;
}

interface SnapshotMessage {
  ts: string;
  syncMode: "local" | "sync";
  metrics: {
    requestsPerMinute: number;
    completedTotal: number;
    queueDepth: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    throughputPerSecond: number;
  };
  /** Seconds the oldest unconfirmed effect has waited — how far Sheets lags SQLite. */
  syncLagSec: number;
  outbox: EffectCounts;
  conflicts: ConflictCounts;
  healthScore: number;
}

let lastEffects: EffectCounts | null = null;
let lastOpenConflicts = 0;
let healthScore = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(samples: number[], ratio: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio));
  return Math.round(sorted[index]!);
}

function broadcast(name: string, payload: unknown): void {
  const frame = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

function recordEvent(tone: DemoEventMessage["tone"], title: string, detail: string): void {
  const message: DemoEventMessage = {
    id: `evt_${randomUUID().slice(0, 8)}`,
    tone,
    title,
    detail,
    at: new Date().toISOString(),
  };
  eventBuffer.push(message);
  if (eventBuffer.length > EVENT_BUFFER_LIMIT) eventBuffer.shift();
  broadcast("event", message);
}

/** Throttled per-write event so a 5,000 burst does not flood the stream. */
function recordPersistEventThrottled(): void {
  const now = Date.now();
  if (now - lastPersistEventAt < EVENT_THROTTLE_MS) return;
  lastPersistEventAt = now;
  recordEvent("neutral", "Entity persisted", `demo_requests / write #${completedTotal}`);
}
let lastPersistEventAt = 0;

// ---------------------------------------------------------------------------
// Serialized writer loop
// ---------------------------------------------------------------------------

const writeQueue: string[] = [];
let drainRunning = false;

function enqueueBurst(count: number): number {
  const accepted = Math.min(Math.max(1, Math.floor(count)), MAX_BURST);
  for (let i = 0; i < accepted; i += 1) {
    writeQueue.push(`req_${randomUUID().slice(0, 8)}`);
  }
  void drain();
  return accepted;
}

async function drain(): Promise<void> {
  if (drainRunning) return;
  drainRunning = true;
  try {
    while (writeQueue.length > 0) {
      writeQueue.shift();
      const em = hikoutei.em.fork();
      const startedAt = performance.now();
      em.persist(
        em.create(DemoRequest, {
          id: randomUUID(),
          label: `demo write #${completedTotal + 1}`,
          amount: Math.round(Math.random() * 10_000) / 100,
          processed: Math.random() < 0.5,
        }),
      );
      await em.flush();
      const elapsedMs = performance.now() - startedAt;

      completedTotal += 1;
      latencySamples.push(elapsedMs);
      if (latencySamples.length > LATENCY_SAMPLE_LIMIT) latencySamples.shift();
      ingestTimestamps.push(Date.now());
      throughputTimestamps.push(Date.now());
      recordPersistEventThrottled();
    }
  } finally {
    drainRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Sync-side polling (read-only, never writes)
// ---------------------------------------------------------------------------

async function pollSyncStatus(): Promise<{ outbox: EffectCounts; conflicts: ConflictCounts } | null> {
  const status = await readHikouteiSyncStatus({ dbName: DB_PATH });
  if (status.mode !== "sync") return null;

  const effects: EffectCounts = { ...status.effects };
  const conflicts: ConflictCounts = { ...status.conflicts };

  if (lastEffects !== null) {
    const projected = lastEffects.pending - effects.pending;
    if (projected > 0) {
      recordEvent("success", "Projection completed", `${projected} effect${projected === 1 ? "" : "s"} → Google Sheets`);
    }
    if (effects.deliveryUncertain > lastEffects.deliveryUncertain) {
      recordEvent("info", "Worker retrying", `${effects.deliveryUncertain} delivery-uncertain effect(s) requeued`);
    }
    if (effects.failed > lastEffects.failed) {
      recordEvent("danger", "Effect failed", `${effects.failed} failed effect(s) in the outbox`);
    }
  }
  lastEffects = effects;

  if (conflicts.open > lastOpenConflicts) {
    recordEvent("danger", "Conflict detected", "human edit diverged from the SQLite authority");
  }
  lastOpenConflicts = conflicts.open;

  // Simple health-score model: outbox health penalties only. The frontend
  // keeps its own rolling series from these snapshots.
  const penalty = Math.min(40, effects.failed * 4 + effects.deliveryUncertain * 0.5 + conflicts.open * 10);
  healthScore = Math.round(100 - penalty);

  return { outbox: effects, conflicts };
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  res.write(":ok\n\n");

  // Replay recent events so a fresh page does not boot with an empty log.
  for (const event of eventBuffer.slice(-20)) {
    res.write(`event: event\ndata: ${JSON.stringify(event)}\n\n`);
  }

  sseClients.add(res);
  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.post("/api/burst", (req, res) => {
  const raw = Number(req.body?.count ?? 1);
  if (!Number.isSafeInteger(raw) || raw < 1) {
    res.status(400).json({ error: "count must be a positive integer" });
    return;
  }
  const accepted = enqueueBurst(raw);
  res.json({ accepted, queued: writeQueue.length });
});

app.post("/api/reset", (_req, res) => {
  latencySamples.length = 0;
  ingestTimestamps.length = 0;
  throughputTimestamps.length = 0;
  completedTotal = 0;
  eventBuffer.length = 0;
  lastEffects = null;
  healthScore = 100;
  res.json({ reset: true });
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    syncMode: syncSpreadsheetConfigured ? "sync" : "local",
    uptimeS: Math.round(process.uptime()),
  });
});

app.get("/api/sheet-link", (_req, res) => {
  res.json({ url: syncSpreadsheetConfigured ? process.env.HIKOUTEI_SYNC_SPREADSHEET_URL : null });
});

// ---------------------------------------------------------------------------
// Sync lag (read-only co-reader)
//
// Age of the OLDEST effect not yet confirmed in Google Sheets:
// "Sheets is N seconds behind SQLite". A pure SQLite read (WAL co-reader,
// never writes, never contacts Google) — the demo's soul metric.
// ---------------------------------------------------------------------------

const UNCONFIRMED_EFFECT_STATUSES = "('pending','processing','delivery_uncertain')";

function readSyncLagSec(): number {
  if (!existsSync(DB_PATH)) return 0;
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const row = db
        .prepare(`SELECT MIN(created_at) AS oldest FROM sheet_effect_outbox WHERE status IN ${UNCONFIRMED_EFFECT_STATUSES}`)
        .get();
      const oldest = row?.oldest;
      if (typeof oldest !== "number") return 0;
      return Math.max(0, Math.round((Date.now() - oldest) / 100) / 10);
    } finally {
      db.close();
    }
  } catch {
    return 0; // schema not provisioned yet (fresh/local DB) — no lag to report
  }
}

// ---------------------------------------------------------------------------
// Snapshot loop
// ---------------------------------------------------------------------------

function trimWindow(timestamps: number[], windowMs: number, now: number): void {
  while (timestamps.length > 0 && timestamps[0]! < now - windowMs) timestamps.shift();
}

async function pushSnapshot(): Promise<void> {
  const polled = await pollSyncStatus();
  const now = Date.now();

  trimWindow(ingestTimestamps, 60_000, now);
  trimWindow(throughputTimestamps, THROUGHPUT_WINDOW_MS, now);

  const snapshot: SnapshotMessage = {
    ts: new Date(now).toISOString(),
    syncMode: syncSpreadsheetConfigured ? "sync" : "local",
    metrics: {
      requestsPerMinute: ingestTimestamps.length,
      completedTotal,
      queueDepth: writeQueue.length,
      p50LatencyMs: percentile(latencySamples, 0.5),
      p95LatencyMs: percentile(latencySamples, 0.95),
      throughputPerSecond: Number((throughputTimestamps.length / (THROUGHPUT_WINDOW_MS / 1_000)).toFixed(1)),
    },
    outbox: polled?.outbox ?? { pending: 0, processing: 0, deliveryUncertain: 0, failed: 0 },
    conflicts: polled?.conflicts ?? { open: 0, needsRebase: 0 },
    syncLagSec: syncSpreadsheetConfigured ? readSyncLagSec() : 0,
    healthScore,
  };
  broadcast("snapshot", snapshot);
}

const snapshotTimer = setInterval(() => {
  void pushSnapshot().catch((error: unknown) => {
    console.error("[demo] snapshot failed:", error);
  });
}, SNAPSHOT_INTERVAL_MS);
snapshotTimer.unref();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[demo] listening on http://localhost:${PORT}`);
  console.log(`[demo] stream:  curl -N localhost:${PORT}/api/stream`);
  console.log(`[demo] burst:   curl -X POST localhost:${PORT}/api/burst -H 'content-type: application/json' -d '{"count":50}'`);
});