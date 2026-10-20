// Power grid alerts envelope: ISO/RTO operating conditions, EIA-930 demand,
// grid-relevant NWS hazard alerts mapped to operator footprints, and NOAA SWPC
// geomagnetic state, assessed into a per-region impact score. Published by
// scripts/seed-grid-alerts.mjs every 10 minutes to `energy:grid-alerts:v1`
// and read here through the on-demand bootstrap key `gridAlerts`.
//
// The panel and the DeckGL layer both consume the same snapshot, so the last
// accepted envelope is memoized here: the map layer must never trigger a
// second CDN read for a payload the panel already holds.

import { createCircuitBreaker } from '@/utils';
import { ensureHydrated } from '@/services/bootstrap';

export type GridStatusLevel = 'normal' | 'watch' | 'advisory' | 'conservative' | 'eea1' | 'eea2' | 'eea3' | 'unknown';
export type GridImpactBand = 'low' | 'watch' | 'elevated' | 'critical';
export type GridAlertKind = 'operator' | 'weather' | 'space';
export type GridAlertLevel = 'emergency' | 'warning' | 'advisory' | 'info';
export type GridHazardCategory = 'winter' | 'tropical' | 'cold' | 'heat' | 'wind' | 'storm' | 'fire' | 'flood';

export interface GridRegionMetrics {
  demandMw: number | null;
  demandAt: string | null;
  forecastMw: number | null;
  peakForecastMw: number | null;
  capacityMw: number | null;
  netGenerationMw: number | null;
  interchangeMw: number | null;
  prcMw: number | null;
  reservePct: number | null;
  demandVsForecastPct: number | null;
  demandHistory: Array<[string, number]>;
}

export interface GridRegion {
  id: string;
  name: string;
  kind: 'iso' | 'ba';
  operator: string | null;
  interconnection: 'eastern' | 'western' | 'ercot';
  states: string[];
  centroid: [number, number];
  status: GridStatusLevel;
  statusText: string;
  statusUpdatedAt: string | null;
  metrics: GridRegionMetrics;
  hazards: { alertCount: number; categories: Partial<Record<GridHazardCategory, number>>; topEvent: string | null };
  space: { gicExposure: 'high' | 'moderate' | 'low' | 'unknown'; gNow: number };
  impact: { score: number; band: GridImpactBand; drivers: string[] };
  dataSources: string[];
}

export interface GridAlert {
  id: string;
  source: string;
  kind: GridAlertKind;
  level: GridAlertLevel;
  title: string;
  detail: string;
  event?: string;
  category?: GridHazardCategory;
  areaDesc?: string;
  regionIds: string[];
  issuedAt: string | null;
  expires: string | null;
  centroid?: [number, number] | null;
  url?: string | null;
}

export interface GridHazardImpact {
  regionId: string;
  regionName: string;
  score: number;
  band: GridImpactBand;
  drivers: string[];
  hazardCategories: Partial<Record<GridHazardCategory, number>>;
  alertIds: string[];
}

export interface GridSpaceDay { date: string | null; g: number; gText: string; s: number; r: number; rMinorProb: number | null; rMajorProb: number | null }

export interface GridSpaceWeather {
  current: GridSpaceDay;
  forecast: GridSpaceDay[];
  kp: number | null;
  kpAt: string | null;
  exposure: Array<{ regionId: string; exposure: 'high' | 'moderate' | 'low' | 'unknown'; points: number }>;
}

export interface GridSourceStatus {
  id: string;
  label: string;
  url: string | null;
  ok: boolean;
  fetchedAt: string;
  latencyMs: number;
  error?: string;
  status?: string;
  records?: number;
  g?: number;
}

export interface GridAlertsSummary {
  overall: 'normal' | 'watch' | 'elevated' | 'critical';
  regionsAssessed: number;
  regionsStressed: number;
  alertCount: number;
  emergencyCount: number;
  weatherAlertCount: number;
  weatherAlertTotal: number;
  worstRegionId: string | null;
  worstScore: number;
  gNow: number;
  gForecastMax: number;
  kp: number | null;
  sourcesOk: number;
  sourcesTotal: number;
}

export interface GridAlertsEnvelope {
  schemaVersion: number;
  generatedAt: string;
  summary: GridAlertsSummary;
  regions: GridRegion[];
  alerts: GridAlert[];
  impacts: GridHazardImpact[];
  space: GridSpaceWeather | null;
  sources: GridSourceStatus[];
  statusLevels: GridStatusLevel[];
  attribution: { notice: string; sources: Array<{ id: string; name: string; url: string }> };
}

