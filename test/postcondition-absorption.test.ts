/**
 * Phase 4 postcondition absorption (design/unified-read-engine.md §10).
 *
 * A same-route delivery-uncertain recovery head rides the dispatch batch's
 * own reads instead of a standalone probe pass. These tests pin:
 * (1) absorption e2e: one enumeration per coexisting cycle, merged base/verify
 *     evidence, and the head settling applied through the unchanged transitions;
 * (2) redrive timing: absorbed unapplied → +1s requeue, per-target predecessor
 *     ordering preserved, other rows progressing;
 * (3) end-of-queue: an empty queue settles the head through the unchanged
 *     standalone idle-pass probe (D4);
 * (4) cross-route fallback: a probe whose route is not in the batch is NOT
 *     absorbed and keeps the standalone probe path (D1);
 * (5) coverage-unknown: the absorbed gate returns unknown_coverage for the
 *     mid-read memo drop / identity format escalation, and the absorbed
 *     fast-append then decides through exactly ONE full fallback read (D6).
 *
 * All credential-free: stub transport + SQLite/MikroORM fixtures.
 */

import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { APPLICABILITY_KINDS, PRESENCE_KINDS } from "@hikoutei/contracts/state/constants.js";
import { absentValue, presentValue } from "@hikoutei/contracts/state/index.js";
import {
  computeSyncVisibleHash,
  serializeSyncProjectionEffectPayload,
  type FastAppendRow,
  type SyncProjectionEffect,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { SYNC_POSTCONDITION_DISPOSITIONS } from "@hikoutei/contracts/sheets/constants.js";
import {
  appendPendingEffectsWithAdapter,
  claimWriterLeaseWithAdapter,
  runEffectWorkerWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type DispatchRequest,
  type NewEffect,
  type PendingEffect,
  type PostconditionResult,
} from "@hikoutei/ikisaki";
import { SheetsEffectDispatcher } from "@hikoutei/sync-engine/sync/outbound/SheetsEffectDispatcher.js";
import { GoogleSheetsApiSyncProvider } from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import type { GoogleSheetsApiTransport } from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import { GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/preflightFields.js";
import { GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME } from "@hikoutei/sheets/sheets/providers/google-sheets-api/constants.js";
import { absorbedProbePlan } from "@hikoutei/sheets/sheets/providers/google-sheets-api/operations/applyEffects.js";
import { ReceiptReadCursor } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/receiptCursor.js";
import { CoordinatedSheetsProvider } from "@hikoutei/contracts/sheets/mutationCoordinator/CoordinatedSheetsProvider.js";
import { FakeSyncSheetsProvider, type FakeSyncSheetInput } from "./support/FakeSyncSheetsProvider.js";
import type { SqlStorageAdapter } from "@hikoutei/contracts/storage/sql.js";
import type {
  ApplySyncEffectsRequest,
  PreparedApplyEffects,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { MikroOrmSqliteAdapter } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateSqliteSchema } from "@hikoutei/storage/storage/sqlite/migrateSchema.js";
import { StubSheetsTransport, StubSpreadsheet } from "./support/StubSheetsTransport.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";

const EntitySchema = defineEntity({
  name: "AbsorptionEntity",
  tableName: "absorption_entity",
  properties: { id: p.string().primary() },
});
class Entity extends EntitySchema.class {}
EntitySchema.setClass(Entity);

const ORDERS_SHEET_ID = "physical-absorption";
const ARCHIVE_SHEET_ID = "physical-absorption-archive";

const cell = {
  string: (value: string): NormalizedCell => ({ kind: "string", value }),
  bool: (value: boolean): NormalizedCell => ({ kind: "boolean", value }),
  number: (value: number): NormalizedCell => ({ kind: "number", value }),
};

describe("postcondition absorption (Phase 4, design §10)", () => {
  const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

  afterEach(async () => {
    await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
  });

  /**
   * Full stack: durable outbox + fenced worker + real SheetsEffectDispatcher
   * + real Google Sheets provider over the stub transport. Two routes exist
   * (Orders + Archive) so the same-route gate is exercised, not assumed.
   */
  async function setupWorker() {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateSqliteSchema(adapter);
    await registerProjection(adapter);
    await registerArchiveProjection(adapter);

    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Orders", { headers: ["id", "status"] });
    spreadsheet.addTab("Archive", { headers: ["id", "status"] });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: "stub-spreadsheet",
      definitions: [
        definitionFor(ORDERS_SHEET_ID, "Orders"),
        definitionFor(ARCHIVE_SHEET_ID, "Archive"),
      ],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 0,
    });
    const dispatcher = new SheetsEffectDispatcher({ provider, storage: adapter });
    const claim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync-effect-worker",
      writerId: "absorption-worker",
      leaseDurationMs: 600_000,
      now: 10_000,
    });
    if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) throw new Error("Expected a writer lease");
    const fenceAt = (now: number) => ({
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now,
    });
    // A pinned pass clock keeps every fence.now deterministic: the +1s
    // redrive gate is crossed by advancing the PINED value, never by wall
    // sleeps (design §9.4's test-level bound proposal).
    const run = (now: number, maxEffects = 10) => runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "absorption-worker",
      now,
      clock: () => now,
      maxEffects,
    });
    return {
      adapter,
      dispatcher,
      transport,
      spreadsheet,
      fenceAt,
      run,
      status: (effectId: string) => readStatus(adapter, effectId),
      row: (tab: "Orders" | "Archive", rowNumber: number) =>
        stubFields(transport, tab, rowNumber),
    };
  }

  /** Flip an APPLIED row back to a ready recovery head (landed evidence). */
  async function markLandedHead(
    adapter: MikroOrmSqliteAdapter,
    effectId: string,
    uncertainSince: number,
  ): Promise<void> {
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'delivery_uncertain', claim_token = NULL, lease_until = NULL, uncertain_since = ?, next_probe_at = 1 WHERE effect_id = ?",
      [uncertainSince, effectId],
    ));
  }

  function enumerations(transport: StubSheetsTransport, from: number): number {
    return transport.getSpreadsheetRequests.slice(from)
      .filter((request) => request.ranges.length === 0).length;
  }
  function gets(transport: StubSheetsTransport, from: number): number {
    return transport.getSpreadsheetRequests.slice(from).length;
  }

  it("absorbs a same-route landed head into the batch cycle: one enumeration, head settles applied", async () => {
    const t = await setupWorker();
    const head = createEffect("head", 1);
    const batch = createEffect("batch", 1);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(10_000), [head]);

    // Pass 1: the head lands (row + receipt) and completes normally.
    expect(await t.run(10_100)).toMatchObject({ applied: 1 });
    // Then the cycle the absorption targets: the head is flipped back to a
    // ready delivery-uncertain state (landed, unresolved evidence) and a
    // NEW same-route batch effect is enqueued beside it.
    await markLandedHead(t.adapter, head.effectId, 11_100);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(11_000), [batch]);

    const from = t.transport.getSpreadsheetRequests.length;
    const writesBefore = t.transport.batchUpdateCalls;
    const report = await t.run(11_100);

    // The head settled from the BATCH's evidence: applied exactly once more,
    // recorded as a response-loss recovery (the unchanged transition path).
    expect(report).toMatchObject({ claimed: 2, applied: 2, responseLossRecovered: 1, requeued: 0, failed: 0 });
    expect(await t.status(head.effectId)).toBe("applied");
    expect(await t.status(batch.effectId)).toBe("applied");
    // (a) ONE range-less enumeration for the whole cycle: the probe's own
    // standalone enumeration is gone (it would have made this 2).
    expect(enumerations(t.transport, from)).toBe(1);
    // (b) cycle accounting: enumeration + base + merged row-band verification
    // = 3 reads (pre-absorption the coexisting cycle costs 4-5 reads).
    expect(gets(t.transport, from)).toBe(3);
    // (c) the merge is real, not just a count: the head's landed row (row 2)
    // is verified through a probe-target row band riding the BATCH cycle's
    // own reads. A batch-only cycle never requests this band (the append is
    // receipt-verified), and a standalone probe would enumerate again.
    expect(
      t.transport.getSpreadsheetRequests.slice(from).some(
        (request) => request.ranges.includes("'Orders'!A2:B2"),
      ),
    ).toBe(true);
    // The absorbed probe added no write: only the batch's append batchUpdate.
    expect(t.transport.batchUpdateCalls - writesBefore).toBe(1);
  });

  it("absorbs a human-edited head as changed through the unchanged terminal transition", async () => {
    const t = await setupWorker();
    const head = createEffect("edited", 1);
    const batch = createEffect("edited-batch", 1);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(10_000), [head]);
    expect(await t.run(10_100)).toMatchObject({ applied: 1 });
    // Out-of-band human edit of the head's landed row AFTER its receipt was
    // written (the D5 window: the absorbed snapshot now sees `changed`).
    setStubCell(t.spreadsheet, "Orders", 2, 1, cell.string("human-edited"));
    await markLandedHead(t.adapter, head.effectId, 11_100);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(11_000), [batch]);

    const report = await t.run(11_100);
    expect(report).toMatchObject({ applied: 1, failed: 1, responseLossRecovered: 0 });
    expect(await t.status(head.effectId)).toBe("failed");
    expect(await readErrorCode(t.adapter, head.effectId)).toBe("postcondition_changed");
    expect(await t.status(batch.effectId)).toBe("applied");
  });

  it("redrives an absorbed unapplied head on the +1s gate without breaking per-target ordering", async () => {
    const t = await setupWorker();
    // Head never landed (no row, no receipt): the absorbed probe must
    // classify `unapplied` from the provable receipt-band miss.
    const head = createEffect("redrive", 1);
    // Same-target follower: never claimable while the head is unsettled.
    const follower = createFollowerEffect("redrive", ORDERS_SHEET_ID, "Orders");
    // Different-row batch: progresses independently in the SAME cycle.
    const batch = createEffect("redrive-batch", 1);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(10_000), [head, follower]);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(10_500), [batch]);
    await t.adapter.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'delivery_uncertain', claim_token = NULL, lease_until = NULL, uncertain_since = ?, next_probe_at = 1 WHERE effect_id = ?",
      [11_100, head.effectId],
    ));

    const report = await t.run(11_100);
    // Head + batch claimed (the follower is not even ready behind its
    // unsettled predecessor); the absorbed verdict redrives the head.
    expect(report).toMatchObject({ claimed: 2, applied: 1, requeued: 1 });
    expect(await t.status(head.effectId)).toBe("pending");
    const headRow = await t.adapter.read(({ sql }) => sql.get<{ next_attempt_at: number | null }>(
      "SELECT next_attempt_at FROM sheet_effect_outbox WHERE effect_id = ?", [head.effectId],
    ));
    // The +1s redrive gate landed exactly on the pinned clock.
    expect(headRow?.next_attempt_at).toBe(12_100);
    // Ordering: the same-target follower was NOT claimed or written.
    expect(await t.status(follower.effectId)).toBe("pending");
    // The other row progressed in the same cycle.
    expect(await t.status(batch.effectId)).toBe("applied");

    // Pass at +1_100ms: the head redrives and applies; the follower is still
    // not ready (its predecessor is in flight during selection).
    expect(await t.run(12_200)).toMatchObject({ claimed: 1, applied: 1 });
    expect(await t.status(follower.effectId)).toBe("pending");
    // A later pass: the follower claims and applies strictly AFTER its head
    // settled, updating the head-committed row (row 3: the batch effect took
    // row 2 as the earlier append).
    expect(await t.run(12_300)).toMatchObject({ claimed: 1, applied: 1 });
    expect(await t.status(follower.effectId)).toBe("applied");
    expect(await t.row("Orders", 3)).toEqual({ id: "order-redrive", status: "shipped" });
  });

  it("settles an isolated head through the unchanged standalone idle-pass probe (D4)", async () => {
    const t = await setupWorker();
    const head = createEffect("idle", 1);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(10_000), [head]);
    expect(await t.run(10_100)).toMatchObject({ applied: 1 });
    await markLandedHead(t.adapter, head.effectId, 11_100);

    const from = t.transport.getSpreadsheetRequests.length;
    const report = await t.run(11_100);
    // Queue empty: nothing to absorb into, so the pass falls through to the
    // standalone probe exactly as before Phase 4: its OWN enumeration (1).
    expect(report).toMatchObject({ claimed: 1, applied: 1, responseLossRecovered: 1 });
    expect(await t.status(head.effectId)).toBe("applied");
    expect(enumerations(t.transport, from)).toBe(1);
  });

  it("does NOT absorb a cross-route head: the standalone probe still runs it (D1)", async () => {
    const t = await setupWorker();
    const head = createEffect("xroute", 1); // Orders route
    const batch = createEffect("xroute-batch", 1, ARCHIVE_SHEET_ID, "Archive");
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(10_000), [head]);
    expect(await t.run(10_100)).toMatchObject({ applied: 1 });
    await markLandedHead(t.adapter, head.effectId, 11_100);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(11_000), [batch]);

    const from = t.transport.getSpreadsheetRequests.length;
    const report = await t.run(11_100);
    expect(report).toMatchObject({ claimed: 2, applied: 2, responseLossRecovered: 1 });
    expect(await t.status(head.effectId)).toBe("applied");
    // The batch enumerated its OWN route; the cross-route head kept the
    // standalone probe's separate enumeration: TWO enumerations, not one.
    expect(enumerations(t.transport, from)).toBe(2);
  });

  it("falls back when a SUCCESS envelope omits probeResults entirely (standalone probe still settles)", async () => {
    const t = await setupWorker();
    const head = createEffect("fallback", 1);
    const batch = createEffect("fallback-batch", 1);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(10_000), [head]);
    expect(await t.run(10_100)).toMatchObject({ applied: 1 });
    await markLandedHead(t.adapter, head.effectId, 11_100);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(11_000), [batch]);
    // Simulate a dispatcher/provider that absorbed nothing: the write and its
    // per-effect results SUCCEED, the envelope simply carries no probeResults
    // (older dispatcher, fake dispatcher, or a non-absorbing provider).
    omitProbeResults(t.dispatcher, () => true);
    const from = t.transport.getSpreadsheetRequests.length;
    const report = await t.run(11_100);
    // The head is NOT deferred on the missing envelope: the standalone
    // end-of-pass probe still settles it from durable evidence.
    expect(await t.status(head.effectId)).toBe("applied");
    expect(await t.status(batch.effectId)).toBe("applied");
    expect(report.responseLossRecovered).toBe(1);
    // Batch cycle + the head's own standalone probe enumeration = 2.
    expect(enumerations(t.transport, from)).toBe(2);
  });

  it("falls back per-effect on a PARTIAL probeResults envelope (omitted entry probes standalone)", async () => {
    const t = await setupWorker();
    const headA = createEffect("partial-a", 1);
    const headB = createEffect("partial-b", 1);
    const batch = createEffect("partial-batch", 1);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(10_000), [headA, headB]);
    expect(await t.run(10_100)).toMatchObject({ applied: 2 });
    await markLandedHead(t.adapter, headA.effectId, 11_100);
    await markLandedHead(t.adapter, headB.effectId, 11_100);
    await appendPendingEffectsWithAdapter(t.adapter, t.fenceAt(11_000), [batch]);
    // The absorbed envelope returns headA's verdict but omits headB's entry
    // (a partial provider envelope). headA must settle from the absorbed
    // evidence; headB must keep the standalone fallback, NOT be deferred as
    // a contract gap on the partial evidence.
    omitProbeResults(t.dispatcher, (effectId) => effectId === headB.effectId);
    const from = t.transport.getSpreadsheetRequests.length;
    const report = await t.run(11_100);
    expect(await t.status(headA.effectId)).toBe("applied");
    expect(await t.status(headB.effectId)).toBe("applied");
    expect(await t.status(batch.effectId)).toBe("applied");
    // A broken partial fallback would leave headB delivery_uncertain with a
    // postcondition_read_failed defer marker and never probe it standalone.
    expect(await readErrorCode(t.adapter, headB.effectId)).toBeNull();
    expect(report).toMatchObject({ applied: 3, responseLossRecovered: 2, deferred: 0, failed: 0 });
    // Batch cycle (settles headA) + headB's standalone probe = 2 enumerations.
    expect(enumerations(t.transport, from)).toBe(2);
  });
});

