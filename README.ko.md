[English](README.md) | [日本語](README.ja.md)

<div align="center">

# Hikoutei

**Google Sheets 기반 MVP를 위한 타입 안전 리포지토리 및 안전한 쓰기 계층**

<a href="https://www.npmjs.com/package/hikoutei">npm 패키지</a> ·
<a href="https://github.com/ManddarinShop/Hikoutei/issues">이슈</a> ·
<a href="docs/quick-start.md">빠른 시작</a>

[![npm version](https://img.shields.io/npm/v/hikoutei?style=flat-square)](https://www.npmjs.com/package/hikoutei)
[![license](https://img.shields.io/npm/l/hikoutei?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

Hikoutei는 TypeScript와 Node.js 애플리케이션에서 Google Sheets를 MVP 또는
내부 업무 흐름의 사람이 읽기 쉬운 화면으로 사용할 수 있게 합니다. 애플리케이션은
타입이 지정된 엔티티와 로컬 SQLite를 사용하고, 서비스 계정 기반 Google
Sheets provider를 통해 변경 내용을 Google Sheets에 비동기적으로 전달할 수
있습니다.

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

엔티티 정의와 SQLite lifecycle은 루트 API만 사용합니다. Sheet route,
provider credential, provisioning, polling은 내부 service bootstrap의 책임입니다.

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

`createTypedSheets()`는 로컬 entity table만 준비하며 Google Sheets에 연결하지
않습니다. 내부 sync service가 mapping을 등록하고 탭을 provisioning한 뒤
outbound worker와 User_Input polling을 시작합니다. service mode에서
`flush()`는 entity, canonical state, durable outbox를 SQLite transaction으로
커밋하고 원격 Sheet 전달은 비동기로 수행합니다.

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

Google Sheets 동기화는 service-side의 책임입니다. 권장 경로는 서비스 계정
기반 `googleSheetsApi` provider로, 하나의 서비스 계정으로 탭 provisioning,
outbound effect 쓰기(빠른 append, guarded update/delete, receipt, 응답 유실
복구), 테이블 읽기, 행 anchor, 사용자 편집 관찰을 모두 수행합니다.
애플리케이션은 provider client를 import하거나 Sheet route를
`createTypedSheets()`에 넘기지 않습니다.

1. `https://www.googleapis.com/auth/spreadsheets` scope를 가진 Google Cloud
   서비스 계정을 만들고, 대상 스프레드시트를 이메일로 **Editor** 권한으로
   공유합니다. provider가 탭 생성, effect 행과 receipt 기록, 행 anchor 관리를
   하므로 Viewer 권한으로는 부족합니다. Cloud 프로젝트에서 Google Sheets API를
   활성화합니다.
2. 서비스 계정 키 파일 경로를 서버의 `GOOGLE_APPLICATION_CREDENTIALS`에 두고,
   스프레드시트 ID는 커밋되지 않는 시크릿 저장소에 보관합니다. 키를 브라우저
   코드나 Git에 넣지 마세요.
3. `googleSheetsApi`로 내부 sync bootstrap을 시작합니다. 등록된 탭의 헤더를
   생성/검증한 뒤 outbox 전달과 User_Input polling을 시작합니다.

시트 일관성은 요청 간 Sheet 트랜잭션에서 오지 않습니다. 숨겨진
effect-receipt 탭, effect-id/payload-hash 중복 제거, SQLite durable outbox,
fencing, 필드 단위 compare-and-set 증거, postcondition 복구에서 옵니다.
provider는 자격 증명, 스프레드시트 ID, URL, payload를 로그에 남기지 않으며,
요청 시작 간격을 클래스별(읽기/쓰기) 1,100ms로 조절해 Google quota window를
지킵니다. `flush()`는 로컬 커밋만 의미하고 전달은 비동기이며, 모든 쓰기는
receipt로 기록되고 같은 effect worker가 복구합니다.

추적되는 live 시나리오는 이 provider로 실행됩니다.
[docs/sync-bulk-write-benchmark.md](docs/sync-bulk-write-benchmark.md)의
10,000행 append와 update/delete live 증거도 같은 REST 경로를 사용합니다.
`scripts/bench/`의 원시 전송 실험은 receipt/CAS 없는 unguarded 경로이므로,
worker를 통한 측정 전에는 성능 수치를 검증된 것으로 보지 마세요. live 호출은
opt-in이며, 일반 검증은 fake provider와 SQLite fixture를 사용합니다.

기존 Apps Script Gateway와 `appsScript`/`googleApiWorker` 옵션은 제거되어
위 서비스 계정 provider가 유일한 동기화 경로입니다. 상세한 설정과 문제 해결
방법은 [빠른 시작](docs/quick-start.md)에 설명되어 있습니다.

## 문서

- [빠른 시작](docs/quick-start.md) — 설치, ORM lifecycle, service-side sync 설정.
- [아키텍처](docs/architecture.md) — 로컬 저장소와 Sheet 화면의 관계.
- [쓰기 및 동기화 흐름](docs/write-and-synchronization-flow.md) — 비동기 전달과
  복구 동작.
- [개발 가이드](docs/development.md) — 로컬 개발 및 테스트 명령.
- [벤치마크 기록](docs/sync-bulk-write-benchmark.md) — 날짜별 측정 결과와
  한계.

## 제한사항

- Google Sheets에는 quota, 지연 시간, API rate limit이 있습니다.
- Sheet 업데이트는 비동기이므로 애플리케이션은 로컬 상태를 읽어야 합니다.
- SQLite는 서비스에 로컬이며 분산 조정 계층이 아닙니다.
- 스키마 변경, 수동 편집, 충돌하는 변경에 대한 운영 정책은 애플리케이션이
  별도로 정해야 합니다.

## 로드맵

- Google Sheets에서 의도적인 사용자 편집을 수집하는 기능 완성.
- update/delete 충돌 처리와 표시 개선.
- 레지스트리 및 직접 provider 배포를 위한 설정 도구 추가.
- 공개 패키지 릴리스 안정화.

현재 작업은 [open issues](https://github.com/ManddarinShop/Hikoutei/issues)
에서 확인할 수 있습니다.

## 라이선스

Hikoutei는 [MIT License](LICENSE)로 배포됩니다.
