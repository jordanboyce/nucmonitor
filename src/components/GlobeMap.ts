/**
 * GlobeMap - 3D interactive globe using globe.gl
 *
 * Matches World Monitor's MapContainer API so it can be used as a drop-in
 * replacement within MapContainer when the user enables globe mode.
 *
 * Architecture mirrors Sentinel (sentinel.axonia.us):
 *  - globe.gl v2 (new Globe(element, config))
 *  - Earth texture: /textures/earth-topo-bathy.jpg
 *  - Night sky background: /textures/night-sky.png
 *  - Specular/water map: /textures/earth-water.png
 *  - Atmosphere: #4466cc glow via built-in Fresnel shader
 *  - All markers via htmlElementsData (single merged array with _kind discriminator)
 *  - Auto-rotate after 60 s of inactivity
 */

import Globe from 'globe.gl';
import { isDesktopRuntime } from '@/services/runtime';
import type { NewsLocationMarker as NewsLocationInput } from '@/types';
import type { GlobeInstance, ConfigOptions } from 'globe.gl';
import { NUCLEAR_FACILITIES, UNDERSEA_CABLES } from '@/config/geo-map';
import { PIPELINES } from '@/config/pipelines';
import { t } from '@/services/i18n';
import { SITE_VARIANT } from '@/config/variant';
import { getGlobeRenderScale, resolveGlobePixelRatio, resolvePerformanceProfile, subscribeGlobeRenderScaleChange, getGlobeTexture, GLOBE_TEXTURE_URLS, subscribeGlobeTextureChange, getGlobeVisualPreset, subscribeGlobeVisualPresetChange, type GlobeRenderScale, type GlobePerformanceProfile, type GlobeVisualPreset } from '@/services/globe-render-settings';
import {
  getLayerExplanation,
  getLayersForVariant,
  hasCuratedLayerExplanation,
  resolveLayerLabel,
  bindLayerSearch,
} from '@/config/map-layer-definitions';
import { renderLayerExplanationCard } from '@/utils/layer-explanation-card';
import { guardOrbitControlsPointerTracking } from '@/utils/orbit-controls-pointer-guard';
import { getAuthState } from '@/services/auth-state';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { getCountryBbox } from '@/services/country-geometry';
import { escapeHtml } from '@/utils/sanitize';
import { corroborationLabelHtml } from '@/utils/corroboration-flag';
import { showLayerWarning } from '@/utils/layer-warning';
import { isMobileDevice } from '@/utils';
import { setGlobeMarkerLoad } from '@/bootstrap/globe-marker-probe';
import {
  GLOBE_MARKER_BUDGET_DESKTOP,
  GLOBE_MARKER_BUDGET_MOBILE,
  proximityRank,
  selectGlobeMarkers,
  type GlobeLayerTruncation,
  type GlobeMarkerGroup,
} from '@/utils/globe-marker-budget';
import { renderLayerTruncationBadges } from '@/utils/layer-truncation-badge';
import type { MapLayers, NaturalEvent, InternetOutage, GammaIrradiator, AIDataCenter, UnderseaCable, Pipeline, CableAdvisory, RepairShip } from '@/types';
import type { Earthquake } from '@/services/earthquakes';
import { MapPopup } from './MapPopup';
import type { MapContainerState, MapView, TimeRange } from './MapContainer';
import type { CountryClickPayload } from './DeckGLMap';
import type { WeatherAlert } from '@/services/weather';
import type { ClimateAnomaly } from '@/services/climate';
import { getCategoryStyle } from '@/services/webcams';
import { pinWebcam, isPinned } from '@/services/webcams/pinned-store';
import type { WebcamEntry, WebcamCluster } from '@/generated/client/worldmonitor/webcam/v1/service_client';
import type { TrafficAnomaly as ProtoTrafficAnomaly, DdosLocationHit } from '@/generated/client/worldmonitor/infrastructure/v1/service_client';
import type { RadiationObservation } from '@/services/radiation';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import {
  applyPremiumLayerPresentation,
  getPremiumLayerPresentation,
  PremiumLayerGate,
} from './premium-layer-gate';
import { globeAltitudeToMapZoom, mapZoomToGlobeAltitude } from '@/utils/globe-zoom';

export interface GlobeMapOptions {
  onInitError?: (error: unknown) => void;
  chrome?: boolean;
}


function saveWebcamMarkerMode(mode: string): void {
  try {
    localStorage.setItem('wm-webcam-marker-mode', mode);
  } catch {
    // The in-memory marker mode still applies for the current session.
  }
}
// ─── Marker discriminated union ─────────────────────────────────────────────
interface BaseMarker {
  _kind: string;
  _lat: number;
  _lng: number;
}
interface WeatherMarker extends BaseMarker {
  _kind: 'weather';
  id: string;
  severity: string;
  headline: string;
}
interface NaturalMarker extends BaseMarker {
  _kind: 'natural';
  id: string;
  category: string;
  title: string;
}
interface OutageMarker extends BaseMarker {
  _kind: 'outage';
  id: string;
  title: string;
  severity: string;
  country: string;
}
interface TrafficAnomalyMarker extends BaseMarker {
  _kind: 'trafficAnomaly';
  id: string;
  type: string;
  locationName: string;
}
interface DdosHitMarker extends BaseMarker {
  _kind: 'ddosHit';
  id: string;
  countryName: string;
  percentage: number;
}
interface FireMarker extends BaseMarker {
  _kind: 'fire';
  id: string;
  region: string;
  brightness: number;
}
interface ClimateMarker extends BaseMarker {
  _kind: 'climate';
  id: string;
  zone: string;
  type: string;
  severity: string;
  tempDelta: number;
}
interface NuclearSiteMarker extends BaseMarker {
  _kind: 'nuclearSite';
  id: string;
  name: string;
  type: string;
  status: string;
  operationalSince?: string;
  treaties?: string[];
  iaeaStatus?: string;
  keyEvents?: string[];
}
interface IrradiatorSiteMarker extends BaseMarker {
  _kind: 'irradiator';
  id: string;
  city: string;
  country: string;
}
interface EarthquakeMarker extends BaseMarker {
  _kind: 'earthquake';
  id: string;
  place: string;
  magnitude: number;
}
interface RadiationMarker extends BaseMarker {
  _kind: 'radiation';
  id: string;
  location: string;
  country: string;
  source: RadiationObservation['source'];
  contributingSources: RadiationObservation['contributingSources'];
  value: number;
  unit: string;
  observedAt: Date;
  freshness: RadiationObservation['freshness'];
  baselineValue: number;
  delta: number;
  zScore: number;
  severity: 'normal' | 'elevated' | 'spike';
  confidence: RadiationObservation['confidence'];
  corroborated: boolean;
  conflictingSources: boolean;
  convertedFromCpm: boolean;
  sourceCount: number;
}
interface DatacenterMarker extends BaseMarker {
  _kind: 'datacenter';
  id: string;
  name: string;
  owner: string;
  country: string;
  chipType: string;
}
interface NewsLocationMarker extends BaseMarker {
  _kind: 'newsLocation';
  id: string;
  article?: NewsLocationInput['article'];
  title: string;
  threatLevel: string;
  corroboration?: NewsLocationInput['corroboration'];
}
interface FlashMarker extends BaseMarker {
  _kind: 'flash';
  id: string;
}
interface CableAdvisoryMarker extends BaseMarker {
  _kind: 'cableAdvisory';
  id: string;
  cableId: string;
  title: string;
  severity: string;
  impact: string;
  repairEta: string;
}
interface RepairShipMarker extends BaseMarker {
  _kind: 'repairShip';
  id: string;
  name: string;
  status: string;
  eta: string;
  operator: string;
}
interface WebcamMarkerData extends BaseMarker {
  _kind: 'webcam';
  webcamId: string;
  title: string;
  category: string;
  country: string;
}
interface WebcamClusterData extends BaseMarker {
  _kind: 'webcam-cluster';
  count: number;
  categories: string[];
}
interface GlobePath {
  id: string;
  name: string;
  points: number[][];
  pathType: 'cable' | 'oil' | 'gas' | 'products' | 'stormTrack' | 'stormHistory';
  status: string;
  windKt?: number;
}
interface GlobePolygon {
  coords: number[][][];
  name: string;
  _kind: 'forecastCone';
}
type GlobeMarker =
  | WeatherMarker | NaturalMarker | OutageMarker | TrafficAnomalyMarker | DdosHitMarker
  | FireMarker | ClimateMarker | NuclearSiteMarker | IrradiatorSiteMarker
  | EarthquakeMarker | RadiationMarker | DatacenterMarker
  | CableAdvisoryMarker | RepairShipMarker
  | NewsLocationMarker | FlashMarker
  | WebcamMarkerData | WebcamClusterData;

interface GlobeControlsLike {
  autoRotate: boolean;
  autoRotateSpeed: number;
  enablePan: boolean;
  enableZoom: boolean;
  zoomSpeed: number;
  minDistance: number;
  maxDistance: number;
  enableDamping: boolean;
  update(): boolean;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

// Duration (ms) of the globe.gl pointOfView rotation used by programmatic
// viewport moves. Shared so settlement callers stay in lockstep with the
// animation.
const SET_CENTER_ROTATION_MS = 1200;

export class GlobeMap {
  private container: HTMLElement;
  private globe: GlobeInstance | null = null;
  private initPromise: Promise<void> = Promise.resolve();
  private unsubscribeGlobeQuality: (() => void) | null = null;
  private unsubscribeGlobeTexture: (() => void) | null = null;
  private unsubscribeVisualPreset: (() => void) | null = null;
  private premiumLayerGate: PremiumLayerGate | null = null;
  private pendingPremiumLayerChanges = new Set<keyof MapLayers>();
  private savedDefaultMaterial: any = null;
  private controls: GlobeControlsLike | null = null;
  private renderPaused = false;
  private outerGlow: any = null;
  private innerGlow: any = null;
  private starField: any = null;
  private cyanLight: any = null;
  private extrasAnimFrameId: number | null = null;
  private pendingFlushWhilePaused = false;
  private controlsAutoRotateBeforePause: boolean | null = null;
  private controlsDampingBeforePause: boolean | null = null;

  private initialized = false;
  private destroyed = false;
  private webglLost = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushMaxTimer: ReturnType<typeof setTimeout> | null = null;
  private _pulseEnabled = true;

  // Idle rendering: pause globe animation when nothing changes
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private isGlobeAnimating = true;
  private visibilityHandler: (() => void) | null = null;

  // Current data
  private popup: MapPopup | null = null;
  private weatherMarkers: WeatherMarker[] = [];
  private naturalMarkers: NaturalMarker[] = [];
  private outageMarkers: OutageMarker[] = [];
  private trafficAnomalyMarkers: TrafficAnomalyMarker[] = [];
  private ddosMarkers: DdosHitMarker[] = [];
  private fireMarkers: FireMarker[] = [];
  private climateMarkers: ClimateMarker[] = [];
  private nuclearSiteMarkers: NuclearSiteMarker[] = [];
  private irradiatorSiteMarkers: IrradiatorSiteMarker[] = [];
  private earthquakeMarkers: EarthquakeMarker[] = [];
  private radiationMarkers: RadiationMarker[] = [];
  private datacenterMarkers: DatacenterMarker[] = [];
  private newsLocationMarkers: NewsLocationMarker[] = [];
  private flashMarkers: FlashMarker[] = [];
  private cableAdvisoryMarkers: CableAdvisoryMarker[] = [];
  private repairShipMarkers: RepairShipMarker[] = [];
  private stormTrackPaths: GlobePath[] = [];
  private stormConePolygons: GlobePolygon[] = [];
  private webcamMarkers: (WebcamMarkerData | WebcamClusterData)[] = [];
  /** Layers the marker budget is currently withholding markers from (#5368). */
  private markerTruncation: Record<string, GlobeLayerTruncation> = {};
  /** HTML markers handed to globe.gl on the last flush — the per-frame cost driver. */
  private renderedMarkerCount = 0;
  private markerBudgetProfile: 'mobile' | 'desktop' = 'desktop';
  private webcamMarkerMode: string = (() => {
    try {
      return localStorage.getItem('wm-webcam-marker-mode') || 'icon';
    } catch {
      return 'icon';
    }
  })();
  private controlsEndHandler: (() => void) | null = null;
  private controlsStartHandler: (() => void) | null = null;
  private globePaths: GlobePath[] = [];
  private cableFaultIds = new Set<string>();
  private cableDegradedIds = new Set<string>();

  // Current layers state
  private layers: MapLayers;
  private timeRange: TimeRange;
  private currentView: MapView = 'global';

  // Click callbacks
  private onNewsClick?: (item: Pick<NewsLocationInput, 'article' | 'title'>) => void;

  // Auto-rotate timer (like Sentinel: resume after 60 s idle)
  private autoRotateTimer: ReturnType<typeof setTimeout> | null = null;

  // Overlay UI elements
  private layerTogglesEl: HTMLElement | null = null;
  private tooltipEl: HTMLElement | null = null;
  private tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly chrome: boolean;

