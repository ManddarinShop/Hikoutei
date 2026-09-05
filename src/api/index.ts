/**
 * Public surface for the Hikoutei typed repository.
 *
 * This barrel is the only application-facing entrypoint. It exposes the stable
 * entity-lifecycle API — `defineTypedSheetsEntity`, `createTypedSheets`, the
 * `Hikoutei` runtime, the `EntityManager`, and the typed errors — plus the
 * sync auto-start entrypoint `createTypedSheetsWithSync()` with existing-sheet
 * adoption support (result union + read-only adoption report types; the sync
 * service graph itself stays lazy-loaded and internal).
 */

export {
  defineTypedSheetsEntity,
  HIKOUTEI_SCALAR_TYPES,
} from "./entity.js";
export type {
  HikouteiEntity,
  HikouteiEntityDescriptorInput,
  HikouteiPropertyOptions,
  HikouteiPropertyDescriptorMap,
  HikouteiScalarType,
  HikouteiScalarValueType,
  HikouteiPropertyValueType,
  HikouteiEntityInstance,
} from "./entity.js";
export { createTypedSheets } from "./Hikoutei.js";
export type { CreateTypedSheetsOptions, HikouteiProviderOptions, Hikoutei } from "./Hikoutei.js";
export { createTypedSheetsWithSync } from "./syncRuntime.js";
export type {
  CreateTypedSheetsWithSyncOptions,
  AdoptSpec,
  AdoptEntitySpec,
  AdoptionRunReport,
  AdoptionEntityReport,
  AdoptionColumnBinding,
  AdoptionProblem,
  LocalSyncRuntimeResult,
  RunningSyncServiceResult,
  AdoptDryRunResult,
  TypedSheetsWithSyncResult,
} from "./syncRuntime.js";
export type {
  EntityManager,
  HikouteiFilter,
  HikouteiFindOneOptions,
  HikouteiFindOptions,
  HikouteiOperatorFilter,
  HikouteiOrderBy,
  HikouteiSortDirection,
} from "./EntityManager.js";
export { HIKOUTEI_ERROR_CODES, HikouteiError } from "./errors.js";
export type { HikouteiErrorCode } from "./errors.js";
