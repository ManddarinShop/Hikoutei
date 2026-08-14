/**
 * Outbound effect supervisor assembly for the internal sync service bootstrap.
 *
 * Builds the outbound-only durable effect worker supervisor over the shared
 * SQLite adapter and the effect capability of the coordinated remote
 * provider. Repair scheduling is owned by reconciliationSupervisor.ts; this
 * module never reads snapshots or table values.
 */

import type { MikroOrmSqliteAdapter } from "../../../adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import type { InternalSyncServiceOptions } from "./serviceOptions.js";
import type { SyncEffectWorkerProvider } from "../sheetsContract/syncSheets.js";
import { GOOGLE_SHEETS_API_DEFAULTS } from "../../../adapter/sheets/providers/google-sheets-api/constants.js";
import {
  createEffectWorkerSupervisor,
  APPEND_DISPATCH_THROTTLE_INTERVAL_MS,
  FAST_APPEND_BATCH_CANDIDATE_LIMIT,
  type EffectWorkerSupervisor,
  type WorkerReport,
} from "@hikoutei/ikisaki";
import { SheetsEffectDispatcher } from "../outbound/SheetsEffectDispatcher.js";
import type { SyncTimingSink } from "../telemetry/syncTiming.js";

/** Inputs shared with the composition root's runtime and remote provider. */
export interface CreateEffectSupervisorInput {
  readonly storage: MikroOrmSqliteAdapter;
  readonly provider: SyncEffectWorkerProvider;
  readonly effectWorkerId: string;
  readonly options: InternalSyncServiceOptions;
}

export function createEffectSupervisor(
  input: CreateEffectSupervisorInput,
): EffectWorkerSupervisor {
  const { storage, provider, effectWorkerId, options } = input;

  return createEffectWorkerSupervisor({
    storage,
    dispatcher: new SheetsEffectDispatcher({
      provider,
      storage,
    }),
    ...optionalWorkerOptions(options),
    workerId: effectWorkerId,
  });
}

function optionalWorkerOptions(options: InternalSyncServiceOptions): {
  readonly workerId?: string;
  readonly maxEffects?: number;
  readonly effectLeaseDurationMs?: number;
  readonly requestTimeoutMs?: number;
  readonly idleIntervalMs?: number;
  readonly maxFastAppendCandidates?: number;
  readonly appendDispatchIntervalMs?: number;
  readonly onTiming?: SyncTimingSink;
  readonly onReport?: (report: WorkerReport) => void;
  readonly onError?: (error: unknown) => void;
} {
  // The knobs are tied to the ACTIVE provider: the full direct Google
  // provider's timeouts (its defaults when omitted). The worker provider
  // timeout bounds the WHOLE sequential dispatch (two preflight reads plus
  // one write), so it sums the write timeout and two read timeouts instead
  // of the single write timeout. Injected test providers carry no transport
  // timeouts and keep the bounded 20-item window with no bulk throttle.
  const outboundTimeoutMs = options.googleSheetsApi === undefined
    ? undefined
    : (options.googleSheetsApi.requestTimeoutMs ?? GOOGLE_SHEETS_API_DEFAULTS.REQUEST_TIMEOUT_MS) +
      2 * (options.googleSheetsApi.readTimeoutMs ?? GOOGLE_SHEETS_API_DEFAULTS.READ_TIMEOUT_MS);
  return {
    ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    ...(options.maxEffects === undefined ? {} : { maxEffects: options.maxEffects }),
    ...(options.effectLeaseDurationMs === undefined ? {} : { effectLeaseDurationMs: options.effectLeaseDurationMs }),
    ...(outboundTimeoutMs === undefined ? {} : { requestTimeoutMs: outboundTimeoutMs }),
    ...(options.effectIdleIntervalMs === undefined ? {} : { idleIntervalMs: options.effectIdleIntervalMs }),
    // The bulk append claim window and the append dispatch throttle belong to
    // the real Google Sheets API provider.
    ...(options.googleSheetsApi === undefined
      ? {}
      : {
        maxFastAppendCandidates: FAST_APPEND_BATCH_CANDIDATE_LIMIT,
        appendDispatchIntervalMs: APPEND_DISPATCH_THROTTLE_INTERVAL_MS,
      }),
    ...(options.onTiming === undefined ? {} : { onTiming: options.onTiming }),
    ...(options.onEffectReport === undefined ? {} : { onReport: options.onEffectReport }),
    ...(options.onEffectError === undefined ? {} : { onError: options.onEffectError }),
  };
}
