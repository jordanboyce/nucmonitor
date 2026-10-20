// Partner access gate (docs/partner-access.md).
//
// NucMonitor runs in one of two modes, chosen per deployment by ACCESS_MODE:
//
//   public-demo (default)  anyone can open the dashboard and read the public
//                          data it shows. Nothing here runs.
//   partner                every data read needs a browser session or an API
//                          key, and a browser session is only minted for a
//                          signed-in Clerk user who is on the partner list.
//
// The partner list is the union of two sources, so a deploy works with env
// alone and an operator can still invite one person without a redeploy:
//   - PARTNER_ALLOWED_DOMAINS / PARTNER_ALLOWED_EMAILS (comma-separated env)
//   - the Convex `partnerInvites` table, read through `partnerAccess:isInvited`
//     with the caller's own Clerk token (so the query answers for that caller
//     only and no server secret is involved).
//
// Self-contained on purpose: legacy api/*.js files may not import server/ or
// src/ (scripts/lint-boundaries.mjs), and server/gateway.ts imports this file.

import { createRemoteJWKSet, jwtVerify } from 'jose';

const CLOCK_TOLERANCE_SECONDS = 5;
const CONVEX_TIMEOUT_MS = 3_000;
const CLERK_TIMEOUT_MS = 3_000;
// A verdict is reused for this long per Clerk user, so one page load's burst
// of requests costs one Convex read. Short enough that a revoked invite
// takes effect within minutes.
const VERDICT_TTL_MS = 5 * 60 * 1_000;
const VERDICT_CACHE_MAX = 5_000;

/** @returns {'public-demo' | 'partner'} */
export function getAccessMode(env = process.env) {
  return String(env.ACCESS_MODE ?? '').trim().toLowerCase() === 'partner' ? 'partner' : 'public-demo';
}

export function isPartnerMode(env = process.env) {
  return getAccessMode(env) === 'partner';
}

function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/** True when `email` is named in PARTNER_ALLOWED_EMAILS or its domain in PARTNER_ALLOWED_DOMAINS. */
export function isAllowlistedEmail(email, env = process.env) {
  const normalized = String(email ?? '').trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at <= 0 || at === normalized.length - 1) return false;
  if (parseList(env.PARTNER_ALLOWED_EMAILS).includes(normalized)) return true;
  const domain = normalized.slice(at + 1);
  return parseList(env.PARTNER_ALLOWED_DOMAINS).some((allowed) => (
    domain === allowed.replace(/^@/, '')
  ));
}

export function getBearerToken(req) {
  const header = req.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

let jwks = null;
let jwksIssuer = '';
function getJwks(issuer) {
  if (!jwks || jwksIssuer !== issuer) {
    jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', issuer));
    jwksIssuer = issuer;
  }
  return jwks;
}

/** Verify a Clerk-issued JWT. Resolves the payload, or null when it does not verify. */
async function verifyClerkJwt(token, env) {
  const issuer = String(env.CLERK_JWT_ISSUER_DOMAIN ?? '').trim();
  if (!issuer) throw new Error('CLERK_JWT_ISSUER_DOMAIN is not set');
  try {
    const { payload } = await jwtVerify(token, getJwks(issuer), {
      issuer,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ['exp', 'sub'],
    });
    return payload;
  } catch (err) {
    // A JWKS fetch failure says nothing about the token; surface it as
    // unverifiable rather than as a bad credential.
    if (err instanceof TypeError || err?.code === 'ERR_JWKS_TIMEOUT') throw err;
    return null;
  }
}

/** The account's primary email from the Clerk Backend API, for tokens that omit the claim. */
async function lookupClerkEmail(userId, env, fetchImpl) {
  const secret = String(env.CLERK_SECRET_KEY ?? '').trim();
  if (!secret) return '';
  const resp = await fetchImpl(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
  });
  if (!resp.ok) return '';
  const user = await resp.json();
  const primary = (user?.email_addresses ?? []).find((e) => e.id === user?.primary_email_address_id);
  if (!primary || primary.verification?.status !== 'verified') return '';
  return String(primary.email_address ?? '');
}

/** Ask Convex whether the caller (identified by their own token) holds an invite. */
async function isInvitedInConvex(token, env, fetchImpl) {
  const convexUrl = String(env.CONVEX_URL ?? '').trim();
  if (!convexUrl) return false;
  const resp = await fetchImpl(new URL('/api/query', convexUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ path: 'partnerAccess:isInvited', args: {}, format: 'json' }),
    signal: AbortSignal.timeout(CONVEX_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Convex invite lookup failed: ${resp.status}`);
  const body = await resp.json();
  return body?.status === 'success' && body.value === true;
}

const verdictCache = new Map();

export function __resetPartnerAccessForTests() {
  verdictCache.clear();
  jwks = null;
  jwksIssuer = '';
}

/**
 * Decide whether this request comes from a partner.
 *
 * @returns {Promise<
 *   | { ok: true, userId: string, email: string }
 *   | { ok: false, status: 401 | 403 | 503, error: 'sign_in_required' | 'partner_access_required' | 'access_unverifiable' }
 * >}
 */
export async function verifyPartnerRequest(req, deps = {}) {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const verifyJwt = deps.verifyJwt ?? ((token) => verifyClerkJwt(token, env));
  const now = deps.now ?? Date.now();

  const token = getBearerToken(req);
  if (!token) return { ok: false, status: 401, error: 'sign_in_required' };

  let payload;
  try {
    payload = await verifyJwt(token);
  } catch {
    return { ok: false, status: 503, error: 'access_unverifiable' };
  }
  const userId = typeof payload?.sub === 'string' ? payload.sub : '';
  if (!userId) return { ok: false, status: 401, error: 'sign_in_required' };

  const cached = verdictCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.allowed
      ? { ok: true, userId, email: cached.email }
      : { ok: false, status: 403, error: 'partner_access_required' };
  }

  let email = typeof payload.email === 'string' ? payload.email : '';
  let allowed = false;
  try {
    if (!email) email = await lookupClerkEmail(userId, env, fetchImpl);
    allowed = (email !== '' && isAllowlistedEmail(email, env))
      || await isInvitedInConvex(token, env, fetchImpl);
  } catch {
    return { ok: false, status: 503, error: 'access_unverifiable' };
  }

  if (verdictCache.size >= VERDICT_CACHE_MAX) verdictCache.clear();
  verdictCache.set(userId, { allowed, email, expiresAt: now + VERDICT_TTL_MS });
  return allowed
    ? { ok: true, userId, email }
    : { ok: false, status: 403, error: 'partner_access_required' };
}
