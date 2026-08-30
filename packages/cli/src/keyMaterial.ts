/**
 * Service-account key material handling for `hikoutei setup`.
 *
 * The secure key-file reading and validation logic of the setup flow,
 * extracted verbatim: parse/validate raw key JSON, securely read an existing
 * key file through ONE descriptor boundary (no-follow, non-block,
 * lstat/fstat inode binding, owner-only mode 0600 applied and verified
 * through the still-open descriptor before any read, sanitized path-only
 * failures), and promote either the non-secret metadata or the validated
 * in-memory credential. The private key exists only in process memory for
 * the run and never appears in results, messages, the checkpoint, or the
 * `.env` file.
 */

import type { KeyMetadataResult, SecureKeyReadResult } from "./checkpoint.js";
import { SERVICE_ACCOUNT_KEY_FILE_MODE, SERVICE_ACCOUNT_KEY_ID_PATTERN } from "./checkpoint.js";
import { noFollowFlag, nonBlockFlag } from "./envFileWriter.js";
import { createPrivateKey } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  type Stats,
} from "node:fs";

/**
 * Parses and validates raw service-account key JSON (no filesystem access).
 *
 * Shared by the secure descriptor read and by tests. The key material is
 * never returned; only the non-secret metadata is promoted. The validated
 * in-memory key material is available to the credential reader
 * (`readServiceAccountKeyCredentialSecurely`) for the SA verify phase.
 */
export function parseServiceAccountKeyJson(raw: string, sourceLabel: string): KeyMetadataResult {
  const result = parseServiceAccountKeyPayload(raw, sourceLabel);
  if (result.status === "invalid") {
    return result;
  }
  const { projectId, clientEmail, keyId } = result.payload;
  return { status: "ok", metadata: { projectId, clientEmail, keyId } };
}

/** Validated fields of a service-account key payload. */
interface ServiceAccountKeyPayload {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly keyId: string;
  readonly privateKey: string;
}

/** Result of parsing a raw key payload. */
type KeyPayloadResult =
  | { readonly status: "ok"; readonly payload: ServiceAccountKeyPayload }
  | { readonly status: "invalid"; readonly message: string };

/**
 * Parses and validates raw service-account key JSON, keeping the validated
 * private key in memory for the credential reader.
 *
 * The shared validation core of `parseServiceAccountKeyJson`: JSON shape,
 * RSA private key, project, client email, and non-secret key id. The
 * private key is only ever promoted into process memory (never into a
 * result, message, or the checkpoint); the metadata reader discards it and
 * the credential reader hands it to the SA access verifier for one run.
 */
function parseServiceAccountKeyPayload(raw: string, sourceLabel: string): KeyPayloadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never forward the parse exception text: Node's JSON.parse failures
    // can include a snippet of the input, and a key file is untrusted
    // (it may contain arbitrary text in place of key material).
    return { status: "invalid", message: `${sourceLabel} is not valid JSON` };
  }

  if (!isRecord(parsed)) {
    return { status: "invalid", message: `${sourceLabel} is not a service-account key file` };
  }
  const { type, project_id, client_email, private_key, private_key_id } = parsed;
  if (
    type !== "service_account" ||
    typeof project_id !== "string" ||
    project_id === "" ||
    typeof client_email !== "string" ||
    client_email === "" ||
    typeof private_key !== "string" ||
    private_key === "" ||
    typeof private_key_id !== "string" ||
    !SERVICE_ACCOUNT_KEY_ID_PATTERN.test(private_key_id)
  ) {
    return { status: "invalid", message: `${sourceLabel} is not a service-account key file` };
  }
  if (!isValidRsaPrivateKey(private_key)) {
    return { status: "invalid", message: `${sourceLabel} contains an invalid or non-RSA private key` };
  }
  return {
    status: "ok",
    payload: {
      projectId: project_id,
      clientEmail: client_email,
      keyId: private_key_id,
      privateKey: private_key,
    },
  };
}

/**
 * Filesystem operations the secure key read uses; injectable for tests.
 */
export interface KeyFileFs {
  lstatSync(path: string): Stats;
  openSync(path: string, flags: number): number;
  fchmodSync(fd: number, mode: number): void;
  fstatSync(fd: number): Stats;
  readFileSync(fd: number, encoding: "utf8"): string;
  closeSync(fd: number): void;
}

const defaultKeyFileFs: KeyFileFs = {
  lstatSync,
  openSync,
  fchmodSync,
  fstatSync,
  readFileSync,
  closeSync,
};

