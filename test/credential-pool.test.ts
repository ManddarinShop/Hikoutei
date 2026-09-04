/**
 * Credential-free coverage for the service-account credential pool:
 *
 * - `nextPooledClientIndex`: the transport pool's deterministic round-robin
 *   cursor (0,1,...,N-1,0,...), with provider-admitted preferred indexes
 *   passing through WITHOUT skewing the fallback rotation.
 * - Admission/transport index binding: the identity the admission paced
 *   against IS the identity the transport request is stamped with (and the
 *   telemetry event reports) — request-scoped, never skewed.
 * - Per-identity pacing: per-minute budgets are enforced per pooled
 *   credential, so one saturated identity never blocks another, and the
 *   combined admitted rate scales with the pool size.
 * - Per-identity AIMD: a 429 on one identity grows only that identity's
 *   pacing multiplier; the others stay at 1x.
 *
 * The single-credential path (no pool) is covered by every existing suite:
 * these tests pin the pooled additions; the un-pooled regression proof is
 * `npm test` passing unmodified.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import { SYNC_PROJECTIONS } from "@hikoutei/contracts/sheets/constants.js";
import { presentValue } from "@hikoutei/contracts/state/index.js";
import {
  GoogleSheetsApiSyncProvider,
  type GoogleSheetsApiRequestEvent,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import {
  credentialBinding,
  PromiseTailLock,
  runRead,
  runWrite,
  type CredentialPacingPool,
  type CredentialPacingSlot,
  type GoogleSheetsApiProviderDeps,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/operations/shared.js";
import { ReceiptReadCursor } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/receiptCursor.js";
import { createReadCalibration } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/readPlan.js";
import { readRows } from "@hikoutei/sheets/sheets/providers/google-sheets-api/operations/readRows.js";
import { RequestStartLimiter, ReadQoSScheduler } from "@hikoutei/sheets/sheets/providers/google-sheets-api/transport/rateLimiter.js";
import {
  QUOTA_GOVERNOR_LANES,
  QuotaPacingGovernor,
  RollingQuotaBudget,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/transport/quotaGovernor.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/errors.js";
import {
  nextPooledClientIndex,
  type GoogleSheetsApiBatchUpdateRequest,
  type GoogleSheetsApiGetSpreadsheetRequest,
  type GoogleSheetsApiTransport,
  type GoogleSheetsApiValuesGetRequest,
  type GoogleSheetsApiValuesGetResponse,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/transport/googleSheetsApiTransport.js";
import { HIKOUTEI_ERROR_CODES } from "../src/index.js";
import {
  resolveSyncCredentialPoolEnv,
  SYNC_ENV_KEYS,
} from "@hikoutei/composition/syncAutoStart.js";
import { syncEngineCompositionPorts } from "@hikoutei/composition/syncEngine.js";
import { StubSheetsTransport, StubSpreadsheet } from "./support/StubSheetsTransport.js";
import { SYSTEM_HEADERS } from "./support/googleSheetsFixtures.js";

const SPREADSHEET_ID = "stub-spreadsheet";
const SYSTEM_SHEET_ID = "entity:users:system_state";

const SYSTEM_DEFINITION: RegisteredSyncProjectionDefinition = {
  sheet: {
    logicalSheetId: "entity:users",
    physicalSheetId: SYSTEM_SHEET_ID,
    spreadsheetId: SPREADSHEET_ID,
    tabName: "Users_System",
    registeredRange: "A:C",
    projection: SYNC_PROJECTIONS.SYSTEM_STATE as RegisteredSyncProjectionDefinition["sheet"]["projection"],
    schemaVersion: 1,
    ownershipManifestJson: "{}",
    businessKeyField: "id",
    anchorMode: "business_key",
  },
  headers: SYSTEM_HEADERS,
};

describe("nextPooledClientIndex (transport pool rotation)", () => {
  it("round-robins 0,1,...,N-1,0,... over sequential unbound requests", () => {
    const cursor = { next: 0 };
    const seen: number[] = [];
    for (let request = 0; request < 5; request += 1) {
      seen.push(nextPooledClientIndex(cursor, 2, undefined));
    }
    expect(seen).toEqual([0, 1, 0, 1, 0]);
  });

  it("honors an admitted index WITHOUT skewing the fallback rotation", () => {
    const cursor = { next: 0 };
    expect(nextPooledClientIndex(cursor, 3, 2)).toBe(2);
    // The preferred (provider-admitted) call consumed no fallback slot: the
    // next unbound request still starts the rotation at 0.
    expect(nextPooledClientIndex(cursor, 3, undefined)).toBe(0);
    expect(nextPooledClientIndex(cursor, 3, undefined)).toBe(1);
  });

  it("a 1-client pool always selects index 0 (single-credential path)", () => {
    const cursor = { next: 0 };
    for (let request = 0; request < 4; request += 1) {
      expect(nextPooledClientIndex(cursor, 1, undefined)).toBe(0);
    }
  });
});

describe("credentialBinding", () => {
  it("omits the key entirely on the single-credential path", () => {
    expect(credentialBinding(undefined)).toEqual({});
    expect("credentialIndex" in credentialBinding(undefined)).toBe(false);
    expect(credentialBinding(0)).toEqual({ credentialIndex: 0 });
  });
});

/** Recording transport: captures the credential index of every call. */
class RecordingTransport implements GoogleSheetsApiTransport {
  public readonly seenIndices: (number | undefined)[] = [];

