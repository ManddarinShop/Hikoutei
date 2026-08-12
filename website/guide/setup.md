---
title: Google Sheets setup
description: Env-driven sync auto-start and the service-account environment setup — three steps to connect Hikoutei to a spreadsheet.
---

# Google Sheets setup

Google Sheets synchronization is a service-side concern. Applications do not
import a provider client, pass Sheet routes to `createTypedSheets()`, or choose
an operation for each write.

## Automatic setup with `hikoutei setup` (recommended)

The `hikoutei setup` CLI automates the Google Cloud bootstrap: it creates (or
reuses) a Cloud project, enables the Sheets and Drive APIs, creates a
service account and key, creates a spreadsheet **owned by your human
account**, shares it with the service account as a writer, verifies
service-account access, and writes a ready-to-use `.env` — no console
clicking.

**Prerequisites:** the `gcloud` CLI is installed and you have logged in once
with Drive access (the spreadsheet is created as your user, so the Drive
scope is required):

```sh
gcloud auth login --enable-gdrive-access
```

If the active account lacks Drive access, setup stops before creating
anything and prints the exact command to re-login
(`gcloud auth login --enable-gdrive-access --force`).

Then run the setup from your project directory:

```sh
npx hikoutei setup
```

What happens:

1. **Preflight** — verifies `gcloud` is installed and an active account is
   logged in.
2. **Human auth** — retrieves the user access token and verifies through
   tokeninfo that it grants Drive access. The token is used in memory only;
   it is never written to disk, the checkpoint, or `.env`.
3. **Project** — creates `hikoutei-<slug>` (idempotent: reused when it already
   exists), or use an existing project with `--project <id>`. The decided
   project is persisted to a local checkpoint before creation.
4. **APIs** — enables `sheets.googleapis.com` and `drive.googleapis.com`.
5. **Service account** — creates `hikoutei-sa` (reused when it already exists)
   and a key file secured with `chmod 600` (a reused key is enforced to
   owner-only mode 600 through one secure descriptor). The key is created
   under a write-ahead contract: the user-managed key list of the service
   account is recorded as a baseline and a `key_create_started` checkpoint
   (UUID marker + baseline) is persisted **before** the single gcloud key
   create. gcloud writes the key into a deterministic private staging
   directory (`.hikoutei-key-stage-<marker>`, owner-only 0700), where it is
   validated and then installed at the final key path with an atomic hard
   link — the final path is never the gcloud destination (a dry run shows
   `<private-key-staging-dir>/key.json`). A crash at any boundary resumes
   by reconciling the staged and/or installed key against the current key
   list, and setup never creates a second key. Only the invocation that
   just persisted the `key_create_started` checkpoint may issue the one
   key create; resumed runs are reconcile-only and, when no credential and
   no post-baseline key are visible, poll the key list plus staged/final
   evidence for up to two minutes (2, 4, 8, 16, 30, 30, 30 s) before
   failing with `key_create_uncertain` — the create is never retried
   automatically. An unmatched user-managed key with no local credential
   is **never deleted automatically**: setup fails with
   `key_create_uncertain` and you inspect the key list in the Google Cloud
   console before rerunning; if you have verified no key exists, remove
   the setup state file to reset the key checkpoint and rerun.
6. **Spreadsheet** — generates a local opaque creation marker (a UUID) and
   persists it to the checkpoint as `spreadsheet_create_started` **before**
   the single create attempt, then creates a spreadsheet titled
   `hikoutei-sync-<project>` as the logged-in user (service accounts cannot
   own Drive assets). The same create request carries the marker as a
   private Drive `appProperties` entry, so a crash between the remote
   create and the next checkpoint write is reconciled on resume by querying
   Drive for that exact marker. If the create outcome cannot be confirmed,
   setup stops with `sheet_create_uncertain` and **never creates a second
   spreadsheet** — inspect Drive for the titled spreadsheet and rerun; the
   next run reconciles by marker.
