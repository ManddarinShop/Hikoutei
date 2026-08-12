---
title: Sheet approval template
description: Self-hosted Next.js approval queue backed by SQLite-authoritative Hikoutei entities, with Google Sheets as the asynchronous human review surface.
---

# Sheet approval template

`create-hikoutei` ships a self-hostable approval queue built with Next.js
(App Router) and Hikoutei:

```sh
npm create hikoutei@latest sheet-approval -- --template sheet-approval
cd sheet-approval
```

Your application reads and writes typed entities against **local SQLite**.
Committed changes are **asynchronously projected** to a Google Sheet so people
can review and lightly collaborate. Hikoutei is not a database replacement and
not a raw Sheets API wrapper — SQLite is the authority, Sheets is the
human-facing view.

## Quick start (local-only, no Google credentials)

Authentication is deny-closed: without credentials the app serves **no**
unauthenticated requests until you explicitly opt into the local quick start.
Enable it by copying `.env.example` to `.env.local` and setting
`HIKOUTEI_ALLOW_INSECURE_LOCALHOST=true`:

```sh
cd sheet-approval
npm install
cp .env.example .env.local   # then set HIKOUTEI_ALLOW_INSECURE_LOCALHOST=true
npm run dev                  # binds to 127.0.0.1
```

Open `http://127.0.0.1:3000` in a browser. Create approval requests, change
their status, and remove them. None of this contacts Google. Without the
opt-in, development also fails closed: `next dev` rejects every request with
503 until both credentials are configured. The opt-in only applies to
development builds and only for `localhost` / `127.0.0.1` / `[::1]` request
hosts (each with an optional decimal port); a production build never serves
unauthenticated requests, even when the environment variable is set.

## How writes work

`flush()` commits the entity table, canonical sync state, and the durable Sheet
effect outbox in **one local SQLite transaction**. The Google Sheet projection
is delivered asynchronously by the outbox worker. Saving a request therefore
means "committed to SQLite", not "written to the Sheet".

## Enable the Google Sheets projection (optional)

In your local `.env.local`, uncomment and set:

```sh
HIKOUTEI_SYNC_SPREADSHEET_URL=https://docs.google.com/spreadsheets/d/<id>/edit
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

`GOOGLE_APPLICATION_CREDENTIALS` must point at a **real service-account key
file** on disk; never paste JSON content into the variable. Share the
spreadsheet with the service account email as an **Editor**. People can then
inspect and review committed requests in the sheet.

## Deploy

A local SQLite authority needs a **long-lived process and a writable,
persistent filesystem**.

> **Authentication is required for any real deployment.** The template ships a
> deny-closed HTTP Basic Auth middleware: unless **both** `AUTH_USERNAME` and
> `AUTH_PASSWORD` are set, every request is rejected (503 in production). Set
> both to long random values and always serve over HTTPS. Never put the real
> values in a client bundle, a log line, or a Sheet.

- **Docker Compose** builds the standalone Next.js server and mounts a
  persistent volume at `/data`. The Compose file refuses to start without
  `AUTH_USERNAME` and `AUTH_PASSWORD`:

  ```sh
  AUTH_USERNAME=<long-random-value> AUTH_PASSWORD=<long-random-value> docker compose up --build
  ```

  Put a TLS-terminating reverse proxy (Caddy, Traefik, nginx, a platform edge)
  in front of port 3000 — never expose the app without HTTPS. To enable the
  Sheet projection, mount the service-account key file **read-only** into the
  container and point `GOOGLE_APPLICATION_CREDENTIALS` at the mounted path
  (the Compose file ships these commented out):

  ```yaml
  environment:
    HIKOUTEI_SYNC_SPREADSHEET_URL: https://docs.google.com/spreadsheets/d/<id>/edit
    GOOGLE_APPLICATION_CREDENTIALS: /run/secrets/service-account.json
  volumes:
    - ./service-account.json:/run/secrets/service-account.json:ro
  ```

- **Railway** uses the provided `railway.json`, which is **SQLite-only by
  default**: a `/data` volume for the authority file, `AUTH_USERNAME` and
  `AUTH_PASSWORD` as Railway variables (strong values), and Railway's HTTPS
  domain enabled. The Google Sheets projection is manual and opt-in: provide
  the service-account key as a **real file** through a platform-specific
  secure file provision (for example a volume mount containing the key), then
  set `GOOGLE_APPLICATION_CREDENTIALS` to the path of that file inside the
  container and `HIKOUTEI_SYNC_SPREADSHEET_URL` to your spreadsheet. Never
  paste the JSON content into the `GOOGLE_APPLICATION_CREDENTIALS` variable
  itself — it must point at a file. Without a secure file provision, leave
  both sync variables unset and run SQLite-only.

In local development (`npm run dev`), the app runs without credentials only
when you explicitly copied `.env.example` to `.env.local` and set
`HIKOUTEI_ALLOW_INSECURE_LOCALHOST=true`; without that opt-in, or for any
non-loopback host, development also fails closed with 503 until you set both
credentials.

## Not supported by this template

- **Serverless / read-only filesystems:** SQLite needs a writable local volume.
- **Multi-replica:** a local SQLite file is not a shared coordination layer;
  run a single writable instance.
- **Immediate read-after-write in Google Sheets:** the projection is
  asynchronous by design.

Related: [Google Sheets as an ops UI](/guide/google-sheets-as-ops-ui).
