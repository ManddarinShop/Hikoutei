import { createTypedSheets, defineTypedSheetsEntity, type Hikoutei } from "hikoutei";

export const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
  },
});

// Singleton across route handlers / hot reload. A local SQLite file requires
// a long-lived Node process: run Next.js with `output: "standalone"` in a
// container (serverless Functions use a read-only filesystem).
const globalForHikoutei = globalThis as unknown as { hikoutei?: Hikoutei };

export async function getHikoutei(): Promise<Hikoutei> {
  if (globalForHikoutei.hikoutei === undefined) {
    globalForHikoutei.hikoutei = await createTypedSheets({
      dbName: "./hikoutei.sqlite",
      entities: [User],
    });
  }
  return globalForHikoutei.hikoutei;
}
