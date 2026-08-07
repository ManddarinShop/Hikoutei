# 내부 정합성 모델 — CAS·epoch·fencing·outbox·conflict

> 이 문서는 Hikoutei 동기화 엔진이 "동시 쓰기·응답 유실·사용자 편집 충돌"을 어떻게
> 안전하게 처리하는지, 내부 메커니즘(compare-and-set, epoch, fencing, outbox 상태
> 머신, candidate 보호)을 코드 기준으로 설명한다. 새로운 설계 결정이나 동작 변경을
> 포함하지 않으며, [`design/sqlite-authoritative-sync-target-design.md`](../design/sqlite-authoritative-sync-target-design.md)의
> 고정 정책을 코드가 어떻게 구현하는지 정리한 문서다.
>
> 관련 문서: [`architecture.md`](architecture.md) · [`write-and-synchronization-flow.md`](write-and-synchronization-flow.md) ·
> [`observation-flow.md`](observation-flow.md) · [`recovery-flow.md`](recovery-flow.md)

## 1. 핵심 철학: 시간이 아니라 "증거"로 판정한다

동기화 엔진의 모든 판정은 **wall-clock 시간을 믿지 않고** (revision, hash, epoch,
token) 같은 증거 값의 비교로만 내려진다. 이는 target design의 고정 정책
2번("wall-clock, trigger 실행 시각, event ID 문자열 순서는 승자 기준이 아니다")의
구현이다.

```text
판정 입력: expectedVisibleRevision / visibleHash / candidate_epoch / writer_epoch / fencing_token
판정 방식: 저장된 현재 값과 "요청이 기대하는 값"의 일치 비교 (CAS)
판정 결과: 일치 → 진행 / 불일치 → 거부 또는 conflict
```

시간이 개입하는 곳은 lease 만료 같은 **수명 관리**뿐이고, 승자 결정에는 쓰이지
않는다.

## 2. 단일 writer 보장 — writer lease, epoch, fencing token

구현: [`src/infrastructure/storage/sync/shared/writerLease.ts`](../src/infrastructure/storage/sync/shared/writerLease.ts)

### 2.1 구조

```sql
writer_lease(role, writer_id, writer_epoch, fencing_token, lease_until)
```

- `role`: writer 역할 구분 (예: `sync-effect-worker`)
- `writer_id`: worker 식별자
- `writer_epoch`: takeover 때마다 **단조 증가**하는 세대 번호
- `fencing_token`: `fence-{writerEpoch}:{writerId}` — epoch가 같아도 서로 다른
  writer가 같은 token을 가질 수 없다
- `lease_until`: lease 만료 시각

### 2.2 claim / renew / takeover

| 상황 | 동작 |
|---|---|
| lease 없음 | INSERT (epoch 1) |
| 같은 writer + lease 유효 | RENEW (`lease_until` 연장) |
| 다른 writer + lease 유효 | **거부** (`active_writer`) |
| lease 만료 | **TAKEOVER** — `epoch + 1`, 새 fencing token 발급 |

### 2.3 fencing: 모든 SQLite mutation의 가드

모든 저장소 mutation은 다음 조건이 참일 때만 적용된다:

```sql
WHERE ... AND EXISTS (
  SELECT 1 FROM writer_lease
  WHERE role = ? AND writer_epoch = ? AND fencing_token = ? AND lease_until > ?)
```

옛 epoch/token을 가진 worker의 쓰기는 **대상 행이 바뀌지 않았더라도** 거부된다.
단, 이 lease는 원격(Sheets) 요청을 중단시키지 못하므로, 원격 쓰기의 fence는
3장의 spreadsheet authority가 담당한다.

## 3. 원격(Sheets) 쓰기 보호 — spreadsheet authority + visible-hash CAS

구현: [`src/infrastructure/storage/sync/shared/spreadsheetAuthority.ts`](../src/infrastructure/storage/sync/shared/spreadsheetAuthority.ts) ·
[`src/adapter/sheets/providers/google-sheets-api/model/planner.ts`](../src/adapter/sheets/providers/google-sheets-api/model/planner.ts) ·
[`src/application/sync/outbound/effects/SyncEffectWorkerTransitions.ts`](../src/application/sync/outbound/effects/SyncEffectWorkerTransitions.ts)

