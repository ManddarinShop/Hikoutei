import { randomUUID } from "node:crypto";

import type { SyncSheetsGatewayPorts, SyncSheetsGatewayLease } from "./contracts.js";
import { SyncSheetsGatewayClient } from "./client.js";
import {
  InProcessSyncSheetsGatewayServer,
  type InProcessSyncSheetsGatewayServerOptions,
} from "./server.js";

export * from "./client.js";
export * from "./contracts.js";
export * from "./errors.js";
export * from "./server.js";

/** Options for the current in-process implementation of the gateway boundary. */
export interface CreateInProcessSyncSheetsGatewayOptions
  extends Omit<InProcessSyncSheetsGatewayServerOptions, "gatewayId" | "ports"> {
  readonly gatewayId?: string;
  readonly clientId?: string;
  readonly ports: SyncSheetsGatewayPorts;
}

/** Gateway handles returned to the internal service composition root. */
export interface InProcessSyncSheetsGateway {
  readonly server: InProcessSyncSheetsGatewayServer;
  readonly client: SyncSheetsGatewayClient;
  readonly lease: SyncSheetsGatewayLease;
  readonly release: () => Promise<void>;
}

/**
 * Creates one server/client pair around one coordinated provider instance.
 *
 * The returned client is the only object the workers should receive. The
 * server and its lease are internal lifecycle handles for the host process.
 */
export function createInProcessSyncSheetsGateway(
  options: CreateInProcessSyncSheetsGatewayOptions,
): InProcessSyncSheetsGateway {
  const gatewayId = options.gatewayId ?? `sync-sheets-gateway:${randomUUID()}`;
  const clientId = options.clientId ?? `sync-sheets-client:${randomUUID()}`;
  const server = new InProcessSyncSheetsGatewayServer({
    ...options,
    gatewayId,
    ports: options.ports,
  });
  const client = server.createClient(clientId);
  return {
    server,
    client,
    lease: server.getLease(),
    release: async () => server.close(),
  };
}
