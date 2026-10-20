import 'maplibre-gl/dist/maplibre-gl.css';
import '../styles/main.css';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { DeckGLMap } from '../components/DeckGLMap';
import {
  SITE_VARIANT,
  GAMMA_IRRADIATORS,
  PIPELINES,
} from '../config';
// ai-datacenters + geo-map tables imported directly so they stay off the eager @/config barrel (#4404).
import { AI_DATA_CENTERS } from '../config/ai-datacenters';
import { UNDERSEA_CABLES, NUCLEAR_FACILITIES } from '../config/geo-map';
import type {
  CableAdvisory,
  InternetOutage,
  MapLayers,
  NaturalEvent,
  RepairShip,
} from '../types';
import type { ClimateAnomaly } from '../services/climate';
import type { Earthquake } from '../services/earthquakes';
import type { DiseaseOutbreakItem } from '../services/disease-outbreaks';
import { I18N_RESOURCES_LOADED_EVENT, initI18n, t } from '../services/i18n';
import { setCachedPipelineRegistries } from '../shared/pipeline-registry-store';
import type { WeatherAlert } from '../services/weather';

type HarnessVariant = 'nuclear';
type HarnessLayerKey = keyof MapLayers;
type NewsPulseScenario = 'none' | 'recent' | 'stale';

type LayerSnapshot = {
  id: string;
  dataCount: number;
};

type OverlaySnapshot = {
  datacenterMarkers: number;
};

type CameraState = {
  lon: number;
  lat: number;
  zoom: number;
};

type VisualScenario = {
  id: string;
  variant: 'both' | HarnessVariant;
  enabledLayers: HarnessLayerKey[];
  camera: CameraState;
  expectedDeckLayers: string[];
  expectedSelectors: string[];
  includeNewsLocation?: boolean;
};

type VisualScenarioSummary = {
  id: string;
  variant: 'both' | HarnessVariant;
};

type MapHarness = {
  ready: boolean;
  variant: HarnessVariant;
  seedAllDynamicData: () => void;
  setNewsPulseScenario: (scenario: NewsPulseScenario) => void;
  forcePulseStartupElapsed: () => void;
  resetPulseStartupTime: () => void;
  isPulseAnimationRunning: () => boolean;
  setZoom: (zoom: number) => void;
  setLayersForSnapshot: (enabledLayers: HarnessLayerKey[]) => void;
  setCamera: (camera: CameraState) => void;
  enableDeterministicVisualMode: () => void;
  getVisualScenarios: () => VisualScenarioSummary[];
  prepareVisualScenario: (scenarioId: string) => boolean;
  isVisualScenarioReady: (scenarioId: string) => boolean;
  getDeckLayerSnapshot: () => LayerSnapshot[];
  getLayerDataCount: (layerId: string) => number;
  getLayerFirstScreenTransform: (layerId: string) => string | null;
  getOverlaySnapshot: () => OverlaySnapshot;
  destroy: () => void;
};

declare global {
  interface Window {
    __mapHarness?: MapHarness;
  }
}

const englishResourcesReady = new Promise<void>((resolve) => {
  window.addEventListener(I18N_RESOURCES_LOADED_EVENT, () => resolve(), { once: true });
});
await initI18n();
if (t('components.deckgl.layerWarningTitle').startsWith('components.')) {
  await englishResourcesReady;
}

const app = document.getElementById('app');
if (!app) {
  throw new Error('Missing #app container for map harness');
}

app.style.width = '1280px';
app.style.height = '720px';
app.style.position = 'relative';
app.style.margin = '0 auto';

const allLayersEnabled: MapLayers = {
  cables: true,
  pipelines: true,
  nuclear: true,
  irradiators: true,
  weather: true,
  outages: true,
  datacenters: true,
  natural: true,
  fires: true,
  climate: true,
  dayNight: true,
  webcams: false,
  diseaseOutbreaks: true,
};

const allLayersDisabled: MapLayers = {
  cables: false,
  pipelines: false,
  nuclear: false,
  irradiators: false,
  weather: false,
  outages: false,
  datacenters: false,
  natural: false,
  fires: false,
  climate: false,
  dayNight: false,
  webcams: false,
  diseaseOutbreaks: false,
};

