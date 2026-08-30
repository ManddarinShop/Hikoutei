/**
 * Stable provider-neutral entity lifecycle contract.
 *
 * The implementation lives in an internal module so the generated root
 * declaration never imports SQL, MikroORM, Prisma, or provider contracts.
 */

import type { HikouteiEntity } from "./entity.js";
import type {
  HikouteiFilter,
  HikouteiFindOneOptions,
  HikouteiFindOptions,
} from "./query.js";

export type {
  HikouteiFilter,
  HikouteiFindOneOptions,
  HikouteiFindOptions,
  HikouteiOperatorFilter,
  HikouteiOrderBy,
  HikouteiSortDirection,
} from "./query.js";

/**
 * Request-local entity manager exposed by `createTypedSheets()`.
 *
 * The constructor and provider wiring are intentionally not part of this
 * contract; applications obtain managers from `hikoutei.em.fork()`.
 */
export interface EntityManager {
  fork(): EntityManager;
  create<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    data: Readonly<Partial<Entity>>,
  ): Entity;
  find<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where?: HikouteiFilter<Entity>,
    options?: HikouteiFindOptions<Entity>,
  ): Promise<readonly Entity[]>;
  findOne<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where: HikouteiFilter<Entity>,
    options?: HikouteiFindOneOptions<Entity>,
  ): Promise<Entity | null>;
  count<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where?: HikouteiFilter<Entity>,
  ): Promise<number>;
  findAndCount<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where?: HikouteiFilter<Entity>,
    options?: HikouteiFindOptions<Entity>,
  ): Promise<readonly [readonly Entity[], number]>;
  persist<Entity extends object>(input: Entity | Iterable<Entity>): EntityManager;
  remove<Entity extends object>(input: Entity | Iterable<Entity>): EntityManager;
  flush(): Promise<void>;
  transactional<Result>(operation: (entityManager: EntityManager) => Promise<Result>): Promise<Result>;
}
