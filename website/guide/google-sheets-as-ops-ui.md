---
title: Google Sheets as an ops UI
description: Use Google Sheets as the asynchronous human-facing surface for operations, approvals, and lightweight collaboration while SQLite stays authoritative.
---

# Google Sheets as an ops UI

Google Sheets is not the database — it is the **ops UI**. Hikoutei projects
committed SQLite state to a spreadsheet so people can inspect, filter, and
annotate application data without touching code, while the application keeps
reading and writing local SQLite.

## The division of labor

| Layer | Role |
| --- | --- |
| SQLite | Application authority: typed entities, durable outbox, canonical sync state |
| Outbox worker | Asynchronously projects committed changes to the Sheet |
| Google Sheets | Human-facing projection and input surface |
| `User_Input` observation | Evaluates intentional human edits and records conflicts in SQLite |

The application never reads normal entity data from Sheets. Sheets writes are
delivered asynchronously through the outbox worker, and human edits are
observed, validated, and either accepted back into SQLite or recorded as
conflicts — never silently overwritten.

## Why this works for MVP workflows

- **Fast application reads.** Normal reads hit local SQLite, not the network.
- **Human-in-the-loop without code.** Approvals, status changes, and notes
  happen in the spreadsheet people already know.
- **Safe writes.** Durable outbox, idempotent delivery, and conflict-aware
  updates protect against overwriting newer Sheet edits.

## What to watch out for

- **Quota and latency.** Sheets is rate-limited; projection is asynchronous by
  design. Never put a spreadsheet on a hot request path.
- **Schema drift.** Header changes and duplicate headers fail clearly at
  validation time.
- **Operational policy.** Manual edits and conflicting updates still need an
  application policy for acceptance or conflict resolution.

## Templates

- [Sheet approval template](/templates/sheet-approval) — a Next.js approval
  queue with a spreadsheet as the review surface.
- [MCP human review template](/templates/mcp-human-review) — AI agents queue
  review rows through MCP; people review them in Sheets.
