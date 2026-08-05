/**
 * Public surface for the Hikoutei typed repository.
 *
 * The root entrypoint exports only the stable entity-lifecycle API:
 * `defineTypedSheetsEntity`, `createTypedSheets`, the `Hikoutei` runtime, the
 * `EntityManager`, and the typed errors. Internal storage, provider, ORM,
 * provider, and sync-protocol types are implementation modules only and are not
 * package exports or part of this contract.
 *
 * The SQLite-authoritative sync bootstrap is explicitly service-side: it uses a
 * secret-bearing service-account Google Sheets API client and must never be
 * bundled into a browser.
 */

export * from "./api/index.js";
