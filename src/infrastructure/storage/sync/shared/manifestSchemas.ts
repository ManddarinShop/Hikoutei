import { z } from "zod";

import { REGISTERED_PROJECTION_KINDS } from "../../../../domain/model/constants.js";

/** Opaque ownership metadata persisted for worker-facing manifest reads. */
export const syncOwnershipManifestSchema = z.record(z.string(), z.unknown());

/** Ordered physical projection headers stored beside a registry route. */
export const syncProjectionHeadersSchema = z.array(z.string().min(1));

/** Projection headers used when a new registration must contain a column. */
export const nonEmptySyncProjectionHeadersSchema = syncProjectionHeadersSchema.min(1);

/** Registered projection labels accepted by the SQLite sync registry. */
export const registeredProjectionSchema = z.enum([
  REGISTERED_PROJECTION_KINDS.USER_INPUT,
  REGISTERED_PROJECTION_KINDS.SYSTEM_STATE,
  REGISTERED_PROJECTION_KINDS.SYNC_CONFLICTS,
]);

/** Anchor modes retained by the persisted registry compatibility contract. */
export const syncAnchorModeSchema = z.enum([
  "business_key",
  "developer_metadata",
]);

/** Positive safe integer used by persisted sync registration metadata. */
export const positiveSyncSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 1,
  { message: "must be a positive safe integer" },
);

/** Non-empty persisted identifier or route text. */
export const nonEmptySyncTextSchema = z.string().min(1);
