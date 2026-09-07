/**
 * Keyset-pagination parity for the System_State reconciliation scan (#503).
 *
 * Phase 0 baseline: a large deterministic fixture (tens of thousands of
 * active entities with several fields each, active row bindings, seeded
 * outbox effects) exercised through one `runReconciliationScan`. The
 * repair-decision set (report + full outbox dump) is captured as a golden
 * file; the chunked implementation must reproduce it byte-identically.
 *
 * Regenerate goldens with UPDATE_GOLDENS=1. Never commit a regenerated
 * golden without diffing it: any change means scan behavior changed.
 */

import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FakeSyncSheetsProvider } from "./support/FakeSyncSheetsProvider.js";
import { MikroOrmSqliteAdapter } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateSqliteSchema } from "@hikoutei/storage/storage/sqlite/migrateSchema.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import type {
  SqlExecutor,
  SqlParameter,
  SqlStorageAdapter,
} from "@hikoutei/contracts/storage/sql.js";
import {
  assembleDesiredChunk,
  flushDesiredCarry,
  readDesiredSystemStateWithSql,
  readReconciliationDesiredSystemStateChunkWithSql,
  type PartialDesiredRow,
} from "@hikoutei/sync-engine/sync/outbound/reconciliation/shared.js";
import { runReconciliationScan } from "@hikoutei/sync-engine/sync/outbound/reconciliation/ReconciliationScanner.js";
import {
  appendPendingEffectsWithAdapter,
  claimWriterLeaseWithAdapter,
  SYNC_EFFECT_RECOVERY_ERROR_CODES,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
} from "@hikoutei/ikisaki";
import { createSystemProjectionEffect } from "@hikoutei/storage/sync/outbound/projection/ProjectionEffectFactory.js";

const EntitySchema = defineEntity({
  name: "ReconParityEntity",
  tableName: "recon_parity_entity",
  properties: { id: p.string().primary() },
});

class Entity extends EntitySchema.class {}

EntitySchema.setClass(Entity);

const SYSTEM_HEADERS = ["id", "status", "note", "flag"] as const;
/** Large enough to force dozens of 1000-row chunks (4 fields per entity). */
export const PARITY_ENTITY_COUNT = 20_000;

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "scan-parity",
  "reconciliation-golden.json",
);

