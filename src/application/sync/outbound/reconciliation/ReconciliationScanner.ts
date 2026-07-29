/**
 * Periodic reconciliation scanner for the System_State projection.
 *
 * SQLite is the canonical state; the Sheet is a projection that may drift when
 * the fast-append path skips per-effect CAS, when a spreadsheet owner edits a
 * protected tab, or when a response is lost. This scanner compares the durable
 * desired state against one gateway snapshot per scan and, for every drift, it
 * enqueues a normal system_projection effect on the existing outbox. The effect
 * worker then applies the correction through the same slow path (with CAS) used
 * by regular writes, so reconciliation never writes to the Sheet directly.
 *
 * Scope is intentionally limited to System_State in v1: that projection is
 * protected and hidden, so the canonical state is always authoritative and a
 * drift is always a repair target. User_Input reconciliation remains the
 * responsibility of the candidate/conflict pipeline.
 */

import { randomUUID } from "node:crypto";
import {
  EMPTY_STRING_LENGTH_ZERO,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  stableHash,
  type NormalizedCell,
} from "../../../../domain/index.js";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "../../../../shared/state/index.js";
import { NORMALIZED_CELL_KINDS } from "../../../../shared/encoding/constants.js";
import {
  appendPendingEffectsWithAdapter,
  claimWriterLeaseWithAdapter,
  readReconciliationCorrectionStateWithAdapter,
  readReconciliationDesiredSystemStateWithAdapter,
  requireRegisteredSyncSheetWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type FencingContext,
  type NewEffect,
  type ReconciliationCorrectionState,
  type ReconciliationDesiredSystemStateRow,
  type ReconciliationVisibleState,
} from "../../../../infrastructure/storage/index.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../../../infrastructure/storage/errors.js";
import type { SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import {
  computeSyncVisibleHash,
  observeSyncSnapshot,
  type SyncGatewaySnapshot,
  type SyncSheetGateway,
} from "../../gateway/syncGateway.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
  SYNC_GATEWAY_SNAPSHOT_READ_MODES,
} from "../../gateway/constants.js";
import { createSystemProjectionEffect } from "../projection/ProjectionEffectFactory.js";

const DEFAULT_RECONCILIATION_ROLE = "typed-sheets-reconciler";
const DEFAULT_RECONCILIATION_LEASE_MS = 60_000;
const DEFAULT_SYSTEM_TOMBSTONE_FIELD = "_deleted";

/** Builder used by the scanner to produce fresh effect/commit identifiers. */
export type ReconciliationIdFactory = () => string;

/** Construction options for a single reconciliation scan. */
export interface RunReconciliationScanOptions {
  readonly storage: SqlStorageAdapter;
  readonly gateway: SyncSheetGateway;
  /** Physical sheet id of the System_State projection to reconcile. */
  readonly physicalSheetId: string;
  /** Logical sheet id owning the entity row bindings. */
  readonly logicalSheetId: string;
  /**
   * Schema-declared field list for the System_State projection. The scanner
   * reads exactly these fields per row and ignores anything else in the Sheet.
   */
  readonly systemFields: readonly string[];
  /**
   * Field name that encodes a tombstone (soft delete) on the System_State
   * projection. Defaults to `_deleted`; tombstoned rows are dropped from the
   * desired state and re-created if the Sheet still exposes them.
   */
  readonly tombstoneField?: string;
  /** Schema version shared by every System_State effect produced here. */
  readonly schemaVersion: number;
  /** Reconciler writer identity. */
  readonly writerId: string;
  /** Injectable clock and id source for deterministic tests. */
  readonly now?: () => number;
  readonly createId?: ReconciliationIdFactory;
  /** Override the reconciler lease role or duration. */
  readonly writerRole?: string;
  readonly leaseDurationMs?: number;
  /** Observability hook invoked once after the scan settles. */
  readonly onReport?: (report: ReconciliationScanReport) => void;
}

