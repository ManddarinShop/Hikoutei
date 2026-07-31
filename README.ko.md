[English](README.md) | [日本語](README.ja.md)

<div align="center">

# Hikoutei

**Google Sheets 기반 MVP를 위한 타입 안전 리포지토리 및 안전한 쓰기 계층**

<a href="https://www.npmjs.com/package/hikoutei">npm 패키지</a> ·
<a href="https://github.com/ManddarinShop/Hikoutei/issues">이슈</a> ·
<a href="apps-script/gateway/Code.gs">Apps Script Gateway</a>

[![npm version](https://img.shields.io/npm/v/hikoutei?style=flat-square)](https://www.npmjs.com/package/hikoutei)
[![license](https://img.shields.io/npm/l/hikoutei?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

Hikoutei는 TypeScript와 Node.js 애플리케이션에서 Google Sheets를 MVP 또는
내부 업무 흐름의 사람이 읽기 쉬운 화면으로 사용할 수 있게 합니다. 애플리케이션은
타입이 지정된 엔티티와 로컬 SQLite를 사용하고, 포함된 Apps Script Gateway를
통해 변경 내용을 Google Sheets에 비동기적으로 전달할 수 있습니다.

Hikoutei의 범위는 의도적으로 작습니다. 범용 데이터베이스 대체재, Prisma/JPA
클론, 범용 Google Sheets API 래퍼를 목표로 하지 않습니다.

## Hikoutei가 제공하는 것

- 엔티티 중심 생명주기: 생성, 조회, 변경, `persist`, `remove`, `flush`.
- Sheet 데이터에 대한 타입 필드 매핑과 런타임 검증.
- 원격 스프레드시트 요청을 기다리지 않는 로컬 SQLite 조회.
- 사람이 검토하고 가볍게 협업할 수 있는 비동기 Google Sheets 뷰.
- 예상하지 못한 스키마 변경과 최신 데이터를 덮어쓰는 문제에 대한 보호.

## 설치

프로젝트와 npm 패키지 이름은 모두 `hikoutei`입니다.

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

MikroORM 패키지는 루트 패키지의 선택적 peer dependency입니다. 현재 기본
SQLite provider가 내부적으로 사용하지만 루트 public API에는 MikroORM 타입이
노출되지 않습니다.

## 빠른 시작

엔티티 정의와 환경별 Sheet route를 분리하고 루트 API만 사용합니다.

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
  sheets: {
    spreadsheetId: process.env.SHEET_ID!,
    routes: {
      User: {
        systemState: { tabName: "Users_System", registeredRange: "A:Z" },
      },
    },
  },
});

const em = hikoutei.em.fork();
const user = em.create(User, { id: "u1", name: "Ada" });
em.persist(user);
await em.flush();

user.name = "Ada Lovelace";
await em.flush();
```

`createTypedSheets()`는 SQLite와 로컬 canonical/outbox만 준비합니다. 원격
탭과 헤더 provisioning은 `hikoutei.setupSheets(provisioner)`를 명시적으로
호출해야 합니다. `flush()`가 성공하면 SQLite 변경과 durable outbox가
커밋되며 원격 Sheet 전달은 별도 worker가 비동기로 수행합니다.

## Hikoutei를 사용하기 좋은 경우

- 스프레드시트가 제품 업무 흐름의 일부인 MVP와 프로토타입.
- 내부 도구와 저트래픽 관리 애플리케이션.
- 타입이 지정된 애플리케이션 데이터를 유지하면서 사람이 Sheets를 쉽게
  확인해야 하는 팀.
- 로컬 SQLite를 사용할 수 있고 Sheets의 비동기 업데이트를 허용할 수 있는
  서비스.

## 다른 도구를 선택해야 하는 경우

다음 요구사항이 있다면 일반적인 데이터베이스와 직접적인 Google API 사용을
검토하세요.

- 여러 행 또는 여러 서비스에 걸친 강한 트랜잭션.
- 높은 쓰기 처리량 또는 많은 동시 작성자.
- 복잡한 쿼리, 조인, 리포팅 작업.
- 멀티 서버 또는 멀티 리전 조정.
- Google Sheets에서 즉시 쓰기 후 읽기 일관성이 필요한 경우.
- 애플리케이션의 기본 데이터베이스로 Google Sheets를 사용해야 하는 경우.

## Google Sheets 설정

1. `createTypedSheets()`에서 scalar entity와 환경별 Sheet route를 정의합니다.
2. [빠른 시작](docs/quick-start.md#sheet-setup-and-delivery)을 따라
   [`apps-script/gateway/Code.gs`](apps-script/gateway/Code.gs)를 대상
   Spreadsheet에 bound된 Apps Script 프로젝트에 복사하고 Web App으로
   배포한 뒤 `/exec` URL을 입력하고 `setupSyncGateway()`를 실행합니다.
3. 생성된 `TYPED_SHEETS_GATEWAY_URL`,
   `TYPED_SHEETS_GATEWAY_SHARED_SECRET`,
   `TYPED_SHEETS_GATEWAY_SHEET_ID`를 추적하지 않는 서버 환경 파일이나
   secret store에 보관합니다. shared secret은 브라우저 코드나 Git에 넣지
   마세요.
4. `hikoutei.setupSheets(provisioner)`를 명시적으로 호출해 등록된 탭과
   헤더를 provisioning한 뒤, 대기 중인 outbox effect를 전달하는 sync worker를
   실행합니다.

외부 서버에서 접근하려면 Web App의 액세스 범위가 서버를 허용해야 하며,
일반적으로 **Anyone** 설정이 필요합니다. 편집기 전용 `/dev`가 아니라 배포용
`/exec` URL을 사용하세요. `Code.gs`를 변경하면 Web App deployment를 새
버전으로 갱신해야 합니다. 상세한 설정과 문제 해결 방법은
[빠른 시작](docs/quick-start.md)에 설명되어 있습니다.

## 문서

- [빠른 시작](docs/quick-start.md) — 설치, 매핑, Gateway 설정.
- [아키텍처](docs/architecture.md) — 로컬 저장소와 Sheet 화면의 관계.
- [쓰기 및 동기화 흐름](docs/write-and-synchronization-flow.md) — 비동기 전달과
  복구 동작.
- [개발 가이드](docs/development.md) — 로컬 개발 및 테스트 명령.
- [벤치마크 기록](docs/sync-bulk-write-benchmark.md) — 날짜별 측정 결과와
  한계.

## 제한사항

- Google Sheets에는 quota, 지연 시간, Apps Script 실행 시간 제한이 있습니다.
- Sheet 업데이트는 비동기이므로 애플리케이션은 로컬 상태를 읽어야 합니다.
- SQLite는 서비스에 로컬이며 분산 조정 계층이 아닙니다.
- 스키마 변경, 수동 편집, 충돌하는 변경에 대한 운영 정책은 애플리케이션이
  별도로 정해야 합니다.

## 로드맵

- Google Sheets에서 의도적인 사용자 편집을 수집하는 기능 완성.
- update/delete 충돌 처리와 표시 개선.
- 레지스트리 및 Apps Script 배포를 위한 설정 도구 추가.
- 공개 패키지 릴리스 안정화.

현재 작업은 [open issues](https://github.com/ManddarinShop/Hikoutei/issues)
에서 확인할 수 있습니다.

## 라이선스

Hikoutei는 [MIT License](LICENSE)로 배포됩니다.