describe("reconciliation scan pagination", () => {
  it("reproduces the golden full-load repair decisions on the large fixture", async () => {
    const { adapter, provider } = await bootstrapLarge();
    try {
      const ids = counter();
      const report = await runReconciliationScan({
        storage: adapter,
        provider,
        physicalSheetId: "physical-recon",
        logicalSheetId: "logical-recon",
        systemFields: [...SYSTEM_HEADERS],
        schemaVersion: 1,
        writerId: "reconciler",
        now: () => 5_000,
        createId: ids,
      });
      const golden = { report, outbox: await dumpOutbox(adapter) };
      if (process.env.UPDATE_GOLDENS === "1") {
        mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
        writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 2) + "\n");
        return;
      }
      const expected = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as unknown;
      expect(golden).toEqual(expected);
    } finally {
      await adapter.close(true);
    }
  }, 240_000);

  it("bounds every canonical read to the entity page size (peak scan memory is O(chunk))", async () => {
    const { adapter, provider } = await bootstrapLarge();
    try {
      const { adapter: watched, sizes } = watchAllSizes(adapter);
      await runReconciliationScan({
        storage: watched,
        provider,
        physicalSheetId: "physical-recon",
        logicalSheetId: "logical-recon",
        systemFields: [...SYSTEM_HEADERS],
        schemaVersion: 1,
        writerId: "reconciler",
        now: () => 5_000,
        createId: counter(),
      });
      // 20k entities / 250 per entity page = 80 full pages; per-entity
      // binding/field fetches are a handful of rows each. No read ever
      // materializes more than one page, so peak scan memory stays flat as
      // the table grows. (The provider snapshot is outside the scan's
      // control and intentionally not measured here.)
      expect(Math.max(...sizes)).toBeLessThanOrEqual(250);
      expect(sizes.filter((size) => size === 250).length).toBeGreaterThanOrEqual(79);
    } finally {
      await adapter.close(true);
    }
  }, 240_000);

  it("handles empty tables, a single row, and mid-entity chunk splits", async () => {
    const { adapter } = await bootstrapSmall([
      { entityId: "e1", fields: { id: "a", status: "x", note: "n", flag: "f" } },
      { entityId: "e2", fields: { id: "b", status: "y" } },
      { entityId: "e3", fields: { id: "c", status: "z", note: "m" } },
    ]);
    try {
      const context = { logicalSheetId: "logical-recon", tombstoneField: "_deleted" as string | undefined };
      const full = await adapter.read(({ sql }) =>
        readDesiredSystemStateWithSql(sql, context),
      );
      // Entity-batched pages hold whole entities, so limits 1 and 2 split
      // between entities and reproduce the full-load grouping exactly.
      for (const limit of [1, 2, 1_000]) {
        await expect(assemblePaged(adapter, limit, context.tombstoneField)).resolves.toEqual(full);
      }
      // Without a tombstone field the default is not injected by either path.
      const fullBare = await adapter.read(({ sql }) =>
        readDesiredSystemStateWithSql(sql, { logicalSheetId: "logical-recon", tombstoneField: undefined }),
      );
      expect(fullBare.every((row) => row.fields._deleted === undefined)).toBe(true);
      await expect(assemblePaged(adapter, 2, undefined)).resolves.toEqual(fullBare);
    } finally {
      await adapter.close(true);
    }
  });

  it("reads nothing from empty tables", async () => {
    const { adapter } = await bootstrapSmall([]);
    try {
      const chunk = await adapter.read(({ sql }) =>
        readReconciliationDesiredSystemStateChunkWithSql(sql, "logical-recon", undefined),
      );
      expect(chunk).toEqual({ rows: [], entityCount: 0, lastEntityId: undefined });
      const assembled = assembleDesiredChunk(chunk.rows, undefined, "_deleted");
      expect(assembled.completed).toEqual([]);
      expect(flushDesiredCarry(assembled.carry, "_deleted")).toBeUndefined();
    } finally {
      await adapter.close(true);
    }
  });

  it("keeps every binding's fields for multi-binding entities", async () => {
    const { adapter } = await bootstrapSmall([
      { entityId: "e1", fields: { id: "a", status: "x", note: "n", flag: "f" } },
    ]);
    try {
      // A second active binding on the same entity: a flat (entity, field)
      // cursor would skip the second binding's rows at page boundaries.
      // Whole-entity chunks cannot split bindings, so both survive.
      await adapter.transaction(async ({ sql }) => {
        await sql.run(
          "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, entity_id, state) VALUES (?, ?, ?, ?, ?)",
          ["bind-e1-second", "logical-recon", "anchor-e1-second", "e1", "active"],
        );
      });
      const context = { logicalSheetId: "logical-recon", tombstoneField: "_deleted" as string | undefined };
      const full = await adapter.read(({ sql }) =>
        readDesiredSystemStateWithSql(sql, context),
      );
      // Both bindings' rows are present in the chunked reads...
      const chunked = await assemblePaged(adapter, 1, context.tombstoneField);
      const bindingIds = new Set(
        (await adapter.read(({ sql }) =>
          readReconciliationDesiredSystemStateChunkWithSql(sql, "logical-recon", undefined),
        )).rows.map((row) => row.rowBindingId),
      );
      expect(bindingIds).toEqual(new Set(["bind-e1", "bind-e1-second"]));
      // ...and the assembled desired rows match the full-load grouping.
      expect(chunked).toEqual(full);
    } finally {
      await adapter.close(true);
    }
  });

  it("skips binding-less entities while advancing the cursor", async () => {
    const { adapter } = await bootstrapSmall([
      { entityId: "e1", fields: { id: "a" } },
    ]);
    try {
      // An active entity with no binding contributes no rows (inner-join
      // semantics) but must still advance the cursor past itself, or the
      // scan would re-read it forever.
      await adapter.transaction(async ({ sql }) => {
        await sql.run("DELETE FROM row_binding WHERE entity_id = ?", ["e1"]);
      });
      const first = await adapter.read(({ sql }) =>
        readReconciliationDesiredSystemStateChunkWithSql(sql, "logical-recon", undefined),
      );
      expect(first.rows).toEqual([]);
      expect(first.entityCount).toBe(1);
      expect(first.lastEntityId).toBe("e1");
      const second = await adapter.read(({ sql }) =>
        readReconciliationDesiredSystemStateChunkWithSql(sql, "logical-recon", { entityId: "e1" }),
      );
      expect(second.entityCount).toBe(0);
      const assembled = await assemblePaged(adapter, 250, "_deleted");
      expect(assembled).toEqual([]);
    } finally {
      await adapter.close(true);
    }
  });

  it("serves entity-batched pages from bounded index seeks (no temp sort)", async () => {
    const { adapter } = await bootstrapSmall([
      { entityId: "e1", fields: { id: "a" } },
    ]);
    try {
      await adapter.read(async ({ sql }) => {
        const plans = await sql.all<{ readonly detail: string }>(`
          EXPLAIN QUERY PLAN SELECT entity_id, entity_revision FROM entity_state
          WHERE status = 'active' AND entity_id > 'e' ORDER BY entity_id LIMIT 250
        `, []);
        const fields = await sql.all<{ readonly detail: string }>(`
          EXPLAIN QUERY PLAN SELECT field_name, normalized_value, ownership
          FROM entity_field_state WHERE entity_id = 'e' ORDER BY field_name
        `, []);
        const bindings = await sql.all<{ readonly detail: string }>(`
          EXPLAIN QUERY PLAN SELECT row_binding_id, anchor_reference FROM row_binding
          WHERE logical_sheet_id = 'L' AND entity_id = 'e' AND state = 'active'
          ORDER BY row_binding_id
        `, []);
        const userFields = await sql.all<{ readonly detail: string }>(`
          EXPLAIN QUERY PLAN SELECT field_name, normalized_value, ownership
          FROM entity_field_state WHERE entity_id = 'e' AND ownership = 'user'
          ORDER BY field_name
        `, []);
        // Every page is an index seek; a temp b-tree sort would make the
        // per-page cost O(remaining rows) and the scan O(N^2) overall.
        for (const plan of [...plans, ...fields, ...userFields, ...bindings]) {
          expect(plan.detail).not.toContain("TEMP B-TREE");
        }
        expect(plans.some((plan) => plan.detail.includes("USING INDEX"))).toBe(true);
        expect(bindings.some((plan) => plan.detail.includes("row_binding_entity_idx"))).toBe(true);
      });
    } finally {
      await adapter.close(true);
    }
  });
});

