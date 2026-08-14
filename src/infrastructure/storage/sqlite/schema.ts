/**
 * SQLite schema and migration DDL for the SQLite-authoritative sync storage layer.
 *
 * Implements the logical schema owned by this module. All identity constraints,
 * unique indexes, and foreign keys are fixed here.
 *
 * Table creation order is parent-first. Deletion order is child-first.
 */

import {
  EFFECT_OUTBOX_DDL,
  REQUIRED_V5_COLUMNS as KERNEL_REQUIRED_V5_COLUMNS,
  VISIBLE_STATE_TABLES_DDL,
  WRITER_LEASE_DDL,
} from "@hikoutei/ikisaki";

/**
 * The outbox kernel owns the required-column contracts and the v5 probe
 * index for the durable delivery columns; the sheets-authority columns and
 * the remaining tables stay here.
 */
export { REQUIRED_V3_COLUMNS } from "@hikoutei/ikisaki";
export { syncSchemaV5IndexesDdl } from "@hikoutei/ikisaki";

/** Current durable schema version managed by the provider migration. */
export const CURRENT_SCHEMA_VERSION = 7;

/** Observable result of bringing one SQLite database to the current schema. */
export interface SchemaMigrationResult {
  readonly fromVersion: number;
  readonly toVersion: number;
  /** Versions newly applied during this call; empty means already current. */
  readonly appliedVersions: readonly number[];
}

