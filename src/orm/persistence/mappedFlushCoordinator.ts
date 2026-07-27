/**
 * Backward-compatible persistence entrypoint.
 *
 * The mapped flush implementation is split by responsibility, but existing
 * imports from `mappedFlushCoordinator.ts` remain valid for callers and tests.
 */

export {
  createMappedTypedSheetsFlushCoordinator,
  registerTypedSheetsEntityMappings,
  registeredTypedSheetsProjectionDefinitions,
} from "./flushCoordinator.js";
export type {
  CreateMappedTypedSheetsFlushCoordinatorOptions,
  RegisteredTypedSheetsMappedProjection,
  TypedSheetsEntityWriterOptions,
} from "./contracts.js";
