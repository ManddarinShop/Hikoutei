/**
 * Fenced append with optional terminal-head supersession.
 *
 * Both the System_State repair scanner and the User_Input cleanup scanner
 * must sometimes append an effect and supersede a terminal stream head in
 * one SQLite transaction: the durable predecessor guard would otherwise keep
 * the fresh effect blocked forever behind a `failed`/`blocked_candidate`/
 * `conflict` head the worker will never retry. This helper owns that
 * transaction shape so both scanners share one fencing contract.
 */

import { STORAGE_ERROR_CODES, StorageError } from "@hikoutei/storage/storage/errors.js";
import {
  appendPendingEffectsWithAdapter,
  appendPendingEffectsWithSql,
  supersedeEffectWithSql,
  type FencingContext,
  type NewEffect,
} from "@hikoutei/ikisaki";
import type { SqlStorageAdapter } from "@hikoutei/contracts/storage/sql.js";

/** One effect to append plus the terminal head it must supersede, if any. */
export interface AppendPlan {
  readonly effect: NewEffect;
  /** Terminal stream head superseded with {@link effect} in the same transaction. */
  readonly supersedeEffectId: string | null;
}

/**
 * Appends every plan under the fence, superseding each declared terminal head
 * with its replacement effect inside the same transaction.
 *
 * A supersede that changes zero rows means the head was already closed by a
 * concurrent pass: the append is rolled back so the stream stays consistent
 * and the caller re-plans on the next scan. Returns true only when every
 * effect was appended and every supersede applied. Fence loss reports false
 * exactly like `appendPendingEffectsWithAdapter`.
 */
export async function appendEffectsWithSupersedes(
  storage: SqlStorageAdapter,
  fence: FencingContext,
  plans: readonly AppendPlan[],
): Promise<boolean> {
  if (plans.length === 0) return true;
  const needsSupersede = plans.some((plan) => plan.supersedeEffectId !== null);
  if (!needsSupersede) {
    return appendPendingEffectsWithAdapter(
      storage,
      fence,
      plans.map((plan) => plan.effect),
    );
  }

  let appended = false;
  try {
    await storage.transaction(async ({ sql }) => {
      const inserted = await appendPendingEffectsWithSql(
        sql,
        fence,
        plans.map((plan) => plan.effect),
      );
      if (!inserted) return;
      for (const plan of plans) {
        if (plan.supersedeEffectId === null) continue;
        const superseded = await supersedeEffectWithSql(
          sql,
          fence,
          plan.supersedeEffectId,
          plan.effect.effectId,
        );
        if (!superseded) {
          throw new StorageError(
            STORAGE_ERROR_CODES.EFFECT_REPLAN_CONFLICT,
            "terminal stream head could not be superseded during reconciliation",
          );
        }
      }
      appended = true;
    });
  } catch (error: unknown) {
    if (
      error instanceof StorageError &&
      (error.code === STORAGE_ERROR_CODES.EFFECT_REPLAN_CONFLICT ||
        error.code === STORAGE_ERROR_CODES.STALE_WRITER_FENCE)
    ) {
      return false;
    }
    throw error;
  }
  return appended;
}
