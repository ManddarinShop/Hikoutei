/**
 * Soak artifact writers and collectors.
 *
 * All artifacts are redacted by construction: only cycle-level counters,
 * statuses, durations, and sanitized table names are recorded. Field values,
 * entity ids, spreadsheet IDs/URLs, and error messages never enter them.
 * The collected log concatenates ONLY validated logger-shaped JSONL lines
 * (current + rotated backups): every line must match the library logger's
 * allowed event/field/redaction shape (see `logLines.mjs`), so a
 * pre-existing arbitrary `.txt` or backup file can never be byte-copied
 * into the collection. SQLite database/WAL/journal files are explicitly
 * never collected.
 */

import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { sanitizeCollectedLogLine } from "./logLines.mjs";
import {
  sanitizeCounts,
  sanitizeReason,
  sanitizeRecordFields,
  sanitizeStableCode,
  sanitizeTableName,
} from "./redact.mjs";
import { sanitizeScenarioRecord } from "./scenarios/scenarioVocabulary.mjs";

/** Artifact file names inside the output directory. */
export const ARTIFACT_NAMES = Object.freeze({
  cycles: "cycles.jsonl",
  operations: "operations.jsonl",
  resources: "resources.jsonl",
  state: "state.json",
  // Atomic per-cycle recovery marker: "in-flight" before a cycle's SQLite
  // mutations, "completed" only after its cycle record + state checkpoint
  // landed. Resume validates it to distinguish an interrupted cycle from a
  // clean handoff (see runner.mjs planResumeRecovery).
  checkpoint: "checkpoint.json",
  summaryJson: "summary.json",
  summaryMd: "summary.md",
  collectedLog: "collected-log.txt",
  internalLog: "hikoutei-internal-log.txt",
});

/**
 * Creates the artifact writer bound to one output directory.
 *
 * @param {string} outputDir absolute or relative output directory.
 * @param {(message: string) => void} progress stderr progress sink.
 */
