/**
 * Lifecycle and public error-contract gap coverage for the Hikoutei surface.
 *
 * This file pins the application-facing lifecycle and stable-error guarantees
 * that were not already covered by the broad lifecycle, provider-neutral,
 * scalar-contract, descriptor, and factory-option suites. Every assertion
 * branches on the machine-readable `code`, never on a human message.
 *
 * Scope is scalar EntityManager + SQLite authority + async Sheets projection:
 * no relations, joins, populate, migration, cascade, raw SQL, provider leakage,
 * or sync internals are exercised here.
 *
 * Gaps filled (each a distinct, previously-unpinned public contract):
 *   - create() missing required scalar and wrong scalar type rejected at flush
 *   - persist()/remove() iterable (array and generic iterable) inputs, exercised
 *     on already-materialized managed entities after a prior flush
 *   - remove() of an unmanaged or cross-fork entity rejected with a stable code
 *   - unregistered entity token rejected on the read surface (find)
 *   - primary-key mutation on a pending insert rejected at flush
 *   - repeated flush() with no pending changes is idempotent
 *   - fork() isolates identity maps and dirty snapshots across managers
 *   - close() is idempotent on the public runtime
 *   - transactional() propagates the callback result and durably commits writes
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  createTypedSheets,
  defineTypedSheetsEntity,
  HIKOUTEI_ERROR_CODES,
  type EntityManager,
  type Hikoutei,
  type HikouteiEntity,
} from "../src/index.js";

/** Entity shared by most lifecycle assertions in this file. */
const Note = defineTypedSheetsEntity({
  name: "LifecycleContractNote",
  tableName: "lifecycle_contract_notes",
  properties: {
    id: { type: "string", primary: true },
    title: { type: "string" },
    body: { type: "string", nullable: true },
    views: { type: "number" },
    published: { type: "boolean" },
    createdAt: { type: "date" },
  },
});

/**
 * A valid entity token that is deliberately never passed to a runtime.
 *
 * It exercises the read-path branch of the unregistered-entity guard; the
 * create-path branch is already covered by the factory-options suite.
 */
const UnregisteredNote = defineTypedSheetsEntity({
  name: "LifecycleUnregisteredNote",
  tableName: "lifecycle_unregistered_notes",
  properties: {
    id: { type: "string", primary: true },
    title: { type: "string" },
  },
});

/** Fixed timestamp used by seeded rows so date handling is unambiguous. */
const SEEDED_AT = new Date("2026-01-15T00:00:00.000Z");

/**
 * Typed initial-data shape matching the scalar Note entity contract.
 *
 * Keeping this in sync with the descriptor above lets every seed call stay
 * fully typed against the public `create()` contract instead of relying on a
 * broad `Record<string, unknown>` bag.
 */
type NoteData = {
  id: string;
  title: string;
  body: string | null;
  views: number;
  published: boolean;
  createdAt: Date;
};

/** Full, type-correct initial data for one Note so create() can be reused. */
function noteData(id: string, title = `Title ${id}`): NoteData {
  return {
    id,
    title,
    body: null,
    views: id.length,
    published: true,
    createdAt: SEEDED_AT,
  };
}

async function openRuntime(entities: readonly HikouteiEntity[] = [Note]): Promise<Hikoutei> {
  return createTypedSheets({ dbName: ":memory:", entities });
}

/** Runs a block against a fresh runtime and closes it afterwards. */
async function withRuntime(
  entities: readonly HikouteiEntity[] | undefined,
  block: (runtime: Hikoutei) => Promise<void>,
): Promise<void> {
  const runtime = await openRuntime(entities);
  try {
    await block(runtime);
  } finally {
    await runtime.close();
  }
}

describe("create() required and scalar value validation", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("rejects a missing required scalar at flush with INVALID_SCALAR_VALUE", async () => {
    await withRuntime(undefined, async (runtime) => {
      const em = runtime.em.fork();
      // `title` is a non-nullable string and is omitted; create() leaves it
      // unset and flush() must reject the entity before any write.
      em.create(Note, {
        id: "missing-required",
        // title intentionally omitted
        body: null,
        views: 1,
        published: true,
        createdAt: SEEDED_AT,
      });
      await expect(em.flush()).rejects.toMatchObject({
        code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      });
    });
  });

  it("rejects a wrong scalar type at flush with INVALID_SCALAR_VALUE", async () => {
    await withRuntime(undefined, async (runtime) => {
      const em = runtime.em.fork();
      const note = em.create(Note, noteData("wrong-type"));
      // Assign a value whose runtime type does not match the declared column.
      // The validation boundary is flush(), so create() itself must not throw.
      // The narrow cast is deliberate: it is the invalid-value under test.
      (note as { published: unknown }).published = "not-a-boolean";
      await expect(em.flush()).rejects.toMatchObject({
        code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      });
    });
  });
});

