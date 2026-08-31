/**
 * Env-file writer and atomic private-file write for `hikoutei setup`.
 *
 * The secure, atomic `.env` output-write machinery of the setup flow,
 * extracted verbatim: update only the two managed env keys while preserving
 * unrelated lines, refuse to read or write through any symlink/hardlink
 * alias of a reserved path, and always land the result via a unique private
 * temp file plus rename (never pathname-chmodded). Also carries
 * `revalidateSetupPaths`, the fail-closed re-run of the reserved-path
 * collision check performed immediately before every checkpoint and `.env`
 * write, so an alias planted mid-run can never redirect those writes.
 */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  defaultSetupStateWriteFs,
  fsyncParentDirectory,
  noFollowFlag,
  nonBlockFlag,
  writeAllSync,
  type SetupStateWriteFs,
} from "./setupPaths.js";
import { SETUP_ERROR_CODES, setupPathSafetyError } from "./errors.js";
import { errorResult, type SetupErrorResult } from "./flowResult.js";
import { findSetupPathCollision } from "./setupPathCollision.js";
import type { RunSetupOptions } from "./setupFlow.js";

/** The two .env keys the setup CLI manages. */
export const SETUP_ENV_KEYS = {
  CREDENTIALS: "GOOGLE_APPLICATION_CREDENTIALS",
  SPREADSHEET_URL: "HIKOUTEI_SYNC_SPREADSHEET_URL",
} as const;

/** Result of writing the .env output file. */
export interface EnvFileWriteResult {
  /** True when the file did not exist before this write. */
  readonly created: boolean;
  /** True when the file content changed (created or keys added/updated). */
  readonly modified: boolean;
}

function isManagedEnvLine(line: string): boolean {
  return (
    line.startsWith(`${SETUP_ENV_KEYS.CREDENTIALS}=`) ||
    line.startsWith(`${SETUP_ENV_KEYS.SPREADSHEET_URL}=`)
  );
}

/** Prefix of the unique per-run private temp file for the .env write. */
const ENV_TEMP_PREFIX = ".hikoutei-env-";

/** .env file permission (owner read/write only). */
const ENV_FILE_MODE = 0o600;

/**
 * Writes or updates the .env output file securely and atomically.
 *
 * An existing output must be a regular file at the lstat boundary (a
 * symlink is rejected outright, and directories/FIFOs/devices/sockets are
 * refused before any open so a FIFO can never block), the file is opened
 * WITHOUT following symlinks (`O_NOFOLLOW` where supported) and
 * non-blocking (`O_NONBLOCK` where supported), the descriptor is
 * fstat-verified as a regular file BEFORE a single byte is read (covering
 * a non-regular replacement between the lstat check and the open), and any
 * alias of the credentials file or other reserved paths (hardlink/symlink
 * alias — the key contents are never read through it) is refused before a
 * single byte is read. The preserved env content is built in memory and written to a unique private sibling temp
 * file (`O_CREAT|O_EXCL|O_WRONLY` plus `O_NOFOLLOW`, mode 0600, fsync +
 * close), then atomically renamed over the output: rename replaces the
 * directory entry and never follows a symlink or hardlink planted after
 * validation, so it cannot overwrite the key inode. Cleanup removes only
 * the temp inode this invocation created. Missing file is created; a file
 * whose content is unchanged is not rewritten. An existing file whose
 * owner bits are not exactly 0600 counts as modified and is atomically
 * replaced by a fresh verified-0600 file — never pathname-chmodded — so
 * hardlinks sharing the old inode keep their own mode and content. Throws on filesystem
 * failure or an unsafe existing entry; the caller preserves carrier codes
 * (`SetupPathSafetyError`) and falls back to `output_write_failed` for other errors.
 */
export function writeSetupEnvFile(
  outputPath: string,
  credentialsPath: string,
  spreadsheetUrl: string,
  reservedPaths: readonly string[] = [],
): EnvFileWriteResult {
  const read = readExistingEnvFile(outputPath, [credentialsPath, ...reservedPaths]);
  const existing = read.existing;
  const created = read.created;

  const rawLines = existing === "" ? [] : existing.split("\n");
  // A trailing empty element comes from the final newline; drop it so
  // unrelated content is preserved without a spurious blank line.
  const lines =
    rawLines.length > 0 && rawLines[rawLines.length - 1] === "" ? rawLines.slice(0, -1) : rawLines;
  const next = [
    ...lines.filter((line) => !isManagedEnvLine(line)),
    `${SETUP_ENV_KEYS.CREDENTIALS}=${credentialsPath}`,
    `${SETUP_ENV_KEYS.SPREADSHEET_URL}=${spreadsheetUrl}`,
  ];
  const content = `${next.join("\n")}\n`;
  // A mode repair is a modification: an existing file whose owner bits are
  // not exactly 0600 must be atomically replaced by a fresh verified-0600
  // file (never pathname-chmodded, so hardlinks sharing the old inode keep
  // their own mode and content).
  const modeNeedsRepair = !created && read.mode !== ENV_FILE_MODE;
  const modified = created || content !== existing || modeNeedsRepair;
  if (modified) {
    atomicWritePrivateFile(outputPath, content);
  }
  return { created, modified };
}

