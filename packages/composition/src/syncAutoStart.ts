/**
 * Composition bridge for the env-driven sync auto-start factory (P8-C).
 *
 * The public API entrypoints (`src/api/Hikoutei.ts`, `src/api/syncRuntime.ts`)
 * route their dynamic engine import through this composition module instead
 * of the engine module directly, so every public factory entry crosses the
 * composition boundary exactly once. The factory implementation itself stays
 * in the engine (`sync/service/syncAutoStart.ts` in `@hikoutei/sync-engine`);
 * its concrete wiring is resolved through the registered composition ports
 * (see `./index.ts`), which this module loads as a side effect so every
 * entry through the composition boundary — including tests that dynamic-
 * import this module directly — has both port slots registered before the
 * factory runs.
 */

import "./index.js";

export * from "@hikoutei/sync-engine/sync/service/syncAutoStart.js";