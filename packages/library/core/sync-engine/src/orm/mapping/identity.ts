/**
 * P8-C re-export shim: the module moved verbatim to the contracts leaf package
 * leaf (dependency-leaf semantics). Existing import paths in application,
 * test, and public-declaration code keep resolving through this barrel.
 */

export * from "@hikoutei/contracts/sync-orm/mapping/identity.js";
