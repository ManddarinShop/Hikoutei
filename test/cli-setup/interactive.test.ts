/**
 * Unit tests for the `hikoutei setup` CLI.
 *
 * Every test runs against the real production modules with injected fakes:
 * a recording gcloud runner, a fake tokeninfo validator, a fake human-token
 * sheet API, and a fake SA verifier — so nothing touches gcloud, the
 * network, or real Google resources. The fake runner simulates gcloud's
 * key-file side effect so the flow's chmod-600 step is exercised
 * realistically.
 */

import {
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  spawn,
} from "node:child_process";
import {
  join,
} from "node:path";
import {
  Readable,
} from "node:stream";
import {
  pathToFileURL,
} from "node:url";
import { describe, expect, it } from "vitest";
import {
  serviceAccountEmail,
} from "../../src/cli/checkpoint.js";
import {
  confirmSetup,
  promptLoginHandoff,
} from "../../src/cli/confirm.js";
import {
  SETUP_ARG_ERROR_EXIT_CODE,
  SETUP_ERROR_CODES,
  type SetupErrorCode,
} from "../../src/cli/errors.js";
import {
  createInteractiveLoginRunner,
  LOGIN_ARGS,
  type GcloudLoginResult,
  type GcloudLoginRunner,
  type LoginSpawner,
} from "../../src/cli/gcloudRunner.js";
import {
  DEFAULT_KEY_FILE_NAME,
  runSetup,
  type SetupResult,
  type SetupSummary,
} from "../../src/cli/setupFlow.js";
import {
  isModuleMainEntry,
  runSetupCli,
  type CliStderr,
  type CliStdin,
  type CliStdout,
  type RunSetupCallable,
  type RunSetupCliContext,
} from "../../src/cli/setup.js";

import {
  makeTempDir,
  FAKE_OWNER,
  SECRET_JWT,
  SECRET_AUTHORIZATION,
  failed,
} from "../support/cliSetupHarness.js";

describe("promptLoginHandoff", () => {
  function capturingOutput(): { output: { write: (text: string) => void }; text: () => string } {
    let text = "";
    return {
      output: { write: (chunk: string) => { text += chunk; } },
      text: () => text,
    };
  }

  it("proceeds on Enter and whitespace-only input", async () => {
    for (const answer of ["\n", "   \n", "\t\n"]) {
      const { output } = capturingOutput();
      const result = await promptLoginHandoff({ input: Readable.from([answer]), output });
      expect(result).toStrictEqual({ status: "proceed" });
    }
  });

  it("cancels on any other input", async () => {
    for (const answer of ["n\n", "no\n", "x\n", "cancel\n"]) {
      const result = await promptLoginHandoff({
        input: Readable.from([answer]),
        output: { write: () => undefined },
      });
      expect(result).toStrictEqual({ status: "cancel" });
    }
  });

  it("cancels on end of input", async () => {
    const result = await promptLoginHandoff({
      input: Readable.from([]),
      output: { write: () => undefined },
    });
    expect(result).toStrictEqual({ status: "cancel" });
  });

  it("writes the Enter-to-login prompt with the exact re-login command", async () => {
    const { output, text } = capturingOutput();
    await promptLoginHandoff({ input: Readable.from(["\n"]), output });
    expect(text()).toContain("Press Enter");
    expect(text()).toContain("gcloud auth login --enable-gdrive-access --force");
  });
});

describe("confirm + login shared stdin (real Readable)", () => {
  /**
   * Regression: the old `for await (... of input) { ... return; }` prompt
   * bodies called the iterator's `return()` on early return, which destroys a
   * Node Readable (such as `process.stdin`). The second prompt then read a
   * destroyed stream and threw ABORT_ERR. A real shared Readable models that
   * stream and must let the confirmation and the login prompt each consume
   * one chunk in sequence without aborting.
   */
  it("consumes two sequential chunks over one shared Readable without ABORT_ERR", async () => {
    const shared = Readable.from(["y\n", "\n"]);
    const confirm = await confirmSetup({
      yes: false,
      dryRun: false,
      input: shared,
      output: { write: () => undefined },
    });
    expect(confirm).toStrictEqual({ status: "confirmed" });
    const login = await promptLoginHandoff({ input: shared, output: { write: () => undefined } });
    expect(login).toStrictEqual({ status: "proceed" });
  });

  it("declines/cancels cleanly when the shared Readable ends after the first chunk", async () => {
    const shared = Readable.from(["y\n"]);
    const confirm = await confirmSetup({
      yes: false,
      dryRun: false,
      input: shared,
      output: { write: () => undefined },
    });
    expect(confirm).toStrictEqual({ status: "confirmed" });
    const login = await promptLoginHandoff({ input: shared, output: { write: () => undefined } });
    expect(login).toStrictEqual({ status: "cancel" });
  });
});

