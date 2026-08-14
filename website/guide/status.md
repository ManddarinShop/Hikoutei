---
title: Project status
description: Hikoutei is in active development — the entity API is usable while Sheet edit ingestion and conflict presentation evolve.
---

# Project status

Hikoutei is in active development. The entity API is usable, while Sheet edit
ingestion and conflict presentation are still evolving. Review release notes
before upgrading minor versions.

## Current scope

- **Scalar EntityManager only** — entity lifecycle operations, typed scalar
  local queries (`eq` / `ne` / `gt` / `gte` / `lt` / `lte` / `in` / `nin` and
  string-only `like`), `count()`, snapshot-consistent `findAndCount()`,
  ordering, `limit` / `offset` pagination, and callback-style
  `transactional()`. Relationships, joins, and full ORM features — along
  with schema migrations — are not available yet.
- **Async Sheets projection** — `flush()` commits SQLite locally; the Sheet
  write is delivered asynchronously by the outbox worker and is at-least-once,
  not immediate. Reads always come from SQLite, never Sheets.
- **Shipped setup path** — the `hikoutei setup` CLI and the direct Google
  Sheets API provider (the only sync path, env-driven auto-start) are in
  place; no Apps Script gateway.
- **Live verification is opt-in** — it requires a service account, a
  spreadsheet shared with it, and external quota; the normal suite uses fake
  providers and SQLite fixtures.

## Limitations

- Best fit for low traffic and a single local writer; SQLite is not a
  distributed coordination layer and the library is not designed for many
  concurrent writers.
- Inbound user-edit ingestion and conflict presentation are still evolving:
  new conflicts stay OPEN, and resolution is the implemented implicit
  system-wins policy rather than a checkbox-driven review flow.
- Hikoutei does not claim broad production readiness; evaluate it for your
  workload and review release notes before upgrading minor versions.

## Roadmap

- Complete ingestion of intentional user edits from Google Sheets.
- Improve update/delete conflict handling and presentation.

See the
[open issues](https://github.com/ManddarinShop/Hikoutei/issues) for current
work.

## Persistence and synchronization

The public EntityManager delegates to Hikoutei's scalar Unit of Work and
provider SPI. The MikroORM adapter executes the provider-neutral insert,
update, and delete plan together with mapped canonical state and the durable
Sheet outbox in one SQLite transaction. Sheets delivery remains asynchronous.

## Contributing

Hikoutei is a solo-maintained, open-source project with a documented
contribution and release process:

- [CONTRIBUTING.md](https://github.com/ManddarinShop/Hikoutei/blob/develop/CONTRIBUTING.md)
- [Release process](https://github.com/ManddarinShop/Hikoutei/blob/develop/docs/release-process.md)

Bug reports and feature requests use the repository's issue templates
(`type:` / `area:` / `status:` labels).
