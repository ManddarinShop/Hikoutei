/**
 * dependency-cruiser layer rules — P8-D2 phase 2 final package-space DAG.
 *
 * This config encodes the INTENDED architecture as `forbidden` rules with
 * severity "error". Since P8-C the `audit:deps` script is CI-BLOCKING:
 * depcruiser exits nonzero on any violation and nothing swallows it.
 * Do NOT weaken these rules to force-pass; fix the graph instead.
 *
 * Final DAG (P8-D2 phase 2 + cycle break — the transitional
 * "@hikoutei-app-src" bridge is removed, `src/application|composition|cli`
 * no longer exist, and the former storage<->sync-engine workspace cycle is
 * severed by moving the mapped persistence glue DOWN into storage):
 *
 *   ikisaki  contracts (pure leaves; contracts also owns the api
 *     ^       ^         descriptor/error pair after the cycle break)
 *     |       |__________________  storage (state/SQL + the mapped
 *     |        \\                 flush/observation/projection/conflict
 *     |                           persistence glue — imports contracts,
 *     |                           ikisaki, and itself; NEVER the engine)
 *     |                                  ^   ^
 *     |                                  |   |
 *     +-----------------------  sync-engine (orm + sync services + internal
 *                                 api core + shared observability; imports
 *                                 contracts, ikisaki, and storage — engine
 *                                 -> storage is the declared allowed
 *                                 direction; NEVER sheets, composition,
 *                                 cli, or root src)
 *                              ^          ^
 *                              |           \_____  composition (may name every
 *                              |                       leaf: it owns the
 *                              |                       concrete-adapter wiring)
 *                              \____  cli (public entry via the root `hikoutei`
 *                                        barrel + engine registry internals)
 *   root src (api entry shims + internal/syncStatus + types) -> engine,
 *   composition (the public API layer is the composition carrier).
 *
 * Resolution note: package specifiers resolve through tsconfig.depcruise.json
 * (source `paths` mirroring tsconfig.test.json), so every cross-package edge
 * lands on the SAME (src) tree the scan walks and the rules below police it
 * — NOT on a could-not-resolve pseudo-edge that silently bypasses the gate.
 * Leaf-path regexes still accept `(src|dist)` layouts for defense in depth.
 *
 * Baseline ledger: docs/maintenance/0.9-cleanup-baseline.md (§v P8-A 실행 기록, §vi P8-B, P8-C, P8-D ADR)
 * Full violation list: docs/maintenance/baseline/depcruise-2026-08-29.txt (local-only)
 *
 * `tsPreCompilationDeps` is mandatory: without it `import type` edges
 * disappear from the graph and the infra rule silently reports 0.
 */

