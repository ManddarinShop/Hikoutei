/** Status, command, row, and SQL-result contracts for resolution persistence. */

import type { ResolutionCommand } from "../../../../domain/index.js";
import type { NewEffect } from "@hikoutei/ikisaki";

/** Runtime values for the durable resolution-command lifecycle. */
export const RESOLUTION_COMMAND_STATUSES = {
  /** A durable command waiting for an in-flight predecessor to settle. */
  PENDING: "pending",
  PROCESSING: "processing",
  APPLIED: "applied",
  STALE: "stale",
  REJECTED: "rejected",
  FAILED: "failed",
} as const;

/** Closed set of statuses stored for a resolution command. */
export type ResolutionCommandStatus =
  (typeof RESOLUTION_COMMAND_STATUSES)[keyof typeof RESOLUTION_COMMAND_STATUSES];

/** Runtime values for results returned by the resolution writer. */
export const PERSIST_RESOLUTION_RESULT_KINDS = {
  FENCED_OUT: "fenced_out",
  DEFERRED: "deferred",
  APPLIED: "applied",
  STALE: "stale",
  REJECTED: "rejected",
  DUPLICATE: "duplicate",
} as const;

/** Input required to durably process one trusted `acknowledge_system` request. */
export interface PersistResolutionCommandInput {
  readonly logicalSheetId: string;
  readonly command: ResolutionCommand;
  /** Durable transaction identity for effects created by this resolution. */
  readonly commitId: string;
  /** Effects to materialize after a successful acknowledge_system transition. */
  readonly effects: readonly NewEffect[];
  /**
   * Effects to materialize when the request is stale. This normally consumes a
   * checked control cell while projecting NEEDS_REBASE rather than retrying an
   * old acknowledgement forever.
   */
  readonly staleEffects?: readonly NewEffect[];
  /** Effects to materialize when a trusted request is rejected. */
  readonly rejectedEffects?: readonly NewEffect[];
  /**
   * Effects to materialize when a replay reaches an already terminal command.
   * This normally resets a still-checked one-shot control without reopening or
   * reapplying the canonical resolution.
   */
  readonly duplicateEffects?: readonly NewEffect[];
}

/** Result of a resolution command transaction, including safe in-flight deferral. */
export type PersistResolutionCommandResult =
  | { readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.FENCED_OUT }
  | {
      readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.DEFERRED;
      readonly commandId: string;
      readonly conflictId: string;
      readonly reason: "processing_predecessor";
    }
  | {
      readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.APPLIED;
      readonly commandId: string;
      readonly conflictId: string;
    }
  | {
      readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.STALE;
      readonly commandId: string;
      readonly conflictId: string;
    }
  | {
      readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.REJECTED;
      readonly commandId: string;
      readonly reason: string;
    }
  | {
      readonly kind: typeof PERSIST_RESOLUTION_RESULT_KINDS.DUPLICATE;
      readonly commandId: string;
      readonly status: ResolutionCommandStatus;
    };

export interface ConflictRow {
  readonly conflict_id: string;
  readonly conflict_group_id: string | null;
  readonly event_id: string;
  readonly row_binding_id: string;
  readonly entity_id: string;
  readonly field_name: string;
  readonly user_value: string;
  readonly user_base_revision: number;
  readonly canonical_value_at_detection: string;
  readonly canonical_revision_at_detection: number;
  readonly current_canonical_value: string;
  readonly current_canonical_revision: number;
  readonly candidate_epoch: number;
  readonly candidate_visible_revision: number | null;
  readonly candidate_visible_hash: string | null;
  readonly status: string;
  readonly resolution_command_id: string | null;
}

export interface CommandRow {
  readonly command_id: string;
  readonly request_key: string;
  readonly action: string;
  readonly actor_id: string;
  readonly role: string;
  readonly target_conflict_id: string;
  readonly expected_revision: number;
  readonly active_candidate_hash: string;
  readonly expected_candidate_epoch: number;
  readonly payload_hash: string;
  readonly status: ResolutionCommandStatus;
}

export interface ActiveCandidatePointer {
  readonly physical_sheet_id: string;
  readonly projection: string;
  readonly candidate_epoch: number;
  readonly active_candidate_hash: string;
}

export interface EffectDedupeRow {
  readonly effect_kind: string;
  readonly commit_id: string;
  readonly logical_sheet_id: string;
  readonly physical_sheet_id: string;
  readonly projection: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly payload_hash: string;
}

export interface RegisteredProjectionRow {
  readonly logical_sheet_id: string;
  readonly projection: string;
  readonly enabled: number;
}
