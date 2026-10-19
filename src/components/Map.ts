import * as d3 from 'd3';
import * as topojson from 'topojson-client';
import { escapeHtml } from '@/utils/sanitize';
import { getCSSColor } from '@/utils';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { Feature, Geometry } from 'geojson';
import type { MapLayers, NewsLocationMarker, InternetOutage, RelatedAsset, AssetType, CableAdvisory, RepairShip, NaturalEvent, CableHealthRecord } from '@/types';
import type { Earthquake } from '@/services/earthquakes';
import { getNaturalEventIcon } from '@/services/eonet';
import type { WeatherAlert } from '@/services/weather';
import type { RadiationObservation } from '@/services/radiation';
import { getSeverityColor } from '@/services/weather';
import { getThreatColor } from '@/services/threat-classifier';
import { startSmartPollLoop, type SmartPollLoopHandle } from '@/services/smart-poll-loop';
import { scheduleAfterFirstPaint, yieldToMain } from '@/utils/after-paint';
import { measure, mutate } from '@/utils/layout-batch';
import {
  GAMMA_IRRADIATORS,
  PIPELINES,
  PIPELINE_COLORS,
  SITE_VARIANT,
} from '@/config';
// ai-datacenters + geo-map tables imported directly so their chunks stay
// off the eager @/config barrel and load only with this lazy renderer (#4404).
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { worldTopologyUrl, UNDERSEA_CABLES, NUCLEAR_FACILITIES } from '@/config/geo-map';
import { US_NUCLEAR_FACILITIES } from '@/config/us-nuclear-facilities';
import { pinWebcam, isPinned } from '@/services/webcams/pinned-store';
import type { WebcamEntry, WebcamCluster } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import { MapPopup } from './MapPopup';
import { getCountryAtCoordinates, getCountryBbox } from '@/services/country-geometry';
import type { CountryClickPayload } from './DeckGLMap';
import { t } from '@/services/i18n';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { renderLayerTruncationBadges } from '@/utils/layer-truncation-badge';
import {
  overlayMarkerPosition,
  projectionPointAtScreenCentre,
} from '@/utils/overlay-marker-geometry';
import {
  MAP_OVERLAY_MARKER_BUDGET_DESKTOP,
  MAP_OVERLAY_MARKER_BUDGET_MOBILE,
  proximityRank,
  selectGlobeMarkers,
  type GlobeLayerTruncation,
  type GlobeMarkerGroup,
  type LatLng,
} from '@/utils/globe-marker-budget';
import {
  getLayerExplanation,
  hasCuratedLayerExplanation,
  isLayerExecutable,
  LAYER_REGISTRY,
  resolveLayerLabel,
} from '@/config/map-layer-definitions';
import { renderLayerExplanationCard } from '@/utils/layer-explanation-card';
import {
  createCountryClickGestureTracker,
  finishCountryClickGesture,
  shouldSuppressCountryClick,
  startCountryClickGesture,
  updateCountryClickGestureDrag,
} from './map-interaction-guard';
import { resolveClusterGlContext } from './map-cluster-gl';


export type TimeRange = '1h' | '6h' | '24h' | '48h' | '7d' | 'all';
export type MapView = 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

export interface MapState {
  zoom: number;
  pan: { x: number; y: number };
  view: MapView;
  layers: MapLayers;
  timeRange: TimeRange;
}

export interface MapComponentOptions {
  chrome?: boolean;
  isMobile?: boolean;
  /** App-owned entitlement guard; omitted for the public embed renderer. */
  canToggleLayer?: (layer: keyof MapLayers, currentlyEnabled: boolean | undefined) => boolean;
}

interface WorldTopology extends Topology {
  objects: {
    countries: GeometryCollection;
  };
}

/**
 * The AI data centres the SVG overlay actually draws (>=10k GPUs). Hoisted to
 * module scope so the overlay marker budget (#7112) plans on exactly the list
 * the render loop iterates, rather than on a superset that would spend fair
 * share on markers that were never going to appear.
 */
const MIN_AI_DATA_CENTER_GPU_COUNT = 10000;
const RENDERABLE_AI_DATA_CENTERS = AI_DATA_CENTERS.filter(
  (dc) => (dc.chipCount || 0) >= MIN_AI_DATA_CENTER_GPU_COUNT,
);

export class MapComponent {
  private static readonly MOBILE_MIN_EARTHQUAKE_MAGNITUDE = 5;
  // #4669: how long markers pulse after a render before settling to static.
  // Infinite opacity pulses hold a permanent compositing layer per marker
  // (385 of 517 desktop layers; Layerize ~34% of the main thread scales with
  // the count), so after the attention window the pulses are switched off via
  // the .markers-settled class. Any overlay re-render re-arms the window.
  private static readonly MARKER_SETTLE_MS = 6000;
  // #7112: how long the view must be still before the overlay marker budget is
  // re-planned for the new centre. Longer than a frame so a drag or an inertia
  // fling coalesces into ONE rebuild; short enough that the badge's "pan or zoom
  // to bring others in" is true promptly once the user stops.
  private static readonly OVERLAY_BUDGET_REPLAN_SETTLE_MS = 200;
  // #7112: ceiling on concurrent news flashes. They are `#mapOverlays` children
  // created outside the marker budget, so this is what keeps the overlay's total
  // node count bounded rather than "bounded plus however much news arrived".
  private static readonly MAX_CONCURRENT_MAP_FLASHES = 12;
  private static readonly LAYER_ZOOM_THRESHOLDS: Partial<
    Record<keyof MapLayers, { minZoom: number; showLabels?: number }>
  > = {
      nuclear: { minZoom: 2 },
      natural: { minZoom: 1, showLabels: 2 },
    };

  private static readonly SVG_MARKER_DOM_ZOOM_LAYERS = new Set<keyof MapLayers>(['nuclear']);

  private container: HTMLElement;
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private wrapper: HTMLElement;
  private overlays: HTMLElement;
  private markerSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private clusterCanvas: HTMLCanvasElement;
  private clusterGl: WebGLRenderingContext | null = null;
  private state: MapState;
  private layerExplanationOutsideClickHandler: ((event: MouseEvent) => void) | null = null;
  private worldData: WorldTopology | null = null;
  private countryFeatures: Feature<Geometry>[] | null = null;
  private isResizing = false;
  private baseLayerGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  private dynamicLayerGroup: d3.Selection<SVGGElement, unknown, null, undefined> | null = null;
  private baseRendered = false;
  private baseWidth = 0;
  private baseHeight = 0;
  private earthquakes: Earthquake[] = [];
  private newsLocations: NewsLocationMarker[] = [];
  private weatherAlerts: WeatherAlert[] = [];
  private radiationObservations: RadiationObservation[] = [];
  private outages: InternetOutage[] = [];
  private cableAdvisories: CableAdvisory[] = [];
  private repairShips: RepairShip[] = [];
  private healthByCableId: Record<string, CableHealthRecord> = {};
  private naturalEvents: NaturalEvent[] = [];
  private firmsFireData: Array<{ lat: number; lon: number; brightness: number; frp: number; confidence: number; region: string; acq_date: string; daynight: string }> = [];
  private webcamData: Array<WebcamEntry | WebcamCluster> = [];
  private popup: MapPopup;
  private onNewsClick?: (item: Pick<NewsLocationMarker, 'article' | 'title'>) => void;
  private onTimeRangeChange?: (range: TimeRange) => void;
  private onLayerChange?: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void;
  private layerZoomOverrides: Partial<Record<keyof MapLayers, boolean>> = {};
  private onStateChange?: (state: MapState) => void;
  private onCountryClick?: (country: CountryClickPayload) => void;
  private highlightedAssets: Record<AssetType, Set<string>> = {
    pipeline: new Set(),
    cable: new Set(),
    datacenter: new Set(),
    nuclear: new Set(),
  };
  private boundVisibilityHandler!: () => void;
  private handleThemeChange: () => void;
  private resizeObserver: ResizeObserver | null = null;
  private renderScheduled = false;
  private lastRenderTime = 0;
  private readonly MIN_RENDER_INTERVAL_MS = 100;
  private healthCheckLoop: SmartPollLoopHandle | null = null;
  // First render paints the base map (countries) synchronously for LCP, then defers the
  // heavy dynamic-overlay pass off the first-paint critical path (#4429). Mobile uses this
  // SVG renderer and its synchronous overlay build was the #1 boot-scripting cost (~1.3s).
  private initialDynamicRendered = false;
  private initialDynamicScheduled = false;
  // Bumped on every dynamic-layer build; lets the chunked first-paint pass bail mid-yield
  // when a newer (synchronous) render has superseded it (#4442 re-entrancy guard).
  private dynamicRenderToken = 0;
  // Set in destroy(); guards render() (incl. the deferred first-paint callback and the
  // resize/visibility rAF callbacks) from running on a torn-down instance.
  private destroyed = false;
  // Mobile loads the lighter 110m country topology (U6); passed in from MapContainer.
  private readonly isMobile: boolean;
  private readonly canToggleLayer: NonNullable<MapComponentOptions['canToggleLayer']>;
  private overlayAppendTarget: ParentNode | null = null;
  // #7112 overlay marker budget. `overlayMarkerCut` holds the marker objects
  // this render pass withheld; it is consulted by identity, so a feed that is
  // NOT in the plan simply never appears here and renders in full. That makes a
  // plan/render mismatch fail safe (an unbudgeted layer, not a blank one).
  private overlayMarkerCut: Set<unknown> = new Set();
  // Pending settle-debounced budget re-plan; see scheduleOverlayBudgetReplan().
  private overlayBudgetReplanTimer: ReturnType<typeof setTimeout> | null = null;
  // Live news-flash nodes -> their expiry timer, insertion-ordered so the oldest
  // can be evicted when MAX_CONCURRENT_MAP_FLASHES is reached. Also lets destroy()
  // clear timers that would otherwise fire against a torn-down instance.
  private readonly activeFlashes = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  private overlayMarkerTruncation: Record<string, GlobeLayerTruncation> = {};
  // Truncated layer keys with no toggle row to disclose them on; see
  // updateLayerTruncationLabels().
  private overlayUndisclosedTruncation: string[] = [];
  private renderedOverlayMarkerCount = 0;
  // #7112: how many times renderOverlays() has rebuilt the overlay, surfaced
  // through getOverlayMarkerBudgetState() so a test can assert that a view
  // another render already re-planned is not rebuilt again.
  private overlayRenderCount = 0;
  private lastTruncationLabelKey = '';
  private labelVisibilityScheduled = false;
  private pendingLabelVisibilityZoom = 1;
  private lastContainerSize = { width: 0, height: 0 };
  // #5080 slice 2: last zoom (4dp) whose overlay counter-scale CSS vars were
  // written — lets applyTransform() skip same-value setProperty calls that
  // would restyle every marker on every render pass.
  private lastOverlayVarZoom = '';
  // The overlay budget is planned for the transformed viewport. Keep the last
  // planned transform so pan/zoom can request one coalesced rebuild instead of
  // leaving the previous view's nearest markers on screen.
  private lastOverlayBudgetViewport = {
    width: Number.NaN,
    height: Number.NaN,
    zoom: Number.NaN,
    panX: Number.NaN,
    panY: Number.NaN,
  };
  // Desktop measures label overlap from the start; mobile defers until the first
  // interaction. The effective value is set in the constructor (= !this.isMobile);
  // false here documents the mobile-off default.
  private mobileLabelVisibilityArmed = false;
  // All container/document interaction listeners are registered with this signal so
  // destroy() can remove them in one shot. The container node is reused across
  // renderer switches (MapContainer keeps one element and rebuilds MapComponent on it),
  // so listeners left attached would retain every destroyed instance forever.
  private readonly listenerAbort = new AbortController();

  constructor(container: HTMLElement, initialState: MapState, options: MapComponentOptions = {}) {
    this.container = container;
    this.state = initialState;
    const chrome = options.chrome ?? true;
    this.isMobile = options.isMobile ?? false;
    this.canToggleLayer = options.canToggleLayer ?? (() => true);
    this.mobileLabelVisibilityArmed = !this.isMobile;

    this.wrapper = document.createElement('div');
    this.wrapper.className = 'map-wrapper';
    this.wrapper.id = 'mapWrapper';

    const svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svgElement.classList.add('map-svg');
    svgElement.id = 'mapSvg';
    this.wrapper.appendChild(svgElement);

    this.clusterCanvas = document.createElement('canvas');
    this.clusterCanvas.className = 'map-cluster-canvas';
    this.clusterCanvas.id = 'mapClusterCanvas';
    this.wrapper.appendChild(this.clusterCanvas);

    // Overlays inside wrapper so they transform together on zoom/pan
    this.overlays = document.createElement('div');
    this.overlays.id = 'mapOverlays';
    this.wrapper.appendChild(this.overlays);

    container.appendChild(this.wrapper);
    if (chrome) {
      container.appendChild(this.createControls());
      container.appendChild(this.createTimeSlider());
      container.appendChild(this.createLayerToggles());
      container.appendChild(this.createLegend());
      this.healthCheckLoop = startSmartPollLoop(() => { this.runHealthCheck(); }, {
        intervalMs: 30_000,
        pauseWhenHidden: true,
        refreshOnVisible: false,
        runImmediately: false,
        jitterFraction: 0,
      });
    }

    this.svg = d3.select(svgElement);
    this.baseLayerGroup = this.svg.append('g').attr('class', 'map-base');
    this.dynamicLayerGroup = this.svg.append('g').attr('class', 'map-dynamic');
    this.popup = new MapPopup(container);
    this.initClusterRenderer();

    this.setupZoomHandlers();
    this.loadMapData();
    this.setupResizeObserver();

    this.handleThemeChange = () => {
      this.baseRendered = false;
      this.render();
    };
    window.addEventListener('theme-changed', this.handleThemeChange);

  }