  public constructor(private readonly inner: StubSheetsTransport) {}

  public async getSpreadsheet(
    request: GoogleSheetsApiGetSpreadsheetRequest,
  ): Promise<unknown> {
    this.seenIndices.push(request.credentialIndex);
    return this.inner.getSpreadsheet(request);
  }

  public async batchUpdate(request: GoogleSheetsApiBatchUpdateRequest): Promise<unknown> {
    this.seenIndices.push(request.credentialIndex);
    return this.inner.batchUpdate(request);
  }

  public async getValues(
    request: GoogleSheetsApiValuesGetRequest,
  ): Promise<GoogleSheetsApiValuesGetResponse> {
    this.seenIndices.push(request.credentialIndex);
    const values = await this.inner.getValues(request);
    return values;
  }
}

describe("provider credential pool: admission/transport index binding", () => {
  it("stamps the admitted identity into every transport request and event", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", {
      headers: SYSTEM_HEADERS,
      rows: [["u1", "pending", false]],
    });
    const transport = new RecordingTransport(new StubSheetsTransport(spreadsheet));
    const events: GoogleSheetsApiRequestEvent[] = [];
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [SYSTEM_DEFINITION],
      // The pool is validated by SHAPE here: an injected transport means the
      // provider never reads these (non-existent) files.
      serviceAccountKeyFiles: ["/pool/sa-1.json", "/pool/sa-2.json"],
      transport,
      rateLimitIntervalMs: 0,
      onRequest: (event) => events.push(event),
    });

    const readRequest = {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: SYSTEM_HEADERS,
    } as const;
    await provider.readRows(readRequest);
    await provider.readRows(readRequest);
    await provider.readRows(readRequest);
    await provider.readRows(readRequest);

    // Round-robin over the 2-identity pool: 0,1,0,1 — the identity the
    // admission paced IS the identity the request carries (no skew).
    expect(transport.seenIndices).toEqual([0, 1, 0, 1]);
    // Telemetry reports the same binding (index only, redacted).
    expect(events.map((event) => event.credentialIndex)).toEqual([0, 1, 0, 1]);
  });

  it("a single key file keeps requests UNBOUND (byte-identical no-pool path)", async () => {
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Users_System", {
      headers: SYSTEM_HEADERS,
      rows: [["u1", "pending", false]],
    });
    const transport = new RecordingTransport(new StubSheetsTransport(spreadsheet));
    const events: GoogleSheetsApiRequestEvent[] = [];
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: SPREADSHEET_ID,
      definitions: [SYSTEM_DEFINITION],
      serviceAccountKeyFiles: ["/pool/sa-only.json"],
      transport,
      rateLimitIntervalMs: 0,
      onRequest: (event) => events.push(event),
    });
    await provider.readRows({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "Users_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: SYSTEM_HEADERS,
    });
    // N=1: no index is stamped into the request or the event at all.
    expect(transport.seenIndices).toEqual([undefined]);
    expect("credentialIndex" in events[0]!).toBe(false);
  });
});

