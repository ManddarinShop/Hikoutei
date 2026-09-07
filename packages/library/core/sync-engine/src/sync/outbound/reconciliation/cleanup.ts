/**
 * User_Input cleanup detection and correction-effect building.
 *
 * The cleanup scan is the human-input counterpart of the System_State repair
 * scan, and it follows the same system-first rule: SQLite is the authority and
 * a corrupted User_Input tab (duplicated business keys or anchors, empty-ID
 * rows, orphan rows) is rewritten from canonical state instead of being
 * patched row by row.
 *
 * Concretely, when the scan proves corruption it builds two kinds of
 * `user_input` effects on the existing outbox:
 *
 * - Every physical row bound in SQLite (row_binding -> active entity ->
 *   canonical user-owned fields) gets a full-row `candidate_reconcile`
 *   rewrite carrying the canonical values with the row's observed cells as
 *   compare-and-set evidence. A binding with a durable active candidate
 *   (sheet_visible_field_state pointer joined to an OPEN/NEEDS_REBASE
 *   conflict) is NEVER planned by this scan: the conflict/candidate evidence
 *   is re-read after the snapshot (and again right before effect building),
 *   and the binding is skipped while a candidate is durable, so a rewrite
 *   can never be enqueued into a conflicted row. The conflict converges
 *   exclusively through resolution, whose binding-keyed reconcile
 *   supersedes any earlier rewrite on the same stream.
 * - Every physical row NOT matching a bound binding (a duplicate of a bound
 *   key beyond the kept row, empty-ID rows, and orphan rows) gets a
 *   `user_input_delete` carrying the full observed row as its CAS guard.
 *
 * Bound-row corrections stream under the BINDING key
 * (`projection-row:<physicalSheetId>:<rowBindingId>`), the same target key
 * flush projections and resolution reconciles use, so the resolution's
 * supersede-and-replan covers any pending cleanup rewrite in the same
 * transaction and an in-flight flush/reconcile head defers the scan. Only
 * unbound rows (orphans, empty-ID rows without a binding) keep the physical
 * anchor as their stream key, because no binding exists to own the stream;
 * their deletes already write no projection confirmation.
 *
 * Duplicated anchors are resolved the way the real provider resolves them:
 * its preflight anchor index keeps only the FIRST row per anchor value
 * (indexRows in preflightRows.ts; planEffectBatch mirrors the same rule), so
 * a scan targets only the first (lowest) row of a duplicate-anchor group for
 * deletion and defers the surviving rows and the group's rewrite to the next
 * scan. Each scan therefore converges one surplus row per duplicated anchor,
 * and a re-scan of a converged tab enqueues nothing (idempotent).
 *
 * The scan never writes to the Sheet directly; every correction flows through
 * the durable outbox and the worker's CAS-guarded slow path.
 */

