/**
 * Consistency-queue kernel tests.
 *
 * These cover the queue contracts on an in-memory SQLite store through the
 * kernel's own adapter port: transaction-bound enqueue, claim/fencing,
 * terminal transitions, ambiguous-delivery recovery, delivery-confirmation
 * receipts, stream ordering, and the fast-append selection window.
 */

import { describe, expect, it } from "vitest";

import {
  appendPendingEffectsWithAdapter,
  appendPendingEffectsWithSql,
  applyEffectResultWithAdapter,
  applyEffectResultWithSql,
  claimEffectWithAdapter,
  claimEffectWithSql,
  claimWriterLeaseWithAdapter,
  claimWriterLeaseWithSql,
  findPendingEffectsByTargetWithSql,
  hasPendingOrProcessingEffectsWithSql,
  listReadyEffectsWithAdapter,
  listReadyEffectsWithSql,
  listReadyFastAppendEffectsWithSql,
  markDeliveryUncertainWithAdapter,
  markDeliveryUncertainWithSql,
  readOutboxScanReadinessWithAdapter,
  readSystemStateDrainReadinessWithAdapter,
  readWriterLeaseWithAdapter,
  recoverExpiredLeasesWithSql,
  releaseWriterLeaseWithAdapter,
  renewEffectLeaseWithSql,
  retryClaimedEffectWithSql,
  STORAGE_ERROR_CODES,
  StorageError,
  supersedeAndReplanWithSql,
  SYNC_EFFECT_RECOVERY_ERROR_CODES,
  type EffectProjectionConfirmation,
  type FencingContext,
  type PendingEffect,
  type SqlExecutor,
} from "../src/index.js";
import { APPLICABILITY_KINDS, LOOKUP_RESULT_KINDS, PRESENCE_KINDS, WRITER_LEASE_CLAIM_RESULT_KINDS } from "../src/index.js";
import {
  claimTestFence,
  createKernelStore,
  newEffect,
  TEST_NOW,
  TEST_ROLE,
} from "./support/kernelFixtures.js";
import { NodeSqliteTestAdapter } from "./support/nodeSqliteAdapter.js";

/** Runs one queue operation through the store's async SQL context. */
function withSql<T>(
  adapter: NodeSqliteTestAdapter,
  operation: (sql: SqlExecutor) => Promise<T>,
): Promise<T> {
  return adapter.read(({ sql }) => operation(sql));
}

function fenceAt(fence: FencingContext, now: number): FencingContext {
  return { ...fence, now };
}

async function readOutboxRow(
  adapter: NodeSqliteTestAdapter,
  effectId: string,
): Promise<Record<string, unknown> | undefined> {
  return adapter.read(({ sql }) =>
    sql.get("SELECT * FROM sheet_effect_outbox WHERE effect_id = ?", [effectId]));
}

