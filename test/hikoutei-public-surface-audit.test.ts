/**
 * Public-surface audit for the narrow Hikoutei scalar contract.
 *
 * These tests pin the application-facing boundary of the package: the exact
 * runtime values the root entrypoint exports, the compile-time guarantee that
 * internal engine/provider/SQL types are not re-exported, the rule that the
 * public query/manager type modules import nothing from the storage engine or
 * SDKs, and the explicit rejection of relation/join/populate options at entity
 * definition time.
 *
 * The runtime allowlist is intentionally exhaustive: a new public export must
 * update this list, which forces a conscious review of the public contract.
 */
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import * as hikouteiRoot from "../src/index.js";
import {
  HIKOUTEI_ERROR_CODES,
  HikouteiError,
  defineTypedSheetsEntity,
} from "../src/index.js";

describe("root public export allowlist", () => {
  it("exposes exactly the intended runtime values from the root entrypoint", () => {
    // Type-only re-exports (HikouteiEntity, HikouteiFilter, EntityManager, ...)
    // do not appear as runtime keys; only value exports do.
    expect(Object.keys(hikouteiRoot).sort()).toEqual([
      "HIKOUTEI_ERROR_CODES",
      "HIKOUTEI_SCALAR_TYPES",
      "HikouteiError",
      "createTypedSheets",
      "defineTypedSheetsEntity",
    ]);
  });

  it("does not re-export internal factory, provider, or descriptor helpers as values", () => {
    const namespace = hikouteiRoot as Record<string, unknown>;
    // Engine/provider/SQL symbols that must never be part of the public contract.
    expect(namespace.createEntityManager).toBeUndefined();
    expect(namespace.createInternalHikoutei).toBeUndefined();
    expect(namespace.createLocalTypedSheetsRuntime).toBeUndefined();
    expect(namespace.normalizeEntityQuery).toBeUndefined();
    expect(namespace.getEntityDescriptor).toBeUndefined();
    expect(namespace.resolveEntityDescriptor).toBeUndefined();
    expect(namespace.HikouteiEntity).toBeUndefined();
    expect(namespace.MikroOrmScalarPersistenceProvider).toBeUndefined();
    expect(namespace.SqlExecutor).toBeUndefined();
  });
});

// Compile-time leak guard: each `@ts-expect-error` below must remain used. If
// any internal type is ever re-exported from the root, the directive becomes
// unused and `typecheck:test` fails, surfacing the leak for review. True type
// exports use the bare `import(...).Type` form; internal VALUE exports use
// `typeof import(...).name` so an accidental value re-export resolves the
// query, turns the directive unused, and fails with TS2578 (a bare type
// reference to a value member would stay an error even when the value exists).
// @ts-expect-error the provider-neutral predicate contract is internal.
type _LeakPredicate = import("../src/index.js").ScalarEntityPredicate;
// @ts-expect-error the engine-neutral persistence provider is internal.
type _LeakProvider = import("../src/index.js").ScalarEntityPersistenceProvider;
// @ts-expect-error the low-level SQL executor is an internal storage type.
type _LeakSqlExecutor = import("../src/index.js").SqlExecutor;
// @ts-expect-error the internal validated query shape is not public.
type _LeakQuery = import("../src/index.js").ScalarEntityQuery;
// @ts-expect-error the public manager has no factory on its surface.
type _LeakEntityManagerFactory = typeof import("../src/index.js").createEntityManager;
// @ts-expect-error descriptor resolution helpers are internal.
type _LeakDescriptorHelper = typeof import("../src/index.js").getEntityDescriptor;
// @ts-expect-error the local-only runtime factory is internal.
type _LeakLocalRuntime = typeof import("../src/index.js").createLocalTypedSheetsRuntime;
// @ts-expect-error query normalization is an internal boundary.
type _LeakNormalize = typeof import("../src/index.js").normalizeEntityQuery;
// @ts-expect-error raw scalar row/value types are internal to the provider contract.
type _LeakRow = import("../src/index.js").ScalarEntityRow;
void (null as unknown as _LeakPredicate);
void (null as unknown as _LeakProvider);
void (null as unknown as _LeakSqlExecutor);
void (null as unknown as _LeakQuery);
void (null as unknown as _LeakEntityManagerFactory);
void (null as unknown as _LeakDescriptorHelper);
void (null as unknown as _LeakLocalRuntime);
void (null as unknown as _LeakNormalize);
void (null as unknown as _LeakRow);

const auditRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const auditRootEntry = resolve(auditRepoRoot, "src", "index.ts");

/**
 * Bare module specifiers that must never appear in the public declaration
 * graph reachable from the root entrypoint. A public type signature that
 * references the MikroORM engine, the Google Sheets SDK, or the Google auth
 * library would force every consumer to resolve those service-side modules.
 */
const FORBIDDEN_PUBLIC_PACKAGE =
  /^(@mikro-orm\/|@googleapis\/|googleapis($|\/)|google-auth-library($|\/))/;

/**
 * De-duplicates combined pre-emit and emit diagnostics by a stable key.
 *
 * `getPreEmitDiagnostics` already includes declaration diagnostics when
 * `declaration` is enabled, and `program.emit` returns the diagnostics raised
 * during the emit pass; the two sets can overlap. De-duplicating keeps the
 * failure output readable without dropping any distinct diagnostic.
 */
function dedupeDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
): readonly ts.Diagnostic[] {
  const seen = new Set<string>();
  const result: ts.Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.category}:${diagnostic.code}:${diagnostic.file?.fileName ?? ""}:${diagnostic.start ?? -1}:${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(diagnostic);
  }
  return result;
}

/**
 * Compiles the root entrypoint to TypeScript declarations in memory.
 *
 * Declaration emit strips comments and elides value-only imports, so the
 * emitted `.d.ts` files are the faithful public type surface a consumer's type
 * checker must resolve: they show exactly the module specifiers reachable from
 * the public API, and nothing an implementation-only `import` pulls in. Nothing
 * is written to disk, so the suite never depends on a stale `dist` artifact and
 * needs no separate build step beyond the normal test command.
 */
function emitPublicDeclarationGraph(rootFile: string): {
  readonly declarations: ReadonlyMap<string, string>;
  readonly rootDeclarationPath: string;
  readonly diagnostics: readonly ts.Diagnostic[];
} {
  const configPath = resolve(auditRepoRoot, "tsconfig.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error !== undefined) {
    throw new Error(
      `Could not read ${configPath}: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    auditRepoRoot,
    undefined,
    configPath,
  );
  const outDir = resolve(
    auditRepoRoot,
    "node_modules",
    ".cache",
    "hikoutei-public-decl-audit",
  );
  const options: ts.CompilerOptions = {
    ...parsed.options,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    outDir,
    noEmit: false,
  };
  const host = ts.createCompilerHost(options, true);
  const program = ts.createProgram({ rootNames: [rootFile], options, host });

  const declarations = new Map<string, string>();
  const writeFile: ts.WriteFileCallback = (fileName, data) => {
    if (fileName.endsWith(".d.ts")) {
      declarations.set(resolve(fileName), data);
    }
  };
  const emitResult = program.emit(undefined, writeFile, undefined, true);

  // Combine the pre-emit diagnostics (syntactic, semantic, and declaration)
  // with the diagnostics raised during declaration emit, then de-duplicate.
  // The graph walk below only inspects the emitted `.d.ts` files, so any error
  // or warning here means that graph may be silently incomplete or malformed.
  const combinedDiagnostics = dedupeDiagnostics([
    ...ts.getPreEmitDiagnostics(program),
    ...emitResult.diagnostics,
  ]);

  return {
    declarations,
    rootDeclarationPath: join(outDir, "index.d.ts"),
    diagnostics: combinedDiagnostics,
  };
}

/**
 * Diagnostics that would make the emitted declaration graph an unreliable
 * representation of the public type surface.
 *
 * The boundary is intentionally narrow and principled: only `Error` and
 * `Warning` severities gate the audit. A `Cannot find module` error, a
 * semantic error, or a declaration-emit failure means the emitted `.d.ts`
 * graph the walk inspects may be silently incomplete or malformed, so the audit
 * must fail rather than pass on that partial graph. `Suggestion` and `Message`
 * severities are advisory and must never gate the public-surface audit, so an
 * informational diagnostic can never make a correct graph fail. The clean
 * workspace currently emits none of either severity; this assertion exists so
 * a future regression cannot pass silently.
 */
function relevantDeclarationDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
): readonly ts.Diagnostic[] {
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.category === ts.DiagnosticCategory.Error
      || diagnostic.category === ts.DiagnosticCategory.Warning,
  );
}

/**
 * Formats diagnostics into a file-located, readable message list for failure
 * output, so a non-empty relevant diagnostic names the offending module and the
 * compiler message instead of dumping raw `ts.Diagnostic` objects.
 */
function formatDiagnostics(
  diagnostics: readonly ts.Diagnostic[],
  repoRoot: string,
): string {
  return diagnostics
    .map((diagnostic) => {
      const location =
        diagnostic.file === undefined
          ? "<no file>"
          : `${relative(repoRoot, diagnostic.file.fileName)}${
              diagnostic.start === undefined
                ? ""
                : `:${ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start).line + 1}`
            }`;
      return `${location} (ts${diagnostic.code}, ${ts.DiagnosticCategory[diagnostic.category]}): ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
    })
    .join("\n");
}

