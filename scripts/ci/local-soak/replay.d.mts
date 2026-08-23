/**
 * Type declarations for `scripts/ci/local-soak/replay.mjs`.
 *
 * Declares the deterministic replay facade's public planning surface. The
 * offline tests consume only `replayDeterministicHistory`; the facade also
 * re-exports the verification surface from `replayVerify.mjs` for the live
 * resume paths, which are out of scope here.
 */

/** The persisted run state a deterministic replay reproduces. */
export interface ReplayState {
  readonly seed: number;
  readonly mode: string;
  readonly lastCompletedCycle: number;
  readonly params: {
    readonly actors: number;
    readonly operationsPerActor: number;
    readonly resolvedTables: readonly string[];
  };
  readonly cumulative: Record<string, unknown>;
  readonly tableRows: Record<string, unknown>;
}

/** The deterministic replay result for a window of cycles. */
export interface ReplayResult {
  readonly cyclePlans: ReadonlyMap<number, readonly Record<string, unknown>[]>;
}

/**
 * Replays the deterministic per-cycle operation plans for a run state.
 * Pure function of the stored seed/params; never touches SQLite or Sheets.
 */
export function replayDeterministicHistory(input: {
  readonly state: ReplayState;
  readonly activeEntities: readonly { readonly name: string; readonly tableName: string }[];
  readonly cycleByNumber: ReadonlyMap<number, object>;
  readonly inFlightCycle?: number | undefined;
}): ReplayResult;
