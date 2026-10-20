import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { correlateFacilityHazards, type FacilityHazardSignal } from '../src/services/nuclear-facility-hazards.ts';
import {
  buildSiteRiskCsv,
  buildSiteRiskSummaries,
  classifySiteRisk,
  groupReactorPowerByFacility,
  INGESTION_EPZ_KM,
  KM_PER_MILE,
  PLUME_EPZ_KM,
  summarizeSiteRisk,
  zoneForDistanceKm,
  type SiteRiskSignal,
} from '../src/services/nuclear-site-risk.ts';
import { buildSiteBriefDocument } from '../src/services/nuclear-site-brief.ts';
import { parseWatchlist } from '../src/services/nuclear-watchlist.ts';
import { getUsNuclearFacility, US_NUCLEAR_FACILITIES } from '../src/config/us-nuclear-facilities.ts';
import type { Earthquake } from '../src/services/earthquakes.ts';
import type { InternetOutage } from '../src/types/index.ts';

const NOW = new Date('2026-10-17T12:00:00Z');
const northAnna = getUsNuclearFacility('north-anna')!;

/** A point `km` due north of a facility. */
function north(lat: number, lon: number, km: number): { lat: number; lon: number } {
  return { lat: lat + km / 111.195, lon };
}

function quakeNear(km: number, magnitude: number): Earthquake {
  const p = north(northAnna.lat, northAnna.lon, km);
  return {
    id: `q-${km}-${magnitude}`,
    place: 'Louisa County, VA',
    magnitude,
    depthKm: 6,
    location: { latitude: p.lat, longitude: p.lon },
    occurredAt: NOW.getTime() - 3_600_000,
    sourceUrl: 'https://earthquake.usgs.gov/',
    source: 'usgs',
    category: 'earthquake',
  } as Earthquake;
}

function signal(zone: SiteRiskSignal['zone'], severity: FacilityHazardSignal['severity'], kind: FacilityHazardSignal['kind'] = 'weather'): SiteRiskSignal {
  const distanceKm = zone === 'plume' ? 5 : zone === 'ingestion' ? 50 : 150;
  return { kind, severity, summary: 's', distanceKm, distanceMi: distanceKm / KM_PER_MILE, source: 'test', zone };
}

describe('EPZ zones', () => {
  it('uses 10 and 50 statute miles', () => {
    assert.equal(Math.round(PLUME_EPZ_KM * 10) / 10, 16.1);
    assert.equal(Math.round(INGESTION_EPZ_KM * 10) / 10, 80.5);
    assert.equal(zoneForDistanceKm(0), 'plume');
    assert.equal(zoneForDistanceKm(16), 'plume');
    assert.equal(zoneForDistanceKm(17), 'ingestion');
    assert.equal(zoneForDistanceKm(80), 'ingestion');
    assert.equal(zoneForDistanceKm(81), 'regional');
  });
});

describe('classifySiteRisk rules', () => {
  it('is normal with no signals or only low-level ones', () => {
    assert.deepEqual(classifySiteRisk([]), { status: 'normal', reasons: [] });
    assert.equal(classifySiteRisk([signal('plume', 'watch'), signal('regional', 'high')]).status, 'normal');
  });

  it('warns on a high signal inside the plume EPZ', () => {
    const r = classifySiteRisk([signal('plume', 'high')]);
    assert.equal(r.status, 'warning');
    assert.match(r.reasons[0]!, /10-mile EPZ/);
  });

  it('warns on a critical signal inside the ingestion EPZ but only watches a high one', () => {
    assert.equal(classifySiteRisk([signal('ingestion', 'critical')]).status, 'warning');
    assert.equal(classifySiteRisk([signal('ingestion', 'high')]).status, 'watch');
  });

  it('warns on high radiation anywhere inside 50 miles', () => {
    const r = classifySiteRisk([signal('ingestion', 'high', 'radiation')]);
    assert.equal(r.status, 'warning');
    assert.ok(r.reasons.some((x) => /radiation/.test(x)));
  });

  it('watches elevated signals inside 50 miles and critical ones regionally', () => {
    assert.equal(classifySiteRisk([signal('ingestion', 'elevated')]).status, 'watch');
    assert.equal(classifySiteRisk([signal('regional', 'critical')]).status, 'watch');
  });

  it('watches three or more low-level signals inside the plume EPZ', () => {
    assert.equal(classifySiteRisk([signal('plume', 'watch'), signal('plume', 'watch')]).status, 'normal');
    const r = classifySiteRisk([signal('plume', 'watch'), signal('plume', 'watch'), signal('plume', 'watch')]);
    assert.equal(r.status, 'watch');
    assert.match(r.reasons[0]!, /3 signals/);
  });
});

