[English](README.md) | [日本語](README.ja.md)

<div align="center">

<img src="assets/hikoutei-icon.png" alt="Hikoutei" width="220" />

# Hikoutei

**SQLite로 앱은 빠르게, Google Sheets로 업무 흐름은 눈에 보이게.**

Google Sheets 기반 MVP를 위한 타입 안전 리포지토리이자 안전한 쓰기 계층:
애플리케이션은 타입이 지정된 엔티티로 로컬 SQLite를 읽고 쓰고, 커밋된 변경은
사람이 검토하고 가볍게 협업할 수 있도록 Google Sheets에 비동기로 투영됩니다.

<a href="https://www.npmjs.com/package/hikoutei">npm</a> ·
<a href="website/guide/quick-start.md">빠른 시작</a> ·
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

## Hikoutei를 쓰는 이유

- 시트 행을 수동으로 변환하는 대신 타입 지정 엔티티를 정의합니다.
- Google Sheets를 기다리지 않고 로컬 SQLite로 읽고 씁니다.
- 커밋된 변경을 Sheets에 백그라운드로 동기화합니다.
- 예상치 못한 컬럼 변경과 중복 헤더를 감지합니다.
- 충돌 중에 더 새로운 시트 수정을 덮어쓰지 않습니다.

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

## 설치

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

라이브러리 설치만 하면 Google Cloud에는 아무 것도 만들지 않습니다 — 기본은
로컬 전용(SQLite)으로 동작합니다. 시트 동기화를 원할 때만 아래 setup을
실행하세요.

## 설정 (Google Sheets 동기화)

1회성 인터랙티브 작업입니다. gcloud CLI 설치 후:

```sh
npx hikoutei setup
```

Cloud 프로젝트, 서비스 계정, 키, 스프레드시트를 만들고 `.env`까지 써 줍니다.
`HIKOUTEI_SYNC_SPREADSHEET_URL`이 없으면 `createTypedSheets()`는 로컬 전용
(SQLite)으로 유지됩니다. 상세 설정, 크리덴셜 풀, 쿼터 가이드, 수동 설정:
[Google Sheets 설정](website/guide/setup.md).

## 사용법

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
    age: { type: "number" },
    active: { type: "boolean" },
  },
});

const hikoutei = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
});

const em = hikoutei.em.fork();
const user = em.create(User, { id: "u1", name: "Ada", age: 36, active: true });
em.persist(user);
await em.flush();

user.name = "Ada Lovelace";
await em.flush();

const loaded = await em.findOne(User, { id: "u1" });
if (loaded !== null) {
  em.remove(loaded);
  await em.flush();
}
```

더 많은 읽기·트랜잭션·연산자: [빠른 시작](website/guide/quick-start.md).

쓰기는 즉시 로컬 SQLite에 커밋됩니다 — 요청은 Google을 기다리지 않습니다.
시트에서 사람이 편집하면 폴링으로 되돌아와 SQLite에 수용되거나 충돌로
기록되며, 절대 조용히 덮어쓰이지 않습니다. 전체 파이프라인(outbox, 전달,
충돌 처리)은 [쓰기 및 동기화 흐름](website/guide/sync-flow.md)을 참고하세요.

## 더 보기

- [빠른 시작](website/guide/quick-start.md) — 설치, ORM 생명주기, 동기화 설정
- [아키텍처](website/guide/architecture.md) — 로컬 저장소와 Sheet 화면이 맞물리는 방식
- [쓰기 및 동기화 흐름](website/guide/sync-flow.md) — 비동기 전달과 복구 동작
- [한계](website/guide/limitations.md) — 다른 도구를 선택해야 할 때
- [프로젝트 상태와 로드맵](website/guide/status.md) — 완료된 것과 다음 작업

## 라이선스

Hikoutei는 [MIT 라이선스](LICENSE)로 배포됩니다.