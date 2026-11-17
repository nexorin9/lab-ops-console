import { describe, it, expect, beforeEach } from 'vitest';
import { readEnv, withEnv, REQUIRED_ENV_KEYS, OPTIONAL_ENV_KEYS } from '../../src/shared/env.js';
import { EnvMissingError } from '../../src/shared/errors.js';

/**
 * env.test.ts —— 必填项缺失抛错、选填默认值、类型化返回、withEnv 注入
 */

const BASE_VALID_ENV = {
  DEVICE_LISTEN_PORT: '2575',
  DEVICE_ENCODING: 'utf-8',
  LIS_FHIR_BASE_URL: 'https://lis.example.local/fhir',
  LIS_FHIR_TOKEN: 'lis-token',
  FHIR_BASE_URL: 'https://fhir.example.local/fhir',
  FHIR_TOKEN: 'fhir-token',
  MODELS_BASE_URL: 'https://models.example.local/v1',
  MODELS_API_KEY: 'sk-test',
  MODELS_MODEL: 'gpt-4o-mini',
};

describe('shared/env', () => {
  beforeEach(() => {
    // 每个用例前后清理关键 env（防泄漏）
    for (const k of [...REQUIRED_ENV_KEYS, ...OPTIONAL_ENV_KEYS]) {
      delete process.env[k];
    }
  });

  describe('readEnv', () => {
    it('必填项全部设置时返回完整 AppEnv', () => {
      withEnv(BASE_VALID_ENV, () => {
        const env = readEnv();
        expect(env.device.listenPort).toBe(2575);
        expect(env.device.encoding).toBe('utf-8');
        expect(env.lisFhir.baseUrl).toBe('https://lis.example.local/fhir');
        expect(env.lisFhir.token).toBe('lis-token');
        expect(env.fhir.baseUrl).toBe('https://fhir.example.local/fhir');
        expect(env.fhir.token).toBe('fhir-token');
        expect(env.models.baseUrl).toBe('https://models.example.local/v1');
        expect(env.models.apiKey).toBe('sk-test');
        expect(env.models.model).toBe('gpt-4o-mini');
        expect(env.models.timeoutMs).toBe(8000);
        expect(env.httpPort).toBe(3000);
        expect(env.dataDir).toBe('./data');
        expect(env.logLevel).toBe('info');
        expect(env.shutdownTimeoutMs).toBe(10_000);
        expect(env.serial.baudRate).toBe(9600);
        expect(env.serial.port).toBeNull();
        expect(env.notifyWebhookUrl).toBeNull();
      });
    });

    it('缺失 DEVICE_LISTEN_PORT 抛 EnvMissingError（含字段名）', () => {
      const env = { ...BASE_VALID_ENV };
      delete env.DEVICE_LISTEN_PORT;
      withEnv(env, () => {
        expect(() => readEnv()).toThrow(EnvMissingError);
        try {
          readEnv();
        } catch (e) {
          expect((e as EnvMissingError).code).toBe('ENV_MISSING');
          expect((e as EnvMissingError).context.envName).toBe('DEVICE_LISTEN_PORT');
        }
      });
    });

    it('缺失 LIS_FHIR_BASE_URL 抛错', () => {
      const env = { ...BASE_VALID_ENV };
      delete env.LIS_FHIR_BASE_URL;
      withEnv(env, () => {
        expect(() => readEnv()).toThrow(EnvMissingError);
      });
    });

    it('缺失 MODELS_API_KEY 抛错', () => {
      const env = { ...BASE_VALID_ENV };
      delete env.MODELS_API_KEY;
      withEnv(env, () => {
        expect(() => readEnv()).toThrow(EnvMissingError);
      });
    });

    it('DEVICE_LISTEN_PORT 非整数抛错', () => {
      const env = { ...BASE_VALID_ENV, DEVICE_LISTEN_PORT: 'abc' };
      withEnv(env, () => {
        expect(() => readEnv()).toThrow(EnvMissingError);
      });
    });

    it('DEVICE_ENCODING 不合法抛错', () => {
      const env = { ...BASE_VALID_ENV, DEVICE_ENCODING: 'iso-8859-1' };
      withEnv(env, () => {
        expect(() => readEnv()).toThrow(EnvMissingError);
      });
    });

    it('DEVICE_ENCODING 接受 utf-8 / gbk / gb18030', () => {
      for (const enc of ['utf-8', 'gbk', 'gb18030']) {
        withEnv({ ...BASE_VALID_ENV, DEVICE_ENCODING: enc }, () => {
          expect(readEnv().device.encoding).toBe(enc);
        });
      }
    });

    it('MODELS_TIMEOUT_MS 解析为整数', () => {
      withEnv({ ...BASE_VALID_ENV, MODELS_TIMEOUT_MS: '15000' }, () => {
        expect(readEnv().models.timeoutMs).toBe(15000);
      });
    });

    it('SERIAL_PORT 设置后被解析', () => {
      withEnv({ ...BASE_VALID_ENV, SERIAL_PORT: '/dev/ttyUSB0', SERIAL_BAUD_RATE: '115200' }, () => {
        const env = readEnv();
        expect(env.serial.port).toBe('/dev/ttyUSB0');
        expect(env.serial.baudRate).toBe(115200);
      });
    });

    it('NOTIFY_WEBHOOK_URL 设置后被解析', () => {
      withEnv({ ...BASE_VALID_ENV, NOTIFY_WEBHOOK_URL: 'https://hook.example.local/critical' }, () => {
        expect(readEnv().notifyWebhookUrl).toBe('https://hook.example.local/critical');
      });
    });

    it('HTTP_PORT / DATA_DIR / LOG_LEVEL / SHUTDOWN_TIMEOUT_MS 选填解析', () => {
      withEnv({
        ...BASE_VALID_ENV,
        HTTP_PORT: '4000',
        DATA_DIR: '/var/lib/lab-ops-console',
        LOG_LEVEL: 'debug',
        SHUTDOWN_TIMEOUT_MS: '5000',
      }, () => {
        const env = readEnv();
        expect(env.httpPort).toBe(4000);
        expect(env.dataDir).toBe('/var/lib/lab-ops-console');
        expect(env.logLevel).toBe('debug');
        expect(env.shutdownTimeoutMs).toBe(5000);
      });
    });

    it('env 值视为空字符串等同缺失', () => {
      withEnv({ ...BASE_VALID_ENV, FHIR_TOKEN: '' }, () => {
        expect(() => readEnv()).toThrow(EnvMissingError);
      });
    });
  });

  describe('withEnv', () => {
    it('结束后还原原值', () => {
      process.env.FHIR_TOKEN = 'before';
      withEnv({ FHIR_TOKEN: 'during' }, () => {
        expect(process.env.FHIR_TOKEN).toBe('during');
      });
      expect(process.env.FHIR_TOKEN).toBe('before');
    });

    it('undefined 值删除 env', () => {
      process.env.FHIR_TOKEN = 'set';
      withEnv({ FHIR_TOKEN: undefined }, () => {
        expect(process.env.FHIR_TOKEN).toBeUndefined();
      });
      expect(process.env.FHIR_TOKEN).toBe('set');
    });
  });

  describe('REQUIRED_ENV_KEYS / OPTIONAL_ENV_KEYS', () => {
    it('必填列表至少 8 项且不重叠', () => {
      expect(REQUIRED_ENV_KEYS.length).toBeGreaterThanOrEqual(8);
      const overlap = REQUIRED_ENV_KEYS.filter((k) => OPTIONAL_ENV_KEYS.includes(k as any));
      expect(overlap.length).toBe(0);
    });
  });
});
