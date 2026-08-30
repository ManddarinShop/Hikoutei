/**
 * In-memory implementation of the sync provider contract.
 *
 * It deliberately models the safety boundary of the regular path and the
 * append-only behavior of the fast path: visible compare-and-set, effect-id
 * receipts, read-back after response loss, and bounded partial batches. Tests
 * can therefore prove outbox behavior without a network call or a Sheet.
 */

import {
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "@hikoutei/contracts/constants.js";
import { stableHash } from "@hikoutei/contracts/encoding/stableEncode.js";
import type { EffectKind } from "@hikoutei/contracts/domain/model/constants.js";
import type {
  Applicability,
  LookupResult,
  Presence,
} from "@hikoutei/contracts/state/types.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { CELL_OBSERVATION_KINDS } from "@hikoutei/contracts/encoding/constants.js";
import {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "@hikoutei/contracts/state/index.js";
import { CoreErrorException } from "@hikoutei/contracts/domain/errors/index.js";
import {
  computeSyncVisibleHash,
  type ApplySyncEffectsRequest,
  type ApplySyncEffectsResult,
  type FastAppendRow,
  type FastAppendRowResult,
  type FastAppendRowsRequest,
  type FastAppendRowsResult,
  type EnsureSyncRowAnchorsRequest,
  type EnsureSyncRowAnchorsResult,
  type ReadSyncEffectPostconditionsRequest,
  type ReadSyncSnapshotRequest,
  type ReadSyncTableRowsRequest,
  type SyncTableRowsResult,
  type SyncEffectPostcondition,
  type SyncProjectionEffect,
  type SyncEffectPostconditionResult,
  type SyncEffectResult,
  type SyncSheetsSnapshot,
  type SyncProjection,
  type SyncSheetsProvider,
  type SyncSnapshotCell,
  type SyncSnapshotRow,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  SYNC_DELETE_EFFECT_KINDS,
  SYNC_EFFECT_RESULT_STATUSES,
  SYNC_FAST_APPEND_STATUSES,
  SYNC_POSTCONDITION_DISPOSITIONS,
  SYNC_POSTCONDITION_MODES,
  SYNC_POSTCONDITION_STATUSES,
  SYNC_PROJECTIONS,
  SYNC_PROTOCOL_VERSIONS,
} from "@hikoutei/contracts/sheets/constants.js";
import {
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "@hikoutei/contracts/sheets/errors.js";
import {
  requireSyncSheetsNonEmptyList,
  requireSyncSheetsNonNegativeSafeInteger,
  requireSyncSheetsPositiveSafeInteger,
  requireSyncProjectionKind,
  requireSyncSheetsText,
} from "@hikoutei/contracts/sheets/validation.js";

const FAKE_EFFECT_KINDS = {
  SYSTEM_PROJECTION: "system_projection",
  CANDIDATE_RECONCILE: "candidate_reconcile",
  SYSTEM_REPAIR: "system_repair",
  RESOLUTION_PROJECTION: "resolution_projection",
  RESOLUTION_DELETE: SYNC_DELETE_EFFECT_KINDS.RESOLUTION_DELETE,
  USER_INPUT_DELETE: SYNC_DELETE_EFFECT_KINDS.USER_INPUT_DELETE,
} as const satisfies Record<string, EffectKind>;

const EMPTY_VISIBLE_HASH = "" as const;

export const FAKE_SYNC_SHEETS_ERROR_CODES = {
  RESPONSE_LOST_AFTER_APPLY: "response_lost_after_apply",
} as const;

type FakeSyncSheetsErrorCode =
  (typeof FAKE_SYNC_SHEETS_ERROR_CODES)[keyof typeof FAKE_SYNC_SHEETS_ERROR_CODES];

/** Initial state for one fake projection row. */
export interface FakeSyncRowInput {
  readonly targetId: string;
  /** `null` models a row without physical anchor assignment (fast append). */
  readonly physicalAnchor?: string | null;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly visibleRevision?: number;
  readonly activeCandidateHash?: Applicability<string>;
}

/** Initial state for one registered fake projection sheet. */
export interface FakeSyncSheetInput {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  /** Business-key header used to find rows appended without physical metadata. */
  readonly identityField?: string;
  readonly rows?: readonly FakeSyncRowInput[];
}

/** Optional deterministic fault controls for a fake provider. */
export interface FakeSyncProviderOptions {
  /** Return only this many results per apply call, after applying that prefix. */
  readonly maxEffectsPerApply?: number;
  /**
   * Permit two rows to share one physical anchor in initial sheet state so
   * tests can prove fail-closed reconciliation. Defaults to false: the fake
   * rejects duplicate anchors exactly like the real provider.
   */
  readonly allowDuplicateAnchors?: boolean;
  /**
   * Emit snapshots with the real provider's shape: visibleRevision and
   * visibleHash are ABSENT on every snapshot row (the real provider leaves
   * visible state to SQLite). Defaults to false for source compatibility
   * with fixtures that assert the legacy present shape.
   */
  readonly realProviderSnapshotShape?: boolean;
}

interface FakeRow {
  readonly targetId: string;
  /** Mutable like the real provider's system-column cell: anchor assignment rewrites it. */
  anchor: string;
  physicalAnchorPresent: boolean;
  fields: Record<string, NormalizedCell>;
  visibleRevision: number;
  visibleHash: string;
  activeCandidateHash: Applicability<string>;
}

interface FakeSheet {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  readonly identityField: string | undefined;
  readonly rowsByAnchor: Map<string, FakeRow[]>;
}

interface Receipt {
  readonly payloadHash: string;
  readonly targetVisibleHash: string;
  readonly visibleRevision: number;
}

/** Error intentionally thrown after a remote write has already completed. */
export class FakeSyncResponseLossError extends CoreErrorException<
  "runtime.fake_sync_provider",
  FakeSyncSheetsErrorCode
> {
  public constructor() {
    super(
      "runtime.fake_sync_provider",
      FAKE_SYNC_SHEETS_ERROR_CODES.RESPONSE_LOST_AFTER_APPLY,
      "Fake provider dropped the response after applying remote effects.",
    );
  }
}

/**
 * Fake provider with explicit response-loss and partial-batch injection.
 *
 * `dropNextResponseAfterApply()` is intentionally one-shot: the next call
 * writes and records receipts before its caller observes a transport failure.
 */
export class FakeSyncSheetsProvider implements SyncSheetsProvider {
  private readonly sheets = new Map<string, FakeSheet>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly maxEffectsPerApply: Presence<number>;
  private readonly allowDuplicateAnchors: boolean;
  private readonly realProviderSnapshotShape: boolean;
  private anchorSequence = 0;
  private dropResponse = false;
  private snapshotReadError: Error | undefined;
  private postconditionBatchReadCount = 0;
  public tableReadBatchCount = 0;
  public snapshotReadCount = 0;
  private fastAppendCallCount = 0;
  private applyEffectsCallCount = 0;
  private lastApplyPostconditionMode: ApplySyncEffectsRequest["postconditionMode"] | undefined;

  public constructor(inputs: readonly FakeSyncSheetInput[], options: FakeSyncProviderOptions = {}) {
    this.maxEffectsPerApply = options.maxEffectsPerApply === undefined
      ? absentValue()
      : presentValue(requireSyncSheetsPositiveSafeInteger(
        options.maxEffectsPerApply,
        "fake provider maxEffectsPerApply",
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
      ));
    this.allowDuplicateAnchors = options.allowDuplicateAnchors === true;
    this.realProviderSnapshotShape = options.realProviderSnapshotShape === true;
    for (const input of inputs) this.addSheet(input);
  }

  /** Injects exactly one transport failure after the next successful remote apply. */
  public dropNextResponseAfterApply(): void {
    this.dropResponse = true;
  }

  /** Makes subsequent snapshot reads throw until {@link clearSnapshotReadFailure}. */
  public failSnapshotReads(error: Error): void {
    this.snapshotReadError = error;
  }

  /** Clears an injected snapshot-read failure. */
  public clearSnapshotReadFailure(): void {
    this.snapshotReadError = undefined;
  }

  /** Simulates a user/collaborator edit without creating an effect receipt. */
  public mutateRow(
    physicalSheetId: string,
    anchor: string,
    fields: Readonly<Record<string, NormalizedCell>>,
    activeCandidateHash: Applicability<string> = notApplicableValue(),
  ): void {
    const sheet = this.requireSheet(physicalSheetId);
    const row = this.requireRow(sheet, anchor);
    row.fields = { ...fields };
    row.visibleHash = computeSyncVisibleHash(row.fields);
    row.visibleRevision += 1;
    row.activeCandidateHash = activeCandidateHash;
  }

  /** Simulates a structural row disappearance without asserting delete evidence. */
  public removeRow(physicalSheetId: string, anchor: string): void {
    const sheet = this.requireSheet(physicalSheetId);
    if (!sheet.rowsByAnchor.delete(anchor)) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        `fake row anchor does not exist: ${anchor}`,
      );
    }
  }

  /**
   * Simulates a remote row reappearing without an effect receipt.
   *
   * Mirrors the row shape a create-if-missing write leaves behind (anchored,
   * revision 1), so snapshot reads observe the row while the outbox still
   * treats the write that produced it as in flight (delivery-uncertain).
   */
  public restoreRow(
    physicalSheetId: string,
    anchor: string,
    targetId: string,
    fields: Readonly<Record<string, NormalizedCell>>,
  ): void {
    const sheet = this.requireSheet(physicalSheetId);
    if (this.findRowByAnchorOrIdentity(sheet, anchor, targetId).kind === LOOKUP_RESULT_KINDS.FOUND) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        `fake row already exists at ${anchor} for ${targetId}`,
      );
    }
    const bucket = sheet.rowsByAnchor.get(anchor) ?? [];
    bucket.push({
      targetId,
      anchor,
      physicalAnchorPresent: true,
      fields: { ...fields },
      visibleRevision: 1,
      visibleHash: computeSyncVisibleHash(fields),
      activeCandidateHash: notApplicableValue(),
    });
    sheet.rowsByAnchor.set(anchor, bucket);
  }

  /** Simulates a manual deletion of an anchorless fast-appended row. */
  public removeRowByIdentity(physicalSheetId: string, identity: string): void {
    const sheet = this.requireSheet(physicalSheetId);
    const matches = fakeRows(sheet).filter((row) =>
      normalizedCellIdentity(row.fields[sheet.identityField as string]) === identity);
    const match = matches[0];
    if (match === undefined || matches.length > 1) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        `fake row identity does not exist or is ambiguous: ${identity}`,
      );
    }
    sheet.rowsByAnchor.delete(match.anchor);
  }

  /** Returns a copy of a fake row for assertions without exposing mutable state. */
  public readRow(physicalSheetId: string, anchor: string): FakeSyncRowInput & { readonly visibleHash: string } {
    const row = this.requireRow(this.requireSheet(physicalSheetId), anchor);
    return {
      targetId: row.targetId,
      physicalAnchor: row.anchor,
      fields: { ...row.fields },
      visibleRevision: row.visibleRevision,
      activeCandidateHash: row.activeCandidateHash,
      visibleHash: row.visibleHash,
    };
  }

  public async ensureRowAnchors(request: EnsureSyncRowAnchorsRequest): Promise<EnsureSyncRowAnchorsResult> {
    const sheet = this.requireMatchingSheet(request);
    // Mirror the real provider's anchor pass: only user_input tabs carry the
    // system row-id column, so only their unanchored rows are assigned fresh
    // sync-anchor values (system_state and sync_conflicts rows are
    // identity-located and never anchored; the real planRowAnchors returns
    // zeros for them). Duplicated anchors are reported as evidence, never
    // rewritten.
    if (sheet.projection !== SYNC_PROJECTIONS.USER_INPUT) {
      return { assigned: 0, existing: 0, duplicateAnchors: [] };
    }
    const rows = fakeRows(sheet);
    const anchors: string[] = [];
    let assigned = 0;
    let existing = 0;
    for (const row of rows) {
      if (!row.physicalAnchorPresent) {
        const anchor = this.nextAnchorWithPrefix();
        sheet.rowsByAnchor.delete(row.anchor);
        row.anchor = anchor;
        row.physicalAnchorPresent = true;
        sheet.rowsByAnchor.set(anchor, [row]);
        anchors.push(anchor);
        assigned += 1;
        continue;
      }
      anchors.push(row.anchor);
      existing += 1;
    }
    return {
      assigned,
      existing,
      duplicateAnchors: groupDuplicateAnchors(anchors),
    };
  }

  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncSheetsSnapshot> {
    if (this.snapshotReadError !== undefined) throw this.snapshotReadError;
    this.snapshotReadCount += 1;
    const sheet = this.requireMatchingSheet(request);
    const rows = fakeRows(sheet)
      .sort((left, right) => left.anchor.localeCompare(right.anchor))
      .map((row, index) => this.toSnapshotRow(sheet, row, index + 2));
    const snapshotPayload = {
      protocolVersion: SYNC_PROTOCOL_VERSIONS.V1,
      sheetName: sheet.sheetName,
      registeredRange: sheet.registeredRange,
      projection: sheet.projection,
      schemaVersion: sheet.schemaVersion,
      headers: sheet.headers,
      rows,
    };
    return {
      ...snapshotPayload,
      snapshotHash: stableHash({
        protocolVersion: snapshotPayload.protocolVersion,
        sheetName: snapshotPayload.sheetName,
        registeredRange: snapshotPayload.registeredRange,
        projection: snapshotPayload.projection,
        schemaVersion: snapshotPayload.schemaVersion,
        headers: [...snapshotPayload.headers],
        rows: rows.map((row) => ({
          rowNumber: row.rowNumber,
          physicalAnchor: row.physicalAnchor,
          visibleRevision: row.visibleRevision,
          visibleHash: row.visibleHash,
          cells: Object.fromEntries(Object.entries(row.cells).map(([fieldName, cell]) => [
            fieldName,
            cell.normalizedCell,
          ])),
        })),
      }),
      unanchoredRows: rows
        .filter((row) => row.physicalAnchor.kind === PRESENCE_KINDS.ABSENT)
        .map((row) => row.rowNumber),
      duplicateAnchors: groupDuplicateAnchors(rows.flatMap((row) =>
        row.physicalAnchor.kind === PRESENCE_KINDS.PRESENT
          ? [row.physicalAnchor.value]
          : [],
      )),
    };
  }

  /** Reads fake literal values without metadata, matching the fast polling capability. */
  public async readRows(request: ReadSyncTableRowsRequest): Promise<SyncTableRowsResult> {
    const [result] = await this.readRowsBatch([request]);
    if (result === undefined) throw new Error("fake table read returned no result");
    return result;
  }

  /** Reads several fake tables without mutating anchors, receipts, or revisions. */
  public async readRowsBatch(
    requests: readonly ReadSyncTableRowsRequest[],
  ): Promise<readonly SyncTableRowsResult[]> {
    this.tableReadBatchCount += 1;
    return requests.map((request) => {
      const sheet = this.requireMatchingSheet(request);
      return {
        sheetName: sheet.sheetName,
        registeredRange: sheet.registeredRange,
        headers: sheet.headers,
        rows: fakeRows(sheet)
          .sort((left, right) => left.anchor.localeCompare(right.anchor))
          .map((row, index) => ({
            rowNumber: index + 2,
            fields: { ...row.fields },
          })),
      };
    });
  }

  public async applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    this.applyEffectsCallCount += 1;
    this.lastApplyPostconditionMode = request.postconditionMode;
    const limit = this.maxEffectsPerApply.kind === PRESENCE_KINDS.PRESENT
      ? this.maxEffectsPerApply.value
      : request.effects.length;
    const selected = request.effects.slice(0, limit);
    // Effects may span multiple tabs after spreadsheet-level route grouping;
    // route each effect to its own registered sheet.
    const results = selected.map((effect) => {
      const sheet = this.requireMatchingSheetForEffect(effect);
      const result = this.applyOne(sheet, effect);
      if (
        request.postconditionMode === SYNC_POSTCONDITION_MODES.DEFERRED &&
        (result.status === SYNC_EFFECT_RESULT_STATUSES.APPLIED ||
          result.status === SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED)
      ) {
        return {
          ...result,
          postcondition: SYNC_POSTCONDITION_STATUSES.ACKNOWLEDGED,
        };
      }
      return result;
    });
    if (this.dropResponse) {
      this.dropResponse = false;
      throw new FakeSyncResponseLossError();
    }
    return {
      results,
      snapshotHash: absentValue(),
      hasMore: selected.length < request.effects.length,
    };
  }

  /** Appends rows without CAS, metadata, or retry deduplication. */
  public async fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    this.fastAppendCallCount += 1;
    const limit = this.maxEffectsPerApply.kind === PRESENCE_KINDS.PRESENT
      ? this.maxEffectsPerApply.value
      : request.rows.length;
    const selected = request.rows.slice(0, limit);
    // Rows may span multiple tabs after dashboard phase route grouping; the
    // route is derived from each row (falling back to the request route).
    const bySheet = new Map<string, { readonly sheet: FakeSheet; readonly rows: FastAppendRow[] }>();
    for (const row of selected) {
      const sheet = this.requireMatchingSheetForRow(request, row);
      const bucket = bySheet.get(sheet.physicalSheetId) ?? { sheet, rows: [] };
      bucket.rows.push(row);
      bySheet.set(sheet.physicalSheetId, bucket);
    }
    const results: FastAppendRowResult[] = [];
    for (const { sheet, rows } of bySheet.values()) {
      const identityField = sheet.identityField;
      if (identityField === undefined) {
        throw new SyncSheetsContractError(
          SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
          `fake fast append requires a registered identityField for sheet ${sheet.physicalSheetId}`,
        );
      }
      // Mirror the built-in append preflight: identity uniqueness is verified
      // for the whole batch before any row is written, so a duplicated identity
      // fails closed without mutating the sheet. Replay entries (already
      // receipted effects) are exempt exactly like the real provider.
      this.assertAppendIdentityAvailability(sheet, identityField, rows);
      results.push(...rows.map((row) => this.fastAppendOne(sheet, row)));
    }
    if (this.dropResponse) {
      this.dropResponse = false;
      throw new FakeSyncResponseLossError();
    }
    return {
      results,
      hasMore: selected.length < request.rows.length,
    };
  }

  public async readEffectPostcondition(effect: SyncProjectionEffect): Promise<SyncEffectPostcondition> {
    const sheetResult = lookupResult(this.sheets.get(effect.physicalSheetId));
    if (sheetResult.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      return unavailablePostcondition();
    }
    const sheet = sheetResult.value;
    const row = this.findRowByAnchorOrIdentity(sheet, effect.payload.targetAnchor, effect.targetId);
    const snapshotHash = presentValue(this.sheetSnapshotHash(sheet));
    const receipt = this.receipts.get(effect.effectId);
    if (isProjectionDeletionEffect(effect.effectKind)) {
      if (receipt !== undefined && receipt.payloadHash !== effect.payloadHash) {
        return changedPostcondition(snapshotHash);
      }
      if (receipt !== undefined && row.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
        return {
          disposition: SYNC_POSTCONDITION_DISPOSITIONS.APPLIED,
          visibleRevision: presentValue(receipt.visibleRevision),
          visibleHash: presentValue(receipt.targetVisibleHash),
          snapshotHash,
        };
      }
      // An absent row without this effect's receipt could be a manual deletion.
      // Never let that absence close an outbox effect after response loss.
      if (row.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
        return {
          disposition: SYNC_POSTCONDITION_DISPOSITIONS.UNAVAILABLE,
          visibleRevision: absentValue(),
          visibleHash: absentValue(),
          snapshotHash,
        };
      }
      const base = {
        visibleRevision: presentValue(row.value.visibleRevision),
        visibleHash: presentValue(row.value.visibleHash),
        snapshotHash,
      };
      if (receipt !== undefined) {
        return { disposition: SYNC_POSTCONDITION_DISPOSITIONS.CHANGED, ...base };
      }
      if (
        row.value.visibleRevision === effect.expectedVisibleRevision &&
        row.value.visibleHash === effect.expectedVisibleHash
      ) {
        return { disposition: SYNC_POSTCONDITION_DISPOSITIONS.UNAPPLIED, ...base };
      }
      return { disposition: SYNC_POSTCONDITION_DISPOSITIONS.CHANGED, ...base };
    }
    if (row.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      return {
        disposition: receipt !== undefined || !effect.payload.createIfMissing
          ? SYNC_POSTCONDITION_DISPOSITIONS.CHANGED
          : SYNC_POSTCONDITION_DISPOSITIONS.UNAPPLIED,
        visibleRevision: absentValue(),
        visibleHash: absentValue(),
        snapshotHash,
      };
    }
    const base = {
      visibleRevision: presentValue(row.value.visibleRevision),
      visibleHash: presentValue(row.value.visibleHash),
      snapshotHash,
    };
    if (row.value.visibleHash === effect.payload.targetVisibleHash) {
      return { disposition: SYNC_POSTCONDITION_DISPOSITIONS.APPLIED, ...base };
    }
    if (row.value.visibleHash === effect.expectedVisibleHash) {
      return { disposition: SYNC_POSTCONDITION_DISPOSITIONS.UNAPPLIED, ...base };
    }
    if (
      effect.effectKind === FAKE_EFFECT_KINDS.SYSTEM_REPAIR &&
      effect.repairGuardHash.kind === PRESENCE_KINDS.PRESENT &&
      row.value.visibleHash === effect.repairGuardHash.value
    ) {
      return { disposition: SYNC_POSTCONDITION_DISPOSITIONS.UNAPPLIED, ...base };
    }
    return { disposition: SYNC_POSTCONDITION_DISPOSITIONS.CHANGED, ...base };
  }

  /** Reads a recovery batch through the same contract as the real provider. */
  public async readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncEffectPostconditionResult[]> {
    this.postconditionBatchReadCount += 1;
    this.requireMatchingSheet(request);
    return Promise.all(request.effects.map(async (effect) => ({
      effectId: effect.effectId,
      payloadHash: effect.payloadHash,
      postcondition: await this.readEffectPostcondition(effect),
    })));
  }

  /** Exposes batch-call count for worker tests without exposing fake internals. */
  public get postconditionBatchReads(): number {
    return this.postconditionBatchReadCount;
  }

  /** Exposes fast-append calls so worker tests can prove routing occurred. */
  public get fastAppendCalls(): number {
    return this.fastAppendCallCount;
  }

  /** Exposes applyEffects calls so worker tests can prove batch-cap dispatch. */
  public get applyEffectsCalls(): number {
    return this.applyEffectsCallCount;
  }

  /** Exposes the last verification mode so worker tests can assert the contract. */
  public get applyPostconditionMode(): ApplySyncEffectsRequest["postconditionMode"] {
    return this.lastApplyPostconditionMode;
  }

  private addSheet(input: FakeSyncSheetInput): void {
    const physicalSheetId = requireSyncSheetsText(
      input.physicalSheetId,
      "fake sheet physicalSheetId",
      SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
    );
    if (this.sheets.has(physicalSheetId)) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        `duplicate fake physical sheet ID: ${physicalSheetId}`,
      );
    }
    const sheetName = requireSyncSheetsText(
      input.sheetName,
      "fake sheet sheetName",
      SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
    );
    const registeredRange = requireSyncSheetsText(
      input.registeredRange,
      "fake sheet registeredRange",
      SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
    );
    const projection = requireSyncProjectionKind(
      input.projection,
      "fake sheet projection",
      SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
    );
    const schemaVersion = requireSyncSheetsPositiveSafeInteger(
      input.schemaVersion,
      "fake sheet schemaVersion",
      SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
    );
    requireSyncSheetsNonEmptyList(
      input.headers,
      "fake sheet headers",
      SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
    );
    const headers = input.headers.map((header, index) =>
      requireSyncSheetsText(
        header,
        `fake sheet headers[${index}]`,
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
      ));
    const rowsByAnchor = new Map<string, FakeRow[]>();
    for (const initial of input.rows ?? []) {
      // `null` marks a row the fake appends/reads without physical anchor
      // assignment, mirroring the built-in append path of the MVP.
      const anchor = initial.physicalAnchor === undefined || initial.physicalAnchor === null
        ? this.nextAnchor()
        : requireSyncSheetsText(
          initial.physicalAnchor,
          "fake row physicalAnchor",
          SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        );
      if (rowsByAnchor.has(anchor) && !this.allowDuplicateAnchors) {
        throw new SyncSheetsContractError(
          SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
          `duplicate fake physical anchor: ${anchor}`,
        );
      }
      const fields = { ...initial.fields };
      const bucket = rowsByAnchor.get(anchor) ?? [];
      bucket.push({
        targetId: requireSyncSheetsText(
          initial.targetId,
          "fake row targetId",
          SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        ),
        anchor,
        physicalAnchorPresent: initial.physicalAnchor !== null,
        fields,
        visibleRevision: initial.visibleRevision === undefined
          ? NON_NEGATIVE_SAFE_INTEGER_MINIMUM
          : requireSyncSheetsNonNegativeSafeInteger(
            initial.visibleRevision,
            "fake row visibleRevision",
            SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
          ),
        visibleHash: computeSyncVisibleHash(fields),
        activeCandidateHash: initial.activeCandidateHash ?? notApplicableValue(),
      });
      rowsByAnchor.set(anchor, bucket);
    }
    this.sheets.set(physicalSheetId, {
      physicalSheetId,
      sheetName,
      registeredRange,
      projection,
      schemaVersion,
      headers,
      // Mirror the real bootstrap defaults: system_state routes register the
      // business key, and sync_conflicts routes always register Conflict_ID.
      identityField: input.identityField ??
        (projection === SYNC_PROJECTIONS.SYSTEM_STATE && headers.includes("id")
          ? "id"
          : projection === SYNC_PROJECTIONS.SYNC_CONFLICTS && headers.includes("Conflict_ID")
            ? "Conflict_ID"
            : undefined),
      rowsByAnchor,
    });
  }

  private fastAppendOne(sheet: FakeSheet, row: FastAppendRow): FastAppendRowResult {
    const payloadHash = row.payloadHash ?? row.effectId;
    const existingReceipt = this.receipts.get(row.effectId);
    if (existingReceipt !== undefined) {
      if (existingReceipt.payloadHash !== payloadHash) {
        throw new Error("fast append effect payload hash mismatch");
      }
      // A lost response is replayed by the same effect ID. The built-in
      // append path ignores the advisory row anchor and never materializes
      // anchor metadata, so the row is located through the registered
      // identity column and fails closed when the identity is missing or
      // ambiguous instead of guessing at a position.
      const existingRow = this.findRowByAnchorOrIdentity(sheet, "", appendTargetId(sheet, row));
      if (existingRow.kind === LOOKUP_RESULT_KINDS.NOT_FOUND ||
          existingRow.value.visibleHash !== existingReceipt.targetVisibleHash) {
        throw new Error("fast append receipt postcondition changed");
      }
      return {
        effectId: row.effectId,
        status: SYNC_FAST_APPEND_STATUSES.APPLIED,
        visibleHash: existingReceipt.targetVisibleHash,
        visibleRevision: existingReceipt.visibleRevision,
      };
    }
    // The built-in append path ignores the advisory row anchor and never
    // materializes a physical anchor (the internal anchor is only a fake
    // storage key), so the row replays by registered identity until
    // observation assigns physical anchors.
    const anchor = this.nextAnchor();
    const fields = { ...row.fields };
    const visibleHash = computeSyncVisibleHash(fields);
    sheet.rowsByAnchor.set(anchor, [{
      targetId: appendTargetId(sheet, row),
      anchor,
      physicalAnchorPresent: false,
      fields,
      visibleRevision: 1,
      visibleHash,
      activeCandidateHash: notApplicableValue(),
    }]);
    this.receipts.set(row.effectId, {
      payloadHash,
      targetVisibleHash: visibleHash,
      visibleRevision: 1,
    });
    return {
      effectId: row.effectId,
      status: SYNC_FAST_APPEND_STATUSES.APPLIED,
      visibleHash,
      visibleRevision: 1,
    };
  }

  /**
   * Mirrors the built-in append identity preflight: the registered identity
   * is required and must be unique across the sheet and the batch, checked
   * before any row is appended. Replay entries (already receipted effects)
   * are exempt from the preflight exactly like the real provider; only
   * unreceipted pending rows participate in the duplicate/missing checks.
   */
  private assertAppendIdentityAvailability(
    sheet: FakeSheet,
    identityField: string,
    rows: readonly FastAppendRow[],
  ): void {
    const existing = new Map<string, string>();
    fakeRows(sheet).forEach((row) => {
      const identity = normalizedCellIdentity(row.fields[identityField]);
      if (identity === undefined) {
        throw new SyncSheetsContractError(
          SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
          `sync identity is missing at fake row ${row.anchor}`,
        );
      }
      const location = existing.get(identity);
      if (location !== undefined) {
        throw new SyncSheetsContractError(
          SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
          `sync identity is duplicated: ${identity} at ${location} and ${row.anchor}`,
        );
      }
      existing.set(identity, row.anchor);
    });
    rows.forEach((row) => {
      // Receipted effects are replays, not pending appends: the real provider
      // skips its identity preflight for them, and so does the fake.
      if (this.receipts.has(row.effectId)) return;
      const identity = normalizedCellIdentity(row.fields[identityField]);
      if (identity === undefined) {
        throw new SyncSheetsContractError(
          SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
          `sync identity is required for append: ${identityField}`,
        );
      }
      const location = existing.get(identity);
      if (location !== undefined) {
        throw new SyncSheetsContractError(
          SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
          `sync identity already exists: ${identity} at ${location}`,
        );
      }
      existing.set(identity, "pending");
    });
  }

  private applyOne(sheet: FakeSheet, effect: SyncProjectionEffect): SyncEffectResult {
    if (effect.physicalSheetId !== sheet.physicalSheetId || effect.projection !== sheet.projection) {
      return this.result(
        effect,
        SYNC_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
        notFoundValue(),
        presentValue("effect targets a different fake sheet"),
      );
    }
    if (
      effect.payload.sheetName !== sheet.sheetName ||
      effect.payload.registeredRange !== sheet.registeredRange ||
      effect.payload.schemaVersion !== sheet.schemaVersion
    ) {
      return this.result(
        effect,
        SYNC_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
        notFoundValue(),
        presentValue("effect payload does not match registered sheet"),
      );
    }
    if (computeSyncVisibleHash(effect.payload.fields) !== effect.payload.targetVisibleHash) {
      return this.result(
        effect,
        SYNC_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
        notFoundValue(),
        presentValue("effect target hash does not match fields"),
      );
    }
    const deletionShapeError = this.projectionDeleteShapeError(sheet, effect);
    if (deletionShapeError.kind === PRESENCE_KINDS.PRESENT) {
      return this.result(
        effect,
        SYNC_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
        notFoundValue(),
        deletionShapeError,
      );
    }

    const receipt = this.receipts.get(effect.effectId);
    if (receipt !== undefined) {
      if (receipt.payloadHash !== effect.payloadHash) {
        return this.result(
          effect,
          SYNC_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
          notFoundValue(),
          presentValue("effect ID was reused with another payload"),
        );
      }
      const row = this.findRowByAnchorOrIdentity(sheet, effect.payload.targetAnchor, effect.targetId);
      if (isProjectionDeletionEffect(effect.effectKind)) {
        if (row.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
          return this.result(
            effect,
            SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED,
            row,
            absentValue(),
            receipt,
          );
        }
        return this.result(
          effect,
          SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
          row,
          presentValue("receipt_target_reappeared"),
        );
      }
      if (
        row.kind === LOOKUP_RESULT_KINDS.NOT_FOUND ||
        row.value.visibleRevision !== receipt.visibleRevision ||
        row.value.visibleHash !== receipt.targetVisibleHash ||
        row.value.visibleHash !== effect.payload.targetVisibleHash
      ) {
        return this.result(
          effect,
          effect.effectKind === FAKE_EFFECT_KINDS.SYSTEM_REPAIR
            ? SYNC_EFFECT_RESULT_STATUSES.REPAIR_REOBSERVE
            : SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
          row,
          presentValue("receipt_postcondition_changed"),
        );
      }
      return this.result(
        effect,
        SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED,
        row,
        absentValue(),
      );
    }

    const existingRow = this.findRowByAnchorOrIdentity(sheet, effect.payload.targetAnchor, effect.targetId);
    let row: FakeRow;
    if (existingRow.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      if (!effect.payload.createIfMissing) {
        return this.result(
          effect,
          SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
          existingRow,
          presentValue("target anchor is missing"),
        );
      }
      if (
        effect.expectedVisibleRevision !== NON_NEGATIVE_SAFE_INTEGER_MINIMUM ||
        effect.expectedVisibleHash !== EMPTY_VISIBLE_HASH
      ) {
        return this.result(
          effect,
          SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
          existingRow,
          presentValue("insert requires an empty visible baseline"),
        );
      }
      row = {
        targetId: effect.targetId,
        anchor: effect.payload.targetAnchor,
        physicalAnchorPresent: true,
        fields: {},
        visibleRevision: NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
        visibleHash: EMPTY_VISIBLE_HASH,
        activeCandidateHash: notApplicableValue(),
      };
      sheet.rowsByAnchor.set(row.anchor, [row]);
    } else {
      row = existingRow.value;
    }

    if (isProjectionDeletionEffect(effect.effectKind)) {
      // The real provider's deletion CAS is hash-only (the expected visible
      // revision is echoed into the receipt but never gates the mutation), so
      // the fake must not reject on a revision mismatch either.
      if (row.visibleHash !== effect.expectedVisibleHash) {
        return this.result(
          effect,
          SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
          foundValue(row),
          presentValue("visible_guard_mismatch"),
        );
      }
      if (
        effect.effectKind === FAKE_EFFECT_KINDS.USER_INPUT_DELETE &&
        row.activeCandidateHash.kind === APPLICABILITY_KINDS.APPLICABLE
      ) {
        return this.result(
          effect,
          SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
          foundValue(row),
          presentValue("active_candidate_preserved"),
        );
      }
      const deletionReceipt: Receipt = {
        payloadHash: effect.payloadHash,
        targetVisibleHash: effect.payload.targetVisibleHash,
        // Echo the effect's expected revision exactly like the real
        // provider's deletion receipt (makeReceipt with the expected
        // revision), so the confirmation mirror sees the same evidence.
        visibleRevision: effect.expectedVisibleRevision,
      };
      // A duplicated anchor bucket resolves to its first row; only that row
      // is deleted, so the remaining rows become resolvable on later passes
      // exactly like the real provider's anchor index.
      const bucket = sheet.rowsByAnchor.get(row.anchor);
      if (bucket !== undefined && bucket.length > 1) {
        bucket.shift();
      } else {
        sheet.rowsByAnchor.delete(row.anchor);
      }
      this.receipts.set(effect.effectId, deletionReceipt);
      return this.result(
        effect,
        SYNC_EFFECT_RESULT_STATUSES.APPLIED,
        notFoundValue(),
        absentValue(),
        deletionReceipt,
      );
    }

    if (
      effect.effectKind === FAKE_EFFECT_KINDS.CANDIDATE_RECONCILE &&
      row.activeCandidateHash.kind === APPLICABILITY_KINDS.APPLICABLE
    ) {
      if (!sameApplicability(effect.payload.expectedCandidateHash, row.activeCandidateHash)) {
        return this.result(
          effect,
          SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
          foundValue(row),
          presentValue("candidate_guard_mismatch"),
        );
      }
      return this.result(
        effect,
        SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
        foundValue(row),
        presentValue("active_candidate_preserved"),
      );
    }

    if (row.visibleHash === effect.payload.targetVisibleHash) {
      const receipt: Receipt = {
        payloadHash: effect.payloadHash,
        targetVisibleHash: effect.payload.targetVisibleHash,
        // Echo expected + 1 exactly like the real provider's already-applied
        // receipt.
        visibleRevision: effect.expectedVisibleRevision + 1,
      };
      this.receipts.set(effect.effectId, receipt);
      return this.result(
        effect,
        SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED,
        foundValue(row),
        absentValue(),
        receipt,
      );
    }

    if (effect.effectKind === FAKE_EFFECT_KINDS.SYSTEM_REPAIR) {
      if (
        effect.repairGuardHash.kind !== PRESENCE_KINDS.PRESENT ||
        row.visibleHash !== effect.repairGuardHash.value
      ) {
        return this.result(
          effect,
          SYNC_EFFECT_RESULT_STATUSES.REPAIR_REOBSERVE,
          foundValue(row),
          presentValue("repair_guard_mismatch"),
        );
      }
    } else if (row.visibleHash !== effect.expectedVisibleHash) {
      // The real provider's write CAS is hash-only; the expected visible
      // revision is never compared remotely, so the fake must not reject on
      // a revision mismatch either (rows with write history carry higher
      // revisions than a fresh snapshot fallback).
      return this.result(
        effect,
        SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
        foundValue(row),
        presentValue("visible_guard_mismatch"),
      );
    }

    row.fields = { ...effect.payload.fields };
    row.visibleHash = effect.payload.targetVisibleHash;
    row.visibleRevision += 1;
    if (effect.effectKind === FAKE_EFFECT_KINDS.RESOLUTION_PROJECTION) {
      row.activeCandidateHash = notApplicableValue();
    }
    const writeReceipt: Receipt = {
      payloadHash: effect.payloadHash,
      targetVisibleHash: effect.payload.targetVisibleHash,
      // Echo expected + 1 exactly like the real provider's write receipt
      // (makeReceipt with expectedVisibleRevision + 1).
      visibleRevision: effect.expectedVisibleRevision + 1,
    };
    this.receipts.set(effect.effectId, writeReceipt);
    return this.result(
      effect,
      SYNC_EFFECT_RESULT_STATUSES.APPLIED,
      foundValue(row),
      absentValue(),
      writeReceipt,
    );
  }

  /** Rejects broad or ambiguous delete effects before an anchor is ever removed. */
  private projectionDeleteShapeError(
    sheet: FakeSheet,
    effect: SyncProjectionEffect,
  ): Presence<string> {
    if (!isProjectionDeletionEffect(effect.effectKind)) {
      return absentValue();
    }
    const expectedProjection = effect.effectKind === FAKE_EFFECT_KINDS.RESOLUTION_DELETE
      ? SYNC_PROJECTIONS.SYNC_CONFLICTS
      : SYNC_PROJECTIONS.USER_INPUT;
    const errorPrefix = effect.effectKind === FAKE_EFFECT_KINDS.RESOLUTION_DELETE
      ? "resolution_delete"
      : "user_input_delete";
    if (
      effect.projection !== expectedProjection ||
      effect.payload.createIfMissing ||
      effect.expectedVisibleRevision < POSITIVE_SAFE_INTEGER_MINIMUM ||
      effect.payload.targetVisibleHash !== effect.expectedVisibleHash
    ) {
      return presentValue(`invalid_${errorPrefix}_guard`);
    }
    const actualFields = Object.keys(effect.payload.fields).sort();
    const expectedFields = [...sheet.headers].sort();
    if (
      actualFields.length !== expectedFields.length ||
      actualFields.some((fieldName, index) => fieldName !== expectedFields[index])
    ) {
      return presentValue(`${errorPrefix}_requires_full_row`);
    }
    return absentValue();
  }

  private result(
    effect: SyncProjectionEffect,
    status: SyncEffectResult["status"],
    row: LookupResult<FakeRow>,
    reason: Presence<string>,
    receipt?: Receipt,
  ): SyncEffectResult {
    const sheet = lookupResult(this.sheets.get(effect.physicalSheetId));
    return {
      effectId: effect.effectId,
      payloadHash: effect.payloadHash,
      status,
      visibleRevision: receipt !== undefined
        ? presentValue(receipt.visibleRevision)
        : row.kind === LOOKUP_RESULT_KINDS.FOUND
          ? presentValue(row.value.visibleRevision)
          : absentValue(),
      visibleHash: receipt !== undefined
        ? presentValue(receipt.targetVisibleHash)
        : row.kind === LOOKUP_RESULT_KINDS.FOUND
          ? presentValue(row.value.visibleHash)
          : absentValue(),
      snapshotHash: sheet.kind === LOOKUP_RESULT_KINDS.FOUND
        ? presentValue(this.sheetSnapshotHash(sheet.value))
        : absentValue(),
      reason,
      postcondition: receipt !== undefined || row.kind === LOOKUP_RESULT_KINDS.FOUND
        ? SYNC_POSTCONDITION_STATUSES.VERIFIED
        : SYNC_POSTCONDITION_STATUSES.UNAVAILABLE,
    };
  }

  private toSnapshotRow(sheet: FakeSheet, row: FakeRow, rowNumber: number): SyncSnapshotRow {
    const cells: Record<string, SyncSnapshotCell> = {};
    for (const header of sheet.headers) {
      const value = row.fields[header];
      const normalizedCell = value ?? null;
      cells[header] = normalizedCell === null
        ? {
          cellKind: CELL_OBSERVATION_KINDS.BLANK,
          normalizedCell: null,
          formulaHash: absentValue(),
          mergeRange: absentValue(),
          errorCode: absentValue(),
          stableHash: presentValue(stableHash(null)),
        }
        : {
          cellKind: CELL_OBSERVATION_KINDS.LITERAL,
          normalizedCell,
          formulaHash: absentValue(),
          mergeRange: absentValue(),
          errorCode: absentValue(),
          stableHash: presentValue(stableHash(normalizedCell)),
        };
    }
    return {
      rowNumber,
      physicalAnchor: row.physicalAnchorPresent
        ? presentValue(row.anchor)
        : absentValue(),
      visibleRevision: this.realProviderSnapshotShape
        ? absentValue()
        : presentValue(row.visibleRevision),
      visibleHash: this.realProviderSnapshotShape
        ? absentValue()
        : presentValue(row.visibleHash),
      cells,
    };
  }

  private requireSheet(physicalSheetId: string): FakeSheet {
    const sheet = lookupResult(this.sheets.get(physicalSheetId));
    if (sheet.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        `unknown fake physical sheet: ${physicalSheetId}`,
      );
    }
    return sheet.value;
  }

  /** Finds a row by anchor first, then by the registered business key. */
  private findRowByAnchorOrIdentity(
    sheet: FakeSheet,
    anchor: string,
    targetId: string,
  ): LookupResult<FakeRow> {
    const bucket = sheet.rowsByAnchor.get(anchor);
    if (bucket !== undefined) {
      // Mirrors the real provider's indexRows first-wins rule: only the FIRST
      // row per anchor value enters the anchor index (duplicated anchors are
      // evidence, never rewritten), so a duplicated anchor resolves
      // deterministically instead of drifting to the last row carrying it.
      const anchored = lookupResult(bucket[0]);
      if (anchored.kind === LOOKUP_RESULT_KINDS.FOUND || sheet.identityField === undefined) {
        return anchored;
      }
    }
    if (sheet.identityField === undefined) return notFoundValue();
    const matches = fakeRows(sheet).filter((row) =>
      normalizedCellIdentity(row.fields[sheet.identityField as string]) === targetId,
    );
    if (matches.length === 0) {
      // Mirror the real provider's findWorkingRow contract: entity target IDs
      // carry the full entity id (`entity:<logical>:<id>`) while fast-appended
      // rows are indexed only by their visible business key, so the targetId
      // tail is the second identity fallback before failing closed.
      const separator = targetId.lastIndexOf(":");
      if (separator >= 0) {
        const visibleIdentity = targetId.slice(separator + 1);
        if (visibleIdentity.length > 0) {
          matches.push(...fakeRows(sheet).filter((row) =>
            normalizedCellIdentity(row.fields[sheet.identityField as string]) === visibleIdentity,
          ));
        }
      }
    }
    if (matches.length > 1) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        `fake sync identity is duplicated: ${targetId}`,
      );
    }
    if (matches[0] !== undefined) {
      return { kind: LOOKUP_RESULT_KINDS.FOUND, value: matches[0] };
    }
    // Mirror the real provider's fallback: canonical target ids are
    // namespaced (`entity:<entity>:<visibleId>`), so a row re-created by the
    // append path (which never materializes anchor metadata) is located by
    // the visible identity tail of the target id.
    const separator = targetId.lastIndexOf(":");
    const visibleIdentity = separator >= 0 ? targetId.slice(separator + 1) : targetId;
    const tailMatches = fakeRows(sheet).filter((row) =>
      normalizedCellIdentity(row.fields[sheet.identityField as string]) === visibleIdentity,
    );
    if (tailMatches.length > 1) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        `fake sync identity is duplicated: ${visibleIdentity}`,
      );
    }
    return tailMatches[0] === undefined
      ? notFoundValue()
      : { kind: LOOKUP_RESULT_KINDS.FOUND, value: tailMatches[0] };
  }

  private requireRow(sheet: FakeSheet, anchor: string): FakeRow {
    const row = lookupResult(firstFakeRow(sheet, anchor));
    if (row.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        `fake row anchor does not exist: ${anchor}`,
      );
    }
    return row.value;
  }

  private requireMatchingSheet(request: EnsureSyncRowAnchorsRequest): FakeSheet {
    const sheet = this.requireSheet(request.physicalSheetId);
    if (
      sheet.sheetName !== request.sheetName ||
      sheet.registeredRange !== request.registeredRange ||
      sheet.projection !== request.projection ||
      sheet.schemaVersion !== request.schemaVersion
    ) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        "fake provider request does not match registered sheet",
      );
    }
    return sheet;
  }

  /** Routes one effect to its own registered sheet (multi-tab apply). */
  private requireMatchingSheetForEffect(effect: SyncProjectionEffect): FakeSheet {
    const sheet = this.requireSheet(effect.physicalSheetId);
    if (
      sheet.sheetName !== effect.payload.sheetName ||
      sheet.registeredRange !== effect.payload.registeredRange ||
      sheet.projection !== effect.projection ||
      sheet.schemaVersion !== effect.payload.schemaVersion
    ) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        "fake provider effect does not match registered sheet",
      );
    }
    return sheet;
  }

  /** Routes one append row to its own sheet (multi-tab fast append). */
  private requireMatchingSheetForRow(request: FastAppendRowsRequest, row: FastAppendRow): FakeSheet {
    const physicalSheetId = row.physicalSheetId ?? request.physicalSheetId;
    const sheet = this.requireSheet(physicalSheetId);
    if (
      sheet.sheetName !== (row.sheetName ?? request.sheetName) ||
      sheet.registeredRange !== (row.registeredRange ?? request.registeredRange) ||
      sheet.projection !== (row.projection ?? request.projection) ||
      sheet.schemaVersion !== (row.schemaVersion ?? request.schemaVersion)
    ) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_FAKE_PROVIDER_INPUT,
        "fake provider row does not match registered sheet",
      );
    }
    return sheet;
  }

  private sheetSnapshotHash(sheet: FakeSheet): string {
    return stableHash({
      sheetName: sheet.sheetName,
      registeredRange: sheet.registeredRange,
      projection: sheet.projection,
      schemaVersion: sheet.schemaVersion,
      rows: fakeRows(sheet)
        .sort((left, right) => left.anchor.localeCompare(right.anchor))
        .map((row) => ({
          targetId: row.targetId,
          anchor: row.anchor,
          fields: row.fields,
          visibleRevision: row.visibleRevision,
          visibleHash: row.visibleHash,
          activeCandidateHash: toStableApplicability(row.activeCandidateHash),
        })),
    });
  }

  private nextAnchor(): string {
    this.anchorSequence += 1;
    return "fake-anchor:" + this.anchorSequence;
  }

  /** Mirrors the real provider's observation-assigned anchor format. */
  private nextAnchorWithPrefix(): string {
    this.anchorSequence += 1;
    return "sync-anchor:" + this.anchorSequence;
  }
}

