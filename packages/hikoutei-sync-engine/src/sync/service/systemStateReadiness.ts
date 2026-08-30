/**
 * Internal System_State readiness controller for external convergence
 * barriers.
 *
 * External tooling (for example the local multi-table soak runner's live
 * convergence phase) needs to know when a runtime's System_State outbox
 * drain has finished so its own batched sheet reads do not compete with
 * the initial drain on the shared request limiter. The sync service
 * registers every runtime it bootstraps here and unregisters it when the
 * runtime closes; a runtime that was never registered (plain local-only
 * mode, or an already-closed runtime) reports ready immediately.
 *
 * This module is deliberately internal: it is never re-exported from
 * `src/index.ts`, and applications observe readiness only through the
 * library's own behavior.
 */

import type { Hikoutei } from "../../api/hikouteiCore.js";
import type { SyncServiceStorage } from "./compositionPorts.js";
import {
  readSystemStateDrainReadinessWithAdapter,
  type SystemStateDrainReadiness,
} from "@hikoutei/ikisaki";

/** Storage handle bound to one registered runtime. */
interface RegisteredRuntime {
  readonly storage: SyncServiceStorage;
}

/**
 * Registry of bootstrapped runtimes keyed by the runtime object itself.
 *
 * A WeakMap keeps the registry inert: a runtime that is garbage-collected
 * without closing (or whose registration leaked) never pins its storage
 * or SQLite file open, and the key is the exact public `Hikoutei` object
 * the caller holds.
 */
const registeredRuntimes = new WeakMap<Hikoutei, RegisteredRuntime>();

/** Registers one bootstrapped runtime for readiness queries. */
export function registerSystemStateReadiness(
  runtime: Hikoutei,
  storage: SyncServiceStorage,
): void {
  registeredRuntimes.set(runtime, { storage });
}

/** Unregisters one runtime (called on close, before storage is released). */
export function unregisterSystemStateReadiness(runtime: Hikoutei): void {
  registeredRuntimes.delete(runtime);
}

/**
 * Reports the CURRENT System_State drain readiness of one runtime.
 *
 * Only the System_State projection's claimable in-flight effects are
 * considered — never the whole-outbox idle state. A pending follower behind
 * a conflict/blocked_candidate/failed predecessor is not claimable drain
 * work and never defers, so an open conflict cannot stall the barrier. A
 * runtime without a registered sync service (local-only mode, or already
 * closed) has no outbox to drain and is ready immediately.
 */
export async function readRuntimeSystemStateReadiness(
  runtime: Hikoutei,
): Promise<SystemStateDrainReadiness> {
  const entry = registeredRuntimes.get(runtime);
  if (entry === undefined) return { status: "ready" };
  return readSystemStateDrainReadinessWithAdapter(entry.storage);
}