  // Callbacks
  private onLayerChangeCb: ((layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void) | null = null;
  private onStateChangeCb: ((state: MapContainerState) => void) | null = null;
  private viewportSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private viewportAnimationFrame: number | null = null;
  private viewportSettledPromise: Promise<boolean> = Promise.resolve(true);
  private resolveViewportSettled: ((completed: boolean) => void) | null = null;
  private viewportTarget: { lat: number; lng: number; altitude: number } | null = null;
  private viewportSettleDeadline = 0;
  private viewportAutoRotateBeforeMove: boolean | null = null;
  private viewportMovementGeneration = 0;
  private onMapContextMenuCb?: (payload: { lat: number; lon: number; screenX: number; screenY: number }) => void;
  private readonly handleContextMenu = (e: MouseEvent): void => {
    e.preventDefault();
    if (!this.onMapContextMenuCb || !this.globe) return;
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const coords = this.globe.toGlobeCoords(x, y);
    if (!coords) return;
    this.onMapContextMenuCb({ lat: coords.lat, lon: coords.lng, screenX: e.clientX, screenY: e.clientY });
  };

  constructor(container: HTMLElement, initialState: MapContainerState, options: GlobeMapOptions = {}) {
    this.container = container;
    this.chrome = options.chrome ?? true;
    this.popup = new MapPopup(this.container);
    this.layers = { ...initialState.layers };
    this.timeRange = initialState.timeRange;
    this.currentView = initialState.view;

    this.container.classList.add('globe-mode');
    this.container.style.cssText = 'width:100%;height:100%;background:#000;position:relative;';

    this.initPromise = this.initGlobe();
    this.initPromise.catch(err => {
      console.error('[GlobeMap] Init failed:', err);
      options.onInitError?.(err);
    });
  }

  // Resolves once initGlobe() has finished (this.globe is set on success). Lets
  // callers defer work that needs the globe — e.g. a replayed deep link —
  // instead of dropping it during the async init window.
  public whenReady(): Promise<void> {
    return this.initPromise;
  }

  private async initGlobe(): Promise<void> {
    if (this.destroyed) return;

    const desktop = isDesktopRuntime();
    const initialScale = getGlobeRenderScale();
    const initialPixelRatio = desktop
      ? Math.min(resolveGlobePixelRatio(initialScale), 1.25)
      : resolveGlobePixelRatio(initialScale);
    const config: ConfigOptions = {
      animateIn: false,
      rendererConfig: {
        // Desktop (Tauri/WebView2) can fall back to software rendering on some machines.
        // Keep defaults conservative to avoid 1fps reports (see #930).
        powerPreference: desktop ? 'high-performance' : 'default',
        logarithmicDepthBuffer: !desktop,
        antialias: initialPixelRatio > 1,
      },
    };

    const globe = new Globe(this.container, config) as GlobeInstance;

    if (this.destroyed) {
      globe._destructor();
      return;
    }

    this.unsubscribeGlobeQuality?.();
    this.unsubscribeGlobeQuality = subscribeGlobeRenderScaleChange((scale) => {
      this.applyRenderQuality(scale);
      this.applyPerformanceProfile(resolvePerformanceProfile(scale));
    });

    // Initial sizing: use container dimensions, fall back to window if not yet laid out
    const initW = this.container.clientWidth || window.innerWidth;
    const initH = this.container.clientHeight || window.innerHeight;

    const initialTexture = getGlobeTexture();
    globe
      .globeImageUrl(GLOBE_TEXTURE_URLS[initialTexture])
      .backgroundImageUrl('')
      .atmosphereColor('#4466cc')
      .atmosphereAltitude(0.18)
      .width(initW)
      .height(initH)
      .pathTransitionDuration(0);

    // Orbit controls — match Sentinel's settings
    const controls = globe.controls() as GlobeControlsLike;
    this.controls = controls;
    // three r183 OrbitControls only position-tracks touch pointers but reads the
    // surviving/second pointer's position in mixed mouse|pen + touch gestures —
    // crashes reading undefined.x on touchscreen laptops (WORLDMONITOR-QD).
    guardOrbitControlsPointerTracking(controls);
    controls.autoRotate = !desktop;
    controls.autoRotateSpeed = 0.3;
    controls.enablePan = false;
    controls.enableZoom = true;
    controls.zoomSpeed = 1.4;
    controls.minDistance = 101;
    controls.maxDistance = 600;
    controls.enableDamping = !desktop;

    this.controlsStartHandler = () => {
      if (this.viewportTarget) this.settleViewportMovement(false);
    };
    controls.addEventListener('start', this.controlsStartHandler);
    this.controlsEndHandler = () => {
      // Snapshot before publishing state: a synchronous subscriber can start a
      // newer movement, and this old event must never settle that generation.
      const viewportMovementGeneration = this.viewportTarget
        ? this.viewportMovementGeneration
        : null;
      // Truncated layers are ranked by nearness to the camera, so the visible
      // subset is only correct for the POV it was computed at. Re-select when
      // the camera settles — that is what makes "rotate or zoom to bring others
      // in" true rather than a promise the badge cannot keep (#5368).
      this.reselectMarkersForViewport();
      this.onStateChangeCb?.(this.getState());
      if (viewportMovementGeneration !== null) {
        queueMicrotask(() => {
          this.trySettleViewportMovement(true, viewportMovementGeneration);
        });
      }
    };
    controls.addEventListener('end', this.controlsEndHandler);

    // Force the canvas to visually fill the container so it expands with CSS transitions.
    // globe.gl sets explicit width/height attributes; we override the CSS so the canvas
    // always covers the full container even before the next renderer resize fires.
    const glCanvas = this.container.querySelector('canvas');
    if (glCanvas) {
      (glCanvas as HTMLElement).style.cssText =
        'position:absolute;top:0;left:0;width:100% !important;height:100% !important;';
    }

    // Globe attribution (texture + OpenStreetMap data)
    const attribution = document.createElement('div');
    attribution.className = 'map-attribution';
    setTrustedHtml(attribution, trustedHtml('© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> © <a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a>', "legacy direct innerHTML migration"));
    this.container.appendChild(attribution);

    // Upgrade material to MeshStandardMaterial + add scene enhancements
    // Save default material for classic preset restoration
    this.savedDefaultMaterial = globe.globeMaterial();

    // Apply visual enhancements based on preset
    const initialPreset = getGlobeVisualPreset();
    if (initialPreset === 'enhanced') {
      setTimeout(() => this.applyEnhancedVisuals(), 800);
    }

    this.unsubscribeVisualPreset = subscribeGlobeVisualPresetChange((preset) => {
      this.applyVisualPreset(preset);
    });

    // Subscribe to texture changes (kept as-is)
    this.unsubscribeGlobeTexture = subscribeGlobeTextureChange((texture) => {
      if (this.globe) this.globe.globeImageUrl(GLOBE_TEXTURE_URLS[texture]);
    });

    // Pause auto-rotate on user interaction; resume after 60 s idle (like Sentinel)
    const pauseAutoRotate = () => {
      if (this.renderPaused) return;
      // A user gesture during a tracked camera move owns the post-move state:
      // do not restore the auto-rotation that was active before the tween.
      if (this.viewportAutoRotateBeforeMove !== null) {
        this.viewportAutoRotateBeforeMove = false;
      }
      controls.autoRotate = false;
      if (this.autoRotateTimer) clearTimeout(this.autoRotateTimer);
    };
    const scheduleResumeAutoRotate = () => {
      if (this.renderPaused) return;
      if (this.autoRotateTimer) clearTimeout(this.autoRotateTimer);
      this.autoRotateTimer = setTimeout(() => {
        if (this.renderPaused) return;
        if (this.viewportAutoRotateBeforeMove !== null) {
          this.viewportAutoRotateBeforeMove = !desktop;
        } else {
          controls.autoRotate = !desktop;
        }
      }, 60_000);
    };

    const canvas = this.container.querySelector('canvas');
    if (canvas) {
      // Wake globe on any user interaction (idle rendering optimization)
      const wakeOnInteraction = () => this.wakeGlobe();
      canvas.addEventListener('mousedown', () => { pauseAutoRotate(); wakeOnInteraction(); });
      canvas.addEventListener('touchstart', () => { pauseAutoRotate(); wakeOnInteraction(); }, { passive: true });
      canvas.addEventListener('wheel', wakeOnInteraction, { passive: true });
      let lastMoveWake = 0;
      canvas.addEventListener('mousemove', () => {
        const now = performance.now();
        if (now - lastMoveWake > 500) { lastMoveWake = now; wakeOnInteraction(); }
      }, { passive: true });
      canvas.addEventListener('mouseup', scheduleResumeAutoRotate);
      canvas.addEventListener('touchend', scheduleResumeAutoRotate);
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.webglLost = true;
        console.warn('[GlobeMap] WebGL context lost — will restore when browser recovers');
      });
      canvas.addEventListener('webglcontextrestored', () => {
        this.webglLost = false;
        console.info('[GlobeMap] WebGL context restored');
        this.flushMarkers();
      });
    }

    this.container.addEventListener('contextmenu', this.handleContextMenu);

    // Wire HTML marker layer
    globe
      .htmlElementsData([])
      .htmlLat((d: object) => (d as GlobeMarker)._lat)
      .htmlLng((d: object) => (d as GlobeMarker)._lng)
      .htmlAltitude(() => 0.003)
      .htmlElement((d: object) => this.buildMarkerElement(d as GlobeMarker));

    // Path accessors — set once
    (globe as any)
      .pathPoints((d: GlobePath) => d?.points ?? [])
      .pathPointLat((p: number[]) => p[1])
      .pathPointLng((p: number[]) => p[0])
      .pathPointAlt(() => 0)
      .pathColor((d: GlobePath) => {
        if (!d) return 'rgba(180,160,255,0.6)';
        if (d.pathType === 'cable') {
          if (this.cableFaultIds.has(d.id))    return '#ff3030';
          if (this.cableDegradedIds.has(d.id)) return '#ff8800';
          return 'rgba(0,200,255,0.65)';
        }
        if (d.pathType === 'oil')   return 'rgba(255,140,0,0.6)';
        if (d.pathType === 'gas')   return 'rgba(80,220,120,0.6)';
        if (d.pathType === 'stormTrack') return 'rgba(255,100,100,0.8)';
        if (d.pathType === 'stormHistory') {
          const w = d.windKt || 0;
          if (w >= 137) return 'rgba(255,96,96,0.8)';
          if (w >= 96) return 'rgba(255,140,0,0.8)';
          if (w >= 64) return 'rgba(255,231,117,0.8)';
          if (w >= 34) return 'rgba(94,186,255,0.8)';
          return 'rgba(160,160,160,0.6)';
        }
        return 'rgba(180,160,255,0.6)';
      })
      .pathStroke((d: GlobePath) => {
        if (!d) return 0.6;
        if (d.pathType === 'cable') return 0.3;
        if (d.pathType === 'stormTrack' || d.pathType === 'stormHistory') return 1.2;
        return 0.6;
      })
      .pathDashLength((d: GlobePath) => {
        if (!d) return 0.6;
        if (d.pathType === 'cable') return 1;
        if (d.pathType === 'stormTrack') return 0.8;
        if (d.pathType === 'stormHistory') return 1;
        return 0.6;
      })
      .pathDashGap((d: GlobePath) => {
        if (!d) return 0.25;
        if (d.pathType === 'cable') return 0;
        if (d.pathType === 'stormTrack') return 0.4;
        if (d.pathType === 'stormHistory') return 0;
        return 0.25;
      })
      .pathDashAnimateTime((d: GlobePath) => {
        if (!d) return 5000;
        if (d.pathType === 'cable') return 0;
        if (d.pathType === 'stormTrack') return 3000;
        if (d.pathType === 'stormHistory') return 0;
        return 5000;
      })
      .pathLabel((d: GlobePath) => escapeHtml(d?.name ?? ''));

    // Polygon accessors — set once
    (globe as any)
      .polygonGeoJsonGeometry((d: GlobePolygon) => ({ type: 'Polygon', coordinates: d.coords }))
      .polygonCapColor(() => 'rgba(255,140,60,0.2)')
      .polygonSideColor(() => 'rgba(255,140,60,0.1)')
      .polygonStrokeColor(() => 'rgba(255,140,60,0.5)')
      .polygonAltitude(() => 0.005)
      .polygonLabel((d: GlobePolygon) => escapeHtml(d.name));

    this.globe = globe;
    this.initialized = true;

    // Apply initial render quality + performance profile
    this.applyRenderQuality(initialScale);
    this.applyPerformanceProfile(resolvePerformanceProfile(initialScale));

    // Add overlay UI (zoom controls + layer panel)
    if (this.chrome) {
      this.createControls();
      this.createLayerToggles();
    }

    // Load static datasets
    this.initStaticLayers();

    // Navigate to initial view
    this.setView(this.currentView);

    this.layers.dayNight = false;
    this.hideLayerToggle('dayNight');

    // Flush any data that arrived before init completed
    this.flushMarkers();
    this.flushPaths();
    this.flushPolygons();

    // Idle rendering: pause animation when nothing is happening
    this.setupVisibilityHandler();
    this.scheduleIdlePause();
  }

  // ─── Marker element builder ────────────────────────────────────────────────

  private pulseStyle(duration: string): string {
    return this._pulseEnabled ? `animation:globe-pulse ${duration} ease-out infinite;` : 'animation:none;';
  }

  /** Wrap marker content in an invisible 20×20px hit target for easier clicking on the globe. */
  private static wrapHit(inner: string): string {
    return `<div style="width:20px;height:20px;display:flex;align-items:center;justify-content:center">${inner}</div>`;
  }

  private buildMarkerElement(d: GlobeMarker): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'pointer-events:auto;cursor:pointer;user-select:none;';

