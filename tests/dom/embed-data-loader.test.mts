import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbedDataLoader, type EmbedMapSurface } from '@/embed/embed-data-loader';
import {
  EmbedMapFrameUnavailableError,
  fetchEmbedMapFrame,
  mintEmbedGrant,
  type EmbedGrant,
  type EmbedGrantResult,
} from '@/embed/embed-fetch';
import type { MapLayers } from '@/types';
import { classifyPublicEmbedFrameRequest } from '../../shared/embed-map-frame';
import {
  EMBED_FREE_REFRESH_MS,
  EMBED_KEYED_REFRESH_MS,
  type EmbedLayerId,
} from '../../shared/embed-panels';
import type { EmbedMapFrameResponse } from '../../shared/embed-map-frame';

const NOW = 1_700_000_000_000;

interface RecordedMap extends EmbedMapSurface {
  earthquakes: unknown[][];
  naturalEvents: unknown[][];
  weather: unknown[][];
  ready: Map<string, boolean>;
  loading: string[];
  layers: MapLayers;
  bypassEntitlementSanitization: boolean;
}

function recordingMap(): RecordedMap {
  const map: RecordedMap = {
    earthquakes: [],
    naturalEvents: [],
    weather: [],
    ready: new Map(),
    loading: [],
    layers: {} as MapLayers,
    bypassEntitlementSanitization: false,
    setEarthquakes: (events) => { map.earthquakes.push(events); },
    setNaturalEvents: (events) => { map.naturalEvents.push(events); },
    setWeatherAlerts: (alerts) => { map.weather.push(alerts); },
    setLayerLoading: (layer, loading) => { map.loading.push(`${String(layer)}:${loading}`); },
    setLayerReady: (layer, ready) => { map.ready.set(String(layer), ready); },
    getState: () => ({ layers: map.layers }),
    setLayers: (layers, options) => {
      map.layers = layers;
      map.bypassEntitlementSanitization = options?.bypassEntitlementSanitization === true;
    },
  };
  return map;
}

function frame(overrides: Partial<EmbedMapFrameResponse> = {}): EmbedMapFrameResponse {
  return {
    tier: 'free',
    refreshMs: EMBED_FREE_REFRESH_MS,
    generatedAt: NOW,
    layers: { earthquakes: 'ok', weather: 'ok' },
    data: {
      earthquakes: [{ id: 'q1' }],
      naturalEvents: [],
      weatherAlerts: [weatherAlert()],
    },
    ...overrides,
  };
}

function grant(expiresAt: number): EmbedGrant {
  return { token: 'wmg_test', expiresAt };
}

/** A wire-shaped NWS alert, as the composed frame carries it. */
function weatherAlert() {
  return {
    id: 'w1',
    event: 'Flood Warning',
    severity: 'Severe',
    headline: 'Flood Warning',
    description: '',
    areaDesc: 'Test County',
    onset: new Date(NOW).toISOString(),
    expires: new Date(NOW + 3_600_000).toISOString(),
    coordinates: [[-90, 30], [-89, 30], [-89, 31], [-90, 30]],
    centroid: [-89.5, 30.5],
  };
}

