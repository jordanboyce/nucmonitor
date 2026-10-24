/**
 * Composes the embed map frame from the domain handlers the equivalent RPCs
 * already use, so this endpoint is a fan-out over one data path rather than a
 * second implementation of it.
 *
 * The request carries `layers` and nothing else — no bbox, no page size, no
 * time window — so a public, shared-cacheable endpoint has no knob that could
 * widen its upstream cost. Each upstream is called with its own defaults.
 */

import {
  EMBED_LAYER_IDS,
  EMBED_REFRESH_MS,
  isEmbedLayerId,
  type EmbedLayerId,
} from '../../shared/embed-panels';
import type {
  EmbedMapFrameData,
  EmbedMapFrameLayerState,
  EmbedMapFrameResponse,
} from '../../shared/embed-map-frame';

/**
 * The upstream reads, injected so the composition can be tested without Redis
 * or a live ACLED cache. Each returns the verbatim wire array its RPC returns.
 */
export interface EmbedMapFrameSources {
  listEarthquakes: () => Promise<readonly unknown[]>;
  listNaturalEvents: () => Promise<readonly unknown[]>;
  listWeatherAlerts: () => Promise<readonly unknown[]>;
}

/** Which upstreams each live layer needs. Absent ⇒ the layer is static data
 *  the client already ships, and needs no upstream read. */
const SOURCES_BY_LAYER = {
  earthquakes: ['earthquakes', 'naturalEvents'],
  weather: ['weatherAlerts'],
} as const satisfies Partial<Record<EmbedLayerId, readonly (keyof EmbedMapFrameData)[]>>;

type LiveLayerId = keyof typeof SOURCES_BY_LAYER;
type SourceKey = keyof EmbedMapFrameData;

const FETCHER_BY_SOURCE: Record<SourceKey, keyof EmbedMapFrameSources> = {
  earthquakes: 'listEarthquakes',
  naturalEvents: 'listNaturalEvents',
  weatherAlerts: 'listWeatherAlerts',
};

function isLiveLayer(id: EmbedLayerId): id is LiveLayerId {
  return id in SOURCES_BY_LAYER;
}

/**
 * The `Cache-Control` for a response.
 *
 * `shared` is granted ONLY to the exact public URL shape; everything else is
 * `private, no-store`. There is no middle setting: #5386 is the incident where
 * a body that was merely "not public" still landed in a warm shared entry and
 * answered a different caller's request.
 */
export function cacheControlForEmbedFrame(shared: boolean): string {
  if (!shared) return 'private, no-store';
  const seconds = Math.floor(EMBED_REFRESH_MS / 1000);
  // `stale-while-revalidate` keeps a wall display rendering through an
  // origin blip.
  return `public, max-age=60, s-maxage=${seconds}, stale-while-revalidate=600`;
}

/**
 * Parse the only input this endpoint accepts.
 *
 * Unknown ids are dropped rather than rejected: a partner pinned to an older
 * snippet must keep rendering the layers we still recognise. Order and
 * duplicates are normalised so the CDN cache key does not fragment.
 */
export function parseRequestedLayers(raw: string | null): EmbedLayerId[] {
  if (raw === null || raw.trim() === '') return [...EMBED_LAYER_IDS];
  const seen = new Set<EmbedLayerId>();
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id && isEmbedLayerId(id)) seen.add(id);
  }
  return [...seen];
}

export async function composeEmbedMapFrame(
  requestedLayers: readonly EmbedLayerId[],
  sources: EmbedMapFrameSources,
  now: number = Date.now(),
): Promise<EmbedMapFrameResponse> {
  const layers: Partial<Record<EmbedLayerId, EmbedMapFrameLayerState>> = {};

  // Fetch only the upstreams the requested live layers need.
  const needed = new Set<SourceKey>();
  for (const id of requestedLayers) {
    if (!isLiveLayer(id)) {
      layers[id] = 'ok';
      continue;
    }
    for (const source of SOURCES_BY_LAYER[id]) needed.add(source);
  }

  const order = [...needed];
  const settled = await Promise.allSettled(
    order.map((source) => sources[FETCHER_BY_SOURCE[source]]()),
  );

  const data: EmbedMapFrameData = {};
  const failed = new Set<SourceKey>();
  order.forEach((source, index) => {
    const result = settled[index];
    if (result?.status === 'fulfilled') data[source] = result.value;
    else failed.add(source);
  });

  for (const id of requestedLayers) {
    if (layers[id] !== undefined) continue;
    const required = SOURCES_BY_LAYER[id as LiveLayerId];
    const down = required.filter((source) => failed.has(source)).length;
    layers[id] = down === 0 ? 'ok' : down === required.length ? 'unavailable' : 'partial';
  }

  return {
    refreshMs: EMBED_REFRESH_MS,
    generatedAt: now,
    layers,
    data,
  };
}
