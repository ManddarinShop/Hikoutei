# Google Sheets 동기화 확장 전략 — Direct API 검증과 폴백 의사결정 가이드

> 이 문서는 Hikoutei의 Sheets 투영(projection) 경로가 현재 어디까지 확장 가능한지,
> Direct Sheets API 전환을 검증할지, 검증 결과에 따라 무엇을 채택하거나 포기할지를
> 결정하기 위한 의사결정 가이드다. 소스 코드 구현 계획이 아니다.
>
> 프로젝트 포지셔닝: **Typed repository and safe write layer for Google Sheets-backed MVPs.**
> SQLite가 애플리케이션 authority이며, Google Sheets는 비동기 human-facing 투영이자
> 입력 표면이다. 이 문서는 Sheets를 데이터베이스 대체품으로 소개하지 않으며,
> Sheets에 트랜잭션 보장이 있다고 주장하지 않는다.

참조 문서(모두 상대 링크):

- [`AGENTS.md`](../AGENTS.md) — 프로젝트 원칙과 코드 수정 규칙
- [`code-guidelines.md`](code-guidelines.md) — 코드/문서 작성 기준
- [`architecture.md`](architecture.md) — 아키텍처와 SQLite authority 모델
- [`write-and-synchronization-flow.md`](write-and-synchronization-flow.md) — 쓰기·동기화 흐름과 실패 모델
- [`sync-bulk-write-benchmark.md`](sync-bulk-write-benchmark.md) — 벤치마크 증거 원본
- [`advanced-sheets-gateway-concurrency-problem.md`](advanced-sheets-gateway-concurrency-problem.md) — Apps Script 게이트웨이 동시성/정합성 문제 분석

## 표기 규약

이 문서는 아래 다섯 가지 상태를 명시적으로 구분한다.

| 표기 | 의미 | 예 |
| --- | --- | --- |
| `[측정]` | 벤치마크 문서에 기록된 과거 관측 사실(벤치마크 뒷받침 관측에만 사용) | 2026-08-04 no-op Gateway p50 1.956s |
| `[일반 사실·미측정]` | 벤치마크로 측정되지 않은 일반적 사실(플랫폼/제품 문서 수준 지식) | Service Account와 OAuth가 동일한 Sheets API를 호출 |
| `[가설]` | 아직 실행하지 않은 벤치마크에 대한 예상 | Direct API 최소 경로가 수 배 빠를 것 |
| `[설계안]` | 검증 후에만 채택을 고려하는 조건부 설계 | receipt/사후조건 축소안 |
| `[폴백]` | 전송 최적화가 실패할 때 적용하는 확정 결정 | 백로그 압축, canonical 재구축 |

벤치마크 수치는 모두 환경 특정적 과거 관측이며, 다른 환경이나 Direct Sheets API에
대한 보장으로 일반화할 수 없다.

---

## 1. 목적, 가정, 비목표

### 목적

- 로컬 SQLite/API 서빙 안정성과 원격 Sheets 수렴·신선도(freshness)를 **별개의 SLO**로 분리한다.
  - **SLO-A(로컬 서빙)**: SQLite 읽기/쓰기 가용성, 지연, 내구성. Google 측
    장애와 무관해야 한다. 단, 이 격리는 **구성된 백로그/저장소 엔벨로프
    안에서의 아키텍처 목표**이며 무한 보장이 아니다(아래 "백로그 용량 경계"
    참조).
  - **SLO-B(원격 수렴)**: Sheets 투영의 최종 일치와 신선도. 환경·할당량 의존적이며
    최선 노력(best-effort) 성격을 명시한다.
- **백로그 용량 경계**: 장기 장애로 유입 작업률이 원격 처리 용량을 초과하면
  (λ > μ) 내구성 아웃박스가 SQLite/디스크 용량을 소진해 결국 로컬 서빙에
  영향을 줄 수 있다. 따라서 의미상 안전한 범위에서의 **제한된 보존/압축
  (bounded retention/compaction)**, **admission/backpressure 또는 운영자
  일시 중지**, 그리고 **로컬 저장소 소진 전 경보**를 구성한다.
