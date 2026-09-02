/**
 * Graceful shutdown and lease release for the internal sync service bootstrap.
 *
 * Owns the stop/retry semantics (stop inbound reads first, then the outbound
 * worker, ALWAYS expire this runtime's own leases, keep stop() retryable when
 * a supervisor stop fails) and the CAS-guarded, warn-and-continue lease
 * releases mirrored from every claim site wired into the bootstrap.
 */

import {
  DEFAULT_MAPPED_WRITER_ROLE,
  type TypedSheetsEntityWriterOptions,
} from "@hikoutei/storage/orm/persistence/support/contracts.js";
import type { SyncServiceStorage } from "./compositionPorts.js";
import {
  DEFAULT_WORKER_ROLE,
  LOOKUP_RESULT_KINDS,
  readWriterLeaseWithAdapter,
  releaseWriterLeaseWithAdapter,
  type EffectWorkerSupervisor,
  type WriterLeaseHeartbeatHandle,
} from "@hikoutei/ikisaki";
import { RECONCILIATION_DEFAULTS } from "../outbound/reconciliation/ReconciliationScanner.js";
import { stableConsoleErrorTag } from "../../shared/observability/internalLog.js";
import type { MappedUserInputPollingReport } from "@hikoutei/contracts/sheets/userInputPolling.js";
import type { SyncPollingSupervisor } from "./SyncPollingSupervisor.js";

/**
 * Expires this runtime's own writer leases on graceful shutdown.
 *
 * Each release is CAS-guarded on the exact lease row this runtime holds
 * (role, writer id, epoch, fencing token), so a concurrent takeover or a
 * previously crashed runtime's stale row is never expired. The observation
 * poller and the auto conflict resolver claim under the mapped writer role
 * with the same writer id, so the single mapped-role release covers them.
 * A failing release only logs a classified warning and never aborts stop().
 */
export async function expireRuntimeWriterLeases(
  storage: SyncServiceStorage,
  writer: TypedSheetsEntityWriterOptions,
  effectWorkerId: string,
): Promise<void> {
  const now = writer.now?.() ?? Date.now();
  // Every claim site wired into the bootstrap must be mirrored here:
  // conflict route registration (registerSyncConflictProjectionRoutes), mapped
  // flush planning and projection registration (flushCoordinator), observation
  // polling with deferred-conflict retry (MikroOrmUserInputPolling), and System_State reconciliation
  // (ReconciliationScanner) claim under the mapped writer role (or the
  // dedicated reconciler role) with writer.writerId; the effect worker
  // supervisor claims under DEFAULT_WORKER_ROLE with effectWorkerId. A claim
  // added elsewhere must be added to this list, or graceful close leaves it
  // leased for the window.
  const ownLeases: ReadonlyArray<{ readonly role: string; readonly writerId: string }> = [
    { role: DEFAULT_MAPPED_WRITER_ROLE, writerId: writer.writerId },
    { role: DEFAULT_WORKER_ROLE, writerId: effectWorkerId },
    // The reconciliation scanner claims under the dedicated reconciler role
    // with the mapped writer id; mirror that claim site here so a graceful
    // close does not leave it leased for the full scan window.
    { role: RECONCILIATION_DEFAULTS.ROLE, writerId: writer.writerId },
  ];
  for (const { role, writerId } of ownLeases) {
    try {
      const found = await readWriterLeaseWithAdapter(storage, role);
      if (found.kind !== LOOKUP_RESULT_KINDS.FOUND || found.value.writerId !== writerId) {
        // No row, or the lease was already taken over by a newer writer:
        // nothing this runtime owns to expire.
        continue;
      }
      const released = await releaseWriterLeaseWithAdapter(storage, {
        role,
        writerId,
        writerEpoch: found.value.writerEpoch,
        fencingToken: found.value.fencingToken,
        now,
      });
      if (!released) {
        console.warn(
          `[sync-service] writer lease for role "${role}" changed ownership during shutdown; skipping release.`,
        );
      }
    } catch (error: unknown) {
      // Default console diagnostics emit only the stable allowlisted
      // class/code tag — never the raw message, which can embed provider
      // payload fragments, spreadsheet IDs, emails, or paths.
      console.warn(
        `[sync-service] writer lease release failed for role "${role}": ${stableConsoleErrorTag(error)}`,
      );
    }
  }
}

/** Inputs shared with the composition root's supervisors. */
export interface CreateStopHandlerInput {
  readonly storage: SyncServiceStorage;
  readonly writer: TypedSheetsEntityWriterOptions;
  readonly effectWorkerId: string;
  readonly pollingSupervisor: SyncPollingSupervisor<MappedUserInputPollingReport>;
  readonly effectSupervisor: EffectWorkerSupervisor;
  /** Renew-only entity-writer lease heartbeat; stopped FIRST so shutdown stops renewing. */
  readonly entityWriterLeaseHeartbeat?: WriterLeaseHeartbeatHandle;
}

/**
 * Builds the idempotent, retryable stop handler for one internal service.
 *
 * Stops inbound reads first, then the outbound worker, and ALWAYS expires
 * this runtime's own leases even when a supervisor stop fails, so a restart
 * inside the lease window never fails with WRITER_LEASE_UNAVAILABLE. A
 * failing release only logs and never masks the supervisor error. `stopped`
 * still flips only when both supervisor stops complete, so a rejected stop
 * leaves a retryable close() that re-runs the stops and the release.
 */
export function createStopHandler(input: CreateStopHandlerInput): () => Promise<void> {
  const { storage, writer, effectWorkerId, pollingSupervisor, effectSupervisor, entityWriterLeaseHeartbeat } = input;

  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (stopPromise !== undefined) return stopPromise;
    // Stop inbound reads first, then the outbound worker. Both supervisors
    // drain manual and background passes before SQLite is closed.
    stopPromise = (async () => {
      try {
        // The heartbeat must stop renewing BEFORE the supervisors stop and
        // the leases expire, so graceful shutdown hands the lease over at
        // once instead of renewing it underneath the release path.
        await entityWriterLeaseHeartbeat?.stop();
        await pollingSupervisor.stop();
        await effectSupervisor.stop();
      } finally {
        // Graceful-shutdown handoff: expire this runtime's own leases so the
        // next runtime on the same SQLite file claims immediately through the
        // TAKEOVER path. Abnormal exits keep the full lease window, and the
        // row is never deleted so authority epoch ordering stays monotonic.
        // The release ALWAYS runs, even when a supervisor stop fails, so a
        // restart inside the lease window never fails with
        // WRITER_LEASE_UNAVAILABLE; a failing release only logs and never
        // masks the supervisor error. `stopped` still flips only when both
        // supervisor stops complete, so a rejected stop leaves a retryable
        // close() that re-runs the stops and the release.
        await expireRuntimeWriterLeases(storage, writer, effectWorkerId)
          .catch(() => undefined);
      }
      stopped = true;
      stopPromise = undefined;
    })().catch((error: unknown) => {
      stopPromise = undefined;
      throw error;
    });
    return stopPromise;
  };
  return stop;
}