export function createArtifactWriter(outputDir, progress) {
  const dir = path.resolve(outputDir);
  const paths = Object.fromEntries(
    Object.entries(ARTIFACT_NAMES).map(([key, name]) => [key, path.join(dir, name)]),
  );
  // Per-writer staging sequence: every atomic write claims a FRESH unique
  // staging name (`<name>.tmp-<pid>-<seq>`), so two writers in one output
  // dir can never collide on a fixed `<name>.tmp` path, and a symlink
  // planted at any one staging name fails the exclusive open closed
  // (EEXIST/ELOOP) instead of redirecting the write. The fixed
  // `<name>.tmp` names are retired as write targets; stale fixed and
  // unique staging leftovers are both removed by resetRunArtifacts.
  let stagingSequence = 0;
  const nextStagingPath = (targetPath) => uniqueStagingPath(targetPath, ++stagingSequence);
  return {
    dir,
    paths,
    /** Ensures the output directory exists. */
    async ensure() {
      await mkdir(dir, { recursive: true });
    },
    /**
     * Appends one JSONL record (single line) without ever following a
     * pre-existing symlink at the stream path.
     *
     * The stream is opened with `O_NOFOLLOW` after any pre-existing
     * symlink at the artifact name is removed (the link itself, never its
     * target), so an operator symlink pointing outside the output dir is
     * replaced by a real file inside it — the external target is never
     * appended to.
     */
    async appendJsonl(key, record) {
      await appendNoFollow(paths[key], `${JSON.stringify(record)}\n`);
    },
    /**
     * Atomically writes one whole JSON document (unique staging name,
     * exclusive no-follow open, fsync, rename).
     *
     * Atomic for every artifact, but the recovery contract depends on it
     * for `state.json`: rename() is atomic on POSIX, so a reader (or a
     * resumed run) can never observe a half-written state — a process
     * interruption mid-write leaves the PREVIOUS complete state in place,
     * never a truncated file that would silently restart or corrupt a
     * resume. Mirrors writeCheckpoint().
     *
     * Symlink-safe by construction: every write claims a UNIQUE staging
     * name (`<name>.tmp-<pid>-<seq>`) opened with `O_EXCL` (plus
     * `O_NOFOLLOW` where the platform provides it), so a pre-planted
     * symlink at a staging name — fixed or unique — can never redirect
     * the temp write: the exclusive open fails closed (EEXIST/ELOOP)
     * instead of following it, and the next unique name is claimed. The
     * content is written and fsynced through the opened handle before
     * the handle closes, and the final rename() swaps the destination
     * entry itself — a pre-existing symlink at the artifact name is
     * replaced, never followed — so an external operator target can
     * never be overwritten.
     */
    async writeJson(key, value) {
      await atomicWrite(paths[key], `${JSON.stringify(value, null, 2)}\n`, () => nextStagingPath(paths[key]));
    },
    /**
     * Atomically writes the checkpoint marker (unique staging name,
     * exclusive no-follow open, fsync, rename).
     *
     * The marker is the recovery contract's durable in-flight/completed
     * record: rename() is atomic on POSIX, so a reader can never observe a
     * half-written marker. Written BEFORE a cycle's SQLite mutations
     * (`in-flight`) and advanced ONLY after the cycle record + state
     * checkpoint landed (`completed`). Symlink-safe like writeJson(): the
     * unique staging name is claimed with an exclusive no-follow open and
     * the rename replaces any pre-existing symlink at the marker name.
     */
    async writeCheckpoint(marker) {
      await atomicWrite(paths.checkpoint, `${JSON.stringify(marker)}\n`, () => nextStagingPath(paths.checkpoint));
    },
    /**
     * Writes the Markdown summary without ever following a pre-existing
     * symlink at the artifact name: the link itself is removed first and
     * the write is opened with `O_NOFOLLOW`, so an operator symlink
     * pointing outside the output dir is replaced by a real file inside
     * it — the external target is never overwritten.
     */
    async writeMarkdown(value) {
      await writeNoFollow(paths.summaryMd, value);
    },
    /**
     * Collects the internal library log (current + rotated `.txt` backups,
     * oldest first) into `collected-log.txt`.
     *
     * `logFile` is the EFFECTIVE log path the runner pinned (a custom
     * `--log-file` or the default inside the output dir), so a custom log
     * and its rotated backups are collected too. Custom paths are trimmed
     * of surrounding whitespace and extensionless forms are normalized to
     * `.txt` first, mirroring the library logger's exact path handling
     * (trim then `ensureTxtExtension`), so the collector always reads the
     * file the logger actually wrote. Only `.txt` files are ever read;
     * SQLite database/WAL/journal files are never collected. Every line
     * must validate against the logger's JSONL shape (allowlisted
     * event/component/code/class, known fields, finite counts); invalid or
     * secret-bearing lines — including arbitrary pre-existing files that
     * merely share the log name — are DROPPED, never byte-copied.
     *
     * Backup matching accepts ONLY canonical logger-created indices:
     * `<base>.<N>.txt` with N the canonical positive decimal integer in
     * [1, retention] — the exact index shape the library rotation
     * produces — and is EXACT-case: the logger always appends a lowercase
     * `.txt` suffix and preserves only the configured path's base-name
     * case, so operator files that differ by base-name case or suffix
     * case (`HIKOUTEI-INTERNAL-LOG.1.txt`, `hikoutei-internal-log.1.TXT`)
     * are never matched. `.0.txt`, leading-zero `.01.txt`, and arbitrary
     * numeric files beyond the configured retention are never read either
     * (an operator file that merely shares the base name stays
     * untouched). The retention defaults to the library's effective
     * `HIKOUTEI_LOG_BACKUPS` (mirror of the logger contract: default 5,
     * 0 = truncate, max 20); pass `backups` to pin a different retention.
     *
     * Path isolation: a BLANK/whitespace log path means logging was
     * disabled (the library logger never normalizes blank to `.txt`) and
     * the collection is empty. The reserved `collected-log.txt` is
     * written atomically (temp file + rename), so a pre-existing symlink
     * at that name is REPLACED, never followed — an external operator
     * target can never be overwritten. A log path that is lexically
     * inside the
     * output dir must ALSO be contained by real path — a symlinked log
     * directory or log file resolving outside the REAL output dir is not
     * logger-owned and is never read, so collection can never touch an
     * unintended external file. Lexically external custom `--log-file`
     * paths stay operator-intended and are collected as-is.
     */
    async collectInternalLog({ logFile, backups } = {}) {
      const retention = backups ?? resolveLogRetention();
      const normalized = normalizeSoakLogFilePath(logFile ?? paths.internalLog);
      if (normalized === undefined) {
        // A blank/whitespace `HIKOUTEI_LOG_FILE` means the library logger
        // is DISABLED (it never normalizes blank to a bare `.txt`): nothing
        // was logged, so the collection is empty and no file is touched.
        await writeCollectedLogAtomic(
          paths.collectedLog,
          "",
          () => nextStagingPath(paths.collectedLog),
        );
        progress(`collected 0 internal log lines into ${ARTIFACT_NAMES.collectedLog}`);
        return { lines: 0 };
      }
      const logPath = path.resolve(normalized);
      const logDir = path.dirname(logPath);
      const baseName = path.basename(logPath).replace(/\.txt$/i, "");
      const pieces = [];
      const backupsFound = [];
      const dirEntries = await readdir(logDir).catch(() => []);
      for (const entry of dirEntries) {
        const index = rotatedBackupIndex(baseName, entry, retention);
        if (index !== undefined) backupsFound.push({ index, entry });
      }
      backupsFound.sort((left, right) => right.index - left.index); // highest index = oldest
      // Containment: custom EXTERNAL log paths are operator-intended and
      // read as-is; a log path that is lexically inside the output dir must
      // ALSO be contained by real path — a symlinked log directory or log
      // file that resolves outside the REAL output dir is not logger-owned
      // and is never read, so collection can never touch an unintended
      // external file.
      const containment = await resolveLogContainment(logPath, dir);
      const mayRead = async (candidate) => {
        // Lexically external custom paths are operator-intended: read as-is.
        if (!containment.lexicallyInside) return true;
        // A symlink-escaping log dir is not logger-owned: never read it.
        if (!containment.realContained) return false;
        const realCandidate = await realpath(candidate).catch(() => undefined);
        return realCandidate !== undefined &&
          (realCandidate === containment.realDir ||
            realCandidate.startsWith(`${containment.realDir}${path.sep}`));
      };
      for (const { entry } of backupsFound) {
        const candidate = path.join(logDir, entry);
        if (await mayRead(candidate)) {
          pieces.push(...await readValidLogLines(candidate));
        }
      }
      if (await mayRead(logPath)) {
        pieces.push(...await readValidLogLines(logPath));
      }
      const collected = pieces.join("");
      // Atomic temp + rename (unique exclusive staging name): replaces a
      // pre-existing symlink at the reserved name instead of writing
      // through it.
      await writeCollectedLogAtomic(
        paths.collectedLog,
        collected,
        () => nextStagingPath(paths.collectedLog),
      );
      const lines = collected.split("\n").filter((line) => line.trim() !== "").length;
      progress(`collected ${lines} internal log lines into ${ARTIFACT_NAMES.collectedLog}`);
      return { lines };
    },
    /** Reads the SQLite database size for resource sampling (never copied). */
    async databaseSizeBytes(dbPath) {
      const info = await stat(dbPath).catch(() => undefined);
      return info?.size ?? 0;
    },
    /**
     * Removes runner-owned per-run artifacts when starting a FRESH run so a
     * reused output directory can never leak prior cycle history, a
     * previous run identity, stale SQLite rows, or old resume documents
     * into the new run.
     *
     * Only files the runner itself owns are removed: the per-run JSONL
     * streams (`cycles.jsonl`, `operations.jsonl`, `resources.jsonl`), the
     * SQLite authority file plus its sidecars (`soak.sqlite`,
     * `soak.sqlite-wal`, `soak.sqlite-journal`, `soak.sqlite-shm`), and
     * the atomic-write staging files (`state.json.tmp`,
     * `checkpoint.json.tmp`, `summary.json.tmp`,
     * `collected-log.txt.tmp`) — all resolved INSIDE
     * this writer's output directory, never any external or
     * operator-supplied path.
     *
     * HIGH 3: `state.json` and `checkpoint.json` are REMOVED too (never
     * merely overwritten in place). A crash after the fresh run's new DB
     * opens but BEFORE its first state write must make a later `--resume`
     * FAIL cleanly ("no state.json exists") instead of accepting the
     * previous run identity or its zero-cycle state. Only a true `--resume`
     * preserves these documents (this reset never runs then).
     *
     * The derived outputs (`summary.json`, `summary.md`, `collected-log.txt`)
     * are overwritten during finalization and are never read by `--resume`,
     * so they need no removal here.
     */
    async resetRunArtifacts() {
      await rm(paths.cycles, { force: true });
      await rm(paths.operations, { force: true });
      await rm(paths.resources, { force: true });
      // HIGH 3: remove the atomic resume documents with the rest of the
      // prior run, so a fresh-run crash window can never be mistaken for
      // a resumable continuation of the previous run.
      await rm(paths.state, { force: true });
      await rm(paths.checkpoint, { force: true });
      // MEDIUM: stale atomic-write staging files are removed with the
      // documents they stage — a fresh run never carries a half-written
      // state/checkpoint/summary staging file into the new run. Both the
      // retired FIXED `<doc>.tmp` names (exact paths, legacy leftovers
      // from pre-unique-name runs) and the current UNIQUE staging shape
      // `<doc>.tmp-<pid>-<seq>` (a crash between the exclusive temp write
      // and its rename leaves one of these) are removed. The unique names
      // are matched by an anchored pattern on the known artifact base
      // name plus the exact `.tmp-<digits>-<digits>` staging shape, and
      // only INSIDE this writer's output directory — never a sweep of
      // arbitrary files inside or outside the output dir. rm() on a
      // symlink unlinks the link itself, never its target, so a planted
      // symlink at a staging name is removed without touching the
      // external file.
      for (const key of ATOMIC_STAGED_ARTIFACTS) {
        await rm(`${paths[key]}.tmp`, { force: true });
      }
      const uniqueStagingEntries = await readdir(dir).catch(() => []);
      for (const key of ATOMIC_STAGED_ARTIFACTS) {
        const stagingPattern = uniqueStagingPattern(ARTIFACT_NAMES[key]);
        for (const entry of uniqueStagingEntries) {
          if (stagingPattern.test(entry)) {
            await rm(path.join(dir, entry), { force: true });
          }
        }
      }
      for (const name of RUNNER_OWNED_SQLITE_FILES) {
        await rm(path.join(dir, name), { force: true });
      }
    },
    /**
     * Clears logger-owned log files (current + rotated backups) for a
     * FRESH run so a reused output directory can never leak prior log
     * content into the new run's `collected-log.txt`.
     *
     * Only files that match the logger's exact ownership pattern for the
     * effective log path are removed (`<base>.txt` and the CANONICAL
     * logger-created backups `<base>.<N>.txt` with N in [1, retention] —
     * never `.0.txt`, leading-zero `.01.txt`, case variants, or numeric
     * files beyond the configured retention), and ONLY when the log file
     * lives inside this
     * writer's output directory by BOTH lexical and real path: an
     * operator-supplied `--log-file` outside the output dir is
     * operator-owned and is never touched, and a symlinked log directory
     * that resolves outside the real output dir is not logger-owned either
     * — so arbitrary external or custom files can never be deleted
     * unsafely. A blank/whitespace log path (logging disabled) clears
     * nothing. The retention defaults to the library's effective
     * `HIKOUTEI_LOG_BACKUPS` (mirror: default 5, 0 = truncate, max 20);
     * pass `backups` to pin a different retention.
     *
     * @param {{ logFile?: string, backups?: number }} [options] effective log path and retention.
     * @returns {Promise<{ removed: number }>} number of files removed.
     */
    async resetLoggerFiles({ logFile, backups } = {}) {
      const retention = backups ?? resolveLogRetention();
      const normalized = normalizeSoakLogFilePath(logFile ?? paths.internalLog);
      if (normalized === undefined) {
        // A blank/whitespace `HIKOUTEI_LOG_FILE` means the library logger
        // is DISABLED: there are no logger-owned files to clear.
        return { removed: 0 };
      }
      const logPath = path.resolve(normalized);
      if (!logPath.startsWith(`${dir}${path.sep}`)) {
        // External operator-owned log file: leave it untouched.
        return { removed: 0 };
      }
      // Real-path containment: a symlinked log directory that resolves
      // OUTSIDE the real output dir is not logger-owned — deleting through
      // it would remove arbitrary external files. (Individual log-file
      // symlinks are safe here: rm() removes the link, never its target.)
      const containment = await resolveLogContainment(logPath, dir);
      if (!containment.realContained) {
        return { removed: 0 };
      }
      const logDir = path.dirname(logPath);
      const baseName = path.basename(logPath).replace(/\.txt$/i, "");
      const dirEntries = await readdir(logDir).catch(() => []);
      let removed = 0;
      for (const entry of dirEntries) {
        // Only the current file plus CANONICAL logger-created backups
        // (indices 1..retention, exact case) are removed; `.0.txt`,
        // leading-zero, beyond-retention numeric files, and case variants
        // are operator files and survive.
        if (entry === path.basename(logPath) ||
            rotatedBackupIndex(baseName, entry, retention) !== undefined) {
          await rm(path.join(logDir, entry), { force: true });
          removed += 1;
        }
      }
      return { removed };
    },
  };
}

