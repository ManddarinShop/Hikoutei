/** Validates trusted resolution commands before they enter the SQL state machine. */

import { PRESENCE_KINDS } from "../../../../shared/state/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import type { NewEffect } from "../../sync/outbound/effectOutbox.js";
import type { PersistResolutionCommandInput } from "./resolutionWriterContracts.js";

/** Validates durable command identity and every effect target in the request. */
export function validateResolutionCommandInput(
  input: PersistResolutionCommandInput,
): void {
  if (input.logicalSheetId.length === 0 || input.commitId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_RESOLUTION_COMMAND,
      "logical sheet ID and resolution commit ID are required",
    );
  }
  const command = input.command;
  if (
    command.commandId.length === 0 ||
    command.requestKey.length === 0 ||
    command.actorId.length === 0 ||
    command.targetConflictId.length === 0 ||
    command.activeCandidateHash.length === 0 ||
    command.payloadHash.length === 0 ||
    !Number.isSafeInteger(command.expectedRevision) ||
    command.expectedRevision < 0 ||
    !Number.isSafeInteger(command.expectedCandidateEpoch) ||
    command.expectedCandidateEpoch < 0
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_RESOLUTION_COMMAND,
      "resolution command has an invalid durable identity or CAS input",
    );
  }

  for (const effect of allResolutionEffects(input)) {
    const isConflictControlProjection =
      effect.projection === "sync_conflicts" &&
      effect.targetKind === "conflict" &&
      effect.conflictId.kind === PRESENCE_KINDS.PRESENT &&
      effect.conflictId.value === command.targetConflictId;
    if (effect.logicalSheetId !== input.logicalSheetId && !isConflictControlProjection) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_RESOLUTION_COMMAND,
        "resolution effect belongs to a different logical sheet",
      );
    }
  }
}

function allResolutionEffects(input: PersistResolutionCommandInput): readonly NewEffect[] {
  return [
    ...input.effects,
    ...(input.staleEffects ?? []),
    ...(input.rejectedEffects ?? []),
    ...(input.duplicateEffects ?? []),
  ];
}
