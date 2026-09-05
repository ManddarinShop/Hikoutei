/**
 * Dispatcher boundary contracts: per-effect results, postcondition probes,
 * and the role interfaces the worker composes into the `Dispatcher`.
 *
 * The worker reasons only about kernel rows and these contracts. It never
 * interprets effect payloads: every payload-derived decision (fast-append
 * candidacy, route keys, evidence validation against the effect target, the
 * User_Input candidate gate) is declared by the dispatcher.
 */

import type {
  NewEffect,
  PendingEffect,
} from "../contract/contracts.js";
import type { FencingContext } from "../outbox/writerLease.js";
import type { Presence } from "../contract/state.js";
import type { ClaimedEffect } from "./contracts.js";
import type { ProviderTiming } from "./pacing/timing.js";

/**
 * Renews the effect leases of one claimed batch.
 *
 * Returns true only when every effect in the batch is still claimed and its
 * lease was extended. A false result means at least one effect could not be
 * renewed (expired or taken over); the caller must abort before any remote
 * request and requeue/recover the batch through the durable outbox.
 */
export type EffectLeaseRenewal = (items: readonly ClaimedEffect[]) => Promise<boolean>;

/** One route-bound batch of pending effects handed to the dispatcher. */
export interface DispatchRequest {
  /** Opaque route identity produced by `Dispatcher.routeKeyFor`. */
  readonly routeKey: string;
  readonly effects: readonly PendingEffect[];
  /**
   * Optional delivery-uncertain recovery effects the worker absorbs into
   * this batch's dispatch (unified read engine Phase 4, design §10.3).
   *
   * These rows are NEVER dispatched/written by this call: the worker claims
   * them as recovery candidates and attaches each same-route group to the
   * first dispatch unit of that route, so the batch's own reads double as
   * the recovery probe's evidence read and the dispatcher returns their
   * classifications in `probeResults` for the worker's unchanged transitions.
   * A dispatcher that does not absorb (older host, fake, or cross-route
   * mismatch) simply returns no `probeResults`, and the worker falls back to
   * the standalone `readPostconditions` probe. The host must pass these
   * effects' payloads to the provider's `probeEffects` request fields and
   * must NOT include them in `effects`.
   */
  readonly probeEffects?: readonly PendingEffect[];
  /**
   * Optional lease-renewal hook the HOST dispatcher must invoke immediately
   * before the provider remote call, after every internal serialization lane
   * and limiter wait the host applies.
   *
   * The worker supplies the hook so the effect lease is renewed as late as
   * possible: queue time on the physical-sheet mutation lane plus shared
   * limiter waits can otherwise outlive a lease refreshed before dispatch
   * starts. The hook is already bound to the request's claimed effects (the
   * host only sees `PendingEffect` rows and cannot renew claims itself). When
   * the hook is present, the host dispatcher must never issue a remote
   * request without first invoking it, and must abort the whole batch with a
   * classified delivery-uncertain/requeue-safe error when it resolves false
   * or throws. Dispatchers that do not perform remote work (fakes, tests)
   * must simply ignore the hook.
   */
  readonly beforeRemoteDispatch?: () => Promise<boolean>;
}

/** Receipt-backed per-effect fast-append outcome. */
export type FastAppendEffectResult =
  | {
      readonly effectId: string;
      readonly status: "applied";
      /** Receipt-backed remote evidence, verified against the effect target. */
      readonly visibleRevision: number;
      readonly visibleHash: string;
      /** Stable per-field hashes used by confirmed projection state. */
      readonly fieldHashes: Readonly<Record<string, string>>;
    }
  | {
      readonly effectId: string;
      readonly status: "applied_target_mismatch";
    }
  | {
      readonly effectId: string;
      readonly status: "delivery_uncertain";
      readonly reason: Presence<string>;
    };

