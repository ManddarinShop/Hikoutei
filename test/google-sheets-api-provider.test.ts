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

import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { presentValue, absentValue, notApplicableValue } from "@hikoutei/contracts/state/index.js";
import { computeSyncVisibleHash } from "@hikoutei/contracts/sheets/syncSheets.js";
import type {
  ApplySyncEffectsRequest,
  FastAppendRow,
  SyncProjectionEffect,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { SYNC_POSTCONDITION_MODES } from "@hikoutei/contracts/sheets/constants.js";
import { classifyTransportOutcome, TRANSPORT_OUTCOME_KINDS, TRANSPORT_OUTCOME_UNKNOWN_CODE } from "@hikoutei/contracts/sheets/transportOutcome.js";
import { GoogleSheetsApiSyncProvider, classifyGoogleSheetsApiError, isRetryableTransportStatus } from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import type {
  GoogleSheetsApiTransport,
  GoogleSheetsApiGetSpreadsheetRequest,
  GoogleSheetsApiBatchUpdateRequest,
  GoogleSheetsApiWriteRequest,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import { serializeBatchUpdateRequests } from "@hikoutei/sheets/sheets/providers/google-sheets-api/transport/googleSheetsApiTransport.js";
import { parseRawErrorRecord } from "@hikoutei/ikisaki";
import { GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS, GOOGLE_SHEETS_API_PREFLIGHT_FIELDS, GOOGLE_SHEETS_API_ENUMERATION_FIELDS } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/preflightFields.js";
import { GOOGLE_SHEETS_API_RECEIPT_HEADERS, GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME, GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT } from "@hikoutei/sheets/sheets/providers/google-sheets-api/constants.js";
import {
  patchPreflightContext,
  planPreflightVerification,
  resolveVerifyCell,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/preflightVerify.js";
import type { ParsedGridData, PreflightContext, PreflightRow } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/preflightContext.js";
import { dateSerialFromIso } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/valueNormalization.js";
import { createReadCalibration } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/readPlan.js";
import { GoogleSheetsApiTransportError, GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES } from "@hikoutei/sheets/sheets/providers/google-sheets-api/errors.js";
import { SYNC_SHEETS_ERROR_CODES } from "@hikoutei/contracts/sheets/errors.js";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import {
  StubSpreadsheet,
  StubSheetsTransport,
  stubRowFields,
  stubRowVisibleHash,
} from "./support/StubSheetsTransport.js";
import { SYSTEM_HEADERS } from "./support/googleSheetsFixtures.js";

const SPREADSHEET_ID = "stub-spreadsheet";
const SYSTEM_SHEET_ID = "entity:users:system_state";
const USER_INPUT_SHEET_ID = "entity:users:user_input";
const CONFLICT_SHEET_ID = "entity:users:sync_conflicts";

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
  transport: GoogleSheetsApiTransport,
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

/** Mirrors the enumerable fields carried by a real GaxiosError instance. */
class GaxiosLikeError extends Error {
  public constructor(
    message: string,
    fields: {
      readonly code?: string | number;
      readonly status?: number | string;
      readonly response?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "GaxiosError";
    Object.assign(this, fields);
  }
}

/**
 * Test-local transport wrapper that delays every read/write call so two
 * concurrent `applyPreparedEffects` stages genuinely interleave inside their
 * refresh+write work instead of running strictly back to back (a sequential
 * run would pass even without the receipt-init lock). It delegates the
 * provider transport contract to the inner stub and mirrors the stub's
 * write/read counters for assertions.
 */
class DelayingTransport implements GoogleSheetsApiTransport {
  public readonly appliedBatchUpdates: GoogleSheetsApiWriteRequest[][] = [];
  public readonly getSpreadsheetRequests: GoogleSheetsApiGetSpreadsheetRequest[] = [];
  public batchUpdateCalls = 0;
  public getSpreadsheetCalls = 0;

  public constructor(
    private readonly inner: StubSheetsTransport,
    private readonly options: { readonly delayMs: number },
  ) {}

  private async delay(): Promise<void> {
    if (this.options.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
    }
  }

  public async getSpreadsheet(request: GoogleSheetsApiGetSpreadsheetRequest): Promise<unknown> {
    await this.delay();
    const result = await this.inner.getSpreadsheet(request);
    this.getSpreadsheetRequests.push(request);
    this.getSpreadsheetCalls = this.inner.getSpreadsheetCalls;
    return result;
  }

  public async batchUpdate(request: GoogleSheetsApiBatchUpdateRequest): Promise<unknown> {
    await this.delay();
    const result = await this.inner.batchUpdate(request);
    this.batchUpdateCalls = this.inner.batchUpdateCalls;
    const last = this.inner.appliedBatchUpdates[this.inner.appliedBatchUpdates.length - 1];
    if (last !== undefined) this.appliedBatchUpdates.push(last);
    return result;
  }
}

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
    // gridProperties(rowCount) rides the mask: it is the unified read
    // engine's authoritative row bound (metadata-only, no grid cost).
    expect(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS).toBe(
      "sheets.properties(sheetId,title,hidden,gridProperties(rowCount))," +
      "sheets.data(startRow,startColumn," +
      "rowData.values(userEnteredValue,userEnteredFormat.numberFormat,effectiveFormat.numberFormat))",
    );
    expect(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS).not.toContain("sheets.data(sheetId");
    expect(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS).not.toContain("developerMetadata");
    // The enumeration mask is the minimal identity-only subset; it must never
    // request grid data paths.
    expect(GOOGLE_SHEETS_API_ENUMERATION_FIELDS).toBe(
      "sheets.properties(sheetId,title,hidden,gridProperties(rowCount))",
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

describe("GoogleSheetsApiSyncProvider split apply (preflight + applyPrepared)", () => {
  it("serializes shared receipt-tab creation across two stale prepared writes", async () => {
    // Two routes on the SAME spreadsheet, both preflighted when the shared
    // receipt tab was still absent. Both prepared states carry a stale
    // absent-receipt context. When their write+verify stages run concurrently
    // through the direct provider, the receipt-init lock must let the first
    // create the tab and force the second to refresh (seeing it present) and
    // append instead — never two duplicate `addSheet` requests.
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    seedUserInputTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    // Delay reads and writes so the two applyPrepared stages genuinely
    // interleave inside their refresh/plan work instead of running strictly
    // back to back (a sequential run would pass even without the lock).
    const interleaved = new DelayingTransport(transport, { delayMs: 2 });
    const provider = buildProvider(interleaved);

    const systemRequest: ApplySyncEffectsRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
      effects: [effect({
        effectId: "race-a",
        targetAnchor: "anchor-race-a",
        createIfMissing: true,
        fields: { id: cell.string("ra"), status: cell.string("pending") },
      })],
    };
    const userRequest: ApplySyncEffectsRequest = {
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: "A:C",
      projection: "user_input",
      schemaVersion: 1,
      postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
      effects: [effect({
        effectId: "race-b",
        physicalSheetId: USER_INPUT_SHEET_ID,
        projection: "user_input",
        targetAnchor: "anchor-race-b",
        createIfMissing: true,
        fields: { id: cell.string("rb"), status: cell.string("active") },
      })],
    };

    // Both preflights observe the receipt tab absent (stale).
    const preparedA = await provider.preflightApplyEffects(systemRequest);
    const preparedB = await provider.preflightApplyEffects(userRequest);
    expect(preparedA.kind).toBe("single");
    expect(preparedB.kind).toBe("single");

    // Fire both writes together so their refresh+write stages overlap.
    const [outcomeA, outcomeB] = await Promise.all([
      provider.applyPreparedEffects(preparedA),
      provider.applyPreparedEffects(preparedB),
    ]);

    expect(outcomeA.results.map((r) => r.status)).toEqual(["applied"]);
    expect(outcomeB.results.map((r) => r.status)).toEqual(["applied"]);
    // Exactly one addSheet across all writes (the first creates the tab; the
    // second appends to it).
    const addSheets = interleaved.appliedBatchUpdates.filter((batch) =>
      batch.some((request) => request.kind === "addSheet"));
    expect(addSheets).toHaveLength(1);
    // Exactly one receipt tab exists in the model.
    expect(spreadsheet.sheets.filter((sheet) =>
      sheet.title === GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)).toHaveLength(1);
    // Both target rows were written.
    const systemTab = spreadsheet.findTab("Users_System");
    const inputTab = spreadsheet.findTab("Users_Input");
    if (systemTab === undefined || inputTab === undefined) throw new Error("tabs missing");
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS)).toMatchObject({
      id: cell.string("ra"),
      status: cell.string("pending"),
    });
    expect(stubRowFields(inputTab, 2, USER_INPUT_HEADERS)).toMatchObject({
      id: cell.string("rb"),
      status: cell.string("active"),
    });
  });

  it("refreshes a stale absent-receipt preflight with ONE write-lane ranged read before appending", async () => {
    // Regression: the stale-receipt refresh used to run a range-less
    // enumeration AND a ranged data read on the write lane. With defaults that
    // made the complete fast-append/legacy stale branch (two preflight reads +
    // enumeration + data read + write + five bounded admission waits = 125 s)
    // outlive the 120 s default effect lease. The refresh must be exactly ONE
    // paced write-lane ranged read that both discovers the tab and reads its
    // receipts, so the counted three-reads/one-write/four-waits bound holds.
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const request: ApplySyncEffectsRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
      effects: [effect({
        effectId: "stale-refresh-1",
        targetAnchor: "anchor-stale-refresh",
        createIfMissing: true,
        fields: { id: cell.string("sr"), status: cell.string("pending") },
      })],
    };
    // The read-ahead preflight observes the receipt tab absent (stale).
    const prepared = await provider.preflightApplyEffects(request);
    expect(prepared.kind).toBe("single");
    // A concurrent write creates the receipt tab (with one receipt) between
    // the preflight and this write stage.
    seedReceiptTab(spreadsheet, [{
      effectId: "concurrent-1",
      payloadHash: "payload-concurrent-1",
      visibleHash: computeSyncVisibleHash({
        id: cell.string("c"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      visibleRevision: 1,
    }]);
    const readsAfterPreflight = transport.getSpreadsheetRequests.length;
    const result = await provider.applyPreparedEffects(prepared);

    expect(result.results.map((entry) => entry.status)).toEqual(["applied"]);
    // Exactly ONE write-stage read, ranged to the receipt tab by title; the
    // write lane ran NO range-less enumeration.
    const writeStageReads = transport.getSpreadsheetRequests.slice(readsAfterPreflight);
    expect(writeStageReads).toHaveLength(1);
    expect(writeStageReads[0]?.ranges).toEqual([
      `'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!A1:F1048576`,
    ]);
    expect(transport.batchUpdateCalls).toBe(1);
    // Exactly one receipt tab exists, and the refreshed receipt landed AFTER
    // the concurrent writer's receipt (a stale receiptLastRow would have
    // overwritten the header or the concurrent row instead).
    const receiptTab = spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
    if (receiptTab === undefined) throw new Error("receipt tab missing");
    expect(stubRowFields(receiptTab, 1, [...GOOGLE_SHEETS_API_RECEIPT_HEADERS]).effectId)
      .toEqual(cell.string("effectId"));
    expect(stubRowFields(receiptTab, 2, [...GOOGLE_SHEETS_API_RECEIPT_HEADERS]).effectId)
      .toEqual(cell.string("concurrent-1"));
    expect(stubRowFields(receiptTab, 3, [...GOOGLE_SHEETS_API_RECEIPT_HEADERS]).effectId)
      .toEqual(cell.string("stale-refresh-1"));
  });

  it("treats the API's missing-range rejection of the receipt refresh as still-absent", async () => {
    // The real API answers a range that names a missing tab with a proven
    // pre-mutation 400. The single ranged refresh read relies on that
    // rejection to prove the receipt tab is still absent, so the caller
    // creates it atomically; only that exact proven 400 is classified as
    // still-absent, and every other transport failure must propagate.
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const inner = new StubSheetsTransport(spreadsheet);
    const receiptRange = `'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!`;
    const rejecting: GoogleSheetsApiTransport = {
      getSpreadsheet: async (request) => {
        if (request.ranges.some((range) => range.startsWith(receiptRange.slice(0, receiptRange.indexOf("!"))))) {
          throw classifyGoogleSheetsApiError(new GaxiosLikeError("Unable to parse range", {
            status: 400,
            response: { status: 400, data: { error: { status: "INVALID_ARGUMENT" } } },
          }));
        }
        return inner.getSpreadsheet(request);
      },
      batchUpdate: (request) => inner.batchUpdate(request),
    };
    const provider = buildProvider(rejecting);
    const result = await applyRequest(provider, [effect({
      effectId: "first-write-1",
      targetAnchor: "anchor-first",
      createIfMissing: true,
      fields: { id: cell.string("u1"), status: cell.string("pending") },
    })]);
    expect(result.results.map((entry) => entry.status)).toEqual(["applied"]);
    expect(inner.batchUpdateCalls).toBe(1);
    expect(spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)).toBeDefined();

    // Any other transport failure (here a 5xx on the same read) keeps its own
    // delivery-uncertain classification instead of being read as still-absent.
    const faulting: GoogleSheetsApiTransport = {
      getSpreadsheet: async (request) => {
        if (request.ranges.some((range) => range.startsWith(receiptRange.slice(0, receiptRange.indexOf("!"))))) {
          throw new GoogleSheetsApiTransportError(
            GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
            "backend error",
            presentValue(500),
            presentValue("INTERNAL"),
          );
        }
        return inner.getSpreadsheet(request);
      },
      batchUpdate: (request) => inner.batchUpdate(request),
    };
    const faultProvider = buildProvider(faulting);
    await expect(applyRequest(faultProvider, [effect({
      effectId: "first-write-2",
      targetAnchor: "anchor-2",
      createIfMissing: true,
      fields: { id: cell.string("u2"), status: cell.string("pending") },
    })])).rejects.toMatchObject({ code: GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR });

    // A 400 with a DIFFERENT remote status is not proof the receipt tab is
    // absent: it must fail closed and propagate, never be read as still-absent.
    const wrongCode: GoogleSheetsApiTransport = {
      getSpreadsheet: async (request) => {
        if (request.ranges.some((range) => range.startsWith(receiptRange.slice(0, receiptRange.indexOf("!"))))) {
          throw new GoogleSheetsApiTransportError(
            GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
            "bad request",
            presentValue(400),
            presentValue("FAILED_PRECONDITION"),
          );
        }
        return inner.getSpreadsheet(request);
      },
      batchUpdate: (request) => inner.batchUpdate(request),
    };
    const wrongCodeProvider = buildProvider(wrongCode);
    await expect(applyRequest(wrongCodeProvider, [effect({
      effectId: "first-write-3",
      targetAnchor: "anchor-3",
      createIfMissing: true,
      fields: { id: cell.string("u3"), status: cell.string("pending") },
    })])).rejects.toMatchObject({ code: GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR });

    // A 400 with NO remote status is equally not proof of absence: fail closed.
    const noCode: GoogleSheetsApiTransport = {
      getSpreadsheet: async (request) => {
        if (request.ranges.some((range) => range.startsWith(receiptRange.slice(0, receiptRange.indexOf("!"))))) {
          throw new GoogleSheetsApiTransportError(
            GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
            "bad request",
            presentValue(400),
          );
        }
        return inner.getSpreadsheet(request);
      },
      batchUpdate: (request) => inner.batchUpdate(request),
    };
    const noCodeProvider = buildProvider(noCode);
    await expect(applyRequest(noCodeProvider, [effect({
      effectId: "first-write-4",
      targetAnchor: "anchor-4",
      createIfMissing: true,
      fields: { id: cell.string("u4"), status: cell.string("pending") },
    })])).rejects.toMatchObject({ code: GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR });
  });

  it("produces the same result and write as the single applyEffects wrapper", async () => {
    const effects = [
      effect({
        effectId: "split-1",
        targetAnchor: "anchor-split-1",
        createIfMissing: true,
        fields: { id: cell.string("s1"), status: cell.string("pending") },
      }),
      effect({
        effectId: "split-2",
        targetAnchor: "anchor-split-2",
        createIfMissing: true,
        fields: { id: cell.string("s2"), status: cell.string("active") },
      }),
    ];
    const request: ApplySyncEffectsRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
      effects,
    };

    // Wrapper path: applyEffects does preflight then applyPrepared internally.
    const wrapperSpreadsheet = new StubSpreadsheet();
    seedSystemTab(wrapperSpreadsheet, []);
    const wrapperTransport = new StubSheetsTransport(wrapperSpreadsheet);
    const wrapperProvider = buildProvider(wrapperTransport);
    const wrapped = await wrapperProvider.applyEffects(request);

    // Split path: preflight then applyPrepared across the same request.
    const splitSpreadsheet = new StubSpreadsheet();
    seedSystemTab(splitSpreadsheet, []);
    const splitTransport = new StubSheetsTransport(splitSpreadsheet);
    const splitProvider = buildProvider(splitTransport);
    const prepared = await splitProvider.preflightApplyEffects(request);
    expect(prepared.kind).toBe("single");
    const split = await splitProvider.applyPreparedEffects(prepared);

    expect(split.results).toEqual(wrapped.results);
    expect(split.hasMore).toBe(wrapped.hasMore);
    expect(splitTransport.batchUpdateCalls).toBe(wrapperTransport.batchUpdateCalls);
    const systemTab = splitSpreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS)).toMatchObject({
      id: cell.string("s1"),
      status: cell.string("pending"),
    });
    expect(stubRowFields(systemTab, 3, SYSTEM_HEADERS)).toMatchObject({
      id: cell.string("s2"),
      status: cell.string("active"),
    });
  });

  it("rejects a prepared state produced by a different provider instance before any write", async () => {
    const request: ApplySyncEffectsRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
      effects: [effect({
        effectId: "foreign-provider",
        targetAnchor: "anchor-foreign-provider",
        createIfMissing: true,
        fields: { id: cell.string("fp"), status: cell.string("pending") },
      })],
    };
    // Two provider instances over the SAME spreadsheet: a prepared state from
    // one instance must fail closed on the other (per-instance nonce) before
    // any remote write, even though the spreadsheetId matches.
    const spreadsheetA = new StubSpreadsheet();
    seedSystemTab(spreadsheetA, []);
    const providerA = buildProvider(new StubSheetsTransport(spreadsheetA));
    const spreadsheetB = new StubSpreadsheet();
    seedSystemTab(spreadsheetB, []);
    const providerB = buildProvider(new StubSheetsTransport(spreadsheetB));
    const prepared = await providerA.preflightApplyEffects(request);
    await expect(providerB.applyPreparedEffects(prepared)).rejects.toThrow(
      /different provider instance/,
    );
    expect(spreadsheetB.sheets.filter((sheet) =>
      sheet.title === GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)).toHaveLength(0);
  });

  it("rejects a prepared state applied twice (sequential reuse) with no second mutation", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const request: ApplySyncEffectsRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
      effects: [effect({
        effectId: "reuse-seq",
        targetAnchor: "anchor-reuse-seq",
        createIfMissing: true,
        fields: { id: cell.string("rs"), status: cell.string("pending") },
      })],
    };
    const prepared = await provider.preflightApplyEffects(request);
    const first = await provider.applyPreparedEffects(prepared);
    expect(first.results.map((r) => r.status)).toEqual(["applied"]);
    const callsAfterFirst = transport.batchUpdateCalls;
    // Reusing the same prepared state must fail closed before any write so a
    // stale plan cannot replay a duplicate append or delete the next row.
    await expect(provider.applyPreparedEffects(prepared)).rejects.toThrow(
      /was not produced by this provider/,
    );
    expect(transport.batchUpdateCalls).toBe(callsAfterFirst);
  });

  it("rejects concurrent reuse of one prepared state with no second mutation", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const request: ApplySyncEffectsRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
      effects: [effect({
        effectId: "reuse-conc",
        targetAnchor: "anchor-reuse-conc",
        createIfMissing: true,
        fields: { id: cell.string("rc"), status: cell.string("pending") },
      })],
    };
    const prepared = await provider.preflightApplyEffects(request);
    const [first, second] = await Promise.allSettled([
      provider.applyPreparedEffects(prepared),
      provider.applyPreparedEffects(prepared),
    ]);
    const fulfilled = first.status === "fulfilled" ? first : second;
    const rejected = first.status === "rejected" ? first : second;
    expect(fulfilled.status).toBe("fulfilled");
    expect(rejected.status).toBe("rejected");
    // Exactly one write ran; the rejected concurrent reuse performed no second
    // mutation.
    expect(transport.batchUpdateCalls).toBe(1);
  });

  it("appends receipts without loss when two stale same-spreadsheet writes race with the receipt tab PRESENT", async () => {
    // Cross-route read-ahead overlap invariant: two routes on the same
    // spreadsheet preflight while the shared receipt tab is present, then a
    // different-route write lands between their preflights and writes (the
    // exact read-ahead overlap window). Both writes planned receipt rows from
    // the SAME stale receiptLastRow. Receipt appends reserve rows with
    // insertDimension (shift, not overwrite), so both batches' receipts must
    // survive side by side — never overwritten or lost — and each write must
    // land only on its own tab (provisioning forbids two definitions on one
    // tab, so cross-route target rows are disjoint).
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    seedUserInputTab(spreadsheet, []);
    seedReceiptTab(spreadsheet, [{
      effectId: "seeded-1",
      payloadHash: "payload-seeded-1",
      visibleHash: computeSyncVisibleHash({
        id: cell.string("seed"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      visibleRevision: 1,
    }]);
    const interleaved = new DelayingTransport(new StubSheetsTransport(spreadsheet), { delayMs: 2 });
    const provider = buildProvider(interleaved);
    const systemRequest: ApplySyncEffectsRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
      effects: [effect({
        effectId: "race-present-a",
        targetAnchor: "anchor-race-present-a",
        createIfMissing: true,
        fields: { id: cell.string("pa"), status: cell.string("pending") },
      })],
    };
    const userRequest: ApplySyncEffectsRequest = {
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "Users_Input",
      registeredRange: "A:C",
      projection: "user_input",
      schemaVersion: 1,
      postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
      effects: [effect({
        effectId: "race-present-b",
        physicalSheetId: USER_INPUT_SHEET_ID,
        projection: "user_input",
        targetAnchor: "anchor-race-present-b",
        createIfMissing: true,
        fields: { id: cell.string("pb"), status: cell.string("active") },
      })],
    };
    const preparedA = await provider.preflightApplyEffects(systemRequest);
    const preparedB = await provider.preflightApplyEffects(userRequest);
    expect(preparedA.kind).toBe("single");
    expect(preparedB.kind).toBe("single");

    await Promise.all([
      provider.applyPreparedEffects(preparedA),
      provider.applyPreparedEffects(preparedB),
    ]);

    // No addSheet: the tab was present at both preflights.
    expect(interleaved.appliedBatchUpdates.filter((batch) =>
      batch.some((request) => request.kind === "addSheet"))).toHaveLength(0);
    // All three receipts (the seeded one plus both writes) are present exactly
    // once, even though both batches computed the same stale start row: the
    // second insertDimension shifted the first batch's receipt down instead of
    // overwriting it.
    const receiptTab = spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
    if (receiptTab === undefined) throw new Error("receipt tab missing");
    const receiptHeaders = [...GOOGLE_SHEETS_API_RECEIPT_HEADERS];
    const effectIdAt = (rowNumber: number): string => {
      const value: NormalizedCell | undefined =
        stubRowFields(receiptTab, rowNumber, receiptHeaders).effectId;
      return value?.kind === "string" ? value.value : "";
    };
    expect([effectIdAt(2), effectIdAt(3), effectIdAt(4)].sort())
      .toEqual(["race-present-a", "race-present-b", "seeded-1"]);
    // Each write landed on its OWN tab only.
    const systemTab = spreadsheet.findTab("Users_System");
    const inputTab = spreadsheet.findTab("Users_Input");
    if (systemTab === undefined || inputTab === undefined) throw new Error("tabs missing");
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS)).toMatchObject({
      id: cell.string("pa"),
      status: cell.string("pending"),
    });
    expect(stubRowFields(inputTab, 2, USER_INPUT_HEADERS)).toMatchObject({
      id: cell.string("pb"),
      status: cell.string("active"),
    });
  });

  it("preserves both appended rows when two same-route prepared appends run out of order", async () => {
    // Two prepared states for the SAME route (only reachable by a caller that
    // bypasses the worker's same-route sequencing and the coordinator lane).
    // Both plans reserve the same stale next-append row; the second batch's
    // insertDimension must shift the first batch's row down instead of
    // overwriting it, so neither business identity is lost or duplicated. This
    // shift-safety is what makes the same-route serialization invariant
    // (coordinator lane + worker sequencing) sufficient without a fresh
    // in-lane re-read per write.
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const requestA: ApplySyncEffectsRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
      effects: [effect({
        effectId: "same-route-a",
        targetAnchor: "anchor-same-route-a",
        createIfMissing: true,
        fields: { id: cell.string("sa1"), status: cell.string("pending") },
      })],
    };
    const requestB: ApplySyncEffectsRequest = {
      ...requestA,
      effects: [effect({
        effectId: "same-route-b",
        targetAnchor: "anchor-same-route-b",
        createIfMissing: true,
        fields: { id: cell.string("sa2"), status: cell.string("pending") },
      })],
    };
    const preparedA = await provider.preflightApplyEffects(requestA);
    const preparedB = await provider.preflightApplyEffects(requestB);
    await Promise.all([
      provider.applyPreparedEffects(preparedA),
      provider.applyPreparedEffects(preparedB),
    ]);
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    const idAt = (rowNumber: number): string => {
      const value: NormalizedCell | undefined = stubRowFields(systemTab, rowNumber, SYSTEM_HEADERS).id;
      return value?.kind === "string" ? value.value : "";
    };
    expect([idAt(2), idAt(3)].sort()).toEqual(["sa1", "sa2"]);
    // Both receipts were persisted (the receipt-init lock let the first write
    // create the tab and the second refresh to append).
    const receiptTab = spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
    if (receiptTab === undefined) throw new Error("receipt tab missing");
    const receiptHeaders = [...GOOGLE_SHEETS_API_RECEIPT_HEADERS];
    const receiptIdAt = (rowNumber: number): string => {
      const value: NormalizedCell | undefined =
        stubRowFields(receiptTab, rowNumber, receiptHeaders).effectId;
      return value?.kind === "string" ? value.value : "";
    };
    expect([receiptIdAt(2), receiptIdAt(3)].sort()).toEqual(["same-route-a", "same-route-b"]);
    expect(transport.batchUpdateCalls).toBe(2);
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

  it("serializes shared receipt-tab creation across two concurrent fast appends", async () => {
    // Two fast appends on the SAME spreadsheet, both preflighting the shared
    // receipt tab absent. When their target+receipt batches run concurrently
    // through the direct provider, the per-spreadsheet receipt-init lock must
    // let the first create the tab and force the second to refresh (seeing it
    // present) and append instead — never two duplicate `addSheet` requests
    // (the second would otherwise fail with a 400).
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    // Delay reads and writes so the two fast-append preflights both observe the
    // tab absent before either write creates it, making the race real instead of
    // a sequential run that would pass even without the lock.
    const interleaved = new DelayingTransport(transport, { delayMs: 2 });
    const provider = buildProvider(interleaved);

    const rowA: FastAppendRow = {
      effectId: "fast-race-a",
      payloadHash: "payload-race-a",
      fields: {
        id: cell.string("ra"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      },
    };
    const rowB: FastAppendRow = {
      effectId: "fast-race-b",
      payloadHash: "payload-race-b",
      fields: {
        id: cell.string("rb"),
        status: cell.string("active"),
        __typed_sheets_deleted: cell.bool(false),
      },
    };
    const request = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state" as const,
      schemaVersion: 1,
    };

    const [resultA, resultB] = await Promise.all([
      provider.fastAppendRows({ ...request, rows: [rowA] }),
      provider.fastAppendRows({ ...request, rows: [rowB] }),
    ]);

    expect(resultA.results.map((entry) => entry.status)).toEqual(["applied"]);
    expect(resultB.results.map((entry) => entry.status)).toEqual(["applied"]);
    // Exactly one addSheet across all appends (the first creates the tab; the
    // second appends to it), and never a swallowed duplicate-add 400.
    const addSheets = interleaved.appliedBatchUpdates.filter((batch) =>
      batch.some((req) => req.kind === "addSheet"));
    expect(addSheets).toHaveLength(1);
    // Exactly one receipt tab exists in the model.
    expect(spreadsheet.sheets.filter((sheet) =>
      sheet.title === GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)).toHaveLength(1);
    // Both rows landed in the target tab. The two concurrent appends race to
    // create the shared receipt tab, so either row may win the lane and land
    // first; assert both rows are present (order is not guaranteed).
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    const identities = [
      stubRowFields(systemTab, 2, SYSTEM_HEADERS).id,
      stubRowFields(systemTab, 3, SYSTEM_HEADERS).id,
    ];
    expect(identities.map((value) => value?.value).sort()).toEqual(["ra", "rb"].sort());
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
    const events: Array<Record<string, unknown>> = [];
    const provider = buildProvider(transport, {
      maxBatchBytes: 6_000,
      onRequest: (event) => events.push(event as Record<string, unknown>),
    });

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
    // Multi-route telemetry reports the ORIGINAL requested effect count (3)
    // while `includedEffects` stays the actual included prefix (2 valid
    // effects; the oversized one was excluded as a schema error).
    const writeEvent = events.find((event) => event.operation === "batchUpdate");
    expect(writeEvent).toBeDefined();
    expect(writeEvent?.requestedEffects).toBe(3);
    expect(writeEvent?.includedEffects).toBe(2);
    const systemTab = spreadsheet.findTab("Users_System");
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(systemTab.lastContentRow()).toBe(1);
    expect(stubRowFields(systemTab, 2, SYSTEM_HEADERS).id).toEqual(cell.string("small"));
    const inputTab = spreadsheet.findTab("Users_Input");
    if (inputTab === undefined) throw new Error("input tab missing");
    expect(inputTab.lastContentRow()).toBe(1);
    expect(stubRowFields(inputTab, 2, USER_INPUT_HEADERS).id).toEqual(cell.string("u-input"));
  });

  it("skips receipt refresh and write when every bounded effect is a schema error and the receipt tab is absent", async () => {
    // With NO included plan able to write (an oversized effect with a tight
    // batch budget yields an empty `included` set) and the receipt tab absent
    // at preflight, apply must NOT take the write-side receipt-init refresh or
    // its lock: there is no receipt-producing write to protect. It should
    // return the per-effect schema-error result with no refresh read and no
    // batch write.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: SYSTEM_HEADERS });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport, { maxBatchBytes: 2_000 });
    const oversized = effect({
      effectId: "all-oversize",
      targetAnchor: "anchor-big",
      createIfMissing: true,
      fields: {
        id: cell.string("big"),
        status: cell.string("x".repeat(5_000)),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const readsBefore = transport.getSpreadsheetCalls;
    const result = await applyRequest(provider, [oversized]);
    expect(result.results.map((entry) => entry.status)).toEqual(["schema_error"]);
    expect(result.results[0]?.reason).toEqual({
      kind: "present",
      value: "effect_payload_too_large",
    });
    expect(result.hasMore).toBe(false);
    // Only the two preflight reads (enumeration + ranged data) ran; the
    // write-side receipt-init refresh/lock was skipped entirely, and no batch
    // write was sent.
    expect(transport.getSpreadsheetCalls).toBe(readsBefore + 2);
    expect(transport.batchUpdateCalls).toBe(0);
    // The receipt tab was never created by a write-side refresh/init.
    expect(spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)).toBeUndefined();
  });

  it("skips the receipt refresh for a guard-mismatch no-op batch when the receipt tab is absent", async () => {
    // A guard-mismatch/repair-reobserve plan set is a deterministic no-op: no
    // mutation and no receipt. The receipt-init refresh (whose write-lane
    // admission can be REFUSED under saturation) must not run for it, so the
    // refusal cannot turn the no-op into a delivery-uncertain requeue.
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [{
      anchor: "anchor-1",
      fields: {
        id: cell.string("u1"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      },
    }]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const stale = effect({
      effectId: "stale-noop-1",
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
    const readsBefore = transport.getSpreadsheetCalls;
    const result = await applyRequest(provider, [stale]);
    expect(result.results.map((entry) => entry.status)).toEqual(["guard_mismatch"]);
    expect(result.results[0]?.reason).toEqual({
      kind: "present",
      value: "visible_guard_mismatch",
    });
    // Only the two preflight reads ran; no write-lane refresh read and no
    // batch write, and the receipt tab was never created.
    expect(transport.getSpreadsheetCalls).toBe(readsBefore + 2);
    expect(transport.batchUpdateCalls).toBe(0);
    expect(spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)).toBeUndefined();
  });

  it("skips the multi-route receipt refresh when every included plan is a deterministic no-op", async () => {
    // Same guard on the combined multi-tab path: two routes whose plans are
    // all guard mismatches carry no mutation and no receipt, so the write
    // stage must not take the receipt-init refresh/lock at all.
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [{
      anchor: "anchor-sys",
      fields: {
        id: cell.string("s1"),
        status: cell.string("pending"),
        __typed_sheets_deleted: cell.bool(false),
      },
    }]);
    seedUserInputTab(spreadsheet, [{
      anchor: "anchor-input",
      fields: { id: cell.string("i1"), status: cell.string("pending") },
    }]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const staleSystem = effect({
      effectId: "stale-multi-sys",
      targetAnchor: "anchor-sys",
      targetId: "entity:users:s1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("s1"),
        status: cell.string("other"),
        __typed_sheets_deleted: cell.bool(false),
      }),
      fields: {
        id: cell.string("s1"),
        status: cell.string("new-sys"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const staleInput = effect({
      effectId: "stale-multi-input",
      projection: "user_input",
      physicalSheetId: USER_INPUT_SHEET_ID,
      targetAnchor: "anchor-input",
      targetId: "entity:users:i1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash({
        id: cell.string("i1"),
        status: cell.string("other"),
      }),
      fields: { id: cell.string("i1"), status: cell.string("new-input") },
    });
    const readsBefore = transport.getSpreadsheetCalls;
    const result = await applyRequest(provider, [staleSystem, staleInput]);
    expect([...result.results].sort((a, b) => a.effectId.localeCompare(b.effectId))
      .map((entry) => entry.status)).toEqual(["guard_mismatch", "guard_mismatch"]);
    // ONE shared preflight enumeration + ONE shared ranged read across both
    // routes; no write-lane refresh read and no batch write.
    expect(transport.getSpreadsheetCalls).toBe(readsBefore + 2);
    expect(transport.batchUpdateCalls).toBe(0);
    expect(spreadsheet.findTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)).toBeUndefined();
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

  // --- Scoped postcondition-probe reads (band scoping of the recovery read) ---

  /** Seed one landed write: target row + matching receipt. */
  function seedLandedWrite(spreadsheet: StubSpreadsheet): string {
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
    return targetHash;
  }

  function landedProbe(): SyncProjectionEffect {
    return effect({
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
  }

  it("settles a landed batch as applied from scoped band reads (cold cursor)", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedLandedWrite(spreadsheet);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const postcondition = await provider.readEffectPostcondition(landedProbe());
    expect(postcondition.disposition).toBe("applied");
    // Even the cold-cursor probe never issues the whole-tab full-evidence
    // target range: the receipt tab's full read rides the same scoped request.
    for (const request of transport.getSpreadsheetRequests) {
      expect(request.ranges).not.toContain("'Users_System'!A1:C1048576");
    }
  });

  it("settles a receipt-landed but pre-write row as unapplied (redrive)", async () => {
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
    // Receipt IS landed here (partial remote state, not the missing-receipt
    // case): the batch reached the sheet but the row still holds the
    // pre-write expected state, so the probe must answer `unapplied` and the
    // worker redrives, decided from the located row's band.
    seedReceiptTab(spreadsheet, [{
      effectId: "effect-redrive",
      payloadHash: "payload-redrive",
      visibleHash: "whatever",
      visibleRevision: 2,
    }]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const baseline = stubRowVisibleHash(spreadsheet.findTab("Users_System") as never, 2, SYSTEM_HEADERS);
    const probe = effect({
      effectId: "effect-redrive",
      payloadHash: "payload-redrive",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: baseline,
      fields: {
        id: cell.string("u1"),
        status: cell.string("queued"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const postcondition = await provider.readEffectPostcondition(probe);
    expect(postcondition.disposition).toBe("unapplied");
  });

  it("decides a missing receipt from bands alone under a live cursor even when a full read times out", async () => {
    // The drain-blocking defect this guards: a genuinely not-landed effect
    // under a warm cursor used to route through the historical whole-table
    // + FULL-receipt fallback. That fallback does not reset the cursor, and
    // at scale the whole-table read is what times out, so every redrive
    // probe repeated the timeout and the delivery-uncertain head blocked
    // forever. A live cursor after the base read proves COMPLETE memo
    // coverage (append-only tab + sentinel-trusted band or an in-read full
    // settle), so the miss is provable and must classify `unapplied` from
    // the scoped bands. The wrapper transport below fails any whole-tab
    // full-evidence or full-receipt read with a timeout: if the probe ever
    // regresses to the fallback, this test throws instead of settling.
    const spreadsheet = new StubSpreadsheet();
    seedLandedWrite(spreadsheet);
    const stub = new StubSheetsTransport(spreadsheet);
    let failFullReads = false;
    const timingOutTransport: GoogleSheetsApiTransport = {
      getSpreadsheet: async (request) => {
        if (failFullReads && request.ranges.some((range) =>
          range === "'Users_System'!A1:C1048576" ||
          range.endsWith("__typed_sheets_internal_effect_receipts'!A1:F1048576"))) {
          throw new GoogleSheetsApiTransportError(
            GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.TIMEOUT,
            "stub full-read timeout",
            absentValue(),
          );
        }
        return stub.getSpreadsheet(request);
      },
      batchUpdate: (request) => stub.batchUpdate(request),
    };
    const provider = buildProvider(timingOutTransport);
    // Cold probe advances the receipt cursor to the tab's parsed tail.
    await provider.readEffectPostcondition(landedProbe());
    failFullReads = true;
    // A never-dispatched effect: its receipt exists nowhere, and the target
    // row still holds the pre-write state the effect expected.
    const baseline = stubRowVisibleHash(spreadsheet.findTab("Users_System") as never, 2, SYSTEM_HEADERS);
    const missing = effect({
      effectId: "effect-2",
      payloadHash: "payload-2",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: baseline,
      fields: {
        id: cell.string("u1"),
        status: cell.string("queued"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const postcondition = await provider.readEffectPostcondition(missing);
    expect(postcondition.disposition).toBe("unapplied");
  });

  it("decides a missing receipt from a cold cursor's full receipt coverage", async () => {
    // Cursor-invalid (fresh process) counterpart: the base read itself is
    // the historical FULL receipt read, so the miss is proven by complete
    // coverage, not by a band. The full receipt range must appear, and no
    // separate whole-tab target fallback read may follow.
    const spreadsheet = new StubSpreadsheet();
    seedLandedWrite(spreadsheet);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const baseline = stubRowVisibleHash(spreadsheet.findTab("Users_System") as never, 2, SYSTEM_HEADERS);
    const missing = effect({
      effectId: "effect-2",
      payloadHash: "payload-2",
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: baseline,
      fields: {
        id: cell.string("u1"),
        status: cell.string("queued"),
        __typed_sheets_deleted: cell.bool(false),
      },
    });
    const postcondition = await provider.readEffectPostcondition(missing);
    expect(postcondition.disposition).toBe("unapplied");
    // Enumeration, scoped base read (carrying the FULL receipt range), and
    // the located row's verification band — nothing after.
    expect(transport.getSpreadsheetRequests).toHaveLength(3);
    const base = transport.getSpreadsheetRequests[1]!;
    expect(base.ranges.some((range) =>
      range.includes("__typed_sheets_internal_effect_receipts'!A1:F1048576"))).toBe(true);
    for (const request of transport.getSpreadsheetRequests) {
      expect(request.ranges).not.toContain("'Users_System'!A1:C1048576");
    }
  });

  it("carries responseBytes telemetry on the scoped probe verification read", async () => {
    // The verification pass runs its OWN paced getSpreadsheet with a raw
    // meta carrier; the event must measure the RAW document like every
    // other preflight read, or write-lane payload evidence silently vanishes
    // exactly when probes go scoped.
    const spreadsheet = new StubSpreadsheet();
    seedLandedWrite(spreadsheet);
    const transport = new StubSheetsTransport(spreadsheet);
    const events: Array<Record<string, unknown>> = [];
    const provider = buildProvider(transport, {
      onRequest: (event) => events.push(event as Record<string, unknown>),
    });
    await provider.readEffectPostcondition(landedProbe());
    const readEvents = events.filter((event) => event.operation === "getSpreadsheet");
    // Enumeration, scoped base read, and the row-band verification read.
    expect(readEvents).toHaveLength(3);
    for (const read of readEvents) {
      expect(typeof read.responseBytes).toBe("number");
      expect(read.responseBytes as number).toBeGreaterThan(0);
    }
  });

  it("requests key-column and row BANDS (never whole-tab ranges) once the receipt cursor is live", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedLandedWrite(spreadsheet);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    // Cold probe: advances the cursor to the receipt tab's parsed tail.
    await provider.readEffectPostcondition(landedProbe());
    const requestsBefore = transport.getSpreadsheetRequests.length;
    const postcondition = await provider.readEffectPostcondition(landedProbe());
    expect(postcondition.disposition).toBe("applied");
    const probeRequests = transport.getSpreadsheetRequests.slice(requestsBefore);
    // Enumeration, scoped base read, and the row-band verification read.
    expect(probeRequests).toHaveLength(3);
    expect(probeRequests[0]!.ranges).toEqual([]);
    const base = probeRequests[1]!;
    // Header row + tab-wide identity column band replace the whole-tab range,
    // and the receipt tab is read as the tail band from the cursor row.
    expect(base.fields).toBe(GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS);
    expect(base.ranges).toContain("'Users_System'!A1:C1");
    expect(base.ranges).toContain("'Users_System'!A2:A1048576");
    expect(base.ranges.some((range) => range.includes("__typed_sheets_internal_effect_receipts'!A2:F1048576")))
      .toBe(true);
    for (const request of probeRequests) {
      expect(request.ranges).not.toContain("'Users_System'!A1:C1048576");
    }
    // The landed row's full-field, format-evidenced band comes from its own
    // atomic request (values + both number-format sources in one snapshot).
    const band = probeRequests[2]!;
    expect(band.fields).toBe(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS);
    expect(band.ranges).toContain("'Users_System'!A2:C2");
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

  it("maps plain and class-like gaxios failures without weakening the raw boundary", () => {
    // Keep the existing plain shaped fixture contract intact.
    const plain = classifyGoogleSheetsApiError({
      code: 400,
      response: { status: 400, data: { error: { status: "INVALID_ARGUMENT" } } },
    });
    expect(plain).toMatchObject({
      status: { kind: "present", value: 400 },
      remoteCode: { kind: "present", value: "INVALID_ARGUMENT" },
    });
    expect(plain.code).toBe(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR);

    // Real GaxiosError instances expose status at the top level; their
    // response status and nested API status must remain available too.
    const topLevelHttp = classifyGoogleSheetsApiError(new GaxiosLikeError("bad request", {
      status: 400,
      response: { data: { error: { status: "INVALID_ARGUMENT" } } },
    }));
    expect(topLevelHttp).toMatchObject({
      code: GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
      status: { kind: "present", value: 400 },
      remoteCode: { kind: "present", value: "INVALID_ARGUMENT" },
    });

    // Also preserve the nested response.status form when no top-level status
    // is present.
    const nestedHttp = classifyGoogleSheetsApiError(new GaxiosLikeError("not found", {
      response: { status: 404, data: { error: { status: "NOT_FOUND" } } },
    }));
    expect(nestedHttp).toMatchObject({
      code: GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
      status: { kind: "present", value: 404 },
      remoteCode: { kind: "present", value: "NOT_FOUND" },
    });

    expect(parseRawErrorRecord(new GaxiosLikeError("class instance"))).toBeDefined();
    expect(parseRawErrorRecord(null)).toBeUndefined();
    expect(parseRawErrorRecord([])).toBeUndefined();
    expect(parseRawErrorRecord("not an object")).toBeUndefined();

    const network = classifyGoogleSheetsApiError(new GaxiosLikeError("socket hang up", {
      code: "ECONNRESET",
    }));
    expect(network.code).toBe(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
    const timeout = classifyGoogleSheetsApiError(new GaxiosLikeError("timeout of 60000ms exceeded", {
      code: "ETIMEDOUT",
    }));
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

  it("paces reads against reads and writes against writes through independent limiters", async () => {
    let now = 1_000_000;
    const events: Array<{ readonly pacing: "preflight" | "write"; readonly at: number }> = [];
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
      onRequest: (event) => {
        const record = event as { readonly pacing: "preflight" | "write"; readonly startedAt: number };
        events.push({ pacing: record.pacing, at: record.startedAt });
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
    // Reads and writes each pace on their OWN lane. The preflight-paced calls are
    // the two preflight reads per apply (the receipt-refresh reads after a
    // stale preflight are part of the write/initialization critical section and
    // pace on the WRITE lane, so they must NOT be counted as read-lane reads).
    // Preflight-lane starts stay >=1,100 ms apart among themselves, write-lane
    // starts (receipt refresh + batchUpdate) stay >=1,100 ms apart among
    // themselves, and a write-lane call runs beside its run's last
    // preflight-lane call, so cross-lane boundaries are allowed closer than
    // one interval.
    const readStarts = events
      .filter((entry) => entry.pacing === "preflight")
      .map((entry) => entry.at);
    const writeStarts = events
      .filter((entry) => entry.pacing === "write")
      .map((entry) => entry.at);
    // Two preflight reads per apply (2 applies); the receipt-refresh read is
    // write-paced so it is excluded from the read lane.
    expect(readStarts.length).toBe(4);
    // One receipt-refresh read (apply 1, receipt absent) plus two batchUpdates.
    // Apply 2's preflight observes the receipt tab created by apply 1, so it
    // skips the refresh read and only writes.
    expect(writeStarts.length).toBe(3);
    for (let index = 1; index < readStarts.length; index += 1) {
      expect((readStarts[index] ?? 0) - (readStarts[index - 1] ?? 0)).toBeGreaterThanOrEqual(1_100);
    }
    for (let index = 1; index < writeStarts.length; index += 1) {
      expect((writeStarts[index] ?? 0) - (writeStarts[index - 1] ?? 0)).toBeGreaterThanOrEqual(1_100);
    }
    // The first write-lane call (the receipt refresh) runs on its own limiter
    // beside the read lane's last preflight read: it must NOT wait out the read
    // interval, proving the lanes are independent.
    expect((writeStarts[0] ?? 0) - (readStarts[1] ?? 0)).toBeLessThan(1_100);
  });

  it("reports the limiter's own pacing wait on read and write request events", async () => {
    let now = 1_000_000;
    const events: Array<{
      readonly operation: string;
      readonly pacing: string;
      readonly pacingWaitMs: number;
    }> = [];
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
      onRequest: (event) => {
        const record = event as {
          readonly operation: string;
          readonly pacing: string;
          readonly pacingWaitMs: number;
        };
        events.push({
          operation: record.operation,
          pacing: record.pacing,
          pacingWaitMs: record.pacingWaitMs,
        });
      },
    });
    await applyRequest(provider, [
      effect({
        effectId: "wait-1",
        targetAnchor: "anchor-1",
        createIfMissing: true,
        fields: { id: cell.string("u1"), status: cell.string("x") },
      }),
    ]);
    await applyRequest(provider, [
      effect({
        effectId: "wait-2",
        targetAnchor: "anchor-2",
        createIfMissing: true,
        fields: { id: cell.string("u2"), status: cell.string("x") },
      }),
    ]);
    // Every read request event carries a redacted pacing wait (0 when the
    // slot was already available), not just write events.
    const readEvents = events.filter((entry) => entry.operation === "getSpreadsheet");
    expect(readEvents.length).toBeGreaterThan(0);
    for (const read of readEvents) {
      expect(typeof read.pacingWaitMs).toBe("number");
      expect(read.pacingWaitMs).toBeGreaterThanOrEqual(0);
    }
    // The second apply's batchUpdate waits out the write-lane interval since
    // the first apply's receipt refresh; its pacingWaitMs is the limiter's own
    // measured wait (the interval), not a clock delta.
    const writeEvents = events.filter((entry) => entry.operation === "batchUpdate");
    expect(writeEvents.length).toBeGreaterThan(0);
    const waitedWrite = writeEvents.find((entry) => entry.pacingWaitMs > 0);
    expect(waitedWrite).toBeDefined();
    expect(waitedWrite?.pacingWaitMs).toBe(1_100);
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
    // The write event carries the redacted batch diagnostics: request count,
    // body-size estimate, requested/included effect counts, and pacing wait.
    const write = writeEvent as Record<string, unknown>;
    expect(typeof write.requestCount).toBe("number");
    expect(typeof write.bodyBytes).toBe("number");
    expect(typeof write.requestedEffects).toBe("number");
    expect(typeof write.includedEffects).toBe("number");
    expect(typeof write.pacingWaitMs).toBe("number");
  });

  it("estimates getSpreadsheet response bytes scaled with the payload size", async () => {
    // The preflight-vs-polling latency investigation needs payload evidence:
    // every successful getSpreadsheet event must carry a responseBytes
    // estimate, and a data read of a big tab must dwarf the metadata-only
    // enumeration read of the same spreadsheet.
    const spreadsheet = new StubSpreadsheet();
    const padding = "x".repeat(200);
    seedSystemTab(spreadsheet, Array.from({ length: 100 }, (_, index) => ({
      anchor: `anchor-${index}`,
      fields: {
        id: cell.string(`u${index}`),
        status: cell.string(padding),
        __typed_sheets_deleted: cell.string(""),
      },
    })));
    const transport = new StubSheetsTransport(spreadsheet);
    const events: Array<Record<string, unknown>> = [];
    const provider = buildProvider(transport, {
      onRequest: (event) => events.push(event as Record<string, unknown>),
    });
    await applyRequest(provider, [
      effect({
        effectId: "bytes-1",
        targetAnchor: "anchor-new",
        createIfMissing: true,
        fields: { id: cell.string("u-new"), status: cell.string("pending") },
      }),
    ]);
    const readEvents = events.filter((event) => event.operation === "getSpreadsheet");
    expect(readEvents.length).toBeGreaterThanOrEqual(2);
    for (const read of readEvents) {
      expect(typeof read.responseBytes).toBe("number");
      expect(read.responseBytes as number).toBeGreaterThan(0);
    }
    const byteSizes = readEvents.map((read) => read.responseBytes as number);
    // The ranged data read carries the 100 seeded 200-char rows; the
    // metadata-only enumeration carries none. The payload signal must be
    // visible in the estimate.
    expect(Math.max(...byteSizes)).toBeGreaterThan(10 * Math.min(...byteSizes));
    // The write reply is small but still measured.
    const write = events.find((event) => event.operation === "batchUpdate");
    expect(typeof write?.responseBytes).toBe("number");
  });

  it("computes no responseBytes when no telemetry sink is attached", async () => {
    // Zero-overhead gate: without onRequest the provider must not serialize
    // responses. The event simply never exists, so the assertion is that a
    // big read still succeeds unchanged with no sink wired.
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, []);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const result = await applyRequest(provider, [
      effect({
        effectId: "bytes-nosink",
        targetAnchor: "anchor-1",
        createIfMissing: true,
        fields: { id: cell.string("u1"), status: cell.string("x") },
      }),
    ]);
    expect(result.results[0]?.status).toBe("applied");
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

describe("preflight payload reduction: cursor-banded receipts + scoped fast-append verification", () => {
  const CANONICAL_DATE_FORMAT = GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT;

  it("(a) matches a date-cell CAS guard through the single full-evidence read", async () => {
    const spreadsheet = new StubSpreadsheet();
    const fields = {
      id: cell.string("u1"),
      status: cell.date("2024-06-01T00:00:00.000Z"),
      __typed_sheets_deleted: cell.bool(false),
    };
    seedSystemTab(spreadsheet, [{ anchor: "anchor-1", fields }]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const result = await applyRequest(provider, [effect({
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash(fields),
      fields: { ...fields, status: cell.date("2024-06-02T00:00:00.000Z") },
    })]);
    // The apply path keeps its committed request budget: the date-cell guard
    // matches through the ONE whole-table read that carries BOTH number-format
    // sources (the only steady-state reduction there is the receipt tab
    // riding the tail-band cursor inside the same request).
    expect(result.results[0]?.status).toBe("applied");
    const fullMaskData = transport.getSpreadsheetRequests.filter(
      (request) => request.fields === GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
    );
    expect(fullMaskData).toHaveLength(1);
    expect(fullMaskData[0]?.ranges).toContain("'Users_System'!A1:C1048576");
  });

  it("(a) still detects a human edit to a date cell through the same snapshot", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedSystemTab(spreadsheet, [{
      anchor: "anchor-1",
      fields: {
        id: cell.string("u1"),
        // The human moved the date to June 1 after the plan-time baseline.
        status: cell.date("2024-06-01T00:00:00.000Z"),
        __typed_sheets_deleted: cell.bool(false),
      },
    }]);
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const stale = {
      id: cell.string("u1"),
      status: cell.date("2024-05-01T00:00:00.000Z"),
      __typed_sheets_deleted: cell.bool(false),
    };
    const result = await applyRequest(provider, [effect({
      targetAnchor: "anchor-1",
      targetId: "entity:users:u1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash(stale),
      fields: { ...stale, status: cell.date("2024-07-01T00:00:00.000Z") },
    })]);
    expect(result.results[0]?.status).toBe("guard_mismatch");
    expect(result.results[0]?.reason).toEqual({
      kind: "present",
      value: "visible_guard_mismatch",
    });
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("(b) a human date-format on a numeric identity cannot evade identity dedupe", async () => {
    // Row 3 is a human-added copy of row 2's numeric identity 45100 with the
    // canonical DATE pattern applied to the identity cell. The full-evidence
    // read keys the formatted row by its ISO identity (no false duplicate;
    // row 2 stays targeted) — exactly the historical behavior.
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", {
      headers: [...SYSTEM_HEADERS],
      rows: [
        [45100, "pending", false],
        [45100, "human-copy", false],
      ],
    });
    tab.cells.set("2,0", {
      userEnteredValue: { numberValue: 45100 },
      userEnteredFormat: { numberFormat: CANONICAL_DATE_FORMAT },
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const current = {
      id: cell.number(45100),
      status: cell.string("pending"),
      __typed_sheets_deleted: cell.bool(false),
    };
    const result = await applyRequest(provider, [effect({
      targetAnchor: "45100",
      targetId: "entity:users:45100",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash(current),
      fields: { ...current, status: cell.string("written") },
    })]);
    expect(result.results[0]?.status).toBe("applied");
    // One full-evidence data read; the apply path issues no scoped
    // verification request at all.
    expect(transport.getSpreadsheetRequests.filter(
      (request) => request.fields === GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
    )).toHaveLength(1);
  });

  it("(b) a real duplicate numeric identity still fails closed", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", {
      headers: [...SYSTEM_HEADERS],
      rows: [
        [45100, "pending", false],
        [45100, "other", false],
      ],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const current = {
      id: cell.number(45100),
      status: cell.string("pending"),
      __typed_sheets_deleted: cell.bool(false),
    };
    await expect(applyRequest(provider, [effect({
      targetAnchor: "45100",
      targetId: "entity:users:45100",
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash(current),
      fields: { ...current, status: cell.string("written") },
    })])).rejects.toThrow(/sync identity is duplicated/);
  });

  it("(c) appends land past human blanks with exact anchors in one whole-table read", async () => {
    const spreadsheet = new StubSpreadsheet();
    seedReceiptTab(spreadsheet, []);
    const tab = spreadsheet.addTab("Users_Input", {
      headers: [...USER_INPUT_HEADERS, "__hikoutei_row_id"],
      rows: [
        ["u1", "pending", "sync-anchor:a1"],
        ["u2", "pending", "sync-anchor:a2"],
        [null, null, null],
        ["u4", "human", "sync-anchor:a4"],
      ],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const result = await applyRequest(provider, [effect({
      projection: "user_input",
      physicalSheetId: USER_INPUT_SHEET_ID,
      targetAnchor: "sync-anchor:a3",
      targetId: "entity:users:u3",
      createIfMissing: true,
      fields: { id: cell.string("u3"), status: cell.string("new") },
    })]);
    expect(result.results[0]?.status).toBe("applied");
    // The historical full-width scan keeps nextAppendRow past the last human
    // content row: the new row lands at row 6 with its anchor.
    expect(tab.cell(5, 0)?.userEnteredValue?.stringValue).toBe("u3");
    expect(tab.cell(5, 2)?.userEnteredValue?.stringValue).toBe("sync-anchor:a3");
    // Enumeration + ONE whole-table full-evidence data read (the receipt tab
    // exists, so no refresh): the apply dispatch never grows its read count.
    expect(transport.getSpreadsheetRequests).toHaveLength(2);
    expect(transport.getSpreadsheetRequests[1]?.fields)
      .toBe(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS);
  });

  it("(c) the steady fast-append dispatch keeps the historical two paced reads", async () => {
    // Pure-insert batch, string identity, receipt tab present: enumeration +
    // ONE column-scoped base read + the write. No verification read is
    // issued, so the leased request budget is unchanged from HEAD.
    const spreadsheet = new StubSpreadsheet();
    seedReceiptTab(spreadsheet, []);
    const tab = spreadsheet.addTab("Users_System", {
      headers: [...SYSTEM_HEADERS],
      rows: [["u1", "pending", false]],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    const identity = "u2";
    const result = await provider.fastAppendRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      rows: [{
        effectId: "append-u2",
        payloadHash: "payload-u2",
        fields: {
          id: cell.string(identity),
          status: cell.string("pending"),
          __typed_sheets_deleted: cell.bool(false),
        },
      }],
    });
    expect(result.results[0]?.status).toBe("applied");
    expect(transport.getSpreadsheetRequests).toHaveLength(2);
    expect(transport.getSpreadsheetRequests[1]?.fields)
      .toBe(GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS);
    // The row is appended AFTER the existing content (position proof).
    expect(tab.cell(2, 0)?.userEnteredValue?.stringValue).toBe("u2");
  });

  it("(d) a key-row gap refuses scoped mode: whole-table full-evidence fallback", async () => {
    // 45 data rows separated by human blank rows: the scoped bands cannot
    // prove what the blank rows hold, so the dispatch falls back to the
    // historical whole-table full-evidence read and replays with IDENTICAL
    // outcomes (the receipt-replay hash is computed from the fallback
    // snapshot; no third verification read stacks on top of the fallback).
    function seedScattered(target: StubSpreadsheet): void {
      const rows: (string | number | boolean | null)[][] = [];
      for (let index = 0; index < 45; index += 1) {
        rows.push([`u${String(index)}`, `status-${String(index)}`, false]);
        rows.push([null, null, null]);
      }
      target.addTab("Users_System", { headers: [...SYSTEM_HEADERS], rows });
    }
    function rowFields(index: number): Record<string, NormalizedCell> {
      return {
        id: cell.string(`u${String(index)}`),
        status: cell.string(`status-${String(index)}`),
        __typed_sheets_deleted: cell.bool(false),
      };
    }
    async function dispatch(replayIndexes: readonly number[]): Promise<{
      readonly statuses: unknown[];
      readonly requests: GoogleSheetsApiGetSpreadsheetRequest[];
      readonly rawBytes: number[];
    }> {
      const spreadsheet = new StubSpreadsheet();
      seedScattered(spreadsheet);
      seedReceiptTab(spreadsheet, replayIndexes.map((index) => ({
        effectId: `noop-${String(index)}`,
        payloadHash: `payload-${String(index)}`,
        visibleHash: computeSyncVisibleHash(rowFields(index)),
        visibleRevision: 1,
      })));
      const transport = new StubSheetsTransport(spreadsheet);
      // Measure the RAW reply of every data request at the transport edge:
      // the scoped read and its whole-table fallback share ONE paced slot
      // (one telemetry event), so per-event bytes cannot separate them.
      const originalGet = transport.getSpreadsheet.bind(transport);
      const rawBytes: number[] = [];
      transport.getSpreadsheet = async (request) => {
        const response = await originalGet(request);
        if (request.ranges.length > 0) rawBytes.push(JSON.stringify(response).length);
        return response;
      };
      const provider = buildProvider(transport);
      const result = await provider.fastAppendRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        rows: replayIndexes.map((index) => ({
          effectId: `noop-${String(index)}`,
          payloadHash: `payload-${String(index)}`,
          fields: rowFields(index),
        })),
      });
      return {
        statuses: result.results.map((entry) => entry.status),
        requests: transport.getSpreadsheetRequests,
        rawBytes,
      };
    }

    const one = await dispatch([0]);
    // enumeration + scoped base read + the whole-table full-evidence
    // fallback REPLACES (not adds to) the verification read.
    expect(one.requests).toHaveLength(3);
    expect(one.requests[1]?.fields).toBe(GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS);
    expect(one.requests[1]?.ranges).toContain("'Users_System'!A2:A1048576");
    expect(one.requests[2]?.fields).toBe(GOOGLE_SHEETS_API_PREFLIGHT_FIELDS);
    expect(one.requests[2]?.ranges).toContain("'Users_System'!A1:C1048576");
    expect(one.statuses).toEqual(["applied"]);

    // Byte evidence on the SAME scattered table: the values-only column
    // bands are materially smaller than the whole-table full-evidence read.
    const [baseBytes = 0, fallbackBytes = 0] = one.rawBytes;
    expect(baseBytes).toBeGreaterThan(0);
    expect(fallbackBytes).toBeGreaterThan(baseBytes);
  });

  it("(e) answers a multi-range read with ONE cropped grid per range, in order", async () => {
    // Stub realism contract: a banded `spreadsheets.get` returns one
    // GridData per requested range (in request order), each cropped to its
    // own band. A whole-sheet grid would let scoped-read assertions pass
    // against data that the real API never returns for the band.
    const spreadsheet = new StubSpreadsheet();
    const rowFields = (id: string): Record<string, NormalizedCell> => ({
      id: cell.string(id),
      status: cell.string(`status-${id}`),
      __typed_sheets_deleted: cell.bool(false),
    });
    seedSystemTab(spreadsheet, [
      { anchor: "u0", fields: rowFields("u0") },
      { anchor: "u1", fields: rowFields("u1") },
      { anchor: "u2", fields: rowFields("u2") },
      { anchor: "u3", fields: rowFields("u3") },
    ]);
    const transport = new StubSheetsTransport(spreadsheet);
    const raw = await transport.getSpreadsheet({
      spreadsheetId: SPREADSHEET_ID,
      ranges: ["'Users_System'!A4:C4", "'Users_System'!A2:B2"],
      fields: GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
      timeoutMs: 1_000,
    });
    const grids = stubGridsOf(raw);
    expect(grids).toHaveLength(2);
    // Request order and bands are preserved, and each grid carries ONLY
    // its own row: no neighbouring row data rides along.
    expect(grids[0]?.startRow).toBe(3);
    expect(grids[0]?.startColumn).toBe(0);
    expect(grids[0]?.rowData).toHaveLength(1);
    expect(JSON.stringify(grids[0])).toContain('"status-u2"');
    expect(JSON.stringify(grids[0])).not.toContain('"status-u1"');
    expect(JSON.stringify(grids[0])).not.toContain('"status-u3"');
    // Column cropping too: the A2:B2 band never exposes column C.
    expect(grids[1]?.startRow).toBe(1);
    const secondRowValues = grids[1]?.rowData[0]?.values ?? [];
    expect(secondRowValues).toHaveLength(2);
  });

  it("resolves verification cells across the ordered per-range grid list", () => {
    const entered = (value: string): Record<string, unknown> => ({
      userEnteredValue: { stringValue: value },
    });
    const grids: ParsedGridData[] = [
      { startRow: 1, startColumn: 0, rowData: [{ values: [entered("a2"), entered("b2")] }] },
      { startRow: 99, startColumn: 2, rowData: [{ values: [entered("c100")] }] },
    ];
    expect(resolveVerifyCell(grids, 2, 1)).toEqual(entered("a2"));
    expect(resolveVerifyCell(grids, 2, 3)).toBeNull();
    expect(resolveVerifyCell(grids, 100, 3)).toEqual(entered("c100"));
    expect(resolveVerifyCell(grids, 1, 1)).toBeNull();
  });

  it("plans identity bands first and merges consecutive rows (no overflow rung)", () => {
    const context = verificationContextFixture({});
    const calibration = createReadCalibration();
    expect(planPreflightVerification(context, [2, 3, 4, 10], calibration)).toEqual({
      kind: "ranges",
      items: [
        { range: "'Users_System'!A2:B4", cells: 6 },
        { range: "'Users_System'!A10:B10", cells: 2 },
      ],
    });
    const withIdentity = verificationContextFixture({
      identityNeedsFormatEvidence: true,
      rows: [preflightRow(4)],
    });
    const planned = planPreflightVerification(withIdentity, [2], calibration);
    if (planned.kind !== "ranges") throw new Error("expected ranges");
    // Identity column ("id" = column A) spans every data row; the resolved
    // CAS row band covers the full registered span.
    expect(planned.items.map((item) => item.range)).toEqual([
      "'Users_System'!A2:A4", "'Users_System'!A2:B2",
    ]);
    // The unified engine removed the `overflow` rung: a 41-range plan stays
    // a band plan (the packer spreads it across sequential requests).
    const scattered = Array.from({ length: 41 }, (_, index) => 2 + index * 2);
    const scatteredPlan = planPreflightVerification(context, scattered, calibration);
    expect(scatteredPlan.kind).toBe("ranges");
    if (scatteredPlan.kind !== "ranges") throw new Error("expected ranges");
    expect(scatteredPlan.items).toHaveLength(41);
  });

  it("blanks a banded row whose verification anchor proves it shifted", () => {
    const baseRow = preflightRow(2, {
      physicalAnchor: presentValue("sync-anchor:a1"),
      cells: { id: cell.string("u1"), status: cell.string("pending") },
    });
    const context = verificationContextFixture({
      rows: [baseRow],
      anchorColumn: 3,
    });
    // The verification snapshot at row 2 carries a DIFFERENT anchor: a human
    // inserted a row above between the base and verification reads.
    const grids: ParsedGridData[] = [{
      startRow: 1,
      startColumn: 0,
      rowData: [{
        values: [
          { userEnteredValue: { stringValue: "someone-else" } },
          { userEnteredValue: { stringValue: "x" } },
          { userEnteredValue: { stringValue: "sync-anchor:zzz" } },
        ],
      }],
    }];
    const patched = patchPreflightContext(context, grids, [2], { includeIdentityBand: false });
    const row = patched.rows.find((candidate) => candidate.rowNumber === 2);
    expect(row?.cells.status).toBeNull();
    expect(row?.identity.kind).toBe("absent");
    expect(patched.byAnchor.has("sync-anchor:a1")).toBe(false);
  });

  it("blanks a banded row whose verification anchor is MISSING (shifted-in human row)", () => {
    const baseRow = preflightRow(2, {
      physicalAnchor: presentValue("sync-anchor:a1"),
      cells: { id: cell.string("u1"), status: cell.string("pending") },
    });
    const context = verificationContextFixture({
      rows: [baseRow],
      anchorColumn: 3,
    });
    // The verification snapshot at row 2 is NONBLANK but carries NO anchor:
    // a human typed a fresh row that shifted into the banded position between
    // the base and verification reads. Absence is as much proof of a shift
    // as a different anchor: the base row's evidence must fail closed.
    const grids: ParsedGridData[] = [{
      startRow: 1,
      startColumn: 0,
      rowData: [{
        values: [
          { userEnteredValue: { stringValue: "someone-else" } },
          { userEnteredValue: { stringValue: "x" } },
          {},
        ],
      }],
    }];
    const patched = patchPreflightContext(context, grids, [2], { includeIdentityBand: false });
    const row = patched.rows.find((candidate) => candidate.rowNumber === 2);
    expect(row?.cells.status).toBeNull();
    expect(row?.identity.kind).toBe("absent");
    expect(patched.byAnchor.has("sync-anchor:a1")).toBe(false);
    expect(patched.byIdentity.has("someone-else")).toBe(false);
  });

  it("promotes a date-formatted numeric identity through the verification band", () => {
    const plain = preflightRow(2, {
      cells: { id: cell.number(45100), status: cell.string("pending") },
      identity: presentValue("45100"),
    });
    const formatted = preflightRow(3, {
      cells: { id: cell.number(45100), status: cell.string("human-copy") },
      identity: presentValue("45100"),
    });
    const context = verificationContextFixture({ rows: [plain, formatted] });
    const grids: ParsedGridData[] = [{
      startRow: 1,
      startColumn: 0,
      rowData: [
        { values: [{ userEnteredValue: { numberValue: 45100 } }] },
        {
          values: [{
            userEnteredValue: { numberValue: 45100 },
            effectiveFormat: { numberFormat: CANONICAL_DATE_FORMAT },
          }],
        },
      ],
    }];
    const patched = patchPreflightContext(context, grids, [], {
      includeIdentityBand: true,
    });
    // The stray-format row re-keys to its ISO identity: the base-read
    // "duplicate" resolves exactly like the historical full-mask read.
    expect(patched.byIdentity.get("45100")?.rowNumber).toBe(2);
    expect(
      patched.byIdentity.get("2023-06-23T00:00:00.000Z")?.rowNumber,
    ).toBe(3);
    expect(patched.identityNeedsFormatEvidence).toBe(false);
  });
});

/** Extracts the raw grid list of a stub `getSpreadsheet` reply. */
function stubGridsOf(
  raw: unknown,
): { readonly startRow: number; readonly startColumn: number; readonly rowData: { readonly values: unknown[] }[] }[] {
  const document = raw as {
    sheets: { data: { startRow: number; startColumn: number; rowData: { values: unknown[] }[] }[] }[];
  };
  return document.sheets.flatMap((sheet) => sheet.data);
}

/** One minimal preflight row for the pure verification-helper fixtures. */
function preflightRow(
  rowNumber: number,
  overrides: Partial<Pick<PreflightRow, "physicalAnchor" | "cells" | "identity">> = {},
): PreflightRow {
  return {
    rowNumber,
    physicalAnchor: overrides.physicalAnchor ?? absentValue(),
    cells: overrides.cells ?? {},
    identity: overrides.identity ?? absentValue(),
  };
}

/** Minimal synthetic preflight context for the pure verification helpers. */
function verificationContextFixture(overrides: {
  readonly rows?: PreflightRow[];
  readonly identityNeedsFormatEvidence?: boolean;
  readonly anchorColumn?: number;
} = {}): PreflightContext {
  const rows = overrides.rows ?? [];
  const headers = ["id", "status"];
  return {
    sheetId: 7,
    title: "Users_System",
    startColumn: 1,
    headers,
    positions: new Map(headers.map((header, index) => [header, index])),
    rows,
    byAnchor: new Map(),
    byIdentity: new Map(
      rows
        .filter((row) => row.identity.kind === "present")
        .map((row) => [row.identity.kind === "present" ? row.identity.value : "", row]),
    ),
    nextAppendRow: 2,
    identityField: presentValue("id"),
    identityNeedsFormatEvidence: overrides.identityNeedsFormatEvidence ?? false,
    checkboxHeaders: [],
    scopedBase: true,
    anchorColumn: overrides.anchorColumn,
    checkColumn: undefined,
    receiptSheetId: absentValue(),
    receiptLastRow: 0,
    receiptFirstRow: undefined,
    receipts: new Map(),
    existingSheetIds: [7],
  };
}
