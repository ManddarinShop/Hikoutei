/**
 * Composition root for the internal sync engine's concrete adapters (P8-C).
 *
 * This module is the ONLY place where the engine wiring names concrete
 * adapter classes: the MikroORM SQLite runtime (scalar schema generation,
 * storage opening + schema migration + mapping registration, the flush
 * coordinator binding, and the scalar persistence provider), the MikroORM
 * polling engine, the full-direct Google Sheets API remote provider, and the
 * ADC-backed HTTP transport used by existing-sheet adoption reads. Every
 * block is extracted verbatim from the former in-engine wiring sites
 * (`SyncServiceBootstrap`, `remoteProvider`, `pollingSupervisor`,
 * `existingSheetAdoption`, `createLocalTypedSheetsRuntime`), so runtime
 * behavior is byte-identical — only the construction site moved.
 *
 * Direction: `composition` imports the engine (application/sync,
 * application/orm) and the concrete adapters. NOTHING in application imports
 * composition; the public API layer (`src/api/Hikoutei.ts`) loads this
 * composition root through `src/composition/index.ts`, which registers the
 * engine ports lazily so importing the root package alone still never loads
 * MikroORM or the Google SDK module graph.
 */

import {
  initializeMappedRuntime,
  type InitializeMappedRuntimeOptions,
} from "@hikoutei/storage/persistence/providers/mikro-orm/engine/MikroOrmMappedRuntime.js";
import {
  createMikroOrmScalarRuntime,
  type MikroOrmScalarRuntimeDefinition,
} from "@hikoutei/storage/persistence/providers/mikro-orm/engine/MikroOrmScalarRuntime.js";
import { MikroOrmScalarPersistenceProvider } from "@hikoutei/storage/persistence/providers/mikro-orm/api/MikroOrmScalarPersistenceProvider.js";
import {
  MAPPED_USER_INPUT_POLL_MODES,
  pollMappedUserInputWithMikroOrm,
} from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import {
  GoogleSheetsApiHttpTransport,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/transport/googleSheetsApiTransport.js";
import {
  GoogleSheetsApiSyncProvider,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import {
  requireValidBatchUpdateReply,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/operations/shared.js";
import type {
  SyncDirectRemoteProvider,
  SyncEngineCompositionPorts,
  SyncMappedRuntimeSeeds,
} from "../application/sync/service/compositionPorts.js";
import type {
  GoogleSheetsApiAdoptionReader,
} from "../application/sync/service/adopt/existingSheetAdoption.js";
import type {
  InternalSyncProjectionConfig,
} from "@hikoutei/contracts/sheets/syncServiceConfig.js";
import type { HikouteiEntity } from "../api/entity.js";
import type { GoogleSheetsApiProviderOptions } from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import { GOOGLE_SHEETS_API_DEFAULTS } from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import type { MikroOrmSqliteAdapter } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";

/** Builds the concrete MikroORM runtime seeds and its open/bind closures. */
function planMappedRuntime(
  entities: readonly HikouteiEntity[],
  projections: InternalSyncProjectionConfig,
): SyncMappedRuntimeSeeds {
  const generated: MikroOrmScalarRuntimeDefinition = createMikroOrmScalarRuntime(
    entities,
    projections,
  );
  return {
    mappings: generated.mappings,
    async openMappedRuntime(input) {
      const initializeOptions: InitializeMappedRuntimeOptions = {
        dbName: input.dbName,
        entities: generated.entities,
        mappings: generated.mappings,
        writer: input.writer,
        ...(input.syncFlushHook === undefined ? {} : { syncFlushHook: input.syncFlushHook }),
      };
      const runtime = await initializeMappedRuntime(initializeOptions);
      return {
        storage: runtime.storage,
        mappings: runtime.mappings,
        registrations: runtime.registrations,
        flushCoordinator: runtime.flushCoordinator,
        createScalarPersistenceProvider: () =>
          new MikroOrmScalarPersistenceProvider(
            runtime.storage,
            generated.bindings,
            runtime.flushCoordinator,
          ),
      };
    },
  };
}

/** Implements the engine ports with the concrete adapter wiring. */
function createSyncEnginePorts(): SyncEngineCompositionPorts {
  return {
    planMappedRuntime,
    createDirectRemoteProvider(input): SyncDirectRemoteProvider {
      const provider = new GoogleSheetsApiSyncProvider({
        ...input.providerOptions,
        spreadsheetId: input.spreadsheetId,
        definitions: input.definitions,
      });
      return { provider };
    },
    async pollMappedUserInput(input) {
      return pollMappedUserInputWithMikroOrm({
        storage: input.storage as MikroOrmSqliteAdapter,
        provider: input.provider,
        mappings: input.mappings,
        writer: input.writer,
        mode: MAPPED_USER_INPUT_POLL_MODES.ADAPTIVE,
        forceFull: input.forceFull,
        safetyScanLagMs: input.safetyScanLagMs,
        ...(input.physicalSheetIds === undefined ? {} : { physicalSheetIds: input.physicalSheetIds }),
        ...(input.onTiming === undefined ? {} : { onTiming: input.onTiming }),
      });
    },
    createAdoptionReaderTransport(
      providerOptions: GoogleSheetsApiProviderOptions | undefined,
    ): GoogleSheetsApiAdoptionReader {
      return new GoogleSheetsApiHttpTransport({
        requestTimeoutMs:
          providerOptions?.requestTimeoutMs ?? GOOGLE_SHEETS_API_DEFAULTS.REQUEST_TIMEOUT_MS,
      });
    },
    verifyBatchUpdateReply: requireValidBatchUpdateReply,
  };
}

/**
 * Resolves the lazy concrete composition for the engine ports registry.
 * Constructing the ports is synchronous; the adapter module graphs load the
 * first time `src/composition/index.ts` dynamically imports this module.
 */
export function syncEngineCompositionPorts(): Promise<SyncEngineCompositionPorts> {
  return Promise.resolve(createSyncEnginePorts());
}