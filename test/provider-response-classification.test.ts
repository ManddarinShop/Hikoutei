/**
 * Focused fixtures for issue #357: invalid-provider-response classification.
 *
 * The three live-soak evidence branches (malformed batchUpdate/get 2xx reply,
 * fast-append identity already exists without a matching receipt, and a
 * postcondition read with a missing tab) must each surface a redacted
 * `hikoutei.transport.response_invalid` event carrying ONLY the allowlisted
 * `providerOperation` / `providerReason` tags — never a URL, spreadsheet/tab/
 * effect id, response body, cell value, credential, or raw message. These
 * tests drive the real provider over the stub transport, capture the internal
 * log event the boundary emits, and assert the stable classification and
 * redaction guarantees.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { presentValue, absentValue, notApplicableValue } from "@hikoutei/contracts/state/index.js";
import { computeSyncVisibleHash } from "@hikoutei/contracts/sheets/syncSheets.js";
import type { SyncProjectionEffect } from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  SYNC_INVALID_PROVIDER_OPERATIONS,
  SYNC_INVALID_PROVIDER_REASONS,
  SYNC_SHEETS_ERROR_CODES,
  type SyncInvalidProviderClassification,
} from "@hikoutei/contracts/sheets/errors.js";
import {
  HIKOUTEI_LOG_ENV_KEYS,
  getHikouteiInternalLogger,
  resetHikouteiInternalLoggerForTests,
} from "../src/shared/observability/internalLog.js";
import { HIKOUTEI_LOG_EVENTS } from "../src/shared/observability/logEvents.js";
import type { RegisteredSyncProjectionDefinition, SyncSheetsProvisionRoute } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import { GoogleSheetsApiSyncProvider } from "../src/adapter/sheets/providers/google-sheets-api/index.js";
import {
  StubSpreadsheet,
  StubSheetsTransport,
} from "./support/StubSheetsTransport.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { SYSTEM_HEADERS } from "./support/googleSheetsFixtures.js";

const SPREADSHEET_ID = "stub-spreadsheet";
const SYSTEM_SHEET_ID = "entity:users:system_state";

/** Builds one system_state projection definition against the stub spreadsheet. */
function systemDefinition(tabName: string = "Users_System"): RegisteredSyncProjectionDefinition {
  return {
    sheet: {
      logicalSheetId: "entity:users",
      physicalSheetId: SYSTEM_SHEET_ID,
      spreadsheetId: SPREADSHEET_ID,
      tabName,
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      ownershipManifestJson: "{}",
      businessKeyField: "id",
      anchorMode: "business_key",
    },
    headers: [...SYSTEM_HEADERS],
  };
}

function buildProvider(transport: StubSheetsTransport, tabName?: string): GoogleSheetsApiSyncProvider {
  return new GoogleSheetsApiSyncProvider({
    spreadsheetId: SPREADSHEET_ID,
    definitions: [systemDefinition(tabName)],
    transport,
    requestTimeoutMs: 60_000,
    readTimeoutMs: 5_000,
    rateLimitIntervalMs: 0,
  });
}

/** Builds the provisioning route for the system_state definition. */
function systemProvisionRoute(): SyncSheetsProvisionRoute {
  return {
    sheetName: "Users_System",
    registeredRange: "A:C",
    projection: "system_state",
    schemaVersion: 1,
    headers: [...SYSTEM_HEADERS],
    identityField: "id",
  };
}

function appendRow(identity: string, effectId = `append-${identity}`): {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
} {
  return {
    effectId,
    payloadHash: `payload-${identity}`,
    fields: {
      id: { kind: "string", value: identity },
      status: { kind: "string", value: "pending" },
      __typed_sheets_deleted: { kind: "boolean", value: false },
    },
  };
}

/** A minimal effect shape for the postcondition-recovery read. */
function postconditionEffect(sheetName: string): SyncProjectionEffect {
  const fields = { id: { kind: "string" as const, value: "u1" } };
  return {
    effectId: "postcond-1",
    payloadHash: "payload-postcond",
    effectKind: "system_projection",
    physicalSheetId: SYSTEM_SHEET_ID,
    projection: "system_state",
    targetKind: "entity",
    targetId: "entity:users:u1",
    rowBindingId: presentValue("row:u1"),
    conflictId: absentValue(),
    expectedVisibleRevision: 0,
    expectedVisibleHash: "",
    repairGuardHash: absentValue(),
    payload: {
      sheetName,
      registeredRange: "A:C",
      schemaVersion: 1,
      targetAnchor: "u1",
      fields: { id: { kind: "string", value: "u1" } },
      targetVisibleHash: computeSyncVisibleHash({
        id: { kind: "string", value: "u1" },
        status: { kind: "string", value: "pending" },
        __typed_sheets_deleted: { kind: "boolean", value: false },
      }),
      createIfMissing: false,
      expectedCandidateHash: notApplicableValue(),
    },
  };
}

