/**
 * In-memory implementation of the sync gateway contract.
 *
 * It deliberately models the safety boundary of the regular path and the
 * append-only behavior of the fast path: visible compare-and-set, effect-id
 * receipts, read-back after response loss, and bounded partial batches. Tests
 * can therefore prove outbox behavior without a network call or a Sheet.
 */

import {
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  stableHash,
  type Applicability,
  type EffectKind,
  type LookupResult,
  type NormalizedCell,
  type Presence,
} from "../../src/domain/index.js";
import { CELL_OBSERVATION_KINDS } from "../../src/shared/encoding/constants.js";
import {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "../../src/shared/state/index.js";
import { CoreErrorException } from "../../src/domain/errors/index.js";
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
  type SyncEffectPostcondition,
  type SyncGatewayEffect,
  type SyncGatewayEffectPostconditionResult,
  type SyncGatewayEffectResult,
  type SyncGatewaySnapshot,
  type SyncProjection,
  type SyncSheetGateway,
  type SyncSnapshotCell,
  type SyncSnapshotRow,
} from "../../src/application/sync/gateway/syncGateway.js";
import {
  SYNC_GATEWAY_EFFECT_KINDS,
  SYNC_GATEWAY_EFFECT_RESULT_STATUSES,
  SYNC_GATEWAY_FAST_APPEND_STATUSES,
  SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS,
  SYNC_GATEWAY_POSTCONDITION_MODES,
  SYNC_GATEWAY_POSTCONDITION_STATUSES,
  SYNC_GATEWAY_PROJECTIONS,
  SYNC_GATEWAY_PROTOCOL_VERSIONS,
} from "../../src/application/sync/gateway/constants.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "../../src/application/sync/gateway/errors.js";
import {
  requireSyncGatewayNonEmptyList,
  requireSyncGatewayNonNegativeSafeInteger,
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayProjection,
  requireSyncGatewayText,
} from "../../src/application/sync/gateway/validation.js";

const FAKE_EFFECT_KINDS = {
  SYSTEM_PROJECTION: "system_projection",
  CANDIDATE_RECONCILE: "candidate_reconcile",
  SYSTEM_REPAIR: "system_repair",
  RESOLUTION_PROJECTION: "resolution_projection",
  RESOLUTION_DELETE: SYNC_GATEWAY_EFFECT_KINDS.RESOLUTION_DELETE,
  USER_INPUT_DELETE: SYNC_GATEWAY_EFFECT_KINDS.USER_INPUT_DELETE,
} as const satisfies Record<string, EffectKind>;

const EMPTY_VISIBLE_HASH = "" as const;

export const FAKE_SYNC_GATEWAY_ERROR_CODES = {
  RESPONSE_LOST_AFTER_APPLY: "response_lost_after_apply",
} as const;

type FakeSyncGatewayErrorCode =
  (typeof FAKE_SYNC_GATEWAY_ERROR_CODES)[keyof typeof FAKE_SYNC_GATEWAY_ERROR_CODES];

/** Initial state for one fake projection row. */
export interface FakeSyncRowInput {
  readonly targetId: string;
  readonly physicalAnchor?: string;
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

/** Optional deterministic fault controls for a fake gateway. */
export interface FakeSyncGatewayOptions {
  /** Return only this many results per apply call, after applying that prefix. */
  readonly maxEffectsPerApply?: number;
}

interface FakeRow {
  readonly targetId: string;
  readonly anchor: string;
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
  readonly rowsByAnchor: Map<string, FakeRow>;
}

interface Receipt {
  readonly payloadHash: string;
  readonly targetVisibleHash: string;
  readonly visibleRevision: number;
}

/** Error intentionally thrown after a remote write has already completed. */
export class FakeSyncResponseLossError extends CoreErrorException<
  "runtime.fake_sync_gateway",
  FakeSyncGatewayErrorCode
> {
  public constructor() {
    super(
      "runtime.fake_sync_gateway",
      FAKE_SYNC_GATEWAY_ERROR_CODES.RESPONSE_LOST_AFTER_APPLY,
      "Fake gateway dropped the response after applying remote effects.",
    );
  }
}

/**
 * Fake gateway with explicit response-loss and partial-batch injection.
 *
 * `dropNextResponseAfterApply()` is intentionally one-shot: the next call
 * writes and records receipts before its caller observes a transport failure.
 */
export class FakeSyncSheetGateway implements SyncSheetGateway {
  private readonly sheets = new Map<string, FakeSheet>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly maxEffectsPerApply: Presence<number>;
  private anchorSequence = 0;
  private dropResponse = false;
  private postconditionBatchReadCount = 0;
  private fastAppendCallCount = 0;
  private lastApplyPostconditionMode: ApplySyncEffectsRequest["postconditionMode"] | undefined;

