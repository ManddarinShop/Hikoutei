/**
 * Protocol-level tests: a real MCP `Client` talks to the server over the
 * SDK's in-memory transport pair, exercising the same handlers stdio uses
 * (initialize handshake, tools/list, tools/call, error results).
 */

import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";
import type { Hikoutei, HikouteiEntity } from "hikoutei";
import { createHikouteiMcpServer } from "../src/index.js";
import { buildToolEntityInfos } from "../src/values.js";
import { HIKOUTEI_MCP_TOOLS, type HikouteiToolContext } from "../src/tools.js";
import type { HikouteiMcpConfig } from "../src/config.js";

const config: HikouteiMcpConfig = {
  entities: [
    {
      name: "notes",
      tableName: "notes",
      properties: {
        id: { type: "string", primary: true },
        body: { type: "string" },
      },
    },
  ],
};

const Note = defineTypedSheetsEntity({
  name: "notes",
  tableName: "notes",
  properties: {
    id: { type: "string", primary: true },
    body: { type: "string" },
  },
}) as HikouteiEntity<object>;

describe("hikoutei-mcp protocol surface", () => {
  let hikoutei: Hikoutei;
  let dbName: string;
  let server: Server;
  let client: Client;

  beforeEach(async () => {
    dbName = join(tmpdir(), `hikoutei-mcp-proto-${randomUUID()}.sqlite`);
    hikoutei = await createTypedSheets({ dbName, entities: [Note] });
    const context: HikouteiToolContext = {
      hikoutei,
      dbName,
      entityInfos: buildToolEntityInfos(config),
      tokens: new Map([["notes", Note]]),
    };
    server = createHikouteiMcpServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "hikoutei-mcp-test", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
    await hikoutei.close();
    await Promise.all([
      unlink(dbName),
      unlink(`${dbName}-wal`),
      unlink(`${dbName}-shm`),
    ]).catch(() => undefined);
  });

  it("advertises the eight v1 tools", async () => {
    const listing = await client.listTools();
    expect(listing.tools.map((tool) => tool.name).sort()).toEqual(
      [...HIKOUTEI_MCP_TOOLS].sort(),
    );
  });

  it("answers list_entities with structured content", async () => {
    const result = await client.callTool({ name: "list_entities", arguments: {} });
    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { entities: unknown[] };
    expect(structured.entities).toHaveLength(1);
  });

  it("round-trips a record through create_record and find_records", async () => {
    const created = await client.callTool({
      name: "create_record",
      arguments: { entity: "notes", data: { id: "n1", body: "hello protocol" } },
    });
    expect(created.isError).toBeUndefined();
    const createdStructured = created.structuredContent as { record: { id: string } };
    expect(createdStructured.record.id).toBe("n1");

    const found = await client.callTool({
      name: "find_records",
      arguments: { entity: "notes", where: { body: { like: "%protocol%" } } },
    });
    expect(found.isError).toBeUndefined();
    const foundStructured = found.structuredContent as {
      count: number;
      rows: Array<{ id: string; body: string }>;
    };
    expect(foundStructured.count).toBe(1);
    expect(foundStructured.rows[0]).toMatchObject({ id: "n1", body: "hello protocol" });
  });

  it("returns isError tool results without breaking the connection", async () => {
    const failure = await client.callTool({
      name: "get_record",
      arguments: { entity: "missing", id: "x" },
    });
    expect(failure.isError).toBe(true);

    const recovered = await client.callTool({
      name: "get_record",
      arguments: { entity: "notes", id: "n1" },
    });
    expect(recovered.isError).toBeUndefined();
  });
});