import { POSITIVE_SAFE_INTEGER_MINIMUM } from "@hikoutei/contracts/constants.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import {
  PRESENCE_KINDS,
} from "@hikoutei/contracts/state/index.js";
import { isRecoverableEffectErrorCode } from "@hikoutei/ikisaki";
import type { NewEffect } from "@hikoutei/ikisaki";
import type { SqlExecutor, SqlStorageAdapter } from "@hikoutei/contracts/storage/sql.js";
import {
  computeSyncVisibleHash,
  type SyncSheetsSnapshot,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { SYNC_PROJECTIONS } from "@hikoutei/contracts/sheets/constants.js";
import {
  createCandidateReconcileEffect,
  createUserInputDeleteEffect,
} from "@hikoutei/storage/sync/outbound/projection/ProjectionEffectFactory.js";
import { normalizedCellIdentity } from "./diff.js";
import {
  decodeNormalizedCell,
  RECONCILIATION_SCAN_CHUNK_SIZE,
  RECONCILIATION_SCAN_ENTITY_PAGE_SIZE,
  readActiveEntityPageWithSql,
  readEntityBindingsWithSql,
  readEntityFieldsWithSql,
} from "./shared.js";

/** One snapshot row the cleanup scan may correct. */
export interface CleanupRow {
  readonly rowNumber: number;
  /** Physical anchor (row-id system column) value; null when unanchored. */
  readonly anchor: string | null;
  /** Business-key value, or undefined for empty-ID rows. */
  readonly identity: string | undefined;
  /**
   * Deterministic positive visible revision: the snapshot-provided revision
   * when present (defensive), otherwise 1. The real provider leaves visible
   * state to SQLite, so the scan derives a positive baseline revision.
   */
  readonly visibleRevision: number;
  /**
   * Visible hash: the snapshot-provided hash when present (defensive),
   * otherwise computed over the observed cells with computeSyncVisibleHash.
   */
  readonly visibleHash: string;
  /** Full observed row cells keyed by header (blank cells are null). */
  readonly fields: Record<string, NormalizedCell>;
}

export type CleanupTargetKind = "duplicate" | "empty_id" | "extra" | "rewrite";

/** Raw confirmed revision row for one cleanup binding. */
interface CleanupConfirmedVisibleSqlShape {
  readonly confirmed_visible_revision: number | null;
}

/** One surplus or drifted row proven safe to correct under its CAS guard. */
export interface CleanupTarget {
  readonly kind: CleanupTargetKind;
  readonly row: CleanupRow;
  /** Rewrite-only: canonical SQLite user-owned fields to project. */
  readonly canonicalFields?: Record<string, NormalizedCell>;
  /**
   * Rewrite/delete-only: durable row binding id. Rewrites always carry the
   * binding id so the worker candidate gate can find the binding's visible
   * state; deletes carry it when a real binding owns the row's anchor;
   * unbound rows (orphans, empty-ID rows) carry none, so the worker writes
   * no projection confirmation for a binding that does not exist.
   */
  readonly rowBindingId?: string;
}

/** Durable evidence consulted before any row may be corrected. */
export interface CleanupEvidence {
  readonly bindings: readonly CleanupBinding[];
  readonly canonical: readonly CleanupCanonicalRow[];
  /** row_binding_id -> active candidate hash for user_input visible state. */
  readonly candidateHashes: ReadonlyMap<string, string>;
}

export interface CleanupBinding {
  readonly rowBindingId: string;
  readonly anchorReference: string;
  readonly state: string;
}

/** Canonical User_Input projection target owned by one active binding. */
export interface CleanupCanonicalRow {
  readonly entityId: string;
  readonly rowBindingId: string;
  readonly anchorReference: string;
  readonly fields: Record<string, NormalizedCell>;
  readonly fieldRevisionHash: string;
}

interface CleanupBindingSqlShape {
  readonly row_binding_id: string;
  readonly anchor_reference: string;
  readonly state: string;
}

interface CleanupCanonicalSqlShape {
  readonly entity_id: string;
  readonly row_binding_id: string;
  readonly anchor_reference: string;
  readonly field_name: string;
  readonly normalized_value: string;
}

interface CleanupCandidateHashSqlShape {
  readonly row_binding_id: string;
  readonly active_candidate_hash: string;
}

interface CleanupLatestEffectSqlShape {
  readonly effect_id: string;
  readonly stream_sequence: number | null;
  readonly status: string;
  readonly last_error_code: string | null;
}

const READ_CLEANUP_BINDINGS_SQL = `
  SELECT row_binding_id, anchor_reference, state
  FROM row_binding
  WHERE logical_sheet_id = ?
`;

/**
 * One keyset page of row bindings in `row_binding_id` order. The
 * `(logical_sheet_id, row_binding_id)` covering index (`row_binding_scan_idx`)
 * serves each page as a bounded index range scan with no temp-b-tree sort.
 */
const READ_CLEANUP_BINDINGS_PAGE_SQL = `
  SELECT row_binding_id, anchor_reference, state
  FROM row_binding
  WHERE logical_sheet_id = ? AND row_binding_id > ?
  ORDER BY row_binding_id
  LIMIT ?
`;

const READ_CLEANUP_BINDINGS_FIRST_PAGE_SQL = `
  SELECT row_binding_id, anchor_reference, state
  FROM row_binding
  WHERE logical_sheet_id = ?
  ORDER BY row_binding_id
  LIMIT ?
`;

/**
 * Canonical user-owned projection values for every active binding with an
 * entity. The anchor_reference is the User_Input row-id anchor of the bound
 * row; only user-owned fields are projected (system-owned fields never appear
 * on the human input surface).
 */
const READ_CLEANUP_CANONICAL_SQL = `
  SELECT
    entity.entity_id        AS entity_id,
    binding.row_binding_id  AS row_binding_id,
    binding.anchor_reference AS anchor_reference,
    field.field_name        AS field_name,
    field.normalized_value  AS normalized_value
  FROM entity_state AS entity
  JOIN row_binding AS binding
    ON binding.entity_id = entity.entity_id
   AND binding.logical_sheet_id = ?
   AND binding.state = 'active'
  JOIN entity_field_state AS field
    ON field.entity_id = entity.entity_id
   AND field.ownership = 'user'
  WHERE entity.status = 'active'
  ORDER BY entity.entity_id, field.field_name
`;

/**
 * Whole-entity canonical pages are assembled from the storage-owned
 * entity-batch primitives (same bounded access path as the desired-state
 * pages: PK-ordered entities, PK-prefix fields, covering binding seeks).
 * A flat cross-table keyset cannot page here: duplicate `(entity, field)`
 * keys across several active bindings of one entity would be skipped by a
 * `(entity_id, field_name)` cursor, silently dropping a binding's fields.
 */

/**
 * Stable binding-keyed stream target id shared with flush projections and
 * resolution reconciles. Bound-row cleanup corrections must stream under the
 * same key so the resolution's supersede-and-replan lookup and the durable
 * stream predecessor guard cover them.
 */
export function cleanupBindingStreamTargetId(physicalSheetId: string, rowBindingId: string): string {
  return `projection-row:${physicalSheetId}:${rowBindingId}`;
}

/**
 * Durable active candidate hashes for user_input bindings. A binding is
 * candidate-protected when any of its fields carries an active candidate
 * pointer joined to an OPEN/NEEDS_REBASE conflict; the scan must never plan
 * a rewrite/delete for such a binding (the conflict converges exclusively
 * through resolution).
 */
const READ_CLEANUP_CANDIDATE_HASHES_SQL = `
  SELECT visible.row_binding_id AS row_binding_id,
         visible.active_candidate_hash AS active_candidate_hash
  FROM sheet_visible_field_state AS visible
  JOIN sync_conflict AS conflict
    ON conflict.conflict_id = visible.active_candidate_conflict_id
  WHERE visible.physical_sheet_id = ?
    AND visible.projection = 'user_input'
    AND visible.active_candidate_conflict_id IS NOT NULL
    AND visible.active_candidate_hash IS NOT NULL
    AND conflict.status IN ('OPEN', 'NEEDS_REBASE')
  ORDER BY visible.row_binding_id, visible.field_name
`;

/**
 * Durable confirmed visible revision for one user_input binding. The real
 * provider leaves snapshot revisions ABSENT, so this is the authoritative
 * revision counter for rows with write history.
 */
const READ_CLEANUP_CONFIRMED_VISIBLE_REVISION_SQL = `
  SELECT confirmed_visible_revision
  FROM sheet_visible_state
  WHERE physical_sheet_id = ? AND projection = 'user_input' AND row_binding_id = ?
`;

const READ_CLEANUP_LATEST_EFFECT_SQL = `
  SELECT effect_id, stream_sequence, status, last_error_code
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = 'projection_row' AND target_id = ?
  ORDER BY stream_sequence DESC
  LIMIT 1
`;

/**
 * Reads the set of row bindings carrying a durable active candidate pointer
 * joined to an OPEN/NEEDS_REBASE conflict. The scan must never plan a
 * rewrite/delete for one of these bindings: the conflict converges only
 * through resolution, whose binding-keyed reconcile supersedes any pending
 * rewrite on the same stream.
 */
export async function readCleanupProtectedBindingsWithSql(
  sql: SqlExecutor,
  physicalSheetId: string,
): Promise<ReadonlySet<string>> {
  const candidateRows = await sql.all<CleanupCandidateHashSqlShape>(
    READ_CLEANUP_CANDIDATE_HASHES_SQL,
    [physicalSheetId],
  );
  return new Set(candidateRows.map((row) => row.row_binding_id));
}

/** Reads the durable binding/canonical/candidate evidence for one tab. */
export async function readCleanupEvidenceWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  physicalSheetId: string,
): Promise<CleanupEvidence> {
  const [bindings, canonicalRows, candidateRows] = await Promise.all([
    sql.all<CleanupBindingSqlShape>(READ_CLEANUP_BINDINGS_SQL, [logicalSheetId]),
    sql.all<CleanupCanonicalSqlShape>(READ_CLEANUP_CANONICAL_SQL, [logicalSheetId]),
    sql.all<CleanupCandidateHashSqlShape>(READ_CLEANUP_CANDIDATE_HASHES_SQL, [physicalSheetId]),
  ]);
  return {
    bindings: bindings.map((row) => ({
      rowBindingId: row.row_binding_id,
      anchorReference: row.anchor_reference,
      state: row.state,
    })),
    canonical: groupCanonicalRows(canonicalRows),
    candidateHashes: new Map(candidateRows.map((row) => [
      row.row_binding_id,
      row.active_candidate_hash,
    ])),
  };
}

