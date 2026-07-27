// Core domain layer — pure evaluator and model types.

export {
  EMPTY_ARRAY_LENGTH_ZERO,
  EMPTY_STRING_LENGTH_ZERO,
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "./constants.js";

// Encoding
export { stableEncode, stableHash } from "./encoding/index.js";
export type {
  NormalizedCell,
  DateValue,
  CellObservation,
  StableValue,
} from "./encoding/index.js";

// Model
export type {
  CanonicalFieldState,
  CanonicalEntityState,
  FieldOwnership,
  Projection,
  RowBindingState,
  NormalizedRow,
  NormalizedRowField,
  ObservationSource,
  RowOperation,
  DeleteEvidence,
  EditorActorSource,
  ObservedFieldChange,
  ObservedRowChange,
  ObservedEditBatch,
  SheetChangeEvent,
  ConflictStatus,
  SyncConflict,
  QuarantineReason,
  QuarantinePlan,
  RepairPlan,
  FieldManifestEntry,
  OwnershipManifest,
  RowBindingContext,
  ResolutionAction,
  ActorRole,
  ResolutionCommand,
  EffectKind,
  EffectTargetKind,
  EffectStatus,
  SheetEffect,
} from "./model/index.js";
export {
  FIELD_OWNERSHIPS,
  ROW_OPERATIONS,
} from "./model/index.js";

// Evaluator
export {
  evaluateBatch,
  computeEventKey,
  computeRowHash,
  computeRepairGuardHash,
} from "./evaluate/index.js";
export type {
  BatchEvaluationResult,
  RowEvaluationResult,
  RowOutcome,
  BatchOutcome,
  AcceptedField,
  FieldConflict,
  EvaluationContext,
  EventKeyField,
} from "./evaluate/index.js";

// Conflict transitions
export {
  shouldRebaseConflict,
  applyResolution,
} from "./conflict/index.js";
export type { ConflictTransitionResult } from "./conflict/index.js";

// Shared state contracts
export {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "./state/index.js";
export type {
  Applicability,
  LookupResult,
  Presence,
} from "./state/index.js";
