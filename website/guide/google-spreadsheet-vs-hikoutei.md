---
title: Google Spreadsheet vs Hikoutei
description: When to use a plain Google Spreadsheet, and when to back it with Hikoutei's SQLite-authoritative entity layer.
---

# Google Spreadsheet vs Hikoutei

A plain Google Spreadsheet is a great collaboration surface. Hikoutei is a
typed repository and safe write layer for Google Sheets-backed MVPs — it keeps
the spreadsheet as the human-facing view while moving application reads and
writes to local SQLite. The two are not competitors; they serve different
sides of the same workflow.

## Start with a plain spreadsheet when

- People are the only readers and writers, and the data is small.
- There is no application logic over the rows yet.
- You need ad-hoc filtering, formatting, and comments as the primary interface.

A raw spreadsheet gives you instant human collaboration with zero
infrastructure. If that covers the whole workflow, there is nothing to build.

## Add Hikoutei when the spreadsheet becomes an application

The moment application code needs to read or write the same rows, a spreadsheet
becomes a poor database: reads are slow and quota-bound, writes race with human
edits, and there is no schema or transaction boundary.

Hikoutei keeps the spreadsheet for people and moves the application to SQLite:

| Concern | Plain spreadsheet | Hikoutei |
| --- | --- | --- |
| Human review and editing | Native | Native (async projection + `User_Input` observation) |
| Typed application reads | Manual row conversion | Typed entity API over local SQLite |
| Application writes | Direct API calls, quota-bound | Local commit + durable outbox |
| Schema drift | Undetected until parse errors | Header validation and clear failures |
| Overwriting human edits | Easy to do by accident | Conflict-aware updates with compare-and-set evidence |

## What Hikoutei is not

- **Not a database replacement.** SQLite is the authority; Sheets stays a
  projection and input surface.
- **Not a raw Sheets API wrapper.** Direct row and cell manipulation remains
  limited; if that is all you need, use `google-spreadsheet` or
  `@googleapis/sheets` directly.
- **Not a transaction-safe database on top of Sheets.** Sheet updates are
  asynchronous; a successful `flush()` commits SQLite, outbox state, and the
  durable effect log in one local transaction, but does not mean the Sheet
  write has completed.

## Decision guide

- Team edits the rows directly, no application involved → spreadsheet.
- Application reads/writes, humans review in Sheets → Hikoutei.
- High write throughput, complex queries, or multi-region coordination →
  a conventional database; Hikoutei and spreadsheets are the wrong tool.

Related: [Google Sheets as an ops UI](/guide/google-sheets-as-ops-ui).