/** Escapes one string for use inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mirror of the library logger's rotated-backup retention contract (see
 * `src/shared/observability/internalLog.ts`): this module runs under plain
 * Node and cannot import the TS source, so the defaults are mirrored here
 * and any drift is caught by the contract mirror test in
 * `test/soak-artifacts.records.test.ts`.
 */
const DEFAULT_LOG_BACKUPS = 5;
const MAX_LOG_BACKUPS = 20;

/**
 * Resolves the EFFECTIVE rotated-backup retention for a log path, from the
 * same environment the library logger uses (`HIKOUTEI_LOG_BACKUPS`), with
 * the same bounded-integer fallback rules: digits-only values, default 5,
 * clamped to [0, 20]; 0 means the logger truncates and creates no backups.
 *
 * @param {Record<string, string | undefined>} env environment map.
 * @returns {number} retention in [0, 20].
 */
function resolveLogRetention(env = process.env) {
  const raw = env.HIKOUTEI_LOG_BACKUPS;
  if (typeof raw !== "string" || raw.trim() === "" || !/^\d+$/.test(raw.trim())) {
    return DEFAULT_LOG_BACKUPS;
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) return DEFAULT_LOG_BACKUPS;
  return Math.min(Math.max(value, 0), MAX_LOG_BACKUPS);
}

