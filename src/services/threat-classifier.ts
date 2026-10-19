export type { ThreatLevel, EventCategory, ThreatClassification } from '@/types';
import type { ThreatLevel, EventCategory, ThreatClassification } from '@/types';

import { getCSSColor } from '@/utils';

/** @deprecated Use getThreatColor() instead for runtime CSS variable reads */
export const THREAT_COLORS: Record<ThreatLevel, string> = {
  critical: '#ef4444',
  high: '#f97316',
  medium: '#eab308',
  low: '#22c55e',
  info: '#3b82f6',
};

const THREAT_VAR_MAP: Record<ThreatLevel, string> = {
  critical: '--threat-critical',
  high: '--threat-high',
  medium: '--threat-medium',
  low: '--threat-low',
  info: '--threat-info',
};

export function getThreatColor(level: string): string {
  return getCSSColor(THREAT_VAR_MAP[level as ThreatLevel] || '--text-dim');
}

export const THREAT_PRIORITY: Record<ThreatLevel, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

import { t } from '@/services/i18n';

export function getThreatLabel(level: ThreatLevel): string {
  return t(`components.threatLabels.${level}`);
}

export const THREAT_LABELS: Record<ThreatLevel, string> = {
  critical: 'CRIT',
  high: 'HIGH',
  medium: 'MED',
  low: 'LOW',
  info: 'INFO',
};

// The keyword tables and the cascade live in shared/threat-keyword-classifier.ts
// (#7526) so server surfaces that must agree with the browser — the country
// coverage RPC — label a headline identically instead of keeping a second copy.
// Re-exported here so every existing caller keeps its import path.
export { classifyByKeyword } from '../../shared/threat-keyword-classifier';
import type {
  ThreatLevel as SharedThreatLevel,
  EventCategory as SharedEventCategory,
  ThreatClassification as SharedThreatClassification,
} from '../../shared/threat-keyword-classifier';

// The shared module declares its own unions because shared/ cannot import the
// '@/types' alias. These assertions fail typecheck the moment the two drift, so
// the duplication cannot silently become a divergence.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _threatLevelsAgree: Exact<ThreatLevel, SharedThreatLevel> = true;
const _eventCategoriesAgree: Exact<EventCategory, SharedEventCategory> = true;
const _classificationsAgree: Exact<ThreatClassification, SharedThreatClassification> = true;
void _threatLevelsAgree;
void _eventCategoriesAgree;
void _classificationsAgree;

export function aggregateThreats(
  items: Array<{ threat?: ThreatClassification; tier?: number }>
): ThreatClassification {
  const withThreat = items.filter(i => i.threat);
  if (withThreat.length === 0) {
    return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
  }

  // Level = max across items
  let maxLevel: ThreatLevel = 'info';
  let maxPriority = 0;
  for (const item of withThreat) {
    const p = THREAT_PRIORITY[item.threat!.level];
    if (p > maxPriority) {
      maxPriority = p;
      maxLevel = item.threat!.level;
    }
  }

  // Category = most frequent
  const catCounts = new Map<EventCategory, number>();
  for (const item of withThreat) {
    const cat = item.threat!.category;
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
  }
  let topCat: EventCategory = 'general';
  let topCount = 0;
  for (const [cat, count] of catCounts) {
    if (count > topCount) {
      topCount = count;
      topCat = cat;
    }
  }

  // Confidence = weighted avg by source tier (lower tier = higher weight)
  let weightedSum = 0;
  let weightTotal = 0;
  for (const item of withThreat) {
    const weight = item.tier ? (6 - Math.min(item.tier, 5)) : 1;
    weightedSum += item.threat!.confidence * weight;
    weightTotal += weight;
  }

  return {
    level: maxLevel,
    category: topCat,
    confidence: weightTotal > 0 ? weightedSum / weightTotal : 0.5,
    source: 'keyword',
  };
}
