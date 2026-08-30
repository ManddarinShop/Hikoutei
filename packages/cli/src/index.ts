#!/usr/bin/env node
/**
 * `hikoutei` bin entry and subcommand router.
 *
 * Routes:
 *   hikoutei setup [flags...]  → the setup bootstrap flow (src/cli/setup.ts)
 *   hikoutei adopt [flags...]  → the existing-sheet adoption flow (src/cli/adoptMain.ts)
 *   hikoutei [flags...]        → legacy spelling of `hikoutei setup` (the bin
 *                                predates subcommands; bare-flag invocations
 *                                stay on the setup flow for compatibility)
 *
 * Both subcommand modules keep their own ESM entrypoint guards, so importing
 * them from this router never triggers their side effects.
 */

import { runAdoptMain } from "./adoptMain.js";
import { runSetupMain } from "./setup.js";
import { SETUP_RUNTIME_ERROR_EXIT_CODE } from "./errors.js";

async function route(argv: readonly string[]): Promise<number> {
  const head = argv[0];
  if (head === "adopt") {
    return runAdoptMain(argv.slice(1));
  }
  if (head === "setup") {
    return runSetupMain(argv.slice(1));
  }
  // Legacy: the bin used to BE the setup CLI, so bare-flag invocations keep
  // working unchanged.
  return runSetupMain(argv);
}

route(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    process.stderr.write(`hikoutei:unexpected: ${reason}\n`);
    process.exitCode = SETUP_RUNTIME_ERROR_EXIT_CODE;
  });