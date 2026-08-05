/**
 * Public surface for the Hikoutei typed repository.
 *
 * This barrel is the only application-facing entrypoint. It exposes the stable
 * entity-lifecycle API — `defineTypedSheetsEntity`, `createTypedSheets`, the
 * `Hikoutei` runtime, the `EntityManager`, and the typed errors — and nothing
 * else. Sheet synchronization, storage, provider, ORM, and protocol types are
 * internal service implementation details.
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
export type { CreateTypedSheetsOptions, Hikoutei } from "./Hikoutei.js";
export type { EntityManager, HikouteiFindOptions } from "./EntityManager.js";
export { HIKOUTEI_ERROR_CODES, HikouteiError } from "./errors.js";
export type { HikouteiErrorCode } from "./errors.js";
