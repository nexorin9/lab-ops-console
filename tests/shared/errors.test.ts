import { describe, it, expect } from 'vitest';
import {
  BaseError,
  ErrorCode,
  Hl7ParseFailError,
  Hl7FrameInvalidError,
  Hl7EncodingFailError,
  AstmParseFailError,
  PrivateBytesParseFailError,
  FhirWriteFailError,
  FhirValidationFailError,
  FhirServerFailError,
  FhirBatchPartialFailError,
  ModelTimeoutError,
  ModelSchemaInvalidError,
  ModelNetworkFailError,
  ModelUnavailableFallbackError,
  ModelPromptRenderFailError,
  DlqEnqueueError,
  TaskInvalidTransitionError,
  AuditFieldMissingError,
  AuditDeniedError,
  AuthTokenMissingError,
  AuthTokenExpiredError,
  AuthTokenInvalidError,
  EnvMissingError,
  ChannelConfigError,
  ExportFieldMissingError,
  isBaseError,
  wrapError,
} from '../../src/shared/errors.js';

describe('shared/errors', () => {
  describe('BaseError', () => {
    it('preserves name, code, message, context, cause', () => {
      const cause = new Error('inner');
      const err = new BaseError('TEST', 'msg', { k: 'v' }, cause);
      expect(err.name).toBe('BaseError');
      expect(err.code).toBe('TEST');
      expect(err.message).toBe('msg');
      expect(err.context).toEqual({ k: 'v' });
      expect(err.cause).toBe(cause);
      expect(err instanceof Error).toBe(true);
    });

    it('toJSON 输出稳定字段', () => {
      const cause = new Error('inner');
      const err = new BaseError('TEST', 'msg', { k: 'v' }, cause);
      const json = err.toJSON();
      expect(json).toMatchObject({
        name: 'BaseError',
        code: 'TEST',
        message: 'msg',
        context: { k: 'v' },
        cause: 'inner',
      });
      expect(typeof json.stack).toBe('string');
    });

    it('toLogFields 提供 pino 字段', () => {
      const err = new BaseError('CODE', 'msg', { a: 1 });
      expect(err.toLogFields()).toEqual({
        err_name: 'BaseError',
        err_code: 'CODE',
        err_message: 'msg',
        err_context: { a: 1 },
        err_cause: undefined,
      });
    });
  });

  describe('ErrorCode enum', () => {
    it('包含 14 类核心错误码', () => {
      expect(ErrorCode.HL7_PARSE_FAIL).toBeDefined();
      expect(ErrorCode.HL7_FRAME_INVALID).toBeDefined();
      expect(ErrorCode.HL7_ENCODING_FAIL).toBeDefined();
      expect(ErrorCode.ASTM_PARSE_FAIL).toBeDefined();
      expect(ErrorCode.PRIVATE_BYTES_PARSE_FAIL).toBeDefined();
      expect(ErrorCode.FHIR_WRITE_FAIL).toBeDefined();
      expect(ErrorCode.FHIR_VALIDATION_FAIL).toBeDefined();
      expect(ErrorCode.FHIR_SERVER_FAIL).toBeDefined();
      expect(ErrorCode.FHIR_BATCH_PARTIAL_FAIL).toBeDefined();
      expect(ErrorCode.MODEL_TIMEOUT).toBeDefined();
      expect(ErrorCode.MODEL_SCHEMA_INVALID).toBeDefined();
      expect(ErrorCode.MODEL_NETWORK_FAIL).toBeDefined();
      expect(ErrorCode.MODEL_UNAVAILABLE_FALLBACK).toBeDefined();
      expect(ErrorCode.MODEL_PROMPT_RENDER_FAIL).toBeDefined();
      expect(ErrorCode.DLQ_ENQUEUE).toBeDefined();
      expect(ErrorCode.TASK_INVALID_TRANSITION).toBeDefined();
      expect(ErrorCode.AUDIT_FIELD_MISSING).toBeDefined();
      expect(ErrorCode.AUDIT_DENIED).toBeDefined();
      expect(ErrorCode.AUTH_TOKEN_MISSING).toBeDefined();
      expect(ErrorCode.AUTH_TOKEN_EXPIRED).toBeDefined();
      expect(ErrorCode.AUTH_TOKEN_INVALID).toBeDefined();
      expect(ErrorCode.ENV_MISSING).toBeDefined();
      expect(ErrorCode.CHANNEL_CONFIG_ERROR).toBeDefined();
      expect(ErrorCode.EXPORT_FIELD_MISSING).toBeDefined();
    });
  });

  describe('14 类结构化错误子类', () => {
    const cases: Array<[new (...args: any[]) => BaseError, string]> = [
      [Hl7ParseFailError, ErrorCode.HL7_PARSE_FAIL],
      [Hl7FrameInvalidError, ErrorCode.HL7_FRAME_INVALID],
      [Hl7EncodingFailError, ErrorCode.HL7_ENCODING_FAIL],
      [AstmParseFailError, ErrorCode.ASTM_PARSE_FAIL],
      [PrivateBytesParseFailError, ErrorCode.PRIVATE_BYTES_PARSE_FAIL],
      [FhirWriteFailError, ErrorCode.FHIR_WRITE_FAIL],
      [FhirValidationFailError, ErrorCode.FHIR_VALIDATION_FAIL],
      [FhirServerFailError, ErrorCode.FHIR_SERVER_FAIL],
      [FhirBatchPartialFailError, ErrorCode.FHIR_BATCH_PARTIAL_FAIL],
      [ModelTimeoutError, ErrorCode.MODEL_TIMEOUT],
      [ModelSchemaInvalidError, ErrorCode.MODEL_SCHEMA_INVALID],
      [ModelNetworkFailError, ErrorCode.MODEL_NETWORK_FAIL],
      [ModelUnavailableFallbackError, ErrorCode.MODEL_UNAVAILABLE_FALLBACK],
      [ModelPromptRenderFailError, ErrorCode.MODEL_PROMPT_RENDER_FAIL],
      [DlqEnqueueError, ErrorCode.DLQ_ENQUEUE],
      [TaskInvalidTransitionError, ErrorCode.TASK_INVALID_TRANSITION],
      [AuditFieldMissingError, ErrorCode.AUDIT_FIELD_MISSING],
      [AuditDeniedError, ErrorCode.AUDIT_DENIED],
      [AuthTokenMissingError, ErrorCode.AUTH_TOKEN_MISSING],
      [AuthTokenExpiredError, ErrorCode.AUTH_TOKEN_EXPIRED],
      [AuthTokenInvalidError, ErrorCode.AUTH_TOKEN_INVALID],
      [EnvMissingError, ErrorCode.ENV_MISSING],
      [ChannelConfigError, ErrorCode.CHANNEL_CONFIG_ERROR],
      [ExportFieldMissingError, ErrorCode.EXPORT_FIELD_MISSING],
    ];

    for (const [Cls, code] of cases) {
      it(`${Cls.name} → code=${code}`, () => {
        const err = new Cls('msg', { extra: 1 });
        expect(err).toBeInstanceOf(BaseError);
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe(code);
        expect(err.message).toBe('msg');
        expect(err.context).toEqual({ extra: 1 });
        expect(err.toJSON().code).toBe(code);
      });
    }

    it('子类传递 cause', () => {
      const inner = new Error('inner');
      const err = new FhirWriteFailError('outer', { id: 'x' }, inner);
      expect(err.cause).toBe(inner);
      expect(err.toJSON().cause).toBe('inner');
    });
  });

  describe('isBaseError / wrapError', () => {
    it('isBaseError 正确识别 BaseError 实例', () => {
      expect(isBaseError(new FhirWriteFailError('m'))).toBe(true);
      expect(isBaseError(new Error('plain'))).toBe(false);
      expect(isBaseError('string')).toBe(false);
      expect(isBaseError(null)).toBe(false);
    });

    it('wrapError 包装非结构化错误', () => {
      const plain = new Error('plain');
      const wrapped = wrapError(plain, ErrorCode.MODEL_TIMEOUT);
      expect(wrapped).toBeInstanceOf(BaseError);
      expect(wrapped.code).toBe(ErrorCode.MODEL_TIMEOUT);
      expect(wrapped.message).toBe('plain');
      expect(wrapped.cause).toBe(plain);
    });

    it('wrapError 已是 BaseError 原样返回', () => {
      const base = new FhirWriteFailError('m');
      const wrapped = wrapError(base);
      expect(wrapped).toBe(base);
    });

    it('wrapError 包装 string / unknown', () => {
      const wrapped = wrapError('oops');
      expect(wrapped.code).toBe(ErrorCode.FHIR_WRITE_FAIL);
      expect(wrapped.message).toBe('oops');
      expect(wrapped.cause).toBe('oops');
    });
  });
});