/** Builds one independent pacing slot on the test clock. */
function makeSlot(
  now: () => number,
  options: {
    readonly intervalMs?: number;
    readonly readBudget?: number;
  },
): CredentialPacingSlot {
  const quotaGovernor = new QuotaPacingGovernor({
    baseIntervalMs: options.intervalMs ?? 0,
    now,
  });
  return {
    quotaGovernor,
    readBudget: new RollingQuotaBudget({
      maxStartsPerWindow: options.readBudget ?? Number.POSITIVE_INFINITY,
      windowMs: 60_000,
      now,
      sleep: async () => undefined,
    }),
    writeBudget: new RollingQuotaBudget({
      maxStartsPerWindow: Number.POSITIVE_INFINITY,
      windowMs: 60_000,
      now,
      sleep: async () => undefined,
    }),
    readScheduler: new ReadQoSScheduler({
      intervalMs: options.intervalMs ?? 0,
      now,
      sleep: async () => undefined,
    }),
    writeLimiter: new RequestStartLimiter({
      intervalMs: options.intervalMs ?? 0,
      now,
      sleep: async () => undefined,
    }),
  };
}

function makePooledDeps(
  slots: CredentialPacingSlot[],
  transport: GoogleSheetsApiTransport,
  now: () => number,
): GoogleSheetsApiProviderDeps {
  const pool: CredentialPacingPool = { slots, nextIndex: 0 };
  return {
    spreadsheetId: SPREADSHEET_ID,
    providerNonce: "provider:test",
    preparedStateRegistry: new WeakSet<object>(),
    definitions: [SYSTEM_DEFINITION],
    transport,
    receiptInitLock: new PromiseTailLock(),
    receiptReadCursor: new ReceiptReadCursor(),
    sheetRowBounds: new Map<string, number>(),
    readCalibration: createReadCalibration(),
    readTimeoutMs: 60_000,
    maxBatchBytes: 2_000_000,
    readScheduler: slots[0]!.readScheduler,
    writeLimiter: slots[0]!.writeLimiter,
    readBudget: slots[0]!.readBudget,
    writeBudget: slots[0]!.writeBudget,
    quotaGovernor: slots[0]!.quotaGovernor,
    maxRequestStartWaitMs: 5_000,
    credentialPacing: pool,
    now,
    onRequest: undefined,
  };
}