describe("absorbed-probe preflight lane serialization (D1)", () => {
  const LANE_SHEET = "physical-absorption-lane";

  /** Fake worker provider that records each split preflight call's probe load. */
  class PreflightRecorderProvider extends FakeSyncSheetsProvider {
    public readonly preflightCalls: { readonly probes: number }[] = [];

    public async preflightApplyEffects(
      request: ApplySyncEffectsRequest,
    ): Promise<PreparedApplyEffects> {
      this.preflightCalls.push({ probes: request.probeEffects?.length ?? 0 });
      return { kind: "single", request };
    }

    public async applyPreparedEffects(
      prepared: PreparedApplyEffects,
    ): Promise<Awaited<ReturnType<FakeSyncSheetsProvider["applyEffects"]>>> {
      if (prepared.kind !== "single") throw new Error("unexpected prepared state");
      return this.applyEffects(prepared.request);
    }
  }

  function pending(effectId: string): PendingEffect {
    const fields = { id: cell.string(`order-${effectId}`), status: cell.string("paid") };
    return {
      effect_id: `effect-${effectId}` as PendingEffect["effect_id"],
      effect_kind: "system_projection",
      commit_id: `commit-${effectId}`,
      logical_sheet_id: "logical-absorption",
      physical_sheet_id: LANE_SHEET as PendingEffect["physical_sheet_id"],
      projection: "system_state",
      row_binding_id: null,
      conflict_id: null,
      target_kind: "entity",
      target_id: `order-${effectId}`,
      target_entity_revision: 1,
      target_field_revision_hash: null,
      target_canonical_commit_id: null,
      expected_visible_revision: 0,
      expected_visible_hash: "",
      repair_guard_hash: null,
      source_quarantine_id: null,
      payload_json: serializeSyncProjectionEffectPayload({
        sheetName: "Orders",
        registeredRange: "A:B",
        schemaVersion: 1,
        targetAnchor: `${effectId}-anchor`,
        fields,
        targetVisibleHash: computeSyncVisibleHash(fields),
        createIfMissing: true,
        expectedCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
      }),
      payload_hash: `payload-${effectId}` as PendingEffect["payload_hash"],
      effect_dedupe_key: `dedupe-${effectId}` as PendingEffect["effect_dedupe_key"],
      stream_sequence: 1,
      created_at: 10_000,
      next_attempt_at: 10_000,
      uncertain_since: null,
      next_probe_at: null,
      dispatch_id: null,
      status: "pending",
    };
  }

  const LANE_ONLY_STORAGE: SqlStorageAdapter = {
    read: async () => { throw new Error("preflight must not touch storage"); },
    transaction: async () => { throw new Error("preflight must not touch storage"); },
  } as unknown as SqlStorageAdapter;

  const laneSheetInput: FakeSyncSheetInput = {
    physicalSheetId: LANE_SHEET,
    sheetName: "Orders",
    registeredRange: "A:B",
    projection: "system_state",
    schemaVersion: 1,
    headers: ["id", "status"],
    identityField: "id",
  };

  it("holds a probe-riding preflight behind an in-flight same-route write, and keeps a probeless preflight lock-free", async () => {
    const inner = new PreflightRecorderProvider([laneSheetInput]);
    const coordinator = new CoordinatedSheetsProvider({ inner });
    const dispatcher = new SheetsEffectDispatcher({ provider: coordinator, storage: LANE_ONLY_STORAGE });
    const head = pending("lane-head");
    const batch = pending("lane-batch");

    // Simulate another worker's same-route write holding the mutation lane.
    let releaseHold: () => void = () => {};
    const hold = coordinator.runSerializedInner(
      LANE_SHEET,
      "test-in-flight-write",
      () => new Promise<void>((resolve) => { releaseHold = resolve; }),
    );

    // A probeless preflight stays lock-free (the read-ahead pipeline depends
    // on overlapping another route's write), even while this route's lane is
    // held.
    const plainRequest: DispatchRequest = {
      routeKey: dispatcher.routeKeyFor(batch),
      effects: [batch],
    };
    const plain = await dispatcher.preflight(plainRequest);
    expect(plain).toBeDefined();
    expect(inner.preflightCalls).toEqual([{ probes: 0 }]);

    // A probe-riding preflight must NOT read while the same-route lane is
    // held: design §10.3 D1 forbids a same-route probe read interleaving with
    // an in-flight same-route write (own-write false `changed` verdicts).
    const probeRequest: DispatchRequest = {
      routeKey: dispatcher.routeKeyFor(batch),
      effects: [batch],
      probeEffects: [head],
    };
    const absorbed = dispatcher.preflight(probeRequest);
    await new Promise((resolve) => setImmediate(resolve));
    expect(inner.preflightCalls).toEqual([{ probes: 0 }]); // still queued on the lane

    releaseHold();
    await hold;
    expect((await absorbed)).toBeDefined();
    expect(inner.preflightCalls).toEqual([{ probes: 0 }, { probes: 1 }]);
  });

  it("leaves preflight lock-free on a provider without a mutation lane (bare provider parity)", async () => {
    const inner = new PreflightRecorderProvider([laneSheetInput]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: LANE_ONLY_STORAGE });
    const batch = pending("bare-batch");
    const head = pending("bare-head");
    const prepared = await dispatcher.preflight({
      routeKey: dispatcher.routeKeyFor(batch),
      effects: [batch],
      probeEffects: [head],
    });
    // A bare provider exposes no lane to serialize on (parity with the
    // standalone probe on such providers); the probe-riding preflight reads
    // directly instead of failing closed.
    expect(prepared).toBeDefined();
    expect(inner.preflightCalls).toEqual([{ probes: 1 }]);
  });
});