- Direct Sheets API 검증을 위한 **최소 벤치마크 단계와 채택 게이트**를 정의한다.
- 전송/프로토콜 최적화가 실패할 경우의 **폴백 우선순위**를 확정해 둔다.

### 가정

- SQLite가 authority이며, **내부 sync-service 모드에서** `flush()`는 entity
  table·canonical 상태·지속형 효과 아웃박스를 하나의 SQLite 트랜잭션으로
  커밋한다. 원격 반영은 비동기 at-least-once 전달이다
  (`write-and-synchronization-flow.md`). 공개 SQLite-only 모드는 Google
  Sheets에 접촉하지 않으며 sync 테이블/아웃박스 효과를 만들지 않는다
  (`architecture.md`).
- 응답 손실(ambiguous delivery)은 실패를 증명하지 않으며, receipt 기반 증거와
  사후조건 조사로 처리한다.
- 정상 entity 데이터는 항상 SQLite에서 읽는다. Sheets는 사람용 투영·입력 표면이다.
- 대상 워크로드는 저트래픽 MVP/내부 도구이며, 단일 로컬 writer 프로세스를 전제한다.

### 비목표

- Sheets를 고처리량 트랜잭션 안전 데이터베이스로 만드는 일은 **이 프로젝트의 목표가 아니다**.
  이 문서는 그런 시도를 검증하지 않는다.
- Sheets에 진정한 크로스-요청 CAS나 분산 트랜잭션을 제공하는 일은 다루지 않는다.
- 공개 EntityManager API를 바꾸거나, MikroORM/게이트웨이 내부를 공개 계약으로
  노출하는 일은 다루지 않는다.
- Google 백엔드/할당량 한계를 라이브러리 코드로 제거하는 일은 불가능하며 다루지 않는다.

---

## 2. 현재 병목의 증거 (`sync-bulk-write-benchmark.md` 기준)

모든 수치는 해당 벤치마크 문서의 섹션·날짜와 함께 인용하며, 환경 특정적
관측이다. Direct Sheets API 성능을 보장하지 않는다.

### 2.1 로컬 경로는 밀리초 단위, Gateway는 초 단위

`[측정]` 2026-08-03 clean Locust smoke(10 users, 60초, fresh SQLite + fresh 투영 탭).
**주의**: 아래 Gateway/아웃박스 수치는 60초 Locust 워크로드 구간의 지표가
아니라, 워크로드 종료 후 약 2분간 백그라운드 drain이 이어진 뒤의 서버 측
스냅샷이다. 단일 steady-state 구간의 측정으로 읽으면 안 된다.

| 경로 | 결과 |
| --- | --- |
| `GET /users/:id` | 134건, 실패 0, p50 2 ms / p95 4 ms / max 6 ms |
| `POST /users` | 81건, 실패 0, p50 5 ms / p95 6 ms / max 19 ms |
| `PATCH /users/:id` | 76건, 실패 0, p50 5 ms / p95 8 ms / max 22 ms |
| Gateway(워크로드 후 + 백그라운드 drain 스냅샷) | 100건, 실패 34, p50 3.71 s / **p95 33.47 s** / max 60.00 s |
| 아웃박스(같은 스냅샷 시점) | pending 306, processing 8, applied 2, superseded 2 — **수렴하지 않음** |

즉 SQLite 기반 CRUD는 밀리초 단위·무실패인 반면, 원격 투영 경로는 테일 지연과
non-JSON/timeout 실패가 지배적이었고 아웃박스가 워크로드보다 빠르게 소진되지
못했다.

### 2.2 원시 셀 쓰기 자체는 빠르다

`[측정]` 2026-07-24 raw Apps Script write: 100행 × 6열 = 600셀, 단일 연속
`setValues()` + `flush()`.

| 측정 | `setValues()` | `flush()` | 합계 |
| --- | ---: | ---: | ---: |
| 100행 / 600셀 | 96 ms | 278 ms | **374 ms** (약 267 rows/s) |

### 2.3 완전 경로는 훨씬 느리다 — 그러나 동일 비교가 아니다

