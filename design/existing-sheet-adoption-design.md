# 기존 시트 연결(Adoption) 설계 — MVP

상태: **설계 확정 (2026-08-28), Phase 1-3 구현 (PR #385 + 시딩 엔진 브랜치)**

라이브러리와 연결된 적 없는 기존 Google Spreadsheet의 기존 탭을 엔티티로
가져와(adopt), SQLite 테이블을 생성하고 기존 행 데이터를 베이스라인으로
시딩한 뒤, 정상 sync 흐름으로 이어지는 기능의 설계.

선행 논의: 결정 D1–D7은 2026-08-28 대화에서 확정되었으며, 기술 근거는
`docs/sync-bulk-write-benchmark.md`(2026-08-28 섹션)의 라이브 측정과 코드
탐색 결과에 기반한다.

## 1. 핵심 모델: 기존 탭 = User_Input, System_State는 새로 프로비저닝

```
[기존 시트 탭: Invoices] ──▶ User_Input (그대로, 사람 편집 계속 가능 · 흡수됨)
                                    │ 폴링이 편집 흡수
[SQLite] ←──────────────────────────┘  (어답션 시 기존 행 시딩)
                                    │ 신규 행 append (평소 경로)
[새 탭: Invoices_System] ──▶ 라이브러리가 프로비저닝, sync가 자동 채움
```

- **기존 탭은 데이터 이동 없이 User_Input이 된다.** 사람은 기존 그대로 편집을
  계속하고, 폴링이 편집을 SQLite로 흡수한다.
- 라이브러리는 **System_State 탭을 평소처럼 새로 프로비저닝**한다. 탭이 비어
  있으므로 시딩된 엔티티가 정상 신규 행 append 경로(대량 append)로
  프로젝션된다 — 기존 1,000행과 CAS를 맞추는 관측 해시 시딩이 **불필요**.
- 어답션 엔티티의 탭 구성(User_Input + System_State + Sync_Conflicts)은
  **신규 생성 플로우와 100% 동일**하다. 개념 충돌 없음.

## 2. 결정 기록

| # | 결정 | 내용 |
|---|---|---|
| D1 | **기존 탭 = User_Input, System_State 신규 프로비저닝** | 기존 데이터는 그 탭에 그대로 두고 사람 편집을 계속 받는다(흡수). 라이브러리의 System_State는 새 탭에 정상 append 경로로 채워진다. 어답션 엔티티 구조 = 신규 생성 플로우와 동일. |
| D2 | **헤더 이름 바인딩, 위치 무관** | 시트 헤더 이름 == 엔티티 프로퍼티 이름인 컬럼만 바인딩. 순서·위치 무관. 여분 컬럼(`memo` 등)은 어디에 있든 무기한 무시 — 절대 덮어쓰지 않음. |
| D3 | **쓰기 경로 세그먼트화** | 바인딩된 필드가 시트에서 비연속이면 쓰기를 열별 세그먼트 요청으로 분할(batchUpdate 1회 = sub-request 복수 → 호출 수·쿼터 불변). 연속이면 기존 통짜 쓰기(빠른 경로). dry-run이 분할 모드 여부를 표시. |
| D4 | **PK 정책** | 비즈니스 키(PK)는 폴링 매칭의 기준이므로 시트에 존재해야 한다. 기존 컬럼을 지정(유니크성 검사)하거나, 없으면 **라이브러리가 PK 컬럼을 맨 오른쪽에 append + 기존 행 채워넣기**(기존 셀 이동·수정 없음). |
| D5 | **시딩 선행 = fail-closed** | 프로비저닝 → User_Input 바인딩 시딩 → 최종 재판정 → 슈퍼바이저 기동 순서 강제. CleanupScanner가 미바인딩 행을 오염으로 삭제하는 것 방지. 어답션 실패 시 서비스 기동 자체 실패. |
| D6 | **편집 정책: 흡수가 기본** | 기존 탭이 User_Input이므로 사람의 수정/추가/삭제는 **정상 경로로 흡수**된다(되돌려지지 않음). 라이브러리가 이 탭에 하는 쓰기는 row_id append와 캐노니컬 정리뿐이다. |
| D7 | **MVP는 단일 엔티티·빈 SQLite 테이블** | 어답션 대상 엔티티의 SQLite 테이블이 비어 있을 때만 허용(병합은 후속). 다중 엔티티 동시 어답션은 엔진 재사용으로 이후 확장. |

## 3. 발견된 블로커와 해결

코드 탐색으로 확정한 블로커 — 전부 D5(시딩 선행)와 D2/D4로 해소:

| 블로커 | 위치 | 해결 |
|---|---|---|
| 프로비저닝이 User_Input 탭에 `__hikoutei_row_id` 헤더 + 정확 일치 요구 | `provisioning.ts` | 어답션 전용 경로: 이름 바인딩 검사로 대체, row_id 컬럼은 append로 확보 |
| CleanupScanner가 미바인딩 행 삭제/재작성 | `CleanupScanner.ts` | D5 순서 강제 — 시딩으로 전 행 바인딩 후 기동 |
| 폴링이 미지 행 격리(`unknown_business_key`) | polling inspection | 바인딩 시딩으로 미지 행 없음 |
| 외부 행 앵커 부재 | Developer Metadata | `ensureRowAnchors`로 어답션 중 할당 |
| System_State CAS 베이스라인 | `planner.ts` | **해당 없음** — System_State는 빈 탭에서 신규 append (기존 경로) |

## 4. API 설계

### 4.1 옵션 (InternalSyncServiceOptions / createTypedSheetsWithSync 확장)

```ts
adopt: {
  mode: "dry-run" | "adopt",
  entities: {
    Invoice: {
      tabName: "Invoices",        // 기존 탭 = User_Input이 됨
      // 헤더 이름 바인딩(자동). 프로퍼티 이름 == 시트 헤더 이름.
      identityFrom: "InvoiceNo" | "auto",   // PK 소스 (D4)
      // System_State / Sync_Conflicts 탭 이름은 projections 설정 그대로
      // (새로 프로비저닝됨).
    },
  },
}
```

### 4.2 dry-run 리포트 (읽기 전용, 시트에 쓰기 0)

- 탭 헤더 목록, 행 수, 빈 행 수
- 바인딩 결과: `필드 → 열` (예: `invoiceNo → A, customer → C, total → D`)
- 무시되는 컬럼 목록 / 연속성 판정(통짜 vs 세그먼트 쓰기)
- 누락 컬럼(엔티티 userOwned 필드 중 시트에 없음) → 에러
- PK 후보 판정(유니크성) 또는 자동 생성 예고
- 중복 identity 행 / 빈 행 리포트
- 추가될 컬럼: `__hikoutei_row_id` (필수), 필요 시 PK
- 새로 프로비저닝될 탭: System_State, Sync_Conflicts

### 4.3 어답션 완료 응답

바인딩된 행 수, 생성된 entityId 범위, 앵커 할당 수, 경고(캐노니컬 정리 시
셀 표기 정규화 가능성 등).

## 5. 시딩 데이터 모델

어답션 시딩이 채우는 SQLite 테이블 (관측 파이프라인의 canonical-commit
기계 재사용 — `infrastructure/storage/state/canonical/canonicalCommit.ts`):

- `entity_state` / `entity_field_state`: 기존 행 → 엔티티 인스턴스
- `row_binding`(ACTIVE) / `projection_row_binding`: User_Input 행 ↔ 엔티티
- `business_key_index`: PK → entityId 조회 (폴링 매칭용)
- `sheet_visible_state` / `sheet_visible_field_state` (User_Input 라우트):
  **관측 해시로 확정** → CleanupScanner가 기존 행을 재작성/삭제하지 않고,
  이후 편집 CAS가 일치
- 앵커: 어답션이 결정적 앵커(`entity:<pk>`, `mapping.anchorForEntity`)를
  row-id 컬럼 셀에 기록 — Developer Metadata가 아닌 셀 값 기반 (코드 실체와
  일치). `ensureRowAnchors`는 미앵커 행에만 할당하므로 어답션 행은 유지됨.
- System_State: **시딩 없음** — 빈 탭, 신규 append 경로로 채움
  (EFFECT_BATCH_LIMIT 1,000 대량 append, 측정치 244–286 effects/s)

## 6. 안전 — 유실 방지

| 위험 | 방어 |
|---|---|
| 시딩 전 슈퍼바이저 기동 → CleanupScanner가 미바인딩 행 삭제 | D5 fail-closed 순서. 어답션 실패 시 서비스 기동 자체 실패 |
| row_id/기존 데이터 간섭 | row_id 컬럼은 append라 기존 셀 불변. 앵커는 Developer Metadata (셀 값 불변) |
| 어답션 창구 동시 편집 | 시딩 완료 후 슈퍼바이저 기동 직전 최종 재판정 — 탭 재독해, 행별 해시 비교, delta 재흡수 |
| 어답션 도중 중단 | 체크포인트 상태 머신(`snapshot_taken → row_id_written → anchored → seeded → verified`) — 셋업 CLI 패턴 재사용, 재실행 시 이어서(중복 임포트 방지) |
| PK 값 충돌 | 생성값 스킴(`adopt_` 접두 + uuid) + 유니크성 검사. MVP는 **빈 엔티티 테이블에만** 어답션 허용 |
| 응답 유실 | 기기+수신 검증 read — 기존 response-loss 대응 패턴 재사용 |

기존 셀 값에 대한 쓰기는 **row_id 컬럼 추가뿐**. 헤더 이름 바인딩 정책(D2)
덕분에 재배치/수정이 원천적으로 없다. 사람의 데이터 편집은 흡수(D6)되므로
유실 경로가 없다.

## 7. 실패 모드

| 실패 | 동작 |
|---|---|
| 헤더 파싱 불가 / 빈 탭 | dry-run 리포트에서 중단 안내 |
| 필수 컬럼 누락(PK, userOwned 매핑 실패) | dry-run 에러 — 시트 수정 또는 identityFrom 지정 요구 |
| 중복 PK 값 | dry-run 리포트(행 번호 나열) — 사용자가 정리 후 재시도 |
| 시딩 중 네트워크/타임아웃 | 체크포인트 재개. SQLite 트랜잭션 롤백으로 all-or-nothing |
| 어답션 완료 직후 시트 수정 | 최종 재판정이 delta 재흡수. 이후 편집은 정상 폴링 흡수 |

## 8. 구현 단계

| Phase | 내용 | 배포 |
|---|---|---|
| 1 | dry-run (읽기 전용): 스냅샷 → 바인딩/리포트. `FakeSyncSheetsProvider`의 pre-populated 탭 시뮬레이션으로 테스트 | 단독 배포 가능 |
| 2 | 어답션 엔진: row_id/앵커 할당 + canonical-commit 시딩 + User_Input 관측 해시 확정 | Phase 1 뒤 |
| 3 | 부트스트랩 통합: `adopt` 옵션, 순서 강제(프로비저닝 → 시딩 → 기동), 체크포인트 | Phase 2와 함께 |
| 4 | 테스트/문서: 정상 가져오기, 컬럼 비연속, 중복 PK, 창구 동시 편집, 어답션 직후 사람 편집 흡수, System_State 자동 채움 | — |

## 9. 후속 과제 (MVP 밖)

- 자동 컬럼 매핑(`columnMap`): 헤더 이름이 프로퍼티와 다른 시트.
- 다중 엔티티 동시 어답션.
- 기존 데이터가 있는 SQLite로의 병합 어답션.
- 어답션 드리프트 캡처 리포트.
- System_State 모드 어답션(시트를 프로젝션으로 편입 — 수동 편집 되돌림 정책이
  허용되는 워크플로용).