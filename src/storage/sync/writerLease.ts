/**
 * SQLite writer lease and fencing token management.
 *
 * Per design concurrency/writer-rpc.md:
 * - Single writer owns all canonical/outbox mutations.
 * - Every mutation CAS-checks the current fencing token.
 * - Lease takeover increments epoch + fencing token.
 * - Stale fencing tokens are rejected even if the affected row hasn't changed.
 */

import type { DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { STORAGE_ERROR_CODES, StorageError } from "../errors.js";
import { LOOKUP_RESULT_KINDS } from "../../core/state/constants.js";
import type { LookupResult } from "../../core/state/types.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../adapter/persistence/contracts/sql.js";
import { withSqlSavepoint } from "../sqlite/sqlTransaction.js";

const READ_WRITER_LEASE_SQL =
  "SELECT role, writer_id, writer_epoch, fencing_token, lease_until FROM writer_lease WHERE role = ?";

const INSERT_WRITER_LEASE_SQL = `
  INSERT INTO writer_lease (role, writer_id, writer_epoch, fencing_token, lease_until)
  VALUES (?, ?, ?, ?, ?)
`;

const RENEW_WRITER_LEASE_SQL = `
  UPDATE writer_lease
  SET lease_until = ?
  WHERE role = ? AND writer_id = ? AND writer_epoch = ?
    AND fencing_token = ? AND lease_until > ?
`;

const TAKEOVER_WRITER_LEASE_SQL = `
  UPDATE writer_lease
  SET writer_id = ?, writer_epoch = ?, fencing_token = ?, lease_until = ?
  WHERE role = ? AND writer_epoch = ? AND fencing_token = ? AND lease_until <= ?
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
}

/** The current lease identity required for a fenced storage mutation. */
export interface FencingContext {
  readonly role: string;
  readonly writerEpoch: number;
  readonly fencingToken: string;
  readonly now: number;
}

/**
 * Claims or renews the writer lease for a role.
 *
 * If no lease exists, creates one with epoch 1.
 * If the current lease belongs to this writer, renews it.
 * If the current lease has expired, takes over with incremented epoch + new fencing token.
 * If the current lease is held by another active writer, returns a typed failure.
 */
export function claimWriterLease(
  db: DatabaseSyncLike,
  options: ClaimLeaseOptions,
): WriterLeaseClaimResult {
  validateClaimOptions(options);

  return withSavepoint(db, "claim_writer_lease", () => {
    const existing = readLeaseRow(db, options.role);
    const newLeaseUntil = options.now + options.leaseDurationMs;

    if (existing === undefined) {
      const lease = makeLease(options.role, options.writerId, 1, newLeaseUntil);
      const result = db.prepare(INSERT_WRITER_LEASE_SQL).run(
        lease.role,
        lease.writerId,
        lease.writerEpoch,
        lease.fencingToken,
        lease.leaseUntil,
      );
      return result.changes === 1
        ? { kind: WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED, lease }
        : {
            kind: WRITER_LEASE_CLAIM_RESULT_KINDS.NOT_CLAIMED,
            reason: WRITER_LEASE_CLAIM_FAILURE_REASONS.INITIAL_CLAIM_NOT_APPLIED,
          };
    }

    if (existing.writer_id === options.writerId && existing.lease_until > options.now) {
      const result = db.prepare(RENEW_WRITER_LEASE_SQL).run(
        newLeaseUntil,
        options.role,
        options.writerId,
        existing.writer_epoch,
        existing.fencing_token,
        options.now,
      );
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

    if (existing.lease_until > options.now) {
      return {
        kind: WRITER_LEASE_CLAIM_RESULT_KINDS.NOT_CLAIMED,
        reason: WRITER_LEASE_CLAIM_FAILURE_REASONS.ACTIVE_WRITER,
      };
    }

    // An expired owner, including the same process, must take a new epoch.
    // Reusing its old fence would allow delayed work to look current again.
    const takeover = makeLease(
      options.role,
      options.writerId,
      existing.writer_epoch + 1,
      newLeaseUntil,
    );
    const result = db.prepare(TAKEOVER_WRITER_LEASE_SQL).run(
      takeover.writerId,
      takeover.writerEpoch,
      takeover.fencingToken,
      takeover.leaseUntil,
      options.role,
      existing.writer_epoch,
      existing.fencing_token,
      options.now,
    );
    return result.changes === 1
      ? { kind: WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED, lease: takeover }
      : {
          kind: WRITER_LEASE_CLAIM_RESULT_KINDS.NOT_CLAIMED,
          reason: WRITER_LEASE_CLAIM_FAILURE_REASONS.TAKEOVER_RACE_LOST,
        };
  });
}

/**
 * Claims or renews a writer lease inside an already-active async SQL context.
 *
 * This is the MikroORM-compatible counterpart of `claimWriterLease()`. Call
 * it from a broader adapter transaction when the lease claim must be atomic
 * with an entity, canonical-state, or outbox mutation.
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

    if (existing.lease_until > options.now) {
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
      options.role,
      existing.writer_epoch,
      existing.fencing_token,
      options.now,
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

/** Reads the current lease for a role with an explicit not-found state. */
export function readWriterLease(db: DatabaseSyncLike, role: string): LookupResult<WriterLease> {
  const row = readLeaseRow(db, role);
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

/**
 * Checks whether the given epoch + fencing token match the current lease.
 * Used by effect workers to verify their claim is still valid before applying results.
 */
export function isFencingValid(db: DatabaseSyncLike, fence: FencingContext): boolean {
  const lease = readWriterLease(db, fence.role);
  if (lease.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) return false;
  return (
    lease.value.writerEpoch === fence.writerEpoch &&
    lease.value.fencingToken === fence.fencingToken &&
    lease.value.leaseUntil > fence.now
  );
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
}

function readLeaseRow(db: DatabaseSyncLike, role: string): LeaseRow | undefined {
  return db.prepare(READ_WRITER_LEASE_SQL).get(role) as LeaseRow | undefined;
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
    fencingToken: `fence-${writerEpoch}`,
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

function withSavepoint<T>(
  db: DatabaseSyncLike,
  name: string,
  operation: () => T,
): T {
  db.exec(`SAVEPOINT ${name}`);
  try {
    const value = operation();
    db.exec(`RELEASE ${name}`);
    return value;
  } catch (error: unknown) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}
