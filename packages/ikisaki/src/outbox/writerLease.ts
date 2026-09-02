/**
 * SQLite writer lease and fencing token management.
 *
 * - Single writer owns all canonical/outbox mutations.
 * - Every mutation CAS-checks the current fencing token.
 * - Lease takeover increments epoch + fencing token.
 * - Stale fencing tokens are rejected even if the affected row hasn't changed.
 */

import { STORAGE_ERROR_CODES, StorageError } from "../contract/errors.js";
import { LOOKUP_RESULT_KINDS } from "../contract/state.js";
import type { LookupResult } from "../contract/state.js";
import type { SqlExecutor, SqlStorageAdapter } from "../sql/sql.js";
import { withSqlSavepoint } from "../sql/sqlTransaction.js";

/**
 * Heartbeat renewal interval for a live writer lease. The supervisor (and any
 * host using `createWriterLeaseHeartbeat`) re-renews the lease and stamps
 * `writer_lease.heartbeat_at` at this cadence, so a dead process's lease
 * becomes takeable within the stale bound of its last renewal instead of
 * after the full lease duration.
 */
export const DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS = 5_000;
/**
 * Stale-heartbeat takeover evidence bound: a lease whose owner last stamped
 * `heartbeat_at` more than this long ago (while `lease_until` is still in the
 * future) is presumed dead and may be taken over. Must stay a comfortable
 * multiple of the heartbeat interval (3× by default) so a momentarily paused
 * event loop is never mistaken for a dead writer.
 */
export const DEFAULT_WRITER_LEASE_HEARTBEAT_STALE_MS = 15_000;
/**
 * Startup wait-gate cap: how long a relaunching runtime will poll a live
 * lease for its heartbeat to go stale before giving up. Stale bound (15s)
 * plus 10s of slack, so a crash→relaunch within the stale window succeeds
 * while a genuinely live writer (heartbeat keeps moving) is never waited out
 * indefinitely.
 */
export const DEFAULT_WRITER_LEASE_STARTUP_WAIT_MS = 25_000;

/**
 * Takeover evidence bound for one claim at timestamp `now`: the earliest
 * `heartbeat_at` that still counts as fresh. Clamped at zero so deterministic
 * test clocks cannot produce a negative (invalid) bound.
 */
export function writerLeaseHeartbeatStaleBoundMs(
  now: number,
  staleMs: number = DEFAULT_WRITER_LEASE_HEARTBEAT_STALE_MS,
): number {
  return Math.max(0, now - staleMs);
}

const READ_WRITER_LEASE_SQL =
  "SELECT role, writer_id, writer_epoch, fencing_token, lease_until, heartbeat_at FROM writer_lease WHERE role = ?";

const INSERT_WRITER_LEASE_SQL = `
  INSERT INTO writer_lease (role, writer_id, writer_epoch, fencing_token, lease_until, heartbeat_at)
  VALUES (?, ?, ?, ?, ?, ?)
`;

const RENEW_WRITER_LEASE_SQL = `
  UPDATE writer_lease
  SET lease_until = ?, heartbeat_at = ?
  WHERE role = ? AND writer_id = ? AND writer_epoch = ?
    AND fencing_token = ? AND lease_until > ?
`;

/**
 * Takeover CAS. A lease may be taken over when it EXPIRED (`lease_until <=
 * now`) or, only when the caller supplied heartbeat evidence bounds
 * (`staleBefore` non-NULL), when the owner stamped a stale heartbeat while
 * its lease is still nominally alive. Rows with a NULL heartbeat (legacy
 * databases, hosts that never heartbeat) stay on the expiry-only rule.
 */
const TAKEOVER_WRITER_LEASE_SQL = `
  UPDATE writer_lease
  SET writer_id = ?, writer_epoch = ?, fencing_token = ?, lease_until = ?, heartbeat_at = ?
  WHERE role = ? AND writer_epoch = ? AND fencing_token = ?
    AND (lease_until <= ? OR (heartbeat_at IS NOT NULL AND heartbeat_at <= ?))
`;

