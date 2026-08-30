/**
 * User_Input polling supervisor assembly for the internal sync service bootstrap.
 *
 * Builds the adaptive mapped polling pass over the shared SQLite adapter and
 * the coordinated remote provider, owns the metadata-preserving safety full
 * scan cadence (including the reported safety-scan lag), and wraps the pass
 * in the liveness loop. Polling interval, report/error hooks, the injectable
 * clock, and the safety-scan deadline semantics are unchanged from the
 * single-module bootstrap.
 */

import type { SyncServiceStorage } from "./compositionPorts.js";
import type { TypedSheetsEntityMappingRegistry } from "../../orm/mapping/contracts.js";
import type { TypedSheetsEntityWriterOptions } from "@hikoutei/storage/orm/persistence/support/contracts.js";
import type {
  InternalSyncProvider,
  InternalSyncServiceOptions,
} from "./serviceOptions.js";
import type {
  SyncEngineCompositionPorts,
} from "./compositionPorts.js";
import type { MappedUserInputPollingReport } from "@hikoutei/contracts/sheets/userInputPolling.js";
import { SyncPollingSupervisor } from "./SyncPollingSupervisor.js";
import { POLLING_FULL_SCAN_INTERVAL_MS } from "./cadence.js";
import { readSystemStateDrainReadinessWithAdapter } from "@hikoutei/ikisaki";
import {
  describeErrorForInternalLog,
  logHikouteiInternalEvent,
} from "../../shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "../../shared/observability/logEvents.js";

/**
 * SQLite poll cadence for the first-pass System_State drain gate.
 *
 * While the gate is pending the loop performs one cheap outbox read per
 * tick and nothing else; 250 ms keeps the first polling pass starting
 * promptly after the drain without hammering SQLite.
 */
const FIRST_POLLING_PASS_READINESS_POLL_MS = 250;

/** Inputs shared with the composition root's runtime and remote provider. */
export interface CreatePollingSupervisorInput {
  readonly storage: SyncServiceStorage;
  readonly provider: InternalSyncProvider;
  readonly mappings: TypedSheetsEntityMappingRegistry;
  readonly writer: TypedSheetsEntityWriterOptions;
  readonly options: InternalSyncServiceOptions;
  /**
   * P8-C: the concrete MikroORM polling pass is composition-owned wiring;
   * the supervisor invokes it through this port (behavior byte-identical).
   */
  readonly pollMappedUserInput: SyncEngineCompositionPorts["pollMappedUserInput"];
}

