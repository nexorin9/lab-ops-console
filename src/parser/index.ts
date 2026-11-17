/**
 * parser 统一出口
 */

export {
  parseOruR01,
  parseOruR01Segments,
  parseOruR01Frame,
  type ParseOruR01Options,
  type OruR01SegmentView,
} from './oru-r01.js';

export {
  parseAstmRecord,
  parseAstmStream,
  splitAstmRecords,
  decodeAstmControlChars,
  ASTM_CONTROL,
  type ParseAstmOptions,
  type AstmControlFrame,
  type AstmControlFrameType,
  type AstmSplitResult,
} from './astm-record.js';

export {
  FieldMapper,
  lookupDictionary,
  checkCriticalThreshold,
  CRITICAL_THRESHOLDS,
  type LoincSuggestion,
  type ModelGatewayLike,
  type FieldMapperOptions,
  type FieldMapperStats,
} from './field-mapper.js';

export type {
  ParserResult,
  FhirObservation,
  FhirDiagnosticReport,
  FhirSpecimen,
  FhirDevice,
  FhirCodeableConcept,
  FhirReference,
  FhirIdentifier,
  FhirQuantity,
  FhirCoding,
} from './fhir-types.js';
