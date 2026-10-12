/**
 * Helper and CLI tests for the find-workspace-dir CI script.
 *
 * Covers workspace lookup by package name, manifest discovery by dependency,
 * and CLI output and exit codes for ambiguous or invalid input. Spawns the
 * script against temp fixture trees without touching the real workspace.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findManifestsWithDep,
  findWorkspaceDirByPackageName,
} from "../scripts/ci/find-workspace-dir.mjs";

const scriptPath = fileURLToPath(
  new URL("../scripts/ci/find-workspace-dir.mjs", import.meta.url),
);

function run(...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], { encoding: "utf8" });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "find-workspace-dir-"));
  const manifest = (dir: string, pkg: unknown) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), JSON.stringify(pkg));
  };
  manifest("packages/alpha", { name: "@scope/alpha" });
  manifest("packages/protocol/beta", {
    name: "@hikoutei/ikisaki",
    dependencies: { zod: "^4.0.0" },
  });
  manifest("packages/gamma", {
    name: "@scope/gamma",
    dependencies: { "@hikoutei/ikisaki": "0.1.14" },
  });
  manifest("packages/delta", {
    name: "@scope/delta",
    devDependencies: { "@hikoutei/ikisaki": "0.1.14" },
  });
  // Never descend here: vendored copies must not shadow the workspace.
  manifest("packages/gamma/node_modules/shadow", { name: "@hikoutei/ikisaki" });
  return root;
}

// Covers findWorkspaceDirByPackageName.
describe("findWorkspaceDirByPackageName", () => {
  // Verifies finds a nested workspace by package name.
  it("finds a nested workspace by package name", () => {
    const root = fixture();
    try {
      expect(findWorkspaceDirByPackageName(root, "@hikoutei/ikisaki")).toStrictEqual({
        status: "valid",
        dir: "packages/protocol/beta",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Verifies rejects a missing name instead of guessing.
  it("rejects a missing name instead of guessing", () => {
    const root = fixture();
    try {
      expect(findWorkspaceDirByPackageName(root, "@scope/missing").status).toBe("invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Covers findManifestsWithDep.
describe("findManifestsWithDep", () => {
  // Verifies lists manifests carrying the dep in dependencies or devDependencies.
  it("lists manifests carrying the dep in dependencies or devDependencies", () => {
    const root = fixture();
    try {
      expect(findManifestsWithDep(root, "@hikoutei/ikisaki")).toStrictEqual({
        status: "valid",
        manifests: ["packages/delta/package.json", "packages/gamma/package.json"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Verifies fails closed when nothing carries the dep.
  it("fails closed when nothing carries the dep", () => {
    const root = fixture();
    try {
      expect(findManifestsWithDep(root, "@scope/nothing").status).toBe("invalid");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Covers find-workspace-dir CLI.
describe("find-workspace-dir CLI", () => {
  // Verifies prints the single package dir and lists dep manifests.
  it("prints the single package dir and lists dep manifests", () => {
    const root = fixture();
    try {
      const byName = run("--package=@hikoutei/ikisaki", `--root=${root}`);
      expect(byName.status).toBe(0);
      expect(byName.stdout.trim()).toBe("packages/protocol/beta");
      const byDep = run("--with-dep=@hikoutei/ikisaki", `--root=${root}`);
      expect(byDep.status).toBe(0);
      expect(byDep.stdout.trim().split("\n")).toStrictEqual([
        "packages/delta/package.json",
        "packages/gamma/package.json",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Verifies exits non-zero on ambiguous names and usage errors.
  it("exits non-zero on ambiguous names and usage errors", () => {
    const root = fixture();
    try {
      expect(run("--package=@scope/alpha", "--with-dep=x", `--root=${root}`).status).toBe(2);
      expect(run(`--root=${root}`).status).toBe(2);
      expect(run("--package=@scope/missing", `--root=${root}`).status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
