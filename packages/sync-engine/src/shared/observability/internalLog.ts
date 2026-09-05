/**
 * Internal redaction-safe structured file logger.
 *
 * This module is service-side observability only: it is deliberately NOT
 * exported from the root `src/index.ts` barrel and must never become part of
 * the application-facing API. Logging is opt-in through environment variables
 * and every sink failure is fail-open — a logging problem can never change
 * transaction, flush, worker, or polling results.
 *
 * Redaction contract (enforced structurally, not by scrubbing text):
 *
 * - The entry type accepts only known structured fields. There is no
 *   free-form `message` field, so error messages, provider payloads, stack
 *   traces, URLs, and filesystem paths can never reach the log.
 * - Identifier-like string fields (`event`, `component`, `code`, `table`,
 *   `errorClass`) must match strict allowlist patterns; anything else is
 *   replaced with the literal `"[redacted]"` before serialization.
 * - Numeric context is passed through a typed `counts` record whose values
 *   must be finite numbers; every other value shape is dropped.
 *
 * Output is one JSON object per line, appended to the `.txt` file named by
 * `HIKOUTEI_LOG_FILE`. When the file would exceed `HIKOUTEI_LOG_MAX_BYTES`
 * it rotates to `<name>.1.txt`, `<name>.2.txt`, ... keeping at most
 * `HIKOUTEI_LOG_BACKUPS` rotated files (defaults: 10 MiB and 5 backups,
 * matching the soak runner's plan; explicit env overrides stay bounded).
 * All I/O is serialized through one promise queue and any failure degrades
 * the sink to a silent no-op. The first write creates the parent directory
 * of the log file so nested or custom paths work out of the box. The
 * append never follows a pre-existing symlink at the log path
 * (`O_NOFOLLOW` where available, lstat rejection elsewhere): a symlinked
 * log file is rejected fail-open and the external target is never
 * appended to, truncated, or renamed.
 */

import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
  HIKOUTEI_LOG_PROVIDER_OPERATIONS,
  HIKOUTEI_LOG_PROVIDER_REASONS,
  HIKOUTEI_LOG_STABLE_CLASSES,
  HIKOUTEI_LOG_STABLE_CODES,
  HIKOUTEI_LOG_TRANSPORT_OPERATIONS,
} from "./logEvents.js";

/** Environment keys that configure the internal file logger. */
export const HIKOUTEI_LOG_ENV_KEYS = {
  /** Target log file; absent/blank disables file logging entirely. */
  LOG_FILE: "HIKOUTEI_LOG_FILE",
  /** Minimum level written: debug, info, warn, or error. Defaults to info. */
  LOG_LEVEL: "HIKOUTEI_LOG_LEVEL",
  /** Rotation threshold in bytes. Defaults to 10 MiB; minimum 4 KiB. */
  LOG_MAX_BYTES: "HIKOUTEI_LOG_MAX_BYTES",
  /** Rotated backup files kept. Defaults to 5; minimum 0 (truncate). */
  LOG_BACKUPS: "HIKOUTEI_LOG_BACKUPS",
} as const;

/** Emission levels, ordered from most to least verbose. */
export const HIKOUTEI_LOG_LEVELS = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
} as const;

/** One emission level. */
export type HikouteiInternalLogLevel =
  (typeof HIKOUTEI_LOG_LEVELS)[keyof typeof HIKOUTEI_LOG_LEVELS];

const LEVEL_ORDER: Readonly<Record<HikouteiInternalLogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Default level applied when the env var is absent or malformed. */
const DEFAULT_LOG_LEVEL: HikouteiInternalLogLevel = HIKOUTEI_LOG_LEVELS.INFO;
/** Default rotation threshold applied when the env var is absent/malformed (10 MiB). */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** Floor for the rotation threshold so rotation cannot thrash per line. */
const MIN_MAX_BYTES = 4096;
/** Default rotated backup count (matches the approved soak plan). */
export const DEFAULT_BACKUPS = 5;
/** Upper bound for rotated backups to keep rename chains bounded. */
const MAX_BACKUPS = 20;
/** Consecutive sink failures before the logger degrades to a silent no-op. */
const SINK_FAILURE_LIMIT = 3;

