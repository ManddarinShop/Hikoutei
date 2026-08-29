/**
 * Shared provider contract for the SQLite-authoritative sync runtime.
 *
 * The contract deliberately contains normalized values and stable anchors,
 * never Google SDK objects or physical row numbers. Both the fake provider and
 * the Google Sheets API provider implement this boundary so fault tests
 * exercise the same compare-and-set semantics as a deployed provider.
 */

import { stableHash } from "../../../shared/encoding/stableEncode.js";
import type {
  CellObservation,
  NormalizedCell,
} from "../../../shared/encoding/types.js";
import type {
  EffectKind,
  EffectTargetKind,
} from "../../../domain/model/constants.js";
import { formatZodBoundaryIssues } from "../../../shared/validation/zodBoundary.js";
import { APPLICABILITY_KINDS } from "../../../shared/state/constants.js";
import {
  applicableValue,
  notApplicableValue,
} from "../../../shared/state/index.js";
import type { Applicability, Presence } from "../../../shared/state/types.js";
import type { RegisteredProjection } from "../../../infrastructure/storage/sync/shared/syncRegistry.js";
import {
  type SyncEffectResultStatus,
  type SyncFastAppendStatus,
  type SyncPostconditionMode,
  type SyncPostconditionDisposition,
  type SyncPostconditionStatus,
  type SyncProtocolVersion,
  type SyncSnapshotReadMode,
} from "./constants.js";
import {
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "./errors.js";
import { syncProjectionEffectPayloadSchema } from "./payloadSchemas.js";
import { requireSyncSheetsText } from "./validation.js";
import type { SyncSheetsTiming } from "../telemetry/syncTiming.js";

/** Projections supported by the v1 sync provider. */
export type SyncProjection = RegisteredProjection;

/** Effect classes whose compare-and-set behavior differs at the provider. */
export type SyncEffectKind = EffectKind;

/** Literal/formula metadata retained by a normalized Sheet snapshot. */
export interface SyncSnapshotCell extends CellObservation {
  readonly stableHash: Presence<string>;
}

/** One physical row read from a registered projection. */
export interface SyncSnapshotRow {
  readonly rowNumber: number;
  readonly physicalAnchor: Presence<string>;
  /** Optional compatibility fields; the real provider leaves visible state to SQLite. */
  readonly visibleRevision: Presence<number>;
  readonly visibleHash: Presence<string>;
  readonly cells: Readonly<Record<string, SyncSnapshotCell>>;
}

/** Lock-free normalized snapshot returned by a provider. */
export interface SyncSheetsSnapshot {
  readonly protocolVersion: SyncProtocolVersion;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  readonly rows: readonly SyncSnapshotRow[];
  readonly snapshotHash: string;
  readonly unanchoredRows: readonly number[];
  readonly duplicateAnchors: readonly {
    readonly anchor: string;
    readonly rowNumbers: readonly number[];
  }[];
}

/** Request used to assign missing Developer Metadata anchors before a snapshot. */
export interface EnsureSyncRowAnchorsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
}

/** Result of one anchor assignment pass. */
export interface EnsureSyncRowAnchorsResult {
  readonly assigned: number;
  readonly existing: number;
  readonly duplicateAnchors: readonly {
    readonly anchor: string;
    readonly rowNumbers: readonly number[];
  }[];
}

/** Lock-free snapshot request. */
export interface ReadSyncSnapshotRequest extends EnsureSyncRowAnchorsRequest {
  /** Full metadata for reconciliation, or user-editable values for polling. */
  readonly readMode?: SyncSnapshotReadMode;
}

/** Result of one combined anchor assignment and snapshot read. */
export interface SyncObservedSnapshot {
  readonly anchors: EnsureSyncRowAnchorsResult;
  readonly snapshot: SyncSheetsSnapshot;
  /** Optional diagnostic phases returned by newer observation providers. */
  readonly timing?: SyncSheetsTiming;
}

/** Optional batch observation capability used to share one remote request. */
export interface SyncSheetsObservationBatchProvider extends SyncSheetsObservationProvider {
  observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot>;
  observeSnapshots(
    requests: readonly ReadSyncSnapshotRequest[],
  ): Promise<readonly SyncObservedSnapshot[]>;
}