describe("per-identity pacing", () => {
  it("a saturated slot 0 does not refuse a healthy slot 1 (multi-slot search)", async () => {
    let now = 1_000_000;
    // Slot 0's per-minute budget is 1, slot 1's is generous: the frozen
    // clock keeps every refusal INSTANT (no sleeping), so the divergent-
    // slot case isolates the search from the deadline arithmetic.
    const slots = [
      makeSlot(() => now, { readBudget: 1 }),
      makeSlot(() => now, { readBudget: 10 }),
    ];
    const deps = makePooledDeps(slots, new StubSheetsTransport(new StubSpreadsheet()), () => now);
    const admitted: (number | undefined)[] = [];
    const admit = () =>
      runRead(deps, (credentialIndex) => {
        admitted.push(credentialIndex);
        return Promise.resolve({ ok: true });
      }, "polling");

    await admit(); // rotation step 1: admitted on slot 0 (budget now full)
    await admit(); // rotation step 2: admitted on slot 1
    // Rotation step 3 STARTS on the saturated slot 0: its budget refusal
    // must fall through to the healthy slot 1 instead of refusing the
    // request outright.
    await admit();
    expect(admitted).toEqual([0, 1, 1]);
    // Per-slot bookkeeping lands on the ADMITTED slot only: the failed
    // slot-0 attempt reserved nothing.
    expect(slots[0]!.readBudget.reservedCount()).toBe(1);
    expect(slots[1]!.readBudget.reservedCount()).toBe(2);
  });

  it("one identity reaching its per-minute cap does not block the other", async () => {
    let now = 1_000_000;
    const slots = [makeSlot(() => now, { readBudget: 1 }), makeSlot(() => now, { readBudget: 1 })];
    const deps = makePooledDeps(slots, new StubSheetsTransport(new StubSpreadsheet()), () => now);

    const admit = () =>
      runRead(deps, async () => ({ sheets: [], grids: new Map() }), "polling");

    // Frozen clock: rotation 0,1,0,1 admits ONE start per identity (each
    // identity's budget is 1/window), so the combined admitted count is N.
    await admit();
    await admit();
    // The third start rotates back to identity 0, whose window is full:
    // the search tries identity 1 too — also full — so the request is
    // refused only when EVERY slot refuses (bounded admission), without
    // advancing any horizon.
    await expect(admit()).rejects.toBeInstanceOf(GoogleSheetsApiTransportError);
    expect(slots[0]!.readBudget.reservedCount()).toBe(1);
    expect(slots[1]!.readBudget.reservedCount()).toBe(1);
  });

  it("combined admitted starts scale with the pool (budget x N per window)", async () => {
    let now = 1_000_000;
    const slots = [makeSlot(() => now, { readBudget: 2 }), makeSlot(() => now, { readBudget: 2 })];
    const deps = makePooledDeps(slots, new StubSheetsTransport(new StubSpreadsheet()), () => now);
    const admitted: (number | undefined)[] = [];
    for (let request = 0; request < 4; request += 1) {
      await runRead(deps, (credentialIndex) => {
        admitted.push(credentialIndex);
        return Promise.resolve({ ok: true });
      }, "polling");
    }
    // 2 identities x budget 2 = 4 starts admitted in ONE window; a single
    // identity would have refused at start 3.
    expect(admitted).toEqual([0, 1, 0, 1]);
    expect(slots[0]!.readBudget.reservedCount()).toBe(2);
    expect(slots[1]!.readBudget.reservedCount()).toBe(2);
    // The fifth start (identity 0, window full) is refused without advancing
    // any horizon.
    await expect(
      runRead(deps, async () => ({ ok: true }), "polling"),
    ).rejects.toHaveProperty(
      "code",
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED,
    );
    // Identity 1's refusal never poisoned identity 0's window either.
    expect(slots[0]!.readBudget.reservedCount()).toBe(2);
    expect(slots[1]!.readBudget.reservedCount()).toBe(2);
  });

  it("an all-slot lane refusal rolls back every provisional budget reservation", async () => {
    // Huge pacing interval + finite budgets: after ONE admitted start per
    // slot the BUDGET gate keeps admitting while the LANE gate refuses on
    // every slot. Before provisional reservations existed, each refused
    // attempt leaked one budget reservation per tried slot, poisoning the
    // per-minute budgets despite zero request starts.
    let now = 1_000_000;
    const slots = [
      makeSlot(() => now, { intervalMs: 60_000, readBudget: 10 }),
      makeSlot(() => now, { intervalMs: 60_000, readBudget: 10 }),
    ];
    const deps = makePooledDeps(slots, new StubSheetsTransport(new StubSpreadsheet()), () => now);
    const admit = () => runRead(deps, async () => ({ ok: true }), "polling");
    // Warm-up: the first start per slot is admitted (empty lane horizon) and
    // pushes that slot's lane out by a full interval.
    await admit(); // slot 0
    await admit(); // slot 1
    // Every later attempt: budget admits provisionally, the lane refuses on
    // BOTH slots, so the whole request is refused (bounded admission).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(admit()).rejects.toHaveProperty(
        "code",
        GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED,
      );
    }
    // Zero leaked reservations: each budget still shows ONLY its one real
    // admitted start (pre-fix it would show 1 + 3 lane-refused reservations).
    expect(slots[0]!.readBudget.reservedCount()).toBe(1);
    expect(slots[1]!.readBudget.reservedCount()).toBe(1);
  });
});

