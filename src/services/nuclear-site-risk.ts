/**
 * Site-centric risk status for US nuclear facilities.
 *
 * `correlateFacilityHazards` answers "which hazard signals are near which
 * facility". This module turns that into the question an operator or partner
 * actually asks each morning: "is anything happening inside this site's
 * emergency planning zones, and how worried should I be?"
 *
 * It buckets every signal by the two NRC emergency planning zones
 * (10 CFR 50.47 / NUREG-0654):
 *   - the ~10-mile plume exposure pathway EPZ, and
 *   - the ~50-mile ingestion exposure pathway EPZ,
 * with anything farther out (e.g. a hurricane forecast track 150 km away)
 * kept as "regional" context. Each facility then gets one explainable status:
 *
 *   WARNING — any high or critical signal inside the 10-mile EPZ,
 *             any critical signal inside the 50-mile EPZ, or
 *             a radiation reading at high or above inside the 50-mile EPZ.
 *   WATCH   — any elevated-or-worse signal inside the 50-mile EPZ,
 *             any critical signal anywhere in the regional watch radius, or
 *             three or more signals of any level inside the 10-mile EPZ.
 *   NORMAL  — everything else (no signals, or only low-level / far-field ones).
 *
 * The rule that fired is returned in `reasons`, so the UI and exports can
 * always say *why* a site is flagged. A status is a proximity screen built
 * from public feeds, not a statement about plant condition.
 *
 * Pure functions: no fetches, no DOM.
 */

import {
  getNrcRegion,
  US_NUCLEAR_CATEGORY_LABELS,
  US_NUCLEAR_FACILITIES,
  US_NUCLEAR_STATUS_LABELS,
  type UsNuclearFacility,
} from '@/config/us-nuclear-facilities';
import type {
  FacilityHazardKind,
  FacilityHazardReport,
  FacilityHazardSeverity,
  FacilityHazardSignal,
} from '@/services/nuclear-facility-hazards';

export const KM_PER_MILE = 1.609344;
/** Plume exposure pathway EPZ radius (miles). */
export const PLUME_EPZ_MILES = 10;
/** Ingestion exposure pathway EPZ radius (miles). */
export const INGESTION_EPZ_MILES = 50;
export const PLUME_EPZ_KM = PLUME_EPZ_MILES * KM_PER_MILE;
export const INGESTION_EPZ_KM = INGESTION_EPZ_MILES * KM_PER_MILE;
/** Signals inside the plume EPZ at or above this count raise WATCH regardless of level. */
export const PLUME_SIGNAL_COUNT_WATCH = 3;

export type SiteRiskStatus = 'normal' | 'watch' | 'warning';
export type SiteRiskZone = 'plume' | 'ingestion' | 'regional';

export const SITE_RISK_STATUS_LABELS: Record<SiteRiskStatus, string> = {
  normal: 'Normal',
  watch: 'Watch',
  warning: 'Warning',
};

const STATUS_RANK: Record<SiteRiskStatus, number> = { normal: 0, watch: 1, warning: 2 };
const SEVERITY_RANK: Record<FacilityHazardSeverity, number> = { watch: 1, elevated: 2, high: 3, critical: 4 };

export interface SiteRiskZoneCounts {
  total: number;
  byKind: Partial<Record<FacilityHazardKind, number>>;
}

export interface SiteRiskSignal extends FacilityHazardSignal {
  zone: SiteRiskZone;
  distanceMi: number;
}

export interface SiteRiskSummary {
  facility: UsNuclearFacility;
  status: SiteRiskStatus;
  /** Plain-language rules that produced the status (empty when normal with no signals). */
  reasons: string[];
  /** Highest signal severity at any distance, or null when there are no signals. */
  highestSeverity: FacilityHazardSeverity | null;
  /** Distance to the nearest signal, in miles; null when there are no signals. */
  nearestMi: number | null;
  plume: SiteRiskZoneCounts;
  ingestion: SiteRiskZoneCounts;
  regional: SiteRiskZoneCounts;
  /** All signals, most severe and nearest first, tagged with their zone. */
  signals: SiteRiskSignal[];
  /** Ranking score from the hazard correlation (0 when there are no signals). */
  score: number;
}

export function zoneForDistanceKm(distanceKm: number): SiteRiskZone {
  if (distanceKm <= PLUME_EPZ_KM) return 'plume';
  if (distanceKm <= INGESTION_EPZ_KM) return 'ingestion';
  return 'regional';
}

