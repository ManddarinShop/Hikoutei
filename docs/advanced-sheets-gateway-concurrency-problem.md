# Hikoutei Advanced Sheets Gateway 동시성/정합성 문제 해결 요청서

> 이 문서만 읽고도 현재 문제의 원인을 분석하고, 락 제거 여부와 대체 정합성 모델을 설계할 수 있도록 작성한 독립 문서다.

## 1. 해결해야 할 문제

Hikoutei는 SQLite를 애플리케이션의 authority로 사용하고, Google Sheets를 비동기 projection 및 human input surface로 사용한다. SQLite의 flush는 entity table, canonical sync state, durable Sheet effect outbox를 하나의 SQLite transaction으로 커밋한다. Google Sheets 원격 반영은 flush 이후 worker가 비동기로 수행한다.

현재 Apps Script Gateway write path에 Advanced Sheets `Sheets.Spreadsheets.batchUpdate`를 도입했다. 그러나 Locust 부하에서 Gateway latency와 오류가 급증한다.

핵심 질문은 다음이다.

> `batchUpdate`를 사용해도 Apps Script 전역 Script Lock과 원격 read/validate/write 구조 때문에 병목이 남는다. 전역 락을 제거하고 SQLite authority, effect receipt, CAS/fencing, durable outbox를 이용한 다른 정합성 모델로 바꾸는 것이 안전한가? 안전하다면 정확한 설계와 단계별 변경안을 제시하라.

단순히 락을 제거하는 패치를 제안하지 말고, 동시 append, response loss, retry, stale CAS, duplicate identity, multi-worker fencing을 모두 고려해야 한다.

---

## 2. 반드시 보존해야 하는 불변조건

1. **SQLite authority**
   - 애플리케이션은 정상 entity data를 Sheets에서 읽지 않는다.
   - Sheets는 비동기 projection이며 User_Input을 제외하면 사람이 직접 수정하는 source of truth가 아니다.

2. **Durable outbox**
   - 효과는 flush 시 SQLite outbox에 저장된다.
   - 메모리에 효과를 30초 이상 모아두지 않는다.
   - process crash 이후에도 pending/retry/recovery가 가능해야 한다.

3. **Effect idempotency**
   - effect ID와 payload hash가 receipt에 기록된다.
   - 같은 effect ID를 같은 payload로 재시도하면 `already_applied`/`applied`로 안전하게 회복해야 한다.
   - 같은 effect ID를 다른 payload로 재사용하면 fail-closed 해야 한다.
   - effect ID를 확인했다고 해서 row postcondition이 검증된 것으로 간주하면 안 된다.

4. **CAS와 fencing**
   - guarded update/delete는 expected visible revision/hash와 target evidence를 사용한다.
   - 오래된 worker나 lease를 잃은 worker가 원격 row를 덮어쓰면 안 된다.
   - SQLite writer lease와 effect lease의 fencing semantics를 보존해야 한다.

5. **Duplicate identity fail-closed**
   - business identity, `Conflict_ID`, physical anchor가 중복되면 자동 삭제하지 않는다.
   - 중복 row는 진단/quarantine 대상으로 남겨야 한다.

6. **Public boundary 유지**
   - `src/index.ts`와 public EntityManager API를 변경하지 않는다.
   - Apps Script `Code.gs` dispatcher/business logic은 현재 단계에서 변경하지 않는다.
   - SQLite authority, outbox, receipt, recovery semantics를 약화하지 않는다.

---

## 3. 현재 시스템 구조

### 3.1 Node/Application side

- Entity flush가 SQLite entity table과 canonical state를 저장한다.
- 같은 transaction에서 Sheet effect outbox를 만든다.
- `SyncEffectWorker`가 SQLite에서 effect를 claim하고 route별로 전송한다.
- worker는 adaptive batch controller를 사용한다.
  - coalescing window: 기본 500ms
  - 내부 effect batch 범위: 5~20
  - initial batch: 10
  - gateway의 공식 제한이 아니라 내부 방어 상한이다.
