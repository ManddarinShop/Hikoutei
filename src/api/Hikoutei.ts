/**
 * Public SQLite-authoritative Hikoutei runtime and the `createTypedSheets()` factory.
 *
 * This module intentionally knows nothing about Sheet routes or provider
 * provisioning. When `HIKOUTEI_SYNC_SPREADSHEET_URL` is set, the factory
 * delegates to the internal sync auto-start bridge, which builds a mapped
 * runtime and provisions the bound spreadsheet separately; the application-
 * facing contract stays unchanged either way.
 */

import type { ScalarEntityPersistenceProvider } from "../adapter/persistence/contracts/scalar.js";
import type { EntityManager } from "./EntityManager.js";
import { createEntityManager } from "./internalEntityManager.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "./errors.js";
import {
  getRegisteredEntityTokens,
  HikouteiEntity,
  type ResolvedHikouteiEntityDescriptor,
} from "./entity.js";
import {
  resolveEntityDescriptors,
  type EntityDescriptorResolutionFailure,
} from "./internalEntityRegistry.js";
import {
  describeErrorForInternalLog,
  getHikouteiInternalLogger,
  logHikouteiInternalEvent,
} from "../shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "../shared/observability/logEvents.js";

import { AsyncLocalStorage } from "node:async_hooks";

/** Environment variable that supplies the default SQLite path. */
const HIKOUTEI_DB_PATH_ENV = "HIKOUTEI_DB_PATH";

/** SQLite path used when neither `dbName` nor the env var is set. */
const DEFAULT_DB_PATH = "./hikoutei.sqlite";

/** Options for opening the local Hikoutei runtime. */
export interface CreateTypedSheetsOptions {
  /**
   * SQLite database path, URI, or `:memory:`.
   *
   * Defaults to the `HIKOUTEI_DB_PATH` environment variable when it is set to
   * a non-empty value, otherwise `./hikoutei.sqlite`.
   */
  readonly dbName?: string;
  /**
   * Entity tokens produced by `defineTypedSheetsEntity()`.
   *
   * Defaults to the entities registered by `defineTypedSheetsEntity()` at the
   * time of the call, in registration order.
   */
  readonly entities?: readonly HikouteiEntity[];
}

/**
 * Root object for the local entity runtime.
 *
 * Use `hikoutei.em.fork()` to obtain a request-local manager. Sheet delivery
 * and User_Input polling belong to the internal sync service, not this object.
 */
export interface Hikoutei {
  /** Root entity manager; call `fork()` before request or job-local work. */
  readonly em: EntityManager;
  close(): Promise<void>;
}

/**
 * Close lifecycle states of one runtime.
 *
 * - `open`: no close attempt has succeeded; close() may run.
 * - `closing`: one attempt is in flight; concurrent callers share it.
 * - `closed`: a close attempt succeeded; close() is terminal and idempotent.
 *
 * A FAILED attempt explicitly returns the state to `open` (in
 * performClose(), before the original error is rethrown), so a later
 * close() genuinely retries the full cleanup instead of no-oping on a
 * half-closed runtime.
 */
type CloseState = "open" | "closing" | "closed";

/**
 * Marks the async context of ONE beforeClose hook invocation with the
 * runtime whose hook is running, plus an explicitly ACTIVE flag.
 *
 * MEDIUM 5: a close() called from INSIDE the runtime's own active
 * beforeClose hook must never await that runtime's pending close attempt
 * (self-deadlock — the attempt cannot settle until the hook returns). The
 * stored runtime identity scopes the reentrancy exemption to the OWNING
 * runtime: `marker.runtime === this` resolves immediately, while a close()
 * on ANY OTHER runtime (a cross-runtime call made from inside the hook) is
 * NOT reentrant and must share that runtime's single in-flight attempt
 * like any ordinary concurrent caller — the global marker this replaces
 * would have skipped it. Because single-flight permits at most one attempt
 * per runtime, the runtime identity IS the attempt identity.
 *
 * Luna: the exemption additionally requires `active`. Detached callbacks
 * (a `setImmediate`, a detached promise continuation) scheduled by the
 * hook retain this AsyncLocalStorage store AFTER `run()` returns, so the
 * identity alone would keep exempting them forever; the flag is cleared in
 * `finally` when the hook's execution window ends, turning those callbacks
 * into ordinary concurrent callers whose close() awaits the same
 * close/drain attempt.
 */
