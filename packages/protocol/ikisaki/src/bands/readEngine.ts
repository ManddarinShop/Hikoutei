/**
 * Banded read executor: runs an already-packed band plan as SEQUENTIAL
 * paced requests and reassembles the replies into one logical document.
 *
 * The executor is provider-neutral: the adapter supplies one band fetch
 * (paced transport + parse + telemetry) plus bound/calibration observers,
 * and the kernel owns the iteration (skip-empty, per-band accounting) and
 * the reassembly (every requested range's cells in request order,
 * concatenated per sheet key, last-seen sheet entry wins).
 *
 * Each band consumes exactly one adapter fetch slot, so a timeout or
 * rejection fails ONE band with the adapter's own classification instead of
 * an all-or-nothing single request, and per-band bytes stay observable
 * without extra plumbing.
 */

import type {
  BandedDocument,
  BandedGet,
  BandEvidence,
  BandRange,
  EngineRuntime,
  ReadCalibration,
} from "./readPlan.js";

/** One fetched band: parsed sheets plus per-key cell lists. */
export interface BandFetchResult<TSheet, TGridKey, TGrid> {
  readonly sheets: readonly TSheet[];
  readonly grids: ReadonlyMap<TGridKey, readonly TGrid[]>;
  /** Measured response bytes, when the adapter measures telemetry. */
  readonly responseBytes: number | undefined;
}

/**
 * Provider hooks for one logical banded read. `fetchBand` runs the paced
 * transport call and parses the reply; the observers update the shared
 * provider-instance carriers (bounds cache, calibration) the planner reads
 * on the NEXT pass.
 */
export interface BandEngineHooks<TSheet, TGridKey, TGrid> {
  /** Fetches + parses the band covering these opaque range addresses. */
  fetchBand(addresses: readonly string[]): Promise<BandFetchResult<TSheet, TGridKey, TGrid>>;
  /** Stable identity of one fetched sheet (last-seen entry wins). */
  sheetKey(sheet: TSheet): string;
  /** Records one fetched sheet's authoritative bound (fresher metadata wins). */
  noteSheet?(sheet: TSheet): void;
  /** Feeds `responseBytes ÷ cellsRequested` into the calibration tracker. */
  noteResponse?(evidence: BandEvidence, cells: number, responseBytes: number | undefined): void;
}

/**
 * Builds the executor for ONE logical read: fixed read shape, evidence
 * class, and provider hooks. The returned closure owns no state —
 * bounds/calibration updates land on the shared carriers behind the hooks.
 */
export function createBandExecutor<TSheet, TGridKey, TGrid>(
  hooks: BandEngineHooks<TSheet, TGridKey, TGrid>,
  evidence: BandEvidence,
): BandedGet<TSheet, TGridKey, TGrid> {
  return async (requests) => {
    const sheetsByKey = new Map<string, TSheet>();
    const grids = new Map<TGridKey, TGrid[]>();
    let executed = 0;
    let bytes = 0;
    for (const request of requests) {
      if (request.length === 0) continue;
      const addresses = request.map((item) => item.address);
      const cells = request.reduce((total, item) => total + item.cells, 0);
      const fetched = await hooks.fetchBand(addresses);
      executed += 1;
      for (const sheet of fetched.sheets) {
        // Last-seen entry wins (fresher metadata); consumers read identity
        // from this list, cell data lives in `grids`.
        sheetsByKey.set(hooks.sheetKey(sheet), sheet);
        hooks.noteSheet?.(sheet);
      }
      for (const [key, list] of fetched.grids) {
        const existing = grids.get(key);
        if (existing === undefined) grids.set(key, [...list]);
        else existing.push(...list);
      }
      if (fetched.responseBytes !== undefined) {
        bytes += fetched.responseBytes;
        hooks.noteResponse?.(evidence, cells, fetched.responseBytes);
      }
    }
    return {
      sheets: [...sheetsByKey.values()],
      grids,
      requests: executed,
      bytes,
    };
  };
}

/**
 * Builds the model-facing engine runtime for one logical read: the
 * read-shape/evidence → executor factory plus the shared bounds cache and
 * calibration tracker. Model functions receive this instead of raw
 * transport, which is what lets a single logical read expand into
 * sequential paced band requests WITHOUT the model layer importing the
 * operations layer.
 */
export function createEngineRuntime<TSheet, TGridKey, TGrid>(options: {
  /** Builds the band fetch for one read-shape + evidence combination. */
  makeFetch: (
    fields: string,
    evidence: BandEvidence,
  ) => BandEngineHooks<TSheet, TGridKey, TGrid>["fetchBand"];
  /** Provider-instance authoritative row bounds (title → grid rowCount). */
  rowBounds: ReadonlyMap<string, number>;
  /** Provider-instance byte-estimate calibration (shared across lanes). */
  calibration: ReadCalibration;
  /** Shared bound/calibration observers for every executor this builds. */
  noteSheet?: BandEngineHooks<TSheet, TGridKey, TGrid>["noteSheet"];
  noteResponse?: BandEngineHooks<TSheet, TGridKey, TGrid>["noteResponse"];
  /** Stable identity of one fetched sheet (last-seen entry wins). */
  sheetKey: BandEngineHooks<TSheet, TGridKey, TGrid>["sheetKey"];
}): EngineRuntime<TSheet, TGridKey, TGrid> {
  return {
    makeGet: (fields, evidence) => createBandExecutor<TSheet, TGridKey, TGrid>(
      {
        fetchBand: options.makeFetch(fields, evidence),
        sheetKey: options.sheetKey,
        ...(options.noteSheet === undefined ? {} : { noteSheet: options.noteSheet }),
        ...(options.noteResponse === undefined ? {} : { noteResponse: options.noteResponse }),
      },
      evidence,
    ),
    rowBounds: options.rowBounds,
    calibration: options.calibration,
  };
}

/** Neutral bound-enumeration carriers for cold title resolution. */
export interface BandBoundEnumeration {
  /** True when the provider-instance cache already bounds this title. */
  hasBound(title: string): boolean;
  /** Settles cold titles with one metadata enumeration. */
  enumerate(): Promise<readonly { readonly title: string; readonly rowCount: number | undefined }[]>;
  /** Records one enumerated bound in the provider-instance cache. */
  noteBound(title: string, rowCount: number | undefined): void;
}

/**
 * Ensures every listed tab has an authoritative row bound in the
 * provider-instance cache, settling cold titles with ONE metadata
 * enumeration. The cache is refreshed by every subsequent engine response,
 * so the enumeration is a once-per-title-per-instance cost.
 */
export async function ensureBandRowBounds(
  lanes: BandBoundEnumeration,
  titles: readonly string[],
): Promise<void> {
  if (titles.every((title) => lanes.hasBound(title))) return;
  const enumerated = await lanes.enumerate();
  for (const sheet of enumerated) {
    lanes.noteBound(sheet.title, sheet.rowCount);
  }
}
