import { expect, test, type Page } from '@playwright/test';

// Showcase smoke for the NucMonitor dashboard: the page boots, the facility map
// and the core nuclear panels mount, and nothing throws. Third-party hosts are
// blocked so the run is deterministic; failed data fetches are expected and
// only uncaught exceptions or non-network console errors fail the test.
// Edge functions are answered with a 503 because vite dev cannot run them.

const CORE_PANELS = [
  'nuclear-reactor-status',
  'nuclear-events',
  'nuclear-hazards',
  'nuclear-facilities',
];

// Console noise that comes from the blocked network, not from the app.
// The service worker (/sw.js) is only emitted by `vite build`; under vite dev its
// registration fetches the SPA fallback and fails with a MIME-type error.
const NETWORK_NOISE = /unsupported MIME type \('text\/html'\)|ServiceWorker|Failed to load resource|net::ERR_|ERR_FAILED|ERR_BLOCKED|NetworkError|Failed to fetch|fetch failed|status of [45]\d\d|\b[45]\d\d\b|WebSocket|AbortError|timed? ?out|CORS|circuit/i;

async function blockThirdParty(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      // vite dev serves Vercel edge functions (api/*.js|ts outside the sebuf
      // /api/<domain>/v<N>/ router) as source text, not as running handlers.
      // Answer them the way an unreachable upstream would.
      if (url.pathname.startsWith('/api/') && !/^\/api\/[a-z][a-z0-9-]*\/v\d+\//.test(url.pathname)) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable in e2e"}' });
      }
      return route.continue();
    }
    return route.abort('blockedbyclient');
  });
}

test.describe('NucMonitor dashboard smoke', () => {
  test('boots with the facility map and core nuclear panels', async ({ page }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(`${error.name}: ${error.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !NETWORK_NOISE.test(msg.text())) consoleErrors.push(msg.text());
    });
    await blockThirdParty(page);

    await page.goto('/');

    for (const id of CORE_PANELS) {
      await expect(page.locator(`[data-panel="${id}"]`).first(), `panel ${id}`).toBeAttached({ timeout: 45_000 });
    }
    await expect(page.locator('#mapContainer canvas, #mapContainer svg').first()).toBeAttached({ timeout: 45_000 });
    await expect(page).toHaveTitle(/NucMonitor|Nuclear/i);

    // Let deferred loaders settle so late exceptions surface.
    await page.waitForTimeout(3_000);
    expect(pageErrors, 'uncaught exceptions').toEqual([]);
    expect(consoleErrors, 'console errors').toEqual([]);
  });
});
