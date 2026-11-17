/**
 * FHIR R4 Device 构造器（仪器心跳 + 设备白名单）
 *
 * field-by-field 对照 FHIR R4 spec：
 * https://hl7.org/fhir/R4/device.html
 *
 * - 用于：将仪器接入层 channel 注册成 FHIR Device，便于 HIS / LIS 端追溯设备厂商和序列号
 * - 与 Observation.device.reference 关联
 */

import { z } from 'zod';
import { FhirValidationFailError } from '../../shared/errors.js';

export const DeviceSchema = z.object({
  resourceType: z.literal('Device'),
  id: z.string().optional(),
  identifier: z.array(z.object({
    system: z.string(),
    value: z.string(),
  })).optional(),
  manufacturer: z.string().optional(),
  modelNumber: z.string().optional(),
  serialNumber: z.string().optional(),
  deviceName: z.array(z.object({
    name: z.string(),
    type: z.enum(['udi-label-name', 'user-friendly-name', 'patient-reported-name', 'manufacturer-name', 'model-name', 'other']),
  })).optional(),
  type: z.object({
    coding: z.array(z.object({
      system: z.string(),
      code: z.string(),
      display: z.string().optional(),
    })).min(1),
  }).optional(),
  status: z.enum(['active', 'inactive', 'entered-in-error', 'unknown']).optional(),
  version: z.object({
    value: z.string(),
    type: z.object({
      coding: z.array(z.object({
        system: z.string(),
        code: z.string(),
        display: z.string().optional(),
      })).min(1),
    }).optional(),
  }).optional(),
});

export type FhirDevice = z.infer<typeof DeviceSchema>;

export interface BuildDeviceInput {
  id: string;
  manufacturer: string;
  modelName: string;
  serialNumber?: string;
  typeCode?: string;
  typeDisplay?: string;
  typeSystem?: string;
  status?: 'active' | 'inactive' | 'entered-in-error' | 'unknown';
  firmwareVersion?: string;
}

export function buildDevice(input: BuildDeviceInput): FhirDevice {
  if (!input.id) {
    throw new FhirValidationFailError('buildDevice: id 必填', { field: 'id' });
  }
  if (!input.manufacturer || !input.modelName) {
    throw new FhirValidationFailError('buildDevice: manufacturer 与 modelName 必填', {
      manufacturer: !!input.manufacturer,
      modelName: !!input.modelName,
    });
  }
  const device: FhirDevice = {
    resourceType: 'Device',
    id: input.id,
    manufacturer: input.manufacturer,
    status: input.status ?? 'active',
    deviceName: [
      { name: input.modelName, type: 'model-name' },
    ],
  };
  if (input.serialNumber) {
    device.serialNumber = input.serialNumber;
    device.identifier = [{
      system: 'urn:lab-ops-console:device-sn',
      value: input.serialNumber,
    }];
  }
  if (input.typeCode) {
    device.type = {
      coding: [{
        system: input.typeSystem ?? 'http://snomed.info/sct',
        code: input.typeCode,
        display: input.typeDisplay,
      }],
    };
  }
  if (input.firmwareVersion) {
    device.version = {
      value: input.firmwareVersion,
      type: {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/device-version-type',
          code: 'firmware',
        }],
      },
    };
  }
  return device;
}

export function validateDevice(d: unknown): FhirDevice {
  const parsed = DeviceSchema.safeParse(d);
  if (!parsed.success) {
    throw new FhirValidationFailError('Device schema 校验失败', { issues: parsed.error.issues });
  }
  return parsed.data;
}