export const EMPTY_GRID_ALERTS: GridAlertsEnvelope = Object.freeze({
  schemaVersion: 1,
  generatedAt: '',
  summary: {
    overall: 'normal', regionsAssessed: 0, regionsStressed: 0, alertCount: 0, emergencyCount: 0, weatherAlertCount: 0, weatherAlertTotal: 0,
    worstRegionId: null, worstScore: 0, gNow: 0, gForecastMax: 0, kp: null, sourcesOk: 0, sourcesTotal: 0,
  },
  regions: [],
  alerts: [],
  impacts: [],
  space: null,
  sources: [],
  statusLevels: [],
  attribution: { notice: '', sources: [] },
}) as GridAlertsEnvelope;

const breaker = createCircuitBreaker<GridAlertsEnvelope>({ name: 'Grid Alerts', cacheTtlMs: 5 * 60 * 1000 });

let lastAccepted: GridAlertsEnvelope | null = null;

function isEnvelope(value: unknown): value is GridAlertsEnvelope {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<GridAlertsEnvelope>;
  return Array.isArray(v.regions) && Array.isArray(v.alerts) && Array.isArray(v.sources) && typeof v.generatedAt === 'string' && !!v.summary;
}

/** Normalize the published payload; `_seed` envelopes are already unwrapped by the bootstrap reader. */
export function toGridAlertsEnvelope(raw: unknown): GridAlertsEnvelope {
  const data = raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>) && !('regions' in (raw as Record<string, unknown>))
    ? (raw as { data: unknown }).data
    : raw;
  if (!isEnvelope(data)) return EMPTY_GRID_ALERTS;
  return {
    ...EMPTY_GRID_ALERTS,
    ...data,
    impacts: Array.isArray(data.impacts) ? data.impacts : [],
    space: data.space ?? null,
    statusLevels: Array.isArray(data.statusLevels) ? data.statusLevels : EMPTY_GRID_ALERTS.statusLevels,
    attribution: data.attribution ?? EMPTY_GRID_ALERTS.attribution,
  };
}

/** Fetch the envelope through the credential-less on-demand bootstrap URL. */
export async function fetchGridAlerts(): Promise<GridAlertsEnvelope> {
  const result = await breaker.execute(async () => {
    const envelope = toGridAlertsEnvelope(await ensureHydrated('gridAlerts'));
    if (envelope.regions.length === 0) throw new Error('grid alerts envelope unavailable');
    return envelope;
  }, EMPTY_GRID_ALERTS, { shouldCache: (r) => r.regions.length > 0 });
  if (result.regions.length > 0) lastAccepted = result;
  return result;
}

/** Last accepted envelope, for the map layer and other same-tick readers. */
export function getCachedGridAlerts(): GridAlertsEnvelope | null {
  return lastAccepted;
}

export function __resetGridAlertsForTests(): void {
  lastAccepted = null;
}

// ─── Presentation helpers ────────────────────────────────────────────────────

export const GRID_STATUS_LABELS: Record<GridStatusLevel, string> = {
  normal: 'Normal',
  watch: 'Watch',
  advisory: 'Advisory',
  conservative: 'Conservative ops',
  eea1: 'EEA 1',
  eea2: 'EEA 2',
  eea3: 'EEA 3',
  unknown: 'No condition feed',
};

export const GRID_HAZARD_LABELS: Record<GridHazardCategory, string> = {
  winter: 'Winter / ice',
  tropical: 'Tropical',
  cold: 'Extreme cold',
  heat: 'Extreme heat',
  wind: 'High wind',
  storm: 'Severe storms',
  fire: 'Fire weather',
  flood: 'Flooding',
};

export const GRID_HAZARD_ORDER: GridHazardCategory[] = ['winter', 'cold', 'heat', 'tropical', 'wind', 'storm', 'fire', 'flood'];

export function gridBandColor(band: GridImpactBand): [number, number, number, number] {
  switch (band) {
    case 'critical': return [231, 76, 60, 235];
    case 'elevated': return [243, 156, 18, 225];
    case 'watch': return [241, 196, 15, 210];
    default: return [52, 152, 219, 170];
  }
}

export function gridBandCssVar(band: GridImpactBand): string {
  switch (band) {
    case 'critical': return 'var(--semantic-critical, #e74c3c)';
    case 'elevated': return 'var(--semantic-high, #f39c12)';
    case 'watch': return 'var(--semantic-elevated, #f1c40f)';
    default: return 'var(--semantic-info, #3498db)';
  }
}

export function formatMw(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(1)} GW`;
  return `${Math.round(value)} MW`;
}

export function formatRelativeAge(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((nowMs - t) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