const RELEASE_WRITER_LEASE_SQL = `
  UPDATE writer_lease
  SET lease_until = ?
  WHERE role = ? AND writer_id = ? AND writer_epoch = ? AND fencing_token = ?
`;

export interface WriterLease {
  readonly role: string;
  readonly writerId: string;
  readonly writerEpoch: number;
  readonly fencingToken: string;
  readonly leaseUntil: number;
}

/** Runtime values for the two observable writer-lease claim outcomes. */
export const WRITER_LEASE_CLAIM_RESULT_KINDS = {
  CLAIMED: "claimed",
  NOT_CLAIMED: "not_claimed",
} as const;

/** Closed set of writer-lease claim outcome kinds. */
export type WriterLeaseClaimResultKind =
  (typeof WRITER_LEASE_CLAIM_RESULT_KINDS)[keyof typeof WRITER_LEASE_CLAIM_RESULT_KINDS];

/** Runtime values explaining why a writer-lease claim did not succeed. */
export const WRITER_LEASE_CLAIM_FAILURE_REASONS = {
  ACTIVE_WRITER: "active_writer",
  INITIAL_CLAIM_NOT_APPLIED: "initial_claim_not_applied",
  RENEWAL_RACE_LOST: "renewal_race_lost",
  TAKEOVER_RACE_LOST: "takeover_race_lost",
} as const;

/** Closed set of writer-lease claim failure reasons. */
export type WriterLeaseClaimFailureReason =
  (typeof WRITER_LEASE_CLAIM_FAILURE_REASONS)[keyof typeof WRITER_LEASE_CLAIM_FAILURE_REASONS];

export type WriterLeaseClaimResult =
  | {
      readonly kind: typeof WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED;
      readonly lease: WriterLease;
    }
  | {
      readonly kind: typeof WRITER_LEASE_CLAIM_RESULT_KINDS.NOT_CLAIMED;
      readonly reason: WriterLeaseClaimFailureReason;
    };

export interface ClaimLeaseOptions {
  readonly role: string;
  readonly writerId: string;
  readonly leaseDurationMs: number;
  readonly now: number;
  /**
   * Takeover evidence bound for the DEAD-writer heartbeat rule: the earliest
   * `writer_lease.heartbeat_at` timestamp that still counts as fresh. When
   * set, a lease whose owner last heartbeated BEFORE this bound may be taken
   * over even while `lease_until` is in the future (the owner is presumed
   * dead or event-loop-paused). When undefined, takeover stays strictly
   * expiry-based and NULL-heartbeat rows are unaffected either way.
   */
  readonly heartbeatStaleBeforeMs?: number;
}

/** Identity of one writer lease a runtime may expire on graceful shutdown. */
export interface ReleaseWriterLeaseOptions {
  readonly role: string;
  readonly writerId: string;
  readonly writerEpoch: number;
  readonly fencingToken: string;
  readonly now: number;
}

/** The current lease identity required for a fenced storage mutation. */
export interface FencingContext {
  readonly role: string;
  readonly writerEpoch: number;
  readonly fencingToken: string;
  readonly now: number;
}

/** SQL fragment used to fence mutations against the current writer lease. */
export const FENCE_EXISTS_SQL = `
  SELECT 1 FROM writer_lease
  WHERE role = ? AND writer_epoch = ? AND fencing_token = ? AND lease_until > ?
`;

/** Returns the parameter tuple shared by every fenced SQL statement. */
export function fenceParameters(
  fence: FencingContext,
): readonly [string, number, string, number] {
  return [fence.role, fence.writerEpoch, fence.fencingToken, fence.now];
}

/**
 * Claims or renews a writer lease inside an already-active async SQL context.
 *
 * Call it from a broader adapter transaction when the lease claim must be
 * atomic with an entity, canonical-state, or outbox mutation.
 */
