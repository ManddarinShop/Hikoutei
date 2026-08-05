#!/usr/bin/env node
/**
 * Live Direct Sheets API benchmark — service account on the shared spreadsheet.
 *
 * EXPERIMENT ONLY. This script is opt-in and must never run in npm test/CI:
 *
 *   node --env-file=.env scripts/bench/direct-sheets-api-service-account.mjs
 *
 * It measures the raw Google Sheets REST path (no Apps Script provider, no
 * receipts, no CAS) on the shared spreadsheet identified by
 * GOOGLE_SHEETS_TEST_SPREADSHEET_ID, authenticating with the service account
 * at GOOGLE_APPLICATION_CREDENTIALS via GoogleAuth (ADC).
 *
 * Scope and safety:
 *   - Never creates a spreadsheet and never uses the Drive API; all work is
 *     on the shared spreadsheet, in run-specific temporary tabs that are
 *     always deleted in a `finally` cleanup block. Cleanup reports success
 *     only after a verification read shows zero generated tabs remaining;
 *     when stage 0 fails before any tab is created, cleanup is trivially
 *     clean without a verification call.
 *   - Uses only values.append, values.get/values.batchGet, and
 *     spreadsheets.batchUpdate for add/delete tabs.
 *   - Never logs or stores payloads, tokens, client email, private keys,
 *     spreadsheet IDs, or full API responses. Errors are reduced to stable
 *     classes + short codes; artifacts hold counts, timings, and verdicts.
 *   - Raw values.append has no idempotency key or receipt: Stage 4 replays a
 *     payload after simulated response loss and records duplicates as
 *     evidence, never as success.
 *
 * Exit code: 0 only if the auth/metadata smoke passed, at least one append
 * succeeded, and cleanup fully succeeded. External permission/quota failures
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
  buildRows,
  summarizeLatencies,
  classifyError,
  classifyAppendResponse,
  compareRows,
  analyzeWindowRows,
  countDuplicateKeys,
  aggregateErrorClasses,
} from "./direct-sheets-api-common.mjs";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const ROW_SIZES = [1, 10, 100, 500];
const CONCURRENCIES = [1, 2, 4, 10, 20];
const REQUESTS_PER_CELL = 20;
const BATCH_UPDATE_CHUNK = 10;
const REQUEST_TIMEOUT_MS = 120_000;
const STAGE2_WINDOW_ROWS = 100;
const STAGE4_PAYLOAD_ROWS = 5;

const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const tabPrefix = `__DIRECTAPI_${runId}`;
const artifactPath = path.join(".local", `direct-sheets-api-${runId}.json`);

const cells = [];
for (const rows of ROW_SIZES) {
  for (const concurrency of CONCURRENCIES) {
    cells.push({
      rows,
      concurrency,
      tab: `${tabPrefix}_r${rows}_c${concurrency}`,
      cellId: `r${rows}_c${concurrency}`,
    });
  }
}
const replayTab = `${tabPrefix}_replay`;
const allTabs = [...cells.map((cell) => cell.tab), replayTab];

/** Signals a deliberate early exit (e.g. stage 0 failure) after cleanup ran. */
class EarlyExit extends Error {}

let record = null; // module-scoped so the EarlyExit handler can persist it

/** Runs `worker` over `items` with at most `concurrency` in flight. */
async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index], index);
      }
    })
  );
  return results;
}

/**
 * Runs one API call with timing and error classification.
 * Success keeps only the response data needed for counts/evidence; failure
 * keeps only { class, code } — never messages, URLs, or full responses.
 */
