/** AI 模块统一出口（业务层只依赖本出口，不直接依赖厂商 SDK） */

export {
  ModelGateway,
  STATIC_FALLBACK,
  classifyFetchError,
  type ModelGatewayOptions,
} from './ModelGateway.js';

export {
  readModelConfig,
  chatCompletionsUrl,
  DEFAULT_MODELS_TIMEOUT_MS,
  MODEL_ENV_KEYS,
  type ModelConfig,
} from './config.js';

export {
  RECIPIENT_PROMPT,
  ATTRIBUTION_PROMPT,
  PROMPT_TEMPLATES,
  RecipientResponseSchema,
  AttributionResponseSchema,
  renderPrompt,
  type PromptTemplate,
} from './prompt-templates.js';

export {
  createModelCallAuditor,
  readModelCallAudit,
  sha256,
  DEFAULT_AUDIT_DIR,
  AUDIT_FILENAME,
  type ModelCallAuditRecord,
  type ModelCallAuditor,
} from './audit.js';

export {
  FAILURE_MATRIX,
  FAILURE_KINDS,
  FALLBACK_AUDIT_OUTCOME,
  PARTIAL_AUDIT_OUTCOME,
  SUCCESS_AUDIT_OUTCOME,
  semanticsFor,
  type FailureKind,
  type FailureSemantics,
} from './failure-matrix.js';

export {
  mergeCandidates,
  type Candidate,
  type FieldAttribution,
  type RecipientQuery,
  type AttributionQuery,
  type FallbackProvider,
  type GatewayResult,
} from './types.js';
