/**
 * dependency-cruiser layer rules — P8-A baseline + P8-B contracts package.
 *
 * This config encodes the INTENDED architecture as `forbidden` rules with
 * severity "error", but until P8-C flips the blocking gate the
 * `audit:deps` script is REPORT-ONLY: it always exits 0 (see the script
 * comment in package.json). Gate enforcement (fail on nonzero violations)
 * is deliberately deferred to P8-C, after the measured violations are
 * remediated. Do NOT weaken these rules to force-pass; fix the graph instead.
 *
 * Baseline ledger: docs/maintenance/0.9-cleanup-baseline.md (§v P8-A 실행 기록)
 * Full violation list: docs/maintenance/baseline/depcruise-2026-08-29.txt (local-only)
 *
 * `tsPreCompilationDeps` is mandatory: without it `import type` edges
 * disappear from the graph and the infra rule silently reports 0.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "adapter-not-into-application",
      comment:
        "Adapter code must not reach into application-layer modules (contracts live in @hikoutei/contracts).",
      severity: "error",
      from: { path: "^src/adapter/" },
      to: { path: "^src/application/" },
    },
    {
      name: "infrastructure-upward",
      comment:
        "Infrastructure must not depend on adapter or application modules.",
      severity: "error",
      from: { path: "^src/infrastructure/" },
      to: { path: "^src/(adapter|application)/" },
    },
    {
      name: "api-not-into-adapter",
      comment: "The public API layer stays adapter-free.",
      severity: "error",
      from: { path: "^src/api/" },
      to: { path: "^src/adapter/" },
    },
    {
      name: "domain-shared-leaf",
      comment:
        "Domain and shared contracts are leaves: they may only use builtins, external packages, kernel (@hikoutei/ikisaki) and each other.",
      severity: "error",
      from: { path: "^src/(domain|shared)/" },
      to: { path: "^src/", pathNot: "^src/(domain|shared)/" },
    },
    {
      name: "contracts-leaf",
      comment:
        "@hikoutei/contracts is a pure leaf: only node builtins, @hikoutei/kohkai, zod and itself.",
      severity: "error",
      from: { path: "^packages/hikoutei-contracts/src/" },
      to: {
        pathNot:
          "^packages/hikoutei-contracts/src/|^(node:)?(crypto|zod|@hikoutei/kohkai|@hikoutei/contracts)($|/)",
      },
    },
    {
      name: "composition-concrete-adapters",
      comment:
        "Known-and-accepted (until P8-C): application composition roots naming concrete adapters.",
      severity: "info",
      from: { path: "^src/application/" },
      to: { path: "^src/adapter/", pathNot: "^src/adapter/(contracts|index)" },
    },
    {
      name: "no-cycles",
      comment:
        "Known-and-accepted (until P8-C): three circular families (cli, application/sync service⇄api, google-sheets-api provider internals).",
      severity: "info",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules|(^|/)dist($|/)|(^|/)node_modules($|/)" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      extensions: [".ts", ".js", ".d.ts"],
    },
  },
};