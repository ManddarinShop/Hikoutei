/**
 * Docs API provider constants: scopes, timeouts, pacing, and quota budgets.
 *
 * PROVISIONAL NUMBERS: every pacing/budget/AIMD value below is copied from
 * the Sheets provider's measured deployment (per-user 60 reads/min binding)
 * until Docs quota is measured in the target console project. Google Docs
 * API documents per-minute read/write quotas per user; operators facing a
 * measured ceiling tune `quotaReadBudgetPerMinute` /
 * `quotaWriteBudgetPerMinute` exactly like the Sheets provider options.
 * The SHAPE (not the values) is the contract: it feeds the shared
 * `QuotaGovernorTimingDefaults` in `@hikoutei/ikisaki`, so pacing behavior
 * stays identical and only the markers differ per API.
 */

import type { QuotaGovernorTimingDefaults } from "@hikoutei/ikisaki";

/** OAuth scopes requested for the Docs API transport. */
export const GOOGLE_DOCS_API_SCOPES = [
  "https://www.googleapis.com/auth/documents",
] as const;

/** Defaults for the Docs API transport and batching. */
export const GOOGLE_DOCS_API_DEFAULTS = {
  /** Default per-request timeout; the durable worker owns retries, not gaxios. */
  REQUEST_TIMEOUT_MS: 60_000,
  MIN_REQUEST_TIMEOUT_MS: 1_000,
  MAX_REQUEST_TIMEOUT_MS: 120_000,
  /** Default per-READ-request timeout (every documents.get call). */
  READ_TIMEOUT_MS: 10_000,
  /** Upper bound for read timeouts; reads must stay well under any lease. */
  MAX_READ_TIMEOUT_MS: 60_000,
  /**
   * Minimum interval between request starts per lane (reads serialize only
   * against reads, writes only against writes). Provisional: mirrors the
   * Sheets 800 ms default (≤125 starts/100 s per lane).
   */
  REQUEST_START_INTERVAL_MS: 800,
  /** Maximum admitted wait for ONE request-start slot before refusal. */
  REQUEST_START_MAX_ADMISSION_WAIT_MS: 5_000,
  /** Sliding window the per-minute budgets enforce over. */
  QUOTA_BUDGET_WINDOW_MS: 60_000,
  /** Per-window read-lane budget. DISABLED by default (Infinity). */
  QUOTA_READ_BUDGET_PER_WINDOW: Number.POSITIVE_INFINITY,
  /** Recommended read budget once a 60/min per-user quota is measured. */
  RECOMMENDED_QUOTA_READ_BUDGET_PER_WINDOW: 45,
  /** Per-window write-lane budget. DISABLED by default (Infinity). */
  QUOTA_WRITE_BUDGET_PER_WINDOW: Number.POSITIVE_INFINITY,
  /** Recommended write budget for low write demand. */
  RECOMMENDED_QUOTA_WRITE_BUDGET_PER_WINDOW: 10,
  /** HTTP status that marks a quota-limited (AIMD signal) response. */
  QUOTA_LIMIT_HTTP_STATUS: 429,
  /** google.rpc code that marks a quota-limited response without a status. */
  QUOTA_LIMIT_REMOTE_CODE: "RESOURCE_EXHAUSTED",
  /** Multiplicative decrease: pacing interval factor per observed 429. */
  QUOTA_BACKOFF_GROWTH_FACTOR: 2,
  /** Ceiling for the AIMD pacing multiplier (interval never exceeds 4x base). */
  QUOTA_BACKOFF_MAX_MULTIPLIER: 4,
  /** Additive increase: pacing multiplier divisor per recovery step. */
  QUOTA_RECOVERY_STEP_FACTOR: 2,
  /** Successful request starts of quiet before one recovery step. */
  QUOTA_RECOVERY_SUCCESS_THRESHOLD: 25,
  /** Milliseconds since the last 429 that alone earns a recovery step. */
  QUOTA_RECOVERY_QUIET_MS: 10_000,
} as const;

/** Timing markers the Docs provider passes to every pooled governor. */
export const GOOGLE_DOCS_API_TIMING: QuotaGovernorTimingDefaults = {
  backoffGrowthFactor: GOOGLE_DOCS_API_DEFAULTS.QUOTA_BACKOFF_GROWTH_FACTOR,
  backoffMaxMultiplier: GOOGLE_DOCS_API_DEFAULTS.QUOTA_BACKOFF_MAX_MULTIPLIER,
  recoveryStepFactor: GOOGLE_DOCS_API_DEFAULTS.QUOTA_RECOVERY_STEP_FACTOR,
  recoverySuccessThreshold: GOOGLE_DOCS_API_DEFAULTS.QUOTA_RECOVERY_SUCCESS_THRESHOLD,
  recoveryQuietMs: GOOGLE_DOCS_API_DEFAULTS.QUOTA_RECOVERY_QUIET_MS,
  quotaLimitHttpStatus: GOOGLE_DOCS_API_DEFAULTS.QUOTA_LIMIT_HTTP_STATUS,
  quotaLimitRemoteCode: GOOGLE_DOCS_API_DEFAULTS.QUOTA_LIMIT_REMOTE_CODE,
};
