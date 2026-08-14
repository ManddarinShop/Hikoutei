[English](README.md) | [日本語](README.ja.md)

<div align="center">

# Hikoutei

**SQLite로 앱은 빠르게, Google Sheets로 업무 흐름은 눈에 보이게.**

Google Sheets 기반 MVP를 위한 타입 안전 리포지토리이자 안전한 쓰기 계층:
애플리케이션은 타입이 지정된 엔티티로 로컬 SQLite를 읽고 쓰고, 커밋된 변경은
사람이 검토하고 가볍게 협업할 수 있도록 Google Sheets에 비동기로 투영됩니다.

<a href="https://www.npmjs.com/package/hikoutei">npm</a> ·
<a href="docs/quick-start.md">빠른 시작</a> ·
<a href="https://github.com/ManddarinShop/Hikoutei/issues">이슈</a>

[![npm version](https://img.shields.io/npm/v/hikoutei?style=flat-square)](https://www.npmjs.com/package/hikoutei)
[![license](https://img.shields.io/npm/l/hikoutei?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

## Hikoutei란 무엇인가?

Hikoutei는 TypeScript 애플리케이션에 로컬 SQLite를 기반으로 한 타입 지정
엔티티 API를 제공하고, 커밋된 변경을 Google Sheets에 비동기로 동기화합니다.

일반적인 읽기와 쓰기에서 애플리케이션은 Google Sheets를 기다리지 않습니다.
Sheets는 검토, 운영, 가벼운 협업을 위한 화면으로 남습니다.

> Hikoutei는 원시 Sheets API 래퍼가 아니며, PostgreSQL의 대체재도 아니고,
> Google Sheets를 권위 있는 애플리케이션 데이터베이스로 취급하지 않습니다.
> SQLite가 진실의 원천이고, Sheets는 사람을 위한 화면입니다.

## 빠른 시작

스칼라 엔티티를 정의하고 요청-로컬 매니저를 통해 로컬 SQLite authority를
사용합니다.

```ts
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
  },
});

const hikoutei = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
});

const em = hikoutei.em.fork();
const user = em.create(User, { id: "u1", name: "Ada" });
em.persist(user);
await em.flush();

user.name = "Ada Lovelace";
await em.flush();
```

**시트에는 무슨 일이 일어날까?** 쓰기는 즉시 로컬 SQLite에 커밋됩니다 —
애플리케이션 요청은 Google을 기다리지 않습니다. 동기화 서비스가 활성화되면
Hikoutei는 나중에 엔티티를 등록된 Google Sheet에 백그라운드로 투영합니다.
시트에서 이루어진 사람의 수정은 관찰되고 검증되어 SQLite로 수용되거나
충돌로 기록되며, 절대 조용히 덮어쓰이지 않습니다.

## Hikoutei를 쓰는 이유

- 시트 행을 수동으로 변환하는 대신 타입 지정 엔티티를 정의합니다.
- Google Sheets를 기다리지 않고 로컬 SQLite로 읽고 씁니다.
- 커밋된 변경을 Sheets에 백그라운드로 동기화합니다.
- 예상치 못한 컬럼 변경과 중복 헤더를 감지합니다.
- 충돌 중에 더 새로운 시트 수정을 덮어쓰지 않습니다.

## Hikoutei를 쓰기 좋은 때

Hikoutei는 다음 상황에 잘 맞습니다.

- 제품 워크플로의 일부로 스프레드시트가 있는 MVP와 프로토타입
- 내부 도구와 저트래픽 관리 애플리케이션
- 사람들이 Sheets를 쉽게 확인하면서 타입 지정된 애플리케이션 데이터를
  유지하려는 팀
- SQLite를 로컬에서 사용하고 비동기 시트 업데이트를 수용할 수 있는 서비스

## 다른 도구를 선택해야 할 때

다음이 필요하다면 일반 데이터베이스와 Google API를 직접 사용하세요.

- 여러 행이나 서비스에 걸친 강력한 트랜잭션
- 높은 쓰기 처리량 또는 많은 동시 작성자
- 복잡한 쿼리, 조인, 리포팅 워크로드
- 멀티 서버·멀티 리전 조정
- Google Sheets에서의 즉시 읽기-쓰기 일관성
- Google Sheets를 애플리케이션의 주 데이터베이스로 사용

## Hikoutei가 당신에게 맞는 추상화인가요?

Hikoutei는 `google-spreadsheet`나 `@googleapis/sheets`를 대체하지 않습니다 —
한 단계 위에 위치합니다. 원시 스프레드시트 접근만 필요하다면 API 클라이언트를
직접 사용하세요.

| 기능 | Hikoutei | google-spreadsheet | @googleapis/sheets |
| --- | :-: | :-: | :-: |
| 타입 지정 엔티티 모델 | ✅ | ❌ | ❌ |
| 빠른 로컬 애플리케이션 읽기 | ✅ | ❌ | ❌ |
| Sheets로의 비동기 투영 | ✅ | ❌ | ❌ |
| 내구성 있는 쓰기 재시도와 중복 제거 | ✅ | ❌ | ❌ |
| 충돌을 인지하는 시트 업데이트 | ✅ | ❌ | ❌ |
| 행·셀 직접 조작 | 제한적 | ✅ | ✅ |
| 전체 Google Sheets API 접근 | Provider 경유 | 부분적 | ✅ |

## Google Sheets 설정

Google Sheets 동기화는 서비스 측 관심사입니다. 애플리케이션은 provider
클라이언트를 import하거나, Sheet 라우트를 `createTypedSheets()`에 넘기거나,
쓰기마다 연산을 선택하지 않습니다 — 루트 API는 `dbName`과 `entities`만
받습니다. 동기화 런타임은 서비스 계정을 사용하는 하나의 내부 Google Sheets
API provider를 사용합니다 — Apps Script 배포가 없습니다. 동기화 자동 시작은
`HIKOUTEI_SYNC_SPREADSHEET_URL`과 `GOOGLE_APPLICATION_CREDENTIALS`로
선택되며, 설정할 공개 `googleSheetsApi` bootstrap 옵션은 없습니다.

### 환경 변수 기반 동기화 자동 시작

스프레드시트 URL을 환경 변수로 설정하면 `createTypedSheets()`가 내부적으로
Sheets 동기화를 시작합니다 — `flush()`는 설정 코드 없이 outbox worker를 통해
Google Sheets로 흘러갑니다:

```sh
HIKOUTEI_SYNC_SPREADSHEET_URL=https://docs.google.com/spreadsheets/d/<ID>/edit
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

```ts
const hikoutei = await createTypedSheets({ dbName: "./hikoutei.sqlite", entities: [User] });
```

`HIKOUTEI_SYNC_SPREADSHEET_URL`이 없으면 `createTypedSheets()`는 로컬 전용
(SQLite)으로 유지됩니다. 시작 실패는 명확한 메시지로 진단됩니다: 잘못된 URL,
없거나 잘못된 자격 증명 파일, 스프레드시트에 공유되지 않은 서비스 계정
(어떤 이메일을 공유해야 하는지 에러가 알려줍니다).

### 수동 서비스 계정 설정

1. **서비스 계정을 만듭니다.** Cloud 프로젝트에서 Google Sheets API를
   활성화하고, `https://www.googleapis.com/auth/spreadsheets` 스코프의
   서비스 계정을 만든 뒤 대상 스프레드시트를 해당 이메일에 **편집자(Editor)**로
   공유합니다. provider가 탭을 만들고, 효과 행과 receipt 기록을 쓰고, 행
   anchor를 관리하므로 뷰어 권한으로는 부족합니다.
2. **키를 서버 측에 둡니다.** 서비스 계정 키 경로를 서버의
   `GOOGLE_APPLICATION_CREDENTIALS`에, 스프레드시트 ID는 추적되지 않는
   비밀 저장소에 둡니다. 키를 브라우저 코드나 Git에 넣지 마세요.
3. **애플리케이션을 정상적으로 실행합니다.** `GOOGLE_APPLICATION_CREDENTIALS`와
   `HIKOUTEI_SYNC_SPREADSHEET_URL`을 설정한 상태로 앱을 시작하면
   `createTypedSheets()`가 이를 감지해 내부 sync bootstrap을 시작합니다 —
   등록된 탭의 헤더를 만들고 검증한 뒤 outbox 전달과 User_Input 폴링을
   시작합니다. 넘길 provider 옵션이나 직접 시작할 내부 bootstrap은 없습니다.

> **레거시 스프레드시트 참고.** 이전 Apps Script provider가 developer
> metadata 행 anchor로 프로비저닝한 스프레드시트는 마이그레이션되지
> 않습니다. `User_Input` 탭은 이제 `__hikoutei_row_id` 시스템 컬럼이
> 필요하므로 레거시 탭을 다시 프로비저닝해야 합니다.

Hikoutei는 내구성 있는 로컬 outbox, 멱등 전달, 충돌을 인지하는 업데이트를
사용하므로 일시적인 API 실패가 커밋된 애플리케이션 쓰기를 잃게 하지 않습니다.
provider는 자격 증명, 스프레드시트 ID, URL, 페이로드를 로그에 남기지 않으며,
Google 할당량 창 안에 머물도록 요청 시작 간격을 조절합니다. 상세 상태 머신과
복구 규칙은 [내부 정합성 모델](docs/internal-consistency-model.md)을
참고하세요.

라이브 Google 호출은 opt-in이며, 일반적인 검증 경로는 fake provider와 SQLite
fixture입니다. 자세한 설정과 문제 해결 단계는 [빠른 시작](docs/quick-start.md)을
참고하세요.

## 설치

프로젝트와 npm 패키지 이름은 모두 `hikoutei`입니다. 내장 SQLite provider는
현재 MikroORM을 필요로 합니다.

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

MikroORM은 구현 세부 사항이며 Hikoutei의 공개 엔티티 API에는 나타나지
않습니다.

## 문서

- [빠른 시작](docs/quick-start.md) — 설치, ORM 생명주기, 서비스 측 동기화 설정
- [아키텍처](docs/architecture.md) — 로컬 저장소와 Sheet 화면이 맞물리는 방식
- [쓰기 및 동기화 흐름](docs/write-and-synchronization-flow.md) — 비동기 전달과
  복구 동작
- [내부 정합성 모델](docs/internal-consistency-model.md) — 내구성 outbox,
  멱등 전달, 충돌을 인지하는 업데이트
- [개발](docs/development.md) — 로컬 개발 및 테스트 명령어
- [벤치마크 노트](docs/sync-bulk-write-benchmark.md) — 날짜가 기록된 측정과
  그 한계

## 한계

- Google Sheets에는 quota, 지연, API 요청 제한이 있습니다.
- 시트 업데이트는 비동기이며, 애플리케이션은 로컬 상태를 읽어야 합니다.
- SQLite는 서비스 로컬 전용이며 분산 조정 계층이 아닙니다.
- 스키마 변경, 수동 편집, 충돌 업데이트에는 여전히 애플리케이션의 운영 정책이
  필요합니다.

## 로컬 쿼리

읽기는 Hikoutei가 정의한 타입 연산자를 사용하며 항상 SQLite에서 실행됩니다.

```ts
const [users, total] = await em.findAndCount(
  User,
  {
    name: { like: "Ada%" },
    age: { gte: 18, lt: 65 },
    active: { in: [true] },
  },
  {
    orderBy: { age: "desc", name: "asc" },
    limit: 20,
    offset: 0,
  },
);
```

`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`은 선언된 스칼라 타입에
허용되는 범위에서 사용할 수 있고, `like`는 문자열 전용입니다. `{ active: true }`
같은 동등 조건 축약도 계속 지원합니다. `count()`는 페이지네이션 전 필터 전체 개수를
반환하고, `findAndCount()`는 한 SQLite 스냅샷에서 페이지와 전체 개수를 읽습니다.
명시적 정렬에는 마지막 동률 해소 기준으로 PK가 추가되며, `orderBy` 없는
페이지네이션은 PK 오름차순을 사용합니다.

## 프로젝트 상태

Hikoutei는 활발히 개발 중입니다. 현재 EntityManager는 스칼라 엔티티 생명주기,
타입 로컬 필터와 정렬, `limit` / `offset` 페이지네이션, `count()`, 스냅샷이
일관된 `findAndCount()`, 콜백형 `transactional()`을 지원합니다. 일반 읽기는
Google Sheets가 아니라 항상 SQLite에서 수행됩니다. 시트 편집 수집과 충돌 표시는
아직 발전 중입니다. 마이너 버전 업그레이드 전에 릴리스 노트를 확인하세요.

## 로드맵

첫 EntityManager 단계인 풍부한 로컬 읽기는 완료됐습니다. 남은 단계는 아래 구현
순서를 따르며, 일정이나 릴리스 번호는 약속하지 않습니다.

1. **생명주기 안전 쓰기**
   - `upsert`와 direct/bulk mutation 기능은 엔티티 테이블, canonical state,
     내구성 있는 Sheet effect outbox를 하나의 SQLite 트랜잭션에서 처리하는
     Hikoutei 정의 계약을 통해서만 추가합니다.
   - 이 원자적 생명주기를 우회할 수 있는 원시 `nativeInsert`, `nativeUpdate`,
     `nativeDelete` 또는 SQL 패스스루 API는 약속하지 않습니다.
2. **관계와 로딩**
   - many-to-one, one-to-many, `populate()` 기능을 추가합니다.
   - 공개 전에 관계의 SQLite 매핑, Sheets 프로젝션 표현, 스키마 동작, 충돌
     의미론을 함께 설계합니다.
3. **스키마 운영**
   - 마이그레이션과 스키마 드리프트 관리를 추가합니다.
   - 검증 및 운영 흐름을 기존 설정 도구와 통합합니다.

### 동기화 및 운영

다음 작업은 EntityManager 단계와 병행합니다.

- Google Sheets에서 의도적인 사용자 편집 수집 완성
- 업데이트·삭제 충돌 처리와 표시 개선

현재 작업은 [오픈 이슈](https://github.com/ManddarinShop/Hikoutei/issues)를
참고하세요.

## 라이선스

Hikoutei는 [MIT 라이선스](LICENSE)로 배포됩니다.