const SEEDED_NEWS_LOCATIONS: Array<{
  lat: number;
  lon: number;
  title: string;
  threatLevel: string;
}> = [
  {
    lat: 48.85,
    lon: 2.35,
    title: 'Harness News Item',
    threatLevel: 'high',
  },
];

const SEEDED_DISEASE_OUTBREAKS: DiseaseOutbreakItem[] = [
  {
    id: 'e2e-disease-outbreak',
    disease: 'Harness Fever',
    location: 'Harness Province',
    countryCode: 'KE',
    alertLevel: 'warning',
    summary: 'Deterministic outbreak fixture for map smoke coverage.',
    sourceUrl: 'https://example.com/outbreak',
    publishedAt: Date.parse('2026-02-01T12:00:00.000Z'),
    sourceName: 'E2E Health Desk',
    lat: -1.29,
    lng: 36.82,
    cases: 37,
  },
];

const seededAllLayers: MapLayers = allLayersEnabled;

const initialLayers: MapLayers = { ...seededAllLayers };

const map = new DeckGLMap(app, {
  zoom: 5,
  pan: { x: 0, y: 0 },
  view: 'global',
  layers: initialLayers,
  // Keep harness deterministic regardless of wall-clock date.
  timeRange: 'all',
});

const DETERMINISTIC_BODY_CLASS = 'e2e-deterministic';

const internals = map as unknown as {
  buildLayers?: () => Array<{ id: string; props?: { data?: unknown } }>;
  maplibreMap?: MapLibreMap;
  getTooltip?: (info: { object?: unknown; layer?: { id?: string } }) => { html?: string } | null;
  newsLocationFirstSeen?: Map<string, number>;
  newsPulseIntervalId?: ReturnType<typeof setInterval> | null;
  startupTime?: number;
  stopPulseAnimation?: () => void;
};

const buildLayerState = (enabledLayers: HarnessLayerKey[]): MapLayers => {
  const next: MapLayers = { ...allLayersDisabled };
  for (const key of enabledLayers) {
    next[key] = true;
  }
  return next;
};

const setLayersForSnapshot = (enabledLayers: HarnessLayerKey[]): void => {
  map.setLayers(buildLayerState(enabledLayers));
};

const setCamera = (camera: CameraState): void => {
  const maplibreMap = internals.maplibreMap;
  if (!maplibreMap) return;
  maplibreMap.jumpTo({
    center: [camera.lon, camera.lat],
    zoom: camera.zoom,
  });
  map.render();
};

const getDataCount = (data: unknown): number => {
  if (Array.isArray(data)) return data.length;
  if (
    data &&
    typeof data === 'object' &&
    'type' in data &&
    (data as { type?: string }).type === 'FeatureCollection' &&
    'features' in data &&
    Array.isArray((data as { features?: unknown[] }).features)
  ) {
    return (data as { features: unknown[] }).features.length;
  }
  if (
    data &&
    typeof data === 'object' &&
    'length' in data &&
    typeof (data as { length?: unknown }).length === 'number'
  ) {
    return Number((data as { length: number }).length);
  }
  return data ? 1 : 0;
};

const getDeckLayerSnapshot = (): LayerSnapshot[] => {
  const layers = internals.buildLayers?.() ?? [];
  const counts = new Map<string, number>();

  for (const layer of layers) {
    const layerId = layer.id;
    const dataCount = getDataCount(layer.props?.data);
    const previous = counts.get(layerId) ?? 0;
    if (dataCount > previous) {
      counts.set(layerId, dataCount);
    }
  }

  return [...counts.entries()].map(([id, dataCount]) => ({ id, dataCount }));
};

const getLayerDataCount = (layerId: string): number => {
  return getDeckLayerSnapshot().find((layer) => layer.id === layerId)?.dataCount ?? 0;
};

const getLayerFirstScreenTransform = (layerId: string): string | null => {
  const maplibreMap = internals.maplibreMap;
  if (!maplibreMap) return null;

  const layers = internals.buildLayers?.() ?? [];
  const target = layers.find((layer) => layer.id === layerId);
  const data = target?.props?.data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const first = data[0] as {
    lon?: number;
    lng?: number;
    longitude?: number;
    lat?: number;
    latitude?: number;
  };

  const lon = first.lon ?? first.lng ?? first.longitude;
  const lat = first.lat ?? first.latitude;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;

  const point = maplibreMap.project([lon as number, lat as number]);
  return `translate(${point.x.toFixed(2)}px, ${point.y.toFixed(2)}px)`;
};

