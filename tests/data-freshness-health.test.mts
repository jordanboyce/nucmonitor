import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { dataFreshness, getIntelligenceGaps } from '../src/services/data-freshness.ts';
import {
  __resetHealthFreshnessForTests,
  HEALTH_CHECK_SOURCE_MAP,
  refreshDataFreshnessFromHealth,
} from '../src/services/health-freshness.ts';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('health freshness ingestion', () => {
  it('does not synthesize healthy sources or a Redis outage while refresh is pending', async () => {
    __resetHealthFreshnessForTests();
    const before = structuredClone(dataFreshness.getSource('rss'));
    await assert.rejects(refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({ status: 'REFRESH_PENDING', retryAfterSeconds: 3 }, 503),
    }), /health freshness fetch failed: 503/);
    assert.deepEqual(dataFreshness.getSource('rss'), before);
  });

  it('identifies the weather source and outage gap as NWS/ECCC/WMO SWIC coverage', async () => {
    __resetHealthFreshnessForTests();
    await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date().toISOString(),
        checks: {
          weatherAlerts: {
            status: 'SEED_ERROR',
            records: 0,
            maxStaleMin: 45,
          },
        },
      }),
    });

    const weatherGap = getIntelligenceGaps().find(gap => gap.source === 'weather');

    assert.equal(dataFreshness.getSource('weather')?.name, 'Severe Weather Alerts (NWS, ECCC, WMO SWIC)');
    assert.match(weatherGap?.message ?? '', /NWS, ECCC, or WMO SWIC/);

    // The two assertions above are satisfied by DataFreshnessTracker's constructor alone:
    // it pre-seeds every SOURCE_METADATA entry with `name` and status 'no_data', and
    // getIntelligenceGaps() admits 'no_data' with a static per-source message. Without the
    // two below, this test passes verbatim with the refreshDataFreshnessFromHealth() call
    // above deleted — an inert fixture. Only a SEED_ERROR that actually routed through
    // recordSeedHealth sets lastError, which calculateStatus turns into status 'error' and
    // getIntelligenceGaps escalates to 'critical' (weather is requiredForRisk: false, so
    // constructor state yields 'warning').
    assert.equal(dataFreshness.getSource('weather')?.status, 'error');
    assert.equal(weatherGap?.severity, 'critical');
  });

  it('hydrates dataFreshness from /api/health cadence metadata', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          newsInsights: {
            status: 'OK',
            records: 14,
            seedAgeMin: 30,
            maxStaleMin: 420,
          },
          weatherAlerts: {
            status: 'STALE_SEED',
            records: 2,
            seedAgeMin: 60,
            maxStaleMin: 45,
          },
          wildfires: {
            status: 'SEED_ERROR',
            records: 0,
            maxStaleMin: 240,
          },
        },
      }),
    });

    assert.equal(applied, 3);

    const rss = dataFreshness.getSource('rss');
    assert.equal(rss?.status, 'fresh');
    assert.equal(rss?.itemCount, 14);
    assert.equal(rss?.maxStaleMin, 420);
    assert.equal(rss?.lastUpdate?.toISOString(), new Date(checkedAtMs - 30 * 60_000).toISOString());

    const weather = dataFreshness.getSource('weather');
    assert.equal(weather?.status, 'stale');
    assert.equal(weather?.healthStatus, 'STALE_SEED');

    const cyber = dataFreshness.getSource('firms');
    assert.equal(cyber?.status, 'error');
    assert.equal(cyber?.lastError, 'SEED_ERROR');
  });

  it('keeps the frontend mapping pinned to registered api/health checks', () => {
    const healthSrc = readFileSync(resolve(repoRoot, 'api/health.js'), 'utf8');

    for (const checkName of Object.keys(HEALTH_CHECK_SOURCE_MAP)) {
      assert.match(
        healthSrc,
        new RegExp(`\\b${checkName}:\\s*(?:\\{|['"\`])`),
        `HEALTH_CHECK_SOURCE_MAP references ${checkName}, but api/health.js does not register that check`,
      );
    }
  });

  it('uses the worst health status when several checks map to one frontend source', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          climateAnomalies: {
            status: 'OK',
            records: 25,
            seedAgeMin: 10,
            maxStaleMin: 540,
          },
          climateDisasters: {
            status: 'STALE_SEED',
            records: 4,
            seedAgeMin: 900,
            maxStaleMin: 720,
          },
          climateAirQuality: {
            status: 'OK',
            records: 8,
            seedAgeMin: 20,
            maxStaleMin: 180,
          },
        },
      }),
    });

    assert.equal(applied, 1);

    const climate = dataFreshness.getSource('climate');
    assert.equal(climate?.status, 'stale');
    assert.equal(climate?.healthStatus, 'STALE_SEED');
    assert.equal(climate?.itemCount, 4);
  });

  it('treats redis outages as higher severity than ok checks', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          bisPolicy: {
            status: 'OK',
            records: 12,
            seedAgeMin: 0,
            maxStaleMin: 360,
          },
          bisDsr: {
            status: 'REDIS_DOWN',
            records: 0,
            seedAgeMin: 5,
            maxStaleMin: 360,
          },
        },
      }),
    });

    assert.equal(applied, 1);

    const bis = dataFreshness.getSource('bis');
    assert.equal(bis?.status, 'error');
    assert.equal(bis?.healthStatus, 'REDIS_DOWN');
    assert.equal(bis?.lastError, 'REDIS_DOWN');
  });

  it('marks mapped sources unhealthy when /api/health reports top-level redis outage without checks', async () => {
    const mappedSources = new Set(Object.values(HEALTH_CHECK_SOURCE_MAP).flat());
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      // REDIS_DOWN returns HTTP 503 (api/health.js). The consumer must parse the
      // body before bailing on !resp.ok, or this outage branch never runs and
      // mapped sources keep stale freshness. Mocking 503 (not 200) makes this a
      // real guard for that regression.
      fetchFn: async () => jsonResponse({
        status: 'REDIS_DOWN',
        checkedAt: new Date(checkedAtMs).toISOString(),
      }, 503),
    });

    assert.equal(applied, mappedSources.size);
    assert.ok(applied >= 5);

    for (const sourceId of ['rss', 'weather', 'bis'] as const) {
      const source = dataFreshness.getSource(sourceId);
      assert.equal(source?.status, 'error');
      assert.equal(source?.healthStatus, 'REDIS_DOWN');
      assert.equal(source?.lastError, 'REDIS_DOWN');
      assert.equal(source?.itemCount, 0);
    }
  });

  it('does not classify partial coverage as fresh even when recently seeded', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          newsInsights: {
            status: 'COVERAGE_PARTIAL',
            records: 12,
            seedAgeMin: 1,
            maxStaleMin: 420,
          },
        },
      }),
    });

    assert.equal(applied, 1);

    const rss = dataFreshness.getSource('rss');
    assert.equal(rss?.status, 'stale');
    assert.equal(rss?.healthStatus, 'COVERAGE_PARTIAL');
    assert.equal(rss?.lastError, null);
  });

  it('does not classify stale seeds as fresh even when recently seeded', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          newsInsights: {
            status: 'STALE_SEED',
            records: 12,
            seedAgeMin: 1,
            maxStaleMin: 420,
          },
        },
      }),
    });

    assert.equal(applied, 1);

    const rss = dataFreshness.getSource('rss');
    assert.equal(rss?.status, 'stale');
    assert.equal(rss?.healthStatus, 'STALE_SEED');
    assert.equal(rss?.lastError, null);
  });

  it('uses stale content age instead of seed age for STALE_CONTENT checks', async () => {
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          bisDsr: {
            status: 'STALE_CONTENT',
            records: 9,
            seedAgeMin: 1,
            maxStaleMin: 360,
            contentAgeMin: 90,
            maxContentAgeMin: 60,
          },
        },
      }),
    });

    assert.equal(applied, 1);

    const bls = dataFreshness.getSource('bis');
    assert.equal(bls?.status, 'stale');
    assert.notEqual(bls?.status, 'fresh');
    assert.equal(bls?.healthStatus, 'STALE_CONTENT');
    assert.equal(bls?.lastError, null);
    assert.equal(bls?.maxStaleMin, 60);
    assert.equal(bls?.lastUpdate?.toISOString(), new Date(checkedAtMs - 90 * 60_000).toISOString());
  });

  // Detailed /api/health was operator-key-gated by #4715; the anonymous
  // dashboard must read the keyless compact variant or every visitor 401s
  // once a minute and the seed-health pipeline goes silently dead (#4902).
  it('defaults to the keyless compact endpoint', async () => {
    __resetHealthFreshnessForTests();
    const seenUrls: string[] = [];
    await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async (url) => {
        seenUrls.push(String(url));
        return jsonResponse({ status: 'HEALTHY', checkedAt: new Date().toISOString() });
      },
    });
    assert.deepEqual(seenUrls, ['/api/health?compact=1']);
  });

  // Cloudflare's zone Browser-Cache-TTL override rewrites the origin's
  // max-age=0 to 30min on this path (#4910). A browser-cached body older than
  // the 15-min FRESH_THRESHOLD would flip every synthesized-OK source to
  // stale in oscillating waves, so the poller must revalidate every tick —
  // the CDN's 60s edge cache still absorbs the origin cost.
  it('forces browser revalidation on every poll (cache: no-cache)', async () => {
    __resetHealthFreshnessForTests();
    let seenInit: RequestInit | undefined;
    await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async (_url, init) => {
        seenInit = init;
        return jsonResponse({ status: 'HEALTHY', checkedAt: new Date().toISOString() });
      },
    });
    assert.equal(seenInit?.cache, 'no-cache');
  });

  it('hydrates from a compact payload: problems degrade, absent mapped checks read healthy', async () => {
    __resetHealthFreshnessForTests();
    const mappedSources = new Set(Object.values(HEALTH_CHECK_SOURCE_MAP).flat());
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        status: 'DEGRADED',
        summary: { total: 196, ok: 195, warn: 0, onDemandWarn: 0, staleContent: 0, crit: 1 },
        checkedAt: new Date(checkedAtMs).toISOString(),
        problems: {
          newsInsights: { status: 'STALE_SEED', records: 6, seedAgeMin: 900, maxStaleMin: 720 },
        },
      }),
    });

    // Every mapped source gets an update: the problem entry for gdelt, a
    // synthesized server-vouched OK for the rest.
    assert.equal(applied, mappedSources.size);

    const rss = dataFreshness.getSource('rss');
    assert.equal(rss?.status, 'stale');
    assert.equal(rss?.healthStatus, 'STALE_SEED');
    assert.equal(rss?.itemCount, 6);

    const weather = dataFreshness.getSource('weather');
    assert.equal(weather?.status, 'fresh');
    assert.equal(weather?.healthStatus, 'OK');
    assert.equal(weather?.lastUpdate?.toISOString(), new Date(checkedAtMs).toISOString());
  });

  it('degrades only the mapped source when HEALTHY availability contains a problem', async () => {
    __resetHealthFreshnessForTests();
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        status: 'HEALTHY',
        summary: {
          total: 292, ok: 291, warn: 1, containedWarn: 1,
          onDemandWarn: 0, staleContent: 0, crit: 0,
        },
        checkedAt: new Date(checkedAtMs).toISOString(),
        problems: {
          newsInsights: {
            status: 'COVERAGE_PARTIAL', records: 12,
            seedAgeMin: 1, maxStaleMin: 420,
          },
        },
      }),
    });

    const mappedSources = new Set(Object.values(HEALTH_CHECK_SOURCE_MAP).flat());
    assert.equal(applied, mappedSources.size);
    assert.equal(dataFreshness.getSource('rss')?.status, 'stale');
    assert.equal(dataFreshness.getSource('rss')?.healthStatus, 'COVERAGE_PARTIAL');
    assert.equal(dataFreshness.getSource('weather')?.status, 'fresh');
    assert.equal(dataFreshness.getSource('weather')?.healthStatus, 'OK');
  });

  it('preserves stale content and its vintage from a pending-only compact payload', async () => {
    __resetHealthFreshnessForTests();
    const checkedAtMs = Date.now();
    await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        status: 'HEALTHY',
        checkedAt: new Date(checkedAtMs).toISOString(),
        pending: {
          bisDsr: {
            status: 'STALE_CONTENT', records: 9,
            seedAgeMin: 1, maxStaleMin: 360,
            contentAgeMin: 90, maxContentAgeMin: 60,
          },
        },
      }),
    });

    const bls = dataFreshness.getSource('bis');
    assert.equal(bls?.status, 'stale');
    assert.equal(bls?.healthStatus, 'STALE_CONTENT');
    assert.equal(bls?.itemCount, 9);
    assert.equal(bls?.maxStaleMin, 60);
    assert.equal(bls?.lastUpdate?.toISOString(), new Date(checkedAtMs - 90 * 60_000).toISOString());
  });

  it('prefers a compact problem over a duplicate pending check', async () => {
    __resetHealthFreshnessForTests();
    const checkedAtMs = Date.now();
    await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        status: 'DEGRADED',
        checkedAt: new Date(checkedAtMs).toISOString(),
        pending: {
          weatherAlerts: { status: 'STALE_CONTENT', records: 2, contentAgeMin: 60, maxContentAgeMin: 45 },
        },
        problems: {
          weatherAlerts: { status: 'STALE_SEED', records: 4, seedAgeMin: 90, maxStaleMin: 45 },
        },
      }),
    });

    const weather = dataFreshness.getSource('weather');
    assert.equal(weather?.healthStatus, 'STALE_SEED');
    assert.equal(weather?.itemCount, 4);
    assert.equal(weather?.maxStaleMin, 45);
    assert.equal(weather?.lastUpdate?.toISOString(), new Date(checkedAtMs - 90 * 60_000).toISOString());
  });

  it('keeps full checks authoritative over both compact maps', async () => {
    __resetHealthFreshnessForTests();
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        status: 'HEALTHY',
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          weatherAlerts: { status: 'OK', records: 3, seedAgeMin: 5, maxStaleMin: 45 },
        },
        pending: { weatherAlerts: { status: 'STALE_CONTENT' } },
        problems: { weatherAlerts: { status: 'SEED_ERROR' }, newsInsights: { status: 'SEED_ERROR' } },
      }),
    });

    assert.equal(applied, 1);
    const weather = dataFreshness.getSource('weather');
    assert.equal(weather?.status, 'fresh');
    assert.equal(weather?.healthStatus, 'OK');
    assert.equal(weather?.itemCount, 3);
    assert.equal(weather?.lastUpdate?.toISOString(), new Date(checkedAtMs - 5 * 60_000).toISOString());
  });

  it('marks all mapped sources healthy on a compact payload with no problems or pending keys', async () => {
    __resetHealthFreshnessForTests();
    const mappedSources = new Set(Object.values(HEALTH_CHECK_SOURCE_MAP).flat());
    const checkedAtMs = Date.now();
    const applied = await refreshDataFreshnessFromHealth({
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        status: 'HEALTHY',
        summary: { total: 196, ok: 196, warn: 0, onDemandWarn: 0, staleContent: 0, crit: 0 },
        checkedAt: new Date(checkedAtMs).toISOString(),
      }),
    });

    assert.equal(applied, mappedSources.size);

    // cyber_threats carried SEED_ERROR from an earlier ingest above — a
    // healthy compact snapshot must clear it.
    const cyber = dataFreshness.getSource('firms');
    assert.equal(cyber?.status, 'fresh');
    assert.equal(cyber?.healthStatus, 'OK');
    assert.equal(cyber?.lastError, null);
  });

  it('suppresses refetch for a window after an auth-gated 401 instead of erroring every tick', async () => {
    __resetHealthFreshnessForTests();
    let calls = 0;
    const fetchFn = async () => {
      calls++;
      return jsonResponse({ error: 'API key required' }, 401);
    };

    await assert.rejects(
      refreshDataFreshnessFromHealth({ urlResolver: (p) => p, fetchFn }),
      /401/,
    );
    assert.equal(calls, 1);

    // Within the suppression window: no request, no throw — the scheduler
    // keeps ticking every 60s and must not re-error each tick (#4902).
    const applied = await refreshDataFreshnessFromHealth({ urlResolver: (p) => p, fetchFn });
    assert.equal(applied, 0);
    assert.equal(calls, 1, 'suppression window must not issue another request');

    // After the window (reset here), the probe runs — and errors — again, so
    // a persistent re-gate stays visible at 1 event per window per tab.
    __resetHealthFreshnessForTests();
    await assert.rejects(
      refreshDataFreshnessFromHealth({ urlResolver: (p) => p, fetchFn }),
      /401/,
    );
    assert.equal(calls, 2);

    __resetHealthFreshnessForTests();
  });

  it('renders server-crit and server-warn statuses as degraded, not fresh (#6780)', async () => {
    __resetHealthFreshnessForTests();
    const checkedAtMs = Date.now();
    await refreshDataFreshnessFromHealth({
      endpoint: '/api/health',
      urlResolver: (path) => path,
      fetchFn: async () => jsonResponse({
        checkedAt: new Date(checkedAtMs).toISOString(),
        checks: {
          // Server-crit: must surface as an error even at a fresh seed age,
          // instead of passing calculateStatus's age check as 'fresh'.
          weatherAlerts: { status: 'CHINA_UNAVAILABLE', records: 5, seedAgeMin: 1, maxStaleMin: 45 },
          // Server-warn degradation: fresh age but must render 'stale'.
          newsInsights: { status: 'COVERAGE_DEGRADED', records: 10, seedAgeMin: 1, maxStaleMin: 420 },
          // Server-ok: an intentionally-blocked source is NOT a degradation and
          // must still render 'fresh' at a fresh age (guards a future edit from
          // folding it in with the warn statuses next to it).
          wildfires: { status: 'SOURCE_BLOCKED', records: 8, seedAgeMin: 1, maxStaleMin: 240 },
        },
      }),
    });

    // Before #6780 the first two rendered 'fresh' (green): CHINA_UNAVAILABLE was
    // not an error predicate and COVERAGE_DEGRADED was not in the fresh-age stale
    // set. SOURCE_BLOCKED must stay fresh in both the old and new behavior.
    assert.equal(dataFreshness.getSource('weather')?.status, 'error');
    assert.equal(dataFreshness.getSource('rss')?.status, 'stale');
    assert.equal(dataFreshness.getSource('firms')?.status, 'fresh');
  });
});
