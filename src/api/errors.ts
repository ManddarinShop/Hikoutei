/**
 * P8-D2 phase 2 compatibility re-export.
 *
 * The implementation lives in `@hikoutei/contracts` (P8-D2 cycle break: the
 * descriptor/error pair is contracts-pure and consumed from below the engine);
 * the `@hikoutei/sync-engine` path re-exports it unchanged.
 * This root module keeps the historical `src/api/errors.js` path alive for the
 * staying public entry modules (and deep-import tests) while preserving a
 * single runtime type identity through the re-export.
 */
export * from "@hikoutei/sync-engine/api/errors.js";
