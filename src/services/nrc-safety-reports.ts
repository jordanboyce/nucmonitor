import { createCircuitBreaker } from '@/utils/circuit-breaker';
import { toApiUrl } from '@/services/runtime';
import { matchNrcUnitName, type UsNuclearFacility } from '@/config/us-nuclear-facilities';
import {
  NRC_PART21_INDEX,
  NRC_PRELIMINARY_NOTIFICATIONS_INDEX,
  type NrcPart21Report,
  type NrcPreliminaryNotification,
} from '../../shared/nrc-safety-reports';

export type { NrcPart21Report, NrcPreliminaryNotification };
export { NRC_PART21_INDEX, NRC_PRELIMINARY_NOTIFICATIONS_INDEX };

export interface NrcPart21WithFacility extends NrcPart21Report {
  /** Registry facility when the notifier is a plant rather than a vendor. */
  facilityMatch?: UsNuclearFacility;
}

export interface NrcPreliminaryNotificationWithFacility extends NrcPreliminaryNotification {
  /** Registry facility named in the description, when one is. */
  facilityMatch?: UsNuclearFacility;
}

export interface NrcSafetyReportsResult {
  fetchedAt: Date;
  part21: NrcPart21WithFacility[];
  preliminaryNotifications: NrcPreliminaryNotificationWithFacility[];
  /** Year pages that failed to load (as opposed to years with no page yet). */
  pagesFailed: number;
}

interface Payload {
  fetchedAt: string;
  part21: { pages: Array<{ year: number; url: string; status: 'ok' | 'missing' | 'error' }>; reports: NrcPart21Report[] };
  preliminaryNotifications: { pages: Array<{ year: number; url: string; status: 'ok' | 'missing' | 'error' }>; notifications: NrcPreliminaryNotification[] };
}

const REQUEST_TIMEOUT_MS = 30_000;

const breaker = createCircuitBreaker<Payload>({
  name: 'NRC Part 21 / PN reports',
  cacheTtlMs: 60 * 60 * 1000,
  persistCache: true,
});

let latestResult: NrcSafetyReportsResult | null = null;

export function getLatestNrcSafetyReports(): NrcSafetyReportsResult | null {
  return latestResult;
}

/**
 * Resolve a plant named in free text to a registry facility. Part 21
 * notifiers are mostly vendors ("ABB Inc."), and PN descriptions name the
 * station in passing ("Quad Cities Nuclear Power Station Declaration of an
 * Unusual Event…"), so this tries the text as an NRC unit label and then each
 * leading word run of it; a vendor name simply fails to match.
 */
export function matchFacilityInText(text: string): UsNuclearFacility | undefined {
  const cleaned = text.replace(/\b(nuclear|power|generating|electric|steam|station|plant|center|units?|llc|inc\.?|co\.?)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  for (let len = Math.min(words.length, 4); len >= 1; len--) {
    const candidate = words.slice(0, len).join(' ');
    if (candidate.length < 4) continue;
    const hit = matchNrcUnitName(candidate);
    if (hit) return hit.facility;
  }
  return undefined;
}

function enrich(payload: Payload): NrcSafetyReportsResult {
  const part21 = payload.part21.reports.map((r) => {
    const facilityMatch = matchFacilityInText(r.notifier);
    return facilityMatch ? { ...r, facilityMatch } : r;
  });
  const preliminaryNotifications = payload.preliminaryNotifications.notifications.map((p) => {
    const facilityMatch = matchFacilityInText(p.description);
    return facilityMatch ? { ...p, facilityMatch } : p;
  });
  const pages = [...payload.part21.pages, ...payload.preliminaryNotifications.pages];
  return {
    fetchedAt: payload.fetchedAt ? new Date(payload.fetchedAt) : new Date(),
    part21,
    preliminaryNotifications,
    pagesFailed: pages.filter((p) => p.status === 'error').length,
  };
}

export async function fetchNrcSafetyReports(): Promise<NrcSafetyReportsResult | null> {
  const payload = await breaker.execute(async () => {
    const resp = await fetch(toApiUrl('/api/nrc-safety-reports'), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`NRC safety reports fetch failed: ${resp.status}`);
    const body = await resp.json() as Payload;
    if (!body || !Array.isArray(body.part21?.reports) || !Array.isArray(body.preliminaryNotifications?.notifications)) {
      throw new Error('NRC safety reports payload malformed');
    }
    return body;
  }, { fetchedAt: '', part21: { pages: [], reports: [] }, preliminaryNotifications: { pages: [], notifications: [] } }, {
    shouldCache: (p) => p.part21.pages.length > 0 || p.preliminaryNotifications.pages.length > 0,
  });
  if (!payload.part21.pages.length && !payload.preliminaryNotifications.pages.length) return latestResult;
  latestResult = enrich(payload);
  return latestResult;
}
