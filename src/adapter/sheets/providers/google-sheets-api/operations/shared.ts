/**
 * Shared wiring and pacing helpers for the Google Sheets API provider
 * operations.
 *
 * The provider class hands one immutable `GoogleSheetsApiProviderDeps` object
 * to every operation function so the class stays a thin facade. Pacing
 * (ONE request-start limiter shared by reads and writes), redacted
 * telemetry, route validation against the registered definition, and
 * batchUpdate reply validation live here because every operation shares
 * them.
 */

import type { RegisteredSyncProjectionDefinition } from "../../../../../application/sync/sheetsContract/sheetsProvisioning.js";
import {
  SYNC_INVALID_PROVIDER_OPERATIONS,
  SYNC_INVALID_PROVIDER_REASONS,
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "../../../../../application/sync/sheetsContract/errors.js";
import { classifyTransportOutcome, sanitizeTransportRemoteCode } from "../../../../../application/sync/sheetsContract/transportOutcome.js";
import { presentValue, absentValue, PRESENCE_KINDS, type Presence } from "../../../../../shared/state/index.js";
import {
  logHikouteiInternalEvent,
} from "../../../../../shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "../../../../../shared/observability/logEvents.js";
import type { GoogleSheetsApiRequestEvent } from "../GoogleSheetsApiSyncProvider.js";
import type { GoogleSheetsApiTransport } from "../transport/googleSheetsApiTransport.js";
import { RequestStartLimiter } from "../transport/rateLimiter.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
  invalidProviderState,
} from "../errors.js";
import { batchUpdateResponseShapeSchema } from "../model/rawResponseSchemas.js";

/** Immutable wiring every operation function receives from the provider. */
export interface GoogleSheetsApiProviderDeps {
  readonly spreadsheetId: string;
  readonly definitions: readonly RegisteredSyncProjectionDefinition[];
  readonly transport: GoogleSheetsApiTransport;
  readonly readTimeoutMs: number;
  readonly maxBatchBytes: number;
  /** ONE limiter shared by reads and writes (combined starts are serialized). */
  readonly requestLimiter: RequestStartLimiter;
  /**
   * Maximum admitted wait for ONE request start (the limiter's interval): a
   * call whose predicted slot is further out is refused before transport.
   */
  readonly maxRequestStartWaitMs: number;
  readonly now: () => number;
  readonly onRequest: ((event: GoogleSheetsApiRequestEvent) => void) | undefined;
}

/**
 * Static, redacted refusal message. Never embeds effect ids, sheet names,
 * spreadsheet ids, or limiter state: the durable worker only needs the
 * stable code to requeue through the CAS/recovery path.
 */
const REQUEST_START_REFUSED_MESSAGE =
  "Google Sheets API request start refused before transport: the shared pacing queue exceeds the bounded admission wait.";

/**
 * Acquires one bounded request-start slot, refusing (and logging one
 * redacted event) when the predicted wait exceeds the configured bound.
 * A refusal NEVER advances the limiter horizon and throws the stable
 * delivery-uncertain transport error before any SDK call, so the durable
 * worker requeues instead of firing an unpaced burst.
 */
async function admitRequestStart(
  deps: GoogleSheetsApiProviderDeps,
  operation: "getSpreadsheet" | "batchUpdate",
): Promise<void> {
  const admission = await deps.requestLimiter.waitForSlot(deps.maxRequestStartWaitMs);
  if (admission.status !== "refused") return;
  // Boundary record for a locally refused start: only the stable code is
  // logged (retryable, like the other delivery-uncertain buckets), never a
  // message, payload, id, or URL.
  logHikouteiInternalEvent({
    event: HIKOUTEI_LOG_EVENTS.TRANSPORT_REQUEST_FAILED,
    level: "warn",
    component: HIKOUTEI_LOG_COMPONENTS.TRANSPORT,
    code: GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED,
    errorClass: "GoogleSheetsApiTransportError",
    retryable: true,
  });
  throw new GoogleSheetsApiTransportError(
    GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED,
    REQUEST_START_REFUSED_MESSAGE,
    absentValue(),
    absentValue(),
  );
}

/** Paces ONE `getSpreadsheet` transport call and emits one read event. */
export async function runRead<T>(
  deps: GoogleSheetsApiProviderDeps,
  task: () => Promise<T>,
): Promise<T> {
  await admitRequestStart(deps, "getSpreadsheet");
  const startedAt = deps.now();
  try {
    const result = await task();
    emitRequest(deps, "getSpreadsheet", 1, startedAt, true, absentValue(), absentValue());
    return result;
  } catch (error: unknown) {
    const outcome = classifyTransportOutcome(error);
    emitRequest(deps, "getSpreadsheet", 1, startedAt, false, outcome.httpStatus, outcome.code);
    throw error;
  }
}

/** Paces ONE `batchUpdate` transport call and emits one write event. */
export async function runWrite<T>(
  deps: GoogleSheetsApiProviderDeps,
  task: () => Promise<T>,
): Promise<T> {
  await admitRequestStart(deps, "batchUpdate");
  const startedAt = deps.now();
  try {
    const result = await task();
    emitRequest(deps, "batchUpdate", 1, startedAt, true, absentValue(), absentValue());
    return result;
  } catch (error: unknown) {
    const outcome = classifyTransportOutcome(error);
    emitRequest(deps, "batchUpdate", 1, startedAt, false, outcome.httpStatus, outcome.code);
    throw error;
  }
}