describe("persist() and remove() iterable inputs", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("persists every managed entity scheduled for removal in an array input", async () => {
    await withRuntime(undefined, async (runtime) => {
      // A loaded entity is dirty-tracked against its snapshot, so mutating it
      // would flush as an update even if persist() were a no-op. To make the
      // iterable branch load-bearing, schedule both entities for removal first
      // and reinstate them with persist(): if persist() does not traverse the
      // iterable, the entities stay removed and flush deletes them.
      const seed = runtime.em.fork();
      seed.create(Note, noteData("arr-a"));
      seed.create(Note, noteData("arr-b"));
      await seed.flush();

      // A fresh fork loads managed instances whose initial insert already flushed.
      const em = runtime.em.fork();
      const first = await em.findOne(Note, { id: "arr-a" });
      const second = await em.findOne(Note, { id: "arr-b" });
      if (first === null || second === null) throw new Error("expected seeded notes");

      // Put both loaded entities into the removed state via single-entity
      // remove() calls so only the persist() call below exercises traversal.
      em.remove(first);
      em.remove(second);

      // The array branch of persist() must traverse the iterable and reinstate
      // each entity (removed -> clean). A no-op traversal would leave both rows
      // removed, so flush would delete them and the assertions below would fail.
      em.persist([first, second]);
      first.title = "updated arr-a";
      second.title = "updated arr-b";
      await em.flush();

      // A fresh fork with an empty identity map reads SQLite, proving both rows
      // survived with the updated values rather than being deleted.
      const reader = runtime.em.fork();
      const titles = (await reader.find(Note, {}, { orderBy: { id: "asc" } }))
        .map((row) => row.title);
      expect(titles).toEqual(["updated arr-a", "updated arr-b"]);
    });
  });

  it("persists every managed entity scheduled for removal in a generic iterable (Set) input", async () => {
    await withRuntime(undefined, async (runtime) => {
      // Same load-bearing rationale as the array case above: a loaded entity
      // mutates to an update on its own, so we gate survival on persist()
      // reinstating two entities scheduled for removal.
      const seed = runtime.em.fork();
      seed.create(Note, noteData("set-a"));
      seed.create(Note, noteData("set-b"));
      await seed.flush();

      const em = runtime.em.fork();
      const first = await em.findOne(Note, { id: "set-a" });
      const second = await em.findOne(Note, { id: "set-b" });
      if (first === null || second === null) throw new Error("expected seeded notes");

      // Put both loaded entities into the removed state via single-entity
      // remove() calls so only the persist() call below exercises traversal.
      em.remove(first);
      em.remove(second);

      // A Set is a non-array iterable: the generic iterable branch must walk
      // Symbol.iterator rather than assume an array shape, reinstating each
      // removed entity. A no-op traversal would leave both rows removed, so
      // flush would delete them and the assertions below would fail.
      em.persist(new Set([first, second]));
      first.title = "updated set-a";
      second.title = "updated set-b";
      await em.flush();

      // A fresh fork with an empty identity map reads SQLite, proving both rows
      // survived with the updated values rather than being deleted.
      const reader = runtime.em.fork();
      const titles = (await reader.find(Note, {}, { orderBy: { id: "asc" } }))
        .map((row) => row.title);
      expect(titles).toEqual(["updated set-a", "updated set-b"]);
    });
  });

  it("removes every managed entity in an array input", async () => {
    await withRuntime(undefined, async (runtime) => {
      const seed = runtime.em.fork();
      seed.create(Note, noteData("rm-a"));
      seed.create(Note, noteData("rm-b"));
      await seed.flush();

      const em = runtime.em.fork();
      const first = await em.findOne(Note, { id: "rm-a" });
      const second = await em.findOne(Note, { id: "rm-b" });
      if (first === null || second === null) throw new Error("expected seeded notes");

      // The array branch of remove() must traverse the iterable and tombstone
      // both managed entities in one flush.
      em.remove([first, second]);
      await em.flush();

      const reader = runtime.em.fork();
      expect(await reader.findOne(Note, { id: "rm-a" })).toBeNull();
      expect(await reader.findOne(Note, { id: "rm-b" })).toBeNull();
    });
  });

  it("removes every managed entity in a generic iterable (Set) input", async () => {
    await withRuntime(undefined, async (runtime) => {
      const seed = runtime.em.fork();
      seed.create(Note, noteData("set-rm-a"));
      seed.create(Note, noteData("set-rm-b"));
      await seed.flush();

      const em = runtime.em.fork();
      const first = await em.findOne(Note, { id: "set-rm-a" });
      const second = await em.findOne(Note, { id: "set-rm-b" });
      if (first === null || second === null) throw new Error("expected seeded notes");

      // A Set exercises the generic iterable branch of remove() alongside the
      // array branch above.
      em.remove(new Set([first, second]));
      await em.flush();

      const reader = runtime.em.fork();
      expect(await reader.findOne(Note, { id: "set-rm-a" })).toBeNull();
      expect(await reader.findOne(Note, { id: "set-rm-b" })).toBeNull();
    });
  });
});

