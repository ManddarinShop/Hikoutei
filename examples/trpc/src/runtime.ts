import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";

export const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
  },
});

export const hikoutei = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
});
