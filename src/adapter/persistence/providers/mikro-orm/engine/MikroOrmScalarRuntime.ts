/**
 * Materializes Hikoutei scalar descriptors for the current MikroORM provider.
 *
 * The generated EntitySchema/classes and Sheet mappings are adapter details.
 * Applications keep the descriptor token and route configuration, so a future
 * Prisma provider can replace this module without changing EntityManager code.
 */

import { defineEntity, p } from "@mikro-orm/sql";

import { getEntityDescriptor } from "../../../../../api/entity.js";
import type {
  HikouteiEntity,
  ResolvedHikouteiEntityDescriptor,
  ResolvedHikouteiProperty,
} from "../../../../../api/entity.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "../../../../../api/errors.js";
import type { HikouteiEntityRoutes } from "../../../../../api/Hikoutei.js";
import type { TypedSheetsEntityReference } from "../../../../../application/orm/api/contracts.js";
import { defineTypedSheetsEntityMapping } from "../../../../../application/orm/mapping/definition.js";
import type {
  TypedSheetsEntityMapping,
  TypedSheetsEntityProjectionMappingInput,
} from "../../../../../application/orm/mapping/contracts.js";
import type { MikroOrmSqliteEntity } from "../storage/MikroOrmSqliteAdapter.js";
import type { MikroOrmScalarEntityBinding } from "../api/MikroOrmScalarPersistenceProvider.js";
import { FIELD_OWNERSHIPS } from "../../../../../domain/model/constants.js";
import { NORMALIZED_CELL_KINDS, type NormalizedCellKind } from "../../../../../shared/encoding/constants.js";

/** Generated provider inputs for one public scalar runtime. */
export interface MikroOrmScalarRuntimeDefinition {
  readonly entities: readonly MikroOrmSqliteEntity[];
  readonly bindings: readonly MikroOrmScalarEntityBinding[];
  readonly mappings: readonly TypedSheetsEntityMapping[];
}

/**
 * Converts public descriptors and routes into current-provider entities and
 * the existing canonical/outbox mapping declarations.
 */
export function createMikroOrmScalarRuntime(
  entities: readonly HikouteiEntity[],
  routes: ReadonlyMap<string, HikouteiEntityRoutes>,
  spreadsheetId: string,
): MikroOrmScalarRuntimeDefinition {
  const generatedEntities: MikroOrmSqliteEntity[] = [];
  const bindings: MikroOrmScalarEntityBinding[] = [];
  const mappings: TypedSheetsEntityMapping[] = [];

  for (const token of entities) {
    const descriptor = getEntityDescriptor(token);
    const route = routes.get(descriptor.name);
    if (route === undefined) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.INVALID_SHEET_ROUTE,
        `sheet routes are missing for entity "${descriptor.name}".`,
      );
    }
    if (route.userInput !== undefined && !descriptor.properties.some(
      (property) => property.primary && property.editable,
    )) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.INVALID_SHEET_ROUTE,
        `User_Input for "${descriptor.name}" requires an editable primary id because v1 uses id as its business key.`,
      );
    }

    const schema = defineEntity({
      name: descriptor.name,
      tableName: descriptor.tableName,
      properties: createMikroProperties(descriptor.properties),
    } as never);
    const GeneratedEntity = class extends schema.class {};
    schema.setClass(GeneratedEntity);
    const reference = GeneratedEntity as unknown as TypedSheetsEntityReference<object>;
    generatedEntities.push(schema);
    bindings.push({ descriptor, entity: reference });
    mappings.push(createMapping(descriptor, reference, route, spreadsheetId));
  }

  return { entities: generatedEntities, bindings, mappings };
}

function createMikroProperties(
  properties: readonly ResolvedHikouteiProperty[],
): Record<string, unknown> {
  return Object.fromEntries(properties.map((property) => {
    let builder: unknown;
    switch (property.type) {
      case "number":
        builder = p.float();
        break;
      case "boolean":
        builder = p.boolean();
        break;
      case "string":
      case "date":
        // Dates use canonical ISO text in the provider bridge. This avoids
        // provider-specific Date conversion while the public value remains Date.
        builder = p.string();
        break;
    }
    if (property.primary) {
      builder = (builder as { primary(): unknown }).primary();
    }
    if (property.nullable) {
      builder = (builder as { nullable(): unknown }).nullable();
    }
    return [property.name, builder];
  }));
}

function createMapping(
  descriptor: ResolvedHikouteiEntityDescriptor,
  reference: TypedSheetsEntityReference<object>,
  route: HikouteiEntityRoutes,
  spreadsheetId: string,
): TypedSheetsEntityMapping {
  const logicalSheetId = `entity:${descriptor.tableName}`;
  const projections: TypedSheetsEntityProjectionMappingInput[] = [
    {
      physicalSheetId: `${logicalSheetId}:system_state`,
      spreadsheetId,
      tabName: route.systemState.tabName,
      registeredRange: route.systemState.registeredRange,
      projection: "system_state" as const,
    },
    ...(route.userInput === undefined ? [] : [{
      physicalSheetId: `${logicalSheetId}:user_input`,
      spreadsheetId,
      tabName: route.userInput.tabName,
      registeredRange: route.userInput.registeredRange,
      projection: "user_input" as const,
    }]),
  ];

  return defineTypedSheetsEntityMapping({
    entity: reference,
    entityName: descriptor.name,
    logicalSheetId,
    primaryKey: descriptor.primaryKey,
    businessKey: descriptor.primaryKey,
    schemaVersion: 1,
    fields: descriptor.properties.map((property) => ({
      property: property.name,
      cellKind: toCellKind(property),
      ownership: property.editable ? FIELD_OWNERSHIPS.USER : FIELD_OWNERSHIPS.SYSTEM,
      required: !property.nullable,
      unique: property.primary,
    })),
    projections,
  } as never);
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
