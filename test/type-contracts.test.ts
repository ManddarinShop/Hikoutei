import { describe, expect, it } from "vitest";

import {
  decodePendingEffectRow,
  validateApplyResultOptions,
  validateProjectionConfirmation,
} from "../src/infrastructure/storage/sync/outbound/effectOutboxSupport.js";
import { StorageError } from "../src/infrastructure/storage/errors.js";
import { isCanonicalUtcIsoDate } from "../src/shared/validation.js";

function rawPendingEffect(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    effect_id: "effect-1",
    effect_kind: "system_projection",
    commit_id: "commit-1",
    logical_sheet_id: "logical-sheet",
    physical_sheet_id: "physical-sheet",
    projection: "system_state",
    row_binding_id: null,
    conflict_id: null,
    target_kind: "entity",
    target_id: "entity-1",
    target_entity_revision: 1,
    target_field_revision_hash: null,
    target_canonical_commit_id: null,
    expected_visible_revision: 0,
    expected_visible_hash: "",
    repair_guard_hash: null,
    source_quarantine_id: null,
    payload_json: "{}",
    payload_hash: "payload-hash",
    effect_dedupe_key: "dedupe-1",
    stream_sequence: 1,
    created_at: 1_000,
    status: "pending",
    ...overrides,
  };
}

describe("internal type contract promotion", () => {
  it("promotes a valid pending effect and rejects an unknown stored status", () => {
    expect(decodePendingEffectRow(rawPendingEffect())).toMatchObject({
      effect_id: "effect-1",
      effect_kind: "system_projection",
      status: "pending",
    });

    expect(() => decodePendingEffectRow(rawPendingEffect({ status: "unknown" })))
      .toThrowError(StorageError);
  });

  it("rejects non-terminal apply statuses and malformed confirmations at runtime", () => {
    expect(() => validateApplyResultOptions({
      effectId: "effect-1",
      claimToken: "claim-1",
      role: "sync_writer",
      writerEpoch: 1,
      fencingToken: "fence-1",
      now: 1_000,
      status: "pending",
      lastErrorCode: { kind: "absent" },
      lastErrorMessage: { kind: "absent" },
    } as never)).toThrowError(StorageError);

    expect(() => validateProjectionConfirmation({
      physicalSheetId: "sheet-1",
      projection: "system_state",
      rowBindingId: "binding-1",
      visibleRevision: 1,
      visibleHash: 42,
      entityRevision: { kind: "not_applicable" },
      fieldHashes: {},
    } as never)).toThrowError(StorageError);
  });

  it("allows an empty expected visible hash only for the new-row sentinel", () => {
    expect(decodePendingEffectRow(rawPendingEffect({ expected_visible_hash: "" })))
      .toMatchObject({ expected_visible_hash: "" });
    expect(() => decodePendingEffectRow(rawPendingEffect({ expected_visible_hash: null })))
      .toThrowError(StorageError);
    expect(() => decodePendingEffectRow(rawPendingEffect({
      expected_visible_revision: 1,
      expected_visible_hash: "",
    }))).toThrowError(StorageError);
  });

  it("shares the canonical date predicate used by storage and gateway boundaries", () => {
    expect(isCanonicalUtcIsoDate("2026-01-02T03:04:05.000Z")).toBe(true);
    expect(isCanonicalUtcIsoDate("2026-01-02T03:04:05+00:00")).toBe(false);
  });
});
