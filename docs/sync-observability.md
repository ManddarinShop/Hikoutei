# Sync observability (동기화 진단)

대량 동기화가 멈췄을 때 SQLite outbox(전송 대기함)의 문제와 Apps Script
게이트웨이(원격 실행부) 또는 Google Sheets 처리 문제를 분리하기 위한 진단
방법이다.

## 기록되는 이벤트

API 서버는 JSON 한 줄 로그를 출력한다.

| 이벤트 | 의미 |
| --- | --- |
| `typed_sheets_sync_worker_report` | 한 번의 worker(백그라운드 처리기) pass가 로컬 outbox를 어떻게 처리했는지 보여준다. `selected`, `claimed`, `applied`, `failed`, `deferred`, `requeued`, `responseLossRecovered`, `expiredLeasesRecovered`를 확인한다. 모호한 전송은 outbox의 `delivery_uncertain`, `uncertain_since`, `next_probe_at`, `dispatch_id`를 함께 확인한다. |
| `typed_sheets_gateway_request` | Node가 Apps Script에 보낸 하나의 요청이다. `requestId`, `operation`, `effectCount`, `effectIds`, `requestBytes`, `durationMs`, `httpStatus`, `clientErrorCode`, `remoteErrorCode`, `effectStatuses`를 확인한다. |
| `typed_sheets_sync_worker_error` | worker pass 자체가 예외로 종료된 경우다. |

Apps Script 실행 기록에는 다음 이벤트가 같은 `requestId`로 남는다.

| 이벤트 | 의미 |
| --- | --- |
| `sync_gateway_request_started` | Apps Script가 요청을 받기 시작한 시점이다. |
| `sync_gateway_request_finished` | Apps Script가 응답을 만들고 종료한 시점이다. `durationMs`, `errorCode`, `effectStatuses`, `hasMore`를 포함한다. |
| `sync_gateway_request_failed` | 게이트웨이 코드가 예외를 밖으로 전파한 경우다. |

로그에는 shared secret(공유 비밀키), signature(서명), 셀 값, 전체 payload(요청
내용)를 기록하지 않는다. `effectId`는 요청 양 끝을 연결하기 위한 식별자만 기록한다.

## 폴링 타이밍 단계 (진단 전용)

인바운드 `User_Input` 폴링은 진단용 타이밍 싱크(`onTiming`, `scope: polling`)를
통해 단계별 소요 시간을 내보낸다. 이 값들은 애플리케이션이나 원격 동작에
영향을 주지 않는 계측 전용 값이며, 서버나 벤치마크가 이 싱크를 연결한 경우에만
관찰된다. 폴링은 append/update/delete 작업을 수반하지 않으므로 모든 단계는 빈
작업 종류와 0인 카운트로 보고된다.

| 단계 (`scope: polling`) | 의미 |
| --- | --- |
| `canonical_state_read` | 비교 기준이 되는 정규 SQLite 상태를 읽는 구간이다. |
| `values_only_read` | 적응형 preflight가 값 전용(values-only) 원격 읽기로 변경 후보를 찾는 구간이다. |
| `fast_comparison` | 값 전용 읽기 결과를 정규 상태와 비교해 전체 메타데이터로 올릴 테이블을 가리는 구간이다. |
| `full_metadata_observation` | 변경/모호/스키마 사례나 주기적 안전 전수 스캔으로 올라간 테이블의 수식/병합/오류 메타데이터를 보존하는 스냅샷 읽기 구간이다. |
| `persistence` | 수락된 관측과 엔터티 변경, 격리(quarantine) 행을 SQLite에 기록하는 구간이다. |
| `polling_total` | 폴링 pass 전체 소요 시간이다. |
| `safety_scan_lag` | 예정된 안전 전수 스캔이 시작 시점에 얼마나 늦었는지(밀리초) 기록한다. 스캔 실패 전에도 기록된다. |

같은 pass의 폴링 보고서는 모드(`mode`), 안전 전수 스캔 여부(`safetyFullScan`),
전체 메타데이터로 처리한 테이블 수(`fullMetadataTables`), preflight가 훑은/
변경된 행 수(`fastPathRowsScanned`, `fastPathChangedRows`)와 안전 전수 스캔 지연
(`safetyScanLagMs`)을 함께 보고한다. `safetyScanLagMs`는 적응형 pass에서는 0이고,
첫 전수 스캔에는 이전 완료 시점이 없어 0이며, writer lease 경쟁이나 긴 polling
간격으로 예정 시각을 넘긴 전수 스캔에서 양수로 기록된다.
`values_only_read`가 짧고 `full_metadata_observation`이 거의 없으면 적응형
preflight가 원격 전체 읽기를 건너뛰고 있다는 뜻이다.

