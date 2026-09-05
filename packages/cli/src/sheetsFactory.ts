/**
 * Human-owned spreadsheet provisioning for `hikoutei setup`.
 *
 * The setup CLI creates the sync spreadsheet as the logged-in human account
 * (service accounts cannot own Drive/Workspace assets) using the memory-only
 * access token obtained by the human auth step, then grants the freshly
 * provisioned service account writer access through the Drive API and
 * verifies Drive metadata: the active human must be the owner and the
 * service account must be a writer. The runtime itself stays service-account
 * only — the human token is never persisted.
 *
 * The create request does NOT carry a client-supplied id (Drive
 * `files.generateIds` ids cannot create Google Workspace files): instead the
 * flow generates a local opaque creation marker (a UUID) and the create
 * request carries it as a private `appProperties` entry in the same atomic
 * request. A lost response or failed create is reconciled by querying Drive
 * for that exact marker; the flow never retries the create from the started
 * state.
 *
 * Production implementations use google-auth-library plus @googleapis/drive;
 * tests inject a fake `HumanSheetApiFactory`, so unit tests never touch the
 * network. Every SDK response is treated as untrusted input and validated by
 * runtime guards before promotion.
 */

import { OAuth2Client } from "google-auth-library";
import { drive } from "@googleapis/drive";
import { isValidCreationMarker, isValidDriveId } from "./checkpoint.js";
import { httpStatusOf, safeError } from "./sdkError.js";

/** OAuth scope required to create and write spreadsheets. */
export const SPREADSHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/** Template for the human-facing spreadsheet edit URL. */
export const SPREADSHEET_EDIT_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/<id>/edit";

/** Drive MIME type of a Google Sheets spreadsheet. */
export const SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet" as const;

/** Private Drive `appProperties` key carrying the setup creation marker. */
export const HIKOUTEI_SETUP_MARKER_KEY = "hikouteiSetupMarker" as const;

/**
 * Drive fields requested from `drive.files.create` and the marker query.
 *
 * `appProperties` is requested so the create response can be validated
 * against the expected creation marker before the result is promoted; a
 * response that omits or contradicts the marker is a protocol error and the
 * outcome is reconciled by marker instead.
 */
export const DRIVE_FILE_CREATE_FIELDS = "id,name,mimeType,appProperties" as const;

/**
 * Drive fields requested from the creation-marker `drive.files.list`
 * pagination: every page carries `nextPageToken` so ALL pages are walked
 * before the flow decides 0/1/many over the complete result, and
 * `incompleteSearch` so a page the server could not fully search is
 * refused (a `true` value means the aggregate may be missing files, so the
 * flow must fail closed instead of trusting a partial lookup).
 */
export const MARKER_FILE_LIST_FIELDS =
  "files(id,name,mimeType,appProperties),nextPageToken,incompleteSearch" as const;

/** Page size for the creation-marker `drive.files.list` pagination. */
export const MARKER_FILE_LIST_PAGE_SIZE = 10;

/** Result of creating a spreadsheet as the human owner. */
export interface SpreadsheetCreateResult {
  readonly spreadsheetId: string;
}

/** One validated file returned by the creation-marker query. */
export interface MarkerFileInfo {
  readonly spreadsheetId: string;
  readonly name: string;
  readonly mimeType: string;
  /** Private appProperties; validated as a record when present. */
  readonly appProperties: Readonly<Record<string, unknown>>;
}

/** Result of ensuring the service account can write the spreadsheet. */
export interface ShareOutcome {
  readonly writerRole: "reused" | "upgraded" | "created";
}

