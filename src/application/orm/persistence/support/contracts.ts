/**
 * Internal contracts shared by the mapped persistence modules.
 *
 * Public flush options are kept here as well so the coordinator entrypoint can
 * stay focused on orchestration while row, projection, and SQL helpers share a
 * single set of contracts.
 */

import type {
  EffectStatus,
  EffectTargetKind,
} from "@hikoutei/contracts/domain/model/constants.js";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import type {
  SyncTimingSink,
} from "../../../sync/telemetry/syncTiming.js";
import type {
  CanonicalCommitInput,
  CanonicalFieldWrite,
} from "../../../../infrastructure/storage/state/canonical/canonicalCommit.js";
import type {
  FencingContext,
  NewEffect,
} from "@hikoutei/ikisaki";
import type {
  RegisteredSyncSheet,
} from "../../../../infrastructure/storage/sync/shared/syncRegistry.js";
import type { SqlExecutor, SqlStorageAdapter } from "@hikoutei/contracts/storage/sql.js";
import type {
  ScalarEntityFlushChange,
  ScalarEntityFlushContext,
  ScalarEntityFlushCoordinator,
} from "@hikoutei/contracts/storage/scalar.js";
import type {
  TypedSheetsEntityFieldMapping,
  TypedSheetsEntityMapping,
  TypedSheetsEntityMappingRegistry,
} from "../../mapping/contracts.js";

/** Default lease role used by mapped entity writes. */
export const DEFAULT_MAPPED_WRITER_ROLE = "typed-sheets-entity-writer";

/** Default lease duration used by mapped entity writes. */
export const DEFAULT_MAPPED_WRITER_LEASE_DURATION_MS = 60_000;

/** Effect target kinds emitted by mapped entity persistence. */
export const MAPPED_EFFECT_TARGET_KINDS = {
  ENTITY: "entity",
  PROJECTION_ROW: "projection_row",
} as const satisfies Record<string, EffectTargetKind>;

/** Effect lifecycle states read while deriving the next projection baseline. */
export const MAPPED_EFFECT_STATUSES = {
  PENDING: "pending",
  PROCESSING: "processing",
  APPLIED: "applied",
} as const satisfies Record<string, EffectStatus>;

/** Writer identity used to fence mapped entity lifecycle commits. */
export interface TypedSheetsEntityWriterOptions {
  /** Stable process or service identity that owns mapped entity writes. */
  readonly writerId: string;
  /** Lease role. It may differ from the effect worker's role. */
  readonly role?: string;
  /** Writer lease length in milliseconds. */
  readonly leaseDurationMs?: number;
  /** Injectable clock used for deterministic tests and fencing. */
  readonly now?: () => number;
  /** Injectable opaque-ID source used for commit and effect identities. */
  readonly createId?: () => string;
  /** Optional diagnostics sink for append/update/delete flush phases. */
  readonly onTiming?: SyncTimingSink;
}

/** Options for deriving a built-in flush coordinator from mapping metadata. */
export interface CreateMappedTypedSheetsFlushCoordinatorOptions {
  readonly mappings: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[];
  readonly writer: TypedSheetsEntityWriterOptions;
  /**
   * Internal sync behavior injected after each mapped flush commit.
   *
   * The callback runs inside the same SQLite transaction as the entity,
   * canonical, and outbox writes so NEEDS_REBASE auditing and implicit
   * system-wins resolution stay atomic with the flush. It is service-side
   * only and never part of the root application contract.
   */
  readonly syncFlushHook?: MappedFlushSyncHook;
}

/** One committed mapped flush result handed to the internal sync hook. */
export interface MappedFlushSyncPlan {
  readonly mapping: TypedSheetsEntityMapping;
  readonly change: ScalarEntityFlushChange;
  readonly changedFields: readonly TypedSheetsEntityFieldMapping[];
  readonly entityId: string;
  readonly rowBindingId: string;
  readonly commitId: string;
  /** True when an active row candidate suppressed the User_Input projection. */
  readonly suppressedUserProjection: boolean;
}

/**
 * Internal flush/runtime callback contract injected by the sync service.
 *
 * The hook may plan conflict audits and resolutions but never changes the
 * public ORM surface; `src/index.ts` does not expose it.
 */
export type MappedFlushSyncHook = (input: {
  readonly sql: SqlExecutor;
  readonly fence: FencingContext;
  readonly writer: ResolvedWriterOptions;
  readonly plan: MappedFlushSyncPlan;
}) => Promise<void>;

/** A registered route with headers ready for provider-side provisioning. */
export interface RegisteredTypedSheetsMappedProjection {
  readonly mapping: TypedSheetsEntityMapping;
  readonly sheet: RegisteredSyncSheet;
  readonly headers: readonly string[];
}

/** Normalized writer options used by all persistence helpers. */
export interface ResolvedWriterOptions {
  readonly writerId: string;
  readonly role: string;
  readonly leaseDurationMs: number;
  readonly now: () => number;
  readonly createId: () => string;
  readonly onTiming: SyncTimingSink | undefined;
}

/** Confirmed or queued baseline used when creating the next projection effect. */
export interface ProjectionBaseline {
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly createIfMissing: boolean;
  readonly streamSequence: number;
}

/** One validated mapped entity lifecycle change and its selected fields. */
export interface MappedChangePlan {
  readonly mapping: TypedSheetsEntityMapping;
  readonly change: ScalarEntityFlushChange;
  readonly changedFields: readonly TypedSheetsEntityFieldMapping[];
}

/** Provider-neutral coordinator shape used by the scalar persistence provider. */
export type {
  ScalarEntityFlushCoordinator as TypedSheetsFlushCoordinator,
  ScalarEntityFlushContext as TypedSheetsFlushContext,
};

/** Keeps the API imports used by persistence modules explicit in one contract file. */
export type {
  CanonicalCommitInput,
  CanonicalFieldWrite,
  FencingContext,
  NewEffect,
  RegisteredSyncProjectionDefinition,
  RegisteredSyncSheet,
  SqlExecutor,
  SqlStorageAdapter,
};

export type {
  ScalarEntityFlushChange,
  ScalarEntityFlushContext,
  ScalarEntityFlushCoordinator,
};