describe("consistency-queue kernel", () => {
  describe("transaction-bound enqueue", () => {
    it("commits enqueued effects with the business transaction and rolls them back with it", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const first = newEffect();

      // Committed transaction: the row survives.
      const committed = await adapter.transaction(async ({ sql }) => {
        const ok = await appendPendingEffectsWithSql(sql, fence, [first]);
        expect(ok).toBe(true);
        return ok;
      });
      expect(committed).toBe(true);
      const row = await readOutboxRow(adapter, first.effectId);
      expect(row).toBeDefined();
      expect(row?.status).toBe("pending");
      expect(row?.effect_dedupe_key).toBe(first.effectDedupeKey);
      expect(await withSql(adapter, (sql) => hasPendingOrProcessingEffectsWithSql(sql)))
        .toBe(true);

      // Rolled-back transaction: the row must not exist, while the committed
      // effect from the earlier transaction remains pending.
      const second = newEffect();
      await expect(
        adapter.transaction(async ({ sql }) => {
          await appendPendingEffectsWithSql(sql, fence, [second]);
          throw new Error("business transaction aborted");
        }),
      ).rejects.toThrow("business transaction aborted");
      expect(await readOutboxRow(adapter, second.effectId)).toBeUndefined();
      expect(await withSql(adapter, (sql) => hasPendingOrProcessingEffectsWithSql(sql)))
        .toBe(true);
    });

    it("returns false when the writer fence is stale instead of enqueueing", async () => {
      const adapter = createKernelStore();
      await claimTestFence(adapter);
      const effect = newEffect();
      const staleFence: FencingContext = {
        role: "test-writer",
        writerEpoch: 99,
        fencingToken: "fence-99:other",
        now: TEST_NOW,
      };
      const ok = await appendPendingEffectsWithAdapter(adapter, staleFence, [effect]);
      expect(ok).toBe(false);
      expect(await readOutboxRow(adapter, effect.effectId)).toBeUndefined();
    });
  });

  describe("claim, lease, and recovery", () => {
    it("claims one effect with a lease and blocks a second claim", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const effect = newEffect();
      await appendPendingEffectsWithAdapter(adapter, fence, [effect]);

      const claimToken = "claim-1";
      const claimed = await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: effect.effectId,
        claimToken,
        leaseDurationMs: 30_000,
      });
      expect(claimed).toEqual({
        effectId: effect.effectId,
        claimToken,
        status: "claimed",
      });

      const row = await readOutboxRow(adapter, effect.effectId);
      expect(row?.status).toBe("processing");
      expect(row?.claim_token).toBe(claimToken);
      expect(row?.lease_until).toBe(TEST_NOW + 30_000);
      expect(row?.attempts).toBe(1);
      expect(row?.dispatch_id).toBe("dispatch:" + claimToken);

      // A second worker with its own claim token cannot claim the same effect.
      const second = await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: effect.effectId,
        claimToken: "claim-2",
        leaseDurationMs: 30_000,
      });
      expect(second).toMatchObject({ status: "not_claimed", reason: "not_claimable" });
    });

    it("renews a live lease and only after expiry recovers the effect", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const effect = newEffect();
      await appendPendingEffectsWithAdapter(adapter, fence, [effect]);
      const claimToken = "claim-1";
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: effect.effectId,
        claimToken,
        leaseDurationMs: 30_000,
      });

      // Renewal extends the lease while the claim and fence still match.
      const renewed = await withSql(adapter, (sql) =>
        renewEffectLeaseWithSql(sql, {
          ...fence,
          effectId: effect.effectId,
          claimToken,
          leaseDurationMs: 45_000,
        }));
      expect(renewed).toBe(true);
      const renewedRow = await readOutboxRow(adapter, effect.effectId);
      expect(renewedRow?.lease_until).toBe(TEST_NOW + 45_000);

      // A stale claim token cannot renew.
      expect(await withSql(adapter, (sql) =>
        renewEffectLeaseWithSql(sql, {
          ...fence,
          effectId: effect.effectId,
          claimToken: "wrong-token",
          leaseDurationMs: 45_000,
        }))).toBe(false);

      // After the lease expires, recovery marks the effect delivery-uncertain.
      const laterFence = fenceAt(fence, TEST_NOW + 46_000);
      const recovered = await withSql(adapter, (sql) =>
        recoverExpiredLeasesWithSql(sql, laterFence));
      expect(recovered).toBe(1);
      const recoveredRow = await readOutboxRow(adapter, effect.effectId);
      expect(recoveredRow?.status).toBe("delivery_uncertain");
      expect(recoveredRow?.claim_token).toBeNull();
      expect(recoveredRow?.last_error_code).toBe(
        SYNC_EFFECT_RECOVERY_ERROR_CODES.LEASE_EXPIRED_REQUIRES_POSTCONDITION,
      );

      // The effect is selectable again once its probe time is due.
      const notDue = await withSql(adapter, (sql) =>
        listReadyEffectsWithSql(sql, 10, TEST_NOW + 45_000));
      expect(notDue.map((item) => item.effect_id)).toEqual([]);
      const due = await withSql(adapter, (sql) =>
        listReadyEffectsWithSql(sql, 10, TEST_NOW + 46_000));
      expect(due.map((item) => item.effect_id)).toEqual([effect.effectId]);
      expect(due[0]?.status).toBe("delivery_uncertain");
    });
  });

  describe("apply result transitions", () => {
    for (const status of ["applied", "blocked_candidate", "conflict", "superseded", "failed"] as const) {
      it(`closes a claimed effect with status ${status}`, async () => {
        const adapter = createKernelStore();
        const fence = await claimTestFence(adapter);
        const effect = newEffect();
        await appendPendingEffectsWithAdapter(adapter, fence, [effect]);
        await claimEffectWithAdapter(adapter, {
          ...fence,
          effectId: effect.effectId,
          claimToken: "claim-1",
          leaseDurationMs: 30_000,
        });

        const applied = await applyEffectResultWithAdapter(adapter, {
          ...fence,
          effectId: effect.effectId,
          claimToken: "claim-1",
          status,
          lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
          lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
        });
        expect(applied).toBe(true);

        const row = await readOutboxRow(adapter, effect.effectId);
        expect(row?.status).toBe(status);
        expect(row?.claim_token).toBeNull();
        expect(row?.lease_until).toBeNull();

        // A terminal effect cannot be applied twice.
        const again = await applyEffectResultWithAdapter(adapter, {
          ...fence,
          effectId: effect.effectId,
          claimToken: "claim-1",
          status,
          lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
          lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
        });
        expect(again).toBe(false);
      });
    }

    it("rejects a non-terminal result before touching the row", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const effect = newEffect();
      await appendPendingEffectsWithAdapter(adapter, fence, [effect]);
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: effect.effectId,
        claimToken: "claim-1",
        leaseDurationMs: 30_000,
      });

      await expect(
        withSql(adapter, (sql) =>
          applyEffectResultWithSql(sql, {
            ...fence,
            effectId: effect.effectId,
            claimToken: "claim-1",
            status: "pending",
            lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
            lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
          } as never)),
      ).rejects.toThrowError(StorageError);
      expect((await readOutboxRow(adapter, effect.effectId))?.status).toBe("processing");
    });
  });

  describe("ambiguous delivery and probing", () => {
    it("marks delivery uncertain, selects by probe time, and requeues after a postcondition read", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const effect = newEffect();
      await appendPendingEffectsWithAdapter(adapter, fence, [effect]);
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: effect.effectId,
        claimToken: "claim-1",
        leaseDurationMs: 30_000,
      });

      const moved = await markDeliveryUncertainWithAdapter(adapter, {
        ...fence,
        effectId: effect.effectId,
        claimToken: "claim-1",
        uncertainSince: TEST_NOW + 1_000,
        nextProbeAt: TEST_NOW + 10_000,
        lastErrorCode: SYNC_EFFECT_RECOVERY_ERROR_CODES.DELIVERY_UNCERTAIN_REQUIRES_PROBE,
        lastErrorMessage: "response lost",
      });
      expect(moved).toBe(true);

      const row = await readOutboxRow(adapter, effect.effectId);
      expect(row?.status).toBe("delivery_uncertain");
      expect(row?.uncertain_since).toBe(TEST_NOW + 1_000);
      expect(row?.next_probe_at).toBe(TEST_NOW + 10_000);

      // Not selected before the probe time; selected once the probe is due.
      expect(await withSql(adapter, (sql) => listReadyEffectsWithSql(sql, 10, TEST_NOW + 9_000)))
        .toEqual([]);
      const due = await withSql(adapter, (sql) =>
        listReadyEffectsWithSql(sql, 10, TEST_NOW + 10_000));
      expect(due.map((item) => item.effect_id)).toEqual([effect.effectId]);

      // The worker claims the probe, reads the postcondition, and requeues.
      const probeFence = fenceAt(fence, TEST_NOW + 10_000);
      const probeClaim = await withSql(adapter, (sql) =>
        claimEffectWithSql(sql, {
          ...probeFence,
          effectId: effect.effectId,
          claimToken: "probe-claim",
          leaseDurationMs: 30_000,
        }));
      expect(probeClaim.status).toBe("claimed");
      const requeued = await withSql(adapter, (sql) =>
        retryClaimedEffectWithSql(sql, {
          ...probeFence,
          effectId: effect.effectId,
          claimToken: "probe-claim",
          lastErrorCode: SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE,
          lastErrorMessage: "not visible yet",
        }));
      expect(requeued).toBe(true);
      const requeuedRow = await readOutboxRow(adapter, effect.effectId);
      expect(requeuedRow?.status).toBe("pending");
      expect(requeuedRow?.next_attempt_at).toBe(TEST_NOW + 11_000);
    });

    it("rejects unordered uncertain timestamps", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const effect = newEffect();
      await appendPendingEffectsWithAdapter(adapter, fence, [effect]);
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: effect.effectId,
        claimToken: "claim-1",
        leaseDurationMs: 30_000,
      });
      await expect(
        withSql(adapter, (sql) =>
          markDeliveryUncertainWithSql(sql, {
            ...fence,
            effectId: effect.effectId,
            claimToken: "claim-1",
            uncertainSince: TEST_NOW + 5_000,
            nextProbeAt: TEST_NOW + 1_000,
            lastErrorCode: "x",
            lastErrorMessage: "x",
          })),
      ).rejects.toThrowError(StorageError);
    });
  });

  describe("recoverable failure codes", () => {
    it("re-selects a failed row carrying the legacy gateway retryable error code", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const effect = newEffect();
      await appendPendingEffectsWithAdapter(adapter, fence, [effect]);
      await adapter.transaction(async ({ sql }) => {
        await sql.run(
          `UPDATE sheet_effect_outbox
           SET status = 'failed',
               last_error_code = '${SYNC_EFFECT_RECOVERY_ERROR_CODES.LEGACY_GATEWAY_RETRYABLE_ERROR}',
               next_attempt_at = ?
           WHERE effect_id = ?`,
          [TEST_NOW, effect.effectId],
        );
      });

      const ready = await withSql(adapter, (sql) => listReadyEffectsWithSql(sql, 10, TEST_NOW));
      expect(ready.map((item) => item.effect_id)).toEqual([effect.effectId]);

      // The legacy row is claimable again through the normal claim path.
      const claimed = await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: effect.effectId,
        claimToken: "claim-1",
        leaseDurationMs: 30_000,
      });
      expect(claimed.status).toBe("claimed");
    });
  });

  describe("delivery-confirmation mirror", () => {
    it("writes confirmed visible state atomically with the applied result", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const effect = newEffect({ rowBindingId: { kind: PRESENCE_KINDS.PRESENT, value: "binding-1" } });
      await appendPendingEffectsWithAdapter(adapter, fence, [effect]);
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: effect.effectId,
        claimToken: "claim-1",
        leaseDurationMs: 30_000,
      });

      const confirmation: EffectProjectionConfirmation = {
        physicalSheetId: "physical-1",
        projection: "system_state",
        rowBindingId: "binding-1",
        visibleRevision: 1,
        visibleHash: "visible-hash-1",
        entityRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: 1 },
        fieldHashes: { name: "field-hash-1" },
      };
      const applied = await withSql(adapter, (sql) =>
        applyEffectResultWithSql(sql, {
          ...fence,
          effectId: effect.effectId,
          claimToken: "claim-1",
          status: "applied",
          projectionConfirmation: confirmation,
          lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
          lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
        }));
      expect(applied).toBe(true);

      const visible = await adapter.read(({ sql }) =>
        sql.get(
          `SELECT confirmed_snapshot_hash, confirmed_visible_revision, confirmed_entity_revision
           FROM sheet_visible_state
           WHERE physical_sheet_id = 'physical-1' AND projection = 'system_state' AND row_binding_id = 'binding-1'`,
        ));
      expect(visible).toMatchObject({
        confirmed_snapshot_hash: "visible-hash-1",
        confirmed_visible_revision: 1,
        confirmed_entity_revision: 1,
      });
      const field = await adapter.read(({ sql }) =>
        sql.get(
          `SELECT confirmed_field_hash, confirmed_visible_revision
           FROM sheet_visible_field_state
           WHERE physical_sheet_id = 'physical-1' AND projection = 'system_state'
             AND row_binding_id = 'binding-1' AND field_name = 'name'`,
        ));
      expect(field).toMatchObject({
        confirmed_field_hash: "field-hash-1",
        confirmed_visible_revision: 1,
      });
    });

    it("rejects a confirmation that would move visible state backwards", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const first = newEffect({ rowBindingId: { kind: PRESENCE_KINDS.PRESENT, value: "binding-1" } });
      await appendPendingEffectsWithAdapter(adapter, fence, [first]);
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: first.effectId,
        claimToken: "claim-1",
        leaseDurationMs: 30_000,
      });

      const baseConfirmation: EffectProjectionConfirmation = {
        physicalSheetId: "physical-1",
        projection: "system_state",
        rowBindingId: "binding-1",
        visibleRevision: 5,
        visibleHash: "visible-hash-5",
        entityRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
        fieldHashes: { name: "field-hash-5" },
      };
      expect(await withSql(adapter, (sql) =>
        applyEffectResultWithSql(sql, {
          ...fence,
          effectId: first.effectId,
          claimToken: "claim-1",
          status: "applied",
          projectionConfirmation: baseConfirmation,
          lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
          lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
        }))).toBe(true);

      // A second effect that read back an older revision must fail loudly.
      const second = newEffect({ rowBindingId: { kind: PRESENCE_KINDS.PRESENT, value: "binding-1" } });
      await appendPendingEffectsWithAdapter(adapter, fence, [second]);
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: second.effectId,
        claimToken: "claim-2",
        leaseDurationMs: 30_000,
      });
      await expect(
        withSql(adapter, (sql) =>
          applyEffectResultWithSql(sql, {
            ...fence,
            effectId: second.effectId,
            claimToken: "claim-2",
            status: "applied",
            projectionConfirmation: {
              ...baseConfirmation,
              visibleRevision: 3,
              visibleHash: "visible-hash-3",
              fieldHashes: { name: "field-hash-3" },
            },
            lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
            lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
          })),
      ).rejects.toMatchObject({
        code: STORAGE_ERROR_CODES.PROJECTION_CONFIRMATION_REGRESSION,
      });

      // The regression rolled the effect transition back with the mirror.
      const secondRow = await readOutboxRow(adapter, second.effectId);
      expect(secondRow?.status).toBe("processing");
    });

    it("advances a create-if-missing confirmation past a higher confirmed revision instead of rejecting it", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const first = newEffect({ rowBindingId: { kind: PRESENCE_KINDS.PRESENT, value: "binding-1" } });
      await appendPendingEffectsWithAdapter(adapter, fence, [first]);
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: first.effectId,
        claimToken: "claim-1",
        leaseDurationMs: 30_000,
      });

      const baseConfirmation: EffectProjectionConfirmation = {
        physicalSheetId: "physical-1",
        projection: "system_state",
        rowBindingId: "binding-1",
        visibleRevision: 3,
        visibleHash: "visible-hash-3",
        entityRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
        fieldHashes: { name: "field-hash-3" },
      };
      expect(await withSql(adapter, (sql) =>
        applyEffectResultWithSql(sql, {
          ...fence,
          effectId: first.effectId,
          claimToken: "claim-1",
          status: "applied",
          projectionConfirmation: baseConfirmation,
          lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
          lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
        }))).toBe(true);

      // A create-if-missing repair restarted the provider revision at 1, so
      // the confirmation is allowed to advance the durable revision past the
      // confirmed 3 (confirmed + 1) instead of being rejected as a regression.
      const second = newEffect({ rowBindingId: { kind: PRESENCE_KINDS.PRESENT, value: "binding-1" } });
      await appendPendingEffectsWithAdapter(adapter, fence, [second]);
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: second.effectId,
        claimToken: "claim-2",
        leaseDurationMs: 30_000,
      });
      expect(await withSql(adapter, (sql) =>
        applyEffectResultWithSql(sql, {
          ...fence,
          effectId: second.effectId,
          claimToken: "claim-2",
          status: "applied",
          projectionConfirmation: {
            ...baseConfirmation,
            visibleRevision: 1,
            visibleHash: "visible-hash-1",
            fieldHashes: { name: "field-hash-1" },
            allowCreateRebaseline: true,
          },
          lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
          lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
        }))).toBe(true);

      const visible = await adapter.read(({ sql }) =>
        sql.get(
          `SELECT confirmed_snapshot_hash, confirmed_visible_revision
           FROM sheet_visible_state
           WHERE physical_sheet_id = 'physical-1' AND projection = 'system_state' AND row_binding_id = 'binding-1'`,
        ));
      expect(visible).toMatchObject({
        confirmed_snapshot_hash: "visible-hash-1",
        confirmed_visible_revision: 4,
      });
      const field = await adapter.read(({ sql }) =>
        sql.get(
          `SELECT confirmed_field_hash, confirmed_visible_revision
           FROM sheet_visible_field_state
           WHERE physical_sheet_id = 'physical-1' AND projection = 'system_state'
             AND row_binding_id = 'binding-1' AND field_name = 'name'`,
        ));
      expect(field).toMatchObject({
        confirmed_field_hash: "field-hash-1",
        confirmed_visible_revision: 4,
      });
    });

    it("rejects confirmation evidence that does not belong to the claimed effect", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const effect = newEffect();
      await appendPendingEffectsWithAdapter(adapter, fence, [effect]);
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: effect.effectId,
        claimToken: "claim-1",
        leaseDurationMs: 30_000,
      });
      await expect(
        withSql(adapter, (sql) =>
          applyEffectResultWithSql(sql, {
            ...fence,
            effectId: effect.effectId,
            claimToken: "claim-1",
            status: "applied",
            projectionConfirmation: {
              physicalSheetId: "some-other-sheet",
              projection: "system_state",
              rowBindingId: "binding-1",
              visibleRevision: 1,
              visibleHash: "visible-hash-1",
              entityRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
              fieldHashes: {},
            },
            lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
            lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
          })),
      ).rejects.toMatchObject({
        code: STORAGE_ERROR_CODES.INVALID_PROJECTION_CONFIRMATION,
      });
    });
  });

  describe("stream ordering", () => {
    it("keeps head-of-line order within one target stream", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const head = newEffect({ streamSequence: 1, targetId: "entity-1" });
      const tail = newEffect({ streamSequence: 2, targetId: "entity-1" });
      await appendPendingEffectsWithAdapter(adapter, fence, [head, tail]);

      const ready = await withSql(adapter, (sql) => listReadyEffectsWithSql(sql, 10, TEST_NOW));
      expect(ready.map((item) => item.effect_id)).toEqual([head.effectId]);

      // The tail becomes selectable only after the head closes.
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: head.effectId,
        claimToken: "claim-1",
        leaseDurationMs: 30_000,
      });
      await applyEffectResultWithAdapter(adapter, {
        ...fence,
        effectId: head.effectId,
        claimToken: "claim-1",
        status: "applied",
        lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
        lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
      });
      const afterHead = await withSql(adapter, (sql) =>
        listReadyEffectsWithSql(sql, 10, TEST_NOW));
      expect(afterHead.map((item) => item.effect_id)).toEqual([tail.effectId]);
    });

    it("returns pending effects for one target stream in sequence order", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const head = newEffect({ streamSequence: 1, targetId: "entity-9" });
      const tail = newEffect({ streamSequence: 2, targetId: "entity-9" });
      await appendPendingEffectsWithAdapter(adapter, fence, [head, tail]);

      const stream = await withSql(adapter, (sql) =>
        findPendingEffectsByTargetWithSql(sql, "logical-1", "entity", "entity-9"));
      expect(stream.map((item) => item.effect_id)).toEqual([head.effectId]);
    });
  });

  describe("fast-append selection window", () => {
    it("jumps past blocking update rows and respects the bounded window", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);

      // Stream A: an update-shaped head blocks a fast-append tail.
      const updateRow = newEffect({
        effectId: "effect-update",
        effectDedupeKey: "dedupe-update",
        streamSequence: 1,
        targetId: "entity-a",
        expectedVisibleRevision: 4,
        expectedVisibleHash: "visible-hash-4",
      });
      const blockedAppend = newEffect({
        effectId: "effect-blocked-append",
        effectDedupeKey: "dedupe-blocked-append",
        streamSequence: 2,
        targetId: "entity-a",
        expectedVisibleRevision: 0,
        expectedVisibleHash: "",
      });
      // Stream B: three ready fast-append rows on separate target streams
      // (head-of-line allows only one row per stream to be ready at a time).
      const appendOne = newEffect({
        effectId: "effect-append-1",
        effectDedupeKey: "dedupe-append-1",
        targetId: "entity-b1",
        expectedVisibleRevision: 0,
        expectedVisibleHash: "",
      });
      const appendTwo = newEffect({
        effectId: "effect-append-2",
        effectDedupeKey: "dedupe-append-2",
        targetId: "entity-b2",
        expectedVisibleRevision: 0,
        expectedVisibleHash: "",
      });
      const appendThree = newEffect({
        effectId: "effect-append-3",
        effectDedupeKey: "dedupe-append-3",
        targetId: "entity-b3",
        expectedVisibleRevision: 0,
        expectedVisibleHash: "",
      });
      await appendPendingEffectsWithAdapter(adapter, fence, [
        updateRow,
        blockedAppend,
        appendOne,
        appendTwo,
        appendThree,
      ]);

      // Only the three ready fast-append rows are returned, bounded by limit.
      const window = await withSql(adapter, (sql) =>
        listReadyFastAppendEffectsWithSql(sql, 1, TEST_NOW));
      expect(window.map((item) => item.effect_id)).toEqual([appendOne.effectId]);
      const fullWindow = await withSql(adapter, (sql) =>
        listReadyFastAppendEffectsWithSql(sql, 10, TEST_NOW));
      expect(fullWindow.map((item) => item.effect_id)).toEqual([
        appendOne.effectId,
        appendTwo.effectId,
        appendThree.effectId,
      ]);

      // The regular path still surfaces the update head first (followed by
      // the three ready fast-append rows from their own streams); once the
      // update head is applied, the blocked fast-append row enters the
      // fast-append window.
      const regular = await withSql(adapter, (sql) => listReadyEffectsWithSql(sql, 10, TEST_NOW));
      expect(regular.map((item) => item.effect_id)).toEqual([
        updateRow.effectId,
        appendOne.effectId,
        appendTwo.effectId,
        appendThree.effectId,
      ]);
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: updateRow.effectId,
        claimToken: "claim-update",
        leaseDurationMs: 30_000,
      });
      await applyEffectResultWithAdapter(adapter, {
        ...fence,
        effectId: updateRow.effectId,
        claimToken: "claim-update",
        status: "applied",
        lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
        lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
      });
      const afterUpdate = await withSql(adapter, (sql) =>
        listReadyFastAppendEffectsWithSql(sql, 10, TEST_NOW));
      expect(afterUpdate.map((item) => item.effect_id)).toEqual([
        blockedAppend.effectId,
        appendOne.effectId,
        appendTwo.effectId,
        appendThree.effectId,
      ]);
    });
  });

  describe("pending-effect promotion", () => {
    it("decodes a raw outbox row into the closed pending-effect contract", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const effect = newEffect();
      await appendPendingEffectsWithAdapter(adapter, fence, [effect]);
      const ready = await listReadyEffectsWithAdapter(adapter, 10, TEST_NOW);
      expect(ready).toHaveLength(1);
      const pending: PendingEffect = ready[0] as PendingEffect;
      expect(pending.effect_id).toBe(effect.effectId);
      expect(pending.effect_kind).toBe("system_projection");
      expect(pending.target_kind).toBe("entity");
      expect(pending.expected_visible_revision).toBe(0);
      expect(pending.expected_visible_hash).toBe("");
      expect(pending.status).toBe("pending");
      expect(pending.dispatch_id).toBeNull();
    });
  });

  describe("supersede and replan", () => {
    it("closes an old effect and inserts its replacement atomically", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const oldEffect = newEffect({ streamSequence: 1, targetId: "entity-1" });
      await appendPendingEffectsWithAdapter(adapter, fence, [oldEffect]);
      await claimEffectWithAdapter(adapter, {
        ...fence,
        effectId: oldEffect.effectId,
        claimToken: "claim-1",
        leaseDurationMs: 30_000,
      });

      const replacement = newEffect({
        effectId: "effect-replacement",
        effectDedupeKey: "dedupe-replacement",
        streamSequence: 2,
        targetId: "entity-1",
      });
      await withSql(adapter, (sql) =>
        supersedeAndReplanWithSql(sql, fence, oldEffect.effectId, replacement));

      const oldRow = await readOutboxRow(adapter, oldEffect.effectId);
      expect(oldRow?.status).toBe("superseded");
      const newRow = await readOutboxRow(adapter, replacement.effectId);
      expect(newRow?.status).toBe("pending");
      expect(newRow?.predecessor_effect_id).toBe(oldEffect.effectId);

      // The replacement is now the head of its stream and selectable.
      const ready = await withSql(adapter, (sql) => listReadyEffectsWithSql(sql, 10, TEST_NOW));
      expect(ready.map((item) => item.effect_id)).toEqual([replacement.effectId]);
    });
  });

  describe("writer lease kernel", () => {
    it("takes over an expired lease with a higher epoch and fences out the old writer", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter, TEST_NOW, "writer-1");
      const effect = newEffect();
      await appendPendingEffectsWithAdapter(adapter, fence, [effect]);

      // The original writer's fence is still valid until its lease expires.
      const afterExpiry = TEST_NOW + 61_000;
      const takeover = await withSql(adapter, (sql) =>
        claimWriterLeaseWithSql(sql, {
          role: "test-writer",
          writerId: "writer-2",
          leaseDurationMs: 60_000,
          now: afterExpiry,
        }));
      expect(takeover.kind).toBe("claimed");
      if (takeover.kind !== "claimed") throw new Error("expected takeover");
      expect(takeover.lease.writerEpoch).toBe(2);
      expect(takeover.lease.fencingToken).toBe("fence-2:writer-2");

      // Old fencing can no longer enqueue effects.
      const staleOk = await withSql(adapter, (sql) =>
        appendPendingEffectsWithSql(sql, fence, [newEffect()]));
      expect(staleOk).toBe(false);
    });
  });

  describe("writer lease release", () => {
    it("expires the owner's lease so a new writer takes over with epoch + 1", async () => {
      const adapter = createKernelStore();
      const first = await claimWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-1",
        leaseDurationMs: 60_000,
        now: TEST_NOW,
      });
      expect(first.kind).toBe(WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED);
      if (first.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) throw new Error("expected claim");
      expect(first.lease.writerEpoch).toBe(1);

      const released = await releaseWriterLeaseWithAdapter(adapter, {
        role: first.lease.role,
        writerId: first.lease.writerId,
        writerEpoch: first.lease.writerEpoch,
        fencingToken: first.lease.fencingToken,
        now: TEST_NOW,
      });
      expect(released).toBe(true);

      // The next claim funnels into TAKEOVER: same wall-clock now is enough
      // because release expired the row to the release timestamp.
      const next = await claimWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-2",
        leaseDurationMs: 60_000,
        now: TEST_NOW,
      });
      expect(next.kind).toBe(WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED);
      if (next.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) throw new Error("expected takeover");
      expect(next.lease.writerEpoch).toBe(2);
      expect(next.lease.fencingToken).toBe("fence-2:writer-2");
      expect(next.lease.leaseUntil).toBe(TEST_NOW + 60_000);
    });

    it("does not expire a lease owned by a different writer", async () => {
      const adapter = createKernelStore();
      const first = await claimWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-1",
        leaseDurationMs: 60_000,
        now: TEST_NOW,
      });
      expect(first.kind).toBe(WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED);
      if (first.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) throw new Error("expected claim");

      const released = await releaseWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-9",
        writerEpoch: first.lease.writerEpoch,
        fencingToken: first.lease.fencingToken,
        now: TEST_NOW,
      });
      expect(released).toBe(false);

      // The row is untouched: same writer, epoch, and full lease window.
      const lease = await readWriterLeaseWithAdapter(adapter, TEST_ROLE);
      expect(lease.kind).toBe(LOOKUP_RESULT_KINDS.FOUND);
      if (lease.kind !== LOOKUP_RESULT_KINDS.FOUND) throw new Error("expected lease row");
      expect(lease.value.writerId).toBe("writer-1");
      expect(lease.value.writerEpoch).toBe(1);
      expect(lease.value.leaseUntil).toBe(TEST_NOW + 60_000);
    });

    it("does not expire a lease with a stale epoch or fencing token", async () => {
      const adapter = createKernelStore();
      const first = await claimWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-1",
        leaseDurationMs: 60_000,
        now: TEST_NOW,
      });
      expect(first.kind).toBe(WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED);
      if (first.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) throw new Error("expected claim");

      expect(await releaseWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-1",
        writerEpoch: first.lease.writerEpoch + 1,
        fencingToken: first.lease.fencingToken,
        now: TEST_NOW,
      })).toBe(false);
      expect(await releaseWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-1",
        writerEpoch: first.lease.writerEpoch,
        fencingToken: "fence-1:other",
        now: TEST_NOW,
      })).toBe(false);

      const lease = await readWriterLeaseWithAdapter(adapter, TEST_ROLE);
      expect(lease.kind).toBe(LOOKUP_RESULT_KINDS.FOUND);
      if (lease.kind !== LOOKUP_RESULT_KINDS.FOUND) throw new Error("expected lease row");
      expect(lease.value.writerEpoch).toBe(1);
      expect(lease.value.leaseUntil).toBe(TEST_NOW + 60_000);
    });

    it("returns false when no lease row exists", async () => {
      const adapter = createKernelStore();
      const released = await releaseWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-1",
        writerEpoch: 1,
        fencingToken: "fence-1:writer-1",
        now: TEST_NOW,
      });
      expect(released).toBe(false);
    });

    it("keeps epochs strictly increasing across repeated release/reclaim cycles", async () => {
      const adapter = createKernelStore();
      const epochs: number[] = [];
      let writerId = "writer-1";
      for (let cycle = 0; cycle < 4; cycle += 1) {
        const claim = await claimWriterLeaseWithAdapter(adapter, {
          role: TEST_ROLE,
          writerId,
          leaseDurationMs: 60_000,
          now: TEST_NOW,
        });
        expect(claim.kind).toBe(WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED);
        if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) throw new Error("expected claim");
        epochs.push(claim.lease.writerEpoch);
        if (cycle < 3) {
          expect(await releaseWriterLeaseWithAdapter(adapter, {
            role: claim.lease.role,
            writerId: claim.lease.writerId,
            writerEpoch: claim.lease.writerEpoch,
            fencingToken: claim.lease.fencingToken,
            now: TEST_NOW,
          })).toBe(true);
        }
        writerId = writerId === "writer-1" ? "writer-2" : "writer-1";
      }
      // The row is never deleted or reset: every release/reclaim round bumps
      // the epoch exactly once through the TAKEOVER path.
      expect(epochs).toEqual([1, 2, 3, 4]);
    });

    it("sends a same-writer re-claim after release through TAKEOVER instead of resetting", async () => {
      const adapter = createKernelStore();
      const first = await claimWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-1",
        leaseDurationMs: 60_000,
        now: TEST_NOW,
      });
      expect(first.kind).toBe(WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED);
      if (first.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) throw new Error("expected claim");
      expect(await releaseWriterLeaseWithAdapter(adapter, {
        role: first.lease.role,
        writerId: first.lease.writerId,
        writerEpoch: first.lease.writerEpoch,
        fencingToken: first.lease.fencingToken,
        now: TEST_NOW,
      })).toBe(true);

      // The same writer re-claims through TAKEOVER (epoch + 1) because the row
      // still exists; it must never be treated as a fresh INSERT with epoch 1.
      const reclaim = await claimWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-1",
        leaseDurationMs: 60_000,
        now: TEST_NOW,
      });
      expect(reclaim.kind).toBe(WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED);
      if (reclaim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) throw new Error("expected same-writer takeover");
      expect(reclaim.lease.writerEpoch).toBe(2);
      expect(reclaim.lease.fencingToken).toBe("fence-2:writer-1");
    });

    it("rejects invalid release options with INVALID_WRITER_LEASE_OPTIONS", async () => {
      const adapter = createKernelStore();
      const base = {
        role: TEST_ROLE,
        writerId: "writer-1",
        writerEpoch: 1,
        fencingToken: "fence-1:writer-1",
        now: TEST_NOW,
      };
      await expect(releaseWriterLeaseWithAdapter(adapter, {
        ...base, now: -1,
      })).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS });
      await expect(releaseWriterLeaseWithAdapter(adapter, {
        ...base, now: 1.5,
      })).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS });
      await expect(releaseWriterLeaseWithAdapter(adapter, {
        ...base, writerEpoch: 1.5,
      })).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS });
      await expect(releaseWriterLeaseWithAdapter(adapter, {
        ...base, role: "",
      })).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS });
      await expect(releaseWriterLeaseWithAdapter(adapter, {
        ...base, writerId: "",
      })).rejects.toMatchObject({ code: STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS });
    });
  });
});