/** Human-token sheet operations used by the setup flow. */
export interface HumanSheetApi {
  /**
   * Creates a spreadsheet owned by the human account with the expected
   * title and the creation marker as a private `appProperties` entry in the
   * same atomic request. No client-supplied id is used. Throws on API or
   * validation failure; the flow reconciles an unknown outcome by marker.
   */
  createSpreadsheet(request: { readonly title: string; readonly marker: string }): Promise<SpreadsheetCreateResult>;
  /**
   * Lists Drive files carrying the exact creation marker across ALL pages.
   *
   * Returns the validated matches aggregated from every `drive.files.list`
   * page (the flow enforces 0/1 over the complete result). Throws when the
   * lookup itself fails, so the flow treats the outcome as unknown and
   * never creates a second spreadsheet.
   */
  findSpreadsheetByMarker(marker: string): Promise<readonly MarkerFileInfo[]>;
  /**
   * Ensures the service account is a writer on the spreadsheet (reusing an
   * existing writer/owner role, upgrading a lower role, or creating the
   * permission without a notification email) and verifies that the active
   * human is the owner and the service account can write.
   */
  ensureSaWriter(request: {
    spreadsheetId: string;
    saEmail: string;
    ownerEmail: string;
  }): Promise<ShareOutcome>;
}

/**
 * Builds a `HumanSheetApi` for one run; the access token lives only in the
 * returned client for the duration of the run.
 */
export type HumanSheetApiFactory = (accessToken: string) => HumanSheetApi;

/** SDK-boundary auth types; contain the google-auth-library version cast here. */
type DriveAuth = NonNullable<Parameters<typeof drive>[0]["auth"]>;

/** Production factory: creates the human-token Sheets/Drive clients on demand. */
export function createHumanSheetApiFactory(): HumanSheetApiFactory {
  return (accessToken: string): HumanSheetApi => createHumanSheetApi(accessToken);
}

/**
 * Production human-token sheet API.
 *
 * Builds an OAuth2Client carrying the access token, then wraps the Drive
 * clients (create/get/permissions). The token is held in memory only;
 * errors are rethrown and the flow maps them to `sheet_create_failed`,
 * `sheet_create_uncertain`, or `sheet_share_failed` with sanitized reasons.
 */
export function createHumanSheetApi(accessToken: string): HumanSheetApi {
  const oauth = new OAuth2Client();
  oauth.setCredentials({ access_token: accessToken });
  const driveClient = drive({ version: "v3", auth: oauth as unknown as DriveAuth });
  return {
    async createSpreadsheet(request: { title: string; marker: string }): Promise<SpreadsheetCreateResult> {
      requireCreationMarker(request.marker);
      const response = await driveClient.files.create(buildDriveFileCreateRequest(request.title, request.marker));
      return extractDriveFileCreateResult(response.data, request.title, request.marker);
    },
    async findSpreadsheetByMarker(marker: string): Promise<readonly MarkerFileInfo[]> {
      return findMarkerFilesWithDrive(driveClient, marker);
    },
    async ensureSaWriter(request: {
      spreadsheetId: string;
      saEmail: string;
      ownerEmail: string;
    }): Promise<ShareOutcome> {
      requireDriveId(request.spreadsheetId);
      const outcome = await ensureSaWriterPermissionWithDrive(driveClient, request.spreadsheetId, request.saEmail);
      await verifyDriveOwnership(driveClient, request.spreadsheetId, request.ownerEmail, request.saEmail);
      return outcome;
    },
  };
}

/** Builds the public edit URL for a spreadsheet id. */
export function spreadsheetEditUrl(spreadsheetId: string): string {
  // The id is untrusted input at this boundary (it may come from a
  // checkpoint, an SDK payload, or a caller): refuse a malformed value
  // BEFORE interpolation so a newline/control/space id can never reach a
  // URL or a message. The error never includes the raw id.
  if (!isValidDriveId(spreadsheetId)) {
    throw safeError("a malformed spreadsheet id was refused before building the edit URL");
  }
  return SPREADSHEET_EDIT_URL_TEMPLATE.replace("<id>", spreadsheetId);
}

/**
 * Builds the atomic `drive.files.create` request for a spreadsheet.
 *
 * The request carries the creation marker as a private `appProperties`
 * entry in the same atomic request (no client-supplied id is ever used) and
 * asks for `appProperties` in the response fields so the result can be
 * validated against the marker before promotion.
 */
