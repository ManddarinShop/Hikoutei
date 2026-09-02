---
title: Internal consistency model
description: How Hikoutei protects against concurrent writes, response loss, and human edits — CAS, epochs, fencing, the outbox state machine, and candidate protection.
---

# Internal consistency model

Hikoutei's sync engine decides every conflict with **evidence comparison, not
wall-clock time**: revisions, hashes, epochs, and tokens. This page summarizes
the internal mechanisms behind that policy.

## Single writer: lease, epoch, fencing token

A worker claims a SQLite `writer_lease` (`role`, `writer_id`,
`writer_epoch`, `fencing_token`, `lease_until`, `heartbeat_at`). Takeover
increments the epoch and issues a new token. Every storage mutation is
guarded by:

```text
WHERE ... AND EXISTS (
  SELECT 1 FROM writer_lease
  WHERE role = ? AND writer_epoch = ? AND fencing_token = ? AND lease_until > ?)
```

A stale epoch/token is rejected even if the row did not change.

### Takeover: expiry OR dead-writer heartbeat evidence

A live writer keeps its lease fresh two ways: pass-time renewals stamp
`heartbeat_at`, and a background renew-only heartbeat timer renews on a
5 s cadence. A lease may be taken over when it EXPIRED (`lease_until <=
now`) **or** when the owner's `heartbeat_at` is stale (older than 15 s
while `lease_until` is still in the future — the owner is presumed dead;
NULL-heartbeat rows, written before the evidence column existed, stay on
the expiry-only rule). Takeover always bumps epoch + fencing token, so the
displaced writer's mutations are fenced out through the same CAS above,
and its in-flight work is recovered exactly like a crash: pre-dispatch
renewal aborts before any remote call, post-ack bookkeeping is rejected,
and the new owner recovers the rows through the durable outbox. The
background heartbeat never claims or takes over — it only extends the
caller's own live lease, so a running timer can never steal the lease back
from a live owner.

## Remote write protection: authority + visible-hash CAS

- The SQLite writer epoch/token is mirrored into `spreadsheet_authority` and
  carried on every remote mutation request; an older `authority_epoch` is
  rejected.
- Effects carry `expectedVisibleRevision` + `expectedVisibleHash`. The
  provider reads, compares hashes, writes only on match, and returns a receipt
  with the new visible revision/hash. The worker verifies the receipt hash
  against the effect target before closing the outbox row as `applied`.

## Outbox state machine

```text
pending → processing → applied / failed / superseded / blocked_candidate / conflict
   └──────────────→ delivery_uncertain (response loss) → probe → pending/applied
```

- Claim is CAS-guarded and ordered: an effect is not claimable until the
  previous `stream_sequence` for the same target settles.
- Timeout/response loss becomes `delivery_uncertain` with a due probe; only a
  due probe returns it to processing, and the probe reads remote postconditions
  as evidence.
- Idempotency: same effect ID + same payload hash retries safely; same ID with
  a different payload fails closed.
- A `failed` effect with a **recoverable** error code stays on the worker retry
  path. A `failed` effect with a terminal code (for example
  `delivery_uncertain_timeout`) can never be claimed again, so the periodic
  reconciliation scan supersedes it (fence-checked, in the same SQLite
  transaction as its replacement effect) and the stream keeps progressing.
  Recoverable failed heads are never superseded by reconciliation.

## Human edits: candidates and epochs

- `sheet_visible_field_state` tracks per-field confirmed hashes plus an active
  candidate (`active_candidate_hash`, `candidate_epoch`).
- Detecting a `User_Input` value A against canonical value B persists the active
  candidate, candidate-time full-row visible revision/hash, and an `OPEN`
  conflict. It queues only the `OPEN` audit projection; polling and restarts do
  not create a resolution command or resolve the conflict.
- Only a later local commit with a strictly higher canonical revision on the
  same conflicted field triggers implicit system-wins. Unrelated fields and
  same-value writes without a field-revision increase are not approval.
- The `acknowledge_system` command compares canonical revision, candidate hash,
  and `candidate_epoch`. Its asynchronous row reconcile compares the stored
  candidate-time visible revision/hash, so a later human edit makes the
  reconcile `blocked_candidate` rather than being overwritten. Resolution
  clears the candidate and increments its epoch to prevent ABA reuse.
- A legacy conflict without candidate visible evidence remains unresolved; the
  resolver never substitutes confirmed state or guesses a CAS baseline.
- In this policy scope, deleting a row with an unresolved conflict fails closed
  before its local entity, canonical state, or outbox changes commit.

## Row identity and stable encoding

- Row identity is a physical anchor + SQLite `row_binding_id` (stable hash of
  logical sheet and anchor), never a physical row number; duplicate anchors
  fail closed into quarantine.
- `@hikoutei/kohkai` provides canonical encoding (UTC dates, NFC strings,
  deterministic serialization) so equal values always hash equal — the
  foundation of every comparison above.

## Summary

| Mechanism | Role | Core evidence |
| --- | --- | --- |
| Writer lease + fencing | Single SQLite writer | `writer_epoch` + `fencing_token` |
| Spreadsheet authority | Remote write generation | `authority_epoch` + `authority_token` |
| Visible-hash CAS | Conditional Sheet writes | expected revision/hash + receipt verification |
| Outbox state machine | Ordering, retry, response-loss recovery | `stream_sequence`, `claim_token`, `next_probe_at` |
| Candidate resolution CAS | System-advance and human-edit protection | canonical field revision + candidate-time visible revision/hash + candidate hash/epoch |
| Anchor + rowBindingId | Stable row identity | physical anchor + stable hash |
| Kohkai encoding | Consistent evidence hashes | canonical encoding + deterministic hash |