/** Marker substituted for any field value that fails its allowlist check. */
const REDACTED = "[redacted]";

/** Set of every stable event name the log may carry. */
const EVENT_ALLOWLIST: ReadonlySet<string> = new Set(Object.values(HIKOUTEI_LOG_EVENTS));
/** Set of every stable component tag the log may carry. */
const COMPONENT_ALLOWLIST: ReadonlySet<string> = new Set(Object.values(HIKOUTEI_LOG_COMPONENTS));
/** Set of every stable error code the log may carry. */
const CODE_ALLOWLIST: ReadonlySet<string> = new Set(HIKOUTEI_LOG_STABLE_CODES);
/** Set of every stable error class name the log may carry. */
const CLASS_ALLOWLIST: ReadonlySet<string> = new Set(HIKOUTEI_LOG_STABLE_CLASSES);
/** Set of every stable provider-operation tag the log may carry. */
const PROVIDER_OPERATION_ALLOWLIST: ReadonlySet<string> = new Set([
  ...HIKOUTEI_LOG_PROVIDER_OPERATIONS,
  // The request-telemetry boundary logs the transport's own operation names
  // (`GoogleSheetsApiRequestEvent.operation`) in the same structured field.
  ...HIKOUTEI_LOG_TRANSPORT_OPERATIONS,
]);
/** Set of every stable provider-reason tag the log may carry. */
const PROVIDER_REASON_ALLOWLIST: ReadonlySet<string> = new Set(HIKOUTEI_LOG_PROVIDER_REASONS);
/** Set of every stable request-start pacing lane the log may carry. */
const REQUEST_START_PACING_ALLOWLIST: ReadonlySet<string> = new Set([
  "polling",
  "preflight",
  "write",
]);
/** Table/entity-name allowlist (matches the public SQL identifier rules). */
const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * One structured log entry.
 *
 * Every field is optional except `event`. Only these fields are serialized;
 * unknown properties on the input object are dropped by the writer.
 */
export interface HikouteiInternalLogEntry {
  /** Stable dotted event name such as `hikoutei.em.flush_failed`. */
  readonly event: string;
  /** Emission level; defaults to info. */
  readonly level?: HikouteiInternalLogLevel;
  /** Owning subsystem tag such as `entity-manager` or `outbox`. */
  readonly component?: string;
  /** Stable machine-readable error code (e.g. a HikouteiError code). */
  readonly code?: string;
  /** Whether the described failure is transient and worth retrying. */
  readonly retryable?: boolean;
  /** Attempt counter for retried operations. */
  readonly attempts?: number;
  /** Sanitized entity/table scope; never a Sheet ID, URL, or row anchor. */
  readonly table?: string;
  /** Sanitized error class name such as `HikouteiError`. */
  readonly errorClass?: string;
  /** Allowlisted provider operation the invalid state was detected in. */
  readonly providerOperation?: string;
  /** Allowlisted provider reason for the invalid state. */
  readonly providerReason?: string;
  /** Request-start pacing lane (`polling`, `preflight`, or `write`). */
  readonly pacing?: string;
  /** Operation duration in milliseconds. */
  readonly durationMs?: number;
  /** Numeric context only (counts, sizes). Non-numeric values are dropped. */
  readonly counts?: Readonly<Record<string, number>>;
}

/** Result of validating one entry: the serializable field set or a reason. */
export type LogEntryValidation =
  | { readonly status: "valid"; readonly line: string }
  | { readonly status: "invalid"; readonly reason: string };

/** Handle over one configured log file. */
export interface HikouteiInternalLogger {
  /** True when logging is enabled and the sink has not degraded. */
  readonly enabled: boolean;
  /** Effective minimum level (always defined, even when disabled). */
  readonly level: HikouteiInternalLogLevel;
  /** Resolved log file path (undefined when disabled). */
  readonly filePath: string | undefined;
  /** Enqueues one entry; returns false when the entry was filtered/dropped. */
  log(entry: HikouteiInternalLogEntry): boolean;
  /** Waits for every queued write (and rotation) to settle. Test support. */
  drain(): Promise<void>;
}

