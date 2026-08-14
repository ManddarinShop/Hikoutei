/**
 * MikroORM implementation of Hikoutei's scalar persistence SPI.
 *
 * Hikoutei's Unit of Work is the only lifecycle authority. This adapter merely
 * schedules its provider-neutral row plan on a transaction-bound MikroORM
 * manager, runs the optional mapped canonical/outbox planner, and flushes the
 * entity statements in the same SQLite transaction.
 */

import type { ResolvedHikouteiEntityDescriptor } from "../../../../../api/entity.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "../../../../../api/errors.js";
import type {
  ScalarEntityCountQuery,
  ScalarEntityDelete,
  ScalarEntityFlushChange,
  ScalarEntityFlushCoordinator,
  ScalarEntityInsert,
  ScalarEntityPersistenceProvider,
  ScalarEntityPredicate,
  ScalarEntityQuery,
  ScalarEntityReader,
  ScalarEntityRow,
  ScalarEntityTransaction,
  ScalarEntityUpdate,
  ScalarEntityValue,
} from "../../../contracts/scalar.js";
import type {
  MikroOrmSqliteAdapter,
  MikroOrmSqliteEntityManager,
} from "../storage/MikroOrmSqliteAdapter.js";
import { isCanonicalUtcIsoDate } from "../../../../../shared/validation.js";
import { isRecord } from "../../../../../shared/encoding/typeGuards.js";
import type { MappedEntityReference } from "../../../../../application/orm/mapping/contracts.js";

/** Internal mapping from a public descriptor to its generated MikroORM entity. */
export interface MikroOrmScalarEntityBinding {
  readonly descriptor: ResolvedHikouteiEntityDescriptor;
  /** Kept opaque so MikroORM types remain inside this adapter module. */
  readonly entity: MappedEntityReference<Record<string, unknown>>;
}

/**
 * Adapts generated MikroORM entity bindings to the provider-neutral scalar
 * contract. A mapped coordinator, when supplied, runs before entity SQL and
 * shares the active manager's transaction-bound SQL executor.
 */
export class MikroOrmScalarPersistenceProvider implements ScalarEntityPersistenceProvider {
  private readonly bindings: ReadonlyMap<string, MikroOrmScalarEntityBinding>;
  private readonly bindingsByTable: ReadonlyMap<string, MikroOrmScalarEntityBinding>;

  constructor(
    private readonly storage: MikroOrmSqliteAdapter,
    bindings: readonly MikroOrmScalarEntityBinding[],
    private readonly flushCoordinator?: ScalarEntityFlushCoordinator,
  ) {
    this.bindings = new Map(bindings.map((binding) => [binding.descriptor.name, binding]));
    this.bindingsByTable = new Map(bindings.map((binding) => [binding.descriptor.tableName, binding]));
  }

  /** Reads through a clean manager without flushing another Unit of Work. */
  async read(query: ScalarEntityQuery): Promise<readonly ScalarEntityRow[]> {
    const manager = this.storage.forkEntityManager();
    return readRows(manager, this.requireBindingByTable(query.tableName), query);
  }

  /** Counts rows through a clean manager without materializing entities. */
  async count(query: ScalarEntityCountQuery): Promise<number> {
    const manager = this.storage.forkEntityManager();
    return countRows(manager, this.requireBindingByTable(query.tableName), query);
  }

  /** Runs sequential reads through one consistent SQLite read transaction. */
  async readSnapshot<Result>(
    work: (reader: ScalarEntityReader) => Promise<Result>,
  ): Promise<Result> {
    return this.storage.transactional(async ({ entityManager }) => {
      return work(new MikroOrmScalarReader(
        entityManager,
        this.bindings,
        this.bindingsByTable,
      ));
    });
  }

