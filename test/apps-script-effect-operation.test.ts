import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  computeSyncVisibleHash,
  type ApplySyncEffectsResult,
  type SyncGatewayEffect,
} from "../src/application/sync/gateway/syncGateway.js";
import {
  createApplyEffectsOperation,
} from "../src/adapter/sheets/providers/apps-script-gateway/operations/effect/effectOperation.js";
import { createObserveSnapshotOperation } from "../src/adapter/sheets/providers/apps-script-gateway/operations/observation/observationOperation.js";

const SHEET_NAME = "Users_Input";
const PHYSICAL_SHEET_ID = "users-input";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("thin Code.gs effect operation", () => {
  it("plans append, existing update, and delete as separate physical operations", () => {
    const sheet = new FakeSheet(SHEET_NAME, ["id", "status"]);
    const spreadsheet = new FakeSpreadsheet(sheet);
    installAppsScriptGlobals();

    const append = createEffect({
      effectId: "effect-append",
      effectKind: "candidate_reconcile",
      fields: stringFields("u1", "pending"),
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      createIfMissing: true,
      expectedCandidateHash: { kind: "applicable", value: "candidate-1" },
    });
    const appendResult = runApply(spreadsheet, append);

    expect(appendResult.results[0]).toMatchObject({
      effectId: append.effectId,
      status: "applied",
      visibleRevision: { kind: "present", value: 1 },
      visibleHash: { kind: "present", value: append.payload.targetVisibleHash },
      postcondition: "verified",
    });
    expect(sheet.rowValues(2)).toEqual(["u1", "pending"]);
    expect(sheet.metadataValues(2)).toEqual([]);

    const update = createEffect({
      effectId: "effect-update",
      effectKind: "candidate_reconcile",
      fields: stringFields("u1", "paid"),
      expectedVisibleRevision: 1,
      expectedVisibleHash: append.payload.targetVisibleHash,
      createIfMissing: false,
      expectedCandidateHash: { kind: "applicable", value: "candidate-1" },
    });
    const updateResult = runApply(spreadsheet, update);

    expect(updateResult.results[0]).toMatchObject({
      effectId: update.effectId,
      status: "applied",
      visibleRevision: { kind: "present", value: 2 },
      visibleHash: { kind: "present", value: update.payload.targetVisibleHash },
    });
    expect(sheet.rowValues(2)).toEqual(["u1", "paid"]);

    const deletion = createEffect({
      effectId: "effect-delete",
      effectKind: "user_input_delete",
      fields: stringFields("u1", "paid"),
      expectedVisibleRevision: 2,
      expectedVisibleHash: update.payload.targetVisibleHash,
      createIfMissing: false,
      expectedCandidateHash: { kind: "not_applicable" },
    });
    const deletionResult = runApply(spreadsheet, deletion);

    expect(deletionResult.results[0]).toMatchObject({
      effectId: deletion.effectId,
      status: "applied",
      visibleRevision: { kind: "present", value: 2 },
      visibleHash: { kind: "present", value: deletion.payload.targetVisibleHash },
    });
    expect(sheet.getLastRow()).toBe(1);

    const receiptSheet = spreadsheet.getSheetByName("__typed_sheets_internal_effect_receipts");
    expect(receiptSheet?.getLastRow()).toBe(4);
  });

  it("queues a receipt when an unrecorded effect is already visible", () => {
    const sheet = new FakeSheet(SHEET_NAME, ["id", "status"]);
    sheet.seedRow(2, ["u1", "paid"], "anchor:u1");
    const spreadsheet = new FakeSpreadsheet(sheet);
    installAppsScriptGlobals();

    const effect = createEffect({
      effectId: "effect-already-visible",
      effectKind: "system_projection",
      fields: stringFields("u1", "paid"),
      expectedVisibleRevision: 1,
      expectedVisibleHash: computeSyncVisibleHash(stringFields("u1", "paid")),
      createIfMissing: false,
      expectedCandidateHash: { kind: "not_applicable" },
    });
    const result = runApply(spreadsheet, effect);

    expect(result.results[0]).toMatchObject({
      status: "already_applied",
      visibleRevision: { kind: "present", value: 2 },
      visibleHash: { kind: "present", value: effect.payload.targetVisibleHash },
    });
    expect(spreadsheet.getSheetByName("__typed_sheets_internal_effect_receipts")?.getLastRow()).toBe(2);
  });

  it("reads User_Input by visible values without touching row metadata", () => {
    const sheet = new FakeSheet(SHEET_NAME, ["id", "status"]);
    sheet.seedRow(2, ["u1", "pending"], "legacy-anchor:u1");
    const metadataWritesBefore = sheet.metadataWriteCount;
    const spreadsheet = new FakeSpreadsheet(sheet);
    installAppsScriptGlobals();

    const operation = createObserveSnapshotOperation({
      physicalSheetId: PHYSICAL_SHEET_ID,
      sheetName: SHEET_NAME,
      registeredRange: "A:B",
      projection: "user_input",
      schemaVersion: 1,
      readMode: "user_input",
    });
    const rawResult = executeAppsScriptSource(operation.fn, spreadsheet, operation.args);
    if (operation.decode === undefined) throw new Error("observation decoder is missing");
    const result = operation.decode(rawResult);

    expect(result.timing?.phases.map((phase) => phase.phase)).not.toContain("anchor_metadata_read");
    expect(sheet.metadataReadCount).toBe(0);
    expect(sheet.metadataWriteCount).toBe(metadataWritesBefore);
  });
});

