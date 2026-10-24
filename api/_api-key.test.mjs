import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const SECRET = 'test-secret-must-be-at-least-32-chars-long-xxx';
const ENTERPRISE_KEY = 'enterprise-test-key-123';
process.env.WM_SESSION_SECRET = SECRET;
process.env.WORLDMONITOR_VALID_KEYS = ENTERPRISE_KEY;

const { getHeaderApiKey, validateApiKey } = await import('./_api-key.js');
const { issueSessionToken } = await import('./_session.js');

function makeReq({ origin, referer, secFetchSite, key, cookie } = {}) {
  const headers = new Headers();
  if (origin) headers.set('origin', origin);
  if (referer) headers.set('referer', referer);
  if (secFetchSite) headers.set('sec-fetch-site', secFetchSite);
  if (key) headers.set('x-worldmonitor-key', key);
  if (cookie) headers.set('cookie', cookie);
  return new Request('https://api.worldmonitor.app/api/test', { headers });
}

// ── #3541 regression: header-only signals must NEVER pass ──────────────────

test('#3541: forged Referer alone is rejected', async () => {
  const r = await validateApiKey(makeReq({ referer: 'https://worldmonitor.app/' }));
  assert.equal(r.valid, false);
  assert.equal(r.required, true);
});

test('#3541: forged Sec-Fetch-Site: same-origin alone is rejected (this was the closed-PR bug)', async () => {
  const r = await validateApiKey(makeReq({ secFetchSite: 'same-origin' }));
  assert.equal(r.valid, false);
});

test('#3541: forged Origin: https://worldmonitor.app alone is rejected (no key, no session)', async () => {
  const r = await validateApiKey(makeReq({ origin: 'https://worldmonitor.app' }));
  assert.equal(r.valid, false);
});

test('#3541: combined forged Origin + Sec-Fetch-Site + Referer all together is still rejected', async () => {
  const r = await validateApiKey(makeReq({
    origin: 'https://worldmonitor.app',
    referer: 'https://worldmonitor.app/',
    secFetchSite: 'same-origin',
  }));
  assert.equal(r.valid, false);
});

test('#3541: Sec-Fetch-Site: cross-site alone is rejected', async () => {
  const r = await validateApiKey(makeReq({ secFetchSite: 'cross-site' }));
  assert.equal(r.valid, false);
});

test('#3541: Sec-Fetch-Site: none alone is rejected', async () => {
  const r = await validateApiKey(makeReq({ secFetchSite: 'none' }));
  assert.equal(r.valid, false);
});

// ── Anonymous browser session token (the new trust path) ────────────────────

test('valid wms_ session token from any origin is accepted', async () => {
  const { token } = await issueSessionToken();
  const r = await validateApiKey(makeReq({ key: token }));
  assert.equal(r.valid, true);
  assert.equal(r.required, false);
  assert.equal(r.kind, 'session', 'must tag as session — operator-only surfaces key off kind');
});

test('valid HttpOnly wm-session cookie is accepted without JS-readable auth header', async () => {
  const { token } = await issueSessionToken();
  const r = await validateApiKey(makeReq({ cookie: `wm-session=${encodeURIComponent(token)}` }));
  assert.equal(r.valid, true);
  assert.equal(r.required, false);
  assert.equal(r.kind, 'session');
});

test('dual wm-session cookies use the first value sent by the browser', async () => {
  // getCookie() is first-match. An invalid host-only wm-session listed first
  // shadows a later valid Domain cookie — the production tombstone in
  // api/wm-session.js exists so the browser should not send both after a mint.
  const { token } = await issueSessionToken();
  const shadowed = await validateApiKey(makeReq({
    cookie: `wm-session=wms_invalid; wm-session=${encodeURIComponent(token)}`,
  }));
  assert.equal(shadowed.valid, false, 'first-match keeps the invalid host-only cookie');
  assert.equal(shadowed.error, 'Invalid session token');

  const tombstoned = await validateApiKey(makeReq({
    cookie: `wm-session=${encodeURIComponent(token)}`,
  }));
  assert.equal(tombstoned.valid, true, 'after tombstone only the valid Domain cookie remains');
  assert.equal(tombstoned.kind, 'session');
});

// The retired tester cookies are no longer credentials: an enterprise key
// placed in one does not authenticate, and does not shadow a valid session.
test('retired tester cookies are not credentials', async () => {
  for (const name of ['__Host-wm-pro-key', '__Host-wm-widget-key']) {
    const alone = await validateApiKey(makeReq({ cookie: `${name}=${encodeURIComponent(ENTERPRISE_KEY)}` }));
    assert.equal(alone.valid, false, `${name} alone must not authenticate`);
    assert.equal(alone.error, 'API key required');

    const { token } = await issueSessionToken();
    const withSession = await validateApiKey(makeReq({
      key: token,
      cookie: `${name}=${encodeURIComponent(ENTERPRISE_KEY)}`,
    }));
    assert.equal(withSession.valid, true);
    assert.equal(withSession.kind, 'session', `${name} must not upgrade a session to enterprise`);
  }
});

test('wms_ header ALONE is still kind session (XP preserved)', async () => {
  const { token } = await issueSessionToken();
  const r = await validateApiKey(makeReq({ key: token }));
  assert.equal(r.valid, true);
  assert.equal(r.kind, 'session');
});

test('PR #3557 review: wms_ result must NOT carry kind=enterprise (operator-surface anti-regression)', async () => {
  // Detailed health, seed-health and the per-key meter trust ONLY
  // kind:'enterprise'. If a future refactor mislabels wms_ as enterprise,
  // anonymous tokens silently unlock operator surfaces. Lock the contract here.
  const { token } = await issueSessionToken();
  const r = await validateApiKey(makeReq({ key: token }));
  assert.notEqual(r.kind, 'enterprise');
});

