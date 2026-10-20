/**
 * Regression tests for split GDELT circuit breakers (PR #879).
 *
 * Root cause: two instances of the shared-breaker anti-pattern fixed in the same
 * audit pass that caught the World Bank breaker bug (PR #877):
 *
 * gdeltBreaker was shared between fetchGdeltArticles (military/conflict
 *      queries, 10-min cache) and fetchPositiveGdeltArticles (peace/humanitarian queries,
 *      different topic set). Failures in one function silenced the other, and the 10-min
 *      cache stored whichever query ran last, poisoning the other function's results.
 *      Fix: positiveGdeltBreaker — dedicated breaker for the positive sentiment path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ============================================================
// Behavioral: circuit breaker isolation (gdelt-intel.ts was removed)
// ============================================================

describe('CircuitBreaker isolation — GDELT split breaker independence', () => {
  const CIRCUIT_BREAKER_URL = pathToFileURL(
    resolve(root, 'src/utils/circuit-breaker.ts'),
  ).href;

  it('GDELT: positive breaker failure does not trip regular breaker', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const gdelt = createCircuitBreaker({ name: 'GDELT Intelligence', cacheTtlMs: 10 * 60 * 1000 });
      const positive = createCircuitBreaker({ name: 'GDELT Positive', cacheTtlMs: 10 * 60 * 1000 });

      const fallback = { articles: [], totalArticles: 0 };
      const alwaysFail = () => { throw new Error('GDELT API unavailable'); };

      // Force positive breaker into cooldown (2 failures)
      await positive.execute(alwaysFail, fallback); // failure 1
      await positive.execute(alwaysFail, fallback); // failure 2 → cooldown
      assert.equal(positive.isOnCooldown(), true, 'positive breaker should be on cooldown after 2 failures');

      // gdelt breaker must NOT be affected
      assert.equal(gdelt.isOnCooldown(), false, 'gdelt breaker must not be on cooldown when positive fails');

      // gdelt should still call through successfully
      const realArticles = { articles: [{ url: 'https://news.example/military', title: 'Conflict update' }], totalArticles: 1 };
      const result = await gdelt.execute(async () => realArticles, fallback);
      assert.deepEqual(result, realArticles, 'gdelt breaker should return live data unaffected by positive cooldown');
    } finally {
      clearAllCircuitBreakers();
    }
  });

  it('GDELT: regular and positive breakers cache different data independently', async () => {
    const { createCircuitBreaker, clearAllCircuitBreakers } = await import(
      `${CIRCUIT_BREAKER_URL}?t=${Date.now()}`
    );

    clearAllCircuitBreakers();

    try {
      const gdelt = createCircuitBreaker({ name: 'GDELT Intelligence', cacheTtlMs: 10 * 60 * 1000 });
      const positive = createCircuitBreaker({ name: 'GDELT Positive', cacheTtlMs: 10 * 60 * 1000 });

      const fallback = { articles: [], totalArticles: 0 };
      const militaryData = { articles: [{ url: 'https://news.example/military', title: 'Military operations' }], totalArticles: 1 };
      const peaceData    = { articles: [{ url: 'https://good.example/peace', title: 'Peace agreement' }], totalArticles: 1 };

      // Populate both caches with different data
      await gdelt.execute(async () => militaryData, fallback);
      await positive.execute(async () => peaceData, fallback);

      // Each must return its own cached value; pass fallback fn that would return wrong data
      const cachedGdelt    = await gdelt.execute(async () => fallback, fallback);
      const cachedPositive = await positive.execute(async () => fallback, fallback);

      assert.ok(
        cachedGdelt.articles[0]?.url.includes('military'),
        'gdelt cache must return military article URL, not peace article',
      );
      assert.ok(
        cachedPositive.articles[0]?.url.includes('peace'),
        'positive cache must return peace article URL, not military article',
      );
      assert.notEqual(
        cachedGdelt.articles[0]?.url,
        cachedPositive.articles[0]?.url,
        'Cached article URLs must be distinct per breaker (no cross-contamination)',
      );
    } finally {
      clearAllCircuitBreakers();
    }
  });
});