/** Observable outcome of one reconciliation scan. */
export interface ReconciliationScanReport {
  readonly physicalSheetId: string;
  readonly snapshotRowsScanned: number;
  readonly desiredRowsScanned: number;
  readonly matchedRows: number;
  readonly driftedRows: number;
  readonly missingRows: number;
  readonly extraRows: number;
  readonly effectsEnqueued: number;
  readonly fenceClaimed: boolean;
}

interface DesiredRow {
  readonly entityId: string;
  readonly rowBindingId: string;
  readonly entityRevision: number;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly fieldRevisionHash: string;
}

/**
 * Runs one reconciliation scan and enqueues correction effects for drift.
 *
 * The scan never writes to the Sheet. It only reads a snapshot and inserts
 * effects into the durable outbox; the existing effect worker applies them.
 */
export async function runReconciliationScan(
  options: RunReconciliationScanOptions,
): Promise<ReconciliationScanReport> {
  validateOptions(options);

  const now = options.now ?? Date.now;
  const createId = options.createId ?? randomUUID;
  const tombstoneField = options.tombstoneField ?? (
    options.systemFields.includes(DEFAULT_SYSTEM_TOMBSTONE_FIELD)
      ? DEFAULT_SYSTEM_TOMBSTONE_FIELD
      : undefined
  );
  const role = options.writerRole ?? DEFAULT_RECONCILIATION_ROLE;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_RECONCILIATION_LEASE_MS;

  const report: ReconciliationScanReport = await scanAndEnqueue({
    storage: options.storage,
    gateway: options.gateway,
    physicalSheetId: options.physicalSheetId,
    logicalSheetId: options.logicalSheetId,
    systemFields: options.systemFields,
    tombstoneField,
    schemaVersion: options.schemaVersion,
    writerId: options.writerId,
    now,
    createId,
    role,
    leaseDurationMs,
  });

  try {
    options.onReport?.(report);
  } catch {
    // Observability callbacks must never fail the scan.
  }
  return report;
}

interface ScanContext {
  readonly storage: SqlStorageAdapter;
  readonly gateway: SyncSheetGateway;
  readonly physicalSheetId: string;
  readonly logicalSheetId: string;
  readonly systemFields: readonly string[];
  readonly tombstoneField: string | undefined;
  readonly schemaVersion: number;
  readonly writerId: string;
  readonly now: () => number;
  readonly createId: ReconciliationIdFactory;
  readonly role: string;
  readonly leaseDurationMs: number;
}

