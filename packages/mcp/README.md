# spreadsheet-db-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that lets AI agents
(Claude Desktop, Cursor, Windsurf, …) work with entities managed by
[Hikoutei](https://github.com/ManddarinShop/Hikoutei) — a typed repository where
**local SQLite is the authority** and Google Sheets is an asynchronous, human-facing projection.

Agents read and write SQLite through the same entity-lifecycle API an application would use.
Sheet delivery happens in the background via Hikoutei's durable outbox, so an agent never
fights the Sheets API quota, and a human editing the Sheet never gets silently overwritten:
their edits surface as conflicts that need a human decision.

> Status: **v0.1.0 — published to npm as [`spreadsheet-db-mcp`](https://www.npmjs.com/package/spreadsheet-db-mcp).**
> Releases are tagged `mcp-vX.Y.Z`; the `mcp-publish` workflow patches the manifest, verifies a
> bare consumer install, and publishes with provenance.

## Why this exists

Direct Sheets-API MCP servers hit three walls quickly: quota errors (429), schema-less cells
(anything lands anywhere), and silent clobbering of concurrent human edits. Hikoutei's model
avoids all three by design:

- **Agent → SQLite.** All reads/writes commit locally first; `flush()` is fast and offline.
- **SQLite → Sheets, asynchronously.** A durable outbox delivers effects with retry and
  stale-write protection; sessions can end mid-delivery and resume later.
- **Human → Sheet → conflicts.** Human edits in the `User_Input` projection are detected,
  recorded, and never auto-overwritten. v1 exposes them read-only via `list_conflicts`.

## Install (once published)

```sh
npx -y spreadsheet-db-mcp
```

## Configuration

The server needs (1) an entity declaration file and (2) the same environment variables the
library uses.

### 1. `hikoutei.config.json`

Search order: `--config <path>` flag → `HIKOUTEI_MCP_CONFIG` env var →
`./hikoutei.config.json` in the working directory.

```json
{
  "entities": [
    {
      "name": "users",
      "tableName": "users",
      "properties": {
        "id": { "type": "string", "primary": true },
        "name": { "type": "string" },
        "age": { "type": "number", "nullable": true },
        "createdAt": { "type": "date" }
      }
    }
  ]
}
```

- `type` is one of `string`, `number`, `boolean`, `date` (ISO 8601 strings cross the tool boundary).
- Exactly one property per entity must be `primary: true`; it is immutable after create.
- Names and table names must be SQL identifiers; tables reserved by Hikoutei or SQLite are rejected.

### 2. Environment

| Variable | Meaning |
| --- | --- |
| `HIKOUTEI_SYNC_SPREADSHEET_URL` | Spreadsheet URL; **absent ⇒ local-only mode** (no Google contact) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service-account key file path (from `hikoutei setup`) |
| `HIKOUTEI_DB_PATH` | SQLite path; default `./hikoutei.sqlite` |

The server loads `.env` (or `--env <path>`) into gaps in the environment before startup, so the
`.env` written by `hikoutei setup` can be reused as-is. Variables already set in the process
always win.

### Client setup

```json
{
  "mcpServers": {
    "hikoutei": {
      "command": "npx",
      "args": ["-y", "spreadsheet-db-mcp"],
      "env": {
        "HIKOUTEI_SYNC_SPREADSHEET_URL": "https://docs.google.com/spreadsheets/d/<ID>/edit",
        "GOOGLE_APPLICATION_CREDENTIALS": "~/.gcp/hikoutei-service-account.json"
      }
    }
  }
}
```

For a local (unpublished) build, point `command` at `node` with
`<repo>/packages/mcp/dist/index.js` as the argument and set the working directory where
`hikoutei.config.json` lives.

## Tools (v1)

| Tool | Input | Behavior |
| --- | --- | --- |
| `list_entities` | — | Entities with fields, types, primary keys |
| `create_record` | `entity`, `data` | Validate → insert into SQLite → return stored row |
| `find_records` | `entity`, `where?`, `limit?`, `offset?`, `orderBy?` | Filtered read; limit default 50, max 500 |
| `get_record` | `entity`, `id` | Single read by primary key |
| `update_record` | `entity`, `id`, `data` | Partial update; primary key immutable |
| `delete_record` | `entity`, `id` | Delete by primary key |
| `get_sync_status` | — | Mode, bound spreadsheet ID, outbox counts, unresolved conflict counts |
| `list_conflicts` | `limit?` | Unresolved human-edit conflicts (read-only) |

`where` maps a field to a value (equality) or an operator object:
`eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`, `like`.

## Verify locally (before publishing)

```sh
npm run build          # root build builds ikisaki → root dist → this package
mkdir -p /tmp/spreadsheet-db-mcp-demo && cd /tmp/hikoutei-mcp-demo
# write hikoutei.config.json (see above; no env needed for local-only mode)
npx @modelcontextprotocol/inspector /path/to/Hikoutei/packages/mcp/dist/index.js
```

In the Inspector: connect → list tools → call `list_entities`, `create_record`,
`get_sync_status` (expect `{"mode": "local"}`). No credentials are required for this smoke test.

## Limitations (v1)

- **No `resolve_conflict` yet.** Conflicts are listed read-only; resolution tooling is planned.
- **Entities are fixed per session.** They come from `hikoutei.config.json`; defining entities
  at call time is not supported.
- **Single server process per database.** Running two `spreadsheet-db-mcp` processes against the
  same SQLite file concurrently is not supported.
- **stdio transport only.** No remote/OAuth server mode.
- `get_sync_status` / `list_conflicts` read the internal sync tables through the unstable
  `hikoutei/internal/sync-status` subpath, which is reserved for first-party tooling.

## Development

```sh
npm run build -w spreadsheet-db-mcp        # after the root build
npm run typecheck:test               # includes packages/mcp
npm test                             # vitest includes packages/mcp/test
```

License: MIT (same as the repository).
