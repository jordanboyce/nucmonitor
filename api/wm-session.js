// POST /api/wm-session — issues a short-lived HttpOnly session cookie for
// browser access: an HMAC-signed wms_ token. In partner mode it is minted only
// for a signed-in partner (docs/partner-access.md).

import { getCorsHeaders, getOriginDeniedCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { checkRateLimit } from './_rate-limit.js';
import { issueSessionToken, validateSessionToken } from './_session.js';
import { isPartnerMode, verifyPartnerRequest } from './_partner-access.js';
import { emitWmSessionUsage } from './_usage-telemetry.js';

export const config = { runtime: 'edge' };

const SESSION_COOKIE = 'wm-session';
const COOKIE_MAX_AGE_SECONDS = 12 * 60 * 60;
const SESSION_RATE_LIMIT_SCOPE = 'wm-session';
const SESSION_RATE_LIMIT_PER_MINUTE = 30;
const SESSION_RATE_LIMIT_WINDOW = '60 s';

function jsonResponse(body, status, headers) {
  const out = headers instanceof Headers ? headers : new Headers(headers);
  out.set('Content-Type', 'application/json');
  out.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(body), {
    status,
    headers: out,
  });
}

function appendHeader(headers, name, value) {
  const next = new Headers(headers);
  next.append(name, value);
  return next;
}

/**
 * Read one cookie off the request. Mirrors the reader in `_api-key.js`; kept
 * local because this endpoint is the only other consumer and `_api-key.js`
 * does not export it.
 */
function readCookie(req, name) {
  const raw = req.headers.get('Cookie') || req.headers.get('cookie') || '';
  if (!raw) return '';
  const prefix = `${name}=`;
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(trimmed.slice(prefix.length));
    } catch {
      return trimmed.slice(prefix.length);
    }
  }
  return '';
}

/**
 * Did THIS request arrive already carrying a usable session cookie?
 *
 * The client cannot answer this itself — the cookie is HttpOnly, so JS can
 * neither read it nor tell "the server rejected my cookie" apart from "my
 * browser never stored it." Those two need opposite responses: the first is
 * worth a re-mint, the second makes every re-mint useless because no route can
 * ever succeed. Reporting it back lets the client stop after one wasted mint
 * instead of spending one per route and blaming the API for a browser-side
 * storage failure (WORLDMONITOR-WG/XP).
 *
 * Computed from the INCOMING request, before this response's Set-Cookie.
 */
async function hadValidSessionCookie(req) {
  const presented = readCookie(req, SESSION_COOKIE);
  if (!presented) return false;
  return validateSessionToken(presented);
}

function shouldUseSharedCookieDomain(req) {
  const host = (req.headers.get('host') || new URL(req.url).hostname).toLowerCase();
  return host === 'worldmonitor.app' || host.endsWith('.worldmonitor.app');
}

function cookieDomainAttribute(req) {
  return shouldUseSharedCookieDomain(req) ? '; Domain=.worldmonitor.app' : '';
}

function sessionCookie(req, name, value) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}${cookieDomainAttribute(req)}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Host-only Max-Age=0 tombstone for the same name/path. An older api-host
 * wm-session (no Domain) would otherwise shadow the new Domain=.worldmonitor.app
 * cookie: browsers send both, and first-match readers keep the stale host-only
 * value. Only emit this on shared-domain production hosts.
 */
function hostOnlySessionTombstone() {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

export default async function handler(req, ctx) {
  const startedAt = Date.now();
  const respond = (body, status, headers, reason) => {
    const response = jsonResponse(body, status, headers);
    emitWmSessionUsage(ctx, req, response, startedAt, reason);
    return response;
  };

  // Preflight must succeed even for origins we refuse on POST — otherwise the
  // browser never sends the actual request and the client sees a network error
  // instead of a readable 403 (#6411). Allowed origins get normal CORS;
  // disallowed origins get refusal-specific headers that echo their Origin.
  if (req.method === 'OPTIONS') {
    const preflight = isDisallowedOrigin(req)
      ? getOriginDeniedCorsHeaders(req, 'POST, OPTIONS')
      : getCorsHeaders(req, 'POST, OPTIONS');
    return new Response(null, { status: 204, headers: preflight });
  }

  if (isDisallowedOrigin(req)) {
    const deniedCors = getOriginDeniedCorsHeaders(req, 'POST, OPTIONS');
    const response = new Response('Forbidden', { status: 403, headers: deniedCors });
    emitWmSessionUsage(ctx, req, response, startedAt, 'origin_403');
    return response;
  }

  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405, cors, 'method_not_allowed');
  }

  // Rate-limit per IP. Without this, an attacker can farm tokens cheaply.
  // Token TTL is 12h, so this route uses a lower, fail-closed issuance budget
  // instead of inheriting the availability-first global fallback.
  const rl = await checkRateLimit(req, cors, {
    failClosed: true,
    ctx,
    scope: SESSION_RATE_LIMIT_SCOPE,
    limit: SESSION_RATE_LIMIT_PER_MINUTE,
    window: SESSION_RATE_LIMIT_WINDOW,
  });
  if (rl) {
    emitWmSessionUsage(ctx, req, rl, startedAt, rl.status === 429 ? 'rate_limit_429' : 'rate_limit_degraded');
    return rl;
  }

  // Partner deployments mint a browser session only for a signed-in partner;
  // every data read downstream needs that session (or an API key), so this is
  // the one gate between the dashboard and the data (docs/partner-access.md).
  if (isPartnerMode()) {
    const partner = await verifyPartnerRequest(req);
    if (!partner.ok) {
      return respond({ error: partner.error }, partner.status, cors, `partner_${partner.status}`);
    }
  }

  // Before the new Set-Cookie: whether the caller's browser gave the previous
  // cookie back. Never fails the request — it is diagnostic, not a gate.
  let hadSession = false;
  try {
    hadSession = await hadValidSessionCookie(req);
  } catch {
    hadSession = false;
  }

  let issued;
  try {
    issued = await issueSessionToken();
  } catch {
    // WM_SESSION_SECRET missing — fail closed. 503 signals "configure me",
    // not "you're rejected." Operator-visible.
    return respond({ error: 'Session service not configured' }, 503, cors, 'auth_unavailable');
  }

  let headers = cors;
  if (shouldUseSharedCookieDomain(req)) {
    // Tombstone first so the subsequent Domain cookie is the only live wm-session.
    headers = appendHeader(headers, 'Set-Cookie', hostOnlySessionTombstone());
  }
  headers = appendHeader(headers, 'Set-Cookie', sessionCookie(req, SESSION_COOKIE, issued.token));

  // The HttpOnly cookie remains the primary transport. The anonymous token is
  // also returned so browsers that demonstrably refuse the shared-domain
  // cookie can use the existing X-WorldMonitor-Key validation path. This does
  // not expose user authority: wms_ tokens carry no identity.
  return respond({
    ok: true,
    exp: issued.exp,
    hadSession,
    token: issued.token,
  }, 200, headers, 'ok');
}
