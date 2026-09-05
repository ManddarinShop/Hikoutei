# 데모 버스트 부하 테스트 결과

## 메타

- **일자**: 2026-09-04
- **브랜치**: `test/demo-load-test` (기반: `origin/develop` @ `307d96e`, v0.9.28)
- **라이브러리**: hikoutei 0.9.28 (3차 테스트는 로컬 빌드 + 병목 수정 포함)
- **목적**: 초당 1,000개 쓰기 버스트에 대한 SQLite 인입 경로 + Sheets projection 처리량 측정

## 환경/백엔드

- 데모 서버: `website/demo/server` (Express, port 3101, `tsx src/server.ts`)
- 웹사이트: `website/` VitePress dev (port 5173, `/Hikoutei/demo`)
- 엔티티: `DemoRequest` (id/label/amount/processed 4칼럼, 테이블 `demo_requests`)
- Sync 모드: 서비스 계정 `(demo service account)` + 스프레드시트 `(demo spreadsheet)`
- Local 모드: Google 인증 없이 SQLite만 (sync state/outbox 없음)

## 시나리오/스크립트

- `POST /api/burst { "count": 1000 }`을 1초 간격으로 반복 (`/tmp/hikoutei-burst.mjs` 30회, `/tmp/hikoutei-burst-15s.mjs` 15회)
- 시작 전 `POST /api/reset`으로 메트릭 리셋
- 스냅샷: `GET /api/stream` (SSE) `event: snapshot` 1초 간격 (`outbox.pending`, `deliveryUncertain`, `failed`, `completedTotal`, `p50/p95`, `syncLagSec`, `healthScore`)
- 드레이닝 속도 = pending 감소량 / 스냅샷 간격(초)

## 결과

### 1차: local 모드, 30초 × 1,000/s = 30,000개 (수정 전 코드)

| 지표 | 값 |
|---|---|
| 수락 | 30,000 / 30,000 (실패 0) |
| 완료 (SQLite) | 30,000, queueDepth 0 |
| p50 / p95 지연 | 0ms / 1ms |
| healthScore | 100 |

### 2차: sync 모드, 30초 × 1,000/s = 30,000개 (수정 전 코드)

| 지표 | 값 |
|---|---|
| 수락 | 30,000 / 30,000 (실패 0) |
| 완료 (SQLite) | 30,000, queueDepth 0 |
| p50 / p95 지연 | 2ms / 4ms |
| 아웃박스 초기 pending | ~56,000 (엔티티당 2 effect: SYSTEM_STATE + candidate_reconcile) |
| 드레이닝 속도 | **~47/s → ~25/s** |
| deliveryUncertain / failed | ~800–900 순환 / 0 |
| syncLag | ~2분, healthScore 60 |

### 3차: sync 모드, 15초 × 1,000/s = 15,000개 (병목 수정 적용 후)

| 시각 | pending | uncertain | failed | syncLag | health |
|---|---|---|---|---|---|
| 버스트 종료 직후 | 28,900 | 1,000 | 0 | 67s | 60 |
| +30s | 28,900 | 1,000 | 0 | 99s | 60 |
| +60s | 24,183 | 651 | 0 | 131s | 60 |
| +95s | 21,398 | 447 | 0 | 163s | 60 |
| +140s | 14,708 | 0 | 0 | 207s | **100** |

| 지표 | 값 |
|---|---|
| 수락 | 15,000 / 15,000 (실패 0, 단 응답 밀림으로 실제 주입 구간 ~59초) |
| 완료 (SQLite) | 15,000, queueDepth 0, p50 3ms / p95 6ms |
| 안정 구간 드레이닝 속도 | **~150/s** (147/s, 87/s, 152/s) |
| failed | 0 유지, uncertain 0으로 완전 소진, health 100 회복 |

### 준비 제외 steady-state 비교 (핵심)

| | 수정 전 (2차) | 수정 후 (3차) |
|---|---|---|
| Sheets projection 드레이닝 | ~47/s → ~25/s | **~150/s** |
| failed | 0 | 0 |
| health 회복 | 60 유지 | **100 회복** |

