/**
 * Public-contract tests for the `env` default of `createTypedSheetsWithSync()`
 * (`src/api/syncRuntime.ts`).
 *
 * The documented contract is that `env` (default: `process.env`) drives sync
 * auto-start via `HIKOUTEI_SYNC_SPREADSHEET_URL` +
 * `GOOGLE_APPLICATION_CREDENTIALS`. These tests pin that the PUBLIC wrapper
 * forwards `process.env` at call time when `options.env` is omitted, and that
 * an explicit `options.env` wins over the host process env.
 *
 * No network and no credentials: the assertions use startup seams that fail
 * fast BEFORE any remote contact — a missing credentials file (classified
 * `SYNC_CREDENTIALS_FILE_MISSING`) proves the env was actually read, and the
 * local-only info diagnostic proves the sync-disabled branch is observable.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTypedSheetsWithSync,
  defineTypedSheetsEntity,
  HIKOUTEI_ERROR_CODES,
} from "../src/index.js";

const User = defineTypedSheetsEntity({
  name: "PublicSyncEnvUser",
  tableName: "public_sync_env_users",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});

const SPREADSHEET_URL = "https://docs.google.com/spreadsheets/d/sync-test-1/edit";
const CREDENTIALS_ENV = "GOOGLE_APPLICATION_CREDENTIALS";
const URL_ENV = "HIKOUTEI_SYNC_SPREADSHEET_URL";

describe("createTypedSheetsWithSync public env default", () => {
  const saved: Record<string, string | undefined> = {};
  const created: string[] = [];

  afterEach(() => {
    // Restore the host env exactly as this suite found it — other tests must
    // never observe these mutations.
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
      delete saved[key];
    }
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function missingCredentialsPath(): string {
    created.push(mkdtempSync(join(tmpdir(), "hikoutei-public-env-")));
    return join(created[created.length - 1]!, "missing-service-account.json");
  }

  function setProcessEnv(key: string, value: string): void {
    saved[key] ??= process.env[key];
    process.env[key] = value;
  }

  it("defaults env to process.env so autostart resolves host variables", async () => {
    // A valid URL plus a credentials path that does not exist: the bridge
    // validates the credentials file BEFORE any remote contact, so the
    // SYNC_CREDENTIALS_FILE_MISSING classification is deterministic proof
    // that the wrapper forwarded the real process env (with the wrapper's
    // old empty-env default this would instead resolve to kind: "local").
    setProcessEnv(URL_ENV, SPREADSHEET_URL);
    setProcessEnv(CREDENTIALS_ENV, missingCredentialsPath());
    const credentialsPath = process.env[CREDENTIALS_ENV]!;
    const diagnostics: Array<{ level: string; message: string }> = [];

    await expect(
      createTypedSheetsWithSync({
        dbName: ":memory:",
        entities: [User],
        onDiagnostic: (level, message) => diagnostics.push({ level, message }),
      }),
    ).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING,
      message: expect.stringContaining(credentialsPath),
    });
    expect(diagnostics[0]?.level).toBe("error");
  });

  it("reads process.env at call time (local-only when the host env is empty)", async () => {
    // No env vars set anywhere: without the URL the documented behavior is
    // the local-only runtime plus the "sync disabled" info diagnostic.
    const diagnostics: Array<{ level: string; message: string }> = [];
    const result = await createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      onDiagnostic: (level, message) => diagnostics.push({ level, message }),
    });
    expect(result.kind).toBe("local");
    expect(diagnostics).toEqual([
      {
        level: "info",
        message:
          "sync disabled — HIKOUTEI_SYNC_SPREADSHEET_URL is not set (local-only mode)",
      },
    ]);
    if (result.kind !== "local") return;
    await result.hikoutei.close();
  });

  it("an explicit options.env overrides the host process env", async () => {
    // The host process env points at a valid autostart configuration; the
    // explicit env omits the URL, so the explicit value must win and the
    // result must be local-only (NOT an autostart attempt against the
    // process-env credentials path).
    setProcessEnv(URL_ENV, SPREADSHEET_URL);
    setProcessEnv(CREDENTIALS_ENV, missingCredentialsPath());
    const diagnostics: Array<{ level: string; message: string }> = [];

    const result = await createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: {},
      onDiagnostic: (level, message) => diagnostics.push({ level, message }),
    });
    expect(result.kind).toBe("local");
    expect(diagnostics).toEqual([
      {
        level: "info",
        message:
          "sync disabled — HIKOUTEI_SYNC_SPREADSHEET_URL is not set (local-only mode)",
      },
    ]);
    if (result.kind !== "local") return;
    await result.hikoutei.close();
  });
});