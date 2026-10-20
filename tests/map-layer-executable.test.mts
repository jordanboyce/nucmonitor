// Regression guards for src/config/map-layer-definitions.ts:
//
//   - the `renderers: ('svg' | 'deck' | 'globe')[]` axis on LayerDefinition
//   - the `isLayerExecutable(key, kind)` predicate
//
// The renderers list gates whether a `layer:*` toggle (per-layer CMD+K,
// `layers:*` preset, or programmatic dispatch) is allowed to flip a layer
// on under the active renderer. Getting it wrong means toggles can set
// `mapLayers[key] = true` for layers that can't render — silent no-op state
// the user can't toggle back off if the picker hides the command under the
// current renderer.
//
// The single 3-kind axis replaced an ambiguous `'flat'` renderer plus a
// bolted-on `deckGLOnly?: boolean` (#6773 / audit R8): `'flat'` covered both
// the SVG fallback and DeckGL, so DeckGL-only layers needed the extra flag.
// Now `'svg'` and `'deck'` are distinct, so `renderers` alone is the gate.

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import type { MapLayers } from '../src/types';
import { persistGateOwnershipTransition } from '../src/services/variant-panel-ownership';
import {
  LAYER_REGISTRY,
  isLayerCommandAllowed,
  isLayerExecutable,
  isLayerEntitled,
  isLayerToggleAllowed,
  sanitizeLayersForVariant,
  sanitizeLockedLayers,
  sanitizeLockedLayersWithOwnership,
  restoreGateOwnedLockedLayers,
  mapLayerStatesEqual,
  shouldSanitizeLockedLayers,
} from '../src/config/map-layer-definitions';

describe('LAYER_REGISTRY — renderer axis', () => {
  test('layers with only DeckGL render paths are deck-only', () => {
    // diseaseOutbreaks has a DeckGL-only render path. GlobeMap has no branch
    // for it, and Map.ts SVG fallback has no render code. `renderers: ['deck']`
    // is the signal that non-DeckGL contexts must not flip it on.
    assert.deepEqual(LAYER_REGISTRY.diseaseOutbreaks.renderers, ['deck']);
    const deckOnly = (Object.keys(LAYER_REGISTRY) as Array<keyof MapLayers>)
      .filter((key) => LAYER_REGISTRY[key].renderers.length === 1 && LAYER_REGISTRY[key].renderers[0] === 'deck');
    assert.deepEqual(deckOnly, ['diseaseOutbreaks']);
  });

  test('the deckGLOnly flag is fully removed from the definition shape', () => {
    // The second axis is gone; `renderers` alone gates execution now.
    for (const def of Object.values(LAYER_REGISTRY)) {
      assert.equal('deckGLOnly' in def, false, `${def.key} still carries deckGLOnly`);
    }
  });

  test('all-surface layers list every renderer', () => {
    // Layers with a paint path on SVG, DeckGL, and the globe list all three.
    assert.deepEqual(LAYER_REGISTRY.radiationWatch.renderers, ['svg', 'deck', 'globe']);
    assert.deepEqual(LAYER_REGISTRY.natural.renderers, ['svg', 'deck', 'globe']);
    assert.deepEqual(LAYER_REGISTRY.weather.renderers, ['svg', 'deck', 'globe']);
    assert.deepEqual(LAYER_REGISTRY.nuclear.renderers, ['svg', 'deck', 'globe']);
    // Flat-surface-only layers (no globe paint path) are svg + deck.
    assert.deepEqual(LAYER_REGISTRY.usNuclearFacilities.renderers, ['svg', 'deck']);
    assert.deepEqual(LAYER_REGISTRY.dayNight.renderers, ['svg', 'deck']);
  });

  test('every registry entry is keyed by its own key and names at least one renderer', () => {
    for (const [key, def] of Object.entries(LAYER_REGISTRY)) {
      assert.equal(def.key, key);
      assert.ok(def.renderers.length > 0, `${key} has no renderer`);
    }
  });
});

describe('isLayerExecutable — renderer gate', () => {
  test('a deck-only layer is executable under kind "deck" but not "svg" or "globe"', () => {
    // The intended ship state: DeckGL desktop can render, nothing else.
    assert.equal(isLayerExecutable('diseaseOutbreaks', 'deck'), true,
      'DeckGL should execute');
    assert.equal(isLayerExecutable('diseaseOutbreaks', 'svg'), false,
      'SVG fallback must NOT execute a deck-only layer');
    assert.equal(isLayerExecutable('diseaseOutbreaks', 'globe'), false,
      'globe mode must NOT execute (no GlobeMap render path)');
  });

  test('a flat-surface layer admits svg + deck but not globe', () => {
    // The US facility registry renders on the SVG fallback and DeckGL, but
    // has no globe paint path.
    assert.equal(isLayerExecutable('usNuclearFacilities', 'svg'), true);
    assert.equal(isLayerExecutable('usNuclearFacilities', 'deck'), true);
    assert.equal(isLayerExecutable('usNuclearFacilities', 'globe'), false,
      'usNuclearFacilities has no globe renderer');
  });

  test('all-surface layer admits every kind', () => {
    // `radiationWatch` has renderers:['svg', 'deck', 'globe'] (default).
    assert.equal(isLayerExecutable('radiationWatch', 'svg'), true);
    assert.equal(isLayerExecutable('radiationWatch', 'deck'), true);
    assert.equal(isLayerExecutable('radiationWatch', 'globe'), true);
  });

  test('unknown layer key returns false', () => {
    // Typo or stale key -> must not accidentally pass the gate.
    // @ts-expect-error — intentionally passing a key outside the union
    assert.equal(isLayerExecutable('nonexistentLayer', 'deck'), false);
  });
});

