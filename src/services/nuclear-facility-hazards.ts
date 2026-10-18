/**
 * All-hazards correlation for US nuclear facilities.
 *
 * Takes the hazard feeds the dashboard already loads (USGS earthquakes, NWS
 * weather alerts, NASA FIRMS fire detections, EPA RadNet / Safecast radiation
 * observations, and EONET / NHC natural events such as tropical cyclones) and
 * joins them geographically to the facility registry. The output is a ranked
 * list of facilities with every active hazard signal within its watch radius,
 * so a reader can answer "which plants have something happening near them
 * right now" without scanning six separate layers.
 *
 * Pure functions: no fetches, no DOM. The panel and the map layer call
 * `correlateFacilityHazards` whenever any input feed refreshes.
 */

import {
  US_NUCLEAR_FACILITIES,
  type UsNuclearFacility,
  type UsNuclearFacilityCategory,
} from '@/config/us-nuclear-facilities';
import type { Earthquake } from '@/services/earthquakes';
import type { WeatherAlert } from '@/services/weather';
import type { RadiationObservation } from '@/services/radiation';
import type { NaturalEvent } from '@/types';
import type { MapFire } from '@/services/wildfires';

export type FacilityHazardKind = 'earthquake' | 'weather' | 'fire' | 'radiation' | 'storm' | 'flood' | 'volcano' | 'other';
export type FacilityHazardSeverity = 'critical' | 'high' | 'elevated' | 'watch';

export interface FacilityHazardSignal {
  kind: FacilityHazardKind;
  severity: FacilityHazardSeverity;
  /** One-line human summary, e.g. "M4.6 earthquake 38 km away". */
  summary: string;
  /** Great-circle distance from the facility in km (0 for area alerts that cover the site). */
  distanceKm: number;
  /** When the signal was observed/issued, if known. */
  at?: Date;
  sourceUrl?: string;
  /** Underlying source label for provenance ("USGS", "NWS", "NASA FIRMS", ...). */
  source: string;
}

export interface FacilityHazardReport {
  facility: UsNuclearFacility;
  signals: FacilityHazardSignal[];
  /** Highest severity among signals. */
  severity: FacilityHazardSeverity;
  /** Numeric score used for ranking (higher = more concerning). */
  score: number;
}

export interface FacilityHazardInputs {
  earthquakes?: Earthquake[];
  weatherAlerts?: WeatherAlert[];
  fires?: MapFire[];
  radiation?: RadiationObservation[];
  naturalEvents?: NaturalEvent[];
  /** Reference time for recency windows (defaults to now). */
  now?: Date;
}

export interface FacilityHazardOptions {
  /** Which registry categories to evaluate. Defaults to the operating fleet plus restarts, new builds, DOE sites, and fuel cycle. */
  categories?: UsNuclearFacilityCategory[];
  /** Earthquake search radius in km (default 100). */
  earthquakeRadiusKm?: number;
  /** Minimum earthquake magnitude to report (default 2.5). */
  earthquakeMinMagnitude?: number;
  /** Earthquake recency window in hours (default 72). */
  earthquakeWindowHours?: number;
  /** Fire detection radius in km (default 25). */
  fireRadiusKm?: number;
  /** Radiation observation radius in km (default 80). */
  radiationRadiusKm?: number;
  /** Tropical cyclone / natural event radius in km (default 250). */
  stormRadiusKm?: number;
  /** Fallback radius for weather alerts that only have a centroid (default 60). */
  weatherCentroidRadiusKm?: number;
}

export const DEFAULT_HAZARD_CATEGORIES: UsNuclearFacilityCategory[] = [
  'power-reactor', 'restart', 'new-build', 'decommissioning', 'fuel-cycle', 'doe-site', 'waste', 'research-reactor', 'uranium-recovery',
];

const SEVERITY_RANK: Record<FacilityHazardSeverity, number> = { watch: 1, elevated: 2, high: 3, critical: 4 };
const SEVERITY_WEIGHT: Record<FacilityHazardSeverity, number> = { watch: 1, elevated: 3, high: 8, critical: 20 };

