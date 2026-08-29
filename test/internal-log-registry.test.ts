/**
 * Cross-check for the internal log's explicit stable-code/class registries.
 *
 * The internal log accepts ONLY allowlisted `code` and `errorClass` values
 * (anything else is redacted), so the registries must cover every stable
 * `*_ERROR_CODES` constant that can reach a logged boundary. This test
 * imports the constants directly and asserts the registry stays in sync;
 * a newly added error code family fails here until it is registered.
 */

import { describe, expect, it } from "vitest";
import { HIKOUTEI_ERROR_CODES } from "../src/api/errors.js";
import { GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES } from "../src/adapter/sheets/providers/google-sheets-api/errors.js";
import { EVALUATION_ERROR_CODES } from "../src/domain/errors/evaluation.js";
import { TYPED_SHEETS_ORM_ERROR_CODES } from "../src/application/orm/errors.js";
import { SYNC_SERVICE_ERROR_CODES } from "../src/application/sync/service/errors.js";
import {
  SYNC_INVALID_PROVIDER_OPERATIONS,
  SYNC_INVALID_PROVIDER_REASONS,
  SYNC_SHEETS_ERROR_CODES,
} from "../src/application/sync/sheetsContract/errors.js";
import { STORAGE_ERROR_CODES } from "../src/infrastructure/storage/errors.js";
import {
  HIKOUTEI_LOG_PROVIDER_OPERATIONS,
  HIKOUTEI_LOG_PROVIDER_REASONS,
  HIKOUTEI_LOG_STABLE_CLASSES,
  HIKOUTEI_LOG_STABLE_CODES,
} from "../src/shared/observability/logEvents.js";

/** Every non-CLI error-code family that can reach a logged boundary. */
const RUNTIME_ERROR_CODE_FAMILIES = [
  HIKOUTEI_ERROR_CODES,
  SYNC_SHEETS_ERROR_CODES,
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  SYNC_SERVICE_ERROR_CODES,
  EVALUATION_ERROR_CODES,
  STORAGE_ERROR_CODES,
  TYPED_SHEETS_ORM_ERROR_CODES,
] as const;

describe("internal log stable-code registry", () => {
  it("covers every runtime error-code constant so drift fails the suite", () => {
    const registry = new Set(HIKOUTEI_LOG_STABLE_CODES);
    const uncovered: string[] = [];
    for (const family of RUNTIME_ERROR_CODE_FAMILIES) {
      for (const code of Object.values(family)) {
        if (!registry.has(code)) uncovered.push(code);
      }
    }
    // The CLI setup family (src/cli/errors.ts) is intentionally excluded: it
    // can never reach the runtime internal log.
    expect(uncovered).toEqual([]);
  });

  it("contains no secret-like values (no dots, @, slashes, or URLs)", () => {
    for (const code of HIKOUTEI_LOG_STABLE_CODES) {
      // `ERR_SQLITE_ERROR` is the exact stable node:sqlite driver code the
      // persistence engine surfaces; every other code is a lowercase
      // identifier, and anything else (URLs, emails, paths, IDs) is rejected.
      expect(code).toMatch(/^[a-z0-9_]+$|^SQLITE_[A-Z0-9_]+$|^ERR_SQLITE_ERROR$/);
    }
    expect(new Set(HIKOUTEI_LOG_STABLE_CODES).size).toBe(HIKOUTEI_LOG_STABLE_CODES.length);
  });

  it("contains only stable, non-secret error class names", () => {
    for (const className of HIKOUTEI_LOG_STABLE_CLASSES) {
      expect(className).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
    }
    // The project's structured error classes must never be redacted.
    for (const className of [
      "HikouteiError",
      "SyncSheetsContractError",
      "GoogleSheetsApiTransportError",
    ]) {
      expect(HIKOUTEI_LOG_STABLE_CLASSES).toContain(className);
    }
  });

  it("allowlists exactly the provider operation/reason classification constants", () => {
    // Exact contract: the runtime allowlist must equal the classification
    // constants in both directions, so adding a constant without allowlisting
    // it (or allowlisting a value with no constant) fails this test. The test
    // lives in `test/` so it may import both sides without creating a source
    // dependency cycle (`shared` cannot import `application`).
    expect(HIKOUTEI_LOG_PROVIDER_OPERATIONS).toEqual(Object.values(SYNC_INVALID_PROVIDER_OPERATIONS));
    expect(HIKOUTEI_LOG_PROVIDER_REASONS).toEqual(Object.values(SYNC_INVALID_PROVIDER_REASONS));
    for (const operation of Object.values(SYNC_INVALID_PROVIDER_OPERATIONS)) {
      expect(operation).toMatch(/^[a-z0-9_]+$/);
    }
    for (const reason of Object.values(SYNC_INVALID_PROVIDER_REASONS)) {
      expect(reason).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
