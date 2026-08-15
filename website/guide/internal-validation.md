---
title: Runtime boundary validation
description: How Hikoutei validates untrusted wire, configuration, and provider values without replacing domain invariants.
---

# Runtime boundary validation

Hikoutei uses TypeScript types for compile-time contracts and Zod for selected
runtime boundaries. A value received from JSON, a future gateway transport, a
configuration file, or a provider SDK is not trusted merely because a
TypeScript type exists for it.

The promotion flow is:

```text
unknown wire/config/provider value
  → Zod shape validation
  → Hikoutei error-code mapping
  → internal discriminated contract
  → domain invariant and CAS validation
```

## Where Zod is used

Zod validates structural shape at these boundaries:

- Sheets gateway request envelopes
- persisted projection payloads
- service-account and sync startup configuration
- durable manifest and registry JSON
- selected Google Sheets API response and transport-error shapes

Schemas are kept near the module that owns the boundary. They are internal
implementation details and are not exported from `src/index.ts`.

## What Zod does not replace

Zod does not decide whether an operation is safe or valid in the Hikoutei
domain. The existing implementations remain responsible for:

- stable canonical encoding and hashes
- entity revisions and conflict transitions
- compare-and-set evidence
- writer leases and fencing
- SQLite transactions and SQL invariants
- outbox state transitions and recovery
- Google Sheets semantic interpretation

For example, Zod can verify that a projection payload contains a string hash
and a record of cells. Hikoutei still recomputes the visible hash and rejects a
mismatch.

## Error handling

Boundary code uses `safeParse()` and maps failures to the owning Hikoutei error
family. Raw `ZodError` instances and invalid values are not exposed to
applications. Diagnostic summaries are bounded and never include credential or
payload values.

## Adding a new boundary

When adding a new external input:

1. Keep the raw value as `unknown`.
2. Add a schema beside the owning adapter or application module.
3. Use `safeParse()` and map the failure to a stable error code.
4. Promote the parsed wire shape into an existing internal type.
5. Keep semantic, concurrency, and persistence checks outside the schema.
6. Add malformed-input and valid-promotion tests.

Zod is intentionally not used for every hot-path SQL row or normalized cell.
Those paths retain explicit domain validators where they carry stronger error
semantics or avoid repeated runtime work.
