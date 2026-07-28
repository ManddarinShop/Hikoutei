# typed-sheets MVP Scope - 2026-06-29

## MVP Goal

`typed-sheets`의 MVP는 Google Sheets를 범용 DB처럼 만드는 것이 아니다.

MVP의 목표는 다음 한 문장으로 제한한다.

> Google Sheets-backed MVP에서 schema drift, parse failure, duplicate key, stale write를 조용히 성공 처리하지 않는 typed repository layer를 만든다.

즉, 처음 버전은 기능이 많은 ORM이 아니라 "운영 중 깨질 수 있는 상태를 실패로 드러내는 최소 repository"여야 한다.

## MVP에 반드시 포함할 것

### 1. Domain / Application / Adapter 분리

MVP부터 domain, application, adapter를 분리한다.

Domain은 Google API와 SQLite 구현을 몰라야 한다. 테스트는 fake adapter로
먼저 작성한다.

초기 adapter port:

```ts
export type SheetCell = string | number | boolean | null;

export interface SheetSnapshot {
  headers: string[];
  rows: SheetCell[][];
}

export interface SheetAdapter {
  readSheet(sheetName: string): Promise<SheetSnapshot>;
  appendRow(sheetName: string, row: SheetCell[]): Promise<void>;
  updateRow(sheetName: string, rowNumber: number, row: SheetCell[]): Promise<void>;
}
```

### 2. Schema Definition API

포함:

- `text()`
- `number()`
- `boolean()`
- `.optional()`

MVP에서는 date, enum, array, object, custom parser는 제외한다.

예상 API:

```ts
const users = createSheetRepository({
  adapter,
  sheetName: "Users",
  key: "id",
  columns: {
    id: text(),
    email: text(),
    age: number().optional(),
    active: boolean(),
    _version: number(),
  },
});
```

### 3. Schema Drift Detection

`assertSchema()`에서 반드시 검증한다.

- required column 누락
- key column 누락
- `_version` column 누락
- duplicate header

MVP에서는 extra column은 허용하는 쪽이 낫다. 비개발자가 sheet에 메모용 column을 추가할 수 있기 때문이다.

단, extra column을 무시한다는 정책은 README에 명확히 적는다.

### 4. Row Parsing

포함:

- text parsing
- number parsing
- boolean parsing
- optional empty value handling
- required empty value failure

실패 시 `ParseError`를 던진다.

MVP에서는 Google Sheets의 formatted value/raw value 차이는 adapter 책임으로 미룬다. core는 adapter가 준 cell value만 파싱한다.

### 5. Repository Read API

포함:

- `findAll()`
- `findById(id)`

검증:

- row를 typed object로 반환
- duplicate key 발견 시 실패
- parse 실패 시 실패

MVP에서는 filter, sort, pagination, query builder는 제외한다.

### 6. Insert API

포함:

- `insert(row)`

검증:

- schema에 맞는 row만 insert
- duplicate key면 실패
- header 순서대로 cell serialize

MVP에서 insert의 `_version` 정책은 단순하게 간다.

- 사용자가 `_version`을 명시하면 그대로 검증
- 문서에서는 최초 insert 시 `_version: 1` 사용을 권장

자동 `_version` 주입은 2차로 미룬다. MVP API를 작게 유지하기 위해서다.

### 7. Update API

포함:

- `update(id, updater)`

동작:

1. 현재 sheet를 읽는다.
2. key로 row를 찾는다.
3. 현재 row를 parse한다.
4. updater를 적용한다.
5. write 직전 sheet를 다시 읽어 `_version`이 그대로인지 확인한다.
6. `_version`이 바뀌었으면 `ConflictError`를 던진다.
7. 같으면 `_version + 1`로 update한다.

MVP에서 이 방식은 완전한 atomic compare-and-set은 아니다. 하지만 stale write를 조용히 성공 처리하지 않는 core 정책을 테스트로 증명할 수 있다.

완전한 직렬화는 Apps Script `LockService` gateway 단계에서 다룬다.

