/**
 * critical 模块统一出口
 */

export {
  detect,
  makeDedupeKey,
  severityFromAbnormalFlag,
  severityFromThreshold,
  extractAbnormalFlag,
  resolvePatientId,
  maxSeverity,
  type CriticalDetection,
  type IdentifiedCriticalFlag,
  type Severity,
} from './detector.js';

export {
  TaskStateMachine,
  TASK_STATES,
  AUDIT_OUTCOMES,
  validateAuditFields,
  validateTransition,
  type TaskState,
  type AuditOutcome,
  type AgentRole,
  type TransitionInput,
  type TransitionResult,
  type AuditFields,
} from './Task-state-machine.js';

export {
  CriticalStore,
  getCriticalStore,
  _resetCriticalStoreForTest,
  type CriticalTaskRow,
  type CriticalAuditRow,
} from './store.js';

export {
  NotificationDispatcher,
  getDispatcher,
  _resetDispatcherForTest,
  type DispatchResult,
  type CriticalPushPayload,
  type DispatcherOptions,
  type WsClientLike,
  type WsServerLike,
  type WebhookOptions,
  buildDispatchPayload,
  hashPatientId,
  assertNoPii,
  FORBIDDEN_PAYLOAD_KEYS,
} from './NotificationDispatcher.js';

export {
  RedeliveryWorker,
  type RedeliveryOptions,
  type RedeliveryResult,
} from './redelivery.js';

export {
  CandidateAdoption,
  type CandidateAdoptionOptions,
} from './CandidateAdoption.js';