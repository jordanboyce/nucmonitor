import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { load as loadYaml } from 'js-yaml';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';
import rpc from '../api/infrastructure/v1/[rpc].ts';
import bootstrap from '../api/bootstrap.js';
import { issueSessionToken } from '../api/_session.js';
import { BOOTSTRAP_CACHE_KEYS } from '../shared/bootstrap-tier-keys.js';
import { assembleBootstrapTierPayload } from '../scripts/publish-bootstrap-tiers.mjs';
import { sanitizeBootstrapValue as edgeSanitize } from '../api/_bootstrap-public-payload.js';
import { sanitizeBootstrapValue as workerSanitize } from '../scripts/_bootstrap-public-payload.mjs';

const PATH = 'https://api.worldmonitor.app/api/infrastructure/v1/get-bootstrap-data';

async function setup(t: TestContext) {
  for (const [name, value] of Object.entries({
    WM_SESSION_SECRET: 'bootstrap-contract-synthetic-secret-32',
    UPSTASH_REDIS_REST_URL: 'https://redis.test', UPSTASH_REDIS_REST_TOKEN: 'fixture',
    VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_SHA: 'abcdef123456', BOOTSTRAP_R2_SHADOW_MEASURE: '0',
  })) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const rateRedis = createRedisFetch({});
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
  t.after(() => assert.ok(warnings.every(line => !line.includes('[rate-limit]')), warnings.join('\n')));
  const values = new Map<string, unknown>();
  const reads: string[] = [];
  const origins = new Set<string>();
  t.after(() => assert.ok([...origins].every(origin => origin === 'https://redis.test')));
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const origin = new URL(input instanceof Request ? input.url : String(input)).origin;
    origins.add(origin);
    assert.equal(origin, 'https://redis.test');
    const commands = JSON.parse(String(init?.body));
    if (!Array.isArray(commands[0]) || commands.some(([op]: string[]) => op !== 'GET')) {
      return rateRedis.fetchImpl(input, init);
    }
    return Response.json(commands.map(([op, key]: string[]) => {
      if (op !== 'GET') return { result: 1 };
      reads.push(key);
      return { result: values.has(key) ? JSON.stringify(values.get(key)) : null };
    }));
  });
  const token = (await issueSessionToken()).token;
  const request = (query: string) => rpc(new Request(PATH + query, { headers: { 'X-WorldMonitor-Key': token, Origin: 'https://worldmonitor.app' } }));
  return { values, reads, request };
}

test('session RPC rejects unbounded and ambiguous selectors before reading seeds', async t => {
  const { request, reads } = await setup(t);
  for (const query of ['', '?tier=unknown', '?keys=earthquakes&keys=cbrRates', '?tier=fast&keys=earthquakes', '?keys=not-a-key', '?keys=earthquakes&keys=not-a-key']) {
    const response = await request(query);
    assert.equal(response.status, 400, query || 'empty request');
  }
  assert.deepEqual(reads, []);
});

test('explicit single-key request preserves JSON-string response and raw seed reads', async t => {
  const { request, reads, values } = await setup(t);
  values.set(BOOTSTRAP_CACHE_KEYS.earthquakes, { earthquakes: [{ id: 'fixture' }] });
  const response = await request('?keys=earthquakes');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(JSON.parse(body.data.earthquakes), { earthquakes: [{ id: 'fixture' }] });
  assert.deepEqual(reads, [BOOTSTRAP_CACHE_KEYS.earthquakes]);
});

test('several fast/slow keys are served together; on-demand keys still go one at a time', async t => {
  const { request, reads, values } = await setup(t);
  values.set(BOOTSTRAP_CACHE_KEYS.earthquakes, { earthquakes: [{ id: 'fixture' }] });
  const response = await request('?keys=earthquakes&keys=wildfires&keys=earthquakes');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body.data), ['earthquakes']);
  assert.deepEqual(body.missing, ['wildfires']);
  assert.deepEqual(reads.toSorted(), [BOOTSTRAP_CACHE_KEYS.earthquakes, BOOTSTRAP_CACHE_KEYS.wildfires].toSorted());

  reads.length = 0;
  const onDemand = await request('?keys=earthquakes&keys=cbrRates');
  assert.equal(onDemand.status, 400);
  assert.deepEqual(reads, []);
  assert.equal((await request('?keys=cbrRates')).status, 200);
});