/** Reads cleanup evidence through a fresh adapter read context. */
export async function readCleanupEvidence(
  storage: SqlStorageAdapter,
  logicalSheetId: string,
  physicalSheetId: string,
): Promise<CleanupEvidence> {
  return storage.read(({ sql }) =>
    readCleanupEvidenceWithSql(sql, logicalSheetId, physicalSheetId));
}

/** Keyset cursor for a paged cleanup binding chunk: the last id already seen. */
export interface CleanupBindingsCursor {
  readonly rowBindingId: string;
}

/** Keyset cursor for a paged canonical chunk: the last entity already seen. */
export interface CleanupCanonicalCursor {
  readonly entityId: string;
}

/** One entity-batched canonical chunk: whole entities plus progress. */
export interface CleanupCanonicalEntityChunk {
  readonly rows: readonly CleanupCanonicalSqlShape[];
  /** Entities paged (including binding-less ones) — the termination signal. */
  readonly entityCount: number;
  /** Last entity paged — the next cursor (absent only when empty). */
  readonly lastEntityId: string | undefined;
}

/** Reads one bounded page of row bindings in `row_binding_id` order. */
export function readCleanupBindingsChunkWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  after: CleanupBindingsCursor | undefined,
  limit: number = RECONCILIATION_SCAN_CHUNK_SIZE,
): Promise<readonly CleanupBinding[]> {
  const query = after === undefined
    ? READ_CLEANUP_BINDINGS_FIRST_PAGE_SQL
    : READ_CLEANUP_BINDINGS_PAGE_SQL;
  const parameters = after === undefined
    ? [logicalSheetId, limit] as const
    : [logicalSheetId, after.rowBindingId, limit] as const;
  return sql.all<CleanupBindingSqlShape>(query, [...parameters]).then((rows) =>
    rows.map((row) => ({
      rowBindingId: row.row_binding_id,
      anchorReference: row.anchor_reference,
      state: row.state,
    })),
  );
}

/**
 * Reads one bounded chunk of whole entities as flat canonical user-owned
 * rows, in global entity order. Pass no cursor for the first chunk, then
 * `{ entityId }` of the last entity paged; an empty chunk (or
 * `entityCount < limit`) ends the scan. Only `limit` entities are ever
 * materialized per call. Multi-binding entities emit one row per
 * (binding, field) with the smallest `row_binding_id` first, so no
 * binding's fields can be skipped across chunks by construction.
 */
export async function readCleanupCanonicalChunkWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  after: CleanupCanonicalCursor | undefined,
  limit: number = RECONCILIATION_SCAN_ENTITY_PAGE_SIZE,
): Promise<CleanupCanonicalEntityChunk> {
  const entities = await readActiveEntityPageWithSql(sql, after?.entityId, limit);
  const rows: CleanupCanonicalSqlShape[] = [];
  for (const entity of entities) {
    const [bindings, fields] = await Promise.all([
      readEntityBindingsWithSql(sql, logicalSheetId, entity.entityId),
      readEntityFieldsWithSql(sql, entity.entityId, "user"),
    ]);
    for (const binding of bindings) {
      for (const field of fields) {
        rows.push({
          entity_id: entity.entityId,
          row_binding_id: binding.rowBindingId,
          anchor_reference: binding.anchorReference,
          field_name: field.fieldName,
          normalized_value: field.normalizedValue,
        });
      }
    }
  }
  const lastEntity = entities[entities.length - 1];
  return {
    rows,
    entityCount: entities.length,
    lastEntityId: lastEntity === undefined ? undefined : lastEntity.entityId,
  };
}

