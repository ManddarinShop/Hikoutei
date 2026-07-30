/**
 * Runtime adapter for the thin, generic Apps Script operation gateway.
 *
 * The current Code.gs exposes a generic signed operation dispatcher. Fast
 * append stays on its low-cost operation, while regular effects and recovery
 * reads use separate operations with their own typed decoders.
 */

import type {
  RegisteredSyncProjectionDefinition,
  SyncGatewayProvisionRoute,
  SyncGatewayProvisioner,
} from "../../../../../application/sync/gateway/SyncGatewayBootstrap.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "../../../../../application/sync/gateway/errors.js";
import {
  requireSyncGatewayNonEmptyList,
  requireSyncGatewayPositiveSafeInteger,
  requireSyncGatewayProjection,
  requireSyncGatewayText,
} from "../../../../../application/sync/gateway/validation.js";
import type {
  ApplySyncEffectsRequest,
  ApplySyncEffectsResult,
  EnsureSyncRowAnchorsRequest,
  EnsureSyncRowAnchorsResult,
  FastAppendRowsRequest,
  FastAppendRowsResult,
  ReadSyncEffectPostconditionsRequest,
  ReadSyncSnapshotRequest,
  SyncEffectPostcondition,
  SyncGatewayEffect,
  SyncGatewayEffectPostconditionResult,
  SyncGatewaySnapshot,
  SyncObservedSnapshot,
  SyncSheetGateway,
  SyncSheetObservationBatchGateway,
  SyncEffectWorkerFullGateway,
} from "../../../../../application/sync/gateway/syncGateway.js";
import { isRecord } from "../../../../../shared/encoding/typeGuards.js";
import type {
  AppsScriptOperationDefinition,
  AppsScriptOperationGateway,
} from "./operationClient.js";
import { createFastAppendRowsOperation } from "../operations/write/fastAppendOperation.js";
import {
  createApplyEffectsOperation,
  createReadEffectPostconditionOperation,
  createReadEffectPostconditionsOperation,
} from "../operations/effect/effectOperation.js";
import {
  createEnsureRowAnchorsOperation,
  createObserveSnapshotOperation,
  createReadSnapshotOperation,
} from "../operations/observation/observationOperation.js";
import { invalidOperationResponse } from "../errors.js";

/** Configuration required to bind the operation client to SQLite projections. */
export interface AppsScriptOperationSyncGatewayOptions {
  readonly operationGateway: AppsScriptOperationGateway;
  readonly definitions: readonly RegisteredSyncProjectionDefinition[];
}

type ProvisionedRoute = Omit<SyncGatewayProvisionRoute, "headers">;

interface ProvisionRegistryArgs {
  readonly registrations: readonly ProvisionRegistrationWire[];
}

interface ProvisionRegistrationWire {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: string;
  readonly schemaVersion: number;
  readonly headers: readonly string[];
  readonly identityField?: string;
  readonly checkboxHeaders?: readonly string[];
}

/**
 * Adapts the generic Apps Script operation transport to the sync worker's
 * fast and regular effect gateway boundaries.
 */
