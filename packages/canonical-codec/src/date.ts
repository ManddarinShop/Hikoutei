/**
 * Canonical UTC date validation for the codec's tagged date path.
 *
 * Mirrors the date guard the Hikoutei repository previously kept in
 * `src/shared/validation.ts`. The stable-encoding date path only accepts a
 * fixed-width UTC ISO-8601 string so that dates encode to identical bytes
 * across runtimes.
 *
 * NOTE: Stage 1 scaffold. The function body is an intentional stub and will be
 * filled in during Stage 2 of the package-extraction plan.
 */

const NOT_IMPLEMENTED =
  "@hikoutei/canonical-codec: Stage 1 scaffold (0.1.0); implementation lands in Stage 2.";

/**
 * Checks whether a string is the canonical UTC ISO representation of a date.
 *
 * Stage 1 stub: throws until the implementation is migrated in Stage 2.
 */
export function isCanonicalUtcIsoDate(value: unknown): value is string {
  throw new Error(`isCanonicalUtcIsoDate is not implemented. ${NOT_IMPLEMENTED}`);
}
