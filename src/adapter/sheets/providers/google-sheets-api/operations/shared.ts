/**
 * Shared wiring and pacing helpers for the Google Sheets API provider
 * operations.
 *
 * The provider class hands one immutable `GoogleSheetsApiProviderDeps` object
 * to every operation function so the class stays a thin facade. Pacing
 * (read/write request-start limiters), redacted telemetry, route validation
 * against the registered definition, and batchUpdate reply validation live
 * here because every operation shares them.
 */

import type { RegisteredSyncProjectionDefinition } from "../../../../../application/sync/sheets/sheetsProvisioning.js";
import {
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "../../../../../application/sync/sheets/errors.js";
import { classifyTransportOutcome } from "../../../../../application/sync/sheets/transportOutcome.js";
import { presentValue, absentValue, type Presence } from "../../../../../shared/state/index.js";
import type { GoogleSheetsApiRequestEvent } from "../GoogleSheetsApiSyncProvider.js";
import type { GoogleSheetsApiTransport } from "../transport/googleSheetsApiTransport.js";
import { RequestStartLimiter } from "../transport/rateLimiter.js";
import { invalidProviderState } from "../errors.js";

/** Immutable wiring every operation function receives from the provider. */
export interface GoogleSheetsApiProviderDeps {
  readonly spreadsheetId: string;
  readonly definitions: readonly RegisteredSyncProjectionDefinition[];
  readonly transport: GoogleSheetsApiTransport;
  readonly readTimeoutMs: number;
  readonly maxBatchBytes: number;
  readonly readLimiter: RequestStartLimiter;
  readonly writeLimiter: RequestStartLimiter;
  readonly now: () => number;
  readonly onRequest: ((event: GoogleSheetsApiRequestEvent) => void) | undefined;
}

/** Paces ONE `getSpreadsheet` transport call and emits one read event. */
export async function runRead<T>(
  deps: GoogleSheetsApiProviderDeps,
  task: () => Promise<T>,
): Promise<T> {
  await deps.readLimiter.waitForSlot();
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
  await deps.writeLimiter.waitForSlot();
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

/** Emits one redacted telemetry event; diagnostics must never throw. */
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
      code,
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
 * not close effects, so this throws a delivery-uncertain state error.
 */
export function requireValidBatchUpdateReply(value: unknown, requestCount: number): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidProviderState("batchUpdate response must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.replies) || record.replies.length !== requestCount) {
    invalidProviderState(
      `batchUpdate reply count does not match ${requestCount} requests`,
    );
  }
  record.replies.forEach((reply, index) => {
    if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
      invalidProviderState(`batchUpdate reply[${index}] must be an object`);
    }
    const replyRecord = reply as Record<string, unknown>;
    const addSheet = replyRecord.addSheet;
    if (addSheet === undefined) return;
    if (addSheet === null || typeof addSheet !== "object" || Array.isArray(addSheet)) {
      invalidProviderState(`batchUpdate reply[${index}].addSheet is invalid`);
    }
    const properties = (addSheet as Record<string, unknown>).properties;
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      invalidProviderState(`batchUpdate reply[${index}].addSheet.properties is invalid`);
    }
    if (typeof (properties as Record<string, unknown>).sheetId !== "number") {
      invalidProviderState(`batchUpdate reply[${index}].addSheet.properties.sheetId is invalid`);
    }
  });
}