/** Outcome of one dispatcher fast-append call. */
export interface FastAppendOutcome {
  readonly results: readonly FastAppendEffectResult[];
  /** True only when the provider intentionally stopped before the supplied suffix. */
  readonly hasMore: boolean;
  /** Optional phase timing returned by newer provider deployments. */
  readonly timing?: ProviderTiming;
  /**
   * Classifications for the request's absorbed `probeEffects` (one entry per
   * absorbed probe effect the batch could decide), absent when none were
   * carried or absorbed; missing entries keep the worker's standalone-probe
   * fallback.
   */
  readonly probeResults?: readonly PostconditionResult[];
}

/** Per-effect outcome of one regular apply call. */
export type ApplyEffectResult =
  | {
      readonly effectId: string;
      readonly payloadHash: string;
      readonly status: "applied";
      /**
       * Present only after the dispatcher verified the provider's success
       * label against the effect target (postcondition evidence, visible
       * revision/hash, and the target visible hash all agree).
       */
      readonly visibleRevision: number;
      readonly visibleHash: string;
      /** Stable per-field hashes used by confirmed projection state. */
      readonly fieldHashes: Readonly<Record<string, string>>;
    }
  | {
      readonly effectId: string;
      readonly payloadHash: string;
      readonly status: "already_applied";
      readonly visibleRevision: number;
      readonly visibleHash: string;
      readonly fieldHashes: Readonly<Record<string, string>>;
    }
  | {
      readonly effectId: string;
      readonly payloadHash: string;
      readonly status: "superseded";
      readonly reason: Presence<string>;
    }
  | {
      readonly effectId: string;
      readonly payloadHash: string;
      readonly status: "guard_mismatch";
      readonly reason: Presence<string>;
    }
  | {
      readonly effectId: string;
      readonly payloadHash: string;
      readonly status: "schema_error";
      readonly reason: Presence<string>;
    }
  | {
      readonly effectId: string;
      readonly payloadHash: string;
      readonly status: "retryable_error";
      readonly reason: Presence<string>;
    }
  | {
      readonly effectId: string;
      readonly payloadHash: string;
      readonly status: "delivery_uncertain";
      readonly reason: Presence<string>;
    }
  | {
      readonly effectId: string;
      readonly payloadHash: string;
      readonly status: "repair_reobserve";
      readonly reason: Presence<string>;
    };

/** Outcome of one dispatcher apply call. */
export interface ApplyOutcome {
  readonly results: readonly ApplyEffectResult[];
  /** True only when the provider intentionally stopped before the supplied suffix. */
  readonly hasMore: boolean;
  /** Optional phase timing returned by newer provider deployments. */
  readonly timing?: ProviderTiming;
  /**
   * Classifications for the request's absorbed `probeEffects` (see
   * `FastAppendOutcome.probeResults`).
   */
  readonly probeResults?: readonly PostconditionResult[];
}

/**
 * Opaque prepared-apply state returned by `preflight` and consumed by
 * `applyPrepared`.
 *
 * The worker never inspects the value; the host dispatcher owns its concrete
 * shape and narrows it back with its own runtime guard at the
 * `applyPrepared` boundary. Marked nominal so the worker cannot fabricate or
 * cast an unrelated value through the pipeline.
 */
export interface PreparedDispatch {
  readonly __preparedDispatch: "hikoutei/dispatcher/prepared";
}

/** Read-back classification of one response-loss effect after a probe. */
export type Postcondition =
  | {
      readonly disposition: "applied";
      /** Probe evidence verified against the effect target. */
      readonly visibleRevision: number;
      readonly visibleHash: string;
      /** Stable per-field hashes used by confirmed projection state. */
      readonly fieldHashes: Readonly<Record<string, string>>;
    }
  | {
      /** The probe says applied but the visible evidence differs from the target. */
      readonly disposition: "applied_target_mismatch";
    }
  | {
      readonly disposition: "applied_without_visible_state";
    }
  | {
      readonly disposition: "changed";
      readonly reason?: string;
    }
  | {
      readonly disposition: "unapplied";
      readonly reason?: string;
    }
  | {
      readonly disposition: "unavailable";
      readonly reason?: string;
    };

/** One effect identity paired with its read-back result in a recovery batch. */
export interface PostconditionResult {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly postcondition: Postcondition;
}

