# typed-sheets Plan

## 1. Project Positioning

`typed-sheets`는 Google Sheets를 초기 MVP, 내부 운영툴, 저트래픽 어드민, 프로토타입의 lightweight database처럼 사용할 때 필요한 TypeScript repository layer다.

핵심 포지션은 다음이다.

> Typed repository and safe write layer for Google Sheets-backed MVPs.

이 프로젝트는 Google Sheets를 MySQL/Postgres 대체재로 주장하지 않는다. 또한 `google-spreadsheet`나 `@googleapis/sheets` 같은 API client를 대체하려는 것도 아니다.

핵심 차별점은 Google Sheets를 DB처럼 쓸 때 조용히 깨지는 상태를 성공으로 처리하지 않는 것이다.

- Sheet header와 TypeScript schema의 drift 감지
- row 데이터를 typed object로 변환
- key column 기반 repository API 제공
- `_version` column 기반 optimistic locking
- Google Sheets API quota를 고려한 확장 가능한 구조
- 향후 Apps Script `LockService` write gateway 확장 가능성

## 2. Existing Ecosystem Comparison

### `google-spreadsheet`

- Google Sheets API를 편하게 다루기 위한 wrapper다.
- row/cell 조작은 편하지만 repository abstraction은 아니다.
- schema drift, key uniqueness, optimistic locking을 라이브러리의 중심 책임으로 보지 않는다.

`typed-sheets`에서는 이 라이브러리를 내부 adapter 구현체로 사용할 수 있다.

### `@googleapis/sheets`

- Google 공식 Sheets API client다.
- 저수준 API 호출, 인증, range read/write에 적합하다.
- typed repository, schema validation, stale write protection은 직접 구현해야 한다.

`typed-sheets`에서는 production adapter의 가장 보수적인 기반이 될 수 있다.

### `spreadsheet-orm`

- Google Spreadsheet를 ORM처럼 다루려는 비교적 가까운 시도다.
- query builder, schema management 등 ORM 방향의 기능을 포함한다.
- `typed-sheets`는 더 좁게 가는 것이 좋다.

`typed-sheets`의 MVP는 ORM 전체가 아니라 다음만 강하게 잡는다.

- header drift detection
- typed row parsing
- key-based repository
- `_version` optimistic locking

## 3. MVP API Review

제안된 MVP API는 크지 않다. 오히려 프로젝트의 차별점을 증명하기에 적절한 최소 범위다.

초기 API:

```ts
import { createSheetRepository, text, number, boolean } from "typed-sheets";

const users = createSheetRepository({
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

await users.assertSchema();

const all = await users.findAll();
const user = await users.findById("u1");

await users.insert({
  id: "u1",
  email: "a@test.com",
  age: 20,
  active: true,
  _version: 1,
});

await users.update("u1", current => ({
  ...current,
  age: current.age + 1,
}));
```

단, 실제 구현에서는 `createSheetRepository`에 adapter를 명시적으로 주입하는 형태가 더 좋다.

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

이렇게 하면 core repository logic을 Google API, OAuth, network와 분리해 fake adapter로 테스트할 수 있다.

## 4. MVP Scope

MVP에 포함할 기능:

- schema definition API
- header 검증
- 필수 column 누락 감지
- 중복 header 감지
- key column 누락 감지
- row parsing
- string, number, boolean parser
- optional column
- `findAll`
- `findById`
- `insert`
- `update`
- `_version` 기반 optimistic locking
- `SchemaDriftError`
- `ConflictError`
- `ParseError`
- fake adapter 기반 테스트

MVP에서 제외할 기능:

- relation / join
- lazy loading
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

## 5. Google Sheets를 DB처럼 쓸 때의 한계

Google Sheets는 spreadsheet이지 database가 아니다. 따라서 다음 한계를 명확히 문서화해야 한다.

