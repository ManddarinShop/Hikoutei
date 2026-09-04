/**
 * Env-driven sync auto-start bridge for the public `createTypedSheets()`.
 *
 * This internal module owns the mapping from environment variables to the
 * sync service bootstrap: spreadsheet URL parsing, service-account credentials
 * file validation, polling interval parsing, request-start pacing override
 * parsing, projection auto-generation from entity descriptors, and fail-closed
 * startup failure classification. It is re-exported to applications ONLY
 * through the lazy public wrapper `src/api/syncRuntime.ts`, so importing the
 * package root never loads the sync module graph; the public factory calls it
 * only when `HIKOUTEI_SYNC_SPREADSHEET_URL` is set, so local-only users never
 * load the sync module graph either.
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

import {
  getEntityDescriptor,
  type HikouteiEntity,
} from "../../api/entity.js";
import {
  validateTypedSheetsOptions,
  type Hikoutei,
  type HikouteiProviderOptions,
} from "../../api/hikouteiCore.js";
import { requireSyncEngineLocalRuntime } from "./compositionPorts.js";
import {
  HIKOUTEI_ERROR_CODES,
  HikouteiError,
} from "../../api/errors.js";
import type { GoogleSheetsApiTransport } from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import {
  GoogleSheetsApiTransportError,
} from "@hikoutei/contracts/sheets/transportError.js";
import { columnLetters } from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import {
  GOOGLE_SHEETS_API_DEFAULTS,
} from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import { PRESENCE_KINDS } from "@hikoutei/contracts/state/index.js";
import {
  DEFAULT_EFFECT_LEASE_DURATION_MS,
  EFFECT_LEASE_PROVIDER_HEADROOM_MS,
} from "@hikoutei/ikisaki";
import {
  SYNC_CONFLICT_PROJECTION_REGISTERED_RANGE,
} from "@hikoutei/storage/sync/sheetsContract/conflictProjection.js";
import { SyncSheetsContractError } from "@hikoutei/contracts/sheets/errors.js";
import {
  ExistingSheetAdoptionDryRunReportError,
  type ExistingSheetAdoptionRunReport,
  type ExistingSheetAdoptionSpec,
} from "./adopt/existingSheetAdoption.js";
import {
  SYNC_SERVICE_ERROR_CODES,
  SyncServiceError,
} from "./errors.js";
import {
  describeErrorForInternalLog,
  HIKOUTEI_LOG_LEVELS,
  logHikouteiInternalEvent,
} from "../../shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
  HIKOUTEI_LOG_STABLE_CLASSES,
  HIKOUTEI_LOG_STABLE_CODES,
} from "../../shared/observability/logEvents.js";
import type {
  InternalSyncEntityConfig,
  InternalSyncProjectionConfig,
} from "./contracts.js";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "./SyncServiceBootstrap.js";
import {
  SYNC_FULL_SCAN_INTERVAL_MS,
  SYNC_POLLING_INTERVAL_MS,
} from "./cadence.js";

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
  /**
   * Optional request-start pacing in ms for the direct provider's
   * independent read and write request-start limiters; absent uses the safe
   * default (800 ms). Internal only — never part of the root public API.
   */
  RATE_LIMIT_INTERVAL_MS: "HIKOUTEI_SYNC_RATE_LIMIT_INTERVAL_MS",
  /**
   * Optional service-account credential POOL: a comma-separated list of
   * ADC-format key-file paths, each a distinct Google quota principal. When
   * set, per-identity pacing and round-robin signing multiply the effective
   * per-user quota by the pool size. Absent (or blank) keeps the single
   * `GOOGLE_APPLICATION_CREDENTIALS` credential exactly as before. An
   * explicit pool overrides `providerOptions.serviceAccountKeyFiles`, like
   * the pacing env override does for `rateLimitIntervalMs`; conversely, a
   * NONEMPTY `providerOptions.serviceAccountKeyFiles` with this env key
   * unset also forms the effective pool (ADC is then not required). The pool
   * is RESOLVED AND VALIDATED on every startup path (it replaces the
   * mandatory `GOOGLE_APPLICATION_CREDENTIALS` gate); the file list is
   * PLUMBED into the provider only on the real-provider path — an injected
   * test transport never uses the pool identities.
   */
  CREDENTIAL_POOL_FILES: "HIKOUTEI_SYNC_CREDENTIALS",
} as const;

