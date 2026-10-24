// @ts-check
// Fixture-driven parser tests for the grid-alerts source adapters. Every
// adapter is exercised through its public fetch function with an injected
// `deps` object, so the tests prove the normalization each upstream shape
// receives without touching the providers.
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAISO_DEMAND_URL, CAISO_STATS_URL, ERCOT_OUTLOOK_URL, ERCOT_PRC_URL, GRID_HAZARD_EVENTS, MISO_LOAD_URL,
  SPP_CONDITIONS_URL, SWPC_ALERTS_URL, SWPC_KP_URL, SWPC_SCALES_URL,
  alertStates, buildEia930Url, buildNwsAlertsUrl, classifyOperatorStatus, fetchCaiso, fetchEia930, fetchErcot, fetchMiso,
  fetchNwsAlerts, fetchNyiso, fetchSpp, fetchSwpc, geometryCentroid, normalizeEia930, normalizeSppConditions, nyisoDateStamp, parseCsv,
} from '../scripts/lib/grid-alerts/adapters.mjs';
import { GRID_REGIONS, regionsForState, regionsForStates } from '../scripts/lib/grid-alerts/regions.mjs';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/grid-alerts');
const read = (name) => readFileSync(resolve(FIXTURES, name), 'utf8');
const json = (name) => JSON.parse(read(name));
const NOW = Date.parse('2026-10-20T21:00:00Z');

/** Deps that answer from fixtures keyed by URL prefix and record every request. */
function fixtureDeps(routes) {
  const requests = [];
  const lookup = (url) => {
    requests.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`no fixture for ${url}`);
    const value = hit[1];
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(url) : value;
  };
  return {
    requests,
    fetchJson: async (url) => { const v = lookup(url); return typeof v === 'string' ? JSON.parse(v) : v; },
    fetchText: async (url) => { const v = lookup(url); return typeof v === 'string' ? v : JSON.stringify(v); },
    now: () => NOW,
  };
}

describe('grid-alerts region registry', () => {
  test('ids are unique EIA respondent codes with footprints and centroids', () => {
    const ids = new Set();
    for (const r of GRID_REGIONS) {
      assert.match(r.id, /^[A-Z]{2,4}$/);
      assert.ok(!ids.has(r.id), `duplicate ${r.id}`);
      ids.add(r.id);
      assert.ok(r.states.length > 0);
      assert.equal(r.centroid.length, 2);
      assert.ok(r.centroid[1] > 20 && r.centroid[1] < 55, `${r.id} latitude`);
      assert.ok(['iso', 'ba'].includes(r.kind));
    }
    assert.ok(GRID_REGIONS.length >= 30);
  });
  test('state lookup is case-insensitive and de-duplicated', () => {
    assert.deepEqual(regionsForState('tx').map((r) => r.id).slice(0, 2), ['MISO', 'ERCO']);
    const both = regionsForStates(['NC', 'nc', 'SC']);
    assert.ok(both.some((r) => r.id === 'DUK'));
    assert.equal(new Set(both.map((r) => r.id)).size, both.length);
    assert.deepEqual(regionsForStates(['', 'XYZ']), []);
  });
});

describe('operator status classification', () => {
  test('maps ISO vocabulary onto the shared ladder', () => {
    assert.equal(classifyOperatorStatus('Normal Conditions'), 'normal');
    assert.equal(classifyOperatorStatus('Energy Emergency Alert 2'), 'eea2');
    assert.equal(classifyOperatorStatus('EEA Level 3'), 'eea3');
    assert.equal(classifyOperatorStatus('Conservative Operations Advisory'), 'conservative');
    assert.equal(classifyOperatorStatus('Flex Alert'), 'conservative');
    assert.equal(classifyOperatorStatus('Weather Watch'), 'watch');
    assert.equal(classifyOperatorStatus('Resource Advisory'), 'advisory');
    assert.equal(classifyOperatorStatus(''), 'unknown');
  });
});

describe('ERCOT adapter', () => {
  test('parses EEA state, PRC with thousands separators, and outlook demand/capacity', async () => {
    const deps = fixtureDeps({ [ERCOT_PRC_URL]: read('ercot-daily-prc.json'), [ERCOT_OUTLOOK_URL]: read('ercot-todays-outlook.json') });
    const r = await fetchErcot(deps);
    assert.equal(r.source.ok, true);
    assert.equal(r.operator.regionId, 'ERCO');
    assert.equal(r.operator.level, 'eea1');
    assert.equal(r.operator.prcMw, 2250);
    assert.equal(r.operator.outlook.demandMw, 68200);
    assert.equal(r.operator.outlook.capacityMw, 70100);
    assert.equal(r.operator.outlook.peakForecastMw, 69800);
    assert.equal(r.operator.updatedAt, '2026-10-20T20:55:12.000Z');
  });
  test('outlook failure degrades to status-only rather than failing the source', async () => {
    const deps = fixtureDeps({ [ERCOT_PRC_URL]: read('ercot-daily-prc.json'), [ERCOT_OUTLOOK_URL]: new Error('HTTP 503') });
    const r = await fetchErcot(deps);
    assert.equal(r.source.ok, true);
    assert.equal(r.operator.outlook, null);
  });
  test('missing current_condition is a source failure with a reason', async () => {
    const r = await fetchErcot(fixtureDeps({ [ERCOT_PRC_URL]: '{"foo":1}' }));
    assert.equal(r.source.ok, false);
    assert.match(r.source.error, /current_condition/);
    assert.equal(r.operator, undefined);
  });
});

