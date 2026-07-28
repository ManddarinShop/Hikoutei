/**
 * Public mapping entrypoint.
 *
 * Implementation is split by responsibility; this barrel preserves the
 * existing import path for callers while keeping the individual modules small.
 */

export * from "./contracts.js";
export * from "./definition.js";
export * from "./identity.js";
export * from "./projection.js";
export * from "./registry.js";
export * from "./values.js";
