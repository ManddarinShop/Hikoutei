import type { SyncTimingSink } from "../shared/observability/syncTiming.js";

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
  /**
   * Fired AT WAIT ENTRY — immediately before a startup writer-lease wait
   * gate begins sleeping — by every gate site (mapped registration, conflict
   * route registration, adoption seeding). Each waited gate invocation fires
   * it at most once; the injecting bootstrap latches it for a once-per-
   * startup warning. Injected by the sync bootstrap because the warning must
   * live in the package that owns logging; storage never depends on log
   * infrastructure.
   */
  readonly onStartupLeaseWait?: () => void;
}
