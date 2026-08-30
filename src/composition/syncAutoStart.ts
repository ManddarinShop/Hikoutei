/**
 * Composition bridge for the env-driven sync auto-start factory (P8-C).
 *
 * The public API entrypoints (`src/api/Hikoutei.ts`, `src/api/syncRuntime.ts`)
 * route their dynamic engine import through this composition module instead
 * of the engine module directly, so every public factory entry crosses the
 * composition boundary exactly once. The factory implementation itself stays
 * in the engine (`application/sync/service/syncAutoStart.ts`); its concrete
 * wiring is resolved through the registered composition ports (see
 * `src/composition/index.ts`), loaded via the API carrier.
 */

export {
  createTypedSheetsWithSync,
} from "../application/sync/service/syncAutoStart.js";