/**
 * Securely reads an existing service-account key file through ONE
 * descriptor boundary and enforces owner-only mode 0600.
 *
 * A missing file is `absent`. An existing entry must be a regular file (a
 * symlink is refused outright; directories, FIFOs, and sockets are refused
 * too). The file is opened with `O_NOFOLLOW` (where the platform defines it
 * — a symlink swapped in between the type check and the open fails with
 * ELOOP/EMLINK and is refused) plus `O_NONBLOCK` (where the platform
 * defines it — a FIFO swapped in between the type check and the open
 * returns from the open instead of blocking), the descriptor is
 * fstat-verified as a regular file with the SAME device/inode the lstat
 * observed BEFORE any fchmod (a directory, FIFO, socket, device, or
 * replaced-file entry is refused with zero chmod and zero read calls), and
 * only then is mode 0600 applied THROUGH the open descriptor
 * with `fchmod` and the resulting mode verified on the same descriptor
 * before a single byte is read — never an existsSync/readFileSync
 * check-then-use sequence, so an alias planted mid-read cannot receive the
 * chmod or be read through. Only after the descriptor is secured is the
 * content parsed and validated (JSON shape, RSA private key, project,
 * client email, and non-secret key id). Any inspect/open/type/chmod/read/
 * parse failure fails closed with a stable path-only message that never
 * contains raw error text or key material, and the descriptor is closed
 * exactly once (a close failure never overrides the verdict). Supported
 * platforms (macOS/Linux) can
 * enforce owner-only modes; Windows automatic setup is refused before this
 * code runs.
 */
export function readServiceAccountKeySecurely(
  keyPath: string,
  fs: KeyFileFs = defaultKeyFileFs,
): SecureKeyReadResult {
  const result = readServiceAccountKeyPayloadSecurely(keyPath, fs);
  if (result.status === "absent" || result.status === "invalid") {
    return result;
  }
  const { projectId, clientEmail, keyId } = result.payload;
  return { status: "ok", metadata: { projectId, clientEmail, keyId } };
}

/**
 * Result of the secure, descriptor-based key credential read.
 *
 * Same descriptor boundary as `readServiceAccountKeySecurely`, but the
 * validated `private_key` is promoted into process memory for the SA
 * access verify phase: the verifier is given the credentials in memory and
 * NEVER reopens the key pathname, so a mid-run replacement cannot redirect
 * it. The key material exists only in memory for the run; it is never
 * returned by the setup result, never written to the checkpoint or `.env`,
 * and never included in any error message.
 */
export type SecureKeyCredentialReadResult =
  | { readonly status: "absent" }
  | {
    readonly status: "ok";
    readonly credentials: {
      readonly projectId: string;
      readonly clientEmail: string;
      readonly privateKey: string;
    };
  }
  | { readonly status: "invalid"; readonly message: string };

/**
 * Securely reads an existing service-account key file and promotes the
 * validated credential into process memory.
 *
 * Identical descriptor security to `readServiceAccountKeySecurely`
 * (regular file, no-follow, non-block, lstat/fstat inode binding, owner-only
 * 0600 through the descriptor before any read, sanitized failures), but
 * the returned credentials carry the validated `privateKey` so the SA
 * access verifier can authenticate from memory. The private key is only in
 * process memory for the run and never appears in results, messages, the
 * checkpoint, or the `.env` file.
 */
export function readServiceAccountKeyCredentialSecurely(
  keyPath: string,
  fs: KeyFileFs = defaultKeyFileFs,
): SecureKeyCredentialReadResult {
  const result = readServiceAccountKeyPayloadSecurely(keyPath, fs);
  if (result.status === "absent" || result.status === "invalid") {
    return result;
  }
  const { projectId, clientEmail, privateKey } = result.payload;
  return { status: "ok", credentials: { projectId, clientEmail, privateKey } };
}

/**
 * The secure descriptor read shared by the metadata and credential
 * readers; see `readServiceAccountKeySecurely` for the full contract.
 */
