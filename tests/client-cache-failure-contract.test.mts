import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import { build, type PluginBuild } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalNow = Date.now;
type RpcQueues = Record<string, Array<unknown | Error>>;
type RuntimeGlobals = typeof globalThis & { __clientRpcQueues?: RpcQueues; __clientHydrated?: Record<string, unknown>; __clientPersistent?: Map<string, unknown>; __clientFreshnessErrors?: Array<[string, string]>; __clientFeatureAvailable?: boolean };
const runtime = globalThis as RuntimeGlobals;

afterEach(() => {
  Date.now = originalNow;
  for (const key of ['__clientRpcQueues', '__clientHydrated', '__clientPersistent', '__clientFreshnessErrors', '__clientFeatureAvailable'] as const) delete runtime[key];
});

function serviceStubs() {
  return { name: 'client-cache-failure-runtime-stubs', setup(b: PluginBuild) {
    b.onResolve({ filter: /^@\/utils$/ }, (args) => (
      args.importer.endsWith('/src/services/consumer-prices/index.ts') || args.importer.endsWith('/src/services/cyber/index.ts')
        ? { path: resolve(root, 'src/utils/circuit-breaker.ts') }
        : undefined
    ));
    b.onResolve({ filter: /services\/generated-rpc-clients/ }, () => ({ path: 'stub:rpc', namespace: 'client-stub' }));
    b.onResolve({ filter: /services\/bootstrap$/ }, () => ({ path: 'stub:bootstrap', namespace: 'client-stub' }));
    b.onResolve({ filter: /services\/persistent-cache$/ }, () => ({ path: 'stub:persistent', namespace: 'client-stub' }));
    b.onResolve({ filter: /data-freshness$/ }, () => ({ path: 'stub:freshness', namespace: 'client-stub' }));
    b.onResolve({ filter: /runtime-config$/ }, () => ({ path: 'stub:runtime-config', namespace: 'client-stub' }));
    b.onLoad({ filter: /.*/, namespace: 'client-stub' }, (args) => {
      if (args.path === 'stub:rpc') return { loader: 'js', contents: `
        function take(name) { const value = globalThis.__clientRpcQueues?.[name]?.shift(); if (value instanceof Error) throw value; return value; }
        export class CyberServiceClient { listCyberThreats() { return take('cyber'); } }
        export class UnrestServiceClient { listUnrestEvents() { return take('unrest'); } }
        export class ClimateServiceClient { listClimateAnomalies() { return take('climate'); } }
        export class ConsumerPricesServiceClient { getConsumerPriceOverview() { return take('consumerOverview'); } getConsumerPriceBasketSeries() { return take('consumerSeries'); } listConsumerPriceCategories() { return take('consumerCategories'); } listConsumerPriceMovers() { return take('consumerMovers'); } listRetailerPriceSpreads() { return take('consumerSpreads'); } getConsumerPriceFreshness() { return take('consumerFreshness'); } }
        export class InfrastructureServiceClient { listInternetOutages() { return take('outages'); } listServiceStatuses() { return take('statuses'); } }
        export class IntelligenceServiceClient { listSecurityAdvisories() { return take('advisories'); } listSatellites() { return take('satellites'); } }
      ` };
      if (args.path === 'stub:bootstrap') return { loader: 'js', contents: `
        export function getHydratedData(key) { return globalThis.__clientHydrated?.[key]; }
        export async function ensureHydrated(key) { const value = globalThis.__clientHydrated?.[key]; if (value instanceof Error) throw value; return value; }
      ` };
      if (args.path === 'stub:persistent') return { loader: 'js', contents: `
        export async function getPersistentCache(key) { const data = globalThis.__clientPersistent?.get(key); return data === undefined ? null : { data, updatedAt: Date.now() }; }
        export async function setPersistentCache(key, data) { globalThis.__clientPersistent?.set(key, data); }
        export async function deletePersistentCache(key) { globalThis.__clientPersistent?.delete(key); }
        export async function deletePersistentCacheByPrefix(prefix) { for (const key of globalThis.__clientPersistent?.keys() ?? []) if (key.startsWith(prefix)) globalThis.__clientPersistent.delete(key); }
      ` };
      if (args.path === 'stub:freshness') return { loader: 'js', contents: `export const dataFreshness = { recordUpdate() {}, recordError(id, error) { globalThis.__clientFreshnessErrors?.push([id, error]); } };` };
      return { loader: 'js', contents: `export function isFeatureAvailable() { return globalThis.__clientFeatureAvailable ?? true; }` };
    });
  } };
}