async function scanAndEnqueue(context: ScanContext): Promise<ReconciliationScanReport> {
  const sheet = await requireRegisteredSyncSheetWithAdapter(
    context.storage,
    context.physicalSheetId,
  );
  if (sheet.projection !== SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "reconciliation scanner only supports the system_state projection",
    );
  }

  const snapshotRequest = {
    physicalSheetId: context.physicalSheetId,
    sheetName: sheet.tabName,
    registeredRange: sheet.registeredRange,
    projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
    schemaVersion: sheet.schemaVersion,
    readMode: SYNC_GATEWAY_SNAPSHOT_READ_MODES.FULL,
  } as const;
  // The snapshot is matched by the registered visible business-key field.
  const observed = await observeSyncSnapshot(context.gateway, snapshotRequest);
  const snapshot = observed.snapshot;

  const desired = await readDesiredSystemState(context);
  const drifts = computeDrifts({
    snapshot,
    desired,
    systemFields: context.systemFields,
    sheet,
  });

  if (drifts.length === 0) {
    return freezeReport(context.physicalSheetId, snapshot, desired, {
      matched: countMatchedRows(snapshot, desired, sheet.businessKeyField),
      drifted: 0,
      missing: 0,
      extra: countExtraRows(snapshot, desired, sheet.businessKeyField),
      effects: 0,
      fenceClaimed: false,
    });
  }

  const fence = await claimReconcilerFence(context);
  if (fence === null) {
    return freezeReport(context.physicalSheetId, snapshot, desired, {
      matched: countMatchedRows(snapshot, desired, sheet.businessKeyField),
      drifted: drifts.filter((drift) => drift.kind === "drifted").length,
      missing: drifts.filter((drift) => drift.kind === "missing").length,
      extra: 0,
      effects: 0,
      fenceClaimed: false,
    });
  }

  const effects = await buildCorrectionEffects(context, sheet, drifts);
  if (effects.length === 0) {
    return freezeReport(context.physicalSheetId, snapshot, desired, {
      matched: countMatchedRows(snapshot, desired, sheet.businessKeyField),
      drifted: drifts.filter((drift) => drift.kind === "drifted").length,
      missing: drifts.filter((drift) => drift.kind === "missing").length,
      extra: countExtraRows(snapshot, desired, sheet.businessKeyField),
      effects: 0,
      fenceClaimed: true,
    });
  }

  const enqueued = await appendPendingEffectsWithAdapter(context.storage, fence, effects);
  if (!enqueued) {
    return freezeReport(context.physicalSheetId, snapshot, desired, {
      matched: countMatchedRows(snapshot, desired, sheet.businessKeyField),
      drifted: drifts.filter((drift) => drift.kind === "drifted").length,
      missing: drifts.filter((drift) => drift.kind === "missing").length,
      extra: countExtraRows(snapshot, desired, sheet.businessKeyField),
      effects: 0,
      fenceClaimed: true,
    });
  }

  return freezeReport(context.physicalSheetId, snapshot, desired, {
    matched: countMatchedRows(snapshot, desired, sheet.businessKeyField),
    drifted: drifts.filter((drift) => drift.kind === "drifted").length,
    missing: drifts.filter((drift) => drift.kind === "missing").length,
    extra: countExtraRows(snapshot, desired, sheet.businessKeyField),
    effects: effects.length,
    fenceClaimed: true,
  });
}

type DriftKind = "drifted" | "missing";

interface DriftTarget {
  readonly kind: DriftKind;
  readonly desired: DesiredRow;
}

function computeDrifts(args: {
  readonly snapshot: SyncGatewaySnapshot;
  readonly desired: readonly DesiredRow[];
  readonly systemFields: readonly string[];
  readonly sheet: { readonly registeredRange: string; readonly businessKeyField: string };
}): readonly DriftTarget[] {
  const rowsByIdentity = new Map<string, SyncGatewaySnapshot["rows"][number]>();
  const ambiguousIdentities = new Set<string>();
  for (const row of args.snapshot.rows) {
    const identity = snapshotIdentity(row, args.sheet.businessKeyField);
    if (identity === undefined || ambiguousIdentities.has(identity)) continue;
    if (rowsByIdentity.has(identity)) {
      rowsByIdentity.delete(identity);
      ambiguousIdentities.add(identity);
    } else {
      rowsByIdentity.set(identity, row);
    }
  }

  const drifts: DriftTarget[] = [];
  for (const desiredRow of args.desired) {
    const observed = ambiguousIdentities.has(desiredRow.entityId)
      ? undefined
      : rowsByIdentity.get(desiredRow.entityId);
    if (observed === undefined) {
      drifts.push({ kind: "missing", desired: desiredRow });
      continue;
    }
    const observedHash = computeObservedHash(observed, args.systemFields);
    const desiredHash = computeSyncVisibleHash(desiredRow.fields);
    if (observedHash !== desiredHash) {
      drifts.push({ kind: "drifted", desired: desiredRow });
    }
  }
  return drifts;
}

/** Reads a business-key value from a visible snapshot row. */
function snapshotIdentity(
  row: SyncGatewaySnapshot["rows"][number],
  identityField: string,
): string | undefined {
  const cell = row.cells[identityField]?.normalizedCell;
  if (cell === undefined || cell === null) return undefined;
  switch (cell.kind) {
    case NORMALIZED_CELL_KINDS.STRING:
      return cell.value.length === EMPTY_STRING_LENGTH_ZERO ? undefined : cell.value;
    case NORMALIZED_CELL_KINDS.NUMBER:
      return Number.isFinite(cell.value) ? String(cell.value) : undefined;
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return String(cell.value);
    case NORMALIZED_CELL_KINDS.DATE:
      return cell.value;
  }
}