- storage layer에 primary key / unique constraint가 없다.
- multi-row transaction이 없다.
- 여러 사용자가 동시에 수정할 때 lost update가 발생할 수 있다.
- 비개발자가 header를 변경하거나 삭제할 수 있다.
- 값 타입이 느슨해서 string, number, boolean, date가 섞일 수 있다.
- formula, formatted value, raw value가 다를 수 있다.
- 전체 row scan이 커질수록 느려지고 quota를 많이 쓴다.
- Google Sheets API quota와 timeout에 영향을 받는다.
- Google OAuth, service account, 공유 권한 설정이 운영 변수가 된다.
- Apps Script를 붙이면 OAuth 승인, Workspace 정책, script quota, 배포 문제가 추가된다.

따라서 이 프로젝트는 다음 사용처에만 적합하다고 명확히 제한해야 한다.

- 초기 MVP
- 내부 운영툴
- 저트래픽 어드민
- 비개발자가 직접 수정하는 운영 데이터
- 프로토타입

## 6. Domain / Application / Adapter 분리 구조

권장 구조:

```txt
src/
  index.ts
  domain/                       # 정규화, 평가, 충돌, 상태 규칙
  shared/                       # 공통 상수·인코딩·상태 계약
  application/
    orm/                        # 사용자 ORM facade와 mapping/flush
    sync/                       # gateway, worker, reconciliation
  adapter/                      # persistence와 Sheets provider 계약/구현
  infrastructure/
    storage/                    # SQLite schema, canonical state, outbox
```

### Domain 책임

`domain`은 Google API와 SQLite 구현을 몰라야 한다.

책임:

- schema definition 해석
- header validation
- duplicate header detection
- required column validation
- key column validation
- row parsing
- duplicate key detection
- repository method 구현
- `_version` optimistic locking
- typed error throw

### Application 책임

application은 domain 규칙과 adapter/infrastructure를 조율한다.

책임:

- ORM entity lifecycle과 flush 계획
- effect worker와 reconciliation 실행
- Apps Script gateway operation 조합

### Adapter 책임

adapter는 Google Sheets와 통신하는 부분만 담당한다.

책임:

- 인증
- spreadsheet 접근
- sheet 조회
- range read/write
- append row
- update row
- batch API 사용 여부
- retry/backoff
- cache/request collapse
- Apps Script gateway 호출

초기 adapter port 예시:

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

`rowNumber`는 Google Sheet 기준 1-based row number로 둔다. header가 1행이므로 data row는 2행부터 시작한다.

## 7. Optimistic Locking 설계

`_version` column은 MVP에서 필수로 두는 것이 좋다.

기본 흐름:

1. `update(id, updater)` 호출
2. sheet를 읽는다.
3. key column으로 row를 찾는다.
4. 현재 `_version`을 기억한다.
5. updater를 적용한다.
6. write 직전 같은 row를 다시 읽거나 adapter-level compare-and-set을 수행한다.
7. version이 바뀌었으면 `ConflictError`를 던진다.
8. version이 같으면 `_version + 1`로 write한다.

MVP fake adapter에서는 read-between-write 시나리오를 테스트할 수 있게 만들어 stale write를 증명한다.

실제 Google Sheets API만으로는 완전한 atomic compare-and-set이 어렵다. 따라서 MVP에서는 stale write risk를 줄이는 repository-level fencing으로 시작하고, 2차 확장에서 Apps Script `LockService` 기반 serialized write gateway로 강화한다.

## 8. Error 설계

### `SchemaDriftError`

다음 상황에서 발생:

- header 중복
- required column 누락
- key column 누락
- `_version` column 누락
- duplicate key 발견

### `ParseError`

다음 상황에서 발생:

- required value가 비어 있음
- number parser 실패
- boolean parser 실패
- `_version` 값이 number가 아님

### `ConflictError`

다음 상황에서 발생:

- update 중 `_version`이 변경됨
- stale row write가 감지됨

## 9. Test Scenarios

