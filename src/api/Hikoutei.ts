/**
 * Public SQLite-authoritative Hikoutei runtime and the `createTypedSheets()` factory.
 *
 * This module intentionally knows nothing about Sheet routes or provider
 * provisioning. When `HIKOUTEI_SYNC_SPREADSHEET_URL` is set, the factory
 * delegates to the internal sync auto-start bridge, which builds a mapped
 * runtime and provisions the bound spreadsheet separately; the application-
 * facing contract stays unchanged either way.
 *
 * P8-D2 phase 2: the runtime core (the `Hikoutei` contract, its close state
 * machine, and the option helpers) lives in `@hikoutei/sync-engine`, and the
 * local-runtime factory lives in `@hikoutei/composition`. This module keeps
 * only the public factory entry and re-exports the internal helpers for the
 * staying root modules and internal deep-import tests.
 */

import { HIKOUTEI_ERROR_CODES, HikouteiError } from "./errors.js";
import { getRegisteredEntityTokens } from "./entity.js";
import {
  resolveDefaultDbPath,
  validateTypedSheetsOptions,
  createInternalHikoutei,
  type CreateTypedSheetsOptions,
  type Hikoutei,
} from "@hikoutei/sync-engine/api/hikouteiCore.js";

// P8-C composition carrier: the public API layer loads the composition root,
// which registers (lazily) the concrete sync-engine port wiring. The heavy
// adapter module graphs (MikroORM, Google SDK) still load only when a runtime
// actually opens (every wiring module is dynamically imported by factories).
import "@hikoutei/composition/index.js";

export {
  createInternalHikoutei,
  resolveDefaultDbPath,
  validateTypedSheetsOptions,
  type CreateTypedSheetsOptions,
  type Hikoutei,
};

/**
 * Opens the local SQLite runtime for the declared scalar entities.
 *
 * When `dbName` is omitted the `HIKOUTEI_DB_PATH` environment variable or
 * `./hikoutei.sqlite` is used; when `entities` is omitted the tokens registered
 * by `defineTypedSheetsEntity()` are used, in registration order.
 *
 * When `HIKOUTEI_SYNC_SPREADSHEET_URL` is set, the internal sync auto-start
 * bridge provisions the spreadsheet, validates the service-account
 * credentials file, and starts the outbound worker and User_Input polling
 * before returning. Startup failures are classified into stable
 * `HikouteiError` codes and fail closed. Without that env var this call never
 * contacts Google Sheets, creates projection tables, or starts a worker, and
 * the local-only behavior is byte-identical to previous releases.
 */
export async function createTypedSheets(
  options: CreateTypedSheetsOptions = {},
): Promise<Hikoutei> {
  validateTypedSheetsOptions(options);

  const dbName = options.dbName ?? resolveDefaultDbPath();
  const entities = options.entities ?? getRegisteredEntityTokens();
  if (options.entities === undefined && entities.length === 0) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      "createTypedSheets() requires at least one entity; pass `entities` or call defineTypedSheetsEntity() before opening the runtime.",
    );
  }

  const spreadsheetUrl = process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
  if (spreadsheetUrl === undefined || spreadsheetUrl.trim() === "") {
    // Env absent: the exact local-only path. The sync module graph (MikroORM
    // and the Google SDK) is never imported here.
    const { createLocalTypedSheetsRuntime } = await import(
      "@hikoutei/composition/localRuntime.js"
    );
    return createLocalTypedSheetsRuntime({ dbName, entities });
  }

  // Env present: delegate to the internal sync auto-start bridge. The dynamic
  // import keeps the module graph out of the env-absent path.
  const { createTypedSheetsWithSync } = await import(
    "@hikoutei/composition/syncAutoStart.js"
  );
  const result = await createTypedSheetsWithSync({
    dbName,
    entities: [...entities],
    env: process.env,
  });
  // This factory never passes `adopt`, so the `adopt-dry-run` variant is
  // unreachable here; narrow for the type system only.
  if (result.kind === "adopt-dry-run") {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      "createTypedSheets() cannot produce an adoption dry-run result.",
    );
  }
  return result.hikoutei;
}