export function buildDriveFileCreateRequest(
  title: string,
  marker: string,
): {
  readonly requestBody: {
    readonly name: string;
    readonly mimeType: typeof SPREADSHEET_MIME_TYPE;
    readonly appProperties: { readonly [HIKOUTEI_SETUP_MARKER_KEY]: string };
  };
  readonly fields: typeof DRIVE_FILE_CREATE_FIELDS;
} {
  requireCreationMarker(marker);
  return {
    requestBody: {
      name: title,
      mimeType: SPREADSHEET_MIME_TYPE,
      appProperties: { [HIKOUTEI_SETUP_MARKER_KEY]: marker },
    },
    fields: DRIVE_FILE_CREATE_FIELDS,
  };
}

/**
 * Validates the raw `drive.files.create` payload.
 *
 * The created file's id must be a non-empty URL-safe Drive id, the mime
 * type must be `application/vnd.google-apps.spreadsheet`, the returned name
 * must match the requested title exactly, and the returned `appProperties`
 * must be a record whose `hikouteiSetupMarker` value equals the expected
 * marker exactly; anything else is a protocol violation and the outcome is
 * treated as unknown (the flow reconciles by marker, never by retrying the
 * create and never by promoting the response). The id is validated before
 * it can reach a URL, the `.env` file, a summary, or a command label. The
 * edit URL is derived from the id deterministically and never stored.
 */
export function extractDriveFileCreateResult(
  data: unknown,
  expectedTitle: string,
  expectedMarker: string,
): SpreadsheetCreateResult {
  if (!isRecord(data)) {
    throw safeError("drive.files.create returned a non-object payload");
  }
  const { id, name, mimeType, appProperties } = data;
  if (!isValidDriveId(id)) {
    throw safeError("drive.files.create response is missing or carries a malformed file id");
  }
  if (mimeType !== SPREADSHEET_MIME_TYPE) {
    throw safeError("drive.files.create returned a file that is not a spreadsheet");
  }
  if (typeof name !== "string" || name === "") {
    throw safeError("drive.files.create response is missing the file name");
  }
  if (name !== expectedTitle) {
    throw safeError("drive.files.create returned a file name that does not match the requested title");
  }
  // The marker is the write-ahead proof of identity: a response that omits
  // it, carries it malformed, or carries a different value cannot be trusted
  // to be OUR spreadsheet, so it is refused as a protocol violation. The
  // message never includes the marker or the title.
  if (!isRecord(appProperties)) {
    throw safeError("drive.files.create response is missing the appProperties marker");
  }
  if (appProperties[HIKOUTEI_SETUP_MARKER_KEY] !== expectedMarker) {
    throw safeError("drive.files.create returned appProperties that do not carry the expected marker");
  }
  return { spreadsheetId: id };
}

/** One validated `drive.files.list` page for a creation-marker query. */
export interface MarkerFileListPage {
  readonly files: readonly MarkerFileInfo[];
  /**
   * Opaque continuation token, validated as a non-empty string when the
   * untrusted payload carries one; `undefined` means the last page.
   */
  readonly nextPageToken: string | undefined;
  /**
   * Drive's completeness flag: the page is only promotable when the server
   * states the search was complete (`false`). A missing, `true`, or
   * malformed value fails closed — an incomplete search may hide files the
   * marker reconciliation depends on, so the flow must never decide 0/1
   * over a partial result.
   */
  readonly incompleteSearch: false;
}

/**
 * Validates one raw `drive.files.list` page payload for a creation-marker
 * query.
 *
 * Untrusted SDK data: every file entry must carry a non-empty URL-safe
 * `id`, non-empty `name` and `mimeType` strings, and `appProperties` (when
 * present) must be a record. The optional `nextPageToken` must be a
 * non-empty string when present; malformed payloads throw through the
 * sanitized structured path and never leak payload contents. Whether the
 * marker itself matches is decided by the flow, which also enforces
 * exactly one result before promotion.
 */
