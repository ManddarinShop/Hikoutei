/**
 * Contracts shared by the durable observation writer modules.
 *
 * The input is already normalized and evaluated by pure core. Storage owns
 * only idempotent receipts, canonical commits, conflict records, and effects.
 */

import type {
  EditorActorSource,
  ObservedEditBatch,
  Applicability,
  Presence,
  RowBindingState,
  RowEvaluationResult,
  ConflictStatus,
  RowOutcome,
} from "../../../../domain/index.js";
import { ROW_OUTCOMES } from "../../../../domain/evaluate/constants.js";
import { CANONICAL_COMMIT_RESULT_KINDS } from "../canonical/canonicalCommit.js";
import type { CanonicalCommitInput, CanonicalCommitResult } from "../canonical/canonicalCommit.js";
import type { NewEffect } from "@hikoutei/ikisaki";
import { OBSERVATION_WRITE_RESULT_KINDS } from "./observationConstants.js";
import type {
  ObservationDuplicateReason,
  ObservationAppendResultKind,
  ObservationReceiptState,
} from "./observationConstants.js";

/** One append-only occurrence captured by a provider or polling adapter. */
export interface ObservationAttemptInput {
  readonly observationId: string;
  readonly observationKey: string;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly detectedAt: number;
  readonly receivedAt: number;
  readonly ingressActorId: string;
  /** Editor identity is absent when the provider cannot verify one. */
  readonly editorActorId: Presence<string>;
  readonly editorActorSource: EditorActorSource;
}

/** Event identity computed after observation identity resolution. */
export interface EventIdentityInput {
  readonly eventKey: string;
  readonly payloadHash: string;
}

/** One active unique-key change that must commit with canonical state. */
export interface BusinessKeyChange {
  readonly fieldName: string;
  readonly previousNormalizedKey: Presence<string>;
  readonly nextNormalizedKey: Presence<string>;
}

/** Canonical mutation and key claims committed in the same writer transaction. */
export interface CanonicalRowMutation {
  readonly commitId: string;
  readonly commit: CanonicalCommitInput;
  readonly businessKeyChanges: readonly BusinessKeyChange[];
}

/** Remote visible-state evidence captured with one observed row. */
export const OBSERVED_PROJECTION_EVIDENCE_SOURCES = {
  REMOTE: "remote",
  SYNTHETIC: "synthetic",
} as const;

export type ObservedProjectionEvidenceSource =
  (typeof OBSERVED_PROJECTION_EVIDENCE_SOURCES)[keyof typeof OBSERVED_PROJECTION_EVIDENCE_SOURCES];

export interface ObservedProjectionBaseline {
  readonly visibleRevision: number;
  readonly visibleHash: string;
}

export interface ObservedProjectionEvidence {
  /** Remote row revision, or the next monotonic local revision when unavailable. */
  readonly visibleRevision: number;
  /** Stable hash of the complete visible row returned by the provider. */
  readonly visibleHash: string;
  /** Legacy callers omit this and retain the original monotonic behavior. */
  readonly source?: ObservedProjectionEvidenceSource;
  /** Exact prior baseline required before accepting synthetic evidence. */
  readonly baseline?: ObservedProjectionBaseline;
}

/** Input for exactly one row of an observed batch. */
export interface PersistObservedRowInput {
  readonly physicalSheetId: string;
  readonly batch: ObservedEditBatch;
  /** Optional for legacy callers that do not have visible revision evidence. */
  readonly observedProjection?: ObservedProjectionEvidence;
  readonly rowIndex: number;
  readonly observation: ObservationAttemptInput;
  readonly event: Presence<EventIdentityInput>;
  readonly evaluation: RowEvaluationResult;
  readonly canonical: Presence<CanonicalRowMutation>;
  readonly effects: readonly NewEffect[];
}

/** Durable outcome for one row-independent observation submission. */
export type PersistObservedRowResult =
  | { readonly kind: typeof OBSERVATION_WRITE_RESULT_KINDS.FENCED_OUT }
  | { readonly kind: typeof OBSERVATION_WRITE_RESULT_KINDS.STALE }
  | {
      readonly kind: typeof OBSERVATION_WRITE_RESULT_KINDS.DUPLICATE;
      readonly observationId: string;
      readonly eventId: Presence<string>;
      readonly reason: ObservationDuplicateReason;
    }
  | {
      readonly kind: typeof OBSERVATION_WRITE_RESULT_KINDS.QUARANTINED;
      readonly observationId: string;
      readonly eventId: Presence<string>;
      readonly quarantineId: string;
    }
  | {
      readonly kind: typeof OBSERVATION_WRITE_RESULT_KINDS.PERSISTED;
      readonly observationId: string;
      readonly eventId: string;
      readonly eventSequence: number;
      readonly outcome: Exclude<RowOutcome, typeof ROW_OUTCOMES.QUARANTINE>;
      readonly entityRevision: Applicability<number>;
      readonly conflictIds: readonly string[];
    };

export interface ReceiptRow {
  readonly representative_payload_hash: string;
  readonly event_id: string | null;
  readonly state: ObservationReceiptState;
}

export interface EventRow {
  readonly event_id: string;
  readonly payload_hash: string;
  readonly event_sequence: number;
}

export interface RowBindingRow {
  readonly entity_id: Presence<string>;
  readonly state: RowBindingState;
}

export interface ActiveCandidateRow {
  readonly active_candidate_conflict_id: string;
  readonly active_candidate_hash: string;
  readonly candidate_epoch: number;
  readonly event_id: string;
  readonly status: ConflictStatus;
}

export interface CreatedEvent {
  readonly eventId: string;
  readonly eventSequence: number;
}

export interface ObservationAppendResult {
  readonly kind: ObservationAppendResultKind;
  readonly eventId: Presence<string>;
}

/** Signals that the writer lease changed inside an outer transaction. */
export class FenceLostError extends Error {}

/** Signals that a canonical CAS/binding transition became stale. */
export class CanonicalStaleError extends Error {}

/** Applied canonical result used by canonical/conflict composition. */
export type AppliedCanonicalCommit = Extract<
  CanonicalCommitResult,
  { readonly kind: typeof CANONICAL_COMMIT_RESULT_KINDS.APPLIED }
>;
