# @hikoutei/docs

## Purpose
Minimal Google Docs API adapter leaf: `documents.create/get/batchUpdate`
with shared quota pacing (`@hikoutei/ikisaki` governor + budgets) and
retry classification. Docs is a projection surface, never the source of
truth.

## Boundary
Must not import `@hikoutei/sync-engine` or `@hikoutei/sheets`. Never
forwards SDK objects beyond the transport module; telemetry carries only
redacted counts/durations/codes.

## Quota numbers
Provisional (copied from the Sheets measured deployment until Docs quota
is measured in the target console project); see `src/constants.ts`.