async function loadHarness<T>(exports: string[]): Promise<T> {
  const result = await build({ stdin: { contents: exports.join('\n'), loader: 'ts', resolveDir: root, sourcefile: 'client-cache-failure-runtime-entry.ts' }, bundle: true, define: { 'import.meta.env': '{"DEV":false}' }, format: 'esm', logLevel: 'silent', platform: 'node', target: 'node20', write: false, plugins: [serviceStubs()] });
  const source = result.outputFiles[0]?.text;
  assert.ok(source);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${Math.random()}`) as T;
}

function setup(queues: RpcQueues = {}, hydrated: Record<string, unknown> = {}): void {
  runtime.__clientRpcQueues = queues; runtime.__clientHydrated = hydrated; runtime.__clientPersistent = new Map(); runtime.__clientFreshnessErrors = []; runtime.__clientFeatureAvailable = true;
}
async function settlePersistence(): Promise<void> { await new Promise<void>((resolveWait) => setImmediate(resolveWait)); }

describe('browser service cache failure contracts (#8348)', () => {
  it('climate clears stale anomalies with healthy empty and service status distinguishes rejection', async () => {
    let now = 1_000_000; Date.now = () => now;
    const anomaly = { zone: 'Gulf', location: { latitude: 1, longitude: 2 }, severity: 'ANOMALY_SEVERITY_EXTREME', type: 'ANOMALY_TYPE_WARM' };
    setup({ climate: [{ anomalies: [anomaly] }, { anomalies: [] }], statuses: [new Error('503'), { statuses: [] }] });
    const h = await loadHarness<{ fetchClimateAnomalies(): Promise<{ ok: boolean; anomalies: unknown[] }>; fetchServiceStatuses(): Promise<{ success: boolean; services: unknown[] }> }>(["export { fetchClimateAnomalies } from './src/services/climate/index.ts';", "export { fetchServiceStatuses } from './src/services/infrastructure/index.ts';"]);
    assert.equal((await h.fetchClimateAnomalies()).anomalies.length, 1);
    now += 21 * 60 * 1000;
    assert.equal((await h.fetchClimateAnomalies()).anomalies.length, 1, 'stale read returns last-good while empty refresh runs');
    await settlePersistence();
    assert.deepEqual(await h.fetchClimateAnomalies(), { ok: true, anomalies: [] });
    const failed = await h.fetchServiceStatuses(); const recovered = await h.fetchServiceStatuses();
    assert.equal(failed.success, false); assert.equal(recovered.success, true); assert.deepEqual(recovered.services, []);
  });

  it('outages replace stale non-empty data with healthy empty and remain configured', async () => {
    let now = 1_000_000; Date.now = () => now;
    setup({ outages: [{ outages: [{ id: 'o1', title: 'Outage', link: '', description: '', country: 'AE', severity: '', categories: [] }] }, { outages: [] }] });
    const h = await loadHarness<{ fetchInternetOutages(): Promise<unknown[]>; isOutagesConfigured(): boolean | null }>(["export { fetchInternetOutages, isOutagesConfigured } from './src/services/infrastructure/index.ts';"]);
    assert.equal((await h.fetchInternetOutages()).length, 1); assert.equal(h.isOutagesConfigured(), true);
    now += 31 * 60 * 1000;
    assert.equal((await h.fetchInternetOutages()).length, 1, 'stale read returns last-good while empty refresh runs');
    await settlePersistence();
    assert.deepEqual(await h.fetchInternetOutages(), []); assert.equal(h.isOutagesConfigured(), true);
    runtime.__clientFeatureAvailable = false; assert.deepEqual(await h.fetchInternetOutages(), []); assert.equal(h.isOutagesConfigured(), false);
    runtime.__clientFeatureAvailable = true; assert.deepEqual(await h.fetchInternetOutages(), []); assert.equal(h.isOutagesConfigured(), true, 'cached healthy empty recovers configuration after re-enabling');
  });

});
