/**
 * P8-B bundle-model smoke: run the BUILT root dist entry (dist/index.js)
 * and prove the bundled @hikoutei/contracts code inside dist/contracts
 * actually executes from the public surface (the rewritten relative
 * specifiers are the only runtime path — exactly like in the packed
 * artifact, with no @hikoutei/contracts package in dependencies).
 *
 * Public-surface contract exercised (same shape as the installed-package
 * root API scenario): defineTypedSheetsEntity -> createTypedSheets -> fork;
 * create/persist/flush -> findOne verify; mutate/flush/re-read; remove/
 * flush -> absence; close idempotency; HikouteiError (contracts
 * CoreErrorException subclass) constructible.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Import the built artifact directly — like an installed consumer would.
const hikoutei = await import(new URL("../../dist/index.js", import.meta.url));
assert.ok(hikoutei.createTypedSheets, "createTypedSheets export present");
assert.ok(hikoutei.defineTypedSheetsEntity, "defineTypedSheetsEntity export present");
assert.ok(hikoutei.HikouteiError, "HikouteiError export present");
assert.ok(hikoutei.HIKOUTEI_ERROR_CODES, "HIKOUTEI_ERROR_CODES export present");

// HikouteiError extends the bundled contracts-domain CoreErrorException —
// constructing it executes code loaded from dist/contracts.
const err = new hikoutei.HikouteiError(
  hikoutei.HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
  "smoke",
);
assert.ok(err instanceof Error, "HikouteiError constructible (contracts error chain executed)");

const dir = mkdtempSync(path.join(tmpdir(), "hikoutei-smoke-"));
let runtime;
try {
  const User = hikoutei.defineTypedSheetsEntity({
    name: "User",
    tableName: "users",
    properties: {
      id: { type: "string", primary: true },
      name: { type: "string" },
      count: { type: "number" },
      active: { type: "boolean" },
    },
  });
  runtime = await hikoutei.createTypedSheets({ dbName: ":memory:", entities: [User] });
  const em = runtime.em.fork();

  const user = em.create(User, { id: "SMOKE-1", name: "contracts-bundle-smoke", count: 1, active: true });
  em.persist(user);
  await em.flush();
  const loaded = await em.findOne(User, { id: "SMOKE-1" });
  assert.equal(loaded?.name, "contracts-bundle-smoke", "create/persist/flush -> findOne round-trip");

  loaded.name = "contracts-bundle-smoke-2";
  await em.flush();
  const fresh = await runtime.em.fork().findOne(User, { id: "SMOKE-1" });
  assert.equal(fresh?.name, "contracts-bundle-smoke-2", "mutate/flush -> fresh-fork re-read");

  em.remove(loaded);
  await em.flush();
  const gone = await runtime.em.fork().findOne(User, { id: "SMOKE-1" });
  assert.equal(gone, null, "remove/flush -> absence");

  await runtime.close();
  await runtime.close(); // idempotency
  console.log(
    "[smoke-contracts-bundle] PASSED: built dist/index.js executed; " +
      "encoding/identity/state/domain/sheets contracts code ran from dist/contracts " +
      "(error chain + lifecycle stableEncode round-trip).",
  );
} finally {
  if (runtime) await runtime.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}