export async function claimWriterLeaseWithSql(
  sql: SqlExecutor,
  options: ClaimLeaseOptions,
): Promise<WriterLeaseClaimResult> {
  validateClaimOptions(options);

  return withSqlSavepoint(sql, "claim_writer_lease", async () => {
    const existing = await readLeaseRowWithSql(sql, options.role);
    const newLeaseUntil = options.now + options.leaseDurationMs;

    if (existing === undefined) {
      const lease = makeLease(options.role, options.writerId, 1, newLeaseUntil);
      const result = await sql.run(INSERT_WRITER_LEASE_SQL, [
        lease.role,
        lease.writerId,
        lease.writerEpoch,
        lease.fencingToken,
        lease.leaseUntil,
        options.now,
      ]);
      return result.changes === 1
        ? { kind: WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED, lease }
        : {
            kind: WRITER_LEASE_CLAIM_RESULT_KINDS.NOT_CLAIMED,
            reason: WRITER_LEASE_CLAIM_FAILURE_REASONS.INITIAL_CLAIM_NOT_APPLIED,
          };
    }

    if (existing.writer_id === options.writerId && existing.lease_until > options.now) {
      const result = await sql.run(RENEW_WRITER_LEASE_SQL, [
        newLeaseUntil,
        options.now,
        options.role,
        options.writerId,
        existing.writer_epoch,
        existing.fencing_token,
        options.now,
      ]);
      return result.changes === 1
        ? {
            kind: WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED,
            lease: {
              role: existing.role,
              writerId: existing.writer_id,
              writerEpoch: existing.writer_epoch,
              fencingToken: existing.fencing_token,
              leaseUntil: newLeaseUntil,
            },
          }
        : {
            kind: WRITER_LEASE_CLAIM_RESULT_KINDS.NOT_CLAIMED,
            reason: WRITER_LEASE_CLAIM_FAILURE_REASONS.RENEWAL_RACE_LOST,
          };
    }

    // Expired leases are always takeable. A live lease is takeable only when
    // the caller supplied heartbeat evidence bounds AND the owner last
    // heartbeated before it (presumed dead or paused). NULL heartbeats never
    // satisfy the stale rule, so legacy rows keep the expiry-only behavior.
    const heartbeatStale =
      options.heartbeatStaleBeforeMs !== undefined &&
      existing.heartbeat_at !== null &&
      existing.heartbeat_at <= options.heartbeatStaleBeforeMs;
    if (existing.lease_until > options.now && !heartbeatStale) {
      return {
        kind: WRITER_LEASE_CLAIM_RESULT_KINDS.NOT_CLAIMED,
        reason: WRITER_LEASE_CLAIM_FAILURE_REASONS.ACTIVE_WRITER,
      };
    }

    const takeover = makeLease(
      options.role,
      options.writerId,
      existing.writer_epoch + 1,
      newLeaseUntil,
    );
    const result = await sql.run(TAKEOVER_WRITER_LEASE_SQL, [
      takeover.writerId,
      takeover.writerEpoch,
      takeover.fencingToken,
      takeover.leaseUntil,
      options.now,
      options.role,
      existing.writer_epoch,
      existing.fencing_token,
      options.now,
      options.heartbeatStaleBeforeMs ?? null,
    ]);
    return result.changes === 1
      ? { kind: WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED, lease: takeover }
      : {
          kind: WRITER_LEASE_CLAIM_RESULT_KINDS.NOT_CLAIMED,
          reason: WRITER_LEASE_CLAIM_FAILURE_REASONS.TAKEOVER_RACE_LOST,
        };
  });
}

/** Claims or renews a writer lease in one adapter-owned transaction. */
export async function claimWriterLeaseWithAdapter(
  storage: SqlStorageAdapter,
  options: ClaimLeaseOptions,
): Promise<WriterLeaseClaimResult> {
  return storage.transaction(({ sql }) => claimWriterLeaseWithSql(sql, options));
}

/** Runtime values for the observable renew-only heartbeat outcomes. */
export const WRITER_LEASE_RENEW_RESULT_KINDS = {
  RENEWED: "renewed",
  NOT_HELD: "not_held",
} as const;

