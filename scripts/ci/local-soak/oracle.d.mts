/**
 * Type declarations for `scripts/ci/local-soak/oracle.mjs`.
 */

/** Field plan shape shared with `entities.mjs`. */
export interface OracleFieldSpec {
  readonly type: "string" | "number" | "boolean" | "date";
  readonly primary?: boolean;
  readonly nullable?: boolean;
}

/** One oracle mutation. */
export type OracleMutation =
  | { readonly op: "insert"; readonly entity: string; readonly row: Record<string, unknown> }
  | { readonly op: "update"; readonly entity: string; readonly id: string; readonly patch: Record<string, unknown> }
  | { readonly op: "delete"; readonly entity: string; readonly id: string }
  | { readonly op: "replace"; readonly entity: string; readonly id: string; readonly row: Record<string, unknown> };

/** Query shape accepted by the oracle (public EntityManager semantics). */
export interface OracleQuery {
  readonly where?: Record<string, unknown>;
  readonly orderBy?: Record<string, "asc" | "desc">;
  readonly limit?: number;
  readonly offset?: number;
}

/** Deterministic in-memory mirror of the public query semantics. */
export class SoakOracle {
  constructor(
    fieldPlans: Record<string, Record<string, OracleFieldSpec>>,
  );
  /** Applies one mutation; returns true when the visible state changed. */
  applyMutation(mutation: OracleMutation): boolean;
  /** Live row ids for one entity (unordered). */
  ids(entityName: string): string[];
  /** Live row count for one entity. */
  size(entityName: string): number;
  /** Live row snapshot (defensive copy) for one id, or undefined. */
  row(entityName: string, id: string): Record<string, unknown> | undefined;
  /** Evaluates one query, returning ordered ids and the pre-paging total. */
  query(
    entityName: string,
    query: OracleQuery,
  ): { readonly ids: string[]; readonly total: number };
}

/** SQLite LIKE semantics for the ASCII soak data (`%` and `_`). */
export function sqlLikeMatch(value: string, pattern: string): boolean;
