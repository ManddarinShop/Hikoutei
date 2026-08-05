#!/usr/bin/env node
/**
 * Live Direct Sheets API batch-write benchmark — one request, one spreadsheet.
 *
 * EXPERIMENT ONLY. This script is opt-in and must never run in npm test/CI:
 *
 *   node --env-file=.env scripts/bench/direct-sheets-api-batch-update.mjs
 *
 * It compares two raw Google Sheets REST write paths on the shared
 * spreadsheet identified by GOOGLE_SHEETS_TEST_SPREADSHEET_ID, authenticating
 * with the service account at GOOGLE_APPLICATION_CREDENTIALS via GoogleAuth
 * (ADC):
 *
 *   1. spreadsheets.batchUpdate with one UpdateCellsRequest per temporary
 *      tab (fields "userEnteredValue", stringValue cells only).
 *   2. spreadsheets.values.batchUpdate with one ValueRange per temporary
 *      tab (valueInputOption RAW).
 *
 * The total dataset is 10,000 records (3 string cells: bench_key, seq,
 * payload) split across 1/2/4/10/20 temporary tabs (10,000/5,000/2,500/1,000/
 * 500 rows per tab). Each scenario is exactly ONE write request and requests
 * are always sequential (concurrency 1, no Promise.all or parallel workers).
 * `DIRECT_BATCH_WARMUP` (default 1) unmeasured warm-up requests and
 * `DIRECT_BATCH_REPETITIONS` (default 3) measured repetitions run per
 * scenario; both are env-tunable:
 *
 *   DIRECT_BATCH_TAB_COUNTS=1,2,4,10,20   (default matrix)
 *   DIRECT_BATCH_TOTAL_ROWS=10000         (records per scenario)
 *   DIRECT_BATCH_WARMUP=1                 (unmeasured requests per scenario)
 *   DIRECT_BATCH_REPETITIONS=3            (measured requests per scenario)
 *   DIRECT_BATCH_SEED=20260804            (scenario-order shuffle seed)
 *
 * Scope and safety:
 *   - Never creates a spreadsheet and never uses the Drive API; all work is
 *     on the shared spreadsheet, in run-specific temporary tabs that are
 *     deleted after every scenario and again by a `finally` recovery cleanup
 *     for interruptions/failures. Cleanup reports success only after a
 *     verification read shows zero generated tabs remaining.
 *   - Measured writes are never auto-retried: 429/timeout/4xx/5xx are
 *     classified and recorded as failures, never hidden by retry.
 *   - Every warm-up and every measured repetition writes its OWN unique
 *     deterministic key set (an attempt marker folded into the keys) into
 *     the same fixed ranges, and every measured repetition is followed by
 *     its own separate values.batchGet verification against that attempt's
 *     expected rows (exact per-tab row counts and the deterministic key
 *     set; missing/duplicate/unexpected keys fail). Stale data from an
 *     earlier attempt can therefore never pass a later attempt's
 *     verification, and a response that lied about applying cannot be
 *     silently overwritten by the next repetition while still counting as a
 *     success.
 *   - Verification runs for EVERY measured repetition when setup succeeded
 *     — including after timeout/4xx/5xx/response-format failures — because
 *     a lost-response write may still have applied. Response outcome and
 *     verification outcome are stored independently; a repetition is a
 *     successful benchmark write only when BOTH are positive, and a failed
 *     response whose data was nevertheless verified is preserved as
 *     `write_response_failed_but_data_verified` evidence, never counted as
 *     a success. Verification latency is recorded separately and never
 *     enters write latency.
 *   - Each scenario's temporary tabs are deleted before the next scenario
 *     starts; if a per-scenario cleanup fails, the matrix is aborted (no
 *     later scenario runs on possibly contaminated state) and the final
 *     recovery cleanup retries the leftovers.
 *   - Scenario order is a deterministic seeded shuffle of the configured
 *     (tabCount, api) pairs (no fixed-order bias, no uncontrolled
 *     randomness); seed and actual order are recorded in the artifact.
 *   - Setup (tab creation, grid expansion, header row), write round-trip
 *     latency, verification, and cleanup are recorded separately.
 *   - SIGINT/SIGTERM request an orderly stop: the current request settles,
 *     scenario/recovery cleanup runs, the artifact is written, and the
 *     process exits nonzero. Cleanup is never skipped to exit faster.
 *   - Never logs or stores payloads, tokens, client email, private keys,
 *     spreadsheet IDs, or full API responses. Errors are reduced to stable
 *     classes + short codes; artifacts hold counts, timings, payload byte
 *     sizes, and verdicts.
 *
 * Exit code: 0 only if the env gate and stage0 smoke passed, the complete
 * configured matrix ran without interruption, every scenario's setup was
 * clean, EVERY measured repetition was both response-ok and post-write
 * verified, every per-scenario cleanup succeeded, and the final recovery
 * cleanup left zero generated tabs. Any partial outcome (failed or
 * unverified write, setup/verification/cleanup problem, signal interrupt)
 * exits nonzero with a classified reason. External permission/quota failures
 * are classified and reported; they are results, not test failures.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { GoogleAuth } from "google-auth-library";
import { sheets } from "@googleapis/sheets";
import {
  BENCH_HEADERS,
  validateBenchmarkEnv,
  summarizeLatencies,
  classifyError,
  aggregateErrorClasses,
} from "./direct-sheets-api-common.mjs";
import {
  BENCH_COLUMNS,
  BATCH_WRITE_APIS,
  DATA_FIRST_ROW_INDEX,
  DEFAULT_SCENARIO_SEED,
  TOTAL_RECORDS,
  buildTabRows,
  buildUpdateCellsRequests,
  buildValueRanges,
  classifyAttemptOutcome,
  classifyUpdateCellsReplies,
  classifyValuesBatchUpdateResponse,
  computeThroughput,
  evaluateVerifiedTabs,
  measurePayloadBytes,
  parseOptionalTabCounts,
  parsePositiveIntEnv,
  parseSeedEnv,
  planScenarioOrder,
  planTabDistribution,
} from "./direct-sheets-api-batch-update-common.mjs";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const REQUEST_TIMEOUT_MS = 300_000; // single 10k-row requests can exceed 2 minutes
const BATCH_UPDATE_CHUNK = 10;
const CLEANUP_RETRY_ATTEMPTS = 3; // 429 backoff for cleanup only, never measured writes
const CLEANUP_RETRY_DELAY_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const tabPrefix = `__BATCHUPD_${runId}`;
const artifactPath = path.join(".local", `direct-sheets-api-batch-update-${runId}.json`);

/** Signals a deliberate early exit (e.g. stage 0 failure) after cleanup ran. */
class EarlyExit extends Error {}

