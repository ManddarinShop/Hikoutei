/**
 * Narrow scalar public-contract coverage for the Hikoutei EntityManager.
 *
 * These tests focus on the application-visible read and identity contract that
 * a SQLite-authoritative scalar repository must keep, complementing the broad
 * rich-query lifecycle tests in `hikoutei-api.test.ts`:
 *
 *   - equality reads with no filter, an empty match, and number/boolean/date
 *     equality (the gaps left by the existing boolean/string equality tests)
 *   - `findOne()` present/absent behavior and `find()`'s readonly return type
 *   - `limit` / `offset` paging compatibility on equality filters
 *   - `create()` / `persist()` input and identity-map boundaries
 *   - a regression guard for `offset` without `limit`
 *
 * They intentionally exercise the public API only and never assert SQL,
 * MikroORM, or storage-internal shapes.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  createTypedSheets,
  defineTypedSheetsEntity,
  HIKOUTEI_ERROR_CODES,
  type EntityManager,
  type Hikoutei,
} from "../src/index.js";

const Article = defineTypedSheetsEntity({
  name: "ScalarContractArticle",
  tableName: "scalar_contract_articles",
  properties: {
    id: { type: "string", primary: true },
    title: { type: "string" },
    views: { type: "number" },
    published: { type: "boolean" },
    summary: { type: "string", nullable: true },
    createdAt: { type: "date" },
  },
});

type ArticleInstance = {
  id: string;
  title: string;
  views: number;
  published: boolean;
  summary: string | null;
  createdAt: Date;
};

/**
 * Compile-time readonly-array discriminator.
 *
 * A mutable `T[]` satisfies both `readonly unknown[]` and `unknown[]`, while a
 * truly readonly `readonly T[]` satisfies only the former. Used to assert, at
 * the type level, that a public `find()` result keeps its readonly marker.
 */
type IsReadonlyArray<T> = T extends readonly unknown[]
  ? T extends unknown[]
    ? false
    : true
  : false;

/**
 * Typecheck-only proof that a `find()` result cannot be mutated.
 *
 * The body violates the readonly array contract under `@ts-expect-error`, which
 * keeps the directive active and pins the application-facing read contract:
 * `find()` is declared to return `Promise<readonly Entity[]>`, so the array
 * mutation helpers are intentionally absent from that type. The helper is never
 * invoked, so Vitest never mutates a real result array at runtime.
 */
function assertFindResultCannotBeMutated(rows: readonly ArticleInstance[]): void {
  // @ts-expect-error the public read contract returns readonly Entity[];
  // array mutation helpers are intentionally absent from the type.
  rows.push({} as ArticleInstance);
}
// Reference the uncalled helper so it stays part of the type-checked surface.
void assertFindResultCannotBeMutated;

/** Fixed timestamp used by every seeded row so date equality is unambiguous. */
const SEEDED_AT = new Date("2026-01-15T00:00:00.000Z");

function seed(em: EntityManager, ids: readonly string[]): void {
  for (const id of ids) {
    em.persist(
      em.create(Article, {
        id,
        title: `Title ${id}`,
        views: id.length,
        published: true,
        summary: null,
        createdAt: SEEDED_AT,
      }),
    );
  }
}

