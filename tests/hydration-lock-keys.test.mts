import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// #6770 — the shared `inFlight` mutex is keyed by ad-hoc job-name strings. A
// logical job must be locked under ONE key across boot-hydration, refresh, and
// layer toggles, or the same work double-runs (or a same-key wrapper around a
// self-guarding loader becomes a guaranteed no-op). These source-structural
// assertions pin the alignment; behavioral scheduling is covered by
// load-all-data-scheduling.test.mts.

const REPO_ROOT = resolve(import.meta.dirname, '..');
const dataLoader = readFileSync(resolve(REPO_ROOT, 'src/app/data-loader.ts'), 'utf8');
const app = readFileSync(resolve(REPO_ROOT, 'src/App.ts'), 'utf8');

describe('hydration lock keys (#6770)', () => {
  it('one-flights firms/radiation hydration with their map-layer toggles', () => {
    // loadDataForLayer locks by the MapLayers key ('fires' / 'radiationWatch');
    // the hydration loaders have no internal guard, so they must lock the SAME
    // key or a hydration/toggle race double-fetches.
    assert.match(dataLoader, /runGuarded\(\s*'fires'/, "firms hydration must lock 'fires' (the layer key)");
    assert.match(dataLoader, /runGuarded\(\s*'radiationWatch'/, "radiation hydration must lock 'radiationWatch'");
    assert.doesNotMatch(dataLoader, /runGuarded\(\s*'firms'/, "'firms' inFlight key diverges from the 'fires' layer key");
    assert.doesNotMatch(dataLoader, /runGuarded\(\s*'radiation'\s*,/, "'radiation' inFlight key diverges from 'radiationWatch'");
    // The firms REFRESH is the third guard-less-loadFirmsData call site; it must
    // lock the same 'fires' key or a hydration/refresh overlap double-fetches.
    const firmsRefreshRegistrations = app
      .split('\n')
      .filter(line => line.includes('fn: () => this.dataLoader.loadFirmsData()'));
    assert.equal(firmsRefreshRegistrations.length, 1, 'loadFirmsData must have exactly one refresh registration');
    const firmsRefreshRegistration = firmsRefreshRegistrations[0];
    assert.match(
      firmsRefreshRegistration,
      /name: 'fires'/,
      "firms refresh must lock 'fires' (matches hydration + layer toggle)",
    );
    assert.doesNotMatch(
      firmsRefreshRegistration,
      /name: 'firms'/,
      "firms refresh must not lock the divergent 'firms' key",
    );
  });

});
