/**
 * Internal sync/gateway end-to-end scenario (NOT a public API smoke test).
 *
 * This script drives Hikoutei's internal typed-sheets sync pipeline against a
 * fake backend and, when live secrets are present, a real Google Sheets
 * backend. It exercises projection registration, gateway provisioning, the
 * bounded effect worker, polling, and the MikroORM-backed storage/CAS/hash
 * machinery end to end.
 *
 * The scenario loads implementation modules directly from the installed
 * package's `dist/` tree. The `hikoutei/orm` and `hikoutei/mikro-orm` package
 * subpaths are intentionally rejected; the public contract is the high-level
 * `hikoutei` root API. This scenario remains focused on internal sync/gateway
 * behavior rather than public API CRUD coverage.
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
// This is an internal package-consumer harness, not application code. Resolve
// the implementation modules directly from the installed package; only the
// root `hikoutei` entrypoint is an application-facing export.
const packageEntry = import.meta.resolve("hikoutei");
const packageDist = new URL("./", packageEntry);
const [mapping, flush, mappedRuntime, sqliteAdapter, sqliteSchema, polling, provisioning, worker, gateway, encoding] =
  await Promise.all([
    import(new URL("./application/orm/mapping/entityMapping.js", packageDist).href),
    import(new URL("./application/orm/persistence/flush/flushCoordinator.js", packageDist).href),
    import(new URL("./adapter/persistence/providers/mikro-orm/engine/MikroOrmMappedTypedSheets.js", packageDist).href),
    import(new URL("./adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js", packageDist).href),
    import(new URL("./adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js", packageDist).href),
    import(new URL("./application/sync/inbound/polling/SimpleSheetPolling.js", packageDist).href),
    import(new URL("./application/sync/gateway/SyncGatewayBootstrap.js", packageDist).href),
    import(new URL("./application/sync/outbound/effects/SyncEffectWorker.js", packageDist).href),
    import(new URL("./adapter/sheets/providers/apps-script-gateway/index.js", packageDist).href),
    import(new URL("./shared/encoding/index.js", packageDist).href),
  ]);
const { defineTypedSheetsEntityMapping } = mapping;
const { registeredTypedSheetsProjectionDefinitions, registerTypedSheetsEntityMappings } = flush;
const { createMappedTypedSheetsOrm, initializeMappedTypedSheetsOrm } = mappedRuntime;
const { initializeMikroOrmSqliteAdapter } = sqliteAdapter;
const { migrateMikroOrmSqliteStorageSchema } = sqliteSchema;
const { pollSimpleSheetRowsWithAdapter } = polling;
const { provisionRegisteredSyncSheets } = provisioning;
const { runSyncEffectWorkerWithAdapter } = worker;
const { stableHash } = encoding;
const {
  AppsScriptOperationClient,
  AppsScriptOperationSyncGateway,
  AppsScriptSyncGatewayError,
} = gateway;
const [directSheets, mappedPolling] = await Promise.all([
  import(new URL("./adapter/sheets/providers/google-sheets-api/index.js", packageDist).href),
  import(new URL("./adapter/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js", packageDist).href),
]);
const { GoogleSheetsApiSyncProvider, GoogleSheetsApiHttpTransport } = directSheets;
const { pollMappedUserInputWithMikroOrm } = mappedPolling;

await assertLegacyPackageSubpathsUnavailable();

async function assertLegacyPackageSubpathsUnavailable() {
  for (const subpath of ["orm", "mikro-orm"]) {
    await assert.rejects(
      () => import(`hikoutei/${subpath}`),
      (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
  }
}

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
    // Mirror the built-in append operation contract: each result carries
    // receipt-backed visible evidence (revision 1 and the hash of the written
    // full-header row) so the effect worker can close the outbox entry.
    const results = request.rows.map((row) => {
      const fields = this.completeFields(sheet.headers, row.fields);
      sheet.rows.push({ fields, revision: 1 });
      return {
        effectId: row.effectId,
        status: "applied",
        visibleRevision: 1,
        visibleHash: visibleHash(fields, fields),
      };
    });
    return { results, hasMore: false };
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
  constructor(outbound) {
    this.outbound = outbound ?? "gateway";
    this.sheetMatched = undefined;
    this.events = [];
    if (this.outbound === "direct") {
      // Service-account-only full-provider mode: no Apps Script gateway is
      // involved at all. ADC supplies the service account; the spreadsheet
      // must be shared with it. No TYPED_SHEETS_GATEWAY_* variables are read.
      requireEnvironment("GOOGLE_APPLICATION_CREDENTIALS");
      this.sheetId = requireEnvironment("GOOGLE_SHEETS_TEST_SPREADSHEET_ID");
      this.sheetMatched = true;
      this.saTransport = new GoogleSheetsApiHttpTransport({ requestTimeoutMs: 120_000 });
      return;
    }
    const url = requireEnvironment("TYPED_SHEETS_GATEWAY_URL");
    const secret = requireEnvironment("TYPED_SHEETS_GATEWAY_SHARED_SECRET");
    const sheetId = requireEnvironment("TYPED_SHEETS_GATEWAY_SHEET_ID");
    this.sheetId = sheetId;
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
    if (this.outbound === "direct") {
      // The full service-account provider owns provisioning, outbound
      // effects, table reads, anchors, and snapshots in one instance.
      return new GoogleSheetsApiSyncProvider({
        spreadsheetId: this.sheetId,
        definitions,
        requestTimeoutMs: 120_000,
        onRequest: (event) => this.events.push(event),
      });
    }
    // Legacy Apps Script gateway mode.
    return new AppsScriptOperationSyncGateway({
      operationGateway: this.client,
      definitions,
    });
  }

  async mutateRow({ sheetName, identity, field, value }) {
    if (this.outbound === "direct") {
      await this.mutateRowDirect({ sheetName, identity, field, value });
      return;
    }
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

  /**
   * Simulates a human edit with the service-account transport: locate the
   * tab, find the row by its identity cell, and overwrite one field cell
   * through an updateCells batchUpdate.
   */
  async mutateRowDirect({ sheetName, identity, field, value }) {
    const raw = await this.saTransport.getSpreadsheet({
      spreadsheetId: this.sheetId,
      ranges: [`${quoteTabName(sheetName)}!A1:B1048576`],
      fields: "sheets.properties(sheetId,title),sheets.data(startRow,startColumn,rowData.values(userEnteredValue,formattedValue))",
    });
    const sheetEntry = (raw?.sheets ?? []).find((entry) =>
      entry?.properties?.title === sheetName);
    if (sheetEntry === undefined) {
      throw new Error(`test sheet was not found: ${sheetName}`);
    }
    const grid = (sheetEntry.data ?? [])[0];
    const rows = grid?.rowData ?? [];
    const headers = (rows[0]?.values ?? []).map((cell) =>
      String(cell?.userEnteredValue?.stringValue ?? ""));
    const identityColumn = headers.indexOf("id");
    const fieldColumn = headers.indexOf(field);
    if (identityColumn < 0) throw new Error("test identity field was not found: id");
    if (fieldColumn < 0) throw new Error(`test field was not found: ${field}`);
    for (let index = 1; index < rows.length; index += 1) {
      const cells = rows[index]?.values ?? [];
      const cellValue = cells[identityColumn]?.userEnteredValue?.stringValue ??
        cells[identityColumn]?.formattedValue;
      if (String(cellValue) !== String(identity)) continue;
      await this.saTransport.batchUpdate({
        spreadsheetId: this.sheetId,
        requests: [{
          kind: "updateCells",
          sheetId: sheetEntry.properties.sheetId,
          startRowIndex: index,
          startColumnIndex: fieldColumn,
          rows: [[{ userEnteredValue: { stringValue: String(value) } }]],
          fields: "userEnteredValue",
        }],
      });
      return { rowNumber: index + 1 };
    }
    throw new Error(`test identity row was not found: ${identity}`);
  }

  /** Reads one tab's raw string rows through the service-account transport. */
  async readTabRows(tabName) {
    if (this.outbound !== "direct") {
      throw new Error("readTabRows is a service-account-only helper");
    }
    const raw = await this.saTransport.getSpreadsheet({
      spreadsheetId: this.sheetId,
      ranges: [`${quoteTabName(tabName)}!A1:F1048576`],
      fields: "sheets.properties(sheetId,title),sheets.data(startRow,startColumn,rowData.values(userEnteredValue))",
    });
    const sheetEntry = (raw?.sheets ?? []).find((entry) =>
      entry?.properties?.title === tabName);
    if (sheetEntry === undefined) return [];
    const grid = (sheetEntry.data ?? [])[0];
    return (grid?.rowData ?? []).map((row) =>
      (row?.values ?? []).map((cell) => cell?.userEnteredValue?.stringValue ?? ""));
  }

  async cleanup(sheetNames) {
    if (this.outbound === "direct") {
      await this.cleanupDirect(sheetNames);
      return;
    }
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

  /**
   * Deletes the fixture tabs and the shared receipt tab through deleteSheet
   * batchUpdates. The provider itself never emits deleteSheet; the scenario
   * harness uses the request kind for cleanup only.
   */
  async cleanupDirect(sheetNames) {
    const raw = await this.saTransport.getSpreadsheet({
      spreadsheetId: this.sheetId,
      ranges: [],
      fields: "sheets.properties(sheetId,title)",
    });
    const targets = (raw?.sheets ?? [])
      .map((entry) => entry?.properties)
      .filter((properties) =>
        properties?.sheetId !== undefined &&
        (sheetNames.includes(properties.title) || properties.title === INTERNAL_RECEIPT_SHEET))
      .map((properties) => properties.sheetId);
    if (targets.length === 0) return;
    await this.saTransport.batchUpdate({
      spreadsheetId: this.sheetId,
      requests: targets.map((sheetId) => ({ kind: "deleteSheet", sheetId })),
    });
  }

  readRequest(definition) {
    return requestForDefinition(definition);
  }
}

