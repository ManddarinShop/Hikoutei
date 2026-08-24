/**
 * Credential-free coverage for the full Google Sheets API sync provider.
 *
 * These tests exercise the provider's provisioning, values-only table reads,
 * row-anchor assignment, and full snapshot fidelity through the narrow stub
 * transport with an in-memory spreadsheet model: atomic batch provisioning
 * with exact-match fail-closed header verification, idempotent retry after
 * lost responses, getValues-computed table reads, checkbox blank semantics,
 * merged/formula/error cell classification with Apps Script byte parity, and
 * per-request read/write pacing with redacted telemetry. No test requires
 * Google credentials or a network call.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { NormalizedCell } from "../src/shared/encoding/types.js";
import { stableHash } from "../src/shared/encoding/index.js";
import type { StableValue } from "../src/shared/encoding/types.js";
import { presentValue, absentValue } from "../src/shared/state/index.js";
import { computeSyncVisibleHash } from "../src/application/sync/sheetsContract/syncSheets.js";
import {
  SYNC_PROJECTIONS,
  SYNC_SNAPSHOT_READ_MODES,
} from "../src/application/sync/sheetsContract/constants.js";
import { SYNC_SHEETS_ERROR_CODES } from "../src/application/sync/sheetsContract/errors.js";
import {
  getHikouteiInternalLogger,
  HIKOUTEI_LOG_ENV_KEYS,
  resetHikouteiInternalLoggerForTests,
} from "../src/shared/observability/internalLog.js";
import { HIKOUTEI_LOG_EVENTS } from "../src/shared/observability/logEvents.js";
import type {
  ApplySyncEffectsRequest,
  ReadSyncSnapshotRequest,
  SyncSheetsSnapshot,
  SyncProjectionEffect,
} from "../src/application/sync/sheetsContract/syncSheets.js";
import type { SyncSheetsProvisionRoute } from "../src/application/sync/sheetsContract/sheetsProvisioning.js";
import {
  GoogleSheetsApiSyncProvider,
  type GoogleSheetsApiRequestEvent,
} from "../src/adapter/sheets/providers/google-sheets-api/index.js";
import {
  GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
  GOOGLE_SHEETS_API_ENUMERATION_FIELDS,
  GOOGLE_SHEETS_API_OBSERVATION_FIELDS,
  GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS,
  GOOGLE_SHEETS_API_VALUES_FIELDS,
  GOOGLE_SHEETS_API_PROVISION_FIELDS,
  GOOGLE_SHEETS_API_PROVISION_ENUMERATION_FIELDS,
} from "../src/adapter/sheets/providers/google-sheets-api/model/preflightFields.js";
import { GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT } from "../src/adapter/sheets/providers/google-sheets-api/constants.js";
import { dateSerialFromIso } from "../src/adapter/sheets/providers/google-sheets-api/model/valueNormalization.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
} from "../src/adapter/sheets/providers/google-sheets-api/errors.js";
import {
  TRANSPORT_OUTCOME_KINDS,
  classifyTransportOutcome,
} from "../src/application/sync/sheetsContract/transportOutcome.js";
import type { RegisteredSyncProjectionDefinition } from "../src/application/sync/sheetsContract/sheetsProvisioning.js";
import {
  StubSheet,
  StubSpreadsheet,
  StubSheetsTransport,
  type StubCell,
} from "./support/StubSheetsTransport.js";

const SPREADSHEET_ID = "stub-spreadsheet";
const SYSTEM_SHEET_ID = "entity:users:system_state";
const USER_INPUT_SHEET_ID = "entity:users:user_input";
const CONFLICT_SHEET_ID = "entity:users:sync_conflicts";

const SYSTEM_HEADERS = ["id", "status", "__typed_sheets_deleted"];
const USER_INPUT_HEADERS = ["id", "status"];
const CONFLICT_HEADERS = [
  "Conflict_ID",
  "Conflict_Group_ID",
  "Event_ID",
  "Entity_ID",
  "Field_Name",
  "User_Value",
  "User_Base_Revision",
  "Canonical_Value_At_Detection",
  "Canonical_Revision_At_Detection",
  "Current_Canonical_Value",
  "Current_Canonical_Revision",
  "Candidate_Epoch",
  "Status",
  "Resolution",
  "Resolution_Command_ID",
];

function definition(overrides: {
  readonly physicalSheetId: string;
  readonly tabName: string;
  readonly projection: string;
  readonly registeredRange: string;
  readonly headers: readonly string[];
  readonly checkboxHeaders?: readonly string[];
}): RegisteredSyncProjectionDefinition {
  return {
    sheet: {
      logicalSheetId: "entity:users",
      physicalSheetId: overrides.physicalSheetId,
      spreadsheetId: SPREADSHEET_ID,
      tabName: overrides.tabName,
      registeredRange: overrides.registeredRange,
      projection: overrides.projection as RegisteredSyncProjectionDefinition["sheet"]["projection"],
      schemaVersion: 1,
      ownershipManifestJson: "{}",
      businessKeyField: "id",
      anchorMode: "business_key",
    },
    headers: overrides.headers,
    ...(overrides.checkboxHeaders === undefined
      ? {}
      : { checkboxHeaders: overrides.checkboxHeaders }),
  };
}

const SYSTEM_DEFINITION = definition({
  physicalSheetId: SYSTEM_SHEET_ID,
  tabName: "Users_System",
  projection: "system_state",
  registeredRange: "A:C",
  headers: SYSTEM_HEADERS,
});
const USER_INPUT_DEFINITION = definition({
  physicalSheetId: USER_INPUT_SHEET_ID,
  tabName: "Users_Input",
  projection: "user_input",
  // The last column is the internal __hikoutei_row_id system column.
  registeredRange: "A:C",
  headers: USER_INPUT_HEADERS,
});
const CONFLICT_DEFINITION = definition({
  physicalSheetId: CONFLICT_SHEET_ID,
  tabName: "Users_Conflicts",
  projection: "sync_conflicts",
  registeredRange: "A:O",
  headers: CONFLICT_HEADERS,
  checkboxHeaders: ["Status"],
});

const DEFINITIONS = [SYSTEM_DEFINITION, USER_INPUT_DEFINITION, CONFLICT_DEFINITION];

function buildProvider(
  transport: StubSheetsTransport,
  options: {
    readonly onRequest?: (event: GoogleSheetsApiRequestEvent) => void;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  } = {},
): GoogleSheetsApiSyncProvider {
  return new GoogleSheetsApiSyncProvider({
    spreadsheetId: SPREADSHEET_ID,
    definitions: DEFINITIONS,
    transport,
    requestTimeoutMs: 60_000,
    // Zero interval: pacing itself is covered by the dedicated pacing tests
    // below, so unrelated tests must never wait on — or be refused by — the
    // request-start limiter. The pacing tests pin their own interval.
    rateLimitIntervalMs: 0,
    ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

function provisionRoutes(): SyncSheetsProvisionRoute[] {
  return DEFINITIONS.map((definition) => ({
    sheetName: definition.sheet.tabName,
    registeredRange: definition.sheet.registeredRange,
    projection: definition.sheet.projection,
    schemaVersion: definition.sheet.schemaVersion,
    headers: definition.headers,
    ...(definition.sheet.projection === "system_state" ? { identityField: "id" } : {}),
    ...(definition.checkboxHeaders === undefined
      ? {}
      : { checkboxHeaders: definition.checkboxHeaders }),
  }));
}

function systemSnapshotRequest(overrides: Partial<ReadSyncSnapshotRequest> = {}): ReadSyncSnapshotRequest {
  return {
    physicalSheetId: SYSTEM_SHEET_ID,
    sheetName: "Users_System",
    registeredRange: "A:C",
    projection: SYNC_PROJECTIONS.SYSTEM_STATE,
    schemaVersion: 1,
    ...overrides,
  };
}

function userInputSnapshotRequest(overrides: Partial<ReadSyncSnapshotRequest> = {}): ReadSyncSnapshotRequest {
  return {
    physicalSheetId: USER_INPUT_SHEET_ID,
    sheetName: "Users_Input",
    registeredRange: "A:C",
    projection: SYNC_PROJECTIONS.USER_INPUT,
    schemaVersion: 1,
    ...overrides,
  };
}

const cell = {
  string: (value: string): NormalizedCell => ({ kind: "string", value }),
  number: (value: number): NormalizedCell => ({ kind: "number", value }),
  bool: (value: boolean): NormalizedCell => ({ kind: "boolean", value }),
  date: (value: string): NormalizedCell => ({ kind: "date", value }),
};

function seedSystemTab(spreadsheet: StubSpreadsheet, rows: number): void {
  spreadsheet.addTab("Users_System", {
    headers: SYSTEM_HEADERS,
    rows: Array.from({ length: rows }, (_, index) => [
      `u${index + 1}`,
      "pending",
      false,
    ]),
  });
}

function formulaCell(
  formula: string,
  effective: NonNullable<StubCell["effectiveValue"]>,
  formatted: string,
): StubCell {
  return {
    userEnteredValue: { formulaValue: formula },
    effectiveValue: effective,
    formattedValue: formatted,
  };
}

describe("GoogleSheetsApiSyncProvider provisioning", () => {
  it("creates missing tabs and headers in ONE batch, in input order", async () => {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const result = await provider.provisionRegistry(provisionRoutes());

    expect(transport.batchUpdateCalls).toBe(1);
    const batch = transport.appliedBatchUpdates[0];
    expect(batch).toBeDefined();
    const addSheets = batch?.filter((request) => request.kind === "addSheet");
    const headerWrites = batch?.filter((request) => request.kind === "updateCells");
    expect(addSheets?.map((request) => request.kind === "addSheet" ? request.title : "")).toEqual([
      "Users_System",
      "Users_Input",
      "Users_Conflicts",
    ]);
    expect(headerWrites).toHaveLength(3);
    expect(result.createdSheets).toEqual(["Users_System", "Users_Input", "Users_Conflicts"]);
    expect(result.initializedHeaders).toEqual(["Users_System", "Users_Input", "Users_Conflicts"]);
    expect(result.registrations).toEqual(provisionRoutes().map(({ headers: _headers, ...route }) => route));
    expect(result.registrations[0]).toMatchObject({ identityField: "id" });
    expect(result.registrations[2]).toMatchObject({ checkboxHeaders: ["Status"] });

    const systemTab = spreadsheet.findTab("Users_System");
    expect(systemTab).toBeDefined();
    expect(systemTab?.cell(0, 0)?.userEnteredValue?.stringValue).toBe("id");
    expect(systemTab?.cell(0, 2)?.userEnteredValue?.stringValue).toBe("__typed_sheets_deleted");
    const inputTab = spreadsheet.findTab("Users_Input");
    expect(inputTab?.cell(0, 0)?.userEnteredValue?.stringValue).toBe("id");
    expect(inputTab?.cell(0, 2)?.userEnteredValue?.stringValue).toBe("__hikoutei_row_id");
    const conflictsTab = spreadsheet.findTab("Users_Conflicts");
    expect(conflictsTab?.cell(0, 12)?.userEnteredValue?.stringValue).toBe("Status");
  });

  it("treats an existing exact header row as a no-op with zero mutations", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
    });
    spreadsheet.addTab("Users_Conflicts", { headers: CONFLICT_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const result = await provider.provisionRegistry(provisionRoutes());

    expect(transport.batchUpdateCalls).toBe(0);
    expect(result.createdSheets).toEqual([]);
    expect(result.initializedHeaders).toEqual([]);
  });

  it("rejects a legacy User_Input content tab without the system column", async () => {
    // A tab provisioned by an older version has only the user-field headers;
    // provisioning must fail closed with the re-provision message instead of
    // silently extending the tab.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    spreadsheet.addTab("Users_Input", {
      headers: USER_INPUT_HEADERS,
      rows: [["u1", "pending"]],
    });
    spreadsheet.addTab("Users_Conflicts", { headers: CONFLICT_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    await expect(provider.provisionRegistry(provisionRoutes()))
      .rejects.toThrow(/missing the __hikoutei_row_id system column; re-provision the route/);
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("initializes headers on a truly empty existing tab without recreating it", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", {});
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const result = await provider.provisionRegistry(provisionRoutes());

    expect(result.createdSheets).toEqual(["Users_Input", "Users_Conflicts"]);
    expect(result.initializedHeaders).toEqual([
      "Users_System",
      "Users_Input",
      "Users_Conflicts",
    ]);
    // One atomic batch: two addSheet pairs plus one header-only updateCells.
    const batch = transport.appliedBatchUpdates[0];
    const headerWrites = batch?.filter((request) => request.kind === "updateCells");
    expect(headerWrites).toHaveLength(3);
    expect(spreadsheet.findTab("Users_System")?.cell(0, 0)?.userEnteredValue?.stringValue).toBe("id");
  });

  it("ignores formatting-only cells when deciding whether a tab has content", async () => {
    // A blank-but-formatted tab must be initialized like a truly empty one:
    // Apps Script getLastRow()/getLastColumn() ignore formatting-only cells,
    // so a format-only cell (no userEnteredValue) is NOT content.
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", {});
    tab.cells.set("2,0", {
      userEnteredFormat: { numberFormat: GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT },
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const result = await provider.provisionRegistry(provisionRoutes());
    expect(result.initializedHeaders).toContain("Users_System");
    expect(spreadsheet.findTab("Users_System")?.cell(0, 0)?.userEnteredValue?.stringValue).toBe("id");
  });

  it("fails closed on a malformed userEnteredValue instead of initializing headers", async () => {
    // A content cell whose userEnteredValue wrapper is a primitive is a
    // malformed reply: provisioning must fail closed with the stable code
    // instead of treating the tab as empty and initializing its headers.
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", {});
    tab.cells.set("2,0", { userEnteredValue: "stray" } as unknown as StubCell);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    await expect(provider.provisionRegistry(provisionRoutes()))
      .rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("fails closed on a malformed format wrapper instead of initializing headers", async () => {
    // A present userEnteredFormat/effectiveFormat (and its nested numberFormat)
    // must be a record; a primitive wrapper must fail closed, never be treated
    // as an ignorable format-only cell that triggers header initialization.
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", {});
    tab.cells.set("2,0", {
      userEnteredFormat: { numberFormat: "bad" },
    } as unknown as StubCell);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    await expect(provider.provisionRegistry(provisionRoutes()))
      .rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("logs a stable redacted response_invalid record for a malformed provisioning cell", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-provision-log-"));
    const originalLogFile = process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE];
    const logFile = path.join(tempRoot, "hikoutei-log.txt");
    try {
      process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE] = logFile;
      resetHikouteiInternalLoggerForTests();

      const spreadsheet = new StubSpreadsheet();
      const tab = spreadsheet.addTab("Users_System", {});
      tab.cells.set("2,0", {
        userEnteredValue: "RAW_MARKER_VALUE_12345",
      } as unknown as StubCell);
      const transport = new StubSheetsTransport(spreadsheet);
      const provider = buildProvider(transport);

      await expect(provider.provisionRegistry(provisionRoutes()))
        .rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE });
      expect(transport.batchUpdateCalls).toBe(0);

      const logger = getHikouteiInternalLogger();
      await logger.drain();
      const raw = await readFile(logFile, "utf8");
      const lines = raw.split("\n").filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      // The boundary emits only a stable, redacted record for the malformed
      // reply: the stable event/code/class reach the log, never the raw value.
      const invalid = lines.find((line) =>
        line.event === HIKOUTEI_LOG_EVENTS.TRANSPORT_RESPONSE_INVALID);
      expect(invalid).toBeDefined();
      expect(invalid?.code).toBe(SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE);
      expect(invalid?.errorClass).toBe("SyncSheetsContractError");
      expect(raw).not.toContain("RAW_MARKER_VALUE_12345");
      expect(raw).not.toContain("userEnteredValue");
    } finally {
      if (originalLogFile === undefined) {
        delete process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE];
      } else {
        process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE] = originalLogFile;
      }
      resetHikouteiInternalLoggerForTests();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats a tab with one value cell anywhere as content that must match headers", async () => {
    // A single entered value outside the header row makes the tab a content
    // tab; with no registered header row the exact-match verification fails
    // closed before any mutation.
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", {});
    tab.cells.set("2,5", { userEnteredValue: { stringValue: "stray" } });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    await expect(provider.provisionRegistry(provisionRoutes()))
      .rejects.toThrow(/operational provisioning header mismatch: Users_System/);
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("fails closed on content tabs whose headers drift, with ZERO batchUpdate mutations", async () => {
    // Reordered header row.
    const reordered = new StubSpreadsheet();
    reordered.addTab("Users_System", {
      headers: ["status", "id", "__typed_sheets_deleted"],
      rows: [["pending", "u1", false]],
    });
    const reorderedTransport = new StubSheetsTransport(reordered);
    await expect(buildProvider(reorderedTransport).provisionRegistry(provisionRoutes()))
      .rejects.toThrow(/operational provisioning header mismatch: Users_System/);
    expect(reorderedTransport.batchUpdateCalls).toBe(0);

    // Missing header cell (content exists only outside the registered range).
    const partial = new StubSpreadsheet();
    partial.addTab("Users_System", {
      headers: ["id"],
      rows: [["u1", "pending", false]],
    });
    const partialTransport = new StubSheetsTransport(partial);
    await expect(buildProvider(partialTransport).provisionRegistry(provisionRoutes()))
      .rejects.toThrow(/operational provisioning header mismatch: Users_System/);
    expect(partialTransport.batchUpdateCalls).toBe(0);

    // Duplicate headers.
    const duplicate = new StubSpreadsheet();
    duplicate.addTab("Users_System", {
      headers: ["id", "id", "__typed_sheets_deleted"],
      rows: [["u1", "pending", false]],
    });
    const duplicateTransport = new StubSheetsTransport(duplicate);
    await expect(buildProvider(duplicateTransport).provisionRegistry(provisionRoutes()))
      .rejects.toThrow(/duplicate header/);
    expect(duplicateTransport.batchUpdateCalls).toBe(0);

    // Wrong registered-range width fails before any transport call.
    const narrow = new StubSpreadsheet();
    const narrowTransport = new StubSheetsTransport(narrow);
    const badRoutes = provisionRoutes().map((route) => ({ ...route, registeredRange: "A:B" }));
    await expect(buildProvider(narrowTransport).provisionRegistry(badRoutes))
      .rejects.toThrow(/headers do not match registeredRange/);
    expect(narrowTransport.batchUpdateCalls).toBe(0);
    expect(narrowTransport.getSpreadsheetCalls).toBe(0);
  });

  it("fails closed on duplicate tab names before any transport call", async () => {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const routes = provisionRoutes();
    const first = routes[0];
    if (first === undefined) throw new Error("fixture routes missing");
    const duplicated = [...routes, { ...first, sheetName: "Users_System" }];
    await expect(buildProvider(transport).provisionRegistry(duplicated))
      .rejects.toThrow(/cannot repeat a tab name: Users_System/);
    expect(transport.getSpreadsheetCalls).toBe(0);
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("is idempotent after a lost response: retry succeeds without rewriting", async () => {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    transport.fault = { kind: "malformedBatchUpdateReply" };
    await expect(provider.provisionRegistry(provisionRoutes()))
      .rejects.toThrow(/batchUpdate reply count does not match/);

    // The batch actually applied despite the lost reply; the retry must see
    // the exact headers and perform no new mutation.
    const retry = await provider.provisionRegistry(provisionRoutes());
    expect(transport.batchUpdateCalls).toBe(1);
    expect(retry.createdSheets).toEqual([]);
    expect(retry.initializedHeaders).toEqual([]);
  });

  it("allocates sheet ids that never collide with existing tabs", async () => {
    const spreadsheet = new StubSpreadsheet();
    // A pre-existing tab with a known low sheet id.
    const occupied = new StubSheet(5, "Occupied", false);
    spreadsheet.sheets.push(occupied);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const routes = provisionRoutes();
    const first = routes[0];
    if (first === undefined) throw new Error("fixture routes missing");

    const result = await provider.provisionRegistry([first]);
    expect(result.createdSheets).toEqual(["Users_System"]);
    const created = spreadsheet.findTab("Users_System");
    expect(created?.sheetId).not.toBe(5);
    expect(created?.sheetId).toBeGreaterThan(0);
    expect(Number.isSafeInteger(created?.sheetId)).toBe(true);
  });

  it("provisions quoted tab names and registered ranges beyond Z", async () => {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const wideDefinition = definition({
      physicalSheetId: "entity:users:wide",
      tabName: "My Tab",
      projection: "user_input",
      // user_input ranges reserve the last column for the system row-id.
      registeredRange: "AA:AC",
      headers: ["left", "right"],
    });
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [wideDefinition],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 0,
    });

    const result = await provider.provisionRegistry([{
      sheetName: "My Tab",
      registeredRange: "AA:AC",
      projection: "user_input",
      schemaVersion: 1,
      headers: ["left", "right"],
    }]);
    expect(result.createdSheets).toEqual(["My Tab"]);
    const tab = spreadsheet.findTab("My Tab");
    expect(tab).toBeDefined();
    expect(tab?.cell(0, 26)?.userEnteredValue?.stringValue).toBe("left");
    expect(tab?.cell(0, 27)?.userEnteredValue?.stringValue).toBe("right");
    expect(tab?.cell(0, 28)?.userEnteredValue?.stringValue).toBe("__hikoutei_row_id");

    // The values-only read on the same route round-trips.
    const read = await provider.readRows({
      physicalSheetId: "entity:users:wide",
      sheetName: "My Tab",
      registeredRange: "AA:AC",
      projection: "user_input",
      schemaVersion: 1,
      headers: ["left", "right"],
    });
    expect(read.rows).toEqual([]);
    expect(read.headers).toEqual(["left", "right"]);
  });
});

describe("GoogleSheetsApiSyncProvider values-only table reads", () => {
  it("reads several tabs through ONE getSpreadsheet call in request order", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 2);
    spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
      rows: [["u1", "pending", null], ["u2", "paid", null]],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const results = await provider.readRowsBatch([
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "Users_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: USER_INPUT_HEADERS,
      },
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: SYSTEM_HEADERS,
      },
    ]);

    expect(transport.getSpreadsheetCalls).toBe(1);
    expect(transport.getSpreadsheetRequests[0]?.ranges).toEqual([
      "'Users_Input'!A1:C1048576",
      "'Users_System'!A1:C1048576",
    ]);
    expect(results.map((result) => result.sheetName)).toEqual(["Users_Input", "Users_System"]);
    expect(results[0]?.rows.map((row) => row.fields.id)).toEqual([
      cell.string("u1"),
      cell.string("u2"),
    ]);
    expect(results[1]?.rows).toHaveLength(2);
  });

  it("normalizes strings, numbers, booleans, dates, and blanks with getValues semantics", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", { userEnteredValue: { numberValue: 42 } });
    tab.cells.set("2,0", { userEnteredValue: { boolValue: true } });
    tab.cells.set("2,1", { userEnteredValue: { numberValue: 45292 } });
    tab.cells.set("3,0", { userEnteredValue: { stringValue: "" } });
    tab.cells.set("4,0", { userEnteredValue: { stringValue: "u4" } });
    tab.cells.set("4,1", {
      userEnteredValue: { numberValue: dateSerialFromIso("2024-01-15T00:00:00.000Z") },
      userEnteredFormat: { numberFormat: GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT },
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const result = await provider.readRows({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      headers: USER_INPUT_HEADERS,
    });

    expect(result.rows.map((row) => row.rowNumber)).toEqual([2, 3, 5]);
    expect(result.rows[0]?.fields).toEqual({
      id: cell.string("u1"),
      status: cell.number(42),
    });
    expect(result.rows[1]?.fields).toEqual({
      id: cell.bool(true),
      status: cell.number(45292),
    });
    // The explicit empty string row is blank and skipped.
    expect(result.rows[2]?.fields).toEqual({
      id: cell.string("u4"),
      status: cell.date("2024-01-15T00:00:00.000Z"),
    });
  });

  it("resolves formula cells to their computed effective value", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", formulaCell("=B2*2", { numberValue: 84 }, "84"));
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const result = await provider.readRows({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      headers: USER_INPUT_HEADERS,
    });
    expect(result.rows[0]?.fields.status).toEqual(cell.number(84));
  });

  it("returns error cells as their formatted error string literal", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", {
      userEnteredValue: { formulaValue: "=1/0" },
      effectiveValue: { errorValue: { type: "DIVIDE_BY_ZERO" } },
      formattedValue: "#DIV/0!",
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const result = await provider.readRows({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      headers: USER_INPUT_HEADERS,
    });
    expect(result.rows[0]?.fields.status).toEqual(cell.string("#DIV/0!"));
  });

  it("fails closed when a literal cell carries a malformed effectiveValue", async () => {
    // A present effectiveValue must be a record even on a literal/non-formula
    // cell. A primitive effectiveValue is a malformed reply and must fail
    // closed instead of falling through to the literal/blank path.
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
    });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", {
      userEnteredValue: { numberValue: 42 },
      effectiveValue: 42,
    } as unknown as StubCell);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    await expect(provider.readRows({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      headers: USER_INPUT_HEADERS,
    })).rejects.toMatchObject({
      code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
    });
  });

  it("fails closed when a valid entered format hides a malformed effective format", async () => {
    // Both present format wrappers (and their nested numberFormat containers)
    // must be validated before entered is preferred over effective, so a
    // well-formed entered DATE format can never mask a malformed effective
    // numberFormat.
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
    });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", {
      userEnteredValue: { numberValue: 42 },
      userEnteredFormat: { numberFormat: GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT },
      effectiveFormat: { numberFormat: "not-an-object" },
    } as unknown as StubCell);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    await expect(provider.readRows({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      headers: USER_INPUT_HEADERS,
    })).rejects.toMatchObject({
      code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
    });
  });

  it("fails closed on a missing tab, header drift, and malformed payloads", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const request = {
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      headers: USER_INPUT_HEADERS,
    };

    // The route check fires first because the sheet name no longer matches
    // the registered definition; either way the read fails closed.
    await expect(provider.readRows({ ...request, sheetName: "Missing_Tab" }))
      .rejects.toThrow(/does not match the registered projection/);

    await expect(provider.readRows({ ...request, headers: ["wrong"] }))
      .rejects.toThrow(/table read headers do not match the registered projection/);

    transport.fault = { kind: "malformedGetResponse" };
    await expect(provider.readRows(request))
      .rejects.toThrow(/table read response must contain a sheets array/);
  });

  it("treats unchecked checkbox cells as blank rows", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Conflicts", { headers: CONFLICT_HEADERS });
    // Row 2: unchecked checkbox only -> blank row.
    tab.cells.set("1,12", { userEnteredValue: { boolValue: false } });
    // Row 3: checked checkbox -> nonblank row.
    tab.cells.set("2,0", { userEnteredValue: { stringValue: "c-1" } });
    tab.cells.set("2,12", { userEnteredValue: { boolValue: true } });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const result = await provider.readRows({
      physicalSheetId: CONFLICT_SHEET_ID,
      sheetName: "Users_Conflicts",
      registeredRange: "A:O",
      projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
      schemaVersion: 1,
      headers: CONFLICT_HEADERS,
    });
    expect(result.rows.map((row) => row.rowNumber)).toEqual([3]);
  });
});

describe("GoogleSheetsApiSyncProvider anchors and snapshots", () => {
  it("assigns missing anchors in one batch and re-reads so the snapshot sees them", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
      rows: [["u1", "pending", null]],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const observed = await provider.observeSnapshot(userInputSnapshotRequest());

    expect(observed.anchors.assigned).toBe(1);
    expect(observed.anchors.existing).toBe(0);
    expect(observed.anchors.duplicateAnchors).toEqual([]);
    // One anchor write batch (updateCells on the system column); the
    // snapshot was built from a re-read.
    expect(transport.batchUpdateCalls).toBe(1);
    const anchorBatch = transport.appliedBatchUpdates[0];
    expect(anchorBatch?.every((request) =>
      request.kind === "updateCells" && request.startColumnIndex === 2 &&
      request.fields === "userEnteredValue")).toBe(true);
    expect(observed.snapshot.rows[0]?.physicalAnchor.kind).toBe("present");
    expect(presenceValue(observed.snapshot.rows[0]?.physicalAnchor)).toMatch(/^sync-anchor:/);
    expect(observed.snapshot.unanchoredRows).toEqual([]);

    // The second pass is idempotent: zero writes, same anchor evidence.
    const again = await provider.observeSnapshot(userInputSnapshotRequest());
    expect(again.anchors.assigned).toBe(0);
    expect(again.anchors.existing).toBe(1);
    expect(transport.batchUpdateCalls).toBe(1);
    expect(presenceValue(again.snapshot.rows[0]?.physicalAnchor)).toBe(
      presenceValue(observed.snapshot.rows[0]?.physicalAnchor),
    );
  });

  it("reports unanchored rows from readSnapshot without any mutation", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 2);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const snapshot = await provider.readSnapshot(systemSnapshotRequest());

    expect(transport.batchUpdateCalls).toBe(0);
    expect(snapshot.unanchoredRows).toEqual([2, 3]);
    expect(snapshot.duplicateAnchors).toEqual([]);
    expect(snapshot.rows.every((row) => row.physicalAnchor.kind === "absent")).toBe(true);
  });

  it("reports duplicate anchors across rows as evidence", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
      rows: [
        ["u1", "pending", "sync-anchor:shared"],
        ["u2", "pending", "sync-anchor:shared"],
      ],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const ensured = await provider.ensureRowAnchors(userInputSnapshotRequest());
    expect(ensured.duplicateAnchors).toEqual([
      { anchor: "sync-anchor:shared", rowNumbers: [2, 3] },
    ]);
    expect(ensured.assigned).toBe(0);
    expect(ensured.existing).toBe(2);

    const snapshot = await provider.readSnapshot(userInputSnapshotRequest());
    expect(snapshot.duplicateAnchors).toEqual([
      { anchor: "sync-anchor:shared", rowNumbers: [2, 3] },
    ]);
  });

  it("treats system-column edits as anchor state, never as user-field edits", async () => {
    // A user overwrites or blanks the UUID column. The column is invisible to
    // user-field hashing, so no conflict or quarantine can arise; the ensure
    // pass re-anchors ONLY blank cells with a fresh sync-anchor value while a
    // replaced (but non-empty) value is kept as the row's anchor evidence.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
      rows: [
        ["u1", "pending", "sync-anchor:keep"],
        ["u2", "pending", "user-typed-garbage"],
        ["u3", "pending", null],
      ],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const ensured = await provider.ensureRowAnchors(userInputSnapshotRequest());
    expect(ensured.assigned).toBe(1);
    expect(ensured.existing).toBe(2);
    expect(ensured.duplicateAnchors).toEqual([]);
    expect(transport.batchUpdateCalls).toBe(1);
    const batch = transport.appliedBatchUpdates[0];
    const writes = batch?.filter((request) => request.kind === "updateCells");
    expect(writes?.map((request) => request.kind === "updateCells" ? request.startRowIndex : -1))
      .toEqual([3]);
    const inputTab = spreadsheet.findTab("Users_Input");
    // The blanked cell was reassigned; the garbage value and the valid anchor
    // were left untouched.
    expect(inputTab?.cell(3, 2)?.userEnteredValue?.stringValue).toMatch(/^sync-anchor:/);
    expect(inputTab?.cell(2, 2)?.userEnteredValue?.stringValue).toBe("user-typed-garbage");
    expect(inputTab?.cell(0, 2)?.userEnteredValue?.stringValue).toBe("__hikoutei_row_id");
  });

  it("treats whitespace-only anchor cells as missing and re-anchors them", async () => {
    // Mirroring the header validation's trim rule, a system-column cell made
    // of only whitespace is not an anchor: the ensure pass re-anchors it with
    // a fresh sync-anchor value instead of keeping it as anchor evidence.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
      rows: [
        ["u1", "pending", "sync-anchor:keep"],
        ["u2", "pending", "   "],
      ],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const ensured = await provider.ensureRowAnchors(userInputSnapshotRequest());
    expect(ensured.assigned).toBe(1);
    expect(ensured.existing).toBe(1);
    expect(ensured.duplicateAnchors).toEqual([]);
    const inputTab = spreadsheet.findTab("Users_Input");
    expect(inputTab?.cell(1, 2)?.userEnteredValue?.stringValue).toBe("sync-anchor:keep");
    expect(inputTab?.cell(2, 2)?.userEnteredValue?.stringValue).toMatch(/^sync-anchor:/);
  });

  it("skips checkbox-false-only rows as blank for anchors and snapshots", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Conflicts", { headers: CONFLICT_HEADERS });
    tab.cells.set("1,12", { userEnteredValue: { boolValue: false } });
    tab.cells.set("2,0", { userEnteredValue: { stringValue: "c-1" } });
    tab.cells.set("2,12", { userEnteredValue: { boolValue: true } });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const observed = await provider.observeSnapshot({
      physicalSheetId: CONFLICT_SHEET_ID,
      sheetName: "Users_Conflicts",
      registeredRange: "A:O",
      projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
      schemaVersion: 1,
    });
    // Only user_input tabs carry anchors; the conflicts row is identity- and
    // row-number-located, so the pass assigns nothing and reports the row as
    // unanchored.
    expect(observed.anchors.assigned).toBe(0);
    expect(observed.snapshot.rows.map((row) => row.rowNumber)).toEqual([3]);
    expect(observed.snapshot.unanchoredRows).toEqual([3]);
  });

  it("fails closed when a user property collides with the system row-id header", async () => {
    // A mapping whose user fields include __hikoutei_row_id is a header
    // collision: the provider rejects it before any read or mutation.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const collidingDefinition = definition({
      physicalSheetId: USER_INPUT_SHEET_ID,
      tabName: "Users_Input",
      projection: "user_input",
      registeredRange: "A:C",
      headers: ["id", "__hikoutei_row_id"],
    });
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [collidingDefinition],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 0,
    });

    await expect(provider.observeSnapshot(userInputSnapshotRequest()))
      .rejects.toThrow(/registered header __hikoutei_row_id collides with the system row-id column/);
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("rejects a legacy User_Input tab without the system column with a re-provision error", async () => {
    // A tab provisioned by an older version has only the user-field headers.
    // Every read path must fail closed with the re-provision message instead
    // of silently treating the missing column as a blank anchor area.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_Input", {
      headers: USER_INPUT_HEADERS,
      rows: [["u1", "pending"]],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    await expect(provider.observeSnapshot(userInputSnapshotRequest()))
      .rejects.toThrow(/missing the __hikoutei_row_id system column; re-provision the route/);
    await expect(provider.readSnapshot(userInputSnapshotRequest()))
      .rejects.toThrow(/missing the __hikoutei_row_id system column; re-provision the route/);
    await expect(provider.ensureRowAnchors(userInputSnapshotRequest()))
      .rejects.toThrow(/missing the __hikoutei_row_id system column; re-provision the route/);
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("assigns anchors to 500 rows in one atomic batch (no metadata quota bound)", async () => {
    // The old developer-metadata scheme capped a User_Input tab at roughly
    // 410-420 rows per sheet quota; anchors as cell values have no such
    // bound, so a 500-row tab is fully anchored in one batch.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
      rows: Array.from({ length: 500 }, (_, index) => [
        `u${index + 1}`,
        "pending",
        null,
      ]),
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const observed = await provider.observeSnapshot(userInputSnapshotRequest());

    expect(observed.anchors.assigned).toBe(500);
    expect(observed.anchors.existing).toBe(0);
    expect(observed.anchors.duplicateAnchors).toEqual([]);
    // One atomic anchor batch carrying one updateCells per anchored row.
    expect(transport.batchUpdateCalls).toBe(1);
    const batch = transport.appliedBatchUpdates[0];
    expect(batch?.filter((request) => request.kind === "updateCells")).toHaveLength(500);
    expect(observed.snapshot.rows).toHaveLength(500);
    expect(observed.snapshot.unanchoredRows).toEqual([]);

    // The second pass reuses every anchor: zero writes, zero assignments.
    const again = await provider.observeSnapshot(userInputSnapshotRequest());
    expect(again.anchors.assigned).toBe(0);
    expect(again.anchors.existing).toBe(500);
    expect(transport.batchUpdateCalls).toBe(1);
  });

  it("observeSnapshots shares one anchor write and one re-read across tabs", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 1);
    spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
      rows: [["u1", "pending", null]],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const results = await provider.observeSnapshots([
      systemSnapshotRequest(),
      userInputSnapshotRequest(),
    ]);

    expect(transport.batchUpdateCalls).toBe(1);
    expect(transport.getSpreadsheetCalls).toBe(2); // one read + one shared re-read
    // Anchors are user_input-only: the system tab gets no anchor writes.
    expect(results.map((result) => result.anchors.assigned)).toEqual([0, 1]);
    expect(results.map((result) => result.snapshot.rows.length)).toEqual([1, 1]);
    expect(results[0]?.snapshot.rows[0]?.physicalAnchor.kind).toBe("absent");
    expect(results[1]?.snapshot.rows[0]?.physicalAnchor.kind).toBe("present");
  });
});

describe("GoogleSheetsApiSyncProvider snapshot fidelity", () => {
  it("keeps the outbound preflight masks and adds separate observation/values masks", () => {
    // Row anchors are cell values in the User_Input system column, so no
    // mask requests developer metadata anymore.
    expect(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS).toBe(
      "sheets.properties(sheetId,title,hidden),sheets.data(startRow,startColumn," +
      "rowData.values(userEnteredValue,userEnteredFormat.numberFormat,effectiveFormat.numberFormat))",
    );
    expect(GOOGLE_SHEETS_API_ENUMERATION_FIELDS).toBe("sheets.properties(sheetId,title,hidden)");
    // Merged regions are sheet-level `sheets.merges` GridRange entries in the
    // real API; GridData has no mergedCells field, so the observation mask
    // must request the sheet-level field and never a per-grid mergedCells.
    expect(GOOGLE_SHEETS_API_OBSERVATION_FIELDS).toContain("sheets.merges");
    expect(GOOGLE_SHEETS_API_OBSERVATION_FIELDS).not.toContain("mergedCells");
    expect(GOOGLE_SHEETS_API_OBSERVATION_FIELDS).toContain("effectiveValue");
    expect(GOOGLE_SHEETS_API_OBSERVATION_FIELDS).toContain("dataValidation");
    // The lightweight user_input mask drops merges and dataValidation (the
    // lightweight branch never consults either), keeping effectiveValue and
    // the system-column anchor values the snapshot needs.
    expect(GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS).not.toContain("merges");
    expect(GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS).not.toContain("dataValidation");
    expect(GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS).toContain("effectiveValue");
    expect(GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS).not.toContain("developerMetadata");
    expect(GOOGLE_SHEETS_API_OBSERVATION_FIELDS).not.toContain("developerMetadata");
    expect(GOOGLE_SHEETS_API_VALUES_FIELDS).toContain("effectiveValue");
    expect(GOOGLE_SHEETS_API_VALUES_FIELDS).toContain("dataValidation");
    expect(GOOGLE_SHEETS_API_VALUES_FIELDS).not.toContain("mergedCells");
    expect(GOOGLE_SHEETS_API_VALUES_FIELDS).not.toContain("sheets.merges");
    expect(GOOGLE_SHEETS_API_PROVISION_ENUMERATION_FIELDS).toContain("gridProperties(rowCount,columnCount)");
    expect(GOOGLE_SHEETS_API_PROVISION_FIELDS).not.toContain("effectiveValue");
  });

  it("classifies formula cells with the sha256 formula hash", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", formulaCell("=B2*2", { numberValue: 84 }, "84"));
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const snapshot = await provider.readSnapshot(userInputSnapshotRequest());
    const status = snapshot.rows[0]?.cells.status;
    expect(status?.cellKind).toBe("formula");
    expect(status?.normalizedCell).toBeNull();
    expect(status?.formulaHash).toEqual({
      kind: "present",
      value: createHash("sha256").update("=B2*2", "utf8").digest("hex"),
    });
    expect(status?.stableHash.kind).toBe("absent");
  });

  it("classifies every covered cell of one merged range with its full A1 notation", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", { userEnteredValue: { stringValue: "pending" } });
    tab.cells.set("2,0", { userEnteredValue: { stringValue: "merged-anchor" } });
    // Merge A3:B3 (0-based row 2, columns 0-1). The stub emits the region as
    // a sheet-level `merges` GridRange entry (the real API wire shape), which
    // the observation mask requests and the parser attaches to the sheet.
    tab.mergedRanges.push({
      startRowIndex: 2,
      endRowIndex: 3,
      startColumnIndex: 0,
      endColumnIndex: 2,
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const snapshot = await provider.readSnapshot(userInputSnapshotRequest());
    expect(snapshot.rows.map((row) => row.rowNumber)).toEqual([2, 3]);
    const row3 = snapshot.rows.find((row) => row.rowNumber === 3);
    expect(row3?.cells.id).toMatchObject({
      cellKind: "merged",
      normalizedCell: null,
      mergeRange: { kind: "present", value: "A3:B3" },
      stableHash: { kind: "absent" },
    });
    expect(row3?.cells.status?.cellKind).toBe("merged");
    expect(presenceValue(row3?.cells.status?.mergeRange)).toBe("A3:B3");
    // The untouched row keeps its literal classification.
    expect(snapshot.rows[0]?.cells.id?.cellKind).toBe("literal");
  });

  it("classifies every supported displayed error code", async () => {
    const codes = ["#REF!", "#DIV/0!", "#N/A", "#VALUE!", "#NAME?", "#NUM!", "#ERROR!", "#NULL!"];
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    codes.forEach((code, index) => {
      tab.cells.set(`${index + 1},0`, { userEnteredValue: { stringValue: `row-${index}` } });
      tab.cells.set(`${index + 1},1`, {
        userEnteredValue: { errorValue: { type: "ERROR_TYPE" } },
        formattedValue: code,
      });
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const snapshot = await provider.readSnapshot(userInputSnapshotRequest());
    expect(snapshot.rows).toHaveLength(codes.length);
    snapshot.rows.forEach((row, index) => {
      expect(row.cells.status).toMatchObject({
        cellKind: "error",
        normalizedCell: null,
        errorCode: { kind: "present", value: codes[index] },
      });
    });
  });

  it("emits stableHash evidence for literals AND blank cells (stableHash(null))", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", { userEnteredValue: { stringValue: "paid" } });
    tab.cells.set("2,0", { userEnteredValue: { stringValue: "u2" } });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const snapshot = await provider.readSnapshot(userInputSnapshotRequest());
    const literal = snapshot.rows[0]?.cells.status;
    expect(literal?.cellKind).toBe("literal");
    expect(literal?.stableHash).toEqual({
      kind: "present",
      value: stableHash(cell.string("paid")),
    });
    const blank = snapshot.rows[1]?.cells.status;
    expect(blank?.cellKind).toBe("blank");
    expect(blank?.normalizedCell).toBeNull();
    expect(blank?.stableHash).toEqual({ kind: "present", value: stableHash(null) });
  });

  it("normalizes canonical-format numbers as dates in snapshots", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", {
      userEnteredValue: { numberValue: dateSerialFromIso("2024-02-01T00:00:00.000Z") },
      userEnteredFormat: { numberFormat: GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT },
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const snapshot = await provider.readSnapshot(userInputSnapshotRequest());
    expect(snapshot.rows[0]?.cells.status?.normalizedCell).toEqual(
      cell.date("2024-02-01T00:00:00.000Z"),
    );
  });

  it("lightweight mode omits stableHash and merge/formula detection", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", formulaCell("=B2*2", { numberValue: 84 }, "84"));
    // Merge A2:B2 over the formula row: full mode classifies it as merged,
    // lightweight mode reads the raw computed values instead.
    tab.mergedRanges.push({
      startRowIndex: 1,
      endRowIndex: 2,
      startColumnIndex: 0,
      endColumnIndex: 2,
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const full = await provider.readSnapshot(userInputSnapshotRequest());
    expect(full.rows[0]?.cells.status?.cellKind).toBe("merged");
    expect(presenceValue(full.rows[0]?.cells.status?.mergeRange)).toBe("A2:B2");

    const lightweight = await provider.readSnapshot(
      userInputSnapshotRequest({ readMode: SYNC_SNAPSHOT_READ_MODES.USER_INPUT }),
    );
    expect(lightweight.rows[0]?.cells.status).toMatchObject({
      cellKind: "literal",
      normalizedCell: cell.number(84),
      stableHash: { kind: "absent" },
      mergeRange: { kind: "absent" },
    });
    expect(lightweight.rows[0]?.cells.id).toMatchObject({
      cellKind: "literal",
      normalizedCell: cell.string("u1"),
    });
  });

  it("detects displayed error strings in lightweight mode from raw values", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", {
      userEnteredValue: { formulaValue: "=1/0" },
      effectiveValue: { errorValue: { type: "DIVIDE_BY_ZERO" } },
      formattedValue: "#DIV/0!",
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const snapshot = await provider.readSnapshot(
      userInputSnapshotRequest({ readMode: SYNC_SNAPSHOT_READ_MODES.USER_INPUT }),
    );
    expect(snapshot.rows[0]?.cells.status?.cellKind).toBe("error");
    expect(presenceValue(snapshot.rows[0]?.cells.status?.errorCode)).toBe("#DIV/0!");
    expect(snapshot.rows[0]?.cells.status?.stableHash.kind).toBe("absent");
  });

  it("produces stable snapshot hashes equal to the wire-shape computation", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    tab.cells.set("1,0", { userEnteredValue: { stringValue: "u1" } });
    tab.cells.set("1,1", { userEnteredValue: { stringValue: "paid" } });
    tab.cells.set("1,2", { userEnteredValue: { stringValue: "sync-anchor:anchor-1" } });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const first = await provider.readSnapshot(userInputSnapshotRequest());
    const second = await provider.readSnapshot(userInputSnapshotRequest());
    expect(second.snapshotHash).toBe(first.snapshotHash);

    const wire = wireSnapshotShape(first) as StableValue;
    expect(first.snapshotHash).toBe(stableHash(wire));
  });

  it("uses a lighter request mask for lightweight user_input reads", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 1);
    spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
      rows: [["u1", "pending", null]],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    await provider.readSnapshot(userInputSnapshotRequest({
      readMode: SYNC_SNAPSHOT_READ_MODES.USER_INPUT,
    }));
    const lightweightRequest = transport.getSpreadsheetRequests.at(-1);
    expect(lightweightRequest?.fields).toBe(GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS);
    expect(lightweightRequest?.fields).not.toContain("merges");
    expect(lightweightRequest?.fields).not.toContain("dataValidation");

    await provider.readSnapshot(userInputSnapshotRequest());
    const fullRequest = transport.getSpreadsheetRequests.at(-1);
    expect(fullRequest?.fields).toBe(GOOGLE_SHEETS_API_OBSERVATION_FIELDS);
    expect(fullRequest?.fields).toContain("sheets.merges");
    expect(fullRequest?.fields).toContain("dataValidation");
  });

  it("rejects unknown readMode values with INVALID_EFFECT_PAYLOAD before any read", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 1);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    await expect(provider.readSnapshot(systemSnapshotRequest({
      readMode: "bogus" as never,
    }))).rejects.toMatchObject({
      code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      message: "Google Sheets API observation readMode is not supported",
    });
    expect(transport.getSpreadsheetCalls).toBe(0);
  });

  it("rejects user_input readMode on non-user_input projections", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 1);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    await expect(provider.readSnapshot(systemSnapshotRequest({
      readMode: SYNC_SNAPSHOT_READ_MODES.USER_INPUT,
    }))).rejects.toThrow(/user_input readMode requires the user_input projection/);
  });
});

describe("GoogleSheetsApiSyncProvider pacing and telemetry", () => {
  it("paces each preflight transport call and emits one event per request", async () => {
    let now = 1_000_000;
    const events: GoogleSheetsApiRequestEvent[] = [];
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 1);
    const transport = new StubSheetsTransport(spreadsheet);
    transport.now = () => now;
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [SYSTEM_DEFINITION],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
      onRequest: (event) => events.push(event),
    });

    await provider.applyEffects(pacedApplyRequest());

    // Preflight = two paced reads (enumeration + data), one paced write.
    const readStarts = transport.requestStarts.filter((entry) => entry.kind === "read");
    const writeStarts = transport.requestStarts.filter((entry) => entry.kind === "write");
    expect(readStarts).toHaveLength(2);
    expect(writeStarts).toHaveLength(1);
    const readGap = (readStarts[1]?.at ?? 0) - (readStarts[0]?.at ?? 0);
    expect(readGap).toBeGreaterThanOrEqual(1_100);

    const readEvents = events.filter((event) => event.operation === "getSpreadsheet");
    const writeEvents = events.filter((event) => event.operation === "batchUpdate");
    expect(readEvents).toHaveLength(2);
    expect(writeEvents).toHaveLength(1);
    expect(readEvents.every((event) => event.operationCount === 1)).toBe(true);
  });

  it("serializes read AND write starts through ONE shared limiter", async () => {
    let now = 1_000_000;
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 1);
    const transport = new StubSheetsTransport(spreadsheet);
    transport.now = () => now;
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [SYSTEM_DEFINITION],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });

    // One applyEffects run: the two reads gate each other and the write
    // shares the SAME limiter, so it starts one full interval after the
    // second read instead of beside it (the old per-class behavior).
    await provider.applyEffects(pacedApplyRequest());
    const readStarts = transport.requestStarts.filter((entry) => entry.kind === "read");
    const writeStarts = transport.requestStarts.filter((entry) => entry.kind === "write");
    expect(readStarts).toHaveLength(2);
    expect(writeStarts).toHaveLength(1);
    expect(writeStarts[0]?.at).toBe((readStarts[1]?.at ?? 0) + 1_100);
    // Total elapsed is exactly TWO intervals: read 1 at t0, read 2 at
    // t0+1,100, write at t0+2,200.
    expect(now).toBe(1_002_200);
  });

  it("paces concurrent reads and writes of different operations through one limiter", async () => {
    let now = 1_000_000;
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 2);
    const transport = new StubSheetsTransport(spreadsheet);
    transport.now = () => now;
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [SYSTEM_DEFINITION],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });

    // Two applyEffects runs (4 reads + 2 writes) share ONE limiter, so the
    // SECOND run's first read must start a full interval after the FIRST
    // run's write — under the old per-class design that read started beside
    // the write (gap 0). Every consecutive start of either class stays at
    // least one interval apart.
    await provider.applyEffects(pacedApplyRequest("u1", "paced-1"));
    await provider.applyEffects(pacedApplyRequest("u2", "paced-2"));
    const starts = transport.requestStarts.map((entry) => entry.at);
    expect(starts).toHaveLength(6);
    for (let index = 1; index < starts.length; index += 1) {
      expect((starts[index] ?? 0) - (starts[index - 1] ?? 0)).toBeGreaterThanOrEqual(1_100);
    }
    // The cross-class boundary: second run's read 1 starts 1,100 ms after
    // the first run's write (not beside it).
    expect((starts[3] ?? 0) - (starts[2] ?? 0)).toBeGreaterThanOrEqual(1_100);
    // Six slots at 1,100 ms apart: exactly five intervals of fake time.
    expect(now).toBe(1_000_000 + 5 * 1_100);
  });

  it("refuses a queued fourth request beyond one interval with zero remote calls", async () => {
    let now = 1_000_000;
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 1);
    const transport = new StubSheetsTransport(spreadsheet);
    transport.now = () => now;
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [SYSTEM_DEFINITION],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 1_100,
      now: () => now,
      // The clock advances only when a sleep RESOLVES (real-world behavior):
      // every queued caller's synchronous reservation prefix runs at the
      // same frozen instant, so the third and fourth callers predict slots
      // two intervals out and are refused before any SDK call.
      sleep: async (ms: number) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        now += ms;
      },
    });
    const readRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: SYSTEM_HEADERS,
    };

    // Four queued reads at the same instant: the immediate slot and the
    // slot exactly one interval out are admitted; the third and fourth are
    // refused BEFORE any SDK call, so the remote sees exactly two starts.
    const settled = await Promise.allSettled([
      provider.readRows(readRequest),
      provider.readRows(readRequest),
      provider.readRows(readRequest),
      provider.readRows(readRequest),
    ]);
    expect(transport.getSpreadsheetCalls).toBe(2);
    expect(transport.batchUpdateCalls).toBe(0);
    expect(transport.requestStarts.map((entry) => entry.at)).toEqual([
      1_000_000,
      1_001_100,
    ]);
    expect(settled[0]?.status).toBe("fulfilled");
    expect(settled[1]?.status).toBe("fulfilled");
    for (const result of [settled[2], settled[3]]) {
      expect(result?.status).toBe("rejected");
      if (result?.status !== "rejected") continue;
      const error = result.reason;
      expect(error).toBeInstanceOf(GoogleSheetsApiTransportError);
      expect((error as GoogleSheetsApiTransportError).code).toBe(
        GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED,
      );
      // A refused start is delivery-uncertain material: the durable worker
      // requeues/probes it, never closing the effect on unverified evidence.
      expect(classifyTransportOutcome(error).kind).toBe(
        TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN,
      );
    }

    // The refusals never advanced the limiter horizon: when time advances
    // only HALF an interval past the open slot, a fresh request is admitted
    // with the remaining 600 ms wait instead of being refused again.
    now = 1_001_600;
    const late = await provider.readRows(readRequest);
    expect(late.rows).toHaveLength(1);
    expect(transport.getSpreadsheetCalls).toBe(3);
    expect(transport.requestStarts[2]?.at).toBe(1_002_200);
  });

  it("refuses queued WRITES through the same bound when reads hold the shared queue", async () => {
    let now = 1_000_000;
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 1);
    const transport = new StubSheetsTransport(spreadsheet);
    transport.now = () => now;
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [SYSTEM_DEFINITION],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        now += ms;
      },
    });
    const readRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: SYSTEM_HEADERS,
    };
    const appendRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      rows: [{
        effectId: "append-1",
        payloadHash: "payload-1",
        anchor: "anchor-1",
        fields: {
          id: { kind: "string" as const, value: "a1" },
          status: { kind: "string" as const, value: "pending" },
          __typed_sheets_deleted: { kind: "boolean" as const, value: false },
        },
      }],
    };

    // Two reads and two fastAppend WRITES queue at the same instant. The
    // shared bound admits the two reads; each write is refused at its FIRST
    // preflight read, so the remote sees zero batchUpdate calls — reads and
    // writes share the same bounded queue.
    const settled = await Promise.allSettled([
      provider.readRows(readRequest),
      provider.readRows(readRequest),
      provider.fastAppendRows(appendRequest),
      provider.fastAppendRows(appendRequest),
    ]);
    expect(transport.getSpreadsheetCalls).toBe(2);
    expect(transport.batchUpdateCalls).toBe(0);
    expect(settled[0]?.status).toBe("fulfilled");
    expect(settled[1]?.status).toBe("fulfilled");
    for (const result of [settled[2], settled[3]]) {
      expect(result?.status).toBe("rejected");
      if (result?.status !== "rejected") continue;
      expect((result.reason as GoogleSheetsApiTransportError).code).toBe(
        GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED,
      );
    }

    // Once the queue drains, a write is admitted and commits remotely.
    now = 1_003_000;
    const appended = await provider.fastAppendRows(appendRequest);
    expect(appended.results[0]?.status).toBe("applied");
    expect(transport.batchUpdateCalls).toBe(1);
  });

  it("applies the read timeout to every getSpreadsheet call but not writes", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, 1);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [SYSTEM_DEFINITION],
      transport,
      requestTimeoutMs: 60_000,
      readTimeoutMs: 10_000,
      rateLimitIntervalMs: 0,
    });

    await provider.applyEffects(pacedApplyRequest());
    expect(transport.getSpreadsheetRequests).toHaveLength(2);
    expect(transport.getSpreadsheetRequests.every((request) => request.timeoutMs === 10_000))
      .toBe(true);
    // The transport-level write timeout stays the configured write timeout;
    // the read override only affects getSpreadsheet requests.
    expect(provider.timeoutMs).toBe(60_000);
  });

  it("rejects a readTimeoutMs outside the 1..60 second bounds at construction", () => {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    expect(() => new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: DEFINITIONS,
      transport,
      requestTimeoutMs: 60_000,
      readTimeoutMs: 500,
      rateLimitIntervalMs: 0,
    })).toThrow(/readTimeoutMs must be between 1 second and 60 seconds/);
    expect(transport.getSpreadsheetCalls).toBe(0);
  });
});

/**
 * Builds one deferred system_state create that applies over a seeded row.
 * `id`/`effectId` default to the first seeded row so callers can build
 * disjoint concurrent requests.
 */