- effect lease 기본값은 120초, writer lease 기본값은 180초다.
- worker와 polling supervisor가 별도 경로로 Gateway에 요청한다.
- load harness의 `POST /__test/user-input`은 테스트용으로 `User_Input` row를 직접 수정하는 별도 control operation을 보낸다. 이것은 production effect가 아니다.

### 3.2 Apps Script Gateway

`apps-script/gateway/Code.gs`는 다음만 수행한다.

1. signed POST 검증
2. HMAC/body hash/time/sheet allowlist 검증
3. `applyOperations`의 serialized function source를 실행
4. 응답 JSON envelope 생성
5. 마지막에 `SpreadsheetApp.flush()` 호출

Data-plane의 `Code.gs` 자체는 일반 effect마다 Script Lock을 잡지 않는다. 다만 eval로 실행되는 operation source들이 `LockService.getScriptLock()`을 사용한다.

### 3.3 Operation source별 락

#### `batchAppendOperation.ts`

`LockService.getScriptLock()`을 잡은 뒤 다음 전체를 수행한다.

- target sheet와 header 확인
- receipt sheet 확인/생성
- 모든 receipt 읽기
- effect ID/payload hash 확인
- target sheet의 identity 중복 확인
- `lastRow` 계산
- Advanced Sheets `batchUpdate` 실행
  - row reservation
  - row cell write
  - developer metadata anchor 생성
  - receipt row 삽입/기록
- receipt/visible evidence 검증
- lock release

즉, lock critical section 안에 원격 read, 전체 receipt scan, identity scan, write가 모두 들어 있다.

#### `effectOperationScript.ts`

일반 update/delete/effect materialization도 `LockService.getScriptLock()`을 약 20초 timeout으로 잡고, effect별 precondition/read/write/receipt 처리를 수행한다.

#### `observationOperation.ts`

anchor assignment가 포함된 full observation은 Script Lock을 사용한다. 이 경로는 다음을 할 수 있다.

- registered range read
- Developer Metadata anchor 검색
- 누락 anchor 생성
- values/formulas/display values/merged range 읽기
- snapshot hash 생성
- duplicate anchor 진단

반면 `READ_SNAPSHOT_OPERATION_SOURCE`는 anchor mutation이 없는 read-only snapshot path로 만들기 위해 lock prologue/epilogue를 제거한 별도 source다.

---

## 4. 왜 `batchUpdate`만으로 문제가 해결되지 않는가

Advanced Sheets `batchUpdate`는 **하나의 API 요청 안의 request 배열을 원자적으로 처리**할 수 있다. 그러나 다음까지 보장하지 않는다.

- 서로 다른 두 HTTP 요청 사이의 serializable isolation
- read 후 write 사이의 compare-and-set
- effect ID/receipt의 unique constraint
- developer metadata anchor의 create-if-absent
- `lastRow` 계산의 동시성 안전성
- User_Input row에 대한 conditional update

예를 들어 두 요청 A/B가 동시에 다음을 수행하면 된다.

```text
A: receipt에 e1 없음
B: receipt에 e1 없음
A: identity u1 없음
B: identity u1 없음
A: lastRow = 100
B: lastRow = 100
A: row 101에 u1 append
B: row 101 또는 shifted row에 u1 append
```

각 요청의 `batchUpdate`는 내부적으로 원자적일 수 있어도, A와 B 사이의 unique identity 보장은 없다. 락을 완전히 제거하면 다음 문제가 가능하다.

- 같은 effect의 duplicate row
- 같은 business identity의 duplicate row
- 같은 anchor의 duplicate metadata
- receipt와 data row의 서로 다른 상태
- stale `User_Input` candidate overwrite
- response loss 이후 재시도 시 duplicate materialization

따라서 “`batchUpdate`이므로 전역 락을 그냥 삭제해도 된다”는 가정은 성립하지 않는다.