describe("createInteractiveLoginRunner", () => {
  /**
   * Fake spawner that records the login command/options and lets the test
   * drive the child lifecycle (exit/error) deterministically. The spawner
   * never touches a real subprocess.
   */
  function recordingSpawner(): {
    spawner: LoginSpawner;
    calls: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly options: { readonly stdio: "inherit" };
    }>;
    emitExit: (code: number | null) => void;
    emitError: (error: NodeJS.ErrnoException) => void;
  } {
    const calls: Array<{
      readonly command: string;
      readonly args: readonly string[];
      readonly options: { readonly stdio: "inherit" };
    }> = [];
    const errorListeners: Array<(error: NodeJS.ErrnoException) => void> = [];
    const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    const spawner: LoginSpawner = (command, args, options) => {
      calls.push({ command, args, options });
      return {
        on(event: "error" | "exit", listener: (...args: never[]) => void): void {
          if (event === "error") {
            errorListeners.push(listener as (error: NodeJS.ErrnoException) => void);
          } else {
            exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
          }
        },
      } as unknown as import("../../src/cli/gcloudRunner.js").LoginChildProcess;
    };
    return {
      spawner,
      calls,
      emitExit: (code) => {
        for (const listener of exitListeners) {
          listener(code, null);
        }
      },
      emitError: (error) => {
        for (const listener of errorListeners) {
          listener(error);
        }
      },
    };
  }

  it("spawns gcloud auth login --enable-gdrive-access --force with inherited stdio", async () => {
    const { spawner, calls, emitExit } = recordingSpawner();
    const runner = createInteractiveLoginRunner(spawner);
    const promise = runner.runInteractiveLogin();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("gcloud");
    expect(calls[0]?.args).toStrictEqual([...LOGIN_ARGS]);
    expect(calls[0]?.args).toStrictEqual(["auth", "login", "--enable-gdrive-access", "--force"]);
    expect(calls[0]?.options).toStrictEqual({ stdio: "inherit" });
    emitExit(0);
    expect(await promise).toStrictEqual({ status: "ok" });
  });

  it("reports ok on a clean exit", async () => {
    const { spawner, emitExit } = recordingSpawner();
    const runner = createInteractiveLoginRunner(spawner);
    const promise = runner.runInteractiveLogin();
    emitExit(0);
    expect(await promise).toStrictEqual({ status: "ok" });
  });

  it("reports failed with the exit code on a non-zero exit", async () => {
    const { spawner, emitExit } = recordingSpawner();
    const runner = createInteractiveLoginRunner(spawner);
    const promise = runner.runInteractiveLogin();
    emitExit(1);
    expect(await promise).toStrictEqual({ status: "failed", code: 1 });
  });

  it("reports not_found on ENOENT (gcloud missing)", async () => {
    const { spawner, emitError } = recordingSpawner();
    const runner = createInteractiveLoginRunner(spawner);
    const promise = runner.runInteractiveLogin();
    emitError(Object.assign(new Error(`spawn gcloud ENOENT ${SECRET_JWT}`), { code: "ENOENT" }));
    const result = await promise;
    expect(result).toStrictEqual({ status: "not_found" });
  });

  it("reports spawn_error on any other spawn failure", async () => {
    const { spawner, emitError } = recordingSpawner();
    const runner = createInteractiveLoginRunner(spawner);
    const promise = runner.runInteractiveLogin();
    emitError(Object.assign(new Error(`spawn exploded ${SECRET_AUTHORIZATION}`), { code: "EACCES" }));
    const result = await promise;
    expect(result).toStrictEqual({ status: "spawn_error" });
  });

  it("resolves once and ignores a later lifecycle event", async () => {
    const { spawner, emitExit, emitError } = recordingSpawner();
    const runner = createInteractiveLoginRunner(spawner);
    const promise = runner.runInteractiveLogin();
    emitExit(0);
    const first = await promise;
    // A delayed error after the clean exit must not change the result.
    emitError(Object.assign(new Error("late"), { code: "ENOENT" }));
    expect(first).toStrictEqual({ status: "ok" });
  });
});

