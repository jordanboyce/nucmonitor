// Source adapters for the grid-alerts envelope.
//
// Every adapter is a pure function of `(deps)` that returns a normalized
// partial result, and every adapter is isolated: one failing upstream marks its
// own `sources[]` entry failed and leaves the rest of the envelope intact.
// Network access is injected (`deps.fetchJson` / `deps.fetchText`) so the
// parsers are testable against fixtures without touching the providers.
//
// Provider notes (all read-only, public unless stated):
//   eia930  api.eia.gov v2 electricity/rto/region-data  (EIA_API_KEY required)
//   ercot   www.ercot.com dashboards daily-prc.json + todays-outlook.json
//   caiso   www.caiso.com/outlook/current stats.txt + demand.csv
//   miso    api.misoenergy.org MISORTWDDataBroker gettotalload
//   nyiso   mis.nyiso.com public pal (actual load) + isolf (forecast) CSVs
//   spp     www.spp.org grid-conditions page (HTML, status text only)
//   nws     api.weather.gov/alerts/active filtered to grid-relevant events
//   swpc    services.swpc.noaa.gov NOAA scales, planetary Kp, alerts
//
// The dashboard JSON files published by the ISOs are undocumented and may
// change shape; every parser tolerates missing fields and reports `ok:false`
// with a reason rather than throwing.

import { GRID_REGIONS, regionsForStates } from './regions.mjs';

export const GRID_ALERTS_USER_AGENT = 'WorldMonitor/2.0 (+https://worldmonitor.app; grid-alerts)';

export const EIA_930_URL = 'https://api.eia.gov/v2/electricity/rto/region-data/data/';
export const ERCOT_PRC_URL = 'https://www.ercot.com/api/1/services/read/dashboards/daily-prc.json';
export const ERCOT_OUTLOOK_URL = 'https://www.ercot.com/api/1/services/read/dashboards/todays-outlook.json';
export const CAISO_STATS_URL = 'https://www.caiso.com/outlook/current/stats.txt';
export const CAISO_DEMAND_URL = 'https://www.caiso.com/outlook/current/demand.csv';
export const MISO_LOAD_URL = 'https://api.misoenergy.org/MISORTWDDataBroker/DataBrokerServices.asmx?messageType=gettotalload&returnType=json';
export const NYISO_BASE_URL = 'https://mis.nyiso.com/public/csv';
export const SPP_CONDITIONS_URL = 'https://www.spp.org/grid-conditions';
export const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active';
export const SWPC_SCALES_URL = 'https://services.swpc.noaa.gov/products/noaa-scales.json';
export const SWPC_KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
export const SWPC_ALERTS_URL = 'https://services.swpc.noaa.gov/products/alerts.json';

/**
 * NWS event names that plausibly stress or damage the bulk power system.
 * Weight is the hazard's base contribution (0-40) to a region's impact score
 * before severity scaling. Categories drive the hazard matrix in the panel.
 */
