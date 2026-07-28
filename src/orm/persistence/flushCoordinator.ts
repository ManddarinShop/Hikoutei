/**
 * Public mapped persistence orchestration.
 *
 * This module collects entity changes, fences the flush with a writer lease,
 * and delegates each lifecycle operation to the focused persistence helpers.
 */

import { randomUUID } from "node:crypto";

import {
  EMPTY_STRING_LENGTH_ZERO,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "../../core/index.js";
import { SYNC_TIMING_SCOPES } from "../../runtime/telemetry/syncTiming.js";
import {
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  claimWriterLeaseWithSql,
  registerSyncSheetWithSql,
  type FencingContext,
} from "../../storage/index.js";
import type { RegisteredSyncProjectionDefinition } from "../../runtime/gateway/SyncGatewayBootstrap.js";
import type { SqlStorageAdapter } from "../../adapter/persistence/contracts/sql.js";
import {
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
  type TypedSheetsEntityChange,
  type TypedSheetsFlushContext,
  type TypedSheetsFlushCoordinator,
} from "../api/contracts.js";
import {
  createTypedSheetsEntityMappingRegistry,
  createTypedSheetsMappedProjectionDefinitions,
  typedSheetsEntityId,
  type TypedSheetsEntityFieldMapping,
  type TypedSheetsEntityMapping,
  type TypedSheetsEntityMappingRegistry,
} from "../mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";
import {
  DEFAULT_MAPPED_WRITER_LEASE_DURATION_MS,
  DEFAULT_MAPPED_WRITER_ROLE,
  type CreateMappedTypedSheetsFlushCoordinatorOptions,
  type MappedChangePlan,
  type RegisteredTypedSheetsMappedProjection,
  type ResolvedWriterOptions,
  type TypedSheetsEntityWriterOptions,
} from "./contracts.js";
import { applyMappedChange } from "./entityLifecycle.js";
import {
  countsForPlans,
  emitTiming,
  operationKindsForCounts,
} from "./timing.js";

/**
 * Creates the built-in planner that makes `em.persist()` / `em.flush()` durable
 * in the entity table, canonical state, business-key index, and Sheets outbox
 * together.
 */
export function createMappedTypedSheetsFlushCoordinator(
  options: CreateMappedTypedSheetsFlushCoordinatorOptions,
): TypedSheetsFlushCoordinator {
  const mappings = mappingRegistry(options.mappings);
  const writer = resolveWriterOptions(options.writer);

  return {
    async onFlush(context: TypedSheetsFlushContext): Promise<void> {
      const flushStartedAt = Date.now();
      const plans = collectMappedChanges(mappings, context.changes);
      if (plans.length === 0) return;

      const operationCounts = countsForPlans(plans);
      const leaseStartedAt = Date.now();
      const now = writer.now();
      const claim = await claimWriterLeaseWithSql(context.sql, {
        role: writer.role,
        writerId: writer.writerId,
        leaseDurationMs: writer.leaseDurationMs,
        now,
      });
      if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
        throw new TypedSheetsOrmError(
          TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
          `mapped entity writer lease is unavailable: ${claim.reason}.`,
        );
      }
      emitTiming(writer, {
        scope: SYNC_TIMING_SCOPES.ORM_FLUSH,
        phase: "writer_lease_claim",
        durationMs: Date.now() - leaseStartedAt,
        operationKinds: operationKindsForCounts(operationCounts),
        operationCounts,
      });

      const fence: FencingContext = {
        role: claim.lease.role,
        writerEpoch: claim.lease.writerEpoch,
        fencingToken: claim.lease.fencingToken,
        now,
      };
      for (const plan of plans) {
        await applyMappedChange(context.sql, fence, writer, plan);
      }
      emitTiming(writer, {
        scope: SYNC_TIMING_SCOPES.ORM_FLUSH,
        phase: "flush_total",
        durationMs: Date.now() - flushStartedAt,
        operationKinds: operationKindsForCounts(operationCounts),
        operationCounts,
      });
    },
  };
}

/**
 * Registers every mapping route under one writer fence.
 *
 * The return value can be passed directly to the existing gateway provisioning
 * helper, so users never need to duplicate route names or header lists in Apps
 * Script configuration.
 */
