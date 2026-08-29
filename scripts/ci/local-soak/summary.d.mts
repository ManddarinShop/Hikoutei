/**
 * Type declarations for `scripts/ci/local-soak/summary.mjs`.
 */

/** Redacted final soak summary (mirrors `SoakRunSummary` in runner.d.mts). */
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
  readonly recovery?: {
    readonly status: "recovered";
    readonly cycle: number;
    readonly reason: string;
  };
  readonly cleanup?: {
    readonly status: "failed";
    readonly reason: "runtime-close-failed";
    readonly errorClass: string;
    readonly code?: string;
  };
  readonly replacementCleanup?: {
    readonly status: "failed";
    readonly reason: "replacement-close-failed";
    readonly errorClass: string;
    readonly code?: string;
  };
  readonly finalization?: {
    readonly status: "failed";
    readonly reason: "artifact-write-failed";
    readonly step: string;
    readonly errorClass: string;
    readonly code?: string;
  };
}

/** Builds the redacted final summary object. */
export function buildSummary(input: {
  readonly state: {
    readonly seed: number;
    readonly startedAtMs: number;
    readonly lastCompletedCycle: number;
    readonly params: { readonly durationMs: number };
    readonly cumulative: {
      readonly operations: number;
      readonly expectedErrors: number;
      readonly failures: number;
      readonly retries: number;
      readonly probes: {
        readonly total: number;
        readonly ok: number;
        readonly skipped: number;
        readonly failed: number;
      };
      readonly convergenceChecks: number;
      readonly convergenceFailed: number;
      readonly scenarioExpectedErrors?: number;
      readonly scenarioFailures?: number;
    };
    readonly tableRows: Readonly<Record<string, number>>;
    readonly recovery?: { readonly cycle: number; readonly reason: string };
  };
  readonly stopReason: string | undefined;
  readonly startedClock: number;
  readonly live: { readonly mode: "local" | "live" };
  readonly closeError?: Error | undefined;
  readonly replacementCloseError?: Error | undefined;
  readonly finalizationFailures?: ReadonlyArray<{ readonly label: string; readonly error: unknown }>;
}): SoakRunSummary;