`[측정]` 2026-07-24 비교 섹션: 이전 clean-DB 테스트의 완전 20-effect 동기화
(`POST /sync/once?maxEffects=20`)는 **약 75.4초**(75,409 ms)가 걸렸고 20개 효과가
모두 적용되었다. 이 경로에는 스냅샷 읽기, 행 메타데이터, CAS 검사, 사후조건
읽기, receipt, 요청 추적이 포함되어 있다. raw 쓰기 벤치마크는 동시성 검사,
사용자 편집 감지, receipt, 사후조건 검증을 의도적으로 우회하므로 **정확성 관점의
동일 비교가 아니다**.

### 2.4 이후 프로그레시브 실행: 30.1 rows/s

`[측정]` 2026-07-27 progressive operational throughput run(운영 서버 + 배포된
Gateway, reconciliation 비활성):

| 스테이지 | 신규 Orders | 머티리얼라이즈 행 | 시간 | 약 rows/s |
| --- | ---: | ---: | ---: | ---: |
| 20 | 20 | 60 | 11,987 ms | 5.0 |
| 100 | 100 | 300 | 14,960 ms | 20.1 |
| 370 | 370 | **1,110** | **36,865 ms** | **30.1** |

원격 worker→Gateway 경로가 지배적이었다: `append_gateway_dispatch` 27회
67,825 ms vs 원시 `set_values` 27회 370 ms vs 로컬 `flush_total` 493회 1,118 ms.
모든 스테이지에서 실패한 효과는 0이었다.

### 2.5 배포된 signed no-op Gateway 베이스라인

`[측정]` 2026-08-04 Gateway baseline transport gate(재배포 후 통과): 100회 순차
signed no-op 호출(시트 변경 없음).

| 지표 | 값 |
| --- | ---: |
| 성공 | 100 / 100 (실패 0%) |
| p50 / p95 / max | 1,956 ms / 4,511 ms / 20,994 ms |
| 총 소요 | 254,786 ms |

모든 요청이 `POST /exec` 302 리다이렉트를 거쳐 Apps Script `macros/echo`로
도달했다. 같은 문서의 2026-08-03 중단된 베이스라인(100/100 HTTP 405,
`Code.gs response was not valid JSON`)과 대비되며, **전송 계층 불안정성이
재배포로 해소될 수 있는 별개 변수**임을 보여준다.

### 2.6 해석: 원시 셀 변이가 유일하거나 주된 전체 경로 비용이 아니다

`[측정]` 2026-07-27 operational timing run과 2026-07-24 isolated stage
benchmark, 2026-07-27 polling phase trace가 다음을 뒷받침한다:

- 20행의 `metadata_write`(행별 Developer Metadata 재작성)가 약 31.7초로 지배적이었고
  `flush()`는 59 ms에 불과했다(이후 가시 버전/해시 메타데이터를 SQLite authority로
  옮기는 마이그레이션이 적용됨).
- 20-Order 실행에서 append 9회의 원시 `set_values`는 92 ms, `append_range_lookup`
  896 ms, `dispatcher_flush` 2,091 ms, `append_gateway_dispatch` 21,698 ms였다.
- 폴링 단계 추적에서 원시 `values_read`는 12 ms였지만 Developer Metadata 탐색이
  표 합계 10,402 ms였다.

즉 전체 경로 비용은 **디스패치/런타임, 락, 범위·identity 조회, Developer
Metadata, receipt/사후조건 처리, 복구, 재시도 증폭**에 분산되어 있다. 원시 셀
쓰기 속도를 올리는 것만으로는 해결되지 않는다.

---

## 3. 인증(authentication)과 데이터 플레인(data plane)의 분리

두 축을 혼동하면 안 된다.

### 3.1 호출자 신원(누가 호출하는가)

`[일반 사실·미측정]` Service Account와 사용자 OAuth는 **호출자 identity와
자격증명 수명주기**를 선택한다. 토큰 획득 이후에는 둘 다 동일한 Google Sheets
API를 호출할 수 있다.

