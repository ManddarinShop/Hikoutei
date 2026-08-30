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

import type { SyncServiceStorage } from "./compositionPorts.js";
import type { TypedSheetsEntityMapping } from "../../orm/mapping/contracts.js";
import type { TypedSheetsEntityWriterOptions } from "../../orm/persistence/support/contracts.js";
import type { InternalSyncServiceOptions } from "./serviceOptions.js";
import type { SyncSheetsProvider } from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  runReconciliationScan,
} from "../outbound/reconciliation/ReconciliationScanner.js";
import { runUserInputCleanupScan } from "../outbound/reconciliation/CleanupScanner.js";
import { SYNC_PROJECTIONS } from "@hikoutei/contracts/sheets/constants.js";
import { GOOGLE_SHEETS_API_DEFAULTS } from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import {
  createEffectWorkerSupervisor,
  APPEND_DISPATCH_THROTTLE_INTERVAL_MS,
  FAST_APPEND_BATCH_CANDIDATE_LIMIT,
  readOutboxScanReadinessWithAdapter,
  type EffectWorkerSupervisor,
  type WorkerReport,
} from "@hikoutei/ikisaki";
import { SheetsEffectDispatcher } from "../outbound/SheetsEffectDispatcher.js";
import type { SyncTimingSink } from "../telemetry/syncTiming.js";
import {
  describeErrorForInternalLog,
  logHikouteiInternalEvent,
  stableConsoleErrorTag,
} from "../../../shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "../../../shared/observability/logEvents.js";
import {
  RECONCILIATION_INITIAL_DELAY_MS,
  RECONCILIATION_SCAN_INTERVAL_MS,
} from "./cadence.js";

/**
 * RECONCILIATION_SCAN_INTERVAL_MS — cadence between System_State reconciliation scans
 * attached to the loop — and RECONCILIATION_INITIAL_DELAY_MS — delay before the FIRST
 * reconciliation scan for the real Google provider — come from `./cadence.js`
 * (single source of application-layer cadence; env-less by design).
 *
 * Why the initial delay exists: a cold-start service opens with the whole initial
 * backlog already in the outbox; an immediate scan would compete with the
 * System_State drain on the shared request-start limiter. Delaying the first scan
 * by one cadence (and additionally gating it on outbox drain readiness, see below)
 * keeps the scanner out of the critical convergence path. Injected test providers
 * keep the generic supervisor default of 0 (immediate first scan).
 */

/** Inputs shared with the composition root's runtime and remote provider. */
export interface CreateEffectSupervisorInput {
  readonly storage: SyncServiceStorage;
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
      intervalMs: options.reconciliationIntervalMs ?? RECONCILIATION_SCAN_INTERVAL_MS,
      // Only the real Google Sheets provider starts with a large initial
      // backlog; delay its first scan by one cadence so it cannot compete
      // with the System_State drain on the shared limiter. Injected test
      // providers keep the generic default (first scan immediately).
      ...(options.googleSheetsApi === undefined
        ? {}
        : { initialReconciliationDelayMs: RECONCILIATION_INITIAL_DELAY_MS }),
      // First-scan gate: defer ONLY while normal claimable drain work is
      // pending/processing/delivery_uncertain. A terminal failed head
      // (repair-needed) must NEVER defer the scanner — the scanner is the
      // repair net that supersedes the failed head, and deferring would
      // wedge the stream forever. After the first scan the gate is no longer
      // consulted, so busy-outbox scans keep the legacy lazy-repair
      // behavior (isOutboxIdle stays omitted by design).
      isFirstScanReady: async () => {
        const readiness = await readOutboxScanReadinessWithAdapter(storage);
        return readiness.status !== "busy";
      },
      // isOutboxIdle is optional on the supervisor contract and the scanner
      // already defers while corrections are in flight, so it is omitted.
      run: runSystemStateReconciliation,
      ...(options.onReconciliationReport === undefined
        ? {}
        : { onReport: (report: { readonly effectsEnqueued: number }) =>
          options.onReconciliationReport!(report) }),
      onError: (error: unknown) => {
        // A scan failure must never stop the effect loop; record it in the
        // internal log first (fail-open), then keep the existing console
        // warning / custom-hook behavior unchanged.
        logHikouteiInternalEvent({
          event: HIKOUTEI_LOG_EVENTS.RECONCILIATION_SCAN_FAILED,
          level: "warn",
          component: HIKOUTEI_LOG_COMPONENTS.RECONCILIATION,
          ...describeErrorForInternalLog(error),
          retryable: true,
        });
        if (options.onReconciliationError !== undefined) {
          options.onReconciliationError(error);
          return;
        }
        // Default console diagnostics emit only the stable allowlisted
        // class/code tag — never the raw message, which can embed provider
        // payload fragments, spreadsheet IDs, emails, or paths. Injected
        // hooks keep receiving the full error unchanged.
        console.warn(
          `[sync-service] system state reconciliation scan failed: ${stableConsoleErrorTag(error)}`,
        );
      },
    },
  });
}

/**
 * Wraps the effect-worker pass hooks with redacted boundary logging.
 *
 * The summary fires only for non-idle passes (claimed work, failures,
 * conflicts, or recoveries) so an idle loop adds no log noise. Custom hooks
 * keep running unchanged after the log write; logging is fail-open and can
 * never alter worker results.
 */
function wrapEffectWorkerHooks(options: InternalSyncServiceOptions): {
  readonly onReport: (report: WorkerReport) => void;
  readonly onError: (error: unknown) => void;
} {
  return {
    onReport: (report: WorkerReport) => {
      if (isNonIdleWorkerReport(report)) {
        logHikouteiInternalEvent({
          event: HIKOUTEI_LOG_EVENTS.OUTBOX_PASS_SUMMARY,
          level: "info",
          component: HIKOUTEI_LOG_COMPONENTS.OUTBOX,
          counts: {
            selected: report.selected,
            claimed: report.claimed,
            applied: report.applied,
            blockedCandidate: report.blockedCandidate,
            superseded: report.superseded,
            conflicted: report.conflicted,
            failed: report.failed,
            deferred: report.deferred,
            requeued: report.requeued,
            replanned: report.replanned,
            responseLossRecovered: report.responseLossRecovered,
            expiredLeasesRecovered: report.expiredLeasesRecovered,
          },
        });
      }
      options.onEffectReport?.(report);
    },
    onError: (error: unknown) => {
      logHikouteiInternalEvent({
        event: HIKOUTEI_LOG_EVENTS.OUTBOX_PASS_FAILED,
        level: "error",
        component: HIKOUTEI_LOG_COMPONENTS.OUTBOX,
        ...describeErrorForInternalLog(error),
      });
      options.onEffectError?.(error);
    },
  };
}

/** True when a pass did work worth one summary line (idling is silent). */
function isNonIdleWorkerReport(report: WorkerReport): boolean {
  return report.selected > 0 ||
    report.claimed > 0 ||
    report.applied > 0 ||
    report.blockedCandidate > 0 ||
    report.superseded > 0 ||
    report.conflicted > 0 ||
    report.failed > 0 ||
    report.deferred > 0 ||
    report.requeued > 0 ||
    report.replanned > 0 ||
    report.responseLossRecovered > 0 ||
    report.expiredLeasesRecovered > 0;
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
  // timeouts and keep the bounded 100-item window with no bulk throttle.
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
    ...wrapEffectWorkerHooks(options),
  };
}
