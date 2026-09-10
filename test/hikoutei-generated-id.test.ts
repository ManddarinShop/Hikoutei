/**
 * Generated primary-key tests for entities with assigned identifiers.
 *
 * Covers numeric and string id assignment, flush persistence of generated
 * keys, and downstream sync projection of generated rows. Uses SQLite
 * fixtures with a fake sync provider and no live Sheets.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  createTypedSheets,
  defineTypedSheetsEntity,
  HIKOUTEI_ERROR_CODES,
  type Hikoutei,
} from "../src/index.js";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "@hikoutei/sync-engine/sync/service/SyncServiceBootstrap.js";
import { SYNC_PROJECTIONS } from "@hikoutei/contracts/sheets/constants.js";
import type { SyncSheetsProvisioner } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import { FakeSyncSheetsProvider } from "./support/FakeSyncSheetsProvider.js";

const NumericItem = defineTypedSheetsEntity({
  name: "GeneratedNumericItem",
  tableName: "generated_numeric_items",
  properties: {
    id: { type: "number", primary: true },
    name: { type: "string" },
  },
});

const StringItem = defineTypedSheetsEntity({
  name: "GeneratedStringItem",
  tableName: "generated_string_items",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
  },
});

class RecordingProvisioner implements SyncSheetsProvisioner {
  async provisionRegistry(registrations: Parameters<SyncSheetsProvisioner["provisionRegistry"]>[0]) {
    return {
      registrations: registrations.map(({ headers: _headers, ...registration }) => registration),
      createdSheets: registrations.map((registration) => registration.sheetName),
      initializedHeaders: registrations.map((registration) => registration.sheetName),
    };
  }
}

// Covers sqlite-generated numeric id.
describe("sqlite-generated numeric id", () => {
  const runtimes: Hikoutei[] = [];
  const services: InternalSyncService[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
    await Promise.all(services.splice(0).map((service) => service.close().catch(() => undefined)));
  });

  // Verifies assigns a numeric id to an id-less insert and backfills the entity.
  it("assigns a numeric id to an id-less insert and backfills the entity", async () => {
    const hikoutei = await createTypedSheets({ dbName: ":memory:", entities: [NumericItem] });
    runtimes.push(hikoutei);
    const em = hikoutei.em.fork();

    const first = em.create(NumericItem, { name: "first" });
    expect(first.id).toBeUndefined();
    em.persist(first);
    await em.flush();

    expect(typeof first.id).toBe("number");
    expect(Number.isSafeInteger(first.id)).toBe(true);
  });

  // Verifies reads, updates, and removes through the assigned numeric id.
  it("reads, updates, and removes through the assigned numeric id", async () => {
    const hikoutei = await createTypedSheets({ dbName: ":memory:", entities: [NumericItem] });
    runtimes.push(hikoutei);
    const em = hikoutei.em.fork();

    const item = em.create(NumericItem, { name: "before" });
    em.persist(item);
    await em.flush();
    const assigned = item.id;

    await expect(hikoutei.em.fork().findOne(NumericItem, { id: assigned })).resolves.toMatchObject({
      id: assigned,
      name: "before",
    });

    const loaded = await em.findOne(NumericItem, { id: assigned });
    if (loaded === null) throw new Error("expected the generated row");
    loaded.name = "after";
    await em.flush();
    await expect(hikoutei.em.fork().findOne(NumericItem, { id: assigned })).resolves.toMatchObject({
      name: "after",
    });

    em.remove(loaded);
    await em.flush();
    await expect(hikoutei.em.fork().findOne(NumericItem, { id: assigned })).resolves.toBeNull();
  });

  // Verifies keeps explicit numeric ids and string primary keys on their existing contract.
  it("keeps explicit numeric ids and string primary keys on their existing contract", async () => {
    const hikoutei = await createTypedSheets({
      dbName: ":memory:",
      entities: [NumericItem, StringItem],
    });
    runtimes.push(hikoutei);
    const em = hikoutei.em.fork();

    const explicit = em.create(NumericItem, { id: 99, name: "explicit" });
    em.persist(explicit);
    await em.flush();
    expect(explicit.id).toBe(99);
    await expect(hikoutei.em.fork().findOne(NumericItem, { id: 99 })).resolves.toMatchObject({
      name: "explicit",
    });

    // A numeric value for a TEXT primary key normalizes to its string form.
    const coerced = em.create(StringItem, { id: 42 as unknown as string, name: "coerced" });
    em.persist(coerced);
    await em.flush();
    expect(coerced.id).toBe("42");
    await expect(hikoutei.em.fork().findOne(StringItem, { id: "42" })).resolves.toMatchObject({
      name: "coerced",
    });

    // String primary keys still reject a missing id at flush.
    const missing = hikoutei.em.fork();
    missing.persist(missing.create(StringItem, { name: "no-id" }));
    await expect(missing.flush()).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE,
    });
  });

  // Verifies carries the same numeric id and entity:<id> anchor through canonical and outbox state.
  it("carries the same numeric id and entity:<id> anchor through canonical and outbox state", async () => {
    const systemSheetId = "entity:generated_numeric_items:system_state";
    const userInputSheetId = "entity:generated_numeric_items:user_input";
    const conflictSheetId = "entity:generated_numeric_items:sync_conflicts";
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: systemSheetId,
        sheetName: "GenItems_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "name", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: userInputSheetId,
        sheetName: "GenItems_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "name"],
      },
      {
        physicalSheetId: conflictSheetId,
        sheetName: "GenItems_Conflicts",
        registeredRange: "A:O",
        projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
        schemaVersion: 1,
        headers: ["Conflict_ID", "Conflict_Group_ID", "Event_ID", "Entity_ID", "Field_Name", "User_Value", "User_Base_Revision", "Canonical_Value_At_Detection", "Canonical_Revision_At_Detection", "Current_Canonical_Value", "Current_Canonical_Revision", "Candidate_Epoch", "Status", "Resolution", "Resolution_Command_ID"],
      },
    ]);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [NumericItem],
      projections: {
        spreadsheetId: "generated-id-spreadsheet",
        entities: {
          GeneratedNumericItem: {
            systemState: { tabName: "GenItems_System", registeredRange: "A:C" },
            syncConflicts: { tabName: "GenItems_Conflicts", registeredRange: "A:O" },
            userInput: { tabName: "GenItems_Input", registeredRange: "A:C" },
            userOwnedFields: ["id", "name"],
          },
        },
      },
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    const item = em.create(NumericItem, { name: "synced" });
    em.persist(item);
    await em.flush();
    expect(Number.isSafeInteger(item.id)).toBe(true);

    const anchor = `entity:${item.id}`;
    const canonical = `entity:generated_numeric_items:${item.id}`;

    const binding = await service.storage.read(({ sql }) => sql.get<{
      readonly row_binding_id: string;
      readonly anchor_reference: string;
      readonly entity_id: string;
    }>("SELECT row_binding_id, anchor_reference, entity_id FROM row_binding"));
    expect(binding).toMatchObject({ anchor_reference: anchor, entity_id: canonical });

    const canonicalRow = await service.storage.read(({ sql }) => sql.get<{
      readonly entity_id: string;
    }>("SELECT entity_id FROM entity_state WHERE entity_id = ?", [canonical]));
    expect(canonicalRow?.entity_id).toBe(canonical);

    const outbox = await service.storage.read(({ sql }) => sql.all<{
      readonly target_id: string;
      readonly row_binding_id: string | null;
      readonly payload_json: string;
    }>(
      "SELECT target_id, row_binding_id, payload_json FROM sheet_effect_outbox ORDER BY stream_sequence",
    ));
    expect(outbox.length).toBeGreaterThan(0);
    // System_State targets the canonical identity; every effect shares the binding.
    expect(outbox.some((effect) => effect.target_id === canonical)).toBe(true);
    expect(outbox.every((effect) => effect.row_binding_id === binding?.row_binding_id)).toBe(true);
    expect(outbox.every((effect) => effect.payload_json.includes(anchor))).toBe(true);

    // The assigned id stays usable for a follow-up update in the sync runtime.
    const loaded = await em.findOne(NumericItem, { id: item.id });
    if (loaded === null) throw new Error("expected the synced row");
    loaded.name = "synced-v2";
    await em.flush();
    await expect(service.hikoutei.em.fork().findOne(NumericItem, { id: item.id }))
      .resolves.toMatchObject({ name: "synced-v2" });
  });
});
