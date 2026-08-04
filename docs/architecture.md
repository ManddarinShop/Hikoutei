# Hikoutei Architecture

Hikoutei owns a local SQLite entity store and exposes Google Sheets as an
asynchronous human-facing projection. SQLite is the authority; Sheets is an
internal service-side projection and human input surface.

> The root package API is ORM-only. Sheet synchronization is implemented inside
> `src`, but its bootstrap, gateway, worker, and storage contracts are not root
> exports.

## System shape

```text
Application code
  └─ hikoutei root API
       └─ EntityManager
            └─ SQLite entity tables
                 └─ [internal sync service in the same process]
                      ├─ canonical sync state
                      ├─ durable Sheet effect outbox
                      ├─ outbound effect worker
                      ├─ User_Input polling
                      └─ Apps Script gateway
                           └─ Google Sheets projections
```

The internal service reuses the same MikroORM SQLite adapter and transaction
boundary as the entity manager. A future deployment can extract the worker
process without changing the root entity lifecycle contract.

## Source boundaries

```text
src/domain/                         pure normalization/evaluation/conflict rules
src/application/orm/                public ORM facade and mapped flush planning
src/application/sync/               internal sync engine and service bootstrap
src/adapter/persistence/            SQLite/MikroORM implementation
src/adapter/sheets/                 Apps Script transport and operation adapter
src/infrastructure/storage/         canonical, observation, resolution, outbox state
src/api/                            root-facing entity and EntityManager facade
src/index.ts                        root public barrel only
apps-script/gateway/                deployable Apps Script code
```

`src` does not mean public. The only application-facing package entrypoint is
`src/index.ts`; package subpaths for providers, gateway operations, polling,
and sync state are not part of the contract.

## Root public API

Applications define scalar entities and open a local SQLite runtime:

```ts
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
  },
});

const hikoutei = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
});

const em = hikoutei.em.fork();
const user = em.create(User, { id: "u1", name: "Ada" });
em.persist(user);
await em.flush();
```

The public surface contains entity definition, runtime creation, and the
request-local `EntityManager` lifecycle: `fork()`, `create()`, `find()`,
`findOne()`, `persist()`, `remove()`, `flush()`, and `transactional()`.
MikroORM, raw SQL, gateway clients, Sheet routes, provisioning, polling, and
outbox controls are internal.

## SQLite authority

Business entity tables are the authoritative application data. Normal reads
always come from SQLite and never from a Sheet. The public local runtime opens
entity tables only and does not contact Google Sheets or create sync tables.

When the internal sync service is active, its mapped flush coordinator extends
the same SQLite transaction with:

```text
entity mutation
canonical sync state
projection registry/state
Sheet effect outbox
```

The service-side configuration supplies the required `System_State`,
`User_Input`, and `Sync_Conflicts` routes, spreadsheet identity, and user-owned
fields. Those values are not entity metadata or public ORM options. Every
internal sync runtime fails closed if any of the three physical routes or its
fixed headers are missing or drifted.

## Google Sheets projection

The internal service provisions and validates registered projection tabs before
starting delivery. It owns the signed Apps Script client, effect worker,
response-loss recovery, reconciliation, and User_Input polling.

The application does not call Sheet operations. A successful public `flush()`
means that the local SQLite transaction committed. It does not mean that a
remote Sheet write has completed.

The MVP gateway is a single file, `apps-script/gateway/Code.gs`, copied into a
spreadsheet-bound Apps Script project and deployed as a Web App. The deployer
pastes the `/exec` URL into `TYPED_SHEETS_GATEWAY_URL` and runs
`setupSyncGateway()` from the editor, which stores the bound spreadsheet ID and
a generated shared secret in Script Properties. This default path requires no
`appsscript.json` manifest, no Apps Script Advanced Sheets Service, no Google
Cloud Sheets API activation, and no service account. Sheet consistency does
not rely on cross-request Sheet transactions; it comes from the Apps Script
script lock, the hidden effect-receipt tab, effect-id/payload-hash dedupe, the
SQLite durable outbox, fencing, and postcondition recovery.

`System_State` is materialized from canonical SQLite state. `User_Input` is
observed by the internal polling loop, evaluated with ownership and field-level
compare-and-set rules, and then committed back to SQLite. `Sync_Conflicts` is a
system-owned audit projection of field-level conflict evidence and resolution
outcomes; it is created even when empty and resolved rows remain visible for
audit. A detected conflict is resolved with the fenced `acknowledge_system`
policy: revision, candidate-hash, and epoch CAS clear the active candidate and
queue the canonical User_Input rewrite. A newer remote edit that fails that CAS
starts a new conflict instead of being overwritten. Stale, conflicting, and
malformed input is therefore never silently written over the entity table.

## Transaction and lifecycle boundary

```text
em.persist(entity) / em.remove(entity)
          │
          ▼
SQLite transaction (internal sync service mode)
  ├─ entity table
  ├─ canonical state and conflict evidence
  ├─ automatic system-wins resolution receipt/state
  └─ durable Sheet effect outbox
          │
          ▼
internal outbound effect supervisor
  ├─ claim leases and send bounded signed operation batches
  ├─ persist delivery uncertainty and due postcondition probes in SQLite
  ├─ fence remote routes with the current spreadsheet authority epoch/token
  └─ reconcile remote drift
          │
          ▼
Apps Script gateway ──▶ Google Sheets

internal User_Input polling
  ├─ adaptive values-only preflight over registered projections
  ├─ escalate changed/ambiguous/schema tables to full metadata
  ├─ periodic safety full scan for formula/merged/error fidelity
  ├─ evaluate ownership/revisions/CAS
  ├─ persist conflict evidence and automatic system-wins resolution in SQLite
  └─ persist accepted observations and entity mutations in SQLite
```

Inbound polling defaults to an adaptive values-only preflight that reads the
cheap value surface and only escalates a table to the metadata-preserving
snapshot read when it changed, is ambiguous (unknown or duplicate business key,
a missing expected entity, or a type-invalid cell), or when the periodic safety
full scan falls due. The safety scan (default one minute, configurable) keeps
formula, merged, and error cell fidelity because the values-only read drops that
metadata; the scan's overdue lag is recorded for diagnostics. Outbound effects
are split into bounded sub-batches per physical route so one gateway call returns
a complete result set, and a pass that only requeued uncertain work backs off with
a bounded delay instead of retrying a struggling remote in a tight loop.

The service bootstrap starts provisioning, outbound delivery, and inbound polling
as one internal runtime. Outbound dispatch keeps the SQLite outbox as its only
durable buffer, coalesces only a short in-process burst, and adapts each route's
Gateway batch between five and twenty effects from latency and response-loss
signals. The effect lease is longer than the configured Gateway timeout so a
slow but valid request is recovered only after its remote result is checked.
Ambiguous delivery is stored as `delivery_uncertain` with `uncertain_since`,
`next_probe_at`, and `dispatch_id`; only a due probe may return it to processing.
A terminal structured remote failure does not enter the ambiguous probe path.
Shutdown stops polling first, waits for remote calls, stops the outbound
supervisor, and only then closes SQLite.

## Design limits

Hikoutei targets one local SQLite writer process and low-traffic MVP or internal
workflows. It is not a distributed transaction coordinator, a general-purpose
database, or a Google Sheets API replacement. Live Google integration remains
opt-in; normal tests use fake gateways and SQLite fixtures.