describe('embed map frame request', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function captureUrl(): { urls: string[]; headers: Record<string, string>[] } {
    const urls: string[] = [];
    const headers: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return new Response(JSON.stringify(frame()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return { urls, headers };
  }

  it('emits a keyless URL the edge will shared-cache', async () => {
    // Builder and validator are the same module, so this proves the URL the
    // client actually sends is the one that gets a shared entry — the failure
    // mode is silent: a near-miss still renders, just never from cache.
    const { urls, headers } = captureUrl();
    await fetchEmbedMapFrame(['weather', 'earthquakes'], null);

    expect(urls[0]).toContain('?layers=earthquakes,weather&public=1');
    expect(classifyPublicEmbedFrameRequest(urls[0] as string)).toEqual(['earthquakes', 'weather']);
    expect(headers[0]).not.toHaveProperty('X-WorldMonitor-Grant');
  });

  it('drops paid layers from the keyless URL instead of fragmenting the key space', async () => {
    const { urls } = captureUrl();
    await fetchEmbedMapFrame(['weather', 'cables', 'pipelines'], null);

    expect(urls[0]).toContain('?layers=weather&public=1');
    expect(classifyPublicEmbedFrameRequest(urls[0] as string)).toEqual(['weather']);
  });

  it('sends the grant on a URL that can never be shared-cached', async () => {
    const { urls, headers } = captureUrl();
    await fetchEmbedMapFrame(['weather', 'cables'], { token: 'wmg_x', expiresAt: NOW });

    expect(headers[0]).toMatchObject({ 'X-WorldMonitor-Grant': 'wmg_x' });
    expect(urls[0]).not.toContain('public=1');
    expect(
      classifyPublicEmbedFrameRequest(urls[0] as string),
      'a credentialed URL must never match the shared shape',
    ).toBeNull();
  });

  it('keeps rate limits and server failures retryable', async () => {
    vi.stubGlobal('fetch', async () => new Response('', {
      status: 429,
      headers: { 'Retry-After': '7' },
    }));
    await expect(mintEmbedGrant('map', 'wme_test')).resolves.toEqual({
      status: 'unavailable',
      retryAfterMs: 7_000,
    });

    vi.stubGlobal('fetch', async () => new Response('', { status: 500 }));
    await expect(mintEmbedGrant('map', 'wme_test')).resolves.toEqual({
      status: 'unavailable',
      retryAfterMs: 60_000,
    });
  });

  it('surfaces a bounded retry delay for an unavailable map frame', async () => {
    vi.stubGlobal('fetch', async () => new Response('', {
      status: 503,
      headers: { 'Retry-After': '3600' },
    }));

    await expect(fetchEmbedMapFrame(['weather'], grant(NOW + 30 * 60_000))).rejects.toMatchObject({
      retryAfterMs: 60_000,
    });
  });
});

describe('embed data loader', () => {
  it('renders the free tier from one request and marks its layers ready', async () => {
    const map = recordingMap();
    const seen: (EmbedGrant | null)[] = [];
    const loader = new EmbedDataLoader(map, ['earthquakes', 'weather'], {
      fetchFrame: async (_layers, g) => { seen.push(g); return frame(); },
      now: () => NOW,
    });

    await loader.loadOnce();

    expect(seen, 'a keyless frame sends no grant').toEqual([null]);
    expect(map.earthquakes).toEqual([[{ id: 'q1' }]]);
    expect(map.weather).toHaveLength(1);
    expect(map.ready.get('natural')).toBe(true);
    expect(map.ready.get('weather')).toBe(true);
  });

  it('requests every active layer in one call, not one call per layer', async () => {
    const map = recordingMap();
    let calls = 0;
    let requested: readonly EmbedLayerId[] = [];
    const loader = new EmbedDataLoader(map, ['earthquakes', 'weather', 'cables'], {
      fetchFrame: async (layers) => {
        calls += 1;
        requested = layers;
        return frame({ layers: { earthquakes: 'ok', weather: 'ok', cables: 'ok' } });
      },
      now: () => NOW,
    });

    await loader.loadOnce();

    expect(calls).toBe(1);
    expect([...requested]).toEqual(['earthquakes', 'weather', 'cables']);
  });

  it('disables a rejected layer and clears its cached live data', async () => {
    const map = recordingMap();
    map.layers = { natural: true, weather: true } as MapLayers;
    let request = 0;
    const loader = new EmbedDataLoader(map, ['earthquakes', 'weather'], {
      fetchFrame: async () => {
        request += 1;
        return request === 1
          ? frame({
            layers: { earthquakes: 'ok', weather: 'ok' },
            data: { earthquakes: [{ id: 'q1' }], weatherAlerts: [weatherAlert()] },
          })
          : frame({
            layers: { earthquakes: 'ok', weather: 'not-entitled' },
            data: { earthquakes: [{ id: 'q1' }] },
          });
      },
      now: () => NOW,
    });

    await loader.loadOnce();
    await loader.loadOnce();

    expect(map.ready.get('natural')).toBe(true);
    expect(map.ready.get('weather')).toBe(false);
    expect(map.layers.weather).toBe(false);
    expect(map.bypassEntitlementSanitization).toBe(true);
    expect(map.weather).toHaveLength(2);
    expect(map.weather[map.weather.length - 1]).toEqual([]);
  });

  it('keeps a partial layer on the map and drops an unavailable one', async () => {
    const map = recordingMap();
    const loader = new EmbedDataLoader(map, ['earthquakes', 'weather'], {
      fetchFrame: async () => frame({
        layers: { earthquakes: 'partial', weather: 'unavailable' },
        data: { earthquakes: [{ id: 'q1' }] },
      }),
      now: () => NOW,
    });

    await loader.loadOnce();

    expect(map.ready.get('natural'), 'partial still has data on screen').toBe(true);
    expect(map.ready.get('weather')).toBe(false);
  });

  it('leaves the previous frame up when a poll fails outright', async () => {
    const map = recordingMap();
    let attempt = 0;
    const loader = new EmbedDataLoader(map, ['weather'], {
      fetchFrame: async () => {
        attempt += 1;
        if (attempt === 1) return frame({ layers: { weather: 'ok' } });
        throw new Error('network down');
      },
      now: () => NOW,
    });

    await loader.loadOnce();
    await loader.loadOnce();

    expect(map.weather, 'no second render').toHaveLength(1);
    expect(map.ready.get('weather'), 'the layer stays marked ready').toBe(true);
    expect(map.loading[map.loading.length - 1], 'the loading flag still clears').toBe('weather:false');
  });

  it('keeps a paid frame and retries a retryable frame failure before the free cadence', async () => {
    vi.useFakeTimers();
    try {
      const map = recordingMap();
      let attempts = 0;
      const loader = new EmbedDataLoader(map, ['weather'], {
        fetchFrame: async () => {
          attempts += 1;
          if (attempts === 1) return frame({ tier: 'keyed', refreshMs: EMBED_KEYED_REFRESH_MS });
          if (attempts === 2) throw new EmbedMapFrameUnavailableError(10_000);
          return frame({ tier: 'keyed', refreshMs: EMBED_KEYED_REFRESH_MS });
        },
        now: () => NOW,
      });

      await loader.upgrade(grant(NOW + 30 * 60_000));
      await loader.loadOnce();
      expect(attempts).toBe(2);
      expect(map.ready.get('weather')).toBe(true);

      await vi.advanceTimersByTimeAsync(9_999);
      expect(attempts).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(3);
      loader.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('upgrades in place: the grant reaches the next request and unlocks the paid layer', async () => {
    const map = recordingMap();
    const seen: (EmbedGrant | null)[] = [];
    const loader = new EmbedDataLoader(map, ['weather', 'cables'], {
      fetchFrame: async (_layers, g) => {
        seen.push(g);
        return g
          ? frame({
            tier: 'keyed',
            refreshMs: EMBED_KEYED_REFRESH_MS,
            layers: { weather: 'ok', cables: 'ok' },
            data: { weatherAlerts: [] },
          })
          : frame({ layers: { weather: 'ok', cables: 'not-entitled' }, data: { weatherAlerts: [] } });
      },
      now: () => NOW,
    });

    await loader.loadOnce();
    expect(map.ready.get('cables')).toBe(false);

    await loader.upgrade(grant(NOW + 30 * 60_000));
    loader.destroy();

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeNull();
    expect(seen[1]?.token).toBe('wmg_test');
    expect(map.ready.get('cables'), 'the paid layer appears after the upgrade').toBe(true);
  });

  it('takes its cadence from the response rather than a client constant', async () => {
    const map = recordingMap();
    const cadences: number[] = [];
    const loader = new EmbedDataLoader(map, ['weather'], {
      fetchFrame: async (_layers, g) => {
        const next = g
          ? frame({ tier: 'keyed', refreshMs: EMBED_KEYED_REFRESH_MS, layers: { weather: 'ok' } })
          : frame({ layers: { weather: 'ok' } });
        cadences.push(next.refreshMs);
        return next;
      },
      now: () => NOW,
    });

    await loader.loadOnce();
    await loader.upgrade(grant(NOW + 30 * 60_000));
    loader.destroy();

    expect(EMBED_FREE_REFRESH_MS).not.toBe(EMBED_KEYED_REFRESH_MS);
    expect(cadences).toEqual([EMBED_FREE_REFRESH_MS, EMBED_KEYED_REFRESH_MS]);
  });

  it('retries an unavailable initial grant exchange after its advertised delay', async () => {
    vi.useFakeTimers();
    try {
      const map = recordingMap();
      let renewals = 0;
      const loader = new EmbedDataLoader(map, ['weather'], {
        fetchFrame: async () => frame({ layers: { weather: 'ok' } }),
        renewGrant: async (): Promise<EmbedGrantResult> => {
          renewals += 1;
          return renewals === 1
            ? { status: 'unavailable', retryAfterMs: 10_000 }
            : { status: 'granted', grant: grant(NOW + 30 * 60_000) };
        },
        now: () => NOW,
      });

      await loader.requestGrant();
      expect(renewals).toBe(1);
      expect(loader.currentGrant()).toBeNull();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(renewals).toBe(2);
      expect(loader.currentGrant()?.token).toBe('wmg_test');
      loader.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('grant renewal', () => {
    it('re-mints before expiry and polls with the fresh grant', async () => {
      const map = recordingMap();
      const seen: (EmbedGrant | null)[] = [];
      let renewals = 0;
      const loader = new EmbedDataLoader(map, ['weather'], {
        fetchFrame: async (_layers, g) => { seen.push(g); return frame({ layers: { weather: 'ok' } }); },
        renewGrant: async (): Promise<EmbedGrantResult> => {
          renewals += 1;
          return { status: 'granted', grant: { token: 'wmg_fresh', expiresAt: NOW + 30 * 60_000 } };
        },
        now: () => NOW,
      });

      // Expires in 30s — inside the renewal skew.
      await loader.upgrade(grant(NOW + 30_000));
      loader.destroy();
      await loader.loadOnce();

      expect(renewals).toBe(1);
      expect(seen[seen.length - 1]?.token).toBe('wmg_fresh');
    });

    it('holds the last frame rather than downgrading when renewal is unavailable', async () => {
      const map = recordingMap();
      let polls = 0;
      let clock = NOW;
      const loader = new EmbedDataLoader(map, ['weather', 'cables'], {
        fetchFrame: async () => {
          polls += 1;
          return frame({
            tier: 'keyed',
            layers: { weather: 'ok', cables: 'ok' },
            data: { weatherAlerts: [] },
          });
        },
        renewGrant: async (): Promise<EmbedGrantResult> => ({ status: 'unavailable', retryAfterMs: 60_000 }),
        now: () => clock,
      });

      // A paid frame is on screen and rendering every requested layer.
      await loader.upgrade(grant(NOW + 30 * 60_000));
      loader.destroy();
      expect(map.ready.get('cables')).toBe(true);
      const pollsWhileEntitled = polls;

      // The grant lapses and the billing lookup cannot be reached.
      clock = NOW + 31 * 60_000;
      await loader.loadOnce();

      expect(polls, 'the poll is skipped, not downgraded').toBe(pollsWhileEntitled);
      expect(
        map.ready.get('cables'),
        'the paid layer stays on screen through a transient billing outage',
      ).toBe(true);
    });

    it('does not renew again before an unavailable response permits it', async () => {
      const map = recordingMap();
      let clock = NOW;
      let renewals = 0;
      const loader = new EmbedDataLoader(map, ['weather'], {
        fetchFrame: async () => frame({ layers: { weather: 'ok' } }),
        renewGrant: async (): Promise<EmbedGrantResult> => {
          renewals += 1;
          return renewals === 1
            ? { status: 'unavailable', retryAfterMs: 10_000 }
            : { status: 'granted', grant: grant(NOW + 30 * 60_000) };
        },
        now: () => clock,
      });

      await loader.upgrade(grant(NOW + 30_000));
      clock = NOW + 9_999;
      await loader.loadOnce();
      expect(renewals).toBe(1);

      clock = NOW + 10_000;
      await loader.loadOnce();
      expect(renewals).toBe(2);
    });

    it('falls back to the free tier when renewal is terminally denied', async () => {
      const map = recordingMap();
      const seen: (EmbedGrant | null)[] = [];
      const loader = new EmbedDataLoader(map, ['weather', 'cables'], {
        fetchFrame: async (_layers, g) => {
          seen.push(g);
          return g
            ? frame({ tier: 'keyed', layers: { weather: 'ok', cables: 'ok' }, data: { weatherAlerts: [] } })
            : frame({ layers: { weather: 'ok', cables: 'not-entitled' }, data: { weatherAlerts: [] } });
        },
        renewGrant: async (): Promise<EmbedGrantResult> => ({ status: 'denied' }),
        now: () => NOW,
      });

      await loader.upgrade(grant(NOW - 1));
      loader.destroy();
      await loader.loadOnce();

      expect(seen[seen.length - 1], 'a lapsed account polls as keyless').toBeNull();
      expect(loader.currentGrant()).toBeNull();
      expect(map.ready.get('cables')).toBe(false);
    });

    it('does not re-mint a grant that is still comfortably valid', async () => {
      const map = recordingMap();
      let renewals = 0;
      const loader = new EmbedDataLoader(map, ['weather'], {
        fetchFrame: async () => frame({ layers: { weather: 'ok' } }),
        renewGrant: async (): Promise<EmbedGrantResult> => {
          renewals += 1;
          return { status: 'granted', grant: grant(NOW + 30 * 60_000) };
        },
        now: () => NOW,
      });

      await loader.upgrade(grant(NOW + 25 * 60_000));
      loader.destroy();
      await loader.loadOnce();

      expect(renewals).toBe(0);
    });
  });
});
