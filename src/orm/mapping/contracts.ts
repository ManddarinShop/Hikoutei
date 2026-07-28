/**
 * Type contracts for entity-to-Sheets mappings.
 *
 * This file contains declarations only. Validation, indexing, projection
 * registration, and value conversion live in their respective modules.
 */

import {
  type FieldOwnership,
  type NormalizedCell,
} from "../../core/index.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
} from "../../runtime/gateway/constants.js";
import type { RegisterSyncSheetInput } from "../../storage/index.js";
import type { TypedSheetsEntityReference } from "../api/contracts.js";
import type { NormalizedCellKind } from "../../core/encoding/constants.js";

/** Physical projections supported by a mapped business entity. */
export type TypedSheetsEntityProjection =
  | typeof SYNC_GATEWAY_PROJECTIONS.USER_INPUT
  | typeof SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE;

/** A string property name declared by one mapped entity. */
export type TypedSheetsEntityProperty<Entity extends object> = Extract<keyof Entity, string>;

/** Optional codec used when a TypeScript property needs custom cell conversion. */
export interface TypedSheetsEntityFieldCodec {
  /** Converts one entity property value into a normalized Sheet cell. */
  readonly encode?: (value: unknown) => NormalizedCell;
  /** Converts one accepted canonical cell into an entity property value. */
  readonly decode?: (value: NormalizedCell) => unknown;
}

/** Input declaration for one entity property stored as a canonical field. */
export interface TypedSheetsEntityFieldMappingInput<Entity extends object>
  extends TypedSheetsEntityFieldCodec {
  /** Property on the application entity. */
  readonly property: TypedSheetsEntityProperty<Entity>;
  /** Stable canonical/Sheet field name. Defaults to `property`. */
  readonly fieldName?: string;
  /** Runtime cell type stored in canonical state and projected to Sheets. */
  readonly cellKind: NormalizedCellKind;
  /** Whether a human Sheet edit may own this business field. */
  readonly ownership: FieldOwnership;
  /** Whether blank (`null`) or an empty string is invalid. */
  readonly required?: boolean;
  /** Whether this is the one v1 business-key field. */
  readonly unique?: boolean;
}

/** Immutable routing coordinates for one physical User_Input or System_State tab. */
export interface TypedSheetsEntityProjectionMappingInput {
  readonly physicalSheetId: string;
  readonly spreadsheetId: string;
  readonly tabName: string;
  readonly registeredRange: string;
  readonly projection: TypedSheetsEntityProjection;
}

/** User-facing declaration used to construct one validated entity mapping. */
export interface TypedSheetsEntityMappingInput<Entity extends object> {
  /** Entity class or stable entity name handled by the execution engine. */
  readonly entity: TypedSheetsEntityReference<Entity>;
  /** Overrides the execution engine's class name when a stable alias is needed. */
  readonly entityName?: string;
  /** Stable logical Sheets identifier shared by its physical projections. */
  readonly logicalSheetId: string;
  /** String primary-key property used as SQLite/canonical entity identity. */
  readonly primaryKey: TypedSheetsEntityProperty<Entity>;
  /** Required unique property used by the v1 business-key index. */
  readonly businessKey: TypedSheetsEntityProperty<Entity>;
  /** Schema version registered for every physical projection of this entity. */
  readonly schemaVersion: number;
  /** Canonical business fields exposed by this mapping. */
  readonly fields: readonly TypedSheetsEntityFieldMappingInput<Entity>[];
  /** One System_State projection and, optionally, one User_Input projection. */
  readonly projections: readonly TypedSheetsEntityProjectionMappingInput[];
  /** System-only marker projected when `em.remove()` tombstones an entity. */
  readonly tombstoneFieldName?: string;
  /** Builds a deterministic projection-local row anchor from canonical identity. */
  readonly anchorForEntity?: (entityId: string) => string;
}

/** Validated mapping metadata for one canonical entity. */
export interface TypedSheetsEntityFieldMapping extends TypedSheetsEntityFieldCodec {
  readonly property: string;
  readonly fieldName: string;
  readonly cellKind: NormalizedCellKind;
  readonly ownership: FieldOwnership;
  readonly required: boolean;
  readonly unique: boolean;
}

/** Validated physical projection route. */
export interface TypedSheetsEntityProjectionMapping {
  readonly physicalSheetId: string;
  readonly spreadsheetId: string;
  readonly tabName: string;
  readonly registeredRange: string;
  readonly projection: TypedSheetsEntityProjection;
}

/** Adapter-neutral mapping consumed by the flush and observation bridges. */
export interface TypedSheetsEntityMapping {
  readonly entity: TypedSheetsEntityReference<object>;
  readonly entityName: string;
  readonly logicalSheetId: string;
  readonly primaryKey: string;
  readonly businessKey: TypedSheetsEntityFieldMapping;
  readonly schemaVersion: number;
  readonly fields: readonly TypedSheetsEntityFieldMapping[];
  readonly projections: readonly TypedSheetsEntityProjectionMapping[];
  readonly tombstoneFieldName: string;
  readonly anchorForEntity: (entityId: string) => string;
}

/** An indexed collection of validated mappings used by one typed-sheets runtime. */
export interface TypedSheetsEntityMappingRegistry {
  readonly mappings: readonly TypedSheetsEntityMapping[];
  findByEntityName(entityName: string): TypedSheetsEntityMapping | undefined;
  findByLogicalSheetId(logicalSheetId: string): TypedSheetsEntityMapping | undefined;
  findByPhysicalSheetId(physicalSheetId: string): TypedSheetsEntityMapping | undefined;
}

/** A physical projection plus its computed registry input and header schema. */
export interface TypedSheetsMappedProjectionDefinition {
  readonly mapping: TypedSheetsEntityMapping;
  readonly projection: TypedSheetsEntityProjectionMapping;
  readonly registration: RegisterSyncSheetInput;
  readonly headers: readonly string[];
}
