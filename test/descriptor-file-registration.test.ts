/**
 * File-form descriptor registration tests (issue #514 work items 1 + 3).
 *
 * Proves the `infer --emit` JSON file flows through the same
 * `defineTypedSheetsEntity` builder as code-registered entities: schema
 * validation (version tag + scalar rules), startup registration via
 * `createTypedSheets({ descriptors })` with local CRUD, option validation,
 * and end-to-end sync-projection delivery through the stub transport — all
 * credential-free.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDescriptorFile,
  createTypedSheets,
  defineTypedSheetsEntity,
  defineTypedSheetsEntityFromDescriptorFile,
  descriptorFileColumnMap,
  HIKOUTEI_DESCRIPTOR_FILE_VERSION,
  HIKOUTEI_ERROR_CODES,
  HikouteiError,
  parseDescriptorFile,
  serializeDescriptorFile,
  type Hikoutei,
  type HikouteiDescriptorFile,
} from "../src/index.js";
import {
  createTypedSheetsWithSync,
  SYNC_ENV_KEYS,
} from "@hikoutei/composition/syncAutoStart.js";
import type { InternalSyncService } from "@hikoutei/sync-engine/sync/service/SyncServiceBootstrap.js";
import {
  StubSheetsTransport,
  StubSpreadsheet,
} from "./support/StubSheetsTransport.js";

/** Descriptor file fixture: the exact shape `infer --emit` writes. */
function widgetFile(): HikouteiDescriptorFile {
  return {
    hikouteiDescriptor: 1,
    name: "DescFileWidget",
    tableName: "desc_file_widgets",
    properties: {
      widgetNo: { header: "Widget No", type: "string", primary: true },
      total: { header: "Total", type: "number" },
    },
  };
}

describe("parseDescriptorFile", () => {
  it("round-trips the builder output through JSON", () => {
    const file = buildDescriptorFile({
      name: "DescFileWidget",
      tableName: "desc_file_widgets",
      columns: [
        { property: "widgetNo", header: "Widget No", type: "string", primary: true },
        { property: "total", header: "Total", type: "number", primary: false },
      ],
    });
    expect(file.hikouteiDescriptor).toBe(HIKOUTEI_DESCRIPTOR_FILE_VERSION);
    const parsed = parseDescriptorFile(JSON.parse(serializeDescriptorFile(file)));
    expect(parsed).toEqual(widgetFile());
    expect(descriptorFileColumnMap(parsed)).toEqual({
      "Widget No": "widgetNo",
      Total: "total",
    });
  });

  it("rejects version mismatches with a stable code", () => {
    for (const version of [0, 2, "1", undefined, null]) {
      // Through JSON so the mistyped tag reaches the runtime validator.
      const input: unknown = JSON.parse(
        JSON.stringify({ ...widgetFile(), hikouteiDescriptor: version }),
      );
      const error = captureThrow(() => parseDescriptorFile(input));
      expect(error).toBeInstanceOf(HikouteiError);
      expect((error as HikouteiError).code).toBe(HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR);
      expect((error as Error).message).toContain("version");
    }
  });

  it("rejects malformed files with the builder's error code", () => {
    const cases: unknown[] = [
      null,
      [],
      { ...widgetFile(), properties: {} },
      { ...widgetFile(), name: "  " },
      {
        ...widgetFile(),
        properties: { widgetNo: { header: "Widget No", type: "bigint", primary: true } },
      },
      {
        ...widgetFile(),
        properties: { widgetNo: { header: "", type: "string", primary: true } },
      },
      {
        ...widgetFile(),
        properties: {
          widgetNo: { header: "Widget No", type: "string", primary: true },
          total: { header: "Total", type: "string", primary: true },
        },
      },
      {
        ...widgetFile(),
        properties: { widgetNo: { header: "Widget No", type: "boolean", primary: true } },
      },
      {
        ...widgetFile(),
        properties: {
          widgetNo: { header: "Widget No", type: "string", primary: true, relation: "x" },
        },
      },
    ];
    for (const input of cases) {
      const error = captureThrow(() => parseDescriptorFile(input));
      expect(error).toBeInstanceOf(HikouteiError);
      expect((error as HikouteiError).code).toBe(HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR);
    }
  });
});