describe("absorbed-probe evidence gate (D6, unit)", () => {
  const cursorHarness = () => {
    const cursor = new ReceiptReadCursor();
    const deps = { receiptReadCursor: cursor } as never;
    return { cursor, deps };
  };
  const located = { rowNumber: 2, physicalAnchor: absentValue(), identity: presentValue("u1"), cells: {} };
  const probeEffect = {
    effectId: "effect-1",
    payloadHash: "payload-1",
    physicalSheetId: "physical-absorption",
    projection: "system_state",
    targetId: "entity:users:u1",
    payload: {
      sheetName: "Orders",
      registeredRange: "A:B",
      schemaVersion: 1,
      targetAnchor: "anchor-1",
      fields: { id: cell.string("u1"), status: cell.string("written") },
      targetVisibleHash: "hash",
      createIfMissing: true,
    },
  } as unknown as SyncProjectionEffect;

  it("cold cursor proves a miss; a live cursor proves coverage; a mid-read drop is unknown", async () => {
    const { cursor, deps } = cursorHarness();
    const context = {
      rows: [located], identityNeedsFormatEvidence: false, receipts: new Map(),
    } as never;
    // Cold pre-read (the batch read performs the full receipt parse).
    expect(absorbedProbePlan(deps, false, [{ context, effects: [probeEffect] }])).toEqual({
      status: "bands", targetRowNumbers: [[2]],
    });
    // Live before AND after the batch read: still covered (memo + sentinel).
    cursor.advanceTo(9);
    expect(absorbedProbePlan(deps, true, [{ context, effects: [probeEffect] }]).status).toBe("bands");
    // Live before, GONE after (mid-read memo over-capacity drop): the miss is
    // no longer provable → full fallback / standalone, never a band decision.
    cursor.reset();
    expect(absorbedProbePlan(deps, true, [{ context, effects: [probeEffect] }]).status)
      .toBe("unknown_coverage");
    // With the probe's own receipt present the decision is positive evidence,
    // so the band decides even under the dropped memo.
    cursor.reset();
    const withReceipt = {
      rows: [located], identityNeedsFormatEvidence: false,
      receipts: new Map([["effect-1", { payloadHash: "payload-1" }]]),
    } as never;
    expect(absorbedProbePlan(deps, true, [{ context: withReceipt, effects: [probeEffect] }]).status)
      .toBe("bands");
  });

  it("format-ambiguous identity evidence forces the whole-table decision", () => {
    const { deps } = cursorHarness();
    const context = {
      rows: [located], identityNeedsFormatEvidence: true, receipts: new Map(),
    } as never;
    expect(absorbedProbePlan(deps, false, [{ context, effects: [probeEffect] }]).status)
      .toBe("unknown_coverage");
  });
});

