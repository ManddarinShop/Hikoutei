import { Inject, Injectable } from "@nestjs/common";
import type { EntityManager } from "hikoutei";
import { HIKOUTEI, User, type HikouteiRuntime } from "./hikoutei.module.js";

@Injectable()
export class UsersService {
  constructor(
    @Inject(HIKOUTEI) private readonly hikoutei: HikouteiRuntime,
  ) {}

  async create(id: string, name: string): Promise<void> {
    const em: EntityManager = this.hikoutei.em.fork();
    em.persist(em.create(User, { id, name }));
    await em.flush();
  }

  async findOne(id: string) {
    const em: EntityManager = this.hikoutei.em.fork();
    return em.findOne(User, { id });
  }
}
