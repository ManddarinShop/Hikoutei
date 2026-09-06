/**
 * Neutral response-loss postcondition classifier.
 *
 * Recovery probes classify one effect against a fresh target+receipt read.
 * The classifier never assumes success: a receipt proves the effect reached
 * the sheet, a matching visible hash proves the target content, and anything
 * else is `unapplied`, `changed`, or `unavailable` so the worker redrives,
 * fails, or keeps probing instead of closing the outbox on weak evidence.
 *
 * The classifier is provider-neutral: it decides over caller-supplied
 * evidence views (deletion-ness, expected/target hashes, the observed row,
 * the receipt). Providers build those views from their own context model
 * and map the neutral verdict onto their contract types at the boundary.
 */

/** Read-back classification of one response-loss effect after a probe. */
export type CasDisposition = "applied" | "unapplied" | "changed" | "unavailable";

/** Neutral postcondition verdict for one probed effect. */
export interface CasPostcondition {
  readonly disposition: CasDisposition;
  /** Probe evidence verified against the effect target (when available). */
  readonly visibleRevision: number | undefined;
  readonly visibleHash: string | undefined;
  /** Classification note (e.g. why a matching row did not prove delivery). */
  readonly reason?: string;
}

/** Neutral receipt evidence for the classified effect, when read back. */
export interface CasReceiptEvidence {
  readonly payloadHash: string;
  readonly visibleRevision: number;
  readonly visibleHash: string;
}

/** Neutral observed-row view for the classified effect's target. */
export interface CasObservedRow {
  /** Provider row number of the probe-located target row. */
  readonly rowNumber: number;
  /** Current content hash of the row under the effect's fields. */
  readonly currentHash: string;
}

/** Everything the classifier needs for one effect. */
export interface CasClassifyInput {
  /** True when the effect deletes its target row. */
  readonly isDeletion: boolean;
  /** Durable expected visible state from the outbox row. */
  readonly expectedVisibleHash: string;
  readonly expectedVisibleRevision: number;
  /** Target content hash the effect intended to write. */
  readonly targetVisibleHash: string;
  /** True when the effect creates its row if missing. */
  readonly createIfMissing: boolean;
  /** Repair guard hash the probe also accepts as unapplied evidence. */
  readonly repairGuardHash: string | null;
  /** Payload hash of the classified effect (receipt-staleness check). */
  readonly effectPayloadHash: string;
  /** Receipt read back for this effect, when present. */
  readonly receipt: CasReceiptEvidence | undefined;
  /** Probe-located target row, when the read found a candidate. */
  readonly observedRow: CasObservedRow | undefined;
}

/**
 * Classifies one effect's delivery state. The receipt and the observed row
 * must come from the same read pass so the classification is a single
 * consistent view.
 */
export function classifyCasPostcondition(
  input: CasClassifyInput,
): CasPostcondition {
  if (
    input.receipt !== undefined &&
    input.receipt.payloadHash !== input.effectPayloadHash
  ) {
    return postcondition("changed", undefined, undefined);
  }
  const row = input.observedRow;
  if (input.isDeletion) {
    if (input.receipt !== undefined && row === undefined) {
      return postcondition(
        "applied",
        input.receipt.visibleRevision,
        input.receipt.visibleHash,
      );
    }
    if (row === undefined) {
      // An absent row without this effect's receipt could be a manual
      // deletion; never let that absence close an outbox effect.
      return postcondition("unavailable", undefined, undefined);
    }
    if (input.receipt !== undefined) {
      return postcondition("changed", undefined, row.currentHash);
    }
    return row.currentHash === input.expectedVisibleHash
      ? postcondition(
        "unapplied",
        input.expectedVisibleRevision,
        row.currentHash,
      )
      : postcondition("changed", undefined, row.currentHash);
  }
  // A receipt alone cannot prove that a non-delete row still exists; a manual
  // deletion must remain observable instead of closing the outbox.
  if (row === undefined) {
    return postcondition(
      input.receipt !== undefined || !input.createIfMissing ? "changed" : "unapplied",
      undefined,
      undefined,
      input.receipt === undefined ? undefined : "receipt_target_missing",
    );
  }
  if (row.currentHash === input.targetVisibleHash) {
    if (input.receipt === undefined) {
      // The row already carries the target content, but without a receipt
      // there is no durable proof that this effect was applied by the
      // provider: the two-stage write path can crash between the target-row
      // write and the receipt write and leave exactly this orphan. Closing
      // the outbox on row-hash evidence alone would turn that crash into a
      // false success, so stay fail-closed.
      return postcondition("unavailable", undefined, row.currentHash, "receipt_missing");
    }
    return postcondition(
      "applied",
      input.receipt.visibleRevision,
      row.currentHash,
    );
  }
  if (
    row.currentHash === input.expectedVisibleHash ||
    (input.repairGuardHash !== null && row.currentHash === input.repairGuardHash)
  ) {
    return postcondition(
      "unapplied",
      input.expectedVisibleRevision,
      row.currentHash,
    );
  }
  return postcondition("changed", undefined, row.currentHash);
}

function postcondition(
  disposition: CasDisposition,
  visibleRevision: number | undefined,
  visibleHash: string | undefined,
  reason?: string,
): CasPostcondition {
  const result: CasPostcondition = {
    disposition,
    visibleRevision,
    visibleHash,
  };
  return reason === undefined ? result : { ...result, reason };
}
