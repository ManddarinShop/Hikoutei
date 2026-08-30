/**
 * Composition-root entry module (P8-C).
 *
 * This is the composition carrier: the public API layer (`src/api/Hikoutei.ts`)
 * imports it statically, and it registers the engine ports as a LAZY promise.
 * The heavyweight concrete adapters (MikroORM, the Google Sheets API client)
 * load only when `packages/hikoutei-composition/src/syncEngine.ts` is first dynamically
 * imported — i.e. when a runtime is actually opened — preserving the
 * root-package lazy-loading guarantee.
 *
 * Direction: composition imports the engine (`application/...`) and the
 * concrete adapters; nothing in `application` imports `composition`.
 */

import {
  registerSyncEnginePorts,
  registerSyncEngineLocalRuntime,
} from "@hikoutei/sync-engine/sync/service/compositionPorts.js";

// NOTE: registers only a lazy LOADER THUNK. The `import()` below is inside
// the arrow function, so merely importing this module (and transitively the
// public API layer) does NOT start loading the sync-engine graph; the
// dynamic import fires on the first `requireSyncEnginePorts()` call — i.e.
// at engine bootstrap, when a runtime is actually opened.
registerSyncEnginePorts(() =>
  import("./syncEngine.js").then((module) => module.syncEngineCompositionPorts()),
);

// P8-D2: the local-runtime seam resolves through its own LIGHT thunk: the
// sync auto-start bridge's env-absent branch opens a plain local runtime
// through `./localRuntime.js` (MikroORM graph only) and must never trigger
// the heavy `./syncEngine.js` graph (Google SDK) above.
registerSyncEngineLocalRuntime(() =>
  import("./localRuntime.js").then((module) => module.createLocalTypedSheetsRuntime),
);
