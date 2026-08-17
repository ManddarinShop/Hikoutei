/**
 * Opt-in long soak launcher (cross-platform).
 *
 * The genuinely long soak/recovery suites live in the non-feature
 * `test/soak-runner-unit.test.ts` and only run when `SOAK_RUNNER_LONG=1` is
 * set, keeping the default `npm test` bounded. The feature-dependent
 * end-to-end `test/soak-runner.test.ts` is excluded from this PR stack, so
 * `npm run test:soak` targets the available non-feature soak test file here.
 * A POSIX-style inline assignment (`SOAK_RUNNER_LONG=1 vitest ...`) does not
 * work in Windows cmd/PowerShell npm shells, so the `test:soak` package script
 * delegates here: this launcher sets the opt-in flag in-process and spawns the
 * local Vitest binary against the long soak file, forwarding any extra CLI
 * arguments and the child's exit code. The default `npm test` suite is
 * untouched.
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestEntry = resolve(repoRoot, "node_modules", "vitest", "vitest.mjs");

// npm scripts run with the package root as the working directory, but
// resolve the file set explicitly so the launcher never depends on cwd.
process.env.SOAK_RUNNER_LONG = "1";

const child = spawn(
  process.execPath,
  [vitestEntry, "run", "test/soak-runner-unit.test.ts", ...process.argv.slice(2)],
  { cwd: repoRoot, stdio: "inherit" },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`[test:soak] failed to launch vitest: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
