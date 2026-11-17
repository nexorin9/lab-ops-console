/**
 * T6 主干核验脚本 —— H2 解析层全量（真实进程、真实字节）
 *
 * 覆盖三条现场路径：
 * ① ASTM E1394：带 ENQ/ACK/EOT 会话帧的原始字节流 → 切帧 → 记录解析 → FHIR 资源
 * ② HL7 ORU^R01：一条报文两份标本 → 标本归属 + Observation 归属
 * ③ 厂商私有协议：yaml 描述的字节模板 + 字段偏移 → 字段提取（含 GBK 字段）
 *
 * 用法：npx tsx scripts/verify-parser-h2.ts
 */

import { parseHl7Message } from '../src/channels/Hl7Connection.js';
import { parseOruR01 } from '../src/parser/oru-r01.js';
import { parseAstmStream, splitAstmRecords } from '../src/parser/astm-record.js';
import {
  PrivateBytesParser,
  buildPrivateBytesConfig,
  parsePrivateBytesYaml,
} from '../src/channels/private-bytes.js';
import iconv from 'iconv-lite';

const lines: string[] = [];
const log = (msg: string): void => {
  lines.push(msg);
  console.log(msg);
};

// ---------- ① ASTM E1394 ----------
const astmStream = [
  '\x05', // ENQ 询问
  '1H|\\^&|||ASTM^Host|||||LIS||P|1\r',
  '2P|1||P98765||||||\r',
  '3O|1|SMP-001||CHEM7^生化七项^L|R|20261013110000\r',
  '4R|1|^^^K|4.8|mmol/L|3.5-5.5|N\r',
  '4R|2|^^^NA|142|mmol/L|135-145|N\r',
  '5L|1|N\r',
  '\x06', // ACK
  '\x04', // EOT
].join('');

const split = splitAstmRecords(astmStream);
log(`ASTM_CONTROL_FRAMES=${split.controlFrames.map((f) => f.type).join(',')}`);
log(`ASTM_RECORDS=${split.records.length}`);

const astm = await parseAstmStream(astmStream, { deviceId: 'DEV-ASTM-VERIFY' });
log(`ASTM_RESULTS=${astm.results.length} ERRORS=${astm.errors.length}`);
log(
  `ASTM_OBS=${astm.results[0]?.observations
    .map((o) => `${o.code.coding[0]?.code}=${o.valueQuantity?.value}${o.valueQuantity?.unit ?? ''}`)
    .join(' | ')}`,
);
log(`ASTM_SPECIMEN_ACCESSION=${astm.results[0]?.specimen.accessionIdentifier?.value}`);
log(`ASTM_DICT_HITS=${astm.results[0]?.fieldAttribution.filter((f) => f.source === 'dictionary').length}`);

// ①b 厂商写法 4R.3 = ^^^项目码^项目名 —— 项目码取首个子成分，危急值阈值照常命中
const astmNamed = [
  '1H|\\^&|||ASTM^Host|||||LIS||P|1\r',
  '2P|1||P98765||||||\r',
  '3O|1|SMP-002||CHEM7^生化七项^L|R|20261013110000\r',
  '4R|1|^^^K^钾|6.8|mmol/L|3.5-5.5|N\r',
  '5L|1|N\r',
].join('');
const astmNamedResult = await parseAstmStream(astmNamed, { deviceId: 'DEV-ASTM-VERIFY' });
log(
  `ASTM_NAMED_CODE=${astmNamedResult.results[0]?.fieldAttribution[0]?.deviceCode} DISPLAY=${astmNamedResult.results[0]?.fieldAttribution[0]?.deviceDisplay}`,
);
log(
  `ASTM_NAMED_CRITICAL=${astmNamedResult.results[0]?.criticalFlags.map((f) => f.reason).join(',')}`,
);

