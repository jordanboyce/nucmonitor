import type { PanelConfig, MapLayers, DataSourceId } from '@/types';
import { SITE_VARIANT } from './variant';

// ============================================
// NUCLEAR variant — NucMonitor (nuclear.<host>)
// The NucMonitor dashboard: US nuclear facility all-hazards hub.
// ============================================
const NUCLEAR_PANELS: Record<string, PanelConfig> = {
  map: { name: 'US Nuclear Facilities Map', enabled: true, priority: 1 },
  'nuclear-reactor-status': { name: 'NRC Reactor Power Status', enabled: true, priority: 1 },
  'nuclear-events': { name: 'NRC Event Notifications', enabled: true, priority: 1 },
  'nuclear-hazards': { name: 'Facility All-Hazards Watch', enabled: true, priority: 1 },
  'nuclear-facilities': { name: 'US Nuclear Facility Directory', enabled: true, priority: 1 },
  'nuclear-buildout': { name: 'Advanced Nuclear Buildout', enabled: true, priority: 2 },
  'nuclear-headlines': { name: 'Nuclear Headlines', enabled: true, priority: 1 },
  'nuclear-regulatory': { name: 'NRC, DOE & IAEA Official', enabled: true, priority: 1 },
  'nuclear-industry': { name: 'Nuclear Industry News', enabled: true, priority: 1 },
  'nuclear-policy': { name: 'Nuclear Policy & Security', enabled: true, priority: 2 },
  'radiation-watch': { name: 'Radiation Watch', enabled: true, priority: 1 },
  'satellite-fires': { name: 'Satellite Fire Detections', enabled: true, priority: 2 },
  climate: { name: 'Climate & Weather Impact', enabled: true, priority: 2 },
  'climate-news': { name: 'Climate & Hazards News', enabled: true, priority: 2 },
  energy: { name: 'Energy Markets News', enabled: true, priority: 2 },
  commodities: { name: 'Energy Commodities', enabled: true, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 3 },
  'world-clock': { name: 'World Clock', enabled: true, priority: 3 },
};

const NUCLEAR_MAP_LAYERS: MapLayers = {
  cables: false,
  pipelines: false,
  nuclear: false,         // Global nuclear sites layer stays available but off; the US registry layer replaces it
  irradiators: false,
  radiationWatch: true,   // EPA RadNet + Safecast anomalies
  weather: true,          // NWS alerts — the primary all-hazards input
  outages: true,          // Grid / internet outages near sites
  datacenters: false,
  natural: true,          // USGS earthquakes + EONET / NHC storms
  fires: true,            // NASA FIRMS detections near sites
  climate: false,
  dayNight: false,
  webcams: false,
  diseaseOutbreaks: false,
  // Nuclear hub registry layer
  usNuclearFacilities: true,
};

const NUCLEAR_MOBILE_MAP_LAYERS: MapLayers = {
  ...NUCLEAR_MAP_LAYERS,
  fires: false,
  outages: false,
  radiationWatch: false,
};

// ============================================
// UNIFIED PANEL REGISTRY
// ============================================

type PanelVariant = 'nuclear';

const VARIANT_PANEL_CONFIGS: Record<PanelVariant, Record<string, PanelConfig>> = {
  nuclear: NUCLEAR_PANELS,
};

function getVariantPanelConfigs(variant: string): Record<string, PanelConfig> | undefined {
  return Object.prototype.hasOwnProperty.call(VARIANT_PANEL_CONFIGS, variant)
    ? VARIANT_PANEL_CONFIGS[variant as PanelVariant]
    : undefined;
}

/** True when `panelId` is in the selected monitor's native catalog, not merely in ALL_PANELS. */
export function isPanelNativeToVariant(panelId: string, variant: string): boolean {
  const configs = getVariantPanelConfigs(variant);
  return Boolean(configs && Object.prototype.hasOwnProperty.call(configs, panelId));
}

/** All panels from all variants — canonical cross-variant registry. */
export const ALL_PANELS: Record<string, PanelConfig> = {
  ...NUCLEAR_PANELS,
};

/** Per-variant canonical panel order (keys = which panels are enabled by default). */
export const VARIANT_DEFAULTS: Record<string, string[]> = {
  nuclear:   Object.keys(VARIANT_PANEL_CONFIGS.nuclear),
};

/**
 * Variant-specific label overrides for panels shared across variants.
 * Applied at render time, not just at seed time.
 */
export const VARIANT_PANEL_OVERRIDES: Partial<Record<string, Partial<Record<string, Partial<PanelConfig>>>>> = {
  nuclear: {
    map:         { name: 'US Nuclear Facilities Map' },
    insights:    { name: 'AI Nuclear Insights' },
    energy:      { name: 'Energy Markets News' },
    commodities: { name: 'Energy Commodities' },
  },
};

/**
 * Returns the effective panel config for a given key and variant,
 * applying variant-specific display overrides (name, premium, etc.).
 */
