/**
 * Telemetry contract for the per-spreadsheet Gateway coordinator.
 *
 * Lane events are diagnostic only: a sink failure must never change gateway
 * behavior. The fields are deliberately redacted — no signed payload, secret,
 * or operation arguments are recorded.
 */

import { TRANSPORT_OUTCOME_KINDS, type TransportOutcomeKind } from "../transportClassification.js";

export { TRANSPORT_OUTCOME_KINDS };
export type { TransportOutcomeKind };

/** One observed mutation lane event emitted by the coordinator. */
export interface CoordinatorLaneEvent {
  /** Operation name (no arguments). */
  readonly operation: string;
  /** Lane key(s) involved; multiple keys are comma-joined in sorted order. */
  readonly laneKey: string;
  /** Time spent waiting for the lane before dispatch. */
  readonly queueWaitMs: number;
  /** Wall-clock duration of the remote call once the lane was held. */
  readonly remoteDurationMs: number;
  /** Classified transport outcome for the dispatch. */
  readonly outcome: TransportOutcomeKind;
  /** Whether an HTTP status was observed. */
  readonly httpStatus: "present" | "absent";
  /** Whether a stable client/remote code was observed. */
  readonly code: "present" | "absent";
}

/** Convenience type alias used by call sites that only need the event shape. */
export type CoordinatorLaneSink = (event: CoordinatorLaneEvent) => void;

/** Marker used so callers can type an absent presence without importing state. */
// Presence is re-exported through transportClassification's redacted fields,
// so this file does not need to import the shared state types directly.
