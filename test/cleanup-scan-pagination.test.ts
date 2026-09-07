/**
 * Keyset-pagination parity for the User_Input cleanup scan (#503).
 *
 * Phase 0 baseline: a large deterministic fixture (tens of thousands of
 * active row bindings with canonical user-owned fields, seeded outbox and
 * conflict evidence) exercised through one `runUserInputCleanupScan`. The
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

import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { SYNC_PROJECTIONS } from "@hikoutei/contracts/sheets/constants.js";
import { FakeSyncSheetsProvider } from "./support/FakeSyncSheetsProvider.js";
import { MikroOrmSqliteAdapter } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import type {
  SqlExecutor,
  SqlParameter,
  SqlStorageAdapter,
} from "@hikoutei/contracts/storage/sql.js";
import { migrateSqliteSchema } from "@hikoutei/storage/storage/sqlite/migrateSchema.js";
import { runUserInputCleanupScan } from "@hikoutei/sync-engine/sync/outbound/reconciliation/CleanupScanner.js";
import {
  assembleCleanupCanonicalChunk,
  buildCleanupSnapshotIndex,
  classifyCleanupRows,
  classifyCleanupStreamTargets,
  decodeCleanupRows,
  flushCleanupCanonicalCarry,
  readCleanupBindingsChunkWithSql,
  readCleanupCanonicalChunkWithSql,
  readCleanupEvidenceWithSql,
  readCleanupStreamEvidenceWithSql,
  type PartialCleanupCanonical,
} from "@hikoutei/sync-engine/sync/outbound/reconciliation/cleanup.js";

const EntitySchema = defineEntity({
  name: "CleanupParityEntity",
  tableName: "cleanup_parity_entity",
  properties: { id: p.string().primary() },
});

class Entity extends EntitySchema.class {}

EntitySchema.setClass(Entity);

const INPUT_HEADERS = ["id", "status"] as const;
/** Large enough to force dozens of 1000-row chunks (2 fields per binding). */
export const PARITY_BINDING_COUNT = 15_000;

const GOLDEN_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "scan-parity",
  "cleanup-golden.json",
);

