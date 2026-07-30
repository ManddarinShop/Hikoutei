/** Adapts the SQLite storage provider to the effect-worker storage contract. */

import { CONFLICT_STATUSES } from "../../../../domain/model/constants.js";
import {
  applyEffectResultWithAdapter,
  claimEffectWithAdapter,
  claimWriterLeaseWithAdapter,
  hasActiveUserInputCandidateWithAdapter,
  recoverExpiredLeasesWithAdapter,
  listReadyEffectsWithAdapter,
  releaseUnprocessedEffectWithAdapter,
  retryClaimedEffectWithAdapter,
  supersedeAndReplanWithAdapter,
} from "../../../../infrastructure/storage/index.js";
import type { SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import { SYNC_GATEWAY_PROJECTIONS } from "../../gateway/constants.js";
import {
  isCandidateProtectingUserInputEffect,
} from "./SyncEffectWorkerRouting.js";
import { isPresent } from "./SyncEffectWorkerHelpers.js";
import type {
  ClaimedEffect,
  EffectWorkerStorage,
} from "./SyncEffectWorkerContracts.js";

/** Creates worker persistence operations backed by one SQLite adapter. */
export function createAdapterEffectWorkerStorage(
  storage: SqlStorageAdapter,
): EffectWorkerStorage {
  return {
    claimWriterLease: (options) => claimWriterLeaseWithAdapter(storage, options),
    recoverExpiredLeases: (fence) => recoverExpiredLeasesWithAdapter(storage, fence),
    listReadyEffects: (limit) => listReadyEffectsWithAdapter(storage, limit),
    claimEffect: (options) => claimEffectWithAdapter(storage, options),
    applyEffectResult: (options) => applyEffectResultWithAdapter(storage, options),
    releaseUnprocessedEffect: (options) => releaseUnprocessedEffectWithAdapter(storage, options),
    retryClaimedEffect: (options) => retryClaimedEffectWithAdapter(storage, options),
    supersedeAndReplan: (fence, oldEffectId, newEffect) => {
      return supersedeAndReplanWithAdapter(storage, fence, oldEffectId, newEffect);
    },
    isUserInputCandidateBlocked: (item: ClaimedEffect) => {
      const effect = item.gatewayEffect;
      if (
        !isPresent(effect) ||
        !isCandidateProtectingUserInputEffect(effect.value) ||
        !isPresent(effect.value.rowBindingId)
      ) {
        return Promise.resolve(false);
      }
      const rowBindingId = effect.value.rowBindingId;
      const fieldNames = Object.keys(effect.value.payload.fields);
      if (fieldNames.length === 0) return Promise.resolve(true);
      return hasActiveUserInputCandidateWithAdapter(storage, {
        physicalSheetId: effect.value.physicalSheetId,
        projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
        rowBindingId: rowBindingId.value,
        fieldNames,
        openConflictStatus: CONFLICT_STATUSES.OPEN,
        rebasedConflictStatus: CONFLICT_STATUSES.NEEDS_REBASE,
      });
    },
  };
}
