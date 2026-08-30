/**
 * P8-D2 phase 2 compatibility re-export.
 *
 * The engine-neutral public error contract is a pure leaf and lives in
 * `@hikoutei/contracts/api/errors.ts` (P8-D2 cycle break: the storage
 * persistence adapter consumes it, so it must sit BELOW storage). This shim
 * keeps the historical `@hikoutei/sync-engine/api/errors.js` specifier alive
 * for the root api surface, cli, and composition while preserving a single
 * runtime class identity for `instanceof HikouteiError`.
 */
export * from "@hikoutei/contracts/api/errors.js";