export function extractMarkerFileListPage(data: unknown): MarkerFileListPage {
  if (!isRecord(data)) {
    throw safeError("drive.files.list returned a non-object payload");
  }
  const { files, nextPageToken, incompleteSearch } = data;
  if (!Array.isArray(files)) {
    throw safeError("drive.files.list response is missing the file list");
  }
  if (incompleteSearch !== false) {
    // A missing, `true`, or malformed completeness flag means the server
    // could not fully search the corpus: the aggregated result may be
    // missing files, so the reconciliation fails closed (the flow treats
    // the create outcome as `sheet_create_uncertain` — never a rollback
    // and never a second create). The raw value is never echoed.
    throw safeError("drive.files.list returned an incomplete search result");
  }
  if (nextPageToken !== undefined && (typeof nextPageToken !== "string" || nextPageToken === "")) {
    throw safeError("drive.files.list returned a malformed continuation token");
  }
  return {
    files: files.map((entry, index) => {
      if (!isRecord(entry)) {
        throw safeError(`marker query file entry ${index} is not an object`);
      }
      const { id, name, mimeType, appProperties } = entry;
      if (!isValidDriveId(id)) {
        throw safeError(`marker query file entry ${index} is missing or carries a malformed id`);
      }
      if (typeof name !== "string" || name === "") {
        throw safeError(`marker query file entry ${index} is missing name`);
      }
      if (typeof mimeType !== "string" || mimeType === "") {
        throw safeError(`marker query file entry ${index} is missing mimeType`);
      }
      if (appProperties !== undefined && !isRecord(appProperties)) {
        throw safeError(`marker query file entry ${index} has malformed appProperties`);
      }
      return { spreadsheetId: id, name, mimeType, appProperties: appProperties ?? {} };
    }),
    nextPageToken: nextPageToken === undefined ? undefined : nextPageToken,
    incompleteSearch: false,
  };
}

/**
 * Validates the raw `drive.files.list` payload for a creation-marker query
 * (single page).
 *
 * Untrusted SDK data: every file entry must carry a non-empty URL-safe
 * `id`, non-empty `name` and `mimeType` strings, and `appProperties` (when
 * present) must be a record. The paginating marker lookup uses
 * `extractMarkerFileListPage`; this wrapper is kept for callers that never
 * paginate.
 */
export function extractMarkerFileList(data: unknown): readonly MarkerFileInfo[] {
  return [...extractMarkerFileListPage(data).files];
}

/** Rejects a malformed creation marker before it reaches the Drive API. */
function requireCreationMarker(marker: string): void {
  if (!isValidCreationMarker(marker)) {
    throw safeError("a malformed creation marker was refused before reaching the Drive API");
  }
}

/** Rejects a malformed Drive id before it reaches the Drive API. */
function requireDriveId(id: string): void {
  if (!isValidDriveId(id)) {
    throw safeError("a malformed Drive id was refused before reaching the Drive API");
  }
}

/**
 * A validated Drive permission entry.
 *
 * `emailAddress` is required only for identity-carrying types (`user`,
 * `group`): Google omits it for `anyone`, `anyoneWithLink`, and `domain`
 * permissions, so those entries promote without it and are safely ignored
 * by writer planning.
 */
export type DrivePermission =
  | {
    readonly id: string;
    readonly role: string;
    readonly type: "user" | "group";
    readonly emailAddress: string;
  }
  | {
    readonly id: string;
    readonly role: string;
    readonly type: string;
    readonly emailAddress: undefined;
  };

/** The id of an existing Drive permission entry. */
export type DrivePermissionId = string;

/**
 * Decides the idempotent writer-ensure action for the service account.
 *
 * Pure decision helper so tests can cover reuse/upgrade/create without the
 * network: an existing user permission with writer/owner role is reused, a
 * lower role is upgraded, and a missing permission is created. Entries of
 * other types (anyone/domain/group) are ignored safely.
 */
export type SaWriterPlan =
  | { readonly action: "reuse" }
  | { readonly action: "upgrade"; readonly permissionId: DrivePermissionId }
  | { readonly action: "create" };

export function planSaWriterAction(
  permissions: readonly DrivePermission[],
  saEmail: string,
): SaWriterPlan {
  const existing = permissions.find(
    (permission) => permission.type === "user" && permission.emailAddress === saEmail,
  );
  if (existing === undefined) {
    return { action: "create" };
  }
  if (existing.role === "writer" || existing.role === "owner") {
    return { action: "reuse" };
  }
  return { action: "upgrade", permissionId: existing.id };
}

