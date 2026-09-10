/**
 * Step-1 protocol import-boundary gate for the `@hikoutei/ikisaki` kernel.
 *
 * The kernel is provider-neutral: no file under `packages/protocol/ikisaki/src/` may
 * import entity/Sheets state, storage, sync-engine/provider code, or the
 * Google SDKs. Shared primitives (`contracts/state`, `contracts/encoding`,
 * `contracts/identity`) stay usable as `import type` only; `zod` stays a
 * runtime dependency for the pure validation parsers. The test reads the
 * kernel sources and fails on violation.
 *
 * Batch-E sheets gate (same file, second suite): the only wrong-direction
 * package edge (`sheets` -> `sync-engine`, previously just the
 * shared/observability log modules now owned by `@hikoutei/contracts`) is
 * removed, so no file under `packages/library/cloud/sheets/src/` may name the
 * `@hikoutei/sync-engine` specifier at all.
 *
 * Batch-B storage-seam gate (same file, third suite): `packages/library/core/storage/src`
 * is the shared-transaction home (entity flush, canonical/observation/
 * resolution writers, and the outbox/fencing SQL they share with the protocol
 * worker), so its `@hikoutei/ikisaki` touches must stay on the narrow port
 * surface below while every other kernel name (worker, dispatch, pacing
 * policy, bands, batches, evidence, transport, effect lifecycle) is denied.
 * `@hikoutei/sheets` is denied inside storage except the single
 * protocol-side audit-planning edge pinned below.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const kernelSrc = resolve(here, "..", "packages", "protocol", "ikisaki", "src");

/** Runtime imports from these specifiers are always a boundary violation. */
const DENIED_RUNTIME_PREFIXES = [
  "@hikoutei/storage",
  "@hikoutei/sheets",
  "@hikoutei/sync-engine",
  "@hikoutei/composition",
  "@hikoutei/cli",
  "googleapis",
  "@googleapis/",
  "google-auth-library",
];

/** `contracts` leaves that are never shared (entity/Sheets/provider state). */
const DENIED_CONTRACTS_PREFIXES = [
  "@hikoutei/contracts/sheets",
  "@hikoutei/contracts/domain",
  "@hikoutei/contracts/api",
  "@hikoutei/contracts/storage",
];

/**
 * Shared primitives the audit classifies as kernel-safe
 * (`encoding/*, state/*, identity/*`): `import type` only, never runtime.
 */
const SHARED_TYPE_ONLY_PREFIXES = [
  "@hikoutei/contracts/encoding",
  "@hikoutei/contracts/state",
  "@hikoutei/contracts/identity",
];

/** Runtime externals the kernel legitimately depends on. */
const ALLOWED_RUNTIME = new Set(["zod"]);

interface KernelImport {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/** Collects every `.ts` file under a directory, recursively. */
function collectSources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSources(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}

/** Strips line/block comments so commented imports never count. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

/** Extracts (specifier, type-only) pairs from static and dynamic imports. */
function extractImports(source: string): KernelImport[] {
  const text = stripComments(source);
  const found: KernelImport[] = [];
  const staticPattern =
    /(?:import|export)\s+(type\s+)?(?:[^"';)]*?\sfrom\s*)?["']([^"']+)["']/g;
  for (let match = staticPattern.exec(text); match !== null; match = staticPattern.exec(text)) {
    const specifier = match[2] as string;
    // A bare `import "./x.js"` side-effect import has no `from`; only the
    // `import type ... from` / `export type ... from` forms are type-only.
    found.push({ specifier, typeOnly: match[1] !== undefined });
  }
  const dynamicPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let match = dynamicPattern.exec(text); match !== null; match = dynamicPattern.exec(text)) {
    found.push({ specifier: match[1] as string, typeOnly: false });
  }
  return found;
}

/** Returns true for kernel-internal or platform specifiers (always legal). */
function isInternalSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("node:") ||
    specifier === "@hikoutei/ikisaki" ||
    specifier.startsWith("@hikoutei/ikisaki/")
  );
}