// #6045 — premium entitlement gate for CMD+K / programmatic layer enable.
// DeckGLMap disables the checkbox for premium === 'locked' only. NucMonitor
// ships no premium-gated layer (a single partner entitlement covers the
// whole dashboard), so the gate must admit every registered layer and still
// reject unknown keys.
describe('isLayerEntitled — premium locked gate', () => {
  test('no registered layer is premium-gated', () => {
    for (const def of Object.values(LAYER_REGISTRY)) {
      assert.equal(def.premium, undefined, `${def.key} unexpectedly carries premium: ${def.premium}`);
    }
  });

  test('non-premium layers are always entitled', () => {
    for (const key of Object.keys(LAYER_REGISTRY) as Array<keyof MapLayers>) {
      assert.equal(isLayerEntitled(key, false), true, `${key} must be entitled for free users`);
      assert.equal(isLayerEntitled(key, true), true);
    }
  });

  test('unknown layer key returns false', () => {
    // @ts-expect-error — intentionally passing a key outside the union
    assert.equal(isLayerEntitled('nonexistentLayer', true), false);
  });
});

describe('sanitizeLockedLayers — free-user stuck-state heal', () => {
  test('leaves non-locked layers alone and returns the input when nothing changed', () => {
    const input = {
      usNuclearFacilities: true,
      radiationWatch: true,
      fires: false,
    } as unknown as MapLayers;
    const out = sanitizeLockedLayers(input, false);
    assert.equal(out, input, 'no locked layer means no copy and no write');
    assert.equal(out.usNuclearFacilities, true);
    assert.equal(out.radiationWatch, true);
    assert.equal(out.fires, false);
  });

  test('is a no-op when entitled', () => {
    const input = {
      usNuclearFacilities: true,
      radiationWatch: true,
    } as unknown as MapLayers;
    const out = sanitizeLockedLayers(input, true);
    assert.equal(out, input);
  });
});

describe('locked map-layer ownership', () => {
  // Regression: App.sanitizeMapLayersForTier's premium branch guarded its
  // storage write with `restored === layers`, where `restored` came out of
  // sanitizeLayersForVariant. That helper spreads its input, so the identity
  // check was ALWAYS false and the branch persisted on every pass — which is
  // how a `?layers=` deep link came to overwrite the saved (cloud-synced)
  // layer preference. Value comparison is the only correct check here.
  test('sanitizeLayersForVariant never returns its input, so identity guards are dead', () => {
    const layers = {
      usNuclearFacilities: true,
      radiationWatch: false,
    } as unknown as MapLayers;

    const out = sanitizeLayersForVariant(layers, 'nuclear');

    assert.notEqual(
      out,
      layers,
      'a fresh object means `out === layers` can never short-circuit a write',
    );
    assert.equal(
      mapLayerStatesEqual(out, layers),
      true,
      'mapLayerStatesEqual is the comparison that actually detects "nothing changed"',
    );
  });

  test('sanitizeLayersForVariant forces layers outside the nuclear allowlist off', () => {
    const layers = {
      usNuclearFacilities: true,
      cables: true,
      pipelines: true,
      datacenters: true,
    } as unknown as MapLayers;
    const out = sanitizeLayersForVariant(layers, 'nuclear');
    assert.equal(out.usNuclearFacilities, true);
    assert.equal(out.cables, false);
    assert.equal(out.pipelines, false);
    assert.equal(out.datacenters, false);
  });

  test('compares layer snapshots semantically instead of by object identity', () => {
    const layers = { usNuclearFacilities: true, radiationWatch: false } as unknown as MapLayers;
    assert.equal(mapLayerStatesEqual(layers, { ...layers }), true);
    assert.equal(
      mapLayerStatesEqual(layers, { ...layers, radiationWatch: true }),
      false,
    );
  });

  test('records no ownership for non-locked layers and drops stale ownership keys', () => {
    const input = {
      usNuclearFacilities: true,
      radiationWatch: true,
    } as unknown as MapLayers;

    const first = sanitizeLockedLayersWithOwnership(input, new Set(['resilienceScore', 'removed-layer']));
    assert.equal(first.layers.usNuclearFacilities, true);
    assert.equal(first.layers.radiationWatch, true);
    assert.deepEqual(first.gateOwned, new Set(), 'ownership of retired or non-locked layers is discarded');
  });

  test('blocks the durable layer write when ownership persistence fails', () => {
    const writes: string[] = [];

    const persistence = persistGateOwnershipTransition(
      'free',
      () => { writes.push('layers'); },
      () => { writes.push('ownership'); return false; },
    );

    assert.deepEqual(writes, ['ownership'], 'destructive durable write is blocked');
    assert.equal(persistence.complete, false);
  });

  test('restores only valid locked layers owned by the gate', () => {
    const input = {
      usNuclearFacilities: false,
      radiationWatch: false,
    } as unknown as MapLayers;
    const restored = restoreGateOwnedLockedLayers(
      input,
      new Set(['usNuclearFacilities', 'resilienceScore', 'removed-layer']),
    );

    assert.equal(restored, input, 'nothing locked is owned, so nothing is restored');
    assert.equal(restored.usNuclearFacilities, false, 'ordinary user-disabled layers stay disabled');
    assert.equal('removed-layer' in restored, false, 'unknown historical keys are ignored');
    assert.equal('resilienceScore' in restored, false, 'retired locked layers are ignored');
  });
});

