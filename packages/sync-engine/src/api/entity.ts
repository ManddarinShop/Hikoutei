/**
 * P8-D2 phase 2 compatibility re-export.
 *
 * The entity-descriptor contract lives in `@hikoutei/contracts/api/entity.ts`
 * (P8-D2 cycle break: it is contracts-pure and consumed from below the
 * engine). This shim keeps the historical
 * `@hikoutei/sync-engine/api/entity.js` specifier alive for the root api
 * surface, cli, and composition with a single runtime identity.
 */
export * from "@hikoutei/contracts/api/entity.js";
