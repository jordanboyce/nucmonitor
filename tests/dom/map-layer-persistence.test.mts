/**
 * The persistence proof behind the WebMCP cancellation gate (#7186, #7320).
 *
 * `WEBMCP_TOOL_CANCELLATION_POLICY` classifies `set_map_layers` as
 * 'cancellation-required', so it is refused outright when the browser cannot
 * deliver a target-side AbortSignal. `open_search_result` is result-dependent:
 * a persistent layer result is refused for the same reason, while a view-state
 * result is not. That justification rests on one concrete claim: applying a
 * map-layer change writes STORAGE_KEYS.mapLayers to local storage, so a
 * phantom completion outlives the session.
 *
 * `tests/webmcp*.test.mjs` stub the final action, so they prove the gate's
 * plumbing and never reach the write. The first tests run the real
 * `EventHandlerManager.applyMapLayerChange`; the final test issues and opens an
 * opaque result through the real WebMcpSearchController and
 * SearchSelectionDispatcher. Both paths use the real saveToStorage and the
 * real happy-dom localStorage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { EventHandlerManager } from '@/app/event-handlers';
import { SearchSelectionDispatcher } from '@/app/search-selection-dispatcher';
import { WebMcpSearchController } from '@/app/webmcp-search-controller';
import type { SearchMatch } from '@/components/search-types';
import { STORAGE_KEYS } from '@/config';
import { COMMANDS } from '@/config/commands';
import { saveToStorage } from '@/utils';

function createManager(mapLayers: Record<string, boolean>) {
  const container = document.createElement('div');
  document.body.append(container);
  return new EventHandlerManager({
    container,
    isDesktopApp: false,
    panels: {},
    panelSettings: {},
    mapLayers,
  } as never, {
    loadDataForLayer: vi.fn(),
    clearLayerData: vi.fn(),
  } as never);
}

describe('applyMapLayerChange persists map layers', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('writes the updated layer set to STORAGE_KEYS.mapLayers', () => {
    const mapLayers = { fires: false };
    const manager = createManager(mapLayers);

    expect(localStorage.getItem(STORAGE_KEYS.mapLayers)).toBeNull();

    manager.applyMapLayerChange('fires' as never, true, 'programmatic');

    // The stored value — not merely "storage was touched". A write of the
    // pre-change object, or of the wrong key, fails here.
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.mapLayers)!))
      .toStrictEqual({ fires: true });

    manager.destroy();
  });

  it('leaves the write behind after the invocation returns, with nothing to cancel', () => {
    // This is the property the gate exists for: the tool has no undo. Toggling
    // off writes again rather than restoring the pre-invocation storage state,
    // so an uncancellable invocation is not recoverable by putting the map back.
    const manager = createManager({ fires: true, outages: false });

    manager.applyMapLayerChange('outages' as never, true, 'programmatic');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.mapLayers)!))
      .toStrictEqual({ fires: true, outages: true });

    manager.applyMapLayerChange('outages' as never, false, 'programmatic');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.mapLayers)!))
      .toStrictEqual({ fires: true, outages: false });

    manager.destroy();
  });
});

describe('open_search_result persists an executable layer result', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
  });

  it('opens an issued layer command through the production dispatcher', async () => {
    const command = COMMANDS.find(({ id }) => id === 'layer:fires');
    if (!command) throw new Error('Expected the fires layer command');
    const match: SearchMatch = {
      kind: 'command',
      command,
      score: 1,
      title: command.label,
      subtitle: 'Map layer',
    };
    const closeForProgrammaticSelection = vi.fn();
    const modal = {
      search: vi.fn(() => ({ orderedMatches: [match] })),
      resolveMatchByIdentity: vi.fn(() => match),
      closeForProgrammaticSelection,
    };
    const mapLayers = { fires: false };
    const enableLayer = vi.fn();
    const dispatcher = new SearchSelectionDispatcher({
      ctx: {
        mapLayers,
        map: {
          isGlobeMode: () => false,
          isDeckGLActive: () => false,
          enableLayer,
        },
        panelSettings: {},
        newsPanels: {},
      } as never,
      getVariant: () => 'nuclear',
      enablePanel: vi.fn(() => true),
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
      isPanelCurrentlyEnabled: () => false,
      selectMatch: (candidate, signal) => dispatcher.selectProgrammaticMatch(
        candidate,
        () => candidate,
        signal,
      ),
      subscribeAuth: () => () => {},
      subscribeRuntimeConfig: () => () => {},
      cancelPendingSelection: () => dispatcher.cancelPendingProgrammaticSelection(),
    });

    const host = new AbortController();
    const response = await controller.search('fires', 'all', 10, host.signal);
    const issued = response.results[0];
    if (!issued) throw new Error('Expected an issued fires search result');
    expect(issued.executable).toBe(true);
    expect(localStorage.getItem(STORAGE_KEYS.mapLayers)).toBeNull();

    await expect(controller.open(issued.key, async () => {}, host.signal)).resolves.toStrictEqual({
      ok: true,
      status: 'opened',
      type: 'command',
    });
    expect(enableLayer).toHaveBeenCalledWith('fires');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.mapLayers)!))
      .toStrictEqual({ fires: true });
    expect(closeForProgrammaticSelection).toHaveBeenCalledOnce();

    controller.destroy();
    dispatcher.destroy();
  });
});
