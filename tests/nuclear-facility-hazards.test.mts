import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  correlateFacilityHazards,
  haversineKm,
  pointInPolygon,
  summarizeFacilityHazards,
} from '../src/services/nuclear-facility-hazards.ts';
import { getUsNuclearFacility } from '../src/config/us-nuclear-facilities.ts';
import type { Earthquake } from '../src/services/earthquakes.ts';
import type { WeatherAlert } from '../src/services/weather.ts';

const NOW = new Date('2026-10-17T12:00:00Z');
const northAnna = getUsNuclearFacility('north-anna')!;
const diablo = getUsNuclearFacility('diablo-canyon')!;

function quake(lat: number, lon: number, magnitude: number, hoursAgo = 1): Earthquake {
  return {
    id: `q-${lat}-${lon}`,
    place: 'test',
    magnitude,
    depthKm: 5,
    location: { latitude: lat, longitude: lon },
    occurredAt: NOW.getTime() - hoursAgo * 3_600_000,
    sourceUrl: 'https://earthquake.usgs.gov/',
    source: 'usgs',
    category: 'earthquake',
  };
}

function alert(event: string, severity: WeatherAlert['severity'], ring: [number, number][], centroid?: [number, number]): WeatherAlert {
  return {
    id: event,
    event,
    severity,
    headline: event,
    description: '',
    areaDesc: 'Louisa County',
    onset: NOW,
    expires: new Date(NOW.getTime() + 3_600_000),
    coordinates: ring,
    centroid,
    countryCode: 'US',
    geometryPrecision: ring.length ? 'polygon' : 'point',
  };
}

describe('nuclear facility hazards', () => {
  it('measures distance and polygon containment', () => {
    assert.ok(Math.abs(haversineKm(38.061, -77.790, 38.061, -77.790)) < 0.001);
    const d = haversineKm(38.061, -77.790, 38.5, -77.790);
    assert.ok(d > 48 && d < 50, `expected ~48.8 km, got ${d}`);
    const ring: [number, number][] = [[-78, 38], [-77, 38], [-77, 39], [-78, 39]];
    assert.equal(pointInPolygon(38.5, -77.5, ring), true);
    assert.equal(pointInPolygon(40, -77.5, ring), false);
  });

  it('flags a strong nearby earthquake as critical and ignores distant or stale ones', () => {
    const reports = correlateFacilityHazards({
      earthquakes: [
        quake(northAnna.lat + 0.15, northAnna.lon, 5.8),          // ~17 km, M5.8 (the 2011 Mineral event)
        quake(diablo.lat + 3, diablo.lon, 3.1),                    // ~330 km from Diablo: outside radius
        quake(northAnna.lat + 0.1, northAnna.lon, 4.0, 200),      // 200 h old: outside window
      ],
      now: NOW,
    });
    const na = reports.find((r) => r.facility.id === 'north-anna');
    assert.ok(na, 'North Anna should be flagged');
    assert.equal(na.severity, 'critical');
    assert.equal(na.signals.length, 1);
    assert.equal(na.signals[0]!.kind, 'earthquake');
    assert.ok(!reports.some((r) => r.facility.id === 'diablo-canyon'));
    assert.equal(reports[0]!.facility.id, 'north-anna', 'operating reactor ranks first');
  });

  it('matches weather alerts by polygon and by centroid fallback', () => {
    const ring: [number, number][] = [
      [northAnna.lon - 0.3, northAnna.lat - 0.3],
      [northAnna.lon + 0.3, northAnna.lat - 0.3],
      [northAnna.lon + 0.3, northAnna.lat + 0.3],
      [northAnna.lon - 0.3, northAnna.lat + 0.3],
    ];
    const reports = correlateFacilityHazards({
      weatherAlerts: [
        alert('Tornado Warning', 'Extreme', ring),
        alert('Flood Watch', 'Moderate', [], [diablo.lat + 0.2, diablo.lon]),
        alert('Heat Advisory', 'Minor', [], [60, -150]),
      ],
      now: NOW,
    });
    const na = reports.find((r) => r.facility.id === 'north-anna');
    assert.equal(na?.severity, 'critical');
    assert.equal(na?.signals[0]?.distanceKm, 0);
    const dc = reports.find((r) => r.facility.id === 'diablo-canyon');
    assert.equal(dc?.severity, 'elevated');
    assert.equal(dc?.signals[0]?.kind, 'flood');
    assert.ok(dc!.signals[0]!.distanceKm > 20 && dc!.signals[0]!.distanceKm < 25);
  });

  it('aggregates fire detections and honours category and radius options', () => {
    const fires = Array.from({ length: 6 }, (_, i) => ({
      lat: diablo.lat + 0.01 * i,
      lon: diablo.lon + 0.02,
      brightness: 340,
      frp: 60,
      confidence: 80,
      region: 'us',
      acq_date: '2026-10-17',
      daynight: 'D',
    }));
    const reports = correlateFacilityHazards({ fires, now: NOW });
    const dc = reports.find((r) => r.facility.id === 'diablo-canyon');
    assert.ok(dc);
    assert.equal(dc.signals.length, 1, 'fires collapse into one signal per facility');
    assert.equal(dc.signals[0]!.kind, 'fire');
    assert.equal(dc.severity, 'critical');

    const none = correlateFacilityHazards({ fires, now: NOW }, { categories: ['doe-site'] });
    assert.ok(!none.some((r) => r.facility.id === 'diablo-canyon'));

    const tight = correlateFacilityHazards({ fires, now: NOW }, { fireRadiusKm: 1 });
    assert.ok(!tight.some((r) => r.facility.id === 'diablo-canyon'));
  });

  it('summarizes totals by severity and kind', () => {
    const reports = correlateFacilityHazards({
      earthquakes: [quake(northAnna.lat + 0.2, northAnna.lon, 3.0)],
      now: NOW,
    });
    const totals = summarizeFacilityHazards(reports);
    assert.equal(totals.facilitiesWithSignals, reports.length);
    assert.equal(totals.byKind.earthquake, reports.reduce((n, r) => n + r.signals.length, 0));
    assert.equal(totals.critical + totals.high + totals.elevated + totals.watch, reports.length);
  });

  it('returns nothing when no feeds are provided', () => {
    assert.deepEqual(correlateFacilityHazards({ now: NOW }), []);
  });
});
