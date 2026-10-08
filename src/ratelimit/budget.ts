import { DEFAULT_AGENT_INPUT_USD_PER_MTOK } from "../model/pi-models.ts";
import { foldPrincipalId, personIds } from "../directory/person.ts";
interface BudgetCheck {
  allowed: boolean;
  spentUsd: number;
  limitUsd: number;
}

export interface BudgetTracker {
  check(principalId: string, now?: number): Promise<BudgetCheck>;
  record(principalId: string, costUsd: number, now?: number): Promise<void>;
}

export const DEFAULT_BUDGET_WINDOW_MS = 86_400_000;

export function estimateCostUsd(inputTokens: number, usdPerMTok = DEFAULT_AGENT_INPUT_USD_PER_MTOK): number {
  return (inputTokens / 1_000_000) * usdPerMTok;
}

export interface BudgetOpts {
  limitUsd?: number;
  orgLimitUsd?: number;
  windowMs?: number;
  /** Per-person caps that replace `limitUsd`, keyed by email or Slack ID (BUDGET_USD_OVERRIDES). */
  limitOverrides?: Record<string, number>;
}

/** Resolves a principal's cap: an override for any of its linked ids (email ⇄ Slack), else the default. */
export function budgetLimitFor(opts: BudgetOpts): (principalId: string) => number {
  const fallback = opts.limitUsd ?? Infinity;
  const overrides = new Map(Object.entries(opts.limitOverrides ?? {}).map(([k, v]) => [foldPrincipalId(k), v]));
  if (overrides.size === 0) return () => fallback;
  return (principalId) => {
    for (const id of [principalId, ...personIds(principalId)]) {
      const hit = overrides.get(foldPrincipalId(id));
      if (hit !== undefined) return hit;
    }
    return fallback;
  };
}

export function createBudgetTracker(opts: BudgetOpts = {}): BudgetTracker {
  const limitFor = budgetLimitFor(opts);
  const orgLimitUsd = opts.orgLimitUsd ?? Infinity;
  const windowMs = opts.windowMs ?? DEFAULT_BUDGET_WINDOW_MS;
  const spend = new Map<string, Array<{ at: number; usd: number }>>();
  const orgKey = "@org";

  function spentIn(principalId: string, now: number): number {
    const cutoff = now - windowMs;
    const kept = (spend.get(principalId) ?? []).filter((e) => e.at >= cutoff);
    spend.set(principalId, kept);
    return kept.reduce((s, e) => s + e.usd, 0);
  }

  return {
    async check(principalId, now = Date.now()) {
      const spentUsd = spentIn(principalId, now);
      const limitUsd = limitFor(principalId);
      if (spentUsd >= limitUsd) return { allowed: false, spentUsd, limitUsd };
      const orgSpent = spentIn(orgKey, now);
      return { allowed: orgSpent < orgLimitUsd, spentUsd: orgSpent, limitUsd: orgLimitUsd };
    },
    async record(principalId, costUsd, now = Date.now()) {
      for (const key of [principalId, orgKey]) {
        const list = spend.get(key) ?? [];
        list.push({ at: now, usd: costUsd });
        spend.set(key, list);
      }
    },
  };
}