단, 인증과 할당량의 관계는 **호출자/할당량 identity와 Apps Script 런타임
할당량**을 구분해 봐야 한다. OAuth 사용자와 Service Account는 사용자별/
프로젝트별 할당량 계정 방식이 다를 수 있으며, Apps Script 실행
identity/런타임 할당량은 Web App 호출자 인증과 별개다. 인증 선택이 할당량에
무관하다고 단정하지 않는다 — 정확한 할당량/성능 관계는 **측정되지
않았다(unmeasured)**. 다만 인증 방식 자체가 Sheets 백엔드 한도를 제거하지는
않는다는 점은 유지한다.

- 중앙 내부 관리 서버에서는, 공유/Workspace 정책이 허용하는 경우 Service Account가
  운영상 단순할 수 있다(사용자별 동의/토큰 갱신 불필요).
- 그러나 Service Account가 속도를 보장하지는 않는다.

### 3.2 실행 경로(어떻게 호출하는가)

`[설계안]` Apps Script Gateway와 Direct Sheets API는 **서로 다른 실행 경로**다.

Direct API가 제거할 수 있는 것:

- Apps Script 배포(Web App `/exec`), 302 리다이렉트, 실행 큐, dispatcher,
  `LockService` 스크립트 락, non-JSON 응답 같은 Apps Script 특유 실패 클래스.

Direct API가 제거하지 못하는 것:

- Google API/백엔드 할당량과 지연, 429/5xx, 네트워크 타임아웃.
- Sheets의 크로스-요청 CAS 부재(진정한 비교-후-쓰기 원자성).

즉 Direct API는 전송/런타임 병목 일부를 제거하는 후보다. Google 백엔드 상한이나
Sheets의 정합성 모델 자체를 바꾸지 않는다.

---

## 4. Direct API 검증 가설과 성능 사다리

> 이 섹션의 어느 것도 **이미 실행된 벤치마크가 아니다**. 아래는 검증 절차와
> 숫자 예상이며, 모든 수치 기대치는 가설 또는 채택 게이트로만 취급한다.

### 4.1 최소 벤치마크(첫 단계)

`[가설]` 시작점은 새 빈 Spreadsheet에서, 메타데이터/receipt/CAS 없이
**최소 연속 배치 쓰기** 하나다.

1. 새 빈 Spreadsheet에 최소 연속 배치 쓰기(메타데이터·receipt·CAS 없음).
2. 행 수 1 / 10 / 100 / 500, 동시성은 **1부터**, 이후 신중하게 2 / 4.
3. 동일 페이로드를 Apps Script 경로와 동일 조건으로 비교.

### 4.2 점진적 추가 단계

각 단계는 독립적으로 측정하고, 단계별 채택 게이트를 통과해야 다음으로 간다.

1. 키 조회 추가
2. 배칭 추가
3. 단일 배치 사후조건 하나 추가
4. 응답 손실 복구 추가
5. 전체 아웃박스 end-to-end 전달(생성→drain→수렴)

### 4.3 측정 항목

| 범주 | 항목 |
| --- | --- |
| 지연 | p50 / p95 / max, 요청당 처리 시간 |
| 오류 | 오류 클래스별(429, 5xx, 타임아웃, 네트워크, 응답 형식 오류) 비율 |
| 처리량 | rows/s, rows/request, effect당 요청 수 |
| 수렴 | 아웃박스 생성률 vs drain률, 백로그 수렴 시간, 중복/유실 쓰기 |
| 로컬 영향 | 로컬 API p95, event-loop/SQLite 경합 |

### 4.4 숫자 기대치(가설)

`[가설]` 다음은 약속이 아니라 검증 전 가설이다:

- 2026-08-04 no-op Gateway 베이스라인(p50 약 2초)과 2026-07-27 디스패치·락
  오버헤드 관측을 고려하면, **약 2초대 Apps Script 고정 베이스라인과 긴
  스크립트 측 프로토콜을 제거**할 경우 의미 있는 개선이 가능할 수 있다.
- end-to-end에서 **수 배 개선은 프로토콜이 단순해질 때만** 기대할 수 있다.
  receipt/사후조건/메타데이터 스캔을 그대로 옮기는 lift-and-shift는 개선이
  거의 없을 수 있다.

