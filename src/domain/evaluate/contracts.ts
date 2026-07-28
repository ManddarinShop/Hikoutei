/**
 * Shared contracts for pure batch evaluation.
 *
 * These types keep evaluator inputs and outcomes independent from SQLite,
 * gateway transport, and any repository implementation.
 */

import type { NormalizedCell } from "../../shared/encoding/types.js";
import type {
  CanonicalResolution,
  OwnershipManifest,
  ObservedRowChange,
  Projection,
  QuarantinePlan,
  QuarantineReason,
  RepairPlan,
  RowBindingContext,
  RowOperation,
  SyncConflict,
} from "../model/types.js";
import { PRECONDITION_RESULTS } from "../model/constants.js";
import { QUARANTINE_REPAIR_STATUSES, ROW_OUTCOMES } from "./constants.js";
import type {
  QuarantineRepairNotPlannedReason,
  RowOutcome,
} from "./constants.js";

export type { RowOutcome } from "./constants.js";

/** Result shared by operation-specific precondition validators. */
export type PreconditionResult =
  | { readonly status: typeof PRECONDITION_RESULTS.VALID }
  | {
      readonly status: typeof PRECONDITION_RESULTS.INVALID;
      readonly reason: QuarantineReason;
    };

/** Result that either promotes raw input to a typed row or explains rejection. */
export type StructuralPreconditionResult =
  | {
      readonly status: typeof PRECONDITION_RESULTS.VALID;
      readonly row: ObservedRowChange;
    }
  | {
      readonly status: typeof PRECONDITION_RESULTS.INVALID;
      readonly reason: QuarantineReason;
    };

/** One accepted canonical field write produced by a row evaluation. */
export interface AcceptedField {
  readonly fieldName: string;
  readonly nextValue: NormalizedCell;
  readonly nextFieldRevision: number;
}

/** A field-level stale-write conflict that requires explicit resolution. */
export interface FieldConflict {
  readonly fieldName: string;
  readonly userValue: NormalizedCell;
  readonly userBaseRevision: number;
  readonly canonicalValue: NormalizedCell;
  readonly canonicalRevision: number;
}

/** A row result that applies one or more fields to canonical state. */
export interface AppliedRowEvaluationResult {
  readonly rowBindingId: string;
  readonly outcome: typeof ROW_OUTCOMES.ACCEPTED | typeof ROW_OUTCOMES.PARTIALLY_ACCEPTED;
  readonly acceptedFields: readonly AcceptedField[];
  readonly conflicts: readonly FieldConflict[];
  readonly nextEntityRevision: number;
}

/** A row result that records conflicts without changing canonical state. */
export interface ConflictRowEvaluationResult {
  readonly rowBindingId: string;
  readonly outcome: typeof ROW_OUTCOMES.CONFLICT;
  readonly acceptedFields: readonly [];
  readonly conflicts: readonly FieldConflict[];
}

/** Explicit repair state for a quarantined row. */
export type QuarantineRepairDecision =
  | {
      readonly status: typeof QUARANTINE_REPAIR_STATUSES.NOT_PLANNED;
      readonly reason: QuarantineRepairNotPlannedReason;
    }
  | { readonly status: typeof QUARANTINE_REPAIR_STATUSES.PLANNED; readonly plan: RepairPlan };

/** A terminal row result that preserves evidence without canonical mutation. */
export interface QuarantineRowEvaluationResult {
  readonly rowBindingId: string;
  readonly outcome: typeof ROW_OUTCOMES.QUARANTINE;
  readonly acceptedFields: readonly [];
  readonly conflicts: readonly [];
  readonly quarantine: QuarantinePlan;
  readonly repair: QuarantineRepairDecision;
}

/** Full immutable decision for one row in an observation batch. */
export type RowEvaluationResult =
  | AppliedRowEvaluationResult
  | ConflictRowEvaluationResult
  | QuarantineRowEvaluationResult;

/** Aggregate classification for a row-independent observation batch. */
export type BatchOutcome = RowOutcome;

/** Result returned by the pure batch evaluator. */
export interface BatchEvaluationResult {
  readonly batchId: string;
  readonly rowResults: readonly RowEvaluationResult[];
  readonly overallOutcome: BatchOutcome;
}

/** Canonical and active-candidate context supplied by the storage boundary. */
export interface EvaluationContext {
  readonly manifest: OwnershipManifest;
  readonly canonicalByBindingId: ReadonlyMap<string, CanonicalResolution>;
  readonly bindingByBindingId: ReadonlyMap<string, RowBindingContext>;
  readonly activeConflictsByBindingAndField: ReadonlyMap<string, ReadonlyMap<string, SyncConflict>>;
  /** Active unique keys by manifest field and stable normalized-cell hash. */
  readonly businessKeyEntityIdsByField: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly schemaVersion: number;
}

/** Common field identity material that distinguishes ABA and revision attempts. */
interface EventKeyFieldBase {
  readonly fieldName: string;
  readonly candidateEpoch: number;
  readonly beforeHash: string;
  readonly afterHash: string;
  readonly nextValue: NormalizedCell;
}

/** Identity material for an inserted field without a prior revision. */
export interface InsertEventKeyField extends EventKeyFieldBase {
  readonly baseFieldRevision?: never;
}

/** Identity material for a versioned field with a required prior revision. */
export interface VersionedEventKeyField extends EventKeyFieldBase {
  readonly baseFieldRevision: number;
}

/** Field identity material whose shape is determined by row state. */
export type EventKeyField = InsertEventKeyField | VersionedEventKeyField;

/** Normalized row-change material used to compute a source-independent event key. */
export interface EventKeyInput {
  readonly schemaVersion: number;
  readonly sheetId: string;
  readonly projection: Projection;
  readonly rowBindingId: string;
  readonly baseVisibleRevision: number;
  readonly baseSnapshotHash: string;
  readonly operation: RowOperation;
  readonly beforeRowHash: string;
  readonly afterRowHash: string;
  readonly changedFields: readonly EventKeyField[];
}
