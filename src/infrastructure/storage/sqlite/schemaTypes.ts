/** Table names used by the additive SQLite schema migrations. */
export type SchemaMigrationTableName =
  | "sync_conflict"
  | "resolution_command"
  | "sheet_effect_outbox"
  | "spreadsheet_authority";

/** Column names added by the additive SQLite schema migrations. */
export type SchemaMigrationColumnName =
  | "candidate_epoch"
  | "expected_candidate_epoch"
  | "created_at"
  | "uncertain_since"
  | "next_probe_at"
  | "dispatch_id";
