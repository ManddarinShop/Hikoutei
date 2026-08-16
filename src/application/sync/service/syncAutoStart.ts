/**
 * Env-driven sync auto-start bridge for the public `createTypedSheets()`.
 *
 * This internal module owns the mapping from environment variables to the
 * sync service bootstrap: spreadsheet URL parsing, service-account credentials
 * file validation, polling interval parsing, projection auto-generation from
 * entity descriptors, and fail-closed startup failure classification. It is
 * never re-exported from `src/index.ts`; the public factory calls it only when
 * `HIKOUTEI_SYNC_SPREADSHEET_URL` is set, so local-only users never load the
 * sync module graph.
 *
 * The env reader, transport, and diagnostic sink are injectable so tests can
 * exercise every startup branch with a stub transport, a fake env, and a
 * captured log without credentials or network access. When no transport is
 * injected, the real Application Default Credentials (ADC) transport is built
 * by the sync service, exactly like the production path.
 *
 * Failures are classified into stable `HikouteiError` codes, logged through
 * the diagnostic sink (console by default), and thrown fail-closed: a startup
 * failure never leaves a half-open runtime behind.
 */

import { readFile } from "node:fs/promises";
import { z } from "zod";

import {
  getEntityDescriptor,
  type HikouteiEntity,
} from "../../../api/entity.js";
import {
  createLocalTypedSheetsRuntime,
  validateTypedSheetsOptions,
  type Hikoutei,
} from "../../../api/Hikoutei.js";
import {
  HIKOUTEI_ERROR_CODES,
  HikouteiError,
} from "../../../api/errors.js";
import type { GoogleSheetsApiTransport } from "../../../adapter/sheets/providers/google-sheets-api/index.js";
import {
  GoogleSheetsApiTransportError,
} from "../../../adapter/sheets/providers/google-sheets-api/errors.js";
import { columnLetters } from "../../../adapter/sheets/providers/google-sheets-api/model/valueNormalization.js";
import { PRESENCE_KINDS } from "../../../shared/state/index.js";
import {
  SYNC_CONFLICT_PROJECTION_REGISTERED_RANGE,
} from "../sheetsContract/conflictProjection.js";
import { SyncSheetsContractError } from "../sheetsContract/errors.js";
import type {
  InternalSyncEntityConfig,
  InternalSyncProjectionConfig,
} from "./contracts.js";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "./SyncServiceBootstrap.js";
import {
  positiveDecimalMillisecondsSchema,
  syncCredentialsSchema,
} from "./configSchemas.js";

/** Env keys consumed by the sync auto-start bridge. */
export const SYNC_ENV_KEYS = {
  /** Spreadsheet URL; absent means sync stays disabled (local-only). */
  SPREADSHEET_URL: "HIKOUTEI_SYNC_SPREADSHEET_URL",
  /** Service-account key file path (JSON, ADC standard). */
  CREDENTIALS_FILE: "GOOGLE_APPLICATION_CREDENTIALS",
  /** Optional User_Input polling cadence in ms; defaults to 60 seconds. */
  POLLING_INTERVAL_MS: "HIKOUTEI_SYNC_POLLING_INTERVAL_MS",
  /** Optional metadata safety full-scan cadence in ms; defaults to 60 seconds. */
  FULL_SCAN_INTERVAL_MS: "HIKOUTEI_SYNC_FULL_SCAN_INTERVAL_MS",
} as const;

/** Default polling cadence applied when the interval env vars are absent. */
export const DEFAULT_SYNC_POLLING_INTERVAL_MS = 60_000;
/** Default safety full-scan cadence applied when the interval env vars are absent. */
export const DEFAULT_SYNC_FULL_SCAN_INTERVAL_MS = 60_000;

/** Diagnostic log levels emitted by the auto-start bridge. */
export type SyncDiagnosticLevel = "info" | "error";

/** Diagnostic sink; defaults to console. Never receives secrets or full URLs. */
export type SyncDiagnostic = (level: SyncDiagnosticLevel, message: string) => void;

