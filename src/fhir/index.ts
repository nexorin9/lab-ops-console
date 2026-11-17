/**
 * src/fhir/index.ts — FHIR 模块统一出口
 */

export {
  createOidcClient,
  createOidcClientFromEnv,
  readOidcConfigFromEnv,
  OidcClient,
  injectFetch,
  type OidcConfig,
  type OidcToken,
} from './oidc-client.js';

export {
  buildAccessionIdentifier,
  buildIfNoneExistHeader,
  escapeSearchValue,
  unescapeSearchValue,
  isValidIdentifierValue,
  assertValidIdentifierValue,
  HEADER_IF_NONE_EXIST,
  ACCESSION_SYSTEM_URI,
  MAX_IDENTIFIER_VALUE_LENGTH,
  type AccessionInput,
} from './idempotency.js';

export {
  FhirWriter,
  createFhirWriter,
  createFhirWriterWithFetch,
  createFhirWriterWithToken,
  createFhirWriterFromEnv,
  isUrlAllowed,
  writeDLQToSqlite,
  type FhirWriterConfig,
  type WriteResourceInput,
  type WriteResult,
  type WriteVerifiedResult,
  type WriteOptions,
  type DLQEntry,
  type DlqSink,
} from './FhirWriter.js';

export {
  publishParserResult,
  type PublishOptions,
  type PublishResult,
} from './result-publisher.js';

export * from './resources/index.js';
