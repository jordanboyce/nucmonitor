import type { MapLayers } from '@/types';

/**
 * The three concrete map renderers a layer can be painted by. This is the
 * single renderer axis: `'svg'` (D3/SVG mobile fallback in Map.ts), `'deck'`
 * (WebGL DeckGLMap), and `'globe'` (globe.gl GlobeMap). It mirrors
 * MapContainer's `RendererKind` (computed by `getPendingRendererKind()`), which
 * imports this type so the picker, dispatcher, and shell stay in lockstep.
 */
export type RendererKind = 'svg' | 'deck' | 'globe';
export type MapVariant = 'nuclear';

export interface LayerDefinition {
  key: keyof MapLayers;
  icon: string;
  i18nSuffix: string;
  fallbackLabel: string;
  /**
   * Every renderer that has a real paint path for this layer. A layer executes
   * (picker toggle / CMD+K dispatch) under a renderer only if that renderer is
   * listed here — this is the whole gate. A DeckGL-only layer is `['deck']`; a
   * layer painted by both DeckGL and the globe (e.g. the CII choropleth) is
   * `['deck', 'globe']`; a layer on every surface is `['svg', 'deck', 'globe']`.
   */
  renderers: RendererKind[];
  premium?: 'locked' | 'enhanced';
}

export type LayerExplanationCoverage = 'curated' | 'fallback';

export interface LayerExplanation {
  key: keyof MapLayers;
  coverage: LayerExplanationCoverage;
  category: string;
  purpose: string;
  source: string;
  freshness: string;
  confidence: string;
  limitations: string[];
  related: string[];
  evidence: string[];
}

const def = (
  key: keyof MapLayers,
  icon: string,
  i18nSuffix: string,
  fallbackLabel: string,
  renderers: RendererKind[] = ['svg', 'deck', 'globe'],
  premium?: 'locked' | 'enhanced',
): LayerDefinition => ({
  key, icon, i18nSuffix, fallbackLabel, renderers,
  ...(premium && { premium }),
});

export const LAYER_REGISTRY: Record<keyof MapLayers, LayerDefinition> = {
  nuclear:                  def('nuclear',                  '&#9762;',   'nuclearSites',             'Nuclear Sites'),
  irradiators:              def('irradiators',              '&#9888;',   'gammaIrradiators',         'Gamma Irradiators'),
  usNuclearFacilities:      def('usNuclearFacilities',      '&#9762;',   'usNuclearFacilities',      'US Nuclear Facilities', ['svg', 'deck']),
  radiationWatch:           def('radiationWatch',           '&#9762;',   'radiationWatch',           'Radiation Watch'),

  cables:                   def('cables',                   '&#128268;', 'underseaCables',           'Undersea Cables'),
  pipelines:                def('pipelines',                '&#128738;', 'pipelines',                'Pipelines'),
  datacenters:              def('datacenters',              '&#128421;', 'aiDataCenters',            'AI Data Centers'),
  climate:                  def('climate',                  '&#127787;', 'climateAnomalies',         'Climate Anomalies'),
  weather:                  def('weather',                  '&#9928;',   'weatherAlerts',            'Severe Weather Alerts (NWS, ECCC, WMO SWIC)'),
  outages:                  def('outages',                  '&#128225;', 'internetOutages',          'Internet Disruptions'),
  natural:                  def('natural',                  '&#127755;', 'naturalEvents',            'Natural Events'),
  fires:                    def('fires',                    '&#128293;', 'fires',                    'Fires'),
  dayNight:                 def('dayNight',                 '&#127763;', 'dayNight',                 'Day/Night', ['svg', 'deck']),
  webcams:                  def('webcams',                  '&#128247;', 'webcams',                  'Live Webcams'),
  // weatherRadar removed — radar tiles now auto-start when Weather Alerts layer is toggled on
  diseaseOutbreaks:         def('diseaseOutbreaks',         '&#129440;', 'diseaseOutbreaks',         'Disease Outbreaks', ['deck']),
};

export const V1_LAYER_EXPLANATION_KEYS = [
  'natural',
  'weather',
  'usNuclearFacilities',
] as const satisfies readonly (keyof MapLayers)[];

