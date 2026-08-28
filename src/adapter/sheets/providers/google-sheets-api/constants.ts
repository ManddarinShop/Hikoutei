/**
 * Provider constants for the direct Google Sheets API outbound worker.
 *
 * The direct provider mirrors the Apps Script provider's durable contracts:
 * the same hidden receipt tab name and headers, the same sync-anchor value
 * format (now stored as the User_Input tab's last system column instead of
 * developer metadata), the same canonical date serial/number-format semantics,
 * and the same bounded effect batches. Keeping these constants next to the provider
 * (rather than importing the Apps Script operation sources) makes the direct
 * path self-contained. Wire compatibility with a spreadsheet an Apps Script
 * provider already wrote to is limited to the receipt and date contracts:
 * User_Input tabs now require the `__hikoutei_row_id` system column, so
 * legacy tabs must be re-provisioned.
 */

/** Spreadsheets scope requested through Application Default Credentials. */
export const GOOGLE_SHEETS_API_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
] as const;

/** Defaults for the direct Google Sheets API transport and batching. */
export const GOOGLE_SHEETS_API_DEFAULTS = {
  /** Default per-request timeout; the durable worker owns retries, not gaxios. */
  REQUEST_TIMEOUT_MS: 60_000,
  MIN_REQUEST_TIMEOUT_MS: 1_000,
  MAX_REQUEST_TIMEOUT_MS: 120_000,
  /**
   * Default per-READ-request timeout (every getSpreadsheet call). Reads are
   * bounded much shorter than writes so a slow-but-working effect dispatch
   * (up to three sequential paced calls: two preflight reads plus one write)
   * cannot outlive its effect lease.
   */
  READ_TIMEOUT_MS: 10_000,
  /** Upper bound for read timeouts; reads must stay well under the lease. */
  MAX_READ_TIMEOUT_MS: 60_000,
  /**
   * Minimum interval between request starts of the WHOLE provider: reads
   * and writes use independent request-start limiters, so reads serialize
   * only against reads and writes only against writes, and a read and a
   * write can start concurrently. Google Sheets quota is enforced per
   * 100-second windows; the 2,000 ms default paces each class to about 50
   * starts per 100 s, leaving headroom inside the default per-user/
   * per-project 100-second quotas for the observation and provisioning
   * reads that run beside the worker. 2,000 ms is the smallest interval
   * demonstrated clean under the current shared service-account quota
   * profile (live records: 0 remote HTTP 429s at 2,000 ms and above, while
   * 1,500 ms produced 429s), so it is the quota-safe default and the env
   * override floor rejects the demonstrated-unsafe 1,000-1,999 ms band.
   * The exact quota stays provider and
   * environment dependent, so operators can override the interval through
   * the internal sync env key
   * (HIKOUTEI_SYNC_RATE_LIMIT_INTERVAL_MS) or the internal provider option;
   * the safe default is intentionally conservative. The interval is part of
   * the effect-lease headroom contract: a worst-case dispatch (two
   * preflight/postcondition reads plus one write, each paced and timed out,
   * with up to one full interval of first-slot wait) must finish inside the
   * lease with the 30-second provider headroom, and the internal service
   * validation rejects an override that would let pacing outlive the lease
   * (the env override is bounded to the largest default-safe interval,
   * ~10 s). Admission is bounded SEPARATELY from this interval: the interval
   * only spaces request starts, while the independent bounded admission wait
   * (REQUEST_START_MAX_ADMISSION_WAIT_MS, default 5,000 ms) refuses a call
   * whose PREDICTED WAIT exceeds that bound before any SDK call with the
   * stable delivery-uncertain `google_sheets_api_request_start_refused`
   * error (the durable worker requeues), so an arbitrarily long queue of
   * concurrent lock-free polling reads can never make a write wait past its
   * lease.
   */
  REQUEST_START_INTERVAL_MS: 900,
  /**
   * Maximum admitted wait for ONE request-start slot before the bounded
   * admission refuses it (delivery-uncertain, requeued durably). This is
   * intentionally larger than the pacing interval: a postcondition read
   * that verifies a just-written row shares the write limiter, and it must
   * be allowed to wait a few intervals for the write slot instead of being
   * refused by the read burst. The interval still spaces request STARTS
   * (quota safety); this bound only caps how long a call queued behind a
   * saturated limiter will wait before refusing rather than firing unpaced.
   */
  REQUEST_START_MAX_ADMISSION_WAIT_MS: 5_000,
  /**
   * The provider stops adding effects to one batchUpdate once the serialized
   * body would exceed this budget and returns `hasMore` for the suffix. The
   * Google API itself accepts larger bodies; this is the provider's own
   * safety valve so a pathological payload cannot monopolize a request.
   */
  MAX_BATCH_REQUEST_BYTES: 2 * 1024 * 1024,
  /**
   * Regular effect batch cap. Live-measured 2026-08-28 (fresh spreadsheet,
   * sustained 19-minute mixed soak, zero 429s): 1,000 effects per request is
   * quota-safe (~7% of the per-user write quota at a 900 ms request-start
   * interval) and ~2× the throughput of the former 300 cap for update/delete/
   * mixed backlogs. Larger caps do not help: per-request latency grows
   * super-linearly past 1,000 rows and the 2 MB body budget bounds a single
   * write at ~2,700 rows anyway.
   */
  MAX_EFFECTS_PER_REQUEST: 1_000,
  /** Append row cap per request, matching the worker's bulk claim window. */
  MAX_APPEND_ROWS_PER_REQUEST: 1_000,
} as const;

