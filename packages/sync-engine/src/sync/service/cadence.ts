/**
 * Single source of application-layer sync cadence (scheduler interval) values.
 *
 * Everything in this module is an application scheduling cadence — how often
 * loops poll, reconcile, or run safety scans. The adapter transport pacing
 * (`REQUEST_START_INTERVAL_MS = 800`, throttling individual Google Sheets
 * transport calls) intentionally STAYS in the adapter constants: it is a
 * transport layer-boundary value, not application cadence.
 *
 * Env var → option → constant mapping (see `SYNC_ENV_KEYS` in
 * `syncAutoStart.ts` for the env keys):
 *
 * | Env var                              | Option                       | Constant                          |
 * | ------------------------------------ | ---------------------------- | --------------------------------- |
 * | `HIKOUTEI_SYNC_POLLING_INTERVAL_MS`  | `options.pollingIntervalMs`  | `SYNC_POLLING_INTERVAL_MS`        |
 * | `HIKOUTEI_SYNC_FULL_SCAN_INTERVAL_MS`| `options.pollingFullScanIntervalMs` | `SYNC_FULL_SCAN_INTERVAL_MS` |
 * | (none — env-less by design)          | `options.reconciliationIntervalMs`  | `RECONCILIATION_SCAN_INTERVAL_MS` |
 * | (none — env-less by design)          | (internal, first-scan deferral only) | `RECONCILIATION_INITIAL_DELAY_MS` |
 * | (none — defensive composition default) | (internal supervisor fallback) | `POLLING_FULL_SCAN_INTERVAL_MS` |
 *
 * `HIKOUTEI_SYNC_RATE_LIMIT_INTERVAL_MS` is deliberately NOT listed here:
 * it maps to adapter transport pacing, not application cadence.
 */

/** Default User_Input polling cadence when `HIKOUTEI_SYNC_POLLING_INTERVAL_MS` is absent. */
export const SYNC_POLLING_INTERVAL_MS = 60_000;

/** Default metadata safety full-scan cadence when `HIKOUTEI_SYNC_FULL_SCAN_INTERVAL_MS` is absent. */
export const SYNC_FULL_SCAN_INTERVAL_MS = 60_000;

/** Defensive fallback full-scan cadence used inside the polling supervisor when no interval is provided. */
export const POLLING_FULL_SCAN_INTERVAL_MS = 60_000;

/** Minimum delay between System_State reconciliation scans attached to the effect loop (env-less by design). */
export const RECONCILIATION_SCAN_INTERVAL_MS = 60_000;

/**
 * Delay before the FIRST reconciliation scan for the real Google provider; a
 * cold-start service competes with the System_State drain on the shared
 * request-start limiter, so the first scan waits one cadence (env-less by
 * design; injected test providers use 0).
 */
export const RECONCILIATION_INITIAL_DELAY_MS = 60_000;