interface BeforeCloseHookMarker {
  readonly runtime: HikouteiImpl;
  /** False once the hook invocation's execution window has ended. */
  active: boolean;
}

const beforeCloseHookContext = new AsyncLocalStorage<BeforeCloseHookMarker>();

class HikouteiImpl implements Hikoutei {
  /** Root entity manager; call `fork()` before request or job-local work. */
  readonly em: EntityManager;
  private closeState: CloseState = "open";
  /**
   * The single in-flight close attempt. Concurrent close() calls OUTSIDE
   * the active beforeClose hook await this same promise, so cleanup runs
   * exactly once per attempt and every caller observes the same outcome
   * (single-flight). The shared promise represents the FULL close +
   * process-logger-drain operation and settles only AFTER the drain
   * completes (final safe step), so a close() that lands while the first
   * attempt is still draining — including one arriving after
   * performClose() succeeded but before the drain finished — awaits the
   * SAME attempt until the drain is done instead of resolving early on
   * the terminal marker or starting a second cleanup. A close() called
   * from WITHIN the hook resolves immediately instead (MEDIUM 5:
   * awaiting the pending attempt from the hook would self-deadlock). A
   * failed attempt leaves the runtime retryable after the slot release.
   */
  private closeAttempt: Promise<void> | undefined;

  constructor(
    private readonly provider: ScalarEntityPersistenceProvider,
    descriptors: ReadonlyMap<string, ResolvedHikouteiEntityDescriptor>,
    private readonly beforeClose: (() => Promise<void>) | undefined,
  ) {
    this.em = createEntityManager(provider, descriptors);
  }

  /** Stops internal service work, then releases the local SQLite connection. */
  async close(): Promise<void> {
    // Concurrent callers share the single in-flight attempt. This check
    // comes BEFORE the terminal fast path so a caller that arrives after
    // performClose() succeeded but while the final logger drain is still
    // running awaits the SAME attempt (which settles only after drain)
    // instead of resolving early on the closed marker — the shared
    // promise represents the full close + drain operation.
    if (this.closeAttempt !== undefined) {
      // MEDIUM 5: a close awaited from within the ACTIVE beforeClose hook
      // of THIS runtime must not await the pending attempt — the attempt
      // cannot settle until the hook returns, so awaiting it would
      // self-deadlock. The call resolves immediately: the close is already
      // in progress and owned by the outer caller, so the hook must not
      // rely on the reentrant promise for completion. The exemption is
      // scoped to the OWNING runtime (runtime identity in the context) AND
      // to the hook's execution window (`active`): a close() on a
      // DIFFERENT runtime made from inside the hook, or a close() from a
      // DETACHED callback (setImmediate/promise continuation) that runs
      // AFTER the hook's execution window ended, is an ordinary concurrent
      // call and shares that runtime's in-flight attempt, observing its
      // exact outcome (Luna: the flag is cleared in `finally`, so the
      // detached callback cannot bypass the close/drain attempt). Callers
      // OUTSIDE any hook (no context store) keep sharing the attempt too.
      const marker = beforeCloseHookContext.getStore();
      if (marker !== undefined && marker.runtime === this && marker.active) {
        return;
      }
      return this.closeAttempt;
    }
    // A successful close is terminal and idempotent: later calls resolve
    // immediately without touching the provider again.
    if (this.closeState === "closed") return;

    let settleAttempt: (outcome: { ok: true } | { ok: false; error: unknown }) => void = () => {};
    const attempt = new Promise<void>((resolve, reject) => {
      settleAttempt = (outcome) => {
        if (outcome.ok) resolve();
        else reject(outcome.error);
      };
    });
    this.closeAttempt = attempt;
    // The shared attempt is observed by concurrent callers outside the
    // hook; when none exists, a failed attempt must not surface as an
    // unhandled rejection. The no-op side handler marks the rejection
    // handled for the runtime while those callers still receive the
    // original rejection.
    attempt.catch(() => undefined);
    // The attempt's outcome is decided ONLY after the process logger
    // drain completes (final safe step): the shared promise represents
    // the full close + drain operation, so a concurrent caller awaiting
    // it (including one that arrived while the drain was running) cannot
    // proceed before every final event is on disk.
    let failed = false;
    let failure: unknown;
    try {
      await this.performClose();
    } catch (error: unknown) {
      // Boolean flag, never `error !== undefined`: a hook or provider
      // that throws `undefined` is still a FAILED attempt and the shared
      // promise must reject, never resolve.
      failed = true;
      failure = error;
    }
    try {
      // The soak collector reads the log file immediately after close();
      // drain the process logger queue so every final event (including
      // RUNTIME_CLOSED and any close-failure line) is on disk before the
      // attempt settles. Drain is fail-open by contract, and even a
      // throwing drain must never mask the close outcome — it is
      // swallowed, never propagated.
      await getHikouteiInternalLogger().drain();
    } catch {
      // Fail-open: the drain exists to flush diagnostics, so its failure
      // must not change the close outcome decided above.
    }
    // Settle the shared attempt with the ORIGINAL outcome so every
    // concurrent caller observes exactly the same success or failure.
    if (failed) {
      settleAttempt({ ok: false, error: failure });
    } else {
      settleAttempt({ ok: true });
    }
    // Release the shared slot only after the attempt settled (final safe
    // step). On success performClose() made the close terminal; on
    // failure performClose() already returned the state to retryable
    // "open", so the NEXT close() call after the slot release genuinely
    // re-runs the cleanup. The original failure is rethrown unchanged to
    // THIS caller after the slot release; concurrent callers already
    // received it through the shared attempt.
    this.closeAttempt = undefined;
    if (failed) throw failure;
  }