/** Closed set of renew-only heartbeat outcome kinds. */
export type WriterLeaseRenewResultKind =
  (typeof WRITER_LEASE_RENEW_RESULT_KINDS)[keyof typeof WRITER_LEASE_RENEW_RESULT_KINDS];

export type WriterLeaseRenewResult =
  | {
      readonly kind: typeof WRITER_LEASE_RENEW_RESULT_KINDS.RENEWED;
      /** Epoch and fencing token are UNCHANGED by a renewal. */
      readonly lease: WriterLease;
    }
  | {
      /**
       * The lease row is absent, owned by another writer, or expired. A
       * renew-only heartbeat NEVER takes over: takeover is exclusively the
       * worker pass's claim decision, so a background heartbeat can never
       * steal the lease back from a live owner and cause ping-pong.
       */
      readonly kind: typeof WRITER_LEASE_RENEW_RESULT_KINDS.NOT_HELD;
    };

export interface RenewLeaseOptions {
  readonly role: string;
  readonly writerId: string;
  readonly leaseDurationMs: number;
  readonly now: number;
}

const RENEW_HEARTBEAT_SQL = `
  UPDATE writer_lease
  SET lease_until = ?, heartbeat_at = ?
  WHERE role = ? AND writer_id = ? AND writer_epoch = ?
    AND fencing_token = ? AND lease_until > ?
`;

/**
 * Renew-only writer-lease heartbeat inside an already-active SQL context.
 *
 * Extends the caller's OWN live lease and stamps `heartbeat_at = now`. Never
 * claims a fresh lease, never takes another writer's lease over: a failed
 * renewal simply reports `not_held`, leaving takeover decisions to the
 * worker pass's `claimWriterLease` path.
 */
export async function renewWriterLeaseWithSql(
  sql: SqlExecutor,
  options: RenewLeaseOptions,
): Promise<WriterLeaseRenewResult> {
  validateClaimOptions({
    role: options.role,
    writerId: options.writerId,
    leaseDurationMs: options.leaseDurationMs,
    now: options.now,
  });
  const existing = await readLeaseRowWithSql(sql, options.role);
  if (
    existing === undefined ||
    existing.writer_id !== options.writerId ||
    existing.lease_until <= options.now
  ) {
    return { kind: WRITER_LEASE_RENEW_RESULT_KINDS.NOT_HELD };
  }
  const leaseUntil = options.now + options.leaseDurationMs;
  const result = await sql.run(RENEW_HEARTBEAT_SQL, [
    leaseUntil,
    options.now,
    options.role,
    options.writerId,
    existing.writer_epoch,
    existing.fencing_token,
    options.now,
  ]);
  return result.changes === 1
    ? {
        kind: WRITER_LEASE_RENEW_RESULT_KINDS.RENEWED,
        lease: {
          role: options.role,
          writerId: options.writerId,
          writerEpoch: existing.writer_epoch,
          fencingToken: existing.fencing_token,
          leaseUntil,
        },
      }
    : { kind: WRITER_LEASE_RENEW_RESULT_KINDS.NOT_HELD };
}

/** Renews the caller's own writer lease in one adapter-owned transaction. */
export async function renewWriterLeaseWithAdapter(
  storage: SqlStorageAdapter,
  options: RenewLeaseOptions,
): Promise<WriterLeaseRenewResult> {
  return storage.transaction(({ sql }) => renewWriterLeaseWithSql(sql, options));
}

/**
 * Expires the caller's own writer lease inside an already-active async SQL context.
 *
 * Graceful-shutdown handoff: the UPDATE is CAS-guarded on the exact lease row
 * this writer holds (role, writer id, epoch, fencing token), so an abnormal
 * exit or a concurrent takeover never expires another writer's lease. The row
 * is kept, never deleted, because spreadsheet-authority records compare epoch
 * ordering: deleting the row would reset the epoch to 1 and leave the recorded
 * authority permanently fenced out. The next claim funnels into the existing
 * TAKEOVER path and bumps the epoch by one.
 *
 * Returns true when this writer's own lease row was expired, false when the
 * row is absent or already owned by a different (newer) writer.
 */
