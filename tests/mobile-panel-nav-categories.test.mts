import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PANEL_CATEGORY_MAP, VARIANT_DEFAULTS, getVariantPanelCategories, getProPanelKeys } from '../src/config/panels';
import type { PanelConfig } from '../src/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

// getVariantPanelCategories feeds both the UnifiedSettings panel-tab filter
// and the mobile category nav (MobilePanelNav). Regression target: the
// mobile nav must only surface categories the user can actually browse —
// variant-scoped and with at least one enabled panel.

function settings(entries: Record<string, boolean>): Record<string, PanelConfig> {
  return Object.fromEntries(
    Object.entries(entries).map(([key, enabled]) => [key, { name: key, enabled }]),
  );
}

describe('getVariantPanelCategories', () => {
  it('drops categories with no enabled panel', () => {
    const result = getVariantPanelCategories(settings({ 'nuclear-reactor-status': false, 'nuclear-events': false }), 'nuclear');
    assert.equal(result.length, 0);
  });

  it('includes a category once any of its panels is enabled', () => {
    const result = getVariantPanelCategories(settings({ 'nuclear-reactor-status': true, 'nuclear-events': false }), 'nuclear');
    assert.deepEqual(result.map((c) => c.key), ['nuclearHub']);
    assert.equal(result[0]!.labelKey, PANEL_CATEGORY_MAP['nuclearHub']!.labelKey);
    assert.deepEqual(result[0]!.panelKeys, PANEL_CATEGORY_MAP['nuclearHub']!.panelKeys);
  });

  it('panels absent from settings never activate a category', () => {
    // A panel key that is missing entirely must not count as enabled.
    const result = getVariantPanelCategories(settings({ 'not-a-real-panel': true }), 'nuclear');
    assert.equal(result.length, 0);
  });

  it('respects variant scoping (nuclearHub is nuclear-only)', () => {
    const hub = settings({ 'nuclear-reactor-status': true });
    assert.deepEqual(PANEL_CATEGORY_MAP['nuclearHub']!.variants, ['nuclear'], 'fixture assumption');
    // A persisted or URL-borne upstream variant id must not light up nuclear categories.
    assert.ok(!getVariantPanelCategories(hub, 'full').some((c) => c.key === 'nuclearHub'));
    assert.ok(getVariantPanelCategories(hub, 'nuclear').some((c) => c.key === 'nuclearHub'));
  });

  it('unscoped categories (core) are available to every variant id', () => {
    assert.equal(PANEL_CATEGORY_MAP['core']!.variants, undefined, 'core stays unscoped');
    const enabled = settings({ 'nuclear-headlines': true });
    for (const variant of ['nuclear', 'full']) {
      const result = getVariantPanelCategories(enabled, variant);
      assert.ok(
        result.some((c) => c.key === 'core'),
        `variant ${variant} should see the core category`,
      );
    }
  });

  // Chip-clutter guardrail: the mobile nav and the settings filter both depend
  // on this curation.
  it('variant defaults yield the curated category set, free of duplicate labels', () => {
    const expected: Record<string, string[]> = {
      nuclear: ['core', 'nuclearHub', 'nuclearNews'],
    };
    assert.deepEqual(Object.keys(VARIANT_DEFAULTS).sort(), Object.keys(expected).sort(), 'every variant with defaults is covered');
    for (const [variant, expectedKeys] of Object.entries(expected)) {
      const enabledDefaults = settings(
        Object.fromEntries((VARIANT_DEFAULTS[variant] ?? []).map((k: string) => [k, true])),
      );
      const result = getVariantPanelCategories(enabledDefaults, variant);
      assert.deepEqual(result.map((c) => c.key), expectedKeys, `variant ${variant}`);
      const labels = result.map((c) => c.labelKey);
      assert.equal(new Set(labels).size, labels.length, `duplicate category labels for ${variant}`);
    }
  });

  it('preserves PANEL_CATEGORY_MAP declaration order', () => {
    const all = settings(
      Object.fromEntries(
        Object.values(PANEL_CATEGORY_MAP).flatMap((def) => def.panelKeys.map((k) => [k, true])),
      ),
    );
    const keys = getVariantPanelCategories(all, 'nuclear').map((c) => c.key);
    const expected = Object.keys(PANEL_CATEGORY_MAP).filter((k) => keys.includes(k));
    assert.deepEqual(keys, expected);
    assert.equal(keys.length, Object.keys(PANEL_CATEGORY_MAP).length, 'every category applies to nuclear');
  });
});

describe('getProPanelKeys (mobile nav PRO chip)', () => {
  // NucMonitor's catalog carries no premium panel (one partner entitlement
  // covers the dashboard), so the PRO chip must never light up from it.
  it('surfaces no premium panel from the nuclear catalog, enabled or not', () => {
    const enabledDefaults = settings(
      Object.fromEntries((VARIANT_DEFAULTS['nuclear'] ?? []).map((k: string) => [k, true])),
    );
    assert.deepEqual(getProPanelKeys(enabledDefaults, 'nuclear'), []);
  });

  it('drops unknown keys (custom widgets / MCP panels / retired premium panels)', () => {
    const result = getProPanelKeys(settings({
      'cw-abc123': true,
      'mcp-panel-1': true,
      'stock-analysis': true,
      'chat-analyst': true,
    }), 'nuclear');
    assert.deepEqual(result, []);
  });
});

describe('mobile nav i18n contract', () => {
  it('every category labelKey resolves in en.json', () => {
    const en = JSON.parse(readFileSync(resolve(__dirname, '../src/locales/en.json'), 'utf-8'));
    const lookup = (path: string): unknown =>
      path.split('.').reduce<unknown>((node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, en);

    for (const [key, def] of Object.entries(PANEL_CATEGORY_MAP)) {
      assert.equal(typeof lookup(def.labelKey), 'string', `missing en.json key ${def.labelKey} (category ${key})`);
    }
    // The "all" chip both consumers prepend:
    assert.equal(typeof lookup('header.sourceRegionAll'), 'string');
    // The nav's accessible name:
    assert.equal(typeof lookup('components.mobileNav.panelCategories'), 'string');
  });
});