export function getEffectivePanelConfig(key: string, variant: string): PanelConfig {
  const base = getVariantPanelConfigs(variant)?.[key] ?? ALL_PANELS[key];
  if (!base) return { name: key, enabled: false, priority: 2 };
  const override = VARIANT_PANEL_OVERRIDES[variant]?.[key] ?? {};
  return { ...base, ...override };
}

/**
 * Build the same canonical panel-settings seed App uses on a first visit:
 * every panel is addressable, while only the selected variant's enabled
 * defaults are active. Keeping this pure also gives non-DOM integrations a
 * variant-realistic state without duplicating App's merge formula.
 */
export function getInitialPanelSettingsForVariant(variant: string): Record<string, PanelConfig> {
  const variantDefaults = new Set(VARIANT_DEFAULTS[variant] ?? VARIANT_DEFAULTS.nuclear ?? []);
  return Object.fromEntries(
    Object.keys(ALL_PANELS).map((key) => {
      const config = getEffectivePanelConfig(key, variant);
      return [key, { ...config, enabled: variantDefaults.has(key) && config.enabled }];
    }),
  );
}

/**
 * Returns true if `key` is in the current variant's default panel set.
 *
 * App.ts:577-583 merges ALL_PANELS into panelSettings on every variant so
 * users can cross-enable panels, which makes `shouldCreatePanel(key)`
 * (which just checks `key in panelSettings`) true everywhere. Auto-refresh
 * paths that fan out a fetch must instead gate on the variant defaults —
 * otherwise variants whose backend doesn't seed the panel's bootstrap key
 * (e.g. tech-readiness on commodity/finance/energy) blow their 5s fetch
 * budget on a key that will never populate.
 */
const SITE_VARIANT_DEFAULTS = new Set(VARIANT_DEFAULTS[SITE_VARIANT] ?? []);

export function isPanelInVariantDefaults(key: string): boolean {
  return SITE_VARIANT_DEFAULTS.has(key);
}

/**
 * Apply a USER-initiated enable/disable to a panel config. Every user toggle
 * path goes through this so the toggle semantics stay single-sourced.
 *
 * Mutates in place: every call site already owns a live entry in the
 * panelSettings map it is about to persist.
 */
export function userSetPanelEnabled(config: PanelConfig, enabled: boolean): void {
  config.enabled = enabled;
}

// ============================================
// VARIANT-AWARE EXPORTS
// ============================================
export const DEFAULT_PANELS: Record<string, PanelConfig> = Object.fromEntries(
  (VARIANT_DEFAULTS[SITE_VARIANT] ?? []).map(key =>
    [key, getEffectivePanelConfig(key, SITE_VARIANT)]
  )
);

export const DEFAULT_MAP_LAYERS = NUCLEAR_MAP_LAYERS;

export const MOBILE_DEFAULT_MAP_LAYERS = NUCLEAR_MOBILE_MAP_LAYERS;

/** Maps map-layer toggle keys to their data-freshness source IDs (single source of truth). */
export const LAYER_TO_SOURCE: Partial<Record<keyof MapLayers, DataSourceId[]>> = {
  natural: ['usgs'],
  weather: ['weather'],
  outages: ['outages'],
  climate: ['climate'],
  radiationWatch: ['radiation'],
};

// ============================================
// PANEL CATEGORY MAP
// ============================================
// Maps category keys to panel keys. Only categories with at least one
// matching panel in the user's active panel settings are shown.
export const PANEL_CATEGORY_MAP: Record<string, { labelKey: string; panelKeys: string[]; variants?: string[] }> = {
  core: {
    labelKey: 'header.panelCatCore',
    panelKeys: ['map', 'nuclear-headlines'],
  },

  nuclearHub: {
    labelKey: 'header.panelCatNuclearHub',
    panelKeys: ['nuclear-reactor-status', 'nuclear-events', 'nuclear-hazards', 'nuclear-facilities', 'nuclear-buildout', 'radiation-watch', 'satellite-fires', 'climate'],
    variants: ['nuclear'],
  },
  nuclearNews: {
    labelKey: 'header.panelCatNuclearNews',
    panelKeys: ['nuclear-regulatory', 'nuclear-industry', 'nuclear-policy', 'climate-news', 'energy', 'commodities', 'monitors', 'world-clock'],
    variants: ['nuclear'],
  },
};

export interface VariantPanelCategory {
  key: string;
  labelKey: string;
  panelKeys: string[];
}

// Categories applicable to `variant` that contain at least one enabled panel.
// Shared by the settings panel-tab filter and the mobile category nav —
// callers prepend their own "all" entry and localize labelKey via t().
export function getVariantPanelCategories(
  panelSettings: Record<string, PanelConfig>,
  variant: string,
): VariantPanelCategory[] {
  return Object.entries(PANEL_CATEGORY_MAP)
    .filter(([, def]) => !def.variants || def.variants.includes(variant))
    .filter(([, def]) => def.panelKeys.some((pk) => panelSettings[pk]?.enabled))
    .map(([key, def]) => ({ key, labelKey: def.labelKey, panelKeys: def.panelKeys }));
}