describe('CAISO adapter', () => {
  test('parses flex alert status, reserve and demand.csv peaks', async () => {
    const deps = fixtureDeps({ [CAISO_STATS_URL]: read('caiso-stats.json'), [CAISO_DEMAND_URL]: read('caiso-demand.csv') });
    const r = await fetchCaiso(deps);
    assert.equal(r.source.ok, true);
    assert.equal(r.operator.level, 'conservative');
    assert.equal(r.operator.flexAlert, true);
    assert.equal(r.operator.reservePct, 4.8);
    assert.equal(r.operator.outlook.demandMw, 34390);
    assert.equal(r.operator.outlook.peakForecastMw, 34900);
  });
});

describe('MISO and NYISO load adapters', () => {
  test('MISO five-minute load and medium-term forecast peak', async () => {
    const r = await fetchMiso(fixtureDeps({ [MISO_LOAD_URL]: read('miso-load.json') }));
    assert.equal(r.source.ok, true);
    assert.equal(r.operator.regionId, 'MISO');
    assert.equal(r.operator.level, 'unknown');
    assert.equal(r.operator.noStatusFeed, true);
    assert.equal(r.operator.outlook.demandMw, 88410.2);
    assert.equal(r.operator.outlook.peakForecastMw, 89000);
  });
  test('NYISO sums zonal load for the latest stamp and reads the NYISO forecast column', async () => {
    const stamp = nyisoDateStamp(NOW);
    assert.equal(stamp, '20261020');
    const deps = fixtureDeps({ [`https://mis.nyiso.com/public/csv/pal/${stamp}pal.csv`]: read('nyiso-pal.csv'), [`https://mis.nyiso.com/public/csv/isolf/${stamp}isolf.csv`]: read('nyiso-isolf.csv') });
    const r = await fetchNyiso(deps);
    assert.equal(r.source.ok, true);
    assert.equal(r.operator.outlook.demandMw, 7760);
    assert.equal(r.operator.outlook.peakForecastMw, 18350);
  });
  test('NYISO date stamp follows Eastern time across the UTC midnight boundary', () => {
    assert.equal(nyisoDateStamp(Date.parse('2026-10-21T02:30:00Z')), '20261020');
    assert.equal(nyisoDateStamp(Date.parse('2026-10-21T05:30:00Z')), '20261021');
  });
});

describe('SPP adapter', () => {
  test('reads the condition from page text, ignoring script bodies', async () => {
    const r = await fetchSpp(fixtureDeps({ [SPP_CONDITIONS_URL]: read('spp-conditions.html') }));
    assert.equal(r.source.ok, true);
    assert.equal(r.operator.level, 'conservative');
    assert.equal(r.operator.statusText, 'Conservative Operations Advisory');
  });
  test('recognizes EEA levels and normal operations', () => {
    assert.equal(normalizeSppConditions('<p>SPP declared an Energy Emergency Alert Level 3</p>').level, 'eea3');
    assert.equal(normalizeSppConditions('<p>The entire SPP footprint is under normal grid conditions.</p>').level, 'normal');
    assert.throws(() => normalizeSppConditions('<p>unrelated</p>'), /no recognizable status/);
  });
});

describe('NWS adapter', () => {
  test('keeps only grid-relevant, unexpired events and maps UGC states to regions', async () => {
    const r = await fetchNwsAlerts(fixtureDeps({ 'https://api.weather.gov/alerts/active': read('nws-alerts.json') }));
    assert.equal(r.source.ok, true);
    assert.equal(r.weatherAlertTotal, 2, 'small craft and expired alerts drop');
    const [ice, heat] = r.weatherAlerts;
    assert.equal(ice.event, 'Ice Storm Warning');
    assert.deepEqual(ice.states, ['TX']);
    assert.ok(ice.regionIds.includes('ERCO') && ice.regionIds.includes('MISO'));
    assert.equal(ice.weight, 32, 'Severe scales the 40-point base by 0.8');
    assert.deepEqual(ice.centroid, [-96.5, 32.5]);
    assert.equal(ice.category, 'winter');
    assert.equal(heat.event, 'Heat Advisory');
    assert.ok(heat.regionIds.includes('AZPS') && heat.regionIds.includes('SRP'));
    assert.equal(heat.centroid, null);
  });
  test('the request URL filters by every grid hazard event name', () => {
    const url = new URL(buildNwsAlertsUrl());
    assert.equal(url.searchParams.get('status'), 'actual');
    for (const name of Object.keys(GRID_HAZARD_EVENTS)) assert.ok(url.searchParams.get('event').includes(name));
  });
  test('state extraction falls back to areaDesc suffixes when UGC is absent', () => {
    assert.deepEqual(alertStates({ areaDesc: 'Maricopa, AZ; Clark, NV' }), ['AZ', 'NV']);
    assert.deepEqual(alertStates({ geocode: { UGC: ['FLC086', 'GAZ001', 'bogus'] } }), ['FL', 'GA']);
  });
  test('geometry centroids handle Point, Polygon and MultiPolygon', () => {
    assert.deepEqual(geometryCentroid({ type: 'Point', coordinates: [-80, 25] }), [-80, 25]);
    assert.deepEqual(geometryCentroid({ type: 'MultiPolygon', coordinates: [[[[0, 0], [2, 0], [2, 2], [0, 2]]], [[[10, 10], [12, 10], [12, 12], [10, 12]]]] }), [6, 6]);
    assert.equal(geometryCentroid(null), null);
  });
});

