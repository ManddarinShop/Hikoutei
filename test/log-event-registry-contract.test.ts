/**
 * Contract tests for the internal log registries
 * (`src/shared/observability/logEvents.ts`).
 *
 * The registries are a deliberate allowlist: an unknown or arbitrary
 * `error.code` or `errorClass` (which could be an ID-like secret) must never
 * pass through to the internal log. These tests pin the registries to the
 * actual source taxonomy — every stable code and first-party error class the
 * named layers can emit must be allowlisted, and the code registry must not
 * carry values no layer can emit (the node:sqlite driver family codes are
 * the only external runtime codes allowed).
 *
 * Deliberately absent on purpose: the CLI setup taxonomy
 * (`SETUP_ERROR_CODES` in `src/cli/errors.ts`) and the internal MCP
 * sync-status reader (`HIKOUTEI_SYNC_STATUS_ERROR_CODES` /
 * `HikouteiSyncStatusError` in `src/internal/syncStatus.ts`) are separate
 * tooling surfaces that never route through the runtime log, and the
 * canonical-codec family of `@hikoutei/kohkai` is broader than the
 * stable-encoding subset Hikoutei actually raises.
 */

import { describe, expect, it } from "vitest";

import {
  HIKOUTEI_LOG_EVENTS,
  HIKOUTEI_LOG_STABLE_CLASSES,
  HIKOUTEI_LOG_STABLE_CODES,
} from "../src/shared/observability/logEvents.js";
import { formatHikouteiLogLine } from "../src/shared/observability/internalLog.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "../src/api/errors.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../src/application/orm/errors.js";
import {
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "@hikoutei/contracts/sheets/errors.js";
import {
  SYNC_SERVICE_ERROR_CODES,
  SyncServiceError,
} from "../src/application/sync/service/errors.js";
import {
  STORAGE_ERROR_CODES,
  StorageError,
} from "../src/infrastructure/storage/errors.js";
import {
  EVALUATION_ERROR_CODES,
  EvaluationContractError,
} from "@hikoutei/contracts/domain/errors/evaluation.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
} from "../src/adapter/sheets/providers/google-sheets-api/errors.js";
import { STABLE_ENCODING_ERROR_CODES } from "@hikoutei/contracts/encoding/constants.js";
import { StableEncodingError } from "@hikoutei/contracts/domain/errors/stableEncoding.js";
import { DuplicateChangedFieldError } from "@hikoutei/contracts/domain/errors/identity.js";

/** Every stable code a first-party layer can emit (mirrors the registry comment). */
const TAXONOMY_CODES: readonly string[] = [
  ...Object.values(HIKOUTEI_ERROR_CODES),
  ...Object.values(TYPED_SHEETS_ORM_ERROR_CODES),
  ...Object.values(SYNC_SHEETS_ERROR_CODES),
  ...Object.values(SYNC_SERVICE_ERROR_CODES),
  ...Object.values(STORAGE_ERROR_CODES),
  ...Object.values(EVALUATION_ERROR_CODES),
  ...Object.values(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES),
  ...Object.values(STABLE_ENCODING_ERROR_CODES),
  // Domain event-identity code (src/domain/errors/identity.ts); no exported
  // code constant exists, so derive it from the raised class.
  new DuplicateChangedFieldError("field").code,
];

/** External runtime codes (not source constants) the registry may carry. */
const DRIVER_FAMILY_CODES: readonly string[] = ["ERR_SQLITE_ERROR"];

/** First-party error classes that surface at the internal log boundary. */
const BOUNDARY_ERROR_CLASSES: readonly string[] = [
  HikouteiError.name,
  TypedSheetsOrmError.name,
  SyncSheetsContractError.name,
  SyncServiceError.name,
  StorageError.name,
  EvaluationContractError.name,
  StableEncodingError.name,
  DuplicateChangedFieldError.name,
  GoogleSheetsApiTransportError.name,
];

describe("HIKOUTEI_LOG_STABLE_CODES registry", () => {
  it("allowlists every stable code the source taxonomy can emit", () => {
    for (const code of TAXONOMY_CODES) {
      expect(HIKOUTEI_LOG_STABLE_CODES, `missing taxonomy code: ${code}`).toContain(code);
    }
  });

  it("carries no stale values beyond the node:sqlite driver family", () => {
    const extras = HIKOUTEI_LOG_STABLE_CODES.filter(
      (code) => !TAXONOMY_CODES.includes(code) && !DRIVER_FAMILY_CODES.includes(code),
    );
    expect(extras).toEqual([]);
  });

  it("keeps the driver family exactly at the code node:sqlite surfaces", () => {
    const driverCodes = HIKOUTEI_LOG_STABLE_CODES.filter(
      (code) => !TAXONOMY_CODES.includes(code),
    );
    expect(driverCodes).toEqual(DRIVER_FAMILY_CODES);
  });
});

describe("HIKOUTEI_LOG_STABLE_CLASSES registry", () => {
  it("allowlists every first-party error class at the log boundary", () => {
    for (const className of BOUNDARY_ERROR_CLASSES) {
      expect(HIKOUTEI_LOG_STABLE_CLASSES, `missing class: ${className}`).toContain(
        className,
      );
    }
  });
});

describe("registry wiring in the formatter", () => {
  it("passes allowlisted codes/classes and redacts unknown values", () => {
    const valid = formatHikouteiLogLine({
      event: HIKOUTEI_LOG_EVENTS.EM_FLUSH_FAILED,
      code: STABLE_ENCODING_ERROR_CODES.CYCLIC_VALUE,
      errorClass: StorageError.name,
    });
    expect(valid.status).toBe("valid");
    if (valid.status !== "valid") return;
    expect(valid.line).toContain(
      `"code":"${STABLE_ENCODING_ERROR_CODES.CYCLIC_VALUE}"`,
    );
    expect(valid.line).toContain('"errorClass":"StorageError"');

    const redacted = formatHikouteiLogLine({
      event: HIKOUTEI_LOG_EVENTS.EM_FLUSH_FAILED,
      code: "some_id_like_secret",
      errorClass: "SomeInternalError",
    });
    expect(redacted.status).toBe("valid");
    if (redacted.status !== "valid") return;
    expect(redacted.line).toContain('"code":"[redacted]"');
    expect(redacted.line).toContain('"errorClass":"[redacted]"');
  });
});
