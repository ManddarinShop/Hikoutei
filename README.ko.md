[English](README.md) | [日本語](README.ja.md)

<div align="center">

# Hikoutei

**Google Sheets 기반 MVP를 위한 타입 안전 리포지토리 및 안전한 쓰기 계층**

<a href="https://www.npmjs.com/package/typed-sheets">npm 패키지</a> ·
<a href="https://github.com/ManddarinShop/google-sheets-orm/issues">이슈</a> ·
<a href="apps-script/gateway/Code.gs">Apps Script Gateway</a>

[![npm version](https://img.shields.io/npm/v/typed-sheets?style=flat-square)](https://www.npmjs.com/package/typed-sheets)
[![license](https://img.shields.io/npm/l/typed-sheets?style=flat-square)](LICENSE)
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

프로젝트 이름은 Hikoutei이며, 현재 npm 패키지 이름은 `typed-sheets`입니다.

```sh
npm install typed-sheets @mikro-orm/core @mikro-orm/sql
```

애플리케이션은 `typed-sheets`만 import합니다. MikroORM은 현재 SQLite 실행
프로바이더가 사용하는 선택적 의존성이며, 애플리케이션의 엔티티 정의 API에는
노출되지 않습니다.

## 빠른 시작

typed-sheets를 통해 엔티티를 정의한 후 요청 단위 manager로 엔티티를 다룹니다.
전체 라우트와 Gateway 설정은 [빠른 시작 가이드](docs/quick-start.md)에 있습니다.

```ts
import { createTypedSheets, defineTypedSheetsEntity } from "typed-sheets";

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

`flush()`는 로컬 SQLite 상태를 커밋합니다. 해당 엔티티를 Google Sheets outbox와
연결하려면 별도의 `sync` 라우트 설정을 추가합니다. 원격 전달은 비동기이므로
[설정 가이드](docs/quick-start.md)에 따라 sync worker를 실행하고 Gateway를
프로비저닝해야 합니다.

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

1. 서버 애플리케이션에서 엔티티와 Sheet의 매핑을 정의합니다.
2. [`apps-script/gateway/Code.gs`](apps-script/gateway/Code.gs)를 Google Apps
   Script Web App으로 배포합니다.
3. 서버에서 등록된 탭과 범위를 프로비저닝합니다.
4. 대기 중인 변경 내용을 전달하는 sync worker를 실행합니다.

Gateway 시크릿은 서버에만 보관하세요. 브라우저 코드에 넣거나 Git에 커밋하지
마세요.

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

현재 작업은 [open issues](https://github.com/ManddarinShop/google-sheets-orm/issues)
에서 확인할 수 있습니다.

## 라이선스

Hikoutei는 [MIT License](LICENSE)로 배포됩니다.