/** One entity's canonical bindings accumulated across chunk boundaries. */
export interface PartialCleanupCanonical {
  readonly entityId: string;
  readonly partials: ReadonlyMap<string, {
    readonly entityId: string;
    readonly rowBindingId: string;
    readonly anchorReference: string;
    readonly fields: Record<string, NormalizedCell>;
  }>;
}

/** Completed canonical rows plus the trailing entity still missing fields. */
export interface CleanupCanonicalChunkResult {
  readonly completed: readonly CleanupCanonicalRow[];
  readonly carry: PartialCleanupCanonical | undefined;
}

/**
 * Groups one ordered page of canonical rows into completed canonical rows.
 *
 * A page may split an entity's fields across the boundary, and several
 * bindings may share one entity, so the trailing entity is returned as
 * `carry` (all of its bindings) and must seed the next call; only the flush
 * after the last page finalizes it. Completed rows hash exactly like the
 * full-load grouping, in global entity order.
 */
export function assembleCleanupCanonicalChunk(
  rows: readonly CleanupCanonicalSqlShape[],
  carry: PartialCleanupCanonical | undefined,
): CleanupCanonicalChunkResult {
  const completed: CleanupCanonicalRow[] = [];
  let currentEntityId = carry?.entityId;
  let current = new Map(carry?.partials);
  const finalizeCurrent = (): void => {
    for (const partial of current.values()) {
      completed.push(toCleanupCanonicalRow(partial));
    }
    current = new Map();
    currentEntityId = undefined;
  };
  for (const row of rows) {
    if (currentEntityId !== undefined && currentEntityId !== row.entity_id) {
      finalizeCurrent();
    }
    currentEntityId = row.entity_id;
    const existing = current.get(row.row_binding_id);
    if (existing === undefined) {
      current.set(row.row_binding_id, {
        entityId: row.entity_id,
        rowBindingId: row.row_binding_id,
        anchorReference: row.anchor_reference,
        fields: { [row.field_name]: decodeNormalizedCell(row.normalized_value) },
      });
    } else {
      existing.fields[row.field_name] = decodeNormalizedCell(row.normalized_value);
    }
  }
  return {
    completed,
    carry: currentEntityId === undefined ? undefined : {
      entityId: currentEntityId,
      partials: current,
    },
  };
}

/** Finalizes the trailing entity's canonical rows after the last page. */
export function flushCleanupCanonicalCarry(
  carry: PartialCleanupCanonical | undefined,
): readonly CleanupCanonicalRow[] {
  if (carry === undefined) return [];
  return [...carry.partials.values()].map(toCleanupCanonicalRow);
}

function toCleanupCanonicalRow(partial: {
  readonly entityId: string;
  readonly rowBindingId: string;
  readonly anchorReference: string;
  readonly fields: Record<string, NormalizedCell>;
}): CleanupCanonicalRow {
  return {
    entityId: partial.entityId,
    rowBindingId: partial.rowBindingId,
    anchorReference: partial.anchorReference,
    fields: partial.fields,
    fieldRevisionHash: computeSyncVisibleHash(partial.fields),
  };
}

/** Snapshot rows grouped by anchor for the chunked cleanup scan. */
export interface CleanupSnapshotIndex {
  readonly groupsByAnchor: ReadonlyMap<string, readonly CleanupRow[]>;
  readonly duplicateAnchors: ReadonlySet<string>;
}

/**
 * Groups decoded snapshot rows by anchor once per scan. The maps hold
 * references to the decoded rows; no snapshot data is copied.
 */
export function buildCleanupSnapshotIndex(
  rows: readonly CleanupRow[],
): CleanupSnapshotIndex {
  const groupsByAnchor = new Map<string, CleanupRow[]>();
  for (const row of rows) {
    if (row.anchor === null) continue;
    const group = groupsByAnchor.get(row.anchor) ?? [];
    group.push(row);
    groupsByAnchor.set(row.anchor, group);
  }
  const duplicateAnchors = new Set<string>();
  for (const [anchor, group] of groupsByAnchor) {
    if (group.length > 1) duplicateAnchors.add(anchor);
  }
  return { groupsByAnchor, duplicateAnchors };
}

/** Streaming evidence for one cleanup scan: small maps plus drifted rewrites. */
export interface CleanupStreamEvidence {
  readonly bindingsByAnchor: ReadonlyMap<string, CleanupBinding>;
  readonly candidateHashes: ReadonlyMap<string, string>;
  readonly canonicalAnchors: ReadonlySet<string>;
  readonly rewriteByAnchor: ReadonlyMap<string, CleanupTarget>;
}

/**
 * Streams binding/canonical/candidate evidence in keyset pages inside the
 * caller's SQL context.
 *
 * Only one page of canonical rows is materialized at a time; completed
 * canonical rows are rewrite-checked against the snapshot index immediately
 * and dropped unless drifted. Retained state is small bindings, candidate
 * hashes, canonical anchor keys, and drifted rewrite targets — never the
 * full canonical table.
 */
export async function readCleanupStreamEvidenceWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  physicalSheetId: string,
  snapshot: CleanupSnapshotIndex,
): Promise<CleanupStreamEvidence> {
  const candidateRows = await sql.all<CleanupCandidateHashSqlShape>(
    READ_CLEANUP_CANDIDATE_HASHES_SQL,
    [physicalSheetId],
  );
  const candidateHashes = new Map(candidateRows.map((row) => [
    row.row_binding_id,
    row.active_candidate_hash,
  ]));
  const bindingsByAnchor = new Map<string, CleanupBinding>();
  let bindingsAfter: CleanupBindingsCursor | undefined;
  for (;;) {
    const page = await readCleanupBindingsChunkWithSql(sql, logicalSheetId, bindingsAfter);
    if (page.length === 0) break;
    for (const binding of page) bindingsByAnchor.set(binding.anchorReference, binding);
    const last = page[page.length - 1];
    if (last === undefined) break;
    bindingsAfter = { rowBindingId: last.rowBindingId };
    if (page.length < RECONCILIATION_SCAN_CHUNK_SIZE) break;
  }
  const canonicalAnchors = new Set<string>();
  const rewriteByAnchor = new Map<string, CleanupTarget>();
  let canonicalAfter: CleanupCanonicalCursor | undefined;
  let carry: PartialCleanupCanonical | undefined;
  for (;;) {
    const chunk = await readCleanupCanonicalChunkWithSql(sql, logicalSheetId, canonicalAfter);
    // Whole-entity chunks: the cursor is the last entity paged, including
    // binding-less ones that emit no rows, so no entity's rows can be
    // skipped or repeated across chunks.
    if (chunk.entityCount === 0 || chunk.lastEntityId === undefined) break;
    canonicalAfter = { entityId: chunk.lastEntityId };
    const assembled = assembleCleanupCanonicalChunk(chunk.rows, carry);
    carry = assembled.carry;
    for (const canonical of assembled.completed) {
      canonicalAnchors.add(canonical.anchorReference);
      const rewrite = classifyCleanupRewrite(canonical, snapshot, candidateHashes);
      if (rewrite !== undefined) rewriteByAnchor.set(canonical.anchorReference, rewrite);
    }
    if (chunk.entityCount < RECONCILIATION_SCAN_ENTITY_PAGE_SIZE) break;
  }
  for (const canonical of flushCleanupCanonicalCarry(carry)) {
    canonicalAnchors.add(canonical.anchorReference);
    const rewrite = classifyCleanupRewrite(canonical, snapshot, candidateHashes);
    if (rewrite !== undefined) rewriteByAnchor.set(canonical.anchorReference, rewrite);
  }
  return { bindingsByAnchor, candidateHashes, canonicalAnchors, rewriteByAnchor };
}

/**
 * Rewrite-checks one completed canonical row against its snapshot group.
 *
 * Mirrors the bound-row branch of `classifyCleanupRows`: duplicated-anchor
 * groups defer (their delete is planned by the surplus pass), candidate-
 * protected bindings converge through resolution, field-less canonical rows
 * belong to the lifecycle pipeline, and matching rows are idempotent.
 * Returns the rewrite target only for a drifted, plannable row.
 */
function classifyCleanupRewrite(
  canonical: CleanupCanonicalRow,
  snapshot: CleanupSnapshotIndex,
  candidateHashes: ReadonlyMap<string, string>,
): CleanupTarget | undefined {
  if (snapshot.duplicateAnchors.has(canonical.anchorReference)) return undefined;
  if (Object.keys(canonical.fields).length === 0) return undefined;
  if (candidateHashes.has(canonical.rowBindingId)) return undefined;
  const group = snapshot.groupsByAnchor.get(canonical.anchorReference);
  const row = group?.[0];
  if (row === undefined) return undefined;
  if (observedCanonicalHash(row, canonical.fields) === canonical.fieldRevisionHash) {
    return undefined;
  }
  return {
    kind: "rewrite",
    row,
    canonicalFields: canonical.fields,
    rowBindingId: canonical.rowBindingId,
  };
}

/**
 * Classifies snapshot rows into correction targets in full-load order.
 *
 * Mirrors `classifyCleanupRows` decision-for-decision (duplicate deletes
 * first in first-seen anchor order, then snapshot row order for rewrites
 * and surplus deletes) while reading rewrites from the streamed evidence:
 * bound non-duplicate anchors resolve through `rewriteByAnchor`, every
 * other row through the binding map. The target sequence is identical to
 * the full-load scan, so repair effect ids stay stable across the switch.
 */
export function classifyCleanupStreamTargets(
  rows: readonly CleanupRow[],
  snapshot: CleanupSnapshotIndex,
  evidence: CleanupStreamEvidence,
): readonly CleanupTarget[] {
  const targets: CleanupTarget[] = [];
  const handled = new Set<number>();
  for (const [anchor, group] of snapshot.groupsByAnchor) {
    if (group.length < 2) continue;
    const resolvable = lowestRow(group);
    const binding = evidence.bindingsByAnchor.get(anchor);
    if (binding !== undefined && evidence.candidateHashes.has(binding.rowBindingId)) {
      for (const row of group) handled.add(row.rowNumber);
      continue;
    }
    targets.push({
      kind: "duplicate",
      row: resolvable,
      ...(binding === undefined ? {} : { rowBindingId: binding.rowBindingId }),
    });
    for (const row of group) handled.add(row.rowNumber);
  }
  for (const row of rows) {
    if (row.anchor === null || handled.has(row.rowNumber)) continue;
    if (evidence.canonicalAnchors.has(row.anchor)) {
      const rewrite = evidence.rewriteByAnchor.get(row.anchor);
      if (rewrite !== undefined) targets.push(rewrite);
      continue;
    }
    const binding = evidence.bindingsByAnchor.get(row.anchor);
    if (binding !== undefined) {
      if (
        binding.state === "candidate" &&
        row.identity === undefined &&
        !evidence.candidateHashes.has(binding.rowBindingId)
      ) {
        targets.push({ kind: "empty_id", row, rowBindingId: binding.rowBindingId });
      }
      continue;
    }
    targets.push({
      kind: row.identity === undefined ? "empty_id" : "extra",
      row,
    });
  }
  return targets;
}