function computeObservedHash(
  row: SyncGatewaySnapshot["rows"][number],
  systemFields: readonly string[],
): string {
  const values: Record<string, NormalizedCell> = {};
  for (const fieldName of systemFields) {
    const cell = row.cells[fieldName];
    values[fieldName] = cell === undefined ? null : cell.normalizedCell;
  }
  return computeSyncVisibleHash(values);
}

async function readDesiredSystemState(context: ScanContext): Promise<readonly DesiredRow[]> {
  const rows = await readReconciliationDesiredSystemStateWithAdapter(
    context.storage,
    context.logicalSheetId,
  );
  return buildDesiredSystemState(rows, context);
}

function buildDesiredSystemState(
  rows: readonly ReconciliationDesiredSystemStateRow[],
  context: ScanContext,
): readonly DesiredRow[] {
  const byEntity = new Map<string, DesiredRow>();
  for (const row of rows) {
    const existing = byEntity.get(row.entityId);
    const cell = decodeNormalizedCell(row.normalizedValue);
    if (existing === undefined) {
      const fields: Record<string, NormalizedCell> = {};
      fields[row.fieldName] = cell;
      byEntity.set(row.entityId, {
        entityId: row.entityId,
        rowBindingId: row.rowBindingId,
        entityRevision: row.entityRevision,
        fields,
        fieldRevisionHash: "",
      });
      continue;
    }
    (existing.fields as Record<string, NormalizedCell>)[row.fieldName] = cell;
  }

  const desired: DesiredRow[] = [];
  for (const row of byEntity.values()) {
    ensureTombstoneField(row, context.tombstoneField);
    const hash = computeFieldRevisionHash(row.fields);
    desired.push({ ...row, fieldRevisionHash: hash });
  }
  return desired;
}

function ensureTombstoneField(row: DesiredRow, tombstoneField: string | undefined): void {
  if (tombstoneField === undefined) return;
  const fields = row.fields as Record<string, NormalizedCell>;
  if (fields[tombstoneField] === undefined) {
    fields[tombstoneField] = { kind: NORMALIZED_CELL_KINDS.BOOLEAN, value: false };
  }
}

function computeFieldRevisionHash(fields: Readonly<Record<string, NormalizedCell>>): string {
  const entries = Object.entries(fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fieldName, value]) => ({ fieldName, value }));
  return stableHash({ fields: entries });
}

function decodeNormalizedCell(value: string): NormalizedCell {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isNormalizedCellLike(parsed)) {
      throw new StorageError(
        STORAGE_ERROR_CODES.OBSERVATION_STORAGE_INCONSISTENT,
        "entity_field_state.normalized_value is not a normalized cell",
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      STORAGE_ERROR_CODES.OBSERVATION_STORAGE_INCONSISTENT,
      "entity_field_state.normalized_value is not valid JSON",
    );
  }
}

function isNormalizedCellLike(value: unknown): value is NormalizedCell {
  if (value === null) return true;
  if (typeof value !== "object" || value === null) return false;
  const cell = value as { kind?: unknown; value?: unknown };
  return typeof cell.kind === "string";
}

