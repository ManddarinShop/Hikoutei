/**
 * Thin Sheet I/O dispatcher for the typed-sheets sync runtime.
 *
 * This is the v2 data plane. It deliberately contains no business logic, no
 * compare-and-set, no receipts, and no outbox awareness. The Node worker is
 * the sole decision maker; this gateway only executes signed, range-constrained
 * Sheet operations that the worker already planned.
 *
 * This is the only supported Apps Script gateway source. The former full
 * gateway implementation is no longer shipped with the package.
 */

var GATEWAY_SHEET_ID_PROPERTY_ = "TYPED_SHEETS_GATEWAY_SHEET_ID";
var GATEWAY_SHARED_SECRET_PROPERTY_ = "TYPED_SHEETS_GATEWAY_SHARED_SECRET";
var LEGACY_GATEWAY_SHEET_ID_PROPERTY_ = "TYPED_SHEETS_MVP_SHEET_ID";
var LEGACY_GATEWAY_SHARED_SECRET_PROPERTY_ = "TYPED_SHEETS_MVP_SHARED_SECRET";
var GATEWAY_MAX_CLOCK_SKEW_MS_ = 60 * 1000;
var GATEWAY_MAX_REQUEST_LIFETIME_MS_ = 10 * 60 * 1000;
var GATEWAY_LOCK_TIMEOUT_MS_ = 20 * 1000;

var SYNC_PROTOCOL_VERSION_ = "typed-sheets-sync-v1";

// Operations accepted by the v2 data plane. Each operation carries its own
// serialised function body plus the args that function needs. Adding a new
// operation requires only that the Node worker send a recognised opKind and a
// self-contained function string; this list is the allowlist of opKind values.
var SYNC_OPERATIONS_ = {
  applyOperations: true,
};

/** Web-app entry point. Every useful operation must be a signed POST. */
function doPost(event) {
  try {
    return jsonOutput_(handlePost_(event));
  } catch (error) {
    return jsonOutput_(failure_("internal_error", safeErrorMessage_(error)));
  }
}

/** Rejects unauthenticated GET calls instead of exposing spreadsheet metadata. */
function doGet() {
  return jsonOutput_(failure_("method_not_allowed", "Use a signed POST request."));
}

// Paste the deployed /exec URL here, then run setupSyncGateway() from the
// Apps Script editor. It is never reachable through doPost().
var TYPED_SHEETS_GATEWAY_URL = "";

/**
 * Configures this bound spreadsheet for the sync gateway.
 *
 * Run this manually from the Apps Script editor after deploying the web app.
 * It reads the deployed `/exec` URL from TYPED_SHEETS_GATEWAY_URL above,
 * generates a shared secret only when one is absent, and logs a copyable local
 * `.env` block. It is never reachable through doPost(), so the secret is not
 * exposed by the public gateway.
 *
 * @returns {object} Local runner config.
 */
function setupSyncGateway() {
  var config = configureSyncGateway_(TYPED_SHEETS_GATEWAY_URL);
  Logger.log(config.localEnv);
  return config;
}

/**
 * Saves the allowlisted sheet ID and shared secret under a script lock so two
 * manual setup executions cannot accidentally rotate the generated secret.
 */
function configureSyncGateway_(gatewayUrl) {
  var normalizedGatewayUrl = requireSyncGatewayUrl_(gatewayUrl);
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (spreadsheet === null) {
    throw new Error("setupSyncGateway() must run from the bound spreadsheet's Apps Script project.");
  }

  var sheetId = spreadsheet.getId();
  if (!isNonEmptyString_(sheetId)) {
    throw new Error("Could not resolve the bound disposable spreadsheet ID.");
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(GATEWAY_LOCK_TIMEOUT_MS_)) {
    throw new Error("Could not acquire the sync gateway setup lock.");
  }

  try {
    var properties = PropertiesService.getScriptProperties();
    var existingSecret = properties.getProperty(GATEWAY_SHARED_SECRET_PROPERTY_) ||
      properties.getProperty(LEGACY_GATEWAY_SHARED_SECRET_PROPERTY_);
    var sharedSecret = isNonEmptyString_(existingSecret) ? existingSecret : createSyncGatewaySharedSecret_();

    properties.setProperty(GATEWAY_SHEET_ID_PROPERTY_, sheetId);
    properties.setProperty(GATEWAY_SHARED_SECRET_PROPERTY_, sharedSecret);

    return {
      gatewayUrl: normalizedGatewayUrl,
      sheetId: sheetId,
      sharedSecret: sharedSecret,
      localEnv: formatSyncGatewayLocalEnv_(normalizedGatewayUrl, sharedSecret, sheetId),
    };
  } finally {
    lock.releaseLock();
  }
}

