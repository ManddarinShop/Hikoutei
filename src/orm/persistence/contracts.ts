/**
 * Internal contracts shared by the mapped persistence modules.
 *
 * Public flush options are kept here as well so the coordinator entrypoint can
 * stay focused on orchestration while row, projection, and SQL helpers share a
 * single set of contracts.
 */

import {
  type Applicability,
  type EffectStatus,
  type EffectTargetKind,
  type NormalizedCell,
  type Presence,
} from "../../core/index.js";
import type { RegisteredSyncProjectionDefinition } from "../../runtime/gateway/SyncGatewayBootstrap.js";
import type {
  SyncTimingSink,
} from "../../runtime/telemetry/syncTiming.js";
import type {
  CanonicalCommitInput,
  CanonicalFieldWrite,
  FencingContext,
  NewEffect,
  RegisteredSyncSheet,
} from "../../storage/index.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../adapter/persistence/contracts/sql.js";
import {
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
  type TypedSheetsEntityChange,
  type TypedSheetsFlushContext,
  type TypedSheetsFlushCoordinator,
} from "../api/contracts.js";
import type {
  TypedSheetsEntityFieldMapping,
  TypedSheetsEntityMapping,
  TypedSheetsEntityMappingRegistry,
} from "../mapping/contracts.js";

/** Default lease role used by mapped entity writes. */
export const DEFAULT_MAPPED_WRITER_ROLE = "typed-sheets-entity-writer";

/** Default lease duration used by mapped entity writes. */
export const DEFAULT_MAPPED_WRITER_LEASE_DURATION_MS = 60_000;

/** Effect target kinds emitted by mapped entity persistence. */
export const MAPPED_EFFECT_TARGET_KINDS = {
  ENTITY: "entity",
  PROJECTION_ROW: "projection_row",
} as const satisfies Record<string, EffectTargetKind>;

/** Effect lifecycle states read while deriving the next projection baseline. */
export const MAPPED_EFFECT_STATUSES = {
  PENDING: "pending",
  PROCESSING: "processing",
  APPLIED: "applied",
} as const satisfies Record<string, EffectStatus>;

/** SQL used by mapped persistence to read and create row bindings. */
export const READ_ROW_BINDING_SQL = `
  SELECT logical_sheet_id, anchor_reference, entity_id, state
  FROM row_binding
  WHERE row_binding_id = ?
`;

export const INSERT_ACTIVE_ROW_BINDING_SQL = `
  INSERT INTO row_binding (
    row_binding_id, logical_sheet_id, anchor_reference, entity_id, state
  ) VALUES (?, ?, ?, ?, ?)
`;

export const TOMBSTONE_ACTIVE_ROW_BINDING_SQL = `
  UPDATE row_binding
  SET state = ?
  WHERE row_binding_id = ? AND logical_sheet_id = ? AND entity_id = ? AND state = ?
`;

/** SQL used by mapped persistence to read canonical entity revisions. */
export const READ_ACTIVE_CANONICAL_ENTITY_SQL = `
  SELECT entity_revision
  FROM entity_state
  WHERE entity_id = ? AND status = 'active'
`;

export const READ_CANONICAL_FIELD_REVISIONS_SQL = `
  SELECT field_name, field_revision
  FROM entity_field_state
  WHERE entity_id = ?
`;

/** SQL used by mapped persistence to manage unique business-key ownership. */
export const READ_ACTIVE_BUSINESS_KEY_SQL = `
  SELECT entity_id, normalized_key
  FROM business_key_index
  WHERE logical_sheet_id = ? AND field_name = ? AND entity_id = ? AND state = 'active'
`;

export const READ_BUSINESS_KEY_OWNER_SQL = `
  SELECT entity_id
  FROM business_key_index
  WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ? AND state = 'active'
`;

export const INSERT_ACTIVE_BUSINESS_KEY_SQL = `
  INSERT INTO business_key_index (
    logical_sheet_id, field_name, normalized_key, entity_id, state
  ) VALUES (?, ?, ?, ?, 'active')
`;

export const RETIRE_ACTIVE_BUSINESS_KEY_SQL = `
  UPDATE business_key_index
  SET state = 'inactive'
  WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ?
    AND entity_id = ? AND state = 'active'
`;

export const RETIRE_ENTITY_BUSINESS_KEYS_SQL = `
  UPDATE business_key_index
  SET state = 'inactive'
  WHERE logical_sheet_id = ? AND entity_id = ? AND state = 'active'
`;

