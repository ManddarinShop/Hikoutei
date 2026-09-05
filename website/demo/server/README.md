# Hikoutei demo server

Live reliability demo backend: a plain Node/Express process that embeds
Hikoutei exactly like a real application would.

## Run

```sh
npm install
npm start
```

Local-only SQLite mode by default. To run with live Google Sheets projection,
copy `.env.example` to `.env`, set `HIKOUTEI_SYNC_SPREADSHEET_URL` and
`GOOGLE_APPLICATION_CREDENTIALS` (the service account must be shared on the
spreadsheet), and load it (`set -a; source .env; set +a`).

## API

| Endpoint | Description |
| --- | --- |
| `POST /api/burst` `{ count }` | Server-side amplification: enqueue up to 5,000 writes through one serialized worker loop |
| `GET /api/stream` | SSE. `snapshot` every 1s, `event` per pipeline stage |
| `POST /api/reset` | Reset measured metrics (database is preserved) |
| `GET /api/health` | Liveness + sync mode |
| `GET /api/sheet-link` | Demo spreadsheet URL for human-edit (conflict) scenarios |

## Try it

```sh
curl localhost:3101/api/health
curl -X POST localhost:3101/api/burst -H 'content-type: application/json' -d '{"count":50}'
curl -N localhost:3101/api/stream
```

## SSE contract (mirrors the demo frontend's data shapes)

`snapshot` (every 1s):

```json
{
  "ts": "2026-09-01T12:00:00.000Z",
  "syncMode": "sync",
  "metrics": {
    "requestsPerMinute": 1248,
    "completedTotal": 184392,
    "queueDepth": 12,
    "p50LatencyMs": 12,
    "p95LatencyMs": 847,
    "throughputPerSecond": 24.8
  },
  "outbox": { "pending": 0, "processing": 0, "deliveryUncertain": 0, "failed": 0 },
  "conflicts": { "open": 0, "needsRebase": 0 },
  "healthScore": 100
}
```

`event` (as stages happen; new clients replay the last 20):

```json
{
  "id": "evt_8f21ab34",
  "tone": "success",
  "title": "Projection completed",
  "detail": "3 effects → Google Sheets",
  "at": "2026-09-01T12:00:01.000Z"
}
```

Event tones: `neutral` (persisted), `success` (projected), `info` (retrying),
`danger` (failed effect / conflict).

## Design notes

- **Measurement lives here, not in the library.** `em.flush()` is timed
  around the call; sync-side numbers come from the read-only
  `hikoutei/internal/sync-status` WAL co-reader.
- **One serialized writer.** All demo writes flow through a single worker so
  SQLite never contends and `queueDepth` is true backpressure.
- **Burst cap** (`MAX_BURST = 5000`) bounds amplification so concurrent
  visitors cannot starve the Sheets projection queue indefinitely.