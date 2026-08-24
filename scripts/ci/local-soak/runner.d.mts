/**
 * Type declarations for `scripts/ci/local-soak/runner.mjs`.
 *
 * Hand-written ESM helper consumed by the soak CLI and by Vitest; these
 * declarations give the TypeScript test suite full type checking without
 * adding `scripts/**` to a `tsconfig` `include` set.
 */

import type { SoakOptions } from "./args.d.mts";

/** Redacted final soak summary (mirrors `SoakSummary` in artifacts.d.mts). */
export interface SoakRunSummary {
  readonly scenario: string;
  readonly scenarioVersion: number;
  readonly status: "passed" | "failed";
  readonly mode: "local" | "live";
  readonly stopReason: string | undefined;
  readonly seed: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMs: number;
  readonly durationBudgetMs: number;
  readonly cyclesCompleted: number;
  readonly operations: {
    readonly total: number;
    readonly ok: number;
    readonly expectedErrors: number;
    readonly failures: number;
    readonly retries: number;
  };
  readonly probes: {
    readonly total: number;
    readonly ok: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly convergence: { readonly checks: number; readonly failed: number };
  /** Dedicated scenario totals, separate from the standard operation counters. */
  readonly scenarios: { readonly expectedErrors: number; readonly failures: number };
  readonly tableRows: Readonly<Record<string, number>>;
  /** Present only when a resume reconciled an interrupted run. */
  readonly recovery?: {
    readonly status: "recovered";
    readonly cycle: number;
    readonly reason: string;
  };
  /** Present only when the final runtime close failed (run is failed). */
  readonly cleanup?: {
    readonly status: "failed";
    readonly reason: "runtime-close-failed";
    readonly errorClass: string;
    readonly code?: string;
  };
  /**
   * Present only when a replacement runtime left over from a failed
   * reopen handoff could not be closed (run is failed).
   */
  readonly replacementCleanup?: {
    readonly status: "failed";
    readonly reason: "replacement-close-failed";
    readonly errorClass: string;
    readonly code?: string;
  };
  /**
   * Present only when a final artifact write/collection step failed
   * (run is failed); `step` is a fixed runner vocabulary label.
   */
  readonly finalization?: {
    readonly status: "failed";
    readonly reason: "artifact-write-failed";
    readonly step: string;
    readonly errorClass: string;
    readonly code?: string;
  };
}

/** Extracts a spreadsheet ID from a `.../spreadsheets/d/<ID>/...` URL. */
export function parseSpreadsheetIdFromUrl(url: string): string | undefined;

/**
 * True in a plain-Node CLI process (Vitest unset) where the Vitest/Vite TS
 * loader is absent; false when Vitest is active. This is only the ENVIRONMENT
 * gate for dist fallback — the specific loader-failure shape is decided by
 * `isExpectedPlainNodeTsLoaderFailure`.
 */
export function shouldFallBackToDistOnSourceFailure(): boolean;

/**
 * True only when a `.ts` source-module load failure is the EXPECTED plain-Node
 * unsupported-TS-loader shape that may legitimately fall back to the built
 * dist module: either `ERR_UNKNOWN_FILE_EXTENSION` naming this exact `.ts`
 * source URL, or the repository's plain-Node `ERR_MODULE_NOT_FOUND` shape
 * (an internal `.js` specifier under the source tree, imported from the `.ts`
 * source). Every other code/name/message returns false so callers rethrow
 * instead of masking a real source compile/runtime/dependency error with a
 * stale dist copy.
 */
export function isExpectedPlainNodeTsLoaderFailure(
  error: unknown,
  sourceURL: URL | string,
): boolean;

/** Milliseconds left before an epoch deadline (never negative). */
export function deadlineRemainingMs(deadlineAtMs: number, nowMs?: number): number;

/** Bounded sleep honoring both a poll interval and an epoch deadline. */
export function boundedSleep(
  pollMs: number,
  deadlineAtMs: number,
  nowMs?: number,
): Promise<void>;

/** Live convergence budget per cycle (ms). */
export const CONVERGENCE_TIMEOUT_MS: number;

/**
 * Resolves the bounded CLOSE deadline an admitted cycle may run under:
 * live mode grants an already-admitted final cycle one existing
 * convergence budget past the base workload-admission deadline, local
 * mode keeps the base deadline unchanged. Overflow-safe: a base deadline
 * at/near `Number.MAX_SAFE_INTEGER` clamps to the base.
 */
export function resolveCycleDeadlineAtMs(args: {
  readonly mode: "live" | "local";
  readonly baseDeadlineAtMs: number;
}): number;

/** Poll interval of the live human-edit probe (deadline-bounded). */
export const PROBE_ACCEPT_POLL_MS: number;

/** Poll interval of the live convergence check (deadline-bounded). */
export const CONVERGENCE_POLL_MS: number;

/** SQLite-only poll cadence of the System_State drain barrier (live mode). */
export const SYSTEM_STATE_READINESS_POLL_MS: number;

/** A System_State drain readiness observation reported by the reader. */
export type SystemStateReadiness = { readonly status: "ready" | "draining" };

/** The resolved System_State readiness reader function. */
export type SystemStateReadinessReaderFn = (runtime: object) => SystemStateReadiness;

/**
 * Resolves the internal System_State readiness reader as an OPTIONAL internal
 * capability: returns the real reader when the module is present, an
 * immediate-ready no-op reader when the feature module is absent from this
 * branch, and rethrows any real source/runtime load failure. Dist fallback is
 * restricted to the expected plain-Node unsupported-TS-loader shape only
 * (never under Vitest, never for a real compile/runtime/dependency error).
 * Injectable deps let a focused test simulate a module-absent branch without
 * real files.
 */
export function resolveSystemStateReadinessReader(deps?: {
  readonly sourceURL?: URL | string;
  readonly sourceExists?: () => boolean;
  readonly distExists?: () => boolean;
  readonly loadSource?: () => Promise<unknown>;
  readonly loadDist?: () => Promise<unknown>;
  readonly canFallBackToDist?: () => boolean;
}): Promise<SystemStateReadinessReaderFn>;

/**
 * Phase 4 System_State drain barrier for one runtime: waits (SQLite-only,
 * through the internal controller) until the runtime's System_State outbox
 * drain reports ready or the phase deadline expires, whichever comes first.
 * Runtimes without a registered sync service (local-only mode, closed, or
 * a context that omits `hikoutei`) report ready immediately.
 */
export function waitForRuntimeSystemStateReadiness(
  context: { readonly hikoutei?: object } | undefined,
  phaseDeadline: number,
): Promise<void>;

/**
 * Live human-edit/CAS/conflict probe: overwrites one editable string
 * field through the User_Input tab and waits for SQLite to accept the
 * value within the phase deadline. The deadline is rechecked immediately
 * before every poll read and again before a success is accepted, so a
 * post-deadline value is recorded as failed, never as ok. Before the
 * single write it polls the User_Input tab until exactly one intended
 * identity is observable within the same phase deadline.
 */
export function runHumanEditProbe(
  context: {
    readonly cycle: number;
    readonly oracle: { applyMutation(mutation: unknown): void };
    readonly tokenByEntity: ReadonlyMap<string, unknown>;
    readonly activeEntities: readonly { readonly name: string; readonly tableName: string }[];
    readonly live: {
      readonly mode: "live";
      readonly spreadsheetId: string;
      readonly client: {
        readTabRows(
          spreadsheetId: string,
          tabName: string,
          options: { readonly deadlineAtMs: number },
        ): Promise<unknown[][]>;
        mutateInputCell(request: unknown): Promise<unknown>;
      };
    };
    readonly seed: number;
    readonly deadlineAtMs: number;
    readonly hikoutei: { readonly em: { fork(): { findOne(token: unknown, where: unknown): Promise<unknown> } } };
  },
  tablesTouched: Set<string>,
): Promise<{
  readonly record: Record<string, unknown>;
  readonly applied: { readonly entityName: string; readonly field: string; readonly value: string; readonly targetId: string } | undefined;
}>;

/**
 * Pure User_Input readiness evaluation for one intended identity, applying
 * the SAME full pre-write snapshot validation as the direct write (the
 * shared `evaluateInputPreWrite`): missing/duplicate/whitespace headers, a
 * non-empty row with a blank or non-string identity, or a duplicated
 * nonblank identity (intended or not) return `fail` with a fixed status
 * class; a structurally valid tab lacking the intended identity returns
 * `missing` (the caller may reread before the deadline); and exactly one
 * intended identity returns `ready`. `headerName` is the field the probe
 * will write.
 */
export function evaluateInputReadiness(
  rows: readonly unknown[][],
  identity: string,
  headerName: string,
): { status: "ready" } | { status: "missing" } | { status: "fail"; statusClass: string };

/**
 * Live convergence check: the observed projection id set must match the
 * oracle exactly within the phase deadline. Durable System_State
 * tombstone rows (`__typed_sheets_deleted` displayed boolean true on a
 * non-blank-id row) are retained deleted-entity history and are excluded
 * from the active id set before the comparisons run. The deadline is
 * rechecked before every read (including the final read of an iteration)
 * and again before a success is returned, so converging data observed
 * only after the deadline records a failed check, never a post-deadline
 * ok.
 *
 * Observation is batched when the client provides `readTabsRows`: one
 * request per round reads every active System tab. Clients that only
 * implement the per-tab `readTabRows` method keep the previous per-entity
 * request behavior.
 */
export function checkSheetsConvergence(
  context: {
    readonly cycle: number;
    readonly oracle: { ids(entityName: string): readonly unknown[] };
    readonly activeEntities: readonly { readonly name: string }[];
    readonly live: {
      readonly spreadsheetId: string;
      readonly client: {
        readTabsRows?(
          spreadsheetId: string,
          tabNames: readonly string[],
          options: { readonly deadlineAtMs: number },
        ): Promise<Record<string, unknown[][]>>;
        readTabRows(
          spreadsheetId: string,
          tabName: string,
          options: { readonly deadlineAtMs: number },
        ): Promise<unknown[][]>;
      };
    };
    readonly deadlineAtMs: number;
    /**
     * Runtime whose System_State drain readiness gates the first batched
     * convergence read (optional: absent means ready immediately).
     */
    readonly hikoutei?: object;
  },
  appliedProbe: {
    readonly entityName: string;
    readonly field: string;
    readonly value: string;
    readonly targetId: string;
  } | undefined,
): Promise<Record<string, unknown>>;

/**
 * True when a value is a finite epoch-millis timestamp that
 * `new Date(value).toISOString()` can safely render.
 */
export function isSafeEpochTimestampMs(value: unknown): boolean;

/** Stable recovery reasons recorded (redacted) in state/summary. */
export const RECOVERY_REASONS: Readonly<Record<string, string>>;

/**
 * Plans the resume recovery from the validated checkpoint marker.
 */
export function planResumeRecovery(
  checkpoint: { readonly version: number; readonly runId: string; readonly cycle: number; readonly status: "in-flight" | "completed" } | undefined,
  state: { readonly lastCompletedCycle: number },
  cycleRecords: ReadonlyMap<number, unknown>,
): { readonly cycle: number; readonly reason: string } | undefined;

/**
 * Closes one runtime with a final second attempt on failure; returns the
 * close error when both attempts failed, or undefined when a close
 * succeeded. `failClose` fails only the first attempt (retry recovers);
 * `failClosePersistent` fails every attempt. A close that rejects with a
 * non-Error value (including `undefined`) is a FAILED close and is
 * normalized to a stable Error, never a silent pass.
 */
export function closeRuntimeWithFinalRetry(
  runtime: { close(): Promise<unknown> },
  options?: { readonly failClose?: boolean; readonly failClosePersistent?: boolean },
): Promise<Error | undefined>;

/**
 * Opens the runtime, then verifies the open finished inside the run's
 * deadline: a startup/reopen that returns after the deadline is closed
 * (best effort) and fails with the stable `deadline_expired` class.
 */
export function openRuntimeWithinDeadline(
  open: () => Promise<{ close(): Promise<unknown> }>,
  deadlineAtMs: number | undefined,
): Promise<{ close(): Promise<unknown> }>;

/** Stable redacted error tag for progress/diagnostic lines. */
export function stableErrorTag(error: unknown): string;

/**
 * Pure deterministic replay of cycles 1..replayThrough from the stored
 * seed/params and the recorded cycle history (never from SQLite). Each
 * proven successful human-edit probe override (recorded ok probe naming
 * the deterministic round-robin target) is applied to the replay oracle
 * after that cycle's prologue/actor state and before the next cycle's
 * filters/plan are derived, so replayed plans match the plans the live
 * run executed against the edited authority.
 */
export function replayDeterministicHistory(args: {
  readonly state: {
    readonly seed: number;
    readonly mode: "local" | "live";
    readonly lastCompletedCycle: number;
    readonly params: {
      readonly actors: number;
      readonly operationsPerActor: number;
      readonly resolvedTables: readonly string[];
    };
  };
  readonly activeEntities: readonly { readonly name: string; readonly tableName: string }[];
  readonly cycleByNumber: ReadonlyMap<number, Record<string, unknown>>;
  readonly inFlightCycle?: number;
  /**
   * DB-backed probe evidence: `"<cycle>:<tableName>"` keys whose
   * authority main row contains the deterministic human-edit value.
   * Absent = JSONL-only structural grant (no oracle-mutation outputs are
   * consumed); present = an ok probe is granted ONLY with its evidence.
   */
  readonly probeEvidence?: ReadonlySet<string>;
}): {
  readonly exactRowsByTable: Map<string, Map<string, object[]>>;
  readonly prefixCycles: Array<{ cycle: number; byTable: Map<string, object> }>;
  readonly checkpointTableRows: Record<string, number>;
  readonly cycleTableRows: Map<number, Record<string, number>>;
  readonly plans: Map<string, { kind: string; entityName: string }>;
  readonly cyclePlans: Map<number, object[]>;
  /**
   * Structurally valid ok probes whose authority evidence is missing
   * (forged records with adjusted counters, unchanged DB): DB-backed
   * callers must fail closed instead of trusting them.
   */
  readonly ungrantedProbeOverrides: Array<{ cycle: number; tableName: string }>;
  readonly ambiguousAbortCycles: number[];
};

/**
 * Extracts projected ids and counts non-empty rows whose id cell is blank.
 * When `tombstoneColumn` is provided, rows with a non-blank id whose
 * tombstone cell displays boolean true are durable deleted-entity history
 * and are excluded from the active id set; blank-id rows with real content
 * still count as extra rows, and a missing/undefined `tombstoneColumn`
 * keeps the original behavior (every non-blank id is active).
 */
export function extractProjectionIds(
  rows: readonly unknown[][],
  idColumn: number,
  tombstoneColumn?: number,
): { readonly ids: unknown[]; readonly blankIdRows: number };

/** Runs the soak loop and returns the redacted summary (also written out). */
export function runLocalMultiTableSoak(options: SoakOptions): Promise<SoakRunSummary>;