async function buildCorrectionEffects(
  context: ScanContext,
  sheet: { readonly tabName: string; readonly registeredRange: string },
  drifts: readonly DriftTarget[],
): Promise<readonly NewEffect[]> {
  const effects: NewEffect[] = [];
  const commitId = "reconciliation:" + context.createId();

  for (const drift of drifts) {
    const baseline = await resolveCorrectionBaseline(context, drift.desired);
    if (baseline.skip) continue;
    const effect = createSystemProjectionEffect({
      effectId: "effect:" + context.createId(),
      commitId,
      logicalSheetId: context.logicalSheetId,
      physicalSheetId: context.physicalSheetId,
      sheetName: sheet.tabName,
      registeredRange: sheet.registeredRange,
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: context.schemaVersion,
      targetKind: "entity",
      targetId: drift.desired.entityId,
      rowBindingId: { kind: PRESENCE_KINDS.PRESENT, value: drift.desired.rowBindingId },
      conflictId: { kind: PRESENCE_KINDS.ABSENT },
      fields: drift.desired.fields,
      createIfMissing: baseline.createIfMissing,
      expectedVisibleRevision: baseline.expectedVisibleRevision,
      expectedVisibleHash: baseline.expectedVisibleHash,
      targetEntityRevision: {
        kind: APPLICABILITY_KINDS.APPLICABLE,
        value: drift.desired.entityRevision,
      },
      targetFieldRevisionHash: {
        kind: APPLICABILITY_KINDS.APPLICABLE,
        value: drift.desired.fieldRevisionHash,
      },
      targetCanonicalCommitId: { kind: APPLICABILITY_KINDS.APPLICABLE, value: commitId },
      streamSequence: baseline.streamSequence,
    });
    effects.push(effect);
  }
  return effects;
}

interface CorrectionBaseline {
  readonly skip: boolean;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly createIfMissing: boolean;
  readonly streamSequence: number;
}

async function resolveCorrectionBaseline(
  context: ScanContext,
  desired: DesiredRow,
): Promise<CorrectionBaseline> {
  const state = await readReconciliationCorrectionStateWithAdapter(context.storage, {
    logicalSheetId: context.logicalSheetId,
    physicalSheetId: context.physicalSheetId,
    entityId: desired.entityId,
    rowBindingId: desired.rowBindingId,
  });
  return resolveCorrectionBaselineFromState(state, desired);
}

function resolveCorrectionBaselineFromState(
  state: ReconciliationCorrectionState,
  desired: DesiredRow,
): CorrectionBaseline {
  const latestEffect = state.latestEffect;

  if (latestEffect !== undefined && latestEffect.streamSequence !== null) {
    const streamSequence = latestEffect.streamSequence + 1;
    if (latestEffect.status === "pending" || latestEffect.status === "processing") {
      const payload = latestEffect.payloadJson;
      const expectedHash =
        payload === null ? "" : extractTargetVisibleHash(payload);
      if (expectedHash === computeSyncVisibleHash(desired.fields)) {
        // A canonical write already has an equivalent correction in flight.
        // Do not append another stream item on every periodic scan while the
        // first item is waiting for the gateway or its recovery read-back.
        return {
          skip: true,
          expectedVisibleRevision: (latestEffect.expectedVisibleRevision ?? 0) + 1,
          expectedVisibleHash: expectedHash,
          createIfMissing: false,
          streamSequence,
        };
      }
      return {
        skip: false,
        expectedVisibleRevision: (latestEffect.expectedVisibleRevision ?? 0) + 1,
        expectedVisibleHash: expectedHash,
        createIfMissing: false,
        streamSequence,
      };
    }
    return baselineFromVisible(state.visibleState, streamSequence);
  }

  return baselineFromVisible(state.visibleState, POSITIVE_SAFE_INTEGER_MINIMUM);
}

function baselineFromVisible(
  visible: ReconciliationVisibleState | undefined,
  streamSequence: number,
): CorrectionBaseline {
  if (
    visible === undefined ||
    visible.confirmedVisibleRevision === null ||
    visible.confirmedSnapshotHash === null ||
    visible.confirmedSnapshotHash.length === 0
  ) {
    return {
      skip: false,
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
      createIfMissing: true,
      streamSequence,
    };
  }
  return {
    skip: false,
    expectedVisibleRevision: visible.confirmedVisibleRevision,
    expectedVisibleHash: visible.confirmedSnapshotHash,
    createIfMissing: false,
    streamSequence,
  };
}

