/** Builds the canonical desired System_State rows used by reconciliation. */

import {
  stableHash,
  type NormalizedCell,
} from "../../../../domain/index.js";
import { NORMALIZED_CELL_KINDS } from "../../../../shared/encoding/constants.js";
import {
  readReconciliationDesiredSystemStateWithAdapter,
  type ReconciliationDesiredSystemStateRow,
} from "../../../../infrastructure/storage/index.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../../../infrastructure/storage/errors.js";
import type { SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";

export interface ReconciliationDesiredStateContext {
  readonly storage: SqlStorageAdapter;
  readonly logicalSheetId: string;
  readonly tombstoneField: string | undefined;
}

/** Canonical entity row prepared for System_State comparison and repair. */
export interface DesiredRow {
  readonly entityId: string;
  readonly rowBindingId: string;
  readonly entityRevision: number;
  readonly fields: Readonly<Record<string, NormalizedCell>>;
  readonly fieldRevisionHash: string;
}

/** Reads and groups canonical SQLite field rows into desired projection rows. */
export async function readDesiredSystemState(
  context: ReconciliationDesiredStateContext,
): Promise<readonly DesiredRow[]> {
  const rows = await readReconciliationDesiredSystemStateWithAdapter(
    context.storage,
    context.logicalSheetId,
  );
  return buildDesiredSystemState(rows, context.tombstoneField);
}

function buildDesiredSystemState(
  rows: readonly ReconciliationDesiredSystemStateRow[],
  tombstoneField: string | undefined,
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
    ensureTombstoneField(row, tombstoneField);
    desired.push({ ...row, fieldRevisionHash: computeFieldRevisionHash(row.fields) });
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
  if (typeof value !== "object") return false;
  const cell = value as { kind?: unknown; value?: unknown };
  return typeof cell.kind === "string";
}