let record = null; // module-scoped so the EarlyExit handler can persist it

// Orderly-stop state: a signal never force-exits; it asks the current await
// to settle, then the scenario loop stops starting new work and the `finally`
// recovery cleanup + artifact write run before a nonzero exit.
let stopRequested = false;
let stopSignal = null;

function requestStop(signal) {
  if (stopRequested) {
    console.log(`[signal] ${signal} again: cleanup still pending, not forcing exit`);
    return;
  }
  stopRequested = true;
  stopSignal = signal;
  console.log(
    `[signal] ${signal} received: finishing the current request, then cleaning up and exiting nonzero`
  );
}
process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));

/** Runs one API call with timing and error classification. */
async function timedRequest(fn) {
  const started = performance.now();
  try {
    const data = await fn();
    return { ok: true, durationMs: performance.now() - started, data };
  } catch (error) {
    return { ok: false, durationMs: performance.now() - started, error: classifyError(error) };
  }
}

/**
 * Classifies a measured write result into a stable record entry.
 * Success keeps only the validated response signal; failure keeps only
 * { class, code } — never messages, URLs, or full responses.
 */
function classifyWriteResult(result, api, tabCount, totalRows) {
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  if (api === "updateCells") {
    const classification = classifyUpdateCellsReplies(result.data?.data?.replies, tabCount);
    return classification.status === "ok"
      ? { ok: true, response: classification }
      : { ok: false, error: { class: classification.class, code: classification.code } };
  }
  const classification = classifyValuesBatchUpdateResponse(
    result.data?.data?.totalUpdatedRows,
    result.data?.data?.totalUpdatedCells,
    totalRows
  );
  return classification.status === "ok"
    ? { ok: true, response: classification }
    : { ok: false, error: { class: classification.class, code: classification.code } };
}

