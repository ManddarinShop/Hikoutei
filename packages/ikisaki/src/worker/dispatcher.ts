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
} from "../contracts.js";
import type { FencingContext } from "../writerLease.js";
import type { Presence } from "../state.js";
import type { ClaimedEffect } from "./contracts.js";
import type { ProviderTiming } from "./timing.js";

/** One route-bound batch of pending effects handed to the dispatcher. */
export interface DispatchRequest {
  /** Opaque route identity produced by `Dispatcher.routeKeyFor`. */
  readonly routeKey: string;
  readonly effects: readonly PendingEffect[];
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
  /** Dispatches append-only rows through the idempotent bulk operation. */
  fastAppend(request: DispatchRequest): Promise<FastAppendOutcome>;
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
 * candidacy, payload validation, the User_Input candidate gate, remote
 * evidence validation against effect targets, and transport-outcome
 * classification. The worker owns selection, claiming, grouping, lease
 * refresh, transitions, and recovery.
 */
export type Dispatcher =
  FastAppendDispatcher & EffectDispatcher & CandidateGateDispatcher & AuthorityDispatcher;
