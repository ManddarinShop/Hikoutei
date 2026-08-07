#!/usr/bin/env node
/**
 * Fastify + Hono example verification scenario (CI).
 *
 * Runs the same three HTTP checks against both servers sequentially: first
 * `npm run start:fastify`, then `npm run start:hono`. Both bind port 3000 but
 * never run at the same time. On failure the captured server log tail is
 * printed to stderr and the process exits non-zero.
 *
 * Usage:
 *   node scripts/ci/examples/fastify-hono.mjs --dir examples/fastify-hono [--port 3000] [--output result.json]
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { waitForServer } from "./wait-for-server.mjs";

const EXAMPLE = "fastify-hono";
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

const log = [];

/** Spawn a server in its own process group so npm and its child die together. */
function spawnServer(command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", (chunk) => log.push(chunk.toString()));
  child.stderr?.on("data", (chunk) => log.push(chunk.toString()));
  return child;
}

function printLogTail() {
  const tail = log.join("").trim().split("\n").slice(-LOG_TAIL_LINES).join("\n");
  console.error(`--- ${EXAMPLE} server log tail ---\n${tail || "(no output captured)"}\n---`);
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

/** Spawn one server, run the shared CRUD checks, terminate it, await exit. */
async function runServerScenario(args, base, script, label) {
  // Fresh SQLite authority per server so each phase starts like a fresh
  // checkout (both servers share the same dbName and would otherwise clash
  // on the primary key).
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(path.join(args.dir, `hikoutei.sqlite${suffix}`), { force: true });
  }
  const child = spawnServer("npm", ["run", script], args.dir);
  try {
    // Any HTTP response (404 here) proves the server is up.
    await waitForServer(`${base}/users/__probe__`, { timeoutMs: 30_000 });

    await step(`${label}: create user`, async () => {
      const body = await assertJson(
        await requestJson("POST", `${base}/users`, { id: "u1", name: "Ada" }),
        201,
        `POST /users (${label})`,
      );
      assert(JSON.stringify(body) === JSON.stringify({ id: "u1" }), `POST /users (${label}): expected body {id:\"u1\"}`);
    });

    await step(`${label}: read user`, async () => {
      const body = await assertJson(await requestJson("GET", `${base}/users/u1`), 200, `GET /users/u1 (${label})`);
      assert(body?.id === "u1" && body?.name === "Ada", `GET /users/u1 (${label}): expected {id:\"u1\",name:\"Ada\"}`);
    });

    await step(`${label}: missing user`, async () => {
      const body = await assertJson(
        await requestJson("GET", `${base}/users/missing`),
        404,
        `GET /users/missing (${label})`,
      );
      assert(
        JSON.stringify(body) === JSON.stringify({ error: "not found" }),
        `GET /users/missing (${label}): expected {error:\"not found\"}`,
      );
    });
  } finally {
    await terminateChild(child);
  }
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
  // checkouts are clean anyway; this makes local re-runs deterministic). The
  // per-phase cleanup inside runServerScenario also resets it between the
  // fastify and hono phases.
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(path.join(args.dir, `hikoutei.sqlite${suffix}`), { force: true });
  }

  const base = `http://127.0.0.1:${args.port}`;
  let result = null;

  try {
    await runServerScenario(args, base, "start:fastify", "fastify");
    await runServerScenario(args, base, "start:hono", "hono");
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
    if (args.output !== null) {
      writeFileSync(args.output, JSON.stringify(result, null, 2) + "\n");
    }
  }

  process.exit(result.status === "passed" ? 0 : 1);
}

await main();
