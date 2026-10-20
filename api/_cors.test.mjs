import { strict as assert } from 'node:assert';
import test from 'node:test';
import { getCorsHeaders, getPublicCorsHeaders, getOriginDeniedCorsHeaders, isDisallowedOrigin } from './_cors.js';

function makeRequest(origin) {
  const headers = new Headers();
  if (origin !== null) {
    headers.set('origin', origin);
  }
  return new Request('https://worldmonitor.app/api/test', { headers });
}

test('allows desktop Tauri origins', () => {
  const origins = [
    'https://tauri.localhost',
    'https://abc123.tauri.localhost',
    'tauri://localhost',
    'asset://localhost',
    'http://127.0.0.1:46123',
  ];

  for (const origin of origins) {
    const req = makeRequest(origin);
    assert.equal(isDisallowedOrigin(req), false, `origin should be allowed: ${origin}`);
    const cors = getCorsHeaders(req);
    assert.equal(cors['Access-Control-Allow-Origin'], origin);
    assert.equal(cors['Access-Control-Allow-Credentials'], 'true');
  }
});

test('allows Google Translate proxy origins of worldmonitor.app (#6411)', () => {
  const origins = [
    'https://www-worldmonitor-app.translate.goog',
    'https://worldmonitor-app.translate.goog',
    'https://nuclear-worldmonitor-app.translate.goog',
  ];

  for (const origin of origins) {
    const req = makeRequest(origin);
    assert.equal(isDisallowedOrigin(req), false, `translate origin should be allowed: ${origin}`);
    const cors = getCorsHeaders(req);
    assert.equal(cors['Access-Control-Allow-Origin'], origin);
    assert.equal(cors['Access-Control-Allow-Credentials'], 'true');
  }
});

test('rejects unrelated translate.goog hosts', () => {
  const rejected = [
    'https://evil-example-com.translate.goog',
    // Google encodes literal hyphens as `--`. evil-worldmonitor.app must NOT
    // match a naive *-worldmonitor-app.translate.goog suffix check (#6411).
    'https://evil--worldmonitor-app.translate.goog',
    'https://notworldmonitor-app.translate.goog',
  ];
  for (const origin of rejected) {
    assert.equal(isDisallowedOrigin(makeRequest(origin)), true, `must reject ${origin}`);
  }
});

test('allows trailing-dot FQDN form of first-party origins (#6411)', () => {
  const origins = [
    'https://worldmonitor.app.',
    'https://nuclear.worldmonitor.app.',
    'https://www.worldmonitor.app.',
  ];

  for (const origin of origins) {
    const req = makeRequest(origin);
    assert.equal(isDisallowedOrigin(req), false, `FQDN origin should be allowed: ${origin}`);
    // ACAO must echo the raw Origin (including the trailing dot) — browsers
    // compare byte-for-byte against the request Origin.
    const cors = getCorsHeaders(req);
    assert.equal(cors['Access-Control-Allow-Origin'], origin);
  }
});

test('rejects trailing-dot form of unrelated origins', () => {
  const req = makeRequest('https://evil.example.com.');
  assert.equal(isDisallowedOrigin(req), true);
});

test('rejects unrelated external origins', () => {
  const req = makeRequest('https://evil.example.com');
  assert.equal(isDisallowedOrigin(req), true);
  const cors = getCorsHeaders(req);
  assert.equal(cors['Access-Control-Allow-Origin'], 'https://worldmonitor.app');
  assert.equal(cors['Access-Control-Allow-Credentials'], 'true');
});

test('getOriginDeniedCorsHeaders echoes the refused Origin so the client can read 403 (#6411)', () => {
  const origin = 'https://evil.example.com';
  const req = makeRequest(origin);
  const denied = getOriginDeniedCorsHeaders(req, 'POST, OPTIONS');
  assert.equal(denied['Access-Control-Allow-Origin'], origin);
  assert.equal(denied['Access-Control-Allow-Credentials'], 'true');
  assert.equal(denied['Access-Control-Allow-Methods'], 'POST, OPTIONS');
  assert.equal(denied['Vary'], 'Origin');
});

test('requests without origin remain allowed', () => {
  const req = makeRequest(null);
  assert.equal(isDisallowedOrigin(req), false);
});

