/**
 * Manager-level regression coverage for programmatic dashboard search (#6212).
 *
 * SearchManager cannot be imported by node:test without loading the complete
 * browser/worker graph. Extract the production class (the same technique used
 * by other manager tests) and provide narrow doubles for its module globals.
 * The public searchDashboard/openSearchResult methods and their real selection,
 * visibility, entitlement, renderer, and capability code all run unchanged.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

import {
  LAYER_REGISTRY,
  getAllowedLayerKeys,
  isLayerCommandAllowed,
  isLayerEntitled,
  isLayerExecutable,
} from '../src/config/map-layer-definitions.ts';
import {
  classifySearchMatchEffect,
  isSearchResultEffectHostExecutable,
  searchResultEffectRequiresCancellation,
} from '../src/app/webmcp-search-effects.ts';
import { searchMatchIdentity, type SearchMatch, type SearchResult } from '../src/components/search-types.ts';
import { OpaqueResultCache } from '../src/services/opaque-result-cache.ts';
import {
  raceWebMcpAbort,
  throwIfWebMcpAborted,
  WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
} from '../src/services/webmcp.ts';
import { withTimeout } from '../src/utils/with-timeout.ts';

type Variant = 'nuclear';

const managerSource = readFileSync(
  new URL('../src/app/search-manager.ts', import.meta.url),
  'utf8',
);

const sourceFile = ts.createSourceFile(
  'search-manager.ts',
  managerSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const managerNode = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => (
  ts.isClassDeclaration(statement) && statement.name?.text === 'SearchManager'
));
assert.ok(managerNode, 'SearchManager class must remain in src/app/search-manager.ts');
const managerClassSource = managerNode.getText(sourceFile).replace(/^export\s+/, '');
const managerClassJs = ts.transpileModule(managerClassSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    useDefineForClassFields: true,
  },
}).outputText;

function extractClassJs(path: string, className: string): string {
  const moduleSource = readFileSync(new URL(path, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(path, moduleSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = parsed.statements.find((statement): statement is ts.ClassDeclaration => (
    ts.isClassDeclaration(statement) && statement.name?.text === className
  ));
  assert.ok(declaration, `${className} must remain in ${path}`);
  return ts.transpileModule(declaration.getText(parsed).replace(/^export\s+/, ''), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      useDefineForClassFields: true,
    },
  }).outputText;
}

const selectionDispatcherClassJs = extractClassJs(
  '../src/app/search-selection-dispatcher.ts',
  'SearchSelectionDispatcher',
);
const webMcpSearchControllerClassJs = extractClassJs(
  '../src/app/webmcp-search-controller.ts',
  'WebMcpSearchController',
);

interface Runtime {
  auth: { user?: { id: string; role?: string } };
  premium: boolean;
  pro: boolean;
  panelEntitled: boolean;
  selectedResultTypes: string[];
  detailedCountryAnalytics: Array<[string, string, string]>;
  authListeners: Set<() => void>;
  entitlementListeners: Set<() => void>;
  runtimeConfigListeners: Set<() => void>;
  widgetAccessListeners: Set<() => void>;
  liveFlightQueries: string[];
  liveFlightSignals: Array<AbortSignal | undefined>;
  liveFlightError: Error | null;
  liveFlightPending: boolean;
  releaseLiveFlight: (() => void) | null;
  deferTimers: boolean;
  nextTimerId: number;
  pendingTimers: Map<number, () => void>;
}

interface ModalDouble {
  matches: SearchMatch[];
  revision: number;
  openCalls: number;
  closeCalls: number;
  isOpen: boolean;
  cancelCalls: number;
  clearedSources: string[];
  flightCallsign: string | null;
  humanInteractionCallback: (() => void) | null;
  search(query: string, scope: string): {
    orderedMatches: SearchMatch[];
    flightCallsign: string | null;
  };
  getSearchIndexRevision(): number;
  resolveMatchByIdentity(identity: string): SearchMatch | undefined;
  registerSource(type: string, items: unknown[]): void;
  refreshSearch(): void;
  open(): void;
  closeForProgrammaticSelection(): void;
  cancelPendingWork(): void;
  setOnHumanInteraction(callback: () => void): void;
  triggerHumanInteraction(): void;
}

interface Scenario {
  manager: any;
  runtime: Runtime;
  modal: ModalDouble;
  ctx: any;
  calls: {
    views: string[];
    layers: string[];
    centers: Array<[number, number, number]>;
    timeRanges: string[];
    nuclearIds: string[];
    irradiatorIds: string[];
    countryBriefs: Array<[
      string,
      string,
      { trackDetailedAnalytics?: boolean; signal?: AbortSignal } | undefined,
    ]>;
    enabledPanels: Array<[string, { trackDetailedAnalytics?: boolean } | undefined]>;
    scrolledPanels: string[];
  };
  state: {
    globe: boolean;
    deckGL: boolean;
    updateCount: number;
    onUpdate?: (count: number) => void;
  };
}

type AllowedLayerKeysFn = typeof getAllowedLayerKeys;

function createHarness(
  variant: Variant,
  runtime: Runtime,
  allowedLayerKeys: AllowedLayerKeysFn = getAllowedLayerKeys,
): new (ctx: any, callbacks: any) => any {
  const dependencyNames = [
    'OpaqueResultCache',
    'SEARCH_RESULT_CACHE_MAX_ENTRIES',
    'SEARCH_RESULT_CACHE_TTL_MS',
    'FLIGHT_SEARCH_SOURCE_TTL_MS',
    'LAYER_PRESET_PRIMARY_LAYERS',
    'SITE_VARIANT',
    'DASHBOARD_SEARCH_OUTPUT_TARGET_CHARS',
    'DASHBOARD_SEARCH_TYPE_MAX_CHARS',
    'DASHBOARD_SEARCH_TITLE_MAX_CHARS',
    'DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS',
    'searchMatchIdentity',
    'getAuthState',
    'hasPremiumAccess',
    'subscribeAuthState',
    'onEntitlementChange',
    'subscribeRuntimeConfig',
    'subscribeWidgetAccess',
    'ALL_PANELS',
    'getEffectivePanelConfig',
    'isPanelEntitled',
    'isProUser',
    'isFreePanelCapCounted',
    'countFreePanelCapUsage',
    'FREE_MAX_PANELS',
    'getAllowedLayerKeys',
    'isLayerCommandAllowed',
    'isLayerExecutable',
    'isLayerEntitled',
    'LAYER_PRESETS',
    'LAYER_KEY_MAP',
    'trackSearchResultSelected',
    'trackCountrySelected',
    'runWithAgentAnalyticsSuppressed',
    'suppressNextAgentPanelView',
    'saveToStorage',
    'STORAGE_KEYS',
    'setTheme',
    'TIER1_COUNTRIES',
    'CURATED_COUNTRIES',
    'getCountryBbox',
    't',
    'setTimeout',
    'clearTimeout',
    'withTimeout',
    'fetchAircraftPositions',
    'raceWebMcpAbort',
    'throwIfWebMcpAborted',
    'classifySearchMatchEffect',
    'isSearchResultEffectHostExecutable',
    'searchResultEffectRequiresCancellation',
    'WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE',
  ];
  // Regular `function`s, not arrow functions: the receiver check below only
  // reflects how the caller invoked us (arrow functions ignore call-site
  // `this` entirely, which would make this double unable to reproduce the
  // bug). Mirrors the browser's native `window.setTimeout`/`clearTimeout`,
  // which throw `TypeError: Illegal invocation` when invoked as a method on
  // some object other than the global (WORLDMONITOR-ZT) but tolerate a bare,
  // unqualified call (`this === undefined`).
  function nativeLikeSetTimeout(this: unknown, callback: () => void): number {
    if (this !== undefined) throw new TypeError('Illegal invocation');
    if (!runtime.deferTimers) {
      queueMicrotask(callback);
      return 0;
    }
    const timer = runtime.nextTimerId++;
    runtime.pendingTimers.set(timer, callback);
    return timer;
  }
  function nativeLikeClearTimeout(this: unknown, timer: number): void {
    if (this !== undefined) throw new TypeError('Illegal invocation');
    runtime.pendingTimers.delete(timer);
  }

  const dependencyValues = [
    OpaqueResultCache,
    64,
    120_000,
    120_000,
    // Synthetic presets over the nuclear layer set: a preset's defining
    // (primary) layers, and the wider list it toggles (below).
    {
      hazards: ['radiationWatch', 'natural'],
      infra: ['cables', 'pipelines', 'datacenters'],
    },
    variant,
    10_000,
    80,
    240,
    320,
    searchMatchIdentity,
    () => runtime.auth,
    () => runtime.premium,
    (listener: () => void) => {
      runtime.authListeners.add(listener);
      return () => runtime.authListeners.delete(listener);
    },
    (listener: () => void) => {
      runtime.entitlementListeners.add(listener);
      return () => runtime.entitlementListeners.delete(listener);
    },
    (listener: () => void) => {
      runtime.runtimeConfigListeners.add(listener);
      return () => runtime.runtimeConfigListeners.delete(listener);
    },
    (listener: () => void) => {
      runtime.widgetAccessListeners.add(listener);
      return () => runtime.widgetAccessListeners.delete(listener);
    },
    { 'test-panel': { id: 'test-panel' } },
    (panelId: string) => panelId === 'test-panel' ? { id: panelId } : undefined,
    () => runtime.panelEntitled,
    () => runtime.pro,
    () => true,
    () => 0,
    6,
    allowedLayerKeys,
    isLayerCommandAllowed,
    isLayerExecutable,
    isLayerEntitled,
    {
      hazards: ['radiationWatch', 'natural', 'weather'],
      infra: ['cables', 'pipelines', 'datacenters'],
    },
    {},
    (type: string) => runtime.selectedResultTypes.push(type),
    (code: string, name: string, source: string) => {
      runtime.detailedCountryAnalytics.push([code, name, source]);
    },
    <T>(callback: () => T) => callback(),
    () => {},
    () => {},
    { mapLayers: 'mapLayers' },
    () => {},
    { US: 'United States' },
    {},
    () => null,
    (key: string) => key,
    nativeLikeSetTimeout,
    nativeLikeClearTimeout,
    withTimeout,
    (request: { callsign?: string }, signal?: AbortSignal) => {
      runtime.liveFlightQueries.push(request.callsign ?? '');
      runtime.liveFlightSignals.push(signal);
      if (runtime.liveFlightError) return Promise.reject(runtime.liveFlightError);
      const livePosition = {
        icao24: 'abc123',
        callsign: request.callsign ?? 'AB123',
        lat: 1,
        lon: 2,
        altitudeFt: 30_000,
        groundSpeedKts: 450,
        observedAt: Date.now(),
        onGround: false,
      };
      if (runtime.liveFlightPending) {
        return new Promise<typeof livePosition[]>((resolve) => {
          runtime.releaseLiveFlight = () => resolve([livePosition]);
        });
      }
      return Promise.resolve([livePosition]);
    },
    raceWebMcpAbort,
    throwIfWebMcpAborted,
    classifySearchMatchEffect,
    isSearchResultEffectHostExecutable,
    searchResultEffectRequiresCancellation,
    WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
  ];

  // eslint-disable-next-line no-new-func
  return new Function(
    ...dependencyNames,
    `${selectionDispatcherClassJs}\n${webMcpSearchControllerClassJs}\n${managerClassJs}\nreturn SearchManager;`,
  )(...dependencyValues) as new (ctx: any, callbacks: any) => any;
}

function resultMatch(
  type: SearchResult['type'],
  id: string,
  title: string,
  data: unknown,
  subtitle?: string,
): SearchMatch {
  return {
    kind: 'result',
    score: 2,
    result: { type, id, title, subtitle, data },
  };
}

function commandMatch(id: string, category: string, title = id): SearchMatch {
  return {
    kind: 'command',
    score: 2,
    title,
    subtitle: category,
    command: {
      id,
      category,
      label: title,
      keywords: [title.toLowerCase()],
      icon: '',
    },
  } as SearchMatch;
}

function makeScenario(
  matches: SearchMatch[],
  variant: Variant = 'nuclear',
  options: { allowedLayerKeys?: AllowedLayerKeysFn } = {},
): Scenario {
  const runtime: Runtime = {
    auth: { user: { id: 'user-a', role: 'pro' } },
    premium: true,
    pro: true,
    panelEntitled: true,
    selectedResultTypes: [],
    detailedCountryAnalytics: [],
    authListeners: new Set(),
    entitlementListeners: new Set(),
    runtimeConfigListeners: new Set(),
    widgetAccessListeners: new Set(),
    liveFlightQueries: [],
    liveFlightSignals: [],
    liveFlightError: null,
    liveFlightPending: false,
    releaseLiveFlight: null,
    deferTimers: false,
    nextTimerId: 1,
    pendingTimers: new Map(),
  };
  const calls: Scenario['calls'] = {
    views: [],
    layers: [],
    centers: [],
    timeRanges: [],
    nuclearIds: [],
    irradiatorIds: [],
    countryBriefs: [],
    enabledPanels: [],
    scrolledPanels: [],
  };
  const state: Scenario['state'] = {
    globe: false,
    deckGL: true,
    updateCount: 0,
  };
  const modal: ModalDouble = {
    matches: [...matches],
    revision: 1,
    openCalls: 0,
    closeCalls: 0,
    isOpen: false,
    cancelCalls: 0,
    clearedSources: [],
    flightCallsign: null,
    humanInteractionCallback: null,
    search: () => ({
      orderedMatches: [...modal.matches],
      flightCallsign: modal.flightCallsign,
    }),
    getSearchIndexRevision: () => modal.revision,
    resolveMatchByIdentity: (identity) => modal.matches.find(
      (match) => searchMatchIdentity(match) === identity,
    ),
    registerSource: (type, items) => {
      if (items.length === 0) modal.clearedSources.push(type);
      if (type === 'flight' && items.length > 0) {
        modal.matches = (items as Array<{
          id: string;
          title: string;
          subtitle?: string;
          data: unknown;
        }>).map((item) => resultMatch('flight', item.id, item.title, item.data, item.subtitle));
      }
    },
    refreshSearch: () => {},
    open: () => {
      modal.openCalls += 1;
      modal.isOpen = true;
    },
    closeForProgrammaticSelection: () => {
      modal.closeCalls += 1;
      modal.isOpen = false;
    },
    cancelPendingWork: () => { modal.cancelCalls += 1; },
    setOnHumanInteraction: (callback) => { modal.humanInteractionCallback = callback; },
    triggerHumanInteraction: () => { modal.humanInteractionCallback?.(); },
  };
  const mapLayers = Object.fromEntries(
    Object.keys(LAYER_REGISTRY).map((key) => [key, false]),
  );
  const ctx = {
    searchModal: modal,
    mapLayers,
    map: {
      isGlobeMode: () => state.globe,
      isDeckGLActive: () => state.deckGL,
      setView: (view: string) => calls.views.push(view),
      enableLayer: (layer: string) => calls.layers.push(layer),
      setLayers: () => {},
      setCenter: (lat: number, lon: number, zoom: number) => calls.centers.push([lat, lon, zoom]),
      setTimeRange: (range: string) => calls.timeRanges.push(range),
      triggerNuclearClick: (id: string) => calls.nuclearIds.push(id),
      triggerIrradiatorClick: (id: string) => calls.irradiatorIds.push(id),
    },
    panelSettings: {
      'test-panel': { enabled: false },
      markets: { enabled: true },
      polymarket: { enabled: true },
    },
    panels: {},
    newsPanels: {},
    allNews: [],
    latestPredictions: [],
    latestMarkets: [],
    latestTechEvents: [],
  };
  const Harness = createHarness(variant, runtime, options.allowedLayerKeys);
  const manager = new Harness(ctx, {
    openCountryBriefByCode: (
      code: string,
      name: string,
      options?: { trackDetailedAnalytics?: boolean; signal?: AbortSignal },
    ) => {
      calls.countryBriefs.push([code, name, options]);
      return true;
    },
    enablePanel: (
      panelId: string,
      options?: { trackDetailedAnalytics?: boolean },
    ) => {
      calls.enabledPanels.push([panelId, options]);
      return true;
    },
  });
  // Mirrors SearchManager.setupSearchModal's production authority seam while
  // retaining this test's lightweight prebuilt modal double.
  modal.setOnHumanInteraction(() => manager.cancelPendingProgrammaticSelection());
  manager.updateSearchIndex = () => {
    state.updateCount += 1;
    state.onUpdate?.(state.updateCount);
  };
  manager.searchSelection.scrollToPanel = (panelId: string) => {
    calls.scrolledPanels.push(panelId);
    return true;
  };
  manager.searchSelection.scrollToPanelWhenReady = (panelId: string) => {
    calls.scrolledPanels.push(panelId);
    return true;
  };
  manager.searchSelection.dispatchPanelTabAfterPresentation = () => true;
  manager.destroyed = false;

  // Existing tests omit the host signal the way a capable caller would. Chrome
  // 149–151 passes explicit `undefined`; those cases must keep being able to
  // name the missing signal, so only an omitted argument is filled in.
  const searchDashboard = manager.searchDashboard.bind(manager);
  manager.searchDashboard = (
    query: string,
    scope: string,
    limit: number,
    ...rest: Array<AbortSignal | undefined>
  ) => searchDashboard(
    query,
    scope,
    limit,
    rest.length === 0 ? new AbortController().signal : rest[0],
  );
  const openSearchResult = manager.openSearchResult.bind(manager);
  manager.openSearchResult = (
    resultKey: string,
    waitForMapReady?: () => Promise<void>,
    ...rest: Array<AbortSignal | undefined>
  ) => openSearchResult(
    resultKey,
    waitForMapReady,
    rest.length === 0 ? new AbortController().signal : rest[0],
  );

  return { manager, runtime, modal, ctx, calls, state };
}

async function searchThenOpen(scenario: Scenario, index = 0) {
  const response = await scenario.manager.searchDashboard('needle', 'all', 10);
  const descriptor = response.results[index];
  assert.ok(descriptor, `expected search result at index ${index}`);
  const opened = await scenario.manager.openSearchResult(descriptor.key, async () => {});
  return { response, descriptor, opened };
}

function flushTimers(runtime: Runtime): void {
  while (runtime.pendingTimers.size > 0) {
    const callbacks = [...runtime.pendingTimers.values()];
    runtime.pendingTimers.clear();
    for (const callback of callbacks) callback();
  }
}

describe('SearchManager programmatic dashboard search (#6212)', () => {
  it('denies forged keys and consumes issued keys before selection', async () => {
    const scenario = makeScenario([
      resultMatch('earthquake', 'eq-1', 'Needle earthquake', { id: 'eq-1' }),
    ]);

    assert.deepEqual(await scenario.manager.openSearchResult(`sr_${'f'.repeat(32)}`), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    });

    const first = await searchThenOpen(scenario);
    assert.deepEqual(first.opened, { ok: true, status: 'opened', type: 'earthquake' });
    assert.deepEqual(await scenario.manager.openSearchResult(first.descriptor.key), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    });
    assert.deepEqual(scenario.calls.views, ['global'], 'replay must not repeat selection');
    assert.equal(scenario.modal.openCalls, 0, 'programmatic search must not open CMD+K');
  });

  it('cancels delayed work from an earlier programmatic selection', async () => {
    const scenario = makeScenario([
      resultMatch('nuclear', 'old-site', 'Old site', { id: 'old-site' }),
      resultMatch('earthquake', 'eq-ca', 'Needle earthquake', { id: 'eq-ca' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);

    let staleOpenSettled = false;
    const staleOpen = scenario.manager.openSearchResult(response.results[0].key)
      .then((result: unknown) => {
        staleOpenSettled = true;
        return result;
      });
    await Promise.resolve();
    assert.equal(scenario.runtime.pendingTimers.size, 1);
    assert.equal(staleOpenSettled, false, 'scheduled map work must keep the opener pending');
    assert.deepEqual(
      await scenario.manager.openSearchResult(response.results[1].key),
      { ok: true, status: 'opened', type: 'earthquake' },
    );
    assert.deepEqual(await staleOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });

    flushTimers(scenario.runtime);
    assert.deepEqual(scenario.calls.nuclearIds, []);
    assert.deepEqual(scenario.calls.layers, [], 'the cancelled nuclear-site open must not enable its layer');
    assert.deepEqual(scenario.calls.views, ['global'], 'only the newer earthquake selection moves the map');
  });

  it('rejects an aborted delayed selection without applying its map effect', async () => {
    const scenario = makeScenario([
      resultMatch('nuclear', 'cancelled-site', 'Cancelled site', { id: 'cancelled-site' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    const controller = new AbortController();
    const pendingOpen = scenario.manager.openSearchResult(key, undefined, controller.signal);
    await Promise.resolve();
    assert.equal(scenario.runtime.pendingTimers.size, 1);

    controller.abort();
    await assert.rejects(pendingOpen, (error: unknown) => (
      error instanceof Error && error.name === 'AbortError'
    ));
    flushTimers(scenario.runtime);
    assert.deepEqual(scenario.calls.nuclearIds, []);
    assert.deepEqual(scenario.calls.views, []);
  });

  it('aborts promptly while renderer readiness is still pending', async () => {
    const scenario = makeScenario([
      resultMatch('irradiator', 'irr-pending', 'Pending irradiator', { id: 'irr-pending' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    let releaseRenderer!: () => void;
    const rendererReady = new Promise<void>((resolve) => {
      releaseRenderer = resolve;
    });
    const controller = new AbortController();
    const pendingOpen = scenario.manager.openSearchResult(
      key,
      () => rendererReady,
      controller.signal,
    );
    await Promise.resolve();
    assert.equal(scenario.modal.closeCalls, 0);

    controller.abort();
    await assert.rejects(pendingOpen, (error: unknown) => error === controller.signal.reason);
    assert.deepEqual(scenario.calls.irradiatorIds, []);
    assert.deepEqual(scenario.calls.views, []);
    assert.equal(scenario.modal.closeCalls, 0);
    releaseRenderer();
    await Promise.resolve();
    assert.deepEqual(scenario.calls.irradiatorIds, []);
  });

  it('lets an existing palette interaction cancel an open before renderer readiness', async () => {
    const scenario = makeScenario([
      resultMatch('irradiator', 'irr-human-cancel', 'Human-cancelled irradiator', { id: 'irr-human-cancel' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    let releaseRenderer!: () => void;
    const rendererReady = new Promise<void>((resolve) => { releaseRenderer = resolve; });
    scenario.modal.open();
    const pendingOpen = scenario.manager.openSearchResult(key, () => rendererReady);
    await Promise.resolve();

    scenario.modal.triggerHumanInteraction();
    assert.deepEqual(await pendingOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.equal(scenario.modal.isOpen, true, 'human interaction keeps the existing palette open');
    assert.equal(scenario.modal.closeCalls, 0);

    releaseRenderer();
    await Promise.resolve();
    assert.deepEqual(scenario.calls.irradiatorIds, [], 'released stale readiness must not mutate the map');
    assert.equal(scenario.modal.closeCalls, 0, 'released stale readiness must not close the palette');
  });

  it('lets a newer result supersede an older open held in renderer readiness', async () => {
    const scenario = makeScenario([
      resultMatch('irradiator', 'irr-old', 'Old irradiator', { id: 'irr-old' }),
      resultMatch('irradiator', 'irr-new', 'New irradiator', { id: 'irr-new' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const oldKey = response.results[0]?.key;
    const newKey = response.results[1]?.key;
    assert.ok(oldKey);
    assert.ok(newKey);
    let releaseOldRenderer!: () => void;
    const oldRendererReady = new Promise<void>((resolve) => { releaseOldRenderer = resolve; });
    const oldOpen = scenario.manager.openSearchResult(oldKey, () => oldRendererReady);
    await Promise.resolve();

    assert.deepEqual(
      await scenario.manager.openSearchResult(newKey, async () => {}),
      { ok: true, status: 'opened', type: 'irradiator' },
    );
    assert.deepEqual(await oldOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });

    releaseOldRenderer();
    await Promise.resolve();
    assert.deepEqual(scenario.calls.irradiatorIds, ['irr-new']);
    assert.equal(scenario.modal.closeCalls, 1, 'only the newer successful result may close the palette');
  });

  it('cancels renderer-held opens on security invalidation and destroy', async () => {
    for (const cause of ['security', 'destroy'] as const) {
      const scenario = makeScenario([
        resultMatch('irradiator', `irr-${cause}`, `${cause} irradiator`, { id: `irr-${cause}` }),
      ]);
      if (cause === 'security') scenario.manager.observeSecurityContext();
      const response = await scenario.manager.searchDashboard('needle', 'all', 10);
      const key = response.results[0]?.key;
      assert.ok(key);
      let releaseRenderer!: () => void;
      const rendererReady = new Promise<void>((resolve) => { releaseRenderer = resolve; });
      const pendingOpen = scenario.manager.openSearchResult(key, () => rendererReady);
      await Promise.resolve();

      if (cause === 'security') {
        scenario.runtime.auth = {};
        scenario.runtime.premium = false;
        for (const listener of scenario.runtime.authListeners) listener();
      } else {
        scenario.manager.destroy();
      }

      assert.deepEqual(await pendingOpen, cause === 'destroy'
        ? { ok: false, status: 'denied', reason: 'search_state_changed' }
        : { ok: false, status: 'denied', reason: 'result_no_longer_executable' });
      releaseRenderer();
      await Promise.resolve();
      assert.deepEqual(scenario.calls.irradiatorIds, [], cause);
      assert.equal(scenario.modal.closeCalls, 0, cause);
    }
  });

  it('denies a panel result when enabling it never produces a visible target', async () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Test panel'),
    ]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    delete scenario.manager.searchSelection.scrollToPanel;
    delete scenario.manager.searchSelection.dispatchPanelTabAfterPresentation;
    const runtimeGlobal = globalThis as unknown as {
      document?: { querySelector: () => null };
    };
    const previousDocument = runtimeGlobal.document;
    runtimeGlobal.document = { querySelector: () => null };

    try {
      const response = await scenario.manager.searchDashboard('needle', 'all', 10);
      const key = response.results[0]?.key;
      assert.ok(key);
      const pendingOpen = scenario.manager.openSearchResult(key);
      await Promise.resolve();
      assert.ok(scenario.runtime.pendingTimers.size > 0);
      flushTimers(scenario.runtime);

      assert.deepEqual(await pendingOpen, {
        ok: false,
        status: 'denied',
        reason: 'result_no_longer_executable',
      });
      assert.deepEqual(scenario.calls.enabledPanels, [[
        'test-panel',
        { trackDetailedAnalytics: false },
      ]]);
      assert.deepEqual(scenario.calls.scrolledPanels, []);
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
    }
  });

  it('re-arms agent view suppression when a slow deferred-panel retry finally mounts', async () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Test panel'),
    ]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    delete scenario.manager.searchSelection.scrollToPanel;
    delete scenario.manager.searchSelection.dispatchPanelTabAfterPresentation;
    let mounted = false;
    let notifyMutation = (): void => {};
    let simulatedElapsedMs = 0;
    let observerObserved = false;
    const suppressionTimes: number[] = [];
    scenario.manager.searchSelection.bindings.suppressNextAgentPanelView = () => {
      suppressionTimes.push(simulatedElapsedMs);
    };
    const target = {
      classList: { add: () => {}, remove: () => {} },
      isConnected: true,
      offsetWidth: 1,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('test-panel'),
    };
    const shell = {
      isConnected: true,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('deferred-shell'),
    };
    const runtimeGlobal = globalThis as unknown as {
      document?: {
        body: object;
        querySelector: (selector: string) => typeof target | typeof shell | null;
      };
      MutationObserver?: typeof MutationObserver;
    };
    const previousDocument = runtimeGlobal.document;
    const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
    runtimeGlobal.document = {
      body: {},
      querySelector: (selector) => {
        if (selector.includes(':not([data-deferred-panel])')) return mounted ? target : null;
        return selector.includes('[data-deferred-panel]') ? shell : null;
      },
    };
    class MutationObserverDouble {
      constructor(callback: () => void) {
        notifyMutation = callback;
      }

      observe(): void { observerObserved = true; }
      disconnect(): void {}
      takeRecords(): MutationRecord[] { return []; }
    }
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      writable: true,
      value: MutationObserverDouble as unknown as typeof MutationObserver,
    });

    try {
      const response = await scenario.manager.searchDashboard('needle', 'all', 10);
      const key = response.results[0]?.key;
      assert.ok(key);
      const pendingOpen = scenario.manager.openSearchResult(key);
      await Promise.resolve();
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell']);
      assert.equal(observerObserved, true, 'the deferred wait must observe panel mounts');
      assert.equal(
        scenario.runtime.pendingTimers.size,
        1,
        'waiting uses one deadline rather than polling PanelLayout retry timing',
      );
      assert.deepEqual(
        suppressionTimes,
        [],
        'a shell-only wait must not leave privacy suppression behind if the agent is cancelled',
      );

      let settled = false;
      void pendingOpen.then(() => { settled = true; });
      simulatedElapsedMs = 5_500;
      notifyMutation();
      await Promise.resolve();
      assert.equal(settled, false, 'the failed initial load must keep waiting for PanelLayout retry');

      simulatedElapsedMs += 1_000;
      mounted = true;
      notifyMutation();

      assert.deepEqual(await pendingOpen, {
        ok: true,
        status: 'opened',
        type: 'command',
      });
      assert.equal(simulatedElapsedMs, 6_500, 'the real panel mounted after the privacy TTL and retry gap');
      assert.deepEqual(
        suppressionTimes,
        [6_500],
        'privacy suppression must be armed at the real-panel scroll boundary',
      );
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell', 'test-panel']);
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
      if (previousMutationObserver) {
        Object.defineProperty(globalThis, 'MutationObserver', previousMutationObserver);
      } else {
        delete runtimeGlobal.MutationObserver;
      }
    }
  });

  it('disconnects a human deferred-panel wait when the dispatcher is destroyed', async () => {
    const scenario = makeScenario([]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    let notifyMutation = (): void => {};
    let observerDisconnected = false;
    let observerObserved = false;
    const shell = {
      isConnected: true,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('deferred-shell'),
    };
    const target = {
      classList: { add: () => {}, remove: () => {} },
      isConnected: true,
      offsetWidth: 1,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('real-panel'),
    };
    let mounted = false;
    const runtimeGlobal = globalThis as unknown as {
      document?: {
        body: object;
        querySelector: (selector: string) => typeof target | typeof shell | null;
      };
      MutationObserver?: typeof MutationObserver;
    };
    const previousDocument = runtimeGlobal.document;
    const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
    runtimeGlobal.document = {
      body: {},
      querySelector: (selector) => {
        if (selector.includes(':not([data-deferred-panel])')) return mounted ? target : null;
        return selector.includes('[data-deferred-panel]') ? shell : null;
      },
    };
    class MutationObserverDouble {
      constructor(callback: () => void) { notifyMutation = callback; }
      observe(): void { observerObserved = true; }
      disconnect(): void { observerDisconnected = true; }
      takeRecords(): MutationRecord[] { return []; }
    }
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      writable: true,
      value: MutationObserverDouble as unknown as typeof MutationObserver,
    });

    try {
      const pendingScroll = scenario.manager.searchSelection.scrollToPanelWhenReady(
        'test-panel',
        true,
      );
      await Promise.resolve();
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell']);
      assert.equal(observerObserved, true, 'the deferred wait must observe panel mounts');
      assert.equal(scenario.runtime.pendingTimers.size, 1);

      scenario.manager.searchSelection.destroy();
      assert.equal(await pendingScroll, false);
      assert.equal(observerDisconnected, true);
      assert.equal(scenario.runtime.pendingTimers.size, 0);

      mounted = true;
      notifyMutation();
      assert.deepEqual(
        scenario.calls.scrolledPanels,
        ['deferred-shell'],
        'a late mount must not scroll after dispatcher teardown',
      );
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
      if (previousMutationObserver) {
        Object.defineProperty(globalThis, 'MutationObserver', previousMutationObserver);
      } else {
        delete runtimeGlobal.MutationObserver;
      }
    }
  });

  it('cancels an older human deferred-panel wait when a newer human selection begins', async () => {
    const scenario = makeScenario([]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    delete scenario.manager.searchSelection.scrollToPanel;
    delete scenario.manager.searchSelection.dispatchPanelTabAfterPresentation;
    let notifyMutation = (): void => {};
    let mounted = false;
    let highlightCount = 0;
    let observerObserved = false;
    const shell = {
      isConnected: true,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('deferred-shell'),
    };
    const target = {
      classList: {
        add: () => { highlightCount += 1; },
        remove: () => {},
      },
      isConnected: true,
      offsetWidth: 1,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('stale-real-panel'),
    };
    const runtimeGlobal = globalThis as unknown as {
      document?: {
        body: object;
        querySelector: (selector: string) => typeof target | typeof shell | null;
      };
      MutationObserver?: typeof MutationObserver;
    };
    const previousDocument = runtimeGlobal.document;
    const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
    runtimeGlobal.document = {
      body: {},
      querySelector: (selector) => {
        if (selector.includes(':not([data-deferred-panel])')) return mounted ? target : null;
        return selector.includes('[data-deferred-panel]') ? shell : null;
      },
    };
    class MutationObserverDouble {
      constructor(callback: () => void) { notifyMutation = callback; }
      observe(): void { observerObserved = true; }
      disconnect(): void {}
      takeRecords(): MutationRecord[] { return []; }
    }
    Object.defineProperty(globalThis, 'MutationObserver', {
      configurable: true,
      writable: true,
      value: MutationObserverDouble as unknown as typeof MutationObserver,
    });

    try {
      const pendingPanelOpen = scenario.manager.searchSelection.handleCommand(
        commandMatch('panel:test-panel', 'panels', 'Test panel').command,
      );
      await Promise.resolve();
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell']);
      assert.equal(observerObserved, true, 'the deferred wait must observe panel mounts');

      assert.equal(
        scenario.manager.searchSelection.handleCommand(
          commandMatch('time:week', 'time', 'Past week').command,
        ),
        true,
      );
      assert.equal(await pendingPanelOpen, false, 'the superseded panel wait must be denied');
      assert.deepEqual(scenario.calls.timeRanges, ['week']);

      mounted = true;
      notifyMutation();
      assert.deepEqual(
        scenario.calls.scrolledPanels,
        ['deferred-shell'],
        'a late panel mount must not override the newer human selection',
      );
      assert.equal(highlightCount, 0, 'the stale panel must not be highlighted');
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
      if (previousMutationObserver) {
        Object.defineProperty(globalThis, 'MutationObserver', previousMutationObserver);
      } else {
        delete runtimeGlobal.MutationObserver;
      }
    }
  });

  it('scrolls a deferred panel shell but waits for the real panel before reporting opened', async () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Test panel'),
    ]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    delete scenario.manager.searchSelection.scrollToPanel;
    delete scenario.manager.searchSelection.dispatchPanelTabAfterPresentation;
    let virtualElapsedMs = 0;
    scenario.manager.searchSelection.bindings.setTimeout = (
      callback: () => void,
      delay: number,
    ) => {
      const timer = scenario.runtime.nextTimerId++;
      scenario.runtime.pendingTimers.set(timer, () => {
        virtualElapsedMs += delay;
        callback();
      });
      return timer;
    };
    scenario.manager.searchSelection.bindings.clearTimeout = (timer: number) => {
      scenario.runtime.pendingTimers.delete(timer);
    };
    const shell = {
      isConnected: true,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('deferred-shell'),
    };
    const panel = {
      classList: { add: () => {}, remove: () => {} },
      isConnected: true,
      offsetWidth: 1,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('real-panel'),
    };
    const runtimeGlobal = globalThis as unknown as {
      document?: { querySelector: (selector: string) => typeof shell | typeof panel | null };
    };
    const previousDocument = runtimeGlobal.document;
    runtimeGlobal.document = {
      querySelector: (selector) => {
        if (selector.includes(':not([data-deferred-panel])')) {
          return virtualElapsedMs > 960 ? panel : null;
        }
        return selector.includes('[data-deferred-panel]') ? shell : null;
      },
    };

    try {
      const response = await scenario.manager.searchDashboard('needle', 'all', 10);
      const key = response.results[0]?.key;
      assert.ok(key);
      const pendingOpen = scenario.manager.openSearchResult(key);
      await Promise.resolve();
      assert.equal(scenario.calls.scrolledPanels[0], 'deferred-shell');
      assert.equal(scenario.modal.closeCalls, 0, 'a shell is not a successful presentation');
      flushTimers(scenario.runtime);

      assert.deepEqual(await pendingOpen, {
        ok: true,
        status: 'opened',
        type: 'command',
      });
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell', 'real-panel']);
      assert.ok(virtualElapsedMs >= 1_000, 'the real panel mounted after the old 960 ms window');
      assert.equal(scenario.modal.closeCalls, 1);
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
    }
  });

  it('denies a deferred panel shell that never resolves to a real panel', async () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Test panel'),
    ]);
    scenario.runtime.deferTimers = true;
    delete scenario.manager.searchSelection.scrollToPanelWhenReady;
    delete scenario.manager.searchSelection.scrollToPanel;
    delete scenario.manager.searchSelection.dispatchPanelTabAfterPresentation;
    const shell = {
      isConnected: true,
      scrollIntoView: () => scenario.calls.scrolledPanels.push('deferred-shell'),
    };
    const runtimeGlobal = globalThis as unknown as {
      document?: { querySelector: (selector: string) => typeof shell | null };
    };
    const previousDocument = runtimeGlobal.document;
    runtimeGlobal.document = {
      querySelector: (selector) => (
        selector.includes(':not([data-deferred-panel])') ? null : shell
      ),
    };

    try {
      const response = await scenario.manager.searchDashboard('needle', 'all', 10);
      const key = response.results[0]?.key;
      assert.ok(key);
      scenario.modal.open();
      const pendingOpen = scenario.manager.openSearchResult(key);
      await Promise.resolve();
      flushTimers(scenario.runtime);

      assert.deepEqual(await pendingOpen, {
        ok: false,
        status: 'denied',
        reason: 'result_no_longer_executable',
      });
      assert.deepEqual(scenario.calls.scrolledPanels, ['deferred-shell']);
      assert.equal(scenario.modal.isOpen, true, 'an unresolved shell must not close the palette');
      assert.equal(scenario.modal.closeCalls, 0);
    } finally {
      if (previousDocument === undefined) delete runtimeGlobal.document;
      else runtimeGlobal.document = previousDocument;
    }
  });

  it('cancels delayed programmatic selection work on destroy', async () => {
    const scenario = makeScenario([
      resultMatch('nuclear', 'stale-site', 'Stale site', { id: 'stale-site' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);

    let openSettled = false;
    const pendingOpen = scenario.manager.openSearchResult(response.results[0].key)
      .then((result: unknown) => {
        openSettled = true;
        return result;
      });
    await Promise.resolve();
    assert.equal(scenario.runtime.pendingTimers.size, 1);
    assert.equal(openSettled, false, 'scheduled map work must keep the opener pending');
    scenario.manager.destroy();
    assert.deepEqual(await pendingOpen, {
      ok: false,
      status: 'denied',
      reason: 'search_state_changed',
    });
    flushTimers(scenario.runtime);

    assert.deepEqual(scenario.calls.nuclearIds, []);
    assert.deepEqual(scenario.calls.views, []);
    assert.equal(scenario.modal.cancelCalls, 1);
  });

  it('re-resolves a refreshed target and dispatches its fresh non-indexed payload', async () => {
    // The logical identity (type, id, title) is unchanged; only the payload the
    // map click consumes is refreshed between search and open.
    const oldMatch = resultMatch('nuclear', 'site-xz', 'Example Station', { id: 'old-payload' }, 'PWR');
    const freshMatch = resultMatch('nuclear', 'site-xz', 'Example Station', { id: 'fresh-payload' }, 'PWR');
    const scenario = makeScenario([oldMatch]);
    scenario.state.onUpdate = (count) => {
      if (count === 2) {
        scenario.modal.matches = [freshMatch];
      }
    };

    const { opened } = await searchThenOpen(scenario);
    assert.deepEqual(opened, { ok: true, status: 'opened', type: 'nuclear' });
    assert.deepEqual(scenario.calls.nuclearIds, ['fresh-payload']);
  });

  it('keeps a key valid across a benign index refresh', async () => {
    const match = resultMatch('earthquake', 'eq-1', 'Needle earthquake', { id: 'eq-1' }, 'M5.1');
    const scenario = makeScenario([match]);
    scenario.state.onUpdate = (count) => {
      if (count === 2) scenario.modal.revision += 1;
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: true,
      status: 'opened',
      type: 'earthquake',
    });
    assert.deepEqual(scenario.calls.views, ['global']);
  });

  it('does not consume a map-target key while the renderer is still becoming ready', async () => {
    const scenario = makeScenario([
      resultMatch('irradiator', 'irr-1', 'Needle irradiator', { id: 'irr-1' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    let releaseReady!: () => void;
    const pendingOpen = scenario.manager.openSearchResult(key, () => new Promise<void>((resolve) => {
      releaseReady = resolve;
    }));
    await Promise.resolve();
    scenario.modal.revision += 1;
    releaseReady();
    assert.deepEqual(await pendingOpen, {
      ok: true,
      status: 'opened',
      type: 'irradiator',
    });
    assert.deepEqual(scenario.calls.irradiatorIds, ['irr-1']);
  });

  it('waits for async source hydration before issuing capabilities', async () => {
    const match = resultMatch('earthquake', 'eq-1', 'Needle earthquake', { id: 'eq-1' });
    const scenario = makeScenario([match]);
    let releaseHydration!: () => void;
    scenario.manager.searchIndexReady = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    let settled = false;
    const pendingSearch = scenario.manager.searchDashboard('needle', 'all', 10)
      .then((response: unknown) => {
        settled = true;
        return response;
      });
    await Promise.resolve();
    assert.equal(settled, false);
    releaseHydration();
    const response = await pendingSearch;
    const key = (response as { results: Array<{ key: string }> }).results[0]?.key;
    assert.ok(key);
    const opened = await scenario.manager.openSearchResult(key);
    assert.deepEqual(opened, { ok: true, status: 'opened', type: 'earthquake' });
    assert.deepEqual(scenario.calls.views, ['global']);
  });

  it('denies without selection when destroyed during renderer readiness', async () => {
    const scenario = makeScenario([
      resultMatch('irradiator', 'irr-1', 'Needle irradiator', { id: 'irr-1' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    const opened = await scenario.manager.openSearchResult(key, async () => {
      scenario.manager.destroy();
    });
    assert.deepEqual(opened, {
      ok: false,
      status: 'denied',
      reason: 'search_state_changed',
    });
    assert.deepEqual(scenario.calls.irradiatorIds, []);
  });

  it('denies a key when an index revision removes its logical target', async () => {
    const scenario = makeScenario([
      resultMatch('nuclear', 'removed', 'Removed site', { id: 'removed' }),
    ]);
    scenario.state.onUpdate = (count) => {
      if (count === 2) {
        scenario.modal.revision += 1;
        scenario.modal.matches = [];
      }
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_available',
    });
    assert.deepEqual(scenario.calls.nuclearIds, []);
  });

  it('invalidates capabilities across a same-user entitlement downgrade and restoration', async () => {
    const scenario = makeScenario([
      resultMatch('earthquake', 'eq-1', 'Needle earthquake', { id: 'eq-1' }),
    ]);
    scenario.manager.observeSecurityContext();
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    scenario.runtime.premium = false;
    scenario.runtime.pro = false;
    for (const listener of scenario.runtime.entitlementListeners) listener();
    scenario.runtime.premium = true;
    scenario.runtime.pro = true;
    for (const listener of scenario.runtime.entitlementListeners) listener();

    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    });
    assert.deepEqual(scenario.calls.views, []);
    scenario.manager.destroy();
  });

  it('revalidates executability after a renderer flip', async () => {
    const scenario = makeScenario([
      resultMatch('irradiator', 'irr-1', 'Needle irradiator', { id: 'irr-1' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    assert.equal(response.results[0]?.executable, true);
    const key = response.results[0]?.key;
    assert.ok(key);

    scenario.state.globe = true;
    let readinessCalls = 0;
    assert.deepEqual(await scenario.manager.openSearchResult(key, async () => {
      readinessCalls += 1;
    }), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.equal(readinessCalls, 0, 'a denied key must not wake the deferred renderer');
    assert.deepEqual(scenario.calls.layers, []);
    assert.deepEqual(scenario.calls.irradiatorIds, []);
  });

  it('revalidates renderer compatibility at the delayed mutation boundary', async () => {
    const scenario = makeScenario([
      resultMatch('irradiator', 'irr-delayed', 'Delayed irradiator', { id: 'irr-delayed' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    const pendingOpen = scenario.manager.openSearchResult(key);
    await Promise.resolve();
    assert.equal(scenario.runtime.pendingTimers.size, 1);

    scenario.state.globe = true;
    flushTimers(scenario.runtime);
    assert.deepEqual(await pendingOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(scenario.calls.layers, []);
    assert.deepEqual(scenario.calls.irradiatorIds, []);
    assert.deepEqual(scenario.calls.views, []);
  });

  it('denies a delayed selection removed from the live search index before commit', async () => {
    const scenario = makeScenario([
      resultMatch('nuclear', 'removed-site', 'Removed site', { id: 'removed-site' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    const pendingOpen = scenario.manager.openSearchResult(key);
    await Promise.resolve();
    assert.equal(scenario.runtime.pendingTimers.size, 1);

    scenario.modal.matches = [];
    flushTimers(scenario.runtime);
    assert.deepEqual(await pendingOpen, {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(scenario.calls.nuclearIds, []);
    assert.deepEqual(scenario.calls.views, []);
  });

  it('denies globe time commands that only mutate hidden renderer state', async () => {
    const scenario = makeScenario([
      commandMatch('time:24h', 'actions', 'Last 24 hours'),
    ]);
    scenario.state.globe = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    assert.equal(response.results[0]?.executable, false);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key, async () => {}), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(scenario.calls.timeRanges, []);
  });

  it('denies news retained only by a disabled hidden panel', () => {
    const news = resultMatch('news', 'story', 'Needle story', { link: 'https://example.test/story' });
    const scenario = makeScenario([news]);
    scenario.ctx.newsPanels = {
      politics: { hasNewsItem: () => true },
    };
    scenario.ctx.panelSettings.politics = { enabled: false };
    assert.equal(scenario.manager.isSearchResultExecutable(news.result), false);
  });

  it('opens a duplicate news link in an enabled live panel instead of a disabled first match', async () => {
    const link = 'https://example.test/duplicate-story';
    const news = resultMatch('news', 'duplicate-story', 'Needle story', { link });
    const scenario = makeScenario([news]);
    const itemScrolls: string[] = [];
    scenario.ctx.newsPanels = {
      disabled: {
        hasNewsItem: () => true,
        scrollToNewsItem: () => itemScrolls.push('disabled'),
      },
      enabled: {
        hasNewsItem: () => true,
        scrollToNewsItem: () => itemScrolls.push('enabled'),
      },
    };
    scenario.ctx.panelSettings.disabled = { enabled: false };
    scenario.ctx.panelSettings.enabled = { enabled: true };
    scenario.ctx.panels.enabled = {
      getElement: () => ({ isConnected: true }),
    };

    const { opened } = await searchThenOpen(scenario);

    assert.deepEqual(opened, { ok: true, status: 'opened', type: 'news' });
    assert.deepEqual(scenario.calls.scrolledPanels, ['enabled']);
    assert.deepEqual(itemScrolls, ['enabled']);
  });

  it('keeps an open palette visible when a command fails to present', async () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Test panel'),
    ]);
    scenario.manager.searchSelection.bindings.enablePanel = () => false;

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    scenario.modal.open();
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.equal(scenario.modal.isOpen, true);
    assert.equal(scenario.modal.closeCalls, 0);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    }, 'a failed entered selection must remain one-use');
  });

  it('keeps human-only commands visible while denying agent no-op or unsafe paths', () => {
    const scenario = makeScenario([]);
    for (const action of ['settings', 'route-explorer', 'refresh', 'fullscreen']) {
      const command = commandMatch(`view:${action}`, 'view', action).command;
      assert.equal(scenario.manager.isModalCommandVisible(command), true, action);
      assert.equal(scenario.manager.isCommandExecutable(command), false, action);
    }

    const themeCommand = commandMatch('view:dark', 'view', 'dark').command;
    assert.equal(scenario.manager.isModalCommandVisible(themeCommand), true);
    assert.equal(scenario.manager.isCommandExecutable(themeCommand), true);

    const unloadedCountryMap = commandMatch('country-map:US', 'country-map', 'United States').command;
    assert.equal(scenario.manager.isModalCommandVisible(unloadedCountryMap), false);
    assert.equal(scenario.manager.isCommandExecutable(unloadedCountryMap), false);

    // The country brief is gone and the dispatcher has no `country:` handler:
    // the generated brief commands must not surface as dead clicks.
    const countryBrief = commandMatch('country:US', 'country', 'United States').command;
    assert.equal(scenario.manager.isModalCommandVisible(countryBrief), false);
    assert.equal(scenario.manager.isCommandExecutable(countryBrief), false);
  });

  it('does not treat an incidental preset overlap as a meaningful agent action', () => {
    // The synthetic hazards preset toggles weather as context, but only
    // radiationWatch/natural define it. An allowlist that admits the context
    // layer alone keeps the command visible yet not agent-executable.
    const hazardsPreset = commandMatch('layers:hazards', 'layers', 'Hazard layers').command;
    const contextualOnly = makeScenario([], 'nuclear', {
      allowedLayerKeys: () => new Set(['weather'] as const),
    });
    assert.equal(contextualOnly.manager.isModalCommandVisible(hazardsPreset), true);
    assert.equal(contextualOnly.manager.isCommandExecutable(hazardsPreset), false);

    const nuclear = makeScenario([], 'nuclear');
    assert.equal(nuclear.manager.isCommandExecutable(hazardsPreset), true, 'radiationWatch is a defining hazards layer');

    // The retired infrastructure preset names only layers outside the nuclear
    // allowlist, so it is neither shown nor agent-executable.
    const infraPreset = commandMatch('layers:infra', 'layers', 'Infrastructure layers').command;
    assert.equal(nuclear.manager.isModalCommandVisible(infraPreset), false);
    assert.equal(nuclear.manager.isCommandExecutable(infraPreset), false);
  });

  it('routes panel, map, facility, and command selections through shared handlers', async () => {
    const cases: Array<{
      label: string;
      variant?: Variant;
      match: SearchMatch;
      verify(scenario: Scenario): void;
    }> = [
      {
        label: 'panel',
        match: commandMatch('panel:test-panel', 'panels', 'Test panel'),
        verify: ({ calls }) => {
          assert.deepEqual(calls.enabledPanels, [[
            'test-panel',
            { trackDetailedAnalytics: false },
          ]]);
          assert.deepEqual(calls.scrolledPanels, ['test-panel']);
        },
      },
      {
        label: 'nuclear site',
        match: resultMatch('nuclear', 'np-1', 'Needle station', { id: 'np-1' }),
        verify: ({ calls }) => {
          assert.ok(calls.layers.includes('nuclear'));
          assert.deepEqual(calls.nuclearIds, ['np-1']);
        },
      },
      {
        label: 'irradiator',
        match: resultMatch('irradiator', 'irr-1', 'Needle irradiator', { id: 'irr-1' }),
        verify: ({ calls }) => {
          assert.ok(calls.layers.includes('irradiators'));
          assert.deepEqual(calls.irradiatorIds, ['irr-1']);
        },
      },
      {
        label: 'earthquake',
        match: resultMatch('earthquake', 'eq-1', 'Needle earthquake', { id: 'eq-1' }),
        verify: ({ calls }) => assert.deepEqual(calls.views, ['global']),
      },
      {
        label: 'command',
        match: commandMatch('time:7d', 'actions', 'Last seven days'),
        verify: ({ calls }) => assert.deepEqual(calls.timeRanges, ['7d']),
      },
    ];

    for (const testCase of cases) {
      const scenario = makeScenario([testCase.match], testCase.variant);
      const { opened } = await searchThenOpen(scenario);
      assert.deepEqual(
        opened,
        {
          ok: true,
          status: 'opened',
          type: testCase.match.kind === 'command' ? 'command' : testCase.match.result.type,
        },
        testCase.label,
      );
      testCase.verify(scenario);
      assert.equal(scenario.modal.openCalls, 0, `${testCase.label} must not open CMD+K`);
    }
  });

  it('resolves a desktop-issued key after the ranked window recaps', async () => {
    const matches = Array.from({ length: 8 }, (_, index) => resultMatch(
      'nuclear',
      `np-${index}`,
      `Station ${index}`,
      { id: `np-${index}` },
    ));
    const scenario = makeScenario(matches);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const issued = response.results[response.results.length - 1];
    assert.ok(issued);
    scenario.modal.search = () => ({
      orderedMatches: matches.slice(0, 5),
      flightCallsign: null,
    });

    assert.deepEqual(await scenario.manager.openSearchResult(issued.key), {
      ok: true,
      status: 'opened',
      type: 'nuclear',
    });
    assert.deepEqual(scenario.calls.nuclearIds, ['np-7']);
  });

  it('uses the same premium policy for panel entitlement and free-cap bypass', () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Needle panel'),
    ]);
    scenario.runtime.pro = false;
    scenario.runtime.premium = true;
    scenario.runtime.panelEntitled = true;

    assert.equal(scenario.manager.isCommandExecutable(
      commandMatch('panel:test-panel', 'panels').command,
    ), true);
  });

  it('enforces the nuclear entity visibility matrix without leaking retired domains', () => {
    const probes: Record<string, SearchResult> = {
      nuclear: { type: 'nuclear', id: 'np', title: 'Station', data: { id: 'np' } },
      irradiator: { type: 'irradiator', id: 'irr', title: 'Irradiator', data: { id: 'irr' } },
      earthquake: { type: 'earthquake', id: 'eq', title: 'Quake', data: { id: 'eq' } },
      outage: { type: 'outage', id: 'out', title: 'Outage', data: { id: 'out' } },
      pipeline: { type: 'pipeline', id: 'pipe', title: 'Pipeline', data: { id: 'pipe' } },
      cable: { type: 'cable', id: 'cable', title: 'Cable', data: { id: 'cable' } },
      datacenter: { type: 'datacenter', id: 'dc', title: 'Data center', data: { id: 'dc' } },
    };
    const scenario = makeScenario([], 'nuclear');
    const visible = Object.entries(probes)
      .filter(([, result]) => scenario.manager.isSearchResultVisible(result))
      .map(([name]) => name);
    assert.deepEqual(visible, ['nuclear', 'irradiator', 'earthquake', 'outage']);
    assert.equal(scenario.modal.openCalls, 0);
  });

  it('opens view-state results without a target signal and blocks persistent ones', async () => {
    const viewScenario = makeScenario([
      resultMatch('earthquake', 'view-quake', 'View earthquake', { id: 'view-quake' }),
    ]);
    const viewResponse = await viewScenario.manager.searchDashboard(
      'needle',
      'all',
      10,
      undefined,
    );
    assert.equal(viewResponse.results[0]?.executable, true);
    assert.deepEqual(
      await viewScenario.manager.openSearchResult(
        viewResponse.results[0]!.key,
        async () => {},
        undefined,
      ),
      { ok: true, status: 'opened', type: 'earthquake' },
    );
    assert.deepEqual(viewScenario.calls.views, ['global']);

    const layerScenario = makeScenario([
      commandMatch('layer:radiationWatch', 'layers', 'Toggle radiation watch'),
    ]);
    const layerResponse = await layerScenario.manager.searchDashboard(
      'needle',
      'all',
      10,
      undefined,
    );
    const layerKey = layerResponse.results[0]?.key;
    assert.ok(layerKey);
    assert.equal(layerResponse.results[0]?.executable, false);
    assert.deepEqual(
      await layerScenario.manager.openSearchResult(layerKey, async () => {}, undefined),
      {
        ok: false,
        status: 'denied',
        reason: 'target_cancellation_unsupported',
        message: WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
      },
    );
    assert.deepEqual(layerScenario.calls.layers, []);
    const capable = new AbortController();
    assert.deepEqual(
      await layerScenario.manager.openSearchResult(layerKey, async () => {}, capable.signal),
      { ok: true, status: 'opened', type: 'command' },
    );
    assert.deepEqual(layerScenario.calls.layers, ['radiationWatch']);
  });
});
