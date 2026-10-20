import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  __resetPartnerAccessForTests,
  getAccessMode,
  isAllowlistedEmail,
  verifyPartnerRequest,
} from './_partner-access.js';

const req = (token) => new Request('https://nucmonitor.test/api/wm-session', {
  method: 'POST',
  headers: token ? { Authorization: `Bearer ${token}` } : {},
});

const env = {
  ACCESS_MODE: 'partner',
  PARTNER_ALLOWED_DOMAINS: 'utility.example, @vendor.example',
  PARTNER_ALLOWED_EMAILS: 'consultant@gmail.com',
};

function deps(payload, { convexInvited = false, convexStatus = 200, extraEnv = {} } = {}) {
  const calls = [];
  return {
    calls,
    env: { ...env, ...extraEnv },
    verifyJwt: async () => payload,
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      if (String(url).endsWith('/api/query')) {
        assert.equal(init.headers.Authorization, 'Bearer tok');
        return Response.json({ status: 'success', value: convexInvited }, { status: convexStatus });
      }
      return Response.json({}, { status: 404 });
    },
  };
}

test.beforeEach(() => __resetPartnerAccessForTests());

test('access mode defaults to public-demo and only "partner" switches it', () => {
  assert.equal(getAccessMode({}), 'public-demo');
  assert.equal(getAccessMode({ ACCESS_MODE: 'demo' }), 'public-demo');
  assert.equal(getAccessMode({ ACCESS_MODE: ' Partner ' }), 'partner');
});

test('allowlist matches whole emails and exact domains, never suffixes', () => {
  assert.equal(isAllowlistedEmail('Ops@Utility.Example', env), true);
  assert.equal(isAllowlistedEmail('a@vendor.example', env), true);
  assert.equal(isAllowlistedEmail('consultant@gmail.com', env), true);
  assert.equal(isAllowlistedEmail('someone@gmail.com', env), false);
  assert.equal(isAllowlistedEmail('a@evilutility.example', env), false);
  assert.equal(isAllowlistedEmail('a@sub.utility.example', env), false);
  assert.equal(isAllowlistedEmail('not-an-email', env), false);
});

test('no bearer or an unverifiable token asks the caller to sign in', async () => {
  assert.deepEqual(await verifyPartnerRequest(req(''), deps(null)), { ok: false, status: 401, error: 'sign_in_required' });
  assert.deepEqual(await verifyPartnerRequest(req('tok'), deps(null)), { ok: false, status: 401, error: 'sign_in_required' });
});

test('an allowlisted email is admitted without asking Convex', async () => {
  const d = deps({ sub: 'user_1', email: 'ops@utility.example' }, { extraEnv: { CONVEX_URL: 'https://x.convex.cloud' } });
  assert.deepEqual(await verifyPartnerRequest(req('tok'), d), { ok: true, userId: 'user_1', email: 'ops@utility.example' });
  assert.deepEqual(d.calls, []);
});

test('a Convex invite admits an email the env does not list', async () => {
  const d = deps({ sub: 'user_2', email: 'new@partner.example' }, { convexInvited: true, extraEnv: { CONVEX_URL: 'https://x.convex.cloud' } });
  const verdict = await verifyPartnerRequest(req('tok'), d);
  assert.equal(verdict.ok, true);
  assert.deepEqual(d.calls, ['https://x.convex.cloud/api/query']);
});

test('a signed-in stranger is refused, and the verdict is cached per user', async () => {
  const d = deps({ sub: 'user_3', email: 'stranger@else.example' }, { extraEnv: { CONVEX_URL: 'https://x.convex.cloud' } });
  const refused = { ok: false, status: 403, error: 'partner_access_required' };
  assert.deepEqual(await verifyPartnerRequest(req('tok'), d), refused);
  assert.deepEqual(await verifyPartnerRequest(req('tok'), d), refused);
  assert.equal(d.calls.length, 1);
});

test('a Convex outage is unverifiable, not a refusal, and is not cached', async () => {
  const d = deps({ sub: 'user_4', email: 'x@else.example' }, { convexStatus: 502, extraEnv: { CONVEX_URL: 'https://x.convex.cloud' } });
  assert.deepEqual(await verifyPartnerRequest(req('tok'), d), { ok: false, status: 503, error: 'access_unverifiable' });
  assert.deepEqual(await verifyPartnerRequest(req('tok'), d), { ok: false, status: 503, error: 'access_unverifiable' });
  assert.equal(d.calls.length, 2);
});

test('a JWKS failure is unverifiable', async () => {
  const d = { env, verifyJwt: async () => { throw new TypeError('fetch failed'); } };
  assert.deepEqual(await verifyPartnerRequest(req('tok'), d), { ok: false, status: 503, error: 'access_unverifiable' });
});
