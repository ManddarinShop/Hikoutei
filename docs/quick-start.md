# Hikoutei Quick Start

The project is called Hikoutei and is currently published on npm as
`hikoutei`.

## Installation

```sh
npm install hikoutei @mikro-orm/core @mikro-orm/sql
```

The root API does not expose MikroORM types. The current built-in SQLite
provider uses those optional peer dependencies internally; a future provider
can replace it without changing the entity lifecycle API.

## Define a scalar entity

Entity metadata and environment-specific Sheet routes are separate:

```ts
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
    active: { type: "boolean" },
  },
});

const hikoutei = await createTypedSheets({
  dbName: "./hikoutei.sqlite",
  entities: [User],
  sheets: {
    spreadsheetId: process.env.GOOGLE_SHEET_ID!,
    routes: {
      User: {
        systemState: { tabName: "Users_System", registeredRange: "A:Z" },
      },
    },
  },
});
```

`createTypedSheets()` validates the descriptors and routes, opens the local
SQLite authority, registers canonical/outbox state, and prepares the current
persistence provider. It does not call Google Sheets or mutate a remote tab.

## Entity lifecycle

Use a request-local manager. Reads come from SQLite, never from the remote Sheet.
The Unit of Work owns identity maps and snapshots, so mutation followed by
`flush()` has the same meaning regardless of the persistence provider.

```ts
const em = hikoutei.em.fork();

const user = em.create(User, {
  id: "u1",
  name: "Ada",
  active: true,
});
em.persist(user);
await em.flush();

const loaded = await em.findOne(User, { id: "u1" });
if (loaded !== null) {
  loaded.name = "Ada Lovelace";
  await em.flush();

  await em.transactional(async (transactionalEm) => {
    transactionalEm.remove(loaded);
  });
}
```

The stable lifecycle methods are `fork()`, `create()`, `find()`, `persist()`,
`remove()`, `flush()`, and `transactional()`. Relations and provider-specific
query operators are not part of the scalar release.

## Sheet setup and delivery

`createTypedSheets()` opens the local SQLite authority and validates the
registered routes, but it does not contact Google Sheets. Provisioning is an
explicit service/deployment operation, and the included
[`apps-script/gateway/Code.gs`](../apps-script/gateway/Code.gs) must be deployed
before the server can deliver Sheet effects.

### Deploy the Apps Script gateway

Complete these steps once for the spreadsheet that the service will use:

1. Create or open the target Google Spreadsheet. From **Extensions → Apps
   Script**, create a **bound** Apps Script project for that spreadsheet.
2. Copy the complete `apps-script/gateway/Code.gs` file from this repository or
   from `node_modules/hikoutei/apps-script/gateway/Code.gs` into the Apps Script
   editor, then save it.
3. Choose **Deploy → New deployment**, select **Web app**, and deploy it with
   **Execute as: Me**. Choose the narrowest access audience that can reach the
   server. A server outside the Workspace normally requires **Anyone**; the
   signed request secret still authenticates every useful POST.
4. Copy the deployed URL ending in `/exec`. Do not use the editor-only `/dev`
   URL. Paste the URL into the constant near the top of `Code.gs` and save:

   ```js
   var TYPED_SHEETS_GATEWAY_URL =
     "https://script.google.com/macros/s/DEPLOYMENT_ID/exec";
   ```

5. In the **bound** Apps Script editor, select `setupSyncGateway` in the
   function menu and click **Run**. Approve the requested Google permissions.
   The helper reads the active spreadsheet ID, stores the ID and shared secret
   in Script Properties, and logs a copyable local environment block. Running
   it from a standalone Apps Script project cannot identify the spreadsheet.
6. Open the execution log and copy the printed values into an untracked server
   environment file or secret store:

   ```dotenv
   TYPED_SHEETS_GATEWAY_URL="https://script.google.com/macros/s/DEPLOYMENT_ID/exec"
   TYPED_SHEETS_GATEWAY_SHARED_SECRET="generated-secret"
   TYPED_SHEETS_GATEWAY_SHEET_ID="spreadsheet-id"
   ```

   The sheet ID is derived from the bound spreadsheet; it is not a second
   spreadsheet to configure. Never put the shared secret in browser code or
   commit it to Git.
7. If `Code.gs` changes, use **Deploy → Manage deployments**, edit the Web App
   deployment, and create a new version before relying on the changed gateway.
   The `/exec` URL stays the same when an existing deployment is updated.

### Provision and deliver Sheets

Provide a server-side, provider-neutral `HikouteiSheetProvisioner` using the
server credentials, then explicitly provision the registered tabs and headers:

```ts
await hikoutei.setupSheets(provisioner);
```

The operation is idempotent and rejects schema drift instead of silently
rewriting headers. After setup, run the sync worker that delivers pending
outbox effects. A successful `flush()` commits the entity table, canonical sync
state, and durable Sheet effect outbox in one SQLite transaction; it does not
mean that the remote Sheet has already been updated.

If `setupSyncGateway()` reports that it must run from a bound project, reopen
Apps Script from the spreadsheet's **Extensions → Apps Script** menu. If the
server receives `gateway_not_configured`, run the setup helper again and make
sure the three environment variables are available to the service.