/** Injectable clock so tests can pin timestamps. */
export type InternalLoggerClock = () => Date;

export interface CreateInternalLoggerOptions {
  /** Environment map; defaults to an empty map (logging disabled). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: InternalLoggerClock;
}

/**
 * Builds one JSONL line from an entry, applying the redaction allowlists.
 *
 * Exported for focused redaction tests. Returns `invalid` only when the
 * entry is not an object or carries no usable `event`; callers treat that
 * as a silent drop (fail-open).
 */
export function formatHikouteiLogLine(
  entry: HikouteiInternalLogEntry,
  now: Date = new Date(),
): LogEntryValidation {
  if (entry === null || typeof entry !== "object") {
    return { status: "invalid", reason: "entry-not-object" };
  }
  const record = entry as unknown as Record<string, unknown>;
  const event = sanitizeAllowlisted(record.event, EVENT_ALLOWLIST);
  // A missing, non-string, or non-allowlisted event name is not a loggable
  // entry: drop the line entirely (fail-open) instead of emitting a
  // redaction hint.
  if (event === undefined || event === REDACTED) {
    return { status: "invalid", reason: "event-missing-or-unsafe" };
  }
  const line: Record<string, unknown> = {
    ts: now.toISOString(),
    level: isLogLevel(record.level) ? record.level : HIKOUTEI_LOG_LEVELS.INFO,
    event,
  };
  setIfDefined(line, "component", sanitizeAllowlisted(record.component, COMPONENT_ALLOWLIST));
  setIfDefined(line, "code", sanitizeAllowlisted(record.code, CODE_ALLOWLIST));
  setIfDefined(line, "table", sanitizeTableField(record.table));
  setIfDefined(line, "errorClass", sanitizeAllowlisted(record.errorClass, CLASS_ALLOWLIST));
  setIfDefined(line, "providerOperation", sanitizeAllowlisted(record.providerOperation, PROVIDER_OPERATION_ALLOWLIST));
  setIfDefined(line, "providerReason", sanitizeAllowlisted(record.providerReason, PROVIDER_REASON_ALLOWLIST));
  setIfDefined(line, "pacing", sanitizeAllowlisted(record.pacing, REQUEST_START_PACING_ALLOWLIST));
  setIfDefined(line, "retryable", typeof record.retryable === "boolean" ? record.retryable : undefined);
  setIfDefined(line, "attempts", safeCountField(record.attempts));
  setIfDefined(line, "durationMs", safeCountField(record.durationMs));
  const counts = sanitizeCounts(record.counts);
  if (counts !== undefined) line.counts = counts;
  return { status: "valid", line: `${JSON.stringify(line)}\n` };
}

/**
 * Creates the internal file logger from an environment map.
 *
 * When `HIKOUTEI_LOG_FILE` is absent or blank the returned logger is a
 * disabled no-op. Malformed numeric env values fall back to the defaults
 * (fail-open) instead of throwing.
 */
export function createHikouteiInternalLogger(
  options: CreateInternalLoggerOptions = {},
): HikouteiInternalLogger {
  const env = options.env ?? {};
  const now = options.now ?? (() => new Date());
  const rawPath = env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE];
  const level = parseLogLevel(env[HIKOUTEI_LOG_ENV_KEYS.LOG_LEVEL]);
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return disabledLogger(level);
  }
  const filePath = ensureTxtExtension(rawPath.trim());
  const maxBytes = parseBoundedInteger(
    env[HIKOUTEI_LOG_ENV_KEYS.LOG_MAX_BYTES],
    DEFAULT_MAX_BYTES,
    MIN_MAX_BYTES,
    Number.MAX_SAFE_INTEGER,
  );
  const backups = parseBoundedInteger(
    env[HIKOUTEI_LOG_ENV_KEYS.LOG_BACKUPS],
    DEFAULT_BACKUPS,
    0,
    MAX_BACKUPS,
  );
  return new EnabledInternalLogger(filePath, level, maxBytes, backups, now);
}