describe("outbox readiness classifications", () => {
  /** Marks one effect terminal-failed with a NON-recoverable error code. */
  async function failTerminal(adapter: NodeSqliteTestAdapter, effectId: string): Promise<void> {
    await adapter.transaction(async ({ sql }) => {
      await sql.run(
        "UPDATE sheet_effect_outbox SET status = 'failed', last_error_code = ? WHERE effect_id = ?",
        ["delivery_uncertain_timeout", effectId],
      );
    });
  }

  it("classifies normal claimable work as busy and a clean outbox as idle", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await expect(readOutboxScanReadinessWithAdapter(adapter)).resolves.toEqual({ status: "idle" });

    await appendPendingEffectsWithAdapter(adapter, fence, [regularEffect("busy-1")]);
    await expect(readOutboxScanReadinessWithAdapter(adapter)).resolves.toEqual({ status: "busy" });
  });

  it("classifies a terminal failed head with a pending follower as repair-needed, not busy", async () => {
    // The first-scan busy gate must NEVER defer the reconciliation scanner
    // behind a terminal failed head: the scanner is the repair net that
    // supersedes the head, so deferring would wedge the stream forever. A
    // pending follower behind such a head must therefore classify as
    // repair-needed (allowed), never busy.
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const head = regularEffect("repair-head");
    const follower = newEffect({
      effectId: "repair-follower",
      targetId: "entity-repair-head",
      expectedVisibleRevision: 1,
      expectedVisibleHash: "baseline-1",
    });
    await appendPendingEffectsWithAdapter(adapter, fence, [head, follower]);
    await failTerminal(adapter, head.effectId);

    await expect(readOutboxScanReadinessWithAdapter(adapter)).resolves.toEqual({
      status: "repair-needed",
    });
  });

  it("classifies a recoverable failed head as idle, not repair-needed or busy", async () => {
    // A failed head whose error code stays on the worker's own retry path is
    // NOT a terminal wedge: the worker keeps claiming it, so it is neither
    // claimable busy work nor a repair-needed terminal head — the scanner
    // gate allows it either way.
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const head = regularEffect("recoverable-head");
    await appendPendingEffectsWithAdapter(adapter, fence, [head]);
    await adapter.transaction(async ({ sql }) => {
      await sql.run(
        "UPDATE sheet_effect_outbox SET status = 'failed', last_error_code = ? WHERE effect_id = ?",
        [SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_READ_FAILED, head.effectId],
      );
    });

    await expect(readOutboxScanReadinessWithAdapter(adapter)).resolves.toEqual({ status: "idle" });
  });

  it("classifies a pending follower behind a conflict or blocked_candidate head as idle, not busy", async () => {
    // A conflict/blocked_candidate row is a candidate-pipeline lifecycle
    // state, not claimable drain work, and the pending follower behind it is
    // not claimable either: counting that follower as busy would defer the
    // first reconciliation scan forever and suppress the repair that
    // supersedes the lifecycle head. The readiness must be idle so the
    // first scan is allowed without anyone manually releasing the follower.
    for (const status of ["conflict", "blocked_candidate"] as const) {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      const head = newEffect({ effectId: `lifecycle-head-${status}`, targetId: "entity-lifecycle-head" });
      const follower = newEffect({
        effectId: `lifecycle-follower-${status}`,
        targetId: "entity-lifecycle-head",
        expectedVisibleRevision: 1,
        expectedVisibleHash: "baseline-1",
      });
      await appendPendingEffectsWithAdapter(adapter, fence, [head, follower]);
      await adapter.transaction(async ({ sql }) => {
        await sql.run(
          "UPDATE sheet_effect_outbox SET status = ? WHERE effect_id = ?",
          [status, head.effectId],
        );
      });

      await expect(readOutboxScanReadinessWithAdapter(adapter)).resolves.toEqual({ status: "idle" });
      // The follower is still pending but not claimable while its lifecycle
      // predecessor is open — only a scanner repair can advance the stream.
      await expect(
        withSql(adapter, (sql) => listReadyEffectsWithSql(sql, 10, TEST_NOW)),
      ).resolves.toEqual([]);
    }
  });

  it("classifies a failed row with a NULL error code as repair-needed, not busy or idle", async () => {
    // A `failed` row whose last_error_code is NULL must be treated as a
    // terminal failed head: SQL three-valued logic would hide it from
    // `NOT IN`, silently classifying a wedged stream as idle and letting
    // the first-scan gate defer recovery. The scanner must be allowed to
    // supersede the head so the pending follower drains without a manual
    // release.
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const head = regularEffect("null-code-head");
    const follower = newEffect({
      effectId: "null-code-follower",
      targetId: "entity-null-code-head",
      expectedVisibleRevision: 1,
      expectedVisibleHash: "baseline-1",
    });
    await appendPendingEffectsWithAdapter(adapter, fence, [head, follower]);
    await adapter.transaction(async ({ sql }) => {
      await sql.run(
        "UPDATE sheet_effect_outbox SET status = 'failed', last_error_code = NULL WHERE effect_id = ?",
        [head.effectId],
      );
    });

    await expect(readOutboxScanReadinessWithAdapter(adapter)).resolves.toEqual({
      status: "repair-needed",
    });
  });

  it("classifies System_State drain readiness as draining while nonterminal work exists", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await expect(readSystemStateDrainReadinessWithAdapter(adapter)).resolves.toEqual({ status: "ready" });

    await appendPendingEffectsWithAdapter(adapter, fence, [
      newEffect({ effectId: "sys-drain-1", targetId: "entity-sys-drain-1" }),
      newEffect({ effectId: "sys-drain-2", targetId: "entity-sys-drain-2" }),
    ]);
    await expect(readSystemStateDrainReadinessWithAdapter(adapter)).resolves.toEqual({
      status: "draining",
    });

    // Terminal lifecycle states never defer the gate: a failed System_State
    // head and an open conflict must not stall the first polling pass.
    await failTerminal(adapter, "sys-drain-1");
    await adapter.transaction(async ({ sql }) => {
      await sql.run(
        "UPDATE sheet_effect_outbox SET status = 'conflict' WHERE effect_id = ?",
        ["sys-drain-2"],
      );
    });
    await expect(readSystemStateDrainReadinessWithAdapter(adapter)).resolves.toEqual({
      status: "ready",
    });
  });

  it("classifies a pending follower behind a conflict predecessor as ready, not draining", async () => {
    // The System_State drain gate must never defer the first polling pass (or
    // an external convergence barrier) behind a terminal conflict head: the
    // blocked follower is not claimable drain work, so the barrier must be
    // ready even though no worker can claim the stream until a later effect
    // supersedes it. Releasing the head makes the follower claimable again,
    // which flips the classification back to draining.
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const head = newEffect({ effectId: "sys-conflict-head", targetId: "entity-sys-conflict" });
    const follower = newEffect({
      effectId: "sys-conflict-follower",
      targetId: "entity-sys-conflict",
    });
    await appendPendingEffectsWithAdapter(adapter, fence, [head, follower]);
    // Both are pending in one stream: the lower stream row is a claimable
    // head, so the gate is draining.
    await expect(readSystemStateDrainReadinessWithAdapter(adapter)).resolves.toEqual({
      status: "draining",
    });
    // Wedge the stream: the head becomes a terminal conflict, leaving the
    // follower pending and blocked behind it. It is not claimable drain work,
    // so readiness must be ready — never draining.
    await adapter.transaction(({ sql }) =>
      sql.run("UPDATE sheet_effect_outbox SET status = 'conflict' WHERE effect_id = ?", [head.effectId]),
    );
    await expect(readSystemStateDrainReadinessWithAdapter(adapter)).resolves.toEqual({
      status: "ready",
    });
    // Releasing the head makes the follower claimable again: draining.
    await adapter.transaction(({ sql }) =>
      sql.run("UPDATE sheet_effect_outbox SET status = 'superseded' WHERE effect_id = ?", [head.effectId]),
    );
    await expect(readSystemStateDrainReadinessWithAdapter(adapter)).resolves.toEqual({
      status: "draining",
    });
  });

  it("ignores non-System_State effects in the System_State drain classification", async () => {
    // The drain gate is scoped to the System_State projection only: pending
    // work on other projections (User_Input, Sync_Conflicts) must not defer
    // the first polling pass, and pending System_State work must not be
    // masked by the whole-outbox view.
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [
      newEffect({
        effectId: "other-projection-1",
        projection: "user_input",
        targetKind: "row_binding",
        targetId: "row-binding-1",
        expectedVisibleRevision: 1,
        expectedVisibleHash: "baseline-1",
      }),
      newEffect({
        effectId: "other-projection-2",
        projection: "sync_conflicts",
        targetKind: "conflict",
        targetId: "conflict-1",
        expectedVisibleRevision: 0,
        expectedVisibleHash: "",
      }),
    ]);
    await expect(readSystemStateDrainReadinessWithAdapter(adapter)).resolves.toEqual({
      status: "ready",
    });
    await expect(readOutboxScanReadinessWithAdapter(adapter)).resolves.toEqual({ status: "busy" });
  });

  function regularEffect(effectId: string): ReturnType<typeof newEffect> {
    return newEffect({
      effectId,
      targetId: "entity-" + effectId,
      expectedVisibleRevision: 1,
      expectedVisibleHash: "baseline-1",
    });
  }
});
