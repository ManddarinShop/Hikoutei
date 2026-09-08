/**
 * @hikoutei/docs public entrypoint: the minimal Google Docs API adapter
 * (`documents.create/get/batchUpdate`) with shared quota pacing and retry
 * classification. Docs is a projection surface, never the source of truth.
 */

export {
  GOOGLE_DOCS_API_DEFAULTS,
  GOOGLE_DOCS_API_SCOPES,
  GOOGLE_DOCS_API_TIMING,
} from "./constants.js";
export {
  GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES,
  DocsTransportError,
  isRetryableDocsStatus,
  type GoogleDocsApiTransportErrorCode,
} from "./errors.js";
export {
  classifyDocsApiError,
  DocsApiHttpTransport,
  type DocsApiHttpTransportOptions,
  type DocsApiTransport,
  type DocsAuth,
  type DocsBatchUpdateRequest,
  type DocsCreateDocumentRequest,
  type DocsCredentialBinding,
  type DocsGetDocumentRequest,
} from "./docsApiTransport.js";
export {
  runDocsRead,
  runDocsWrite,
  type DocsApiRequestEvent,
  type DocsPacingDeps,
} from "./runDocs.js";