test('enterprise key carries kind=enterprise', async () => {
  const r = await validateApiKey(makeReq({ key: ENTERPRISE_KEY }));
  assert.equal(r.valid, true);
  assert.equal(r.kind, 'enterprise');
  assert.equal(r.credential, ENTERPRISE_KEY);
});

test('enterprise key allowlist uses timingSafeIncludes, not Array.includes', async () => {
  const source = await readFile(new URL('./_api-key.js', import.meta.url), 'utf8');
  assert.match(
    source,
    /import\s*\{[^}]*\btimingSafeIncludes\b[^}]*\}\s*from\s*['"]\.\/_crypto\.js['"]/,
    'api/_api-key.js must use the Edge-safe timingSafeIncludes helper',
  );
  // Ban the common non-constant-time spellings, not just one.
  assert.doesNotMatch(
    source,
    /\bvalidKeys\.(includes|some|indexOf|find)\s*\(/,
    'enterprise key validation must not use non-constant-time Array comparison',
  );
});

test('valid wms_ session token works even when Origin is also forged (not redundant — no privilege escalation)', async () => {
  const { token } = await issueSessionToken();
  const r = await validateApiKey(makeReq({ origin: 'https://evil.example.com', key: token }));
  assert.equal(r.valid, true);
});

test('tampered wms_ token is rejected', async () => {
  const { token } = await issueSessionToken();
  const tampered = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A');
  const r = await validateApiKey(makeReq({ key: tampered }));
  assert.equal(r.valid, false);
  assert.equal(r.error, 'Invalid session token');
});

test('garbage wms_ shape is rejected', async () => {
  const r = await validateApiKey(makeReq({ key: 'wms_garbage' }));
  assert.equal(r.valid, false);
});

// ── Enterprise key (WORLDMONITOR_VALID_KEYS) ────────────────────────────────

test('valid enterprise key is accepted from any origin', async () => {
  const r = await validateApiKey(makeReq({ origin: 'https://evil.example.com', key: ENTERPRISE_KEY }));
  assert.equal(r.valid, true);
  assert.equal(r.required, true);
});

test('invalid enterprise-shape key is rejected', async () => {
  const r = await validateApiKey(makeReq({ key: 'random-string' }));
  assert.equal(r.valid, false);
});

// ── wm_-prefixed keys: there are no per-user keys, only operator keys ──────

test('a wm_-prefixed key outside WORLDMONITOR_VALID_KEYS is simply invalid', async () => {
  const r = await validateApiKey(makeReq({ key: 'wm_user_abc123' }));
  assert.equal(r.required, true);
  assert.equal(r.valid, false);
  assert.equal(r.error, 'Invalid API key');
});


test('getHeaderApiKey centralizes X-WorldMonitor-Key and X-Api-Key aliases', () => {
  assert.equal(getHeaderApiKey(makeReq({ key: 'canonical-key' })), 'canonical-key');
  const req = new Request('https://api.worldmonitor.app/api/test', {
    headers: { 'X-Api-Key': 'alias-key' },
  });
  assert.equal(getHeaderApiKey(req), 'alias-key');
});

test('REGRESSION: wm_-prefixed key in WORLDMONITOR_VALID_KEYS is honored as enterprise', async () => {
  // Pre-#3541 the static enterprise allowlist accepted any key shape, so
  // some operator-issued keys (e.g. Railway WORLDMONITOR_RELAY_KEY) carry the
  // wm_ prefix from before user-issued keys were namespaced. Without the
  // static-allowlist-first ordering, those keys 401 because they get punted
  // to the retired per-user key lookup, which did not know operator-minted values.
  // Symptom: ais-relay warm-pings (Chokepoints / CableHealth / CII /
  // ServiceStatuses) all 401 in production despite the key being literally
  // present in WORLDMONITOR_VALID_KEYS.
  const previous = process.env.WORLDMONITOR_VALID_KEYS;
  process.env.WORLDMONITOR_VALID_KEYS = `${ENTERPRISE_KEY},wm_legacy_operator_key_in_static_list`;
  try {
    const r = await validateApiKey(makeReq({ key: 'wm_legacy_operator_key_in_static_list' }));
    assert.equal(r.valid, true, 'wm_-prefixed key in static allowlist must validate as enterprise');
    assert.equal(r.required, true);
    assert.equal(r.kind, 'enterprise');
  } finally {
    process.env.WORLDMONITOR_VALID_KEYS = previous;
  }
});

// ── Desktop (Tauri) — always requires enterprise key ────────────────────────

test('desktop Tauri origin without key is rejected', async () => {
  const r = await validateApiKey(makeReq({ origin: 'tauri://localhost' }));
  assert.equal(r.valid, false);
  assert.equal(r.error, 'API key required for desktop access');
});

test('desktop Tauri origin with valid enterprise key is accepted', async () => {
  const r = await validateApiKey(makeReq({ origin: 'tauri://localhost', key: ENTERPRISE_KEY }));
  assert.equal(r.valid, true);
});

test('desktop Tauri origin with wms_ session token is rejected (desktop must use enterprise key)', async () => {
  const { token } = await issueSessionToken();
  const r = await validateApiKey(makeReq({ origin: 'tauri://localhost', key: token }));
  assert.equal(r.valid, false);
});

// ── Total absence of credentials ────────────────────────────────────────────

test('completely unauthenticated request is rejected', async () => {
  const r = await validateApiKey(makeReq({}));
  assert.equal(r.valid, false);
  assert.equal(r.required, true);
});