function groupCanonicalRows(
  rows: readonly CleanupCanonicalSqlShape[],
): readonly CleanupCanonicalRow[] {
  const byBinding = new Map<string, CleanupCanonicalRow>();
  for (const row of rows) {
    const existing = byBinding.get(row.row_binding_id);
    if (existing === undefined) {
      const fields: Record<string, NormalizedCell> = {};
      fields[row.field_name] = decodeNormalizedCell(row.normalized_value);
      byBinding.set(row.row_binding_id, {
        entityId: row.entity_id,
        rowBindingId: row.row_binding_id,
        anchorReference: row.anchor_reference,
        fields,
        fieldRevisionHash: "",
      });
      continue;
    }
    existing.fields[row.field_name] = decodeNormalizedCell(row.normalized_value);
  }
  const canonical: CleanupCanonicalRow[] = [];
  for (const row of byBinding.values()) {
    canonical.push({ ...row, fieldRevisionHash: computeSyncVisibleHash(row.fields) });
  }
  return canonical;
}

/**
 * Decodes snapshot rows into cleanup rows.
 *
 * Only anchored rows are eligible: the delete/rewrite effects locate their
 * CAS target by the physical anchor, so unanchored rows stay on the
 * observation pipeline instead of being guessed at. The real provider leaves
 * `visibleRevision`/`visibleHash` ABSENT (visible state lives in SQLite), so
 * the visible hash is derived from the observed cells with
 * computeSyncVisibleHash and the revision falls back to a deterministic
 * positive value; provided values are kept when present (defensive).
 */
export function decodeCleanupRows(
  snapshot: SyncSheetsSnapshot,
  identityField: string,
): readonly CleanupRow[] {
  const rows: CleanupRow[] = [];
  for (const row of snapshot.rows) {
    if (row.physicalAnchor.kind !== PRESENCE_KINDS.PRESENT) continue;
    const fields: Record<string, NormalizedCell> = {};
    for (const [fieldName, cell] of Object.entries(row.cells)) {
      fields[fieldName] = cell.normalizedCell;
    }
    const visibleHash = row.visibleHash.kind === PRESENCE_KINDS.PRESENT &&
      row.visibleHash.value.length > 0
      ? row.visibleHash.value
      : computeSyncVisibleHash(fields);
    const visibleRevision = row.visibleRevision.kind === PRESENCE_KINDS.PRESENT &&
      row.visibleRevision.value >= POSITIVE_SAFE_INTEGER_MINIMUM
      ? row.visibleRevision.value
      : POSITIVE_SAFE_INTEGER_MINIMUM;
    rows.push({
      rowNumber: row.rowNumber,
      anchor: row.physicalAnchor.value,
      identity: normalizedCellIdentity(fields[identityField]),
      visibleRevision,
      visibleHash,
      fields,
    });
  }
  return rows;
}

/**
 * Classifies snapshot rows into correction targets with overwrite semantics.
 *
 * Decision order:
 * 1. Duplicated anchor groups: the real provider can only resolve the FIRST
 *    row per anchor (its preflight anchor index keeps the first row only), so
 *    exactly that row is targeted for deletion and every other group member is
 *    deferred to a later scan, when it becomes resolvable. The group's bound
 *    row (if any) is rewritten only after the group is down to one row.
 * 2. A row whose anchor is bound to an active entity is rewritten from
 *    canonical values unless it already matches (idempotent); an active
 *    candidate hash is attached so the existing candidate guard blocks it.
 * 3. Rows bound to non-active bindings (candidate without an entity yet,
 *    tombstoned, ambiguous) are protected: there is no canonical value to
 *    rewrite and no proof they are surplus. The one exception is an empty-ID
 *    row under a candidate binding: it can never bind, so it is deleted and
 *    the candidate guard blocks the delete while the candidate is durable.
 * 4. Every other row (empty-ID rows and orphans, including duplicated orphan
 *    identities and quarantined rows) is surplus relative to SQLite canonical
 *    state and is deleted with its full observed row as CAS evidence; the
 *    durable quarantine/conflict evidence itself is never touched.
 */