---

## 5. 관측된 실제 증상

### 5.1 이전 누적 상태 run

이전 run은 stale SQLite/Sheet state와 duplicate/failure effect가 섞여 있었다.

- 2,648 requests
- HTTP failure 12.61%
- Gateway p50 4.34초
- Gateway p95 34.25초
- 최대 60.01초

이 run은 신규 구현의 공정한 성능 비교로 사용하면 안 된다.

### 5.2 Fresh run

- 날짜: 2026-08-03
- branch: `perf/adaptive-sync-performance`
- fresh SQLite 및 fresh `System_State`, `User_Input`, `Sync_Conflicts` tabs
- Locust: 10 users, spawn rate 2/s, 60초
- command:

```sh
locust -f .local/locustfile.py \
  --host http://127.0.0.1:8787 \
  --headless \
  --users 10 \
  --spawn-rate 2 \
  --run-time 60s \
  --csv .local/locust-20260803-231300-clean2 \
  --html .local/locust-20260803-231300-clean2.html \
  --only-summary
```

Locust 결과:

| Endpoint | Requests | Failures | p50 | p95 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET /users/:id` | 134 | 0 | 2ms | 4ms | 6ms |
| `POST /users` | 81 | 0 | 5ms | 6ms | 19ms |
| `PATCH /users/:id` | 76 | 0 | 5ms | 8ms | 22ms |
| `POST /__test/user-input` | 38 | 8 | 2.2s | 31.0s | 31.9s |
| **Total** | **339** | **8 (2.36%)** | **4ms** | **2.3s** | **31.9s** |

서버-side Gateway snapshot은 workload 종료 후 background worker/polling을 포함해 다음과 같았다.

- Gateway requests: 100
- Gateway failures: 34
- Gateway p50: 3.71초
- Gateway p95: 33.47초
- Gateway max: 60.00초
- outbox: `pending 306`, `processing 8`, `applied 2`, `superseded 2`

주요 오류:

- `Code.gs response was not valid JSON`
- `Code.gs operation request timed out`
- 이전 run에는 `Could not acquire the sync observation gateway lock`도 관측됨

Fresh server startup 중에도 Gateway가 간헐적으로 HTTP 404/non-JSON을 반환했다. idle 상태에서 단일 signed no-op probe를 순차 실행하면 성공하기도 했으므로, 단순한 함수 문법 오류보다 원격 실행 queue/lock/transport/deployment 상태를 분리해 조사해야 한다.

### 5.3 해석

이 run은 다음을 보여준다.

- local SQLite/entity flush 경로는 낮은 latency로 동작한다.
- entity create/read/update HTTP API는 실패하지 않았다.
- Gateway boundary는 10-user 정도의 mixed workload에서도 tail latency와 non-JSON/timeout을 보였다.
- `User_Input` test control path가 stage-1 bulk append benchmark와 섞여 결과를 오염시켰다.
- outbox가 workload보다 빠르게 drain되지 않았으므로 성공적인 성능 benchmark가 아니다.

따라서 현재 결과만으로 `batchUpdate` 자체의 throughput이나 correctness를 판정할 수 없다. 하지만 Gateway의 concurrency/transport 병목은 실제로 존재한다.

---

## 6. 해결책을 설계할 때 반드시 분리할 문제

### A. Transport/deployment 문제

다음은 Script Lock 제거와 별개일 수 있다.

- HTTP 404
- redirect 뒤 non-JSON response
- Apps Script execution timeout
- deployed Code.gs 버전/manifest/Advanced Sheets service 불일치
- Gateway quota 또는 transient execution failure

먼저 no-op signed operation, provisioning operation, single append operation을 각각 독립적으로 측정해야 한다.

### B. Script Lock 경합

다음은 현재 전역 Script Lock으로 직접 악화될 수 있다.

- effect operation이 receipt/identity 전체 scan 중인 동안 observation이 대기
- full metadata observation이 anchor/hash를 계산하는 동안 append가 대기
- 20초 `tryLock` timeout과 60초 HTTP timeout이 겹침
- polling, outbound worker, test control operation이 동일 spreadsheet/script에 동시에 접근

### C. 락 제거 시 생기는 정합성 문제

락을 삭제하면 해결되는 latency와 새로 생기는 correctness failure를 구분해야 한다.

- lock-free append에서 duplicate identity를 어떻게 막을 것인가?
- receipt의 create-if-absent를 어떻게 보장할 것인가?
- `lastRow`/row reservation race를 어떻게 처리할 것인가?
- stale CAS를 어떻게 원격에서 거절할 것인가?
- response loss 후 같은 effect의 duplicate row를 어떻게 방지할 것인가?
- 여러 Node process가 동시에 같은 spreadsheet를 dispatch할 때 어떻게 fencing할 것인가?

---

## 7. 우선 검토할 대체 설계

아래 설계를 비교하고, 더 나은 설계가 있다면 이유를 제시하라.

### 설계안 1: SQLite durable single remote writer

- spreadsheet/route별 remote dispatch ownership을 SQLite writer lease로 결정한다.
- lease holder만 해당 spreadsheet의 mutation Gateway call을 보낸다.
- 효과를 메모리에 오래 모으지 않고, SQLite outbox에서 bounded batch만 읽어 보낸다.
- process가 죽어도 outbox가 남으므로 재시작 후 recovery한다.
- 같은 process의 worker/polling/test control이 Gateway로 직접 병렬 mutation을 보내지 않게 한다.
- remote lock을 제거하거나 최소화하고, serialization을 SQLite authority 쪽으로 옮긴다.

검토할 것:

- polling read는 mutation writer와 병렬화해도 되는가?
- full observation의 anchor mutation은 어느 lane에 넣어야 하는가?
- 여러 Node process의 writer lease fencing이 충분한가?
- lease 만료 중 remote call이 끝나는 경우 response-loss/postcondition 처리는 어떻게 하는가?

### 설계안 2: operation class별 락

- 순수 values/read snapshot: lock-free
- append-only `System_State`/`Sync_Conflicts`: 별도 mutation lane 또는 짧은 route별 serialization
- CAS update/delete/User_Input: 당분간 serialization 유지
- full metadata/anchor assignment: 낮은 빈도의 별도 safety lane

Apps Script `LockService`에는 일반적인 arbitrary route key lock이 없으므로, “route별 lock”을 제안할 경우 실제 구현 방식(SQLite lease, PropertiesService, sheet lease row 등)의 원자성과 crash recovery를 설명해야 한다.

### 설계안 3: append-only command/effect ledger

Sheet에 직접 unique row를 materialize하기보다 effect command/receipt를 append-only로 기록하고, 단일 materializer가 projection row를 만든다.

장점:

- append-only write가 row update보다 단순하다.
- replay와 audit가 쉽다.

단점:

- ledger 자체의 duplicate effect ID 방지 문제가 남는다.
- materializer가 결국 단일 writer가 되어야 한다.
- 기존 Sheet 사용자-facing layout과의 migration 비용이 크다.

### 설계안 4: optimistic concurrency/version column

각 row에 revision/version을 두고 expected version을 같이 전송한다.

단, Google Sheets Advanced API의 `batchUpdate`가 서버-side conditional compare-and-set을 제공하는지 확인해야 한다. 단순히 version을 읽은 뒤 update하는 것은 CAS가 아니다. 실제로 조건부 update를 보장하지 못한다면 User_Input guarded path의 정합성 대체안으로 인정하지 않는다.

---

## 8. 권장 단계

1. **Gateway 단독 안정성 확인**
   - signed no-op 10회
   - provisioning/read 10회
   - 단일 append 1회
   - status, redirect, body classification, execution duration 기록

2. **단일 effect correctness 확인**
   - `System_State` append
   - receipt 확인
   - 같은 effect replay
   - payload hash mismatch
   - response loss simulation
   - duplicate identity simulation

3. **stage-1 benchmark 분리**
   - Locust에서 `User_Input` control traffic 제외
   - `System_State`와 `Sync_Conflicts` outbound path만 측정
   - batch 1/5/10/20 sweep
   - workload window와 background drain window를 분리

4. **concurrency correctness 확인**
   - 같은 effect ID 동시 2회
   - 서로 다른 effect의 동시 append
   - 같은 business identity 동시 append
   - full observation과 append 동시 실행
   - worker lease expiry 중 원격 response 도착

5. **User_Input 별도 검증**
   - guarded update/delete의 stale candidate 거부
   - remote candidate 재관찰/quarantine
   - CAS path를 lock-free로 바꿀 수 있는지 별도 판단

6. **최종 Locust**
   - fresh SQLite/tabs
   - 한 writer/한 Gateway deployment
   - Gateway p50/p95/max
   - non-JSON/timeout 비율
   - lock wait
   - pending/processing/applied/failed/superseded/blocked_candidate
   - outbox drain rate와 effect creation rate 비교

---

## 9. 금지해야 할 단순 해결책

다음 제안은 충분한 정합성 증명 없이는 채택하지 않는다.

- `LockService`를 모두 삭제하고 retry만 추가
- `batchUpdate`이므로 cross-request CAS도 된다고 가정
- duplicate identity를 자동 삭제
- receipt에 effect ID만 있으면 성공으로 판정
- timeout을 늘려 lock contention을 숨김
- pending effect를 메모리에 모아 Gateway latency를 숨김
- User_Input 실패를 전체 benchmark에서 제외하고 성공으로 보고
- 404/non-JSON을 단순 retry로만 처리
- public API나 `Code.gs` dispatcher를 변경해 내부 병목을 숨김

---

## 10. 답변을 작성할 GPT에게 요구하는 결과

다음 형식으로 답하라.

1. **Root cause 분리**
   - Script Lock contention
   - Apps Script/HTTP transport/deployment instability
   - read/validate/write race
   - worker scheduling contention
   을 각각 어느 증거가 지지하는지 설명하라.

2. **추천 consistency model**
   - 어떤 경로에서 lock을 제거하는가?
   - 무엇이 SQLite에서 serialize되는가?
   - 어떤 경로는 왜 lock/CAS가 여전히 필요한가?
   - response loss와 duplicate identity를 어떻게 처리하는가?

3. **상태 전이와 fencing**
   - outbox status
   - writer lease
   - effect lease
   - remote receipt
   - postcondition
   사이의 정확한 전이를 제시하라.

4. **구체적인 코드 변경 위치**
   - 변경할 파일
   - 변경하지 않을 파일
   - operation source의 critical section
   - worker dispatch/scheduler
   - 필요한 schema/telemetry
   를 명시하라.

5. **실패 주입 테스트**
   - timeout
   - HTTP 404/non-JSON
   - response loss
   - lock contention
   - concurrent append
   - stale CAS
   - duplicate identity
   를 재현하고 기대 결과를 정의하라.

6. **성능 측정 계획**
   - stage-1과 stage-2를 분리하라.
   - setup/no-setup/steady-state/drain을 분리하라.
   - 성공률뿐 아니라 outbox convergence와 correctness를 포함하라.

7. **채택 기준과 rollback 기준**
   - 어떤 수치와 invariant를 만족해야 lock-free 또는 reduced-lock 설계를 채택하는가?
   - 어떤 오류가 발생하면 기존 안전 경로로 rollback하는가?

핵심은 **락을 무조건 제거하는 것**이 아니라, Apps Script의 긴 전역 critical section을 줄이면서도 SQLite authority, durable outbox, effect receipt, CAS/fencing, duplicate fail-closed를 유지하는 것이다.
