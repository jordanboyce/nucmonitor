/**
 * Showcase scenario: a fixed, clearly labeled set of hazard signals and NRC
 * events that light up every feature of the hub without depending on what is
 * happening in the world at demo time (src/config/showcase.ts).
 *
 * The scenario is timed relative to `now`, so it always reads as "today":
 *
 *   - Hurricane Marisol (Cat 3) in the northern Gulf, forecast to make
 *     landfall on the Louisiana coast; Hurricane and Storm Surge Warnings over
 *     Waterford 3, a Tropical Storm Warning over River Bend, a Tropical Storm
 *     Watch over South Texas Project; a regional telecom outage; an Unusual
 *     Event and an automatic reactor trip at Waterford 3; a low-confidence
 *     elevated RadNet reading at Baton Rouge consistent with rain washout.
 *   - An M5.4 earthquake 28 km off Diablo Canyon with an aftershock, and an
 *     Unusual Event at the plant (earthquake felt on site).
 *   - A wildfire in the Jemez Mountains west of Los Alamos National Laboratory
 *     with satellite detections inside 12 km and a Red Flag Warning.
 *   - A small M2.8 near Columbia Generating Station that stays below any
 *     threshold, so the demo also shows a quiet site.
 *
 * Every record carries "SAMPLE" in its title or summary. Storm and fire names
 * are invented. Nothing here describes a real event at a real site.
 *
 * Pure functions: no fetches, no DOM.
 */

import { SHOWCASE_SAMPLE_TAG, SHOWCASE_SCENARIO_ENABLED } from '@/config/showcase';
import { getUsNuclearFacility, US_NUCLEAR_FACILITIES, type UsNuclearFacility } from '@/config/us-nuclear-facilities';
import type { Earthquake } from '@/services/earthquakes';
import type { WeatherAlert } from '@/services/weather';
import type { RadiationObservation, RadiationWatchResult } from '@/services/radiation';
import type { FireDetection, MapFire } from '@/services/wildfires';
import type { InternetOutage, NaturalEvent } from '@/types';
import type { NrcEventReport } from '../../shared/nrc-event-reports';
import { NRC_EVENT_REPORTS_INDEX } from '../../shared/nrc-event-reports';
import type { NrcReactorStatusRow } from '@/shared/nrc-reactor-status';

export interface ShowcaseScenario {
  now: Date;
  earthquakes: Earthquake[];
  weatherAlerts: WeatherAlert[];
  /** FIRMS-shaped detections grouped by region, for the Satellite Fires panel. */
  fireRegions: Record<string, FireDetection[]>;
  /** The same detections in map / hazard-store shape. */
  fires: MapFire[];
  radiation: RadiationWatchResult;
  naturalEvents: NaturalEvent[];
  outages: InternetOutage[];
  /** Sample NRC Event Notifications, prepended to the live list. */
  nrcEvents: NrcEventReport[];
  /** Power-status overrides applied on top of the live NRC file, keyed by NRC unit label. */
  nrcStatusOverrides: NrcReactorStatusRow[];
  /** A complete two-day status file used only when the live NRC file cannot be loaded. */
  nrcStatusFallbackRows: NrcReactorStatusRow[];
}

const SAMPLE = SHOWCASE_SAMPLE_TAG;
const HOUR = 3_600_000;

/** Index of the storm and fire names used by the banner and the demo script. */
export const SHOWCASE_STORM_NAME = 'Hurricane Marisol';
export const SHOWCASE_FIRE_NAME = 'Cañada Fire';

