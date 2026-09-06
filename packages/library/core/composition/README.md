# @hikoutei/composition

## Purpose
Composition root: registers the sync-engine ports, wires the concrete
MikroORM/Google-Sheets adapters, and owns the local-runtime and sync-auto-start
factories. Direction: composition imports engine + adapters, never the reverse.

## Boundary
Only place that wires concrete adapters. Public factories cross this boundary
once via lazy dynamic imports, so importing the root package never loads the
MikroORM/Google SDK module graph.

## Entry
`src/localRuntime.ts` (local-only wiring); `src/index.ts` (port registration),
`src/syncAutoStart.ts`, `src/syncEngine.ts`.