### 8. Error Types

포함:

- `SchemaDriftError`
- `ParseError`
- `ConflictError`

추가로 필요하면 내부적으로 `TypedSheetsError` base class를 둘 수 있다.

MVP에서는 error 종류를 더 늘리지 않는다.

## MVP에서 제외할 것

다음은 처음 구현하지 않는다.

- relation / join
- SQL-like query language
- migration engine
- transaction manager
- multi-row atomic transaction
- Apps Script 자동 설치
- Apps Script Web App gateway
- cache
- request collapse
- retry/backoff
- browser support
- dashboard UI
- date parser
- enum parser
- custom parser
- soft delete
- audit log
- `_createdAt`, `_updatedAt`
- Google Sheet template generator
- GitHub Action

## 애매하지만 MVP에서 빼는 것이 좋은 것

### Cache / Request Collapse

프로젝트 차별점과 연결되지만 MVP에서는 빼는 것이 낫다.

이유:

- schema drift와 stale write 검증이 먼저다.
- cache가 들어가면 테스트 surface가 커진다.
- stale data와 optimistic locking 설명이 복잡해진다.

문서에는 확장 방향으로만 둔다.

### Retry / Backoff

quota 관점에서 중요하지만 MVP에서는 빼는 것이 낫다.

이유:

- adapter concern이다.
- fake adapter 기반 core 테스트와 직접 관련이 없다.
- 실제 Google adapter를 만들 때 넣는 편이 자연스럽다.

### Apps Script Gateway

장기적으로 중요하지만 MVP에는 넣지 않는다.

이유:

- OAuth, Workspace 정책, Apps Script API 활성화가 필요하다.
- 설치/권한 문제가 core repository 검증보다 크다.
- MVP의 핵심 메시지를 흐린다.

## MVP Success Criteria

MVP가 성공했다고 볼 기준:

1. fake adapter만으로 전체 core 테스트가 통과한다.
2. header가 깨지면 `SchemaDriftError`가 난다.
3. row 값이 잘못되면 `ParseError`가 난다.
4. duplicate key가 있으면 실패한다.
5. update 중 version이 바뀌면 `ConflictError`가 난다.
6. `findAll`, `findById`, `insert`, `update`가 typed API로 동작한다.
7. README에서 Google Sheets의 한계를 명확히 말한다.

## Recommended MVP File Structure

```txt
src/
  index.ts
  adapter.ts
  columns.ts
  errors.ts
  repository.ts

test/
  fake-adapter.ts
  schema.test.ts
  parsing.test.ts
  repository-read.test.ts
  insert.test.ts
  update.test.ts
```

## Recommended Package Split

처음부터 monorepo로 너무 잘게 나누는 것은 피한다. MVP에서는 core 안정성을 증명하는 것이 우선이므로, 패키지는 "지금 필요한 분리"와 "나중에 필요한 분리"를 나눠서 가져간다.

### MVP 패키지 구성

MVP에서는 단일 npm package로 시작한다.

```txt
typed-sheets/
  src/
    core/
      adapter.ts
      columns.ts
      errors.ts
      repository.ts
      schema.ts
      serialization.ts
    testing/
      fake-adapter.ts
    index.ts
  test/
```

배포 package는 하나다.

```txt
typed-sheets
```

외부 사용자는 하나의 entrypoint만 쓴다.

```ts
import {
  createSheetRepository,
  text,
  number,
  boolean,
  SchemaDriftError,
  ConflictError,
  ParseError,
} from "typed-sheets";
```

이 단계에서 `@typed-sheets/core`, `@typed-sheets/google`, `@typed-sheets/testing`처럼 나누지 않는다.

이유:

- MVP는 아직 public API가 고정되지 않았다.
- adapter가 fake adapter뿐이면 package 분리가 오히려 비용이다.
- multi-package build, versioning, release 관리가 MVP 속도를 늦춘다.
- core와 adapter의 경계는 폴더와 interface로도 충분히 검증할 수 있다.

