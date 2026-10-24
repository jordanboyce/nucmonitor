// @ts-check
// Assessment engine and seeder-contract tests for the grid-alerts envelope.
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAISO_DEMAND_URL, CAISO_STATS_URL, ERCOT_OUTLOOK_URL, ERCOT_PRC_URL, MISO_LOAD_URL, SPP_CONDITIONS_URL,
  SWPC_ALERTS_URL, SWPC_KP_URL, SWPC_SCALES_URL,
} from '../scripts/lib/grid-alerts/adapters.mjs';
import { GRID_REGIONS } from '../scripts/lib/grid-alerts/regions.mjs';
import {
  assessGrid, demandPressure, gicExposure, gridAlertsRecordCount, impactBand, spaceWeatherPoints, validateGridAlerts,
} from '../scripts/lib/grid-alerts/assess.mjs';
import { buildGridAlertsEnvelope } from '../scripts/lib/grid-alerts/index.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/grid-alerts');
const read = (name) => readFileSync(resolve(FIXTURES, name), 'utf8');
const NOW = Date.parse('2026-10-20T21:00:00Z');

function fullFixtureDeps(overrides = {}) {
  const routes = {
    [ERCOT_PRC_URL]: read('ercot-daily-prc.json'),
    [ERCOT_OUTLOOK_URL]: read('ercot-todays-outlook.json'),
    [CAISO_STATS_URL]: read('caiso-stats.json'),
    [CAISO_DEMAND_URL]: read('caiso-demand.csv'),
    [MISO_LOAD_URL]: read('miso-load.json'),
    'https://mis.nyiso.com/public/csv/pal/': read('nyiso-pal.csv'),
    'https://mis.nyiso.com/public/csv/isolf/': read('nyiso-isolf.csv'),
    [SPP_CONDITIONS_URL]: read('spp-conditions.html'),
    'https://api.weather.gov/alerts/active': read('nws-alerts.json'),
    [SWPC_SCALES_URL]: read('swpc-scales.json'),
    [SWPC_KP_URL]: read('swpc-kp.json'),
    [SWPC_ALERTS_URL]: read('swpc-alerts.json'),
    'https://api.eia.gov/v2/electricity/rto/region-data/data/': (url) => read(`eia-930-${new URL(url).searchParams.get('facets[type][]')}.json`),
    ...overrides,
  };
  const lookup = (url) => {
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`no fixture for ${url}`);
    if (hit[1] instanceof Error) throw hit[1];
    return typeof hit[1] === 'function' ? hit[1](url) : hit[1];
  };
  return {
    fetchJson: async (url) => JSON.parse(lookup(url)),
    fetchText: async (url) => lookup(url),
    now: () => NOW,
  };
}

describe('scoring primitives', () => {
  test('impact bands', () => {
    assert.equal(impactBand(0), 'low');
    assert.equal(impactBand(20), 'watch');
    assert.equal(impactBand(44), 'watch');
    assert.equal(impactBand(45), 'elevated');
    assert.equal(impactBand(70), 'critical');
  });
  test('GIC exposure rises with latitude and storm category', () => {
    assert.equal(gicExposure(47), 'high');
    assert.equal(gicExposure(41), 'moderate');
    assert.equal(gicExposure(30), 'low');
    assert.equal(gicExposure(NaN), 'unknown');
    assert.equal(spaceWeatherPoints(0, 'high'), 0);
    assert.ok(spaceWeatherPoints(3, 'high') > spaceWeatherPoints(3, 'low'));
    assert.ok(spaceWeatherPoints(5, 'high') > spaceWeatherPoints(4, 'high'));
    assert.equal(spaceWeatherPoints(9, 'high'), spaceWeatherPoints(5, 'high'), 'clamped');
  });
  test('demand pressure names every driver it scores', () => {
    const dp = demandPressure({ demandMw: 110, forecastMw: 100, capacityMw: 114, prcMw: 2000, reservePct: 2.5, peakForecastMw: 111 });
    assert.equal(dp.demandVsForecastPct, 110);
    assert.equal(dp.drivers.length, 5);
    assert.ok(dp.points >= 14 + 25 + 30 + 30 + 4);
    const quiet = demandPressure({ demandMw: 90, forecastMw: 100 });
    assert.equal(quiet.points, 0);
    assert.deepEqual(quiet.drivers, []);
  });
});

