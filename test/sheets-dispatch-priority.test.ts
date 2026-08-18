/**
 * Dispatch-priority classification tests for the Sheets effect dispatcher.
 *
 * The worker runs ready effects in ascending declared priority across both
 * dispatch buckets. These tests pin the host classification: System_State
 * fast appends first, then System_State regular followers, then Sync_Conflicts
 * fast appends, then User_Input/other regular effects. They also pin that a
 * priority-0/2 row is always a fast-append candidate and that malformed
 * payloads degrade to the neutral class without throwing.
 */

import { describe, expect, it } from "vitest";

import { APPLICABILITY_KINDS, PRESENCE_KINDS } from "../src/shared/state/constants.js";
import {
  sheetsDispatchPriorityFor,
  SYNC_DISPATCH_PRIORITIES,
} from "../src/application/sync/outbound/SheetsEffectDispatcher.js";
import {
  computeSyncVisibleHash,
  serializeSyncProjectionEffectPayload,
} from "../src/application/sync/sheetsContract/syncSheets.js";
import {
  requireSemanticString,
  type PendingEffect,
} from "@hikoutei/ikisaki";

function pendingEffect(overrides: Partial<PendingEffect> = {}): PendingEffect {
  const fields = { id: { kind: "string" as const, value: "row-1" } };
  const createIfMissing = overrides.payload_json === undefined
    ? overrides.expected_visible_hash === "" && overrides.expected_visible_revision === 0
    : false;
  const payload = {
    sheetName: "rows_System",
    registeredRange: "A:B",
    schemaVersion: 1,
    targetAnchor: "anchor-1",
    fields,
    targetVisibleHash: computeSyncVisibleHash(fields),
    createIfMissing,
    expectedCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
  };
  return {
    effect_id: requireSemanticString<"effect-id">("effect-1", "effect ID"),
    effect_kind: "system_projection",
    commit_id: "commit-1",
    logical_sheet_id: "logical-1",
    physical_sheet_id: requireSemanticString<"physical-sheet-id">("physical-1", "physical sheet ID"),
    projection: "system_state",
    row_binding_id: null,
    conflict_id: null,
    target_kind: "entity",
    target_id: "entity-1",
    target_entity_revision: null,
    target_field_revision_hash: null,
    target_canonical_commit_id: null,
    expected_visible_revision: 1,
    expected_visible_hash: requireSemanticString<"visible-hash">("baseline-1", "visible hash"),
    repair_guard_hash: null,
    source_quarantine_id: null,
    payload_json: serializeSyncProjectionEffectPayload(payload),
    payload_hash: requireSemanticString<"payload-hash">("payload-1", "payload hash"),
    effect_dedupe_key: requireSemanticString<"effect-dedupe-key">("dedupe-1", "effect dedupe key"),
    stream_sequence: 1,
    created_at: 0,
    next_attempt_at: null,
    uncertain_since: null,
    next_probe_at: null,
    dispatch_id: null,
    status: "pending",
    ...overrides,
  };
}

describe("sheetsDispatchPriorityFor", () => {
  it("runs System_State fast-append creates first (priority 0)", () => {
    const effect = pendingEffect({
      effect_kind: "system_projection",
      projection: "system_state",
      target_kind: "entity",
      expected_visible_revision: 0,
      expected_visible_hash: "",
    });
    expect(sheetsDispatchPriorityFor(effect))
      .toBe(SYNC_DISPATCH_PRIORITIES.SYSTEM_STATE_FAST_APPEND);
  });

  it("runs System_State regular update/delete/tombstone followers next (priority 1)", () => {
    const update = pendingEffect({
      effect_kind: "system_projection",
      projection: "system_state",
      target_kind: "entity",
      expected_visible_revision: 3,
      expected_visible_hash: requireSemanticString<"visible-hash">("baseline-3", "visible hash"),
    });
    const tombstone = pendingEffect({
      effect_kind: "system_projection",
      projection: "system_state",
      target_kind: "entity",
      expected_visible_revision: 0,
      expected_visible_hash: requireSemanticString<"visible-hash">("non-empty-baseline", "visible hash"),
    });
    expect(sheetsDispatchPriorityFor(update))
      .toBe(SYNC_DISPATCH_PRIORITIES.SYSTEM_STATE_REGULAR);
    expect(sheetsDispatchPriorityFor(tombstone))
      .toBe(SYNC_DISPATCH_PRIORITIES.SYSTEM_STATE_REGULAR);
  });

  it("runs Sync_Conflicts fast appends after System_State followers (priority 2)", () => {
    const effect = pendingEffect({
      effect_kind: "resolution_projection",
      projection: "sync_conflicts",
      target_kind: "conflict",
      expected_visible_revision: 0,
      expected_visible_hash: "",
    });
    expect(sheetsDispatchPriorityFor(effect))
      .toBe(SYNC_DISPATCH_PRIORITIES.SYNC_CONFLICTS_FAST_APPEND);
  });

  it("runs User_Input and other regular effects last (priority 3)", () => {
    const userDelete = pendingEffect({
      effect_kind: "user_input_delete",
      projection: "user_input",
      target_kind: "row_binding",
      expected_visible_revision: 2,
      expected_visible_hash: requireSemanticString<"visible-hash">("baseline-2", "visible hash"),
    });
    const resolutionUpdate = pendingEffect({
      effect_kind: "resolution_projection",
      projection: "sync_conflicts",
      target_kind: "conflict",
      expected_visible_revision: 1,
      expected_visible_hash: requireSemanticString<"visible-hash">("baseline-1", "visible hash"),
    });
    const repair = pendingEffect({
      effect_kind: "system_repair",
      projection: "system_state",
      target_kind: "entity",
      expected_visible_revision: 4,
      expected_visible_hash: requireSemanticString<"visible-hash">("baseline-4", "visible hash"),
    });
    expect(sheetsDispatchPriorityFor(userDelete))
      .toBe(SYNC_DISPATCH_PRIORITIES.OTHER_REGULAR);
    expect(sheetsDispatchPriorityFor(resolutionUpdate))
      .toBe(SYNC_DISPATCH_PRIORITIES.OTHER_REGULAR);
    expect(sheetsDispatchPriorityFor(repair))
      .toBe(SYNC_DISPATCH_PRIORITIES.OTHER_REGULAR);
  });

  it("degrades a malformed payload to the neutral class without throwing", () => {
    const malformed = pendingEffect({
      payload_json: "{not-json",
    });
    expect(sheetsDispatchPriorityFor(malformed))
      .toBe(SYNC_DISPATCH_PRIORITIES.OTHER_REGULAR);
  });
});