### 4.5 용량 모델: λ와 μ

- **λ(lambda)**: 지속 유입 투영 작업률. 단위는 **효과/초(effects/s) 또는
  행/초(rows/s)** 중 하나로 고정한다.
- **μ(mu)**: 지속 원격 처리 용량. 단위는 λ와 **같은 단위**(효과/초 또는
  행/초)로 고정한다.

간단한 백로그 소진 관계(지속형 큐, 백로그 B₀ 존재 시):

```text
B(t) = B₀ + (λ − μ)·t     (상수율 근사; 소진 후 B(t)는 0에서 유지, 음수 불가)
T_drain = B₀ / (μ − λ)     (μ > λ: 소진 시간, 근사)
capacity margin = (μ − λ) / λ   (μ/λ 비율과는 다른 정의; λ = 0이면 해당 없음)
```

상수율(constant-rate) 근사에서 백로그 거동을 경우별로 명시하면:

- **μ > λ: 백로그가 소진된다(drain).** 유입/처리율이 안정적이고 다른 작업에
  쓸 용량이 있다는 전제 아래, T_drain ≈ B₀/(μ − λ)로 0에 도달한 뒤 0을
  유지한다.
- **μ = λ: 백로그는 일정하게 유지된다(constant).** 기존 백로그는 수렴하지
  않으며, 신규 작업은 도착분만큼 처리된다.
- **μ < λ: 백로그가 성장한다(grow).** 지속형 큐는 작업을 보존할 뿐 수렴할
  수 없다.

단위 주의: λ와 μ를 **효과/초와 행/초로 섞어 측정하면 안 된다.** 서로 다른
단위를 혼용하면(예: λ는 효과/초, μ는 행/초) B(t)·T_drain·capacity margin이
모두 의미를 잃는다. 또한 **λ = 0이면** capacity margin `(μ − λ)/λ`와 비율
`μ/λ`는 **0으로 나누지 않으며 해당 없음(not applicable)/정의되지 않음**으로
취급한다 — 유입이 없는 상태에서는 수렴 판단 자체가 무의미하다.

이 식들은 평균 유입/처리율이 일정하다고 가정하는 **상수율(constant-rate)
근사**다. 실제 신선도는 평균 λ만으로 결정되지 않으며, **버스트(burst), 초기
백로그, 재시도/복구 작업, 서비스 시간의 백분위(p50/p95), 폴링·재구축에
예약된 용량** 등에 의존한다. B(t)는 소진 후 0 아래로 내려가지 않는다(음수
백로그 없음). `capacity margin = (μ − λ)/λ`와 비율 `μ/λ`는 서로 다른
정의이며, 같은 의미로 혼동하지 않는다.

- **μ ≤ λ이면 지속형 큐는 기존 백로그를 수렴시킬 수 없다**(μ = λ는 백로그를
  유지할 뿐이며, 수렴에는 μ > λ가 필요). 이는 2026-08-03 clean smoke의
  미수렴 아웃박스와 일치하는 관측이다(큐 자체가 원인은 아님).
- 여유 용량(capacity margin)이 작을수록 일시 장애 후 회복이 느리며, 2.1의
  "회복 후 용량 > 유입" 조건이 수렴의 실질 게이트가 된다.
- 이 모델은 신선도 SLO를 정량화하는 도구다: 목표 지연 L과 평균 유입 λ가 주어지면
  요구 μ가 결정되고, 그 μ가 측정 가능한지가 채택 게이트가 된다.

---

## 5. Direct API가 검증될 경우의 방향

> `[설계안]` 아래는 검증 후에만 채택을 고려하는 방향이며, 현재 승인된 변경이 아니다.

- **공개 경계 불변**: 공개 EntityManager API와 SQLite entity/canonical/아웃박스
  트랜잭션 경계는 그대로 유지한다. 변경은 내부 sync 엔진과 Sheets 어댑터에
  국한된다(`architecture.md`).
