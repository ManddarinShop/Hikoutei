/**
 * Acceptance tests for issue #196: system-advance conflict resolution.
 *
 * A detected User_Input conflict is never resolved by polling alone: the
 * detection persists an OPEN conflict, its active candidate, candidate-time
 * full-row visible evidence, and a durable OPEN Sync_Conflicts audit effect
 * with zero resolution commands. Only a later REAL field revision increase on
 * the SAME conflicted field (committed by a mapped flush) is the implicit
 * system-wins trigger, planned atomically inside the flush transaction.
 *
 * Every core test drives the real production mapped polling path with the
 * fake provider plus SQLite/MikroORM; direct SQL is used only for migration
 * and malformed-evidence boundaries.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTypedSheetsEntity } from "../src/index.js";
import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "@hikoutei/sync-engine/sync/service/SyncServiceBootstrap.js";
import {
  claimEffectWithAdapter,
  claimWriterLeaseWithAdapter,
  markDeliveryUncertainWithAdapter,
  appendPendingEffectsWithSql,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
} from "@hikoutei/ikisaki";
import { presentValue, absentValue, notApplicableValue } from "@hikoutei/contracts/state/index.js";
import { SYNC_PROJECTIONS } from "@hikoutei/contracts/sheets/constants.js";
import {
  openSyncConflictAuditProjectionFields,
  resolvedSyncConflictAuditProjectionFields,
  SYNC_CONFLICT_RESOLUTIONS,
} from "@hikoutei/storage/sync/sheetsContract/conflictProjection.js";
import {
  computeSyncVisibleHash,
  parseSyncProjectionEffectPayload,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { createCandidateReconcileEffect } from "@hikoutei/storage/sync/outbound/projection/ProjectionEffectFactory.js";
import { runUserInputCleanupScan } from "@hikoutei/sync-engine/sync/outbound/reconciliation/CleanupScanner.js";
import { STORAGE_ERROR_CODES } from "@hikoutei/storage/storage/errors.js";
import {
  advanceCandidateVisibleEvidence,
  promoteCandidateVisibleEvidence,
  unavailableCandidateVisibleEvidence,
} from "@hikoutei/storage/storage/state/resolution/candidateEvidence.js";
import { readConflictWithSql } from "@hikoutei/storage/storage/state/resolution/resolutionWriter.js";
import {
  CANDIDATE_VISIBLE_EVIDENCE_STATUSES,
  CONFLICT_STATUSES,
  type ConflictStatus,
} from "@hikoutei/contracts/domain/model/constants.js";
import type { SyncConflict } from "@hikoutei/contracts/domain/model/types.js";
import type { SyncSheetsProvisioner } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import { FakeSyncSheetsProvider } from "./support/FakeSyncSheetsProvider.js";

const User = defineTypedSheetsEntity({
  name: "ConflictUser",
  tableName: "conflict_users",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});

const MigrationOrderSchema = defineEntity({
  name: "MigrationOrder",
  tableName: "migration_orders",
  properties: {
    id: p.string().primary(),
    status: p.string(),
  },
});

class MigrationOrder extends MigrationOrderSchema.class {
  declare id: string;
  declare status: string;
}

MigrationOrderSchema.setClass(MigrationOrder);

const MultiFieldUser = defineTypedSheetsEntity({
  name: "ConflictNotesUser",
  tableName: "conflict_notes_users",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
    notes: { type: "string" },
  },
});

const SYSTEM_SHEET_ID = "entity:conflict_users:system_state";
const USER_INPUT_SHEET_ID = "entity:conflict_users:user_input";
const CONFLICT_SHEET_ID = "entity:conflict_users:sync_conflicts";
const NOTES_SYSTEM_SHEET_ID = "entity:conflict_notes_users:system_state";
const NOTES_USER_INPUT_SHEET_ID = "entity:conflict_notes_users:user_input";
const NOTES_CONFLICT_SHEET_ID = "entity:conflict_notes_users:sync_conflicts";

const CONFLICT_HEADERS = [
  "Conflict_ID",
  "Conflict_Group_ID",
  "Event_ID",
  "Entity_ID",
  "Field_Name",
  "User_Value",
  "User_Base_Revision",
  "Canonical_Value_At_Detection",
  "Canonical_Revision_At_Detection",
  "Current_Canonical_Value",
  "Current_Canonical_Revision",
  "Candidate_Epoch",
  "Status",
  "Resolution",
  "Resolution_Command_ID",
];

const projections = {
  spreadsheetId: "conflict-advance-spreadsheet",
  entities: {
    ConflictUser: {
      systemState: { tabName: "ConflictUsers_System", registeredRange: "A:C" },
      syncConflicts: { tabName: "ConflictUsers_Conflicts", registeredRange: "A:O" },
      userInput: { tabName: "ConflictUsers_Input", registeredRange: "A:C" },
      userOwnedFields: ["id", "status"],
    },
  },
};

const notesProjections = {
  spreadsheetId: "conflict-advance-spreadsheet",
  entities: {
    ConflictNotesUser: {
      systemState: { tabName: "ConflictNotesUsers_System", registeredRange: "A:D" },
      syncConflicts: { tabName: "ConflictNotesUsers_Conflicts", registeredRange: "A:O" },
      userInput: { tabName: "ConflictNotesUsers_Input", registeredRange: "A:D" },
      userOwnedFields: ["id", "status", "notes"],
    },
  },
};

class RecordingProvisioner implements SyncSheetsProvisioner {
  async provisionRegistry(registrations: Parameters<SyncSheetsProvisioner["provisionRegistry"]>[0]) {
    return {
      registrations: registrations.map(({ headers: _headers, ...registration }) => registration),
      createdSheets: registrations.map((registration) => registration.sheetName),
      initializedHeaders: registrations.map((registration) => registration.sheetName),
    };
  }
}

const buildProvider = () =>
  new FakeSyncSheetsProvider([
    {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "ConflictUsers_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: ["id", "status", "__typed_sheets_deleted"],
    },
    {
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "ConflictUsers_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      headers: ["id", "status"],
    },
    {
      physicalSheetId: CONFLICT_SHEET_ID,
      sheetName: "ConflictUsers_Conflicts",
      registeredRange: "A:O",
      projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
      schemaVersion: 1,
      headers: [...CONFLICT_HEADERS],
    },
  ]);

describe("issue #196 system-advance conflict resolution", () => {
  const services: InternalSyncService[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      services.splice(0).map((service) => service.close().catch(() => undefined)),
    );
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const openService = async (
    provider: FakeSyncSheetsProvider,
    options: { readonly dbName?: string; readonly provisioner?: SyncSheetsProvisioner } = {},
  ): Promise<InternalSyncService> => {
    const service = await createInternalSyncService({
      dbName: options.dbName ?? ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: options.provisioner ?? new RecordingProvisioner(),
      // Keep both auto-started loops asleep so explicit passes stay deterministic.
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);
    return service;
  };

  const newDbFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-conflict-advance-"));
    tempDirs.push(dir);
    return join(dir, "conflict-advance.sqlite");
  };

  /** Creates one entity and delivers its projection, returning the User_Input anchor. */
  const createEntity = async (
    service: InternalSyncService,
    provider: FakeSyncSheetsProvider,
    id: string,
    status = "pending",
  ): Promise<string> => {
    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id, status }));
    await em.flush();
    await service.effectSupervisor.runOnce();
    const snapshot = await provider.readSnapshot({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "ConflictUsers_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    const anchor = snapshot.rows[0]?.physicalAnchor;
    if (anchor?.kind !== "present") throw new Error("expected a User_Input row anchor");
    return anchor.value;
  };

  /** Simulates a human edit on one User_Input row. */
  const humanEdit = (
    provider: FakeSyncSheetsProvider,
    anchor: string,
    id: string,
    status: string,
  ): void => {
    provider.mutateRow(USER_INPUT_SHEET_ID, anchor, {
      id: { kind: "string", value: id },
      status: { kind: "string", value: status },
    });
  };

  /**
   * Produces the canonical conflict shape for issue #196: the entity is
   * created, the human edits the sheet, and a later canonical advance moves
   * SQLite past the user's base revision so the next polling pass records an
   * A-vs-B conflict instead of accepting the edit.
   */
  const advanceCanonicalStatus = async (
    service: InternalSyncService,
    id: string,
    status: string,
  ): Promise<void> => {
    const em = service.hikoutei.em.fork();
    const user = await em.findOne(User, { id });
    if (user === null) throw new Error("expected the conflicted entity");
    user.status = status;
    await em.flush();
  };

  const readConflictRow = (
    service: InternalSyncService,
  ): Promise<
    | {
        readonly conflict_id: string;
        readonly status: string;
        readonly candidate_epoch: number;
        readonly current_canonical_revision: number;
        readonly current_canonical_value: string;
        readonly candidate_visible_revision: number | null;
        readonly candidate_visible_hash: string | null;
        readonly last_rebased_commit_id: string | null;
        readonly resolution_command_id: string | null;
      }
    | undefined
  > => service.storage.read(({ sql }) => sql.get(
    "SELECT conflict_id, status, candidate_epoch, current_canonical_revision, current_canonical_value, candidate_visible_revision, candidate_visible_hash, last_rebased_commit_id, resolution_command_id FROM sync_conflict ORDER BY candidate_epoch DESC LIMIT 1",
  ));

  const readCommands = (
    service: InternalSyncService,
  ): Promise<readonly { readonly command_id: string; readonly status: string; readonly expected_revision: number }[]> =>
    service.storage.read(({ sql }) => sql.all(
      "SELECT command_id, status, expected_revision FROM resolution_command ORDER BY command_id",
    ));

  const conflictTabRow = async (
    provider: FakeSyncSheetsProvider,
  ): Promise<Readonly<Record<string, unknown>> | undefined> => {
    const snapshot = await provider.readSnapshot({
      physicalSheetId: CONFLICT_SHEET_ID,
      sheetName: "ConflictUsers_Conflicts",
      registeredRange: "A:O",
      projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
      schemaVersion: 1,
    });
    const row = snapshot.rows[0];
    if (row === undefined) return undefined;
    return Object.fromEntries(
      Object.entries(row.cells).map(([fieldName, cell]) => [
        fieldName,
        cell.normalizedCell,
      ]),
    );
  };

  it("1. records an initial A/B conflict as OPEN with evidence, zero commands, and an OPEN audit projection", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");

    const report = await service.pollingSupervisor.runOnce();
    expect(report.conflictRows).toBe(1);
    await service.effectSupervisor.runOnce();

    const conflict = await readConflictRow(service);
    expect(conflict).toMatchObject({
      status: CONFLICT_STATUSES.OPEN,
      candidate_epoch: 1,
      current_canonical_revision: 2,
      resolution_command_id: null,
    });
    // v6 candidate-time full-row visible evidence is stored, never guessed.
    expect(conflict?.candidate_visible_revision).toBeGreaterThanOrEqual(1);
    expect(typeof conflict?.candidate_visible_hash).toBe("string");
    expect(conflict?.candidate_visible_hash?.length).toBeGreaterThan(0);
    await expect(readCommands(service)).resolves.toEqual([]);

    // Canonical/System_State stays B; User_Input keeps A.
    await expect(service.hikoutei.em.fork().findOne(User, { id: "u1" })).resolves.toMatchObject({
      status: "canonical",
    });
    const systemSnapshot = await provider.readSnapshot({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "ConflictUsers_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    expect(systemSnapshot.rows[0]?.cells).toMatchObject({
      status: { normalizedCell: { kind: "string", value: "canonical" } },
    });
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "human-edit",
    });

    // The durable OPEN audit row materializes with blank resolution columns.
    await service.effectSupervisor.runOnce();
    await expect(conflictTabRow(provider)).resolves.toMatchObject({
      Conflict_ID: { kind: "string", value: conflict?.conflict_id },
      Status: { kind: "string", value: "OPEN" },
      Resolution: null,
      Resolution_Command_ID: null,
      Candidate_Epoch: { kind: "number", value: 1 },
      User_Value: { kind: "string", value: "human-edit" },
      Current_Canonical_Value: { kind: "string", value: "canonical" },
    });
  });

  it("2. repeated polling and a runtime restart leave the OPEN conflict untouched with zero commands", async () => {
    const provider = buildProvider();
    const dbName = newDbFile();
    const service = await openService(provider, { dbName });
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();

    // Repeated polling passes never resolve.
    await service.pollingSupervisor.runOnce();
    await service.pollingSupervisor.runOnce();
    await expect(readConflictRow(service)).resolves.toMatchObject({ status: "OPEN" });
    await expect(readCommands(service)).resolves.toEqual([]);

    // Runtime restart alone never resolves either.
    await service.close();
    const restarted = await openService(provider, { dbName });
    await restarted.pollingSupervisor.runOnce();
    await restarted.pollingSupervisor.runOnce();
    await expect(readConflictRow(restarted)).resolves.toMatchObject({ status: "OPEN" });
    await expect(readCommands(restarted)).resolves.toEqual([]);
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "human-edit",
    });
  });

  it("3. a later same-field B->C flush resolves system-wins, clears the candidate, and converges User_Input", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();
    await service.effectSupervisor.runOnce();

    // The flush itself enqueued no full-row User_Input projection; only the
    // system-wins reconcile (system-wins-commit) may touch the projection row.
    const userEffectsBefore = await service.storage.read(({ sql }) => sql.all<{
      readonly commit_id: string;
    }>(
      "SELECT commit_id FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    await advanceCanonicalStatus(service, "u1", "revised");
    const userEffectsAfter = await service.storage.read(({ sql }) => sql.all<{
      readonly commit_id: string;
    }>(
      "SELECT commit_id FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    // Earlier create/update effects legitimately carry commit IDs; the B->C
    // flush itself must add only the system-wins reconcile effect.
    const flushEffects = userEffectsAfter.slice(userEffectsBefore.length);
    expect(flushEffects.length).toBeGreaterThan(0);
    expect(
      flushEffects.every((effect) => effect.commit_id.startsWith("system-wins-commit:")),
    ).toBe(true);

    // The implicit system-wins command applied in the same flush transaction.
    await expect(readCommands(service)).resolves.toEqual([
      expect.objectContaining({
        command_id: expect.stringMatching(/^sync:system-wins:conflict:/),
        status: "applied",
        expected_revision: 3,
      }),
    ]);
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.RESOLVED,
      current_canonical_revision: 3,
      current_canonical_value: expect.stringContaining("revised"),
      resolution_command_id: expect.stringMatching(/^sync:system-wins:conflict:/),
    });
    const pointer = await service.storage.read(({ sql }) => sql.get<{
      readonly active_candidate_conflict_id: string | null;
      readonly candidate_epoch: number;
    }>(
      "SELECT active_candidate_conflict_id, candidate_epoch FROM sheet_visible_field_state WHERE physical_sheet_id = ? AND projection = ? AND field_name = 'status'",
      [USER_INPUT_SHEET_ID, SYNC_PROJECTIONS.USER_INPUT],
    ));
    expect(pointer).toMatchObject({ active_candidate_conflict_id: null, candidate_epoch: 2 });

    // The worker materializes the canonical rewrite and the RESOLVED audit row.
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "revised",
    });
    await expect(conflictTabRow(provider)).resolves.toMatchObject({
      Status: { kind: "string", value: "RESOLVED" },
      Resolution: { kind: "string", value: "system_wins" },
      Resolution_Command_ID: { kind: "string", value: expect.stringMatching(/^sync:system-wins:conflict:/) },
      Current_Canonical_Value: { kind: "string", value: "revised" },
      Current_Canonical_Revision: { kind: "number", value: 3 },
      Candidate_Epoch: { kind: "number", value: 1 },
    });
  });

  it("4. an unrelated-field flush leaves the OPEN conflict and its evidence untouched", async () => {
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: NOTES_SYSTEM_SHEET_ID,
        sheetName: "ConflictNotesUsers_System",
        registeredRange: "A:D",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "notes", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: NOTES_USER_INPUT_SHEET_ID,
        sheetName: "ConflictNotesUsers_Input",
        registeredRange: "A:D",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status", "notes"],
      },
      {
        physicalSheetId: NOTES_CONFLICT_SHEET_ID,
        sheetName: "ConflictNotesUsers_Conflicts",
        registeredRange: "A:O",
        projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
        schemaVersion: 1,
        headers: [...CONFLICT_HEADERS],
      },
    ]);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [MultiFieldUser],
      projections: notesProjections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(MultiFieldUser, { id: "u1", status: "pending", notes: "none" }));
    await em.flush();
    await service.effectSupervisor.runOnce();
    const snapshot = await provider.readSnapshot({
      physicalSheetId: NOTES_USER_INPUT_SHEET_ID,
      sheetName: "ConflictNotesUsers_Input",
      registeredRange: "A:D",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    const anchor = snapshot.rows[0]?.physicalAnchor;
    if (anchor?.kind !== "present") throw new Error("expected a User_Input row anchor");
    provider.mutateRow(NOTES_USER_INPUT_SHEET_ID, anchor.value, {
      id: { kind: "string", value: "u1" },
      status: { kind: "string", value: "human-edit" },
      notes: { kind: "string", value: "none" },
    });
    const statusManager = service.hikoutei.em.fork();
    const statusUser = await statusManager.findOne(MultiFieldUser, { id: "u1" });
    if (statusUser === null) throw new Error("expected the conflicted entity");
    statusUser.status = "canonical";
    await statusManager.flush();
    await service.pollingSupervisor.runOnce();

    const before = await service.storage.read(({ sql }) => sql.all<{
      readonly effect_id: string;
    }>(
      "SELECT effect_id FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    const notesManager = service.hikoutei.em.fork();
    const notesUser = await notesManager.findOne(MultiFieldUser, { id: "u1" });
    if (notesUser === null) throw new Error("expected the conflicted entity");
    notesUser.notes = "updated";
    await notesManager.flush();

    // Unrelated updates never trigger: conflict stays OPEN, no commands, no
    // rebase, and the full-row User_Input projection stays suppressed.
    const conflict = await service.storage.read(({ sql }) => sql.get<{
      readonly status: string;
      readonly current_canonical_revision: number;
    }>(
      "SELECT status, current_canonical_revision FROM sync_conflict",
    ));
    expect(conflict).toEqual({ status: "OPEN", current_canonical_revision: 2 });
    await expect(readCommands(service)).resolves.toEqual([]);
    const after = await service.storage.read(({ sql }) => sql.all<{
      readonly effect_id: string;
    }>(
      "SELECT effect_id FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    expect(after.map((effect) => effect.effect_id)).toEqual(before.map((effect) => effect.effect_id));
    expect(provider.readRow(NOTES_USER_INPUT_SHEET_ID, anchor.value).fields.status).toEqual({
      kind: "string",
      value: "human-edit",
    });
    await expect(
      service.hikoutei.em.fork().findOne(MultiFieldUser, { id: "u1" }),
    ).resolves.toMatchObject({ status: "canonical", notes: "updated" });
  });

  it("5. a same-candidate re-observation advances stored evidence monotonically and resolution uses the newer CAS baseline", async () => {
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: NOTES_SYSTEM_SHEET_ID,
        sheetName: "ConflictNotesUsers_System",
        registeredRange: "A:D",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "notes", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: NOTES_USER_INPUT_SHEET_ID,
        sheetName: "ConflictNotesUsers_Input",
        registeredRange: "A:D",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status", "notes"],
      },
      {
        physicalSheetId: NOTES_CONFLICT_SHEET_ID,
        sheetName: "ConflictNotesUsers_Conflicts",
        registeredRange: "A:O",
        projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
        schemaVersion: 1,
        headers: [...CONFLICT_HEADERS],
      },
    ]);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [MultiFieldUser],
      projections: notesProjections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(MultiFieldUser, { id: "u1", status: "pending", notes: "none" }));
    await em.flush();
    await service.effectSupervisor.runOnce();
    const snapshot = await provider.readSnapshot({
      physicalSheetId: NOTES_USER_INPUT_SHEET_ID,
      sheetName: "ConflictNotesUsers_Input",
      registeredRange: "A:D",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    const anchor = snapshot.rows[0]?.physicalAnchor;
    if (anchor?.kind !== "present") throw new Error("expected a User_Input row anchor");
    provider.mutateRow(NOTES_USER_INPUT_SHEET_ID, anchor.value, {
      id: { kind: "string", value: "u1" },
      status: { kind: "string", value: "human-edit" },
      notes: { kind: "string", value: "none" },
    });
    const statusManager = service.hikoutei.em.fork();
    const statusUser = await statusManager.findOne(MultiFieldUser, { id: "u1" });
    if (statusUser === null) throw new Error("expected the conflicted entity");
    statusUser.status = "canonical";
    await statusManager.flush();
    await service.pollingSupervisor.runOnce();
    await service.effectSupervisor.runOnce();

    const detected = await service.storage.read(({ sql }) => sql.get<{
      readonly status: string;
      readonly candidate_visible_revision: number;
    }>(
      "SELECT status, candidate_visible_revision FROM sync_conflict WHERE field_name = 'status'",
    ));
    expect(detected).toEqual({ status: "OPEN", candidate_visible_revision: 2 });
    await expect(readCommands(service)).resolves.toEqual([]);

    // The human edits a DIFFERENT field on the same row. The status candidate
    // is unchanged, so the polling pass re-observes the SAME status candidate
    // and advances its stored full-row CAS evidence to the newer row revision
    // instead of opening a new status generation. The notes edit is itself a
    // separate unresolved candidate (fail-closed, no guessing).
    provider.mutateRow(NOTES_USER_INPUT_SHEET_ID, anchor.value, {
      id: { kind: "string", value: "u1" },
      status: { kind: "string", value: "human-edit" },
      notes: { kind: "string", value: "note-1" },
    });
    const report = await service.pollingSupervisor.runOnce();
    // One NEW conflict (notes); the status conflict is re-observed, not
    // re-created.
    expect(report.conflictRows).toBe(1);
    const conflicts = await service.storage.read(({ sql }) => sql.all<{
      readonly field_name: string;
      readonly candidate_epoch: number;
      readonly status: string;
      readonly candidate_visible_revision: number;
      readonly candidate_visible_hash: string | null;
    }>(
      "SELECT field_name, candidate_epoch, status, candidate_visible_revision, candidate_visible_hash FROM sync_conflict ORDER BY field_name",
    ));
    expect(conflicts).toEqual([
      expect.objectContaining({
        field_name: "notes",
        candidate_epoch: 1,
        status: "OPEN",
        candidate_visible_revision: 3,
      }),
      expect.objectContaining({
        field_name: "status",
        candidate_epoch: 1,
        status: "OPEN",
        candidate_visible_revision: 3,
      }),
    ]);
    await expect(readCommands(service)).resolves.toEqual([]);

    // A later same-field canonical advance resolves the STATUS conflict from
    // the ADVANCED evidence: the planned reconcile CAS carries the newer row
    // revision/hash, never the stale detection-time baseline.
    const revisedManager = service.hikoutei.em.fork();
    const revisedUser = await revisedManager.findOne(MultiFieldUser, { id: "u1" });
    if (revisedUser === null) throw new Error("expected the conflicted entity");
    revisedUser.status = "revised";
    await revisedManager.flush();
    await expect(service.storage.read(({ sql }) => sql.get<{
      readonly status: string;
      readonly current_canonical_revision: number;
    }>(
      "SELECT status, current_canonical_revision FROM sync_conflict WHERE field_name = 'status'",
    ))).resolves.toMatchObject({
      status: "RESOLVED",
      current_canonical_revision: 3,
    });
    await expect(service.storage.read(({ sql }) => sql.get<{
      readonly expected_visible_revision: number;
      readonly expected_visible_hash: string;
    }>(
      "SELECT expected_visible_revision, expected_visible_hash FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence DESC LIMIT 1",
      [SYNC_PROJECTIONS.USER_INPUT],
    ))).resolves.toMatchObject({ expected_visible_revision: 3 });

    // The reconcile would rewrite the FULL row, so the unresolved notes
    // candidate blocks it (fail-closed): the human row stays untouched until
    // the notes conflict is settled.
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    expect(provider.readRow(NOTES_USER_INPUT_SHEET_ID, anchor.value).fields.status).toEqual({
      kind: "string",
      value: "human-edit",
    });
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence DESC LIMIT 1",
      [SYNC_PROJECTIONS.USER_INPUT],
    ))).resolves.toMatchObject({ status: "blocked_candidate" });
  });

  it("6. a newer pending D command stales the pending C generation and only D applies", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");

    // A pre-detection flush leaves a User_Input effect in flight so every
    // planned system-wins command is deferred.
    await advanceCanonicalStatus(service, "u1", "server-update");
    const predecessor = await service.storage.read(({ sql }) => sql.get<{ readonly effect_id: string }>(
      "SELECT effect_id FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence DESC LIMIT 1",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    if (predecessor === undefined) throw new Error("expected a User_Input predecessor effect");
    const leaseNow = Date.now();
    const lease = await claimWriterLeaseWithAdapter(service.storage, {
      role: "test-deferred-effect-worker",
      writerId: "test-deferred-effect-worker",
      leaseDurationMs: 60_000,
      now: leaseNow,
    });
    if (lease.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("expected a recovery writer lease");
    }
    const fence = {
      role: lease.lease.role,
      writerEpoch: lease.lease.writerEpoch,
      fencingToken: lease.lease.fencingToken,
      now: leaseNow,
    };
    const claim = await claimEffectWithAdapter(service.storage, {
      ...fence,
      effectId: predecessor.effect_id,
      claimToken: "deferred-test-claim",
      leaseDurationMs: 60_000,
    });
    expect(claim.status).toBe("claimed");

    await service.pollingSupervisor.runOnce();

    // Flush C: command C pending.
    await advanceCanonicalStatus(service, "u1", "step-c");
    await expect(readCommands(service)).resolves.toEqual([
      expect.objectContaining({ status: "pending", expected_revision: 3 }),
    ]);

    // Flush D: only the latest command may stay pending; C is staled.
    await advanceCanonicalStatus(service, "u1", "step-d");
    const commands = await readCommands(service);
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.status).sort()).toEqual(["pending", "stale"]);
    const pending = commands.find((command) => command.status === "pending");
    const stale = commands.find((command) => command.status === "stale");
    expect(pending?.expected_revision).toBe(4);
    expect(stale?.expected_revision).toBe(3);
    expect(pending?.command_id).not.toBe(stale?.command_id);

    // Settle the predecessor; the exact latest command applies and the
    // conflict resolves at revision D.
    await service.storage.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'applied' WHERE effect_id = ?",
      [predecessor.effect_id],
    ));
    await service.pollingSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.RESOLVED,
      current_canonical_revision: 4,
    });
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "step-d",
    });
  });

  it("7. a legacy sync:auto-system-wins pending command is staled idempotently and the conflict stays OPEN", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();

    const conflict = await readConflictRow(service);
    if (conflict === undefined) throw new Error("expected a conflict row");
    const now = Date.now();
    // Seed the retired creation-time command identity exactly as the old
    // resolver produced it, without any new canonical commit.
    await service.storage.transaction(({ sql }) => sql.run(
      "INSERT INTO resolution_command (command_id, request_key, action, actor_id, role, target_conflict_id, expected_revision, active_candidate_hash, expected_candidate_epoch, payload_hash, status, issued_at) VALUES (?, ?, 'acknowledge_system', 'sync:auto-system-wins', 'sync_operator', ?, ?, ?, ?, ?, 'pending', ?)",
      [
        `auto-system-wins:${conflict.conflict_id}:${conflict.candidate_epoch}`,
        `auto-system-wins:${conflict.conflict_id}:${conflict.candidate_epoch}`,
        conflict.conflict_id,
        conflict.current_canonical_revision,
        "legacy-candidate-hash",
        conflict.candidate_epoch,
        "legacy-payload-hash",
        now,
      ],
    ));

    // Polling retries pending commands; the legacy command is staled without
    // resolving anything, idempotently across passes.
    await service.pollingSupervisor.runOnce();
    await expect(readCommands(service)).resolves.toEqual([
      expect.objectContaining({ status: "stale" }),
    ]);
    await expect(readConflictRow(service)).resolves.toMatchObject({ status: "OPEN" });
    await service.pollingSupervisor.runOnce();
    await service.pollingSupervisor.runOnce();
    await expect(readCommands(service)).resolves.toEqual([
      expect.objectContaining({ status: "stale" }),
    ]);
    await expect(readConflictRow(service)).resolves.toMatchObject({ status: "OPEN" });
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "human-edit",
    });
  });

  it("8. a post-candidate remote edit is never overwritten and becomes a new conflict generation", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();
    const first = await readConflictRow(service);
    if (first === undefined) throw new Error("expected the first conflict");

    // The human edits the SAME field again after detection: the stored
    // candidate evidence no longer matches the remote row.
    humanEdit(provider, anchor, "u1", "human-edit-2");
    await advanceCanonicalStatus(service, "u1", "revised");

    // The system-wins resolution applies, but its reconcile must fail the
    // visible-hash CAS instead of overwriting the newer human edit.
    await expect(readConflictRow(service)).resolves.toMatchObject({ status: "RESOLVED" });
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "human-edit-2",
    });
    const blocked = await service.storage.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM sheet_effect_outbox WHERE projection = ? AND status = 'blocked_candidate'",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    expect(blocked).toBeDefined();

    // The next polling pass creates a NEW generation (epoch 2) with its own
    // OPEN audit effect instead of trusting the old evidence.
    const report = await service.pollingSupervisor.runOnce();
    expect(report.conflictRows).toBe(1);
    const conflicts = await service.storage.read(({ sql }) => sql.all<{
      readonly conflict_id: string;
      readonly candidate_epoch: number;
      readonly status: string;
    }>(
      "SELECT conflict_id, candidate_epoch, status FROM sync_conflict ORDER BY candidate_epoch",
    ));
    expect(conflicts).toEqual([
      { conflict_id: first.conflict_id, candidate_epoch: 1, status: "RESOLVED" },
      expect.objectContaining({ candidate_epoch: 2, status: "OPEN" }),
    ]);
    await expect(readCommands(service)).resolves.toEqual([
      expect.objectContaining({ status: "applied" }),
    ]);
  });

  it("9. B->A with a genuine new canonical revision is a valid trigger and resolves", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();

    // The app now commits the SAME value the human typed, at a strictly
    // newer canonical revision: a real same-field advance, so it resolves.
    await advanceCanonicalStatus(service, "u1", "human-edit");

    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.RESOLVED,
      current_canonical_revision: 3,
    });
    await expect(readCommands(service)).resolves.toEqual([
      expect.objectContaining({ status: "applied" }),
    ]);
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "human-edit",
    });
    await expect(
      service.hikoutei.em.fork().findOne(User, { id: "u1" }),
    ).resolves.toMatchObject({ status: "human-edit" });
  });

  it("10. a mapped delete with an unresolved conflict fails closed and rolls back completely", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();

    const effectsBefore = await service.storage.read(({ sql }) => sql.all<{
      readonly effect_id: string;
    }>(
      "SELECT effect_id FROM sheet_effect_outbox ORDER BY stream_sequence",
    ));
    const em = service.hikoutei.em.fork();
    const user = await em.findOne(User, { id: "u1" });
    if (user === null) throw new Error("expected the conflicted entity");
    em.remove(user);
    await expect(em.flush()).rejects.toMatchObject({
      code: "projection_outbox_blocked",
    });

    // Nothing changed: entity, canonical state, binding, conflict, outbox.
    await expect(service.hikoutei.em.fork().findOne(User, { id: "u1" })).resolves.toMatchObject({
      status: "canonical",
    });
    const canonical = await service.storage.read(({ sql }) => sql.get<{
      readonly status: string;
    }>(
      "SELECT status FROM entity_state WHERE entity_id = ?",
      ["entity:conflict_users:u1"],
    ));
    expect(canonical).toEqual({ status: "active" });
    await expect(readConflictRow(service)).resolves.toMatchObject({ status: "OPEN" });
    const effectsAfter = await service.storage.read(({ sql }) => sql.all<{
      readonly effect_id: string;
    }>(
      "SELECT effect_id FROM sheet_effect_outbox ORDER BY stream_sequence",
    ));
    expect(effectsAfter.map((effect) => effect.effect_id)).toEqual(
      effectsBefore.map((effect) => effect.effect_id),
    );
    await expect(readCommands(service)).resolves.toEqual([]);
  });

  it("11. polling and system advances never consume manual or unknown pending commands", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();

    const conflict = await readConflictRow(service);
    if (conflict === undefined) throw new Error("expected a conflict row");
    const now = Date.now();
    // Seed a manual pending command (foreign actor/action) and an incoherent
    // command that borrows the implicit identity prefix without the implicit
    // actor: neither is polling-owned and both must stay untouched.
    await service.storage.transaction(({ sql }) => sql.run(
      "INSERT INTO resolution_command (command_id, request_key, action, actor_id, role, target_conflict_id, expected_revision, active_candidate_hash, expected_candidate_epoch, payload_hash, status, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      [
        `manual:${conflict.conflict_id}`,
        `manual:${conflict.conflict_id}`,
        "acknowledge_user",
        "manual-user",
        "user",
        conflict.conflict_id,
        conflict.current_canonical_revision,
        "manual-candidate-hash",
        conflict.candidate_epoch,
        "manual-payload-hash",
        now,
      ],
    ));
    await service.storage.transaction(({ sql }) => sql.run(
      "INSERT INTO resolution_command (command_id, request_key, action, actor_id, role, target_conflict_id, expected_revision, active_candidate_hash, expected_candidate_epoch, payload_hash, status, issued_at) VALUES (?, ?, 'acknowledge_system', 'manual-user', 'sync_operator', ?, ?, ?, ?, ?, 'pending', ?)",
      [
        `sync:system-wins:${conflict.conflict_id}:${conflict.candidate_epoch}:${conflict.current_canonical_revision}`,
        `sync:system-wins:${conflict.conflict_id}:${conflict.candidate_epoch}:${conflict.current_canonical_revision}`,
        conflict.conflict_id,
        conflict.current_canonical_revision,
        "borrowed-prefix-hash",
        conflict.candidate_epoch,
        "borrowed-prefix-payload",
        now,
      ],
    ));

    // Repeated polling retries must leave both foreign commands pending.
    await service.pollingSupervisor.runOnce();
    await service.pollingSupervisor.runOnce();
    const untouched = await readCommands(service);
    expect(untouched.filter((command) => command.status === "pending")).toHaveLength(2);
    expect(untouched.filter((command) => command.status === "stale")).toHaveLength(0);
    await expect(readConflictRow(service)).resolves.toMatchObject({ status: "OPEN" });

    // A real system advance plans a newer implicit command; only automatic
    // generations may be superseded, so both foreign commands stay pending.
    await advanceCanonicalStatus(service, "u1", "revised");
    const after = await readCommands(service);
    expect(after.filter((command) => command.status === "pending")).toHaveLength(2);
    expect(after.find((command) => command.status === "applied")).toMatchObject({
      status: "applied",
      expected_revision: 3,
    });
    await expect(readConflictRow(service)).resolves.toMatchObject({ status: "RESOLVED" });
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "revised",
    });
  });

  it("12. a legacy conflict without candidate evidence is never upgraded by later polling and stays unresolved", async () => {
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: NOTES_SYSTEM_SHEET_ID,
        sheetName: "ConflictNotesUsers_System",
        registeredRange: "A:D",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "notes", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: NOTES_USER_INPUT_SHEET_ID,
        sheetName: "ConflictNotesUsers_Input",
        registeredRange: "A:D",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status", "notes"],
      },
      {
        physicalSheetId: NOTES_CONFLICT_SHEET_ID,
        sheetName: "ConflictNotesUsers_Conflicts",
        registeredRange: "A:O",
        projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
        schemaVersion: 1,
        headers: [...CONFLICT_HEADERS],
      },
    ]);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [MultiFieldUser],
      projections: notesProjections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(MultiFieldUser, { id: "u1", status: "pending", notes: "none" }));
    await em.flush();
    await service.effectSupervisor.runOnce();
    const snapshot = await provider.readSnapshot({
      physicalSheetId: NOTES_USER_INPUT_SHEET_ID,
      sheetName: "ConflictNotesUsers_Input",
      registeredRange: "A:D",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    const anchor = snapshot.rows[0]?.physicalAnchor;
    if (anchor?.kind !== "present") throw new Error("expected a User_Input row anchor");
    provider.mutateRow(NOTES_USER_INPUT_SHEET_ID, anchor.value, {
      id: { kind: "string", value: "u1" },
      status: { kind: "string", value: "human-edit" },
      notes: { kind: "string", value: "none" },
    });
    const statusManager = service.hikoutei.em.fork();
    const statusUser = await statusManager.findOne(MultiFieldUser, { id: "u1" });
    if (statusUser === null) throw new Error("expected the conflicted entity");
    statusUser.status = "canonical";
    await statusManager.flush();
    await service.pollingSupervisor.runOnce();

    // Fresh v6 conflicts persist AVAILABLE evidence at creation...
    await expect(service.storage.read(({ sql }) => sql.get<{
      readonly candidate_visible_revision: number | null;
    }>(
      "SELECT candidate_visible_revision FROM sync_conflict WHERE field_name = 'status'",
    ))).resolves.toEqual({ candidate_visible_revision: 2 });

    // ...so simulate the legacy v5 row shape: both evidence columns NULL.
    await service.storage.transaction(({ sql }) => sql.run(
      "UPDATE sync_conflict SET candidate_visible_revision = NULL, candidate_visible_hash = NULL WHERE field_name = 'status'",
    ));

    // A later same-candidate observation (the row advances via the notes
    // edit) must NOT upgrade the legacy row into an auto-resolvable baseline.
    provider.mutateRow(NOTES_USER_INPUT_SHEET_ID, anchor.value, {
      id: { kind: "string", value: "u1" },
      status: { kind: "string", value: "human-edit" },
      notes: { kind: "string", value: "note-1" },
    });
    const report = await service.pollingSupervisor.runOnce();
    expect(report.conflictRows).toBe(1);
    await expect(service.storage.read(({ sql }) => sql.get<{
      readonly status: string;
      readonly candidate_visible_revision: number | null;
      readonly candidate_visible_hash: string | null;
    }>(
      "SELECT status, candidate_visible_revision, candidate_visible_hash FROM sync_conflict WHERE field_name = 'status'",
    ))).resolves.toEqual({
      status: "OPEN",
      candidate_visible_revision: null,
      candidate_visible_hash: null,
    });
    await expect(service.storage.read(({ sql }) => sql.get<{
      readonly candidate_visible_revision: number;
    }>(
      "SELECT candidate_visible_revision FROM sync_conflict WHERE field_name = 'notes'",
    ))).resolves.toEqual({ candidate_visible_revision: 3 });
    await expect(readCommands(service)).resolves.toEqual([]);

    // A later same-field canonical advance rebases but never plans a command:
    // with no CAS baseline the resolver must not guess confirmed evidence.
    const revisedManager = service.hikoutei.em.fork();
    const revisedUser = await revisedManager.findOne(MultiFieldUser, { id: "u1" });
    if (revisedUser === null) throw new Error("expected the conflicted entity");
    revisedUser.status = "revised";
    await revisedManager.flush();
    await expect(service.storage.read(({ sql }) => sql.get<{
      readonly status: string;
      readonly current_canonical_revision: number;
      readonly resolution_command_id: string | null;
    }>(
      "SELECT status, current_canonical_revision, resolution_command_id FROM sync_conflict WHERE field_name = 'status'",
    ))).resolves.toEqual({
      status: "NEEDS_REBASE",
      current_canonical_revision: 3,
      resolution_command_id: null,
    });
    await expect(readCommands(service)).resolves.toEqual([]);
  });

  it("13. a one-sided active candidate pointer fails a mapped update closed instead of overwriting", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();

    // Corrupt the pointer: keep the conflict ID, drop the candidate hash.
    await service.storage.transaction(({ sql }) => sql.run(
      "UPDATE sheet_visible_field_state SET active_candidate_hash = NULL WHERE physical_sheet_id = ? AND projection = ? AND field_name = 'status'",
      [USER_INPUT_SHEET_ID, SYNC_PROJECTIONS.USER_INPUT],
    ));

    // The mapped update must fail closed with a structured consistency error
    // instead of treating the row as candidate-free and overwriting it.
    const em = service.hikoutei.em.fork();
    const user = await em.findOne(User, { id: "u1" });
    if (user === null) throw new Error("expected the conflicted entity");
    user.status = "overwrite";
    await expect(em.flush()).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.OBSERVATION_STORAGE_INCONSISTENT,
    });

    // Nothing changed: entity, conflict, and the human's User_Input row survive.
    await expect(service.hikoutei.em.fork().findOne(User, { id: "u1" })).resolves.toMatchObject({
      status: "canonical",
    });
    await expect(readConflictRow(service)).resolves.toMatchObject({ status: "OPEN" });
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "human-edit",
    });
  });

  it("14. a flush defers instead of rolling back when the OPEN audit effect is processing, then resolves in stream order", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();

    // The OPEN audit effect is claimed (processing) when the B->C flush runs.
    const openEffect = await service.storage.read(({ sql }) => sql.get<{
      readonly effect_id: string;
    }>(
      "SELECT effect_id FROM sheet_effect_outbox WHERE target_kind = 'conflict' ORDER BY stream_sequence LIMIT 1",
    ));
    if (openEffect === undefined) throw new Error("expected the OPEN audit effect");
    const leaseNow = Date.now();
    const lease = await claimWriterLeaseWithAdapter(service.storage, {
      role: "test-processing-audit-worker",
      writerId: "test-processing-audit-worker",
      leaseDurationMs: 60_000,
      now: leaseNow,
    });
    if (lease.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("expected a recovery writer lease");
    }
    const fence = {
      role: lease.lease.role,
      writerEpoch: lease.lease.writerEpoch,
      fencingToken: lease.lease.fencingToken,
      now: leaseNow,
    };
    const claim = await claimEffectWithAdapter(service.storage, {
      ...fence,
      effectId: openEffect.effect_id,
      claimToken: "processing-audit-claim",
      leaseDurationMs: 60_000,
    });
    expect(claim.status).toBe("claimed");

    // The flush SUCCEEDS: the canonical advance and the rebase commit, the
    // exact command stays durable-pending, and no EFFECT_REPLAN_CONFLICT
    // escapes to roll back the transaction.
    await advanceCanonicalStatus(service, "u1", "revised");
    await expect(service.hikoutei.em.fork().findOne(User, { id: "u1" })).resolves.toMatchObject({
      status: "revised",
    });
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.NEEDS_REBASE,
      current_canonical_revision: 3,
      current_canonical_value: expect.stringContaining("revised"),
      resolution_command_id: null,
    });
    await expect(readCommands(service)).resolves.toEqual([
      expect.objectContaining({ status: "pending", expected_revision: 3 }),
    ]);
    // The NEEDS_REBASE audit effect was deferred, not appended, while the
    // processing predecessor owns the conflict stream.
    const deferred = await service.storage.read(({ sql }) => sql.all<{
      readonly stream_sequence: number;
      readonly status: string;
    }>(
      "SELECT stream_sequence, status FROM sheet_effect_outbox WHERE target_kind = 'conflict' ORDER BY stream_sequence",
    ));
    expect(deferred).toEqual([{ stream_sequence: 1, status: "processing" }]);

    // Settle the predecessor: requeue the claimed effect and dispatch it so
    // the OPEN audit row materializes before the retry replans the stream.
    await service.storage.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'pending', claim_token = NULL, lease_until = NULL, next_attempt_at = 0, next_probe_at = NULL WHERE effect_id = ?",
      [openEffect.effect_id],
    ));
    await service.effectSupervisor.runOnce();

    // The retry pass replans the NEEDS_REBASE audit effect and applies the
    // exact pending command (same identity, expected_revision C).
    await service.pollingSupervisor.runOnce();
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.RESOLVED,
      current_canonical_revision: 3,
      resolution_command_id: expect.stringMatching(/^sync:system-wins:conflict:/),
    });
    await expect(readCommands(service)).resolves.toEqual([
      expect.objectContaining({ status: "applied", expected_revision: 3 }),
    ]);

    // User_Input converges to C and the audit stream materializes OPEN,
    // NEEDS_REBASE, RESOLVED in stream order with the tab row ending RESOLVED.
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "revised",
    });
    await expect(conflictTabRow(provider)).resolves.toMatchObject({
      Status: { kind: "string", value: "RESOLVED" },
      Resolution: { kind: "string", value: "system_wins" },
      Current_Canonical_Value: { kind: "string", value: "revised" },
      Current_Canonical_Revision: { kind: "number", value: 3 },
    });
    const auditStream = await service.storage.read(({ sql }) => sql.all<{
      readonly stream_sequence: number;
      readonly status: string;
      readonly payload_json: string;
    }>(
      "SELECT stream_sequence, status, payload_json FROM sheet_effect_outbox WHERE target_kind = 'conflict' ORDER BY stream_sequence",
    ));
    expect(auditStream.map((effect) => ({
      streamSequence: effect.stream_sequence,
      status: effect.status,
      auditStatus: parseSyncProjectionEffectPayload(effect.payload_json).fields.Status,
    }))).toEqual([
      { streamSequence: 1, status: "applied", auditStatus: { kind: "string", value: "OPEN" } },
      { streamSequence: 2, status: "superseded", auditStatus: { kind: "string", value: "NEEDS_REBASE" } },
      { streamSequence: 3, status: "applied", auditStatus: { kind: "string", value: "RESOLVED" } },
    ]);
  });

  it("15. a flush defers instead of rolling back when the OPEN audit effect is delivery_uncertain, then resolves in stream order", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();

    // The OPEN audit effect lost its delivery answer (awaiting a probe) when
    // the B->C flush runs.
    const openEffect = await service.storage.read(({ sql }) => sql.get<{
      readonly effect_id: string;
    }>(
      "SELECT effect_id FROM sheet_effect_outbox WHERE target_kind = 'conflict' ORDER BY stream_sequence LIMIT 1",
    ));
    if (openEffect === undefined) throw new Error("expected the OPEN audit effect");
    const leaseNow = Date.now();
    const lease = await claimWriterLeaseWithAdapter(service.storage, {
      role: "test-uncertain-audit-worker",
      writerId: "test-uncertain-audit-worker",
      leaseDurationMs: 60_000,
      now: leaseNow,
    });
    if (lease.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("expected a recovery writer lease");
    }
    const fence = {
      role: lease.lease.role,
      writerEpoch: lease.lease.writerEpoch,
      fencingToken: lease.lease.fencingToken,
      now: leaseNow,
    };
    const claim = await claimEffectWithAdapter(service.storage, {
      ...fence,
      effectId: openEffect.effect_id,
      claimToken: "uncertain-audit-claim",
      leaseDurationMs: 60_000,
    });
    expect(claim.status).toBe("claimed");
    await expect(markDeliveryUncertainWithAdapter(service.storage, {
      ...fence,
      effectId: openEffect.effect_id,
      claimToken: "uncertain-audit-claim",
      uncertainSince: leaseNow,
      nextProbeAt: leaseNow,
      lastErrorCode: "test_delivery_uncertain",
      lastErrorMessage: "test: delivery answer lost",
    })).resolves.toBe(true);

    // The flush SUCCEEDS with the same deferred semantics as a processing
    // predecessor: canonical advance and rebase commit, exact command stays
    // durable-pending, no EFFECT_REPLAN_CONFLICT escapes.
    await advanceCanonicalStatus(service, "u1", "revised");
    await expect(service.hikoutei.em.fork().findOne(User, { id: "u1" })).resolves.toMatchObject({
      status: "revised",
    });
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.NEEDS_REBASE,
      current_canonical_revision: 3,
      current_canonical_value: expect.stringContaining("revised"),
      resolution_command_id: null,
    });
    await expect(readCommands(service)).resolves.toEqual([
      expect.objectContaining({ status: "pending", expected_revision: 3 }),
    ]);
    const deferred = await service.storage.read(({ sql }) => sql.all<{
      readonly stream_sequence: number;
      readonly status: string;
    }>(
      "SELECT stream_sequence, status FROM sheet_effect_outbox WHERE target_kind = 'conflict' ORDER BY stream_sequence",
    ));
    expect(deferred).toEqual([{ stream_sequence: 1, status: "delivery_uncertain" }]);

    // Settle the predecessor: requeue the uncertain effect and dispatch it so
    // the OPEN audit row materializes before the retry replans the stream.
    await service.storage.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'pending', claim_token = NULL, lease_until = NULL, next_attempt_at = 0, next_probe_at = NULL WHERE effect_id = ?",
      [openEffect.effect_id],
    ));
    await service.effectSupervisor.runOnce();

    // The retry pass replans the NEEDS_REBASE audit effect and applies the
    // exact pending command.
    await service.pollingSupervisor.runOnce();
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.RESOLVED,
      current_canonical_revision: 3,
      resolution_command_id: expect.stringMatching(/^sync:system-wins:conflict:/),
    });
    await expect(readCommands(service)).resolves.toEqual([
      expect.objectContaining({ status: "applied", expected_revision: 3 }),
    ]);

    // User_Input converges to C and the audit stream materializes OPEN,
    // NEEDS_REBASE, RESOLVED in stream order with the tab row ending RESOLVED.
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "revised",
    });
    await expect(conflictTabRow(provider)).resolves.toMatchObject({
      Status: { kind: "string", value: "RESOLVED" },
      Resolution: { kind: "string", value: "system_wins" },
      Current_Canonical_Value: { kind: "string", value: "revised" },
      Current_Canonical_Revision: { kind: "number", value: 3 },
    });
    const auditStream = await service.storage.read(({ sql }) => sql.all<{
      readonly stream_sequence: number;
      readonly status: string;
      readonly payload_json: string;
    }>(
      "SELECT stream_sequence, status, payload_json FROM sheet_effect_outbox WHERE target_kind = 'conflict' ORDER BY stream_sequence",
    ));
    expect(auditStream.map((effect) => ({
      streamSequence: effect.stream_sequence,
      status: effect.status,
      auditStatus: parseSyncProjectionEffectPayload(effect.payload_json).fields.Status,
    }))).toEqual([
      { streamSequence: 1, status: "applied", auditStatus: { kind: "string", value: "OPEN" } },
      { streamSequence: 2, status: "superseded", auditStatus: { kind: "string", value: "NEEDS_REBASE" } },
      { streamSequence: 3, status: "applied", auditStatus: { kind: "string", value: "RESOLVED" } },
    ]);
  });

  it("16. a two-sided active candidate pointer to a RESOLVED conflict fails closed instead of overwriting", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();

    // Normal resolution clears the pointer in the same transaction that
    // marks the conflict RESOLVED, so this state is unreachable through real
    // code paths; seed it directly to prove the candidate gate fails closed.
    await service.storage.transaction(({ sql }) => sql.run(
      "UPDATE sync_conflict SET status = 'RESOLVED', resolution_command_id = 'sync:system-wins:conflict:corrupt:1:2' WHERE status = 'OPEN'",
    ));

    // The mapped UPDATE must not treat the row as candidate-free: the
    // full-row User_Input projection stays suppressed and the human's row
    // is never overwritten.
    const effectsBefore = await service.storage.read(({ sql }) => sql.all<{
      readonly effect_id: string;
    }>(
      "SELECT effect_id FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    const em = service.hikoutei.em.fork();
    const user = await em.findOne(User, { id: "u1" });
    if (user === null) throw new Error("expected the conflicted entity");
    user.status = "overwrite";
    await em.flush();
    await expect(service.hikoutei.em.fork().findOne(User, { id: "u1" })).resolves.toMatchObject({
      status: "overwrite",
    });
    const effectsAfter = await service.storage.read(({ sql }) => sql.all<{
      readonly effect_id: string;
    }>(
      "SELECT effect_id FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    expect(effectsAfter.map((effect) => effect.effect_id)).toEqual(
      effectsBefore.map((effect) => effect.effect_id),
    );
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "human-edit",
    });

    // The mapped DELETE fails closed with the structured blocked error and
    // rolls back completely.
    const deleteManager = service.hikoutei.em.fork();
    const deleteUser = await deleteManager.findOne(User, { id: "u1" });
    if (deleteUser === null) throw new Error("expected the conflicted entity");
    deleteManager.remove(deleteUser);
    await expect(deleteManager.flush()).rejects.toMatchObject({
      code: "projection_outbox_blocked",
    });
    await expect(service.hikoutei.em.fork().findOne(User, { id: "u1" })).resolves.toMatchObject({
      status: "overwrite",
    });
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "human-edit",
    });
  });

  it("17. a pending cleanup rewrite for the row is superseded when the conflict resolves so only the fresh reconcile converges User_Input", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");

    // Reproduce the cleanup scan's mid-race rewrite: a full-row
    // candidate_reconcile carrying the stale canonical snapshot, streamed
    // under the physical anchor (NOT the binding stream key the resolution
    // replan looks up) with CAS evidence from the observed row and no
    // candidate hash (the scan's evidence read predates detection).
    const binding = await service.storage.read(({ sql }) => sql.get<{
      readonly row_binding_id: string;
    }>(
      "SELECT row_binding_id FROM row_binding WHERE logical_sheet_id = ? AND anchor_reference = ?",
      ["entity:conflict_users", anchor],
    ));
    if (binding === undefined) throw new Error("expected a row binding");
    const cleanupRewrite = createCandidateReconcileEffect({
      effectId: "effect:test-cleanup-rewrite",
      commitId: "cleanup:test",
      logicalSheetId: "entity:conflict_users",
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "ConflictUsers_Input",
      registeredRange: "A:C",
      schemaVersion: 1,
      targetKind: "projection_row",
      targetId: anchor,
      rowBindingId: presentValue(binding.row_binding_id),
      conflictId: absentValue(),
      targetAnchor: anchor,
      fields: {
        id: { kind: "string", value: "u1" },
        status: { kind: "string", value: "canonical" },
      },
      createIfMissing: false,
      expectedVisibleRevision: 2,
      expectedVisibleHash: computeSyncVisibleHash({
        id: { kind: "string", value: "u1" },
        status: { kind: "string", value: "human-edit" },
      }),
      expectedCandidateHash: notApplicableValue(),
      streamSequence: 1,
    });
    const leaseNow = Date.now();
    const lease = await claimWriterLeaseWithAdapter(service.storage, {
      role: "test-cleanup-rewrite-worker",
      writerId: "test-cleanup-rewrite-worker",
      leaseDurationMs: 60_000,
      now: leaseNow,
    });
    if (lease.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("expected a rewrite writer lease");
    }
    const fence = {
      role: lease.lease.role,
      writerEpoch: lease.lease.writerEpoch,
      fencingToken: lease.lease.fencingToken,
      now: leaseNow,
    };
    const appended = await service.storage.transaction(({ sql }) =>
      appendPendingEffectsWithSql(sql, fence, [cleanupRewrite]));
    expect(appended).toBe(true);

    // Detection records the candidate; the worker candidate gate blocks the
    // stale rewrite only while the conflict stays OPEN.
    await service.pollingSupervisor.runOnce();
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.OPEN,
    });

    // A real same-field advance resolves; the stale rewrite is superseded in
    // the same transaction, attributed to the resolution's fresh reconcile,
    // so it can never deliver after the gate opens.
    await advanceCanonicalStatus(service, "u1", "human-edit");
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.RESOLVED,
    });
    const superseded = await service.storage.read(({ sql }) => sql.get<{
      readonly status: string;
      readonly supersedes_effect_id: string | null;
    }>(
      "SELECT status, supersedes_effect_id FROM sheet_effect_outbox WHERE effect_id = ?",
      [cleanupRewrite.effectId],
    ));
    expect(superseded).toMatchObject({ status: "superseded" });
    expect(superseded?.supersedes_effect_id).toMatch(/^effect:/);
    await expect(readCommands(service)).resolves.toEqual([
      expect.objectContaining({ status: "applied" }),
    ]);

    // Only the resolution's own reconcile converges the row; the stale
    // snapshot never lands on the sheet.
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "human-edit",
    });
  });

  it("18. a restart-style cleanup scan during an OPEN conflict enqueues nothing and the later system-wins flush converges without regression", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    await service.pollingSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.OPEN,
    });

    // The live #196+#194 restart shape: the row still shows the human edit
    // while canonical has advanced, and the conflict is OPEN. The cleanup
    // scan must plan NO rewrite for the conflicted binding.
    const cleanupReport = await runUserInputCleanupScan({
      storage: service.storage,
      provider,
      physicalSheetId: USER_INPUT_SHEET_ID,
      logicalSheetId: "entity:conflict_users",
      identityField: "id",
      schemaVersion: 1,
      writerId: "restart-cleaner",
      now: () => Date.now(),
    });
    expect(cleanupReport).toMatchObject({
      rowsScanned: 1,
      duplicateRows: 0,
      emptyIdRows: 0,
      extraRows: 0,
      rewrittenRows: 0,
      effectsEnqueued: 0,
      fenceClaimed: false,
    });
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE projection = ? AND effect_kind = 'candidate_reconcile' AND commit_id LIKE 'cleanup:%'",
      [SYNC_PROJECTIONS.USER_INPUT],
    ))).resolves.toEqual({ count: 0 });

    // The later same-field C flush resolves system-wins; the worker
    // converges User_Input to C with zero wedged effects and zero
    // confirmation-regression errors.
    await advanceCanonicalStatus(service, "u1", "revised");
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.RESOLVED,
    });
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "revised",
    });
    const userEffects = await service.storage.read(({ sql }) => sql.all<{
      readonly status: string;
      readonly last_error_code: string | null;
    }>(
      "SELECT status, last_error_code FROM sheet_effect_outbox WHERE projection = ?",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    expect(userEffects.length).toBeGreaterThan(0);
    for (const effect of userEffects) {
      expect(["applied", "superseded"]).toContain(effect.status);
      expect(effect.last_error_code).not.toBe("projection_confirmation_regression");
    }
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE projection = ? AND status IN ('processing', 'delivery_uncertain', 'failed')",
      [SYNC_PROJECTIONS.USER_INPUT],
    ))).resolves.toEqual({ count: 0 });
  });

  it("19. a cleanup-scan rewrite enqueued before detection streams under the binding key and is superseded by the resolution", async () => {
    const provider = buildProvider();
    const service = await openService(provider);
    const anchor = await createEntity(service, provider, "u1", "pending");
    await service.effectSupervisor.runOnce();

    // Human edit A; the B2 canonical flush enqueues a binding-keyed reconcile
    // whose visible-hash CAS fails against the edited row.
    humanEdit(provider, anchor, "u1", "human-edit");
    await advanceCanonicalStatus(service, "u1", "canonical");
    const binding = await service.storage.read(({ sql }) => sql.get<{
      readonly row_binding_id: string;
    }>(
      "SELECT row_binding_id FROM row_binding WHERE logical_sheet_id = ? AND anchor_reference = ?",
      ["entity:conflict_users", anchor],
    ));
    if (binding === undefined) throw new Error("expected a row binding");
    const cleanupOptions = {
      storage: service.storage,
      provider,
      physicalSheetId: USER_INPUT_SHEET_ID,
      logicalSheetId: "entity:conflict_users",
      identityField: "id",
      schemaVersion: 1,
      writerId: "restart-cleaner",
      now: () => Date.now(),
    } as const;

    // While the flush reconcile is still in flight on the binding stream the
    // cleanup scan defers instead of stacking a second correction.
    const deferredScan = await runUserInputCleanupScan(cleanupOptions);
    expect(deferredScan).toMatchObject({
      rewrittenRows: 1,
      effectsEnqueued: 0,
      fenceClaimed: true,
    });

    // Settle the stale reconcile: the provider CAS fails (the row is still
    // A), so it closes as blocked_candidate.
    await service.effectSupervisor.runOnce();
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM sheet_effect_outbox WHERE projection = ? AND commit_id NOT LIKE 'cleanup:%' AND effect_kind = 'candidate_reconcile' ORDER BY stream_sequence DESC LIMIT 1",
      [SYNC_PROJECTIONS.USER_INPUT],
    ))).resolves.toMatchObject({ status: "blocked_candidate" });

    // A restart-style cleanup scan before detection now supersedes the
    // terminal blocked_candidate head and enqueues a BINDING-KEYED rewrite
    // carrying the canonical snapshot (no candidate hash: detection has not
    // run yet).
    const cleanupReport = await runUserInputCleanupScan(cleanupOptions);
    expect(cleanupReport).toMatchObject({
      rewrittenRows: 1,
      effectsEnqueued: 1,
      fenceClaimed: true,
    });
    const rewrite = await service.storage.read(({ sql }) => sql.get<{
      readonly effect_id: string;
      readonly target_id: string;
      readonly status: string;
    }>(
      "SELECT effect_id, target_id, status FROM sheet_effect_outbox WHERE projection = ? AND commit_id LIKE 'cleanup:%' ORDER BY stream_sequence DESC LIMIT 1",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    expect(rewrite).toMatchObject({
      target_id: `projection-row:${USER_INPUT_SHEET_ID}:${binding.row_binding_id}`,
      status: "pending",
    });

    // Detection opens the conflict; the worker candidate gate blocks the
    // rewrite (it carries the canonical snapshot into a candidate-owned row).
    await service.pollingSupervisor.runOnce();
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.OPEN,
    });
    await service.effectSupervisor.runOnce();
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM sheet_effect_outbox WHERE effect_id = ?",
      [rewrite!.effect_id],
    ))).resolves.toMatchObject({ status: "blocked_candidate" });

    // The same-field C flush resolves; the pending rewrite is superseded in
    // the same transaction by the resolution's own binding-keyed reconcile,
    // so the stale canonical snapshot can never deliver.
    await advanceCanonicalStatus(service, "u1", "revised");
    await expect(readConflictRow(service)).resolves.toMatchObject({
      status: CONFLICT_STATUSES.RESOLVED,
    });
    await expect(service.storage.read(({ sql }) => sql.get<{
      readonly status: string;
      readonly supersedes_effect_id: string | null;
    }>(
      "SELECT status, supersedes_effect_id FROM sheet_effect_outbox WHERE effect_id = ?",
      [rewrite!.effect_id],
    ))).resolves.toMatchObject({ status: "superseded" });

    // The worker delivers only the resolution reconcile: User_Input
    // converges to C with no regression error and no wedged effect.
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor).fields.status).toEqual({
      kind: "string",
      value: "revised",
    });
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE projection = ? AND status IN ('processing', 'delivery_uncertain', 'failed')",
      [SYNC_PROJECTIONS.USER_INPUT],
    ))).resolves.toEqual({ count: 0 });
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly count: number }>(
      "SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE projection = ? AND last_error_code = 'projection_confirmation_regression'",
      [SYNC_PROJECTIONS.USER_INPUT],
    ))).resolves.toEqual({ count: 0 });
  }, 30_000);
});