  /** Runs the common UoW plan and mapped work in one SQLite transaction. */
  async beginTransaction<Result>(
    work: (transaction: ScalarEntityTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.storage.transactional(async ({ entityManager }) => {
      const transaction = new MikroOrmScalarTransaction(
        this.storage,
        entityManager,
        this.bindings,
        this.bindingsByTable,
        this.flushCoordinator,
      );
      return work(transaction);
    });
  }

  /** Closes the one SQLite connection owned by this provider. */
  async close(): Promise<void> {
    await this.storage.close(true);
  }

  private requireBindingByTable(tableName: string): MikroOrmScalarEntityBinding {
    const binding = this.bindingsByTable.get(tableName);
    if (binding !== undefined) return binding;
    throw unregisteredTable(tableName);
  }
}

/** Transaction-bound reader shared by provider reads and flush-time lookups. */
class MikroOrmScalarReader implements ScalarEntityReader {
  constructor(
    protected readonly entityManager: MikroOrmSqliteEntityManager,
    protected readonly bindings: ReadonlyMap<string, MikroOrmScalarEntityBinding>,
    protected readonly bindingsByTable: ReadonlyMap<string, MikroOrmScalarEntityBinding>,
  ) {}

  async read(query: ScalarEntityQuery): Promise<readonly ScalarEntityRow[]> {
    return readRows(this.entityManager, this.requireBindingByTable(query.tableName), query);
  }

  async count(query: ScalarEntityCountQuery): Promise<number> {
    return countRows(this.entityManager, this.requireBindingByTable(query.tableName), query);
  }

  protected requireBindingByTable(tableName: string): MikroOrmScalarEntityBinding {
    const binding = this.bindingsByTable.get(tableName);
    if (binding !== undefined) return binding;
    throw unregisteredTable(tableName);
  }

  protected requireBindingForRow(
    entityName: string,
    tableName: string,
  ): MikroOrmScalarEntityBinding {
    const binding = this.bindings.get(entityName);
    if (binding !== undefined && binding.descriptor.tableName === tableName) return binding;
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.UNREGISTERED_ENTITY,
      `entity "${entityName}" is not registered for table "${tableName}".`,
    );
  }
}

/**
 * Schedules a Hikoutei flush plan on the active MikroORM manager.
 *
 * The coordinator runs before MikroORM emits entity SQL. Both its SQL and the
 * later entity statements are owned by the surrounding `transactional()` call,
 * so either side can reject without leaving a partial canonical/outbox write.
 */
class MikroOrmScalarTransaction
  extends MikroOrmScalarReader
  implements ScalarEntityTransaction {
  private readonly changes: ScalarEntityFlushChange[] = [];

  constructor(
    private readonly storage: MikroOrmSqliteAdapter,
    entityManager: MikroOrmSqliteEntityManager,
    bindings: ReadonlyMap<string, MikroOrmScalarEntityBinding>,
    bindingsByTable: ReadonlyMap<string, MikroOrmScalarEntityBinding>,
    private readonly flushCoordinator: ScalarEntityFlushCoordinator | undefined,
  ) {
    super(entityManager, bindings, bindingsByTable);
  }

  async insert(row: ScalarEntityInsert): Promise<void> {
    const binding = this.requireBindingForRow(row.entityName, row.tableName);
    const entity = createManagedEntity(
      this.entityManager,
      binding,
      row.values,
    );
    this.entityManager.persist(entity);
    this.changes.push({ kind: "insert", row });
  }

  async update(row: ScalarEntityUpdate): Promise<void> {
    const binding = this.requireBindingForRow(row.entityName, row.tableName);
    const existing = await this.findOne(binding, row.primaryKeyColumn, row.primaryKeyValue);
    if (existing === null) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.ENTITY_NOT_FOUND,
        `cannot update missing entity in table "${row.tableName}".`,
      );
    }
    Object.assign(existing, toInternalData(binding.descriptor, row.changedValues));
    this.entityManager.persist(existing);
    this.changes.push({ kind: "update", row });
  }

  async delete(row: ScalarEntityDelete): Promise<void> {
    const binding = this.requireBindingForRow(row.entityName, row.tableName);
    const existing = await this.findOne(binding, row.primaryKeyColumn, row.primaryKeyValue);
    if (existing === null) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.ENTITY_NOT_FOUND,
        `cannot delete missing entity in table "${row.tableName}".`,
      );
    }
    this.entityManager.remove(existing);
    this.changes.push({ kind: "delete", row });
  }

  /** Plans mapped state first, then flushes the scheduled entity statements. */
  async flush(): Promise<void> {
    if (this.changes.length > 0 && this.flushCoordinator !== undefined) {
      await this.flushCoordinator.onFlush({
        changes: [...this.changes],
        sql: this.storage.createSqlExecutor(this.entityManager),
      });
    }
    await this.entityManager.flush();
    this.changes.length = 0;
  }

  private async findOne(
    binding: MikroOrmScalarEntityBinding,
    primaryKeyColumn: string,
    primaryKeyValue: ScalarEntityValue,
  ): Promise<object | null> {
    const result: unknown = await Reflect.apply(
      this.entityManager.findOne,
      this.entityManager,
      [
        binding.entity,
        { [primaryKeyColumn]: toInternalValue(binding.descriptor, primaryKeyColumn, primaryKeyValue) },
      ],
    );
    if (result === null) return null;
    if (!isRecord(result)) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
        "MikroORM findOne result must be an entity object or null.",
      );
    }
    return result;
  }
}

