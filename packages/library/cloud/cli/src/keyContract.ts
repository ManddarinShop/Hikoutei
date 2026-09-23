/**
 * Shared service-account key contract for `hikoutei setup`.
 *
 * Dependency-free leaf owning the non-secret key constants and metadata
 * result types shared by the checkpoint module and the key-material reader,
 * so neither imports the other for these names (previously the
 * checkpoint ↔ keyMaterial backedge). Moved verbatim from checkpoint.ts;
 * no behavior change. The checkpoint module path stays stable for existing
 * importers via re-exports.
 */

/** Service-account key file permission after setup (owner read/write only). */
export const SERVICE_ACCOUNT_KEY_FILE_MODE = 0o600;

/**
 * Restricted format of a service-account key id (`private_key_id`).
 *
 * Google user-managed service-account key ids are 16 lowercase hex digits;
 * the pattern accepts 16-40 hex digits so the setup never rejects a valid
 * key, while still refusing arbitrary payload text. The key id is NOT
 * secret: it is the last segment of the key's IAM resource name
 * (`projects/<project>/serviceAccounts/<email>/keys/<id>`) and is used to
 * match a local key file against the cloud key list during reconciliation.
 */
export const SERVICE_ACCOUNT_KEY_ID_PATTERN = /^[0-9a-fA-F]{16,40}$/;

/** Validated metadata of a service-account key JSON file. */
export interface ServiceAccountKeyMetadata {
  readonly projectId: string;
  readonly clientEmail: string;
  /** Non-secret `private_key_id`; matches the last segment of the IAM key resource name. */
  readonly keyId: string;
}

/**
 * Result of reading and validating a service-account key file.
 *
 * Only the descriptor-based secure reader is used; the plain pathname
 * reader was removed because a check-then-read sequence cannot be secured
 * against a mid-read alias swap.
 */
export type KeyMetadataResult =
  | { readonly status: "ok"; readonly metadata: ServiceAccountKeyMetadata }
  | { readonly status: "invalid"; readonly message: string };

/**
 * Result of the secure, descriptor-based key file read.
 *
 * `absent` means the path does not exist (the caller decides whether a
 * missing key is valid for the current checkpoint status); `invalid` means
 * the path exists but is not a regular file, could not be secured to mode
 * 0600, or does not parse as a service-account key for any project.
 */
export type SecureKeyReadResult =
  | { readonly status: "absent" }
  | { readonly status: "ok"; readonly metadata: ServiceAccountKeyMetadata }
  | { readonly status: "invalid"; readonly message: string };
