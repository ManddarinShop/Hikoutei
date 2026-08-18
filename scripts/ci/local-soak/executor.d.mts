/**
 * Type declarations for `scripts/ci/local-soak/executor.mjs`.
 *
 * Hand-written ESM helper consumed by the soak runner and by Vitest; these
 * declarations give the TypeScript test suite full type checking without
 * adding `scripts/**` to a `tsconfig` `include` set.
 */

import type { OracleFieldSpec, SoakOracle } from "./oracle.d.mts";
import type { PlannedOperation } from "./operations.d.mts";

/** Stable error codes the workload treats as expected validation results. */
export const EXPECTED_ERROR_CODES: Readonly<Record<string, string>>;

/** Explicit allowlist of every stable error code the soak records. */
export const KNOWN_STABLE_CODES: readonly string[];

/** Maps a candidate error code to the artifact-safe value (`unknown`). */
export function sanitizeStableCode(candidate: unknown): string;

/** Stable redacted failure categories recorded in artifacts. */
export const FAILURE_REASON_CODES: Readonly<Record<string, string>>;

/** Context handed to one operation execution. */
export interface ExecutorContext {
  readonly em: {
    fork(): unknown;
    create(entity: unknown, data: Record<string, unknown>): unknown;
    persist(input: unknown): unknown;
    findOne(entity: unknown, where: Record<string, unknown>): Promise<unknown>;
    find(entity: unknown, where: Record<string, unknown>, options?: unknown): Promise<readonly unknown[]>;
    findAndCount(entity: unknown, where: Record<string, unknown>): Promise<readonly [readonly unknown[], number]>;
    count(entity: unknown, where: Record<string, unknown>): Promise<number>;
    remove(entity: unknown): unknown;
    flush(): Promise<void>;
    transactional<T>(operation: (manager: unknown) => Promise<T>): Promise<T>;
  };
  readonly rootEm: {
    fork(): unknown;
  };
  readonly oracle: SoakOracle;
  readonly tokenByEntity: ReadonlyMap<string, unknown>;
  readonly fieldPlans: Readonly<Record<string, Readonly<Record<string, OracleFieldSpec>>>>;
  /**
   * True during replay of an interrupted cycle: create-type mutations
   * accept already-committed deterministic rows instead of duplicating.
   */
  readonly reconcile?: boolean;
}

/** One redacted executor result. */
export interface ExecutorResult {
  readonly status: "ok" | "expected_error" | "failed";
  readonly code?: string;
  readonly reason?: string;
  readonly counts?: Record<string, number>;
  readonly durationMs: number;
}

/** Executes one planned operation; never throws. */
export function executeActorOperation(
  op: PlannedOperation,
  ctx: ExecutorContext,
): Promise<ExecutorResult>;

/** Field-by-field row comparison (dates by epoch millis); throws on mismatch. */
export function assertRowMatches(
  expectedRow: Record<string, unknown>,
  actualRow: Record<string, unknown>,
  fieldPlan: Readonly<Record<string, unknown>>,
): void;

/**
 * True when a live row's field values equal an expected deterministic row
 * (dates by epoch millis); used by replay reconciliation.
 */
export function rowValuesEqual(
  expectedRow: Record<string, unknown>,
  actualRow: Record<string, unknown>,
  fieldPlan: Readonly<Record<string, unknown>>,
): boolean;

/** Executor-owned assertion failure carrying a stable redacted category. */
export class SoakAssertionError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string);
}