/** Assembles every whole-entity chunk at `limit` entities per chunk. */
async function assemblePaged(
  adapter: MikroOrmSqliteAdapter,
  limit: number,
  tombstoneField: string | undefined,
): Promise<readonly unknown[]> {
  return adapter.read(async ({ sql }) => {
    const completed: unknown[] = [];
    let after: { readonly entityId: string } | undefined;
    let carry: PartialDesiredRow | undefined;
    for (;;) {
      const chunk = await readReconciliationDesiredSystemStateChunkWithSql(
        sql,
        "logical-recon",
        after,
        limit,
      );
      if (chunk.entityCount === 0 || chunk.lastEntityId === undefined) break;
      after = { entityId: chunk.lastEntityId };
      const assembled = assembleDesiredChunk(chunk.rows, carry, tombstoneField);
      completed.push(...assembled.completed);
      carry = assembled.carry;
      if (chunk.entityCount < limit) break;
    }
    const flushed = flushDesiredCarry(carry, tombstoneField);
    if (flushed !== undefined) completed.push(flushed);
    return completed;
  });
}

async function bootstrapSmall(
  entities: readonly { readonly entityId: string; readonly fields: Record<string, string> }[],
): Promise<{ readonly adapter: MikroOrmSqliteAdapter }> {
  const orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ":memory:",
    driverOptions: new NodeSqliteDialect(":memory:"),
    entities: [Entity],
  });
  await orm.schema.create();
  const adapter = new MikroOrmSqliteAdapter(orm);
  await migrateSqliteSchema(adapter);
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-recon", 1, "{}", "id"],
    );
    for (const entity of entities) {
      await sql.run(
        "INSERT INTO entity_state (entity_id, entity_revision, status) VALUES (?, ?, ?)",
        [entity.entityId, 1, "active"],
      );
      await sql.run(
        "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, entity_id, state) VALUES (?, ?, ?, ?, ?)",
        [`bind-${entity.entityId}`, "logical-recon", `anchor-${entity.entityId}`, entity.entityId, "active"],
      );
      for (const [fieldName, value] of Object.entries(entity.fields)) {
        await sql.run(
          "INSERT INTO entity_field_state (entity_id, field_name, normalized_value, field_revision, ownership) VALUES (?, ?, ?, ?, ?)",
          [entity.entityId, fieldName, JSON.stringify({ kind: "string", value }), 1, "system"],
        );
      }
    }
  });
  return { adapter };
}

