/** Internal service-side configuration for the SQLite/Sheets projection runtime. */

/** Physical tab and registered range used by one internal projection. */
export interface InternalSyncRoute {
  readonly tabName: string;
  readonly registeredRange: string;
}

/** Projection routes and field ownership for one declared entity. */
export interface InternalSyncEntityConfig {
  readonly systemState: InternalSyncRoute;
  readonly userInput?: InternalSyncRoute;
  /** Required system-owned audit projection for field-level conflicts. */
  readonly syncConflicts: InternalSyncRoute;
  /** Entity property names that may be changed from the User_Input projection. */
  readonly userOwnedFields?: readonly string[];
}

/**
 * Route and ownership configuration consumed only by the internal sync service.
 *
 * This type is intentionally not re-exported from `src/index.ts`: application
 * code uses entity lifecycle methods while the service owns Sheet credentials,
 * routes, and projection ownership.
 */
export interface InternalSyncProjectionConfig {
  readonly spreadsheetId: string;
  readonly entities: Readonly<Record<string, InternalSyncEntityConfig>>;
}