  /**
   * Runs one full cleanup attempt (beforeClose + provider close).
   *
   * Marks the runtime terminally closed ONLY after the provider close
   * succeeded. EVERY failure — a throwing beforeClose hook, a throwing
   * provider close, or the aggregate of both — explicitly returns the
   * state to retryable `open` before the original error is rethrown
   * unchanged, so the next close() call genuinely re-runs the full
   * cleanup instead of no-oping on a half-closed runtime.
   */
  private async performClose(): Promise<void> {
    this.closeState = "closing";
    try {
      let beforeCloseFailed = false;
      let beforeCloseError: unknown;
      try {
        const beforeClose = this.beforeClose;
        if (beforeClose !== undefined) {
          // MEDIUM 5: the hook runs inside the marked async context so a
          // close() called from within it is recognized as reentrant for
          // THIS runtime (and never awaits its own pending attempt). The
          // stored runtime identity scopes the exemption: a cross-runtime
          // close() made from the hook is not reentrant.
          //
          // Luna: the exemption is scoped to the hook's EXECUTION WINDOW.
          // Detached setImmediate/promise callbacks scheduled by the hook
          // retain the AsyncLocalStorage store after run() returns, so the
          // active flag is cleared in `finally` once the hook's execution
          // has ended — those callbacks' close() then awaits the same
          // close/drain attempt instead of bypassing it. The flag is
          // cleared even when the hook throws.
          const marker = { runtime: this, active: true };
          try {
            await beforeCloseHookContext.run(marker, () => beforeClose());
          } finally {
            marker.active = false;
          }
        }
      } catch (error: unknown) {
        // Boolean flag, never `error !== undefined`: a hook that throws
        // `undefined` is still a FAILED hook and must keep the attempt
        // failed and retryable instead of being treated as success.
        beforeCloseFailed = true;
        beforeCloseError = error;
      }

      try {
        await this.provider.close();
      } catch (providerError: unknown) {
        logHikouteiInternalEvent({
          event: HIKOUTEI_LOG_EVENTS.RUNTIME_CLOSE_FAILED,
          level: "error",
          component: HIKOUTEI_LOG_COMPONENTS.RUNTIME,
          ...describeErrorForInternalLog(providerError),
        });
        if (beforeCloseFailed) {
          // Luna: the AggregateError preserves BOTH original failure
          // values as-thrown — including a hook that throws `undefined`
          // or `null`, which are legitimate thrown values. The errors
          // array must never replace the original hook failure with a
          // synthetic Error, so diagnostics can always inspect exactly
          // what each stage threw.
          throw new AggregateError(
            [beforeCloseError, providerError],
            "Hikoutei failed to stop internal work and close SQLite.",
          );
        }
        throw providerError;
      }

      if (beforeCloseFailed) {
        logHikouteiInternalEvent({
          event: HIKOUTEI_LOG_EVENTS.RUNTIME_CLOSE_FAILED,
          level: "error",
          component: HIKOUTEI_LOG_COMPONENTS.RUNTIME,
          ...describeErrorForInternalLog(beforeCloseError),
        });
        // `throw beforeCloseError` is intentional: `undefined` is a
        // legitimate thrown value and the rejection still marks the
        // attempt failed (the caller's catch below returns the state to
        // retryable open).
        throw beforeCloseError;
      }
      this.closeState = "closed";
      logHikouteiInternalEvent({
        event: HIKOUTEI_LOG_EVENTS.RUNTIME_CLOSED,
        level: "info",
        component: HIKOUTEI_LOG_COMPONENTS.RUNTIME,
      });
    } catch (error: unknown) {
      // Explicit state transition for EVERY failure path (beforeClose or
      // provider): the runtime returns to retryable `open` so the next
      // close() re-runs the cleanup. The original error is rethrown
      // unchanged; the shared-attempt slot was already released by the
      // caller's finally block.
      this.closeState = "open";
      throw error;
    }
  }
}

