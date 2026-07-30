/**
 * Public mapped persistence orchestration.
 *
 * This module collects entity changes, fences the flush with a writer lease,
 * and delegates each lifecycle operation to the focused persistence helpers.
 */

import { SYNC_TIMING_SCOPES } from "../../../sync/telemetry/syncTiming.js";
import {
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type FencingContext,
} from "../../../../infrastructure/storage/index.js";
import {
  type TypedSheetsFlushContext,
  type TypedSheetsFlushCoordinator,
} from "../../api/contracts.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";
import {
  type CreateMappedTypedSheetsFlushCoordinatorOptions,
} from "../support/contracts.js";
import { applyMappedChange } from "../lifecycle/entityLifecycle.js";
import { resolveTypedSheetsEntityWriterOptions } from "./mappedWriterOptions.js";
import { resolveTypedSheetsEntityMappingRegistry } from "./mappedMappingRegistry.js";
import { collectMappedChanges } from "./mappedChangePlanning.js";
export {
  registerTypedSheetsEntityMappings,
  registeredTypedSheetsProjectionDefinitions,
} from "./mappedProjectionRegistration.js";
import {
  countsForPlans,
  emitTiming,
  operationKindsForCounts,
} from "../support/timing.js";

/**
 * Creates the built-in planner that makes `em.persist()` / `em.flush()` durable
 * in the entity table, canonical state, business-key index, and Sheets outbox
 * together.
 */
export function createMappedTypedSheetsFlushCoordinator(
  options: CreateMappedTypedSheetsFlushCoordinatorOptions,
): TypedSheetsFlushCoordinator {
  const mappings = resolveTypedSheetsEntityMappingRegistry(options.mappings);
  const writer = resolveTypedSheetsEntityWriterOptions(options.writer);

  return {
    async onFlush(context: TypedSheetsFlushContext): Promise<void> {
      const flushStartedAt = Date.now();
      const plans = collectMappedChanges(mappings, context.changes);
      if (plans.length === 0) return;

      const operationCounts = countsForPlans(plans);
      const leaseStartedAt = Date.now();
      const now = writer.now();
      const claim = await context.persistence.claimWriterLease({
        role: writer.role,
        writerId: writer.writerId,
        leaseDurationMs: writer.leaseDurationMs,
        now,
      });
      if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
        throw new TypedSheetsOrmError(
          TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
          `mapped entity writer lease is unavailable: ${claim.reason}.`,
        );
      }
      emitTiming(writer, {
        scope: SYNC_TIMING_SCOPES.ORM_FLUSH,
        phase: "writer_lease_claim",
        durationMs: Date.now() - leaseStartedAt,
        operationKinds: operationKindsForCounts(operationCounts),
        operationCounts,
      });

      const fence: FencingContext = {
        role: claim.lease.role,
        writerEpoch: claim.lease.writerEpoch,
        fencingToken: claim.lease.fencingToken,
        now,
      };
      for (const plan of plans) {
        await applyMappedChange(context.persistence, fence, writer, plan);
      }
      emitTiming(writer, {
        scope: SYNC_TIMING_SCOPES.ORM_FLUSH,
        phase: "flush_total",
        durationMs: Date.now() - flushStartedAt,
        operationKinds: operationKindsForCounts(operationCounts),
        operationCounts,
      });
    },
  };
}

export { resolveTypedSheetsEntityWriterOptions } from "./mappedWriterOptions.js";
