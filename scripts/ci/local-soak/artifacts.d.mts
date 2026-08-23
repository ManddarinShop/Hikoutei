/**
 * Type declarations for `scripts/ci/local-soak/artifacts.mjs`.
 */

/** Artifact file names inside the output directory. */
export const ARTIFACT_NAMES: Readonly<Record<string, string>>;

/** Writer bound to one output directory. */
export interface SoakArtifactWriter {
  readonly dir: string;
  readonly paths: Readonly<Record<string, string>>;
  ensure(): Promise<void>;
  /** Appends one JSONL record; never follows a pre-existing symlink at the stream path. */
  appendJsonl(key: string, record: unknown): Promise<void>;
  /** Atomically writes one JSON document (temp file + rename); never follows a pre-existing symlink at the artifact or staging path. */
  writeJson(key: string, value: unknown): Promise<void>;
  /** Atomically writes the recovery checkpoint marker (temp file + rename); never follows a pre-existing symlink. */
  writeCheckpoint(marker: { readonly version: number; readonly runId: string; readonly cycle: number; readonly status: "in-flight" | "completed" }): Promise<void>;
  /** Writes the Markdown summary; never follows a pre-existing symlink at the artifact path. */
  writeMarkdown(value: string): Promise<void>;
  /**
   * Collects the internal library log (current + rotated `.txt` backups,
   * oldest first) into `collected-log.txt`. Only canonical logger-created
   * backups are matched: `<base>.<N>.txt` with N the canonical positive
   * decimal integer in [1, retention] (default: the effective
   * `HIKOUTEI_LOG_BACKUPS`, mirror of the logger contract; pass `backups`
   * to pin it), matched in EXACT case — `.0.txt`, leading-zero,
   * beyond-retention numeric files, and case variants (base-name or
   * suffix) are never read. The reserved `collected-log.txt` is written
   * atomically (temp + rename), replacing any pre-existing symlink at
   * that name rather than following it. A blank/whitespace log path
   * (logging disabled) yields an empty collection; a log path inside the
   * output dir must also be contained by real path (symlinked log
   * dirs/files escaping the real output dir are never read). Lexically
   * external custom `--log-file` paths are collected as-is.
   */
  collectInternalLog(options?: {
    readonly logFile?: string;
    readonly backups?: number;
  }): Promise<{ readonly lines: number }>;
  databaseSizeBytes(dbPath: string): Promise<number>;
  /**
   * Removes runner-owned per-run artifacts for a FRESH run so a reused
   * output directory never leaks prior cycle history, a previous run
   * identity, stale SQLite rows, or old resume documents: the JSONL
   * streams (`cycles.jsonl`, `operations.jsonl`, `resources.jsonl`), the
   * SQLite authority plus its `-wal`/`-journal`/`-shm` sidecars, AND the
   * resume documents `state.json`/`checkpoint.json` (HIGH 3 — removed,
   * never merely overwritten, so a fresh-run crash window can never be
   * mistaken for a resumable continuation). Everything is resolved
   * inside the writer's output dir. Logger-owned log files are NOT
   * touched here; they belong to `resetLoggerFiles`. Only a true
   * `--resume` preserves all of these documents — this reset never runs
   * on the resume path.
   */
  resetRunArtifacts(): Promise<void>;
  /**
   * Clears logger-owned current+rotated files for a fresh run (only when
   * the log lives inside the output dir by BOTH lexical and real path;
   * external logs and symlink-escaping dirs are untouched; a blank log
   * path clears nothing). Only canonical logger-created backups are
   * cleared: `<base>.<N>.txt` with N in [1, retention], exact case —
   * never `.0.txt`, leading-zero, beyond-retention numeric files, or
   * case variants.
   */
  resetLoggerFiles(options?: {
    readonly logFile?: string;
    readonly backups?: number;
  }): Promise<{ readonly removed: number }>;
}

/** Creates the artifact writer for one output directory. */
export function createArtifactWriter(
  outputDir: string,
  progress: (message: string) => void,
): SoakArtifactWriter;

/**
 * Normalizes an extensionless custom log path to `.txt` (logger contract);
 * returns `undefined` for blank/whitespace values (logging disabled).
 */
export function normalizeSoakLogFilePath(filePath: string): string | undefined;

/**
 * Builds one unique staging path for an artifact target:
 * `<target>.tmp-<pid>-<seq>`. Exported for the symlink regression tests
 * to plant a link at the exact next candidate name; production callers
 * use the writer's own per-write sequence.
 */
export function uniqueStagingPath(targetPath: string, sequence: number): string;

/** Builds one redacted operation record for `operations.jsonl`. */
export function operationRecord(
  cycle: number,
  actorIndex: number,
  op: { readonly opIndex: number; readonly kind: string; readonly entityName: string },
  result: {
    readonly status: string;
    readonly code?: string;
    readonly reason?: string;
    readonly counts?: Record<string, number>;
    readonly durationMs?: number;
  },
): Record<string, unknown>;

/** Cycle summary input for `cycleRecord`. */
export interface CycleSummaryInput {
  readonly durationMs: number;
  readonly tablesTouched: readonly string[];
  readonly operations: {
    readonly total: number;
    readonly ok: number;
    readonly expectedErrors: number;
    readonly failures: number;
    readonly retries: number;
  };
  readonly probe?: Record<string, unknown>;
  readonly convergence?: Record<string, unknown>;
  readonly reopen?: Record<string, unknown>;
  readonly abort?: Record<string, unknown>;
  readonly scenarioTotals?: { readonly expectedErrors: number; readonly failures: number };
  readonly scenarios?: readonly Record<string, unknown>[];
}

/** Builds one redacted cycle record for `cycles.jsonl`. */
export function cycleRecord(cycle: number, summary: CycleSummaryInput): Record<string, unknown>;

/** Samples process resources for `resources.jsonl`. */
export function resourceRecord(cycle: number, dbSizeBytes: number): Promise<Record<string, unknown>>;

/** Redacted final summary shape rendered by `renderSummaryMarkdown`. */
export interface SoakSummary {
  readonly scenario: string;
  readonly scenarioVersion: number;
  readonly status: "passed" | "failed";
  readonly mode: string;
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

/** Renders the Markdown summary (redacted). */
export function renderSummaryMarkdown(summary: SoakSummary): string;