### MVP 내부 module 경계

단일 package 안에서 module 경계는 명확히 둔다.

```txt
src/domain/
src/application/
src/adapter/
src/infrastructure/
```

domain에는 순수 규칙을, application에는 ORM과 동기화 흐름을, adapter에는
외부 provider 계약과 구현을, infrastructure에는 SQLite 저장을 둔다.

- schema validation
- row parsing
- serialization
- duplicate key detection
- optimistic locking
- error types

테스트용 fake adapter는 `test/support/`에 둔다.

- in-memory sheet snapshot
- append row 기록
- update row 기록
- conflict simulation helper

fake adapter는 public package surface에 포함하지 않는다.

### 2차 패키지 구성

실제 Google adapter가 들어가는 시점에 package 분리를 검토한다.

권장 monorepo 구조:

```txt
packages/
  core/
    src/
  googleapis-adapter/
    src/
  google-spreadsheet-adapter/
    src/
  testing/
    src/
  cli/
    src/
```

각 패키지 역할:

```txt
@typed-sheets/core
```

순수 repository core.

- Google API dependency 없음
- runtime dependency 최소화
- fake adapter로 대부분 테스트 가능

```txt
@typed-sheets/googleapis-adapter
```

`@googleapis/sheets` 기반 adapter.

- service account / OAuth auth 처리
- range read/write
- batch API
- retry/backoff 후보

```txt
@typed-sheets/google-spreadsheet-adapter
```

`google-spreadsheet` 기반 adapter.

- 더 사용하기 쉬운 wrapper adapter
- 빠른 adoption에 유리

```txt
@typed-sheets/testing
```

사용자 adapter 검증용 test utilities.

- fake adapter
- adapter contract tests
- conflict simulation

```txt
@typed-sheets/cli
```

나중에 Apps Script 설치, template 생성, schema check CLI를 담당.

- `typed-sheets init`
- `typed-sheets check`
- `typed-sheets generate-template`

### 언제 패키지를 나눌지

패키지 분리 기준은 기능 기준이 아니라 dependency boundary 기준으로 잡는다.

나눌 시점:

- Google API dependency가 core에 들어오려고 할 때
- adapter별 dependency가 무거워질 때
- CLI가 OAuth, file system, Apps Script API dependency를 요구할 때
- 사용자가 core만 설치하고 싶다는 니즈가 생길 때
- adapter contract test를 외부에 제공해야 할 때

아직 나누지 말아야 할 시점:

- fake adapter만 있는 MVP
- repository API가 바뀔 가능성이 큰 단계
- README와 테스트로 project shape를 검증하는 단계

## Recommended Import Strategy

MVP에서는 top-level export를 작게 유지한다.

```ts
export {
  createSheetRepository,
  text,
  number,
  boolean,
  SchemaDriftError,
  ConflictError,
  ParseError,
};
```

adapter type은 public으로 export한다.

```ts
export type {
  SheetAdapter,
  SheetSnapshot,
  SheetCell,
};
```

단, internal helper는 export하지 않는다.

- header normalization helper
- row parser internals
- serialization internals
- duplicate key scanner

이렇게 해야 나중에 내부 구현을 바꿔도 public API compatibility를 지킬 수 있다.

## Implementation Order

1. package setup
2. adapter interface
3. error classes
4. column primitives
5. schema validation
6. row parser
7. `findAll`
8. `findById`
9. `insert`
10. `update`
11. fake adapter tests
12. README cleanup

## MVP Line Budget

목표:

- production TypeScript: 500~900 lines
- tests: 700~1,200 lines
- docs/config: 400~700 lines
- total: 1,500~2,800 lines

기능을 많이 넣는 것보다 실패 조건을 테스트로 증명하는 것이 우선이다.

## Final MVP Boundary

MVP는 여기까지다.

> Fake adapter 기반으로 schema drift, parse failure, duplicate key, stale update를 검출하는 typed repository core.

실제 Google Sheets adapter는 MVP core가 안정화된 다음 단계로 잡는다.