function writeArtifact(record) {
  mkdirSync(".local", { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Artifact: ${artifactPath}`);
}

function currentBranch() {
  try {
    return execSync("git branch --show-current", { encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Post-write verification for one scenario state: a separate values.batchGet
 * reads every tab's data range and compares exact per-tab row counts plus the
 * deterministic key set (missing/duplicate/unexpected keys). The expected
 * rows MUST be the CURRENT attempt's rows (unique per attempt), so stale
 * data left by an earlier attempt can never pass. Verification latency is
 * returned separately and never enters write latency.
 *
 * @param options client, spreadsheetId, tabTitles, distribution (valid plan),
 *   rowsByTab (expected rows per tab FOR THIS ATTEMPT)
 * @returns `{ ok, durationMs, tabs, errors }`
 */
async function verifyScenarioData({ client, spreadsheetId, tabTitles, distribution, rowsByTab }) {
  const startedAt = performance.now();
  const ranges = distribution.tabs.map((tab, index) => {
    const rows = rowsByTab[index];
    return `${tabTitles[index]}!A${DATA_FIRST_ROW_INDEX + 1}:C${rows.length + DATA_FIRST_ROW_INDEX}`;
  });
  const verifyRes = await timedRequest(() =>
    client.spreadsheets.values.batchGet(
      { spreadsheetId, ranges, majorDimension: "ROWS" },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  const errors = [];
  let evaluation = null;
  if (verifyRes.ok) {
    const valueRanges = Array.isArray(verifyRes.data?.data?.valueRanges)
      ? verifyRes.data.data.valueRanges
      : [];
    // Normalize each ValueRange object ({ range, values }) to its row array
    // before the pure comparison.
    evaluation = evaluateVerifiedTabs({
      expectedRowsByTab: rowsByTab,
      actualRowsByTab: valueRanges.map((valueRange) =>
        Array.isArray(valueRange?.values) ? valueRange.values : []
      ),
    });
  } else {
    errors.push({ operation: "batchGet", class: verifyRes.error.class, code: verifyRes.error.code });
  }
  return {
    ok: verifyRes.ok && evaluation !== null && evaluation.ok,
    durationMs: performance.now() - startedAt,
    tabs: evaluation?.tabs ?? [],
    errors,
  };
}

/**
 * Deletes a set of temporary tabs with bounded 429 backoff (cleanup is never
 * a measured write, so retrying it cannot hide write failures).
 *
 * The post-deletion metadata read is the ground truth: cleanup is complete
 * only when that read shows zero generated tabs remaining. A delete request
 * whose response was lost but whose delete actually applied therefore does
 * not turn a clean zero-remaining state into a false failure — the failed
 * attempts are preserved as `deleteResponseErrors` evidence, not as
 * failures.
 *
 * Returns which sheetIds were confirmed deleted so callers can forget them
 * from the shared id map; a tab that could not be deleted is left in the map
 * for the final recovery cleanup to retry.
 *
 * @param options client, spreadsheetId, sheetIds (numeric ids to delete),
 *   isGeneratedTab (title predicate for the remaining-tab check)
 * @returns `{ ok, tabsDeleted, remainingGeneratedTabs, durationMs,
 *   deletedSheetIds, deleteResponseErrors, errors }`
 */
async function deleteTabs({ client, spreadsheetId, sheetIds, isGeneratedTab }) {
  const startedAt = performance.now();
  const deleteResponseErrors = [];
  const deletedSheetIds = [];
  for (let i = 0; i < sheetIds.length; i += BATCH_UPDATE_CHUNK) {
    const chunk = sheetIds.slice(i, i + BATCH_UPDATE_CHUNK);
    let res = null;
    for (let attempt = 0; attempt <= CLEANUP_RETRY_ATTEMPTS; attempt += 1) {
      res = await timedRequest(() =>
        client.spreadsheets.batchUpdate(
          {
            spreadsheetId,
            requestBody: { requests: chunk.map((sheetId) => ({ deleteSheet: { sheetId } })) },
          },
          { timeout: REQUEST_TIMEOUT_MS }
        )
      );
      if (res.ok || res.error.class !== "rate_limited" || attempt === CLEANUP_RETRY_ATTEMPTS) {
        break;
      }
      await sleep(CLEANUP_RETRY_DELAY_MS);
    }
    if (res.ok) {
      deletedSheetIds.push(...chunk);
    } else {
      deleteResponseErrors.push({ operation: "deleteSheet", class: res.error.class, code: res.error.code });
    }
  }
  // Cleanup only counts as complete when a verification read shows zero
  // matching tabs remaining; a failed or unknown verification is an error.
  const verify = await timedRequest(() =>
    client.spreadsheets.get(
      { spreadsheetId, fields: "sheets.properties(title)" },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  const errors = [];
  let remaining = null;
  if (verify.ok && Array.isArray(verify.data?.data?.sheets)) {
    remaining = verify.data.data.sheets.filter((sheet) =>
      isGeneratedTab(String(sheet?.properties?.title ?? ""))
    ).length;
  } else if (verify.ok) {
    errors.push({ operation: "cleanupVerify", class: "response_format", code: "missing_sheets_list" });
  } else {
    errors.push({ operation: "cleanupVerify", class: verify.error.class, code: verify.error.code });
  }
  const verificationOk = verify.ok && Number.isInteger(remaining);
  const stateClean = verificationOk && remaining === 0;
  if (verificationOk && remaining > 0) {
    errors.push({
      operation: "cleanupVerify",
      class: "cleanup_incomplete",
      code: "tabs_remaining",
      count: remaining,
    });
  }
  return {
    ok: stateClean,
    tabsDeleted: stateClean ? sheetIds.length : deletedSheetIds.length,
    remainingGeneratedTabs: remaining,
    durationMs: performance.now() - startedAt,
    deletedSheetIds,
    deleteResponseErrors,
    errors,
  };
}

/**
 * Runs one (api, tabCount) scenario: setup, `warmup` unmeasured warm-up
 * requests + `repetitions` measured repetitions of the single write request
 * (each measured repetition followed by its own batchGet verification), then
 * deletes this scenario's temporary tabs so the next scenario starts from the
 * same spreadsheet state. Setup/verification/cleanup timings never enter
 * write latency. Returns the scenario record for the artifact.
 */
async function runScenario({ client, spreadsheetId, runId, tabPrefix, api, tabCount, totalRows, warmup, repetitions, createdSheetIds }) {
  const distribution = planTabDistribution({ tabCount, totalRows });
  if (distribution.status !== "valid") {
    throw new Error(`invalid scenario configuration: ${distribution.reason}`);
  }
  const apiTag = api === "updateCells" ? "uc" : "vb";
  const tabTitles = distribution.tabs.map(
    (tab) => `${tabPrefix}_${apiTag}_t${tabCount}_i${tab.tabIndex}`
  );

  // ---- Setup: addSheet (grid pre-sized) + batched header row --------------
  const setupStartedAt = performance.now();
  const setupErrors = [];
  const chunks = [];
  for (let i = 0; i < tabTitles.length; i += BATCH_UPDATE_CHUNK) {
    chunks.push(tabTitles.slice(i, i + BATCH_UPDATE_CHUNK));
  }
  for (const chunk of chunks) {
    const res = await timedRequest(() =>
      client.spreadsheets.batchUpdate(
        {
          spreadsheetId,
          requestBody: {
            requests: chunk.map((title) => ({
              addSheet: {
                // Pre-size the grid to the exact dataset so both write paths
                // operate on the same grid; grid expansion is setup cost,
                // never write latency.
                properties: {
                  title,
                  gridProperties: { rowCount: distribution.rowsPerTab + 1, columnCount: BENCH_COLUMNS },
                },
              },
            })),
          },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );
    if (!res.ok) {
      setupErrors.push({ operation: "addSheet", tab: chunk[0], class: res.error.class, code: res.error.code });
      continue;
    }
    const replies = Array.isArray(res.data?.data?.replies) ? res.data.data.replies : [];
    chunk.forEach((title, index) => {
      const sheetId = replies[index]?.addSheet?.properties?.sheetId;
      if (typeof sheetId === "number") {
        createdSheetIds.set(title, sheetId);
      } else {
        setupErrors.push({
          operation: "addSheet",
          tab: title,
          class: "response_format",
          code: "missing_addSheet_reply",
        });
      }
    });
  }
  // One batched values.batchUpdate writes the header row of every tab in this
  // scenario, so setup stays at O(1) requests per scenario instead of O(tabs).
  const headerRes = await timedRequest(() =>
    client.spreadsheets.values.batchUpdate(
      {
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: tabTitles.map((title) => ({ range: `${title}!A1`, values: [BENCH_HEADERS] })),
        },
      },
      { timeout: REQUEST_TIMEOUT_MS }
    )
  );
  if (!headerRes.ok) {
    setupErrors.push({ operation: "headerWrite", class: headerRes.error.class, code: headerRes.error.code });
  }
  const setup = {
    tabsRequested: tabTitles.length,
    tabsCreated: tabTitles.filter((title) => typeof createdSheetIds.get(title) === "number").length,
    durationMs: performance.now() - setupStartedAt,
    errors: setupErrors,
  };

  // ---- Per-attempt payload construction (pure; one HTTP request per
  // attempt, unique deterministic key set per attempt) ----------------------
  // Every warm-up and every measured repetition writes its OWN key set (the
  // attempt marker is folded into the keys) into the same fixed ranges, so a
  // no-op or partial write can never pass verification against stale data
  // left by an earlier attempt. Bodies are built per attempt and never
  // stored or logged.
  const writesSkipped = tabTitles.some((title) => typeof createdSheetIds.get(title) !== "number");
  const buildAttempt = (attemptMarker) => {
    const rowsByTab = distribution.tabs.map((tab) =>
      buildTabRows({
        runId,
        attemptMarker,
        tabIndex: tab.tabIndex,
        rowCount: tab.rowCount,
        startSeq: tab.startSeq,
      })
    );
    const body =
      api === "updateCells"
        ? {
            requests: buildUpdateCellsRequests({
              tabs: distribution.tabs.map((tab, index) => ({
                sheetId: createdSheetIds.get(tabTitles[index]),
                rows: rowsByTab[index],
              })),
            }),
          }
        : {
            valueInputOption: "RAW",
            data: buildValueRanges({
              tabs: tabTitles.map((title, index) => ({ title, rows: rowsByTab[index] })),
            }),
          };
    return { body, rowsByTab };
  };
  const sendWrite = (body) =>
    api === "updateCells"
      ? client.spreadsheets.batchUpdate({ spreadsheetId, requestBody: body }, { timeout: REQUEST_TIMEOUT_MS })
      : client.spreadsheets.values.batchUpdate({ spreadsheetId, requestBody: body }, { timeout: REQUEST_TIMEOUT_MS });

  // ---- Warm-up loop + measured repetitions (always sequential) ----------------
  // If tab setup failed, writes would carry a malformed payload and the 400
  // would misclassify a setup failure; skip measurement instead and record
  // the setup errors as the cause.
  const warmups = [];
  const repEntries = [];
  if (!writesSkipped) {
    for (let w = 0; w < warmup; w += 1) {
      if (stopRequested) break;
      const attemptMarker = `w${w}`;
      const { body, rowsByTab } = buildAttempt(attemptMarker);
      const warmupResult = await timedRequest(() => sendWrite(body));
      const entry = {
        attemptMarker,
        payloadBytes: measurePayloadBytes(body),
        ok: warmupResult.ok,
        durationMs: warmupResult.durationMs,
      };
      if (warmupResult.ok) {
        const classified = classifyWriteResult(warmupResult, api, tabCount, totalRows);
        entry.ok = classified.ok;
        if (classified.ok) entry.response = classified.response;
        else entry.error = classified.error;
      } else {
        entry.error = warmupResult.error;
      }
      warmups.push(entry);
    }
    for (let r = 0; r < repetitions; r += 1) {
      if (stopRequested) break;
      const attemptMarker = `r${r}`;
      const { body, rowsByTab } = buildAttempt(attemptMarker);
      const result = await timedRequest(() => sendWrite(body));
      const classified = classifyWriteResult(result, api, tabCount, totalRows);
      const entry = {
        attemptMarker,
        responseOk: classified.ok,
        durationMs: result.durationMs,
        payloadBytes: measurePayloadBytes(body),
      };
      if (classified.ok) entry.response = classified.response;
      else entry.error = classified.error;
      // Verification ALWAYS runs after a measured repetition when setup
      // succeeded — including after timeout/4xx/5xx/response-format failures
      // — because a lost-response write may still have applied. Response and
      // verification outcomes are stored independently; a repetition counts
      // as a successful benchmark write only when BOTH pass. Verification
      // latency is recorded on the entry and never enters write latency.
      const verified = await verifyScenarioData({
        client,
        spreadsheetId,
        tabTitles,
        distribution,
        rowsByTab,
      });
      entry.verified = verified.ok;
      entry.verification = {
        ok: verified.ok,
        durationMs: verified.durationMs,
        tabs: verified.tabs,
        errors: verified.errors,
      };
      entry.outcome = classifyAttemptOutcome({
        responseOk: entry.responseOk,
        verified: verified.ok,
      }).status;
      entry.ok = entry.responseOk && verified.ok;
      if (!entry.ok && entry.responseOk) {
        entry.error = { class: "verification_failed", code: "post_write_verification_failed" };
      }
      repEntries.push(entry);
    }
  }
  const successfulEntries = repEntries.filter((entry) => entry.ok);
  const throughput = computeThroughput({
    // Throughput uses the rows actually proven written: successful
    // repetitions times totalRows over the summed durations of those same
    // repetitions (one 10,000-row dataset per successful repetition, not one
    // shared dataset over all three).
    rows: successfulEntries.length > 0 ? successfulEntries.length * totalRows : 0,
    durationMs: successfulEntries.reduce((sum, entry) => sum + entry.durationMs, 0),
  });

  // ---- Per-scenario cleanup: delete this scenario's tabs before the next
  // scenario starts, so every scenario runs against the same spreadsheet
  // state and earlier scenarios cannot confound later ones (growing tab
  // counts, quota drift from leftover sheets).
  const scenarioSheetIds = tabTitles
    .map((title) => createdSheetIds.get(title))
    .filter((sheetId) => Number.isInteger(sheetId));
  const cleanup = await deleteTabs({
    client,
    spreadsheetId,
    sheetIds: scenarioSheetIds,
    isGeneratedTab: (title) => tabTitles.includes(title),
  });
  // Forget only the tabs this cleanup confirmed deleted; any tab that could
  // not be deleted stays in the shared map so the final recovery cleanup
  // retries it (and the metadata-first resolution in `main` never re-deletes
  // tabs that are already gone).
  const deletedSet = new Set(cleanup.deletedSheetIds);
  for (const title of tabTitles) {
    const sheetId = createdSheetIds.get(title);
    if (sheetId !== undefined && deletedSet.has(sheetId)) {
      createdSheetIds.delete(title);
    }
  }

  const verificationErrors = [];
  for (const entry of repEntries) {
    if (entry.verification !== null && entry.verification.errors.length > 0) {
      verificationErrors.push(...entry.verification.errors);
    }
  }

  return {
    api,
    tabCount,
    totalRows,
    rowsPerTab: distribution.rowsPerTab,
    tabTitles,
    setup,
    // Scenario-level payload size = the first measured attempt's body (all
    // measured attempts differ only in the attempt-marker characters, so
    // sizes are within a byte of each other); each repetition entry carries
    // its own exact payloadBytes.
    payloadBytes: repEntries[0]?.payloadBytes ?? 0,
    writesSkipped,
    warmups,
    repetitions: repEntries,
    latencies: summarizeLatencies(repEntries.map((entry) => entry.durationMs)),
    successes: successfulEntries.length,
    writeOk: repEntries.filter((entry) => entry.responseOk).length,
    errorClasses: aggregateErrorClasses(
      repEntries.filter((entry) => !entry.ok).map((entry) => entry.error)
    ),
    rowsPerSecond: throughput.rowsPerSecond,
    cellsPerSecond: throughput.cellsPerSecond,
    verification: {
      ok: repEntries.length > 0 && repEntries.every((entry) => entry.verified),
      verifiedRepetitions: successfulEntries.length,
      totalRepetitions: repEntries.length,
      totalDurationMs: repEntries.reduce(
        (sum, entry) => sum + entry.verification.durationMs,
        0
      ),
      errorClasses: aggregateErrorClasses(verificationErrors),
    },
    cleanup,
  };
}

async function main() {
  const mainStarted = performance.now();
  const startedAt = new Date().toISOString();
  record = {
    experiment: "direct-sheets-api-batch-update",
    date: startedAt,
    branch: currentBranch(),
    node: process.version,
    command: "node --env-file=.env scripts/bench/direct-sheets-api-batch-update.mjs",
    env: {
      GOOGLE_APPLICATION_CREDENTIALS: "configured",
      GOOGLE_SHEETS_TEST_SPREADSHEET_ID: "configured",
    },
    stages: {},
    overall: null,
  };

  // ---- Environment gate ------------------------------------------------------
  const envResult = validateBenchmarkEnv(process.env);
  const totalRowsResult = parsePositiveIntEnv(process.env, "DIRECT_BATCH_TOTAL_ROWS", TOTAL_RECORDS, { min: 1 });
  const tabCountsResult = parseOptionalTabCounts(process.env.DIRECT_BATCH_TAB_COUNTS, totalRowsResult.status === "valid" ? totalRowsResult.value : TOTAL_RECORDS);
  const warmupResult = parsePositiveIntEnv(process.env, "DIRECT_BATCH_WARMUP", 1, { min: 0 });
  const repetitionsResult = parsePositiveIntEnv(process.env, "DIRECT_BATCH_REPETITIONS", 3, { min: 1 });
  const seedResult = parseSeedEnv(process.env, "DIRECT_BATCH_SEED", DEFAULT_SCENARIO_SEED);
  const envErrors = [
    ...(envResult.status === "invalid" ? envResult.errors : []),
    ...(totalRowsResult.status === "invalid" ? [totalRowsResult] : []),
    ...(tabCountsResult.status === "invalid" ? [tabCountsResult] : []),
    ...(warmupResult.status === "invalid" ? [warmupResult] : []),
    ...(repetitionsResult.status === "invalid" ? [repetitionsResult] : []),
    ...(seedResult.status === "invalid" ? [seedResult] : []),
  ];
  if (envErrors.length > 0) {
    console.error("[env] invalid benchmark environment:");
    for (const error of envErrors) {
      console.error(`  - ${error.key ?? "DIRECT_BATCH_TAB_COUNTS"}: ${error.reason}`);
    }
    record.stages.env = { status: "invalid", errors: envErrors };
    record.overall = { exitCode: 1, reason: "invalid environment" };
    writeArtifact(record);
    process.exitCode = 1;
    return;
  }
  const { spreadsheetId } = envResult.config;
  const tabCounts = tabCountsResult.tabCounts;
  const totalRows = totalRowsResult.value;
  const warmup = warmupResult.value;
  const repetitions = repetitionsResult.value;
  const seed = seedResult.value;
  // Deterministic seeded permutation of every (tabCount, api) pair: no
  // fixed-order bias (updateCells always first, tab counts always ascending)
  // and no uncontrolled randomness. Seed and the exact order are recorded in
  // the artifact so the sequence is reproducible.
  const scenarioOrderPlan = planScenarioOrder({ tabCounts, seed });
  record.env = {
    ...record.env,
    tabCounts,
    totalRows,
    warmup,
    repetitions,
    seed: scenarioOrderPlan.seed,
    scenarioOrder: scenarioOrderPlan.order,
  };
  console.log("[env] credentials: present (file readable); spreadsheet: present (id redacted)");
  console.log(`[env] run id: ${runId}; tab counts: [${tabCounts.join(", ")}]; total rows: ${totalRows}; warmup: ${warmup}; repetitions: ${repetitions}`);
  console.log(`[env] scenario order (seed ${scenarioOrderPlan.seed}): ${scenarioOrderPlan.order
    .map((entry) => `${entry.api}@${entry.tabCount}`)
    .join(" -> ")}`);

  const auth = new GoogleAuth({ scopes: SCOPES });
  const client = sheets({ version: "v4", auth });

  const createdSheetIds = new Map(); // tab title -> numeric sheetId
  let setupStarted = false; // true once temporary-tab setup begins after stage 0
  let cleanup = null;
  let matrixAbortedReason = null; // set when a per-scenario cleanup fails

  try {
    // ---- Stage 0: metadata/auth smoke -------------------------------------
    const stage0Started = performance.now();
    const stage0 = await timedRequest(() =>
      client.spreadsheets.get(
        { spreadsheetId, fields: "sheets.properties(sheetId,title,index)" },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );
    if (!stage0.ok) {
      record.stages.stage0 = {
        ok: false,
        durationMs: stage0.durationMs,
        error: stage0.error,
      };
      console.error(`[stage0] metadata/auth smoke failed: ${stage0.error.class}${stage0.error.code ? ` (${stage0.error.code})` : ""}`);
      record.overall = { exitCode: 1, reason: "stage0 auth/metadata smoke failed" };
      process.exitCode = 1;
      // Cleanup still runs in `finally`; the EarlyExit handler then persists one
      // complete artifact that includes the cleanup stage.
      throw new EarlyExit("stage0 auth/metadata smoke failed");
    }
    const tabCount = Array.isArray(stage0.data?.data?.sheets) ? stage0.data.data.sheets.length : null;
    record.stages.stage0 = { ok: true, durationMs: stage0.durationMs, spreadsheetTabCount: tabCount };
    console.log(`[stage0] metadata/auth smoke ok in ${Math.round(stage0.durationMs)} ms (${tabCount ?? "?"} tabs)`);
    setupStarted = true;

    // ---- Scenarios: setup + single-request writes + per-repetition
    // verification + per-scenario cleanup (stop when a signal arrived) -------
    // The stage object is recorded up front so a fatal error mid-matrix
    // still preserves every completed scenario in the artifact.
    const scenariosStarted = performance.now();
    const scenarios = [];
    record.stages.scenarios = { durationMs: 0, list: scenarios, matrixAborted: null };
    for (const { api, tabCount } of scenarioOrderPlan.order) {
      if (stopRequested) break;
      const scenario = await runScenario({
        client,
        spreadsheetId,
        runId,
        tabPrefix,
        api,
        tabCount,
        totalRows,
        warmup,
        repetitions,
        createdSheetIds,
      });
      scenarios.push(scenario);
      console.log(
        `[scenario] ${api} / ${tabCount} tab(s): setup ${Math.round(scenario.setup.durationMs)} ms, ` +
          `payload ${scenario.payloadBytes} bytes, ${scenario.successes}/${scenario.repetitions.length} writes verified, ` +
          `cleanup ${scenario.cleanup.ok ? "ok" : "FAILED"}`
      );
      if (!scenario.cleanup.ok) {
        // Leftover tabs from this scenario would contaminate every later
        // measurement (growing tab counts, stale data, quota drift): abort
        // the matrix now and let the final recovery cleanup retry the
        // leftovers.
        matrixAbortedReason = `per-scenario cleanup failed at ${api}/${tabCount} tab(s)`;
        record.stages.scenarios.matrixAborted = {
          at: { api, tabCount },
          reason: matrixAbortedReason,
          cleanupErrors: scenario.cleanup.errors,
          deleteResponseErrors: scenario.cleanup.deleteResponseErrors,
        };
        console.error(
          `[scenario] cleanup FAILED for ${api}/${tabCount}; aborting matrix (recovery cleanup will retry)`
        );
        break;
      }
    }
    record.stages.scenarios.durationMs = performance.now() - scenariosStarted;
  } finally {
    // ---- Final recovery cleanup: delete every generated tab that per-
    // scenario cleanup could not (or, after an interrupt, did not) remove ---
    const cleanupStarted = performance.now();
    const cleanupErrors = [];
    let deletedTabs = 0;
    try {
      if (!setupStarted) {
        // Stage 0 failed before any temporary tab was requested: there is
        // nothing to recover, delete, or verify.
        cleanup = {
          ok: true,
          tabsPendingDeletion: 0,
          tabsDeleted: 0,
          remainingGeneratedTabs: 0,
          durationMs: performance.now() - cleanupStarted,
          errors: [],
          deleteResponseErrors: [],
        };
      } else {
        // Resolve what actually remains from a metadata read (single source
        // of truth). Metadata is authoritative: a generated title it does
        // NOT list is already gone (for example a delete whose response was
        // lost after the delete applied), so those stale ids are forgotten
        // from the shared map instead of retrying an already-deleted sheet —
        // a clean zero-remaining state must not become a false cleanup
        // failure. The map is used as a fallback ONLY when metadata is
        // unavailable.
        const meta = await timedRequest(() =>
          client.spreadsheets.get(
            { spreadsheetId, fields: "sheets.properties(sheetId,title)" },
            { timeout: REQUEST_TIMEOUT_MS }
          )
        );
        const targets = [];
        if (meta.ok && Array.isArray(meta.data?.data?.sheets)) {
          const seenTitles = new Set();
          for (const sheet of meta.data.data.sheets) {
            const title = sheet?.properties?.title;
            if (typeof title === "string" && title.startsWith(tabPrefix)) {
              const sheetId = Number(sheet?.properties?.sheetId);
              if (Number.isInteger(sheetId)) {
                targets.push({ title, sheetId });
                seenTitles.add(title);
              } else {
                cleanupErrors.push({ operation: "recoverSheetId", tab: title, class: "response_format", code: "missing_sheetId" });
              }
            }
          }
          for (const [title] of createdSheetIds) {
            if (!seenTitles.has(title)) {
              createdSheetIds.delete(title);
            }
          }
        } else if (meta.ok) {
          cleanupErrors.push({ operation: "recoverSheetIds", class: "response_format", code: "missing_sheets_list" });
          for (const [title, sheetId] of createdSheetIds) {
            targets.push({ title, sheetId });
          }
        } else {
          cleanupErrors.push({ operation: "recoverSheetIds", class: meta.error.class, code: meta.error.code });
          for (const [title, sheetId] of createdSheetIds) {
            targets.push({ title, sheetId });
          }
        }
        const result = await deleteTabs({
          client,
          spreadsheetId,
          sheetIds: targets.map((target) => target.sheetId),
          isGeneratedTab: (title) => title.startsWith(tabPrefix),
        });
        deletedTabs = result.tabsDeleted;
        cleanup = {
          ok: result.ok && cleanupErrors.length === 0,
          tabsPendingDeletion: targets.length,
          tabsDeleted: deletedTabs,
          remainingGeneratedTabs: result.remainingGeneratedTabs,
          durationMs: performance.now() - cleanupStarted,
          errors: [...cleanupErrors, ...result.errors],
          deleteResponseErrors: result.deleteResponseErrors,
        };
      }
    } catch (error) {
      cleanup = {
        ok: false,
        tabsPendingDeletion: createdSheetIds.size,
        tabsDeleted: deletedTabs,
        remainingGeneratedTabs: null,
        durationMs: performance.now() - cleanupStarted,
        errors: [
          ...cleanupErrors,
          { operation: "cleanup", class: classifyError(error).class, code: classifyError(error).code },
        ],
        deleteResponseErrors: [],
      };
    }
    record.stages.cleanup = cleanup;
    if (cleanup.ok) {
      console.log(`[cleanup] ${cleanup.tabsDeleted}/${cleanup.tabsPendingDeletion} tabs deleted in ${Math.round(cleanup.durationMs)} ms`);
    } else {
      console.error(`[cleanup] FAILED: ${cleanup.tabsDeleted}/${cleanup.tabsPendingDeletion} deleted, ${cleanup.errors.length} cleanup errors`);
    }
  }

  // ---- Overall result --------------------------------------------------------
  // Exit 0 only for a complete, fully verified matrix: every measured write
  // response-ok AND post-write verified, clean setup, per-scenario cleanups
  // and the final recovery cleanup all complete, no interrupt. Anything less
  // is a partial outcome and exits nonzero with a classified reason.
  const totalDurationMs = performance.now() - mainStarted;
  const stage0 = record.stages.stage0;
  const scenarios = record.stages.scenarios?.list ?? [];
  const expectedMeasuredWrites = tabCounts.length * BATCH_WRITE_APIS.length * repetitions;
  const verifiedTotal = scenarios.reduce((sum, scenario) => sum + scenario.successes, 0);
  const responseOkTotal = scenarios.reduce((sum, scenario) => sum + scenario.writeOk, 0);
  const setupUnclean = scenarios.some((scenario) => scenario.setup.errors.length > 0 || scenario.writesSkipped);
  const scenarioCleanupUnclean = scenarios.some((scenario) => !scenario.cleanup?.ok);
  const finalCleanupOk = record.stages.cleanup?.ok === true;

  let exitCode = 0;
  let reason = "completed";
  if (!stage0?.ok) {
    exitCode = 1;
    reason = "stage0 auth/metadata smoke failed";
  } else if (stopRequested) {
    exitCode = 1;
    reason = `interrupted by ${stopSignal} after ${verifiedTotal}/${expectedMeasuredWrites} verified writes`;
  } else if (matrixAbortedReason !== null) {
    exitCode = 1;
    reason = `matrix aborted: ${matrixAbortedReason}`;
  } else if (setupUnclean) {
    exitCode = 1;
    reason = "scenario setup incomplete (tab/header errors or skipped writes)";
  } else if (verifiedTotal < expectedMeasuredWrites) {
    exitCode = 1;
    reason = `partial: ${verifiedTotal} of ${expectedMeasuredWrites} measured writes verified`;
  } else if (scenarioCleanupUnclean) {
    exitCode = 1;
    reason = "scenario cleanup incomplete";
  } else if (!finalCleanupOk) {
    exitCode = 1;
    reason = "cleanup incomplete";
  }
  record.overall = {
    exitCode,
    reason,
    totalDurationMs: Math.round(totalDurationMs),
    expectedMeasuredWrites,
    measuredWritesVerified: verifiedTotal,
    measuredWritesRespondedOk: responseOkTotal,
    matrixAborted: matrixAbortedReason !== null,
    interrupted: stopRequested,
    stopSignal: stopSignal ?? null,
    setupFailures: scenarios.reduce((sum, scenario) => sum + scenario.setup.errors.length, 0),
    scenarioCleanupFailures: scenarios.filter((scenario) => !scenario.cleanup?.ok).length,
  };
  writeArtifact(record);
  process.exitCode = exitCode;
  console.log(`[done] exit ${exitCode} — ${record.overall.reason}`);
}

main().catch((error) => {
  if (error instanceof EarlyExit) {
    try {
      writeArtifact(record);
    } catch {
      // artifact write failed; nothing else to report safely
    }
    return;
  }
  const classified = classifyError(error);
  console.error(`[fatal] unexpected benchmark failure: ${classified.class}${classified.code ? ` (${classified.code})` : ""}`);
  try {
    if (record !== null) {
      // Preserve every stage already recorded (setup, completed scenarios,
      // cleanup) and append a redacted fatal classification plus a nonzero
      // overall verdict instead of replacing the artifact with a tiny
      // `{ experiment, fatal }` object. Credential/spreadsheet redaction is
      // inherited from the record itself.
      record.fatal = { class: classified.class, code: classified.code };
      record.overall = {
        ...(record.overall ?? {}),
        exitCode: 1,
        reason: `fatal: ${classified.class}${classified.code ? ` (${classified.code})` : ""}`,
        fatal: { class: classified.class, code: classified.code },
      };
      writeArtifact(record);
    } else {
      // main() never started; nothing else exists to preserve.
      writeArtifact({
        experiment: "direct-sheets-api-batch-update",
        fatal: { class: classified.class, code: classified.code },
      });
    }
  } catch {
    // artifact write failed; nothing else to report safely
  }
  process.exitCode = 1;
});
