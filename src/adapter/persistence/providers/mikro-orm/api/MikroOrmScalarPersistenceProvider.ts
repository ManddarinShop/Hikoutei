/**
 * MikroORM implementation of Hikoutei's scalar persistence SPI.
 *
 * The public Unit of Work prepares provider-neutral row changes. This adapter
 * translates those changes into the existing mapped MikroORM facade, whose
 * flush coordinator still commits canonical state and the durable Sheet
 * outbox in the same SQLite transaction. No MikroORM type crosses the root
 * public entrypoint.
 */

import type {
  ResolvedHikouteiEntityDescriptor,
} from "../../../../../api/entity.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "../../../../../api/errors.js";
import type {
  ScalarEntityDelete,
  ScalarEntityInsert,
  ScalarEntityPersistenceProvider,
  ScalarEntityQuery,
  ScalarEntityRow,
  ScalarEntityTransaction,
  ScalarEntityUpdate,
  ScalarEntityValue,
} from "../../../contracts/scalar.js";
import type {
  TypedSheetsEntityData,
  TypedSheetsEntityReference,
  TypedSheetsFindOptions,
  TypedSheetsEntityFilter,
  TypedSheetsOrm,
  TypedSheetsEntityManager,
} from "../../../../../application/orm/index.js";

/** Internal mapping from a public descriptor to its generated MikroORM entity. */
export interface MikroOrmScalarEntityBinding {
  readonly descriptor: ResolvedHikouteiEntityDescriptor;
  readonly entity: TypedSheetsEntityReference<object>;
}

/**
 * Adapts one mapped MikroORM runtime to the provider-neutral scalar contract.
 *
 * Entity tables are created by the generated schemas before this adapter is
 * constructed. Every transaction delegates through `TypedSheetsOrm.em`, so
 * its existing canonical/outbox flush coordinator remains in the same SQLite
 * transaction as the generated entity rows.
 */
export class MikroOrmScalarPersistenceProvider implements ScalarEntityPersistenceProvider {
  private readonly bindings: ReadonlyMap<string, MikroOrmScalarEntityBinding>;

  constructor(
    private readonly orm: TypedSheetsOrm,
    bindings: readonly MikroOrmScalarEntityBinding[],
  ) {
    this.bindings = new Map(bindings.map((binding) => [binding.descriptor.name, binding]));
  }

  /** Reads through a fresh internal manager so public identity maps stay local. */
  async read(query: ScalarEntityQuery): Promise<readonly ScalarEntityRow[]> {
    const binding = this.requireBindingByTable(query.tableName);
    const manager = this.orm.em.fork();
    return readRows(manager, binding, query);
  }

  /** Runs one common-UoW transaction through the mapped MikroORM facade. */
  async beginTransaction<Result>(
    work: (transaction: ScalarEntityTransaction) => Promise<Result>,
  ): Promise<Result> {
    return this.orm.em.transactional(async (manager) => {
      const transaction = new MikroOrmScalarTransaction(manager, this.bindings);
      return work(transaction);
    });
  }

  /** Closes the internal mapped runtime and its SQLite connection. */
  async close(): Promise<void> {
    await this.orm.close(true);
  }

  private requireBindingByTable(tableName: string): MikroOrmScalarEntityBinding {
    for (const binding of this.bindings.values()) {
      if (binding.descriptor.tableName === tableName) return binding;
    }
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.UNREGISTERED_ENTITY,
      `entity table "${tableName}" is not registered with this runtime.`,
    );
  }
}

/** Transaction-bound translation from scalar plans to mapped entity writes. */
class MikroOrmScalarTransaction implements ScalarEntityTransaction {
  constructor(
    private readonly manager: TypedSheetsEntityManager,
    private readonly bindings: ReadonlyMap<string, MikroOrmScalarEntityBinding>,
  ) {}