/**
 * Validates the raw `permissions.list` payload (single page).
 *
 * Untrusted SDK data: every entry must carry a non-empty URL-safe id, a
 * non-empty role and type; entries of type `user`/`group` must additionally
 * carry a non-empty emailAddress, while other types (where Google omits the
 * identity) promote without it. The paginating writer ensure uses
 * `extractPermissionListPage`; this wrapper is kept for callers that never
 * paginate (the ownership-check file metadata).
 */
export function extractPermissionList(data: unknown): DrivePermission[] {
  return [...extractPermissionListPage(data).permissions];
}

/** Validated Drive file metadata used for the ownership check. */
export interface DriveFileMetadata {
  readonly ownerEmails: readonly string[];
  readonly permissions: readonly DrivePermission[];
}

/**
 * Validates the raw `drive.files.get` payload for the ownership check.
 *
 * Untrusted SDK data: the response must carry the expected URL-safe file
 * id (a mismatched or malformed id means the metadata belongs to a
 * different file and the check must fail), `owners` must be an array of
 * objects with a non-empty `emailAddress`, and `permissions` must validate
 * like a `permissions.list` payload.
 */
export function extractDriveFileMetadata(data: unknown, expectedSpreadsheetId: string): DriveFileMetadata {
  if (!isRecord(data)) {
    throw safeError("drive.files.get returned a non-object payload");
  }
  const { id, owners, permissions } = data;
  if (id !== expectedSpreadsheetId || !isValidDriveId(id)) {
    throw safeError("drive.files.get returned metadata for a different file");
  }
  if (!Array.isArray(owners)) {
    throw safeError("drive.files.get response is missing the owner list");
  }
  const ownerEmails = owners.map((owner) => {
    if (!isRecord(owner)) {
      throw safeError("an owner entry is not an object");
    }
    const { emailAddress } = owner;
    if (typeof emailAddress !== "string" || emailAddress === "") {
      throw safeError("an owner entry is missing emailAddress");
    }
    return emailAddress;
  });
  return { ownerEmails, permissions: extractPermissionList({ permissions }) };
}

const PERMISSION_LIST_FIELDS = "permissions(id,emailAddress,role,type),nextPageToken";
const FILE_VERIFY_FIELDS = "id,owners(emailAddress),permissions(id,emailAddress,role,type)";

/**
 * Hard bound on the number of `permissions.list` pages the writer ensure
 * will follow before failing closed.
 *
 * Spreadsheet permission lists are tiny in practice; the bound exists so a
 * hostile or broken API can never make the ensure loop forever with an
 * ever-changing sequence of distinct continuation tokens (the seen-token
 * guard already stops repeated tokens).
 */
export const MAX_PERMISSION_LIST_PAGES = 50;

/**
 * Hard bound on the number of `drive.files.list` pages the creation-marker
 * lookup will follow before failing closed, consistent with the permission
 * pagination bound. The bound exists so a hostile or broken API can never
 * make the lookup loop forever with an ever-changing sequence of distinct
 * continuation tokens (the seen-token guard already stops repeated tokens).
 */
export const MAX_MARKER_FILE_LIST_PAGES = 50;

/** One validated `permissions.list` page. */
export interface PermissionListPage {
  readonly permissions: readonly DrivePermission[];
  /**
   * Opaque continuation token, validated as a non-empty string when the
   * untrusted payload carries one; `undefined` means the last page.
   */
  readonly nextPageToken: string | undefined;
}

/**
 * Validates one raw `permissions.list` page payload.
 *
 * Untrusted SDK data: every entry must carry a non-empty URL-safe id, a
 * non-empty role and type; entries of type `user`/`group` must additionally
 * carry a non-empty emailAddress, while other types (where Google omits the
 * identity) promote without it. The optional `nextPageToken` must be a
 * non-empty string when present. Malformed payloads throw through the
 * sanitized structured path and never leak payload contents.
 */
