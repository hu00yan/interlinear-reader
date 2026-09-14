// 费用估算（纯本地启发式，OpenAI 兼容接口不返回统一计费字段时使用）。
// 真实账单以 provider 控制台为准；此处只做"费用上限显示/拦截"。

/** 按字符估算 token：CJK ~1.5字/token，拉丁 ~4字/token */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿]/g) || []).length;
  const other = Math.max(0, text.length - cjk);
  return Math.ceil(cjk / 1.5 + other / 4);
}

/** 默认单价（USD/1K tokens）。默认 gpt-4o-mini 量级，用户可在设置页按模型调整思路见 provider.ts */
export const DEFAULT_PRICE = { inputPer1K: 0.00015, outputPer1K: 0.0006 };

export function estimateCostUSD(inputText: string, outputText: string): number {
  const inTok = estimateTokens(inputText) / 1000;
  const outTok = estimateTokens(outputText) / 1000;
  return inTok * DEFAULT_PRICE.inputPer1K + outTok * DEFAULT_PRICE.outputPer1K;
}

export function formatUSD(n: number): string {
  return `$${n.toFixed(4)}`;
}
