/**
 * MapContainer - lightweight conditional map renderer
 * Paints a stable shell first, then lazy-loads the selected renderer.
 * Renders DeckGLMap (WebGL) on desktop, fallback to D3/SVG MapComponent on mobile.
 * Supports an optional 3D globe mode (globe.gl) selectable from Settings.
 */
import { isMobileDevice } from '@/utils';
import { markLcpDebug } from '@/utils/lcp-debug';
import {
  isLayerToggleAllowed,
  isLayerEntitled,
  sanitizeLockedLayers,
  shouldSanitizeLockedLayers,
  type RendererKind,
} from '@/config/map-layer-definitions';
import { isProTierResolved } from '@/services/widget-store';
import { t } from '@/services/i18n';
import type { MapComponent, MapComponentOptions } from './Map';
import type { DeckGLMap, DeckMapView, CountryClickPayload } from './DeckGLMap';
import type { GlobeMap } from './GlobeMap';
import type {
  MapLayers,
  NewsLocationMarker,
  InternetOutage,
  RelatedAsset,
  AssetType,
  CableAdvisory,
  RepairShip,
  NaturalEvent,
  CableHealthRecord,
} from '@/types';
import type { Earthquake } from '@/services/earthquakes';
import type { ClimateAnomaly } from '@/services/climate';
import type { WeatherAlert } from '@/services/weather';
import type { RadiationObservation } from '@/services/radiation';
import type { WebcamEntry, WebcamCluster } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import type { TrafficAnomaly as ProtoTrafficAnomaly, DdosLocationHit } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { DiseaseOutbreakItem } from '@/services/disease-outbreaks';
import { getAuthState } from '@/services/auth-state';
import { hasPremiumAccess } from '@/services/panel-gating';

export type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';
export type MapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

type PendingCenter = { lat: number; lon: number; zoom?: number; actionToken?: number };
type PendingViewportAction =
  | { type: 'view'; view: MapView; zoom?: number; actionToken: number }
  | { type: 'zoom'; zoom: number; actionToken: number }
  | { type: 'center'; lat: number; lon: number; zoom?: number; actionToken: number };

let mapLibreCssPromise: Promise<unknown> | null = null;