/**
 * Internal construction hook used by the sync service to attach shutdown work
 * without adding worker methods to the public `Hikoutei` contract.
 */
export function createInternalHikoutei(
  provider: ScalarEntityPersistenceProvider,
  descriptors: ReadonlyMap<string, ResolvedHikouteiEntityDescriptor>,
  beforeClose?: () => Promise<void>,
): Hikoutei {
  return new HikouteiImpl(provider, descriptors, beforeClose);
}

/**
 * Resolves the default SQLite path for a factory call that omits `dbName`.
 *
 * Prefers the `HIKOUTEI_DB_PATH` environment variable when it is set to a
 * non-empty string, otherwise falls back to `./hikoutei.sqlite`. The `env`
 * parameter defaults to `process.env` and exists so tests can exercise the
 * precedence without mutating the process environment.
 */
export function resolveDefaultDbPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const fromEnv = env[HIKOUTEI_DB_PATH_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  return DEFAULT_DB_PATH;
}

/**
 * Validates the public factory options before any runtime is constructed.
 *
 * Fields are optional; each one is validated only when it is provided. The
 * registry/env defaults are applied afterwards by `createTypedSheets()`.
 */
export function validateTypedSheetsOptions(options: CreateTypedSheetsOptions): void {
  if (options === null || typeof options !== "object") {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      "createTypedSheets() options must be an object.",
    );
  }
  if (options.dbName !== undefined && (typeof options.dbName !== "string" || options.dbName.trim() === "")) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      "createTypedSheets() dbName must be a non-empty string.",
    );
  }
  if (options.entities !== undefined && !Array.isArray(options.entities)) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      "createTypedSheets() entities must be an array.",
    );
  }
}

/**
 * Opens the plain local-only SQLite runtime with no sync service.
 *
 * Internal construction hook shared by `createTypedSheets()` (env absent) and
 * the sync auto-start bridge (env present but disabled). It deliberately loads
 * the current provider lazily so importing the root package alone never
 * requires MikroORM or the Google SDK module graph. Omitting `dbName` or
 * `entities` here applies the same defaults as `createTypedSheets()`.
 */
