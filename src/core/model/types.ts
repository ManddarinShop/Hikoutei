/**
 * Pure domain model types shared across the core evaluator.
 *
 * These types contain no Google SDK, SQLite, or platform-specific values.
 * All cell values are NormalizedCell, all timestamps are audit-only ISO strings.
 */

import type { NormalizedCell } from "../encoding/types.js";
import type { ConflictStatus } from "./constants.js";
import type { NormalizedCellKind } from "../encoding/types.js";
import type { Applicability, Presence } from "../state/types.js";
import type {
  CANONICAL_RESOLUTION_STATUSES,
  CanonicalResolutionStatus,
  DeleteEvidence,
  FieldOwnership,
  QuarantineReason,
  RowBindingState,
  RowOperation,
  ROW_BINDING_STATES,
  ROW_OPERATIONS,
} from "./constants.js";

export type {
  CanonicalResolutionStatus,
  ConflictStatus,
  DeleteEvidence,
  FieldOwnership,
  QuarantineReason,
  RowBindingState,
  RowOperation,
} from "./constants.js";

// ---------------------------------------------------------------------------
// Entity state (canonical)
// ---------------------------------------------------------------------------

/** A single field within a canonical entity. */
export interface CanonicalFieldState {
  readonly fieldName: string;
  readonly value: NormalizedCell;
  readonly fieldRevision: number;
  readonly ownership: FieldOwnership;
}

/** The canonical accepted state of an entity as seen by the evaluator. */
export interface CanonicalEntityState {
  readonly entityId: string;
  readonly entityRevision: number;
  readonly businessKey: string;
  readonly fields: ReadonlyMap<string, CanonicalFieldState>;
}

/** Explicitly represents whether canonical state is available to evaluation. */
export type CanonicalResolution =
  | {
      readonly status: typeof CANONICAL_RESOLUTION_STATUSES.AVAILABLE;
      readonly entity: CanonicalEntityState;
    }
  | { readonly status: typeof CANONICAL_RESOLUTION_STATUSES.MISSING };

// ---------------------------------------------------------------------------
// Projection types
// ---------------------------------------------------------------------------

export type Projection = "user_input" | "system_state" | "legacy_combined";

// ---------------------------------------------------------------------------
// Normalized row
// ---------------------------------------------------------------------------

/** A single field in an observed row change. */
export interface NormalizedRowField {
  readonly fieldName: string;
  readonly cell: NormalizedCell;
  readonly baseFieldRevision: Applicability<number>;
}

/** A row read from a Sheet snapshot, identified by row binding. */
export interface NormalizedRow {
  readonly rowBindingId: string;
  readonly fields: ReadonlyMap<string, NormalizedRowField>;
}

// ---------------------------------------------------------------------------
// Observation types
// ---------------------------------------------------------------------------

export type ObservationSource = "onEdit" | "polling" | "resolution" | "repair";

/** Provenance of an optional editor identity retained for audit only. */
export type EditorActorSource = "google_active_user" | "unavailable";

/** A single normalized field change without operation-specific revision state. */
interface ObservedFieldChangeBase {
  readonly fieldName: string;
  readonly previousValue: NormalizedCell;
  readonly nextValue: NormalizedCell;
}

/** A field change for an inserted row, which has no prior field revision. */
export interface ObservedInsertFieldChange extends ObservedFieldChangeBase {
  readonly baseFieldRevision?: never;
}

/** A field change for an existing row with a required prior field revision. */
export interface ObservedVersionedFieldChange extends ObservedFieldChangeBase {
  readonly baseFieldRevision: number;
}

/** A validated field change accepted by the evaluator. */
export type ObservedFieldChange =
  | ObservedInsertFieldChange
  | ObservedVersionedFieldChange;

/** Common untrusted field data before cell normalization. */
interface RawObservedFieldChangeBase {
  readonly fieldName: string;
  readonly previousValue: unknown;
  readonly nextValue: unknown;
}

/** Raw field data for an insertion, which has no prior field revision. */
export interface RawObservedInsertFieldChange extends RawObservedFieldChangeBase {
  readonly baseFieldRevision?: never;
}

/** Raw field data for an existing row with a prior field revision. */
export interface RawObservedVersionedFieldChange extends RawObservedFieldChangeBase {
  readonly baseFieldRevision: number;
}

