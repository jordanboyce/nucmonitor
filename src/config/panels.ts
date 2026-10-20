import type { PanelConfig, MapLayers, DataSourceId } from '@/types';
import { SITE_VARIANT } from './variant';
// boundary-ignore: isDesktopRuntime is a pure env probe with no service dependencies
import { isDesktopRuntime } from '@/services/runtime';
// boundary-ignore: getSecretState is a pure env/keychain probe with no service dependencies
import { getSecretState } from '@/services/runtime-config';
// boundary-ignore: isEntitled is a pure state check with no side effects
import { isEntitled } from '@/services/entitlements';

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

export const FREE_MAX_PANELS = 40;
export const FREE_MAX_SOURCES = 80;

export function isFreePanelCapCounted(key: string): boolean {
  return key !== 'map' && !key.startsWith('cw-');
}

export function countFreePanelCapUsage(panelSettings: Record<string, PanelConfig>): number {
  return Object.entries(panelSettings).filter(([key, panel]) =>
    panel.enabled && isFreePanelCapCounted(key)
  ).length;
}

export function restoreFreeMapPanelAccess(
  panelSettings: Record<string, PanelConfig>,
): Record<string, PanelConfig> {
  const next: Record<string, PanelConfig> = {};
  for (const [key, config] of Object.entries(panelSettings)) {
    next[key] = { ...config };
  }

  if (next.map?.enabled === false && countFreePanelCapUsage(next) > FREE_MAX_PANELS) {
    next.map = { ...next.map, enabled: true };
  }

  return next;
}

/**
 * Returns true if the current user is entitled to enable/view this panel.
 * Mirrors the entitlement checks in panel-layout.ts (single source of truth).
 */
export function isPanelEntitled(key: string, config: PanelConfig, isPro = false): boolean {
  if (!config.premium) return true;
  // Dodo entitlements unlock all premium panels
  if (isEntitled()) return true;
  const apiKeyPanels = ['stock-analysis', 'stock-backtest', 'daily-market-brief', 'market-implications', 'regional-intelligence', 'deduction', 'chat-analyst', 'wsb-ticker-scanner', 'trade-policy', 'global-procurement'];
  if (apiKeyPanels.includes(key)) {
    return getSecretState('WORLDMONITOR_API_KEY').present || isPro;
  }
  if (config.premium === 'locked') {
    return isDesktopRuntime();
  }
  return true;
}

/**
 * Clamp a panel-settings map to the free-tier panel cap. Single source of
 * truth for the count limit so App boot, the settings/search add paths, and
 * the dashboard-tab add/switch/load paths all enforce the SAME ceiling.
 *
 * Returns a NEW map; the input is never mutated. For free users: cw-*
 * custom-widget panels are a pro
 * feature and are always disabled. The map is free baseline infrastructure
 * and never consumes a capped panel slot. Among the remaining enabled panels
 * the lowest-priority ones past FREE_MAX_PANELS are disabled (priority asc,
 * key tiebreak — identical ordering to App.enforceFreeTierLimits).
 *
 * Pro users get the same panel eligibility, plus the inverse of the cw-* gate:
 * widgets this helper previously hid are restored (see restoreProGatedPanels).
 *
 * `isPro` is passed in (rather than read here) to keep this a pure config
 * helper with no service-state dependency, matching isPanelEntitled above.
 */
export function enforceFreePanelLimit(
  panelSettings: Record<string, PanelConfig>,
  isPro: boolean,
): Record<string, PanelConfig> {
  if (isPro) return restoreProGatedPanels(panelSettings);

  const next: Record<string, PanelConfig> = {};
  for (const [key, config] of Object.entries(panelSettings)) {
    next[key] = { ...config };
  }

  // cw-* custom widgets are pro-only — never enabled on the free tier.
  // Stamp `proGated` so restoreProGatedPanels can tell this apart from a
  // widget the user hid themselves and put it back when they go Pro.
  for (const key of Object.keys(next)) {
    if (key.startsWith('cw-') && next[key]?.enabled) {
      next[key] = { ...next[key]!, enabled: false, proGated: true };
    }
  }

  const enabledKeys = Object.entries(next)
    .filter(([k, v]) => v.enabled && isFreePanelCapCounted(k))
    .sort(([ka, a], [kb, b]) => (a.priority ?? 99) - (b.priority ?? 99) || ka.localeCompare(kb))
    .map(([k]) => k);

  // Stamp `proGated` for the same reason the cw-* gate above does: this is the
  // GATE disabling the panel, not the user. Without the marker the count cap
  // was a one-way door — App.enforceFreeTierLimits persists this map into
  // STORAGE_KEYS.panels, and restoreProGatedPanels only re-enables what is
  // marked, so a panel clamped during any window where the tier read as free
  // stayed `enabled: false` forever. Going Pro never brought it back: the panel
  // kept appearing in Cmd+K and as a checked box in settings while being absent
  // from the dashboard.
  for (const key of enabledKeys.slice(FREE_MAX_PANELS)) {
    next[key] = { ...next[key]!, enabled: false, proGated: true };
  }

  return next;
}

