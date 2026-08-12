/**
 * Outbound effect supervisor assembly for the internal sync service bootstrap.
 *
 * Builds the durable effect worker supervisor over the shared SQLite adapter
 * and the coordinated remote provider, and attaches the periodic System_State
 * reconciliation (plus User_Input cleanup) scan as the supervisor's lazy
 * repair net. Worker knobs, report/error hooks, reconciliation cadence, and
 * the fail-open scan error logging are unchanged from the single-module
 * bootstrap.
 */

import type { MikroOrmSqliteAdapter } from "../../../adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import type { TypedSheetsEntityMapping } from "../../orm/mapping/contracts.js";
import type { TypedSheetsEntityWriterOptions } from "../../orm/persistence/support/contracts.js";
import type { InternalSyncServiceOptions } from "./serviceOptions.js";
import type { SyncSheetsProvider } from "../sheetsContract/syncSheets.js";
import {
  runReconciliationScan,
} from "../outbound/reconciliation/ReconciliationScanner.js";
import { runUserInputCleanupScan } from "../outbound/reconciliation/CleanupScanner.js";
import { SYNC_PROJECTIONS } from "../sheetsContract/constants.js";
import { GOOGLE_SHEETS_API_DEFAULTS } from "../../../adapter/sheets/providers/google-sheets-api/constants.js";
import {
  createEffectWorkerSupervisor,
  APPEND_DISPATCH_THROTTLE_INTERVAL_MS,
  FAST_APPEND_BATCH_CANDIDATE_LIMIT,
  safeErrorMessage,
  type EffectWorkerSupervisor,
  type WorkerReport,
} from "@hikoutei/ikisaki";
import { SheetsEffectDispatcher } from "../outbound/SheetsEffectDispatcher.js";
import type { SyncTimingSink } from "../telemetry/syncTiming.js";

/** Minimum delay between System_State reconciliation scans attached to the loop. */
const DEFAULT_RECONCILIATION_SCAN_INTERVAL_MS = 60_000;

/** Inputs shared with the composition root's runtime and remote provider. */
export interface CreateEffectSupervisorInput {
  readonly storage: MikroOrmSqliteAdapter;
  readonly mappings: readonly TypedSheetsEntityMapping[];
  readonly provider: SyncSheetsProvider;
  readonly writer: TypedSheetsEntityWriterOptions;
  readonly effectWorkerId: string;
  readonly options: InternalSyncServiceOptions;
}

export function createEffectSupervisor(
  input: CreateEffectSupervisorInput,
): EffectWorkerSupervisor {
  const { storage, mappings, provider, writer, effectWorkerId, options } = input;

  // Periodic System_State reconciliation is a lazy repair net, not part of
  // the normal write path: one scan per system_state projection reads a
  // provider snapshot, compares it against canonical SQLite state, and
  // enqueues normal system_projection corrections on the durable outbox for
  // the effect worker to apply through the same CAS-guarded slow path. The
  // scanner never writes to the Sheet; it only feeds the existing outbox.
  // The User_Input cleanup scan runs on the same schedule for tabs that
  // register a user_input projection, removing surplus rows (duplicated
  // business keys, empty-ID rows, unambiguous orphans) through the same
  // CAS-carrying user_input_delete effects.
  const runSystemStateReconciliation = async (): Promise<{ readonly effectsEnqueued: number }> => {
    let effectsEnqueued = 0;
    for (const mapping of mappings) {
      const systemStateProjection = mapping.projections.find(
        (projection) => projection.projection === SYNC_PROJECTIONS.SYSTEM_STATE,
      );
      if (systemStateProjection === undefined) continue;
      const report = await runReconciliationScan({
        storage,
        provider,
        physicalSheetId: systemStateProjection.physicalSheetId,
        logicalSheetId: mapping.logicalSheetId,
        // The scanner compares exactly the System_State headers: every
        // canonical field plus the soft-delete tombstone column.
        systemFields: [
          ...mapping.fields.map((field) => field.fieldName),
          mapping.tombstoneFieldName,
        ],
        tombstoneField: mapping.tombstoneFieldName,
        schemaVersion: mapping.schemaVersion,
        writerId: writer.writerId,
        now: options.now ?? Date.now,
      });
      effectsEnqueued += report.effectsEnqueued;
      const userInputProjection = mapping.projections.find(
        (projection) => projection.projection === SYNC_PROJECTIONS.USER_INPUT,
      );
      if (userInputProjection === undefined) continue;
      const cleanupReport = await runUserInputCleanupScan({
        storage,
        provider,
        physicalSheetId: userInputProjection.physicalSheetId,
        logicalSheetId: mapping.logicalSheetId,
        // The business key is the identity column the polling pipeline uses
        // to match User_Input rows to bindings.
        identityField: mapping.businessKey.fieldName,
        schemaVersion: mapping.schemaVersion,
        writerId: writer.writerId,
        now: options.now ?? Date.now,
      });
      effectsEnqueued += cleanupReport.effectsEnqueued;
    }
    return { effectsEnqueued };
  };

  return createEffectWorkerSupervisor({
    storage,
    dispatcher: new SheetsEffectDispatcher({
      provider,
      storage,
    }),
    ...optionalWorkerOptions(options),
    workerId: effectWorkerId,
    reconciliation: {
      intervalMs: options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_SCAN_INTERVAL_MS,
      // isOutboxIdle is optional on the supervisor contract and the scanner
      // already defers while corrections are in flight, so it is omitted.
      run: runSystemStateReconciliation,
      ...(options.onReconciliationReport === undefined
        ? {}
        : { onReport: (report: { readonly effectsEnqueued: number }) =>
          options.onReconciliationReport!(report) }),
      onError: options.onReconciliationError ??
        ((error: unknown) => {
          // A scan failure must never stop the effect loop; classify and log
          // it exactly like the graceful-shutdown lease warnings.
          console.warn(
            `[sync-service] system state reconciliation scan failed: ${safeErrorMessage(error)}`,
          );
        }),
    },
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
