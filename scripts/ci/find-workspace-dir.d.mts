/** Type declarations for the workspace discovery helper used by CI and tests. */

export type WorkspaceManifest = {
  dir: string;
  manifest: string;
  pkg: { name?: unknown; dependencies?: unknown; devDependencies?: unknown } & Record<
    string,
    unknown
  >;
};

export type DirLookupResult =
  | { status: "valid"; dir: string }
  | { status: "invalid"; reason: string };

export type ManifestsLookupResult =
  | { status: "valid"; manifests: string[] }
  | { status: "invalid"; reason: string };

/** Collects every workspace manifest under <root>/packages (max depth 3). */
export function collectWorkspaceManifests(rootDir: string): WorkspaceManifest[];

/** Finds the single workspace dir whose package.json carries the name. */
export function findWorkspaceDirByPackageName(
  rootDir: string,
  name: string,
): DirLookupResult;

/** Lists manifests carrying dep in dependencies or devDependencies. */
export function findManifestsWithDep(rootDir: string, dep: string): ManifestsLookupResult;

/** Runs the find-workspace-dir command used by GitHub Actions. */
export function main(argv?: string[]): number;