/**
 * Default cadences applied when the interval env vars are absent; the single
 * source of these values is `./cadence.js`.
 */
export {
  SYNC_FULL_SCAN_INTERVAL_MS as DEFAULT_SYNC_FULL_SCAN_INTERVAL_MS,
  SYNC_POLLING_INTERVAL_MS as DEFAULT_SYNC_POLLING_INTERVAL_MS,
} from "./cadence.js";
/** Lower bound for the sync request-start pacing env override (2 seconds). */
export const MIN_SYNC_RATE_LIMIT_INTERVAL_MS = 2_000;
/**
 * Upper bound for the sync request-start pacing env override.
 *
 * A worst-case effect dispatch performs THREE sequential paced transport
 * calls (two preflight/postcondition reads plus one batch write). The effect
 * lease must still cover the whole sequence with the 30-second provider
 * headroom, and a dispatch can wait up to one FULL interval for its first
 * slot because the request's own read or write class limiter may hold a prior
 * reservation — admission
 * is BOUNDED to one interval, so a request whose slot lies further out is
 * refused before any SDK call (delivery-uncertain, requeued durably)
 * instead of waiting past the lease. With the DEFAULT lease, write timeout,
 * and read timeout the interval must satisfy
 * `120s > 60s + I + 2 * max(10s, I) + 30s`, i.e. `I < 10s`. Below
 * the 10 s read timeout the two read slots cost 2 x 10 s and the interval
 * adds once, so the bound is `I < 120 - 60 - 2x10 - 30 = 10 s`; at or
 * above the read timeout the interval dominates (`3I < 30s` has no
 * solution at or above 10 s), so the below-read-slot branch is binding.
 * The ceiling below is derived from those defaults (10,000 - 1 = 9,999 ms)
 * and the service-level lease-headroom validation applies the same math to
 * the ACTIVE lease and timeouts, so an override that could let pacing push
 * a dispatch past the lease is rejected with a stable startup failure
 * instead of risking lease expiry and duplicate remote delivery.
 */
export const MAX_SYNC_RATE_LIMIT_INTERVAL_MS = Math.max(
  MIN_SYNC_RATE_LIMIT_INTERVAL_MS,
  Math.floor(
    DEFAULT_EFFECT_LEASE_DURATION_MS -
      GOOGLE_SHEETS_API_DEFAULTS.REQUEST_TIMEOUT_MS -
      EFFECT_LEASE_PROVIDER_HEADROOM_MS -
      2 * GOOGLE_SHEETS_API_DEFAULTS.READ_TIMEOUT_MS,
  ) - 1,
);

/** Diagnostic log levels emitted by the auto-start bridge. */
export type SyncDiagnosticLevel = "info" | "error";

/** Diagnostic sink; defaults to console. Receives only stable class/code summaries, never full failure messages. */
export type SyncDiagnostic = (level: SyncDiagnosticLevel, message: string) => void;

/** One entity's existing-sheet adoption request (public adopt API, design D1/D4). */
export interface AdoptEntitySpec {
  /** The existing tab that becomes this entity's User_Input route (D1). */
  readonly tabName: string;
  /**
   * Sheet header that carries the business key. `"auto"` (or absent) prefers
   * the column matching the entity's primary-key property and falls back to
   * appending a generated PK column (D4). MVP: an alias whose header differs
   * from the PK property name is blocked with IDENTITY_ALIAS_UNSUPPORTED.
   */
  readonly identityFrom?: string | "auto";
  /**
   * Tab name for the freshly provisioned System_State projection. Defaults to
   * `<tabName>_System`.
   */
  readonly systemStateTabName?: string;
  /**
   * Tab name for the freshly provisioned Sync_Conflicts projection. Defaults
   * to `<tabName>_Conflicts`.
   */
  readonly syncConflictsTabName?: string;
  /**
   * §12: explicit header → property bindings for sheets whose headers differ
   * from the property names (adoption-only). Mapped headers take precedence
   * over name matching; a mapped PK header absorbs the identityFrom alias.
   */
  readonly columnMap?: Readonly<Record<string, string>>;
}

