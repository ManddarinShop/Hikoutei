[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md)

<div align="center">

# Hikoutei

**Google Sheets 기반 MVP를 위한 타입 안전 리포지토리 및 안전한 쓰기 계층**

<a href="https://www.npmjs.com/package/typed-sheets">npm</a> ·
<a href="https://github.com/ManddarinShop/google-sheets-orm/issues">이슈</a> ·
<a href="apps-script/gateway/Code.gs">Apps Script Gateway</a>

[![npm version](https://img.shields.io/npm/v/typed-sheets?style=flat-square)](https://www.npmjs.com/package/typed-sheets)
[![license](https://img.shields.io/npm/l/typed-sheets?style=flat-square)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

> [!NOTE]
> **Hikoutei**는 프로젝트 브랜드입니다. 공개 패키지 식별자가 안정화되는
> 동안 npm 패키지는 현재 `typed-sheets`라는 이름으로 배포됩니다.

Hikoutei는 TypeScript 애플리케이션에 로컬 SQLite를 기반으로 한 엔티티 중심
리포지토리 API를 제공합니다. Google Sheets는 사람이 확인할 수 있는
비동기 프로젝션으로 사용합니다. MVP, 내부 도구, 프로토타입, 저트래픽
관리 도구처럼 스프레드시트가 제품의 일부인 환경을 대상으로 합니다.

Hikoutei는 범용 데이터베이스 대체재, Prisma/JPA 클론, 범용 Google Sheets API
래퍼를 목표로 하지 않습니다.

## 사용하기 좋은 경우

- 애플리케이션이 TypeScript/Node.js 서버에서 실행되는 경우
- SQLite를 로컬 기준 저장소로 사용할 수 있는 경우
- 사용자가 Google Sheets에서 데이터를 확인하거나 가끔 수정해야 하는 경우
- 최종적 일관성을 허용할 수 있는 경우
- MVP, 내부 도구, 프로토타입, 저트래픽 관리 도구인 경우

## 사용하지 않는 것이 좋은 경우

다음 요구사항이 있다면 일반적인 데이터베이스와 직접적인 Google API 사용을
검토하세요.

- 여러 행 또는 여러 서비스에 걸친 강한 트랜잭션
- 높은 쓰기 처리량 또는 많은 동시 작성자
- 복잡한 SQL 쿼리, 조인, 리포팅
- 멀티 리전 또는 멀티 서버 조정
- Google Sheets에서 즉각적인 쓰기 후 읽기 일관성
- Google Sheets를 기본 데이터베이스로 사용하는 경우

## 문서

- [아키텍처](docs/architecture.md)
- [빠른 시작](docs/quick-start.md)
- [쓰기 및 동기화 흐름](docs/write-and-synchronization-flow.md)
- [개발 가이드](docs/development.md)
- [전체 벤치마크 기록](docs/sync-bulk-write-benchmark.md)

## Google Sheets Gateway

[`apps-script/gateway/Code.gs`](apps-script/gateway/Code.gs)를 Google Apps
Script Web App으로 배포하세요. 제공되는 Gateway는 의도적으로 얇게
구성되어 있습니다.

1. 서명된 operation envelope 검증
2. operation 계약 검증
3. 허용 목록에 있는 Sheet 작업 실행
4. 구조화된 결과를 서버 워커에 반환

기준 상태, outbox 결정, 재시도 정책, reconciliation(불일치 보정), 엔티티
평가는 Node/SQLite 측 Hikoutei가 담당합니다. Gateway 공유 시크릿을 브라우저
코드에 넣거나 Git에 커밋하지 마세요.

프로비저닝은 명시적으로 수행합니다. 먼저 로컬 SQLite 레지스트리를 초기화한
후 operation 기반 Gateway를 통해 `provisionRegisteredSyncSheets()`를
사용하세요.

## 이전 경로와 현재 경로

현재 설계는 경로 단위의 발전 결과입니다. 모든 이전 beta 버전과 직접적인
버전 대 버전 비교를 보장하지는 않습니다.

| 영역 | 이전 동기화 경로 | Hikoutei 현재 경로 |
| --- | --- | --- |
| 기준 상태 | Sheet 메타데이터와 원격 검증을 혼합 | SQLite를 기준 저장소로 사용 |
| 쓰기 경로 | effect마다 메타데이터·snapshot·CAS·receipt·postcondition 수행 | SQLite durable outbox와 배치 fast append |
| Gateway | 더 많은 동기화 판단을 Apps Script에서 수행 | 얇은 서명 기반 operation dispatcher |
| 보정 | 초기 쓰기와 보정 작업이 같은 흐름에서 경쟁 | reconciliation을 별도 안전망으로 분리 |
| 폴링 | 전체 snapshot 및 메타데이터 중심 스캔 | 배치 values-only 읽기 후 로컬 비교 |
| 공개 API | 저수준 insert/update/delete 중심 | `persist`, 변경, `flush`, `remove` 엔티티 생명주기 |

현재 설계는 응답 유실 상황에서 원격 쓰기의 정확히 한 번 수행을 증명하려
하기보다, 멱등 effect와 reconciliation을 이용한 최소 한 번 전달을
선택합니다.

## 성능 요약

다음 결과는 저장소에서 측정한 벤치마크이며 모든 Google Sheets 환경에
적용되는 보편적인 보장은 아닙니다.

### 경량 폴링 개선

동일한 66행 운영 데이터 형태를 이전 전체 snapshot 폴링과 현재
values-only 폴링으로 측정했습니다.

| 경로 | 소요 시간 | 원격 읽기 | 결과 |
| --- | ---: | ---: | --- |
| 이전 전체 snapshot 폴링 | 27,652 ms | — | 기준값 |
| 현재 첫 경량 폴링 | 2,109 ms | 573 ms | 약 13배 빠름 |
| 현재 안정 상태 폴링 | 2,240 ms | 530 ms | 약 12배 빠름 |

현재 폴링은 세 개의 `getValues()` 작업을 하나의 서명된 요청에 담고, 결과를
로컬에서 비교합니다. 아직 사용자 수정 내용을 canonical write로 평가하는
단계까지 포함하지 않습니다.

### Fast append 처리량

새 Sheet에서 reconciliation을 끈 상태로 실제 라이브러리 인터페이스를 통해
6개 컬럼의 synthetic row 370개를 한 번에 전송했습니다.

| 행 수 | 소요 시간 | 행/초 | 셀/초 | 결과 |
| ---: | ---: | ---: | ---: | --- |
| 20 | 2,275 ms | 8.79 | 52.75 | applied |
| 100 | 2,729 ms | 36.64 | 219.86 | applied |
| 370 | 3,792 ms | 97.57 | 585.44 | applied |

측정된 세 단계에서 총 490개 행이 모두 성공적으로 처리되었습니다. 이
측정은 순수 fast append 결과이며 SQLite outbox drain, reconciliation,
postcondition 검사, delete 처리는 포함하지 않습니다.

### 운영 경로 전체 측정

실제 `User`/`Order`/`OrderItem` 서버 흐름에서는 Order 370개와 OrderItem
740개가 1,110개 행으로 반영되는 데 36,865 ms가 걸렸고 실패한 effect는
없었습니다. 가장 큰 비용은 로컬 ORM flush나 `setValues()` 자체가 아니라
HTTP/Apps Script dispatch와 range lookup이었습니다.

자세한 날짜별 결과는
[`docs/sync-bulk-write-benchmark.md`](docs/sync-bulk-write-benchmark.md)를
참고하세요.

## 제한사항

- Google Sheets는 최종적 일관성이며 quota와 지연 시간의 영향을 받습니다.
- SQLite가 기준 저장소이며 멀티 서버 조정 계층이 아닙니다.
- `_version`과 effect 상태는 stale write 보호를 제공하지만 분산 트랜잭션은
  아닙니다.
- 사용자 수정, update/delete 충돌 처리, reconciliation에는 별도 운영 정책이
  필요합니다.
- Apps Script 실행 제한과 응답 유실은 워커가 복구해야 하는 외부 실패
  요인입니다.
- 고처리량 트랜잭션 작업에는 적합하지 않습니다.

## 로드맵

- `typed-sheets` beta 호환 경로를 유지하면서 `Hikoutei` 공개 브랜드 안정화
- `onEdit` 및 경량 폴링을 이용한 사용자 수정 수집 계약 완성
- update/delete effect와 충돌 표시 강화
- 레지스트리 및 Apps Script 배포를 위한 setup CLI 추가
- 운영 동기화 계약이 검증된 후 stable 패키지 배포

구현 메모와 현재 이슈는
[open issues](https://github.com/ManddarinShop/google-sheets-orm/issues)를
참고하세요.

## 추가 문서

- [MikroORM adapter 및 엔티티 facade](docs/mikro-orm-adapter-spike.md)
- [SQL 계층 계획](docs/sql-layer-plan.md)
- [Task queue 쓰기 모델](docs/task-queue-write-model.md)
- [동기화 관측성](docs/sync-observability.md)
- [Apps Script gateway 소스](apps-script/gateway/Code.gs)

## 라이선스

Hikoutei는 [MIT License](LICENSE)로 배포됩니다.
