// Full geopolitical variant - worldmonitor.app
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

// Re-export base config
export * from './base';

// Geopolitical-specific exports
export * from '../feeds';
export * from '../geo';
export * from '../irradiators';
export * from '../pipelines';
export * from '../ports';
export * from '../military';
// airports intentionally not re-exported here — keeps the airports table off the
// eager variant/@/config barrel; AviationCommandBar imports it directly. (#4404)
export * from '../entities';

// Panel configuration for geopolitical analysis
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Global Map', enabled: true, priority: 1 },
  'live-news': { name: 'Live News', enabled: true, priority: 1 },
  intel: { name: 'Intel Feed', enabled: true, priority: 1 },
  'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 1 },
  cii: { name: 'Country Instability', enabled: true, priority: 1 },
  cascade: { name: 'Infrastructure Cascade', enabled: true, priority: 1 },
  'strategic-risk': { name: 'Strategic Risk Overview', enabled: true, priority: 1 },
  politics: { name: 'World News', enabled: true, priority: 1 },
  us: { name: 'United States', enabled: true, priority: 1 },
  europe: { name: 'Europe', enabled: true, priority: 1 },
  middleeast: { name: 'Middle East', enabled: true, priority: 1 },
  africa: { name: 'Africa', enabled: true, priority: 1 },
  latam: { name: 'Latin America', enabled: true, priority: 1 },
  asia: { name: 'Asia-Pacific', enabled: true, priority: 1 },
  energy: { name: 'Energy & Resources', enabled: true, priority: 1 },
  gov: { name: 'Government', enabled: true, priority: 1 },
  thinktanks: { name: 'Think Tanks', enabled: true, priority: 1 },
  polymarket: { name: 'Predictions', enabled: true, priority: 1 },
  commodities: { name: 'Commodities', enabled: true, priority: 1 },
  markets: { name: 'Markets', enabled: true, priority: 1 },
  'stock-analysis': { name: 'Stock Analysis', enabled: true, priority: 1 },
  'stock-backtest': { name: 'Backtesting', enabled: true, priority: 1 },
  'daily-market-brief': { name: 'Daily Market Brief', enabled: true, priority: 1 },
  economic: { name: 'Economic Indicators', enabled: true, priority: 1 },
  finance: { name: 'Financial', enabled: true, priority: 1 },
  tech: { name: 'Technology', enabled: true, priority: 2 },
  crypto: { name: 'Crypto', enabled: true, priority: 2 },
  heatmap: { name: 'Sector Heatmap', enabled: true, priority: 2 },
  ai: { name: 'AI/ML', enabled: true, priority: 2 },
  layoffs: { name: 'Layoffs Tracker', enabled: false, priority: 2 },
  'macro-signals': { name: 'Market Radar', enabled: true, priority: 2 },
  'etf-flows': { name: 'BTC ETF Tracker', enabled: true, priority: 2 },
  stablecoins: { name: 'Stablecoins', enabled: true, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
};

// Map layers for geopolitical view
export const DEFAULT_MAP_LAYERS: MapLayers = {


  cables: false,
  pipelines: false,
  nuclear: true,
  irradiators: false,
  weather: true,
  // Opt-in: all five road feeds are on-demand bootstrap keys. Default-on made
  // every visitor fetch them, which is exactly what the on-demand tier is meant
  // to prevent. Narrowest surface on the map, so it follows military/flights/fires
  // rather than the global layers above it (#6763).
  // Stays on: it rides the fast tier already hydrated, so enabling it costs no
  // extra request, and it carries provincial emergency alerts.
  outages: true,
  datacenters: false,
  natural: false,
  fires: false,
  climate: false,
  // Tech layers (disabled in full variant)
  // Finance layers (disabled in full variant)
  // Happy variant layers
  dayNight: false,
  // Commodity variant layers (disabled in full variant)
  webcams: false,
  diseaseOutbreaks: false,
};

// Mobile-specific defaults for geopolitical
export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {


  cables: false,
  pipelines: false,
  nuclear: false,
  irradiators: false,
  weather: true,
  outages: true,
  datacenters: false,
  natural: true,
  fires: false,
  climate: false,
  // Tech layers (disabled in full variant)
  // Finance layers (disabled in full variant)
  // Happy variant layers
  dayNight: false,
  // Commodity variant layers (disabled in full variant)
  webcams: false,
  diseaseOutbreaks: false,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'full',
  description: 'Full geopolitical intelligence dashboard',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
