/**
 * Type declarations for `scripts/ci/local-soak/resumeHistorySchema.mjs`.
 */

/** Every probe failure reason a live run can record after redaction. */
export const LIVE_PROBE_FAILURE_REASONS: readonly string[];

/** True when a candidate is a known persisted status class (incl. `unknown`). */
export function isKnownStatusClass(candidate: unknown): boolean;

/** Reads one JSONL artifact strictly into parsed records. */
export function readStrictJsonlRecords(
  filePath: string,
  fileName: string,
  fail: (reason: string) => void,
): Promise<object[]>;

/** Scenario vocabulary derived from a registered scenario set. */
export interface ScenarioVocab {
  KNOWN_SCENARIO_IDS: readonly string[];
  KNOWN_SCENARIO_PHASES: readonly string[];
  KNOWN_SCENARIO_TAGS: readonly string[];
  SCENARIO_ID_TAGS: Readonly<Record<string, string>>;
  SCENARIO_ID_PHASES: Readonly<Record<string, readonly string[]>>;
}

/**
 * Validates ONE cycle record against the exact runner schema.
 *
 * `vocab` defaults to the vocabulary derived from the currently registered
 * scenario modules; tests may pass a stub-derived vocabulary to exercise
 * acceptance/rejection without changing the registered registry.
 */
export function validateCycleRecordShape(
  record: object,
  vocab?: ScenarioVocab,
): { ok: true } | { ok: false; reason: string };

/** Validates ONE operation record against the exact runner schema. */
export function validateOperationRecordShape(
  record: object,
): { ok: true } | { ok: false; reason: string };

/** Validates ONE resource record against the exact runner schema. */
export function validateResourceRecordShape(
  record: object,
): { ok: true } | { ok: false; reason: string };
