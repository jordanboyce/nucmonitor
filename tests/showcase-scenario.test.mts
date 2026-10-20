import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SHOWCASE_SAMPLE_TAG, SHOWCASE_SCENARIO_ENABLED } from '../src/config/showcase.ts';
import {
  applyShowcaseStatusOverrides,
  buildShowcaseScenario,
  getShowcaseScenario,
} from '../src/services/showcase-scenario.ts';
import { correlateFacilityHazards } from '../src/services/nuclear-facility-hazards.ts';
import { buildSiteRiskSummaries } from '../src/services/nuclear-site-risk.ts';
import { enrichNrcEvents, facilitiesWithRecentEvents } from '../src/services/nrc-event-reports.ts';
import { buildNrcReactorStatusSnapshot, summarizeNrcFleetPower } from '../src/shared/nrc-reactor-status.ts';
import { matchNrcUnitName } from '../src/config/us-nuclear-facilities.ts';

const NOW = new Date('2026-10-20T11:00:00Z');

describe('showcase scenario', () => {
  it('is off unless the build asks for it', () => {
    assert.equal(SHOWCASE_SCENARIO_ENABLED, false);
    assert.equal(getShowcaseScenario(), null);
  });

  it('labels every record as a sample', () => {
    const s = buildShowcaseScenario(NOW);
    for (const q of s.earthquakes) assert.match(q.place, new RegExp(SHOWCASE_SAMPLE_TAG));
    for (const a of s.weatherAlerts) assert.match(a.headline, new RegExp(SHOWCASE_SAMPLE_TAG));
    for (const e of s.naturalEvents) assert.match(e.title, new RegExp(SHOWCASE_SAMPLE_TAG));
    for (const o of s.outages) assert.match(o.title, new RegExp(SHOWCASE_SAMPLE_TAG));
    for (const r of s.radiation.observations) assert.match(r.location, new RegExp(SHOWCASE_SAMPLE_TAG));
    for (const e of s.nrcEvents) {
      assert.match(e.title, new RegExp(SHOWCASE_SAMPLE_TAG));
      assert.match(e.narrative, /did not occur/);
    }
    for (const row of s.nrcStatusOverrides) assert.match(`${row.reason} ${row.change}`, new RegExp(SHOWCASE_SAMPLE_TAG));
  });

  it('is timed relative to now so it always reads as today', () => {
    const s = buildShowcaseScenario(NOW);
    for (const q of s.earthquakes) assert.ok(NOW.getTime() - q.occurredAt < 24 * 3_600_000);
    for (const a of s.weatherAlerts) {
      assert.ok(a.onset.getTime() <= NOW.getTime());
      assert.ok(a.expires.getTime() > NOW.getTime());
    }
    for (const e of s.nrcEvents) assert.equal(e.notificationDate, '2026-10-20');
    assert.ok(s.nrcStatusOverrides.every((r) => r.reportDate === '2026-10-20'));
  });

  it('flags the three story sites and leaves the quiet one alone', () => {
    const s = buildShowcaseScenario(NOW);
    const reports = correlateFacilityHazards({ ...s, radiation: s.radiation.observations, now: NOW });
    const byId = new Map(buildSiteRiskSummaries(reports).map((r) => [r.facility.id, r]));

    assert.equal(byId.get('waterford')?.status, 'warning');
    assert.equal(byId.get('diablo-canyon')?.status, 'warning');
    assert.equal(byId.get('los-alamos')?.status, 'warning');
    assert.equal(byId.get('river-bend')?.status, 'warning');
    assert.equal(byId.get('south-texas')?.status, 'watch');
    assert.equal(byId.get('columbia')?.status ?? 'normal', 'normal');

    const waterfordKinds = new Set(byId.get('waterford')!.signals.map((x) => x.kind));
    assert.ok(waterfordKinds.has('storm'), 'hurricane track reaches Waterford');
    assert.ok(waterfordKinds.has('outage'), 'telecom outage near Waterford');
    assert.ok(byId.get('los-alamos')!.signals.some((x) => x.kind === 'fire'));
    assert.ok(byId.get('diablo-canyon')!.signals.some((x) => x.kind === 'earthquake'));
  });

  it('resolves the sample NRC events to registry sites', () => {
    const s = buildShowcaseScenario(NOW);
    const enriched = enrichNrcEvents(s.nrcEvents);
    const ids = enriched.map((e) => e.facilityMatch?.id);
    assert.deepEqual(new Set(ids), new Set(['waterford', 'diablo-canyon']));
    assert.deepEqual([...facilitiesWithRecentEvents(enriched, NOW)].sort(), ['diablo-canyon', 'waterford']);
    // Placeholder numbers sort below any real NRC event number.
    assert.ok(s.nrcEvents.every((e) => Number(e.eventNumber) < 1000));
  });

  it('lays the status overrides over a live file and provides a complete fallback', () => {
    const s = buildShowcaseScenario(NOW);
    const live = [
      { reportDate: '2026-10-19', unit: 'Waterford 3', power: 100, reason: '', change: '' },
      { reportDate: '2026-10-20', unit: 'Waterford 3', power: 100, reason: '', change: '' },
      { reportDate: '2026-10-20', unit: 'Vogtle 3', power: 100, reason: '', change: '' },
    ];
    const merged = applyShowcaseStatusOverrides(live, s);
    assert.equal(merged.find((r) => r.reportDate === '2026-10-20' && r.unit === 'Waterford 3')?.power, 0);
    assert.equal(merged.find((r) => r.reportDate === '2026-10-19' && r.unit === 'Waterford 3')?.power, 100);
    assert.equal(merged.find((r) => r.unit === 'Vogtle 3')?.power, 100);

    const fallback = applyShowcaseStatusOverrides([], s);
    const snapshot = buildNrcReactorStatusSnapshot(fallback);
    assert.ok(snapshot);
    assert.equal(snapshot!.reportDate, '2026-10-20');
    assert.ok(snapshot!.units.length >= 90, `expected the full fleet, got ${snapshot!.units.length}`);
    const summary = summarizeNrcFleetPower(snapshot!);
    assert.equal(summary.offline, 1);
    assert.ok(summary.reducedPower >= 1);
    for (const row of snapshot!.units) assert.ok(matchNrcUnitName(row.unit), `unmatched sample unit ${row.unit}`);
  });
});