describe("runSetupCli — interactive login handoff", () => {
  /**
   * Fake stdin whose single shared iterator lets consecutive prompts
   * (confirmSetup, then promptLoginHandoff) draw chunks in order without
   * restarting. `isTTY` gates the login handoff.
   */
  function makeStdin(chunks: readonly string[], isTTY: boolean): CliStdin {
    let index = 0;
    const iterator: AsyncIterator<string> = {
      next(): Promise<IteratorResult<string>> {
        if (index < chunks.length) {
          const value = chunks[index] as string;
          index += 1;
          return Promise.resolve({ value, done: false });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    return { [Symbol.asyncIterator]: () => iterator, isTTY };
  }

  function capturingStdout(isTTY: boolean): { stdout: CliStdout; text: () => string } {
    let text = "";
    const stdout: CliStdout = { write: (chunk: string) => { text += chunk; }, isTTY };
    return { stdout, text: () => text };
  }

  function capturingStderr(): { stderr: CliStderr; text: () => string } {
    let text = "";
    const stderr: CliStderr = { write: (chunk: string) => { text += chunk; } };
    return { stderr, text: () => text };
  }

  function okSummary(): SetupSummary {
    return {
      projectId: "hikoutei-test-project",
      ownerEmail: FAKE_OWNER,
      serviceAccountEmail: "hikoutei-sa@hikoutei-test-project.iam.gserviceaccount.com",
      keyPath: "/tmp/hikoutei-service-account.json",
      spreadsheetId: "sheet-1",
      spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
      spreadsheetTitle: "hikoutei-sync-hikoutei-test-project",
      outputPath: "/tmp/.env",
      statePath: "/tmp/.hikoutei-setup-state.json",
      stateStatus: "complete",
      envFileCreated: true,
      envFileModified: false,
      projectReused: false,
      serviceAccountReused: false,
      keyReused: false,
      saWriterRole: "created",
      resumed: false,
    };
  }

  function okResult(): SetupResult {
    return { status: "ok", dryRun: false, summary: okSummary(), commands: [] };
  }

  function dryRunResult(): SetupResult {
    return { status: "ok", dryRun: true, commands: [] };
  }

  function errorResultOf(code: SetupErrorCode, message: string): SetupResult {
    return { status: "error", code, message };
  }

  /** Scripted setup callable that returns the given results in order; the
   * last result repeats for any extra calls so tests stay deterministic. */
  function scriptedRunSetup(results: ReadonlyArray<SetupResult>): {
    runSetup: RunSetupCallable;
    calls: () => number;
  } {
    let calls = 0;
    const runSetup: RunSetupCallable = async (params): Promise<SetupResult> => {
      calls += 1;
      const index = Math.min(calls - 1, results.length - 1);
      return results[index] as SetupResult;
    };
    return { runSetup, calls: () => calls };
  }

  function scriptedLogin(result: GcloudLoginResult): {
    runner: GcloudLoginRunner;
    calls: () => number;
  } {
    let calls = 0;
    const runner: GcloudLoginRunner = {
      async runInteractiveLogin(): Promise<GcloudLoginResult> {
        calls += 1;
        return result;
      },
    };
    return { runner, calls: () => calls };
  }

  /** A login runner that must never be invoked; it throws if it is. */
  const neverLogin: GcloudLoginRunner = {
    async runInteractiveLogin(): Promise<GcloudLoginResult> {
      throw new Error("login must not run in this scenario");
    },
  };

  function baseOptions(overrides: Partial<{ yes: boolean; dryRun: boolean }> = {}): import("../../src/cli/args.js").SetupOptions {
    return {
      saName: "hikoutei-sa",
      output: ".env",
      yes: false,
      dryRun: false,
      ...overrides,
    };
  }

  it("retries exactly once after a successful login when Drive scope is missing (interactive TTY)", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(
        SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED,
        `the active gcloud account does not grant Drive access; run \`gcloud auth login --enable-gdrive-access --force\` and try again`,
      ),
      okResult(),
    ]);
    const login = scriptedLogin({ status: "ok" });
    const { stdout, text: stdoutText } = capturingStdout(true);
    const { stderr, text: stderrText } = capturingStderr();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: login.runner,
      stdin: makeStdin(["y\n", "\n"], true),
      stdout,
      stderr,
    };
    const exitCode = await runSetupCli(context);
    expect(exitCode).toBe(0);
    expect(setup.calls()).toBe(2);
    expect(login.calls()).toBe(1);
    expect(stdoutText()).toContain("Hikoutei setup complete.");
    expect(stderrText()).toBe("");
  });

  it("retries exactly once for gcloud_not_logged_in too", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN, "no active gcloud account"),
      okResult(),
    ]);
    const login = scriptedLogin({ status: "ok" });
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: login.runner,
      stdin: makeStdin(["y\n", "\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
    };
    expect(await runSetupCli(context)).toBe(0);
    expect(setup.calls()).toBe(2);
    expect(login.calls()).toBe(1);
  });

  it("does not login again when the retry still lacks Drive scope", async () => {
    const authError = errorResultOf(
      SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED,
      "the active gcloud account does not grant Drive access",
    );
    const setup = scriptedRunSetup([authError, authError]);
    const login = scriptedLogin({ status: "ok" });
    const { stderr, text: stderrText } = capturingStderr();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: login.runner,
      stdin: makeStdin(["y\n", "\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr,
    };
    const exitCode = await runSetupCli(context);
    expect(exitCode).toBe(1);
    expect(setup.calls()).toBe(2);
    expect(login.calls()).toBe(1);
    expect(stderrText()).toContain(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED);
  });

  it("maps a failed login to gcloud_login_failed without retrying setup", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED, "drive scope missing"),
    ]);
    const login = scriptedLogin({ status: "failed", code: 1 });
    const { stderr, text: stderrText } = capturingStderr();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: login.runner,
      stdin: makeStdin(["y\n", "\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr,
    };
    const exitCode = await runSetupCli(context);
    expect(exitCode).toBe(1);
    expect(setup.calls()).toBe(1);
    expect(login.calls()).toBe(1);
    expect(stderrText()).toContain(SETUP_ERROR_CODES.GCLOUD_LOGIN_FAILED);
    expect(stderrText()).toContain("gcloud auth login --enable-gdrive-access --force");
    expect(stderrText()).not.toContain(SECRET_JWT);
    expect(stderrText()).not.toContain(SECRET_AUTHORIZATION);
  });

  it("maps a not_found login to gcloud_login_failed pointing at install", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_NOT_LOGGED_IN, "no active account"),
    ]);
    const login = scriptedLogin({ status: "not_found" });
    const { stderr, text: stderrText } = capturingStderr();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: login.runner,
      stdin: makeStdin(["y\n", "\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(stderrText()).toContain(SETUP_ERROR_CODES.GCLOUD_LOGIN_FAILED);
    expect(stderrText()).toContain("https://cloud.google.com/sdk");
  });

  it("maps a spawn_error login to gcloud_login_failed", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED, "scope missing"),
    ]);
    const login = scriptedLogin({ status: "spawn_error" });
    const { stderr, text: stderrText } = capturingStderr();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: login.runner,
      stdin: makeStdin(["y\n", "\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(stderrText()).toContain(SETUP_ERROR_CODES.GCLOUD_LOGIN_FAILED);
  });

  it("does not run the login subprocess when --yes is given", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED, "scope missing"),
    ]);
    const { stderr, text: stderrText } = capturingStderr();
    const context: RunSetupCliContext = {
      options: baseOptions({ yes: true }),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin([], true),
      stdout: capturingStdout(true).stdout,
      stderr,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(setup.calls()).toBe(1);
    expect(stderrText()).toContain(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED);
  });

  it("does not run the login subprocess in --dry-run", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED, "scope missing"),
    ]);
    const context: RunSetupCliContext = {
      options: baseOptions({ dryRun: true }),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin([], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(setup.calls()).toBe(1);
  });

  it("does not run the login subprocess when stdin is not a TTY", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED, "scope missing"),
    ]);
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin(["y\n"], false),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(setup.calls()).toBe(1);
  });

  it("does not run the login subprocess when stdout is not a TTY", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED, "scope missing"),
    ]);
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin(["y\n"], true),
      stdout: capturingStdout(false).stdout,
      stderr: capturingStderr().stderr,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(setup.calls()).toBe(1);
  });

  it("does not run the login subprocess on a CI pseudo-TTY (no prompt, no retry)", async () => {
    // CI runners allocate a pseudo-TTY, so `isTTY` alone is not a safe
    // gate: the handoff must also be refused when the session is an
    // automation run (`isCi` true, as production main derives it from a
    // non-empty `CI` environment value) — help/docs promise a manual login
    // command and one static progress line per event in CI, never an
    // interactive prompt or a spawned browser login.
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED, "scope missing"),
    ]);
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin(["y\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
      isCi: true,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(setup.calls()).toBe(1);
  });

  it("still offers the login handoff when isCi is absent (scripted tests, real TTY)", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED, "scope missing"),
      okResult(),
    ]);
    const login = scriptedLogin({ status: "ok" });
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: login.runner,
      stdin: makeStdin(["y\n", "\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
    };
    expect(await runSetupCli(context)).toBe(0);
    expect(setup.calls()).toBe(2);
    expect(login.calls()).toBe(1);
  });

  it("cancels (no login, no retry) when the prompt gets non-Enter input", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED, "scope missing"),
    ]);
    const { stderr, text: stderrText } = capturingStderr();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin(["y\n", "n\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(setup.calls()).toBe(1);
    expect(stderrText()).toContain(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED);
  });

  it("cancels when the prompt reaches end of input", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED, "scope missing"),
    ]);
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin(["y\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(setup.calls()).toBe(1);
  });

  it("does not offer login when the failure is not an auth preflight error", async () => {
    const setup = scriptedRunSetup([
      errorResultOf(SETUP_ERROR_CODES.KEY_CREATE_FAILED, "key create exploded"),
    ]);
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin(["y\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(setup.calls()).toBe(1);
  });

  it("prints the dry-run plan and does not login when the first run is a dry run", async () => {
    const setup = scriptedRunSetup([dryRunResult()]);
    const { stdout, text: stdoutText } = capturingStdout(true);
    const context: RunSetupCliContext = {
      options: baseOptions({ dryRun: true }),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin([], true),
      stdout,
      stderr: capturingStderr().stderr,
    };
    expect(await runSetupCli(context)).toBe(0);
    expect(setup.calls()).toBe(1);
    expect(stdoutText()).toContain("Hikoutei setup dry run");
  });

  it("aborts before running setup when confirmation is declined", async () => {
    const setup = scriptedRunSetup([okResult()]);
    const { stdout, text: stdoutText } = capturingStdout(true);
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin(["n\n"], true),
      stdout,
      stderr: capturingStderr().stderr,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(setup.calls()).toBe(0);
    expect(stdoutText()).toContain("Setup aborted");
  });
});

