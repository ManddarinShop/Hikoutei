# Sync observability (동기화 진단)

현재 런타임의 관측성은 이름이 고정된 JSON 로그 이벤트가 아니라 두 개의
callback으로 제공된다.

- `AppsScriptOperationClient`의 `onRequest`: 서명된 operation batch의 HTTP
  요청·응답 상태와 크기
- sync worker의 `onTiming`: 로컬 worker와 원격 Gateway phase의 소요 시간

worker pass의 반환값인 `SyncEffectWorkerReport`에는 처리 결과 카운터가
포함된다. 애플리케이션은 이 callback과 report를 자체 로그·메트릭 시스템에
연결해야 한다. Apps Script `Code.gs`가
`typed_sheets_gateway_request` 같은 애플리케이션 로그 이벤트를 자동으로
발행한다고 가정하지 않는다.

## Operation client request event

`onRequest` callback은 다음의 민감정보가 제거된 값을 받는다.

| 필드 | 의미 |
| --- | --- |
| `requestId` | 한 signed request를 양쪽에서 추적하기 위한 식별자 |
| `operation` | 현재 operation 이름. 기본 client는 `applyOperations`를 사용한다. |
| `operationCount` | 한 request에 포함된 operation 수 |
| `startedAt`, `durationMs` | 로컬 요청 시작 시각과 총 소요 시간 |
| `ok`, `httpStatus` | HTTP 및 protocol 성공 여부 |
| `requestBytes`, `responseBytes` | 요청·응답 본문 크기 |
| `clientErrorCode` | timeout, network, protocol 등 로컬 오류 코드 |
| `remoteErrorCode` | Apps Script가 반환한 원격 오류 코드 |

operation 인자와 반환값, secret, signature는 이 callback에 포함되지 않는다.
따라서 `effectId`나 셀 값을 로그에 남기려면 별도의 애플리케이션 레벨
correlation 정책이 필요하며, 전체 payload를 무분별하게 기록해서는 안 된다.

## Worker timing event

worker의 `onTiming`은 다음 구조를 받는다.

| 필드 | 의미 |
| --- | --- |
| `scope` | `orm_flush`, `worker`, `gateway` 중 하나 |
| `phase` | 측정된 로컬 또는 원격 처리 단계 |
| `durationMs` | 해당 단계의 소요 시간 |
| `operationKinds` | `append`, `update`, `delete` 분류 |
| `operationCounts` | 분류별 개수 |

진단 sink의 예외는 worker 상태 전이를 실패시키지 않는다. 벤치마크나 운영
로그를 위해 callback에서 수집하되, 동기화의 정합성을 callback에 의존하지
않는다.

## Worker report

`runSyncEffectWorkerWithAdapter()`와 worker supervisor pass는 다음 카운터를
반환한다.

- `selected`, `claimed`, `applied`, `failed`
- `deferred`, `requeued`, `replanned`, `superseded`
- `blockedCandidate`, `conflicted`
- `expiredLeasesRecovered`, `responseLossRecovered`

특히 `responseLossRecovered`는 원격 Sheet 쓰기 후 HTTP 응답을 잃었지만
postcondition read로 반영 사실을 확인한 경우를 나타낸다. `requeued` 또는
`failed`가 증가하면 원격 쓰기 실패로 단정하기 전에 postcondition과 다음
worker pass를 함께 확인해야 한다.

## 판별 순서

1. `onRequest` 이벤트가 없으면 해당 pass가 Gateway 호출 단계에 도달하지
   않았을 가능성이 있다. worker의 `selected`, `claimed`, `requeued`,
   `failed`를 먼저 확인한다.
2. `httpStatus: null`과 `clientErrorCode`가
   `sync_gateway_timeout` 또는 `sync_gateway_network_error`이면 네트워크나
   응답 대기 중 실패다. 원격 쓰기 여부는 이 정보만으로 판단하지 않는다.
3. HTTP 응답이 있지만 `ok: false`이면 `remoteErrorCode`와 worker report의
   `failed`를 함께 확인한다. 원격 operation 실패는 로컬 SQLite transaction을
   되돌리는 것이 아니라 해당 effect의 retry/recovery 경로로 처리된다.
4. timeout 뒤 다음 pass에서 `responseLossRecovered`가 증가하면 Sheet 반영은
   완료되었고 로컬 outbox 상태만 recovery로 확정된 것이다.
5. timing에서 `gateway` phase가 크고 `orm_flush`가 작으면 SQLite가 아니라
   HTTP·Apps Script dispatch, lock, range 처리 비용이 병목일 가능성이 높다.

## 현재 범위의 한계

현재 public runtime에서 User_Input polling과 global Conflict checkbox
resolution은 end-to-end 기능이 아니다. 따라서 이 문서의 callback과 report는
주로 SQLite outbox의 outbound worker와 Apps Script operation gateway 진단에
사용된다. inbound 기능이 구현되면 관측 이벤트를 같은 `onTiming` 경계에
연결한다.

실제 Google Sheets 요청을 관측하려면 배포된 Apps Script Gateway와 서버 쪽
`onRequest`/`onTiming` 연결이 모두 필요하다. Gateway secret과 전체 payload는
로그에 기록하지 않는다.
