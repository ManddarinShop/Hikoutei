/**
 * Materializes Hikoutei scalar descriptors for the current MikroORM provider.
 *
 * Entity schema/binding materialization is independent from Sheet projection
 * mapping. The public SQLite runtime uses the first part only; the internal
 * sync service supplies the second part with its private route and ownership
 * configuration.
 */

import { getEntityDescriptor } from "../../../../../api/entity.js";
import type {
  HikouteiEntity,
  ResolvedHikouteiEntityDescriptor,
  ResolvedHikouteiProperty,
} from "../../../../../api/entity.js";
import type { MappedEntityReference } from "../../../../../application/orm/mapping/contracts.js";
import { defineTypedSheetsEntityMapping } from "../../../../../application/orm/mapping/definition.js";
import type {
  TypedSheetsEntityMapping,
  TypedSheetsEntityProjectionMappingInput,
} from "../../../../../application/orm/mapping/contracts.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../../../../application/orm/errors.js";
import type {
  InternalSyncEntityConfig,
  InternalSyncProjectionConfig,
} from "../../../../../application/sync/service/contracts.js";
import {
  createMikroOrmScalarEntityRuntime,
  type MikroOrmScalarEntityRuntimeDefinition,
} from "./MikroOrmScalarEntityRuntime.js";
export type { MikroOrmScalarEntityRuntimeDefinition } from "./MikroOrmScalarEntityRuntime.js";
import { FIELD_OWNERSHIPS } from "@hikoutei/contracts/domain/model/constants.js";
import {
  NORMALIZED_CELL_KINDS,
  type NormalizedCellKind,
} from "@hikoutei/contracts/encoding/constants.js";
import { SYNC_PROJECTIONS } from "@hikoutei/contracts/sheets/constants.js";

/** Generated provider inputs for one mapped internal sync runtime. */
export interface MikroOrmScalarRuntimeDefinition extends MikroOrmScalarEntityRuntimeDefinition {
  readonly mappings: readonly TypedSheetsEntityMapping[];
}

/**
 * Adds internal projection mappings to the provider materialization.
 *
 * Routes and field ownership are service configuration, never public entity
 * metadata. Validation failures use the internal ORM mapping error contract.
 */
export function createMikroOrmScalarRuntime(
  entities: readonly HikouteiEntity[],
  sync: InternalSyncProjectionConfig,
): MikroOrmScalarRuntimeDefinition {
  const generated = createMikroOrmScalarEntityRuntime(entities);
  const bindingsByName = new Map(
    generated.bindings.map((binding) => [binding.descriptor.name, binding]),
  );
  const mappings: TypedSheetsEntityMapping[] = [];

  for (const token of entities) {
    const descriptor = getEntityDescriptor(token);
    const binding = bindingsByName.get(descriptor.name);
    const entityConfig = sync.entities[descriptor.name];
    if (binding === undefined || entityConfig === undefined) {
      throwInvalidMapping(`sync configuration is missing entity "${descriptor.name}".`);
    }
    mappings.push(createMapping(descriptor, binding.entity, entityConfig, sync.spreadsheetId));
  }

  return { ...generated, mappings };
}


function createMapping(
  descriptor: ResolvedHikouteiEntityDescriptor,
  reference: MappedEntityReference<Record<string, unknown>>,
  entityConfig: InternalSyncEntityConfig,
  spreadsheetId: string,
): TypedSheetsEntityMapping {
  const userOwnedFields = new Set(entityConfig.userOwnedFields ?? []);
  for (const field of userOwnedFields) {
    if (!descriptor.properties.some((property) => property.name === field)) {
      throwInvalidMapping(
        `sync configuration marks unknown property "${descriptor.name}.${field}" as user-owned.`,
      );
    }
  }
  if (entityConfig.userInput !== undefined && !userOwnedFields.has(descriptor.primaryKey)) {
    throwInvalidMapping(
      `User_Input for "${descriptor.name}" requires the primary key "${descriptor.primaryKey}" to be user-owned.`,
    );
  }

  const logicalSheetId = `entity:${descriptor.tableName}`;
  const projections: TypedSheetsEntityProjectionMappingInput[] = [
    {
      physicalSheetId: `${logicalSheetId}:system_state`,
      spreadsheetId,
      tabName: entityConfig.systemState.tabName,
      registeredRange: entityConfig.systemState.registeredRange,
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
    },
    ...(entityConfig.userInput === undefined ? [] : [{
      physicalSheetId: `${logicalSheetId}:user_input`,
      spreadsheetId,
      tabName: entityConfig.userInput.tabName,
      registeredRange: entityConfig.userInput.registeredRange,
      projection: SYNC_PROJECTIONS.USER_INPUT,
    }]),
  ];

  return defineTypedSheetsEntityMapping({
    entity: reference,
    entityName: descriptor.name,
    logicalSheetId,
    primaryKey: descriptor.primaryKey,
    businessKey: descriptor.primaryKey,
    schemaVersion: 1,
    canonicalEntityIdFor: (entityId: string) => `entity:${descriptor.tableName}:${entityId}`,
    entityIdFromCanonical: (entityId: string) => {
      const prefix = `entity:${descriptor.tableName}:`;
      if (!entityId.startsWith(prefix)) {
        // Existing databases may still contain the pre-namespace identity.
        // Lifecycle writes resolve their row binding first, so this fallback
        // keeps observations for those legacy rows readable during migration.
        return entityId;
      }
      const visibleEntityId = entityId.slice(prefix.length);
      if (visibleEntityId.length === 0) {
        // A legacy raw ID may itself equal the namespace prefix. New IDs cannot
        // produce this form because the public primary key is non-empty.
        return entityId;
      }
      return visibleEntityId;
    },
    fields: descriptor.properties.map((property) => ({
      property: property.name,
      cellKind: toCellKind(property),
      ownership: userOwnedFields.has(property.name)
        ? FIELD_OWNERSHIPS.USER
        : FIELD_OWNERSHIPS.SYSTEM,
      required: !property.nullable,
      unique: property.primary,
    })),
    projections,
  });
}

function toCellKind(property: ResolvedHikouteiProperty): NormalizedCellKind {
  switch (property.type) {
    case "string":
      return NORMALIZED_CELL_KINDS.STRING;
    case "number":
      return NORMALIZED_CELL_KINDS.NUMBER;
    case "boolean":
      return NORMALIZED_CELL_KINDS.BOOLEAN;
    case "date":
      return NORMALIZED_CELL_KINDS.DATE;
  }
}

function throwInvalidMapping(message: string): never {
  throw new TypedSheetsOrmError(TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING, message);
}
