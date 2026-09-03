/**
 * Per-provider receipt READ cursor plus cumulative receipt memo.
 *
 * The hidden receipt tab is append-only machine data (each write batch appends
 * its receipt rows at the tab tail; humans never edit it), so a dispatch does
 * not need to re-read the whole tab to decide idempotency: it needs only the
 * receipts appended since the last verified coverage. This cursor records the
 * LAST receipt row this provider instance has verified as covered — either by
 * parsing it in a previous receipt read, or by writing it in a batch that got
 * a valid `batchUpdate` reply — so the next dispatch reads only the tail band
 * starting AT that row (the row doubles as a sentinel proving the cursor is
 * still inside the tab).
 *
 * Because the cursor advances on every successful read, a band alone cannot
 * answer idempotency for effects that have not been re-dispatched for several
 * batches: their receipt rows fall BELOW the next cursor. The cursor
 * therefore also owns a cumulative memo — every receipt row this instance has
 * ever parsed (bands and full reads alike) — and preflight contexts expose
 * the memo, not just the current band, as their `receipts` view. Receipt
 * lookups never depend on where the cursor happens to sit.
 *
 * Safety contract:
 * - The cursor advances ONLY from a successful receipt READ, to the tail row
 *   that read parsed. It is never advanced from a write: receipts appended
 *   after the previous read therefore stay inside the next band, are merged
 *   into the memo there, and remain replay-recognizable for as long as this
 *   instance lives.
 * - Every row at or below the cursor was parsed by this instance since the
 *   last reset (append-only tab + snapshot-atomic reads), so memo coverage
 *   is exactly "everything the cursor has passed". A concurrent or
 *   cross-process append can only grow the tab at the tail, which the next
 *   band (starting AT the cursor sentinel) re-reads.
 * - A kill -9 loses the whole cursor AND the memo (instance memory): the next
 *   process starts with no cursor and performs the historical FULL
 *   `A1:F1048576` receipt read, byte-identical to the pre-cursor behavior.
 * - Cursor missing (< 2), sentinel blank (tab truncated/cleared), or a
 *   clipped grid → reset (cursor + memo dropped together) and fall back to
 *   one full receipt read, which re-establishes both.
 * - Memo growth is bounded: past `MAX_MEMO_RECEIPTS` the cursor resets, so
 *   the instance degrades to the pre-cursor full-read behavior instead of
 *   growing unbounded memory.
 *
 * Why instance memory instead of a SQLite column under the writer fence:
 * durable-then-ack coupling only buys savings across a process restart (one
 * full receipt read paid once per restart), while every multi-process and
 * crash-desync case above is already proven safe by the append-only +
 * shift-not-overwrite + probe-always-full-read invariants. Keeping the cursor
 * inside the provider also keeps the Sheets adapter free of storage-schema
 * ownership (a fence-coupled cursor would require outbox-kernel, contracts,
 * and storage API changes far outside this optimization's scope).
 */

import type { PreflightReceipt } from "./preflightContext.js";

/**
 * Ceiling for the cumulative receipt memo. Beyond it the cursor resets and
 * the instance falls back to the historical per-dispatch full receipt read.
 * ponytail: 200k receipts ≈ tens of MB of small records; upgrade path if a
 * real deployment exceeds this is an acknowledged-effect watermark in
 * SQLite (durable cursor + durable coverage).
 */
export const MAX_MEMO_RECEIPTS = 200_000;

export class ReceiptReadCursor {
  /** Last receipt row (1-based) verified as covered; 0 means "no cursor". */
  private lastVerifiedRow = 0;
  /** Every receipt parsed by this instance since the last reset. */
  private readonly memo = new Map<string, PreflightReceipt>();

  /**
   * Row (1-based) to START a banded receipt read at, or `undefined` when a
   * full read is required (no usable cursor yet). The band starts AT the
   * cursor row so the known-applied receipt there acts as a sentinel against
   * tab truncation; row 1 is the header, so a cursor below 2 can never prove
   * coverage of a data row and the full read stays.
   */
  public bandStartRow(): number | undefined {
    return this.lastVerifiedRow >= 2 ? this.lastVerifiedRow : undefined;
  }

  /** Monotonic advance; understating the verified tail is always safe. */
  public advanceTo(verifiedRow: number): void {
    if (Number.isSafeInteger(verifiedRow) && verifiedRow > this.lastVerifiedRow) {
      this.lastVerifiedRow = verifiedRow;
    }
  }

  /**
   * Merges one parsed read's receipts into the cumulative memo. Re-parsing
   * the same row (the band sentinel is read again every dispatch) is a no-op
   * when the values agree; a different value under an already-covered
   * effectId means the append-only tab was rewritten from under this
   * instance and fails closed exactly like an in-band duplicate.
   */
  public mergeParsed(receipts: ReadonlyMap<string, PreflightReceipt>): boolean {
    for (const [effectId, receipt] of receipts) {
      const known = this.memo.get(effectId);
      if (known !== undefined) {
        if (known.payloadHash !== receipt.payloadHash ||
            known.visibleHash !== receipt.visibleHash ||
            known.visibleRevision !== receipt.visibleRevision) {
          return false;
        }
        continue;
      }
      this.memo.set(effectId, receipt);
    }
    return true;
  }

  /** True when the memo has grown past its ceiling (caller must reset). */
  public isOverCapacity(): boolean {
    return this.memo.size > MAX_MEMO_RECEIPTS;
  }

  /** True when the next merge could only exceed the ceiling: force a full read. */
  public isAtCapacity(): boolean {
    return this.memo.size >= MAX_MEMO_RECEIPTS;
  }

  /** True when this instance has covered no receipt row yet. */
  public isEmpty(): boolean {
    return this.memo.size === 0;
  }

  /** The cumulative receipt coverage every scoped/full read's context exposes. */
  public memoView(): ReadonlyMap<string, PreflightReceipt> {
    return this.memo;
  }

  /**
   * Drops the cursor AND the memo together so the next read performs the
   * historical full receipt read; coverage and cursor must never disagree.
   */
  public reset(): void {
    this.lastVerifiedRow = 0;
    this.memo.clear();
  }
}
