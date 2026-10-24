import { getKeyPrefix } from './redis.js';
import { API_DAILY_TTL_SECONDS, secondsUntilUtcMidnight } from './api-key-rate-limit';

/**
 * Daily direct-LLM allowance per principal (a verified partner account, or a
 * hashed client address for everyone else). NucMonitor has no plans, so this
 * is one flat ceiling: it bounds provider spend, it is not a product tier.
 * Operator keys are metered against their own circuit-breaker ceiling
 * (high-usage-alarm.ts) instead.
 */
export const DIRECT_LLM_DAILY_QUOTA_LIMIT = 500;
export const DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS = 30;

export const DIRECT_LLM_GATEWAY_QUOTA_PATHS = new Set<string>([
  '/api/market/v1/analyze-stock',
  '/api/news/v1/summarize-article',
]);

// The chat analyst and widget agent that metered themselves were retired with
// the trim; no self-metered direct-LLM endpoint remains.
export const DIRECT_LLM_SELF_METERED_QUOTA_PATHS = new Set<string>([]);

export const DIRECT_LLM_QUOTA_PATHS = new Set<string>([
  ...DIRECT_LLM_GATEWAY_QUOTA_PATHS,
  ...DIRECT_LLM_SELF_METERED_QUOTA_PATHS,
]);

export type DirectLlmQuotaReservation =
  | { ok: true; newCount: number; rollback: () => Promise<void> }
  | {
      ok: false;
      reason: 'cap-exceeded' | 'redis-unavailable';
      floor?: number;
      retryAfterSec: number;
    };

export type DirectLlmQuotaPipeline = (
  commands: Array<Array<string | number>>,
) => Promise<Array<{ result?: unknown }>>;

export function directLlmDailyQuotaKey(userId: string, date?: Date): string {
  if (!userId) return '';
  const d = date ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${getKeyPrefix()}llm:direct-usage:${userId}:${yyyy}-${mm}-${dd}`;
}

export async function reserveDirectLlmQuota(opts: {
  userId: string;
  pipeline: DirectLlmQuotaPipeline;
  limit?: number;
  date?: Date;
}): Promise<DirectLlmQuotaReservation> {
  const limit = typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit >= 0
    ? opts.limit
    : DIRECT_LLM_DAILY_QUOTA_LIMIT;
  const retryAfterSec = secondsUntilUtcMidnight(opts.date);
  const key = directLlmDailyQuotaKey(opts.userId, opts.date);
  if (!key) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  let pipeResult: Array<{ result?: unknown }> | null;
  try {
    pipeResult = await opts.pipeline([
      ['INCR', key],
      ['EXPIRE', key, API_DAILY_TTL_SECONDS],
    ]);
  } catch {
    pipeResult = null;
  }

  if (!pipeResult || !Array.isArray(pipeResult) || pipeResult.length === 0) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  const incrRaw = pipeResult[0]?.result;
  const newCount = typeof incrRaw === 'number' ? incrRaw : Number(incrRaw);
  if (!Number.isFinite(newCount) || newCount < 1) {
    return {
      ok: false,
      reason: 'redis-unavailable',
      retryAfterSec: DIRECT_LLM_REDIS_UNAVAILABLE_RETRY_AFTER_SECONDS,
    };
  }

  let rolledBack = false;
  const rollback = async (): Promise<void> => {
    if (rolledBack) return;
    rolledBack = true;
    try {
      await opts.pipeline([['DECR', key]]);
    } catch {
      // Best-effort: over-counting by one is the cost-protection-correct direction.
    }
  };

  if (newCount > limit) {
    await rollback();
    return {
      ok: false,
      reason: 'cap-exceeded',
      floor: limit,
      retryAfterSec,
    };
  }

  return { ok: true, newCount, rollback };
}
