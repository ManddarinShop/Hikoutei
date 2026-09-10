/**
 * Deterministic numeric id allocation for created tabs.
 *
 * The host self-assigns numeric ids when it creates tabs. The allocator is
 * deterministic and fail-closed: it picks the smallest positive 31-bit id
 * not already used by any tab, so repeated creation attempts against the
 * same document never drift and a colliding id can never be emitted.
 *
 * Exhaustion is unreachable for any real document, but the contract must
 * not invent an invalid id: the caller supplies the fail-closed throw as a
 * `() => never` factory, so this neutral helper never depends on a
 * host-owned error type while the host keeps its own structured error.
 */

/** Smallest positive 31-bit signed integer accepted for a created tab. */
const MIN_SHEET_ID = 1;
const MAX_SHEET_ID = 0x7fffffff;

/**
 * Returns the smallest positive 31-bit id that collides with none of the
 * supplied ids. Calls `onExhausted` (which must throw) when no free id
 * remains.
 */
export function allocateSheetId(
  existing: ReadonlySet<number> | readonly number[],
  onExhausted: () => never,
): number {
  const used = existing instanceof Set
    ? existing
    : new Set(existing);
  for (let candidate = MIN_SHEET_ID; candidate <= MAX_SHEET_ID; candidate += 1) {
    if (!used.has(candidate)) return candidate;
  }
  onExhausted();
}