/**
 * Resolves a relative specifier from an emitted declaration to its `.d.ts` key,
 * or returns `null` for a bare package specifier (or an unresolved module).
 */
function resolveDeclarationSpecifier(
  declarations: ReadonlyMap<string, string>,
  fromDeclarationPath: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromDeclarationPath), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".d.ts"),
    base.replace(/\.jsx$/, ".d.ts"),
    base.replace(/\.ts$/, ".d.ts"),
    base.replace(/\.tsx$/, ".d.ts"),
    `${base}.d.ts`,
  ];
  for (const candidate of candidates) {
    if (declarations.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Extracts every module specifier referenced by one emitted declaration.
 *
 * Covers both top-level `import`/`export ... from "..."` statements and inline
 * import-type references such as `import("...").Type` and
 * `typeof import("...").Type`, which the declaration emitter keeps in type
 * positions. Collecting the latter is what lets the walk forbid a package
 * reachable only through an inline import type and resolve relative links that
 * appear only in type positions.
 */
function collectDeclarationSpecifiers(
  declarationPath: string,
  source: string,
): readonly string[] {
  const sourceFile = ts.createSourceFile(
    declarationPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportTypeNode(node)) {
      // `import("...").Type` and `typeof import("...").Type` parse as an
      // `ImportTypeNode` whose `argument` is a `LiteralTypeNode` wrapping the
      // module `StringLiteral`.
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        specifiers.push(argument.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

describe("public declaration graph does not reach engine/provider/SDK modules", () => {
  // The faithful public type surface is the GENERATED declaration graph, not
  // raw source: emitted `.d.ts` files strip comments and elide value-only
  // imports, so they cannot be tripped by a stray comment the way a source
  // substring scan can. We compile the root entrypoint to declarations in
  // memory, walk every module specifier reachable from the root, and assert
  // none of them is the MikroORM engine, the Google Sheets SDK, or the Google
  // auth library. The compile-time root leak guards above remain the
  // symbol-level check that specific internal storage types are not re-exported
  // from the root; together the two checks cover the public boundary.
  it("keeps MikroORM, the Google Sheets SDK, and Google auth out of the root declaration graph", () => {
    const { declarations, rootDeclarationPath, diagnostics } =
      emitPublicDeclarationGraph(auditRootEntry);

    // The emitted declaration graph is only a faithful public type surface when
    // the type checker reports no actionable diagnostics. A missing module, a
    // semantic error, or a declaration-emit failure can leave the root module
    // still emitted while the reachable graph is silently incomplete or
    // malformed, so the audit must fail on the diagnostics themselves rather
    // than only when the root module is absent. Only Error/Warning severities
    // gate the audit; Suggestion/Message diagnostics are advisory and excluded.
    const relevantDiagnostics = relevantDeclarationDiagnostics(diagnostics);
    expect(
      relevantDiagnostics,
      `declaration graph has compiler diagnostics that make the public surface unreliable:\n${formatDiagnostics(relevantDiagnostics, auditRepoRoot)}`,
    ).toHaveLength(0);

    // Sanity: declaration emit produced the root module. With no actionable
    // diagnostics above, this only fails if emit silently dropped the root
    // entry without reporting an error.
    expect(declarations.has(rootDeclarationPath)).toBe(true);

    // package specifier -> declaration modules that referenced it
    const reachablePackages = new Map<string, Set<string>>();
    // Relative specifiers that the in-memory emitted declaration map could not
    // resolve, paired with the declaration that referenced them. A public type
    // surface that names a relative module not present in the emitted graph is
    // incomplete and would not type-check for a consumer, so the walk must not
    // silently skip it. Intentionally external bare package specifiers are
    // never collected here; only relative ("."-prefixed) links that fail to
    // resolve in the emitted map are tracked.
    const unresolvedRelative: Array<{
      readonly specifier: string;
      readonly from: string;
    }> = [];
    const visited = new Set<string>();
    const queue: string[] = [rootDeclarationPath];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) continue;
      visited.add(current);
      const source = declarations.get(current);
      if (source === undefined) continue;
      for (const specifier of collectDeclarationSpecifiers(current, source)) {
        if (specifier.startsWith(".")) {
          const next = resolveDeclarationSpecifier(declarations, current, specifier);
          if (next === null) {
            // Record the unresolved relative link with its declaring emitted
            // declaration path so the post-walk assertion can name both the
            // missing specifier and where it was referenced. Both top-level
            // import/export specifiers and inline import-type specifiers flow
            // through this same collector, so either kind is covered.
            unresolvedRelative.push({
              specifier,
              from: relative(auditRepoRoot, current),
            });
          } else if (!visited.has(next)) {
            queue.push(next);
          }
          continue;
        }
        const modules = reachablePackages.get(specifier) ?? new Set<string>();
        modules.add(relative(auditRepoRoot, current));
        reachablePackages.set(specifier, modules);
      }
    }

    const leaked = [...reachablePackages.keys()].filter((pkg) =>
      FORBIDDEN_PUBLIC_PACKAGE.test(pkg),
    );
    expect(
      leaked,
      `public declaration graph reaches forbidden engine/SDK packages: ${leaked
        .map(
          (pkg) =>
            `${pkg} (from ${[...(reachablePackages.get(pkg) ?? [])].join(", ")})`,
        )
        .join("; ")}`,
    ).toEqual([]);

    // After the walk, every relative specifier the emitted declaration graph
    // referenced must have resolved to a `.d.ts` in the in-memory map. An
    // unresolved relative link means a public type signature points at a module
    // the declaration emitter did not produce, which would break a consumer's
    // type checker; the audit must fail and name each offending reference.
    expect(
      unresolvedRelative,
      `public declaration graph has unresolved relative module specifiers:\n${unresolvedRelative
        .map((entry) => `  ${entry.specifier} (from ${entry.from})`)
        .join("\n")}`,
    ).toEqual([]);
  });
});

describe("collectDeclarationSpecifiers covers inline import-type references", () => {
  // The declaration emitter keeps inline import types such as
  // `import("...").Type` and `typeof import("...").Type` in type positions
  // rather than always lifting them to top-level import statements. The graph
  // walk must collect those module specifiers too, otherwise a forbidden
  // package or a relative declaration link reachable only through an import
  // type would slip through the audit. This pins that behavior at the unit
  // level so a regression in the walker is caught independently of the full
  // in-memory declaration emit.
  it("collects import-type and typeof import-type module specifiers alongside import/export statements", () => {
    const source = [
      'import type { Foo } from "./foo";',
      'export type Bar = import("./bar").Bar;',
      'export type Baz = typeof import("./baz").Baz;',
      'export type Quux = import("@scope/pkg").Quux;',
      'export type Self = import("./self").Self<string>;',
      "",
    ].join("\n");

    expect(collectDeclarationSpecifiers("sample.d.ts", source)).toEqual(
      expect.arrayContaining([
        "./foo",
        "./bar",
        "./baz",
        "@scope/pkg",
        "./self",
      ]),
    );
  });
});

describe("entity descriptor rejects relation, join, and populate options", () => {
  // Hikoutei is scalar-only: relations, foreign keys, joins, populate, and
  // cascade/eager/lazy loading are explicitly out of scope and must be rejected
  // at definition time with a stable INVALID_ENTITY_DESCRIPTOR code. Each option
  // below is an ORM-relational concept that must never become a public property
  // option in the scalar contract.
  const forbiddenOptions = [
    "relation",
    "reference",
    "references",
    "foreignKey",
    "join",
    "populate",
    "cascade",
    "eager",
    "lazy",
    "entity",
    "onDelete",
    "mappedBy",
    "inversedBy",
  ] as const;

  it.each(forbiddenOptions)("rejects the %s relational option", (option) => {
    let caught: HikouteiError | undefined;
    try {
      defineTypedSheetsEntity({
        name: `ForbiddenOption_${option}`,
        tableName: `forbidden_option_${option}`,
        properties: {
          id: { type: "string", primary: true },
          target: {
            type: "string",
            [option]: Array.isArray(option) ? [] : "relational-value",
          } as never,
        },
      });
    } catch (error) {
      caught = error as HikouteiError;
    }

    expect(caught).toBeInstanceOf(HikouteiError);
    expect(caught?.code).toBe(HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR);
  });
});

describe("package.json packaging contract pins the import boundary", () => {
  // The root-allowlist, compile-time leak guards, and the in-memory
  // declaration-graph walk above all prove the SOURCE root entrypoint does not
  // leak engine/provider/SDK symbols or types. This block complements them by
  // pinning the npm packaging contract itself: the `exports` map exposes
  // exactly one subpath (`.`) routed into `dist`, and `files` ships only
  // `dist`. Together those guarantee a consumer can import only the root
  // entrypoint, that no internal module becomes a resolvable package export
  // (Node returns ERR_PACKAGE_PATH_NOT_EXPORTED for any other subpath), and
  // that source, tests, scripts, and tsconfig never ship in the tarball. If
  // the contract must change, these assertions fail loudly so the public
  // boundary gets a conscious review rather than silently widening. The values
  // here are exactly what the packed-tarball consumer smoke verified end to
  // end: a fresh consumer could resolve only `.` and the tarball carried only
  // `dist` plus npm-mandatory metadata.
  const pkgPath = join(auditRepoRoot, "package.json");
  const pkgText = ts.sys.readFile(pkgPath);
  if (pkgText === undefined) {
    throw new Error(`Could not read ${pkgPath}`);
  }
  const pkg = JSON.parse(pkgText) as {
    readonly main?: unknown;
    readonly types?: unknown;
    readonly exports?: unknown;
    readonly files?: unknown;
  };

  it("exposes exactly the root and the unstable sync-status subpath from the exports map", () => {
    // `.` with `types`/`import` conditions keeps every other specifier
    // (including `./dist/api/internalEntityManager.js`) resolving to
    // ERR_PACKAGE_PATH_NOT_EXPORTED for a consumer. The single intentional
    // exception is `./internal/sync-status`, the documented unstable
    // observability subpath reserved for first-party tooling (hikoutei-mcp);
    // adding any other subpath here would punch a hole through the import
    // boundary and must update this allowlist consciously.
    expect(pkg.exports).toEqual({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./internal/sync-status": {
        types: "./dist/internal/syncStatus.d.ts",
        import: "./dist/internal/syncStatus.js",
      },
    });
  });

  it("ships only the built dist directory", () => {
    // npm always includes package.json, README, and LICENSE regardless of the
    // `files` allowlist, so pinning `files` to ["dist"] is precisely what keeps
    // src/, test/, scripts/, docs/, and tsconfig out of the published tarball.
    expect(pkg.files).toEqual(["dist"]);
  });

  it("routes the main and types entrypoints into dist", () => {
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
  });
});