describe("cleanup scan pagination", () => {
  it("reproduces the golden full-load repair decisions on the large fixture", async () => {
    const { adapter, provider } = await bootstrapLarge();
    try {
      const report = await runUserInputCleanupScan({
        storage: adapter,
        provider,
        physicalSheetId: "physical-input",
        logicalSheetId: "logical-clean",
        identityField: "id",
        schemaVersion: 1,
        writerId: "cleaner",
        now: () => 5_000,
        createId: counter(),
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

  it("bounds every evidence page to the chunk size (peak scan memory is O(chunk))", async () => {
    const { adapter, provider } = await bootstrapLarge();
    try {
      const { adapter: watched, sizes } = watchAllSizes(adapter);
      await runUserInputCleanupScan({
        storage: watched,
        provider,
        physicalSheetId: "physical-input",
        logicalSheetId: "logical-clean",
        identityField: "id",
        schemaVersion: 1,
        writerId: "cleaner",
        now: () => 5_000,
        createId: counter(),
      });
      // 15k bindings (15 full 1000-row pages) + 15k entities (60 full
      // 250-entity canonical pages) + per-entity binding/field fetches of a
      // handful of rows: no read ever materializes more than one page, so
      // peak scan memory stays flat as the tables grow. (The provider
      // snapshot is outside the scan's control and intentionally not
      // measured here.)
      expect(Math.max(...sizes)).toBeLessThanOrEqual(1_000);
      expect(sizes.filter((size) => size === 1_000).length).toBeGreaterThanOrEqual(14);
      expect(sizes.filter((size) => size === 250).length).toBeGreaterThanOrEqual(59);
    } finally {
      await adapter.close(true);
    }
  }, 240_000);

  it("streams evidence identical to the full-load evidence on a small fixture", async () => {
    const { adapter, provider } = await bootstrapSmall();
    try {
      const rows = decodeCleanupRows(
        await provider.readSnapshot({
          physicalSheetId: "physical-input",
          sheetName: "Orders_Input",
          registeredRange: "A:B",
          projection: SYNC_PROJECTIONS.USER_INPUT,
          schemaVersion: 1,
        }),
        "id",
      );
      const snapshotIndex = buildCleanupSnapshotIndex(rows);
      const [full, streamed] = await adapter.read(async ({ sql }) => [
        await readCleanupEvidenceWithSql(sql, "logical-clean", "physical-input"),
        await readCleanupStreamEvidenceWithSql(sql, "logical-clean", "physical-input", snapshotIndex),
      ] as const);
      // Bindings match as sets (paged reads impose `row_binding_id` order
      // while the legacy query is unordered); canonical rows and candidate
      // hashes match exactly, in order.
      expect([...streamed.bindingsByAnchor.values()].sort((a, b) =>
        a.rowBindingId.localeCompare(b.rowBindingId))).toEqual(
        [...full.bindings].sort((a, b) => a.rowBindingId.localeCompare(b.rowBindingId)),
      );
      expect([...streamed.canonicalAnchors].sort()).toEqual(
        full.canonical.map((row) => row.anchorReference).sort(),
      );
      expect([...streamed.candidateHashes]).toEqual([...full.candidateHashes]);
      expect(streamed.rewriteByAnchor.size).toBeGreaterThan(0);
      // The mirrored classifier decides exactly what the full-load
      // classifier decides, in the same order.
      expect(classifyCleanupStreamTargets(rows, snapshotIndex, streamed)).toEqual(
        classifyCleanupRows(rows, full),
      );
    } finally {
      await adapter.close(true);
    }
  });

  it("handles empty tables, a single row, and mid-entity chunk splits", async () => {
    const empty = await bootstrapSmallCustom({ bindings: [] });
    try {
      await empty.adapter.read(async ({ sql }) => {
        expect(await readCleanupBindingsChunkWithSql(sql, "logical-clean", undefined)).toEqual([]);
        expect(await readCleanupCanonicalChunkWithSql(sql, "logical-clean", undefined)).toEqual({
          rows: [],
          entityCount: 0,
          lastEntityId: undefined,
        });
      });
    } finally {
      await empty.adapter.close(true);
    }
    const single = await bootstrapSmallCustom({
      bindings: [{ rowBindingId: "b1", anchor: "a1", state: "active", entityId: "e1", fields: { id: cell("u1") } }],
    });
    try {
      const streamed = await single.adapter.read(({ sql }) =>
        readCleanupStreamEvidenceWithSql(
          sql,
          "logical-clean",
          "physical-input",
          buildCleanupSnapshotIndex([]),
        ),
      );
      expect(streamed.canonicalAnchors).toEqual(new Set(["a1"]));
      expect(streamed.rewriteByAnchor.size).toBe(0);
    } finally {
      await single.adapter.close(true);
    }
    // Whole-entity chunks (limits 1 and 3 over multi-field bindings)
    // assemble exactly what the full-load grouping assembles.
    const { adapter } = await bootstrapSmall();
    try {
      const full = await adapter.read(({ sql }) =>
        readCleanupEvidenceWithSql(sql, "logical-clean", "physical-input"),
      );
      for (const limit of [1, 3, 1_000]) {
        await expect(assembleCanonicalPaged(adapter, limit)).resolves.toEqual(full.canonical);
      }
    } finally {
      await adapter.close(true);
    }
  });

  it("keeps every binding's fields for multi-binding entities", async () => {
    // One entity, two active bindings: a flat (entity, field) cursor would
    // skip the second binding's rows at page boundaries. Whole-entity
    // chunks page the entity once with all of its bindings.
    const { adapter } = await bootstrapSmallCustom({
      bindings: [
        { rowBindingId: "b1", anchor: "a1", state: "active", entityId: "e1", fields: { id: cell("u1"), status: cell("open") } },
      ],
    });
    // Fields live per entity and are shared: only the binding row is added.
    await adapter.transaction(async ({ sql }) => {
      await sql.run(
        "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, entity_id, state) VALUES (?, ?, ?, ?, ?)",
        ["b2", "logical-clean", "a2", "e1", "active"],
      );
    });
    try {
      const full = await adapter.read(({ sql }) =>
        readCleanupEvidenceWithSql(sql, "logical-clean", "physical-input"),
      );
      const streamed = await assembleCanonicalPaged(adapter, 1);
      // Both bindings complete with both user fields...
      expect(streamed).toHaveLength(2);
      for (const row of streamed) {
        expect(Object.keys((row as { readonly fields: Record<string, unknown> }).fields).sort())
          .toEqual(["id", "status"]);
      }
      expect(new Set(streamed.map((row) =>
        (row as { readonly rowBindingId: string }).rowBindingId))).toEqual(new Set(["b1", "b2"]));
      // ...and identical to the full-load grouping.
      expect(streamed).toEqual(full.canonical);
    } finally {
      await adapter.close(true);
    }
  });
});

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

/** Assembles every whole-entity canonical chunk at `limit` entities per chunk. */
async function assembleCanonicalPaged(
  adapter: MikroOrmSqliteAdapter,
  limit: number,
): Promise<readonly unknown[]> {
  return adapter.read(async ({ sql }) => {
    const completed: unknown[] = [];
    let after: { readonly entityId: string } | undefined;
    let carry: PartialCleanupCanonical | undefined;
    for (;;) {
      const chunk = await readCleanupCanonicalChunkWithSql(sql, "logical-clean", after, limit);
      if (chunk.entityCount === 0 || chunk.lastEntityId === undefined) break;
      after = { entityId: chunk.lastEntityId };
      const assembled = assembleCleanupCanonicalChunk(chunk.rows, carry);
      completed.push(...assembled.completed);
      carry = assembled.carry;
      if (chunk.entityCount < limit) break;
    }
    completed.push(...flushCleanupCanonicalCarry(carry));
    return completed;
  });
}

function cell(value: string): NormalizedCell {
  return { kind: "string", value };
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

  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-clean", 1, "{}", "id"],
    );
    await sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["physical-input", "logical-clean", "spreadsheet", "Orders_Input", "A:B", "user_input", 1],
    );
    const entityRows: string[] = [];
    const bindingRows: string[] = [];
    const fieldRows: string[] = [];
    const entityParams: (string | number)[] = [];
    const bindingParams: (string | number | null)[] = [];
    const fieldParams: (string | number)[] = [];
    const flush = async (): Promise<void> => {
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
    for (let i = 0; i < PARITY_BINDING_COUNT; i += 1) {
      const entityId = `entity:u${i}`;
      entityRows.push("(?,?,?)");
      entityParams.push(entityId, 1, "active");
      bindingRows.push("(?,?,?,?,?)");
      bindingParams.push(`binding-${i}`, "logical-clean", `input-${i}`, entityId, "active");
      fieldRows.push("(?,?,?,?,?)", "(?,?,?,?,?)");
      fieldParams.push(
        entityId, "id", JSON.stringify(cell(`user-${i}`)), 1, "user",
        entityId, "status", JSON.stringify(cell("open")), 1, "user",
      );
      if (entityRows.length >= 500) await flush();
    }
    await flush();
    // Two drifted bound rows protected by durable OPEN conflicts: the scan
    // must never plan a rewrite for them.
    await seedCandidate(sql, "conflict-p1", "binding-7", "entity:u7");
    await seedCandidate(sql, "conflict-p2", "binding-9", "entity:u9");
  });

  const sheetRows: {
    readonly anchor: string;
    readonly id: string;
    readonly status: string;
  }[] = [];
  for (let i = 0; i < PARITY_BINDING_COUNT; i += 1) {
    // Every 25th bound row drifted from canonical (rewrite target), plus
    // the two conflict-protected bindings: their drift proves the OPEN
    // conflict suppresses the rewrite.
    const drifted = i % 25 === 0 || i === 7 || i === 9;
    sheetRows.push({
      anchor: `input-${i}`,
      id: `user-${i}`,
      status: drifted ? "stale" : "open",
    });
  }
  // Duplicated-anchor group: only the first row is provider-resolvable, so
  // the scan deletes exactly that row and defers the group's rewrite.
  sheetRows.push({ anchor: "input-0", id: "user-0", status: "open" });
  for (let k = 0; k < 100; k += 1) {
    sheetRows.push({ anchor: `empty-${k}`, id: "", status: "open" });
  }
  for (let k = 0; k < 200; k += 1) {
    sheetRows.push({ anchor: `extra-${k}`, id: `orphan-${k}`, status: "open" });
  }
  // Duplicated orphan identity: both rows are surplus.
  sheetRows.push({ anchor: "extra-dup-a", id: "orphan-dup", status: "open" });
  sheetRows.push({ anchor: "extra-dup-b", id: "orphan-dup", status: "open" });

  const provider = new FakeSyncSheetsProvider([
    {
      physicalSheetId: "physical-input",
      sheetName: "Orders_Input",
      registeredRange: "A:B",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      identityField: "id",
      headers: [...INPUT_HEADERS],
      rows: sheetRows.map((row) => ({
        targetId: row.id.length === 0 ? row.anchor : row.id,
        physicalAnchor: row.anchor,
        visibleRevision: 1,
        fields: { id: cell(row.id), status: cell(row.status) },
      })),
    },
  ], { allowDuplicateAnchors: true, realProviderSnapshotShape: true });

  return { adapter, provider };
}

/** Seeds one durable OPEN conflict with its visible-field candidate pointer. */
async function seedCandidate(
  sql: SqlExecutor,
  conflictId: string,
  bindingId: string,
  entityId: string,
): Promise<void> {
  const batchId = `batch-${conflictId}`;
  const eventId = `event-${conflictId}`;
  await sql.run(
    "INSERT INTO event_batch (batch_id, logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash) VALUES (?, ?, ?, 'polling', 'user_input', 'row_independent', 'hash')",
    [batchId, "logical-clean", "physical-input"],
  );
  await sql.run(
    "INSERT INTO event_log (event_id, logical_sheet_id, physical_sheet_id, event_key, payload_hash, event_sequence, batch_id, row_binding_id, operation, status, received_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'update', 'accepted', 1_000)",
    [eventId, "logical-clean", "physical-input", `key-${conflictId}`, "hash", batchId, bindingId],
  );
  await sql.run(
    "INSERT INTO sync_conflict (conflict_id, event_id, logical_sheet_id, entity_id, row_binding_id, field_name, user_value, user_base_revision, canonical_value_at_detection, canonical_revision_at_detection, current_canonical_value, current_canonical_revision, candidate_epoch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'status', 'user', 0, 'canonical', 0, 'canonical', 0, 0, 'OPEN', 1_000, 1_000)",
    [conflictId, eventId, "logical-clean", entityId, bindingId],
  );
  await sql.run(
    "INSERT INTO sheet_visible_field_state (physical_sheet_id, projection, row_binding_id, field_name, confirmed_field_hash, confirmed_visible_revision, active_candidate_conflict_id, active_candidate_hash, candidate_epoch, last_observed_field_hash) VALUES (?, 'user_input', ?, 'status', 'h', 1, ?, 'candidate-hash', 0, 'h')",
    ["physical-input", bindingId, conflictId],
  );
}

async function dumpOutbox(adapter: MikroOrmSqliteAdapter): Promise<readonly unknown[]> {
  return adapter.read(({ sql }) =>
    sql.all(
      `SELECT effect_id, effect_kind, target_kind, target_id, row_binding_id,
              stream_sequence, status, supersedes_effect_id,
              expected_visible_revision, expected_visible_hash, payload_json
       FROM sheet_effect_outbox ORDER BY target_id, stream_sequence`,
    ),
  );
}

function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `cleanup-parity-${n}`;
  };
}

