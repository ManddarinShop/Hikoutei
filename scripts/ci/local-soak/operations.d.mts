/**
 * Type declarations for `scripts/ci/local-soak/operations.mjs`.
 */

import type { OracleFieldSpec, SoakOracle } from "./oracle.d.mts";

/** One planned actor operation (deterministic from seed/cycle/actor/index). */
export interface PlannedOperation {
  readonly kind: string;
  readonly entityName: string;
  readonly actor: number;
  readonly opIndex: number;
  readonly cycle: number;
  readonly mutateId: string;
  readonly updateTarget: string;
  readonly deleteTarget: string;
  readonly lookupId: string;
  readonly row?: Record<string, unknown>;
  readonly extraRows?: Record<string, unknown>[];
  readonly patch?: Record<string, unknown>;
  readonly filter?: Record<string, unknown>;
  readonly orderBy?: Record<string, "asc" | "desc">;
  readonly limit?: number;
  readonly offset?: number;
}

/** All actor operation kinds, including the `expected_*` error checks. */
export const OPERATION_KINDS: readonly string[];

/** Deterministic shared (prologue) entity id: variant "main" or "churn". */
export function sharedEntityId(entityName: string, cycle: number, variant: string): string;

/** Deterministic actor-scoped entity id (disjoint across actors). */
export function actorEntityId(entityName: string, cycle: number, actor: number, opIndex: number): string;

/** Generates one deterministic synthetic value for a scalar field. */
export function generateValue(
  rng: { next(): number; int(max: number): number; chance(p: number): boolean },
  spec: OracleFieldSpec,
): unknown;

/** Builds a full row (all non-nullable fields) for one entity. */
export function generateRow(
  rng: { next(): number; int(max: number): number; chance(p: number): boolean },
  fieldPlan: Record<string, OracleFieldSpec>,
): Record<string, unknown>;

/** Builds a partial update patch over 1-2 mutable fields. */
export function generatePatch(
  rng: { next(): number; int(max: number): number; chance(p: number): boolean },
  fieldPlan: Record<string, OracleFieldSpec>,
): Record<string, unknown>;

/** Plans one actor operation deterministically. */
export function planActorOperation(input: {
  readonly seed: number;
  readonly cycle: number;
  readonly actor: number;
  readonly opIndex: number;
  readonly entityName: string;
  readonly fieldPlan: Record<string, OracleFieldSpec>;
  readonly oracle: SoakOracle;
}): PlannedOperation;

/** Generates a filter exercising the supported operator families. */
export function generateFilter(
  rng: { next(): number; int(max: number): number; chance(p: number): boolean },
  entityName: string,
  fieldPlan: Record<string, OracleFieldSpec>,
  oracle: SoakOracle,
): Record<string, unknown>;

/** Generates an orderBy that always includes the primary key. */
export function generateOrderBy(
  rng: { next(): number; int(max: number): number; chance(p: number): boolean },
  fieldPlan: Record<string, OracleFieldSpec>,
): Record<string, "asc" | "desc">;
