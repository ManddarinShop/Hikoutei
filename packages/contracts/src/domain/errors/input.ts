/**
 * Structured input validation errors for the contracts leaf.
 *
 * These mirror the kernel's `KernelInputError` pattern: a `TypeError`
 * subclass carrying a stable error code and a label parameterised message.
 * The contracts leaf and the kernel each own their own class so neither
 * package depends on the other; message text is byte-identical by convention.
 */

/** Stable error codes for contracts-leaf input validation. */
export const CONTRACTS_INPUT_ERROR_CODES = {
  NON_EMPTY_STRING_REQUIRED: "contracts_non_empty_string_required",
  NON_NEGATIVE_INTEGER_REQUIRED: "contracts_non_negative_integer_required",
  SHA256_HASH_REQUIRED: "contracts_sha256_hex_required",
  OBJECT_REQUIRED: "contracts_object_required",
} as const;

export type ContractsInputErrorCode =
  (typeof CONTRACTS_INPUT_ERROR_CODES)[keyof typeof CONTRACTS_INPUT_ERROR_CODES];

const contractsInputMessages: Record<ContractsInputErrorCode, (label: string) => string> = {
  [CONTRACTS_INPUT_ERROR_CODES.NON_EMPTY_STRING_REQUIRED]: (label) =>
    `${label} must be a non-empty string`,
  [CONTRACTS_INPUT_ERROR_CODES.NON_NEGATIVE_INTEGER_REQUIRED]: (label) =>
    `${label} must be a non-negative safe integer`,
  [CONTRACTS_INPUT_ERROR_CODES.SHA256_HASH_REQUIRED]: (label) =>
    `${label} must be a SHA-256 hexadecimal hash`,
  [CONTRACTS_INPUT_ERROR_CODES.OBJECT_REQUIRED]: (label) =>
    `${label} must be an object`,
};

/** Typed error for contracts-leaf input validation failures (identity, SQL row decoding). */
export class ContractsInputError extends TypeError {
  readonly code: ContractsInputErrorCode;

  constructor(code: ContractsInputErrorCode, label: string) {
    super(contractsInputMessages[code](label));
    this.name = "ContractsInputError";
    this.code = code;
  }
}
