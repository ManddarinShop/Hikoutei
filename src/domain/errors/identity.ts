import { CoreErrorException } from "./types.js";

/**
 * Raised when one event contains the same changed field more than once.
 *
 * A duplicate field would make the event identity ambiguous, so callers must
 * reject or quarantine the observation instead of generating an event key.
 */
export class DuplicateChangedFieldError extends CoreErrorException<
  "event_identity",
  "duplicate_changed_field"
> {
  readonly fieldName: string;

  constructor(fieldName: string) {
    super(
      "event_identity",
      "duplicate_changed_field",
      `event key cannot contain duplicate field ${fieldName}`,
    );
    this.fieldName = fieldName;
  }
}
