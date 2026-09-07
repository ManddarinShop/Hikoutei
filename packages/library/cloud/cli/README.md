# @hikoutei/cli

## Purpose
Service-side provisioning CLI, not part of the library API: `hikoutei setup`
(bootstrap flow) and `hikoutei adopt` (existing-sheet adoption); bare flags stay
on the legacy setup spelling. Bundled into the root `dist/cli/**` bin.

## Boundary
Not importable library surface. Subcommand modules keep ESM entrypoint guards,
so importing the router never triggers their side effects; unexpected failures
exit via the stable setup error code.

## Entry
`src/index.ts` (bin router); `src/setup.ts`, `src/adoptMain.ts`.
