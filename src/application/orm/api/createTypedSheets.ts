/** Public runtime factory with a lazy current-provider selection. */

import type { TypedSheetsOrm } from "./TypedSheetsOrm.js";
import type { CreateTypedSheetsOptions } from "./factoryContracts.js";

/**
 * Opens the current SQLite-backed typed-sheets runtime.
 *
 * The provider is loaded only when this factory is called. Importing the root
 * package therefore does not force an application to load a provider-specific
 * ORM before it chooses to use the built-in runtime.
 */
export async function createTypedSheets(
  options: CreateTypedSheetsOptions,
): Promise<TypedSheetsOrm> {
  const provider = await import(
    "../../../adapter/persistence/providers/mikro-orm/engine/TypedSheetsFactory.js"
  );
  return provider.createTypedSheets(options);
}
