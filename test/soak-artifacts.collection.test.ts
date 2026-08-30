/**
 * Soak LOG COLLECTION tests: canonical backup matching/retention, SQLite
 * exclusion, and malicious/whitespace/extension normalization of collected logs.
 *
 * Split from soak-artifacts.test.ts (writer and log collection describe group,
 * second half).
 */
import { describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createArtifactWriter,
  cycleRecord,
  normalizeSoakLogFilePath,
  operationRecord,
  renderSummaryMarkdown,
  resourceRecord,
  uniqueStagingPath,
} from "../scripts/ci/local-soak/artifacts.mjs";
import {
  createHikouteiInternalLogger,
  HIKOUTEI_LOG_ENV_KEYS,
} from "@hikoutei/sync-engine/shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
  HIKOUTEI_LOG_STABLE_CLASSES,
  HIKOUTEI_LOG_STABLE_CODES,
} from "@hikoutei/sync-engine/shared/observability/logEvents.js";
import {
  LOGGED_COMPONENT_NAMES,
  LOGGED_EVENT_NAMES,
  LOGGED_FIELD_NAMES,
  LOGGED_LEVELS,
  LOGGED_STABLE_CLASSES as LOGGED_CLASS_MIRROR,
  LOGGED_STABLE_CODES as LOGGED_CODE_MIRROR,
  sanitizeCollectedLogLine,
} from "../scripts/ci/local-soak/logLines.mjs";

