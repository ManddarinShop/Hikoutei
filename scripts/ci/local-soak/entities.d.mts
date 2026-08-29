/**
 * Type declarations for `scripts/ci/local-soak/entities.mjs`.
 *
 * Hand-written ESM helper consumed by the soak runner and by Vitest; these
 * declarations give the TypeScript test suite full type checking without
 * adding `scripts/**` to a `tsconfig` `include` set.
 */

import type { OracleFieldSpec } from "./oracle.d.mts";

/** Stable entity order used by the workload rotation and probes. */
export const SOAK_ENTITY_ORDER: readonly { readonly name: string; readonly tableName: string }[];

/** Field kinds the generator emits, keyed by entity name (synthetic values). */
export const SOAK_FIELD_PLANS: Readonly<
  Record<string, Readonly<Record<string, OracleFieldSpec>>>
>;

/** Builds the six soak entity tokens. */
export function buildSoakEntities(options?: {
  readonly suffix?: string;
}): { readonly tokens: object[]; readonly byName: ReadonlyMap<string, object> };

/** Returns the mutable (non-primary) field metadata for one entity. */
export function mutableFields(
  entityName: string,
): Array<{ readonly field: string; readonly type: string; readonly nullable?: boolean }>;

/** Returns the known soak projection table name for one entity name (or undefined). */
export function soakTableNameForEntity(entityName: string): string | undefined;