export async function releaseWriterLeaseWithSql(
  sql: SqlExecutor,
  options: ReleaseWriterLeaseOptions,
): Promise<boolean> {
  validateReleaseOptions(options);
  const result = await sql.run(RELEASE_WRITER_LEASE_SQL, [
    options.now,
    options.role,
    options.writerId,
    options.writerEpoch,
    options.fencingToken,
  ]);
  return result.changes === 1;
}

/** Expires the caller's own writer lease in one adapter-owned transaction. */
export async function releaseWriterLeaseWithAdapter(
  storage: SqlStorageAdapter,
  options: ReleaseWriterLeaseOptions,
): Promise<boolean> {
  return storage.transaction(({ sql }) => releaseWriterLeaseWithSql(sql, options));
}

/** Reads a writer lease through an already-active async SQL context. */
export async function readWriterLeaseWithSql(
  sql: SqlExecutor,
  role: string,
): Promise<LookupResult<WriterLease>> {
  const row = await readLeaseRowWithSql(sql, role);
  return row === undefined
    ? { kind: LOOKUP_RESULT_KINDS.NOT_FOUND }
    : {
        kind: LOOKUP_RESULT_KINDS.FOUND,
        value: {
          role: row.role,
          writerId: row.writer_id,
          writerEpoch: row.writer_epoch,
          fencingToken: row.fencing_token,
          leaseUntil: row.lease_until,
        },
      };
}

/** Reads a writer lease through a fresh adapter read context. */
export async function readWriterLeaseWithAdapter(
  storage: SqlStorageAdapter,
  role: string,
): Promise<LookupResult<WriterLease>> {
  return storage.read(({ sql }) => readWriterLeaseWithSql(sql, role));
}

/** Runtime values for the two observable startup wait-gate outcomes. */
export const WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS = {
  READY: "ready",
  FAILED: "failed",
} as const;

/** Closed set of startup wait-gate outcome kinds. */
export type WriterLeaseStartupWaitResultKind =
  (typeof WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS)[keyof typeof WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS];

/** Runtime values explaining why the startup wait-gate gave up. */
export const WRITER_LEASE_STARTUP_WAIT_FAILURE_REASONS = {
  /** Live lease with a NULL heartbeat: a legacy row is never waited out. */
  LIVE_LEGACY_LEASE: "live_legacy_lease",
  /** A live writer kept its heartbeat moving past the wait cap. */
  WAIT_CAP_REACHED: "wait_cap_reached",
} as const;

/** Closed set of startup wait-gate failure reasons. */
export type WriterLeaseStartupWaitFailureReason =
  (typeof WRITER_LEASE_STARTUP_WAIT_FAILURE_REASONS)[keyof typeof WRITER_LEASE_STARTUP_WAIT_FAILURE_REASONS];

export type WriterLeaseStartupWaitResult =
  | {
      readonly kind: typeof WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS.READY;
      /** Milliseconds actually waited before the lease became takeable. */
      readonly waitedMs: number;
    }
  | {
      readonly kind: typeof WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS.FAILED;
      readonly reason: WriterLeaseStartupWaitFailureReason;
      readonly waitedMs: number;
    };

