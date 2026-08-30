/**
 * P8-D2 phase 2 compatibility re-export.
 *
 * The implementation moved to `@hikoutei/sync-engine` (packages/hikoutei-sync-engine/src/api/queryNormalization.ts).
 * This root module keeps the historical `src/api/queryNormalization.js` path alive for the
 * staying public entry modules (and deep-import tests) while preserving a
 * single runtime type identity through the re-export.
 */
export * from "@hikoutei/sync-engine/api/queryNormalization.js";