function pacedApplyRequest(id = "u1", effectId = "paced-1"): ApplySyncEffectsRequest {
  const fields = {
    id: cell.string(id),
    status: cell.string("pending"),
    __typed_sheets_deleted: cell.bool(false),
  };
  const targetVisibleHash = computeSyncVisibleHash(fields);
  const effect: SyncProjectionEffect = {
    effectId,
    payloadHash: `${effectId}-payload`,
    effectKind: "system_projection",
    physicalSheetId: SYSTEM_SHEET_ID,
    projection: SYNC_PROJECTIONS.SYSTEM_STATE,
    targetKind: "entity",
    targetId: `entity:users:${id}`,
    rowBindingId: presentValue(`row:${id}`),
    conflictId: absentValue(),
    expectedVisibleRevision: 1,
    expectedVisibleHash: targetVisibleHash,
    repairGuardHash: absentValue(),
    payload: {
      sheetName: "Users_System",
      registeredRange: "A:C",
      schemaVersion: 1,
      targetAnchor: id,
      fields,
      targetVisibleHash,
      createIfMissing: true,
      expectedCandidateHash: { kind: "not_applicable" },
    },
  };
  return {
    physicalSheetId: SYSTEM_SHEET_ID,
    sheetName: "Users_System",
    registeredRange: "A:C",
    projection: SYNC_PROJECTIONS.SYSTEM_STATE,
    schemaVersion: 1,
    postconditionMode: "deferred",
    effects: [effect],
  };
}

