/**
 * Legacy import bridge for the scalar provider contract.
 *
 * The actual SPI belongs to the persistence adapter boundary. This path remains
 * available to current internal tests while the root public API stays closed.
 */
export * from "../../../../adapter/persistence/contracts/scalar.js";
