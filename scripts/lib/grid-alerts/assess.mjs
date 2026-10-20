// Assessment engine for the grid-alerts envelope: merges operator state, demand
// data, hazard alerts and space weather into per-region status, stress and a
// transparent hazard-impact score with named drivers.
//
// Scores are additive and capped at 100. Every contribution is recorded as a
// driver string so the panel can show *why* a region is flagged. The bands are:
//   >= 70 critical, >= 45 elevated, >= 20 watch, else low.

import { GRID_REGIONS, regionLatitude } from './regions.mjs';
import { GRID_STATUS_LEVELS, statusRank } from './adapters.mjs';

export const GRID_ALERTS_SCHEMA_VERSION = 1;

export const IMPACT_BANDS = Object.freeze([
  { band: 'critical', min: 70 },
  { band: 'elevated', min: 45 },
  { band: 'watch', min: 20 },
  { band: 'low', min: 0 },
]);

export function impactBand(score) {
  for (const b of IMPACT_BANDS) if (score >= b.min) return b.band;
  return 'low';
}

const STATUS_POINTS = { eea3: 40, eea2: 30, eea1: 20, conservative: 12, advisory: 8, watch: 4, normal: 0, unknown: 0 };
const STATUS_ALERT_LEVEL = { eea3: 'emergency', eea2: 'emergency', eea1: 'emergency', conservative: 'warning', advisory: 'advisory', watch: 'info' };

/** Geomagnetically induced current exposure from latitude: GICs grow toward the auroral oval. */
export function gicExposure(lat) {
  if (!Number.isFinite(lat)) return 'unknown';
  if (lat >= 45) return 'high';
  if (lat >= 40) return 'moderate';
  return 'low';
}

const GIC_POINTS = {
  // [G1..G5] by exposure
  high:     [0, 4, 10, 25, 40],
  moderate: [0, 2, 6, 15, 28],
  low:      [0, 0, 3, 8, 16],
  unknown:  [0, 0, 3, 8, 16],
};

export function spaceWeatherPoints(gLevel, exposure) {
  const g = Math.max(0, Math.min(5, Math.round(Number(gLevel) || 0)));
  if (g === 0) return 0;
  return (GIC_POINTS[exposure] ?? GIC_POINTS.unknown)[g - 1];
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return Math.round((a / b) * 1000) / 10;
}

function clamp100(v) { return Math.max(0, Math.min(100, Math.round(v))); }

/**
 * Derive demand-pressure metrics from whatever the region has.
 * Returns points + drivers + the metrics block that the UI renders.
 */
export function demandPressure(metrics) {
  const drivers = [];
  let points = 0;
  const demand = metrics.demandMw;
  const forecast = metrics.forecastMw;
  const peak = metrics.peakForecastMw;
  const capacity = metrics.capacityMw;
  const ratio = pct(demand, forecast);
  if (ratio !== null) {
    if (ratio >= 108) { points += 14; drivers.push(`Demand ${ratio}% of day-ahead forecast`); }
    else if (ratio >= 104) { points += 8; drivers.push(`Demand ${ratio}% of day-ahead forecast`); }
  }
  if (Number.isFinite(capacity) && Number.isFinite(demand) && capacity > 0) {
    const marginPct = pct(capacity - demand, capacity);
    if (marginPct !== null) {
      if (marginPct < 5) { points += 25; drivers.push(`Operating margin ${marginPct}% of committed capacity`); }
      else if (marginPct < 10) { points += 12; drivers.push(`Operating margin ${marginPct}% of committed capacity`); }
    }
  }
  if (Number.isFinite(metrics.prcMw)) {
    if (metrics.prcMw < 2300) { points += 30; drivers.push(`ERCOT physical responsive capability ${Math.round(metrics.prcMw)} MW (EEA threshold)`); }
    else if (metrics.prcMw < 3000) { points += 15; drivers.push(`ERCOT physical responsive capability ${Math.round(metrics.prcMw)} MW`); }
  }
  if (Number.isFinite(metrics.reservePct)) {
    if (metrics.reservePct < 3) { points += 30; drivers.push(`Reserve margin ${metrics.reservePct}%`); }
    else if (metrics.reservePct < 6) { points += 15; drivers.push(`Reserve margin ${metrics.reservePct}%`); }
  }
  if (Number.isFinite(peak) && Number.isFinite(demand) && peak > 0 && demand / peak >= 0.97) {
    points += 4; drivers.push('Load at or near forecast daily peak');
  }
  return { points, drivers, demandVsForecastPct: ratio };
}

