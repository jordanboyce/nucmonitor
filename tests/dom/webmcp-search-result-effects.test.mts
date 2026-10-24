/**
 * Per-result cancellation for open_search_result (#7320).
 *
 * Chrome 149–151 omits the target-side AbortSignal. The selector tool used to
 * refuse every result for that reason. Safe view-state results (an already
 * enabled panel) must run; persistent, quota-consuming, and external-navigation
 * results stay blocked. The effect class is bound to the opaque token at
 * issuance so a caller cannot downgrade it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SearchSelectionDispatcher } from '@/app/search-selection-dispatcher';
import { WebMcpSearchController } from '@/app/webmcp-search-controller';
import type { SearchMatch } from '@/components/search-types';
import { STORAGE_KEYS } from '@/config';
import { COMMANDS } from '@/config/commands';
import { saveToStorage } from '@/utils';
import {
  buildWebMcpTools,
  type DashboardContextSnapshot,
  type WebMcpAppBindings,
  type WebMcpNavigationResult,
  WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
} from '@/services/webmcp';

const unusedDashboardContext: DashboardContextSnapshot = {
  variant: 'nuclear',
  map: {
    view: 'global',
    center: null,
    zoom: 2,
    timeRange: '7d',
    enabledLayers: [],
  },
  panels: { mounted: [], enabled: [] },
};

function unusedNavigationResult(
  destination: WebMcpNavigationResult['destination'],
  extras: Partial<WebMcpNavigationResult> = {},
): WebMcpNavigationResult {
  return {
    ok: true,
    status: 'applied',
    destination,
    message: 'Unused in this test.',
    context: unusedDashboardContext,
    ...extras,
  };
}

const unusedNavigationBindings: Pick<
  WebMcpAppBindings,
  'openSettings' | 'listMissionPresets' | 'applyMissionPreset' | 'openMissionPicker'
> = {
  openSettings: async () => unusedNavigationResult('settings', {
    overlay: 'open',
    tab: 'settings',
  }),
  listMissionPresets: async () => ({
    ok: true,
    variant: 'nuclear',
    activePresetId: null,
    presets: [],
    count: 0,
  }),
  applyMissionPreset: async () => ({
    ok: true,
    status: 'applied',
    presetId: 'supply-chain-risk',
    label: 'Supply-Chain Risk',
    changed: false,
    monitor: 'nuclear',
    message: 'Unused mission preset binding.',
  }),
  openMissionPicker: async () => unusedNavigationResult('mission_picker', {
    overlay: 'open',
  }),
};

const unusedPanelLayoutBindings: Pick<
  WebMcpAppBindings,
  'getPanelLayout' | 'setPanelCollapsed' | 'movePanel' | 'setPanelFullscreen' | 'selectPanelTab'
> = {
  getPanelLayout: async () => {
    throw new Error('Unexpected panel layout read.');
  },
  setPanelCollapsed: async () => {
    throw new Error('Unexpected panel layout mutation.');
  },
  movePanel: async () => {
    throw new Error('Unexpected panel layout mutation.');
  },
  setPanelFullscreen: async () => {
    throw new Error('Unexpected panel layout mutation.');
  },
  selectPanelTab: async () => {
    throw new Error('Unexpected panel tab mutation.');
  },
};

function commandMatch(id: string): SearchMatch {
  const command = COMMANDS.find((entry) => entry.id === id);
  if (!command) throw new Error(`Expected command ${id}`);
  return {
    kind: 'command',
    command,
    score: 1,
    title: command.label,
    subtitle: command.category,
  };
}

function mountPanel(panelId: string): HTMLElement {
  const panel = document.createElement('div');
  panel.setAttribute('data-panel', panelId);
  document.body.append(panel);
  return panel;
}

function createHarness(matches: SearchMatch[], enabledPanels: Record<string, boolean> = {}) {
  const mapLayers = { fires: false };
  const enableLayer = vi.fn();
  const closeForProgrammaticSelection = vi.fn();
  const openSettings = vi.fn();
  const panelSettings = Object.fromEntries(
    Object.entries(enabledPanels).map(([panelId, enabled]) => [panelId, { enabled }]),
  );
  const enablePanel = vi.fn((panelId: string) => {
    const settings = panelSettings[panelId] ?? { enabled: false };
    settings.enabled = true;
    panelSettings[panelId] = settings;
    saveToStorage(STORAGE_KEYS.panels, panelSettings);
    return true;
  });
  const modal = {
    search: vi.fn(() => ({ orderedMatches: matches })),
    resolveMatchByIdentity: vi.fn((identity: string) => (
      matches.find((match) => JSON.stringify(
        match.kind === 'command'
          ? ['command', match.command.id]
          : ['result', match.result.type, match.result.id, match.result.title, ''],
      ) === identity)
    )),
    closeForProgrammaticSelection,
  };
  const dispatcher = new SearchSelectionDispatcher({
    ctx: {
      mapLayers,
      map: {
        isGlobeMode: () => false,
        isDeckGLActive: () => false,
        enableLayer,
        setView: vi.fn(),
        setLayers: vi.fn(),
      },
      panelSettings,
      newsPanels: {},
      unifiedSettings: { open: openSettings },
    } as never,
    getVariant: () => 'nuclear',
    enablePanel,
    trackSearchResultSelected: vi.fn(),
    runWithAgentAnalyticsSuppressed: (callback) => callback(),
    suppressNextAgentPanelView: vi.fn(),
    resolveExecutableNewsPanel: vi.fn(() => null),
    saveToStorage,
    setTheme: vi.fn(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  });
  const controller = new WebMcpSearchController({
    waitForIndexReady: async () => {},
    isDestroyed: () => false,
    refreshIndex: vi.fn(),
    getModal: () => modal as never,
    getAuthContext: () => 'anonymous:settled',
    getVariant: () => 'nuclear',
    isMatchExecutable: () => true,
    isPanelCurrentlyEnabled: (panelId) => enabledPanels[panelId] === true,
    selectMatch: (candidate, signal) => dispatcher.selectProgrammaticMatch(
      candidate,
      () => candidate,
      signal,
    ),
    subscribeAuth: () => () => {},
    subscribeRuntimeConfig: () => () => {},
    cancelPendingSelection: () => dispatcher.cancelPendingProgrammaticSelection(),
  });
  return {
    closeForProgrammaticSelection,
    controller,
    dispatcher,
    enableLayer,
    enablePanel,
    mapLayers,
    modal,
    openSettings,
    panelSettings,
  };
}

const cancellationDenial = {
  ok: false,
  status: 'denied',
  reason: 'target_cancellation_unsupported',
  message: WEBMCP_UNSUPPORTED_CANCELLATION_MESSAGE,
} as const;

describe('open_search_result evaluates cancellation per issued effect', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('opens an enabled panel without a target-side signal', async () => {
    const { controller, closeForProgrammaticSelection, dispatcher } = createHarness(
      [commandMatch('panel:radiation-watch')],
      { 'radiation-watch': true },
    );
    mountPanel('radiation-watch');

    const response = await controller.search('webcam', 'panels', 10);
    const issued = response.results[0];
    expect(issued).toMatchObject({
      type: 'command',
      executable: true,
    });
    expect(issued).not.toHaveProperty('effectClass');

    await expect(controller.open(issued!.key, async () => {})).resolves.toStrictEqual({
      ok: true,
      status: 'opened',
      type: 'command',
    });
    expect(closeForProgrammaticSelection).toHaveBeenCalledOnce();
    expect(localStorage.getItem(STORAGE_KEYS.mapLayers)).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.panels)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });

  it('does not advertise or run a persistent layer result without a target-side signal', async () => {
    const { controller, dispatcher, enableLayer } = createHarness(
      [commandMatch('layer:fires')],
    );

    const response = await controller.search('fires', 'map', 10);
    const issued = response.results[0];
    expect(issued?.executable).toBe(false);

    await expect(controller.open(issued!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enableLayer).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.mapLayers)).toBeNull();

    const host = new AbortController();
    await expect(
      controller.open(issued!.key, async () => {}, host.signal),
    ).resolves.toStrictEqual({
      ok: true,
      status: 'opened',
      type: 'command',
    });
    expect(enableLayer).toHaveBeenCalledWith('fires');

    controller.destroy();
    dispatcher.destroy();
  });

  it('persists a layer result only when the host supplies a target-side signal', async () => {
    const { controller, dispatcher, enableLayer } = createHarness(
      [commandMatch('layer:fires')],
    );
    const host = new AbortController();

    const response = await controller.search('fires', 'map', 10, host.signal);
    const issued = response.results[0];
    expect(issued?.executable).toBe(true);

    await expect(
      controller.open(issued!.key, async () => {}, host.signal),
    ).resolves.toStrictEqual({
      ok: true,
      status: 'opened',
      type: 'command',
    });
    expect(enableLayer).toHaveBeenCalledWith('fires');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.mapLayers)!))
      .toStrictEqual({ fires: true });

    controller.destroy();
    dispatcher.destroy();
  });

  it('does not run a persistent result advertised under a capable host when open omits the signal', async () => {
    const { controller, dispatcher, enableLayer } = createHarness(
      [commandMatch('layer:fires')],
    );
    const host = new AbortController();

    const response = await controller.search('fires', 'map', 10, host.signal);
    expect(response.results[0]?.executable).toBe(true);

    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enableLayer).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.mapLayers)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });

  it('blocks an external-navigation settings result without a target-side signal', async () => {
    const { controller, closeForProgrammaticSelection, dispatcher, openSettings } = createHarness(
      [commandMatch('view:settings')],
    );

    const response = await controller.search('settings', 'actions', 10);
    expect(response.results[0]?.executable).toBe(false);
    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(openSettings).not.toHaveBeenCalled();
    expect(closeForProgrammaticSelection).not.toHaveBeenCalled();

    controller.destroy();
    dispatcher.destroy();
  });

  it('blocks enabling a disabled panel without a target-side signal', async () => {
    const { controller, closeForProgrammaticSelection, dispatcher, enablePanel } = createHarness(
      [commandMatch('panel:world-clock')],
      { 'world-clock': false },
    );

    const response = await controller.search('webcam', 'panels', 10);
    expect(response.results[0]?.executable).toBe(false);
    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enablePanel).not.toHaveBeenCalled();
    expect(closeForProgrammaticSelection).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.panels)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });

  it('denies an issued enabled panel after it is disabled without a target-side signal', async () => {
    const enabledPanels = { 'radiation-watch': true };
    const { controller, closeForProgrammaticSelection, dispatcher, enablePanel, panelSettings } =
      createHarness([commandMatch('panel:radiation-watch')], enabledPanels);

    const response = await controller.search('webcam', 'panels', 10);
    expect(response.results[0]?.executable).toBe(true);

    enabledPanels['radiation-watch'] = false;
    panelSettings['radiation-watch']!.enabled = false;

    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enablePanel).not.toHaveBeenCalled();
    expect(closeForProgrammaticSelection).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.panels)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });

  it('keeps the bound persistent class when a disabled panel is later enabled', async () => {
    const enabledPanels = { 'world-clock': false };
    const { controller, closeForProgrammaticSelection, dispatcher, enablePanel } = createHarness(
      [commandMatch('panel:world-clock')],
      enabledPanels,
    );

    const response = await controller.search('webcam', 'panels', 10);
    expect(response.results[0]?.executable).toBe(false);

    enabledPanels['world-clock'] = true;

    await expect(controller.open(response.results[0]!.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enablePanel).not.toHaveBeenCalled();
    expect(closeForProgrammaticSelection).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.panels)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });

  it('keeps the bound effect class when the advertised executable flag is ignored', async () => {
    const { controller, dispatcher, enableLayer } = createHarness(
      [commandMatch('layer:fires')],
    );
    const response = await controller.search('fires', 'map', 10);
    const issued = { ...response.results[0]!, executable: true };

    await expect(controller.open(issued.key, async () => {})).resolves.toStrictEqual(
      cancellationDenial,
    );
    expect(enableLayer).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEYS.mapLayers)).toBeNull();

    controller.destroy();
    dispatcher.destroy();
  });
});

describe('open_search_result rejects a caller-supplied effect class', () => {
  it('treats an extra effect property as malformed arguments', async () => {
    const tools = buildWebMcpTools({
      openSearch: async () => true,
      getDashboardContext: async () => unusedDashboardContext,
      listMapLayerCatalog: async () => ({
        variant: 'nuclear',
        rendererKind: 'deck',
        enabledLayers: [],
        liveLayerKeys: [],
        deckGlActive: true,
      }),
      ...unusedNavigationBindings,
      applyDashboardAction: async () => ({
        ok: true,
        status: 'applied',
        message: 'Applied.',
        targets: [],
      }),
      searchDashboard: async () => ({
        queryLength: 1,
        results: [],
        resultCount: 0,
        truncated: false,
      }),
      openSearchResult: async () => ({ ok: true, status: 'opened' }),
      setPanelEnabled: async () => {
        throw new Error('Unexpected dashboard panel mutation.');
      },
      ...unusedPanelLayoutBindings,
      applyDashboardTabAction: async () => {
        throw new Error('Unexpected dashboard tab action.');
      },
      listDashboardPanels: async () => {
        throw new Error('Unexpected dashboard panel catalog read.');
      },
      getAccessContext: async () => ({
        accountState: 'signed_out',
        clerk: 'unavailable',
        usage: { enabledPanels: 1, dashboardTabs: 1 },
      }),
      openSignIn: async () => ({ ok: false, status: 'denied', reason: 'clerk_unavailable' }),
    }, () => {});
    const open = tools.find((tool) => tool.name === 'open_search_result');
    await expect(open!.execute({
      resultKey: `sr_${'a'.repeat(32)}`,
      effect: 'view-state',
    })).resolves.toMatchObject({
      ok: false,
      status: 'denied',
      reason: 'malformed_arguments',
    });
  });
});