describe("absorbed fast-append fallback read (D6/D7, provider e2e)", () => {
  it("decides a format-ambiguous probe through exactly ONE full fallback read", async () => {
    const spreadsheet = new StubSpreadsheet();
    // Row 2 carries a NUMBER identity cell: the values-only scoped base read
    // defers its identity evidence, which puts the absorbed probe into the
    // coverage-unknown branch even under complete receipt coverage.
    spreadsheet.addTab("Users_System", {
      headers: ["id", "status", "__typed_sheets_deleted"],
      rows: [[cell.number(45000), cell.string("written"), cell.bool(false)]],
    });
    const targetCells = {
      id: cell.number(45000), status: cell.string("written"), __typed_sheets_deleted: cell.bool(false),
    };
    spreadsheet.addTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME, {
      headers: ["effectId", "payloadHash", "status", "visibleHash", "visibleRevision", "updatedAt"],
      rows: [["probe-1", "payload-probe", "applied", computeSyncVisibleHash(targetCells), 2, "2024-01-01T00:00:00.000Z"]],
      hidden: true,
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: "stub-spreadsheet",
      definitions: [definitionFor("entity:users:system_state", "Users_System", ["id", "status", "__typed_sheets_deleted"], "A:C")],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 0,
    });
    // Warm the receipt cursor so the absorption dispatch's base read is the
    // BANDED one (a cold base read would legitimately full-parse inside it).
    await provider.fastAppendRows(appendRequest("warm", "entity:users:system_state", "Users_System"));
    const from = transport.getSpreadsheetRequests.length;
    const response = await provider.fastAppendRows({
      ...appendRequest("fresh", "entity:users:system_state", "Users_System"),
      probeEffects: [probeEffect("probe-1", targetCells)],
    });
    expect(response.results[0]?.status).toBe("applied");
    expect(response.probeResults?.[0]?.postcondition.disposition)
      .toBe(SYNC_POSTCONDITION_DISPOSITIONS.APPLIED);
    const window = transport.getSpreadsheetRequests.slice(from);
    expect(window.filter((request) => request.ranges.length === 0)).toHaveLength(1);
    // ONE full-evidence fallback read (full-mask fields + the cursor-less
    // whole-tab receipt range), covering the probe decision.
    const fallback = window.filter((request) =>
      request.fields !== GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS &&
      request.ranges.some((range) => range.includes(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)));
    expect(fallback).toHaveLength(1);
  });
});

