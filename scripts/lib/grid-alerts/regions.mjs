// Static registry of the North American grid operators and balancing
// authorities (BAs) the grid-alerts envelope assesses. EIA-930 respondent codes
// are the canonical ids so the hourly demand feed joins without a lookup table.
//
// `states` is the approximate footprint used to attach NWS hazard alerts
// (UGC/state codes) to a region. It is deliberately coarse: an alert covering a
// state touches every BA with load in that state, and the scoring then weighs
// severity, hazard type and the BA's own operating state. `lat` is the
// footprint's representative latitude used for geomagnetic (GIC) exposure.
//
// Footprints and centroids are hand-maintained from the EIA-930 BA reference
// table and operator service-territory maps; they are not an authoritative
// boundary dataset. Keep entries in order of system size.

/**
 * @typedef {object} GridRegionDef
 * @property {string} id EIA-930 respondent code
 * @property {string} name
 * @property {'iso'|'ba'} kind
 * @property {string} [operator] adapter id that reports an operating state for this region
 * @property {string[]} states
 * @property {[number, number]} centroid [lon, lat]
 * @property {'eastern'|'western'|'ercot'} interconnection
 */

/** @type {GridRegionDef[]} */
export const GRID_REGIONS = Object.freeze([
  { id: 'PJM',  name: 'PJM Interconnection',             kind: 'iso', operator: 'pjm',   interconnection: 'eastern', states: ['PA', 'NJ', 'MD', 'DE', 'VA', 'WV', 'OH', 'DC', 'KY', 'NC', 'IL', 'IN', 'MI', 'TN'], centroid: [-79.8, 39.6] },
  { id: 'MISO', name: 'MISO (Midcontinent)',             kind: 'iso', operator: 'miso',  interconnection: 'eastern', states: ['MN', 'WI', 'IA', 'IL', 'IN', 'MI', 'MO', 'AR', 'LA', 'MS', 'ND', 'SD', 'MT', 'KY', 'TX'], centroid: [-91.5, 41.5] },
  { id: 'ERCO', name: 'ERCOT (Texas)',                   kind: 'iso', operator: 'ercot', interconnection: 'ercot',   states: ['TX'], centroid: [-99.3, 31.2] },
  { id: 'SWPP', name: 'SPP (Southwest Power Pool)',      kind: 'iso', operator: 'spp',   interconnection: 'eastern', states: ['KS', 'OK', 'NE', 'SD', 'ND', 'MO', 'AR', 'LA', 'TX', 'NM', 'MN', 'IA', 'MT', 'WY'], centroid: [-97.8, 38.2] },
  { id: 'CISO', name: 'CAISO (California)',              kind: 'iso', operator: 'caiso', interconnection: 'western', states: ['CA'], centroid: [-119.6, 36.8] },
  { id: 'NYIS', name: 'NYISO (New York)',                kind: 'iso', operator: 'nyiso', interconnection: 'eastern', states: ['NY'], centroid: [-75.5, 42.9] },
  { id: 'ISNE', name: 'ISO New England',                 kind: 'iso', operator: 'isone', interconnection: 'eastern', states: ['ME', 'NH', 'VT', 'MA', 'CT', 'RI'], centroid: [-71.6, 43.4] },
  { id: 'SOCO', name: 'Southern Company',                kind: 'ba',  interconnection: 'eastern', states: ['GA', 'AL', 'MS', 'FL'], centroid: [-85.0, 32.8] },
  { id: 'TVA',  name: 'Tennessee Valley Authority',      kind: 'ba',  interconnection: 'eastern', states: ['TN', 'AL', 'MS', 'KY', 'GA', 'NC', 'VA'], centroid: [-86.5, 35.6] },
  { id: 'DUK',  name: 'Duke Energy Carolinas',           kind: 'ba',  interconnection: 'eastern', states: ['NC', 'SC'], centroid: [-81.2, 35.4] },
  { id: 'CPLE', name: 'Duke Energy Progress East',       kind: 'ba',  interconnection: 'eastern', states: ['NC', 'SC'], centroid: [-78.6, 35.5] },
  { id: 'FPL',  name: 'Florida Power & Light',           kind: 'ba',  interconnection: 'eastern', states: ['FL'], centroid: [-80.9, 27.2] },
  { id: 'FPC',  name: 'Duke Energy Florida',             kind: 'ba',  interconnection: 'eastern', states: ['FL'], centroid: [-82.3, 28.6] },
  { id: 'BPAT', name: 'Bonneville Power Administration', kind: 'ba',  interconnection: 'western', states: ['WA', 'OR', 'ID', 'MT'], centroid: [-120.5, 46.3] },
  { id: 'PACW', name: 'PacifiCorp West',                 kind: 'ba',  interconnection: 'western', states: ['OR', 'WA', 'CA'], centroid: [-122.6, 44.0] },
  { id: 'PACE', name: 'PacifiCorp East',                 kind: 'ba',  interconnection: 'western', states: ['UT', 'WY', 'ID'], centroid: [-110.8, 41.5] },
  { id: 'AZPS', name: 'Arizona Public Service',          kind: 'ba',  interconnection: 'western', states: ['AZ'], centroid: [-112.1, 33.9] },
  { id: 'SRP',  name: 'Salt River Project',              kind: 'ba',  interconnection: 'western', states: ['AZ'], centroid: [-111.7, 33.4] },
  { id: 'NEVP', name: 'NV Energy',                       kind: 'ba',  interconnection: 'western', states: ['NV'], centroid: [-116.4, 38.6] },
  { id: 'PSCO', name: 'Public Service Co. of Colorado',  kind: 'ba',  interconnection: 'western', states: ['CO'], centroid: [-105.3, 39.7] },
  { id: 'WACM', name: 'WAPA Rocky Mountain',             kind: 'ba',  interconnection: 'western', states: ['CO', 'WY', 'NE', 'SD', 'NM'], centroid: [-105.0, 41.5] },
  { id: 'LDWP', name: 'Los Angeles DWP',                 kind: 'ba',  interconnection: 'western', states: ['CA'], centroid: [-118.3, 34.1] },
  { id: 'AECI', name: 'Associated Electric Cooperative', kind: 'ba',  interconnection: 'eastern', states: ['MO', 'OK', 'IA'], centroid: [-93.3, 37.9] },
  { id: 'IPCO', name: 'Idaho Power',                     kind: 'ba',  interconnection: 'western', states: ['ID', 'OR'], centroid: [-116.2, 43.6] },
  { id: 'PGE',  name: 'Portland General Electric',       kind: 'ba',  interconnection: 'western', states: ['OR'], centroid: [-122.7, 45.5] },
  { id: 'PSEI', name: 'Puget Sound Energy',              kind: 'ba',  interconnection: 'western', states: ['WA'], centroid: [-122.3, 47.6] },
  { id: 'PNM',  name: 'Public Service Co. of New Mexico', kind: 'ba', interconnection: 'western', states: ['NM'], centroid: [-106.6, 35.1] },
  { id: 'EPE',  name: 'El Paso Electric',                kind: 'ba',  interconnection: 'western', states: ['TX', 'NM'], centroid: [-106.5, 31.8] },
  { id: 'NWMT', name: 'NorthWestern Energy (Montana)',   kind: 'ba',  interconnection: 'western', states: ['MT'], centroid: [-110.4, 46.9] },
  { id: 'LGEE', name: 'LG&E and KU',                     kind: 'ba',  interconnection: 'eastern', states: ['KY'], centroid: [-85.5, 37.8] },
  { id: 'SC',   name: 'Santee Cooper',                   kind: 'ba',  interconnection: 'eastern', states: ['SC'], centroid: [-80.0, 33.5] },
  { id: 'SCEG', name: 'Dominion Energy South Carolina',  kind: 'ba',  interconnection: 'eastern', states: ['SC'], centroid: [-81.0, 33.9] },
  { id: 'JEA',  name: 'JEA (Jacksonville)',              kind: 'ba',  interconnection: 'eastern', states: ['FL'], centroid: [-81.7, 30.3] },
  { id: 'TEC',  name: 'Tampa Electric',                  kind: 'ba',  interconnection: 'eastern', states: ['FL'], centroid: [-82.4, 27.9] },
]);

export const GRID_REGION_IDS = Object.freeze(GRID_REGIONS.map((r) => r.id));

const BY_ID = new Map(GRID_REGIONS.map((r) => [r.id, r]));

/** @param {string} id */
export function getGridRegion(id) {
  return BY_ID.get(id) ?? null;
}

/** Regions whose footprint includes the given two-letter US state code. */
export function regionsForState(state) {
  const code = String(state || '').toUpperCase();
  if (code.length !== 2) return [];
  return GRID_REGIONS.filter((r) => r.states.includes(code));
}

/**
 * Regions touched by a set of state codes, de-duplicated and in registry order.
 * @param {Iterable<string>} states
 */
export function regionsForStates(states) {
  const wanted = new Set([...states].map((s) => String(s || '').toUpperCase()).filter((s) => s.length === 2));
  if (wanted.size === 0) return [];
  return GRID_REGIONS.filter((r) => r.states.some((s) => wanted.has(s)));
}

/** Representative latitude for geomagnetic exposure. */
export function regionLatitude(region) {
  return Array.isArray(region?.centroid) ? region.centroid[1] : NaN;
}