/** Returns a violation description, or undefined when the import is legal. */
function checkImport(imp: KernelImport): string | undefined {
  const { specifier, typeOnly } = imp;
  if (isInternalSpecifier(specifier) || ALLOWED_RUNTIME.has(specifier)) {
    return undefined;
  }
  if (typeOnly && SHARED_TYPE_ONLY_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    return undefined;
  }
  if (DENIED_CONTRACTS_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    return `forbidden contracts import ${JSON.stringify(specifier)}`;
  }
  if (
    specifier === "@hikoutei/contracts" ||
    specifier.startsWith("@hikoutei/contracts/") ||
    DENIED_RUNTIME_PREFIXES.some((prefix) => specifier.startsWith(prefix))
  ) {
    return typeOnly
      ? `type-only import of non-shared leaf ${JSON.stringify(specifier)}`
      : `forbidden runtime import ${JSON.stringify(specifier)}`;
  }
  return undefined;
}

// Covers ikisaki protocol import boundary.
describe("ikisaki protocol import boundary", () => {
  // Verifies keeps provider/Sheets/entity imports out of packages/protocol/ikisaki/src.
  it("keeps provider/Sheets/entity imports out of packages/protocol/ikisaki/src", () => {
    const violations: string[] = [];
    for (const file of collectSources(kernelSrc)) {
      const source = readFileSync(file, "utf8");
      for (const imp of extractImports(source)) {
        const reason = checkImport(imp);
        if (reason !== undefined) {
          violations.push(`${relative(kernelSrc, file)}: ${reason}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // Verifies never interprets domain kinds inside packages/protocol/ikisaki/src (opaque dispatchClass only).
  it("never interprets domain kinds inside packages/protocol/ikisaki/src (opaque dispatchClass only)", () => {
    // Step-2 vocabulary: the worker routes SOLELY on the entity-stamped
    // opaque `dispatchClass` label. Domain-kind tables, provider effect
    // shapes, Sheets grid concepts, and host classifier predicates must not
    // appear as identifiers in kernel code (word-boundary match, so the
    // protocol-owned OUTBOX_* copies never trip this gate). Comments are
    // stripped before scanning so prose can still name the concepts.
    const denied = [
      "EFFECT_KINDS",
      "EFFECT_TARGET_KINDS",
      "EFFECT_STATUSES",
      "EffectKind",
      "EffectStatus",
      "EffectTargetKind",
      "SYNC_PROJECTIONS",
      "SYNC_EFFECT_RESULT_STATUSES",
      "SYNC_POSTCONDITION_STATUSES",
      "SYNC_POSTCONDITION_DISPOSITIONS",
      "SYNC_FAST_APPEND_STATUSES",
      "SYNC_DELETE_EFFECT_KINDS",
      "isFastAppendCandidate",
      "isSheetsFastAppendCandidate",
      "isFastAppendEffect",
      "isCandidateProtectingUserInputEffect",
      "toProviderEffect",
      "parseSyncProjectionEffectPayload",
      "SyncProjectionEffect",
      "SyncEffectResult",
      "SyncEffectPostcondition",
      "PreflightContext",
      "PreflightReceipt",
      "BuiltApplyBatch",
      "ParsedGrid",
      "ParsedSheet",
      "PlannedRange",
      "ReadEvidence",
    ].map((name) => ({
      name,
      pattern: new RegExp(`\\b${name}\\b`),
    }));
    const violations: string[] = [];
    for (const file of collectSources(kernelSrc)) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const { name, pattern } of denied) {
        if (pattern.test(text)) {
          violations.push(`${relative(kernelSrc, file)}: forbidden domain-kind identifier ${name}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // Verifies never branches on effect_kind or raw domain literals inside the dispatch hot path.
  it("never branches on effect_kind or raw domain literals inside the dispatch hot path", () => {
    // The deny-list above catches entity-vocabulary reintroduction
    // tree-wide, but a worker branch on the bare `effect_kind` column or on
    // a raw domain literal (e.g. "system_projection") would slip through:
    // those spellings are legitimate in the outbox SQL layer (column names,
    // CHECK values) but must never select a dispatch path. Scope this gate
    // to the dispatch hot path only.
    const hotPath = [
      join(kernelSrc, "worker", "dispatch"),
      join(kernelSrc, "worker", "worker.ts"),
    ];
    const violations: string[] = [];
    const scopedDenied = ["effect_kind", '"system_projection"', '"candidate_reconcile"'];
    const scopedFiles = hotPath.flatMap((entry) =>
      statSync(entry).isDirectory() ? collectSources(entry) : [entry],
    );
    for (const file of scopedFiles) {
      if (!file.endsWith(".ts")) continue;
      const text = stripComments(readFileSync(file, "utf8"));
      for (const name of scopedDenied) {
        if (text.includes(name)) {
          violations.push(`${relative(kernelSrc, file)}: forbidden dispatch-hot-path token ${name}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // Verifies branches dispatch routing on the opaque dispatchClass hint.
  it("branches dispatch routing on the opaque dispatchClass hint", () => {
    const routing = readFileSync(join(kernelSrc, "worker", "dispatch", "routing.ts"), "utf8");
    expect(routing).toContain("dispatch_class");
    expect(routing).toContain('"fast-append"');
    const worker = readFileSync(join(kernelSrc, "worker", "worker.ts"), "utf8");
    expect(worker).toContain("dispatchClassValidationError");
    const contracts = readFileSync(join(kernelSrc, "contract", "contracts.ts"), "utf8");
    expect(contracts).toContain("dispatchClass");
  });
});

// Covers sheets provider import boundary.
describe("sheets provider import boundary", () => {
  // Verifies keeps @hikoutei/sync-engine imports out of packages/library/cloud/sheets/src.
  it("keeps @hikoutei/sync-engine imports out of packages/library/cloud/sheets/src", () => {
    // Batch E removed the only wrong-direction package edge (sheets ->
    // sync-engine, previously just the shared/observability log modules now
    // owned by @hikoutei/contracts). The package graph must stay a clean
    // DAG with no provider->engine edge, so the specifier is deny-listed
    // outright (runtime or type-only). Comments are stripped before scanning
    // so prose can still name the package.
    const sheetsSrc = resolve(here, "..", "packages", "library", "cloud", "sheets", "src");
    const violations: string[] = [];
    for (const file of collectSources(sheetsSrc)) {
      const source = readFileSync(file, "utf8");
      for (const imp of extractImports(source)) {
        if (
          imp.specifier === "@hikoutei/sync-engine" ||
          imp.specifier.startsWith("@hikoutei/sync-engine/")
        ) {
          violations.push(
            `${relative(sheetsSrc, file)}: forbidden sync-engine import ${JSON.stringify(imp.specifier)}`,
          );
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * Batch-B storage-seam gate: the narrow protocol port surface storage may use.
 *
 * `packages/library/core/storage/src` shares one SQLite transaction between the entity
 * flush and the protocol outbox, so fencing, the outbox SQL seam, the DDL
 * the kernel owns, the shared error identity, and passive diagnostic timing
 * vocabulary are the port; every other kernel export (worker, dispatch,
 * pacing policy, bands, batches, evidence, transport, confirmations, effect
 * lifecycle) is an internal and must never be named by storage. `export *`
 * and default/namespace/side-effect/dynamic imports are opaque and denied
 * outright because no port name can be verified on them.
 */
const STORAGE_SEAM_IKISAKI_PORT = new Set([
  // Fencing ports: writer-lease claims/gates, fence-guarded SQL evidence,
  // and the fence-lost signal the append seam reports through.
  "FencingContext",
  "claimWriterLeaseWithSql",
  "claimWriterLeaseWithAdapter",
  "awaitTakeoverableWriterLeaseWithAdapter",
  "isFencingValidWithSql",
  "fenceParameters",
  "FENCE_EXISTS_SQL",
  "writerLeaseHeartbeatStaleBoundMs",
  "WRITER_LEASE_CLAIM_RESULT_KINDS",
  "AsyncFenceLostError",
  // Outbox SQL seam: the in-transaction append/replan primitives, their
  // input type, the opaque dispatch label type, and the pure recoverability
  // predicate over the shared error-code vocabulary.
  "appendPendingEffectsWithSql",
  "supersedeAndReplanWithSql",
  "NewEffect",
  "isRecoverableEffectErrorCode",
  // DDL the kernel owns and the host schema composes.
  "EFFECT_OUTBOX_DDL",
  "REQUIRED_V3_COLUMNS",
  "REQUIRED_V5_COLUMNS",
  "REQUIRED_V9_COLUMNS",
  "VISIBLE_STATE_TABLES_DDL",
  "WRITER_LEASE_DDL",
  "syncSchemaV5IndexesDdl",
  // Shared error identity plus passive diagnostic timing vocabulary (shapes
  // and zeroed counts only; no pacing policy, emit, or dispatch helper).
  "StorageError",
  "TIMING_OPERATION_KINDS",
  "TIMING_SCOPES",
  "emptyOperationCounts",
  "ProviderTiming",
  "TimingEvent",
  "TimingOperationCounts",
  "TimingOperationKind",
]);

/** The moved Sync_Conflicts audit projection (Sheets-tab semantics, Batch B). */
const CONFLICT_PROJECTION_SHEETS_SPECIFIER =
  "@hikoutei/contracts/sheets/model/conflictProjection.js";

/** The one protocol-side storage file allowed to plan audit effects. */
const AUDIT_PLANNER_RELATIVE = join("sync", "inbound", "autoSystemConflictResolution.ts");

/** One import edge with the names the gate can verify against the port. */
interface StorageSeamImport {
  readonly specifier: string;
  readonly names: readonly string[];
  readonly opaque: boolean;
}

/** Extracts (specifier, verified names) pairs, flagging opaque edges. */
function extractStorageSeamImports(source: string): StorageSeamImport[] {
  const text = stripComments(source);
  const found: StorageSeamImport[] = [];
  const staticPattern = /(?:import|export)\s+([^;]*?)\sfrom\s*["']([^"']+)["']/g;
  for (let match = staticPattern.exec(text); match !== null; match = staticPattern.exec(text)) {
    const clause = match[1] as string;
    const specifier = match[2] as string;
    const names: string[] = [];
    const bracePattern = /\{([^}]*)\}/g;
    for (let brace = bracePattern.exec(clause); brace !== null; brace = bracePattern.exec(clause)) {
      for (const part of (brace[1] as string).split(",")) {
        const name = part.replace(/^\s*type\s+/, "").split(/\s+as\s+/)[0]?.trim() ?? "";
        if (name !== "") names.push(name);
      }
    }
    // Anything outside braces (default binding, namespace, star) hides the
    // kernel name behind a local alias, so the edge stays unverifiable.
    const outside = clause.replace(/\{[^}]*\}/g, "").trim();
    found.push({ specifier, names, opaque: outside !== "" && outside !== "type" });
  }
  const sideEffectPattern = /import\s*["']([^"']+)["']/g;
  for (let match = sideEffectPattern.exec(text); match !== null; match = sideEffectPattern.exec(text)) {
    found.push({ specifier: match[1] as string, names: [], opaque: true });
  }
  const dynamicPattern = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let match = dynamicPattern.exec(text); match !== null; match = dynamicPattern.exec(text)) {
    found.push({ specifier: match[1] as string, names: [], opaque: true });
  }
  return found;
}

// Covers storage protocol-seam import boundary.
describe("storage protocol-seam import boundary", () => {
  // Verifies keeps @hikoutei/ikisaki imports inside storage on the narrow port surface.
  it("keeps @hikoutei/ikisaki imports inside storage on the narrow port surface", () => {
    const storageSrc = resolve(here, "..", "packages", "library", "core", "storage", "src");
    const violations: string[] = [];
    for (const file of collectSources(storageSrc)) {
      const source = readFileSync(file, "utf8");
      for (const imp of extractStorageSeamImports(source)) {
        if (imp.specifier !== "@hikoutei/ikisaki") {
          if (imp.specifier.startsWith("@hikoutei/ikisaki/")) {
            violations.push(`${relative(storageSrc, file)}: deep protocol import ${JSON.stringify(imp.specifier)}`);
          }
          continue;
        }
        if (imp.opaque) {
          violations.push(`${relative(storageSrc, file)}: opaque protocol import of ${JSON.stringify(imp.specifier)}`);
          continue;
        }
        for (const name of imp.names) {
          if (!STORAGE_SEAM_IKISAKI_PORT.has(name)) {
            violations.push(`${relative(storageSrc, file)}: protocol internal ${JSON.stringify(name)} is past the port surface`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // Verifies keeps @hikoutei/sheets out of storage except the single audit-planning edge.
  it("keeps @hikoutei/sheets out of storage except the single audit-planning edge", () => {
    // The Sync_Conflicts audit projection is Sheets-tab semantics owned by
    // `@hikoutei/sheets`, but its rows are planned inside the shared flush
    // transaction by the protocol-side inbound planner, which must stay for
    // the atomic seam. That one edge is pinned here; the entity-ORM
    // subtrees (`orm/`, `persistence/`, `storage/`) and every other sync
    // file must never name the sheets package.
    const storageSrc = resolve(here, "..", "packages", "library", "core", "storage", "src");
    const violations: string[] = [];
    for (const file of collectSources(storageSrc)) {
      const source = readFileSync(file, "utf8");
      for (const imp of extractStorageSeamImports(source)) {
        if (imp.specifier !== "@hikoutei/sheets" && !imp.specifier.startsWith("@hikoutei/sheets/")) {
          continue;
        }
        const isPinnedEdge = relative(storageSrc, file) === AUDIT_PLANNER_RELATIVE &&
          imp.specifier === CONFLICT_PROJECTION_SHEETS_SPECIFIER;
        if (!isPinnedEdge) {
          violations.push(`${relative(storageSrc, file)}: forbidden sheets import ${JSON.stringify(imp.specifier)}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  // Verifies leaves no sheetsContract remnant behind in storage or its importers.
  it("leaves no sheetsContract remnant behind in storage or its importers", () => {
    // The Batch-B move empties the old storage-side sheets-contract home:
    // no storage source may reference it (relative or by package), and no
    // importer worktree-wide may name the retired package path.
    const storageSrc = resolve(here, "..", "packages", "library", "core", "storage", "src");
    const violations: string[] = [];
    for (const file of collectSources(storageSrc)) {
      const source = readFileSync(file, "utf8");
      for (const imp of extractStorageSeamImports(source)) {
        if (imp.specifier.includes("sheetsContract")) {
          violations.push(`${relative(storageSrc, file)}: retired sheets-contract import ${JSON.stringify(imp.specifier)}`);
        }
      }
    }
    for (const root of [
      resolve(here, "..", "packages", "library", "core", "sync-engine", "src"),
      resolve(here, "..", "packages", "library", "cloud", "sheets", "src"),
      resolve(here, "..", "packages", "library", "core", "composition", "src"),
      resolve(here, "..", "packages", "library", "cloud", "cli", "src"),
      resolve(here, "..", "src"),
      here,
    ]) {
      for (const file of collectSources(root)) {
        if (!file.endsWith(".ts")) continue;
        const source = readFileSync(file, "utf8");
        for (const imp of extractStorageSeamImports(source)) {
          if (imp.specifier === "@hikoutei/storage/sync/sheetsContract/conflictProjection.js") {
            violations.push(`${relative(resolve(here, ".."), file)}: retired package import ${JSON.stringify(imp.specifier)}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
