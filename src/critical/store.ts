/**
 * critical.store —— 危急值 Task + AuditEvent + 推送队列的 SQLite 持久层
 *
 * 表：
 * - critical_tasks (id / patient_id / status / focus_diagnostic_id / focus_observation_code / priority / reason_text / created_at / updated_at)
 * - critical_audit_events (id / task_id / agent / agent_display / recorded / source / outcome / reason / context)
 * - escalation_events (T21 升级用，本表 schema 先建好)
 *
 * 设计原则：
 * - 用 shared/sqlite 的单例（与解析层 / FHIR 层共享 db）
 * - 启动时 migrate v2 增量（不动 v1 的表）
 * - AuditEvent 四字段（agent / recorded / source / outcome）非空约束
 * - index 用于：按 patient_id 查 / 按 status 查 / 按 recorded 倒序 / 按 denied 单独索引
 */

import type { Database as DB } from 'better-sqlite3';
import { getSqlite } from '../shared/sqlite.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('critical.store');

/** critical_tasks 行结构 */
export interface CriticalTaskRow {
  id: string;
  patient_id: string;
  status: string;
  focus_diagnostic_id: string;
  focus_observation_code: string;
  priority: string;
  reason_text: string | null;
  created_at: string;
  updated_at: string;
  /** T24 · 收到（ack）时间；升级链按此计时而非 created_at，避免夜班交班算错停留时长 */
  received_at: string | null;
  /** T31 · 面板/大屏展示用危急值快照字段（与 broadcast critical.detected 同源，避免回看快照看不到数值） */
  focus_value: string | null;
  focus_unit: string | null;
  focus_test_code: string | null;
  focus_test_display: string | null;
  focus_severity: string | null;
}

/** critical_audit_events 行结构 */
export interface CriticalAuditRow {
  id: number;
  task_id: string;
  agent: string;
  agent_display: string | null;
  recorded: string;
  source: string;
  outcome: string;
  reason: string | null;
  context: string | null;
}

/** migration v2：critical_tasks / critical_audit_events / escalation_events */
const MIGRATIONS_V2: string[] = [
  `CREATE TABLE IF NOT EXISTS critical_tasks (
    id TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('requested','received','in-progress','completed','cancelled','rejected')),
    focus_diagnostic_id TEXT NOT NULL,
    focus_observation_code TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'urgent',
    reason_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    received_at TEXT,
    focus_value TEXT,
    focus_unit TEXT,
    focus_test_code TEXT,
    focus_test_display TEXT,
    focus_severity TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_critical_tasks_patient ON critical_tasks(patient_id)`,
  `CREATE INDEX IF NOT EXISTS idx_critical_tasks_status ON critical_tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_critical_tasks_focus ON critical_tasks(focus_diagnostic_id, focus_observation_code)`,
  `CREATE INDEX IF NOT EXISTS idx_critical_tasks_updated ON critical_tasks(updated_at)`,

  `CREATE TABLE IF NOT EXISTS critical_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    agent_display TEXT,
    recorded TEXT NOT NULL,
    source TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('success','denied','partial','fallback_rules')),
    reason TEXT,
    context TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_critical_audit_task ON critical_audit_events(task_id)`,
  `CREATE INDEX IF NOT EXISTS idx_critical_audit_recorded ON critical_audit_events(recorded)`,
  `CREATE INDEX IF NOT EXISTS idx_critical_audit_denied ON critical_audit_events(task_id) WHERE outcome = 'denied'`,

  `CREATE TABLE IF NOT EXISTS escalation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('dept_head','department_head','medical_affairs')),
    created_at TEXT NOT NULL,
    notified_at TEXT,
    reason TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_escalation_task ON escalation_events(task_id)`,

  // T9：审计幂等去重表。状态机每次转换写一条，重复投递（重连 / 重放 / 客户端双击）
  // 不得在审计链上留下第二条同样的事件，否则飞检时「一次确认」会被算成两次。
  `CREATE TABLE IF NOT EXISTS critical_audit_dedupe (
    dedupe_key TEXT PRIMARY KEY,
    audit_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

let v2Applied = false;
const migratedDbs = new WeakSet<DB>();

/** 应用 v2 migration（幂等，每个 db 只跑一次） */
function ensureMigrations(db: DB): void {
  if (migratedDbs.has(db)) return;
  // 全部 DDL 均为 IF NOT EXISTS，直接按「首次使用此 db 时执行一遍」处理。
  // 不能复用 shared/sqlite 的 schema_migrations v2 版本号：那边的 v2 是 DLQ 回放列，
  // 与危急值三表是两套迁移，共用版本号会让 critical_tasks 在共享库上永远建不出来。
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  db.transaction(() => {
    for (const sql of MIGRATIONS_V2) db.exec(sql);
    // 老库（T8 时代建表）没有 received_at 列，增量补上；新库 CREATE 已带该列
    const cols = db.prepare(`PRAGMA table_info(critical_tasks)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'received_at')) {
      db.exec(`ALTER TABLE critical_tasks ADD COLUMN received_at TEXT`);
    }
    for (const col of ['focus_value', 'focus_unit', 'focus_test_code', 'focus_test_display', 'focus_severity']) {
      if (!cols.some((c) => c.name === col)) {
        db.exec(`ALTER TABLE critical_tasks ADD COLUMN ${col} TEXT`);
      }
    }
    db.prepare(`INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)`).run(102);
  })();
  migratedDbs.add(db);
  v2Applied = true;
}

