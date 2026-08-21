/**
 * Credential-free coverage for the direct Google Sheets API outbound provider.
 *
 * These tests exercise the provider through the narrow stub transport with an
 * in-memory spreadsheet model: bulk preflight fail-closed validation, the
 * ported Apps Script planning semantics, atomic target+receipt batches,
 * date serial/number-format preservation, append replay/idempotency, byte
 * budget prefixing, postcondition recovery classification, transport error
 * classification, request-start limiting, and redacted telemetry. No test
 * requires Google credentials or a network call.
 */

import { describe, expect, it } from "vitest";

import type { NormalizedCell } from "../src/shared/encoding/types.js";
import { presentValue, absentValue, notApplicableValue } from "../src/shared/state/index.js";
import { computeSyncVisibleHash } from "../src/application/sync/sheetsContract/syncSheets.js";
import type {
  ApplySyncEffectsRequest,
  FastAppendRow,
  SyncProjectionEffect,
} from "../src/application/sync/sheetsContract/syncSheets.js";
import { SYNC_POSTCONDITION_MODES } from "../src/application/sync/sheetsContract/constants.js";
import { classifyTransportOutcome, TRANSPORT_OUTCOME_KINDS, TRANSPORT_OUTCOME_UNKNOWN_CODE } from "../src/application/sync/sheetsContract/transportOutcome.js";
import { GoogleSheetsApiSyncProvider, classifyGoogleSheetsApiError, isRetryableTransportStatus } from "../src/adapter/sheets/providers/google-sheets-api/index.js";
import { serializeBatchUpdateRequests } from "../src/adapter/sheets/providers/google-sheets-api/transport/googleSheetsApiTransport.js";
import { GOOGLE_SHEETS_API_PREFLIGHT_FIELDS, GOOGLE_SHEETS_API_ENUMERATION_FIELDS } from "../src/adapter/sheets/providers/google-sheets-api/model/preflightFields.js";
import { GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME } from "../src/adapter/sheets/providers/google-sheets-api/constants.js";
import { dateSerialFromIso } from "../src/adapter/sheets/providers/google-sheets-api/model/valueNormalization.js";
import { GoogleSheetsApiTransportError, GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES } from "../src/adapter/sheets/providers/google-sheets-api/errors.js";
import { SYNC_SHEETS_ERROR_CODES } from "../src/application/sync/sheetsContract/errors.js";
import type { RegisteredSyncProjectionDefinition } from "../src/application/sync/sheetsContract/sheetsProvisioning.js";
import {
  StubSpreadsheet,
  StubSheetsTransport,
  stubRowFields,
  stubRowVisibleHash,
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
  readonly headers: readonly string[];
  readonly checkboxHeaders?: readonly string[];
}): RegisteredSyncProjectionDefinition {
  return {
    sheet: {
      logicalSheetId: "entity:users",
      physicalSheetId: overrides.physicalSheetId,
      spreadsheetId: SPREADSHEET_ID,
      tabName: overrides.tabName,
      // user_input tabs reserve the last column for the internal
      // __hikoutei_row_id system column.
      registeredRange: "A:" + columnLetters(
        overrides.headers.length + (overrides.projection === "user_input" ? 1 : 0),
      ),
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

function columnLetters(count: number): string {
  return String.fromCharCode(64 + count);
}

const SYSTEM_DEFINITION = definition({
  physicalSheetId: SYSTEM_SHEET_ID,
  tabName: "Users_System",
  projection: "system_state",
  headers: SYSTEM_HEADERS,
});
const USER_INPUT_DEFINITION = definition({
  physicalSheetId: USER_INPUT_SHEET_ID,
  tabName: "Users_Input",
  projection: "user_input",
  headers: USER_INPUT_HEADERS,
});
const CONFLICT_DEFINITION = definition({
  physicalSheetId: CONFLICT_SHEET_ID,
  tabName: "Users_Conflicts",
  projection: "sync_conflicts",
  headers: CONFLICT_HEADERS,
  checkboxHeaders: ["Status"],
});

function buildProvider(
  transport: StubSheetsTransport,
  options: {
    readonly maxBatchBytes?: number;
    readonly rateLimitIntervalMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly onRequest?: (event: unknown) => void;
  } = {},
): GoogleSheetsApiSyncProvider {
  return new GoogleSheetsApiSyncProvider({
    spreadsheetId: SPREADSHEET_ID,
    definitions: [SYSTEM_DEFINITION, USER_INPUT_DEFINITION, CONFLICT_DEFINITION],
    transport,
    requestTimeoutMs: 60_000,
    // Zero interval unless a test pins the interval: pacing itself is covered
    // by the dedicated pacing tests, so the default here must never make
    // unrelated tests wait on — or be refused by — the request-start limiter.
    rateLimitIntervalMs: options.rateLimitIntervalMs ?? 0,
    ...(options.maxBatchBytes === undefined ? {} : { maxBatchBytes: options.maxBatchBytes }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.onRequest === undefined ? {} : { onRequest: options.onRequest as never }),
  });
}

function seedSystemTab(
  spreadsheet: StubSpreadsheet,
  rows: readonly {
    readonly anchor: string;
    readonly fields: Readonly<Record<string, NormalizedCell>>;
    readonly identity?: string;
  }[],
): void {
  // System_State rows carry no physical anchors; rows are located by their
  // visible business key (id) on every apply/probe.
  void rows[0]?.anchor;
  spreadsheet.addTab("Users_System", {
    headers: SYSTEM_HEADERS,
    rows: rows.map((row) => SYSTEM_HEADERS.map((header) => row.fields[header] ?? null)),
  });
}

function seedUserInputTab(
  spreadsheet: StubSpreadsheet,
  rows: readonly {
    readonly anchor: string;
    readonly fields: Readonly<Record<string, NormalizedCell>>;
  }[],
): void {
  // The row anchor is the LAST column cell value (sync-anchor:<uuid>).
  spreadsheet.addTab("Users_Input", {
    headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
    rows: rows.map((row) => [
      ...USER_INPUT_HEADERS.map((header) => row.fields[header] ?? null),
      row.anchor,
    ]),
  });
}

function seedReceiptTab(
  spreadsheet: StubSpreadsheet,
  receipts: readonly {
    readonly effectId: string;
    readonly payloadHash: string;
    readonly visibleHash: string;
    readonly visibleRevision: number;
  }[],
): void {
  const tab = spreadsheet.addTab("__typed_sheets_internal_effect_receipts", {
    headers: ["effectId", "payloadHash", "status", "visibleHash", "visibleRevision", "updatedAt"],
    rows: receipts.map((receipt) => [
      receipt.effectId,
      receipt.payloadHash,
      "applied",
      receipt.visibleHash,
      receipt.visibleRevision,
      "2024-01-01T00:00:00.000Z",
    ]),
    hidden: true,
  });
  void tab;
}

interface EffectSeed {
  readonly effectId?: string;
  readonly payloadHash?: string;
  readonly effectKind?: SyncProjectionEffect["effectKind"];
  readonly projection?: string;
  readonly targetId?: string;
  readonly targetAnchor: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly expectedVisibleRevision?: number;
  readonly expectedVisibleHash?: string;
  readonly createIfMissing?: boolean;
  readonly repairGuardHash?: string;
  readonly expectedCandidateHash?: string;
  readonly physicalSheetId?: string;
}

function effect(seed: EffectSeed): SyncProjectionEffect {
  const fields = { ...seed.fields };
  const targetVisibleHash = computeSyncVisibleHash(fields);
  const projection = seed.projection ?? "system_state";
  const physicalSheetId = seed.physicalSheetId ?? SYSTEM_SHEET_ID;
  const route = projection === "user_input"
    ? { sheetName: "Users_Input", registeredRange: "A:C" }
    : projection === "sync_conflicts"
      ? { sheetName: "Users_Conflicts", registeredRange: "A:O" }
      : { sheetName: "Users_System", registeredRange: "A:C" };
  return {
    effectId: seed.effectId ?? "effect-1",
    payloadHash: seed.payloadHash ?? "payload-1",
    effectKind: seed.effectKind ?? "system_projection",
    physicalSheetId,
    projection: projection as SyncProjectionEffect["projection"],
    targetKind: "entity",
    targetId: seed.targetId ?? `entity:users:${seed.targetAnchor}`,
    rowBindingId: presentValue(`row:${seed.targetAnchor}`),
    conflictId: absentValue(),
    expectedVisibleRevision: seed.expectedVisibleRevision ?? 0,
    expectedVisibleHash: seed.expectedVisibleHash ?? "",
    repairGuardHash: seed.repairGuardHash === undefined
      ? absentValue()
      : presentValue(seed.repairGuardHash),
    payload: {
      sheetName: route.sheetName,
      registeredRange: route.registeredRange,
      schemaVersion: 1,
      targetAnchor: seed.targetAnchor,
      fields,
      targetVisibleHash,
      createIfMissing: seed.createIfMissing ?? false,
      expectedCandidateHash: seed.expectedCandidateHash === undefined
        ? notApplicableValue()
        : { kind: "applicable", value: seed.expectedCandidateHash },
    },
  };
}

function applyRequest(
  provider: GoogleSheetsApiSyncProvider,
  effects: readonly SyncProjectionEffect[],
  postconditionMode: "inline" | "deferred" = "deferred",
): ReturnType<GoogleSheetsApiSyncProvider["applyEffects"]> {
  return provider.applyEffects({
    physicalSheetId: effects[0]?.physicalSheetId ?? SYSTEM_SHEET_ID,
    sheetName: effects[0]?.payload.sheetName ?? "Users_System",
    registeredRange: effects[0]?.payload.registeredRange ?? "A:C",
    projection: effects[0]?.projection ?? "system_state",
    schemaVersion: 1,
    postconditionMode,
    effects,
  });
}

function appendRows(count: number, prefix = "a"): FastAppendRow[] {
  return Array.from({ length: count }, (_, index) => {
    const identity = `${prefix}-${String(index).padStart(4, "0")}`;
    return {
      effectId: `append-${identity}`,
      payloadHash: `payload-${identity}`,
      anchor: `anchor-${identity}`,
      fields: {
        id: { kind: "string", value: identity },
        status: { kind: "string", value: "pending" },
        __typed_sheets_deleted: { kind: "boolean", value: false },
      },
    };
  });
}

const cell = {
  string: (value: string): NormalizedCell => ({ kind: "string", value }),
  number: (value: number): NormalizedCell => ({ kind: "number", value }),
  bool: (value: boolean): NormalizedCell => ({ kind: "boolean", value }),
  date: (value: string): NormalizedCell => ({ kind: "date", value }),
};

describe("GoogleSheetsApiSyncProvider route and preflight validation", () => {
  it("rejects a request whose route does not match the registered definition", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const request: ApplySyncEffectsRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Wrong_Tab",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      effects: [effect({ targetAnchor: "a1", fields: { id: cell.string("u1"), status: cell.string("x") } })],
    };
    await expect(provider.applyEffects(request)).rejects.toMatchObject({
      code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    });
    expect(transport.getSpreadsheetCalls).toBe(0);
  });

  it("rejects an unknown physical sheet", async () => {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    await expect(provider.applyEffects({
      physicalSheetId: "unknown-sheet",
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      effects: [effect({ targetAnchor: "a1", fields: { id: cell.string("u1"), status: cell.string("x") } })],
    })).rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS });
  });

  it("fails closed on header drift, duplicate headers, and missing headers", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: ["id", "name", "status"] });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    await expect(applyRequest(provider, [
      effect({ targetAnchor: "a1", fields: { id: cell.string("u1"), status: cell.string("x") } }),
    ])).rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("requests a valid REST field mask for preflight grid reads", async () => {
    // GridData has no sheetId of its own (the parent sheet properties
    // identify the grid) and row anchors are plain cell values now, so the
    // mask must never request a nonexistent metadata path.
    expect(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS).toBe(
      "sheets.properties(sheetId,title,hidden)," +
      "sheets.data(startRow,startColumn," +
      "rowData.values(userEnteredValue,userEnteredFormat.numberFormat,effectiveFormat.numberFormat))",
    );
    expect(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS).not.toContain("sheets.data(sheetId");
    expect(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS).not.toContain("developerMetadata");
    // The enumeration mask is the minimal identity-only subset; it must never
    // request grid data paths.
    expect(GOOGLE_SHEETS_API_ENUMERATION_FIELDS).toBe(
      "sheets.properties(sheetId,title,hidden)",
    );
    expect(GOOGLE_SHEETS_API_ENUMERATION_FIELDS).not.toContain("sheets.data(");

    // The end-to-end preflight parses the REAL wire shape the stub now
    // produces (grids without sheetId, anchors as plain cell values).
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("x"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const result = await applyRequest(provider, [
      effect({
        effectId: "mask-1",
        targetAnchor: "anchor-1",
        targetId: "entity:users:u1",
        expectedVisibleRevision: 1,
        expectedVisibleHash: computeSyncVisibleHash({
          id: cell.string("u1"),
          status: cell.string("x"),
          __typed_sheets_deleted: cell.bool(false),
        }),
        fields: {
          id: cell.string("u1"),
          status: cell.string("written"),
          __typed_sheets_deleted: cell.bool(false),
        },
      }),
    ]);
    expect(result.results[0]?.status).toBe("applied");
  });

  it("rejects malformed SDK payloads with runtime guards before mutation", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    transport.fault = { kind: "malformedGetResponse" };
    const provider = buildProvider(transport);
    await expect(applyRequest(provider, [
      effect({ targetAnchor: "a1", fields: { id: cell.string("u1"), status: cell.string("x") } }),
    ])).rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("tolerates duplicated anchors from a copy-paste and still processes other rows", async () => {
    // Copying a row copies its UUID cell, so two rows carry the same anchor.
    // The preflight must not throw: the anchor index keeps the FIRST row per
    // value, duplicated rows are evidence (never rewritten), and writes for
    // other rows still proceed.
    const spreadsheet = new StubSpreadsheet();
    seedUserInputTab(spreadsheet, [
      { anchor: "sync-anchor:dup", fields: { id: cell.string("u1"), status: cell.string("x") } },
      { anchor: "sync-anchor:dup", fields: { id: cell.string("u2"), status: cell.string("y") } },
      { anchor: "sync-anchor:ok", fields: { id: cell.string("u3"), status: cell.string("z") } },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const result = await applyRequest(provider, [
      // A unique row still processes normally.
      effect({
        effectId: "update-unique",
        projection: "user_input",
        physicalSheetId: USER_INPUT_SHEET_ID,
        targetAnchor: "sync-anchor:ok",
        targetId: "entity:users:u3",
        expectedVisibleRevision: 1,
        expectedVisibleHash: computeSyncVisibleHash({
          id: cell.string("u3"),
          status: cell.string("z"),
        }),
        fields: { id: cell.string("u3"), status: cell.string("updated") },
      }),
      // An effect for the duplicated anchor resolves to the first row that
      // carries it (the original), never rewriting the copy row.
      effect({
        effectId: "update-original",
        projection: "user_input",
        physicalSheetId: USER_INPUT_SHEET_ID,
        targetAnchor: "sync-anchor:dup",
        targetId: "entity:users:u1",
        expectedVisibleRevision: 1,
        expectedVisibleHash: computeSyncVisibleHash({
          id: cell.string("u1"),
          status: cell.string("x"),
        }),
        fields: { id: cell.string("u1"), status: cell.string("x2") },
      }),
    ]);
    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "applied"]);
    expect(transport.batchUpdateCalls).toBe(1);
    const inputTab = spreadsheet.findTab("Users_Input");
    expect(inputTab).toBeDefined();
    if (inputTab === undefined) throw new Error("input tab missing");
    expect(stubRowFields(inputTab, 2, USER_INPUT_HEADERS)).toMatchObject({
      id: cell.string("u1"),
      status: cell.string("x2"),
    });
    // The copy row keeps its duplicated anchor and untouched fields.
    expect(stubRowFields(inputTab, 3, USER_INPUT_HEADERS)).toMatchObject({
      id: cell.string("u2"),
      status: cell.string("y"),
    });
    expect(stubRowFields(inputTab, 4, USER_INPUT_HEADERS)).toMatchObject({
      id: cell.string("u3"),
      status: cell.string("updated"),
    });
  });

  it("still fails closed on duplicate identities", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("x"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
      {
        anchor: "anchor-2",
        fields: {
          id: cell.string("u1"),
          status: cell.string("y"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    await expect(applyRequest(provider, [
      effect({
        targetAnchor: "anchor-3",
        fields: {
          id: cell.string("u3"),
          status: cell.string("z"),
          __typed_sheets_deleted: cell.bool(false),
        },
      }),
    ])).rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE });
    expect(transport.batchUpdateCalls).toBe(0);
  });

});

describe("GoogleSheetsApiSyncProvider applyEffects planning and batches", () => {
  it("batches effects spanning MULTIPLE tabs into ONE batchUpdate targeting different sheetIds", async () => {
    const spreadsheet = new StubSpreadsheet();
    // Seed two tabs that belong to one spreadsheet; the provider groups a
    // spreadsheet-scoped request across all of them.
    seedSystemTab(spreadsheet, []);
    seedUserInputTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const systemEffect = effect({
      effectId: "multi-system",
      physicalSheetId: SYSTEM_SHEET_ID,
      projection: "system_state",
      targetAnchor: "anchor-system",
      createIfMissing: true,
      fields: { id: cell.string("u-system"), status: cell.string("pending") },
    });
    const inputEffect = effect({
      effectId: "multi-input",
      physicalSheetId: USER_INPUT_SHEET_ID,
      projection: "user_input",
      targetAnchor: "anchor-input",
      createIfMissing: true,
      fields: { id: cell.string("u-input"), status: cell.string("pending") },
    });

    const result = await applyRequest(provider, [systemEffect, inputEffect]);
    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "applied"]);

    // ONE atomic batchUpdate whose requests target the different tabs' sheetIds.
    expect(transport.batchUpdateCalls).toBe(1);
    const batch = transport.appliedBatchUpdates[0];
    expect(batch).toBeDefined();
    if (batch === undefined) return;
    const systemTab = spreadsheet.findTab("Users_System");
    const inputTab = spreadsheet.findTab("Users_Input");
    expect(systemTab).toBeDefined();
    expect(inputTab).toBeDefined();
    if (systemTab === undefined || inputTab === undefined) return;
    const sheetIds = new Set(batch.map((request) => request.sheetId));
    expect(sheetIds).toContain(systemTab.sheetId);
    expect(sheetIds).toContain(inputTab.sheetId);
    expect(sheetIds.size).toBeGreaterThan(1);
    // Each tab's own effect landed in its own tab.
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS)).toMatchObject({
      id: cell.string("u-system"),
      status: cell.string("pending"),
    });
    expect(stubRowFields(inputTab, 2, USER_INPUT_HEADERS)).toMatchObject({
      id: cell.string("u-input"),
      status: cell.string("pending"),
    });
  });

  it("rejects a multi-route apply in inline postcondition mode before any mutation", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    seedUserInputTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const systemEffect = effect({
      effectId: "inline-system",
      physicalSheetId: SYSTEM_SHEET_ID,
      projection: "system_state",
      targetAnchor: "anchor-a",
      createIfMissing: true,
      fields: {
        id: cell.string("u1"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const inputEffect = effect({
      effectId: "inline-input",
      physicalSheetId: USER_INPUT_SHEET_ID,
      projection: "user_input",
      targetAnchor: "anchor-b",
      createIfMissing: true,
      fields: { id: cell.string("u2"), status: cell.string("pending") },
    });
    // Multi-route inline cannot verify written rows or persist receipts, so
    // it must reject BEFORE any read or mutation instead of acknowledging
    // unverified writes.
    await expect(applyRequest(provider, [systemEffect, inputEffect], "inline"))
      .rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD });
    expect(transport.getSpreadsheetRequests).toHaveLength(0);
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("plans multiple creates into one target+receipt batch", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const created = [
      effect({
        effectId: "create-1",
        targetAnchor: "anchor-new-1",
        targetId: "entity:users:u-new-1",
        createIfMissing: true,
        fields: { id: cell.string("u-new-1"), status: cell.string("pending") },
      }),
      effect({
        effectId: "create-2",
        targetAnchor: "anchor-new-2",
        targetId: "entity:users:u-new-2",
        createIfMissing: true,
        fields: { id: cell.string("u-new-2"), status: cell.string("active") },
      }),
    ];
    const result = await applyRequest(provider, created);
    expect(result.hasMore).toBe(false);
    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "applied"]);
    for (const entry of result.results) {
      expect(entry.postcondition).toBe("acknowledged");
      expect(entry.visibleRevision).toEqual({ kind: "present", value: 1 });
    }

    // One atomic batchUpdate carrying inserts, values, and receipts. System
    // rows carry no physical anchors (identity-located), so no anchor write
    // appears in the batch.
    expect(transport.batchUpdateCalls).toBe(1);
    const batch = transport.appliedBatchUpdates[0];
    expect(batch).toBeDefined();
    if (batch === undefined) return;
    const kinds = batch.map((request) => request.kind);
    expect(kinds).toContain("insertDimension");
    expect(kinds).toContain("updateCells");
    expect(kinds).not.toContain("createDeveloperMetadata");
    // The receipt tab was created in the SAME batch (addSheet + header + rows).
    expect(kinds).toContain("addSheet");
    expect(kinds).toContain("updateSheetProperties");

    const systemTab = spreadsheet.findTab("Users_System");
    expect(systemTab).toBeDefined();
    if (systemTab === undefined) return;
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS)).toMatchObject({
      id: cell.string("u-new-1"),
      status: cell.string("pending"),
    });
    const receiptTab = spreadsheet.findTab("__typed_sheets_internal_effect_receipts");
    expect(receiptTab?.hidden).toBe(true);
    expect(receiptTab?.cell(1, 0)?.userEnteredValue?.stringValue).toBe("create-1");
  });

  it("does not re-create the receipt tab on a later batch after its first creation", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    // First batch creates the receipt tab atomically with its effects.
    const first = await applyRequest(provider, [
      effect({
        effectId: "create-batch-1",
        targetAnchor: "anchor-batch-1",
        createIfMissing: true,
        fields: { id: cell.string("u-batch-1"), status: cell.string("pending") },
      }),
    ]);
    expect(first.results[0]?.status).toBe("applied");
    expect(transport.appliedBatchUpdates[0]?.some((request) =>
      request.kind === "addSheet")).toBe(true);

    // Second batch on the same spreadsheet: the preflight must discover the
    // (hidden) receipt tab through the enumeration, so the batch must NOT
    // plan another addSheet for it. This is the live load-test failure: the
    // old preflight could not see the receipt tab in its ranged response and
    // re-adding the tab makes the real API reject the whole batchUpdate with
    // 400 INVALID_ARGUMENT.
    const second = await applyRequest(provider, [
      effect({
        effectId: "create-batch-2",
        targetAnchor: "anchor-batch-2",
        createIfMissing: true,
        fields: { id: cell.string("u-batch-2"), status: cell.string("active") },
      }),
    ]);
    expect(second.results[0]?.status).toBe("applied");
    expect(transport.batchUpdateCalls).toBe(2);
    const secondBatch = transport.appliedBatchUpdates[1];
    if (secondBatch === undefined) throw new Error("expected a second batch");
    expect(secondBatch.some((request) => request.kind === "addSheet")).toBe(false);
    // Exactly one receipt tab exists in the spreadsheet model.
    expect(spreadsheet.sheets.filter((sheet) =>
      sheet.title === GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)).toHaveLength(1);
  });

  it("enumerates every sheet (no ranges) before the ranged data call and reads a hidden receipt tab", async () => {
    const spreadsheet = new StubSpreadsheet();
    const writtenFields = {
      id: cell.string("u1"),
      status: cell.string("written"),
      __typed_sheets_deleted: cell.bool(false),
    };
    seedSystemTab(spreadsheet, [
      { anchor: "anchor-1", fields: writtenFields },
    ]);
    // The hidden receipt tab already exists from a previous batch.
    seedReceiptTab(spreadsheet, [{
      effectId: "replay-1",
      payloadHash: "payload-1",
      visibleHash: computeSyncVisibleHash(writtenFields),
      visibleRevision: 1,
    }]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const write = effect({
      effectId: "replay-1",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      fields: {
        id: cell.string("u1"),
        status: cell.string("written"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const result = await applyRequest(provider, [write]);
    // The replay is classified from receipt evidence read through the data
    // call, which required the enumeration to find the hidden tab first.
    expect(result.results[0]?.status).toBe("already_applied");

    // Exactly two reads: enumeration (no ranges, identity-only mask), then
    // the ranged data call covering the target tab and the receipt tab.
    expect(transport.getSpreadsheetRequests).toHaveLength(2);
    const enumeration = transport.getSpreadsheetRequests[0];
    const dataCall = transport.getSpreadsheetRequests[1];
    if (enumeration === undefined || dataCall === undefined) {
      throw new Error("expected two getSpreadsheet requests");
    }
    expect(enumeration.ranges).toEqual([]);
    expect(enumeration.fields).toBe(GOOGLE_SHEETS_API_ENUMERATION_FIELDS);
    expect(dataCall.ranges).toContain("'Users_System'!A1:C1048576");
    expect(dataCall.ranges).toContain(
      `'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!A1:F1048576`,
    );
    // No mutation ran: the receipt evidence fully classified the replay.
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("finds a created row by targetId for a later effect with a different anchor", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const create = effect({
      effectId: "create-same",
      targetAnchor: "anchor-a",
      targetId: "entity:users:u-same",
      createIfMissing: true,
      fields: {
        id: cell.string("u-same"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    // Second effect: SAME targetId, DIFFERENT anchor, guard matching the
    // just-created state (expectedVisibleHash = first effect's target hash
    // restricted to the fields this effect writes).
    const update = effect({
      effectId: "update-same",
      targetAnchor: "anchor-b",
      targetId: "entity:users:u-same",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({ status: cell.string("pending") }),
      fields: { status: cell.string("active") },
    });
    const result = await applyRequest(provider, [create, update]);
    expect(result.hasMore).toBe(false);
    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "applied"]);
    // Exactly ONE physical row: the second effect updated the first's row
    // instead of appending a new one for anchor-b.
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(systemTab.lastContentRow()).toBe(1);
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS)).toMatchObject({
      id: cell.string("u-same"),
      status: cell.string("active"),
    });
  });

  it("updates scattered fields only and preserves date serials with the canonical format", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("pending"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
      {
        anchor: "anchor-2",
        fields: {
          id: cell.string("u2"),
          status: cell.string("active"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const baseline = stubRowVisibleHash(spreadsheet.findTab("Users_System") as never, 2, SYSTEM_HEADERS);
    const updated = effect({
      effectId: "update-1",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: baseline,
      fields: {
        id: cell.string("u1"),
        status: cell.date("2024-03-15T10:30:00.000Z"),
        __typed_sheets_deleted: cell.bool(true),
      },
    });
    const result = await applyRequest(provider, [updated]);
    expect(result.results[0]?.status).toBe("applied");
    expect(result.results[0]?.visibleHash).toEqual({
      kind: "present",
      value: updated.payload.targetVisibleHash,
    });

    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    // Only the target row changed; the second row is untouched.
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS)).toMatchObject({
      status: cell.date("2024-03-15T10:30:00.000Z"),
      __typed_sheets_deleted: cell.bool(true),
    });
    expect(stubRowFields(systemTab, 3, SYSTEM_HEADERS)).toMatchObject({
      status: cell.string("active"),
      __typed_sheets_deleted: cell.bool(false),
    });
    // The date cell carries the canonical number format object.
    const dateCell = systemTab.cell(1, 1);
    expect(dateCell?.userEnteredFormat?.numberFormat).toEqual({
      type: "DATE_TIME",
      pattern: 'yyyy"-"mm"-"dd"T"hh:mm:ss.000"Z"',
    });
    // The date serial matches the Apps Script formula.
    const expectedSerial = (Date.parse("2024-03-15T10:30:00.000Z") - Date.UTC(1899, 11, 30)) / 86_400_000;
    expect(dateCell?.userEnteredValue?.numberValue).toBe(expectedSerial);
  });

  it("rejects a visible guard mismatch without mutating the sheet", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("pending"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const stale = effect({
      effectId: "stale-1",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("other"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      fields: {
        id: cell.string("u1"),
        status: cell.string("new-value"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const result = await applyRequest(provider, [stale]);
    expect(result.results[0]).toMatchObject({
      status: "guard_mismatch",
      reason: { kind: "present", value: "visible_guard_mismatch" },
      postcondition: "unavailable",
    });
    // No mutation was sent; only the preflight reads happened.
    expect(transport.batchUpdateCalls).toBe(0);
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS).status).toEqual(cell.string("pending"));
  });

  it("applies an update whose guard hash contains a drifted date serial", async () => {
    // Regression for the direct-live soak `visible_guard_mismatch`: the sheet
    // row was written with `dateSerialFromIso(iso)`, and the unrounded
    // read-back conversion truncated the serial a hair below the exact
    // millisecond, so the re-hashed row differed from the canonical
    // expectedVisibleHash by one millisecond. Rounding the read-back to the
    // nearest millisecond makes the guard match the canonical fields again.
    const driftedIso = "2024-03-15T00:00:00.002Z";
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.date(driftedIso),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const updated = effect({
      effectId: "update-drift",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      // The guard hash comes from the canonical fields (the SQLite
      // authority), exactly as the sync worker computes it for a conflict
      // effect on the pre-delete row.
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.date(driftedIso),
        __typed_sheets_deleted: cell.bool(false),
      }),
      fields: {
        id: cell.string("u1"),
        status: cell.date(driftedIso),
        __typed_sheets_deleted: cell.bool(true),
      },
    });
    const result = await applyRequest(provider, [updated]);
    expect(result.results[0]?.status).toBe("applied");
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS)).toMatchObject({
      id: cell.string("u1"),
      status: cell.date(driftedIso),
      __typed_sheets_deleted: cell.bool(true),
    });
    // The stored serial is still the exact wire value from the canonical ISO.
    const statusCell = systemTab.cell(1, 1);
    expect(statusCell?.userEnteredValue?.numberValue).toBe(dateSerialFromIso(driftedIso));
  });

  it("rejects a candidate reconcile whose expected candidate hash does not match", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("pending"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const reconcile = effect({
      effectId: "reconcile-1",
      effectKind: "candidate_reconcile",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      // The row currently holds "pending", but the effect expected the stale
      // "y" state, so the candidate guard fires before any write.
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("y"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      expectedCandidateHash: "stale-candidate-hash",
      fields: {
        id: cell.string("u1"),
        status: cell.string("reconciled"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const result = await applyRequest(provider, [reconcile]);
    expect(result.results[0]).toMatchObject({
      status: "guard_mismatch",
      reason: { kind: "present", value: "candidate_guard_mismatch" },
    });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("returns repair_reobserve when the repair guard hash does not match", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("pending"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const repair = effect({
      effectId: "repair-1",
      effectKind: "system_repair",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      repairGuardHash: "wrong-guard-hash",
      fields: {
        id: cell.string("u1"),
        status: cell.string("repaired"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const result = await applyRequest(provider, [repair]);
    expect(result.results[0]).toMatchObject({
      status: "repair_reobserve",
      reason: { kind: "present", value: "repair_guard_mismatch" },
    });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("replays a receipted effect as already_applied without a second mutation", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("pending"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const write = effect({
      effectId: "replay-1",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      fields: {
        id: cell.string("u1"),
        status: cell.string("written"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const first = await applyRequest(provider, [write]);
    expect(first.results[0]?.status).toBe("applied");
    const callsAfterFirst = transport.batchUpdateCalls;
    const receiptTab = spreadsheet.findTab("__typed_sheets_internal_effect_receipts");
    expect(receiptTab?.cell(1, 3)?.userEnteredValue?.stringValue).toBe(write.payload.targetVisibleHash);

    // Replay: same effect id, same payload, row already carries the target.
    const replay = await applyRequest(provider, [write]);
    expect(replay.results[0]?.status).toBe("already_applied");
    expect(replay.results[0]?.visibleHash).toEqual({
      kind: "present",
      value: write.payload.targetVisibleHash,
    });
    // The replay wrote nothing: no target mutation and no duplicate receipt
    // (queueReceipt_ semantics skip stored receipts), so no batchUpdate ran.
    expect(transport.batchUpdateCalls).toBe(callsAfterFirst);
    // The receipt tab still has exactly one row for the effect (no duplicate).
    expect(receiptTab?.cell(2, 0)?.userEnteredValue?.stringValue).toBeUndefined();
  });

  it("rejects a receipted effect reused with a different payload", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    seedReceiptTab(spreadsheet, [{
      effectId: "reused-1",
      payloadHash: "original-payload",
      visibleHash: "hash",
      visibleRevision: 1,
    }]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const reused = effect({
      effectId: "reused-1",
      payloadHash: "different-payload",
      targetAnchor: "anchor-1",
      createIfMissing: true,
      fields: { id: cell.string("u1"), status: cell.string("x") },
    });
    const result = await applyRequest(provider, [reused]);
    expect(result.results[0]).toMatchObject({
      status: "schema_error",
      reason: { kind: "present", value: "effect_id_reused_with_different_payload" },
    });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("replays a duplicate effect ID inside one request against its planned receipt", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const write = effect({
      effectId: "dup-1",
      targetAnchor: "anchor-dup-1",
      createIfMissing: true,
      fields: { id: cell.string("u1"), status: cell.string("x") },
    });
    const result = await applyRequest(provider, [write, write]);
    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "already_applied"]);
    // The replay planned the SAME receipt; the batch wrote it once (no
    // duplicate receipt row for one effect ID).
    const receiptTab = spreadsheet.findTab("__typed_sheets_internal_effect_receipts");
    expect(receiptTab?.lastContentRow()).toBe(1);
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(systemTab.lastContentRow()).toBe(1);
  });

  it("rejects a duplicate effect ID with a different payload inside one request", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const first = effect({
      effectId: "dup-2",
      payloadHash: "payload-a",
      targetAnchor: "anchor-dup-2",
      createIfMissing: true,
      fields: { id: cell.string("u1"), status: cell.string("x") },
    });
    const second = effect({
      effectId: "dup-2",
      payloadHash: "payload-b",
      targetAnchor: "anchor-dup-2",
      createIfMissing: true,
      fields: { id: cell.string("u1"), status: cell.string("y") },
    });
    const result = await applyRequest(provider, [first, second]);
    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "schema_error"]);
    expect(result.results[1]?.reason).toEqual({
      kind: "present",
      value: "effect_id_reused_with_different_payload",
    });
    // The single receipt row belongs to the first (applied) plan only.
    const receiptTab = spreadsheet.findTab("__typed_sheets_internal_effect_receipts");
    expect(receiptTab?.lastContentRow()).toBe(1);
  });

  it("deletes contiguous and noncontiguous rows with descending deleteDimension requests", async () => {
    const spreadsheet = new StubSpreadsheet();
    const rows = [
      { anchor: "sync-anchor:anchor-1", id: "u1" },
      { anchor: "sync-anchor:anchor-2", id: "u2" },
      { anchor: "sync-anchor:anchor-3", id: "u3" },
      { anchor: "sync-anchor:anchor-4", id: "u4" },
      { anchor: "sync-anchor:anchor-5", id: "u5" },
    ];
    seedUserInputTab(spreadsheet, rows.map((row) => ({
      anchor: row.anchor,
      fields: { id: cell.string(row.id), status: cell.string("x") },
    })));
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const deleteAt = (row: (typeof rows)[number]): SyncProjectionEffect => effect({
      effectId: `delete-${row.anchor}`,
      effectKind: "user_input_delete",
      physicalSheetId: USER_INPUT_SHEET_ID,
      projection: "user_input",
      targetId: row.id,
      targetAnchor: row.anchor,
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string(row.id),
        status: cell.string("x"),
      }),
      fields: { id: cell.string(row.id), status: cell.string("x") },
    });
    const result = await applyRequest(provider, [
      deleteAt(rows[1] ?? { anchor: "anchor-2", id: "u2" }),
      deleteAt(rows[3] ?? { anchor: "anchor-4", id: "u4" }),
      deleteAt(rows[0] ?? { anchor: "anchor-1", id: "u1" }),
    ]);
    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "applied", "applied"]);
    const batch = transport.appliedBatchUpdates[0];
    if (batch === undefined) throw new Error("expected a batch");
    const deletes = batch.filter((request) => request.kind === "deleteDimension");
    // Descending physical row order: 1-based rows 5, 3, 2 -> 0-based 4, 2, 1.
    expect(deletes.map((request) => request.kind === "deleteDimension" ? request.startIndex : -1)).toEqual([4, 2, 1]);
    // Receipts travelled in the same atomic batch as the deletes.
    expect(batch.some((request) => request.kind === "updateCells" &&
      request.startRowIndex >= 1)).toBe(true);
    const inputTab = spreadsheet.findTab("Users_Input");
    if (inputTab === undefined) throw new Error("input tab missing");
    expect(inputTab.lastContentRow()).toBe(2);
    expect(stubRowFields(inputTab, 2, USER_INPUT_HEADERS).id).toEqual(cell.string("u3"));
    expect(stubRowFields(inputTab, 3, USER_INPUT_HEADERS).id).toEqual(cell.string("u5"));
  });

  it("rejects a delete whose fields do not cover every header", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedUserInputTab(spreadsheet, [
      { anchor: "sync-anchor:anchor-1", fields: { id: cell.string("u1"), status: cell.string("x") } },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const partial = effect({
      effectId: "delete-partial",
      effectKind: "user_input_delete",
      physicalSheetId: USER_INPUT_SHEET_ID,
      projection: "user_input",
      targetAnchor: "sync-anchor:anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("x"),
      }),
      fields: { id: cell.string("u1") },
    });
    const result = await applyRequest(provider, [partial]);
    // The Apps Script guard order checks the deletion guards before field
    // coverage, and a partial field set can never hash-match the full row.
    expect(result.results[0]).toMatchObject({
      status: "schema_error",
      reason: { kind: "present", value: "invalid_deletion_guard" },
    });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("rejects resolution_delete outside the sync_conflicts projection", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    await expect(applyRequest(provider, [
      effect({
        effectId: "bad-delete",
        effectKind: "resolution_delete",
        targetAnchor: "anchor-1",
        createIfMissing: true,
        fields: { id: cell.string("u1"), status: cell.string("x") },
      }),
    ])).rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("writes dates as serials with the canonical format for appended columns", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const created = effect({
      effectId: "create-date",
      targetAnchor: "anchor-date",
      createIfMissing: true,
      fields: {
        id: cell.string("u-date"),
        status: cell.date("2024-06-01T12:00:00.000Z"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const result = await applyRequest(provider, [created]);
    expect(result.results[0]?.status).toBe("applied");
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS).status).toEqual(
      cell.date("2024-06-01T12:00:00.000Z"),
    );
    const statusCell = systemTab.cell(1, 1);
    expect(statusCell?.userEnteredFormat?.numberFormat).toEqual({
      type: "DATE_TIME",
      pattern: 'yyyy"-"mm"-"dd"T"hh:mm:ss.000"Z"',
    });
    // Null/boolean/string round-trip in the same row.
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS).__typed_sheets_deleted).toEqual(cell.bool(false));
  });

  it("applies setDataValidation for checkbox headers on appended rows", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_Conflicts", { headers: CONFLICT_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const fields: Record<string, NormalizedCell> = {};
    CONFLICT_HEADERS.forEach((header, index) => {
      fields[header] = header === "Conflict_ID"
        ? cell.string(`conflict-${index}`)
        : header === "Status"
          ? cell.string("OPEN")
          : cell.string("v");
    });
    const created = effect({
      effectId: "create-conflict",
      physicalSheetId: CONFLICT_SHEET_ID,
      projection: "sync_conflicts",
      targetAnchor: "anchor-conflict",
      targetId: `conflict:${"create-conflict"}`,
      createIfMissing: true,
      fields,
    });
    const result = await applyRequest(provider, [created]);
    expect(result.results[0]?.status).toBe("applied");
    const conflictsTab = spreadsheet.findTab("Users_Conflicts");
    if (conflictsTab === undefined) throw new Error("conflicts tab missing");
    expect(conflictsTab.dataValidationRanges).toHaveLength(1);
    expect(conflictsTab.dataValidationRanges[0]).toMatchObject({
      startRowIndex: 1,
      endRowIndex: 2,
    });
  });
});

describe("GoogleSheetsApiSyncProvider fast append", () => {
  it("appends rows spanning MULTIPLE tabs in ONE batchUpdate targeting different sheetIds", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    spreadsheet.addTab("Orders_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [
        SYSTEM_DEFINITION,
        definition({
          physicalSheetId: "orders:system_state",
          tabName: "Orders_System",
          projection: "system_state",
          headers: SYSTEM_HEADERS,
        }),
      ],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 0,
    });

    const usersRow: FastAppendRow = {
      effectId: "fast-users",
      payloadHash: "payload-users",
      fields: {
        id: cell.string("u-fast"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      },
      physicalSheetId: SYSTEM_SHEET_ID,
      projection: "system_state",
      sheetName: "Users_System",
      registeredRange: "A:C",
      schemaVersion: 1,
    };
    const ordersRow: FastAppendRow = {
      effectId: "fast-orders",
      payloadHash: "payload-orders",
      fields: {
        id: { kind: "string" as const, value: "order-fast" },
        status: { kind: "string" as const, value: "pending" },
        __typed_sheets_deleted: { kind: "boolean" as const, value: false },
      },
      physicalSheetId: "orders:system_state",
      projection: "system_state",
      sheetName: "Orders_System",
      registeredRange: "A:C",
      schemaVersion: 1,
    };

    const result = await provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows: [usersRow, ordersRow],
    });
    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "applied"]);

    // ONE atomic batchUpdate whose requests target the different tabs' sheetIds.
    expect(transport.batchUpdateCalls).toBe(1);
    const batch = transport.appliedBatchUpdates[0];
    expect(batch).toBeDefined();
    if (batch === undefined) return;
    const usersTab = spreadsheet.findTab("Users_System");
    const ordersTab = spreadsheet.findTab("Orders_System");
    expect(usersTab).toBeDefined();
    expect(ordersTab).toBeDefined();
    if (usersTab === undefined || ordersTab === undefined) return;
    const sheetIds = new Set(batch.map((request) => request.sheetId));
    expect(sheetIds).toContain(usersTab.sheetId);
    expect(sheetIds).toContain(ordersTab.sheetId);
    expect(sheetIds.size).toBeGreaterThan(1);
    // Each row landed in its own tab.
    expect(stubRowFields(usersTab, 2, SYSTEM_HEADERS)).toMatchObject({
      id: { kind: "string", value: "u-fast" },
    });
    expect(stubRowFields(ordersTab, 2, SYSTEM_HEADERS)).toMatchObject({
      id: { kind: "string", value: "order-fast" },
    });
  });

  it("appends up to 1,000 rows per request and defers the suffix", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const rows = appendRows(1_001);
    const result = await provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows,
    });
    expect(result.results).toHaveLength(1_000);
    expect(result.hasMore).toBe(true);
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(systemTab.lastContentRow()).toBe(1_000);
    // Each appended row carries receipt-backed visible evidence (revision 1).
    expect(result.results[0]).toMatchObject({
      status: "applied",
      visibleRevision: 1,
    });
    expect(result.results[0]?.visibleHash).toBeTypeOf("string");
  });

  it("replays a receipted append without appending twice", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const rows = appendRows(2);
    const first = await provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows,
    });
    expect(first.hasMore).toBe(false);
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(systemTab.lastContentRow()).toBe(2);

    const second = await provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows,
    });
    expect(second.hasMore).toBe(false);
    expect(second.results.map((entry) => entry.status)).toEqual(["applied", "applied"]);
    expect(second.results[0]?.visibleHash).toBe(first.results[0]?.visibleHash);
    // No second mutation: the same rows exist and no new receipt rows landed.
    expect(systemTab.lastContentRow()).toBe(2);
    const receiptTab = spreadsheet.findTab("__typed_sheets_internal_effect_receipts");
    expect(receiptTab?.lastContentRow()).toBe(2);
  });

  it("fails closed on duplicate identities without appending", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const rows = appendRows(2);
    const duplicated = [rows[0], rows[1]].filter((row): row is FastAppendRow => row !== undefined);
    const rowA = rows[0];
    const rowB = rows[1];
    if (rowA === undefined || rowB === undefined) throw new Error("fixture rows missing");
    duplicated[1] = { ...rowB, fields: { ...rowB.fields, id: rowA.fields.id ?? null } };
    await expect(provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows: duplicated,
    })).rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("requires an identity field for the route before any preflight read", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedUserInputTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    await expect(provider.fastAppendRows({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: "A:C",
      projection: "user_input",
      schemaVersion: 1,
      rows: appendRows(1),
    })).rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD });
    // Fail-fast: an identity-less route is rejected before any enumeration or
    // ranged preflight read is burned, and before any mutation.
    expect(transport.getSpreadsheetRequests).toHaveLength(0);
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("rejects a multi-route request with an identity-less route before any preflight read", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    spreadsheet.addTab("Users_Input", { headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"] });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const systemRow: FastAppendRow = {
      effectId: "fast-system",
      payloadHash: "payload-system",
      fields: {
        id: cell.string("u-fast"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      },
      physicalSheetId: SYSTEM_SHEET_ID,
      projection: "system_state",
      sheetName: "Users_System",
      registeredRange: "A:C",
      schemaVersion: 1,
    };
    const inputRow: FastAppendRow = {
      effectId: "fast-input",
      payloadHash: "payload-input",
      fields: {
        id: cell.string("i-fast"),
        status: cell.string("pending"),
      },
      physicalSheetId: USER_INPUT_SHEET_ID,
      projection: "user_input",
      sheetName: "Users_Input",
      registeredRange: "A:C",
      schemaVersion: 1,
    };
    await expect(provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows: [systemRow, inputRow],
    })).rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD });
    // Fail-fast: the identity-less route is rejected before the shared
    // enumeration/ranged preflight read, and before any mutation.
    expect(transport.getSpreadsheetRequests).toHaveLength(0);
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("appends a single-route request whose row overrides point to another tab on the overridden tab", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    spreadsheet.addTab("Orders_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [
        SYSTEM_DEFINITION,
        definition({
          physicalSheetId: "orders:system_state",
          tabName: "Orders_System",
          projection: "system_state",
          headers: SYSTEM_HEADERS,
        }),
      ],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 0,
    });
    // The request-level route is the top-level Users_System tab, but the row
    // carries per-row route overrides pointing at Orders_System. The request
    // collapses to ONE effective route, so it must append to the overridden
    // tab, not the top-level one.
    const ordersRow: FastAppendRow = {
      effectId: "fast-orders",
      payloadHash: "payload-orders",
      fields: {
        id: cell.string("order-fast"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      },
      physicalSheetId: "orders:system_state",
      projection: "system_state",
      sheetName: "Orders_System",
      registeredRange: "A:C",
      schemaVersion: 1,
    };
    const result = await provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows: [ordersRow],
    });
    expect(result.results.map((entry) => entry.status)).toEqual(["applied"]);
    const ordersTab = spreadsheet.findTab("Orders_System");
    const systemTab = spreadsheet.findTab("Users_System");
    expect(ordersTab).toBeDefined();
    expect(systemTab).toBeDefined();
    if (ordersTab === undefined || systemTab === undefined) return;
    // The row landed in the overridden Orders_System tab, not Users_System.
    expect(stubRowFields(ordersTab, 2, SYSTEM_HEADERS)).toMatchObject({
      id: { kind: "string", value: "order-fast" },
    });
    expect(systemTab.lastContentRow()).toBe(0);
  });

  it("fails closed when an append row omits payloadHash", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const row = appendRows(1)[0];
    if (row === undefined) throw new Error("fixture row missing");
    const withoutPayloadHash: FastAppendRow = {
      effectId: row.effectId,
      fields: row.fields,
      ...(row.anchor === undefined ? {} : { anchor: row.anchor }),
    };
    await expect(provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows: [withoutPayloadHash],
    })).rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("fails closed when an append row field is not a normalized cell", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const row = appendRows(1)[0];
    if (row === undefined) throw new Error("fixture row missing");
    await expect(provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows: [{
        ...row,
        fields: { ...row.fields, status: "raw-string" as unknown as NormalizedCell },
      }],
    })).rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("fails closed when the identity field cell is not a string or number", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const row = appendRows(1)[0];
    if (row === undefined) throw new Error("fixture row missing");
    // The identity rule accepts non-empty strings and finite numbers only;
    // booleans must fail closed instead of being string-coerced.
    await expect(provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows: [{ ...row, fields: { ...row.fields, id: { kind: "boolean", value: true } } }],
    })).rejects.toMatchObject({ code: SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("defers a byte-budget append suffix and completes it on the next call", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport, {
      maxBatchBytes: 2_000,
      sleep: async () => undefined,
    });
    // Two oversized rows: the serialized pair (measured ~2.6 KB) exceeds the
    // budget while either row alone fits, so exactly the first row is sent.
    const rows: FastAppendRow[] = Array.from({ length: 2 }, (_, index) => {
      const identity = `budget-${String(index).padStart(4, "0")}`;
      return {
        effectId: `append-${identity}`,
        payloadHash: `payload-${identity}`,
        anchor: `anchor-${identity}`,
        fields: {
          id: { kind: "string", value: identity },
          status: { kind: "string", value: "p" + "x".repeat(300) },
          __typed_sheets_deleted: { kind: "boolean", value: false },
        },
      };
    });
    const first = await provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows,
    });
    const included = first.results.length;
    expect(first.hasMore).toBe(true);
    expect(included).toBeGreaterThan(0);
    expect(included).toBeLessThan(rows.length);
    // One atomic batch carrying exactly the included prefix rows + receipts.
    expect(transport.batchUpdateCalls).toBe(1);
    const batch = transport.appliedBatchUpdates[0];
    if (batch === undefined) throw new Error("expected one append batch");
    const targetSheetId = spreadsheet.findTab("Users_System")?.sheetId;
    const valuesWrite = batch.find((request) =>
      request.kind === "updateCells" && request.sheetId === targetSheetId &&
      request.startRowIndex === 1 && request.fields === "userEnteredValue");
    if (valuesWrite === undefined || valuesWrite.kind !== "updateCells") {
      throw new Error("expected one target values write");
    }
    expect(valuesWrite.rows).toHaveLength(included);
    const insert = batch.find((request) =>
      request.kind === "insertDimension" && request.sheetId === targetSheetId);
    if (insert === undefined || insert.kind !== "insertDimension") {
      throw new Error("expected one target insert");
    }
    expect(insert.endIndex - insert.startIndex).toBe(included);
    // The same single batch carries exactly the prefix's receipts.
    const receiptWrite = batch.find((request) =>
      request.kind === "updateCells" && request.sheetId !== targetSheetId &&
      request.startRowIndex === 1);
    if (receiptWrite === undefined || receiptWrite.kind !== "updateCells") {
      throw new Error("expected one receipt write");
    }
    expect(receiptWrite.rows).toHaveLength(included);
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(systemTab.lastContentRow()).toBe(included);

    // A fresh call replays the committed prefix from the receipt tab and
    // appends the deferred suffix in one batch (replay semantics).
    const second = await provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows,
    });
    expect(second.hasMore).toBe(false);
    expect(second.results).toHaveLength(rows.length);
    expect(systemTab.lastContentRow()).toBe(rows.length);
    const receiptTab = spreadsheet.findTab("__typed_sheets_internal_effect_receipts");
    expect(receiptTab?.lastContentRow()).toBe(rows.length);
  });
});

