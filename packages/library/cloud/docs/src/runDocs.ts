/**
 * Paced Docs API call shells: bounded admission → transport → AIMD feedback.
 *
 * Built on the neutral `runPacedRequest` shell (`@hikoutei/ikisaki`); this
 * module supplies only the Docs edges (refusal error, quota-signal mapping,
 * redacted telemetry). Reads pace on the read lane (`polling` default),
 * writes (`createDocument`/`batchUpdate`) on the write lane.
 */

import {
  credentialBinding,
  runPacedRequest,
  type CredentialPacingPool,
  type PacedQuotaSignals,
  type Presence,
  type QuotaGovernorTimingDefaults,
  type QuotaPacingGovernor,
  type ReadQoSScheduler,
  type RequestStartLimiter,
  type RequestStartPacing,
  type RequestStartPacingDeps,
  type RollingQuotaBudget,
} from "@hikoutei/ikisaki";
import { GOOGLE_DOCS_API_TIMING } from "./constants.js";
import {
  GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES,
  DocsTransportError,
} from "./errors.js";

/** Redacted telemetry event emitted per transport call (no ids/URLs). */
export interface DocsApiRequestEvent {
  readonly operation: "createDocument" | "getDocument" | "batchUpdate";
  readonly pacing: RequestStartPacing;
  readonly operationCount: number;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly httpStatus: Presence<number>;
  readonly code: Presence<string>;
  readonly pacingWaitMs?: number;
  readonly credentialIndex?: number;
  /** Number of structural requests in a batchUpdate body. */
  readonly requestCount?: number;
}

/** Everything one paced Docs call needs (admission stack + telemetry). */
export interface DocsPacingDeps extends RequestStartPacingDeps {
  readonly timingDefaults: QuotaGovernorTimingDefaults;
  readonly now: () => number;
  readonly onRequest: ((event: DocsApiRequestEvent) => void) | undefined;
}

const REQUEST_START_REFUSED_MESSAGE =
  "Google Docs API request start refused before transport: the pacing queue exceeds the bounded admission wait.";

/** Throws the delivery-uncertain refusal error (the worker requeues). */
function refuseRequestStart(): never {
  throw new DocsTransportError(
    GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED,
    REQUEST_START_REFUSED_MESSAGE,
    { kind: "absent" },
    { kind: "absent" },
  );
}

/**
 * Reads the quota pair off a caught error. Docs transport errors carry
 * presence-shaped status/remote-code; anything else is an unverified
 * remote state (absent pair → AIMD-quiet, still delivery-uncertain).
 */
function quotaSignalsOf(error: unknown): PacedQuotaSignals {
  if (error instanceof DocsTransportError) {
    return { httpStatus: error.status, code: error.remoteCode };
  }
  return { httpStatus: { kind: "absent" }, code: { kind: "absent" } };
}

/** Paces ONE `documents.get` transport call and emits one read event. */
export async function runDocsRead<T>(
  deps: DocsPacingDeps,
  /** MUST bind the admitted identity via `credentialBinding` on pooled runs. */
  task: (credentialIndex: number | undefined) => Promise<T>,
  pacing: RequestStartPacing = "polling",
): Promise<T> {
  const startedAt = deps.now();
  return runPacedRequest({
    deps,
    pacing,
    timingDefaults: deps.timingDefaults,
    task,
    quotaSignalsOf,
    onRefused: refuseRequestStart,
    onSettled: (settlement) => {
      deps.onRequest?.({
        operation: "getDocument",
        pacing: settlement.pacing,
        operationCount: 1,
        startedAt,
        durationMs: Math.max(0, deps.now() - startedAt),
        ok: settlement.ok,
        httpStatus: settlement.httpStatus,
        code: settlement.code,
        pacingWaitMs: settlement.pacingWaitMs,
        ...credentialBinding(settlement.credentialIndex),
      });
    },
  });
}

/** Paces ONE mutating call (`createDocument`/`batchUpdate`) on the write lane. */
export async function runDocsWrite<T>(
  deps: DocsPacingDeps,
  operation: "createDocument" | "batchUpdate",
  /** MUST bind the admitted identity via `credentialBinding` on pooled runs. */
  task: (credentialIndex: number | undefined) => Promise<T>,
  meta?: { readonly requestCount?: number },
): Promise<T> {
  const startedAt = deps.now();
  return runPacedRequest({
    deps,
    pacing: "write",
    timingDefaults: deps.timingDefaults,
    task,
    quotaSignalsOf,
    onRefused: refuseRequestStart,
    onSettled: (settlement) => {
      deps.onRequest?.({
        operation,
        pacing: settlement.pacing,
        operationCount: 1,
        startedAt,
        durationMs: Math.max(0, deps.now() - startedAt),
        ok: settlement.ok,
        httpStatus: settlement.httpStatus,
        code: settlement.code,
        pacingWaitMs: settlement.pacingWaitMs,
        ...credentialBinding(settlement.credentialIndex),
        ...meta,
      });
    },
  });
}

/** Re-exported so callers build deps without importing ikisaki pacing twice. */
export {
  GOOGLE_DOCS_API_TIMING,
  type CredentialPacingPool,
  type QuotaPacingGovernor,
  type ReadQoSScheduler,
  type RequestStartLimiter,
  type RequestStartPacing,
  type RollingQuotaBudget,
};
