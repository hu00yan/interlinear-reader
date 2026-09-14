import { Mode, type TargetLang } from '../types.js';

export interface Settings {
  baseUrl: string;
  apiKey: string;
  model: string;
  target: TargetLang;
  mode: Mode;
  /** 费用上限（USD），仅本地显示/拦截，不上传 */
  costCapUSD: number;
  costUsedUSD: number;
  /** 释义显隐总开关 */
  showGloss: boolean;
  /** 三级过滤 */
  hideStopwords: boolean;
  hideKnown: boolean;
  /** 词频过滤：只隐藏词频排名前 N 的词的释义（0=关闭）。真词频表由 Track C 提供，此处为启发式占位。 */
  freqHideTopN: number;
  pageSize: number;
}

const KEY = 'ilr.settings.v1';
/**
 * CONTRACT 键（CONTRACT.md 主张，不动原文，此处做双写/迁移兼容）：
 * - `ilr:key`：BYOK 原始 key，只去 LLM provider 域，永不随 /api/* 发送。
 * - `ilr:mode`：模式，小写 `a|b|c`（内部 Mode 枚举为大写 A/B/C，此处映射）。
 * 规范存储仍是 `ilr.settings.v1` JSON；save 时双写两份，load 时迁移合并。
 */
export const CONTRACT_KEY = 'ilr:key';
export const CONTRACT_MODE = 'ilr:mode';

export function modeToContractValue(mode: Mode): 'a' | 'b' | 'c' {
  return mode === Mode.B ? 'b' : mode === Mode.C ? 'c' : 'a';
}

export function modeFromContractValue(v: unknown): Mode | null {
  const s = String(v ?? '').toLowerCase();
  if (s === 'a') return Mode.A;
  if (s === 'b') return Mode.B;
  if (s === 'c') return Mode.C;
  return null;
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  target: 'zh',
  mode: Mode.A,
  costCapUSD: 5,
  costUsedUSD: 0,
  showGloss: true,
  hideStopwords: false,
  hideKnown: false,
  freqHideTopN: 0,
  pageSize: 20,
};

export function loadSettings(): Settings {
  let base: Settings;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) base = { ...DEFAULT_SETTINGS };
    else base = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    base = { ...DEFAULT_SETTINGS };
  }
  // CONTRACT 键迁移：ilr:key / ilr:mode 存在即为准（跨轨 pin 的口径；save 双写保证平时一致）。
  try {
    const legacyKey = localStorage.getItem(CONTRACT_KEY);
    if (legacyKey != null) {
      base.apiKey = legacyKey;
    }
    const legacyMode = localStorage.getItem(CONTRACT_MODE);
    const mapped = modeFromContractValue(legacyMode);
    if (mapped) {
      base.mode = mapped;
    }
  } catch {
    // localStorage 不可用时忽略迁移
  }
  // 规范键里若存的是小写（手改/外部写入），一并归一化为内部大写枚举。
  const normalized = modeFromContractValue(base.mode);
  if (normalized) base.mode = normalized;
  return base;
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
  // 双写 CONTRACT 键（BYOK 与模式的跨轨口径；清理逻辑按 ilr. 前缀已覆盖）。
  try {
    localStorage.setItem(CONTRACT_KEY, s.apiKey);
    localStorage.setItem(CONTRACT_MODE, modeToContractValue(s.mode));
  } catch {
    // 配额满等：规范键已写成功，CONTRACT 镜像失败不抛错
  }
}

export function resetCost(s: Settings): Settings {
  return { ...s, costUsedUSD: 0 };
}
