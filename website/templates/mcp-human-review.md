---
title: MCP human review template
description: Standalone Model Context Protocol server exposing Hikoutei typed entities to AI agents, with people reviewing results in Google Sheets.
---

# MCP human review template

`create-hikoutei` ships a standalone Model Context Protocol server that exposes
Hikoutei typed entities to AI agents, with people reviewing results in Google
Sheets:

```sh
npm create hikoutei@latest mcp-review -- --template mcp-review
```

AI agents work against **local SQLite** through the MCP tools; committed
changes are **asynchronously projected** to a Google Sheet for human review.
Hikoutei is not a database replacement and not a raw Sheets API wrapper —
SQLite is the authority, Sheets is the human-facing view.

## Quick start (local-only, no Google credentials)

```sh
cd mcp-review
npm install
npm run mcp
```

This starts the stdio MCP server from `hikoutei.mcp.config.mjs`. Connect to it
from an MCP client (Claude Desktop, an agent harness, etc.) over stdio.

## What agents can do

The `HumanReview` entity is configured so that:

- `find` / `find_one` are always available (read-only is the default).
- `create` is enabled, so an agent can queue a review row.
- `update` is restricted to an allowlist: only `decision`, `reviewer`, and
  `reviewedAt` may change. The primary key and `summary` are protected.
- `remove` is disabled.

Every write response distinguishes **"committed to SQLite"** from
**"asynchronous Sheet projection"** — an agent never reports a remote Sheet
write as completed.

## How writes work

`flush()` commits the entity table, canonical sync state, and the durable Sheet
effect outbox in **one local SQLite transaction**. The Google Sheet projection
is delivered asynchronously by the outbox worker.

## Enable the Google Sheets projection (optional)

Copy `.env.example` to `.env` and fill in:

```sh
HIKOUTEI_SYNC_SPREADSHEET_URL=https://docs.google.com/spreadsheets/d/<id>/edit
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

Share the spreadsheet with the service account as an **Editor**.

## Not supported by this template

- **Serverless / read-only filesystems:** SQLite needs a writable local volume.
- **Multi-replica:** a local SQLite file is not a shared coordination layer.

The server itself is [`@hikoutei/mcp`](https://www.npmjs.com/package/@hikoutei/mcp).
