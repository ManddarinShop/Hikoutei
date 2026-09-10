/**
 * Neutral paced-request shell shared by every Google API provider lane.
 *
 * Sheets proved the composition (bounded admission → transport call → AIMD
 * feedback on quota-limited outcomes → redacted telemetry); this module
 * parameterizes the provider-specific edges so Docs (and later Drive) reuse
 * the shell without copying it:
 *
 * - admission comes from `admitRequestStart` (interval pacing + per-minute
 *   budgets + per-credential slots, all owned by the caller-supplied deps);
 * - quota feedback needs only the `{ httpStatus, code }` presence pair, so
 *   callers map their own transport error to that pair instead of importing
 *   another provider's fault codes;
 * - refusal and telemetry stay caller-owned (each provider keeps its own
 *   error vocabulary and event shape).
 *
 * Sheets keeps its own `runRead`/`runWrite` for now (stable path, migrated
 * separately after Docs proves this shell); new providers start here.
 */

import type { Presence } from "../../contract/state.js";
import {
  admitRequestStart,
  type RequestStartPacing,
  type RequestStartPacingDeps,
} from "./requestAdmission.js";
import {
  DEFAULT_QUOTA_GOVERNOR_TIMING,
  isQuotaLimitedOutcome,
  QUOTA_GOVERNOR_LANES,
  type QuotaGovernorTimingDefaults,
} from "./quotaGovernor.js";

/** Quota signals a provider reads off its own transport error. */
export interface PacedQuotaSignals {
  readonly httpStatus: Presence<number>;
  readonly code: Presence<string>;
}

/** Provider-owned edges of one paced request. */
export interface RunPacedRequestOptions<T> {
  /** Admission stack (limiters, budgets, governors, pool, bounds, clock). */
  readonly deps: RequestStartPacingDeps;
  /** Lane the call paces on (`polling`/`preflight` share the read lane). */
  readonly pacing: RequestStartPacing;
  /**
   * Quota/backoff markers; defaults to the inlined Sheets-measured markers
   * (providers with their own measured quota pass their own object and use
   * the SAME object for every governor they construct).
   */
  readonly timingDefaults?: QuotaGovernorTimingDefaults;
  /**
   * The transport call. Receives the admitted pool identity and MUST bind
   * it into the request on pooled runs (`undefined` on single-credential).
   */
  readonly task: (credentialIndex: number | undefined) => Promise<T>;
  /** Reads the quota pair off a caught transport error (never throws). */
  readonly quotaSignalsOf: (error: unknown) => PacedQuotaSignals;
  /** Throws the provider's refusal error (delivery-uncertain, requeued). */
  readonly onRefused: () => never;
  /** Settlement hook (telemetry); must never throw out of the result path. */
  readonly onSettled: (settlement: PacedSettlement) => void;
}

/** Settlement handed to `onSettled` (telemetry only, no payloads). */
export interface PacedSettlement {
  readonly ok: boolean;
  readonly pacing: RequestStartPacing;
  readonly pacingWaitMs: number;
  readonly credentialIndex: number | undefined;
  readonly httpStatus: Presence<number>;
  readonly code: Presence<string>;
}

/**
 * Runs one bounded paced request: admits a start slot (refusal throws via
 * `onRefused` before any transport call), runs the task bound to the
 * admitted identity, and feeds quota-limited outcomes back to the SAME
 * slot's governor. Success/failure telemetry goes through `onSettled`.
 */
export async function runPacedRequest<T>(options: RunPacedRequestOptions<T>): Promise<T> {
  const timing = options.timingDefaults ?? DEFAULT_QUOTA_GOVERNOR_TIMING;
  const admission = await admitRequestStart(options.deps, options.pacing);
  if (admission === null) {
    options.onRefused();
  }
  const { pacingWaitMs, credentialIndex, slot } = admission;
  try {
    const result = await options.task(credentialIndex);
    settle(options, { ok: true, pacingWaitMs, credentialIndex }, undefined);
    return result;
  } catch (error: unknown) {
    const signals = options.quotaSignalsOf(error);
    if (isQuotaLimitedOutcome(signals, timing)) {
      slot.quotaGovernor.recordQuotaLimited(
        options.pacing === "write" ? QUOTA_GOVERNOR_LANES.WRITE : QUOTA_GOVERNOR_LANES.READ,
      );
    }
    settle(options, { ok: false, pacingWaitMs, credentialIndex }, signals);
    throw error;
  }
}

/** Invokes `onSettled` defensively: diagnostics never change a result. */
function settle(
  options: RunPacedRequestOptions<unknown>,
  base: { ok: boolean; pacingWaitMs: number; credentialIndex: number | undefined },
  signals: PacedQuotaSignals | undefined,
): void {
  try {
    options.onSettled({
      ok: base.ok,
      pacing: options.pacing,
      pacingWaitMs: base.pacingWaitMs,
      credentialIndex: base.credentialIndex,
      httpStatus: signals?.httpStatus ?? { kind: "absent" },
      code: signals?.code ?? { kind: "absent" },
    });
  } catch {
    // Diagnostics must never change a remote result.
  }
}