/** Public existing-sheet adoption spec (design `design/existing-sheet-adoption-design.md` §4.1). */
export interface AdoptSpec {
  readonly mode: "dry-run" | "adopt";
  readonly entities: Readonly<Record<string, AdoptEntitySpec>>;
}

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
  /**
   * Existing-sheet adoption (MVP, direct mode only). In `dry-run` mode the
   * result is `{ kind: "adopt-dry-run", report }` — the spreadsheet was not
   * mutated and no service started. In `adopt` mode the adopted tab becomes
   * the entity's User_Input route, every existing row is bound + seeded
   * (fail-closed, D5), and the normal sync service starts.
   */
  readonly adopt?: AdoptSpec;
  /**
   * Public provider subset forwarded verbatim into the sync-service
   * `googleSheetsApi` settings (real-transport path only). `onRequest` here
   * chains AFTER the engine's internal request-telemetry sink (see
   * `remoteProvider.ts`); a per-request env pacing override still wins over
   * `providerOptions.rateLimitIntervalMs`.
   */
  readonly providerOptions?: HikouteiProviderOptions;
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

/**
 * Adoption dry-run result: the read-only report was produced and the
 * spreadsheet was NOT mutated; no sync service was started.
 */
export interface AdoptDryRunResult {
  readonly kind: "adopt-dry-run";
  readonly report: ExistingSheetAdoptionRunReport;
}

export type TypedSheetsWithSyncResult = LocalSyncRuntimeResult | RunningSyncServiceResult | AdoptDryRunResult;