const getOverlaySnapshot = (): OverlaySnapshot => ({
  datacenterMarkers: document.querySelectorAll('.datacenter-marker').length,
});

const toCamera = (lon: number, lat: number, zoom: number): CameraState => ({
  lon,
  lat,
  zoom,
});

const firstLatLon = <T extends { lat: number; lon: number }>(
  items: T[],
  fallback: [number, number]
): [number, number] => {
  const first = items[0];
  if (!first) return fallback;
  return [first.lon, first.lat];
};

const firstPathPoint = <T extends { points: [number, number][] }>(
  items: T[],
  fallback: [number, number]
): [number, number] => {
  const firstPoint = items[0]?.points?.[0];
  if (!firstPoint || firstPoint.length < 2) return fallback;
  return [firstPoint[0], firstPoint[1]];
};

const seededCameras = {
  weather: toCamera(-80.2, 25.7, 5.2),
  outages: toCamera(-0.1, 51.5, 5.2),
  natural: toCamera(-118.2, 34.1, 4.8),
  fires: toCamera(-60.1, -5.4, 5.0),
  news: toCamera(2.35, 48.85, 5.0),
  diseaseOutbreaks: toCamera(36.82, -1.29, 5.2),
};

const [cableLon, cableLat] = firstPathPoint(UNDERSEA_CABLES, [38.0, 20.0]);
const [pipelineLon, pipelineLat] = firstPathPoint(PIPELINES, [45.0, 30.0]);
const [nuclearLon, nuclearLat] = firstLatLon(NUCLEAR_FACILITIES, [14.0, 50.0]);
const [irradiatorLon, irradiatorLat] = firstLatLon(GAMMA_IRRADIATORS, [12.0, 50.0]);
const [datacenterLon, datacenterLat] = firstLatLon(AI_DATA_CENTERS, [-121.9, 37.3]);

const VISUAL_SCENARIOS: VisualScenario[] = [
  {
    id: 'cables-z4',
    variant: 'both',
    enabledLayers: ['cables'],
    camera: toCamera(cableLon, cableLat, 4.2),
    expectedDeckLayers: ['cables-layer', 'cable-advisories-layer', 'repair-ships-layer'],
    expectedSelectors: [],
  },
  {
    id: 'pipelines-z4',
    variant: 'both',
    enabledLayers: ['pipelines'],
    camera: toCamera(pipelineLon, pipelineLat, 4.2),
    expectedDeckLayers: ['pipelines-layer'],
    expectedSelectors: [],
  },
  {
    id: 'nuclear-z5',
    variant: 'both',
    enabledLayers: ['nuclear'],
    camera: toCamera(nuclearLon, nuclearLat, 5.2),
    expectedDeckLayers: ['nuclear-layer'],
    expectedSelectors: [],
  },
  {
    id: 'irradiators-z5',
    variant: 'both',
    enabledLayers: ['irradiators'],
    camera: toCamera(irradiatorLon, irradiatorLat, 5.2),
    expectedDeckLayers: ['irradiators-layer'],
    expectedSelectors: [],
  },
  {
    id: 'weather-z5',
    variant: 'both',
    enabledLayers: ['weather'],
    camera: seededCameras.weather,
    expectedDeckLayers: ['weather-layer'],
    expectedSelectors: [],
  },
  {
    id: 'outages-z5',
    variant: 'both',
    enabledLayers: ['outages'],
    camera: seededCameras.outages,
    expectedDeckLayers: ['outages-layer'],
    expectedSelectors: [],
  },
  {
    id: 'datacenters-cluster-z3',
    variant: 'both',
    enabledLayers: ['datacenters'],
    camera: toCamera(datacenterLon, datacenterLat, 3.0),
    expectedDeckLayers: ['datacenter-clusters-layer'],
    expectedSelectors: [],
  },
  {
    id: 'datacenters-icons-z6',
    variant: 'both',
    enabledLayers: ['datacenters'],
    camera: toCamera(datacenterLon, datacenterLat, 6.0),
    expectedDeckLayers: ['datacenters-layer'],
    expectedSelectors: [],
  },
  {
    id: 'natural-z5',
    variant: 'both',
    enabledLayers: ['natural'],
    camera: seededCameras.natural,
    expectedDeckLayers: ['earthquakes-layer', 'natural-events-layer'],
    expectedSelectors: [],
  },
  {
    id: 'fires-z5',
    variant: 'both',
    enabledLayers: ['fires'],
    camera: seededCameras.fires,
    expectedDeckLayers: ['fires-layer'],
    expectedSelectors: [],
  },
  {
    id: 'news-z5',
    variant: 'both',
    enabledLayers: [],
    camera: seededCameras.news,
    expectedDeckLayers: ['news-locations-layer'],
    expectedSelectors: [],
    includeNewsLocation: true,
  },
];