/** One logger-shaped JSONL line for collection tests. */
function loggerLine(event: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event, ...extra })}\n`;
}

/**
 * True when the platform can create symlinks (used to skip the symlink
 * escape test with an explicit reason on filesystems that cannot).
 */
const SYMLINK_SUPPORTED = (() => {
  const probeDir = mkdtempSync(path.join(tmpdir(), "soak-symlink-probe-"));
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

describe("soak artifacts: log collection", () => {
  it("collects and resets ONLY canonical logger-created backups: never .0, leading-zero, or beyond-retention files", async () => {
    // Regression (Luna review): backup matching must accept exactly the
    // index shape the library rotation produces — canonical positive
    // decimals 1..retention. `.0.txt`, `.01.txt`, `.007.txt`, and numeric
    // files beyond the retention are operator/decoy files: they are
    // never read into the collection and never deleted by a fresh-run
    // reset.
    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      const line = (pass: number) => loggerLine(HIKOUTEI_LOG_EVENTS.OUTBOX_PASS_SUMMARY, {
        counts: { pass },
      });
      const current = line(0);
      await writeFile(path.join(dir, "hikoutei-internal-log.txt"), current, "utf8");
      // Collection order is oldest-first (highest rotated index first),
      // matching the existing collection contract.
      const expected = [];
      for (let index = 5; index >= 1; index -= 1) {
        const content = line(index);
        await writeFile(path.join(dir, `hikoutei-internal-log.${index}.txt`), content, "utf8");
        expected.push(content);
      }
      expected.push(current);
      // Decoy files that must never be matched (valid logger-shaped
      // lines on purpose: if they were read, the collection would grow).
      const decoys = ["hikoutei-internal-log.0.txt", "hikoutei-internal-log.01.txt",
        "hikoutei-internal-log.007.txt", "hikoutei-internal-log.6.txt",
        "hikoutei-internal-log.999.txt", "hikoutei-internal-log.txt.bak"];
      for (const name of decoys) {
        await writeFile(path.join(dir, name), line(99), "utf8");
      }
      // An operator file that merely shares the base name.
      await writeFile(path.join(dir, "hikoutei-internal-log.notes.txt"), "operator notes\n", "utf8");

      const collected = await writer.collectInternalLog();
      expect(collected.lines).toBe(6); // current + 5 canonical backups
      const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
      expect(content).toBe(expected.join(""));
      for (const name of decoys) {
        expect(content, name).not.toContain(`"pass":99`);
      }
      expect(content).not.toContain("operator notes");

      // The fresh-run reset removes exactly the current file + canonical
      // backups; every decoy and operator file survives byte-identical.
      const reset = await writer.resetLoggerFiles();
      expect(reset.removed).toBe(6);
      const remaining = await readdir(dir);
      for (const name of ["hikoutei-internal-log.txt", ...Array.from({ length: 5 }, (_, i) => `hikoutei-internal-log.${i + 1}.txt`)]) {
        expect(remaining).not.toContain(name);
      }
      for (const name of decoys) {
        expect(remaining, name).toContain(name);
        expect(await readFile(path.join(dir, name), "utf8")).toBe(line(99));
      }
      expect(remaining).toContain("hikoutei-internal-log.notes.txt");
      expect(await readFile(path.join(dir, "hikoutei-internal-log.notes.txt"), "utf8"))
        .toBe("operator notes\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never matches backups whose base-name or suffix case differs from the logger's canonical shape", async () => {
    // Regression (Luna review): backup matching is EXACT-case. The logger
    // always writes the lowercase `.txt` suffix and preserves only the
    // configured path's base-name case, so an operator file that differs
    // by base-name case (`HIKOUTEI-INTERNAL-LOG.3.txt`) or suffix case
    // (`hikoutei-internal-log.2.TXT`) is never a logger-created backup:
    // it is never read into the collection and never deleted by a
    // fresh-run reset. Retention is pinned to 9 so the variant indices
    // sit INSIDE the retention window — only the exact-case rule can
    // exclude them — while the distinct indices (2/3/4) keep the
    // variants distinct files even on case-insensitive filesystems (where
    // a name differing ONLY by case from an existing file would alias
    // it).
    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      const line = (pass: number) => loggerLine(HIKOUTEI_LOG_EVENTS.OUTBOX_PASS_SUMMARY, {
        counts: { pass },
      });
      const current = line(0);
      const canonicalBackup = line(1);
      await writeFile(path.join(dir, "hikoutei-internal-log.txt"), current, "utf8");
      await writeFile(path.join(dir, "hikoutei-internal-log.1.txt"), canonicalBackup, "utf8");
      const caseVariants = [
        "hikoutei-internal-log.2.TXT", // suffix case differs
        "HIKOUTEI-INTERNAL-LOG.3.txt", // base name case differs
        "Hikoutei-Internal-Log.4.TXT", // base AND suffix case differ
      ];
      for (const name of caseVariants) {
        await writeFile(path.join(dir, name), line(99), "utf8");
      }

      const collected = await writer.collectInternalLog({ backups: 9 });
      expect(collected.lines).toBe(2); // current + canonical .1.txt only
      const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
      expect(content).toBe(`${canonicalBackup}${current}`);
      expect(content).not.toContain('"pass":99');

      const reset = await writer.resetLoggerFiles({ backups: 9 });
      expect(reset.removed).toBe(2);
      const remaining = await readdir(dir);
      expect(remaining).not.toContain("hikoutei-internal-log.txt");
      expect(remaining).not.toContain("hikoutei-internal-log.1.txt");
      for (const name of caseVariants) {
        expect(remaining, name).toContain(name);
        expect(await readFile(path.join(dir, name), "utf8")).toBe(line(99));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("honors a pinned retention: beyond-retention and zero-retention backups are never matched", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      const line = (pass: number) => loggerLine(HIKOUTEI_LOG_EVENTS.OUTBOX_PASS_SUMMARY, {
        counts: { pass },
      });
      await writeFile(path.join(dir, "hikoutei-internal-log.txt"), line(0), "utf8");
      for (let index = 1; index <= 3; index += 1) {
        await writeFile(path.join(dir, `hikoutei-internal-log.${index}.txt`), line(index), "utf8");
      }

      // Retention 2: index 3 is beyond the retention and stays untouched.
      const collected = await writer.collectInternalLog({ backups: 2 });
      expect(collected.lines).toBe(3); // current + .1 + .2
      const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
      expect(content).toContain('"pass":0');
      expect(content).toContain('"pass":1');
      expect(content).toContain('"pass":2');
      expect(content).not.toContain('"pass":3');
      const reset = await writer.resetLoggerFiles({ backups: 2 });
      expect(reset.removed).toBe(3);
      expect(await readdir(dir)).toContain("hikoutei-internal-log.3.txt");

      // Retention 0 (the logger truncates, creating no backups at all):
      // only the current file matches; every backup is an operator file.
      await writeFile(path.join(dir, "hikoutei-internal-log.txt"), line(0), "utf8");
      await writeFile(path.join(dir, "hikoutei-internal-log.1.txt"), line(1), "utf8");
      await writeFile(path.join(dir, "hikoutei-internal-log.2.txt"), line(2), "utf8");
      await writeFile(path.join(dir, "hikoutei-internal-log.3.txt"), line(3), "utf8");
      const zeroReset = await writer.resetLoggerFiles({ backups: 0 });
      expect(zeroReset.removed).toBe(1);
      const afterZero = await readdir(dir);
      for (const name of ["hikoutei-internal-log.1.txt", "hikoutei-internal-log.2.txt", "hikoutei-internal-log.3.txt"]) {
        expect(afterZero, name).toContain(name);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves the retention from HIKOUTEI_LOG_BACKUPS exactly like the library logger", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    const prior = process.env.HIKOUTEI_LOG_BACKUPS;
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      const line = (pass: number) => loggerLine(HIKOUTEI_LOG_EVENTS.OUTBOX_PASS_SUMMARY, {
        counts: { pass },
      });
      await writeFile(path.join(dir, "hikoutei-internal-log.txt"), line(0), "utf8");
      await writeFile(path.join(dir, "hikoutei-internal-log.1.txt"), line(1), "utf8");
      await writeFile(path.join(dir, "hikoutei-internal-log.2.txt"), line(2), "utf8");
      await writeFile(path.join(dir, "hikoutei-internal-log.3.txt"), line(3), "utf8");

      // Operator retention of 2 mirrors the library logger's own env
      // parse: indices 1..2 are logger-owned, index 3 is not.
      process.env.HIKOUTEI_LOG_BACKUPS = "2";
      const collected = await writer.collectInternalLog();
      expect(collected.lines).toBe(3);
      const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
      expect(content).not.toContain('"pass":3');
      const reset = await writer.resetLoggerFiles();
      expect(reset.removed).toBe(3);
      expect(await readdir(dir)).toContain("hikoutei-internal-log.3.txt");

      // Malformed env values fall back to the default retention (5), the
      // logger's fail-open contract.
      process.env.HIKOUTEI_LOG_BACKUPS = "banana";
      await writeFile(path.join(dir, "hikoutei-internal-log.txt"), line(0), "utf8");
      const fallbackReset = await writer.resetLoggerFiles();
      expect(fallbackReset.removed).toBe(2); // current + canonical .1/.2 again
    } finally {
      if (prior === undefined) delete process.env.HIKOUTEI_LOG_BACKUPS;
      else process.env.HIKOUTEI_LOG_BACKUPS = prior;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never collects SQLite database, WAL, or journal files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      // Simulated database sidecar files next to the real txt log.
      await writeFile(path.join(dir, "soak.sqlite"), "SQLite format 3\u0000db-bytes", "utf8");
      await writeFile(path.join(dir, "soak.sqlite-wal"), "wal-payload-bytes", "utf8");
      await writeFile(path.join(dir, "soak.sqlite-journal"), "journal-bytes", "utf8");
      const logLine = loggerLine(HIKOUTEI_LOG_EVENTS.OUTBOX_PASS_SUMMARY, { counts: { applied: 1 } });
      await writeFile(path.join(dir, "hikoutei-internal-log.txt"), logLine, "utf8");
      const collected = await writer.collectInternalLog();
      expect(collected.lines).toBe(1);
      const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
      expect(content).toBe(logLine);
      expect(content).not.toContain("SQLite");
      expect(content).not.toContain("wal");
      expect(content).not.toContain("journal");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops malicious pre-existing log/backup content instead of byte-copying it", async () => {
    // Regression: a pre-existing file that merely shares the log name (a
    // leftover backup, an operator note, an attacker-placed file) must
    // never have its content byte-copied into collected-log.txt. Every
    // line must validate against the logger's JSONL shape; non-JSON text
    // and crafted JSONL with secret-bearing values are dropped.
    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      const secrets = [
        "ya29.jwt-abcdefghijklmnop",
        "service@project.iam.gserviceaccount.com",
        "https://docs.google.com/spreadsheets/d/1AbC/edit",
        "/Users/me/.config/gcloud/application_default_credentials.json",
      ];
      const maliciousBackup = [
        ...secrets,
        "not json at all",
        // Crafted JSONL: unknown free-form field, non-allowlisted component,
        // non-allowlisted code, and non-allowlisted event must all be
        // rejected as lines.
        JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event: "hikoutei.runtime.opened", message: secrets[0] }),
        JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event: "hikoutei.runtime.opened", component: secrets[0] }),
        JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event: "hikoutei.runtime.opened", code: secrets[0] }),
        JSON.stringify({ ts: "2025-01-01T00:00:00.000Z", level: "info", event: "hikoutei.evil.event_name" }),
      ].join("\n") + "\n";
      await writeFile(path.join(dir, "hikoutei-internal-log.1.txt"), maliciousBackup, "utf8");
      const genuine = loggerLine(HIKOUTEI_LOG_EVENTS.RUNTIME_CLOSED);
      await writeFile(path.join(dir, "hikoutei-internal-log.txt"), genuine, "utf8");
      const collected = await writer.collectInternalLog();
      expect(collected.lines).toBe(1);
      const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
      expect(content).toBe(genuine);
      for (const secret of secrets) {
        expect(content).not.toContain(secret);
      }
      expect(content).not.toContain("message");
      expect(content).not.toContain("evil");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("trims whitespace-padded custom log paths exactly like the logger before collecting", async () => {
    // The library logger trims HIKOUTEI_LOG_FILE before normalizing the
    // extension; the collector must follow the same rule so a padded
    // --log-file still reads the real file (and its rotated backups).
    expect(normalizeSoakLogFilePath("  operator-log  ")).toBe("operator-log.txt");
    expect(normalizeSoakLogFilePath("  operator-log.txt\t")).toBe("operator-log.txt");

    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    const logDir = path.join(dir, "custom-logs");
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      const { mkdir } = await import("node:fs/promises");
      await mkdir(logDir, { recursive: true });
      const line = loggerLine(HIKOUTEI_LOG_EVENTS.RUNTIME_OPENED);
      // The logger itself trims: a padded extensionless path writes to the
      // trimmed `operator-log.txt`, and the collector must read that file.
      await writeFile(path.join(logDir, "operator-log.txt"), line, "utf8");
      const collected = await writer.collectInternalLog({
        logFile: `  ${path.join(logDir, "operator-log")}  `,
      });
      expect(collected.lines).toBe(1);
      const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
      expect(content).toBe(line);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("normalizes extensionless custom log paths to .txt before collecting", async () => {
    expect(normalizeSoakLogFilePath("operator-log")).toBe("operator-log.txt");
    expect(normalizeSoakLogFilePath("deep/nested/operator-log")).toBe("deep/nested/operator-log.txt");
    expect(normalizeSoakLogFilePath("operator-log.txt")).toBe("operator-log.txt");
    expect(normalizeSoakLogFilePath("operator-log.TXT")).toBe("operator-log.TXT");

    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    const logDir = path.join(dir, "custom-logs");
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      // The library logger normalizes the extensionless path itself; the
      // collector must follow the same rule to read the real file and its
      // rotated backups.
      const extensionless = path.join(logDir, "operator-log");
      const logger = createHikouteiInternalLogger({
        env: {
          [HIKOUTEI_LOG_ENV_KEYS.LOG_FILE]: extensionless,
          [HIKOUTEI_LOG_ENV_KEYS.LOG_BACKUPS]: "2",
          [HIKOUTEI_LOG_ENV_KEYS.LOG_MAX_BYTES]: "4096",
        },
      });
      for (let pass = 0; pass < 3; pass += 1) {
        logger.log({ event: "hikoutei.outbox.pass_summary", counts: { pass } });
        await logger.drain();
      }
      // The logger wrote to the NORMALIZED path (current + rotated).
      const normalized = path.join(logDir, "operator-log.txt");
      const collected = await writer.collectInternalLog({ logFile: extensionless });
      expect(collected.lines).toBe(3);
      const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
      for (const line of content.split("\n").filter((entry) => entry.trim() !== "")) {
        expect(JSON.parse(line).event).toBe("hikoutei.outbox.pass_summary");
      }
      expect(content).toContain('"pass":0');
      expect(content).toContain('"pass":2');
      void normalized;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
