/** Public construction options for the initial typed-sheets runtime. */

import type {
  TypedSheetsEntityClass,
} from "./contracts.js";
import type { RegisteredSyncProjectionDefinition } from "../../sync/gateway/SyncGatewayBootstrap.js";

/** Physical route information for one projection tab. */
export interface TypedSheetsSheetRouteOptions {
  readonly spreadsheetId: string;
  readonly tabName: string;
  readonly registeredRange: string;
  /** Stable route ID; derived from the logical ID when omitted. */
  readonly physicalSheetId?: string;
}

/** Sheet mapping for one public entity. */
export interface TypedSheetsEntitySyncOptions {
  readonly logicalSheetId?: string;
  readonly systemState: TypedSheetsSheetRouteOptions;
  readonly userInput?: TypedSheetsSheetRouteOptions;
  /** Fields that may be edited in User_Input; all scalar fields by default. */
  readonly editableFields?: readonly string[];
  /** Unique business key used to bind rows; defaults to the primary key. */
  readonly businessKey?: string;
  readonly schemaVersion?: number;
}

/** Separate Sheet projection configuration for the entity definitions. */
export interface TypedSheetsSyncOptions {
  readonly writerId: string;
  readonly entities: Readonly<Record<string, TypedSheetsEntitySyncOptions>>;
  /** Optional callback for remote Apps Script provisioning after local registration. */
  readonly onRegisteredProjections?: (
    definitions: readonly RegisteredSyncProjectionDefinition[],
  ) => Promise<void>;
}

/**
 * Opens the SQLite-authoritative entity runtime.
 *
 * Sheet routes are intentionally configured by the sync bootstrap boundary;
 * entity definitions themselves remain independent from physical tab names.
 */
export interface CreateTypedSheetsOptions {
  readonly dbName: string;
  readonly entities: readonly TypedSheetsEntityClass<object>[];
  /** Omit for an entity-only local runtime; provide to enable Sheet outbox planning. */
  readonly sync?: TypedSheetsSyncOptions;
}