function afterFirstPaint(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function loadMapLibreCss(): Promise<unknown> {
  mapLibreCssPromise ??= import('maplibre-gl/dist/maplibre-gl.css');
  return mapLibreCssPromise;
}

const DECK_RENDERER_VISIBLE_IDLE_DELAY_MS = 3_500;
const DECK_RENDERER_IDLE_TIMEOUT_MS = 5_000;
const DECK_RENDERER_NO_OBSERVER_DELAY_MS = 4_500;
// Absolute upper bound for the demand gate when an IntersectionObserver is
// available: longer than VISIBLE_IDLE + IDLE_TIMEOUT so the visible-idle path
// wins for on-screen maps, but guarantees an off-screen / partially-visible /
// deferred-mounted map still loads instead of hanging on the shell forever.
const DECK_RENDERER_MAX_WAIT_MS = 12_000;

export interface MapContainerState {
  zoom: number;
  pan: { x: number; y: number };
  view: MapView;
  layers: MapLayers;
  timeRange: TimeRange;
}

export interface MapContainerOptions {
  chrome?: boolean;
  mapLibreWorkerUrl?: string;
  preferDesktopRenderer?: boolean;
  isFreeTierFallbackActive?: () => boolean;
}

export type ViewportTransitionFailureReason =
  | 'viewport_superseded'
  | 'renderer_changed'
  | 'viewport_interrupted';

export interface MapRendererSwitchResult {
  renderer: 'globe' | 'deck' | 'svg';
  mode: 'globe' | 'flat';
  fallback: boolean;
}

export class ViewportTransitionError extends Error {
  public constructor(public readonly reason: ViewportTransitionFailureReason) {
    super(reason === 'viewport_superseded'
      ? 'Map viewport transition was superseded.'
      : reason === 'renderer_changed'
        ? 'Map renderer changed during the viewport transition.'
        : 'Map viewport transition was interrupted.');
    this.name = 'ViewportTransitionError';
  }
}

type FireMarker = { lat: number; lon: number; brightness: number; frp: number; confidence: number; region: string; acq_date: string; daynight: string };

/**
 * Unified map interface that delegates to either DeckGLMap or MapComponent
 * based on device capabilities
 */
export class MapContainer {
  private container: HTMLElement;
  private isMobile: boolean;
  private readonly preferDesktopRenderer: boolean;
  private deckGLMap: DeckGLMap | null = null;
  private svgMap: MapComponent | null = null;
  private globeMap: GlobeMap | null = null;
  private initialState: MapContainerState;
  private useDeckGL: boolean;
  private useGlobe: boolean;
  private readonly chrome: boolean;
  private readonly mapLibreWorkerUrl: string | undefined;
  private readonly svgLayerToggleGuard: NonNullable<MapComponentOptions['canToggleLayer']>;
  private readonly isFreeTierFallbackActive: (() => boolean) | null;
  private isResizingInternal = false;
  private resizeObserver: ResizeObserver | null = null;
  private rendererDemandCleanup: (() => void) | null = null;
  private globeInitToken = 0;
  private rendererInitToken = 0;
  private viewportActionToken = 0;
  private humanViewportInteractionToken = 0;
  private readonly invalidateViewportAuthority = (): void => {
    this.markHumanViewportInteraction();
  };
  private rendererReady = false;
  private rendererInitError: Error | null = null;
  private rendererReadyWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();
  private rendererDemandRequested = false;
  private releaseRendererDemand: (() => void) | null = null;
  private destroyed = false;
  private pendingCenter: PendingCenter | null = null;
  private pendingViewportActions: PendingViewportAction[] = [];
  private hiddenLayerToggles = new Set<keyof MapLayers>();
  private layerLoadingState = new Map<keyof MapLayers, boolean>();
  private layerReadyState = new Map<keyof MapLayers, boolean>();

  // ─── Callback cache (survives map mode switches) ───────────────────────────
  private cachedOnStateChanged: ((state: MapContainerState) => void) | null = null;
  private cachedOnLayerChange: ((layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void) | null = null;
  private cachedOnTimeRangeChanged: ((range: TimeRange) => void) | null = null;
  private cachedOnNewsClicked: ((item: Pick<NewsLocationMarker, 'article' | 'title'>) => void) | null = null;
  private cachedOnCountryClicked: ((country: CountryClickPayload) => void) | null = null;
  private cachedOnMapContextMenu: ((payload: { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string }) => void) | null = null;

  // ─── Data cache (survives map mode switches) ───────────────────────────────
  private cachedEarthquakes: Earthquake[] | null = null;
  private cachedWeatherAlerts: WeatherAlert[] | null = null;
  private cachedOutages: InternetOutage[] | null = null;
  private cachedCableAdvisories: CableAdvisory[] | null = null;
  private cachedRepairShips: RepairShip[] | null = null;
  private cachedCableHealth: Record<string, CableHealthRecord> | null = null;
  private cachedNaturalEvents: NaturalEvent[] | null = null;
  private cachedFires: FireMarker[] | null = null;
  private cachedClimateAnomalies: ClimateAnomaly[] | null = null;
  private cachedRadiationObservations: RadiationObservation[] | null = null;
  private cachedDiseaseOutbreaks: DiseaseOutbreakItem[] | null = null;
  private cachedNewsLocations: NewsLocationMarker[] | null = null;
  private cachedWebcams: Array<WebcamEntry | WebcamCluster> | null = null;
  private cachedTrafficAnomalies: ProtoTrafficAnomaly[] | null = null;
  private cachedDdosLocations: DdosLocationHit[] | null = null;

  constructor(container: HTMLElement, initialState: MapContainerState, preferGlobe = false, options: MapContainerOptions = {}) {
    this.container = container;
    this.initialState = initialState;
    this.chrome = options.chrome ?? true;
    this.mapLibreWorkerUrl = options.mapLibreWorkerUrl;
    this.svgLayerToggleGuard = (layer, currentlyEnabled) => isLayerToggleAllowed(
      layer,
      currentlyEnabled === true,
      hasPremiumAccess(getAuthState()),
    );
    this.isFreeTierFallbackActive = options.isFreeTierFallbackActive ?? null;
    this.isMobile = isMobileDevice();
    this.preferDesktopRenderer = options.preferDesktopRenderer ?? false;
    this.useGlobe = preferGlobe && this.hasGlobeSupport();

    this.useDeckGL = !this.useGlobe && this.shouldUseDeckGL();

    // A WebMCP viewport action can wait for the UI and renderer to become
    // ready. Any direct map interaction during that wait owns the newer user
    // intent and must make the queued agent action stale before it can apply.
    this.container.addEventListener('pointerdown', this.invalidateViewportAuthority, { passive: true });
    this.container.addEventListener('wheel', this.invalidateViewportAuthority, { passive: true });
    this.container.addEventListener('touchstart', this.invalidateViewportAuthority, { passive: true });
    this.container.addEventListener('keydown', this.invalidateViewportAuthority);

    // init() attaches the resize observer synchronously (before its first await),
    // so the constructor does not need to start it separately.
    void this.init();
  }

  private hasWebGLSupport(): boolean {
    try {
      const canvas = document.createElement('canvas');
      // deck.gl + maplibre rely on WebGL2 features in desktop mode.
      // Some Linux WebKitGTK builds expose only WebGL1, which can lead to
      // an empty/black render surface instead of a usable map.
      const gl2 = canvas.getContext('webgl2');
      if (!gl2) return false;
      const debugInfo = gl2.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const renderer = String(gl2.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '').toLowerCase();
        if (renderer.includes('swiftshader') || renderer.includes('llvmpipe') || renderer.includes('softpipe') || renderer.includes('software rasterizer')) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private hasGlobeSupport(): boolean {
    try {
      const canvas = document.createElement('canvas');
      return !!(
        canvas.getContext('webgl2')
        || canvas.getContext('webgl')
        || canvas.getContext('experimental-webgl')
      );
    } catch {
      return false;
    }
  }

  private shouldUseDeckGL(): boolean {
    // Keep the default mobile path on the lightweight SVG renderer. High-end
    // phones can still request globe mode explicitly via the persisted mode,
    // but they should not pull Deck/MapLibre before first paint by default.
    if (this.isMobile && !this.preferDesktopRenderer) return false;
    if (!this.hasWebGLSupport()) return false;
    return true;
  }

  private getPendingRendererKind(): RendererKind {
    if (this.useGlobe) return 'globe';
    if (this.useDeckGL) return 'deck';
    return 'svg';
  }

  private showRendererShell(kind: RendererKind): void {
    markLcpDebug('wm:map:shell-shown', { kind });
    this.container.classList.remove('deckgl-mode', 'globe-mode', 'svg-mode');
    this.container.classList.add('map-renderer-shell');
    this.container.dataset.mapRendererPending = kind;
    this.container.setAttribute('aria-busy', 'true');
    this.container.textContent = '';
    const shell = document.createElement('div');
    shell.className = 'map-renderer-shell-surface';
    shell.setAttribute('aria-hidden', 'true');
    this.container.appendChild(shell);
  }

  private prepareRendererDom(modeClass: 'svg-mode' | 'deckgl-mode' | 'globe-mode'): void {
    this.rendererReady = false;
    this.container.classList.remove('map-renderer-shell', 'deckgl-mode', 'globe-mode', 'svg-mode');
    delete this.container.dataset.mapRendererPending;
    this.container.removeAttribute('aria-busy');
    this.container.textContent = '';
    this.container.classList.add(modeClass);
  }

  private isCurrentRendererInit(token: number): boolean {
    return !this.destroyed && token === this.rendererInitToken;
  }

  private hasActiveRenderer(): boolean {
    return Boolean(this.globeMap || this.deckGLMap || this.svgMap);
  }

  private isViewportRendererReady(): boolean {
    return this.rendererReady && this.hasActiveRenderer();
  }

  private replayPendingViewportActions(): void {
    const pendingViewportActions = this.pendingViewportActions.splice(0);
    if (this.pendingCenter) {
      pendingViewportActions.push({
        type: 'center',
        ...this.pendingCenter,
        actionToken: this.pendingCenter.actionToken ?? -1,
      });
      this.pendingCenter = null;
    }
    pendingViewportActions.sort((left, right) => left.actionToken - right.actionToken);
    for (const action of pendingViewportActions) {
      if (action.type === 'view') this.applyView(action.view, action.zoom);
      else if (action.type === 'zoom') this.applyZoom(action.zoom);
      else this.applyCenter(action.lat, action.lon, action.zoom);
    }
  }

  private markRendererReady(token: number): void {
    // Renderer initialization can overlap a runtime mode switch. Only the
    // currently selected generation may publish readiness; otherwise an old
    // async renderer could wake callers that are waiting on its replacement.
    if (!this.isCurrentRendererInit(token)) return;
    this.rendererInitError = null;
    this.rendererReady = true;
    this.rendererDemandRequested = false;
    this.releaseRendererDemand = null;
    // Replay viewport commands before resolving readiness so callers waiting to
    // observe settlement attach to the transition that was actually started.
    this.replayPendingViewportActions();
    const waiters = Array.from(this.rendererReadyWaiters);
    this.rendererReadyWaiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }

  private startResizeObserver(): void {
    if (this.resizeObserver || typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.isResizingInternal) return;
      this.resize();
    });
    this.resizeObserver.observe(this.container);
  }

  private waitForDeckRendererDemand(token: number): Promise<boolean> {
    if (typeof window === 'undefined') return Promise.resolve(true);
    if (this.rendererDemandRequested) {
      this.rendererDemandRequested = false;
      return Promise.resolve(true);
    }

    this.rendererDemandCleanup?.();
    this.rendererDemandCleanup = null;

    return new Promise((resolve) => {
      let resolved = false;
      let observer: IntersectionObserver | null = null;
      let visibleDelayId: number | null = null;
      let fallbackDelayId: number | null = null;
      let idleCallbackId: number | null = null;
      let idleFallbackDelayId: number | null = null;
      let cancelDemand: (() => void) | null = null;

      const clearVisibleDelay = (): void => {
        if (visibleDelayId !== null) {
          window.clearTimeout(visibleDelayId);
          visibleDelayId = null;
        }
        if (idleCallbackId !== null && typeof window.cancelIdleCallback === 'function') {
          window.cancelIdleCallback(idleCallbackId);
          idleCallbackId = null;
        }
        if (idleFallbackDelayId !== null) {
          window.clearTimeout(idleFallbackDelayId);
          idleFallbackDelayId = null;
        }
      };

      const cleanup = (): void => {
        clearVisibleDelay();
        if (fallbackDelayId !== null) {
          window.clearTimeout(fallbackDelayId);
          fallbackDelayId = null;
        }
        observer?.disconnect();
        observer = null;
        this.container.removeEventListener('pointerdown', finishFromSignal);
        this.container.removeEventListener('wheel', finishFromSignal);
        this.container.removeEventListener('touchstart', finishFromSignal);
        this.container.removeEventListener('keydown', finishFromSignal);
        if (this.rendererDemandCleanup === cancelDemand) this.rendererDemandCleanup = null;
        if (this.releaseRendererDemand === finishIfCurrent) this.releaseRendererDemand = null;
      };

      const settle = (shouldLoadDeck: boolean): void => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(shouldLoadDeck);
      };

      const finish = (): void => {
        this.rendererDemandRequested = false;
        markLcpDebug('wm:map:renderer-demand', { kind: 'deck' });
        settle(true);
      };

      const cancel = (): void => {
        settle(false);
      };

      const finishIfCurrent = (): void => {
        if (this.isCurrentRendererInit(token)) {
          finish();
        } else {
          cancel();
        }
      };

      function finishFromSignal(): void {
        finishIfCurrent();
      }

      const requestIdle = (): void => {
        if (idleCallbackId !== null || idleFallbackDelayId !== null) return;
        if (typeof window.requestIdleCallback === 'function') {
          idleCallbackId = window.requestIdleCallback(() => {
            idleCallbackId = null;
            finishIfCurrent();
          }, { timeout: DECK_RENDERER_IDLE_TIMEOUT_MS });
        } else {
          idleFallbackDelayId = window.setTimeout(() => {
            idleFallbackDelayId = null;
            finishIfCurrent();
          }, 1);
        }
      };

      const scheduleVisibleIdle = (): void => {
        if (visibleDelayId !== null || idleCallbackId !== null || idleFallbackDelayId !== null) return;
        visibleDelayId = window.setTimeout(() => {
          visibleDelayId = null;
          requestIdle();
        }, DECK_RENDERER_VISIBLE_IDLE_DELAY_MS);
      };

      cancelDemand = cancel;
      this.rendererDemandCleanup = cancelDemand;
      this.releaseRendererDemand = finishIfCurrent;
      this.container.addEventListener('pointerdown', finishFromSignal, { once: true, passive: true });
      this.container.addEventListener('wheel', finishFromSignal, { once: true, passive: true });
      this.container.addEventListener('touchstart', finishFromSignal, { once: true, passive: true });
      this.container.addEventListener('keydown', finishFromSignal, { once: true });

      const hasIntersectionObserver = typeof IntersectionObserver === 'function';

      // Absolute backstop so the renderer always loads even when the container
      // never reaches the visibility threshold and no interaction fires (e.g.
      // below-fold, only 1-14% visible, deferred-mount, or a hidden map panel).
      // With an IntersectionObserver the visible-idle path resolves first; this
      // longer timer is purely the safety net that prevents a permanent shell.
      fallbackDelayId = window.setTimeout(
        finishIfCurrent,
        hasIntersectionObserver ? DECK_RENDERER_MAX_WAIT_MS : DECK_RENDERER_NO_OBSERVER_DELAY_MS,
      );

      if (hasIntersectionObserver) {
        observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            scheduleVisibleIdle();
          } else {
            clearVisibleDelay();
          }
        }, { threshold: 0.15 });
        observer.observe(this.container);
      }
    });
  }

  private async initSvgMap(logMessage: string, token: number): Promise<void> {
    console.log(logMessage);
    markLcpDebug('wm:map:svg-init-start');
    this.useDeckGL = false;
    this.deckGLMap = null;
    const { MapComponent } = await import('./Map');
    if (!this.isCurrentRendererInit(token)) return;
    this.prepareRendererDom('svg-mode');
    // DeckGLMap mutates DOM early during construction. If initialization throws,
    // clear partial WebGL nodes before creating the SVG fallback.
    this.svgMap = new MapComponent(this.container, this.initialState, {
      chrome: this.chrome,
      isMobile: this.isMobile,
      canToggleLayer: this.svgLayerToggleGuard,
    });
    this.rehydrateActiveMap();
    this.markRendererReady(token);
    markLcpDebug('wm:map:svg-ready');
  }

  private async createGlobeMap(rendererToken: number): Promise<void> {
    const globeToken = ++this.globeInitToken;
    try {
      markLcpDebug('wm:map:globe-init-start');
      const { GlobeMap } = await import('./GlobeMap');
      if (!this.isCurrentRendererInit(rendererToken)) return;
      this.prepareRendererDom('globe-mode');
      this.globeMap = new GlobeMap(this.container, this.initialState, {
        onInitError: (error) => this.handleGlobeInitFailure(globeToken, error),
        chrome: this.chrome,
      });
      this.rehydrateActiveMap();
      void this.globeMap.whenReady().then(() => {
        if (!this.isCurrentRendererInit(rendererToken) || !this.useGlobe) return;
        this.markRendererReady(rendererToken);
        markLcpDebug('wm:map:globe-ready');
      }).catch(() => {});
    } catch (error) {
      this.handleGlobeInitFailure(globeToken, error);
    }
  }

  private handleGlobeInitFailure(token: number, error: unknown): void {
    if (token !== this.globeInitToken || !this.useGlobe) return;
    console.warn('[MapContainer] Globe initialization failed, falling back to SVG map', error);
    this.globeMap?.destroy();
    this.globeMap = null;
    this.useGlobe = false;
    this.useDeckGL = false;
    const fallbackToken = ++this.rendererInitToken;
    this.showRendererShell('svg');
    void this.initSvgMap('[MapContainer] Initializing SVG map (globe fallback mode)', fallbackToken);
  }

  private handleDeckGLRuntimeFailure(token: number, error: unknown): void {
    if (token !== this.rendererInitToken || !this.useDeckGL) return;
    console.warn('[MapContainer] DeckGL runtime failure, falling back to SVG map', error);
    const snapshot = this.getState();
    const center = this.getCenter();
    this.initialState = snapshot;
    this.pendingCenter = center ? { ...center, zoom: snapshot.zoom } : null;
    try {
      this.deckGLMap?.destroy();
    } catch (destroyError) {
      console.warn('[MapContainer] DeckGL teardown failed during SVG fallback', destroyError);
    }
    this.deckGLMap = null;
    this.useDeckGL = false;
    const fallbackToken = ++this.rendererInitToken;
    this.showRendererShell('svg');
    void this.initSvgMap('[MapContainer] Initializing SVG map (DeckGL runtime fallback)', fallbackToken).catch((error: unknown) => {
      if (!this.isCurrentRendererInit(fallbackToken)) return;
      this.rendererInitError = error instanceof Error ? error : new Error(String(error));
      console.warn('[MapContainer] SVG fallback initialization failed', this.rendererInitError);
      try {
        this.svgMap?.destroy();
      } catch (destroyError) {
        console.warn('[MapContainer] Partial SVG teardown failed', destroyError);
      }
      this.svgMap = null;
      this.prepareRendererDom('svg-mode');
      this.container.textContent = t('common.unavailable');
      const waiters = Array.from(this.rendererReadyWaiters);
      this.rendererReadyWaiters.clear();
      for (const waiter of waiters) waiter.reject(this.rendererInitError);
    });
  }

  private async createDeckGLMap(token: number): Promise<void> {
    console.log('[MapContainer] Initializing deck.gl map (desktop mode)');
    try {
      markLcpDebug('wm:map:deck-init-start');
      await loadMapLibreCss();
      const { DeckGLMap } = await import('./DeckGLMap');
      if (!this.isCurrentRendererInit(token)) return;
      this.prepareRendererDom('deckgl-mode');
      this.deckGLMap = new DeckGLMap(this.container, {
        ...this.initialState,
        view: this.initialState.view as DeckMapView,
      }, {
        chrome: this.chrome,
        // Mid-session MapLibre rebuilds (fallback basemap after WebGL loss)
        // can throw GPUInitializationError outside whenReady(); degrade to SVG.
        onFatalError: (error) => this.handleDeckGLRuntimeFailure(token, error),
        mapLibreWorkerUrl: this.mapLibreWorkerUrl,
      });
      this.rehydrateActiveMap();
      // DeckGLMap defers MapLibre construction behind an async init. Await it so
      // a WebGL/map-construction throw still reaches this catch and degrades to
      // SVG, instead of becoming an unhandled rejection behind a blank map.
      await this.deckGLMap.whenReady();
      if (!this.isCurrentRendererInit(token)) return;
      this.markRendererReady(token);
      markLcpDebug('wm:map:deck-ready');
    } catch (error) {
      if (!this.isCurrentRendererInit(token)) return;
      console.warn('[MapContainer] DeckGL initialization failed, falling back to SVG map', error);
      // Tear down the half-built deck map so its listeners, timers and WebGL
      // context do not leak; initSvgMap then nulls the reference and flips
      // useDeckGL off.
      this.deckGLMap?.destroy();
      await this.initSvgMap('[MapContainer] Initializing SVG map (DeckGL fallback mode)', token);
    }
  }

  private async init(): Promise<void> {
    const token = ++this.rendererInitToken;
    this.rendererInitError = null;
    this.rendererReady = false;
    this.showRendererShell(this.getPendingRendererKind());
    this.startResizeObserver();
    // requestAnimationFrame is paused while the tab is hidden, so the heavy
    // renderer load deferred behind afterFirstPaint() intentionally waits until
    // the tab becomes visible — the lightweight shell is shown until then.
    await afterFirstPaint();
    if (!this.isCurrentRendererInit(token)) return;
    markLcpDebug('wm:map:after-first-paint');

    if (this.useGlobe) {
      console.log('[MapContainer] Initializing 3D globe (globe.gl mode)');
      await this.createGlobeMap(token);
    } else if (this.useDeckGL) {
      const shouldLoadDeck = await this.waitForDeckRendererDemand(token);
      if (!shouldLoadDeck || !this.isCurrentRendererInit(token)) return;
      await this.createDeckGLMap(token);
    } else {
      await this.initSvgMap('[MapContainer] Initializing SVG map (mobile/fallback mode)', token);
    }
  }

  /** Switch to 3D globe mode at runtime (called from Settings). */
  public switchToGlobe(): Promise<MapRendererSwitchResult> {
    if (!this.useGlobe) {
      const snapshot = this.getState();
      const center = this.getCenter();
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      this.destroyFlatMap();
      this.useGlobe = true;
      this.useDeckGL = false;
      this.initialState = snapshot;
      this.pendingCenter = center ? { ...center, zoom: snapshot.zoom } : null;
      void this.init();
    }
    return this.waitForRendererSwitch('globe');
  }

  /** Reload basemap style (called when map provider changes in Settings). */
  public reloadBasemap(): void {
    this.deckGLMap?.reloadBasemap();
  }

  /** Switch back to flat map at runtime (called from Settings). */
  public switchToFlat(): Promise<MapRendererSwitchResult> {
    if (this.useGlobe) {
      const snapshot = this.getState();
      const center = this.getCenter();
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      this.globeInitToken++;
      this.globeMap?.destroy();
      this.globeMap = null;
      this.useGlobe = false;
      this.useDeckGL = this.shouldUseDeckGL();
      this.initialState = snapshot;
      this.pendingCenter = center ? { ...center, zoom: snapshot.zoom } : null;
      // Cancel any pending deck demand gate from a prior flat init before
      // re-initializing, mirroring destroyFlatMap(), so a stale gate can't abort
      // the new init during the afterFirstPaint() window.
      this.rendererDemandCleanup?.();
      this.rendererDemandCleanup = null;
      void this.init();
    }
    return this.waitForRendererSwitch('flat');
  }

  private rehydrateActiveMap(): void {
    // 1. Re-wire callbacks (through own public methods for adapter safety)
    if (this.cachedOnStateChanged) this.onStateChanged(this.cachedOnStateChanged);
    if (this.cachedOnLayerChange) this.setOnLayerChange(this.cachedOnLayerChange);
    if (this.cachedOnTimeRangeChanged) this.onTimeRangeChanged(this.cachedOnTimeRangeChanged);
    if (this.cachedOnCountryClicked) this.onCountryClicked(this.cachedOnCountryClicked);
    if (this.cachedOnNewsClicked) this.onNewsClicked(this.cachedOnNewsClicked);
    if (this.cachedOnMapContextMenu) this.onMapContextMenu(this.cachedOnMapContextMenu);

    // 2. Re-push all cached data
    if (this.cachedEarthquakes) this.setEarthquakes(this.cachedEarthquakes);
    if (this.cachedWeatherAlerts) this.setWeatherAlerts(this.cachedWeatherAlerts);
    if (this.cachedOutages) this.setOutages(this.cachedOutages);
    if (this.cachedCableAdvisories != null && this.cachedRepairShips != null) this.setCableActivity(this.cachedCableAdvisories, this.cachedRepairShips);
    if (this.cachedCableHealth) this.setCableHealth(this.cachedCableHealth);
    if (this.cachedNaturalEvents) this.setNaturalEvents(this.cachedNaturalEvents);
    if (this.cachedFires) this.setFires(this.cachedFires);
    if (this.cachedClimateAnomalies) this.setClimateAnomalies(this.cachedClimateAnomalies);
    if (this.cachedRadiationObservations) this.setRadiationObservations(this.cachedRadiationObservations);
    if (this.cachedDiseaseOutbreaks) this.setDiseaseOutbreaks(this.cachedDiseaseOutbreaks);
    if (this.cachedNewsLocations) this.setNewsLocations(this.cachedNewsLocations);
    if (this.cachedTrafficAnomalies) this.setTrafficAnomalies(this.cachedTrafficAnomalies);
    if (this.cachedDdosLocations) this.setDdosLocations(this.cachedDdosLocations);
    if (this.cachedWebcams) {
      if (this.useGlobe) this.globeMap?.setWebcams(this.cachedWebcams);
      else if (this.useDeckGL) this.deckGLMap?.setWebcams(this.cachedWebcams);
      else this.svgMap?.setWebcams(this.cachedWebcams);
    }
    for (const [layer, loading] of this.layerLoadingState) this.setLayerLoading(layer, loading);
    for (const [layer, hasData] of this.layerReadyState) this.setLayerReady(layer, hasData);
    for (const layer of this.hiddenLayerToggles) this.hideLayerToggle(layer);
  }

  private currentRendererSwitchResult(requested: 'globe' | 'flat'): MapRendererSwitchResult {
    const renderer = this.useGlobe ? 'globe' : this.useDeckGL ? 'deck' : 'svg';
    return {
      renderer,
      mode: this.useGlobe ? 'globe' : 'flat',
      fallback: requested === 'globe' ? !this.useGlobe : this.useGlobe,
    };
  }

  private async waitForRendererSwitch(requested: 'globe' | 'flat'): Promise<MapRendererSwitchResult> {
    await this.whenRendererReady();
    return this.currentRendererSwitchResult(requested);
  }

  public isGlobeMode(): boolean {
    return this.useGlobe;
  }

  public isDeckGLActive(): boolean {
    return this.useDeckGL;
  }

  /** Resolves once the currently selected concrete renderer can accept commands. */
  public whenRendererReady(): Promise<void> {
    if (this.rendererReady && this.hasActiveRenderer()) return Promise.resolve();
    if (this.destroyed) return Promise.reject(new Error('Map renderer is no longer available.'));
    if (this.rendererInitError) return Promise.reject(this.rendererInitError);
    this.rendererDemandRequested = true;
    this.releaseRendererDemand?.();
    return new Promise((resolve, reject) => {
      this.rendererReadyWaiters.add({ resolve, reject });
    });
  }

  /** Snapshot direct user interaction so delayed agent work cannot overwrite it. */
  public getViewportAuthorityToken(): number {
    return this.humanViewportInteractionToken;
  }

  private markHumanViewportInteraction(): void {
    this.humanViewportInteractionToken += 1;
  }

  /** Resolves after the current programmatic viewport transition is visible. */
  public async whenViewportSettled(viewportActionToken = this.viewportActionToken): Promise<void> {
    const rendererInitToken = this.rendererInitToken;
    await this.whenRendererReady();
    if (viewportActionToken !== this.viewportActionToken) {
      throw new ViewportTransitionError('viewport_superseded');
    }
    let completed = true;
    if (this.useGlobe) {
      completed = await this.globeMap?.whenViewportSettled() ?? false;
    } else if (this.useDeckGL) {
      completed = await this.deckGLMap?.whenViewportSettled() ?? false;
    }
    // SVG viewport mutations are synchronous.
    if (viewportActionToken !== this.viewportActionToken) {
      throw new ViewportTransitionError('viewport_superseded');
    }
    if (rendererInitToken !== this.rendererInitToken) {
      throw new ViewportTransitionError('renderer_changed');
    }
    if (!completed) {
      throw new ViewportTransitionError('viewport_interrupted');
    }
  }

  private destroyFlatMap(): void {
    this.rendererDemandCleanup?.();
    this.rendererDemandCleanup = null;
    this.deckGLMap?.destroy();
    this.deckGLMap = null;
    this.svgMap?.destroy();
    this.svgMap = null;
    this.container.textContent = '';
    this.container.classList.remove('deckgl-mode', 'svg-mode', 'map-renderer-shell');
    delete this.container.dataset.mapRendererPending;
    this.container.removeAttribute('aria-busy');
  }

  // ─── Unified public API - delegates to active map implementation ────────────

  public render(): void {
    if (this.useGlobe) { this.globeMap?.render(); return; }
    if (this.useDeckGL) { this.deckGLMap?.render(); } else { this.svgMap?.render(); }
  }

  public resize(): void {
    if (this.useGlobe) {
      this.globeMap?.resize();
      return;
    }
    if (this.useDeckGL) {
      this.deckGLMap?.resize();
    } else {
      this.svgMap?.resize();
    }
  }

  public setIsResizing(isResizing: boolean): void {
    this.isResizingInternal = isResizing;
    if (this.useGlobe) { this.globeMap?.setIsResizing(isResizing); return; }
    if (this.useDeckGL) { this.deckGLMap?.setIsResizing(isResizing); } else { this.svgMap?.setIsResizing(isResizing); }
  }

  public setView(view: MapView, zoom?: number): number {
    const viewportActionToken = ++this.viewportActionToken;
    this.initialState = zoom == null
      ? { ...this.initialState, view }
      : { ...this.initialState, view, zoom };
    if (!this.isViewportRendererReady()) {
      this.pendingViewportActions.push({ type: 'view', view, zoom, actionToken: viewportActionToken });
      return viewportActionToken;
    }
    this.applyView(view, zoom);
    return viewportActionToken;
  }

  private applyView(view: MapView, zoom?: number): void {
    if (this.useGlobe) { this.globeMap?.setView(view, zoom); return; }
    if (this.useDeckGL) { this.deckGLMap?.setView(view as DeckMapView, zoom); } else { this.svgMap?.setView(view, zoom); }
  }

  public setZoom(zoom: number): void {
    const viewportActionToken = ++this.viewportActionToken;
    this.initialState = { ...this.initialState, zoom };
    if (!this.isViewportRendererReady()) {
      this.pendingViewportActions.push({ type: 'zoom', zoom, actionToken: viewportActionToken });
      return;
    }
    this.applyZoom(zoom);
  }

  private applyZoom(zoom: number): void {
    if (this.useGlobe) { this.globeMap?.setZoom(zoom); return; }
    if (this.useDeckGL) { this.deckGLMap?.setZoom(zoom); } else { this.svgMap?.setZoom(zoom); }
  }

  public setCenter(lat: number, lon: number, zoom?: number): number {
    const viewportActionToken = ++this.viewportActionToken;
    if (!this.isViewportRendererReady()) {
      this.pendingCenter = { lat, lon, zoom, actionToken: viewportActionToken };
      if (zoom != null) this.initialState = { ...this.initialState, zoom };
      return viewportActionToken;
    }
    this.applyCenter(lat, lon, zoom);
    return viewportActionToken;
  }

  /** NucMonitor — draw the 10/50-mile EPZ rings for a facility (deck.gl renderer only). */
  public setSelectedUsNuclearFacility(facilityId: string | null): void {
    if (this.useDeckGL) this.deckGLMap?.setSelectedUsNuclearFacility(facilityId);
  }

  private applyCenter(lat: number, lon: number, zoom?: number): void {
    if (this.useGlobe) { this.globeMap?.setCenter(lat, lon, zoom); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setCenter(lat, lon, zoom);
    } else {
      this.svgMap?.setCenter(lat, lon);
      if (zoom != null) this.svgMap?.setZoom(zoom);
    }
  }

  public getCenter(): { lat: number; lon: number } | null {
    if (this.useGlobe) return this.globeMap?.getCenter() ?? null;
    if (this.useDeckGL) return this.deckGLMap?.getCenter() ?? null;
    return this.svgMap?.getCenter() ?? null;
  }

  public setTimeRange(range: TimeRange): void {
    this.initialState = { ...this.initialState, timeRange: range };
    if (!this.hasActiveRenderer()) {
      this.cachedOnTimeRangeChanged?.(range);
      return;
    }
    if (this.useGlobe) { this.globeMap?.setTimeRange(range); return; }
    if (this.useDeckGL) { this.deckGLMap?.setTimeRange(range); } else { this.svgMap?.setTimeRange(range); }
  }

  public getTimeRange(): TimeRange {
    if (this.useGlobe) return this.globeMap?.getTimeRange() ?? this.initialState.timeRange;
    if (this.useDeckGL) return this.deckGLMap?.getTimeRange() ?? this.initialState.timeRange;
    return this.svgMap?.getTimeRange() ?? this.initialState.timeRange;
  }

  public setLayers(layers: MapLayers, options: { bypassEntitlementSanitization?: boolean } = {}): void {
    // Strip locked premium layers for settled free users (#6045).
    // Wait for isProTierResolved so Pro users don't lose premium layers during Clerk/Convex boot.
    let sanitized = layers;
    if (!options.bypassEntitlementSanitization && shouldSanitizeLockedLayers(
      hasPremiumAccess(getAuthState()),
      isProTierResolved(),
      this.isFreeTierFallbackActive?.() === true,
    )) {
      sanitized = sanitizeLockedLayers(sanitized, false);
    }
    this.initialState = { ...this.initialState, layers: sanitized };
    if (this.useGlobe) { this.globeMap?.setLayers(sanitized); return; }
    if (this.useDeckGL) { this.deckGLMap?.setLayers(sanitized); } else { this.svgMap?.setLayers(sanitized); }
  }

  public getState(): MapContainerState {
    if (this.useGlobe) return this.globeMap?.getState() ?? this.initialState;
    if (this.useDeckGL) {
      const state = this.deckGLMap?.getState();
      return state ? { ...state, view: state.view as MapView } : this.initialState;
    }
    return this.svgMap?.getState() ?? this.initialState;
  }

  // ─── Data setters ────────────────────────────────────────────────────────────

  public setEarthquakes(earthquakes: Earthquake[], options: { replaceEmpty?: boolean } = {}): void {
    this.cachedEarthquakes = earthquakes;
    if (this.useGlobe) { this.globeMap?.setEarthquakes(earthquakes); return; }
    if (this.useDeckGL) { this.deckGLMap?.setEarthquakes(earthquakes); } else { this.svgMap?.setEarthquakes(earthquakes, options); }
  }

  public setWebcams(markers: Array<WebcamEntry | WebcamCluster>): void {
    this.cachedWebcams = markers;
    if (this.useGlobe) { this.globeMap?.setWebcams(markers); return; }
    if (this.useDeckGL) { this.deckGLMap?.setWebcams(markers); }
    else { this.svgMap?.setWebcams(markers); }
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.cachedWeatherAlerts = alerts;
    if (this.useGlobe) { this.globeMap?.setWeatherAlerts(alerts); return; }
    if (this.useDeckGL) { this.deckGLMap?.setWeatherAlerts(alerts); } else { this.svgMap?.setWeatherAlerts(alerts); }
  }

  public setOutages(outages: InternetOutage[]): void {
    this.cachedOutages = outages;
    if (this.useGlobe) { this.globeMap?.setOutages(outages); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOutages(outages); } else { this.svgMap?.setOutages(outages); }
  }

  public setTrafficAnomalies(anomalies: ProtoTrafficAnomaly[]): void {
    this.cachedTrafficAnomalies = anomalies;
    if (this.useGlobe) { this.globeMap?.setTrafficAnomalies(anomalies); return; }
    if (this.useDeckGL) { this.deckGLMap?.setTrafficAnomalies(anomalies); }
  }

  public setDdosLocations(hits: DdosLocationHit[]): void {
    this.cachedDdosLocations = hits;
    if (this.useGlobe) { this.globeMap?.setDdosLocations(hits); return; }
    if (this.useDeckGL) { this.deckGLMap?.setDdosLocations(hits); }
  }

  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    this.cachedCableAdvisories = advisories;
    this.cachedRepairShips = repairShips;
    if (this.useGlobe) { this.globeMap?.setCableActivity(advisories, repairShips); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setCableActivity(advisories, repairShips);
    } else {
      this.svgMap?.setCableActivity(advisories, repairShips);
    }
  }

  public setCableHealth(healthMap: Record<string, CableHealthRecord>): void {
    this.cachedCableHealth = healthMap;
    if (this.useGlobe) { this.globeMap?.setCableHealth(healthMap); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setCableHealth(healthMap);
    } else {
      this.svgMap?.setCableHealth(healthMap);
    }
  }

  public setNaturalEvents(events: NaturalEvent[]): void {
    this.cachedNaturalEvents = events;
    if (this.useGlobe) { this.globeMap?.setNaturalEvents(events); return; }
    if (this.useDeckGL) { this.deckGLMap?.setNaturalEvents(events); } else { this.svgMap?.setNaturalEvents(events); }
  }

  public setFires(fires: FireMarker[]): void {
    this.cachedFires = fires;
    if (this.useGlobe) { this.globeMap?.setFires(fires); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setFires(fires);
    } else {
      this.svgMap?.setFires(fires);
    }
  }

  public setClimateAnomalies(anomalies: ClimateAnomaly[]): void {
    this.cachedClimateAnomalies = anomalies;
    if (this.useGlobe) { this.globeMap?.setClimateAnomalies(anomalies); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setClimateAnomalies(anomalies);
    }
  }

  public setRadiationObservations(observations: RadiationObservation[]): void {
    this.cachedRadiationObservations = observations;
    if (this.useGlobe) { this.globeMap?.setRadiationObservations(observations); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setRadiationObservations(observations);
    } else {
      this.svgMap?.setRadiationObservations(observations);
    }
  }

  public setDiseaseOutbreaks(outbreaks: DiseaseOutbreakItem[]): void {
    this.cachedDiseaseOutbreaks = outbreaks;
    if (this.useGlobe) return; // TODO: add globe support for disease outbreaks layer
    if (this.useDeckGL) this.deckGLMap?.setDiseaseOutbreaks(outbreaks);
  }

  public setNewsLocations(data: NewsLocationMarker[]): void {
    this.cachedNewsLocations = data;
    if (this.useGlobe) { this.globeMap?.setNewsLocations(data); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setNewsLocations(data);
    } else {
      this.svgMap?.setNewsLocations(data);
    }
  }

  public highlightAssets(assets: RelatedAsset[] | null): void {
    if (this.useDeckGL) {
      this.deckGLMap?.highlightAssets(assets);
    } else {
      this.svgMap?.highlightAssets(assets);
    }
  }

  // ─── Callback setters ────────────────────────────────────────────────────────

  public onTimeRangeChanged(callback: (range: TimeRange) => void): void {
    this.cachedOnTimeRangeChanged = callback;
    if (this.useGlobe) { this.globeMap?.onTimeRangeChanged(callback); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOnTimeRangeChange(callback); } else { this.svgMap?.onTimeRangeChanged(callback); }
  }

  public setOnLayerChange(callback: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void {
    this.cachedOnLayerChange = callback;
    if (this.useGlobe) { this.globeMap?.setOnLayerChange(callback); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOnLayerChange(callback); } else { this.svgMap?.setOnLayerChange(callback); }
  }

  public getBbox(): string | null {
    if (this.useDeckGL) return this.deckGLMap?.getBbox() ?? null;
    if (this.useGlobe) return this.globeMap?.getBbox() ?? null;
    return null;
  }

  public onStateChanged(callback: (state: MapContainerState) => void): void {
    this.cachedOnStateChanged = callback;
    if (this.useGlobe) { this.globeMap?.onStateChanged(callback); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setOnStateChange((state) => {
        callback({ ...state, view: state.view as MapView });
      });
    } else {
      this.svgMap?.onStateChanged(callback);
    }
  }

  // UI visibility methods
  public hideLayerToggle(layer: keyof MapLayers): void {
    this.hiddenLayerToggles.add(layer);
    if (this.useGlobe) { this.globeMap?.hideLayerToggle(layer); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.hideLayerToggle(layer);
    } else {
      this.svgMap?.hideLayerToggle(layer);
    }
  }

  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    this.layerLoadingState.set(layer, loading);
    if (this.useGlobe) { this.globeMap?.setLayerLoading(layer, loading); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setLayerLoading(layer, loading);
    } else {
      this.svgMap?.setLayerLoading(layer, loading);
    }
  }

  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    this.layerReadyState.set(layer, hasData);
    if (this.useGlobe) { this.globeMap?.setLayerReady(layer, hasData); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.setLayerReady(layer, hasData);
    } else {
      this.svgMap?.setLayerReady(layer, hasData);
    }
  }

  public flashAssets(assetType: AssetType, ids: string[]): void {
    if (this.useDeckGL) {
      this.deckGLMap?.flashAssets(assetType, ids);
    }
    // SVG map doesn't have flashAssets - only supported in deck.gl mode
  }

  // Layer enable/disable and trigger methods
  public enableLayer(layer: keyof MapLayers): void {
    // #6045 — don't stamp initialState or enable locked premium layers for free users.
    if (!isLayerEntitled(layer, hasPremiumAccess(getAuthState()))) return;
    this.initialState = {
      ...this.initialState,
      layers: { ...this.initialState.layers, [layer]: true },
    };
    if (!this.hasActiveRenderer()) return;
    if (this.useGlobe) { this.globeMap?.enableLayer(layer); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.enableLayer(layer);
    } else {
      this.svgMap?.enableLayer(layer);
    }
  }

  public triggerPipelineClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerPipelineClick(id);
    } else {
      this.svgMap?.triggerPipelineClick(id);
    }
  }

  public triggerCableClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerCableClick(id);
    } else {
      this.svgMap?.triggerCableClick(id);
    }
  }

  public triggerDatacenterClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerDatacenterClick(id);
    } else {
      this.svgMap?.triggerDatacenterClick(id);
    }
  }

  public triggerNuclearClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerNuclearClick(id);
    } else {
      this.svgMap?.triggerNuclearClick(id);
    }
  }

  public triggerIrradiatorClick(id: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.triggerIrradiatorClick(id);
    } else {
      this.svgMap?.triggerIrradiatorClick(id);
    }
  }

  public flashLocation(lat: number, lon: number, durationMs?: number): void {
    if (this.useGlobe) { this.globeMap?.flashLocation(lat, lon, durationMs); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.flashLocation(lat, lon, durationMs);
    } else {
      this.svgMap?.flashLocation(lat, lon, durationMs);
    }
  }

  public onNewsClicked(callback: (item: Pick<NewsLocationMarker, 'article' | 'title'>) => void): void {
    this.cachedOnNewsClicked = callback;
    if (this.useGlobe) { this.globeMap?.setOnNewsClick(callback); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOnNewsClick(callback); } else { this.svgMap?.setOnNewsClick(callback); }
  }

  public onCountryClicked(callback: (country: CountryClickPayload) => void): void {
    this.cachedOnCountryClicked = callback;
    if (this.useGlobe) { this.globeMap?.setOnCountryClick(callback); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOnCountryClick(callback); } else { this.svgMap?.setOnCountryClick(callback); }
  }

  public onMapContextMenu(callback: (payload: { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string }) => void): void {
    this.cachedOnMapContextMenu = callback;
    if (this.useGlobe) { this.globeMap?.setOnMapContextMenu(callback); return; }
    if (this.useDeckGL) { this.deckGLMap?.setOnMapContextMenu(callback); }
  }

  public fitCountry(code: string): void {
    if (this.useGlobe) { this.globeMap?.fitCountry(code); return; }
    if (this.useDeckGL) {
      this.deckGLMap?.fitCountry(code);
    } else {
      this.svgMap?.fitCountry(code);
    }
  }

  public highlightCountry(code: string): void {
    if (this.useDeckGL) {
      this.deckGLMap?.highlightCountry(code);
    }
  }

  public clearCountryHighlight(): void {
    if (this.useDeckGL) {
      this.deckGLMap?.clearCountryHighlight();
    }
  }

  public setRenderPaused(paused: boolean): void {
    if (this.useDeckGL) {
      this.deckGLMap?.setRenderPaused(paused);
    }
  }

  // ─── Route Highlight ─────────────────────────────────────────────────────────

  // ─── Scenario Engine ─────────────────────────────────────────────────────────

  // Utility methods
  public isDeckGLMode(): boolean {
    return this.useDeckGL;
  }

  public isMobileMode(): boolean {
    return this.isMobile;
  }

  public destroy(): void {
    this.destroyed = true;
    this.container.removeEventListener('pointerdown', this.invalidateViewportAuthority);
    this.container.removeEventListener('wheel', this.invalidateViewportAuthority);
    this.container.removeEventListener('touchstart', this.invalidateViewportAuthority);
    this.container.removeEventListener('keydown', this.invalidateViewportAuthority);
    this.rendererReady = false;
    const rendererReadyWaiters = Array.from(this.rendererReadyWaiters);
    this.rendererReadyWaiters.clear();
    for (const waiter of rendererReadyWaiters) {
      waiter.reject(new Error('Map renderer is no longer available.'));
    }
    this.releaseRendererDemand = null;
    this.resizeObserver?.disconnect();
    this.rendererDemandCleanup?.();
    this.rendererDemandCleanup = null;
    this.globeInitToken++;
    this.rendererInitToken++;
    this.globeMap?.destroy();
    this.deckGLMap?.destroy();
    this.svgMap?.destroy();
    this.clearCache();
  }

  private clearCache(): void {
    this.cachedOnStateChanged = null;
    this.cachedOnLayerChange = null;
    this.cachedOnTimeRangeChanged = null;
    this.cachedOnCountryClicked = null;
    this.cachedOnNewsClicked = null;
    this.cachedOnMapContextMenu = null;
    this.cachedEarthquakes = null;
    this.cachedWeatherAlerts = null;
    this.cachedOutages = null;
    this.cachedCableAdvisories = null;
    this.cachedRepairShips = null;
    this.cachedCableHealth = null;
    this.cachedNaturalEvents = null;
    this.cachedFires = null;
    this.cachedClimateAnomalies = null;
    this.cachedRadiationObservations = null;
    this.cachedDiseaseOutbreaks = null;
    this.cachedNewsLocations = null;
    this.cachedTrafficAnomalies = null;
    this.cachedDdosLocations = null;
    this.pendingCenter = null;
    this.pendingViewportActions = [];
    this.hiddenLayerToggles.clear();
    this.layerLoadingState.clear();
    this.layerReadyState.clear();
  }
}
