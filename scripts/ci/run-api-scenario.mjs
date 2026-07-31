/**
 * Internal sync/gateway end-to-end scenario (NOT a public API smoke test).
 *
 * This script drives Hikoutei's internal typed-sheets sync pipeline against a
 * fake backend and, when live secrets are present, a real Google Sheets
 * backend. It exercises projection registration, gateway provisioning, the
 * bounded effect worker, polling, and the MikroORM-backed storage/CAS/hash
 * machinery end to end.
 *
 * The entrypoints it imports are internal implementation surface — the
 * gateway/polling/worker/storage providers plus the `hikoutei/orm` and
 * `hikoutei/mikro-orm` modules — not the public contract. The public contract
 * is the high-level `hikoutei` root API (Sheet configuration/registration and
 * a MikroORM-style entity lifecycle), which has not yet received its final
 * refactoring on `develop`. A dedicated public API CRUD smoke for that
 * contract will be added separately once it lands; until then, do not read
 * this scenario as public-contract coverage.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import { defineEntity, p } from "@mikro-orm/sql";
import {
  defineTypedSheetsEntityMapping,
  registeredTypedSheetsProjectionDefinitions,
  registerTypedSheetsEntityMappings,
} from "hikoutei/orm";
import {
  createMappedTypedSheetsOrm,
  initializeMikroOrmSqliteAdapter,
  initializeMappedTypedSheetsOrm,
  migrateMikroOrmSqliteStorageSchema,
  runSyncEffectWorkerWithAdapter,
} from "hikoutei/mikro-orm";
// This is an internal package-consumer harness, not application code. Resolve
// the built internal modules from the installed package without reopening the
// root public API that PR #138 intentionally narrows.
const packageEntry = import.meta.resolve("hikoutei");
const packageDist = new URL("./", packageEntry);
const [gateway, sync, encoding] = await Promise.all([
  import(new URL("./adapter/sheets/providers/apps-script-gateway/index.js", packageDist).href),
  import(new URL("./application/sync/index.js", packageDist).href),
  import(new URL("./shared/encoding/index.js", packageDist).href),
]);
const {
  AppsScriptOperationClient,
  AppsScriptOperationSyncGateway,
  AppsScriptSyncGatewayError,
} = gateway;
const {
  pollSimpleSheetRowsWithAdapter,
  provisionRegisteredSyncSheets,
} = sync;
const { stableHash } = encoding;

const SCENARIO_VERSION = "v1";
const INTERNAL_RECEIPT_SHEET = "__typed_sheets_internal_effect_receipts";
const PRESENT = "present";

const cleanupSource = `function (spreadsheet, args) {
  var names = Array.isArray(args && args.sheetNames) ? args.sheetNames : [];
  var removed = [];
  names.forEach(function (name) {
    var sheet = spreadsheet.getSheetByName(name);
    if (sheet === null) return;
    if (spreadsheet.getSheets().length > 1) {
      spreadsheet.deleteSheet(sheet);
      removed.push(name);
    } else {
      sheet.clearContents();
    }
  });
  var receipt = spreadsheet.getSheetByName(${JSON.stringify(INTERNAL_RECEIPT_SHEET)});
  if (receipt !== null) {
    if (spreadsheet.getSheets().length > 1) spreadsheet.deleteSheet(receipt);
    else receipt.clearContents();
  }
  return { removed: removed };
}`;

const mutateRowSource = `function (spreadsheet, args) {
  var sheet = spreadsheet.getSheetByName(args.sheetName);
  if (sheet === null) throw new Error("test sheet was not found: " + args.sheetName);
  var lastColumn = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2 || lastColumn < 1) throw new Error("test sheet has no data rows");
  var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (value) { return String(value); });
  var identityColumn = headers.indexOf(args.identityField);
  var fieldColumn = headers.indexOf(args.field);
  if (identityColumn < 0) throw new Error("test identity field was not found: " + args.identityField);
  if (fieldColumn < 0) throw new Error("test field was not found: " + args.field);
  var values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  for (var index = 0; index < values.length; index += 1) {
    if (String(values[index][identityColumn]) !== String(args.identity)) continue;
    values[index][fieldColumn] = args.value;
    sheet.getRange(index + 2, 1, 1, lastColumn).setValues([values[index]]);
    SpreadsheetApp.flush();
    return { rowNumber: index + 2 };
  }
  throw new Error("test identity row was not found: " + args.identity);
}`;

class FakeSyncGateway {
  constructor() {
    this.sheets = new Map();
    this.effects = new Map();
    this.calls = [];
  }

  async provisionRegistry(registrations) {
    const createdSheets = [];
    const initializedHeaders = [];
    for (const registration of registrations) {
      if (this.sheets.has(registration.sheetName)) continue;
      this.sheets.set(registration.sheetName, {
        physicalSheetId: registration.physicalSheetId ?? registration.sheetName,
        sheetName: registration.sheetName,
        registeredRange: registration.registeredRange,
        projection: registration.projection,
        schemaVersion: registration.schemaVersion,
        headers: [...registration.headers],
        identityField: registration.identityField,
        rows: [],
      });
      createdSheets.push(registration.sheetName);
      initializedHeaders.push(registration.sheetName);
    }
    return {
      registrations: registrations.map(({ headers: _headers, ...registration }) => registration),
      createdSheets,
      initializedHeaders,
    };
  }

  async fastAppendRows(request) {
    this.calls.push({ method: "fastAppendRows", count: request.rows.length });
    const sheet = this.requireSheet(request.sheetName);
    for (const row of request.rows) {
      sheet.rows.push({
        fields: this.completeFields(sheet.headers, row.fields),
        revision: 1,
      });
    }
    return {
      results: request.rows.map((row) => ({ effectId: row.effectId, status: "applied" })),
      hasMore: false,
    };
  }

  async applyEffects(request) {
    this.calls.push({ method: "applyEffects", count: request.effects.length });
    const sheet = this.requireSheet(request.sheetName);
    const results = request.effects.map((effect) => this.applyEffect(sheet, effect));
    return { results, snapshotHash: { kind: PRESENT, value: "fake-snapshot" }, hasMore: false };
  }

  async readEffectPostcondition(effect) {
    const receipt = this.effects.get(effect.effectId);
    if (receipt !== undefined) return receipt.postcondition;
    return {
      disposition: "unapplied",
      visibleRevision: present(effect.expectedVisibleRevision),
      visibleHash: present(effect.expectedVisibleHash),
      snapshotHash: absent(),
    };
  }

  async readEffectPostconditions(request) {
    this.calls.push({ method: "readEffectPostconditions", count: request.effects.length });
    return Promise.all(request.effects.map(async (effect) => ({
      effectId: effect.effectId,
      payloadHash: effect.payloadHash,
      postcondition: await this.readEffectPostcondition(effect),
    })));
  }

  async ensureRowAnchors(request) {
    const sheet = this.requireSheet(request.sheetName);
    return { assigned: 0, existing: sheet.rows.length, duplicateAnchors: [] };
  }

  async readSnapshot(request) {
    const sheet = this.requireSheet(request.sheetName);
    return {
      protocolVersion: "typed-sheets-sync-v1",
      sheetName: sheet.sheetName,
      registeredRange: sheet.registeredRange,
      projection: sheet.projection,
      schemaVersion: sheet.schemaVersion,
      headers: [...sheet.headers],
      rows: sheet.rows.map((row, index) => ({
        rowNumber: index + 2,
        physicalAnchor: absent(),
        visibleRevision: present(row.revision),
        visibleHash: absent(),
        cells: Object.fromEntries(Object.entries(row.fields).map(([field, value]) => [
          field,
          { normalizedCell: value, stableHash: absent() },
        ])),
      })),
      snapshotHash: "fake-snapshot",
      unanchoredRows: sheet.rows.map((_, index) => index + 2),
      duplicateAnchors: [],
    };
  }

  async readRows(request) {
    this.calls.push({ method: "readRows", count: 1 });
    const sheet = this.requireSheet(request.sheetName);
    return {
      sheetName: sheet.sheetName,
      registeredRange: sheet.registeredRange,
      headers: [...sheet.headers],
      rows: sheet.rows.map((row, index) => ({
        rowNumber: index + 2,
        fields: { ...row.fields },
      })),
    };
  }

  async readRowsBatch(requests) {
    this.calls.push({ method: "readRowsBatch", count: requests.length });
    return Promise.all(requests.map((request) => this.readRows(request)));
  }

  async mutateRow({ sheetName, identity, field, value }) {
    const sheet = this.requireSheet(sheetName);
    const row = sheet.rows.find((candidate) => cellValue(candidate.fields.id) === identity);
    if (row === undefined) throw new Error(`fake identity row was not found: ${identity}`);
    row.fields[field] = { kind: "string", value };
    row.revision += 1;
  }

  async cleanup() {
    this.sheets.clear();
    this.effects.clear();
  }

  readRequest(definition) {
    return requestForDefinition(definition);
  }

  createGateway() {
    return this;
  }

  applyEffect(sheet, effect) {
    const identity = cellValue(effect.payload.fields.id);
    const rowIndex = sheet.rows.findIndex((candidate) => cellValue(candidate.fields.id) === identity);
    const isDeletion = effect.effectKind === "user_input_delete" || effect.effectKind === "resolution_delete";
    if (isDeletion) {
      if (rowIndex >= 0 && visibleHash(sheet.rows[rowIndex].fields, effect.payload.fields) !== effect.expectedVisibleHash) {
        return this.effectResult(effect, "guard_mismatch", sheet.rows[rowIndex].revision, visibleHash(sheet.rows[rowIndex].fields, effect.payload.fields), "visible guard mismatch");
      }
      if (rowIndex >= 0) sheet.rows.splice(rowIndex, 1);
    } else if (rowIndex < 0) {
      if (!effect.payload.createIfMissing) {
        return this.effectResult(effect, "guard_mismatch", effect.expectedVisibleRevision, effect.expectedVisibleHash, "target row was not found");
      }
      if (effect.expectedVisibleRevision !== 0 || effect.expectedVisibleHash !== "") {
        return this.effectResult(effect, "guard_mismatch", 0, "", "insert requires an empty visible baseline");
      }
      sheet.rows.push({ fields: this.completeFields(sheet.headers, effect.payload.fields), revision: effect.expectedVisibleRevision + 1 });
    } else {
      const currentHash = visibleHash(sheet.rows[rowIndex].fields, effect.payload.fields);
      if (currentHash === effect.payload.targetVisibleHash) {
        return this.effectResult(effect, "already_applied", sheet.rows[rowIndex].revision, currentHash, null);
      }
      if (currentHash !== effect.expectedVisibleHash) {
        return this.effectResult(effect, "guard_mismatch", sheet.rows[rowIndex].revision, currentHash, "visible guard mismatch");
      }
      sheet.rows[rowIndex].fields = this.completeFields(sheet.headers, effect.payload.fields);
      sheet.rows[rowIndex].revision += 1;
    }
    const result = this.effectResult(
      effect,
      "applied",
      effect.expectedVisibleRevision + 1,
      effect.payload.targetVisibleHash,
      null,
    );
    this.effects.set(effect.effectId, {
      payloadHash: effect.payloadHash,
      postcondition: {
        disposition: "applied",
        visibleRevision: present(effect.expectedVisibleRevision + 1),
        visibleHash: present(effect.payload.targetVisibleHash),
        snapshotHash: absent(),
      },
    });
    return result;
  }

  effectResult(effect, status, revision, hash, reason) {
    return {
      effectId: effect.effectId,
      payloadHash: effect.payloadHash,
      status,
      visibleRevision: present(revision),
      visibleHash: present(hash),
      snapshotHash: absent(),
      reason: reason === null ? absent() : present(reason),
      postcondition: status === "applied" ? "acknowledged" : "unavailable",
    };
  }

  completeFields(headers, fields) {
    return Object.fromEntries(headers.map((header) => [header, fields[header] ?? null]));
  }

  requireSheet(sheetName) {
    const sheet = this.sheets.get(sheetName);
    if (sheet === undefined) throw new Error(`fake sheet was not provisioned: ${sheetName}`);
    return sheet;
  }
}

class LiveSyncBackend {
  constructor() {
    const url = requireEnvironment("TYPED_SHEETS_GATEWAY_URL");
    const secret = requireEnvironment("TYPED_SHEETS_GATEWAY_SHARED_SECRET");
    const sheetId = requireEnvironment("TYPED_SHEETS_GATEWAY_SHEET_ID");
    this.events = [];
    this.client = new AppsScriptOperationClient({
      url,
      secret,
      sheetId,
      actorId: `hikoutei-ci-${process.env.GITHUB_RUN_ID ?? "local"}`,
      // Live Apps Script calls can exceed the default client timeout during quota or network latency.
      requestTimeoutMs: 120_000,
      onRequest: (event) => this.events.push(event),
    });
  }

  createGateway(definitions) {
    return new AppsScriptOperationSyncGateway({
      operationGateway: this.client,
      definitions,
    });
  }

  async mutateRow({ sheetName, identity, field, value }) {
    await this.client.applyOperations([{
      fn: mutateRowSource,
      args: {
        sheetName,
        identityField: "id",
        identity,
        field,
        value,
      },
    }]);
  }

  async cleanup(sheetNames) {
    // A timed-out Apps Script request may still be finishing remotely. Retry
    // idempotent cleanup so the scenario does not report a false failure while
    // the workflow's always-run cleanup step remains the final safety net.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.client.applyOperations([{
          fn: cleanupSource,
          args: { sheetNames },
        }]);
        return;
      } catch (error) {
        const retryable = error instanceof AppsScriptSyncGatewayError &&
          error.code === "sync_gateway_timeout";
        if (!retryable || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 2_000));
      }
    }
  }

  readRequest(definition) {
    return requestForDefinition(definition);
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.cleanupOnly) {
    await cleanupFromManifest(options);
    return;
  }
  if (options.backend !== "fake" && options.backend !== "live") {
    throw new Error("--backend must be fake or live");
  }

  const startedAt = new Date().toISOString();
  const startedClock = performance.now();
  const prefix = options.prefix ?? createPrefix(options.backend);
  const sheetNames = [`${prefix}_System`, `${prefix}_Input`];
  const manifest = {
    version: SCENARIO_VERSION,
    backend: options.backend,
    prefix,
    sheetNames,
    createdAt: startedAt,
  };
  await writeJson(options.manifest, manifest);

  const backend = options.backend === "live" ? new LiveSyncBackend() : new FakeSyncGateway();
  const steps = [];
  const timings = [];
  let runtime;
  let scenarioError;
  let cleanupError;
  let assertions = 0;

  const measure = async (name, phase, operation) => {
    const stepStartedAt = performance.now();
    try {
      const result = await operation();
      const durationMs = elapsedMs(stepStartedAt);
      const entry = { name, phase, durationMs, status: "passed" };
      steps.push(entry);
      timings.push(entry);
      return result;
    } catch (error) {
      const entry = {
        name,
        phase,
        durationMs: elapsedMs(stepStartedAt),
        status: "failed",
        error: errorMessage(error),
      };
      steps.push(entry);
      timings.push(entry);
      throw error;
    }
  };

  try {
    runtime = await measure("runtime_setup", "setup", () => createRuntime({
      backend,
      prefix,
      sheetNames,
      recordTiming: (event) => timings.push({ phase: "internal", ...event }),
    }));
    const { orm, storage, gateway, definitions, entity, mapping } = runtime;
    const systemDefinition = requireDefinition(definitions, "system_state");
    const userDefinition = requireDefinition(definitions, "user_input");
    const em = orm.em.fork();
    const entityId = `${prefix}-order-1`;

    await measure("initialize_mapped_orm", "setup", () => smokeInitializeMappedOrm({
      entity,
      mapping,
      prefix,
    }));

    await measure("create_and_flush", "steady_state", async () => {
      const order = em.create(entity, { id: entityId, status: "pending" });
      em.persist(order);
      await em.flush();
      assertions += 1;
    });
    await measure("worker_after_create", "steady_state", async () => {
      const reports = await runWorkerUntilIdle(storage, gateway, `${prefix}-worker`);
      assert.equal(reports.at(-1)?.selected ?? 0, 0);
      assertions += 1;
    });
    await measure("read_after_create", "steady_state", async () => {
      const loaded = await em.findOne(entity, { id: entityId });
      assert.notEqual(loaded, null);
      assert.equal(loaded.status, "pending");
      const rows = await gateway.readRows(backend.readRequest(systemDefinition));
      assert.equal(rows.rows.length, 1);
      assert.equal(cellValue(rows.rows[0]?.fields.id), entityId);
      assertions += 3;
    });
    const loaded = await em.findOne(entity, { id: entityId });
    assert.notEqual(loaded, null);

    await measure("update_and_flush", "steady_state", async () => {
      loaded.status = "paid";
      await em.flush();
      assertions += 1;
    });
    await measure("worker_after_update", "steady_state", async () => {
      const reports = await runWorkerUntilIdle(storage, gateway, `${prefix}-worker`);
      assert.equal(reports.at(-1)?.selected ?? 0, 0);
      assertions += 1;
    });
    await measure("read_after_update", "steady_state", async () => {
      const readBack = await em.findOne(entity, { id: entityId });
      assert.notEqual(readBack, null);
      assert.equal(readBack.status, "paid");
      assertions += 2;
    });

    await measure("polling_changed_row", "steady_state", async () => {
      await backend.mutateRow({
        sheetName: userDefinition.sheet.tabName,
        identity: entityId,
        field: "status",
        value: "edited-by-user",
      });
      const result = await pollSimpleSheetRowsWithAdapter({
        storage,
        gateway,
        definitions: [userDefinition],
      });
      assert.equal(result.rowsScanned, 1);
      assert.equal(result.changedRows.length, 1);
      assert.deepEqual(result.changedRows[0]?.fields.status, {
        kind: "string",
        value: "edited-by-user",
      });
      assertions += 3;
    });
    await measure("polling_restored_row", "steady_state", async () => {
      await backend.mutateRow({
        sheetName: userDefinition.sheet.tabName,
        identity: entityId,
        field: "status",
        value: "paid",
      });
      const result = await pollSimpleSheetRowsWithAdapter({
        storage,
        gateway,
        definitions: [userDefinition],
      });
      assert.equal(result.rowsScanned, 1);
      assert.equal(result.changedRows.length, 0);
      assertions += 2;
    });

    await measure("delete_and_flush", "steady_state", async () => {
      em.remove(loaded);
      await em.flush();
      assertions += 1;
    });
    await measure("worker_after_delete", "steady_state", async () => {
      const reports = await runWorkerUntilIdle(storage, gateway, `${prefix}-worker`);
      assert.equal(reports.at(-1)?.selected ?? 0, 0);
      assertions += 1;
    });
    await measure("read_after_delete", "steady_state", async () => {
      const readBack = await em.findOne(entity, { id: entityId });
      assert.equal(readBack, null);
      const userRows = await gateway.readRows(backend.readRequest(userDefinition));
      assert.equal(userRows.rows.length, 0);
      const systemRows = await gateway.readRows(backend.readRequest(systemDefinition));
      assert.equal(systemRows.rows.length, 1);
      assert.deepEqual(systemRows.rows[0]?.fields.__typed_sheets_deleted, {
        kind: "boolean",
        value: true,
      });
      assertions += 4;
    });

    // Keep the mapping in the result so a future scenario can report which
    // internal route was exercised without importing source-only test helpers.
    void mapping;
  } catch (error) {
    scenarioError = error;
  } finally {
    if (runtime !== undefined) {
      try {
        await runtime.orm.close(true);
      } catch (error) {
        cleanupError = error;
      }
      await rm(runtime.tempRoot, { recursive: true, force: true });
    }
    try {
      await backend.cleanup(sheetNames);
    } catch (error) {
      cleanupError = cleanupError ?? error;
    }
  }

  const report = createReport({
    backend: options.backend,
    prefix,
    startedAt,
    durationMs: elapsedMs(startedClock),
    steps,
    assertions,
    scenarioError,
    cleanupError,
    gatewayEvents: backend.events ?? backend.calls,
  });
  await writeJson(options.output, report);
  await writeSummary(options.summary, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (scenarioError !== undefined) throw scenarioError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function createRuntime({ backend, prefix, sheetNames, recordTiming }) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hikoutei-ci-"));
  const dbName = path.join(tempRoot, "scenario.sqlite");
  const spreadsheetId = backend instanceof LiveSyncBackend ? requireEnvironment("TYPED_SHEETS_GATEWAY_SHEET_ID") : `fake-${prefix}`;
  const OrderSchema = defineEntity({
    name: "CiOrder",
    tableName: "ci_orders",
    properties: {
      id: p.string().primary(),
      status: p.string(),
    },
  });
  class CiOrder extends OrderSchema.class {}
  OrderSchema.setClass(CiOrder);

  const mapping = defineTypedSheetsEntityMapping({
    entity: CiOrder,
    entityName: "CiOrder",
    logicalSheetId: `${prefix}-orders`,
    primaryKey: "id",
    businessKey: "id",
    schemaVersion: 1,
    fields: [
      {
        property: "id",
        cellKind: "string",
        ownership: "user",
        required: true,
        unique: true,
      },
      {
        property: "status",
        cellKind: "string",
        ownership: "user",
        required: true,
      },
    ],
    projections: [
      {
        physicalSheetId: `${prefix}-orders-system`,
        spreadsheetId,
        tabName: sheetNames[0],
        registeredRange: "A:C",
        projection: "system_state",
      },
      {
        physicalSheetId: `${prefix}-orders-input`,
        spreadsheetId,
        tabName: sheetNames[1],
        registeredRange: "A:B",
        projection: "user_input",
      },
    ],
  });
  const writer = {
    writerId: `${prefix}-writer`,
    role: `${prefix}-writer-role`,
    leaseDurationMs: 60_000,
    onTiming: recordTiming,
  };

  let storage;
  try {
    storage = await initializeMikroOrmSqliteAdapter({
      dbName,
      entities: [CiOrder],
    });
    await migrateMikroOrmSqliteStorageSchema(storage);
    const registrations = await registerTypedSheetsEntityMappings(storage, [mapping], writer);
    const definitions = registeredTypedSheetsProjectionDefinitions(registrations);
    const gateway = backend.createGateway(definitions);
    await provisionRegisteredSyncSheets(gateway, definitions);
    const orm = createMappedTypedSheetsOrm(storage, {
      mappings: [mapping],
      writer,
    });
    return {
      tempRoot,
      storage,
      orm,
      gateway,
      definitions,
      entity: CiOrder,
      mapping,
    };
  } catch (error) {
    if (storage !== undefined) await storage.close(true);
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function smokeInitializeMappedOrm({ entity, mapping, prefix }) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "hikoutei-ci-init-"));
  try {
    const orm = await initializeMappedTypedSheetsOrm({
      dbName: path.join(tempRoot, "initializer.sqlite"),
      entities: [entity],
      mappings: [mapping],
      writer: {
        writerId: `${prefix}-initializer-smoke`,
      },
    });
    await orm.close(true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runWorkerUntilIdle(storage, gateway, workerId) {
  const reports = [];
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const report = await runSyncEffectWorkerWithAdapter({
      storage,
      gateway,
      workerId,
      now: Date.now(),
      maxEffects: 100,
    });
    reports.push(report);
    if (report.selected === 0) return reports;
    if (report.failed > 0 || report.conflicted > 0) {
      throw new Error(`sync worker did not apply all effects: ${JSON.stringify(report)}`);
    }
  }
  throw new Error("sync worker did not become idle within ten passes");
}

async function cleanupFromManifest(options) {
  if (options.backend !== "live") {
    process.stdout.write("cleanup-only is only needed for the live backend\n");
    return;
  }
  if (options.manifest === undefined || !existsSync(options.manifest)) {
    process.stdout.write("live cleanup manifest was not found; nothing to clean\n");
    return;
  }
  const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
  const backend = new LiveSyncBackend();
  await backend.cleanup(manifest.sheetNames);
  process.stdout.write(`cleaned live fixture ${manifest.prefix}\n`);
}

function createReport({
  backend,
  prefix,
  startedAt,
  durationMs,
  steps,
  assertions,
  scenarioError,
  cleanupError,
  gatewayEvents,
}) {
  const setupMs = sumStepDuration(steps, "setup");
  const steadyStateSteps = steps.filter((step) => step.phase === "steady_state");
  const steadyStateMs = sumStepDuration(steadyStateSteps);
  const status = scenarioError === undefined && cleanupError === undefined ? "passed" : "failed";
  return {
    scenario: "internal-sync-gateway-e2e-lifecycle-and-polling",
    scenarioVersion: SCENARIO_VERSION,
    backend,
    status,
    prefix,
    startedAt,
    durationMs: roundMs(durationMs),
    setupMs: roundMs(setupMs),
    steadyStateMs: roundMs(steadyStateMs),
    steps: steps.map((step) => ({ ...step, durationMs: roundMs(step.durationMs) })),
    assertions,
    gatewayEvents,
    error: scenarioError === undefined ? undefined : errorMessage(scenarioError),
    cleanupError: cleanupError === undefined ? undefined : errorMessage(cleanupError),
  };
}

async function writeSummary(summaryPath, report) {
  if (summaryPath === undefined) return;
  const lines = [
    `## Hikoutei internal sync/gateway E2E (${report.backend})`,
    "",
    `- Status: **${report.status}**`,
    `- Total: ${report.durationMs} ms`,
    `- Setup: ${report.setupMs} ms`,
    `- Steady state: ${report.steadyStateMs} ms`,
    `- Assertions: ${report.assertions}`,
    "",
    "| Step | Phase | Duration (ms) | Status |",
    "| --- | --- | ---: | --- |",
    ...report.steps.map((step) => `| ${step.name} | ${step.phase} | ${step.durationMs} | ${step.status} |`),
    "",
  ];
  await appendFile(summaryPath, `${lines.join("\n")}\n`);
}

function parseOptions(arguments_) {
  const options = {
    backend: undefined,
    cleanupOnly: false,
    manifest: process.env.HIKOUTEI_CI_MANIFEST,
    output: process.env.HIKOUTEI_CI_OUTPUT,
    summary: process.env.GITHUB_STEP_SUMMARY,
    prefix: undefined,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--cleanup-only") {
      options.cleanupOnly = true;
      continue;
    }
    const [key, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? arguments_[++index];
    if (key === "--backend") options.backend = value;
    else if (key === "--manifest") options.manifest = value;
    else if (key === "--output") options.output = value;
    else if (key === "--summary") options.summary = value;
    else if (key === "--prefix") options.prefix = value;
    else throw new Error(`unknown option: ${argument}`);
  }
  if (options.output === undefined) options.output = path.join(os.tmpdir(), "hikoutei-ci-result.json");
  if (options.manifest === undefined) options.manifest = path.join(os.tmpdir(), "hikoutei-ci-manifest.json");
  return options;
}

function createPrefix(backend) {
  const runId = process.env.GITHUB_RUN_ID ?? "local";
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  return `ci_${backend}_${runId}_${attempt}_${Date.now().toString(36)}`;
}

function requestForDefinition(definition) {
  return {
    physicalSheetId: definition.sheet.physicalSheetId,
    sheetName: definition.sheet.tabName,
    registeredRange: definition.sheet.registeredRange,
    projection: definition.sheet.projection,
    schemaVersion: definition.sheet.schemaVersion,
    headers: definition.headers,
  };
}

function requireDefinition(definitions, projection) {
  const definition = definitions.find((candidate) => candidate.sheet.projection === projection);
  if (definition === undefined) throw new Error(`projection definition not found: ${projection}`);
  return definition;
}

function present(value) {
  return { kind: PRESENT, value };
}

function absent() {
  return { kind: "absent" };
}

function cellValue(cell) {
  return cell === null || cell === undefined ? undefined : cell.value;
}

function visibleHash(currentFields, selectedFields) {
  const fields = Object.keys(selectedFields)
    .sort()
    .map((fieldName) => ({ fieldName, value: currentFields[fieldName] ?? null }));
  return stableHash({ fields });
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function elapsedMs(startedAt) {
  return performance.now() - startedAt;
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

function sumStepDuration(steps, phase) {
  return steps
    .filter((step) => phase === undefined || step.phase === phase)
    .reduce((sum, step) => sum + step.durationMs, 0);
}

function errorMessage(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function writeJson(filePath, value) {
  if (filePath === undefined) return;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});