export function createPollingSupervisor(
  input: CreatePollingSupervisorInput,
): SyncPollingSupervisor<MappedUserInputPollingReport> {
  const { storage, provider, mappings, writer, options } = input;
  const pollingFullScanIntervalMs = options.pollingFullScanIntervalMs
    ?? POLLING_FULL_SCAN_INTERVAL_MS;
  const clock = options.now ?? Date.now;
  let lastSuccessfulFullScanAt: number | undefined;
  const runPollingPass = async (): Promise<MappedUserInputPollingReport> => {
    const now = clock();
    const safetyFullScan = lastSuccessfulFullScanAt === undefined ||
      now - lastSuccessfulFullScanAt >= pollingFullScanIntervalMs;
    // Safety-scan lag is how far past the configured deadline this pass starts.
    // It is zero before the first completed scan and on adaptive passes, so the
    // report exposes a stable numeric field with a safe default elsewhere.
    const safetyScanLagMs = safetyFullScan && lastSuccessfulFullScanAt !== undefined
      ? Math.max(0, now - lastSuccessfulFullScanAt - pollingFullScanIntervalMs)
      : 0;
    const report = await input.pollMappedUserInput({
      storage,
      provider,
      mappings,
      writer,
      forceFull: safetyFullScan,
      safetyScanLagMs,
      ...(options.onTiming === undefined ? {} : { onTiming: options.onTiming }),
    });
    // Only a completed safety scan advances the deadline. A failing safety scan
    // propagates its original error and leaves lastSuccessfulFullScanAt unchanged.
    if (report.safetyFullScan) lastSuccessfulFullScanAt = clock();
    return report;
  };
  let supervisor: SyncPollingSupervisor<MappedUserInputPollingReport>;
  supervisor = new SyncPollingSupervisor({
    runPass: runPollingPass,
    ...(options.pollingIntervalMs === undefined ? {} : { intervalMs: options.pollingIntervalMs }),
    // First-polling-pass gate: on a cold start the effect worker drains the
    // initial System_State backlog while the first polling pass would
    // otherwise compete with it on the shared request limiter. The loop's
    // FIRST pass therefore waits (SQLite-only checks, stop-interruptible)
    // until no claimable System_State drain work is left; terminal failed
    // or conflict rows — and the pending followers they block — never
    // defer, so a stuck stream cannot stall polling forever. After the
    // first pass the gate is no longer consulted and the normal cadence
    // (interval + safety full scans) is preserved. Manual runOnce() calls
    // are caller-driven and bypass the gate.
    waitForFirstPass: async () => {
      await waitForSystemStateDrainReadiness({
        storage,
        isStopping: () => supervisor.isStopping(),
        pollIntervalMs: FIRST_POLLING_PASS_READINESS_POLL_MS,
      });
    },
    onReport: (report) => {
      // Only passes that observed or changed something emit a summary line;
      // idle scans stay silent so long soak runs do not accumulate noise.
      if (isNotablePollingReport(report)) {
        logHikouteiInternalEvent({
          event: HIKOUTEI_LOG_EVENTS.POLLING_PASS_SUMMARY,
          level: "info",
          component: HIKOUTEI_LOG_COMPONENTS.POLLING,
          durationMs: Math.round(report.elapsedMs),
          counts: {
            rowsScanned: report.rowsScanned,
            changedRows: report.changedRows,
            appliedRows: report.appliedRows,
            conflictRows: report.conflictRows,
            quarantinedRows: report.quarantinedRows,
            duplicateRows: report.duplicateRows,
            staleRows: report.staleRows,
            fencedRows: report.fencedRows,
            invalidRows: report.invalidRows,
            unknownBusinessKeyRows: report.unknownBusinessKeyRows,
            duplicateBusinessKeyRows: report.duplicateBusinessKeyRows,
          },
          retryable: true,
        });
      }
      options.onPollingReport?.(report);
    },
    onError: (error: unknown) => {
      // Polling failures back off and retry inside the supervisor; the log
      // line is the durable record of the pass failure.
      logHikouteiInternalEvent({
        event: HIKOUTEI_LOG_EVENTS.POLLING_PASS_FAILED,
        level: "error",
        component: HIKOUTEI_LOG_COMPONENTS.POLLING,
        ...describeErrorForInternalLog(error),
        retryable: true,
      });
      options.onPollingError?.(error);
    },
  });
  return supervisor;
}

/**
 * Waits (SQLite-only) until no claimable System_State drain work remains.
 *
 * Polls the kernel's System_State drain classification through the shared
 * storage adapter — never the remote provider — until it reports `ready`
 * or until `isStopping()` turns true (the loop's stop() is honored within
 * one poll tick, so shutdown never waits for the drain). Only genuinely
 * claimable System_State work (processing/delivery_uncertain effects and
 * pending claimable heads) defers; terminal failed/conflict rows and the
 * pending followers they block never defer, so a permanently stuck stream
 * cannot stall the first polling pass forever.
 */
export async function waitForSystemStateDrainReadiness(options: {
  readonly storage: SyncServiceStorage;
  readonly isStopping: () => boolean;
  readonly pollIntervalMs?: number;
}): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? FIRST_POLLING_PASS_READINESS_POLL_MS;
  while (!options.isStopping()) {
    const readiness = await readSystemStateDrainReadinessWithAdapter(options.storage);
    if (readiness.status === "ready") return;
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/** True when a polling pass observed or applied something worth logging. */
function isNotablePollingReport(report: MappedUserInputPollingReport): boolean {
  return report.appliedRows > 0 ||
    report.conflictRows > 0 ||
    report.quarantinedRows > 0 ||
    report.duplicateRows > 0 ||
    report.staleRows > 0 ||
    report.fencedRows > 0 ||
    report.invalidRows > 0 ||
    report.unknownBusinessKeyRows > 0 ||
    report.duplicateBusinessKeyRows > 0;
}