test('RPC, public bootstrap and publisher apply the same transforms', async t => {
  const { request, values } = await setup(t);
  const fixtures = {
    wildfires: { fireDetections: Array.from({ length: 501 }, (_, i) => ({ id: String(i) })) },
    naturalEvents: { events: [{ id: 'storm', conePolygon: [{ points: Array.from({ length: 401 }, (_, i) => ({ lon: Math.cos(i * Math.PI / 200), lat: Math.sin(i * Math.PI / 200) })) }] }] },
  };
  for (const [name, value] of Object.entries(fixtures)) {
    values.set(BOOTSTRAP_CACHE_KEYS[name], value);
  }
  for (const name of Object.keys(fixtures)) {
    const response = await request('?keys=' + name);
    assert.equal(response.status, 200);
    const actual = JSON.parse((await response.json()).data[name]);
    const publicResponse = await bootstrap(new Request('https://api.worldmonitor.app/api/bootstrap?tier=slow&public=1'));
    const publicData = (await publicResponse.json()).data;
    const published = await assembleBootstrapTierPayload({ [name]: BOOTSTRAP_CACHE_KEYS[name] });
    assert.deepEqual(actual, JSON.parse(JSON.stringify(published.data[name])));
    if (name in publicData) assert.deepEqual(actual, publicData[name]);
    if (name === 'naturalEvents') assert.ok(actual.events[0].conePolygon[0].points.length <= 96);
    if (name === 'wildfires') assert.equal(actual.fireDetections.length, 500);
  }
});


test('public payload helpers stay equivalent across Edge and worker packaging', () => {
  const edge = readFileSync(new URL('../api/_bootstrap-public-payload.js', import.meta.url), 'utf8');
  const worker = readFileSync(new URL('../scripts/_bootstrap-public-payload.mjs', import.meta.url), 'utf8');
  assert.equal(worker.replaceAll('-dashboard.mjs', '-dashboard.js').replace('./_social-velocity.mjs', './_social-velocity.js'), edge);
});

test('fast and slow selectors stay within their tier; missing values retain their names', async t => {
  const { request, reads } = await setup(t);
  for (const tier of ['fast', 'slow']) {
    reads.length = 0;
    const response = await request('?tier=' + tier);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, {});
    assert.ok(body.missing.length > 0);
    assert.ok(!body.missing.includes('wsbTickers'));
    assert.ok(!body.missing.includes('pipelinesGas'));
    assert.ok(reads.every(key => !key.startsWith('preview:')));
  }
});


test('RPC still requires a session and does not expose arbitrary Redis keys', async t => {
  const { request, reads } = await setup(t);
  const anonymous = await rpc(new Request(PATH + '?keys=earthquakes'));
  assert.equal(anonymous.status, 401);
  const unknown = await request('?keys=seed-meta%3Aprivate');
  assert.equal(unknown.status, 400);
  assert.deepEqual(reads, []);
});


test('published RPC query schema documents the multi-key selector', () => {
  const spec = JSON.parse(readFileSync(new URL('../docs/api/InfrastructureService.openapi.json', import.meta.url), 'utf8'));
  const parameters = spec.paths['/api/infrastructure/v1/get-bootstrap-data'].get.parameters;
  const yaml = loadYaml(readFileSync(new URL('../docs/api/InfrastructureService.openapi.yaml', import.meta.url), 'utf8')) as typeof spec;
  const yamlKeys = yaml.paths['/api/infrastructure/v1/get-bootstrap-data'].get.parameters.find((parameter: { name: string }) => parameter.name === 'keys');
  assert.deepEqual(yamlKeys.schema, { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1 } });
  const keys = parameters.find((parameter: { name: string }) => parameter.name === 'keys');
  assert.equal(keys.schema.maxItems, 100);
  assert.equal(keys.schema.items.minLength, 1);
  const tier = parameters.find((parameter: { name: string }) => parameter.name === 'tier');
  assert.equal(tier.schema.pattern, '^(fast|slow)$');
});
