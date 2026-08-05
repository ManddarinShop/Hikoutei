# Gateway 제거 인벤토리 (Apps Script gateway 완전 철수)

> 브랜치: `chore/post-merge-cleanup` · 기준: develop 8ecce3c (PR #161+#162 머지 후)
> 원칙: `src/` 내부의 gateway 사용 코드를 전부 제거 — 파일, 인터페이스 파라미터, 타입
> 파라미터, 상수명, 문자열까지 포함. 이 과정에서 실패하는 테스트는 무시한다 (승인됨).
> **단, scripts/ci/run-api-scenario.mjs(릴리스 CI 검증 경로)는 깨지지 않게 수정**해야 한다.

## Tier 1 — 파일 완전 삭제

### 1-1. Apps Script provider (18 파일)
`src/adapter/sheets/providers/apps-script-gateway/` 전체 삭제:
- `errors.ts`, `index.ts`, `validation.ts`
- `operations/effect/effectOperation.ts`, `effectOperationScript.ts`
- `operations/observation/observationOperation.ts`
- `operations/read/tableReadOperation.ts`
- `operations/shared/appsScriptStableCodecSource.ts`
- `operations/write/batchAppendOperation.ts`, `fastAppendOperation.ts`
- `protocol/codeGsProtocol.ts`, `constants.ts`, `syncProtocol.ts`, `timing.ts`, `types.ts`, `validation.ts`
- `transport/operationClient.ts`, `transport/operationSyncGateway.ts`

### 1-2. 배포용 Apps Script
- `apps-script/gateway/Code.gs`, `apps-script/gateway/appsscript.json`
- `package.json` `files`에서 `apps-script/gateway/*` 항목 제거

### 1-3. 혼합 모드/구버전 전용 src 파일
- `src/application/sync/gateway/RoutedSyncGateway.ts` (deprecated mixed-mode 라우터)
- `src/adapter/sheets/providers/google-sheets-api/GoogleSheetsApiEffectGateway.ts` (deprecated alias)
- `src/application/sync/gateway/syncGateway.ts` 내 `SplitSyncGateway` 클래스 + `SyncEffectWorkerGateway`(fast-only 인터페이스) — 사용처가 Split 테스트뿐이면 삭제

### 1-4. 삭제할 테스트 (실패 무시 승인 범위)
- `test/apps-script-batch-append-operation.test.ts`
- `test/apps-script-fast-append-operation.test.ts`
- `test/apps-script-operation-client.test.ts`
- `test/apps-script-operation-sync-gateway.test.ts`
- `test/coordinated-sync-gateway.test.ts`
- `test/fake-sync-gateway.test.ts`
- `test/split-sync-gateway.test.ts`
- `test/sync-gateway.test.ts`
- `test/support/FakeSyncSheetGateway.ts` (stub transport 기반으로 대체하거나 삭제)

## Tier 2 — 계약 레이어 재명명 (`src/application/sync/gateway/`)

디렉터리 제안: `src/application/sync/gateway/` → `src/application/sync/sheets/`

| 기존 | 제안 |
| --- | --- |
| `syncGateway.ts` | `syncSheets.ts` |
| `SyncGatewayBootstrap.ts` | `sheetsProvisioning.ts` |
| `transportClassification.ts` | `transportOutcome.ts` |
| `conflictProjectionRegistration.ts` | `conflictProjection.ts` |
| `coordinator/` | `mutationCoordinator/` |
| `CoordinatedSyncGateway` | `CoordinatedSheetsProvider` |
| `coordinatorTelemetry.ts` | `laneTelemetry.ts` |

### 핵심 타입 재명명 (gateway 단어 제거)
- `SyncSheetGateway` → `SyncSheetsProvider`
- `SyncEffectWorkerFullGateway` → `SyncEffectWorkerProvider`
- `SyncSheetObservationGateway` → `SyncSheetsObservationProvider`
- `SyncSheetObservationBatchGateway` → `SyncSheetsObservationBatchProvider`
- `SyncSheetTableReaderGateway` → `SyncSheetsTableReader`
- `SyncGatewayProvisioner` → `SyncSheetsProvisioner`
- `SyncGatewaySnapshot` → `SyncSheetsSnapshot`
- `SyncGatewayEffect` → `SyncProjectionEffect`
- `SyncGatewayEffectResult` → `SyncEffectResult`
- `SyncGatewayEffectPostconditionResult` → `SyncEffectPostconditionResult`
- `SyncGatewayTiming` → `SyncSheetsTiming` (syncTiming.ts)
- `SyncGatewayContractError` → `SyncSheetsContractError`
- `SYNC_GATEWAY_ERROR_CODES` → `SYNC_SHEETS_ERROR_CODES` (또는 `SYNC_CONTRACT_ERROR_CODES`)

### 상수 재명명 (`src/application/sync/gateway/constants.ts`)
- `SYNC_GATEWAY_PROJECTIONS` → `SYNC_PROJECTIONS`
- `SYNC_GATEWAY_PROTOCOL_VERSIONS` → `SYNC_PROTOCOL_VERSIONS`
- `SYNC_GATEWAY_SNAPSHOT_READ_MODES` → `SYNC_SNAPSHOT_READ_MODES`
- `SYNC_GATEWAY_EFFECT_RESULT_STATUSES` → `SYNC_EFFECT_RESULT_STATUSES`
- `SYNC_GATEWAY_FAST_APPEND_STATUSES` → `SYNC_FAST_APPEND_STATUSES`
- `SYNC_GATEWAY_POSTCONDITION_MODES/STATUSES/DISPOSITIONS` → `SYNC_POSTCONDITION_*`
- `SYNC_GATEWAY_EFFECT_KINDS` → `SYNC_EFFECT_KINDS`

### 워커 상수/타입
- `GATEWAY_EFFECT_BATCH_LIMIT` → `EFFECT_BATCH_LIMIT`
- `WORKER_ERROR_CODES.GATEWAY_SUPERSEDED/SCHEMA_ERROR/REMOTE_ERROR/CAPABILITY_MISSING` → `PROVIDER_*` (⚠️ `last_error_code`로 SQLite에 저장되는 값 — 재명명 시 과거 데이터 코드 의미 변경. dev 단계라 저위험, 문서에 명시)
- `gatewayTimeoutMs` 옵션 → `requestTimeoutMs` (SyncEffectWorker/SyncEffectSupervisor/SyncServiceBootstrap)
- `gateway` 파라미터명 → `provider` (runSyncEffectWorkerWithAdapter 등)
- `item.gatewayEffect` → `item.providerEffect` (또는 `sheetEffect`)

## Tier 3 — 파라미터/타입 단위 제거 (사소한 부분)

- **`SyncGatewayAuthority` + `authority` 요청 파라미터 삭제**
  - 전달 지점은 `SyncEffectWorkerRouting.ts:292` 1곳뿐이며 워커는 값을 넣지 않음(항상 undefined)
  - 대상: `ApplySyncEffectsRequest.authority`, `FastAppendRowsRequest.authority`, `EnsureSyncRowAnchorsRequest.authority`, `ReadSyncSnapshotRequest.authority`, `ReadSyncEffectPostconditionsRequest.authority`
  - `GoogleSheetsApiSyncProvider`의 `validateAuthority` 삭제
  - SQLite `spreadsheet_authority`(infrastructure/storage/sync/shared/spreadsheetAuthority.ts)는 **유지** — 로컬 fence
- **Bootstrap 옵션 삭제**: `gateway`(injected), `provisioner`, `appsScript`, `googleApiWorker`
  - `InternalSyncGateway`/`InternalSyncGatewayControl` → `InternalSyncProvider`/삭제
  - `runGatewayControl` → `runSerializedControl` (coordinator 기존 메서드로 통합)
  - `createAppsScriptObservationGateway`, `asProvisioner`, `isSyncGatewayProvisioner`, `wrapInCoordinator` 정리
  - 남는 모드: `googleSheetsApi` 단일 경로
- **워커 내부 네이밍**: `groupByGatewayRequest` → `groupByProviderRequest`, `gatewayRouteKey` → `routeKey`, "gateway is fast-only" 메시지 정리
- **텔레메트리**: `SYNC_TIMING_SCOPES.GATEWAY = "gateway"` → `"provider"` (scope 값 — 텔레메트리 계약, 테스트 갱신 필요)
- **워커 타이밍 phase 이름**: `*_gateway_dispatch` 등 gateway 포함 phase 문자열 확인 후 `*_provider_dispatch`로 (sync-effect-outbound-performance.test.ts 등이 참조)

## Tier 4 — 주석/문자열 정리 (gateway 언급 제거)

- `src/index.ts`, `src/api/index.ts`, `src/api/Hikoutei.ts` (주석)
- `src/domain/model/types.ts`, `src/shared/encoding/types.ts` ("observation/gateway path" 주석)
- `src/infrastructure/storage/sync/outbound/effectOutbox*.ts` (주석)
- `src/application/sync/inbound/*`, `reconciliation/*`, `outbound/projection/*` 주석
- `src/adapter/persistence/providers/mikro-orm/**` 주석
- `domain/evaluate/contracts.ts`, `application/orm/**` 주석 (SYNC_GATEWAY_ import는 재명명 반영)

## Tier 5 — 테스트 영향

### 삭제: Tier 1-4 목록 (8 파일 + FakeSyncSheetGateway)
### 수정 필요 (재명명 따라가기 — 실패 시 무시 OK, 단 시나리오 제외):
- `test/google-sheets-api-effect-gateway.test.ts` → `test/google-sheets-api-provider.test.ts`로 병합/이름 변경 (deprecated alias 테스트 제거, 나머지는 sync-provider 테스트로)
- `test/sync-service.test.ts` (gateway/appsScript/googleApiWorker 모드 테스트 제거, googleSheetsApi 모드 유지)
- `test/google-sheets-api-sync-provider.test.ts`, `test/transport-classification.test.ts`
- `test/simple-sheet-polling.test.ts`, `test/mapped-typed-sheets-orm.test.ts`, `test/mapped-user-input-*.test.ts`
- `test/reconciliation-scanner.test.ts`, `test/sync-effect-*.test.ts`, `test/sync-polling-supervisor.test.ts`
- `test/hikoutei-*.test.ts`, `test/type-contracts.test.ts`, `test/kohkai-compatibility.test.ts` (apps-script codec 참조 확인)
- `test/root-api-options.test.ts` (options에 gateway 포함 여부 확인)

## Tier 6 — CI/스크립트 (깨지면 안 되는 경로)

- `scripts/ci/run-api-scenario.mjs`
  - `FakeSyncGateway` 클래스 → 재명명된 계약 구현(또는 StubSheetsTransport 기반으로 교체) — **fake 모드는 CI(ci.yml, develop/stable-publish)가 사용하므로 유지 필수**
  - `LiveSyncBackend` gateway 모드, `mutateRowSource`/`cleanupSource`(Apps Script 소스), `AppsScriptOperationClient` import 제거
  - direct 모드만 남도록 정리
- `.github/workflows/` — live-integration.yml은 이미 direct-only; 나머지 확인
- `.env.example`, `docs/` — `TYPED_SHEETS_GATEWAY_*`, `GOOGLE_APPS_SCRIPT_*` 정리 (후속)

## 유지 목록 (혼동 방지)

- `src/infrastructure/storage/sync/shared/spreadsheetAuthority.ts` — SQLite authority (gateway 아님, 유지)
- `@hikoutei/kohkai` — stable codec (유지)
- `src/adapter/sheets/providers/google-sheets-api/**` — 유일 provider (유지, 계약 재명명 반영)
- `scripts/ci/release-version.mjs`, `read-npm-dist-tag.mjs` — 무관

## 실행 순서 제안

1. Tier 2 재명명 (디렉터리+타입+상수) — 순수 기계적 변경, 중간 커밋
2. Tier 1 삭제 (apps-script-gateway, alias, 혼합 모드, 배포 파일, 전용 테스트)
3. Tier 3 파라미터/옵션 제거 (authority, bootstrap 옵션, 워커 네이밍)
4. Tier 6 시나리오/워크플로 정리 (direct-only, fake 유지)
5. Tier 5 수정 테스트 + 실패 무시 목록 확정
6. Tier 4 주석/문자열 + 문서 정리
7. 검증: typecheck/build는 통과 목표, 단위 테스트는 실패 허용 목록 외 통과
