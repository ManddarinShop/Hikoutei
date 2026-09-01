# Demo VM deployment (Oracle Always Free, docker compose, no domain needed)

Target topology — one VM, one entry point, bare-host URL shows the live demo:

```
browser ── http://<vm-ip>/  ──> Caddy (docker :80)
                                 ├─ /            -> 302 -> /demo   (live demo)
                                 ├─ /api/*       -> demo-server container :3101
                                 └─ /*           -> /srv/docs (VitePress build, DOCS_BASE_PATH=/)
```

Deployed by `.github/workflows/demo-deploy.yml` (manual dispatch + push paths).

## 0. Prerequisites (one-time)

- Oracle Always Free VM (Ubuntu 22.04+), Docker + docker compose plugin installed
- Ports **80** open in BOTH:
  - OCI console: VCN > Security List > ingress `0.0.0.0/0` TCP 80
  - host: `sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT` (and persist via
    `netfilter-persistent save`) — Oracle images ship a default REJECT rule
- Repo cloned at `/opt/hikoutei`, deploy user in the `docker` group

## 1. Demo-only secrets (in GitHub Secrets, injected at deploy time)

| Secret | Content |
| --- | --- |
| `DEMO_SSH_HOST` / `DEMO_SSH_USER` / `DEMO_SSH_KEY` | VM access for the deploy workflow |
| `DEMO_SA_JSON` | **Dedicated** demo service-account key (full JSON). Never the dev/test account. |
| `DEMO_ENV` | env file body: `HIKOUTEI_SYNC_SPREADSHEET_URL=https://docs.google.com/spreadsheets/d/<demo-sheet-id>/edit`, `GOOGLE_APPLICATION_CREDENTIALS=/etc/hikoutei-demo/sa.json` |

The workflow writes `/etc/hikoutei-demo.env` + `/etc/hikoutei-demo/sa.json`
(chmod 600) on the VM at every deploy — GH Secrets are the single source of
truth. The demo sheet itself must be **a dedicated sheet** shared with the
demo service account (Editor).

## 2. What the workflow does

1. Builds VitePress docs on the runner (`DOCS_BASE_PATH=/`, demo page included)
2. Rsyncs static assets to `/srv/hikoutei-docs`
3. On the VM: `git pull` → injects secrets → `docker compose up -d --build`
4. Health gate: `/api/health` must report `"syncMode":"sync"` within 30s,
   otherwise the deploy fails loudly (and dumps container logs)

## 3. Verify

```sh
curl http://<vm-ip>/api/health            # {"ok":true,"syncMode":"sync",...}
curl -sI http://<vm-ip>/ | head -1        # 302 -> /demo
```

Browser: `http://<vm-ip>/` → live demo directly. Top-right badge should read
"Operational" (SSE connected); SHEET LAG counts up during bursts.

## Local dev (no Docker)

```sh
cd website/demo/server && npm install && npm start   # local-only or .env sync
cd website && npm run docs:dev                       # /Hikoutei/demo
```

## Operations notes

- SQLite (durable outbox) lives in the `demo-data` volume — survives restarts.
- Full reset: `docker compose down -v` + restart; the library re-provisions
  the demo tabs automatically.
- NEVER hand-edit the demo sheet's `*_System` tabs or the receipt tab
  (breaks the receipt/anchor contract → effects force-settle as failed).
  Human edits belong in the `DemoRequest_Input` tab only.
- GH Pages build excludes the demo page (`srcExclude`); the live demo exists
  only on this VM, where `/api` is served same-origin.

## Adding a domain later

1. Buy domain, add A record → VM public IP (or CNAME if using DuckDNS first).
2. Change `:80` to `your.domain.com` in the Caddyfile and reload — Caddy
   obtains the Let's Encrypt certificate automatically. No code changes.