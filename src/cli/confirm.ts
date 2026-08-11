/**
 * Interactive confirmation for `hikoutei setup`.
 *
 * The setup flow creates real Google Cloud resources, so the CLI asks for a
 * y/N confirmation before running unless `--yes` (non-interactive mode) or
 * `--dry-run` is given. The input and output sinks are injected so tests can
 * exercise the prompt without a TTY.
 */

export interface ConfirmSetupOptions {
  readonly yes: boolean;
  readonly dryRun: boolean;
  /** Line/chunk source; `process.stdin` in the real CLI. */
  readonly input: AsyncIterable<string>;
  readonly output: { readonly write: (text: string) => void };
}

export type ConfirmSetupResult = { readonly status: "confirmed" } | { readonly status: "declined" };

const CONFIRMATION_PROMPT =
  "This will create Google Cloud resources (project, service account, key, spreadsheet). Continue? [y/N] ";

/**
 * Asks for confirmation unless `--yes` or `--dry-run` was given.
 *
 * Reads a single input chunk; `y`/`yes` (case-insensitive) confirms, anything
 * else or end-of-input declines. Buffers are decoded as UTF-8 so the function
 * works with both string and Buffer stdin streams.
 */
export async function confirmSetup(options: ConfirmSetupOptions): Promise<ConfirmSetupResult> {
  if (options.yes || options.dryRun) {
    return { status: "confirmed" };
  }
  options.output.write(CONFIRMATION_PROMPT);
  for await (const chunk of options.input) {
    const text = typeof chunk === "string" ? chunk : String(chunk);
    const answer = text.trim().toLowerCase();
    return answer === "y" || answer === "yes" ? { status: "confirmed" } : { status: "declined" };
  }
  return { status: "declined" };
}
