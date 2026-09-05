/**
 * Type declarations for `scripts/ci/local-soak/scenarios/sheetCorruptionDetection.mjs`.
 */

/** Stable scenario id. */
export const id: "sheet-corruption-detection";
/** Data scenario (overlaps data/base workload). */
export const kind: "data";
/** Allowed phase windows. */
export const allowedPhases: readonly string[];
/** Stable redacted parameter tag. */
export const TAG: string;
/** The corrupted shapes this scenario can inject and detect. */
export const CORRUPTION_KINDS: readonly ["duplicate-identity", "shifted-cell", "missing-field"];

/**
 * Pure tab-shape corruption verdict. Only a verdict is returned — never an
 * id, value, or payload. `detected: true, repaired: false` records that
 * detection succeeded and NO repair was performed (the #194 defect
 * evidence).
 */
export type CorruptionVerdict =
  | { readonly status: "clean" }
  | { readonly status: "detected"; readonly kind: string; readonly detected: true; readonly repaired: false };

/**
 * Pure tab-shape corruption detector (string comparison only): malformed/
 * missing header, a non-blank row with a blank identity column
 * (`shifted-cell`), a repeated identity (`duplicate-identity`), or — when
 * an anchor `identity` and `requiredFields` are supplied — a blank
 * required field cell on the anchor row (`missing-field`).
 */
export function detectCorruption(
  rows: ReadonlyArray<readonly unknown[]>,
  scope?: { readonly identity?: string; readonly requiredFields?: readonly string[] },
): CorruptionVerdict;

/** Builds the deterministic plan for one cycle. */
export function plan(input: {
  seed: number;
  cycle: number;
  phase: string;
  order: number;
  rng: object;
}): Record<string, unknown>;

/**
 * Live action: create a dedicated row, inject one corrupted shape into its
 * User_Input tab, re-read the tab, and judge detection. Detection is the
 * expected outcome (one expected error, `repaired: false`); an injected
 * corruption the read misses is the guard deficiency (failures=1).
 */
export function execute(input: { plan: object; context: object }): Promise<{
  status: string;
  expectedErrors: number;
  failures: number;
  cleanupFailures?: number;
  reason?: string;
  reasonTag?: string;
  failureKinds?: string[];
}>;

/** Deterministic idempotent orphan recovery for a process-death resume. */
export function recover(input: { plan: object; context: object }): Promise<{ removed: number }>;