/** Validates a deployed Apps Script Web App URL before it is copied locally. */
function requireSyncGatewayUrl_(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Paste a deployed Apps Script Web App URL ending in /exec before running setupSyncGateway().");
  }

  var gatewayUrl = value.trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/?#]+\/exec$/.test(gatewayUrl)) {
    throw new Error("Sync gateway URL must be a deployed Apps Script Web App URL ending in /exec.");
  }
  return gatewayUrl;
}

/** Generates a long URL-safe secret only for the trusted editor setup path. */
function createSyncGatewaySharedSecret_() {
  return Utilities.getUuid().replace(/-/g, "") + Utilities.getUuid().replace(/-/g, "");
}

/** Formats the exact local environment values consumed by the Node sync runners. */
function formatSyncGatewayLocalEnv_(gatewayUrl, sharedSecret, sheetId) {
  return [
    "# Keep this untracked. The shared secret grants gateway access.",
    "TYPED_SHEETS_GATEWAY_URL=" + JSON.stringify(gatewayUrl),
    "TYPED_SHEETS_GATEWAY_SHARED_SECRET=" + JSON.stringify(sharedSecret),
    "TYPED_SHEETS_GATEWAY_SHEET_ID=" + JSON.stringify(sheetId),
  ].join("\n");
}


function handlePost_(event) {
  if (!event || !event.postData || typeof event.postData.contents !== "string") {
    return failure_("invalid_request", "Expected a JSON POST body.");
  }

  var envelope;
  try {
    envelope = JSON.parse(event.postData.contents);
  } catch (error) {
    return failure_("invalid_json", "Request body is not valid JSON.");
  }

  if (!isPlainObject_(envelope) || envelope.protocolVersion !== SYNC_PROTOCOL_VERSION_) {
    return failure_("unsupported_protocol", "Unsupported sync protocol version.");
  }

  var validation = validateSyncEnvelope_(envelope);
  if (validation.failure !== null) return validation.failure;

  if (envelope.operation === "applyOperations") {
    return applyOperations_(envelope);
  }
  return failure_("unsupported_operation", "Sync operation is not implemented.");
}

/**
 * Executes one signed batch of Sheet operations.
 *
 * Each operation carries:
 *   - opKind: an allowlisted label (currently unused for dispatch, reserved for
 *             future per-op validation), and
 *   - fn:     the function body as a string, of the form
 *             (spreadsheet, args) => result, and
 *   - args:   a JSON-serialisable payload passed as the second argument.
 *
 * The function is evaluated in this request's global context, so it may call
 * SpreadsheetApp/Utilities just like any other Apps Script code. It must not
 * rely on any external closure, because only the body text crosses the wire.
 *
 * A single SpreadsheetApp.flush() is issued after all operations have run, so
 * a multi-operation request applies atomically from the Sheet's perspective.
 */
function applyOperations_(envelope) {
  var payload = envelope.payload;
  if (!isPlainObject_(payload) || !Array.isArray(payload.operations)) {
    return failure_("invalid_payload", "applyOperations payload must contain an operations array.");
  }

  var spreadsheet;
  try {
    spreadsheet = SpreadsheetApp.openById(envelope.sheetId);
  } catch (error) {
    return failure_("sheet_open_failed", "Configured sync spreadsheet could not be opened.");
  }

  var results = [];
  for (var index = 0; index < payload.operations.length; index += 1) {
    var operation = payload.operations[index];
    try {
      var operationStartedAt = Date.now();
      var operationResult = runOneOperation_(spreadsheet, operation);
      appendGatewayTimingPhase_(operationResult, "dispatcher_eval", Date.now() - operationStartedAt);
      results.push(operationResult);
    } catch (error) {
      // Stop at the first failing operation so the worker can retry the whole
      // signed batch idempotently. Partial results are returned for diagnosis.
      return failure_("operation_failed", "Operation " + index + " failed: " + safeErrorMessage_(error));
    }
  }

  var flushStartedAt = Date.now();
  SpreadsheetApp.flush();
  var flushDurationMs = Date.now() - flushStartedAt;
  results.forEach(function (result) {
    appendGatewayTimingPhase_(result, "dispatcher_flush", flushDurationMs);
  });
  return success_({ results: results });
}