/** Hidden receipt tab shared with the Apps Script effect operations. */
export const GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME =
  "__typed_sheets_internal_effect_receipts";

/**
 * Canonical Google API remote status that proves a range names a missing
 * tab. The refresh's fixed receipt-tab range is only treated as still-absent
 * when the API rejects it with this exact status; any other 400 (or a 400
 * without a remote status) must fail closed instead of being read as proof
 * the receipt tab is absent.
 */
export const GOOGLE_SHEETS_API_MISSING_RANGE_REMOTE_CODE = "INVALID_ARGUMENT";

/** Receipt columns written by both the Apps Script and direct providers. */
export const GOOGLE_SHEETS_API_RECEIPT_HEADERS = [
  "effectId",
  "payloadHash",
  "status",
  "visibleHash",
  "visibleRevision",
  "updatedAt",
] as const;

/**
 * System-column header of the User_Input tab carrying the row anchor.
 *
 * The row UUID lives in the LAST column of the User_Input tab as a cell
 * value (`sync-anchor:<uuid>`) instead of developer metadata, so anchor
 * storage is not bounded by the Sheets per-sheet metadata quota. The column
 * is internal: it is excluded from user-field hashes, blank-row rules, and
 * the registered headers contract.
 */
export const GOOGLE_SHEETS_API_ROW_ID_HEADER = "__hikoutei_row_id";

/**
 * Value prefix of anchors GENERATED by the observation/anchor-ensure path.
 *
 * Flush-created rows keep the mapping's deterministic anchor format (the
 * default is `entity:<id>`); the system column accepts any non-empty string
 * as an anchor because the column position is the identity proof.
 */
export const GOOGLE_SHEETS_API_ANCHOR_VALUE_PREFIX = "sync-anchor:";

/**
 * Canonical UTC date number format, byte-identical to the Apps Script
 * `setNumberFormat` pattern so date cells written by either provider read
 * back as dates through the REST API.
 */
export const GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT =
  'yyyy"-"mm"-"dd"T"hh:mm:ss.000"Z"';

/**
 * Canonical date number format as a REST `CellFormat.numberFormat` object.
 * The Sheets API models number formats as `{ type, pattern }` objects, not
 * bare pattern strings.
 */
export const GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT = {
  type: "DATE_TIME",
  pattern: GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT,
} as const;

/** Stable per-effect reason codes emitted by the direct provider. */
export const GOOGLE_SHEETS_API_EFFECT_REASONS = {
  EFFECT_ID_REUSED_WITH_DIFFERENT_PAYLOAD: "effect_id_reused_with_different_payload",
  RECEIPT_TARGET_MISSING: "receipt_target_missing",
  RECEIPT_POSTCONDITION_CHANGED: "receipt_postcondition_changed",
  RECEIPT_TARGET_REAPPEARED: "receipt_target_reappeared",
  TARGET_ANCHOR_MISSING: "target_anchor_missing",
  INSERT_REQUIRES_EMPTY_VISIBLE_BASELINE: "insert_requires_empty_visible_baseline",
  VISIBLE_GUARD_MISMATCH: "visible_guard_mismatch",
  CANDIDATE_GUARD_MISMATCH: "candidate_guard_mismatch",
  REPAIR_GUARD_MISMATCH: "repair_guard_mismatch",
  INVALID_DELETION_GUARD: "invalid_deletion_guard",
  POSTCONDITION_HASH_MISMATCH: "postcondition_hash_mismatch",
  EFFECT_PAYLOAD_TOO_LARGE: "effect_payload_too_large",
} as const;

export type GoogleSheetsApiEffectReason =
  (typeof GOOGLE_SHEETS_API_EFFECT_REASONS)[keyof typeof GOOGLE_SHEETS_API_EFFECT_REASONS];

/** Deletion-kind projection restriction reasons use the effect kind prefix. */
export function fullRowDeletionReason(effectKind: string): string {
  return `${effectKind}_requires_full_row`;
}
