/**
 * Step-by-step progress reporting for `hikoutei setup`.
 *
 * The setup flow creates several remote Google Cloud resources and waits on
 * asynchronous IAM/ACL propagation, so a run can take minutes with no stdout
 * activity. This module renders that progress to stderr as two bars:
 *
 * - an OVERALL bar that advances one segment per completed setup phase
 *   (never a guessed percentage or an ETA — only finished work moves it);
 *   and
 * - a DETAIL bar for the bounded retry polls inside the key-settlement and
 *   service-account access-verification phases (how many of the eight
 *   propagation checks have run, and during a known wait how far through
 *   that wait the clock is) plus a fixed `working…` label for
 *   unknown-duration steps.
 *
 * The flow reports progress through a discriminated
 * {@link SetupProgressEvent} union: `resumed` (once, with the phases a
 * checkpoint guarantees), `phase_started` / `phase_completed` at phase
 * boundaries, `operation_started` / `operation_completed` around the
 * notable remote/local steps (fixed safe labels; the bounded propagation
 * checks additionally carry 1-based attempt info), `retry_wait_started`
 * before each bounded sleep, and `phase_failed` (a stable
 * {@link SetupErrorCode} only) emitted by the CLI controller when a run
 * ends in error — the flow itself returns a stable error result and never
 * knows it is the final attempt (the interactive login retry can still
 * rescue an auth preflight failure).
 *
 * Two renderers share one validating state machine:
 * - an interactive (TTY, color-capable) renderer that redraws a fixed
 *   four-line block in place with ANSI and animates a known wait through
 *   an `unref`-ed interval timer; and
 * - an append-only renderer for CI / non-TTY / `NO_COLOR` that prints a
 *   static line per phase start / phase completion / bounded-check attempt
 *   / retry wait / failure and NEVER uses control sequences, a clock tick,
 *   or a line for ordinary operation events (no log spam). The final
 *   bounded attempt (8/8) has no following wait line, so it must print its
 *   own attempt line or it would be invisible before success/failure.
 *
 * Security contract: progress events and rendered text carry ONLY fixed
 * labels, attempt/delay numbers, and stable error codes. Project ids,
 * service-account emails, owner emails, paths, access tokens, private keys,
 * key ids, raw gcloud output, and raw provider payloads are NEVER placed in
 * an event or written by a renderer. A throwing renderer callback is
 * swallowed by {@link safeProgressSink}, and the controller swallows its
 * own write/scheduler failures, so progress can never change the setup
 * result, the mutation order, or the process exit code. This module is
 * internal CLI machinery only; it is not part of the application-facing
 * API.
 */

import { SETUP_ERROR_CODES, type SetupErrorCode } from "./errors.js";

/** The ten setup phases in execution order. */
export const SETUP_PROGRESS_PHASES = [
  "cloud_auth",
  "drive_access",
  "project",
  "apis",
  "service_account",
  "service_account_key",
  "spreadsheet",
  "share",
  "sa_access",
  "output",
] as const;

/** One setup phase. */
export type SetupProgressPhase = (typeof SETUP_PROGRESS_PHASES)[number];

/** Total number of setup phases (drives the overall bar denominator). */
export const SETUP_PROGRESS_PHASE_COUNT = SETUP_PROGRESS_PHASES.length;

/**
 * The phases a checkpoint can ever guarantee as already complete, in order.
 *
 * A valid `resumed` event lists a PREFIX of this sequence: cloud_auth and
 * drive_access are never checkpoint-complete (every run re-runs them
 * fresh) and the output phase is never checkpoint-complete (the `.env`
 * write runs on every successful run). The tracker rejects any other
 * shape (gaps, duplicates, out-of-order entries, unknown phases) as an
 * invalid checkpoint phase list.
 */
const RESUMABLE_CHECKPOINT_PHASES = [
  "project",
  "apis",
  "service_account",
  "service_account_key",
  "spreadsheet",
  "share",
  "sa_access",
] as const satisfies readonly SetupProgressPhase[];

/** Fixed, safe human labels for each phase (never secrets). */
export const SETUP_PROGRESS_LABELS: Readonly<Record<SetupProgressPhase, string>> = {
  cloud_auth: "Google Cloud authentication",
  drive_access: "Drive access",
  project: "Project",
  apis: "Sheets and Drive APIs",
  service_account: "Service account",
  service_account_key: "Service-account key",
  spreadsheet: "Spreadsheet",
  share: "Share and ownership",
  sa_access: "Service-account access",
  output: "Checkpoint and .env",
};

/** Short labels for the compact "done" line. */
export const SETUP_PROGRESS_SHORT_LABELS: Readonly<Record<SetupProgressPhase, string>> = {
  cloud_auth: "Cloud auth",
  drive_access: "Drive access",
  project: "Project",
  apis: "APIs",
  service_account: "Service account",
  service_account_key: "Key",
  spreadsheet: "Spreadsheet",
  share: "Share",
  sa_access: "SA access",
  output: "Output",
};

/** The bounded retry polls that carry a nested detail bar. */
export type SetupRetryKind = "key_settlement" | "sa_access";

/** The retry kind a phase can host, if any. */
const RETRY_KIND_OF_PHASE: Readonly<Partial<Record<SetupProgressPhase, SetupRetryKind>>> = {
  service_account_key: "key_settlement",
  sa_access: "sa_access",
};

/** Human word for each retry kind, used in "before next <word> check". */
const RETRY_KIND_WORD: Readonly<Record<SetupRetryKind, string>> = {
  key_settlement: "key",
  sa_access: "access",
};