/** Adds dispatcher timing without requiring older dynamic operations to know the contract. */
function appendGatewayTimingPhase_(result, phase, durationMs) {
  if (!isPlainObject_(result)) return;
  if (!isPlainObject_(result.timing)) {
    result.timing = {
      operationKinds: [],
      operationCounts: { append: 0, update: 0, delete: 0 },
      durationMs: 0,
      phases: [],
    };
  }
  if (!Array.isArray(result.timing.phases)) result.timing.phases = [];
  result.timing.phases.push({ phase: phase, durationMs: durationMs });
  result.timing.durationMs = Number(result.timing.durationMs) + durationMs;
}

/** Restores one operation function from its serialised body and runs it. */
function runOneOperation_(spreadsheet, operation) {
  if (!isPlainObject_(operation) || typeof operation.fn !== "string" || operation.fn.length === 0) {
    throw new Error("operation must be an object with a non-empty fn string");
  }
  // The function body is restored in this request scope. Eval is safe here
  // because the enclosing envelope was HMAC-signed; an attacker who cannot
  // sign requests cannot inject code.
  var fn;
  try {
    fn = eval("(" + operation.fn + ")");
  } catch (error) {
    throw new Error("operation fn could not be restored: " + safeErrorMessage_(error));
  }
  if (typeof fn !== "function") {
    throw new Error("operation fn did not evaluate to a function");
  }
  return fn(spreadsheet, operation.args);
}

// ---------------------------------------------------------------------------
// Envelope validation (preserved from v1 so the trust boundary is unchanged)
// ---------------------------------------------------------------------------

/** Validates the sync envelope and resolves the configured spreadsheet id. */
function validateSyncEnvelope_(envelope) {
  if (!isPlainObject_(envelope)) {
    return { failure: failure_("invalid_envelope", "Envelope must be a JSON object.") };
  }
  if (envelope.protocolVersion !== SYNC_PROTOCOL_VERSION_) {
    return { failure: failure_("unsupported_protocol", "Unsupported sync protocol version.") };
  }
  if (!isNonEmptyString_(envelope.requestId) || !/^[A-Za-z0-9._:-]{8,128}$/.test(envelope.requestId)) {
    return { failure: failure_("invalid_request_id", "Request ID must be 8-128 URL-safe characters.") };
  }
  if (!isNonEmptyString_(envelope.operation) || !SYNC_OPERATIONS_[envelope.operation]) {
    return { failure: failure_("unsupported_operation", "Operation is not allowlisted.") };
  }
  if (!isNonEmptyString_(envelope.keyId) || !isNonEmptyString_(envelope.sheetId) ||
      !isNonEmptyString_(envelope.actorId) || !isNonEmptyString_(envelope.bodyHash) ||
      !isNonEmptyString_(envelope.signature)) {
    return { failure: failure_("invalid_envelope", "Sync envelope is missing an authenticated field.") };
  }
  if (!isPositiveSafeInteger_(envelope.issuedAt) || !isPositiveSafeInteger_(envelope.expiresAt)) {
    return { failure: failure_("invalid_time", "issuedAt and expiresAt must be positive epoch milliseconds.") };
  }
  var now = Date.now();
  if (envelope.issuedAt > now + GATEWAY_MAX_CLOCK_SKEW_MS_ || envelope.expiresAt < now ||
      envelope.expiresAt <= envelope.issuedAt ||
      envelope.expiresAt - envelope.issuedAt > GATEWAY_MAX_REQUEST_LIFETIME_MS_) {
    return { failure: failure_("invalid_expiry", "Sync envelope is expired or outside the allowed lifetime.") };
  }
  var gateway = readGatewayConfiguration_();
  if (gateway === null) {
    return { failure: failure_("gateway_not_configured", "Required Script Properties are not configured.") };
  }
  if (gateway.sheetId !== envelope.sheetId) {
    return { failure: failure_("sheet_not_allowlisted", "Envelope sheetId is not the configured spreadsheet.") };
  }
  if (envelope.keyId !== "typed-sheets-shared-secret-v1") {
    return { failure: failure_("unknown_key", "Sync keyId is not configured.") };
  }
  var actualBodyHash;
  try {
    actualBodyHash = sha256Hex_(canonicalJson_(envelope.payload));
  } catch (error) {
    return { failure: failure_("invalid_payload", safeErrorMessage_(error)) };
  }
  if (!constantTimeEquals_(actualBodyHash, envelope.bodyHash)) {
    return { failure: failure_("body_hash_mismatch", "Payload does not match the signed body hash.") };
  }
  if (!constantTimeEquals_(
    hmacSha256Base64Url_(syncSigningInput_(envelope), gateway.sharedSecret),
    envelope.signature,
  )) {
    return { failure: failure_("invalid_signature", "Sync envelope signature could not be verified.") };
  }
  return { failure: null };
}

