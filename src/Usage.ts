import type { AgentHarness } from './types';
export type UsageProvider = AgentHarness;

export interface UsageTokenTotals {
  total?: number;
  input?: number;
  output?: number;
  cachedInput?: number;
  cacheWriteInput?: number;
  reasoning?: number;
}

export interface UsageQuotaWindow {
  label: string;
  usedPercent?: number;
  resetsAt?: number;
  durationMinutes?: number;
  status?: 'allowed' | 'allowed_warning' | 'rejected';
  limitType?: string;
}

export interface UsageSnapshot {
  provider: UsageProvider;
  updatedAt: number;
  tokens?: UsageTokenTotals;
  lastTurnTokens?: UsageTokenTotals;
  turns?: number;
  estimatedCostUsd?: number;
  models?: Array<{
    model: string; input?: number; output?: number; cachedInput?: number; cacheWriteInput?: number;
    webSearchRequests?: number; estimatedCostUsd?: number; contextWindow?: number; maxOutputTokens?: number;
    canonicalModel?: string; provider?: string;
  }>;
  quotaWindows: UsageQuotaWindow[];
  plan?: string;
  credits?: { available?: boolean; unlimited?: boolean; balance?: string | number };
  resetCredits?: Record<string, unknown>;
  overage?: {
    active?: boolean; inUse?: boolean; status?: string; resetsAt?: number; disabledReason?: string;
    surpassedThreshold?: number; errorCode?: string; canPurchaseCredits?: boolean; hasSavedPaymentMethod?: boolean;
  };
  accountUsage?: AccountUsage;
  accountUsageUnavailable?: string;
}

export interface AccountUsage {
  lifetimeTokens?: number;
  peakDailyTokens?: number;
  longestRunningTurnSeconds?: number;
  currentStreakDays?: number;
  longestStreakDays?: number;
  daily: Array<{ date: string; tokens: number }>;
}

function finite(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  const n = finite(value);
  if (n === undefined) return undefined;
  return n < 1_000_000_000_000 ? n * 1000 : n;
}

function percent(value: unknown): number | undefined {
  const n = finite(value);
  if (n === undefined) return undefined;
  return Math.max(0, Math.min(100, n <= 1 ? n * 100 : n));
}