export function extractPermissionListPage(data: unknown): PermissionListPage {
  if (!isRecord(data)) {
    throw safeError("permissions.list returned a non-object payload");
  }
  const { permissions, nextPageToken } = data;
  if (!Array.isArray(permissions)) {
    throw safeError("permissions.list response is missing the permission list");
  }
  if (nextPageToken !== undefined && (typeof nextPageToken !== "string" || nextPageToken === "")) {
    throw safeError("permissions.list returned a malformed continuation token");
  }
  return {
    permissions: permissions.map((entry, index) => {
      if (!isRecord(entry)) {
        throw safeError(`permission entry ${index} is not an object`);
      }
      const { id, emailAddress, role, type } = entry;
      if (!isValidDriveId(id)) {
        throw safeError(`permission entry ${index} is missing or carries a malformed id`);
      }
      if (typeof role !== "string" || role === "") {
        throw safeError(`permission entry ${index} is missing role`);
      }
      if (typeof type !== "string" || type === "") {
        throw safeError(`permission entry ${index} is missing type`);
      }
      if (type === "user" || type === "group") {
        if (typeof emailAddress !== "string" || emailAddress === "") {
          throw safeError(`permission entry ${index} of type ${type} is missing emailAddress`);
        }
        return { id, role, type, emailAddress };
      }
      return { id, role, type, emailAddress: undefined };
    }),
    nextPageToken: nextPageToken === undefined ? undefined : nextPageToken,
  };
}

/**
 * The injectable Drive permission boundary used by the writer ensure.
 *
 * Production wraps the @googleapis/drive permissions resource; tests inject
 * a fake so pagination, cycle guards, and request fields are exercised
 * without the network. Every response `data` is treated as untrusted input
 * and validated by runtime guards before promotion.
 */
export interface DrivePermissionApi {
  list(request: {
    fileId: string;
    fields: string;
    pageToken?: string;
  }): Promise<{ readonly data: unknown }>;
  update(request: {
    fileId: string;
    permissionId: string;
    requestBody: { readonly role: "writer" };
  }): Promise<unknown>;
  create(request: {
    fileId: string;
    requestBody: { readonly type: "user"; readonly role: "writer"; readonly emailAddress: string };
    sendNotificationEmail: false;
  }): Promise<unknown>;
}

/**
 * Collects every permission of a file across ALL `permissions.list` pages.
 *
 * Follows `nextPageToken` until it is absent, requesting the fields that
 * include the token. Fails closed on a malformed page payload or
 * continuation token, on a repeated token (cycle guard — a non-progress
 * loop can never spin), and on the hard page bound; API errors propagate
 * through the sanitized structured path. The file id is validated before
 * it reaches the API.
 */
