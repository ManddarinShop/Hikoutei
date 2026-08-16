#!/usr/bin/env node
/**
 * CI consumer smoke for the packed hikoutei-mcp tarball.
 *
 * Installs the tarball into a throwaway directory together with the pinned
 * MikroORM peer engines (hikoutei and its internal deps resolve from the
 * real npm registry), then drives the installed binary over stdio:
 * initialize handshake, tools/list, create_record, get_record, and
 * get_sync_status in local-only mode. This reproduces what a bare
 * `npx -y hikoutei-mcp` run does and would catch a broken dependency
 * spec, a missing engine dep, or a dead bin entry before publish.
 *
 * Usage: node run-mcp-consumer-smoke.mjs --package <mcp-tarball-path>
 * Exits 0 on success, 1 on any failure. No Google credentials required.
 */

import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface as createReadlineInterface } from "node:readline";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIKRO_ORM_VERSION = "7.1.7";
const EXPECTED_TOOL_COUNT = 8;

function parseArgs(argv) {
  const args = { package: undefined };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--package" && argv[index + 1] !== undefined) {
      args.package = argv[index + 1];
      index += 1;
    }
  }
  if (args.package === undefined) {
    console.error("usage: run-mcp-consumer-smoke.mjs --package <mcp-tarball-path>");
    process.exit(1);
  }
  return args;
}

function run(cmd, cmdArgs, cwd) {
  return execFileSync(cmd, cmdArgs, { cwd, encoding: "utf8" });
}

async function main() {
  const { package: packagePath } = parseArgs(process.argv);
  const consumerDir = join(process.env.RUNNER_TEMP ?? ".", "hikoutei-mcp-consumer-smoke");
  rmSync(consumerDir, { recursive: true, force: true });
  mkdirSync(consumerDir, { recursive: true });

  run("npm", ["init", "-y"], consumerDir);
  // hikoutei (a regular dependency of the tarball) and @hikoutei/ikisaki
  // resolve from the real registry here, so this also proves the published
  // dependency spec resolves — a file: or private leftover would fail.
  run("npm", [
    "install",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    packagePath,
    `@mikro-orm/core@${MIKRO_ORM_VERSION}`,
    `@mikro-orm/sql@${MIKRO_ORM_VERSION}`,
  ], consumerDir);

  writeFileSync(join(consumerDir, "hikoutei.config.json"), `${JSON.stringify({
    entities: [
      {
        name: "smoke_tasks",
        tableName: "smoke_tasks",
        properties: {
          id: { type: "string", primary: true },
          title: { type: "string" },
          done: { type: "boolean" },
          dueAt: { type: "date" },
        },
      },
    ],
  }, null, 2)}\n`);

  const child = spawn(
    process.execPath,
    [join(consumerDir, "node_modules", "hikoutei-mcp", "dist", "index.js")],
    { cwd: consumerDir, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.on("error", (error) => { console.error("spawn failed:", error); process.exit(1); });
  child.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  const rl = createReadlineInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    try {
      const message = JSON.parse(line);
      if (typeof message.id === "number" && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    } catch {
      console.error("non-JSON stdout line:", line);
    }
  });

  const request = (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30000);
    });
  };

  try {
    const init = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ci-consumer-smoke", version: "0.0.0" },
    });
    if (init.result?.serverInfo?.name !== "hikoutei-mcp") {
      throw new Error(`initialize handshake failed: ${JSON.stringify(init)}`);
    }
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const tools = await request("tools/list", {});
    const toolNames = tools.result?.tools?.map((tool) => tool.name) ?? [];
    if (toolNames.length !== EXPECTED_TOOL_COUNT) {
      throw new Error(`expected ${EXPECTED_TOOL_COUNT} tools, got ${toolNames.length}`);
    }

    const created = await request("tools/call", {
      name: "create_record",
      arguments: {
        entity: "smoke_tasks",
        data: {
          id: "ci-1",
          title: "consumer smoke",
          done: false,
          dueAt: "2026-08-16T00:00:00.000Z",
        },
      },
    });
    if (created.result?.structuredContent?.record?.id !== "ci-1") {
      throw new Error(`create_record failed: ${JSON.stringify(created)}`);
    }

    const got = await request("tools/call", {
      name: "get_record",
      arguments: { entity: "smoke_tasks", id: "ci-1" },
    });
    if (got.result?.structuredContent?.found !== true) {
      throw new Error(`get_record failed: ${JSON.stringify(got)}`);
    }

    const status = await request("tools/call", { name: "get_sync_status", arguments: {} });
    if (status.result?.structuredContent?.mode !== "local") {
      throw new Error(`get_sync_status failed: ${JSON.stringify(status)}`);
    }

    console.log("consumer smoke passed: install, handshake, create/get, local status");
    child.kill("SIGTERM");
    process.exit(0);
  } catch (error) {
    console.error("consumer smoke failed:", error);
    child.kill("SIGKILL");
    process.exit(1);
  }
}

await main();