/** Process-wide logger resolved lazily from `process.env` (cached). */
let processLogger: HikouteiInternalLogger | undefined;

/**
 * Returns the cached process logger, creating it from `process.env` on first
 * use. Boundary call sites use this plus {@link logHikouteiInternalEvent};
 * both are silent no-ops when file logging is not opted in.
 */
export function getHikouteiInternalLogger(): HikouteiInternalLogger {
  if (processLogger === undefined) {
    processLogger = createHikouteiInternalLogger({ env: process.env });
  }
  return processLogger;
}

/**
 * Emits one entry through the process logger, swallowing every failure.
 *
 * This is the boundary call-site helper: it never throws, never blocks (the
 * write is queued), and returns immediately when logging is disabled.
 */
export function logHikouteiInternalEvent(entry: HikouteiInternalLogEntry): void {
  try {
    getHikouteiInternalLogger().log(entry);
  } catch {
    // Fail-open by contract: logging can never affect caller behavior.
  }
}

/** Test hook: drops the cached process logger so a new env is honored. */
export function resetHikouteiInternalLoggerForTests(): void {
  processLogger = undefined;
}

/**
 * Emits the single stable WARN for ENTERING a writer-lease startup wait
 * (every startup wait-gate site and the sync bootstrap's injected callback
 * share this shape). Callers that need once-per-startup semantics latch this
 * at their own boundary; the log module stays emission-only.
 */
export function logWriterLeaseStartupWait(): void {
  logHikouteiInternalEvent({
    event: HIKOUTEI_LOG_EVENTS.WRITER_LEASE_UNAVAILABLE,
    level: HIKOUTEI_LOG_LEVELS.WARN,
    component: HIKOUTEI_LOG_COMPONENTS.OUTBOX,
    counts: { startupWait: 1 },
  });
}

/** True once the value is one of the known levels. */
function isLogLevel(value: unknown): value is HikouteiInternalLogLevel {
  return value === HIKOUTEI_LOG_LEVELS.DEBUG ||
    value === HIKOUTEI_LOG_LEVELS.INFO ||
    value === HIKOUTEI_LOG_LEVELS.WARN ||
    value === HIKOUTEI_LOG_LEVELS.ERROR;
}

