import { getNuclearWatchlist, toggleNuclearWatchlist } from '@/services/nuclear-watchlist';
import { createCircuitBreaker } from '@/utils/circuit-breaker';
import { toApiUrl } from '@/services/runtime';
import { safeStorageGet, safeStorageSet } from '@/utils/safe-storage';
import { matchNrcUnitName, US_NUCLEAR_FACILITIES, type UsNuclearFacility } from '@/config/us-nuclear-facilities';
import {
  compareNrcEvents,
  NRC_EVENT_REPORTS_INDEX,
  type NrcEventCategory,
  type NrcEventReport,
} from '../../shared/nrc-event-reports';

export type { NrcEventReport };
export { NRC_EVENT_REPORTS_INDEX };

export interface NrcEventWithFacility extends NrcEventReport {
  /** Registry facility the event's facility name resolved to, when matched. */
  facilityMatch?: UsNuclearFacility;
}

export interface NrcEventReportsResult {
  fetchedAt: Date;
  events: NrcEventWithFacility[];
  daysCovered: number;
  daysMissing: number;
  daysFailed: number;
}

interface Payload {
  fetchedAt: string;
  days: Array<{ date: string; url: string; status: 'ok' | 'missing' | 'error' }>;
  events: NrcEventReport[];
}

const REQUEST_TIMEOUT_MS = 30_000;
const LAST_SEEN_KEY = 'nucmonitor:nrc-events:last-seen-v1';

const breaker = createCircuitBreaker<Payload>({
  name: 'NRC Event Reports',
  cacheTtlMs: 15 * 60 * 1000,
  persistCache: true,
});

let latestResult: NrcEventReportsResult | null = null;

export function getLatestNrcEventReports(): NrcEventReportsResult | null {
  return latestResult;
}

// Only licensed-facility categories carry a facility name that can mean a
// registry site. Materials and Agreement State licensees (radiographers,
// hospitals, gauge users) share words with plant names and must not match.
const MATCHABLE: ReadonlySet<NrcEventCategory> = new Set(['power-reactor', 'non-power-reactor', 'fuel-cycle']);

const NAME_STOPWORDS = new Set([
  'the', 'of', 'at', 'and', 'inc', 'co', 'corp', 'corporation', 'company', 'llc', 'lp',
  'facility', 'plant', 'station', 'site', 'center', 'unit', 'units',
]);

// Words every fuel-cycle or research licensee shares; a match on these alone
// is not evidence of the same site.
const GENERIC_TOKENS = new Set([
  'nuclear', 'fuel', 'fabrication', 'enrichment', 'services', 'research', 'reactor', 'reactors',
  'university', 'college', 'state', 'institute', 'technology', 'science', 'sciences', 'laboratory',
  'lab', 'national', 'energy', 'electric', 'american', 'americas', 'operations', 'group', 'training',
]);

function nameTokens(text: string): string[] {
  return text.toLowerCase().replace(/&/g, ' ').split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !NAME_STOPWORDS.has(t));
}

/**
 * Fuel-cycle and research-reactor events name the licensee ("OREGON STATE
 * UNIVERSITY", "WESTINGHOUSE ELECTRIC COMPANY"), not a plant alias, so they
 * fall back to a same-state token match against registry names and operators.
 */
function matchByLicenseeName(event: NrcEventReport): UsNuclearFacility | undefined {
  if (!event.state) return undefined;
  const wanted = [...new Set(nameTokens(event.facility))];
  if (wanted.length === 0) return undefined;
  let best: { facility: UsNuclearFacility; score: number } | undefined;
  let tie = false;
  for (const facility of US_NUCLEAR_FACILITIES) {
    if (facility.state !== event.state || facility.category === 'power-reactor') continue;
    const have = new Set(nameTokens(`${facility.name} ${facility.operator}`));
    const hits = wanted.filter((t) => have.has(t)).length;
    const score = hits / wanted.length;
    const distinctive = wanted.some((t) => have.has(t) && !GENERIC_TOKENS.has(t));
    if (hits < Math.min(2, wanted.length) || score < 0.6 || (score < 1 && !distinctive)) continue;
    if (!best || score > best.score) { best = { facility, score }; tie = false; }
    else if (score === best.score) tie = true;
  }
  return best && !tie ? best.facility : undefined;
}

export function matchEventFacility(event: NrcEventReport): UsNuclearFacility | undefined {
  if (!MATCHABLE.has(event.category) || !event.facility) return undefined;
  const hit = matchNrcUnitName(event.facility);
  // A matched name in a different state is a coincidence, not the site.
  if (hit && (!event.state || !hit.facility.state || hit.facility.state === event.state)) return hit.facility;
  return event.category === 'power-reactor' ? undefined : matchByLicenseeName(event);
}

export function enrichNrcEvents(events: NrcEventReport[]): NrcEventWithFacility[] {
  return events
    .map((e) => ({ ...e, facilityMatch: matchEventFacility(e) }))
    .sort(compareNrcEvents);
}

export async function fetchNrcEventReports(days = 14): Promise<NrcEventReportsResult | null> {
  const payload = await breaker.execute(async () => {
    const resp = await fetch(toApiUrl(`/api/nrc-event-reports?days=${encodeURIComponent(String(days))}`), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`NRC event reports fetch failed: ${resp.status}`);
    const body = await resp.json() as Payload;
    if (!body || !Array.isArray(body.events) || !Array.isArray(body.days)) {
      throw new Error('NRC event reports payload malformed');
    }
    return body;
  }, { fetchedAt: '', days: [], events: [] }, { shouldCache: (p) => p.days.length > 0 });

  if (!payload.days.length) return latestResult;
  latestResult = {
    fetchedAt: payload.fetchedAt ? new Date(payload.fetchedAt) : new Date(),
    events: enrichNrcEvents(payload.events),
    daysCovered: payload.days.filter((d) => d.status === 'ok').length,
    daysMissing: payload.days.filter((d) => d.status === 'missing').length,
    daysFailed: payload.days.filter((d) => d.status === 'error').length,
  };
  return latestResult;
}

export function getNrcEventReportsBreakerStatus(): string {
  return breaker.getStatus();
}

// ── "New since last visit" ─────────────────────────────────────────────────

/** Highest event number the user has seen; events above it are new. */
export function getLastSeenEventNumber(): number {
  const n = Number.parseInt(safeStorageGet(LAST_SEEN_KEY) ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

export function markEventsSeen(events: NrcEventReport[]): void {
  const max = events.reduce((m, e) => Math.max(m, Number(e.eventNumber) || 0), 0);
  if (max > getLastSeenEventNumber()) safeStorageSet(LAST_SEEN_KEY, String(max));
}

// ── Watched sites ("my sites") ─────────────────────────────────────────────
// One watchlist for the whole hub, shared with the hazards and directory panels.

export function getWatchedFacilityIds(): Set<string> {
  return getNuclearWatchlist();
}

export function toggleWatchedFacility(id: string): Set<string> {
  toggleNuclearWatchlist(id);
  return getNuclearWatchlist();
}

/** Facility ids with a non-retracted event notified in the last `hours`. */
export function facilitiesWithRecentEvents(events: NrcEventWithFacility[], now: Date, hours = 72): Set<string> {
  const cutoff = now.getTime() - hours * 3_600_000;
  const ids = new Set<string>();
  for (const e of events) {
    if (e.retracted || !e.facilityMatch) continue;
    const when = Date.parse(`${e.notificationDate ?? e.reportDate ?? ''}T23:59:59Z`);
    if (Number.isFinite(when) && when >= cutoff) ids.add(e.facilityMatch.id);
  }
  return ids;
}
