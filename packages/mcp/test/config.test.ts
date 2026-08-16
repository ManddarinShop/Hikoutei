/**
 * Tests for the `hikoutei.config.json` loader: every invalid state must be
 * rejected with a corrective reason, and valid states must parse losslessly.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HIKOUTEI_MCP_CONFIG_FILE_NAME,
  loadHikouteiMcpConfig,
  resolveConfigPath,
} from "../src/config.js";

const VALID_CONFIG = {
  entities: [
    {
      name: "users",
      tableName: "users",
      properties: {
        id: { type: "string", primary: true },
        name: { type: "string" },
        age: { type: "number", nullable: true },
      },
    },
  ],
};

describe("hikoutei-mcp config loader", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeConfig(value: unknown, name = HIKOUTEI_MCP_CONFIG_FILE_NAME): string {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-mcp-config-"));
    tempDirs.push(dir);
    const path = join(dir, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  }

  it("accepts a valid config and parses it losslessly", async () => {
    const path = writeConfig(VALID_CONFIG);
    const result = await loadHikouteiMcpConfig(path);
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.sourcePath).toBe(path);
    expect(result.config.entities).toHaveLength(1);
    const entity = result.config.entities[0];
    expect(entity?.name).toBe("users");
    expect(entity?.tableName).toBe("users");
    expect(entity?.properties.id).toEqual({ type: "string", primary: true, nullable: false });
    expect(entity?.properties.age).toEqual({ type: "number", primary: false, nullable: true });
  });

  it("rejects a missing file with guidance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-mcp-config-"));
    tempDirs.push(dir);
    const result = await loadHikouteiMcpConfig(join(dir, "hikoutei.config.json"));
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain("not found");
      expect(result.reason).toContain("--config");
    }
  });

  it("rejects unparseable JSON", async () => {
    const path = writeConfig("{ not json");
    const result = await loadHikouteiMcpConfig(path);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain("not valid JSON");
    }
  });

  it("rejects a non-object envelope and an empty entities list", async () => {
    const array = await loadHikouteiMcpConfig(writeConfig([]));
    expect(array.status).toBe("invalid");

    const empty = await loadHikouteiMcpConfig(writeConfig({ entities: [] }));
    expect(empty.status).toBe("invalid");
    if (empty.status === "invalid") {
      expect(empty.reason).toContain("non-empty array");
    }
  });

  it("rejects unknown top-level and entity keys", async () => {
    const top = await loadHikouteiMcpConfig(writeConfig({ entities: VALID_CONFIG.entities, extra: 1 }));
    expect(top.status).toBe("invalid");
    if (top.status === "invalid") {
      expect(top.reason).toContain('"extra"');
    }

    const entity = await loadHikouteiMcpConfig(writeConfig({
      entities: [{ ...VALID_CONFIG.entities[0], routes: [] }],
    }));
    expect(entity.status).toBe("invalid");
    if (entity.status === "invalid") {
      expect(entity.reason).toContain('"routes"');
    }
  });

  it("rejects invalid identifiers and reserved tables", async () => {
    const badName = await loadHikouteiMcpConfig(writeConfig({
      entities: [{ name: "not a name", tableName: "t1", properties: { id: { type: "string", primary: true } } }],
    }));
    expect(badName.status).toBe("invalid");
    if (badName.status === "invalid") {
      expect(badName.reason).toContain("entities[0].name");
    }

    const reserved = await loadHikouteiMcpConfig(writeConfig({
      entities: [{ name: "e", tableName: "sqlite_sequence", properties: { id: { type: "string", primary: true } } }],
    }));
    expect(reserved.status).toBe("invalid");
    if (reserved.status === "invalid") {
      expect(reserved.reason).toContain("reserved by SQLite");
    }
  });

  it("rejects duplicate entity names and duplicate tables", async () => {
    const entity = {
      name: "users",
      tableName: "users",
      properties: { id: { type: "string", primary: true } },
    };
    const names = await loadHikouteiMcpConfig(writeConfig({
      entities: [entity, { ...entity, tableName: "other" }],
    }));
    expect(names.status).toBe("invalid");
    if (names.status === "invalid") {
      expect(names.reason).toContain("duplicate entity name");
    }

    const tables = await loadHikouteiMcpConfig(writeConfig({
      entities: [entity, { ...entity, name: "others" }],
    }));
    expect(tables.status).toBe("invalid");
    if (tables.status === "invalid") {
      expect(tables.reason).toContain("duplicate table name");
    }
  });

  it("rejects zero or multiple primaries and primary-with-nullable", async () => {
    const none = await loadHikouteiMcpConfig(writeConfig({
      entities: [{
        name: "e",
        tableName: "e",
        properties: { id: { type: "string" }, name: { type: "string" } },
      }],
    }));
    expect(none.status).toBe("invalid");
    if (none.status === "invalid") {
      expect(none.reason).toContain("exactly one");
    }

    const two = await loadHikouteiMcpConfig(writeConfig({
      entities: [{
        name: "e",
        tableName: "e",
        properties: {
          a: { type: "string", primary: true },
          b: { type: "string", primary: true },
        },
      }],
    }));
    expect(two.status).toBe("invalid");
    if (two.status === "invalid") {
      expect(two.status === "invalid");
      expect(two.reason).toContain("found 2");
    }

    const primaryNullable = await loadHikouteiMcpConfig(writeConfig({
      entities: [{
        name: "e",
        tableName: "e",
        properties: { id: { type: "string", primary: true, nullable: true } },
      }],
    }));
    expect(primaryNullable.status).toBe("invalid");
    if (primaryNullable.status === "invalid") {
      expect(primaryNullable.reason).toContain("primary and nullable");
    }
  });

  it("rejects unsupported property types and unknown property keys", async () => {
    const badType = await loadHikouteiMcpConfig(writeConfig({
      entities: [{
        name: "e",
        tableName: "e",
        properties: { id: { type: "datetime", primary: true } },
      }],
    }));
    expect(badType.status).toBe("invalid");
    if (badType.status === "invalid") {
      expect(badType.reason).toContain('"string", "number", "boolean", "date"');
    }

    const unknownKey = await loadHikouteiMcpConfig(writeConfig({
      entities: [{
        name: "e",
        tableName: "e",
        properties: { id: { type: "string", primary: true, unique: true } },
      }],
    }));
    expect(unknownKey.status).toBe("invalid");
    if (unknownKey.status === "invalid") {
      expect(unknownKey.reason).toContain('"unique"');
    }
  });

  it("resolves the config path from flag, env, then default", () => {
    const cwd = process.cwd();
    const fromFlag = resolveConfigPath(["--config", "/tmp/custom.json"], {});
    expect(fromFlag).toBe("/tmp/custom.json");

    const fromEnv = resolveConfigPath([], { HIKOUTEI_MCP_CONFIG: "/tmp/env.json" });
    expect(fromEnv).toBe("/tmp/env.json");

    const flagWins = resolveConfigPath(["--config", "/tmp/a.json"], { HIKOUTEI_MCP_CONFIG: "/tmp/b.json" });
    expect(flagWins).toBe("/tmp/a.json");

    const flagWithoutValue = resolveConfigPath(["--config"], { HIKOUTEI_MCP_CONFIG: "/tmp/b.json" });
    expect(flagWithoutValue).toBe("/tmp/b.json");

    const relative = resolveConfigPath(["--config", "nested/cfg.json"], {});
    expect(relative).toBe(join(cwd, "nested/cfg.json"));

    const fallback = resolveConfigPath([], {});
    expect(fallback?.endsWith(HIKOUTEI_MCP_CONFIG_FILE_NAME)).toBe(true);
  });
});