- **`System_State` — 시스템 전용 빠른 레인**: spreadsheet/route당 **단일 원격
  writer**(SQLite writer lease 기반 fencing), 목표 상태 합치(desired-state
  coalescing), 제한된 배치 쓰기. 사후조건 조사는 **무조건적 effect별 재읽기가
  아니라 주로 모호한 전달(ambiguous delivery) 판정**에 사용한다.
  **단, SQLite writer lease는 그 자체로 원격 fencing이 아니다**: lease는 이미
  실행 중인 Direct API 요청을 중단시키지 못하며, lease가 만료된 writer가
  takeover 이후에도 Sheets를 변경할 수 있다. 원격 fencing이 필요하면
  (a) provider/게이트웨이가 검증하는 **원격 authority token/epoch**를
  도입하거나, (b) 보수적인 lease headroom과 함께 **in-flight 호출
  완료/불확실 전달(uncertain delivery) 사후조건 처리**를 적용하고
  **동시 takeover를 금지**해야 한다. lease 단독으로는 fencing을 보장하지
  않는다는 한계를 명시한다.
- **`User_Input` — 분리된 저용량 보호 레인**: 인간 편집, 검증, 충돌 증거,
  신중한 reconciliation 전용. 낮은 빈도로 유지한다.
- **`Sync_Conflicts` — 독립 배치 감사 투영**: 충돌 감사 행을 별도 배치로
  머티리얼라이즈한다.
- **CAS 한계 명시**: Direct API의 read-then-write 시퀀스는 원자적 CAS가 아니다.
  단일 writer 직렬화는 시스템-vs-시스템 경합을 처리하지만, 임의의 동시 인간
  편집을 처리하지는 못한다. `User_Input` 보호 레인은 기존의 field-level CAS
  증거 체계를 유지해야 한다.
- **정확성 약화 금지**: receipt/사후조건 축소를 "이미 승인된 정확성 약화"로
  제시하지 않는다. 이는 **불변조건 증명과 실패 주입 검증을 요구하는 제안**이며,
  `advanced-sheets-gateway-concurrency-problem.md`의 금지 목록(락 무조건 제거,
  receipt만으로 성공 판정 등)을 계속 따른다.

---

## 6. 폴백: 모든 전송/프로토콜 최적화가 실패할 때

> `[폴백]` 아래는 확정된 우선순위다. 낮은 번호부터 적용한다. 어떤 단계도
> SQLite authority를 약화시키지 않는다.
>
> 1~3순위의 목표 상태 합치·superseded 효과 압축·canonical 재구축은
> **시스템 소유 `System_State` 머티리얼라이즈에만** 적용한다. `User_Input`과
> `Sync_Conflicts`는 사람 입력·충돌 증거·감사 이력을 담고 있으므로 조용히
> 건너뛰거나 압축하지 않으며, 각각 고유의 순서(ordering)·CAS·감사·보존
> 정책을 요구한다. 압축은 중간 투영 작업(intermediate projection work)만
> 바꿀 뿐, 내구성 있는 로컬 authority/감사 의미론은 바꾸지 않는다.
>
> **보장 의미론의 명시**: 2~3순위가 superseded 중간 효과를 건너뛰거나 과거
> 효과를 재생하지 않고 재구축하는 것은 **효과 단위 at-least-once가 아니다.**
> 압축된 작업에 대해 보장되는 것은 **최종 `System_State` 목표 상태 수렴
> (desired-state convergence)**이며, superseded된 모든 중간 효과 각각에 대한
> 반영·receipt·감사 보장은 아니다. 효과 단위 at-least-once/receipt/감사
> 의미론은 **압축되지 않은(non-compacted) 작업**에 대해서는 그대로 유지되며,
> 최신 목표 상태에는 **tombstone/삭제 정확성**이 보존되어야 한다(삭제 효과가
> 압축·재구축 과정에서 유실되면 안 된다). 즉 "압축이 at-least-once 전달을
> 약화시키지 않는다"보다 강한 보장을 주장하지 않는다.

