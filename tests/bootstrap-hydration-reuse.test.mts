import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { PluginBuild } from 'esbuild';
import { readFileSync } from 'node:fs';

// #7048 — getHydratedData() is consume-once, so a recurring loader that
// returned an accepted bootstrap value directly refetched its RPC on every
// later viewport/refresh call. These tests pin the reuse contract: a valid
// hydrated value must survive into the owning breaker cache (or, for loaders
// with no breaker, the service-owned hydration handoff), so the second call
// makes zero network requests; empty hydration still falls through once; the
// handoff expires so a normal refresh can resume.

type Harness = {
  fetchBootstrapData: () => Promise<void>;
  bootstrapTesting: {
    resetBootstrapForTests: () => void;
    seedHydrationCacheForTests: (data: Record<string, unknown>) => void;
  };
  fetchNaturalEvents: () => Promise<Array<{ id: string; title: string }>>;
  fetchAllFires: () => Promise<{ totalCount: number; regions?: Record<string, unknown[]>; skipped?: boolean }>;
  fetchEarthquakes: () => Promise<Array<{ id: string }>>;
  fetchDdosAttacks: () => Promise<{
    protocol: Array<{ label: string }>;
    vector: Array<{ label: string }>;
    dateRangeStart: string;
    dateRangeEnd: string;
    topTargetLocations: Array<{ countryCode: string }>;
  }>;
  fetchTrafficAnomalies: (country?: string) => Promise<{ anomalies: Array<{ id: string }>; totalCount: number }>;
  fetchDiseaseOutbreaks: () => Promise<{ outbreaks: Array<{ id: string }>; fetchedAt: number }>;
  createHydrationHandoff: <T>(
    key: string,
    validate: (value: unknown) => T | null,
    options?: { ttlMs?: number },
  ) => {
    get: () => T | null;
    getOrLoad: (load: () => Promise<T>, fallback: T) => Promise<T>;
  };
};