/** Parses a captured log file into JSONL records. */
async function readLogLines(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * Runs one provider operation that is expected to fail closed with
 * `invalid_sync_provider_response`, captures the internal log file, and
 * returns the emitted `hikoutei.transport.response_invalid` event.
 */
async function captureInvalidResponse(
  run: () => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-classification-"));
  const filePath = path.join(tempRoot, "hikoutei-log.txt");
  const previous = process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE];
  process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE] = filePath;
  resetHikouteiInternalLoggerForTests();
  try {
    await expect(run()).rejects.toMatchObject({
      code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
    });
    await getHikouteiInternalLogger().drain();
    const lines = await readLogLines(filePath);
    const event = lines.find(
      (line) => line.event === HIKOUTEI_LOG_EVENTS.TRANSPORT_RESPONSE_INVALID,
    );
    if (event === undefined) throw new Error("expected a hikoutei.transport.response_invalid event");
    return event;
  } finally {
    if (previous === undefined) {
      delete process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE];
    } else {
      process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE] = previous;
    }
    resetHikouteiInternalLoggerForTests();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

describe("invalid provider-response classification (issue #357)", () => {
  it("classifies a malformed batchUpdate 2xx reply as batch_update_reply/malformed_reply", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    transport.fault = { kind: "malformedBatchUpdateReply" };

    const event = await captureInvalidResponse(() =>
      provider.fastAppendRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        rows: [appendRow("u1", "malformed-batch-1")],
      }),
    );

    expect(event.code).toBe(SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE);
    expect(event.errorClass).toBe("SyncSheetsContractError");
    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.BATCH_UPDATE_REPLY);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY);
    // Redaction: no message, no effect id, no tab/URL/payload in the event.
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("malformed-batch-1");
  });

  it("classifies a malformed get 2xx reply as get_reply/malformed_reply", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    transport.fault = { kind: "malformedGetResponse" };

    const event = await captureInvalidResponse(() =>
      provider.fastAppendRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        rows: [appendRow("u2", "malformed-get-1")],
      }),
    );

    expect(event.code).toBe(SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE);
    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("malformed-get-1");
  });

  it("classifies a field-level malformed get guard as get_reply/malformed_reply", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);
    // Structurally valid top-level body whose tab title is not a string: the
    // top-level shape guard passes and a field-level parse guard fails.
    transport.fault = { kind: "malformedGetField" };

    const event = await captureInvalidResponse(() =>
      provider.fastAppendRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        rows: [appendRow("u3", "malformed-get-field-1")],
      }),
    );

    expect(event.code).toBe(SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE);
    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("malformed-get-field-1");
  });

  it("classifies a malformed raw GET cell value as get_reply/malformed_reply", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
    // A cell whose stringValue is not a string: the sheet/cell parse succeeds
    // structurally but the cell-value guard fails closed.
    (tab.cells as unknown as Map<string, unknown>).set("1,0", {
      userEnteredValue: { stringValue: 42 },
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const event = await captureInvalidResponse(() =>
      provider.fastAppendRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        rows: [appendRow("u4", "malformed-cell-1")],
      }),
    );

    expect(event.code).toBe(SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE);
    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("malformed-cell-1");
  });

  it("classifies a malformed raw GET cell numberFormat as get_reply/malformed_reply", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
    // numberFormat is a bare string instead of the { type, pattern } object the
    // cell-format guard requires.
    (tab.cells as unknown as Map<string, unknown>).set("1,0", {
      userEnteredValue: { stringValue: "u5" },
      userEnteredFormat: { numberFormat: "DATE_TIME" },
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const event = await captureInvalidResponse(() =>
      provider.fastAppendRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        rows: [appendRow("u5", "malformed-format-1")],
      }),
    );

    expect(event.code).toBe(SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE);
    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("malformed-format-1");
  });

  it("classifies a primitive CellData wrapper as get_reply/malformed_reply", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
    // A whole CellData entry that is a primitive (not an object) is a malformed
    // wrapper: it must fail closed at the values-array boundary instead of
    // silently becoming a blank cell or dropping its userEnteredValue.
    (tab.cells as unknown as Map<string, unknown>).set("1,0", "u6");
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const event = await captureInvalidResponse(() =>
      provider.fastAppendRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        rows: [appendRow("u6", "primitive-cell-1")],
      }),
    );

    expect(event.code).toBe(SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE);
    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("primitive-cell-1");
    expect(JSON.stringify(event)).not.toContain("u6");
  });

  it("classifies a primitive userEnteredFormat wrapper as get_reply/malformed_reply", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
    // A present but bare-string userEnteredFormat (not a record) is a malformed
    // format container: it must fail closed instead of silently dropping the
    // cell's number format.
    (tab.cells as unknown as Map<string, unknown>).set("1,0", {
      userEnteredValue: { stringValue: "u7" },
      userEnteredFormat: "DATE_TIME",
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const event = await captureInvalidResponse(() =>
      provider.fastAppendRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        rows: [appendRow("u7", "primitive-format-1")],
      }),
    );

    expect(event.code).toBe(SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE);
    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("primitive-format-1");
    expect(JSON.stringify(event)).not.toContain("u7");
  });

  it("fails a literal cell with a malformed effectiveValue as get_reply/malformed_reply", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
    // A literal (non-formula) cell whose present effectiveValue is a primitive:
    // the up-front CellData child validation must fail closed even though the
    // entered value is valid and the cell is not a formula.
    (tab.cells as unknown as Map<string, unknown>).set("1,0", {
      userEnteredValue: { stringValue: "literal-1" },
      // A numeric literal collides with the event's `ts` timestamp (seconds can
      // be "42"), so use a string sentinel that can never appear in a timestamp.
      effectiveValue: "malformed-literal-primitive-1",
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const event = await captureInvalidResponse(() =>
      provider.readRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        headers: [...SYSTEM_HEADERS],
      }),
    );

    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("literal-1");
    expect(JSON.stringify(event)).not.toContain("malformed-literal-primitive-1");
  });

  it("does not let a valid entered format hide a malformed effective numberFormat", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
    // A valid entered number format must not hide a malformed lower-priority
    // effective numberFormat: both format containers and both nested number
    // format containers are validated before the entered format is selected.
    (tab.cells as unknown as Map<string, unknown>).set("1,0", {
      userEnteredValue: { stringValue: "fmt-1" },
      userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: "yyyy-mm-dd" } },
      effectiveFormat: { numberFormat: "bogus" },
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const event = await captureInvalidResponse(() =>
      provider.readRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        headers: [...SYSTEM_HEADERS],
      }),
    );

    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("fmt-1");
    expect(JSON.stringify(event)).not.toContain("bogus");
  });

  it("fails provisioning on a primitive CellData child wrapper as get_reply/malformed_reply", async () => {
    const spreadsheet = new StubSpreadsheet();
    const tab = spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
    // A primitive userEnteredValue wrapper in the provisioning grid would
    // previously be permissively treated as "no content"; it must now fail
    // closed instead of silently skewing the emptiness/header decision.
    (tab.cells as unknown as Map<string, unknown>).set("1,0", {
      userEnteredValue: "raw-provider-sentinel-9f2c",
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const event = await captureInvalidResponse(() =>
      provider.provisionRegistry([systemProvisionRoute()]),
    );

    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("raw-provider-sentinel-9f2c");
  });

  it("does not mislabel a missing tab in a generic table read as malformed", async () => {
    // The registered tab is absent from the spreadsheet: a structurally valid
    // GET can simply lack the tab. A generic table read has no missing-tab
    // taxonomy pair, so it must keep the safe unclassified default instead of
    // being mislabeled get_reply/malformed_reply.
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const event = await captureInvalidResponse(() =>
      provider.readRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        headers: [...SYSTEM_HEADERS],
      }),
    );

    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.UNCLASSIFIED);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.UNCLASSIFIED);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("Users_System");
  });

  it("classifies a fast-append identity already present without a receipt as preflight/identity_already_exists", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", {
      headers: [...SYSTEM_HEADERS],
      // A pre-existing remote identity row with no matching receipt: the
      // effect's identity already exists in the sheet, so a pending append
      // cannot be safely redriven (stale-state protection).
      rows: [["u1", "pending", false]],
    });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const event = await captureInvalidResponse(() =>
      provider.fastAppendRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        rows: [appendRow("u1", "identity-exists-1")],
      }),
    );

    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.PREFLIGHT);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.IDENTITY_ALREADY_EXISTS);
    // Redaction: the effect id and the identity value never reach the log.
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("identity-exists-1");
  });

  it("does not mislabel a current-request duplicate as a remote identity collision", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", { headers: [...SYSTEM_HEADERS] });
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    // Two distinct effects in ONE request share the same identity field value;
    // there is no remote row and no receipt. The second row is a local call
    // error (duplicate within the current request), NOT a remote collision, so
    // it keeps the safe unclassified default.
    const event = await captureInvalidResponse(() =>
      provider.fastAppendRows({
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "Users_System",
        registeredRange: "A:C",
        projection: "system_state",
        schemaVersion: 1,
        rows: [appendRow("dup", "dup-a"), appendRow("dup", "dup-b")],
      }),
    );

    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.UNCLASSIFIED);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.UNCLASSIFIED);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("dup");
  });

  it("classifies a postcondition read with a missing tab as postcondition_read/missing_tab", async () => {
    // The registered tab is absent from the spreadsheet, so the postcondition
    // recovery read's preflight cannot resolve it.
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = buildProvider(transport);

    const event = await captureInvalidResponse(() =>
      provider.readEffectPostcondition(postconditionEffect("Users_System")),
    );

    expect(event.providerOperation).toBe(SYNC_INVALID_PROVIDER_OPERATIONS.POSTCONDITION_READ);
    expect(event.providerReason).toBe(SYNC_INVALID_PROVIDER_REASONS.MISSING_TAB);
    expect(event.message).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("Users_System");
  });
});

