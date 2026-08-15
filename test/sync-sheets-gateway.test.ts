import { describe, expect, it } from "vitest";

import {
  CoordinatedSheetsProvider,
} from "../src/application/sync/sheetsContract/mutationCoordinator/CoordinatedSheetsProvider.js";
import {
  createInProcessSyncSheetsGateway,
} from "../src/application/sync/sheetsContract/gateway/index.js";
import {
  SYNC_SHEETS_GATEWAY_ERROR_CODES,
} from "../src/application/sync/sheetsContract/gateway/errors.js";
import {
  SYNC_SHEETS_GATEWAY_PROTOCOL_VERSION,
} from "../src/application/sync/sheetsContract/gateway/contracts.js";
import type {
  EnsureSyncRowAnchorsRequest,
  EnsureSyncRowAnchorsResult,
  FastAppendRowsRequest,
  FastAppendRowsResult,
  ApplySyncEffectsRequest,
  ApplySyncEffectsResult,
  ReadSyncEffectPostconditionsRequest,
  SyncEffectPostcondition,
  SyncEffectPostconditionResult,
  ReadSyncSnapshotRequest,
  SyncSheetsSnapshot,
  ReadSyncTableRowsRequest,
  SyncTableRowsResult,
  SyncSheetsProvider,
  SyncSheetsTableReader,
} from "../src/application/sync/sheetsContract/syncSheets.js";
import type { SyncSheetsProvisioner } from "../src/application/sync/sheetsContract/sheetsProvisioning.js";
import { FakeSyncSheetsProvider } from "./support/FakeSyncSheetsProvider.js";

class DelayedEnsureProvider implements SyncSheetsProvider, SyncSheetsTableReader {
  readonly firstEnsureStarted: Promise<void>;
  readonly maxConcurrentEnsures = { value: 0 };
  private readonly inner: FakeSyncSheetsProvider;
  private readonly resolveFirstEnsureStarted: () => void;
  private readonly releaseFirstEnsure: () => void;
  private readonly firstEnsureReleased: Promise<void>;
  private activeEnsures = 0;
  private ensureCalls = 0;

  public constructor(inner: FakeSyncSheetsProvider) {
    this.inner = inner;
    let resolveStarted!: () => void;
    this.firstEnsureStarted = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    this.resolveFirstEnsureStarted = resolveStarted;
    let resolveReleased!: () => void;
    this.firstEnsureReleased = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    this.releaseFirstEnsure = resolveReleased;
  }

  public release(): void {
    this.releaseFirstEnsure();
  }

  public async ensureRowAnchors(request: EnsureSyncRowAnchorsRequest): Promise<EnsureSyncRowAnchorsResult> {
    this.ensureCalls += 1;
    this.activeEnsures += 1;
    this.maxConcurrentEnsures.value = Math.max(
      this.maxConcurrentEnsures.value,
      this.activeEnsures,
    );
    try {
      if (this.ensureCalls === 1) {
        this.resolveFirstEnsureStarted();
        await this.firstEnsureReleased;
      }
      return await this.inner.ensureRowAnchors(request);
    } finally {
      this.activeEnsures -= 1;
    }
  }

  public readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncSheetsSnapshot> {
    return this.inner.readSnapshot(request);
  }

  public fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    return this.inner.fastAppendRows(request);
  }

  public applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    return this.inner.applyEffects(request);
  }

  public readEffectPostcondition(effect: Parameters<SyncSheetsProvider["readEffectPostcondition"]>[0]): Promise<SyncEffectPostcondition> {
    return this.inner.readEffectPostcondition(effect);
  }

  public readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncEffectPostconditionResult[]> {
    return this.inner.readEffectPostconditions(request);
  }

  public readRows(request: ReadSyncTableRowsRequest): Promise<SyncTableRowsResult> {
    return this.inner.readRows(request);
  }

  public readRowsBatch(
    requests: readonly ReadSyncTableRowsRequest[],
  ): Promise<readonly SyncTableRowsResult[]> {
    return this.inner.readRowsBatch(requests);
  }
}

const PROVISIONER: SyncSheetsProvisioner = {
  async provisionRegistry(registrations) {
    return {
      registrations: registrations.map(({ headers: _headers, ...registration }) => registration),
      createdSheets: [],
      initializedHeaders: [],
    };
  },
};

function ensureRequest(): EnsureSyncRowAnchorsRequest {
  return {
    physicalSheetId: "users-system",
    sheetName: "Users_System",
    registeredRange: "A:B",
    projection: "system_state",
    schemaVersion: 1,
  };
}

