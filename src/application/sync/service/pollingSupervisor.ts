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

import type { MikroOrmSqliteAdapter } from "../../../adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import type { TypedSheetsEntityMappingRegistry } from "../../orm/mapping/contracts.js";
import type { TypedSheetsEntityWriterOptions } from "../../orm/persistence/support/contracts.js";
import type {
  InternalSyncServiceOptions,
} from "./serviceOptions.js";
import {
  MAPPED_USER_INPUT_POLL_MODES,
  type MappedUserInputPollingReport,
  type PollMappedUserInputWithMikroOrmOptions,
} from "../../../adapter/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import { SyncPollingSupervisor } from "./SyncPollingSupervisor.js";
import type {
  SyncSheetsObservationProvider,
  SyncSheetsTableReader,
} from "../sheetsContract/syncSheets.js";

const DEFAULT_POLLING_FULL_SCAN_INTERVAL_MS = 60_000;

/** Narrow task port implemented by the MikroORM inbound adapter. */
export type MappedUserInputObservationTask = (
  options: PollMappedUserInputWithMikroOrmOptions,
) => Promise<MappedUserInputPollingReport>;

/** Inputs shared with the composition root's runtime and remote provider. */
export interface CreatePollingSupervisorInput {
  readonly storage: MikroOrmSqliteAdapter;
  readonly provider: SyncSheetsObservationProvider;
  readonly tableReader: SyncSheetsTableReader;
  readonly mappings: TypedSheetsEntityMappingRegistry;
  readonly writer: TypedSheetsEntityWriterOptions;
  readonly options: InternalSyncServiceOptions;
  readonly runObservation: MappedUserInputObservationTask;
  /** Called after the first successful safety observation pass. */
  readonly onReady?: () => void;
}

export function createPollingSupervisor(
  input: CreatePollingSupervisorInput,
): SyncPollingSupervisor<MappedUserInputPollingReport> {
  const {
    storage,
    provider,
    tableReader,
    mappings,
    writer,
    options,
    runObservation,
  } = input;
  const pollingFullScanIntervalMs = options.pollingFullScanIntervalMs
    ?? DEFAULT_POLLING_FULL_SCAN_INTERVAL_MS;
  const clock = options.now ?? Date.now;
  let lastSuccessfulFullScanAt: number | undefined;
  let readyNotified = false;
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
    const report = await runObservation({
      storage,
      provider,
      tableReader,
      mappings,
      writer,
      mode: MAPPED_USER_INPUT_POLL_MODES.ADAPTIVE,
      forceFull: safetyFullScan,
      safetyScanLagMs,
      ...(options.onTiming === undefined ? {} : { onTiming: options.onTiming }),
    });
    // Only a completed safety scan advances the deadline. A failing safety scan
    // propagates its original error and leaves lastSuccessfulFullScanAt unchanged.
    if (report.safetyFullScan) lastSuccessfulFullScanAt = clock();
    if (!readyNotified) {
      readyNotified = true;
      try {
        input.onReady?.();
      } catch {
        // Readiness notification is an optimization/scheduling hook only.
      }
    }
    return report;
  };
  return new SyncPollingSupervisor({
    runPass: runPollingPass,
    ...(options.pollingIntervalMs === undefined ? {} : { intervalMs: options.pollingIntervalMs }),
    onReport: (report) => options.onPollingReport?.(report),
    ...(options.onPollingError === undefined ? {} : { onError: options.onPollingError }),
  });
}
