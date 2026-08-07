# Framework Examples

Hikoutei is framework-agnostic: the root API (`createTypedSheets` + the
request-local `EntityManager`) runs in any Node.js process, and each example
below shows the same entity-lifecycle pattern adapted to a popular stack.

> Runtime premise: Node.js >= 22.3, a local SQLite file, and a long-lived
> process.
>
> **Sheets sync via environment:** set `HIKOUTEI_SYNC_SPREADSHEET_URL`
> (and `GOOGLE_APPLICATION_CREDENTIALS`) in `.env` — see each example's
> `.env.example` — and `createTypedSheets()` starts the Sheets sync
> internally; `flush()` then flows to Google Sheets automatically through
> the outbox worker. Without the env var the examples run local-only.

| Example | Stack | Pattern |
| --- | --- | --- |
| [express](express/) | Express | request-scoped `em.fork()` via middleware |
| [fastify-hono](fastify-hono/) | Fastify + Hono | same pattern, two servers |
| [nestjs](nestjs/) | NestJS | lifecycle module + provider |
| [nextjs](nextjs/) | Next.js App Router | `globalThis` singleton, route handlers |
| [trpc](trpc/) | tRPC | request-scoped em in procedures |