async function timedRequest(fn) {
  const started = performance.now();
  try {
    const data = await fn();
    return { ok: true, durationMs: performance.now() - started, data };
  } catch (error) {
    return { ok: false, durationMs: performance.now() - started, error: classifyError(error) };
  }
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

async function main() {
  const mainStarted = performance.now();
  const startedAt = new Date().toISOString();
  record = {
    experiment: "direct-sheets-api-service-account",
    date: startedAt,
    branch: currentBranch(),
    node: process.version,
    command: "node --env-file=.env scripts/bench/direct-sheets-api-service-account.mjs",
    env: { GOOGLE_APPLICATION_CREDENTIALS: "configured", GOOGLE_SHEETS_TEST_SPREADSHEET_ID: "configured" },
    stages: {},
    overall: null,
  };

  const envResult = validateBenchmarkEnv(process.env);
  if (envResult.status === "invalid") {
    console.error("[env] invalid benchmark environment:");
    for (const error of envResult.errors) {
      console.error(`  - ${error.key}: ${error.reason}`);
    }
    record.stages.env = { status: "invalid", errors: envResult.errors };
    record.overall = { exitCode: 1, reason: "invalid environment" };
    writeArtifact(record);
    process.exitCode = 1;
    return;
  }
  console.log("[env] credentials: present (file readable); spreadsheet: present (id redacted)");
  console.log(`[env] run id: ${runId}`);
  const { spreadsheetId } = envResult.config;

  const auth = new GoogleAuth({ scopes: SCOPES });
  const client = sheets({ version: "v4", auth });

  const createdSheetIds = new Map(); // tab title -> numeric sheetId
  let setupStarted = false; // true once temporary-tab setup begins after stage 0
  let cleanup = null;

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

    // ---- Setup: run-specific temporary tabs + header rows ------------------
    const setupStartedAt = performance.now();
    setupStarted = true;
    const setupErrors = [];
    for (let i = 0; i < allTabs.length; i += BATCH_UPDATE_CHUNK) {
      const chunk = allTabs.slice(i, i + BATCH_UPDATE_CHUNK);
      const res = await timedRequest(() =>
        client.spreadsheets.batchUpdate(
          {
            spreadsheetId,
            requestBody: {
              requests: chunk.map((title) => ({ addSheet: { properties: { title } } })),
            },
          },
          { timeout: REQUEST_TIMEOUT_MS }
        )
      );
      if (res.ok) {
        const replies = Array.isArray(res.data?.data?.replies) ? res.data.data.replies : [];
        chunk.forEach((title, index) => {
          const sheetId = replies[index]?.addSheet?.properties?.sheetId;
          if (typeof sheetId === "number") {
            createdSheetIds.set(title, sheetId);
          } else {
            setupErrors.push({ operation: "addSheet", tab: title, class: "response_format", code: "missing_addSheet_reply" });
          }
        });
      } else {
        setupErrors.push({ operation: "addSheet", tab: chunk[0], class: res.error.class, code: res.error.code });
      }
    }
    for (const title of allTabs) {
      const res = await timedRequest(() =>
        client.spreadsheets.values.append(
          {
            spreadsheetId,
            range: `${title}!A1`,
            valueInputOption: "RAW",
            insertDataOption: "INSERT_ROWS",
            requestBody: { values: [BENCH_HEADERS] },
          },
          { timeout: REQUEST_TIMEOUT_MS }
        )
      );
      if (!res.ok) {
        setupErrors.push({ operation: "headerAppend", tab: title, class: res.error.class, code: res.error.code });
      }
    }
    record.stages.setup = {
      tabsRequested: allTabs.length,
      tabsCreated: createdSheetIds.size,
      addSheetRequests: Math.ceil(allTabs.length / BATCH_UPDATE_CHUNK),
      headerAppends: allTabs.length,
      durationMs: performance.now() - setupStartedAt,
      errors: setupErrors,
    };
    console.log(
      `[setup] ${createdSheetIds.size}/${allTabs.length} tabs created, ${setupErrors.length} setup errors, in ${Math.round(record.stages.setup.durationMs)} ms`
    );

    // ---- Stage 1: raw append sweep ------------------------------------------
    const stage1Started = performance.now();
    const stage1 = { cells: [], totals: null };
    let stage1Requests = 0;
    let stage1Ok = 0;
    let stage1Rows = 0;
    const stage1Latencies = [];
    const stage1Errors = [];
    for (const cell of cells) {
      const cellStarted = performance.now();
      const results = await runWithConcurrency(
        Array.from({ length: REQUESTS_PER_CELL }, (_, index) => index),
        cell.concurrency,
        async (requestIndex) => {
          const rows = buildRows({
            runId,
            cellId: cell.cellId,
            startSeq: requestIndex * cell.rows,
            count: cell.rows,
          });
          return timedRequest(() =>
            client.spreadsheets.values.append(
              {
                spreadsheetId,
                range: `${cell.tab}!A1`,
                valueInputOption: "RAW",
                insertDataOption: "INSERT_ROWS",
                requestBody: { values: rows },
              },
              { timeout: REQUEST_TIMEOUT_MS }
            )
          );
        }
      );
      const latencies = results.map((result) => result.durationMs);
      const errors = [];
      let appendOk = 0;
      let cellRows = 0;
      let updatedRowsAnomalies = 0;
      for (const result of results) {
        if (!result.ok) {
          errors.push(result.error);
          continue;
        }
        // A 2xx response is not a successful append unless updatedRows is an
        // integer matching the payload; anomalies are response-format errors,
        // and rowsAppended/rowsPerSecond use only validated actual updatedRows.
        const classification = classifyAppendResponse(result.data?.data?.updates?.updatedRows, cell.rows);
        if (classification.status === "ok") {
          appendOk += 1;
          cellRows += classification.rowsAppended;
        } else {
          updatedRowsAnomalies += 1;
          cellRows += classification.rowsAppended;
          errors.push({ class: classification.class, code: classification.code });
        }
      }
      stage1.cells.push({
        cell: cell.cellId,
        rowsPerRequest: cell.rows,
        concurrency: cell.concurrency,
        requests: results.length,
        ok: appendOk,
        errors,
        latencies: summarizeLatencies(latencies),
        rowsAppended: cellRows,
        rowsPerSecond: cellRows / ((performance.now() - cellStarted) / 1000),
        updatedRowsAnomalies,
      });
      stage1Requests += results.length;
      stage1Ok += appendOk;
      stage1Rows += cellRows;
      stage1Latencies.push(...latencies);
      stage1Errors.push(...errors);
    }
    stage1.totals = {
      requests: stage1Requests,
      ok: stage1Ok,
      errorClasses: aggregateErrorClasses(stage1Errors),
      rowsAppended: stage1Rows,
      rowsPerRequest: stage1Requests > 0 ? stage1Rows / stage1Requests : 0,
      rowsPerSecond: stage1Rows / ((performance.now() - stage1Started) / 1000),
      latencies: summarizeLatencies(stage1Latencies),
      durationMs: performance.now() - stage1Started,
    };
    record.stages.stage1 = stage1;
    console.log(
      `[stage1] ${stage1Ok}/${stage1Requests} appends ok, ${stage1Rows} rows, ` +
        `${stage1.totals.rowsPerSecond.toFixed(1)} rows/s steady-state`
    );

    // ---- Stage 2: key-range reads + batch comparison -------------------------
    const stage2Started = performance.now();
    const stage2 = { cells: [], totals: null };
    const stage2All = [];
    for (const cell of cells) {
      const totalDataRows = REQUESTS_PER_CELL * cell.rows;
      const lastDataRow = 1 + totalDataRows;
      const expectedAll = buildRows({ runId, cellId: cell.cellId, startSeq: 0, count: totalDataRows });
      const cellEntry = { cell: cell.cellId, keyRangeRead: null, batchRead: null };

      // Single-range key read of a leading window (A2..windowEnd). Concurrent
      // appends make physical row order unpredictable, so observed rows are
      // validated only as well-formed/known; missing/extra are recorded as
      // interleaving evidence, never assumed to follow request-index order.
      const windowEnd = Math.min(lastDataRow, 1 + STAGE2_WINDOW_ROWS);
      const expectedWindow = expectedAll.slice(0, windowEnd - 1);
      const readRes = await timedRequest(() =>
        client.spreadsheets.values.get(
          {
            spreadsheetId,
            range: `${cell.tab}!A2:C${windowEnd}`,
            majorDimension: "ROWS",
          },
          { timeout: REQUEST_TIMEOUT_MS }
        )
      );
      if (readRes.ok) {
        const actual = Array.isArray(readRes.data?.data?.values) ? readRes.data.data.values : [];
        const analysis = analyzeWindowRows({ expectedAll, expectedWindow, actual });
        cellEntry.keyRangeRead = { ok: true, durationMs: readRes.durationMs, ...analysis };
      } else {
        cellEntry.keyRangeRead = { ok: false, durationMs: readRes.durationMs, error: readRes.error };
      }

      // Batch comparison: one batchGet with 4 subranges covering the data.
      const parts = 4;
      const subranges = [];
      for (let part = 0; part < parts; part += 1) {
        const startRow = 2 + Math.floor((part * totalDataRows) / parts);
        const endRow = 1 + Math.floor(((part + 1) * totalDataRows) / parts);
        subranges.push(`${cell.tab}!A${startRow}:C${endRow}`);
      }
      const batchRes = await timedRequest(() =>
        client.spreadsheets.values.batchGet(
          {
            spreadsheetId,
            ranges: subranges,
            majorDimension: "ROWS",
          },
          { timeout: REQUEST_TIMEOUT_MS }
        )
      );
      if (batchRes.ok) {
        // Flatten every returned value range and compare the complete observed
        // key set against expectedAll: compareRows matches by key, so no
        // physical row order is assumed under concurrent appends.
        const valueRanges = Array.isArray(batchRes.data?.data?.valueRanges) ? batchRes.data.data.valueRanges : [];
        const flattened = valueRanges.flatMap((valueRange) =>
          Array.isArray(valueRange?.values) ? valueRange.values : []
        );
        const comparison = compareRows(expectedAll, flattened);
        cellEntry.batchRead = {
          ok: true,
          durationMs: batchRes.durationMs,
          ranges: valueRanges.length,
          observed: flattened.length,
          ...comparison,
        };
      } else {
        cellEntry.batchRead = { ok: false, durationMs: batchRes.durationMs, error: batchRes.error };
      }

      stage2.cells.push(cellEntry);
      stage2All.push(readRes, batchRes);
    }
    const stage2Ok = stage2All.filter((result) => result.ok).length;
    stage2.totals = {
      requests: stage2All.length,
      ok: stage2Ok,
      errorClasses: aggregateErrorClasses(stage2All.filter((result) => !result.ok).map((result) => result.error)),
      durationMs: performance.now() - stage2Started,
    };
    record.stages.stage2 = stage2;
    console.log(`[stage2] ${stage2Ok}/${stage2All.length} read requests ok`);

    // ---- Stage 3: one postcondition read per batch ---------------------------
    const stage3Started = performance.now();
    const stage3 = { cells: [], totals: null };
    const stage3All = [];
    for (const cell of cells) {
      const totalDataRows = REQUESTS_PER_CELL * cell.rows;
      const lastDataRow = 1 + totalDataRows;
      const expectedAll = buildRows({ runId, cellId: cell.cellId, startSeq: 0, count: totalDataRows });
      const postRes = await timedRequest(() =>
        client.spreadsheets.values.get(
          {
            spreadsheetId,
            range: `${cell.tab}!A2:C${lastDataRow}`,
            majorDimension: "ROWS",
          },
          { timeout: REQUEST_TIMEOUT_MS }
        )
      );
      if (postRes.ok) {
        const actual = Array.isArray(postRes.data?.data?.values) ? postRes.data.data.values : [];
        const comparison = compareRows(expectedAll, actual);
        const countOk = actual.length === totalDataRows;
        const keysOk = comparison.matched === totalDataRows;
        stage3.cells.push({
          cell: cell.cellId,
          ok: countOk && keysOk,
          durationMs: postRes.durationMs,
          expectedRows: totalDataRows,
          actualRows: actual.length,
          ...comparison,
        });
      } else {
        stage3.cells.push({ cell: cell.cellId, ok: false, durationMs: postRes.durationMs, error: postRes.error });
      }
      stage3All.push(postRes);
    }
    const stage3Passed = stage3.cells.filter((entry) => entry.ok).length;
    stage3.totals = {
      requests: stage3All.length,
      ok: stage3All.filter((result) => result.ok).length,
      passed: stage3Passed,
      errorClasses: aggregateErrorClasses(stage3All.filter((result) => !result.ok).map((result) => result.error)),
      durationMs: performance.now() - stage3Started,
    };
    record.stages.stage3 = stage3;
    console.log(`[stage3] postcondition passed for ${stage3Passed}/${stage3.cells.length} cells`);

    // ---- Stage 4: simulated response loss + deterministic replay -------------
    const payload = buildRows({ runId, cellId: "replay", startSeq: 0, count: STAGE4_PAYLOAD_ROWS });
    const appendPayload = () =>
      client.spreadsheets.values.append(
        {
          spreadsheetId,
          range: `${replayTab}!A1`,
          valueInputOption: "RAW",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values: payload },
        },
        { timeout: REQUEST_TIMEOUT_MS }
      );
    // First append: the response is intentionally discarded (simulated loss).
    const firstAppend = await timedRequest(appendPayload);
    const replayAppend = await timedRequest(appendPayload);
    const postRes = await timedRequest(() =>
      client.spreadsheets.values.get(
        {
          spreadsheetId,
          range: `${replayTab}!A2:C${1 + STAGE4_PAYLOAD_ROWS * 2}`,
          majorDimension: "ROWS",
        },
        { timeout: REQUEST_TIMEOUT_MS }
      )
    );
    let stage4;
    if (postRes.ok) {
      const actual = Array.isArray(postRes.data?.data?.values) ? postRes.data.data.values : [];
      const keys = countDuplicateKeys(actual);
      const verdict =
        keys.duplicates > 0
          ? "duplicate_replay"
          : keys.total === STAGE4_PAYLOAD_ROWS
            ? "single_copy"
            : "unexpected_count";
      stage4 = {
        payloadRows: STAGE4_PAYLOAD_ROWS,
        firstAppend: { ok: firstAppend.ok, durationMs: firstAppend.durationMs, responseDiscarded: true },
        replayAppend: { ok: replayAppend.ok, durationMs: replayAppend.durationMs },
        postcondition: { ok: true, durationMs: postRes.durationMs, ...keys, verdict },
        firstAppendLandedInferred:
          keys.duplicates > 0 && keys.total === STAGE4_PAYLOAD_ROWS * 2,
        rawAppendIdempotency: "none",
        receipt: "none",
        note:
          "values.append has no idempotency key or receipt: after a lost response the writer " +
          "cannot know whether the rows landed, and a deterministic replay can duplicate them. " +
          "A duplicate replay is recorded as evidence, not as success.",
      };
      console.log(
        `[stage4] verdict=${verdict} (found ${keys.total} rows, ${keys.duplicates} duplicate keys after replay of ${STAGE4_PAYLOAD_ROWS})`
      );
    } else {
      stage4 = {
        payloadRows: STAGE4_PAYLOAD_ROWS,
        firstAppend: { ok: firstAppend.ok, durationMs: firstAppend.durationMs, responseDiscarded: true },
        replayAppend: { ok: replayAppend.ok, durationMs: replayAppend.durationMs },
        postcondition: { ok: false, durationMs: postRes.durationMs, error: postRes.error },
        rawAppendIdempotency: "none",
        receipt: "none",
        note: "postcondition read failed; duplicate evidence unavailable",
      };
      console.error(`[stage4] postcondition read failed: ${postRes.error.class}${postRes.error.code ? ` (${postRes.error.code})` : ""}`);
    }
    record.stages.stage4 = stage4;
  } finally {
    // ---- Cleanup: always delete every generated tab --------------------------
    const cleanupStarted = performance.now();
    const cleanupErrors = [];
    let deletedTabs = 0;
    try {
      if (!setupStarted) {
        // Stage 0 failed before any temporary tab was requested: there is
        // nothing to recover, delete, or verify, and a metadata call here
        // would only add a misleading failure after e.g. a 403.
        cleanup = {
          ok: true,
          tabsCreated: 0,
          tabsDeleted: 0,
          remainingGeneratedTabs: 0,
          durationMs: performance.now() - cleanupStarted,
          errors: [],
        };
      } else {
        // Resolve numeric sheet IDs for every generated tab title whose
        // addSheet reply was missing/incomplete before deleting anything.
        if (createdSheetIds.size < allTabs.length) {
          const meta = await timedRequest(() =>
            client.spreadsheets.get(
              { spreadsheetId, fields: "sheets.properties(sheetId,title)" },
              { timeout: REQUEST_TIMEOUT_MS }
            )
          );
          if (meta.ok && Array.isArray(meta.data?.data?.sheets)) {
            for (const sheet of meta.data.data.sheets) {
              const title = sheet?.properties?.title;
              if (typeof title === "string" && title.startsWith(tabPrefix) && !createdSheetIds.has(title)) {
                const sheetId = Number(sheet?.properties?.sheetId);
                if (Number.isInteger(sheetId)) {
                  createdSheetIds.set(title, sheetId);
                } else {
                  cleanupErrors.push({ operation: "recoverSheetId", tab: title, class: "response_format", code: "missing_sheetId" });
                }
              }
            }
          } else if (meta.ok) {
            cleanupErrors.push({ operation: "recoverSheetIds", class: "response_format", code: "missing_sheets_list" });
          } else {
            cleanupErrors.push({ operation: "recoverSheetIds", class: meta.error.class, code: meta.error.code });
          }
        }
        const sheetIds = [...createdSheetIds.values()].filter((sheetId) => Number.isInteger(sheetId));
        for (let i = 0; i < sheetIds.length; i += BATCH_UPDATE_CHUNK) {
          const chunk = sheetIds.slice(i, i + BATCH_UPDATE_CHUNK);
          const res = await timedRequest(() =>
            client.spreadsheets.batchUpdate(
              {
                spreadsheetId,
                requestBody: { requests: chunk.map((sheetId) => ({ deleteSheet: { sheetId } })) },
              },
              { timeout: REQUEST_TIMEOUT_MS }
            )
          );
          if (res.ok) {
            deletedTabs += chunk.length;
          } else {
            cleanupErrors.push({ operation: "deleteSheet", class: res.error.class, code: res.error.code });
          }
        }
        // Cleanup succeeds only when a verification read shows zero generated
        // tabs remaining; a failed or unknown verification is a cleanup error.
        const verify = await timedRequest(() =>
          client.spreadsheets.get(
            { spreadsheetId, fields: "sheets.properties(title)" },
            { timeout: REQUEST_TIMEOUT_MS }
          )
        );
        let remaining = null;
        if (verify.ok && Array.isArray(verify.data?.data?.sheets)) {
          remaining = verify.data.data.sheets.filter((sheet) =>
            String(sheet?.properties?.title ?? "").startsWith(tabPrefix)
          ).length;
        } else if (verify.ok) {
          cleanupErrors.push({ operation: "cleanupVerify", class: "response_format", code: "missing_sheets_list" });
        } else {
          cleanupErrors.push({ operation: "cleanupVerify", class: verify.error.class, code: verify.error.code });
        }
        cleanup = {
          ok: cleanupErrors.length === 0 && deletedTabs === createdSheetIds.size && remaining === 0,
          tabsCreated: createdSheetIds.size,
          tabsDeleted: deletedTabs,
          remainingGeneratedTabs: remaining,
          durationMs: performance.now() - cleanupStarted,
          errors: cleanupErrors,
        };
      }
    } catch (error) {
      cleanup = {
        ok: false,
        tabsCreated: createdSheetIds.size,
        tabsDeleted: deletedTabs,
        remainingGeneratedTabs: null,
        durationMs: performance.now() - cleanupStarted,
        errors: [...cleanupErrors, { operation: "cleanup", class: classifyError(error).class, code: classifyError(error).code }],
      };
    }
    record.stages.cleanup = cleanup;
    if (cleanup.ok) {
      console.log(`[cleanup] ${cleanup.tabsDeleted}/${cleanup.tabsCreated} tabs deleted in ${Math.round(cleanup.durationMs)} ms`);
    } else {
      console.error(`[cleanup] FAILED: ${cleanup.tabsDeleted}/${cleanup.tabsCreated} deleted, ${cleanup.errors.length} cleanup errors`);
    }
  }

  // ---- Overall result --------------------------------------------------------
  const totalDurationMs = performance.now() - mainStarted;
  const stage0 = record.stages.stage0;
  const stage1Total = record.stages.stage1?.totals ?? null;
  const exitCode =
    !stage0?.ok || (stage1Total !== null && stage1Total.ok === 0) || !cleanup?.ok ? 1 : 0;
  record.overall = {
    exitCode,
    reason:
      !stage0?.ok
        ? "stage0 auth/metadata smoke failed"
        : stage1Total?.ok === 0
          ? "no successful append in stage 1"
          : !cleanup?.ok
            ? "cleanup incomplete"
            : "completed",
    totalDurationMs: Math.round(totalDurationMs),
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
    writeArtifact({ experiment: "direct-sheets-api-service-account", fatal: { class: classified.class, code: classified.code } });
  } catch {
    // artifact write failed; nothing else to report safely
  }
  process.exitCode = 1;
});