  async insert(row: ScalarEntityInsert): Promise<void> {
    const binding = this.requireBindingByTable(row.tableName);
    const entity = this.manager.create(
      binding.entity,
      toInternalData(binding.descriptor, row.values) as TypedSheetsEntityData<object>,
    );
    this.manager.persist(entity);
  }

  async update(row: ScalarEntityUpdate): Promise<void> {
    const binding = this.requireBindingByTable(row.tableName);
    const existing = await this.findOne(binding, row.primaryKeyColumn, row.primaryKeyValue);
    if (existing === null) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.ENTITY_NOT_FOUND,
        `cannot update missing entity in table "${row.tableName}".`,
      );
    }
    Object.assign(existing, toInternalData(binding.descriptor, row.changedValues));
    this.manager.persist(existing);
  }

  async delete(row: ScalarEntityDelete): Promise<void> {
    const binding = this.requireBindingByTable(row.tableName);
    const existing = await this.findOne(binding, row.primaryKeyColumn, row.primaryKeyValue);
    if (existing === null) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.ENTITY_NOT_FOUND,
        `cannot delete missing entity in table "${row.tableName}".`,
      );
    }
    this.manager.remove(existing);
  }

  async read(query: ScalarEntityQuery): Promise<readonly ScalarEntityRow[]> {
    const binding = this.requireBindingByTable(query.tableName);
    return readRows(this.manager, binding, query);
  }

  /** Forces MikroORM's mapped flush before the common UoW advances snapshots. */
  async flush(): Promise<void> {
    await this.manager.flush();
  }

  private async findOne(
    binding: MikroOrmScalarEntityBinding,
    primaryKeyColumn: string,
    primaryKeyValue: ScalarEntityValue,
  ): Promise<object | null> {
    const result = await this.manager.findOne(
      binding.entity,
      { [primaryKeyColumn]: toInternalValue(binding.descriptor, primaryKeyColumn, primaryKeyValue) } as TypedSheetsEntityFilter<object>,
    );
    return result;
  }

  private requireBindingByTable(tableName: string): MikroOrmScalarEntityBinding {
    for (const binding of this.bindings.values()) {
      if (binding.descriptor.tableName === tableName) return binding;
    }
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.UNREGISTERED_ENTITY,
      `entity table "${tableName}" is not registered with this runtime.`,
    );
  }
}

async function readRows(
  manager: TypedSheetsEntityManager,
  binding: MikroOrmScalarEntityBinding,
  query: ScalarEntityQuery,
): Promise<readonly ScalarEntityRow[]> {
  const entities = await manager.find(
    binding.entity,
    toInternalFilter(binding.descriptor, query.where) as TypedSheetsEntityFilter<object>,
    toFindOptions(query),
  );
  return entities.map((entity) => fromInternalEntity(binding.descriptor, entity));
}

function toFindOptions(query: ScalarEntityQuery): TypedSheetsFindOptions {
  return {
    ...(query.limit === undefined ? {} : { limit: query.limit }),
    ...(query.offset === undefined ? {} : { offset: query.offset }),
  };
}

function toInternalFilter(
  descriptor: ResolvedHikouteiEntityDescriptor,
  where: Readonly<Record<string, ScalarEntityValue>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(where).map(([property, value]) => [
      property,
      toInternalValue(descriptor, property, value),
    ]),
  );
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
  const record = entity as Readonly<Record<string, unknown>>;
  for (const property of descriptor.properties) {
    const value = record[property.name];
    if (property.type === "date") {
      if (value === null || value === undefined) {
        values[property.name] = null;
        continue;
      }
      if (typeof value !== "string") {
        throw new HikouteiError(
          HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
          `${property.name} returned a non-string stored date.`,
        );
      }
      const date = new Date(value);
      if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
        throw new HikouteiError(
          HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
          `${property.name} contains a non-canonical stored date.`,
        );
      }
      values[property.name] = date;
      continue;
    }
    values[property.name] = value === undefined ? null : value as ScalarEntityValue;
  }
  return values;
}