/** Existing output content and owner bits read without following any alias. */
interface ExistingEnvRead {
  readonly existing: string;
  readonly created: boolean;
  /** Owner permission bits (`mode & 0o777`) of the existing file; 0 when created. */
  readonly mode: number;
}

/**
 * Reads an existing .env output without following symlinks or aliases.
 *
 * A symlink at the output path is rejected outright (the target could be
 * the key file, and the contents must never be read through an alias). An
 * existing entry must be a regular file at the lstat boundary: directories,
 * FIFOs, devices, and sockets are refused BEFORE any open, so a FIFO can
 * never block the open or a later read. The file is opened with `O_NOFOLLOW`
 * (where supported) plus `O_NONBLOCK` (where supported), the descriptor is
 * fstat-verified as a regular file BEFORE a single byte is read — this
 * covers a non-regular replacement (for example a FIFO planted between the
 * lstat check and the open) and prevents a FIFO open/read from blocking —
 * and the descriptor inode is compared against every reserved path; any
 * match is refused before reading. A missing file is `created` with empty
 * content. Throws on unsafe entries; the caller preserves carrier codes
 * (`SetupPathSafetyError`) and falls back to `output_write_failed` for other errors.
 */
function readExistingEnvFile(outputPath: string, reservedPaths: readonly string[]): ExistingEnvRead {
  try {
    const lst = lstatSync(outputPath);
    if (lst.isSymbolicLink()) {
      throw setupPathSafetyError(
        SETUP_ERROR_CODES.OUTPUT_SYMLINK_REFUSED,
        `refusing to follow a symlink at the output path ${outputPath}; remove the symlink and retry`,
      );
    }
    if (!lst.isFile()) {
      // Directories, FIFOs, devices, and sockets are never opened or read:
      // a FIFO open without O_NONBLOCK would block indefinitely.
      throw setupPathSafetyError(
        SETUP_ERROR_CODES.OUTPUT_NOT_REGULAR_FILE,
        `the output path ${outputPath} is not a regular file; remove it and retry`,
      );
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { existing: "", created: true, mode: 0 };
    }
    throw error;
  }

  let fd: number;
  try {
    fd = openSync(outputPath, constants.O_RDONLY | noFollowFlag() | nonBlockFlag());
  } catch (error) {
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
      // The entry became a symlink between the lstat check and the open
      // (or the platform lacks O_NOFOLLOW): refuse rather than follow.
      throw setupPathSafetyError(
        SETUP_ERROR_CODES.OUTPUT_SYMLINK_REFUSED,
        `refusing to follow a symlink at the output path ${outputPath}; remove the symlink and retry`,
      );
    }
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      // A non-regular entry replaced the output between the lstat check and
      // the open (e.g. a FIFO planted mid-run): refuse without reading it
      // (O_NONBLOCK made the open return instead of blocking on a FIFO).
      throw setupPathSafetyError(
        SETUP_ERROR_CODES.OUTPUT_NOT_REGULAR_FILE,
        `the output path ${outputPath} is not a regular file; remove it and retry`,
      );
    }
    const alias = reservedPaths.find((path) => sameInodeAsPath(stat, path));
    if (alias !== undefined) {
      throw setupPathSafetyError(
        SETUP_ERROR_CODES.OUTPUT_ALIASES_RESERVED,
        `the output path ${outputPath} aliases the reserved file ${alias}; refusing to read or write through it`,
      );
    }
    // The owner bits come from the SAME secured descriptor read, so the
    // mode-repair decision below can never race a check-then-use sequence.
    return { existing: readFileSync(fd, "utf8"), created: false, mode: Number(stat.mode) & 0o777 };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The read error is the one to report.
    }
  }
}

/** True when the given stat names the same device/inode as the path. */
function sameInodeAsPath(
  stat: { readonly dev: number; readonly ino: number },
  path: string,
): boolean {
  try {
    const other = statSync(path);
    return stat.dev === other.dev && stat.ino === other.ino && other.ino !== 0;
  } catch {
    return false;
  }
}

/**
 * Writes content to the output path atomically via a unique private temp.
 *
 * The temp file (PID + UUID sibling name) is created with exclusive
 * no-follow flags and mode 0600, owner-only mode is applied and verified
 * THROUGH the still-open descriptor (`fchmod` + `fstat`) before the content
 * is written and fsynced, the path is re-verified against the created
 * inode, and the file is renamed over the output. No pathname `chmod` is
 * ever performed. Rename replaces the directory entry rather than
 * following a symlink/hardlink planted after validation. Cleanup removes
 * only the temp inode this invocation created. Throws on failure. `fs` is
 * injectable so tests can prove the descriptor-mode behavior.
 *
 * Exported for the injected descriptor-mode regression; the flow calls it
 * through `writeSetupEnvFile` with the default filesystem.
 */