/** Outcome of one dispatcher postcondition probe batch. */
export interface PostconditionOutcome {
  readonly results: readonly PostconditionResult[];
  /** Optional phase timing returned by newer provider deployments. */
  readonly timing?: ProviderTiming;
}

/** Per-effect candidate-gate decision for one claimed batch. */
export interface CandidateGateResult {
  /** Effect IDs cleared for remote dispatch. */
  readonly allowed: readonly string[];
  /** Effect IDs that must be preserved as blocked_candidate. */
  readonly blocked: readonly string[];
}

/** An effect plus evidence supplied to a writer-owned system-repair replanner. */
export interface RepairReplanRequest {
  readonly effect: PendingEffect;
  readonly providerResult: Presence<ApplyEffectResult>;
  readonly postcondition: Presence<Postcondition>;
}

/** Callback that creates a fresh effect without mutating the old evidence. */
export type RepairReplanFactory = (request: RepairReplanRequest) => Presence<NewEffect>;

/** Fast-append classification and dispatch role of the dispatcher boundary. */
export interface FastAppendDispatcher {
  /**
   * Declares whether one pending effect is eligible for the append-only fast
   * path.
   *
   * No-throw contract: this predicate must never throw and must always return
   * the boolean candidacy as a value. The worker guards the call defensively,
   * but a throwing dispatcher forces the affected effects through the
   * per-effect invalid-payload failure path instead of aborting the pass, so
   * a compliant dispatcher must report every classification as a return
   * value.
   */
  isFastAppendCandidate(effect: PendingEffect): boolean;
  /**
   * Builds the worker-visible grouping key for fast-append effects.
   *
   * Unlike `routeKeyFor` (which distinguishes every physical route so the
   * regular read-ahead pipeline can overlap one route's preflight with another
   * route's write), the fast-append grouping key must keep effects that the
   * provider commits in ONE atomic batch together. A host whose provider
   * appends multiple tabs/spreadsheets atomically (one batchUpdate) returns a
   * spreadsheet-scoped key here so the worker sends the whole multi-route
   * batch in a single `fastAppend` call instead of splitting it per route. An
   * absent declaration falls back to `routeKeyFor`, preserving legacy
   * per-route append grouping for providers that cannot combine routes.
   *
   * No-throw contract, exactly like `routeKeyFor`.
   */
  fastAppendRouteKeyFor?(effect: PendingEffect): string;
  /** Dispatches append-only rows through the idempotent bulk operation. */
  fastAppend(request: DispatchRequest): Promise<FastAppendOutcome>;
  /**
   * Declares the dispatch-priority class of one pending effect.
   *
   * The worker runs READY effects in ascending priority order across both
   * dispatch buckets (fast-append and regular), so a host can keep its
   * critical projection ahead of unrelated work without touching claim
   * windows, leases, fencing, predecessor ordering, the limiter, or bounded
   * fairness. The method is optional: an absent declaration means every
   * effect has priority 0 and the worker keeps the legacy order (all fast
   * append groups before all regular groups).
   *
   * The priority is a payload-derived decision owned by the dispatcher; the
   * worker never interprets effect payloads. Lower numbers run earlier;
   * ties keep the ready-selection order (the sort is stable). No-throw
   * contract: the predicate must never throw and must always return a
   * number as a value; the worker guards the call defensively and degrades
   * a throwing declaration to priority 0 for the affected group.
   */
  dispatchPriorityFor?(effect: PendingEffect): number;
}

