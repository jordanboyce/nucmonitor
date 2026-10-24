import { isSessionTokenShape, validateSessionToken } from './_session.js';
import { timingSafeIncludes } from './_crypto.js';

const DESKTOP_ORIGIN_PATTERNS = [
  /^https?:\/\/tauri\.localhost(:\d+)?$/,
  /^https?:\/\/[a-z0-9-]+\.tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/,
  /^asset:\/\/localhost$/,
];

export function isDesktopOrigin(origin) {
  return Boolean(origin) && DESKTOP_ORIGIN_PATTERNS.some(p => p.test(origin));
}

export function getHeaderApiKey(req) {
  return req.headers.get('X-WorldMonitor-Key') || req.headers.get('X-Api-Key') || '';
}

async function isValidEnterpriseKey(key) {
  if (!key) return false;
  const validKeys = (process.env.WORLDMONITOR_VALID_KEYS || '').split(',').filter(Boolean);
  return timingSafeIncludes(key, validKeys);
}

async function validateCredential(key) {
  if (isSessionTokenShape(key)) {
    // Anonymous session tokens are NOT proof of any specific user identity —
    // anyone can mint one via POST /api/wm-session (outside partner mode).
    // NucMonitor has no plans, so a valid one opens every data route.
    if (await validateSessionToken(key)) {
      return { valid: true, required: false, kind: 'session' };
    }
    return { valid: false, required: true, error: 'Invalid session token' };
  }

  // Enterprise key (WORLDMONITOR_VALID_KEYS). `credential` records the
  // authority that actually won; downstream identity/rate-limit code must not
  // infer it again from headers.
  if (key && await isValidEnterpriseKey(key)) {
    return { valid: true, required: true, kind: 'enterprise', credential: key };
  }

  if (key) {
    return { valid: false, required: true, error: 'Invalid API key' };
  }

  return { valid: false, required: true, error: 'API key required' };
}

function getCookie(req, name) {
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

// Note: HTTP headers like Origin / Referer / Sec-Fetch-Site are entirely
// client-controlled at the wire level (see issue #3541 / closed PR #3554).
// Trusting any of them as a "this is a real browser" signal is forgeable by
// curl in one line. The previous Referer-origin fallback and Origin-pattern
// no-key trust path are both gone. Callers now authenticate via:
//   1. A short-lived wms_-prefixed session token (HMAC-signed by /api/wm-session).
//      Kind: 'session'. Anonymous outside partner mode; in partner mode it is
//      minted only for a signed-in partner (api/_partner-access.js).
//   2. An enterprise key (WORLDMONITOR_VALID_KEYS). Kind: 'enterprise'.
//      Operator-issued; metered per key by the gateway.
// Tauri desktop continues to authenticate via enterprise key.
//
// Async because session validation uses Web Crypto (crypto.subtle.sign).
// All call sites await this — see grep for migration history.
export async function validateApiKey(req) {
  const headerKey = getHeaderApiKey(req);
  const sessionCookie = getCookie(req, 'wm-session');
  const origin = req.headers.get('Origin') || '';

  // Desktop app — always require an enterprise key.
  if (isDesktopOrigin(origin)) {
    if (!headerKey) return { valid: false, required: true, error: 'API key required for desktop access' };
    if (!await isValidEnterpriseKey(headerKey)) return { valid: false, required: true, error: 'Invalid API key' };
    return { valid: true, required: true, kind: 'enterprise', credential: headerKey };
  }

  // Explicit non-session headers remain authoritative. They are machine/API
  // credentials and must never silently fall back to ambient browser cookies.
  if (headerKey && !isSessionTokenShape(headerKey)) {
    return validateCredential(headerKey);
  }

  if (headerKey) return validateCredential(headerKey);
  if (sessionCookie) return validateCredential(sessionCookie);

  return { valid: false, required: true, error: 'API key required' };
}
