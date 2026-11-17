/**
 * src/fhir/resources/index.ts — FHIR R4 构造器统一出口
 */

export {
  buildObservation,
  validateObservation,
  ObservationSchema,
  type FhirObservation,
  type BuildObservationInput,
} from './observation.js';

export {
  buildDiagnosticReport,
  validateDiagnosticReport,
  DiagnosticReportSchema,
  type FhirDiagnosticReport,
  type BuildDiagnosticReportInput,
} from './diagnostic-report.js';

export {
  buildSpecimen,
  validateSpecimen,
  SpecimenSchema,
  type FhirSpecimen,
  type BuildSpecimenInput,
} from './specimen.js';

export {
  buildDevice,
  validateDevice,
  DeviceSchema,
  type FhirDevice,
  type BuildDeviceInput,
} from './device.js';

export {
  buildTask,
  validateTask,
  TaskSchema,
  TASK_STATUSES,
  type FhirTask,
  type TaskStatus,
  type BuildTaskInput,
} from './task.js';

export {
  buildAuditEvent,
  validateAuditEvent,
  AuditEventSchema,
  AuditOutcomeCode,
  type FhirAuditEvent,
  type AuditOutcome,
  type BuildAuditEventInput,
} from './audit-event.js';
