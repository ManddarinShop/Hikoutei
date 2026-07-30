# SQL Layer Plan

## Positioning

The SQL layer should sit above the existing repository/core layer.

It should not turn Google Sheets into a general database. The goal is a small, predictable SQL subset for MVPs, internal tools, and low-traffic admin workflows.

## Initial SQL Subset

Candidate first subset:

```sql
SELECT * FROM Users;
SELECT * FROM Users WHERE id = ?;
INSERT INTO Users (id, email, active, _version) VALUES (?, ?, ?, ?);
UPDATE Users SET active = ? WHERE id = ?;
```

## Required Constraints

- One sheet tab maps to one table.
- Table schema still comes from typed column definitions.
- Header drift still fails.
- `_version` optimistic locking remains the write-safety mechanism.
- SQL parsing should call repository operations instead of bypassing them.

## Out of Scope for the First SQL Version

- Joins.
- Transactions.
- Multi-row atomic writes.
- Aggregations.
- Nested queries.
- Arbitrary expressions.
- Cross-spreadsheet queries.

## Implementation Direction

The SQL layer should be a separate package or module above core:

```txt
sql query
  -> parser
  -> typed table registry
  -> repository operation
  -> adapter
  -> Google Sheets API
```

This keeps schema drift detection, parsing, duplicate key checks, and optimistic locking in one place.

## 한국어

SQL layer는 현재 repository/core layer 위에 올라가는 구조가 맞습니다.

목표는 Google Sheets를 범용 DB로 만드는 것이 아니라, MVP/internal tool/low-traffic admin을 위한 작고 예측 가능한 SQL subset을 제공하는 것입니다.

초기 SQL은 `SELECT`, key 기반 `WHERE`, `INSERT`, 단순 `UPDATE` 정도로 제한하는 것이 좋습니다. Join, transaction, multi-row atomic write는 후순위입니다.
