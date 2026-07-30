/** Public façade for canonical and conflict mutations produced by observation. */

export {
  applyCanonicalMutationWithSql,
  requirePersistedOutcome,
} from "./observationCanonicalMutation.js";
export { persistConflictAttemptsWithSql } from "./observationConflictPersistence.js";