function extractTargetVisibleHash(payloadJson: string): string {
  try {
    const parsed = JSON.parse(payloadJson) as { targetVisibleHash?: unknown };
    return typeof parsed.targetVisibleHash === "string" ? parsed.targetVisibleHash : "";
  } catch {
    return "";
  }
}

async function claimReconcilerFence(context: ScanContext): Promise<FencingContext | null> {
  const claim = await claimWriterLeaseWithAdapter(context.storage, {
    role: context.role,
    writerId: context.writerId,
    leaseDurationMs: context.leaseDurationMs,
    now: context.now(),
  });
  if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) return null;
  const lease = claim.lease;
  return {
    role: lease.role,
    writerEpoch: lease.writerEpoch,
    fencingToken: lease.fencingToken,
    now: context.now(),
  };
}

function countMatchedRows(
  snapshot: SyncGatewaySnapshot,
  desired: readonly DesiredRow[],
  identityField: string,
): number {
  const identities = new Set<string>();
  const duplicateIdentities = new Set<string>();
  for (const row of snapshot.rows) {
    const identity = snapshotIdentity(row, identityField);
    if (identity === undefined || duplicateIdentities.has(identity)) continue;
    if (identities.has(identity)) {
      identities.delete(identity);
      duplicateIdentities.add(identity);
    } else {
      identities.add(identity);
    }
  }
  let matched = 0;
  for (const row of desired) {
    if (identities.has(row.entityId)) matched += 1;
  }
  return matched;
}

function countExtraRows(
  snapshot: SyncGatewaySnapshot,
  desired: readonly DesiredRow[],
  identityField: string,
): number {
  const desiredIdentities = new Set(desired.map((row) => row.entityId));
  let extra = 0;
  for (const row of snapshot.rows) {
    const identity = snapshotIdentity(row, identityField);
    if (identity !== undefined && desiredIdentities.has(identity)) continue;
    extra += 1;
  }
  return extra;
}

interface ReportDelta {
  readonly matched: number;
  readonly drifted: number;
  readonly missing: number;
  readonly extra: number;
  readonly effects: number;
  readonly fenceClaimed: boolean;
}

function freezeReport(
  physicalSheetId: string,
  snapshot: SyncGatewaySnapshot,
  desired: readonly DesiredRow[],
  delta: ReportDelta,
): ReconciliationScanReport {
  return {
    physicalSheetId,
    snapshotRowsScanned: snapshot.rows.length,
    desiredRowsScanned: desired.length,
    matchedRows: delta.matched,
    driftedRows: delta.drifted,
    missingRows: delta.missing,
    extraRows: delta.extra,
    effectsEnqueued: delta.effects,
    fenceClaimed: delta.fenceClaimed,
  };
}

function validateOptions(options: RunReconciliationScanOptions): void {
  if (options.physicalSheetId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "reconciliation scanner requires a physical sheet id",
    );
  }
  if (options.logicalSheetId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "reconciliation scanner requires a logical sheet id",
    );
  }
  if (options.systemFields.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "reconciliation scanner requires at least one system field",
    );
  }
  if (
    !Number.isSafeInteger(options.schemaVersion) ||
    options.schemaVersion < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_SYNC_REGISTRATION,
      "reconciliation scanner schemaVersion must be a positive safe integer",
    );
  }
  if (options.writerId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "reconciliation scanner writerId is required",
    );
  }
  if (
    options.leaseDurationMs !== undefined &&
    (!Number.isSafeInteger(options.leaseDurationMs) ||
      options.leaseDurationMs < POSITIVE_SAFE_INTEGER_MINIMUM)
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "reconciliation scanner leaseDurationMs must be a positive safe integer",
    );
  }
}

// Re-export for callers that want the constants used as defaults.
export const RECONCILIATION_DEFAULTS = {
  ROLE: DEFAULT_RECONCILIATION_ROLE,
  LEASE_MS: DEFAULT_RECONCILIATION_LEASE_MS,
  TOMBSTONE_FIELD: DEFAULT_SYSTEM_TOMBSTONE_FIELD,
} as const;
