// Nuclear variant - NucMonitor (nuclear.<host> / VITE_VARIANT=nuclear)
// NOTE: This file is a structured canonical description for reference. The runtime
// wiring lives in src/config/panels.ts (NUCLEAR_PANELS, NUCLEAR_MAP_LAYERS,
// NUCLEAR_MOBILE_MAP_LAYERS) — modify both if the variant shape changes. Parallel
// to energy.ts / commodity.ts / finance.ts / tech.ts / happy.ts / full.ts.
//
// Purpose: an all-hazards information hub for every US nuclear facility —
// operating power reactors, restarts, advanced-reactor builds, decommissioning
// sites, DOE/NNSA complex, fuel cycle, research reactors, uranium recovery, and
// waste — fed by NRC, DOE, EIA, EPA RadNet, USGS, NWS, NASA FIRMS, and open
// industry sources.
import type { PanelConfig, MapLayers } from '@/types';
import type { VariantConfig } from './base';

// Re-export base config
export * from './base';

// ─────────────────────────────────────────────────────────────────────────────
// PANEL CONFIGURATION — Nuclear-hub panels
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_PANELS: Record<string, PanelConfig> = {
  map: { name: 'US Nuclear Facilities Map', enabled: true, priority: 1 },
  'nuclear-reactor-status': { name: 'NRC Reactor Power Status', enabled: true, priority: 1 },
  'nuclear-hazards': { name: 'Facility All-Hazards Watch', enabled: true, priority: 1 },
  'nuclear-facilities': { name: 'US Nuclear Facility Directory', enabled: true, priority: 1 },
  'live-news': { name: 'Nuclear Headlines', enabled: true, priority: 1 },
  'nuclear-regulatory': { name: 'NRC, DOE & IAEA Official', enabled: true, priority: 1 },
  'nuclear-industry': { name: 'Nuclear Industry News', enabled: true, priority: 1 },
  'nuclear-policy': { name: 'Nuclear Policy & Security', enabled: true, priority: 2 },
  'radiation-watch': { name: 'Radiation Watch', enabled: true, priority: 1 },
  'satellite-fires': { name: 'Satellite Fire Detections', enabled: true, priority: 2 },
  climate: { name: 'Climate & Weather Impact', enabled: true, priority: 2 },
  'climate-news': { name: 'Climate & Hazards News', enabled: true, priority: 2 },
  insights: { name: 'AI Nuclear Insights', enabled: true, priority: 2 },
  energy: { name: 'Energy Markets News', enabled: true, priority: 2 },
  commodities: { name: 'Energy Commodities', enabled: true, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 3 },
  'world-clock': { name: 'World Clock', enabled: true, priority: 3 },
};

// ─────────────────────────────────────────────────────────────────────────────
// MAP LAYERS — Facilities plus every hazard layer that can touch a site
// ─────────────────────────────────────────────────────────────────────────────
export const DEFAULT_MAP_LAYERS: MapLayers = {
  usNuclearFacilities: true,
  nuclear: false,
  irradiators: false,
  radiationWatch: true,
  natural: true,
  weather: true,
  fires: true,
  outages: true,
  climate: false,
  pipelines: false,
  cables: false,
  datacenters: false,
  webcams: false,
  diseaseOutbreaks: false,
  dayNight: false,
};

export const MOBILE_DEFAULT_MAP_LAYERS: MapLayers = {
  ...DEFAULT_MAP_LAYERS,
  fires: false,
  outages: false,
  radiationWatch: false,
};

export const VARIANT_CONFIG: VariantConfig = {
  name: 'nuclear',
  description: 'US nuclear facility hub — NRC reactor status, all-hazards watch, facility directory, radiation monitoring, official and industry news',
  panels: DEFAULT_PANELS,
  mapLayers: DEFAULT_MAP_LAYERS,
  mobileMapLayers: MOBILE_DEFAULT_MAP_LAYERS,
};
