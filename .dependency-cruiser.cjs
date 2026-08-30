/**
 * dependency-cruiser layer rules — P8-C blocking gate.
 *
 * This config encodes the INTENDED architecture as `forbidden` rules with
 * severity "error". Since P8-C the `audit:deps` script is CI-BLOCKING:
 * depcruiser exits nonzero on any violation and nothing swallows it.
 * Do NOT weaken these rules to force-pass; fix the graph instead.
 *
 * P8-C remediation ledger:
 * - `composition-concrete-adapters` (info) is REPLACED by the real rule
 *   `application-not-into-composition`: composition wiring lives in
 *   `src/composition/` (composition owns all concrete-adapter wiring) and
 *   application code must never name it or the concrete adapters directly.
 * - `adapter-not-into-application` now carries one explicitly enumerated
 *   pathNot list (the P8-C boundary decision): the MikroORM persistence
 *   adapter implements the typed-sheets sync-ORM engine's
 *   observation/persistence bridge, so seven exact engine-glue modules —
 *   flushCoordinator, support contracts/helpers, projectionEffects,
 *   observationMapping, autoSystemConflictResolution, syncTiming — stay
 *   reachable from the mikro-orm bridge (exactly 7 modules / 12 edges,
 *   verified against the residual audit report, enumerated as exact file
 *   paths with a near-name companion rule). Everything else
 *   adapter→application stays an error. Proper break-up (engine extraction or callback inversion
 *   through composition) is P8-D scope.
 *
 * Baseline ledger: docs/maintenance/0.9-cleanup-baseline.md (§v P8-A 실행 기록, §vi P8-B, P8-C)
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
        "Adapter code must not reach into application-layer modules (contracts live in @hikoutei/contracts). The pathNot list is the P8-C boundary decision, enumerated as an EXACT module list (verified against the residual 12-edge audit report): the mikro-orm observation/persistence bridge implements the sync-ORM engine's flush coordinator, writer contracts, projection-effect builders, observation mapping, and conflict planners — seven exact files, never whole trees. A new or near-named application file inherits nothing (each allowance is anchored to one real module path). Contract-type flow continues through @hikoutei/contracts; the companion rule `adapter-into-application-allowlist-trees` reports anything else percolating into the seven allowlisted trees.",
      severity: "error",
      from: { path: "^src/adapter/" },
      to: {
        path: "^src/application/",
        pathNot: [
          "^src/application/orm/mapping/observationMapping\\.ts$",
          "^src/application/orm/persistence/flush/flushCoordinator\\.ts$",
          "^src/application/orm/persistence/projection/projectionEffects\\.ts$",
          "^src/application/orm/persistence/support/contracts\\.ts$",
          "^src/application/orm/persistence/support/helpers\\.ts$",
          "^src/application/sync/inbound/autoSystemConflictResolution\\.ts$",
          "^src/application/sync/telemetry/syncTiming\\.ts$",
        ],
      },
    },
    {
      name: "adapter-into-application-allowlist-trees",
      comment:
        "Near-name guard for the exact-allowlist rule above: inside the application trees that host the seven P8-C bridge modules, adapter→application is allowed for NOTHING but those seven exact files. A new similar file (flushCoordinatorV2, support/extraHelpers, …) is flagged here immediately instead of silently inheriting a prefix allowance.",
      severity: "error",
      from: { path: "^src/adapter/" },
      to: {
        path: "^src/application/(orm/mapping/|orm/persistence/(flush/|projection/|support/)|sync/inbound/|sync/telemetry/)",
        pathNot: [
          "^src/application/orm/mapping/observationMapping\\.ts$",
          "^src/application/orm/persistence/flush/flushCoordinator\\.ts$",
          "^src/application/orm/persistence/projection/projectionEffects\\.ts$",
          "^src/application/orm/persistence/support/contracts\\.ts$",
          "^src/application/orm/persistence/support/helpers\\.ts$",
          "^src/application/sync/inbound/autoSystemConflictResolution\\.ts$",
          "^src/application/sync/telemetry/syncTiming\\.ts$",
        ],
      },
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
      comment: "The public API layer stays adapter-free (composition root owns wiring).",
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
      name: "application-not-into-composition",
      comment:
        "P8-C: the composition root (src/composition, loaded from the public api layer) owns ALL concrete-adapter wiring; application code must not name composition modules or concrete adapters. Contract types flow through @hikoutei/contracts.",
      severity: "error",
      from: { path: "^src/application/" },
      to: { path: "^src/(composition|adapter)/", pathNot: "^src/adapter/(contracts|index)" },
    },
    {
      name: "no-cycles",
      comment:
        "INFO remnant (does not gate): measured circular families are #1 the cli plan/setup graph, #2 the application/sync service<->api composition chain (the public API layer is the composition carrier, a deliberate P8-C shape), and #3 the google-sheets-api provider internals. P8-D candidate.",
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