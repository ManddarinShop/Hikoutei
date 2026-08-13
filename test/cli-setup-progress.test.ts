/**
 * Focused tests for `hikoutei setup` step-by-step progress reporting.
 *
 * Covers the pure helpers, the validating tracker (rejection rules, count
 * clamping, transient reset for the login retry), the safe sink, the
 * bounded-check reporter wiring, the append-only (CI/non-TTY/NO_COLOR)
 * renderer, the interactive (TTY) renderer with its known-wait animation
 * and timer cleanup, the retry reporters wired into key provisioning and
 * SA access verification (1/8..8/8 attempt numbering, exact 2, 4, 8, 16,
 * 30, 30, 30 s delays, exhaustion), the end-to-end phase sequence emitted
 * by `runSetup` (fresh run, resume, key retries, dry run, sink-exception
 * safety, no-secrets contract), and the `runSetupCli` login handoff with a
 * real renderer (suspend before login, retry re-render, final 100%).
 */

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_KEY_FILE_NAME } from "../src/cli/setupFlow.js";
import { SETUP_STATE_FILE_NAME, SETUP_STATE_VERSION } from "../src/cli/checkpoint.js";
import { SETUP_ERROR_CODES, type SetupErrorCode } from "../src/cli/errors.js";
import {
  createSaAccessVerifier,
  SA_VERIFY_MAX_ATTEMPTS,
  type SaAccessVerifier,
} from "../src/cli/saVerify.js";
import {
  boundedCheckReporter,
  BOUNDED_CHECK_MAX_ATTEMPTS,
  createSetupProgressRenderer,
  isCiEnvironment,
  NOOP_PROGRESS_SINK,
  overallPercent,
  renderProgressBar,
  safeProgressSink,
  SETUP_PROGRESS_BOUNDED_OPERATIONS,
  SETUP_PROGRESS_OPERATIONS,
  SETUP_PROGRESS_PHASES,
  SETUP_PROGRESS_PHASE_COUNT,
  SetupProgressTracker,
  shouldUseInteractiveProgress,
  type BoundedCheckReporter,
  type SetupBoundedOperation,
  type SetupProgressEvent,
  type SetupProgressOperation,
  type SetupProgressPhase,
  type SetupProgressSink,
  type SetupProgressSource,
} from "../src/cli/setupProgress.js";
import {
  KEY_SETTLE_MAX_ATTEMPTS,
  KEY_SETTLE_POLL_DELAYS_MS,
  settleServiceAccountKey,
  type KeyCreatePermission,
} from "../src/cli/keyProvision.js";
import { runSetup, type RunSetupOptions, type SetupResult } from "../src/cli/setupFlow.js";
import type { PlannedCommand } from "../src/cli/flowResult.js";
import { runSetupCli, type RunSetupCliContext } from "../src/cli/setup.js";
import type { GcloudRunner, GcloudRunResult } from "../src/cli/gcloudRunner.js";
import type { HumanSheetApiFactory, MarkerFileInfo, ShareOutcome } from "../src/cli/sheetsFactory.js";
import { HIKOUTEI_SETUP_MARKER_KEY, SPREADSHEET_MIME_TYPE } from "../src/cli/sheetsFactory.js";
import type { TokenInfo, TokenValidator } from "../src/cli/humanAuth.js";

const OWNER = "owner@example.com";
const TOKEN = "ya29.fake-token";
const FIXED_KEY_ID = "82bb5bd24d2c47bc95bca3ef60e4f335db";
const CREATED_SHEET_ID = "created-sheet-001";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/** Generates one RSA private key PEM (reused across the valid key fixtures). */
function rsaPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