export const LAYER_EXPLANATIONS: Partial<Record<keyof MapLayers, LayerExplanation>> = {
  natural: {
    key: 'natural',
    coverage: 'curated',
    category: 'Natural Disasters',
    purpose: 'Shows earthquakes, severe disaster alerts, and active Earth-observation events for situational awareness.',
    source: 'USGS earthquakes, GDACS alerts, and NASA EONET events merged into the natural events service.',
    freshness: 'Natural events are seeded every 3 hours; USGS earthquake expectations are documented at roughly 5-minute source cadence.',
    confidence: 'Strong for detected public disaster signals; confidence varies by hazard type and upstream reporting latency.',
    limitations: [
      'Low-severity GDACS alerts are filtered out to keep the map readable.',
      'EONET wildfires are freshness-filtered, so older open events may not appear as active map points.',
    ],
    related: ['Natural Events layer popups', 'Severe Weather Alerts (NWS, ECCC, WMO SWIC)', 'Country brief natural signals'],
    evidence: ['docs/data-sources.mdx', 'docs/natural-disasters.mdx', 'server/worldmonitor/natural/v1/list-natural-events.ts'],
  },
  weather: {
    key: 'weather',
    coverage: 'curated',
    category: 'Weather',
    purpose: 'Shows active official severe-weather alerts from national meteorological services, merged into one weather:alerts:v1 feed.',
    source: 'United States National Weather Service (NWS), Environment and Climate Change Canada (ECCC), and WMO Severe Weather Information Centre (SWIC) CAP aggregation, seeded through the NucMonitor relay.',
    freshness: 'NWS, ECCC, and SWIC alerts are seeded every 15 minutes by the relay and monitored against a 45-minute freshness budget.',
    confidence: 'Authoritative for alerts issued by the contributing national services, subject to upstream publication timing. NWS and ECCC render as polygons; SWIC geocoded alerts render at the issuing service country centroid with an explicit precision marker.',
    limitations: [
      'Most SWIC members publish geocodes, not polygons; those alerts appear as country-level points with the verbatim area description, not warned-area overlays.',
      'SWIC coverage depends on which WMO members currently publish to the aggregator; density varies by region.',
      'US and Canadian SWIC rows are skipped because NWS and ECCC already supply polygon-tier coverage for those countries.',
    ],
    related: ['Natural Events layer', 'Weather alert popups', 'Data freshness status'],
    evidence: ['scripts/ais-relay.cjs', 'scripts/_weather-alert-select.mjs', 'api/health.js', 'src/services/weather.ts'],
  },
  usNuclearFacilities: {
    key: 'usNuclearFacilities',
    coverage: 'curated',
    category: 'Nuclear facilities',
    purpose: 'Every US nuclear facility in the NucMonitor registry: operating power reactors, restart programs, advanced reactor builds, decommissioning and spent fuel sites, DOE/NNSA complex, fuel cycle plants, research reactors, uranium recovery, and waste sites, colored by category.',
    source: 'Curated registry (src/config/us-nuclear-facilities.ts) compiled from the NRC facility locator and operating reactor list, DOE/NNSA site pages, and operator disclosures.',
    freshness: 'Static registry reviewed periodically; the review date is printed in the directory panel footer.',
    confidence: 'High for site identity and location; capacities and license dates may lag uprates and renewals.',
    limitations: [
      'Not a live operational status — pair with the NRC Reactor Power Status panel.',
      'Coordinates are site centroids, not exclusion-area boundaries or emergency planning zones.',
    ],
    related: ['NRC Reactor Power Status panel', 'Facility All-Hazards Watch panel', 'US Nuclear Facility Directory panel', 'Radiation Watch layer'],
    evidence: ['src/config/us-nuclear-facilities.ts', 'docs/nuclear-hub.mdx'],
  },
};

const VARIANT_LAYER_ORDER: Record<MapVariant, Array<keyof MapLayers>> = {
  nuclear: [
    // NucMonitor — facilities first, then every hazard layer that can touch a site
    'usNuclearFacilities', 'radiationWatch', 'natural', 'weather', 'fires', 'outages',
    'nuclear', 'irradiators', 'climate', 'dayNight',
  ],
};

const I18N_PREFIX = 'components.deckgl.layers.';

export function getOrderedLayerKeys(variant: MapVariant): Array<keyof MapLayers> {
  return VARIANT_LAYER_ORDER[variant] ?? VARIANT_LAYER_ORDER.nuclear;
}

export function getCompleteLayerCatalogKeys(variant: MapVariant): Array<keyof MapLayers> {
  const primary = getOrderedLayerKeys(variant);
  const seen = new Set(primary);
  const rest = (Object.keys(LAYER_REGISTRY) as Array<keyof MapLayers>)
    .filter(k => !seen.has(k));
  return [...primary, ...rest];
}

export function getLayersForVariant(variant: MapVariant, kind: RendererKind): LayerDefinition[] {
  return getOrderedLayerKeys(variant)
    .map(k => LAYER_REGISTRY[k])
    .filter(d => d.renderers.includes(kind));
}

export function getAllowedLayerKeys(variant: MapVariant): Set<keyof MapLayers> {
  return new Set(getOrderedLayerKeys(variant));
}

