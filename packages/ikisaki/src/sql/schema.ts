/**
 * SQLite DDL owned by the consistency-queue kernel.
 *
 * The kernel owns the tables its SQL writes: the durable effect outbox, the
 * writer lease, and the confirmed-delivery mirror. Column and table names are
 * persisted contract and must never change. Foreign keys reference host
 * registry tables; the host schema composes this DDL into its full schema.
 */

/** Columns that must exist before a version-three-or-later marker is trusted. */
export const REQUIRED_V3_COLUMNS: Readonly<Record<"sheet_effect_outbox", readonly string[]>> = {
  sheet_effect_outbox: ["effect_id", "created_at"],
};

/** Columns required before the durable uncertain-delivery marker is trusted. */
export const REQUIRED_V5_COLUMNS: Readonly<Record<"sheet_effect_outbox", readonly string[]>> = {
  sheet_effect_outbox: [
    "effect_id",
    "created_at",
    "next_attempt_at",
    "uncertain_since",
    "next_probe_at",
    "dispatch_id",
  ],
};

/**
 * Creates indexes that depend on v5-only outbox columns.
 *
 * `effect_outbox_probe_idx` must never run as part of the base table DDL:
 * pre-v5 databases lack `next_probe_at`, so a v4 installation would fail
 * before the v5 rebuild. The migration runs this only after the durable
 * delivery columns exist.
 */
export function syncSchemaV5IndexesDdl(): string {
  return `
    CREATE INDEX IF NOT EXISTS effect_outbox_probe_idx
      ON sheet_effect_outbox(next_probe_at, logical_sheet_id, physical_sheet_id)
      WHERE status = 'delivery_uncertain';
  `;
}

/** Durable outbox table DDL plus its stream-ordering index. */
export const EFFECT_OUTBOX_DDL = `
  CREATE TABLE IF NOT EXISTS sheet_effect_outbox (
    effect_id TEXT PRIMARY KEY,
    effect_kind TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    logical_sheet_id TEXT NOT NULL REFERENCES sheet_registry(sheet_id),
    physical_sheet_id TEXT NOT NULL REFERENCES physical_sheet_registry(physical_sheet_id),
    projection TEXT NOT NULL,
    row_binding_id TEXT,
    conflict_id TEXT,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('entity', 'row_binding', 'projection_row', 'conflict')),
    target_id TEXT NOT NULL,
    target_entity_revision INTEGER,
    target_field_revision_hash TEXT,
    target_canonical_commit_id TEXT,
    expected_visible_revision INTEGER NOT NULL,
    expected_visible_hash TEXT NOT NULL,
    repair_guard_hash TEXT,
    source_quarantine_id TEXT,
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    effect_dedupe_key TEXT NOT NULL UNIQUE,
    stream_sequence INTEGER NOT NULL,
    predecessor_effect_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivery_uncertain', 'applied', 'blocked_candidate', 'superseded', 'conflict', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    next_attempt_at INTEGER,
    uncertain_since INTEGER,
    next_probe_at INTEGER,
    dispatch_id TEXT,
    claim_token TEXT,
    writer_epoch INTEGER,
    supersedes_effect_id TEXT,
    last_error_code TEXT,
    last_error_message TEXT,
    created_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE(logical_sheet_id, target_kind, target_id, stream_sequence)
  );

  CREATE INDEX IF NOT EXISTS effect_outbox_stream_idx
    ON sheet_effect_outbox(logical_sheet_id, target_kind, target_id, stream_sequence)
    WHERE status IN ('pending', 'processing', 'delivery_uncertain');
`;

/** Writer-lease table DDL backing every fenced queue mutation. */
export const WRITER_LEASE_DDL = `
  CREATE TABLE IF NOT EXISTS writer_lease (
    role TEXT PRIMARY KEY,
    writer_id TEXT NOT NULL,
    writer_epoch INTEGER NOT NULL,
    fencing_token TEXT NOT NULL,
    lease_until INTEGER NOT NULL
  );
`;

/** Confirmed-delivery mirror tables updated by the apply-result path. */
export const VISIBLE_STATE_TABLES_DDL = `
  CREATE TABLE IF NOT EXISTS sheet_visible_state (
    physical_sheet_id TEXT NOT NULL,
    projection TEXT NOT NULL,
    row_binding_id TEXT NOT NULL,
    confirmed_snapshot_hash TEXT NOT NULL,
    confirmed_visible_revision INTEGER NOT NULL,
    confirmed_entity_revision INTEGER,
    last_observed_hash TEXT,
    PRIMARY KEY(physical_sheet_id, projection, row_binding_id),
    FOREIGN KEY(physical_sheet_id) REFERENCES physical_sheet_registry(physical_sheet_id)
  );

  CREATE TABLE IF NOT EXISTS sheet_visible_field_state (
    physical_sheet_id TEXT NOT NULL,
    projection TEXT NOT NULL,
    row_binding_id TEXT NOT NULL,
    field_name TEXT NOT NULL,
    confirmed_field_hash TEXT NOT NULL,
    confirmed_visible_revision INTEGER NOT NULL,
    active_candidate_conflict_id TEXT,
    active_candidate_hash TEXT,
    candidate_epoch INTEGER NOT NULL DEFAULT 0,
    last_observed_field_hash TEXT,
    PRIMARY KEY(physical_sheet_id, projection, row_binding_id, field_name),
    FOREIGN KEY(physical_sheet_id) REFERENCES physical_sheet_registry(physical_sheet_id)
  );
`;