export const GRID_HAZARD_EVENTS = Object.freeze({
  'Ice Storm Warning':            { category: 'winter',  weight: 40, mechanism: 'Line and tower icing; conductor galloping' },
  'Hurricane Warning':            { category: 'tropical', weight: 40, mechanism: 'Wind damage to distribution and transmission; flooding of substations' },
  'Hurricane Watch':              { category: 'tropical', weight: 24, mechanism: 'Possible hurricane-force wind within 48h' },
  'Tropical Storm Warning':       { category: 'tropical', weight: 26, mechanism: 'Tree contact and distribution outages' },
  'Tropical Storm Watch':         { category: 'tropical', weight: 14, mechanism: 'Possible tropical-storm wind within 48h' },
  'Storm Surge Warning':          { category: 'tropical', weight: 22, mechanism: 'Coastal substation and plant flooding' },
  'Blizzard Warning':             { category: 'winter',  weight: 30, mechanism: 'Wind plus snow load; crew access blocked' },
  'Winter Storm Warning':         { category: 'winter',  weight: 20, mechanism: 'Snow and ice load; heating demand' },
  'Winter Storm Watch':           { category: 'winter',  weight: 10, mechanism: 'Possible significant winter weather' },
  'Extreme Cold Warning':         { category: 'cold',    weight: 28, mechanism: 'Peak heating demand; gas supply freeze-offs; unit trips' },
  'Extreme Cold Watch':           { category: 'cold',    weight: 14, mechanism: 'Possible dangerous cold' },
  'Cold Weather Advisory':        { category: 'cold',    weight: 10, mechanism: 'Elevated heating demand' },
  'Wind Chill Warning':           { category: 'cold',    weight: 22, mechanism: 'Peak heating demand; freeze-related unit outages' },
  'Wind Chill Advisory':          { category: 'cold',    weight: 10, mechanism: 'Elevated heating demand' },
  'Extreme Heat Warning':         { category: 'heat',    weight: 28, mechanism: 'Peak cooling demand; derated thermal units and lines' },
  'Excessive Heat Warning':       { category: 'heat',    weight: 28, mechanism: 'Peak cooling demand; derated thermal units and lines' },
  'Extreme Heat Watch':           { category: 'heat',    weight: 14, mechanism: 'Possible dangerous heat' },
  'Excessive Heat Watch':         { category: 'heat',    weight: 14, mechanism: 'Possible dangerous heat' },
  'Heat Advisory':                { category: 'heat',    weight: 12, mechanism: 'Elevated cooling demand' },
  'High Wind Warning':            { category: 'wind',    weight: 22, mechanism: 'Tree contact; pole and line damage; PSPS risk' },
  'High Wind Watch':              { category: 'wind',    weight: 10, mechanism: 'Possible damaging wind' },
  'Wind Advisory':                { category: 'wind',    weight: 8,  mechanism: 'Scattered distribution outages' },
  'Extreme Wind Warning':         { category: 'wind',    weight: 34, mechanism: 'Hurricane-force wind in progress' },
  'Severe Thunderstorm Warning':  { category: 'storm',   weight: 16, mechanism: 'Lightning trips; microburst line damage' },
  'Severe Thunderstorm Watch':    { category: 'storm',   weight: 8,  mechanism: 'Organized severe storms possible' },
  'Tornado Warning':              { category: 'storm',   weight: 24, mechanism: 'Transmission structure failure in the path' },
  'Tornado Watch':                { category: 'storm',   weight: 10, mechanism: 'Tornado outbreak possible' },
  'Red Flag Warning':             { category: 'fire',    weight: 16, mechanism: 'Wildfire ignition risk; public-safety power shutoffs' },
  'Fire Weather Watch':           { category: 'fire',    weight: 8,  mechanism: 'Critical fire weather possible' },
  'Flood Warning':                { category: 'flood',   weight: 10, mechanism: 'Substation and underground vault flooding' },
  'Flash Flood Warning':          { category: 'flood',   weight: 14, mechanism: 'Rapid substation flooding; access loss' },
  'Flash Flood Emergency':        { category: 'flood',   weight: 26, mechanism: 'Catastrophic flooding' },
  'Dust Storm Warning':           { category: 'wind',    weight: 10, mechanism: 'Insulator contamination flashover' },
});

export const GRID_HAZARD_EVENT_NAMES = Object.freeze(Object.keys(GRID_HAZARD_EVENTS));

const SEVERITY_FACTOR = { Extreme: 1, Severe: 0.8, Moderate: 0.55, Minor: 0.3, Unknown: 0.4 };

// ─── shared helpers ──────────────────────────────────────────────────────────

export function createFetchDeps({ timeoutMs = 20_000, fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
  async function request(url, accept, extraHeaders = {}) {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': GRID_ALERTS_USER_AGENT, Accept: accept, ...extraHeaders },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  return {
    fetchJson: async (url, headers) => JSON.parse(await request(url, 'application/json, text/plain, */*', headers)),
    fetchText: (url, headers) => request(url, 'text/csv, text/plain, text/html, */*', headers),
    now: () => Date.now(),
  };
}

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value.replace(/,/g, '').trim());
    return Number.isFinite(n) && value.trim() !== '' ? n : null;
  }
  return null;
}

function round(value, digits = 0) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

