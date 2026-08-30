/**
 * Composition-root entry module (P8-C).
 *
 * This is the composition carrier: the public API layer (`src/api/Hikoutei.ts`)
 * imports it statically, and it registers the engine ports as a LAZY promise.
 * The heavyweight concrete adapters (MikroORM, the Google Sheets API client)
 * load only when `src/composition/syncEngine.ts` is first dynamically
 * imported — i.e. when a runtime is actually opened — preserving the
 * root-package lazy-loading guarantee.
 *
 * Direction: composition imports the engine (`application/...`) and the
 * concrete adapters; nothing in `application` imports `composition`.
 */

import { registerSyncEnginePorts } from "../application/sync/service/compositionPorts.js";

// NOTE: registers only a lazy LOADER THUNK. The `import()` below is inside
// the arrow function, so merely importing this module (and transitively the
// public API layer) does NOT start loading the sync-engine graph; the
// dynamic import fires on the first `requireSyncEnginePorts()` call — i.e.
// at engine bootstrap, when a runtime is actually opened.
registerSyncEnginePorts(() =>
  import("./syncEngine.js").then((module) => module.syncEngineCompositionPorts()),
);
