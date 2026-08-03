export type NpmDistTagLookup =
  | { status: "found"; version: string }
  | { status: "missing" }
  | { status: "failed"; code: string; reason: string };

export function parseNpmViewDistTagResult(result: {
  status: number | null;
  stdout: string;
  stderr: string;
}): NpmDistTagLookup;

export function readNpmDistTag(packageName: string, tag: string): string;

export function main(argv?: readonly string[]): Promise<number>;
