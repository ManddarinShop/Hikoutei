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
  InternalSyncProvider,
  InternalSyncServiceOptions,
} from "./serviceOptions.js";
import {
  MAPPED_USER_INPUT_POLL_MODES,
  pollMappedUserInputWithMikroOrm,
  type MappedUserInputPollingReport,
} from "../../../adapter/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import { SyncPollingSupervisor } from "./SyncPollingSupervisor.js";

const DEFAULT_POLLING_FULL_SCAN_INTERVAL_MS = 60_000;

/** Inputs shared with the composition root's runtime and remote provider. */
export interface CreatePollingSupervisorInput {
  readonly storage: MikroOrmSqliteAdapter;
  readonly provider: InternalSyncProvider;
  readonly mappings: TypedSheetsEntityMappingRegistry;
  readonly writer: TypedSheetsEntityWriterOptions;
  readonly options: InternalSyncServiceOptions;
}

export function createPollingSupervisor(
  input: CreatePollingSupervisorInput,
): SyncPollingSupervisor<MappedUserInputPollingReport> {
  const { storage, provider, mappings, writer, options } = input;
  const pollingFullScanIntervalMs = options.pollingFullScanIntervalMs
    ?? DEFAULT_POLLING_FULL_SCAN_INTERVAL_MS;
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
    const report = await pollMappedUserInputWithMikroOrm({
      storage,
      provider,
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
    return report;
  };
  return new SyncPollingSupervisor({
    runPass: runPollingPass,
    ...(options.pollingIntervalMs === undefined ? {} : { intervalMs: options.pollingIntervalMs }),
    onReport: (report) => options.onPollingReport?.(report),
    ...(options.onPollingError === undefined ? {} : { onError: options.onPollingError }),
  });
}
