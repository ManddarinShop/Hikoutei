---
layout: home

hero:
  name: Hikoutei
  text: Typed repository and safe write layer for Google Sheets-backed MVPs
  tagline: Keep your app fast with SQLite. Keep your workflow visible in Google Sheets.
  actions:
    - theme: brand
      text: Get Started →
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
  - title: Type-first API
    details: Define entities once with a typed schema and get an entity-lifecycle manager modeled on the MikroORM/JPA workflow.
---

## See it in action

Add a row below — this mirrors the Hikoutei write path: commit to SQLite,
queue in the durable outbox, then project to Sheets.

<SyncDemo />

## Community & support

Questions, ideas, or a project that needs Sheets as a human interface?
Open an issue on [GitHub](https://github.com/ManddarinShop/Hikoutei), or
start with the [quick start](/guide/quick-start) guide.
