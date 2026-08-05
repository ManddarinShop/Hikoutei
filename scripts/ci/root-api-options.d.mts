/**
 * Type declarations for `scripts/ci/root-api-options.mjs`.
 *
 * The helper is hand-written ESM (consistent with the other `scripts/ci/*.mjs`
 * tools) and is consumed by the installed root API smoke runner and by Vitest.
 * These declarations give the TypeScript test suite full type checking without
 * adding `scripts/**` to a `tsconfig` `include` set.
 */

export type RootApiOptions = {
  /** Resolved output JSON report path. Never `undefined`. */
  output: string;
  /** Step-summary path, or `undefined` when `$GITHUB_STEP_SUMMARY` is unset. */
  summary: string | undefined;
};

/**
 * Parse the installed root API smoke CLI options. Throws on a missing/empty
 * value or a bare option followed by another option token (for example
 * `--output --summary=foo`).
 *
 * @param argv - arguments after the script path.
 */
export function parseRootApiOptions(argv: readonly string[]): RootApiOptions;