function createManagedEntity(
  entityManager: MikroOrmSqliteEntityManager,
  binding: MikroOrmScalarEntityBinding,
  values: Readonly<Record<string, ScalarEntityValue>>,
): object {
  const result: unknown = Reflect.apply(
    entityManager.create,
    entityManager,
    [binding.entity, toInternalData(binding.descriptor, values), { partial: true, persist: false }],
  );
  if (!isRecord(result)) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      "MikroORM create result must be an entity object.",
    );
  }
  return result;
}

async function readRows(
  entityManager: MikroOrmSqliteEntityManager,
  binding: MikroOrmScalarEntityBinding,
  query: ScalarEntityQuery,
): Promise<readonly ScalarEntityRow[]> {
  const result: unknown = await Reflect.apply(
    entityManager.find,
    entityManager,
    [
      binding.entity,
      toMikroOrmFilter(
        toInternalPredicate(binding.descriptor, query.predicate),
        query.primaryKeyColumn,
      ),
      toMikroOrmQueryOptions(query),
    ],
  );
  if (!Array.isArray(result) || !result.every(isRecord)) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      "MikroORM find result must be an array of entity objects.",
    );
  }
  return result.map((entity) => fromInternalEntity(binding.descriptor, entity));
}

async function countRows(
  entityManager: MikroOrmSqliteEntityManager,
  binding: MikroOrmScalarEntityBinding,
  query: ScalarEntityCountQuery,
): Promise<number> {
  const result: unknown = await Reflect.apply(
    entityManager.count,
    entityManager,
    [
      binding.entity,
      toMikroOrmFilter(
        toInternalPredicate(binding.descriptor, query.predicate),
        query.primaryKeyColumn,
      ),
    ],
  );
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      "MikroORM count result must be a non-negative safe integer.",
    );
  }
  return result;
}

function toMikroOrmQueryOptions(query: ScalarEntityQuery): Record<string, unknown> {
  const orderBy = query.orderBy.map((order) => ({ [order.field]: order.direction }));
  // SQLite rejects a bare `OFFSET` (it requires a preceding `LIMIT`), so an
  // offset-only public query must use the SQLite idiom for "all rows after a
  // skip": a negative `LIMIT`, which SQLite treats as no upper bound. The
  // public option contract still allows `{ offset }` independently of
  // `{ limit }`; this `LIMIT -1` stays inside the MikroORM adapter boundary and
  // is never exposed as raw SQL to application code. `limit` is `0`-safe via
  // nullish coalescing: an explicit `limit: 0` is preserved unchanged.
  const limit = query.limit ?? (query.offset === undefined ? undefined : -1);
  return {
    ...(orderBy.length === 0 ? {} : { orderBy }),
    ...(limit === undefined ? {} : { limit }),
    ...(query.offset === undefined ? {} : { offset: query.offset }),
  };
}