function parseLogLevel(raw: string | undefined): HikouteiInternalLogLevel {
  if (typeof raw !== "string") return DEFAULT_LOG_LEVEL;
  const normalized = raw.trim().toLowerCase();
  return isLogLevel(normalized) ? normalized : DEFAULT_LOG_LEVEL;
}

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof raw !== "string" || raw.trim() === "" || !/^\d+$/.test(raw.trim())) {
    return fallback;
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Forces the `.txt` extension required by the log-collection contract.
 *
 * `hikoutei-log` becomes `hikoutei-log.txt`; an existing `.txt` suffix is
 * preserved as-is.
 */
export function ensureTxtExtension(filePath: string): string {
  return filePath.toLowerCase().endsWith(".txt") ? filePath : `${filePath}.txt`;
}

/** Rotated backup path for one base path and index (base `x.txt` -> `x.1.txt`). */
export function rotatedLogPath(filePath: string, index: number): string {
  const withoutTxt = filePath.slice(0, filePath.length - ".txt".length);
  return `${withoutTxt}.${index}.txt`;
}

function disabledLogger(level: HikouteiInternalLogLevel): HikouteiInternalLogger {
  return {
    enabled: false,
    level,
    filePath: undefined,
    log: () => false,
    drain: async () => undefined,
  };
}

class EnabledInternalLogger implements HikouteiInternalLogger {
  readonly filePath: string;
  private readonly minLevel: HikouteiInternalLogLevel;
  private readonly maxBytes: number;
  private readonly backups: number;
  private readonly now: InternalLoggerClock;
  private bytesWritten: number | undefined;
  private consecutiveFailures = 0;
  private degraded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    filePath: string,
    minLevel: HikouteiInternalLogLevel,
    maxBytes: number,
    backups: number,
    now: InternalLoggerClock,
  ) {
    this.filePath = filePath;
    this.minLevel = minLevel;
    this.maxBytes = maxBytes;
    this.backups = backups;
    this.now = now;
  }

  get level(): HikouteiInternalLogLevel {
    return this.minLevel;
  }

  /** False once the sink degraded, so callers stop relying on delivery. */
  get enabled(): boolean {
    return !this.degraded;
  }

  log(entry: HikouteiInternalLogEntry): boolean {
    if (this.degraded) return false;
    let validation: LogEntryValidation;
    try {
      validation = formatHikouteiLogLine(entry, this.now());
    } catch {
      return false;
    }
    if (validation.status === "invalid") return false;
    if (LEVEL_ORDER[lineLevel(validation.line)] < LEVEL_ORDER[this.minLevel]) return false;
    // Serialize through the queue so concurrent boundary calls keep a stable
    // order and the rotation size check can never interleave with a write.
    this.queue = this.queue.then(() => this.writeLine(validation.line)).catch(() => undefined);
    return true;
  }

  async drain(): Promise<void> {
    await this.queue;
  }

  private async writeLine(line: string): Promise<void> {
    if (this.degraded) return;
    try {
      if (this.bytesWritten === undefined) {
        const currentSize = await stat(this.filePath).then(
          (info) => info.size,
          () => 0,
        );
        this.bytesWritten = currentSize;
        // First write: ensure the parent directory exists so nested or
        // custom log paths work without operator setup. Idempotent and
        // fail-open (a failed mkdir counts against the sink failure
        // budget, exactly like any other append failure).
        await mkdir(dirname(this.filePath), { recursive: true });
      }
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (this.bytesWritten > 0 &&
        this.bytesWritten + lineBytes > this.maxBytes) {
        // A symlinked current file is rejected BEFORE rotation so the
        // link itself is never moved into the backup chain: the external
        // target stays byte-identical and untouched, exactly like the
        // rejected append below.
        await rejectSymlinkedLogFile(this.filePath);
        await this.rotate();
        this.bytesWritten = 0;
      }
      await appendNoFollow(this.filePath, line);
      this.bytesWritten += lineBytes;
      this.consecutiveFailures = 0;
    } catch {
      // Fail-open: degrade permanently after repeated failures so a broken
      // sink (unwritable path, full disk) cannot add latency or noise to
      // every flush, and never propagates an error to the caller.
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= SINK_FAILURE_LIMIT) {
        this.degraded = true;
      }
    }
  }

  private async rotate(): Promise<void> {
    if (this.backups < 1) {
      // Zero backups: replace the current file with a fresh empty one.
      await rm(this.filePath, { force: true });
      return;
    }
    await rm(rotatedLogPath(this.filePath, this.backups), { force: true });
    for (let index = this.backups; index > 1; index -= 1) {
      await rename(
        rotatedLogPath(this.filePath, index - 1),
        rotatedLogPath(this.filePath, index),
      ).catch(() => undefined);
    }
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await rename(this.filePath, rotatedLogPath(this.filePath, 1));
    } catch (error: unknown) {
      // A vanished current file is fine (nothing to move); anything else
      // surfaces through the write-path failure counter.
      if (!isNodeNoEntityError(error)) throw error;
    }
  }
}

function isNodeNoEntityError(error: unknown): boolean {
  return error !== null &&
    typeof error === "object" &&
    (error as { readonly code?: unknown }).code === "ENOENT";
}

/**
 * Rejects a symlinked log file before an append or rotation touches it.
 *
 * A pre-existing symlink at the log path must never be followed: the
 * append would write into the external target and rotation would move the
 * link into the backup chain. The rejection is fail-open — the caller's
 * sink failure counter absorbs it exactly like any other write failure,
 * and the external target is never appended to, truncated, or renamed. A
 * missing path is fine (the first write creates it).
 */
async function rejectSymlinkedLogFile(filePath: string): Promise<void> {
  const info = await lstat(filePath).catch((error: unknown) => {
    if (isNodeNoEntityError(error)) return undefined;
    throw error;
  });
  if (info !== undefined && info.isSymbolicLink()) {
    throw new Error(`refusing to write through a symlinked log file: ${filePath}`);
  }
}