| 순위 | 조치 | 요지 |
| ---: | --- | --- |
| 1 | per-effect 미러 → 최신 목표 상태 델타 배치 | 개별 효과 반영 대신 상태 차이만 배치로 반영 |
| 2 | 백로그 임계치 초과 시 대체된 중간 작업 압축 | superseded 효과를 건너뛰고 최신 상태만 유지 |
| 3 | 장기 장애 복구는 SQLite canonical 상태에서 재구축 | 과거 중간 효과 전부 재생 대신 canonical 스냅샷 기반 rebuild |
| 4 | 투영 열·활성 행·보존 이력 축소 | 머티리얼라이즈 범위 자체를 줄임. **기본은 `System_State` 한정**, `User_Input`/`Sync_Conflicts` 축소는 아래 정책 필요 |
| 5 | 업무 도메인/시간별로 여러 Spreadsheet 분할 + 정당한 할당량 증액 요청 | 분할은 무한한 project/user 할당량을 만들지 않음 |
| 6 | 신선도 SLO 완화 + 마지막 성공 시각·지연 노출 | SLO-B를 현실에 맞추고 운영 가시성 제공 |
| 7 | Sheets를 예약 내보내기 + 좁은 `User_Input` 표면으로 축소 | 실시간 투영 포기, 입력 표면만 유지 |
| 8 | 실시간 운영 CRUD는 전용 관리 UI로, 대규모 분석은 BigQuery/Connected Sheets 등 적합한 표면으로 | Sheets의 역할 자체를 재정의 |

**4순위 축소 범위**: 투영 열·활성 행·보존 이력 축소는 **기본적으로
`System_State` 머티리얼라이즈에만** 적용한다. `User_Input`(사람 입력)과
`Sync_Conflicts`(충돌 감사 이력)의 열·행·이력 축소는 사용자 입력과 충돌 감사
의미론을 보존하는 **명시적 제품/보존 정책(opt-in)**이 있을 때만 허용하며,
기본값으로 적용하지 않는다.

명시적으로 금지: **할당량 회피를 위한 Service Account 회전/다중화**. 이는
라이선스·정책 위반 위험을 만들고 근본 용량을 늘리지 않는다. 할당량이 필요한
경우 정당한 절차로 증액을 요청한다.

---

## 7. 경계 판단 표

| 판단 | 결론 | 근거/조건 |
| --- | --- | --- |
| Google 장애 중 SQLite API 계속 서빙 | **아키텍처상 달성 가능** | SQLite가 authority, 로컬 flush 경로는 Google과 무관(`architecture.md`) |
| 일시 장애 후 수렴 | **회복 후 용량이 유입을 초과할 때만 달성 가능** | λ/μ 모델: μ ≤ λ면 큐가 작업을 보존할 뿐 수렴 불가 |
| Apps Script 런타임/리다이렉트/락 특유 실패 제거 | **Direct API로 개선 가능** | 실행 경로 차이(3.2절). 단, 전송 불안정은 재배포로도 해소될 수 있는 별개 변수 |
| Google 백엔드/할당량 상한 제거 | **라이브러리 코드로 불가능** | 할당량은 Google 정책·프로젝트 단위. 호출자 신원(OAuth 사용자 vs Service Account)에 따라 사용자별/프로젝트별 계정 방식이 달라질 수 있으나, 인증 선택만으로 상한이 사라지지 않음 |
| Sheets에 고처리량 트랜잭션/진정한 원자적 CAS 제공 | **보장 불가** | Sheets에 크로스-요청 serializable isolation·조건부 원자 쓰기가 없음 |
| 투영 실패가 로컬 서빙을 중단시키는 것 방지 | **아키텍처상 달성 가능** | 격리, 제한된 재시도, circuit breaking, 지속형 큐, 별도 헬스 신호 필요 |
| 정상 데이터를 Sheets에서 읽는 것 | **금지(설계 원칙)** | SQLite만 authority |

---

## 8. 최종 결정 순서와 운영 상태

### 8.1 결정 순서

1. **최소 Direct API 벤치마크부터** 실행한다(4.1절). 다른 최적화를 병행하지
   않는다. 게이트: 최소 경로가 요구 신선도/처리량 엔벨로프에 들어오는가.
2. **원시 Direct 경로는 빠른데 전체 동기화가 느리면** 라이브러리 프로토콜을
   최적화한다: 조회, 메타데이터, receipt, 사후조건, 재시도 폭풍, 배치/합치
   (coalescing). 이 단계에서 4.2절의 점진적 추가 측정이 게이트를 제공한다.
