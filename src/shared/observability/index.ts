/**
 * Internal observability barrel.
 *
 * These modules are implementation-only diagnostics support and are never
 * re-exported from `src/index.ts`: the public API surface stays unchanged.
 */

export * from "./internalLog.js";
export * from "./logEvents.js";