describe("per-identity AIMD independence", () => {
  it("a 429 on identity 0 leaves identity 1's pacing interval at 1x", async () => {
    let now = 1_000_000;
    const slots = [makeSlot(() => now, { intervalMs: 800 }), makeSlot(() => now, { intervalMs: 800 })];
    const deps = makePooledDeps(slots, new StubSheetsTransport(new StubSpreadsheet()), () => now);
    const quota429 = () =>
      new GoogleSheetsApiTransportError(
        GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
        "quota",
        presentValue(429),
        presentValue("RESOURCE_EXHAUSTED"),
      );

    // Request 1 lands on identity 0 and fails with a 429.
    await expect(
      runRead(deps, async () => {
        throw quota429();
      }, "polling"),
    ).rejects.toBeInstanceOf(GoogleSheetsApiTransportError);

    // Only identity 0's READ lane backed off (2x base); identity 1 is nominal.
    expect(slots[0]!.quotaGovernor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(1_600);
    expect(slots[1]!.quotaGovernor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(800);

    // And the WRITE lanes stay untouched on both identities (per-lane
    // feedback is preserved inside each slot).
    expect(slots[0]!.quotaGovernor.intervalMsFor(QUOTA_GOVERNOR_LANES.WRITE)).toBe(800);
    expect(slots[1]!.quotaGovernor.intervalMsFor(QUOTA_GOVERNOR_LANES.WRITE)).toBe(800);

    // The write path feeds the SAME slot's write lane only.
    await expect(
      runWrite(deps, async () => {
        throw quota429();
      }),
    ).rejects.toBeInstanceOf(GoogleSheetsApiTransportError);
    // This start rotated to identity 1: its WRITE lane backed off, identity
    // 0's write lane stays at 1x.
    expect(slots[1]!.quotaGovernor.intervalMsFor(QUOTA_GOVERNOR_LANES.WRITE)).toBe(1_600);
    expect(slots[0]!.quotaGovernor.intervalMsFor(QUOTA_GOVERNOR_LANES.WRITE)).toBe(800);
  });
});

/** Writes one JSON payload as a key file and returns its path. */
function writeKeyFile(dir: string, name: string, payload: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

describe("key-file shape guard (fails at construction, not first request)", () => {
  it("rejects a JSON object that is not a service-account credential", () => {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-pool-key-"));
    try {
      const bad = writeKeyFile(dir, "bad.json", { hello: "world" });
      // Provider construction builds the real transport, which loads every
      // key file eagerly: a malformed file must throw HERE, not on first use.
      expect(() => new GoogleSheetsApiSyncProvider({
        spreadsheetId: SPREADSHEET_ID,
        definitions: [SYSTEM_DEFINITION],
        serviceAccountKeyFiles: [bad],
      })).toThrow(/missing required fields/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects blank service-account fields without leaking values", () => {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-pool-key-"));
    try {
      const bad = writeKeyFile(dir, "partial.json", {
        type: "service_account",
        client_email: "sa@example.com",
        private_key: "   ",
        project_id: "p",
      });
      let caught: unknown;
      try {
        new GoogleSheetsApiSyncProvider({
          spreadsheetId: SPREADSHEET_ID,
          definitions: [SYSTEM_DEFINITION],
          serviceAccountKeyFiles: [bad],
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GoogleSheetsApiTransportError);
      // The message carries the offending field NAME only — never any field
      // value (no email, no key material).
      const message = (caught as Error).message;
      expect(message).toContain("private_key");
      expect(message).not.toContain("sa@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a well-shaped key file constructs without touching the network", () => {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-pool-key-"));
    try {
      const good = writeKeyFile(dir, "good.json", {
        type: "service_account",
        project_id: "hikoutei-test",
        private_key_id: "k1",
        private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
        client_email: "pool-test@example.com",
        token_uri: "https://oauth2.googleapis.com/token",
      });
      expect(() => new GoogleSheetsApiSyncProvider({
        spreadsheetId: SPREADSHEET_ID,
        definitions: [SYSTEM_DEFINITION],
        serviceAccountKeyFiles: [good, good],
      })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("adoption reader transport: pool-only startup", () => {
  it("constructs from the pool's key files at port-call time (shape guard, no wire calls)", async () => {
    // Pool-only deployments have no ADC file: the composition adoption
    // reader must load the pooled credentials at construction, riding the
    // FIRST slot (deterministic, never the fallback round-robin) so it
    // matches the principal the startup 403 hint names.
    const ports = await syncEngineCompositionPorts();
    const goodPayload = {
      type: "service_account",
      project_id: "hikoutei-test",
      private_key_id: "k1",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
      client_email: "adoption-slot-0@example.com",
      token_uri: "https://oauth2.googleapis.com/token",
    };
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-adoption-pool-"));
    try {
      const goodFirst = writeKeyFile(dir, "sa-first.json", goodPayload);
      const badSecond = writeKeyFile(dir, "sa-bad.json", { hello: "world" });
      // Only the FIRST pooled file is loaded: the rest of the list is the
      // worker pool's concern, so a slot-0-valid list constructs even when a
      // later entry is malformed (proves slot-0-only, not whole-list load).
      expect(() =>
        ports.createAdoptionReaderTransport({
          serviceAccountKeyFiles: [goodFirst, badSecond],
        }),
      ).not.toThrow();
      // The pool IS consulted (not silently ADC): a malformed FIRST file
      // fails the construction-time shape guard before any wire call.
      expect(() =>
        ports.createAdoptionReaderTransport({
          serviceAccountKeyFiles: [badSecond, goodFirst],
        }),
      ).toThrow(/missing required fields/);
      // No pool: the historical ADC-only reader still constructs offline.
      expect(() => ports.createAdoptionReaderTransport(undefined)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("HIKOUTEI_SYNC_CREDENTIALS parsing", () => {
  it("rejects a non-blank value whose segments are empty (never falls back to ADC)", async () => {
    await expect(
      resolveSyncCredentialPoolEnv({ [SYNC_ENV_KEYS.CREDENTIAL_POOL_FILES]: ",," }),
    ).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FIELD_MISSING,
    });
    await expect(
      resolveSyncCredentialPoolEnv({ [SYNC_ENV_KEYS.CREDENTIAL_POOL_FILES]: "a.json,,b.json" }),
    ).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FIELD_MISSING,
    });
    // Trailing separators are empty segments too.
    await expect(
      resolveSyncCredentialPoolEnv({ [SYNC_ENV_KEYS.CREDENTIAL_POOL_FILES]: "a.json," }),
    ).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FIELD_MISSING,
    });
  });

  it("treats only genuinely blank input as unset", async () => {
    await expect(resolveSyncCredentialPoolEnv({})).resolves.toBeUndefined();
    await expect(
      resolveSyncCredentialPoolEnv({ [SYNC_ENV_KEYS.CREDENTIAL_POOL_FILES]: "   " }),
    ).resolves.toBeUndefined();
  });

  it("parses and validates a trimmed comma-separated pool list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-pool-env-"));
    try {
      const a = writeKeyFile(dir, "sa-a.json", {
        type: "service_account",
        project_id: "hikoutei-test",
        private_key_id: "k1",
        private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
        client_email: "a@example.com",
      });
      const b = writeKeyFile(dir, "sa-b.json", {
        type: "service_account",
        project_id: "hikoutei-test",
        private_key_id: "k2",
        private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
        client_email: "b@example.com",
      });
      await expect(
        resolveSyncCredentialPoolEnv({ [SYNC_ENV_KEYS.CREDENTIAL_POOL_FILES]: `${a} ,${b}` }),
      ).resolves.toEqual([a, b]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