describe("GoogleSheetsApiSyncProvider byte budget", () => {
  it("sends only the order-preserving prefix and returns hasMore past the budget", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport, { maxBatchBytes: 3_000 });
    const updates = Array.from({ length: 10 }, (_, index) => {
      const identity = `u-${index}`;
      return effect({
        effectId: `update-${index}`,
        targetAnchor: `anchor-${index}`,
        createIfMissing: true,
        targetId: `entity:users:${identity}`,
        fields: {
          id: cell.string(identity),
          status: cell.string("pending-" + "x".repeat(400)),
          __typed_sheets_deleted: cell.bool(false),
        },
      });
    });
    const result = await applyRequest(provider, updates);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.length).toBeLessThan(10);
    expect(result.hasMore).toBe(true);
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(systemTab.lastContentRow()).toBe(result.results.length);
  });

  it("turns a single oversize effect into schema_error and keeps the rest", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport, { maxBatchBytes: 2_000 });
    const oversize = effect({
      effectId: "oversize-1",
      targetAnchor: "anchor-big",
      createIfMissing: true,
      fields: {
        id: cell.string("big"),
        status: cell.string("x".repeat(5_000)),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const small = effect({
      effectId: "small-1",
      targetAnchor: "anchor-small",
      createIfMissing: true,
      fields: {
        id: cell.string("small"),
        status: cell.string("ok"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const result = await applyRequest(provider, [oversize, small]);
    expect(result.results.map((entry) => entry.status)).toEqual(["schema_error", "applied"]);
    expect(result.results[0]?.reason).toEqual({
      kind: "present",
      value: "effect_payload_too_large",
    });
    expect(result.hasMore).toBe(false);
    // Only the small effect reached the sheet.
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(systemTab.lastContentRow()).toBe(1);
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS).id).toEqual(cell.string("small"));
  });

  it("skips an oversize effect in a multi-tab group and applies the following valid effects without row gaps", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    seedUserInputTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport, { maxBatchBytes: 6_000 });

    // One oversized effect FIRST in the system tab's group, followed by a
    // valid effect in the SAME group and a valid effect in another tab. The
    // prefix search must respect the start offset so the valid effects that
    // come after the oversized one are still included, and the included
    // effects must be re-planned against the tab so the skipped slot does
    // not leave a row gap.
    const oversize = effect({
      effectId: "multi-oversize",
      physicalSheetId: SYSTEM_SHEET_ID,
      projection: "system_state",
      targetAnchor: "anchor-big",
      createIfMissing: true,
      fields: {
        id: cell.string("big"),
        status: cell.string("x".repeat(20_000)),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const systemSmall = effect({
      effectId: "multi-system-small",
      physicalSheetId: SYSTEM_SHEET_ID,
      projection: "system_state",
      targetAnchor: "anchor-small",
      createIfMissing: true,
      fields: {
        id: cell.string("small"),
        status: cell.string("ok"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const inputSmall = effect({
      effectId: "multi-input-small",
      physicalSheetId: USER_INPUT_SHEET_ID,
      projection: "user_input",
      targetAnchor: "anchor-input",
      createIfMissing: true,
      fields: { id: cell.string("u-input"), status: cell.string("ok") },
    });

    const result = await applyRequest(provider, [oversize, systemSmall, inputSmall]);
    // Only the oversized effect is schema_error; the valid effects in the
    // SAME system tab group still apply after it.
    expect(result.results.map((entry) => entry.status)).toEqual(["schema_error", "applied", "applied"]);
    expect(result.results[0]?.reason).toEqual({
      kind: "present",
      value: "effect_payload_too_large",
    });
    expect(result.hasMore).toBe(false);

    // ONE atomic batch carried the two valid effects; the oversized one was
    // excluded, so its skipped slot must NOT leave a row gap in the tab.
    expect(transport.batchUpdateCalls).toBe(1);
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(systemTab.lastContentRow()).toBe(1);
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS).id).toEqual(cell.string("small"));
    const inputTab = spreadsheet.findTab("Users_Input");
    if (inputTab === undefined) throw new Error("input tab missing");
    expect(inputTab.lastContentRow()).toBe(1);
    expect(stubRowFields(inputTab, 2, USER_INPUT_HEADERS).id).toEqual(cell.string("u-input"));
  });

  it("measures the SDK-wrapped wire body, so wrapper overhead trims the batch", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const effects = Array.from({ length: 6 }, (_, index) => effect({
      effectId: `wire-${index}`,
      targetAnchor: `anchor-wire-${index}`,
      createIfMissing: true,
      fields: {
        id: cell.string(`u-wire-${index}`),
        status: cell.string("s" + "x".repeat(120)),
        __typed_sheets_deleted: cell.bool(false),
      },
    }));
    const full = await applyRequest(provider, effects);
    expect(full.hasMore).toBe(false);
    const batch = transport.appliedBatchUpdates[0];
    if (batch === undefined) throw new Error("expected a batch");
    const internalBytes = new TextEncoder().encode(JSON.stringify({ requests: batch })).byteLength;
    const wireBytes = new TextEncoder().encode(serializeBatchUpdateRequests(batch)).byteLength;
    // The SDK-wrapped body (addSheet/updateCells wrappers) is larger than the
    // internal request union serialization.
    expect(wireBytes).toBeGreaterThan(internalBytes);
    // A budget between the internal-union size and the wire size must trim:
    // the old internal measurement would have sent the whole batch.
    const budget = Math.floor((internalBytes + wireBytes) / 2);
    const spreadsheet2 = new StubSpreadsheet();
    spreadsheet2.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport2 = new StubSheetsTransport(spreadsheet2);
    const provider2 = buildProvider(transport2, { maxBatchBytes: budget });
    const trimmed = await applyRequest(provider2, effects);
    expect(trimmed.hasMore).toBe(true);
    expect(trimmed.results.length).toBeLessThan(effects.length);
    const trimmedBatch = transport2.appliedBatchUpdates[0];
    if (trimmedBatch === undefined) throw new Error("expected a trimmed batch");
    expect(new TextEncoder().encode(serializeBatchUpdateRequests(trimmedBatch)).byteLength)
      .toBeLessThanOrEqual(budget);
  });
});

describe("GoogleSheetsApiSyncProvider postcondition recovery", () => {
  it("classifies an applied effect from receipt evidence", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("written"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const targetHash = computeSyncVisibleHash({
      id: cell.string("u1"),
      status: cell.string("written"),
      __typed_sheets_deleted: cell.bool(false),
    });
    seedReceiptTab(spreadsheet, [{
      effectId: "effect-1",
      payloadHash: "payload-1",
      visibleHash: targetHash,
      visibleRevision: 2,
    }]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const probe = effect({
      effectId: "effect-1",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      fields: {
        id: cell.string("u1"),
        status: cell.string("written"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const postcondition = await provider.readEffectPostcondition(probe);
    expect(postcondition).toMatchObject({
      disposition: "applied",
      visibleRevision: { kind: "present", value: 2 },
      visibleHash: { kind: "present", value: targetHash },
    });
    expect(postcondition.snapshotHash).toEqual({ kind: "absent" });
  });

  it("never assumes a missing row closes a delete without its receipt", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedUserInputTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const probe = effect({
      effectId: "delete-1",
      effectKind: "user_input_delete",
      physicalSheetId: USER_INPUT_SHEET_ID,
      projection: "user_input",
      targetAnchor: "anchor-gone",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("x"),
      }),
      fields: { id: cell.string("u1"), status: cell.string("x") },
    });
    const postcondition = await provider.readEffectPostcondition(probe);
    expect(postcondition.disposition).toBe("unavailable");
  });

  it("classifies a deletion as applied only when its receipt is present", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedUserInputTab(spreadsheet, []);
    seedReceiptTab(spreadsheet, [{
      effectId: "delete-1",
      payloadHash: "payload-1",
      visibleHash: "delete-hash",
      visibleRevision: 1,
    }]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const probe = effect({
      effectId: "delete-1",
      effectKind: "user_input_delete",
      physicalSheetId: USER_INPUT_SHEET_ID,
      projection: "user_input",
      targetAnchor: "anchor-gone",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("x"),
      }),
      fields: { id: cell.string("u1"), status: cell.string("x") },
    });
    const postcondition = await provider.readEffectPostcondition(probe);
    expect(postcondition).toMatchObject({
      disposition: "applied",
      visibleRevision: { kind: "present", value: 1 },
      visibleHash: { kind: "present", value: "delete-hash" },
    });
  });

  it("treats a matching row without a receipt as unavailable", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("written"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const probe = effect({
      effectId: "effect-1",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      fields: {
        id: cell.string("u1"),
        status: cell.string("written"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const postcondition = await provider.readEffectPostcondition(probe);
    expect(postcondition).toMatchObject({
      disposition: "unavailable",
      reason: "receipt_missing",
    });
  });

  it("classifies unapplied and changed states from the visible hash", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("pending"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const baseline = computeSyncVisibleHash({
      id: cell.string("u1"),
      status: cell.string("pending"),
      __typed_sheets_deleted: cell.bool(false),
    });
    const unapplied = effect({
      effectId: "effect-unapplied",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: baseline,
      fields: {
        id: cell.string("u1"),
        status: cell.string("written"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const postcondition = await provider.readEffectPostcondition(unapplied);
    expect(postcondition).toMatchObject({
      disposition: "unapplied",
      visibleRevision: { kind: "present", value: 1 },
      visibleHash: { kind: "present", value: baseline },
    });

    const changed = effect({
      effectId: "effect-changed",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      // The row holds "pending" but the effect expected the stale "y" state,
      // so the current hash matches neither the expectation nor the target.
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("y"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      fields: {
        id: cell.string("u1"),
        status: cell.string("other"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const changedPostcondition = await provider.readEffectPostcondition(changed);
    expect(changedPostcondition.disposition).toBe("changed");
  });

  it("classifies a batch of postconditions with one shared read", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("pending"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const baseline = stubRowVisibleHash(spreadsheet.findTab("Users_System") as never, 2, SYSTEM_HEADERS);
    const first = effect({
      effectId: "batch-1",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: baseline,
      fields: {
        id: cell.string("u1"),
        status: cell.string("written"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const second = effect({
      effectId: "batch-2",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      // The row holds "pending", not the stale "y" the effect expected.
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("u1"),
        status: cell.string("y"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      fields: {
        id: cell.string("u1"),
        status: cell.string("other"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const readsBefore = transport.getSpreadsheetCalls;
    const results = await provider.readEffectPostconditions({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      effects: [first, second],
    });
    expect(results.map((entry) => entry.postcondition.disposition)).toEqual(["unapplied", "changed"]);
    // Each preflight performs an enumeration read plus one ranged data read
    // (no receipt tab exists in this fixture).
    expect(transport.getSpreadsheetCalls).toBe(readsBefore + 2);
  });
});

describe("GoogleSheetsApiSyncProvider transport classification and telemetry", () => {
  it("classifies malformed 2xx replies as delivery-uncertain", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    transport.fault = { kind: "malformedBatchUpdateReply" };
    const outcome = await applyRequest(provider, [
      effect({
        effectId: "malformed-1",
        targetAnchor: "anchor-1",
        createIfMissing: true,
        fields: { id: cell.string("u1"), status: cell.string("x") },
      }),
    ]).then(
      () => { throw new Error("expected the malformed reply to fail the apply"); },
      (error: unknown) => classifyTransportOutcome(error),
    );
    expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  it("classifies pre-mutation 4xx rejections as explicit remote failures", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    transport.fault = { kind: "http", status: 400, apiErrorStatus: "INVALID_ARGUMENT" };
    const outcome = await applyRequest(provider, [
      effect({
        effectId: "rejected-1",
        targetAnchor: "anchor-1",
        createIfMissing: true,
        fields: { id: cell.string("u1"), status: cell.string("x") },
      }),
    ]).then(
      () => { throw new Error("expected the rejection to fail the apply"); },
      (error: unknown) => classifyTransportOutcome(error),
    );
    expect(outcome.kind).toBe(TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE);
    expect(outcome.httpStatus).toEqual({ kind: "present", value: 400 });
  });

  it.each([
    { status: 429, apiErrorStatus: "RESOURCE_EXHAUSTED", kind: TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN },
    { status: 500, apiErrorStatus: "INTERNAL", kind: TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN },
    { status: 408, apiErrorStatus: "DEADLINE", kind: TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN },
    { status: 403, apiErrorStatus: "PERMISSION_DENIED", kind: TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE },
    { status: 404, apiErrorStatus: "NOT_FOUND", kind: TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE },
  ])("classifies HTTP $status as $kind", async ({ status, apiErrorStatus, kind }) => {
    const error = new GoogleSheetsApiTransportError(
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
      "stub",
      presentValue(status),
      presentValue(apiErrorStatus),
    );
    expect(classifyTransportOutcome(error).kind).toBe(kind);
  });

  it("classifies timeout and network errors as delivery-uncertain", () => {
    const timeout = new GoogleSheetsApiTransportError(
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.TIMEOUT,
      "stub timeout",
      absentValue(),
    );
    expect(classifyTransportOutcome(timeout).kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
    const network = new GoogleSheetsApiTransportError(
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR,
      "stub network",
      absentValue(),
      presentValue("ECONNRESET"),
    );
    expect(classifyTransportOutcome(network)).toMatchObject({
      kind: TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN,
      code: { kind: "present", value: "ECONNRESET" },
    });
    const invalid = new GoogleSheetsApiTransportError(
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.INVALID_RESPONSE,
      "stub malformed",
      absentValue(),
    );
    expect(classifyTransportOutcome(invalid).kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  it("maps gaxios-shaped failures in classifyGoogleSheetsApiError", () => {
    const http = classifyGoogleSheetsApiError({
      code: 400,
      response: { status: 400, data: { error: { status: "INVALID_ARGUMENT" } } },
    });
    expect(http).toMatchObject({
      status: { kind: "present", value: 400 },
      remoteCode: { kind: "present", value: "INVALID_ARGUMENT" },
    });
    expect(http.code).toBe(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR);
    const network = classifyGoogleSheetsApiError({ code: "ECONNRESET", message: "socket hang up" });
    expect(network.code).toBe(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
    const timeout = classifyGoogleSheetsApiError({ code: "ETIMEDOUT", message: "timeout of 60000ms exceeded" });
    expect(timeout.code).toBe(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.TIMEOUT);
  });

  it("classifies HTTP 408 as retryable exactly like the shared transport boundary", () => {
    // The shared classifier treats 408 as delivery-uncertain (the request
    // may have committed before the timeout); the transport's own telemetry
    // bucket must agree so log consumers never see a proven retryable
    // timeout as a non-retryable rejection.
    expect(isRetryableTransportStatus(408)).toBe(true);
    expect(isRetryableTransportStatus(429)).toBe(true);
    expect(isRetryableTransportStatus(500)).toBe(true);
    expect(isRetryableTransportStatus(503)).toBe(true);
    expect(isRetryableTransportStatus(undefined)).toBe(true);
    // Proven pre-mutation rejections are never retryable.
    expect(isRetryableTransportStatus(400)).toBe(false);
    expect(isRetryableTransportStatus(401)).toBe(false);
    expect(isRetryableTransportStatus(403)).toBe(false);
    expect(isRetryableTransportStatus(404)).toBe(false);
    // A 408 HTTP error still maps through the shared boundary as
    // delivery-uncertain, and the transport never re-drives the mutating
    // call itself (gaxios retry stays disabled; the durable worker owns
    // retries).
    const error = new GoogleSheetsApiTransportError(
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
      "stub 408",
      presentValue(408),
      presentValue("DEADLINE"),
    );
    expect(classifyTransportOutcome(error).kind).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
  });

  it("paces every request start — reads and writes — through ONE shared limiter", async () => {
    let now = 1_000_000;
    const started: number[] = [];
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    transport.now = () => now;
    const provider = buildProvider(transport, {
      rateLimitIntervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });
    const first = await applyRequest(provider, [
      effect({
        effectId: "limited-1",
        targetAnchor: "anchor-1",
        createIfMissing: true,
        fields: { id: cell.string("u1"), status: cell.string("x") },
      }),
    ]);
    expect(first.results[0]?.status).toBe("applied");
    const second = await applyRequest(provider, [
      effect({
        effectId: "limited-2",
        targetAnchor: "anchor-2",
        createIfMissing: true,
        fields: { id: cell.string("u2"), status: cell.string("x") },
      }),
    ]);
    expect(second.results[0]?.status).toBe("applied");
    // Reads AND writes share ONE limiter: every consecutive request start of
    // either class must be at least 1,100 ms after the previous start, so a
    // combined read+write burst can never outpace the interval.
    const starts = transport.requestStarts.map((entry) => entry.at);
    expect(starts.length).toBeGreaterThanOrEqual(4);
    for (let index = 1; index < starts.length; index += 1) {
      const gap = (starts[index] ?? 0) - (starts[index - 1] ?? 0);
      expect(gap).toBeGreaterThanOrEqual(1_100);
    }
    void started;
  });

  it("emits redacted request telemetry without payload or identity material", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const events: unknown[] = [];
    const provider = buildProvider(transport, {
      onRequest: (event) => events.push(event),
    });
    await applyRequest(provider, [
      effect({
        effectId: "telemetry-1",
        targetAnchor: "anchor-1",
        createIfMissing: true,
        fields: { id: cell.string("u1"), status: cell.string("secret-payload") },
      }),
    ]);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const record = event as Record<string, unknown>;
      expect(["getSpreadsheet", "batchUpdate"]).toContain(record.operation);
      expect(typeof record.operationCount).toBe("number");
      expect(typeof record.durationMs).toBe("number");
      expect(typeof record.ok).toBe("boolean");
      expect(record.startedAt).toBeTypeOf("number");
      // Redaction: never payloads, spreadsheet ids, anchors, or URLs.
      expect(JSON.stringify(event)).not.toContain("secret-payload");
      expect(JSON.stringify(event)).not.toContain("stub-spreadsheet");
      expect(JSON.stringify(event)).not.toContain("anchor-");
    }
    const writeEvent = events.find((event) =>
      (event as Record<string, unknown>).operation === "batchUpdate");
    expect(writeEvent).toBeDefined();
  });

  it("never forwards an arbitrary remote code into onRequest telemetry", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const events: unknown[] = [];
    const provider = buildProvider(transport, {
      onRequest: (event) => events.push(event),
    });
    // A hostile API error body echoes a secret-like string instead of a
    // canonical Google status name; it must collapse to the fixed safe
    // category before it can reach the telemetry sink.
    transport.fault = {
      kind: "http",
      status: 400,
      apiErrorStatus: "ya29.jwt-abcdefghijklmnop",
    };
    await applyRequest(provider, [
      effect({
        effectId: "hostile-telemetry-1",
        targetAnchor: "anchor-1",
        createIfMissing: true,
        fields: { id: cell.string("u1"), status: cell.string("x") },
      }),
    ]).then(
      () => { throw new Error("expected the hostile rejection to fail the apply"); },
      () => undefined,
    );
    const failureEvents = events.filter((event) =>
      (event as Record<string, unknown>).ok === false);
    expect(failureEvents.length).toBeGreaterThan(0);
    for (const event of failureEvents) {
      const record = event as Record<string, unknown>;
      // The raw hostile string never reaches the sink; the code is either
      // the fixed safe category or absent.
      expect(JSON.stringify(event)).not.toContain("ya29");
      expect(record.code).toEqual({ kind: "present", value: TRANSPORT_OUTCOME_UNKNOWN_CODE });
    }
  });
});

describe("GoogleSheetsApiSyncProvider inline postcondition mode", () => {
  it("writes target mutations first, verifies, then writes receipts", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [
      {
        anchor: "anchor-1",
        fields: {
          id: cell.string("u1"),
          status: cell.string("pending"),
          __typed_sheets_deleted: cell.bool(false),
        },
      },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const baseline = stubRowVisibleHash(spreadsheet.findTab("Users_System") as never, 2, SYSTEM_HEADERS);
    const update = effect({
      effectId: "inline-1",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: baseline,
      fields: {
        id: cell.string("u1"),
        status: cell.string("verified-write"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const result = await applyRequest(provider, [update], SYNC_POSTCONDITION_MODES.INLINE);
    expect(result.results[0]?.status).toBe("applied");
    expect(result.results[0]?.postcondition).toBe("verified");
    // Two writes: target batch first, receipt batch after verification.
    expect(transport.batchUpdateCalls).toBe(2);
    const firstBatch = transport.appliedBatchUpdates[0];
    const secondBatch = transport.appliedBatchUpdates[1];
    if (firstBatch === undefined || secondBatch === undefined) {
      throw new Error("expected two batches");
    }
    expect(firstBatch.some((request) => request.kind === "updateCells" &&
      request.startRowIndex === 1)).toBe(true);
    expect(secondBatch.every((request) => request.kind === "insertDimension" ||
      request.kind === "updateCells" || request.kind === "addSheet" ||
      request.kind === "updateSheetProperties")).toBe(true);
  });
});
