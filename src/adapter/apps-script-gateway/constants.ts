/** Protocol version used by the thin Apps Script operation dispatcher. */
export const SYNC_GATEWAY_PROTOCOL_VERSIONS = {
  DATA: "typed-sheets-sync-v1",
} as const;

export type SyncGatewayProtocolVersion =
  (typeof SYNC_GATEWAY_PROTOCOL_VERSIONS)[keyof typeof SYNC_GATEWAY_PROTOCOL_VERSIONS];

/** Data-plane protocol version used by signed sync requests. */
export type SyncGatewayDataProtocolVersion =
  (typeof SYNC_GATEWAY_PROTOCOL_VERSIONS)["DATA"];

/** Operation names accepted by the thin Code.gs function dispatcher. */
export const APPS_SCRIPT_OPERATION_NAMES = {
  APPLY_OPERATIONS: "applyOperations",
} as const;

export type AppsScriptOperationName =
  (typeof APPS_SCRIPT_OPERATION_NAMES)[keyof typeof APPS_SCRIPT_OPERATION_NAMES];

/** Shared defaults for signed gateway envelopes. */
export const SYNC_GATEWAY_DEFAULTS = {
  DATA_ACTOR_ID: "typed-sheets-sync-worker",
  KEY_ID: "typed-sheets-shared-secret-v1",
  EXPIRY_MS: 60_000,
  MIN_EXPIRY_MS: 1_000,
  MAX_EXPIRY_MS: 10 * 60_000,
} as const;

/** Request timeout bounds for the Node-side Apps Script client. */
export const SYNC_GATEWAY_CLIENT_DEFAULTS = {
  REQUEST_TIMEOUT_MS: 30_000,
  MIN_REQUEST_TIMEOUT_MS: 1_000,
  MAX_REQUEST_TIMEOUT_MS: 120_000,
} as const;

/** Cryptographic algorithm used by both gateway envelope types. */
export const SYNC_GATEWAY_HASH_ALGORITHMS = {
  SHA256: "sha256",
} as const;

/** Encodings used by the Node crypto boundary. */
export const SYNC_GATEWAY_ENCODINGS = {
  UTF8: "utf8",
  BASE64URL: "base64url",
} as const;

/** Canonical JSON tokens emitted for primitive literal values. */
export const SYNC_JSON_LITERAL_TOKENS = {
  NULL: "null",
  TRUE: "true",
  FALSE: "false",
} as const;

/** Request IDs must remain short and safe to carry through the gateway. */
export const SYNC_GATEWAY_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