/** HMAC material for typed-sheets-sync-v1; actor/sheet/key are authenticated too. */
function syncSigningInput_(envelope) {
  return [
    envelope.protocolVersion,
    envelope.requestId,
    envelope.operation,
    envelope.keyId,
    String(envelope.issuedAt),
    String(envelope.expiresAt),
    envelope.sheetId,
    envelope.actorId,
    envelope.bodyHash,
  ].join("\n");
}

/** Reads the configured gateway identity, accepting one prior property namespace during migration. */
function readGatewayConfiguration_() {
  var properties = PropertiesService.getScriptProperties();
  var sheetId = properties.getProperty(GATEWAY_SHEET_ID_PROPERTY_) ||
    properties.getProperty(LEGACY_GATEWAY_SHEET_ID_PROPERTY_);
  var sharedSecret = properties.getProperty(GATEWAY_SHARED_SECRET_PROPERTY_) ||
    properties.getProperty(LEGACY_GATEWAY_SHARED_SECRET_PROPERTY_);
  if (!isNonEmptyString_(sheetId) || !isNonEmptyString_(sharedSecret)) return null;
  return { sheetId: sheetId, sharedSecret: sharedSecret };
}

// ---------------------------------------------------------------------------
// Shared encoding / hashing helpers (preserved from v1)
// ---------------------------------------------------------------------------

function canonicalJson_(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!isFinite(value)) throw new Error("Sync payload numbers must be finite");
    return (value === 0 ? "0" : String(value)).replace(/e\+/, "e").replace(/e(-?)0+(\d+)/, "e$1$2");
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson_).join(",") + "]";
  }
  if (isPlainObject_(value)) {
    return "{" + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ":" + canonicalJson_(value[key]);
    }).join(",") + "}";
  }
  throw new Error("Sync payload has unsupported value type");
}

function sha256Hex_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
    .map(function (byte) {
      var unsigned = byte < 0 ? byte + 256 : byte;
      return ("0" + unsigned.toString(16)).slice(-2);
    })
    .join("");
}

function hmacSha256Base64Url_(value, secret) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(value, secret)).replace(/=+$/, "");
}

function constantTimeEquals_(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  var maxLength = Math.max(left.length, right.length);
  var difference = left.length ^ right.length;
  for (var index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function isPlainObject_(value) {
  return value !== null && !Array.isArray(value) && Object.prototype.toString.call(value) === "[object Object]";
}

function isNonEmptyString_(value) {
  return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInteger_(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value &&
    value > 0 && value <= Number.MAX_SAFE_INTEGER;
}

function success_(result) {
  return { ok: true, result: result };
}

function failure_(code, message) {
  return { ok: false, error: { code: code, message: message } };
}

function jsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function safeErrorMessage_(error) {
  var message = error && error.message ? String(error.message) : "Unexpected gateway failure.";
  return message.replace(/[\r\n]+/g, " ").slice(0, 500);
}