function appendRequest(prefix: string, physicalSheetId: string, sheetName: string) {
  const identity = `${prefix}-0000`;
  const rows: FastAppendRow[] = [{
    effectId: `append-${identity}`,
    payloadHash: `payload-${identity}`,
    anchor: `anchor-${identity}`,
    fields: {
      id: cell.string(identity),
      status: cell.string("pending"),
      __typed_sheets_deleted: cell.bool(false),
    },
  }];
  return {
    physicalSheetId,
    sheetName,
    registeredRange: "A:C",
    projection: "system_state" as const,
    schemaVersion: 1,
    rows,
  };
}

function probeEffect(effectId: string, fields: Readonly<Record<string, NormalizedCell>>): SyncProjectionEffect {
  return {
    effectId,
    payloadHash: effectId === "probe-1" ? "payload-probe" : `payload-${effectId}`,
    effectKind: "system_projection",
    physicalSheetId: "entity:users:system_state",
    projection: "system_state",
    targetKind: "entity",
    // The trailing segment of the target id is the visible identity the
    // probe locates by (the numeric id cell normalizes to "45000").
    targetId: "entity:users:45000",
    rowBindingId: absentValue(),
    conflictId: absentValue(),
    expectedVisibleRevision: 1,
    expectedVisibleHash: computeSyncVisibleHash(fields),
    repairGuardHash: absentValue(),
    payload: {
      sheetName: "Users_System",
      registeredRange: "A:C",
      schemaVersion: 1,
      targetAnchor: `anchor-${effectId}`,
      fields,
      targetVisibleHash: computeSyncVisibleHash(fields),
      createIfMissing: false,
      expectedCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    },
  };
}