function normalizedCellIdentity(cell: NormalizedCell | undefined): string | undefined {
  if (cell === undefined || cell === null) return undefined;
  if (typeof cell.value === "string") return cell.value.length === 0 ? undefined : cell.value;
  if (typeof cell.value === "number") return Number.isFinite(cell.value) ? String(cell.value) : undefined;
  if (typeof cell.value === "boolean") return String(cell.value);
  return undefined;
}

/** All rows of one fake sheet, including rows that share a physical anchor. */
function fakeRows(sheet: FakeSheet): FakeRow[] {
  return [...sheet.rowsByAnchor.values()].flat();
}

/** Derives the fake row's target id exactly like the built-in append path. */
function appendTargetId(sheet: FakeSheet, row: FastAppendRow): string {
  const identityField = sheet.identityField;
  return identityField === undefined
    ? row.effectId
    : String(row.fields[identityField]?.value ?? row.effectId);
}

/** First row claiming an anchor; duplicates are only reachable via {@link fakeRows}. */
function firstFakeRow(sheet: FakeSheet, anchor: string): FakeRow | undefined {
  return sheet.rowsByAnchor.get(anchor)?.[0];
}

function presentValue<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function absentValue<T>(): Presence<T> {
  return { kind: PRESENCE_KINDS.ABSENT };
}