describe('buildSiteRiskSummaries', () => {
  it('covers every facility and ranks flagged sites first', () => {
    const reports = correlateFacilityHazards({ earthquakes: [quakeNear(10, 5.2)], now: NOW });
    const summaries = buildSiteRiskSummaries(reports);
    assert.equal(summaries.length, US_NUCLEAR_FACILITIES.length);
    const na = summaries.find((s) => s.facility.id === 'north-anna')!;
    assert.equal(na.status, 'warning');
    assert.equal(na.plume.total, 1);
    assert.equal(na.plume.byKind.earthquake, 1);
    assert.ok(na.nearestMi! > 5 && na.nearestMi! < 7);
    assert.equal(summaries[0]!.status, 'warning');
    const totals = summarizeSiteRisk(summaries);
    assert.equal(totals.warning + totals.watch + totals.normal, summaries.length);
    assert.ok(totals.withSignals >= 1);
  });

  it('treats a moderate quake 40 miles out as a watch, not a warning', () => {
    const summaries = buildSiteRiskSummaries(correlateFacilityHazards({ earthquakes: [quakeNear(65, 4.2)], now: NOW }));
    const na = summaries.find((s) => s.facility.id === 'north-anna')!;
    assert.equal(na.ingestion.total, 1);
    assert.equal(na.status, 'watch');
  });
});

describe('outage signals', () => {
  it('flags an active total outage inside 50 miles and ignores ended ones', () => {
    const p = north(northAnna.lat, northAnna.lon, 30);
    const base: InternetOutage = {
      id: 'o1', title: 'Regional outage', link: 'https://radar.cloudflare.com/', description: '',
      pubDate: NOW, country: 'United States', region: 'Virginia', lat: p.lat, lon: p.lon,
      severity: 'total', categories: [],
    };
    const ended = { ...base, id: 'o2', endDate: new Date(NOW.getTime() - 60_000) };
    const reports = correlateFacilityHazards({ outages: [base, ended], now: NOW });
    const na = reports.find((r) => r.facility.id === 'north-anna')!;
    assert.equal(na.signals.length, 1);
    assert.equal(na.signals[0]!.kind, 'outage');
    assert.equal(na.signals[0]!.severity, 'high');
  });
});

describe('exports', () => {
  it('writes one CSV row per facility and neutralises formula injection', () => {
    const summaries = buildSiteRiskSummaries(correlateFacilityHazards({ earthquakes: [quakeNear(10, 5.2)], now: NOW }));
    const evil = { ...summaries[0]!, facility: { ...summaries[0]!.facility, name: '=HYPERLINK("x")' } };
    const csv = buildSiteRiskCsv([evil, ...summaries.slice(1)], { generatedAt: NOW });
    const lines = csv.split('\n');
    assert.equal(lines.length, 3 + summaries.length);
    assert.match(lines[2]!, /"Hazard status"/);
    assert.ok(lines[3]!.startsWith(`"'=HYPERLINK(""x"")"`));
  });

  it('joins NRC power to registry units in the brief and escapes HTML', () => {
    const reports = correlateFacilityHazards({ earthquakes: [quakeNear(10, 5.2)], now: NOW });
    const na = buildSiteRiskSummaries(reports).find((s) => s.facility.id === 'north-anna')!;
    const unitName = na.facility.units![0]!.name;
    const power = groupReactorPowerByFacility({
      reportDate: '10/16/2026',
      units: [{ unit: 'North Anna 1', power: 87, facility: { id: 'north-anna' }, unitRecord: { name: unitName } }],
    });
    const html = buildSiteBriefDocument(
      { ...na, reasons: ['<script>alert(1)</script>'] },
      { power: power.get('north-anna'), generatedAt: NOW },
    );
    assert.ok(html.startsWith('<!doctype html>'));
    assert.match(html, /87%/);
    assert.match(html, /status-warning/);
    assert.ok(!html.includes('<script>alert(1)'));
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('watchlist parsing', () => {
  it('keeps only known registry ids', () => {
    assert.deepEqual([...parseWatchlist('["north-anna","nope",3]')], ['north-anna']);
    assert.equal(parseWatchlist('not json').size, 0);
    assert.equal(parseWatchlist(null).size, 0);
  });
});
