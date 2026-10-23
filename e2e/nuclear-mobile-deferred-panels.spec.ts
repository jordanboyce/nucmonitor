import { expect, test, type Page } from '@playwright/test';

// Mobile deferred-panel hydration for the NucMonitor dashboard.
//
// At phone widths the initial mount budget is 3 panels
// (INITIAL_PANEL_MOUNT_BUDGET_MOBILE), so the US Nuclear Facility Directory and
// Advanced Nuclear Buildout panels boot as `.panel-deferred-shell` skeletons and
// only swap in their real implementation once their IntersectionObserver sees
// them near the `#main` scrollport. On desktop the budget is 8 and both mount
// synchronously, so a regression on the mobile observer path is invisible to
// every desktop-viewport spec. This test scrolls the shells into view the way a
// phone user does and requires the real panels to render.
//
// Third-party hosts are blocked and edge functions answered with a 503 so the
// run is deterministic; both panels render from the static registry.

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DEFERRED_PANELS = ['nuclear-facilities', 'nuclear-buildout'] as const;

async function blockThirdParty(page: Page): Promise<void> {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
      if (url.pathname.startsWith('/api/') && !/^\/api\/[a-z][a-z0-9-]*\/v\d+\//.test(url.pathname)) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable in e2e"}' });
      }
      return route.continue();
    }
    return route.abort('blockedbyclient');
  });
}

test.describe('NucMonitor mobile deferred panels', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });

  test('Directory and Buildout shells hydrate when scrolled into view at 375px', async ({ page }) => {
    await blockThirdParty(page);
    await page.addInitScript(() => {
      localStorage.setItem('wm-layer-warning-dismissed', 'true');
    });

    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', { timeout: 45_000 });
    await expect(page.locator('#mobileTabBar')).toBeVisible();

    // The reactor status panel sits inside the mobile mount budget and renders
    // immediately; the two panels below it must boot as deferred shells, or this
    // test would no longer exercise the observer path at all.
    await expect(page.locator('[data-panel="nuclear-reactor-status"]')).not.toHaveAttribute('data-deferred-panel', 'true');
    for (const id of DEFERRED_PANELS) {
      await expect(page.locator(`[data-panel="${id}"]`), `${id} boots deferred on mobile`).toHaveAttribute('data-deferred-panel', 'true');
    }

    // Scroll the current shell node directly: the shell is replaced in place
    // when it mounts, so a locator-based scroll can race the swap.
    await page.evaluate(() => {
      document.querySelector('[data-panel="nuclear-facilities"]')?.scrollIntoView({ block: 'start' });
    });

    for (const id of DEFERRED_PANELS) {
      const panel = page.locator(`[data-panel="${id}"]`);
      await expect(panel, `${id} mounts after scrolling into view`).not.toHaveAttribute('data-deferred-panel', 'true', { timeout: 60_000 });
      await expect(panel).not.toHaveClass(/panel-deferred-shell/);
      await expect(panel.locator('.panel-content')).toBeAttached();
    }

    const directory = page.locator('[data-panel="nuclear-facilities"]');
    await expect(directory.locator('.panel-title')).toHaveText(/US Nuclear Facility Directory/i);
    const buildout = page.locator('[data-panel="nuclear-buildout"]');
    await expect(buildout.locator('.panel-title')).toHaveText(/Advanced Nuclear Buildout/i);
  });
});
