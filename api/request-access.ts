// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { checkRateLimit } from './_rate-limit.js';
// @ts-expect-error — JS module, no declaration file
import { jsonResponse } from './_json-response.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';

export const config = { runtime: 'edge' };

/**
 * Request-access intake for the landing page (public/landing.html).
 *
 * Validates the form, applies a small per-IP budget, and stores the request
 * in Convex (`partnerAccess:requestAccess`). Without CONVEX_URL the intake is
 * not configured: the response says so and carries the contact address when
 * PARTNER_CONTACT_EMAIL is set, so the page can fall back to a mailto link.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 8 * 1024;
const CONVEX_TIMEOUT_MS = 8_000;
const RATE_LIMIT = { scope: 'request-access', limit: 5, window: '1 h' } as const;

export interface AccessRequestInput {
  email: string;
  organization: string;
  role?: string;
  message?: string;
}

type Validation = { ok: true; value: AccessRequestInput } | { ok: false; error: string };

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function validateAccessRequest(body: unknown): Validation {
  if (!body || typeof body !== 'object') return { ok: false, error: 'invalid_body' };
  const record = body as Record<string, unknown>;
  // Honeypot: real visitors never fill the hidden "website" field.
  if (clean(record.website, 10)) return { ok: false, error: 'rejected' };
  const email = clean(record.email, 254).toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'invalid_email' };
  const organization = clean(record.organization, 120);
  if (!organization) return { ok: false, error: 'organization_required' };
  const role = clean(record.role, 80);
  const message = clean(record.message, 1000);
  return { ok: true, value: { email, organization, ...(role ? { role } : {}), ...(message ? { message } : {}) } };
}

interface Deps {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

export async function handleAccessRequest(req: Request, deps: Deps = {}): Promise<Response> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const corsHeaders = getCorsHeaders(req, 'POST, OPTIONS');

  if (isDisallowedOrigin(req)) return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, { ...corsHeaders, Allow: 'POST, OPTIONS' });

  const contact = String(env.PARTNER_CONTACT_EMAIL ?? '').trim() || null;
  const convexUrl = String(env.CONVEX_URL ?? '').trim();
  if (!convexUrl) {
    return jsonResponse({ error: 'intake_not_configured', contact }, 503, { ...corsHeaders, 'Cache-Control': 'no-store' });
  }

  const rateLimited = await checkRateLimit(req, corsHeaders, RATE_LIMIT);
  if (rateLimited) return rateLimited;

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return jsonResponse({ error: 'body_too_large' }, 413, corsHeaders);
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400, corsHeaders);
  }
  const validated = validateAccessRequest(body);
  if (!validated.ok) {
    // A honeypot hit looks like success to the bot and stores nothing.
    if (validated.error === 'rejected') return jsonResponse({ ok: true }, 202, corsHeaders);
    return jsonResponse({ error: validated.error }, 400, corsHeaders);
  }

  try {
    const resp = await fetchImpl(new URL('/api/mutation', convexUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'partnerAccess:requestAccess', args: { ...validated.value, source: 'landing' }, format: 'json' }),
      signal: AbortSignal.timeout(CONVEX_TIMEOUT_MS),
    });
    const result = (await resp.json().catch(() => null)) as { status?: string; value?: { created?: boolean } } | null;
    if (!resp.ok || result?.status !== 'success') {
      throw new Error(`Convex requestAccess failed: ${resp.status} ${result?.status ?? ''}`);
    }
    return jsonResponse({ ok: true, created: result.value?.created !== false }, 202, { ...corsHeaders, 'Cache-Control': 'no-store' });
  } catch (error) {
    captureSilentError(error, { tags: { route: 'request-access' } });
    return jsonResponse({ error: 'intake_unavailable', contact }, 503, { ...corsHeaders, 'Cache-Control': 'no-store' });
  }
}

export default function handler(req: Request): Promise<Response> {
  return handleAccessRequest(req);
}