function createGateway() {
  const inner = new DelayedEnsureProvider(new FakeSyncSheetsProvider([{
    physicalSheetId: "users-system",
    sheetName: "Users_System",
    registeredRange: "A:B",
    projection: "system_state",
    schemaVersion: 1,
    headers: ["id"],
  }]));
  const coordinated = new CoordinatedSheetsProvider({ inner });
  const gateway = createInProcessSyncSheetsGateway({
    gatewayId: "gateway-test",
    spreadsheetId: "spreadsheet-test",
    ports: {
      effects: coordinated,
      observation: coordinated,
      tableReader: coordinated,
      provisioner: PROVISIONER,
    },
  });
  return { gateway, inner };
}

describe("in-process Sheets gateway", () => {
  it("serializes mutation and anchor calls from two clients through one coordinator", async () => {
    const { gateway, inner } = createGateway();
    try {
      const first = gateway.server.createClient("client-a");
      const second = gateway.server.createClient("client-b");
      const firstRequest = first.ensureRowAnchors(ensureRequest());
      await inner.firstEnsureStarted;
      const secondRequest = second.ensureRowAnchors(ensureRequest());
      await Promise.resolve();
      expect(inner.maxConcurrentEnsures.value).toBe(1);
      inner.release();
      await Promise.all([firstRequest, secondRequest]);
      expect(inner.maxConcurrentEnsures.value).toBe(1);
    } finally {
      await gateway.release();
    }
  });

  it("rejects protocol and lease violations, and enforces one gateway per spreadsheet", async () => {
    const { gateway } = createGateway();
    try {
      const lease = gateway.server.getLease();
      await expect(gateway.server.ensureRowAnchors({
        ...lease,
        protocolVersion: 99,
        clientId: "client-a",
        requestId: "bad-version",
        operation: "observation.ensure_row_anchors",
        payload: ensureRequest(),
      } as never)).rejects.toMatchObject({
        code: SYNC_SHEETS_GATEWAY_ERROR_CODES.PROTOCOL_MISMATCH,
      });
      await expect(gateway.server.ensureRowAnchors({
        ...lease,
        protocolVersion: SYNC_SHEETS_GATEWAY_PROTOCOL_VERSION,
        leaseToken: "stale-token",
        clientId: "client-a",
        requestId: "bad-lease",
        operation: "observation.ensure_row_anchors",
        payload: ensureRequest(),
      } as never)).rejects.toMatchObject({
        code: SYNC_SHEETS_GATEWAY_ERROR_CODES.LEASE_EXPIRED,
      });
      expect(() => createGateway()).toThrowError(
        expect.objectContaining({ code: SYNC_SHEETS_GATEWAY_ERROR_CODES.LEASE_CONFLICT }),
      );
    } finally {
      await gateway.release();
    }

    const replacement = createGateway();
    await replacement.gateway.release();
  });

  it("rejects malformed gateway envelopes before capability dispatch", async () => {
    const { gateway } = createGateway();
    try {
      const lease = gateway.server.getLease();
      await expect(gateway.server.ensureRowAnchors(null as never)).rejects.toMatchObject({
        code: SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
      });
      await expect(gateway.server.ensureRowAnchors({
        ...lease,
        protocolVersion: SYNC_SHEETS_GATEWAY_PROTOCOL_VERSION,
        clientId: "",
        requestId: "missing-client",
        operation: "observation.ensure_row_anchors",
        payload: ensureRequest(),
      } as never)).rejects.toMatchObject({
        code: SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
      });
      await expect(gateway.server.ensureRowAnchors({
        ...lease,
        protocolVersion: SYNC_SHEETS_GATEWAY_PROTOCOL_VERSION,
        clientId: "client-a",
        requestId: "wrong-payload-shape",
        operation: "observation.ensure_row_anchors",
        payload: [],
      } as never)).rejects.toMatchObject({
        code: SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
      });
      await expect(gateway.server.ensureRowAnchors({
        ...lease,
        protocolVersion: SYNC_SHEETS_GATEWAY_PROTOCOL_VERSION,
        clientId: "client-a",
        requestId: "unknown-operation",
        operation: "unknown.operation",
        payload: ensureRequest(),
      } as never)).rejects.toMatchObject({
        code: SYNC_SHEETS_GATEWAY_ERROR_CODES.INVALID_REQUEST,
      });
    } finally {
      await gateway.release();
    }
  });

  it("rejects requests after the singleton server is released", async () => {
    const { gateway } = createGateway();
    const client = gateway.server.createClient("client-a");
    await gateway.release();
    await expect(client.ensureRowAnchors(ensureRequest())).rejects.toMatchObject({
      code: SYNC_SHEETS_GATEWAY_ERROR_CODES.UNAVAILABLE,
    });
  });
});
