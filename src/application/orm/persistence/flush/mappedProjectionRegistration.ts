/** Registers mapped projection routes and adapts them for gateway provisioning. */

import {
  registerTypedSheetsPersistenceRoutesWithAdapter,
  type RegisteredSyncSheet,
} from "../../../../infrastructure/storage/index.js";
import type { RegisteredSyncProjectionDefinition } from "../../../sync/gateway/SyncGatewayBootstrap.js";
import type { SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import {
  createTypedSheetsMappedProjectionDefinitions,
  type TypedSheetsEntityMapping,
  type TypedSheetsEntityMappingRegistry,
} from "../../mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";
import type {
  RegisteredTypedSheetsMappedProjection,
  TypedSheetsEntityWriterOptions,
} from "../support/contracts.js";
import { resolveTypedSheetsEntityWriterOptions } from "./mappedWriterOptions.js";
import { resolveTypedSheetsEntityMappingRegistry } from "./mappedMappingRegistry.js";

/**
 * Registers every mapping route under one writer fence.
 *
 * The result can be passed directly to gateway provisioning, so callers do
 * not need to duplicate generated route names or header lists.
 */
export async function registerTypedSheetsEntityMappings(
  storage: SqlStorageAdapter,
  mappingsInput: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[],
  writerInput: TypedSheetsEntityWriterOptions,
): Promise<readonly RegisteredTypedSheetsMappedProjection[]> {
  const mappings = resolveTypedSheetsEntityMappingRegistry(mappingsInput);
  const writer = resolveTypedSheetsEntityWriterOptions(writerInput);
  const definitions = createTypedSheetsMappedProjectionDefinitions(mappings.mappings);

  const result = await registerTypedSheetsPersistenceRoutesWithAdapter(storage, {
    role: writer.role,
    writerId: writer.writerId,
    leaseDurationMs: writer.leaseDurationMs,
    now: writer.now(),
  }, definitions.map((definition) => definition.registration));
  if (result.kind !== "registered") {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
      "mapped projection registration lease is unavailable.",
    );
  }

  return result.sheets.map((sheet, index) => registeredProjection(definitions, sheet, index));
}

/** Converts registered mapping routes into gateway provisioning definitions. */
export function registeredTypedSheetsProjectionDefinitions(
  registrations: readonly RegisteredTypedSheetsMappedProjection[],
): readonly RegisteredSyncProjectionDefinition[] {
  return registrations.map(({ sheet, headers }) => ({ sheet, headers }));
}

function registeredProjection(
  definitions: ReturnType<typeof createTypedSheetsMappedProjectionDefinitions>,
  sheet: RegisteredSyncSheet,
  index: number,
): RegisteredTypedSheetsMappedProjection {
  const definition = definitions[index];
  if (definition === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "mapped projection registration result count does not match its definitions.",
    );
  }
  return {
    mapping: definition.mapping,
    sheet,
    headers: definition.headers,
  };
}