  private setupResizeObserver(): void {
    let lastWidth = 0;
    let lastHeight = 0;
    this.resizeObserver = new ResizeObserver((entries) => {
      if (this.isResizing) return;
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width === lastWidth && height === lastHeight) continue;
        lastWidth = width;
        lastHeight = height;
        // Record zero-size (hidden) transitions too, not just visible sizes.
        // getKnownContainerSize() falls back to a live read whenever the cache
        // is zero, so recording the hide keeps render()'s zero-size skip intact
        // and lets a reveal center off current dimensions instead of the last
        // visible ones (#5022 review). Only a visible size is worth rendering.
        this.rememberContainerSize({ width, height });
        if (width > 0 && height > 0) this.scheduleRender();
      }
    });
    this.resizeObserver.observe(this.container);

    // Re-render when page becomes visible again (after browser throttling)
    this.boundVisibilityHandler = () => {
      if (!document.hidden) {
        this.scheduleRender();
      }
    };
    document.addEventListener('visibilitychange', this.boundVisibilityHandler);
  }

  public setIsResizing(value: boolean): void {
    const wasResizing = this.isResizing;
    this.isResizing = value;
    if (wasResizing && !value) {
      this.scheduleRender();
    }
  }

  public resize(): void {
    this.scheduleRender();
  }

  public destroy(): void {
    this.destroyed = true;
    this.listenerAbort.abort();
    if (this.markerSettleTimer !== null) {
      clearTimeout(this.markerSettleTimer);
      this.markerSettleTimer = null;
    }
    if (this.overlayBudgetReplanTimer !== null) {
      clearTimeout(this.overlayBudgetReplanTimer);
      this.overlayBudgetReplanTimer = null;
    }
    for (const [flash, timer] of this.activeFlashes) {
      clearTimeout(timer);
      flash.remove();
    }
    this.activeFlashes.clear();
    window.removeEventListener('theme-changed', this.handleThemeChange);
    document.removeEventListener('visibilitychange', this.boundVisibilityHandler);
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.healthCheckLoop) {
      this.healthCheckLoop.stop();
      this.healthCheckLoop = null;
    }
  }

  private createControls(): HTMLElement {
    const controls = document.createElement('div');
    controls.className = 'map-controls';
    setTrustedHtml(controls, trustedHtml(`
      <button class="map-control-btn" data-action="zoom-in" aria-label="Zoom in">+</button>
      <button class="map-control-btn" data-action="zoom-out" aria-label="Zoom out">−</button>
      <button class="map-control-btn" data-action="reset" aria-label="Reset rotation">⟲</button>
    `, "legacy direct innerHTML migration"));

    controls.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.dataset.action;
      if (action === 'zoom-in') this.zoomIn();
      else if (action === 'zoom-out') this.zoomOut();
      else if (action === 'reset') this.reset();
    });

    return controls;
  }

  private createTimeSlider(): HTMLElement {
    const slider = document.createElement('div');
    slider.className = 'time-slider';
    slider.id = 'timeSlider';

    const ranges: { value: TimeRange; label: string }[] = [
      { value: '1h', label: '1H' },
      { value: '6h', label: '6H' },
      { value: '24h', label: '24H' },
      { value: '48h', label: '48H' },
      { value: '7d', label: '7D' },
      { value: 'all', label: 'ALL' },
    ];

    setTrustedHtml(slider, trustedHtml(`
      <span class="time-slider-label">TIME RANGE</span>
      <div class="time-slider-buttons">
        ${ranges
        .map(
          (r) =>
            `<button class="time-btn ${this.state.timeRange === r.value ? 'active' : ''}" data-range="${r.value}">${r.label}</button>`
        )
        .join('')}
      </div>
    `, "legacy direct innerHTML migration"));

    slider.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains('time-btn')) {
        const range = target.dataset.range as TimeRange;
        this.setTimeRange(range);
        slider.querySelectorAll('.time-btn').forEach((btn) => btn.classList.remove('active'));
        target.classList.add('active');
      }
    });

    return slider;
  }

  private updateTimeSliderButtons(): void {
    const slider = this.container.querySelector('#timeSlider');
    if (!slider) return;
    slider.querySelectorAll('.time-btn').forEach((btn) => {
      const range = (btn as HTMLElement).dataset.range as TimeRange | undefined;
      btn.classList.toggle('active', range === this.state.timeRange);
    });
  }

  public setTimeRange(range: TimeRange): void {
    this.state.timeRange = range;
    this.onTimeRangeChange?.(range);
    this.updateTimeSliderButtons();
    this.render();
  }

  private getTimeRangeMs(): number {
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'all': Infinity,
    };
    return ranges[this.state.timeRange];
  }



  private getLayerControlLabel(layer: keyof MapLayers): string {
    // Labels are renderer-independent, so resolve straight from the registry.
    const def = LAYER_REGISTRY[layer];
    return def ? resolveLayerLabel(def, t) : String(layer);
  }

  private createLayerToggles(): HTMLElement {
    const toggles = document.createElement('div');
    toggles.className = 'layer-toggles';
    toggles.id = 'layerToggles';

    // Variant-aware layer buttons
    const fullLayers: (keyof MapLayers)[] = [
      'nuclear', 'irradiators',                          // strategic
      'cables', 'pipelines', 'outages', 'datacenters',   // infrastructure
      'natural', 'weather', 'fires',                     // natural
    ];
    // Nuclear variant — SVG/mobile fallback. Facilities registry plus the
    // hazard layers this renderer can paint.
    const nuclearLayers: (keyof MapLayers)[] = [
      'usNuclearFacilities',                  // NucMonitor registry
      'radiationWatch',                       // EPA RadNet / Safecast watch
      'natural', 'weather', 'fires',          // all-hazards inputs
      'outages',                              // grid status
      'nuclear', 'irradiators',               // global strategic context
      'pipelines', 'cables', 'datacenters',   // infrastructure
    ];
    // Filter renderer-incompatible layers so the SVG/mobile picker cannot
    // expose a toggle whose layer has no SVG paint path.
    const layers = (SITE_VARIANT === 'nuclear' ? nuclearLayers
                 : fullLayers).filter((key) => isLayerExecutable(key, 'svg'));
    const MAX_SVG_LAYERS = 9;
    const enforceLayerLimit = () => {
      const allBtns = Array.from(toggles.querySelectorAll<HTMLButtonElement>('.layer-toggle'));
      const activeBtns = allBtns.filter(b => b.classList.contains('active'));
      if (activeBtns.length > MAX_SVG_LAYERS) {
        const excess = activeBtns.slice(MAX_SVG_LAYERS);
        for (const btn of excess) {
          btn.classList.remove('active');
          const layer = btn.dataset.layer as keyof MapLayers | undefined;
          if (layer) this.toggleLayer(layer);
        }
      }
      const activeCount = allBtns.filter(b => b.classList.contains('active')).length;
      allBtns.forEach(b => {
        if (!b.classList.contains('active')) {
          b.disabled = activeCount >= MAX_SVG_LAYERS;
          b.classList.toggle('limit-reached', activeCount >= MAX_SVG_LAYERS);
        } else {
          b.disabled = false;
          b.classList.remove('limit-reached');
        }
      });
    };

    layers.forEach((layer) => {
      const layerLabel = this.getLayerControlLabel(layer);
      const explainLabel = `Explain ${layerLabel} layer`;
      const row = document.createElement('div');
      row.className = 'layer-toggle-row';
      row.dataset.layer = layer;

      const btn = document.createElement('button');
      btn.className = `layer-toggle ${this.state.layers[layer] ? 'active' : ''}`;
      btn.dataset.layer = layer;
      btn.textContent = layerLabel;
      btn.addEventListener('click', () => {
        this.toggleLayer(layer);
        enforceLayerLimit();
      });
      row.appendChild(btn);

      const explainBtn = document.createElement('button');
      explainBtn.type = 'button';
      explainBtn.className = `layer-explain-btn ${hasCuratedLayerExplanation(layer) ? 'has-layer-explanation' : ''}`;
      explainBtn.dataset.layer = layer;
      explainBtn.textContent = 'i';
      explainBtn.title = explainLabel;
      explainBtn.setAttribute('aria-label', explainLabel);
      explainBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.showLayerExplanation(layer);
      });
      row.appendChild(explainBtn);

      toggles.appendChild(row);
    });

    // Add help button
    const helpBtn = document.createElement('button');
    helpBtn.className = 'layer-help-btn';
    helpBtn.textContent = '?';
    helpBtn.title = t('components.deckgl.layerGuide');
    helpBtn.setAttribute('aria-label', t('components.deckgl.layerGuide'));
    helpBtn.addEventListener('click', () => this.showLayerHelp());
    toggles.appendChild(helpBtn);
    enforceLayerLimit();

    return toggles;
  }

  private clearLayerExplanationOutsideClickHandler(): void {
    if (!this.layerExplanationOutsideClickHandler) return;
    document.removeEventListener('click', this.layerExplanationOutsideClickHandler);
    this.layerExplanationOutsideClickHandler = null;
  }

  private showLayerExplanation(layer: keyof MapLayers): void {
    const existing = this.container.querySelector('.layer-explanation-popup') as HTMLElement | null;
    this.clearLayerExplanationOutsideClickHandler();
    if (existing?.dataset.layer === layer) {
      existing.remove();
      this.container.querySelector(`.layer-explain-btn[data-layer="${layer}"]`)?.classList.remove('active');
      return;
    }
    existing?.remove();
    this.container.querySelector('.layer-help-popup')?.remove();
    this.container.querySelectorAll('.layer-explain-btn.active').forEach(btn => btn.classList.remove('active'));

    const popup = document.createElement('div');
    popup.className = 'layer-explanation-popup';
    popup.dataset.layer = layer;
    setTrustedHtml(popup, trustedHtml(
      renderLayerExplanationCard(this.getLayerControlLabel(layer), getLayerExplanation(layer)),
      "static layer explanation metadata",
    ));

    const closePopup = (): void => {
      this.clearLayerExplanationOutsideClickHandler();
      popup.remove();
      this.container.querySelector(`.layer-explain-btn[data-layer="${layer}"]`)?.classList.remove('active');
    };

    popup.querySelector('.layer-explanation-close')?.addEventListener('click', closePopup);
    const content = popup.querySelector('.layer-explanation-content');
    content?.addEventListener('wheel', (e) => e.stopPropagation(), { passive: false });
    content?.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: false });

    setTimeout(() => {
      const closeHandler = (e: MouseEvent) => {
        if (!popup.contains(e.target as Node)) {
          closePopup();
        }
      };
      this.layerExplanationOutsideClickHandler = closeHandler;
      document.addEventListener('click', closeHandler);
    }, 100);

    this.container.appendChild(popup);
    this.container.querySelector(`.layer-explain-btn[data-layer="${layer}"]`)?.classList.add('active');
  }

  private showLayerHelp(): void {
    const existing = this.container.querySelector('.layer-help-popup');
    if (existing) {
      existing.remove();
      return;
    }
    this.container.querySelector('.layer-explanation-popup')?.remove();
    this.clearLayerExplanationOutsideClickHandler();
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
      helpItem(label('canadaRoads'), 'canadaRoads'),
      helpItem(label('canadaAlerts'), 'canadaAlerts'),
      helpItem(label('climateAnomalies'), 'climateAnomalies'),
    ])}
        ${helpSection('labels', [
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

  private syncLayerButtons(): void {
    this.container.querySelectorAll<HTMLButtonElement>('.layer-toggle').forEach((btn) => {
      const layer = btn.dataset.layer as keyof MapLayers | undefined;
      if (!layer) return;
      btn.classList.toggle('active', this.state.layers[layer]);
    });
  }

  private createLegend(): HTMLElement {
    const legend = document.createElement('div');
    legend.className = 'map-legend';

    setTrustedHtml(legend, trustedHtml(`
      <div class="map-legend-item"><span class="map-legend-icon earthquake">●</span>${escapeHtml(t('modals.search.types.earthquake').toUpperCase())}</div>
    `, "legacy direct innerHTML migration"));
    return legend;
  }

  private runHealthCheck(): void {
    const svgNode = this.svg.node();
    if (!svgNode) return;

    // Verify base layer exists and has content
    const baseGroup = svgNode.querySelector('.map-base');
    const countryCount = baseGroup?.querySelectorAll('.country').length ?? 0;

    // If we have country data but no rendered countries, something is wrong
    if (this.countryFeatures && this.countryFeatures.length > 0 && countryCount === 0) {
      console.warn('[Map] Health check: Base layer missing countries, initiating recovery');
      this.baseRendered = false;
      // Also check if d3 selection is stale
      if (baseGroup && this.baseLayerGroup?.node() !== baseGroup) {
        console.warn('[Map] Health check: Stale d3 selection detected');
      }
      this.render();
    }
  }

  private setupZoomHandlers(): void {
    const signal = this.listenerAbort.signal;
    let isDragging = false;
    let lastPos = { x: 0, y: 0 };
    let lastTouchDist = 0;
    let lastTouchCenter = { x: 0, y: 0 };
    const countryClickGesture = createCountryClickGestureTracker();
    const shouldIgnoreInteractionStart = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      return Boolean(
        target.closest(
          '.map-controls, .time-slider, .layer-toggles, .map-legend, .layer-help-popup, .map-popup, button, select, input, textarea, a'
        )
      );
    };

    // Wheel zoom with smooth delta
    this.container.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();

        // Check if this is a pinch gesture (ctrlKey is set for trackpad pinch)
        if (e.ctrlKey) {
          // Pinch-to-zoom on trackpad
          const zoomDelta = -e.deltaY * 0.01;
          this.state.zoom = Math.max(1, Math.min(10, this.state.zoom + zoomDelta));
        } else {
          // Two-finger scroll for pan, regular scroll for zoom
          if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 0.5 || e.shiftKey) {
            // Horizontal scroll or shift+scroll = pan
            const panSpeed = 2 / this.state.zoom;
            this.state.pan.x -= e.deltaX * panSpeed;
            this.state.pan.y -= e.deltaY * panSpeed;
          } else {
            // Vertical scroll = zoom
            const zoomDelta = e.deltaY > 0 ? -0.15 : 0.15;
            this.state.zoom = Math.max(1, Math.min(10, this.state.zoom + zoomDelta));
          }
        }
        this.applyTransform();
      },
      { passive: false, signal }
    );

    // Mouse drag for panning
    this.container.addEventListener('mousedown', (e) => {
      if (shouldIgnoreInteractionStart(e.target)) return;
      if (e.button === 0) { // Left click
        isDragging = true;
        lastPos = { x: e.clientX, y: e.clientY };
        startCountryClickGesture(countryClickGesture, { x: e.clientX, y: e.clientY });
        this.container.style.cursor = 'grabbing';
      }
    }, { signal });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const dx = e.clientX - lastPos.x;
      const dy = e.clientY - lastPos.y;
      updateCountryClickGestureDrag(countryClickGesture, { x: e.clientX, y: e.clientY });

      const panSpeed = 1 / this.state.zoom;
      this.state.pan.x += dx * panSpeed;
      this.state.pan.y += dy * panSpeed;

      lastPos = { x: e.clientX, y: e.clientY };
      this.applyTransform();
    }, { signal });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        finishCountryClickGesture(countryClickGesture);
        this.container.style.cursor = 'grab';
      }
    }, { signal });

    let touchStartPos = { x: 0, y: 0 };
    let touchDragActive = false;
    let lastDragEndTime = 0;
    const TOUCH_DRAG_THRESHOLD = 8;
    const touchHistory: Array<{ x: number; y: number; t: number }> = [];
    let inertiaRaf = 0;

    // Keep tap starts out of the label-collision pass; arm it only once the
    // gesture actually moves/zooms the viewport.
    this.container.addEventListener('touchstart', (e) => {
      if (shouldIgnoreInteractionStart(e.target)) return;
      cancelAnimationFrame(inertiaRaf);
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];

      if (e.touches.length === 2 && touch1 && touch2) {
        e.preventDefault();
        touchDragActive = false;
        lastTouchDist = Math.hypot(
          touch2.clientX - touch1.clientX,
          touch2.clientY - touch1.clientY
        );
        lastTouchCenter = {
          x: (touch1.clientX + touch2.clientX) / 2,
          y: (touch1.clientY + touch2.clientY) / 2,
        };
      } else if (e.touches.length === 1 && touch1) {
        isDragging = true;
        touchDragActive = false;
        touchStartPos = { x: touch1.clientX, y: touch1.clientY };
        lastPos = { x: touch1.clientX, y: touch1.clientY };
        touchHistory.length = 0;
        touchHistory.push({ x: touch1.clientX, y: touch1.clientY, t: performance.now() });
      }
    }, { passive: false, signal });

    this.container.addEventListener('touchmove', (e) => {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];

      if (e.touches.length === 2 && touch1 && touch2) {
        e.preventDefault();

        const dist = Math.hypot(
          touch2.clientX - touch1.clientX,
          touch2.clientY - touch1.clientY
        );
        const scale = dist / lastTouchDist;
        this.state.zoom = Math.max(1, Math.min(10, this.state.zoom * scale));
        lastTouchDist = dist;

        const center = {
          x: (touch1.clientX + touch2.clientX) / 2,
          y: (touch1.clientY + touch2.clientY) / 2,
        };
        const panSpeed = 1 / this.state.zoom;
        this.state.pan.x += (center.x - lastTouchCenter.x) * panSpeed;
        this.state.pan.y += (center.y - lastTouchCenter.y) * panSpeed;
        lastTouchCenter = center;

        this.resumeMobileLabelVisibility();
        this.applyTransform();
      } else if (e.touches.length === 1 && isDragging && touch1) {
        if (!touchDragActive) {
          const dx0 = touch1.clientX - touchStartPos.x;
          const dy0 = touch1.clientY - touchStartPos.y;
          if (Math.hypot(dx0, dy0) < TOUCH_DRAG_THRESHOLD) return;
          touchDragActive = true;
          this.resumeMobileLabelVisibility();
        }

        e.preventDefault();

        const dx = touch1.clientX - lastPos.x;
        const dy = touch1.clientY - lastPos.y;

        const panSpeed = 1 / this.state.zoom;
        this.state.pan.x += dx * panSpeed;
        this.state.pan.y += dy * panSpeed;

        lastPos = { x: touch1.clientX, y: touch1.clientY };
        const now = performance.now();
        touchHistory.push({ x: touch1.clientX, y: touch1.clientY, t: now });
        if (touchHistory.length > 4) touchHistory.shift();

        this.applyTransform();
      }
    }, { passive: false, signal });

    this.container.addEventListener('touchend', () => {
      if (touchDragActive && touchHistory.length >= 2) {
        const last = touchHistory[touchHistory.length - 1]!;
        const first = touchHistory[0]!;
        const dt = (last.t - first.t) / 1000;
        if (dt > 0 && dt < 0.3) {
          let vx = (last.x - first.x) / dt;
          let vy = (last.y - first.y) / dt;
          const panSpeed = 1 / this.state.zoom;
          const decay = 0.92;
          const animate = () => {
            vx *= decay;
            vy *= decay;
            if (Math.abs(vx) < 10 && Math.abs(vy) < 10) return;
            this.state.pan.x += (vx / 60) * panSpeed;
            this.state.pan.y += (vy / 60) * panSpeed;
            this.applyTransform();
            inertiaRaf = requestAnimationFrame(animate);
          };
          inertiaRaf = requestAnimationFrame(animate);
        }
      }
      isDragging = false;
      if (touchDragActive) lastDragEndTime = performance.now();
      touchDragActive = false;
      lastTouchDist = 0;
      touchHistory.length = 0;
    }, { signal });

    this.container.addEventListener('click', (e) => {
      if (!this.onCountryClick) return;
      if (performance.now() - lastDragEndTime < 300) return;
      if (shouldSuppressCountryClick(countryClickGesture)) return;
      const containerRect = this.container.getBoundingClientRect();
      const zoom = this.state.zoom;
      const width = this.container.clientWidth;
      const height = this.container.clientHeight;
      const centerOffsetX = (width / 2) * (1 - zoom);
      const centerOffsetY = (height / 2) * (1 - zoom);
      const tx = centerOffsetX + this.state.pan.x * zoom;
      const ty = centerOffsetY + this.state.pan.y * zoom;
      const rawX = (e.clientX - containerRect.left - tx) / zoom;
      const rawY = (e.clientY - containerRect.top - ty) / zoom;
      const projection = this.getProjection(width, height);
      if (!projection.invert) return;
      const coords = projection.invert([rawX, rawY]);
      if (!coords) return;
      const [lon, lat] = coords;
      const hit = getCountryAtCoordinates(lat, lon);
      if (hit) {
        this.onCountryClick({ lat, lon, code: hit.code, name: hit.name });
      }
    }, { signal });

    this.container.style.cursor = 'grab';
  }

  private async loadMapData(): Promise<void> {
    try {
      const worldResponse = await fetch(worldTopologyUrl(this.isMobile));
      this.worldData = await worldResponse.json();
      if (this.worldData) {
        const countries = topojson.feature(
          this.worldData,
          this.worldData.objects.countries
        );
        this.countryFeatures = 'features' in countries ? countries.features : [countries];
      }
      this.baseRendered = false;
      this.render();
      // Re-render after layout stabilizes to catch full container width.
      this.scheduleRender();
    } catch (e) {
      console.error('Failed to load map data:', e);
    }
  }

  private initClusterRenderer(): void {
    // WebGL clustering disabled - just get context for clearing canvas.
    // resolveClusterGlContext() rejects the truthy-but-method-less stub that
    // canvas fingerprint blockers return, which used to crash the whole
    // dynamic-layer render pass from clearClusterCanvas() (WORLDMONITOR-YG/YH).
    this.clusterGl = resolveClusterGlContext(this.clusterCanvas);
  }

  private clearClusterCanvas(): void {
    if (!this.clusterGl) return;
    this.clusterGl.clearColor(0, 0, 0, 0);
    this.clusterGl.clear(this.clusterGl.COLOR_BUFFER_BIT);
  }

  private renderClusterLayer(_projection: d3.GeoProjection): void {
    // WebGL clustering disabled - all layers use HTML markers for visual fidelity
    // (severity colors, emoji icons, magnitude sizing, animations)
    this.wrapper.classList.toggle('cluster-active', false);
    this.clearClusterCanvas();
  }

  public scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    measure(() => {
      const { width, height } = this.readContainerSize();
      const measuredAt = performance.now();
      mutate(() => {
        if (this.destroyed) {
          this.renderScheduled = false;
          return;
        }
        if (measuredAt - this.lastRenderTime < this.MIN_RENDER_INTERVAL_MS) {
          this.renderScheduled = false;
          this.scheduleRender();
          return;
        }
        this.lastRenderTime = measuredAt;
        this.renderScheduled = false;
        this.renderWithSize(width, height);
      });
    });
  }

  private rememberContainerSize(size: { width: number; height: number }): { width: number; height: number } {
    this.lastContainerSize = size;
    return size;
  }

  private readContainerSize(): { width: number; height: number } {
    return this.rememberContainerSize({
      width: this.container.clientWidth,
      height: this.container.clientHeight,
    });
  }

  private getKnownContainerSize(): { width: number; height: number } {
    return this.lastContainerSize.width > 0 && this.lastContainerSize.height > 0
      ? this.lastContainerSize
      : this.readContainerSize();
  }

  private appendOverlay(node: Node): void {
    (this.overlayAppendTarget ?? this.overlays).appendChild(node);
  }

  public render(): void {
    if (this.destroyed) return;
    const now = performance.now();
    if (now - this.lastRenderTime < this.MIN_RENDER_INTERVAL_MS) {
      this.scheduleRender();
      return;
    }
    this.lastRenderTime = now;

    // Use the ResizeObserver-maintained cache instead of a live clientWidth/
    // clientHeight read: render() fires repeatedly as data streams in on boot,
    // and each live read interleaved with the prior tick's SVG writes forces a
    // synchronous layout (the #5017 boot reflow). getKnownContainerSize() falls
    // back to a live read only when the cache is still empty (first paint).
    const { width, height } = this.getKnownContainerSize();
    this.renderWithSize(width, height);
  }

  private renderWithSize(width: number, height: number): void {
    if (this.destroyed) return;
    this.rememberContainerSize({ width, height });

    // Skip render if container has no dimensions (tab throttled, hidden, etc.)
    if (width === 0 || height === 0) {
      return;
    }

    // Simple viewBox matching container - keeps SVG and overlays aligned
    if (!this.svg) return;
    this.svg.attr('viewBox', `0 0 ${width} ${height}`);

    // CRITICAL: Always refresh d3 selections from actual DOM to prevent stale references
    // D3 selections can become stale if the DOM is modified externally
    const svgNode = this.svg.node();
    if (!svgNode) return;

    // Query DOM directly for layer groups
    const existingBase = svgNode.querySelector('.map-base') as SVGGElement | null;
    const existingDynamic = svgNode.querySelector('.map-dynamic') as SVGGElement | null;

    // Recreate layer groups if missing or if d3 selections are stale
    const baseStale = !existingBase || this.baseLayerGroup?.node() !== existingBase;
    const dynamicStale = !existingDynamic || this.dynamicLayerGroup?.node() !== existingDynamic;

    if (baseStale || dynamicStale) {
      // Clear any orphaned groups and create fresh ones
      svgNode.querySelectorAll('.map-base, .map-dynamic').forEach(el => el.remove());
      this.baseLayerGroup = this.svg.append('g').attr('class', 'map-base');
      this.dynamicLayerGroup = this.svg.append('g').attr('class', 'map-dynamic');
      this.baseRendered = false;
      console.warn('[Map] Layer groups recreated - baseStale:', baseStale, 'dynamicStale:', dynamicStale);
    }

    // Double-check selections are valid after recreation
    if (!this.baseLayerGroup?.node() || !this.dynamicLayerGroup?.node()) {
      console.error('[Map] Failed to create layer groups');
      return;
    }

    // Check if base layer has actual country content (not just empty group)
    const countryCount = this.baseLayerGroup.node()!.querySelectorAll('.country').length;
    const shouldRenderBase = !this.baseRendered || countryCount === 0 || width !== this.baseWidth || height !== this.baseHeight;

    // Debug: log when base layer needs re-render
    if (shouldRenderBase && countryCount === 0 && this.baseRendered) {
      console.warn('[Map] Base layer missing countries, forcing re-render. countryFeatures:', this.countryFeatures?.length ?? 'null');
    }

    if (shouldRenderBase) {
      this.baseWidth = width;
      this.baseHeight = height;
      // Use native DOM clear for guaranteed effect
      const baseNode = this.baseLayerGroup.node()!;
      while (baseNode.firstChild) baseNode.removeChild(baseNode.firstChild);

      // Background - extend well beyond viewBox to cover pan/zoom transforms
      // 3x size in each direction ensures no black bars when panning
      this.baseLayerGroup
        .append('rect')
        .attr('x', -width)
        .attr('y', -height)
        .attr('width', width * 3)
        .attr('height', height * 3)
        .attr('fill', getCSSColor('--map-bg'));

      // Grid
      this.renderGrid(this.baseLayerGroup, width, height);

      // Setup projection for base elements
      const baseProjection = this.getProjection(width, height);
      const basePath = d3.geoPath().projection(baseProjection);

      // Graticule
      this.renderGraticule(this.baseLayerGroup, basePath);

      // Countries
      this.renderCountries(this.baseLayerGroup, basePath);
      this.baseRendered = true;
    }

    // Defer the first dynamic-overlay pass off the first-paint critical path. The base map
    // (countries) above is enough for LCP; the dynamic layer below (cables/pipelines/
    // cluster markers/overlays) is the heavy synchronous cost (#4429 — ~1.3s
    // of mobile boot scripting, the #1 mobile-TBT contributor since mobile uses this SVG
    // renderer). After first paint, render fully so interactions update overlays immediately.
    if (!this.initialDynamicRendered) {
      if (!this.initialDynamicScheduled) {
        this.initialDynamicScheduled = true;
        // First paint: build the dynamic layers off the critical path AND chunked into
        // sub-50ms tasks (#4442), so the overlay build is neither blocking nor one long task.
        scheduleAfterFirstPaint(() => { void this.renderInitialDynamicPass(); });
      }
      this.applyTransform(false);
      return;
    }

    // Steady state (post first-paint): build the dynamic layers synchronously so interactions
    // (zoom/pan/toggle/theme) update overlays immediately. renderDynamicLayers takes no await
    // when chunk=false, so this runs to completion before returning.
    void this.renderDynamicLayers(width, height);

    // POST-RENDER VERIFICATION: Ensure base layer actually rendered
    // This catches silent failures where d3 operations didn't stick
    if (this.baseRendered && this.countryFeatures && this.countryFeatures.length > 0) {
      const verifyCount = this.baseLayerGroup?.node()?.querySelectorAll('.country').length ?? 0;
      if (verifyCount === 0) {
        console.error('[Map] POST-RENDER: Countries failed to render despite baseRendered=true. Forcing full rebuild.');
        this.baseRendered = false;
        // Schedule a retry on next frame instead of immediate recursion
        this.scheduleRender();
        return;
      }
    }

    this.applyTransform(false);
  }

  // Builds the dynamic overlay layers (cables/pipelines/cluster/overlays).
  // When `chunk` is true, yields between layers so the build runs as several sub-50ms tasks
  // instead of one long task (#4442). Steady-state callers pass chunk=false → no await is
  // reached, so it runs synchronously. The re-entrancy token lets a chunked pass bail once a
  // newer render (which bumps the token and rebuilds) has superseded it.
  private async renderDynamicLayers(width: number, height: number, chunk = false): Promise<void> {
    const dynamicGroup = this.dynamicLayerGroup;
    const dynamicNode = dynamicGroup?.node();
    if (!dynamicGroup || !dynamicNode) return;
    const token = ++this.dynamicRenderToken;

    // Rebuild dynamic layer - native DOM clear for reliability
    while (dynamicNode.firstChild) dynamicNode.removeChild(dynamicNode.firstChild);
    dynamicGroup.append('g').attr('class', 'overlays-svg');

    const projection = this.getProjection(width, height);

    const steps: Array<() => void> = [];
    if (this.state.layers.cables) steps.push(() => this.renderCables(projection));
    if (this.state.layers.pipelines) steps.push(() => this.renderPipelines(projection));
    steps.push(() => this.renderClusterLayer(projection));
    steps.push(() => this.renderOverlays(projection));

    for (let i = 0; i < steps.length; i++) {
      if (chunk && (this.destroyed || token !== this.dynamicRenderToken)) return;
      steps[i]?.();
      if (chunk && i < steps.length - 1) await yieldToMain();
    }
  }

  // First-paint dynamic pass: the base map is already painted, so build the overlays chunked
  // (off the critical path + split into sub-50ms tasks). Steady-state renders run synchronously.
  private async renderInitialDynamicPass(): Promise<void> {
    if (this.destroyed || !this.svg) return;
    const { width, height } = this.getKnownContainerSize();
    if (this.destroyed) return;
    if (width === 0 || height === 0) return; // next real render handles it
    this.initialDynamicRendered = true;
    await this.renderDynamicLayers(width, height, true);
    if (!this.destroyed) this.applyTransform(false);
  }

  private renderGrid(
    group: d3.Selection<SVGGElement, unknown, null, undefined>,
    width: number,
    height: number,
    yStart = 0
  ): void {
    const gridGroup = group.append('g').attr('class', 'grid');

    for (let x = 0; x < width; x += 20) {
      gridGroup
        .append('line')
        .attr('x1', x)
        .attr('y1', yStart)
        .attr('x2', x)
        .attr('y2', yStart + height)
        .attr('stroke', getCSSColor('--map-grid'))
        .attr('stroke-width', 0.5);
    }

    for (let y = yStart; y < yStart + height; y += 20) {
      gridGroup
        .append('line')
        .attr('x1', 0)
        .attr('y1', y)
        .attr('x2', width)
        .attr('y2', y)
        .attr('stroke', getCSSColor('--map-grid'))
        .attr('stroke-width', 0.5);
    }
  }

  private getProjection(width: number, height: number): d3.GeoProjection {
    // Equirectangular with cropped latitude range (72°N to 56°S = 128°)
    // Shows Greenland/Iceland while trimming extreme polar regions
    const LAT_NORTH = 72;  // Includes Greenland (extends to ~83°N but 72 shows most)
    const LAT_SOUTH = -56; // Just below Tierra del Fuego
    const LAT_RANGE = LAT_NORTH - LAT_SOUTH; // 128°
    const LAT_CENTER = (LAT_NORTH + LAT_SOUTH) / 2; // 8°N

    // Scale to fit: 360° longitude in width, 128° latitude in height
    const scaleForWidth = width / (2 * Math.PI);
    const scaleForHeight = height / (LAT_RANGE * Math.PI / 180);
    const scale = Math.min(scaleForWidth, scaleForHeight);

    return d3
      .geoEquirectangular()
      .scale(scale)
      .center([0, LAT_CENTER])
      .translate([width / 2, height / 2]);
  }

  private renderGraticule(
    group: d3.Selection<SVGGElement, unknown, null, undefined>,
    path: d3.GeoPath
  ): void {
    const graticule = d3.geoGraticule();
    group
      .append('path')
      .datum(graticule())
      .attr('class', 'graticule')
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', getCSSColor('--map-stroke'))
      .attr('stroke-width', 0.4);
  }

  private renderCountries(
    group: d3.Selection<SVGGElement, unknown, null, undefined>,
    path: d3.GeoPath
  ): void {
    if (!this.countryFeatures) return;

    group
      .selectAll('.country')
      .data(this.countryFeatures)
      .enter()
      .append('path')
      .attr('class', 'country')
      .attr('d', path as unknown as string)
      .attr('fill', getCSSColor('--map-country'))
      .attr('stroke', getCSSColor('--map-stroke'))
      .attr('stroke-width', 0.7);
  }

  private renderCables(projection: d3.GeoProjection): void {
    if (!this.dynamicLayerGroup) return;
    const cableGroup = this.dynamicLayerGroup.append('g').attr('class', 'cables');

    UNDERSEA_CABLES.forEach((cable) => {
      const lineGenerator = d3
        .line<[number, number]>()
        .x((d) => projection(d)?.[0] ?? 0)
        .y((d) => projection(d)?.[1] ?? 0)
        .curve(d3.curveCardinal);

      const isHighlighted = this.highlightedAssets.cable.has(cable.id);
      const cableAdvisory = this.getCableAdvisory(cable.id);
      const advisoryClass = cableAdvisory ? `cable-${cableAdvisory.severity}` : '';
      const healthRecord = this.healthByCableId[cable.id];
      const healthClass = healthRecord?.status === 'fault' ? 'cable-health-fault' : healthRecord?.status === 'degraded' ? 'cable-health-degraded' : '';
      const highlightClass = isHighlighted ? 'asset-highlight asset-highlight-cable' : '';

      const path = cableGroup
        .append('path')
        .attr('class', `cable-path ${advisoryClass} ${healthClass} ${highlightClass}`.trim())
        .attr('d', lineGenerator(cable.points));

      path.append('title').text(cable.name);

      path.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        this.popup.show({
          type: 'cable',
          data: cable,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      });
    });
  }

  private renderPipelines(projection: d3.GeoProjection): void {
    if (!this.dynamicLayerGroup) return;
    const pipelineGroup = this.dynamicLayerGroup.append('g').attr('class', 'pipelines');

    PIPELINES.forEach((pipeline) => {
      const lineGenerator = d3
        .line<[number, number]>()
        .x((d) => projection(d)?.[0] ?? 0)
        .y((d) => projection(d)?.[1] ?? 0)
        .curve(d3.curveCardinal.tension(0.5));

      const color = PIPELINE_COLORS[pipeline.type] || getCSSColor('--text-dim');
      const opacity = 0.85;
      const dashArray = pipeline.status === 'construction' ? '4,2' : 'none';

      const isHighlighted = this.highlightedAssets.pipeline.has(pipeline.id);
      const path = pipelineGroup
        .append('path')
        .attr('class', `pipeline-path pipeline-${pipeline.type} pipeline-${pipeline.status}${isHighlighted ? ' asset-highlight asset-highlight-pipeline' : ''}`)
        .attr('d', lineGenerator(pipeline.points))
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', 2.5)
        .attr('stroke-opacity', opacity)
        .attr('stroke-linecap', 'round')
        .attr('stroke-linejoin', 'round');

      if (dashArray !== 'none') {
        path.attr('stroke-dasharray', dashArray);
      }

      path.append('title').text(`${pipeline.name} (${pipeline.type.toUpperCase()})`);

      path.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        this.popup.show({
          type: 'pipeline',
          data: pipeline,
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      });
    });
  }

  private isLayerZoomVisible(layer: keyof MapLayers): boolean {
    if (!this.state.layers[layer]) return false;
    const thresholds = MapComponent.LAYER_ZOOM_THRESHOLDS[layer];
    if (!thresholds) return true;
    return Boolean(this.layerZoomOverrides[layer]) || this.state.zoom >= thresholds.minZoom;
  }

  /**
   * Chooses which overlay markers this render pass is allowed to create (#7112).
   *
   * `renderOverlays` rebuilds every HTML marker from scratch on every render, and
   * each marker is a `<div>` with its own `click` listener. With an uncapped feed
   * that makes both the live DOM size and the renderer's detached-node count a
   * function of upstream traffic: production measured 2,088 overlay markers on a
   * desktop cold load (1,502 of them military vessels), 17.4k renderer nodes and
   * 2.8k listeners at rest, spiking to 49.7k / 21.5k while a rebuild's previous
   * generation waited for GC. Desktop reaches this path whenever the client has
   * no hardware WebGL2 context, which is the normal state of a lab runner.
   *
   * The selection is the globe's (#5368) — same module, same ceilings, so a
   * client that falls back from Deck to SVG does not silently change how much of
   * a layer it can see. The plan is stored as the set of markers to WITHHOLD, so
   * a feed absent from the plan renders in full rather than disappearing.
   */
  /**
   * The exact slice of each filtered feed that `renderOverlays` will draw.
   *
   * The budget plan and the render loops MUST agree on these (#7112). Planning
   * on the unfiltered field instead would let the budget spend its fair share
   * on markers the loop then filters away: a 24-hour time filter over a
   * 2,000-event earthquake feed would keep the 300 largest of all time, most of
   * them outside the window, and render a fraction of what the ceiling allows.
   */
  private overlayFeedSlices(): {
    quakes: readonly Earthquake[];
    weather: readonly WeatherAlert[];
    news: readonly MapComponent['newsLocations'][number][];
    naturalEvents: readonly NaturalEvent[];
    radiationObservations: readonly RadiationObservation[];
    outages: readonly InternetOutage[];
    cableAdvisories: readonly CableAdvisory[];
    fires: readonly MapComponent['firmsFireData'][number][];
  } {
    const withinTimeRange = <T extends { occurredAt: number }>(items: readonly T[]): readonly T[] => (
      this.state.timeRange === 'all'
        ? items
        : items.filter((item) => item.occurredAt >= Date.now() - this.getTimeRangeMs())
    );
    // Each feed is emptied when its layer is off before any filtering runs, so
    // this method costs no more per render than the guarded blocks it replaced.
    // renderOverlays is on the pan/zoom path.
    const layers = this.state.layers;
    const activeQuakes = layers.natural ? this.earthquakes : [];
    const filteredQuakes = withinTimeRange(activeQuakes);
    return {
      quakes: this.isMobile
        ? filteredQuakes.filter((eq) => eq.magnitude >= MapComponent.MOBILE_MIN_EARTHQUAKE_MAGNITUDE)
        : filteredQuakes,
      // `centroid` is optional on WeatherAlert and the render loop skips an alert
      // without one, so an alert that can never become a marker must not be
      // budgeted: it would inflate the `weather` group that fairShareCap sizes
      // every other layer against, and overstate `total` in the shown/total badge
      // with markers that were never renderable. Same plan/loop agreement rule as
      // the earthquake slice (3356f19c8) — this is the only other feed with a
      // per-marker data precondition; the `newsCount === 0` skips sit on exempt
      // groups, which are outside the budget entirely.
      weather: layers.weather
        ? this.filterByTime(this.weatherAlerts, (alert) => alert.onset).filter((alert) => alert.centroid)
        : [],
      news: this.newsLocations.filter((item) => {
        if (!Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return false;
        if (this.state.timeRange === 'all') return true;
        const timestamp = item.timestamp?.getTime();
        return timestamp == null || !Number.isFinite(timestamp) || timestamp >= Date.now() - this.getTimeRangeMs();
      }),
      // Same fields DeckGLMap.buildLayers filters on, so both renderers show the
      // same records for a given TIME RANGE.
      naturalEvents: layers.natural ? this.filterByTime(this.naturalEvents, (event) => event.date) : [],
      radiationObservations: layers.radiationWatch
        ? this.filterByTime(this.radiationObservations, (observation) => observation.observedAt)
        : [],
      outages: layers.outages ? this.filterByTime(this.outages, (outage) => outage.pubDate) : [],
      cableAdvisories: layers.cables ? this.filterByTime(this.cableAdvisories, (advisory) => advisory.reported) : [],
      fires: layers.fires ? this.filterByTime(this.firmsFireData, (fire) => fire.acq_date) : [],
    };
  }

  /** Mirrors DeckGLMap.filterByTime: a record without a parseable date stays visible. */
  private filterByTime<T>(
    items: readonly T[],
    getTime: (item: T) => Date | string | number | null | undefined,
  ): readonly T[] {
    if (this.state.timeRange === 'all') return items;
    const cutoff = Date.now() - this.getTimeRangeMs();
    return items.filter((item) => {
      const value = getTime(item);
      if (value == null) return true;
      const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
      return !Number.isFinite(timestamp) || timestamp >= cutoff;
    });
  }

  private planOverlayMarkerBudget(
    projection: d3.GeoProjection,
    slices: ReturnType<MapComponent['overlayFeedSlices']>,
  ): void {
    const groups: GlobeMarkerGroup<unknown>[] = [];
    const add = (
      layer: string,
      markers: readonly unknown[],
      // Only the tuning knobs, mirroring GlobeMap.flushMarkers: spreading a full
      // Partial would let a caller overwrite the layer/markers just set.
      extra: Pick<Partial<GlobeMarkerGroup<unknown>>, 'rank' | 'exempt'> = {},
    ): void => { if (markers.length) groups.push({ layer, markers, ...extra }); };

    const layers = this.state.layers;
    add('news', slices.news);
    // The zoom gates below mirror the render conditions exactly: a group that
    // is planned but not rendered would spend fair share it never uses, and
    // tighten the cap on the layers that do render.
    if (this.isLayerZoomVisible('nuclear')) add('nuclear', NUCLEAR_FACILITIES);
    if (layers.usNuclearFacilities) add('usNuclearFacilities', US_NUCLEAR_FACILITIES);
    if (layers.irradiators) add('irradiators', GAMMA_IRRADIATORS);
    if (layers.natural) {
      add('natural', slices.quakes, { rank: (m) => (m as Earthquake).magnitude ?? 0 });
      add('natural', slices.naturalEvents);
    }
    if (layers.weather) add('weather', slices.weather);
    if (layers.radiationWatch) add('radiationWatch', slices.radiationObservations);
    if (layers.outages) add('outages', slices.outages);
    if (layers.cables) {
      add('cables', slices.cableAdvisories);
      add('cables', this.repairShips);
    }
    if (layers.datacenters) add('datacenters', RENDERABLE_AI_DATA_CENTERS);
    if (layers.fires) {
      add('fires', slices.fires, { rank: (m) => (m as { brightness?: number }).brightness ?? 0 });
    }
    if (layers.webcams && this.state.zoom >= 2) add('webcams', this.webcamData);

    // Layers with no severity signal rank by nearness to the centre of the
    // current view rather than by raw feed order, so a capped reference layer
    // drops whatever is furthest from what the user is looking at instead of
    // whatever happens to sort last. See proximityRank.
    const { width, height } = this.getKnownContainerSize();
    const centre = this.getOverlayBudgetCentre(projection, width, height);
    const nearestFirst = proximityRank<unknown>(
      centre,
      overlayMarkerPosition,
    );
    for (const group of groups) {
      if (group.exempt) continue;
      if (group.rank) group.tieBreak = nearestFirst;
      else group.rank = nearestFirst;
    }

    const budget = this.isMobile
      ? MAP_OVERLAY_MARKER_BUDGET_MOBILE
      : MAP_OVERLAY_MARKER_BUDGET_DESKTOP;
    const { markers, truncated } = selectGlobeMarkers(groups, budget);

    const kept = new Set(markers);
    const cut = new Set<unknown>();
    for (const group of groups) {
      if (group.exempt) continue;
      for (const marker of group.markers) {
        if (!kept.has(marker)) cut.add(marker);
      }
    }
    this.overlayMarkerCut = cut;
    this.overlayMarkerTruncation = truncated;
    this.renderedOverlayMarkerCount = markers.length;
    this.lastOverlayBudgetViewport = {
      width,
      height,
      zoom: this.state.zoom,
      panX: this.state.pan.x,
      panY: this.state.pan.y,
    };
    this.updateLayerTruncationLabels();
  }

  /**
   * Return the geographic point currently at the screen centre.
   *
   * The SVG projection is transformed by CSS after it produces marker
   * coordinates. Inverting the untransformed screen centre therefore ranks the
   * old map centre after a pan or zoom. Undo the same translate/scale that
   * applyTransform() applies before asking d3 for the geographic coordinate.
   */
  private getOverlayBudgetCentre(
    projection: d3.GeoProjection,
    width: number,
    height: number,
  ): LatLng {
    const centre = projection.invert?.(projectionPointAtScreenCentre(width, height, this.state.pan));
    return { lat: centre?.[1] ?? 0, lng: centre?.[0] ?? 0 };
  }

  /** True when this render pass withheld `marker` under the overlay budget (#7112). */
  private isOverlayMarkerCut(marker: unknown): boolean {
    return this.overlayMarkerCut.size > 0 && this.overlayMarkerCut.has(marker);
  }

  /**
   * Discloses a capped layer as `shown/total` on its toggle row, the way the
   * globe does — a ceiling the user cannot see is indistinguishable from missing
   * data. Skipped when nothing changed: this runs on every render pass, and the
   * writes would restyle the toggle rows each time (#5080).
   *
   * A layer the budget trimmed that has no toggle row in this variant's picker
   * (`webcams`, `radiationWatch`) has nowhere to show a badge. Those stay budgeted — an
   * unbounded feed is what #7112 is about, and `toMapFires` caps nothing — but
   * the cut is recorded on `overlayUndisclosedTruncation` and surfaced through
   * getOverlayMarkerBudgetState() rather than vanishing, so it is assertable and
   * a newly-added rowless layer trips the guard test instead of going quiet.
   */
  private updateLayerTruncationLabels(): void {
    const root = this.container.querySelector<HTMLElement>('#layerToggles');

    if (!root) {
      // No toggle rail exists at all. `chrome: false` builds one of these on
      // purpose (src/embed/panels/map.ts) — an embed has no controls — so there
      // is nowhere for any `shown/total` badge to go and EVERY trimmed layer is
      // undisclosed. Recording the honest set matters more here than anywhere
      // else: returning early without touching it left
      // getOverlayMarkerBudgetState().undisclosed reading `[]`, i.e. reporting
      // full disclosure while the embed silently withheld markers, and any test
      // asserting `undisclosed` is empty passed for that reason rather than
      // because the cut was shown.
      //
      // Recomputed on every pass rather than latched: the key latch below only
      // advances when badges were actually written, so a map that never has a
      // rail would otherwise keep a stale set once truncation changed or cleared.
      this.overlayUndisclosedTruncation = Object.keys(this.overlayMarkerTruncation);
      this.renderCompactTruncationSummary();
      return;
    }

    const key = Object.entries(this.overlayMarkerTruncation)
      .map(([layer, counts]) => `${layer}:${counts.shown}/${counts.total}`)
      .sort()
      .join(',');
    // Same key means the same truncation, so the badges and the undisclosed set
    // are both already correct. Latching only after the write above is what lets
    // a render that ran before the rail existed be redone once it appears.
    if (key === this.lastTruncationLabelKey) return;
    this.lastTruncationLabelKey = key;
    const { undisclosed } = renderLayerTruncationBadges(root, this.overlayMarkerTruncation, 'pan');
    this.overlayUndisclosedTruncation = undisclosed;
    this.renderCompactTruncationSummary(this.overlayMarkerTruncation.news ? [this.overlayMarkerTruncation.news] : []);
  }

  /**
   * The one disclosure a chrome-less map can still make (#7112).
   *
   * `chrome: false` (src/embed/panels/map.ts) deliberately builds no controls, so
   * there is no toggle row to hang a per-layer `shown/total` badge on. Recording
   * the undisclosed set above makes the state honest, but the person looking at
   * the embed still sees a partial map and no reason for it — and "a ceiling the
   * user cannot see is indistinguishable from missing data" is the whole argument
   * the per-layer badge rests on.
   *
   * So state the total, compactly, inside the map itself. Deliberately NOT a
   * control: no click target, no toggle, nothing that reintroduces the chrome the
   * embed opted out of — just the count and a `title` carrying the explanation.
   * Idempotent (one node, updated in place) and removed the moment nothing is
   * being withheld, so it cannot accumulate across renders or outlive the cut.
   */
  private renderCompactTruncationSummary(entries = Object.values(this.overlayMarkerTruncation)): void {
    const existing = this.container.querySelector<HTMLElement>('.map-truncation-summary');

    if (entries.length === 0) {
      existing?.remove();
      return;
    }

    const shown = entries.reduce((sum, counts) => sum + counts.shown, 0);
    const total = entries.reduce((sum, counts) => sum + counts.total, 0);
    const summary = existing ?? document.createElement('div');
    if (!existing) {
      summary.className = 'map-truncation-summary';
      // The summary is absolutely positioned, and MapComponent does not own the
      // container's CSS — an embed host supplies it. `.map-container` happens to
      // be `position: relative`, but a static container would let the summary
      // escape to some ancestor and land anywhere on the host page. Establish the
      // containing block once, on creation only, so this costs a style resolution
      // the first time a chrome-less map is over budget and never again.
      if (getComputedStyle(this.container).position === 'static') {
        this.container.style.position = 'relative';
      }
      this.container.appendChild(summary);
    }
    summary.textContent = `${shown}/${total} markers`;
    // Untranslated literal, matching the per-layer badge and its existing i18n
    // follow-up.
    summary.title = `Showing ${shown} of ${total} markers — the most significant, and those nearest the current view. The map caps markers per layer to keep interaction responsive; pan or zoom to bring others in.`;
  }

  /** Markers this render pass drew, and what the budget withheld (#7112). */
  public getOverlayMarkerBudgetState(): {
    rendered: number;
    renders: number;
    truncated: Record<string, GlobeLayerTruncation>;
    undisclosed: string[];
  } {
    return {
      rendered: this.renderedOverlayMarkerCount,
      // Overlay rebuild count. Lets a test assert that a view which another
      // render already re-planned does not get rebuilt a second time.
      renders: this.overlayRenderCount,
      truncated: this.overlayMarkerTruncation,
      // Layers trimmed with no toggle row to show a `shown/total` badge on.
      // Should be empty for any layer this variant's picker exposes.
      undisclosed: this.overlayUndisclosedTruncation,
    };
  }

  private renderOverlays(projection: d3.GeoProjection): void {
    this.overlayRenderCount += 1;
    setTrustedHtml(this.overlays, trustedHtml('', "legacy direct innerHTML migration"));
    this.labelVisibilityScheduled = false;
    const slices = this.overlayFeedSlices();
    this.planOverlayMarkerBudget(projection, slices);
    const fragment = document.createDocumentFragment();
    const previousTarget = this.overlayAppendTarget;
    this.overlayAppendTarget = fragment;

    try {
    for (const item of slices.news) {
      if (this.isOverlayMarkerCut(item)) continue;
      const pos = projection([item.lon, item.lat]);
      if (!pos) continue;
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'news-location-marker';
      marker.style.cssText = 'position:absolute;width:24px;height:24px;border:0;padding:0;border-radius:50%;transform:translate(-50%,-50%) scale(var(--marker-scale,1));transform-origin:center;z-index:53;pointer-events:auto;cursor:pointer';
      marker.style.left = `${pos[0]}px`;
      marker.style.top = `${pos[1]}px`;
      marker.style.background = `radial-gradient(circle, ${getThreatColor(item.threatLevel)} 4px, transparent 4px)`;
      marker.title = item.title;
      marker.setAttribute('aria-label', item.title);
      marker.addEventListener('click', (event) => {
        event.stopPropagation();
        const rect = this.container.getBoundingClientRect();
        this.popup.show({ type: 'news', data: item, x: event.clientX - rect.left, y: event.clientY - rect.top });
        this.onNewsClick?.(item);
      });
      this.appendOverlay(marker);
    }
    // Nuclear facilities (always HTML - shapes convey status)
    if (this.state.layers.nuclear && this.isLayerZoomVisible('nuclear')) {
      NUCLEAR_FACILITIES.forEach((facility) => {
        if (this.isOverlayMarkerCut(facility)) return;
        const pos = projection([facility.lon, facility.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        const isHighlighted = this.highlightedAssets.nuclear.has(facility.id);
        div.className = `nuclear-marker ${facility.status}${isHighlighted ? ' asset-highlight asset-highlight-nuclear' : ''}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.title = `${facility.name} (${facility.type})`;

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'nuclear',
            data: facility,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.appendOverlay(div);
      });
    }

    // NucMonitor — US nuclear facility registry (HTML markers, category-colored)
    if (this.state.layers.usNuclearFacilities) {
      US_NUCLEAR_FACILITIES.forEach((facility) => {
        if (this.isOverlayMarkerCut(facility)) return;
        const pos = projection([facility.lon, facility.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `us-facility-marker ${facility.category}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.title = `${facility.name} (${facility.category})`;

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'usNuclear',
            data: facility,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.appendOverlay(div);
      });
    }

    // Gamma irradiators (IAEA DIIF) - no labels, click to see details
    if (this.state.layers.irradiators) {
      GAMMA_IRRADIATORS.forEach((irradiator) => {
        if (this.isOverlayMarkerCut(irradiator)) return;
        const pos = projection([irradiator.lon, irradiator.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = 'irradiator-marker';
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.title = `${irradiator.city}, ${irradiator.country}`;

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'irradiator',
            data: irradiator,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.appendOverlay(div);
      });
    }

    // Earthquakes (magnitude-based sizing) - part of NATURAL layer
    if (this.state.layers.natural) {
      console.log('[Map] Rendering earthquakes. Total:', this.earthquakes.length, 'Layer enabled:', this.state.layers.natural);
      const quakesForRender = slices.quakes;
      console.log('[Map] After time/mobile filter:', quakesForRender.length, 'earthquakes. TimeRange:', this.state.timeRange);
      let rendered = 0;
      quakesForRender.forEach((eq) => {
        if (this.isOverlayMarkerCut(eq)) return;
        const pos = projection([eq.location?.longitude ?? 0, eq.location?.latitude ?? 0]);
        if (!pos) {
          console.log('[Map] Earthquake position null for:', eq.place, eq.location?.longitude, eq.location?.latitude);
          return;
        }
        rendered++;

        const size = Math.max(8, eq.magnitude * 3);
        const div = document.createElement('div');
        div.className = 'earthquake-marker';
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.width = `${size}px`;
        div.style.height = `${size}px`;
        div.title = `M${eq.magnitude.toFixed(1)} - ${eq.place}`;

        const label = document.createElement('div');
        label.className = 'earthquake-label';
        label.textContent = `M${eq.magnitude.toFixed(1)}`;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'earthquake',
            data: eq,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.appendOverlay(div);
      });
      console.log('[Map] Actually rendered', rendered, 'earthquake markers');
    }

    // Weather Alerts (severity icons)
    if (this.state.layers.weather) {
      slices.weather.forEach((alert) => {
        if (this.isOverlayMarkerCut(alert)) return;
        const pos = projection(alert.centroid as [number, number]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `weather-marker ${alert.severity.toLowerCase()}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.borderColor = getSeverityColor(alert.severity);

        const icon = document.createElement('div');
        icon.className = 'weather-icon';
        icon.textContent = '⚠';
        div.appendChild(icon);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'weather',
            data: alert,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.appendOverlay(div);
      });
    }

    if (this.state.layers.radiationWatch) {
      slices.radiationObservations.forEach((observation) => {
        if (this.isOverlayMarkerCut(observation)) return;
        const pos = projection([observation.lon, observation.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        const color = observation.severity === 'spike' ? '#ff3030' : '#ffaa00';
        div.className = `radiation-watch-marker radiation-watch-marker-${observation.severity}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;
        div.style.width = '14px';
        div.style.height = '14px';
        div.style.borderRadius = '50%';
        div.style.background = color;
        div.style.border = '2px solid rgba(255,255,255,0.75)';
        div.style.boxShadow = `0 0 10px ${color}88`;
        div.title = `${observation.location}: ${observation.value.toFixed(1)} ${observation.unit}`;

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'radiation',
            data: observation,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.appendOverlay(div);
      });
    }

    // Internet Outages (severity colors)
    if (this.state.layers.outages) {
      slices.outages.forEach((outage) => {
        if (this.isOverlayMarkerCut(outage)) return;
        const pos = projection([outage.lon, outage.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `outage-marker ${outage.severity}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'outage-icon';
        icon.textContent = '📡';
        div.appendChild(icon);

        const label = document.createElement('div');
        label.className = 'outage-label';
        label.textContent = outage.country;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'outage',
            data: outage,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.appendOverlay(div);
      });
    }

    // Cable advisories & repair ships
    if (this.state.layers.cables) {
      slices.cableAdvisories.forEach((advisory) => {
        if (this.isOverlayMarkerCut(advisory)) return;
        const pos = projection([advisory.lon, advisory.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `cable-advisory-marker ${advisory.severity}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'cable-advisory-icon';
        icon.textContent = advisory.severity === 'fault' ? '⚡' : '⚠';
        div.appendChild(icon);

        const label = document.createElement('div');
        label.className = 'cable-advisory-label';
        label.textContent = this.getCableName(advisory.cableId);
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'cable-advisory',
            data: advisory,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.appendOverlay(div);
      });

      this.repairShips.forEach((ship) => {
        if (this.isOverlayMarkerCut(ship)) return;
        const pos = projection([ship.lon, ship.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `repair-ship-marker ${ship.status}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'repair-ship-icon';
        icon.textContent = '🚢';
        div.appendChild(icon);

        const label = document.createElement('div');
        label.className = 'repair-ship-label';
        label.textContent = ship.name;
        div.appendChild(label);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'repair-ship',
            data: ship,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.appendOverlay(div);
      });
    }

    // AI Data Centers (always HTML - icons; RENDERABLE_AI_DATA_CENTERS is the
    // >=10k-GPU list, shared with the overlay budget plan)
    if (this.state.layers.datacenters) {
      RENDERABLE_AI_DATA_CENTERS.forEach((dc) => {
        if (this.isOverlayMarkerCut(dc)) return;
        const pos = projection([dc.lon, dc.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        const isHighlighted = this.highlightedAssets.datacenter.has(dc.id);
        div.className = `datacenter-marker ${dc.status}${isHighlighted ? ' asset-highlight asset-highlight-datacenter' : ''}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'datacenter-icon';
        icon.textContent = '🖥️';
        div.appendChild(icon);

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'datacenter',
            data: dc,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.appendOverlay(div);
      });
    }

    // Natural Events (NASA EONET) - part of NATURAL layer
    if (this.state.layers.natural) {
      slices.naturalEvents.forEach((event) => {
        if (this.isOverlayMarkerCut(event)) return;
        const pos = projection([event.lon, event.lat]);
        if (!pos) return;

        const div = document.createElement('div');
        div.className = `nat-event-marker ${event.category}`;
        div.style.left = `${pos[0]}px`;
        div.style.top = `${pos[1]}px`;

        const icon = document.createElement('div');
        icon.className = 'nat-event-icon';
        icon.textContent = getNaturalEventIcon(event.category);
        div.appendChild(icon);

        if (this.state.zoom >= 2) {
          const label = document.createElement('div');
          label.className = 'nat-event-label';
          label.textContent = event.title.length > 25 ? event.title.slice(0, 25) + '…' : event.title;
          div.appendChild(label);
        }

        if (event.magnitude) {
          const mag = document.createElement('div');
          mag.className = 'nat-event-magnitude';
          mag.textContent = `${event.magnitude}${event.magnitudeUnit ? ` ${event.magnitudeUnit}` : ''}`;
          div.appendChild(mag);
        }

        div.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = this.container.getBoundingClientRect();
          this.popup.show({
            type: 'natEvent',
            data: event,
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
          });
        });

        this.appendOverlay(div);
      });
    }

    // Satellite Fires (NASA FIRMS) - separate fires layer
    if (this.state.layers.fires) {
      slices.fires.forEach((fire) => {
        if (this.isOverlayMarkerCut(fire)) return;
        const pos = projection([fire.lon, fire.lat]);
        if (!pos) return;

        const color = fire.brightness > 400 ? getCSSColor('--semantic-critical') : fire.brightness > 350 ? getCSSColor('--semantic-high') : getCSSColor('--semantic-elevated');
        const size = Math.max(4, Math.min(10, (fire.frp || 1) * 0.5));

        const dot = document.createElement('div');
        dot.className = 'fire-dot';
        dot.style.left = `${pos[0]}px`;
        dot.style.top = `${pos[1]}px`;
        dot.style.width = `${size}px`;
        dot.style.height = `${size}px`;
        dot.style.backgroundColor = color;
        dot.title = `${fire.region} — ${Math.round(fire.brightness)}K, ${fire.frp}MW`;

        this.appendOverlay(dot);
      });
    }

    // Webcam markers (colored circles, gated by zoom >= 2)
    if (this.state.layers.webcams && this.webcamData.length > 0 && this.state.zoom >= 2) {
      const CATEGORY_COLORS: Record<string, string> = {
        traffic: '#ffd700', city: '#00d4ff', landscape: '#45b7d1',
        nature: '#96ceb4', beach: '#f4a460', water: '#4169e1', other: '#888888',
      };
      this.webcamData.forEach((cam) => {
        if (this.isOverlayMarkerCut(cam)) return;
        const pos = projection([cam.lng, cam.lat]);
        if (!pos || !Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return;
        const isCluster = 'count' in cam;
        const radius = isCluster ? Math.min(4 + Math.sqrt((cam as WebcamCluster).count), 12) : 3;
        const size = radius * 2;
        const color = isCluster ? '#00d4ff' : (CATEGORY_COLORS[(cam as WebcamEntry).category] ?? '#888888');
        const dot = document.createElement('div');
        dot.className = 'webcam-dot';
        dot.style.left = `${pos[0]}px`;
        dot.style.top = `${pos[1]}px`;
        dot.style.width = `${size}px`;
        dot.style.height = `${size}px`;
        dot.style.position = 'absolute';
        dot.style.borderRadius = '50%';
        dot.style.backgroundColor = color;
        dot.style.opacity = '0.75';
        dot.style.cursor = 'pointer';
        dot.title = isCluster ? `${(cam as WebcamCluster).count} webcams` : ((cam as WebcamEntry).title || 'Webcam');
        dot.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isCluster) {
            this.showWebcamClusterPopup(cam as WebcamCluster, e.clientX, e.clientY);
          } else {
            this.showWebcamTooltip(cam as WebcamEntry, e.clientX, e.clientY);
          }
        });
        this.appendOverlay(dot);
      });
    }

    } finally {
      this.overlayAppendTarget = previousTarget;
      this.overlays.appendChild(fragment);
      this.armMarkerSettle();
    }
  }

  // #4669: let freshly-rendered markers pulse for the attention window, then
  // add .markers-settled on the wrapper so main.css stops the infinite pulses
  // and their compositing layers are released while the map is idle.
  private armMarkerSettle(): void {
    this.wrapper.classList.remove('markers-settled');
    if (this.markerSettleTimer !== null) clearTimeout(this.markerSettleTimer);
    this.markerSettleTimer = setTimeout(() => {
      this.markerSettleTimer = null;
      if (this.destroyed) return;
      this.wrapper.classList.add('markers-settled');
    }, MapComponent.MARKER_SETTLE_MS);
  }

  private makeWebcamTooltipShell(): { tooltip: HTMLDivElement; closeBtn: HTMLButtonElement } {
    this.container.querySelector('.webcam-tooltip')?.remove();
    const tooltip = document.createElement('div');
    tooltip.className = 'webcam-tooltip';
    tooltip.style.cssText = [
      'position:absolute',
      'background:rgba(10,12,16,0.95)',
      'border:1px solid rgba(60,120,60,0.6)',
      'padding:8px 12px',
      'border-radius:3px',
      'font-size:calc(11px * var(--wm-panel-effective-scale, 1))',
      'font-family:var(--font-mono)',
      'color:#d4d4d4',
      'max-width:240px',
      'z-index:1000',
      'pointer-events:auto',
      'line-height:1.5',
    ].join(';');
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'position:absolute;top:4px;right:4px;background:none;border:none;color:#888;cursor:pointer;font-size:calc(14px * var(--wm-panel-effective-scale, 1));line-height:1;padding:2px 4px;';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => tooltip.remove());
    tooltip.appendChild(closeBtn);
    return { tooltip, closeBtn };
  }

  private placeWebcamTooltip(tooltip: HTMLElement, clientX: number, clientY: number): void {
    const rect = this.container.getBoundingClientRect();
    this.container.appendChild(tooltip);
    const x = Math.min(clientX - rect.left + 10, rect.width - 260);
    const y = Math.max(clientY - rect.top - 20, 4);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
    let hideTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => tooltip.remove(), 8000);
    tooltip.addEventListener('mouseenter', () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
    tooltip.addEventListener('mouseleave', () => { hideTimer = setTimeout(() => tooltip.remove(), 2000); });
  }

  private showWebcamTooltip(cam: WebcamEntry, clientX: number, clientY: number): void {
    const { tooltip } = this.makeWebcamTooltipShell();

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:bold;color:#00d4ff;padding-right:18px;';
    title.textContent = `\u{1F4F7} ${cam.title || cam.category || 'Webcam'}`;
    tooltip.appendChild(title);

    const meta = document.createElement('div');
    meta.style.cssText = 'opacity:0.7;font-size:calc(10px * var(--wm-panel-effective-scale, 1));margin-top:2px;';
    meta.textContent = [cam.country, cam.category].filter(Boolean).join(' \u00B7 ');
    if (meta.textContent) tooltip.appendChild(meta);

    const previewDiv = document.createElement('div');
    previewDiv.style.marginTop = '6px';
    const loadingSpan = document.createElement('span');
    loadingSpan.style.cssText = 'opacity:0.5;font-size:calc(10px * var(--wm-panel-effective-scale, 1));';
    loadingSpan.textContent = 'Loading preview...';
    previewDiv.appendChild(loadingSpan);
    tooltip.appendChild(previewDiv);

    if (cam.webcamId) {
      const link = document.createElement('a');
      link.href = `https://www.windy.com/webcams/${cam.webcamId}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.style.cssText = 'display:block;margin-top:4px;color:#00d4ff;font-size:calc(11px * var(--wm-panel-effective-scale, 1));text-decoration:none;';
      link.textContent = 'Open on Windy \u2197';
      tooltip.appendChild(link);
    }

    this.placeWebcamTooltip(tooltip, clientX, clientY);

    if (cam.webcamId) {
      import('@/services/webcams').then(({ fetchWebcamImage }) => {
        fetchWebcamImage(cam.webcamId).then(img => {
          if (!tooltip.isConnected) return;
          previewDiv.replaceChildren();
          if (img.thumbnailUrl) {
            const imgEl = document.createElement('img');
            imgEl.src = img.thumbnailUrl;
            imgEl.style.cssText = 'width:200px;border-radius:4px;margin-bottom:4px;';
            imgEl.loading = 'lazy';
            previewDiv.appendChild(imgEl);
          } else {
            const span = document.createElement('span');
            span.style.cssText = 'opacity:0.5;font-size:calc(10px * var(--wm-panel-effective-scale, 1));';
            span.textContent = 'Preview unavailable';
            previewDiv.appendChild(span);
          }

          const pinBtn = document.createElement('button');
          pinBtn.className = 'webcam-pin-btn';
          const wcId = cam.webcamId;
          if (isPinned(wcId)) {
            pinBtn.classList.add('webcam-pin-btn--pinned');
            pinBtn.textContent = '\u{1F4CC} Pinned';
            pinBtn.disabled = true;
          } else {
            pinBtn.textContent = '\u{1F4CC} Pin';
            pinBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              pinWebcam({
                webcamId: wcId,
                title: cam.title || img?.title || '',
                lat: cam.lat,
                lng: cam.lng,
                category: cam.category || 'other',
                country: cam.country || '',
                playerUrl: img?.playerUrl || '',
              });
              pinBtn.classList.add('webcam-pin-btn--pinned');
              pinBtn.textContent = '\u{1F4CC} Pinned';
              pinBtn.disabled = true;
            });
          }
          tooltip.appendChild(pinBtn);
        });
      });
    } else {
      previewDiv.remove();
    }
  }

  private showWebcamClusterPopup(cam: WebcamCluster, clientX: number, clientY: number): void {
    const { tooltip } = this.makeWebcamTooltipShell();

    const header = document.createElement('div');
    header.style.cssText = 'font-weight:bold;color:#00d4ff;padding-right:18px;';
    header.textContent = `\u{1F4F7} ${cam.count} webcams — loading...`;
    tooltip.appendChild(header);

    this.placeWebcamTooltip(tooltip, clientX, clientY);

    const currentZoom = this.state.zoom ?? 3;
    import('@/services/webcams').then(({ fetchWebcams, getClusterCellSize }) => {
      const margin = Math.max(0.5, getClusterCellSize(currentZoom));
      fetchWebcams(10, {
        w: cam.lng - margin, s: cam.lat - margin,
        e: cam.lng + margin, n: cam.lat + margin,
      }).then(result => {
        if (!tooltip.isConnected) return;
        const webcams = result.webcams.slice(0, 20);
        header.textContent = `\u{1F4F7} ${webcams.length} webcams`;

        const list = document.createElement('div');
        list.style.cssText = 'max-height:200px;overflow-y:auto;margin-top:6px;';
        for (const webcam of webcams) {
          const item = document.createElement('div');
          item.style.cssText = 'padding:3px 2px;cursor:pointer;color:#aaa;border-bottom:1px solid rgba(255,255,255,0.08);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          const nameSpan = document.createElement('span');
          nameSpan.textContent = webcam.title || webcam.category || 'Webcam';
          item.appendChild(nameSpan);
          if (webcam.country) {
            const cc = document.createElement('span');
            cc.style.cssText = 'float:right;opacity:0.4;font-size:calc(10px * var(--wm-panel-effective-scale, 1));margin-left:6px;';
            cc.textContent = webcam.country;
            item.appendChild(cc);
          }
          item.addEventListener('mouseenter', () => { item.style.color = '#00d4ff'; });
          item.addEventListener('mouseleave', () => { item.style.color = '#aaa'; });
          item.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showWebcamTooltip(webcam, e.clientX, e.clientY);
          });
          list.appendChild(item);
        }
        tooltip.appendChild(list);
      }).catch(() => {
        if (!tooltip.isConnected) return;
        header.textContent = '\u{1F4F7} Failed to load webcam list';
      });
    });
  }

  public flashLocation(lat: number, lon: number, durationMs = 2000): void {
    // flashMapForNews() flashes the map once per matching news item, firing in
    // bursts across load passes (hundreds of calls shortly after load) against a
    // container whose size is not changing. A live clientWidth/clientHeight read
    // here forced a synchronous layout of the whole base-map SVG on every call
    // (~75ms across the load in the authenticated DebugBear trace — the dominant
    // Map forced-reflow, #5049 / tail of #5017/#5022). Route through the
    // ResizeObserver-maintained cache
    // instead; it falls back to a live read only while the cache is empty
    // (first paint). This is the draw/render path, not a one-shot viewport
    // command, so the cache is the correct source (#5022).
    const { width, height } = this.getKnownContainerSize();
    if (!width || !height) return;

    const projection = this.getProjection(width, height);
    const pos = projection([lon, lat]);
    if (!pos) return;

    const flash = document.createElement('div');
    flash.className = 'map-flash';
    flash.style.left = `${pos[0]}px`;
    flash.style.top = `${pos[1]}px`;
    flash.style.setProperty('--flash-duration', `${durationMs}ms`);
    this.appendOverlay(flash);
    this.trackFlash(flash, durationMs);
  }

  /**
   * Holds concurrent news flashes to a fixed ceiling (#7112).
   *
   * A flash is a `#mapOverlays` child like every budgeted marker, but it is
   * created outside planOverlayMarkerBudget() — so without a bound of its own it
   * is simply unbounded DOM on the overlay the budget exists to cap. The comment
   * above records the real volume: flashMapForNews() fires "in bursts across load
   * passes (hundreds of calls shortly after load)", and each node lives
   * `durationMs`, so hundreds can coexist with a full 800-marker overlay and the
   * stated whole-overlay ceiling stops being true.
   *
   * A separate bounded exemption rather than a budget group, because a flash is
   * transient decoration on a news item, not a feed the fair-share cap should be
   * sized against: making it compete would let a news burst evict real markers.
   * Newest wins — an old flash is nearly expired anyway, and dropping the newest
   * would hide the item that just arrived.
   */
  private trackFlash(flash: HTMLElement, durationMs: number): void {
    const expire = setTimeout(() => {
      this.activeFlashes.delete(flash);
      flash.remove();
    }, durationMs);
    this.activeFlashes.set(flash, expire);

    while (this.activeFlashes.size > MapComponent.MAX_CONCURRENT_MAP_FLASHES) {
      // Map iteration is insertion-ordered, so this is the oldest live flash.
      const [oldest, oldestTimer] = this.activeFlashes.entries().next().value as [
        HTMLElement,
        ReturnType<typeof setTimeout>,
      ];
      clearTimeout(oldestTimer);
      this.activeFlashes.delete(oldest);
      oldest.remove();
    }
  }

  /** Live news flashes, so a test can prove the ceiling holds. */
  public getActiveFlashCount(): number {
    return this.activeFlashes.size;
  }

  public setView(view: MapView, zoom?: number): void {
    this.state.view = view;

    // Region-specific zoom and pan settings
    // Pan: +x = west, -x = east, +y = north, -y = south
    const viewSettings: Record<MapView, { zoom: number; pan: { x: number; y: number } }> = {
      global: { zoom: 1, pan: { x: 0, y: 0 } },
      america: { zoom: 1.8, pan: { x: 180, y: 30 } },
      mena: { zoom: 3.5, pan: { x: -100, y: 50 } },
      eu: { zoom: 2.4, pan: { x: -30, y: 100 } },
      asia: { zoom: 2.0, pan: { x: -320, y: 40 } },
      latam: { zoom: 2.0, pan: { x: 120, y: -100 } },
      africa: { zoom: 2.2, pan: { x: -40, y: -30 } },
      oceania: { zoom: 2.2, pan: { x: -420, y: -100 } },
    };

    const settings = viewSettings[view];
    this.state.zoom = zoom ?? settings.zoom;
    this.state.pan = settings.pan;
    this.applyTransform();
    this.render();
  }

  private static readonly ASYNC_DATA_LAYERS: Set<keyof MapLayers> = new Set([
    'natural', 'weather', 'outages',
  ]);

  public toggleLayer(layer: keyof MapLayers, source: 'user' | 'programmatic' = 'user'): void {
    if (!this.canToggleLayer(layer, this.state.layers[layer])) return;
    console.log(`[Map.toggleLayer] ${layer}: ${this.state.layers[layer]} -> ${!this.state.layers[layer]}`);
    this.state.layers[layer] = !this.state.layers[layer];
    if (this.state.layers[layer]) {
      const thresholds = MapComponent.LAYER_ZOOM_THRESHOLDS[layer];
      if (thresholds && this.state.zoom < thresholds.minZoom) {
        this.layerZoomOverrides[layer] = true;
      } else {
        delete this.layerZoomOverrides[layer];
      }
    } else {
      delete this.layerZoomOverrides[layer];
    }

    // Qualify with .layer-toggle: the chip is a button inside a
    // `.layer-toggle-row` that carries the SAME data-layer, and an ancestor
    // precedes its descendant in document order — so a bare [data-layer]
    // query returns the row and the chip never leaves its initial state.
    const btn = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    const isEnabled = this.state.layers[layer];
    const isAsyncLayer = MapComponent.ASYNC_DATA_LAYERS.has(layer);

    if (isEnabled && isAsyncLayer) {
      // Async layers: start in loading state, will be set to active when data arrives
      btn?.classList.remove('active');
      btn?.classList.add('loading');
    } else {
      // Static layers or disabling: toggle active immediately
      btn?.classList.toggle('active', isEnabled);
      btn?.classList.remove('loading');
    }

    this.onLayerChange?.(layer, this.state.layers[layer], source);
    // Defer render to next frame to avoid blocking the click handler
    this.scheduleRender();
  }

  public setOnLayerChange(callback: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void {
    this.onLayerChange = callback;
  }

  public hideLayerToggle(layer: keyof MapLayers): void {
    const btn = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (btn) {
      (btn as HTMLElement).style.display = 'none';
    }
  }

  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    const btn = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (btn) {
      btn.classList.toggle('loading', loading);
    }
  }

  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    const btn = this.container.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    if (!btn) return;

    btn.classList.remove('loading');
    if (this.state.layers[layer] && hasData) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }

  public onStateChanged(callback: (state: MapState) => void): void {
    this.onStateChange = callback;
  }

  public zoomIn(): void {
    this.state.zoom = Math.min(this.state.zoom + 0.5, 10);
    this.applyTransform();
    // The on-screen +/- controls are excluded by shouldIgnoreInteractionStart, so a
    // mobile user zooming only via buttons would never arm label thinning otherwise.
    this.resumeMobileLabelVisibility();
  }

  public zoomOut(): void {
    this.state.zoom = Math.max(this.state.zoom - 0.5, 1);
    this.applyTransform();
    this.resumeMobileLabelVisibility();
  }

  public reset(): void {
    this.state.zoom = 1;
    this.state.pan = { x: 0, y: 0 };
    if (this.state.view !== 'global') {
      this.state.view = 'global';
      this.render();
    } else {
      this.applyTransform();
    }
    this.resumeMobileLabelVisibility();
  }

  public triggerPipelineClick(id: string): void {
    const pipeline = PIPELINES.find(p => p.id === id);
    if (!pipeline || pipeline.points.length === 0) return;

    const { width, height } = this.readContainerSize();
    const projection = this.getProjection(width, height);
    const midPoint = pipeline.points[Math.floor(pipeline.points.length / 2)] as [number, number];
    const pos = projection(midPoint);
    if (!pos) return;

    this.popup.show({
      type: 'pipeline',
      data: pipeline,
      x: pos[0],
      y: pos[1],
    });
  }

  public triggerCableClick(id: string): void {
    const cable = UNDERSEA_CABLES.find(c => c.id === id);
    if (!cable || cable.points.length === 0) return;

    const { width, height } = this.readContainerSize();
    const projection = this.getProjection(width, height);
    const midPoint = cable.points[Math.floor(cable.points.length / 2)] as [number, number];
    const pos = projection(midPoint);
    if (!pos) return;

    this.popup.show({
      type: 'cable',
      data: cable,
      x: pos[0],
      y: pos[1],
    });
  }

  public triggerDatacenterClick(id: string): void {
    const dc = AI_DATA_CENTERS.find(d => d.id === id);
    if (!dc) return;

    const { width, height } = this.readContainerSize();
    const projection = this.getProjection(width, height);
    const pos = projection([dc.lon, dc.lat]);
    if (!pos) return;

    this.popup.show({
      type: 'datacenter',
      data: dc,
      x: pos[0],
      y: pos[1],
    });
  }

  public triggerNuclearClick(id: string): void {
    const facility = NUCLEAR_FACILITIES.find(n => n.id === id);
    if (!facility) return;

    const { width, height } = this.readContainerSize();
    const projection = this.getProjection(width, height);
    const pos = projection([facility.lon, facility.lat]);
    if (!pos) return;

    this.popup.show({
      type: 'nuclear',
      data: facility,
      x: pos[0],
      y: pos[1],
    });
  }

  public triggerIrradiatorClick(id: string): void {
    const irradiator = GAMMA_IRRADIATORS.find(i => i.id === id);
    if (!irradiator) return;

    const { width, height } = this.readContainerSize();
    const projection = this.getProjection(width, height);
    const pos = projection([irradiator.lon, irradiator.lat]);
    if (!pos) return;

    this.popup.show({
      type: 'irradiator',
      data: irradiator,
      x: pos[0],
      y: pos[1],
    });
  }

  public enableLayer(layer: keyof MapLayers): void {
    if (!this.canToggleLayer(layer, this.state.layers[layer])) return;
    if (!this.state.layers[layer]) {
      this.state.layers[layer] = true;
      const thresholds = MapComponent.LAYER_ZOOM_THRESHOLDS[layer];
      if (thresholds && this.state.zoom < thresholds.minZoom) {
        this.layerZoomOverrides[layer] = true;
      } else {
        delete this.layerZoomOverrides[layer];
      }
      const btn = document.querySelector(`[data-layer="${layer}"]`);
      btn?.classList.add('active');
      this.onLayerChange?.(layer, true, 'programmatic');
      this.render();
    }
  }

  public highlightAssets(assets: RelatedAsset[] | null): void {
    (Object.keys(this.highlightedAssets) as AssetType[]).forEach((type) => {
      this.highlightedAssets[type].clear();
    });

    if (assets) {
      assets.forEach((asset) => {
        if (asset?.type && this.highlightedAssets[asset.type]) {
          this.highlightedAssets[asset.type].add(asset.id);
        }
      });
    }

    this.render();
  }

  private clampPan(width: number, height: number): void {
    const zoom = this.state.zoom;

    // Allow generous panning - maps should be explorable
    // Scale limits with zoom to allow reaching edges at higher zoom
    const maxPanX = (width / 2) * Math.max(1, zoom * 0.8);
    const maxPanY = (height / 2) * Math.max(1, zoom * 0.8);

    this.state.pan.x = Math.max(-maxPanX, Math.min(maxPanX, this.state.pan.x));
    this.state.pan.y = Math.max(-maxPanY, Math.min(maxPanY, this.state.pan.y));
  }

  private applyTransform(rebuildOnZoomVisibilityChange = true): void {
    const { width, height } = this.getKnownContainerSize();
    this.clampPan(width, height);
    const zoom = this.state.zoom;
    const overlayBudgetViewportChanged = this.overlayBudgetPlanIsStale(width, height);

    // With transform-origin: 0 0, we need to offset to keep center in view
    // Formula: translate first to re-center, then scale
    const centerOffsetX = (width / 2) * (1 - zoom);
    const centerOffsetY = (height / 2) * (1 - zoom);
    const tx = centerOffsetX + this.state.pan.x * zoom;
    const ty = centerOffsetY + this.state.pan.y * zoom;

    this.wrapper.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;

    // Set CSS variable for counter-scaling labels/markers
    // Labels: max 1.5x scale, so counter-scale = min(1.5, zoom) / zoom
    // Markers: fixed size, so counter-scale = 1 / zoom
    // #5080 slice 2: write the vars ONLY when zoom actually changed.
    // applyTransform() also runs on every render/data pass at unchanged zoom,
    // and each setProperty — even with an identical value — invalidates every
    // var() consumer: invalidation tracking measured thousands of per-marker
    // style recalcs in a single tap window (earthquake-marker 4356,
    // hotspot-marker 1694, conflict-zone 1210) — the dominant mobile tap
    // presentation cost.
    const overlayVarZoom = zoom.toFixed(4);
    if (this.lastOverlayVarZoom !== overlayVarZoom) {
      this.lastOverlayVarZoom = overlayVarZoom;
      const labelScale = Math.min(1.5, zoom) / zoom;
      const markerScale = 1 / zoom;
      this.wrapper.style.setProperty('--label-scale', String(labelScale));
      this.wrapper.style.setProperty('--marker-scale', String(markerScale));
      this.wrapper.style.setProperty('--zoom', String(zoom));
    }

    // Smart label hiding based on zoom level and overlap
    if (this.shouldUpdateLabelVisibility()) this.updateLabelVisibility(zoom);
    const zoomVisibilityChanged = this.updateZoomLayerVisibility();
    this.emitStateChange();
    if (rebuildOnZoomVisibilityChange && zoomVisibilityChanged) {
      this.scheduleRender();
    } else if (overlayBudgetViewportChanged) {
      this.scheduleOverlayBudgetReplan();
    }
  }

  /**
   * Re-plan the overlay budget once the view stops moving (#7112).
   *
   * applyTransform() runs on every mousemove/touchmove/wheel and on each frame
   * of the touch-inertia loop. Re-planning from there directly would put a full
   * renderDynamicLayers() pass — which wipes and rebuilds cables, pipelines,
   * conflicts, AIS density, clusters AND every overlay marker with a fresh
   * click listener — on the interaction path at up to 1000/MIN_RENDER_INTERVAL_MS
   * per second, where a pan used to be a pure CSS transform with no DOM work at
   * all. It would also re-arm armMarkerSettle() continuously, holding every
   * marker in the infinite-pulse state (and its compositing layer, #4669) for
   * the whole gesture.
   *
   * So coalesce to the settle instead, which is what GlobeMap does by re-selecting
   * on the controls 'end' event rather than during the drag. The markers on
   * screen stay correct for the pre-gesture POV while the finger is down and
   * are re-ranked once, when the user stops.
   */
  private scheduleOverlayBudgetReplan(): void {
    if (this.overlayBudgetReplanTimer !== null) clearTimeout(this.overlayBudgetReplanTimer);
    this.overlayBudgetReplanTimer = setTimeout(() => {
      this.overlayBudgetReplanTimer = null;
      if (this.destroyed) return;
      // Re-test rather than firing unconditionally. A render triggered by
      // anything else during the settle window — every setX() data setter calls
      // render(), and feeds stream continuously — has already re-planned for the
      // current viewport, so the plan is no longer stale and this timer would
      // schedule a second full renderDynamicLayers() pass that cannot change a
      // marker. That duplicate is the exact churn this debounce exists to remove.
      const { width, height } = this.getKnownContainerSize();
      if (!this.overlayBudgetPlanIsStale(width, height)) return;
      this.scheduleRender();
    }, MapComponent.OVERLAY_BUDGET_REPLAN_SETTLE_MS);
  }

  /**
   * True when the stored budget plan was computed for a different viewport than
   * the current one, AND re-planning could actually change what is drawn.
   *
   * The truncation test is the load-bearing half: with nothing withheld the
   * selection is view-independent, so a rebuild cannot change a single marker and
   * would be pure churn on the very path this feature exists to make cheaper.
   * Same guard, and same reason, as GlobeMap.reselectMarkersForViewport.
   */
  private overlayBudgetPlanIsStale(width: number, height: number): boolean {
    return (
      this.initialDynamicRendered &&
      Object.keys(this.overlayMarkerTruncation).length > 0 &&
      (this.lastOverlayBudgetViewport.width !== width ||
        this.lastOverlayBudgetViewport.height !== height ||
        this.lastOverlayBudgetViewport.zoom !== this.state.zoom ||
        this.lastOverlayBudgetViewport.panX !== this.state.pan.x ||
        this.lastOverlayBudgetViewport.panY !== this.state.pan.y)
    );
  }

  private shouldUpdateLabelVisibility(): boolean {
    return !this.isMobile || this.mobileLabelVisibilityArmed;
  }

  private resumeMobileLabelVisibility(): void {
    if (!this.isMobile || this.mobileLabelVisibilityArmed) return;
    this.mobileLabelVisibilityArmed = true;
    this.updateLabelVisibility(this.state.zoom);
  }

  private updateZoomLayerVisibility(): boolean {
    const zoom = this.state.zoom;
    let visibilityChanged = false;
    (Object.keys(MapComponent.LAYER_ZOOM_THRESHOLDS) as (keyof MapLayers)[]).forEach((layer) => {
      const thresholds = MapComponent.LAYER_ZOOM_THRESHOLDS[layer];
      if (!thresholds) return;

      const enabled = this.state.layers[layer];
      const override = Boolean(this.layerZoomOverrides[layer]);
      const isVisible = enabled && (override || zoom >= thresholds.minZoom);
      const labelZoom = thresholds.showLabels ?? thresholds.minZoom;
      const labelsVisible = enabled && zoom >= labelZoom;
      const hiddenAttr = `data-layer-hidden-${layer}`;
      const labelsHiddenAttr = `data-labels-hidden-${layer}`;
      const wasVisible = !this.wrapper.hasAttribute(hiddenAttr);

      const affectsSvgMarkerDom = MapComponent.SVG_MARKER_DOM_ZOOM_LAYERS.has(layer);
      if (affectsSvgMarkerDom && wasVisible !== isVisible) visibilityChanged = true;

      if (isVisible) {
        this.wrapper.removeAttribute(hiddenAttr);
      } else {
        this.wrapper.setAttribute(hiddenAttr, 'true');
      }

      if (labelsVisible) {
        this.wrapper.removeAttribute(labelsHiddenAttr);
      } else {
        this.wrapper.setAttribute(labelsHiddenAttr, 'true');
      }

      const btn = document.querySelector(`[data-layer="${layer}"]`);
      const autoHidden = enabled && !override && zoom < thresholds.minZoom;
      btn?.classList.toggle('auto-hidden', autoHidden);
    });
    return visibilityChanged;
  }

  private emitStateChange(): void {
    this.onStateChange?.(this.getState());
  }

  private updateLabelVisibility(zoom: number): void {
    this.pendingLabelVisibilityZoom = zoom;
    if (this.labelVisibilityScheduled) return;
    this.labelVisibilityScheduled = true;

    measure(() => {
      const measuredZoom = this.pendingLabelVisibilityZoom;
      const labelRects = this.measureLabelVisibility();
      mutate(() => {
        this.labelVisibilityScheduled = false;
        if (this.destroyed) return;
        this.applyLabelVisibility(labelRects, measuredZoom);
        if (this.pendingLabelVisibilityZoom !== measuredZoom) this.updateLabelVisibility(this.pendingLabelVisibilityZoom);
      });
    });
  }

  private measureLabelVisibility(): { el: HTMLElement; rect: DOMRect; priority: number }[] {
    const labels = this.overlays.querySelectorAll('.earthquake-label, .weather-label');
    const labelRects: { el: HTMLElement; rect: DOMRect; priority: number }[] = [];

    labels.forEach((label) => {
      const el = label as HTMLElement;
      const parent = el.closest('.earthquake-marker, .weather-marker');

      let priority = 1;
      if (parent?.classList.contains('earthquake-marker')) {
        priority = 4;
      } else if (parent?.classList.contains('weather-marker')) {
        if (parent.classList.contains('extreme')) priority = 5;
        else if (parent.classList.contains('severe')) priority = 4;
        else priority = 2;
      }

      labelRects.push({ el, rect: el.getBoundingClientRect(), priority });
    });

    return labelRects;
  }

  private applyLabelVisibility(labelRects: { el: HTMLElement; rect: DOMRect; priority: number }[], zoom: number): void {
    labelRects.sort((a, b) => b.priority - a.priority);

    const visibleRects: DOMRect[] = [];
    const minDistance = 30 / zoom;

    labelRects.forEach(({ el, rect, priority }) => {
      const overlaps = visibleRects.some((vr) => {
        const dx = Math.abs((rect.left + rect.width / 2) - (vr.left + vr.width / 2));
        const dy = Math.abs((rect.top + rect.height / 2) - (vr.top + vr.height / 2));
        return dx < (rect.width + vr.width) / 2 + minDistance &&
          dy < (rect.height + vr.height) / 2 + minDistance;
      });

      if (overlaps && zoom < 2) {
        el.style.opacity = priority >= 4 ? '0.7' : '0';
      } else {
        el.style.opacity = '1';
        visibleRects.push(rect);
      }
    });
  }

  public setOnNewsClick(callback: (item: Pick<NewsLocationMarker, 'article' | 'title'>) => void): void {
    this.onNewsClick = callback;
  }

  public onTimeRangeChanged(callback: (range: TimeRange) => void): void {
    this.onTimeRangeChange = callback;
  }

  public setOnCountryClick(cb: (country: CountryClickPayload) => void): void {
    this.onCountryClick = cb;
  }

  public fitCountry(code: string): void {
    const bbox = getCountryBbox(code);
    if (!bbox) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const midLon = (minLon + maxLon) / 2;
    const midLat = (minLat + maxLat) / 2;
    const { width, height } = this.readContainerSize();
    const projection = this.getProjection(width, height);
    const topLeft = projection([minLon, maxLat]);
    const bottomRight = projection([maxLon, minLat]);
    if (!topLeft || !bottomRight) {
      this.state.zoom = 4;
      this.setCenter(midLat, midLon);
      this.resumeMobileLabelVisibility();
      return;
    }
    const pxWidth = Math.abs(bottomRight[0] - topLeft[0]);
    const pxHeight = Math.abs(bottomRight[1] - topLeft[1]);
    const padFactor = 0.8;
    const zoomX = pxWidth > 0 ? (width * padFactor) / pxWidth : 4;
    const zoomY = pxHeight > 0 ? (height * padFactor) / pxHeight : 4;
    this.state.zoom = Math.max(1, Math.min(8, Math.min(zoomX, zoomY)));
    this.setCenter(midLat, midLon);
    this.resumeMobileLabelVisibility();
  }

  public getState(): MapState {
    return { ...this.state };
  }

  public getCenter(): { lat: number; lon: number } | null {
    const { width, height } = this.readContainerSize();
    const projection = this.getProjection(width, height);
    if (!projection.invert) return null;
    const coords = projection.invert(
      projectionPointAtScreenCentre(width, height, this.state.pan),
    );
    // A 0x0 container (hidden or not yet laid out) makes getProjection scale 0,
    // and d3 then inverts to [NaN, NaN] rather than null (#7660).
    if (!coords || !Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return null;
    return { lon: coords[0], lat: coords[1] };
  }

  public getTimeRange(): TimeRange {
    return this.state.timeRange;
  }

  public setZoom(zoom: number): void {
    this.state.zoom = Math.max(1, Math.min(10, zoom));
    this.applyTransform();
    // Ensure base layer is intact after zoom change
    this.ensureBaseLayerIntact();
  }

  private ensureBaseLayerIntact(): void {
    // Query DOM directly instead of relying on cached d3 selection
    const svgNode = this.svg.node();
    const domBaseGroup = svgNode?.querySelector('.map-base');
    const selectionNode = this.baseLayerGroup?.node();

    // Check for stale selection (d3 reference doesn't match DOM)
    if (domBaseGroup && selectionNode !== domBaseGroup) {
      console.warn('[Map] Stale base layer selection detected, forcing full rebuild');
      this.baseRendered = false;
      this.render();
      return;
    }

    // Check for missing countries
    const countryCount = domBaseGroup?.querySelectorAll('.country').length ?? 0;
    if (countryCount === 0 && this.countryFeatures && this.countryFeatures.length > 0) {
      console.warn('[Map] Base layer missing countries, triggering recovery render');
      this.baseRendered = false;
      this.render();
    }
  }

  public setCenter(lat: number, lon: number): void {
    console.log('[Map] setCenter called:', { lat, lon });
    const { width, height } = this.readContainerSize();
    const projection = this.getProjection(width, height);
    const pos = projection([lon, lat]);
    console.log('[Map] projected pos:', pos, 'container:', { width, height }, 'zoom:', this.state.zoom);
    if (!pos) return;
    // Pan formula: after applyTransform() computes tx = centerOffset + pan*zoom,
    // and transform is translate(tx,ty) scale(zoom), to center on pos:
    // pos*zoom + tx = width/2 → tx = width/2 - pos*zoom
    // Solving: (width/2)(1-zoom) + pan*zoom = width/2 - pos*zoom
    // → pan = width/2 - pos (independent of zoom)
    this.state.pan = {
      x: width / 2 - pos[0],
      y: height / 2 - pos[1],
    };
    this.applyTransform();
    // Ensure base layer is intact after pan
    this.ensureBaseLayerIntact();
  }

  public setLayers(layers: MapLayers): void {
    this.state.layers = { ...layers };
    this.syncLayerButtons();
    this.render();
  }

  public setEarthquakes(earthquakes: Earthquake[], options: { replaceEmpty?: boolean } = {}): void {
    console.log('[Map] setEarthquakes called with', earthquakes.length, 'earthquakes');
    if (options.replaceEmpty || earthquakes.length > 0 || this.earthquakes.length === 0) {
      this.earthquakes = earthquakes;
    } else {
      console.log('[Map] Keeping existing', this.earthquakes.length, 'earthquakes (new data was empty)');
    }
    this.render();
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.weatherAlerts = alerts;
    this.render();
  }

  public setRadiationObservations(observations: RadiationObservation[]): void {
    this.radiationObservations = observations;
    this.render();
  }

  public setOutages(outages: InternetOutage[]): void {
    this.outages = outages;
    this.render();
  }

  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    this.cableAdvisories = advisories;
    this.repairShips = repairShips;
    this.popup.setCableActivity(advisories, repairShips);
    this.render();
  }

  public setCableHealth(healthMap: Record<string, CableHealthRecord>): void {
    this.healthByCableId = healthMap;
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

  public setWebcams(markers: Array<WebcamEntry | WebcamCluster>): void {
    this.webcamData = markers;
    this.render();
  }

  public setNewsLocations(data: NewsLocationMarker[]): void {
    this.newsLocations = data;
    this.render();
  }

  private getCableAdvisory(cableId: string): CableAdvisory | undefined {
    const advisories = this.cableAdvisories.filter((advisory) => advisory.cableId === cableId);
    return advisories.reduce<CableAdvisory | undefined>((latest, advisory) => {
      if (!latest) return advisory;
      return advisory.reported.getTime() > latest.reported.getTime() ? advisory : latest;
    }, undefined);
  }

  private getCableName(cableId: string): string {
    return UNDERSEA_CABLES.find((cable) => cable.id === cableId)?.name || cableId;
  }
}