/** Raw field data whose revision shape is determined by row state. */
export type RawObservedFieldChange =
  | RawObservedInsertFieldChange
  | RawObservedVersionedFieldChange;

/** Common identity and visibility data for a validated row change. */
interface ObservedRowChangeBase {
  readonly rowBindingId: string;
  readonly baseVisibleRevision: number;
}

/** A validated insertion with only the state an insertion can carry. */
export interface ObservedInsertRowChange extends ObservedRowChangeBase {
  readonly operation: typeof ROW_OPERATIONS.INSERT;
  readonly afterRow: NormalizedRow;
  readonly fields: readonly ObservedInsertFieldChange[];
}

/** A validated update or rename with both visible row snapshots. */
export interface ObservedExistingRowChange extends ObservedRowChangeBase {
  readonly operation: typeof ROW_OPERATIONS.UPDATE | typeof ROW_OPERATIONS.RENAME;
  readonly beforeRow: NormalizedRow;
  readonly afterRow: NormalizedRow;
  readonly baseEntityRevision: number;
  readonly fields: readonly ObservedVersionedFieldChange[];
}

/** A validated deletion with required evidence that may later be rejected. */
export interface ObservedDeleteRowChange extends ObservedRowChangeBase {
  readonly operation: typeof ROW_OPERATIONS.DELETE;
  readonly beforeRow: NormalizedRow;
  readonly baseEntityRevision: number;
  /** Anchor evidence is checked by operation preconditions after normalization. */
  readonly deleteEvidence: DeleteEvidence;
  readonly fields: readonly ObservedVersionedFieldChange[];
}

/** A validated row change whose shape is determined by its operation. */
export type ObservedRowChange =
  | ObservedInsertRowChange
  | ObservedExistingRowChange
  | ObservedDeleteRowChange;

/** Common raw row data shared by operation-specific input variants. */
interface RawObservedRowChangeBase {
  readonly rowBindingId: string;
  readonly baseVisibleRevision: number;
}

/** Raw insertion input with no existing-row state fields. */
export interface RawObservedInsertRowChange extends RawObservedRowChangeBase {
  readonly operation: typeof ROW_OPERATIONS.INSERT;
  readonly afterRow: NormalizedRow;
  readonly fields: readonly RawObservedInsertFieldChange[];
}

/** Raw update or rename input with required existing-row state. */
export interface RawObservedExistingRowChange extends RawObservedRowChangeBase {
  readonly operation: typeof ROW_OPERATIONS.UPDATE | typeof ROW_OPERATIONS.RENAME;
  readonly beforeRow: NormalizedRow;
  readonly afterRow: NormalizedRow;
  readonly baseEntityRevision: number;
  readonly fields: readonly RawObservedVersionedFieldChange[];
}

/** Raw delete input with required deletion evidence and entity revision. */
export interface RawObservedDeleteRowChange extends RawObservedRowChangeBase {
  readonly operation: typeof ROW_OPERATIONS.DELETE;
  readonly beforeRow: NormalizedRow;
  readonly baseEntityRevision: number;
  readonly deleteEvidence: DeleteEvidence;
  readonly fields: readonly RawObservedVersionedFieldChange[];
}

/** Raw row input whose shape is determined by its operation. */
export type RawObservedRowChange =
  | RawObservedInsertRowChange
  | RawObservedExistingRowChange
  | RawObservedDeleteRowChange;

/** A batch of row changes observed from one paste/drag-fill/poll cycle. */
export interface ObservedEditBatch {
  readonly batchId: string;
  readonly source: ObservationSource;
  readonly sheetId: string;
  readonly projection: Projection;
  /** Schema version reported by the normalized snapshot. */
  readonly schemaVersion: number;
  readonly atomicity: "row_independent";
  readonly baseSnapshotHash: string;
  /** Authenticated service principal; audit metadata, never a merge input. */
  readonly ingressActorId: string;
  /** Verified editor identity when the gateway can provide one. */
  readonly editorActorId: Presence<string>;
  readonly editorActorSource: EditorActorSource;
  readonly rows: readonly ObservedRowChange[];
}

// ---------------------------------------------------------------------------
// Event model
// ---------------------------------------------------------------------------

