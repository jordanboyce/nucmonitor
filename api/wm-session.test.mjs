import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, test } from 'node:test';

const SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const { default: handler } = await import('./wm-session.js');
const { validateSessionToken } = await import('./_session.js');
const { __resetRateLimitForTest } = await import('./_rate-limit.js');
const { __resetWmSessionTelemetryForTests } = await import('./_usage-telemetry.js');

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function configureDefaultEnv() {
  process.env.WM_SESSION_SECRET = SECRET;
  process.env.WORLDMONITOR_VALID_KEYS = 'enterprise-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
}

function mockUpstashRateLimit({ remaining = 29, limit = 30 } = {}) {
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (url.includes('fake.upstash.io')) {
      return new Response(
        JSON.stringify([{ result: [remaining, limit] }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return originalFetch(input, init);
  };
}

beforeEach(() => {
  configureDefaultEnv();
  __resetRateLimitForTest();
  __resetWmSessionTelemetryForTests();
  mockUpstashRateLimit();
});

afterEach(() => {
  __resetRateLimitForTest();
  __resetWmSessionTelemetryForTests();
  globalThis.fetch = originalFetch;
  restoreEnv();
});

function makeReq(method, { origin, referer } = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  if (referer) headers.set('referer', referer);
  return new Request('https://api.worldmonitor.app/api/wm-session', { method, headers });
}

function makeLocalReq(method, { origin } = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  return new Request('http://localhost:5173/api/wm-session', { method, headers });
}

function setCookies(resp) {
  return resp.headers.getSetCookie ? resp.headers.getSetCookie() : [resp.headers.get('set-cookie')].filter(Boolean);
}

function cookieValue(cookies, name) {
  const prefix = `${name}=`;
  const found = cookies.find((cookie) => {
    if (!cookie.startsWith(prefix)) return false;
    const attrs = cookie.split(';').map((part) => part.trim().toLowerCase());
    const maxAge = attrs.find((attr) => attr.startsWith('max-age='));
    if (maxAge && Number(maxAge.slice('max-age='.length)) <= 0) return false;
    return true;
  });
  if (!found) return '';
  return decodeURIComponent(found.slice(prefix.length).split(';')[0]);
}

function makeWaitUntilCtx() {
  const pending = [];
  return {
    ctx: { waitUntil: (promise) => pending.push(promise) },
    settle: async () => {
      for (let index = 0; index < pending.length; index += 1) {
        await Promise.allSettled([pending[index]]);
      }
    },
  };
}

test('POST sets a valid HttpOnly cookie and returns the anonymous-only fallback token', async () => {
  const resp = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.match(body.token, /^wms_/);
  assert.equal(await validateSessionToken(body.token), true);
  assert.equal(typeof body.exp, 'number');
  assert.equal(resp.headers.get('cache-control'), 'no-store');
  const cookies = setCookies(resp);
  const token = cookieValue(cookies, 'wm-session');
  assert.match(token, /^wms_/);
  assert.equal(body.token, token, 'cookie and fallback header must carry the same anonymous token');
  assert.equal(await validateSessionToken(token), true);
  assert.match(cookies.join('\n'), /wm-session=.*HttpOnly/);
  assert.match(cookies.join('\n'), /wm-session=.*Domain=\.worldmonitor\.app/);
});

test('production Set-Cookie tombstones the host-only cookie before the shared-domain cookie', async () => {
  // An older api.worldmonitor.app host-only wm-session would otherwise shadow
  // Domain=.worldmonitor.app. Tombstone first, then the live Domain cookie.
  const resp = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const cookies = setCookies(resp);
  const sessionCookies = cookies.filter((cookie) => cookie.startsWith('wm-session='));
  assert.equal(sessionCookies.length, 2, 'host-only tombstone then Domain cookie');
  assert.match(sessionCookies[0], /^wm-session=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Lax$/);
  assert.match(sessionCookies[0], /HttpOnly/);
  assert.doesNotMatch(sessionCookies[0], /Domain=/);
  assert.match(sessionCookies[1], /Domain=\.worldmonitor\.app/);
  assert.match(sessionCookies[1], /HttpOnly/);
  assert.match(sessionCookies[1], /SameSite=Lax/);
  assert.doesNotMatch(sessionCookies[1], /SameSite=None/);
  const token = cookieValue(cookies, 'wm-session');
  assert.equal(body.token, token, 'live Domain cookie value still equals the JSON token');
  assert.match(token, /^wms_/);
});

test('POST emits one anonymous mint usage event without exposing cookie material', async () => {
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  const events = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (url.includes('fake.upstash.io')) {
      return new Response(JSON.stringify([{ result: [29, 30] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('axiom.co')) {
      events.push(...JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected telemetry fetch: ${url}`);
  };
  const { ctx, settle } = makeWaitUntilCtx();

  const request = makeReq('POST', {
    origin: 'https://worldmonitor.app',
    referer: 'https://worldmonitor.app/reset-password?token=must-not-be-logged#also-not-logged',
  });
  request.headers.set('x-forwarded-for', '203.0.113.99, attacker-controlled');
  const resp = await handler(request, ctx);
  assert.equal(resp.status, 200);
  await settle();

  assert.equal(events.length, 1);
  assert.deepEqual(
    {
      event_type: events[0].event_type,
      route: events[0].route,
      status: events[0].status,
      auth_kind: events[0].auth_kind,
      origin_kind: events[0].origin_kind,
      ip: events[0].ip,
      referer: events[0].referer,
      reason: events[0].reason,
    },
    {
      event_type: 'request',
      route: '/api/wm-session',
      status: 200,
      auth_kind: 'anon',
      origin_kind: 'browser-cross-origin',
      ip: null,
      referer: 'https://worldmonitor.app/reset-password',
      reason: 'ok',
    },
  );
  assert.equal(JSON.stringify(events[0]).includes('wms_'), false, 'never telemeter the minted session token');
});

test('session usage telemetry records verified Cloudflare client attribution and rejects forged headers', async () => {
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
  const events = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (url.includes('fake.upstash.io')) {
      return new Response(JSON.stringify([{ result: [29, 30] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('axiom.co')) {
      events.push(...JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected telemetry fetch: ${url}`);
  };

  const verified = makeReq('POST', { origin: 'https://worldmonitor.app' });
  verified.headers.set('cf-connecting-ip', '203.0.113.7');
  verified.headers.set('cf-ipcountry', 'FR');
  verified.headers.set('x-real-ip', '192.0.2.5');
  verified.headers.set('x-vercel-ip-country', 'ZA');
  verified.headers.set('x-wm-edge-proof', 'edge-secret-xyz');
  const verifiedCtx = makeWaitUntilCtx();
  assert.equal((await handler(verified, verifiedCtx.ctx)).status, 200);
  await verifiedCtx.settle();

  const forged = makeReq('POST', { origin: 'https://worldmonitor.app' });
  forged.headers.set('cf-connecting-ip', '203.0.113.7');
  forged.headers.set('cf-ipcountry', 'FR');
  forged.headers.set('x-real-ip', '192.0.2.5');
  forged.headers.set('x-vercel-ip-country', 'ZA');
  const forgedCtx = makeWaitUntilCtx();
  // IP-scoped session minting fails closed on unproven cf-connecting-ip (#8402).
  const forgedResp = await handler(forged, forgedCtx.ctx);
  assert.equal(forgedResp.status, 403);
  assert.equal(forgedResp.headers.get('X-RateLimit-Mode'), 'edge-proof');
  await forgedCtx.settle();

  const tor = makeReq('POST', { origin: 'https://worldmonitor.app' });
  tor.headers.set('cf-connecting-ip', '203.0.113.7');
  tor.headers.set('cf-ipcountry', 'T1');
  tor.headers.set('x-real-ip', '192.0.2.5');
  tor.headers.set('x-vercel-ip-country', 'ZA');
  tor.headers.set('x-wm-edge-proof', 'edge-secret-xyz');
  const torCtx = makeWaitUntilCtx();
  assert.equal((await handler(tor, torCtx.ctx)).status, 200);
  await torCtx.settle();

  assert.equal(events.length, 3);
  assert.deepEqual(
    events.map(({ ip, country }) => ({ ip, country })),
    [
      { ip: '203.0.113.7', country: 'FR' },
      { ip: '192.0.2.5', country: 'ZA' },
      { ip: '203.0.113.7', country: 'ZA' },
    ],
  );
});

test('localhost session cookie remains host-only for dev', async () => {
  const resp = await handler(makeLocalReq('POST', { origin: 'http://localhost:5173' }));
  assert.equal(resp.status, 200);
  const cookies = setCookies(resp);
  const sessionCookies = cookies.filter((cookie) => cookie.startsWith('wm-session='));
  assert.equal(sessionCookies.length, 1, 'localhost must not emit a host-only tombstone');
  assert.doesNotMatch(sessionCookies[0], /Domain=/);
});

test('OPTIONS preflight returns 204 with CORS', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimitForTest();
  const resp = await handler(makeReq('OPTIONS', { origin: 'https://worldmonitor.app' }));
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
});

test('POST fail-closed limiter receives Vercel ctx for degraded telemetry', () => {
  const src = readFileSync(new URL('./wm-session.js', import.meta.url), 'utf8');

  assert.match(src, /export\s+default\s+async\s+function\s+handler\s*\(\s*req\s*,\s*ctx\s*\)/);
  // Extract the wm-session checkRateLimit options block and assert every
  // required property lives inside it. This avoids the overmatch bug where a
  // later `ctx,` in the source file satisfied a looser regex.
  const match = src.match(/checkRateLimit\(req,\s*cors,\s*\{([\s\S]*?)\}\);/);
  assert.ok(match, 'expected one checkRateLimit(req, cors, {...}) call');
  const opts = match[1];
  assert.match(opts, /failClosed:\s*true/, 'rate limiter must be fail-closed');
  assert.match(opts, /ctx,/, 'must pass Vercel ctx for waitUntil/Sentry telemetry');
  assert.match(opts, /scope:\s*SESSION_RATE_LIMIT_SCOPE/, 'must scope to wm-session');
  assert.match(opts, /limit:\s*SESSION_RATE_LIMIT_PER_MINUTE/, 'must use production limit constant');
  assert.match(opts, /window:\s*SESSION_RATE_LIMIT_WINDOW/, 'must use production window constant');
});

test('GET method is rejected with 405', async () => {
  const resp = await handler(makeReq('GET', { origin: 'https://worldmonitor.app' }));
  assert.equal(resp.status, 405);
});

test('Disallowed origin OPTIONS preflight succeeds with echoed Origin (#6411)', async () => {
  const origin = 'https://evil.example.com';
  const resp = await handler(makeReq('OPTIONS', { origin }));
  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('access-control-allow-origin'), origin);
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
});

test('Disallowed origin gets 403', async () => {
  const resp = await handler(makeReq('POST', { origin: 'https://evil.example.com' }));
  assert.equal(resp.status, 403);
});

test('Disallowed origin 403 echoes the request Origin so the client can read it (#6411)', async () => {
  const origin = 'https://evil.example.com';
  const resp = await handler(makeReq('POST', { origin }));
  assert.equal(resp.status, 403);
  assert.equal(resp.headers.get('access-control-allow-origin'), origin);
  assert.equal(resp.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(await resp.text(), 'Forbidden');
});

test('Google Translate proxy origin can mint an anonymous session (#6411)', async () => {
  const origin = 'https://www-worldmonitor-app.translate.goog';
  const resp = await handler(makeReq('POST', { origin }));
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('access-control-allow-origin'), origin);
  const body = await resp.json();
  assert.equal(body.ok, true);
  assert.match(body.token, /^wms_/);
  assert.equal(typeof body.exp, 'number');
});

test('Trailing-dot FQDN first-party origin can mint a session (#6411)', async () => {
  const origin = 'https://nuclear.worldmonitor.app.';
  const resp = await handler(makeReq('POST', { origin }));
  assert.equal(resp.status, 200);
  assert.equal(resp.headers.get('access-control-allow-origin'), origin);
  const body = await resp.json();
  assert.equal(body.ok, true);
  assert.match(body.token, /^wms_/);
});

test('No origin (curl) is allowed (rate limit + token TTL are the throttles)', async () => {
  const resp = await handler(makeReq('POST', {}));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const cookieToken = cookieValue(setCookies(resp), 'wm-session');
  assert.match(body.token, /^wms_/);
  assert.equal(body.token, cookieToken);
  assert.equal(await validateSessionToken(body.token), true);
});

test('POST returns degraded 503 without issuing a token when Redis limiter config is missing', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  __resetRateLimitForTest();

  const resp = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }));

  assert.equal(resp.status, 503);
  assert.equal(resp.headers.get('X-RateLimit-Mode'), 'degraded');
  assert.equal(resp.headers.get('Retry-After'), '5');
  assert.equal(resp.headers.get('access-control-allow-origin'), 'https://worldmonitor.app');
  assert.equal(cookieValue(setCookies(resp), 'wm-session'), '');
  const body = await resp.json();
  assert.match(body.error, /rate-limit service temporarily unavailable/i);
});

test('POST returns 429 without issuing a token when the wm-session issuance budget is exhausted', async () => {
  mockUpstashRateLimit({ remaining: -1, limit: 30 });
  const resp = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }));

  assert.equal(resp.status, 429);
  assert.equal(resp.headers.get('X-RateLimit-Limit'), '30');
  assert.equal(resp.headers.get('X-RateLimit-Remaining'), '0');
  assert.equal(cookieValue(setCookies(resp), 'wm-session'), '');
  const body = await resp.json();
  assert.equal(body.error, 'Too many requests');
});

