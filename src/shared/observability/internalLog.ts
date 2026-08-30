/**
 * P8-D2 phase 2 compatibility re-export.
 *
 * The implementation moved to `@hikoutei/sync-engine`
 * (packages/hikoutei-sync-engine/src/shared/observability/internalLog.ts). This root
 * module keeps the historical `src/shared/observability/internalLog.js` path alive
 * for staying root consumers while preserving a single runtime identity.
 */
export * from "@hikoutei/sync-engine/shared/observability/internalLog.js";