/** Internal auto-start options; none are part of the root application contract. */
export interface SyncAutoStartOptions {
  readonly dbName: string;
  readonly entities: readonly HikouteiEntity[];
  /** Injectable env reader; defaults to an empty env (sync disabled). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Stub transport for credential-free tests; omitted builds the real ADC client. */
  readonly transport?: GoogleSheetsApiTransport;
  /** Injectable diagnostic sink for tests; defaults to console. */
  readonly onDiagnostic?: SyncDiagnostic;
}

/** Local-only result: no sync service was started (env absent or blank). */
export interface LocalSyncRuntimeResult {
  readonly kind: "local";
  readonly hikoutei: Hikoutei;
}

/** Sync result: the running internal service plus its public runtime handle. */
export interface RunningSyncServiceResult {
  readonly kind: "sync";
  /** Same object as `service.hikoutei`; convenient for the public factory. */
  readonly hikoutei: Hikoutei;
  /** Internal service handle (supervisors, storage) for tests and tooling. */
  readonly service: InternalSyncService;
}

export type TypedSheetsWithSyncResult = LocalSyncRuntimeResult | RunningSyncServiceResult;

/** Required service-account fields validated before any remote contact. */
const REQUIRED_CREDENTIAL_FIELDS = ["type", "client_email", "private_key"] as const;

const SPREADSHEET_PATH_SEGMENT = "d";
const SPREADSHEET_PARENT_SEGMENT = "spreadsheets";

/**
 * Extracts the spreadsheet ID from a Google Sheets URL.
 *
 * Supports `https://docs.google.com/spreadsheets/d/<ID>/edit` (with `#gid=`,
 * `?usp=sharing`, `/view`, trailing slashes, and scheme-less forms) and a
 * top-level `/d/<ID>` right after the host. The ID must be its own path
 * segment, so a Docs URL such as `/document/d/<ID>` is rejected instead of
 * being misread as a spreadsheet. Returns `undefined` when no ID segment can
 * be extracted. The ID itself is the only part ever echoed in diagnostics;
 * full URLs are never logged.
 */
