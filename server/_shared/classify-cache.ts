/**
 * Classify cache contract shared by the feed digest reader and the relay's
 * classify seed. The intelligence RPCs that originally owned this moved out
 * with the intelligence domain; the key prefix and the hit validation stay
 * here so every remaining reader validates Redis-backed JSON the same way.
 */

import { sha256Hex } from './hash';

export const CLASSIFY_VALID_LEVELS = ['critical', 'high', 'medium', 'low', 'info'] as const;
export const CLASSIFY_VALID_CATEGORIES = [
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
] as const;

export function isValidClassifyHit(hit: { level: string; category: string }): boolean {
  return (CLASSIFY_VALID_LEVELS as readonly string[]).includes(hit.level)
    && (CLASSIFY_VALID_CATEGORIES as readonly string[]).includes(hit.category);
}

// Three sites read/write this prefix: this canonical builder, the digest
// reader at server/worldmonitor/news/v1/list-feed-digest.ts, and
// scripts/ais-relay.cjs (independent inline helper — cannot import from .ts).
// They are kept in lockstep by the news-classify-cache-prefix-audit test.
const CLASSIFY_CACHE_PREFIX = 'classify:sebuf:v6:';

export async function buildClassifyCacheKey(title: string): Promise<string> {
  return `${CLASSIFY_CACHE_PREFIX}${(await sha256Hex(title.toLowerCase())).slice(0, 16)}`;
}
