/**
 * Structured errors owned by the consistency-queue kernel.
 *
 * The kernel defines its own error class and code table so it has zero
 * dependencies on the host application. Code strings are stable persisted
 * values and must never change; the host's storage facade re-exports
 * `StorageError` from this module so host and kernel share ONE class
 * identity (`instanceof StorageError` behaves identically on both sides of
 * the package boundary).
 */

/** Structured error value shared by pure core decisions. */
export interface CoreError {
  /** Stable domain namespace used by callers instead of parsing messages. */
  readonly domain: string;
  /** Stable machine-readable error code. */
  readonly code: string;
}

/**
 * Base class for core helpers that must abort with a structured exception.
 *
 * Decision functions should generally return `CoreError` values. This class is
 * for invalid inputs that make a helper's success value impossible to produce
 * while preserving normal `Error` stack/message behavior for callers.
 */
export class CoreErrorException<
  TDomain extends string = string,
  TCode extends string = string,
> extends Error implements CoreError {
  readonly domain: TDomain;
  readonly code: TCode;

  protected constructor(
    domain: TDomain,
    code: TCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.domain = domain;
    this.code = code;
  }
}

/**
 * Stable error categories used by the consistency-queue kernel.
 *
 * Only the codes the kernel can raise live here; the values are part of the
 * persisted/observable contract and must stay byte-identical to the codes the
 * host storage layer has always used for these paths.
 */
export const STORAGE_ERROR_CODES = {
  INVALID_WRITER_LEASE_OPTIONS: "invalid_writer_lease_options",
  INVALID_EFFECT_OPTIONS: "invalid_effect_options",
  EFFECT_WRITE_FAILED: "effect_write_failed",
  EFFECT_REPLAN_CONFLICT: "effect_replan_conflict",
  INVALID_EFFECT_RESULT: "invalid_effect_result",
  INVALID_PENDING_EFFECT: "invalid_pending_effect",
  INVALID_PROJECTION_CONFIRMATION: "invalid_projection_confirmation",
  PROJECTION_CONFIRMATION_REGRESSION: "projection_confirmation_regression",
  STALE_WRITER_FENCE: "stale_writer_fence",
} as const;

export type StorageErrorCode =
  (typeof STORAGE_ERROR_CODES)[keyof typeof STORAGE_ERROR_CODES];

/**
 * Error raised when queue input, schema, or runtime prerequisites are invalid.
 *
 * The constructor accepts any stable storage-domain code string: the kernel
 * raises the codes in `STORAGE_ERROR_CODES`, while host applications pass
 * their own additional codes from their wider code table. The host storage
 * facade re-exports this class so both sides construct the same class.
 */
export class StorageError extends CoreErrorException<"storage", string> {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super("storage", code, message, options);
  }
}

// ---------------------------------------------------------------------------
// Kernel input validation
// ---------------------------------------------------------------------------

/**
 * Stable error codes for kernel input validation (non-empty strings, object
 * checks). These cover the boundary where untrusted external values enter
 * queue contracts.
 */
export const KERNEL_INPUT_ERROR_CODES = {
  NON_EMPTY_STRING_REQUIRED: "kernel_non_empty_string_required",
  OBJECT_REQUIRED: "kernel_object_required",
} as const;

export type KernelInputErrorCode =
  (typeof KERNEL_INPUT_ERROR_CODES)[keyof typeof KERNEL_INPUT_ERROR_CODES];

const kernelInputMessages: Record<KernelInputErrorCode, (label: string) => string> = {
  [KERNEL_INPUT_ERROR_CODES.NON_EMPTY_STRING_REQUIRED]: (label) =>
    `${label} must be a non-empty string`,
  [KERNEL_INPUT_ERROR_CODES.OBJECT_REQUIRED]: (label) =>
    `${label} must be an object`,
};

/**
 * Typed error for kernel input validation failures (identity, SQL row decoding).
 */
export class KernelInputError extends TypeError {
  readonly code: KernelInputErrorCode;

  constructor(code: KernelInputErrorCode, label: string) {
    super(kernelInputMessages[code](label));
    this.name = "KernelInputError";
    this.code = code;
  }
}
