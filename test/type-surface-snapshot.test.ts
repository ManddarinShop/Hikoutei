/**
 * Code-surface freeze snapshot (Terra Phase 7b recommendations).
 *
 * Three pins in one file:
 *
 * 1. Type-only export pin — the 14 type-only contracts on the root public
 *    barrel (`src/index.ts`) must keep their exact names. These symbols have
 *    no runtime value to snapshot, so each is pinned by a compile-time type
 *    reference to `import("../src/index.js").<Name>`: deleting or renaming
 *    any pinned type makes this file fail `typecheck:test` (TS2694/TS2305)
 *    before vitest even loads it.
 * 2. Error-vocabulary freeze — the full code-string vocabulary of every
 *    maintained error-code table is snapshotted as sorted `toEqual`
 *    baselines. These code strings are persisted values (SQLite
 *    `last_error_code`, structured CLI failures); renaming or deleting one
 *    must break this test and force a conscious review.
 * 3. `bin` pin — the package.json `bin` mapping must keep pointing the
 *    registered CLI entry at the compiled root of `src/cli/index.ts`.
 *
 * The logEvents allowlist is pinned separately in
 * `log-event-registry-contract.test.ts` and intentionally not duplicated here.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HIKOUTEI_ERROR_CODES } from "@hikoutei/sync-engine/api/errors.js";
import { SETUP_ERROR_CODES } from "@hikoutei/cli/errors.js";
import { SYNC_SERVICE_ERROR_CODES } from "@hikoutei/sync-engine/sync/service/errors.js";
import {
  SYNC_SHEETS_ERROR_CODES,
} from "@hikoutei/contracts/sheets/errors.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/errors.js";
import { STORAGE_ERROR_CODES } from "@hikoutei/storage/storage/errors.js";
import { TYPED_SHEETS_ORM_ERROR_CODES } from "@hikoutei/sync-engine/orm/errors.js";
import {
  HIKOUTEI_SYNC_STATUS_ERROR_CODES,
} from "../src/internal/syncStatus.js";

// ---------------------------------------------------------------------------
// 1. Type-only export pin (14 pinned types)
// ---------------------------------------------------------------------------

/**
 * The 14 type-only root exports pinned by name. Exactly the Terra audit
 * line set: `entity.ts` (26/47/50/82/90/96), `syncRuntime.ts`
 * (32/67/76/109/116/122/150), and `query.ts` (21, re-exported through the
 * manager module) — all reachable from `src/index.ts`.
 *
 * Each lines-up alias below resolves ONLY while the eponymous type exists
 * on the root barrel; the tuple reference keeps every alias live so an
 * unused-alias lint cannot silently drop the pin.
 */
type _AdoptEntitySpec = import("../src/index.js").AdoptEntitySpec;
type _AdoptionColumnBinding = import("../src/index.js").AdoptionColumnBinding;
type _AdoptionProblem = import("../src/index.js").AdoptionProblem;
type _AdoptionRunReport = import("../src/index.js").AdoptionRunReport;
type _CreateTypedSheetsWithSyncOptions =
  import("../src/index.js").CreateTypedSheetsWithSyncOptions;
type _HikouteiEntityDescriptorInput =
  import("../src/index.js").HikouteiEntityDescriptorInput;
type _HikouteiEntityInstance = import("../src/index.js").HikouteiEntityInstance<import("../src/index.js").HikouteiPropertyDescriptorMap>;
type _HikouteiPropertyValueType = import("../src/index.js").HikouteiPropertyValueType<import("../src/index.js").HikouteiPropertyOptions>;
type _HikouteiPropertyDescriptorMap =
  import("../src/index.js").HikouteiPropertyDescriptorMap;
type _HikouteiScalarType = import("../src/index.js").HikouteiScalarType;
type _HikouteiScalarValueType = import("../src/index.js").HikouteiScalarValueType<"string">;
type _HikouteiSortDirection = import("../src/index.js").HikouteiSortDirection;
type _LocalSyncRuntimeResult = import("../src/index.js").LocalSyncRuntimeResult;
type _RunningSyncServiceResult = import("../src/index.js").RunningSyncServiceResult;

