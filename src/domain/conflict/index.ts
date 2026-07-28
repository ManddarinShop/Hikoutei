export {
  CONFLICT_TRANSITION_KINDS,
  shouldRebaseConflict,
  applyResolution,
} from "./transitions.js";
export type {
  ConflictTransitionKind,
  ConflictTransitionResult,
} from "./transitions.js";
export {
  createAlreadyResolvedError,
  createConflictIdMismatchError,
  createInvalidResolutionRoleError,
  createUnsupportedResolutionActionError,
} from "./errors.js";
export type {
  ConflictResolutionError,
  ConflictResolutionErrorCode,
  UnsupportedResolutionActionError,
  InvalidResolutionRoleError,
  ConflictIdMismatchError,
  AlreadyResolvedError,
} from "./errors.js";
