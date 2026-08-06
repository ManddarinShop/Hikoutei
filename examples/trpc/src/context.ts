import type { EntityManager, Hikoutei } from "hikoutei";

export type Context = {
  em: EntityManager;
  hikoutei: Hikoutei;
};

export function createContext(hikoutei: Hikoutei, fork: boolean): Context {
  return { hikoutei, em: hikoutei.em.fork() };
}