function canonicalFields(index: number): Record<string, NormalizedCell> {
  return {
    id: { kind: "string", value: `user-${index}` },
    status: { kind: "string", value: `st-${index % 7}` },
    note: { kind: "string", value: `note-${index}` },
    flag: { kind: "boolean", value: index % 2 === 0 },
  };
}

async function bootstrapLarge(): Promise<{
  readonly adapter: MikroOrmSqliteAdapter;
  readonly provider: FakeSyncSheetsProvider;
}> {
  const orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ":memory:",
    driverOptions: new NodeSqliteDialect(":memory:"),
    entities: [Entity],
  });
  await orm.schema.create();
  const adapter = new MikroOrmSqliteAdapter(orm);
  await migrateSqliteSchema(adapter);

  // Batched multi-row inserts: 20k entities x 4 fields must seed in seconds.
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-recon", 1, "{}", "id"],
    );
    await sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["physical-recon", "logical-recon", "spreadsheet", "Orders", "A:D", "system_state", 1],
    );
    const entityRows: string[] = [];
    const bindingRows: string[] = [];
    const fieldRows: string[] = [];
    const entityParams: (string | number)[] = [];
    const bindingParams: (string | number | null)[] = [];
    const fieldParams: (string | number)[] = [];
    const flushEntities = async (): Promise<void> => {
      if (entityRows.length === 0) return;
      await sql.run(
        `INSERT INTO entity_state (entity_id, entity_revision, status) VALUES ${entityRows.join(",")}`,
        entityParams,
      );
      await sql.run(
        `INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, entity_id, state) VALUES ${bindingRows.join(",")}`,
        bindingParams,
      );
      await sql.run(
        `INSERT INTO entity_field_state (entity_id, field_name, normalized_value, field_revision, ownership) VALUES ${fieldRows.join(",")}`,
        fieldParams,
      );
      entityRows.length = 0;
      bindingRows.length = 0;
      fieldRows.length = 0;
      entityParams.length = 0;
      bindingParams.length = 0;
      fieldParams.length = 0;
    };
    for (let i = 0; i < PARITY_ENTITY_COUNT; i += 1) {
      const entityId = `ent-${String(i).padStart(6, "0")}`;
      entityRows.push("(?,?,?)");
      entityParams.push(entityId, 1, "active");
      bindingRows.push("(?,?,?,?,?)");
      bindingParams.push(`bind-${i}`, "logical-recon", `anchor-${i}`, entityId, "active");
      for (const [fieldName, cell] of Object.entries(canonicalFields(i))) {
        fieldRows.push("(?,?,?,?,?)");
        fieldParams.push(entityId, fieldName, JSON.stringify(cell), 1, "system");
      }
      if (entityRows.length >= 500) await flushEntities();
    }
    await flushEntities();
  });

  // Snapshot: every row matches except a deterministic drifted subset; every
  // 50th row is missing; 200 surplus orphans exercise the extra counter.
  const sheetRows: {
    readonly targetId: string;
    readonly physicalAnchor: string;
    readonly fields: Record<string, NormalizedCell>;
  }[] = [];
  for (let i = 0; i < PARITY_ENTITY_COUNT; i += 1) {
    if (i % 50 === 0) continue;
    const fields = canonicalFields(i);
    if (i % 20 === 0) fields.status = { kind: "string", value: "drifted" };
    sheetRows.push({ targetId: `user-${i}`, physicalAnchor: `anchor-${i}`, fields });
  }
  for (let k = 0; k < 200; k += 1) {
    sheetRows.push({
      targetId: `orphan-${k}`,
      physicalAnchor: `orphan-anchor-${k}`,
      fields: {
        id: { kind: "string", value: `orphan-${k}` },
        status: { kind: "string", value: "stale" },
        note: { kind: "string", value: "orphan" },
        flag: { kind: "boolean", value: false },
      },
    });
  }
  const provider = new FakeSyncSheetsProvider([
    {
      physicalSheetId: "physical-recon",
      sheetName: "Orders",
      registeredRange: "A:D",
      projection: "system_state",
      schemaVersion: 1,
      headers: [...SYSTEM_HEADERS],
      rows: sheetRows,
    },
  ]);

  await seedOutboxHeads(adapter);
  return { adapter, provider };
}

