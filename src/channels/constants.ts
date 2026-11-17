/**
 * HL7 v2 control characters
 * - VT (Vertical Tab, 0x0B): start of HL7 frame
 * - FS (File Separator, 0x1C): end of HL7 frame body
 * - CR (Carriage Return, 0x0D): terminator (immediately follows FS)
 */
export const VT = 0x0b;
export const FS = 0x1c;
export const CR = 0x0d;

/** Default HL7 v2 encoding */
export const DEFAULT_ENCODING = 'utf-8';

/** Common field separators */
export const FIELD_SEP = '|';
export const COMPONENT_SEP = '^';
export const REPETITION_SEP = '~';
export const ESCAPE_CHAR = '\\';
export const SUBCOMPONENT_SEP = '&';

/** Acknowledgement codes */
export const ACK_AA = 'AA'; // Application Accept
export const ACK_CA = 'CA'; // Application Accept (commit) — also used as error ack
export const ACK_AE = 'AE'; // Application Error
export const ACK_AR = 'AR'; // Application Reject

/** Force-drain timeout on Hl7Server.stop(): graceful close, then force after timeout */
export const DEFAULT_FORCE_DRAIN_TIMEOUT_MS = 10_000;

/** Graceful close timeout on Hl7Connection.close(): end() → destroy() */
export const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;

/**
 * HL7 v2 帧体内允许出现的控制字符（白名单）。
 * - 0x0D (CR)：HL7 v2 段分隔符
 * - 0x0A (LF)：部分仪器用 LF 作段分隔符（兜底接受）
 * 其余 C0 控制字符（0x00–0x1F）与 0x7F 一律视为非法帧 → 拒收进 DLQ。
 */
export const ALLOWED_BODY_CONTROL_CHARS = new Set<number>([0x0d, 0x0a]);

/** 非法控制字符的判定范围（C0 + DEL） */
export const ILLEGAL_CONTROL_CHAR_RANGE = { min: 0x00, max: 0x1f, del: 0x7f } as const;