/** Quotes a tab name for A1 notation in raw harness reads. */
function quoteTabName(sheetName) {
  return `'${sheetName.replace(/'/g, "''")}'`;
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
  if (options.outbound !== "gateway" && options.outbound !== "direct") {
    throw new Error("--outbound must be gateway or direct");
  }
  if (options.outbound === "direct" && options.backend !== "live") {
    throw new Error("--outbound direct requires --backend live (it needs a service account and a shared spreadsheet)");
  }

  const startedAt = new Date().toISOString();
  const startedClock = performance.now();
  const prefix = options.prefix ?? createPrefix(options.backend);
  const sheetNames = [`${prefix}_System`, `${prefix}_Input`];
  const manifest = {
    version: SCENARIO_VERSION,
    backend: options.backend,
    outbound: options.outbound,
    prefix,
    sheetNames,
    createdAt: startedAt,
  };
  await writeJson(options.manifest, manifest);

  const backend = options.backend === "live" ? new LiveSyncBackend(options.outbound) : new FakeSyncGateway();
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
    const { orm, storage, gateway, definitions, entity, mapping, writer, provision } = runtime;
    const systemDefinition = requireDefinition(definitions, "system_state");
    const userDefinition = requireDefinition(definitions, "user_input");
    const em = orm.em.fork();
    const entityId = `${prefix}-order-1`;
    const conflictEntityId = `${prefix}-order-conflict`;
    const systemGuardEntityId = `${prefix}-order-system-guard`;

    await measure("initialize_mapped_orm", "setup", () => smokeInitializeMappedOrm({
      entity,
      mapping,
      prefix,
    }));

    if (options.outbound === "direct") {
      // Service-account-only mode provisions from the EMPTY spreadsheet
      // state: both fixture tabs are created and their headers initialized.
      await measure("provision_created_tabs", "setup", async () => {
        assert.deepEqual(provision.createdSheets, sheetNames);
        assert.deepEqual(provision.initializedHeaders, sheetNames);
        assertions += 2;
      });
    }

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
    if (options.outbound === "direct") {
      // Append receipt evidence: the create produced exactly two receipt rows
      // (system fast append + user_input create) and no duplicate rows.
      await measure("append_receipt_evidence", "steady_state", async () => {
        const receiptRows = await backend.readTabRows(INTERNAL_RECEIPT_SHEET);
        assert.equal(receiptRows.length - 1, 2);
        assertions += 1;
      });
    }
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

    if (options.outbound === "direct") {
      // Direct full-parity checklist (service-account only): seed a second
      // entity for the stale-edit guard steps, run a mapped polling pass so a
      // simulated human edit flows through full observation into SQLite, and
      // verify both CAS guards (candidate on User_Input, visible on System).
      await measure("seed_conflict_entity", "steady_state", async () => {
        const conflictEm = orm.em.fork();
        conflictEm.persist(conflictEm.create(entity, { id: conflictEntityId, status: "pending" }));
        await conflictEm.flush();
        const reports = await runWorkerUntilIdle(storage, gateway, `${prefix}-worker`);
        assert.equal(reports.at(-1)?.selected ?? 0, 0);
        assertions += 1;
      });

      await measure("seed_system_guard_entity", "steady_state", async () => {
        // A separate entity for the System_State guard step: an entity whose
        // user_input projection is blocked (blocked_candidate) can no longer
        // enqueue further projection effects, so the system guard must target
        // a fresh entity with an unblocked input projection.
        const guardEm = orm.em.fork();
        guardEm.persist(guardEm.create(entity, { id: systemGuardEntityId, status: "pending" }));
        await guardEm.flush();
        const reports = await runWorkerUntilIdle(storage, gateway, `${prefix}-worker`);
        assert.equal(reports.at(-1)?.selected ?? 0, 0);
        assertions += 1;
      });

      await measure("mapped_polling_human_edit", "steady_state", async () => {
        await backend.mutateRow({
          sheetName: userDefinition.sheet.tabName,
          identity: entityId,
          field: "status",
          value: "edited-by-user",
        });
        const mapped = await pollMappedUserInputWithMikroOrm({
          storage,
          gateway,
          mappings: [mapping],
          writer,
          mode: "adaptive",
          forceFull: true,
        });
        assert.equal(mapped.appliedRows, 1);
        assertions += 1;
        // The long-lived em fork's identity map predates the polling write;
        // read the persisted entity through a fresh fork so the assertion
        // observes the SQLite row, not the stale managed instance.
        const reloaded = await orm.em.fork().findOne(entity, { id: entityId });
        assert.notEqual(reloaded, null);
        assert.equal(reloaded.status, "edited-by-user");
        assertions += 2;
      });

      await measure("stale_input_edit_blocked", "steady_state", async () => {
        // A stale human edit on User_Input: the input mirror effect is parked
        // as blocked_candidate (candidate_guard_mismatch) and the sheet keeps
        // the human value.
        await backend.mutateRow({
          sheetName: userDefinition.sheet.tabName,
          identity: conflictEntityId,
          field: "status",
          value: "human-2",
        });
        const em5 = orm.em.fork();
        const target = await em5.findOne(entity, { id: conflictEntityId });
        assert.notEqual(target, null);
        if (target === null) throw new Error("conflict target entity missing");
        target.status = "paid-v2";
        await em5.flush();
        const reports = await runWorkerUntilIdle(storage, gateway, `${prefix}-worker`, true);
        const blocked = reports.reduce((sum, report) => sum + report.blockedCandidate, 0);
        const conflicted = reports.reduce((sum, report) => sum + report.conflicted, 0);
        assert.ok(blocked >= 1);
        assert.equal(conflicted, 0);
        const inputRows = await backend.readTabRows(userDefinition.sheet.tabName);
        const humanRow = inputRows.find((row) => row[0] === conflictEntityId);
        assert.equal(humanRow?.[1], "human-2");
        assertions += 4;
      });

      await measure("stale_system_edit_conflict", "steady_state", async () => {
        // A stale human edit on System_State: the system effect records a
        // durable conflict (visible_guard_mismatch) and the sheet keeps the
        // human value.
        await backend.mutateRow({
          sheetName: systemDefinition.sheet.tabName,
          identity: systemGuardEntityId,
          field: "status",
          value: "human-sys",
        });
        const em5b = orm.em.fork();
        const target = await em5b.findOne(entity, { id: systemGuardEntityId });
        assert.notEqual(target, null);
        if (target === null) throw new Error("system guard target entity missing");
        target.status = "paid-v4";
        await em5b.flush();
        const reports = await runWorkerUntilIdle(storage, gateway, `${prefix}-worker`, true);
        const conflicted = reports.reduce((sum, report) => sum + report.conflicted, 0);
        assert.ok(conflicted >= 1);
        const systemRows = await backend.readTabRows(systemDefinition.sheet.tabName);
        const humanRow = systemRows.find((row) => row[0] === systemGuardEntityId);
        assert.equal(humanRow?.[1], "human-sys");
        assertions += 3;
      });
    } else {
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
    }

    await measure("delete_and_flush", "steady_state", async () => {
      // Read through a fresh fork: the long-lived em identity map predates the
      // polling-applied human edit, and the mapped delete fails closed when the
      // managed entity fields diverge from the User_Input row.
      const deleteEm = orm.em.fork();
      const fresh = await deleteEm.findOne(entity, { id: entityId });
      assert.notEqual(fresh, null);
      if (fresh !== null) {
        deleteEm.remove(fresh);
        await deleteEm.flush();
      }
      assertions += 1;
    });
    await measure("worker_after_delete", "steady_state", async () => {
      const reports = await runWorkerUntilIdle(storage, gateway, `${prefix}-worker`);
      assert.equal(reports.at(-1)?.selected ?? 0, 0);
      assertions += 1;
    });
    await measure("read_after_delete", "steady_state", async () => {
      // Fresh fork again: the long-lived em identity map still holds the
      // deleted instance and would return it instead of the SQLite row.
      const readBack = await orm.em.fork().findOne(entity, { id: entityId });
      assert.equal(readBack, null);
      const userRows = await gateway.readRows(backend.readRequest(userDefinition));
      const systemRows = await gateway.readRows(backend.readRequest(systemDefinition));
      if (options.outbound === "direct") {
        // The conflict fixture row remains; the deleted entity's User_Input
        // row is physically gone and its System_State row is tombstoned.
        assert.equal(
          userRows.rows.filter((row) => cellValue(row.fields.id) === entityId).length,
          0,
        );
        assert.equal(systemRows.rows.length, 3);
        const systemRow = systemRows.rows.find((row) => cellValue(row.fields.id) === entityId);
        assert.deepEqual(systemRow?.fields.__typed_sheets_deleted, {
          kind: "boolean",
          value: true,
        });
      } else {
        assert.equal(userRows.rows.length, 0);
        assert.equal(systemRows.rows.length, 1);
        assert.deepEqual(systemRows.rows[0]?.fields.__typed_sheets_deleted, {
          kind: "boolean",
          value: true,
        });
      }
      assertions += 4;
    });

    if (options.outbound === "direct") {
      // Anchor evidence: the fast append path intentionally never materializes
      // anchor metadata (matching the Apps Script batch append), so anchors
      // exist on User_Input rows, which the polling observation pass anchored;
      // System_State rows are located by visible identity instead. Assert both
      // surfaces and that no entity was materialized twice.
      await measure("anchor_evidence", "steady_state", async () => {
        const systemSnapshot = await gateway.readSnapshot(backend.readRequest(systemDefinition));
        assert.equal(systemSnapshot.rows.length, 3);
        const systemIds = systemSnapshot.rows.map((row) => cellValue(row.cells.id?.normalizedCell));
        assert.equal(new Set(systemIds).size, 3);
        const inputSnapshot = await gateway.readSnapshot(backend.readRequest(userDefinition));
        assert.equal(inputSnapshot.rows.length, 2);
        assert.ok(inputSnapshot.rows.every((row) => row.physicalAnchor.kind === PRESENT));
        assert.equal(inputSnapshot.unanchoredRows.length, 0);
        const inputIds = inputSnapshot.rows.map((row) => cellValue(row.cells.id?.normalizedCell));
        assert.equal(new Set(inputIds).size, 2);
        assertions += 5;
      });
    }

    // Keep the mapping in the result so a future scenario can report which
    // internal route was exercised without importing source-only test helpers.
    void mapping;
    void writer;
    void provision;
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
    outbound: options.outbound,
    sheetMatched: backend.sheetMatched,
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
  const spreadsheetId = backend instanceof LiveSyncBackend
    ? backend.sheetId
    : `fake-${prefix}`;
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
    const provision = await provisionRegisteredSyncSheets(gateway, definitions);
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
      writer,
      provision,
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

async function runWorkerUntilIdle(storage, gateway, workerId, allowConflicts = false) {
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
    if (report.failed > 0 || (!allowConflicts && report.conflicted > 0)) {
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
  // The manifest records which outbound mode produced the fixture, so the
  // cleanup step uses the matching backend (service-account-only for the
  // direct workflow, the Apps Script gateway for legacy runs).
  const backend = new LiveSyncBackend(manifest.outbound);
  await backend.cleanup(manifest.sheetNames);
  process.stdout.write(`cleaned live fixture ${manifest.prefix}\n`);
}

function createReport({
  backend,
  outbound,
  sheetMatched,
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
    outbound,
    ...(sheetMatched === undefined ? {} : { sheetMatched }),
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
    outbound: "gateway",
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
    else if (key === "--outbound") options.outbound = value;
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
