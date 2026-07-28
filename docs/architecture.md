# Hikoutei Architecture

Hikoutei owns a local SQLite entity store and exposes Google Sheets as an
asynchronous human-facing projection. The public API belongs to Hikoutei;
MikroORM is the current replaceable execution engine behind that API.

## System shape

```text
Application server
  └─ TypedSheets entity API
       ├─ entity definitions and relations
       └─ TypedSheets EntityManager
            └─ replaceable persistence engine
                 └─ MikroORM + SQLite (current provider)
                      ├─ business entity tables
                      ├─ sync metadata and conflict ledger
                      └─ durable Sheet effect outbox
                           └─ separate sync worker
                                └─ signed Apps Script gateway
                                     └─ Google Sheets projections
```

## Ownership boundaries

### TypedSheets public API

Applications define entities with `defineTypedSheetsEntity()` and use the
typed-sheets EntityManager for `fork()`, `create()`, `find()`, `persist()`,
`remove()`, `flush()`, and `transactional()`.

Applications do not import `defineEntity`, `p`, `MikroORM`, or provider-specific
SQL types. The public entity definition is materialized by the current
MikroORM adapter and can later be materialized by another engine.

### Business entity tables

The ORM entity tables are the authoritative application data. A successful
SQLite transaction commits the entity mutation together with the sync work
needed to project it to Sheets.

Primary keys are explicit, string-valued, and immutable in the initial release.
Relations initially support `manyToOne` and `oneToMany`; the owning
`manyToOne` side stores the foreign key. `manyToMany`, lazy loading, and
cascade persistence are out of scope for the first release.

### Sync metadata

Sync tables record bindings, revisions, visible Sheet state, event evidence,
conflicts, resolution commands, leases, and outbox effects. They are not
additional business tables such as `Users_System` or `Users_Input`.

The sync layer must not become a second source of application field values.
Where it needs a value for hashing or conflict evidence, it stores the minimum
required normalized snapshot or audit evidence and the entity table remains the
application authority.

### Google Sheets projections

Each mapped entity can have a protected `System_State` projection and an
editable `User_Input` projection. The application never reads normal entity
data from Sheets. It reads SQLite; the worker observes User_Input only to
evaluate intentional human changes.

There is one global `Conflict` projection. A conflict row contains one field-
level decision and two mutually exclusive controls:

```text
conflict_id | entity_name | entity_id | field_name |
system_value | user_value | use_system | use_user
```

No checked control is a pending decision. Exactly one control creates a
compare-and-set resolution command. Both checked controls are invalid and are
reset. A stale command is reset and leaves the conflict visible for rebase.
After a successful resolution, SQLite records the result first and a durable
outbox effect removes the resolved row from the Conflict projection.

## Transaction boundary

The transaction boundary ends at SQLite commit:

```text
em.persist(entity) / em.remove(entity)
          │
          ▼
SQLite transaction
  ├─ business entity table
  ├─ sync metadata and conflict state
  └─ durable Sheet effect outbox
          │
          ▼
separate worker process
  ├─ drain outbound effects
  ├─ poll User_Input
  ├─ evaluate accepted fields and conflicts
  └─ poll and apply Conflict decisions
          │
          ▼
Google Sheets projection
```

`flush()` returning successfully means that SQLite accepted the local change
and the corresponding remote work is durable. It does not mean that a Sheet
write has completed.

## Worker responsibilities

The initial inbound source is polling. `onEdit` can be added later as an
optional lower-latency observation source, but it must enter the same evaluator
and SQLite writer boundary.

The worker claims leases, sends signed gateway operations, retries recoverable
failures, and reconciles remote drift. The Apps Script gateway performs only
the signed, range-constrained Sheet operation; it does not choose conflict
winners or own canonical state.

## Design limits

Hikoutei targets one local SQLite writer process and low-traffic MVP or internal
workflows. It is not a distributed transaction coordinator, a general-purpose
database, or a Google Sheets API replacement.
