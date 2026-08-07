---
title: What is Hikoutei
description: Hikoutei is a typed repository and safe write layer for Google Sheets-backed MVPs — SQLite is the authority, Google Sheets is the human-facing view.
---

# What is Hikoutei?

Hikoutei gives TypeScript applications a typed entity API backed by local
SQLite, then asynchronously synchronizes committed changes to Google Sheets.

Your application does not wait on Google Sheets for normal reads and writes.
Sheets remains available for inspection, operations, and lightweight human
collaboration.

> Hikoutei is not a raw Sheets API wrapper, not a replacement for PostgreSQL,
> and it does not treat Google Sheets as the authoritative application
> database. SQLite is the source of truth; Sheets is the human-facing view.

## How it compares

| Capability | Hikoutei | google-spreadsheet | @googleapis/sheets |
| --- | :-: | :-: | :-: |
| Typed entity model | ✅ | ❌ | ❌ |
| Fast local application reads | ✅ | ❌ | ❌ |
| Async projection to Sheets | ✅ | ❌ | ❌ |
| Durable write retry and deduplication | ✅ | ❌ | ❌ |
| Conflict-aware Sheet updates | ✅ | ❌ | ❌ |
| Direct row and cell manipulation | Limited | ✅ | ✅ |
| Full Google Sheets API access | Provider only | Partial | ✅ |

Hikoutei does not replace `google-spreadsheet` or `@googleapis/sheets` — it
sits one level above them. If you only need raw spreadsheet access, use the
API client directly.

## When to use Hikoutei

- MVPs and prototypes where a spreadsheet is part of the product workflow.
- Internal tools and low-traffic administrative applications.
- Teams that want typed application data while keeping Sheets easy for people
  to inspect.
- Services that can use SQLite locally and accept asynchronous Sheet updates.

## When to choose something else

Use a conventional database and direct Google APIs when you need strong
transactions, high write throughput, complex queries, multi-server
coordination, immediate read-after-write consistency in Sheets, or Google
Sheets as the primary database.