function readServiceAccountKeyPayloadSecurely(
  keyPath: string,
  fs: KeyFileFs,
): SecureKeyPayloadReadResult {
  let lst: ReturnType<typeof lstatSync> | undefined;
  try {
    lst = fs.lstatSync(keyPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "absent" };
    }
    // Generic path-only diagnostic: arbitrary thrown text from this
    // injected/filesystem stage (which may carry token or key sentinels)
    // must never reach the result.
    return { status: "invalid", message: `could not inspect ${keyPath}` };
  }
  if (lst === undefined) {
    // Unreachable: lstatSync either assigned or the catch returned above.
    return { status: "invalid", message: `could not inspect ${keyPath}` };
  }
  if (lst.isSymbolicLink()) {
    return {
      status: "invalid",
      message: `refusing to follow a symlink at ${keyPath}; remove it and retry`,
    };
  }
  if (!lst.isFile()) {
    return {
      status: "invalid",
      message: `${keyPath} is not a regular file; remove it and retry`,
    };
  }
  let fd: number;
  try {
    fd = fs.openSync(keyPath, constants.O_RDONLY | noFollowFlag() | nonBlockFlag());
  } catch (error) {
    if (isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")) {
      return {
        status: "invalid",
        message: `refusing to follow a symlink at ${keyPath}; remove it and retry`,
      };
    }
    // Generic path-only diagnostic: arbitrary thrown text from this
    // injected/filesystem stage (which may carry token or key sentinels)
    // must never reach the result. There is no descriptor to close here.
    return { status: "invalid", message: `could not open ${keyPath}` };
  }
  try {
    // The descriptor is fstat-verified as a REGULAR FILE immediately after
    // the open and BEFORE any fchmod: a directory, FIFO, socket, or device
    // swapped in between the lstat check and the open (O_NONBLOCK made the
    // open return instead of blocking on a FIFO) is refused with zero
    // chmod and zero read calls, so a directory replacement never receives
    // a mode change through this descriptor.
    let stat: ReturnType<KeyFileFs["fstatSync"]>;
    try {
      stat = fs.fstatSync(fd);
    } catch {
      // Generic path-only diagnostic: arbitrary thrown text from this
      // injected/filesystem stage must never reach the result.
      return {
        status: "invalid",
        message: `could not verify owner-only permissions on ${keyPath}`,
      };
    }
    if (!stat.isFile()) {
      return {
        status: "invalid",
        message: `${keyPath} is not a regular file; remove it and retry`,
      };
    }
    if (lst.dev !== stat.dev || lst.ino !== stat.ino) {
      // The descriptor is NOT the file the lstat verified: the entry was
      // replaced between the type check and the open. Refuse BEFORE any
      // fchmod or read — a swapped alias must never receive the chmod or
      // contribute key material.
      return {
        status: "invalid",
        message: `${keyPath} changed while being read; remove it and retry`,
      };
    }
    // Only a verified regular file is secured: mode 0600 is applied
    // THROUGH the open descriptor and the resulting mode is verified on
    // the same descriptor before a single byte is read.
    try {
      fs.fchmodSync(fd, SERVICE_ACCOUNT_KEY_FILE_MODE);
    } catch {
      // Generic path-only diagnostic: arbitrary thrown text from this
      // injected/filesystem stage (or the injected chmod failure) must
      // never reach the result.
      return {
        status: "invalid",
        message: `could not secure ${keyPath} to owner-only mode`,
      };
    }
    try {
      stat = fs.fstatSync(fd);
    } catch {
      // Generic path-only diagnostic: arbitrary thrown text from this
      // injected/filesystem stage must never reach the result.
      return {
        status: "invalid",
        message: `could not verify owner-only permissions on ${keyPath}`,
      };
    }
    const mode = Number(stat.mode);
    if (!stat.isFile() || (mode & 0o777) !== SERVICE_ACCOUNT_KEY_FILE_MODE) {
      return {
        status: "invalid",
        message: `could not verify owner-only permissions on ${keyPath}`,
      };
    }
    let raw: string;
    try {
      raw = fs.readFileSync(fd, "utf8");
    } catch {
      // Generic path-only diagnostic: the file is untrusted, so its read
      // failure text is never forwarded.
      return { status: "invalid", message: `could not read ${keyPath}` };
    }
    return parseServiceAccountKeyPayload(raw, keyPath);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The validation result is the one to report.
    }
  }
}

/** Result of the shared secure payload read. */
type SecureKeyPayloadReadResult =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly payload: ServiceAccountKeyPayload }
  | { readonly status: "invalid"; readonly message: string };




/**
 * True when the PEM parses as an RSA private key.
 *
 * The parsed key object is discarded immediately; only the type verdict is
 * returned and the key material never leaves this function.
 */
function isValidRsaPrivateKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