/** Common metadata for a normalized Sheet change event. */
interface SheetChangeEventBase {
  readonly eventId: string;
  readonly eventKey: string;
  readonly payloadHash: string;
  readonly batchId: string;
  readonly source: ObservationSource;
  readonly sheetId: string;
  readonly projection: Projection;
  readonly rowBindingId: string;
  readonly baseVisibleRevision: number;
  readonly baseSnapshotHash: string;
  readonly beforeRowHash: string;
  readonly afterRowHash: string;
}

/** An event for a newly observed row with no prior entity revision. */
export interface InsertSheetChangeEvent extends SheetChangeEventBase {
  readonly operation: typeof ROW_OPERATIONS.INSERT;
  readonly fields: readonly ObservedInsertFieldChange[];
}

/** An event for an existing row with a required entity revision. */
export interface ExistingSheetChangeEvent extends SheetChangeEventBase {
  readonly operation: typeof ROW_OPERATIONS.UPDATE | typeof ROW_OPERATIONS.RENAME;
  readonly baseEntityRevision: number;
  readonly fields: readonly ObservedVersionedFieldChange[];
}

/** A delete event with a required entity revision and deletion evidence. */
export interface DeleteSheetChangeEvent extends SheetChangeEventBase {
  readonly operation: typeof ROW_OPERATIONS.DELETE;
  readonly baseEntityRevision: number;
  readonly fields: readonly ObservedVersionedFieldChange[];
}

/** A normalized event whose shape is determined by its operation. */
export type SheetChangeEvent =
  | InsertSheetChangeEvent
  | ExistingSheetChangeEvent
  | DeleteSheetChangeEvent;

// ---------------------------------------------------------------------------
// Conflict model
// ---------------------------------------------------------------------------

/** Field-level conflict record preserving both candidate and canonical state. */
export interface SyncConflict {
  readonly conflictId: string;
  readonly conflictGroupId: Presence<string>;
  readonly eventId: string;
  readonly rowBindingId: string;
  readonly entityId: string;
  readonly fieldName: string;
  readonly userValue: NormalizedCell;
  readonly userBaseRevision: number;
  readonly canonicalValueAtDetection: NormalizedCell;
  readonly canonicalRevisionAtDetection: number;
  readonly currentCanonicalValue: NormalizedCell;
  readonly currentCanonicalRevision: number;
  /** Monotonic attempt generation for this field's active candidate. */
  readonly candidateEpoch: number;
  readonly status: ConflictStatus;
  readonly resolutionCommandId: Presence<string>;
}

// ---------------------------------------------------------------------------
// Quarantine model
// ---------------------------------------------------------------------------

/** A plan to quarantine a row with preserved evidence. */
interface QuarantinePlanBase {
  readonly quarantineId: string;
  readonly reason: QuarantineReason;
  readonly rowBindingId: string;
  readonly operation: RowOperation;
  readonly fields: readonly ObservedFieldChange[];
  readonly repairFields: readonly string[];
}

/** Quarantine evidence for an inserted row. */
export interface InsertQuarantinePlan extends QuarantinePlanBase {
  readonly operation: typeof ROW_OPERATIONS.INSERT;
  readonly afterRow: NormalizedRow;
}

/** Quarantine evidence for an existing row edit. */
export interface ExistingQuarantinePlan extends QuarantinePlanBase {
  readonly operation: typeof ROW_OPERATIONS.UPDATE | typeof ROW_OPERATIONS.RENAME;
  readonly beforeRow: NormalizedRow;
  readonly afterRow: NormalizedRow;
}

/** Quarantine evidence for a deleted row. */
export interface DeleteQuarantinePlan extends QuarantinePlanBase {
  readonly operation: typeof ROW_OPERATIONS.DELETE;
  readonly beforeRow: NormalizedRow;
}

export type QuarantinePlan =
  | InsertQuarantinePlan
  | ExistingQuarantinePlan
  | DeleteQuarantinePlan;

/** Alias kept for internal code that needs to emphasize the typed shape. */
export type TypedQuarantinePlan = QuarantinePlan;

// ---------------------------------------------------------------------------
// Repair model
// ---------------------------------------------------------------------------