/** Required service-account fields validated before any remote contact. */
const REQUIRED_CREDENTIAL_FIELDS = ["type", "client_email", "private_key", "project_id"] as const;

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
    // P8-D2: the concrete local-runtime wiring is composition-owned; the
    // engine resolves it through the LIGHT composition port (the heavy
    // syncEngine ports thunk is never touched on this path), so the engine
    // never imports the composition package.
    const createLocalRuntime = await requireSyncEngineLocalRuntime();
    const hikoutei = await createLocalRuntime(options);
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
    // Resolve the EFFECTIVE credential pool FIRST — env (`HIKOUTEI_SYNC_
    // CREDENTIALS`) takes precedence, else a non-empty
    // `providerOptions.serviceAccountKeyFiles` — so a valid pool-only
    // deployment starts without `GOOGLE_APPLICATION_CREDENTIALS`: the primary
    // ADC file is mandatory only when NO pool is configured from either
    // source. With a pool, the 403 message names the FIRST pooled identity
    // (every pool identity must be shared on the sheet anyway, so slot 0's
    // email is the most actionable single hint) — never the ADC identity,
    // which worker/adoption signing do not use. Every listed file is
    // validated (readable + required service-account fields) BEFORE startup
    // so a misconfigured pool fails fast with a stable HikouteiError;
    // validation reads contents but never logs emails or key material beyond
    // path-bearing messages. Like the always-enforced ADC gate this replaces,
    // the pool is resolved even for an injected test transport (startup
    // validation); it is PLUMBED into the provider only on the real-provider
    // path.
    const envPool = await resolveSyncCredentialPoolEnv(env);
    const providerOptionPool = options.providerOptions?.serviceAccountKeyFiles;
    const providerOptionPoolFiles =
      providerOptionPool !== undefined && providerOptionPool.length > 0
        ? providerOptionPool
        : undefined;
    const serviceAccountKeyFiles = envPool ?? providerOptionPoolFiles;
    if (serviceAccountKeyFiles !== undefined) {
      if (envPool === undefined) {
        // providerOptions-supplied pool: same fail-closed whole-list check
        // the env path applies inside `resolveSyncCredentialPoolEnv`.
        for (const file of serviceAccountKeyFiles) {
          await validateSyncCredentialsFile(file);
        }
      }
      ({ clientEmail } = await validateSyncCredentialsFile(serviceAccountKeyFiles[0]));
    } else {
      ({ clientEmail } = await validateSyncCredentialsFile(
        env[SYNC_ENV_KEYS.CREDENTIALS_FILE],
      ));
    }
    const pollingIntervalMs = parseIntervalEnv(
      env,
      SYNC_ENV_KEYS.POLLING_INTERVAL_MS,
      SYNC_POLLING_INTERVAL_MS,
    );
    const pollingFullScanIntervalMs = parseIntervalEnv(
      env,
      SYNC_ENV_KEYS.FULL_SCAN_INTERVAL_MS,
      SYNC_FULL_SCAN_INTERVAL_MS,
    );
    // The pacing env override applies ONLY to the real Google Sheets
    // provider: it is resolved and validated only when no fake transport is
    // injected, so local/fake suites stay immune to a misconfigured or
    // invalid override in the host env.
    const rateLimitIntervalMs = options.transport === undefined
      ? resolveSyncRateLimitIntervalMs(env)
      : undefined;
    // NOTE: the credential pool (`serviceAccountKeyFiles`) is resolved and
    // validated at the TOP of this block — see the pool-first comment above.
    const projections = withAdoptedTabOverrides(
      buildSyncProjections(options.entities, spreadsheetId),
      options.entities,
      options.adopt,
    );
    const service = await createInternalSyncService({
      dbName: options.dbName,
      entities: [...options.entities],
      projections,
      // Injected transports are a test-only affordance; ZERO pacing keeps
      // stub-based suites wall-clock cheap AND immune to the bounded
      // admission (interval 0 never waits and never refuses). The pacing env
      // override applies ONLY to the real Google Sheets provider (no injected
      // transport): a valid override is plumbed through, and the production
      // path builds the real ADC-backed transport with the provider's safe
      // default (800 ms) when the override is absent. Fake transports never
      // consult HIKOUTEI_SYNC_RATE_LIMIT_INTERVAL_MS, so local/fake suites
      // stay immune to a misconfigured or invalid override in the host env.
      googleSheetsApi: options.transport === undefined
        ? {
          ...options.providerOptions,
          ...(rateLimitIntervalMs === undefined ? {} : { rateLimitIntervalMs }),
          // Real-provider path only: an injected stub transport is un-paced
          // and never signs with pool identities.
          ...(serviceAccountKeyFiles === undefined
            ? {}
            : { serviceAccountKeyFiles }),
        }
        : {
            // Test-injection path: the stub transport and ZERO pacing stay
            // pinned AFTER the spread so providerOptions can only ADD the
            // telemetry sink (onRequest) and timeout knobs, never override
            // the transport or reintroduce pacing/env sensitivity.
            ...options.providerOptions,
            transport: options.transport,
            rateLimitIntervalMs: 0,
            // Pin the per-minute budgets OFF explicitly (not via defaults):
            // the stub branch must stay fully unpaced regardless of future
            // default-budget changes.
            quotaReadBudgetPerMinute: Number.POSITIVE_INFINITY,
            quotaWriteBudgetPerMinute: Number.POSITIVE_INFINITY,
          },
      pollingIntervalMs,
      pollingFullScanIntervalMs,
      ...(options.adopt === undefined ? {} : { adopt: toInternalAdoptSpec(options.adopt) }),
    });
    logHikouteiInternalEvent({
      event: HIKOUTEI_LOG_EVENTS.SYNC_AUTOSTART_STARTED,
      level: HIKOUTEI_LOG_LEVELS.INFO,
      component: HIKOUTEI_LOG_COMPONENTS.SYNC_AUTOSTART,
      counts: { entities: options.entities.length },
    });
    return { kind: "sync", hikoutei: service.hikoutei, service };
  } catch (error: unknown) {
    // Adoption dry-run is a SUCCESSFUL outcome surfaced as a report, not a
    // failure: the bridge converts the internal fail-closed startup throw
    // into the `{ kind: "adopt-dry-run", report }` result variant — but ONLY
    // for `mode: "dry-run"`. A BLOCKED report under `mode: "adopt"` must stay
    // fail-closed (D5): adopt failures are loud, diagnosed startup failures
    // with the problem codes in the message, never a silent result shape.
    if (error instanceof ExistingSheetAdoptionDryRunReportError) {
      if (options.adopt?.mode === "adopt") {
        const blocked = error.report.entities
          .flatMap((entity) => entity.problems.map((problem) => `${entity.entityName}: ${problem.code}`));
        // The report rides on the error as an untyped `adoptionReport`
        // property: typing it here would pull the internal adoption types
        // into api/errors.ts and leak the SDK packages into the public
        // declaration graph (public-surface audit rule). Terra N1.
        const failure = new HikouteiError(
          HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
          `existing-sheet adoption is blocked by the dry-run analysis (${blocked.join("; ") || "no detail"}); run mode "dry-run" for the full report.`,
        );
        Object.assign(failure, { adoptionReport: error.report });
        return raiseDiagnosed(diagnostic, failure);
      }
      const result: AdoptDryRunResult = { kind: "adopt-dry-run", report: error.report };
      return result;
    }
    // The cell-kind-mismatch startup failure carries the precise diagnosis
    // (rows, fields, declared vs observed kinds); re-raise it with the full
    // message instead of the generic "Sync start failed" wrapper so the
    // public path is actionable (internal callers keep the stable
    // SyncServiceError code).
    if (error instanceof SyncServiceError
      && error.code === SYNC_SERVICE_ERROR_CODES.ADOPTION_CELL_KIND_MISMATCH) {
      return raiseDiagnosed(
        diagnostic,
        new HikouteiError(HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED, error.message),
      );
    }
    const failure = error instanceof HikouteiError
      ? error
      : classifySyncStartupFailure(error, spreadsheetId, clientEmail);
    return raiseDiagnosed(diagnostic, failure);
  }
}

