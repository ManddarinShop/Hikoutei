import { describe, expect, it } from "vitest";

import { fromSqlNullable } from "@hikoutei/contracts/storage/sql.js";
import { PRESENCE_KINDS } from "@hikoutei/contracts/state/constants.js";
import { fromSqlNullable as fromStorageSqlNullable } from "@hikoutei/storage/storage/sqlite/sqlState.js";

describe("SQL nullable state contract", () => {
  it("distinguishes SQL null from falsy values", () => {
    expect(fromSqlNullable(null)).toEqual({ kind: PRESENCE_KINDS.ABSENT });
    expect(fromSqlNullable(0)).toEqual({ kind: PRESENCE_KINDS.PRESENT, value: 0 });
  });

  it("preserves the storage compatibility re-export", () => {
    expect(fromStorageSqlNullable).toBe(fromSqlNullable);
  });
});
