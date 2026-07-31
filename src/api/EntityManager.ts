/**
 * Stable provider-neutral entity lifecycle contract.
 *
 * The implementation lives in an internal module so the generated root
 * declaration never imports SQL, MikroORM, Prisma, or provider contracts.
 */

import type { HikouteiEntity } from "./entity.js";

/** Equality filter options shared by all provider implementations. */
export interface HikouteiFindOptions {
  readonly limit?: number;
  readonly offset?: number;
}

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
    where?: Readonly<Partial<Entity>>,
    options?: HikouteiFindOptions,
  ): Promise<readonly Entity[]>;
  findOne<Entity extends object>(
    entity: HikouteiEntity<Entity>,
    where: Readonly<Partial<Entity>>,
  ): Promise<Entity | null>;
  persist<Entity extends object>(input: Entity | Iterable<Entity>): EntityManager;
  remove<Entity extends object>(input: Entity | Iterable<Entity>): EntityManager;
  flush(): Promise<void>;
  transactional<Result>(operation: (entityManager: EntityManager) => Promise<Result>): Promise<Result>;
}