export interface AwaitTakeoverableWriterLeaseOptions {
  readonly role: string;
  /**
   * The calling runtime's writer identity. A live lease ALREADY owned by this
   * id never needs waiting out: the caller's own claim CAS renews it (and
   * startup flows claim-then-reclaim the same role across entities/passes),
   * so the gate reports `ready` immediately when `writer_id` matches.
   */
  readonly writerId?: string;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Heartbeat stale bound; defaults to {@link DEFAULT_WRITER_LEASE_HEARTBEAT_STALE_MS}. */
  readonly staleMs?: number;
  /** Total wait cap; defaults to {@link DEFAULT_WRITER_LEASE_STARTUP_WAIT_MS}. */
  readonly maxWaitMs?: number;
  /** Injectable sleep; defaults to a `setTimeout`-based promise. */
  readonly wait?: (ms: number) => Promise<void>;
  /**
   * Fired at WAIT ENTRY: exactly once per gate invocation, immediately before
   * the first actual sleep, so callers can surface a warning while the startup
   * is still waiting (never after the wait has already returned). Immediates
   * (`ready`/`failed` with zero wait) never fire it. Multiple gate calls in
   * one startup each fire at most once; the caller latches for a
   * once-per-startup warning.
   */
  readonly onWaitEntry?: (() => void) | undefined;
}

/** Default sleep: a `setTimeout`-based promise. */
function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Startup wait gate: polls a live writer lease until it becomes takeable.
 *
 * A crash→relaunch within the stale-heartbeat window cannot be told apart
 * from a live writer by a single read — the ONLY discriminator is waiting
 * until the OBSERVED `heartbeat_at` + stale bound and re-reading (live
 * writers keep moving `heartbeat_at` forward; dead ones freeze). This gate
 * performs that wait so the caller's fail-closed startup claim can succeed
 * instead of exiting with `sync_startup_failed`.
 *
 * Read-only by contract: every read goes through
 * {@link readWriterLeaseWithAdapter} (a read context, never a transaction)
 * and the gate never writes. The real claim stays a compare-and-set inside
 * the caller's own transaction, so this gate is purely advisory.
 *
 * Loop rules, in order:
 * 1. Row missing OR `lease_until <= now` OR the row is owned by the
 *    caller's own `writerId` → `ready` (the caller's claim renews its lease).
 * 2. `heartbeat_at === null` → `failed("live_legacy_lease")` immediately
 *    (a legacy row is never waited out).
 * 3. `heartbeat_at + staleMs <= now` → `ready` (takeover evidence valid).
 * 4. elapsed >= `maxWaitMs` → `failed("wait_cap_reached")` (a live writer
 *    kept its heartbeat moving).
 * 5. Otherwise sleep until `min(heartbeat_at + staleMs, start + maxWaitMs)`
 *    and loop. A target already in the past re-reads immediately; the fresh
 *    `now()` read at the top of each iteration advances the clock, so a real
 *    clock never busy-loops on a zero/negative sleep. `onWaitEntry` (when
 *    provided) fires once, immediately before the first actual sleep.
 */
export async function awaitTakeoverableWriterLeaseWithAdapter(
  storage: SqlStorageAdapter,
  options: AwaitTakeoverableWriterLeaseOptions,
): Promise<WriterLeaseStartupWaitResult> {
  const staleMs = options.staleMs ?? DEFAULT_WRITER_LEASE_HEARTBEAT_STALE_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_WRITER_LEASE_STARTUP_WAIT_MS;
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? defaultWait;
  const start = now();
  let waitEntryReported = false;

  for (;;) {
    const current = now();
    const lease = await readLeaseEvidenceWithAdapter(storage, options.role);
    if (
      lease === undefined ||
      lease.lease_until <= current ||
      (options.writerId !== undefined && lease.writer_id === options.writerId)
    ) {
      return { kind: WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS.READY, waitedMs: current - start };
    }
    if (lease.heartbeat_at === null) {
      return {
        kind: WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS.FAILED,
        reason: WRITER_LEASE_STARTUP_WAIT_FAILURE_REASONS.LIVE_LEGACY_LEASE,
        waitedMs: current - start,
      };
    }
    if (lease.heartbeat_at + staleMs <= current) {
      return { kind: WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS.READY, waitedMs: current - start };
    }
    if (current - start >= maxWaitMs) {
      return {
        kind: WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS.FAILED,
        reason: WRITER_LEASE_STARTUP_WAIT_FAILURE_REASONS.WAIT_CAP_REACHED,
        waitedMs: current - start,
      };
    }
    const target = Math.min(lease.heartbeat_at + staleMs, start + maxWaitMs);
    const sleepMs = target - current;
    if (sleepMs > 0) {
      if (!waitEntryReported) {
        waitEntryReported = true;
        options.onWaitEntry?.();
      }
      await wait(sleepMs);
    }
    // sleepMs <= 0 means the target is already past: re-read immediately. The
    // fresh now() read at the top of the next iteration advances the clock.
  }
}

