/**
 * Parses documented Google Sheets spreadsheet URLs into a spreadsheet id.
 * Leaf module: no soak-module dependencies.
 */

/**
 * Documented Google Sheets spreadsheet URL authority (host) and path
 * segments. The runner only ever resolves `HIKOUTEI_SYNC_SPREADSHEET_URL`,
 * which is documented as `https://docs.google.com/spreadsheets/d/<ID>/...`,
 * so the host is enforced rather than trusting any arbitrary authority.
 */
const SPREADSHEET_URL_HOST = "docs.google.com";
const SPREADSHEET_PARENT_SEGMENT = "spreadsheets";
const SPREADSHEET_PATH_SEGMENT = "d";

/**
 * URI-scheme pattern recognising any `scheme://` prefix. A schemed URL is
 * only accepted when the scheme is exactly `https`; the documented
 * scheme-less `docs.google.com/...` form is still allowed. Any other
 * scheme (`ftp`, `javascript`, `http`, `ws`, ...) is rejected so a hostile
 * or stale env value can never be misread as a spreadsheet target.
 */
const SPREADSHEET_URL_SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//;

/**
 * Valid Google Sheets spreadsheet ID characters (URL-safe base64): ASCII
 * letters, digits, `-` and `_`. Anything else -- whitespace, `?`, `#`, `/`,
 * `+`, `=`, `.`, percent-encoded octets, etc. -- is rejected so a malformed
 * ID is never echoed into diagnostics or used to build a Sheets API URL.
 */
const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Extracts a spreadsheet ID from a documented Google Sheets URL
 * (`https://docs.google.com/spreadsheets/d/<ID>/...`).
 *
 * The authority is locked to the documented `docs.google.com` host so a URL
 * such as `https://evil.example/d/<ID>` or any other arbitrary host can
 * never be misread as a spreadsheet target (which would let cleanup-only
 * act on an unintended spreadsheet). Within that host only two exact path
 * layouts are accepted -- `/spreadsheets/d/<ID>` and a top-level `/d/<ID>`
 * right after the host -- followed only by the documented trailing forms
 * (`/edit` and/or a trailing slash; query/fragment are stripped before
 * parsing). No arbitrary prefix or suffix segment is allowed, so a path
 * such as `/foo/spreadsheets/d/<ID>` or `d/<ID>/extra` is refused rather
 * than scanned for any `d` segment. A schemed URL must use `https`
 * (scheme-less `docs.google.com/...` remains supported) and the `<ID>`
 * must contain only valid spreadsheet ID characters. Returns `undefined`
 * when no valid ID can be extracted; the ID is the only part ever echoed in
 * diagnostics.
 */
export function parseSpreadsheetIdFromUrl(url) {
  const input = String(url);
  const schemeMatch = SPREADSHEET_URL_SCHEME_PATTERN.exec(input);
  if (schemeMatch && schemeMatch[1].toLowerCase() !== "https") return undefined;
  const withoutScheme = schemeMatch ? input.slice(schemeMatch[0].length) : input;
  const pathPart = withoutScheme.split(/[?#]/, 1)[0] ?? "";
  const segments = pathPart.split("/");
  // The authority is the first segment; reject any non-documented host so
  // cleanup-only can never be scoped to an unintended spreadsheet.
  if (segments[0] !== SPREADSHEET_URL_HOST) return undefined;
  // Only the two documented layouts are allowed; anything else (including an
  // arbitrary prefix segment such as `/foo/spreadsheets/d/<ID>`) is refused.
  let prefixLength; // number of leading segments up to and including `d`
  if (
    segments[1] === SPREADSHEET_PARENT_SEGMENT &&
    segments[2] === SPREADSHEET_PATH_SEGMENT
  ) {
    prefixLength = 3; // host / spreadsheets / d
  } else if (segments[1] === SPREADSHEET_PATH_SEGMENT) {
    prefixLength = 2; // host / d
  } else {
    return undefined;
  }
  const id = segments[prefixLength];
  if (id === undefined || id.length === 0) return undefined;
  if (!SPREADSHEET_ID_PATTERN.test(id)) return undefined;
  // After the ID only the documented trailing forms are accepted: nothing
  // (end of path), a trailing slash, `/edit`, or `/edit/`. Any other suffix
  // segment is refused rather than accepted.
  const remainder = segments.slice(prefixLength + 1);
  if (remainder.length === 0) return id; // exact end of path
  if (remainder.length === 1 && remainder[0] === "") return id; // trailing slash
  if (remainder.length === 1 && remainder[0] === "edit") return id; // /edit
  if (
    remainder.length === 2 &&
    remainder[0] === "edit" &&
    remainder[1] === ""
  ) {
    return id; // /edit/
  }
  return undefined;
}
