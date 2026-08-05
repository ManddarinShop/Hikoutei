# Write and Synchronization Flow

Hikoutei commits local state first and materializes Google Sheets changes
asynchronously. The root ORM API is SQLite-only; the internal sync service owns
all Sheet communication.

## Public ORM flow

```text
em.persist(entity) / em.remove(entity)
          │
          ▼
SQLite transaction
  └─ entity table
          │
          ▼
return to application
```

`createTypedSheets()` never contacts Google Sheets and does not require a Sheet
route, provider client, or provisioner. Reads always come from SQLite.

## Internal sync service flow

The service-side bootstrap uses the same SQLite adapter and adds the canonical
sync state and durable outbox to the flush transaction:

```text
EntityManager.flush()
          │
          ▼
SQLite transaction
  ├─ entity table
  ├─ canonical sync state
  ├─ projection registry/state
  └─ durable Sheet effect outbox
          │
          ▼
internal effect supervisor
  ├─ claim with a lease
  ├─ send a bounded direct REST batch to the sync provider
  ├─ persist uncertain delivery and schedule a durable postcondition probe
  └─ mark the effect applied, terminally failed, or recoverably pending
          │
          ▼
sync provider (googleSheetsApi) ──▶ Google Sheets
```

A successful `flush()` means that SQLite accepted the local change and queued
its projection effect. It does not mean that the remote Sheet write has
completed.

## Fast append, update, and delete

New System_State rows use the bounded fast append operation where possible.
Updates and deletes use guarded effects with expected visible revision/hash
evidence. The same internal worker handles retries, response-loss recovery, and
reconciliation. Each physical route's effects are split into bounded sub-batches
so one provider call returns a complete result set instead of a partial prefix.
These operation types are implementation details and are not methods on the
public EntityManager.

### Outbound provider

The outbound half of the worker runs through one Google Sheets API provider
(`googleSheetsApi`): a single service-account provider owns provisioning,
outbound effects, table reads, row anchors, and User_Input observation with
no Apps Script at all. The legacy Apps Script gateway and the
`appsScript`/`googleApiWorker` options were removed; existing deployments
should switch to `googleSheetsApi`.

The direct provider implements the established sync semantics in TypeScript: bulk
preflight with fail-closed validation (headers, anchors, identities,
receipts), receipt replay/idempotency, visible/candidate/repair guards,
full-row deletion guards, one atomic `spreadsheets.batchUpdate` per
applicable target mutation + receipt write, and receipt-backed postcondition
recovery. It disables SDK auto-retry (the durable worker owns retries),
spaces request starts at 1,100 ms per class (reads and writes separately),
and trims a serialized batch over ~2 MB to an order-preserving prefix with
`hasMore`. Transport outcomes are classified by the shared
`classifyTransportOutcome` boundary: pre-mutation 4xx rejections are explicit
remote failures; timeouts, network errors, 408/429/5xx, and malformed 2xx
replies stay delivery-uncertain and are probed like any provider response loss.
This mode is not a performance claim; the raw-transport experiments under
`scripts/bench/` measure the unguarded API path without receipts or
compare-and-set.

## Inbound User_Input flow

The internal service polls registered `User_Input` projections on a bounded
interval. By default each pass runs an adaptive values-only preflight: it reads
the cheap value surface, compares it with canonical SQLite state, and only
escalates a table to the metadata-preserving snapshot read when the preflight
cannot certify it as unchanged:

```text
User_Input polling
  ├─ values-only preflight over registered projections
  ├─ escalate changed/ambiguous/schema tables to full metadata
  ├─ normalize literal/blank cells and retain formula/merge/error metadata
  ├─ resolve business-key row binding
  ├─ validate ownership and field revisions
  ├─ classify accepted, conflict, stale, or quarantine
  ├─ record Sync_Conflicts evidence
  ├─ CAS-resolve conflicts in favor of canonical SQLite state
  └─ persist accepted observation and entity mutation in SQLite
```

The preflight never accepts or persists edits. It escalates a table whenever a
row changed, a business key is unknown or duplicated, an expected active entity
is missing from the projection, or any cell fails its literal/blank type check,
so the existing quarantine and conflict rules stay authoritative. Because the
values-only read drops formula, merged, and error metadata, the bootstrap also
forces a periodic metadata-preserving safety full scan (default one minute,
configurable) so invalid cells are rechecked and quarantined rather than
mistaken for literal user edits. The coordinator records any overdue safety-scan
lag, including a scan delayed by writer-lease contention, through internal
polling telemetry without changing the SQLite write boundary.

Accepted observation writes update canonical state and the application entity in
the same SQLite transaction. They do not enqueue a duplicate User_Input effect;
only the required system projection repair/materialization is considered.
Conflicts, stale writes, duplicate keys, and malformed cells remain visible in
SQLite evidence tables. A conflict is not left open indefinitely: the internal
resolver submits a fenced `acknowledge_system` command using the current
canonical revision, active candidate hash, and candidate epoch. When it applies,
it clears the candidate pointer and appends both the guarded canonical
User_Input rewrite and the `Sync_Conflicts` audit effect in the same SQLite
transaction. If the CAS is stale, the newer candidate remains authoritative for
the next observation pass rather than being overwritten.

## Provisioning and provider boundary

Projection provisioning is an internal service-start operation. The bootstrap
generates route registrations and headers for the required System_State,
User_Input, and Sync_Conflicts projections, verifies remote schema drift, and
starts workers only after provisioning and unresolved-conflict backfill succeed.
The full direct provider provisions the tabs itself — creating missing tabs,
initializing truly-empty tabs, and failing closed on header drift — with no
Apps Script involved. The legacy Apps Script gateway mode was removed; the
service-account `googleSheetsApi` provider is the only sync path.

Sheet consistency is not provided by cross-request Sheet transactions; Google
Sheets offers no serializable isolation between separate API calls. It comes
from the hidden effect-receipt tab (each effect id and payload hash is
recorded with its visible evidence), effect-id/payload-hash dedupe (a
replayed or concurrent effect is recognized as already applied and never
double-materialized), the SQLite durable outbox (effects survive restarts and
are delivered at-least-once), fencing (spreadsheet authority epoch/token and
worker/effect leases reject stale writers), and postcondition recovery
(uncertain deliveries are probed until receipt-backed visible evidence
matches).

Applications do not import or call the provider client, protocol, operation
builders, polling functions, provisioning interfaces, or the direct Sheets
API provider.

In direct mode the same spreadsheet must be reachable by the service account
(the full provider owns provisioning, outbound writes, and observation): one
SQLite runtime is the single authoritative writer for the whole spreadsheet.
The tracked live scenario
(`scripts/ci/run-api-scenario.mjs --backend live --outbound direct`) verifies
provisioning from an empty spreadsheet, append/update/delete delivery, mapped
User_Input polling, stale-edit CAS guards, anchor evidence, and cleanup
without any Apps Script deployment.

## Failure model

An HTTP timeout, non-JSON response, 404, or lost connection does not prove that
a Sheet write failed. The worker persists `delivery_uncertain` with a durable
probe schedule and dispatch identity, then promotes the effect only after
receipt-backed visible evidence is read. An explicit structured remote failure
uses the terminal failure path. SQLite also records a per-spreadsheet authority
epoch/token; provider mutations carrying an older token are rejected. A pass that only
requeued uncertain work (a response-loss or postcondition-unapplied loop) backs
off with a bounded, jittered delay that resets as soon as forward progress
resumes; lease expiry and recovery keep effects live during the backoff. The
SQLite commit is the application success boundary; remote delivery is
at-least-once and asynchronous.