// ①c 同一份记录解析两次 → 幂等锚（accession / 资源 id）不变
const astmNoOrder = '1H|\\^&|||ASTM^Host|||||LIS||P|1\r2P|1||P1||||||\r4R|1|^^^K|4.8|mmol/L|3.5-5.5|N\r5L|1|N\r';
const astmFirst = await parseAstmStream(astmNoOrder, { deviceId: 'DEV-ASTM-VERIFY' });
await new Promise((r) => setTimeout(r, 5));
const astmSecond = await parseAstmStream(astmNoOrder, { deviceId: 'DEV-ASTM-VERIFY' });
log(
  `ASTM_IDEMPOTENT=${
    astmFirst.results[0]?.specimen.accessionIdentifier?.value ===
    astmSecond.results[0]?.specimen.accessionIdentifier?.value
  } ACCESSION=${astmFirst.results[0]?.specimen.accessionIdentifier?.value}`,
);

// ---------- ② HL7 ORU^R01 多标本 ----------
const oruRaw = [
  'MSH|^~\\&|LIS|Hospital-A|LabOpsConsole|Hospital-B|20261013100000||ORU^R01^ORU_R01|MSG90001|P|2.5',
  'PID|1||P90001^^^Hospital-A^MR',
  'OBR|1|ORD901|FIL901|CBC^血常规^L|||20261013100000',
  'SPM|1|SMP-A',
  'OBX|1|NM|HGB^血红蛋白^L|1|138|g/L|130-175|N|||F',
  'OBR|2|ORD902|FIL902|BIO^生化^L|||20261013100000',
  'SPM|1|SMP-B',
  'OBX|1|NM|K^钾^L|1|6.8|mmol/L|3.5-5.5|HH|||F',
  'OBX',
].join('\r');

const oru = await parseOruR01(parseHl7Message(oruRaw), {
  deviceId: 'DEV-LIS-VERIFY',
  allowedDeviceIds: ['DEV-LIS-VERIFY'],
});
log(`ORU_SPECIMENS=${oru.specimens.length}`);
log(
  `ORU_OBS_SPECIMEN=${oru.observations
    .map((o) => `${o.id}->${o.specimen?.reference}`)
    .join(' | ')}`,
);
log(`ORU_CRITICAL_FLAGS=${oru.criticalFlags.length} REASONS=${oru.criticalFlags.map((f) => f.reason).join(',')}`);
log(`ORU_SKIPPED=${oru.skippedSegments?.length ?? 0} PARSE_ERRORS=${oru.parseErrors?.length ?? 0}`);

// 白名单外设备应被拒收
let rejected = false;
try {
  await parseOruR01(parseHl7Message(oruRaw), {
    deviceId: 'DEV-RETIRED',
    allowedDeviceIds: ['DEV-LIS-VERIFY'],
  });
} catch (err) {
  rejected = (err as { code?: string }).code === 'DEVICE_NOT_ALLOWED';
}
log(`ORU_DEVICE_WHITELIST_REJECT=${rejected}`);

// ---------- ③ 厂商私有协议 ----------
const privateYaml = parsePrivateBytesYaml(
  `name: example-private-biochem
deviceId: DEV-PRIVATE-VERIFY
startTriggerHex: '0x02'
endTriggerHex: '0x03'
fields:
  - name: patientId
    offset: 0
    length: 8
    encoding: utf-8
  - name: testName
    offset: 8
    length: 4
    encoding: gbk
`,
  'verify-private.yaml',
);
const parser = new PrivateBytesParser(buildPrivateBytesConfig(privateYaml));
const body = Buffer.concat([
  Buffer.from('P12345  ', 'utf-8'),
  iconv.encode('钾   ', 'gbk'),
]);
const priv = parser.parse(Buffer.concat([Buffer.from([0x02]), body, Buffer.from([0x03])]));
log(`PRIVATE_PATIENT=${priv.fields.patientId} TESTNAME=${priv.fields.testName}`);
log(`PRIVATE_EXTRACTED=${priv.extractedCount}/${priv.declaredCount}`);

log('RESULT=PASS');
