import { strict as assert } from 'node:assert';
import test from 'node:test';
import { handleAccessRequest, validateAccessRequest } from './request-access.ts';

const ORIGIN = 'https://nucmonitor.test';
const post = (body, extra = {}) => new Request(`${ORIGIN}/api/request-access`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', origin: ORIGIN, ...extra },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const good = { email: 'Ops@Utility.com', organization: 'Utility Co', role: 'EP manager', message: 'Three plants on the Gulf.' };

function convex(status = 200, value = { created: true }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json({ status: status === 200 ? 'success' : 'error', value }, { status });
  };
  return { calls, fetchImpl };
}

test('validates and normalises the form', () => {
  const ok = validateAccessRequest({ ...good, email: '  Ops@Utility.com ' });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, { email: 'ops@utility.com', organization: 'Utility Co', role: 'EP manager', message: 'Three plants on the Gulf.' });
  assert.equal(validateAccessRequest({ ...good, email: 'nope' }).error, 'invalid_email');
  assert.equal(validateAccessRequest({ ...good, organization: '  ' }).error, 'organization_required');
  assert.equal(validateAccessRequest({ ...good, website: 'http://spam' }).error, 'rejected');
  assert.equal(validateAccessRequest(null).error, 'invalid_body');
  assert.equal(validateAccessRequest({ ...good, message: 'x'.repeat(5000) }).value.message.length, 1000);
});

test('stores a valid request in Convex and reports 202', async () => {
  const { calls, fetchImpl } = convex();
  const res = await handleAccessRequest(post(good), { env: { CONVEX_URL: 'https://convex.test' }, fetchImpl });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, created: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://convex.test/api/mutation');
  assert.equal(calls[0].body.path, 'partnerAccess:requestAccess');
  assert.deepEqual(calls[0].body.args, { email: 'ops@utility.com', organization: 'Utility Co', role: 'EP manager', message: 'Three plants on the Gulf.', source: 'landing' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

test('says the intake is not configured, with the contact address, when Convex is absent', async () => {
  const res = await handleAccessRequest(post(good), { env: { PARTNER_CONTACT_EMAIL: 'hello@nucmonitor.test' }, fetchImpl: async () => { throw new Error('must not call'); } });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'intake_not_configured', contact: 'hello@nucmonitor.test' });
});

test('rejects bad input without calling Convex and swallows the honeypot', async () => {
  const { calls, fetchImpl } = convex();
  const env = { CONVEX_URL: 'https://convex.test' };
  assert.equal((await handleAccessRequest(post('{not json'), { env, fetchImpl })).status, 400);
  assert.equal((await handleAccessRequest(post({ ...good, email: 'x' }), { env, fetchImpl })).status, 400);
  const trap = await handleAccessRequest(post({ ...good, website: 'spam' }), { env, fetchImpl });
  assert.equal(trap.status, 202);
  assert.equal(calls.length, 0);
});

test('refuses foreign origins and non-POST methods', async () => {
  const env = { CONVEX_URL: 'https://convex.test' };
  const foreign = await handleAccessRequest(post(good, { origin: 'https://evil.example' }), { env });
  assert.equal(foreign.status, 403);
  const get = await handleAccessRequest(new Request(`${ORIGIN}/api/request-access`, { headers: { origin: ORIGIN } }), { env });
  assert.equal(get.status, 405);
  const preflight = await handleAccessRequest(new Request(`${ORIGIN}/api/request-access`, { method: 'OPTIONS', headers: { origin: ORIGIN } }), { env });
  assert.equal(preflight.status, 204);
});

test('turns a Convex failure into a 503 that still carries the contact address', async () => {
  const { fetchImpl } = convex(500);
  const res = await handleAccessRequest(post(good), { env: { CONVEX_URL: 'https://convex.test', PARTNER_CONTACT_EMAIL: 'hello@nucmonitor.test' }, fetchImpl });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'intake_unavailable', contact: 'hello@nucmonitor.test' });
});
