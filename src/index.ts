/**
 * Application-facing typed-sheets API.
 *
 * Persistence engines, storage helpers, and gateway implementations stay
 * behind provider or internal module boundaries. Applications should define
 * entities and open the SQLite-authoritative runtime through this surface.
 */

export { TypedSheetsEntityManager, TypedSheetsOrm } from "./application/orm/api/TypedSheetsOrm.js";
export { createTypedSheets } from "./application/orm/api/createTypedSheets.js";
export {
  defineTypedSheetsEntity,
  TYPED_SHEETS_RELATION_KINDS,
  TYPED_SHEETS_SCALAR_TYPES,
} from "./application/orm/api/entityDefinition.js";
export {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "./application/orm/errors.js";

export type {
  CreateTypedSheetsOptions,
  TypedSheetsEntitySyncOptions,
  TypedSheetsSheetRouteOptions,
  TypedSheetsSyncOptions,
} from "./application/orm/api/factoryContracts.js";
export type {
  DefineTypedSheetsEntityInput,
  InferTypedSheetsEntity,
  TypedSheetsEntityDefinition,
  TypedSheetsManyToOnePropertyDefinition,
  TypedSheetsOneToManyPropertyDefinition,
  TypedSheetsPropertyDefinition,
  TypedSheetsPropertyValue,
  TypedSheetsRelationKind,
  TypedSheetsScalarPropertyDefinition,
  TypedSheetsScalarType,
} from "./application/orm/api/entityDefinition.js";
export type {
  TypedSheetsEntityClass,
  TypedSheetsEntityData,
  TypedSheetsEntityFilter,
  TypedSheetsEntityReference,
  TypedSheetsFindOptions,
  TypedSheetsForkOptions,
} from "./application/orm/api/contracts.js";
export type { TypedSheetsOrmErrorCode } from "./application/orm/errors.js";
