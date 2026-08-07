#!/usr/bin/env node
/**
 * Next.js example verification scenario (CI).
 *
 * Runs `npm run build` first (must exit 0), then `npm run start` (next start,
 * port 3000 by default) and drives the /api/users scenario over HTTP. On
 * failure the captured build/server log tail is printed to stderr and the
 * process exits non-zero.
 *
 * Usage:
 *   node scripts/ci/examples/nextjs.mjs --dir examples/nextjs [--port 3000] [--output result.json]
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { waitForServer } from "./wait-for-server.mjs";

const EXAMPLE = "nextjs";
const LOG_TAIL_LINES = 40;

function parseArgs(argv) {
  const args = { dir: null, port: 3000, output: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--output") args.output = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.dir === null) throw new Error("--dir is required");
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`invalid --port: ${args.port}`);
  }
  return args;
}

/** Spawn a command in its own process group so npm and its child die together. */
function spawnCommand(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", (chunk) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => log.push(chunk.toString()));
  return child;
}

const log = [];

function printLogTail() {
  const tail = log.join("").trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
  console.error(`--- ${EXAMPLE} build/server log tail ---\n${tail || "(no output captured)"}\n---`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * SIGTERM the whole process group, then SIGKILL if it does not exit in time.
 * Waits for the process GROUP (not just the direct child): npm may exit
 * before its server child, so the direct child's exit alone does not mean the
 * port was released.
 */
async function terminateChild(child) {
  if (child === null) return;
  if (child.exitCode !== null && !groupExists(child.pid)) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Process group already gone.
  }
  const exited = await waitForGroupExit(child.pid, 8_000);
  if (!exited) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Process group already gone.
    }
    await waitForGroupExit(child.pid, 3_000);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function requestJson(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { response, json };
}

async function assertJson(request, expectedStatus, label) {
  assert(
    request.response.status === expectedStatus,
    `${label}: expected HTTP ${expectedStatus}, got ${request.response.status}`,
  );
  return request.json;
}

const steps = [];
let currentStep = "";

async function step(name, fn) {
  currentStep = name;
  await fn();
  steps.push({ name });
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(2);
  }

  // Fresh SQLite authority per run so the scenario is idempotent (CI
  // checkouts are clean anyway; this makes local re-runs deterministic).
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(path.join(args.dir, `hikoutei.sqlite${suffix}`), { force: true });
  }

  const base = `http://127.0.0.1:${args.port}`;
  let server = null;
  let result = null;

  try {
    // Production build must succeed before the server can start.
    const build = spawnCommand("npm", ["run", "build"], args.dir);
    currentStep = "next build";
    const buildExit = await waitForExit(build, 600_000);
    assert(build.exitCode === 0, `next build exited with code ${buildExit ?? build.exitCode}`);
    steps.push({ name: "next build" });

    // next start binds port 3000 by default; honor --port when it differs.
    const startArgs =
      args.port === 3000 ? ["run", "start"] : ["run", "start", "--", "-p", String(args.port)];
    server = spawnCommand("npm", startArgs, args.dir);

    // GET /api/users without an id answers 400, which doubles as the probe.
    await waitForServer(`${base}/api/users`, { timeoutMs: 60_000 });

    await step("create user", async () => {
      const body = await assertJson(
        await requestJson("POST", `${base}/api/users`, { id: "u1", name: "Ada" }),
        201,
        "POST /api/users",
      );
      assert(JSON.stringify(body) === JSON.stringify({ id: "u1" }), "POST /api/users: expected body {id:\"u1\"}");
    });

    await step("read user", async () => {
      const body = await assertJson(await requestJson("GET", `${base}/api/users?id=u1`), 200, "GET /api/users?id=u1");
      assert(body?.id === "u1" && body?.name === "Ada", "GET /api/users?id=u1: expected {id:\"u1\",name:\"Ada\"}");
    });

    await step("missing user", async () => {
      const body = await assertJson(
        await requestJson("GET", `${base}/api/users?id=missing`),
        404,
        "GET /api/users?id=missing",
      );
      assert(
        JSON.stringify(body) === JSON.stringify({ error: "not found" }),
        "GET /api/users?id=missing: expected {error:\"not found\"}",
      );
    });

    await step("missing id param", async () => {
      const body = await assertJson(await requestJson("GET", `${base}/api/users`), 400, "GET /api/users");
      assert(
        JSON.stringify(body) === JSON.stringify({ error: "id required" }),
        "GET /api/users: expected {error:\"id required\"}",
      );
    });

    result = { status: "passed", example: EXAMPLE, steps };
  } catch (error) {
    printLogTail();
    result = {
      status: "failed",
      example: EXAMPLE,
      step: currentStep,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await terminateChild(server);
    if (args.output !== null) {
      writeFileSync(args.output, JSON.stringify(result, null, 2) + "\n");
    }
  }

  process.exit(result.status === "passed" ? 0 : 1);
}

await main();
