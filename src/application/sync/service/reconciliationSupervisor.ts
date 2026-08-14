/** Independent repair worker for System_State drift and User_Input cleanup. */

import type { MikroOrmSqliteAdapter } from "../../../adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import type { TypedSheetsEntityMapping } from "../../orm/mapping/contracts.js";
import type { TypedSheetsEntityWriterOptions } from "../../orm/persistence/support/contracts.js";
import type { SyncSheetsObservationProvider } from "../sheetsContract/syncSheets.js";
import { SYNC_PROJECTIONS } from "../sheetsContract/constants.js";
import {
  runReconciliationScan,
} from "../outbound/reconciliation/ReconciliationScanner.js";
import { runUserInputCleanupScan } from "../outbound/reconciliation/CleanupScanner.js";
import { safeErrorMessage } from "@hikoutei/ikisaki";
import type { InternalSyncServiceOptions } from "./serviceOptions.js";
import {
  SyncTaskSupervisor,
} from "./SyncTaskSupervisor.js";

const DEFAULT_RECONCILIATION_SCAN_INTERVAL_MS = 60_000;

/** Aggregate report produced by one repair pass. */
export interface ReconciliationWorkerReport {
  readonly effectsEnqueued: number;
}

/** Inputs required to build the independent repair worker. */
export interface CreateReconciliationSupervisorInput {
  readonly storage: MikroOrmSqliteAdapter;
  readonly mappings: readonly TypedSheetsEntityMapping[];
  readonly provider: SyncSheetsObservationProvider;
  readonly writer: TypedSheetsEntityWriterOptions;
  readonly options: InternalSyncServiceOptions;
  /** Prevents User_Input cleanup until the first inbound safety pass settles. */
  readonly isInboundReady?: () => boolean;
  /** Best-effort wake-up for the outbound worker after enqueueing repairs. */
  readonly requestDrain?: () => void;
}

/**
 * Creates the repair worker. Scanners only read Sheets and append correction
 * effects to SQLite; the outbound worker remains the sole Sheet mutator.
 */
export function createReconciliationSupervisor(
  input: CreateReconciliationSupervisorInput,
): SyncTaskSupervisor<ReconciliationWorkerReport> {
  const {
    storage,
    mappings,
    provider,
    writer,
    options,
    isInboundReady,
    requestDrain,
  } = input;
  const runPass = async (): Promise<ReconciliationWorkerReport> => {
    let effectsEnqueued = 0;
    for (const mapping of mappings) {
      const systemStateProjection = mapping.projections.find(
        (projection) => projection.projection === SYNC_PROJECTIONS.SYSTEM_STATE,
      );
      if (systemStateProjection !== undefined) {
        const report = await runReconciliationScan({
          storage,
          provider,
          physicalSheetId: systemStateProjection.physicalSheetId,
          logicalSheetId: mapping.logicalSheetId,
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
      }

      // User_Input cleanup can rewrite a row from canonical state. Delay it
      // until inbound has completed its first full observation, otherwise a
      // startup cleanup could overwrite a human edit before it becomes a
      // durable candidate/conflict.
      if (isInboundReady !== undefined && !isInboundReady()) continue;
      const userInputProjection = mapping.projections.find(
        (projection) => projection.projection === SYNC_PROJECTIONS.USER_INPUT,
      );
      if (userInputProjection === undefined) continue;
      const cleanupReport = await runUserInputCleanupScan({
        storage,
        provider,
        physicalSheetId: userInputProjection.physicalSheetId,
        logicalSheetId: mapping.logicalSheetId,
        identityField: mapping.businessKey.fieldName,
        schemaVersion: mapping.schemaVersion,
        writerId: writer.writerId,
        now: options.now ?? Date.now,
      });
      effectsEnqueued += cleanupReport.effectsEnqueued;
    }
    const report = { effectsEnqueued } satisfies ReconciliationWorkerReport;
    if (effectsEnqueued > 0) {
      // The durable outbox is the correctness boundary. This wake-up only
      // avoids waiting for the outbound idle interval and is safe to lose.
      try {
        requestDrain?.();
      } catch {
        // A trigger failure cannot invalidate effects already committed to SQL.
      }
    }
    return report;
  };

  return new SyncTaskSupervisor({
    name: "reconciliation",
    runPass,
    intervalMs: options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_SCAN_INTERVAL_MS,
    onReport: (report) => options.onReconciliationReport?.(report),
    onError: options.onReconciliationError ?? ((error: unknown) => {
      console.warn(
        `[sync-service] system state reconciliation scan failed: ${safeErrorMessage(error)}`,
      );
    }),
  });
}
