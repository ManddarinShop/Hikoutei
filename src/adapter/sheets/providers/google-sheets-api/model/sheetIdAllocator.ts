/**
 * Deterministic sheet-id allocation for the direct Sheets provider.
 *
 * The provider self-assigns numeric sheet ids when it creates tabs (the
 * provisioned projection tabs and the hidden receipt tab). The allocator is
 * deterministic and fail-closed: it picks the smallest positive 31-bit id
 * not already used by any tab, so repeated provision attempts against the
 * same spreadsheet never drift and a colliding id can never be emitted.
 */

import { invalidProviderState } from "../errors.js";

/** Smallest positive 31-bit signed integer accepted by the Sheets API. */
const MIN_SHEET_ID = 1;
const MAX_SHEET_ID = 0x7fffffff;

/**
 * Returns the smallest positive 31-bit sheet id that collides with none of
 * the supplied ids. Fails closed when no free id remains (unreachable for
 * any real spreadsheet, but the contract must not invent an invalid id).
 */
export function allocateSheetId(
  existing: ReadonlySet<number> | readonly number[],
): number {
  const used = existing instanceof Set
    ? existing
    : new Set(existing);
  for (let candidate = MIN_SHEET_ID; candidate <= MAX_SHEET_ID; candidate += 1) {
    if (!used.has(candidate)) return candidate;
  }
  invalidProviderState("no free sheet id remains for tab creation");
}