/** Reads the full lease row (including heartbeat evidence) through a read context. */
async function readLeaseEvidenceWithAdapter(
  storage: SqlStorageAdapter,
  role: string,
): Promise<LeaseRow | undefined> {
  return storage.read(({ sql }) => readLeaseRowWithSql(sql, role));
}

/** Checks a fencing token inside an already-active async SQL context. */
export async function isFencingValidWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<boolean> {
  const lease = await readWriterLeaseWithSql(sql, fence.role);
  if (lease.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) return false;
  return (
    lease.value.writerEpoch === fence.writerEpoch &&
    lease.value.fencingToken === fence.fencingToken &&
    lease.value.leaseUntil > fence.now
  );
}

/** Checks a fencing token through a fresh adapter read context. */
export async function isFencingValidWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
): Promise<boolean> {
  return storage.read(({ sql }) => isFencingValidWithSql(sql, fence));
}

interface LeaseRow {
  readonly role: string;
  readonly writer_id: string;
  readonly writer_epoch: number;
  readonly fencing_token: string;
  readonly lease_until: number;
  readonly heartbeat_at: number | null;
}

function readLeaseRowWithSql(sql: SqlExecutor, role: string): Promise<LeaseRow | undefined> {
  return sql.get<LeaseRow>(READ_WRITER_LEASE_SQL, [role]);
}

function makeLease(
  role: string,
  writerId: string,
  writerEpoch: number,
  leaseUntil: number,
): WriterLease {
  return {
    role,
    writerId,
    writerEpoch,
    // Include the owner identity as well as the monotonically increasing epoch;
    // the token is unique per (epoch, writer identity). Roles of one runtime
    // may legitimately share it at an equal epoch (the mapped writer and the
    // effect worker default to the same writer id); FENCE_EXISTS_SQL still
    // keeps the roles distinct because it matches the role column too.
    fencingToken: `fence-${writerEpoch}:${writerId}`,
    leaseUntil,
  };
}

function validateClaimOptions(options: ClaimLeaseOptions): void {
  if (!Number.isSafeInteger(options.now) || options.now < 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS,
      "writer lease now must be a non-negative safe integer",
    );
  }
  if (options.heartbeatStaleBeforeMs !== undefined &&
      (!Number.isSafeInteger(options.heartbeatStaleBeforeMs) || options.heartbeatStaleBeforeMs < 0)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS,
      "writer lease heartbeat stale bound must be a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS,
      "writer lease duration must be a positive safe integer",
    );
  }
  if (options.role.length === 0 || options.writerId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS,
      "writer lease role and writer ID are required",
    );
  }
}

function validateReleaseOptions(options: ReleaseWriterLeaseOptions): void {
  if (!Number.isSafeInteger(options.now) || options.now < 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS,
      "writer lease now must be a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(options.writerEpoch)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS,
      "writer lease epoch must be a safe integer",
    );
  }
  if (options.role.length === 0 || options.writerId.length === 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_WRITER_LEASE_OPTIONS,
      "writer lease role and writer ID are required",
    );
  }
}

export async function requireCurrentFenceWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<void> {
  if (!(await isFencingValidWithSql(sql, fence))) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "writer fencing is stale or expired",
    );
  }
}

/** Internal control-flow signal that forces the enclosing async savepoint to roll back. */
export class AsyncFenceLostError extends Error {}

export function validateEffectLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "effect lease duration must be a positive safe integer",
    );
  }
}

export function validateReadyEffectLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "ready effect limit must be a positive safe integer",
    );
  }
}