/** Connection settings required by every typed-sheets SQLite store. */
export const SQLITE_CONNECTION_PRAGMAS = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
`;

/** Columns that must exist before a version-two-or-later marker is trusted. */
export const REQUIRED_V2_COLUMNS: Readonly<
  Record<"sync_conflict" | "resolution_command", readonly string[]>
> = {
  sync_conflict: [
    "conflict_id",
    "conflict_group_id",
    "event_id",
    "logical_sheet_id",
    "entity_id",
    "row_binding_id",
    "field_name",
    "user_value",
    "user_base_revision",
    "canonical_value_at_detection",
    "canonical_revision_at_detection",
    "current_canonical_value",
    "current_canonical_revision",
    "candidate_epoch",
    "status",
    "last_rebased_commit_id",
    "resolution_command_id",
    "created_at",
    "updated_at",
  ],
  resolution_command: [
    "command_id",
    "request_key",
    "action",
    "actor_id",
    "role",
    "target_conflict_id",
    "expected_revision",
    "active_candidate_hash",
    "expected_candidate_epoch",
    "payload_hash",
    "status",
    "issued_at",
    "applied_commit_id",
  ],
};

/** Columns required before the durable uncertain-delivery marker is trusted. */
export const REQUIRED_V5_SCHEMA_COLUMNS: Readonly<
  Record<"spreadsheet_authority", readonly string[]>
> = {
  spreadsheet_authority: [
    "spreadsheet_id",
    "owner_id",
    "authority_epoch",
    "authority_token",
    "updated_at",
  ],
};

/**
 * Merges the outbox kernel's required columns with the sheets-authority
 * columns so the migration can verify both tables from one map.
 */
export const REQUIRED_V5_COLUMNS: Readonly<
  Record<"sheet_effect_outbox" | "spreadsheet_authority", readonly string[]>
> = {
  ...KERNEL_REQUIRED_V5_COLUMNS,
  ...REQUIRED_V5_SCHEMA_COLUMNS,
};

/** Candidate-evidence columns added to sync_conflict by the v6 migration. */
export const REQUIRED_V6_COLUMNS: Readonly<
  Record<"sync_conflict", readonly string[]>
> = {
  sync_conflict: ["candidate_visible_revision", "candidate_visible_hash"],
};

/** Ordered projection headers added to physical registry rows by v7. */
export const REQUIRED_V7_COLUMNS: Readonly<
  Record<"physical_sheet_registry", readonly string[]>
> = {
  physical_sheet_registry: ["projection_headers_json"],
};

/** Returns table DDL only, so migration transactions never change connection pragmas. */
export function syncSchemaTablesDdl(): string {
  return [
    REGISTRY_TABLES_DDL,
    IDENTITY_TABLES_DDL,
    CANONICAL_STATE_TABLES_DDL,
    VISIBLE_STATE_TABLES_DDL,
    EVENT_LEDGER_TABLES_DDL,
    CONFLICT_AND_QUARANTINE_TABLES_DDL,
    BUSINESS_KEY_INDEX_DDL,
    EFFECT_OUTBOX_DDL,
    WRITER_LEASE_DDL,
  ].join("\n");
}

/**
 * Creates indexes that depend on additive migration columns only after those
 * columns have been confirmed. This keeps a version-one upgrade ordered.
 */
export function syncSchemaIndexesDdl(): string {
  return `
    CREATE UNIQUE INDEX IF NOT EXISTS sync_conflict_candidate_attempt_uq
      ON sync_conflict(row_binding_id, field_name, candidate_epoch);
  `;
}

const REGISTRY_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS sheet_registry (
    sheet_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    ownership_manifest_json TEXT NOT NULL,
    business_key_field TEXT NOT NULL,
    locale TEXT,
    timezone TEXT,
    anchor_mode TEXT NOT NULL DEFAULT 'business_key',
    stable_encode_version TEXT NOT NULL DEFAULT 'stable_encode_v1',
    enabled INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS physical_sheet_registry (
    physical_sheet_id TEXT PRIMARY KEY,
    logical_sheet_id TEXT NOT NULL REFERENCES sheet_registry(sheet_id),
    spreadsheet_id TEXT NOT NULL,
    tab_name TEXT NOT NULL,
    registered_range TEXT NOT NULL,
    projection TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    projection_headers_json TEXT NOT NULL DEFAULT '[]',
    anchor_mode TEXT NOT NULL DEFAULT 'business_key',
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(spreadsheet_id, tab_name, registered_range, projection)
  );

  CREATE TABLE IF NOT EXISTS spreadsheet_authority (
    spreadsheet_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    authority_epoch INTEGER NOT NULL,
    authority_token TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

const IDENTITY_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS row_binding (
    row_binding_id TEXT PRIMARY KEY,
    logical_sheet_id TEXT NOT NULL REFERENCES sheet_registry(sheet_id),
    anchor_reference TEXT NOT NULL,
    entity_id TEXT,
    last_business_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('candidate', 'active', 'tombstoned', 'ambiguous')),
    candidate_epoch INTEGER NOT NULL DEFAULT 0,
    UNIQUE(logical_sheet_id, anchor_reference)
  );

  CREATE TABLE IF NOT EXISTS projection_row_binding (
    projection_row_id TEXT PRIMARY KEY,
    physical_sheet_id TEXT NOT NULL REFERENCES physical_sheet_registry(physical_sheet_id),
    row_binding_id TEXT REFERENCES row_binding(row_binding_id),
    conflict_id TEXT,
    anchor_reference TEXT NOT NULL,
    physical_row_locator INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    CHECK ((row_binding_id IS NOT NULL) != (conflict_id IS NOT NULL)),
    UNIQUE(physical_sheet_id, anchor_reference)
  );

  CREATE UNIQUE INDEX IF NOT EXISTS projection_row_binding_entity_uq
    ON projection_row_binding(physical_sheet_id, row_binding_id)
    WHERE row_binding_id IS NOT NULL;

  CREATE UNIQUE INDEX IF NOT EXISTS projection_row_binding_conflict_uq
    ON projection_row_binding(physical_sheet_id, conflict_id)
    WHERE conflict_id IS NOT NULL;
`;