/** CriticalStore —— critical_tasks / critical_audit_events 的 CRUD */
type Stmt1<T> = { run(...p: any[]): { changes: number; lastInsertRowid: number | bigint }; get(...p: any[]): T | undefined; all(...p: any[]): T[] };
type Stmt1Run<T> = { run(...p: any[]): { changes: number; lastInsertRowid: number | bigint }; get(...p: any[]): T | undefined; all(...p: any[]): T[] };

export class CriticalStore {
  private readonly db: DB;

  constructor(db?: DB) {
    const target = db ?? getSqlite();
    ensureMigrations(target);
    this.db = target;
  }

  private stmts!: {
    insertTask: Stmt1Run<unknown>;
    updateStatus: Stmt1Run<unknown>;
    getTask: Stmt1<CriticalTaskRow>;
    findByFocus: Stmt1<CriticalTaskRow>;
    listByStatus: Stmt1<CriticalTaskRow>;
    listByPatient: Stmt1<CriticalTaskRow>;
    insertAudit: Stmt1Run<unknown>;
    queryAudits: Stmt1<CriticalAuditRow>;
    queryDeniedAudits: Stmt1<CriticalAuditRow>;
  };

  private initStmts(): void {
    if (this.stmts) return;
    this.stmts = {
      insertTask: this.db.prepare(`INSERT INTO critical_tasks (id, patient_id, status, focus_diagnostic_id, focus_observation_code, priority, reason_text, created_at, updated_at, focus_value, focus_unit, focus_test_code, focus_test_display, focus_severity)
        VALUES (@id, @patient_id, @status, @focus_diagnostic_id, @focus_observation_code, @priority, @reason_text, @created_at, @updated_at, @focus_value, @focus_unit, @focus_test_code, @focus_test_display, @focus_severity)`) as unknown as Stmt1Run<unknown>,
      updateStatus: this.db.prepare(`UPDATE critical_tasks
        SET status = ?, updated_at = ?,
            received_at = CASE WHEN ? = 'received' AND received_at IS NULL THEN ? ELSE received_at END
        WHERE id = ?`) as unknown as Stmt1Run<unknown>,
      getTask: this.db.prepare(`SELECT id, patient_id, status, focus_diagnostic_id, focus_observation_code, priority, reason_text, created_at, updated_at, received_at, focus_value, focus_unit, focus_test_code, focus_test_display, focus_severity
        FROM critical_tasks WHERE id = ?`) as unknown as Stmt1<CriticalTaskRow>,
      findByFocus: this.db.prepare(`SELECT id, patient_id, status, focus_diagnostic_id, focus_observation_code, priority, reason_text, created_at, updated_at, received_at, focus_value, focus_unit, focus_test_code, focus_test_display, focus_severity
        FROM critical_tasks WHERE focus_diagnostic_id = ? AND focus_observation_code = ? AND status != 'cancelled' LIMIT 1`) as unknown as Stmt1<CriticalTaskRow>,
      listByStatus: this.db.prepare(`SELECT id, patient_id, status, focus_diagnostic_id, focus_observation_code, priority, reason_text, created_at, updated_at, received_at, focus_value, focus_unit, focus_test_code, focus_test_display, focus_severity
        FROM critical_tasks WHERE status = ? ORDER BY updated_at DESC LIMIT ?`) as unknown as Stmt1<CriticalTaskRow>,
      listByPatient: this.db.prepare(`SELECT id, patient_id, status, focus_diagnostic_id, focus_observation_code, priority, reason_text, created_at, updated_at, received_at, focus_value, focus_unit, focus_test_code, focus_test_display, focus_severity
        FROM critical_tasks WHERE patient_id = ? ORDER BY updated_at DESC LIMIT ?`) as unknown as Stmt1<CriticalTaskRow>,
      insertAudit: this.db.prepare(`INSERT INTO critical_audit_events (task_id, agent, agent_display, recorded, source, outcome, reason, context)
        VALUES (@task_id, @agent, @agent_display, @recorded, @source, @outcome, @reason, @context)`) as unknown as Stmt1Run<unknown>,
      queryAudits: this.db.prepare(`SELECT id, task_id, agent, agent_display, recorded, source, outcome, reason, context
        FROM critical_audit_events WHERE task_id = ? ORDER BY recorded ASC`) as unknown as Stmt1<CriticalAuditRow>,
      queryDeniedAudits: this.db.prepare(`SELECT id, task_id, agent, agent_display, recorded, source, outcome, reason, context
        FROM critical_audit_events WHERE outcome = 'denied' AND recorded >= ? AND recorded <= ? ORDER BY recorded DESC LIMIT ?`) as unknown as Stmt1<CriticalAuditRow>,
    };
  }

