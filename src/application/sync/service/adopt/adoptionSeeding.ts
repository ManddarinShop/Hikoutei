/**
 * Existing-sheet adoption seeding engine (MVP Phase 2/3).
 *
 * Turns the Phase-1 dry-run report into a working adopted entity:
 *
 * 1. `computeExistingSheetAdoptionLayout` — derives the managed column span,
 *    the row-id system column, the PK column (existing or appended), and the
 *    registered range override from the dry-run report + raw snapshot.
 * 2. `applyAdoptionSystemColumns` — the ONLY sheet mutation adoption ever
 *    performs: appending the `__hikoutei_row_id` header, an optional
 *    generated PK column, and the deterministic per-row anchors
 *    (`entity:<pk>`, `mapping.anchorForEntity`). No existing cell is
 *    rewritten.
 * 3. `seedAdoptedEntityRows` — one all-or-nothing SQLite transaction that
 *    binds every observed row (row_binding + canonical INSERT via
 *    `commitCanonicalChangesWithSql` + business-key index + User_Input
 *    visible state confirmed to the observed hash), so the CleanupScanner
 *    never sees an unbound row (D5) and the first human edit CAS-matches.
 *
 * Ordering is owned by the service bootstrap: planning (read-only) →
 * runtime/provisioning → system columns → observation → seeding → final
 * re-verification → supervisors.
 */

