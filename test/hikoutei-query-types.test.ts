import { describe, expect, it } from "vitest";

import {
  createTypedSheets,
  defineTypedSheetsEntity,
  type HikouteiFilter,
  type HikouteiFindOneOptions,
  type HikouteiFindOptions,
  type HikouteiOperatorFilter,
  type HikouteiOrderBy,
} from "../src/index.js";

const QueryUser = defineTypedSheetsEntity({
  name: "QueryTypeUser",
  tableName: "query_type_users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
    nickname: { type: "string", nullable: true },
    age: { type: "number" },
    active: { type: "boolean" },
    createdAt: { type: "date" },
  },
});

type QueryUserInstance = {
  id: string;
  name: string;
  nickname: string | null;
  age: number;
  active: boolean;
  createdAt: Date;
};

const validFilter: HikouteiFilter<QueryUserInstance> = {
  id: { in: ["a", "b"] },
  name: { gt: "A", lte: "Z", like: "A%" },
  nickname: { eq: null, nin: [null, "blocked"] },
  age: { gte: 18, lt: 65 },
  active: { ne: false, in: [true] },
  createdAt: { gt: new Date("2026-01-01T00:00:00.000Z") },
};
const validOrder: HikouteiOrderBy<QueryUserInstance> = { age: "desc", name: "asc" };
const genericOptions: HikouteiFindOptions = { limit: 10, offset: 0 };
const typedOptions: HikouteiFindOptions<QueryUserInstance> = { orderBy: validOrder, limit: 10 };
const findOneOptions: HikouteiFindOneOptions<QueryUserInstance> = { orderBy: { age: "desc" } };
const stringOperators: HikouteiOperatorFilter<string> = { gte: "A", like: "%a%" };

// @ts-expect-error boolean fields do not support range comparison.
const invalidBooleanRange: HikouteiFilter<QueryUserInstance> = { active: { gt: true } };
// @ts-expect-error number fields do not support LIKE.
const invalidNumberLike: HikouteiFilter<QueryUserInstance> = { age: { like: "1%" } };
// @ts-expect-error non-nullable fields do not accept null equality.
const invalidRequiredNull: HikouteiFilter<QueryUserInstance> = { name: { eq: null } };
// @ts-expect-error non-nullable sets cannot contain null.
const invalidRequiredSetNull: HikouteiFilter<QueryUserInstance> = { age: { in: [1, null] } };
// @ts-expect-error operator objects require at least one operator.
const invalidEmptyOperator: HikouteiFilter<QueryUserInstance> = { age: {} };
// @ts-expect-error only declared entity fields can be ordered.
const invalidOrderField: HikouteiOrderBy<QueryUserInstance> = { missing: "asc" };
// @ts-expect-error sort direction is a closed string union.
const invalidOrderDirection: HikouteiOrderBy<QueryUserInstance> = { age: "ascending" };
// @ts-expect-error findOne options intentionally have no paging.
const invalidFindOnePaging: HikouteiFindOneOptions<QueryUserInstance> = { limit: 1 };
// @ts-expect-error undefined is not a valid exact-optional filter operand.
const invalidUndefined: HikouteiFilter<QueryUserInstance> = { age: undefined };

void validFilter;
void genericOptions;
void typedOptions;
void findOneOptions;
void stringOperators;
void invalidBooleanRange;
void invalidNumberLike;
void invalidRequiredNull;
void invalidRequiredSetNull;
void invalidEmptyOperator;
void invalidOrderField;
void invalidOrderDirection;
void invalidFindOnePaging;
void invalidUndefined;

describe("Hikoutei rich-query public type contract", () => {
  it("keeps the inferred manager signatures usable", async () => {
    const runtime = await createTypedSheets({ dbName: ":memory:", entities: [QueryUser] });
    try {
      const em = runtime.em.fork();
      await em.find(QueryUser, validFilter, typedOptions);
      await em.findOne(QueryUser, { id: "missing" }, findOneOptions);
      await em.count(QueryUser, { active: true });
      await em.findAndCount(QueryUser, {}, genericOptions);
      expect(true).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