export async function listAllDrivePermissions(
  api: Pick<DrivePermissionApi, "list">,
  spreadsheetId: string,
): Promise<readonly DrivePermission[]> {
  requireDriveId(spreadsheetId);
  const all: DrivePermission[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PERMISSION_LIST_PAGES) {
      throw safeError("permissions.list pagination exceeded the page limit; refusing to continue");
    }
    const response = await api.list({
      fileId: spreadsheetId,
      fields: PERMISSION_LIST_FIELDS,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    const pageResult = extractPermissionListPage(response.data);
    all.push(...pageResult.permissions);
    const next = pageResult.nextPageToken;
    if (next === undefined) {
      return all;
    }
    if (seenTokens.has(next)) {
      throw safeError("permissions.list pagination repeated a continuation token; refusing to continue");
    }
    seenTokens.add(next);
    pageToken = next;
  }
}

/**
 * The injectable Drive file-list boundary used by the creation-marker
 * lookup.
 *
 * Production wraps the @googleapis/drive files resource; tests inject a
 * fake so pagination, cycle guards, and request fields are exercised
 * without the network. Every response `data` is treated as untrusted input
 * and validated by runtime guards before promotion.
 */
export interface DriveFileListApi {
  list(request: {
    q: string;
    spaces: string;
    fields: string;
    pageSize: number;
    pageToken?: string;
  }): Promise<{ readonly data: unknown }>;
}

/**
 * Collects every Drive file carrying the exact creation marker across ALL
 * `drive.files.list` pages.
 *
 * Follows `nextPageToken` until it is absent, requesting the fields that
 * include the token. Fails closed on a malformed page payload or
 * continuation token, on a repeated token (cycle guard — a non-progress
 * loop can never spin), and on the hard page bound; API errors propagate
 * through the sanitized structured path. The marker is validated before it
 * reaches the API. All pages are aggregated before the result is returned,
 * so the flow's 0/1/many reconciliation sees the COMPLETE result: a
 * duplicate exact marker hidden after a short first page can never be
 * mistaken for a clean single match.
 */
export async function listAllMarkerFiles(
  api: Pick<DriveFileListApi, "list">,
  marker: string,
): Promise<readonly MarkerFileInfo[]> {
  requireCreationMarker(marker);
  const all: MarkerFileInfo[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_MARKER_FILE_LIST_PAGES) {
      throw safeError("drive.files.list pagination exceeded the page limit; refusing to continue");
    }
    const response = await api.list({
      q: `appProperties has { key='${HIKOUTEI_SETUP_MARKER_KEY}' and value='${marker}' }`,
      spaces: "drive",
      fields: MARKER_FILE_LIST_FIELDS,
      pageSize: MARKER_FILE_LIST_PAGE_SIZE,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    const pageResult = extractMarkerFileListPage(response.data);
    all.push(...pageResult.files);
    const next = pageResult.nextPageToken;
    if (next === undefined) {
      return all;
    }
    if (seenTokens.has(next)) {
      throw safeError("drive.files.list pagination repeated a continuation token; refusing to continue");
    }
    seenTokens.add(next);
    pageToken = next;
  }
}

/**
 * Production adapter: the creation-marker lookup over the @googleapis/drive
 * files resource.
 */
async function findMarkerFilesWithDrive(
  driveClient: ReturnType<typeof drive>,
  marker: string,
): Promise<readonly MarkerFileInfo[]> {
  const files = driveClient.files;
  return listAllMarkerFiles(
    {
      list: (request) => files.list(request),
    },
    marker,
  );
}

/** Grants or reuses the service-account writer permission; returns the outcome. */
export async function ensureSaWriterPermission(
  api: DrivePermissionApi,
  spreadsheetId: string,
  saEmail: string,
): Promise<ShareOutcome> {
  const permissions = await listAllDrivePermissions(api, spreadsheetId);
  const plan = planSaWriterAction(permissions, saEmail);
  switch (plan.action) {
    case "reuse":
      return { writerRole: "reused" };
    case "upgrade":
      await api.update({
        fileId: spreadsheetId,
        permissionId: plan.permissionId,
        requestBody: { role: "writer" },
      });
      return { writerRole: "upgraded" };
    case "create":
      await api.create({
        fileId: spreadsheetId,
        requestBody: { type: "user", role: "writer", emailAddress: saEmail },
        sendNotificationEmail: false,
      });
      return { writerRole: "created" };
  }
}

/**
 * Production adapter: the writer ensure over the @googleapis/drive
 * permissions resource.
 */
async function ensureSaWriterPermissionWithDrive(
  driveClient: ReturnType<typeof drive>,
  spreadsheetId: string,
  saEmail: string,
): Promise<ShareOutcome> {
  const permissions = driveClient.permissions;
  return ensureSaWriterPermission(
    {
      list: (request) => permissions.list(request),
      update: (request) => permissions.update(request),
      create: (request) => permissions.create(request),
    },
    spreadsheetId,
    saEmail,
  );
}

/**
 * Verifies Drive metadata after sharing.
 *
 * Fails the share step when the active human is not an owner or the service
 * account is not a writer/owner — the state the sync runtime depends on.
 */
async function verifyDriveOwnership(
  driveClient: ReturnType<typeof drive>,
  spreadsheetId: string,
  ownerEmail: string,
  saEmail: string,
): Promise<void> {
  const response = await driveClient.files.get({
    fileId: spreadsheetId,
    fields: FILE_VERIFY_FIELDS,
  });
  const metadata = extractDriveFileMetadata(response.data, spreadsheetId);
  if (!metadata.ownerEmails.includes(ownerEmail)) {
    throw safeError(`the active account ${ownerEmail} is not an owner of the spreadsheet`);
  }
  const saCanWrite = metadata.permissions.some(
    (permission) =>
      permission.emailAddress === saEmail &&
      (permission.role === "writer" || permission.role === "owner"),
  );
  if (!saCanWrite) {
    throw safeError(`the service account ${saEmail} is not a writer on the spreadsheet`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