/** Human noun for each retry kind shown between checks. */
const RETRY_CHECK_NOUN: Readonly<Record<SetupRetryKind, string>> = {
  key_settlement: "key settlement check",
  sa_access: "access check",
};

/**
 * Fixed, safe operation labels for the notable setup steps.
 *
 * The flow emits `operation_started` / `operation_completed` around the
 * unknown-duration calls (gcloud spawns, API calls) so the detail bar can
 * show a fixed `working… <label>` instead of a guessed percentage. Labels
 * are constant text and never carry identifiers, paths, or secrets.
 */
export const SETUP_PROGRESS_OPERATIONS = {
  GCLOUD_PRESENCE: "checking gcloud CLI",
  ACTIVE_ACCOUNT: "checking active gcloud account",
  DRIVE_SCOPE: "verifying Drive access",
  PROJECT_VERIFY: "verifying project",
  PROJECT_CREATE: "creating project",
  PROJECT_SELECT: "selecting default project",
  API_ENABLE: "enabling Sheets and Drive APIs",
  SA_LIST: "listing service accounts",
  SA_CREATE: "creating service account",
  KEY_LIST: "listing service-account keys",
  SHEET_CREATE: "creating spreadsheet",
  SHEET_RECONCILE: "reconciling spreadsheet",
  SHARE: "sharing spreadsheet with service account",
  ENV_WRITE: "writing .env",
  CHECKPOINT_PERSIST: "persisting checkpoint",
} as const;

/** One generic operation label. */
export type SetupProgressOperation = (typeof SETUP_PROGRESS_OPERATIONS)[keyof typeof SETUP_PROGRESS_OPERATIONS];

/**
 * Fixed, safe operation labels for the bounded propagation checks.
 *
 * Operation events carrying these labels also carry a
 * {@link BoundedCheckInfo} with the 1-based attempt within the bounded
 * window, so the tracker can keep the detail bar on the propagation check
 * while it runs.
 */
export const SETUP_PROGRESS_BOUNDED_OPERATIONS = {
  KEY_SETTLE: "key settlement check",
  SA_ACCESS: "access check",
} as const;

/** One bounded-check operation label. */
export type SetupBoundedOperation = (typeof SETUP_PROGRESS_BOUNDED_OPERATIONS)[keyof typeof SETUP_PROGRESS_BOUNDED_OPERATIONS];

/** The bounded-check operation label a phase hosts, if any. */
function boundedOperationOf(phase: SetupProgressPhase): SetupBoundedOperation | undefined {
  if (RETRY_KIND_OF_PHASE[phase] === "key_settlement") {
    return SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE;
  }
  if (RETRY_KIND_OF_PHASE[phase] === "sa_access") {
    return SETUP_PROGRESS_BOUNDED_OPERATIONS.SA_ACCESS;
  }
  return undefined;
}

/** 1-based attempt info of one propagation check within its bounded window. */
export interface BoundedCheckInfo {
  /** 1-based index of the check/attempt that is running (1..maxAttempts). */
  readonly attempt: number;
  /** Total checks/attempts in the bounded window (8 for both polls). */
  readonly maxAttempts: number;
}

/** How a completed phase finished. */
export type SetupProgressSource = "run" | "checkpoint";

/**
 * Discriminated progress event emitted by the setup flow and the CLI
 * controller.
 *
 * The flow emits `resumed` (once, with the phases a checkpoint
 * guarantees), `phase_started` / `phase_completed` at phase boundaries,
 * `operation_started` / `operation_completed` around notable steps
 * (bounded propagation checks carry {@link BoundedCheckInfo}), and
 * `retry_wait_started` before each bounded retry sleep. `phase_failed` is
 * emitted by the CLI controller when a run ends in error (the flow itself
 * returns a stable error result and never knows it is the final attempt —
 * the interactive login retry can still rescue an auth preflight failure).
 */
export type SetupProgressEvent =
  | { readonly type: "resumed"; readonly completedFromCheckpoint: readonly SetupProgressPhase[] }
  | { readonly type: "phase_started"; readonly phase: SetupProgressPhase }
  | { readonly type: "phase_completed"; readonly phase: SetupProgressPhase; readonly source: SetupProgressSource }
  | { readonly type: "operation_started" | "operation_completed"; readonly phase: SetupProgressPhase; readonly operation: SetupProgressOperation }
  | { readonly type: "operation_started" | "operation_completed"; readonly phase: SetupProgressPhase; readonly operation: SetupBoundedOperation; readonly check: BoundedCheckInfo }
  | {
    readonly type: "retry_wait_started";
    readonly phase: SetupProgressPhase;
    readonly kind: SetupRetryKind;
    /** 1-based index of the propagation check that just ran. */
    readonly attempt: number;
    readonly maxAttempts: number;
    /** Milliseconds the flow will sleep before the next check. */
    readonly delayMs: number;
  }
  | { readonly type: "phase_failed"; readonly phase: SetupProgressPhase; readonly code: SetupErrorCode };

/** Sink that receives every progress event. */
export interface SetupProgressSink {
  report(event: SetupProgressEvent): void;
}

/** A sink that drops every event; used when progress is disabled. */
export const NOOP_PROGRESS_SINK: SetupProgressSink = {
  report(): void {
    /* progress disabled */
  },
};

/**
 * Wraps a sink so a throwing callback (or an absent sink) can never affect
 * the setup run. Returns {@link NOOP_PROGRESS_SINK} for `undefined` so flow
 * call sites can call `progress.report(...)` unconditionally.
 */