/** Returns whether a provider supports the one-request observation path. */
export function isSyncSheetsObservationBatchProvider(
  provider: SyncSheetsObservationProvider,
): provider is SyncSheetsObservationBatchProvider {
  return "observeSnapshot" in provider &&
    typeof provider.observeSnapshot === "function" &&
    "observeSnapshots" in provider &&
    typeof provider.observeSnapshots === "function";
}

/** Reads one snapshot with one combined request when the provider supports it. */
export async function observeSyncSnapshot(
  provider: SyncSheetsObservationProvider,
  request: ReadSyncSnapshotRequest,
): Promise<SyncObservedSnapshot> {
  if (isSyncSheetsObservationBatchProvider(provider)) {
    return provider.observeSnapshot(request);
  }
  const anchors = await provider.ensureRowAnchors(request);
  const snapshot = await provider.readSnapshot(request);
  return { anchors, snapshot };
}

/** Reads several snapshots through one remote operation when available. */
export async function observeSyncSnapshots(
  provider: SyncSheetsObservationProvider,
  requests: readonly ReadSyncSnapshotRequest[],
): Promise<readonly SyncObservedSnapshot[]> {
  if (isSyncSheetsObservationBatchProvider(provider)) {
    return provider.observeSnapshots(requests);
  }
  const results: SyncObservedSnapshot[] = [];
  for (const request of requests) {
    results.push(await observeSyncSnapshot(provider, request));
  }
  return results;
}

/**
 * Serializable projection values written by one outbox effect.
 *
 * `targetVisibleHash` is computed over `fields` with
 * computeSyncVisibleHash().  The anchor is projection-local: User_Input and
 * System_State may represent the same row binding with different anchors.
 */
export interface SyncProjectionEffectPayload {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly schemaVersion: number;
  readonly targetAnchor: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly targetVisibleHash: string;
  readonly createIfMissing: boolean;
  /** A candidate reconcile must fail rather than overwrite an active candidate. */
  readonly expectedCandidateHash: Applicability<string>;
}

/** Provider-ready view of one durable outbox row. */
export interface SyncProjectionEffect {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly effectKind: SyncEffectKind;
  readonly physicalSheetId: string;
  readonly projection: SyncProjection;
  readonly targetKind: EffectTargetKind;
  readonly targetId: string;
  readonly rowBindingId: Presence<string>;
  readonly conflictId: Presence<string>;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly repairGuardHash: Presence<string>;
  readonly payload: SyncProjectionEffectPayload;
}

/** Per-effect terminal/non-terminal provider result. */
export interface SyncEffectResult {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly status: SyncEffectResultStatus;
  readonly visibleRevision: Presence<number>;
  readonly visibleHash: Presence<string>;
  readonly snapshotHash: Presence<string>;
  readonly reason: Presence<string>;
  readonly postcondition: SyncPostconditionStatus;
}

/** Batch request. All effects must target the same physical sheet. */
export interface ApplySyncEffectsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly effects: readonly SyncProjectionEffect[];
  /**
   * Defaults to inline verification for compatibility. The worker explicitly
   * selects deferred verification so recovery/reconciliation owns read-back.
   */
  readonly postconditionMode?: SyncPostconditionMode;
}

/** A batch may intentionally return only a prefix when its budget is exhausted. */
export interface ApplySyncEffectsResult {
  readonly results: readonly SyncEffectResult[];
  readonly snapshotHash: Presence<string>;
  /** True only when the provider intentionally stopped before the supplied suffix. */
  readonly hasMore: boolean;
  /** Optional phase timing returned by newer Code.gs deployments. */
  readonly timing?: SyncSheetsTiming;
}

/** Read-back classification used after a response is lost or a lease expires. */
export interface SyncEffectPostcondition {
  readonly disposition: SyncPostconditionDisposition;
  readonly visibleRevision: Presence<number>;
  readonly visibleHash: Presence<string>;
  readonly snapshotHash: Presence<string>;
  /** Stable diagnostic reason for terminal or manual-repair classifications. */
  readonly reason?: string;
}

/** One effect identity paired with its read-back result in a recovery batch. */
export interface SyncEffectPostconditionResult {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly postcondition: SyncEffectPostcondition;
}

/** One row written through the append-only bulk path.
 *
 * The payload hash lets the provider receipt sheet recognize a response-loss
 * replay without appending the same durable effect twice. The optional shape
 * keeps older direct adapter fixtures source-compatible; worker-produced rows
 * always carry the SQLite outbox payload hash.
 */