/**
 * Assemble the envelope.
 * @param {object} inputs
 * @param {Map<string, object>} [inputs.eia] per-region EIA-930 metrics
 * @param {object[]} [inputs.operators] normalized operator states
 * @param {object[]} [inputs.weatherAlerts]
 * @param {object} [inputs.space]
 * @param {object[]} inputs.sources
 * @param {number} [inputs.nowMs]
 */
export function assessGrid({ eia, operators = [], weatherAlerts = [], space = null, sources = [], nowMs = Date.now(), weatherAlertTotal }) {
  const operatorById = new Map(operators.filter(Boolean).map((o) => [o.regionId, o]));
  const gNow = Number(space?.current?.g ?? 0) || 0;
  const gForecastMax = Math.max(gNow, ...(space?.forecast ?? []).map((d) => Number(d?.g) || 0));
  const alerts = [];
  const impacts = [];
  const regions = [];

  // Operator-condition alerts (one per operator with a non-normal state).
  for (const op of operators) {
    if (!op || op.level === 'normal' || op.level === 'unknown') continue;
    alerts.push({
      id: `op-${op.regionId}-${op.level}`,
      source: op.regionId.toLowerCase(),
      kind: 'operator',
      level: STATUS_ALERT_LEVEL[op.level] ?? 'advisory',
      title: `${op.regionId}: ${op.statusText}`,
      detail: op.note || '',
      regionIds: [op.regionId],
      issuedAt: op.updatedAt ?? new Date(nowMs).toISOString(),
      expires: null,
    });
  }

  // Weather alerts enter the unified feed with a level derived from severity.
  for (const wa of weatherAlerts) {
    alerts.push({
      id: wa.id,
      source: 'nws',
      kind: 'weather',
      level: wa.severity === 'Extreme' ? 'emergency' : wa.severity === 'Severe' ? 'warning' : 'advisory',
      title: wa.title,
      detail: wa.mechanism,
      event: wa.event,
      category: wa.category,
      areaDesc: wa.areaDesc,
      regionIds: wa.regionIds,
      issuedAt: wa.issuedAt,
      expires: wa.expires,
      centroid: wa.centroid,
      url: wa.url,
    });
  }

  // Space weather alerts (watches/warnings) and the current G-scale state.
  for (const sa of space?.alerts ?? []) {
    alerts.push({
      id: sa.id,
      source: 'swpc',
      kind: 'space',
      level: (sa.gLevel ?? 0) >= 4 ? 'emergency' : (sa.gLevel ?? 0) >= 3 ? 'warning' : 'advisory',
      title: sa.title,
      detail: sa.gLevel ? `Geomagnetic storm category G${sa.gLevel}` : 'Geomagnetic activity product',
      regionIds: [],
      issuedAt: sa.issuedAt,
      expires: null,
    });
  }
  if (gNow >= 1) {
    alerts.push({
      id: `swpc-g-now-${gNow}`,
      source: 'swpc',
      kind: 'space',
      level: gNow >= 4 ? 'emergency' : gNow >= 3 ? 'warning' : 'advisory',
      title: `Geomagnetic storm in progress: G${gNow} (${space?.current?.gText ?? ''})`.trim(),
      detail: 'Geomagnetically induced currents can saturate transformers and trip protection on long east-west lines; exposure rises with latitude.',
      regionIds: GRID_REGIONS.filter((r) => gicExposure(regionLatitude(r)) !== 'low').map((r) => r.id),
      issuedAt: new Date(nowMs).toISOString(),
      expires: null,
    });
  }

  const alertsByRegion = new Map();
  for (const wa of weatherAlerts) for (const rid of wa.regionIds) {
    if (!alertsByRegion.has(rid)) alertsByRegion.set(rid, []);
    alertsByRegion.get(rid).push(wa);
  }

  for (const def of GRID_REGIONS) {
    const op = operatorById.get(def.id) ?? null;
    const e = eia?.get(def.id) ?? null;
    const metrics = {
      demandMw: op?.outlook?.demandMw ?? e?.demandMw ?? null,
      demandAt: op?.outlook?.demandAt ?? e?.demandAt ?? null,
      forecastMw: e?.forecastMw ?? null,
      peakForecastMw: op?.outlook?.peakForecastMw ?? e?.peakForecastMw ?? null,
      capacityMw: op?.outlook?.capacityMw ?? null,
      netGenerationMw: e?.netGenerationMw ?? null,
      interchangeMw: e?.interchangeMw ?? null,
      prcMw: op?.prcMw ?? null,
      reservePct: op?.reservePct ?? null,
      demandHistory: e?.demandHistory ?? [],
    };
    const level = op?.level ?? 'unknown';
    const drivers = [];
    let score = 0;

    const statusPts = STATUS_POINTS[level] ?? 0;
    if (statusPts > 0) { score += statusPts; drivers.push(`Operator state: ${op.statusText}`); }

    const dp = demandPressure(metrics);
    score += dp.points; drivers.push(...dp.drivers);

    // Hazards: strongest alert counts fully, each further distinct category
    // adds a diminishing share so a cluster of advisories reads as compounding.
    const regionAlerts = (alertsByRegion.get(def.id) ?? []).slice().sort((a, b) => b.weight - a.weight);
    const hazardCategories = {};
    let hazardPts = 0;
    const seenCategories = new Set();
    for (const wa of regionAlerts) {
      const share = seenCategories.size === 0 ? 1 : seenCategories.has(wa.category) ? 0.15 : 0.5;
      hazardPts += wa.weight * share;
      seenCategories.add(wa.category);
      hazardCategories[wa.category] = Math.max(hazardCategories[wa.category] ?? 0, wa.weight);
    }
    if (regionAlerts.length > 0) {
      score += Math.min(50, hazardPts);
      const top = regionAlerts[0];
      drivers.push(`${top.event} (${top.severity}) in footprint${regionAlerts.length > 1 ? ` plus ${regionAlerts.length - 1} more hazard alert${regionAlerts.length > 2 ? 's' : ''}` : ''}`);
    }

    const exposure = gicExposure(regionLatitude(def));
    const gicPts = spaceWeatherPoints(gNow, exposure);
    if (gicPts > 0) { score += gicPts; drivers.push(`G${gNow} geomagnetic storm with ${exposure} GIC exposure`); }
    const gicForecastPts = gForecastMax > gNow ? Math.round(spaceWeatherPoints(gForecastMax, exposure) * 0.4) : 0;
    if (gicForecastPts > 0) { score += gicForecastPts; drivers.push(`G${gForecastMax} geomagnetic storm forecast within 3 days`); }

    const finalScore = clamp100(score);
    const band = impactBand(finalScore);
    const regionRecord = {
      id: def.id,
      name: def.name,
      kind: def.kind,
      operator: def.operator ?? null,
      interconnection: def.interconnection,
      states: def.states,
      centroid: def.centroid,
      status: level,
      statusText: op?.statusText ?? (e ? 'No operator condition feed; EIA-930 demand only' : 'No data'),
      statusUpdatedAt: op?.updatedAt ?? null,
      metrics: { ...metrics, demandVsForecastPct: dp.demandVsForecastPct },
      hazards: { alertCount: regionAlerts.length, categories: hazardCategories, topEvent: regionAlerts[0]?.event ?? null },
      space: { gicExposure: exposure, gNow },
      impact: { score: finalScore, band, drivers },
      dataSources: [op ? op.regionId.toLowerCase() === def.id.toLowerCase() ? def.operator : def.operator : null, e ? 'eia930' : null].filter(Boolean),
    };
    regions.push(regionRecord);
    if (finalScore >= 20 || regionAlerts.length > 0) {
      impacts.push({
        regionId: def.id,
        regionName: def.name,
        score: finalScore,
        band,
        drivers,
        hazardCategories,
        alertIds: regionAlerts.map((a) => a.id),
      });
    }
  }

  regions.sort((a, b) => b.impact.score - a.impact.score || statusRank(b.status) - statusRank(a.status) || a.name.localeCompare(b.name));
  impacts.sort((a, b) => b.score - a.score);
  const levelOrder = { emergency: 0, warning: 1, advisory: 2, info: 3 };
  alerts.sort((a, b) => (levelOrder[a.level] ?? 9) - (levelOrder[b.level] ?? 9) || String(b.issuedAt).localeCompare(String(a.issuedAt)));

  const worst = regions[0]?.impact ?? { score: 0, band: 'low' };
  const stressed = regions.filter((r) => r.impact.score >= 20).length;
  const emergencies = alerts.filter((a) => a.level === 'emergency').length;
  const overall = worst.band === 'critical' ? 'critical' : worst.band === 'elevated' ? 'elevated' : (stressed > 0 || gNow >= 1) ? 'watch' : 'normal';

  return {
    schemaVersion: GRID_ALERTS_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    summary: {
      overall,
      regionsAssessed: regions.length,
      regionsStressed: stressed,
      alertCount: alerts.length,
      emergencyCount: emergencies,
      weatherAlertCount: weatherAlerts.length,
      weatherAlertTotal: Number.isFinite(weatherAlertTotal) ? weatherAlertTotal : weatherAlerts.length,
      worstRegionId: regions[0]?.id ?? null,
      worstScore: worst.score,
      gNow,
      gForecastMax,
      kp: space?.kp ?? null,
      sourcesOk: sources.filter((s) => s.ok).length,
      sourcesTotal: sources.length,
    },
    regions,
    alerts,
    impacts,
    space: space ? {
      current: space.current,
      forecast: space.forecast,
      kp: space.kp ?? null,
      kpAt: space.kpAt ?? null,
      exposure: GRID_REGIONS.map((r) => ({ regionId: r.id, exposure: gicExposure(regionLatitude(r)), points: spaceWeatherPoints(gNow, gicExposure(regionLatitude(r))) })),
    } : null,
    hazardWeights: undefined,
    sources,
    statusLevels: GRID_STATUS_LEVELS,
    attribution: {
      notice: 'Operating conditions from the ISOs/RTOs public dashboards; hourly demand from the U.S. Energy Information Administration (EIA-930); hazard alerts from the National Weather Service; space weather from NOAA SWPC. Impact scores are WorldMonitor heuristics, not operator declarations.',
      sources: [
        { id: 'eia930', name: 'U.S. Energy Information Administration, Hourly Electric Grid Monitor', url: 'https://www.eia.gov/electricity/gridmonitor/' },
        { id: 'ercot', name: 'ERCOT Grid Conditions', url: 'https://www.ercot.com/gridmktinfo/dashboards' },
        { id: 'caiso', name: "CAISO Today's Outlook", url: 'https://www.caiso.com/todays-outlook' },
        { id: 'miso', name: 'MISO Real-Time Operations', url: 'https://www.misoenergy.org/markets-and-operations/real-time--market-data/' },
        { id: 'nyiso', name: 'NYISO Real-Time Dashboard', url: 'https://www.nyiso.com/real-time-dashboard' },
        { id: 'spp', name: 'SPP Current Grid Conditions', url: 'https://www.spp.org/grid-conditions' },
        { id: 'nws', name: 'National Weather Service Alerts', url: 'https://www.weather.gov/alerts' },
        { id: 'swpc', name: 'NOAA Space Weather Prediction Center', url: 'https://www.swpc.noaa.gov/' },
      ],
    },
  };
}

/** Record count for the seed contract: regions plus alerts carried. */
export function gridAlertsRecordCount(envelope) {
  if (!envelope || typeof envelope !== 'object') return 0;
  return (Array.isArray(envelope.regions) ? envelope.regions.length : 0) + (Array.isArray(envelope.alerts) ? envelope.alerts.length : 0);
}

/** Seed validation: a snapshot is publishable only if the regions table is complete and at least one upstream answered. */
export function validateGridAlerts(envelope) {
  if (!envelope || typeof envelope !== 'object') return false;
  if (!Array.isArray(envelope.regions) || envelope.regions.length < GRID_REGIONS.length) return false;
  if (!Array.isArray(envelope.alerts) || !Array.isArray(envelope.sources)) return false;
  if (!envelope.sources.some((s) => s?.ok)) return false;
  return typeof envelope.generatedAt === 'string' && envelope.schemaVersion === GRID_ALERTS_SCHEMA_VERSION;
}