function site(id: string): UsNuclearFacility {
  const facility = getUsNuclearFacility(id);
  if (!facility) throw new Error(`showcase scenario: unknown facility ${id}`);
  return facility;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function hhmm(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** A rectangle around a point, as [lon, lat] pairs (NWS GeoJSON order). */
function box(lat: number, lon: number, dLat: number, dLon: number): [number, number][] {
  return [
    [lon - dLon, lat - dLat],
    [lon + dLon, lat - dLat],
    [lon + dLon, lat + dLat],
    [lon - dLon, lat + dLat],
    [lon - dLon, lat - dLat],
  ];
}

function alert(
  id: string,
  event: string,
  severity: WeatherAlert['severity'],
  areaDesc: string,
  center: { lat: number; lon: number },
  size: { dLat: number; dLon: number },
  now: Date,
  hoursAgo: number,
  hoursAhead: number,
  description: string,
): WeatherAlert {
  return {
    id,
    event,
    severity,
    headline: `${SAMPLE}: ${event} for ${areaDesc}`,
    description: `${SAMPLE} scenario. ${description}`,
    areaDesc,
    onset: new Date(now.getTime() - hoursAgo * HOUR),
    expires: new Date(now.getTime() + hoursAhead * HOUR),
    coordinates: box(center.lat, center.lon, size.dLat, size.dLon),
    centroid: [center.lat, center.lon],
    countryCode: 'US',
    source: 'NWS (sample)',
    geometryPrecision: 'polygon',
    issuedBy: 'NWS (sample)',
  };
}

function quake(id: string, place: string, magnitude: number, depthKm: number, lat: number, lon: number, now: Date, hoursAgo: number): Earthquake {
  return {
    id,
    place: `${SAMPLE}: ${place}`,
    magnitude,
    depthKm,
    location: { latitude: lat, longitude: lon },
    occurredAt: now.getTime() - hoursAgo * HOUR,
    sourceUrl: 'https://earthquake.usgs.gov/earthquakes/map/',
    source: 'usgs',
    category: 'sample',
  };
}

function detection(id: string, lat: number, lon: number, frp: number, brightness: number, now: Date, hoursAgo: number, dayNight: 'D' | 'N'): FireDetection {
  return {
    id,
    location: { latitude: lat, longitude: lon },
    brightness,
    frp,
    confidence: frp >= 40 ? 'FIRE_CONFIDENCE_HIGH' : 'FIRE_CONFIDENCE_NOMINAL',
    satellite: 'VIIRS (sample)',
    detectedAt: now.getTime() - hoursAgo * HOUR,
    region: 'US Southwest',
    dayNight,
    possibleExplosion: false,
    source: 'sample',
    kind: 'wildfire',
    emergency: false,
    agencyFireId: '',
    agencyCode: '',
    fireSize: 0,
  };
}

function radnet(
  id: string,
  location: string,
  lat: number,
  lon: number,
  value: number,
  baseline: number,
  severity: RadiationObservation['severity'],
  confidence: RadiationObservation['confidence'],
  now: Date,
): RadiationObservation {
  const delta = Math.round((value - baseline) * 10) / 10;
  return {
    id,
    source: 'EPA RadNet',
    contributingSources: ['EPA RadNet'],
    location: `${location} (${SAMPLE})`,
    country: 'US',
    lat,
    lon,
    value,
    unit: 'nSv/h',
    observedAt: new Date(now.getTime() - 0.5 * HOUR),
    freshness: 'live',
    baselineValue: baseline,
    delta,
    zScore: Math.round((delta / Math.max(1, baseline * 0.08)) * 10) / 10,
    severity,
    confidence,
    corroborated: false,
    conflictingSources: false,
    convertedFromCpm: false,
    sourceCount: 1,
  };
}

function nrcEvent(
  now: Date,
  eventNumber: string,
  facility: UsNuclearFacility,
  units: string[],
  hoursAgo: number,
  emergencyClass: NrcEventReport['emergencyClass'],
  title: string,
  cfr: Array<[string, string]>,
  unitStatus: NrcEventReport['unitStatus'],
  narrative: string,
): NrcEventReport {
  const eventAt = new Date(now.getTime() - hoursAgo * HOUR);
  const notifiedAt = new Date(eventAt.getTime() + 0.75 * HOUR);
  return {
    eventNumber,
    category: 'power-reactor',
    categoryLabel: 'Power Reactor',
    facility: facility.name.toUpperCase(),
    units,
    region: facility.state === 'LA' || facility.state === 'TX' || facility.state === 'CA' ? 4 : 2,
    state: facility.state,
    city: facility.city,
    notificationDate: isoDate(notifiedAt),
    notificationTime: `${hhmm(notifiedAt)} [UTC]`,
    eventDate: isoDate(eventAt),
    eventTime: `${hhmm(eventAt)} [UTC]`,
    lastUpdateDate: isoDate(notifiedAt),
    emergencyClass,
    cfrSections: cfr.map(([code, description]) => ({ code, description })),
    unitStatus,
    title: `${SAMPLE}: ${title}`,
    narrative: `${SAMPLE} SCENARIO. This event is simulated for demonstration and did not occur.\n\n${narrative}`,
    retracted: false,
    updated: false,
    reportDate: isoDate(notifiedAt),
    sourceUrl: NRC_EVENT_REPORTS_INDEX,
  };
}

/** NRC-style unit labels for every operating or restarting power reactor in the registry. */
function registryUnitLabels(): string[] {
  const labels: string[] = [];
  for (const f of US_NUCLEAR_FACILITIES) {
    if (f.category !== 'power-reactor' && f.category !== 'restart') continue;
    const alias = f.statusAliases?.[0];
    if (!alias) continue;
    const base = alias.replace(/\b\w/g, (c) => c.toUpperCase());
    for (const u of f.units ?? []) {
      if (u.status !== 'operating') continue;
      const n = u.name.match(/(\d+)\s*$/)?.[1];
      labels.push(n ? `${base} ${n}` : base);
    }
  }
  return labels;
}

export function buildShowcaseScenario(now: Date = new Date()): ShowcaseScenario {
  const waterford = site('waterford');
  const riverBend = site('river-bend');
  const southTexas = site('south-texas');
  const diablo = site('diablo-canyon');
  const losAlamos = site('los-alamos');
  const columbia = site('columbia');

  // ── Gulf Coast hurricane ───────────────────────────────────────────────
  const stormCenter = { lat: 27.62, lon: -89.28 };
  const storm: NaturalEvent = {
    id: 'sample-storm-marisol',
    title: `${SAMPLE}: ${SHOWCASE_STORM_NAME}`,
    description: `${SAMPLE} scenario: Category 3 hurricane moving north-northwest at 10 kt, forecast landfall on the southeast Louisiana coast in about 30 hours.`,
    category: 'severeStorms',
    categoryTitle: 'Severe Storms',
    lat: stormCenter.lat,
    lon: stormCenter.lon,
    date: new Date(now.getTime() - 1 * HOUR),
    magnitude: 105,
    magnitudeUnit: 'kts',
    sourceUrl: 'https://www.nhc.noaa.gov/',
    sourceName: 'NHC (sample)',
    closed: false,
    stormId: 'sample-marisol',
    stormName: `${SHOWCASE_STORM_NAME} (${SAMPLE})`,
    basin: 'Atlantic',
    stormCategory: 3,
    classification: 'HU',
    windKt: 105,
    pressureMb: 958,
    movementDir: 340,
    movementSpeedKt: 10,
    forecastTrack: [
      { lat: 28.25, lon: -89.65, hour: 12, windKt: 105, category: 3 },
      { lat: 28.95, lon: -90.05, hour: 24, windKt: 100, category: 3 },
      { lat: 29.75, lon: -90.45, hour: 36, windKt: 75, category: 1 },
      { lat: 30.70, lon: -90.95, hour: 48, windKt: 45, category: 0 },
      { lat: 31.70, lon: -91.40, hour: 72, windKt: 30, category: 0 },
    ],
  };

  const weatherAlerts: WeatherAlert[] = [
    alert('sample-nws-hurricane-warning', 'Hurricane Warning', 'Extreme',
      'St. Charles, St. John the Baptist, Jefferson, Orleans, Lafourche Parishes (LA)',
      { lat: waterford.lat, lon: waterford.lon }, { dLat: 0.55, dLon: 0.9 }, now, 6, 36,
      `Hurricane conditions expected within 36 hours as ${SHOWCASE_STORM_NAME} approaches the southeast Louisiana coast. Sustained winds of 100 to 115 mph possible near the track.`),
    alert('sample-nws-surge-warning', 'Storm Surge Warning', 'Extreme',
      'Lower Mississippi River and Barataria Basin (LA)',
      { lat: 29.75, lon: -90.35 }, { dLat: 0.45, dLon: 0.7 }, now, 6, 36,
      'Life-threatening inundation of 8 to 12 feet above ground possible outside the levee system.'),
    alert('sample-nws-ts-warning', 'Tropical Storm Warning', 'Severe',
      'West and East Baton Rouge, West Feliciana, Pointe Coupee Parishes (LA)',
      { lat: riverBend.lat, lon: riverBend.lon }, { dLat: 0.45, dLon: 0.6 }, now, 4, 42,
      'Tropical storm conditions expected within 36 hours. Sustained winds of 50 to 65 mph with higher gusts as the center passes to the east.'),
    alert('sample-nws-ts-watch', 'Tropical Storm Watch', 'Moderate',
      'Matagorda and Brazoria Counties (TX)',
      { lat: southTexas.lat, lon: southTexas.lon }, { dLat: 0.5, dLon: 0.7 }, now, 3, 48,
      'Tropical storm conditions possible within 48 hours along the middle Texas coast on the western side of the circulation.'),
    alert('sample-nws-flood-watch', 'Flash Flood Watch', 'Moderate',
      'Claiborne, Jefferson, Warren Counties (MS); Tensas, Concordia Parishes (LA)',
      { lat: 32.0, lon: -91.0 }, { dLat: 0.6, dLon: 0.8 }, now, 1, 60,
      'Rainfall totals of 6 to 10 inches possible along the remnant track Thursday into Friday.'),
    // ── Jemez wildfire ──
    alert('sample-nws-red-flag', 'Red Flag Warning', 'Severe',
      'Jemez Mountains, Pajarito Plateau, Española Valley (NM)',
      { lat: losAlamos.lat, lon: losAlamos.lon }, { dLat: 0.45, dLon: 0.6 }, now, 2, 14,
      `Southwest winds 25 to 35 mph with gusts to 50 mph, relative humidity 6 to 10 percent, and extreme fire behavior expected on the ${SHOWCASE_FIRE_NAME}.`),
  ];

  const outages: InternetOutage[] = [{
    id: 'sample-outage-st-charles',
    title: `${SAMPLE}: Major telecom outage, St. Charles Parish, LA`,
    link: '',
    description: `${SAMPLE} scenario: regional fibre and cellular outage reported ahead of ${SHOWCASE_STORM_NAME}; utility and parish emergency communications operating on backup links.`,
    pubDate: new Date(now.getTime() - 1.5 * HOUR),
    country: 'US',
    region: 'Louisiana',
    lat: 29.93,
    lon: -90.36,
    severity: 'major',
    categories: ['telecom', 'weather'],
    cause: 'storm',
    outageType: 'regional',
  }];

  // ── Central Coast earthquake ───────────────────────────────────────────
  const earthquakes: Earthquake[] = [
    quake('sample-eq-hosgri-main', '28 km WNW of Avila Beach, CA (offshore)', 5.4, 9.8, 35.31, -121.14, now, 4.5),
    quake('sample-eq-hosgri-after', '26 km WNW of Avila Beach, CA (offshore)', 3.6, 8.1, 35.29, -121.11, now, 2.3),
    quake('sample-eq-columbia-minor', '31 km N of Richland, WA', 2.8, 12.0, columbia.lat + 0.28, columbia.lon, now, 19),
  ];

  // ── Jemez wildfire ─────────────────────────────────────────────────────
  const fireDetections: FireDetection[] = [
    detection('sample-fire-1', 35.845, -106.405, 86, 371, now, 2, 'D'),
    detection('sample-fire-2', 35.852, -106.398, 61, 352, now, 2, 'D'),
    detection('sample-fire-3', 35.838, -106.418, 44, 341, now, 2, 'D'),
    detection('sample-fire-4', 35.861, -106.389, 37, 336, now, 2, 'D'),
    detection('sample-fire-5', 35.830, -106.430, 29, 331, now, 8, 'N'),
    detection('sample-fire-6', 35.869, -106.381, 52, 348, now, 2, 'D'),
  ];
  const fireRegions: Record<string, FireDetection[]> = { 'US Southwest': fireDetections };
  const fires: MapFire[] = fireDetections.map((f) => ({
    lat: f.location!.latitude,
    lon: f.location!.longitude,
    brightness: f.brightness,
    frp: f.frp,
    confidence: f.confidence === 'FIRE_CONFIDENCE_HIGH' ? 90 : 60,
    region: f.region,
    acq_date: isoDate(new Date(f.detectedAt)),
    daynight: f.dayNight,
  }));

  const fireEvent: NaturalEvent = {
    id: 'sample-fire-canada',
    title: `${SAMPLE}: ${SHOWCASE_FIRE_NAME}, Jemez Mountains, NM`,
    description: `${SAMPLE} scenario: wind-driven wildfire on the east slope of the Jemez Mountains, 10 km west of Los Alamos National Laboratory, 0 percent contained.`,
    category: 'wildfires',
    categoryTitle: 'Wildfires',
    lat: 35.848,
    lon: -106.41,
    date: new Date(now.getTime() - 20 * HOUR),
    sourceUrl: 'https://eonet.gsfc.nasa.gov/',
    sourceName: 'EONET (sample)',
    closed: false,
  };

  // ── Radiation ──────────────────────────────────────────────────────────
  const observations: RadiationObservation[] = [
    radnet('sample-radnet-baton-rouge', 'Baton Rouge, LA', 30.45, -91.19, 118, 94, 'elevated', 'low', now),
    radnet('sample-radnet-new-orleans', 'New Orleans, LA', 29.95, -90.07, 96, 95, 'normal', 'high', now),
    radnet('sample-radnet-san-luis-obispo', 'San Luis Obispo, CA', 35.28, -120.66, 101, 102, 'normal', 'high', now),
    radnet('sample-radnet-los-alamos', 'Los Alamos, NM', 35.89, -106.30, 141, 139, 'normal', 'high', now),
    radnet('sample-radnet-albuquerque', 'Albuquerque, NM', 35.08, -106.65, 128, 126, 'normal', 'high', now),
    radnet('sample-radnet-richland', 'Richland, WA', 46.28, -119.28, 88, 89, 'normal', 'high', now),
  ];
  const radiation: RadiationWatchResult = {
    fetchedAt: now,
    observations,
    coverage: { epa: observations.length, safecast: 0 },
    summary: {
      anomalyCount: 1,
      elevatedCount: 1,
      spikeCount: 0,
      corroboratedCount: 0,
      lowConfidenceCount: 1,
      conflictingCount: 0,
      convertedFromCpmCount: 0,
    },
  };

  // ── NRC event notifications ────────────────────────────────────────────
  const nrcEvents: NrcEventReport[] = [
    nrcEvent(now, '00000003', waterford, ['3'], 4, 'non-emergency',
      'AUTOMATIC REACTOR TRIP ON LOSS OF OFFSITE POWER',
      [
        ['50.72(b)(2)(iv)(B)', 'RPS ACTUATION - CRITICAL'],
        ['50.72(b)(3)(iv)(A)', 'VALID SPECIF SYS ACTUATION'],
        ['50.72(b)(3)(v)(D)', 'ACCIDENT MITIGATION'],
      ],
      [{ unit: '3', scramCode: 'A/R', reactorCritical: false, initialPower: 100, initialMode: 'Power Operation', currentPower: 0, currentMode: 'Hot Standby' }],
      `At ${hhmm(new Date(now.getTime() - 4 * HOUR))} UTC, with ${SHOWCASE_STORM_NAME} approaching the site, both offsite 230 kV lines were lost when transmission structures south of the station were damaged by high winds. The reactor automatically tripped on loss of forced circulation. Both emergency diesel generators started and loaded as designed. All control rods fully inserted. Decay heat is being removed via the atmospheric steam dump valves and auxiliary feedwater. The licensee has notified the NRC Resident Inspector and the Louisiana Department of Environmental Quality. An Unusual Event remains in effect for the Hurricane Warning (see EN 00000002).`),
    nrcEvent(now, '00000002', waterford, ['3'], 9, 'unusual-event',
      'UNUSUAL EVENT DECLARED DUE TO HURRICANE WARNING',
      [['50.72(a)(1)(i)', 'EMERGENCY DECLARED']],
      [{ unit: '3', scramCode: 'N', reactorCritical: true, initialPower: 100, initialMode: 'Power Operation', currentPower: 100, currentMode: 'Power Operation' }],
      `The National Weather Service issued a Hurricane Warning for St. Charles Parish at ${hhmm(new Date(now.getTime() - 9.5 * HOUR))} UTC. In accordance with the site emergency plan (EAL HU1.1), the Shift Manager declared a Notification of Unusual Event. Storm preparations are in progress per the severe weather procedure. The unit remains at 100 percent power. State and parish authorities were notified within 15 minutes. The licensee will update the NRC Operations Center as conditions change.`),
    nrcEvent(now, '00000001', diablo, ['1', '2'], 4.4, 'unusual-event',
      'UNUSUAL EVENT DECLARED - EARTHQUAKE FELT ON SITE',
      [['50.72(a)(1)(i)', 'EMERGENCY DECLARED'], ['50.72(b)(3)(xiii)', 'LOSS COMM/ASMT/RESPONSE']],
      [
        { unit: '1', scramCode: 'N', reactorCritical: true, initialPower: 100, initialMode: 'Power Operation', currentPower: 100, currentMode: 'Power Operation' },
        { unit: '2', scramCode: 'N', reactorCritical: true, initialPower: 100, initialMode: 'Power Operation', currentPower: 100, currentMode: 'Power Operation' },
      ],
      `At ${hhmm(new Date(now.getTime() - 4.5 * HOUR))} UTC an earthquake was felt in the control rooms of both units. The USGS preliminary report is a magnitude 5.4 event about 28 km west-northwest of the site. The seismic monitoring system annunciated; the Operating Basis Earthquake exceedance determination is in progress. Both units remain at 100 percent power with no plant transients or abnormal indications. The Shift Manager declared an Unusual Event per EAL HU1.2. Post-seismic walkdowns of safety-related structures are under way. No damage has been identified.`),
  ];

  // ── NRC power status ───────────────────────────────────────────────────
  const today = isoDate(now);
  const yesterday = isoDate(new Date(now.getTime() - 24 * HOUR));
  const nrcStatusOverrides: NrcReactorStatusRow[] = [
    { reportDate: today, unit: 'Waterford 3', power: 0, reason: `${SAMPLE}: Automatic reactor trip on loss of offsite power during ${SHOWCASE_STORM_NAME}`, change: 'Unit tripped from 100% power' },
    { reportDate: today, unit: 'River Bend 1', power: 80, reason: `${SAMPLE}: Power reduced for severe weather procedure entry`, change: 'Down 20 points' },
    { reportDate: today, unit: 'Diablo Canyon 1', power: 100, reason: '', change: `${SAMPLE}: Unusual Event, M5.4 earthquake felt on site; unit at full power` },
    { reportDate: today, unit: 'Diablo Canyon 2', power: 100, reason: '', change: `${SAMPLE}: Unusual Event, M5.4 earthquake felt on site; unit at full power` },
  ];
  const overrideByUnit = new Map(nrcStatusOverrides.map((r) => [r.unit, r]));
  const nrcStatusFallbackRows: NrcReactorStatusRow[] = [];
  for (const unit of registryUnitLabels()) {
    nrcStatusFallbackRows.push({ reportDate: yesterday, unit, power: 100, reason: '', change: '' });
    nrcStatusFallbackRows.push(overrideByUnit.get(unit) ?? { reportDate: today, unit, power: 100, reason: '', change: '' });
  }

  return {
    now,
    earthquakes,
    weatherAlerts,
    fireRegions,
    fires,
    radiation,
    naturalEvents: [storm, fireEvent],
    outages,
    nrcEvents,
    nrcStatusOverrides,
    nrcStatusFallbackRows,
  };
}

let cached: ShowcaseScenario | null = null;

/** The active scenario, or null when the build was made without `VITE_SHOWCASE_SCENARIO`. */
export function getShowcaseScenario(): ShowcaseScenario | null {
  if (!SHOWCASE_SCENARIO_ENABLED) return null;
  // Rebuild once an hour so "4 hours ago" keeps reading as recent in a long demo.
  if (!cached || Date.now() - cached.now.getTime() > HOUR) cached = buildShowcaseScenario(new Date());
  return cached;
}

/** Apply the scenario's unit overrides on top of a live NRC status file. */
export function applyShowcaseStatusOverrides(rows: NrcReactorStatusRow[], scenario: ShowcaseScenario): NrcReactorStatusRow[] {
  if (rows.length === 0) return scenario.nrcStatusFallbackRows;
  let latest = '';
  for (const r of rows) if (r.reportDate > latest) latest = r.reportDate;
  const overrides = new Map(scenario.nrcStatusOverrides.map((o) => [o.unit.toLowerCase(), o]));
  // A unit the live file does not list (renamed, retired) is simply not overridden.
  return rows.map((r) => {
    const o = r.reportDate === latest ? overrides.get(r.unit.trim().toLowerCase()) : undefined;
    return o ? { ...r, power: o.power, reason: o.reason, change: o.change } : r;
  });
}