export async function registerTypedSheetsEntityMappings(
  storage: SqlStorageAdapter,
  mappingsInput: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[],
  writerInput: TypedSheetsEntityWriterOptions,
): Promise<readonly RegisteredTypedSheetsMappedProjection[]> {
  const mappings = mappingRegistry(mappingsInput);
  const writer = resolveWriterOptions(writerInput);
  const definitions = createTypedSheetsMappedProjectionDefinitions(mappings.mappings);

  return storage.transaction(async ({ sql }) => {
    const now = writer.now();
    const claim = await claimWriterLeaseWithSql(sql, {
      role: writer.role,
      writerId: writer.writerId,
      leaseDurationMs: writer.leaseDurationMs,
      now,
    });
    if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
        `mapped projection registration lease is unavailable: ${claim.reason}.`,
      );
    }
    const fence: FencingContext = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now,
    };

    const registered: RegisteredTypedSheetsMappedProjection[] = [];
    for (const definition of definitions) {
      const result = await registerSyncSheetWithSql(sql, fence, definition.registration);
      if (result.kind !== "registered") {
        throw new TypedSheetsOrmError(
          TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
          `writer lease was lost while registering ${definition.projection.physicalSheetId}.`,
        );
      }
      registered.push({
        mapping: definition.mapping,
        sheet: result.sheet,
        headers: definition.headers,
      });
    }
    return registered;
  });
}

/** Converts registered mapping routes into gateway provisioning definitions. */
export function registeredTypedSheetsProjectionDefinitions(
  registrations: readonly RegisteredTypedSheetsMappedProjection[],
): readonly RegisteredSyncProjectionDefinition[] {
  return registrations.map(({ sheet, headers }) => ({ sheet, headers }));
}

function collectMappedChanges(
  mappings: TypedSheetsEntityMappingRegistry,
  changes: readonly TypedSheetsEntityChange[],
): readonly MappedChangePlan[] {
  const plans: MappedChangePlan[] = [];
  for (const change of changes) {
    const mapping = mappings.findByEntityName(change.entityName);
    if (mapping === undefined) continue;
    const changedFields = changedMappingFields(mapping, change);
    if (
      change.kind === TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE &&
      changedFields.length === 0
    ) continue;
    plans.push({ mapping, change, changedFields });
  }
  return plans;
}

function changedMappingFields(
  mapping: TypedSheetsEntityMapping,
  change: TypedSheetsEntityChange,
): readonly TypedSheetsEntityFieldMapping[] {
  if (change.kind !== TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE) return mapping.fields;
  if (hasOwn(change.payload, mapping.primaryKey)) {
    const nextPrimaryKey = change.payload[mapping.primaryKey];
    const entityId = typedSheetsEntityId(mapping, change.entity);
    if (nextPrimaryKey !== entityId) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_MUTATION,
        `${mapping.entityName}.${mapping.primaryKey} cannot change after it is mapped to Sheets.`,
      );
    }
  }
  return mapping.fields.filter((field) => hasOwn(change.payload, field.property));
}

function mappingRegistry(
  input: TypedSheetsEntityMappingRegistry | readonly TypedSheetsEntityMapping[],
): TypedSheetsEntityMappingRegistry {
  if ("findByEntityName" in input) return input;
  return createTypedSheetsEntityMappingRegistry(input);
}

function resolveWriterOptions(options: TypedSheetsEntityWriterOptions): ResolvedWriterOptions {
  if (options.writerId.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "mapped writer ID is required.",
    );
  }
  const role = options.role ?? DEFAULT_MAPPED_WRITER_ROLE;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_MAPPED_WRITER_LEASE_DURATION_MS;
  if (
    role.length === EMPTY_STRING_LENGTH_ZERO ||
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "mapped writer role and lease duration must be valid.",
    );
  }
  return {
    writerId: options.writerId,
    role,
    leaseDurationMs,
    now: options.now ?? (() => Date.now()),
    createId: options.createId ?? randomUUID,
    onTiming: options.onTiming,
  };
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