### 3.1 spreadsheet authority

SQLite의 writer epoch/token이 `spreadsheet_authority(spreadsheet_id, owner_id,
authority_epoch, authority_token)`로 원격에 내려가고, **모든 원격 mutation 요청에
authority(epoch/token)가 실려** 간다. 갱신은 epoch CAS로:

```sql
UPDATE spreadsheet_authority
SET owner_id = ?, authority_epoch = ?, authority_token = ?, updated_at = ?
WHERE spreadsheet_id = ? AND authority_epoch <= ?
```

옛 epoch 요청은 거부되고, 새 writer만 원격 권한을 승계한다.

### 3.2 visible-hash CAS (provider)

effect는 `expectedVisibleRevision` + `expectedVisibleHash`(또는 신규 행은
`createIfMissing`)를 들고 provider에 도착한다. provider는 **read → hash 비교 →
write** 순서로 진행한다:

```text
현재 셀 읽기 → visible hash 계산
  ├─ expectedVisibleHash와 일치 → write + receipt(visibleRevision+1, 새 visibleHash)
  └─ 불일치 → guard_mismatch (worker가 conflict/blocked_candidate로 처리)
```

- 신규 append는 `expectedVisibleRevision = 0` + `expectedVisibleHash = ""` +
  `createIfMissing = true`일 때만 fast append로 진행된다.
- worker는 receipt의 `visibleHash === effect.payload.targetVisibleHash`를
  **다시 검증한 뒤에만** outbox effect를 `applied`로 닫는다.
- "applied라고 응답했지만 receipt 증거가 없다"는 응답 유실로 취급되어 재조회
  (postcondition probe) 경로로 들어간다.
- `computeSyncVisibleHash(fields) !== payload.targetVisibleHash` 같은 payload
  자체 검증도 provider에서 수행된다.

## 4. outbox 상태 머신 — claim CAS, 순서, lease, 응답 유실

구현: [`src/infrastructure/storage/sync/outbound/effectOutboxSql.ts`](../src/infrastructure/storage/sync/outbound/effectOutboxSql.ts) ·
[`src/application/sync/outbound/effects/SyncEffectWorker.ts`](../src/application/sync/outbound/effects/SyncEffectWorker.ts)

### 4.1 상태 전이

```text
pending → processing → applied / failed / superseded / blocked_candidate / conflict
   └──────────────→ delivery_uncertain (응답 유실) → probe → pending/applied
```

상태 값은 `src/domain/model/constants.ts`의 `EFFECT_STATUSES`(`as const`)가
유일한 출처다.

### 4.2 claim CAS와 순서 보장

claim은 상태·lease·fence·**선행 작업** 조건을 모두 만족할 때만 성공한다:

```sql
UPDATE sheet_effect_outbox AS candidate
SET status = 'processing', claim_token = ?, writer_epoch = ?, lease_until = ?, ...
WHERE candidate.effect_id = ?
  AND candidate.status IN ('pending', 'failed', 'delivery_uncertain')
  AND (status별 next_attempt_at / next_probe_at 조건)
  AND EXISTS (FENCE_EXISTS_SQL)
  AND NOT EXISTS (
    SELECT 1 FROM sheet_effect_outbox AS predecessor
    WHERE predecessor.logical_sheet_id = candidate.logical_sheet_id
      AND predecessor.target_kind = candidate.target_kind
      AND predecessor.target_id = candidate.target_id
      AND predecessor.stream_sequence < candidate.stream_sequence
      AND predecessor.status NOT IN ('applied', 'superseded')
  )
```

같은 target의 이전 effect가 `stream_sequence` 기준으로 안 끝나면 다음 effect는
claim되지 않는다 — **commit 순서 역전 금지** 정책의 구현이다.

### 4.3 적용 CAS