  public constructor(inputs: readonly FakeSyncSheetInput[], options: FakeSyncGatewayOptions = {}) {
    this.maxEffectsPerApply = options.maxEffectsPerApply === undefined
      ? absentValue()
      : presentValue(requireSyncGatewayPositiveSafeInteger(
        options.maxEffectsPerApply,
        "fake gateway maxEffectsPerApply",
        SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
      ));
    for (const input of inputs) this.addSheet(input);
  }

  /** Injects exactly one transport failure after the next successful remote apply. */
  public dropNextResponseAfterApply(): void {
    this.dropResponse = true;
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
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
        `fake row anchor does not exist: ${anchor}`,
      );
    }
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
    const grouped = groupDuplicateAnchors([...sheet.rowsByAnchor.values()].map((row) => row.anchor));
    return {
      assigned: 0,
      existing: sheet.rowsByAnchor.size,
      duplicateAnchors: grouped,
    };
  }

  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot> {
    const sheet = this.requireMatchingSheet(request);
    const rows = [...sheet.rowsByAnchor.values()]
      .sort((left, right) => left.anchor.localeCompare(right.anchor))
      .map((row, index) => this.toSnapshotRow(sheet, row, index + 2));
    const snapshotPayload = {
      protocolVersion: SYNC_GATEWAY_PROTOCOL_VERSIONS.V1,
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

  public async applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    this.lastApplyPostconditionMode = request.postconditionMode;
    const sheet = this.requireMatchingSheet(request);
    const limit = this.maxEffectsPerApply.kind === PRESENCE_KINDS.PRESENT
      ? this.maxEffectsPerApply.value
      : request.effects.length;
    const selected = request.effects.slice(0, limit);
    const results = selected.map((effect) => {
      const result = this.applyOne(sheet, effect);
      if (
        request.postconditionMode === SYNC_GATEWAY_POSTCONDITION_MODES.DEFERRED &&
        (result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.APPLIED ||
          result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED)
      ) {
        return {
          ...result,
          postcondition: SYNC_GATEWAY_POSTCONDITION_STATUSES.ACKNOWLEDGED,
        };
      }
      return result;
    });
    const snapshotHash = this.sheetSnapshotHash(sheet);
    if (this.dropResponse) {
      this.dropResponse = false;
      throw new FakeSyncResponseLossError();
    }
    return {
      results,
      snapshotHash: presentValue(snapshotHash),
      hasMore: selected.length < request.effects.length,
    };
  }

  /** Appends rows without CAS, metadata, or retry deduplication. */
  public async fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    this.fastAppendCallCount += 1;
    const sheet = this.requireMatchingSheet(request);
    const limit = this.maxEffectsPerApply.kind === PRESENCE_KINDS.PRESENT
      ? this.maxEffectsPerApply.value
      : request.rows.length;
    const selected = request.rows.slice(0, limit);
    const results = selected.map((row) => this.fastAppendOne(sheet, row));
    if (this.dropResponse) {
      this.dropResponse = false;
      throw new FakeSyncResponseLossError();
    }
    return {
      results,
      hasMore: selected.length < request.rows.length,
    };
  }

  public async readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition> {
    const sheetResult = lookupResult(this.sheets.get(effect.physicalSheetId));
    if (sheetResult.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      return unavailablePostcondition();
    }
    const sheet = sheetResult.value;
    const row = this.findRowByAnchorOrIdentity(sheet, effect.payload.targetAnchor, effect.targetId);
    const snapshotHash = presentValue(this.sheetSnapshotHash(sheet));
    if (isProjectionDeletionEffect(effect.effectKind)) {
      const receipt = this.receipts.get(effect.effectId);
      if (receipt !== undefined && receipt.payloadHash !== effect.payloadHash) {
        return changedPostcondition(snapshotHash);
      }
      if (receipt !== undefined && row.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
        return {
          disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.APPLIED,
          visibleRevision: presentValue(receipt.visibleRevision),
          visibleHash: presentValue(receipt.targetVisibleHash),
          snapshotHash,
        };
      }
      // An absent row without this effect's receipt could be a manual deletion.
      // Never let that absence close an outbox effect after response loss.
      if (row.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
        return {
          disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAVAILABLE,
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
        return { disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED, ...base };
      }
      if (
        row.value.visibleRevision === effect.expectedVisibleRevision &&
        row.value.visibleHash === effect.expectedVisibleHash
      ) {
        return { disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAPPLIED, ...base };
      }
      return { disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED, ...base };
    }
    if (row.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      return {
        disposition: effect.payload.createIfMissing
          ? SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAPPLIED
          : SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED,
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
      return { disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.APPLIED, ...base };
    }
    if (row.value.visibleHash === effect.expectedVisibleHash) {
      return { disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAPPLIED, ...base };
    }
    if (
      effect.effectKind === FAKE_EFFECT_KINDS.SYSTEM_REPAIR &&
      effect.repairGuardHash.kind === PRESENCE_KINDS.PRESENT &&
      row.value.visibleHash === effect.repairGuardHash.value
    ) {
      return { disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAPPLIED, ...base };
    }
    return { disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED, ...base };
  }

  /** Reads a recovery batch through the same contract as the real gateway. */
  public async readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncGatewayEffectPostconditionResult[]> {
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

  /** Exposes the last verification mode so worker tests can assert the contract. */
  public get applyPostconditionMode(): ApplySyncEffectsRequest["postconditionMode"] {
    return this.lastApplyPostconditionMode;
  }

  private addSheet(input: FakeSyncSheetInput): void {
    const physicalSheetId = requireSyncGatewayText(
      input.physicalSheetId,
      "fake sheet physicalSheetId",
      SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
    );
    if (this.sheets.has(physicalSheetId)) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
        `duplicate fake physical sheet ID: ${physicalSheetId}`,
      );
    }
    const sheetName = requireSyncGatewayText(
      input.sheetName,
      "fake sheet sheetName",
      SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
    );
    const registeredRange = requireSyncGatewayText(
      input.registeredRange,
      "fake sheet registeredRange",
      SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
    );
    const projection = requireSyncGatewayProjection(
      input.projection,
      "fake sheet projection",
      SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
    );
    const schemaVersion = requireSyncGatewayPositiveSafeInteger(
      input.schemaVersion,
      "fake sheet schemaVersion",
      SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
    );
    requireSyncGatewayNonEmptyList(
      input.headers,
      "fake sheet headers",
      SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
    );
    const headers = input.headers.map((header, index) =>
      requireSyncGatewayText(
        header,
        `fake sheet headers[${index}]`,
        SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
      ));
    const rowsByAnchor = new Map<string, FakeRow>();
    for (const initial of input.rows ?? []) {
      const anchor = initial.physicalAnchor === undefined
        ? this.nextAnchor()
        : requireSyncGatewayText(
          initial.physicalAnchor,
          "fake row physicalAnchor",
          SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
        );
      if (rowsByAnchor.has(anchor)) {
        throw new SyncGatewayContractError(
          SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
          `duplicate fake physical anchor: ${anchor}`,
        );
      }
      const fields = { ...initial.fields };
      rowsByAnchor.set(anchor, {
        targetId: requireSyncGatewayText(
          initial.targetId,
          "fake row targetId",
          SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
        ),
        anchor,
        physicalAnchorPresent: true,
        fields,
        visibleRevision: initial.visibleRevision === undefined
          ? NON_NEGATIVE_SAFE_INTEGER_MINIMUM
          : requireSyncGatewayNonNegativeSafeInteger(
            initial.visibleRevision,
            "fake row visibleRevision",
            SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
          ),
        visibleHash: computeSyncVisibleHash(fields),
        activeCandidateHash: initial.activeCandidateHash ?? notApplicableValue(),
      });
    }
    this.sheets.set(physicalSheetId, {
      physicalSheetId,
      sheetName,
      registeredRange,
      projection,
      schemaVersion,
      headers,
      identityField: input.identityField ??
        (projection === SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE && headers.includes("id") ? "id" : undefined),
      rowsByAnchor,
    });
  }

  private fastAppendOne(sheet: FakeSheet, row: FastAppendRow): FastAppendRowResult {
    const anchor = this.nextAnchor();
    const fields = { ...row.fields };
    sheet.rowsByAnchor.set(anchor, {
      targetId: row.effectId,
      anchor,
      physicalAnchorPresent: false,
      fields,
      visibleRevision: 1,
      visibleHash: computeSyncVisibleHash(fields),
      activeCandidateHash: notApplicableValue(),
    });
    return {
      effectId: row.effectId,
      status: SYNC_GATEWAY_FAST_APPEND_STATUSES.APPLIED,
    };
  }

  private applyOne(sheet: FakeSheet, effect: SyncGatewayEffect): SyncGatewayEffectResult {
    if (effect.physicalSheetId !== sheet.physicalSheetId || effect.projection !== sheet.projection) {
      return this.result(
        effect,
        SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
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
        SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
        notFoundValue(),
        presentValue("effect payload does not match registered sheet"),
      );
    }
    if (computeSyncVisibleHash(effect.payload.fields) !== effect.payload.targetVisibleHash) {
      return this.result(
        effect,
        SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
        notFoundValue(),
        presentValue("effect target hash does not match fields"),
      );
    }
    const deletionShapeError = this.projectionDeleteShapeError(sheet, effect);
    if (deletionShapeError.kind === PRESENCE_KINDS.PRESENT) {
      return this.result(
        effect,
        SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
        notFoundValue(),
        deletionShapeError,
      );
    }

    const receipt = this.receipts.get(effect.effectId);
    if (receipt !== undefined) {
      if (receipt.payloadHash !== effect.payloadHash) {
        return this.result(
          effect,
          SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
          notFoundValue(),
          presentValue("effect ID was reused with another payload"),
        );
      }
      const row = this.findRowByAnchorOrIdentity(sheet, effect.payload.targetAnchor, effect.targetId);
      if (isProjectionDeletionEffect(effect.effectKind)) {
        if (row.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
          return this.result(
            effect,
            SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED,
            row,
            absentValue(),
            receipt,
          );
        }
        return this.result(
          effect,
          SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
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
            ? SYNC_GATEWAY_EFFECT_RESULT_STATUSES.REPAIR_REOBSERVE
            : SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
          row,
          presentValue("receipt_postcondition_changed"),
        );
      }
      return this.result(
        effect,
        SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED,
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
          SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
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
          SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
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
      sheet.rowsByAnchor.set(row.anchor, row);
    } else {
      row = existingRow.value;
    }

    if (isProjectionDeletionEffect(effect.effectKind)) {
      if (
        row.visibleRevision !== effect.expectedVisibleRevision ||
        row.visibleHash !== effect.expectedVisibleHash
      ) {
        return this.result(
          effect,
          SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
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
          SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
          foundValue(row),
          presentValue("active_candidate_preserved"),
        );
      }
      const deletionReceipt: Receipt = {
        payloadHash: effect.payloadHash,
        targetVisibleHash: effect.payload.targetVisibleHash,
        visibleRevision: row.visibleRevision,
      };
      sheet.rowsByAnchor.delete(row.anchor);
      this.receipts.set(effect.effectId, deletionReceipt);
      return this.result(
        effect,
        SYNC_GATEWAY_EFFECT_RESULT_STATUSES.APPLIED,
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
          SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
          foundValue(row),
          presentValue("candidate_guard_mismatch"),
        );
      }
      return this.result(
        effect,
        SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
        foundValue(row),
        presentValue("active_candidate_preserved"),
      );
    }

    if (row.visibleHash === effect.payload.targetVisibleHash) {
      this.receipts.set(effect.effectId, {
        payloadHash: effect.payloadHash,
        targetVisibleHash: effect.payload.targetVisibleHash,
        visibleRevision: row.visibleRevision,
      });
      return this.result(
        effect,
        SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED,
        foundValue(row),
        absentValue(),
      );
    }

    if (effect.effectKind === FAKE_EFFECT_KINDS.SYSTEM_REPAIR) {
      if (
        effect.repairGuardHash.kind !== PRESENCE_KINDS.PRESENT ||
        row.visibleHash !== effect.repairGuardHash.value
      ) {
        return this.result(
          effect,
          SYNC_GATEWAY_EFFECT_RESULT_STATUSES.REPAIR_REOBSERVE,
          foundValue(row),
          presentValue("repair_guard_mismatch"),
        );
      }
    } else if (
      row.visibleRevision !== effect.expectedVisibleRevision ||
      row.visibleHash !== effect.expectedVisibleHash
    ) {
      return this.result(
        effect,
        SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH,
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
    this.receipts.set(effect.effectId, {
      payloadHash: effect.payloadHash,
      targetVisibleHash: effect.payload.targetVisibleHash,
      visibleRevision: row.visibleRevision,
    });
    return this.result(
      effect,
      SYNC_GATEWAY_EFFECT_RESULT_STATUSES.APPLIED,
      foundValue(row),
      absentValue(),
    );
  }

  /** Rejects broad or ambiguous delete effects before an anchor is ever removed. */
  private projectionDeleteShapeError(
    sheet: FakeSheet,
    effect: SyncGatewayEffect,
  ): Presence<string> {
    if (!isProjectionDeletionEffect(effect.effectKind)) {
      return absentValue();
    }
    const expectedProjection = effect.effectKind === FAKE_EFFECT_KINDS.RESOLUTION_DELETE
      ? SYNC_GATEWAY_PROJECTIONS.SYNC_CONFLICTS
      : SYNC_GATEWAY_PROJECTIONS.USER_INPUT;
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
    effect: SyncGatewayEffect,
    status: SyncGatewayEffectResult["status"],
    row: LookupResult<FakeRow>,
    reason: Presence<string>,
    receipt?: Receipt,
  ): SyncGatewayEffectResult {
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
        ? SYNC_GATEWAY_POSTCONDITION_STATUSES.VERIFIED
        : SYNC_GATEWAY_POSTCONDITION_STATUSES.UNAVAILABLE,
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
      visibleRevision: presentValue(row.visibleRevision),
      visibleHash: presentValue(row.visibleHash),
      cells,
    };
  }

  private requireSheet(physicalSheetId: string): FakeSheet {
    const sheet = lookupResult(this.sheets.get(physicalSheetId));
    if (sheet.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
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
    const anchored = lookupResult(sheet.rowsByAnchor.get(anchor));
    if (anchored.kind === LOOKUP_RESULT_KINDS.FOUND || sheet.identityField === undefined) {
      return anchored;
    }
    const matches = [...sheet.rowsByAnchor.values()].filter((row) =>
      normalizedCellIdentity(row.fields[sheet.identityField as string]) === targetId,
    );
    if (matches.length > 1) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
        `fake sync identity is duplicated: ${targetId}`,
      );
    }
    return matches[0] === undefined ? notFoundValue() : { kind: LOOKUP_RESULT_KINDS.FOUND, value: matches[0] };
  }

  private requireRow(sheet: FakeSheet, anchor: string): FakeRow {
    const row = lookupResult(sheet.rowsByAnchor.get(anchor));
    if (row.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
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
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_FAKE_GATEWAY_INPUT,
        "fake gateway request does not match registered sheet",
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
      rows: [...sheet.rowsByAnchor.values()]
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
}

function normalizedCellIdentity(cell: NormalizedCell | undefined): string | undefined {
  if (cell === undefined || cell === null) return undefined;
  if (typeof cell.value === "string") return cell.value.length === 0 ? undefined : cell.value;
  if (typeof cell.value === "number") return Number.isFinite(cell.value) ? String(cell.value) : undefined;
  if (typeof cell.value === "boolean") return String(cell.value);
  return undefined;
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
    disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAVAILABLE,
    visibleRevision: absentValue(),
    visibleHash: absentValue(),
    snapshotHash: absentValue(),
  };
}

function changedPostcondition(snapshotHash: Presence<string>): SyncEffectPostcondition {
  return {
    disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED,
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