// Upstream stamps are published without a zone designator (ERCOT
// "2026-10-20T20:55:12", SWPC "2026-10-20 18:00:00.000"). Date.parse would
// read those as host-local time, so the same payload would hash to a
// different instant depending on where the seeder runs. Pin them to UTC.
const ZONELESS_STAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
function isoOrNull(value) {
  const raw = String(value ?? '').trim();
  const m = ZONELESS_STAMP.exec(raw);
  const t = Date.parse(m ? `${m[1]}T${m[2]}Z` : raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Minimal RFC-4180-tolerant CSV parser (quoted fields, no embedded newlines). */
export function parseCsv(text) {
  const rows = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cells = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; } else { quoted = !quoted; }
      } else if (ch === ',' && !quoted) {
        cells.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

/**
 * Map an operator's free-text condition to the shared status ladder.
 * The ladder is ordered by operational severity; `statusRank` exposes it.
 */
export const GRID_STATUS_LEVELS = Object.freeze(['normal', 'watch', 'advisory', 'conservative', 'eea1', 'eea2', 'eea3', 'unknown']);

export function statusRank(level) {
  const idx = GRID_STATUS_LEVELS.indexOf(level);
  return idx < 0 || level === 'unknown' ? 0 : idx;
}

export function classifyOperatorStatus(text) {
  const s = String(text || '').toLowerCase();
  if (!s.trim()) return 'unknown';
  const eea = s.match(/(?:eea|energy emergency alert)\s*(?:level\s*)?([123])/);
  if (eea) return `eea${eea[1]}`;
  if (/\beea\b|energy emergency/.test(s)) return 'eea1';
  if (/conservative|conservation appeal|conservation alert|flex alert|max(?:imum)? gen(?:eration)?|capacity advisory|restricted maintenance/.test(s)) return 'conservative';
  if (/advisory|alert|warning|emergency/.test(s)) return 'advisory';
  if (/watch|weather watch|cold weather|hot weather/.test(s)) return 'watch';
  if (/normal/.test(s)) return 'normal';
  return 'unknown';
}

function sourceEntry(id, label, url, started, ok, extra = {}) {
  return { id, label, url, ok, fetchedAt: new Date().toISOString(), latencyMs: Math.max(0, Date.now() - started), ...extra };
}

async function guarded(id, label, url, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    return { ...result, source: sourceEntry(id, label, url, started, true, result?.sourceExtra) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { source: sourceEntry(id, label, url, started, false, { error: message.slice(0, 200) }) };
  }
}

// ─── EIA-930 ─────────────────────────────────────────────────────────────────

/** Hourly demand (D), day-ahead forecast (DF), net generation (NG), interchange (TI). */
export function buildEia930Url(type, startIso, endIso, apiKey) {
  const params = new URLSearchParams({
    frequency: 'hourly',
    'data[0]': 'value',
    'facets[type][]': type,
    start: startIso,
    end: endIso,
    'sort[0][column]': 'period',
    'sort[0][direction]': 'desc',
    length: '5000',
    api_key: apiKey,
  });
  for (const r of GRID_REGIONS) params.append('facets[respondent][]', r.id);
  return `${EIA_930_URL}?${params.toString()}`;
}

function eiaHour(date) {
  // EIA-930 periods are UTC hours formatted YYYY-MM-DDTHH.
  return new Date(date).toISOString().slice(0, 13);
}

/**
 * Normalize EIA-930 rows into per-region metrics.
 * @param {Record<string, Array<{period:string, respondent:string, value:unknown}>>} rowsByType
 */
export function normalizeEia930(rowsByType, nowMs = Date.now()) {
  const regions = new Map();
  const ensure = (id) => {
    if (!regions.has(id)) regions.set(id, { demandMw: null, demandAt: null, forecastMw: null, forecastAt: null, peakForecastMw: null, peakForecastAt: null, netGenerationMw: null, interchangeMw: null, demandHistory: [] });
    return regions.get(id);
  };
  const nowHour = eiaHour(nowMs);
  for (const row of rowsByType.D ?? []) {
    const value = toNumber(row.value);
    if (value === null || !row.respondent) continue;
    const r = ensure(row.respondent);
    if (r.demandAt === null) { r.demandMw = value; r.demandAt = row.period; }
    if (r.demandHistory.length < 24) r.demandHistory.push([row.period, value]);
  }
  for (const row of rowsByType.NG ?? []) {
    const value = toNumber(row.value);
    if (value === null || !row.respondent) continue;
    const r = ensure(row.respondent);
    if (r.netGenerationMw === null) r.netGenerationMw = value;
  }
  for (const row of rowsByType.TI ?? []) {
    const value = toNumber(row.value);
    if (value === null || !row.respondent) continue;
    const r = ensure(row.respondent);
    if (r.interchangeMw === null) r.interchangeMw = value;
  }
  for (const row of rowsByType.DF ?? []) {
    const value = toNumber(row.value);
    if (value === null || !row.respondent) continue;
    const r = ensure(row.respondent);
    // Forecast for the hour matching the latest actual, else nearest current hour.
    const target = r.demandAt ?? nowHour;
    if (row.period === target || (r.forecastAt === null && row.period <= nowHour)) { r.forecastMw = value; r.forecastAt = row.period; }
    if (row.period >= nowHour && (r.peakForecastMw === null || value > r.peakForecastMw)) { r.peakForecastMw = value; r.peakForecastAt = row.period; }
  }
  for (const r of regions.values()) r.demandHistory.reverse();
  return regions;
}

export async function fetchEia930(deps, { apiKey = process.env.EIA_API_KEY } = {}) {
  return guarded('eia930', 'EIA-930 hourly grid monitor', EIA_930_URL, async () => {
    if (!apiKey) throw new Error('EIA_API_KEY not configured');
    const now = deps.now();
    const start = eiaHour(now - 8 * 3600_000);
    const endForecast = eiaHour(now + 30 * 3600_000);
    const endActual = eiaHour(now + 3600_000);
    const rowsByType = {};
    for (const [type, end] of [['D', endActual], ['DF', endForecast], ['NG', endActual], ['TI', endActual]]) {
      const body = await deps.fetchJson(buildEia930Url(type, start, end, apiKey));
      const rows = body?.response?.data;
      if (!Array.isArray(rows)) throw new Error(`EIA-930 ${type}: malformed response.data`);
      rowsByType[type] = rows;
    }
    const regions = normalizeEia930(rowsByType, now);
    if (regions.size === 0) throw new Error('EIA-930 returned no rows');
    return { eia: regions, sourceExtra: { records: regions.size } };
  });
}

// ─── ERCOT ───────────────────────────────────────────────────────────────────

export function normalizeErcotPrc(json) {
  const cc = json?.current_condition ?? json?.currentCondition ?? null;
  if (!cc || typeof cc !== 'object') throw new Error('daily-prc.json: no current_condition');
  const title = String(cc.title ?? cc.state ?? '').trim();
  const note = String(cc.condition_note ?? cc.note ?? '').trim();
  const prcMw = toNumber(cc.prc_value ?? cc.prc ?? cc.prcValue);
  const eea = toNumber(cc.eea_level ?? cc.eeaLevel);
  let level = classifyOperatorStatus(`${title} ${cc.state ?? ''}`);
  if (eea !== null && eea >= 1 && eea <= 3) level = `eea${eea}`;
  return {
    level,
    statusText: title || note || 'Unknown',
    note,
    prcMw,
    updatedAt: isoOrNull(json?.lastUpdated ?? cc.datetime),
  };
}

export function normalizeErcotOutlook(json) {
  const rows = Array.isArray(json?.data) ? json.data : [];
  let demandMw = null; let demandAt = null; let capacityMw = null;
  let peakForecastMw = null; let peakForecastAt = null;
  for (const row of rows) {
    const demand = toNumber(row.demand);
    const capacity = toNumber(row.capacity);
    const isForecast = row.forecast === 1 || row.forecast === true || row.forecast === '1';
    const ts = row.timestamp ?? row.time ?? null;
    if (!isForecast && demand !== null) { demandMw = demand; demandAt = ts; if (capacity !== null) capacityMw = capacity; }
    if (isForecast && demand !== null && (peakForecastMw === null || demand > peakForecastMw)) { peakForecastMw = demand; peakForecastAt = ts; }
  }
  return { demandMw, demandAt: demandAt ? String(demandAt) : null, capacityMw, peakForecastMw, peakForecastAt: peakForecastAt ? String(peakForecastAt) : null, updatedAt: isoOrNull(json?.lastUpdated) };
}

export async function fetchErcot(deps) {
  return guarded('ercot', 'ERCOT grid conditions', ERCOT_PRC_URL, async () => {
    const prc = normalizeErcotPrc(await deps.fetchJson(ERCOT_PRC_URL));
    let outlook = null;
    try { outlook = normalizeErcotOutlook(await deps.fetchJson(ERCOT_OUTLOOK_URL)); } catch { outlook = null; }
    return { operator: { regionId: 'ERCO', ...prc, outlook }, sourceExtra: { status: prc.statusText } };
  });
}

// ─── CAISO ───────────────────────────────────────────────────────────────────

export function normalizeCaisoStats(json) {
  if (!json || typeof json !== 'object') throw new Error('stats.txt: not an object');
  const statuses = Array.isArray(json.gridstatus) ? json.gridstatus.map(String) : (json.gridstatus ? [String(json.gridstatus)] : []);
  const statusText = statuses.join('; ') || 'Unknown';
  const flexAlert = statuses.some((s) => /flex/i.test(s)) || json.flexAlert === true || json.flex_alert === true;
  const reservePct = toNumber(json.Current_reserve ?? json.current_reserve ?? json.reserve);
  return {
    level: flexAlert ? 'conservative' : classifyOperatorStatus(statusText),
    statusText,
    flexAlert,
    reservePct,
    updatedAt: isoOrNull(json.slotDate ?? json.updated ?? json.timestamp),
  };
}

export function normalizeCaisoDemand(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { demandMw: null, peakForecastMw: null };
  const header = rows[0].map((h) => h.toLowerCase());
  const col = (re) => header.findIndex((h) => re.test(h));
  const cDemand = col(/current demand/);
  const cDayAhead = col(/day ahead/);
  const cHourAhead = col(/hour ahead/);
  let demandMw = null; let demandAt = null; let peakForecastMw = null;
  for (const row of rows.slice(1)) {
    const d = cDemand >= 0 ? toNumber(row[cDemand]) : null;
    if (d !== null) { demandMw = d; demandAt = row[0]; }
    const f = cDayAhead >= 0 ? toNumber(row[cDayAhead]) : (cHourAhead >= 0 ? toNumber(row[cHourAhead]) : null);
    if (f !== null && (peakForecastMw === null || f > peakForecastMw)) peakForecastMw = f;
  }
  return { demandMw, demandAt, peakForecastMw };
}

export async function fetchCaiso(deps) {
  return guarded('caiso', 'CAISO Today\'s Outlook', CAISO_STATS_URL, async () => {
    const stats = normalizeCaisoStats(await deps.fetchJson(CAISO_STATS_URL));
    let demand = null;
    try { demand = normalizeCaisoDemand(await deps.fetchText(CAISO_DEMAND_URL)); } catch { demand = null; }
    return { operator: { regionId: 'CISO', ...stats, outlook: demand }, sourceExtra: { status: stats.statusText } };
  });
}

// ─── MISO ────────────────────────────────────────────────────────────────────

export function normalizeMisoLoad(json) {
  const info = json?.LoadInfo ?? json?.loadInfo ?? json;
  if (!info || typeof info !== 'object') throw new Error('gettotalload: unexpected shape');
  const fiveMin = Array.isArray(info.FiveMinTotalLoad) ? info.FiveMinTotalLoad : [];
  let demandMw = null; let demandAt = null;
  for (const entry of fiveMin) {
    const load = entry?.Load ?? entry;
    const v = toNumber(load?.Value ?? load?.value);
    if (v !== null) { demandMw = v; demandAt = String(load?.Time ?? load?.time ?? ''); }
  }
  const mtlf = Array.isArray(info.MediumTermLoadForecast) ? info.MediumTermLoadForecast : [];
  let peakForecastMw = null; let peakForecastAt = null;
  for (const entry of mtlf) {
    const f = entry?.Forecast ?? entry;
    const v = toNumber(f?.LoadForecast ?? f?.loadForecast ?? f?.Value);
    if (v !== null && (peakForecastMw === null || v > peakForecastMw)) { peakForecastMw = v; peakForecastAt = String(f?.HourEnding ?? f?.Time ?? ''); }
  }
  if (demandMw === null && peakForecastMw === null) throw new Error('gettotalload: no load values');
  return { demandMw, demandAt, peakForecastMw, peakForecastAt, updatedAt: null };
}

export async function fetchMiso(deps) {
  return guarded('miso', 'MISO real-time load', MISO_LOAD_URL, async () => {
    const load = normalizeMisoLoad(await deps.fetchJson(MISO_LOAD_URL));
    return { operator: { regionId: 'MISO', level: 'unknown', statusText: 'Load only (no public condition feed)', outlook: load, noStatusFeed: true } };
  });
}

// ─── NYISO ───────────────────────────────────────────────────────────────────

export function nyisoDateStamp(nowMs) {
  // NYISO files are keyed by Eastern-time calendar day. Use America/New_York.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

export function normalizeNyisoActual(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { demandMw: null, demandAt: null };
  const header = rows[0].map((h) => h.toLowerCase());
  const cTime = header.findIndex((h) => h.includes('time stamp'));
  const cLoad = header.indexOf('load');
  if (cTime < 0 || cLoad < 0) return { demandMw: null, demandAt: null };
  const totals = new Map();
  for (const row of rows.slice(1)) {
    const v = toNumber(row[cLoad]);
    if (v === null) continue;
    const ts = row[cTime];
    totals.set(ts, (totals.get(ts) ?? 0) + v);
  }
  let demandMw = null; let demandAt = null;
  for (const [ts, total] of totals) { demandMw = total; demandAt = ts; }
  return { demandMw: demandMw === null ? null : round(demandMw), demandAt };
}

export function normalizeNyisoForecast(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { peakForecastMw: null, peakForecastAt: null };
  const header = rows[0].map((h) => h.toLowerCase());
  const cTotal = header.indexOf('nyiso');
  if (cTotal < 0) return { peakForecastMw: null, peakForecastAt: null };
  let peakForecastMw = null; let peakForecastAt = null;
  for (const row of rows.slice(1)) {
    const v = toNumber(row[cTotal]);
    if (v !== null && (peakForecastMw === null || v > peakForecastMw)) { peakForecastMw = v; peakForecastAt = row[0]; }
  }
  return { peakForecastMw, peakForecastAt };
}

export async function fetchNyiso(deps) {
  const stamp = nyisoDateStamp(deps.now());
  const actualUrl = `${NYISO_BASE_URL}/pal/${stamp}pal.csv`;
  const forecastUrl = `${NYISO_BASE_URL}/isolf/${stamp}isolf.csv`;
  return guarded('nyiso', 'NYISO real-time load', actualUrl, async () => {
    const actual = normalizeNyisoActual(await deps.fetchText(actualUrl));
    let forecast = { peakForecastMw: null, peakForecastAt: null };
    try { forecast = normalizeNyisoForecast(await deps.fetchText(forecastUrl)); } catch { /* forecast optional */ }
    if (actual.demandMw === null) throw new Error('pal.csv: no load rows');
    return { operator: { regionId: 'NYIS', level: 'unknown', statusText: 'Load only (no public condition feed)', outlook: { ...actual, ...forecast }, noStatusFeed: true } };
  });
}

// ─── SPP ─────────────────────────────────────────────────────────────────────

export function normalizeSppConditions(html) {
  const text = String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const patterns = [
    /energy emergency alert\s*(?:level\s*)?([123])/i,
    /conservative operations? advisory/i,
    /conservative operations?/i,
    /resource advisory/i,
    /(?:cold|hot|severe) weather (?:advisory|alert)/i,
    /weather advisory/i,
    /normal (?:grid )?(?:operations|conditions)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const statusText = m[0].replace(/\s+/g, ' ').trim();
      return { level: classifyOperatorStatus(statusText), statusText };
    }
  }
  if (/current grid conditions/i.test(text)) return { level: 'unknown', statusText: 'Condition text not recognized' };
  throw new Error('grid-conditions page: no recognizable status');
}

export async function fetchSpp(deps) {
  return guarded('spp', 'SPP current grid conditions', SPP_CONDITIONS_URL, async () => {
    const parsed = normalizeSppConditions(await deps.fetchText(SPP_CONDITIONS_URL));
    return { operator: { regionId: 'SWPP', ...parsed, updatedAt: null }, sourceExtra: { status: parsed.statusText } };
  });
}

// ─── NWS ─────────────────────────────────────────────────────────────────────

export function buildNwsAlertsUrl() {
  const params = new URLSearchParams({ status: 'actual', message_type: 'alert,update', limit: '500' });
  params.set('event', GRID_HAZARD_EVENT_NAMES.join(','));
  return `${NWS_ALERTS_URL}?${params.toString()}`;
}

function ringCentroid(coords) {
  let sx = 0; let sy = 0; let n = 0;
  // GeoJSON rings repeat the first vertex as the last; drop the duplicate so
  // it does not pull the mean toward that corner.
  const pts = Array.isArray(coords) ? coords : [];
  const first = pts[0]; const last = pts[pts.length - 1];
  const body = pts.length > 1 && Array.isArray(first) && Array.isArray(last) && first[0] === last[0] && first[1] === last[1] ? pts.slice(0, -1) : pts;
  for (const pt of body) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    const [x, y] = pt;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x; sy += y; n += 1;
  }
  return n ? [round(sx / n, 3), round(sy / n, 3)] : null;
}

export function geometryCentroid(geometry) {
  if (!geometry || typeof geometry !== 'object') return null;
  const { type, coordinates } = geometry;
  if (type === 'Point') return ringCentroid([coordinates]);
  if (type === 'Polygon') return ringCentroid(coordinates?.[0] ?? []);
  if (type === 'MultiPolygon') return ringCentroid((coordinates ?? []).flatMap((poly) => poly?.[0] ?? []));
  return null;
}

/** States referenced by a NWS alert: UGC zone/county codes carry the state prefix. */
export function alertStates(props) {
  const states = new Set();
  const ugc = props?.geocode?.UGC;
  if (Array.isArray(ugc)) for (const code of ugc) { const m = String(code).match(/^([A-Z]{2})[CZ]\d{3}$/); if (m) states.add(m[1]); }
  if (states.size === 0 && typeof props?.areaDesc === 'string') {
    for (const m of props.areaDesc.matchAll(/,\s*([A-Z]{2})(?:;|$)/g)) states.add(m[1]);
  }
  return [...states];
}

export function normalizeNwsAlerts(featureCollection, nowMs = Date.now()) {
  const features = Array.isArray(featureCollection?.features) ? featureCollection.features : [];
  const alerts = [];
  for (const f of features) {
    const p = f?.properties;
    if (!p || typeof p !== 'object') continue;
    const def = GRID_HAZARD_EVENTS[p.event];
    if (!def) continue;
    const expires = Date.parse(p.expires ?? p.ends ?? '') || null;
    if (expires && expires < nowMs) continue;
    const states = alertStates(p);
    const regionIds = regionsForStates(states).map((r) => r.id);
    const severity = ['Extreme', 'Severe', 'Moderate', 'Minor'].includes(p.severity) ? p.severity : 'Unknown';
    alerts.push({
      id: String(p.id ?? f.id ?? '').slice(0, 200) || `nws-${alerts.length}`,
      source: 'nws',
      kind: 'weather',
      event: p.event,
      category: def.category,
      severity,
      weight: round(def.weight * (SEVERITY_FACTOR[severity] ?? 0.4), 1),
      mechanism: def.mechanism,
      title: String(p.headline ?? p.event).slice(0, 240),
      areaDesc: String(p.areaDesc ?? '').slice(0, 300),
      states,
      regionIds,
      onset: isoOrNull(p.onset ?? p.effective),
      expires: expires ? new Date(expires).toISOString() : null,
      issuedAt: isoOrNull(p.sent),
      centroid: geometryCentroid(f.geometry),
      url: typeof p['@id'] === 'string' ? p['@id'] : (typeof p.id === 'string' && p.id.startsWith('http') ? p.id : null),
    });
  }
  alerts.sort((a, b) => b.weight - a.weight || String(a.expires).localeCompare(String(b.expires)));
  return alerts;
}

export async function fetchNwsAlerts(deps, { limit = 150 } = {}) {
  const url = buildNwsAlertsUrl();
  return guarded('nws', 'NWS active alerts (grid-relevant events)', NWS_ALERTS_URL, async () => {
    const body = await deps.fetchJson(url, { Accept: 'application/geo+json' });
    if (!Array.isArray(body?.features)) throw new Error('alerts/active: no features array');
    const all = normalizeNwsAlerts(body, deps.now());
    return { weatherAlerts: all.slice(0, limit), weatherAlertTotal: all.length, sourceExtra: { records: all.length } };
  });
}

// ─── SWPC ────────────────────────────────────────────────────────────────────

const G_TEXT = { 0: 'none', 1: 'minor', 2: 'moderate', 3: 'strong', 4: 'severe', 5: 'extreme' };

export function normalizeSwpcScales(json) {
  if (!json || typeof json !== 'object') throw new Error('noaa-scales.json: not an object');
  const day = (k) => {
    const d = json[k];
    if (!d || typeof d !== 'object') return null;
    return {
      date: d.DateStamp ?? null,
      g: toNumber(d.G?.Scale) ?? 0,
      gText: d.G?.Text ?? G_TEXT[toNumber(d.G?.Scale) ?? 0],
      s: toNumber(d.S?.Scale) ?? 0,
      r: toNumber(d.R?.Scale) ?? 0,
      rMinorProb: toNumber(d.R?.MinorProb),
      rMajorProb: toNumber(d.R?.MajorProb),
    };
  };
  const current = day('0');
  if (!current) throw new Error('noaa-scales.json: no current ("0") entry');
  return { current, forecast: ['1', '2', '3'].map(day).filter(Boolean), yesterday: day('-1') };
}

export function normalizeSwpcKp(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return { kp: null, kpAt: null };
  const header = Array.isArray(rows[0]) ? rows[0].map((h) => String(h).toLowerCase()) : [];
  const cTime = Math.max(0, header.indexOf('time_tag'));
  const cKp = header.indexOf('kp') >= 0 ? header.indexOf('kp') : 1;
  let kp = null; let kpAt = null;
  for (const row of rows.slice(1)) {
    const v = toNumber(row?.[cKp]);
    if (v !== null) { kp = v; kpAt = isoOrNull(row[cTime]); }
  }
  return { kp, kpAt };
}

export function normalizeSwpcAlerts(rows, nowMs = Date.now(), { maxAgeHours = 72 } = {}) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const message = String(row?.message ?? '');
    const issued = Date.parse(String(row?.issue_datetime ?? '').replace(' ', 'T') + (String(row?.issue_datetime ?? '').endsWith('Z') ? '' : 'Z'));
    if (!Number.isFinite(issued) || nowMs - issued > maxAgeHours * 3600_000) continue;
    const g = message.match(/Geomagnetic Storm Category G([1-5])/i) || message.match(/NOAA Scale:\s*G([1-5])/i) || message.match(/\bG([1-5])\b[^\n]*(?:Watch|Warning|Alert)/i);
    const kType = message.match(/(?:WATCH|WARNING|ALERT|SUMMARY):\s*([^\n]+)/i);
    if (!g && !/geomagnetic|k-index|kp/i.test(message)) continue;
    const gLevel = g ? Number(g[1]) : null;
    out.push({
      id: `swpc-${row.product_id ?? ''}-${issued}`,
      source: 'swpc',
      kind: 'space',
      gLevel,
      title: (kType ? kType[1] : message.split('\n').find((l) => l.trim()) || 'SWPC product').trim().slice(0, 200),
      issuedAt: new Date(issued).toISOString(),
      productId: row.product_id ?? null,
    });
  }
  out.sort((a, b) => (b.gLevel ?? 0) - (a.gLevel ?? 0) || b.issuedAt.localeCompare(a.issuedAt));
  return out.slice(0, 12);
}

export async function fetchSwpc(deps) {
  return guarded('swpc', 'NOAA SWPC space weather scales', SWPC_SCALES_URL, async () => {
    const scales = normalizeSwpcScales(await deps.fetchJson(SWPC_SCALES_URL));
    let kp = { kp: null, kpAt: null };
    let alerts = [];
    try { kp = normalizeSwpcKp(await deps.fetchJson(SWPC_KP_URL)); } catch { /* optional */ }
    try { alerts = normalizeSwpcAlerts(await deps.fetchJson(SWPC_ALERTS_URL), deps.now()); } catch { /* optional */ }
    return { space: { ...scales, ...kp, alerts }, sourceExtra: { g: scales.current.g } };
  });
}

export const ADAPTERS = Object.freeze({
  eia930: fetchEia930,
  ercot: fetchErcot,
  caiso: fetchCaiso,
  miso: fetchMiso,
  nyiso: fetchNyiso,
  spp: fetchSpp,
  nws: fetchNwsAlerts,
  swpc: fetchSwpc,
});