3. **최소 Direct 경로조차 요구 엔벨로프를 놓치면** 전송 튜닝을 중단하고
   6절의 델타/스냅샷/재구축(1~3순위)으로 이동하거나 Sheets의 역할을 재정의한다
   (4~8순위).
4. **수정된 투영이 여전히 제품 요구를 못 채우면** 지원 가능한 용량/신선도
   엔벨로프를 문서화하고 다른 운영 표면(전용 관리 UI, BigQuery/Connected
   Sheets 등)을 사용한다. 이 결정은 SLO-B를 명시적으로 재정의하는 것이며,
   SLO-A에는 영향을 주지 않는다.

### 8.2 운영 상태

로컬 헬스와 동기화 헬스를 **분리**해 노출한다.

- **로컬 헬스**: SQLite 읽기/쓰기 가용성과 지연. Google 상태와 무관하게
  `healthy`/`unhealthy`로 판정한다.
- **동기화 헬스**(`System_State` 투영 기준):
  - `healthy`: 백로그가 목표 범위, 마지막 성공이 최근.
  - `degraded`(지연): 백로그 증가 또는 마지막 성공 경과가 SLO-B를 초과.
  - `paused`(재구축): 6절 3순위 재구축 또는 회복 중. 쓰기는 계속 큐잉된다.
  - 또는 동등한 표현(예: lag 단계)을 사용한다.

**백로그 용량 경계**: 큐잉은 무한히 지속되지 않는다. 장기 장애로 유입 작업률이
처리 용량을 초과하면(λ > μ) 내구성 아웃박스가 SQLite/디스크 용량을 소진해
로컬 서빙에 영향을 줄 수 있으므로, 의미상 안전한 범위의 **제한된 보존/압축**, **admission/backpressure 또는 운영자 일시 중지**, **로컬 저장소 소진 전
경보**를 구성한다.

핵심 원칙: **투영이 degraded/paused여도 SQLite 읽기/쓰기는 계속 가능해야
한다.** 단, 이 격리는 **구성된 백로그/저장소 엔벨로프 안에서의 아키텍처
목표**이며 무한 보장이 아니다. 신호는 마지막 성공 시각, 현재 lag, 백로그
최고령 작업(age)을 포함한다.
이 상태 구분은 2026-08-03 clean smoke의 "아웃박스 미수렴 + 로컬 API 정상"을
운영상 정상적인 상태로 표현할 수 있게 한다: 로컬은 healthy, 투영은 degraded.

---

## 요약

- 로컬 서빙(SLO-A)과 원격 수렴(SLO-B)은 별개의 SLO다. Sheets 투영 실패는
  구성된 백로그/저장소 엔벨로프 안에서 로컬 서빙을 중단시키지 않는다(무한
  보장은 아님).
- 현재 증거는 원시 셀 쓰기가 아니라 디스패치/락/메타데이터/receipt/복구 경로가
  병목임을 가리킨다(`sync-bulk-write-benchmark.md`의 2026-07-24, 2026-07-27,
  2026-08-03, 2026-08-04 관측).
- Direct API는 Apps Script 특유의 전송/런타임 실패 클래스를 제거할 수 있으나,
  Google 할당량·지연·429/5xx·CAS 부재는 제거하지 못한다.
- 검증은 최소 배치 쓰기부터 시작해 점진적으로 프로토콜을 추가하는 사다리로
  진행하며, 모든 숫자 기대치는 가설 또는 채택 게이트다.
- 전송 최적화가 실패하면 델타/압축/재구축(`System_State` 머티리얼라이즈
  한정) → 범위 축소 → 분할 → SLO 완화 → 역할 재정의 순서로 폴백한다.
  할당량 회피를 위한 Service Account 다중화는 금지다.
- 최종 판정 기준은 "지원 가능한 용량/신선도 엔벨로프를 측정으로 증명하고
  문서화했는가"이며, 그 엔벨로프 밖의 요구는 다른 운영 표면으로 안내한다.
