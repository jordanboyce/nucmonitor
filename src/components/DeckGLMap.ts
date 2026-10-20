/**
 * DeckGLMap - WebGL-accelerated map visualization for desktop
 * Uses deck.gl for high-performance rendering of large datasets
 * Mobile devices gracefully degrade to the D3/SVG-based Map component
 */
import { MapLibreOverlay } from '@deck.gl/maplibre';
import type { Layer, LayersList, PickingInfo } from '@deck.gl/core';
import { ScatterplotLayer, PathLayer, IconLayer, TextLayer, PolygonLayer } from '@deck.gl/layers';
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { StyleSpecification } from 'maplibre-gl';
import { FALLBACK_DARK_STYLE, FALLBACK_LIGHT_STYLE, getMapProvider, getMapTheme, isLightMapTheme } from '@/config/basemap';
import { getStyleForProvider } from '@/config/basemap-styles';
import Supercluster from 'supercluster';
import type {
  MapLayers,
  NewsLocationMarker,
  InternetOutage,
  RelatedAsset,
  AssetType,
  CableAdvisory,
  RepairShip,
  AIDataCenter,
  NaturalEvent,
  MapDatacenterCluster,
  CableHealthRecord,
  NuclearFacility,
} from '@/types';
import { getWindColor } from '@/config/wind-colors';
import type { TrafficAnomaly as ProtoTrafficAnomaly, DdosLocationHit } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { Earthquake } from '@/services/earthquakes';
import type { ClimateAnomaly } from '@/services/climate';
import type { RadiationObservation } from '@/services/radiation';
import type { WeatherAlert } from '@/services/weather';
import { escapeHtml } from '@/utils/sanitize';
import { corroborationLabelHtml } from '@/utils/corroboration-flag';
import {
  derivePipelinePublicBadge,
  type PipelineEvidenceInput,
  type PipelinePublicBadge,
} from '@/shared/pipeline-evidence';
import { getCachedPipelineRegistries } from '@/shared/pipeline-registry-store';
import { t } from '@/services/i18n';
import { debounce, rafSchedule, getCurrentTheme } from '@/utils/index';
import { isInputPending } from '@/utils/after-paint';
import { showLayerWarning } from '@/utils/layer-warning';
import { localizeMapLabels } from '@/utils/map-locale';
import {
  createCountryHoverQueryController,
  resolveCountryForPointerInteraction,
  shouldRunInputSensitiveMapWork,
  type CountryHoverQueryController,
} from './map/input-delay-interactions';
import {
  GAMMA_IRRADIATORS,
  PIPELINES,
  PIPELINE_COLORS,
  SITE_VARIANT,
} from '@/config';
// ai-datacenters + geo-map tables imported directly so their chunks stay
// off the eager @/config barrel and load only with this lazy renderer (#4404).
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { UNDERSEA_CABLES, NUCLEAR_FACILITIES } from '@/config/geo-map';
import { US_NUCLEAR_FACILITIES, US_NUCLEAR_CATEGORY_LABELS, type UsNuclearFacility, type UsNuclearFacilityCategory } from '@/config/us-nuclear-facilities';
import {
  getLayersForVariant,
  resolveLayerLabel,
  bindLayerSearch,
  getLayerExplanation,
  hasCuratedLayerExplanation,
  isLayerEntitled,
  isLayerToggleAllowed,
  sanitizeLockedLayers,
} from '@/config/map-layer-definitions';
import { isProTierResolved } from '@/services/widget-store';
import { renderLayerExplanationCard } from '@/utils/layer-explanation-card';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { onEntitlementChange } from '@/services/entitlements';
import { hasPremiumAccess } from '@/services/panel-gating';
import { MapPopup, type PopupType } from './MapPopup';
import {
  canonicalizeCountryCode,
  getCountriesGeoJson,
  getCountryAtCoordinates,
  getCountryBbox,
  getCountryCentroid,
} from '@/services/country-geometry';
import type { DiseaseOutbreakItem } from '@/services/disease-outbreaks';

import { pinWebcam, isPinned } from '@/services/webcams/pinned-store';
import type { WebcamEntry, WebcamCluster } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import { fetchWebcamImage } from '@/services/webcams';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { summarizeRenderTiming, formatRenderTiming } from '@/components/map/render-timing';
import { ZoomHintGuard } from '@/components/map/zoom-hint-guard';
import { dispatchWebcamLayerClick, resolveWebcamStreamUrl, type WebcamLeafLike } from '@/components/map/webcam-click';
import {
  createCountryClickGestureTracker,
  finishCountryClickGesture,
  markCountryClickDrag,
  refreshCountryClickDragSuppression,
  shouldSuppressCountryClick,
  startCountryClickGesture,
  updateCountryClickGestureDrag,
  type CountryClickGestureTracker,
} from './map-interaction-guard';


export type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';
export type DeckMapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';
type MapInteractionMode = 'flat' | '3d';

export interface CountryClickPayload {
  lat: number;
  lon: number;
  code?: string;
  name?: string;
}

interface DeckMapState {
  zoom: number;
  pan: { x: number; y: number };
  view: DeckMapView;
  layers: MapLayers;
  timeRange: TimeRange;
}

interface DeckGLMapOptions {
  chrome?: boolean;
  mapLibreWorkerUrl?: string;
  /**
   * Fired when MapLibre cannot be (re)constructed after the initial ready
   * handshake — e.g. WebGL2 lost mid-session while recreating the fallback
   * basemap. MapContainer uses this to degrade to the SVG renderer.
   */
  onFatalError?: (error: unknown) => void;
}

// View presets with longitude, latitude, zoom
const VIEW_PRESETS: Record<DeckMapView, { longitude: number; latitude: number; zoom: number }> = {
  global: { longitude: 0, latitude: 20, zoom: 1.5 },
  america: { longitude: -95, latitude: 38, zoom: 3 },
  mena: { longitude: 45, latitude: 28, zoom: 3.5 },
  eu: { longitude: 15, latitude: 50, zoom: 3.5 },
  asia: { longitude: 105, latitude: 35, zoom: 3 },
  latam: { longitude: -60, latitude: -15, zoom: 3 },
  africa: { longitude: 20, latitude: 5, zoom: 3 },
  oceania: { longitude: 135, latitude: -25, zoom: 3.5 },
};

const VIEWPORT_MOVEMENT_EVENT_KEY = 'worldMonitorViewportGeneration';

type ViewportMovementEventData = {
  worldMonitorViewportGeneration?: unknown;
};

const MAP_INTERACTION_MODE: MapInteractionMode =
  import.meta.env.VITE_MAP_INTERACTION_MODE === 'flat' ? 'flat' : '3d';

// Zoom thresholds for layer visibility and labels (matches old Map.ts)
// Zoom-dependent layer visibility and labels
const LAYER_ZOOM_THRESHOLDS: Partial<Record<keyof MapLayers, { minZoom: number; showLabels?: number }>> = {
  nuclear: { minZoom: 3 },
  natural: { minZoom: 1, showLabels: 2 },
  datacenters: { minZoom: 5 },
  irradiators: { minZoom: 4 },
};
// Export for external use
export { LAYER_ZOOM_THRESHOLDS };

// Theme-aware overlay color function — refreshed each buildLayers() call
function getOverlayColors() {
  const isLight = getCurrentTheme() === 'light';
  return {
    // Threat dots: IDENTICAL in both modes (user locked decision)
    hotspotHigh: [255, 68, 68, 200] as [number, number, number, number],
    hotspotElevated: [255, 165, 0, 200] as [number, number, number, number],
    hotspotLow: [255, 255, 0, 180] as [number, number, number, number],

    // Conflict zone fills: more transparent in light mode
    conflict: isLight
      ? [255, 0, 0, 60] as [number, number, number, number]
      : [255, 0, 0, 100] as [number, number, number, number],

    // Infrastructure/category markers: darker variants in light mode for map readability
    base: [0, 150, 255, 200] as [number, number, number, number],
    nuclear: isLight
      ? [180, 120, 0, 220] as [number, number, number, number]
      : [255, 215, 0, 200] as [number, number, number, number],
    datacenter: isLight
      ? [13, 148, 136, 200] as [number, number, number, number]
      : [0, 255, 200, 180] as [number, number, number, number],
    cable: [0, 200, 255, 150] as [number, number, number, number],
    cableHighlight: [255, 100, 100, 200] as [number, number, number, number],
    cableFault: [255, 50, 50, 220] as [number, number, number, number],
    cableDegraded: [255, 165, 0, 200] as [number, number, number, number],
    earthquake: [255, 100, 50, 200] as [number, number, number, number],
    vesselMilitary: [255, 100, 100, 220] as [number, number, number, number],
    protest: [255, 150, 0, 200] as [number, number, number, number],
    outage: [255, 50, 50, 180] as [number, number, number, number],
    trafficAnomaly: [255, 160, 0, 200] as [number, number, number, number],
    ddosHit: [180, 0, 255, 200] as [number, number, number, number],
    weather: [100, 150, 255, 180] as [number, number, number, number],
    canadaRoads: [255, 140, 0, 190] as [number, number, number, number],
    canadaRoadsClosure: [220, 40, 40, 210] as [number, number, number, number],
    canadaAlerts: [220, 50, 50, 200] as [number, number, number, number],
    stockExchange: isLight
      ? [20, 120, 200, 220] as [number, number, number, number]
      : [80, 200, 255, 210] as [number, number, number, number],
    financialCenter: isLight
      ? [0, 150, 110, 215] as [number, number, number, number]
      : [0, 220, 150, 200] as [number, number, number, number],
    centralBank: isLight
      ? [180, 120, 0, 220] as [number, number, number, number]
      : [255, 210, 80, 210] as [number, number, number, number],
    commodityHub: isLight
      ? [190, 95, 40, 220] as [number, number, number, number]
      : [255, 150, 80, 200] as [number, number, number, number],
    gulfInvestmentSA: [0, 168, 107, 220] as [number, number, number, number],
    gulfInvestmentUAE: [255, 0, 100, 220] as [number, number, number, number],
    ucdpStateBased: [255, 50, 50, 200] as [number, number, number, number],
    ucdpNonState: [255, 165, 0, 200] as [number, number, number, number],
    ucdpOneSided: [255, 255, 0, 200] as [number, number, number, number],
  };
}
// Initialize and refresh on every buildLayers() call
let COLORS = getOverlayColors();