describe("invalid provider-response classification valid pair contract (issue #357)", () => {
  it("permits exactly the proven operation/reason pairs (compile-time)", () => {
    // Every proven pair satisfies the discriminated union.
    const valid: SyncInvalidProviderClassification[] = [
      { operation: SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY, reason: SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY },
      { operation: SYNC_INVALID_PROVIDER_OPERATIONS.BATCH_UPDATE_REPLY, reason: SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY },
      { operation: SYNC_INVALID_PROVIDER_OPERATIONS.PREFLIGHT, reason: SYNC_INVALID_PROVIDER_REASONS.IDENTITY_ALREADY_EXISTS },
      { operation: SYNC_INVALID_PROVIDER_OPERATIONS.PREFLIGHT, reason: SYNC_INVALID_PROVIDER_REASONS.MISSING_TAB },
      { operation: SYNC_INVALID_PROVIDER_OPERATIONS.POSTCONDITION_READ, reason: SYNC_INVALID_PROVIDER_REASONS.MISSING_TAB },
      { operation: SYNC_INVALID_PROVIDER_OPERATIONS.UNCLASSIFIED, reason: SYNC_INVALID_PROVIDER_REASONS.UNCLASSIFIED },
    ];
    expect(valid.length).toBe(6);

    // Invalid pairs must NOT compile: each line below produces a type error, so
    // if a loose pair accidentally becomes representable, `typecheck:test`
    // fails with an unused `@ts-expect-error` directive.
    // @ts-expect-error get_reply cannot carry identity_already_exists
    const badGet: SyncInvalidProviderClassification = { operation: SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY, reason: SYNC_INVALID_PROVIDER_REASONS.IDENTITY_ALREADY_EXISTS };
    // @ts-expect-error malformed_reply is not a preflight reason
    const badPreflight: SyncInvalidProviderClassification = { operation: SYNC_INVALID_PROVIDER_OPERATIONS.PREFLIGHT, reason: SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY };
    // @ts-expect-error batch_update_reply cannot be a missing_tab
    const badBatch: SyncInvalidProviderClassification = { operation: SYNC_INVALID_PROVIDER_OPERATIONS.BATCH_UPDATE_REPLY, reason: SYNC_INVALID_PROVIDER_REASONS.MISSING_TAB };

    expect([badGet, badPreflight, badBatch]).toBeDefined();
  });
});
