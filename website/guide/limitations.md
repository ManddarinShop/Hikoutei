---
title: Limitations
description: Google Sheets quota, async delivery, local-only SQLite, and operational policy — what Hikoutei does not promise.
---

# Limitations

- Google Sheets has quota, latency, and API rate limits.
- Sheet updates are asynchronous; the application should read its local state.
- SQLite is local to the service and is not a distributed coordination layer.
- Schema changes, manual edits, and conflicting updates still need an
  operational policy from the application.

## What Hikoutei is not

- Not a general-purpose database replacement.
- Not a Prisma/JPA clone.
- Not a general-purpose Google Sheets API wrapper — use
  `@googleapis/sheets` or `google-spreadsheet` for raw spreadsheet access.
- Not a transaction-safe database on top of Sheets. The SQLite commit is the
  application success boundary; remote delivery is at-least-once and
  asynchronous, and compare-and-set evidence is not a true distributed
  transaction.
