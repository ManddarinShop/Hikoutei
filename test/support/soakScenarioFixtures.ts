/**
 * Shared fake seams for the `test/soak-scenarios-*.test.ts` family.
 *
 * The twelve scenario test files each declared a private `FakeEm`
 * EntityManager fake, a `liveContext` builder, and — where the scenario has a
 * human write that must be projected into the fake `_Input` tab — a
 * `projectPersistedRow` helper. The copies drifted in small, mechanical ways;
 * this module is the strict capability union of those copies:
 *
 * - `findOneOverride` — hook over `findOne` (from the
 *   human-edit/multi-field lineage; the corruption/shifted/invalid/no-op
 *   copies lacked it, where it is inert).
 * - `flushBehavior` + a private flush counter — throws on the Nth flush
 *   (from the same lineage; simpler copies had an empty `flush()`, where it
 *   is inert). The counter doubles as the `flushCount()` accessor the
 *   `pendingDeliveryReopen` copy exposed as a private `#flushCount` field.
 * - `findResultsOverride` / `findOverride` — two name-compatible hooks over
 *   `find` with identical bodies, retained verbatim from the
 *   `deleteRecreate*` and `humanEditPublicDelete` copies so consumer call
 *   sites need no edits.
 *
 * `projectPersistedRow` genuinely diverged across lineages (which fields the
 * fake sync worker projects into the `_Input` tab), so the three behaviors
 * live here as distinct named helpers:
 * - `projectPersistedRow`: the single `plan.target.field` projection used by
 *   the single-human-field scenarios (`humanDeleteRow`, `noOpHumanEdit`,
 *   `localHumanWriteRace`, `humanEditPublicDelete`, `deleteRecreateHumanEdit`).
 * - `projectHumanFieldsRow`: projects every `plan.humanFields` entry
 *   (`multiFieldHumanEdit`). Scenario files import it aliased as
 *   `projectPersistedRow` so their call sites are unchanged.
 * - `projectAllFieldsRow`: projects every non-primary field of the target
 *   entity via `SOAK_FIELD_PLANS` (`humanInsertDuplicateId`).
 *
 * Not consolidated here (genuinely divergent signatures/plan shapes, kept
 * local by their files on purpose): `deleteRecreateRace` and
 * `pendingDeliveryReopen` build their contexts with different parameter
 * shapes, and `noOpHumanEdit` reserves the fourth `liveContext` slot for the
 * scenario `seed` instead of a deadline.
 */

import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../../scripts/ci/local-soak/entities.mjs";

/** A fake EntityManager over an in-memory id-keyed store. */
export class FakeEm {
  store = new Map<string, Record<string, unknown>>();
  findOneOverride: ((id: string) => Record<string, unknown> | null | undefined) | undefined;
  /** Throws on the flush whose 1-based call index matches. */
  flushBehavior: ((flushIndex: number) => void) | undefined;
  /** Hook over `find` (retained alias from the `humanEditPublicDelete` copy). */
  findOverride: ((id: string) => Record<string, unknown>[] | undefined) | undefined;
  /** Hook over `find` (retained alias from the `deleteRecreate*` copies). */
  findResultsOverride: ((id: string) => Record<string, unknown>[] | undefined) | undefined;
  #flushIndex = 0;