/** Every pinned type alias is exercised here; deleting its import breaks compile. */
type PinnedTypeExports = [
  _AdoptEntitySpec,
  _AdoptionColumnBinding,
  _AdoptionProblem,
  _AdoptionRunReport,
  _CreateTypedSheetsWithSyncOptions,
  _HikouteiEntityDescriptorInput,
  _HikouteiEntityInstance,
  _HikouteiPropertyDescriptorMap,
  _HikouteiPropertyValueType,
  _HikouteiScalarType,
  _HikouteiScalarValueType,
  _HikouteiSortDirection,
  _LocalSyncRuntimeResult,
  _RunningSyncServiceResult,
];
void (null as unknown as PinnedTypeExports);

/** The exact pinned type names; must stay in sync with the aliases above. */
const PINNED_TYPE_EXPORT_NAMES = [
  "AdoptEntitySpec",
  "AdoptionColumnBinding",
  "AdoptionProblem",
  "AdoptionRunReport",
  "CreateTypedSheetsWithSyncOptions",
  "HikouteiEntityDescriptorInput",
  "HikouteiEntityInstance",
  "HikouteiPropertyDescriptorMap",
  "HikouteiPropertyValueType",
  "HikouteiScalarType",
  "HikouteiScalarValueType",
  "HikouteiSortDirection",
  "LocalSyncRuntimeResult",
  "RunningSyncServiceResult",
] as const;