/**
 * Re-derives the auto-generated projections for the adopted entities: the
 * adopted tab replaces the generated `<Entity>_Input` User_Input route (the
 * adoption gate requires the adopt tab to EQUAL the userInput route), and the
 * fresh System_State / Sync_Conflicts tabs derive from the adopted tab name
 * (defaults `<tab>_System` / `<tab>_Conflicts`) unless explicitly overridden.
 * Non-adopted entities keep their generated routes untouched.
 */
function withAdoptedTabOverrides(
  base: InternalSyncProjectionConfig,
  entities: readonly HikouteiEntity[],
  adopt: AdoptSpec | undefined,
): InternalSyncProjectionConfig {
  if (adopt === undefined) return base;
  const descriptorByName = new Map(entities.map((entity) => {
    const descriptor = getEntityDescriptor(entity);
    return [descriptor.name, descriptor];
  }));
  const configs = { ...base.entities };
  for (const [entityName, spec] of Object.entries(adopt.entities)) {
    const config = configs[entityName];
    if (config === undefined) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
        `adopt.entities references entity "${entityName}" that is not part of this runtime (declared: ${[...descriptorByName.keys()].join(", ") || "none"}).`,
      );
    }
    // NOTE: configs is derived from buildSyncProjections(options.entities),
    // so a config existing implies its descriptor exists — no second check.
    if (config.userInput === undefined) {
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
        `adopt.entities entity "${entityName}" has no generated User_Input route to replace.`,
      );
    }
    configs[entityName] = {
      ...config,
      userInput: { ...config.userInput, tabName: spec.tabName },
      systemState: {
        ...config.systemState,
        tabName: spec.systemStateTabName ?? `${spec.tabName}_System`,
      },
      syncConflicts: {
        ...config.syncConflicts,
        tabName: spec.syncConflictsTabName ?? `${spec.tabName}_Conflicts`,
      },
    };
  }
  return { spreadsheetId: base.spreadsheetId, entities: configs };
}

/** Narrows the public adopt spec to the internal bootstrap spec (same D1/D4 shape). */
function toInternalAdoptSpec(adopt: AdoptSpec): ExistingSheetAdoptionSpec {
  const entities: Record<string, {
    readonly tabName: string;
    readonly identityFrom?: string | "auto";
    readonly columnMap?: Readonly<Record<string, string>>;
  }> = {};
  for (const [entityName, spec] of Object.entries(adopt.entities)) {
    entities[entityName] = {
      tabName: spec.tabName,
      ...(spec.identityFrom === undefined ? {} : { identityFrom: spec.identityFrom }),
      ...(spec.columnMap === undefined ? {} : { columnMap: spec.columnMap }),
    };
  }
  return { mode: adopt.mode, entities };
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
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_INVALID_JSON,
      `Credentials file is not valid JSON: ${path}`,
    );
  }
  const record = parsed as Record<string, unknown>;
  const missing = REQUIRED_CREDENTIAL_FIELDS.filter((field) =>
    typeof record[field] !== "string" || (record[field] as string).trim() === "");
  if (missing.length > 0) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FIELD_MISSING,
      `Credentials file is missing required fields: ${missing.join(", ")}`,
    );
  }
  return { clientEmail: record.client_email as string };
}

