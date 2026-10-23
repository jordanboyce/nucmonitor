import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SECOND_ATOMIC_AGE,
  SECOND_ATOMIC_AGE_KIND_LABELS,
  SECOND_ATOMIC_AGE_TOOLS,
  secondAtomicAgeCitation,
  secondAtomicAgeToolsFor,
} from '../src/config/second-atomic-age.ts';

describe('The Second Atomic Age index', () => {
  it('lists well-formed deep links on the site itself', () => {
    const ids = new Set<string>();
    for (const tool of SECOND_ATOMIC_AGE_TOOLS) {
      assert.ok(!ids.has(tool.id), `duplicate tool id ${tool.id}`);
      ids.add(tool.id);
      assert.match(tool.url, /^https:\/\/thesecondatomicage\.com\/[a-z0-9-]+\/$/, `${tool.id} url`);
      assert.ok(tool.title.length > 2 && tool.summary.length > 20, `${tool.id} needs a title and summary`);
      assert.ok(tool.kind in SECOND_ATOMIC_AGE_KIND_LABELS, `${tool.id} kind ${tool.kind}`);
    }
    assert.ok(SECOND_ATOMIC_AGE_TOOLS.length >= 12);
    assert.match(SECOND_ATOMIC_AGE.home, /^https:\/\/thesecondatomicage\.com\/$/);
    assert.match(SECOND_ATOMIC_AGE.reviewed, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('never points at their data files (their terms forbid republishing the dataset)', () => {
    for (const url of [SECOND_ATOMIC_AGE.home, SECOND_ATOMIC_AGE.about, ...SECOND_ATOMIC_AGE_TOOLS.map((t) => t.url)]) {
      assert.doesNotMatch(url, /\.json$|\/data\//, `${url} looks like a data file`);
    }
  });

  it('offers relevant tools per registry category and cites in their requested form', () => {
    const newBuild = secondAtomicAgeToolsFor('new-build').map((t) => t.id);
    assert.ok(newBuild.includes('buildout') && newBuild.includes('criticality'), `new-build tools: ${newBuild.join(', ')}`);
    assert.deepEqual(secondAtomicAgeToolsFor('fuel-cycle').map((t) => t.id), ['fuel-cycle']);
    assert.deepEqual(secondAtomicAgeToolsFor('power-reactor'), []);
    const buildout = SECOND_ATOMIC_AGE_TOOLS.find((t) => t.id === 'buildout')!;
    assert.equal(
      secondAtomicAgeCitation(buildout, '2026-10-22'),
      'The Second Atomic Age, "The Buildout", https://thesecondatomicage.com/buildout/, accessed 2026-10-22',
    );
  });
});
