/**
 * CRUD lifecycle tests for the MCP tool handlers against the real local-only
 * Hikoutei engine on a temp SQLite file (no network, no credentials).
 */

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";
import type { Hikoutei, HikouteiEntity } from "hikoutei";
import { buildToolEntityInfos } from "../src/values.js";
import { callHikouteiTool, type HikouteiToolContext } from "../src/tools.js";
import type { HikouteiMcpConfig } from "../src/config.js";

const config: HikouteiMcpConfig = {
  entities: [
    {
      name: "tasks",
      tableName: "tasks",
      properties: {
        id: { type: "string", primary: true },
        title: { type: "string" },
        done: { type: "boolean" },
        effort: { type: "number", nullable: true },
        dueAt: { type: "date" },
      },
    },
  ],
};

const Task = defineTypedSheetsEntity({
  name: "tasks",
  tableName: "tasks",
  properties: {
    id: { type: "string", primary: true },
    title: { type: "string" },
    done: { type: "boolean" },
    effort: { type: "number", nullable: true },
    dueAt: { type: "date" },
  },
}) as HikouteiEntity<object>;

describe("hikoutei-mcp tool handlers (local-only engine)", () => {
  let hikoutei: Hikoutei;
  let dbName: string;
  let context: HikouteiToolContext;

  beforeEach(async () => {
    dbName = join(tmpdir(), `hikoutei-mcp-tools-${randomUUID()}.sqlite`);
    hikoutei = await createTypedSheets({ dbName, entities: [Task] });
    context = {
      hikoutei,
      dbName,
      entityInfos: buildToolEntityInfos(config),
      tokens: new Map([["tasks", Task]]),
    };
  });

  afterEach(async () => {
    await hikoutei.close();
    await Promise.all([
      unlink(dbName),
      unlink(`${dbName}-wal`),
      unlink(`${dbName}-shm`),
    ]).catch(() => undefined);
  });

  async function call(name: string, args: unknown) {
    return callHikouteiTool(context, name, args);
  }

  function requireOk(outcome: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
    expect(outcome.isError).toBeUndefined();
    const structured = outcome.structuredContent as Record<string, unknown>;
    expect(structured).toBeDefined();
    return structured;
  }

  it("lists entities with property metadata", async () => {
    const structured = requireOk(await call("list_entities", {}));
    const entities = structured.entities as Array<Record<string, unknown>>;
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ name: "tasks", primaryKey: "id" });
  });

  it("runs a create → get → find → update → delete lifecycle", async () => {
    const created = requireOk(await call("create_record", {
      entity: "tasks",
      data: {
        id: "t1",
        title: "ship the mcp server",
        done: false,
        effort: 3,
        dueAt: "2026-08-01T00:00:00.000Z",
      },
    }));
    expect(created.record).toMatchObject({
      id: "t1",
      title: "ship the mcp server",
      done: false,
      effort: 3,
      dueAt: "2026-08-01T00:00:00.000Z",
    });

    const got = requireOk(await call("get_record", { entity: "tasks", id: "t1" }));
    expect(got.found).toBe(true);
    expect(got.record).toMatchObject({ title: "ship the mcp server" });

    await call("create_record", {
      entity: "tasks",
      data: { id: "t2", title: "beta task", done: true, dueAt: "2026-08-02T00:00:00.000Z" },
    });

    const found = requireOk(await call("find_records", {
      entity: "tasks",
      where: { done: { eq: false } },
      orderBy: { id: "asc" },
    }));
    expect(found.count).toBe(1);
    expect((found.rows as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "t1" });

    const paged = requireOk(await call("find_records", {
      entity: "tasks",
      orderBy: { id: "desc" },
      limit: 1,
      offset: 1,
    }));
    expect(paged.count).toBe(1);
    expect((paged.rows as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "t1" });

    const updated = requireOk(await call("update_record", {
      entity: "tasks",
      id: "t1",
      data: { title: "renamed", effort: null },
    }));
    expect(updated.record).toMatchObject({ title: "renamed", effort: null });

    const deleted = requireOk(await call("delete_record", { entity: "tasks", id: "t2" }));
    expect(deleted.deleted).toBe(true);

    const missing = requireOk(await call("get_record", { entity: "tasks", id: "t2" }));
    expect(missing.found).toBe(false);
    expect(missing.record).toBeNull();
  });

  it("returns isError with corrective text for argument problems", async () => {
    const unknownEntity = await call("create_record", { entity: "nope", data: {} });
    expect(unknownEntity.isError).toBe(true);

    const unknownField = await call("create_record", {
      entity: "tasks",
      data: { id: "x", title: "y", done: true, dueAt: "2026-08-01T00:00:00.000Z", bogus: 1 },
    });
    expect(unknownField.isError).toBe(true);

    const wrongType = await call("create_record", {
      entity: "tasks",
      data: { id: 9, title: "y", done: true, dueAt: "2026-08-01T00:00:00.000Z" },
    });
    expect(wrongType.isError).toBe(true);

    const missing = await call("update_record", { entity: "tasks", id: "ghost", data: { title: "z" } });
    expect(missing.isError).toBe(true);

    const unknownTool = await call("explode", {});
    expect(unknownTool.isError).toBe(true);
  });

  it("maps engine failures to stable hikoutei:<code> error text", async () => {
    await call("create_record", {
      entity: "tasks",
      data: { id: "dup", title: "first", done: true, dueAt: "2026-08-01T00:00:00.000Z" },
    });
    const duplicate = await call("create_record", {
      entity: "tasks",
      data: { id: "dup", title: "second", done: true, dueAt: "2026-08-01T00:00:00.000Z" },
    });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content[0]?.text).toMatch(/^hikoutei:/);
  });

  it("reports local-only status and an empty conflict list", async () => {
    const status = requireOk(await call("get_sync_status", {}));
    expect(status).toEqual({ mode: "local" });

    const conflicts = requireOk(await call("list_conflicts", {}));
    expect(conflicts).toEqual({ conflicts: [] });
  });
});
