#!/usr/bin/env node
/**
 * `hikoutei-mcp` stdio server entrypoint.
 *
 * Boot sequence: resolve the config path (`--config`, `HIKOUTEI_MCP_CONFIG`,
 * or `./hikoutei.config.json`), gap-fill the environment from `.env`
 * (typically written by `hikoutei setup`), register the declared entities,
 * then open the Hikoutei runtime with `createTypedSheets()` — sync starts
 * automatically when `HIKOUTEI_SYNC_SPREADSHEET_URL` is set, exactly like the
 * library's documented env-driven bootstrap.
 *
 * stdout belongs to the JSON-RPC channel, so all diagnostics go to stderr.
 * Any startup failure is reported on stderr and exits 1 (fail closed). On
 * SIGINT/SIGTERM the runtime is closed cleanly; undelivered Sheet effects
 * remain durable in the outbox and resume on the next session.
 */

import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";
import type { HikouteiEntity, Hikoutei } from "hikoutei";
import {
  loadHikouteiMcpConfig,
  resolveConfigPath,
} from "./config.js";
import { loadEnvFile } from "./env.js";
import {
  buildToolEntityInfos,
} from "./values.js";
import {
  buildToolDefinitions,
  callHikouteiTool,
  type HikouteiToolContext,
} from "./tools.js";

/** Server identity reported during MCP initialization. */
const SERVER_NAME = "hikoutei-mcp";
/** Server version reported during MCP initialization. */
const SERVER_VERSION = "0.1.0";
/** CLI flag for an explicit .env path. */
const ENV_FLAG = "--env";
/** Default .env file name loaded from the CWD when present. */
const DEFAULT_ENV_FILE = ".env";
/** Fallback SQLite path when HIKOUTEI_DB_PATH is unset. */
const DEFAULT_DB_PATH = "./hikoutei.sqlite";

/**
 * Builds a connected-ready MCP server over an open Hikoutei runtime.
 *
 * Exposed for tests, which attach an in-memory transport instead of stdio.
 * The returned `Server` answers `tools/list` and `tools/call` only; the
 * caller owns transport lifecycle.
 */
export function createHikouteiMcpServer(context: HikouteiToolContext): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "Typed entity access over a SQLite-authoritative store with an asynchronous Google Sheets projection. " +
        "Reads and writes always hit local SQLite; the Sheet catches up asynchronously (get_sync_status). " +
        "Human Sheet edits surface as conflicts (list_conflicts) and need a human decision.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: buildToolDefinitions(context.entityInfos),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as unknown;
    const outcome = await callHikouteiTool(context, request.params.name, args);
    return {
      content: [...outcome.content],
      ...(outcome.structuredContent !== undefined
        ? { structuredContent: outcome.structuredContent as Record<string, unknown> }
        : {}),
      ...(outcome.isError === true ? { isError: true } : {}),
    };
  });
  return server;
}

/** Production entrypoint; wires config, env, runtime, and stdio transport. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const envPath = readFlagValue(argv, ENV_FLAG) ?? DEFAULT_ENV_FILE;
  try {
    const envResult = await loadEnvFile(envPath, process.env);
    if (envResult.applied > 0) {
      console.error(`[hikoutei-mcp] loaded ${envResult.applied} variable(s) from ${envPath}`);
    }
  } catch (error: unknown) {
    failStartup(`could not load env file ${envPath}: ${messageOf(error)}`);
  }

  const configPath = resolveConfigPath(argv, process.env);
  if (configPath === null) {
    failStartup("no config path could be resolved; pass --config <path>.");
  }
  const configResult = await loadHikouteiMcpConfig(configPath);
  if (configResult.status === "invalid") {
    failStartup(configResult.reason);
  }

  const tokens = new Map<string, HikouteiEntity<object>>();
  for (const entity of configResult.config.entities) {
    const token = defineTypedSheetsEntity({
      name: entity.name,
      tableName: entity.tableName,
      properties: entity.properties,
    }) as HikouteiEntity<object>;
    tokens.set(entity.name, token);
  }

  const dbName = resolveDbName(process.env);
  let hikoutei: Hikoutei;
  try {
    hikoutei = await createTypedSheets({ dbName, entities: [...tokens.values()] });
  } catch (error: unknown) {
    failStartup(`could not open the hikoutei runtime at ${dbName}: ${messageOf(error)}`);
  }

  const context: HikouteiToolContext = {
    hikoutei,
    dbName,
    entityInfos: buildToolEntityInfos(configResult.config),
    tokens,
  };
  const server = createHikouteiMcpServer(context);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[hikoutei-mcp] serving ${context.entityInfos.size} entity(ies) from ${dbName} (config: ${configResult.sourcePath})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[hikoutei-mcp] ${signal} received; closing runtime`);
    try {
      await hikoutei.close();
    } catch (error: unknown) {
      console.error(`[hikoutei-mcp] close failed: ${messageOf(error)}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  transport.onclose = () => {
    void shutdown("transport closed");
  };
}

/** Resolves the SQLite path exactly like the library's default: env first. */
function resolveDbName(env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env.HIKOUTEI_DB_PATH;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim();
  return DEFAULT_DB_PATH;
}

/** Reads the value following a `--flag` argument, or null when absent. */
function readFlagValue(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (value === undefined || value === "") return null;
  return value;
}

/** Prints one diagnostic to stderr and exits 1 (fail closed). */
function failStartup(message: string): never {
  console.error(`[hikoutei-mcp] ${message}`);
  process.exit(1);
}

/** Best-effort human-readable message from an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when this module is the Node entry script (bin/CLI), not an import. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  await main();
}