/**
 * Wraps one dispatcher's success path so `probeResults` entries matching the
 * predicate are dropped from the returned envelope: `() => true` simulates a
 * dispatcher that absorbed nothing at all, and an id-matching predicate
 * simulates a PARTIAL absorption envelope. The writes and per-effect results
 * stay successful — only the probe evidence is omitted, exactly the shape
 * the worker's residual-fallback contract must survive.
 */
function omitProbeResults(
  dispatcher: SheetsEffectDispatcher,
  omit: (effectId: string) => boolean,
): void {
  const mask = <T extends { probeResults?: readonly PostconditionResult[] }>(
    outcome: T,
  ): T => outcome.probeResults === undefined
    ? outcome
    : { ...outcome, probeResults: outcome.probeResults.filter((result) => !omit(result.effectId)) };
  const fastAppend = dispatcher.fastAppend.bind(dispatcher);
  const apply = dispatcher.apply.bind(dispatcher);
  const applyPrepared = dispatcher.applyPrepared.bind(dispatcher);
  dispatcher.fastAppend = async (request) => mask(await fastAppend(request));
  dispatcher.apply = async (request) => mask(await apply(request));
  dispatcher.applyPrepared = async (request, prepared) => mask(await applyPrepared(request, prepared));
}

function definitionFor(
  physicalSheetId: string,
  tabName: string,
  headers: readonly string[] = ["id", "status"],
  registeredRange = "A:B",
): RegisteredSyncProjectionDefinition {
  return {
    sheet: {
      logicalSheetId: "logical-absorption",
      physicalSheetId,
      spreadsheetId: "stub-spreadsheet",
      tabName,
      registeredRange,
      projection: "system_state",
      schemaVersion: 1,
      ownershipManifestJson: "{}",
      businessKeyField: "id",
      anchorMode: "business_key",
    },
    headers: [...headers],
  };
}