test('failed mint outcomes emit their terminal status', async () => {
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  const events = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (url.includes('fake.upstash.io')) {
      return new Response(JSON.stringify([{ result: [-1, 30] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('axiom.co')) {
      events.push(...JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected telemetry fetch: ${url}`);
  };
  const { ctx, settle } = makeWaitUntilCtx();

  const resp = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }), ctx);
  assert.equal(resp.status, 429);
  await settle();

  assert.equal(events.length, 1);
  assert.equal(events[0].status, 429);
  assert.equal(events[0].reason, 'rate_limit_429');
});

test('telemetry stops delivery attempts when the Axiom sink is repeatedly unavailable', async () => {
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  let axiomAttempts = 0;
  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (url.includes('fake.upstash.io')) {
      return new Response(JSON.stringify([{ result: [29, 30] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('axiom.co')) {
      axiomAttempts += 1;
      throw new Error('Axiom unavailable');
    }
    throw new Error(`unexpected telemetry fetch: ${url}`);
  };

  for (let index = 0; index < 20; index += 1) {
    const { ctx, settle } = makeWaitUntilCtx();
    const response = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }), ctx);
    assert.equal(response.status, 200);
    await settle();
  }
  assert.equal(axiomAttempts, 20);

  const { ctx, settle } = makeWaitUntilCtx();
  const response = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }), ctx);
  assert.equal(response.status, 200);
  await settle();
  assert.equal(axiomAttempts, 20, 'open circuit breaker drops later telemetry delivery attempts');
});

test('telemetry probes and closes the circuit after the outage window elapses', async () => {
  process.env.USAGE_TELEMETRY = '1';
  process.env.AXIOM_API_TOKEN = 'axiom-test-token';
  const originalDateNow = Date.now;
  let now = 1_000_000;
  let axiomAttempts = 0;
  let axiomAvailable = false;
  Date.now = () => now;
  globalThis.fetch = async (input) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (url.includes('fake.upstash.io')) {
      return new Response(JSON.stringify([{ result: [29, 30] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('axiom.co')) {
      axiomAttempts += 1;
      if (!axiomAvailable) throw new Error('Axiom unavailable');
      return new Response('{}', { status: 200 });
    }
    throw new Error(`unexpected telemetry fetch: ${url}`);
  };

  try {
    for (let index = 0; index < 20; index += 1) {
      const { ctx, settle } = makeWaitUntilCtx();
      await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }), ctx);
      await settle();
    }
    now += 5 * 60 * 1000 + 1;
    axiomAvailable = true;

    const recovered = makeWaitUntilCtx();
    await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }), recovered.ctx);
    await recovered.settle();
    assert.equal(axiomAttempts, 21, 'a single half-open delivery probes the recovered sink');

    const resumed = makeWaitUntilCtx();
    await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }), resumed.ctx);
    await resumed.settle();
    assert.equal(axiomAttempts, 22, 'a successful probe closes the circuit for later events');
  } finally {
    Date.now = originalDateNow;
  }
});

test('Returns 503 when WM_SESSION_SECRET is missing', async () => {
  const stash = process.env.WM_SESSION_SECRET;
  delete process.env.WM_SESSION_SECRET;
  try {
    const resp = await handler(makeReq('POST', { origin: 'https://worldmonitor.app' }));
    assert.equal(resp.status, 503);
    const body = await resp.json();
    assert.match(body.error, /Session service not configured/);
  } finally {
    process.env.WM_SESSION_SECRET = stash;
  }
});

// --- hadSession: does the caller's browser give the cookie back? -------------
// The client cannot answer this itself (HttpOnly), so it could not tell "the
// server rejected my cookie" from "my browser never stored it" — and re-minted
// forever on the second, reporting it as a server-side retry_401. See
// WORLDMONITOR-WG/XP.

function makeReqWithCookie(cookie) {
  const headers = new Headers({ origin: 'https://worldmonitor.app' });
  if (cookie) headers.set('cookie', cookie);
  return new Request('https://api.worldmonitor.app/api/wm-session', { method: 'POST', headers });
}

test('mint reports hadSession:false when the request carries no session cookie', async () => {
  const resp = await handler(makeReqWithCookie(null));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.hadSession, false, 'a first-ever visitor presents no cookie');
});

test('mint reports hadSession:true when the browser returns the cookie it was issued', async () => {
  const first = await handler(makeReqWithCookie(null));
  const token = cookieValue(setCookies(first), 'wm-session');
  assert.match(token, /^wms_/);

  // Exactly what a browser that stored the cookie sends on the next mint.
  const resp = await handler(makeReqWithCookie(`wm-session=${encodeURIComponent(token)}`));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.hadSession, true, 'a cookie that made the round trip must be reported');
});

test('mint reports hadSession:false for a tampered or foreign session cookie', async () => {
  // A cookie that exists but does not verify is not evidence of a working
  // round trip — it must not suppress the client's re-mint.
  const first = await handler(makeReqWithCookie(null));
  const token = cookieValue(setCookies(first), 'wm-session');
  const tampered = `${token.slice(0, -2)}${token.slice(-2) === 'AA' ? 'BB' : 'AA'}`;

  const resp = await handler(makeReqWithCookie(`wm-session=${encodeURIComponent(tampered)}`));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.hadSession, false);
});

test('mint still succeeds when the cookie header is malformed', async () => {
  // hadSession is diagnostic, never a gate: a junk Cookie header must not
  // turn a routine mint into an error.
  const resp = await handler(makeReqWithCookie('wm-session=%%%not-a-token%%%; other=1'));
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.hadSession, false);
  assert.match(cookieValue(setCookies(resp), 'wm-session'), /^wms_/);
});

test('vendor origins cannot mint a session even with a valid privileged cookie', async () => {
  for (const origin of ['https://clerk.worldmonitor.app', 'https://abacus.worldmonitor.app']) {
    const response = await handler(new Request('https://api.worldmonitor.app/api/wm-session', {
      method: 'POST',
      headers: { origin, cookie: '__Host-wm-pro-key=enterprise-secret' },
    }));
    assert.equal(response.status, 403, origin);
    assert.equal(setCookies(response).length, 0);
    // The denial remains readable; echoing a refusal is not an origin grant.
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  }
});

test('a submitted legacy key body is ignored: the response sets only the session cookie', async () => {
  const response = await handler(new Request('https://api.worldmonitor.app/api/wm-session', {
    method: 'POST',
    headers: { origin: 'https://worldmonitor.app', 'content-type': 'application/json' },
    body: JSON.stringify({ widgetKey: 'widget-secret', proKey: 'enterprise-secret' }),
  }));
  assert.equal(response.status, 200);
  const cookies = setCookies(response);
  assert.ok(cookies.length > 0);
  assert.ok(cookies.every((cookie) => cookie.startsWith('wm-session=')), cookies.join(' | '));
});

// ── Partner mode (docs/partner-access.md) ────────────────────────────────

const { __resetPartnerAccessForTests } = await import('./_partner-access.js');
const { SignJWT, exportJWK, generateKeyPair } = await import('jose');

async function partnerFixture() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const issuer = 'https://clerk.partner.test';
  process.env.ACCESS_MODE = 'partner';
  process.env.CLERK_JWT_ISSUER_DOMAIN = issuer;
  process.env.PARTNER_ALLOWED_DOMAINS = 'utility.example';
  __resetPartnerAccessForTests();
  const upstash = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
    if (url === `${issuer}/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    return upstash(input, init);
  };
  const sign = (email) => new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(issuer)
    .setSubject(`user_${email}`)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { sign };
}

function partnerReq(token) {
  const headers = new Headers({ origin: 'https://worldmonitor.app' });
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return new Request('https://api.worldmonitor.app/api/wm-session', { method: 'POST', headers });
}

test('partner mode refuses to mint a session without a signed-in partner', async () => {
  const { sign } = await partnerFixture();

  const anonymous = await handler(partnerReq(''));
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: 'sign_in_required' });
  assert.equal(cookieValue(setCookies(anonymous), 'wm-session'), '');

  const stranger = await handler(partnerReq(await sign('someone@elsewhere.example')));
  assert.equal(stranger.status, 403);
  assert.deepEqual(await stranger.json(), { error: 'partner_access_required' });
  assert.equal(cookieValue(setCookies(stranger), 'wm-session'), '');
});

test('partner mode mints a session for an allowlisted partner', async () => {
  const { sign } = await partnerFixture();
  const resp = await handler(partnerReq(await sign('ops@utility.example')));
  assert.equal(resp.status, 200);
  assert.match(cookieValue(setCookies(resp), 'wm-session'), /^wms_/);
});