export class AppsScriptOperationSyncGateway
  implements
    SyncSheetGateway,
    SyncSheetObservationBatchGateway,
    SyncEffectWorkerFullGateway,
    SyncGatewayProvisioner {
  private readonly operationGateway: AppsScriptOperationGateway;
  private readonly definitions: readonly RegisteredSyncProjectionDefinition[];

  public constructor(options: AppsScriptOperationSyncGatewayOptions) {
    if (options.definitions.length === 0) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "Apps Script operation sync gateway requires a projection definition",
      );
    }
    this.operationGateway = options.operationGateway;
    this.definitions = options.definitions;
  }

  /**
   * Creates or verifies the registered tabs and their header rows remotely.
   *
   * The operation is idempotent: the remote source only creates missing tabs
   * and rejects a nonblank header row that differs from SQLite's schema.
   */
  public async provisionRegistry(
    registrations: readonly SyncGatewayProvisionRoute[],
  ): Promise<{
    readonly registrations: readonly ProvisionedRoute[];
    readonly createdSheets: readonly string[];
    readonly initializedHeaders: readonly string[];
  }> {
    requireSyncGatewayNonEmptyList(
      registrations,
      "Apps Script operation provisioning registrations",
      SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
    );
    const operation: AppsScriptOperationDefinition<
      ProvisionRegistryArgs,
      Awaited<ReturnType<SyncGatewayProvisioner["provisionRegistry"]>>
    > = {
      fn: PROVISION_SOURCE,
      args: {
        registrations: registrations.map(toProvisionRegistrationWire),
      },
      decode: decodeProvisionResult,
    };
    const [result] = await this.operationGateway.applyOperations([operation] as const);
    return result;
  }

  /**
   * Appends new System_State rows with one remote setValues operation.
   *
   * No row metadata, receipt, snapshot, CAS, or postcondition work is
   * performed here. Reconciliation owns drift detection after this write.
   */
  public async fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
    validateRoute(request, definition);
    const operation = createFastAppendRowsOperation({
      sheetName: request.sheetName,
      headers: definition.headers,
      rows: request.rows,
    });
    const [result] = await this.operationGateway.applyOperations([operation] as const);
    return result;
  }

  /** Applies regular update/delete effects through the full operation path. */
  public async applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
    validateRoute(request, definition);
    const operation = createApplyEffectsOperation({
      ...request,
      ...effectRouteOptions(definition),
    });
    const [result] = await this.operationGateway.applyOperations([operation] as const);
    return result;
  }

  /** Reads one regular-effect postcondition after an uncertain response. */
  public async readEffectPostcondition(
    effect: SyncGatewayEffect,
  ): Promise<SyncEffectPostcondition> {
    const definition = this.definitionForPhysicalSheet(effect.physicalSheetId);
    const request = {
      physicalSheetId: effect.physicalSheetId,
      sheetName: effect.payload.sheetName,
      registeredRange: effect.payload.registeredRange,
      projection: effect.projection,
      schemaVersion: effect.payload.schemaVersion,
      effect,
    };
    validateRoute(request, definition);
    const operation = createReadEffectPostconditionOperation({
      ...request,
      ...effectRouteOptions(definition),
    });
    const [result] = await this.operationGateway.applyOperations([operation] as const);
    return result;
  }

  /** Reads several regular-effect postconditions with one Sheet scan. */
  public async readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncGatewayEffectPostconditionResult[]> {
    const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
    validateRoute(request, definition);
    const operation = createReadEffectPostconditionsOperation({
      ...request,
      ...effectRouteOptions(definition),
    });
    const [result] = await this.operationGateway.applyOperations([operation] as const);
    return result;
  }

  /** Assigns missing row anchors through the observation operation. */
  public async ensureRowAnchors(
    request: EnsureSyncRowAnchorsRequest,
  ): Promise<EnsureSyncRowAnchorsResult> {
    const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
    validateRoute(request, definition);
    const operation = createEnsureRowAnchorsOperation({
      ...request,
      ...observationRouteOptions(definition),
    });
    const [result] = await this.operationGateway.applyOperations([operation] as const);
    return result;
  }

  /** Reads a normalized, anchor-aware snapshot for polling and reconciliation. */
  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot> {
    const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
    validateRoute(request, definition);
    const operation = createReadSnapshotOperation({
      ...request,
      ...observationRouteOptions(definition),
    });
    const [result] = await this.operationGateway.applyOperations([operation] as const);
    return result;
  }

  /** Reads one snapshot under one remote lock/request; User_Input skips metadata anchors. */
  public async observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot> {
    const [result] = await this.observeSnapshots([request]);
    if (result === undefined) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
        "Apps Script observation returned no result",
      );
    }
    return result;
  }

  /** Reads several projections through one signed Apps Script request. */
  public async observeSnapshots(
    requests: readonly ReadSyncSnapshotRequest[],
  ): Promise<readonly SyncObservedSnapshot[]> {
    const operations = requests.map((request) => {
      const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
      validateRoute(request, definition);
      return createObserveSnapshotOperation({
        ...request,
        ...observationRouteOptions(definition),
      });
    });
    if (operations.length === 0) return [];
    const results = await this.operationGateway.applyOperations(
      operations as readonly AppsScriptOperationDefinition<unknown, unknown>[],
    );
    return results as readonly SyncObservedSnapshot[];
  }

  private definitionForPhysicalSheet(
    physicalSheetId: string,
  ): RegisteredSyncProjectionDefinition {
    const definition = this.definitions.find(
      (candidate) => candidate.sheet.physicalSheetId === physicalSheetId,
    );
    if (definition === undefined) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "no projection definition exists for " + physicalSheetId,
      );
    }
    return definition;
  }
}

function toProvisionRegistrationWire(
  registration: SyncGatewayProvisionRoute,
): ProvisionRegistrationWire {
  return {
    sheetName: registration.sheetName,
    registeredRange: registration.registeredRange,
    projection: registration.projection,
    schemaVersion: registration.schemaVersion,
    headers: registration.headers,
    ...(registration.identityField === undefined
      ? {}
      : { identityField: registration.identityField }),
    ...(registration.checkboxHeaders === undefined
      ? {}
      : { checkboxHeaders: registration.checkboxHeaders }),
  };
}

function decodeProvisionResult(
  value: unknown,
): Awaited<ReturnType<SyncGatewayProvisioner["provisionRegistry"]>> {
  const record = requireRecord(value, "provisioning result");
  if (!Array.isArray(record.registrations)) {
    return invalidOperationResponse(
      "Apps Script operation",
      "provisioning registrations must be an array",
    );
  }
  return {
    registrations: record.registrations.map((entry, index) =>
      decodeProvisionedRoute(entry, index),
    ),
    createdSheets: requireStringArray(record.createdSheets, "provisioning createdSheets"),
    initializedHeaders: requireStringArray(
      record.initializedHeaders,
      "provisioning initializedHeaders",
    ),
  };
}

