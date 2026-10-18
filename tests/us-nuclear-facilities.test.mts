import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  getNrcRegion,
  getOperatingPowerReactorSites,
  matchNrcUnitName,
  normalizeReactorName,
  stripUnitSuffix,
  summarizeUsNuclearFleet,
  US_NUCLEAR_FACILITIES,
  US_NUCLEAR_CATEGORY_LABELS,
  US_NUCLEAR_STATUS_LABELS,
} from '../src/config/us-nuclear-facilities.ts';

const CONUS = { minLat: 24.3, maxLat: 49.5, minLon: -125.0, maxLon: -66.5 };
const PR = { minLat: 17.8, maxLat: 18.6, minLon: -67.5, maxLon: -65.2 };

describe('us nuclear facility registry', () => {
  it('has unique ids and complete, in-bounds records', () => {
    const ids = new Set<string>();
    for (const f of US_NUCLEAR_FACILITIES) {
      assert.ok(!ids.has(f.id), `duplicate id ${f.id}`);
      ids.add(f.id);
      assert.match(f.id, /^[a-z0-9-]+$/, `${f.id} must be a slug`);
      assert.ok(f.name.length > 3, `${f.id} needs a name`);
      assert.ok(f.operator.length > 2, `${f.id} needs an operator`);
      assert.ok(f.category in US_NUCLEAR_CATEGORY_LABELS, `${f.id} unknown category ${f.category}`);
      assert.ok(f.status in US_NUCLEAR_STATUS_LABELS, `${f.id} unknown status ${f.status}`);
      assert.ok(getNrcRegion(f.state), `${f.id} state ${f.state} has no NRC region`);
      const box = f.state === 'PR' ? PR : CONUS;
      assert.ok(f.lat >= box.minLat && f.lat <= box.maxLat, `${f.id} latitude ${f.lat} out of bounds`);
      assert.ok(f.lon >= box.minLon && f.lon <= box.maxLon, `${f.id} longitude ${f.lon} out of bounds`);
      for (const u of f.units ?? []) {
        if (u.docket) assert.match(u.docket, /^0[57][02]\d{5}$/, `${f.id} ${u.name} docket ${u.docket} malformed`);
      }
      if (f.docket) assert.match(f.docket, /^0[4-7]\d{6}$/, `${f.id} docket ${f.docket} malformed`);
    }
  });

  it('power reactor unit dockets are unique across the fleet', () => {
    const dockets = new Map<string, string>();
    for (const f of US_NUCLEAR_FACILITIES) {
      for (const u of f.units ?? []) {
        if (!u.docket) continue;
        assert.ok(!dockets.has(u.docket), `docket ${u.docket} shared by ${dockets.get(u.docket)} and ${f.id}`);
        dockets.set(u.docket, f.id);
      }
    }
  });

  it('tracks the operating US fleet at its documented size', () => {
    const summary = summarizeUsNuclearFleet();
    // 54 operating sites + Palisades restart; 94 operating units including
    // Vogtle 3-4 (NRC operating reactor list). The bands leave room for
    // registry edits without silently dropping a plant.
    assert.ok(summary.operatingSites >= 52 && summary.operatingSites <= 56, `operating sites ${summary.operatingSites}`);
    assert.ok(summary.operatingUnits >= 92 && summary.operatingUnits <= 96, `operating units ${summary.operatingUnits}`);
    assert.ok(summary.netMwe > 90_000 && summary.netMwe < 105_000, `net MWe ${summary.netMwe}`);
    assert.equal(summary.pwrUnits + summary.bwrUnits, summary.operatingUnits);
    assert.ok(summary.restartingUnits >= 1);
    assert.ok(summary.researchReactors >= 25);
    assert.ok(summary.doeSites >= 15);
    assert.ok(summary.fuelCycleFacilities >= 8);
    assert.equal(
      summary.unitsByRegion[1] + summary.unitsByRegion[2] + summary.unitsByRegion[3] + summary.unitsByRegion[4],
      summary.operatingUnits,
    );
    assert.ok(getOperatingPowerReactorSites().length >= summary.operatingSites);
  });

  it('every operating power reactor site has at least one status alias', () => {
    for (const f of US_NUCLEAR_FACILITIES) {
      if (f.category !== 'power-reactor' && f.category !== 'restart') continue;
      assert.ok((f.statusAliases ?? []).length > 0, `${f.id} needs statusAliases for NRC matching`);
    }
  });

  it('normalizes and matches NRC unit labels', () => {
    assert.equal(normalizeReactorName("Saint Lucie 1"), 'saint lucie 1');
    assert.equal(normalizeReactorName("R.E. Ginna"), 're ginna');
    assert.deepEqual(stripUnitSuffix('browns ferry 3'), { base: 'browns ferry', unit: '3' });
    assert.deepEqual(stripUnitSuffix('columbia generating station'), { base: 'columbia generating station', unit: undefined });

    const bf3 = matchNrcUnitName('Browns Ferry 3');
    assert.equal(bf3?.facility.id, 'browns-ferry');
    assert.equal(bf3?.unit?.docket, '05000296');

    assert.equal(matchNrcUnitName('Saint Lucie 2')?.facility.id, 'st-lucie');
    assert.equal(matchNrcUnitName('St. Lucie 2')?.facility.id, 'st-lucie');
    assert.equal(matchNrcUnitName('Columbia Generating Station')?.facility.id, 'columbia');
    assert.equal(matchNrcUnitName('Nine Mile Point 2')?.unit?.docket, '05000410');
    assert.equal(matchNrcUnitName('Arkansas Nuclear 1')?.facility.id, 'arkansas-nuclear-one');
    assert.equal(matchNrcUnitName('Cook 1')?.facility.id, 'dc-cook');
    assert.equal(matchNrcUnitName('Summer')?.facility.id, 'vc-summer');
    assert.equal(matchNrcUnitName('Vogtle 4')?.unit?.type, 'AP1000');
    assert.equal(matchNrcUnitName('Palisades')?.facility.category, 'power-reactor');
    assert.equal(matchNrcUnitName('Palisades')?.unit?.status, 'restarting');
    assert.equal(matchNrcUnitName('Zaporizhzhia 1'), undefined);
  });
});
