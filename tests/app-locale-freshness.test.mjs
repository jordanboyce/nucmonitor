import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import { localesRootFor } from '../scripts/translate-locales.mjs';

// NucMonitor ships English only: the 27 translated app locales were deleted,
// so there is no translation pass to keep fresh and no provenance baseline to
// hold in step with en.json. What survives is the invariant that the locale
// root holds exactly the English bundle and its shell split.
const LOCALES_DIR = localesRootFor(false);

describe('app locale freshness', () => {
  it('ships only the English app locale', () => {
    const shipped = readdirSync(LOCALES_DIR).filter((name) => name.endsWith('.json')).sort();
    assert.deepEqual(shipped, ['en.json', 'en.shell.json']);
  });
});