/**
 * Appends one line to the log file without ever following a pre-existing
 * symlink at the path.
 *
 * Where the platform provides `O_NOFOLLOW`, the open uses
 * `O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW`: a pre-existing symlink at
 * the log path makes the open fail (ELOOP) instead of writing through it,
 * so the external target is never appended to or truncated (`O_APPEND`
 * never truncates). On platforms without `O_NOFOLLOW` the path is
 * rejected via `lstat` first (best effort — a link planted between the
 * check and the open cannot be detected without the flag), then appended
 * through the plain handle. Every rejection is fail-open: the caller's
 * failure counter absorbs it exactly like any other sink failure.
 */
async function appendNoFollow(filePath: string, line: string): Promise<void> {
  const noFollowFlag = constants.O_NOFOLLOW;
  if (noFollowFlag !== undefined) {
    const handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollowFlag,
      0o644,
    );
    try {
      await handle.appendFile(line, "utf8");
    } finally {
      await handle.close();
    }
    return;
  }
  // Platform fallback: best-effort lstat rejection, then the plain
  // append open. A rejection here is a sink failure like any other.
  await rejectSymlinkedLogFile(filePath);
  const handle = await open(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    0o644,
  );
  try {
    await handle.appendFile(line, "utf8");
  } finally {
    await handle.close();
  }
}

/** Reads the level back out of a formatted line (level is always present). */
function lineLevel(line: string): HikouteiInternalLogLevel {
  try {
    const parsed = JSON.parse(line) as { readonly level?: unknown };
    return isLogLevel(parsed.level) ? parsed.level : HIKOUTEI_LOG_LEVELS.INFO;
  } catch {
    return HIKOUTEI_LOG_LEVELS.INFO;
  }
}

function sanitizeAllowlisted(
  value: unknown,
  allowlist: ReadonlySet<string>,
): string | undefined {
  if (typeof value !== "string") return undefined;
  return allowlist.has(value) ? value : REDACTED;
}

function sanitizeTableField(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return TABLE_NAME_PATTERN.test(value) ? value : REDACTED;
}

function safeCountField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeCounts(
  value: unknown,
): Readonly<Record<string, number>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const sanitized: Record<string, number> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    // Count keys are trusted-shaped identifiers; the VALUES are the only
    // free-form part and must be finite numbers, so no secret text can
    // enter through a counts entry.
    if (!TABLE_NAME_PATTERN.test(key)) continue;
    const numeric = safeCountField(entryValue);
    if (numeric !== undefined) sanitized[key] = numeric;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function setIfDefined(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Extracts a sanitized error class/code pair for boundary logging.
 *
 * Returns only the constructor name and, for `HikouteiError`-shaped errors,
 * the stable `code` string. The error `message` is deliberately never
 * returned: messages can embed emails, spreadsheet IDs, and paths.
 */
export function describeErrorForInternalLog(
  error: unknown,
): { readonly errorClass: string; readonly code?: string } {
  const errorClass = error !== null &&
      typeof error === "object" &&
      typeof (error as { readonly name?: unknown }).name === "string" &&
      (error as { readonly name: string }).name.length > 0
    ? (error as { readonly name: string }).name
    : "UnknownError";
  const code = error !== null &&
      typeof error === "object" &&
      typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : undefined;
  return code === undefined ? { errorClass } : { errorClass, code };
}

/**
 * Stable, allowlisted error tag for DEFAULT console diagnostics.
 *
 * Emits only error-class names from the stable class allowlist and codes
 * from the stable code allowlist; unknown values collapse to the fixed
 * `unknown` category. The raw message, stack, path, URL, id, and email can
 * never reach a default console warning — injected diagnostic hooks and
 * thrown public errors keep their full contracts unchanged.
 */
export function stableConsoleErrorTag(error: unknown): string {
  const described = describeErrorForInternalLog(error);
  const errorClass = CLASS_ALLOWLIST.has(described.errorClass)
    ? described.errorClass
    : "unknown";
  if (described.code === undefined) return errorClass;
  return CODE_ALLOWLIST.has(described.code)
    ? `${errorClass} (${described.code})`
    : errorClass;
}