7. **Share** — persists a `spreadsheet_share_started` write-ahead (the
   spreadsheet id and `keyOrigin`; no `shareOrigin` — the outcome is not
   known yet) **before** the idempotent Drive permission ensure can create,
   upgrade, or reuse the service account's writer role, then grants writer
   access through the Drive API (reusing an existing writer/owner role,
   upgrading a lower role, or creating the permission without a
   notification email) and verifies that your account owns the spreadsheet
   and the service account can write. `spreadsheet_shared` is persisted
   only after the ensure completes, so a crash between the remote
   permission mutation and that write resumes the idempotent ensure on the
   next run — never a second spreadsheet.
8. **Verify** — reads the spreadsheet with the service-account key,
   retrying up to eight times (2, 4, 8, 16, 30, 30, 30 s) only for
   propagation of resources created in this run, plus quota and server
   errors. The propagation evidence survives resumes: whether the key was
   created and whether the SA writer permission was freshly granted are
   persisted as non-secret provenance discriminants (`keyOrigin`,
   `shareOrigin`), so a resumed shared-but-unverified state keeps the
   Invalid JWT Signature and 403/404 retries without re-running the share
   step.
9. **Output** — writes `GOOGLE_APPLICATION_CREDENTIALS` and
   `HIKOUTEI_SYNC_SPREADSHEET_URL` into `.env`, preserving any unrelated
   lines already in the file.

The command asks for a y/N confirmation before creating cloud resources; pass
`--yes` for non-interactive runs. Preview the exact command sequence with
`--dry-run`: it runs only read-only local path-safety checks (reserved-path
collision resolution) and performs no subprocess, network, cloud, or file
mutations — no lock, checkpoint, key, or `.env` writes. Key material and the
access token are never printed.

Automatic setup runs on macOS and Linux. On Windows, a non-dry-run is
refused with `unsupported_platform` **before** any subprocess, network,
cloud, lock, checkpoint, key, or env mutation (Windows cannot guarantee
no-follow opens or owner-only ACL semantics); dry runs remain pure on every
platform, and manual setup (below) is always available.

### Interrupted runs and the checkpoint

Setup persists progress to `.hikoutei-setup-state.json` (mode 600) in the
current directory: the project id before project creation, the key
write-ahead (`key_create_started` before the key create, `key_ready` right
after the key is secured), the creation
marker (`spreadsheet_create_started`) before the spreadsheet exists, the
spreadsheet id right after creation, a share write-ahead
(`spreadsheet_share_started` before the SA writer permission is ensured,
`spreadsheet_shared` after it), then verification, and completion. The
spreadsheet URL is never stored — it is derived from the
id. Rerunning setup resumes from the same project and spreadsheet and skips
completed work, so an interrupted run never creates a second spreadsheet.
A create rejected up front with HTTP 400/403 whose marker lookup confirms
no file exists rolls the checkpoint back to `key_ready` and fails with
`sheet_create_failed`, so a corrected rerun starts a fresh marker. The key
recovery works the same way: a crashed key create resumes by reconciling
the deterministic staged and/or installed key against the current
user-managed key list — resumed key states are reconcile-only and never
create (a lagging key list must never permit a duplicate), and when no
credential and no post-baseline key are visible the run polls the key
list plus staged/final evidence for up to two minutes before failing with
`key_create_uncertain`. `key_ready` and later checkpoints record whether
the key was created by the setup and whether the SA writer permission was
freshly granted (`keyOrigin`/`shareOrigin`), so the access verification
keeps its propagation retries across resumes. A resume from
`spreadsheet_share_started` reruns the idempotent permission ensure and
conservatively records `shareOrigin: fresh` (the prior attempt may have
created or upgraded the permission before crashing), which only adds
bounded 403/404 retries and is safe.
An exclusive lock — an empty directory at
`.hikoutei-setup-state.json.lock` — prevents concurrent runs and is never
removed automatically: an existing lock, even one left by a crashed run,
fails with `setup_in_progress` before anything is created, and a leftover
lock directory requires manual removal only when you are certain no setup
is running. The checkpoint records only identities
and paths — never tokens or key material. A checkpoint bound to a different
account, project, or key path fails with `setup_state_conflict`; a key file
without a checkpoint and without `--project` also fails before anything is
created. To provision fresh resources, remove or move **both** the
checkpoint and the key file — or keep them and pass the matching
`--project <id>` to recover. Checkpointed or identity-matched cloud
resources are reused; setup never deletes cloud resources.

Options:

