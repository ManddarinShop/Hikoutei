import type { CoreError } from "../errors/types.js";
import type { Presence } from "../../shared/state/types.js";

/** Stable rejection codes returned by conflict-resolution CAS decisions. */
export type ConflictResolutionErrorCode =
  | "unsupported_action"
  | "invalid_role"
  | "conflict_id_mismatch"
  | "already_resolved";

interface ConflictResolutionErrorBase extends CoreError {
  readonly domain: "conflict_resolution";
}

/** Resolution action was not supported by this core version. */
export interface UnsupportedResolutionActionError extends ConflictResolutionErrorBase {
  readonly code: "unsupported_action";
  readonly action: string;
}

/** The actor role cannot submit the requested resolution action. */
export interface InvalidResolutionRoleError extends ConflictResolutionErrorBase {
  readonly code: "invalid_role";
  readonly role: string;
}

/** The command targets a different conflict than the one being transitioned. */
export interface ConflictIdMismatchError extends ConflictResolutionErrorBase {
  readonly code: "conflict_id_mismatch";
  readonly targetConflictId: string;
  readonly actualConflictId: string;
}

/** A different command already resolved the conflict. */
export interface AlreadyResolvedError extends ConflictResolutionErrorBase {
  readonly code: "already_resolved";
  readonly conflictId: string;
  readonly existingResolutionCommandId: Presence<string>;
  readonly commandId: string;
}

/** Structured rejection details for a conflict-resolution command. */
export type ConflictResolutionError =
  | UnsupportedResolutionActionError
  | InvalidResolutionRoleError
  | ConflictIdMismatchError
  | AlreadyResolvedError;

/** Creates a stable error value for an unsupported resolution action. */
export function createUnsupportedResolutionActionError(
  action: string,
): UnsupportedResolutionActionError {
  return {
    domain: "conflict_resolution",
    code: "unsupported_action",
    action,
  };
}

/** Creates a stable error value for an unauthorized resolution role. */
export function createInvalidResolutionRoleError(role: string): InvalidResolutionRoleError {
  return {
    domain: "conflict_resolution",
    code: "invalid_role",
    role,
  };
}

/** Creates a stable error value when a command targets another conflict. */
export function createConflictIdMismatchError(
  targetConflictId: string,
  actualConflictId: string,
): ConflictIdMismatchError {
  return {
    domain: "conflict_resolution",
    code: "conflict_id_mismatch",
    targetConflictId,
    actualConflictId,
  };
}

/** Creates a stable error value when another command already resolved a conflict. */
export function createAlreadyResolvedError(
  conflictId: string,
  existingResolutionCommandId: Presence<string>,
  commandId: string,
): AlreadyResolvedError {
  return {
    domain: "conflict_resolution",
    code: "already_resolved",
    conflictId,
    existingResolutionCommandId,
    commandId,
  };
}