export function classifyCleanupRows(
  rows: readonly CleanupRow[],
  evidence: CleanupEvidence,
): readonly CleanupTarget[] {
  const bindingByAnchor = new Map<string, CleanupBinding>();
  for (const binding of evidence.bindings) {
    bindingByAnchor.set(binding.anchorReference, binding);
  }
  const canonicalByAnchor = new Map<string, CleanupCanonicalRow>();
  for (const canonical of evidence.canonical) {
    canonicalByAnchor.set(canonical.anchorReference, canonical);
  }

  const targets: CleanupTarget[] = [];
  const handled = new Set<number>();

  const groups = new Map<string, CleanupRow[]>();
  for (const row of rows) {
    if (row.anchor === null) continue;
    const group = groups.get(row.anchor) ?? [];
    group.push(row);
    groups.set(row.anchor, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const resolvable = lowestRow(group);
    const anchor = resolvable.anchor;
    if (anchor === null) continue;
    const binding = bindingByAnchor.get(anchor);
    if (binding !== undefined && evidence.candidateHashes.has(binding.rowBindingId)) {
      // The duplicate group belongs to a binding with an OPEN/NEEDS_REBASE
      // conflict: never plan the delete while the candidate is durable; the
      // group converges after resolution. The whole group stays handled so
      // no member is re-classified as a rewrite either.
      for (const row of group) handled.add(row.rowNumber);
      continue;
    }
    targets.push({
      kind: "duplicate",
      row: resolvable,
      // A bound anchor's first row is deleted under the binding id so the
      // worker candidate gate can block the delete while a candidate is
      // durable; unbound anchors are orphan evidence with no binding and
      // carry no binding id, so no confirmation is written for a
      // pseudo-binding.
      ...(binding === undefined ? {} : { rowBindingId: binding.rowBindingId }),
    });
    for (const row of group) handled.add(row.rowNumber);
  }

  for (const row of rows) {
    if (row.anchor === null || handled.has(row.rowNumber)) continue;
    const canonical = canonicalByAnchor.get(row.anchor);
    if (canonical !== undefined) {
      // An entity without user-owned fields cannot be projected; leave the
      // row for the lifecycle pipeline instead of failing effect validation.
      if (Object.keys(canonical.fields).length === 0) continue;
      if (observedCanonicalHash(row, canonical.fields) === canonical.fieldRevisionHash) {
        continue;
      }
      // A binding with a durable active candidate (OPEN/NEEDS_REBASE
      // conflict) is skipped entirely: the conflict converges through
      // resolution, whose binding-keyed reconcile supersedes any pending
      // rewrite, so a scan-planned rewrite can never race the resolution.
      if (evidence.candidateHashes.has(canonical.rowBindingId)) continue;
      targets.push({
        kind: "rewrite",
        row,
        canonicalFields: canonical.fields,
        rowBindingId: canonical.rowBindingId,
      });
      continue;
    }
    const binding = bindingByAnchor.get(row.anchor);
    if (binding !== undefined) {
      // Candidate bindings without an entity are human rows pending
      // acceptance; tombstoned/ambiguous bindings are lifecycle-protected.
      // Only an empty-ID row can never bind, so only that shape is deleted.
      if (
        binding.state === "candidate" &&
        row.identity === undefined &&
        // An open conflict on the candidate binding means the row is a
        // disputed human edit; the delete must wait for resolution.
        !evidence.candidateHashes.has(binding.rowBindingId)
      ) {
        targets.push({ kind: "empty_id", row, rowBindingId: binding.rowBindingId });
      }
      continue;
    }
    targets.push({
      kind: row.identity === undefined ? "empty_id" : "extra",
      row,
    });
  }

  return targets;
}

/** Hash of the observed row restricted to the canonical field names. */
function observedCanonicalHash(
  row: CleanupRow,
  canonicalFields: Readonly<Record<string, NormalizedCell>>,
): string {
  const restricted: Record<string, NormalizedCell> = {};
  for (const fieldName of Object.keys(canonicalFields)) {
    restricted[fieldName] = row.fields[fieldName] ?? null;
  }
  return computeSyncVisibleHash(restricted);
}

function lowestRow(rows: readonly CleanupRow[]): CleanupRow {
  let lowest = rows[0]!;
  for (const row of rows) {
    if (row.rowNumber < lowest.rowNumber) lowest = row;
  }
  return lowest;
}

/** Baseline decision for one cleanup target stream. */
export type CleanupBaseline =
  | { readonly kind: "append"; readonly streamSequence: number; readonly supersedeEffectId: string | null }
  | { readonly kind: "defer" };

/**
 * Resolves the outbox baseline for one cleanup stream.
 *
 * Bound rows stream under the BINDING key
 * (`projection-row:<physicalSheetId>:<rowBindingId>`, the same key flush
 * projections and resolution reconciles use) so the cleanup correction joins
 * the row's real predecessor chain and the resolution replan covers it;
 * unbound rows (orphans, empty-ID rows without a binding) keep the physical
 * anchor as their stream key. An in-flight head
 * (pending/processing/delivery_uncertain) defers the scan; a recoverable
 * failed head stays on the worker retry path; terminal heads (non-recoverable
 * failed, blocked_candidate, conflict) are superseded with the new correction
 * in the same transaction so the stream can never wedge.
 */
export async function resolveCleanupBaselineWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  targetId: string,
): Promise<CleanupBaseline> {
  const latest = await sql.get<CleanupLatestEffectSqlShape>(READ_CLEANUP_LATEST_EFFECT_SQL, [
    logicalSheetId,
    targetId,
  ]);
  if (latest === undefined) {
    return { kind: "append", streamSequence: POSITIVE_SAFE_INTEGER_MINIMUM, supersedeEffectId: null };
  }
  const streamSequence = (latest.stream_sequence ?? 0) + 1;
  switch (latest.status) {
    case "pending":
    case "processing":
    case "delivery_uncertain":
      return { kind: "defer" };
    case "applied":
    case "superseded":
      return { kind: "append", streamSequence, supersedeEffectId: null };
    case "failed":
      return isRecoverableEffectErrorCode(latest.last_error_code)
        ? { kind: "defer" }
        : { kind: "append", streamSequence, supersedeEffectId: latest.effect_id };
    case "blocked_candidate":
    case "conflict":
      return { kind: "append", streamSequence, supersedeEffectId: latest.effect_id };
    default:
      return { kind: "defer" };
  }
}

/** Effect-building input shared by the cleanup scan orchestrator. */
export interface CleanupEffectContext {
  readonly storage: SqlStorageAdapter;
  readonly logicalSheetId: string;
  readonly physicalSheetId: string;
  readonly schemaVersion: number;
  readonly identityField: string;
  readonly createId: () => string;
}

/** One built cleanup correction plus the terminal head it supersedes, if any. */
export interface CleanupPlan {
  readonly effect: NewEffect;
  readonly supersedeEffectId: string | null;
}

/**
 * Builds CAS-carrying corrections for every currently safe target.
 *
 * Deletes carry the full observed row (their fields must hash to the observed
 * visible hash, which the provider's full-row deletion guard requires);
 * rewrites carry the canonical user-owned fields with the observed row as the
 * expected CAS state, so the provider only writes when the row is unchanged
 * since the scan observed it.
 */
