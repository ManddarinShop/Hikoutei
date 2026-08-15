import { z } from "zod";

import { formatZodBoundaryIssues } from "../../../../shared/validation/zodBoundary.js";
import {
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS,
  type SyncSheetsGatewayOperation,
} from "./contracts.js";
import {
  SYNC_SHEETS_GATEWAY_ERROR_CODES,
  SyncSheetsGatewayError,
} from "./errors.js";

const nonEmptyGatewayTextSchema = z.string().refine(
  (value) => value.trim().length > 0,
  { message: "must be a non-empty string" },
);

const safeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value),
  { message: "must be a safe integer" },
);

const gatewayOperationSchema = z.enum([
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS.FAST_APPEND_ROWS,
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS.APPLY_EFFECTS,
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_EFFECT_POSTCONDITION,
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_EFFECT_POSTCONDITIONS,
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS.ENSURE_ROW_ANCHORS,
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_SNAPSHOT,
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS.OBSERVE_SNAPSHOT,
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS.OBSERVE_SNAPSHOTS,
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_ROWS,
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS.READ_ROWS_BATCH,
  SYNC_SHEETS_GATEWAY_OPERATION_KINDS.PROVISION_REGISTRY,
]);

const gatewayEnvelopeSchema = z.object({
  protocolVersion: safeIntegerSchema,
  gatewayId: nonEmptyGatewayTextSchema,
  spreadsheetId: nonEmptyGatewayTextSchema,
  leaseEpoch: safeIntegerSchema,
  leaseToken: nonEmptyGatewayTextSchema,
  clientId: nonEmptyGatewayTextSchema,
  requestId: nonEmptyGatewayTextSchema,
  operation: gatewayOperationSchema,
  payload: z.unknown(),
}).strip();

const gatewayObjectPayloadSchema = z.record(z.string(), z.unknown());
const gatewayArrayPayloadSchema = z.array(z.unknown());

type GatewayPayloadShape = "object" | "array";

export interface ParsedGatewayRequestShape {
  readonly protocolVersion: number;
  readonly gatewayId: string;
  readonly spreadsheetId: string;
  readonly leaseEpoch: number;
  readonly leaseToken: string;
  readonly clientId: string;
  readonly requestId: string;
  readonly operation: SyncSheetsGatewayOperation;
  readonly payload: unknown;
}

/** Validates the transport-shaped request before lease and capability checks. */
export function parseGatewayRequestShape(
  value: unknown,
  payloadShape: GatewayPayloadShape,
): ParsedGatewayRequestShape {
  const envelope = gatewayEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new SyncSheetsGatewayError(
      SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
      `gateway request has an invalid shape: ${formatZodBoundaryIssues(envelope.error)}`,
    );
  }

  const payloadSchema = payloadShape === "array"
    ? gatewayArrayPayloadSchema
    : gatewayObjectPayloadSchema;
  const payload = payloadSchema.safeParse(envelope.data.payload);
  if (!payload.success) {
    throw new SyncSheetsGatewayError(
      SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
      `gateway ${envelope.data.operation} payload has the wrong shape`,
    );
  }

  return {
    ...envelope.data,
    payload: payload.data,
  };
}

/** Validates a gateway identity supplied by a client or server constructor. */
export function requireGatewayText(value: unknown, label: string): string {
  const result = nonEmptyGatewayTextSchema.safeParse(value);
  if (!result.success) {
    throw new SyncSheetsGatewayError(
      SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
      `${label} must be a non-empty string`,
    );
  }
  return result.data;
}

/** Validates a positive duration or epoch value at the gateway boundary. */
export function requireGatewayPositiveSafeInteger(value: unknown, label: string): number {
  const result = safeIntegerSchema
    .refine((candidate) => candidate >= 1, { message: "must be positive" })
    .safeParse(value);
  if (!result.success) {
    throw new SyncSheetsGatewayError(
      SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
      `${label} must be a positive safe integer`,
    );
  }
  return result.data;
}
