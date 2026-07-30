/**
 * Fenced canonical field commits for the SQLite-authoritative prototype.
 *
 * The writer applies every accepted field CAS and any resulting outbox rows in
 * one SQLite savepoint. A stale field or lost fence rolls back the complete
 * row-level commit, so a partially accepted event cannot leak a partial state.
 */

// Domain contract: canonical rows are the SQLite source of truth.
import { ROW_OPERATIONS } from "../../../../domain/model/constants.js";
import type {
  Applicability,
  FieldOwnership,
  NormalizedCell,
  Presence,
} from "../../../../domain/index.js";

// Shared state tags: these make applicability and presence explicit.
import { PRESENCE_KINDS } from "../../../../shared/state/constants.js";

// Storage boundary: errors, transactions, fencing, and SQL adapters.
import { rollbackSqlSavepoint } from "../../sqlite/sqlTransaction.js";
import { isFencingValidWithSql } from "../../sync/shared/writerLease.js";
import type { FencingContext } from "../../sync/shared/writerLease.js";

// Outbound synchronization: accepted canonical changes become outbox effects.
import {
  appendPendingEffectsWithSql,
  type NewEffect,
} from "../../sync/outbound/effectOutbox.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import {
  CANONICAL_COMMIT_RESULT_KINDS,
  CANONICAL_COMMIT_STALE_TARGETS,
} from "./canonicalCommitConstants.js";
import {
  AsyncFenceLostError,
  applyCanonicalDeleteWithSql,
  applyCanonicalInsertWithSql,
  applyCanonicalUpdateWithSql,
} from "./canonicalCommitOperations.js";
import { validateCanonicalCommitInput } from "./canonicalCommitValidation.js";

export {
  CANONICAL_COMMIT_RESULT_KINDS,
  CANONICAL_COMMIT_STALE_TARGETS,
} from "./canonicalCommitConstants.js";

/** Closed set of canonical stale-target kinds. */
export type CanonicalCommitStaleTarget =
  (typeof CANONICAL_COMMIT_STALE_TARGETS)[keyof typeof CANONICAL_COMMIT_STALE_TARGETS];

/** A field value the writer should insert or compare-and-set. */
export interface CanonicalFieldWrite {
  readonly fieldName: string;
  readonly value: NormalizedCell;
  /** Inserts have no prior revision; updates carry the revision used by CAS. */
  readonly expectedFieldRevision: Applicability<number>;
  readonly ownership: FieldOwnership;
}

/** Shared canonical commit fields used by every row operation. */
interface CanonicalCommitBase {
  readonly entityId: string;
  /** Snapshot hash is absent when the caller has no accepted snapshot evidence. */
  readonly acceptedSnapshotHash: Presence<string>;
  /** Effects are inserted in this same savepoint as the canonical mutation. */
  readonly effects: readonly NewEffect[];
}

/** An insert prepared from one core evaluation result. */
export interface CanonicalInsertCommitInput extends CanonicalCommitBase {
  readonly kind: typeof ROW_OPERATIONS.INSERT;
  readonly fields: readonly CanonicalFieldWrite[];
}

/** A field-level update prepared from one core evaluation result. */
export interface CanonicalUpdateCommitInput extends CanonicalCommitBase {
  readonly kind: typeof ROW_OPERATIONS.UPDATE;
  readonly fields: readonly CanonicalFieldWrite[];
}

/** An insert or field-level update prepared from one core evaluation result. */
export type CanonicalFieldCommitInput = CanonicalInsertCommitInput | CanonicalUpdateCommitInput;

/** A confirmed delete that turns an active canonical entity into a tombstone. */
export interface CanonicalDeleteCommitInput extends CanonicalCommitBase {
  readonly kind: typeof ROW_OPERATIONS.DELETE;
  /** Entity revision observed with the explicit delete evidence. */
  readonly expectedEntityRevision: number;
}

/** A row-level canonical mutation prepared from one core evaluation result. */
export type CanonicalCommitInput = CanonicalFieldCommitInput | CanonicalDeleteCommitInput;

/** Observable result of a fenced canonical commit attempt. */
export type CanonicalCommitResult =
  | {
      readonly kind: typeof CANONICAL_COMMIT_RESULT_KINDS.APPLIED;
      readonly entityRevision: number;
      readonly fieldRevisions: ReadonlyMap<string, number>;
    }
  | {
      readonly kind: typeof CANONICAL_COMMIT_RESULT_KINDS.STALE;
      readonly target: CanonicalCommitStaleTarget;
      readonly fieldName: Applicability<string>;
    }
  | { readonly kind: typeof CANONICAL_COMMIT_RESULT_KINDS.FENCED_OUT }
  | {
      readonly kind: typeof CANONICAL_COMMIT_RESULT_KINDS.INVALID;
      readonly reason: string;
    };

/**
 * Commits canonical state and outbox effects inside an already-active async
 * SQL transaction.
 *
 * Call it from the same adapter transaction as the user entity mutation so a
 * database error cannot persist one side without the other.
 */
export async function commitCanonicalChangesWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: CanonicalCommitInput,
): Promise<CanonicalCommitResult> {
  const invalidReason = validateCanonicalCommitInput(input);
  if (invalidReason.kind === PRESENCE_KINDS.PRESENT) {
    return { kind: CANONICAL_COMMIT_RESULT_KINDS.INVALID, reason: invalidReason.value };
  }
  if (!(await isFencingValidWithSql(sql, fence))) {
    return { kind: CANONICAL_COMMIT_RESULT_KINDS.FENCED_OUT };
  }

  await sql.run("SAVEPOINT canonical_commit");
  try {
    const result = input.kind === ROW_OPERATIONS.INSERT
      ? await applyCanonicalInsertWithSql(sql, fence, input)
      : input.kind === ROW_OPERATIONS.UPDATE
        ? await applyCanonicalUpdateWithSql(sql, fence, input)
        : await applyCanonicalDeleteWithSql(sql, fence, input);
    if (result.kind !== CANONICAL_COMMIT_RESULT_KINDS.APPLIED) {
      await rollbackSqlSavepoint(sql, "canonical_commit");
      return result;
    }

    if (!(await appendPendingEffectsWithSql(sql, fence, input.effects))) {
      throw new AsyncFenceLostError();
    }

    await sql.run("RELEASE canonical_commit");
    return result;
  } catch (error: unknown) {
    try {
      await rollbackSqlSavepoint(sql, "canonical_commit");
    } catch {
      // Preserve the storage error that made the canonical commit fail.
    }
    if (error instanceof AsyncFenceLostError) {
      return { kind: CANONICAL_COMMIT_RESULT_KINDS.FENCED_OUT };
    }
    throw error;
  }
}

/** Commits canonical state in one adapter-owned transaction. */
export async function commitCanonicalChangesWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
  input: CanonicalCommitInput,
): Promise<CanonicalCommitResult> {
  return storage.transaction(({ sql }) => commitCanonicalChangesWithSql(sql, fence, input));
}