export async function buildCleanupEffects(
  context: CleanupEffectContext,
  sheet: { readonly tabName: string; readonly registeredRange: string },
  targets: readonly CleanupTarget[],
): Promise<readonly CleanupPlan[]> {
  const plans: CleanupPlan[] = [];
  const commitId = "cleanup:" + context.createId();
  await context.storage.read(async ({ sql }) => {
    // Re-read the durable candidate evidence right before effect building:
    // a conflict that opened after the snapshot classification must also
    // suppress the correction, so a rewrite can never be enqueued while a
    // conflict is open (the resolution's binding-keyed reconcile supersedes
    // anything that still slipped through as pending).
    const protectedBindings = await readCleanupProtectedBindingsWithSql(
      sql,
      context.physicalSheetId,
    );
    for (const target of targets) {
      const anchor = target.row.anchor;
      if (anchor === null) continue;
      if (target.rowBindingId !== undefined && protectedBindings.has(target.rowBindingId)) {
        continue;
      }
      // Bound rows share the binding-keyed stream with flush projections and
      // resolution reconciles so the supersede-on-resolution covers them;
      // unbound rows keep the physical anchor as their stream key.
      const streamTargetId = target.rowBindingId === undefined
        ? anchor
        : cleanupBindingStreamTargetId(context.physicalSheetId, target.rowBindingId);
      const baseline = await resolveCleanupBaselineWithSql(
        sql,
        context.logicalSheetId,
        streamTargetId,
      );
      if (baseline.kind === "defer") continue;
      const expectedVisibleRevision = await resolveCleanupExpectedVisibleRevisionWithSql(
        sql,
        context.physicalSheetId,
        target,
      );
      const effect = target.kind === "rewrite"
        ? buildRewriteEffect(context, sheet, commitId, streamTargetId, anchor, target, baseline.streamSequence, expectedVisibleRevision)
        : buildDeleteEffect(context, sheet, commitId, streamTargetId, anchor, target, baseline.streamSequence, expectedVisibleRevision);
      plans.push({ effect, supersedeEffectId: baseline.supersedeEffectId });
    }
  });
  return plans;
}

/**
 * Deterministic expected visible revision for one cleanup correction.
 *
 * The real provider leaves snapshot revisions ABSENT, so the scan's observed
 * baseline falls back to 1; the durable confirmed revision
 * (sheet_visible_state) is the projection authority and is higher for rows
 * with write history. The correction must carry the higher of the two: the
 * provider CAS compares hashes only (the revision never gates the mutation),
 * but the confirmation mirror rejects a receipt revision below the confirmed
 * one, which would wedge the applied effect in the delivery_uncertain
 * recovery loop forever. Rows without a real binding (orphans, empty-ID
 * rows) have no confirmed state and keep the observed baseline.
 */
async function resolveCleanupExpectedVisibleRevisionWithSql(
  sql: SqlExecutor,
  physicalSheetId: string,
  target: CleanupTarget,
): Promise<number> {
  if (target.rowBindingId === undefined) return target.row.visibleRevision;
  const confirmed = await sql.get<CleanupConfirmedVisibleSqlShape>(
    READ_CLEANUP_CONFIRMED_VISIBLE_REVISION_SQL,
    [physicalSheetId, target.rowBindingId],
  );
  const confirmedRevision = confirmed?.confirmed_visible_revision;
  if (confirmedRevision === undefined || confirmedRevision === null) {
    return target.row.visibleRevision;
  }
  return Math.max(target.row.visibleRevision, confirmedRevision);
}

function buildRewriteEffect(
  context: CleanupEffectContext,
  sheet: { readonly tabName: string; readonly registeredRange: string },
  commitId: string,
  targetId: string,
  anchor: string,
  target: CleanupTarget,
  streamSequence: number,
  expectedVisibleRevision: number,
): NewEffect {
  const canonicalFields = target.canonicalFields ?? {};
  return createCandidateReconcileEffect({
    effectId: "effect:" + context.createId(),
    commitId,
    logicalSheetId: context.logicalSheetId,
    physicalSheetId: context.physicalSheetId,
    sheetName: sheet.tabName,
    registeredRange: sheet.registeredRange,
    projection: SYNC_PROJECTIONS.USER_INPUT,
    schemaVersion: context.schemaVersion,
    targetKind: "projection_row",
    targetId,
    rowBindingId: {
      kind: PRESENCE_KINDS.PRESENT,
      value: target.rowBindingId ?? anchor,
    },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    targetAnchor: anchor,
    fields: canonicalFields,
    createIfMissing: false,
    expectedVisibleRevision,
    expectedVisibleHash: observedCanonicalHash(target.row, canonicalFields),
    streamSequence,
  });
}

function buildDeleteEffect(
  context: CleanupEffectContext,
  sheet: { readonly tabName: string; readonly registeredRange: string },
  commitId: string,
  targetId: string,
  anchor: string,
  target: CleanupTarget,
  streamSequence: number,
  expectedVisibleRevision: number,
): NewEffect {
  return createUserInputDeleteEffect({
    effectId: "effect:" + context.createId(),
    commitId,
    logicalSheetId: context.logicalSheetId,
    physicalSheetId: context.physicalSheetId,
    sheetName: sheet.tabName,
    registeredRange: sheet.registeredRange,
    projection: SYNC_PROJECTIONS.USER_INPUT,
    schemaVersion: context.schemaVersion,
    targetKind: "projection_row",
    targetId,
    // Unbound rows carry no binding id: the worker candidate gate has
    // nothing to protect and the applied delete writes no projection
    // confirmation for a binding that does not exist.
    rowBindingId: target.rowBindingId === undefined
      ? { kind: PRESENCE_KINDS.ABSENT }
      : { kind: PRESENCE_KINDS.PRESENT, value: target.rowBindingId },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    targetAnchor: anchor,
    fields: target.row.fields,
    createIfMissing: false,
    expectedVisibleRevision,
    expectedVisibleHash: target.row.visibleHash,
    streamSequence,
  });
}
