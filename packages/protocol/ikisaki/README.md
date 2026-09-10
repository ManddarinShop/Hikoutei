# @hikoutei/ikisaki

## Purpose
Durable, ordered, idempotent delivery queue bound to the business transaction.
Owns its SQL port, schema DDL, and errors; the effect payload stays opaque
(route keys, ordering keys, fencing, lifecycle evidence only).

## Boundary
Must not import entity/Sheets/Google SDK code — enforced by
`test/protocol-import-boundary.test.ts`. Runtime dependency is `zod` only;
shared `contracts` primitives (`encoding`/`state`/`identity`) are `import type` only.

## Entry
`src/index.ts` (kernel ownership header); `src/outbox/`, `src/worker/`, `src/sql/`.
