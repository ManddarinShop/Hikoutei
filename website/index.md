---
layout: home

hero:
  name: Hikoutei
  text: Typed repository and safe write layer for Google Sheets-backed MVPs
  tagline: Keep your app fast with SQLite. Keep your workflow visible in Google Sheets.
  actions:
    - theme: brand
      text: Quick start
      link: /guide/quick-start
    - theme: alt
      text: View on GitHub
      link: https://github.com/ManddarinShop/Hikoutei

features:
  - title: SQLite is the authority
    details: Your application reads and writes typed entities against local SQLite. Normal reads never wait on a remote spreadsheet request.
  - title: Sheets is the human view
    details: Committed changes are asynchronously projected to Google Sheets for review, operations, and lightweight collaboration.
  - title: Safe writes
    details: Durable outbox, idempotent delivery, and conflict-aware updates protect against overwriting newer Sheet edits.
---

## What is Hikoutei?

Hikoutei gives TypeScript applications a typed entity API backed by local
SQLite, then asynchronously synchronizes committed changes to Google Sheets.
It is not a raw Sheets API wrapper, not a replacement for PostgreSQL, and it
does not treat Google Sheets as the authoritative application database.

- [What is Hikoutei](/guide/what-is-hikoutei)
- [Quick start](/guide/quick-start)
- [Architecture](/guide/architecture)
- [Internal consistency model](/guide/internal-consistency)