export function safeProgressSink(sink: SetupProgressSink | undefined): SetupProgressSink {
  if (sink === undefined) {
    return NOOP_PROGRESS_SINK;
  }
  return {
    report(event: SetupProgressEvent): void {
      try {
        sink.report(event);
      } catch {
        // Progress rendering must never change the setup result, the
        // mutation order, or the exit code.
      }
    },
  };
}

/** Output sink the renderers write to (stderr in production). */
export interface ProgressOutput {
  readonly write: (text: string) => void;
}

/** Width (in cells) of both progress bars. */
const PROGRESS_BAR_WIDTH = 20;

/**
 * Renders a `[████…░░░…]` bar for a 0..1 fill ratio.
 *
 * The fill is clamped to [0, 1] so a clock tick past the end of a known wait
 * never overflows the bar.
 */
export function renderProgressBar(fill: number): string {
  const ratio = fill < 0 ? 0 : fill > 1 ? 1 : fill;
  const filled = Math.round(ratio * PROGRESS_BAR_WIDTH);
  return `[${"█".repeat(filled)}${"░".repeat(PROGRESS_BAR_WIDTH - filled)}]`;
}

/**
 * Whole-percent of completed phases over the total.
 *
 * The input is clamped to the ten logical phases (defense in depth: the
 * tracker count is already clamped, but an out-of-range caller value must
 * never be able to render 110% or a negative percent).
 */
export function overallPercent(completed: number): number {
  const clamped = completed < 0 ? 0 : completed > SETUP_PROGRESS_PHASE_COUNT ? SETUP_PROGRESS_PHASE_COUNT : completed;
  return Math.floor((clamped / SETUP_PROGRESS_PHASE_COUNT) * 100);
}

/** True when the value names a known phase (runtime boundary guard). */
function isKnownPhase(value: unknown): value is SetupProgressPhase {
  return typeof value === "string" && (SETUP_PROGRESS_PHASES as readonly string[]).includes(value);
}

/** True when the value is a known generic or bounded operation label. */
function isKnownOperation(
  value: unknown,
): value is SetupProgressOperation | SetupBoundedOperation {
  if (typeof value !== "string") {
    return false;
  }
  return (
    (Object.values(SETUP_PROGRESS_OPERATIONS) as readonly string[]).includes(value) ||
    (Object.values(SETUP_PROGRESS_BOUNDED_OPERATIONS) as readonly string[]).includes(value)
  );
}

/**
 * Fixed size of every bounded propagation window.
 *
 * Both polls (key settlement and SA-access verification) run exactly eight
 * checks (`1/8`..`8/8`); the tracker rejects any attempt/maxAttempts pair
 * that claims a different window size, so impossible values can never
 * reach the detail bar or a rendered line.
 */
export const BOUNDED_CHECK_MAX_ATTEMPTS = 8;

/** True when the value is a structurally valid bounded-check info. */
function isValidCheckInfo(value: unknown): value is BoundedCheckInfo {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { attempt, maxAttempts } = value as { readonly attempt?: unknown; readonly maxAttempts?: unknown };
  return (
    typeof attempt === "number" &&
    Number.isInteger(attempt) &&
    attempt >= 1 &&
    attempt <= BOUNDED_CHECK_MAX_ATTEMPTS &&
    typeof maxAttempts === "number" &&
    Number.isInteger(maxAttempts) &&
    maxAttempts === BOUNDED_CHECK_MAX_ATTEMPTS &&
    maxAttempts >= attempt
  );
}

/** True when the value is a stable setup error code. */
function isSetupErrorCode(value: unknown): value is SetupErrorCode {
  return typeof value === "string" && (Object.values(SETUP_ERROR_CODES) as readonly string[]).includes(value);
}

/**
 * Validating progress state machine shared by both renderers.
 *
 * The tracker validates every event and REJECTS (ignores, never throws)
 * invalid ones: phase order (a phase may only start when every earlier
 * phase is complete and no other phase is in progress), duplicate phase
 * completion (a completed phase never increments the count again),
 * operation start/complete pairing (an operation may only complete the
 * exact operation that is active, with matching check attempt info),
 * retry kind/phase consistency, attempt bounds, and checkpoint phase
 * lists (a `resumed` list must be a prefix of the resumable phases).
 * Invalid events are silently dropped so a benign reporting quirk can
 * never silence progress for the rest of a run and can never throw.
 * {@link SetupProgressTracker.resetTransient} clears the in-progress
 * state (current phase, active operation, retry, failure) before the
 * interactive login retry so a re-run can re-emit phase events from
 * scratch; completed phases and the resume flag are kept.
 * {@link SetupProgressTracker.markFailed} records a failure for a phase
 * that is no longer in progress (the controller's `fail()` fallback after
 * a suspend cleared the current phase).
 */
export class SetupProgressTracker {
  private readonly completed = new Map<SetupProgressPhase, SetupProgressSource>();
  private current: SetupProgressPhase | undefined;
  private operation:
    | { readonly phase: SetupProgressPhase; readonly operation: SetupProgressOperation }
    | { readonly phase: SetupProgressPhase; readonly operation: SetupBoundedOperation; readonly check: BoundedCheckInfo }
    | undefined;
  private retry:
    | { readonly phase: SetupProgressPhase; readonly kind: SetupRetryKind; readonly attempt: number; readonly maxAttempts: number }
    | undefined;
  private failed: { readonly phase: SetupProgressPhase; readonly code: SetupErrorCode } | undefined;
  private resumed = false;

  /**
   * Number of completed phases (any source), clamped to the ten logical
   * phases. Duplicate completions are rejected, so the count can never
   * exceed the total; the clamp is defense in depth.
   */
  get completedCount(): number {
    return Math.min(this.completed.size, SETUP_PROGRESS_PHASE_COUNT);
  }

