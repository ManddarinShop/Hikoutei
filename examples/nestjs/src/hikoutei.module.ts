import { Global, Inject, Module, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createTypedSheets, defineTypedSheetsEntity, type EntityManager } from "hikoutei";

export const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
  },
});

export const HIKOUTEI = Symbol("HIKOUTEI");
export type HikouteiRuntime = {
  em: { fork(): EntityManager };
  close(): Promise<void>;
};

@Global()
@Module({
  providers: [
    {
      provide: HIKOUTEI,
      useFactory: async (): Promise<HikouteiRuntime> =>
        createTypedSheets({ dbName: "./hikoutei.sqlite", entities: [User] }),
    },
    {
      provide: "EM",
      inject: [HIKOUTEI],
      useFactory: (hikoutei: HikouteiRuntime) => hikoutei.em.fork(),
    },
  ],
  exports: [HIKOUTEI, "EM"],
})
export class HikouteiModule implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(HIKOUTEI) private readonly hikoutei: HikouteiRuntime) {}
  async onModuleInit(): Promise<void> {}
  async onModuleDestroy(): Promise<void> {
    await this.hikoutei.close();
  }
}
