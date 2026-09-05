/**
 * Type declarations for `scripts/ci/local-soak/scenarios/registry.mjs`.
 */

/** The scenario contract every registered module must expose. */
export interface ScenarioModule {
  id: string;
  kind: "data" | "lifecycle";
  allowedPhases: readonly string[];
  /** Stable redacted parameter tag this scenario's plans record. */
  TAG: string;
  plan(input: { seed: number; cycle: number; phase: string; order: number; rng: object }): object;
  execute(input: { plan: object; context: object }): Promise<{
    status: string;
    expectedErrors: number;
    failures: number;
    cleanupFailures?: number;
    reason?: string;
    /** Stable redacted tag when the scenario swallowed a throw. */
    reasonTag?: string;
    /** Allowlisted invariant kinds the scenario's failure counters fired. */
    failureKinds?: string[];
  }>;
  /** Optional deterministic idempotent orphan recovery for a process-death resume. */
  recover?(input: { plan: object; context: object }): Promise<{ removed: number }>;
}

/** Every registered scenario module. */
export const SCENARIO_REGISTRY: readonly ScenarioModule[];

/** Returns a registered scenario module by its fixed id. */
export function getScenarioById(id: string): ScenarioModule | undefined;
