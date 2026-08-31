/**
 * Contract validation tests for `toProviderEffect` in dispatcherSupport.
 *
 * When a persisted outbox value fails its closed-union check (unsupported
 * effect_kind, projection, or target_kind), the function throws a structured
 * SyncEffectContractError carrying a stable code and the persisted value.
 */

import { describe, expect, it } from "vitest";

import { toProviderEffect } from "@hikoutei/sync-engine/sync/outbound/dispatcherSupport.js";
import {
  SYNC_EFFECT_CONTRACT_ERROR_CODES,
  SyncEffectContractError,
} from "@hikoutei/sync-engine/sync/outbound/errors.js";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "@hikoutei/contracts/state/constants.js";
import {
  requireSemanticString,
  type PendingEffect,
} from "@hikoutei/ikisaki";

function baseEffect(overrides: Partial<PendingEffect> = {}): PendingEffect {
  const fields = { id: { kind: "string" as const, value: "row-1" } };
  const payload = {
    sheetName: "rows_System",
    registeredRange: "A:B",
    schemaVersion: 1,
    targetAnchor: "anchor-1",
    fields,
    targetVisibleHash: "",
    createIfMissing: false,
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
    expected_visible_revision: 0,
    expected_visible_hash: requireSemanticString<"visible-hash">("baseline-1", "visible hash"),
    repair_guard_hash: null,
    source_quarantine_id: null,
    payload_json: JSON.stringify(payload),
    ...overrides,
  } as PendingEffect;
}

describe("toProviderEffect persisted-value contract", () => {
  it("throws SyncEffectContractError for an unsupported effect_kind", () => {
    const effect = baseEffect({ effect_kind: "bogus_kind" as PendingEffect["effect_kind"] });
    expect.assertions(3);
    try {
      toProviderEffect(effect);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SyncEffectContractError);
      expect((error as SyncEffectContractError).code).toBe(
        SYNC_EFFECT_CONTRACT_ERROR_CODES.UNSUPPORTED_SYNC_EFFECT_KIND,
      );
      expect((error as Error).message).toBe("unsupported sync effect kind: bogus_kind");
    }
  });

  it("throws SyncEffectContractError for an unsupported projection", () => {
    const effect = baseEffect({ projection: "bogus_projection" as PendingEffect["projection"] });
    expect.assertions(3);
    try {
      toProviderEffect(effect);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SyncEffectContractError);
      expect((error as SyncEffectContractError).code).toBe(
        SYNC_EFFECT_CONTRACT_ERROR_CODES.UNSUPPORTED_SYNC_PROJECTION,
      );
      expect((error as Error).message).toBe("unsupported sync projection: bogus_projection");
    }
  });

  it("throws SyncEffectContractError for an unsupported target_kind", () => {
    const effect = baseEffect({ target_kind: "bogus_target" as PendingEffect["target_kind"] });
    expect.assertions(3);
    try {
      toProviderEffect(effect);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SyncEffectContractError);
      expect((error as SyncEffectContractError).code).toBe(
        SYNC_EFFECT_CONTRACT_ERROR_CODES.UNSUPPORTED_SYNC_EFFECT_TARGET_KIND,
      );
      expect((error as Error).message).toBe("unsupported sync effect target kind: bogus_target");
    }
  });
});
