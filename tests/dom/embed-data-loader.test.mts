import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmbedDataLoader, type EmbedMapSurface } from '@/embed/embed-data-loader';
import { fetchEmbedMapFrame } from '@/embed/embed-fetch';
import type { MapLayers } from '@/types';
import { classifyPublicEmbedFrameRequest } from '../../shared/embed-map-frame';
import { EMBED_REFRESH_MS, type EmbedLayerId } from '../../shared/embed-panels';
import type { EmbedMapFrameResponse } from '../../shared/embed-map-frame';

const NOW = 1_700_000_000_000;

interface RecordedMap extends EmbedMapSurface {
  earthquakes: unknown[][];
  naturalEvents: unknown[][];
  weather: unknown[][];
  ready: Map<string, boolean>;
  loading: string[];
  layers: MapLayers;
}

function recordingMap(): RecordedMap {
  const map: RecordedMap = {
    earthquakes: [],
    naturalEvents: [],
    weather: [],
    ready: new Map(),
    loading: [],
    layers: {} as MapLayers,
    setEarthquakes: (events) => { map.earthquakes.push(events); },
    setNaturalEvents: (events) => { map.naturalEvents.push(events); },
    setWeatherAlerts: (alerts) => { map.weather.push(alerts); },
    setLayerLoading: (layer, loading) => { map.loading.push(`${String(layer)}:${loading}`); },
    setLayerReady: (layer, ready) => { map.ready.set(String(layer), ready); },
    getState: () => ({ layers: map.layers }),
    setLayers: (layers) => { map.layers = layers; },
  };
  return map;
}

function frame(overrides: Partial<EmbedMapFrameResponse> = {}): EmbedMapFrameResponse {
  return {
    refreshMs: EMBED_REFRESH_MS,
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

  function captureUrl(): { urls: string[]; inits: (RequestInit | undefined)[] } {
    const urls: string[] = [];
    const inits: (RequestInit | undefined)[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      inits.push(init);
      return new Response(JSON.stringify(frame()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    return { urls, inits };
  }

  it('emits the URL the edge will shared-cache', async () => {
    // Builder and validator are the same module, so this proves the URL the
    // client actually sends is the one that gets a shared entry — the failure
    // mode is silent: a near-miss still renders, just never from cache.
    const { urls, inits } = captureUrl();
    await fetchEmbedMapFrame(['weather', 'earthquakes']);

    expect(urls[0]).toContain('?layers=earthquakes,weather&public=1');
    expect(classifyPublicEmbedFrameRequest(urls[0] as string)).toEqual(['earthquakes', 'weather']);
    expect(inits[0]?.credentials, 'a signed-in viewer never authenticates the embed').toBe('omit');
  });

  it('keeps every requested layer in the shared-cacheable URL', async () => {
    const { urls } = captureUrl();
    await fetchEmbedMapFrame(['weather', 'cables', 'pipelines']);

    expect(classifyPublicEmbedFrameRequest(urls[0] as string)).toEqual(['weather', 'cables', 'pipelines']);
  });

  it('surfaces a bounded retry delay for an unavailable map frame', async () => {
    vi.stubGlobal('fetch', async () => new Response('', {
      status: 503,
      headers: { 'Retry-After': '3600' },
    }));

    await expect(fetchEmbedMapFrame(['weather'])).rejects.toMatchObject({
      retryAfterMs: 60_000,
    });
  });
});

describe('embed data loader', () => {
  it('renders from one request and marks its layers ready', async () => {
    const map = recordingMap();
    const loader = new EmbedDataLoader(map, ['earthquakes', 'weather'], {
      fetchFrame: async () => frame(),
    });

    await loader.loadOnce();

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
    });

    await loader.loadOnce();

    expect(calls).toBe(1);
    expect([...requested]).toEqual(['earthquakes', 'weather', 'cables']);
  });

  it('keeps a partial layer on the map, and drops and clears an unavailable one', async () => {
    const map = recordingMap();
    map.layers = { natural: true, weather: true } as MapLayers;
    const loader = new EmbedDataLoader(map, ['earthquakes', 'weather'], {
      fetchFrame: async () => frame({
        layers: { earthquakes: 'partial', weather: 'unavailable' },
        data: { earthquakes: [{ id: 'q1' }] },
      }),
    });

    await loader.loadOnce();

    expect(map.ready.get('natural'), 'partial still has data on screen').toBe(true);
    expect(map.ready.get('weather')).toBe(false);
    expect(map.layers.weather).toBe(false);
    expect(map.weather[map.weather.length - 1]).toEqual([]);
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
    });

    await loader.loadOnce();
    await loader.loadOnce();

    expect(map.weather, 'no second render').toHaveLength(1);
    expect(map.ready.get('weather'), 'the layer stays marked ready').toBe(true);
    expect(map.loading[map.loading.length - 1], 'the loading flag still clears').toBe('weather:false');
  });
});
