/**
 * Internal shared entity-descriptor registry resolution.
 *
 * Both the public runtime factory (`createTypedSheets()`) and the internal
 * sync bootstrap validate entity token lists with the same checks: every
 * value must be a token produced by `defineTypedSheetsEntity()`, entity
 * names must be unique, and table names must be unique. This module owns
 * that single pass and returns the resolved descriptor map.
 *
 * Error creation is boundary-specific: each caller supplies an error factory
 * that maps a structured resolution failure to its own error class, code,
 * and message wording. The public boundary keeps the stable `HikouteiError`
 * codes and messages, and the sync boundary keeps `SyncServiceError`
 * `INVALID_OPTIONS` messages, so both contracts stay byte-identical.
 */

import type { ResolvedHikouteiEntityDescriptor } from "./entity.js";
import { getEntityDescriptor, HikouteiEntity } from "./entity.js";

/**
 * Structured descriptor-registry failure reported to the boundary error
 * factory.
 *
 * The resolver reports only facts (which check failed and which names
 * collided); message wording and error class/code belong to the boundary.
 */
export type EntityDescriptorResolutionFailure =
  /** A value in the list is not a `HikouteiEntity` token. */
  | { readonly kind: "invalid-token" }
  /** Two entities declare the same entity name. */
  | { readonly kind: "duplicate-name"; readonly entityName: string }
  /** Two entities share one SQLite table name. */
  | {
      readonly kind: "duplicate-table";
      readonly tableName: string;
      readonly firstEntityName: string;
      readonly secondEntityName: string;
    };

/**
 * Boundary-provided error creation.
 *
 * Maps a structured resolution failure to that boundary's error class, code,
 * and message wording, and never returns.
 */
export type EntityDescriptorResolutionErrorFactory =
  (failure: EntityDescriptorResolutionFailure) => never;

/**
 * Validates token instances and entity/table-name uniqueness once, then
 * indexes the resolved descriptors by entity name.
 *
 * Shared by the public runtime factory and the internal sync bootstrap so
 * both boundaries apply identical checks. All failure reporting is delegated
 * to `throwResolutionError`, which each boundary supplies; the returned map
 * is read-only by convention and consumed by `createEntityManager()` /
 * `createInternalHikoutei()`.
 */
export function resolveEntityDescriptors(
  entities: readonly HikouteiEntity[],
  throwResolutionError: EntityDescriptorResolutionErrorFactory,
): ReadonlyMap<string, ResolvedHikouteiEntityDescriptor> {
  const descriptors = new Map<string, ResolvedHikouteiEntityDescriptor>();
  const tablesByName = new Map<string, string>();
  for (const entity of entities) {
    if (!(entity instanceof HikouteiEntity)) {
      throwResolutionError({ kind: "invalid-token" });
    }
    const descriptor = getEntityDescriptor(entity);
    if (descriptors.has(descriptor.name)) {
      throwResolutionError({ kind: "duplicate-name", entityName: descriptor.name });
    }
    const existingTableEntity = tablesByName.get(descriptor.tableName);
    if (existingTableEntity !== undefined) {
      throwResolutionError({
        kind: "duplicate-table",
        tableName: descriptor.tableName,
        firstEntityName: existingTableEntity,
        secondEntityName: descriptor.name,
      });
    }
    descriptors.set(descriptor.name, descriptor);
    tablesByName.set(descriptor.tableName, descriptor.name);
  }
  return descriptors;
}