```sql
UPDATE sheet_effect_outbox
SET status = ?, ...
WHERE effect_id = ? AND status = 'processing' AND claim_token = ?
  AND writer_epoch = ? AND lease_until IS NOT NULL AND lease_until > ?
  AND EXISTS (FENCE_EXISTS_SQL)
```

내가 claim한 그 작업(claim_token + epoch)만 내가 닫을 수 있다.

### 4.4 응답 유실과 probe

- timeout/응답 유실은 실패로 단정하지 않고 `delivery_uncertain` + `uncertain_since`
  + `next_probe_at` + `dispatch_id`로 기록한다.
- `delivery_uncertain`은 **due probe일 때만** 처리로 복귀하며, probe는 원격
  postcondition(visible 상태 재조회)으로 "적용됐는지"를 증거로 판정한다.
- lease가 만료된 `processing` 작업도 `delivery_uncertain`으로 회수된다.

### 4.5 idempotency

- 같은 effect ID + 같은 `payload_hash` 재시도 → 안전하게 `already_applied`/`applied`
- 같은 effect ID + **다른** payload → fail-closed (거부)
- retry는 같은 event/effect/command identity를 재사용한다 (고정 정책 8번)

## 5. 사용자 편집 충돌 — field revision, active candidate, candidate_epoch

구현: [`src/domain/conflict/transitions.ts`](../src/domain/conflict/transitions.ts) ·
[`src/infrastructure/storage/state/resolution/resolutionWriterSql.ts`](../src/infrastructure/storage/state/resolution/resolutionWriterSql.ts)

### 5.1 필드 단위 증거

`sheet_visible_field_state`는 필드별로 다음을 보관한다:

```text
confirmed_field_hash, confirmed_visible_revision,
active_candidate_conflict_id, active_candidate_hash, candidate_epoch
```

사용자 편집이 관찰되면 필드 revision/hash를 비교해:

- 기존 canonical과 일치 → 승인 (canonical commit)
- 불일치 → **candidate 생성** (conflict OPEN)

### 5.2 active candidate가 시스템 보정을 차단

worker는 `isUserInputCandidateBlocked`로 **해결되지 않은 candidate가 소유한
필드**를 건드리는 시스템 보정 effect를 `blocked_candidate`로 막는다. 시스템이
사용자 후보를 조용히 덮어쓰지 못하게 하는 게 목적이다.

### 5.3 resolution: one-shot 요청 + CAS + epoch 증가

1. 사용자가 `Sync_Conflicts.resolve_requested` checkbox를 TRUE로 변경 (one-shot
   요청이며 직접 RESOLVED 상태를 쓰는 게 아니다)
2. `resolution_command` 저장 — `command_id`/`request_key`로 **재제출 중복 방지**
3. `applyResolution`이 CAS 수행:
   - action = `acknowledge_system`, role(`sheet_editor`/`sync_operator`) 검증
   - `targetConflictId` 일치 검증
   - `current_canonical_revision = ? AND candidate_epoch = ?` 비교
4. 성공 시 candidate pointer 해제와 함께 **`candidate_epoch = candidate_epoch + 1`**:

```sql
UPDATE sheet_visible_field_state
SET active_candidate_conflict_id = NULL, active_candidate_hash = NULL,
    candidate_epoch = candidate_epoch + 1
WHERE physical_sheet_id = ? AND projection = ?
  AND row_binding_id = ? AND field_name = ?
  AND active_candidate_conflict_id = ? AND candidate_epoch = ?
```

### 5.4 ABA 방지

candidate가 A→B→A로 되돌아온 뒤에도 **epoch가 이미 증가**했으므로, 옛
request(옛 epoch)는 "다시 같은 후보"를 보고도 해소할 수 없다. 같은 값이라도
세대가 다르면 별개의 후보로 취급된다.

### 5.5 conflict 상태

`src/domain/model/constants.ts`의 `CONFLICT_STATUSES`:

```text
OPEN → NEEDS_REBASE → RESOLVED
```

