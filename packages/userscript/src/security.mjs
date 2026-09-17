export const CONFIG = "ilr-config-v1";
export const SESSION_ONLY = "ilr-session-only-v1";
export const CONFIRMED_ENDPOINT = "ilr-confirmed-endpoint-v1";
export const KEY_WARNING =
  "⚠️ 密钥安全：能访问你电脑的恶意程序或恶意浏览器扩展可能窃取密钥并耗尽余额。本程序无法从技术上防御本机恶意软件。";
export const KEY_ADVICE =
  "默认记住密钥，写入脚本管理器本地磁盘存储；菜单可切换“仅本次会话（不保存）”。建议使用低余额、设置消费/用量限额的专用密钥：OpenAI Dashboard → Usage limits / 项目限额；Anthropic Console → Spend limits；DeepSeek/月之暗面等类似后台。确认限额是否硬性执行（有些预算仅提醒），定期轮换，发现异常立即吊销。";

export function maskKey(key) {
  return key ? (key.length > 8 ? `sk-…${key.slice(-4)}` : "••••") : "未设置";
}

export function keySummary(config) {
  if (!config?.key) return "密钥：未设置";
  const time = config.keyUpdatedAt ? new Date(config.keyUpdatedAt) : null;
  const updated = time && !Number.isNaN(time.getTime()) ? time.toISOString() : "未知（旧配置）";
  return `密钥：${maskKey(config.key)} · ${config.rememberKey ? "已记住（本地磁盘）" : "仅本次会话（不保存）"} · 更新：${updated} · 建议定期轮换`;
}

// Exact allowlist: never derive a navigation target from page DOM or an endpoint path.
export function providerConsole(endpoint) {
  let host;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return null;
  }
  return (
    {
      "api.openai.com": {
        name: "OpenAI Usage limits / 项目限额",
        url: "https://platform.openai.com/settings/organization/limits",
      },
      "api.anthropic.com": {
        name: "Anthropic Spend limits",
        url: "https://console.anthropic.com/settings/limits",
      },
      "api.deepseek.com": {
        name: "DeepSeek 用量 / 余额",
        url: "https://platform.deepseek.com/usage",
      },
      "api.moonshot.cn": {
        name: "月之暗面 用量 / 余额",
        url: "https://platform.moonshot.cn/console",
      },
      "api.moonshot.ai": {
        name: "Moonshot 用量 / 余额",
        url: "https://platform.moonshot.ai/console",
      },
    }[host] ?? null
  );
}

export class KeySettings {
  constructor(get, set) {
    this.get = get;
    this.set = set;
    this.sessionOnly = get(SESSION_ONLY, false) === true;
    const saved = get(CONFIG, null);
    this.config = saved ? { ...saved, rememberKey: saved.rememberKey !== false } : null;
    if (this.config && (this.sessionOnly || !this.config.rememberKey)) {
      this.config.key = "";
      this.config.rememberKey = false;
      set(CONFIG, null);
    }
    this.confirmedEndpoint = get(CONFIRMED_ENDPOINT, "");
  }
  configure(endpoint, model, key, rememberKey = !this.sessionOnly) {
    this.config = {
      endpoint,
      model,
      key,
      rememberKey,
      keyUpdatedAt: key ? new Date().toISOString() : null,
    };
    this.setSessionOnly(!rememberKey);
    this.confirmedEndpoint = "";
    this.set(CONFIRMED_ENDPOINT, "");
  }
  setSessionOnly(sessionOnly) {
    this.sessionOnly = sessionOnly;
    this.set(SESSION_ONLY, sessionOnly);
    if (this.config) this.config.rememberKey = !sessionOnly;
    this.set(CONFIG, !sessionOnly && this.config?.key ? { ...this.config } : null);
  }
  forget() {
    this.setSessionOnly(true);
  }
  needsEndpointConfirmation(endpoint) {
    return this.confirmedEndpoint !== endpoint;
  }
  confirmEndpoint(endpoint) {
    this.confirmedEndpoint = endpoint;
    this.set(CONFIRMED_ENDPOINT, endpoint);
  }
}