/**
 * RegExp matching a rotated backup name of `baseName`: `<base>.<digits>.txt`
 * in EXACT case — the logger always appends the lowercase `.txt` suffix
 * and preserves only the configured path's base-name case. The caller
 * applies the canonical-index and retention rules; this only extracts the
 * numeric part. Operator files that differ by base-name case or suffix
 * case are never matched.
 *
 * @param {string} baseName log base name without the `.txt` suffix.
 * @returns {RegExp}
 */
function rotatedBackupPattern(baseName) {
  return new RegExp(`^${escapeRegExp(baseName)}\\.(\\d+)\\.txt$`);
}

/**
 * The index of one rotated backup entry, or `undefined` when the entry is
 * not a logger-created backup of `baseName`.
 *
 * Accepts ONLY canonical logger-created indices: `<base>.<N>.txt` where N
 * is the CANONICAL positive decimal representation of an integer in
 * [1, retention] — exactly the index shape the library rotation produces
 * (`<base>.1.txt` .. `<base>.N.txt`) — and matching is EXACT-case:
 * variants that differ by base-name case or suffix case
 * (`HIKOUTEI-INTERNAL-LOG.1.txt`, `hikoutei-internal-log.1.TXT`) are
 * operator files. `.0.txt`, leading-zero `.01.txt`, and arbitrary numeric
 * files beyond the configured retention are never matched either, so
 * operator files that merely share the base name are never collected or
 * deleted.
 *
 * @param {string} baseName log base name without the `.txt` suffix.
 * @param {string} entry one directory entry name.
 * @param {number} retention configured rotated-backup retention (>= 0).
 * @returns {number | undefined} the canonical backup index when matched.
 */