interface SmallBindingSeed {
  readonly rowBindingId: string;
  readonly anchor: string;
  readonly state: string;
  readonly entityId?: string;
  readonly fields?: Readonly<Record<string, NormalizedCell>>;
}

interface SmallSheetRowSeed {
  readonly anchor: string;
  readonly id: string;
  readonly status: string;
}

/** Small mixed fixture: multi-field bindings, a candidate, a protected drift. */
async function bootstrapSmall(): Promise<{
  readonly adapter: MikroOrmSqliteAdapter;
  readonly provider: FakeSyncSheetsProvider;
}> {
  return bootstrapSmallCustom({
    bindings: [
      {
        rowBindingId: "b0", anchor: "a0", state: "active", entityId: "e0",
        fields: { id: cell("u0"), status: cell("open"), note: cell("n0") },
      },
      {
        rowBindingId: "b1", anchor: "a1", state: "active", entityId: "e1",
        fields: { id: cell("u1"), status: cell("open") },
      },
      {
        rowBindingId: "b2", anchor: "a2", state: "active", entityId: "e2",
        fields: { id: cell("u2"), status: cell("open") },
      },
      { rowBindingId: "b3", anchor: "a3", state: "candidate" },
      {
        rowBindingId: "b4", anchor: "a4", state: "active", entityId: "e4",
        fields: { id: cell("u4"), status: cell("open") },
      },
    ],
    sheetRows: [
      { anchor: "a0", id: "u0", status: "open" },
      { anchor: "a0", id: "u0", status: "open" },
      { anchor: "a1", id: "u1", status: "open" },
      { anchor: "a2", id: "u2", status: "stale" },
      { anchor: "a4", id: "u4", status: "stale" },
      { anchor: "empty-0", id: "", status: "open" },
      { anchor: "extra-0", id: "orphan", status: "open" },
    ],
    candidates: [{ conflictId: "conflict-small", bindingId: "b4", entityId: "e4" }],
  });
}

