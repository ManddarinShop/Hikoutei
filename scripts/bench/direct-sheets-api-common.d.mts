/**
 * Type declarations for scripts/bench/direct-sheets-api-common.mjs.
 *
 * The benchmark itself is plain ESM (not compiled by this package's
 * TypeScript build); this declaration file lets test/*.ts import the shared
 * helpers with full type checking. Keep in sync with the .mjs exports.
 */

export const BENCH_ENV_KEYS: readonly string[];

export const BENCH_HEADERS: readonly ["bench_key", "seq", "payload"];

export type BenchmarkEnvConfig = {
  credentialsPath: string;
  spreadsheetId: string;
};

export type EnvValidationError = {
  key: string;
  code: string;
  reason: string;
};

export type EnvValidationResult =
  | { status: "valid"; config: BenchmarkEnvConfig }
  | { status: "invalid"; errors: EnvValidationError[] };

export function validateBenchmarkEnv(
  env: Record<string, string | undefined>,
  readFileSync?: (path: string) => string
): EnvValidationResult;

export type BenchRow = readonly [key: string, seq: string, payload: string];

export type BuildRowsOptions = {
  runId: string;
  cellId: string;
  startSeq: number;
  count: number;
};

export function buildRows(options: BuildRowsOptions): BenchRow[];

export function percentile(sortedAscending: readonly number[], p: number): number;

export type LatencySummary = {
  count: number;
  sumMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  p50: number;
  p95: number;
  p99: number;
};

export function summarizeLatencies(samples: readonly number[]): LatencySummary;

export type ErrorClass =
  | "rate_limited"
  | "auth"
  | "permission"
  | "server_error"
  | "timeout"
  | "network"
  | "response_format"
  | "bad_request"
  | "not_found"
  | "other";

export type ClassifiedError = {
  class: ErrorClass;
  code: string | null;
};

export function classifyError(error: unknown): ClassifiedError;

export function countDuplicateKeys(
  rows: readonly unknown[]
): { unique: number; duplicates: number; total: number };

export type CompareResult = {
  compared: number;
  matched: number;
  mismatched: number;
  missing: number;
  extra: number;
};

export function compareRows(expected: readonly BenchRow[], actual: readonly (readonly unknown[])[]): CompareResult;

export type AppendResponseClassification =
  | { status: "ok"; rowsAppended: number }
  | { status: "anomaly"; class: ErrorClass; code: string; rowsAppended: number };

export function classifyAppendResponse(updatedRows: unknown, expectedRows: number): AppendResponseClassification;

export type WindowReadEvidence = {
  observed: number;
  wellFormed: number;
  malformed: number;
  known: number;
  unknownKeys: number;
  extra: number;
  missing: number;
};

export function analyzeWindowRows(options: {
  expectedAll: readonly BenchRow[];
  expectedWindow: readonly BenchRow[];
  actual: readonly (readonly unknown[])[] | undefined;
}): WindowReadEvidence;

export function aggregateErrorClasses(
  classified: readonly { class: ErrorClass; code: string | null }[]
): Partial<Record<ErrorClass, number>>;
