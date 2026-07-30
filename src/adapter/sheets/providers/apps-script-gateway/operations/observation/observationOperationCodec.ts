/** Validates observation requests and promotes untrusted gateway responses. */

import type {
  ReadSyncSnapshotRequest,
  SyncObservedSnapshot,
  SyncGatewaySnapshot,
} from "../../../../../../application/sync/gateway/syncGateway.js";
import {
  CELL_OBSERVATION_KINDS,
  NORMALIZED_CELL_KINDS,
  type CellObservationKind,
} from "../../../../../../shared/encoding/constants.js";
import type { NormalizedCell } from "../../../../../../domain/index.js";
import { isRecord } from "../../../../../../shared/encoding/typeGuards.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
} from "../../../../../../application/sync/gateway/errors.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
  SYNC_GATEWAY_PROTOCOL_VERSIONS,
  SYNC_GATEWAY_SNAPSHOT_READ_MODES,
} from "../../../../../../application/sync/gateway/constants.js";
import {
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayProjection,
  requireSyncGatewaySnapshotReadMode,
  requireSyncGatewayText,
} from "../../../../../../application/sync/gateway/validation.js";
import { decodeOptionalSyncGatewayTiming } from "../../protocol/timing.js";
import {
  invalidOperationRequest,
  invalidOperationResponse,
} from "../../errors.js";

/** Optional route metadata carried by the observation operation. */
export interface ObservationOperationRouteOptions {
  readonly checkboxHeaders?: readonly string[];
}

export type ObservationOperationRequest = ReadSyncSnapshotRequest & ObservationOperationRouteOptions;