  /** 注入 db（用于测试） */
  static withDb(db: DB): CriticalStore {
    return new CriticalStore(db);
  }

  /** 只读暴露底层 db 句柄（T24 升级链 / T26 台账的聚合查询用） */
  get rawDb(): DB { return this.db; }

  /** 创建 Task（直接 insert，不走 mutex；mutex 由 state-machine 包） */
  async createTask(input: {
    id: string;
    patient_id: string;
    status: string;
    focus_diagnostic_id: string;
    focus_observation_code: string;
    priority: string;
    reason_text?: string | null;
    created_at: string;
    updated_at: string;
    /** T31 · 展示用快照字段（与 broadcast critical.detected 同源） */
    focus_value?: string | null;
    focus_unit?: string | null;
    focus_test_code?: string | null;
    focus_test_display?: string | null;
    focus_severity?: string | null;
  }): Promise<CriticalTaskRow> {
    this.initStmts();
    // T9：focus 幂等 —— 同一份报告 + 同一检验项只产一条 Task。
    // 上游状态机已按 focus 查重，但通道重连 / 报文重放仍可能并发落到 store 层，
    // 因此把去重下沉到持久层兜底，避免「同一危急值两条闭环台账」。
    const duplicate = await this.findTaskByFocus(input.focus_diagnostic_id, input.focus_observation_code);
    if (duplicate) {
      log.debug({ taskId: duplicate.id, requestedId: input.id }, 'createTask dedup by focus');
      return duplicate;
    }
    this.stmts.insertTask.run({
      id: input.id,
      patient_id: input.patient_id,
      status: input.status,
      focus_diagnostic_id: input.focus_diagnostic_id,
      focus_observation_code: input.focus_observation_code,
      priority: input.priority,
      reason_text: input.reason_text ?? null,
      created_at: input.created_at,
      updated_at: input.updated_at,
      focus_value: input.focus_value ?? null,
      focus_unit: input.focus_unit ?? null,
      focus_test_code: input.focus_test_code ?? null,
      focus_test_display: input.focus_test_display ?? null,
      focus_severity: input.focus_severity ?? null,
    });
    log.debug({ taskId: input.id, patientId: input.patient_id }, 'task inserted');
    return this.getTaskOrThrow(input.id);
  }

  /** 查 Task by id */
  async getTask(id: string): Promise<CriticalTaskRow | null> {
    this.initStmts();
    const row = this.stmts.getTask.get(id) as CriticalTaskRow | undefined;
    return row ?? null;
  }

  /** 查 Task by id 或抛 */
  async getTaskOrThrow(id: string): Promise<CriticalTaskRow> {
    const row = await this.getTask(id);
    if (!row) throw new Error(`Task 不存在: ${id}`);
    return row;
  }

  /** 按 focus 查（去重用） */
  async findTaskByFocus(focusDiagnosticId: string, focusObservationCode: string): Promise<CriticalTaskRow | null> {
    this.initStmts();
    const row = this.stmts.findByFocus.get(focusDiagnosticId, focusObservationCode) as CriticalTaskRow | undefined;
    return row ?? null;
  }

  /** 按状态列表 */
  async listByStatus(status: string, limit = 50): Promise<CriticalTaskRow[]> {
    this.initStmts();
    return this.stmts.listByStatus.all(status, limit) as CriticalTaskRow[];
  }

