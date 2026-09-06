/**
 * Interactive confirmation for `hikoutei setup`.
 *
 * The setup flow creates real Google Cloud resources, so the CLI asks for a
 * y/N confirmation before running unless `--yes` (non-interactive mode) or
 * `--dry-run` is given. The input and output sinks are injected so tests can
 * exercise the prompt without a TTY.
 *
 * The separate {@link promptLoginHandoff} prompt offers an Enter-to-start
 * handoff into `gcloud auth login`: when the preflight detects a missing or
 * Drive-less account on a real terminal, Enter launches the browser login in
 * the inherited terminal, while any other input or end-of-input cancels and
 * leaves setup for a later run.
 */

export interface ConfirmSetupOptions {
  readonly yes: boolean;
  readonly dryRun: boolean;
  /** Line/chunk source; `process.stdin` in the real CLI. */
  readonly input: AsyncIterable<string>;
  readonly output: { readonly write: (text: string) => void };
}

export type ConfirmSetupResult = { readonly status: "confirmed" } | { readonly status: "declined" };

/** Input and output sinks for the Enter-to-login handoff prompt. */
export interface PromptLoginHandoffOptions {
  /** Line/chunk source; `process.stdin` in the real CLI. */
  readonly input: AsyncIterable<string>;
  readonly output: { readonly write: (text: string) => void };
}

/** Result of the Enter-to-login handoff prompt. */
export type PromptLoginHandoffResult =
  | { readonly status: "proceed" }
  | { readonly status: "cancel" };

/**
 * Reads exactly one input chunk from a shared async iterable WITHOUT closing
 * or aborting it.
 *
 * A `for await (... of input) { ... return; }` loop calls the iterator's
 * `return()` on early completion. For a Node Readable such as `process.stdin`,
 * `return()` destroys the stream, so the very next read raises `ABORT_ERR`.
 * Setup asks two sequential prompts (the y/N confirmation, then the
 * Enter-to-login handoff) over the SAME shared stdin, so each prompt must
 * consume exactly one chunk and leave the stream open for the next one.
 *
 * This helper acquires the shared iterator — `process.stdin` is its own
 * self-iterator, so re-acquiring it on the next prompt continues right after
 * the last read — and calls `next()` once. It deliberately never calls
 * `return()`, which is the one difference that keeps a later prompt working.
 */
async function readOneInputChunk(input: AsyncIterable<string>): Promise<string | null> {
  const iterator = input[Symbol.asyncIterator]();
  const result = await iterator.next();
  if (result.done === true || result.value === undefined) {
    return null;
  }
  const value = result.value;
  return typeof value === "string" ? value : String(value);
}

const LOGIN_HANDOFF_PROMPT =
  "The active gcloud account is missing or lacks Drive access. Press Enter to " +
  "start `gcloud auth login --enable-gdrive-access --force` in this terminal (a " +
  "browser window opens for you to approve); press any other key or Ctrl-D to " +
  "cancel and finish setup later. ";

/**
 * Prompts once for the Enter-to-login handoff.
 *
 * Reads a single input chunk: an empty line (Enter) or whitespace-only input
 * proceeds with the gcloud login; any other input or end-of-input cancels.
 * Buffers are decoded as UTF-8 so the function works with both string and
 * Buffer stdin streams. This prompt is intentionally separate from the
 * resource-creation {@link confirmSetup} prompt and never runs for `--yes`,
 * `--dry-run`, or non-TTY sessions.
 */
export async function promptLoginHandoff(
  options: PromptLoginHandoffOptions,
): Promise<PromptLoginHandoffResult> {
  options.output.write(LOGIN_HANDOFF_PROMPT);
  const chunk = await readOneInputChunk(options.input);
  if (chunk === null) {
    return { status: "cancel" };
  }
  return chunk.trim() === "" ? { status: "proceed" } : { status: "cancel" };
}

const CONFIRMATION_PROMPT =
  "This will create Google Cloud resources (project, service account, key, spreadsheet). Continue? [y/N] ";

export interface ConfirmAdoptOptions {
  readonly yes: boolean;
  readonly input: AsyncIterable<string>;
  readonly output: { readonly write: (text: string) => void };
  /** One-line summary of what adopt will do, embedded in the prompt. */
  readonly summary: string;
}

const ADOPT_CONFIRMATION_PROMPT =
  (summary: string) =>
    `This will ADOPT ${summary}: the tab gains a row-id system column, the local ` +
    "state is seeded from the existing rows, and fresh system tabs are provisioned. " +
    "Existing cells are never rewritten. Continue? [y/N] ";

/**
 * Asks for confirmation before an adoption unless `--yes` was given. Same
 * single-chunk contract as {@link confirmSetup}; dry-run callers never reach
 * this (the flow only prompts in adopt mode).
 */
export async function confirmAdopt(options: ConfirmAdoptOptions): Promise<ConfirmSetupResult> {
  if (options.yes) {
    return { status: "confirmed" };
  }
  options.output.write(ADOPT_CONFIRMATION_PROMPT(options.summary));
  const chunk = await readOneInputChunk(options.input);
  if (chunk === null) {
    return { status: "declined" };
  }
  const answer = chunk.trim().toLowerCase();
  return answer === "y" || answer === "yes" ? { status: "confirmed" } : { status: "declined" };
}

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
  const chunk = await readOneInputChunk(options.input);
  if (chunk === null) {
    return { status: "declined" };
  }
  const answer = chunk.trim().toLowerCase();
  return answer === "y" || answer === "yes" ? { status: "confirmed" } : { status: "declined" };
}