type MirrorHarness = {
  fetchRadiationWatch: () => Promise<unknown>;
  getLatestRadiationWatch: () => unknown;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const originalFetch = globalThis.fetch;
let harness: Harness;
let mirrorHarness: MirrorHarness;
let capturedBreakerOptions: Record<string, {
  revivePersistedData?: (data: unknown) => unknown;
}>;

const NATURAL_EVENT = {
  id: 'eonet-EONET_1', title: 'Storm Alpha', category: 'severeStorms', categoryTitle: 'Severe Storms',
  lat: 12.5, lon: -70.1, date: '2026-08-01T00:00:00Z', closed: false,
};
const FIRE_DETECTION = {
  id: 'fire-1', region: 'BR', brightness: 330.5, frp: 12.5, confidence: 'FIRE_CONFIDENCE_HIGH',
  acq_date: '2026-08-01', daynight: 'N', location: { latitude: -10.2, longitude: -55.3 },
};
const EARTHQUAKE = {
  id: 'us-7001', place: '12 km SE of X', magnitude: 4.6, depthKm: 33.2,
  occurredAt: 1754000000, sourceUrl: 'https://example.org/eq', source: 'usgs', category: 'usgs',
};
const OUTBREAK = { id: 'out-1', disease: 'Cholera', country: 'YY', cases: 10 };
const DDOS_ATTACK = {
  protocol: [{ label: 'TCP', percentage: 80 }], vector: [],
  dateRangeStart: '2026-09-01T00:00:00Z', dateRangeEnd: '2026-09-08T00:00:00Z', topTargetLocations: [],
};

function bootstrapStub(
  payload: Record<string, unknown>,
  rpcResponseForUrl: (url: string) => unknown | Promise<unknown> = (url) => ({
    __rpc: true,
    url,
    events: [],
    fireDetections: [],
    anomalies: [],
    totalCount: 0,
  }),
) {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.includes('/api/bootstrap')) {
      // A real bootstrap key belongs to one tier. Keep the deferred slow-tier
      // request empty so it cannot repopulate a consume-once test key and mask
      // whether the service cache or handoff answered the recurring call.
      const data = url.includes('tier=slow') ? {} : payload;
      return new Response(JSON.stringify({ data, missing: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(await rpcResponseForUrl(url)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return requests;
}

function rpcUrlCount(requests: string[]): number {
  return requests.filter((url) => !url.includes('/api/bootstrap')).length;
}

async function waitForRpcCount(requests: string[], expected: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && rpcUrlCount(requests) < expected; attempt += 1) {
    await new Promise<void>((resolveWait) => setImmediate(resolveWait));
  }
  assert.equal(rpcUrlCount(requests), expected);
}

before(async () => {
  // Stub the browser-only seams (panel-gating -> entitlements -> i18n's
  // import.meta.glob, which only exists under Vite) in case a bundled service
  // reaches them. Anonymous access is intentional: it exercises the public
  // bootstrap fallback, the branch used by ordinary visitors.
  const stubBrowserSeams = {
    name: 'stub-browser-seams',
    setup(b: PluginBuild) {
      b.onResolve({ filter: /services\/panel-gating/ }, () => ({ path: 'stub:panel-gating', namespace: 'stub-seam' }));
      b.onResolve({ filter: /services\/premium-fetch/ }, () => ({ path: 'stub:premium-fetch', namespace: 'stub-seam' }));
      b.onResolve({ filter: /services\/i18n/ }, () => ({ path: 'stub:i18n', namespace: 'stub-seam' }));
      b.onLoad({ filter: /.*/, namespace: 'stub-seam' }, (args) => ({
        contents: args.path === 'stub:panel-gating'
          ? 'export function hasPremiumAccess() { return false; }'
          : args.path === 'stub:premium-fetch'
            ? 'export async function premiumFetch(...args) { return globalThis.fetch(...args); }'
            : "export function t(key) { return key; } export function getCurrentLanguageTag() { return 'en'; }",
        loader: 'js',
      }));
    },
  };
  const result = await build({
    stdin: {
      contents: [
        "export { fetchNaturalEvents } from './src/services/eonet.ts';",
        "export { fetchAllFires } from './src/services/wildfires/index.ts';",
        "export { fetchEarthquakes } from './src/services/earthquakes.ts';",
        "export { fetchDdosAttacks } from './src/services/infrastructure/index.ts';",
        "export { fetchTrafficAnomalies } from './src/services/infrastructure/index.ts';",
        "export { fetchDiseaseOutbreaks } from './src/services/disease-outbreaks.ts';",
        "export { createHydrationHandoff } from './src/services/hydration-handoff.ts';",
        "export { fetchBootstrapData, __testing__ as bootstrapTesting } from './src/services/bootstrap.ts';",
      ].join('\n'),
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'bootstrap-hydration-reuse-entry.ts',
    },
    bundle: true,
    define: { 'import.meta.env': '{"DEV":false}' },
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
    plugins: [stubBrowserSeams],
  });
  const source = result.outputFiles[0]?.text;
  assert.ok(source, 'esbuild must emit the hydration-reuse harness');
  harness = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) as Harness;

  const captureCircuitBreakerOptions = {
    name: 'capture-circuit-breaker-options',
    setup(b: PluginBuild) {
      b.onResolve({ filter: /utils\/circuit-breaker/ }, () => ({ path: 'stub:circuit-breaker', namespace: 'capture-breaker' }));
      b.onLoad({ filter: /.*/, namespace: 'capture-breaker' }, () => ({
        contents: `
          globalThis.__wmCapturedBreakerOptions ??= {};
          export function createCircuitBreaker(options) {
            globalThis.__wmCapturedBreakerOptions[options.name] = options;
            return {
              recordSuccess() {},
              getCached() { return null; },
              clearCache() {},
              getStatus() { return 'ok'; },
              async execute(fn, fallback) {
                const replay = globalThis.__wmBreakerReplay?.[options.name];
                if (replay !== undefined) {
                  if (globalThis.__wmBreakerRunBackground?.includes(options.name)) {
                    const background = Promise.resolve().then(fn);
                    (globalThis.__wmBreakerBackgroundPromises ??= []).push(background);
                  }
                  return replay;
                }
                try { return await fn(); } catch { return fallback; }
              },
            };
          }
        `,
        loader: 'js',
      }));
    },
  };
  const captureRpcClients = {
    name: 'capture-rpc-clients',
    setup(b: PluginBuild) {
      b.onResolve({ filter: /services\/generated-rpc-clients/ }, () => ({
        path: 'stub:generated-rpc-clients',
        namespace: 'capture-rpc',
      }));
      b.onLoad({ filter: /.*/, namespace: 'capture-rpc' }, () => ({
        contents: `
          export class RadiationServiceClient {
            constructor() {}
            async listRadiationObservations() { return globalThis.__wmCapturedLiveRadiation; }
          }
        `,
        loader: 'js',
      }));
    },
  };
  const reviverCapture = await build({
    stdin: {
      contents: [
        "export { fetchRadiationWatch, getLatestRadiationWatch } from './src/services/radiation.ts';",
      ].join('\n'),
      loader: 'ts',
      resolveDir: root,
      sourcefile: 'bootstrap-persisted-date-revivers-entry.ts',
    },
    bundle: true,
    define: { 'import.meta.env': '{"DEV":false}' },
    format: 'esm',
    logLevel: 'silent',
    platform: 'node',
    target: 'node20',
    write: false,
    plugins: [captureCircuitBreakerOptions, captureRpcClients, stubBrowserSeams],
  });
  const reviverSource = reviverCapture.outputFiles[0]?.text;
  assert.ok(reviverSource, 'esbuild must emit the Date-reviver capture harness');
  mirrorHarness = await import(
    `data:text/javascript;base64,${Buffer.from(reviverSource).toString('base64')}`
  ) as MirrorHarness;
  capturedBreakerOptions = (globalThis as typeof globalThis & {
    __wmCapturedBreakerOptions: typeof capturedBreakerOptions;
  }).__wmCapturedBreakerOptions;
  delete (globalThis as typeof globalThis & {
    __wmCapturedBreakerOptions?: typeof capturedBreakerOptions;
  }).__wmCapturedBreakerOptions;
});

afterEach(() => {
  harness.bootstrapTesting.resetBootstrapForTests();
  globalThis.fetch = originalFetch;
});

describe('bootstrap hydration reuse (#7048)', () => {
  // Runs FIRST: the service breakers are module singletons, so a later test
  // that warms a cache would otherwise answer this fallthrough scenario from
  // that stale entry.
  it('empty hydration falls through once to the fetch path (recovery preserved)', async () => {
    const requests = bootstrapStub({ naturalEvents: { events: [] } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchNaturalEvents();
    assert.deepEqual(first, [], 'breaker fallback shape is preserved for rejected hydration');
    assert.equal(rpcUrlCount(requests), 1, 'the first rejected hydration falls through exactly once');

    const second = await harness.fetchNaturalEvents();
    assert.deepEqual(second, []);
    assert.equal(rpcUrlCount(requests), 2, 'an empty live response is not promoted into the breaker cache');
  });

  it('naturalEvents: a second call is served from the warmed breaker with zero RPC requests', async () => {
    const requests = bootstrapStub({ naturalEvents: { events: [NATURAL_EVENT] } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchNaturalEvents();
    const second = await harness.fetchNaturalEvents();

    assert.equal(first.length, 1);
    assert.equal(first[0].id, 'eonet-EONET_1');
    assert.deepEqual(second, first, 'second call must return equivalent data');
    assert.equal(rpcUrlCount(requests), 0, 'accepted hydration must not be followed by an RPC refetch');
  });

  it('concurrent first reads of accepted hydration make zero RPC requests', async () => {
    const requests = bootstrapStub({ earthquakes: { earthquakes: [EARTHQUAKE] } });
    await harness.fetchBootstrapData();

    const [a, b] = await Promise.all([harness.fetchEarthquakes(), harness.fetchEarthquakes()]);
    assert.equal(a.length, 1);
    assert.deepEqual(b, a);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('wildfires: rejected hydration and empty live data remain retryable', async () => {
    const requests = bootstrapStub({ wildfires: { fireDetections: [], fetchedAt: 0, dataAvailable: false } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchAllFires();
    const second = await harness.fetchAllFires();

    assert.equal(first.totalCount, 0);
    assert.equal(second.totalCount, 0);
    assert.equal(rpcUrlCount(requests), 2, 'each call retries because empty wildfire data is not cached');
  });

  it('wildfires: a second call is served from the warmed breaker with zero RPC requests', async () => {
    const requests = bootstrapStub({ wildfires: { fireDetections: [FIRE_DETECTION], fetchedAt: 1, dataAvailable: true } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchAllFires();
    const second = await harness.fetchAllFires();

    assert.equal(first.totalCount, 1);
    assert.ok(first.regions && Object.keys(first.regions).length === 1, 'detections are grouped by region');
    assert.deepEqual(second, first);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('earthquakes: a second call is served from the warmed breaker with zero RPC requests', async () => {
    const requests = bootstrapStub({ earthquakes: { earthquakes: [EARTHQUAKE] } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchEarthquakes();
    const second = await harness.fetchEarthquakes();

    assert.equal(first.length, 1);
    assert.equal(first[0].id, 'us-7001');
    assert.deepEqual(second, first);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('malformed live DDoS and traffic responses use their fallbacks', async () => {
    const requests = bootstrapStub({}, (url) => {
      if (url.includes('list-internet-ddos-attacks')) {
        return { protocol: [], vector: [], dateRangeStart: '', dateRangeEnd: '', topTargetLocations: null };
      }
      if (url.includes('list-internet-traffic-anomalies')) return { anomalies: [], totalCount: '0' };
      return { anomalies: [], totalCount: 0 };
    });
    await harness.fetchBootstrapData();

    const [firstDdos, firstTraffic] = await Promise.all([
      harness.fetchDdosAttacks(),
      harness.fetchTrafficAnomalies(),
    ]);

    assert.deepEqual(firstDdos, { protocol: [], vector: [], dateRangeStart: '', dateRangeEnd: '', topTargetLocations: [] });
    assert.deepEqual(firstTraffic, { anomalies: [], totalCount: 0 });
    assert.equal(rpcUrlCount(requests), 2, 'each malformed live response must reach its runtime guard');
  });

  it('malformed DDoS and traffic hydration falls through instead of warming the global cache', async () => {
    const requests = bootstrapStub({
      ddosAttacks: { protocol: [], vector: [], dateRangeStart: '', dateRangeEnd: '' },
      trafficAnomalies: { anomalies: [], totalCount: '0' },
    }, (url) => {
      if (url.includes('list-internet-ddos-attacks')) return DDOS_ATTACK;
      if (url.includes('list-internet-traffic-anomalies')) return { anomalies: [{ id: 'live-traffic' }], totalCount: 1 };
      return { anomalies: [], totalCount: 0 };
    });
    await harness.fetchBootstrapData();

    const [ddos, traffic] = await Promise.all([
      harness.fetchDdosAttacks(),
      harness.fetchTrafficAnomalies(),
    ]);

    assert.equal(ddos.protocol[0]?.label, 'TCP');
    assert.equal(traffic.anomalies[0]?.id, 'live-traffic');
    assert.equal(rpcUrlCount(requests), 2, 'each malformed global hydration must use its live RPC fallback');
  });

  it('DDoS: authoritative empty hydration replaces stale global cache data', async () => {
    const requests = bootstrapStub({
      ddosAttacks: { protocol: [], vector: [], dateRangeStart: '', dateRangeEnd: '', topTargetLocations: [] },
    });
    await harness.fetchBootstrapData();

    const first = await harness.fetchDdosAttacks();
    const second = await harness.fetchDdosAttacks();

    assert.deepEqual(first, { protocol: [], vector: [], dateRangeStart: '', dateRangeEnd: '', topTargetLocations: [] });
    assert.deepEqual(second, first, 'the empty global DDoS snapshot replaces the previous cached response');
    assert.equal(rpcUrlCount(requests), 0, 'valid empty DDoS hydration must stay in the breaker cache');
  });

  it('traffic anomalies: global hydration never satisfies a country-specific cache key', async () => {
    const requests = bootstrapStub({
      trafficAnomalies: { anomalies: [{ id: 'global-1' }], totalCount: 1 },
    });
    await harness.fetchBootstrapData();

    const global = await harness.fetchTrafficAnomalies();
    const filtered = await harness.fetchTrafficAnomalies('US');

    assert.equal(global.anomalies[0]?.id, 'global-1');
    assert.deepEqual(filtered.anomalies, []);
    assert.equal(rpcUrlCount(requests), 1, 'the filtered read must use its own RPC/cache key');
  });

  it('traffic anomalies: authoritative empty hydration and country results stay cached', async () => {
    const requests = bootstrapStub({
      trafficAnomalies: { anomalies: [], totalCount: 0 },
    });
    await harness.fetchBootstrapData();

    const globalFirst = await harness.fetchTrafficAnomalies();
    const globalSecond = await harness.fetchTrafficAnomalies();
    assert.deepEqual(globalFirst, { anomalies: [], totalCount: 0 });
    assert.deepEqual(globalSecond, globalFirst, 'the empty global snapshot replaces the previous cached response');
    assert.equal(rpcUrlCount(requests), 0, 'valid empty global traffic hydration must stay in the breaker cache');

    await harness.fetchTrafficAnomalies('CA');
    await harness.fetchTrafficAnomalies('CA');
    assert.equal(rpcUrlCount(requests), 1, 'the confirmed empty country result stays cached after its first RPC');
  });

  it('diseaseOutbreaks retries unavailable hydration and retains confirmed-empty RPC data', async () => {
    const payload = { outbreaks: [], fetchedAt: Date.now(), alertLevelMethodologyVersion: 'v1' };
    const requests = bootstrapStub({ diseaseOutbreaks: { outbreaks: [], fetchedAt: 0 } }, () => payload);
    await harness.fetchBootstrapData();
    assert.deepEqual(await harness.fetchDiseaseOutbreaks(), payload);
    assert.deepEqual(await harness.fetchDiseaseOutbreaks(), payload);
    assert.equal(rpcUrlCount(requests), 1);
  });

  it('diseaseOutbreaks retains confirmed-empty hydration without an RPC', async () => {
    const payload = { outbreaks: [], fetchedAt: Date.now(), alertLevelMethodologyVersion: 'v1' };
    const requests = bootstrapStub({ diseaseOutbreaks: payload });
    await harness.fetchBootstrapData();
    assert.deepEqual(await harness.fetchDiseaseOutbreaks(), payload);
    assert.deepEqual(await harness.fetchDiseaseOutbreaks(), payload);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('diseaseOutbreaks (no breaker): the hydration handoff answers recurring reads', async () => {
    const requests = bootstrapStub({ diseaseOutbreaks: { outbreaks: [OUTBREAK], fetchedAt: 1, alertLevelMethodologyVersion: 'v1' } });
    await harness.fetchBootstrapData();

    const first = await harness.fetchDiseaseOutbreaks();
    const second = await harness.fetchDiseaseOutbreaks();

    assert.equal(first.outbreaks.length, 1);
    assert.deepEqual(second, first);
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('hydration handoff: TTL expiry lets the normal fetch path resume', async () => {
    const handoff = harness.createHydrationHandoff<{ v: number }>(
      'unitHandoffKey',
      (value) => (value && typeof (value as { v?: unknown }).v === 'number' ? value as { v: number } : null),
      { ttlMs: 5 },
    );
    assert.equal(handoff.get(), null, 'nothing accepted yet');

    // Seed the bootstrap slot the way fetchBootstrapData would.
    const requests = bootstrapStub({ unitHandoffKey: { v: 7 } });
    await harness.fetchBootstrapData();
    assert.equal(handoff.get()?.v, 7);
    assert.equal(handoff.get()?.v, 7);

    await new Promise((r) => setTimeout(r, 20));
    let liveCalls = 0;
    const refreshed = await handoff.getOrLoad(async () => {
      liveCalls++;
      return { v: 8 };
    }, { v: 0 });
    const repeated = await handoff.getOrLoad(async () => {
      liveCalls++;
      return { v: 9 };
    }, { v: 0 });
    assert.equal(refreshed.v, 8, 'expiry permits the normal live refresh');
    assert.equal(repeated.v, 8, 'a valid live refresh starts a new bounded TTL');
    assert.equal(liveCalls, 1, 'the retained live refresh prevents a second load');
    assert.equal(rpcUrlCount(requests), 0);
  });

  it('hydration handoff: concurrent first live loads are one-flight', async () => {
    const handoff = harness.createHydrationHandoff<{ v: number }>(
      'unitHandoffConcurrentKey',
      (value) => ((value as { v?: unknown })?.v === 7 ? value as { v: number } : null),
    );
    let liveCalls = 0;
    let release!: (value: { v: number }) => void;
    const pending = new Promise<{ v: number }>((resolve) => { release = resolve; });
    const load = () => {
      liveCalls++;
      return pending;
    };

    const first = handoff.getOrLoad(load, { v: 0 });
    const second = handoff.getOrLoad(load, { v: 0 });
    assert.equal(liveCalls, 1);
    release({ v: 7 });
    assert.deepEqual(await first, { v: 7 });
    assert.deepEqual(await second, { v: 7 });
    assert.deepEqual(await handoff.getOrLoad(load, { v: 0 }), { v: 7 });
    assert.equal(liveCalls, 1, 'the accepted live result remains in the handoff cache');
  });

  it('hydration handoff: rejected values are not retained', async () => {
    const handoff = harness.createHydrationHandoff<{ v: number }>(
      'unitHandoffRejectedKey',
      (value) => ((value as { v?: unknown })?.v === 42 ? value as { v: number } : null),
      { ttlMs: 60_000 },
    );
    bootstrapStub({ unitHandoffRejectedKey: { v: 41 } });
    await harness.fetchBootstrapData();
    assert.equal(handoff.get(), null, 'invalid hydration is not accepted');
    assert.equal(handoff.get(), null, 'and therefore not retained');
  });

  it('mapped breaker results revive Date fields after JSON persistence', () => {
    const roundTrip = <T>(breakerName: string, value: T): T => {
      const revive = capturedBreakerOptions[breakerName]?.revivePersistedData;
      assert.ok(revive, `${breakerName} must configure revivePersistedData`);
      return revive(JSON.parse(JSON.stringify(value))) as T;
    };

    const radiation = roundTrip('Radiation Watch', {
      fetchedAt: new Date(3),
      observations: [{ observedAt: new Date(4) }],
    });
    assert.ok(radiation.fetchedAt instanceof Date);
    assert.ok(radiation.observations[0]?.observedAt instanceof Date);
  });

  it('persistent breaker replay updates the radiation integration mirror', async () => {
    const radiation = {
      fetchedAt: new Date(11),
      observations: [{ observedAt: new Date(12) }],
      coverage: { epa: 1, safecast: 0 },
      summary: {
        anomalyCount: 0, elevatedCount: 0, spikeCount: 0, corroboratedCount: 0,
        lowConfidenceCount: 0, conflictingCount: 0, convertedFromCpmCount: 0,
      },
    };
    (globalThis as typeof globalThis & {
      __wmBreakerReplay: Record<string, unknown>;
    }).__wmBreakerReplay = {
      'Radiation Watch': radiation,
    };

    try {
      const replayedRadiation = await mirrorHarness.fetchRadiationWatch();
      assert.strictEqual(mirrorHarness.getLatestRadiationWatch(), replayedRadiation);
    } finally {
      delete (globalThis as typeof globalThis & {
        __wmBreakerReplay?: Record<string, unknown>;
      }).__wmBreakerReplay;
    }
  });

  it('stale-while-revalidate advances the radiation integration mirror', async () => {
    const staleRadiation = {
      fetchedAt: new Date(20), observations: [], coverage: { epa: 0, safecast: 0 },
      summary: {
        anomalyCount: 0, elevatedCount: 0, spikeCount: 0, corroboratedCount: 0,
        lowConfidenceCount: 0, conflictingCount: 0, convertedFromCpmCount: 0,
      },
    };
    const liveRadiation = {
      fetchedAt: 22,
      observations: [{
        id: 'rad-live', source: 'RADIATION_SOURCE_EPA_RADNET', contributingSources: [],
        locationName: 'Live station', country: 'US', location: { latitude: 1, longitude: 2 },
        value: 0.1, unit: 'uSv/h', observedAt: 23, freshness: 'RADIATION_FRESHNESS_LIVE',
        baselineValue: 0.1, delta: 0, zScore: 0, severity: 'RADIATION_SEVERITY_NORMAL',
        confidence: 'RADIATION_CONFIDENCE_HIGH', corroborated: false, conflictingSources: false,
        convertedFromCpm: false, sourceCount: 1,
      }],
      epaCount: 1, safecastCount: 0, anomalyCount: 0, elevatedCount: 0, spikeCount: 0,
      corroboratedCount: 0, lowConfidenceCount: 0, conflictingCount: 0, convertedFromCpmCount: 0,
    };
    const scopedGlobal = globalThis as typeof globalThis & {
      __wmBreakerReplay: Record<string, unknown>;
      __wmBreakerRunBackground: string[];
      __wmBreakerBackgroundPromises: Promise<unknown>[];
      __wmCapturedLiveRadiation: unknown;
    };
    scopedGlobal.__wmBreakerReplay = {
      'Radiation Watch': staleRadiation,
    };
    scopedGlobal.__wmBreakerRunBackground = ['Radiation Watch'];
    scopedGlobal.__wmBreakerBackgroundPromises = [];
    scopedGlobal.__wmCapturedLiveRadiation = liveRadiation;
    try {
      await mirrorHarness.fetchRadiationWatch();
      await Promise.all(scopedGlobal.__wmBreakerBackgroundPromises);
      const radiationMirror = mirrorHarness.getLatestRadiationWatch() as { observations?: unknown[] };
      assert.equal(radiationMirror.observations?.length, 1);
    } finally {
      delete (scopedGlobal as Partial<typeof scopedGlobal>).__wmBreakerReplay;
      delete (scopedGlobal as Partial<typeof scopedGlobal>).__wmBreakerRunBackground;
      delete (scopedGlobal as Partial<typeof scopedGlobal>).__wmBreakerBackgroundPromises;
      delete (scopedGlobal as Partial<typeof scopedGlobal>).__wmCapturedLiveRadiation;
      globalThis.fetch = originalFetch;
    }
  });

  it('the mandatory services warm their owner cache in source (#7048 regression pin)', () => {
    // Behavioral coverage above exercises the reuse loop; this pins that the
    // recordSuccess-based warmers (whose owners are typed results rather than
    // raw responses) keep the call, mirroring hydration-lock-keys.test.mts.
    const mustWarm: Array<[string, RegExp]> = [
      ['src/services/radiation.ts', /breaker\.recordSuccess\(result\)/],
      ['src/services/economic/index.ts', /bisPolicyBreaker\.recordSuccess\(hPolicy\)/],
    ];
    for (const [file, marker] of mustWarm) {
      const source = readFileSync(resolve(root, file), 'utf8');
      assert.match(source, marker, `${file} must warm its owner cache with accepted hydration`);
    }

    const radiationSource = readFileSync(resolve(root, 'src/services/radiation.ts'), 'utf8');
    assert.match(radiationSource, /revivePersistedData:/, 'src/services/radiation.ts must revive Date fields after JSON persistence');
  });
});
