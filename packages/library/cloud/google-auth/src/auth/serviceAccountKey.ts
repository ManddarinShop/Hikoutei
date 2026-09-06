/**
 * Shared service-account key-file loading + shape validation (Batch A).
 *
 * This is the ONE loader for Google service-account key files, reused by
 * every provider line (Sheets today; Drive/Gmail next) and by the sync
 * auto-start bridge. It reads, JSON-parses, and SHAPE-validates a key file
 * so a misconfigured credential fails fast and locally — a malformed file
 * must never build an auth client that only breaks on first signing.
 *
 * Neutral error contract: this leaf owns no provider vocabulary, so every
 * failure is reported through the caller-supplied `fail` callback as a
 * discriminated `ServiceAccountKeyFailure` (quotaGovernor `timingDefaults`
 * precedent — behavior injected, dependency direction kept acyclic). The
 * Sheets transport maps every kind to its transport error; the sync
 * auto-start bridge maps them to the stable startup codes. Failure payloads
 * carry the PATH (and field names) only — never file contents, client
 * emails, or key material.
 */

import { GoogleAuth } from "google-auth-library";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

/** Required service-account key-file fields, checked by SHAPE (non-blank string) only at load. */
export const SERVICE_ACCOUNT_KEY_FIELDS = ["type", "client_email", "private_key", "project_id"] as const;

/** Structured key-file load failure (path-bearing only, never key material). */
export type ServiceAccountKeyFailure =
  | {
      /** The file could not be read (`code` is the Node errno, e.g. `ENOENT`). */
      readonly kind: "read-error";
      readonly path: string;
      readonly code: string | undefined;
    }
  | {
      /** The file contents are not valid JSON. */
      readonly kind: "invalid-json";
      readonly path: string;
    }
  | {
      /** The file parsed but is not a JSON object. */
      readonly kind: "not-object";
      readonly path: string;
    }
  | {
      /** Required service-account fields are missing or blank (NAMES only, never values). */
      readonly kind: "field-missing";
      readonly path: string;
      readonly fields: readonly string[];
    };

/** Loader options: the caller's failure mapping (must throw, never return). */
export interface ServiceAccountKeyLoadOptions {
  readonly fail: (failure: ServiceAccountKeyFailure) => never;
}

/** One validated service-account key: raw credentials plus the client email. */
export interface LoadedServiceAccountKey {
  /** Parsed key JSON, passed straight into `GoogleAuth.credentials` (never logged). */
  readonly credentials: Record<string, unknown>;
  /** The `client_email` field (used for access-denied hints, never logged by this leaf). */
  readonly clientEmail: string;
}

/**
 * Validates parsed key JSON by SHAPE and promotes it to a loaded key.
 *
 * Shared by the sync/async file loaders so both paths enforce the identical
 * contract: the payload must be a JSON object whose required
 * service-account fields are non-blank strings. Without this, ANY JSON
 * object builds a GoogleAuth client and the failure surfaces mid-run on
 * first signing instead of at load.
 */
export function parseServiceAccountKeyJson(
  raw: string,
  path: string,
  options: ServiceAccountKeyLoadOptions,
): LoadedServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    options.fail({ kind: "invalid-json", path });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    options.fail({ kind: "not-object", path });
  }
  const record = parsed as Record<string, unknown>;
  const invalidFields = SERVICE_ACCOUNT_KEY_FIELDS.filter(
    (field) => typeof record[field] !== "string" || (record[field] as string).trim() === "",
  );
  if (invalidFields.length > 0) {
    options.fail({ kind: "field-missing", path, fields: invalidFields });
  }
  return { credentials: record, clientEmail: record.client_email as string };
}

/**
 * Loads + validates one key file synchronously (transport construction path).
 *
 * Reads and shape-validates the file at construction so a misconfigured
 * pool fails fast and locally. Failure messages carry the path only.
 */
export function loadServiceAccountKeyFileSync(
  keyFile: string,
  options: ServiceAccountKeyLoadOptions,
): LoadedServiceAccountKey {
  let raw: string;
  try {
    raw = readFileSync(keyFile, "utf8");
  } catch (error: unknown) {
    options.fail({ kind: "read-error", path: keyFile, code: nodeErrorCode(error) });
  }
  return parseServiceAccountKeyJson(raw, keyFile, options);
}

/**
 * Loads + validates one key file asynchronously (startup-bridge path).
 *
 * Same contract as the sync loader; the bridge keeps its own env parsing
 * and error-code mapping and delegates only file loading/validation here.
 */
export async function loadServiceAccountKeyFile(
  keyFile: string,
  options: ServiceAccountKeyLoadOptions,
): Promise<LoadedServiceAccountKey> {
  let raw: string;
  try {
    raw = await readFile(keyFile, "utf8");
  } catch (error: unknown) {
    options.fail({ kind: "read-error", path: keyFile, code: nodeErrorCode(error) });
  }
  return parseServiceAccountKeyJson(raw, keyFile, options);
}

/**
 * Builds one pooled `GoogleAuth` from validated key credentials.
 *
 * The caller supplies the scopes (Sheets/Drive/Gmail each request their
 * own); the cast keeps the google-auth-library version-shape mismatch
 * inside this leaf, exactly like the former per-provider boundary casts.
 */
export function createServiceAccountAuth(
  credentials: Record<string, unknown>,
  scopes: readonly string[],
): GoogleAuth {
  return new GoogleAuth({
    scopes: [...scopes],
    credentials,
  } as unknown as ConstructorParameters<typeof GoogleAuth>[0]);
}

/** Extracts the Node errno (`ENOENT`, ...) from a caught read failure. */
function nodeErrorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object") {
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
