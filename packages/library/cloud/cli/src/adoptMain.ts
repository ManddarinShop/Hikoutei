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

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createTypedSheetsWithSync } from "hikoutei";
import type { HikouteiEntity } from "@hikoutei/sync-engine/api/entity.js";
import {
  defineTypedSheetsEntityFromDescriptorFile,
  descriptorFileColumnMap,
  getEntityDescriptor,
  getRegisteredEntityTokens,
  parseDescriptorFile,
} from "@hikoutei/sync-engine/api/entity.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "@hikoutei/sync-engine/api/errors.js";
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
 * Loads the ambient/module entity registry: imports the `--entities` module
 * once (whose import side effect registers the descriptors) and snapshots
 * the tokens, or falls back to entities already registered in this process.
 */
async function registeredTokens(entitiesModule: string | undefined): Promise<readonly HikouteiEntity[]> {
  if (entitiesModule !== undefined) {
    await import(pathToFileURL(entitiesModule).href);
  }
  return getRegisteredEntityTokens();
}

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

  const registered = await registeredTokens(options.entitiesModule);

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
 * Resolves a `--descriptor` adoption: reads the JSON file, validates it
 * with the same rules `defineTypedSheetsEntity` enforces (version mismatch
 * and malformed fields fail with `invalid_entity_descriptor`), rejects an
 * already-registered entity name with `duplicate_entity`, and registers the
 * file through the same builder adopt requires. The header→property
 * columnMap comes from the file's `header` fields; an explicit `--map` wins
 * on a conflict. File content is never echoed (redaction); only the reason
 * and the descriptor path are reported.
 */
export async function loadDescriptorAdoption(
  options: AdoptOptions,
): Promise<{ readonly entityName: string; readonly columnMap: Record<string, string>; readonly entities: readonly HikouteiEntity[] }> {
  const descriptorPath = options.descriptorPath!;
  let raw: string;
  try {
    raw = await readFile(descriptorPath, "utf8");
  } catch {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      `could not read the descriptor file "${descriptorPath}".`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      `descriptor file "${descriptorPath}" is not valid JSON.`,
    );
  }
  const file = parseDescriptorFile(json);
  const registered = await registeredTokens(options.entitiesModule);
  if (registered.some((candidate) => getEntityDescriptor(candidate).name === file.name)) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.DUPLICATE_ENTITY,
      `entity "${file.name}" from descriptor file "${descriptorPath}" is already registered.`,
    );
  }
  return {
    entityName: file.name,
    // Explicit `--map` bindings win over the file-derived headers.
    columnMap: { ...descriptorFileColumnMap(file), ...(options.columnMap ?? {}) },
    entities: [defineTypedSheetsEntityFromDescriptorFile(file)],
  };
}

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
    // `--descriptor` (file alternative to `--entity`): the entity name and
    // the header→property columnMap come from the file, so `--map` flags
    // are unnecessary; an explicit `--map` still wins on a conflict.
    if (options.descriptorPath !== undefined) {
      const resolved = await loadDescriptorAdoption(options);
      const { descriptorPath: _dropped, ...rest } = options;
      void _dropped;
      return await runAdoptCli({
        options: {
          ...rest,
          entityName: resolved.entityName,
          ...(resolved.columnMap === undefined ? {} : { columnMap: resolved.columnMap }),
        },
        entities: resolved.entities,
        runner: productionRunner,
        input: process.stdin,
        output: process.stdout,
        error: process.stderr,
        // The confirmation prompt reads one stdin chunk and leaves the shared
        // iterator open; destroy the stream so the process can exit (Terra S1).
        finalizeStdin: createStdinFinalizer(),
      });
    }
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