#!/usr/bin/env node
/**
 * `hikoutei setup` CLI entry.
 *
 * Thin main: parse flags, resolve path defaults against the current
 * directory, ask for confirmation (unless `--yes`/`--dry-run`), run the
 * injected-runner setup flow, and print the summary or the dry-run plan.
 * Exit codes: 0 success, 2 argument errors, 1 runtime failures. Errors are
 * printed as `hikoutei-setup:<code>: <message>` for machine consumption, and
 * key material is never printed.
 */

import { resolve } from "node:path";
import { parseSetupArgs } from "./args.js";
import { confirmSetup } from "./confirm.js";
import {
  SETUP_ARG_ERROR_EXIT_CODE,
  SETUP_ERROR_CODES,
  SETUP_RUNTIME_ERROR_EXIT_CODE,
} from "./errors.js";
import { createGcloudRunner } from "./gcloudRunner.js";
import { createGoogleSheetsSpreadsheetCreator } from "./sheetsFactory.js";
import {
  DEFAULT_KEY_FILE_NAME,
  formatPlan,
  formatSummary,
  runSetup,
} from "./setupFlow.js";

async function main(): Promise<number> {
  const parsed = parseSetupArgs(process.argv.slice(2));

  if (parsed.status === "help") {
    process.stdout.write(`${parsed.helpText}\n`);
    return 0;
  }
  if (parsed.status === "invalid") {
    process.stderr.write(`hikoutei-setup:${parsed.failure.code}: ${parsed.failure.message}\n`);
    process.stderr.write("Run `hikoutei setup --help` for usage.\n");
    return parsed.failure.code === SETUP_ERROR_CODES.INVALID_ARGS
      ? SETUP_ARG_ERROR_EXIT_CODE
      : SETUP_RUNTIME_ERROR_EXIT_CODE;
  }

  const options = parsed.options;
  const cwd = process.cwd();

  const confirmed = await confirmSetup({
    yes: options.yes,
    dryRun: options.dryRun,
    input: process.stdin,
    output: process.stdout,
  });
  if (confirmed.status === "declined") {
    process.stdout.write("Setup aborted. Pass --yes to run without confirmation.\n");
    return SETUP_RUNTIME_ERROR_EXIT_CODE;
  }

  const result = await runSetup({
    runner: createGcloudRunner(),
    createSpreadsheet: createGoogleSheetsSpreadsheetCreator(),
    projectId: options.projectId,
    saName: options.saName,
    spreadsheetTitle: options.spreadsheetTitle,
    keyPath: resolve(cwd, DEFAULT_KEY_FILE_NAME),
    outputPath: resolve(cwd, options.output),
    dryRun: options.dryRun,
  });

  if (result.status === "error") {
    process.stderr.write(`hikoutei-setup:${result.code}: ${result.message}\n`);
    return SETUP_RUNTIME_ERROR_EXIT_CODE;
  }
  if (result.dryRun) {
    process.stdout.write("Hikoutei setup dry run (nothing was executed). Planned steps:\n");
    process.stdout.write(`${formatPlan(result.commands)}\n`);
    return 0;
  }
  process.stdout.write(`${formatSummary(result.summary)}\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `hikoutei-setup:unexpected: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = SETUP_RUNTIME_ERROR_EXIT_CODE;
  });
