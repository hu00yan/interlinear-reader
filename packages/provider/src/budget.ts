// Cost counting + cap circuit breaker. Tripped breaker blocks new spend
// until reset(). Token estimates are chars/4 when the API reports no usage.

import type { PricePer1k, UsageInfo } from "./types.ts";

export class BudgetExceededError extends Error {
  code = "E_BUDGET";
  usage: UsageInfo;
  constructor(message: string, usage: UsageInfo) {
    super(message);
    this.name = "BudgetExceededError";
    this.usage = usage;
  }
}

/** Rough token estimate for budgeting when usage is absent. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface BudgetCaps {
  maxCostUsd?: number;
  maxTokens?: number;
  prices?: PricePer1k;
}

export class BudgetTracker {
  private caps: BudgetCaps;
  private inputTokens = 0;
  private outputTokens = 0;
  private requests = 0;
  tripped = false;

  constructor(caps: BudgetCaps = {}) {
    this.caps = { ...caps };
  }

  get costUsd(): number {
    const p = this.caps.prices;
    if (!p) return 0;
    return (this.inputTokens / 1000) * p.input + (this.outputTokens / 1000) * p.output;
  }

  snapshot(): UsageInfo {
    return {
      requests: this.requests,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      tripped: this.tripped,
    };
  }

  /** Pre-flight check: throws BudgetExceededError once a cap has been hit. */
  ensure(): void {
    if (this.tripped) {
      throw new BudgetExceededError("budget breaker is tripped", this.snapshot());
    }
    const { maxCostUsd, maxTokens, prices } = this.caps;
    if (maxTokens !== undefined && this.inputTokens + this.outputTokens > maxTokens) {
      this.tripped = true;
      throw new BudgetExceededError(`token cap exceeded: total>${maxTokens}`, this.snapshot());
    }
    if (maxCostUsd !== undefined && prices && this.costUsd > maxCostUsd) {
      this.tripped = true;
      throw new BudgetExceededError(
        `cost cap exceeded: cost>$${maxCostUsd}`,
        this.snapshot(),
      );
    }
  }

  /** Post-flight accounting. Breaching a cap latches the breaker. */
  record(input: number, output: number): UsageInfo {
    this.requests += 1;
    this.inputTokens += input;
    this.outputTokens += output;
    const { maxCostUsd, maxTokens, prices } = this.caps;
    if (maxTokens !== undefined && this.inputTokens + this.outputTokens > maxTokens) {
      this.tripped = true;
    }
    if (maxCostUsd !== undefined && prices && this.costUsd > maxCostUsd) {
      this.tripped = true;
    }
    return this.snapshot();
  }

  reset(): void {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.requests = 0;
    this.tripped = false;
  }
}