  fork(): FakeEm {
    return this;
  }
  create(_token: unknown, row: Record<string, unknown>): Record<string, unknown> {
    return row;
  }
  persist(entity: Record<string, unknown>): void {
    if (entity !== null && typeof entity === "object" && typeof entity.id === "string") {
      this.store.set(entity.id, entity);
    }
  }
  async flush(): Promise<void> {
    this.#flushIndex += 1;
    if (this.flushBehavior !== undefined) this.flushBehavior(this.#flushIndex);
  }
  async find(_token: unknown, filter: { id: string }): Promise<Record<string, unknown>[]> {
    if (this.findResultsOverride !== undefined) {
      const overridden = this.findResultsOverride(filter.id);
      if (overridden !== undefined) return overridden;
    }
    if (this.findOverride !== undefined) {
      const overridden = this.findOverride(filter.id);
      if (overridden !== undefined) return overridden;
    }
    const row = this.store.get(filter.id);
    return row === undefined ? [] : [row];
  }
  async findOne(_token: unknown, filter: { id: string }): Promise<Record<string, unknown> | null> {
    if (this.findOneOverride !== undefined) {
      const overridden = this.findOneOverride(filter.id);
      if (overridden !== null && overridden !== undefined) return overridden;
    }
    const row = this.store.get(filter.id);
    return row === undefined ? null : row;
  }
  remove(row: Record<string, unknown>): void {
    if (row !== null && typeof row === "object" && typeof row.id === "string") {
      this.store.delete(row.id);
    }
  }
  rows(): Record<string, unknown>[] {
    return [...this.store.values()];
  }
  /** Total flushes observed (from the `pendingDeliveryReopen` copy). */
  flushCount(): number {
    return this.#flushIndex;
  }
}

/** The minimal plan face the live context needs (every scenario's plan has a `.target.entityName`). */
export interface LiveContextPlanLike {
  target: { entityName: string };
}

/** The minimal plan face the single-field projection needs. */
export interface TargetFieldPlanLike {
  target: { entityName: string; field: string; targetId: string };
}

/** The minimal plan face the multi-field projection needs. */
export interface HumanFieldsPlanLike {
  target: { entityName: string; targetId: string };
  humanFields: string[];
}

/** The minimal plan face the all-fields projection needs. */
export interface TargetIdPlanLike {
  target: { entityName: string; targetId: string };
}

/** Structural face of the per-file `FakeClient` consumed by the projection helpers. */
export interface SoakFakeSheetClient {
  ensureTab(tabName: string, headers: string[]): void;
  setCell(tabName: string, identity: string, values: Record<string, string>): void;
}

/** Builds a live execution context wired to the fake seams. */
export function liveContext(
  plan: LiveContextPlanLike,
  client: object,
  em: FakeEm,
  deadlineAtMs?: number,
): Record<string, unknown> {
  return {
    seed: 1,
    cycle: 1,
    activeEntities: SOAK_ENTITY_ORDER,
    tokenByEntity: new Map([[plan.target.entityName, { entity: plan.target.entityName }]]),
    em,
    live: { mode: "live", client, spreadsheetId: "spreadsheet-1" },
    deadlineAtMs: deadlineAtMs ?? Date.now() + 5000,
  };
}
/**
 * The projected Sheet cell string a soak field value carries once the sync
 * worker projects it: booleans as uppercase `TRUE`/`FALSE`, dates as
 * canonical ISO strings, numbers/strings as String(), null as the empty cell.
 * Mirrors the scenario's own `projectedCellString` so the fake projection is
 * indistinguishable from the real Sheet.
 */
export function projectedCell(value: unknown, type: string | undefined): string {
  if (value === null || value === undefined) return "";
  if (type === "boolean") return value ? "TRUE" : "FALSE";
  if (type === "date") {
    return (value instanceof Date ? value : new Date(value as string | number)).toISOString();
  }
  return String(value);
}

/**
 * Hooks the fake EntityManager's `persist` so the dedicated row's single
 * human field is projected into the fake `_Input` tab at the exact
 * cell-string the row will carry once the sync worker projects it (the
 * authoritative-value pattern shared by the single-human-field scenarios).
 */
export function projectPersistedRow(em: FakeEm, client: SoakFakeSheetClient, plan: TargetFieldPlanLike): void {
  const originalPersist = em.persist.bind(em);
  em.persist = (entity: Record<string, unknown>) => {
    const value = entity[plan.target.field];
    const projected = value === null || value === undefined ? "" : String(value);
    client.ensureTab(`${plan.target.entityName}_Input`, ["id", plan.target.field]);
    client.setCell(`${plan.target.entityName}_Input`, plan.target.targetId, {
      id: plan.target.targetId,
      [plan.target.field]: projected,
    });
    originalPersist(entity);
  };
}

/**
 * Multi-field variant of `projectPersistedRow` (`multiFieldHumanEdit`):
 * projects every `plan.humanFields` entry into the fake `_Input` tab.
 */
export function projectHumanFieldsRow(em: FakeEm, client: SoakFakeSheetClient, plan: HumanFieldsPlanLike): void {
  const originalPersist = em.persist.bind(em);
  em.persist = (entity: Record<string, unknown>) => {
    const headers = ["id", ...plan.humanFields];
    const values: Record<string, string> = { id: plan.target.targetId };
    for (const field of plan.humanFields) {
      const value = entity[field];
      values[field] = value === null || value === undefined ? "" : String(value);
    }
    client.ensureTab(`${plan.target.entityName}_Input`, headers);
    client.setCell(`${plan.target.entityName}_Input`, plan.target.targetId, values);
    originalPersist(entity);
  };
}

/**
 * All-fields variant of `projectPersistedRow` (`humanInsertDuplicateId`):
 * projects every non-primary SOAK_FIELD_PLANS field of the target entity.
 * `capture` (optional) records the projected cell strings so a test can
 * assert the typed boolean/date display strings without re-deriving them.
 */
export function projectAllFieldsRow(
  em: FakeEm,
  client: SoakFakeSheetClient,
  plan: TargetIdPlanLike,
  capture?: { values: Record<string, string> },
): void {
  const originalPersist = em.persist.bind(em);
  em.persist = (entity: Record<string, unknown>) => {
    const fieldPlan = SOAK_FIELD_PLANS[plan.target.entityName]!;
    const headers = ["id"];
    const values: Record<string, string> = { id: plan.target.targetId };
    for (const [field, spec] of Object.entries(fieldPlan)) {
      if (spec.primary) continue;
      headers.push(field);
      values[field] = projectedCell(entity[field], spec.type);
    }
    if (capture) capture.values = values;
    client.ensureTab(`${plan.target.entityName}_Input`, headers);
    client.setCell(`${plan.target.entityName}_Input`, plan.target.targetId, values);
    originalPersist(entity);
  };
}