/**
 * Emits one redacted telemetry event; diagnostics must never throw.
 *
 * The code is re-sanitized at the sink as defense in depth: every value
 * reaching `onRequest` is either an allowlisted stable code or the fixed
 * `unknown` category, so a future caller can never forward an arbitrary
 * remote string.
 */
export function emitRequest(
  deps: GoogleSheetsApiProviderDeps,
  operation: "getSpreadsheet" | "batchUpdate",
  operationCount: number,
  startedAt: number,
  ok: boolean,
  httpStatus: Presence<number>,
  code: Presence<string>,
): void {
  try {
    deps.onRequest?.({
      operation,
      operationCount,
      startedAt,
      durationMs: Math.max(0, deps.now() - startedAt),
      ok,
      httpStatus,
      code: code.kind === PRESENCE_KINDS.PRESENT
        ? presentValue(sanitizeTransportRemoteCode(code.value))
        : code,
    });
  } catch {
    // Diagnostics must never change a remote result.
  }
}

/** Resolves the registered projection definition for one physical sheet. */
export function definitionForPhysicalSheet(
  deps: GoogleSheetsApiProviderDeps,
  physicalSheetId: string,
): RegisteredSyncProjectionDefinition {
  const definition = deps.definitions.find(
    (candidate) => candidate.sheet.physicalSheetId === physicalSheetId,
  );
  if (definition === undefined) {
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
      "no projection definition exists for " + physicalSheetId,
    );
  }
  return definition;
}

/**
 * Route validation against the registered definition (mirrors
 * `validateRoute` in the Apps Script operation provider).
 */
export function validateRoute(
  request: {
    readonly sheetName: string;
    readonly registeredRange: string;
    readonly projection: string;
    readonly schemaVersion: number;
  },
  definition: RegisteredSyncProjectionDefinition,
): void {
  if (
    request.sheetName !== definition.sheet.tabName ||
    request.registeredRange !== definition.sheet.registeredRange ||
    request.projection !== definition.sheet.projection ||
    request.schemaVersion !== definition.sheet.schemaVersion
  ) {
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "sync provider request does not match the registered projection " +
      definition.sheet.physicalSheetId,
    );
  }
}

/** Derives the per-route effect options exactly like the Apps Script provider. */
export function effectRouteOptions(
  definition: RegisteredSyncProjectionDefinition,
): {
  readonly identityField: Presence<string>;
  readonly checkboxHeaders: readonly string[];
} {
  const identityField = definition.sheet.projection === "system_state"
    ? definition.sheet.businessKeyField
    : definition.sheet.projection === "sync_conflicts"
      ? "Conflict_ID"
      : undefined;
  return {
    identityField: identityField === undefined
      ? absentValue()
      : presentValue(identityField),
    checkboxHeaders: definition.checkboxHeaders ?? [],
  };
}

/**
 * Validates a batchUpdate reply shape: one reply per request, with the
 * addSheet reply carrying the created sheet id. A malformed 2xx response must
 * not close effects, so this throws a delivery-uncertain state error
 * classified as a `batch_update_reply` / `malformed_reply` invalid state.
 */
export function requireValidBatchUpdateReply(value: unknown, requestCount: number): void {
  const batchUpdateClassification = {
    operation: SYNC_INVALID_PROVIDER_OPERATIONS.BATCH_UPDATE_REPLY,
    reason: SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY,
  } as const;
  const parsed = batchUpdateResponseShapeSchema.safeParse(value);
  if (!parsed.success) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      invalidProviderState("batchUpdate response must be an object", batchUpdateClassification);
    }
    invalidProviderState(
      `batchUpdate reply count does not match ${requestCount} requests`,
      batchUpdateClassification,
    );
  }
  const record = parsed.data;
  if (record.replies.length !== requestCount) {
    invalidProviderState(
      `batchUpdate reply count does not match ${requestCount} requests`,
      batchUpdateClassification,
    );
  }
  record.replies.forEach((reply, index) => {
    if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
      invalidProviderState(`batchUpdate reply[${index}] must be an object`, batchUpdateClassification);
    }
    const replyRecord = reply as Record<string, unknown>;
    const addSheet = replyRecord.addSheet;
    if (addSheet === undefined) return;
    if (addSheet === null || typeof addSheet !== "object" || Array.isArray(addSheet)) {
      invalidProviderState(`batchUpdate reply[${index}].addSheet is invalid`, batchUpdateClassification);
    }
    const properties = (addSheet as Record<string, unknown>).properties;
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      invalidProviderState(`batchUpdate reply[${index}].addSheet.properties is invalid`, batchUpdateClassification);
    }
    if (typeof (properties as Record<string, unknown>).sheetId !== "number") {
      invalidProviderState(`batchUpdate reply[${index}].addSheet.properties.sheetId is invalid`, batchUpdateClassification);
    }
  });
}