async function createOrm() {
  const orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ":memory:",
    driverOptions: new NodeSqliteDialect(":memory:"),
    entities: [Entity],
  });
  await orm.schema.create();
  return orm;
}

async function registerProjection(adapter: MikroOrmSqliteAdapter): Promise<void> {
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-absorption", 1, "{}", "id"],
    );
    await sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [ORDERS_SHEET_ID, "logical-absorption", "stub-spreadsheet", "Orders", "A:B", "system_state", 1],
    );
  });
}

async function registerArchiveProjection(adapter: MikroOrmSqliteAdapter): Promise<void> {
  await adapter.transaction(({ sql }) => sql.run(
    "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [ARCHIVE_SHEET_ID, "logical-absorption", "stub-spreadsheet", "Archive", "A:B", "system_state", 1],
  ));
}

function createEffect(
  suffix: string,
  streamSequence = 1,
  physicalSheetId = ORDERS_SHEET_ID,
  sheetName = "Orders",
): NewEffect {
  const targetId = `order-${suffix}`;
  const fields = {
    id: cell.string(targetId),
    status: cell.string("paid"),
  };
  return {
    effectId: `effect-${suffix}`,
    effectKind: "system_projection",
    commitId: `commit-${suffix}`,
    logicalSheetId: "logical-absorption",
    physicalSheetId,
    projection: "system_state",
    rowBindingId: { kind: PRESENCE_KINDS.ABSENT },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    targetKind: "entity",
    targetId,
    targetEntityRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: 1 },
    targetFieldRevisionHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    targetCanonicalCommitId: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    expectedVisibleRevision: 0,
    expectedVisibleHash: "",
    repairGuardHash: { kind: PRESENCE_KINDS.ABSENT },
    sourceQuarantineId: { kind: PRESENCE_KINDS.ABSENT },
    payloadJson: serializeSyncProjectionEffectPayload({
      sheetName,
      registeredRange: "A:B",
      schemaVersion: 1,
      targetAnchor: `${suffix}-anchor`,
      fields,
      targetVisibleHash: computeSyncVisibleHash(fields),
      createIfMissing: true,
      expectedCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    }),
    payloadHash: `payload-${suffix}`,
    effectDedupeKey: `dedupe-${suffix}`,
    streamSequence,
  };
}