describe('assessGrid', () => {
  test('a region with no data reads unknown/low, never stressed', () => {
    const env = assessGrid({ sources: [], nowMs: NOW });
    assert.equal(env.regions.length, GRID_REGIONS.length);
    assert.ok(env.regions.every((r) => r.status === 'unknown' && r.impact.score === 0 && r.impact.band === 'low'));
    assert.equal(env.summary.overall, 'normal');
    assert.deepEqual(env.alerts, []);
    assert.deepEqual(env.impacts, []);
    assert.equal(env.space, null);
  });

  test('operator emergency plus hazards plus storm compose into drivers and a critical band', () => {
    const env = assessGrid({
      operators: [{ regionId: 'ERCO', level: 'eea1', statusText: 'Energy Emergency Alert 1', note: 'Reserves low', prcMw: 2250, updatedAt: '2026-10-20T20:55:00.000Z', outlook: { demandMw: 68200, capacityMw: 70100, peakForecastMw: 69800 } }],
      weatherAlerts: [
        { id: 'ice', event: 'Ice Storm Warning', category: 'winter', severity: 'Severe', weight: 32, mechanism: 'icing', title: 'Ice Storm Warning', areaDesc: 'Dallas', states: ['TX'], regionIds: ['ERCO', 'MISO'], onset: null, expires: '2099-01-01T00:00:00.000Z', issuedAt: '2026-10-20T20:00:00.000Z', centroid: [-96.5, 32.5], url: null },
        { id: 'cold', event: 'Extreme Cold Warning', category: 'cold', severity: 'Extreme', weight: 28, mechanism: 'demand', title: 'Extreme Cold Warning', areaDesc: 'North Texas', states: ['TX'], regionIds: ['ERCO', 'MISO'], onset: null, expires: '2099-01-01T00:00:00.000Z', issuedAt: '2026-10-20T20:00:00.000Z', centroid: null, url: null },
      ],
      space: { current: { g: 3, gText: 'strong' }, forecast: [{ g: 4 }, { g: 1 }], kp: 6.67, kpAt: null, alerts: [{ id: 'w', gLevel: 4, title: 'WATCH: G4', issuedAt: '2026-10-20T03:00:00.000Z' }] },
      sources: [{ id: 'ercot', ok: true }],
      nowMs: NOW,
    });
    const erco = env.regions.find((r) => r.id === 'ERCO');
    assert.equal(env.regions[0].id, 'ERCO', 'worst region sorts first');
    assert.equal(erco.status, 'eea1');
    assert.equal(erco.impact.band, 'critical');
    assert.ok(erco.impact.drivers.some((d) => /Operator state/.test(d)));
    assert.ok(erco.impact.drivers.some((d) => /physical responsive capability 2250/.test(d)));
    assert.ok(erco.impact.drivers.some((d) => /Ice Storm Warning \(Severe\) in footprint plus 1 more hazard alert/.test(d)));
    assert.ok(erco.impact.drivers.some((d) => /G3 geomagnetic storm with low GIC exposure/.test(d)), 'low-latitude Texas gets only the low-exposure share');
    assert.equal(erco.hazards.alertCount, 2);
    assert.deepEqual(Object.keys(erco.hazards.categories).sort(), ['cold', 'winter']);
    assert.equal(erco.metrics.capacityMw, 70100);
    assert.equal(erco.space.gicExposure, 'low');

    const bpat = env.regions.find((r) => r.id === 'BPAT');
    assert.ok(bpat.impact.drivers.some((d) => /G3 geomagnetic storm with high GIC exposure/.test(d)));
    assert.ok(bpat.impact.drivers.some((d) => /G4 geomagnetic storm forecast/.test(d)));
    assert.equal(bpat.impact.band, 'watch');

    const miso = env.regions.find((r) => r.id === 'MISO');
    assert.equal(miso.status, 'unknown');
    assert.ok(miso.impact.score > 0 && miso.impact.score < erco.impact.score, 'hazards without an operator emergency score lower');

    assert.equal(env.summary.overall, 'critical');
    assert.equal(env.summary.worstRegionId, 'ERCO');
    assert.equal(env.summary.gNow, 3);
    assert.equal(env.summary.gForecastMax, 4);
    const kinds = env.alerts.map((a) => a.kind);
    assert.ok(kinds.includes('operator') && kinds.includes('weather') && kinds.includes('space'));
    assert.equal(env.alerts[0].level, 'emergency', 'emergencies sort first');
    const gNow = env.alerts.find((a) => a.id === 'swpc-g-now-3');
    assert.ok(gNow.regionIds.includes('BPAT') && !gNow.regionIds.includes('FPL'));
    assert.equal(env.space.exposure.find((e) => e.regionId === 'BPAT').exposure, 'high');
    assert.ok(env.impacts[0].regionId === 'ERCO' && env.impacts[0].alertIds.length === 2);
  });

  test('EIA metrics fill regions without an operator feed', () => {
    const eia = new Map([['PJM', { demandMw: 101500, demandAt: '2026-10-20T20', forecastMw: 92000, forecastAt: '2026-10-20T20', peakForecastMw: 104000, peakForecastAt: '2026-10-21T02', netGenerationMw: 99000, interchangeMw: -2500, demandHistory: [['2026-10-20T20', 101500]] }]]);
    const env = assessGrid({ eia, sources: [{ id: 'eia930', ok: true }], nowMs: NOW });
    const pjm = env.regions.find((r) => r.id === 'PJM');
    assert.equal(pjm.metrics.demandVsForecastPct, 110.3);
    assert.ok(pjm.impact.drivers.some((d) => /Demand 110.3% of day-ahead forecast/.test(d)));
    assert.ok(pjm.impact.drivers.some((d) => /near forecast daily peak/.test(d)));
    assert.equal(pjm.impact.score, 18, '14 forecast-overrun points plus 4 near-peak points');
    assert.deepEqual(pjm.dataSources, ['eia930']);
    assert.match(pjm.statusText, /EIA-930 demand only/);
  });
});

