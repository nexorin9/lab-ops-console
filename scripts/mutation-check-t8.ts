/**
 * T8 变异检查 —— 逐个回退修复，确认对应回归测试真的会失败（非恒真断言）。
 *
 * 手法：把源码里的修复片段临时替换成「修复前」的写法，跑一次测试，
 * 若没有任何用例失败，说明这条回归断言是恒真的、没有真正守住行为；
 * 随后把源码原样恢复。
 *
 * 用法：npx tsx scripts/mutation-check-t8.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DET = join(ROOT, 'src/critical/detector.ts');
const SM = join(ROOT, 'src/critical/Task-state-machine.ts');

interface Mutation {
  name: string;
  file: string;
  old: string;
  next: string;
}

const MUTATIONS: Mutation[] = [
  {
    name: 'M1 ASTM/未知标记码降级为 medium',
    file: DET,
    old: 'const severity = severityForFlag(flag);',
    next: "const severity = flag.reason === 'abnormal_flag' ? severityFromAbnormalFlag(flag.detail.match(/OBX\\.8=(\\S+)/)?.[1] ?? 'A') : severityFromThreshold(flag.testCode);",
  },
  {
    name: 'M2 合并时数值不跟随严重度升级',
    file: DET,
    old: `      const higher = severityRank[severity] > severityRank[existing.severity];
      const merged: IdentifiedCriticalFlag = higher
        ? {
            ...flag,
            patientId,
            severity,
            dedupeKey: key,
            detail: \`\${existing.detail}；\${flag.detail}\`,
          }
        : {
            ...existing,
            severity: maxSeverity(existing.severity, severity),
            detail: \`\${existing.detail}；\${flag.detail}\`,
          };`,
    next: `      const merged: IdentifiedCriticalFlag = {
        ...existing,
        severity: maxSeverity(existing.severity, severity),
        detail: \`\${existing.detail}；\${flag.detail}\`,
      };`,
  },
  {
    name: 'M3 无 subject 时共用 unknown-patient',
    file: DET,
    old: 'const patientId = resolvePatientId(result);',
    next: "const patientId = result.diagnosticReport.subject?.reference?.replace(/^Patient\\//, '') ?? 'unknown-patient';",
  },
  {
    name: 'M4 白名单去掉 requested → received',
    file: SM,
    old: "requested: ['received'], // 接单即收单（requested → received 是主路径第一步）",
    next: 'requested: [], // MUTANT',
  },
  {
    name: 'M5b mutex 清理比较恒假（内存泄漏）',
    file: SM,
    old: 'if (this.inFlight.get(taskId) === chained) {',
    next: 'if (this.inFlight.get(taskId) === prev.then(() => next)) {',
  },
  {
    name: 'M6 acknowledge 不自适应起始态（回退为旧的硬编码 received → in-progress）',
    file: SM,
    old: `    if (task.status === 'requested') {
      return this.transition({
        taskId: input.taskId,
        fromState: 'requested',
        toState: 'received',
        agent: input.agent,
        reason: 'acknowledged',
        note: input.note,
        now: input.now,
      });
    }
    if (task.status === 'received') {
      return this.transition({
        taskId: input.taskId,
        fromState: 'received',
        toState: 'in-progress', // 已收单 → 开始处置
        agent: input.agent,
        reason: 'acknowledged',
        note: input.note,
        now: input.now,
      });
    }`,
    next: `    return this.transition({
      taskId: input.taskId,
      fromState: 'received',
      toState: 'in-progress',
      agent: input.agent,
      reason: 'acknowledged',
      note: input.note,
      now: input.now,
    });`,
  },
  {
    name: 'M7 outcome 值域不校验',
    file: SM,
    old: '  if (!AUDIT_OUTCOMES.includes(fields.outcome)) {',
    next: '  if (false) {',
  },
];

function runTests(): { failed: number; out: string } {
  const p = spawnSync('npx', ['vitest', 'run', 'tests/critical/state-machine.test.ts'], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  const out = `${p.stdout ?? ''}${p.stderr ?? ''}`;
  const m = out.match(/Tests\s+.*?(\d+)\s+failed/);
  return { failed: m ? Number(m[1]) : 0, out };
}

function main(): number {
  const backups = new Map<string, string>();
  for (const mu of MUTATIONS) {
    if (!backups.has(mu.file)) backups.set(mu.file, readFileSync(mu.file, 'utf-8'));
  }

  const uncaught: string[] = [];
  try {
    for (const mu of MUTATIONS) {
      const original = backups.get(mu.file)!;
      if (!original.includes(mu.old)) {
        console.log(`[SKIP] ${mu.name}: 未找到待变异片段`);
        uncaught.push(mu.name);
        writeFileSync(mu.file, original);
        continue;
      }
      writeFileSync(mu.file, original.replace(mu.old, mu.next));
      const { failed, out } = runTests();
      writeFileSync(mu.file, original);
      const status = failed > 0 ? 'OK' : '!!! 未捕获';
      console.log(`[${status}] ${mu.name}: 变异后失败用例数 = ${failed}`);
      if (failed === 0) {
        uncaught.push(mu.name);
        console.log(out.slice(-1200));
      }
    }
  } finally {
    for (const [file, content] of backups) writeFileSync(file, content);
  }

  console.log('\n=== 变异检查结论 ===');
  if (uncaught.length > 0) {
    console.log(`以下变异未被回归测试捕获：${uncaught.join('、')}`);
    return 1;
  }
  console.log('全部变异均被对应回归测试捕获 —— 断言有效');
  return 0;
}

process.exit(main());