// SVG icons as data URLs for different marker shapes
const MARKER_ICONS = {
  // Square - for datacenters
  square: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="3" fill="white"/></svg>`),
  // Diamond - for hotspots
  diamond: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 30,16 16,30 2,16" fill="white"/></svg>`),
  // Triangle up - for military bases
  triangleUp: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 30,28 2,28" fill="white"/></svg>`),
  // Hexagon - for nuclear
  hexagon: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 28,9 28,23 16,30 4,23 4,9" fill="white"/></svg>`),
  // Circle - fallback
  circle: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="white"/></svg>`),
  // Star - for special markers
  star: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><polygon points="16,2 20,12 30,12 22,19 25,30 16,23 7,30 10,19 2,12 12,12" fill="white"/></svg>`),
  // Airplane silhouette - top-down with wings and tail (pointing north, rotated by trackDeg)
  plane: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="M16 2 L17.5 10 L17 12 L27 17 L27 19 L17 16 L17 24 L20 26.5 L20 28 L16 27 L12 28 L12 26.5 L15 24 L15 16 L5 19 L5 17 L15 12 L14.5 10 Z" fill="white"/></svg>`),
};

const NUCLEAR_ICON_MAPPING = { hexagon: { x: 0, y: 0, width: 32, height: 32, mask: true } };

// NucMonitor registry layer palette, keyed by facility category.
const US_NUCLEAR_LAYER_COLORS: Record<UsNuclearFacilityCategory, [number, number, number, number]> = {
  'power-reactor': [245, 197, 24, 230],
  restart: [46, 204, 113, 230],
  'new-build': [52, 152, 219, 230],
  decommissioning: [149, 165, 166, 200],
  'fuel-cycle': [155, 89, 182, 230],
  'doe-site': [231, 76, 60, 220],
  'research-reactor': [26, 188, 156, 220],
  'uranium-recovery': [230, 126, 34, 220],
  waste: [127, 140, 141, 200],
};
const DATACENTER_ICON_MAPPING = { square: { x: 0, y: 0, width: 32, height: 32, mask: true } };

/**
 * Webcam markers carry an explicit leaf/group discriminant tagged at setWebcams
 * ingestion, mirroring GlobeMap's `_kind: 'webcam' | 'webcam-cluster'` union.
 * Existing consumers still narrow on `'count' in d`; `_kind` makes the
 * distinction available at the type level for new code without re-deriving it.
 */
type WebcamLeafMarker = WebcamEntry & { _kind: 'webcam' };
type WebcamClusterMarker = WebcamCluster & { _kind: 'webcam-cluster' };
type WebcamMarker = WebcamLeafMarker | WebcamClusterMarker;

// Process-wide guard so the window error listener for the deck.gl/maplibre
// interleaved-mode render race is installed exactly once even if a hot-reload
// or recreateWithFallback rebuilds the map.
let __deckInterleavedRaceFilterInstalled = false;

const DECK_INTERLEAVED_RACE_MESSAGE_RE = /Cannot read properties of null \(reading 'id'\)|null is not an object \(evaluating '[\w.]+\.id'\)/;
const DECK_INTERLEAVED_RACE_SOURCE_RE = /(?:^|[/(])deck-stack-[A-Za-z0-9_-]+\.js/;

/**
 * Swallow the well-known deck.gl 9.x + maplibre-gl 5.x interleaved-mode race:
 *
 *   Uncaught TypeError: Cannot read properties of null (reading 'id')
 *     at DeckRenderer._drawLayers (deck-stack-*.js)
 *     at LayerManager.renderLayers
 *     at MapLibre painter.renderLayer (maplibre-*.js)
 *
 * Trigger: setProps({layers}) → deck _resolveLayers calls maplibre.removeLayer
 * for a layer that's being swapped → maplibre schedules a triggerRepaint that
 * fires the next frame → that repaint runs deck's `render()` via maplibre's
 * custom-layer hook → deck iterates the layer list and hits a layer that was
 * finalized between resolveLayers and renderLayers.
 *
 * MapLibreOverlay's own onError is bypassed because maplibre — not deck — owns
 * the render-loop callstack here (deck doesn't see the throw, so onError is
 * never invoked). The next frame renders cleanly with no user-visible
 * artifact, so swallowing here is safe.
 *
 * Sentry's beforeSend in main.ts already filters this exact pattern for
 * telemetry, but the browser still logs "Uncaught TypeError" to the console
 * — this listener suppresses that.
 *
 * Narrow on BOTH the message shape AND deck-stack chunk evidence so an
 * unrelated null-id crash in first-party code still surfaces. Some browsers
 * surface the exception through Sentry's rAF wrapper, so ev.filename can point
 * at sentry-*.js while ev.error.stack still contains deck-stack-*.js.
 */
function installDeckInterleavedRaceFilter(): void {
  if (__deckInterleavedRaceFilterInstalled) return;
  __deckInterleavedRaceFilterInstalled = true;
  window.addEventListener('error', (ev) => {
    const msg = ev.error?.message ?? ev.message ?? '';
    const file = ev.filename ?? '';
    const stack = typeof ev.error?.stack === 'string' ? ev.error.stack : '';
    const source = `${file}\n${stack}`;
    if (
      DECK_INTERLEAVED_RACE_MESSAGE_RE.test(msg)
      && DECK_INTERLEAVED_RACE_SOURCE_RE.test(source)
    ) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      if (import.meta.env.DEV) {
        console.warn('[DeckGLMap] swallowed interleaved-mode render race (deck.gl/maplibre)');
      }
    }
  }, { capture: true });
}

export class DeckGLMap {
  private static readonly MAX_CLUSTER_LEAVES = 200;

  private container: HTMLElement;
  private deckOverlay: MapLibreOverlay | null = null;
  private maplibreMap: maplibregl.Map | null = null;
  private state: DeckMapState;
  private popup: MapPopup;
  private isResizing = false;
  private savedTopLat: number | null = null;
  private correctingCenter = false;

  private earthquakes: Earthquake[] = [];
  private weatherAlerts: WeatherAlert[] = [];
  private outages: InternetOutage[] = [];
  private trafficAnomalies: ProtoTrafficAnomaly[] = [];
  private ddosLocations: DdosLocationHit[] = [];
  private _unsubscribeAuthState: (() => void) | null = null;
  private _unsubscribeEntitlement: (() => void) | null = null;
  private cableAdvisories: CableAdvisory[] = [];
  private repairShips: RepairShip[] = [];
  private healthByCableId: Record<string, CableHealthRecord> = {};
  private naturalEvents: NaturalEvent[] = [];
  private firmsFireData: Array<{ lat: number; lon: number; brightness: number; frp: number; confidence: number; region: string; acq_date: string; daynight: string }> = [];
  private newsLocations: NewsLocationMarker[] = [];
  private newsLocationFirstSeen = new Map<string, number>();
  private climateAnomalies: ClimateAnomaly[] = [];
  private radiationObservations: RadiationObservation[] = [];
  private diseaseOutbreaks: DiseaseOutbreakItem[] = [];
  // Guards updateZoomHints() so a repeated updateLayers() pass skips the
  // toggle-DOM scan when zoom, layer flags, and row nodes are unchanged (#7776).
  private readonly zoomHintGuard = new ZoomHintGuard();

  private webcamData: WebcamMarker[] = [];

  // Country highlight state
  private countryGeoJsonLoaded = false;
  private countryHoverSetup = false;
  private highlightedCountryCode: string | null = null;
  private hoveredCountryIso2: string | null = null;
  private hoveredCountryName: string | null = null;

  // Callbacks
  private onNewsClick?: (item: Pick<NewsLocationMarker, 'article' | 'title'>) => void;
  private onTimeRangeChange?: (range: TimeRange) => void;
  private onCountryClick?: (country: CountryClickPayload) => void;
  private onMapContextMenu?: (payload: { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string }) => void;
  private readonly countryClickGesture: CountryClickGestureTracker = createCountryClickGestureTracker();
  private readonly handleCountryClickPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.isPrimary === false) return;
    startCountryClickGesture(this.countryClickGesture, { x: e.clientX, y: e.clientY });
  };
  private readonly handleCountryClickPointerMove = (e: PointerEvent): void => {
    if (e.isPrimary === false) return;
    updateCountryClickGestureDrag(this.countryClickGesture, { x: e.clientX, y: e.clientY });
  };
  private readonly handleCountryClickPointerEnd = (): void => {
    finishCountryClickGesture(this.countryClickGesture);
  };
  private readonly markCountryDragGesture = (): void => {
    markCountryClickDrag(this.countryClickGesture);
  };
  private readonly refreshCountryDragSuppression = (): void => {
    refreshCountryClickDragSuppression(this.countryClickGesture);
  };
  private attachMapLibreInteractionHandlers(): void {
    if (!this.maplibreMap) return;
    const canvas = this.maplibreMap.getCanvas();
    canvas.addEventListener('contextmenu', this.handleContextMenu);
    canvas.addEventListener('pointerdown', this.handleCountryClickPointerDown);
    canvas.addEventListener('pointermove', this.handleCountryClickPointerMove);
    canvas.addEventListener('pointerup', this.handleCountryClickPointerEnd);
    canvas.addEventListener('pointercancel', this.handleCountryClickPointerEnd);
    this.maplibreMap.on('dragstart', this.markCountryDragGesture);
    this.maplibreMap.on('dragend', this.refreshCountryDragSuppression);
  }
  private detachMapLibreInteractionHandlers(): void {
    if (!this.maplibreMap) return;
    const canvas = this.maplibreMap.getCanvas();
    this.maplibreMap.off('dragstart', this.markCountryDragGesture);
    this.maplibreMap.off('dragend', this.refreshCountryDragSuppression);
    canvas.removeEventListener('contextmenu', this.handleContextMenu);
    canvas.removeEventListener('pointerdown', this.handleCountryClickPointerDown);
    canvas.removeEventListener('pointermove', this.handleCountryClickPointerMove);
    canvas.removeEventListener('pointerup', this.handleCountryClickPointerEnd);
    canvas.removeEventListener('pointercancel', this.handleCountryClickPointerEnd);
  }
  private readonly handleContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (!this.onMapContextMenu || !this.maplibreMap) return;
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const lngLat = this.maplibreMap.unproject([x, y]);
    if (!Number.isFinite(lngLat.lng)) return;
    const country = resolveCountryForPointerInteraction(
      {
        code: this.hoveredCountryIso2
          ? canonicalizeCountryCode(this.hoveredCountryIso2)
          : this.hoveredCountryIso2,
        name: this.hoveredCountryName,
      },
      this.hoverQueryThrottle?.isPending() ?? false,
      () => this.resolveCountryFromCoordinate(lngLat.lng, lngLat.lat),
    );
    this.onMapContextMenu({
      lat: lngLat.lat,
      lon: lngLat.lng,
      screenX: e.clientX,
      screenY: e.clientY,
      countryCode: country?.code ? canonicalizeCountryCode(country.code) : country?.code,
      countryName: country?.name,
    });
  };
  private onLayerChange?: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void;
  private onStateChange?: (state: DeckMapState) => void;

  // Highlighted assets
  /** NucMonitor — facility whose 10/50-mile EPZ rings are drawn (null = none). */
  private selectedUsNuclearFacility: UsNuclearFacility | null = null;
  private highlightedAssets: Record<AssetType, Set<string>> = {
    pipeline: new Set(),
    cable: new Set(),
    datacenter: new Set(),
    nuclear: new Set(),
  };

  private renderRafId: number | null = null;
  private renderPaused = false;
  private renderPending = false;
  private webglLost = false;
  private destroyed = false;
  private usedFallbackStyle = false;
  private readonly chrome: boolean;
  private readonly mapLibreWorkerUrl: string | undefined;
  private readonly onFatalError: ((error: unknown) => void) | null;
  private initPromise: Promise<void> = Promise.resolve();
  private styleLoadTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private tileMonitorGeneration = 0;


  private layerCache: Map<string, Layer> = new Map();
  private lastZoomThreshold = 0;
  private datacenterSC: Supercluster | null = null;
  private datacenterSCSource: AIDataCenter[] = [];
  private datacenterClusters: MapDatacenterCluster[] = [];
  private lastSCZoom = -1;
  private lastSCBoundsKey = '';
  private lastSCMask = '';
  private newsPulseIntervalId: ReturnType<typeof setInterval> | null = null;
  private dayNightIntervalId: ReturnType<typeof setInterval> | null = null;
  private cachedNightPolygon: [number, number][] | null = null;
  private radarRefreshIntervalId: ReturnType<typeof setInterval> | null = null;
  private radarActive = false;
  private radarTileUrl = '';
  // Drop duplicate `once('idle', applyRadarLayer)` registrations when
  // the source isn't loaded yet. Without this, both the style.load
  // callback and the 5-minute refresh can register listeners in the
  // same load window — they'd all fire on the next idle and call
  // setTiles back-to-back. Idempotent today but wasteful.
  private radarIdlePending = false;
  private readonly startupTime = Date.now();
  private basemapSwitchSeq = 0;
  private lastCableHighlightSignature = '';
  private lastCableHealthSignature = '';
  private lastPipelineHighlightSignature = '';
  // Static facility catalogs filtered once per map instance (#7777). The
  // nuclear and data-center builders run on every render; a fresh .filter()
  // per render hands deck.gl a new data container each time, so the
  // instance attributes are rebuilt even when nothing changed. The
  // highlight Sets are mutated in place, so the same arrays must stay
  // referentially stable while a sorted-content signature (never the Set
  // object) drives updateTriggers.getSize/getColor.
  private activeNuclearFacilities: NuclearFacility[] | null = null;
  private activeDatacenters: AIDataCenter[] | null = null;
  private debouncedRebuildLayers: (() => void) & { cancel(): void };
  private rafUpdateLayers: (() => void) & { cancel(): void };
  private handleThemeChange: () => void;
  private handleMapThemeChange: () => void;
  private moveTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private viewportSettleTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private viewportSettledPromise: Promise<boolean> = Promise.resolve(true);
  private resolveViewportSettled: ((completed: boolean) => void) | null = null;
  private viewportTarget: { lat: number; lon: number; zoom: number } | null = null;
  private viewportSettleDeadline = 0;
  private viewportMovementGeneration = 0;
  /** Target center set eagerly by setView() so getCenter() returns the correct
   *  destination before moveend fires, preventing stale intermediate coords
   *  from being written to the URL during flyTo. Cleared on moveend. */
  private pendingCenter: { lat: number; lon: number } | null = null;

  constructor(container: HTMLElement, initialState: DeckMapState, options: DeckGLMapOptions = {}) {
    this.container = container;
    this.chrome = options.chrome ?? true;
    this.mapLibreWorkerUrl = options.mapLibreWorkerUrl;
    this.onFatalError = options.onFatalError ?? null;
    this.state = {
      ...initialState,
      pan: { ...initialState.pan },
      layers: { ...initialState.layers },
    };

    this.debouncedRebuildLayers = debounce(() => {
      if (this.renderPaused || this.webglLost || !this.maplibreMap) return;
      this.maplibreMap.resize();
      this.updateLayers();
    }, 150);
    this.rafUpdateLayers = rafSchedule(() => {
      if (this.renderPaused || this.webglLost || !this.maplibreMap) return;
      this.updateLayers();
    });

    this.setupDOM();
    this.popup = new MapPopup(container);

    this.handleThemeChange = () => {
      const provider = getMapProvider();
      const mapTheme = getMapTheme(provider);
      const paintTheme = isLightMapTheme(mapTheme) ? 'light' as const : 'dark' as const;
      this.updateCountryLayerPaint(paintTheme);
      this.render();
    };
    window.addEventListener('theme-changed', this.handleThemeChange);

    this.handleMapThemeChange = () => {
      void this.switchBasemap();
    };
    window.addEventListener('map-theme-changed', this.handleMapThemeChange);

    this.initPromise = this.initMapLibre();

    if (this.chrome) {
      this.createControls();
      this.createTimeSlider();
      this.createLayerToggles();
      this.createLegend();
    }

    // Start day/night timer only if layer is initially enabled
    if (this.state.layers.dayNight) {
      this.startDayNightTimer();
    }
    if (this.state.layers.weather) {
      this.startWeatherRadar();
    }
  }

  private startDayNightTimer(): void {
    if (this.dayNightIntervalId) return;
    this.cachedNightPolygon = this.computeNightPolygon();
    this.dayNightIntervalId = setInterval(() => {
      this.cachedNightPolygon = this.computeNightPolygon();
      this.render();
    }, 5 * 60 * 1000);
  }

  private stopDayNightTimer(): void {
    if (this.dayNightIntervalId) {
      clearInterval(this.dayNightIntervalId);
      this.dayNightIntervalId = null;
    }
    this.cachedNightPolygon = null;
  }

  private startWeatherRadar(): void {
    this.radarActive = true;
    this.fetchAndApplyRadar();
    if (!this.radarRefreshIntervalId) {
      this.radarRefreshIntervalId = setInterval(() => this.fetchAndApplyRadar(), 5 * 60 * 1000);
    }
  }

  private stopWeatherRadar(): void {
    this.radarActive = false;
    if (this.radarRefreshIntervalId) {
      clearInterval(this.radarRefreshIntervalId);
      this.radarRefreshIntervalId = null;
    }
    this.removeRadarLayer();
  }

  private fetchAndApplyRadar(): void {
    fetch('https://api.rainviewer.com/public/weather-maps.json')
      .then(r => r.json())
      .then((data: { host: string; radar: { past: Array<{ path: string }> } }) => {
        const past = data.radar?.past;
        const latest = past?.[past.length - 1];
        if (!latest) return;
        this.radarTileUrl = `${data.host}${latest.path}/256/{z}/{x}/{y}/6/1_1.png`;
        this.applyRadarLayer();
      })
      .catch((err) => console.warn('[DeckGLMap] weather radar fetch failed:', err?.message || err));
  }

  private applyRadarLayer(): void {
    if (!this.maplibreMap || !this.radarActive || !this.radarTileUrl) return;
    if (!this.maplibreMap.isStyleLoaded()) {
      this.maplibreMap.once('style.load', () => this.applyRadarLayer());
      return;
    }
    try {
      const existing = this.maplibreMap.getSource('weather-radar') as (maplibregl.RasterTileSource & { setTiles: (tiles: string[]) => void }) | undefined;
      if (existing) {
        // Guard against the source existing in the style registry while
        // its underlying texture is mid-load or being torn down. Calling
        // setTiles in that window triggers a render-frame crash inside
        // MapLibre at fa() / texture.bind() (Sentry WORLDMONITOR-P6:
        // Firefox 149, hit on the 5-minute radar refresh interval).
        // isSourceLoaded(id) is MapLibre's official "tiles fetched +
        // applied to GL state" check; defer to the next idle if false.
        if (!this.maplibreMap.isSourceLoaded('weather-radar')) {
          if (!this.radarIdlePending) {
            this.radarIdlePending = true;
            this.maplibreMap.once('idle', () => {
              this.radarIdlePending = false;
              this.applyRadarLayer();
            });
          }
          return;
        }
        existing.setTiles([this.radarTileUrl]);
        return;
      }
      this.maplibreMap.addSource('weather-radar', {
        type: 'raster',
        tiles: [this.radarTileUrl],
        tileSize: 256,
        attribution: '© RainViewer',
      });
      const beforeId = this.maplibreMap.getLayer('country-interactive') ? 'country-interactive' : undefined;
      this.maplibreMap.addLayer({
        id: 'weather-radar-layer',
        type: 'raster',
        source: 'weather-radar',
        paint: { 'raster-opacity': 0.65 },
      }, beforeId);
    } catch (err) { console.warn('[DeckGLMap] radar layer apply failed:', (err as Error)?.message); }
  }

  private removeRadarLayer(): void {
    if (!this.maplibreMap) return;
    try {
      if (this.maplibreMap.getLayer('weather-radar-layer')) this.maplibreMap.removeLayer('weather-radar-layer');
      if (this.maplibreMap.getSource('weather-radar')) this.maplibreMap.removeSource('weather-radar');
    } catch { /* ignore */ }
  }

  private setupDOM(): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'deckgl-map-wrapper';
    wrapper.id = 'deckglMapWrapper';
    wrapper.style.cssText = 'position: relative; width: 100%; height: 100%; overflow: hidden;';

    // MapLibre container - deck.gl renders directly into MapLibre via MapLibreOverlay
    const mapContainer = document.createElement('div');
    mapContainer.id = 'deckgl-basemap';
    mapContainer.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%;';
    wrapper.appendChild(mapContainer);

    const attribution = document.createElement('div');
    attribution.className = 'map-attribution';
    setTrustedHtml(attribution, trustedHtml('© <a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>', "legacy direct innerHTML migration"));
    wrapper.appendChild(attribution);

    this.container.appendChild(wrapper);
  }

  /**
   * Resolves once the initial MapLibre construction has settled (success, or a
   * guarded teardown that bailed before constructing the map). Rejects if map
   * construction throws (e.g. a WebGL init failure), letting
   * MapContainer.createDeckGLMap fall back to the SVG renderer — the failure
   * path that the fire-and-forget `void this.initMapLibre()` would otherwise
   * swallow into an unhandled rejection + blank map.
   */
  public whenReady(): Promise<void> {
    return this.initPromise;
  }

  private async initMapLibre(): Promise<void> {
    maplibregl.setWorkerUrl(this.mapLibreWorkerUrl ?? maplibreWorkerUrl);
    // No `setRTLTextPlugin` here: MapLibre 6 shapes Arabic and reorders
    // bidirectional text itself and deprecates the plugin. Registering the
    // self-hosted plugin after the 6.x upgrade also broke RTL labels outright —
    // the v6 worker loads a non-`.mjs` plugin URL with `globalThis.eval`, which
    // the dashboard CSP blocks (WORLDMONITOR-12T; tests/map-locale.test.mts).

    const { mapTheme: initialMapTheme, style: primaryStyle } = await this.resolveInitialBasemapStyle();
    // The component can be torn down (renderer switch) while the style import
    // above is in flight; bail before constructing a MapLibre map that destroy()
    // can no longer reach — it would orphan a live WebGL context, its listeners
    // and the 10s styleLoadTimeoutId.
    if (this.destroyed) return;

    const preset = VIEW_PRESETS[this.state.view];
    if (typeof primaryStyle === 'string' && !primaryStyle.includes('pmtiles')) {
      this.usedFallbackStyle = true;
      const attr = this.container.querySelector('.map-attribution');
      if (attr) setTrustedHtml(attr, trustedHtml('© <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>', "legacy direct innerHTML migration"));
    }

    const basemapEl = document.getElementById('deckgl-basemap');
    if (!basemapEl) return;

    this.maplibreMap = new maplibregl.Map({
      container: basemapEl,
      style: primaryStyle,
      center: [preset.longitude, preset.latitude],
      // Fresh-load default = view preset zoom. Any zoom set during the deferred
      // renderer window is re-applied by MapContainer.rehydrateActiveMap() after
      // mount, so seeding from this.state.zoom here only undershoots the preset
      // on the default desktop view.
      zoom: preset.zoom,
      renderWorldCopies: false,
      attributionControl: false,
      interactive: true,
      canvasContextAttributes: { powerPreference: 'high-performance' },
      ...(MAP_INTERACTION_MODE === 'flat'
        ? {
          maxPitch: 0,
          pitchWithRotate: false,
          dragRotate: false,
          touchPitch: false,
        }
        : {}),
    });

    const reportFatalBasemapFailure = (error: unknown, center = this.getCenter()): void => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[DeckGLMap] Basemap fallback unavailable — handing off to SVG:', message);
      this.pendingCenter = center;
      // Defer so we never destroy() while still inside MapLibre construction /
      // a style-load timer callback (Sentry WORLDMONITOR-133).
      queueMicrotask(() => {
        if (this.destroyed) return;
        try {
          this.onFatalError?.(error);
        } catch (callbackError) {
          console.warn('[DeckGLMap] Fatal-error callback failed:', callbackError);
        }
      });
    };

    const recreateWithFallback = () => {
      if (this.usedFallbackStyle || this.destroyed) return;
      const center = this.getCenter();
      this.state.zoom = this.maplibreMap?.getZoom() ?? this.state.zoom;
      // Style-load timeout still fires after webglcontextlost. Rebuilding
      // MapLibre without WebGL2 throws GPUInitializationError as an uncaught
      // window.onerror (Sentry WORLDMONITOR-133). Skip recreate and degrade.
      if (this.webglLost) {
        this.usedFallbackStyle = true;
        if (this.styleLoadTimeoutId) {
          clearTimeout(this.styleLoadTimeoutId);
          this.styleLoadTimeoutId = null;
        }
        reportFatalBasemapFailure(
          new Error('WebGL context lost during primary basemap fallback recreate'),
        );
        return;
      }
      this.usedFallbackStyle = true;
      const fallback = isLightMapTheme(initialMapTheme) ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE;
      console.warn(`[DeckGLMap] Primary basemap failed, recreating with fallback: ${fallback}`);
      const attr = this.container.querySelector('.map-attribution');
      if (attr) setTrustedHtml(attr, trustedHtml('© <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>', "legacy direct innerHTML migration"));
      this.detachMapLibreInteractionHandlers();
      try {
        this.maplibreMap?.remove();
      } catch (error) {
        console.warn('[DeckGLMap] Failed to remove primary basemap before fallback:', error instanceof Error ? error.message : error);
      }
      this.maplibreMap = null;
      const fallbackEl = document.getElementById('deckgl-basemap');
      if (!fallbackEl) {
        reportFatalBasemapFailure(new Error('Missing #deckgl-basemap during fallback recreate'), center);
        return;
      }
      try {
        this.maplibreMap = new maplibregl.Map({
          container: fallbackEl,
          style: fallback,
          center: center ? [center.lon, center.lat] : [preset.longitude, preset.latitude],
          zoom: this.state.zoom,
          renderWorldCopies: false,
          attributionControl: false,
          interactive: true,
          canvasContextAttributes: { powerPreference: 'high-performance' },
          ...(MAP_INTERACTION_MODE === 'flat'
            ? {
              maxPitch: 0,
              pitchWithRotate: false,
              dragRotate: false,
              touchPitch: false,
            }
            : {}),
        });
      } catch (error) {
        // MapLibre throws GPUInitializationError synchronously when WebGL2 is
        // gone (lost context, software renderer revoked, etc.). Catch it so it
        // never reaches window.onerror; MapContainer falls back to SVG.
        reportFatalBasemapFailure(error, center);
        return;
      }
      this.maplibreMap.on('load', () => {
        this.attachMapLibreInteractionHandlers();
        localizeMapLabels(this.maplibreMap);
        this.initDeck();
        this.loadCountryBoundaries();
        this.render();
      });
    };

    this.maplibreMap.on('load', () => {
      localizeMapLabels(this.maplibreMap);
      this.initDeck();
      this.loadCountryBoundaries();
      this.render();
    });

    let tileLoadOk = false;
    let tileErrorCount = 0;

    this.maplibreMap.on('error', (e: { error?: { message?: string }; message?: string }) => {
      const msg = e.error?.message ?? e.message ?? '';
      console.warn('[DeckGLMap] map error:', msg);
      if (msg.includes('Failed to fetch') || msg.includes('AJAXError') || msg.includes('CORS') || msg.includes('NetworkError') || msg.includes('403') || msg.includes('Forbidden')) {
        tileErrorCount++;
        if (!tileLoadOk && tileErrorCount >= 2) {
          recreateWithFallback();
        }
      }
    });

    this.maplibreMap.on('data', (e: { dataType?: string }) => {
      if (e.dataType === 'source') {
        tileLoadOk = true;
        if (this.styleLoadTimeoutId) {
          clearTimeout(this.styleLoadTimeoutId);
          this.styleLoadTimeoutId = null;
        }
      }
    });

    this.styleLoadTimeoutId = setTimeout(() => {
      this.styleLoadTimeoutId = null;
      if (!tileLoadOk) recreateWithFallback();
    }, 10000);

    const canvas = this.maplibreMap.getCanvas();
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.webglLost = true;
      console.warn('[DeckGLMap] WebGL context lost — will restore when browser recovers');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.webglLost = false;
      console.info('[DeckGLMap] WebGL context restored');
      this.maplibreMap?.triggerRepaint();
    });

    // Pin top edge during drag-resize: correct center shift synchronously
    // inside MapLibre's own resize() call (before it renders the frame).
    this.maplibreMap.on('move', () => {
      if (this.correctingCenter || !this.isResizing || !this.maplibreMap) return;
      if (this.savedTopLat === null) return;

      const w = this.maplibreMap.getCanvas().clientWidth;
      if (w <= 0) return;
      const currentTop = this.maplibreMap.unproject([w / 2, 0]).lat;
      const delta = this.savedTopLat - currentTop;

      if (Math.abs(delta) > 1e-6) {
        this.correctingCenter = true;
        const c = this.maplibreMap.getCenter();
        const clampedLat = Math.max(-90, Math.min(90, c.lat + delta));
        this.maplibreMap.jumpTo({ center: [c.lng, clampedLat] });
        this.correctingCenter = false;
        // Do NOT update savedTopLat — keep the original mousedown position
        // so every frame targets the exact same geographic anchor.
      }
    });

    this.attachMapLibreInteractionHandlers();
  }

  private initDeck(): void {
    if (!this.maplibreMap) return;

    installDeckInterleavedRaceFilter();

    this.deckOverlay = new MapLibreOverlay({
      interleaved: true,
      layers: this.buildLayers(),
      getTooltip: (info: PickingInfo) => this.getTooltip(info),
      onClick: (info: PickingInfo) => this.handleClick(info),
      pickingRadius: 10,
      useDevicePixels: window.devicePixelRatio > 2 ? 2 : true,
      onError: (error: Error) => {
        console.warn('[DeckGLMap] Render error (non-fatal):', error.message);
      },
    });

    this.maplibreMap.addControl(this.deckOverlay as unknown as maplibregl.IControl);

    this.maplibreMap.on('movestart', () => {
      if (this.moveTimeoutId) {
        clearTimeout(this.moveTimeoutId);
        this.moveTimeoutId = null;
      }
    });

    this.maplibreMap.on('moveend', (event) => {
      // Snapshot before publishing state: a synchronous subscriber can start a
      // newer movement, and this old event must never settle that generation.
      const viewportMovementGeneration = this.viewportTarget
        ? this.viewportMovementGeneration
        : null;
      const eventGeneration = (event as unknown as ViewportMovementEventData)[VIEWPORT_MOVEMENT_EVENT_KEY];
      if (eventGeneration !== undefined && eventGeneration !== viewportMovementGeneration) return;
      this.pendingCenter = null;
      this.lastSCZoom = -1;
      this.rafUpdateLayers();
      this.state.zoom = this.maplibreMap?.getZoom() ?? this.state.zoom;
      this.onStateChange?.(this.getState());
      if (viewportMovementGeneration !== null) {
        queueMicrotask(() => {
          this.trySettleViewportMovement(true, viewportMovementGeneration);
        });
      }
    });

    this.maplibreMap.on('move', () => {
      if (this.moveTimeoutId) clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = setTimeout(() => {
        this.lastSCZoom = -1;
        this.rafUpdateLayers();
      }, 100);
    });

    this.maplibreMap.on('zoom', () => {
      if (this.moveTimeoutId) clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = setTimeout(() => {
        this.lastSCZoom = -1;
        this.rafUpdateLayers();
      }, 100);
    });

    this.maplibreMap.on('zoomend', () => {
      const currentZoom = Math.floor(this.maplibreMap?.getZoom() || 2);
      const thresholdCrossed = Math.abs(currentZoom - this.lastZoomThreshold) >= 1;
      if (thresholdCrossed) {
        this.lastZoomThreshold = currentZoom;
        this.debouncedRebuildLayers();
      }
      this.state.zoom = this.maplibreMap?.getZoom() ?? this.state.zoom;
      this.onStateChange?.(this.getState());
    });
  }

  public setIsResizing(value: boolean): void {
    this.isResizing = value;
    if (value && this.maplibreMap) {
      const w = this.maplibreMap.getCanvas().clientWidth;
      if (w > 0) {
        this.savedTopLat = this.maplibreMap.unproject([w / 2, 0]).lat;
      }
    } else {
      this.savedTopLat = null;
    }
  }

  private async resolveInitialBasemapStyle(): Promise<{ mapTheme: string; style: StyleSpecification | string }> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const provider = getMapProvider();
      const mapTheme = getMapTheme(provider);
      const style = await getStyleForProvider(provider, mapTheme);
      const currentProvider = getMapProvider();
      const currentMapTheme = getMapTheme(currentProvider);
      if (provider === currentProvider && mapTheme === currentMapTheme) {
        return { mapTheme, style };
      }
    }

    const provider = getMapProvider();
    const mapTheme = getMapTheme(provider);
    console.warn('[DeckGLMap] Map provider changed repeatedly during startup; using latest provider state');
    return {
      mapTheme,
      style: provider === 'carto'
        ? await getStyleForProvider(provider, mapTheme)
        : (isLightMapTheme(mapTheme) ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE),
    };
  }

  public resize(): void {
    this.maplibreMap?.resize();
  }

  private getSetSignature(set: Set<string>): string {
    return [...set].sort().join('|');
  }

  private getActiveNuclearFacilities(): NuclearFacility[] {
    this.activeNuclearFacilities ??= NUCLEAR_FACILITIES.filter(f => f.status !== 'decommissioned');
    return this.activeNuclearFacilities;
  }

  private getActiveDatacenters(): AIDataCenter[] {
    this.activeDatacenters ??= AI_DATA_CENTERS.filter(dc => dc.status !== 'decommissioned');
    return this.activeDatacenters;
  }

  private hasRecentNews(now = Date.now()): boolean {
    for (const ts of this.newsLocationFirstSeen.values()) {
      if (now - ts < 30_000) return true;
    }
    return false;
  }

  private getTimeRangeMs(range: TimeRange = this.state.timeRange): number {
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'all': Infinity,
    };
    return ranges[range];
  }

  private parseTime(value: Date | string | number | undefined | null): number | null {
    if (value == null) return null;
    const ts = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ts) ? ts : null;
  }

  private filterByTime<T>(
    items: T[],
    getTime: (item: T) => Date | string | number | undefined | null
  ): T[] {
    if (this.state.timeRange === 'all') return items;
    const cutoff = Date.now() - this.getTimeRangeMs();
    return items.filter((item) => {
      const ts = this.parseTime(getTime(item));
      return ts == null ? true : ts >= cutoff;
    });
  }

  private _timeFilterCache = new WeakMap<object, { min: number; range: TimeRange; result: unknown[] }>();

  private filterByTimeCached<T>(
    items: T[],
    getTime: (item: T) => Date | string | number | undefined | null
  ): T[] {
    const min = Math.floor(Date.now() / 60000);
    const range = this.state.timeRange;
    const cached = this._timeFilterCache.get(items as object);
    if (cached && cached.min === min && cached.range === range) return cached.result as T[];
    const result = this.filterByTime(items, getTime);
    this._timeFilterCache.set(items as object, { min, range, result });
    return result;
  }

  private rebuildDatacenterSupercluster(): void {
    // Share the stable detail-layer array (#7777) so cluster leaf indexes
    // resolve against the same records detail picking/tooltips identify.
    const activeDCs = this.getActiveDatacenters();
    this.datacenterSCSource = activeDCs;
    const points = activeDCs.map((dc, i) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [dc.lon, dc.lat] as [number, number] },
      properties: {
        index: i,
        country: dc.country,
        chipCount: dc.chipCount,
        powerMW: dc.powerMW ?? 0,
        status: dc.status,
      },
    }));
    this.datacenterSC = new Supercluster({
      radius: 70,
      maxZoom: 14,
      map: (props: Record<string, unknown>) => ({
        index: Number(props.index ?? 0),
        country: String(props.country ?? ''),
        totalChips: Number(props.chipCount ?? 0) || 0,
        totalPowerMW: Number(props.powerMW ?? 0) || 0,
        existingCount: props.status === 'existing' ? 1 : 0,
        plannedCount: props.status === 'planned' ? 1 : 0,
      }),
      reduce: (acc: Record<string, unknown>, props: Record<string, unknown>) => {
        acc.totalChips = Number(acc.totalChips ?? 0) + Number(props.totalChips ?? 0);
        acc.totalPowerMW = Number(acc.totalPowerMW ?? 0) + Number(props.totalPowerMW ?? 0);
        acc.existingCount = Number(acc.existingCount ?? 0) + Number(props.existingCount ?? 0);
        acc.plannedCount = Number(acc.plannedCount ?? 0) + Number(props.plannedCount ?? 0);
        if (!acc.country && props.country) acc.country = props.country;
      },
    });
    this.datacenterSC.load(points);
    this.lastSCZoom = -1;
  }

  private updateClusterData(): void {
    const zoom = Math.floor(this.maplibreMap?.getZoom() ?? 2);
    const bounds = this.maplibreMap?.getBounds();
    if (!bounds) return;
    const bbox: [number, number, number, number] = [
      bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth(),
    ];
    const boundsKey = `${bbox[0].toFixed(4)}:${bbox[1].toFixed(4)}:${bbox[2].toFixed(4)}:${bbox[3].toFixed(4)}`;
    const layers = this.state.layers;
    const useDatacenterClusters = layers.datacenters && zoom < 5;
    const layerMask = `${Number(useDatacenterClusters)}`;
    if (zoom === this.lastSCZoom && boundsKey === this.lastSCBoundsKey && layerMask === this.lastSCMask) return;
    this.lastSCZoom = zoom;
    this.lastSCBoundsKey = boundsKey;
    this.lastSCMask = layerMask;

    if (useDatacenterClusters && !this.datacenterSC) this.rebuildDatacenterSupercluster();

    if (useDatacenterClusters && this.datacenterSC) {
      const activeDCs = this.datacenterSCSource;
      this.datacenterClusters = this.datacenterSC.getClusters(bbox, zoom).map(f => {
        const coords = f.geometry.coordinates as [number, number];
        if (f.properties.cluster) {
          const props = f.properties as Record<string, unknown>;
          const clusterCount = Number(f.properties.point_count ?? 0);
          const existingCount = Number(props.existingCount ?? 0);
          const plannedCount = Number(props.plannedCount ?? 0);
          const totalChips = Number(props.totalChips ?? 0);
          const totalPowerMW = Number(props.totalPowerMW ?? 0);
          return {
            id: `dc-${f.properties.cluster_id}`,
            _kind: 'group' as const,
            _clusterId: f.properties.cluster_id!,
            lat: coords[1], lon: coords[0],
            count: clusterCount,
            items: [] as AIDataCenter[],
            region: String(props.country ?? ''),
            country: String(props.country ?? ''),
            totalChips,
            totalPowerMW,
            majorityExisting: existingCount >= Math.max(1, clusterCount / 2),
            existingCount,
            plannedCount,
            sampled: clusterCount > DeckGLMap.MAX_CLUSTER_LEAVES,
          };
        }
        const item = activeDCs[f.properties.index]!;
        return {
          id: `dp-${f.properties.index}`, _kind: 'leaf' as const, lat: item.lat, lon: item.lon,
          count: 1, items: [item], region: item.country, country: item.country,
          totalChips: item.chipCount, totalPowerMW: item.powerMW ?? 0,
          majorityExisting: item.status === 'existing',
          existingCount: item.status === 'existing' ? 1 : 0,
          plannedCount: item.status === 'planned' ? 1 : 0,
          sampled: false,
        };
      });
    } else {
      this.datacenterClusters = [];
    }
  }




  private isLayerVisible(layerKey: keyof MapLayers): boolean {
    const threshold = LAYER_ZOOM_THRESHOLDS[layerKey];
    if (!threshold) return true;
    const zoom = this.maplibreMap?.getZoom() || 2;
    return zoom >= threshold.minZoom;
  }

  private buildLayers(): LayersList {
    const startTime = performance.now();
    // Refresh theme-aware overlay colors on each rebuild
    COLORS = getOverlayColors();
    const layers: (Layer | null | false)[] = [];
    const { layers: mapLayers } = this.state;
    const filteredEarthquakes = mapLayers.natural ? this.filterByTimeCached(this.earthquakes, (eq) => eq.occurredAt) : [];
    const filteredNaturalEvents = mapLayers.natural ? this.filterByTimeCached(this.naturalEvents, (event) => event.date) : [];
    // Disease outbreaks are sparse-by-nature — WHO Disease Outbreak News
    // publishes 1-2 alerts/week, CDC HAN alerts are infrequent, and the
    // upstream ThinkGlobalHealth tracker carries 90 days of ProMED items.
    // Applying the global time-range filter (max '7d' in the dropdown)
    // wholesale-zeroes the layer when the most recent WHO/CDC update is
    // 8+ days old, which is normal for these sources. Show all items in
    // the cache; the seeder's TTL + per-source lookback already bound
    // freshness at write time. PR #3593: production saw 50 valid records
    // cached but 0 rendered because the newest CDC item was 11d old.
    const filteredDiseaseOutbreaks = mapLayers.diseaseOutbreaks ? this.diseaseOutbreaks : [];
    const filteredRadiationObservations = mapLayers.radiationWatch ? this.filterByTimeCached(this.radiationObservations, (obs) => obs.observedAt) : [];
    const filteredFirmsFireData = mapLayers.fires ? this.filterByTimeCached(this.firmsFireData, (d) => d.acq_date) : [];
    const filteredTrafficAnomalies = mapLayers.outages ? this.filterByTimeCached(this.trafficAnomalies, (a) => a.startDate) : [];
    const filteredWeatherAlerts = mapLayers.weather ? this.filterByTimeCached(this.weatherAlerts, (alert) => alert.onset) : [];
    const filteredOutages = mapLayers.outages ? this.filterByTimeCached(this.outages, (outage) => outage.pubDate) : [];
    const filteredCableAdvisories = mapLayers.cables ? this.filterByTimeCached(this.cableAdvisories, (advisory) => advisory.reported) : [];

    // Day/night overlay (rendered first as background)
    if (mapLayers.dayNight) {
      if (!this.dayNightIntervalId) this.startDayNightTimer();
      layers.push(this.createDayNightLayer());
    } else {
      if (this.dayNightIntervalId) this.stopDayNightTimer();
      this.layerCache.delete('day-night-layer');
    }

    // Undersea cables layer
    if (mapLayers.cables) {
      layers.push(this.createCablesLayer());
    } else {
      this.layerCache.delete('cables-layer');
    }

    // Pipelines layer — Redis-backed evidence registry (seed-pipelines-{gas,oil}.mjs),
    // colored by derived publicBadge. Available on every variant that toggles
    // `pipelines: true`. createEnergyPipelinesLayer falls back to the legacy
    // static `PIPELINES` layer (createPipelinesLayer below) when the bootstrap
    // hasn't hydrated yet, so the static layer is a real fallback — not dead
    // code despite an earlier comment claiming it was retired in the gap #3B
    // rollout. Removing createPipelinesLayer would leave the map blank on
    // cold loads / variant switches before the first hydrate.
    if (mapLayers.pipelines) {
      layers.push(this.createEnergyPipelinesLayer());
    } else {
      this.layerCache.delete('pipelines-layer');
    }

    // Nuclear facilities layer — hidden at low zoom
    if (mapLayers.nuclear && this.isLayerVisible('nuclear')) {
      layers.push(this.createNuclearLayer());
    }
    layers.push(this.createEmptyGhost('nuclear-layer'));

    // NucMonitor — US nuclear facility registry (always visible; small dataset)
    if (mapLayers.usNuclearFacilities) {
      if (this.selectedUsNuclearFacility) layers.push(this.createEpzRingsLayer(this.selectedUsNuclearFacility));
      layers.push(this.createUsNuclearFacilitiesLayer());
    }

    // Gamma irradiators layer — hidden at low zoom
    if (mapLayers.irradiators && this.isLayerVisible('irradiators')) {
      layers.push(this.createIrradiatorsLayer());
    }

    // Datacenters layer - SQUARE icons at zoom >= 5, cluster dots at zoom < 5
    const currentZoom = this.maplibreMap?.getZoom() || 2;
    if (mapLayers.datacenters) {
      if (currentZoom >= 5) {
        layers.push(this.createDatacentersLayer());
      } else {
        layers.push(...this.createDatacenterClusterLayers());
      }
    }

    // Earthquakes layer
    if (mapLayers.natural && filteredEarthquakes.length > 0) {
      layers.push(this.createEarthquakesLayer(filteredEarthquakes));
    }
    layers.push(this.createEmptyGhost('earthquakes-layer'));

    // Natural events layers (non-TC scatter + TC tracks/cones/centers)
    if (mapLayers.natural && filteredNaturalEvents.length > 0) {
      layers.push(...this.createNaturalEventsLayers(filteredNaturalEvents));
    }

    if (mapLayers.radiationWatch && filteredRadiationObservations.length > 0) {
      layers.push(this.createRadiationLayer(filteredRadiationObservations));
    }
    layers.push(this.createEmptyGhost('radiation-watch-layer'));

    // Disease outbreaks layer
    if (mapLayers.diseaseOutbreaks && filteredDiseaseOutbreaks.length > 0) {
      layers.push(this.createDiseaseOutbreaksLayer(filteredDiseaseOutbreaks));
    }
    layers.push(this.createEmptyGhost('disease-outbreaks-layer'));

    // Satellite fires layer (NASA FIRMS)
    if (mapLayers.fires && filteredFirmsFireData.length > 0) {
      layers.push(this.createFiresLayer(filteredFirmsFireData));
    }

    // Weather alerts layer
    if (mapLayers.weather && filteredWeatherAlerts.length > 0) {
      layers.push(this.createWeatherLayer(filteredWeatherAlerts));
    }

    // Internet outages layer
    if (mapLayers.outages && filteredOutages.length > 0) {
      layers.push(this.createOutagesLayer(filteredOutages));
    }
    layers.push(this.createEmptyGhost('outages-layer'));

    if (mapLayers.outages && filteredTrafficAnomalies.length > 0) {
      layers.push(this.createTrafficAnomaliesLayer(filteredTrafficAnomalies));
    }
    layers.push(this.createEmptyGhost('traffic-anomalies-layer'));

    if (mapLayers.outages && this.ddosLocations.length > 0) {
      layers.push(this.createDdosLocationsLayer(this.ddosLocations));
    }
    layers.push(this.createEmptyGhost('ddos-locations-layer'));

    // Cable advisories layer (shown with cables)
    if (mapLayers.cables && filteredCableAdvisories.length > 0) {
      layers.push(this.createCableAdvisoriesLayer(filteredCableAdvisories));
    }

    // Repair ships layer (shown with cables)
    if (mapLayers.cables && this.repairShips.length > 0) {
      layers.push(this.createRepairShipsLayer());
    }

    // Climate anomalies heatmap layer
    if (mapLayers.climate && this.climateAnomalies.length > 0) {
      layers.push(this.createClimateHeatmapLayer());
    }

    // Webcam layer (server-side clustered markers)
    if (mapLayers.webcams && this.webcamData.length > 0) {
      layers.push(new ScatterplotLayer<WebcamMarker>({
        id: 'webcam-layer',
        data: this.webcamData,
        getPosition: (d) => [d.lng, d.lat],
        getRadius: (d) => ('count' in d ? Math.min(8 + d.count * 0.5, 24) : 6),
        getFillColor: (d) => ('count' in d ? [0, 212, 255, 180] : [255, 215, 0, 200]) as [number, number, number, number],
        radiusUnits: 'pixels',
        pickable: true,
        // Consume the pick (return true) so MapLibreOverlay onClick → handleClick
        // does not double-fire. Cluster vs leaf is routed in handleWebcamLayerClick.
        onClick: (info) => this.handleWebcamLayerClick(info),
      }));
    }

    // News geo-locations (always shown if data exists)
    if (this.newsLocations.length > 0) {
      layers.push(...this.createNewsLocationsLayer());
    }

    const result = layers.filter(Boolean) as LayersList;
    const elapsed = performance.now() - startTime;
    if (import.meta.env.DEV && elapsed > 16) {
      console.warn(`[DeckGLMap] buildLayers took ${elapsed.toFixed(2)}ms (>16ms budget), ${result.length} layers`);
    }
    return result;
  }

  // Layer creation methods
  private createCablesLayer(): PathLayer {
    const highlightedCables = this.highlightedAssets.cable;
    const cacheKey = 'cables-layer';
    const cached = this.layerCache.get(cacheKey) as PathLayer | undefined;
    const highlightSignature = this.getSetSignature(highlightedCables);
    const healthSignature = Object.keys(this.healthByCableId).sort().join(',');
    if (cached && highlightSignature === this.lastCableHighlightSignature && healthSignature === this.lastCableHealthSignature) return cached;

    const health = this.healthByCableId;
    const layer = new PathLayer({
      id: cacheKey,
      data: UNDERSEA_CABLES,
      getPath: (d) => d.points,
      getColor: (d) => {
        if (highlightedCables.has(d.id)) return COLORS.cableHighlight;
        const h = health[d.id];
        if (h?.status === 'fault') return COLORS.cableFault;
        if (h?.status === 'degraded') return COLORS.cableDegraded;
        return COLORS.cable;
      },
      getWidth: (d) => {
        if (highlightedCables.has(d.id)) return 3;
        const h = health[d.id];
        if (h?.status === 'fault') return 2.5;
        if (h?.status === 'degraded') return 2;
        return 1;
      },
      widthMinPixels: 1,
      widthMaxPixels: 5,
      pickable: true,
      updateTriggers: { highlighted: highlightSignature, health: healthSignature },
    });

    this.lastCableHighlightSignature = highlightSignature;
    this.lastCableHealthSignature = healthSignature;
    this.layerCache.set(cacheKey, layer);
    return layer;
  }

  private createPipelinesLayer(): PathLayer {
    const highlightedPipelines = this.highlightedAssets.pipeline;
    const cacheKey = 'pipelines-layer';
    const cached = this.layerCache.get(cacheKey) as PathLayer | undefined;
    const highlightSignature = this.getSetSignature(highlightedPipelines);
    if (cached && highlightSignature === this.lastPipelineHighlightSignature) return cached;

    const layer = new PathLayer({
      id: cacheKey,
      data: PIPELINES,
      getPath: (d) => d.points,
      getColor: (d) => {
        if (highlightedPipelines.has(d.id)) {
          return [255, 100, 100, 200] as [number, number, number, number];
        }
        const colorKey = d.type as keyof typeof PIPELINE_COLORS;
        const hex = PIPELINE_COLORS[colorKey] || '#666666';
        return this.hexToRgba(hex, 150);
      },
      getWidth: (d) => highlightedPipelines.has(d.id) ? 3 : 1.5,
      widthMinPixels: 1,
      widthMaxPixels: 4,
      pickable: true,
      updateTriggers: { highlighted: highlightSignature },
    });

    this.lastPipelineHighlightSignature = highlightSignature;
    this.layerCache.set(cacheKey, layer);
    return layer;
  }

  // Energy-variant override for the pipelines map layer. Instead of the
  // static PIPELINES config (colored by oil/gas type), this reads the
  // evidence-backed pipeline registries seeded by scripts/seed-pipelines-
  // {gas,oil}.mjs and colors each path by its derived publicBadge —
  // flowing/reduced/offline/disputed. Click dispatches an
  // `open-pipeline-detail` window event that PipelineStatusPanel listens
  // for to open its drawer. Falls back to the static layer if bootstrap
  // hasn't hydrated yet (e.g. variant switch before the fetch completes).
  private createEnergyPipelinesLayer(): PathLayer {
    const cacheKey = 'pipelines-layer';
    const highlightedPipelines = this.highlightedAssets.pipeline;
    const highlightSignature = this.getSetSignature(highlightedPipelines);

    interface RawEntry {
      id?: string; name?: string; commodityType?: string;
      startPoint?: { lat?: number; lon?: number };
      endPoint?:   { lat?: number; lon?: number };
      waypoints?:  Array<{ lat?: number; lon?: number }>;
      operator?: string;
      evidence?: PipelineEvidenceInput;
    }
    interface EnergyPipeline {
      id: string;
      name: string;
      operator: string;
      commodityType: string;
      points: Array<[number, number]>;
      badge: PipelinePublicBadge;
    }

    // Read through the shared store instead of getHydratedData directly —
    // getHydratedData is single-use (deletes on first read), and this same
    // data is also consumed by PipelineStatusPanel. The store memoizes so
    // both consumers see identical data regardless of mount order.
    const { gas, oil } = getCachedPipelineRegistries() as {
      gas: { pipelines?: Record<string, RawEntry> } | undefined;
      oil: { pipelines?: Record<string, RawEntry> } | undefined;
    };
    const rawEntries: RawEntry[] = [
      ...Object.values(gas?.pipelines ?? {}),
      ...Object.values(oil?.pipelines ?? {}),
    ];

    // Bootstrap not hydrated yet → fall back to the static layer so the
    // map always has some representation of the pipelines toggle.
    if (rawEntries.length === 0) return this.createPipelinesLayer();

    const data: EnergyPipeline[] = rawEntries
      .map(raw => {
        const id = typeof raw.id === 'string' ? raw.id : '';
        if (!id) return null;
        const start = raw.startPoint;
        const end = raw.endPoint;
        if (!start || !end || typeof start.lat !== 'number' || typeof start.lon !== 'number' ||
            typeof end.lat !== 'number' || typeof end.lon !== 'number') return null;
        const points: Array<[number, number]> = [[start.lon, start.lat]];
        if (Array.isArray(raw.waypoints)) {
          for (const wp of raw.waypoints) {
            if (wp && typeof wp.lat === 'number' && typeof wp.lon === 'number') {
              points.push([wp.lon, wp.lat]);
            }
          }
        }
        points.push([end.lon, end.lat]);
        return {
          id,
          name: raw.name || id,
          operator: raw.operator || '',
          commodityType: raw.commodityType || 'gas',
          points,
          badge: derivePipelinePublicBadge(raw.evidence),
        } as EnergyPipeline;
      })
      .filter((p): p is EnergyPipeline => p != null);

    const HIGHLIGHT_COLOR: [number, number, number, number] = [255, 100, 100, 240];
    const badgeColor = (b: PipelinePublicBadge): [number, number, number, number] => {
      switch (b) {
        case 'flowing':  return [46, 204, 113, 200];  // green
        case 'reduced':  return [243, 156, 18, 220];  // amber
        case 'offline':  return [231, 76, 60, 230];   // red
        case 'disputed': return [155, 89, 182, 220];  // purple
      }
    };

    const layer = new PathLayer<EnergyPipeline>({
      id: cacheKey,
      data,
      getPath: d => d.points,
      getColor: d => highlightedPipelines.has(d.id) ? HIGHLIGHT_COLOR : badgeColor(d.badge),
      getWidth: d => {
        if (highlightedPipelines.has(d.id)) return 4;
        return (d.badge === 'offline' || d.badge === 'disputed') ? 3 : 2;
      },
      widthMinPixels: 1.5,
      widthMaxPixels: 6,
      pickable: true,
      // updateTriggers make DeckGL recompute per-path getColor/getWidth
      // when the highlight set changes; without this, flashAssets() /
      // highlightAssets() would have no visible effect on the energy layer.
      updateTriggers: {
        getColor: highlightSignature,
        getWidth: highlightSignature,
      },
      onClick: info => {
        const obj = info?.object as EnergyPipeline | undefined;
        if (!obj?.id) return false;
        // Emit an event; PipelineStatusPanel listens and opens its drawer.
        // Cross-component coupling stays loose — no direct reference to the
        // panel class, and if the panel isn't mounted the event is a no-op.
        try {
          window.dispatchEvent(new CustomEvent('energy:open-pipeline-detail', {
            detail: { pipelineId: obj.id },
          }));
        } catch {
          // Non-browser / tauri edge cases — silent no-op.
        }
        return true;
      },
    });

    // Intentionally NOT caching this layer: the underlying registries can
    // update via setCachedPipelineRegistries() when the panel's RPC lands,
    // and cached layers keyed only on highlightSignature would serve stale
    // data. With ~25 critical-asset pipelines, rebuild cost per render is
    // trivial (far cheaper than a stale-data UI bug).
    return layer;
  }


  private createNuclearLayer(): IconLayer {
    const highlightedNuclear = this.highlightedAssets.nuclear;
    // Stable catalog array (#7777): same reference across unchanged renders
    // so deck.gl skips instance-attribute rebuilds; the sorted-content
    // signature below (never the in-place-mutated Set) invalidates the
    // highlight-dependent attributes.
    const data = this.getActiveNuclearFacilities();
    const highlightSignature = this.getSetSignature(highlightedNuclear);

    // Nuclear: HEXAGON icons - yellow/orange color, semi-transparent
    return new IconLayer({
      id: 'nuclear-layer',
      data,
      getPosition: (d) => [d.lon, d.lat],
      getIcon: () => 'hexagon',
      iconAtlas: MARKER_ICONS.hexagon,
      iconMapping: NUCLEAR_ICON_MAPPING,
      getSize: (d) => highlightedNuclear.has(d.id) ? 15 : 11,
      getColor: (d) => {
        if (highlightedNuclear.has(d.id)) {
          return [255, 100, 100, 220] as [number, number, number, number];
        }
        if (d.status === 'contested') {
          return [255, 50, 50, 200] as [number, number, number, number];
        }
        return [255, 220, 0, 200] as [number, number, number, number]; // Semi-transparent yellow
      },
      sizeScale: 1,
      sizeMinPixels: 6,
      sizeMaxPixels: 15,
      pickable: true,
      updateTriggers: { getSize: highlightSignature, getColor: highlightSignature },
    });
  }

  /**
   * NucMonitor — US nuclear facility registry (src/config/us-nuclear-facilities.ts).
   * Hexagon icons colored by category so an operating reactor, a DOE site, and
   * a decommissioning ISFSI read differently at a glance.
   */
  private createUsNuclearFacilitiesLayer(): IconLayer {
    return new IconLayer({
      id: 'us-nuclear-facilities-layer',
      data: US_NUCLEAR_FACILITIES,
      getPosition: (d: UsNuclearFacility) => [d.lon, d.lat],
      getIcon: () => 'hexagon',
      iconAtlas: MARKER_ICONS.hexagon,
      iconMapping: NUCLEAR_ICON_MAPPING,
      getSize: (d: UsNuclearFacility) => (d.category === 'power-reactor' || d.category === 'restart' ? 14 : d.category === 'research-reactor' ? 8 : 11),
      getColor: (d: UsNuclearFacility) => US_NUCLEAR_LAYER_COLORS[d.category],
      sizeScale: 1,
      sizeMinPixels: 6,
      sizeMaxPixels: 16,
      pickable: true,
    });
  }

  /**
   * 10-mile plume and 50-mile ingestion emergency planning zone rings around
   * one facility. Radii are in meters so the rings stay true to scale at any
   * zoom.
   */
  private createEpzRingsLayer(facility: UsNuclearFacility): ScatterplotLayer {
    const rings = [
      { radiusMeters: 50 * 1609.344, color: [52, 152, 219, 200] as [number, number, number, number] },
      { radiusMeters: 10 * 1609.344, color: [231, 76, 60, 230] as [number, number, number, number] },
    ];
    return new ScatterplotLayer({
      id: 'us-nuclear-epz-rings-layer',
      data: rings,
      getPosition: () => [facility.lon, facility.lat],
      getRadius: (d: (typeof rings)[number]) => d.radiusMeters,
      radiusUnits: 'meters',
      stroked: true,
      filled: true,
      getFillColor: (d: (typeof rings)[number]) => [d.color[0], d.color[1], d.color[2], 18] as [number, number, number, number],
      getLineColor: (d: (typeof rings)[number]) => d.color,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      pickable: false,
      updateTriggers: { getPosition: facility.id },
    });
  }

  /** Draw (or clear with null) the EPZ rings for a registry facility. */
  public setSelectedUsNuclearFacility(facilityId: string | null): void {
    const next = facilityId ? US_NUCLEAR_FACILITIES.find((f) => f.id === facilityId) ?? null : null;
    if (next === this.selectedUsNuclearFacility) return;
    this.selectedUsNuclearFacility = next;
    this.render();
  }

  private createIrradiatorsLayer(): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'irradiators-layer',
      data: GAMMA_IRRADIATORS,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 6000,
      getFillColor: [255, 100, 255, 180] as [number, number, number, number], // Magenta
      radiusMinPixels: 4,
      radiusMaxPixels: 10,
      pickable: true,
    });
  }

  /** Empty sentinel layer — keeps a stable layer ID for deck.gl interleaved mode without rendering anything. */
  private createEmptyGhost(id: string): ScatterplotLayer {
    return new ScatterplotLayer({ id: `${id}-ghost`, data: [], getPosition: () => [0, 0], visible: false });
  }


  private createDatacentersLayer(): IconLayer {
    const highlightedDC = this.highlightedAssets.datacenter;
    // Stable catalog array (#7777): same reference across unchanged renders
    // so deck.gl skips instance-attribute rebuilds; the sorted-content
    // signature below (never the in-place-mutated Set) invalidates the
    // highlight-dependent attributes.
    const data = this.getActiveDatacenters();
    const highlightSignature = this.getSetSignature(highlightedDC);

    // Datacenters: SQUARE icons - purple color, semi-transparent for layering
    return new IconLayer({
      id: 'datacenters-layer',
      data,
      getPosition: (d) => [d.lon, d.lat],
      getIcon: () => 'square',
      iconAtlas: MARKER_ICONS.square,
      iconMapping: DATACENTER_ICON_MAPPING,
      getSize: (d) => highlightedDC.has(d.id) ? 14 : 10,
      getColor: (d) => {
        if (highlightedDC.has(d.id)) {
          return [255, 100, 100, 200] as [number, number, number, number];
        }
        if (d.status === 'planned') {
          return [136, 68, 255, 100] as [number, number, number, number]; // Transparent for planned
        }
        return [136, 68, 255, 140] as [number, number, number, number]; // ~55% opacity
      },
      sizeScale: 1,
      sizeMinPixels: 6,
      sizeMaxPixels: 14,
      pickable: true,
      updateTriggers: { getSize: highlightSignature, getColor: highlightSignature },
    });
  }

  private createEarthquakesLayer(earthquakes: Earthquake[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'earthquakes-layer',
      data: earthquakes,
      getPosition: (d) => [d.location?.longitude ?? 0, d.location?.latitude ?? 0],
      getRadius: (d) => 2 ** d.magnitude * 1000,
      getFillColor: (d) => {
        const mag = d.magnitude;
        if (mag >= 6) return [255, 0, 0, 200] as [number, number, number, number];
        if (mag >= 5) return [255, 100, 0, 200] as [number, number, number, number];
        return COLORS.earthquake;
      },
      radiusMinPixels: 4,
      radiusMaxPixels: 30,
      pickable: true,
    });
  }

  private createNaturalEventsLayers(events: NaturalEvent[]): Layer[] {
    const nonTC = events.filter(e => !e.stormName && !e.windKt);
    const cyclones = events.filter(e => e.stormName || e.windKt);
    const layers: Layer[] = [];

    if (nonTC.length > 0) {
      layers.push(new ScatterplotLayer({
        id: 'natural-events-layer',
        data: nonTC,
        getPosition: (d: NaturalEvent) => [d.lon, d.lat],
        getRadius: (d: NaturalEvent) => d.title.startsWith('🔴') ? 20000 : d.title.startsWith('🟠') ? 15000 : 8000,
        getFillColor: (d: NaturalEvent) => {
          if (d.title.startsWith('🔴')) return [255, 0, 0, 220] as [number, number, number, number];
          if (d.title.startsWith('🟠')) return [255, 140, 0, 200] as [number, number, number, number];
          return [255, 150, 50, 180] as [number, number, number, number];
        },
        radiusMinPixels: 5,
        radiusMaxPixels: 18,
        pickable: true,
      }));
    }

    if (cyclones.length === 0) return layers;

    // Cone polygons (render first, underneath tracks)
    const coneData: { polygon: number[][]; stormName: string; _event: NaturalEvent }[] = [];
    for (const e of cyclones) {
      if (!e.conePolygon?.length) continue;
      for (const ring of e.conePolygon) {
        coneData.push({ polygon: ring, stormName: e.stormName || e.title, _event: e });
      }
    }
    if (coneData.length > 0) {
      layers.push(new PolygonLayer({
        id: 'storm-cone-layer',
        data: coneData,
        getPolygon: (d: { polygon: number[][] }) => d.polygon,
        getFillColor: [255, 255, 255, 30],
        getLineColor: [255, 255, 255, 80],
        lineWidthMinPixels: 1,
        pickable: true,
      }));
    }

    const windRadiiData: { polygon: number[][]; thresholdKt: number; stormName: string; _event: NaturalEvent }[] = [];
    for (const e of cyclones) {
      for (const band of e.windRadii || []) {
        if (band.geometryKind && band.geometryKind !== 'forecast-wind-radii') continue;
        for (const polygon of band.polygons || []) {
          const ring = polygon[0];
          if (ring?.length) {
            windRadiiData.push({
              polygon: ring,
              thresholdKt: band.thresholdKt || 0,
              stormName: e.stormName || e.title,
              _event: e,
            });
          }
        }
      }
    }
    if (windRadiiData.length > 0) {
      layers.push(new PolygonLayer({
        id: 'storm-imd-wind-radii-layer',
        data: windRadiiData,
        getPolygon: (d: { polygon: number[][] }) => d.polygon,
        getFillColor: (d: { thresholdKt: number }) => {
          if (d.thresholdKt >= 64) return [180, 0, 0, 40] as [number, number, number, number];
          if (d.thresholdKt >= 50) return [220, 80, 0, 36] as [number, number, number, number];
          if (d.thresholdKt >= 34) return [220, 160, 0, 32] as [number, number, number, number];
          return [200, 200, 0, 28] as [number, number, number, number];
        },
        getLineColor: [255, 180, 0, 120],
        lineWidthMinPixels: 1,
        pickable: true,
      }));
    }

    // Past track segments (per-segment wind coloring)
    const pastSegments: { path: [number, number][]; windKt: number; stormName: string; _event: NaturalEvent }[] = [];
    for (const e of cyclones) {
      if (!e.pastTrack?.length) continue;
      for (let i = 0; i < e.pastTrack.length - 1; i++) {
        const a = e.pastTrack[i]!;
        const b = e.pastTrack[i + 1]!;
        pastSegments.push({
          path: [[a.lon, a.lat] as [number, number], [b.lon, b.lat] as [number, number]],
          windKt: b.windKt ?? a.windKt ?? 0,
          stormName: e.stormName || e.title,
          _event: e,
        });
      }
    }
    if (pastSegments.length > 0) {
      layers.push(new PathLayer({
        id: 'storm-past-track-layer',
        data: pastSegments,
        getPath: (d: { path: [number, number][] }) => d.path,
        getColor: (d: { windKt: number }) => getWindColor(d.windKt),
        getWidth: 3,
        widthUnits: 'pixels' as const,
        pickable: true,
      }));
    }

    // Forecast track
    const forecastPaths: { path: [number, number][]; stormName: string; _event: NaturalEvent }[] = [];
    for (const e of cyclones) {
      if (!e.forecastTrack?.length) continue;
      forecastPaths.push({
        path: [[e.lon, e.lat] as [number, number], ...e.forecastTrack.map(p => [p.lon, p.lat] as [number, number])],
        stormName: e.stormName || e.title,
        _event: e,
      });
    }
    if (forecastPaths.length > 0) {
      layers.push(new PathLayer({
        id: 'storm-forecast-track-layer',
        data: forecastPaths,
        getPath: (d: { path: [number, number][] }) => d.path,
        getColor: [255, 100, 100, 200],
        getWidth: 2,
        widthUnits: 'pixels' as const,
        pickable: true,
      }));
    }

    // Storm center markers (on top)
    layers.push(new ScatterplotLayer({
      id: 'storm-centers-layer',
      data: cyclones,
      getPosition: (d: NaturalEvent) => [d.lon, d.lat],
      getRadius: 15000,
      getFillColor: (d: NaturalEvent) => getWindColor(d.windKt ?? 0),
      getLineColor: [255, 255, 255, 200],
      lineWidthMinPixels: 2,
      stroked: true,
      radiusMinPixels: 6,
      radiusMaxPixels: 20,
      pickable: true,
    }));

    return layers;
  }

  private createFiresLayer(items: typeof this.firmsFireData): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'fires-layer',
      data: items,
      getPosition: (d: (typeof this.firmsFireData)[0]) => [d.lon, d.lat],
      getRadius: (d: (typeof this.firmsFireData)[0]) => Math.min(d.frp * 200, 30000) || 5000,
      getFillColor: (d: (typeof this.firmsFireData)[0]) => {
        if (d.brightness > 400) return [255, 30, 0, 220] as [number, number, number, number];
        if (d.brightness > 350) return [255, 140, 0, 200] as [number, number, number, number];
        return [255, 220, 50, 180] as [number, number, number, number];
      },
      radiusMinPixels: 3,
      radiusMaxPixels: 12,
      pickable: true,
    });
  }

  private createWeatherLayer(alerts: WeatherAlert[]): ScatterplotLayer {
    // Filter weather alerts that have centroid coordinates
    const alertsWithCoords = alerts.filter(a => a.centroid && a.centroid.length === 2);

    return new ScatterplotLayer({
      id: 'weather-layer',
      data: alertsWithCoords,
      getPosition: (d) => d.centroid as [number, number], // centroid is [lon, lat]
      getRadius: 25000,
      getFillColor: (d) => {
        if (d.severity === 'Extreme') return [255, 0, 0, 200] as [number, number, number, number];
        if (d.severity === 'Severe') return [255, 100, 0, 180] as [number, number, number, number];
        if (d.severity === 'Moderate') return [255, 170, 0, 160] as [number, number, number, number];
        return COLORS.weather;
      },
      radiusMinPixels: 8,
      radiusMaxPixels: 20,
      pickable: true,
    });
  }

  private createOutagesLayer(outages: InternetOutage[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'outages-layer',
      data: outages,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 20000,
      getFillColor: COLORS.outage,
      radiusMinPixels: 6,
      radiusMaxPixels: 18,
      pickable: true,
    });
  }

  private createTrafficAnomaliesLayer(anomalies: ProtoTrafficAnomaly[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'traffic-anomalies-layer',
      data: anomalies.filter(a => a.latitude !== 0 || a.longitude !== 0),
      getPosition: (d) => [d.longitude, d.latitude],
      getRadius: 30000,
      getFillColor: COLORS.trafficAnomaly,
      radiusMinPixels: 5,
      radiusMaxPixels: 14,
      pickable: true,
    });
  }

  private createDdosLocationsLayer(hits: DdosLocationHit[]): ScatterplotLayer {
    return new ScatterplotLayer({
      id: 'ddos-locations-layer',
      data: hits.filter(h => h.latitude !== 0 || h.longitude !== 0),
      getPosition: (d) => [d.longitude, d.latitude],
      getRadius: (d) => 20000 + (d.percentage || 0) * 800,
      getFillColor: COLORS.ddosHit,
      radiusMinPixels: 5,
      radiusMaxPixels: 16,
      pickable: true,
    });
  }

  private createRadiationLayer(items: RadiationObservation[]): ScatterplotLayer<RadiationObservation> {
    return new ScatterplotLayer<RadiationObservation>({
      id: 'radiation-watch-layer',
      data: items,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => {
        const base = d.severity === 'spike' ? 26000 : 18000;
        if (d.corroborated) return base * 1.15;
        if (d.confidence === 'low') return base * 0.85;
        return base;
      },
      getFillColor: (d) => (
        d.severity === 'spike'
          ? [255, 48, 48, 220]
          : d.confidence === 'low'
            ? [255, 174, 0, 150]
            : [255, 174, 0, 200]
      ) as [number, number, number, number],
      getLineColor: [255, 255, 255, 200],
      stroked: true,
      lineWidthMinPixels: 2,
      radiusMinPixels: 6,
      radiusMaxPixels: 20,
      pickable: true,
    });
  }

  private createDiseaseOutbreaksLayer(items: DiseaseOutbreakItem[]): ScatterplotLayer<{ lon: number; lat: number; item: DiseaseOutbreakItem }> {
    type Point = { lon: number; lat: number; item: DiseaseOutbreakItem };
    const points: Point[] = [];
    for (const item of items) {
      if (Number.isFinite(item.lat) && item.lat !== 0 && Number.isFinite(item.lng) && item.lng !== 0) {
        points.push({ lon: item.lng, lat: item.lat, item });
      } else {
        const centroid = getCountryCentroid(item.countryCode ?? '');
        if (centroid) points.push({ lon: centroid.lon, lat: centroid.lat, item });
      }
    }
    return new ScatterplotLayer<Point>({
      id: 'disease-outbreaks-layer',
      data: points,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => d.item.alertLevel === 'alert' ? 180000 : d.item.alertLevel === 'warning' ? 130000 : 90000,
      getFillColor: (d) => (
        d.item.alertLevel === 'alert'
          ? [231, 76, 60, 200]
          : d.item.alertLevel === 'warning'
            ? [230, 126, 34, 190]
            : [241, 196, 15, 170]
      ) as [number, number, number, number],
      getLineColor: [255, 255, 255, 120],
      stroked: true,
      lineWidthMinPixels: 1,
      radiusMinPixels: 5,
      radiusMaxPixels: 22,
      pickable: true,
    });
  }

  private createCableAdvisoriesLayer(advisories: CableAdvisory[]): ScatterplotLayer {
    // Cable fault/maintenance advisories
    return new ScatterplotLayer({
      id: 'cable-advisories-layer',
      data: advisories,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 10000,
      getFillColor: (d) => {
        if (d.severity === 'fault') {
          return [255, 50, 50, 220] as [number, number, number, number]; // Red for faults
        }
        return [255, 200, 0, 200] as [number, number, number, number]; // Yellow for maintenance
      },
      radiusMinPixels: 5,
      radiusMaxPixels: 12,
      pickable: true,
      stroked: true,
      getLineColor: [0, 200, 255, 200] as [number, number, number, number], // Cyan outline (cable color)
      lineWidthMinPixels: 2,
    });
  }

  private createRepairShipsLayer(): ScatterplotLayer {
    // Cable repair ships
    return new ScatterplotLayer({
      id: 'repair-ships-layer',
      data: this.repairShips,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 8000,
      getFillColor: [0, 255, 200, 200] as [number, number, number, number], // Teal
      radiusMinPixels: 4,
      radiusMaxPixels: 10,
      pickable: true,
    });
  }

  private createDatacenterClusterLayers(): Layer[] {
    this.updateClusterData();
    const layers: Layer[] = [];

    layers.push(new ScatterplotLayer<MapDatacenterCluster>({
      id: 'datacenter-clusters-layer',
      data: this.datacenterClusters,
      getPosition: d => [d.lon, d.lat],
      getRadius: d => 15000 + d.count * 2000,
      radiusMinPixels: 6,
      radiusMaxPixels: 20,
      getFillColor: d => {
        if (d.majorityExisting) return [160, 80, 255, 180] as [number, number, number, number];
        return [80, 160, 255, 180] as [number, number, number, number];
      },
      pickable: true,
      updateTriggers: { getRadius: this.lastSCZoom },
    }));

    const multiClusters = this.datacenterClusters.filter(c => c.count > 1);
    if (multiClusters.length > 0) {
      layers.push(new TextLayer<MapDatacenterCluster>({
        id: 'datacenter-clusters-badge',
        data: multiClusters,
        getText: d => String(d.count),
        getPosition: d => [d.lon, d.lat],
        background: true,
        getBackgroundColor: [0, 0, 0, 180],
        backgroundPadding: [4, 2, 4, 2],
        getColor: [255, 255, 255, 255],
        getSize: 12,
        getPixelOffset: [0, -14],
        pickable: false,
        fontFamily: 'system-ui, sans-serif',
        fontWeight: 700,
      }));
    }

    layers.push(this.createEmptyGhost('datacenter-clusters-layer'));
    return layers;
  }

  private pulseTime = 0;

  private canPulse(now = Date.now()): boolean {
    return now - this.startupTime > 60_000;
  }

  private needsPulseAnimation(now = Date.now()): boolean {
    return this.hasRecentNews(now);
  }

  private syncPulseAnimation(now = Date.now()): void {
    if (this.renderPaused) {
      if (this.newsPulseIntervalId !== null) this.stopPulseAnimation();
      return;
    }
    const shouldPulse = this.canPulse(now) && this.needsPulseAnimation(now);
    if (shouldPulse && this.newsPulseIntervalId === null) {
      this.startPulseAnimation();
    } else if (!shouldPulse && this.newsPulseIntervalId !== null) {
      this.stopPulseAnimation();
    }
  }

  private startPulseAnimation(): void {
    if (this.newsPulseIntervalId !== null) return;
    const PULSE_UPDATE_INTERVAL_MS = 500;

    this.newsPulseIntervalId = setInterval(() => {
      const now = Date.now();
      if (!this.needsPulseAnimation(now)) {
        this.pulseTime = now;
        this.stopPulseAnimation();
        this.rafUpdateLayers();
        return;
      }
      this.pulseTime = now;
      // Steady-state pulse rebuild: skip when input is queued (#5042 U2). The
      // terminal settle branch above is never guarded — it must commit the
      // static end state. pulseTime still advances so no visual state is lost.
      if (shouldRunInputSensitiveMapWork(isInputPending)) this.rafUpdateLayers();
    }, PULSE_UPDATE_INTERVAL_MS);
  }

  private stopPulseAnimation(): void {
    if (this.newsPulseIntervalId !== null) {
      clearInterval(this.newsPulseIntervalId);
      this.newsPulseIntervalId = null;
    }
  }

  private createNewsLocationsLayer(): ScatterplotLayer[] {
    const zoom = this.maplibreMap?.getZoom() || 2;
    const alphaScale = zoom < 2.5 ? 0.4 : zoom < 4 ? 0.7 : 1.0;
    const filteredNewsLocations = this.filterByTime(this.newsLocations, (location) => location.timestamp);
    const THREAT_RGB: Record<string, [number, number, number]> = {
      critical: [239, 68, 68],
      high: [249, 115, 22],
      medium: [234, 179, 8],
      low: [34, 197, 94],
      info: [59, 130, 246],
    };
    const THREAT_ALPHA: Record<string, number> = {
      critical: 220,
      high: 190,
      medium: 160,
      low: 120,
      info: 80,
    };

    const now = this.pulseTime || Date.now();
    const PULSE_DURATION = 30_000;

    const layers: ScatterplotLayer[] = [
      new ScatterplotLayer({
        id: 'news-locations-layer',
        data: filteredNewsLocations,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: 18000,
        getFillColor: (d) => {
          const rgb = THREAT_RGB[d.threatLevel] || [59, 130, 246];
          const a = Math.round((THREAT_ALPHA[d.threatLevel] || 120) * alphaScale);
          return [...rgb, a] as [number, number, number, number];
        },
        radiusMinPixels: 3,
        radiusMaxPixels: 12,
        pickable: true,
      }),
    ];

    const recentNews = filteredNewsLocations.filter(d => {
      const firstSeen = this.newsLocationFirstSeen.get(d.title);
      return firstSeen && (now - firstSeen) < PULSE_DURATION;
    });

    if (recentNews.length > 0) {
      const pulse = 1.0 + 1.5 * (0.5 + 0.5 * Math.sin(now / 318));

      layers.push(new ScatterplotLayer({
        id: 'news-pulse-layer',
        data: recentNews,
        getPosition: (d) => [d.lon, d.lat],
        getRadius: 18000,
        radiusScale: pulse,
        radiusMinPixels: 6,
        radiusMaxPixels: 30,
        pickable: false,
        stroked: true,
        filled: false,
        getLineColor: (d) => {
          const rgb = THREAT_RGB[d.threatLevel] || [59, 130, 246];
          const firstSeen = this.newsLocationFirstSeen.get(d.title) || now;
          const age = now - firstSeen;
          const fadeOut = Math.max(0, 1 - age / PULSE_DURATION);
          const a = Math.round(150 * fadeOut * alphaScale);
          return [...rgb, a] as [number, number, number, number];
        },
        lineWidthMinPixels: 1.5,
        updateTriggers: { pulseTime: now },
      }));
    }

    return layers;
  }

  private getTooltip(info: PickingInfo): { html: string } | null {
    if (!info.object) return null;

    const rawLayerId = info.layer?.id || '';
    const layerId = rawLayerId.endsWith('-ghost') ? rawLayerId.slice(0, -6) : rawLayerId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = info.object as any;
    const text = (value: unknown): string => escapeHtml(String(value ?? ''));

    const numericLabel = (value: unknown, digits?: number): string => {
      const number = value == null || value === '' ? NaN : Number(value);
      return Number.isFinite(number) ? text(digits == null ? number.toLocaleString() : number.toFixed(digits)) : '—';
    };

    switch (layerId) {
      case 'earthquakes-layer':
        return { html: `<div class="deckgl-tooltip"><strong>M${numericLabel(obj.magnitude, 1)} ${t('components.deckgl.tooltip.earthquake')}</strong><br/>${text(obj.place)}</div>` };
      case 'datacenter-clusters-layer':
        if (obj.count === 1) {
          const dc = obj.items?.[0];
          return { html: `<div class="deckgl-tooltip"><strong>${text(dc?.name || '')}</strong><br/>${text(dc?.owner || '')}</div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${text(t('components.deckgl.tooltip.dataCentersCount', { count: numericLabel(obj.count) }))}</strong><br/>${text(obj.country)}</div>` };
      case 'nuclear-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type)}</div>` };
      case 'us-nuclear-facilities-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(US_NUCLEAR_CATEGORY_LABELS[(obj as UsNuclearFacility).category])} · ${text(obj.state)}</div>` };
      case 'datacenters-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.owner)}</div>` };
      case 'cables-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${t('components.deckgl.tooltip.underseaCable')}</div>` };
      case 'pipelines-layer': {
        // Energy variant emits objects with {commodityType, badge}; other
        // variants emit the static-config shape {type}. Differentiate by
        // checking for the evidence-derived badge field.
        const hasBadge = typeof obj.badge === 'string';
        const commodity = hasBadge ? String(obj.commodityType || '').toLowerCase() : String(obj.type || '').toLowerCase();
        const commodityLabel = commodity === 'oil'
          ? t('popups.pipeline.types.oil')
          : commodity === 'gas'
            ? t('popups.pipeline.types.gas')
            : commodity === 'products'
              ? t('popups.pipeline.types.products')
              : `${text(commodity)} ${t('components.deckgl.tooltip.pipeline')}`.trim();
        if (hasBadge) {
          const badge = String(obj.badge).toUpperCase();
          return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${commodityLabel} · <strong>${text(badge)}</strong></div>` };
        }
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${commodityLabel}</div>` };
      }
      case 'natural-events-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.title)}</strong><br/>${text(obj.category || t('components.deckgl.tooltip.naturalEvent'))}</div>` };
      case 'storm-centers-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName || obj.title)}</strong><br/>${text(obj.classification || '')} ${obj.windKt ? numericLabel(obj.windKt) + ` kt${obj.windAveragingPeriodMinutes ? ` (${numericLabel(obj.windAveragingPeriodMinutes)}-minute mean)` : ''}` : ''}</div>` };
      case 'storm-forecast-track-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName)}</strong><br/>${t('popups.naturalEvent.classification')}: Forecast Track</div>` };
      case 'storm-past-track-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName)}</strong><br/>Past Track (${numericLabel(obj.windKt)} kt)</div>` };
      case 'storm-cone-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName)}</strong><br/>Forecast cone of uncertainty<br/><small>Not an observed storm footprint</small></div>` };
      case 'storm-imd-wind-radii-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.stormName || 'IMD cyclone')}</strong><br/>Forecast wind radii ${text(String(obj.thresholdKt || ''))} kt<br/><small>India Meteorological Department · not an observed footprint</small></div>` };
      case 'irradiators-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name)}</strong><br/>${text(obj.type || t('components.deckgl.layers.gammaIrradiators'))}</div>` };
      case 'disease-outbreaks-layer': {
        const item = (obj as { item: DiseaseOutbreakItem }).item;
        if (!item) return null;
        const lvlColor = item.alertLevel === 'alert' ? '#e74c3c' : item.alertLevel === 'warning' ? '#e67e22' : '#f1c40f';
        const casesHtml = item.cases ? ` | ${text(item.cases)} case${item.cases !== 1 ? 's' : ''}` : '';
        const dateStr = new Date(item.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const metaHtml = `<br/><span style="opacity:.6;font-size:calc(11px * var(--wm-panel-effective-scale, 1))">${text(item.sourceName || '')} | ${dateStr}${casesHtml}</span>`;
        const summaryHtml = item.summary ? `<br/><span style="opacity:.75">${text(item.summary.slice(0, 100))}${item.summary.length > 100 ? '…' : ''}</span>` : '';
        return { html: `<div class="deckgl-tooltip"><strong style="color:${lvlColor}">${text(item.alertLevel.toUpperCase())}</strong> ${text(item.disease)}<br/>${text(item.location)}${summaryHtml}${metaHtml}</div>` };
      }
      case 'radiation-watch-layer': {
        const severityLabel = obj.severity === 'spike' ? t('components.deckgl.layers.radiationSpike') : t('components.deckgl.layers.radiationElevated');
        const delta = Number(obj.delta || 0);
        const confidence = String(obj.confidence || 'low').toUpperCase();
        const corroboration = obj.corroborated ? 'CONFIRMED' : obj.conflictingSources ? 'CONFLICTING' : confidence;
        return { html: `<div class="deckgl-tooltip"><strong>${severityLabel}</strong><br/>${text(obj.location)}<br/>${Number(obj.value).toFixed(1)} ${text(obj.unit)} · ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} vs baseline<br/>${text(corroboration)}</div>` };
      }
      case 'cable-advisories-layer': {
        const cableName = UNDERSEA_CABLES.find(c => c.id === obj.cableId)?.name || obj.cableId;
        return { html: `<div class="deckgl-tooltip"><strong>${text(cableName)}</strong><br/>${text(obj.severity || t('components.deckgl.tooltip.advisory'))}<br/>${text(obj.description)}</div>` };
      }
      case 'repair-ships-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.name || t('components.deckgl.tooltip.repairShip'))}</strong><br/>${text(obj.status)}</div>` };
      case 'weather-layer': {
        const areaDesc = typeof obj.areaDesc === 'string' ? obj.areaDesc : '';
        const area = areaDesc ? `<br/><small>${text(areaDesc.slice(0, 50))}${areaDesc.length > 50 ? '...' : ''}</small>` : '';
        const issuedBy = typeof obj.issuedBy === 'string' && obj.issuedBy ? `<br/>${text(obj.issuedBy)}` : '';
        const marine = [obj.wind, obj.seaState, obj.visibility].filter((value) => typeof value === 'string' && value).join(' · ');
        const marineLine = marine ? `<br/><small>${text(marine)}</small>` : '';
        const sourceLine = obj.sourceUrl ? `<br/><small>${text(String(obj.sourceUrl))}</small>` : '';
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.event || t('components.deckgl.layers.weatherAlerts'))}</strong><br/>${text(obj.severity)}${issuedBy}${area}${marineLine}${sourceLine}</div>` };
      }
      case 'outages-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.title || t('components.deckgl.tooltip.internetOutage'))}</strong><br/>${text(obj.country)}</div>` };
      case 'traffic-anomalies-layer':
        return { html: `<div class="deckgl-tooltip"><strong>${text(obj.type || 'Traffic Anomaly')}</strong><br/>${text(obj.locationName || obj.asnName || '')}</div>` };
      case 'ddos-locations-layer':
        return { html: `<div class="deckgl-tooltip"><strong>DDoS: ${text(obj.countryName)}</strong><br/>${text(obj.percentage ? numericLabel(obj.percentage, 1) + '%' : '')}</div>` };
      case 'news-locations-layer': {
        const coverage = corroborationLabelHtml(obj.corroboration);
        return { html: `<div class="deckgl-tooltip"><strong>📰 ${t('components.deckgl.tooltip.news')}</strong><br/>${text(obj.title?.slice(0, 80) || '')}${coverage ? `<br/>${coverage}` : ''}</div>` };
      }
      case 'webcam-layer': {
        const label = 'count' in obj
          ? `${numericLabel(obj.count)} webcams`
          : (obj.title || obj.name || 'Webcam');
        return { html: `<div class="deckgl-tooltip"><strong>${text(label)}</strong></div>` };
      }
      default:
        return null;
    }
  }

  private handleClick(info: PickingInfo): void {
    if (!info.object) {
      if (info.coordinate && this.onCountryClick) {
        if (this.shouldSuppressCountryClickAfterDrag()) return;
        const [lon, lat] = info.coordinate as [number, number];
        const country = resolveCountryForPointerInteraction(
          {
            code: this.hoveredCountryIso2
              ? canonicalizeCountryCode(this.hoveredCountryIso2)
              : this.hoveredCountryIso2,
            name: this.hoveredCountryName,
          },
          this.hoverQueryThrottle?.isPending() ?? false,
          () => this.resolveCountryFromCoordinate(lon, lat),
        );
        // Only fire if we have a country — ocean/no-country clicks are silently ignored
        if (country?.code && country?.name) {
          this.onCountryClick({
            lat,
            lon,
            code: canonicalizeCountryCode(country.code),
            name: country.name,
          });
        }
      }
      return;
    }

    const rawClickLayerId = info.layer?.id || '';
    const layerId = rawClickLayerId.endsWith('-ghost') ? rawClickLayerId.slice(0, -6) : rawClickLayerId;

    if (layerId === 'news-locations-layer') {
      this.onNewsClick?.(info.object as NewsLocationMarker);
      return;
    }

    if (layerId === 'datacenter-clusters-layer') {
      const cluster = info.object as MapDatacenterCluster;
      if (cluster.items.length === 0 && cluster._clusterId != null && this.datacenterSC) {
        try {
          const leaves = this.datacenterSC.getLeaves(cluster._clusterId, DeckGLMap.MAX_CLUSTER_LEAVES);
          cluster.items = leaves.map(l => this.datacenterSCSource[l.properties.index]).filter((x): x is AIDataCenter => !!x);
          cluster.sampled = cluster.items.length < cluster.count;
        } catch (e) {
          console.warn('[DeckGLMap] stale datacenter cluster', cluster._clusterId, e);
          return;
        }
      }
      if (cluster.count === 1 && cluster.items[0]) {
        this.popup.show({ type: 'datacenter', data: cluster.items[0], x: info.x, y: info.y });
      } else {
        this.popup.show({
          type: 'datacenterCluster',
          data: {
            items: cluster.items,
            region: cluster.region || cluster.country,
            country: cluster.country,
            count: cluster.count,
            totalChips: cluster.totalChips,
            totalPowerMW: cluster.totalPowerMW,
            existingCount: cluster.existingCount,
            plannedCount: cluster.plannedCount,
            sampled: cluster.sampled,
          },
          x: info.x,
          y: info.y,
        });
      }
      return;
    }

    if (layerId === 'webcam-layer') {
      this.handleWebcamLayerClick(info);
      return;
    }

    // Map layer IDs to popup types
    const layerToPopupType: Record<string, PopupType> = {
      'nuclear-layer': 'nuclear',
      'us-nuclear-facilities-layer': 'usNuclear',
      'irradiators-layer': 'irradiator',
      'radiation-watch-layer': 'radiation',
      'datacenters-layer': 'datacenter',
      'cables-layer': 'cable',
      'pipelines-layer': 'pipeline',
      'earthquakes-layer': 'earthquake',
      'weather-layer': 'weather',
      'outages-layer': 'outage',
      'natural-events-layer': 'natEvent',
      'storm-centers-layer': 'natEvent',
      'storm-forecast-track-layer': 'natEvent',
      'storm-past-track-layer': 'natEvent',
      'storm-cone-layer': 'natEvent',
      'storm-imd-wind-radii-layer': 'natEvent',
      'cable-advisories-layer': 'cable-advisory',
      'repair-ships-layer': 'repair-ship',
    };

    const popupType = layerToPopupType[layerId];
    if (!popupType) return;

    // Clicking a registry facility also draws its emergency planning zones.
    if (layerId === 'us-nuclear-facilities-layer') {
      this.setSelectedUsNuclearFacility((info.object as UsNuclearFacility).id);
    }

    // For synthetic storm layers, unwrap the backing NaturalEvent
    const data = info.object?._event ?? info.object;

    // Get click coordinates relative to container
    const x = info.x ?? 0;
    const y = info.y ?? 0;

    this.popup.show({
      type: popupType,
      data: data,
      x,
      y,
    });
  }

  /**
   * Layer-level webcam pick. Returns true so deck.gl consumes the event and the
   * global MapLibreOverlay handler does not run a second time (#3877 / #4230).
   * Clusters zoom in instead of opening a tab per camera.
   */
  private handleWebcamLayerClick(info: PickingInfo): boolean {
    return dispatchWebcamLayerClick(info.object, {
      onLeaf: (webcam) => {
        this.showWebcamClickPopup(webcam, info.x, info.y);
      },
      onCluster: (cluster) => {
        const currentZoom = this.maplibreMap?.getZoom() ?? this.state.zoom;
        this.setCenter(cluster.lat, cluster.lng, Math.min(currentZoom + 2, 14));
      },
    });
  }

  private async showWebcamClickPopup(webcam: WebcamLeafLike, x: number, y: number): Promise<void> {
    // Remove any existing popup
    this.container.querySelector('.deckgl-webcam-popup')?.remove();

    const popup = document.createElement('div');
    popup.className = 'deckgl-webcam-popup';
    popup.style.position = 'absolute';
    popup.style.left = x + 'px';
    popup.style.top = y + 'px';
    popup.style.zIndex = '1000';

    const titleEl = document.createElement('div');
    titleEl.className = 'deckgl-webcam-popup-title';
    titleEl.textContent = webcam.title || webcam.webcamId || '';
    popup.appendChild(titleEl);

    const locationEl = document.createElement('div');
    locationEl.className = 'deckgl-webcam-popup-location';
    locationEl.textContent = webcam.country || '';
    popup.appendChild(locationEl);

    const id = webcam.webcamId;
    const streamUrl = resolveWebcamStreamUrl(webcam);
    if (streamUrl) {
      const link = document.createElement('a');
      link.className = 'deckgl-webcam-popup-link';
      link.href = streamUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Open on Windy \u2197';
      popup.appendChild(link);
    }

    const pinBtn = document.createElement('button');
    pinBtn.className = 'webcam-pin-btn';
    let imageData: Awaited<ReturnType<typeof fetchWebcamImage>> | null = null;
    if (isPinned(id)) {
      pinBtn.classList.add('webcam-pin-btn--pinned');
      pinBtn.textContent = '\u{1F4CC} Pinned';
      pinBtn.disabled = true;
    } else {
      pinBtn.textContent = '\u{1F4CC} Pin';
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        pinWebcam({
          webcamId: id,
          title: webcam.title || imageData?.title || '',
          lat: webcam.lat,
          lng: webcam.lng,
          category: webcam.category || 'other',
          country: webcam.country || '',
          playerUrl: imageData?.playerUrl || '',
        });
        pinBtn.classList.add('webcam-pin-btn--pinned');
        pinBtn.textContent = '\u{1F4CC} Pinned';
        pinBtn.disabled = true;
      });
    }
    popup.appendChild(pinBtn);

    const cleanup = () => {
      popup.remove();
      document.removeEventListener('click', closeHandler);
      clearTimeout(autoDismiss);
    };
    const closeHandler = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) cleanup();
    };
    const autoDismiss = setTimeout(cleanup, 8000);
    setTimeout(() => document.addEventListener('click', closeHandler), 0);

    // Show immediately so a slow image fetch cannot look like a dead click.
    this.container.appendChild(popup);

    imageData = await fetchWebcamImage(id).catch(() => null);
    if (!popup.isConnected) return;

    if (imageData?.windyUrl) {
      const existing = popup.querySelector<HTMLAnchorElement>('.deckgl-webcam-popup-link');
      if (existing) existing.href = imageData.windyUrl;
    }
  }

  // Utility methods
  private hexToRgba(hex: string, alpha: number): [number, number, number, number] {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (result?.[1] && result[2] && result[3]) {
      return [
        parseInt(result[1], 16),
        parseInt(result[2], 16),
        parseInt(result[3], 16),
        alpha,
      ];
    }
    return [100, 100, 100, alpha];
  }

  // UI Creation methods
  private createControls(): void {
    const controls = document.createElement('div');
    controls.className = 'map-controls deckgl-controls';
    setTrustedHtml(controls, trustedHtml(`
      <div class="zoom-controls">
        <button class="map-btn zoom-in" title="${t('components.deckgl.zoomIn')}" aria-label="${t('components.deckgl.zoomIn')}">+</button>
        <button class="map-btn zoom-out" title="${t('components.deckgl.zoomOut')}" aria-label="${t('components.deckgl.zoomOut')}">-</button>
        <button class="map-btn zoom-reset" title="${t('components.deckgl.resetView')}" aria-label="${t('components.deckgl.resetView')}">&#8962;</button>
      </div>
      <div class="view-selector">
        <select class="view-select" aria-label="${t('header.selectRegion')}">
          <option value="global">${t('components.deckgl.views.global')}</option>
          <option value="america">${t('components.deckgl.views.americas')}</option>
          <option value="mena">${t('components.deckgl.views.mena')}</option>
          <option value="eu">${t('components.deckgl.views.europe')}</option>
          <option value="asia">${t('components.deckgl.views.asia')}</option>
          <option value="latam">${t('components.deckgl.views.latam')}</option>
          <option value="africa">${t('components.deckgl.views.africa')}</option>
          <option value="oceania">${t('components.deckgl.views.oceania')}</option>
        </select>
      </div>
    `, "legacy direct innerHTML migration"));

    this.container.appendChild(controls);

    // Bind events - use event delegation for reliability
    controls.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('zoom-in')) this.zoomIn();
      else if (target.classList.contains('zoom-out')) this.zoomOut();
      else if (target.classList.contains('zoom-reset')) this.resetView();
    });

    const viewSelect = controls.querySelector('.view-select') as HTMLSelectElement;
    viewSelect.value = this.state.view;
    viewSelect.addEventListener('change', () => {
      this.setView(viewSelect.value as DeckMapView);
    });
  }

  private createTimeSlider(): void {
    const slider = document.createElement('div');
    slider.className = 'time-slider deckgl-time-slider';
    setTrustedHtml(slider, trustedHtml(`
      <div class="time-options">
        <button class="time-btn ${this.state.timeRange === '1h' ? 'active' : ''}" data-range="1h">1h</button>
        <button class="time-btn ${this.state.timeRange === '6h' ? 'active' : ''}" data-range="6h">6h</button>
        <button class="time-btn ${this.state.timeRange === '24h' ? 'active' : ''}" data-range="24h">24h</button>
        <button class="time-btn ${this.state.timeRange === '48h' ? 'active' : ''}" data-range="48h">48h</button>
        <button class="time-btn ${this.state.timeRange === '7d' ? 'active' : ''}" data-range="7d">7d</button>
        <button class="time-btn ${this.state.timeRange === 'all' ? 'active' : ''}" data-range="all">${t('components.deckgl.timeAll')}</button>
      </div>
    `, "legacy direct innerHTML migration"));

    this.container.appendChild(slider);

    slider.querySelectorAll('.time-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const range = (btn as HTMLElement).dataset.range as TimeRange;
        this.setTimeRange(range);
      });
    });
  }

  private updateTimeSliderButtons(): void {
    const slider = this.container.querySelector('.deckgl-time-slider');
    if (!slider) return;
    slider.querySelectorAll('.time-btn').forEach((btn) => {
      const range = (btn as HTMLElement).dataset.range as TimeRange | undefined;
      btn.classList.toggle('active', range === this.state.timeRange);
    });
  }

  private createLayerToggles(): void {
    const toggles = document.createElement('div');
    toggles.className = 'layer-toggles deckgl-layer-toggles';

    const layerDefs = getLayersForVariant(SITE_VARIANT, 'deck');
    const premiumUnlocked = hasPremiumAccess(getAuthState());
    const layerConfig = layerDefs.map(def => ({
      key: def.key,
      label: resolveLayerLabel(def, t),
      icon: def.icon,
      premium: def.premium,
      explainLabel: escapeHtml(`Explain ${resolveLayerLabel(def, t)} layer`),
      hasExplanation: hasCuratedLayerExplanation(def.key),
    }));

    setTrustedHtml(toggles, trustedHtml(`
      <div class="toggle-header">
        <span>${t('components.deckgl.layersTitle')}</span>
        <button class="layer-help-btn" aria-label="${t('components.deckgl.layerGuide')}">?</button>
        <button class="toggle-collapse">&#9660;</button>
      </div>
      <input type="text" class="layer-search" placeholder="${t('components.deckgl.layerSearch')}" autocomplete="off" spellcheck="false" />
      <div class="toggle-list" style="max-height: 32vh; overflow-y: auto; scrollbar-width: thin;">
        ${layerConfig.map(({ key, label, icon, premium, explainLabel, hasExplanation }) => {
          const isLocked = premium === 'locked' && !premiumUnlocked;
          const isEnhanced = premium === 'enhanced' && !premiumUnlocked;
          return `
          <div class="layer-toggle-row" data-layer="${key}">
            <label class="layer-toggle${isLocked ? ' layer-toggle-locked' : ''}" data-layer="${key}">
              <input type="checkbox" ${this.state.layers[key as keyof MapLayers] ? 'checked' : ''}${isLocked ? ' disabled' : ''}>
              <span class="toggle-icon">${icon}</span>
              <span class="toggle-label">${label}${isLocked ? ' \uD83D\uDD12' : ''}${isEnhanced ? ' <span class="layer-pro-badge">PRO</span>' : ''}</span>
            </label>
            <button type="button" class="layer-explain-btn${hasExplanation ? ' has-layer-explanation' : ''}" data-layer="${key}" aria-label="${explainLabel}">i</button>
          </div>`;
        }).join('')}
      </div>
    `, "legacy direct innerHTML migration"));

    const authorBadge = document.createElement('div');
    authorBadge.className = 'map-author-badge';
    authorBadge.textContent = '© Elie Habib · Someone™';
    toggles.appendChild(authorBadge);

    this.container.appendChild(toggles);

    const lockedLayerControls = layerConfig
      .filter(({ premium }) => premium === 'locked')
      .map(({ key, label }) => {
        const control = toggles.querySelector(`.layer-toggle[data-layer="${key}"]`);
        return {
          key,
          label,
          control,
          input: control?.querySelector('input') as HTMLInputElement | null,
          labelSpan: control?.querySelector('.toggle-label') as HTMLElement | null,
        };
      });
    let lastPremiumUnlocked: boolean | null = null;
    let lastSettledFree: boolean | null = null;

    // Reconcile premium controls whenever either entitlement signal changes.
    // Pro can come from Clerk role or the Convex entitlement snapshot, and
    // both subscriptions must remain live: a user can later downgrade or sign
    // out after unlocking a layer. The initial pending state stays visually
    // locked, but it must not be persisted as free until the tier settles (or
    // App's bounded fallback explicitly heals it).
    const syncPremiumLayerControls = (): void => {
      const premiumUnlocked = hasPremiumAccess(getAuthState());
      const settledFree = isProTierResolved() && !premiumUnlocked;
      if (premiumUnlocked === lastPremiumUnlocked && settledFree === lastSettledFree) return;
      lastPremiumUnlocked = premiumUnlocked;
      lastSettledFree = settledFree;
      let stateChanged = false;

      for (const { key, label: layerLabel, control, input, labelSpan } of lockedLayerControls) {
        if (!control) continue;
        const locked = !premiumUnlocked;
        control.classList.toggle('layer-toggle-locked', locked);
        if (input) {
          input.disabled = locked;
          if (settledFree && this.state.layers[key]) {
            this.state.layers[key] = false;
            input.checked = false;
            this.setLayerReady(key, false);
            this.onLayerChange?.(key, false, 'programmatic');
            stateChanged = true;
          }
        }

        if (labelSpan) {
          labelSpan.textContent = locked ? `${layerLabel} 🔒` : layerLabel;
        }
      }

      if (stateChanged) {
        this.render();
        this.updateLegend();
        this.enforceLayerLimit();
      }
    };
    this._unsubscribeAuthState = subscribeAuthState(syncPremiumLayerControls);
    this._unsubscribeEntitlement = onEntitlementChange(syncPremiumLayerControls);

    // Bind toggle events
    toggles.querySelectorAll('.layer-toggle input').forEach(input => {
      input.addEventListener('change', () => {
        const layer = (input as HTMLInputElement).closest('.layer-toggle')?.getAttribute('data-layer') as keyof MapLayers;
        if (layer) {
          const enabled = (input as HTMLInputElement).checked;
          if (!isLayerToggleAllowed(layer, this.state.layers[layer], hasPremiumAccess(getAuthState()))) {
            (input as HTMLInputElement).checked = Boolean(this.state.layers[layer]);
            return;
          }
          const prevRadar = this.state.layers.weather;
          this.state.layers[layer] = enabled;
          if (this.state.layers.weather && !prevRadar) this.startWeatherRadar();
          else if (!this.state.layers.weather && prevRadar) this.stopWeatherRadar();
          this.render();
          this.updateLegend();
          this.onLayerChange?.(layer, enabled, 'user');
          this.enforceLayerLimit();
        }
      });
    });
    this.enforceLayerLimit();

    toggles.querySelectorAll('.layer-explain-btn').forEach(button => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const layer = (button as HTMLElement).getAttribute('data-layer') as keyof MapLayers | null;
        if (layer) this.showLayerExplanation(layer);
      });
    });

    // Help button
    const helpBtn = toggles.querySelector('.layer-help-btn');
    helpBtn?.addEventListener('click', () => this.showLayerHelp());

    // Collapse toggle
    const collapseBtn = toggles.querySelector('.toggle-collapse');
    const toggleList = toggles.querySelector('.toggle-list');

    // Manual scroll: intercept wheel, prevent map zoom, scroll the list ourselves
    if (toggleList) {
      toggles.addEventListener('wheel', (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleList.scrollTop += e.deltaY;
      }, { passive: false });
      toggles.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: false });
    }
    bindLayerSearch(toggles);
    const searchEl = toggles.querySelector('.layer-search') as HTMLElement | null;

    collapseBtn?.addEventListener('click', () => {
      toggleList?.classList.toggle('collapsed');
      if (searchEl) searchEl.style.display = toggleList?.classList.contains('collapsed') ? 'none' : '';
      if (collapseBtn) setTrustedHtml(collapseBtn, trustedHtml(toggleList?.classList.contains('collapsed') ? '&#9654;' : '&#9660;', "legacy direct innerHTML migration"));
    });
  }

  private showLayerExplanation(layer: keyof MapLayers): void {
    const existing = this.container.querySelector('.layer-explanation-popup') as HTMLElement | null;
    if (existing?.dataset.layer === layer) {
      existing.remove();
      this.container.querySelector(`.layer-explain-btn[data-layer="${layer}"]`)?.classList.remove('active');
      return;
    }
    existing?.remove();
    this.container.querySelector('.layer-help-popup')?.remove();
    this.container.querySelectorAll('.layer-explain-btn.active').forEach(btn => btn.classList.remove('active'));

    const def = getLayersForVariant(SITE_VARIANT, 'deck').find(item => item.key === layer);
    const layerLabel = def ? resolveLayerLabel(def, t) : String(layer);
    const explanation = getLayerExplanation(layer);
    const popup = document.createElement('div');
    popup.className = 'layer-explanation-popup';
    popup.dataset.layer = layer;
    setTrustedHtml(popup, trustedHtml(
      renderLayerExplanationCard(layerLabel, explanation),
      "static layer explanation metadata",
    ));

    const closePopup = (): void => {
      popup.remove();
      this.container.querySelector(`.layer-explain-btn[data-layer="${layer}"]`)?.classList.remove('active');
    };

    popup.querySelector('.layer-explanation-close')?.addEventListener('click', closePopup);
    this.container.appendChild(popup);
    this.container.querySelector(`.layer-explain-btn[data-layer="${layer}"]`)?.classList.add('active');
  }

  /** Show layer help popup explaining each layer */
  private showLayerHelp(): void {
    const existing = this.container.querySelector('.layer-help-popup');
    if (existing) {
      existing.remove();
      return;
    }
    this.container.querySelector('.layer-explanation-popup')?.remove();
    this.container.querySelectorAll('.layer-explain-btn.active').forEach(btn => btn.classList.remove('active'));

    const popup = document.createElement('div');
    popup.className = 'layer-help-popup';

    const label = (layerKey: string): string => t(`components.deckgl.layers.${layerKey}`).toUpperCase();
    const staticLabel = (labelKey: string): string => t(`components.deckgl.layerHelp.labels.${labelKey}`).toUpperCase();
    const helpItem = (layerLabel: string, descriptionKey: string): string =>
      `<div class="layer-help-item"><span>${layerLabel}</span> ${t(`components.deckgl.layerHelp.descriptions.${descriptionKey}`)}</div>`;
    const helpSection = (titleKey: string, items: string[], noteKey?: string): string => `
      <div class="layer-help-section">
        <div class="layer-help-title">${t(`components.deckgl.layerHelp.sections.${titleKey}`)}</div>
        ${items.join('')}
        ${noteKey ? `<div class="layer-help-note">${t(`components.deckgl.layerHelp.notes.${noteKey}`)}</div>` : ''}
      </div>
    `;
    const helpHeader = `
      <div class="layer-help-header">
        <span>${t('components.deckgl.layerHelp.title')}</span>
        <button class="layer-help-close" aria-label="Close">×</button>
      </div>
    `;

    const fullHelpContent = `
      ${helpHeader}
      <div class="layer-help-content">
        ${helpSection('timeFilter', [
      helpItem(staticLabel('timeRecent'), 'timeRecent'),
      helpItem(staticLabel('timeExtended'), 'timeExtended'),
    ], 'timeAffects')}
        ${helpSection('militaryStrategic', [
      helpItem(label('nuclearSites'), 'militaryNuclear'),
      helpItem(label('gammaIrradiators'), 'militaryIrradiators'),
    ])}
        ${helpSection('infrastructure', [
      helpItem(label('underseaCables'), 'infraCablesFull'),
      helpItem(label('pipelines'), 'infraPipelinesFull'),
      helpItem(label('internetOutages'), 'infraOutages'),
      helpItem(label('aiDataCenters'), 'infraDatacentersFull'),
    ])}
        ${helpSection('naturalEconomic', [
      helpItem(label('naturalEvents'), 'naturalEventsFull'),
      helpItem(label('fires'), 'firesFull'),
      helpItem(label('weatherAlerts'), 'weatherAlerts'),
      helpItem(label('climateAnomalies'), 'climateAnomalies'),
    ])}
        ${helpSection('overlays', [
      helpItem(label('dayNight'), 'dayNight'),
      helpItem(staticLabel('countries'), 'countriesOverlay'),
    ])}
      </div>
    `;

    setTrustedHtml(popup, trustedHtml(fullHelpContent, "legacy direct innerHTML migration"));

    popup.querySelector('.layer-help-close')?.addEventListener('click', () => popup.remove());

    // Prevent scroll events from propagating to map
    const content = popup.querySelector('.layer-help-content');
    if (content) {
      content.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });
      content.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: false });
    }

    // Close on click outside
    setTimeout(() => {
      const closeHandler = (e: MouseEvent) => {
        if (!popup.contains(e.target as Node)) {
          popup.remove();
          document.removeEventListener('click', closeHandler);
        }
      };
      document.addEventListener('click', closeHandler);
    }, 100);

    this.container.appendChild(popup);
  }

  private createLegend(): void {
    const legend = document.createElement('div');
    legend.className = 'map-legend deckgl-legend';

    // SVG shapes for different marker types
    const shapes = {
      circle: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="${color}"/></svg>`,
      triangle: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><polygon points="6,1 11,10 1,10" fill="${color}"/></svg>`,
      square: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" rx="1" fill="${color}"/></svg>`,
      hexagon: (color: string) => `<svg width="12" height="12" viewBox="0 0 12 12"><polygon points="6,1 10.5,3.5 10.5,8.5 6,11 1.5,8.5 1.5,3.5" fill="${color}"/></svg>`,
    };

    const isLight = getCurrentTheme() === 'light';
    const legendItems: { shape: string; label: string; layerKey: keyof MapLayers }[] = SITE_VARIANT === 'nuclear'
      ? [
        { shape: shapes.hexagon('rgb(245, 197, 24)'), label: 'Operating power reactor', layerKey: 'usNuclearFacilities' },
        { shape: shapes.hexagon('rgb(46, 204, 113)'), label: 'Restart program', layerKey: 'usNuclearFacilities' },
        { shape: shapes.hexagon('rgb(52, 152, 219)'), label: 'New build / advanced reactor', layerKey: 'usNuclearFacilities' },
        { shape: shapes.hexagon('rgb(231, 76, 60)'), label: 'DOE / NNSA site', layerKey: 'usNuclearFacilities' },
        { shape: shapes.hexagon('rgb(155, 89, 182)'), label: 'Fuel cycle', layerKey: 'usNuclearFacilities' },
        { shape: shapes.hexagon('rgb(26, 188, 156)'), label: 'Research reactor', layerKey: 'usNuclearFacilities' },
        { shape: shapes.hexagon('rgb(149, 165, 166)'), label: 'Decommissioning / waste', layerKey: 'usNuclearFacilities' },
        { shape: shapes.circle('rgb(255, 68, 68)'), label: t('components.deckgl.layers.radiationSpike'), layerKey: 'radiationWatch' },
        { shape: shapes.circle('rgb(255, 165, 0)'), label: t('components.deckgl.layers.radiationElevated'), layerKey: 'radiationWatch' },
      ]
      : [
        { shape: shapes.hexagon(isLight ? 'rgb(180, 120, 0)' : 'rgb(255, 220, 0)'), label: t('components.deckgl.legend.nuclear'), layerKey: 'nuclear' },
        { shape: shapes.square('rgb(136, 68, 255)'), label: t('components.deckgl.legend.datacenter'), layerKey: 'datacenters' },
        { shape: shapes.circle('rgb(231, 76, 60)'), label: t('components.deckgl.legend.diseaseAlert'), layerKey: 'diseaseOutbreaks' },
        { shape: shapes.circle('rgb(230, 126, 34)'), label: t('components.deckgl.legend.diseaseWarning'), layerKey: 'diseaseOutbreaks' },
        { shape: shapes.circle('rgb(241, 196, 15)'), label: t('components.deckgl.legend.diseaseWatch'), layerKey: 'diseaseOutbreaks' },
      ];

    setTrustedHtml(legend, trustedHtml(`
      <span class="legend-label-title">${t('components.deckgl.legend.title')}</span>
      ${legendItems.map(({ shape, label, layerKey }) => `<span class="legend-item" data-layer="${layerKey}">${shape}<span class="legend-label">${label}</span></span>`).join('')}
    `, "legacy direct innerHTML migration"));

    this.container.appendChild(legend);
    this.updateLegend();
  }

  private updateLegend(): void {
    this.container.querySelectorAll<HTMLElement>('.legend-item[data-layer]').forEach(item => {
      const layerKey = item.dataset.layer;
      if (!layerKey || !(layerKey in this.state.layers)) return;
      item.style.display = this.state.layers[layerKey as keyof MapLayers] ? '' : 'none';
    });
  }

  // Public API methods (matching MapComponent interface)
  public render(): void {
    if (this.renderPaused) {
      this.renderPending = true;
      return;
    }
    if (this.renderRafId !== null) {
      cancelAnimationFrame(this.renderRafId);
    }
    this.renderRafId = requestAnimationFrame(() => {
      this.renderRafId = null;
      this.updateLayers();
    });
  }

  public setRenderPaused(paused: boolean): void {
    if (this.renderPaused === paused) return;
    this.renderPaused = paused;
    if (paused) {
      if (this.renderRafId !== null) {
        cancelAnimationFrame(this.renderRafId);
        this.renderRafId = null;
        this.renderPending = true;
      }
      this.stopPulseAnimation();
      this.stopDayNightTimer();
      return;
    }

    this.syncPulseAnimation();
    if (this.state.layers.dayNight) this.startDayNightTimer();
    if (!paused && this.renderPending) {
      this.renderPending = false;
      this.render();
    }
  }

  private updateLayers(): void {
    if (this.renderPaused || this.webglLost || !this.maplibreMap) return;
    const startTime = performance.now();
    let jsBuild = 0;
    let layerCount = 0;
    try {
      const buildStart = performance.now();
      const built = this.buildLayers();
      jsBuild = performance.now() - buildStart;
      layerCount = built.length;
      this.deckOverlay?.setProps({ layers: built });
    } catch { /* map may be mid-teardown (null.getProjection) */ }
    if (import.meta.env.DEV) {
      // Attribute a slow frame to our JS build vs deck.gl's commit (#4558).
      // Sample total BEFORE triggerRepaint() so the deckCommit bucket isolates
      // setProps tessellation and doesn't absorb the repaint-schedule cost.
      const summary = summarizeRenderTiming({ total: performance.now() - startTime, jsBuild, layerCount });
      if (summary.overBudget) console.warn(formatRenderTiming(summary));
    }
    this.maplibreMap.triggerRepaint();
    this.updateZoomHints();
  }

  private updateZoomHints(): void {
    const toggleList = this.container.querySelector('.deckgl-layer-toggles .toggle-list');
    if (!toggleList) return;
    // Mirror isLayerVisible()'s zoom source exactly so the guard key can
    // never disagree with the visibility computation it protects.
    const zoom = this.maplibreMap?.getZoom() || 2;
    // Skip the full toggle-DOM scan when neither the visibility inputs
    // (zoom, layer flags) nor the row nodes changed (#7776).
    if (!this.zoomHintGuard.shouldScan({ zoom, layers: this.state.layers }, toggleList)) return;
    for (const [key, enabled] of Object.entries(this.state.layers)) {
      const toggle = toggleList.querySelector(`.layer-toggle[data-layer="${key}"]`) as HTMLElement | null;
      if (!toggle) continue;
      const zoomHidden = !!enabled && !this.isLayerVisible(key as keyof MapLayers);
      toggle.classList.toggle('zoom-hidden', zoomHidden);
    }
    this.zoomHintGuard.markScanned({ zoom, layers: this.state.layers }, toggleList);
  }

  private markViewportMoving(target: { lat: number; lon: number; zoom: number }, fallbackMs: number): number {
    // Every concrete renderer command owns a distinct settlement generation.
    // This also catches renderer-local controls that bypass MapContainer's
    // facade token: superseding them must never make the older caller succeed.
    this.resolveViewportSettled?.(false);
    this.viewportSettledPromise = new Promise((resolve) => {
      this.resolveViewportSettled = resolve;
    });
    const generation = ++this.viewportMovementGeneration;
    this.viewportTarget = target;
    this.viewportSettleDeadline = Date.now() + 15_000;
    if (this.viewportSettleTimeoutId) clearTimeout(this.viewportSettleTimeoutId);
    // MapLibre normally resolves this through moveend. The timer only resolves
    // when the live camera actually reached the requested target; background
    // tabs may throttle animation frames while allowing timers to continue.
    this.viewportSettleTimeoutId = setTimeout(
      () => this.trySettleViewportMovement(false, generation),
      fallbackMs,
    );
    return generation;
  }

  private trySettleViewportMovement(
    finalMovementEvent = false,
    generation = this.viewportMovementGeneration,
  ): void {
    if (generation !== this.viewportMovementGeneration) return;
    if (this.destroyed) {
      this.settleViewportMovement(false, generation);
      return;
    }
    const target = this.viewportTarget;
    const center = this.maplibreMap?.getCenter();
    const zoom = this.maplibreMap?.getZoom();
    const longitudeDelta = target && center
      ? Math.abs((((center.lng - target.lon) + 540) % 360) - 180)
      : Number.POSITIVE_INFINITY;
    const atTarget = Boolean(target && center && zoom != null
      && Math.abs(center.lat - target.lat) <= 0.0001
      && longitudeDelta <= 0.0001
      && Math.abs(zoom - target.zoom) <= 0.01);
    if (!this.maplibreMap?.isMoving() && atTarget) {
      this.settleViewportMovement(true, generation);
      return;
    }
    if (finalMovementEvent && !this.maplibreMap?.isMoving()) {
      this.settleViewportMovement(false, generation);
      return;
    }
    if (Date.now() >= this.viewportSettleDeadline) {
      this.settleViewportMovement(false, generation);
      return;
    }
    this.viewportSettleTimeoutId = setTimeout(
      () => this.trySettleViewportMovement(false, generation),
      100,
    );
  }

  private settleViewportMovement(
    completed: boolean,
    generation = this.viewportMovementGeneration,
  ): void {
    if (generation !== this.viewportMovementGeneration) return;
    if (this.viewportSettleTimeoutId) {
      clearTimeout(this.viewportSettleTimeoutId);
      this.viewportSettleTimeoutId = null;
    }
    this.viewportTarget = null;
    this.viewportSettleDeadline = 0;
    this.viewportMovementGeneration++;
    const resolve = this.resolveViewportSettled;
    this.resolveViewportSettled = null;
    resolve?.(completed);
  }

  public whenViewportSettled(): Promise<boolean> {
    return this.viewportSettledPromise;
  }

  public setView(view: DeckMapView, zoom?: number): void {
    const preset = VIEW_PRESETS[view];
    if (!preset) return;
    this.state.view = view;
    // Eagerly write target zoom+center so getState()/getCenter() return the
    // correct destination before moveend fires. Without this a 250ms URL sync
    // reads the old cached zoom or an intermediate animated center and
    // overwrites URL params (e.g. ?view=mena&zoom=4 → wrong coords).
    this.state.zoom = zoom ?? preset.zoom;
    this.pendingCenter = { lat: preset.latitude, lon: preset.longitude };

    if (this.maplibreMap) {
      const viewportMovementGeneration = this.markViewportMoving({
        lat: preset.latitude,
        lon: preset.longitude,
        zoom: this.state.zoom,
      }, 1_300);
      this.maplibreMap.flyTo({
        center: [preset.longitude, preset.latitude],
        zoom: this.state.zoom,
        duration: 1000,
      }, { [VIEWPORT_MOVEMENT_EVENT_KEY]: viewportMovementGeneration });
    }

    const viewSelect = this.container.querySelector('.view-select') as HTMLSelectElement;
    if (viewSelect) viewSelect.value = view;

    this.onStateChange?.(this.getState());
  }

  public setZoom(zoom: number): void {
    this.state.zoom = zoom;
    if (this.maplibreMap) {
      this.maplibreMap.setZoom(zoom);
    }
  }

  public setCenter(lat: number, lon: number, zoom?: number): void {
    // Publish the requested destination immediately, matching setView(). This
    // keeps URL/context reads truthful even if flyTo is interrupted or its
    // moveend arrives after a programmatic caller's bounded settlement wait.
    this.pendingCenter = { lat, lon };
    if (zoom != null) this.state.zoom = zoom;
    if (this.maplibreMap) {
      const viewportMovementGeneration = this.markViewportMoving({
        lat,
        lon,
        zoom: zoom ?? this.maplibreMap.getZoom(),
      }, 800);
      this.maplibreMap.flyTo({
        center: [lon, lat],
        ...(zoom != null && { zoom }),
        duration: 500,
      }, { [VIEWPORT_MOVEMENT_EVENT_KEY]: viewportMovementGeneration });
    }
    this.onStateChange?.(this.getState());
  }

  public fitCountry(code: string): void {
    const bbox = getCountryBbox(code);
    if (!bbox || !this.maplibreMap) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    this.maplibreMap.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
      padding: 40,
      duration: 800,
      maxZoom: 8,
    });
  }

  public getCenter(): { lat: number; lon: number } | null {
    if (this.pendingCenter) return this.pendingCenter;
    if (this.maplibreMap) {
      const center = this.maplibreMap.getCenter();
      return { lat: center.lat, lon: center.lng };
    }
    return null;
  }

  public getBbox(): string | null {
    if (!this.maplibreMap) return null;
    const b = this.maplibreMap.getBounds();
    return `${b.getWest().toFixed(4)},${b.getSouth().toFixed(4)},${b.getEast().toFixed(4)},${b.getNorth().toFixed(4)}`;
  }

  public setTimeRange(range: TimeRange): void {
    this.state.timeRange = range;
    this.onTimeRangeChange?.(range);
    this.updateTimeSliderButtons();
    this.render(); // Debounced
  }

  public getTimeRange(): TimeRange {
    return this.state.timeRange;
  }

  public setLayers(layers: MapLayers): void {
    // #6045 — strip locked premium layers for settled free users before
    // checkbox force-sync (prevents checked+disabled stuck state from any
    // bulk path: mission presets, layers:all, URL, cloud prefs).
    let next = layers;
    if (isProTierResolved() && !hasPremiumAccess(getAuthState())) {
      next = sanitizeLockedLayers(layers, false);
    }
    const prevRadar = this.state.layers.weather;
    this.state.layers = { ...next };
    if (this.state.layers.weather && !prevRadar) this.startWeatherRadar();
    else if (!this.state.layers.weather && prevRadar) this.stopWeatherRadar();
    this.render(); // Debounced
    this.updateLegend();

    Object.entries(this.state.layers).forEach(([key, value]) => {
      const toggle = this.container.querySelector(`.layer-toggle[data-layer="${key}"] input`) as HTMLInputElement;
      if (toggle) toggle.checked = value;
    });
  }

  public getState(): DeckMapState {
    return {
      ...this.state,
      pan: { ...this.state.pan },
      layers: { ...this.state.layers },
    };
  }

  // Zoom controls - public for external access
  public zoomIn(): void {
    if (this.maplibreMap) {
      this.maplibreMap.zoomIn();
    }
  }

  public zoomOut(): void {
    if (this.maplibreMap) {
      this.maplibreMap.zoomOut();
    }
  }

  private resetView(): void {
    this.setView('global');
  }

  private createClimateHeatmapLayer(): ScatterplotLayer<ClimateAnomaly> {
    return new ScatterplotLayer<ClimateAnomaly>({
      id: 'climate-heatmap-layer',
      data: this.climateAnomalies,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => 14_000 + Math.min(80_000, (Math.abs(d.tempDelta) + Math.abs(d.precipDelta) * 0.1) * 18_000),
      getFillColor: (d) => {
        const weight = Math.abs(d.tempDelta) + Math.abs(d.precipDelta) * 0.1;
        if (weight >= 4) return [255, 50, 50, 120] as [number, number, number, number];
        if (weight >= 2.5) return [255, 140, 50, 110] as [number, number, number, number];
        if (weight >= 1.25) return [255, 220, 80, 95] as [number, number, number, number];
        return [100, 200, 255, 85] as [number, number, number, number];
      },
      radiusMinPixels: 12,
      radiusMaxPixels: 72,
      stroked: false,
      pickable: false,
    });
  }

  private computeNightPolygon(): [number, number][] {
    const now = new Date();
    const JD = now.getTime() / 86400000 + 2440587.5;
    const D = JD - 2451545.0; // Days since J2000.0

    // Solar mean anomaly (radians)
    const g = ((357.529 + 0.98560028 * D) % 360) * Math.PI / 180;

    // Solar ecliptic longitude (degrees)
    const q = (280.459 + 0.98564736 * D) % 360;
    const L = q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
    const LRad = L * Math.PI / 180;

    // Obliquity of ecliptic (radians)
    const eRad = (23.439 - 0.00000036 * D) * Math.PI / 180;

    // Solar declination (radians)
    const decl = Math.asin(Math.sin(eRad) * Math.sin(LRad));

    // Solar right ascension (radians)
    const RA = Math.atan2(Math.cos(eRad) * Math.sin(LRad), Math.cos(LRad));

    // Greenwich Mean Sidereal Time (degrees)
    const GMST = ((18.697374558 + 24.06570982441908 * D) % 24) * 15;

    // Sub-solar longitude (degrees, normalized to [-180, 180])
    let sunLng = RA * 180 / Math.PI - GMST;
    sunLng = ((sunLng % 360) + 540) % 360 - 180;

    // Trace terminator line (1° steps for smooth curve at high zoom)
    const tanDecl = Math.tan(decl);
    const points: [number, number][] = [];

    // Near equinox (|tanDecl| ≈ 0), the terminator is nearly a great circle
    // through the poles — use a vertical line at the subsolar meridian ±90°
    if (Math.abs(tanDecl) < 1e-6) {
      for (let lat = -90; lat <= 90; lat += 1) {
        points.push([sunLng + 90, lat]);
      }
      for (let lat = 90; lat >= -90; lat -= 1) {
        points.push([sunLng - 90, lat]);
      }
      return points;
    }

    for (let lng = -180; lng <= 180; lng += 1) {
      const ha = (lng - sunLng) * Math.PI / 180;
      const lat = Math.atan(-Math.cos(ha) / tanDecl) * 180 / Math.PI;
      points.push([lng, lat]);
    }

    // Close polygon around the dark pole
    const darkPoleLat = decl > 0 ? -90 : 90;
    points.push([180, darkPoleLat]);
    points.push([-180, darkPoleLat]);

    return points;
  }

  private createDayNightLayer(): PolygonLayer {
    const nightPolygon = this.cachedNightPolygon ?? (this.cachedNightPolygon = this.computeNightPolygon());
    const isLight = getCurrentTheme() === 'light';

    return new PolygonLayer({
      id: 'day-night-layer',
      data: [{ polygon: nightPolygon }],
      getPolygon: (d: { polygon: [number, number][] }) => d.polygon,
      getFillColor: isLight ? [0, 0, 40, 35] : [0, 0, 20, 55],
      filled: true,
      stroked: true,
      getLineColor: isLight ? [100, 100, 100, 40] : [200, 200, 255, 25],
      getLineWidth: 1,
      lineWidthUnits: 'pixels' as const,
      pickable: false,
    });
  }

  // Data setters - all use render() for debouncing
  public setEarthquakes(earthquakes: Earthquake[]): void {
    this.earthquakes = earthquakes;
    this.render();
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.weatherAlerts = alerts;
    this.render();
  }

  public setOutages(outages: InternetOutage[]): void {
    this.outages = outages;
    this.render();
  }

  public setTrafficAnomalies(anomalies: ProtoTrafficAnomaly[]): void {
    this.trafficAnomalies = anomalies;
    this.render();
  }

  public setDdosLocations(hits: DdosLocationHit[]): void {
    this.ddosLocations = hits;
    this.render();
  }

  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    this.cableAdvisories = advisories;
    this.repairShips = repairShips;
    this.render();
  }

  public setCableHealth(healthMap: Record<string, CableHealthRecord>): void {
    this.healthByCableId = healthMap;
    this.layerCache.delete('cables-layer');
    this.render();
  }

  public setNaturalEvents(events: NaturalEvent[]): void {
    this.naturalEvents = events;
    this.render();
  }

  public setFires(fires: Array<{ lat: number; lon: number; brightness: number; frp: number; confidence: number; region: string; acq_date: string; daynight: string }>): void {
    this.firmsFireData = fires;
    this.render();
  }

  public setClimateAnomalies(anomalies: ClimateAnomaly[]): void {
    this.climateAnomalies = anomalies;
    this.render();
  }

  public setRadiationObservations(observations: RadiationObservation[]): void {
    this.radiationObservations = observations;
    this.render();
  }

  public setWebcams(markers: Array<WebcamEntry | WebcamCluster>): void {
    this.webcamData = markers.map((m) =>
      'count' in m
        ? { ...m, _kind: 'webcam-cluster' as const }
        : { ...m, _kind: 'webcam' as const },
    );
    this.render();
  }

  public setDiseaseOutbreaks(outbreaks: DiseaseOutbreakItem[]): void {
    this.diseaseOutbreaks = outbreaks;
    this.render();
  }

  public setNewsLocations(data: NewsLocationMarker[]): void {
    const now = Date.now();
    for (const d of data) {
      if (!this.newsLocationFirstSeen.has(d.title)) {
        this.newsLocationFirstSeen.set(d.title, now);
      }
    }
    for (const [key, ts] of this.newsLocationFirstSeen) {
      if (now - ts > 60_000) this.newsLocationFirstSeen.delete(key);
    }
    this.newsLocations = data;
    this.render();

    this.syncPulseAnimation(now);
  }

  public highlightAssets(assets: RelatedAsset[] | null): void {
    // Clear previous highlights
    Object.values(this.highlightedAssets).forEach(set => set.clear());

    if (assets) {
      assets.forEach(asset => {
        if (asset?.type && this.highlightedAssets[asset.type]) {
          this.highlightedAssets[asset.type].add(asset.id);
        }
      });
    }

    this.render(); // Debounced
  }

  public setOnNewsClick(callback: (item: Pick<NewsLocationMarker, 'article' | 'title'>) => void): void {
    this.onNewsClick = callback;
  }

  public setOnTimeRangeChange(callback: (range: TimeRange) => void): void {
    this.onTimeRangeChange = callback;
  }

  public setOnLayerChange(callback: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void {
    this.onLayerChange = callback;
  }

  public setOnStateChange(callback: (state: DeckMapState) => void): void {
    this.onStateChange = callback;
  }

  private layerWarningShown = false;
  private lastActiveLayerCount = 0;

  private enforceLayerLimit(): void {
    const WARN_THRESHOLD = 13;
    const togglesEl = this.container.querySelector('.deckgl-layer-toggles');
    if (!togglesEl) return;
    const activeCount = Array.from(togglesEl.querySelectorAll<HTMLInputElement>('.layer-toggle input'))
      .filter(i => {
        const toggle = i.closest('.layer-toggle') as HTMLElement | null;
        const row = i.closest('.layer-toggle-row') as HTMLElement | null;
        return toggle?.style.display !== 'none' && row?.style.display !== 'none';
      })
      .filter(i => i.checked).length;
    const increasing = activeCount > this.lastActiveLayerCount;
    this.lastActiveLayerCount = activeCount;
    if (activeCount >= WARN_THRESHOLD && increasing && !this.layerWarningShown) {
      this.layerWarningShown = true;
      showLayerWarning(WARN_THRESHOLD);
    } else if (activeCount < WARN_THRESHOLD) {
      this.layerWarningShown = false;
    }
  }

  // UI visibility methods
  public hideLayerToggle(layer: keyof MapLayers): void {
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (toggle) {
      const row = toggle.closest('.layer-toggle-row') as HTMLElement | null;
      const target = (row ?? toggle) as HTMLElement;
      target.style.display = 'none';
      toggle.setAttribute('data-layer-hidden', '');
    }
  }

  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (toggle) toggle.classList.toggle('loading', loading);
  }

  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (!toggle) return;

    toggle.classList.remove('loading');
    // Match old Map.ts behavior: set 'active' only when layer enabled AND has data
    if (this.state.layers[layer] && hasData) {
      toggle.classList.add('active');
    } else {
      toggle.classList.remove('active');
    }
  }

  public flashAssets(assetType: AssetType, ids: string[]): void {
    if (!this.highlightedAssets[assetType]) return;
    ids.forEach(id => this.highlightedAssets[assetType].add(id));
    this.render();

    setTimeout(() => {
      ids.forEach(id => this.highlightedAssets[assetType]?.delete(id));
      this.render();
    }, 3000);
  }

  // Enable layer programmatically
  public enableLayer(layer: keyof MapLayers): void {
    // Defense in depth for CMD+K / agent / deep-link paths: locked premium
    // layers stay off for free users (#6045). search-manager also gates
    // before calling here; this catches any remaining enableLayer callers.
    if (!isLayerEntitled(layer, hasPremiumAccess(getAuthState()))) return;
    if (!this.state.layers[layer]) {
      this.state.layers[layer] = true;
      const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"] input`) as HTMLInputElement;
      if (toggle) toggle.checked = true;
      if (layer === 'weather') this.startWeatherRadar();
      this.render();
      this.updateLegend();
      this.onLayerChange?.(layer, true, 'programmatic');
      this.enforceLayerLimit();
    }
  }

  // Toggle layer on/off programmatically
  public toggleLayer(layer: keyof MapLayers): void {
    const prevRadar = this.state.layers.weather;
    if (!isLayerToggleAllowed(layer, this.state.layers[layer], hasPremiumAccess(getAuthState()))) return;
    this.state.layers[layer] = !this.state.layers[layer];
    const toggle = this.container.querySelector(`.layer-toggle[data-layer="${layer}"] input`) as HTMLInputElement;
    if (toggle) toggle.checked = this.state.layers[layer];
    if (this.state.layers.weather && !prevRadar) this.startWeatherRadar();
    else if (!this.state.layers.weather && prevRadar) this.stopWeatherRadar();
    this.render();
    this.updateLegend();
    this.onLayerChange?.(layer, this.state.layers[layer], 'programmatic');
    this.enforceLayerLimit();
  }

  // Update legend visibility based on which layers are currently active
  // Get center coordinates for programmatic popup positioning
  private getContainerCenter(): { x: number; y: number } {
    const rect = this.container.getBoundingClientRect();
    return { x: rect.width / 2, y: rect.height / 2 };
  }

  // Project lat/lon to screen coordinates without moving the map
  private projectToScreen(lat: number, lon: number): { x: number; y: number } | null {
    if (!this.maplibreMap) return null;
    const point = this.maplibreMap.project([lon, lat]);
    return { x: point.x, y: point.y };
  }

  public triggerPipelineClick(id: string): void {
    const pipeline = PIPELINES.find(p => p.id === id);
    if (pipeline && pipeline.points.length > 0) {
      const midIdx = Math.floor(pipeline.points.length / 2);
      const midPoint = pipeline.points[midIdx];
      // Don't pan - show popup at projected screen position or center
      const screenPos = midPoint ? this.projectToScreen(midPoint[1], midPoint[0]) : null;
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'pipeline', data: pipeline, x, y });
    }
  }

  public triggerCableClick(id: string): void {
    const cable = UNDERSEA_CABLES.find(c => c.id === id);
    if (cable && cable.points.length > 0) {
      const midIdx = Math.floor(cable.points.length / 2);
      const midPoint = cable.points[midIdx];
      // Don't pan - show popup at projected screen position or center
      const screenPos = midPoint ? this.projectToScreen(midPoint[1], midPoint[0]) : null;
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'cable', data: cable, x, y });
    }
  }

  public triggerDatacenterClick(id: string): void {
    const dc = AI_DATA_CENTERS.find(d => d.id === id);
    if (dc) {
      // Don't pan - show popup at projected screen position or center
      const screenPos = this.projectToScreen(dc.lat, dc.lon);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'datacenter', data: dc, x, y });
    }
  }

  public triggerNuclearClick(id: string): void {
    const facility = NUCLEAR_FACILITIES.find(n => n.id === id);
    if (facility) {
      // Don't pan - show popup at projected screen position or center
      const screenPos = this.projectToScreen(facility.lat, facility.lon);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'nuclear', data: facility, x, y });
    }
  }

  public triggerIrradiatorClick(id: string): void {
    const irradiator = GAMMA_IRRADIATORS.find(i => i.id === id);
    if (irradiator) {
      // Don't pan - show popup at projected screen position or center
      const screenPos = this.projectToScreen(irradiator.lat, irradiator.lon);
      const { x, y } = screenPos || this.getContainerCenter();
      this.popup.show({ type: 'irradiator', data: irradiator, x, y });
    }
  }

  public flashLocation(lat: number, lon: number, durationMs = 2000): void {
    // Don't pan - project coordinates to screen position
    const screenPos = this.projectToScreen(lat, lon);
    if (!screenPos) return;

    // Flash effect by temporarily adding a highlight at the location
    const flashMarker = document.createElement('div');
    flashMarker.className = 'flash-location-marker';
    flashMarker.style.cssText = `
      position: absolute;
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.5);
      border: 2px solid #fff;
      animation: flash-pulse 0.5s ease-out infinite;
      pointer-events: none;
      z-index: 1000;
      left: ${screenPos.x}px;
      top: ${screenPos.y}px;
      transform: translate(-50%, -50%);
    `;

    // Add animation keyframes if not present
    if (!document.getElementById('flash-animation-styles')) {
      const style = document.createElement('style');
      style.id = 'flash-animation-styles';
      style.textContent = `
        @keyframes flash-pulse {
          0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
          100% { transform: translate(-50%, -50%) scale(2); opacity: 0; }
        }
      `;
      document.head.appendChild(style);
    }

    const wrapper = this.container.querySelector('.deckgl-map-wrapper');
    if (wrapper) {
      wrapper.appendChild(flashMarker);
      setTimeout(() => flashMarker.remove(), durationMs);
    }
  }

  // --- Country click + highlight ---

  private shouldSuppressCountryClickAfterDrag(): boolean {
    return shouldSuppressCountryClick(this.countryClickGesture);
  }

  public setOnCountryClick(cb: (country: CountryClickPayload) => void): void {
    this.onCountryClick = cb;
  }

  public setOnMapContextMenu(cb: (payload: { lat: number; lon: number; screenX: number; screenY: number; countryCode?: string; countryName?: string }) => void): void {
    this.onMapContextMenu = cb;
  }

  private resolveCountryFromCoordinate(lon: number, lat: number): { code: string; name: string } | null {
    const fromGeometry = getCountryAtCoordinates(lat, lon);
    if (fromGeometry) return fromGeometry;
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return null;
    try {
      if (!this.maplibreMap.getLayer('country-interactive')) return null;
      const point = this.maplibreMap.project([lon, lat]);
      const features = this.maplibreMap.queryRenderedFeatures(point, { layers: ['country-interactive'] });
      const properties = (features?.[0]?.properties ?? {}) as Record<string, unknown>;
      const code = typeof properties['ISO3166-1-Alpha-2'] === 'string'
        ? canonicalizeCountryCode(properties['ISO3166-1-Alpha-2'])
        : '';
      const name = typeof properties.name === 'string'
        ? properties.name.trim()
        : '';
      if (!code || !name) return null;
      return { code, name };
    } catch {
      return null;
    }
  }

  private loadCountryBoundaries(): void {
    if (!this.maplibreMap || this.countryGeoJsonLoaded) return;
    this.countryGeoJsonLoaded = true;

    getCountriesGeoJson()
      .then((geojson) => {
        if (!this.maplibreMap || !geojson) return;
        if (this.maplibreMap.getSource('country-boundaries')) return;
        this.maplibreMap.addSource('country-boundaries', {
          type: 'geojson',
          data: geojson,
        });
        this.maplibreMap.addLayer({
          id: 'country-interactive',
          type: 'fill',
          source: 'country-boundaries',
          paint: {
            'fill-color': '#3b82f6',
            'fill-opacity': 0,
          },
        });
        if (!this.chrome) {
          this.maplibreMap.addLayer({
            id: 'country-embed-outline',
            type: 'line',
            source: 'country-boundaries',
            paint: {
              'line-color': getCurrentTheme() === 'light' ? '#334155' : '#94a3b8',
              'line-width': 0.8,
              'line-opacity': getCurrentTheme() === 'light' ? 0.26 : 0.32,
            },
          });
        }
        this.maplibreMap.addLayer({
          id: 'country-hover-fill',
          type: 'fill',
          source: 'country-boundaries',
          paint: {
            'fill-color': '#ffffff',
            'fill-opacity': 0.05,
          },
          filter: ['==', ['get', 'ISO3166-1-Alpha-2'], ''],
        });
        this.maplibreMap.addLayer({
          id: 'country-hover-border',
          type: 'line',
          source: 'country-boundaries',
          paint: {
            'line-color': '#ffffff',
            'line-width': 1.5,
            'line-opacity': 0.22,
          },
          filter: ['==', ['get', 'ISO3166-1-Alpha-2'], ''],
        });
        this.maplibreMap.addLayer({
          id: 'country-highlight-fill',
          type: 'fill',
          source: 'country-boundaries',
          paint: {
            'fill-color': '#3b82f6',
            'fill-opacity': 0.12,
          },
          filter: ['==', ['get', 'ISO3166-1-Alpha-2'], ''],
        });
        this.maplibreMap.addLayer({
          id: 'country-highlight-border',
          type: 'line',
          source: 'country-boundaries',
          paint: {
            'line-color': '#3b82f6',
            'line-width': 1.5,
            'line-opacity': 0.5,
          },
          filter: ['==', ['get', 'ISO3166-1-Alpha-2'], ''],
        });

        if (!this.countryHoverSetup) this.setupCountryHover();
        const paintProvider = getMapProvider();
        const paintMapTheme = getMapTheme(paintProvider);
        this.updateCountryLayerPaint(isLightMapTheme(paintMapTheme) ? 'light' : 'dark');
        if (this.highlightedCountryCode) this.highlightCountry(this.highlightedCountryCode);
        this.render();
      })
      .catch((err) => console.warn('[DeckGLMap] Failed to load country boundaries:', err));
  }

  private setupCountryHover(): void {
    if (!this.maplibreMap || this.countryHoverSetup) return;
    this.countryHoverSetup = true;
    const map = this.maplibreMap;
    let hoveredIso2: string | null = null;

    const clearHover = () => {
      this.hoveredCountryIso2 = null;
      this.hoveredCountryName = null;
      map.getCanvas().style.cursor = '';
      if (!map.getLayer('country-hover-fill')) return;
      const noMatch = ['==', ['get', 'ISO3166-1-Alpha-2'], ''] as maplibregl.FilterSpecification;
      map.setFilter('country-hover-fill', noMatch);
      map.setFilter('country-hover-border', noMatch);
    };

    // rAF-throttle the per-mousemove feature query (#5042 U3). The canvas is the
    // dominant input-delay surface and queryRenderedFeatures is synchronous, so
    // coalesce to at most one query per frame; the latest pointer position wins.
    const runHoverQuery = (point: maplibregl.Point) => {
      if (!this.onCountryClick) return;
      try {
        if (!map.getLayer('country-interactive')) return;
        const features = map.queryRenderedFeatures(point, { layers: ['country-interactive'] });
        const props = features?.[0]?.properties;
        const rawIso2 = props?.['ISO3166-1-Alpha-2'] as string | undefined;
        // Keep MapLibre filters on the feature's property value (rewritten to
        // ISO2 on geometry load) while storing the canonical code for clicks.
        const iso2 = typeof rawIso2 === 'string' ? canonicalizeCountryCode(rawIso2) : undefined;
        const name = props?.['name'] as string | undefined;

        if (iso2 && iso2 !== hoveredIso2) {
          hoveredIso2 = iso2;
          this.hoveredCountryIso2 = iso2;
          this.hoveredCountryName = name ?? null;
          const filter = ['==', ['get', 'ISO3166-1-Alpha-2'], iso2] as maplibregl.FilterSpecification;
          map.setFilter('country-hover-fill', filter);
          map.setFilter('country-hover-border', filter);
          map.getCanvas().style.cursor = 'pointer';
        } else if (!iso2 && hoveredIso2) {
          hoveredIso2 = null;
          clearHover();
        }
      } catch { /* style not done loading during theme switch */ }
    };
    const hoverQueryThrottle = createCountryHoverQueryController<maplibregl.Point>(
      rafSchedule,
      runHoverQuery,
    );
    this.hoverQueryThrottle = hoverQueryThrottle;

    map.on('mousemove', (e) => {
      if (!this.onCountryClick) {
        hoverQueryThrottle.cancel();
        return;
      }
      hoverQueryThrottle.queue(e.point);
    });

    map.on('mouseout', () => {
      // Cancel a queued query so a deferred rAF cannot re-highlight a country the
      // pointer has already left (R8); clearHover stays immediate.
      hoverQueryThrottle.cancel();
      if (hoveredIso2) {
        hoveredIso2 = null;
        try { clearHover(); } catch { /* style not done loading */ }
      }
    });
  }

  private countryPulseRaf: number | null = null;
  private hoverQueryThrottle: CountryHoverQueryController<maplibregl.Point> | null = null;

  private getHighlightRestOpacity(): { fill: number; border: number } {
    const theme = isLightMapTheme(getMapTheme(getMapProvider())) ? 'light' : 'dark';
    return { fill: theme === 'light' ? 0.18 : 0.12, border: 0.5 };
  }

  public highlightCountry(code: string): void {
    this.highlightedCountryCode = canonicalizeCountryCode(code);
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return;
    try {
      if (!this.maplibreMap.getLayer('country-highlight-fill')) return;
      const filter = ['==', ['get', 'ISO3166-1-Alpha-2'], this.highlightedCountryCode] as maplibregl.FilterSpecification;
      this.maplibreMap.setFilter('country-highlight-fill', filter);
      this.maplibreMap.setFilter('country-highlight-border', filter);
      this.pulseCountryHighlight();
    } catch { /* style not yet loaded */ }
  }

  public clearCountryHighlight(): void {
    this.highlightedCountryCode = null;
    if (this.countryPulseRaf) { cancelAnimationFrame(this.countryPulseRaf); this.countryPulseRaf = null; }
    if (!this.maplibreMap) return;
    try {
      if (!this.maplibreMap.getLayer('country-highlight-fill')) return;
      const rest = this.getHighlightRestOpacity();
      const noMatch = ['==', ['get', 'ISO3166-1-Alpha-2'], ''] as maplibregl.FilterSpecification;
      this.maplibreMap.setFilter('country-highlight-fill', noMatch);
      this.maplibreMap.setFilter('country-highlight-border', noMatch);
      this.maplibreMap.setPaintProperty('country-highlight-fill', 'fill-opacity', rest.fill);
      this.maplibreMap.setPaintProperty('country-highlight-border', 'line-opacity', rest.border);
    } catch { /* style unloaded or map torn down between panel close and highlight clear */ }
  }

  private pulseCountryHighlight(): void {
    if (this.countryPulseRaf) { cancelAnimationFrame(this.countryPulseRaf); this.countryPulseRaf = null; }
    const map = this.maplibreMap;
    if (!map) return;
    const rest = this.getHighlightRestOpacity();
    const start = performance.now();
    const duration = 3000;
    const step = (now: number) => {
      try {
        if (!map.getLayer('country-highlight-fill')) { this.countryPulseRaf = null; return; }
      } catch { this.countryPulseRaf = null; return; }
      const t = (now - start) / duration;
      if (t >= 1) {
        this.countryPulseRaf = null;
        map.setPaintProperty('country-highlight-fill', 'fill-opacity', rest.fill);
        map.setPaintProperty('country-highlight-border', 'line-opacity', rest.border);
        return;
      }
      const pulse = Math.sin(t * Math.PI * 3) ** 2;
      const fade = 1 - t * t;
      const fillOp = rest.fill + 0.25 * pulse * fade;
      const borderOp = rest.border + 0.5 * pulse * fade;
      map.setPaintProperty('country-highlight-fill', 'fill-opacity', fillOp);
      map.setPaintProperty('country-highlight-border', 'line-opacity', borderOp);
      this.countryPulseRaf = requestAnimationFrame(step);
    };
    this.countryPulseRaf = requestAnimationFrame(step);
  }

  private async switchBasemap(): Promise<void> {
    const map = this.maplibreMap;
    if (!map) return;
    const seq = ++this.basemapSwitchSeq;
    const provider = getMapProvider();
    const mapTheme = getMapTheme(provider);
    const style = (this.usedFallbackStyle && provider === 'auto')
      ? (isLightMapTheme(mapTheme) ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE)
      : await getStyleForProvider(provider, mapTheme);
    if (this.maplibreMap !== map || seq !== this.basemapSwitchSeq) return;
    if (this.countryPulseRaf) { cancelAnimationFrame(this.countryPulseRaf); this.countryPulseRaf = null; }
    this.countryGeoJsonLoaded = false;
    map.setStyle(style, { diff: false });
    map.once('style.load', () => {
      localizeMapLabels(this.maplibreMap);
      this.loadCountryBoundaries();
      if (this.radarActive) this.applyRadarLayer();
      const paintTheme = isLightMapTheme(mapTheme) ? 'light' as const : 'dark' as const;
      this.updateCountryLayerPaint(paintTheme);
      this.render();
    });
    if (provider !== 'openfreemap' && !this.usedFallbackStyle) {
      this.monitorTileLoading(mapTheme);
    }
  }

  private monitorTileLoading(mapTheme: string): void {
    if (!this.maplibreMap) return;
    const gen = ++this.tileMonitorGeneration;
    let ok = false;
    let errCount = 0;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const map = this.maplibreMap;

    const cleanup = () => {
      map.off('error', onError);
      map.off('data', onData);
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
    };

    const onError = (e: { error?: { message?: string }; message?: string }) => {
      if (gen !== this.tileMonitorGeneration) { cleanup(); return; }
      const msg = e.error?.message ?? e.message ?? '';
      if (msg.includes('Failed to fetch') || msg.includes('AJAXError') || msg.includes('CORS') || msg.includes('NetworkError') || msg.includes('403') || msg.includes('Forbidden')) {
        errCount++;
        if (!ok && errCount >= 2) {
          cleanup();
          this.switchToFallbackStyle(mapTheme);
        }
      }
    };

    const onData = (e: { dataType?: string }) => {
      if (gen !== this.tileMonitorGeneration) { cleanup(); return; }
      if (e.dataType === 'source') { ok = true; cleanup(); }
    };

    map.on('error', onError);
    map.on('data', onData);

    timeoutId = setTimeout(() => {
      timeoutId = null;
      if (gen !== this.tileMonitorGeneration) return;
      cleanup();
      if (!ok) this.switchToFallbackStyle(mapTheme);
    }, 10000);
  }

  private switchToFallbackStyle(mapTheme: string): void {
    if (this.usedFallbackStyle || !this.maplibreMap) return;
    this.usedFallbackStyle = true;
    const fallback = isLightMapTheme(mapTheme) ? FALLBACK_LIGHT_STYLE : FALLBACK_DARK_STYLE;
    console.warn(`[DeckGLMap] Basemap tiles failed, falling back to OpenFreeMap: ${fallback}`);
    if (this.countryPulseRaf) { cancelAnimationFrame(this.countryPulseRaf); this.countryPulseRaf = null; }
    this.countryGeoJsonLoaded = false;
    this.maplibreMap.setStyle(fallback, { diff: false });
    this.maplibreMap.once('style.load', () => {
      localizeMapLabels(this.maplibreMap);
      this.loadCountryBoundaries();
      if (this.radarActive) this.applyRadarLayer();
      const paintTheme = isLightMapTheme(mapTheme) ? 'light' as const : 'dark' as const;
      this.updateCountryLayerPaint(paintTheme);
      this.render();
    });
  }

  public reloadBasemap(): void {
    this.basemapSwitchSeq++;
    if (!this.maplibreMap) return;
    this.usedFallbackStyle = false;
    void this.switchBasemap();
  }

  private updateCountryLayerPaint(theme: 'dark' | 'light'): void {
    if (!this.maplibreMap || !this.countryGeoJsonLoaded) return;
    if (!this.maplibreMap.style || !this.maplibreMap.getLayer('country-hover-fill')) return;
    const hoverFillOpacity   = theme === 'light' ? 0.08 : 0.05;
    const hoverBorderOpacity = theme === 'light' ? 0.35 : 0.22;
    const highlightOpacity   = theme === 'light' ? 0.18 : 0.12;
    this.maplibreMap.setPaintProperty('country-hover-fill',   'fill-opacity', hoverFillOpacity);
    this.maplibreMap.setPaintProperty('country-hover-border', 'line-opacity', hoverBorderOpacity);
    this.maplibreMap.setPaintProperty('country-highlight-fill', 'fill-opacity', highlightOpacity);
    if (this.maplibreMap.getLayer('country-embed-outline')) {
      this.maplibreMap.setPaintProperty('country-embed-outline', 'line-color', theme === 'light' ? '#334155' : '#94a3b8');
      this.maplibreMap.setPaintProperty('country-embed-outline', 'line-opacity', theme === 'light' ? 0.26 : 0.32);
    }
  }

  public destroy(): void {
    this.destroyed = true;
    this.settleViewportMovement(false);
    this._unsubscribeAuthState?.();
    this._unsubscribeAuthState = null;
    this._unsubscribeEntitlement?.();
    this._unsubscribeEntitlement = null;
    window.removeEventListener('theme-changed', this.handleThemeChange);
    window.removeEventListener('map-theme-changed', this.handleMapThemeChange);
    this.debouncedRebuildLayers.cancel();
    this.rafUpdateLayers.cancel();
    this.hoverQueryThrottle?.cancel();

    if (this.renderRafId !== null) {
      cancelAnimationFrame(this.renderRafId);
      this.renderRafId = null;
    }

    if (this.countryPulseRaf !== null) {
      cancelAnimationFrame(this.countryPulseRaf);
      this.countryPulseRaf = null;
    }

    if (this.moveTimeoutId) {
      clearTimeout(this.moveTimeoutId);
      this.moveTimeoutId = null;
    }

    if (this.styleLoadTimeoutId) {
      clearTimeout(this.styleLoadTimeoutId);
      this.styleLoadTimeoutId = null;
    }
    this.stopPulseAnimation();
    this.stopDayNightTimer();
    this.stopWeatherRadar();

    this.layerCache.clear();
    this.activeNuclearFacilities = null;
    this.activeDatacenters = null;

    this.deckOverlay?.finalize();
    this.deckOverlay = null;
    this.detachMapLibreInteractionHandlers();
    this.maplibreMap?.remove();
    this.maplibreMap = null;
    setTrustedHtml(this.container, trustedHtml('', "legacy direct innerHTML migration"));
  }
}