/**
 * Apply a USER-initiated enable/disable to a panel config.
 *
 * Every user toggle path must go through this. `proGated` means "the GATE owns
 * this disable"; the moment the user takes a position on the panel themselves,
 * the gate no longer owns it and the marker must go — otherwise a panel the
 * gate once clamped keeps the marker through a user re-enable, and a LATER
 * deliberate hide is indistinguishable from gate damage, so the next Pro
 * reconcile resurrects a panel the user chose to hide (and cloud-syncs that to
 * every device).
 *
 * Mutates in place: every call site already owns a live entry in the
 * panelSettings map it is about to persist.
 */
export function userSetPanelEnabled(config: PanelConfig, enabled: boolean): void {
  config.enabled = enabled;
  delete config.proGated;
}

/**
 * Inverse of `enforceFreePanelLimit`: re-enable panels the free-tier gate hid
 * (custom widgets or count-cap overflow), and clear the marker.
 *
 * Without this the gate is a one-way door. `enforceFreePanelLimit` writes
 * straight into STORAGE_KEYS.panels, so once a widget is disabled nothing
 * ever turns it back on — a user who upgrades to Pro (or whose Pro session
 * simply resolved late, see App.enforceFreeTierLimits) would find their
 * widgets permanently missing from the dashboard even though the specs are
 * still in wm-custom-widgets.
 *
 * Only panels carrying `proGated` are touched, so a panel the user hid
 * deliberately via settings stays hidden.
 */
export function restoreProGatedPanels(
  panelSettings: Record<string, PanelConfig>,
): Record<string, PanelConfig> {
  const next: Record<string, PanelConfig> = {};
  for (const [key, config] of Object.entries(panelSettings)) {
    if (config.proGated) {
      const { proGated: _proGated, ...rest } = config;
      next[key] = { ...rest, enabled: true };
    } else {
      next[key] = { ...config };
    }
  }
  return next;
}

/**
 * True while the session's tier is still unknowable, so the persisted
 * free-tier clamp must not run yet. Two windows qualify:
 *
 * - Clerk hasn't settled (`authPending`) — a signed-in Pro user is
 *   indistinguishable from an anonymous one.
 * - Clerk settled on a signed-in user but the Convex entitlement snapshot
 *   hasn't arrived (`hasUser && !entitlementLoaded`) — isEntitled() is
 *   deterministically false until the snapshot lands, so a Convex-only Pro
 *   subscriber would be clamped as free.
 *
 * `deadlineExceeded` is the AUTH_SETTLE_GRACE_MS backstop: once the grace
 * timer fires, enforcement proceeds with whatever tier signals exist, so a
 * snapshot that never arrives cannot defer the caps forever.
 *
 * Pure on plain booleans (no service imports) to keep this a config helper,
 * matching isPanelEntitled above.
 */
export function shouldDeferFreeTierEnforcement(
  authPending: boolean,
  hasUser: boolean,
  entitlementLoaded: boolean,
  deadlineExceeded: boolean,
): boolean {
  if (deadlineExceeded) return false;
  return authPending || (hasUser && !entitlementLoaded);
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
    panelKeys: ['nuclear-reactor-status', 'nuclear-events', 'nuclear-hazards', 'nuclear-facilities', 'radiation-watch', 'satellite-fires', 'climate'],
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

// Enabled panels that carry a premium gate on the current surface — drives
// the mobile nav's PRO chip. getEffectivePanelConfig folds in per-variant
// premium overrides; unknown keys (custom widgets, MCP panels) resolve to a
// premium-less stub and drop out.
export function getProPanelKeys(
  panelSettings: Record<string, PanelConfig>,
  variant: string,
): string[] {
  return Object.keys(panelSettings).filter((key) =>
    panelSettings[key]?.enabled && Boolean(getEffectivePanelConfig(key, variant).premium),
  );
}
