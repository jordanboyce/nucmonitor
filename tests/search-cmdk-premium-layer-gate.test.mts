/**
 * Executable regression coverage for the CMD+K premium-layer gate (#6045).
 *
 * These tests call the production command policy rather than scanning source
 * text. The policy must preserve a stale free-user off-ramp while denying new
 * activation, and it must continue to honor renderer/DeckGL constraints.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  LAYER_REGISTRY,
  getAllowedLayerKeys,
  isLayerCommandAllowed,
  isLayerEntitled,
  isLayerExecutable,
  shouldSanitizeLockedLayers,
  sanitizeLockedLayers,
} from '../src/config/map-layer-definitions.ts';
import type { MapLayers } from '../src/types/index.ts';

const searchManagerSrc = readFileSync(new URL('../src/app/search-manager.ts', import.meta.url), 'utf8');
const searchSelectionSrc = readFileSync(
  new URL('../src/app/search-selection-dispatcher.ts', import.meta.url),
  'utf8',
);
const commandTier = { premium: false };

function extractSelectionDispatcher(): new (bindings: any) => {
  handleCommand(command: { id: string }): boolean | Promise<boolean>;
} {
  const sourceFile = ts.createSourceFile(
    'search-selection-dispatcher.ts',
    searchSelectionSrc,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const dispatcher = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => (
    ts.isClassDeclaration(statement) && statement.name?.text === 'SearchSelectionDispatcher'
  ));
  assert.ok(dispatcher, 'SearchSelectionDispatcher must remain in the source');
  const js = ts.transpileModule(dispatcher.getText(sourceFile).replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(
    'STORAGE_KEYS',
    'getAllowedLayerKeys',
    'isLayerExecutable',
    'isLayerEntitled',
    'isLayerCommandAllowed',
    'LAYER_PRESETS',
    'LAYER_KEY_MAP',
    'TIER1_COUNTRIES',
    'CURATED_COUNTRIES',
    'getCountryBbox',
    `${js}\nreturn SearchSelectionDispatcher;`,
  )(
    { mapLayers: 'mapLayers' },
    () => getAllowedLayerKeys('nuclear'),
    isLayerExecutable,
    isLayerEntitled,
    isLayerCommandAllowed,
    // Mirrors src/config/commands.ts LAYER_PRESETS, empty since the
    // infrastructure preset was retired (commands.ts pulls i18n's
    // import.meta.glob, so it cannot be imported under node:test).
    {},
    {},
    {},
    {},
    () => null,
  ) as new (bindings: any) => {
    handleCommand(command: { id: string }): boolean | Promise<boolean>;
  };
}

const SearchSelectionHarness = extractSelectionDispatcher();

function extractLayerExecutableCallback(): (context: { ctx: any }, layerKey: string) => boolean {
  const marker = 'this.ctx.searchModal.setLayerExecutableFn((layerKey) => {';
  const start = searchManagerSrc.indexOf(marker);
  assert.ok(start >= 0, 'SearchManager must wire a layer executable callback');
  const arrowStart = searchManagerSrc.indexOf('(layerKey) => {', start);
  const braceStart = searchManagerSrc.indexOf('{', arrowStart);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < searchManagerSrc.length; i++) {
    if (searchManagerSrc[i] === '{') depth++;
    else if (searchManagerSrc[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  assert.ok(end > braceStart, 'SearchManager layer executable callback must have balanced braces');
  const js = ts.transpileModule(
    `function createCallback() { return ${searchManagerSrc.slice(arrowStart, end)}; }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } },
  ).outputText;
  return new Function(
    'SITE_VARIANT',
    'LAYER_KEY_MAP',
    'getAllowedLayerKeys',
    'isLayerCommandAllowed',
    'hasPremiumAccess',
    'getAuthState',
    `${js}\nreturn createCallback;`,
  )(
    'nuclear',
    {},
    getAllowedLayerKeys,
    isLayerCommandAllowed,
    () => commandTier.premium,
    () => ({}),
  ) as () => (layerKey: string) => boolean;
}

const layerExecutableCallbackFactory = extractLayerExecutableCallback();

function makeCommandHarness({
  premium = false,
  deckGL = true,
}: { premium?: boolean; deckGL?: boolean } = {}) {
  const calls = { enabled: [] as string[], setLayers: 0 };
  commandTier.premium = premium;
  const ctx = {
    mapLayers: {
      usNuclearFacilities: false,
      radiationWatch: false,
      diseaseOutbreaks: false,
      cables: false,
    } as unknown as MapLayers,
    map: {
      isGlobeMode: () => false,
      isDeckGLActive: () => deckGL,
      enableLayer: (key: string) => { calls.enabled.push(key); },
      setLayers: () => { calls.setLayers++; },
    },
  };
  const dispatcher = new SearchSelectionHarness({
    ctx,
    getVariant: () => 'nuclear',
    hasPremiumAccess: () => commandTier.premium,
    openCountryBriefByCode: () => true,
    enablePanel: () => true,
    trackSearchResultSelected: () => {},
    trackCountrySelected: () => {},
    runWithAgentAnalyticsSuppressed: (callback: () => unknown) => callback(),
    suppressNextAgentPanelView: () => {},
    resolveExecutableNewsPanel: () => null,
    saveToStorage: () => {},
    setTheme: () => {},
    setTimeout,
    clearTimeout,
  });
  const command = (id: string) => dispatcher.handleCommand({ id });
  return { ctx, calls, command };
}

// NucMonitor registers no premium-locked layer (one partner entitlement covers
// the dashboard), so the #6045 gate must admit every allowlisted layer for a
// free user while the renderer and variant gates keep doing their job.
describe('CMD+K premium layer gate (#6045)', () => {
  it('free users can toggle every registry layer in both directions', () => {
    for (const key of Object.keys(LAYER_REGISTRY) as Array<keyof MapLayers>) {
      if (!isLayerExecutable(key, 'deck')) continue;
      assert.equal(isLayerCommandAllowed(key, false, 'deck', false), true, `${key} on`);
      assert.equal(isLayerCommandAllowed(key, true, 'deck', false), true, `${key} off`);
      assert.equal(isLayerEntitled(key, false), true, key);
    }
    const stale = { radiationWatch: true } as unknown as MapLayers;
    assert.equal(sanitizeLockedLayers(stale, false), stale, 'nothing locked, nothing to heal');
  });

  it('does not treat an unresolved tier as settled-free', () => {
    assert.equal(shouldSanitizeLockedLayers(false, false, false), false);
    assert.equal(isLayerCommandAllowed('usNuclearFacilities', false, 'deck', false), true,
      'an unlocked layer stays available while entitlement is unresolved');
  });

  it('still blocks commands that cannot render in the active map context', () => {
    // diseaseOutbreaks is deck-only: the SVG fallback and globe cannot run it.
    assert.equal(isLayerCommandAllowed('diseaseOutbreaks', false, 'svg', true), false);
    assert.equal(isLayerCommandAllowed('diseaseOutbreaks', false, 'globe', true), false);
    // The facility registry has no globe paint path.
    assert.equal(isLayerCommandAllowed('usNuclearFacilities', false, 'globe', true), false);
  });

  it('wires the production palette filter through the variant and renderer gates', () => {
    let globe = false;
    const ctx = {
      mapLayers: { usNuclearFacilities: false, cables: false } as Record<string, boolean>,
      map: {
        isGlobeMode: () => globe,
        isDeckGLActive: () => true,
      },
    };
    commandTier.premium = false;
    const callback = layerExecutableCallbackFactory.call({ ctx });
    assert.equal(callback('usNuclearFacilities'), true);
    assert.equal(callback('cables'), false, 'retired upstream layers stay out of the nuclear palette');
    assert.equal(callback('radiationWatch'), false, 'a key missing from mapLayers is not offered');
    globe = true;
    assert.equal(callback('usNuclearFacilities'), false, 'no globe paint path');
  });

  it('keeps non-executable and disallowed layers out of the production all-layers preset', () => {
    const svg = makeCommandHarness({ deckGL: false });
    svg.command('layers:all');
    assert.equal(svg.ctx.mapLayers.usNuclearFacilities, true);
    assert.equal(svg.ctx.mapLayers.radiationWatch, true);
    assert.equal(svg.ctx.mapLayers.diseaseOutbreaks, false, 'deck-only layer on the SVG fallback');
    assert.equal(svg.ctx.mapLayers.cables, false, 'outside the nuclear allowlist');
    assert.equal(svg.calls.setLayers, 1);
  });

  it('leaves the active layers alone for the retired infrastructure preset', () => {
    const harness = makeCommandHarness();
    harness.ctx.mapLayers.radiationWatch = true;
    harness.command('layers:infra');
    assert.equal(harness.ctx.mapLayers.cables, false);
    assert.equal(harness.ctx.mapLayers.radiationWatch, true);
  });
});