function decodeProvisionedRoute(value: unknown, index: number): ProvisionedRoute {
  const record = requireRecord(value, "provisioning registrations[" + index + "]");
  const identityField = optionalString(
    record.identityField,
    "provisioning registrations[" + index + "].identityField",
  );
  const checkboxHeaders = record.checkboxHeaders === undefined
    ? undefined
    : requireStringArray(
      record.checkboxHeaders,
      "provisioning registrations[" + index + "].checkboxHeaders",
    );
  return {
    sheetName: requireSyncGatewayText(
      record.sheetName,
      "provisioning registrations[" + index + "].sheetName",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    registeredRange: requireSyncGatewayText(
      record.registeredRange,
      "provisioning registrations[" + index + "].registeredRange",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    projection: requireSyncGatewayProjection(
      record.projection,
      "provisioning registrations[" + index + "].projection",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    schemaVersion: requireSyncGatewayPositiveSafeInteger(
      record.schemaVersion,
      "provisioning registrations[" + index + "].schemaVersion",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
    ...(identityField === undefined ? {} : { identityField }),
    ...(checkboxHeaders === undefined ? {} : { checkboxHeaders }),
  };
}

function requireStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    return invalidOperationResponse("Apps Script operation", label + " must be an array");
  }
  return value.map((entry, index) =>
    requireSyncGatewayText(
      entry,
      label + "[" + index + "]",
      SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    ),
  );
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireSyncGatewayText(
    value,
    label,
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
  );
}

function validateRoute(
  request: Pick<
    FastAppendRowsRequest,
    "physicalSheetId" | "sheetName" | "registeredRange" | "projection" | "schemaVersion"
  >,
  definition: RegisteredSyncProjectionDefinition,
): void {
  if (
    request.sheetName !== definition.sheet.tabName ||
    request.registeredRange !== definition.sheet.registeredRange ||
    request.projection !== definition.sheet.projection ||
    request.schemaVersion !== definition.sheet.schemaVersion
  ) {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "sync gateway request does not match the registered projection " +
      request.physicalSheetId,
    );
  }
}

function effectRouteOptions(
  definition: RegisteredSyncProjectionDefinition,
): {
  readonly identityField?: string;
  readonly checkboxHeaders?: readonly string[];
} {
  return {
    ...(definition.sheet.projection === "system_state" ||
      definition.sheet.projection === "user_input"
      ? { identityField: definition.sheet.businessKeyField }
      : {}),
    ...(definition.checkboxHeaders === undefined
      ? {}
      : { checkboxHeaders: definition.checkboxHeaders }),
  };
}

function observationRouteOptions(
  definition: RegisteredSyncProjectionDefinition,
): { readonly checkboxHeaders?: readonly string[] } {
  return definition.checkboxHeaders === undefined
    ? {}
    : { checkboxHeaders: definition.checkboxHeaders };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    return invalidOperationResponse("Apps Script operation", label + " must be an object");
  }
  return value as Record<string, unknown>;
}

const PROVISION_SOURCE = [
  "function (spreadsheet, args) {",
  "  if (!args || !Array.isArray(args.registrations) || args.registrations.length === 0) {",
  '    throw new Error("operational provisioning registrations are required");',
  "  }",
  "  var createdSheets = [];",
  "  var initializedHeaders = [];",
  "  args.registrations.forEach(function (registration) {",
  "    var sheet = spreadsheet.getSheetByName(registration.sheetName);",
  "    if (sheet === null) {",
  "      sheet = spreadsheet.insertSheet(registration.sheetName);",
  "      createdSheets.push(registration.sheetName);",
  "    }",
  "    if (sheet.getLastRow() === 0 && sheet.getLastColumn() === 0) {",
  "      sheet.getRange(1, 1, 1, registration.headers.length).setValues([registration.headers]);",
  "      initializedHeaders.push(registration.sheetName);",
  "      return;",
  "    }",
  "    var actual = sheet.getRange(1, 1, 1, registration.headers.length).getValues()[0];",
  "    for (var index = 0; index < registration.headers.length; index += 1) {",
  '      if (String(actual[index]) !== String(registration.headers[index])) {',
  '        throw new Error("operational provisioning header mismatch: " + registration.sheetName);',
  "      }",
  "    }",
  "  });",
  "  return {",
  "    registrations: args.registrations.map(function (registration) {",
  "      return {",
  "        sheetName: registration.sheetName,",
  "        registeredRange: registration.registeredRange,",
  "        projection: registration.projection,",
  "        schemaVersion: registration.schemaVersion,",
  "        identityField: registration.identityField,",
  "      };",
  "    }),",
  "    createdSheets: createdSheets,",
  "    initializedHeaders: initializedHeaders,",
  "  };",
  "}",
].join("\n");