/** Rebuilds the Apps Script wire-shaped snapshot object for hash parity. */
function wireSnapshotShape(snapshot: SyncSheetsSnapshot): unknown {
  return {
    protocolVersion: snapshot.protocolVersion,
    sheetName: snapshot.sheetName,
    registeredRange: snapshot.registeredRange,
    projection: snapshot.projection,
    schemaVersion: snapshot.schemaVersion,
    headers: snapshot.headers,
    rows: snapshot.rows.map((row) => ({
      rowNumber: row.rowNumber,
      physicalAnchor: presenceToNull(row.physicalAnchor),
      visibleRevision: null,
      visibleHash: null,
      cells: Object.fromEntries(
        snapshot.headers.map((header) => {
          const cell = row.cells[header];
          if (cell === undefined) {
            throw new Error(`snapshot cell is missing for header: ${header}`);
          }
          return [header, {
            cellKind: cell.cellKind,
            normalizedCell: cell.normalizedCell,
            formulaHash: presenceToNull(cell.formulaHash),
            mergeRange: presenceToNull(cell.mergeRange),
            errorCode: presenceToNull(cell.errorCode),
            stableHash: presenceToNull(cell.stableHash),
          }];
        }),
      ),
    })),
  };
}

function presenceToNull(presence: { readonly kind: string; readonly value?: string }): string | null {
  return presence.kind === "present" ? presence.value ?? null : null;
}

/** Returns the value of a Presence, or null when absent. */
function presenceValue(
  presence: { readonly kind: string; readonly value?: string } | undefined,
): string | null {
  return presence === undefined ? null : presenceToNull(presence);
}