describe("runSetupCli — shared stdin finalization", () => {
  /**
   * Regression for the release blocker: the confirmation and login-handoff
   * prompts read `process.stdin` through its async iterator WITHOUT calling
   * the iterator's `return()` (so the two sequential prompts share one
   * stream), which leaves an internal listener that would hold the process
   * alive after setup finishes. `runSetupCli` must invoke the injected
   * `finalizeStdin` exactly once on EVERY outcome — success, errors, login
   * cancel/failure, declined confirmation, and path collision — and only
   * AFTER the inherited gcloud login subprocess has resolved (the terminal
   * must stay live for the user's browser login).
   */
  function recordingFinalizer(): {
    finalize: () => void;
    calls: () => number;
  } {
    let count = 0;
    return {
      finalize: () => { count += 1; },
      calls: () => count,
    };
  }

  const authError: SetupResult = {
    status: "error",
    code: SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED,
    message: "the active gcloud account does not grant Drive access",
  };

  /** Minimal login runner that never runs; it throws if invoked. */
  const neverLogin: GcloudLoginRunner = {
    async runInteractiveLogin(): Promise<GcloudLoginResult> {
      throw new Error("login must not run in this scenario");
    },
  };

  function okResult(): SetupResult {
    return {
      status: "ok",
      dryRun: false,
      summary: {
        projectId: "hikoutei-test-project",
        ownerEmail: FAKE_OWNER,
        serviceAccountEmail: "hikoutei-sa@hikoutei-test-project.iam.gserviceaccount.com",
        keyPath: "/tmp/hikoutei-service-account.json",
        spreadsheetId: "sheet-1",
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/sheet-1/edit",
        spreadsheetTitle: "hikoutei-sync-hikoutei-test-project",
        outputPath: "/tmp/.env",
        statePath: "/tmp/.hikoutei-setup-state.json",
        stateStatus: "complete",
        envFileCreated: true,
        envFileModified: false,
        projectReused: false,
        serviceAccountReused: false,
        keyReused: false,
        saWriterRole: "created",
        resumed: false,
      },
      commands: [],
    };
  }

  /** Scripted setup callable returning the given results in order; the last repeats. */
  function scriptedRunSetup(results: ReadonlyArray<SetupResult>): {
    runSetup: RunSetupCallable;
    calls: () => number;
  } {
    let calls = 0;
    const runSetup: RunSetupCallable = async (params): Promise<SetupResult> => {
      calls += 1;
      const index = Math.min(calls - 1, results.length - 1);
      return results[index] as SetupResult;
    };
    return { runSetup, calls: () => calls };
  }

  function scriptedLogin(result: GcloudLoginResult): {
    runner: GcloudLoginRunner;
    calls: () => number;
  } {
    let calls = 0;
    const runner: GcloudLoginRunner = {
      async runInteractiveLogin(): Promise<GcloudLoginResult> {
        calls += 1;
        return result;
      },
    };
    return { runner, calls: () => calls };
  }

  function baseOptions(overrides: Partial<{ yes: boolean; dryRun: boolean; output: string }> = {}): import("../../src/cli/args.js").SetupOptions {
    return {
      saName: "hikoutei-sa",
      output: ".env",
      yes: false,
      dryRun: false,
      ...overrides,
    };
  }

  /** Fake stdin whose single shared iterator lets sequential prompts draw chunks in order. */
  function makeStdin(chunks: readonly string[], isTTY: boolean): CliStdin {
    let index = 0;
    const iterator: AsyncIterator<string> = {
      next(): Promise<IteratorResult<string>> {
        if (index < chunks.length) {
          const value = chunks[index] as string;
          index += 1;
          return Promise.resolve({ value, done: false });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    return { [Symbol.asyncIterator]: () => iterator, isTTY };
  }

  function capturingStdout(isTTY: boolean): { stdout: CliStdout } {
    return { stdout: { write: () => undefined, isTTY } };
  }

  function capturingStderr(): { stderr: CliStderr } {
    return { stderr: { write: () => undefined } };
  }

  it("finalizes stdin exactly once after a successful login retry, after the login resolves", async () => {
    const events: string[] = [];
    const setup = scriptedRunSetup([authError, okResult()]);
    const login: GcloudLoginRunner = {
      async runInteractiveLogin(): Promise<GcloudLoginResult> {
        events.push("login-resolved");
        return { status: "ok" };
      },
    };
    const finalizer = recordingFinalizer();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: login,
      stdin: makeStdin(["y\n", "\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
      finalizeStdin: () => { events.push("finalize"); finalizer.finalize(); },
    };
    expect(await runSetupCli(context)).toBe(0);
    expect(setup.calls()).toBe(2);
    expect(finalizer.calls()).toBe(1);
    // The finalizer must release the shared stdin only after the inherited
    // gcloud login finished; destroying it earlier would break the browser
    // handoff that runs in the same terminal.
    expect(events).toEqual(["login-resolved", "finalize"]);
  });

  it("finalizes stdin on success without any login", async () => {
    const setup = scriptedRunSetup([okResult()]);
    const finalizer = recordingFinalizer();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin(["y\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
      finalizeStdin: finalizer.finalize,
    };
    expect(await runSetupCli(context)).toBe(0);
    expect(finalizer.calls()).toBe(1);
  });

  it("finalizes stdin when the retry still lacks Drive scope", async () => {
    const setup = scriptedRunSetup([authError, authError]);
    const finalizer = recordingFinalizer();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: scriptedLogin({ status: "ok" }).runner,
      stdin: makeStdin(["y\n", "\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
      finalizeStdin: finalizer.finalize,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(finalizer.calls()).toBe(1);
  });

  it("finalizes stdin when the interactive login fails", async () => {
    const setup = scriptedRunSetup([authError]);
    const finalizer = recordingFinalizer();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: scriptedLogin({ status: "failed", code: 1 }).runner,
      stdin: makeStdin(["y\n", "\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
      finalizeStdin: finalizer.finalize,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(setup.calls()).toBe(1);
    expect(finalizer.calls()).toBe(1);
  });

  it("finalizes stdin when the handoff is cancelled", async () => {
    const setup = scriptedRunSetup([authError]);
    const finalizer = recordingFinalizer();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin(["y\n", "n\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
      finalizeStdin: finalizer.finalize,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(finalizer.calls()).toBe(1);
  });

  it("finalizes stdin when an auth error cannot be retried (--yes)", async () => {
    const setup = scriptedRunSetup([authError]);
    const finalizer = recordingFinalizer();
    const context: RunSetupCliContext = {
      options: baseOptions({ yes: true }),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin([], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
      finalizeStdin: finalizer.finalize,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(finalizer.calls()).toBe(1);
  });

  it("finalizes stdin when confirmation is declined", async () => {
    const setup = scriptedRunSetup([okResult()]);
    const finalizer = recordingFinalizer();
    const context: RunSetupCliContext = {
      options: baseOptions(),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin(["n\n"], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
      finalizeStdin: finalizer.finalize,
    };
    expect(await runSetupCli(context)).toBe(1);
    expect(setup.calls()).toBe(0);
    expect(finalizer.calls()).toBe(1);
  });

  it("finalizes stdin on a path collision before confirmation", async () => {
    const setup = scriptedRunSetup([okResult()]);
    const finalizer = recordingFinalizer();
    // `--output` aliasing the key path is a canonical path collision; it is
    // rejected before any prompt or setup call, and the stdin must still be
    // released so the process can exit.
    const context: RunSetupCliContext = {
      options: baseOptions({ output: DEFAULT_KEY_FILE_NAME }),
      cwd: "/tmp",
      runSetup: setup.runSetup,
      loginRunner: neverLogin,
      stdin: makeStdin([], true),
      stdout: capturingStdout(true).stdout,
      stderr: capturingStderr().stderr,
      finalizeStdin: finalizer.finalize,
    };
    expect(await runSetupCli(context)).toBe(SETUP_ARG_ERROR_EXIT_CODE);
    expect(setup.calls()).toBe(0);
    expect(finalizer.calls()).toBe(1);
  });
});

describe("shared stdin async iterator — subprocess lifetime regression", () => {
  /**
   * Deterministic subprocess proof of the release blocker behind
   * `finalizeStdin`: a Node process whose stdin pipe stays open (the parent
   * never closes it) must NOT exit after finishing its work while the
   * shared async iterator is left open (the `readOneInputChunk` pattern:
   * `next()` without `return()`), and MUST exit once the stream is
   * destroyed — the production finalizer's `process.stdin.destroy()`.
   *
   * The child scripts are self-contained (they import nothing from this
   * repository) so the test does not depend on build artifacts; they model
   * exactly the prompt pattern: two sequential single-chunk reads over one
   * shared stdin iterator, then work completion.
   */
  const PATTERN_SCRIPT = `
const it = process.stdin[Symbol.asyncIterator]();
const a = await it.next();
console.log("first:" + String(a.value).trim());
const b = await it.next();
console.log("second:" + String(b.value).trim());
console.log("work-done");
`;
  const PATTERN_SCRIPT_WITH_DESTROY = `${PATTERN_SCRIPT}
process.stdin.destroy();
`;

  interface ChildOutcome {
    readonly exitCode: number | null;
    readonly output: string;
  }

  /**
   * Spawns the child, feeds the two prompt chunks (waiting for the first
   * read before writing the second so pipes deliver them as two chunks),
   * keeps stdin OPEN, and resolves once the child exits or the bounded
   * window elapses.
   */
  function runPatternChild(script: string): Promise<{ outcome: ChildOutcome; exitedWhileOpen: boolean }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      let output = "";
      let settled = false;
      let graceTimer: NodeJS.Timeout | undefined;
      const finish = (outcome: ChildOutcome, exitedWhileOpen: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (graceTimer !== undefined) {
          clearTimeout(graceTimer);
        }
        resolve({ outcome, exitedWhileOpen });
      };
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (!output.includes("first:")) {
          return;
        }
        if (!output.includes("second:") && !child.stdin.destroyed) {
          child.stdin.write("\n");
        }
        // Once the child finished its work, give it a short bounded window to
        // exit on its own; the open iterator must keep it alive past it.
        if (output.includes("work-done") && graceTimer === undefined) {
          graceTimer = setTimeout(() => {
            // The child hung with the open iterator (the regression under
            // test): kill it so the suite never leaks a live child process,
            // then report that it did NOT exit while stdin stayed open.
            child.kill("SIGKILL");
            finish({ exitCode: null, output }, false);
          }, 2500);
        }
      });
      child.on("error", (error: Error) => {
        if (!settled) {
          if (graceTimer !== undefined) {
            clearTimeout(graceTimer);
          }
          reject(error);
        }
      });
      child.on("exit", (code: number | null) => {
        finish({ exitCode: code, output }, true);
      });
      child.stdin.write("y\n");
    });
  }

  it("an unfinalized shared stdin iterator keeps the process alive after work completes", async () => {
    const { outcome, exitedWhileOpen } = await runPatternChild(PATTERN_SCRIPT);
    expect(outcome.output).toContain("first:y");
    expect(outcome.output).toContain("second:");
    expect(outcome.output).toContain("work-done");
    // The child finished its work but must still be running because the
    // open iterator holds the open stdin pipe — exactly the production
    // hang the finalizer prevents.
    expect(exitedWhileOpen).toBe(false);
    expect(outcome.exitCode).toBeNull();
  });

  it("destroying the shared stdin (the production finalizer) lets the process exit", async () => {
    const { outcome, exitedWhileOpen } = await runPatternChild(PATTERN_SCRIPT_WITH_DESTROY);
    expect(outcome.output).toContain("work-done");
    expect(exitedWhileOpen).toBe(true);
    expect(outcome.exitCode).toBe(0);
  });
});

describe("isModuleMainEntry", () => {
  it("returns false for an undefined entry argument", () => {
    expect(isModuleMainEntry(undefined, "file:///tmp/hikoutei-setup.js")).toBe(false);
  });

  it("returns true when the entry resolves to the module file", () => {
    const dir = makeTempDir();
    const modulePath = join(dir, "setup.js");
    writeFileSync(modulePath, "");
    expect(isModuleMainEntry(modulePath, pathToFileURL(modulePath).href)).toBe(true);
  });

  it("returns true when the entry is a symlink to the module file (npm bin)", () => {
    const dir = makeTempDir();
    const modulePath = join(dir, "setup.js");
    writeFileSync(modulePath, "");
    const linkPath = join(dir, "hikoutei-bin");
    symlinkSync(modulePath, linkPath);
    expect(isModuleMainEntry(linkPath, pathToFileURL(modulePath).href)).toBe(true);
  });

  it("returns false when the entry is a different file", () => {
    const dir = makeTempDir();
    const modulePath = join(dir, "setup.js");
    const otherPath = join(dir, "other.js");
    writeFileSync(modulePath, "");
    writeFileSync(otherPath, "");
    expect(isModuleMainEntry(otherPath, pathToFileURL(modulePath).href)).toBe(false);
  });

  it("returns false when the entry path does not exist", () => {
    const dir = makeTempDir();
    const modulePath = join(dir, "setup.js");
    writeFileSync(modulePath, "");
    expect(isModuleMainEntry(join(dir, "missing.js"), pathToFileURL(modulePath).href)).toBe(false);
  });

  it("returns false for a non-file module URL", () => {
    const dir = makeTempDir();
    const entry = join(dir, "setup.js");
    writeFileSync(entry, "");
    expect(isModuleMainEntry(entry, "https://example.com/setup.js")).toBe(false);
  });
});

describe("package and entry regression", () => {
  it("maps the bin to the subcommand router (dist/cli/index.js) with a node shebang", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      bin: Record<string, string>;
    };
    // The bin moved to the router so `hikoutei adopt` coexists with the
    // legacy bare-flag setup spelling (routed back to the setup flow).
    expect(pkg.bin.hikoutei).toBe("./dist/cli/index.js");

    const router = readFileSync(new URL("../../src/cli/index.ts", import.meta.url), "utf8");
    expect(router.split("\n")[0]).toBe("#!/usr/bin/env node");
    expect(router).toContain('head === "adopt"');
    expect(router).toContain('head === "setup"');

    // The setup entry keeps its shebang for direct `node dist/cli/setup.js`
    // invocations (back-compat when the bin WAS the setup CLI).
    const entry = readFileSync(new URL("../../src/cli/setup.ts", import.meta.url), "utf8");
    expect(entry.split("\n")[0]).toBe("#!/usr/bin/env node");
  });
});