function runApply(spreadsheet: FakeSpreadsheet, effect: SyncGatewayEffect): ApplySyncEffectsResult {
  const operation = createApplyEffectsOperation({
    physicalSheetId: PHYSICAL_SHEET_ID,
    sheetName: SHEET_NAME,
    registeredRange: "A:B",
    projection: "user_input",
    schemaVersion: 1,
    identityField: "id",
    effects: [effect],
  });
  const rawResult = executeAppsScriptSource(operation.fn, spreadsheet, operation.args);
  if (operation.decode === undefined) throw new Error("effect operation decoder is missing");
  return operation.decode(rawResult);
}

function createEffect(options: {
  readonly effectId: string;
  readonly effectKind: SyncGatewayEffect["effectKind"];
  readonly fields: SyncGatewayEffect["payload"]["fields"];
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly createIfMissing: boolean;
  readonly expectedCandidateHash: SyncGatewayEffect["payload"]["expectedCandidateHash"];
}): SyncGatewayEffect {
  return {
    effectId: options.effectId,
    payloadHash: `payload-${options.effectId}`,
    effectKind: options.effectKind,
    physicalSheetId: PHYSICAL_SHEET_ID,
    projection: "user_input",
    targetKind: "entity",
    targetId: "u1",
    rowBindingId: { kind: "present", value: "binding:u1" },
    expectedVisibleRevision: options.expectedVisibleRevision,
    expectedVisibleHash: options.expectedVisibleHash,
    repairGuardHash: { kind: "absent" },
    payload: {
      sheetName: SHEET_NAME,
      registeredRange: "A:B",
      schemaVersion: 1,
      fields: options.fields,
      targetVisibleHash: computeSyncVisibleHash(options.fields),
      createIfMissing: options.createIfMissing,
      expectedCandidateHash: options.expectedCandidateHash,
    },
  };
}

function stringFields(id: string, status: string): SyncGatewayEffect["payload"]["fields"] {
  return {
    id: { kind: "string", value: id },
    status: { kind: "string", value: status },
  };
}

function installAppsScriptGlobals(): void {
  vi.stubGlobal("SpreadsheetApp", {
    DeveloperMetadataVisibility: { PROJECT: "PROJECT" },
    flush: vi.fn(),
  });
  vi.stubGlobal("LockService", {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: vi.fn(),
    }),
  });
  vi.stubGlobal("Utilities", {
    Charset: { UTF_8: "UTF_8" },
    DigestAlgorithm: { SHA_256: "SHA_256" },
    computeDigest: (_algorithm: string, value: string, _charset: string) => signedBytes(
      createHash("sha256").update(value, "utf8").digest(),
    ),
    newBlob: (value: string) => ({ getBytes: () => signedBytes(Buffer.from(value, "utf8")) }),
  });
}

function signedBytes(value: Uint8Array): number[] {
  return Array.from(value, (byte) => (byte > 127 ? byte - 256 : byte));
}

type StoredMetadata = { readonly key: string; readonly value: string };

class FakeSpreadsheet {
  private readonly sheets = new Map<string, FakeSheet>();

  public constructor(mainSheet: FakeSheet) {
    this.sheets.set(mainSheet.getName(), mainSheet);
  }

  public getSheetByName(name: string): FakeSheet | null {
    return this.sheets.get(name) ?? null;
  }

