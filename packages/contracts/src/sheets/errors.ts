import { CoreErrorException } from "../domain/errors/index.js";

/** Stable error categories emitted by the runtime sync provider contract. */
export const SYNC_SHEETS_ERROR_CODES = {
  INVALID_EFFECT_PAYLOAD: "invalid_sync_effect_payload",
  INVALID_PROVISIONING_DEFINITIONS: "invalid_sync_provisioning",
  INVALID_CLIENT_OPTIONS: "invalid_sync_client_options",
  INVALID_PROVIDER_RESPONSE: "invalid_sync_provider_response",
  INVALID_FAKE_PROVIDER_INPUT: "invalid_fake_sync_provider_input",
} as const;

export type SyncSheetsErrorCode =
  (typeof SYNC_SHEETS_ERROR_CODES)[keyof typeof SYNC_SHEETS_ERROR_CODES];

/**
 * Stable operation categories for an invalid provider state, keyed by the
 * provider step where the failure was detected. Only categories with a
 * proven detection site exist; an un-instrumented provider-state validation
 * collapses to the fixed `UNCLASSIFIED` category rather than inventing a
 * speculative taxonomy. All values are allowlisted in the internal log
 * (`HIKOUTEI_LOG_PROVIDER_OPERATIONS` in `shared/observability/logEvents.ts`).
 */
export const SYNC_INVALID_PROVIDER_OPERATIONS = {
  /** Preflight read/validation of a target tab (headers, identity, receipts). */
  PREFLIGHT: "preflight",
  /** batchUpdate 2xx reply shape validation. */
  BATCH_UPDATE_REPLY: "batch_update_reply",
  /** getSpreadsheet 2xx reply shape validation. */
  GET_REPLY: "get_reply",
  /** Response-loss postcondition recovery read. */
  POSTCONDITION_READ: "postcondition_read",
  /** Any provider-state validation with no classified branch. */
  UNCLASSIFIED: "unclassified",
} as const;

export type SyncInvalidProviderOperation =
  (typeof SYNC_INVALID_PROVIDER_OPERATIONS)[keyof typeof SYNC_INVALID_PROVIDER_OPERATIONS];

/**
 * Stable reason categories for an invalid provider state, keyed by the
 * concrete failure branch. Each value names the proven condition; anything
 * without a classified branch collapses to `UNCLASSIFIED`. All values are
 * allowlisted in `HIKOUTEI_LOG_PROVIDER_REASONS`.
 */
export const SYNC_INVALID_PROVIDER_REASONS = {
  /** A 2xx reply failed its structural shape validation. */
  MALFORMED_REPLY: "malformed_reply",
  /** Fast-append identity already exists remotely without a matching receipt. */
  IDENTITY_ALREADY_EXISTS: "identity_already_exists",
  /** A registered tab is absent from a provider response/context. */
  MISSING_TAB: "missing_tab",
  /** Unclassified provider-state validation. */
  UNCLASSIFIED: "unclassified",
} as const;

export type SyncInvalidProviderReason =
  (typeof SYNC_INVALID_PROVIDER_REASONS)[keyof typeof SYNC_INVALID_PROVIDER_REASONS];

/**
 * Operations that may carry the `missing_tab` reason: the tab may be absent
 * during the preflight read or during the postcondition-recovery read.
 */
export type SyncMissingTabOperation =
  | typeof SYNC_INVALID_PROVIDER_OPERATIONS.PREFLIGHT
  | typeof SYNC_INVALID_PROVIDER_OPERATIONS.POSTCONDITION_READ;

/**
 * Allowlisted, redaction-safe classification attached to an invalid provider
 * state, typed as a discriminated union so only the proven operation/reason
 * pairs are representable: malformed `get`/`batchUpdate` replies, a remote
 * fast-append identity collision, a missing tab during preflight or
 * postcondition recovery, and the unclassified fallback. Every value is
 * allowlisted in the internal log
 * (`HIKOUTEI_LOG_PROVIDER_OPERATIONS`/`HIKOUTEI_LOG_PROVIDER_REASONS`), and
 * the exact set is pinned by `test/internal-log-registry.test.ts`.
 */
export type SyncInvalidProviderClassification =
  | { readonly operation: typeof SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY; readonly reason: typeof SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY }
  | { readonly operation: typeof SYNC_INVALID_PROVIDER_OPERATIONS.BATCH_UPDATE_REPLY; readonly reason: typeof SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY }
  | { readonly operation: typeof SYNC_INVALID_PROVIDER_OPERATIONS.PREFLIGHT; readonly reason: typeof SYNC_INVALID_PROVIDER_REASONS.IDENTITY_ALREADY_EXISTS }
  | { readonly operation: typeof SYNC_INVALID_PROVIDER_OPERATIONS.PREFLIGHT; readonly reason: typeof SYNC_INVALID_PROVIDER_REASONS.MISSING_TAB }
  | { readonly operation: typeof SYNC_INVALID_PROVIDER_OPERATIONS.POSTCONDITION_READ; readonly reason: typeof SYNC_INVALID_PROVIDER_REASONS.MISSING_TAB }
  | { readonly operation: typeof SYNC_INVALID_PROVIDER_OPERATIONS.UNCLASSIFIED; readonly reason: typeof SYNC_INVALID_PROVIDER_REASONS.UNCLASSIFIED };

/**
 * Builds the classified `missing_tab` pair for a preflight or a
 * postcondition-recovery read, mapping the narrowed operation to its only
 * valid member.
 */
export function missingTabClassification(
  operation: SyncMissingTabOperation,
): SyncInvalidProviderClassification {
  return operation === SYNC_INVALID_PROVIDER_OPERATIONS.POSTCONDITION_READ
    ? { operation: SYNC_INVALID_PROVIDER_OPERATIONS.POSTCONDITION_READ, reason: SYNC_INVALID_PROVIDER_REASONS.MISSING_TAB }
    : { operation: SYNC_INVALID_PROVIDER_OPERATIONS.PREFLIGHT, reason: SYNC_INVALID_PROVIDER_REASONS.MISSING_TAB };
}

/** Fallback classification for invalid-provider-state sites without a branch. */
export const DEFAULT_INVALID_PROVIDER_CLASSIFICATION: SyncInvalidProviderClassification = {
  operation: SYNC_INVALID_PROVIDER_OPERATIONS.UNCLASSIFIED,
  reason: SYNC_INVALID_PROVIDER_REASONS.UNCLASSIFIED,
};

/** Error raised when a provider payload or provisioning contract is invalid. */
export class SyncSheetsContractError extends CoreErrorException<
  "runtime.sync_sheets",
  SyncSheetsErrorCode
> {
  /** Allowlisted provider operation the invalid state was detected in (when classified). */
  readonly providerOperation: SyncInvalidProviderOperation | undefined;
  /** Allowlisted provider reason for the invalid state (when classified). */
  readonly providerReason: SyncInvalidProviderReason | undefined;

  constructor(
    code: SyncSheetsErrorCode,
    message: string,
    classification?: SyncInvalidProviderClassification,
  ) {
    super("runtime.sync_sheets", code, message);
    this.providerOperation = classification?.operation;
    this.providerReason = classification?.reason;
  }
}
