/**
 * Internal file logger tests: SINK BEHAVIOR and runtime BOUNDARY.
 *
 * Split from internal-file-logger.test.ts (rotation, fail-open, public-runtime
 * boundary integration, and the process singleton describe groups).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createHikouteiInternalLogger,
  DEFAULT_BACKUPS,
  DEFAULT_MAX_BYTES,
  describeErrorForInternalLog,
  ensureTxtExtension,
  formatHikouteiLogLine,
  getHikouteiInternalLogger,
  HIKOUTEI_LOG_ENV_KEYS,
  logHikouteiInternalEvent,
  resetHikouteiInternalLoggerForTests,
  rotatedLogPath,
  stableConsoleErrorTag,
  type HikouteiInternalLogger,
} from "@hikoutei/sync-engine/shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_EVENTS,
  HIKOUTEI_LOG_STABLE_CODES,
} from "@hikoutei/sync-engine/shared/observability/logEvents.js";
/** Reads a log file and parses every JSONL line. */
async function readLogLines(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * True when the platform can create symlinks (used to skip the symlink
 * rejection test with an explicit reason on filesystems that cannot).
 */
const SYMLINK_SUPPORTED = (() => {
  const probeDir = mkdtempSync(path.join(tmpdir(), "hikoutei-log-symlink-probe-"));
  try {
    const target = path.join(probeDir, "target.txt");
    writeFileSync(target, "probe", "utf8");
    symlinkSync(target, path.join(probeDir, "link.txt"));
    return existsSync(path.join(probeDir, "link.txt"));
  } catch {
    return false;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
})();

describe("internal file logger rotation", () => {
  it("rotates to numbered .txt backups within the backup budget", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-log-rot-"));
    try {
      const filePath = path.join(tempRoot, "hikoutei-log.txt");
      const logger = createHikouteiInternalLogger({
        env: {
          [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: filePath,
          // 4 KiB is the floor; each padded line exceeds it so every write
          // after the first rotates.
          [HIKOUTEI_LOG_ENV_KEYS.LOG_MAX_BYTES]: "4096",
          [HIKOUTEI_LOG_ENV_KEYS.LOG_BACKUPS]: "2",
        },
      });
      const padding = (pass: number): Record<string, number> =>
        Object.fromEntries(
          Array.from({ length: 500 }, (_, index) => [`p${index}`, index]),
        ) as Record<string, number>;
      for (let pass = 0; pass < 6; pass += 1) {
        logger.log({ event: "hikoutei.outbox.pass_summary", counts: { ...padding(pass), pass } });
        await logger.drain();
      }
      // The current file plus exactly two rotated backups exist.
      expect(existsSync(filePath)).toBe(true);
      expect(existsSync(rotatedLogPath(filePath, 1))).toBe(true);
      expect(existsSync(rotatedLogPath(filePath, 2))).toBe(true);
      expect(existsSync(rotatedLogPath(filePath, 3))).toBe(false);
      const current = await readLogLines(filePath);
      const first = await readLogLines(rotatedLogPath(filePath, 1));
      const second = await readLogLines(rotatedLogPath(filePath, 2));
      // Every write after the first rotates, so each file keeps one line.
      expect(current).toHaveLength(1);
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect((second[0]?.counts as Record<string, number>).pass).toBe(3);
      expect((first[0]?.counts as Record<string, number>).pass).toBe(4);
      expect((current[0]?.counts as Record<string, number>).pass).toBe(5);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves the existing file size when opening an existing log", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-log-size-"));
    try {
      const filePath = path.join(tempRoot, "hikoutei-log.txt");
      await writeFile(filePath, `${"x".repeat(100)}\n`, "utf8");
      const logger = createHikouteiInternalLogger({
        env: {
          [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: filePath,
          [HIKOUTEI_LOG_ENV_KEYS.LOG_MAX_BYTES]: "4096",
        },
      });
      logger.log({ event: "hikoutei.runtime.opened" });
      await logger.drain();
      const info = await stat(filePath);
      expect(info.size).toBeGreaterThan(101);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("internal file logger fail-open behavior", () => {
  it("never throws and degrades after repeated sink failures", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-log-broken-"));
    try {
      // A directory blocks the file path, so every append fails.
      const blockedPath = path.join(tempRoot, "blocked.txt");
      await mkdir(blockedPath);
      const logger = createHikouteiInternalLogger({
        env: { [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: blockedPath },
      });
      expect(logger.enabled).toBe(true);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(() =>
          logger.log({ event: "hikoutei.em.flush_failed", level: "error" }),
        ).not.toThrow();
        await logger.drain();
      }
      // Degraded after the failure limit: `enabled` flips to false (the
      // interface promises no delivery once the sink degraded) and further
      // log calls are dropped without attempting I/O.
      expect(logger.enabled).toBe(false);
      expect(logger.log({ event: "hikoutei.em.flush_failed", level: "error" })).toBe(false);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("survives a disappearing directory mid-run without throwing", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-log-vanish-"));
    const nested = path.join(tempRoot, "nested");
    await mkdir(nested);
    const filePath = path.join(nested, "hikoutei-log.txt");
    const logger = createHikouteiInternalLogger({
      env: { [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: filePath },
    });
    logger.log({ event: "hikoutei.runtime.opened" });
    await logger.drain();
    await rm(nested, { recursive: true, force: true });
    expect(() =>
      logger.log({ event: "hikoutei.runtime.opened" }),
    ).not.toThrow();
    await logger.drain();
    await rm(tempRoot, { recursive: true, force: true });
  });

  it(
    "never appends through a pre-existing symlink at the log path (fail-open)",
    // Skipped only when the platform/filesystem cannot create symlinks
    // (see the SYMLINK_SUPPORTED probe above for the explicit reason).
    { skip: !SYMLINK_SUPPORTED },
    async () => {
      // Luna regression: the append path must never follow a pre-existing
      // symlink at the log path. The write is rejected fail-open — the
      // external target is never appended to or truncated, the symlink
      // itself stays in place, and logging never throws.
      const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-log-symlink-"));
      try {
        const externalTarget = path.join(tempRoot, "external-target.txt");
        const precious = "operator content that must never change\n";
        await writeFile(externalTarget, precious, "utf8");
        const filePath = path.join(tempRoot, "hikoutei-log.txt");
        await symlink(externalTarget, filePath);

        const logger = createHikouteiInternalLogger({
          env: { [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: filePath },
        });
        expect(() =>
          logger.log({ event: "hikoutei.runtime.opened" }),
        ).not.toThrow();
        await logger.drain();
        // The external target is byte-identical: nothing was appended and
        // nothing was truncated.
        expect(await readFile(externalTarget, "utf8")).toBe(precious);
        // The symlink itself stays in place (the write was rejected, not
        // replaced).
        const linkInfo = await lstat(filePath);
        expect(linkInfo.isSymbolicLink()).toBe(true);
        // Repeated rejections degrade the sink exactly like any other
        // persistent sink failure — never a throw.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          expect(() =>
            logger.log({ event: "hikoutei.runtime.opened" }),
          ).not.toThrow();
          await logger.drain();
        }
        expect(logger.enabled).toBe(false);
        expect(await readFile(externalTarget, "utf8")).toBe(precious);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it(
    "never rotates a symlinked log file into the backup chain",
    // Skipped only when the platform/filesystem cannot create symlinks
    // (see the SYMLINK_SUPPORTED probe above for the explicit reason).
    { skip: !SYMLINK_SUPPORTED },
    async () => {
      // Luna regression: rotation must not move a pre-existing symlink
      // into the backups (which would relabel the operator's link and
      // later appends would silently diverge from it). A symlinked log
      // path whose target already exceeds the rotation threshold is
      // rejected BEFORE rotation: the link stays in place, no backup
      // file is created, and the external target is untouched.
      const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-log-symlink-rot-"));
      try {
        const externalTarget = path.join(tempRoot, "external-target.txt");
        // Larger than the 4 KiB rotation floor, so the size check would
        // trigger rotation on the very first write.
        const oversized = `${"x".repeat(5000)}\n`;
        await writeFile(externalTarget, oversized, "utf8");
        const filePath = path.join(tempRoot, "hikoutei-log.txt");
        await symlink(externalTarget, filePath);

        const logger = createHikouteiInternalLogger({
          env: {
            [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: filePath,
            [HIKOUTEI_LOG_ENV_KEYS.LOG_MAX_BYTES]: "4096",
            [HIKOUTEI_LOG_ENV_KEYS.LOG_BACKUPS]: "2",
          },
        });
        expect(() =>
          logger.log({ event: "hikoutei.runtime.opened" }),
        ).not.toThrow();
        await logger.drain();
        // The external target is byte-identical and no backup exists —
        // the link was never moved into the backup chain.
        expect(await readFile(externalTarget, "utf8")).toBe(oversized);
        expect(existsSync(rotatedLogPath(filePath, 1))).toBe(false);
        expect(existsSync(rotatedLogPath(filePath, 2))).toBe(false);
        expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );
});

describe("internal logger process singleton", () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    resetHikouteiInternalLoggerForTests();
  });

  afterEach(() => {
    resetHikouteiInternalLoggerForTests();
    for (const key of Object.keys(HIKOUTEI_LOG_ENV_KEYS)) {
      const name = HIKOUTEI_LOG_ENV_KEYS[key as keyof typeof HIKOUTEI_LOG_ENV_KEYS];
      const original = savedEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
  });

  it("creates the process logger from process.env once", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-log-proc-"));
    try {
      process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE] = path.join(tempRoot, "proc.txt");
      const first = getHikouteiInternalLogger();
      const second = getHikouteiInternalLogger();
      expect(first).toBe(second);
      expect(first.enabled).toBe(true);
      expect(() =>
        logHikouteiInternalEvent({
          event: HIKOUTEI_LOG_EVENTS.RUNTIME_OPENED,
          component: "runtime",
        }),
      ).not.toThrow();
      await first.drain();
      const lines = await readLogLines(first.filePath ?? "");
      expect(lines.at(-1)?.event).toBe("hikoutei.runtime.opened");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps boundary logging a no-op when the env var is absent", async () => {
    delete process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE];
    const logger: HikouteiInternalLogger = getHikouteiInternalLogger();
    expect(logger.enabled).toBe(false);
    expect(() =>
      logHikouteiInternalEvent({ event: HIKOUTEI_LOG_EVENTS.EM_FLUSH_FAILED }),
    ).not.toThrow();
  });
});