describe("createTypedSheets({ descriptors })", () => {
  const runtimes: Hikoutei[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("registers the file through the same builder and runs CRUD", async () => {
    const file = parseDescriptorFile(JSON.parse(serializeDescriptorFile(widgetFile())));
    const token = defineTypedSheetsEntityFromDescriptorFile(file);
    const hikoutei = await createTypedSheets({
      dbName: ":memory:",
      entities: [],
      descriptors: [file],
    });
    runtimes.push(hikoutei);

    const em = hikoutei.em.fork();
    em.persist(em.create(token, { widgetNo: "w1", total: 10 }));
    await em.flush();
    await expect(em.findOne(token, { widgetNo: "w1" })).resolves.toMatchObject({
      widgetNo: "w1",
      total: 10,
    });

    const loaded = await em.findOne(token, { widgetNo: "w1" });
    if (loaded === null) throw new Error("expected the file-registered row");
    // File-built tokens carry `object` as the phantom entity type (no TS
    // generics at runtime), so the mutation goes through a narrow cast.
    (loaded as { total: number }).total = 11;
    await em.flush();
    await expect(hikoutei.em.fork().findOne(token, { widgetNo: "w1" })).resolves.toMatchObject({
      total: 11,
    });

    em.remove(loaded);
    await em.flush();
    await expect(em.findOne(token, { widgetNo: "w1" })).resolves.toBeNull();
  });

  it("rejects a non-array descriptors option with a stable code", async () => {
    await expect(
      createTypedSheets({ dbName: ":memory:", entities: [], descriptors: "nope" as never }),
    ).rejects.toMatchObject({ code: HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR });
  });

  it("rejects a name collision between entities and descriptors", async () => {
    const codeEntity = defineTypedSheetsEntity({
      name: "DescFileCollision",
      tableName: "desc_file_collision_code",
      properties: { id: { type: "string", primary: true } },
    });
    const file: HikouteiDescriptorFile = {
      hikouteiDescriptor: 1,
      name: "DescFileCollision",
      tableName: "desc_file_collision_file",
      properties: { id: { header: "Id", type: "string", primary: true } },
    };
    await expect(
      createTypedSheets({ dbName: ":memory:", entities: [codeEntity], descriptors: [file] }),
    ).rejects.toMatchObject({ code: HIKOUTEI_ERROR_CODES.DUPLICATE_ENTITY });
  });
});

describe("descriptors through the sync bridge (stub transport)", () => {
  const services: InternalSyncService[] = [];
  const tempDirs: string[] = [];
  const dbFiles: string[] = [];

  afterEach(async () => {
    await Promise.all(
      services.splice(0).map((service) => service.close().catch(() => undefined)),
    );
    await Promise.all(
      dbFiles.splice(0).flatMap((db) => [
        unlink(db),
        unlink(`${db}-wal`),
        unlink(`${db}-shm`),
      ]).map((promise) => promise.catch(() => undefined)),
    );
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function credentialsPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-desc-"));
    tempDirs.push(dir);
    const path = join(dir, "service-account.json");
    writeFileSync(path, JSON.stringify({
      type: "service_account",
      project_id: "hikoutei-test",
      private_key_id: "k1",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
      client_email: "desc-test@example.com",
      client_id: "123456",
      token_uri: "https://oauth2.googleapis.com/token",
    }));
    return path;
  }

  /** Column-A string values of one stub tab (row 1 = header). */
  function tabFirstColumn(tab: { cells: Map<string, { userEnteredValue?: Record<string, unknown> }> }): Set<string> {
    const ids = new Set<string>();
    for (const [key, cell] of tab.cells) {
      const [row, col] = key.split(",").map(Number);
      if (col !== 0 || row === 0) continue;
      const value = cell.userEnteredValue?.stringValue;
      if (typeof value === "string") ids.add(value);
    }
    return ids;
  }

  it("delivers a file-registered entity's outbox to the projection rows", async () => {
    const file = parseDescriptorFile(JSON.parse(serializeDescriptorFile(widgetFile())));
    const spreadsheet = new StubSpreadsheet();
    const dbName = join(tmpdir(), `hikoutei-desc-${randomUUID()}.sqlite`);
    dbFiles.push(dbName);
    const result = await createTypedSheetsWithSync({
      dbName,
      entities: [],
      descriptors: [file],
      env: {
        [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/spreadsheets/d/desc-test-1/edit",
        [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath(),
        [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "3600000",
      },
      transport: new StubSheetsTransport(spreadsheet),
    });
    if (result.kind !== "sync") throw new Error(`expected a sync result, got ${result.kind}`);
    services.push(result.service);

    // The test-side token carries the same descriptor the bridge registered.
    const token = defineTypedSheetsEntityFromDescriptorFile(file);
    const em = result.hikoutei.em.fork();
    em.persist(em.create(token, { widgetNo: "w9", total: 42 }));
    await em.flush();

    for (let pass = 0; pass < 6; pass += 1) {
      await result.service.effectSupervisor.runOnce();
      const pending = await result.service.storage.read(({ sql }) =>
        sql.get<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE status = 'pending'",
        ));
      if ((pending?.count ?? 0) === 0) break;
      if (pass === 5) throw new Error("effect outbox did not drain within the pass budget");
    }

    const tab = spreadsheet.findTab("DescFileWidget_Input");
    expect(tab).toBeDefined();
    expect(tabFirstColumn(tab!)).toContain("w9");
    await expect(em.findOne(token, { widgetNo: "w9" })).resolves.toMatchObject({ total: 42 });
  }, 60000);
});

/** Runs `fn` and returns the thrown error (fails the test when nothing throws). */
function captureThrow(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected the function to throw");
}
