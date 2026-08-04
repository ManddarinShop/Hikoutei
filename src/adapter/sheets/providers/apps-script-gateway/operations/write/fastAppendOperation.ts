/** Compatibility name for the idempotent built-in Apps Script append operation. */

import type {
  FastAppendRowsRequest,
  FastAppendRowsResult,
} from "../../../../../../application/sync/gateway/syncGateway.js";
import { stableHash } from "../../../../../../domain/index.js";
import { isNormalizedCell } from "../../../../../../shared/encoding/normalizedCell.js";
import { invalidOperationRequest } from "../../errors.js";
import type { AppsScriptOperationDefinition } from "../../transport/operationClient.js";
import {
  createBatchAppendRowsOperation,
  type AppsScriptBatchAppendOperationArgs,
} from "./batchAppendOperation.js";

/** Arguments retained for callers of the historical fast-append name. */
export type AppsScriptFastAppendOperationArgs = AppsScriptBatchAppendOperationArgs;
export type AppsScriptFastAppendOperationRequest = AppsScriptFastAppendOperationArgs;
export type AppsScriptFastAppendOperation = AppsScriptOperationDefinition<
  AppsScriptFastAppendOperationArgs,
  FastAppendRowsResult
>;

/**
 * Builds the current idempotent built-in Apps Script append operation.
 * The old name remains internal compatibility only; transport callers now use
 * createBatchAppendRowsOperation directly.
 *
 * The registered identityField is required: the built-in append path never
 * materializes anchor metadata, so replay locates the target row through the
 * identity column and fails closed when it is missing.
 */
export function createFastAppendRowsOperation(
  request: AppsScriptFastAppendOperationRequest,
): AppsScriptFastAppendOperation {
  // Only the historical builder supplies this compatibility fallback. The
  // worker transport uses createBatchAppendRowsOperation directly and always
  // carries the durable outbox payload hash. Legacy direct callers still get
  // a content-derived hash so changing fields cannot replay an effect ID as
  // if it had the same payload.
  return createBatchAppendRowsOperation({
    ...request,
    rows: request.rows.map((row) => ({
      ...row,
      payloadHash: row.payloadHash ?? legacyPayloadHash(row.fields),
    })),
  });
}

function legacyPayloadHash(fields: FastAppendRowsRequest["rows"][number]["fields"]): string {
  for (const cell of Object.values(fields)) {
    if (!isNormalizedCell(cell)) {
      invalidOperationRequest("batch append operation", "rows contain an invalid normalized cell");
    }
  }
  return stableHash({ fields });
}