/** Validates the trusted shape required to start an observation operation. */
export function validateObservationRequest(
  request: ObservationOperationRequest,
): void {
  requireSyncGatewayText(
    request.physicalSheetId,
    "Apps Script observation physicalSheetId",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  requireSyncGatewayText(
    request.sheetName,
    "Apps Script observation sheetName",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  requireSyncGatewayText(
    request.registeredRange,
    "Apps Script observation registeredRange",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  requireSyncGatewayProjection(
    request.projection,
    "Apps Script observation projection",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  requireSyncGatewayPositiveSafeInteger(
    request.schemaVersion,
    "Apps Script observation schemaVersion",
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
  );
  if (request.checkboxHeaders !== undefined && !Array.isArray(request.checkboxHeaders)) {
    invalidOperationRequest(
      "Apps Script observation operation",
      "checkboxHeaders must be an array",
    );
  }
  if ("readMode" in request && request.readMode !== undefined) {
    const readMode = requireSyncGatewaySnapshotReadMode(
      request.readMode,
      "Apps Script observation readMode",
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    );
    if (
      readMode === SYNC_GATEWAY_SNAPSHOT_READ_MODES.USER_INPUT &&
      request.projection !== SYNC_GATEWAY_PROJECTIONS.USER_INPUT
    ) {
      invalidOperationRequest(
        "Apps Script observation operation",
        "user_input readMode requires the user_input projection",
      );
    }
  }
}

/** Decodes one combined observation response from the untrusted gateway. */
export function decodeObservedSnapshot(value: unknown): SyncObservedSnapshot {
  const record = requireRecord(value, "combined observation result");
  const timing = decodeOptionalSyncGatewayTiming(record.timing, "observation timing");
  const result: SyncObservedSnapshot = {
    snapshot: decodeSnapshot(record.snapshot),
  };
  return timing === undefined ? result : { ...result, timing };
}

/** Decodes and validates one normalized snapshot response. */
export function decodeSnapshot(value: unknown): SyncGatewaySnapshot {
  const record = requireRecord(value, "snapshot result");
  const protocolVersion = requireSyncGatewayText(
    record.protocolVersion,
    "snapshot protocolVersion",
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  if (protocolVersion !== SYNC_GATEWAY_PROTOCOL_VERSIONS.V1) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      "snapshot protocolVersion is unsupported",
    );
  }
  const projection = requireSyncGatewayProjection(
    record.projection,
    "snapshot projection",
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  return {
    protocolVersion,
    sheetName: requireSyncGatewayText(
      record.sheetName,
      "snapshot sheetName",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    registeredRange: requireSyncGatewayText(
      record.registeredRange,
      "snapshot registeredRange",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    projection,
    schemaVersion: requireSyncGatewayPositiveSafeInteger(
      record.schemaVersion,
      "snapshot schemaVersion",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    headers: decodeStringArray(record.headers, "snapshot headers"),
    rows: decodeSnapshotRows(record.rows),
  };
}

function decodeSnapshotRows(value: unknown): SyncGatewaySnapshot["rows"] {
  if (!Array.isArray(value)) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      "snapshot rows must be an array",
    );
  }
  return value.map((entry, index) => {
    const record = requireRecord(entry, "snapshot row[" + index + "]");
    return {
      rowNumber: requireSyncGatewayPositiveSafeInteger(
        record.rowNumber,
        "snapshot row[" + index + "].rowNumber",
        SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
      ),
      cells: decodeSnapshotCells(record.cells, index),
    };
  });
}

function decodeSnapshotCells(
  value: unknown,
  rowIndex: number,
): Readonly<Record<string, SyncGatewaySnapshot["rows"][number]["cells"][string]>> {
  const record = requireRecord(value, "snapshot row[" + rowIndex + "].cells");
  const cells: Record<string, SyncGatewaySnapshot["rows"][number]["cells"][string]> = {};
  for (const [fieldName, rawCell] of Object.entries(record)) {
    const cell = requireRecord(rawCell, "snapshot cell " + fieldName);
    const cellKind = requireSyncGatewayText(
      cell.cellKind,
      "snapshot cell " + fieldName + " cellKind",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    );
    if (!isCellObservationKind(cellKind)) {
      return invalidOperationResponse(
        "Apps Script observation operation",
        "snapshot cell " + fieldName + " kind is unsupported",
      );
    }
    cells[fieldName] = {
      cellKind,
      normalizedCell: decodeNormalizedCell(cell.normalizedCell, fieldName),
    };
  }
  return cells;
}

function decodeNormalizedCell(value: unknown, label: string): NormalizedCell {
  if (value === null) return null;
  const record = requireRecord(value, label + " normalizedCell");
  const kind = requireSyncGatewayText(
    record.kind,
    label + ".kind",
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
  if (kind === NORMALIZED_CELL_KINDS.STRING && typeof record.value === "string") {
    return { kind: NORMALIZED_CELL_KINDS.STRING, value: record.value };
  }
  if (kind === NORMALIZED_CELL_KINDS.NUMBER && typeof record.value === "number" && Number.isFinite(record.value)) {
    return { kind: NORMALIZED_CELL_KINDS.NUMBER, value: record.value };
  }
  if (kind === NORMALIZED_CELL_KINDS.BOOLEAN && typeof record.value === "boolean") {
    return { kind: NORMALIZED_CELL_KINDS.BOOLEAN, value: record.value };
  }
  if (kind === NORMALIZED_CELL_KINDS.DATE && typeof record.value === "string") {
    return { kind: NORMALIZED_CELL_KINDS.DATE, value: record.value };
  }
  return invalidOperationResponse(
    "Apps Script observation operation",
    label + " normalizedCell is invalid",
  );
}

function decodeStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      label + " must be an array",
    );
  }
  const values = value.map((entry, index) =>
    requireSyncGatewayText(
      entry,
      label + "[" + index + "]",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ));
  if (new Set(values).size !== values.length) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      label + " contains a duplicate",
    );
  }
  return values;
}

function isCellObservationKind(value: string): value is CellObservationKind {
  return Object.values(CELL_OBSERVATION_KINDS).includes(value as CellObservationKind);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    return invalidOperationResponse(
      "Apps Script observation operation",
      label + " must be an object",
    );
  }
  return value as Record<string, unknown>;
}