function rotatedBackupIndex(baseName, entry, retention) {
  const match = rotatedBackupPattern(baseName).exec(entry);
  if (match === null) return undefined;
  const indexText = match[1];
  // Canonical decimal: the logger never writes leading zeros.
  if (indexText.length > 1 && indexText.startsWith("0")) return undefined;
  const index = Number(indexText);
  if (!Number.isSafeInteger(index) || index < 1 || index > retention) {
    return undefined;
  }
  return index;
}

/**
 * Artifact keys written through the atomic temp-file + rename path
 * (`writeJson`/`writeCheckpoint`, plus the collected log). A crash
 * between the temp write and the rename leaves a `<name>.tmp` staging
 * file; a fresh run removes exactly these runner-owned staging paths and
 * nothing else.
 */
const ATOMIC_STAGED_ARTIFACTS = Object.freeze(["state", "checkpoint", "summaryJson", "collectedLog"]);

/**
 * SQLite authority file names the runner owns inside its output directory
 * (database plus WAL/journal/shm sidecars). A fresh run removes exactly
 * these names — stale `-wal`/`-journal`/`-shm` sidecars can carry rows
 * from an interrupted previous run and must never survive into a new
 * authority.
 */
const RUNNER_OWNED_SQLITE_FILES = Object.freeze([
  "soak.sqlite",
  "soak.sqlite-wal",
  "soak.sqlite-journal",
  "soak.sqlite-shm",
]);

/**
 * Reads one log file and returns every line that validates as a
 * logger-shaped JSONL record (re-serialized in the canonical shape).
 * Invalid or secret-bearing lines are dropped, never copied.
 */
async function readValidLogLines(filePath) {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  const valid = [];
  for (const rawLine of raw.split("\n")) {
    const result = sanitizeCollectedLogLine(rawLine);
    if (result.status === "valid") valid.push(result.line);
  }
  return valid;
}

/**
 * Writes `collected-log.txt` atomically (unique staging name, exclusive
 * no-follow open, fsync, rename).
 *
 * The reserved name must never be written THROUGH a pre-existing symlink:
 * an operator-planted `collected-log.txt` pointing at an external file
 * must not redirect the collection, so rename() swaps the destination
 * entry itself — replacing the link, never following it — and the
 * external target stays byte-identical. The unique staging name is
 * claimed with an exclusive no-follow open, so a pre-planted symlink at
 * a staging name — fixed or unique — can never redirect the temp write
 * either.
 *
 * @param {string} targetPath resolved `collected-log.txt` path.
 * @param {string} content complete collected-log content.
 * @param {() => string} nextTemporary claims the next unique staging path.
 */
async function writeCollectedLogAtomic(targetPath, content, nextTemporary) {
  await atomicWrite(targetPath, content, nextTemporary);
}

/**
 * True when a staging entry is one of this module's unique staging
 * names for `artifactName`: `<name>.tmp-<pid>-<seq>` with a positive
 * integer pid and sequence (the exact shape `uniqueStagingPath` builds).
 * The match is anchored to the artifact base name plus the exact
 * `.tmp-<digits>-<digits>` shape, so an operator file that merely shares
 * the base name is never matched.
 *
 * @param {string} artifactName artifact file name inside the output dir.
 * @returns {RegExp}
 */
