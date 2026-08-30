/**
 * P8-C re-export shim: the internal sync service configuration contract
 * moved verbatim to the contracts leaf package leaf (schema-engine consumers
 * read it there). Existing engine and test import paths keep resolving
 * through this barrel.
 */

export * from "@hikoutei/contracts/sheets/syncServiceConfig.js";
