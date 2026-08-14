/**
 * Temporary installed-consumer TypeScript typecheck for the public API.
 *
 * This file is CI verification infrastructure only. It is NOT shipped in the
 * npm tarball (`files: ["dist"]` excludes `scripts/`) and it is NOT compiled by
 * the repository's own `tsconfig.json` (which includes only `src/**`). The CI
 * workflow copies it into a throwaway consumer directory, installs the packed
 * `hikoutei` tarball plus the `typescript` compiler, and runs `tsc --noEmit`
 * against it. That closes the gap the JavaScript runtime smoke leaves open: it
 * compiles an EXTERNAL consumer against the packed `dist/index.d.ts`, not
 * against repository source.
 *
 * It imports only the root package entrypoint `hikoutei` and exercises:
 *
 *   - the public value exports (`createTypedSheets`, `defineTypedSheetsEntity`,
 *     `HIKOUTEI_ERROR_CODES`, `HIKOUTEI_SCALAR_TYPES`, `HikouteiError`)
 *   - the public type exports (`EntityManager`, `HikouteiEntity`,
 *     `HikouteiFilter`, `HikouteiFindOptions`, `HikouteiOrderBy`)
 *   - a scalar entity definition and a full `createTypedSheets()` +
 *     `em.create()`/`persist()`/`find()`/`count()`/`findAndCount()` usage
 *   - compile-time rejection guards that internal storage/provider symbols are
 *     NOT re-exported from the installed package
 *
 * It is typechecked only; nothing here is executed and it never contacts Google
 * Sheets or needs credentials.
 */

import {
  createTypedSheets,
  defineTypedSheetsEntity,
  HIKOUTEI_ERROR_CODES,
  HIKOUTEI_SCALAR_TYPES,
  HikouteiError,
} from "hikoutei";
import type {
  EntityManager,
  HikouteiEntity,
  HikouteiFilter,
  HikouteiFindOptions,
  HikouteiOrderBy,
} from "hikoutei";

// Scalar entity declared through the public factory.
const Product = defineTypedSheetsEntity({
  name: "Product",
  tableName: "products",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
    price: { type: "number" },
    active: { type: "boolean" },
  },
});

// Inferred mutable instance shape carried by the entity token. The phantom
// `Entity` generic is the first parameter; the second is the descriptor name.
type ProductInstance = (typeof Product) extends HikouteiEntity<infer Entity, string>
  ? Entity
  : never;

// Typecheck the runtime factory and the EntityManager read/write surface. This
// is typechecked only (tsc --noEmit); it is never executed and needs no Google
// credentials. A pass proves the packed dist/index.d.ts is consumable.
async function exercisePublicApi(): Promise<void> {
  const hikoutei = await createTypedSheets({
    dbName: ":memory:",
    entities: [Product],
  });
  const manager: EntityManager = hikoutei.em.fork();

  const created: ProductInstance = manager.create(Product, {
    id: "p-001",
    name: "Widget",
    price: 9.99,
    active: true,
  });
  manager.persist(created);
  await manager.flush();

  // Public query types: equality shorthand plus Hikoutei field operators.
  const where: HikouteiFilter<ProductInstance> = {
    active: true,
    price: { gte: 5, lt: 100 },
    name: { like: "Wid_" },
  };
  const orderBy: HikouteiOrderBy<ProductInstance> = { name: "asc" };
  const options: HikouteiFindOptions<ProductInstance> = {
    orderBy,
    limit: 10,
    offset: 0,
  };

  const found: readonly ProductInstance[] = await manager.find(Product, where, options);
  const single: ProductInstance | null = await manager.findOne(Product, { id: "p-001" });
  const total: number = await manager.count(Product, {
    active: { in: [true, false] },
    id: { nin: ["missing"] },
  });
  const [page, pageTotal]: readonly [readonly ProductInstance[], number] =
    await manager.findAndCount(Product, { active: true }, { orderBy: { id: "asc" }, limit: 1 });
  void found;
  void single;
  void total;
  void page;
  void pageTotal;

  await hikoutei.close();
}
void exercisePublicApi;

// Stable public runtime constants must carry their documented literal values.
const stringType: "string" = HIKOUTEI_SCALAR_TYPES.STRING;
const numberType: "number" = HIKOUTEI_SCALAR_TYPES.NUMBER;
const booleanType: "boolean" = HIKOUTEI_SCALAR_TYPES.BOOLEAN;
const dateType: "date" = HIKOUTEI_SCALAR_TYPES.DATE;
const invalidDescriptorCode: "invalid_entity_descriptor" =
  HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR;
const duplicateEntityCode: "duplicate_entity" = HIKOUTEI_ERROR_CODES.DUPLICATE_ENTITY;
void stringType;
void numberType;
void booleanType;
void dateType;
void invalidDescriptorCode;
void duplicateEntityCode;

// The public error type is a throwable class and a type guard target.
function isPublicError(value: unknown): value is HikouteiError {
  return value instanceof HikouteiError;
}
void isPublicError;

// Compile-time rejection guards against the INSTALLED dist/index.d.ts. These
// internal storage/provider symbols must NOT be part of the public contract.
// Each `@ts-expect-error` must stay used: if any symbol below is ever
// re-exported from the root, the directive becomes unused and `tsc` reports
// TS2578, surfacing the public-boundary leak for review.
//
// True type exports use the bare `import("hikoutei").Type` form. Internal
// VALUE exports use `typeof import("hikoutei").name` instead: a bare type
// reference to a value member stays an error even when the value IS
// re-exported (the query never resolves as a type), so its directive would
// remain satisfied and the leak would pass silently. The `typeof` query only
// resolves when the value exists, so an accidental value re-export makes the
// directive unused and fails with TS2578.
// @ts-expect-error the internal validated query shape is not public.
type LeakScalarEntityQuery = import("hikoutei").ScalarEntityQuery;
// @ts-expect-error the provider-neutral persistence provider is internal.
type LeakPersistenceProvider = import("hikoutei").ScalarEntityPersistenceProvider;
// @ts-expect-error the internal provider-neutral predicate contract is internal.
type LeakScalarEntityPredicate = import("hikoutei").ScalarEntityPredicate;
// @ts-expect-error the raw provider row/value shape is internal.
type LeakScalarEntityRow = import("hikoutei").ScalarEntityRow;
// @ts-expect-error query normalization is an internal boundary.
type LeakNormalizeEntityQuery = typeof import("hikoutei").normalizeEntityQuery;
// @ts-expect-error the public EntityManager has no factory on its surface.
type LeakCreateEntityManager = typeof import("hikoutei").createEntityManager;
// @ts-expect-error descriptor resolution helpers are internal.
type LeakGetEntityDescriptor = typeof import("hikoutei").getEntityDescriptor;
// @ts-expect-error the local-only runtime factory is internal.
type LeakCreateLocalTypedSheetsRuntime = typeof import("hikoutei").createLocalTypedSheetsRuntime;
void (null as unknown as LeakScalarEntityQuery);
void (null as unknown as LeakPersistenceProvider);
void (null as unknown as LeakScalarEntityPredicate);
void (null as unknown as LeakScalarEntityRow);
void (null as unknown as LeakNormalizeEntityQuery);
void (null as unknown as LeakCreateEntityManager);
void (null as unknown as LeakGetEntityDescriptor);
void (null as unknown as LeakCreateLocalTypedSheetsRuntime);
