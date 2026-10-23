import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { checkRateLimit } from './_rate-limit.js';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-edge.js';

export const config = { runtime: 'edge' };

// NRC Power Reactor Status Report, bulk file covering the trailing 365 days.
// Pipe-delimited text (ReportDt|Unit|Power|Reason|Change|...), one row per
// unit per calendar day. Published once a day by the NRC Operations Center.
// https://www.nrc.gov/documents-reports/document-collections/events-reports-associated-with/power-reactor-status-reports
export const NRC_REACTOR_STATUS_URL = 'https://www.nrc.gov/documents-reports/document-collections/events-reports-associated-with/power-reactor-status-reports/PowerReactorStatusForLast365Days.txt';

const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
// The file changes once a day; a 30-minute shared-cache window keeps load on
// nrc.gov negligible while still surfacing the morning update promptly.
const CACHE_CONTROL = 'public, s-maxage=1800, max-age=600, stale-while-revalidate=3600';
const USER_AGENT = 'NucMonitor/1.0 (+https://github.com/jordanboyce/nucmonitor; US nuclear facility hub)';

export function looksLikeReactorStatusFile(text) {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  const header = firstLine.toLowerCase();
  return header.includes('reportdt') && header.includes('unit') && header.includes('power');
}

export default async function handler(req) {
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
    const upstream = await fetch(NRC_REACTOR_STATUS_URL, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/plain, */*;q=0.5',
      },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    if (!upstream.ok) {
      return jsonResponse(
        { error: 'NRC reactor status upstream error', status: upstream.status },
        502,
        corsHeaders,
      );
    }

    const contentLength = Number(upstream.headers.get('content-length') || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return jsonResponse({ error: 'NRC reactor status file too large' }, 502, corsHeaders);
    }

    const text = await upstream.text();
    if (text.length > MAX_BODY_BYTES) {
      return jsonResponse({ error: 'NRC reactor status file too large' }, 502, corsHeaders);
    }
    if (!looksLikeReactorStatusFile(text)) {
      return jsonResponse({ error: 'NRC reactor status file did not match the expected header' }, 502, corsHeaders);
    }

    return new Response(text, {
      status: 200,
      headers: {
        // Raw pass-through of the NRC text; the browser parses it. Never let
        // the upstream MIME type turn this same-origin URL into a document.
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': CACHE_CONTROL,
        'X-Upstream-Source': 'nrc.gov',
        ...corsHeaders,
      },
    });
  } catch (error) {
    captureSilentError(error, {
      tags: { route: 'api/nrc-reactor-status', step: 'fetch' },
      fingerprint: ['api/nrc-reactor-status', 'upstream-fetch'],
    });
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return jsonResponse(
      { error: timedOut ? 'NRC reactor status upstream timed out' : 'NRC reactor status fetch failed' },
      timedOut ? 504 : 502,
      corsHeaders,
    );
  }
}
