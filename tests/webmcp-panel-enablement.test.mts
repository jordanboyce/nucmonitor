import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applySetPanelEnabled,
  isCatalogPanelLive,
  waitUntilPanelLive,
} from '../src/app/panel-enablement.ts';
import {
  ALL_PANELS,
  getInitialPanelSettingsForVariant,
  isPanelNativeToVariant,
} from '../src/config/panels.ts';
import {
  evaluateSetPanelEnabled,
} from '../src/config/panel-enablement.ts';
import type { PanelConfig } from '../src/types/index.ts';
import {
  buildWebMcpTools as buildProductionWebMcpTools,
} from '../src/services/webmcp.ts';

function cloneSettings(variant: string): Record<string, PanelConfig> {
  return structuredClone(getInitialPanelSettingsForVariant(variant));
}

function settingsWithFreeSlots(
  variant: string,
  extras: Record<string, Partial<PanelConfig>> = {},
): Record<string, PanelConfig> {
  const settings = cloneSettings(variant);
  let counted = 0;
  for (const [key, config] of Object.entries(settings)) {
    if (key === 'map') continue;
    if (counted < 5 && config.enabled) {
      counted += 1;
      continue;
    }
    config.enabled = false;
  }
  for (const [key, patch] of Object.entries(extras)) {
    settings[key] = { ...settings[key]!, ...patch };
  }
  return settings;
}

function evaluate(overrides: {
  panelId?: unknown;
  enabled?: unknown;
  panelSettings?: Record<string, PanelConfig>;
  variant?: string;
}) {
  const variant = overrides.variant ?? 'nuclear';
  return evaluateSetPanelEnabled({
    panelId: overrides.panelId ?? 'world-clock',
    enabled: overrides.enabled ?? true,
    panelSettings: overrides.panelSettings ?? cloneSettings(variant),
    variant,
  });
}

