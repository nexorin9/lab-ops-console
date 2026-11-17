/**
 * redact —— 日志脱敏（飞检/运维合规底线：日志里不得出现可直接定位患者的明文）
 *
 * 设计原则：
 * - 凡涉及患者身份/证件/联系方式的字段一律遮罩为固定哨兵值，不落明文
 * - 已做哈希的字段（如 patientHash）不在遮罩之列 —— 哈希值不可逆向，反而该保留
 *   以便跨系统关联与排障（遮罩的是「能直接读出张三李四」的字段，不是所有 id）
 * - 递归处理嵌套对象/数组，避免漏掉深层敏感字段
 * - 不修改入参（纯函数，返回新对象），调用方可安全复用
 */

export const REDACTED = '***';

/** 敏感字段名（大小写不敏感匹配） */
export const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'patientid', 'patient_id', 'patientname', 'name', 'mrn', 'medicalrecordno',
  'idcard', 'id_card', 'idnumber', 'id', 'ssn', 'socialsecurityno',
  'phone', 'mobile', 'tel', 'telephone', 'address', 'birthday', 'birthdate',
  'birth', 'gender', 'sex', 'nationalid', 'bankcard', 'cardno', 'idno',
]);

/**
 * 递归脱敏：命中敏感 key 的值替换为 REDACTED；其余递归处理。
 * 非对象/数组原样返回。
 */
export function redactContext<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => redactContext(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = redactContext(v);
      }
    }
    return out as T;
  }
  return value;
}

/**
 * 字符串脱敏：若字符串命中身份证/手机号/银行卡模式，遮罩中间段。
 * 用于「值本身」就是敏感数据的场景（而非仅靠 key 识别）。
 * 不命中则返回原串。
 */
export function redactValue(input: string): string {
  // 身份证：18 位（含 X）
  if (/^\d{17}[\dXx]$/.test(input)) {
    return `${input.slice(0, 6)}${REDACTED}${input.slice(-4)}`;
  }
  // 手机号：1 开头 11 位
  if (/^1\d{10}$/.test(input)) {
    return `${input.slice(0, 3)}${REDACTED}${input.slice(-2)}`;
  }
  // 银行卡：15-19 位数字
  if (/^\d{15,19}$/.test(input)) {
    return `${input.slice(0, 6)}${REDACTED}${input.slice(-4)}`;
  }
  return input;
}