/** Builds a structurally valid service-account key JSON string. */
function validKeyJson(projectId: string, saEmail: string, keyId: string, privateKey: string): string {
  return JSON.stringify({
    type: "service_account",
    project_id: projectId,
    private_key_id: keyId,
    private_key: privateKey,
    client_email: saEmail,
    client_id: "100000000000000000000",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

/** Canonical IAM key resource name (case-folded id). */
function keyResourceName(projectId: string, saEmail: string, keyId: string): string {
  return `projects/${projectId}/serviceAccounts/${saEmail}/keys/${keyId.toLowerCase()}`;
}

/** A capturing sink that records every event verbatim. */
function capturingSink(): { sink: SetupProgressSink; events: () => readonly SetupProgressEvent[] } {
  const events: SetupProgressEvent[] = [];
  return {
    sink: { report: (event) => { events.push(event); } },
    events: () => events,
  };
}

/** A capturing output that stores every written chunk. */
function capturingOutput(): { output: { write: (text: string) => void }; text: () => string } {
  let text = "";
  return {
    output: { write: (chunk: string) => { text += chunk; } },
    text: () => text,
  };
}

/** Builds a phase_started event. */
function started(phase: SetupProgressPhase): SetupProgressEvent {
  return { type: "phase_started", phase };
}

/** Builds a phase_completed event. */
function completed(phase: SetupProgressPhase, source: SetupProgressSource = "run"): SetupProgressEvent {
  return { type: "phase_completed", phase, source };
}

/** Builds a generic operation_started/completed event. */
function operation(
  type: "operation_started" | "operation_completed",
  phase: SetupProgressPhase,
  operationLabel: SetupProgressOperation | SetupBoundedOperation,
): SetupProgressEvent {
  return { type, phase, operation: operationLabel } as SetupProgressEvent;
}

/** Builds a bounded-check operation event with attempt info. */
function checkOperation(
  type: "operation_started" | "operation_completed",
  phase: SetupProgressPhase,
  operationLabel: SetupBoundedOperation,
  attempt: number,
  maxAttempts = 8,
): SetupProgressEvent {
  return { type, phase, operation: operationLabel, check: { attempt, maxAttempts } };
}

/** Builds a retry_wait_started event for the key-settlement kind. */
function keyWait(attempt: number, delayMs: number): SetupProgressEvent {
  return {
    type: "retry_wait_started",
    phase: "service_account_key",
    kind: "key_settlement",
    attempt,
    maxAttempts: KEY_SETTLE_MAX_ATTEMPTS,
    delayMs,
  };
}

/**
 * Events that start and complete every phase strictly before `phase`, so
 * a test can begin a valid sequence at any phase (the tracker enforces
 * phase order).
 */
function prefixEvents(phase: SetupProgressPhase): readonly SetupProgressEvent[] {
  const events: SetupProgressEvent[] = [];
  const index = SETUP_PROGRESS_PHASES.indexOf(phase);
  for (let i = 0; i < index; i += 1) {
    const earlier = SETUP_PROGRESS_PHASES[i] as SetupProgressPhase;
    events.push(started(earlier));
    events.push(completed(earlier));
  }
  return events;
}

describe("setupProgress helpers", () => {
  it("renders a clamped progress bar for fill ratios", () => {
    expect(renderProgressBar(0)).toBe(`[${"░".repeat(20)}]`);
    expect(renderProgressBar(1)).toBe(`[${"█".repeat(20)}]`);
    expect(renderProgressBar(0.5)).toBe(`[${"█".repeat(10)}${"░".repeat(10)}]`);
    // Clamps out-of-range ratios.
    expect(renderProgressBar(-1)).toBe(renderProgressBar(0));
    expect(renderProgressBar(2)).toBe(renderProgressBar(1));
  });

  it("computes whole-percent of completed phases (0..100)", () => {
    expect(overallPercent(0)).toBe(0);
    expect(overallPercent(SETUP_PROGRESS_PHASE_COUNT)).toBe(100);
    expect(overallPercent(5)).toBe(50);
  });

  it("clamps the overall-percent input to the ten logical phases", () => {
    // The tracker count is already clamped, but the helper itself must
    // never render a negative percent or more than 100% from an
    // out-of-range caller value.
    expect(overallPercent(-3)).toBe(0);
    expect(overallPercent(0)).toBe(0);
    expect(overallPercent(5)).toBe(50);
    expect(overallPercent(SETUP_PROGRESS_PHASE_COUNT)).toBe(100);
    expect(overallPercent(11)).toBe(100);
    expect(overallPercent(999)).toBe(100);
  });

  it("detects an automation session only from a non-empty CI value", () => {
    // Mirrors the de-facto CI convention used by the renderer decision:
    // any non-empty value (GitHub Actions, GitLab CI, CircleCI, Travis,
    // ...) marks automation; an empty override keeps interactive behavior.
    expect(isCiEnvironment({})).toBe(false);
    expect(isCiEnvironment({ CI: "" })).toBe(false);
    expect(isCiEnvironment({ CI: "true" })).toBe(true);
    expect(isCiEnvironment({ CI: "1" })).toBe(true);
    expect(isCiEnvironment({ CI: "0" })).toBe(true);
  });

  it("lists exactly ten phases in execution order", () => {
    expect(SETUP_PROGRESS_PHASES).toHaveLength(10);
    expect(SETUP_PROGRESS_PHASES[0]).toBe("cloud_auth");
    expect(SETUP_PROGRESS_PHASES[9]).toBe("output");
  });

  it("exposes fixed safe operation labels and bounded-check labels", () => {
    expect(SETUP_PROGRESS_OPERATIONS.DRIVE_SCOPE).toBe("verifying Drive access");
    expect(SETUP_PROGRESS_OPERATIONS.PROJECT_CREATE).toBe("creating project");
    expect(SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE).toBe("key settlement check");
    expect(SETUP_PROGRESS_BOUNDED_OPERATIONS.SA_ACCESS).toBe("access check");
  });

  it("enables interactive output only on TTY without NO_COLOR or CI", () => {
    // The default-env calls use an explicit empty env so the assertions
    // hold regardless of the ambient NO_COLOR/CI of the test runner.
    expect(shouldUseInteractiveProgress(true, {})).toBe(true);
    expect(shouldUseInteractiveProgress(false, {})).toBe(false);
    expect(shouldUseInteractiveProgress(true, { NO_COLOR: "1" })).toBe(false);
    expect(shouldUseInteractiveProgress(true, { NO_COLOR: "" })).toBe(true);
    expect(shouldUseInteractiveProgress(true, {})).toBe(true);
    // A CI pseudo-TTY must stay static (documented CI behavior), and an
    // empty CI override keeps interactive output like the NO_COLOR rule.
    expect(shouldUseInteractiveProgress(true, { CI: "true" })).toBe(false);
    expect(shouldUseInteractiveProgress(true, { CI: "1" })).toBe(false);
    expect(shouldUseInteractiveProgress(true, { CI: "" })).toBe(true);
    // CI wins even with an empty NO_COLOR override; NO_COLOR behavior is
    // otherwise unchanged.
    expect(shouldUseInteractiveProgress(true, { CI: "true", NO_COLOR: "" })).toBe(false);
    expect(shouldUseInteractiveProgress(false, { CI: "true" })).toBe(false);
  });

  it("returns a no-op sink for undefined and swallows throwing callbacks", () => {
    expect(safeProgressSink(undefined)).toBe(NOOP_PROGRESS_SINK);
    const bomb: SetupProgressSink = { report: () => { throw new Error("boom"); } };
    const safe = safeProgressSink(bomb);
    expect(() => safe.report(started("cloud_auth"))).not.toThrow();
  });
});

describe("SetupProgressTracker", () => {
  it("tracks completed phases and reaches 100% only after every phase completes", () => {
    const tracker = new SetupProgressTracker();
    expect(tracker.completedCount).toBe(0);
    for (const phase of SETUP_PROGRESS_PHASES) {
      expect(tracker.apply(started(phase))).toBe(true);
      expect(tracker.currentPhase).toBe(phase);
      // The overall count does NOT advance until the phase completes.
      expect(tracker.apply(completed(phase))).toBe(true);
    }
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
    expect(overallPercent(tracker.completedCount)).toBe(100);
    expect(tracker.currentPhase).toBeUndefined();
  });

  it("rejects duplicate completion: the count never increments twice", () => {
    const tracker = new SetupProgressTracker();
    for (const event of prefixEvents("project")) {
      tracker.apply(event);
    }
    tracker.apply(started("project"));
    expect(tracker.apply(completed("project"))).toBe(true);
    expect(tracker.completedCount).toBe(3);
    // A second completion (run or checkpoint) is rejected, no matter what.
    expect(tracker.apply(completed("project", "run"))).toBe(false);
    expect(tracker.apply(completed("project", "checkpoint"))).toBe(false);
    expect(tracker.completedCount).toBe(3);
    expect(tracker.isComplete("project")).toBe(true);
  });

  it("rejects a phase_completed for a phase that is not in progress", () => {
    const tracker = new SetupProgressTracker();
    tracker.apply(started("cloud_auth"));
    // Completing a different phase while cloud_auth is current is invalid.
    expect(tracker.apply(completed("project"))).toBe(false);
    expect(tracker.isComplete("project")).toBe(false);
    // Completing a phase that never started is invalid.
    tracker.apply(completed("cloud_auth"));
    expect(tracker.apply(completed("drive_access"))).toBe(false);
  });

  it("rejects out-of-order phase_started events without throwing", () => {
    const tracker = new SetupProgressTracker();
    tracker.apply(started("cloud_auth"));
    // A second phase while cloud_auth is in progress is invalid.
    expect(tracker.apply(started("drive_access"))).toBe(false);
    // A phase whose earlier phases are not complete is invalid.
    tracker.apply(completed("cloud_auth"));
    expect(tracker.apply(started("project"))).toBe(false);
    // An already-completed phase cannot start again.
    tracker.apply(started("drive_access"));
    tracker.apply(completed("drive_access"));
    expect(tracker.apply(started("drive_access"))).toBe(false);
    expect(tracker.currentPhase).toBeUndefined();
  });

  it("rejects a checkpoint-source completion whose earlier phases are incomplete", () => {
    const tracker = new SetupProgressTracker();
    expect(tracker.apply(completed("project", "checkpoint"))).toBe(false);
    expect(tracker.isComplete("project")).toBe(false);
    tracker.apply(started("cloud_auth"));
    tracker.apply(completed("cloud_auth"));
    tracker.apply(started("drive_access"));
    tracker.apply(completed("drive_access"));
    expect(tracker.apply(completed("project", "checkpoint"))).toBe(true);
    expect(tracker.completedCount).toBe(3);
  });

  it("validates operation start/complete pairing", () => {
    const tracker = new SetupProgressTracker();
    // An operation outside a phase is rejected.
    expect(tracker.apply(operation("operation_started", "cloud_auth", SETUP_PROGRESS_OPERATIONS.GCLOUD_PRESENCE))).toBe(false);
    tracker.apply(started("cloud_auth"));
    expect(tracker.apply(operation("operation_started", "cloud_auth", SETUP_PROGRESS_OPERATIONS.GCLOUD_PRESENCE))).toBe(true);
    expect(tracker.activeOperation?.operation).toBe("checking gcloud CLI");
    // A completion for a different operation is rejected.
    expect(tracker.apply(operation("operation_completed", "cloud_auth", SETUP_PROGRESS_OPERATIONS.ACTIVE_ACCOUNT))).toBe(false);
    expect(tracker.apply(operation("operation_completed", "cloud_auth", SETUP_PROGRESS_OPERATIONS.GCLOUD_PRESENCE))).toBe(true);
    // A completion without a matching start is rejected.
    expect(tracker.apply(operation("operation_completed", "cloud_auth", SETUP_PROGRESS_OPERATIONS.GCLOUD_PRESENCE))).toBe(false);
    expect(tracker.activeOperation).toBeUndefined();
  });

  it("validates bounded-check operation pairing and attempt info", () => {
    const tracker = new SetupProgressTracker();
    for (const event of prefixEvents("service_account_key")) {
      tracker.apply(event);
    }
    tracker.apply(started("service_account_key"));
    // The bounded operation must match the phase's hosted kind and carry
    // valid attempt info.
    expect(tracker.apply(checkOperation("operation_started", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, 2))).toBe(true);
    expect(tracker.activeRetry?.attempt).toBe(2);
    expect(tracker.activeRetry?.kind).toBe("key_settlement");
    // A mismatched attempt cannot complete the check.
    expect(tracker.apply(checkOperation("operation_completed", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, 3))).toBe(false);
    expect(tracker.apply(checkOperation("operation_completed", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, 2))).toBe(true);
    // The bounded operation label must match the phase's kind.
    expect(tracker.apply(checkOperation("operation_started", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.SA_ACCESS, 1))).toBe(false);
    // Out-of-range attempt info is rejected.
    expect(tracker.apply(checkOperation("operation_started", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, 0))).toBe(false);
    expect(tracker.apply(checkOperation("operation_started", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, 9))).toBe(false);
  });

  it("rejects attempt/maxAttempts pairs beyond the fixed eight-attempt contract", () => {
    const tracker = new SetupProgressTracker();
    for (const event of prefixEvents("service_account_key")) {
      tracker.apply(event);
    }
    tracker.apply(started("service_account_key"));
    // Both polls run exactly eight checks; a window of any other size is
    // impossible and must be rejected before it reaches the detail bar.
    expect(
      tracker.apply(checkOperation("operation_started", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, 1, 9)),
    ).toBe(false);
    expect(
      tracker.apply(checkOperation("operation_started", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, 2, 7)),
    ).toBe(false);
    expect(
      tracker.apply({
        type: "retry_wait_started",
        phase: "service_account_key",
        kind: "key_settlement",
        attempt: 1,
        maxAttempts: 9,
        delayMs: 2000,
      }),
    ).toBe(false);
    expect(
      tracker.apply({
        type: "retry_wait_started",
        phase: "service_account_key",
        kind: "key_settlement",
        attempt: 9,
        maxAttempts: BOUNDED_CHECK_MAX_ATTEMPTS,
        delayMs: 2000,
      }),
    ).toBe(false);
    // The fixed eight-attempt window itself stays valid.
    expect(tracker.apply(keyWait(1, 2000))).toBe(true);
    expect(tracker.activeRetry?.maxAttempts).toBe(BOUNDED_CHECK_MAX_ATTEMPTS);
  });

  it("validates retry kind/phase consistency and attempt bounds", () => {
    const tracker = new SetupProgressTracker();
    for (const event of prefixEvents("service_account_key")) {
      tracker.apply(event);
    }
    tracker.apply(started("service_account_key"));
    expect(tracker.apply(keyWait(2, 4000))).toBe(true);
    expect(tracker.activeRetry).toMatchObject({ phase: "service_account_key", kind: "key_settlement", attempt: 2, maxAttempts: 8 });
    // The sa_access kind does not belong to the key phase.
    expect(
      tracker.apply({
        type: "retry_wait_started",
        phase: "service_account_key",
        kind: "sa_access",
        attempt: 1,
        maxAttempts: 8,
        delayMs: 2000,
      }),
    ).toBe(false);
    // Out-of-range attempts and negative delays are rejected.
    expect(tracker.apply({ ...keyWait(0, 2000) })).toBe(false);
    expect(tracker.apply({ ...keyWait(9, 2000) })).toBe(false);
    expect(tracker.apply({ ...keyWait(1, -1) })).toBe(false);
    // A wait outside its phase is rejected.
    tracker.apply(completed("service_account_key"));
    expect(tracker.apply(keyWait(1, 2000))).toBe(false);
  });

  it("accepts only valid checkpoint phase lists (prefixes of the resumable phases)", () => {
    const tracker = new SetupProgressTracker();
    // Empty (project_selected resume) and real prefixes are accepted.
    expect(tracker.apply({ type: "resumed", completedFromCheckpoint: [] })).toBe(true);
    expect(tracker.apply({ type: "resumed", completedFromCheckpoint: ["project", "apis", "service_account"] })).toBe(true);
    expect(tracker.apply({ type: "resumed", completedFromCheckpoint: ["project", "apis", "service_account", "service_account_key", "spreadsheet", "share", "sa_access"] })).toBe(true);
    expect(tracker.completedCount).toBe(7);
    expect(tracker.isResumed).toBe(true);
  });

  it("rejects invalid checkpoint phase lists without throwing", () => {
    const reject = (list: readonly unknown[]): void => {
      const tracker = new SetupProgressTracker();
      expect(() => tracker.apply({ type: "resumed", completedFromCheckpoint: list as readonly SetupProgressPhase[] })).not.toThrow();
      expect(tracker.apply({ type: "resumed", completedFromCheckpoint: list as readonly SetupProgressPhase[] })).toBe(false);
      expect(tracker.completedCount).toBe(0);
      expect(tracker.isResumed).toBe(false);
    };
    // cloud_auth/drive_access/output are never checkpoint-complete.
    reject(["cloud_auth"]);
    reject(["output"]);
    // Gaps, out-of-order entries, duplicates, unknown values, and
    // non-array values are all invalid shapes.
    reject(["project", "service_account"]);
    reject(["apis", "project"]);
    reject(["project", "project"]);
    reject(["not_a_phase"]);
    reject(["project", "project", "project", "project", "project", "project", "project", "project"]);
    const tracker = new SetupProgressTracker();
    expect(tracker.apply({ type: "resumed", completedFromCheckpoint: undefined as unknown as readonly SetupProgressPhase[] })).toBe(false);
  });

  it("rejects phase_failed events with non-stable codes or a non-current phase", () => {
    const tracker = new SetupProgressTracker();
    for (const event of prefixEvents("share")) {
      tracker.apply(event);
    }
    expect(
      tracker.apply({
        type: "phase_failed",
        phase: "share",
        code: "not-a-real-code" as SetupErrorCode,
      }),
    ).toBe(false);
    expect(tracker.apply({ type: "phase_failed", phase: "share", code: SETUP_ERROR_CODES.SHEET_SHARE_FAILED })).toBe(false);
    tracker.apply(started("share"));
    expect(tracker.apply({ type: "phase_failed", phase: "share", code: SETUP_ERROR_CODES.SHEET_SHARE_FAILED })).toBe(true);
    expect(tracker.failure?.phase).toBe("share");
    expect(tracker.failure?.code).toBe("sheet_share_failed");
    expect(tracker.currentPhase).toBeUndefined();
  });

  it("clamps the overall count to the ten logical phases", () => {
    const tracker = new SetupProgressTracker();
    tracker.apply({ type: "resumed", completedFromCheckpoint: ["project", "apis", "service_account", "service_account_key", "spreadsheet", "share", "sa_access"] });
    tracker.apply(started("cloud_auth"));
    tracker.apply(completed("cloud_auth"));
    tracker.apply(started("drive_access"));
    tracker.apply(completed("drive_access"));
    // The resumed spreadsheet phase can never complete again on a resume.
    expect(tracker.apply(started("spreadsheet"))).toBe(false);
    expect(tracker.apply(completed("spreadsheet"))).toBe(false);
    tracker.apply(started("output"));
    tracker.apply(completed("output"));
    expect(tracker.completedCount).toBe(10);
    expect(overallPercent(tracker.completedCount)).toBe(100);
  });

  it("resetTransient clears in-progress state so a login retry can re-run phases", () => {
    const tracker = new SetupProgressTracker();
    // Scenario A: the first attempt died mid-cloud_auth (auth preflight).
    tracker.apply(started("cloud_auth"));
    tracker.apply({ type: "phase_failed", phase: "cloud_auth", code: SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN });
    tracker.resetTransient();
    // The retry re-runs cloud_auth from scratch.
    expect(tracker.apply(started("cloud_auth"))).toBe(true);
    expect(tracker.apply(completed("cloud_auth"))).toBe(true);
    expect(tracker.completedCount).toBe(1);
    // Scenario B: the first attempt completed cloud_auth then died during
    // drive_access; the retry's re-run of completed phases is rejected (the
    // count stays correct) and the retry continues from the next phase.
    expect(tracker.apply(started("drive_access"))).toBe(true);
    expect(tracker.apply(completed("drive_access"))).toBe(true);
    tracker.resetTransient();
    expect(tracker.apply(started("cloud_auth"))).toBe(false);
    expect(tracker.apply(completed("cloud_auth"))).toBe(false);
    expect(tracker.apply(started("drive_access"))).toBe(false);
    expect(tracker.apply(started("project"))).toBe(true);
    expect(tracker.apply(completed("project"))).toBe(true);
    expect(tracker.completedCount).toBe(3);
    expect(tracker.isComplete("cloud_auth")).toBe(true);
    expect(tracker.isComplete("drive_access")).toBe(true);
  });

  it("a phase_started after a failure clears the failure display (retry context)", () => {
    const tracker = new SetupProgressTracker();
    tracker.apply(started("cloud_auth"));
    tracker.apply({ type: "phase_failed", phase: "cloud_auth", code: SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN });
    expect(tracker.failure?.code).toBe("gcloud_not_logged_in");
    tracker.resetTransient();
    expect(tracker.apply(started("cloud_auth"))).toBe(true);
    expect(tracker.failure).toBeUndefined();
  });
});

describe("boundedCheckReporter", () => {
  it("forwards check and wait events as operation/retry events for the key phase", () => {
    const { sink, events } = capturingSink();
    const report = boundedCheckReporter(sink, "service_account_key", "key_settlement");
    report({ type: "check_started", attempt: 1, maxAttempts: 8 });
    report({ type: "check_completed", attempt: 1, maxAttempts: 8 });
    report({ type: "wait_started", attempt: 1, maxAttempts: 8, delayMs: 2000 });
    expect(events()).toStrictEqual([
      {
        type: "operation_started",
        phase: "service_account_key",
        operation: "key settlement check",
        check: { attempt: 1, maxAttempts: 8 },
      },
      {
        type: "operation_completed",
        phase: "service_account_key",
        operation: "key settlement check",
        check: { attempt: 1, maxAttempts: 8 },
      },
      {
        type: "retry_wait_started",
        phase: "service_account_key",
        kind: "key_settlement",
        attempt: 1,
        maxAttempts: 8,
        delayMs: 2000,
      },
    ]);
  });

  it("forwards the sa_access kind with its own bounded operation label", () => {
    const { sink, events } = capturingSink();
    const report = boundedCheckReporter(sink, "sa_access", "sa_access");
    report({ type: "check_started", attempt: 3, maxAttempts: 8 });
    expect(events()[0]).toMatchObject({
      type: "operation_started",
      phase: "sa_access",
      operation: "access check",
      check: { attempt: 3, maxAttempts: 8 },
    });
  });

  it("is a no-op for the NOOP sink (no event emitted)", () => {
    const report: BoundedCheckReporter = boundedCheckReporter(NOOP_PROGRESS_SINK, "service_account_key", "key_settlement");
    expect(() =>
      report({ type: "wait_started", attempt: 1, maxAttempts: 8, delayMs: 2000 }),
    ).not.toThrow();
  });
});

describe("append-only progress renderer (CI / non-TTY / NO_COLOR)", () => {
  it("prints one static line per phase/retry/failure event with no ANSI", () => {
    const { output, text } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: false });
    renderer.report(started("cloud_auth"));
    renderer.report(completed("cloud_auth"));
    for (const event of prefixEvents("service_account_key").slice(2)) {
      renderer.report(event);
    }
    renderer.report(started("service_account_key"));
    renderer.report(keyWait(2, 4000));
    renderer.finish();
    const out = text();
    expect(out).toContain("Hikoutei setup progress");
    expect(out).toContain("[   0% | 0/10] Google Cloud authentication");
    expect(out).toContain("[  10% | 1/10] ✓ Google Cloud authentication ready");
    expect(out).toContain("  [ 2/8] waiting 4s before next key check");
    // No ANSI cursor or erase control sequences in append-only mode.
    expect(out).not.toContain("\x1b[");
  });

  it("never schedules a clock tick in append-only mode", () => {
    const { output } = capturingOutput();
    const scheduled: unknown[] = [];
    const renderer = createSetupProgressRenderer({
      output,
      isTty: false,
      setInterval: (fn, ms) => { scheduled.push({ fn, ms }); return { unref: () => undefined } as unknown as NodeJS.Timeout; },
      clearInterval: () => undefined,
    });
    renderer.report(started("service_account_key"));
    renderer.report(keyWait(1, 2000));
    expect(scheduled).toHaveLength(0);
  });

  it("ordinary operation events update state without printing a line", () => {
    const { output, text } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: false });
    renderer.report(started("cloud_auth"));
    renderer.report(completed("cloud_auth"));
    renderer.report(started("drive_access"));
    renderer.report(operation("operation_started", "drive_access", SETUP_PROGRESS_OPERATIONS.DRIVE_SCOPE));
    renderer.report(operation("operation_completed", "drive_access", SETUP_PROGRESS_OPERATIONS.DRIVE_SCOPE));
    renderer.report(completed("drive_access"));
    const out = text();
    // Header + two cloud_auth lines + two drive_access lines: no operation
    // lines are ever printed.
    expect(out.split("\n").filter((line) => line.length > 0)).toHaveLength(5);
    expect(out).not.toContain("verifying Drive access\n");
  });

  it("draws nothing for a rejected event", () => {
    const { output, text } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: false });
    for (const event of prefixEvents("service_account_key")) {
      renderer.report(event);
    }
    renderer.report(started("service_account_key"));
    // Wrong retry kind for the phase: rejected, no line printed.
    renderer.report({
      type: "retry_wait_started",
      phase: "service_account_key",
      kind: "sa_access",
      attempt: 1,
      maxAttempts: 8,
      delayMs: 2000,
    });
    expect(text()).not.toContain("waiting");
  });

  it("annotates resume with the already-complete step count", () => {
    const { output, text } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: false });
    // The real flow completes the fresh auth/drive phases before the
    // resumed checkpoint context is reported.
    renderer.report(started("cloud_auth"));
    renderer.report(completed("cloud_auth"));
    renderer.report(started("drive_access"));
    renderer.report(completed("drive_access"));
    renderer.report({ type: "resumed", completedFromCheckpoint: ["project", "apis", "service_account"] });
    renderer.report(started("service_account_key"));
    const out = text();
    // The resume line carries the total completed count so far (the two
    // fresh auth/drive phases plus the three checkpoint-guaranteed ones).
    expect(out).toContain("resuming; 5/10 steps already complete");
    expect(out).toContain("[  50% | 5/10] Service-account key");
  });

  it("prints a failure line on fail()", () => {
    const { output, text } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: false });
    for (const event of prefixEvents("share")) {
      renderer.report(event);
    }
    renderer.report(started("share"));
    renderer.fail(SETUP_ERROR_CODES.SHEET_SHARE_FAILED);
    expect(text()).toContain("[ FAIL | sheet_share_failed] Share and ownership");
  });

  it("prints one line per bounded-check attempt including the final 8/8", () => {
    const { output, text } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: false });
    for (const event of prefixEvents("service_account_key")) {
      renderer.report(event);
    }
    renderer.report(started("service_account_key"));
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      renderer.report(checkOperation("operation_started", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, attempt));
      renderer.report(checkOperation("operation_completed", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, attempt));
      if (attempt < 8) {
        renderer.report(keyWait(attempt, 2000));
      }
    }
    renderer.report(completed("service_account_key"));
    const out = text();
    // Every attempt is visible, including the final 8/8 that has no
    // following wait line before success/failure.
    expect(out).toContain("  [ 1/8] key settlement check");
    expect(out).toContain("  [ 8/8] key settlement check");
    expect(out.match(/key settlement check/g)).toHaveLength(8);
    // One line per attempt (the completions print nothing extra) and no
    // ANSI sequences in static mode.
    expect(out).not.toContain("\x1b[");
  });

  it("prints the suspended phase's failure line after suspend()", () => {
    const { output, text } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: false });
    for (const event of prefixEvents("drive_access")) {
      renderer.report(event);
    }
    renderer.report(started("drive_access"));
    // The login handoff cleared the in-progress state; a cancelled or
    // failed handoff must still print a stable failure line naming the
    // phase the run died in.
    renderer.suspend();
    renderer.fail(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED);
    expect(text()).toContain("[ FAIL | gcloud_drive_access_required] Drive access");
  });
});

