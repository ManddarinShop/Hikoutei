/** Normalizes mapped entity inputs into the registry used by persistence flows. */

import {
  createTypedSheetsEntityMappingRegistry,
  type TypedSheetsEntityMapping,
  type TypedSheetsEntityMappingRegistry,
} from "../../mapping/entityMapping.js";

/** Accepts an existing registry or builds one from mapping definitions. */
export function resolveTypedSheetsEntityMappingRegistry(
  input: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[],
): TypedSheetsEntityMappingRegistry {
  if ("findByEntityName" in input) return input;
  return createTypedSheetsEntityMappingRegistry(input);
}