  /** 全量列表（工具层 / 台账按时间区间筛选的上游） */
  async listAll(limit = 1000): Promise<CriticalTaskRow[]> {
    return this.db.prepare(`SELECT id, patient_id, status, focus_diagnostic_id, focus_observation_code,
      priority, reason_text, created_at, updated_at, received_at, focus_value, focus_unit,
      focus_test_code, focus_test_display, focus_severity FROM critical_tasks
      ORDER BY created_at ASC LIMIT ?`).all(limit) as CriticalTaskRow[];
  }

  /** 按 patient 列表 */
  async listByPatient(patientId: string, limit = 50): Promise<CriticalTaskRow[]> {
    this.initStmts();
    return this.stmts.listByPatient.all(patientId, limit) as CriticalTaskRow[];
  }

  /** 更新状态 */
  async updateTaskStatus(id: string, status: string, updatedAt: string): Promise<CriticalTaskRow> {
    this.initStmts();
    const r = this.stmts.updateStatus.run(status, updatedAt, status, updatedAt, id);
    if (r.changes === 0) throw new Error(`Task 不存在: ${id}`);
    return this.getTaskOrThrow(id);
  }

  /** 写 AuditEvent */
  async writeAudit(input: {
    task_id: string;
    agent: string;
    agent_display?: string | null;
    recorded: string;
    source: string;
    outcome: 'success' | 'denied' | 'partial' | 'fallback_rules';
    reason?: string | null;
    context?: Record<string, unknown> | null;
    /** T9：传入则按该键幂等去重（同一状态变更重复投递只留一条审计） */
    dedupeKey?: string;
  }): Promise<CriticalAuditRow> {
    this.initStmts();
    const ctxJson = input.context ? JSON.stringify(input.context) : null;
    if (input.dedupeKey) {
      const seen = this.db
        .prepare('SELECT audit_id FROM critical_audit_dedupe WHERE dedupe_key = ?')
        .get(input.dedupeKey) as { audit_id: number } | undefined;
      if (seen) {
        const existing = this.getAuditById(seen.audit_id);
        if (existing) return existing;
      }
    }
    const r = this.stmts.insertAudit.run({
      task_id: input.task_id,
      agent: input.agent,
      agent_display: input.agent_display ?? null,
      recorded: input.recorded,
      source: input.source,
      outcome: input.outcome,
      reason: input.reason ?? null,
      context: ctxJson,
    });
    const auditId = Number(r.lastInsertRowid);
    if (input.dedupeKey) {
      this.db.prepare('INSERT OR IGNORE INTO critical_audit_dedupe (dedupe_key, audit_id) VALUES (?, ?)')
        .run(input.dedupeKey, auditId);
    }
    log.debug({ taskId: input.task_id, outcome: input.outcome, agent: input.agent }, 'audit written');
    return {
      id: auditId,
      task_id: input.task_id,
      agent: input.agent,
      agent_display: input.agent_display ?? null,
      recorded: input.recorded,
      source: input.source,
      outcome: input.outcome,
      reason: input.reason ?? null,
      context: ctxJson,
    };
  }

  /** 按主键取审计行（dedupe 命中时回读用） */
  getAuditById(id: number): CriticalAuditRow | null {
    const row = this.db.prepare(`SELECT id, task_id, agent, agent_display, recorded, source, outcome, reason, context
      FROM critical_audit_events WHERE id = ?`).get(id) as CriticalAuditRow | undefined;
    return row ?? null;
  }

  /** 统计 Task 行数（压测 / 台账对账用） */
  countTasks(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM critical_tasks').get() as { n: number }).n;
  }

  /** 按 focus 唯一键删除（仅测试夹具用） */
  dropTask(id: string): void {
    this.db.prepare('DELETE FROM critical_tasks WHERE id = ?').run(id);
  }

  /** 查 Task 全审计链（按 recorded ASC 还原时间序） */
  async queryAuditChain(taskId: string): Promise<CriticalAuditRow[]> {
    this.initStmts();
    return this.stmts.queryAudits.all(taskId) as CriticalAuditRow[];
  }

  /** 查 denied audits（飞检倒查） */
  async queryDeniedAudits(timeRange: { from: string; to: string }, limit = 100): Promise<CriticalAuditRow[]> {
    this.initStmts();
    return this.stmts.queryDeniedAudits.all(timeRange.from, timeRange.to, limit) as CriticalAuditRow[];
  }
}

/** 单例 store（懒初始化） */
let _store: CriticalStore | null = null;
export function getCriticalStore(): CriticalStore {
  if (!_store) _store = new CriticalStore();
  return _store;
}
export function _resetCriticalStoreForTest(): void {
  _store = null;
}