describe("remove() unmanaged entity contract", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("rejects a plain object that was never managed with UNMANAGED_ENTITY", async () => {
    await withRuntime(undefined, async (runtime) => {
      const em = runtime.em.fork();
      // A plain data object is structurally a Note but was never created or
      // loaded by this manager, so remove() must reject it up front.
      expect(() => em.remove({ ...noteData("detached") })).toThrow(
        expect.objectContaining({ code: HIKOUTEI_ERROR_CODES.UNMANAGED_ENTITY }),
      );
    });
  });

  it("rejects an entity materialized by a different fork with UNMANAGED_ENTITY", async () => {
    await withRuntime(undefined, async (runtime) => {
      const owner = runtime.em.fork();
      owner.create(Note, noteData("owned"));
      await owner.flush();
      const loaded = await owner.findOne(Note, { id: "owned" });
      if (loaded === null) throw new Error("expected the seeded note");

      // A second fork's Unit of Work never tracked this instance.
      const other = runtime.em.fork();
      expect(() => other.remove(loaded)).toThrow(
        expect.objectContaining({ code: HIKOUTEI_ERROR_CODES.UNMANAGED_ENTITY }),
      );
    });
  });
});

describe("unregistered entity token on the read surface", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("rejects find() on a token not passed to createTypedSheets() with UNREGISTERED_ENTITY", async () => {
    // Open the runtime with only `Note`; `UnregisteredNote` is a valid token
    // but was never registered with this runtime.
    const runtime = await openRuntime();
    runtimes.push(runtime);
    const em = runtime.em.fork();
    await expect(em.find(UnregisteredNote)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.UNREGISTERED_ENTITY,
    });
    await expect(em.count(UnregisteredNote)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.UNREGISTERED_ENTITY,
    });
  });
});

describe("primary-key mutation on a pending insert", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("rejects a changed primary key before the first flush with ENTITY_PRIMARY_KEY_MUTATION", async () => {
    await withRuntime(undefined, async (runtime) => {
      const em = runtime.em.fork();
      const note = em.create(Note, noteData("original"));
      // Mutate the immutable public identity between create() and flush().
      note.id = "moved";
      await expect(em.flush()).rejects.toMatchObject({
        code: HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_MUTATION,
      });
    });
  });
});

describe("flush() idempotency with no pending changes", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("resolves repeated flush() calls without changes and leaves data intact", async () => {
    await withRuntime(undefined, async (runtime) => {
      const em = runtime.em.fork();
      em.create(Note, noteData("stable"));
      await em.flush();

      // Two additional flushes over a clean identity map must be no-ops.
      await expect(em.flush()).resolves.toBeUndefined();
      await expect(em.flush()).resolves.toBeUndefined();

      expect(await em.findOne(Note, { id: "stable" })).toMatchObject({
        id: "stable",
        title: "Title stable",
      });
    });
  });
});

describe("fork() identity isolation", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("keeps identity maps and dirty snapshots independent across forks", async () => {
    await withRuntime(undefined, async (runtime) => {
      const seed = runtime.em.fork();
      seed.create(Note, noteData("iso"));
      await seed.flush();

      const a = runtime.em.fork();
      const b = runtime.em.fork();
      const loadedA = await a.findOne(Note, { id: "iso" });
      const loadedB = await b.findOne(Note, { id: "iso" });
      if (loadedA === null || loadedB === null) throw new Error("expected seeded note");

      // Distinct forks materialize distinct managed instances for the same row.
      expect(loadedA).not.toBe(loadedB);

      // Flushing a mutation in fork A advances SQLite but must not disturb fork
      // B's already-loaded instance or its dirty snapshot.
      loadedA.title = "from-a";
      await a.flush();
      expect(loadedB.title).toBe("Title iso");

      // Fork B's identity map stays authoritative: a later read in B returns the
      // same managed instance it already loaded, still unaffected by A's commit.
      const rereadB = await b.findOne(Note, { id: "iso" });
      expect(rereadB).toBe(loadedB);
      expect(rereadB?.title).toBe("Title iso");

      // A fresh fork with an empty identity map observes the committed SQLite
      // value, proving the stores are shared while per-fork identity maps stay
      // isolated.
      const fresh = await runtime.em.fork().findOne(Note, { id: "iso" });
      expect(fresh?.title).toBe("from-a");
    });
  });
});

describe("close() public contract", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close().catch(() => undefined)));
  });

  it("is idempotent: a second close() resolves without throwing", async () => {
    const runtime = await openRuntime();
    runtimes.push(runtime);
    await expect(runtime.close()).resolves.toBeUndefined();
    // The runtime guards repeated shutdown; calling close() again must not throw.
    await expect(runtime.close()).resolves.toBeUndefined();
  });
});

describe("transactional() success result propagation", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it("returns the callback result and commits its writes on success", async () => {
    await withRuntime(undefined, async (runtime) => {
      const em = runtime.em.fork();
      const result = await em.transactional(async (transactionalEm: EntityManager) => {
        transactionalEm.persist(transactionalEm.create(Note, noteData("tx-result")));
        return { committed: true };
      });
      expect(result).toEqual({ committed: true });
      // Verify durable commit through a fresh fork whose empty identity map
      // forces a SQLite read, rather than reusing the callback manager's
      // identity map where the entity would already be cached.
      expect(await runtime.em.fork().findOne(Note, { id: "tx-result" })).toMatchObject({
        id: "tx-result",
      });
    });
  });
});