/** Leaf-tree alternation shared by the package-space rules. */
const ENGINE = "packages/sync-engine/(?:src|dist)";
const STORAGE = "packages/storage/(?:src|dist)";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "engine-not-into-upper-trees",
      comment:
        "The sync engine is composition-free and provider-free: it must never import @hikoutei/sheets, @hikoutei/composition, @hikoutei/cli, or root src (the public API layer/composition imports the engine, never the reverse). Contract types flow through @hikoutei/contracts; concrete-adapter wiring arrives via the registered composition ports (sync/service/compositionPorts.ts).",
      severity: "error",
      from: { path: "^packages/sync-engine/src/" },
      to: {
        path:
          "^packages/(sheets|composition|cli)/(?:src|dist)/|^src/",
      },
    },
    {
      name: "storage-not-into-engine",
      comment:
        "P8-D2 cycle break: the former storage->engine P8-C exact-bridge allowlist is GONE. The mapped flush/observation/projection/conflict glue the persistence adapter consumes was moved DOWN into this package (src/orm, src/sync), and the api descriptor/error pair moved DOWN into @hikoutei/contracts. Storage is below the engine: any @hikoutei/sync-engine import from storage re-creates the workspace cycle and fails `pnpm install`'s no-cycle invariant.",
      severity: "error",
      from: { path: `^${STORAGE}/` },
      to: { path: `^${ENGINE}/|^@hikoutei/sync-engine` },
    },
    {
      name: "sheets-into-engine-observability-only",
      comment:
        "The Google Sheets provider may reuse ONLY the engine's shared/observability log modules (internalLog/logEvents). Any other sheets->engine edge is an error: the provider belongs below the engine, and the engine must never import @hikoutei/sheets.",
      severity: "error",
      from: { path: "^packages/sheets/src/" },
      to: {
        path: `^${ENGINE}/`,
        pathNot: [
          `^${ENGINE}/shared/observability/internalLog\\.(ts|js)$`,
          `^${ENGINE}/shared/observability/logEvents\\.(ts|js)$`,
        ],
      },
    },
    {
      name: "storage-layer-not-into-upper-trees",
      comment:
        "packages/storage/src/storage is the SQLite storage technology layer: it may depend on contracts/ikisaki and itself only — never the engine, composition, cli, the src/orm + src/sync persistence glue, the adapter bridge, or root src.",
      severity: "error",
      from: { path: "^packages/storage/src/storage/" },
      to: {
        path:
          `^packages/(sync-engine|composition|cli)/(?:src|dist)/|^src/|^packages/storage/src/(persistence|orm|sync)/`,
      },
    },
    {
      name: "api-not-into-adapter",
      comment:
        "The public API layer stays adapter-free (composition root owns wiring): src/api may consume @hikoutei/sync-engine and @hikoutei/composition but must never import @hikoutei/storage or @hikoutei/sheets.",
      severity: "error",
      from: { path: "^src/api/" },
      to: { path: "^src/adapter/|^packages/(storage|sheets)/(?:src|dist)/" },
    },
    {
      name: "cli-not-into-adapter-leaves",
      comment:
        "The setup/adoption cli talks to the public root entrypoint (`hikoutei` barrel — the api-bridge) and the engine's registry internals only; concrete adapter leaves (@hikoutei/storage, @hikoutei/sheets) are the composition root's business and are never named from cli code.",
      severity: "error",
      from: { path: "^packages/cli/src/" },
      to: { path: "^packages/(storage|sheets)/(?:src|dist)/" },
    },
    {
      name: "domain-shared-leaf",
      comment:
        "Domain and shared contracts are leaves: they may only use builtins, external packages, kernel (@hikoutei/kohkai) and each other.",
      severity: "error",
      from: { path: "^src/(domain|shared)/" },
      to: { path: "^src/", pathNot: "^src/(domain|shared)/" },
    },
    {
      name: "contracts-leaf",
      comment:
        "@hikoutei/contracts is a pure leaf: only node builtins, @hikoutei/kohkai, zod and itself. Workspace/undeclared specifiers that fail to resolve stay flagged (could-not-resolved edges carry the bare specifier, not a node_modules path).",
      severity: "error",
      from: { path: "^packages/contracts/src/" },
      to: {
        pathNot:
          "^packages/contracts/src/|^(node:)?(crypto|zod|@hikoutei/kohkai|@hikoutei/contracts)($|/)|(^|/)node_modules/",
      },
    },
    {
      name: "no-cycles",
      comment:
        "INFO remnant (does not gate): the storage<->sync-engine workspace cycle was severed by the P8-D2 phase 2 cycle break (the mapped persistence glue moved down into storage; the api descriptor/error pair moved down into contracts). The remaining circular family is the google-sheets-api provider internals; the former application<->api knot was severed by P8-D2 phase 2 (the runtime core moved into the engine package).",
      severity: "info",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules|(^|/)dist($|/)|(^|/)node_modules($|/)" },
    // Resolution-only audit config with the private workspace source `paths`
    // (root tsconfig.json has none, which previously made every
    // @hikoutei/* edge could-not-resolve and silently bypassed every
    // package-boundary rule above). See tsconfig.depcruise.json.
    tsConfig: { fileName: "./tsconfig.depcruise.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      extensions: [".ts", ".js", ".d.ts"],
    },
  },
};