SQLite 인입 경로(p50 2–3ms, p95 4–6ms)는 sync on/off와 무관하게 안정적. 병목은 전적으로 Sheets projection 아웃박스 드레이닝에 있었음.

## 병목 분석 요약

- 각 INSERT → 2 effect (`SYSTEM_STATE` + `candidate_reconcile`). 후자는 fast-append 자격이 없어(`isFastAppendEffect`, `dispatcherSupport.ts`) 전량 일반 CAS 경로로 감.
- 일반 경로는 배치당 write-lane 슬롯 2~3개 소모 (batchUpdate 쓰기 + inline 검증 읽기 + 영수증 쓰기) × 800ms request-start 페이싱 → ~47/s. 실측과 일치.
- Read 쪽(preflight 밴드 분산, 98.9% 페이로드 압축, 폴링 축소)은 이전 작업에서 이미 최적화됨. 병목은 write-lane 경합.

## 적용한 수정

- `packages/sheets/src/sheets/providers/google-sheets-api/operations/applyEffects.ts`
  inline 검증 읽기의 request-start 페이싱을 `"write"` → `"preflight"`(read-lane)로 이동.
  워커가 단일 스레드 직렬이라 write→verify 순서는 그대로 보장되어 CAS 안전성 유지.
  배치당 write-lane 슬롯 3 → 2.
- 검증: `npm test` 2144 passed, `typecheck` + `build` 통과.
- 정정: 초기 "약 2배" 추정은 과장이었음. 슬롯 기준 3→2 = 1.5배가 이론치이며, 실측 ~3배(47/s → 150/s)에는 read-lane 병렬 처리와의 시너지가 포함된 것으로 보임. 기여도 분해는 추가 계측 필요.
- `test/request-telemetry.test.ts`의 "inline 검증 읽기가 write-lane을 먹인다"는 주석은 수정 후 사실이 아님 (테스트는 cold-start 영수증 refresh 1회로 통과). 주석 업데이트 필요.

## 기존 caveat

- 2차와 3차는 버스트 규모가 다름 (30,000 vs 15,000). 탭 크기·밴드 읽기 비용이 달라 드레이닝에 영향을 줄 수 있어 1:1 동일 조건 비교는 아님.
- 3차 주입이 15초가 아닌 ~59초에 걸쳐 일어남 (POST 응답 밀림). 순수 15초 버스트가 아님.
- 3차 초반 ~30초간 pending 정체 (워커 미가동 구간). 원인 미확정.
- 라이브 Google Sheets API 할당량·네트워크 변동이 포함된 실측치. 동일 조건 재현 시 편차 가능.
- 라이브 Google 연동은 opt-in 수동 검증扱い. 통상 검증은 fake provider + SQLite/MikroORM fixture 사용.

# 후속 라운드 (4차~8차, 2026-09-04)