describe("scalar equality read contract", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  async function openRuntime(): Promise<Hikoutei> {
    const runtime = await createTypedSheets({ dbName: ":memory:", entities: [Article] });
    runtimes.push(runtime);
    return runtime;
  }

  it("find() with no filter returns every persisted row", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    seed(em, ["a", "b", "c"]);
    await em.flush();

    const all = await em.find(Article);
    expect(all.map((row) => row.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("find() with an equality filter that matches nothing returns an empty array", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    seed(em, ["a", "b"]);
    await em.flush();

    const none = await em.find(Article, { title: "no-such-title" });
    // The absent-match contract is an empty readonly array, never null.
    expect(Array.isArray(none)).toBe(true);
    expect(none).toEqual([]);
  });

  it("matches equality filters on number, boolean, and date scalars", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    const firstDay = new Date("2026-01-01T00:00:00.000Z");
    const secondDay = new Date("2026-01-02T00:00:00.000Z");
    em.persist(em.create(Article, {
      id: "n1", title: "A", views: 10, published: true, summary: null, createdAt: firstDay,
    }));
    em.persist(em.create(Article, {
      id: "n2", title: "B", views: 20, published: false, summary: "x", createdAt: secondDay,
    }));
    await em.flush();

    expect((await em.find(Article, { views: 10 })).map((row) => row.id)).toEqual(["n1"]);
    expect((await em.find(Article, { published: false })).map((row) => row.id)).toEqual(["n2"]);
    // Equality on a date compares the stored instant, not the object reference.
    expect((await em.find(Article, { createdAt: new Date(firstDay.getTime()) }))
      .map((row) => row.id)).toEqual(["n1"]);
  });

  it("findOne() returns the single match when present and null when absent", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    seed(em, ["a", "b"]);
    await em.flush();

    await expect(em.findOne(Article, { id: "a" })).resolves.toMatchObject({ id: "a", title: "Title a" });
    await expect(em.findOne(Article, { id: "missing" })).resolves.toBeNull();
  });

  it("exposes a readonly entity array from find()", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    seed(em, ["a"]);
    await em.flush();

    const rows = await em.find(Article);
    expect(rows).toHaveLength(1);

    // Application-facing read contract: the concrete result keeps the readonly
    // marker declared by find(). If the public return type ever widened to a
    // mutable Entity[], `IsReadonlyArray<typeof rows>` would become `false` and
    // this assignment would stop type-checking.
    const readonlyProof: IsReadonlyArray<typeof rows> = true;
    void readonlyProof;
    // The invalid `rows.push(...)` mutation itself is validated only by the
    // typechecker (see `assertFindResultCannotBeMutated`) and never executed
    // here, so this real result array is not mutated by the test.
  });
});

describe("scalar limit/offset paging compatibility", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  async function openRuntime(): Promise<Hikoutei> {
    const runtime = await createTypedSheets({ dbName: ":memory:", entities: [Article] });
    runtimes.push(runtime);
    return runtime;
  }

  it("limit and limit+offset slice equality-filtered reads deterministically", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    seed(em, ["a", "b", "c", "d", "e"]);
    await em.flush();

    // Order is pinned explicitly so this test isolates slicing; the default
    // primary-key ascending fallback for paged reads is proven by the
    // offset-only regression tests below, which seed rows out of order.
    const firstPage = await hikoutei.em.fork().find(
      Article,
      { published: true },
      { limit: 2, orderBy: { id: "asc" } },
    );
    expect(firstPage.map((row) => row.id)).toEqual(["a", "b"]);

    const secondPage = await hikoutei.em.fork().find(
      Article,
      { published: true },
      { limit: 2, offset: 2, orderBy: { id: "asc" } },
    );
    expect(secondPage.map((row) => row.id)).toEqual(["c", "d"]);

    // A limit larger than the remaining rows returns only what is left.
    const tail = await hikoutei.em.fork().find(
      Article,
      { published: true },
      { limit: 10, offset: 4, orderBy: { id: "asc" } },
    );
    expect(tail.map((row) => row.id)).toEqual(["e"]);

    // An explicit `limit: 0` must yield an empty page, not be mistaken for an
    // offset-only read that would return the tail. This guards the adapter
    // against truthiness-based limit handling (`if (limit)` instead of nullish
    // coalescing), which would incorrectly treat zero as "no limit".
    const emptyPage = await hikoutei.em.fork().find(
      Article,
      { published: true },
      { limit: 0, offset: 2, orderBy: { id: "asc" } },
    );
    expect(emptyPage).toEqual([]);
  });
});

