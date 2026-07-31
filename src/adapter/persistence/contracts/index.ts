/** Adapter-neutral persistence contracts grouped by storage capability. */

export type {
  SqlExecutor,
  SqlGeneratedId,
  SqlMutationResult,
  SqlParameter,
  SqlStorageAdapter,
  SqlStorageContext,
} from "./sql.js";
export type {
  ScalarEntityColumnDefinition,
  ScalarEntityDelete,
  ScalarEntityInsert,
  ScalarEntityPersistenceProvider,
  ScalarEntityQuery,
  ScalarEntityRow,
  ScalarEntityStorageType,
  ScalarEntityTableDefinition,
  ScalarEntityTransaction,
  ScalarEntityUpdate,
  ScalarEntityValue,
} from "./scalar.js";