export interface FastAppendRow {
  readonly effectId: string;
  readonly payloadHash?: string;
  /** Developer-metadata row anchor written in the same Sheets batch. */
  readonly anchor?: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  /**
   * Optional per-row route so one fast-append request can span multiple tabs.
   * When absent the provider falls back to the request-level route (single
   * tab, the legacy shape). The dispatcher populates these from each effect.
   */
  readonly physicalSheetId?: string;
  readonly projection?: SyncProjection;
  readonly sheetName?: string;
  readonly registeredRange?: string;
  readonly schemaVersion?: number;
}

/** Per-effect result for one fast-append row. */
export interface FastAppendRowResult {
  readonly effectId: string;
  /** The row was included in the provider's bulk write. */
  readonly status: SyncFastAppendStatus;
  /** Receipt-backed evidence returned by the provider append operation. */
  readonly visibleHash?: string;
  readonly visibleRevision?: number;
}

/** Bounded idempotent append request for one registered projection sheet. */
export interface FastAppendRowsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly rows: readonly FastAppendRow[];
}

/** Result of one bounded fast-append batch. */
export interface FastAppendRowsResult {
  readonly results: readonly FastAppendRowResult[];
  /** True when the provider intentionally stopped before the supplied suffix. */
  readonly hasMore: boolean;
  /** Optional phase timing returned by newer Code.gs deployments. */
  readonly timing?: SyncSheetsTiming;
}

/** Request used to classify several response-loss effects with one Sheet read. */
export interface ReadSyncEffectPostconditionsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly effects: readonly SyncProjectionEffect[];
}

/**
 * Prepared-apply state carried from `preflightApplyEffects` to
 * `applyPreparedEffects`.
 *
 * The worker treats the value as an opaque token and never inspects it; the
 * provider owns its concrete shape and narrows it back with a runtime `kind`
 * guard at the `applyPreparedEffects` boundary. Only the shared discriminant
 * and the request the state was preflighted from are declared here so
 * unrelated providers cannot invent a conflicting shape across the interface
 * and so the dispatcher can bind the prepared state to the exact request it
 * was created for.
 */
export interface PreparedApplyEffects {
  readonly kind: "single" | "multi";
  /** The exact request this prepared state was preflighted from. */
  readonly request: ApplySyncEffectsRequest;
}

/**
 * Full effect capability required for fast append, regular updates, deletes,
 * and recovery.
 *
 * `preflightApplyEffects` / `applyPreparedEffects` are an OPTIONAL split of
 * `applyEffects`: a preflight does the read+plan stage (no remote mutation)
 * and returns an opaque `PreparedApplyEffects`, which a later
 * `applyPreparedEffects` consumes for the write+verify stage. Providers that
 * implement neither optional method keep the single legacy `applyEffects`
 * path. The worker and dispatcher feature-detect the pair before using it.
 */
export interface SyncEffectWorkerProvider {
  fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult>;
  applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult>;
  /** Optional read+plan stage that produces opaque prepared state. */
  preflightApplyEffects?(request: ApplySyncEffectsRequest): Promise<PreparedApplyEffects>;
  /** Optional write+verify stage that consumes the prepared state. */
  applyPreparedEffects?(prepared: PreparedApplyEffects): Promise<ApplySyncEffectsResult>;
  readEffectPostcondition(effect: SyncProjectionEffect): Promise<SyncEffectPostcondition>;
  readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncEffectPostconditionResult[]>;
}

/** Read-only provider capability used by polling and onEdit observation. */
export interface SyncSheetsObservationProvider {
  ensureRowAnchors(request: EnsureSyncRowAnchorsRequest): Promise<EnsureSyncRowAnchorsResult>;
  readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncSheetsSnapshot>;
}

/** Request for a lightweight table read used by simple polling. */
export interface ReadSyncTableRowsRequest {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: SyncProjection;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
}

/** One nonblank row returned by a lightweight table read. */
export interface SyncTableRow {
  readonly rowNumber: number;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
}

/** Result of a lightweight table read without Sheet metadata or CAS work. */
export interface SyncTableRowsResult {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly headers: readonly string[];
  readonly rows: readonly SyncTableRow[];
  readonly timing?: SyncSheetsTiming;
}

/** Capability for reading literal table values without observation metadata. */
export interface SyncSheetsTableReader {
  readRows(request: ReadSyncTableRowsRequest): Promise<SyncTableRowsResult>;
  readRowsBatch(
    requests: readonly ReadSyncTableRowsRequest[],
  ): Promise<readonly SyncTableRowsResult[]>;
}