describe("managed-entity input and identity boundaries", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  async function openRuntime(): Promise<Hikoutei> {
    const runtime = await createTypedSheets({ dbName: ":memory:", entities: [Article] });
    runtimes.push(runtime);
    return runtime;
  }

  it("create() rejects an undeclared property before any write", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    expect(() =>
      em.create(Article, {
        id: "x",
        title: "x",
        views: 1,
        published: true,
        summary: null,
        createdAt: SEEDED_AT,
        bogus: 1,
      } as never),
    ).toThrowError(expect.objectContaining({
      code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
    }));
  });

  it("create() with a duplicate primary key in one fork rejects an identity conflict", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    em.create(Article, {
      id: "dup", title: "first", views: 1, published: true, summary: null, createdAt: SEEDED_AT,
    });
    expect(() =>
      em.create(Article, {
        id: "dup", title: "second", views: 2, published: true, summary: null, createdAt: SEEDED_AT,
      }),
    ).toThrowError(expect.objectContaining({
      code: HIKOUTEI_ERROR_CODES.ENTITY_IDENTITY_CONFLICT,
    }));
  });

  it("persist() rejects an object this fork did not create or load", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    // A plain object never passed through create()/find() has no descriptor binding.
    const detached = {
      id: "detached",
      title: "detached",
      views: 1,
      published: true,
      summary: null,
      createdAt: SEEDED_AT,
    } as ArticleInstance;
    expect(() => em.persist(detached)).toThrowError(expect.objectContaining({
      code: HIKOUTEI_ERROR_CODES.UNMANAGED_ENTITY,
    }));
  });

  it("persist() rejects an entity materialized by a different fork", async () => {
    const hikoutei = await openRuntime();
    const owner = hikoutei.em.fork();
    owner.persist(owner.create(Article, {
      id: "owned", title: "owned", views: 1, published: true, summary: null, createdAt: SEEDED_AT,
    }));
    await owner.flush();
    const loaded = await owner.findOne(Article, { id: "owned" });
    if (loaded === null) throw new Error("expected the seeded article");

    // A second fork never bound this instance in its own descriptor WeakMap.
    const other = hikoutei.em.fork();
    expect(() => other.persist(loaded)).toThrowError(expect.objectContaining({
      code: HIKOUTEI_ERROR_CODES.UNMANAGED_ENTITY,
    }));
  });
});

describe("scalar offset-only pagination regression", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  async function openRuntime(): Promise<Hikoutei> {
    const runtime = await createTypedSheets({ dbName: ":memory:", entities: [Article] });
    runtimes.push(runtime);
    return runtime;
  }

  // Regression for `offset` without `limit`. The public option type allows
  // `{ offset }` independently of `{ limit }`, but SQLite rejects a bare
  // `OFFSET`, so the MikroORM adapter emits the SQLite idiom
  // `LIMIT -1 OFFSET n` (a negative LIMIT means "no upper bound"). These
  // assertions pin the intended result so a future regression in the adapter
  // fails the suite directly, instead of resurrecting the SQLite syntax error.
  it("find() with offset and no limit returns every row after the offset", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    // Seeded in reverse so the assertion can only pass when the paged query
    // applies its default primary-key ascending order; without that
    // normalization fallback the rows would stay in insertion order.
    seed(em, ["e", "d", "c", "b", "a"]);
    await em.flush();

    const tail = await hikoutei.em.fork().find(Article, {}, { offset: 2 });
    expect(tail.map((row) => row.id)).toEqual(["c", "d", "e"]);
  });

  it("find() with offset 0 and no limit returns every row", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    seed(em, ["e", "d", "c", "b", "a"]);
    await em.flush();

    // An offset of 0 must not drop rows; combined with the no-limit idiom it
    // is equivalent to the unpaged read, still normalized to primary-key
    // ascending order despite the reverse seed.
    const all = await hikoutei.em.fork().find(Article, {}, { offset: 0 });
    expect(all.map((row) => row.id)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("find() with an offset beyond the row count returns an empty array", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    seed(em, ["a", "b", "c", "d", "e"]);
    await em.flush();

    const beyond = await hikoutei.em.fork().find(Article, {}, { offset: 100 });
    expect(beyond).toEqual([]);
  });
});
