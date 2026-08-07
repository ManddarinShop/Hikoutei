/**
 * Contract-drift guard between the @hikoutei/ikisaki kernel package and the
 * host application.
 *
 * The kernel is compiled and published independently of the host, but several
 * persisted string contracts are shared across the boundary: storage error
 * codes, effect kinds, effect targets, and effect statuses. Host and kernel
 * each declare their own `as const` tables (the kernel must stay
 * self-contained), so this test pins every kernel value to the matching host
 * value key-by-key and fails loudly if either side drifts. Credential-free
 * and fast: it only compares constant tables.
 */

import { describe, expect, it } from "vitest";

import {
  EFFECT_KINDS as KERNEL_EFFECT_KINDS,
  EFFECT_STATUSES as KERNEL_EFFECT_STATUSES,
  EFFECT_TARGET_KINDS as KERNEL_EFFECT_TARGET_KINDS,
  STORAGE_ERROR_CODES as KERNEL_STORAGE_ERROR_CODES,
} from "@hikoutei/ikisaki";
import {
  EFFECT_KINDS as HOST_EFFECT_KINDS,
  EFFECT_STATUSES as HOST_EFFECT_STATUSES,
  EFFECT_TARGET_KINDS as HOST_EFFECT_TARGET_KINDS,
} from "../src/domain/model/constants.js";
import { STORAGE_ERROR_CODES as HOST_STORAGE_ERROR_CODES } from "../src/infrastructure/storage/errors.js";

/** Constant tables are plain string-keyed string maps at runtime. */
type StringConstantTable = Readonly<Record<string, string>>;

/** Asserts every kernel entry exists in the host table with the same value. */
function assertSharedValuesEqual(
  kernel: StringConstantTable,
  host: StringConstantTable,
  tableName: string,
): void {
  const kernelEntries = Object.entries(kernel);
  expect(kernelEntries.length, `${tableName} must not be empty`).toBeGreaterThan(0);
  for (const [key, value] of kernelEntries) {
    expect(host[key], `${tableName}.${key}`).toBe(value);
  }
}

describe("outbox kernel / host persisted-contract drift", () => {
  it("keeps storage error code values byte-identical for the shared keys", () => {
    assertSharedValuesEqual(
      KERNEL_STORAGE_ERROR_CODES,
      HOST_STORAGE_ERROR_CODES,
      "STORAGE_ERROR_CODES",
    );
  });

  it("keeps effect kind values byte-identical for the shared keys", () => {
    assertSharedValuesEqual(KERNEL_EFFECT_KINDS, HOST_EFFECT_KINDS, "EFFECT_KINDS");
  });

  it("keeps effect target kind values byte-identical for the shared keys", () => {
    assertSharedValuesEqual(
      KERNEL_EFFECT_TARGET_KINDS,
      HOST_EFFECT_TARGET_KINDS,
      "EFFECT_TARGET_KINDS",
    );
  });

  it("keeps effect status values byte-identical for the shared keys", () => {
    assertSharedValuesEqual(
      KERNEL_EFFECT_STATUSES,
      HOST_EFFECT_STATUSES,
      "EFFECT_STATUSES",
    );
  });
});