function uniqueStagingPattern(artifactName) {
  return new RegExp(`^${escapeRegExp(artifactName)}\\.tmp-\\d+-\\d+$`);
}

/**
 * Builds one unique staging path for an artifact target.
 *
 * `<target>.tmp-<pid>-<seq>`: the fixed `<name>.tmp` names are retired as
 * write targets (stale fixed leftovers are still removed by the reset),
 * and every write gets its own exclusively created staging name, so a
 * symlink planted at any one staging name can never redirect the write —
 * the open fails closed (EEXIST/ELOOP) instead.
 *
 * Exported for the symlink regression tests to plant a link at the exact
 * next candidate name.
 *
 * @param {string} targetPath resolved artifact path.
 * @param {number} sequence per-writer staging sequence (>= 1).
 * @returns {string}
 */
export function uniqueStagingPath(targetPath, sequence) {
  return `${targetPath}.tmp-${process.pid}-${sequence}`;
}

/**
 * Atomically writes one artifact file (unique staging name + exclusive
 * no-follow open + fsync + rename), never following a pre-existing
 * symlink at either the staging or the target path.
 *
 * Every attempt claims a fresh unique staging name and opens it with
 * `O_CREAT | O_EXCL` (plus `O_NOFOLLOW` where the platform provides it):
 * a pre-planted symlink — at the fixed `<name>.tmp` name or at any
 * unique candidate — makes the open fail closed (EEXIST/ELOOP) instead
 * of redirecting the write, so there is NO rm-then-open window to race.
 * The content is written and fsynced through the opened handle before
 * the handle closes; the final rename() then swaps the destination entry
 * itself — a pre-existing symlink at the artifact name is replaced,
 * never followed — so an external operator target can never be
 * overwritten. An EEXIST collision (a planted entry or a concurrent
 * writer) claims the next unique name, bounded to a few attempts.
 *
 * @param {string} targetPath resolved artifact path.
 * @param {string} content complete file content.
 * @param {() => string} nextTemporary claims the next unique staging path.
 */
async function atomicWrite(targetPath, content, nextTemporary) {
  let lastCollisionError;
  for (let attempt = 0; attempt < MAX_STAGING_ATTEMPTS; attempt += 1) {
    const temporary = nextTemporary();
    let handle;
    try {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0);
      handle = await open(temporary, flags, 0o644);
      await handle.writeFile(content, "utf8");
      // fsync before rename: the staged content is durable before the
      // atomic swap makes it visible, so a crash can never expose a
      // half-written artifact under the final name.
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, targetPath);
      return;
    } catch (error) {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      if (isNodeErrorWithCode(error, "EEXIST")) {
        // The name was already taken (a planted symlink/file or an
        // extremely unlikely collision with a concurrent writer): claim
        // the next unique name. The planted entry is never followed and
        // never written through.
        lastCollisionError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastCollisionError ??
    new Error(`unable to claim a unique staging name for ${targetPath}`);
}

/** Maximum unique staging-name claims per atomic write (EEXIST retries). */
const MAX_STAGING_ATTEMPTS = 8;

/**
 * True when an fs error carries the given Node error code string.
 */
function isNodeErrorWithCode(error, code) {
  return error !== null &&
    typeof error === "object" &&
    (error).code === code;
}

/**
 * Removes a pre-existing symlink at `filePath` (the link itself, never
 * its target) so a subsequent no-follow write replaces it with a real
 * file instead of writing through it. A missing path stays untouched.
 *
 * @param {string} filePath resolved artifact path.
 */
async function removeSymlinkIfPresent(filePath) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) {
      await rm(filePath, { force: true });
    }
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
  }
}

/**
 * Appends content to one artifact stream without ever following a
 * pre-existing symlink at the stream path.
 *
 * A pre-existing symlink at the artifact name is removed first (the link
 * itself, never its target) and the open is then forced with `O_NOFOLLOW`
 * (when the platform provides it), so an operator symlink pointing
 * outside the output dir is replaced by a real file inside it — the
 * external target is never appended to, and a link planted between the
 * removal and the open fails the write closed instead of following it.
 *
 * @param {string} filePath resolved artifact path.
 * @param {string} content bytes to append.
 */
