/**
 * Shared service-account credential-pool ownership (Batch A).
 *
 * This module owns the N-`GoogleAuth` pool every provider line paces and
 * signs with: one auth per key file (one Google quota principal), the
 * deterministic round-robin cursor, and the per-identity index binding that
 * ties admission to transport (the admitted identity IS the signing
 * identity). Providers build their API clients (`sheets({ version, auth })`
 * stays provider-side) from the selected auths; the pacing pool
 * (`CredentialPacingPool` in ikisaki) meets this pool at the existing
 * admission→transport index binding, which is unchanged.
 *
 * Out-of-range selection fails CLOSED through the caller-supplied
 * `onInvalidSelection` (same parameterization as the key loader's `fail`):
 * signing with a different identity than the one admission paced against
 * would silently defeat the per-identity quota contract.
 */

import type { GoogleAuth } from "google-auth-library";
import {
  createServiceAccountAuth,
  loadServiceAccountKeyFileSync,
  type ServiceAccountKeyFailure,
  type ServiceAccountKeyLoadOptions,
} from "./serviceAccountKey.js";

/**
 * Advances (and returns) the next round-robin client index for a pool.
 *
 * A preferred (provider-admitted) index is returned WITHOUT advancing the
 * cursor, so admission-bound calls never skew the fallback rotation. The
 * cursor is a mutable carrier so callers keep the rotation across requests;
 * `clientCount` must be ≥ 1.
 */
export function nextPooledClientIndex(
  cursor: { next: number },
  clientCount: number,
  preferredIndex: number | undefined,
): number {
  if (preferredIndex !== undefined) {
    return preferredIndex;
  }
  const index = cursor.next % clientCount;
  cursor.next = (index + 1) % clientCount;
  return index;
}

/** Selection failure mapping (must throw, never return). */
export interface ServiceAccountAuthPoolSelection {
  readonly onInvalidSelection: (message: string) => never;
}

/** Key-file pool construction: scopes plus both failure mappings. */
export interface ServiceAccountAuthPoolKeyFilesOptions
  extends ServiceAccountKeyLoadOptions, ServiceAccountAuthPoolSelection {
  /** OAuth scopes the pooled auths request (provider-owned, e.g. Sheets/Drive). */
  readonly scopes: readonly string[];
}

/**
 * The N-`GoogleAuth` credential pool plus its rotation cursor.
 *
 * Generic over the auth value so providers wrap their own auth flavor
 * (injected test auths, the ADC default) together with the file-backed
 * `GoogleAuth` instances under ONE selection cursor.
 */
export class ServiceAccountAuthPool<TAuth = GoogleAuth> {
  /** Fallback rotation cursor for requests WITHOUT an admitted index. */
  private readonly poolCursor: { next: number } = { next: 0 };

  public constructor(
    /** Every pooled credential; index-aligned with the provider's clients. */
    public readonly auths: readonly TAuth[],
    private readonly selection: ServiceAccountAuthPoolSelection,
  ) {}

  /**
   * Builds the file-backed pool: each key file is read and turned into its
   * own `GoogleAuth` at construction (fail fast on unreadable or malformed
   * files). Error payloads carry the PATH only — never file contents,
   * client emails, or key material.
   */
  public static loadFromKeyFiles(
    keyFiles: readonly string[],
    options: ServiceAccountAuthPoolKeyFilesOptions,
  ): ServiceAccountAuthPool<GoogleAuth> {
    const fail = (failure: ServiceAccountKeyFailure): never => options.fail(failure);
    const auths = keyFiles.map((keyFile) => {
      const { credentials } = loadServiceAccountKeyFileSync(keyFile, { fail });
      return createServiceAccountAuth(credentials, options.scopes);
    });
    return new ServiceAccountAuthPool(auths, options);
  }

  /** Number of pooled credentials (quota principals). */
  public get size(): number {
    return this.auths.length;
  }

  /**
   * Picks the pool index for one request: the admitted identity when the
   * request carries one, otherwise the next round-robin entry (a 1-auth
   * pool always selects index 0 — the historical single-auth path).
   */
  public selectIndex(preferredIndex: number | undefined): number {
    if (preferredIndex !== undefined) {
      if (this.auths[preferredIndex] === undefined) {
        // Fail CLOSED before any wire contact: signing with a different
        // identity than the one admission paced against would silently
        // defeat the per-identity quota contract.
        this.selection.onInvalidSelection("credentialIndex is outside the client pool");
      }
      return preferredIndex;
    }
    if (this.auths.length === 1) {
      return 0;
    }
    return nextPooledClientIndex(this.poolCursor, this.auths.length, undefined);
  }
}