function emptyCounts(): SiteRiskZoneCounts {
  return { total: 0, byKind: {} };
}

function atLeast(severity: FacilityHazardSeverity, floor: FacilityHazardSeverity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[floor];
}

/** Apply the documented status rules to one facility's tagged signals. */
export function classifySiteRisk(signals: SiteRiskSignal[]): { status: SiteRiskStatus; reasons: string[] } {
  const warning: string[] = [];
  const watch: string[] = [];

  const plume = signals.filter((s) => s.zone === 'plume');
  const withinIngestion = signals.filter((s) => s.zone !== 'regional');

  const plumeSevere = plume.filter((s) => atLeast(s.severity, 'high'));
  if (plumeSevere.length) warning.push(`${plumeSevere.length} high/critical signal${plumeSevere.length === 1 ? '' : 's'} inside the ${PLUME_EPZ_MILES}-mile EPZ`);
  const ingestionCritical = withinIngestion.filter((s) => s.zone === 'ingestion' && s.severity === 'critical');
  if (ingestionCritical.length) warning.push(`critical signal inside the ${INGESTION_EPZ_MILES}-mile EPZ`);
  const radiation = withinIngestion.filter((s) => s.kind === 'radiation' && atLeast(s.severity, 'high'));
  if (radiation.length) warning.push(`radiation reading at high or above inside the ${INGESTION_EPZ_MILES}-mile EPZ`);

  if (warning.length) return { status: 'warning', reasons: warning };

  const ingestionElevated = withinIngestion.filter((s) => atLeast(s.severity, 'elevated'));
  if (ingestionElevated.length) watch.push(`${ingestionElevated.length} elevated signal${ingestionElevated.length === 1 ? '' : 's'} inside the ${INGESTION_EPZ_MILES}-mile EPZ`);
  const regionalCritical = signals.filter((s) => s.zone === 'regional' && s.severity === 'critical');
  if (regionalCritical.length) watch.push('critical signal in the surrounding region');
  if (plume.length >= PLUME_SIGNAL_COUNT_WATCH) watch.push(`${plume.length} signals inside the ${PLUME_EPZ_MILES}-mile EPZ`);

  if (watch.length) return { status: 'watch', reasons: watch };
  return { status: 'normal', reasons: [] };
}

function summarize(facility: UsNuclearFacility, report: FacilityHazardReport | undefined): SiteRiskSummary {
  const plume = emptyCounts();
  const ingestion = emptyCounts();
  const regional = emptyCounts();
  const signals: SiteRiskSignal[] = (report?.signals ?? []).map((s) => {
    const zone = zoneForDistanceKm(s.distanceKm);
    const counts = zone === 'plume' ? plume : zone === 'ingestion' ? ingestion : regional;
    counts.total += 1;
    counts.byKind[s.kind] = (counts.byKind[s.kind] ?? 0) + 1;
    return { ...s, zone, distanceMi: s.distanceKm / KM_PER_MILE };
  });
  signals.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.distanceKm - b.distanceKm);

  let highestSeverity: FacilityHazardSeverity | null = null;
  let nearestMi: number | null = null;
  for (const s of signals) {
    if (!highestSeverity || SEVERITY_RANK[s.severity] > SEVERITY_RANK[highestSeverity]) highestSeverity = s.severity;
    if (nearestMi === null || s.distanceMi < nearestMi) nearestMi = s.distanceMi;
  }

  const { status, reasons } = classifySiteRisk(signals);
  return {
    facility,
    status,
    reasons,
    highestSeverity,
    nearestMi,
    plume,
    ingestion,
    regional,
    signals,
    score: report?.score ?? 0,
  };
}

/**
 * One summary per facility (including quiet ones), sorted by status, then
 * hazard score, then name.
 */
export function buildSiteRiskSummaries(
  reports: FacilityHazardReport[],
  facilities: UsNuclearFacility[] = US_NUCLEAR_FACILITIES,
): SiteRiskSummary[] {
  const byId = new Map(reports.map((r) => [r.facility.id, r]));
  return facilities.map((f) => summarize(f, byId.get(f.id))).sort(compareSiteRisk);
}

export function compareSiteRisk(a: SiteRiskSummary, b: SiteRiskSummary): number {
  return STATUS_RANK[b.status] - STATUS_RANK[a.status]
    || b.score - a.score
    || a.facility.name.localeCompare(b.facility.name);
}

export interface SiteRiskTotals {
  warning: number;
  watch: number;
  normal: number;
  withSignals: number;
}

