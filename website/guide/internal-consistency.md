---
title: Internal consistency model
description: How Hikoutei protects against concurrent writes, response loss, and human edits — CAS, epochs, fencing, the outbox state machine, and candidate protection.
---

# Internal consistency model

Hikoutei's sync engine decides every conflict with **evidence comparison, not
wall-clock time**: revisions, hashes, epochs, and tokens. This page summarizes
the mechanisms; the full detail lives in the repository's
[`docs/internal-consistency-model.md`](https://github.com/ManddarinShop/Hikoutei/blob/develop/docs/internal-consistency-model.md).

## Single writer: lease, epoch, fencing token

A worker claims a SQLite `writer_lease` (`role`, `writer_id`,
`writer_epoch`, `fencing_token`, `lease_until`). Takeover increments the epoch
and issues a new token. Every storage mutation is guarded by:

```text
WHERE ... AND EXISTS (
  SELECT 1 FROM writer_lease
  WHERE role = ? AND writer_epoch = ? AND fencing_token = ? AND lease_until > ?)
```

A stale epoch/token is rejected even if the row did not change.

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
- A human edit that does not match the confirmed field hash becomes a
  candidate (conflict `OPEN`); system repairs on that field are blocked
  (`blocked_candidate`) until resolution.
- `Sync_Conflicts.resolve_requested` is a one-shot request. Resolution applies
  `acknowledge_system` with CAS on revision, candidate hash, and
  `candidate_epoch`, then increments the epoch — so an old request cannot
  resolve an ABA retry that returned to the same candidate value.

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
| Candidate + epoch | Human-edit protection, ABA prevention | `active_candidate_hash` + `candidate_epoch` |
| Anchor + rowBindingId | Stable row identity | physical anchor + stable hash |
| Kohkai encoding | Consistent evidence hashes | canonical encoding + deterministic hash |