## 판별 순서

1. Node 로그에 `typed_sheets_gateway_request` 자체가 없는 effect가 있으면
   worker의 claim(처리권 확보), grouping(배치 묶기), 또는 로컬 DB 처리부터
   확인한다. Apps Script까지 요청이 도달하지 않은 것이다.
2. Node 로그에는 요청이 있지만 `httpStatus`가 `null`이고
   `clientErrorCode`가 `sync_gateway_timeout` 또는
   `sync_gateway_network_error`이면 전송 경로 또는 응답 대기 중 실패다.
   Apps Script에 `started`가 있고 `finished`가 없으면 원격 실행 중 종료,
   quota(사용량 제한), 또는 실행 시간 제한 가능성이 있다.
3. Node 로그의 `httpStatus`가 있고 `remoteErrorCode`가
   `lock_timeout`, `operation_failed`, `snapshot_failed`,
   `postcondition_failed` 중 하나면 Apps Script가 응답한 원격 오류다.
   이 경우 `requestId`로 Apps Script 실행 기록을 대조한다.
4. Apps Script가 `finished`를 `ok: true`로 남겼는데 Node가 timeout이면,
   시트 반영 후 HTTP 응답만 유실됐을 가능성이 있다. outbox가
   `delivery_uncertain`으로 남고 `next_probe_at`이 설정되는지 확인한 뒤,
   due probe의 `readEffectPostcondition(원격 반영 확인)` 결과와
   `responseLossRecovered`를 확인한다.
5. Apps Script와 Node 양쪽에 `finished`/성공 기록이 있고도 outbox가
   `pending`(대기)으로 남으면, 응답을 로컬 SQLite에 기록하는 단계와
   fencing(동시 worker 보호) 실패를 확인한다.

## 대량 데이터 재현 방법

기존 backlog의 과거 시도에는 이 로그가 남아 있지 않으므로, 계측을 배포한
뒤 새 시도부터 별도 파일로 보존한다.

```sh
node --env-file-if-exists=.local/typed-sheets-api-server/.env \
  .local/typed-sheets-api-server/server.mjs 2>&1 \
  | tee .local/typed-sheets-api-server/sync-worker.log
```

처음에는 `TYPED_SHEETS_SYNC_MAX_EFFECTS=1` 또는 `2`로 소량을 처리해
`requestId` 하나의 양쪽 로그가 모두 생기는지 확인한다. 그 다음 5, 10, 20으로
늘리면서 `requestBytes`와 `durationMs`, `effectStatuses`가 어떻게 변하는지
비교한다. 배치 크기를 키울 때만 실패율이나 처리 시간이 급증하면 Apps Script
시트 처리 비용 또는 요청/응답 크기 제한을 의심할 수 있다. 배치 크기와 무관하게
`lock_timeout`이 반복되면 동시 실행 또는 락 점유 시간을 먼저 확인한다.

하나의 `applyEffects` 호출이 인정하는 효과 수는 게이트웨이 배치 한계(현재 20)로
묶여 있다. 워커가 더 많은 효과를 한 번에 claim해도 각 물리 경로는 이 한계
단위로 잘려 별도 요청으로 나가므로 요청당 `effectCount`는 이 한계를 넘지
않는다. 응답 손실이나 사후조건 미반영으로 한 pass가 작업을 requeue만
반복하면, 즉시 재시도하는 대신 상한이 있는 지터 지연으로 물러나고 정방향
진행이 회복되면 곧바로 원래 간격으로 돌아온다. 이 동안 임대 만료와 복구는
효과를 계속 살려 둔다.

Apps Script 실행 기록은 해당 프로젝트의 권한이 필요하다. 프로젝트 소유자나
편집자가 아니라면 라이브러리가 원격 실행 로그를 자동으로 읽을 수 없으므로,
소유자에게 실행 기록 또는 Cloud Logging(보존형 로그) 접근 권한을 요청하거나
계측된 `apps-script/gateway/Code.gs`를 해당 프로젝트에 배포해야 한다.
