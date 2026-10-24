/**
 * Unit tests for the embedding-dedup helpers (scripts/lib/brief-dedup-embed.mjs
 * and scripts/lib/brief-embedding.mjs): entity extraction and veto, clustering,
 * and cosine similarity. No network.
 *
 * Run: node --test tests/brief-dedup-embedding.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cosineSimilarity } from '../scripts/lib/brief-embedding.mjs';
import {
  completeLinkCluster,
  extractEntities,
  shouldVeto,
  singleLinkCluster,
} from '../scripts/lib/brief-dedup-embed.mjs';

describe('extractEntities', () => {
  it('classifies country name as actor, strait as location', () => {
    // Per plan intent: countries are geopolitical actors ("Iran does X"),
    // physical geography is the venue.
    const { locations, actors } = extractEntities('Iran closes Strait of Hormuz');
    assert.ok(actors.includes('iran'));
    // Multi-word match finds "strait of hormuz", NOT the single-token
    // fallback "hormuz" — the full phrase is in the gazetteer.
    assert.ok(
      locations.includes('strait of hormuz') || locations.includes('hormuz'),
      'hormuz location must be detected (as phrase or single token)',
    );
    assert.ok(!locations.includes('iran'));
  });

  it('classifies city as location, person as actor', () => {
    const { locations, actors } = extractEntities('Biden meets Xi in Tokyo');
    assert.ok(locations.includes('tokyo'));
    assert.ok(actors.includes('biden'));
    assert.ok(actors.includes('xi'));
  });

  it('skips common capitalized sentence-starters', () => {
    const { locations, actors } = extractEntities('The meeting begins');
    assert.equal(locations.length, 0);
    assert.equal(actors.length, 0);
  });

  it('keeps sentence-start proper nouns', () => {
    const { actors } = extractEntities('Trump to visit Japan');
    assert.ok(actors.includes('trump'));
    // Japan is a country → actor, not location
    assert.ok(actors.includes('japan'));
  });

  // Regression: multi-word gazetteer entries are matched as whole
  // phrases. An earlier implementation split on whitespace and only
  // checked single tokens, so "Red Sea", "South China Sea", "New York",
  // etc. silently fell through to the actor bucket and disabled the
  // veto for a whole class of real headlines.
  it('matches multi-word location: Red Sea', () => {
    const { locations, actors } = extractEntities('Houthis strike ship in Red Sea');
    assert.ok(locations.includes('red sea'));
    assert.ok(!actors.includes('red'));
    assert.ok(!actors.includes('sea'));
    assert.ok(actors.includes('houthis'));
  });

  it('matches multi-word location: South China Sea', () => {
    const { locations } = extractEntities('Tensions flare in South China Sea');
    assert.ok(locations.includes('south china sea'));
  });

  it('matches multi-word location with lowercase connector: Strait of Hormuz', () => {
    const { locations } = extractEntities('Iran closes Strait of Hormuz');
    assert.ok(locations.includes('strait of hormuz'));
  });

  it('matches multi-word city: Abu Dhabi', () => {
    const { locations } = extractEntities('Summit held in Abu Dhabi');
    assert.ok(locations.includes('abu dhabi'));
  });

  it('matches multi-word city: New York', () => {
    const { locations } = extractEntities('UN meeting in New York');
    assert.ok(locations.includes('new york'));
  });

  // Veto end-to-end: reproducer from the P1 finding. Two Red-Sea
  // headlines share a location and disagree on the actor — veto
  // MUST fire (otherwise the main anti-overmerge guard is off for
  // bodies-of-water / region headlines).
  it('shouldVeto: Houthis vs US on Red Sea — location phrase match fires the veto', () => {
    assert.equal(
      shouldVeto('Houthis strike ship in Red Sea', 'US escorts convoy in Red Sea'),
      true,
    );
  });
});

// ── Single-link clustering ───────────────────────────────────────────────────

describe('singleLinkCluster', () => {
  // Derived from a real production case (2026-04-20-1532 brief, US
  // Navy ship-seizure coverage): 4 wire stories about the same event
  // where pairwise cosines chain through a strong intermediate (story
  // 5 with cos ≥ 0.63 to every other) but one outlier pair (1↔8) is
  // 0.500. Complete-link refuses to merge all 4 because of the outlier;
  // single-link chains them via the bridge.
  it('chains 4 items through a strong intermediate when one pair is weak', () => {
    // Construct 4 unit vectors so cosines are exact:
    //   5 = [1, 0, 0]
    //   1 ≈ strong link to 5 (~0.65), weak to 8
    //   8 ≈ strong link to 5 (~0.70), weak to 1
    //   10 ≈ strong link to 5 (~0.66), weak to 8
    // Constructing this in 3D isn't straightforward; easier to just
    // hand-craft vectors that give the required pairwise matrix.
    const v5 = [1, 0, 0, 0];
    const v1 = [0.65, Math.sqrt(1 - 0.65 * 0.65), 0, 0];
    const v8 = [0.70, 0.0, Math.sqrt(1 - 0.70 * 0.70), 0];
    const v10 = [0.66, Math.sqrt(1 - 0.66 * 0.66) * 0.3, 0, Math.sqrt(1 - 0.66 * 0.66 - (Math.sqrt(1 - 0.66 * 0.66) * 0.3) ** 2)];
    const items = [
      { title: 's1', embedding: v1 },
      { title: 's5', embedding: v5 },
      { title: 's8', embedding: v8 },
      { title: 's10', embedding: v10 },
    ];

    // Complete-link at 0.55 splits at least one story out because the
    // weak 1↔8 / 8↔10 pairs fail the "every pair" rule.
    const complete = completeLinkCluster(items, { cosineThreshold: 0.55 });
    assert.ok(complete.clusters.length >= 2, 'complete-link fails to merge all 4');

    // Single-link at 0.55 chains them through story 5 (strong link
    // to each of 1, 8, 10).
    const single = singleLinkCluster(items, { cosineThreshold: 0.55 });
    assert.equal(single.clusters.length, 1, 'single-link unions all 4 via the bridge');
    assert.deepEqual([...single.clusters[0]].sort(), [0, 1, 2, 3]);
  });

  it('respects veto: pairs that satisfy cosine but fail shouldVeto do NOT union', () => {
    // Two items with high cosine but the veto fires on the pair
    // shape (shared location, disagreeing actors).
    const items = [
      { title: 'Biden meets Xi in Tokyo', embedding: [1, 0, 0] },
      { title: 'Biden meets Putin in Tokyo', embedding: [0.99, Math.sqrt(1 - 0.99 * 0.99), 0] },
    ];
    const vetoFn = (a, b) => shouldVeto(a.title, b.title);
    const out = singleLinkCluster(items, { cosineThreshold: 0.5, vetoFn });
    assert.equal(out.clusters.length, 2, 'veto keeps the two titles separate');
    assert.equal(out.vetoFires, 1);
  });

  it('permutation-invariant: random input orders yield the same cluster set', () => {
    // Single-link is order-independent by construction (union-find
    // doesn't care which pair is visited first). Property test.
    const N = 12;
    const items = [];
    for (let c = 0; c < 3; c++) {
      const basis = Array.from({ length: 3 }, (_, i) => (i === c ? 1 : 0));
      for (let k = 0; k < 4; k++) {
        const jitter = basis.map((v, i) => (i === c ? v - k * 0.002 : v));
        items.push({ title: `c${c}-k${k}`, embedding: jitter, _hash: `c${c}k${k}` });
      }
    }
    const baseline = singleLinkCluster(items, { cosineThreshold: 0.9 }).clusters;
    const baselineSig = baseline
      .map((c) => c.map((i) => items[i]._hash).sort().join(','))
      .sort()
      .join('|');

    let seed = 17;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let r = 0; r < 5; r++) {
      const shuffled = [...items];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const run = singleLinkCluster(shuffled, { cosineThreshold: 0.9 }).clusters;
      const sig = run
        .map((c) => c.map((i) => shuffled[i]._hash).sort().join(','))
        .sort()
        .join('|');
      assert.equal(sig, baselineSig, `shuffle ${r} produced a different cluster set`);
    }
  });

  it('empty input returns empty clusters without exploding', () => {
    const out = singleLinkCluster([], { cosineThreshold: 0.5 });
    assert.deepEqual(out.clusters, []);
    assert.equal(out.vetoFires, 0);
  });
});

// ── Orchestrator clustering-algorithm dispatch ────────────────────────────────


describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  });
  it('returns 0 for orthogonal vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  });
  it('handles a zero vector without throwing', () => {
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  });
});