describe('buildGridAlertsEnvelope', () => {
  test('assembles every adapter from fixtures into one validated envelope', async () => {
    const env = await buildGridAlertsEnvelope({ deps: fullFixtureDeps(), eiaApiKey: 'k' });
    assert.equal(validateGridAlerts(env), true);
    assert.equal(env.sources.length, 8);
    assert.ok(env.sources.every((s) => s.ok), env.sources.filter((s) => !s.ok).map((s) => `${s.id}: ${s.error}`).join('; '));
    assert.equal(env.summary.sourcesOk, 8);
    assert.equal(gridAlertsRecordCount(env), env.regions.length + env.alerts.length);
    assert.ok(gridAlertsRecordCount(env) > GRID_REGIONS.length);
    const byId = Object.fromEntries(env.regions.map((r) => [r.id, r]));
    assert.equal(byId.ERCO.status, 'eea1');
    assert.equal(byId.CISO.status, 'conservative');
    assert.equal(byId.SWPP.status, 'conservative');
    assert.equal(byId.MISO.metrics.demandMw, 88410.2);
    assert.equal(byId.NYIS.metrics.demandMw, 7760);
    assert.equal(byId.PJM.metrics.demandMw, 101500);
    assert.equal(byId.AZPS.hazards.topEvent, 'Heat Advisory');
    assert.equal(env.summary.gNow, 3);
    assert.equal(env.summary.weatherAlertTotal, 2);
    assert.ok(JSON.stringify(env).length < 400_000, 'payload stays well under the on-demand budget');
  });

  test('one failing source is recorded and the envelope still publishes', async () => {
    const env = await buildGridAlertsEnvelope({ deps: fullFixtureDeps({ [ERCOT_PRC_URL]: new Error('HTTP 503') }), eiaApiKey: 'k' });
    assert.equal(validateGridAlerts(env), true);
    const ercot = env.sources.find((s) => s.id === 'ercot');
    assert.equal(ercot.ok, false);
    assert.equal(ercot.error, 'HTTP 503');
    assert.equal(env.regions.find((r) => r.id === 'ERCO').status, 'unknown');
    assert.equal(env.regions.find((r) => r.id === 'ERCO').metrics.demandMw, 68200, 'EIA demand still fills the region');
  });

  test('all sources failing throws a tagged error so runSeed preserves last-good', async () => {
    const deps = { fetchJson: async () => { throw new Error('down'); }, fetchText: async () => { throw new Error('down'); }, now: () => NOW };
    await assert.rejects(buildGridAlertsEnvelope({ deps, eiaApiKey: '' }), (err) => err.allSourcesFailed === true && /every source failed/.test(err.message));
  });

  test('validateGridAlerts rejects partial region tables and source-less snapshots', () => {
    assert.equal(validateGridAlerts(null), false);
    assert.equal(validateGridAlerts({ schemaVersion: 1, generatedAt: 'x', regions: [], alerts: [], sources: [{ ok: true }] }), false);
    const env = assessGrid({ sources: [{ id: 'x', ok: false }], nowMs: NOW });
    assert.equal(validateGridAlerts(env), false, 'no source answered');
  });
});

describe('seeder module contract', () => {
  test('exports the key names health.js and bootstrap-tier-keys register', async () => {
    const mod = await import('../scripts/seed-grid-alerts.mjs');
    assert.equal(mod.GRID_ALERTS_CANONICAL_KEY, 'energy:grid-alerts:v1');
    assert.equal(mod.GRID_ALERTS_SEED_META_KEY, 'seed-meta:energy:grid-alerts');
    assert.equal(mod.GRID_ALERTS_ACTIVATION_KEY, 'seed-activated:energy:grid-alerts');
    assert.equal(mod.seedOptions.maxStaleMin, 30);
    assert.equal(mod.seedOptions.emptyDataIsFailure, true);
    assert.equal(typeof mod.seedOptions.afterPublish, 'function');
    const { BOOTSTRAP_CACHE_KEYS } = await import('../shared/bootstrap-tier-keys.js');
    assert.equal(BOOTSTRAP_CACHE_KEYS.gridAlerts, mod.GRID_ALERTS_CANONICAL_KEY);
  });
});