export function sanitizeLayersForVariant(layers: MapLayers, variant: MapVariant): MapLayers {
  const allowed = getAllowedLayerKeys(variant);
  const sanitized = { ...layers };
  for (const key of Object.keys(sanitized) as Array<keyof MapLayers>) {
    if (!allowed.has(key)) sanitized[key] = false;
  }
  return sanitized;
}

/**
 * Checks whether a layer can actually render under the active renderer. Used
 * by both the layer picker UI and the CMD+K dispatcher to hide / silently-skip
 * toggles that would be a no-op.
 *
 * The layer's declared `renderers` must include `kind`. Because the axis now
 * distinguishes `'svg'` from `'deck'`, a DeckGL-only layer (`['deck']`) is
 * naturally rejected on the SVG fallback and on the globe — no separate flag.
 */
export function isLayerExecutable(
  layerKey: keyof MapLayers,
  kind: RendererKind,
): boolean {
  const def = LAYER_REGISTRY[layerKey];
  if (!def) return false;
  return def.renderers.includes(kind);
}

/**
 * Whether the user may enable a layer given their premium status.
 *
 * Matches DeckGLMap's layer-picker contract:
 *   - `premium: 'locked'` → disabled checkbox for free users (must not enable)
 *   - `premium: 'enhanced'` → PRO badge only; free users can still toggle
 *   - no premium flag → free for everyone
 *
 * Used by CMD+K (`search-manager`) and programmatic enable paths so free
 * users cannot force a locked layer on (which left a stuck checked+disabled
 * checkbox and could mutual-exclude a free layer — #6045).
 */
export function isLayerEntitled(
  layerKey: keyof MapLayers,
  hasPremium: boolean,
): boolean {
  const def = LAYER_REGISTRY[layerKey];
  if (!def) return false;
  if (def.premium === 'locked' && !hasPremium) return false;
  return true;
}

/**
 * Whether a layer toggle may be applied from the current state.
 *
 * A free user may turn a locked layer off when stale state survives from an
 * older build, but must not be able to turn it on. Keeping that distinction
 * makes every toggle entry point able to heal old state without reopening the
 * activation path (#6045).
 */
export function isLayerToggleAllowed(
  layerKey: keyof MapLayers,
  currentlyEnabled: boolean | undefined,
  hasPremium: boolean,
): boolean {
  if (!LAYER_REGISTRY[layerKey]) return false;
  return currentlyEnabled === true || isLayerEntitled(layerKey, hasPremium);
}

/**
 * Whether a CMD+K layer command may toggle the layer in the current map
 * context. This keeps renderer compatibility and entitlement in one policy
 * used by the palette filter and its dispatch paths.
 */
export function isLayerCommandAllowed(
  layerKey: keyof MapLayers,
  currentlyEnabled: boolean | undefined,
  kind: RendererKind,
  hasPremium: boolean,
): boolean {
  return isLayerExecutable(layerKey, kind)
    && isLayerToggleAllowed(layerKey, currentlyEnabled, hasPremium);
}

/**
 * Whether locked-layer state may be persisted as a free-tier decision.
 *
 * A pending auth session is intentionally not enough: a paying user is
 * indistinguishable from an anonymous user during boot. The explicit fallback
 * signal is the bounded exception used when that session never settles.
 */
export function shouldSanitizeLockedLayers(
  hasPremium: boolean,
  tierResolved: boolean,
  fallbackActive = false,
): boolean {
  return !hasPremium && (tierResolved || fallbackActive);
}

/**
 * Force locked premium layers off when the user is not entitled.
 * Heals stuck localStorage/state left by pre-#6045 CMD+K activation.
 * Does not mutate the input object.
 */
export function sanitizeLockedLayers(
  layers: MapLayers,
  hasPremium: boolean,
): MapLayers {
  if (hasPremium) return layers;
  let changed = false;
  const sanitized = { ...layers };
  for (const key of Object.keys(sanitized) as Array<keyof MapLayers>) {
    if (sanitized[key] && LAYER_REGISTRY[key]?.premium === 'locked') {
      sanitized[key] = false;
      changed = true;
    }
  }
  return changed ? sanitized : layers;
}

export interface LockedLayerOwnershipResult {
  layers: MapLayers;
  gateOwned: Set<string>;
}