describe("issue #196 evidence promotion and migration boundaries", () => {
  const openAdapters: Array<{ readonly close: (deleteFile?: boolean) => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(
      openAdapters.splice(0).map((adapter) => adapter.close(true).catch(() => undefined)),
    );
  });

  it("promotes raw evidence columns into the validated union and rejects malformed shapes", () => {
    expect(promoteCandidateVisibleEvidence(null, null, "c1")).toEqual(
      unavailableCandidateVisibleEvidence(),
    );
    expect(promoteCandidateVisibleEvidence(3, "hash", "c1")).toEqual({
      status: CANDIDATE_VISIBLE_EVIDENCE_STATUSES.AVAILABLE,
      visibleRevision: 3,
      visibleHash: "hash",
    });
    // SQLite is dynamically typed: a non-string hash must fail promotion
    // with the structured storage-consistency error, never be adopted.
    expect(() => promoteCandidateVisibleEvidence(3, 42, "c1")).toThrowError(
      expect.objectContaining({ code: STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT }),
    );
    for (const [revision, hash] of [
      [3, null],
      [null, "hash"],
      [-1, "hash"],
      [1.5, "hash"],
      [3, ""],
      [3, 42],
    ] as const) {
      expect(() => promoteCandidateVisibleEvidence(revision, hash, "c1")).toThrowError(
        expect.objectContaining({ code: STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT }),
      );
    }
  });

  it("advances same-candidate evidence only monotonically", () => {
    const current = promoteCandidateVisibleEvidence(3, "hash-a", "c1");
    // Legacy UNAVAILABLE evidence stays UNAVAILABLE: a later observation
    // never upgrades it into an auto-resolvable CAS baseline.
    expect(
      advanceCandidateVisibleEvidence(unavailableCandidateVisibleEvidence(), 2, "hash-2", "c1"),
    ).toEqual(unavailableCandidateVisibleEvidence());
    expect(
      advanceCandidateVisibleEvidence(unavailableCandidateVisibleEvidence(), 5, "hash-5", "c1"),
    ).toEqual(unavailableCandidateVisibleEvidence());
    // Identical observations keep the stored evidence.
    expect(advanceCandidateVisibleEvidence(current, 3, "hash-a", "c1")).toBe(current);
    // Strictly newer evidence advances.
    expect(advanceCandidateVisibleEvidence(current, 4, "hash-b", "c1")).toEqual({
      status: CANDIDATE_VISIBLE_EVIDENCE_STATUSES.AVAILABLE,
      visibleRevision: 4,
      visibleHash: "hash-b",
    });
    // Regressions and same-revision hash changes are storage inconsistencies.
    expect(() => advanceCandidateVisibleEvidence(current, 2, "hash-0", "c1")).toThrowError(
      expect.objectContaining({ code: STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT }),
    );
    expect(() => advanceCandidateVisibleEvidence(current, 3, "hash-other", "c1")).toThrowError(
      expect.objectContaining({ code: STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT }),
    );
  });

describe("issue #196 audit projection state union", () => {
  const auditConflict = (
    status: ConflictStatus,
    resolutionCommandId: ReturnType<typeof presentValue<string>> | ReturnType<typeof absentValue<string>>,
  ): SyncConflict => ({
    conflictId: "conflict-proj",
    conflictGroupId: absentValue(),
    eventId: "event-1",
    rowBindingId: "binding-1",
    entityId: "entity-1",
    fieldName: "status",
    userValue: { kind: "string", value: "human" },
    userBaseRevision: 1,
    canonicalValueAtDetection: { kind: "string", value: "canonical" },
    canonicalRevisionAtDetection: 1,
    currentCanonicalValue: { kind: "string", value: "canonical" },
    currentCanonicalRevision: 1,
    candidateEpoch: 1,
    candidateVisibleEvidence: unavailableCandidateVisibleEvidence(),
    status,
    resolutionCommandId,
  });

  it("projects OPEN and NEEDS_REBASE with blank resolution cells and RESOLVED with its command identity", () => {
    const open = openSyncConflictAuditProjectionFields(
      auditConflict(CONFLICT_STATUSES.OPEN, absentValue()),
    );
    expect(open.Status).toEqual({ kind: "string", value: CONFLICT_STATUSES.OPEN });
    expect(open.Resolution).toBeNull();
    expect(open.Resolution_Command_ID).toBeNull();

    const needsRebase = openSyncConflictAuditProjectionFields(
      auditConflict(CONFLICT_STATUSES.NEEDS_REBASE, absentValue()),
    );
    expect(needsRebase.Status).toEqual({ kind: "string", value: CONFLICT_STATUSES.NEEDS_REBASE });
    expect(needsRebase.Resolution).toBeNull();
    expect(needsRebase.Resolution_Command_ID).toBeNull();

    const resolved = resolvedSyncConflictAuditProjectionFields(
      auditConflict(CONFLICT_STATUSES.RESOLVED, presentValue("sync:system-wins:conflict-proj:1:3")),
    );
    expect(resolved.Status).toEqual({ kind: "string", value: CONFLICT_STATUSES.RESOLVED });
    expect(resolved.Resolution).toEqual({
      kind: "string",
      value: SYNC_CONFLICT_RESOLUTIONS.SYSTEM_WINS,
    });
    expect(resolved.Resolution_Command_ID).toEqual({
      kind: "string",
      value: "sync:system-wins:conflict-proj:1:3",
    });
  });

  it("rejects malformed audit state combinations with the structured storage error", () => {
    // Unresolved conflicts must never carry a command identity: the shared
    // materializer would otherwise emit a nonblank Resolution_Command_ID.
    expect(() => openSyncConflictAuditProjectionFields(
      auditConflict(CONFLICT_STATUSES.OPEN, presentValue("sync:system-wins:conflict-proj:1:3")),
    )).toThrowError(expect.objectContaining({
      code: STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
    }));
    expect(() => openSyncConflictAuditProjectionFields(
      auditConflict(CONFLICT_STATUSES.NEEDS_REBASE, presentValue("sync:system-wins:conflict-proj:1:3")),
    )).toThrowError(expect.objectContaining({
      code: STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
    }));
    // RESOLVED cannot be projected as unresolved, with or without identity.
    expect(() => openSyncConflictAuditProjectionFields(
      auditConflict(CONFLICT_STATUSES.RESOLVED, absentValue()),
    )).toThrowError(expect.objectContaining({
      code: STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
    }));
    // RESOLVED as resolved requires the applied command identity.
    expect(() => resolvedSyncConflictAuditProjectionFields(
      auditConflict(CONFLICT_STATUSES.RESOLVED, absentValue()),
    )).toThrowError(expect.objectContaining({
      code: STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
    }));
    // A non-RESOLVED conflict can never be projected as resolved.
    expect(() => resolvedSyncConflictAuditProjectionFields(
      auditConflict(CONFLICT_STATUSES.OPEN, presentValue("sync:system-wins:conflict-proj:1:3")),
    )).toThrowError(expect.objectContaining({
      code: STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
    }));
  });
});

  it("rejects one-sided stored evidence when a conflict row is promoted", async () => {
    const { initializeMikroOrmSqliteAdapter } = await import(
        "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js"
    );
    const { migrateMikroOrmSqliteStorageSchema } = await import(
        "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js"
    );
    const adapter = await initializeMikroOrmSqliteAdapter({
      dbName: ":memory:",
      entities: [MigrationOrder],
    });
    openAdapters.push(adapter);
    await migrateMikroOrmSqliteStorageSchema(adapter);
    const now = Date.now();
    await adapter.transaction(async ({ sql }) => {
      await sql.run(
        "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
        ["logical-1", 1, "{}", "id"],
      );
      await sql.run(
        "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["physical-1", "logical-1", "spreadsheet", "Orders", "A:C", "user_input", 1],
      );
      await sql.run(
        "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, state, candidate_epoch) VALUES (?, ?, ?, 'active', 0)",
        ["binding-1", "logical-1", "anchor-1"],
      );
      await sql.run(
        "INSERT INTO event_batch (batch_id, logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["batch-1", "logical-1", "physical-1", "polling", "user_input", "row_independent", "snapshot"],
      );
      await sql.run(
        "INSERT INTO event_log (event_id, logical_sheet_id, physical_sheet_id, event_key, payload_hash, event_sequence, batch_id, row_binding_id, operation, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["event-1", "logical-1", "physical-1", "key-1", "payload", 1, "batch-1", "binding-1", "update", "conflict", now],
      );
      await sql.run(
        "INSERT INTO sync_conflict (conflict_id, event_id, logical_sheet_id, entity_id, row_binding_id, field_name, user_value, user_base_revision, canonical_value_at_detection, canonical_revision_at_detection, current_canonical_value, current_canonical_revision, candidate_epoch, candidate_visible_revision, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "conflict-one-sided",
          "event-1",
          "logical-1",
          "entity-1",
          "binding-1",
          "status",
          JSON.stringify({ kind: "string", value: "human" }),
          1,
          JSON.stringify({ kind: "string", value: "canonical" }),
          1,
          JSON.stringify({ kind: "string", value: "canonical" }),
          1,
          1,
          3,
          "OPEN",
          now,
          now,
        ],
      );
    });
    await expect(adapter.read(({ sql }) => readConflictWithSql(sql, "logical-1", "conflict-one-sided"))).rejects.toMatchObject({
      code: STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
    });
  });

  it("migrates a v5 store to v6 additively, preserves legacy rows, and stays idempotent", async () => {
    const { initializeMikroOrmSqliteAdapter } = await import(
        "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js"
    );
    const { migrateMikroOrmSqliteStorageSchema } = await import(
        "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js"
    );
    const adapter = await initializeMikroOrmSqliteAdapter({
      dbName: ":memory:",
      entities: [MigrationOrder],
    });
    openAdapters.push(adapter);

    // Build the v6 store, then strip the v6 columns and downgrade the marker
    // to simulate a genuine v5 installation with legacy rows.
    await migrateMikroOrmSqliteStorageSchema(adapter);
    await adapter.transaction(async ({ sql }) => {
      await sql.run("ALTER TABLE sync_conflict DROP COLUMN candidate_visible_revision");
      await sql.run("ALTER TABLE sync_conflict DROP COLUMN candidate_visible_hash");
      await sql.run("PRAGMA user_version = 5");
      const now = Date.now();
      await sql.run(
        "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
        ["logical-legacy", 1, "{}", "id"],
      );
      await sql.run(
        "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["physical-legacy", "logical-legacy", "spreadsheet", "Orders", "A:C", "user_input", 1],
      );
      await sql.run(
        "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, state, candidate_epoch) VALUES (?, ?, ?, 'active', 0)",
        ["binding-legacy", "logical-legacy", "anchor-legacy"],
      );
      await sql.run(
        "INSERT INTO event_batch (batch_id, logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["batch-legacy", "logical-legacy", "physical-legacy", "polling", "user_input", "row_independent", "snapshot"],
      );
      await sql.run(
        "INSERT INTO event_log (event_id, logical_sheet_id, physical_sheet_id, event_key, payload_hash, event_sequence, batch_id, row_binding_id, operation, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["event-legacy", "logical-legacy", "physical-legacy", "key-legacy", "payload", 1, "batch-legacy", "binding-legacy", "update", "conflict", now],
      );
      await sql.run(
        "INSERT INTO sync_conflict (conflict_id, event_id, logical_sheet_id, entity_id, row_binding_id, field_name, user_value, user_base_revision, canonical_value_at_detection, canonical_revision_at_detection, current_canonical_value, current_canonical_revision, candidate_epoch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "conflict-legacy",
          "event-legacy",
          "logical-legacy",
          "entity-legacy",
          "binding-legacy",
          "status",
          JSON.stringify({ kind: "string", value: "human" }),
          1,
          JSON.stringify({ kind: "string", value: "canonical" }),
          1,
          JSON.stringify({ kind: "string", value: "canonical" }),
          1,
          1,
          "OPEN",
          now,
          now,
        ],
      );
      await sql.run(
        "INSERT INTO resolution_command (command_id, request_key, action, actor_id, role, target_conflict_id, expected_revision, active_candidate_hash, expected_candidate_epoch, payload_hash, status, issued_at) VALUES (?, ?, 'acknowledge_system', 'sync:auto-system-wins', 'sync_operator', ?, 1, 'hash', 1, 'payload', 'pending', ?)",
        ["auto-system-wins:conflict-legacy:1", "auto-system-wins:conflict-legacy:1", "conflict-legacy", now],
      );
    });

    // The v5->v6 migration is additive: legacy conflict/command rows survive
    // and the new evidence columns start NULL (never guessed).
    await expect(migrateMikroOrmSqliteStorageSchema(adapter)).resolves.toEqual({
      fromVersion: 5,
      toVersion: 7,
      appliedVersions: [6, 7],
    });
    await expect(adapter.read(({ sql }) => sql.all<{ readonly name: string }>(
      "PRAGMA table_info(sync_conflict)",
    ))).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "candidate_visible_revision" }),
      expect.objectContaining({ name: "candidate_visible_hash" }),
    ]));
    await expect(adapter.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM sync_conflict WHERE conflict_id = ?",
      ["conflict-legacy"],
    ))).resolves.toEqual({ status: "OPEN" });
    await expect(adapter.read(({ sql }) => sql.get<{
      readonly status: string;
      readonly candidate_visible_revision: number | null;
      readonly candidate_visible_hash: string | null;
    }>(
      "SELECT status, candidate_visible_revision, candidate_visible_hash FROM sync_conflict WHERE conflict_id = ?",
      ["conflict-legacy"],
    ))).resolves.toEqual({
      status: "OPEN",
      candidate_visible_revision: null,
      candidate_visible_hash: null,
    });
    await expect(adapter.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM resolution_command WHERE command_id = ?",
      ["auto-system-wins:conflict-legacy:1"],
    ))).resolves.toEqual({ status: "pending" });

    // Idempotent: a second migration applies nothing.
    await expect(migrateMikroOrmSqliteStorageSchema(adapter)).resolves.toEqual({
      fromVersion: 7,
      toVersion: 7,
      appliedVersions: [],
    });

    // The legacy conflict promotes to UNAVAILABLE evidence and is never
    // guessed as resolution CAS input.
    const conflict = await adapter.read(({ sql }) =>
      readConflictWithSql(sql, "logical-legacy", "conflict-legacy"));
    if (conflict.kind !== "found") throw new Error("expected the legacy conflict");
    expect(conflict.value.candidateVisibleEvidence.status).toBe(
      CANDIDATE_VISIBLE_EVIDENCE_STATUSES.UNAVAILABLE,
    );
  });

  it("drops real legacy quarantine repair data in the v5→v7 multi-hop path and keeps the surviving columns intact", async () => {
    const { initializeMikroOrmSqliteAdapter } = await import(
        "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js"
    );
    const { migrateMikroOrmSqliteStorageSchema } = await import(
        "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js"
    );
    const adapter = await initializeMikroOrmSqliteAdapter({
      dbName: ":memory:",
      entities: [MigrationOrder],
    });
    openAdapters.push(adapter);

    // Build the current store, then re-introduce the historical v5 quarantine
    // shape: the three legacy repair columns WITH real persisted values (the
    // v5 writer did write them) so the multi-hop path drops data-bearing
    // columns, not empty ones.
    await migrateMikroOrmSqliteStorageSchema(adapter);
    await adapter.transaction(async ({ sql }) => {
      await sql.run("ALTER TABLE quarantine_record ADD COLUMN repair_fields_json TEXT NOT NULL DEFAULT '[]'");
      await sql.run("ALTER TABLE quarantine_record ADD COLUMN repair_state TEXT");
      await sql.run("ALTER TABLE quarantine_record ADD COLUMN candidate_payload_json TEXT");
      await sql.run("PRAGMA user_version = 5");
      const now = Date.now();
      await sql.run(
        "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
        ["logical-legacy", 1, "{}", "id"],
      );
      await sql.run(
        "INSERT INTO quarantine_record (quarantine_id, event_id, observation_id, logical_sheet_id, row_binding_id, reason, before_row_json, after_row_json, fields_json, repair_fields_json, repair_state, candidate_payload_json, created_at, updated_at) VALUES (?, NULL, NULL, ?, ?, 'duplicate', NULL, NULL, '{}', '[\"field-a\"]', 'pending', 'payload-evidence', ?, ?)",
        ["quar-legacy-v5", "logical-legacy", "binding-legacy-v5", now, now],
      );
    });

    // The v5→v6→v7 multi-hop migration still reports both applied versions.
    await expect(migrateMikroOrmSqliteStorageSchema(adapter)).resolves.toEqual({
      fromVersion: 5,
      toVersion: 7,
      appliedVersions: [6, 7],
    });

    // The repair columns (and their data) are gone for good.
    await expect(adapter.read(({ sql }) => sql.all<{ readonly name: string }>(
      "PRAGMA table_info(quarantine_record)",
    ))).resolves.not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "repair_fields_json" }),
      expect.objectContaining({ name: "repair_state" }),
      expect.objectContaining({ name: "candidate_payload_json" }),
    ]));

    // Surviving columns of the legacy quarantine row are untouched.
    await expect(adapter.read(({ sql }) => sql.get<{
      readonly logical_sheet_id: string;
      readonly row_binding_id: string;
      readonly reason: string;
      readonly fields_json: string;
    }>(
      "SELECT logical_sheet_id, row_binding_id, reason, fields_json FROM quarantine_record WHERE quarantine_id = ?",
      ["quar-legacy-v5"],
    ))).resolves.toEqual({
      logical_sheet_id: "logical-legacy",
      row_binding_id: "binding-legacy-v5",
      reason: "duplicate",
      fields_json: "{}",
    });
  });
});
