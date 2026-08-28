/**
 * Production wiring for `hikoutei adopt`.
 *
 * Owns the real-world dependencies the testable flow deliberately avoids:
 * loading the application's entity definitions from a module (`--entities`,
 * a dynamic import whose side effect registers the entities), resolving the
 * adopted entity's token, and building the runner around the PUBLIC
 * `createTypedSheetsWithSync()` factory. The runner closes the runtime after
 * a successful adopt so the CLI process can exit (adoption is a one-shot
 * migration, not a long-lived service host).
 */

import { pathToFileURL } from "node:url";

import { createTypedSheetsWithSync } from "../api/syncRuntime.js";
import type { HikouteiEntity } from "../api/entity.js";
import { getEntityDescriptor, getRegisteredEntityTokens } from "../api/entity.js";
import { HikouteiError } from "../api/errors.js";
import { parseAdoptArgs } from "./adoptArgs.js";
import {
  ADOPT_ERROR_PREFIX,
  runAdoptCli,
  type AdoptRunner,
  type AdoptRunnerInput,
} from "./adoptFlow.js";
import {
  SETUP_ARG_ERROR_EXIT_CODE,
  SETUP_RUNTIME_ERROR_EXIT_CODE,
} from "./errors.js";
import { createStdinFinalizer, isModuleMainEntry } from "./setup.js";

// The adopt-specific stable error code (api/errors.ts owns the real taxonomy;
// this alias keeps the machine-readable surface identical).
const HIKOUTEI_ERROR_CODES_ADOPT_ENTITY_UNKNOWN = "sync_startup_failed" as const;

/**
 * Loads the entities module and returns the token matching the requested
 * entity name. The import side effect must call `defineTypedSheetsEntity()`.
 */
async function loadAdoptEntity(entitiesModule: string, entityName: string): Promise<HikouteiEntity> {
  await import(pathToFileURL(entitiesModule).href);
  const token = getRegisteredEntityTokens().find(
    (candidate) => getEntityDescriptor(candidate).name === entityName,
  );
  if (token === undefined) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES_ADOPT_ENTITY_UNKNOWN,
      `entity "${entityName}" was not registered by module "${entitiesModule}" — the module must call defineTypedSheetsEntity() at import time (registered: ` +
        `${getRegisteredEntityTokens().map((candidate) => getEntityDescriptor(candidate).name).join(", ") || "none"}).`,
    );
  }
  return token;
}

/** The production runner: public factory + close-after-adopt lifecycle. */
const productionRunner: AdoptRunner = async (input: AdoptRunnerInput) => {
  const result = await createTypedSheetsWithSync({
    dbName: input.dbName,
    entities: [...input.entities],
    env: input.env,
    adopt: input.spec,
  });
  if (result.kind === "sync") {
    // Adoption is one-shot: close the runtime so the CLI exits cleanly. The
    // close drains the seeded state; the sync service resumes in the
    // application process, not in this CLI invocation.
    await result.hikoutei.close();
  }
  return result;
};

/**
 * Runs the `hikoutei adopt` CLI with the given argument vector (without the
 * leading "adopt" subcommand). Exported so the bin router can delegate and
 * tests can drive it with injected argv.
 */
export async function runAdoptMain(argv: readonly string[]): Promise<number> {
  const parsed = parseAdoptArgs(argv);
  if (parsed.status === "help") {
    process.stdout.write(`${parsed.helpText}\n`);
    return 0;
  }
  if (parsed.status === "invalid") {
    process.stderr.write(`${ADOPT_ERROR_PREFIX}:${parsed.failure.code}: ${parsed.failure.message}\n`);
    process.stderr.write("Run `hikoutei adopt --help` for usage.\n");
    return parsed.failure.code === "invalid_args"
      ? SETUP_ARG_ERROR_EXIT_CODE
      : SETUP_RUNTIME_ERROR_EXIT_CODE;
  }

  const options = parsed.options;
  try {
    let entities: readonly HikouteiEntity[];
    if (options.entitiesModule !== undefined) {
      entities = [await loadAdoptEntity(options.entitiesModule, options.entityName)];
    } else {
      // No --entities module: fall back to entities registered by an
      // application module already loaded into this process (e.g. via
      // `node --import`). The registry is empty in a bare CLI process, which
      // the flow surfaces as the unknown-entity failure of the public API.
      const token = getRegisteredEntityTokens().find(
        (candidate) => getEntityDescriptor(candidate).name === options.entityName,
      );
      if (token === undefined) {
        throw new HikouteiError(
          HIKOUTEI_ERROR_CODES_ADOPT_ENTITY_UNKNOWN,
          `entity "${options.entityName}" is not registered in this process — pass --entities <module> (a module that calls defineTypedSheetsEntity() on import)`,
        );
      }
      entities = [token];
    }
    return await runAdoptCli({
      options,
      entities,
      runner: productionRunner,
      input: process.stdin,
      output: process.stdout,
      error: process.stderr,
      // The confirmation prompt reads one stdin chunk and leaves the shared
      // iterator open; destroy the stream so the process can exit (Terra S1).
      finalizeStdin: createStdinFinalizer(),
    });
  } catch (error: unknown) {
    const code = typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "unexpected";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`hikoutei-adopt:${code}: ${message}\n`);
    return SETUP_RUNTIME_ERROR_EXIT_CODE;
  }
}

// ESM entrypoint guard: run main() only when this file is the process entry,
// never when merely imported (see setup.ts for the same pattern).
if (isModuleMainEntry(process.argv[1], import.meta.url)) {
  runAdoptMain(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${ADOPT_ERROR_PREFIX}:unexpected: ${safeReason(error)}\n`);
      process.exitCode = SETUP_RUNTIME_ERROR_EXIT_CODE;
    });
}

/** Strict sanitizer: only Error-shaped reasons are ever printed. */
function safeReason(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}