/** Route, validation, apply, and postcondition-probe role of the dispatcher. */
export interface EffectDispatcher {
  /**
   * Builds the stable grouping key shared by all dispatcher operations on one
   * route. The value is opaque to the worker.
   *
   * No-throw contract: this predicate must never throw and must always return
   * the route key as a value. The worker guards the call defensively, but a
   * throwing dispatcher forces the affected effects through the per-effect
   * invalid-payload failure path instead of aborting the pass, so a compliant
   * dispatcher must report every classification as a return value.
   */
  routeKeyFor(effect: PendingEffect): string;
  /**
   * Validates the opaque payload of one pending effect. Returns an absent
   * value for a valid payload and the validation message otherwise.
   *
   * No-throw contract: this predicate must never throw and must report an
   * invalid payload as a present validation message. The worker guards the
   * call defensively, but a throwing dispatcher forces the effect through the
   * same per-effect invalid-payload failure path instead of aborting the
   * pass, so a compliant dispatcher must report every validation as a return
   * value.
   */
  payloadValidationError(effect: PendingEffect): Presence<string>;
  /** Dispatches one regular effect batch. */
  apply(request: DispatchRequest): Promise<ApplyOutcome>;
  /**
   * Optional split-dispatch preflight: read+plan stage for one regular batch.
   *
   * Returns an opaque `PreparedDispatch` token that `applyPrepared` later
   * consumes for the write+verify stage. A dispatcher implementing BOTH
   * `preflight` and `applyPrepared` lets the worker overlap one route's
   * preflight (a read) with another route's applyPrepared (write+verify). A
   * dispatcher implementing neither keeps the single legacy `apply` path;
   * implementing only one of the two is invalid and the worker treats it as
   * legacy `apply`. The preflight must NOT perform any remote mutation or
   * effect-lease renewal (renewal stays in `applyPrepared`'s before-remote
   * hook), so it is safe to run while another route writes.
   */
  preflight?(request: DispatchRequest): Promise<PreparedDispatch>;
  /**
   * Optional split-dispatch write+verify stage, consuming `preflight` state.
   *
   * Must honor `DispatchRequest.beforeRemoteDispatch` exactly like `apply`:
   * renew the effect lease immediately before the remote call and abort the
   * whole batch with a classified delivery-uncertain error when the renewal
   * fails. Only present together with `preflight`.
   */
  applyPrepared?(request: DispatchRequest, prepared: PreparedDispatch): Promise<ApplyOutcome>;
  /** Reads back response-loss effects so the worker can settle them safely. */
  readPostconditions(request: DispatchRequest): Promise<PostconditionOutcome>;
}

/** Optional local gate that preserves active human candidates. */
export interface CandidateGateDispatcher {
  /**
   * Optional local gate that preserves active human candidates before remote
   * dispatch. Blocked effect IDs are transitioned to blocked_candidate by the
   * worker.
   */
  gate?(items: readonly ClaimedEffect[]): Promise<CandidateGateResult>;
}

/** Optional dispatch authority claim refreshed before remote dispatch. */
export interface AuthorityDispatcher {
  /**
   * Optional dispatch authority claim refreshed before remote dispatch. When
   * absent the worker assumes dispatch authority is always available.
   */
  ensureAuthority?(
    fence: FencingContext,
    physicalSheetId: string,
    ownerId: string,
  ): Promise<boolean>;
}

/**
 * The dispatcher boundary implemented by the host application.
 *
 * The dispatcher owns every payload-derived decision: route keys, fast-append
 * candidacy, dispatch priority, payload validation, the User_Input candidate
 * gate, remote evidence validation against effect targets, and transport-outcome
 * classification. The worker owns selection, claiming, grouping, fence
 * preparation, transitions, and recovery.
 *
 * The worker supplies `DispatchRequest.beforeRemoteDispatch` so the host can
 * renew effect leases after its own serialization/limiter waits but before
 * the provider remote call. A host dispatcher that performs remote work MUST
 * invoke that hook (when present) immediately before the remote call and
 * abort with a classified delivery-uncertain error when it fails; remote-less
 * dispatchers ignore it.
 *
 * Ready effects run in ascending `dispatchPriorityFor` order across both
 * dispatch buckets (see `FastAppendDispatcher.dispatchPriorityFor`); a
 * dispatcher that omits the declaration keeps the legacy order. The ordering
 * never forces unready predecessors: claiming still enforces the durable
 * per-target predecessor guard, and every claimed group is dispatched in the
 * same pass, so non-priority work cannot starve.
 */
export type Dispatcher =
  FastAppendDispatcher & EffectDispatcher & CandidateGateDispatcher & AuthorityDispatcher;
