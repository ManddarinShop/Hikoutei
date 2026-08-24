/**
 * Soak-runner startup: live/local mode detection and state loading.
 *
 * `detectLiveMode` derives the run mode purely from the environment (never
 * logs values), and `loadOrInitState` either validates and loads the stored
 * resume state or initializes a fresh one. Both run before the orchestration
 * loop in `runnerOrchestration.mjs` and never touch the runtime.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { validateResumeState } from "./resume.mjs";
import { parseSpreadsheetIdFromUrl } from "./spreadsheetUrl.mjs";


/**
 * Detects live vs local mode from the environment (never logs values).
 *
 * In live mode the direct observation client is built with the MAXIMUM
 * REQUEST/CLOSE deadline — the bounded close deadline past the base
 * workload-admission budget — so every Sheets request timeouts at the
 * minimum of the client default and the remaining close budget, and requests
 * never start after the close deadline expired. Convergence/probe phases
 * additionally pass their own tighter operation deadline
 * (`min(close deadline, now + phase timeout)`) on every call, so a phase can
 * never outlive its own timeout. Local mode ignores the deadline entirely
 * (the client is undefined).
 */
export async function detectLiveMode(deadlineAtMs) {
  const url = process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if ((url === undefined || url.trim() === "") ||
      (credentials === undefined || credentials.trim() === "")) {
    return { mode: "local", spreadsheetId: undefined, client: undefined };
  }
  const spreadsheetId = parseSpreadsheetIdFromUrl(url);
  if (spreadsheetId === undefined) {
    throw new Error(
      "HIKOUTEI_SYNC_SPREADSHEET_URL is set but no spreadsheet ID could be parsed from it",
    );
  }
  // Lazy import keeps the Google SDK out of the local (no-credentials) path.
  const { createDirectSheetsClient } = await import("./sheetsDirect.mjs");
  return {
    mode: "live",
    spreadsheetId,
    client: createDirectSheetsClient({ deadlineAtMs }),
  };
}

/**
 * Loads resume state or initializes a fresh one.
 *
 * `--resume` with a missing, unparseable, or structurally invalid state
 * file fails instead of silently starting a fresh run, so an operator can
 * never mistake a new run for a continuation of the interrupted one. The
 * complete schema is validated BEFORE any runtime opens, so a malformed
 * state can never partially run.
 */
export async function loadOrInitState(artifacts, options, seed, mode, startedClock, progress) {
  if (options.resume) {
    if (!existsSync(artifacts.paths.state)) {
      // A checkpoint marker without state means the run died before its
      // first cycle checkpoint: the seed/params live only in state.json, so
      // recovery is impossible and resuming must NEVER silently start fresh.
      const checkpointPresent = existsSync(artifacts.paths.checkpoint);
      throw new Error(
        checkpointPresent
          ? "--resume requested but no state.json exists in the output dir (checkpoint.json is present, so the run died before its first state checkpoint); start a fresh run without --resume"
          : "--resume requested but no state.json exists in the output dir; " +
            "start a fresh run without --resume",
      );
    }
    let stored;
    try {
      stored = JSON.parse(await readFile(artifacts.paths.state, "utf8"));
    } catch {
      throw new Error("--resume failed: state.json is not valid JSON");
    }
    validateResumeState(stored, mode);
    progress(`resuming run after cycle ${stored.lastCompletedCycle}`);
    return {
      ...stored,
      params: {
        ...stored.params,
        durationMs: options.durationMs,
        maxConsecutiveFailures: options.maxConsecutiveFailures,
      },
    };
  }
  return {
    version: 1,
    runId: `soak-${Date.now().toString(36)}`,
    seed,
    mode,
    startedAtMs: Date.now(),
    params: {
      seed,
      durationMs: options.durationMs,
      intervalSeconds: options.intervalSeconds,
      actors: options.actors,
      operationsPerActor: options.operationsPerActor,
      resolvedTables: options.resolvedTables,
      maxConsecutiveFailures: options.maxConsecutiveFailures,
    },
    lastCompletedCycle: 0,
    cumulative: {
      operations: 0,
      expectedErrors: 0,
      failures: 0,
      retries: 0,
      probes: { total: 0, ok: 0, skipped: 0, failed: 0 },
      convergenceChecks: 0,
      convergenceFailed: 0,
    },
    tableRows: {},
  };
}