describe('isLayerToggleAllowed — stale locked-state recovery', () => {
  test('free and premium users may toggle every registered layer in either direction', () => {
    for (const key of Object.keys(LAYER_REGISTRY) as Array<keyof MapLayers>) {
      for (const hasPremium of [false, true]) {
        assert.equal(isLayerToggleAllowed(key, true, hasPremium), true, `${key} off`);
        assert.equal(isLayerToggleAllowed(key, false, hasPremium), true, `${key} on`);
      }
    }
  });

  test('unknown layers never pass the toggle gate', () => {
    // @ts-expect-error — intentionally passing a key outside the union
    assert.equal(isLayerToggleAllowed('nonexistentLayer', true, false), false);
  });
});

describe('shouldSanitizeLockedLayers — settled-free policy', () => {
  test('does not clamp a pending session before the fallback deadline', () => {
    assert.equal(shouldSanitizeLockedLayers(false, false, false), false);
  });

  test('clamps a settled anonymous session', () => {
    assert.equal(shouldSanitizeLockedLayers(false, true, false), true);
  });

  test('clamps when the bounded fallback is active even if auth stays pending', () => {
    assert.equal(shouldSanitizeLockedLayers(false, false, true), true);
  });

  test('never clamps a premium user', () => {
    assert.equal(shouldSanitizeLockedLayers(true, true, true), false);
  });
});

describe('isLayerCommandAllowed — CMD+K toggle policy', () => {
  test('free users can toggle unlocked layers on the renderers that paint them', () => {
    assert.equal(isLayerCommandAllowed('usNuclearFacilities', false, 'deck', false), true);
    assert.equal(isLayerCommandAllowed('usNuclearFacilities', true, 'svg', false), true);
    assert.equal(isLayerCommandAllowed('radiationWatch', false, 'globe', false), true);
  });

  test('renderer compatibility still blocks commands independently of entitlement', () => {
    // diseaseOutbreaks is deck-only: the SVG fallback and globe cannot run it.
    assert.equal(isLayerCommandAllowed('diseaseOutbreaks', false, 'svg', true), false);
    assert.equal(isLayerCommandAllowed('diseaseOutbreaks', false, 'globe', true), false);
    // The facility registry has no globe paint path.
    assert.equal(isLayerCommandAllowed('usNuclearFacilities', false, 'globe', true), false);
  });
});

describe('isLayerExecutable — matrix of layer x kind', () => {
  // Exhaustive matrix over the three renderer kinds for representative
  // layers. Future edits to the predicate that accidentally widen the
  // allowed set get caught here rather than in production.
  const cases: Array<{
    key: keyof typeof LAYER_REGISTRY;
    kind: 'svg' | 'deck' | 'globe';
    expect: boolean;
    why: string;
  }> = [
    // diseaseOutbreaks = ['deck'] (deck-only)
    { key: 'diseaseOutbreaks',    kind: 'deck',  expect: true,  why: 'deck-only layer on deck' },
    { key: 'diseaseOutbreaks',    kind: 'svg',   expect: false, why: 'deck-only layer rejects the SVG fallback' },
    { key: 'diseaseOutbreaks',    kind: 'globe', expect: false, why: 'deck-only layer rejects globe' },
    // usNuclearFacilities = ['svg', 'deck'] (flat-surface, no globe)
    { key: 'usNuclearFacilities', kind: 'svg',   expect: true,  why: 'flat-surface layer on SVG' },
    { key: 'usNuclearFacilities', kind: 'deck',  expect: true,  why: 'flat-surface layer on deck' },
    { key: 'usNuclearFacilities', kind: 'globe', expect: false, why: 'flat-surface layer rejects globe' },
    // radiationWatch = ['svg', 'deck', 'globe'] (all surfaces)
    { key: 'radiationWatch',      kind: 'svg',   expect: true,  why: 'all-surface layer on SVG' },
    { key: 'radiationWatch',      kind: 'deck',  expect: true,  why: 'all-surface layer on deck' },
    { key: 'radiationWatch',      kind: 'globe', expect: true,  why: 'all-surface layer on globe' },
  ];

  for (const c of cases) {
    test(`${c.why}`, () => {
      assert.equal(isLayerExecutable(c.key, c.kind), c.expect, c.why);
    });
  }
});