export function mapLayerStatesEqual(a: MapLayers, b: MapLayers): boolean {
  const keys = Object.keys(a) as Array<keyof MapLayers>;
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Sanitize locked layers while remembering which enabled preferences the
 * free-tier gate forced off. Existing ownership is retained across idempotent
 * reconciliation passes where the persisted layer is already false.
 */
export function sanitizeLockedLayersWithOwnership(
  layers: MapLayers,
  existingGateOwned: ReadonlySet<string>,
): LockedLayerOwnershipResult {
  const gateOwned = new Set(
    [...existingGateOwned].filter((key) => (
      LAYER_REGISTRY[key as keyof MapLayers]?.premium === 'locked'
    )),
  );
  for (const key of Object.keys(layers) as Array<keyof MapLayers>) {
    if (layers[key] && LAYER_REGISTRY[key]?.premium === 'locked') {
      gateOwned.add(key);
    }
  }
  return {
    layers: sanitizeLockedLayers(layers, false),
    gateOwned,
  };
}

/** Restore only valid premium layers previously disabled by the free gate. */
export function restoreGateOwnedLockedLayers(
  layers: MapLayers,
  gateOwned: ReadonlySet<string>,
): MapLayers {
  let changed = false;
  const restored = { ...layers };
  for (const rawKey of gateOwned) {
    const key = rawKey as keyof MapLayers;
    if (LAYER_REGISTRY[key]?.premium !== 'locked' || restored[key] === true) continue;
    restored[key] = true;
    changed = true;
  }
  return changed ? restored : layers;
}

export const LAYER_SYNONYMS: Record<string, Array<keyof MapLayers>> = {
  sea: ['cables'],
  ocean: ['cables'],
  nuke: ['nuclear', 'usNuclearFacilities'],
  reactor: ['usNuclearFacilities', 'nuclear'],
  reactors: ['usNuclearFacilities', 'nuclear'],
  nrc: ['usNuclearFacilities'],
  radiation: ['radiationWatch', 'nuclear', 'irradiators', 'usNuclearFacilities'],
  radnet: ['radiationWatch'],
  safecast: ['radiationWatch'],
  anomaly: ['radiationWatch', 'climate'],
  internet: ['outages', 'cables'],
  cyber: ['outages'],
  earthquake: ['natural'],
  volcano: ['natural'],
  tsunami: ['natural'],
  storm: ['weather', 'natural'],
  hurricane: ['weather', 'natural'],
  typhoon: ['weather', 'natural'],
  cyclone: ['weather', 'natural'],
  flood: ['weather', 'natural'],
  wildfire: ['fires'],
  forest: ['fires'],
  oil: ['pipelines'],
  gas: ['pipelines'],
  energy: ['pipelines'],
  cloud: ['datacenters'],
  ai: ['datacenters'],
  tech: ['datacenters'],
  night: ['dayNight'],
  sun: ['dayNight'],
  webcam: ['webcams'],
  camera: ['webcams'],
  livecam: ['webcams'],
};

export function resolveLayerLabel(def: LayerDefinition, tFn?: (key: string) => string): string {
  if (tFn) {
    const translated = tFn(I18N_PREFIX + def.i18nSuffix);
    if (translated && translated !== I18N_PREFIX + def.i18nSuffix) return translated;
  }
  return def.fallbackLabel;
}

export function hasCuratedLayerExplanation(layerKey: keyof MapLayers): boolean {
  return LAYER_EXPLANATIONS[layerKey]?.coverage === 'curated';
}

export function getLayerExplanation(layerKey: keyof MapLayers): LayerExplanation {
  const curated = LAYER_EXPLANATIONS[layerKey];
  if (curated) return curated;

  return {
    key: layerKey,
    coverage: 'fallback',
    category: 'Layer',
    purpose: 'This layer can be toggled on the map, but a curated source and confidence card has not been added yet.',
    source: 'Not curated in the v1 layer-explainability set.',
    freshness: 'No layer-level freshness contract is declared here. Check the visible panel badges, popups, or data freshness status when available.',
    confidence: 'Unknown until source-specific metadata is added.',
    limitations: [
      'The lack of a curated card does not mean the layer is unsupported.',
      'Use layer popups and related panels for source-specific context.',
    ],
    related: ['Layer guide'],
    evidence: [],
  };
}

export function bindLayerSearch(container: HTMLElement): void {
  const searchInput = container.querySelector('.layer-search') as HTMLInputElement | null;
  if (!searchInput) return;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const synonymHits = new Set<string>();
    if (q) {
      for (const [alias, keys] of Object.entries(LAYER_SYNONYMS)) {
        if (alias.includes(q)) keys.forEach(k => synonymHits.add(k));
      }
    }
    container.querySelectorAll('.layer-toggle').forEach(label => {
      const el = label as HTMLElement;
      if (el.hasAttribute('data-layer-hidden')) return;
      const row = el.closest('.layer-toggle-row') as HTMLElement | null;
      const displayTarget = row ?? el;
      if (!q) { displayTarget.style.display = ''; return; }
      const key = label.getAttribute('data-layer') || '';
      const text = label.textContent?.toLowerCase() || '';
      const match = text.includes(q) || key.toLowerCase().includes(q) || synonymHits.has(key);
      displayTarget.style.display = match ? '' : 'none';
    });
  });
}
