/**
 * Reserved setup path helpers and the shared private-write filesystem
 * primitives for the `hikoutei setup` CLI.
 *
 * Extracted as the dependency-free leaf of the CLI module graph so the
 * checkpoint module and the env-file writer can share these names without
 * importing each other (the previous checkpoint ↔ envFileWriter re-import
 * formed a benign but avoidable module cycle). This module imports only
 * ./errors.js for the setupPathSafetyError carrier factory and SETUP_ERROR_CODES.
 */

import {
  type Stats,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  SETUP_ERROR_CODES,
  setupPathSafetyError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Reserved path suffixes and derivations (moved verbatim from checkpoint.ts)
// ---------------------------------------------------------------------------

/** Suffix of the fixed-name checkpoint sibling temp path. */
export const SETUP_STATE_TEMP_SUFFIX = ".tmp";

/** Suffix of the exclusive setup lock directory. */
export const SETUP_LOCK_SUFFIX = ".lock";

/** Atomic checkpoint temp path for a state file. */
export function setupStateTempPath(statePath: string): string {
  return `${statePath}${SETUP_STATE_TEMP_SUFFIX}`;
}

/** Exclusive setup lock path for a state file. */
export function setupLockPath(statePath: string): string {
  return `${statePath}${SETUP_LOCK_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Symlink-safe open flags (moved verbatim from envFileWriter.ts)
// ---------------------------------------------------------------------------

/** `O_NOFOLLOW` where the platform defines it, else 0. */
export function noFollowFlag(): number {
  return (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

/** `O_NONBLOCK` where the platform defines it, else 0. */
export function nonBlockFlag(): number {
  return (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
}

// ---------------------------------------------------------------------------
// Shared private-write filesystem primitives (moved verbatim from checkpoint.ts)
// ---------------------------------------------------------------------------

export interface SetupStateWriteFs {
  openSync(path: string, flags: number, mode: number): number;
  fstatSync(fd: number): Stats;
  fchmodSync(fd: number, mode: number): void;
  /**
   * Descriptor write at a byte offset; returns the actual byte count written.
   *
   * `position` is `null` to write at (and advance) the current file
   * position. The contract matches `fs.writeSync(fd, buffer, offset,
   * length, position)` so the node implementation is assignable directly.
   */
  writeSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  lstatSync(path: string): Stats;
  unlinkSync(path: string): void;
  renameSync(from: string, to: string): void;
  /**
   * Opens the containing directory of a just-renamed file for its
   * durability fsync, with `O_NOFOLLOW`/`O_DIRECTORY` where the platform
   * defines them.
   */
  openDirSync(path: string, flags: number): number;
  /** Fsyncs an open directory descriptor so a completed rename is durable. */
  fsyncDirSync(fd: number): void;
  /** Never called by production; present so tests can prove the pathname chmod is unused. */
  chmodSync(path: string, mode: number): void;
}

/**
 * The default filesystem for the private temp write; exported so callers
 * (and tests) can build an injected `SetupStateWriteFs` around the real
 * operations.
 */
export const defaultSetupStateWriteFs: SetupStateWriteFs = {
  openSync,
  fstatSync,
  fchmodSync,
  writeSync,
  fsyncSync,
  closeSync,
  lstatSync,
  unlinkSync,
  renameSync,
  openDirSync: (path, flags) => openSync(path, flags),
  fsyncDirSync: fsyncSync,
  chmodSync: () => {
    // Production never pathname-chmods a temp file; this default exists only
    // to satisfy the interface for callers that do not inject a test fs.
    // survey §c (I): invariant — unreachable in production; the private temp
    // write applies and verifies mode through the descriptor, never via pathname.
    throw new Error("pathname chmod is not used by the private temp write");
  },
};

/**
 * Writes every UTF-8 byte of `content` to the descriptor, looping on short
 * writes.
 *
 * Works at the Buffer/byte level, so a partial write that splits a
 * multibyte character is still resumed at the exact byte offset and the
 * final content is byte-identical. A write that reports 0, a negative
 * value, a non-integer, or more bytes than remain is a safe failure (the
 * loop can never spin forever). Throws a SetupPathSafetyError with
 * SETUP_WRITE_NO_PROGRESS so the boundary catch preserves the specific
 * carrier code.
 */
export function writeAllSync(
  fd: number,
  content: string,
  write: SetupStateWriteFs["writeSync"],
): void {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = write(fd, buffer, offset, buffer.length - offset, null);
    if (!Number.isInteger(written) || written <= 0 || written > buffer.length - offset) {
      throw setupPathSafetyError(
        SETUP_ERROR_CODES.SETUP_WRITE_NO_PROGRESS,
        "the write made no progress; nothing was written",
      );
    }
    offset += written;
  }
}

// ---------------------------------------------------------------------------
// Durability fsync of a containing directory (moved verbatim from checkpoint.ts)
// ---------------------------------------------------------------------------

/**
 * Open flags for the durability fsync of a containing directory.
 *
 * `O_RDONLY` with `O_DIRECTORY`/`O_NOFOLLOW` where the platform defines
 * them: only a real directory is opened and a symlink planted at the
 * parent path is never followed.
 */
function directoryFsyncOpenFlags(): number {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const directory = (constants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  return constants.O_RDONLY | noFollow | directory;
}

/**
 * Fsyncs the containing directory of a just-renamed file so the rename is
 * durable across power loss.
 *
 * POSIX rename durability requires the directory entry change to be
 * flushed to stable storage; a directory fsync after the rename makes the
 * write-ahead checkpoint (and the `.env` output) survive a power loss.
 * The directory is opened WITHOUT following symlinks (`O_NOFOLLOW`) and
 * with `O_DIRECTORY` where the platform defines them, fsynced through the
 * descriptor, and closed exactly once. Open/fsync/close failures throw a
 * sanitized error; the caller must NOT roll back a completed rename — the
 * destination is already in place and the next run sees it.
 */
export function fsyncParentDirectory(parentPath: string, fs: SetupStateWriteFs): void {
  let dirFd: number;
  try {
    dirFd = fs.openDirSync(parentPath, directoryFsyncOpenFlags());
  } catch (error) {
    throw setupPathSafetyError(
      SETUP_ERROR_CODES.SETUP_DIR_FSYNC_OPEN_FAILED,
      `could not open the directory containing ${parentPath} to make the rename durable: ${messageOf(error)}`,
    );
  }
  let fsyncError: unknown;
  try {
    fs.fsyncDirSync(dirFd);
  } catch (error) {
    fsyncError = error;
  }
  let closeError: unknown;
  try {
    fs.closeSync(dirFd);
  } catch (error) {
    closeError = error;
  }
  if (fsyncError !== undefined) {
    throw setupPathSafetyError(
      SETUP_ERROR_CODES.SETUP_RENAME_DURABLE_FAILED,
      `could not make the rename at ${parentPath} durable: ${messageOf(fsyncError)}`,
    );
  }
  if (closeError !== undefined) {
    throw setupPathSafetyError(
      SETUP_ERROR_CODES.SETUP_DIR_FSYNC_CLOSE_FAILED,
      `could not finalize the directory sync for ${parentPath}: ${messageOf(closeError)}`,
    );
  }
}

/** Sanitizes an unknown error value to its message (module-local; matches the other CLI modules). */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}