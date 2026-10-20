// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { validateApiKey } from './_api-key.js';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import {
  looksLikeNrcEventReportPage,
  mergeNrcEventReports,
  nrcEventReportPageUrl,
  parseNrcEventReportPage,
  type NrcEventReport,
} from '../shared/nrc-event-reports';

export const config = { runtime: 'edge' };

// NRC Event Notification Reports: one HTML page per calendar day, published
// by the NRC Operations Center. nrc.gov sends no CORS headers and the pages
// are heavy HTML, so this function fetches the trailing window of daily pages,
// parses them with the shared label-based parser, merges updates/retractions
// across days, and returns compact JSON.
// https://www.nrc.gov/reading-rm/doc-collections/event-status/event/

export const DEFAULT_DAYS = 14;
export const MAX_DAYS = 30;
const PAGE_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const FETCH_CONCURRENCY = 4;
// Reports post through the (US Eastern) business day and are revised when an
// event is updated; 15 minutes at the edge keeps nrc.gov load negligible.
const CACHE_CONTROL = 'public, s-maxage=900, max-age=300, stale-while-revalidate=3600';
const USER_AGENT = 'NucMonitor/1.0 (+https://github.com/jordanboyce/nucmonitor; US nuclear facility hub)';
// NRC page dates follow US Eastern time; shifting UTC back five hours keeps
// "today" from rolling over to a page that cannot exist yet.
const EASTERN_OFFSET_MS = 5 * 60 * 60 * 1000;

export type NrcDayStatus = 'ok' | 'missing' | 'error';

export interface NrcEventReportsPayload {
  source: string;
  fetchedAt: string;
  days: Array<{ date: string; url: string; status: NrcDayStatus }>;
  events: NrcEventReport[];
}

export function parseDaysParam(value: string | null): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

/** Daily page dates, newest first, for the trailing `days` Eastern-time days. */
export function reportWindow(now: Date, days: number): Date[] {
  const anchor = new Date(now.getTime() - EASTERN_OFFSET_MS);
  const base = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  return Array.from({ length: days }, (_, i) => new Date(base - i * 86_400_000));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function fetchDay(date: Date): Promise<{ date: string; url: string; status: NrcDayStatus; events: NrcEventReport[] }> {
  const url = nrcEventReportPageUrl(date);
  const day = isoDate(date);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html, */*;q=0.5' },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    // Weekends, holidays and days without reports simply have no page.
    if (resp.status === 404 || resp.status === 410) return { date: day, url, status: 'missing', events: [] };
    if (!resp.ok) return { date: day, url, status: 'error', events: [] };
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > MAX_PAGE_BYTES) return { date: day, url, status: 'error', events: [] };
    const html = await resp.text();
    if (html.length > MAX_PAGE_BYTES) return { date: day, url, status: 'error', events: [] };
    // Missing pages are sometimes served as a 200 "page not found" shell.
    if (!looksLikeNrcEventReportPage(html)) return { date: day, url, status: 'missing', events: [] };
    return { date: day, url, status: 'ok', events: parseNrcEventReportPage(html, url, day) };
  } catch {
    return { date: day, url, status: 'error', events: [] };
  }
}

export async function collectNrcEventReports(now: Date, days: number): Promise<NrcEventReportsPayload> {
  const dates = reportWindow(now, days);
  const results: Awaited<ReturnType<typeof fetchDay>>[] = [];
  for (let i = 0; i < dates.length; i += FETCH_CONCURRENCY) {
    results.push(...await Promise.all(dates.slice(i, i + FETCH_CONCURRENCY).map(fetchDay)));
  }
  return {
    source: 'https://www.nrc.gov/reading-rm/doc-collections/event-status/event/',
    fetchedAt: now.toISOString(),
    days: results.map(({ date, url, status }) => ({ date, url, status })),
    events: mergeNrcEventReports(results.flatMap((r) => r.events)),
  };
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const keyCheck = await validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return jsonResponse({ error: keyCheck.error }, 401, corsHeaders);
  }

  const rateLimitResponse = await checkRateLimit(req, corsHeaders);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const days = parseDaysParam(new URL(req.url).searchParams.get('days'));
    const payload = await collectNrcEventReports(new Date(), days);
    const ok = payload.days.filter((d) => d.status === 'ok').length;
    const errors = payload.days.filter((d) => d.status === 'error').length;
    // Every day failing (as opposed to every day having no page) means the
    // upstream is down or blocking us: surface that instead of caching "none".
    if (ok === 0 && errors > 0) {
      return jsonResponse({ error: 'NRC event reports upstream unavailable', days: payload.days }, 502, corsHeaders);
    }
    return jsonResponse(payload, 200, {
      ...corsHeaders,
      'Cache-Control': CACHE_CONTROL,
      'X-Upstream-Source': 'nrc.gov',
    });
  } catch (error) {
    captureSilentError(error, {
      tags: { route: 'api/nrc-event-reports', step: 'collect' },
      fingerprint: ['api/nrc-event-reports', 'collect'],
    });
    return jsonResponse({ error: 'NRC event reports fetch failed' }, 502, corsHeaders);
  }
}