describe("type-only public export pin (14 types)", () => {
  it("pins exactly the Terra-audited 14 type-only root exports by name", () => {
    expect([...PINNED_TYPE_EXPORT_NAMES].sort()).toEqual([
      "AdoptEntitySpec",
      "AdoptionColumnBinding",
      "AdoptionProblem",
      "AdoptionRunReport",
      "CreateTypedSheetsWithSyncOptions",
      "HikouteiEntityDescriptorInput",
      "HikouteiEntityInstance",
      "HikouteiPropertyDescriptorMap",
      "HikouteiPropertyValueType",
      "HikouteiScalarType",
      "HikouteiScalarValueType",
      "HikouteiSortDirection",
      "LocalSyncRuntimeResult",
      "RunningSyncServiceResult",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Error-vocabulary freeze snapshots
// ---------------------------------------------------------------------------

/** Sorted full code-string vocabulary of one error-code table. */
function sortedCodes(codes: Readonly<Record<string, string>>): string[] {
  return Object.values(codes).sort();
}

describe("error-vocabulary freeze snapshots (persisted code strings)", () => {
  it("freezes the public Hikoutei API error vocabulary (HIKOUTEI_ERROR_CODES)", () => {
    expect(sortedCodes(HIKOUTEI_ERROR_CODES)).toEqual([
      "duplicate_entity",
      "entity_identity_conflict",
      "entity_not_found",
      "entity_primary_key_mutation",
      "entity_primary_key_unavailable",
      "invalid_entity_descriptor",
      "invalid_query",
      "invalid_scalar_value",
      "sync_auth_failed",
      "sync_credentials_field_missing",
      "sync_credentials_file_missing",
      "sync_credentials_invalid_json",
      "sync_provisioning_failed",
      "sync_spreadsheet_access_denied",
      "sync_spreadsheet_not_found",
      "sync_spreadsheet_url_invalid",
      "sync_startup_failed",
      "unmanaged_entity",
      "unregistered_entity",
    ]);
  });

  it("freezes the setup CLI error vocabulary (SETUP_ERROR_CODES)", () => {
    expect(sortedCodes(SETUP_ERROR_CODES)).toEqual([
      "api_enable_failed",
      "checkpoint_temp_exists",
      "checkpoint_temp_path_changed",
      "checkpoint_temp_permission_verify_failed",
      "gcloud_drive_access_required",
      "gcloud_login_failed",
      "gcloud_missing",
      "gcloud_not_logged_in",
      "invalid_args",
      "key_create_failed",
      "key_create_uncertain",
      "output_aliases_reserved",
      "output_dir_fsync_close_failed",
      "output_dir_fsync_open_failed",
      "output_not_regular_file",
      "output_symlink_refused",
      "output_temp_conflict",
      "output_temp_path_changed",
      "output_temp_permission_verify_failed",
      "output_write_failed",
      "project_create_failed",
      "project_not_found",
      "project_select_failed",
      "sa_access_verify_failed",
      "sa_create_failed",
      "setup_dir_fsync_close_failed",
      "setup_dir_fsync_open_failed",
      "setup_in_progress",
      "setup_lock_failed",
      "setup_output_rename_durable_failed",
      "setup_rename_durable_failed",
      "setup_state_conflict",
      "setup_state_invalid",
      "setup_state_write_failed",
      "setup_write_no_progress",
      "sheet_create_failed",
      "sheet_create_uncertain",
      "sheet_share_failed",
      "unsupported_platform",
      "user_token_failed",
    ]);
  });

  it("freezes the sync service error vocabulary (SYNC_SERVICE_ERROR_CODES)", () => {
    expect(sortedCodes(SYNC_SERVICE_ERROR_CODES)).toEqual([
      "existing_sheet_adoption_cell_kind_mismatch",
      "existing_sheet_adoption_dry_run_report",
      "invalid_sync_projection_config",
      "invalid_sync_service_options",
      "sync_provider_unavailable",
      "sync_service_startup_failed",
    ]);
  });

  it("freezes the sync provider-contract error vocabulary (SYNC_SHEETS_ERROR_CODES)", () => {
    expect(sortedCodes(SYNC_SHEETS_ERROR_CODES)).toEqual([
      "invalid_fake_sync_provider_input",
      "invalid_sync_client_options",
      "invalid_sync_effect_payload",
      "invalid_sync_provider_response",
      "invalid_sync_provisioning",
    ]);
  });

  it("freezes the Google Sheets transport error vocabulary (GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES)", () => {
    expect(sortedCodes(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES)).toEqual([
      "google_sheets_api_http_error",
      "google_sheets_api_invalid_response",
      "google_sheets_api_network_error",
      "google_sheets_api_request_start_refused",
      "google_sheets_api_timeout",
    ]);
  });

  it("freezes the mapping layer error vocabulary (TYPED_SHEETS_ORM_ERROR_CODES)", () => {
    expect(sortedCodes(TYPED_SHEETS_ORM_ERROR_CODES)).toEqual([
      "canonical_commit_rejected",
      "duplicate_entity_mapping",
      "entity_mapping_not_found",
      "entity_primary_key_mismatch",
      "entity_primary_key_mutation",
      "entity_primary_key_unavailable",
      "invalid_entity_mapping",
      "invalid_mapped_field_value",
      "observation_entity_mutation_failed",
      "projection_outbox_blocked",
      "row_binding_conflict",
      "writer_lease_unavailable",
    ]);
  });

  it("freezes the storage error vocabulary (STORAGE_ERROR_CODES — the SQLite last_error_code baseline)", () => {
    expect(sortedCodes(STORAGE_ERROR_CODES)).toEqual([
      "effect_replan_conflict",
      "effect_write_failed",
      "invalid_effect_options",
      "invalid_effect_result",
      "invalid_observation_input",
      "invalid_pending_effect",
      "invalid_projection_confirmation",
      "invalid_resolution_command",
      "invalid_sql_script",
      "invalid_stored_conflict",
      "invalid_sync_registration",
      "invalid_writer_lease_options",
      "observation_audit_serialization_failed",
      "observation_storage_inconsistent",
      "projection_confirmation_regression",
      "resolution_command_identity_conflict",
      "resolution_effect_conflict",
      "resolution_storage_inconsistent",
      "resolution_target_unavailable",
      "schema_column_missing",
      "schema_index_missing",
      "schema_table_missing",
      "schema_version_invalid",
      "schema_version_too_new",
      "stale_writer_fence",
      "sync_registration_conflict",
      "sync_registration_write_failed",
      "sync_registry_target_unavailable",
    ]);
  });

  it("freezes the internal sync-status reader error vocabulary (HIKOUTEI_SYNC_STATUS_ERROR_CODES)", () => {
    expect(sortedCodes(HIKOUTEI_SYNC_STATUS_ERROR_CODES)).toEqual([
      "invalid_db_name",
      "open_failed",
      "read_failed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. bin pin
// ---------------------------------------------------------------------------

const repoRoot = dirname(fileURLToPath(import.meta.url)) + "/..";

const packageJson = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
) as {
  name: string;
  bin: Record<string, string>;
};

describe("package.json bin pin", () => {
  it("registers the hikoutei CLI at the compiled root of packages/cli/src/index.ts", () => {
    // The bin dist path is produced by the reconcile codemod bundling the
    // cli package's dist into `dist/cli/**`; the source file must exist so
    // the bin entry can never silently dangle.
    expect(packageJson.bin).toEqual({ hikoutei: "./dist/cli/index.js" });
    expect(existsSync(join(repoRoot, "packages/cli/src/index.ts"))).toBe(true);
    expect(existsSync(join(repoRoot, "packages/cli/src/index.js"))).toBe(false);
  });
});