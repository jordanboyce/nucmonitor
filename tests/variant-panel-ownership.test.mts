import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { PanelConfig } from '../src/types';
import {
  applyVariantPanelLayoutTransition,
  resolveAppliedPanelLayoutVariant,
  stageVariantSelection,
} from '../src/services/variant-panel-ownership';

describe('variant panel ownership', () => {

  it('seeds a stable valid legacy profile without treating it as a variant switch', () => {
    const seeded: string[] = [];
    const applied = resolveAppliedPanelLayoutVariant({
      appliedVariant: null,
      legacyVariant: 'full',
      currentVariant: 'full',
      validVariants: new Set(['full', 'tech']),
      persistAppliedVariant: (variant) => { seeded.push(variant); },
    });

    assert.equal(applied, 'full');
    assert.deepEqual(seeded, ['full']);
  });

  it('keeps an existing applied marker authoritative during a staged switch', () => {
    const seeded: string[] = [];
    const applied = resolveAppliedPanelLayoutVariant({
      appliedVariant: 'full',
      legacyVariant: 'tech',
      currentVariant: 'tech',
      validVariants: new Set(['full', 'tech']),
      persistAppliedVariant: (variant) => { seeded.push(variant); },
    });

    assert.equal(applied, 'full');
    assert.deepEqual(seeded, []);
  });

  it('ignores an invalid legacy variant when the applied marker is missing', () => {
    const applied = resolveAppliedPanelLayoutVariant({
      appliedVariant: null,
      legacyVariant: 'removed-variant',
      currentVariant: 'full',
      validVariants: new Set(['full', 'tech']),
      persistAppliedVariant: () => { throw new Error('must not seed'); },
    });

    assert.equal(applied, null);
  });

  it('keeps the selected and applied layout variants distinct across a reload', () => {
    const writes: Array<[string, string]> = [];
    assert.equal(
      stageVariantSelection('full', 'tech', (key, value) => {
        writes.push([key, value]);
      }),
      true,
    );
    assert.deepEqual(writes, [
      ['worldmonitor-panel-layout-variant', 'full'],
      ['worldmonitor-variant', 'tech'],
    ]);
  });

  it('does not overwrite the selected variant when the applied marker cannot persist', () => {
    const writes: string[] = [];
    const staged = stageVariantSelection('full', 'tech', (key) => {
      writes.push(key);
      return false;
    });

    assert.equal(staged, false);
    assert.deepEqual(writes, ['worldmonitor-panel-layout-variant']);
  });

  it('persists the marker-free panel reset before marking the new layout applied', () => {
    const panels: Record<string, PanelConfig> = {
      keep: { name: 'Keep', enabled: true },
      outsideEnabled: { name: 'Outside enabled', enabled: true },
      outsideHidden: { name: 'Outside hidden', enabled: false },
      'cw-user': { name: 'Widget', enabled: false },
    };
    const events: string[] = [];
    let persisted: Record<string, PanelConfig> | null = null;

    const result = applyVariantPanelLayoutTransition({
      currentVariant: 'tech',
      panelSettings: panels,
      variantPanelKeys: new Set(['keep', 'new-default']),
      isDynamicPanel: (key) => key.startsWith('cw-'),
      getDefaultPanel: (key) => ({ name: key, enabled: true }),
      persistPanels: (next) => {
        events.push('panels');
        persisted = structuredClone(next);
      },
      persistAppliedVariant: (variant) => events.push(`variant:${variant}`),
    });

    assert.deepEqual(events, ['panels', 'variant:tech']);
    assert.equal(result.outsideEnabled?.enabled, false);
    assert.equal(result.outsideHidden?.enabled, false);
    assert.deepEqual(result['cw-user'], { name: 'Widget', enabled: false }, 'dynamic panel state survives variant resets');
    assert.equal(result['new-default']?.enabled, true);
    assert.deepEqual(persisted, result);
  });

  it('does not advance the applied marker when panel persistence fails', () => {
    const events: string[] = [];
    const result = applyVariantPanelLayoutTransition({
      currentVariant: 'tech',
      panelSettings: { outside: { name: 'Outside', enabled: true } },
      variantPanelKeys: new Set(),
      isDynamicPanel: () => false,
      getDefaultPanel: (key) => ({ name: key, enabled: true }),
      persistPanels: () => {
        events.push('panels');
        throw new Error('quota exceeded');
      },
      persistAppliedVariant: () => events.push('variant'),
    });

    assert.deepEqual(events, ['panels']);
    assert.equal(result.outside?.enabled, false, 'the safe in-memory transition still applies');
  });
});