export function summarizeSiteRisk(summaries: SiteRiskSummary[]): SiteRiskTotals {
  const totals: SiteRiskTotals = { warning: 0, watch: 0, normal: 0, withSignals: 0 };
  for (const s of summaries) {
    totals[s.status] += 1;
    if (s.signals.length) totals.withSignals += 1;
  }
  return totals;
}

export function formatMiles(mi: number | null): string {
  if (mi === null) return '—';
  return mi < 1 ? '<1 mi' : `${Math.round(mi)} mi`;
}

/** Latest NRC daily power reading for a facility, joined by the caller. */
export interface SiteReactorPower {
  /** Unit label as the NRC status report prints it. */
  unit: string;
  /** Registry unit name it resolved to (e.g. "Unit 1"), when matched. */
  registryUnit?: string;
  power: number;
  reportDate: string;
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number') return `"${value}"`;
  // Neutralise spreadsheet formula injection, as src/utils/export.ts does.
  const safe = /^[\t\r\n]|^\s*[=+@-]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Facility table with current hazard status, one row per facility. Pure so it
 * can be tested; the panel hands the string to a download.
 */
export function buildSiteRiskCsv(
  summaries: SiteRiskSummary[],
  options: { generatedAt?: Date; power?: Map<string, SiteReactorPower[]> } = {},
): string {
  const generatedAt = options.generatedAt ?? new Date();
  const header = [
    'Facility', 'Facility ID', 'Category', 'Status', 'State', 'City', 'NRC region', 'Operator', 'Docket',
    'Units', 'Net MWe', 'Earliest license expiry', 'NRC power (latest)', 'Hazard status', 'Highest signal',
    `Signals within ${PLUME_EPZ_MILES} mi`, `Signals within ${INGESTION_EPZ_MILES} mi`, 'Regional signals',
    'Nearest signal (mi)', 'Reasons', 'Latitude', 'Longitude',
  ];
  const lines = [
    csvCell(`# NucMonitor facility hazard export — ${generatedAt.toISOString()}`),
    csvCell('# Proximity screen from public feeds; not a statement of plant condition. Confirm with NRC Event Notification Reports.'),
    header.map(csvCell).join(','),
  ];
  for (const s of summaries) {
    const f = s.facility;
    const units = f.units ?? [];
    const activeUnits = units.filter((u) => u.status === 'operating' || u.status === 'restarting');
    const mwe = activeUnits.reduce((sum, u) => sum + (u.netMwe ?? 0), 0);
    const expiries = units.map((u) => u.licenseExpires).filter((y): y is number => typeof y === 'number').sort((a, b) => a - b);
    const power = options.power?.get(f.id) ?? [];
    const region = getNrcRegion(f.state);
    lines.push([
      f.name,
      f.id,
      US_NUCLEAR_CATEGORY_LABELS[f.category],
      US_NUCLEAR_STATUS_LABELS[f.status],
      f.state,
      f.city ?? '',
      region ? String(region) : '',
      f.operator,
      f.docket ?? '',
      units.length,
      mwe || '',
      expiries[0] ?? '',
      power.map((p) => `${p.unit} ${p.power}%`).join('; '),
      SITE_RISK_STATUS_LABELS[s.status],
      s.highestSeverity ?? '',
      s.plume.total,
      s.plume.total + s.ingestion.total,
      s.regional.total,
      s.nearestMi === null ? '' : Math.round(s.nearestMi * 10) / 10,
      s.reasons.join('; '),
      f.lat,
      f.lon,
    ].map(csvCell).join(','));
  }
  return lines.join('\n');
}

/** Shape of the NRC status rows this module needs (see services/nrc-reactor-status). */
export interface NrcPowerSource {
  reportDate: string;
  units: Array<{ unit: string; power: number; facility?: { id: string }; unitRecord?: { name: string } }>;
}

/** Group the latest NRC daily power readings by registry facility id. */
export function groupReactorPowerByFacility(status: NrcPowerSource | null | undefined): Map<string, SiteReactorPower[]> {
  const out = new Map<string, SiteReactorPower[]>();
  if (!status) return out;
  for (const u of status.units) {
    if (!u.facility) continue;
    const list = out.get(u.facility.id) ?? [];
    list.push({ unit: u.unit, registryUnit: u.unitRecord?.name, power: u.power, reportDate: status.reportDate });
    out.set(u.facility.id, list);
  }
  return out;
}
