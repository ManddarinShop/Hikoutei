/**
 * Leaf contracts for the effect planner: the shared plan/outcome/row types.
 *
 * The planner core (`planner.ts`) and its focused helper modules
 * (`plannerWorkingRow`, `plannerDeletion`, `plannerReceipt`) all consume
 * these types. Living in one leaf module keeps the helper modules free of
 * imports back into the planner core, so planner files never form a type
 * cycle.
 */

import type { SyncProjectionEffect } from "@hikoutei/contracts/sheets/syncSheets.js";
import type { Presence } from "@hikoutei/contracts/state/index.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/index.js";

/** Receipt evidence produced by the planner for one effect. */
export interface PlannedReceipt {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly status: "applied";
  readonly visibleHash: string;
  readonly visibleRevision: number;
}

/** Terminal/non-terminal planner outcome for one effect. */
export type PlannedOutcome =
  | {
    readonly kind: "applied";
    readonly effect: SyncProjectionEffect;
    readonly rowNumber: Presence<number>;
    readonly receipt: PlannedReceipt;
    readonly created: boolean;
    readonly deletion: boolean;
  }
  | {
    readonly kind: "already_applied";
    readonly effect: SyncProjectionEffect;
    readonly rowNumber: Presence<number>;
    readonly receipt: PlannedReceipt;
  }
  | {
    readonly kind: "guard_mismatch";
    readonly effect: SyncProjectionEffect;
    readonly rowNumber: Presence<number>;
    readonly reason: string;
  }
  | {
    readonly kind: "repair_reobserve";
    readonly effect: SyncProjectionEffect;
    readonly rowNumber: Presence<number>;
    readonly reason: string;
  }
  | {
    readonly kind: "schema_error";
    readonly effect: SyncProjectionEffect;
    readonly rowNumber: Presence<number>;
    readonly reason: string;
  }
  | {
    readonly kind: "retryable_error";
    readonly effect: SyncProjectionEffect;
    readonly rowNumber: Presence<number>;
    readonly reason: string;
  };

/** Target mutation planned for one effect (only successful write outcomes). */
export type PlanMutation =
  | { readonly kind: "append"; readonly row: WorkingRow }
  | { readonly kind: "update"; readonly row: WorkingRow }
  | { readonly kind: "delete"; readonly row: WorkingRow };

/** Mutable working copy of one preflight row during planning. */
export interface WorkingRow {
  readonly rowNumber: number;
  readonly anchor: Presence<string>;
  readonly cells: Record<string, NormalizedCell>;
  readonly identity: Presence<string>;
  readonly appended: boolean;
  deleted: boolean;
  readonly writeFields: Record<string, NormalizedCell>;
}

/** Per-effect plan: outcome plus any mutation and receipt the batch needs. */
export interface EffectPlan {
  readonly outcome: PlannedOutcome;
  readonly mutation: PlanMutation | undefined;
  readonly receipt: PlannedReceipt | undefined;
  /** True when inline postcondition verification must re-read this write. */
  readonly verify: boolean;
}
