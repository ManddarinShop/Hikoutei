/**
 * dependency-cruiser layer-rules gate — P8-A (report-only baseline).
 *
 * This config encodes the INTENDED architecture as `forbidden` rules with
 * severity "error", but during P8-A the run script (`npm run audit:deps`) is
 * REPORT-ONLY: it always exits 0 (see the script comment in package.json).
 * Gate enforcement (fail on nonzero violations) is deliberately deferred to
 * P8-C, after the measured violations are remediated. Do NOT weaken these
 * rules to force-pass; fix the graph instead.
 *
 * Baseline ledger: docs/maintenance/0.9-cleanup-baseline.md (§ P8-A 실행 기록)
 * Full violation list: docs/maintenance/baseline/depcruise-2026-08-29.txt (local-only)
 *
 * @type {import('dependency-cruiser').IConfig}
 */
module.exports = {
  forbidden: [
    {
      name: "adapter-not-into-application",
      severity: "error",
      comment:
        "Adapters must not reach upward into the application layer. " +
        "Baseline (2026-08-29, depcruise): 80 module-pair edges (49 via application/sync/sheetsContract, 28 via application/orm, 3 other). " +
        "Remediation target: P8 (ports/interception).",
      from: { path: "^src/adapter" },
      to: { path: "^src/application" },
    },
    {
      name: "infrastructure-upward",
      severity: "error",
      comment:
        "Infrastructure is the bottom layer; it must never import adapter or application code. " +
        "Baseline (2026-08-29, depcruise): 16 edges, ALL toward adapter (persistence contracts.ts — type-only); 0 toward application (superserved the earlier campaign estimate).",
      from: { path: "^src/infrastructure" },
      to: { path: "^src/(adapter|application)" },
    },
    {
      name: "api-not-into-adapter",
      severity: "error",
      comment:
        "The public API surface must talk to application services, not concrete adapters. " +
        "Baseline (2026-08-29): 6 edges.",
      from: { path: "^src/api" },
      to: { path: "^src/adapter" },
    },
    {
      name: "domain-shared-leaf",
      severity: "error",
      comment:
        "domain and shared are leaves: they may depend only on each other (domain→shared allowed), " +
        "never on adapter/application/infrastructure. Expected baseline: 0 violations.",
      from: { path: "^src/(domain|shared)" },
      to: { path: "^src/(adapter|application|infrastructure)" },
    },
    {
      // --- INFO rules below are advisory observation, not gate material. ---
      name: "composition-imports-concrete-adapters-accepted-until-p8c",
      severity: "info",
      comment:
        "Advisory: composition/wiring files import concrete adapters. Known-and-accepted " +
        "until P8-C introduces the composition root. Files: syncAutoStart, serviceOptions, " +
        "remoteProvider, adoptionSeeding (adopt seeding).",
      from: {
        path:
          "^src/application/sync/service/(syncAutoStart|serviceOptions|remoteProvider)\\.ts$" +
          "|^src/application/sync/service/adopt/adoptionSeeding\\.ts$",
      },
      to: { path: "^src/adapter" },
    },
    {
      name: "domain-may-depend-only-on-shared-and-itself",
      severity: "info",
      comment:
        "Advisory observation of the 'domain depends only on shared (and itself)' property. " +
        "Non-src imports (node_modules etc.) are out of scope for this rule.",
      from: { path: "^src/domain" },
      to: { path: "^src/", pathNot: "^src/(domain|shared)" },
    },
    {
      name: "no-cycles",
      severity: "info",
      comment:
        "Advisory during P8-A: reports cycles among the forbidden-rule feedback paths. " +
        "Known cycles (adapter⇄application, adapter⇄infrastructure) are recorded in the " +
        "P8-A baseline; they become a hard error in a later phase.",
      from: {},
      to: { circular: true },
    },
  ],

  options: {
    /* Resolve TS path aliases with the repo's tsconfig so relative
     * imports with a ".js" suffix (compiled TS, NodeNext) resolve
     * exactly like tsc does. */
    tsConfig: { fileName: "tsconfig.json" },
    /* Count type-only imports ("import type ...") as edges — the campaign
     * measurements they must reconcile against include type-only arrows. */
    tsPreCompilationDeps: true,
    /* Keep the dist build output out of the graph (node_modules is
     * never traversed by default). */
    doNotFollow: { path: "node_modules|(^|/)dist/" },
  },
};