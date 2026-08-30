/**
 * Conflict lifecycle transitions.
 *
 * Per design: conflict status is OPEN, NEEDS_REBASE, RESOLVED only.
 * SUPERSEDED is not a conflict status.
 *
 * - OPEN: initial state when a stale field is detected
 * - NEEDS_REBASE: same field's canonical value advanced while conflict is open
 * - RESOLVED: user submitted acknowledge_system with matching revision/hash CAS
 */

import { stableHash } from "../../encoding/stableEncode.js";
import type { NormalizedCell } from "../../encoding/types.js";
import {
  createAlreadyResolvedError,
  createConflictIdMismatchError,
  createInvalidResolutionRoleError,
  createUnsupportedResolutionActionError,
} from "./errors.js";
import type { ConflictResolutionError } from "./errors.js";
import { CONFLICT_STATUSES } from "../model/constants.js";
import type { ResolutionCommand, SyncConflict } from "../model/types.js";
import { LOOKUP_RESULT_KINDS, PRESENCE_KINDS } from "../../state/constants.js";
import type { LookupResult } from "../../state/types.js";

/** Runtime values for the discriminated conflict transition result. */
export const CONFLICT_TRANSITION_KINDS = {
  RESOLVED: "resolved",
  STALE: "stale",
  REJECTED: "rejected",
} as const;

/** Closed set of outcomes produced by a conflict transition. */
export type ConflictTransitionKind =
  (typeof CONFLICT_TRANSITION_KINDS)[keyof typeof CONFLICT_TRANSITION_KINDS];

/** Result of attempting to transition a conflict via a resolution command. */
export type ConflictTransitionResult =
  | {
      readonly kind: typeof CONFLICT_TRANSITION_KINDS.RESOLVED;
      readonly conflict: SyncConflict;
    }
  | {
      readonly kind: typeof CONFLICT_TRANSITION_KINDS.STALE;
      readonly conflict: SyncConflict;
    }
  | {
      readonly kind: typeof CONFLICT_TRANSITION_KINDS.REJECTED;
      readonly error: ConflictResolutionError;
    };

/**
 * Determines whether a canonical commit should trigger NEEDS_REBASE.
 *
 * Called within the same SQLite transaction that commits the canonical change.
 * If the same field has an OPEN or NEEDS_REBASE conflict, the conflict's
 * current canonical projection is updated and status set to NEEDS_REBASE.
 */
export function shouldRebaseConflict(
  conflict: SyncConflict,
  changedFieldName: string,
  newCanonicalRevision: number,
  newCanonicalValue: NormalizedCell,
): LookupResult<SyncConflict> {
  if (conflict.fieldName !== changedFieldName) {
    return { kind: LOOKUP_RESULT_KINDS.NOT_FOUND };
  }
  if (conflict.status === CONFLICT_STATUSES.RESOLVED) {
    return { kind: LOOKUP_RESULT_KINDS.NOT_FOUND };
  }
  if (newCanonicalRevision <= conflict.currentCanonicalRevision) {
    return { kind: LOOKUP_RESULT_KINDS.NOT_FOUND };
  }

  return {
    kind: LOOKUP_RESULT_KINDS.FOUND,
    value: {
      ...conflict,
      currentCanonicalValue: newCanonicalValue,
      currentCanonicalRevision: newCanonicalRevision,
      status: CONFLICT_STATUSES.NEEDS_REBASE,
    },
  };
}

/**
 * Applies a resolution command to a conflict via compare-and-set.
 *
 * The command's expected revision, active candidate hash, and candidate epoch
 * must match the conflict's current state. The epoch prevents an old request
 * from resolving an ABA retry that returned to the same candidate value. If
 * any CAS input does not match, the conflict stays at its current status
 * (NEEDS_REBASE if canonical has advanced) and the checkbox is reset.
 */
export function applyResolution(
  conflict: SyncConflict,
  command: ResolutionCommand,
): ConflictTransitionResult {
  if (command.action !== "acknowledge_system") {
    return {
      kind: CONFLICT_TRANSITION_KINDS.REJECTED,
      error: createUnsupportedResolutionActionError(command.action),
    };
  }

  if (command.role !== "sheet_editor" && command.role !== "sync_operator") {
    return {
      kind: CONFLICT_TRANSITION_KINDS.REJECTED,
      error: createInvalidResolutionRoleError(command.role),
    };
  }

  if (command.targetConflictId !== conflict.conflictId) {
    return {
      kind: CONFLICT_TRANSITION_KINDS.REJECTED,
      error: createConflictIdMismatchError(
        command.targetConflictId,
        conflict.conflictId,
      ),
    };
  }

  if (conflict.status === CONFLICT_STATUSES.RESOLVED) {
    return conflict.resolutionCommandId.kind === PRESENCE_KINDS.PRESENT &&
      conflict.resolutionCommandId.value === command.commandId
      ? { kind: CONFLICT_TRANSITION_KINDS.RESOLVED, conflict }
      : {
          kind: CONFLICT_TRANSITION_KINDS.REJECTED,
          error: createAlreadyResolvedError(
            conflict.conflictId,
            conflict.resolutionCommandId,
            command.commandId,
          ),
        };
  }

  const revisionMatches = command.expectedRevision === conflict.currentCanonicalRevision;
  const hashMatches = command.activeCandidateHash === candidateHash(conflict);
  const epochMatches = command.expectedCandidateEpoch === conflict.candidateEpoch;

  if (!revisionMatches || !hashMatches || !epochMatches) {
    return {
      kind: CONFLICT_TRANSITION_KINDS.STALE,
      conflict:
        conflict.status === CONFLICT_STATUSES.OPEN
          ? { ...conflict, status: CONFLICT_STATUSES.NEEDS_REBASE }
          : conflict,
    };
  }

  return {
    kind: CONFLICT_TRANSITION_KINDS.RESOLVED,
    conflict: {
      ...conflict,
      status: CONFLICT_STATUSES.RESOLVED,
      resolutionCommandId: {
        kind: PRESENCE_KINDS.PRESENT,
        value: command.commandId,
      },
    },
  };
}

/** Computes the active candidate hash for CAS comparison. */
/** Computes the compare-and-set hash for the currently active user candidate. */
export function candidateHash(conflict: SyncConflict): string {
  return stableHash({
    value: conflict.userValue,
    revision: conflict.userBaseRevision,
  });
}
