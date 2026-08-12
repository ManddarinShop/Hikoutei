---
title: Project status
description: Hikoutei is in active development — the entity API is usable while Sheet edit ingestion and conflict presentation evolve.
---

# Project status

Hikoutei is in active development. The scalar EntityManager supports typed
local filters and ordering, pagination, `count()`, and snapshot-consistent
`findAndCount()`. Reads use the SQLite authority and do not query Sheets.
Sheet edit ingestion and conflict presentation are still evolving. Review
release notes before upgrading minor versions.

## EntityManager roadmap

Rich local reads are complete. The remaining sequence is:

1. Add lifecycle-safe upsert and mutation capabilities without bypassing the
   entity/canonical/outbox transaction.
2. Design relationships and population together with their Sheets projection
   and conflict semantics.
3. Add migration and schema-drift operations integrated with setup tooling.

## Synchronization and operations

- Complete ingestion of intentional user edits from Google Sheets.
- Improve update/delete conflict handling and presentation.
- Improve setup tooling for registry and direct-provider deployment.

See the
[open issues](https://github.com/ManddarinShop/Hikoutei/issues) for current
work.

## Contributing

Hikoutei is a solo-maintained, open-source project with a documented
contribution and release process:

- [CONTRIBUTING.md](https://github.com/ManddarinShop/Hikoutei/blob/develop/CONTRIBUTING.md)
- [Release process](https://github.com/ManddarinShop/Hikoutei/blob/develop/docs/release-process.md)

Bug reports and feature requests use the repository's issue templates
(`type:` / `area:` / `status:` labels).
