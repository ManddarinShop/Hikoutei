/**
 * Promotion and update helpers for candidate-time visible conflict evidence.
 *
 * A conflict stores the full-row visible revision/hash observed when its user
 * candidate was detected. That evidence is the compare-and-set baseline the
 * resolver uses when it writes the canonical value back to User_Input, so a
 * later human edit produces a guard mismatch instead of a silent overwrite.
 *
 * Legacy conflicts created before the v6 migration have both columns absent
 * (NULL). They carry no usable CAS baseline and must stay unresolved until a
 * human resolves them on the Sync_Conflicts tab.
 */

import {
  CANDIDATE_VISIBLE_EVIDENCE_STATUSES,
} from "@hikoutei/contracts/domain/model/constants.js";
import type { CandidateVisibleEvidence } from "@hikoutei/contracts/domain/model/types.js";
import { PRESENCE_KINDS } from "@hikoutei/contracts/state/constants.js";
import type { Presence } from "@hikoutei/contracts/state/types.js";
import { isNonNegativeSafeInteger } from "@hikoutei/contracts/validation.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";

/** Returns the unavailable evidence variant used by legacy and unread rows. */
export function unavailableCandidateVisibleEvidence(): CandidateVisibleEvidence {
  return { status: CANDIDATE_VISIBLE_EVIDENCE_STATUSES.UNAVAILABLE };
}

/**
 * Promotes raw stored evidence columns into the validated evidence union.
 *
 * Both columns absent means legacy/unavailable evidence. Both present must be a
 * valid non-negative revision and a non-empty string hash. A one-sided column,
 * an invalid or negative/non-integer revision, or an empty or non-string hash
 * is a storage-consistency failure: the row cannot be trusted as resolution
 * CAS input. The raw values are treated as unknown because SQLite is
 * dynamically typed and must never be assumed to hold the declared shape.
 */
export function promoteCandidateVisibleEvidence(
  rawRevision: unknown,
  rawHash: unknown,
  conflictId: string,
): CandidateVisibleEvidence {
  const revision = rawRevision === null ? null : rawRevision;
  const hash = rawHash === null ? null : rawHash;
  if (revision === null && hash === null) {
    return unavailableCandidateVisibleEvidence();
  }
  if (revision === null || hash === null) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      `conflict ${conflictId} has one-sided candidate visible evidence`,
    );
  }
  if (
    !isNonNegativeSafeInteger(revision) ||
    typeof hash !== "string" ||
    hash.length === 0
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      `conflict ${conflictId} has invalid candidate visible evidence`,
    );
  }
  return {
    status: CANDIDATE_VISIBLE_EVIDENCE_STATUSES.AVAILABLE,
    visibleRevision: revision,
    visibleHash: hash,
  };
}

/**
 * Selects the newer full-row visible evidence when the same active candidate
 * is re-observed while another accepted field advances the row.
 *
 * Returns the new evidence when it is strictly newer than the stored evidence,
 * the stored evidence when they are identical, and throws on a revision
 * regression or a same-revision/different-hash inconsistency. Unavailable
 * (legacy) stored evidence stays unavailable: only fresh v6 conflicts persist
 * AVAILABLE evidence at creation, and only those may advance monotonically.
 * A later polling observation must never upgrade a legacy conflict into an
 * auto-resolvable baseline.
 */
export function advanceCandidateVisibleEvidence(
  current: CandidateVisibleEvidence,
  observedRevision: number,
  observedHash: string,
  conflictId: string,
): CandidateVisibleEvidence {
  if (
    !isNonNegativeSafeInteger(observedRevision) ||
    typeof observedHash !== "string" ||
    observedHash.length === 0
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      `conflict ${conflictId} observed invalid candidate visible evidence`,
    );
  }
  const observed: CandidateVisibleEvidence = {
    status: CANDIDATE_VISIBLE_EVIDENCE_STATUSES.AVAILABLE,
    visibleRevision: observedRevision,
    visibleHash: observedHash,
  };
  if (current.status === CANDIDATE_VISIBLE_EVIDENCE_STATUSES.UNAVAILABLE) {
    return current;
  }
  if (current.visibleRevision === observedRevision) {
    if (current.visibleHash !== observedHash) {
      throw new StorageError(
        STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
        `conflict ${conflictId} candidate visible hash changed at the same revision`,
      );
    }
    return current;
  }
  if (observedRevision < current.visibleRevision) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      `conflict ${conflictId} candidate visible evidence regressed`,
    );
  }
  return observed;
}

/** Unwraps available evidence or returns null when it is unavailable. */
export function availableCandidateVisibleEvidence(
  evidence: CandidateVisibleEvidence,
): { readonly visibleRevision: number; readonly visibleHash: string } | null {
  return evidence.status === CANDIDATE_VISIBLE_EVIDENCE_STATUSES.AVAILABLE
    ? { visibleRevision: evidence.visibleRevision, visibleHash: evidence.visibleHash }
    : null;
}

/** Converts a presence-wrapped evidence pair into the validated evidence union. */
export function presenceCandidateVisibleEvidence(
  revision: Presence<number>,
  hash: Presence<string>,
  conflictId: string,
): CandidateVisibleEvidence {
  if (revision.kind === PRESENCE_KINDS.ABSENT && hash.kind === PRESENCE_KINDS.ABSENT) {
    return unavailableCandidateVisibleEvidence();
  }
  return promoteCandidateVisibleEvidence(
    revision.kind === PRESENCE_KINDS.PRESENT ? revision.value : null,
    hash.kind === PRESENCE_KINDS.PRESENT ? hash.value : null,
    conflictId,
  );
}
