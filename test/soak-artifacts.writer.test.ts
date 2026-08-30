/**
 * Soak artifact WRITER tests: output-dir writing, reset/atomic checkpoint,
 * symlink rejection, and custom/--log-file rotation collection.
 *
 * Split from soak-artifacts.test.ts (writer and log collection describe group,
 * first half).
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

describe("soak artifacts: writer and log collection", () => {
  it("writes artifacts into the output dir and collects rotated internal logs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      await writer.appendJsonl("cycles", { cycle: 1 });
      await writer.writeJson("state", { version: 1 });
      await writer.writeMarkdown("# summary");
      // Simulate a rotated backup (index 1 = oldest) plus the current file
      // with logger-shaped JSONL lines.
      const oldLine = loggerLine(HIKOUTEI_LOG_EVENTS.RUNTIME_OPENED);
      const newLine = loggerLine(HIKOUTEI_LOG_EVENTS.RUNTIME_CLOSED);
      await writeFile(path.join(dir, "hikoutei-internal-log.1.txt"), oldLine, "utf8");
      await writeFile(path.join(dir, "hikoutei-internal-log.txt"), newLine, "utf8");
      const collected = await writer.collectInternalLog();
      expect(collected.lines).toBe(2);
      const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
      expect(content).toBe(`${oldLine}${newLine}`);
      expect(await readFile(path.join(dir, "summary.md"), "utf8")).toBe("# summary");
      expect(await writer.databaseSizeBytes(path.join(dir, "nope.sqlite"))).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resetRunArtifacts removes only runner-owned JSONL, SQLite, and resume documents", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      await writer.appendJsonl("cycles", { cycle: 1 });
      await writer.appendJsonl("operations", { status: "ok" });
      await writer.appendJsonl("resources", { rssKb: 1 });
      await writer.writeJson("state", { keep: true });
      await writer.writeCheckpoint({ version: 1, runId: "soak-abcd", cycle: 1, status: "completed" });
      // Runner-owned SQLite authority plus sidecars (a stale `-wal` can
      // carry rows from an interrupted previous run and must never
      // survive into a fresh authority).
      await writeFile(path.join(dir, "soak.sqlite"), "SQLite format 3\u0000db-bytes", "utf8");
      await writeFile(path.join(dir, "soak.sqlite-wal"), "wal-payload-bytes", "utf8");
      await writeFile(path.join(dir, "soak.sqlite-journal"), "journal-bytes", "utf8");
      await writeFile(path.join(dir, "soak.sqlite-shm"), "shm-bytes", "utf8");
      // An operator-owned custom file must never be deleted by the reset.
      await writeFile(path.join(dir, "operator-notes.txt"), "keep me", "utf8");
      await writer.resetRunArtifacts();
      const remaining = await readdir(dir);
      for (const name of ["cycles.jsonl", "operations.jsonl", "resources.jsonl",
        "soak.sqlite", "soak.sqlite-wal", "soak.sqlite-journal", "soak.sqlite-shm"]) {
        expect(remaining).not.toContain(name);
      }
      // HIGH 3: state.json and checkpoint.json are REMOVED by a fresh
      // run's reset (never merely overwritten in place), so a crash after
      // the new DB opens but before the first state write can never be
      // resumed as the previous run identity/zero-cycle state.
      expect(remaining).not.toContain("state.json");
      expect(remaining).not.toContain("checkpoint.json");
      // Arbitrary external/custom content is untouched.
      expect(remaining).toContain("operator-notes.txt");
      expect(await readFile(path.join(dir, "operator-notes.txt"), "utf8")).toBe("keep me");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writeCheckpoint writes the marker atomically (temp file + rename)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      const marker: {
        version: number;
        runId: string;
        cycle: number;
        status: "in-flight" | "completed";
      } = { version: 1, runId: "soak-abcd", cycle: 7, status: "in-flight" };
      await writer.writeCheckpoint(marker);
      const stored = JSON.parse(
        await readFile(path.join(dir, "checkpoint.json"), "utf8"),
      );
      expect(stored).toEqual(marker);
      // The temporary staging file is never left behind.
      expect(await readdir(dir)).not.toContain("checkpoint.json.tmp");
      // Advancing the marker overwrites the previous value completely.
      await writer.writeCheckpoint({ ...marker, status: "completed" });
      expect(JSON.parse(
        await readFile(path.join(dir, "checkpoint.json"), "utf8"),
      )).toEqual({ ...marker, status: "completed" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "never follows pre-existing symlinks at JSONL, JSON, checkpoint, markdown, or temp paths",
    // Skipped only when the platform/filesystem cannot create symlinks
    // (see the SYMLINK_SUPPORTED probe above for the explicit reason).
    { skip: !SYMLINK_SUPPORTED },
    async () => {
      // Regression (Luna review): every artifact writer must replace a
      // pre-existing symlink at its artifact or staging path instead of
      // writing THROUGH it — an operator symlink pointing outside the
      // output dir must never redirect a JSONL append, a JSON/checkpoint
      // temp write or rename, or the Markdown summary write, so external
      // operator targets stay byte-identical.
      const root = await mkdtemp(path.join(tmpdir(), "soak-artifacts-symlink-"));
      const dir = path.join(root, "run");
      const externalDir = path.join(root, "external");
      try {
        const writer = createArtifactWriter(dir, () => undefined);
        await writer.ensure();
        await mkdir(externalDir, { recursive: true });
        const precious = "operator data that must never be overwritten\n";
        const plantExternal = async (name: string): Promise<string> => {
          const externalTarget = path.join(externalDir, name);
          await writeFile(externalTarget, precious, "utf8");
          return externalTarget;
        };

        // JSONL stream: a symlink at cycles.jsonl is replaced, never
        // appended through — the external target stays byte-identical.
        const jsonlTarget = await plantExternal("jsonl-target.txt");
        await symlink(jsonlTarget, path.join(dir, "cycles.jsonl"));
        await writer.appendJsonl("cycles", { cycle: 1 });
        expect(await readFile(jsonlTarget, "utf8")).toBe(precious);
        const jsonlPath = path.join(dir, "cycles.jsonl");
        expect(JSON.parse(await readFile(jsonlPath, "utf8"))).toEqual({ cycle: 1 });
        expect((await lstat(jsonlPath)).isSymbolicLink()).toBe(false);
        // Appends keep working on the replaced real file.
        await writer.appendJsonl("cycles", { cycle: 2 });
        const appended = (await readFile(jsonlPath, "utf8")).trim().split("\n")
          .map((line) => JSON.parse(line));
        expect(appended).toEqual([{ cycle: 1 }, { cycle: 2 }]);
        expect(await readFile(jsonlTarget, "utf8")).toBe(precious);

        // JSON document: symlinks at BOTH the staging path and the target
        // path are replaced — the external targets stay byte-identical.
        const stateTempTarget = await plantExternal("state-tmp-target.txt");
        await symlink(stateTempTarget, path.join(dir, "state.json.tmp"));
        const stateTarget = await plantExternal("state-target.txt");
        await symlink(stateTarget, path.join(dir, "state.json"));
        await writer.writeJson("state", { keep: true });
        expect(await readFile(stateTempTarget, "utf8")).toBe(precious);
        expect(await readFile(stateTarget, "utf8")).toBe(precious);
        expect(JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")))
          .toEqual({ keep: true });
        expect((await lstat(path.join(dir, "state.json"))).isSymbolicLink()).toBe(false);
        // The planted staging symlink was never followed and never
        // deleted: it stays in place, still pointing at the untouched
        // external target (the write claims unique staging names now, so
        // a planted `<name>.tmp` entry cannot redirect it).
        expect((await lstat(path.join(dir, "state.json.tmp"))).isSymbolicLink()).toBe(true);
        expect(await readFile(stateTempTarget, "utf8")).toBe(precious);

        // Checkpoint marker: symlinks at BOTH paths are replaced too.
        const checkpointTempTarget = await plantExternal("checkpoint-tmp-target.txt");
        await symlink(checkpointTempTarget, path.join(dir, "checkpoint.json.tmp"));
        const checkpointTarget = await plantExternal("checkpoint-target.txt");
        await symlink(checkpointTarget, path.join(dir, "checkpoint.json"));
        const marker = { version: 1, runId: "soak-abcd", cycle: 7, status: "in-flight" } as const;
        await writer.writeCheckpoint(marker);
        expect(await readFile(checkpointTempTarget, "utf8")).toBe(precious);
        expect(await readFile(checkpointTarget, "utf8")).toBe(precious);
        expect(JSON.parse(await readFile(path.join(dir, "checkpoint.json"), "utf8")))
          .toEqual(marker);
        expect((await lstat(path.join(dir, "checkpoint.json"))).isSymbolicLink()).toBe(false);

        // summary.json (whole-JSON writer): the staging symlink is
        // replaced and the external target stays untouched.
        const summaryTempTarget = await plantExternal("summary-tmp-target.txt");
        await symlink(summaryTempTarget, path.join(dir, "summary.json.tmp"));
        await writer.writeJson("summaryJson", { status: "passed" });
        expect(await readFile(summaryTempTarget, "utf8")).toBe(precious);
        expect(JSON.parse(await readFile(path.join(dir, "summary.json"), "utf8")))
          .toEqual({ status: "passed" });
        // The planted staging symlink stays in place, untouched.
        expect((await lstat(path.join(dir, "summary.json.tmp"))).isSymbolicLink()).toBe(true);
        expect(await readFile(summaryTempTarget, "utf8")).toBe(precious);

        // Markdown summary: a symlink at summary.md is replaced, never
        // written through.
        const markdownTarget = await plantExternal("markdown-target.txt");
        await symlink(markdownTarget, path.join(dir, "summary.md"));
        await writer.writeMarkdown("# summary");
        expect(await readFile(markdownTarget, "utf8")).toBe(precious);
        expect(await readFile(path.join(dir, "summary.md"), "utf8")).toBe("# summary");
        expect((await lstat(path.join(dir, "summary.md"))).isSymbolicLink()).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "claims unique exclusive staging names: planted symlinks can never redirect an atomic write",
    // Skipped only when the platform/filesystem cannot create symlinks
    // (see the SYMLINK_SUPPORTED probe above for the explicit reason).
    { skip: !SYMLINK_SUPPORTED },
    async () => {
      // Luna regression (TOCTOU): the atomic writers no longer rm() a
      // fixed `<name>.tmp` and then writeFile() it — that window let a
      // planted symlink redirect the temp write. Every write claims a
      // UNIQUE staging name (`<name>.tmp-<pid>-<seq>`) with an exclusive
      // no-follow open, so a symlink planted at a staging name fails the
      // open closed (EEXIST/ELOOP) instead of redirecting the write.
      const root = await mkdtemp(path.join(tmpdir(), "soak-artifacts-staging-"));
      const dir = path.join(root, "run");
      const externalDir = path.join(root, "external");
      try {
        const writer = createArtifactWriter(dir, () => undefined);
        await writer.ensure();
        await mkdir(externalDir, { recursive: true });
        const precious = "operator data that must never be overwritten\n";
        const statePath = path.join(dir, "state.json");

        // The FIRST staging name this fresh writer claims is
        // `state.json.tmp-<pid>-1`. A symlink planted there is never
        // followed: the exclusive open fails, the writer claims the next
        // unique name, and the planted link stays untouched.
        const firstStagingTarget = path.join(externalDir, "first-staging-target.txt");
        await writeFile(firstStagingTarget, precious, "utf8");
        await symlink(firstStagingTarget, uniqueStagingPath(statePath, 1));
        // The retired FIXED staging name is never used as a write target
        // either: a symlink planted there is simply never touched.
        const fixedStagingTarget = path.join(externalDir, "fixed-staging-target.txt");
        await writeFile(fixedStagingTarget, precious, "utf8");
        await symlink(fixedStagingTarget, path.join(dir, "state.json.tmp"));

        await writer.writeJson("state", { keep: true });
        expect(await readFile(firstStagingTarget, "utf8")).toBe(precious);
        expect(await readFile(fixedStagingTarget, "utf8")).toBe(precious);
        expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual({ keep: true });
        // The writer left no staging file of its own behind: the only
        // `.tmp`-shaped entries are the two planted symlinks, each still
        // a link whose external target is untouched.
        const plantedFirst = uniqueStagingPath(statePath, 1).split(path.sep).pop()!;
        const stagingEntries = (await readdir(dir))
          .filter((name) => name.startsWith("state.json.tmp"));
        expect(stagingEntries.sort()).toEqual(["state.json.tmp", plantedFirst].sort());
        for (const entry of stagingEntries) {
          expect((await lstat(path.join(dir, entry))).isSymbolicLink()).toBe(true);
        }

        // Adversarial: a FRESH writer whose first atomic write claims
        // sequences 1..N, with symlinks planted at EVERY candidate name,
        // makes the write FAIL CLOSED — the write throws instead of ever
        // writing through a link, and every external target stays
        // byte-identical.
        const blockingWriter = createArtifactWriter(dir, () => undefined);
        const blockedTargets: string[] = [];
        const checkpointPath = path.join(dir, "checkpoint.json");
        for (let sequence = 1; sequence <= 8; sequence += 1) {
          const target = path.join(externalDir, `blocked-${sequence}.txt`);
          await writeFile(target, precious, "utf8");
          await symlink(target, uniqueStagingPath(checkpointPath, sequence));
          blockedTargets.push(target);
        }
        await expect(
          blockingWriter.writeCheckpoint({
            version: 1,
            runId: "soak-abcd",
            cycle: 1,
            status: "in-flight",
          }),
        ).rejects.toThrow();
        for (const target of blockedTargets) {
          expect(await readFile(target, "utf8")).toBe(precious);
        }
        expect((await lstat(uniqueStagingPath(checkpointPath, 1))).isSymbolicLink())
          .toBe(true);
        // The blocked checkpoint never landed.
        expect(await readdir(dir)).not.toContain("checkpoint.json");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "resetRunArtifacts unlinks runner-owned staging and SQLite symlinks without touching their targets",
    // Skipped only when the platform/filesystem cannot create symlinks
    // (see the SYMLINK_SUPPORTED probe above for the explicit reason).
    { skip: !SYMLINK_SUPPORTED },
    async () => {
      // Luna regression: a fresh run's cleanup must unlink ONLY the
      // in-directory runner-owned names — the JSONL streams, the SQLite
      // authority plus sidecars, and the atomic-write staging files
      // (fixed AND unique shapes) — and always by removing the LINK
      // itself, never by writing or deleting through it. Planted symlinks
      // at every runner-owned name must be unlinked while their external
      // targets stay byte-identical.
      const root = await mkdtemp(path.join(tmpdir(), "soak-artifacts-reset-symlink-"));
      const dir = path.join(root, "run");
      const externalDir = path.join(root, "external");
      try {
        const writer = createArtifactWriter(dir, () => undefined);
        await writer.ensure();
        await mkdir(externalDir, { recursive: true });
        const precious = "operator data that must never be overwritten\n";
        const plant = async (name: string): Promise<string> => {
          const target = path.join(externalDir, `target-${name.replace(/[^a-z0-9]/g, "-")}`);
          await writeFile(target, precious, "utf8");
          await symlink(target, path.join(dir, name));
          return target;
        };
        const targets = await Promise.all([
          plant("cycles.jsonl"),
          plant("state.json"),
          plant("checkpoint.json"),
          plant("state.json.tmp"),
          plant(uniqueStagingPath(path.join(dir, "state.json"), 1).split(path.sep).pop()!),
          plant("soak.sqlite"),
          plant("soak.sqlite-wal"),
          plant("soak.sqlite-journal"),
          plant("soak.sqlite-shm"),
        ]);

        await writer.resetRunArtifacts();
        const remaining = await readdir(dir);
        for (const name of ["cycles.jsonl", "state.json", "checkpoint.json",
          "state.json.tmp", "soak.sqlite", "soak.sqlite-wal",
          "soak.sqlite-journal", "soak.sqlite-shm"]) {
          expect(remaining, name).not.toContain(name);
        }
        // The unique staging name is unlinked too (the link itself).
        const uniqueName = uniqueStagingPath(path.join(dir, "state.json"), 1).split(path.sep).pop()!;
        expect(remaining).not.toContain(uniqueName);
        // Every external target stays byte-identical — nothing was ever
        // written or deleted through a link.
        for (const target of targets) {
          expect(await readFile(target, "utf8")).toBe(precious);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("collects a custom --log-file and its rotated backups, oldest first", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    const dir = path.join(root, "run");
    // The custom log lives OUTSIDE the output dir (a true operator-owned
    // external path): collection reads it, a fresh-run reset never deletes
    // it or its rotated backups.
    const logDir = path.join(root, "custom-logs");
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      const customLog = path.join(logDir, "operator-log.txt");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(logDir, { recursive: true });
      const oldest = loggerLine(HIKOUTEI_LOG_EVENTS.RUNTIME_OPENED);
      const older = loggerLine(HIKOUTEI_LOG_EVENTS.RUNTIME_CLOSED);
      const current = loggerLine(HIKOUTEI_LOG_EVENTS.EM_QUERY_FAILED, {
        level: "error",
        code: "invalid_query",
      });
      await writeFile(path.join(logDir, "operator-log.2.txt"), oldest, "utf8");
      await writeFile(path.join(logDir, "operator-log.1.txt"), older, "utf8");
      await writeFile(customLog, current, "utf8");
      // A decoy file that must NOT be collected (not a rotated backup).
      await writeFile(path.join(logDir, "operator-log.notes.txt"), "decoy\n", "utf8");
      const collected = await writer.collectInternalLog({ logFile: customLog });
      expect(collected.lines).toBe(3);
      const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
      expect(content).toBe(`${oldest}${older}${current}`);
      expect(content).not.toContain("decoy");
      // Custom EXTERNAL log paths are operator-owned: a fresh-run reset
      // never deletes them or their rotated backups.
      const reset = await writer.resetLoggerFiles({ logFile: customLog });
      expect(reset.removed).toBe(0);
      expect(await readFile(customLog, "utf8")).toBe(current);
      expect(await readFile(path.join(logDir, "operator-log.1.txt"), "utf8")).toBe(older);
      expect(await readFile(path.join(logDir, "operator-log.2.txt"), "utf8")).toBe(oldest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a blank log path as disabled: collection is empty and reset clears nothing", async () => {
    // Regression (Luna review): a blank/whitespace HIKOUTEI_LOG_FILE means
    // the library logger is DISABLED — it must never be trimmed into an
    // empty path and normalized to a bare `.txt` that collection would
    // read or reset would delete.
    expect(normalizeSoakLogFilePath("   ")).toBeUndefined();
    expect(normalizeSoakLogFilePath("\t")).toBeUndefined();
    expect(normalizeSoakLogFilePath("")).toBeUndefined();

    const dir = await mkdtemp(path.join(tmpdir(), "soak-artifacts-"));
    try {
      const writer = createArtifactWriter(dir, () => undefined);
      await writer.ensure();
      // A decoy bare `.txt` in the cwd of the old normalization bug must
      // never be read or removed.
      await writeFile(path.join(dir, ".txt"), "decoy\n", "utf8");
      const collected = await writer.collectInternalLog({ logFile: " \t " });
      expect(collected.lines).toBe(0);
      const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
      expect(content).toBe("");
      const reset = await writer.resetLoggerFiles({ logFile: "   " });
      expect(reset.removed).toBe(0);
      expect(await readFile(path.join(dir, ".txt"), "utf8")).toBe("decoy\n");
      expect(await readdir(dir)).toEqual(expect.arrayContaining([".txt"]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it(
    "never reads or deletes through a symlinked log directory or file escaping the output dir",
    // Skipped only when the platform/filesystem cannot create symlinks
    // (see the SYMLINK_SUPPORTED probe above for the explicit reason).
    { skip: !SYMLINK_SUPPORTED },
    async () => {
      // Regression (Luna review): containment must hold by REAL path too.
      // A log path that is lexically inside the output dir but resolves
      // through a symlink to an external location is not logger-owned:
      // collection must not read the external files and reset must not
      // delete them.
      const root = await mkdtemp(path.join(tmpdir(), "soak-artifacts-symlink-"));
      const dir = path.join(root, "run");
      const externalDir = path.join(root, "external");
      try {
        const writer = createArtifactWriter(dir, () => undefined);
        await writer.ensure();
        await mkdir(externalDir, { recursive: true });
        const externalLine = loggerLine(HIKOUTEI_LOG_EVENTS.RUNTIME_OPENED);
        // External files that merely share the logger's ownership pattern.
        await writeFile(path.join(externalDir, "hikoutei-internal-log.txt"), externalLine, "utf8");
        await writeFile(path.join(externalDir, "hikoutei-internal-log.1.txt"), externalLine, "utf8");
        await writeFile(path.join(externalDir, "operator-notes.txt"), "keep me\n", "utf8");
        // A symlinked log subdirectory INSIDE the output dir pointing OUTSIDE.
        await symlink(externalDir, path.join(dir, "logs"));
        const escapedLog = path.join(dir, "logs", "hikoutei-internal-log.txt");

        const collected = await writer.collectInternalLog({ logFile: escapedLog });
        expect(collected.lines).toBe(0);
        const content = await readFile(path.join(dir, "collected-log.txt"), "utf8");
        expect(content).toBe("");
        expect(content).not.toContain("hikoutei.runtime.opened");

        const reset = await writer.resetLoggerFiles({ logFile: escapedLog });
        expect(reset.removed).toBe(0);
        // The external files are untouched — neither read nor deleted.
        expect(await readFile(path.join(externalDir, "hikoutei-internal-log.txt"), "utf8"))
          .toBe(externalLine);
        expect(await readFile(path.join(externalDir, "hikoutei-internal-log.1.txt"), "utf8"))
          .toBe(externalLine);
        expect(await readFile(path.join(externalDir, "operator-notes.txt"), "utf8")).toBe("keep me\n");

        // File-level escape: the default log path itself is a symlink to
        // an external file; collection must not read through it either.
        await symlink(
          path.join(externalDir, "hikoutei-internal-log.txt"),
          path.join(dir, "hikoutei-internal-log.txt"),
        );
        const defaultCollected = await writer.collectInternalLog();
        expect(defaultCollected.lines).toBe(0);
        const defaultContent = await readFile(path.join(dir, "collected-log.txt"), "utf8");
        expect(defaultContent).toBe("");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it(
    "replaces a pre-existing symlink at collected-log.txt instead of writing through it",
    // Skipped only when the platform/filesystem cannot create symlinks
    // (see the SYMLINK_SUPPORTED probe above for the explicit reason).
    { skip: !SYMLINK_SUPPORTED },
    async () => {
      // Regression (Luna review): a symlink planted at the reserved
      // `collected-log.txt` name must never be FOLLOWED — the external
      // target is operator-owned and must stay byte-identical, even for
      // the blank-log-path (logging disabled) empty collection. The
      // collection replaces the link itself with a regular file via
      // atomic temp write + rename.
      const root = await mkdtemp(path.join(tmpdir(), "soak-artifacts-symlink-"));
      const dir = path.join(root, "run");
      const externalDir = path.join(root, "external");
      try {
        const writer = createArtifactWriter(dir, () => undefined);
        await writer.ensure();
        await mkdir(externalDir, { recursive: true });
        const externalTarget = path.join(externalDir, "operator-target.txt");
        const precious = "operator data that must never be overwritten\n";
        await writeFile(externalTarget, precious, "utf8");
        const collectedPath = path.join(dir, "collected-log.txt");

        // Blank log path (logging disabled): the empty collection must
        // REPLACE the planted symlink, never write through it.
        await symlink(externalTarget, collectedPath);
        const blank = await writer.collectInternalLog({ logFile: "   " });
        expect(blank.lines).toBe(0);
        expect(await readFile(externalTarget, "utf8")).toBe(precious);
        expect(await readFile(collectedPath, "utf8")).toBe("");
        const blankStat = await lstat(collectedPath);
        expect(blankStat.isSymbolicLink()).toBe(false);
        expect(blankStat.isFile()).toBe(true);

        // A real collection behaves the same: the planted link is
        // replaced, the external target is untouched.
        await rm(collectedPath, { force: true });
        await symlink(externalTarget, collectedPath);
        const logLine = loggerLine(HIKOUTEI_LOG_EVENTS.RUNTIME_OPENED);
        await writeFile(path.join(dir, "hikoutei-internal-log.txt"), logLine, "utf8");
        const collected = await writer.collectInternalLog();
        expect(collected.lines).toBe(1);
        expect(await readFile(externalTarget, "utf8")).toBe(precious);
        expect(await readFile(collectedPath, "utf8")).toBe(logLine);
        expect((await lstat(collectedPath)).isSymbolicLink()).toBe(false);

        // A symlink planted at the STAGING name cannot redirect the temp
        // write either: it is unlinked (the link itself, never its
        // target) before the fresh temp file is written.
        await rm(collectedPath, { force: true });
        const stagingTarget = path.join(externalDir, "staging-target.txt");
        await writeFile(stagingTarget, precious, "utf8");
        await symlink(stagingTarget, path.join(dir, "collected-log.txt.tmp"));
        await writer.collectInternalLog();
        expect(await readFile(stagingTarget, "utf8")).toBe(precious);
        expect(await readFile(collectedPath, "utf8")).toBe(logLine);
        expect((await lstat(collectedPath)).isSymbolicLink()).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