describe("interactive progress renderer (TTY)", () => {
  /** Builds a renderer with injectable clock/scheduler so tests need no real timers. */
  function interactiveRenderer() {
    const { output, text } = capturingOutput();
    let nowMs = 0;
    const handles: Array<{ readonly fn: () => void; readonly ms: number; cancelled: boolean }> = [];
    const setIntervalFn = (fn: () => void, ms: number) => {
      const handle = { fn, ms, cancelled: false };
      handles.push(handle);
      return handle as unknown as NodeJS.Timeout;
    };
    const clearIntervalFn = (handle: NodeJS.Timeout) => {
      const entry = handles.find((h) => (h as unknown) === handle);
      if (entry !== undefined) {
        entry.cancelled = true;
      }
    };
    const tick = (ms: number): void => {
      nowMs += ms;
      for (const handle of [...handles]) {
        if (handle.cancelled) {
          continue;
        }
        if (nowMs % handle.ms === 0 || ms >= handle.ms) {
          handle.fn();
        }
      }
    };
    const renderer = createSetupProgressRenderer({
      output,
      isTty: true,
      // Forced: interactive-mode tests must not depend on the ambient
      // NO_COLOR/CI environment (CI runs set CI=true and would flip the
      // renderer to static mode).
      interactive: true,
      now: () => nowMs,
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
    });
    return { renderer, text, tick, activeHandles: () => handles.filter((h) => !h.cancelled) };
  }

  it("draws a four-line in-place block with ANSI cursor/erase sequences", () => {
    const { renderer, text } = interactiveRenderer();
    renderer.report(started("cloud_auth"));
    const out = text();
    expect(out).toContain("\x1b[2K");
    expect(out).toContain("Overall");
    expect(out).toContain("Detail");
    expect(out).toContain("Done");
    expect(out).toContain("working… google cloud authentication");
  });

  it("shows a fixed working label for a generic operation", () => {
    const { renderer, text } = interactiveRenderer();
    for (const event of prefixEvents("drive_access")) {
      renderer.report(event);
    }
    renderer.report(started("drive_access"));
    renderer.report(operation("operation_started", "drive_access", SETUP_PROGRESS_OPERATIONS.DRIVE_SCOPE));
    expect(text()).toContain("working… verifying Drive access");
    renderer.report(operation("operation_completed", "drive_access", SETUP_PROGRESS_OPERATIONS.DRIVE_SCOPE));
    expect(text()).toContain("working… drive access");
  });

  it("shows the bounded check attempt/max between waits and animates a known wait", () => {
    const { renderer, text, tick, activeHandles } = interactiveRenderer();
    for (const event of prefixEvents("service_account_key")) {
      renderer.report(event);
    }
    renderer.report(started("service_account_key"));
    renderer.report(checkOperation("operation_started", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, 1));
    expect(text()).toContain("1/8  key settlement check");
    renderer.report(checkOperation("operation_completed", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, 1));
    renderer.report(keyWait(1, 4000));
    expect(activeHandles().length).toBe(1);
    expect(text()).toContain("1/8  waiting 4s before next key check");
    // A quarter of the 4s wait has elapsed: the detail bar reflects it.
    tick(1000);
    expect(text()).toContain(renderProgressBar(0.25));
    // The next check event clears the timer.
    renderer.report(checkOperation("operation_started", "service_account_key", SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE, 2));
    expect(activeHandles().length).toBe(0);
  });

  it("shows the failure code in the detail line after fail()", () => {
    const { renderer, text } = interactiveRenderer();
    for (const event of prefixEvents("share")) {
      renderer.report(event);
    }
    renderer.report(started("share"));
    renderer.fail(SETUP_ERROR_CODES.SHEET_SHARE_FAILED);
    expect(text()).toContain("failed: sheet_share_failed");
    expect(text()).toContain("✗ Share");
  });

  it("shows the next pending phase in the Overall label between phases and reserves 'complete' for 10/10", () => {
    const { renderer, text } = interactiveRenderer();
    // cloud_auth completes: no phase is current at the 1/10 boundary, so
    // the label must name the next pending phase, never "complete".
    renderer.report(started("cloud_auth"));
    renderer.report(completed("cloud_auth"));
    expect(text()).toContain("10% 1/10  next: Drive access");
    expect(text()).not.toContain("10% 1/10  complete");
    // A mid-run boundary at 5/10 names the next pending phase too.
    for (const event of prefixEvents("service_account")) {
      renderer.report(event);
    }
    renderer.report(started("service_account"));
    renderer.report(completed("service_account"));
    expect(text()).toContain("50% 5/10  next: Service-account key");
    expect(text()).not.toContain("50% 5/10  complete");
    // Only a fully completed run (10/10) earns the literal "complete".
    for (const event of prefixEvents("output")) {
      renderer.report(event);
    }
    renderer.report(started("output"));
    renderer.report(completed("output"));
    expect(text()).toContain("100% 10/10  complete");
  });

  it("fail() after suspend() renders the suspended phase's failure", () => {
    const { renderer, text } = interactiveRenderer();
    for (const event of prefixEvents("drive_access")) {
      renderer.report(event);
    }
    renderer.report(started("drive_access"));
    // The login handoff cleared the in-progress state; a cancelled or
    // failed handoff must still render a stable failure frame naming the
    // phase the run died in.
    renderer.suspend();
    renderer.fail(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED);
    expect(text()).toContain("failed: gcloud_drive_access_required");
    expect(text()).toContain("✗ Drive access");
  });

  it("resume() clears the suspended phase so a retry failure uses the retry's own state", () => {
    const { renderer, text } = interactiveRenderer();
    for (const event of prefixEvents("drive_access")) {
      renderer.report(event);
    }
    renderer.report(started("drive_access"));
    // The login handoff suspends the block and remembers the phase; the
    // login then succeeds, ending the suspension.
    renderer.suspend();
    renderer.resume();
    // The retry re-runs the fresh drive_access phase, completes it, and
    // dies before any new phase is accepted (e.g. lock contention).
    renderer.report(started("drive_access"));
    renderer.report(completed("drive_access"));
    renderer.fail(SETUP_ERROR_CODES.SETUP_IN_PROGRESS);
    expect(text()).toContain("failed: setup_in_progress");
    // The frame names the retry's next pending phase (Project), never the
    // stale pre-login phase (Drive access).
    expect(text()).toContain("✗ Project");
    expect(text()).not.toContain("✗ Drive access");
  });

  it("resume() clears the suspended phase in append-only mode too", () => {
    const { output, text } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: false });
    for (const event of prefixEvents("drive_access")) {
      renderer.report(event);
    }
    renderer.report(started("drive_access"));
    renderer.suspend();
    renderer.resume();
    renderer.report(started("drive_access"));
    renderer.report(completed("drive_access"));
    renderer.fail(SETUP_ERROR_CODES.SETUP_IN_PROGRESS);
    const out = text();
    expect(out).toContain("[ FAIL | setup_in_progress] Project");
    expect(out).not.toContain("[ FAIL | setup_in_progress] Drive access");
  });

  it("suspend() clears the block, the timer, and the in-progress tracker state", () => {
    const { renderer, text, activeHandles } = interactiveRenderer();
    for (const event of prefixEvents("service_account_key")) {
      renderer.report(event);
    }
    renderer.report(started("service_account_key"));
    renderer.report(keyWait(1, 2000));
    expect(activeHandles().length).toBe(1);
    renderer.suspend();
    expect(activeHandles().length).toBe(0);
    // The cleared block is erased with ANSI erase-line sequences.
    expect(text()).toContain("\x1b[2K");
    // The tracker was reset: the login retry can re-run phases from
    // scratch and redraws the block.
    renderer.report(started("cloud_auth"));
    expect(text()).toContain("working… google cloud authentication");
  });

  it("finish() renders the final block and clears the timer", () => {
    const { renderer, text, activeHandles } = interactiveRenderer();
    for (const event of prefixEvents("service_account_key")) {
      renderer.report(event);
    }
    renderer.report(started("service_account_key"));
    renderer.report(keyWait(1, 2000));
    renderer.report(completed("service_account_key"));
    renderer.finish();
    expect(activeHandles().length).toBe(0);
    expect(text()).toContain("✓ Key");
  });
});

