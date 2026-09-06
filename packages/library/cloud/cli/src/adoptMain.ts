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

import { createTypedSheetsWithSync } from "hikoutei";
import type { HikouteiEntity } from "@hikoutei/sync-engine/api/entity.js";
import { getEntityDescriptor, getRegisteredEntityTokens } from "@hikoutei/sync-engine/api/entity.js";
import { HikouteiError } from "@hikoutei/sync-engine/api/errors.js";
import { parseAdoptArgs, type AdoptOptions } from "./adoptArgs.js";
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
 * Resolves every requested entity token. Loads the `--entities` module once
 * (whose import side effect registers the descriptors), then resolves each
 * requested entity name. Without a module, falls back to entities already
 * registered in this process. Returns the tokens in the order requested.
 */
async function loadAdoptEntities(options: AdoptOptions): Promise<readonly HikouteiEntity[]> {
  const names = options.adopts !== undefined
    ? options.adopts.map((entry) => entry.entityName)
    : [options.entityName!];

  const registered: readonly HikouteiEntity[] = options.entitiesModule !== undefined
    ? (await import(pathToFileURL(options.entitiesModule).href), getRegisteredEntityTokens())
    : getRegisteredEntityTokens();

  const tokens: HikouteiEntity[] = [];
  for (const name of names) {
    const token = registered.find((candidate) => getEntityDescriptor(candidate).name === name);
    if (token === undefined) {
      const scope = options.entitiesModule !== undefined
        ? `module "${options.entitiesModule}"`
        : "this process";
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES_ADOPT_ENTITY_UNKNOWN,
        `entity "${name}" was not registered by ${scope} — pass --entities <module> (a module that calls defineTypedSheetsEntity() at import time; registered: ` +
          `${registered.map((candidate) => getEntityDescriptor(candidate).name).join(", ") || "none"}).`,
      );
    }
    tokens.push(token);
  }
  return tokens;
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
    const entities = await loadAdoptEntities(options);
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