export function atomicWritePrivateFile(
  outputPath: string,
  content: string,
  fs: SetupStateWriteFs = defaultSetupStateWriteFs,
): void {
  const tempPath = join(dirname(outputPath), `${ENV_TEMP_PREFIX}${process.pid}-${randomUUID()}.tmp`);
  let fd: number;
  let tempDev = 0;
  let tempIno = 0;
  try {
    fd = fs.openSync(tempPath, exclusivePrivateOpenFlags(), ENV_FILE_MODE);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      // A pre-existing entry at the unique temp path is never followed,
      // truncated, or unlinked.
      throw setupPathSafetyError(
        SETUP_ERROR_CODES.OUTPUT_TEMP_CONFLICT,
        `a conflicting entry appeared at the env temp path ${tempPath}; nothing was written`,
      );
    }
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    tempDev = stat.dev;
    tempIno = stat.ino;
    // Owner-only mode is applied and verified on the STILL-OPEN descriptor
    // before any content is written, so the final mode never depends on the
    // process umask and a pathname chmod race is impossible.
    fs.fchmodSync(fd, ENV_FILE_MODE);
    const secured = fs.fstatSync(fd);
    if ((Number(secured.mode) & 0o777) !== ENV_FILE_MODE) {
      throw setupPathSafetyError(
        SETUP_ERROR_CODES.OUTPUT_TEMP_PERMISSION_VERIFY_FAILED,
        `could not verify owner-only permissions on the env temp file ${tempPath}`,
      );
    }
    writeAllSync(fd, content, fs.writeSync);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // The write error is the one to report.
    }
    removeOwnedTempFile(tempPath, tempDev, tempIno, fs);
    throw error;
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    // A close failure after a successful write/fsync still leaves the temp
    // inode this invocation created: remove it (identity-checked) and
    // rethrow. The rename must never run after a failed close, and the
    // descriptor is never closed twice.
    removeOwnedTempFile(tempPath, tempDev, tempIno, fs);
    throw error;
  }
  // Re-verify the temp path still names the inode we created before the
  // rename; a swapped alias must never be renamed onto the output.
  if (!pathNamesInode(tempPath, tempDev, tempIno, fs)) {
    removeOwnedTempFile(tempPath, tempDev, tempIno, fs);
    throw setupPathSafetyError(
      SETUP_ERROR_CODES.OUTPUT_TEMP_PATH_CHANGED,
      `the env temp path ${tempPath} changed while writing; nothing was written`,
    );
  }
  try {
    // The mode was already applied and verified on the descriptor above;
    // NO pathname chmod is performed here.
    fs.renameSync(tempPath, outputPath);
  } catch (error) {
    removeOwnedTempFile(tempPath, tempDev, tempIno, fs);
    throw error;
  }
  // The rename is durable only after the containing directory is fsynced
  // (same durability step as the checkpoint save): without it, a power loss
  // right after the rename could leave the old entry (or nothing) at the
  // output path. A failure here reports the write as failed WITHOUT
  // rolling back the rename — the destination is already in place.
  fsyncParentDirectory(dirname(outputPath), "output", fs);
}

/**
 * `O_NOFOLLOW`/`O_NONBLOCK` where the platform defines each, else 0.
 *
 * Compat re-export: these flags moved to the dependency-free `setupPaths.ts`
 * leaf; the envFileWriter module path stays stable for existing importers.
 */
export { noFollowFlag, nonBlockFlag } from "./setupPaths.js";

/** Exclusive no-follow create flags for a private temp file. */
function exclusivePrivateOpenFlags(): number {
  return constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag();
}

/** True when the path currently names exactly the given device/inode. */
function pathNamesInode(path: string, dev: number, ino: number, fs: SetupStateWriteFs): boolean {
  try {
    const stat = fs.lstatSync(path);
    return stat.dev === dev && stat.ino === ino;
  } catch {
    return false;
  }
}

/**
 * Removes the temp file only when it is still the inode this invocation
 * created; a replaced or foreign entry is never touched.
 */
function removeOwnedTempFile(tempPath: string, dev: number, ino: number, fs: SetupStateWriteFs): void {
  try {
    if (pathNamesInode(tempPath, dev, ino, fs)) {
      fs.unlinkSync(tempPath);
    }
  } catch {
    // Missing or already replaced: nothing of ours to clean up.
  }
}

/**
 * Re-runs the reserved-path collision check and fails closed when aliases
 * changed after the initial preflight.
 *
 * The reserved paths (key, output, checkpoint, temp, lock) are re-resolved
 * immediately before every checkpoint write and the .env write: a symlink
 * or hardlink planted after the preflight must never redirect a write to a
 * reserved file. Returns an error result on collision, `null` when safe.
 */
export function revalidateSetupPaths(options: RunSetupOptions): SetupErrorResult | null {
  const collision = findSetupPathCollision({
    keyPath: options.keyPath,
    outputPath: options.outputPath,
    statePath: options.statePath,
  });
  if (collision.status === "collision") {
    return errorResult(
      SETUP_ERROR_CODES.INVALID_ARGS,
      `${collision.message}; the reserved setup paths changed during the run, so nothing was written`,
    );
  }
  return null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