function toInternalPredicate(
  descriptor: ResolvedHikouteiEntityDescriptor,
  predicate: ScalarEntityPredicate,
): ScalarEntityPredicate {
  switch (predicate.kind) {
    case "comparison":
      return {
        ...predicate,
        value: toInternalValue(descriptor, predicate.field, predicate.value),
      };
    case "set":
      return {
        ...predicate,
        values: predicate.values.map((value) =>
          toInternalValue(descriptor, predicate.field, value)
        ),
      };
    case "all":
    case "any":
      return {
        ...predicate,
        predicates: predicate.predicates.map((child) =>
          toInternalPredicate(descriptor, child)
        ),
      };
    case "like":
    case "null":
    case "constant":
      return predicate;
  }
}

function toMikroOrmFilter(
  predicate: ScalarEntityPredicate,
  primaryKeyColumn: string,
): Record<string, unknown> {
  switch (predicate.kind) {
    case "comparison":
      return { [predicate.field]: { [`$${predicate.operator}`]: predicate.value } };
    case "set":
      return { [predicate.field]: { [`$${predicate.operator}`]: [...predicate.values] } };
    case "like":
      return { [predicate.field]: { $like: predicate.pattern } };
    case "null":
      return predicate.operator === "is_null"
        ? { [predicate.field]: null }
        : { [predicate.field]: { $ne: null } };
    case "constant":
      return predicate.value ? {} : { [primaryKeyColumn]: { $in: [] } };
    case "all":
      return {
        $and: predicate.predicates.map((child) =>
          toMikroOrmFilter(child, primaryKeyColumn)
        ),
      };
    case "any":
      return {
        $or: predicate.predicates.map((child) =>
          toMikroOrmFilter(child, primaryKeyColumn)
        ),
      };
  }
}

function toInternalData(
  descriptor: ResolvedHikouteiEntityDescriptor,
  values: Readonly<Record<string, ScalarEntityValue>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).map(([property, value]) => [
      property,
      toInternalValue(descriptor, property, value),
    ]),
  );
}

function toInternalValue(
  descriptor: ResolvedHikouteiEntityDescriptor,
  propertyName: string,
  value: Exclude<ScalarEntityValue, null>,
): Exclude<ScalarEntityValue, null> | string;
function toInternalValue(
  descriptor: ResolvedHikouteiEntityDescriptor,
  propertyName: string,
  value: ScalarEntityValue,
): ScalarEntityValue | string;
function toInternalValue(
  descriptor: ResolvedHikouteiEntityDescriptor,
  propertyName: string,
  value: ScalarEntityValue,
): ScalarEntityValue | string {
  const property = descriptor.properties.find((candidate) => candidate.name === propertyName);
  if (property?.type === "date" && value instanceof Date) return value.toISOString();
  return value;
}

function fromInternalEntity(
  descriptor: ResolvedHikouteiEntityDescriptor,
  entity: object,
): ScalarEntityRow {
  const values: Record<string, ScalarEntityValue> = {};
  for (const property of descriptor.properties) {
    const value = Reflect.get(entity, property.name);
    if (value === null || value === undefined) {
      if (!property.nullable) {
        throw new HikouteiError(
          HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
          `${property.name} is unexpectedly ${value === null ? "null" : "missing"} in the stored entity.`,
        );
      }
      values[property.name] = null;
      continue;
    }

    switch (property.type) {
      case "string":
        if (typeof value !== "string") throwInvalidStoredScalar(property.name, "string");
        values[property.name] = value;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throwInvalidStoredScalar(property.name, "finite number");
        }
        values[property.name] = value;
        break;
      case "boolean":
        if (typeof value !== "boolean") throwInvalidStoredScalar(property.name, "boolean");
        values[property.name] = value;
        break;
      case "date": {
        if (typeof value !== "string" || !isCanonicalUtcIsoDate(value)) {
          throwInvalidStoredScalar(property.name, "canonical UTC date string");
        }
        values[property.name] = new Date(value);
        break;
      }
    }
  }
  return values;
}

function throwInvalidStoredScalar(propertyName: string, expected: string): never {
  throw new HikouteiError(
    HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
    `${propertyName} must be a ${expected} in the stored entity.`,
  );
}

function unregisteredTable(tableName: string): HikouteiError {
  return new HikouteiError(
    HIKOUTEI_ERROR_CODES.UNREGISTERED_ENTITY,
    `entity table "${tableName}" is not registered with this runtime.`,
  );
}