테스트는 실제 Google API 없이 fake adapter로 먼저 작성한다.

### Schema tests

- `assertSchema`는 모든 column이 있으면 성공한다.
- required column이 없으면 `SchemaDriftError`를 던진다.
- key column이 없으면 `SchemaDriftError`를 던진다.
- `_version` column이 없으면 `SchemaDriftError`를 던진다.
- duplicate header가 있으면 `SchemaDriftError`를 던진다.

### Parsing tests

- text column을 string으로 파싱한다.
- number column을 number로 파싱한다.
- boolean column을 boolean으로 파싱한다.
- optional column은 empty value를 `undefined`로 파싱한다.
- required column이 비어 있으면 `ParseError`를 던진다.
- number 변환에 실패하면 `ParseError`를 던진다.
- boolean 변환에 실패하면 `ParseError`를 던진다.

### Repository read tests

- `findAll`은 typed object 배열을 반환한다.
- `findById`는 key가 일치하는 row를 반환한다.
- `findById`는 없으면 `null`을 반환한다.
- duplicate key가 있으면 `SchemaDriftError`를 던진다.

### Insert tests

- `insert`는 header 순서대로 row를 append한다.
- duplicate key insert는 `SchemaDriftError` 또는 별도 duplicate key error를 던진다.
- insert row parse/serialization 실패를 테스트한다.

### Update tests

- `update`는 현재 row를 updater에 넘긴다.
- `update`는 `_version`을 1 증가시킨다.
- `update`는 header 순서대로 row를 write한다.
- target row가 없으면 `null`을 반환한다.
- write 전 version이 바뀌면 `ConflictError`를 던진다.

## 10. Implementation Order

권장 구현 순서:

1. `package.json`, `tsconfig`, test runner 설정
2. `SheetAdapter` interface 정의
3. error class 정의
4. column schema primitive 구현
5. schema validation 구현
6. row parsing 구현
7. `findAll`, `findById` 구현
8. `insert` 구현
9. `_version` 기반 `update` 구현
10. fake adapter 테스트 작성
11. README 정리
12. 실제 Google Sheets adapter는 MVP core 검증 후 별도 단계로 진행

## 11. Expected MVP Size

목표 규모:

- production TypeScript: 500~900 lines
- tests: 700~1,200 lines
- README/docs/config: 400~700 lines
- total MVP: 1,500~2,800 lines

핵심은 기능 수가 아니라 다음을 테스트로 증명하는 것이다.

- schema drift를 조용히 통과시키지 않는다.
- parse failure를 조용히 통과시키지 않는다.
- duplicate key를 조용히 통과시키지 않는다.
- stale write를 조용히 통과시키지 않는다.

## 12. Later Extensions

MVP 이후 후보:

1. read cache / request collapse
2. timeout / retry / exponential backoff
3. `@googleapis/sheets` adapter
4. `google-spreadsheet` adapter
5. Apps Script 자동 설치 CLI
6. Apps Script `LockService` 기반 serialized write gateway
7. schema drift report
8. GitHub Action
9. Google Sheet template generator
10. `_createdAt`, `_updatedAt` system columns
11. soft delete
12. audit log sheet

## 13. Apps Script 방향

향후 CLI 예시:

```sh
npx typed-sheets init --spreadsheet-id xxx
```

목표:

- Google OAuth 로그인
- 대상 spreadsheet 확인
- bound Apps Script project 생성
- Apps Script 코드 업로드
- `LockService` 기반 write function 설치
- 설치 검증

가능한 공식 API 흐름:

- `projects.create`
- `projects.updateContent`
- spreadsheet file id를 parent로 사용해 bound script 생성
- 필요한 경우 installable trigger 생성

MVP에는 포함하지 않는다. OAuth, Workspace 정책, 권한 승인, Apps Script API 활성화 문제 때문에 core 안정성을 먼저 증명한 뒤 진행한다.