export async function createLocalTypedSheetsRuntime(
  options: CreateTypedSheetsOptions,
): Promise<Hikoutei> {
  const startedAt = Date.now();
  try {
    const dbName = options.dbName ?? resolveDefaultDbPath();
    const entities = options.entities ?? getRegisteredEntityTokens();
    const descriptors = resolveEntityDescriptors(entities, throwHikouteiResolutionError);
    // Load the current provider only when a runtime is opened. Importing the
    // root package alone must not require MikroORM or expose its module graph.
    const [engineModule, providerModule, runtimeModule] = await Promise.all([
      import("../adapter/persistence/providers/mikro-orm/engine/MikroOrmScalarStorage.js"),
      import("../adapter/persistence/providers/mikro-orm/api/MikroOrmScalarPersistenceProvider.js"),
      import("../adapter/persistence/providers/mikro-orm/engine/MikroOrmScalarEntityRuntime.js"),
    ]);
    const generated = runtimeModule.createMikroOrmScalarEntityRuntime(entities);
    const storage = await engineModule.initializeMikroOrmScalarStorage({
      dbName,
      entities: generated.entities,
    });
    const provider = new providerModule.MikroOrmScalarPersistenceProvider(storage, generated.bindings);
    const hikoutei = createInternalHikoutei(provider, descriptors);
    logHikouteiInternalEvent({
      event: HIKOUTEI_LOG_EVENTS.RUNTIME_OPENED,
      level: "info",
      component: HIKOUTEI_LOG_COMPONENTS.RUNTIME,
      durationMs: Date.now() - startedAt,
      counts: { entities: descriptors.size },
    });
    return hikoutei;
  } catch (error: unknown) {
    logHikouteiInternalEvent({
      event: HIKOUTEI_LOG_EVENTS.RUNTIME_OPEN_FAILED,
      level: "error",
      component: HIKOUTEI_LOG_COMPONENTS.RUNTIME,
      durationMs: Date.now() - startedAt,
      ...describeErrorForInternalLog(error),
    });
    throw error;
  }
}

/**
 * Opens the local SQLite runtime for the declared scalar entities.
 *
 * When `dbName` is omitted the `HIKOUTEI_DB_PATH` environment variable or
 * `./hikoutei.sqlite` is used; when `entities` is omitted the tokens registered
 * by `defineTypedSheetsEntity()` are used, in registration order.
 *
 * When `HIKOUTEI_SYNC_SPREADSHEET_URL` is set, the internal sync auto-start
 * bridge provisions the spreadsheet, validates the service-account
 * credentials file, and starts the outbound worker and User_Input polling
 * before returning. Startup failures are classified into stable
 * `HikouteiError` codes and fail closed. Without that env var this call never
 * contacts Google Sheets, creates projection tables, or starts a worker, and
 * the local-only behavior is byte-identical to previous releases.
 */
export async function createTypedSheets(
  options: CreateTypedSheetsOptions = {},
): Promise<Hikoutei> {
  validateTypedSheetsOptions(options);

  const dbName = options.dbName ?? resolveDefaultDbPath();
  const entities = options.entities ?? getRegisteredEntityTokens();
  if (options.entities === undefined && entities.length === 0) {
    throw new HikouteiError(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      "createTypedSheets() requires at least one entity; pass `entities` or call defineTypedSheetsEntity() before opening the runtime.",
    );
  }

  const spreadsheetUrl = process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
  if (spreadsheetUrl === undefined || spreadsheetUrl.trim() === "") {
    // Env absent: the exact local-only path. The sync module graph (MikroORM
    // and the Google SDK) is never imported here.
    return createLocalTypedSheetsRuntime({ dbName, entities });
  }

  // Env present: delegate to the internal sync auto-start bridge. The dynamic
  // import keeps the module graph out of the env-absent path.
  const { createTypedSheetsWithSync } = await import(
    "../application/sync/service/syncAutoStart.js"
  );
  const result = await createTypedSheetsWithSync({
    dbName,
    entities: [...entities],
    env: process.env,
  });
  return result.hikoutei;
}

/**
 * Maps a structured descriptor-registry failure to the public
 * `HikouteiError` contract with unchanged codes and messages.
 */
function throwHikouteiResolutionError(
  failure: EntityDescriptorResolutionFailure,
): never {
  switch (failure.kind) {
    case "invalid-token":
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
        "createTypedSheets() accepts only tokens produced by defineTypedSheetsEntity().",
      );
    case "duplicate-name":
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.DUPLICATE_ENTITY,
        `entity name "${failure.entityName}" is registered more than once.`,
      );
    case "duplicate-table":
      throw new HikouteiError(
        HIKOUTEI_ERROR_CODES.DUPLICATE_ENTITY,
        `table "${failure.tableName}" is shared by entities "${failure.firstEntityName}" and "${failure.secondEntityName}".`,
      );
  }
}
