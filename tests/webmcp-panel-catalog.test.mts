import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_PANELS,
  PANEL_CATEGORY_MAP,
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
  getInitialPanelSettingsForVariant,
} from '../src/config/panels.ts';
import { SITE_VARIANTS } from '../src/config/variant.ts';
import {
  DASHBOARD_PANEL_CATALOG_DEFAULT_LIMIT,
  DASHBOARD_PANEL_CATALOG_MAX_LIMIT,
  DASHBOARD_PANEL_CATALOG_OUTPUT_TARGET_CHARS,
  DashboardPanelCatalogError,
  getCanonicalDashboardPanelIds,
  getDashboardPanelCategoryKey,
  listDashboardPanelCatalog,
  type DashboardPanelCatalogItem,
  type DashboardPanelCatalogLiveState,
  type DashboardPanelCatalogPage,
} from '../src/services/webmcp-panel-catalog.ts';
import { WEBMCP_TOOL_BUDGETS } from '../src/config/webmcp.ts';
import type { PanelConfig } from '../src/types/index.ts';

function liveState(
  variant: string,
  overrides: {
    enabled?: string[];
    mounted?: string[];
    denied?: string[];
    panelSettings?: Record<string, PanelConfig>;
  } = {},
): DashboardPanelCatalogLiveState {
  const panelSettings = overrides.panelSettings ?? getInitialPanelSettingsForVariant(variant);
  if (overrides.enabled) {
    const enabled = new Set(overrides.enabled);
    for (const [panelId, config] of Object.entries(panelSettings)) {
      panelSettings[panelId] = { ...config, enabled: enabled.has(panelId) };
    }
  }
  const mounted = new Set(
    overrides.mounted
      ?? Object.entries(panelSettings)
        .filter(([, config]) => config.enabled)
        .map(([panelId]) => panelId),
  );
  const denied = new Set(overrides.denied ?? []);
  return {
    currentVariant: variant,
    panelSettings,
    mountedIds: mounted,
    isPanelAllowed: (panelId, config) => !denied.has(panelId) && !config.premium,
  };
}

function collectPages(
  live: DashboardPanelCatalogLiveState,
  query: Parameters<typeof listDashboardPanelCatalog>[1] = {},
): DashboardPanelCatalogPage[] {
  const pages: DashboardPanelCatalogPage[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 80; guard += 1) {
    const page = listDashboardPanelCatalog(live, { ...query, cursor, limit: query?.limit });
    pages.push(page);
    if (!page.hasMore) return pages;
    assert.equal(typeof page.nextCursor, 'string');
    cursor = page.nextCursor ?? undefined;
  }
  throw new Error('catalog pagination did not terminate');
}

describe('WebMCP dashboard panel catalog', () => {
  it('lists every canonical panel ID, including disabled World defaults', () => {
    const uniqueIds = getCanonicalDashboardPanelIds();
    const worldIds = getCanonicalDashboardPanelIds('full');
    const disabledWorld = (VARIANT_DEFAULTS.full ?? [])
      .filter((panelId) => getEffectivePanelConfig(panelId, 'full').enabled !== true);

    assert.equal(uniqueIds.length, Object.keys(ALL_PANELS).length);
    assert.equal(worldIds.length, 111);
    assert.ok(uniqueIds.includes('nuclear-reactor-status'));
    assert.ok(uniqueIds.includes('nuclear-hazards'));
    assert.equal(worldIds.includes('nuclear-reactor-status'), false);
    assert.ok(disabledWorld.length > 0, 'World registry must include disabled panels');
    assert.ok(disabledWorld.every((panelId) => worldIds.includes(panelId)));
    assert.deepEqual([...uniqueIds], [...uniqueIds].sort((left, right) => left.localeCompare(right, 'en')));
  });

  it('rejects invalid filters and cursors with structured reasons', () => {
    const live = liveState('full');
    const cases: Array<[Parameters<typeof listDashboardPanelCatalog>[1], string]> = [
      [{ variant: 'desktop' }, 'invalid_variant'],
      [{ category: 'not-a-category' }, 'invalid_category'],
      [{ category: 'constructor' }, 'invalid_category'],
      [{ cursor: 'not-a-panel' }, 'invalid_cursor'],
      [{ cursor: 'cw-risk-chart' }, 'invalid_cursor'],
      [{ limit: 0 }, 'invalid_limit'],
      [{ limit: DASHBOARD_PANEL_CATALOG_MAX_LIMIT + 1 }, 'invalid_limit'],
      [{ enabled: 'true' as unknown as boolean }, 'malformed_arguments'],
    ];

    for (const [query, reason] of cases) {
      assert.throws(
        () => listDashboardPanelCatalog(live, query),
        (error: unknown) => (
          error instanceof DashboardPanelCatalogError
          && error.reason === reason
        ),
        JSON.stringify(query),
      );
    }
  });

});