function createFollowerEffect(
  suffix: string,
  physicalSheetId = ORDERS_SHEET_ID,
  sheetName = "Orders",
): NewEffect {
  const targetId = `order-${suffix}`;
  const committed = { id: cell.string(targetId), status: cell.string("paid") };
  const next = { id: cell.string(targetId), status: cell.string("shipped") };
  return {
    effectId: `effect-${suffix}-follower`,
    effectKind: "system_projection",
    commitId: `commit-${suffix}-follower`,
    logicalSheetId: "logical-absorption",
    physicalSheetId,
    projection: "system_state",
    rowBindingId: { kind: PRESENCE_KINDS.ABSENT },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    targetKind: "entity",
    targetId,
    targetEntityRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: 2 },
    targetFieldRevisionHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    targetCanonicalCommitId: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    expectedVisibleRevision: 1,
    expectedVisibleHash: computeSyncVisibleHash(committed),
    repairGuardHash: { kind: PRESENCE_KINDS.ABSENT },
    sourceQuarantineId: { kind: PRESENCE_KINDS.ABSENT },
    payloadJson: serializeSyncProjectionEffectPayload({
      sheetName,
      registeredRange: "A:B",
      schemaVersion: 1,
      targetAnchor: `${suffix}-anchor`,
      fields: next,
      targetVisibleHash: computeSyncVisibleHash(next),
      createIfMissing: false,
      expectedCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    }),
    payloadHash: `payload-${suffix}-follower`,
    effectDedupeKey: `dedupe-${suffix}-follower`,
    streamSequence: 2,
  };
}

async function readStatus(adapter: MikroOrmSqliteAdapter, effectId: string): Promise<string | undefined> {
  const row = await adapter.read(({ sql }) => sql.get<{ status: string }>(
    "SELECT status FROM sheet_effect_outbox WHERE effect_id = ?", [effectId],
  ));
  return row?.status;
}

async function readErrorCode(adapter: MikroOrmSqliteAdapter, effectId: string): Promise<string | null | undefined> {
  const row = await adapter.read(({ sql }) => sql.get<{ last_error_code: string | null }>(
    "SELECT last_error_code FROM sheet_effect_outbox WHERE effect_id = ?", [effectId],
  ));
  return row?.last_error_code;
}

/** Reads one stub tab row's [id, status] string fields (absolute 1-based row). */
async function stubFields(
  transport: StubSheetsTransport,
  tab: "Orders" | "Archive",
  rowNumber: number,
): Promise<Record<string, string | null>> {
  const sheet = transport.spreadsheet.findTab(tab);
  const read = (column: number) => {
    const value = sheet?.cells.get(`${String(rowNumber - 1)},${String(column)}`)?.userEnteredValue;
    return value?.stringValue ?? (value?.numberValue === undefined ? null : String(value.numberValue));
  };
  return { id: read(0), status: read(1) };
}

function setStubCell(
  spreadsheet: StubSpreadsheet,
  tab: string,
  rowNumber: number,
  column: number,
  value: NormalizedCell,
): void {
  const sheet = spreadsheet.findTab(tab);
  if (sheet === undefined) throw new Error(`missing tab ${tab}`);
  if (value === null || value.kind === "date") throw new Error("setStubCell needs a scalar cell");
  const wire = value.kind === "string"
    ? { userEnteredValue: { stringValue: value.value }, effectiveValue: { stringValue: value.value } }
    : value.kind === "boolean"
      ? { userEnteredValue: { boolValue: value.value }, effectiveValue: { boolValue: value.value } }
      : { userEnteredValue: { numberValue: value.value }, effectiveValue: { numberValue: value.value } };
  // Stub cell keys are 0-based; `rowNumber` is the absolute 1-based row.
  sheet.cells.set(`${String(rowNumber - 1)},${String(column)}`, wire);
}