function notApplicableValue<T>(): Applicability<T> {
  return { kind: APPLICABILITY_KINDS.NOT_APPLICABLE };
}

function lookupResult<T>(value: T | undefined): LookupResult<T> {
  return value === undefined
    ? notFoundValue()
    : foundValue(value);
}

function foundValue<T>(value: T): LookupResult<T> {
  return { kind: LOOKUP_RESULT_KINDS.FOUND, value };
}

function notFoundValue<T>(): LookupResult<T> {
  return { kind: LOOKUP_RESULT_KINDS.NOT_FOUND };
}

function sameApplicability<T>(left: Applicability<T>, right: Applicability<T>): boolean {
  if (
    left.kind !== APPLICABILITY_KINDS.APPLICABLE ||
    right.kind !== APPLICABILITY_KINDS.APPLICABLE
  ) {
    return left.kind === right.kind;
  }
  return left.value === right.value;
}

function isProjectionDeletionEffect(effectKind: EffectKind): boolean {
  return effectKind === FAKE_EFFECT_KINDS.RESOLUTION_DELETE ||
    effectKind === FAKE_EFFECT_KINDS.USER_INPUT_DELETE;
}

function toStableApplicability(
  value: Applicability<string>,
): Readonly<Record<string, string>> {
  return value.kind === APPLICABILITY_KINDS.APPLICABLE
    ? { kind: value.kind, value: value.value }
    : { kind: value.kind };
}

function unavailablePostcondition(): SyncEffectPostcondition {
  return {
    disposition: SYNC_POSTCONDITION_DISPOSITIONS.UNAVAILABLE,
    visibleRevision: absentValue(),
    visibleHash: absentValue(),
    snapshotHash: absentValue(),
  };
}

function changedPostcondition(snapshotHash: Presence<string>): SyncEffectPostcondition {
  return {
    disposition: SYNC_POSTCONDITION_DISPOSITIONS.CHANGED,
    visibleRevision: absentValue(),
    visibleHash: absentValue(),
    snapshotHash,
  };
}

function groupDuplicateAnchors(anchors: readonly string[]): readonly {
  readonly anchor: string;
  readonly rowNumbers: readonly number[];
}[] {
  const grouped = new Map<string, number[]>();
  anchors.forEach((anchor, index) => {
    const rows = grouped.get(anchor) ?? [];
    rows.push(index + 2);
    grouped.set(anchor, rows);
  });
  return [...grouped.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([anchor, rowNumbers]) => ({ anchor, rowNumbers }));
}