/**
 * Parses and validates `HIKOUTEI_SYNC_CREDENTIALS`: a comma-separated list
 * of service-account key-file paths forming the credential pool.
 *
 * Every entry is validated through the same fail-closed file check as the
 * primary ADC credentials (readable JSON with the required service-account
 * fields) BEFORE any remote contact, so a misconfigured pool fails fast with
 * a stable `HikouteiError`. Returns `undefined` only when the key is absent
 * or genuinely blank (empty/whitespace-only — the single-credential path,
 * zero behavior change). A NON-blank value with an empty segment (e.g.
 * `",,"` or `"a.json,,b.json"`) is rejected instead of being silently
 * filtered into "unset": a typo'd pool must never degrade to the primary
 * credential without a word. Diagnostics carry paths only — never client
 * emails or key material.
 */
export async function resolveSyncCredentialPoolEnv(
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly string[] | undefined> {
  const raw = env[SYNC_ENV_KEYS.CREDENTIAL_POOL_FILES];
  if (raw === undefined || raw.trim() === "") return undefined;
  const files: string[] = [];
  for (const entry of raw.split(",")) {
    const file = entry.trim();
    if (file === "") {
      // Structured, redacted refusal: the raw value could legitimately
      // contain paths, so only the stable code and a schema hint are
      // reported — never the parsed segments.
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FIELD_MISSING,
        `${SYNC_ENV_KEYS.CREDENTIAL_POOL_FILES} is invalid: empty list entry ` +
          "(remove stray commas or unset the variable)",
      );
    }
    files.push(file);
  }
  for (const file of files) {
    // Awaited sequentially on purpose: every file is validated (and the
    // FIRST failure names only its path) before the pool is accepted.
    await validateSyncCredentialsFile(file);
  }
  return files;
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
  // Decimal-only shape: Number() would also accept hex ("0x10"), exponent
  // ("1e3"), signed ("-1"), and whitespace-padded (" 60000") forms that
  // violate the positive-integer-ms contract, so the raw string must match
  // before conversion.
  if (!/^\d+$/.test(raw)) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      `Sync start failed: ${key} must be a positive integer (ms) — current value: ${raw}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      `Sync start failed: ${key} must be a positive integer (ms) — current value: ${raw}`,
    );
  }
  return value;
}

/**
 * Resolves the sync request-start pacing env override, or undefined.
 *
 * `HIKOUTEI_SYNC_RATE_LIMIT_INTERVAL_MS` is the internal override for the
 * direct provider's independent read and write request-start limiters. Absent or
 * blank means the provider's safe default (800 ms) applies; a present
 * value must be a plain decimal integer between 2,000 ms and
 * `MAX_SYNC_RATE_LIMIT_INTERVAL_MS` (~10 s). The ceiling is the largest
 * interval whose worst-case three-request paced dispatch still finishes
 * inside the default effect lease (120 s) with the default write timeout
 * (60 s), read timeout (10 s), and provider headroom (30 s): a dispatch
 * can wait up to one full interval for its first slot because the
 * request's own class limiter may hold a prior reservation, so the strict
 * default-safe bound
 * is `120s > 60s + I + 2 * max(10s, I) + 30s` and a larger interval could
 * let pacing push the dispatch past the lease and risk duplicate remote
 * delivery. Values outside those bounds (including hex,
 * exponent, signed, padded, fractional, and non-numeric forms) fail closed
 * with the stable startup code so a mistyped override can never silently
 * drop pacing to a burst or outlive the effect lease. The key stays internal
 * and is never part of the root public API.
 */
export function resolveSyncRateLimitIntervalMs(
  env: Readonly<Record<string, string | undefined>>,
): number | undefined {
  const raw = env[SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS];
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      `Sync start failed: ${SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS} must be an integer between ` +
        `${MIN_SYNC_RATE_LIMIT_INTERVAL_MS} and ${MAX_SYNC_RATE_LIMIT_INTERVAL_MS} ms — current value: ${raw}`,
    );
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_SYNC_RATE_LIMIT_INTERVAL_MS ||
    value > MAX_SYNC_RATE_LIMIT_INTERVAL_MS
  ) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      `Sync start failed: ${SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS} must be an integer between ` +
        `${MIN_SYNC_RATE_LIMIT_INTERVAL_MS} and ${MAX_SYNC_RATE_LIMIT_INTERVAL_MS} ms — current value: ${raw}`,
    );
  }
  return value;
}

function raiseDiagnosed(diagnostic: SyncDiagnostic, failure: HikouteiError): never {
  logHikouteiInternalEvent({
    event: HIKOUTEI_LOG_EVENTS.SYNC_AUTOSTART_FAILED,
    level: HIKOUTEI_LOG_LEVELS.ERROR,
    component: HIKOUTEI_LOG_COMPONENTS.SYNC_AUTOSTART,
    ...describeErrorForInternalLog(failure),
  });
  // EVERY diagnostic sink — injected or default — receives only the
  // stable class/code summary. Full failure messages can embed the
  // service-account email, spreadsheet ID, credential path, or raw
  // provider text and must never reach a sink; the thrown HikouteiError
  // always carries the full public message regardless of the sink.
  try {
    diagnostic("error", stableStartupDiagnostic(failure));
  } catch {
    // Fail-open: a throwing diagnostic sink (injected or default) can
    // never replace the classified startup failure. The original
    // HikouteiError — with its stable class and machine-readable code —
    // is preserved and rethrown unchanged, exactly as if the sink had
    // succeeded.
  }
  throw failure;
}

/** Stable error-class allowlist backing sink diagnostics (see logEvents.ts). */
const STABLE_CLASS_ALLOWLIST: ReadonlySet<string> = new Set(HIKOUTEI_LOG_STABLE_CLASSES);
/** Stable error-code allowlist backing sink diagnostics (see logEvents.ts). */
const STABLE_CODE_ALLOWLIST: ReadonlySet<string> = new Set(HIKOUTEI_LOG_STABLE_CODES);

/**
 * Stable redacted startup summary for diagnostic sinks: class and code
 * only, each checked against the shared stable allowlists.
 *
 * `failure.name` and `failure.code` are runtime strings that could carry
 * secret-like text (paths, emails, tokens) if an unexpected error shape
 * ever reached the sink path, so unknown or malformed values collapse to
 * the fixed `unknown` class/code. The full public message is carried by
 * the thrown HikouteiError alone and never reaches any sink.
 */
export function stableStartupDiagnostic(failure: HikouteiError): string {
  const described = describeErrorForInternalLog(failure);
  const errorClass = STABLE_CLASS_ALLOWLIST.has(described.errorClass)
    ? described.errorClass
    : "unknown";
  const code = described.code !== undefined && STABLE_CODE_ALLOWLIST.has(described.code)
    ? described.code
    : "unknown";
  return `Hikoutei sync autostart failed (class=${errorClass}, code=${code})`;
}

/**
 * Shape gate for the default sink's error line (defense in depth).
 *
 * The error path receives only the stable class/code summary built by
 * `stableStartupDiagnostic`, but the gate re-validates the exact summary
 * shape before printing: an unexpected raw message (which could embed a
 * path, email, spreadsheet ID, or provider text) collapses to the
 * level-only fallback and never reaches the console.
 */
const STABLE_SUMMARY_SHAPE =
  /^Hikoutei sync autostart failed \(class=(unknown|[A-Za-z][A-Za-z0-9]*), code=(unknown|[A-Za-z][A-Za-z0-9_]*)\)$/;

function defaultDiagnostic(level: SyncDiagnosticLevel, message: string): void {
  if (level === "info") {
    // The info path emits only the static local-mode notice.
    console.info(message);
    return;
  }
  // The error path emits the already-redacted stable class/code summary
  // (never the full failure message — that stays on the thrown
  // HikouteiError). The shape gate above keeps the defense in depth:
  // anything that is not the exact stable summary shape falls back to the
  // level-only notice.
  if (STABLE_SUMMARY_SHAPE.test(message)) {
    console.error(message);
  } else {
    console.error(`[hikoutei] sync autostart failed (level=${level})`);
  }
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return error !== null &&
    typeof error === "object" &&
    (error as { readonly code?: unknown }).code === code;
}
