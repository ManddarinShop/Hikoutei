/**
 * Kernel fixtures: a fresh in-memory SQLite store with the kernel schema and
 * a claimed writer fence, plus a factory for opaque pending effects.
 */

import assert from "node:assert/strict";

import {
  claimWriterLeaseWithAdapter,
  EFFECT_OUTBOX_DDL,
  type FencingContext,
  type NewEffect,
  PRESENCE_KINDS,
  APPLICABILITY_KINDS,
  VISIBLE_STATE_TABLES_DDL,
  WRITER_LEASE_DDL,
} from "../../src/index.js";
import { NodeSqliteTestAdapter } from "./nodeSqliteAdapter.js";

export const TEST_ROLE = "test-writer";
export const TEST_NOW = 1_000;

/** Opens an in-memory store with every kernel table applied. */
export function createKernelStore(): NodeSqliteTestAdapter {
  const adapter = new NodeSqliteTestAdapter();
  adapter.exec(EFFECT_OUTBOX_DDL);
  adapter.exec(WRITER_LEASE_DDL);
  adapter.exec(VISIBLE_STATE_TABLES_DDL);
  return adapter;
}

/** Claims the writer lease and returns the fence to use for queue mutations. */
export async function claimTestFence(
  adapter: NodeSqliteTestAdapter,
  now = TEST_NOW,
  writerId = "writer-1",
): Promise<FencingContext> {
  const result = await claimWriterLeaseWithAdapter(adapter, {
    role: TEST_ROLE,
    writerId,
    leaseDurationMs: 60_000,
    now,
  });
  assert(result.kind === "claimed", `writer lease claim failed: ${JSON.stringify(result)}`);
  return {
    role: TEST_ROLE,
    writerEpoch: result.lease.writerEpoch,
    fencingToken: result.lease.fencingToken,
    now,
  };
}

let effectSequence = 0;

/** Builds one opaque pending effect with unique identity and dedupe key. */
export function newEffect(overrides: Partial<NewEffect> = {}): NewEffect {
  effectSequence += 1;
  const sequence = effectSequence;
  return {
    effectId: `effect-${sequence}`,
    effectKind: "system_projection",
    commitId: `commit-${sequence}`,
    logicalSheetId: "logical-1",
    physicalSheetId: "physical-1",
    projection: "system_state",
    rowBindingId: { kind: PRESENCE_KINDS.ABSENT },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    targetKind: "entity",
    targetId: "entity-1",
    targetEntityRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: 1 },
    targetFieldRevisionHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    targetCanonicalCommitId: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    expectedVisibleRevision: 0,
    expectedVisibleHash: "",
    repairGuardHash: { kind: PRESENCE_KINDS.ABSENT },
    sourceQuarantineId: { kind: PRESENCE_KINDS.ABSENT },
    payloadJson: JSON.stringify({ opaque: true }),
    payloadHash: `payload-hash-${sequence}`,
    effectDedupeKey: `dedupe-${sequence}`,
    streamSequence: sequence,
    ...overrides,
  };
}