/** Seeds terminal/recoverable/pending heads over drifted and clean streams. */
async function seedOutboxHeads(adapter: MikroOrmSqliteAdapter): Promise<void> {
  const claim = await claimWriterLeaseWithAdapter(adapter, {
    role: "seed-writer",
    writerId: "seed-writer",
    leaseDurationMs: 60_000,
    now: 5_000,
  });
  if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
    throw new Error("seed writer fence unavailable");
  }
  const fence = {
    role: claim.lease.role,
    writerEpoch: claim.lease.writerEpoch,
    fencingToken: claim.lease.fencingToken,
    now: 5_000,
  };
  const seed = (
    effectId: string,
    index: number,
    fields: Record<string, NormalizedCell>,
  ): ReturnType<typeof createSystemProjectionEffect> =>
    createSystemProjectionEffect({
      effectId,
      commitId: "commit-seed",
      logicalSheetId: "logical-recon",
      physicalSheetId: "physical-recon",
      sheetName: "Orders",
      registeredRange: "A:D",
      projection: "system_state",
      schemaVersion: 1,
      targetKind: "entity",
      targetId: `ent-${String(index).padStart(6, "0")}`,
      rowBindingId: { kind: "present", value: `bind-${index}` },
      conflictId: { kind: "absent" },
      targetAnchor: `anchor-${index}`,
      fields,
      createIfMissing: true,
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      streamSequence: 1,
    });
  const effects = [
    // Terminal head on a drifted stream: superseded by the fresh repair.
    seed("effect-seed-terminal-drifted", 20, canonicalFields(20)),
    // Terminal head on a clean stream: repaired even without drift.
    seed("effect-seed-terminal-clean", 1, canonicalFields(1)),
    // Recoverable head stays on the worker retry path; the scan appends
    // a trailing repair behind it without superseding.
    seed("effect-seed-recoverable", 40, canonicalFields(40)),
    // Equivalent correction already in flight: the scan must skip appending.
    seed("effect-seed-inflight", 60, canonicalFields(60)),
  ];
  await expect(
    appendPendingEffectsWithAdapter(adapter, fence, effects),
  ).resolves.toBe(true);
  // Force-settle the failed heads; the in-flight correction keeps the
  // canonical target hash so the scan recognizes it as equivalent.
  await adapter.transaction(async ({ sql }) => {
    for (const [effectId, code] of [
      ["effect-seed-terminal-drifted", "delivery_uncertain_timeout"],
      ["effect-seed-terminal-clean", "delivery_uncertain_timeout"],
      ["effect-seed-recoverable", SYNC_EFFECT_RECOVERY_ERROR_CODES.PROVIDER_RETRYABLE_ERROR],
    ] as const) {
      await sql.run(
        "UPDATE sheet_effect_outbox SET status = 'failed', claim_token = NULL, lease_until = NULL, next_attempt_at = NULL, last_error_code = ?, last_error_message = ? WHERE effect_id = ?",
        [code, "seeded failure", effectId],
      );
    }
  });
}

async function dumpOutbox(adapter: MikroOrmSqliteAdapter): Promise<readonly unknown[]> {
  return adapter.read(({ sql }) =>
    sql.all(
      `SELECT effect_id, effect_kind, target_kind, target_id, stream_sequence, status,
              supersedes_effect_id, expected_visible_revision, expected_visible_hash,
              last_error_code, payload_json
       FROM sheet_effect_outbox ORDER BY target_id, stream_sequence`,
    ),
  );
}

function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `parity-${n}`;
  };
}

/** Wraps an adapter recording every `sql.all` result size during the scan. */
function watchAllSizes(storage: MikroOrmSqliteAdapter): {
  readonly adapter: SqlStorageAdapter;
  readonly sizes: number[];
} {
  const sizes: number[] = [];
  const watch = (sql: SqlExecutor): SqlExecutor => ({
    all: async <Row extends object>(
      query: string,
      parameters?: readonly SqlParameter[],
    ): Promise<readonly Row[]> => {
      const rows = await sql.all<Row>(query, parameters);
      sizes.push(rows.length);
      return rows;
    },
    get: sql.get.bind(sql),
    run: sql.run.bind(sql),
  });
  return {
    adapter: {
      read: (operation) => storage.read((context) => operation({ sql: watch(context.sql) })),
      transaction: (operation) =>
        storage.transaction((context) => operation({ sql: watch(context.sql) })),
    },
    sizes,
  };
}