async function appendNoFollow(filePath, content) {
  await removeSymlinkIfPresent(filePath);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags, 0o644);
  try {
    await handle.appendFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Writes one whole artifact file without ever following a pre-existing
 * symlink at the path: the link itself is removed first and the write is
 * opened with `O_NOFOLLOW` (when the platform provides it), so an
 * operator symlink pointing outside the output dir is replaced by a real
 * file inside it — the external target is never overwritten.
 *
 * @param {string} filePath resolved artifact path.
 * @param {string} content complete file content.
 */
async function writeNoFollow(filePath, content) {
  await removeSymlinkIfPresent(filePath);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags, 0o644);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Resolves real-path containment for one effective log path.
 *
 * Returns whether the log path is lexically inside the output dir and, if
 * so, whether its REAL (symlink-resolved) log directory stays within the
 * REAL output directory. A log directory that is lexically inside but
 * resolves outside (a symlinked subdirectory pointing elsewhere) is not
 * logger-owned: reading or deleting through it would touch arbitrary
 * external files, so callers must treat it as untouchable. Lexically
 * external custom paths are deliberately excluded from containment — they
 * are operator-intended (collection reads them; reset never deletes them).
 *
 * @param {string} logPath resolved effective log file path.
 * @param {string} outputDir resolved artifact output directory.
 * @returns {Promise<{ lexicallyInside: boolean, realContained: boolean,
 *   realDir: string | undefined }>}
 */
async function resolveLogContainment(logPath, outputDir) {
  const lexicallyInside = logPath.startsWith(`${outputDir}${path.sep}`);
  if (!lexicallyInside) {
    return { lexicallyInside, realContained: false, realDir: undefined };
  }
  const realDir = await realpath(outputDir).catch(() => undefined);
  const realLogDir = await realpath(path.dirname(logPath)).catch(() => undefined);
  const realContained = realDir !== undefined && realLogDir !== undefined &&
    (realLogDir === realDir || realLogDir.startsWith(`${realDir}${path.sep}`));
  return { lexicallyInside, realContained, realDir };
}

/**
 * Normalizes a custom log path: trims surrounding whitespace, then forces
 * the `.txt` extension.
 *
 * Mirrors the library logger's contract exactly (`rawPath.trim()` before
 * `ensureTxtExtension`) so the collector reads the exact file (and rotated
 * backups) the logger wrote for a whitespace-padded `--log-file`:
 * `  operator-log  ` becomes `operator-log.txt`; an existing `.txt` suffix
 * is preserved as-is.
 *
 * A BLANK or whitespace-only value returns `undefined`: the library logger
 * treats blank `HIKOUTEI_LOG_FILE` as logging DISABLED (never normalizes
 * it to a bare `.txt`), so the collector/reset must too — there is no log
 * file to read or clear.
 *
 * @param {string} filePath
 * @returns {string | undefined} normalized `.txt` path, or `undefined` when blank.
 */
export function normalizeSoakLogFilePath(filePath) {
  const trimmed = String(filePath).trim();
  if (trimmed === "") return undefined;
  return trimmed.toLowerCase().endsWith(".txt") ? trimmed : `${trimmed}.txt`;
}

/**
 * Builds one redacted operation record for `operations.jsonl`.
 *
 * Every sensitive field is re-sanitized at this boundary (defense in
 * depth): `code` passes the stable-code allowlist, `reason` the stable
 * reason vocabulary, `counts` keeps only numeric identifier keys, and
 * `table` the soak name vocabulary. Unknown values become the fixed
 * `unknown` category.
 */
export function operationRecord(cycle, actorIndex, op, result) {
  const record = {
    ts: new Date().toISOString(),
    cycle,
    actor: actorIndex,
    index: op.opIndex,
    kind: op.kind,
    table: sanitizeTableName(op.entityName),
    status: result.status,
    ...(result.code === undefined ? {} : { code: sanitizeStableCode(result.code) }),
    // Stable redacted failure category (never a raw message, id, or value).
    ...(result.reason === undefined ? {} : { reason: sanitizeReason(result.reason) }),
    ...(result.counts === undefined ? {} : { counts: sanitizeCounts(result.counts) }),
    durationMs: result.durationMs ?? 0,
  };
  return record;
}

/**
 * Builds one redacted cycle record for `cycles.jsonl`.
 *
 * The probe/convergence/reopen/abort sections are re-sanitized at this
 * boundary (defense in depth): `code`, `reason`, `errorClass`, and
 * `statusClass` values pass their allowlists and table names the soak
 * vocabulary, so no arbitrary message fragment, id, path, URL, or email
 * can enter the durable JSONL even if an upstream record was built
 * loosely.
 */
export function cycleRecord(cycle, summary) {
  const sanitizeSection = (value) => sanitizeRecordFields(value);
  return {
    ts: new Date().toISOString(),
    cycle,
    durationMs: summary.durationMs,
    tablesTouched: (summary.tablesTouched ?? []).map(sanitizeTableName),
    operations: summary.operations.total,
    expectedErrors: summary.operations.expectedErrors,
    failures: summary.operations.failures,
    retries: summary.operations.retries,
    ...(summary.probe === undefined ? {} : { probe: sanitizeSection(summary.probe) }),
    ...(summary.convergence === undefined ? {} : { convergence: sanitizeSection(summary.convergence) }),
    ...(summary.reopen === undefined ? {} : { reopen: sanitizeSection(summary.reopen) }),
    ...(summary.abort === undefined ? {} : { abort: sanitizeSection(summary.abort) }),
    // Dedicated scenario totals, separate from the standard operation
    // counters: scenario expected/failure counts never perturb the baseline
    // workload totals, but they DO feed the run's failure budget/result.
    // The totals are re-sanitized (non-negative integers) at this boundary.
    // When the summary does not carry explicit totals (e.g. a test-built
    // summary), they are derived from the scenario records so the durable
    // record is always self-consistent.
    scenarioTotals: {
      expectedErrors: sanitizeScenarioCounter(
        summary.scenarioTotals?.expectedErrors ??
        (summary.scenarios ?? []).reduce((sum, entry) => sum + (entry.expectedErrors ?? 0), 0)),
      failures: sanitizeScenarioCounter(
        summary.scenarioTotals?.failures ??
        (summary.scenarios ?? []).reduce((sum, entry) => sum + (entry.failures ?? 0), 0)),
    },
    // Per-cycle attack scenarios: each redacted scenario record carries
    // only the fixed id/phase/order/tag/status plus expected/failure counts
    // and an optional allowlisted targetTable (the soak table the plan
    // targets) — never a plan entity, field, id, value, URL, or credential.
    ...(summary.scenarios === undefined || summary.scenarios.length === 0 ? {} : {
      scenarios: summary.scenarios.map(sanitizeScenarioRecord),
    }),
  };
}

/**
 * Coerces one scenario counter to a non-negative integer for the durable
 * record (defense in depth: a malformed upstream total must never write a
 * negative or fractional value into the JSONL).
 *
 * @param {unknown} value candidate scenario counter.
 * @returns {number} non-negative integer (0 when malformed).
 */
function sanitizeScenarioCounter(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Samples process resources for `resources.jsonl`. */
export async function resourceRecord(cycle, dbSizeBytes) {
  const memory = process.memoryUsage();
  return {
    ts: new Date().toISOString(),
    cycle,
    rssKb: Math.round(memory.rss / 1024),
    heapUsedKb: Math.round(memory.heapUsed / 1024),
    externalKb: Math.round(memory.external / 1024),
    dbBytes: dbSizeBytes,
    uptimeMs: Math.round(process.uptime() * 1000),
  };
}

/** Renders the Markdown summary (redacted). */
export function renderSummaryMarkdown(summary) {
  const lines = [
    "# Hikoutei local multi-table soak summary",
    "",
    `- Status: **${summary.status}**`,
    `- Mode: ${summary.mode}`,
    `- Seed: ${summary.seed}`,
    `- Started: ${summary.startedAt}`,
    `- Finished: ${summary.finishedAt}`,
    `- Duration: ${summary.elapsedMs} ms (budget ${summary.durationBudgetMs} ms)`,
    `- Cycles completed: ${summary.cyclesCompleted}`,
    `- Operations: ${summary.operations.total} (ok ${summary.operations.ok}, expected errors ${summary.operations.expectedErrors}, failures ${summary.operations.failures}, retries ${summary.operations.retries})`,
    `- Probes: ${summary.probes.total} (ok ${summary.probes.ok}, skipped ${summary.probes.skipped}, failed ${summary.probes.failed})`,
    `- Convergence checks: ${summary.convergence.checks} (failed ${summary.convergence.failed})`,
    // Redacted scenario totals line (numbers only), so a scenario-only
    // failure stays visible in the markdown even when the operation failure
    // count is zero.
    `- Scenarios: ${summary.scenarios.expectedErrors} expected errors, ${summary.scenarios.failures} failures`,
    "",
    "| Table | Final live rows |", "| --- | ---: |",
    // Defense in depth: table names pass the soak vocabulary and counts
    // stay numeric so no crafted state can inject text into the summary.
    ...Object.entries(summary.tableRows).map(([table, count]) =>
      `| ${sanitizeTableName(table)} | ${typeof count === "number" && Number.isFinite(count) ? count : 0} |`),
    "",
    summary.stopReason === undefined ? "" : `- Stop reason: ${summary.stopReason}`,
    summary.recovery === undefined
      ? ""
      : `- Recovery: ${summary.recovery.status} (${summary.recovery.reason}, cycle ${summary.recovery.cycle})`,
    summary.cleanup === undefined ? "" : `- Cleanup: ${summary.cleanup.status} (${summary.cleanup.reason})`,
    summary.replacementCleanup === undefined
      ? ""
      : `- Replacement cleanup: ${summary.replacementCleanup.status} (${summary.replacementCleanup.reason})`,
    summary.finalization === undefined
      ? ""
      : `- Finalization: ${summary.finalization.status} (${summary.finalization.reason}, step ${summary.finalization.step})`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}