/** SQL used to derive the next visible projection baseline. */
export const READ_VISIBLE_PROJECTION_STATE_SQL = `
  SELECT confirmed_snapshot_hash, confirmed_visible_revision
  FROM sheet_visible_state
  WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ?
`;

export const READ_LATEST_PROJECTION_EFFECT_SQL = `
  SELECT physical_sheet_id, projection, status, payload_json,
         expected_visible_revision, expected_visible_hash, stream_sequence
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = ? AND target_id = ?
  ORDER BY stream_sequence DESC
  LIMIT 1
`;

/** Writer identity used to fence mapped entity lifecycle commits. */
export interface TypedSheetsEntityWriterOptions {
  /** Stable process or service identity that owns mapped entity writes. */
  readonly writerId: string;
  /** Lease role. It may differ from the effect worker's role. */
  readonly role?: string;
  /** Writer lease length in milliseconds. */
  readonly leaseDurationMs?: number;
  /** Injectable clock used for deterministic tests and fencing. */
  readonly now?: () => number;
  /** Injectable opaque-ID source used for commit and effect identities. */
  readonly createId?: () => string;
  /** Optional diagnostics sink for append/update/delete flush phases. */
  readonly onTiming?: SyncTimingSink;
}

/** Options for deriving a built-in flush coordinator from mapping metadata. */
export interface CreateMappedTypedSheetsFlushCoordinatorOptions {
  readonly mappings: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[];
  readonly writer: TypedSheetsEntityWriterOptions;
}

/** A registered route with headers ready for Apps Script control-plane provisioning. */
export interface RegisteredTypedSheetsMappedProjection {
  readonly mapping: TypedSheetsEntityMapping;
  readonly sheet: RegisteredSyncSheet;
  readonly headers: readonly string[];
}

/** Normalized writer options used by all persistence helpers. */
export interface ResolvedWriterOptions {
  readonly writerId: string;
  readonly role: string;
  readonly leaseDurationMs: number;
  readonly now: () => number;
  readonly createId: () => string;
  readonly onTiming: SyncTimingSink | undefined;
}

/** Raw row-binding row returned by SQLite. */
export interface RowBindingSqlRow {
  readonly logical_sheet_id: string;
  readonly anchor_reference: string;
  readonly entity_id: string | null;
  readonly state: string;
}

/** Raw canonical entity revision row returned by SQLite. */
export interface CanonicalEntitySqlRow {
  readonly entity_revision: number;
}

/** Raw canonical field revision row returned by SQLite. */
export interface CanonicalFieldRevisionSqlRow {
  readonly field_name: string;
  readonly field_revision: number;
}

/** Raw active business-key row returned by SQLite. */
export interface ActiveBusinessKeySqlRow {
  readonly entity_id: string;
  readonly normalized_key: string;
}

/** Raw business-key owner row returned by SQLite. */
export interface BusinessKeyOwnerSqlRow {
  readonly entity_id: string;
}

/** Raw confirmed visible-state row returned by SQLite. */
export interface VisibleProjectionSqlRow {
  readonly confirmed_snapshot_hash: string;
  readonly confirmed_visible_revision: number;
}

/** Raw latest projection effect row returned by SQLite. */
export interface LatestProjectionEffectSqlRow {
  readonly physical_sheet_id: string;
  readonly projection: string;
  readonly status: EffectStatus;
  readonly payload_json: string;
  readonly expected_visible_revision: number;
  readonly expected_visible_hash: string;
  readonly stream_sequence: number;
}

/** Confirmed or queued baseline used when creating the next projection effect. */
export interface ProjectionBaseline {
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly createIfMissing: boolean;
  readonly streamSequence: number;
}

/** One validated mapped entity lifecycle change and its selected fields. */
export interface MappedChangePlan {
  readonly mapping: TypedSheetsEntityMapping;
  readonly change: TypedSheetsEntityChange;
  readonly changedFields: readonly TypedSheetsEntityFieldMapping[];
}

/** Public coordinator shape re-exported by the persistence barrel. */
export type { TypedSheetsFlushCoordinator, TypedSheetsFlushContext };

/** Keeps the API imports used by persistence modules explicit in one contract file. */
export type {
  CanonicalCommitInput,
  CanonicalFieldWrite,
  FencingContext,
  NewEffect,
  RegisteredSyncProjectionDefinition,
  RegisteredSyncSheet,
  SqlExecutor,
  SqlStorageAdapter,
};

export { TYPED_SHEETS_ENTITY_CHANGE_KINDS };