- `OPEN`: stale 필드가 감지된 초기 상태
- `NEEDS_REBASE`: conflict가 열린 동안 같은 필드의 canonical이 전진
  (`shouldRebaseConflict`가 revision 비교로 전이)
- `RESOLVED`: CAS를 통과한 해소
- `SUPERSEDED`는 conflict 상태가 아니다.

## 6. 행 identity — anchor + rowBindingId

구현: `src/application/orm/mapping/entityMapping.ts`의 identity helpers ·
[`src/infrastructure/storage/sqlite/schema.ts`](../src/infrastructure/storage/sqlite/schema.ts)의
`projection_row_binding`

- Sheet의 **물리적 행 번호는 identity로 쓰지 않는다** (행 삽입/삭제로 바뀌므로).
  각 행에는 별도 physical anchor가 붙는다.
- SQLite 쪽 `row_binding_id`는 `"binding:" + stableHash(logicalSheetId,
  physicalAnchor)`로 안정적으로 유도된다.
- `projection_row_binding`은 다음을 보장한다:

```text
UNIQUE(physical_sheet_id, anchor_reference)
UNIQUE(physical_sheet_id, row_binding_id)  -- row_binding_id가 있는 행
UNIQUE(physical_sheet_id, conflict_id)     -- conflict 행
```

- **중복 anchor**는 행 선택의 근거가 될 수 없으므로 추측하지 않고
  fail-closed/quarantine 대상이 된다 (고정 정책: "row identity가 불명확하면
  추측하지 않고 quarantine").

## 7. 안정 인코딩 — hash가 곧 증거

구현: [`src/shared/encoding/`](../src/shared/encoding/) (기반: `@hikoutei/kohkai`)

위 모든 비교가 hash에 의존하므로, **같은 값은 항상 같은 hash**여야 한다:

- canonical UTC date 포맷
- NFC 문자열 정규화
- deterministic 직렬화 (키 정렬 포함)

hash가 흔들리면 revision 비교·visible-hash CAS·candidate hash가 전부 무의미해지기
때문에, 안정 인코딩은 동기화 엔진의 기반 계층이다.

## 8. 종합 예시: 사용자 수정이 충돌로 가는 한 경로

```text
1. 사용자가 User_Input 셀 수정
2. polling 관찰 → values-only preflight → 변경 감지 시 full scan
3. 필드 revision/hash 비교 → canonical과 다름 → candidate 생성 (conflict OPEN)
4. 같은 필드를 고치려는 시스템 effect → blocked_candidate로 차단
5. 사용자가 Sync_Conflicts에서 resolve_requested = TRUE
6. resolution_command 저장 (request_key로 중복 방지)
7. applyResolution: role / conflictId / revision / candidate hash / epoch CAS
8. 성공 → candidate_epoch + 1, pointer 해제, canonical 확인 effect 큐잉
9. worker가 effect를 epoch/token + expected visible hash CAS로 Sheets에 반영
10. receipt의 visibleHash 검증 후에만 outbox applied
```

모든 단계가 "시간이 아니라 증거 비교"로만 넘어간다.

---

## 요약

| 메커니즘 | 역할 | 핵심 증거 |
|---|---|---|
| writer lease + fencing | SQLite 단일 writer 보장 | `writer_epoch` + `fencing_token` |
| spreadsheet authority | 원격 쓰기 세대 보장 | `authority_epoch` + `authority_token` |
| visible-hash CAS | Sheets 행의 조건부 쓰기 | `expectedVisibleRevision`/`expectedVisibleHash` + receipt 검증 |
| outbox 상태 머신 | 순서·재시도·응답 유실 복구 | `stream_sequence`, `claim_token`, `next_probe_at` |
| candidate + epoch | 사용자 후보 보호와 ABA 방지 | `active_candidate_hash` + `candidate_epoch` |
| anchor + rowBindingId | 안정적 행 identity | physical anchor + stable hash |
| kohkai 안정 인코딩 | 증거 hash의 일관성 | canonical 인코딩 + deterministic hash |