describe('SWPC adapter', () => {
  test('parses NOAA scales, latest Kp and recent geomagnetic products', async () => {
    const r = await fetchSwpc(fixtureDeps({ [SWPC_SCALES_URL]: read('swpc-scales.json'), [SWPC_KP_URL]: read('swpc-kp.json'), [SWPC_ALERTS_URL]: read('swpc-alerts.json') }));
    assert.equal(r.source.ok, true);
    assert.equal(r.space.current.g, 3);
    assert.equal(r.space.current.gText, 'strong');
    assert.deepEqual(r.space.forecast.map((d) => d.g), [4, 1, 0]);
    assert.equal(r.space.kp, 6.67);
    assert.equal(r.space.kpAt, '2026-10-20T18:00:00.000Z');
    assert.deepEqual(r.space.alerts.map((a) => a.gLevel), [4, 3], 'radio burst and 9-month-old watch are dropped');
    assert.match(r.space.alerts[0].title, /G4/);
  });
  test('Kp and alert feeds are optional', async () => {
    const r = await fetchSwpc(fixtureDeps({ [SWPC_SCALES_URL]: read('swpc-scales.json'), [SWPC_KP_URL]: new Error('HTTP 500'), [SWPC_ALERTS_URL]: new Error('HTTP 500') }));
    assert.equal(r.source.ok, true);
    assert.equal(r.space.kp, null);
    assert.deepEqual(r.space.alerts, []);
  });
});

describe('EIA-930 adapter', () => {
  test('requires a key and reports it as a source failure, not a throw', async () => {
    const r = await fetchEia930(fixtureDeps({}), { apiKey: '' });
    assert.equal(r.source.ok, false);
    assert.match(r.source.error, /EIA_API_KEY/);
  });
  test('joins demand, forecast, generation and interchange per respondent', async () => {
    const routes = (url) => {
      const type = new URL(url).searchParams.get('facets[type][]');
      return read(`eia-930-${type}.json`);
    };
    const deps = fixtureDeps({ 'https://api.eia.gov/v2/electricity/rto/region-data/data/': routes });
    const r = await fetchEia930(deps, { apiKey: 'k' });
    assert.equal(r.source.ok, true);
    assert.equal(deps.requests.length, 4);
    const pjm = r.eia.get('PJM');
    assert.equal(pjm.demandMw, 101500);
    assert.equal(pjm.forecastMw, 92000, 'forecast for the latest actual hour');
    assert.equal(pjm.peakForecastMw, 104000);
    assert.equal(pjm.netGenerationMw, 99000);
    assert.equal(pjm.interchangeMw, -2500);
    const erco = r.eia.get('ERCO');
    assert.deepEqual(erco.demandHistory, [['2026-10-20T19', 67900], ['2026-10-20T20', 68200]]);
    assert.ok(r.eia.has('ZZZ'), 'unknown respondents are kept in the map and ignored by assessment');
  });
  test('URL carries every registry respondent, the key, and a bounded window', () => {
    const url = new URL(buildEia930Url('D', '2026-10-20T12', '2026-10-20T22', 'secret'));
    assert.equal(url.searchParams.getAll('facets[respondent][]').length, GRID_REGIONS.length);
    assert.equal(url.searchParams.get('api_key'), 'secret');
    assert.equal(url.searchParams.get('length'), '5000');
  });
  test('normalizeEia930 tolerates string and numeric values and skips blanks', () => {
    const m = normalizeEia930({ D: [{ period: '2026-10-20T20', respondent: 'TVA', value: 20000 }, { period: '2026-10-20T19', respondent: 'TVA', value: '' }] }, NOW);
    assert.equal(m.get('TVA').demandMw, 20000);
    assert.equal(m.get('TVA').demandHistory.length, 1);
  });
});

describe('csv parser', () => {
  test('handles quoted fields with embedded commas and blank lines', () => {
    assert.deepEqual(parseCsv('a,"b,c",d\n\n1,"2 ""x""",3\n'), [['a', 'b,c', 'd'], ['1', '2 "x"', '3']]);
  });
});