describe('isPanelNativeToVariant', () => {
  it('treats catalog keys as native only to the monitors that define them', () => {
    assert.equal(isPanelNativeToVariant('nuclear-reactor-status', 'nuclear'), true);
    assert.equal(isPanelNativeToVariant('world-clock', 'nuclear'), true);
    // A persisted upstream variant id owns no panels.
    assert.equal(isPanelNativeToVariant('nuclear-reactor-status', 'full'), false);
    assert.equal(isPanelNativeToVariant('markets', 'nuclear'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(ALL_PANELS, 'nuclear-reactor-status'), true);
  });
});

describe('evaluateSetPanelEnabled', () => {
  it('keeps catalog lookup case-sensitive instead of normalizing IDs', () => {
    // No mixed-case IDs remain in the catalog, so the guard is that a
    // differently-cased spelling of a real panel is not folded onto it.
    const exact = evaluate({ panelId: 'nuclear-headlines', enabled: false });
    assert.equal(exact.ok, true);
    assert.equal(exact.panelId, 'nuclear-headlines');
    const folded = evaluate({ panelId: 'Nuclear-Headlines', enabled: false });
    assert.equal(folded.ok, false);
    assert.equal(folded.reason, 'unknown_panel');
  });

  it('enables a native disabled panel', () => {
    const panelSettings = settingsWithFreeSlots('nuclear');
    assert.equal(panelSettings['world-clock']?.enabled, false);
    const result = evaluate({ panelSettings, panelId: 'world-clock', enabled: true });
    assert.deepEqual(result, {
      ok: true,
      status: 'applied',
      panelId: 'world-clock',
      requestedEnabled: true,
      effectiveEnabled: true,
      changed: true,
      message: 'Panel enabled.',
    });
  });

  it('disables a native enabled panel', () => {
    const panelSettings = cloneSettings('nuclear');
    assert.equal(panelSettings['nuclear-headlines']?.enabled, true);
    const result = evaluate({ panelSettings, panelId: 'nuclear-headlines', enabled: false });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'applied');
    assert.equal(result.changed, true);
    assert.equal(result.effectiveEnabled, false);
    assert.equal(result.requestedEnabled, false);
    assert.equal(result.message, 'Panel disabled.');
  });

  it('treats repeats as success with no change', () => {
    const panelSettings = cloneSettings('nuclear');
    panelSettings['world-clock']!.enabled = false;
    const stillOff = evaluate({
      panelSettings,
      panelId: 'world-clock',
      enabled: false,
    });
    assert.equal(stillOff.ok, true);
    assert.equal(stillOff.changed, false);
    assert.equal(stillOff.effectiveEnabled, false);
    assert.equal(stillOff.message, 'Panel already disabled.');

    const stillOn = evaluate({
      panelSettings,
      panelId: 'nuclear-headlines',
      enabled: true,
    });
    assert.equal(stillOn.ok, true);
    assert.equal(stillOn.changed, false);
    assert.equal(stillOn.effectiveEnabled, true);
    assert.equal(stillOn.message, 'Panel already enabled.');
  });

  it('no-ops a cross-variant panel that is already in the requested state', () => {
    // 'full' stands in for a persisted upstream monitor id that owns no panels.
    const panelSettings = cloneSettings('full');
    panelSettings['nuclear-reactor-status'] = {
      ...panelSettings['nuclear-reactor-status']!,
      enabled: true,
    };
    const result = evaluate({
      variant: 'full',
      panelSettings,
      panelId: 'nuclear-reactor-status',
      enabled: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(result.reason, undefined);
  });

  it('refuses to enable a panel that is not native to the current monitor', () => {
    const panelSettings = cloneSettings('full');
    panelSettings['nuclear-reactor-status']!.enabled = false;
    const full = evaluate({
      variant: 'full',
      panelSettings,
      panelId: 'nuclear-reactor-status',
      enabled: true,
    });
    assert.equal(full.ok, false);
    assert.equal(full.status, 'denied');
    assert.equal(full.reason, 'panel_incompatible');
    assert.equal(full.changed, false);
    assert.equal(full.effectiveEnabled, false);
  });

  it('allows disabling a non-native panel that is currently enabled', () => {
    const panelSettings = cloneSettings('full');
    panelSettings['nuclear-reactor-status'] = {
      ...panelSettings['nuclear-reactor-status']!,
      enabled: true,
    };
    const result = evaluate({
      variant: 'full',
      panelSettings,
      panelId: 'nuclear-reactor-status',
      enabled: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.effectiveEnabled, false);
  });

  it('rejects unknown, runtime, and malformed identifiers before mutation policy', () => {
    assert.equal(evaluate({ panelId: 'not-a-real-panel' }).reason, 'unknown_panel');
    assert.equal(evaluate({ panelId: 'cw-custom-1' }).reason, 'unknown_panel');
    assert.equal(evaluate({ panelId: 'mcp-remote-1' }).reason, 'unknown_panel');
    assert.equal(evaluate({ panelId: 'Nuclear-Events' }).reason, 'unknown_panel');
    assert.equal(evaluate({ panelId: '.nuclear-events' }).reason, 'malformed_arguments');
    assert.equal(evaluate({ panelId: 'a'.repeat(97) }).reason, 'malformed_arguments');
    assert.equal(evaluate({ panelId: 12 }).reason, 'malformed_arguments');
    assert.equal(evaluate({ enabled: 'true' }).reason, 'malformed_arguments');
    assert.equal(evaluate({ panelId: 'Nuclear-Events' }).status, 'denied');
  });

  it('treats a catalog panel missing from settings as currently disabled', () => {
    const panelSettings = settingsWithFreeSlots('nuclear');
    delete panelSettings['world-clock'];
    const result = evaluate({ panelSettings, panelId: 'world-clock', enabled: true });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.effectiveEnabled, true);
  });

});

describe('applySetPanelEnabled', () => {
  it('runs beforeApply only after a changed enable persists', () => {
    const events: string[] = [];
    const panelSettings = settingsWithFreeSlots('nuclear');
    const result = applySetPanelEnabled(
      { panelSettings },
      'world-clock',
      true,
      {
        variant: 'nuclear',
        persist: () => { events.push('persist'); },
        trackToggle: () => { events.push('track'); },
        beforeApply: () => { events.push('beforeApply'); },
        applyPanelSettings: () => { events.push('apply'); },
      },
    );
    assert.equal(result.changed, true);
    assert.deepEqual(events, ['persist', 'track', 'beforeApply', 'apply']);

    events.length = 0;
    applySetPanelEnabled(
      { panelSettings },
      'world-clock',
      true,
      {
        variant: 'nuclear',
        persist: () => { events.push('persist'); },
        trackToggle: () => { events.push('track'); },
        beforeApply: () => { events.push('beforeApply'); },
        applyPanelSettings: () => { events.push('apply'); },
      },
    );
    assert.deepEqual(events, [], 'an unchanged enable must not arm suppression');
  });

  it('does not run beforeApply when persistence fails', () => {
    let beforeApplyCount = 0;
    const result = applySetPanelEnabled(
      { panelSettings: settingsWithFreeSlots('nuclear') },
      'world-clock',
      true,
      {
        variant: 'nuclear',
        persist: () => false,
        trackToggle: () => {},
        beforeApply: () => { beforeApplyCount += 1; },
        applyPanelSettings: () => {},
      },
    );
    assert.equal(result.reason, 'persist_failed');
    assert.equal(beforeApplyCount, 0);
  });

  it('persists an enable through the same user-set path and skips persist on no-op', () => {
    const panelSettings = settingsWithFreeSlots('nuclear');
    const persistCalls: Record<string, PanelConfig>[] = [];
    let applyCount = 0;
    let toggleCount = 0;
    let fetchCount = 0;
    let refreshCount = 0;
    const deps = {
      variant: 'nuclear',
      persist: (settings: Record<string, PanelConfig>) => {
        persistCalls.push(structuredClone(settings));
      },
      applyPanelSettings: () => {
        applyCount += 1;
      },
      trackToggle: () => {
        toggleCount += 1;
      },
    };
    const panels = {
      'world-clock': { fetchData: () => { fetchCount += 1; } },
    };
    const unifiedSettings = {
      refreshPanelToggles: () => {
        refreshCount += 1;
      },
    };

    const first = applySetPanelEnabled(
      { panelSettings, panels, unifiedSettings },
      'world-clock',
      true,
      deps,
    );
    assert.equal(first.changed, true);
    assert.equal(panelSettings['world-clock']?.enabled, true);
    assert.equal(panelSettings['world-clock']?.proGated, undefined);
    assert.equal(persistCalls.length, 1);
    assert.equal(persistCalls[0]?.['world-clock']?.enabled, true);
    assert.equal(applyCount, 1);
    assert.equal(toggleCount, 1);
    assert.equal(fetchCount, 1);
    assert.equal(refreshCount, 1);

    const repeat = applySetPanelEnabled(
      { panelSettings, panels, unifiedSettings },
      'world-clock',
      true,
      deps,
    );
    assert.equal(repeat.changed, false);
    assert.equal(persistCalls.length, 1);
    assert.equal(applyCount, 1);
    assert.equal(toggleCount, 1);
    assert.equal(fetchCount, 1);
    assert.equal(refreshCount, 1);
  });

  it('still returns applied when fetchData throws or rejects after persist', async () => {
    const panelSettings = settingsWithFreeSlots('nuclear');
    let persistCount = 0;
    const deps = {
      variant: 'nuclear',
      persist: () => {
        persistCount += 1;
      },
      applyPanelSettings: () => {},
      trackToggle: () => {},
    };
    const thrown = applySetPanelEnabled(
      {
        panelSettings,
        panels: {
          'world-clock': {
            fetchData: () => {
              throw new Error('fetch failed');
            },
          },
        },
      },
      'world-clock',
      true,
      deps,
    );
    assert.equal(thrown.ok, true);
    assert.equal(thrown.changed, true);
    assert.equal(persistCount, 1);

    panelSettings['world-clock']!.enabled = false;
    const rejected = applySetPanelEnabled(
      {
        panelSettings,
        panels: {
          'world-clock': {
            fetchData: () => Promise.reject(new Error('async fetch failed')),
          },
        },
      },
      'world-clock',
      true,
      deps,
    );
    assert.equal(rejected.ok, true);
    assert.equal(rejected.changed, true);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('persists a disable without deleting the catalog entry', () => {
    const panelSettings = cloneSettings('nuclear');
    const persistCalls: Record<string, PanelConfig>[] = [];
    const result = applySetPanelEnabled(
      { panelSettings },
      'nuclear-headlines',
      false,
      {
        variant: 'nuclear',
        persist: (settings) => persistCalls.push(structuredClone(settings)),
        applyPanelSettings: () => {},
        trackToggle: () => {},
      },
    );
    assert.equal(result.changed, true);
    assert.equal(panelSettings['nuclear-headlines']?.enabled, false);
    assert.ok(Object.prototype.hasOwnProperty.call(panelSettings, 'nuclear-headlines'));
    assert.equal(persistCalls.length, 1);
  });

  it('fails closed before changing live state when persistence fails', () => {
    const panelSettings = settingsWithFreeSlots('nuclear');
    let applyCount = 0;
    let toggleCount = 0;
    const result = applySetPanelEnabled(
      { panelSettings },
      'world-clock',
      true,
      {
        variant: 'nuclear',
        persist: () => false,
        applyPanelSettings: () => { applyCount += 1; },
        trackToggle: () => { toggleCount += 1; },
      },
    );

    assert.deepEqual(result, {
      ok: false,
      status: 'denied',
      panelId: 'world-clock',
      requestedEnabled: true,
      effectiveEnabled: false,
      changed: false,
      reason: 'persist_failed',
      message: 'Dashboard panel change could not be saved.',
    });
    assert.equal(panelSettings['world-clock']?.enabled, false);
    assert.equal(applyCount, 0);
    assert.equal(toggleCount, 0);
  });

});

describe('set_panel_enabled WebMCP adapter', () => {
  it('rejects extra keys and missing cancellation before the binding', async () => {
    let calls = 0;
    const tools = buildProductionWebMcpTools({
      openCountryBriefByCode: async () => true,
      resolveCountryName: (code: string) => `Country ${code}`,
      openSearch: async () => true,
      getDashboardContext: async () => ({
        variant: 'full',
        map: {
          view: 'global',
          center: { lat: 0, lon: 0 },
          zoom: 2,
          timeRange: '7d',
          enabledLayers: [],
        },
        panels: { mounted: ['map'], enabled: ['map'] },
      }),
      applyDashboardAction: async (action: { type: string }) => ({
        ok: true,
        status: 'applied' as const,
        actionType: action.type as 'open_panel',
        message: 'Applied.',
        targets: [],
      }),
      searchDashboard: async (query: string) => ({
        queryLength: query.length,
        results: [],
        resultCount: 0,
        truncated: false,
      }),
      openSearchResult: async () => ({ ok: true, status: 'opened' as const }),
      setPanelEnabled: async () => {
        calls += 1;
        return {
          ok: true,
          status: 'applied' as const,
          panelId: 'giving',
          requestedEnabled: true,
          effectiveEnabled: true,
          changed: true,
          message: 'Panel enabled.',
        };
      },
    }, () => {});
    const tool = tools.find((candidate) => candidate.name === 'set_panel_enabled');
    assert.ok(tool);
    const schema = tool.inputSchema as { properties: { panelId: { pattern: string } } };
    assert.ok(new RegExp(schema.properties.panelId.pattern).test('gccNews'));
    assert.ok(new RegExp(schema.properties.panelId.pattern).test('regionalStartups'));

    const extraKeys = await tool.execute(
      { panelId: 'giving', enabled: true, selector: '#giving' },
      { signal: new AbortController().signal },
    );
    assert.equal((extraKeys as { reason?: string }).reason, 'malformed_arguments');
    assert.equal((extraKeys as { status?: string }).status, 'invalid');
    assert.equal(calls, 0);

    const noSignal = await tool.execute({ panelId: 'giving', enabled: true });
    assert.equal((noSignal as { reason?: string }).reason, 'target_cancellation_unsupported');
    assert.equal(calls, 0);

    const applied = await tool.execute(
      { panelId: 'giving', enabled: true },
      { signal: new AbortController().signal },
    );
    assert.equal((applied as { ok?: boolean }).ok, true);
    assert.equal(calls, 1);
  });

});

describe('waitUntilPanelLive', () => {
  it('does not treat a registered but disconnected instance as live', () => {
    assert.equal(isCatalogPanelLive('giving', { giving: {} }), false);
    assert.equal(
      isCatalogPanelLive('giving', { giving: { getElement: () => ({ isConnected: false }) } }),
      false,
    );
    assert.equal(isCatalogPanelLive('giving', {}), false);
  });

  it('treats a connected panel instance as live', () => {
    assert.equal(
      isCatalogPanelLive('giving', { giving: { getElement: () => ({ isConnected: true }) } }),
      true,
    );
  });

  it('treats a connected non-deferred data-panel node as live', () => {
    const previousDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = {
      querySelector: (selector: string) => {
        if (selector.includes('[data-panel="giving"]') && selector.includes(':not([data-deferred-panel])')) {
          return { isConnected: true };
        }
        return null;
      },
    };
    try {
      assert.equal(isCatalogPanelLive('giving', {}), true);
      assert.equal(
        isCatalogPanelLive('giving', { giving: { getElement: () => ({ isConnected: false }) } }),
        true,
      );
    } finally {
      if (previousDocument === undefined) {
        Reflect.deleteProperty(globalThis, 'document');
      } else {
        (globalThis as { document?: unknown }).document = previousDocument;
      }
    }
  });

  it('resolves immediately when the panel is already live', async () => {
    const outcome = await waitUntilPanelLive({
      isLive: () => true,
      timeoutMs: 50,
      observe: () => () => {},
    });
    assert.equal(outcome, 'live');
  });

  it('resolves live when the panel appears before timeout', async () => {
    let live = false;
    let notify = (): void => {};
    const pending = waitUntilPanelLive({
      isLive: () => live,
      timeoutMs: 500,
      observe: (onChange) => {
        notify = onChange;
        return () => {};
      },
    });
    await Promise.resolve();
    live = true;
    notify();
    assert.equal(await pending, 'live');
  });

  it('times out without throwing when the panel never appears', async () => {
    const outcome = await waitUntilPanelLive({
      isLive: () => false,
      timeoutMs: 20,
      observe: () => () => {},
    });
    assert.equal(outcome, 'timeout');
  });

  it('rejects when the invocation is aborted during the wait', async () => {
    const controller = new AbortController();
    const pending = waitUntilPanelLive({
      isLive: () => false,
      signal: controller.signal,
      timeoutMs: 1_000,
      observe: () => () => {},
    });
    controller.abort();
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
  });

  it('enable-then-destroy disconnects the observer and clears the timeout immediately', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const armed = new Set<ReturnType<typeof setTimeout>>();
    let stopCount = 0;
    let live = false;
    let notify = (): void => {};

    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      const id = realSetTimeout(handler, timeout, ...args);
      armed.add(id);
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
      armed.delete(id as ReturnType<typeof setTimeout>);
      realClearTimeout(id);
    }) as typeof clearTimeout;

    const lifecycle = new AbortController();
    try {
      const pending = waitUntilPanelLive({
        isLive: () => live,
        signal: lifecycle.signal,
        timeoutMs: 30_000,
        observe: (onChange) => {
          notify = onChange;
          return () => {
            stopCount += 1;
          };
        },
      });
      await Promise.resolve();
      assert.equal(armed.size, 1, 'live wait must arm the timeout before destroy');
      assert.equal(stopCount, 0);

      // App.destroy() aborts the lifecycle signal; the waiter must settle and
      // drop both the MutationObserver and the 30s timer before replacement
      // DOM can look live.
      lifecycle.abort();
      await assert.rejects(pending, (error: Error) => error.name === 'AbortError');
      assert.equal(stopCount, 1, 'observer must disconnect on destroy');
      assert.equal(armed.size, 0, 'timeout must clear on destroy');

      live = true;
      notify();
      await Promise.resolve();
      assert.equal(stopCount, 1, 'late mutations must not re-arm or re-stop the observer');
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});