  public insertSheet(name: string): FakeSheet {
    const sheet = new FakeSheet(name, []);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

class FakeSheet {
  private readonly values: unknown[][];
  private readonly metadata = new Map<number, StoredMetadata[]>();
  private hidden = false;
  public metadataReadCount = 0;
  public metadataWriteCount = 0;

  public constructor(private readonly name: string, headers: readonly string[]) {
    this.values = headers.length === 0 ? [] : [Array.from(headers)];
  }

  public getName(): string {
    return this.name;
  }

  public getLastRow(): number {
    return this.values.length;
  }

  public getLastColumn(): number {
    return this.values.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  }

  public getRange(...args: readonly (number | string)[]): FakeRange {
    return new FakeRange(this, args);
  }

  public deleteRow(rowNumber: number): void {
    this.values.splice(rowNumber - 1, 1);
    const shifted = new Map<number, StoredMetadata[]>();
    for (const [row, entries] of this.metadata.entries()) {
      if (row < rowNumber) shifted.set(row, entries);
      if (row > rowNumber) shifted.set(row - 1, entries);
    }
    this.metadata.clear();
    shifted.forEach((entries, row) => this.metadata.set(row, entries));
  }

  public hideSheet(): void {
    this.hidden = true;
  }

  public isSheetHidden(): boolean {
    return this.hidden;
  }

  public seedRow(rowNumber: number, values: readonly unknown[], anchor: string): void {
    this.writeValues(rowNumber, 1, [values]);
    this.metadata.set(rowNumber, [{ key: "typed_sheets_sync_anchor", value: anchor }]);
    this.metadataWriteCount += 1;
  }

  public rowValues(rowNumber: number): unknown[] {
    return Array.from({ length: this.getLastColumn() }, (_, columnIndex) => (
      this.values[rowNumber - 1]?.[columnIndex] ?? ""
    ));
  }

  public metadataValues(rowNumber: number): string[] {
    return (this.metadata.get(rowNumber) ?? []).map((entry) => entry.value);
  }

  public readValues(rowNumber: number, columnNumber: number, rowCount: number, columnCount: number): unknown[][] {
    return Array.from({ length: rowCount }, (_, rowOffset) => Array.from(
      { length: columnCount },
      (_, columnOffset) => this.values[rowNumber - 1 + rowOffset]?.[columnNumber - 1 + columnOffset] ?? "",
    ));
  }

  public writeValues(rowNumber: number, columnNumber: number, values: readonly (readonly unknown[])[]): void {
    while (this.values.length < rowNumber + values.length - 1) this.values.push([]);
    values.forEach((row, rowOffset) => {
      const target = this.values[rowNumber - 1 + rowOffset]!;
      while (target.length < columnNumber + row.length - 1) target.push("");
      row.forEach((value, columnOffset) => {
        target[columnNumber - 1 + columnOffset] = value;
      });
    });
  }

  public rowMetadata(rowNumber: number): StoredMetadata[] {
    this.metadataReadCount += 1;
    return [...(this.metadata.get(rowNumber) ?? [])];
  }

  public addRowMetadata(rowNumber: number, key: string, value: string): void {
    this.metadataWriteCount += 1;
    const entries = this.metadata.get(rowNumber) ?? [];
    entries.push({ key, value });
    this.metadata.set(rowNumber, entries);
  }
}

class FakeRange {
  public constructor(
    private readonly sheet: FakeSheet,
    private readonly args: readonly (number | string)[],
  ) {}

  public getValues(): unknown[][] {
    const coordinates = this.coordinates();
    return this.sheet.readValues(
      coordinates.startRow,
      coordinates.startColumn,
      coordinates.rowCount,
      coordinates.columnCount,
    );
  }

  public setValues(values: readonly (readonly unknown[])[]): void {
    const coordinates = this.coordinates();
    this.sheet.writeValues(coordinates.startRow, coordinates.startColumn, values);
  }

  public getDeveloperMetadata(): readonly { getKey: () => string; getValue: () => string }[] {
    const rowNumber = this.coordinates().startRow;
    return this.sheet.rowMetadata(rowNumber).map((entry) => ({
      getKey: () => entry.key,
      getValue: () => entry.value,
    }));
  }

  public addDeveloperMetadata(key: string, value: string): void {
    this.sheet.addRowMetadata(this.coordinates().startRow, key, value);
  }

  public setDataValidation(): void {
    // Checkbox setup is not part of this regression fixture.
  }

  private coordinates(): {
    readonly startRow: number;
    readonly startColumn: number;
    readonly rowCount: number;
    readonly columnCount: number;
  } {
    if (typeof this.args[0] === "string") {
      const match = /^(\d+):(\d+)$/.exec(this.args[0]);
      if (match === null) throw new Error(`Unsupported A1 range: ${this.args[0]}`);
      return {
        startRow: Number(match[1]),
        startColumn: 1,
        rowCount: Number(match[2]) - Number(match[1]) + 1,
        columnCount: Math.max(this.sheet.getLastColumn(), 1),
      };
    }
    return {
      startRow: Number(this.args[0]),
      startColumn: Number(this.args[1]),
      rowCount: Number(this.args[2] ?? 1),
      columnCount: Number(this.args[3] ?? 1),
    };
  }
}

type AppsScriptOperationSource = (spreadsheet: unknown, args: unknown) => unknown;

function executeAppsScriptSource(source: string, spreadsheet: unknown, args: unknown): unknown {
  const factory = new Function(`return (${source});`) as () => AppsScriptOperationSource;
  return factory()(spreadsheet, args);
}
