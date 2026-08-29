/**
 * Type declarations for `scripts/ci/local-soak/scenarios/scenarioVocabulary.mjs`.
 */

/** Stable scenario execution phases (the scheduler's fixed phase values). */
export const KNOWN_SCENARIO_PHASES: readonly string[];

/** Stable attack-scenario ids the soak may record (derived from registry). */
export const KNOWN_SCENARIO_IDS: readonly string[];

/** Stable redacted scenario parameter tags (derived from registry). */
export const KNOWN_SCENARIO_TAGS: readonly string[];

/** The exact redacted tag each registered scenario id records. */
export const SCENARIO_ID_TAGS: Readonly<Record<string, string>>;

/** The allowed execution phases of each registered scenario id. */
export const SCENARIO_ID_PHASES: Readonly<Record<string, readonly string[]>>;

/** Sanitizes one scenario record for a durable artifact. */
export function sanitizeScenarioRecord(value: unknown): Record<string, unknown> | undefined;
