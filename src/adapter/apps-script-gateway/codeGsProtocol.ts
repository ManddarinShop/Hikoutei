/** Signed request protocol implemented by the current thin `Code.gs` file. */

import { createHmac, randomUUID } from "node:crypto";
import {
  APPS_SCRIPT_OPERATION_NAMES,
  SYNC_GATEWAY_DEFAULTS,
  SYNC_GATEWAY_ENCODINGS,
  SYNC_GATEWAY_HASH_ALGORITHMS,
  SYNC_GATEWAY_PROTOCOL_VERSIONS,
  type AppsScriptOperationName,
} from "./constants.js";
import {
  SYNC_GATEWAY_PROTOCOL_ERROR_CODES,
  SyncGatewayProtocolError,
} from "./errors.js";
import {
  requireSyncGatewayExpiry,
  requireSyncGatewayIssuedAt,
  requireSyncGatewayRequestId,
  requireSyncGatewayText,
} from "./validation.js";
import { canonicalSyncJson, syncSha256Hex } from "./syncProtocol.js";
import type { SyncJsonValue } from "./types.js";

/** The thin dispatcher reuses the data-plane protocol version. */
export const APPS_SCRIPT_OPERATION_PROTOCOL_VERSION = SYNC_GATEWAY_PROTOCOL_VERSIONS.DATA;

/** One function call that `Code.gs` restores and invokes with `(spreadsheet, args)`. */
export interface AppsScriptOperationWire {
  readonly fn: string;
  readonly args: SyncJsonValue;
}

/** Payload accepted by `Code.gs`'s `applyOperations` handler. */
export interface AppsScriptOperationPayload {
  readonly operations: readonly AppsScriptOperationWire[];
}

/** Fields authenticated by the current `Code.gs` implementation. */
export interface AppsScriptOperationSigningFields {
  readonly protocolVersion: typeof APPS_SCRIPT_OPERATION_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: AppsScriptOperationName;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly sheetId: string;
  readonly actorId: string;
  readonly bodyHash: string;
}

/** Signed envelope accepted by the current thin `Code.gs` handler. */
export interface AppsScriptOperationEnvelope extends AppsScriptOperationSigningFields {
  readonly signature: string;
  readonly payload: AppsScriptOperationPayload;
}

/** Inputs for deterministic operation-envelope creation and protocol tests. */
export interface CreateAppsScriptOperationEnvelopeOptions {
  readonly operation: AppsScriptOperationName;
  readonly payload: AppsScriptOperationPayload;
  readonly sheetId: string;
  readonly secret: string;
  readonly keyId?: string;
  readonly actorId?: string;
  readonly requestId?: string;
  readonly issuedAt?: number;
  readonly expiresInMs?: number;
}

/** Exact signing input used by `Code.gs` (there is no registered range field). */
export function appsScriptOperationSigningInput(
  input: AppsScriptOperationSigningFields,
): string {
  return [
    input.protocolVersion,
    input.requestId,
    input.operation,
    input.keyId,
    String(input.issuedAt),
    String(input.expiresAt),
    input.sheetId,
    input.actorId,
    input.bodyHash,
  ].join("\n");
}

/** Computes the URL-safe HMAC signature verified by `Code.gs`. */
export function signAppsScriptOperationEnvelope(
  input: AppsScriptOperationSigningFields,
  secret: string,
): string {
  const validSecret = requireSyncGatewayText(
    secret,
    "Apps Script operation secret",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_SECRET,
  );
  return createHmac(SYNC_GATEWAY_HASH_ALGORITHMS.SHA256, validSecret)
    .update(appsScriptOperationSigningInput(input), SYNC_GATEWAY_ENCODINGS.UTF8)
    .digest(SYNC_GATEWAY_ENCODINGS.BASE64URL);
}

/** Creates a signed request matching the current `Code.gs` wire contract. */
export function createAppsScriptOperationEnvelope(
  options: CreateAppsScriptOperationEnvelopeOptions,
): AppsScriptOperationEnvelope {
  const issuedAt = requireSyncGatewayIssuedAt(options.issuedAt ?? Date.now());
  const expiresInMs = requireSyncGatewayExpiry(
    options.expiresInMs ?? SYNC_GATEWAY_DEFAULTS.EXPIRY_MS,
  );
  const sheetId = requireSyncGatewayText(
    options.sheetId,
    "Apps Script operation sheetId",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_SHEET_ID,
  );
  const actorId = requireSyncGatewayText(
    options.actorId ?? SYNC_GATEWAY_DEFAULTS.DATA_ACTOR_ID,
    "Apps Script operation actorId",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_ACTOR_ID,
  );
  const keyId = requireSyncGatewayText(
    options.keyId ?? SYNC_GATEWAY_DEFAULTS.KEY_ID,
    "Apps Script operation keyId",
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_KEY_ID,
  );
  const requestId = requireSyncGatewayRequestId(options.requestId ?? randomUUID());
  if (options.operation !== APPS_SCRIPT_OPERATION_NAMES.APPLY_OPERATIONS) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_OPERATION,
      "Apps Script operation is not supported by Code.gs",
    );
  }

  // canonicalSyncJson validates every args value before the request is sent.
  const bodyHash = syncSha256Hex(canonicalSyncJson(options.payload));
  const unsigned = {
    protocolVersion: APPS_SCRIPT_OPERATION_PROTOCOL_VERSION,
    requestId,
    operation: options.operation,
    keyId,
    issuedAt,
    expiresAt: issuedAt + expiresInMs,
    sheetId,
    actorId,
    bodyHash,
  } as const;

  return {
    ...unsigned,
    signature: signAppsScriptOperationEnvelope(unsigned, options.secret),
    payload: options.payload,
  };
}