const visualScenarioMap = new Map(VISUAL_SCENARIOS.map((scenario) => [scenario.id, scenario]));

const filterScenariosForVariant = (variant: HarnessVariant): VisualScenario[] => {
  return VISUAL_SCENARIOS.filter(
    (scenario) => scenario.variant === 'both' || scenario.variant === variant
  );
};

const currentHarnessVariant: HarnessVariant = SITE_VARIANT;

const seedAllDynamicData = (): void => {
  setCachedPipelineRegistries({
    gas: {
      pipelines: {
        'e2e-gas-pipeline': {
          id: 'e2e-gas-pipeline',
          name: 'Harness Gas Trunkline',
          operator: 'Harness Gas Co.',
          commodityType: 'gas',
          startPoint: { lat: 25.28, lon: 55.3 },
          endPoint: { lat: 26.12, lon: 50.57 },
        },
      },
      classifierVersion: 'e2e-harness-v1',
      updatedAt: '2026-02-01T12:00:00.000Z',
    },
    oil: {
      pipelines: {
        'e2e-oil-pipeline': {
          id: 'e2e-oil-pipeline',
          name: 'Harness Crude Link',
          operator: 'Harness Oil Co.',
          commodityType: 'oil',
          startPoint: { lat: 29.37, lon: 47.98 },
          endPoint: { lat: 25.27, lon: 51.53 },
        },
      },
      classifierVersion: 'e2e-harness-v1',
      updatedAt: '2026-02-01T12:00:00.000Z',
    },
  });

  const earthquakes: Earthquake[] = [
    {
      id: 'e2e-eq-1',
      place: 'Harness Fault',
      magnitude: 5.8,
      depthKm: 12,
      location: { latitude: 34.1, longitude: -118.2 },
      occurredAt: new Date('2026-02-01T10:00:00.000Z').getTime(),
      sourceUrl: 'https://example.com/eq',
      nearTestSite: false,
      testSiteName: '',
      concernScore: 0,
      concernLevel: '',
      source: 'usgs',
      category: '',
    },
  ];

  const weather: WeatherAlert[] = [
    {
      id: 'e2e-weather-1',
      event: 'Storm Warning',
      severity: 'Severe',
      headline: 'Harness Weather Alert',
      description: 'Severe storm conditions expected in harness region.',
      areaDesc: 'Harness Region',
      onset: new Date('2026-02-01T09:00:00.000Z'),
      expires: new Date('2026-02-01T18:00:00.000Z'),
      coordinates: [[-80.1, 25.7], [-80.2, 25.8], [-80.3, 25.6]],
      centroid: [-80.2, 25.7],
    },
  ];

  const outages: InternetOutage[] = [
    {
      id: 'e2e-outage-1',
      title: 'Harness Network Degradation',
      link: 'https://example.com/outage',
      description: 'Network disruption for test coverage.',
      pubDate: new Date('2026-02-01T11:00:00.000Z'),
      country: 'Harnessland',
      lat: 51.5,
      lon: -0.1,
      severity: 'major',
      categories: ['connectivity'],
    },
  ];

  const cableAdvisories: CableAdvisory[] = [
    {
      id: 'e2e-cable-adv-1',
      cableId: 'seamewe_5',
      title: 'Harness Cable Fault',
      severity: 'fault',
      description: 'Fiber disruption under investigation.',
      reported: new Date('2026-02-01T08:00:00.000Z'),
      lat: 12.2,
      lon: 45.2,
      impact: 'Regional latency increase',
      repairEta: '24h',
    },
  ];

  const repairShips: RepairShip[] = [
    {
      id: 'e2e-repair-1',
      name: 'Harness Repair Vessel',
      cableId: 'seamewe_5',
      status: 'enroute',
      lat: 12.5,
      lon: 45.1,
      eta: '2026-02-02T00:00:00Z',
      note: 'En route to suspected break location.',
    },
  ];

  const naturalEvents: NaturalEvent[] = [
    {
      id: 'e2e-natural-1',
      title: '🔴 Harness Volcano Activity',
      category: 'volcanoes',
      categoryTitle: 'Volcano',
      lat: 14.7,
      lon: -90.9,
      date: new Date('2026-02-01T06:00:00.000Z'),
      closed: false,
    },
  ];

  const climateAnomalies: ClimateAnomaly[] = [
    {
      zone: 'Harness Heat Belt',
      lat: 24.8,
      lon: 54.9,
      tempDelta: 3.2,
      precipDelta: -12,
      severity: 'extreme',
      type: 'warm',
      period: '2026-02',
    },
  ];

  map.setRenderPaused(true);
  map.setLayers(seededAllLayers);
  map.setZoom(5);
  map.setEarthquakes(earthquakes);
  map.setWeatherAlerts(weather);
  map.setOutages(outages);
  map.setCableActivity(cableAdvisories, repairShips);
  map.setNaturalEvents(naturalEvents);
  map.setClimateAnomalies(climateAnomalies);
  map.setDiseaseOutbreaks(SEEDED_DISEASE_OUTBREAKS);
  map.setFires([
    {
      lat: -5.4,
      lon: -60.1,
      brightness: 420,
      frp: 180,
      confidence: 0.95,
      region: 'Harness Fire Region',
      acq_date: '2026-02-01',
      daynight: 'D',
    },
  ]);
  map.setNewsLocations(SEEDED_NEWS_LOCATIONS);
  map.setRenderPaused(false);
  map.render();
};