    if (d._kind === 'weather') {
      const severityColors: Record<string, string> = {
        Extreme: '#ff0044', Severe: '#ff6600', Moderate: '#ffaa00', Minor: '#88aaff',
      };
      const c = severityColors[d.severity] ?? '#88aaff';
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(9px * var(--wm-panel-effective-scale, 1));color:${c};text-shadow:0 0 4px ${c}88;font-weight:bold;">⚡</div>`), "legacy direct innerHTML migration"));
      el.title = d.headline;
    } else if (d._kind === 'radiation') {
      const c = d.severity === 'spike' ? '#ff3030' : '#ffaa00';
      const ring = d.severity === 'spike'
        ? `<div style="position:absolute;inset:-5px;border-radius:50%;border:2px solid ${c}66;${this.pulseStyle('1.8s')}"></div>`
        : '';
      const confirmRing = d.corroborated
        ? '<div style="position:absolute;inset:-9px;border-radius:50%;border:1px dashed #7dd3fc88;"></div>'
        : '';
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(
        `<div style="position:relative;display:inline-flex;align-items:center;justify-content:center;">${ring}${confirmRing}<div style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:${c};text-shadow:0 0 5px ${c}88;opacity:${d.confidence === 'low' ? 0.75 : 1};">☢</div></div>`
      ), "legacy direct innerHTML migration"));
      el.title = `${d.location} · ${d.severity} · ${d.confidence}`;
    } else if (d._kind === 'natural') {
      const typeIcons: Record<string, string> = {
        earthquakes: '〽', volcanoes: '🌋', severeStorms: '🌀',
        floods: '💧', wildfires: '🔥', drought: '☀',
      };
      const icon = typeIcons[d.category] ?? '⚠';
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));">${icon}</div>`), "legacy direct innerHTML migration"));
      el.title = d.title;
    } else if (d._kind === 'outage') {
      const sc = d.severity === 'total' ? '#ff2020' : d.severity === 'major' ? '#ff8800' : '#ffcc00';
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(12px * var(--wm-panel-effective-scale, 1));color:${sc};text-shadow:0 0 4px ${sc}88;">📡</div>`), "legacy direct innerHTML migration"));
      el.title = `${d.country}: ${d.title}`;
    } else if (d._kind === 'trafficAnomaly') {
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:#ffa000;text-shadow:0 0 4px #ffa00088;font-weight:bold;">⚡</div>`), "legacy direct innerHTML migration"));
      el.title = `${d.type || 'Traffic Anomaly'}: ${d.locationName}`;
    } else if (d._kind === 'ddosHit') {
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:#b400ff;text-shadow:0 0 4px #b400ff88;font-weight:bold;">⚔</div>`), "legacy direct innerHTML migration"));
      el.title = `DDoS: ${d.countryName} (${d.percentage.toFixed(1)}%)`;
    } else if (d._kind === 'fire') {
      const intensity = d.brightness > 400 ? '#ff2020' : d.brightness > 330 ? '#ff6600' : '#ffaa00';
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:${intensity};text-shadow:0 0 4px ${intensity}88;">🔥</div>`), "legacy direct innerHTML migration"));
      el.title = `Fire — ${d.region}`;
    } else if (d._kind === 'climate') {
      const typeColors: Record<string, string> = { warm: '#ff4400', cold: '#44aaff', wet: '#00ccff', dry: '#ff8800', mixed: '#88ff88' };
      const c = typeColors[d.type] ?? '#88ff88';
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:${c};text-shadow:0 0 4px ${c}88;">🌡</div>`), "legacy direct innerHTML migration"));
      el.title = `${d.zone} (${d.type})`;
    } else if (d._kind === 'nuclearSite') {
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:#ffd700;text-shadow:0 0 4px #ffd70088;">☢</div>`), "legacy direct innerHTML migration"));
      el.title = `${d.name} (${d.type})`;
    } else if (d._kind === 'irradiator') {
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:#ff8800;text-shadow:0 0 3px #ff880088;">⚠</div>`), "legacy direct innerHTML migration"));
      el.title = `${d.city}, ${d.country}`;
    } else if (d._kind === 'earthquake') {
      const mc = d.magnitude >= 6 ? '#ff2020' : d.magnitude >= 4 ? '#ff8800' : '#ffcc00';
      const sz = Math.max(8, Math.min(18, Math.round(d.magnitude * 2.5)));
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="width:${sz}px;height:${sz}px;border-radius:50%;background:${mc}44;border:2px solid ${mc};box-shadow:0 0 6px 2px ${mc}55;"></div>`), "legacy direct innerHTML migration"));
      el.title = `M${d.magnitude.toFixed(1)} — ${d.place}`;
    } else if (d._kind === 'datacenter') {
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:#88aaff;text-shadow:0 0 3px #88aaff88;">🖥</div>`), "legacy direct innerHTML migration"));
      el.title = `${d.name} (${d.owner})`;
    } else if (d._kind === 'cableAdvisory') {
      const sc = d.severity === 'fault' ? '#ff2020' : '#ff8800';
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:${sc};text-shadow:0 0 4px ${sc}88;">🔌</div>`), "legacy direct innerHTML migration"));
      el.title = `${d.title} (${d.severity})`;
    } else if (d._kind === 'repairShip') {
      const sc = d.status === 'on-station' ? '#44ff88' : '#44aaff';
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<div style="font-size:calc(11px * var(--wm-panel-effective-scale, 1));color:${sc};text-shadow:0 0 4px ${sc}88;">🚢</div>`), "legacy direct innerHTML migration"));
      el.title = d.name;
    } else if (d._kind === 'newsLocation') {
      const tc = d.threatLevel === 'critical' ? '#ff2020'
               : d.threatLevel === 'high'     ? '#ff6600'
               : (d.threatLevel === 'elevated' || d.threatLevel === 'medium') ? '#ffaa00'
               : '#44aaff';
      setTrustedHtml(el, trustedHtml(`
        <div style="position:relative;width:16px;height:16px;">
          <div style="position:absolute;inset:0;border-radius:50%;background:${tc}44;border:1.5px solid ${tc};box-shadow:0 0 5px 2px ${tc}55;"></div>
          <div style="position:absolute;inset:-5px;border-radius:50%;background:${tc}22;${this.pulseStyle('1.8s')}"></div>
        </div>`, "legacy direct innerHTML migration"));
      el.title = d.title;
    } else if (d._kind === 'webcam') {
      const style = getCategoryStyle(d.category);
      const emoji = this.webcamMarkerMode === 'emoji' ? style.emoji : '\u{1F4F7}';
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<span style="background:${style.color}33;border:1px solid ${style.color}88;border-radius:10px;padding:1px 5px;font-size:calc(12px * var(--wm-panel-effective-scale, 1));">${emoji}</span>`), "legacy direct innerHTML migration"));
      el.title = d.title;
    } else if (d._kind === 'webcam-cluster') {
      setTrustedHtml(el, trustedHtml(GlobeMap.wrapHit(`<span style="background:#00d4ff33;border:1px solid #00d4ff88;border-radius:12px;padding:2px 7px;font-size:calc(11px * var(--wm-panel-effective-scale, 1));font-weight:bold;color:#00d4ff;">${d.count}</span>`), "legacy direct innerHTML migration"));
      el.title = `${d.count} webcams`;
    } else if (d._kind === 'flash') {
      el.style.pointerEvents = 'none';
      setTrustedHtml(el, trustedHtml(`
        <div style="position:relative;width:0;height:0;">
          <div style="position:absolute;width:44px;height:44px;border-radius:50%;
            border:2px solid rgba(255,255,255,0.9);background:rgba(255,255,255,0.2);
            left:-22px;top:-22px;
            ${this.pulseStyle('0.7s')}"></div>
        </div>`, "legacy direct innerHTML migration"));
    }

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.handleMarkerClick(d, el);
    });

    return el;
  }

  private handleMarkerClick(d: GlobeMarker, anchor: HTMLElement): void {
    if (d._kind === 'webcam-cluster' && this.globe) {
      const pov = this.globe.pointOfView();
      // Fly to cluster and zoom in (reduce altitude by 60%)
      this.moveViewport(
        { lat: d._lat, lng: d._lng, altitude: pov.altitude * 0.4 },
        800,
      );
    }
    if (d._kind === 'radiation' && this.popup) {
      const aRect = anchor.getBoundingClientRect();
      const cRect = this.container.getBoundingClientRect();
      const x = aRect.left - cRect.left + aRect.width / 2;
      const y = aRect.top - cRect.top;
      this.hideTooltip();
      this.popup.show({
        type: 'radiation',
        data: {
          id: d.id,
          source: d.source,
          contributingSources: d.contributingSources,
          location: d.location,
          country: d.country,
          lat: d._lat,
          lon: d._lng,
          value: d.value,
          unit: d.unit,
          observedAt: d.observedAt,
          freshness: d.freshness,
          baselineValue: d.baselineValue,
          delta: d.delta,
          zScore: d.zScore,
          severity: d.severity,
          confidence: d.confidence,
          corroborated: d.corroborated,
          conflictingSources: d.conflictingSources,
          convertedFromCpm: d.convertedFromCpm,
          sourceCount: d.sourceCount,
        },
        x,
        y,
      });
      return;
    }
    this.showMarkerTooltip(d, anchor);
    if (d._kind === 'newsLocation') this.onNewsClick?.(d);
  }

  private showMarkerTooltip(d: GlobeMarker, anchor: HTMLElement): void {
    this.hideTooltip();
    const el = document.createElement('div');
    el.style.cssText = [
      'position:absolute',
      'background:rgba(10,12,16,0.95)',
      'border:1px solid rgba(60,120,60,0.6)',
      'padding:8px 12px',
      'border-radius:3px',
      'font-size:calc(11px * var(--wm-panel-effective-scale, 1))',
      'font-family:var(--font-mono)',
      'color:#d4d4d4',
      'max-width:280px',
      'z-index:1000',
      'pointer-events:auto',
      'line-height:1.5',
    ].join(';');

    const closeBtn = `<button style="position:absolute;top:4px;right:4px;background:none;border:none;color:#888;cursor:pointer;font-size:calc(14px * var(--wm-panel-effective-scale, 1));line-height:1;padding:2px 4px;" aria-label="Close">\u00D7</button>`;

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    let html = '';
    if (d._kind === 'weather') {
      const wc = d.severity === 'Extreme' ? '#ff0044' : d.severity === 'Severe' ? '#ff6600' : '#88aaff';
      html = `<span style="color:${wc};font-weight:bold;">⚡ ${esc(d.severity)}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.headline.slice(0, 90))}</span>`;
    } else if (d._kind === 'radiation') {
      const rc = d.severity === 'spike' ? '#ff3030' : '#ffaa00';
      html = `<span style="color:${rc};font-weight:bold;">☢ ${esc(d.severity.toUpperCase())}</span>` +
             `<br><span style="opacity:.7;">${esc(d.location)}, ${esc(d.country)}</span>` +
             `<br><span style="opacity:.5;">${d.value.toFixed(1)} ${esc(d.unit)} · ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(1)} vs baseline</span>` +
             `<br><span style="opacity:.55;font-size:calc(10px * var(--wm-panel-effective-scale, 1));">${esc(d.confidence.toUpperCase())}${d.corroborated ? ' · CONFIRMED' : ''}${d.conflictingSources ? ' · CONFLICT' : ''}</span>`;
    } else if (d._kind === 'natural') {
      html = `<span style="font-weight:bold;">${esc(d.title.slice(0, 60))}</span>` +
             `<br><span style="opacity:.7;">${esc(d.category)}</span>`;
    } else if (d._kind === 'outage') {
      const sc = d.severity === 'total' ? '#ff2020' : d.severity === 'major' ? '#ff8800' : '#ffcc00';
      html = `<span style="color:${sc};font-weight:bold;">📡 ${d.severity.toUpperCase()} Outage</span>` +
             `<br><span style="opacity:.7;">${esc(d.country)}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.title.slice(0, 70))}</span>`;
    } else if (d._kind === 'trafficAnomaly') {
      html = `<span style="color:#ffa000;font-weight:bold;">⚡ ${esc(d.type || 'Traffic Anomaly')}</span>` +
             `<br><span style="opacity:.7;">${esc(d.locationName)}</span>`;
    } else if (d._kind === 'ddosHit') {
      html = `<span style="color:#b400ff;font-weight:bold;">⚔ DDoS Target: ${esc(d.countryName)}</span>` +
             `<br><span style="opacity:.7;">${d.percentage.toFixed(1)}% of attack traffic</span>`;
    } else if (d._kind === 'fire') {
      html = `<span style="color:#ff6600;font-weight:bold;">🔥 Wildfire</span>` +
             `<br><span style="opacity:.7;">${esc(d.region)}</span>` +
             `<br><span style="opacity:.5;">Brightness: ${d.brightness.toFixed(0)} K</span>`;
    } else if (d._kind === 'climate') {
      const tc = d.type === 'warm' ? '#ff4400' : d.type === 'cold' ? '#44aaff' : '#88ff88';
      html = `<span style="color:${tc};font-weight:bold;">🌡 ${esc(d.type.toUpperCase())}</span>` +
             `<br><span style="opacity:.7;">${esc(d.zone)}</span>` +
             `<br><span style="opacity:.5;">ΔT: ${d.tempDelta > 0 ? '+' : ''}${d.tempDelta.toFixed(1)}°C · ${esc(d.severity)}</span>`;
    } else if (d._kind === 'nuclearSite') {
      const nc = d.status === 'active' ? '#ffd700' : d.status === 'construction' ? '#ff8800' : '#888888';
      html = `<span style="color:${nc};font-weight:bold;">☢ ${esc(d.name)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.type)} · ${esc(d.status)}</span>`;
      if (d.operationalSince || d.treaties?.length || d.iaeaStatus || d.keyEvents?.length) {
        html += `<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:calc(9px * var(--wm-panel-effective-scale, 1));opacity:.6;list-style:none;user-select:none;padding:2px 0;">📜 HISTORICAL PROFILE</summary>` +
          `<div style="margin-top:4px;">` +
          (d.operationalSince ? `<div style="display:flex;justify-content:space-between;gap:8px;font-size:calc(10px * var(--wm-panel-effective-scale, 1));margin:2px 0;"><span style="opacity:.5;">OPERATIONAL SINCE</span><span>${esc(d.operationalSince)}</span></div>` : '') +
          (d.treaties?.length ? `<div style="display:flex;justify-content:space-between;gap:8px;font-size:calc(10px * var(--wm-panel-effective-scale, 1));margin:2px 0;"><span style="opacity:.5;">TREATIES</span><span>${d.treaties.map(esc).join(', ')}</span></div>` : '') +
          (d.iaeaStatus ? `<div style="display:flex;justify-content:space-between;gap:8px;font-size:calc(10px * var(--wm-panel-effective-scale, 1));margin:2px 0;"><span style="opacity:.5;">IAEA STATUS</span><span>${esc(d.iaeaStatus)}</span></div>` : '') +
          (d.keyEvents?.length ? `<div style="font-size:calc(10px * var(--wm-panel-effective-scale, 1));margin:4px 0 2px;"><span style="opacity:.5;display:block;margin-bottom:2px;">KEY EVENTS</span>${d.keyEvents.map(e => `<div style="opacity:.7;">· ${esc(e)}</div>`).join('')}</div>` : '') +
          `</div></details>`;
      }
    } else if (d._kind === 'irradiator') {
      html = `<span style="color:#ff8800;font-weight:bold;">⚠ Gamma Irradiator</span>` +
             `<br><span style="opacity:.7;">${esc(d.city)}, ${esc(d.country)}</span>`;
    } else if (d._kind === 'earthquake') {
      const mc = d.magnitude >= 6 ? '#ff3030' : d.magnitude >= 4 ? '#ff8800' : '#ffcc00';
      html = `<span style="color:${mc};font-weight:bold;">🌍 M${d.magnitude.toFixed(1)}</span>` +
             `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.place.slice(0, 70))}</span>`;
    } else if (d._kind === 'datacenter') {
      html = `<span style="color:#88aaff;font-weight:bold;">🖥 ${esc(d.name)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.owner)} · ${esc(d.country)}</span>` +
             `<br><span style="opacity:.5;">${esc(d.chipType)}</span>`;
    } else if (d._kind === 'cableAdvisory') {
      const sc = d.severity === 'fault' ? '#ff2020' : '#ff8800';
      html = `<span style="color:${sc};font-weight:bold;">🔌 ${esc(d.severity.toUpperCase())} — ${esc(d.title.slice(0, 50))}</span>` +
             (d.impact ? `<br><span style="opacity:.7;white-space:normal;display:block;">${esc(d.impact.slice(0, 70))}</span>` : '') +
             (d.repairEta ? `<br><span style="opacity:.5;">ETA: ${esc(d.repairEta)}</span>` : '');
    } else if (d._kind === 'repairShip') {
      const sc = d.status === 'on-station' ? '#44ff88' : '#44aaff';
      html = `<span style="color:${sc};font-weight:bold;">🚢 ${esc(d.name)}</span>` +
             `<br><span style="opacity:.7;">${esc(d.status.replace(/-/g, ' '))}${d.operator ? ' · ' + esc(d.operator) : ''}</span>` +
             (d.eta ? `<br><span style="opacity:.5;">ETA: ${esc(d.eta)}</span>` : '');
    } else if (d._kind === 'newsLocation') {
      const tc = d.threatLevel === 'critical' ? '#ff2020' : d.threatLevel === 'high' ? '#ff6600' : (d.threatLevel === 'elevated' || d.threatLevel === 'medium') ? '#ffaa00' : '#44aaff';
      const coverage = corroborationLabelHtml(d.corroboration);
      html = `<span style="color:${tc};font-weight:bold;">📰 ${esc(d.title.slice(0, 60))}</span>` +
             `<br><span style="opacity:.5;">${esc(d.threatLevel)}</span>` +
             (coverage ? `<br>${coverage}` : '');
    } else if (d._kind === 'webcam') {
      html = '';
    } else if (d._kind === 'webcam-cluster') {
      html = '';
    }
    setTrustedHtml(el, trustedHtml(`<div style="padding-right:16px;position:relative;">${closeBtn}${html}</div>`, "legacy direct innerHTML migration"));
    const wideKinds = new Set(['cableAdvisory', 'nuclearSite']);
    if (wideKinds.has(d._kind)) el.style.maxWidth = '300px';
    el.querySelector('button')?.addEventListener('click', () => this.hideTooltip());


    if (d._kind === 'webcam') {
      const wrapper = el.firstElementChild!;
      const titleSpan = document.createElement('span');
      titleSpan.style.cssText = 'color:#00d4ff;font-weight:bold;';
      titleSpan.textContent = `\u{1F4F7} ${d.title.slice(0, 50)}`;
      wrapper.appendChild(titleSpan);

      const metaSpan = document.createElement('span');
      metaSpan.style.cssText = 'display:block;opacity:.7;font-size:calc(11px * var(--wm-panel-effective-scale, 1));';
      metaSpan.textContent = `${d.country} \u00B7 ${d.category}`;
      wrapper.appendChild(metaSpan);

      const previewDiv = document.createElement('div');
      previewDiv.style.marginTop = '4px';
      const loadingSpan = document.createElement('span');
      loadingSpan.style.cssText = 'opacity:.5;font-size:calc(11px * var(--wm-panel-effective-scale, 1));';
      loadingSpan.textContent = 'Loading preview...';
      previewDiv.appendChild(loadingSpan);
      wrapper.appendChild(previewDiv);

      const link = document.createElement('a');
      link.href = `https://www.windy.com/webcams/${encodeURIComponent(d.webcamId)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.style.cssText = 'display:block;color:#00d4ff;font-size:calc(11px * var(--wm-panel-effective-scale, 1));text-decoration:none;';
      link.textContent = 'Open on Windy \u2197';
      wrapper.appendChild(link);

      const attribution = document.createElement('div');
      attribution.style.cssText = 'opacity:.4;font-size:calc(9px * var(--wm-panel-effective-scale, 1));margin-top:4px;';
      attribution.textContent = 'Powered by Windy';
      wrapper.appendChild(attribution);

      import('@/services/webcams').then(({ fetchWebcamImage }) => {
        fetchWebcamImage(d.webcamId).then(img => {
          if (!el.isConnected) return;
          previewDiv.replaceChildren();
          if (img.thumbnailUrl) {
            const imgEl = document.createElement('img');
            imgEl.src = img.thumbnailUrl;
            imgEl.style.cssText = 'width:200px;border-radius:4px;margin-bottom:4px;';
            imgEl.loading = 'lazy';
            previewDiv.appendChild(imgEl);
          } else {
            const span = document.createElement('span');
            span.style.cssText = 'opacity:.5;font-size:calc(11px * var(--wm-panel-effective-scale, 1));';
            span.textContent = 'Preview unavailable';
            previewDiv.appendChild(span);
          }
          const pinBtn = document.createElement('button');
          pinBtn.className = 'webcam-pin-btn';
          pinBtn.style.cssText = 'display:block;margin-top:4px;';
          if (isPinned(d.webcamId)) {
            pinBtn.classList.add('webcam-pin-btn--pinned');
            pinBtn.textContent = '\u{1F4CC} Pinned';
            pinBtn.disabled = true;
          } else {
            pinBtn.textContent = '\u{1F4CC} Pin';
            pinBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              pinWebcam({
                webcamId: d.webcamId,
                title: d.title || img.title || '',
                lat: d._lat,
                lng: d._lng,
                category: d.category || 'other',
                country: d.country || '',
                playerUrl: img.playerUrl || '',
              });
              pinBtn.classList.add('webcam-pin-btn--pinned');
              pinBtn.textContent = '\u{1F4CC} Pinned';
              pinBtn.disabled = true;
            });
          }
          wrapper.appendChild(pinBtn);
        });
      });
    } else if (d._kind === 'webcam-cluster') {
      const wrapper = el.firstElementChild!;
      const header = document.createElement('span');
      header.style.cssText = 'color:#00d4ff;font-weight:bold;';
      header.textContent = `\u{1F4F7} ${d.count} webcams`;
      wrapper.appendChild(header);
      const loadingSpan = document.createElement('span');
      loadingSpan.style.cssText = 'display:block;opacity:.5;font-size:calc(10px * var(--wm-panel-effective-scale, 1));';
      loadingSpan.textContent = 'Loading list...';
      wrapper.appendChild(loadingSpan);
    }
    el.addEventListener('mouseenter', () => {
      if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); this.tooltipHideTimer = null; }
    });
    el.addEventListener('mouseleave', () => {
      this.tooltipHideTimer = setTimeout(() => this.hideTooltip(), 2000);
    });

    this.container.appendChild(el);

    // Position relative to container using measured dimensions
    const ar = anchor.getBoundingClientRect();
    const cr = this.container.getBoundingClientRect();
    const left = Math.max(4, Math.min(
      ar.left - cr.left + (anchor.offsetWidth ?? 14) + 6,
      cr.width - el.offsetWidth - 4
    ));
    const top = Math.max(4, Math.min(
      ar.top - cr.top - 8,
      cr.height - el.offsetHeight - 4
    ));
    el.style.left = left + 'px';
    el.style.top  = top  + 'px';

    this.tooltipEl = el;
    if (this.tooltipHideTimer) clearTimeout(this.tooltipHideTimer);
    const richKinds = new Set(['cableAdvisory', 'nuclearSite', 'datacenter', 'repairShip']);
    const hideDelay = d._kind === 'webcam' ? 8000 : d._kind === 'webcam-cluster' ? 12000 : richKinds.has(d._kind) ? 6000 : 3500;
    this.tooltipHideTimer = setTimeout(() => this.hideTooltip(), hideDelay);

    if (d._kind === 'webcam-cluster') {
      const tooltipEl = el;
      const alt = this.globe?.pointOfView()?.altitude ?? 2.0;
      const approxZoom = alt >= 2.0 ? 2 : alt >= 1.0 ? 4 : alt >= 0.5 ? 6 : 8;
      import('@/services/webcams').then(({ fetchWebcams, getClusterCellSize }) => {
        const margin = Math.max(0.5, getClusterCellSize(approxZoom));
        fetchWebcams(10, {
          w: d._lng - margin, s: d._lat - margin,
          e: d._lng + margin, n: d._lat + margin,
        }).then(result => {
          if (!tooltipEl.isConnected) return;
          const webcams = result.webcams.slice(0, 20);

          const wrapper = document.createElement('div');
          wrapper.style.cssText = 'padding-right:16px;position:relative;';

          const closeBtn2 = document.createElement('button');
          closeBtn2.style.cssText = 'position:absolute;top:4px;right:4px;background:none;border:none;color:#888;cursor:pointer;font-size:calc(14px * var(--wm-panel-effective-scale, 1));line-height:1;padding:2px 4px;';
          closeBtn2.setAttribute('aria-label', 'Close');
          closeBtn2.textContent = '\u00D7';
          closeBtn2.addEventListener('click', () => this.hideTooltip());
          wrapper.appendChild(closeBtn2);

          const headerSpan = document.createElement('span');
          headerSpan.style.cssText = 'color:#00d4ff;font-weight:bold;';
          headerSpan.textContent = `\u{1F4F7} ${webcams.length} webcams`;
          wrapper.appendChild(headerSpan);

          const listDiv = document.createElement('div');
          listDiv.style.cssText = 'max-height:180px;overflow-y:auto;margin-top:4px;';

          for (const webcam of webcams) {
            const item = document.createElement('div');
            item.style.cssText = 'padding:2px 0;cursor:pointer;color:#aaa;border-bottom:1px solid rgba(255,255,255,0.08);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = webcam.title || webcam.category || 'Webcam';
            item.appendChild(nameSpan);

            if (webcam.country) {
              const countrySpan = document.createElement('span');
              countrySpan.style.cssText = 'float:right;opacity:0.4;font-size:calc(10px * var(--wm-panel-effective-scale, 1));margin-left:6px;';
              countrySpan.textContent = webcam.country;
              item.appendChild(countrySpan);
            }

            item.addEventListener('mouseenter', () => { item.style.color = '#00d4ff'; });
            item.addEventListener('mouseleave', () => { item.style.color = '#aaa'; });
            item.addEventListener('click', (e) => {
              e.stopPropagation();
              const cr = this.container.getBoundingClientRect();
              const me = e as MouseEvent;
              const phantom = document.createElement('div');
              phantom.style.cssText = `position:absolute;left:${me.clientX - cr.left}px;top:${me.clientY - cr.top}px;width:1px;height:1px;pointer-events:none;`;
              this.container.appendChild(phantom);
              this.showMarkerTooltip({
                _kind: 'webcam', _lat: webcam.lat, _lng: webcam.lng,
                webcamId: webcam.webcamId, title: webcam.title,
                category: webcam.category, country: webcam.country,
              } as GlobeMarker, phantom);
              phantom.remove();
            });
            listDiv.appendChild(item);
          }

          wrapper.appendChild(listDiv);
          tooltipEl.replaceChildren(wrapper);
        });
      });
    }
  }

  private hideTooltip(): void {
    if (this.tooltipHideTimer) { clearTimeout(this.tooltipHideTimer); this.tooltipHideTimer = null; }
    this.tooltipEl?.remove();
    this.tooltipEl = null;
    this.popup?.hide();
  }

  // ─── Overlay UI: zoom controls & layer panel ─────────────────────────────

  private createControls(): void {
    const el = document.createElement('div');
    el.className = 'map-controls deckgl-controls';
    setTrustedHtml(el, trustedHtml(`
      <span class="globe-beta-badge">BETA</span>
      <div class="zoom-controls">
        <button class="map-btn zoom-in"    title="Zoom in" aria-label="Zoom in">+</button>
        <button class="map-btn zoom-out"   title="Zoom out" aria-label="Zoom out">-</button>
        <button class="map-btn zoom-reset" title="Reset view" aria-label="Reset view">&#8962;</button>
      </div>`, "legacy direct innerHTML migration"));
    this.container.appendChild(el);
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if      (target.classList.contains('zoom-in'))    this.zoomInGlobe();
      else if (target.classList.contains('zoom-out'))   this.zoomOutGlobe();
      else if (target.classList.contains('zoom-reset')) this.setView(this.currentView);
    });
  }

  private zoomInGlobe(): void {
    if (!this.globe) return;
    const pov = this.globe.pointOfView();
    if (!pov) return;
    const alt = Math.max(0.05, (pov.altitude ?? 1.8) * 0.6);
    this.moveViewport({ lat: pov.lat, lng: pov.lng, altitude: alt }, 500);
  }

  private zoomOutGlobe(): void {
    if (!this.globe) return;
    const pov = this.globe.pointOfView();
    if (!pov) return;
    const alt = Math.min(4.0, (pov.altitude ?? 1.8) * 1.6);
    this.moveViewport({ lat: pov.lat, lng: pov.lng, altitude: alt }, 500);
  }

  private createLayerToggles(): void {
    const layerDefs = getLayersForVariant(SITE_VARIANT, 'globe');
    const authState = getAuthState();
    const layers = layerDefs.map(def => ({
      key: def.key,
      label: resolveLayerLabel(def, t),
      icon: def.icon,
      premium: def.premium,
      presentation: getPremiumLayerPresentation(def.premium, authState),
    }));

    const el = document.createElement('div');
    el.className = 'layer-toggles deckgl-layer-toggles';
    el.style.bottom = 'auto';
    el.style.top = '10px';
    setTrustedHtml(el, trustedHtml(`
      <div class="toggle-header">
        <span>${t('components.deckgl.layersTitle')}</span>
        <button class="toggle-collapse">&#9660;</button>
      </div>
      <input type="text" class="layer-search" placeholder="${t('components.deckgl.layerSearch')}" autocomplete="off" spellcheck="false" />
      <div class="toggle-list" style="max-height:32vh;overflow-y:auto;scrollbar-width:thin;">
        ${layers.map(({ key, label, icon, presentation }) => {
            const explainLabel = escapeHtml(`Explain ${label} layer`);
            const hasExplanation = hasCuratedLayerExplanation(key);
            return `
          <div class="layer-toggle-row" data-layer="${key}">
            <label class="layer-toggle" data-layer="${key}">
              <input type="checkbox" ${this.layers[key] ? 'checked' : ''}>
              <span class="toggle-icon">${icon}</span>
              <span class="toggle-label">${label}${presentation.enhanced ? ' <span class="layer-pro-badge">PRO</span>' : ''}</span>
            </label>
            <button type="button" class="layer-explain-btn${hasExplanation ? ' has-layer-explanation' : ''}" data-layer="${key}" aria-label="${explainLabel}" title="${explainLabel}">i</button>
          </div>`;
        }).join('')}
      </div>`, "legacy direct innerHTML migration"));
    const authorBadge = document.createElement('div');
    authorBadge.className = 'map-author-badge';
    authorBadge.textContent = '© Elie Habib · Someone™';
    el.appendChild(authorBadge);
    this.container.appendChild(el);
    this.layerTogglesEl = el;

    for (const layer of layers) {
      if (!layer.premium) continue;
      const toggle = el.querySelector(`.layer-toggle[data-layer="${layer.key}"]`) as HTMLElement | null;
      if (toggle) applyPremiumLayerPresentation(toggle, layer.presentation);
    }

    el.querySelectorAll('.layer-toggle input').forEach(input => {
      input.addEventListener('change', () => {
        const layer = (input as HTMLInputElement).closest('.layer-toggle')?.getAttribute('data-layer') as keyof MapLayers | null;
        if (layer) {
          const checked = (input as HTMLInputElement).checked;
          this.layers[layer] = checked;
          this.flushLayerChannels(layer);
          this.onLayerChangeCb?.(layer, checked, 'user');
          this.enforceLayerLimit();
          // Show/hide webcam marker-mode sub-row when webcam layer is toggled
          if (layer === 'webcams') {
            const modeRow = el.querySelector('.webcam-mode-row') as HTMLElement | null;
            if (modeRow) modeRow.style.display = checked ? '' : 'none';
          }
        }
      });
    });

    el.querySelectorAll('.layer-explain-btn').forEach(button => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const layer = (button as HTMLElement).getAttribute('data-layer') as keyof MapLayers | null;
        if (layer) this.showLayerExplanation(layer);
      });
    });

    const lockedPremiumLayerKeys = new Set(
      layers.filter(layer => layer.premium === 'locked').map(layer => layer.key),
    );
    this.premiumLayerGate?.destroy();
    this.premiumLayerGate = lockedPremiumLayerKeys.size > 0
      ? new PremiumLayerGate(el, lockedPremiumLayerKeys, {
          isLayerEnabled: layer => Boolean(this.layers[layer as keyof MapLayers]),
          onAccessLost: layer => this.handlePremiumLayerAccessLoss(layer as keyof MapLayers),
        })
      : null;

    // ── Webcam marker-mode sub-toggle ────────────────────────────────────────
    const webcamToggleEl = el.querySelector('.layer-toggle[data-layer="webcams"]') as HTMLElement | null;
    if (webcamToggleEl) {
      const modeRow = document.createElement('div');
      modeRow.className = 'webcam-mode-row';
      modeRow.style.cssText = 'display:none;padding:2px 6px 4px 24px;font-size:calc(10px * var(--wm-panel-effective-scale, 1));color:#aaa;';
      const currentMode = (): string => this.webcamMarkerMode;
      const renderModeLabel = (): string => currentMode() === 'emoji' ? '&#128247; icon mode' : '&#128512; emoji mode';
      const modeBtn = document.createElement('button');
      modeBtn.style.cssText = 'background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.3);color:#00d4ff;font-size:calc(10px * var(--wm-panel-effective-scale, 1));padding:1px 6px;border-radius:3px;cursor:pointer;margin-left:2px;';
      modeBtn.title = 'Toggle webcam marker style';
      setTrustedHtml(modeBtn, trustedHtml(renderModeLabel(), "legacy direct innerHTML migration"));
      modeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const next = currentMode() === 'icon' ? 'emoji' : 'icon';
        this.webcamMarkerMode = next;
        saveWebcamMarkerMode(next);
        setTrustedHtml(modeBtn, trustedHtml(renderModeLabel(), "legacy direct innerHTML migration"));
        this.flushMarkers();
      });
      const modeLabel = document.createElement('span');
      modeLabel.textContent = 'Marker: ';
      modeRow.appendChild(modeLabel);
      modeRow.appendChild(modeBtn);
      webcamToggleEl.insertAdjacentElement('afterend', modeRow);
      // Show immediately if webcam layer is already enabled
      if (this.layers.webcams) modeRow.style.display = '';
    }

    this.enforceLayerLimit();

    bindLayerSearch(el);
    const searchEl = el.querySelector('.layer-search') as HTMLElement | null;

    const collapseBtn = el.querySelector('.toggle-collapse');
    const list = el.querySelector('.toggle-list') as HTMLElement | null;
    let collapsed = false;
    collapseBtn?.addEventListener('click', () => {
      collapsed = !collapsed;
      if (list) list.style.display = collapsed ? 'none' : '';
      if (searchEl) searchEl.style.display = collapsed ? 'none' : '';
      if (collapseBtn) setTrustedHtml((collapseBtn as HTMLElement), trustedHtml(collapsed ? '&#9654;' : '&#9660;', "legacy direct innerHTML migration"));
    });

    // Intercept wheel on layer panel — scroll list, don't zoom globe
    el.addEventListener('wheel', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (list) list.scrollTop += e.deltaY;
    }, { passive: false });

    // The panel usually mounts after the first flush, so replay what that flush withheld.
    this.updateLayerTruncationLabels();
  }

  private handlePremiumLayerAccessLoss(layer: keyof MapLayers): void {
    const wasEnabled = Boolean(this.layers[layer]);
    this.layers[layer] = false;
    this.flushLayerChannels(layer);
    if (!wasEnabled) return;

    if (this.onLayerChangeCb) {
      this.onLayerChangeCb(layer, false, 'programmatic');
    } else {
      // GlobeMap builds its controls before MapContainer rehydrates the
      // callback. Preserve an initial entitlement clamp for that short window.
      this.pendingPremiumLayerChanges.add(layer);
    }
  }

  private showLayerExplanation(layer: keyof MapLayers): void {
    const existing = this.container.querySelector('.layer-explanation-popup') as HTMLElement | null;
    if (existing?.dataset.layer === layer) {
      existing.remove();
      this.container.querySelector(`.layer-explain-btn[data-layer="${layer}"]`)?.classList.remove('active');
      return;
    }
    existing?.remove();
    this.container.querySelectorAll('.layer-explain-btn.active').forEach(btn => btn.classList.remove('active'));

    const def = getLayersForVariant(SITE_VARIANT, 'globe').find(item => item.key === layer);
    const layerLabel = def ? resolveLayerLabel(def, t) : String(layer);
    const popup = document.createElement('div');
    popup.className = 'layer-explanation-popup';
    popup.dataset.layer = layer;
    setTrustedHtml(popup, trustedHtml(
      renderLayerExplanationCard(layerLabel, getLayerExplanation(layer)),
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

  // ─── Flush all current data to globe ──────────────────────────────────────

  private flushMarkers(): void {
    if (!this.globe || !this.initialized || this.destroyed || this.webglLost) return;
    if (this.renderPaused) { this.pendingFlushWhilePaused = true; return; }

    if (!this.flushMaxTimer) {
      this.flushMaxTimer = setTimeout(() => {
        this.flushMaxTimer = null;
        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        this.flushMarkersImmediate();
      }, 300);
    }
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.flushMaxTimer) { clearTimeout(this.flushMaxTimer); this.flushMaxTimer = null; }
      this.flushMarkersImmediate();
    }, 100);
  }

  private flushMarkersImmediate(): void {
    if (!this.globe || !this.initialized || this.destroyed || this.webglLost) return;
    this.wakeGlobe();

    // Grouped rather than concatenated so the budget can trim the feeds that are
    // actually oversized (#5368). Every marker here becomes a DOM node that
    // CSS2DRenderer repositions on every frame, so the total has to be bounded.
    const groups: GlobeMarkerGroup<GlobeMarker>[] = [];
    const add = (
      layer: string,
      markers: readonly GlobeMarker[],
      // Only the tuning knobs — spreading a full Partial would let a caller
      // silently overwrite the `layer`/`markers` this function just set.
      extra: Pick<Partial<GlobeMarkerGroup<GlobeMarker>>, 'rank' | 'exempt'> = {},
    ): void => { if (markers.length) groups.push({ layer, markers, ...extra }); };

    if (this.layers.nuclear) add('nuclear', this.nuclearSiteMarkers);
    if (this.layers.irradiators) add('irradiators', this.irradiatorSiteMarkers);
    if (this.layers.weather) add('weather', this.weatherMarkers);
    if (this.layers.natural) {
      add('natural', this.naturalMarkers);
      add('natural', this.earthquakeMarkers, { rank: m => (m._kind === 'earthquake' ? m.magnitude : 0) });
    }
    if (this.layers.radiationWatch) add('radiationWatch', this.radiationMarkers);
    if (this.layers.datacenters) add('datacenters', this.datacenterMarkers);
    if (this.layers.outages) {
      add('outages', this.outageMarkers);
      add('outages', this.trafficAnomalyMarkers);
      add('outages', this.ddosMarkers);
    }
    if (this.layers.fires) add('fires', this.fireMarkers, { rank: m => (m._kind === 'fire' ? m.brightness : 0) });
    if (this.layers.climate) add('climate', this.climateMarkers);
    if (this.layers.cables) {
      add('cables', this.cableAdvisoryMarkers);
      add('cables', this.repairShipMarkers);
    }
    if (this.layers.webcams) add('webcams', this.webcamMarkers);
    // Exempt like flash: `news` has no layer-toggle row, so a truncation here
    // would have nowhere to be disclosed. It was ungated before this change too.
    add('news', this.newsLocationMarkers, { exempt: true });
    // Flash markers are the "jump to this location" affordance — dropping one
    // would break navigation, and there are only ever a handful.
    add('flash', this.flashMarkers, { exempt: true });

    // Layers with no severity signal fall back to "nearest what the camera is
    // looking at" rather than raw feed order — see proximityRank. Without this a
    // capped nuclear layer would drop whichever sites sort last alphabetically.
    const pov = this.globe.pointOfView();
    const nearestFirst = proximityRank<GlobeMarker>(
      { lat: pov?.lat ?? 0, lng: pov?.lng ?? 0 },
      m => ({ lat: m._lat, lng: m._lng }),
    );
    for (const group of groups) {
      if (group.exempt) continue;
      // Unranked layers rank by nearness outright; ranked ones use it to break
      // ties, because a coarse severity rank would otherwise fall back to raw
      // feed order.
      if (group.rank) group.tieBreak = nearestFirst;
      else group.rank = nearestFirst;
    }

    const budget = isMobileDevice() ? GLOBE_MARKER_BUDGET_MOBILE : GLOBE_MARKER_BUDGET_DESKTOP;
    const { markers, truncated } = selectGlobeMarkers(groups, budget);
    try {
      this.globe.htmlElementsData(markers);
    } catch (err) {
      // The globe kept its previous markers, so leave the badges and the probe
      // describing what is actually on screen rather than what we intended.
      if (import.meta.env.DEV) console.warn('[GlobeMap] flush error', err);
      return;
    }

    this.markerTruncation = truncated;
    this.renderedMarkerCount = markers.length;
    this.markerBudgetProfile = budget === GLOBE_MARKER_BUDGET_MOBILE ? 'mobile' : 'desktop';
    this.updateLayerTruncationLabels();
    setGlobeMarkerLoad({
      rendered: markers.length,
      truncated,
      activeLayerCount: Object.values(this.layers).filter(Boolean).length,
      budgetProfile: this.markerBudgetProfile,
    });
  }

  private flushPaths(): void {
    if (!this.globe || !this.initialized || this.destroyed || this.webglLost) return;
    this.wakeGlobe();
    const showCables = this.layers.cables;
    const showPipelines = this.layers.pipelines;
    const paths = (showCables && showPipelines)
      ? this.globePaths
      : this.globePaths.filter(p => p.pathType === 'cable' ? showCables : showPipelines);
    const stormPaths = this.layers.natural ? this.stormTrackPaths : [];
    (this.globe as any).pathsData([...paths, ...stormPaths]);
  }

  private flushPolygons(): void {
    if (!this.globe || !this.initialized || this.destroyed || this.webglLost) return;
    this.wakeGlobe();
    const polys: GlobePolygon[] = [];

    if (this.layers.natural) {
      polys.push(...this.stormConePolygons);
    }

    (this.globe as any).polygonsData(polys);
  }

  // ─── Public data setters ──────────────────────────────────────────────────

  private initStaticLayers(): void {
    for (const k of Object.keys(this.layers) as (keyof MapLayers)[]) {
      if (this.layers[k]) this.ensureStaticDataForLayer(k);
    }
  }

  private ensureStaticDataForLayer(layer: keyof MapLayers): void {
    switch (layer) {
      case 'nuclear':
        if (!this.nuclearSiteMarkers.length) {
          this.nuclearSiteMarkers = NUCLEAR_FACILITIES
            .filter(f => f.status !== 'decommissioned')
            .map(f => ({
              _kind: 'nuclearSite' as const,
              _lat: f.lat,
              _lng: f.lon,
              id: f.id,
              name: f.name,
              type: f.type,
              status: f.status,
              operationalSince: f.operationalSince,
              treaties: f.treaties,
              iaeaStatus: f.iaeaStatus,
              keyEvents: f.keyEvents,
            }));
        }
        break;
      case 'irradiators':
        if (!this.irradiatorSiteMarkers.length) {
          this.irradiatorSiteMarkers = (GAMMA_IRRADIATORS as GammaIrradiator[]).map(g => ({
            _kind: 'irradiator' as const,
            _lat: g.lat,
            _lng: g.lon,
            id: g.id,
            city: g.city,
            country: g.country,
          }));
        }
        break;
      case 'datacenters':
        if (!this.datacenterMarkers.length) {
          this.datacenterMarkers = (AI_DATA_CENTERS as AIDataCenter[])
            .filter(d => d.status !== 'decommissioned')
            .map(d => ({
              _kind: 'datacenter' as const,
              _lat: d.lat,
              _lng: d.lon,
              id: d.id,
              name: d.name,
              owner: d.owner,
              country: d.country,
              chipType: d.chipType,
            }));
        }
        break;
      case 'cables':
      case 'pipelines':
        if (!this.globePaths.length) {
          this.globePaths = [
            ...(UNDERSEA_CABLES as UnderseaCable[]).map(c => ({
              id: c.id,
              name: c.name,
              points: c.points,
              pathType: 'cable' as const,
              status: 'ok',
            })),
            ...(PIPELINES as Pipeline[]).map(p => ({
              id: p.id,
              name: p.name,
              points: p.points,
              pathType: p.type,
              status: p.status,
            })),
          ];
        }
        break;
    }
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.weatherMarkers = (alerts ?? [])
      .filter(a => a.centroid != null)
      .map(a => ({
        _kind: 'weather' as const,
        _lat: a.centroid![1],   // centroid is [lon, lat]
        _lng: a.centroid![0],
        id: a.id,
        severity: a.severity ?? 'Minor',
        headline: a.headline ?? a.event ?? '',
      }));
    this.flushMarkers();
  }

  public setNaturalEvents(events: NaturalEvent[]): void {
    this.naturalMarkers = (events ?? []).map(e => ({
      _kind: 'natural' as const,
      _lat: e.lat,
      _lng: e.lon,
      id: e.id,
      category: e.category ?? '',
      title: e.title ?? '',
    }));

    const trackPaths: GlobePath[] = [];
    const conePolys: GlobePolygon[] = [];

    for (const e of events ?? []) {
      if (e.forecastTrack?.length) {
        trackPaths.push({
          id: `storm-forecast-${e.id}`,
          name: e.stormName || e.title || '',
          points: [
            [e.lon, e.lat, 0],
            ...e.forecastTrack.map(p => [p.lon, p.lat, 0]),
          ],
          pathType: 'stormTrack',
          status: 'active',
        });
      }
      if (e.pastTrack?.length) {
        let segIdx = 0;
        for (let i = 0; i < e.pastTrack.length - 1; i++) {
          const a = e.pastTrack[i]!;
          const b = e.pastTrack[i + 1]!;
          trackPaths.push({
            id: `storm-past-${e.id}-${segIdx++}`,
            name: e.stormName || e.title || '',
            points: [[a.lon, a.lat, 0], [b.lon, b.lat, 0]],
            pathType: 'stormHistory',
            status: 'active',
            windKt: b.windKt ?? a.windKt ?? 0,
          });
        }
      }
      if (e.conePolygon?.length) {
        for (const ring of e.conePolygon) {
          conePolys.push({
            coords: [ring],
            name: `${e.stormName || e.title || ''} Forecast Cone`,
            _kind: 'forecastCone',
          });
        }
      }
    }

    this.stormTrackPaths = trackPaths;
    this.stormConePolygons = conePolys;
    this.flushMarkers();
    this.flushPaths();
    this.flushPolygons();
  }

  // ─── Layer control ────────────────────────────────────────────────────────

  private static readonly LAYER_CHANNELS: Map<string, { markers: boolean; paths: boolean; polygons: boolean }> = new Map([
    ['pipelines',     { markers: false, paths: true,  polygons: false }],
    ['cables',        { markers: true,  paths: true,  polygons: false }],
    ['natural',       { markers: true,  paths: true,  polygons: true }],
    ['webcams',       { markers: true,  paths: false, polygons: false }],
  ]);

  private flushLayerChannels(layer: keyof MapLayers): void {
    const ch = GlobeMap.LAYER_CHANNELS.get(layer);
    if (!ch) { this.flushMarkers(); return; }
    if (ch.markers)  this.flushMarkers();
    if (ch.paths)    this.flushPaths();
    if (ch.polygons) this.flushPolygons();
  }

  public setLayers(layers: MapLayers): void {
    const prev = this.layers;
    this.layers = { ...layers, dayNight: false };
    let needMarkers = false, needPaths = false, needPolygons = false;
    for (const k of Object.keys(layers) as (keyof MapLayers)[]) {
      if (!prev[k] && layers[k]) this.ensureStaticDataForLayer(k);
      if (prev[k] === layers[k]) continue;
      const ch = GlobeMap.LAYER_CHANNELS.get(k);
      if (!ch) { needMarkers = true; continue; }
      if (ch.markers)  needMarkers = true;
      if (ch.paths)    needPaths = true;
      if (ch.polygons) needPolygons = true;
    }
    if (needMarkers)  this.flushMarkers();
    if (needPaths)    this.flushPaths();
    if (needPolygons) this.flushPolygons();
  }

  public enableLayer(layer: keyof MapLayers): void {
    if (layer === 'dayNight') return;
    if (this.layers[layer]) return;
    (this.layers as any)[layer] = true;
    this.ensureStaticDataForLayer(layer);
    const toggle = this.layerTogglesEl?.querySelector(`.layer-toggle[data-layer="${layer}"] input`) as HTMLInputElement | null;
    if (toggle) toggle.checked = true;
    this.flushLayerChannels(layer);
    this.enforceLayerLimit();
  }

  private layerWarningShown = false;
  private lastActiveLayerCount = 0;

  /**
   * Shows "shown/total" beside any layer the marker budget is trimming (#5368).
   * This is a monitoring product: quietly dropping 2,000 fire detections off the
   * globe would misrepresent the data, so the withholding is stated in the panel
   * that controls it.
   */
  private updateLayerTruncationLabels(): void {
    const root = this.layerTogglesEl;
    if (!root) return;
    renderLayerTruncationBadges(root, this.markerTruncation, 'rotate');
  }

  /**
   * Re-run marker selection after the camera settles, so proximity-ranked
   * layers follow the view (#5368).
   *
   * Only when something is actually being withheld: with nothing truncated the
   * selection is view-independent and a re-flush would churn DOM for no visible
   * change, on the very path this feature exists to make cheaper.
   */
  private reselectMarkersForViewport(): void {
    if (!Object.keys(this.markerTruncation).length) return;
    this.flushMarkers();
  }

  /** Markers currently handed to globe.gl, and what the budget withheld (#5368). */
  public getMarkerBudgetState(): { rendered: number; truncated: Record<string, GlobeLayerTruncation> } {
    return { rendered: this.renderedMarkerCount, truncated: this.markerTruncation };
  }

  private enforceLayerLimit(): void {
    if (!this.layerTogglesEl) return;
    const WARN_THRESHOLD = 13;
    const activeCount = Array.from(this.layerTogglesEl.querySelectorAll<HTMLInputElement>('.layer-toggle input'))
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

  // ─── Camera / navigation ──────────────────────────────────────────────────

  private static readonly VIEW_POVS: Record<MapView, { lat: number; lng: number; altitude: number }> = {
    global:   { lat: 20,  lng:  0,   altitude: 1.8 },
    america:  { lat: 20,  lng: -90,  altitude: 1.5 },
    mena:     { lat: 25,  lng:  40,  altitude: 1.2 },
    eu:       { lat: 50,  lng:  10,  altitude: 1.2 },
    asia:     { lat: 35,  lng: 105,  altitude: 1.5 },
    latam:    { lat: -15, lng: -60,  altitude: 1.5 },
    africa:   { lat:  5,  lng:  20,  altitude: 1.5 },
    oceania:  { lat: -25, lng: 140,  altitude: 1.5 },
  };

  private markViewportMoving(
    target: { lat: number; lng: number; altitude: number },
    durationMs: number,
  ): number {
    if (this.viewportAnimationFrame !== null) {
      cancelAnimationFrame(this.viewportAnimationFrame);
      this.viewportAnimationFrame = null;
    }
    // Concrete renderer entry points (buttons, marker clicks and fitCountry)
    // can bypass MapContainer's facade token. Give every one its own promise so
    // a superseding local command resolves the older caller as interrupted.
    this.resolveViewportSettled?.(false);
    this.viewportSettledPromise = new Promise((resolve) => {
      this.resolveViewportSettled = resolve;
    });
    const generation = ++this.viewportMovementGeneration;
    // OrbitControls updates auto-rotation in the same frame loop as globe.gl's
    // camera tween. Preserve its state across the whole tracked movement so it
    // cannot pull the camera away from the exact target before settlement is
    // observed. A superseding movement keeps the original pre-move state.
    if (this.controls && this.viewportAutoRotateBeforeMove === null) {
      this.viewportAutoRotateBeforeMove = this.controls.autoRotate;
      this.controls.autoRotate = false;
    }
    this.viewportTarget = target;
    this.viewportSettleDeadline = Date.now() + 15_000;
    if (this.viewportSettleTimer) clearTimeout(this.viewportSettleTimer);
    this.viewportSettleTimer = setTimeout(
      () => this.trySettleViewportMovement(false, generation),
      durationMs + 50,
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
    const pov = this.globe?.pointOfView();
    const longitudeDelta = target && pov
      ? Math.abs((((pov.lng - target.lng) + 540) % 360) - 180)
      : Number.POSITIVE_INFINITY;
    const atTarget = Boolean(!this.renderPaused && !document.hidden && target && pov
      && Math.abs(pov.lat - target.lat) <= 0.0001
      && longitudeDelta <= 0.0001
      && Math.abs(pov.altitude - target.altitude) <= 0.001);
    if (atTarget) {
      this.settleViewportMovement(true, generation);
      return;
    }
    if (finalMovementEvent) {
      this.settleViewportMovement(false, generation);
      return;
    }
    if (Date.now() >= this.viewportSettleDeadline) {
      this.settleViewportMovement(false, generation);
      return;
    }
    // globe.gl animations are driven by requestAnimationFrame, which can pause
    // in background tabs even as timers run. Keep polling instead of claiming
    // visual completion from elapsed wall-clock time alone.
    this.viewportSettleTimer = setTimeout(
      () => this.trySettleViewportMovement(false, generation),
      100,
    );
  }

  private settleViewportMovement(
    completed: boolean,
    generation = this.viewportMovementGeneration,
  ): void {
    if (generation !== this.viewportMovementGeneration) return;
    if (this.viewportAnimationFrame !== null) {
      cancelAnimationFrame(this.viewportAnimationFrame);
      this.viewportAnimationFrame = null;
    }
    if (this.viewportSettleTimer) {
      clearTimeout(this.viewportSettleTimer);
      this.viewportSettleTimer = null;
    }
    this.viewportTarget = null;
    this.viewportSettleDeadline = 0;
    this.viewportMovementGeneration++;
    const resolve = this.resolveViewportSettled;
    this.resolveViewportSettled = null;
    resolve?.(completed);
    if (!this.destroyed && this.viewportAutoRotateBeforeMove !== null) {
      if (this.renderPaused && this.controlsAutoRotateBeforePause !== null) {
        // Keep the renderer paused now, but let setRenderPaused(false) restore
        // the state that existed before the programmatic movement.
        this.controlsAutoRotateBeforePause = this.viewportAutoRotateBeforeMove;
      } else if (this.controls) {
        this.controls.autoRotate = this.viewportAutoRotateBeforeMove;
      }
    }
    this.viewportAutoRotateBeforeMove = null;
    if (!this.destroyed && this.globe) {
      this.reselectMarkersForViewport();
      this.onStateChangeCb?.(this.getState());
    }
  }

  public whenViewportSettled(): Promise<boolean> {
    return this.viewportSettledPromise;
  }

  private moveViewport(
    target: { lat: number; lng: number; altitude: number },
    durationMs = SET_CENTER_ROTATION_MS,
  ): void {
    if (!this.globe) return;
    this.wakeGlobe();
    const controls = this.controls;
    if (controls) {
      const autoRotate = controls.autoRotate;
      const enableDamping = controls.enableDamping;
      controls.autoRotate = false;
      controls.enableDamping = false;
      try {
        controls.update();
      } finally {
        controls.autoRotate = autoRotate;
        controls.enableDamping = enableDamping;
      }
    }
    const generation = this.markViewportMoving(target, durationMs);
    const start = this.globe.pointOfView();
    while (start.lng - target.lng > 180) start.lng -= 360;
    while (start.lng - target.lng < -180) start.lng += 360;
    const startedAt = performance.now();
    const animate = () => {
      if (generation !== this.viewportMovementGeneration || this.destroyed || !this.globe) return;
      this.viewportAnimationFrame = null;
      if (!this.renderPaused && !document.hidden) {
        const progress = durationMs <= 0 ? 1 : Math.min(1, (performance.now() - startedAt) / durationMs);
        const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
        this.globe.pointOfView(progress === 1 ? target : {
          lat: start.lat + (target.lat - start.lat) * eased,
          lng: start.lng + (target.lng - start.lng) * eased,
          altitude: start.altitude + (target.altitude - start.altitude) * eased,
        }, 0);
        if (progress === 1) {
          this.trySettleViewportMovement(false, generation);
          return;
        }
      }
      this.viewportAnimationFrame = requestAnimationFrame(animate);
    };
    animate();
  }

  public setView(view: MapView, zoom?: number): void {
    this.currentView = view;
    if (!this.globe) return;
    this.wakeGlobe();
    const preset = GlobeMap.VIEW_POVS[view] ?? GlobeMap.VIEW_POVS.global;
    const altitude = zoom === undefined ? preset.altitude : mapZoomToGlobeAltitude(zoom);
    // Programmatic moves emit no controls 'end' event, so publish state and
    // re-select markers once the transition has landed on the new POV.
    this.moveViewport({ lat: preset.lat, lng: preset.lng, altitude });
  }

  public setCenter(lat: number, lon: number, zoom?: number): void {
    if (!this.globe) return;
    this.wakeGlobe();
    const altitude = zoom === undefined ? 1.2 : mapZoomToGlobeAltitude(zoom);
    this.moveViewport({ lat, lng: lon, altitude });
  }

  public getCenter(): { lat: number; lon: number } | null {
    if (!this.globe) return null;
    const pov = this.globe.pointOfView();
    return pov ? { lat: pov.lat, lon: pov.lng } : null;
  }

  public getBbox(): string | null {
    if (!this.globe) return null;
    const pov = this.globe.pointOfView();
    if (!pov) return null;
    const alt = pov.altitude ?? 2.0;
    const R = Math.min(90, Math.max(5, alt * 30));
    const south = Math.max(-90, pov.lat - R);
    const north = Math.min(90, pov.lat + R);
    const west = Math.max(-180, pov.lng - R);
    const east = Math.min(180, pov.lng + R);
    return `${west.toFixed(4)},${south.toFixed(4)},${east.toFixed(4)},${north.toFixed(4)}`;
  }

  // ─── Resize ────────────────────────────────────────────────────────────────

  public resize(): void {
    if (!this.globe || this.destroyed) return;
    this.wakeGlobe();
    this.applyRenderQuality(undefined, this.container.clientWidth, this.container.clientHeight);
  }

  // ─── State API ────────────────────────────────────────────────────────────

  public getState(): MapContainerState {
    const altitude = this.globe?.pointOfView()?.altitude;
    return {
      zoom: globeAltitudeToMapZoom(altitude),
      pan: { x: 0, y: 0 },
      view: this.currentView,
      layers: this.layers,
      timeRange: this.timeRange,
    };
  }

  public setTimeRange(range: TimeRange): void {
    this.timeRange = range;
  }

  public getTimeRange(): TimeRange {
    return this.timeRange;
  }

  // ─── Callback setters ─────────────────────────────────────────────────────

  public setOnNewsClick(callback: (item: Pick<NewsLocationInput, 'article' | 'title'>) => void): void {
    this.onNewsClick = callback;
  }

  public setOnCountryClick(_cb: (c: CountryClickPayload) => void): void {
    // Globe country click not yet implemented — no-op
  }

  public setOnMapContextMenu(cb: (payload: { lat: number; lon: number; screenX: number; screenY: number }) => void): void {
    this.onMapContextMenuCb = cb;
  }

  // ─── No-op stubs (keep MapContainer happy) ────────────────────────────────
  public render(): void { this.resize(); }
  public setIsResizing(isResizing: boolean): void {
    // After drag-resize or fullscreen transition completes, re-sync dimensions
    if (!isResizing) this.resize();
  }
  public setZoom(zoom: number): void {
    if (!this.globe) return;
    const pov = this.globe.pointOfView();
    if (!pov) return;
    this.moveViewport({
      lat: pov.lat,
      lng: pov.lng,
      altitude: mapZoomToGlobeAltitude(zoom),
    });
  }
  public setRenderPaused(paused: boolean): void {
    if (this.renderPaused === paused) return;
    this.renderPaused = paused;

    if (paused) {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
      if (this.flushMaxTimer) { clearTimeout(this.flushMaxTimer); this.flushMaxTimer = null; }
      this.pendingFlushWhilePaused = true;
      if (this.autoRotateTimer) {
        clearTimeout(this.autoRotateTimer);
        this.autoRotateTimer = null;
      }
    }

    if (this.controls) {
      if (paused) {
        // A tracked movement temporarily forces autoRotate off. Preserve the
        // state that should exist after that movement, not the forced value,
        // so unpausing later restores the real pre-pause preference.
        this.controlsAutoRotateBeforePause = this.viewportAutoRotateBeforeMove
          ?? this.controls.autoRotate;
        this.controlsDampingBeforePause = this.controls.enableDamping;
        this.controls.autoRotate = false;
        this.controls.enableDamping = false;
      } else {
        if (this.controlsAutoRotateBeforePause !== null) {
          this.controls.autoRotate = this.controlsAutoRotateBeforePause;
        }
        if (this.controlsDampingBeforePause !== null) {
          this.controls.enableDamping = this.controlsDampingBeforePause;
        }
        this.controlsAutoRotateBeforePause = null;
        this.controlsDampingBeforePause = null;
      }
    }

    if (!paused && this.pendingFlushWhilePaused) {
      this.pendingFlushWhilePaused = false;
      this.flushMarkers();
    }
  }
  public highlightAssets(_assets: any): void {}
  public setOnLayerChange(cb: (layer: keyof MapLayers, enabled: boolean, source: 'user' | 'programmatic') => void): void {
    this.onLayerChangeCb = cb;
    if (this.pendingPremiumLayerChanges.size === 0) return;
    const pending = [...this.pendingPremiumLayerChanges];
    this.pendingPremiumLayerChanges.clear();
    for (const layer of pending) cb(layer, false, 'programmatic');
  }
  public setOnTimeRangeChange(_cb: any): void {}
  public hideLayerToggle(layer: keyof MapLayers): void {
    const toggle = this.layerTogglesEl?.querySelector(`.layer-toggle[data-layer="${layer}"]`);
    toggle?.closest('.layer-toggle-row')?.remove();
    toggle?.remove();
  }
  public setLayerLoading(layer: keyof MapLayers, loading: boolean): void {
    this.layerTogglesEl?.querySelector(`.layer-toggle[data-layer="${layer}"]`)?.classList.toggle('loading', loading);
  }
  public setLayerReady(layer: keyof MapLayers, hasData: boolean): void {
    this.layerTogglesEl?.querySelector(`.layer-toggle[data-layer="${layer}"]`)?.classList.toggle('no-data', !hasData);
  }
  public flashAssets(_type: string, _ids: string[]): void {}
  public flashLocation(lat: number, lon: number, durationMs = 2000): void {
    if (!this.globe || !this.initialized) return;
    const id = `flash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.flashMarkers.push({ _kind: 'flash', id, _lat: lat, _lng: lon });
    this.flushMarkers();
    setTimeout(() => {
      this.flashMarkers = this.flashMarkers.filter(m => m.id !== id);
      this.flushMarkers();
    }, durationMs);
  }
  public triggerPipelineClick(_id: string): void {}
  public triggerCableClick(_id: string): void {}
  public triggerDatacenterClick(_id: string): void {}
  public triggerNuclearClick(_id: string): void {}
  public triggerIrradiatorClick(_id: string): void {}
  public fitCountry(code: string): void {
    if (!this.globe) return;
    const bbox = getCountryBbox(code);
    if (!bbox) return;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const lat = (minLat + maxLat) / 2;
    const lng = (minLon + maxLon) / 2;
    const span = Math.max(maxLat - minLat, maxLon - minLon);
    // Map geographic span → altitude: large country (Russia ~170°) vs small (Luxembourg ~0.5°)
    const altitude = span > 60 ? 1.0 : span > 20 ? 0.7 : span > 8 ? 0.45 : span > 3 ? 0.25 : 0.12;
    this.moveViewport({ lat, lng, altitude }, 1200);
  }
  public highlightCountry(_code: string): void {}
  public clearCountryHighlight(): void {}
  public setEarthquakes(earthquakes: Earthquake[]): void {
    this.earthquakeMarkers = (earthquakes ?? [])
      .filter(e => e.location != null)
      .map(e => ({
        _kind: 'earthquake' as const,
        _lat: e.location!.latitude,
        _lng: e.location!.longitude,
        id: e.id,
        place: e.place ?? '',
        magnitude: e.magnitude ?? 0,
      }));
    this.flushMarkers();
  }

  public setRadiationObservations(observations: RadiationObservation[]): void {
    this.radiationMarkers = (observations ?? []).map((observation) => ({
      _kind: 'radiation' as const,
      _lat: observation.lat,
      _lng: observation.lon,
      id: observation.id,
      location: observation.location,
      country: observation.country,
      source: observation.source,
      contributingSources: observation.contributingSources,
      value: observation.value,
      unit: observation.unit,
      observedAt: observation.observedAt,
      freshness: observation.freshness,
      baselineValue: observation.baselineValue,
      delta: observation.delta,
      zScore: observation.zScore,
      severity: observation.severity,
      confidence: observation.confidence,
      corroborated: observation.corroborated,
      conflictingSources: observation.conflictingSources,
      convertedFromCpm: observation.convertedFromCpm,
      sourceCount: observation.sourceCount,
    }));
    this.flushMarkers();
  }

  public setOutages(outages: InternetOutage[]): void {
    this.outageMarkers = (outages ?? []).filter(o => o.lat != null && o.lon != null).map(o => ({
      _kind: 'outage' as const,
      _lat: o.lat,
      _lng: o.lon,
      id: o.id,
      title: o.title ?? '',
      severity: o.severity ?? 'partial',
      country: o.country ?? '',
    }));
    this.flushMarkers();
  }

  public setTrafficAnomalies(anomalies: ProtoTrafficAnomaly[]): void {
    this.trafficAnomalyMarkers = (anomalies ?? [])
      .filter(a => a.latitude !== 0 || a.longitude !== 0)
      .map(a => ({
        _kind: 'trafficAnomaly' as const,
        _lat: a.latitude,
        _lng: a.longitude,
        id: a.uuid || `ta-${a.locationCode}-${a.startDate}`,
        type: a.type || '',
        locationName: a.locationName || '',
      }));
    this.flushMarkers();
  }

  public setDdosLocations(hits: DdosLocationHit[]): void {
    this.ddosMarkers = (hits ?? [])
      .filter(h => h.latitude !== 0 || h.longitude !== 0)
      .map(h => ({
        _kind: 'ddosHit' as const,
        _lat: h.latitude,
        _lng: h.longitude,
        id: `ddos-${h.countryCode}`,
        countryName: h.countryName || '',
        percentage: h.percentage || 0,
      }));
    this.flushMarkers();
  }

  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    this.cableAdvisoryMarkers = (advisories ?? [])
      .filter(a => a.lat != null && a.lon != null)
      .map(a => ({
        _kind: 'cableAdvisory' as const,
        _lat: a.lat,
        _lng: a.lon,
        id: a.id,
        cableId: a.cableId,
        title: a.title ?? '',
        severity: a.severity,
        impact: a.impact ?? '',
        repairEta: a.repairEta ?? '',
      }));
    this.repairShipMarkers = (repairShips ?? [])
      .filter(r => r.lat != null && r.lon != null)
      .map(r => ({
        _kind: 'repairShip' as const,
        _lat: r.lat,
        _lng: r.lon,
        id: r.id,
        name: r.name ?? '',
        status: r.status,
        eta: r.eta ?? '',
        operator: r.operator ?? '',
      }));
    this.cableFaultIds    = new Set((advisories ?? []).filter(a => a.severity === 'fault').map(a => a.cableId));
    this.cableDegradedIds = new Set((advisories ?? []).filter(a => a.severity === 'degraded').map(a => a.cableId));
    this.flushMarkers();
    this.flushPaths();
  }
  public setCableHealth(_m: any): void {}
  public setNewsLocations(data: NewsLocationInput[]): void {
    this.newsLocationMarkers = (data ?? [])
      .filter(d => d.lat != null && d.lon != null)
      .map((d, i) => ({
        _kind: 'newsLocation' as const,
        _lat: d.lat,
        _lng: d.lon,
        id: `news-${i}-${d.title.slice(0, 20)}`,
        article: d.article,
        title: d.title,
        threatLevel: d.threatLevel ?? 'info',
        ...(d.corroboration ? { corroboration: d.corroboration } : {}),
      }));
    this.flushMarkers();
  }
  public setFires(fires: Array<{ lat: number; lon: number; brightness: number; region: string; [key: string]: any }>): void {
    this.fireMarkers = (fires ?? []).filter(f => f.lat != null && f.lon != null).map(f => ({
      _kind: 'fire' as const,
      _lat: f.lat,
      _lng: f.lon,
      id: (f.id as string | undefined) ?? `${f.lat},${f.lon}`,
      region: f.region ?? '',
      brightness: f.brightness ?? 330,
    }));
    this.flushMarkers();
  }
  public setWebcams(markers: Array<WebcamEntry | WebcamCluster>): void {
    this.webcamMarkers = markers.map(m => {
      if ('count' in m) {
        return { _kind: 'webcam-cluster' as const, _lat: m.lat, _lng: m.lng, count: m.count, categories: m.categories || [] };
      }
      return { _kind: 'webcam' as const, _lat: m.lat, _lng: m.lng, webcamId: m.webcamId, title: m.title, category: m.category || 'other', country: m.country || '' };
    });
    this.flushMarkers();
  }
  public setClimateAnomalies(anomalies: ClimateAnomaly[]): void {
    this.climateMarkers = (anomalies ?? []).filter(a => a.lat != null && a.lon != null).map(a => ({
      _kind: 'climate' as const,
      _lat: a.lat,
      _lng: a.lon,
      id: `${a.zone}-${a.period}`,
      zone: a.zone ?? '',
      type: a.type ?? 'mixed',
      severity: a.severity ?? 'normal',
      tempDelta: a.tempDelta ?? 0,
    }));
    this.flushMarkers();
  }
  public onTimeRangeChanged(_cb: (r: TimeRange) => void): void {}
  public onStateChanged(cb: (s: MapContainerState) => void): void { this.onStateChangeCb = cb; }

  private async applyEnhancedVisuals(): Promise<void> {
    if (!this.globe || this.destroyed) return;
    try {
      const THREE = await import('three');
      const scene = this.globe.scene();

      const oldMat = this.globe.globeMaterial();
      if (oldMat) {
        const stdMat = new THREE.MeshStandardMaterial({
          color: 0xffffff, roughness: 0.8, metalness: 0.1,
          emissive: new THREE.Color(0x0a1f2e), emissiveIntensity: 0.3,
        });
        if ((oldMat as any).map) stdMat.map = (oldMat as any).map;
        (this.globe as any).globeMaterial(stdMat);
      }

      this.cyanLight = new THREE.PointLight(0x00d4ff, 0.3);
      this.cyanLight.position.set(-10, -10, -10);
      scene.add(this.cyanLight);

      const outerGeo = new THREE.SphereGeometry(2.15, 24, 24);
      const outerMat = new THREE.MeshBasicMaterial({
        color: 0x00d4ff, side: THREE.BackSide, transparent: true, opacity: 0.15,
      });
      this.outerGlow = new THREE.Mesh(outerGeo, outerMat);
      scene.add(this.outerGlow);

      const innerGeo = new THREE.SphereGeometry(2.08, 24, 24);
      const innerMat = new THREE.MeshBasicMaterial({
        color: 0x00a8cc, side: THREE.BackSide, transparent: true, opacity: 0.1,
      });
      this.innerGlow = new THREE.Mesh(innerGeo, innerMat);
      scene.add(this.innerGlow);

      const starCount = 600;
      const starPositions = new Float32Array(starCount * 3);
      const starColors = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount; i++) {
        const r = 50 + Math.random() * 50;
        const theta = Math.random() * Math.PI * 2;
        const phi = Math.acos(2 * Math.random() - 1);
        starPositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
        starPositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
        starPositions[i * 3 + 2] = r * Math.cos(phi);
        const brightness = 0.5 + Math.random() * 0.5;
        starColors[i * 3] = brightness;
        starColors[i * 3 + 1] = brightness;
        starColors[i * 3 + 2] = brightness;
      }
      const starGeo = new THREE.BufferGeometry();
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
      starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
      const starMat = new THREE.PointsMaterial({ size: 0.1, vertexColors: true, transparent: true });
      this.starField = new THREE.Points(starGeo, starMat);
      scene.add(this.starField);

      this.startExtrasLoop();
    } catch { /* cosmetic — ignore */ }
  }

  private startExtrasLoop(): void {
    if (this.extrasAnimFrameId != null) return;
    const animateExtras = () => {
      if (this.destroyed) return;
      if (this.outerGlow) this.outerGlow.rotation.y += 0.0003;
      if (this.starField) this.starField.rotation.y += 0.00005;
      this.extrasAnimFrameId = requestAnimationFrame(animateExtras);
    };
    animateExtras();
  }

  private removeEnhancedVisuals(): void {
    if (!this.globe) return;
    if (this.extrasAnimFrameId != null) {
      cancelAnimationFrame(this.extrasAnimFrameId);
      this.extrasAnimFrameId = null;
    }
    const scene = this.globe.scene();
    for (const obj of [this.outerGlow, this.innerGlow, this.starField, this.cyanLight]) {
      if (!obj) continue;
      scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
    const mat = this.globe.globeMaterial();
    if (mat && (mat as any).isMeshStandardMaterial) {
      const texMap = (mat as any).map;
      mat.dispose();
      if (this.savedDefaultMaterial) {
        if (texMap) (this.savedDefaultMaterial as any).map = texMap;
        (this.globe as any).globeMaterial(this.savedDefaultMaterial);
      }
    }
    this.outerGlow = null;
    this.innerGlow = null;
    this.starField = null;
    this.cyanLight = null;
  }

  private applyVisualPreset(preset: GlobeVisualPreset): void {
    if (!this.globe || this.destroyed) return;
    if (preset === 'enhanced') {
      this.removeEnhancedVisuals();
      this.applyEnhancedVisuals();
    } else {
      this.removeEnhancedVisuals();
    }
  }

  // ─── Render quality & performance profile ────────────────────────────────

  private applyRenderQuality(scale?: GlobeRenderScale, width?: number, height?: number): void {
    if (!this.globe) return;
    try {
      const desktop = isDesktopRuntime();
      const pr = desktop
        ? Math.min(resolveGlobePixelRatio(scale ?? getGlobeRenderScale()), 1.25)
        : resolveGlobePixelRatio(scale ?? getGlobeRenderScale());
      const renderer = this.globe.renderer();
      renderer.setPixelRatio(pr);
      const w = (width ?? this.container.clientWidth) || window.innerWidth;
      const h = (height ?? this.container.clientHeight) || window.innerHeight;
      if (w > 0 && h > 0) this.globe.width(w).height(h);
    } catch { /* best-effort */ }
  }

  private applyPerformanceProfile(profile: GlobePerformanceProfile): void {
    if (!this.globe || !this.initialized || this.destroyed || this.webglLost) return;

    const prevPulse = this._pulseEnabled;
    this._pulseEnabled = !profile.disablePulseAnimations;

    if (profile.disableDashAnimations) {
      (this.globe as any).pathDashAnimateTime(0);
    } else {
      (this.globe as any).pathDashAnimateTime((d: GlobePath) => {
        if (!d) return 5000;
        if (d.pathType === 'cable') return 0;
        return 5000;
      });
    }

    if (profile.disableAtmosphere) {
      this.globe.atmosphereAltitude(0);
      if (this.outerGlow) this.outerGlow.visible = false;
      if (this.innerGlow) this.innerGlow.visible = false;
    } else {
      this.globe.atmosphereAltitude(0.18);
      if (this.outerGlow) this.outerGlow.visible = true;
      if (this.innerGlow) this.innerGlow.visible = true;
    }

    if (prevPulse !== this._pulseEnabled) {
      this.flushMarkers();
    }
  }

  // ─── Idle rendering control ──────────────────────────────────────────────
  // globe.gl runs requestAnimationFrame at 60fps continuously.
  // Pause when idle to save CPU; resume on interaction or data change.

  private wakeGlobe(): void {
    if (this.destroyed || !this.globe) return;
    if (!this.isGlobeAnimating) {
      this.isGlobeAnimating = true;
      try { (this.globe as any).resumeAnimation?.(); } catch { /* best-effort */ }
    }
    this.scheduleIdlePause();
  }

  private scheduleIdlePause(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // After 3 seconds of no interaction/data change, pause rendering
    this.idleTimer = setTimeout(() => {
      if (this.destroyed || !this.globe || this.renderPaused) return;
      // Don't pause if auto-rotate is active (user expects continuous spin)
      if (this.controls?.autoRotate || this.viewportTarget) return;
      this.isGlobeAnimating = false;
      try { (this.globe as any).pauseAnimation?.(); } catch { /* best-effort */ }
    }, 3000);
  }

  private setupVisibilityHandler(): void {
    this.visibilityHandler = () => {
      if (document.hidden) {
        if (this.isGlobeAnimating && this.globe) {
          this.isGlobeAnimating = false;
          try { (this.globe as any).pauseAnimation?.(); } catch { /* ignore */ }
        }
        if (this.extrasAnimFrameId != null) {
          cancelAnimationFrame(this.extrasAnimFrameId);
          this.extrasAnimFrameId = null;
        }
      } else {
        this.wakeGlobe();
        if (this.outerGlow && this.extrasAnimFrameId == null) {
          this.startExtrasLoop();
        }
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  // ─── Destroy ──────────────────────────────────────────────────────────────

  public destroy(): void {
    this.popup?.hide();
    this.popup = null;
    this.container.removeEventListener('contextmenu', this.handleContextMenu);
    this.unsubscribeGlobeQuality?.();
    this.unsubscribeGlobeQuality = null;
    this.unsubscribeGlobeTexture?.();
    this.unsubscribeGlobeTexture = null;
    this.unsubscribeVisualPreset?.();
    this.unsubscribeVisualPreset = null;
    this.premiumLayerGate?.destroy();
    this.premiumLayerGate = null;
    this.pendingPremiumLayerChanges.clear();
    // Stop attributing INP events to a globe that is no longer mounted (#5368).
    setGlobeMarkerLoad(null);
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (this.controlsStartHandler && this.controls) {
      this.controls.removeEventListener('start', this.controlsStartHandler);
      this.controlsStartHandler = null;
    }
    if (this.controlsEndHandler && this.controls) {
      this.controls.removeEventListener('end', this.controlsEndHandler);
      this.controlsEndHandler = null;
    }
    this.destroyed = true;
    this.settleViewportMovement(false);
    if (this.extrasAnimFrameId != null) {
      cancelAnimationFrame(this.extrasAnimFrameId);
      this.extrasAnimFrameId = null;
    }
    const scene = this.globe?.scene();
    for (const obj of [this.outerGlow, this.innerGlow, this.starField, this.cyanLight]) {
      if (!obj) continue;
      if (scene) scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
    if (this.globe) {
      const mat = this.globe.globeMaterial();
      if (mat && (mat as any).isMeshStandardMaterial) mat.dispose();
    }
    this.outerGlow = null;
    this.innerGlow = null;
    this.starField = null;
    this.cyanLight = null;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.flushMaxTimer) { clearTimeout(this.flushMaxTimer); this.flushMaxTimer = null; }
    if (this.autoRotateTimer) clearTimeout(this.autoRotateTimer);
    this.hideTooltip();
    this.controls = null;
    this.controlsAutoRotateBeforePause = null;
    this.controlsDampingBeforePause = null;
    this.viewportAutoRotateBeforeMove = null;
    this.layerTogglesEl = null;
    if (this.globe) {
      try { this.globe._destructor(); } catch { /* ignore */ }
      this.globe = null;
    }
    setTrustedHtml(this.container, trustedHtml('', "legacy direct innerHTML migration"));
    this.container.classList.remove('globe-mode');
    this.container.style.cssText = '';
  }
}