function title(value: string): string {
  const words = value.replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function normalizeClaudeResult(result: Record<string, any>, now = Date.now()): UsageSnapshot {
  const usage = result.usage ?? {};
  const models = Object.entries(result.modelUsage ?? result.model_usage ?? {}).map(([model, raw]) => {
    const item = raw as Record<string, unknown>;
    return {
      model,
      input: finite(item.inputTokens ?? item.input_tokens),
      output: finite(item.outputTokens ?? item.output_tokens),
      cachedInput: finite(item.cacheReadInputTokens ?? item.cache_read_input_tokens),
      cacheWriteInput: finite(item.cacheCreationInputTokens ?? item.cache_creation_input_tokens),
      webSearchRequests: finite(item.webSearchRequests ?? item.web_search_requests),
      estimatedCostUsd: finite(item.costUSD ?? item.cost_usd),
      contextWindow: finite(item.contextWindow ?? item.context_window),
      maxOutputTokens: finite(item.maxOutputTokens ?? item.max_output_tokens),
      canonicalModel: typeof item.canonicalModel === 'string' ? item.canonicalModel : undefined,
      provider: typeof item.provider === 'string' ? item.provider : undefined,
    };
  });
  const hasModelUsage = models.length > 0;
  const aggregate = hasModelUsage ? models.reduce<Required<Pick<UsageTokenTotals, 'input' | 'output' | 'cachedInput' | 'cacheWriteInput'>>>(
    (sum, model) => ({
      input: sum.input + (model.input ?? 0), output: sum.output + (model.output ?? 0),
      cachedInput: sum.cachedInput + (model.cachedInput ?? 0), cacheWriteInput: sum.cacheWriteInput + (model.cacheWriteInput ?? 0),
    }),
    { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0 },
  ) : null;
  const tokens: UsageTokenTotals = aggregate ? {
    ...aggregate,
    total: aggregate.input + aggregate.output + aggregate.cachedInput + aggregate.cacheWriteInput,
  } : {
    input: finite(usage.input_tokens), output: finite(usage.output_tokens),
    cachedInput: finite(usage.cache_read_input_tokens), cacheWriteInput: finite(usage.cache_creation_input_tokens),
  };
  return {
    provider: 'claude', updatedAt: now, quotaWindows: [],
    turns: finite(result.num_turns),
    estimatedCostUsd: finite(result.total_cost_usd),
    tokens,
    models,
  };
}

export function normalizeClaudeRateLimit(info: Record<string, any>, now = Date.now()): UsageSnapshot {
  const limitType = String(info.rateLimitType ?? info.rate_limit_type ?? '');
  const usedPercent = percent(info.utilization);
  const quotaWindows = (usedPercent !== undefined || info.resetsAt != null || limitType) ? [{
    label: limitType ? title(limitType) : 'Current window', usedPercent,
    resetsAt: timestampMs(info.resetsAt), status: info.status, limitType: limitType || undefined,
  }] : [];
  return {
    provider: 'claude', updatedAt: now, quotaWindows,
    overage: (info.isUsingOverage != null || info.overageStatus != null || info.overageResetsAt != null) ? {
      active: info.isUsingOverage, inUse: info.overageInUse, status: info.overageStatus,
      resetsAt: timestampMs(info.overageResetsAt), disabledReason: info.overageDisabledReason,
      surpassedThreshold: finite(info.surpassedThreshold), errorCode: info.errorCode,
      canPurchaseCredits: info.canUserPurchaseCredits, hasSavedPaymentMethod: info.hasChargeableSavedPaymentMethod,
    } : undefined,
  };
}

const CLAUDE_FIXED_WINDOWS = ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet'] as const;

/** Normalize the proactive SDK usage pull (structured plan rate-limit utilization). */
export function normalizeClaudeUsageResponse(response: Record<string, any>, now = Date.now()): UsageSnapshot {
  const limits = response.rate_limits;
  if (response.rate_limits_available === false || limits == null) {
    return { provider: 'claude', updatedAt: now, quotaWindows: [] };
  }
  const quotaWindows: UsageQuotaWindow[] = [];
  const push = (label: string, window: Record<string, any>) => {
    const usedPercent = window.utilization == null ? undefined : percent(window.utilization);
    quotaWindows.push({
      label, usedPercent, resetsAt: timestampMs(window.resets_at),
      status: (usedPercent ?? 0) >= 80 ? 'allowed_warning' : 'allowed',
    });
  };
  for (const key of CLAUDE_FIXED_WINDOWS) {
    if (limits[key] != null) push(title(key), limits[key]);
  }
  for (const scoped of limits.model_scoped ?? []) {
    if (scoped != null) push(String(scoped.display_name), scoped);
  }
  return { provider: 'claude', updatedAt: now, quotaWindows };
}

function durationLabel(minutes: number | undefined, fallback: string): string {
  if (!minutes) return title(fallback);
  if (minutes % 10080 === 0) return `${minutes / 1440} days`;
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? 'day' : 'days'}`;
  if (minutes % 60 === 0) return `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}`;
  return `${minutes} minutes`;
}

export function normalizeCodexRateLimits(rateLimits: Record<string, any>, now = Date.now()): UsageSnapshot {
  const quotaWindows: UsageQuotaWindow[] = [];
  for (const [key, raw] of Object.entries(rateLimits)) {
    if (!raw || typeof raw !== 'object' || !('usedPercent' in raw || 'resetsAt' in raw || 'windowDurationMins' in raw)) continue;
    const window = raw as Record<string, unknown>;
    const durationMinutes = finite(window.windowDurationMins);
    quotaWindows.push({
      label: durationLabel(durationMinutes, key), usedPercent: percent(window.usedPercent),
      resetsAt: timestampMs(window.resetsAt), durationMinutes,
      status: rateLimits.rateLimitReachedType ? 'rejected' : (percent(window.usedPercent) ?? 0) >= 80 ? 'allowed_warning' : 'allowed',
      limitType: key,
    });
  }
  const credits = rateLimits.credits;
  return {
    provider: 'codex', updatedAt: now, quotaWindows, plan: rateLimits.planType,
    credits: credits ? { available: credits.hasCredits, unlimited: credits.unlimited, balance: credits.balance } : undefined,
  };
}

/** Normalize the official read response while accepting legacy direct rateLimits payloads. */
export function normalizeCodexRateLimitResponse(response: Record<string, any>, now = Date.now()): UsageSnapshot {
  const byId = response.rateLimitsByLimitId as Record<string, Record<string, any>> | undefined;
  if (!byId || Object.keys(byId).length === 0) {
    return normalizeCodexRateLimits(response.rateLimits ?? response, now);
  }
  const quotaWindows: UsageQuotaWindow[] = [];
  let plan = response.rateLimits?.planType as string | undefined;
  let credits: UsageSnapshot['credits'];
  for (const [limitId, limits] of Object.entries(byId)) {
    const normalized = normalizeCodexRateLimits(limits, now);
    plan ??= normalized.plan;
    credits ??= normalized.credits;
    const prefix = title(limitId);
    for (const window of normalized.quotaWindows) {
      quotaWindows.push({ ...window, label: `${prefix} · ${window.label}` });
    }
  }
  const legacy = response.rateLimits ? normalizeCodexRateLimits(response.rateLimits, now) : null;
  plan ??= legacy?.plan;
  credits ??= legacy?.credits;
  return {
    provider: 'codex', updatedAt: now, quotaWindows, plan, credits,
    resetCredits: response.rateLimitResetCredits,
  };
}

export function normalizeCodexAccountUsage(response: Record<string, any>): AccountUsage {
  const summary = response.summary ?? {};
  return {
    lifetimeTokens: finite(summary.lifetimeTokens), peakDailyTokens: finite(summary.peakDailyTokens),
    longestRunningTurnSeconds: finite(summary.longestRunningTurnSec), currentStreakDays: finite(summary.currentStreakDays),
    longestStreakDays: finite(summary.longestStreakDays),
    daily: Array.isArray(response.dailyUsageBuckets) ? response.dailyUsageBuckets.map((bucket: Record<string, unknown>) => ({
      date: String(bucket.startDate ?? ''), tokens: finite(bucket.tokens) ?? 0,
    })) : [],
  };
}

function codexTotals(raw: Record<string, any> | undefined): UsageTokenTotals | undefined {
  if (!raw) return undefined;
  return {
    total: finite(raw.totalTokens), input: finite(raw.inputTokens), cachedInput: finite(raw.cachedInputTokens),
    cacheWriteInput: finite(raw.cacheWriteInputTokens), output: finite(raw.outputTokens), reasoning: finite(raw.reasoningOutputTokens),
  };
}

export function normalizeCodexTokenUsage(tokenUsage: Record<string, any>, now = Date.now()): UsageSnapshot {
  return { provider: 'codex', updatedAt: now, quotaWindows: [], tokens: codexTotals(tokenUsage.total), lastTurnTokens: codexTotals(tokenUsage.last) };
}

export function mergeUsageSnapshot(current: UsageSnapshot | null | undefined, update: UsageSnapshot): UsageSnapshot {
  if (!current || current.provider !== update.provider) return update;
  return {
    ...current, ...update, updatedAt: Math.max(current.updatedAt, update.updatedAt),
    tokens: update.tokens ?? current.tokens,
    lastTurnTokens: update.lastTurnTokens ?? current.lastTurnTokens,
    models: update.models ?? current.models,
    quotaWindows: update.quotaWindows.length ? update.quotaWindows : current.quotaWindows,
    credits: update.credits ?? current.credits, resetCredits: update.resetCredits ?? current.resetCredits,
    overage: update.overage ?? current.overage,
    accountUsage: Object.prototype.hasOwnProperty.call(update, 'accountUsage') ? update.accountUsage : current.accountUsage,
    accountUsageUnavailable: Object.prototype.hasOwnProperty.call(update, 'accountUsageUnavailable')
      ? update.accountUsageUnavailable : current.accountUsageUnavailable,
  };
}
