// Configuration exports
// For variant-specific builds, set VITE_VARIANT environment variable
// VITE_VARIANT=tech → tech.worldmonitor.app (tech-focused)
// VITE_VARIANT=full → worldmonitor.app (geopolitical)
// VITE_VARIANT=finance → finance.worldmonitor.app (markets/trading)

export { SITE_VARIANT } from './variant';

// Shared base configuration (always included)
export {
  IDLE_PAUSE_MS,
  REFRESH_INTERVALS,
  MONITOR_COLORS,
  STORAGE_KEYS,
  DEFAULT_MAP_MODE,
  type MapModePreference,
} from './variants/base';

// Market data (shared)
export { SECTORS, COMMODITIES, MARKET_SYMBOLS, CRYPTO_MAP, STOCK_CATALOG, AUXILIARY_STOCK_CATALOG } from './markets';

// Geo data (shared base). UNDERSEA_CABLES + MAP_URLS moved to the lazy geo-map
// chunk (#4404) — import them directly from '@/config/geo-map', not via this barrel.

// AI Datacenters: NOT re-exported on the eager @/config barrel — the ~86KB table
// is dragged onto the critical path via this re-export. Consumers (map/globe/
// search) import directly from '@/config/ai-datacenters'; related-assets lazy-
// loads it. (#4404)

// Feeds configuration (shared functions, variant-specific data)
export {
  SOURCE_TIERS,
  getSourceTier,
  SOURCE_TYPES,
  getSourceType,
  getSourcePropagandaRisk,
  getSourceTierBadgeTitle,
  describePropagandaBadge,
  hasDeclaredPropagandaRisk,
  hasDeclaredSourceType,
  hasReviewedPropagandaRisk,
  hasReviewedSourceType,
  listConfiguredFeedNames,
  getFeedProvenanceState,
  UNREVIEWED_SOURCE_RISK,
  ALERT_KEYWORDS,
  ALERT_EXCLUSIONS,
  type SourceRiskProfile,
  type SourceType,
} from './feeds';

// Panel configuration - imported from panels.ts
export {
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  LAYER_TO_SOURCE,
  ALL_PANELS,
  VARIANT_DEFAULTS,
  VARIANT_PANEL_OVERRIDES,
  getEffectivePanelConfig,
  getInitialPanelSettingsForVariant,
  isPanelInVariantDefaults,
  isPanelNativeToVariant,
  userSetPanelEnabled,
} from './panels';

// ============================================
// VARIANT-SPECIFIC EXPORTS
// Only import what's needed for each variant
// ============================================

export { FEEDS, CANONICAL_FEEDS } from './feeds';

// MILITARY_BASES moved to the lazy military-bases chunk (#4478) — import it
// directly from '@/config/military-bases', not via this barrel, so the ~48KB
// bases-expanded table stays off the eager boot graph.
export {
  INTEL_HOTSPOTS,
  CONFLICT_ZONES,
  STRATEGIC_WATERWAYS,
} from './geo';

export { GAMMA_IRRADIATORS } from './irradiators';
export { PIPELINES, PIPELINE_COLORS } from './pipelines';
export {
  ENTITY_REGISTRY,
  getEntityById,
  type EntityType,
  type EntityEntry,
} from './entities';