  /** True once a valid `resumed` event was processed. */
  get isResumed(): boolean {
    return this.resumed;
  }

  /** The currently in-progress phase, if any. */
  get currentPhase(): SetupProgressPhase | undefined {
    return this.current;
  }

  /** The active operation (generic step or bounded check), if any. */
  get activeOperation(): SetupProgressTracker["operation"] {
    return this.operation;
  }

  /** The active retry (bounded check/wait context), if any. */
  get activeRetry(): SetupProgressTracker["retry"] {
    return this.retry;
  }

  /** The failed phase/code on a `phase_failed` event, if any. */
  get failure(): SetupProgressTracker["failed"] {
    return this.failed;
  }

  /** True when the phase was completed (by run or checkpoint). */
  isComplete(phase: SetupProgressPhase): boolean {
    return this.completed.has(phase);
  }

  /**
   * Resets the in-progress state so a retried run can re-emit phase events
   * from scratch.
   *
   * Called by the renderer's `suspend()` before the inherited `gcloud auth
   * login` handoff: the first attempt may have died mid-phase (for example
   * during `drive_access`), and the retry re-runs the whole flow from
   * `cloud_auth`. Completed phases and the resume flag are kept — the
   * retry re-completes the same phases, and duplicate completion is
   * rejected so the overall count never grows past the real work.
   */
  resetTransient(): void {
    this.current = undefined;
    this.operation = undefined;
    this.retry = undefined;
    this.failed = undefined;
  }

  /**
   * Records a failure for a phase that is no longer in progress.
   *
   * The controller uses this as the `fail()` fallback after `suspend()`
   * cleared the current phase for the inherited login handoff — and for
   * the deterministic next-pending phase when a run-level error has no
   * current phase: the final failure frame must still name a phase.
   * Validation matches the `phase_failed` event (known phase, stable
   * code) minus the current-phase requirement; the transient
   * operation/retry state is already clear after the suspend.
   */
  markFailed(phase: SetupProgressPhase, code: SetupErrorCode): boolean {
    if (!isKnownPhase(phase) || !isSetupErrorCode(code)) {
      return false;
    }
    this.failed = { phase, code };
    this.current = undefined;
    this.retry = undefined;
    this.operation = undefined;
    return true;
  }

  /** True when every phase before `phase` (in execution order) is complete. */
  private allEarlierCompleted(phase: SetupProgressPhase): boolean {
    const index = SETUP_PROGRESS_PHASES.indexOf(phase);
    if (index === -1) {
      return false;
    }
    for (let i = 0; i < index; i += 1) {
      if (!this.completed.has(SETUP_PROGRESS_PHASES[i] as SetupProgressPhase)) {
        return false;
      }
    }
    return true;
  }

  /** True when `phase` may start: no current phase, not completed, ordered. */
  private isValidNextPhase(phase: SetupProgressPhase): boolean {
    return this.current === undefined && !this.completed.has(phase) && this.allEarlierCompleted(phase);
  }

