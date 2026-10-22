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
  dedupePart21Reports,
  dedupePreliminaryNotifications,
  looksLikeNrcPart21Page,
  looksLikeNrcPreliminaryNotificationPage,
  NRC_PART21_INDEX,
  NRC_PRELIMINARY_NOTIFICATIONS_INDEX,
  nrcPart21YearUrl,
  nrcPreliminaryNotificationYearUrl,
  parseNrcPart21Page,
  parseNrcPreliminaryNotificationPage,
  sortPart21Reports,
  sortPreliminaryNotifications,
  type NrcPart21Report,
  type NrcPreliminaryNotification,
} from '../shared/nrc-safety-reports';

export const config = { runtime: 'edge' };

// NRC Part 21 reports and Preliminary Notifications: two "reports associated
// with events" collections the NRC publishes as one HTML table per year.
// nrc.gov sends no CORS headers and offers no feed, so this function fetches
// the current and previous year of each, parses the rows with the shared
// parser, and returns compact JSON. See shared/nrc-safety-reports.ts.

const PAGE_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
// The tables grow by a handful of rows a month; an hour at the edge is plenty.
const CACHE_CONTROL = 'public, s-maxage=3600, max-age=900, stale-while-revalidate=21600';
const USER_AGENT = 'NucMonitor/1.0 (+https://github.com/jordanboyce/nucmonitor; US nuclear facility hub)';
// NRC pages follow US Eastern time; shifting UTC back five hours keeps the
// year from rolling over before the NRC publishes the next year's page.
const EASTERN_OFFSET_MS = 5 * 60 * 60 * 1000;

export type NrcPageStatus = 'ok' | 'missing' | 'error';

export interface NrcSafetyReportsPayload {
  fetchedAt: string;
  part21: {
    source: string;
    pages: Array<{ year: number; url: string; status: NrcPageStatus }>;
    reports: NrcPart21Report[];
  };
  preliminaryNotifications: {
    source: string;
    pages: Array<{ year: number; url: string; status: NrcPageStatus }>;
    notifications: NrcPreliminaryNotification[];
  };
}

/** The current and previous NRC (Eastern) calendar years, newest first. */
export function reportYears(now: Date): number[] {
  const year = new Date(now.getTime() - EASTERN_OFFSET_MS).getUTCFullYear();
  return [year, year - 1];
}

interface PageResult<T> {
  year: number;
  url: string;
  status: NrcPageStatus;
  items: T[];
}

async function fetchPage<T>(
  year: number,
  url: string,
  looksRight: (html: string) => boolean,
  parse: (html: string, year: number) => T[],
): Promise<PageResult<T>> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html, */*;q=0.5' },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    // A year with no reports yet has no page.
    if (resp.status === 404 || resp.status === 410) return { year, url, status: 'missing', items: [] };
    if (!resp.ok) return { year, url, status: 'error', items: [] };
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > MAX_PAGE_BYTES) return { year, url, status: 'error', items: [] };
    const html = await resp.text();
    if (html.length > MAX_PAGE_BYTES) return { year, url, status: 'error', items: [] };
    // Missing pages are sometimes served as a 200 "page not found" shell.
    if (!looksRight(html)) return { year, url, status: 'missing', items: [] };
    return { year, url, status: 'ok', items: parse(html, year) };
  } catch {
    return { year, url, status: 'error', items: [] };
  }
}

export async function collectNrcSafetyReports(now: Date): Promise<NrcSafetyReportsPayload> {
  const years = reportYears(now);
  const [part21Pages, pnPages] = await Promise.all([
    Promise.all(years.map((y) => fetchPage(y, nrcPart21YearUrl(y), looksLikeNrcPart21Page, parseNrcPart21Page))),
    Promise.all(years.map((y) => fetchPage(y, nrcPreliminaryNotificationYearUrl(y), looksLikeNrcPreliminaryNotificationPage, parseNrcPreliminaryNotificationPage))),
  ]);
  return {
    fetchedAt: now.toISOString(),
    part21: {
      source: NRC_PART21_INDEX,
      pages: part21Pages.map(({ year, url, status }) => ({ year, url, status })),
      reports: sortPart21Reports(dedupePart21Reports(part21Pages.flatMap((p) => p.items))),
    },
    preliminaryNotifications: {
      source: NRC_PRELIMINARY_NOTIFICATIONS_INDEX,
      pages: pnPages.map(({ year, url, status }) => ({ year, url, status })),
      notifications: sortPreliminaryNotifications(dedupePreliminaryNotifications(pnPages.flatMap((p) => p.items))),
    },
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
    const payload = await collectNrcSafetyReports(new Date());
    const pages = [...payload.part21.pages, ...payload.preliminaryNotifications.pages];
    const ok = pages.filter((p) => p.status === 'ok').length;
    const errors = pages.filter((p) => p.status === 'error').length;
    // Every page failing (as opposed to a year having no page yet) means the
    // upstream is down or blocking us: surface that instead of caching "none".
    if (ok === 0 && errors > 0) {
      return jsonResponse({ error: 'NRC safety reports upstream unavailable', pages }, 502, corsHeaders);
    }
    return jsonResponse(payload, 200, {
      ...corsHeaders,
      'Cache-Control': CACHE_CONTROL,
      'X-Upstream-Source': 'nrc.gov',
    });
  } catch (error) {
    captureSilentError(error, {
      tags: { route: 'api/nrc-safety-reports', step: 'collect' },
      fingerprint: ['api/nrc-safety-reports', 'collect'],
    });
    return jsonResponse({ error: 'NRC safety reports fetch failed' }, 502, corsHeaders);
  }
}