/** Returns whether a full observation provider also exposes the values-only reader. */
export function isSyncSheetsTableReader(
  provider: SyncSheetsObservationProvider,
): provider is SyncSheetsObservationProvider & SyncSheetsTableReader {
  return "readRows" in provider &&
    typeof provider.readRows === "function" &&
    "readRowsBatch" in provider &&
    typeof provider.readRowsBatch === "function";
}

/**
 * Full provider boundary used by observation and reconciliation.
 *
 * It includes the full effect-worker capabilities plus the metadata/snapshot
 * reads required to observe user edits and repair projection drift.
 */
export interface SyncSheetsProvider extends SyncEffectWorkerProvider, SyncSheetsObservationProvider {}

/** Computes the stable visible-state hash shared by fake and real providers. */
export function computeSyncVisibleHash(fields: Readonly<Record<string, NormalizedCell>>): string {
  const entries = Object.entries(fields)
    // Apps Script's operation sources use the same UTF-16 code-unit order.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([fieldName, value]) => ({ fieldName, value }));
  return stableHash({ fields: entries });
}

/** Validates and decodes the projection payload stored in a durable outbox row. */
export function parseSyncProjectionEffectPayload(value: string): SyncProjectionEffectPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "effect payload is not valid JSON",
    );
  }

  const parsed = syncProjectionEffectPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      `effect payload has an invalid shape: ${formatZodBoundaryIssues(parsed.error)}`,
    );
  }

  const {
    sheetName,
    registeredRange,
    schemaVersion,
    targetAnchor,
    fields,
    targetVisibleHash,
    createIfMissing,
    expectedCandidateHash: wireCandidateHash,
  } = parsed.data;
  if (Object.keys(fields).length === 0) {
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "effect payload must contain a field",
    );
  }
  if (computeSyncVisibleHash(fields) !== targetVisibleHash) {
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "effect payload targetVisibleHash does not match its fields",
    );
  }

  return {
    sheetName,
    registeredRange,
    schemaVersion,
    targetAnchor,
    fields,
    targetVisibleHash,
    createIfMissing,
    expectedCandidateHash: parseNullableCandidateHash(wireCandidateHash),
  };
}

/** Serializes a checked projection payload in a stable key order for outbox use. */
export function serializeSyncProjectionEffectPayload(payload: SyncProjectionEffectPayload): string {
  // Validate before serialization so worker and provider fail at the same boundary.
  const checked = parseSyncProjectionEffectPayload(
    JSON.stringify(toWireProjectionEffectPayload(payload)),
  );
  return JSON.stringify({
    sheetName: checked.sheetName,
    registeredRange: checked.registeredRange,
    schemaVersion: checked.schemaVersion,
    targetAnchor: checked.targetAnchor,
    fields: Object.fromEntries(Object.entries(checked.fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    targetVisibleHash: checked.targetVisibleHash,
    createIfMissing: checked.createIfMissing,
    expectedCandidateHash: toNullableCandidateHash(checked.expectedCandidateHash),
  });
}

function parseNullableCandidateHash(value: unknown): Applicability<string> {
  if (value === null) {
    return notApplicableValue();
  }
  return applicableValue(
    requireSyncSheetsText(
      value,
      "effect payload expectedCandidateHash",
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    ),
  );
}

interface SyncProjectionEffectPayloadWire {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly schemaVersion: number;
  readonly targetAnchor: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly targetVisibleHash: string;
  readonly createIfMissing: boolean;
  /** `null` is retained only at the JSON transport boundary. */
  readonly expectedCandidateHash: string | null;
}

function toWireProjectionEffectPayload(
  payload: SyncProjectionEffectPayload,
): SyncProjectionEffectPayloadWire {
  return {
    sheetName: payload.sheetName,
    registeredRange: payload.registeredRange,
    schemaVersion: payload.schemaVersion,
    targetAnchor: payload.targetAnchor,
    fields: payload.fields,
    targetVisibleHash: payload.targetVisibleHash,
    createIfMissing: payload.createIfMissing,
    expectedCandidateHash: toNullableCandidateHash(payload.expectedCandidateHash),
  };
}

function toNullableCandidateHash(value: Applicability<string>): string | null {
  return value.kind === APPLICABILITY_KINDS.APPLICABLE ? value.value : null;
}
