/**
 * Type declarations for scripts/bench/direct-sheets-api-batch-update-common.mjs.
 *
 * The benchmark itself is plain ESM (not compiled by this package's
 * TypeScript build); this declaration file lets test/*.ts import the shared
 * helpers with full type checking. Keep in sync with the .mjs exports.
 */
import type { BenchRow, ErrorClass } from "./direct-sheets-api-common.mjs";

export const TOTAL_RECORDS: number;

export const DEFAULT_TAB_COUNTS: readonly number[];

export const BENCH_COLUMNS: number;

export const DATA_FIRST_ROW_INDEX: number;

export const BATCH_WRITE_APIS: readonly ["updateCells", "valuesBatchUpdate"];

export const DEFAULT_SCENARIO_SEED: number;

export type TabPlan = {
  tabIndex: number;
  rowCount: number;
  startSeq: number;
};

export type TabDistributionValid = {
  status: "valid";
  totalRows: number;
  tabCount: number;
  rowsPerTab: number;
  tabs: readonly TabPlan[];
};

export type TabDistributionInvalid = { status: "invalid"; reason: string };

export function planTabDistribution(options: {
  tabCount: number;
  totalRows?: number;
}): TabDistributionValid | TabDistributionInvalid;

export function buildTabRows(options: {
  runId: string;
  attemptMarker: string;
  tabIndex: number;
  rowCount: number;
  startSeq: number;
}): BenchRow[];

export type UpdateCellsRequest = {
  updateCells: {
    start: { sheetId: number; rowIndex: number; columnIndex: number };
    rows: { values: { userEnteredValue: { stringValue: string } }[] }[];
    fields: string;
  };
};

export function buildUpdateCellsRequests(options: {
  tabs: readonly { sheetId: number; rows: readonly BenchRow[] }[];
}): UpdateCellsRequest[];

export type ValueRangePayload = {
  range: string;
  values: readonly (readonly string[])[];
};

export function buildValueRanges(options: {
  tabs: readonly { title: string; rows: readonly BenchRow[] }[];
}): ValueRangePayload[];

export function measurePayloadBytes(body: unknown): number;

export type VerifiedTabEntry = {
  ok: boolean;
  expectedRows: number;
  actualRows: number;
  unique: number;
  duplicates: number;
  total: number;
  compared: number;
  matched: number;
  mismatched: number;
  missing: number;
  extra: number;
};

export function evaluateVerifiedTabs(options: {
  expectedRowsByTab: readonly (readonly (readonly string[])[])[];
  actualRowsByTab: readonly (readonly (readonly string[])[])[];
}): { ok: boolean; tabs: VerifiedTabEntry[] };

export type AttemptOutcome =
  | { status: "success" }
  | { status: "write_response_failed_but_data_verified" }
  | { status: "verification_failed" }
  | { status: "write_failed" };

export function classifyAttemptOutcome(options: {
  responseOk: boolean;
  verified: boolean;
}): AttemptOutcome;

export function createSeededShuffle(
  seed: number
): <T>(items: readonly T[]) => T[];

export type ScenarioOrderEntry = { api: string; tabCount: number };

export function planScenarioOrder(options: {
  tabCounts: readonly number[];
  seed?: number;
}): { seed: number; order: ScenarioOrderEntry[] };

export function parseSeedEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number
): IntEnvResult;

export function computeThroughput(options: {
  rows: number;
  durationMs: number;
}): { rowsPerSecond: number; cellsPerSecond: number };

export type BatchWriteResponseClassification =
  | { status: "ok"; rowsUpdated: number; cellsUpdated: number }
  | {
      status: "anomaly";
      class: ErrorClass;
      code: string;
      rowsUpdated: number;
      cellsUpdated: number;
    };

export function classifyValuesBatchUpdateResponse(
  totalUpdatedRows: unknown,
  totalUpdatedCells: unknown,
  expectedRows: number
): BatchWriteResponseClassification;

export type UpdateCellsRepliesClassification =
  | { status: "ok"; requestCount: number }
  | { status: "anomaly"; class: ErrorClass; code: string; requestCount: number };

export function classifyUpdateCellsReplies(
  replies: unknown,
  expectedRequestCount: number
): UpdateCellsRepliesClassification;

export type IntEnvResult =
  | { status: "valid"; value: number }
  | { status: "invalid"; key: string; code: string; reason: string };

export function parsePositiveIntEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  options?: { min?: number }
): IntEnvResult;

export type TabCountsResult =
  | { status: "valid"; tabCounts: number[] }
  | { status: "invalid"; code: string; reason: string };

export function parseOptionalTabCounts(
  raw: string | undefined,
  totalRows?: number
): TabCountsResult;