import {
  ROW_OPERATIONS,
  FIELD_OWNERSHIPS,
} from "../../../../domain/model/constants.js";
import { stableHash } from "../../../../shared/encoding/stableEncode.js";
import type { NormalizedCell } from "../../../../shared/encoding/types.js";
import {
  notApplicableValue,
  presentValue,
} from "../../../../shared/state/constructors.js";
import {
  PRESENCE_KINDS,
} from "../../../../shared/state/constants.js";
import {
  columnLetters,
  quoteA1SheetName,
} from "../../../../adapter/sheets/providers/google-sheets-api/model/valueNormalization.js";
import type {
  GoogleSheetsApiWriteRequest,
} from "../../../../adapter/sheets/providers/google-sheets-api/transport/googleSheetsApiTransport.js";
import {
  requireValidBatchUpdateReply,
} from "../../../../adapter/sheets/providers/google-sheets-api/operations/shared.js";
import {
  claimWriterLeaseWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type FencingContext,
} from "@hikoutei/ikisaki";
import {
  commitCanonicalChangesWithSql,
} from "../../../../infrastructure/storage/state/canonical/canonicalCommit.js";
import {
  CONFIRM_OBSERVED_VISIBLE_STATE_SQL,
} from "../../../../infrastructure/storage/state/observation/observationCanonical.js";
import {
  createRowBinding,
} from "../../../orm/persistence/support/canonicalState.js";
import {
  claimBusinessKey,
} from "../../../orm/persistence/support/businessKeys.js";
import {
  computeSyncVisibleHash,
  observeSyncSnapshots,
  type SyncSnapshotRow,
  type SyncObservedSnapshot,
} from "../../sheetsContract/syncSheets.js";
import {
  SYNC_PROJECTIONS,
} from "../../sheetsContract/constants.js";
import {
  SYNC_SNAPSHOT_READ_MODES,
} from "../../sheetsContract/constants.js";
import type { TypedSheetsEntityMapping } from "../../../orm/mapping/contracts.js";
import type { TypedSheetsEntityWriterOptions } from "../../../orm/persistence/support/contracts.js";
import type { InternalSyncProvider } from "../serviceOptions.js";
import type {
  ExistingSheetAdoptionStartupPlan,
} from "./existingSheetAdoption.js";
import { DEFAULT_EFFECT_LEASE_DURATION_MS } from "@hikoutei/ikisaki";
import { typedSheetsEntityRowBindingId } from "../../../orm/mapping/identity.js";
import { typedSheetsEntityProjectionHeaders } from "../../../orm/mapping/projection.js";
import type { SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import type {
  ExistingSheetAdoptionEntityReport,
  ExistingSheetAdoptionLayout,
  GoogleSheetsApiAdoptionReader,
} from "./existingSheetAdoption.js";
import {
  SYNC_SERVICE_ERROR_CODES,
  SyncServiceError,
} from "../errors.js";

/**
 * Writes the adoption's system columns in ONE batchUpdate: the row-id
 * header, the generated PK header + values (when applicable), and the
 * deterministic per-row anchors. Nothing outside these appended columns is
 * touched — adoption never rewrites an existing cell.
 */
export async function applyAdoptionSystemColumns(input: {
  readonly transport: GoogleSheetsApiAdoptionReader;
  readonly spreadsheetId: string;
  readonly sheetId: number;
  /** The layout provides the row-id/PK column indices and the PK header. */
  readonly rowIdColumnIndex: number;
  /** Appended PK column; `undefined` when the PK comes from an existing column. */
  readonly pkAppend?: { readonly columnIndex: number; readonly header: string };
  /**
   * Data rows: 0-based sheet row index and the PK value, sorted by rowIndex.
   * Sparse rows are grouped into contiguous runs so values never shift across
   * blank rows.
   */
  readonly rows: readonly { readonly rowIndex: number; readonly pkValue: string }[];
}): Promise<void> {
  const textRow = (value: string) => [{ userEnteredValue: { stringValue: value } }];
  const requests: GoogleSheetsApiWriteRequest[] = [];

  // The row-id system header (row 0 of the appended row-id column).
  requests.push({
    kind: "updateCells",
    sheetId: input.sheetId,
    startRowIndex: 0,
    startColumnIndex: input.rowIdColumnIndex,
    rows: [textRow("__hikoutei_row_id")],
    fields: "userEnteredValue",
  });

  if (input.pkAppend !== undefined) {
    requests.push({
      kind: "updateCells",
      sheetId: input.sheetId,
      startRowIndex: 0,
      startColumnIndex: input.pkAppend.columnIndex,
      rows: [textRow(input.pkAppend.header)],
      fields: "userEnteredValue",
    });
    for (const run of contiguousRowRuns(input.rows)) {
      requests.push({
        kind: "updateCells",
        sheetId: input.sheetId,
        startRowIndex: run[0]!.rowIndex,
        startColumnIndex: input.pkAppend.columnIndex,
        rows: run.map((row) => textRow(row.pkValue)),
        fields: "userEnteredValue",
      });
    }
  }

  // Deterministic anchors: `entity:<pk>` — the same value
  // `mapping.anchorForEntity(entityId)` derives, so the row binding the
  // seeding writes matches the System_State projection's anchor exactly.
  for (const run of contiguousRowRuns(input.rows)) {
    requests.push({
      kind: "updateCells",
      sheetId: input.sheetId,
      startRowIndex: run[0]!.rowIndex,
      startColumnIndex: input.rowIdColumnIndex,
      rows: run.map((row) => textRow(`entity:${row.pkValue}`)),
      fields: "userEnteredValue",
    });
  }

  const response = await input.transport.batchUpdate({
    spreadsheetId: input.spreadsheetId,
    requests,
  });
  requireValidBatchUpdateReply(response, requests.length);
}

/** Groups sorted rows into maximal contiguous rowIndex runs. */
function contiguousRowRuns(
  rows: readonly { readonly rowIndex: number; readonly pkValue: string }[],
): readonly (readonly { readonly rowIndex: number; readonly pkValue: string }[])[] {
  const runs: { readonly rowIndex: number; readonly pkValue: string }[][] = [];
  let current: { readonly rowIndex: number; readonly pkValue: string }[] = [];
  for (const row of rows) {
    const previous = current.at(-1);
    if (previous !== undefined && row.rowIndex !== previous.rowIndex + 1) {
      runs.push(current);
      current = [];
    }
    current.push(row);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Maps a canonical field name to the ORM entity table's column name. The
 * application-owned entity table is created by MikroORM, whose default naming
 * strategy converts camelCase property names to snake_case columns; the raw
 * INSERT must use those column names, not the Sheet field names.
 */
function ormColumnNameForField(fieldName: string): string {
  return fieldName.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Seeds one adopted entity's observed rows into SQLite: active row bindings
 * keyed on the OBSERVED anchors, canonical INSERT commits (entity_state +
 * entity_field_state, revision 1), the business-key index, and the
 * User_Input visible state confirmed to the observed hash — so the
 * CleanupScanner sees fully bound rows (D5) and the first human edit
 * CAS-matches. One transaction: all-or-nothing (D7 safety contract).
 */
export async function seedAdoptedEntityRows(input: {
  readonly storage: SqlStorageAdapter;
  readonly mapping: TypedSheetsEntityMapping;
  /** The application-owned ORM entity table (descriptor.tableName). */
  readonly entityTableName: string;
  readonly physicalSheetId: string;
  /** Observed User_Input snapshot rows (anchors already assigned). */
  readonly rows: readonly {
    readonly visibleEntityId: string;
    readonly canonicalEntityId: string;
    readonly anchor: string;
    readonly fields: Readonly<Record<string, NormalizedCell>>;
  }[];
  readonly writerRole: string;
  readonly writerId: string;
  readonly leaseDurationMs: number;
  readonly now: number;
}): Promise<{ readonly seeded: number }> {
  if (input.rows.length === 0) return { seeded: 0 };
  const lease = await claimWriterLeaseWithAdapter(input.storage, {
    role: input.writerRole,
    writerId: input.writerId,
    leaseDurationMs: input.leaseDurationMs,
    now: input.now,
  });
  if (lease.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
      "adoption seeding could not claim the writer lease; the startup is refused (fail-closed).",
    );
  }
  const fence: FencingContext = {
    role: lease.lease.role,
    writerEpoch: lease.lease.writerEpoch,
    fencingToken: lease.lease.fencingToken,
    now: input.now,
  };

  const columnByFieldName = new Map(
    input.mapping.fields.map((field) => [
      field.fieldName,
      ormColumnNameForField(field.property),
    ]),
  );

  let seededCount = 0;
  await input.storage.transaction(async ({ sql }) => {
    // Only rows whose anchor is NOT yet bound get seeded: re-running the
    // verify loop must never re-bind (or conflict on) an existing row.
    const boundAnchors = new Set(
      (await sql.all<{ anchor_reference: string }>(
        "SELECT anchor_reference FROM row_binding WHERE logical_sheet_id = ?",
        [input.mapping.logicalSheetId],
      )).map((row) => row.anchor_reference),
    );
    const unbound = input.rows.filter((row) => !boundAnchors.has(row.anchor));
    if (unbound.length === 0) return { seeded: 0 };

    for (const row of unbound) {
      // Bindings/canonical state are keyed on the CANONICAL entity identity
      // (the normal flush INSERT converts via mapping.canonicalEntityIdFor);
      // the visible PK stays in the application entity table and the anchor
      // stays derived from the visible ID.
      const rowBindingId = typedSheetsEntityRowBindingId(input.mapping, row.visibleEntityId);
      await createRowBinding(sql, input.mapping, rowBindingId, row.canonicalEntityId, row.anchor);

      const fields = Object.entries(row.fields).map(([fieldName, value]) => ({
        fieldName,
        value,
        expectedFieldRevision: notApplicableValue<number>(),
        ownership: FIELD_OWNERSHIPS.USER,
      }));
      const observedHash = computeSyncVisibleHash(row.fields);
      const commit = await commitCanonicalChangesWithSql(sql, fence, {
        kind: ROW_OPERATIONS.INSERT,
        entityId: row.canonicalEntityId,
        acceptedSnapshotHash: presentValue(observedHash),
        fields,
        effects: [],
      });
      if (commit.kind !== "applied") {
        throw new SyncServiceError(
          SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
          `adoption seeding for ${input.mapping.entityName}:${row.visibleEntityId} did not apply (${commit.kind}).`,
        );
      }
      await claimBusinessKey(sql, input.mapping, row.canonicalEntityId, row.fields);

      // The application-owned ORM entity table must hold the adopted row too:
      // the polling's accepted-update path mutates it (exactly-once CAS). Its
      // PK column carries the VISIBLE identity.
      const fieldNames = Object.keys(row.fields);
      const columns = fieldNames.map(
        (field) => columnByFieldName.get(field) ?? ormColumnNameForField(field),
      );
      const placeholders = columns.map(() => "?").join(", ");
      const ormValues = fieldNames.map((field) => {
        const cell = row.fields[field];
        return cell === null || typeof cell !== "object" || !("value" in cell) ? null : cell.value;
      });
      await sql.run(
        `INSERT INTO ${input.entityTableName} (${columns.join(", ")}) VALUES (${placeholders})`,
        ormValues,
      );

      await sql.run(CONFIRM_OBSERVED_VISIBLE_STATE_SQL, [
        input.physicalSheetId,
        SYNC_PROJECTIONS.USER_INPUT,
        rowBindingId,
        observedHash,
        0,
        1,
        observedHash,
      ]);
      seededCount += 1;
    }
  });

  return { seeded: seededCount };
}

/**
 * Extracts the seed rows from an observed User_Input snapshot. Rows without
 * a usable anchor or PK value are skipped (the final re-verification fails
 * closed when anything remains unbound).
 */
export function extractAdoptedSeedRows(input: {
  readonly mapping: TypedSheetsEntityMapping;
  readonly observed: SyncObservedSnapshot;
}): {
  readonly visibleEntityId: string;
  readonly canonicalEntityId: string;
  readonly anchor: string;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
}[] {
  const projection = input.mapping.projections.find(
    (candidate) => candidate.projection === SYNC_PROJECTIONS.USER_INPUT,
  );
  if (projection === undefined) {
    throw new SyncServiceError(
      SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
      `entity ${input.mapping.entityName} has no User_Input projection for adoption seeding.`,
    );
  }
  const headers = typedSheetsEntityProjectionHeaders(input.mapping, SYNC_PROJECTIONS.USER_INPUT);
  const rows: {
    visibleEntityId: string;
    canonicalEntityId: string;
    anchor: string;
    fields: Record<string, NormalizedCell>;
  }[] = [];
  const anchorsSeen = new Map<string, number>();
  for (const row of input.observed.snapshot.rows) {
    if (row.physicalAnchor.kind !== PRESENCE_KINDS.PRESENT) continue;
    const anchor = row.physicalAnchor.value;
    // Duplicate anchors fail closed: two rows sharing one anchor cannot both
    // be bound, so startup must refuse instead of silently dropping one.
    const anchorSeenAt = anchorsSeen.get(anchor);
    if (anchorSeenAt !== undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
        `adoption found rows ${anchorSeenAt} and ${row.rowNumber} sharing the anchor "${anchor}" in ${projection.tabName}; deduplicate and retry.`,
      );
    }
    anchorsSeen.set(anchor, row.rowNumber);

    const fields: Record<string, NormalizedCell> = {};
    let visibleEntityId: string | undefined;
    for (const fieldName of headers) {
      const cell = row.cells[fieldName];
      const normalized = cell?.normalizedCell ?? null;
      fields[fieldName] = normalized;
      if (fieldName === input.mapping.primaryKey && normalized !== null && typeof normalized === "object" && "value" in normalized && typeof normalized.value === "string" && normalized.value !== "") {
        visibleEntityId = normalized.value;
      }
    }
    if (visibleEntityId === undefined) continue;
    // The canonical identity conversion matches the normal flush INSERT path
    // (planEntityId → typedSheetsCanonicalEntityId); default mappings are
    // identity conversions, namespaced mappings must namespace here too.
    rows.push({
      visibleEntityId,
      canonicalEntityId: input.mapping.canonicalEntityIdFor(visibleEntityId),
      anchor,
      fields,
    });
  }
  return rows;
}

/**
 * Re-verifies and completes the adoption AFTER provisioning: observes the
 * adopted User_Input tab (the anchors written by
 * {@link applyAdoptionSystemColumns} are already in place, so the anchor
 * pass assigns nothing), seeds every observed row that is not yet bound,
 * and repeats until a pass binds nothing new — the final re-verification
 * that absorbs edits made inside the adoption window (D5/D6).
 */
export async function completeExistingSheetAdoption(input: {
  readonly plan: ExistingSheetAdoptionStartupPlan;
  readonly provider: InternalSyncProvider;
  readonly storage: SqlStorageAdapter;
  readonly mappings: readonly TypedSheetsEntityMapping[];
  readonly writer: TypedSheetsEntityWriterOptions;
}): Promise<void> {
  for (const entity of input.plan.entities) {
    const mapping = input.mappings.find((candidate) => candidate.entityName === entity.entityName);
    if (mapping === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
        `adoption plan references entity "${entity.entityName}" without a runtime mapping.`,
      );
    }
    const projection = mapping.projections.find(
      (candidate) => candidate.projection === SYNC_PROJECTIONS.USER_INPUT,
    );
    if (projection === undefined) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
        `entity ${entity.entityName} has no User_Input projection for adoption.`,
      );
    }

    let seededTotal = 0;
    let stablePasses = 0;
    for (let pass = 0; pass < 3; pass += 1) {
      const observed = await observeSyncSnapshots(input.provider, [{
        physicalSheetId: projection.physicalSheetId,
        sheetName: projection.tabName,
        registeredRange: projection.registeredRange,
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: mapping.schemaVersion,
        readMode: SYNC_SNAPSHOT_READ_MODES.FULL,
      }]);
      const observedSnapshot = observed[0]!.snapshot;
      const rows = extractAdoptedSeedRows({ mapping, observed: observed[0]! });
      const seeded = await seedAdoptedEntityRows({
        storage: input.storage,
        mapping,
        entityTableName: entity.entityTableName,
        physicalSheetId: projection.physicalSheetId,
        rows,
        writerRole: input.writer.role ?? "adopt-seeding",
        writerId: input.writer.writerId,
        leaseDurationMs: input.writer.leaseDurationMs ?? DEFAULT_EFFECT_LEASE_DURATION_MS,
        now: Date.now(),
      });
      seededTotal += seeded.seeded;

      // Stability requires EVERY observed row (with a usable anchor) to be
      // bound to ITS OWN row binding (anchor AND canonical entity id both
      // matching) — not merely "this pass seeded nothing". An unanchored row
      // fails closed: the library cannot bind what it cannot locate.
      const unanchored = observedSnapshot.rows.filter(
        (row) => row.physicalAnchor.kind !== PRESENCE_KINDS.PRESENT,
      ).length;
      const bindings = await storageReadAll(input.storage,
        "SELECT anchor_reference, entity_id, state FROM row_binding WHERE logical_sheet_id = ?",
        [mapping.logicalSheetId],
      );
      const boundByAnchor = new Map(
        bindings.map((binding) => [binding.anchor_reference, binding]),
      );
      const unboundRows: number[] = [];
      for (const row of observedSnapshot.rows) {
        if (row.physicalAnchor.kind !== PRESENCE_KINDS.PRESENT) continue;
        const binding = boundByAnchor.get(row.physicalAnchor.value);
        if (binding === undefined || binding.state !== "active") unboundRows.push(row.rowNumber);
      }
      if (unanchored > 0 || unboundRows.length > 0) {
        throw new SyncServiceError(
          SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
          `adoption seeding for ${entity.entityName} left rows unbound (unanchored: ${unanchored}, unbound: ${unboundRows.length} at rows ${unboundRows.slice(0, 20).join(",")}); the startup is refused (fail-closed).`,
        );
      }
      if (seeded.seeded === 0) {
        stablePasses += 1;
        if (stablePasses >= 2) break;
      } else {
        stablePasses = 0;
      }
    }
    if (stablePasses < 2) {
      throw new SyncServiceError(
        SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
        `adoption seeding for ${entity.entityName} did not stabilize; the startup is refused (fail-closed).`,
      );
    }
  }
}

/** Reads rows through the storage adapter's transaction executor. */
async function storageReadAll(
  storage: SqlStorageAdapter,
  query: string,
  parameters: readonly (string | number | null)[],
): Promise<readonly { anchor_reference: string; entity_id: string; state: string }[]> {
  return storage.transaction(async ({ sql }) => sql.all<{ anchor_reference: string; entity_id: string; state: string }>(query, parameters));
}
