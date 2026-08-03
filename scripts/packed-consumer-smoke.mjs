#!/usr/bin/env node
/**
 * Deterministic packed-consumer verification for both public packages.
 *
 * The smoke builds and packs @hikoutei/canonical-codec and hikoutei, installs
 * both local tarballs into an isolated consumer together with the optional
 * MikroORM peer dependencies, and then exercises the public codec, root API,
 * and fake sync/gateway scenario. It never reaches the npm registry, Google,
 * or Apps Script credentials.
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(new URL("../", import.meta.url).pathname);
const codecDir = path.join(repoRoot, "packages", "canonical-codec");
const ciDir = path.join(repoRoot, "scripts", "ci");

/** Runs a command synchronously and reports its output when it fails. */
function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "pipe", encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${cmd} ${args.join(" ")} exited with status ${result.status}`);
  }
  return result;
}

/** Packs a workspace/package and returns the generated tarball path. */
function pack(args, artifactDir) {
  const output = run(
    "npm",
    ["pack", ...args, "--silent", "--pack-destination", artifactDir],
    repoRoot,
  ).stdout.trim();
  const filename = output.split("\n").at(-1);
  if (filename === undefined || filename.length === 0) {
    throw new Error(`npm pack did not return a filename: ${output}`);
  }
  return path.join(artifactDir, filename);
}

/** Confirms that a tarball contains only the intended public package files. */
function verifyTarballContents(tarballPath, packageKind) {
  const entries = run("tar", ["-tzf", tarballPath], repoRoot).stdout
    .split("\n")
    .filter((entry) => entry.length > 0);
  const required = ["package/package.json"];
  if (packageKind === "codec") {
    required.push("package/dist/index.js", "package/dist/index.d.ts", "package/README.md", "package/LICENSE");
    if (entries.some((entry) => entry.startsWith("package/src/") || entry.startsWith("package/test/"))) {
      throw new Error("codec tarball contains source or tests");
    }
  } else {
    required.push("package/dist/index.js", "package/apps-script/gateway/Code.gs");
    if (entries.some((entry) => entry.startsWith("package/packages/"))) {
      throw new Error("hikoutei tarball contains workspace source");
    }
  }
  for (const entry of required) {
    if (!entries.includes(entry)) throw new Error(`${packageKind} tarball is missing ${entry}`);
  }
}

const codecConsumerScript = `
import assert from "node:assert/strict";
import {
  CANONICAL_CODEC_ERROR_CODES,
  CanonicalCodecError,
  canonicalJson,
  isCanonicalJsonValue,
  STABLE_ENCODING_ERROR_CODES,
  StableCodecError,
  stableEncode,
} from "@hikoutei/canonical-codec";

assert.equal(typeof stableEncode, "function");
assert.equal(typeof canonicalJson, "function");
assert.equal(typeof isCanonicalJsonValue, "function");
assert.equal(typeof CanonicalCodecError, "function");
assert.equal(typeof StableCodecError, "function");
assert.equal(CANONICAL_CODEC_ERROR_CODES.NON_FINITE_NUMBER, "non_finite_number");
assert.equal(STABLE_ENCODING_ERROR_CODES.CYCLIC_VALUE, "cyclic_value");
assert.ok(new StableCodecError("cyclic_value", "x") instanceof CanonicalCodecError);

const bytes = stableEncode("Hikoutei");
const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
assert.equal(hex, "73383a48696b6f75746569");
assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
assert.equal(isCanonicalJsonValue({ a: 1 }), true);
assert.equal(isCanonicalJsonValue(Number.NaN), false);
assert.throws(() => stableEncode(Number.NaN), { code: "non_finite_number" });

console.log("packed-consumer codec smoke OK");
`;

async function main() {
  process.stdout.write("smoke: building package and root artifacts\n");
  run("npm", ["run", "build"], repoRoot);

  const artifactDir = await mkdtemp(path.join(tmpdir(), "hikoutei-packed-artifacts-"));
  const consumerDir = await mkdtemp(path.join(tmpdir(), "hikoutei-packed-consumer-"));
  try {
    const codecTarball = pack(["--workspace", "@hikoutei/canonical-codec"], artifactDir);
    const hikouteiTarball = pack([], artifactDir);
    await readFile(codecTarball);
    await readFile(hikouteiTarball);
    verifyTarballContents(codecTarball, "codec");
    verifyTarballContents(hikouteiTarball, "hikoutei");

    await writeFile(
      path.join(consumerDir, "package.json"),
      `${JSON.stringify({ name: "hikoutei-packed-consumer", version: "0.0.0", type: "module" }, null, 2)}\n`,
    );
    run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        codecTarball,
        hikouteiTarball,
        "@mikro-orm/core@7.1.7",
        "@mikro-orm/sql@7.1.7",
      ],
      consumerDir,
    );

    await writeFile(path.join(consumerDir, "codec-consumer.mjs"), codecConsumerScript);
    run("node", ["codec-consumer.mjs"], consumerDir);

    await copyFile(path.join(ciDir, "run-root-api-scenario.mjs"), path.join(consumerDir, "run-root-api-scenario.mjs"));
    await copyFile(path.join(ciDir, "root-api-options.mjs"), path.join(consumerDir, "root-api-options.mjs"));
    run("node", ["run-root-api-scenario.mjs", `--output=${path.join(consumerDir, "root-api.json")}`], consumerDir);

    await copyFile(path.join(ciDir, "run-api-scenario.mjs"), path.join(consumerDir, "run-api-scenario.mjs"));
    run(
      "node",
      [
        "run-api-scenario.mjs",
        "--backend=fake",
        `--output=${path.join(consumerDir, "fake-sync.json")}`,
        `--manifest=${path.join(consumerDir, "fake-sync-manifest.json")}`,
      ],
      consumerDir,
    );

    process.stdout.write("packed-consumer smoke: PASS\n");
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
    await rm(consumerDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