```text
--project <id>              Use an existing Google Cloud project.
--sa-name <name>            Service-account name (default: hikoutei-sa).
--spreadsheet-title <title> Spreadsheet title (default: hikoutei-sync-<project>).
--output <path>             .env file to write or update (default: .env).
--yes                       Skip interactive confirmation.
--dry-run                   Print the command plan without executing or
                            mutating anything (read-only path-safety checks
                            only; no subprocess, network, cloud, or file
                            writes; the key create shows the staging
                            placeholder <private-key-staging-dir>/key.json).
```

When the setup finishes, the sync runtime picks the spreadsheet up from the
environment automatically (see below).

### Keep setup artifacts out of Git

`hikoutei setup` writes its defaults into the current directory:

- `hikoutei-service-account.json` — the service-account key (owner-only
  mode 600). This is a **secret**: never commit it.
- `.hikoutei-setup-state.json` — the resume checkpoint (mode 600), plus
  its `.tmp`/unique-temp and `.lock` siblings.
- `.hikoutei-key-stage-<marker>/` and `.hikoutei-key-cleanup-<marker>/` —
  private key staging/cleanup directories (owner-only 0700).
- `.hikoutei-env-*` — temporary `.env` write files.

The repository's `.gitignore` already ignores these defaults, so a plain
`git add .` does not pick them up. Two caveats:

- A `.gitignore` is **not a security boundary**: it only keeps untracked
  files out of `git add`, and it does not protect files that are already
  tracked. If a key was ever committed, rotate it — delete the
  user-managed key in the Cloud console and rerun setup.
- When you run setup with a custom `--output <path>` or keep the key or
  checkpoint at custom paths, add those exact paths to your application's
  ignore rules and never commit them.

## Env-driven sync auto-start

Set the spreadsheet URL and the service-account key path in the server
environment; `createTypedSheets()` detects them and starts the Sheets sync
internally — `flush()` then flows to Google Sheets through the outbox worker
with no per-call setup:

```sh
HIKOUTEI_SYNC_SPREADSHEET_URL=https://docs.google.com/spreadsheets/d/<ID>/edit
GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/service-account.json
```

```ts
const hikoutei = await createTypedSheets({ dbName: "./hikoutei.sqlite", entities: [User] });
```

Without `HIKOUTEI_SYNC_SPREADSHEET_URL`, `createTypedSheets()` stays
local-only (SQLite). Startup failures are diagnosed with clear messages:
invalid URL, missing/invalid credentials file, or a service account not
shared on the spreadsheet (the error tells you which email to share).

## Manual / advanced setup

Skip the CLI and wire everything by hand when you need an existing project or
spreadsheet, or when you prefer to manage Google Cloud resources yourself.

### Service-account provider (googleSheetsApi)

The sync runtime uses one Google Sheets API provider with a service account —
no Apps Script deployment. The provider, sync worker, and storage are
internal: applications configure nothing beyond the two environment variables
above and call `createTypedSheets()` normally.

1. **Create a service account.** Enable the Google Sheets API in a Cloud
   project, create a service account with the
   `https://www.googleapis.com/auth/spreadsheets` scope, and share the target
   spreadsheet with its email as an **Editor**. The sync provider creates
   tabs, writes effect rows and receipt records, and manages row anchors, so
   Viewer access is not enough.
2. **Keep the key server-side.** Put the service-account key path in
   `GOOGLE_APPLICATION_CREDENTIALS` and the spreadsheet URL in
   `HIKOUTEI_SYNC_SPREADSHEET_URL` in an untracked server secret store. Never
   put the key in browser code or Git.
3. **Run the application normally.** Start the app with those variables set;
   `createTypedSheets()` verifies the spreadsheet with the service account,
   creates and validates the headers on the registered tabs, then starts
   outbox delivery and User_Input polling. There is no provider option to
   pass and no internal bootstrap to start.

Hikoutei uses a durable local outbox, idempotent delivery, and conflict-aware
updates so temporary API failures do not lose committed application writes.
The provider never logs credentials, spreadsheet IDs, URLs, or payloads, and
it spaces request starts to stay inside Google's quota windows.

Live Google calls are opt-in; fake providers and SQLite fixtures are the
normal verification path. Detailed setup and troubleshooting steps live in the
repository's `docs/quick-start.md`.