const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Ray-casting point-in-polygon on [lon, lat] rings. */
export function pointInPolygon(lat: number, lon: number, ring: Array<[number, number]>): boolean {
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ri = ring[i];
    const rj = ring[j];
    if (!ri || !rj) continue;
    const [xi, yi] = ri;
    const [xj, yj] = rj;
    const intersect = ((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function maxSeverity(a: FacilityHazardSeverity, b: FacilityHazardSeverity): FacilityHazardSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function earthquakeSeverity(magnitude: number, distanceKm: number): FacilityHazardSeverity {
  // Rough intensity proxy: strong shaking matters more when close. M5+ within
  // 50 km is the range where plants historically declared unusual events
  // (North Anna 2011, M5.8 at ~18 km).
  if (magnitude >= 6 || (magnitude >= 5 && distanceKm <= 50)) return 'critical';
  if (magnitude >= 5 || (magnitude >= 4 && distanceKm <= 50)) return 'high';
  if (magnitude >= 4 || (magnitude >= 3 && distanceKm <= 30)) return 'elevated';
  return 'watch';
}

function weatherSeverity(alert: WeatherAlert): FacilityHazardSeverity {
  const event = alert.event.toLowerCase();
  const catastrophic = /hurricane warning|tornado warning|flash flood emergency|tsunami warning|storm surge warning/.test(event);
  if (catastrophic || alert.severity === 'Extreme') return 'critical';
  if (alert.severity === 'Severe' || /warning/.test(event)) return 'high';
  if (alert.severity === 'Moderate' || /watch/.test(event)) return 'elevated';
  return 'watch';
}

function weatherKind(alert: WeatherAlert): FacilityHazardKind {
  const event = alert.event.toLowerCase();
  if (/hurricane|tropical|typhoon|storm surge/.test(event)) return 'storm';
  if (/flood/.test(event)) return 'flood';
  if (/fire|red flag/.test(event)) return 'fire';
  return 'weather';
}

function fireSeverity(frp: number, distanceKm: number, count: number): FacilityHazardSeverity {
  if (distanceKm <= 5 && (frp >= 50 || count >= 5)) return 'critical';
  if (distanceKm <= 10 || frp >= 100 || count >= 10) return 'high';
  if (distanceKm <= 15 || count >= 3) return 'elevated';
  return 'watch';
}

function radiationSeverity(obs: RadiationObservation): FacilityHazardSeverity {
  if (obs.severity === 'spike') return obs.corroborated ? 'critical' : 'high';
  if (obs.severity === 'elevated') return obs.confidence === 'low' ? 'watch' : 'elevated';
  return 'watch';
}

function stormSeverity(event: NaturalEvent, distanceKm: number): FacilityHazardSeverity {
  const cat = event.stormCategory ?? 0;
  if (cat >= 3 && distanceKm <= 150) return 'critical';
  if (cat >= 1 && distanceKm <= 150) return 'high';
  if (distanceKm <= 150) return 'elevated';
  return 'watch';
}

function naturalEventKind(event: NaturalEvent): FacilityHazardKind {
  const cat = String(event.category);
  if (cat.includes('storm') || cat.includes('cyclone') || event.stormId) return 'storm';
  if (cat.includes('flood')) return 'flood';
  if (cat.includes('volcano')) return 'volcano';
  if (cat.includes('fire')) return 'fire';
  if (cat.includes('earthquake')) return 'earthquake';
  return 'other';
}

function formatKm(km: number): string {
  return km < 1 ? '<1 km' : `${Math.round(km)} km`;
}

function alertCoversFacility(alert: WeatherAlert, facility: UsNuclearFacility, centroidRadiusKm: number): number | null {
  const ring = Array.isArray(alert.coordinates) ? alert.coordinates : [];
  if (ring.length >= 3 && alert.geometryPrecision !== 'country') {
    // Polygon coordinates in this codebase are [lon, lat] pairs when they
    // come from NWS GeoJSON; tolerate [lat, lon] by testing both orderings.
    const asLonLat = ring as Array<[number, number]>;
    if (pointInPolygon(facility.lat, facility.lon, asLonLat)) return 0;
    const swapped = asLonLat.map(([a, b]) => [b, a] as [number, number]);
    if (pointInPolygon(facility.lat, facility.lon, swapped)) return 0;
  }
  if (alert.centroid && alert.geometryPrecision !== 'country') {
    const [cLat, cLon] = alert.centroid;
    const d = haversineKm(facility.lat, facility.lon, cLat, cLon);
    if (d <= centroidRadiusKm) return d;
    const dSwapped = haversineKm(facility.lat, facility.lon, cLon, cLat);
    if (dSwapped <= centroidRadiusKm) return dSwapped;
  }
  return null;
}

export function correlateFacilityHazards(
  inputs: FacilityHazardInputs,
  options: FacilityHazardOptions = {},
  facilities: UsNuclearFacility[] = US_NUCLEAR_FACILITIES,
): FacilityHazardReport[] {
  const now = inputs.now ?? new Date();
  const categories = new Set(options.categories ?? DEFAULT_HAZARD_CATEGORIES);
  const quakeRadius = options.earthquakeRadiusKm ?? 100;
  const quakeMinMag = options.earthquakeMinMagnitude ?? 2.5;
  const quakeWindowMs = (options.earthquakeWindowHours ?? 72) * 3_600_000;
  const fireRadius = options.fireRadiusKm ?? 25;
  const radRadius = options.radiationRadiusKm ?? 80;
  const stormRadius = options.stormRadiusKm ?? 250;
  const centroidRadius = options.weatherCentroidRadiusKm ?? 60;

  // Pre-filter feeds once so the per-facility loop stays cheap.
  const quakes = (inputs.earthquakes ?? []).filter((q) =>
    q.location
    && Number.isFinite(q.location.latitude)
    && Number.isFinite(q.location.longitude)
    && q.magnitude >= quakeMinMag
    && (now.getTime() - q.occurredAt) <= quakeWindowMs,
  );
  const alerts = (inputs.weatherAlerts ?? []).filter((a) =>
    (!a.countryCode || a.countryCode === 'US')
    && a.expires.getTime() > now.getTime(),
  );
  const fires = inputs.fires ?? [];
  const radiation = (inputs.radiation ?? []).filter((r) => r.severity !== 'normal');
  const natural = (inputs.naturalEvents ?? []).filter((e) => !e.closed);

  const reports: FacilityHazardReport[] = [];

  for (const facility of facilities) {
    if (!categories.has(facility.category)) continue;
    const signals: FacilityHazardSignal[] = [];

    for (const q of quakes) {
      const loc = q.location!;
      const d = haversineKm(facility.lat, facility.lon, loc.latitude, loc.longitude);
      if (d > quakeRadius) continue;
      signals.push({
        kind: 'earthquake',
        severity: earthquakeSeverity(q.magnitude, d),
        summary: `M${q.magnitude.toFixed(1)} earthquake ${formatKm(d)} away (${q.place || 'USGS'})`,
        distanceKm: d,
        at: new Date(q.occurredAt),
        sourceUrl: q.sourceUrl || undefined,
        source: q.source === 'nrcan' ? 'NRCan' : 'USGS',
      });
    }

    for (const a of alerts) {
      const d = alertCoversFacility(a, facility, centroidRadius);
      if (d === null) continue;
      signals.push({
        kind: weatherKind(a),
        severity: weatherSeverity(a),
        summary: d === 0 ? `${a.event} in effect (${a.areaDesc || 'NWS'})` : `${a.event} ${formatKm(d)} away (${a.areaDesc || 'NWS'})`,
        distanceKm: d,
        at: a.onset,
        sourceUrl: a.sourceUrl,
        source: a.source || 'NWS',
      });
    }

    let fireCount = 0;
    let nearestFire = Number.POSITIVE_INFINITY;
    let maxFrp = 0;
    let latestFireDate = '';
    for (const f of fires) {
      const d = haversineKm(facility.lat, facility.lon, f.lat, f.lon);
      if (d > fireRadius) continue;
      fireCount += 1;
      nearestFire = Math.min(nearestFire, d);
      maxFrp = Math.max(maxFrp, f.frp || 0);
      if (f.acq_date > latestFireDate) latestFireDate = f.acq_date;
    }
    if (fireCount > 0) {
      signals.push({
        kind: 'fire',
        severity: fireSeverity(maxFrp, nearestFire, fireCount),
        summary: `${fireCount} satellite fire detection${fireCount === 1 ? '' : 's'} within ${fireRadius} km (nearest ${formatKm(nearestFire)}, peak ${Math.round(maxFrp)} MW FRP)`,
        distanceKm: nearestFire,
        at: latestFireDate ? new Date(`${latestFireDate}T00:00:00Z`) : undefined,
        source: 'NASA FIRMS',
      });
    }

    for (const r of radiation) {
      const d = haversineKm(facility.lat, facility.lon, r.lat, r.lon);
      if (d > radRadius) continue;
      signals.push({
        kind: 'radiation',
        severity: radiationSeverity(r),
        summary: `${r.severity === 'spike' ? 'Radiation spike' : 'Elevated radiation'} at ${r.location} ${formatKm(d)} away (${r.value.toFixed(0)} ${r.unit}, baseline ${r.baselineValue.toFixed(0)})`,
        distanceKm: d,
        at: r.observedAt,
        source: r.source,
      });
    }

    for (const e of natural) {
      const kind = naturalEventKind(e);
      let d = haversineKm(facility.lat, facility.lon, e.lat, e.lon);
      if (kind === 'storm' && e.forecastTrack?.length) {
        for (const p of e.forecastTrack) {
          const pd = haversineKm(facility.lat, facility.lon, p.lat, p.lon);
          if (pd < d) d = pd;
        }
      }
      const radius = kind === 'storm' ? stormRadius : Math.min(stormRadius, 100);
      if (d > radius) continue;
      signals.push({
        kind,
        severity: kind === 'storm' ? stormSeverity(e, d) : (d <= 25 ? 'high' : 'elevated'),
        summary: `${e.title}${e.stormCategory ? ` (Cat ${e.stormCategory})` : ''} ${formatKm(d)} from site${e.forecastTrack?.length ? ' along forecast track' : ''}`,
        distanceKm: d,
        at: e.date,
        sourceUrl: e.sourceUrl,
        source: e.sourceName || 'EONET',
      });
    }

    if (signals.length === 0) continue;

    signals.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.distanceKm - b.distanceKm);
    let severity: FacilityHazardSeverity = 'watch';
    let score = 0;
    for (const s of signals) {
      severity = maxSeverity(severity, s.severity);
      score += SEVERITY_WEIGHT[s.severity];
    }
    // Operating reactors and fuel-cycle plants carry more consequence than a
    // decommissioned ISFSI; weight the ranking so they float up on ties.
    const consequence = facility.category === 'power-reactor' || facility.category === 'restart' ? 1.5
      : facility.category === 'fuel-cycle' || facility.category === 'doe-site' ? 1.25
        : 1;
    reports.push({ facility, signals, severity, score: Math.round(score * consequence * 10) / 10 });
  }

  reports.sort((a, b) => b.score - a.score || a.facility.name.localeCompare(b.facility.name));
  return reports;
}

export interface FacilityHazardTotals {
  facilitiesWithSignals: number;
  critical: number;
  high: number;
  elevated: number;
  watch: number;
  byKind: Record<FacilityHazardKind, number>;
}

export function summarizeFacilityHazards(reports: FacilityHazardReport[]): FacilityHazardTotals {
  const totals: FacilityHazardTotals = {
    facilitiesWithSignals: reports.length,
    critical: 0, high: 0, elevated: 0, watch: 0,
    byKind: { earthquake: 0, weather: 0, fire: 0, radiation: 0, storm: 0, flood: 0, volcano: 0, other: 0 },
  };
  for (const r of reports) {
    totals[r.severity] += 1;
    for (const s of r.signals) totals.byKind[s.kind] += 1;
  }
  return totals;
}
