import type { MapLayers, NaturalEvent } from '@/types';
// The map consumes the seismology service's Earthquake, which carries fields
// the `@/types` one does not — importing the wrong one silently narrows it.
import type { Earthquake } from '@/services/earthquakes';
import type { WeatherAlert } from '@/services/weather';
import { mapAlert } from '@/services/weather';
import { toNaturalEvent } from '@/services/eonet';

import { startSmartPollLoop, type SmartPollLoopHandle } from '@/services/smart-poll-loop';
import { EmbedMapFrameUnavailableError, fetchEmbedMapFrame } from './embed-fetch';
import { EMBED_REFRESH_MS, type EmbedLayerId } from '../../shared/embed-panels';
import type { EmbedMapFrameLayerState, EmbedMapFrameResponse } from '../../shared/embed-map-frame';

/**
 * The slice of `MapContainer` the frame drives. Narrowed to what is actually
 * called so the loader can be exercised without a DOM.
 */
export interface EmbedMapSurface {
  setEarthquakes(earthquakes: Earthquake[]): void;
  setNaturalEvents(events: NaturalEvent[]): void;
  setWeatherAlerts(alerts: WeatherAlert[]): void;
  setLayerLoading(layer: keyof MapLayers, loading: boolean): void;
  setLayerReady(layer: keyof MapLayers, ready: boolean): void;
  getState(): { layers: MapLayers };
  setLayers(layers: MapLayers): void;
}

/** Every embeddable layer's corresponding map layer. */
const MAP_LAYER_BY_EMBED_ID: Record<EmbedLayerId, keyof MapLayers> = {
  earthquakes: 'natural',
  weather: 'weather',
  cables: 'cables',
  pipelines: 'pipelines',
};

export type EmbedFrameFetcher = (
  layerIds: readonly EmbedLayerId[],
) => Promise<EmbedMapFrameResponse>;

export interface EmbedDataLoaderOptions {
  fetchFrame?: EmbedFrameFetcher;
}

/**
 * Drives the embed map frame from the single composed endpoint.
 *
 * The cadence is never a constant here — it comes back on every response, so
 * the refresh policy has exactly one owner (the edge).
 */
export class EmbedDataLoader {
  private refreshLoop: SmartPollLoopHandle | null = null;
  private refreshMs = EMBED_REFRESH_MS;
  private frameRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private readonly fetchFrame: EmbedFrameFetcher;

  constructor(
    private readonly map: EmbedMapSurface,
    private readonly activeLayerIds: readonly EmbedLayerId[],
    options: EmbedDataLoaderOptions = {},
  ) {
    this.fetchFrame = options.fetchFrame ?? fetchEmbedMapFrame;
  }

  async start(): Promise<void> {
    await this.loadOnce();
    this.startLoop();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopLoop();
    if (this.frameRetryTimer !== null) clearTimeout(this.frameRetryTimer);
  }

  async loadOnce(): Promise<void> {
    const live = this.activeLayerIds.filter((id) => isLiveLayer(id));
    for (const id of live) this.map.setLayerLoading(MAP_LAYER_BY_EMBED_ID[id], true);

    try {
      const frame = await this.fetchFrame(this.activeLayerIds);
      const nextRefreshMs = frame.refreshMs > 0 ? frame.refreshMs : this.refreshMs;
      const cadenceChanged = nextRefreshMs !== this.refreshMs;
      this.refreshMs = nextRefreshMs;
      if (this.frameRetryTimer !== null) {
        clearTimeout(this.frameRetryTimer);
        this.frameRetryTimer = null;
      }
      this.applyFrame(frame);
      // A server-side cadence change leaves the running timer on the old one.
      if (cadenceChanged && this.refreshLoop !== null) this.startLoop();
    } catch (error) {
      // A failed poll leaves the previous frame on screen — the map keeps
      // whatever it was already showing, and only the loading flag clears.
      console.warn('[embed] map frame request failed:', error);
      if (error instanceof EmbedMapFrameUnavailableError) {
        this.scheduleFrameRetry(error.retryAfterMs);
      }
      for (const id of live) this.map.setLayerLoading(MAP_LAYER_BY_EMBED_ID[id], false);
      return;
    }

    for (const id of live) this.map.setLayerLoading(MAP_LAYER_BY_EMBED_ID[id], false);
  }

  private applyFrame(frame: EmbedMapFrameResponse): void {
    const data = frame.data;
    if (data.earthquakes && isLayerRendered(frame.layers.earthquakes)) {
      this.map.setEarthquakes(data.earthquakes as Earthquake[]);
    }
    if (data.naturalEvents && isLayerRendered(frame.layers.earthquakes)) {
      this.map.setNaturalEvents(
        (data.naturalEvents as Parameters<typeof toNaturalEvent>[0][]).map(toNaturalEvent),
      );
    }
    if (data.weatherAlerts && isLayerRendered(frame.layers.weather)) {
      this.map.setWeatherAlerts(
        (data.weatherAlerts as Parameters<typeof mapAlert>[0][]).map(mapAlert),
      );
    }

    const nextLayers = { ...this.map.getState().layers };
    const rejected: EmbedLayerId[] = [];
    for (const id of this.activeLayerIds) {
      const layer = MAP_LAYER_BY_EMBED_ID[id];
      const rendered = isLayerRendered(frame.layers[id]);
      if (!rendered) rejected.push(id);
      nextLayers[layer] = rendered;
      this.map.setLayerReady(layer, rendered);
    }
    this.map.setLayers(nextLayers);
    for (const id of rejected) this.clearLayerData(id);
  }

  private clearLayerData(id: EmbedLayerId): void {
    if (id === 'earthquakes') {
      this.map.setEarthquakes([]);
      this.map.setNaturalEvents([]);
    }
    if (id === 'weather') this.map.setWeatherAlerts([]);
  }

  private scheduleFrameRetry(retryAfterMs: number): void {
    if (this.frameRetryTimer !== null) clearTimeout(this.frameRetryTimer);
    this.frameRetryTimer = setTimeout(() => {
      this.frameRetryTimer = null;
      if (!this.destroyed) void this.loadOnce();
    }, retryAfterMs);
  }

  private startLoop(): void {
    this.stopLoop();
    if (this.destroyed) return;
    this.refreshLoop = startSmartPollLoop(() => this.loadOnce(), {
      intervalMs: this.refreshMs,
      pauseWhenHidden: true,
      refreshOnVisible: true,
      runImmediately: false,
    });
  }

  private stopLoop(): void {
    if (this.refreshLoop !== null) {
      this.refreshLoop.stop();
      this.refreshLoop = null;
    }
  }
}

/** Layers backed by an upstream read; the rest ship with the client. */
function isLiveLayer(id: EmbedLayerId): boolean {
  return id === 'earthquakes' || id === 'weather';
}

/**
 * `partial` counts as rendered: one of the layer's two upstreams answered, so
 * there is something on the map and marking it un-ready would hide it.
 */
function isLayerRendered(state: EmbedMapFrameLayerState | undefined): boolean {
  return state === 'ok' || state === 'partial';
}