  /** True when the resumed list is a valid prefix of the resumable phases. */
  private isValidCheckpointList(phases: unknown): boolean {
    if (!Array.isArray(phases)) {
      return false;
    }
    if (phases.length > RESUMABLE_CHECKPOINT_PHASES.length) {
      return false;
    }
    for (let i = 0; i < phases.length; i += 1) {
      if (phases[i] !== RESUMABLE_CHECKPOINT_PHASES[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Processes one event, updating internal state.
   *
   * Never throws: invalid events are rejected (ignored) and `false` is
   * returned so the renderer can skip drawing for them.
   */
  apply(event: SetupProgressEvent): boolean {
    switch (event.type) {
      case "resumed": {
        if (!this.isValidCheckpointList(event.completedFromCheckpoint)) {
          return false;
        }
        this.resumed = true;
        for (const phase of event.completedFromCheckpoint) {
          if (!this.completed.has(phase)) {
            this.completed.set(phase, "checkpoint");
          }
        }
        return true;
      }
      case "phase_started": {
        if (!isKnownPhase(event.phase) || !this.isValidNextPhase(event.phase)) {
          return false;
        }
        this.current = event.phase;
        // A re-run of a phase clears any prior failure display (the login
        // retry re-runs cloud_auth/drive_access after a suspended failure).
        this.failed = undefined;
        if (this.retry?.phase === event.phase) {
          this.retry = undefined;
        }
        return true;
      }
      case "phase_completed": {
        if (!isKnownPhase(event.phase)) {
          return false;
        }
        if (event.source !== "run" && event.source !== "checkpoint") {
          return false;
        }
        // Duplicate completion never increments the count again.
        if (this.completed.has(event.phase)) {
          return false;
        }
        if (event.source === "run") {
          if (this.current !== event.phase) {
            return false;
          }
        } else if (!this.allEarlierCompleted(event.phase)) {
          return false;
        }
        this.completed.set(event.phase, event.source);
        if (this.current === event.phase) {
          this.current = undefined;
        }
        if (this.retry?.phase === event.phase) {
          this.retry = undefined;
        }
        if (this.activeOperation?.phase === event.phase) {
          this.operation = undefined;
        }
        return true;
      }
      case "operation_started":
      case "operation_completed": {
        if (!isKnownPhase(event.phase) || this.current !== event.phase) {
          return false;
        }
        if ("check" in event) {
          // A bounded check must carry valid attempt info and the exact
          // operation label its phase hosts (kind/phase consistency).
          if (!isValidCheckInfo(event.check)) {
            return false;
          }
          const bounded = boundedOperationOf(event.phase);
          if (bounded === undefined || event.operation !== bounded) {
            return false;
          }
        } else if (!isKnownOperation(event.operation)) {
          return false;
        }
        if (event.type === "operation_started") {
          this.operation =
            "check" in event
              ? { phase: event.phase, operation: event.operation, check: event.check }
              : { phase: event.phase, operation: event.operation };
          if ("check" in event) {
            const kind = RETRY_KIND_OF_PHASE[event.phase];
            if (kind === undefined) {
              return false;
            }
            this.retry = {
              phase: event.phase,
              kind,
              attempt: event.check.attempt,
              maxAttempts: event.check.maxAttempts,
            };
          }
          return true;
        }
        // operation_completed must pair with the exact active operation
        // (same phase, operation, and check attempt info).
        const active = this.operation;
        if (active === undefined || active.phase !== event.phase || active.operation !== event.operation) {
          return false;
        }
        if ("check" in event) {
          if (
            !("check" in active) ||
            active.check.attempt !== event.check.attempt ||
            active.check.maxAttempts !== event.check.maxAttempts
          ) {
            return false;
          }
          const kind = RETRY_KIND_OF_PHASE[event.phase];
          if (kind === undefined) {
            return false;
          }
          this.retry = {
            phase: event.phase,
            kind,
            attempt: event.check.attempt,
            maxAttempts: event.check.maxAttempts,
          };
        } else if ("check" in active) {
          return false;
        }
        this.operation = undefined;
        return true;
      }
      case "retry_wait_started": {
        if (!isKnownPhase(event.phase) || this.current !== event.phase) {
          return false;
        }
        // The retry kind must match the phase that hosts it.
        if (RETRY_KIND_OF_PHASE[event.phase] !== event.kind) {
          return false;
        }
        if (
          !Number.isInteger(event.attempt) ||
          !Number.isInteger(event.maxAttempts) ||
          event.attempt < 1 ||
          event.attempt > BOUNDED_CHECK_MAX_ATTEMPTS ||
          event.maxAttempts !== BOUNDED_CHECK_MAX_ATTEMPTS ||
          event.attempt > event.maxAttempts
        ) {
          return false;
        }
        if (!Number.isFinite(event.delayMs) || event.delayMs < 0) {
          return false;
        }
        this.retry = {
          phase: event.phase,
          kind: event.kind,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
        };
        return true;
      }
      case "phase_failed": {
        if (!isKnownPhase(event.phase) || this.current !== event.phase) {
          return false;
        }
        if (!isSetupErrorCode(event.code)) {
          return false;
        }
        this.failed = { phase: event.phase, code: event.code };
        this.current = undefined;
        this.retry = undefined;
        this.operation = undefined;
        return true;
      }
    }
  }
}

/**
 * Events produced by the bounded key-settlement and SA-access verify
 * checks inside `keyProvision` / `saVerify`.
 *
 * These modules stay decoupled from the progress UI; `setupFlow` wires
 * their reporter through {@link boundedCheckReporter} to the progress
 * sink. `check_started` / `check_completed` bracket one propagation check
 * (1-based attempt within the bounded window); `wait_started` precedes a
 * scheduled sleep with the delay before the NEXT check and carries the
 * index of the check that just ran.
 */
export type BoundedCheckReporterEvent =
  | { readonly type: "check_started"; readonly attempt: number; readonly maxAttempts: number }
  | { readonly type: "check_completed"; readonly attempt: number; readonly maxAttempts: number }
  | { readonly type: "wait_started"; readonly attempt: number; readonly maxAttempts: number; readonly delayMs: number };

/** Reporter for the bounded propagation checks of one phase/kind. */
export interface BoundedCheckReporter {
  (event: BoundedCheckReporterEvent): void;
}

/**
 * Builds a {@link BoundedCheckReporter} that forwards to a progress sink as
 * operation events (with check attempt info) and `retry_wait_started`
 * events for the given phase and kind. Returns a no-op when the sink is
 * the {@link NOOP_PROGRESS_SINK}, so key provisioning and SA verification
 * stay cheap when progress is disabled.
 */
export function boundedCheckReporter(
  sink: SetupProgressSink,
  phase: SetupProgressPhase,
  kind: SetupRetryKind,
): BoundedCheckReporter {
  if (sink === NOOP_PROGRESS_SINK) {
    return () => {
      /* progress disabled */
    };
  }
  const operation =
    kind === "key_settlement" ? SETUP_PROGRESS_BOUNDED_OPERATIONS.KEY_SETTLE : SETUP_PROGRESS_BOUNDED_OPERATIONS.SA_ACCESS;
  return (event) => {
    switch (event.type) {
      case "check_started":
        sink.report({
          type: "operation_started",
          phase,
          operation,
          check: { attempt: event.attempt, maxAttempts: event.maxAttempts },
        });
        return;
      case "check_completed":
        sink.report({
          type: "operation_completed",
          phase,
          operation,
          check: { attempt: event.attempt, maxAttempts: event.maxAttempts },
        });
        return;
      case "wait_started":
        sink.report({
          type: "retry_wait_started",
          phase,
          kind,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
        });
        return;
    }
  };
}

/**
 * True when the environment marks an automation session.
 *
 * Mirrors the de-facto CI convention: a NON-EMPTY `CI` value (GitHub
 * Actions, GitLab CI, CircleCI, Travis, ...) marks automation, while an
 * empty override keeps interactive behavior (the same empty-override rule
 * as NO_COLOR). Production `main()` passes this into the CLI context so a
 * CI pseudo-TTY can never prompt for the interactive login handoff or
 * spawn the browser login.
 */
export function isCiEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CI !== undefined && env.CI !== "";
}

/** True when ANSI color/control output should be used (TTY, not NO_COLOR, not CI). */
export function shouldUseInteractiveProgress(
  isTty: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isTty) {
    return false;
  }
  // Respect the de-facto NO_COLOR convention (any non-empty value disables
  // color/control output) and a TTY-only NO_COLOR=0/empty override. A CI
  // pseudo-TTY must also stay static: setup progress is documented as one
  // static line per event there — ANSI redraws and animation timers must
  // never run in CI.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return false;
  }
  return !isCiEnvironment(env);
}

/** Interval (ms) between frames of the known-wait animation in TTY mode. */
const WAIT_ANIMATION_INTERVAL_MS = 250;

/** Marker lines emitted before the static block of the append-only renderer. */
const APPEND_HEADER_FRESH = "Hikoutei setup progress";
const APPEND_HEADER_RESUMED_PREFIX = "Hikoutei setup progress (resuming";

/** Controller surface the CLI orchestration drives in addition to events. */
export interface SetupProgressController extends SetupProgressSink {
  /**
   * Clears the in-place block, stops the animation timer, resets the
   * in-progress tracker state (before the inherited gcloud login handoff),
   * and remembers the in-progress phase so a later `fail()` can render a
   * stable failure frame when the handoff is cancelled or fails.
   */
  suspend(): void;
  /**
   * Ends a login-handoff suspension after a successful login: clears the
   * remembered suspended phase so a retry failure is labeled against the
   * retry's own tracker state (never the pre-login phase) and lets the
   * retry redraw. Never starts or stops timers itself — the retry's own
   * events restart any animation — so nothing runs during the inherited
   * login subprocess.
   */
  resume(): void;
  /** Marks the phase the run died in failed with a stable code, renders, and cleans up. */
  fail(code: SetupErrorCode): void;
  /** Renders the final state and releases any animation timer. */
  finish(): void;
}

/** Options for {@link createSetupProgressRenderer}. */
export interface SetupProgressRendererOptions {
  readonly output: ProgressOutput;
  /** True when the output stream is an interactive terminal. */
  readonly isTty: boolean;
  /** Override the interactive decision (e.g. force static in tests). */
  readonly interactive?: boolean;
  /** Wall-clock used for the known-wait animation; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Scheduler used for the animation interval; defaults to `setInterval`. */
  readonly setInterval?: (handler: () => void, ms: number) => NodeJS.Timeout;
  /** Clears the animation interval; defaults to `clearInterval`. */
  readonly clearInterval?: (handle: NodeJS.Timeout) => void;
}

/**
 * First phase (in execution order) that is not yet complete, if any.
 *
 * The deterministic fallback for a run-level error with no current phase
 * (for example lock contention after the login retry's fresh auth phases):
 * the failure frame names the phase the run was about to enter.
 */
function nextPendingPhase(tracker: SetupProgressTracker): SetupProgressPhase | undefined {
  for (const phase of SETUP_PROGRESS_PHASES) {
    if (!tracker.isComplete(phase)) {
      return phase;
    }
  }
  return undefined;
}

/**
 * Creates the production progress controller.
 *
 * In interactive mode it owns a single animation timer for the known-wait
 * detail bar; the timer is cleared on every subsequent event, on
 * {@link SetupProgressController.suspend} (before the inherited gcloud
 * login), and on {@link SetupProgressController.finish}. The timer is
 * `unref`-ed so it can never be what keeps the process alive (the setup
 * sleep itself holds the run open). In append-only mode no timer is used
 * and ordinary operation events update state without printing a line.
 * All controller methods swallow their own write/scheduler failures so
 * progress can never change the setup result or the exit code.
 */
export function createSetupProgressRenderer(
  options: SetupProgressRendererOptions,
): SetupProgressController {
  const interactive = options.interactive ?? shouldUseInteractiveProgress(options.isTty);
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const tracker = new SetupProgressTracker();
  const output = options.output;
  let headerShown = false;
  let blockLines = 0;
  let animationHandle: NodeJS.Timeout | undefined;
  // The known wait being animated (interactive mode only).
  let wait: { readonly start: number; readonly delay: number } | undefined;
  // The phase that was in progress when `suspend()` cleared the tracker
  // for the login handoff. `fail()` falls back to it when the handoff was
  // cancelled or the login failed and no phase is current anymore, so the
  // final failure frame still names the phase the run died in.
  let suspendedPhase: SetupProgressPhase | undefined;

  /** Writes to the output stream; a closed/erroring stream never fails the run. */
  const safeWrite = (text: string): void => {
    try {
      output.write(text);
    } catch {
      // stderr closed or unwritable: progress must never change the
      // setup result, the mutation order, or the exit code.
    }
  };

  /** Clears the wait-animation timer if one is active. */
  const clearAnimation = (): void => {
    if (animationHandle !== undefined) {
      try {
        clearIntervalFn(animationHandle);
      } catch {
        // Best-effort cleanup; the process is finishing.
      }
      animationHandle = undefined;
    }
    wait = undefined;
  };

  /** Starts the known-wait animation (interactive only) for `delayMs`. */
  const startAnimation = (delayMs: number): void => {
    clearAnimation();
    if (!interactive || delayMs <= 0) {
      return;
    }
    wait = { start: now(), delay: delayMs };
    try {
      animationHandle = setIntervalFn(() => {
        render();
      }, WAIT_ANIMATION_INTERVAL_MS);
    } catch {
      // The scheduler failed: fall back to a static detail line; the
      // setup wait itself is unaffected.
      wait = undefined;
      return;
    }
    // Never let the animation timer be the reason the process stays alive;
    // the real setup sleep keeps the run open while it waits.
    if (typeof animationHandle.unref === "function") {
      animationHandle.unref();
    }
  };

  /** Writes the interactive block in place (clears the previous lines first). */
  const renderInteractive = (): void => {
    const lines = buildBlockLines();
    // Move the cursor up over the previously drawn block, then redraw each
    // line on a cleared line. The first draw has no previous block.
    if (blockLines > 0) {
      safeWrite(`\x1b[${blockLines}A`);
    }
    let written = 0;
    for (const line of lines) {
      safeWrite(`\x1b[2K\r${line}\n`);
      written += 1;
    }
    blockLines = written;
  };

  /**
   * Computes the detail-bar ratio and text for the current state.
   *
   * Priority: a known wait animates its elapsed/total ratio; otherwise a
   * bounded check shows its attempt/max ratio; otherwise a generic step
   * (or the bare phase) shows a fixed `working…` label with a zero ratio;
   * a failed phase shows its stable code; everything else reads "done".
   * No fake percentage is ever shown for unknown-duration work.
   */
  const detailState = (): { readonly ratio: number; readonly text: string } => {
    const retry = tracker.activeRetry;
    if (retry !== undefined) {
      if (wait !== undefined) {
        // Mid-wait: animate the elapsed portion of THIS wait.
        const elapsed = now() - wait.start;
        const ratio = wait.delay <= 0 ? 1 : elapsed / wait.delay;
        return {
          ratio,
          text: `${retry.attempt}/${retry.maxAttempts}  waiting ${Math.round(wait.delay / 1000)}s before next ${RETRY_KIND_WORD[retry.kind]} check`,
        };
      }
      // Between checks (brief): show check progress.
      return {
        ratio: retry.attempt / retry.maxAttempts,
        text: `${retry.attempt}/${retry.maxAttempts}  ${RETRY_CHECK_NOUN[retry.kind]}`,
      };
    }
    const operation = tracker.activeOperation;
    if (operation !== undefined) {
      return { ratio: 0, text: `working… ${operation.operation}` };
    }
    const current = tracker.currentPhase;
    if (current !== undefined) {
      return { ratio: 0, text: `working… ${SETUP_PROGRESS_LABELS[current].toLowerCase()}` };
    }
    const failure = tracker.failure;
    if (failure !== undefined) {
      return { ratio: 0, text: `failed: ${failure.code}` };
    }
    return { ratio: 1, text: "done" };
  };

  /** Builds the fixed-height block (header + overall + detail + done). */
  const buildBlockLines = (): readonly string[] => {
    const completed = tracker.completedCount;
    const pct = overallPercent(completed);
    const header = tracker.isResumed ? "Hikoutei setup (resuming)" : "Hikoutei setup";
    const current = tracker.currentPhase ?? tracker.failure?.phase;
    // The Overall label names the phase the run is working on; with no
    // phase current it names the NEXT pending phase (a phase boundary at
    // 10-90% must never read "complete"), and only a fully completed run
    // (10/10) earns the literal "complete" label.
    let overallLabel: string;
    if (current !== undefined) {
      overallLabel = SETUP_PROGRESS_LABELS[current];
    } else if (completed >= SETUP_PROGRESS_PHASE_COUNT) {
      overallLabel = "complete";
    } else {
      const next = nextPendingPhase(tracker);
      overallLabel = next === undefined ? "complete" : `next: ${SETUP_PROGRESS_LABELS[next]}`;
    }
    const overallLine = `Overall ${renderProgressBar(completed / SETUP_PROGRESS_PHASE_COUNT)} ${String(pct).padStart(3, " ")}% ${completed}/${SETUP_PROGRESS_PHASE_COUNT}  ${overallLabel}`;
    const detail = detailState();
    const detailLine = `Detail  ${renderProgressBar(detail.ratio)} ${detail.text}`;
    const doneLine = `Done    ${buildDoneSegment()}`;
    return [header, overallLine, detailLine, doneLine];
  };

  /** Builds the compact checkmark list for the done line. */
  const buildDoneSegment = (): string => {
    const parts: string[] = [];
    for (const phase of SETUP_PROGRESS_PHASES) {
      if (tracker.isComplete(phase)) {
        parts.push(`✓ ${SETUP_PROGRESS_SHORT_LABELS[phase]}`);
      } else if (tracker.failure !== undefined && tracker.failure.phase === phase) {
        parts.push(`✗ ${SETUP_PROGRESS_SHORT_LABELS[phase]}`);
      } else if (tracker.currentPhase === phase) {
        parts.push(`… ${SETUP_PROGRESS_SHORT_LABELS[phase]}`);
      }
    }
    return parts.length === 0 ? "(starting)" : parts.join("  ");
  };

  /**
   * Append-only renderer: one static line per phase/retry/failure event
   * (bounded-check attempts included — the final 8/8 has no following wait
   * line and must stay visible before success/failure), no control
   * sequences, no clock ticks, and no line for ordinary operation events
   * (CI log spam must stay bounded).
   */
  const renderAppend = (event: SetupProgressEvent): void => {
    const completed = tracker.completedCount;
    if (event.type === "resumed") {
      // The resumed event arrives AFTER the fresh auth/drive phases in the
      // real flow, so it always prints its own resume line with the
      // checkpoint-guaranteed step count.
      safeWrite(`${APPEND_HEADER_RESUMED_PREFIX}; ${completed}/${SETUP_PROGRESS_PHASE_COUNT} steps already complete)\n`);
      return;
    }
    if (!headerShown) {
      safeWrite(`${APPEND_HEADER_FRESH}\n`);
      headerShown = true;
    }
    const pct = overallPercent(completed);
    switch (event.type) {
      case "phase_started": {
        safeWrite(`[ ${String(pct).padStart(3, " ")}% | ${completed}/${SETUP_PROGRESS_PHASE_COUNT}] ${SETUP_PROGRESS_LABELS[event.phase]}\n`);
        return;
      }
      case "phase_completed": {
        const suffix = event.source === "checkpoint" ? " (from checkpoint)" : " ready";
        safeWrite(`[ ${String(pct).padStart(3, " ")}% | ${completed}/${SETUP_PROGRESS_PHASE_COUNT}] ✓ ${SETUP_PROGRESS_LABELS[event.phase]}${suffix}\n`);
        return;
      }
      case "retry_wait_started": {
        const checkWord = RETRY_KIND_WORD[event.kind];
        safeWrite(`  [ ${event.attempt}/${event.maxAttempts}] waiting ${Math.round(event.delayMs / 1000)}s before next ${checkWord} check\n`);
        return;
      }
      case "phase_failed": {
        safeWrite(`[ FAIL | ${event.code}] ${SETUP_PROGRESS_LABELS[event.phase]}\n`);
        return;
      }
      case "operation_started":
      case "operation_completed": {
        if ("check" in event) {
          // A bounded propagation check is visible in static mode: one line
          // per attempt, including the final N/8 that has no following wait
          // line (without it the last attempt would be invisible before
          // success/failure). Only the start prints; the matching
          // completion adds no extra line.
          if (event.type === "operation_started") {
            safeWrite(`  [ ${event.check.attempt}/${event.check.maxAttempts}] ${event.operation}\n`);
          }
          return;
        }
        // Ordinary operation events update state without printing a line.
        return;
      }
    }
  };

  /** Draws the current state in the active mode. */
  const render = (): void => {
    if (interactive) {
      renderInteractive();
    }
    // The append-only renderer draws per event, not on a clock tick.
  };

  return {
    report(event: SetupProgressEvent): void {
      // Invalid events are rejected by the tracker and never drawn.
      if (!tracker.apply(event)) {
        return;
      }
      // A new event always ends any in-flight wait animation first.
      clearAnimation();
      if (interactive) {
        if (event.type === "retry_wait_started") {
          startAnimation(event.delayMs);
        }
        renderInteractive();
      } else {
        renderAppend(event);
      }
    },
    suspend(): void {
      // Remember the phase that was in progress BEFORE resetting: the
      // inherited gcloud login owns the terminal cleanly and the retry
      // re-emits phase events from scratch, but a cancelled handoff or a
      // failed login must still render a stable failure frame naming the
      // phase the run died in.
      const phase = tracker.currentPhase;
      if (phase !== undefined) {
        suspendedPhase = phase;
      }
      // Stop the animation timer and reset the in-progress tracker state.
      clearAnimation();
      tracker.resetTransient();
      if (interactive && blockLines > 0) {
        // Move up over the block, erase each line, then park the cursor on
        // the first cleared line so the next draw (or the login prompt)
        // reuses the space.
        safeWrite(`\x1b[${blockLines}A`);
        for (let i = 0; i < blockLines; i += 1) {
          safeWrite("\x1b[2K\r");
          if (i < blockLines - 1) {
            safeWrite("\n");
          }
        }
        if (blockLines > 1) {
          safeWrite(`\x1b[${blockLines - 1}A`);
        }
        blockLines = 0;
      }
    },
    resume(): void {
      // The inherited login finished and the retry is live again: the
      // suspended-phase fallback must never label a retry failure against
      // the phase the FIRST attempt died in. No timer starts or stops
      // here — the retry's own events restart the animation when a known
      // wait runs, and nothing ever runs during the inherited login.
      suspendedPhase = undefined;
    },
    fail(code: SetupErrorCode): void {
      clearAnimation();
      // The failure frame names the phase the run died in: the live
      // current phase first, then the phase suspended for the login
      // handoff, then the deterministic next pending phase (a run-level
      // error with no current phase — for example lock contention after
      // the retry's fresh auth phases — must still render a safe failure
      // frame), and finally the last phase as a terminal fallback when
      // every phase is complete. All fallbacks use fixed phase labels and
      // stable codes only, so nothing about the failure can leak data.
      const phase =
        tracker.currentPhase ??
        suspendedPhase ??
        nextPendingPhase(tracker) ??
        SETUP_PROGRESS_PHASES[SETUP_PROGRESS_PHASES.length - 1];
      // Consume the suspended fallback: once a failure is finalized, a
      // later fail() or finish() can never reuse the pre-login phase.
      suspendedPhase = undefined;
      if (phase === undefined) {
        return;
      }
      // A phase that is still current fails through the validating
      // tracker; a suspended or next-pending phase is no longer current
      // (the login handoff or the phase boundary cleared it), so it is
      // recorded directly with the same phase/code validation.
      const applied =
        tracker.currentPhase === phase
          ? tracker.apply({ type: "phase_failed", phase, code })
          : tracker.markFailed(phase, code);
      if (!applied) {
        return;
      }
      if (interactive) {
        renderInteractive();
      } else {
        // The append-only renderer printed the phase_started line already
        // (or nothing, for a run-level error); emit an explicit failure
        // line for the phase the run died in.
        renderAppend({ type: "phase_failed", phase, code });
      }
    },
    finish(): void {
      clearAnimation();
      suspendedPhase = undefined;
      if (interactive && blockLines > 0) {
        renderInteractive();
      }
      // Append-only mode needs no terminal frame.
    },
  };
}