const makeNewsLocationsNonRecent = (): void => {
  const now = Date.now();
  if (internals.newsLocationFirstSeen) {
    for (const key of internals.newsLocationFirstSeen.keys()) {
      internals.newsLocationFirstSeen.set(key, now - 120_000);
    }
  }
  internals.stopPulseAnimation?.();
};

const setNewsPulseScenario = (scenario: NewsPulseScenario): void => {
  if (scenario === 'none') {
    internals.newsLocationFirstSeen?.clear();
    map.setNewsLocations([]);
    return;
  }

  if (scenario === 'recent') {
    map.setNewsLocations([
      {
        lat: 48.85,
        lon: 2.35,
        title: `Harness Pulse News ${Date.now()}`,
        threatLevel: 'high',
      },
    ]);
    return;
  }

  map.setNewsLocations(SEEDED_NEWS_LOCATIONS);
  makeNewsLocationsNonRecent();
};

let deterministicVisualModeEnabled = false;
const DETERMINISTIC_STYLE_ID = 'e2e-deterministic-style';

const ensureDeterministicStyles = (): void => {
  if (document.getElementById(DETERMINISTIC_STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = DETERMINISTIC_STYLE_ID;
  style.textContent = `
    body.${DETERMINISTIC_BODY_CLASS} *,
    body.${DETERMINISTIC_BODY_CLASS} *::before,
    body.${DETERMINISTIC_BODY_CLASS} *::after {
      animation: none !important;
      transition: none !important;
    }

    body.${DETERMINISTIC_BODY_CLASS} .deckgl-controls,
    body.${DETERMINISTIC_BODY_CLASS} .deckgl-time-slider,
    body.${DETERMINISTIC_BODY_CLASS} .deckgl-layer-toggles,
    body.${DETERMINISTIC_BODY_CLASS} .deckgl-legend,
    body.${DETERMINISTIC_BODY_CLASS} .deckgl-timestamp,
    body.${DETERMINISTIC_BODY_CLASS} .maplibregl-ctrl-bottom-right,
    body.${DETERMINISTIC_BODY_CLASS} .maplibregl-ctrl-bottom-left {
      display: none !important;
    }
  `;
  document.head.appendChild(style);
};

const hideRasterBasemap = (): void => {
  const maplibreMap = internals.maplibreMap;
  if (!maplibreMap) return;

  try {
    if (maplibreMap.getLayer('carto-dark-layer')) {
      maplibreMap.setPaintProperty('carto-dark-layer', 'raster-opacity', 0);
    }
  } catch {
    // No-op for harness stability.
  }
};

const enableDeterministicVisualMode = (): void => {
  document.body.classList.add(DETERMINISTIC_BODY_CLASS);
  ensureDeterministicStyles();
  hideRasterBasemap();
  makeNewsLocationsNonRecent();
  map.render();
  deterministicVisualModeEnabled = true;
};

const prepareVisualScenario = (scenarioId: string): boolean => {
  const scenario = visualScenarioMap.get(scenarioId);
  if (!scenario) return false;

  enableDeterministicVisualMode();

  map.setRenderPaused(true);
  setLayersForSnapshot(scenario.enabledLayers);
  map.setNewsLocations(scenario.includeNewsLocation ? SEEDED_NEWS_LOCATIONS : []);
  if (!scenario.includeNewsLocation) {
    makeNewsLocationsNonRecent();
  }
  setCamera(scenario.camera);
  map.setRenderPaused(false);
  map.render();

  return true;
};

const isVisualScenarioReady = (scenarioId: string): boolean => {
  const scenario = visualScenarioMap.get(scenarioId);
  if (!scenario) return false;

  const layersById = new Map<string, number>(
    getDeckLayerSnapshot().map((layer) => [layer.id, layer.dataCount])
  );

  for (const expectedLayerId of scenario.expectedDeckLayers) {
    if ((layersById.get(expectedLayerId) ?? 0) <= 0) {
      return false;
    }
  }

  for (const selector of scenario.expectedSelectors) {
    if (document.querySelectorAll(selector).length <= 0) {
      return false;
    }
  }

  return true;
};

seedAllDynamicData();

let ready = false;
const readyStartedAt = Date.now();
const STYLE_READY_FALLBACK_MS = 12_000;
const pollReady = (): void => {
  const hasCanvas = Boolean(document.querySelector('#deckgl-basemap canvas'));
  const maplibreMap = internals.maplibreMap;
  const styleLoaded = Boolean(maplibreMap?.isStyleLoaded());
  const allowStyleFallback =
    hasCanvas &&
    Boolean(maplibreMap) &&
    Date.now() - readyStartedAt >= STYLE_READY_FALLBACK_MS;

  if ((hasCanvas && styleLoaded) || allowStyleFallback) {
    if (!deterministicVisualModeEnabled) {
      enableDeterministicVisualMode();
    }
    ready = true;
    return;
  }

  requestAnimationFrame(pollReady);
};
pollReady();

window.__mapHarness = {
  get ready() {
    return ready;
  },
  variant: currentHarnessVariant,
  seedAllDynamicData,
  setNewsPulseScenario,
  forcePulseStartupElapsed: (): void => {
    internals.startupTime = Date.now() - 61_000;
  },
  resetPulseStartupTime: (): void => {
    internals.startupTime = Date.now();
  },
  isPulseAnimationRunning: (): boolean => {
    return internals.newsPulseIntervalId != null;
  },
  setZoom: (zoom: number): void => {
    map.setZoom(zoom);
    map.render();
  },
  setLayersForSnapshot,
  setCamera,
  enableDeterministicVisualMode,
  getVisualScenarios: (): VisualScenarioSummary[] => {
    return filterScenariosForVariant(currentHarnessVariant).map((scenario) => ({
      id: scenario.id,
      variant: scenario.variant,
    }));
  },
  prepareVisualScenario,
  isVisualScenarioReady,
  getDeckLayerSnapshot,
  getLayerDataCount,
  getLayerFirstScreenTransform,
  getOverlaySnapshot,
  destroy: (): void => {
    map.destroy();
  },
};