describe("createSaAccessVerifier progress events", () => {
  /** Raw reporter events produced by the verifier (pre-wiring shapes). */
  type RawCheckEvent =
    | { readonly type: "check_started"; readonly attempt: number; readonly maxAttempts: number }
    | { readonly type: "check_completed"; readonly attempt: number; readonly maxAttempts: number }
    | { readonly type: "wait_started"; readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number };

  function eventsOf(getClient: () => { get(request: { spreadsheetId: string }): Promise<{ readonly data: unknown }> }): {
    events: () => readonly RawCheckEvent[];
    promise: Promise<void>;
  } {
    const raw: RawCheckEvent[] = [];
    const verifier: SaAccessVerifier = createSaAccessVerifier({
      sleeper: { sleep: async () => { /* instant */ } },
      getClient,
    });
    const promise = verifier.verify({
      keyPath: "/tmp/key.json",
      spreadsheetId: "sheet-1",
      keyFresh: true,
      shareFresh: true,
      credentials: { client_email: "sa@proj.iam.gserviceaccount.com", private_key: "pk" },
      onVerifyProgress: (event) => { raw.push(event); },
    });
    return { events: () => raw, promise };
  }

  it("reports every attempt 1/8..N/8 and a wait only after retryable failures", async () => {
    let calls = 0;
    const { events, promise } = eventsOf(() => ({
      async get(): Promise<{ readonly data: unknown }> {
        calls += 1;
        if (calls <= 2) {
          // 429 quota is always retryable.
          throw Object.assign(new Error("rate limit"), { response: { status: 429 } });
        }
        return { data: { spreadsheetId: "sheet-1" } };
      },
    }));
    await promise;
    expect(calls).toBe(3);
    expect(events()).toStrictEqual([
      { type: "check_started", attempt: 1, maxAttempts: SA_VERIFY_MAX_ATTEMPTS },
      { type: "check_completed", attempt: 1, maxAttempts: SA_VERIFY_MAX_ATTEMPTS },
      { type: "wait_started", attempt: 1, maxAttempts: SA_VERIFY_MAX_ATTEMPTS, delayMs: 2000 },
      { type: "check_started", attempt: 2, maxAttempts: SA_VERIFY_MAX_ATTEMPTS },
      { type: "check_completed", attempt: 2, maxAttempts: SA_VERIFY_MAX_ATTEMPTS },
      { type: "wait_started", attempt: 2, maxAttempts: SA_VERIFY_MAX_ATTEMPTS, delayMs: 4000 },
      { type: "check_started", attempt: 3, maxAttempts: SA_VERIFY_MAX_ATTEMPTS },
      { type: "check_completed", attempt: 3, maxAttempts: SA_VERIFY_MAX_ATTEMPTS },
    ]);
  });

  it("fails immediately with no wait for a non-retryable failure", async () => {
    const { events, promise } = eventsOf(() => ({
      async get(): Promise<{ readonly data: unknown }> {
        // 401 is not retryable.
        throw Object.assign(new Error("unauth"), { response: { status: 401 } });
      },
    }));
    await expect(promise).rejects.toThrow();
    expect(events()).toStrictEqual([
      { type: "check_started", attempt: 1, maxAttempts: SA_VERIFY_MAX_ATTEMPTS },
      { type: "check_completed", attempt: 1, maxAttempts: SA_VERIFY_MAX_ATTEMPTS },
    ]);
  });

  it("reports all eight attempts with the exact 2,4,8,16,30,30,30s schedule on exhaustion", async () => {
    const { events, promise } = eventsOf(() => ({
      async get(): Promise<{ readonly data: unknown }> {
        throw Object.assign(new Error("quota"), { response: { status: 429 } });
      },
    }));
    await expect(promise).rejects.toThrow();
    const started = events().filter((e) => e.type === "check_started");
    const waits = events().filter((e) => e.type === "wait_started");
    expect(started).toHaveLength(SA_VERIFY_MAX_ATTEMPTS);
    expect(started.map((e) => (e as { readonly attempt: number }).attempt)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(waits.map((e) => (e as { readonly delayMs: number }).delayMs)).toStrictEqual([...KEY_SETTLE_POLL_DELAYS_MS]);
    // The 8/8 attempt is reported even though the window is exhausted.
    expect(events().filter((e) => e.type === "check_completed")).toHaveLength(SA_VERIFY_MAX_ATTEMPTS);
  });

  it("swallows a throwing progress callback without changing the verdict", async () => {
    const verifier: SaAccessVerifier = createSaAccessVerifier({
      sleeper: { sleep: async () => { /* instant */ } },
      getClient: () => ({
        async get(): Promise<{ readonly data: unknown }> {
          return { data: { spreadsheetId: "sheet-1" } };
        },
      }),
    });
    await expect(
      verifier.verify({
        keyPath: "/tmp/key.json",
        spreadsheetId: "sheet-1",
        keyFresh: true,
        shareFresh: true,
        credentials: { client_email: "sa@proj.iam.gserviceaccount.com", private_key: "pk" },
        onVerifyProgress: () => { throw new Error("reporter exploded"); },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("settleServiceAccountKey progress events", () => {
  /** Scripts a settle that never produces evidence: the key list is always
   * empty and (for fresh) the create writes no staged key, so the bounded
   * window exhausts with the exact reporter stream. */
  async function exhaustWith(createPermission: KeyCreatePermission): Promise<{
    readonly events: readonly SetupProgressEvent[];
    readonly code: SetupErrorCode | undefined;
    readonly creates: number;
  }> {
    const { sink, events } = capturingSink();
    let creates = 0;
    const runner: GcloudRunner = {
      async run(args, options): Promise<GcloudRunResult> {
        if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
          creates += 1;
          // The create "succeeds" but writes nothing: no local evidence.
          return { status: "ok", stdout: "", stderr: "" };
        }
        if (args[0] === "iam" && args[2] === "keys" && args[3] === "list") {
          return { status: "ok", stdout: "", stderr: "" };
        }
        return { status: "ok", stdout: "", stderr: "" };
      },
    };
    const executed: PlannedCommand[] = [];
    const report = boundedCheckReporter(sink, "service_account_key", "key_settlement");
    const outcome = await settleServiceAccountKey(runner, executed, {
      keyPath: join(tmpdir(), "exhaust-key.json"),
      projectId: "hikoutei-proj",
      saEmail: "hikoutei-sa@hikoutei-proj.iam.gserviceaccount.com",
      keyMarker: "marker",
      baseline: [],
      createPermission,
      sleeper: { sleep: async () => { /* instant */ } },
      onSettleProgress: report,
    });
    return {
      events: events(),
      code: outcome.status === "error" ? outcome.error.code : undefined,
      creates,
    };
  }

  it("numbers the fresh post-create immediate evidence 1/8 and exhausts at 8/8 with the exact schedule", async () => {
    const { events, code, creates } = await exhaustWith("fresh");
    expect(creates).toBe(1);
    expect(code).toBe(SETUP_ERROR_CODES.KEY_CREATE_UNCERTAIN);
    const checks = events.filter((e) => e.type === "operation_started" && "check" in e);
    const completedChecks = events.filter((e) => e.type === "operation_completed" && "check" in e);
    const waits = events.filter((e) => e.type === "retry_wait_started");
    expect(checks.map((e) => (e as { readonly check: { readonly attempt: number } }).check.attempt)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(completedChecks).toHaveLength(8);
    expect(waits.map((e) => (e as { readonly delayMs: number }).delayMs)).toStrictEqual([...KEY_SETTLE_POLL_DELAYS_MS]);
    expect(waits.map((e) => (e as { readonly attempt: number }).attempt)).toStrictEqual([1, 2, 3, 4, 5, 6, 7]);
    // The last check (8/8) is represented even though the window exhausted.
    expect(checks[7]).toMatchObject({
      type: "operation_started",
      phase: "service_account_key",
      operation: "key settlement check",
      check: { attempt: 8, maxAttempts: KEY_SETTLE_MAX_ATTEMPTS },
    });
  });

  it("numbers the reconcile first evidence 1/8 (no create is issued)", async () => {
    const { events, code, creates } = await exhaustWith("reconcile");
    expect(creates).toBe(0);
    expect(code).toBe(SETUP_ERROR_CODES.KEY_CREATE_UNCERTAIN);
    const checks = events.filter((e) => e.type === "operation_started" && "check" in e);
    expect(checks.map((e) => (e as { readonly check: { readonly attempt: number } }).check.attempt)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

/**
 * Minimal runSetup harness for progress integration tests. Scripts a fully
 * fresh successful setup by default; tests override `runnerScript`,
 * `tokenInfo`, and `verifyError` to exercise retries and resume.
 */
function createProgressHarness(dir: string): {
  readonly keyPath: string;
  readonly outputPath: string;
  readonly statePath: string;
  privateKey: string;
  runnerScript: ((args: readonly string[], options?: { readonly cwd?: string }) => GcloudRunResult) | undefined;
  tokenInfo: TokenInfo;
  verifyError: Error | undefined;
  /** Number of post-create key-list calls that return empty before the key appears (forces settlement retries). */
  hideKeyForCalls: number;
  /** Files the creation-marker lookup returns (lets a resume reconcile by marker). */
  markerFiles: readonly MarkerFileInfo[];
  run(options?: Partial<RunSetupOptions> & { readonly progress?: SetupProgressSink }): Promise<SetupResult>;
} {
  const keyPath = join(dir, DEFAULT_KEY_FILE_NAME);
  const outputPath = join(dir, ".env");
  const statePath = join(dir, SETUP_STATE_FILE_NAME);
  const privateKey = rsaPrivateKey();
  let created = false;
  // Number of user-managed key list calls issued AFTER the create; lets a
  // test delay key propagation to force settlement retries.
  let postCreateListCalls = 0;

  const defaultScript = (args: readonly string[], options?: { readonly cwd?: string }): GcloudRunResult => {
    if (args[0] === "--version") {
      return { status: "ok", stdout: "Google Cloud SDK 500.0.0\n", stderr: "" };
    }
    if (args[0] === "auth" && args[1] === "list") {
      return { status: "ok", stdout: `${OWNER}\n`, stderr: "" };
    }
    if (args[0] === "auth" && args[1] === "print-access-token") {
      return { status: "ok", stdout: `${TOKEN}\n`, stderr: "" };
    }
    if (args[0] === "iam" && args[2] === "keys" && args[3] === "list") {
      if (!created) {
        return { status: "ok", stdout: "", stderr: "" };
      }
      postCreateListCalls += 1;
      if (postCreateListCalls <= harness.hideKeyForCalls) {
        return { status: "ok", stdout: "", stderr: "" };
      }
      const iamAccount = args[7] as string;
      const projectId = iamAccount.split("@")[1]?.replace(".iam.gserviceaccount.com", "") ?? "unknown";
      return { status: "ok", stdout: `${keyResourceName(projectId, iamAccount, FIXED_KEY_ID)}\n`, stderr: "" };
    }
    if (args[0] === "iam" && args[2] === "keys" && args[3] === "create") {
      created = true;
      const iamAccount = args[6] as string;
      const projectId = iamAccount.split("@")[1]?.replace(".iam.gserviceaccount.com", "") ?? "unknown";
      const destination =
        options?.cwd === undefined ? (args[4] as string) : join(options.cwd, args[4] as string);
      writeFileSync(destination, validKeyJson(projectId, iamAccount, FIXED_KEY_ID, privateKey), "utf8");
      return { status: "ok", stdout: "", stderr: "" };
    }
    return { status: "ok", stdout: "", stderr: "" };
  };

  const harness = {
    keyPath,
    outputPath,
    statePath,
    privateKey,
    runnerScript: undefined as ((args: readonly string[], options?: { readonly cwd?: string }) => GcloudRunResult) | undefined,
    tokenInfo: { email: OWNER, scope: DRIVE_SCOPE } as TokenInfo,
    verifyError: undefined as Error | undefined,
    hideKeyForCalls: 0,
    markerFiles: [] as readonly MarkerFileInfo[],
    run(options: Partial<RunSetupOptions> & { readonly progress?: SetupProgressSink } = {}): Promise<SetupResult> {
      const runner: GcloudRunner = {
        async run(args, opts): Promise<GcloudRunResult> {
          return (harness.runnerScript ?? defaultScript)(args, opts);
        },
      };
      const validateToken: TokenValidator = {
        async validate(): Promise<TokenInfo> {
          return harness.tokenInfo;
        },
      };
      const createHumanApi: HumanSheetApiFactory = () => ({
        async createSpreadsheet() {
          return { spreadsheetId: CREATED_SHEET_ID };
        },
        async findSpreadsheetByMarker(): Promise<readonly MarkerFileInfo[]> {
          return harness.markerFiles;
        },
        async ensureSaWriter(): Promise<ShareOutcome> {
          return { writerRole: "created" };
        },
      });
      const verifySaAccess: SaAccessVerifier = {
        async verify(request): Promise<void> {
          if (harness.verifyError !== undefined) {
            throw harness.verifyError;
          }
          // Touch the request so the credentials/onVerifyProgress fields are
          // exercised even on the success path.
          expect(request.credentials.client_email).toBeTruthy();
        },
      };
      return runSetup({
        runner,
        validateToken,
        createHumanApi,
        verifySaAccess,
        projectId: undefined,
        saName: "hikoutei-sa",
        spreadsheetTitle: undefined,
        keyPath,
        outputPath,
        statePath,
        dryRun: false,
        sleeper: { sleep: async () => { /* instant */ } },
        ...options,
      });
    },
  };
  return harness;
}

describe("runSetup progress integration", () => {
  const RESUME_PROJECT = "hikoutei-proj";
  const RESUME_TITLE = `hikoutei-sync-${RESUME_PROJECT}`;
  const RESUME_MARKER = "123e4567-e89b-42d3-a456-426614174000";
  const RESUME_SHEET_ID = "sheet-resumed-1";
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hikoutei-progress-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits the ten phases in order and reaches 100% on a fresh successful run", async () => {
    const harness = createProgressHarness(dir);
    const { sink, events } = capturingSink();
    const result = await harness.run({ progress: sink });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) {
      return;
    }
    const started = events()
      .filter((e) => e.type === "phase_started")
      .map((e) => (e as { readonly phase: string }).phase);
    const completed = events()
      .filter((e) => e.type === "phase_completed")
      .map((e) => (e as { readonly phase: string }).phase);
    expect(started).toStrictEqual([...SETUP_PROGRESS_PHASES]);
    expect(completed).toStrictEqual([...SETUP_PROGRESS_PHASES]);
    const tracker = new SetupProgressTracker();
    for (const event of events()) {
      tracker.apply(event);
    }
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
  });

  it("emits fixed safe operation boundaries around the notable steps", async () => {
    const harness = createProgressHarness(dir);
    const { sink, events } = capturingSink();
    await harness.run({ progress: sink });
    const operations = events()
      .filter((e) => e.type === "operation_started" && !("check" in e))
      .map((e) => (e as { readonly operation: string }).operation);
    expect(operations).toContain("checking gcloud CLI");
    expect(operations).toContain("checking active gcloud account");
    expect(operations).toContain("verifying Drive access");
    expect(operations).toContain("creating project");
    expect(operations).toContain("enabling Sheets and Drive APIs");
    expect(operations).toContain("listing service accounts");
    expect(operations).toContain("creating service account");
    expect(operations).toContain("listing service-account keys");
    expect(operations).toContain("creating spreadsheet");
    expect(operations).toContain("sharing spreadsheet with service account");
    expect(operations).toContain("writing .env");
    expect(operations).toContain("persisting checkpoint");
    // Every started operation is paired with its completion.
    const starts = events().filter((e) => e.type === "operation_started").length;
    const ends = events().filter((e) => e.type === "operation_completed").length;
    expect(starts).toBe(ends);
  });

  it("emits key-settlement checks 1/8..N/8 and exact waits when propagation is delayed", async () => {
    const harness = createProgressHarness(dir);
    // Hide the created key for the first two post-create list calls so the
    // settlement poll retries twice before the key appears.
    harness.hideKeyForCalls = 2;
    const { sink, events } = capturingSink();
    const result = await harness.run({ progress: sink });
    expect(result.status).toBe("ok");
    const checks = events().filter((e) => e.type === "operation_started" && "check" in e);
    const waits = events().filter((e) => e.type === "retry_wait_started");
    // Fresh: immediate post-create check is 1/8, then 2/8 and 3/8.
    expect(checks.map((e) => (e as { readonly check: { readonly attempt: number } }).check.attempt)).toStrictEqual([1, 2, 3]);
    expect(checks.map((e) => (e as { readonly check: { readonly maxAttempts: number } }).check.maxAttempts)).toStrictEqual([8, 8, 8]);
    expect(checks.map((e) => (e as { readonly operation: string }).operation)).toStrictEqual([
      "key settlement check",
      "key settlement check",
      "key settlement check",
    ]);
    expect(waits).toHaveLength(2);
    expect((waits[0] as { readonly attempt: number }).attempt).toBe(1);
    expect((waits[0] as { readonly delayMs: number }).delayMs).toBe(2000);
    expect((waits[1] as { readonly attempt: number }).attempt).toBe(2);
    expect((waits[1] as { readonly delayMs: number }).delayMs).toBe(4000);
  });

  it("represents the final 8/8 exhaustion with the exact 2,4,8,16,30,30,30s schedule", async () => {
    const harness = createProgressHarness(dir);
    // The key never appears in the list: the bounded window exhausts at
    // 8/8. The harness create DOES write a staged key, so the exhausted
    // verdict is key_create_failed (a staged key that never becomes
    // active), never an automatic retry of the create.
    harness.hideKeyForCalls = 99;
    const { sink, events } = capturingSink();
    const result = await harness.run({ progress: sink });
    expect(result.status).toBe("error");
    if (result.status !== "error") {
      return;
    }
    expect(result.code).toBe(SETUP_ERROR_CODES.KEY_CREATE_FAILED);
    const checks = events().filter((e) => e.type === "operation_started" && "check" in e);
    expect(checks).toHaveLength(8);
    expect((checks[7] as { readonly check: { readonly attempt: number } }).check.attempt).toBe(8);
    const waits = events().filter((e) => e.type === "retry_wait_started");
    expect(waits.map((e) => (e as { readonly delayMs: number }).delayMs)).toStrictEqual([...KEY_SETTLE_POLL_DELAYS_MS]);
  });

  it("emits resumed + checkpoint-complete phases and skips re-running them", async () => {
    // First run: complete.
    const harness = createProgressHarness(dir);
    await harness.run();
    const { sink, events } = capturingSink();
    // Second run over the complete checkpoint: project/apis/sa/key/
    // spreadsheet/share/sa_access are checkpoint-complete; only cloud_auth,
    // drive_access, spreadsheet (reused), and output re-run.
    const result = await harness.run({ progress: sink });
    expect(result.status).toBe("ok");
    const resumed = events().find((e) => e.type === "resumed");
    expect(resumed).toBeTruthy();
    const completedFromCheckpoint = (resumed as { readonly completedFromCheckpoint: readonly string[] }).completedFromCheckpoint;
    expect(completedFromCheckpoint).toContain("project");
    expect(completedFromCheckpoint).toContain("share");
    expect(completedFromCheckpoint).toContain("sa_access");
    // The output phase is never checkpoint-complete (the .env write re-runs).
    expect(completedFromCheckpoint).not.toContain("output");
    // cloud_auth and drive_access are never checkpoint-complete.
    expect(completedFromCheckpoint).not.toContain("cloud_auth");
    expect(completedFromCheckpoint).not.toContain("drive_access");
    // The key phase is checkpoint-complete on this resume: the flow must
    // never re-emit its start/completion (the tracker would reject it and
    // the count must not double-count checkpoint-completed phases).
    expect(
      events().filter((e) => e.type === "phase_started" && e.phase === "service_account_key"),
    ).toHaveLength(0);
    expect(
      events().filter((e) => e.type === "phase_completed" && e.phase === "service_account_key"),
    ).toHaveLength(0);
    // The rerun still reaches exactly ten completed phases (the resumed
    // spreadsheet phase never completes twice).
    const tracker = new SetupProgressTracker();
    for (const event of events()) {
      tracker.apply(event);
    }
    expect(tracker.completedCount).toBe(10);
    expect(overallPercent(tracker.completedCount)).toBe(100);
  });

  /** Writes a valid key file matching the resume fixture project/SA. */
  function writeResumeKey(harness: { readonly keyPath: string; readonly privateKey: string }, projectId: string): void {
    writeFileSync(
      harness.keyPath,
      validKeyJson(projectId, `hikoutei-sa@${projectId}.iam.gserviceaccount.com`, FIXED_KEY_ID, harness.privateKey),
      "utf8",
    );
  }

  /** Builds a valid checkpoint payload for a spreadsheet-bearing status. */
  function spreadsheetCheckpoint(
    harness: { readonly keyPath: string },
    status:
      | "spreadsheet_create_started"
      | "spreadsheet_created"
      | "spreadsheet_share_started"
      | "spreadsheet_shared"
      | "complete",
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      version: SETUP_STATE_VERSION,
      status,
      projectId: RESUME_PROJECT,
      projectMode: "generated",
      ownerEmail: OWNER,
      saName: "hikoutei-sa",
      saEmail: `hikoutei-sa@${RESUME_PROJECT}.iam.gserviceaccount.com`,
      keyPath: harness.keyPath,
      spreadsheetTitle: RESUME_TITLE,
      ...overrides,
    };
  }

  /** Feeds every event through a fresh tracker; every event must be accepted. */
  function acceptedTracker(events: readonly SetupProgressEvent[]): SetupProgressTracker {
    const tracker = new SetupProgressTracker();
    for (const event of events) {
      expect(tracker.apply(event)).toBe(true);
    }
    return tracker;
  }

  it("reports the spreadsheet phase once on a spreadsheet_create_started resume (reconcile runs as the current phase)", async () => {
    const harness = createProgressHarness(dir);
    writeResumeKey(harness, RESUME_PROJECT);
    writeFileSync(
      harness.statePath,
      JSON.stringify(
        spreadsheetCheckpoint(harness, "spreadsheet_create_started", {
          creationMarker: RESUME_MARKER,
          keyOrigin: "created",
        }),
      ),
      "utf8",
    );
    // The lost-create outcome is recovered by marker: exactly one match
    // carrying the persisted marker, name, and mime type.
    harness.markerFiles = [
      {
        spreadsheetId: RESUME_SHEET_ID,
        name: RESUME_TITLE,
        mimeType: SPREADSHEET_MIME_TYPE,
        appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: RESUME_MARKER },
      },
    ];
    const { sink, events } = capturingSink();
    const result = await harness.run({ progress: sink });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) {
      return;
    }
    expect(result.summary.resumed).toBe(true);
    expect(result.summary.spreadsheetId).toBe(RESUME_SHEET_ID);
    // `spreadsheet_create_started` is a recovery/current phase: the phase
    // still starts and completes exactly once as a run phase.
    expect(events().filter((e) => e.type === "phase_started" && e.phase === "spreadsheet")).toHaveLength(1);
    expect(
      events().filter((e) => e.type === "phase_completed" && e.phase === "spreadsheet" && e.source === "run"),
    ).toHaveLength(1);
    // The reconcile is the only spreadsheet work on this resume; the fresh
    // create never runs.
    const spreadsheetOps = events().filter(
      (e) => e.type === "operation_started" && e.phase === "spreadsheet" && !("check" in e),
    );
    expect(spreadsheetOps.map((e) => (e as { readonly operation: string }).operation)).toStrictEqual([
      SETUP_PROGRESS_OPERATIONS.SHEET_RECONCILE,
    ]);
    expect(
      events().filter(
        (e) => e.type === "operation_started" && "operation" in e && e.operation === SETUP_PROGRESS_OPERATIONS.SHEET_CREATE,
      ),
    ).toHaveLength(0);
    // Every event is accepted by the validating tracker (no duplicate or
    // out-of-order phase events) and the run reaches ten completed phases.
    const tracker = acceptedTracker(events());
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
  });

  it("never re-reports the spreadsheet phase on a spreadsheet_created resume (checkpoint-guaranteed)", async () => {
    const harness = createProgressHarness(dir);
    writeResumeKey(harness, RESUME_PROJECT);
    writeFileSync(
      harness.statePath,
      JSON.stringify(
        spreadsheetCheckpoint(harness, "spreadsheet_created", {
          spreadsheetId: RESUME_SHEET_ID,
          keyOrigin: "created",
        }),
      ),
      "utf8",
    );
    const { sink, events } = capturingSink();
    const result = await harness.run({ progress: sink });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) {
      return;
    }
    expect(result.summary.resumed).toBe(true);
    expect(result.summary.spreadsheetId).toBe(RESUME_SHEET_ID);
    // The `resumed` event already marked spreadsheet checkpoint-complete:
    // no phase start/completion and no create/reconcile operation may be
    // emitted (the tracker would reject them).
    expect(events().filter((e) => e.type === "phase_started" && e.phase === "spreadsheet")).toHaveLength(0);
    expect(events().filter((e) => e.type === "phase_completed" && e.phase === "spreadsheet")).toHaveLength(0);
    expect(
      events().filter(
        (e) => (e.type === "operation_started" || e.type === "operation_completed") && e.phase === "spreadsheet",
      ),
    ).toHaveLength(0);
    // The resumed list carries the spreadsheet phase, and the run still
    // re-runs the share phase (not checkpoint-guaranteed yet).
    const resumed = events().find((e) => e.type === "resumed");
    expect(
      (resumed as { readonly completedFromCheckpoint: readonly string[] }).completedFromCheckpoint,
    ).toContain("spreadsheet");
    expect(events().filter((e) => e.type === "phase_started" && e.phase === "share")).toHaveLength(1);
    // Every event is accepted (no duplicates were emitted) and all ten
    // phases complete exactly once.
    const tracker = acceptedTracker(events());
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
    expect(tracker.isComplete("spreadsheet")).toBe(true);
  });

  it("never re-reports the spreadsheet phase on a spreadsheet_share_started resume (share still runs)", async () => {
    const harness = createProgressHarness(dir);
    writeResumeKey(harness, RESUME_PROJECT);
    writeFileSync(
      harness.statePath,
      JSON.stringify(
        spreadsheetCheckpoint(harness, "spreadsheet_share_started", {
          spreadsheetId: RESUME_SHEET_ID,
          keyOrigin: "created",
        }),
      ),
      "utf8",
    );
    const { sink, events } = capturingSink();
    const result = await harness.run({ progress: sink });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) {
      return;
    }
    expect(result.summary.resumed).toBe(true);
    // The spreadsheet phase is checkpoint-complete: no start/completion
    // and no spreadsheet operation events on this resume.
    expect(events().filter((e) => e.type === "phase_started" && e.phase === "spreadsheet")).toHaveLength(0);
    expect(events().filter((e) => e.type === "phase_completed" && e.phase === "spreadsheet")).toHaveLength(0);
    expect(
      events().filter(
        (e) => (e.type === "operation_started" || e.type === "operation_completed") && e.phase === "spreadsheet",
      ),
    ).toHaveLength(0);
    // The share step is NOT checkpoint-guaranteed by this write-ahead
    // status: the phase still starts and completes as a run phase.
    expect(events().filter((e) => e.type === "phase_started" && e.phase === "share")).toHaveLength(1);
    expect(
      events().filter(
        (e) => e.type === "operation_started" && "operation" in e && e.operation === SETUP_PROGRESS_OPERATIONS.SHARE,
      ),
    ).toHaveLength(1);
    const tracker = acceptedTracker(events());
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
  });

  it("never re-reports spreadsheet or share on a spreadsheet_shared resume (both checkpoint-guaranteed)", async () => {
    const harness = createProgressHarness(dir);
    writeResumeKey(harness, RESUME_PROJECT);
    writeFileSync(
      harness.statePath,
      JSON.stringify(
        spreadsheetCheckpoint(harness, "spreadsheet_shared", {
          spreadsheetId: RESUME_SHEET_ID,
          keyOrigin: "created",
          shareOrigin: "fresh",
        }),
      ),
      "utf8",
    );
    const { sink, events } = capturingSink();
    const result = await harness.run({ progress: sink });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) {
      return;
    }
    expect(result.summary.resumed).toBe(true);
    // No spreadsheet or share phase events and no share operation: the
    // idempotent ensure must not re-run for a shared checkpoint.
    expect(
      events().filter((e) => e.type === "phase_started" && (e.phase === "spreadsheet" || e.phase === "share")),
    ).toHaveLength(0);
    expect(
      events().filter((e) => e.type === "phase_completed" && (e.phase === "spreadsheet" || e.phase === "share")),
    ).toHaveLength(0);
    expect(
      events().filter(
        (e) =>
          (e.type === "operation_started" || e.type === "operation_completed") &&
          (e.phase === "spreadsheet" || e.phase === "share"),
      ),
    ).toHaveLength(0);
    // The share provenance comes from the checkpoint, never from a re-run
    // of the ensure: the current-run role stays "unchanged".
    expect(result.summary.saWriterRole).toBe("unchanged");
    const tracker = acceptedTracker(events());
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
    expect(tracker.isComplete("spreadsheet")).toBe(true);
    expect(tracker.isComplete("share")).toBe(true);
  });

  it("never re-reports spreadsheet, share, or sa_access on a complete resume", async () => {
    const harness = createProgressHarness(dir);
    writeResumeKey(harness, RESUME_PROJECT);
    writeFileSync(
      harness.statePath,
      JSON.stringify(
        spreadsheetCheckpoint(harness, "complete", {
          spreadsheetId: RESUME_SHEET_ID,
          keyOrigin: "created",
          shareOrigin: "fresh",
        }),
      ),
      "utf8",
    );
    const { sink, events } = capturingSink();
    const result = await harness.run({ progress: sink });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) {
      return;
    }
    expect(result.summary.resumed).toBe(true);
    // Spreadsheet/share/sa_access are checkpoint-complete: only the fresh
    // auth/drive phases and the output phase (the .env write always
    // re-runs) report on this resume.
    const startedPhases = events()
      .filter((e) => e.type === "phase_started")
      .map((e) => (e as { readonly phase: string }).phase);
    expect(startedPhases).toStrictEqual(["cloud_auth", "drive_access", "output"]);
    const tracker = acceptedTracker(events());
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
    expect(tracker.isComplete("spreadsheet")).toBe(true);
    expect(tracker.isComplete("share")).toBe(true);
    expect(tracker.isComplete("sa_access")).toBe(true);
  });

  it("emits no progress events in dry-run mode", async () => {
    const harness = createProgressHarness(dir);
    const { sink, events } = capturingSink();
    const result = await harness.run({ progress: sink, dryRun: true });
    expect(result.status).toBe("ok");
    if (result.status === "ok" && result.dryRun) {
      expect(result.commands.length).toBeGreaterThan(0);
    }
    expect(events()).toHaveLength(0);
  });

  it("a throwing progress callback never changes the setup result", async () => {
    const harness = createProgressHarness(dir);
    const bomb: SetupProgressSink = { report: () => { throw new Error("renderer exploded"); } };
    const result = await harness.run({ progress: bomb });
    expect(result.status).toBe("ok");
  });

  it("never places secrets, paths, emails, or ids in progress events", async () => {
    const harness = createProgressHarness(dir);
    const { sink, events } = capturingSink();
    await harness.run({ progress: sink });
    const serialized = JSON.stringify(events());
    for (const secret of [TOKEN, OWNER, FIXED_KEY_ID, CREATED_SHEET_ID, harness.keyPath, "private_key", "BEGIN PRIVATE KEY"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reports the key phase when a fresh run reuses an existing key", async () => {
    const harness = createProgressHarness(dir);
    // A pre-existing validated key (no checkpoint) plus a matching
    // --project: the run reuses the key (no settle/create work), but the
    // key phase must still start and complete so the validating tracker
    // keeps the later phases visible instead of dropping them.
    writeFileSync(
      harness.keyPath,
      validKeyJson(
        "hikoutei-existing",
        "hikoutei-sa@hikoutei-existing.iam.gserviceaccount.com",
        FIXED_KEY_ID,
        harness.privateKey,
      ),
      "utf8",
    );
    const { sink, events } = capturingSink();
    const result = await harness.run({ projectId: "hikoutei-existing", progress: sink });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) {
      return;
    }
    expect(result.summary.keyReused).toBe(true);
    // Every phase started exactly once, in order, and all ten completed:
    // the tracker accepted the full sequence (spreadsheet and later phases
    // stayed visible).
    const startedPhases = events()
      .filter((e) => e.type === "phase_started")
      .map((e) => (e as { readonly phase: string }).phase);
    expect(startedPhases).toStrictEqual([...SETUP_PROGRESS_PHASES]);
    const tracker = new SetupProgressTracker();
    for (const event of events()) {
      tracker.apply(event);
    }
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
    // No key-settlement/create work ran: the key was reused, not created.
    const keyWork = events().filter(
      (e) => e.type === "operation_started" && e.phase === "service_account_key",
    );
    expect(keyWork).toHaveLength(0);
  });

  it("reports the key phase when a project_selected resume reuses the key", async () => {
    const harness = createProgressHarness(dir);
    // A crashed run left a project_selected checkpoint and the key file;
    // resuming with the matching --project reuses the key, and the key
    // phase must still start and complete (the checkpoint guarantees no
    // phase).
    writeFileSync(
      harness.keyPath,
      validKeyJson(
        "hikoutei-existing",
        "hikoutei-sa@hikoutei-existing.iam.gserviceaccount.com",
        FIXED_KEY_ID,
        harness.privateKey,
      ),
      "utf8",
    );
    writeFileSync(
      harness.statePath,
      JSON.stringify({
        version: SETUP_STATE_VERSION,
        status: "project_selected",
        projectId: "hikoutei-existing",
        projectMode: "explicit",
        ownerEmail: OWNER,
        saName: "hikoutei-sa",
        saEmail: "hikoutei-sa@hikoutei-existing.iam.gserviceaccount.com",
        keyPath: harness.keyPath,
        spreadsheetTitle: "hikoutei-sync-hikoutei-existing",
      }),
      "utf8",
    );
    const { sink, events } = capturingSink();
    const result = await harness.run({ projectId: "hikoutei-existing", progress: sink });
    expect(result.status).toBe("ok");
    if (result.status !== "ok" || result.dryRun) {
      return;
    }
    // The resumed event guarantees nothing for a project_selected state.
    const resumed = events().find((e) => e.type === "resumed");
    expect((resumed as { readonly completedFromCheckpoint: readonly unknown[] }).completedFromCheckpoint).toStrictEqual([]);
    const startedPhases = events()
      .filter((e) => e.type === "phase_started")
      .map((e) => (e as { readonly phase: string }).phase);
    expect(startedPhases).toStrictEqual([...SETUP_PROGRESS_PHASES]);
    const tracker = new SetupProgressTracker();
    for (const event of events()) {
      tracker.apply(event);
    }
    expect(tracker.completedCount).toBe(SETUP_PROGRESS_PHASE_COUNT);
  });
});

describe("runSetupCli login handoff with the progress renderer", () => {
  /** Fake stdin whose single shared iterator lets consecutive prompts
   * (confirmSetup, then promptLoginHandoff) draw chunks in order. */
  function makeStdin(chunks: readonly string[], isTTY: boolean): RunSetupCliContext["stdin"] {
    let index = 0;
    const iterator: AsyncIterator<string> = {
      next(): Promise<IteratorResult<string>> {
        if (index < chunks.length) {
          const value = chunks[index] as string;
          index += 1;
          return Promise.resolve({ value, done: false });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    return { [Symbol.asyncIterator]: () => iterator, isTTY };
  }

  function capturingStdout(isTTY: boolean): { stdout: RunSetupCliContext["stdout"]; text: () => string } {
    let text = "";
    const stdout: RunSetupCliContext["stdout"] = { write: (chunk: string) => { text += chunk; }, isTTY };
    return { stdout, text: () => text };
  }

  function okResult(): SetupResult {
    return {
      status: "ok",
      dryRun: false,
      summary: {
        projectId: "hikoutei-test-project",
        ownerEmail: OWNER,
        serviceAccountEmail: "hikoutei-sa@hikoutei-test-project.iam.gserviceaccount.com",
        keyPath: "/tmp/hikoutei-service-account.json",
        spreadsheetId: "sheet-1",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
        spreadsheetTitle: "hikoutei-sync-hikoutei-test-project",
        outputPath: "/tmp/.env",
        statePath: "/tmp/.hikoutei-setup-state.json",
        stateStatus: "complete",
        envFileCreated: true,
        envFileModified: false,
        projectReused: false,
        serviceAccountReused: false,
        keyReused: false,
        saWriterRole: "created",
        resumed: false,
      },
      commands: [],
    };
  }

  it("suspends the renderer before the inherited login and re-renders the retry to 100%", async () => {
    let calls = 0;
    const runSetup: RunSetupCliContext["runSetup"] = async (): Promise<SetupResult> => {
      calls += 1;
      if (calls === 1) {
        // First attempt dies in the drive_access phase (auth preflight).
        return {
          status: "error",
          code: SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED,
          message: "drive scope missing",
        };
      }
      return okResult();
    };
    const loginRunner: RunSetupCliContext["loginRunner"] = {
      async runInteractiveLogin() {
        return { status: "ok" };
      },
    };
    let loginCalls = 0;
    const trackedLogin: RunSetupCliContext["loginRunner"] = {
      async runInteractiveLogin() {
        loginCalls += 1;
        return loginRunner.runInteractiveLogin();
      },
    };
    // A real renderer with an injectable clock/scheduler, writing to the
    // captured stderr that runSetupCli also writes errors to.
    const { output, text: stderrText } = capturingOutput();
    const handles: Array<{ cancelled: boolean }> = [];
    const renderer = createSetupProgressRenderer({
      output,
      isTty: true,
      // Forced: the interactive assertions must not depend on ambient
      // NO_COLOR/CI environment.
      interactive: true,
      now: () => 0,
      setInterval: (fn, ms) => {
        const handle = { fn, ms, cancelled: false };
        handles.push(handle);
        return handle as unknown as NodeJS.Timeout;
      },
      clearInterval: (handle) => {
        const entry = handles.find((h) => (h as unknown) === handle);
        if (entry !== undefined) {
          entry.cancelled = true;
        }
      },
    });
    const { stdout, text: stdoutText } = capturingStdout(true);
    const context: RunSetupCliContext = {
      options: { saName: "hikoutei-sa", output: ".env", yes: false, dryRun: false },
      cwd: "/tmp",
      runSetup: (params) => {
        // The retry re-runs the same controller: re-emit the full phase
        // sequence on the second attempt so the block redraws and finishes.
        // (`calls` is still 1 when the retry invocation arrives.)
        if (calls === 1) {
          for (const phase of SETUP_PROGRESS_PHASES) {
            renderer.report(started(phase));
            renderer.report(completed(phase));
          }
        }
        return runSetup(params);
      },
      loginRunner: trackedLogin,
      stdin: makeStdin(["y\n", "\n"], true),
      stdout,
      stderr: output,
      progress: renderer,
    };
    const exitCode = await runSetupCli(context);
    expect(exitCode).toBe(0);
    expect(calls).toBe(2);
    expect(loginCalls).toBe(1);
    // The success summary still lands on stdout.
    expect(stdoutText()).toContain("Hikoutei setup complete.");
    // No animation timer is left behind after suspend + finish.
    expect(handles.every((h) => h.cancelled)).toBe(true);
    // The retry re-rendered the block (after suspend erased it) and the
    // final finish() drew the 100% state before the stdout summary.
    expect(stderrText()).toContain("100% 10/10");
    expect(stderrText()).toContain("Done");
    expect(stderrText()).toContain("✓ Output");
  });

  it("renders the failed phase with its stable code on a final error", async () => {
    const { output, text: stderrText } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: true, interactive: true, now: () => 0 });
    const context: RunSetupCliContext = {
      options: { saName: "hikoutei-sa", output: ".env", yes: true, dryRun: false },
      cwd: "/tmp",
      runSetup: async () => {
        for (const event of prefixEvents("project")) {
          renderer.report(event);
        }
        renderer.report(started("project"));
        return {
          status: "error",
          code: SETUP_ERROR_CODES.PROJECT_CREATE_FAILED,
          message: "could not create the project",
        };
      },
      loginRunner: {
        async runInteractiveLogin() {
          throw new Error("login must not run");
        },
      },
      stdin: makeStdin([], false),
      stdout: capturingStdout(false).stdout,
      stderr: output,
      progress: renderer,
    };
    const exitCode = await runSetupCli(context);
    expect(exitCode).toBe(1);
    expect(stderrText()).toContain("failed: project_create_failed");
    expect(stderrText()).toContain("✗ Project");
  });

  it("renders the suspended phase failure when the login handoff is cancelled", async () => {
    const { output, text: stderrText } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: true, interactive: true, now: () => 0 });
    const context: RunSetupCliContext = {
      options: { saName: "hikoutei-sa", output: ".env", yes: false, dryRun: false },
      cwd: "/tmp",
      runSetup: async () => {
        for (const event of prefixEvents("drive_access")) {
          renderer.report(event);
        }
        renderer.report(started("drive_access"));
        return {
          status: "error",
          code: SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED,
          message: "drive scope missing",
        };
      },
      loginRunner: {
        async runInteractiveLogin() {
          throw new Error("login must not run after a cancelled handoff");
        },
      },
      stdin: makeStdin(["y\n", "n\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: output,
      progress: renderer,
    };
    const exitCode = await runSetupCli(context);
    expect(exitCode).toBe(1);
    // suspend() cleared the current phase, but the final failure frame
    // still names the phase the run died in.
    expect(stderrText()).toContain("failed: gcloud_drive_access_required");
    expect(stderrText()).toContain("✗ Drive access");
  });

  it("renders the suspended phase failure when the inherited login fails", async () => {
    const { output, text: stderrText } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: true, interactive: true, now: () => 0 });
    const context: RunSetupCliContext = {
      options: { saName: "hikoutei-sa", output: ".env", yes: false, dryRun: false },
      cwd: "/tmp",
      runSetup: async () => {
        for (const event of prefixEvents("drive_access")) {
          renderer.report(event);
        }
        renderer.report(started("drive_access"));
        return {
          status: "error",
          code: SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN,
          message: "no active account",
        };
      },
      loginRunner: {
        async runInteractiveLogin() {
          return { status: "failed", code: 1 };
        },
      },
      stdin: makeStdin(["y\n", "\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: output,
      progress: renderer,
    };
    const exitCode = await runSetupCli(context);
    expect(exitCode).toBe(1);
    // The login failure is reported with its own code, and the failure
    // frame still names the suspended phase.
    expect(stderrText()).toContain("failed: gcloud_login_failed");
    expect(stderrText()).toContain("✗ Drive access");
  });

  it("labels a retry failure against the retry's own state, never the stale suspended phase", async () => {
    let calls = 0;
    const { output, text: stderrText } = capturingOutput();
    const renderer = createSetupProgressRenderer({ output, isTty: true, interactive: true, now: () => 0 });
    const runSetup: RunSetupCliContext["runSetup"] = async () => {
      calls += 1;
      if (calls === 1) {
        // First attempt completes cloud_auth and dies during drive_access
        // (an auth preflight failure the login handoff can rescue).
        for (const event of prefixEvents("drive_access")) {
          renderer.report(event);
        }
        renderer.report(started("drive_access"));
        return {
          status: "error",
          code: SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED,
          message: "drive scope missing",
        };
      }
      // Retry after the successful login: re-runs the fresh drive_access
      // phase, completes it, then dies before any new phase is accepted
      // (lock contention between attempts — the preflight already ran).
      renderer.report(started("drive_access"));
      renderer.report(completed("drive_access"));
      return {
        status: "error",
        code: SETUP_ERROR_CODES.SETUP_IN_PROGRESS,
        message: "another setup run is in progress",
      };
    };
    const context: RunSetupCliContext = {
      options: { saName: "hikoutei-sa", output: ".env", yes: false, dryRun: false },
      cwd: "/tmp",
      runSetup,
      loginRunner: {
        async runInteractiveLogin() {
          return { status: "ok" };
        },
      },
      stdin: makeStdin(["y\n", "\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: output,
      progress: renderer,
    };
    const exitCode = await runSetupCli(context);
    expect(exitCode).toBe(1);
    expect(calls).toBe(2);
    // resume() cleared the suspended pre-login phase: the failure frame
    // names the retry's next pending phase (Project), never the stale
    // Drive access phase the first attempt died in.
    expect(stderrText()).toContain("failed: setup_in_progress");
    expect(stderrText()).toContain("✗ Project");
    expect(stderrText()).not.toContain("✗ Drive access");
  });
});