/** A plan to repair system-owned fields to canonical values. */
export interface RepairPlan {
  readonly quarantineId: string;
  readonly rowBindingId: string;
  readonly affectedSystemFields: readonly string[];
  readonly canonicalTargetValues: ReadonlyMap<string, NormalizedCell>;
  readonly repairGuardHash: string;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Ownership manifest
// ---------------------------------------------------------------------------

/** Ownership metadata for a single field. */
export interface FieldManifestEntry {
  readonly fieldName: string;
  readonly ownership: FieldOwnership;
  readonly projection: Projection;
  readonly type: NormalizedCellKind;
  readonly required: boolean;
  readonly unique: boolean;
}

/** Maps field names to ownership metadata. */
export type OwnershipManifest = ReadonlyMap<string, FieldManifestEntry>;

// ---------------------------------------------------------------------------
// Row binding context (provided by storage layer)
// ---------------------------------------------------------------------------

/** Common identity context shared by operation-state-specific bindings. */
interface RowBindingContextBase {
  readonly rowBindingId: string;
  readonly candidateEpoch: number;
}

/** A candidate binding that has not been attached to a canonical entity. */
export interface CandidateRowBindingContext extends RowBindingContextBase {
  readonly bindingState: typeof ROW_BINDING_STATES.CANDIDATE;
  readonly businessKey?: string;
}

/** An active binding with an entity and business key. */
export interface ActiveRowBindingContext extends RowBindingContextBase {
  readonly bindingState: typeof ROW_BINDING_STATES.ACTIVE;
  readonly entityId: string;
  readonly businessKey: string;
}

/** A tombstoned binding that still points to its former entity. */
export interface TombstonedRowBindingContext extends RowBindingContextBase {
  readonly bindingState: typeof ROW_BINDING_STATES.TOMBSTONED;
  readonly entityId: string;
  readonly businessKey: string;
}

/** An ambiguous binding whose entity identity cannot be trusted. */
export interface AmbiguousRowBindingContext extends RowBindingContextBase {
  readonly bindingState: typeof ROW_BINDING_STATES.AMBIGUOUS;
}

/** A binding whose shape is determined by its lifecycle state. */
export type RowBindingContext =
  | CandidateRowBindingContext
  | ActiveRowBindingContext
  | TombstonedRowBindingContext
  | AmbiguousRowBindingContext;

// ---------------------------------------------------------------------------
// Resolution command
// ---------------------------------------------------------------------------

export type ResolutionAction = "acknowledge_system";

export type ActorRole = "sheet_editor" | "sync_operator" | "sync_admin";

/** A trusted resolution command for a conflict. */
export interface ResolutionCommand {
  readonly commandId: string;
  readonly requestKey: string;
  readonly action: ResolutionAction;
  readonly actorId: string;
  readonly role: ActorRole;
  readonly targetConflictId: string;
  readonly expectedRevision: number;
  readonly activeCandidateHash: string;
  /** Prevents an old acknowledgement from resolving an ABA candidate retry. */
  readonly expectedCandidateEpoch: number;
  readonly payloadHash: string;
}

// ---------------------------------------------------------------------------
// Effect model
// ---------------------------------------------------------------------------

export type EffectKind =
  | "system_projection"
  | "candidate_reconcile"
  | "system_repair"
  | "resolution_projection"
  /** Removes a resolved system-owned Sync_Conflicts row after a visible CAS. */
  | "resolution_delete"
  /** Removes one candidate-free User_Input row after a full-row visible CAS. */
  | "user_input_delete";

export type EffectTargetKind = "entity" | "row_binding" | "projection_row" | "conflict";

export type EffectStatus =
  | "pending"
  | "processing"
  | "applied"
  | "blocked_candidate"
  | "superseded"
  | "conflict"
  | "failed";

/** A sheet effect to be dispatched by the outbox worker. */
export interface SheetEffect {
  readonly effectId: string;
  readonly effectKind: EffectKind;
  readonly commitId: string;
  readonly sheetId: string;
  readonly projection: Projection;
  readonly rowBindingId: string;
  readonly targetKind: EffectTargetKind;
  readonly targetId: string;
  readonly targetEntityRevision: number;
  readonly targetFieldRevisionHash: string;
  readonly targetCanonicalCommitId: string;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly repairGuardHash: Presence<string>;
  readonly sourceQuarantineId: Presence<string>;
  readonly payloadHash: string;
  readonly effectDedupeKey: string;
  readonly streamSequence: number;
}