test('CORS allow headers include MCP transport headers', () => {
  const privateCors = getCorsHeaders(makeRequest('https://worldmonitor.app'));
  const publicCors = getPublicCorsHeaders('POST, GET, OPTIONS');

  for (const cors of [privateCors, publicCors]) {
    const allowed = cors['Access-Control-Allow-Headers'];
    assert.match(allowed, /\bMcp-Session-Id\b/);
    assert.match(allowed, /\bMCP-Protocol-Version\b/);
    assert.match(allowed, /\bLast-Event-ID\b/);

    const exposed = cors['Access-Control-Expose-Headers'];
    assert.match(exposed, /\bMcp-Session-Id\b/);
    assert.match(exposed, /\bWWW-Authenticate\b/);
    assert.match(exposed, /\bRetry-After\b/);
    // IETF RateLimit fields so browser-context agents can self-throttle cross-origin.
    assert.match(exposed, /\bRateLimit-Policy\b/);
    assert.match(exposed, /\bRateLimit-Limit\b/);
    assert.match(exposed, /\bRateLimit-Remaining\b/);
    assert.match(exposed, /\bRateLimit-Reset\b/);
    // Bare combined member: match RateLimit NOT preceded by "-" (so it doesn't
    // just re-match the RateLimit-* fields above) and followed by a delimiter.
    assert.match(exposed, /(^|[\s,])RateLimit(,|$)/);
    assert.match(exposed, /\bX-RateLimit-Limit\b/);
    assert.match(exposed, /\bX-RateLimit-Remaining\b/);
    assert.match(exposed, /\bX-RateLimit-Reset\b/);
    assert.match(exposed, /\bX-RateLimit-Mode\b/);
    assert.match(exposed, /\bX-WorldMonitor-Bbox\b/);
    assert.match(exposed, /\bX-WorldMonitor-Bbox-Missing\b/);
    assert.match(exposed, /\bX-WorldMonitor-Bbox-Invalid\b/);
    assert.match(exposed, /\bX-Military-Bbox\b/);
  }
});

test('admits the origin a request was served from, so a fresh NucMonitor host works before APP_ORIGINS is set', () => {
  const sameOrigin = new Request('https://nucmonitor-demo.vercel.app/api/wm-session', {
    headers: { origin: 'https://nucmonitor-demo.vercel.app' },
  });
  assert.equal(isDisallowedOrigin(sameOrigin), false);
  assert.equal(getCorsHeaders(sameOrigin)['Access-Control-Allow-Origin'], 'https://nucmonitor-demo.vercel.app');

  // Behind a proxy the public host arrives in x-forwarded-host.
  const forwarded = new Request('https://internal.invalid/api/wm-session', {
    headers: { origin: 'https://nucmonitor.example', 'x-forwarded-host': 'nucmonitor.example', 'x-forwarded-proto': 'https' },
  });
  assert.equal(isDisallowedOrigin(forwarded), false);

  // A foreign origin is still refused even when the request host is ours.
  const foreign = new Request('https://nucmonitor-demo.vercel.app/api/wm-session', {
    headers: { origin: 'https://evil.example.com' },
  });
  assert.equal(isDisallowedOrigin(foreign), true);
});

test('APP_ORIGINS names additional first-party hosts', async () => {
  const { configuredAppOrigins } = await import('./_cors.js');
  assert.deepEqual(
    configuredAppOrigins({ APP_ORIGINS: ' https://nucmonitor.example/, https://partners.nucmonitor.example ,http://insecure.example, not-a-url ' }),
    ['https://nucmonitor.example', 'https://partners.nucmonitor.example'],
  );
  const previous = process.env.APP_ORIGINS;
  process.env.APP_ORIGINS = 'https://partners.nucmonitor.example';
  try {
    const req = new Request('https://nucmonitor.example/api/test', { headers: { origin: 'https://partners.nucmonitor.example' } });
    assert.equal(isDisallowedOrigin(req), false);
    assert.equal(getCorsHeaders(req)['Access-Control-Allow-Origin'], 'https://partners.nucmonitor.example');
    const refused = new Request('https://nucmonitor.example/api/test', { headers: { origin: 'https://evil.example.com' } });
    assert.equal(getCorsHeaders(refused)['Access-Control-Allow-Origin'], 'https://partners.nucmonitor.example');
  } finally {
    if (previous === undefined) delete process.env.APP_ORIGINS; else process.env.APP_ORIGINS = previous;
  }
});