이전 문서(1~3차, v0.9.28) 이후, HEAD 코드로 동일 조건(30초 × 1,000/s = 30,000 INSERT)을 반복 측정하며 병목을 단계적으로 제거했다. 기준 브랜치: `refactor/unified-write-engine` (PR #460), 회귀 테스트 PR #461.

## 코드 변경 요약 (4~8차 사이)

1. **write 경로 통합** — `writeEngine.ts`: 흩어진 batchUpdate 호출 5곳 → 1개 executor, receipt-init 가드 1개 (행위 보존, net −99줄).
2. **AIMD 거버너** — 429 관측 시 레인 간격 ×2 (캡 4배), 조용해지면 회복. opt-in 시작 예산(기본 Infinity = 무변경).
3. **AIMD 회복 가속** — ÷1.1 × 60초 조용창(최대 16분) → ÷2 × 10초 (2스텝 복귀).
4. **워커 배치 컨트롤러 완화** — 고-latency 임계 30s → 120s, 성장 +5/3성공 → +25/2성공, 상한 300 → 1,000. 건강한데 느린 사이클이 배치를 절임당하던 것을 제거.
5. **SA 자격증명 풀** — SA = 별개 유저 principal이므로 N개 SA = N×60/min. transport 내부 라운드로빈 + 인덱스별 페이서/AIMD. CAS/워커/영수증 로직 무변경. `HIKOUTEI_SYNC_CREDENTIALS` env 배선.
6. **계측** — `createTypedSheets`에 `providerOptions` 공개, 데모 `/api/health`에 requestTelemetry (429/5xx/refused/연산별/레인별/SA 인덱스별/분당 버킷). Cloud Console 없이 429를 실시간 관측 가능.

## 4차: HEAD 코드, 1 SA (30k) — 실패 확정과 근본 원인 3개

| 지표 | 값 |
|---|---|
| SQLite 인입 | 30,000/30,000, p50 2ms / p95 5ms |
| drain | 초반 ~100/s → **~17/s 감속**, 14.6k 정체 |
| failed | **220** (`delivery_uncertain_timeout`) 고착 |
| uncertain | 255 (`lease_expired_requires_postcondition`) |

클라우드 모니터링 판독으로 확정한 진단:

- **429 만성 발생** — 요청의 4.67%가 429. 프로젝트 쿼터(300/min, 피크 23%)는 여유였고, 실제 천장은 **per-user read 60/min**.
- **읽기:쓰기 = 13:1** (GetSpreadsheet 8,306 vs BatchUpdate 639). BatchUpdate 에러 0% — 쓰기 경로 무죄.
- 죽음의 나선: 읽기 수요가 60/min 초과 → 429 → uncertain → 프로브 읽기 추가 → 읽기 더 증가 → … → 운 나쁜 head가 uncertain 타임아웃으로 hard-fail. deferred 전환의 닫힘이 프로브 읽기 예산에 의존하는 구조적 약점이 쿼터 초과와 만나 발현.

## 5차: AIMD 거버너 적용 (1 SA) — 회복 지연 발견

429 5회를 흡수해 uncertain/failed 0, health 100 유지. 그러나 drain이 0.25/s로 크롤. 원인: 회복이 ÷1.1 스텝마다 새 60초 조용창을 요구 → 4배 백오프에서 1배 복귀에 **~16분**. Google의 per-minute 쿼터는 창이 흐르면 즉시 풀리므로 우리 회복이 병목이었음.

## 6차: AIMD 회복 수정 (1 SA) — 두 번째 조절기 발견

회복 가속(÷2×10초) 후에도 크롤 (~5/s). 429=0, 요청 40/min (한도 여유), pacingWait 거의 없음 → 시트 API는 한가한데 배치당 effect가 ~77개뿐. 진범: **워커 `AdaptiveEffectBatchController`** — 30초 초과 사이클마다 배치 절반, 성장 +5/3성공. 탭이 커질수록 건강한 사이클도 30초를 넘어 영구 절임 압력. "3만 리미트"처럼 느껴진 정체는 행 수 한도가 아니라 fast-append 레인 소진 후 CAS 배치 절임 시작 지점.

## 7차: 배치 컨트롤러 완화 (1 SA) — 쿼터 천장 수렴 확인

120s 임계 + 가속 성장으로 drain이 5/s → 진동 15-50/s. 배치 성장(300→1,000) → 배치당 읽기 수요 재증가 → 60/min 천장 도달 → 429 몇 회 → AIMD 백오프 → 회복 → 재가속의 **완전한 진동 주기**가 관측됨. failed 0, health 100 유지 — 죽지 않고 천장에 붙어 전진하는 정상 상태. 26분 시점 12.7k 잔여로 종료 (8차 대조군 데이터로 활용).

## 8차: 5-SA credential pool (30k) — 완료

SA 4개 추가 발급(각자 고유 uniqueId = 별개 유저), 전부 시트 writer 공유, 5-인덱스 풀 구성.

| 지표 | 값 |
|---|---|
| drain | **안정 ~55/s** (진동 없음) |
| 완료 | **60,000/60,000 applied, ~18.5분** |
| 429 | **0** (수요가 5 버킷에 분산돼 각 SA ~26/min — 60 한도의 절반) |
| failed / uncertain | 0 / 0 |
| health | 100, lag 0 |
| SA 분산 | byCredential 309/309/309/309/308 (완벽 균등) |
| 총 요청 | 1,544회 ≈ 79/min 합산 (프로젝트 한도 300/min의 26%) |

## 라운드 비교 (동일 30k 버스트)

| 구성 | drain | 429 | 완료 |
|---|---|---|---|
| 4차: 1 SA, 개선 전 | 크롤 ~17/s | 다수 (4.67%) | ❌ 220 hard-fail |
| 5차: + AIMD | 크롤 0.25/s | 5 흡수 | ❌ 회복 지연 |
| 6차: + 회복 가속 | 크롤 ~5/s | 0 | ❌ 배치 절임 |
| 7차: + 배치 완화 | 진동 15-50/s | ~37 흡수 | ❌ 12.7k 잔여 |
| **8차: 5-SA 풀** | **안정 ~55/s** | **0** | ✅ **18.5분 완료** |

SQLite 인입은 전 라운드 공통으로 무결 (p50 2ms, 실패 0) — 병목은 전부 Sheets projection 경로.

## 새 caveat

- 4~8차는 모두 동일 조건 (fresh 시트, fresh DB, 30초 × 1,000/s) — 1~3차와는 버전/코드가 달라 직접 비교 불가.
- 5개 SA × 60 = 300/min로 프로젝트 총량 상한에 정확히 포화. 이 이상 확장은 쿼터 상향 신청 필요.
- SA 키 5개 운영 부담: 키 파일 유출 관리(gitignore + 600), 만료/교체 절차 별도.
- 다음 병목 후보: 배치 사이클 시간 (proc 300 상시, ~11 batch/min) → 읽기 증폭 축소(13:1 → 목표 한 자릿수)가 다음 레버.
- AIMD 거버너·배치 컨트롤러 상수는 8차 단일 시나리오에서 튜닝된 값 — 다른 워크로드(다중 루트, 낮은 트래픽)에서 재검증 필요.
# 후속 라운드 (9차~11차, 2026-09-04 밤): 동시성·배치·읽기예산

8차(5-SA 풀, ~18.5분) 이후 직렬 워커 병목을 세 단계로 분해·제거했다. 조건: 동일 30k 버스트, 5-SA 풀, `maxConcurrentUnits=2`.

## 9차: 동시 유닛 디스패치 (`maxConcurrentUnits=2`) — 천장 재확인

패스 내 루트-disjoint 유닛 동시 실행 (route-busy 키 집합 게이트, fast-append 멀티탭 합집합 포함, 루트 내 FIFO 보장). 결과: ~15-17분 완료, 8차 대비 ~1.15배. 총 요청 2,565 (8차 3,079 대비 감소). 교훈: 병렬화는 활성 루트 수만큼만 효과가 있고, System 루트 소진 후 지배적 구간이 **단일 루트(Input CAS)**라 Amdahl 한계가 즉시 드러났다. 총 요청이 오히려 감소(같은 일을 겹쳐서) — 병렬화의 효과는 대기 은닉이다.

## 10차: 읽기 예산 정화 — 읽기도 병목이 아니었음

9차 텔레메트리 분해: reads 2,416 = **polling 1,115 + preflight 1,315** + write 151. polling이 45% — 원인은 `POLLING_FULL_SCAN_INTERVAL_MS`(60초) = polling 간격(60초)이라 **매 패스마다 15k행 Input 탭 전체 세이프티 스캔**이 같은 쿼터를 소모. 테스트로 polling/full-scan 간격을 10분으로 올려 reads를 1,172로 절반화 (+배치 성장 +50/1성공). 결과: 완료했으나 **속도 무변화** — 읽기도 병목이 아니었다는 것을 배제하는 데이터.

## 11차: `EFFECT_BATCH_LIMIT` 하드캡 발견과 제거 — 9분 완료

10차에서 proc=300 상시 → 정범은 adaptive 컨트롤러가 아니라 **워커 `EFFECT_BATCH_LIMIT = 300` 하드캡** (Input 루트 = 100배치). 1,000으로 상향 후:

| 지표 | 8차 (대조) | **11차** |
|---|---|---|
| drain 완료 | ~18.5분 | **~9분 (2배)** |
| 총 요청 | 3,079 | **676** (1/4.5) |
| reads:writes | 21:1 | 8.3:1 |
| proc (배치 크기) | 300 | **1,000** |
| 429 / failed / health | 0/0/100 | **0/0/100** |

드레인율 ~110/s 평균 (중간 구간 ~94/s). SA당 읽기 ~14/min — 한도(60/min)의 4분의 1, 추가 여유 잔존.

## 병목 제거 여정 (4차→11차)

| 병목 | 발견 수단 | 수정 |
|---|---|---|
| deferred probe 기아 (220 hard-fail) | Cloud Console 429 역추적 | AIMD 거버너 |
| AIMD 회복 지연 (16분) | 5차 크롤 실측 | ÷2×10s 가속 |
| 워커 배치 절임 (건강한 사이클) | 6차 429=0인데 크롤 | 120s 임계 + 가속 성장 |
| 쿼터 천장 (per-user 60/min) | 쿼터 피크 23% vs 유저한도 초과 | 5-SA credential pool |
| 직렬 워커 (SA 미사용) | 8차 SA당 26/min | 동시 유닛 디스패치 |
| polling 전체스캔 (읽기 45%) | 9차 텔레메리 분해 | env 간격 제어 |
| **배치 하드캡 300** | 10차 proc=300 상시 | **EFFECT_BATCH_LIMIT 1,000** |

## 남은 것

- 읽기 증폭 (8.3:1) 추가 축소 — SA 읽기 ~14/min, 여유 4배 잔존.
- polling full-scan이 드레인과 쿼터를 경쟁하는 구조 — outbox 포화 시 인바운드 폴링 자동 스로틀 (제품 기능, 별도).
- 튜닝 상수들은 30k 단일 시나리오 검증치 — 다른 워크로드 재검증 필요.

# 후속 검증: 랜덤 시나리오 소크 (12차·13차, 2026-09-05)

데모 버스트(단일 엔티티)의 편향을 보정하기 위해 멀티테이블 랜덤 시나리오 소크를 도입: 6개 엔티티, 액터 4, 사이클당 ~104 ops, 라이브 모드. 시드 고정(20260905)으로 A/B 비교. **12차 = feature 브랜치(5-SA 풀, 동시 3, 배치 1,000), 13차 = origin/develop 대조군(1 SA, 직렬, 배치 300).**

## 결과 비교

| | 12차 (feature) | 13차 (develop 대조) |
|---|---|---|
| 생존 사이클 | **7** (728 ops) | 2 (209 ops) |
| 연산 실패 / 수렴 | 0 / **7-7 통과** | 1 / 1-1 통과 |
| 시나리오 실패 | 11건 후 임계 종료 | **5건 만에 임계 종료** |
| 실패 시나리오 | human-edit 계열 (다양) | **동일 시나리오·동일 테이블** |

## 판정

1. 시나리오 실패(invalid-human-input, multi-field-human-edit, no-op-human-edit 등)는 **develop에도 존재하는 사전 존재 문제** — 동일 시드로 동일 지점 실패. credential pool·동시 디스패치·배치 1,000 변경 무관.
2. feature 브랜치가 **3.5배 더 진행** 후 임계 도달 — 새 안정성 장치(거버너·풀·동시성)가 이 환경에서 더 안정적이었음.
3. 소크의 라이브 멀티테이블 CLI 경로는 워크스페이스 재구성 이후 `distFallback` 스테일 경로로 실행 불가 상태였음 — 이번에 최초 실측. **human-edit 시나리오의 `scenario-error` 정밀 분석은 별도 과제** (내부 로그: feature `projection_outbox_blocked` ×1, develop `transport.request_failed` ×31).