export function parseSpreadsheetIdFromUrl(url: string): string | undefined {
  if (typeof url !== "string" || url.trim() === "") return undefined;
  const withoutScheme = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const path = withoutScheme.split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/");
  const dIndex = segments.findIndex((segment) => segment === SPREADSHEET_PATH_SEGMENT);
  if (dIndex < 0) return undefined;
  const previous = segments[dIndex - 1];
  // Accept /spreadsheets/d/<ID> and a top-level /d/<ID> right after the host;
  // anything deeper (e.g. /document/d/<ID>) is not a spreadsheet URL.
  if (previous !== SPREADSHEET_PARENT_SEGMENT && dIndex !== 1) return undefined;
  const id = segments[dIndex + 1];
  if (id === undefined || id.length === 0 || /[\s?#]/.test(id)) return undefined;
  return id;
}

/**
 * Opens the runtime for the declared entities, starting the internal sync
 * service when the env is configured.
 *
 * When `HIKOUTEI_SYNC_SPREADSHEET_URL` is absent the function logs the
 * "sync disabled" info diagnostic and returns the plain local-only runtime —
 * the exact path `createTypedSheets()` uses without sync. When present it
 * validates the URL and the credentials file, auto-generates the projection
 * routes from the entity descriptors, and fails closed with a classified
 * `HikouteiError` on any startup problem.
 */
export async function createTypedSheetsWithSync(
  options: SyncAutoStartOptions,
): Promise<TypedSheetsWithSyncResult> {
  validateTypedSheetsOptions(options);
  const env = options.env ?? {};
  const diagnostic = options.onDiagnostic ?? defaultDiagnostic;

  const spreadsheetUrl = env[SYNC_ENV_KEYS.SPREADSHEET_URL];
  if (spreadsheetUrl === undefined || spreadsheetUrl.trim() === "") {
    diagnostic("info", "sync disabled — HIKOUTEI_SYNC_SPREADSHEET_URL is not set (local-only mode)");
    const hikoutei = await createLocalTypedSheetsRuntime(options);
    return { kind: "local", hikoutei };
  }

  const spreadsheetId = parseSpreadsheetIdFromUrl(spreadsheetUrl);
  if (spreadsheetId === undefined) {
    return raiseDiagnosed(
      diagnostic,
      new HikouteiError(
        HIKOUTEI_ERROR_CODES.SYNC_SPREADSHEET_URL_INVALID,
        "Unable to extract a spreadsheet ID from HIKOUTEI_SYNC_SPREADSHEET_URL — " +
          "expected a URL of the form https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit",
      ),
    );
  }

  // The client_email read here is retained for the 403 access-denied message.
  let clientEmail = "";
  try {
    ({ clientEmail } = await validateSyncCredentialsFile(
      env[SYNC_ENV_KEYS.CREDENTIALS_FILE],
    ));
    const pollingIntervalMs = parseIntervalEnv(
      env,
      SYNC_ENV_KEYS.POLLING_INTERVAL_MS,
      DEFAULT_SYNC_POLLING_INTERVAL_MS,
    );
    const pollingFullScanIntervalMs = parseIntervalEnv(
      env,
      SYNC_ENV_KEYS.FULL_SCAN_INTERVAL_MS,
      DEFAULT_SYNC_FULL_SCAN_INTERVAL_MS,
    );
    const projections = buildSyncProjections(options.entities, spreadsheetId);
    const service = await createInternalSyncService({
      dbName: options.dbName,
      entities: [...options.entities],
      projections,
      // Injected transports are a test-only affordance; the fast pacing keeps
      // stub-based suites wall-clock cheap. Production builds the real
      // ADC-backed transport with its default pacing.
      googleSheetsApi: options.transport === undefined
        ? {}
        : { transport: options.transport, rateLimitIntervalMs: 1 },
      pollingIntervalMs,
      pollingFullScanIntervalMs,
    });
    return { kind: "sync", hikoutei: service.hikoutei, service };
  } catch (error: unknown) {
    const failure = error instanceof HikouteiError
      ? error
      : classifySyncStartupFailure(error, spreadsheetId, clientEmail);
    return raiseDiagnosed(diagnostic, failure);
  }
}

/**
 * Validates the service-account credentials file and returns its client email.
 *
 * Classifies a missing/unreadable file, a non-object JSON payload, and missing
 * required fields into stable `HikouteiError` codes. The file is validated
 * before any remote contact so a misconfigured deployment fails fast with a
 * precise message instead of an ADC stack trace.
 */
export async function validateSyncCredentialsFile(
  path: string | undefined,
): Promise<{ readonly clientEmail: string }> {
  if (path === undefined || path.trim() === "") {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING,
      "Credentials file not found: GOOGLE_APPLICATION_CREDENTIALS is not set",
    );
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING,
        `Credentials file not found: ${path}`,
      );
    }
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      `Sync start failed: unable to read the credentials file: ${path}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_INVALID_JSON,
      `Credentials file is not valid JSON: ${path}`,
    );
  }
  const parsedRecord = z.record(z.string(), z.unknown()).safeParse(parsed);
  if (!parsedRecord.success) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_INVALID_JSON,
      `Credentials file is not valid JSON: ${path}`,
    );
  }
  const credentials = syncCredentialsSchema.safeParse(parsedRecord.data);
  if (!credentials.success) {
    const missing = REQUIRED_CREDENTIAL_FIELDS.filter((field) =>
      credentials.error.issues.some((issue) => issue.path[0] === field),
    );
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FIELD_MISSING,
      `Credentials file is missing required fields: ${missing.join(", ")}`,
    );
  }
  return { clientEmail: credentials.data.client_email };
}

/**
 * Auto-generates the internal projection routes from public entity descriptors.
 *
 * Every entity owns three tabs named `<EntityName>_System`, `<EntityName>_Input`,
 * and `<EntityName>_Conflicts`. The System_State range covers every property
 * plus the `__typed_sheets_deleted` tombstone, the User_Input range covers the
 * user-owned fields (all properties) plus the internal `__hikoutei_row_id`
 * row-anchor system column, and Sync_Conflicts uses the fixed 15-header
 * `A:O` audit range. All properties are user-owned so polling can accept
 * human edits on any field.
 */
export function buildSyncProjections(
  entities: readonly HikouteiEntity[],
  spreadsheetId: string,
): InternalSyncProjectionConfig {
  const entityConfigs: Record<string, InternalSyncEntityConfig> = {};
  for (const entity of entities) {
    const descriptor = getEntityDescriptor(entity);
    const propertyCount = descriptor.properties.length;
    entityConfigs[descriptor.name] = {
      systemState: {
        tabName: `${descriptor.name}_System`,
        registeredRange: `A:${columnLetters(propertyCount + 1)}`,
      },
      userInput: {
        tabName: `${descriptor.name}_Input`,
        // The last column is the internal __hikoutei_row_id system column.
        registeredRange: `A:${columnLetters(propertyCount + 1)}`,
      },
      syncConflicts: {
        tabName: `${descriptor.name}_Conflicts`,
        registeredRange: SYNC_CONFLICT_PROJECTION_REGISTERED_RANGE,
      },
      userOwnedFields: descriptor.properties.map((property) => property.name),
    };
  }
  return { spreadsheetId, entities: entityConfigs };
}

/**
 * Classifies a sync service startup failure into a stable Hikoutei error.
 *
 * Transport rejections with a proven HTTP status map to authentication,
 * access-denied (using the validated client_email), and not-found codes;
 * remote schema/provisioning contract failures map to provisioning; anything
 * else (timeout, network, invalid options) maps to the generic startup code.
 */
export function classifySyncStartupFailure(
  error: unknown,
  spreadsheetId: string,
  clientEmail: string,
): HikouteiError {
  if (error instanceof GoogleSheetsApiTransportError) {
    const status = error.status.kind === PRESENCE_KINDS.PRESENT
      ? error.status.value
      : undefined;
    if (status === 401) {
      return new HikouteiError(
        HIKOUTEI_ERROR_CODES.SYNC_AUTH_FAILED,
        "Credentials are invalid (authentication failed)",
      );
    }
    if (status === 403) {
      return new HikouteiError(
        HIKOUTEI_ERROR_CODES.SYNC_SPREADSHEET_ACCESS_DENIED,
        `Service account ${clientEmail} has not been shared on the spreadsheet or lacks edit permission — add ${clientEmail} to the sheet's sharing`,
      );
    }
    if (status === 404) {
      return new HikouteiError(
        HIKOUTEI_ERROR_CODES.SYNC_SPREADSHEET_NOT_FOUND,
        `Spreadsheet not found (ID: ${spreadsheetId})`,
      );
    }
    const remoteCode = error.remoteCode.kind === PRESENCE_KINDS.PRESENT
      ? error.remoteCode.value
      : error.code;
    const reason = status === undefined
      ? remoteCode
      : `HTTP ${status} ${remoteCode}`;
    return new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      `Sync start failed: ${reason} ${error.message}`,
    );
  }
  if (error instanceof SyncSheetsContractError) {
    return new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_PROVISIONING_FAILED,
      `Provisioning failed: ${error.message}`,
    );
  }
  const name = error instanceof Error && error.name.length > 0 ? error.name : "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  return new HikouteiError(
    HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
    `Sync start failed: ${name} ${message}`,
  );
}

/** Parses one optional ms interval env var; malformed values fail closed. */
function parseIntervalEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = positiveDecimalMillisecondsSchema.safeParse(raw);
  if (!value.success) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      `Sync start failed: ${key} must be a positive integer (ms) — current value: ${raw}`,
    );
  }
  return value.data;
}

function raiseDiagnosed(diagnostic: SyncDiagnostic, failure: HikouteiError): never {
  diagnostic("error", failure.message);
  throw failure;
}

function defaultDiagnostic(level: SyncDiagnosticLevel, message: string): void {
  if (level === "info") {
    console.info(message);
  } else {
    console.error(message);
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error !== null &&
    typeof error === "object" &&
    (error as { readonly code?: unknown }).code === code;
}