const CANONICAL_STATE_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS entity_state (
    entity_id TEXT PRIMARY KEY,
    entity_revision INTEGER NOT NULL,
    accepted_snapshot_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS entity_field_state (
    entity_id TEXT NOT NULL REFERENCES entity_state(entity_id),
    field_name TEXT NOT NULL,
    normalized_value TEXT NOT NULL,
    field_revision INTEGER NOT NULL,
    ownership TEXT NOT NULL CHECK (ownership IN ('user', 'system')),
    PRIMARY KEY(entity_id, field_name)
  );
`;

const EVENT_LEDGER_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS event_batch (
    batch_id TEXT PRIMARY KEY,
    logical_sheet_id TEXT NOT NULL REFERENCES sheet_registry(sheet_id),
    physical_sheet_id TEXT NOT NULL REFERENCES physical_sheet_registry(physical_sheet_id),
    source TEXT NOT NULL,
    projection TEXT NOT NULL,
    atomicity TEXT NOT NULL DEFAULT 'row_independent',
    base_snapshot_hash TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS event_log (
    event_id TEXT PRIMARY KEY,
    logical_sheet_id TEXT NOT NULL,
    physical_sheet_id TEXT NOT NULL,
    event_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    event_sequence INTEGER NOT NULL,
    batch_id TEXT NOT NULL REFERENCES event_batch(batch_id),
    row_binding_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('accepted', 'conflict', 'quarantined')),
    received_at INTEGER NOT NULL,
    UNIQUE(logical_sheet_id, event_key)
  );

  CREATE TABLE IF NOT EXISTS event_observation (
    observation_id TEXT PRIMARY KEY,
    logical_sheet_id TEXT NOT NULL,
    physical_sheet_id TEXT NOT NULL,
    observation_key TEXT NOT NULL,
    event_id TEXT,
    source TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    redacted_at INTEGER,
    ingress_actor_id TEXT NOT NULL,
    editor_actor_id TEXT,
    editor_actor_source TEXT NOT NULL DEFAULT 'unavailable'
  );

  CREATE TABLE IF NOT EXISTS observation_receipt (
    logical_sheet_id TEXT NOT NULL,
    observation_key TEXT NOT NULL,
    representative_payload_hash TEXT NOT NULL,
    first_observation_id TEXT NOT NULL,
    last_observation_id TEXT NOT NULL,
    event_id TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'evaluated', 'duplicate', 'quarantined')),
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    redacted_at INTEGER,
    PRIMARY KEY(logical_sheet_id, observation_key)
  );

  CREATE TABLE IF NOT EXISTS event_row (
    event_id TEXT PRIMARY KEY REFERENCES event_log(event_id),
    before_row_json TEXT,
    after_row_json TEXT,
    before_hash TEXT,
    after_hash TEXT
  );

  CREATE TABLE IF NOT EXISTS event_field (
    event_id TEXT NOT NULL REFERENCES event_log(event_id),
    field_name TEXT NOT NULL,
    previous_value TEXT,
    next_value TEXT,
    base_field_revision INTEGER,
    PRIMARY KEY(event_id, field_name)
  );
`;

const CONFLICT_AND_QUARANTINE_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS sync_conflict (
    conflict_id TEXT PRIMARY KEY,
    conflict_group_id TEXT,
    event_id TEXT NOT NULL REFERENCES event_log(event_id),
    logical_sheet_id TEXT NOT NULL REFERENCES sheet_registry(sheet_id),
    entity_id TEXT NOT NULL,
    row_binding_id TEXT NOT NULL REFERENCES row_binding(row_binding_id),
    field_name TEXT NOT NULL,
    user_value TEXT NOT NULL,
    user_base_revision INTEGER NOT NULL,
    canonical_value_at_detection TEXT NOT NULL,
    canonical_revision_at_detection INTEGER NOT NULL,
    current_canonical_value TEXT NOT NULL,
    current_canonical_revision INTEGER NOT NULL,
    candidate_epoch INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'NEEDS_REBASE', 'RESOLVED')),
    last_rebased_commit_id TEXT,
    resolution_command_id TEXT,
    /* v6: candidate-time full-row visible evidence used as resolution CAS. */
    candidate_visible_revision INTEGER,
    candidate_visible_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS quarantine_record (
    quarantine_id TEXT PRIMARY KEY,
    event_id TEXT,
    observation_id TEXT,
    logical_sheet_id TEXT NOT NULL REFERENCES sheet_registry(sheet_id),
    row_binding_id TEXT,
    reason TEXT NOT NULL,
    before_row_json TEXT,
    after_row_json TEXT,
    fields_json TEXT NOT NULL,
    repair_fields_json TEXT NOT NULL DEFAULT '[]',
    repair_state TEXT,
    candidate_payload_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS resolution_command (
    command_id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    action TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    role TEXT NOT NULL,
    target_conflict_id TEXT NOT NULL REFERENCES sync_conflict(conflict_id),
    expected_revision INTEGER NOT NULL,
    active_candidate_hash TEXT NOT NULL,
    expected_candidate_epoch INTEGER NOT NULL DEFAULT 0,
    payload_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'applied', 'stale', 'rejected', 'failed')),
    issued_at INTEGER NOT NULL,
    applied_commit_id TEXT
  );
`;

const BUSINESS_KEY_INDEX_DDL = `
  CREATE TABLE IF NOT EXISTS business_key_index (
    logical_sheet_id TEXT NOT NULL REFERENCES sheet_registry(sheet_id),
    field_name TEXT NOT NULL,
    normalized_key TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active'
  );

  CREATE UNIQUE INDEX IF NOT EXISTS business_key_active_uq
    ON business_key_index(logical_sheet_id, field_name, normalized_key)
    WHERE state = 'active';
`;
