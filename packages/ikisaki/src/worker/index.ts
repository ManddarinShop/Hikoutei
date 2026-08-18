/**
 * @hikoutei/ikisaki worker — the generic effect delivery worker.
 *
 * The worker owns selection, claiming, grouping, lease refresh, transitions,
 * and recovery against the kernel. It knows nothing about effect payloads:
 * the host application implements the `Dispatcher` boundary to supply remote
 * operations, payload-derived decisions (route keys, fast-append candidacy,
 * payload validation, candidate gating, evidence verification), and transport
 * classification.
 */

export {
  ADAPTIVE_EFFECT_BATCH_LIMITS,
  AdaptiveEffectBatchController,
  DEFAULT_EFFECT_BATCH_COALESCE_WINDOW_MS,
  EFFECT_BATCH_GROWTH_STEP,
  EFFECT_BATCH_HIGH_LATENCY_THRESHOLD_MS,
  EFFECT_BATCH_STABLE_SUCCESSES_TO_GROW,
  type AdaptiveEffectBatchObservation,
} from "./batch.js";

export {
  APPEND_DISPATCH_THROTTLE_INTERVAL_MS,
  DEFAULT_EFFECT_LEASE_DURATION_MS,
  DEFAULT_WORKER_ROLE,
  DEFAULT_WRITER_LEASE_DURATION_MS,
  EFFECT_BATCH_LIMIT,
  EFFECT_LEASE_PROVIDER_HEADROOM_MS,
  FAST_APPEND_BATCH_CANDIDATE_LIMIT,
  MAX_IN_FLIGHT_EFFECTS,
  OUTBOX_EFFECT_STATUSES,
  WORKER_ERROR_CODES,
  type WorkerErrorCode,
} from "./constants.js";

export {
  TIMING_OPERATION_KINDS,
  TIMING_SCOPES,
  type ProviderTiming,
  type ProviderTimingPhase,
  type TimingEvent,
  type TimingOperationCounts,
  type TimingOperationKind,
  type TimingScope,
  type TimingSink,
} from "./timing.js";

export type {
  ApplyEffectResult,
  ApplyOutcome,
  CandidateGateResult,
  Dispatcher,
  DispatchRequest,
  EffectLeaseRenewal,
  FastAppendEffectResult,
  FastAppendOutcome,
  Postcondition,
  PostconditionOutcome,
  PostconditionResult,
  RepairReplanFactory,
  RepairReplanRequest,
} from "./dispatcher.js";

export type {
  AdaptiveEffectBatchControllerLike,
  EffectWorkerBaseOptions,
  EffectWorkerWithAdapterOptions,
} from "./options.js";

export type { ClaimedEffect } from "./contracts.js";

export type { EffectWorkerStorage } from "./storage.js";

export type {
  MutableReport,
  WorkerReport,
} from "./report.js";

export {
  DISPATCH_TRANSPORT_OUTCOME_KINDS,
  DispatchTransportError,
  isDispatchTransportError,
  type DispatchTransportOutcome,
  type DispatchTransportOutcomeKind,
} from "./errors.js";

export {
  absentValue,
  applicabilityFromSqlNullable,
  isAbsent,
  isPresent,
  lookupResult,
  presentValue,
  safeErrorMessage,
  throwWorkerError,
  type PresentValue,
} from "./helpers.js";

export {
  chunkEffectGroups,
  fenceFromLease,
  groupEffectsByRoute,
  isCandidateProtectingUserInputEffect,
  isFastAppendPendingEffect,
  type EffectRouteGroup,
} from "./routing.js";

export {
  countsForItems,
  countsForOperationKinds,
  countsForPendingEffects,
  emptyOperationCounts,
  emitProviderTiming,
  emitWorkerTiming,
  operationKindsForCounts,
  operationKindsForItems,
  operationKindsForPendingEffects,
  timingOperationKindForPending,
} from "./timing.js";

export {
  completeApplied,
  completeFailure,
  completeProviderResult,
  recoverUnknownResults,
  replanOrFail,
  settleUnknownPostcondition,
} from "./transitions.js";

export {
  dispatchFastAppendGroup,
  handleProviderDispatchError,
  requeueFastAppendItems,
} from "./dispatch.js";

export {
  runEffectWorkerWithAdapter,
} from "./worker.js";

export {
  createEffectWorkerSupervisor,
  EffectWorkerSupervisor,
  type CreateEffectWorkerSupervisorOptions,
  type EffectWorkerSupervisorLoopOptions,
  type EffectWorkerSupervisorReconciliationOptions,
  type EffectWorkerSupervisorWait,
  type WorkerReconciliationReport,
} from "./supervisor.js";