async function bootstrapSmallCustom(args: {
  readonly bindings: readonly SmallBindingSeed[];
  readonly sheetRows?: readonly SmallSheetRowSeed[];
  readonly candidates?: readonly { readonly conflictId: string; readonly bindingId: string; readonly entityId: string }[];
}): Promise<{
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
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-clean", 1, "{}", "id"],
    );
    await sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["physical-input", "logical-clean", "spreadsheet", "Orders_Input", "A:B", "user_input", 1],
    );
    for (const binding of args.bindings) {
      if (binding.entityId !== undefined && binding.fields !== undefined) {
        await sql.run(
          "INSERT INTO entity_state (entity_id, entity_revision, status) VALUES (?, ?, ?)",
          [binding.entityId, 1, "active"],
        );
        for (const [fieldName, value] of Object.entries(binding.fields)) {
          await sql.run(
            "INSERT INTO entity_field_state (entity_id, field_name, normalized_value, field_revision, ownership) VALUES (?, ?, ?, ?, ?)",
            [binding.entityId, fieldName, JSON.stringify(value), 1, "user"],
          );
        }
      }
      await sql.run(
        "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, entity_id, state) VALUES (?, ?, ?, ?, ?)",
        [binding.rowBindingId, "logical-clean", binding.anchor, binding.entityId ?? null, binding.state],
      );
    }
    for (const candidate of args.candidates ?? []) {
      await seedCandidate(sql, candidate.conflictId, candidate.bindingId, candidate.entityId);
    }
  });
  const provider = new FakeSyncSheetsProvider([
    {
      physicalSheetId: "physical-input",
      sheetName: "Orders_Input",
      registeredRange: "A:B",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      identityField: "id",
      headers: [...INPUT_HEADERS],
      rows: (args.sheetRows ?? []).map((row) => ({
        targetId: row.id.length === 0 ? row.anchor : row.id,
        physicalAnchor: row.anchor,
        visibleRevision: 1,
        fields: { id: cell(row.id), status: cell(row.status) },
      })),
    },
  ], { allowDuplicateAnchors: true, realProviderSnapshotShape: true });
  return { adapter, provider };
}
