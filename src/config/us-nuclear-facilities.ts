// US nuclear facility registry — the reference dataset behind the nuclear
// variant (NucMonitor). Every entry is a publicly documented site; the
// authoritative sources are the NRC facility locator and operating-reactor
// list, DOE/NNSA site pages, and operator disclosures. Capacities are net
// summer MWe rounded to the nearest MW and may lag uprates; license expiry
// years reflect the current NRC operating license (renewed or subsequent
// renewed where granted). Treat `asOf` as the review date for the whole table
// and verify any value against the linked source before citing it.
//
// Pure data module: no imports beyond types so it can be consumed by config,
// services, components, node tests, and seed scripts alike.

export const US_NUCLEAR_REGISTRY_AS_OF = '2026-10';

// nrc.gov moved to a new information architecture in 2026 (the old
// /reading-rm/, /reactors/ and /info-finder/ paths now redirect, and some
// facility pages were dropped without a redirect). Every URL below was
// checked against the live site in October 2026.
export const US_NUCLEAR_REGISTRY_SOURCES = {
  nrcOperatingReactors: 'https://www.nrc.gov/facilities-safety/operating-reactors/list-power-reactor-units',
  nrcFacilityLocator: 'https://www.nrc.gov/facilities-safety/facility-finder/region-state',
  nrcFacilityFinder: 'https://www.nrc.gov/facilities-safety/facility-finder',
  nrcReactorStatus: 'https://www.nrc.gov/documents-reports/document-collections/events-reports-associated-with/power-reactor-status-reports',
  nrcEventReports: 'https://www.nrc.gov/documents-reports/document-collections/events-reports-associated-with/event-notification-reports',
  nrcDecommissioning: 'https://www.nrc.gov/facilities-safety/facility-finder/decommissioning/power-reactor',
  nrcResearchReactors: 'https://www.nrc.gov/facilities-safety/non-power-facilities',
  nrcFuelCycle: 'https://www.nrc.gov/facilities-safety/fuel-cycle-facilities',
  nrcNewReactors: 'https://www.nrc.gov/facilities-safety/new-reactors',
  nrcUraniumRecovery: 'https://www.nrc.gov/materials/uranium-recovery',
  doeSites: 'https://www.energy.gov/em/mission-and-sites',
  nnsaSites: 'https://www.energy.gov/nnsa/nnsa-locations',
  eiaNuclear: 'https://www.eia.gov/nuclear/',
  iaeaPris: 'https://pris.iaea.org/PRIS/CountryStatistics/CountryDetails.aspx?current=US',
} as const;

/**
 * NRC and Idaho National Laboratory research surfaces that complement the
 * live feeds. None of these publish an API or RSS (the NRC retired its RSS
 * feeds with the Lyris list service in January 2026), so they are offered as
 * deep links. The INL-hosted applications (LERSearch, NROD, NMED) sit behind
 * bot protection that rejects non-browser clients; link, do not scrape.
 */
export const NRC_RESEARCH_SOURCES = {
  /** ADAMS Public Search, the public document library (replaced the retired WBA front end). */
  adams: 'https://adams-search.nrc.gov/',
  adamsAbout: 'https://www.nrc.gov/documents-reports/adams-public-documents',
  /** INL-hosted search over Licensee Event Reports (10 CFR 50.73). */
  lerSearch: 'https://lersearch.inl.gov/LERSearchCriteria.aspx',
  inspectionReportSearch: 'https://lersearch.inl.gov/IRSearchCriteria.aspx',
  eventNotificationSearch: 'https://lersearch.inl.gov/ENSearchCriteria.aspx',
  /** Reactor Operational Experience results (initiating events, LOOP, component and system studies). */
  operatingExperience: 'https://nrcoe.inl.gov/',
  nrod: 'https://nrcoe.inl.gov/NROD',
  initiatingEvents: 'https://nrcoe.inl.gov/InitEvent',
  lossOfOffsitePower: 'https://nrcoe.inl.gov/LOSP',
  componentPerformance: 'https://nrcoe.inl.gov/CompPerf',
  reliabilityCalculator: 'http://rads.inl.gov/calculator',
  /** Nuclear Material Events Database; the database itself is access-controlled, the annual reports are public. */
  nmed: 'https://nmed.inl.gov/',
  /** SAPHIRE probabilistic risk assessment software and the SPAR models (users group, registration required). */
  saphire: 'https://saphire.inl.gov/',
  part21Reports: 'https://www.nrc.gov/documents-reports/document-collections/events-reports-associated-with/event-notification-reports/part-21-reports',
  preliminaryNotifications: 'https://www.nrc.gov/documents-reports/document-collections/events-reports-associated-with/event-notification-reports/preliminary-notification-reports',
  reactorOversight: 'https://www.nrc.gov/facilities-safety/operating-reactors/reactor-oversight-process-rop',
  escalatedEnforcement: 'https://www.nrc.gov/documents-reports/document-collections/enforcement-documents/significant-enforcement-actions/reactor-licensees',
  newsReleases: 'https://www.nrc.gov/about-nrc/news-releases/index',
  emailUpdates: 'https://www.nrc.gov/public-involve/listserver',
} as const;

export type UsNuclearFacilityCategory =
  | 'power-reactor'      // NRC-licensed commercial power reactor site with at least one operating unit
  | 'restart'            // permanently shut unit with an announced, regulator-engaged restart program
  | 'new-build'          // advanced reactor or SMR project in NRC licensing or construction
  | 'decommissioning'    // permanently shut commercial reactor site (active D&D or ISFSI-only)
  | 'research-reactor'   // NRC-licensed non-power research and test reactor
  | 'fuel-cycle'         // enrichment, conversion, fuel fabrication, deconversion
  | 'doe-site'           // DOE / NNSA laboratory, production, naval reactors, or cleanup site
  | 'uranium-recovery'   // conventional mill or in-situ recovery operation
  | 'waste';             // disposal, consolidated interim storage, or wet storage

export type UsNuclearFacilityStatus =
  | 'operating'
  | 'restarting'
  | 'licensing'
  | 'construction'
  | 'decommissioning'
  | 'isfsi-only'
  | 'decommissioned'
  | 'legacy'
  | 'dormant'
  | 'standby';

export type UsNuclearRegulator = 'NRC' | 'DOE' | 'NNSA' | 'Agreement State' | 'NRC/DOE';

export interface UsReactorUnit {
  /** Unit label as the NRC lists it, e.g. "Unit 1". */
  name: string;
  /** NRC docket number, e.g. "05000259". */
  docket?: string;
  /** Reactor technology: PWR, BWR, AP1000, TRIGA, pool, FHR, SFR, MSR, HTGR ... */
  type: string;
  /** Net summer capacity in MWe (power reactors). */
  netMwe?: number;
  /** Licensed thermal power in MW (research reactors). */
  thermalMw?: number;
  status: 'operating' | 'shutdown' | 'restarting' | 'construction' | 'licensing' | 'planned';
  /** Year the current NRC operating license expires. */
  licenseExpires?: number;
  /** Year of first commercial operation. */
  commercial?: number;
  shutdownYear?: number;
}

export interface UsNuclearFacility {
  id: string;
  name: string;
  category: UsNuclearFacilityCategory;
  status: UsNuclearFacilityStatus;
  /** USPS state or territory code. */
  state: string;
  city?: string;
  lat: number;
  lon: number;
  /** Licensee, operator, or managing contractor. */
  operator: string;
  regulator: UsNuclearRegulator;
  /** NRC materials / fuel-cycle docket where the site has one (power reactors carry dockets per unit). */
  docket?: string;
  units?: UsReactorUnit[];
  /** Independent spent fuel storage installation on site. */
  isfsi?: boolean;
  /** Primary public reference page (NRC, DOE, or operator). */
  url?: string;
  /** Short description of what the site does and why it matters. */
  notes?: string;
  /**
   * Normalized name prefixes used to match the NRC power reactor status
   * report "Unit" column (e.g. "arkansas nuclear", "saint lucie").
   */
  statusAliases?: string[];
}

export const NRC_REGION_BY_STATE: Record<string, 1 | 2 | 3 | 4> = {
  // Region I — Northeast (King of Prussia, PA)
  CT: 1, DC: 1, DE: 1, MA: 1, MD: 1, ME: 1, NH: 1, NJ: 1, NY: 1, PA: 1, RI: 1, VT: 1,
  // Region II — Southeast (Atlanta, GA)
  AL: 2, FL: 2, GA: 2, KY: 2, MS: 2, NC: 2, PR: 2, SC: 2, TN: 2, VA: 2, VI: 2, WV: 2,
  // Region III — Midwest (Lisle, IL)
  IA: 3, IL: 3, IN: 3, MI: 3, MN: 3, MO: 3, OH: 3, WI: 3,
  // Region IV — West and South-Central (Arlington, TX)
  AK: 4, AR: 4, AZ: 4, CA: 4, CO: 4, HI: 4, ID: 4, KS: 4, LA: 4, MT: 4, ND: 4, NE: 4,
  NM: 4, NV: 4, OK: 4, OR: 4, SD: 4, TX: 4, UT: 4, WA: 4, WY: 4,
};

export const NRC_REGION_NAMES: Record<1 | 2 | 3 | 4, string> = {
  1: 'Region I (Northeast)',
  2: 'Region II (Southeast)',
  3: 'Region III (Midwest)',
  4: 'Region IV (West / South-Central)',
};

export function getNrcRegion(state: string): 1 | 2 | 3 | 4 | undefined {
  return NRC_REGION_BY_STATE[state.toUpperCase()];
}

export const US_NUCLEAR_CATEGORY_LABELS: Record<UsNuclearFacilityCategory, string> = {
  'power-reactor': 'Operating power reactor',
  restart: 'Restart program',
  'new-build': 'New build / advanced reactor',
  decommissioning: 'Decommissioning / spent fuel storage',
  'research-reactor': 'Research & test reactor',
  'fuel-cycle': 'Fuel cycle facility',
  'doe-site': 'DOE / NNSA site',
  'uranium-recovery': 'Uranium recovery',
  waste: 'Waste disposal & interim storage',
};

export const US_NUCLEAR_STATUS_LABELS: Record<UsNuclearFacilityStatus, string> = {
  operating: 'Operating',
  restarting: 'Restart in progress',
  licensing: 'In licensing',
  construction: 'Under construction',
  decommissioning: 'Decommissioning',
  'isfsi-only': 'Spent fuel storage only',
  decommissioned: 'Decommissioned',
  legacy: 'Legacy management',
  dormant: 'Dormant',
  standby: 'Standby',
};

const pwr = (
  name: string,
  docket: string,
  netMwe: number,
  licenseExpires: number,
  commercial?: number,
): UsReactorUnit => ({ name, docket, type: 'PWR', netMwe, status: 'operating', licenseExpires, commercial });

const bwr = (
  name: string,
  docket: string,
  netMwe: number,
  licenseExpires: number,
  commercial?: number,
): UsReactorUnit => ({ name, docket, type: 'BWR', netMwe, status: 'operating', licenseExpires, commercial });

export const US_NUCLEAR_FACILITIES: UsNuclearFacility[] = [
  // ───────────────────────────────────────────────────────────────────────────
  // OPERATING COMMERCIAL POWER REACTOR SITES (NRC Part 50 / Part 52)
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'browns-ferry', name: 'Browns Ferry Nuclear Plant', category: 'power-reactor', status: 'operating',
    state: 'AL', city: 'Athens', lat: 34.704, lon: -87.119, operator: 'Tennessee Valley Authority', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000259', 1256, 2033, 1974), bwr('Unit 2', '05000260', 1259, 2034, 1975), bwr('Unit 3', '05000296', 1261, 2036, 1977)],
    notes: 'Largest BWR site in the US by output; three GE BWR/4 units on the Tennessee River.',
    statusAliases: ['browns ferry'],
  },
  {
    id: 'farley', name: 'Joseph M. Farley Nuclear Plant', category: 'power-reactor', status: 'operating',
    state: 'AL', city: 'Dothan', lat: 31.223, lon: -85.111, operator: 'Southern Nuclear Operating Co.', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000348', 874, 2037, 1977), pwr('Unit 2', '05000364', 883, 2041, 1981)],
    statusAliases: ['farley'],
  },
  {
    id: 'palo-verde', name: 'Palo Verde Generating Station', category: 'power-reactor', status: 'operating',
    state: 'AZ', city: 'Tonopah', lat: 33.389, lon: -112.862, operator: 'Arizona Public Service', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000528', 1311, 2045, 1986), pwr('Unit 2', '05000529', 1314, 2046, 1986), pwr('Unit 3', '05000530', 1312, 2047, 1988)],
    notes: 'Largest US nuclear plant by output; the only large plant not sited on a lake, river, or ocean (cooled with treated wastewater).',
    statusAliases: ['palo verde'],
  },
  {
    id: 'arkansas-nuclear-one', name: 'Arkansas Nuclear One', category: 'power-reactor', status: 'operating',
    state: 'AR', city: 'Russellville', lat: 35.310, lon: -93.231, operator: 'Entergy Arkansas', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000313', 846, 2034, 1974), pwr('Unit 2', '05000368', 988, 2038, 1980)],
    statusAliases: ['arkansas nuclear', 'arkansas'],
  },
  {
    id: 'diablo-canyon', name: 'Diablo Canyon Power Plant', category: 'power-reactor', status: 'operating',
    state: 'CA', city: 'Avila Beach', lat: 35.211, lon: -120.854, operator: 'Pacific Gas & Electric', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000275', 1138, 2044, 1985), pwr('Unit 2', '05000323', 1118, 2045, 1986)],
    notes: 'California\'s last operating nuclear plant. State legislation (SB 846, 2022) extended operation beyond the planned 2024-25 retirement; NRC license renewal review completed in 2025. Sits near the Hosgri and Shoreline faults, so seismic hazard is a standing review topic.',
    statusAliases: ['diablo canyon'],
  },
  {
    id: 'millstone', name: 'Millstone Power Station', category: 'power-reactor', status: 'operating',
    state: 'CT', city: 'Waterford', lat: 41.312, lon: -72.169, operator: 'Dominion Energy', regulator: 'NRC', isfsi: true,
    units: [
      { name: 'Unit 1', docket: '05000245', type: 'BWR', status: 'shutdown', shutdownYear: 1998, commercial: 1971 },
      pwr('Unit 2', '05000336', 869, 2035, 1975), pwr('Unit 3', '05000423', 1210, 2045, 1986),
    ],
    notes: 'Unit 1 permanently shut in 1998 and is in SAFSTOR on the same site.',
    statusAliases: ['millstone'],
  },
  {
    id: 'st-lucie', name: 'St. Lucie Nuclear Plant', category: 'power-reactor', status: 'operating',
    state: 'FL', city: 'Jensen Beach', lat: 27.349, lon: -80.246, operator: 'Florida Power & Light', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000335', 981, 2036, 1976), pwr('Unit 2', '05000389', 987, 2043, 1983)],
    notes: 'Barrier-island site on Hutchinson Island; hurricane preparedness is a recurring NRC inspection focus.',
    statusAliases: ['saint lucie', 'st lucie', 'st. lucie'],
  },
  {
    id: 'turkey-point', name: 'Turkey Point Nuclear Generating Station', category: 'power-reactor', status: 'operating',
    state: 'FL', city: 'Homestead', lat: 25.435, lon: -80.331, operator: 'Florida Power & Light', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 3', '05000250', 837, 2052, 1972), pwr('Unit 4', '05000251', 837, 2053, 1973)],
    notes: 'First US units granted subsequent (60-to-80-year) license renewal; the renewals were reinstated in 2024 after a supplemental environmental review.',
    statusAliases: ['turkey point'],
  },
  {
    id: 'hatch', name: 'Edwin I. Hatch Nuclear Plant', category: 'power-reactor', status: 'operating',
    state: 'GA', city: 'Baxley', lat: 31.934, lon: -82.344, operator: 'Southern Nuclear Operating Co.', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000321', 876, 2034, 1975), bwr('Unit 2', '05000366', 883, 2038, 1979)],
    statusAliases: ['hatch'],
  },
  {
    id: 'vogtle', name: 'Alvin W. Vogtle Electric Generating Plant', category: 'power-reactor', status: 'operating',
    state: 'GA', city: 'Waynesboro', lat: 33.143, lon: -81.762, operator: 'Southern Nuclear Operating Co.', regulator: 'NRC', isfsi: true,
    units: [
      pwr('Unit 1', '05000424', 1150, 2047, 1987), pwr('Unit 2', '05000425', 1152, 2049, 1989),
      { name: 'Unit 3', docket: '05200025', type: 'AP1000', netMwe: 1114, status: 'operating', licenseExpires: 2062, commercial: 2023 },
      { name: 'Unit 4', docket: '05200026', type: 'AP1000', netMwe: 1114, status: 'operating', licenseExpires: 2063, commercial: 2024 },
    ],
    notes: 'Units 3 and 4 are the first AP1000s and the first new US reactors in decades (commercial operation 2023 and 2024), making Vogtle the largest US generator of carbon-free electricity.',
    statusAliases: ['vogtle'],
  },
  {
    id: 'braidwood', name: 'Braidwood Generating Station', category: 'power-reactor', status: 'operating',
    state: 'IL', city: 'Braceville', lat: 41.244, lon: -88.229, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000456', 1194, 2046, 1988), pwr('Unit 2', '05000457', 1160, 2047, 1988)],
    statusAliases: ['braidwood'],
  },
  {
    id: 'byron', name: 'Byron Generating Station', category: 'power-reactor', status: 'operating',
    state: 'IL', city: 'Byron', lat: 42.074, lon: -89.282, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000454', 1164, 2044, 1985), pwr('Unit 2', '05000455', 1136, 2046, 1987)],
    statusAliases: ['byron'],
  },
  {
    id: 'clinton', name: 'Clinton Power Station', category: 'power-reactor', status: 'operating',
    state: 'IL', city: 'Clinton', lat: 40.172, lon: -88.834, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000461', 1062, 2027, 1987)],
    notes: 'License renewal application (to 2047) under NRC review; state zero-emission credits keep the unit in service.',
    statusAliases: ['clinton'],
  },
  {
    id: 'dresden', name: 'Dresden Generating Station', category: 'power-reactor', status: 'operating',
    state: 'IL', city: 'Morris', lat: 41.390, lon: -88.271, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [
      { name: 'Unit 1', docket: '05000010', type: 'BWR', status: 'shutdown', shutdownYear: 1978, commercial: 1960 },
      bwr('Unit 2', '05000237', 894, 2029, 1970), bwr('Unit 3', '05000249', 879, 2031, 1971),
    ],
    notes: 'Unit 1 (1960) was the first privately financed US nuclear plant and is in SAFSTOR. Subsequent license renewal for Units 2 and 3 is under NRC review.',
    statusAliases: ['dresden'],
  },
  {
    id: 'lasalle', name: 'LaSalle County Generating Station', category: 'power-reactor', status: 'operating',
    state: 'IL', city: 'Marseilles', lat: 41.244, lon: -88.671, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000373', 1137, 2042, 1984), bwr('Unit 2', '05000374', 1140, 2043, 1984)],
    statusAliases: ['lasalle', 'la salle'],
  },
  {
    id: 'quad-cities', name: 'Quad Cities Generating Station', category: 'power-reactor', status: 'operating',
    state: 'IL', city: 'Cordova', lat: 41.726, lon: -90.310, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000254', 908, 2032, 1973), bwr('Unit 2', '05000265', 911, 2032, 1973)],
    statusAliases: ['quad cities'],
  },
  {
    id: 'wolf-creek', name: 'Wolf Creek Generating Station', category: 'power-reactor', status: 'operating',
    state: 'KS', city: 'Burlington', lat: 38.239, lon: -95.689, operator: 'Wolf Creek Nuclear Operating Corp. (Evergy / KEPCo)', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000482', 1200, 2045, 1985)],
    statusAliases: ['wolf creek'],
  },
  {
    id: 'river-bend', name: 'River Bend Station', category: 'power-reactor', status: 'operating',
    state: 'LA', city: 'St. Francisville', lat: 30.757, lon: -91.332, operator: 'Entergy Louisiana', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000458', 967, 2045, 1986)],
    statusAliases: ['river bend'],
  },
  {
    id: 'waterford', name: 'Waterford Steam Electric Station Unit 3', category: 'power-reactor', status: 'operating',
    state: 'LA', city: 'Killona', lat: 29.995, lon: -90.471, operator: 'Entergy Louisiana', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 3', '05000382', 1168, 2044, 1985)],
    notes: 'Mississippi River site west of New Orleans; hurricane and river-flood preparedness are standing inspection topics (Ida, 2021).',
    statusAliases: ['waterford'],
  },
  {
    id: 'calvert-cliffs', name: 'Calvert Cliffs Nuclear Power Plant', category: 'power-reactor', status: 'operating',
    state: 'MD', city: 'Lusby', lat: 38.432, lon: -76.442, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000317', 866, 2034, 1975), pwr('Unit 2', '05000318', 850, 2036, 1977)],
    statusAliases: ['calvert cliffs'],
  },
  {
    id: 'dc-cook', name: 'Donald C. Cook Nuclear Plant', category: 'power-reactor', status: 'operating',
    state: 'MI', city: 'Bridgman', lat: 41.975, lon: -86.566, operator: 'Indiana Michigan Power (AEP)', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000315', 1030, 2034, 1975), pwr('Unit 2', '05000316', 1168, 2037, 1978)],
    statusAliases: ['cook', 'd c cook', 'donald c cook', 'dc cook'],
  },
  {
    id: 'fermi', name: 'Enrico Fermi Nuclear Generating Station', category: 'power-reactor', status: 'operating',
    state: 'MI', city: 'Newport', lat: 41.963, lon: -83.258, operator: 'DTE Energy', regulator: 'NRC', isfsi: true,
    units: [
      { name: 'Unit 1', docket: '05000016', type: 'SFR', status: 'shutdown', shutdownYear: 1972, commercial: 1966 },
      bwr('Unit 2', '05000341', 1140, 2045, 1988),
    ],
    notes: 'Fermi 1 was a sodium-cooled fast breeder that suffered a partial fuel melt in 1966 and is fully decommissioned. Fermi 3 (ESBWR) holds a combined license (2015) but was never built.',
    statusAliases: ['fermi'],
  },
  {
    id: 'palisades', name: 'Palisades Nuclear Plant', category: 'power-reactor', status: 'restarting',
    state: 'MI', city: 'Covert', lat: 42.323, lon: -86.314, operator: 'Holtec International', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000255', type: 'PWR', netMwe: 800, status: 'restarting', licenseExpires: 2031, commercial: 1971, shutdownYear: 2022 }],
    notes: 'First US power reactor to pursue restart after permanent shutdown (May 2022). NRC returned the operating license to power-operation status in July 2025 with DOE loan support; Holtec also plans two SMR-300 units on the site.',
    statusAliases: ['palisades'],
  },
  {
    id: 'monticello', name: 'Monticello Nuclear Generating Plant', category: 'power-reactor', status: 'operating',
    state: 'MN', city: 'Monticello', lat: 45.334, lon: -93.848, operator: 'Xcel Energy (Northern States Power)', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000263', 671, 2050, 1971)],
    notes: 'Subsequent license renewal to 2050 granted in 2023. A 2022-23 tritium leak to groundwater drew national attention though it stayed on site.',
    statusAliases: ['monticello'],
  },
  {
    id: 'prairie-island', name: 'Prairie Island Nuclear Generating Plant', category: 'power-reactor', status: 'operating',
    state: 'MN', city: 'Welch', lat: 44.622, lon: -92.633, operator: 'Xcel Energy (Northern States Power)', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000282', 521, 2033, 1973), pwr('Unit 2', '05000306', 519, 2034, 1974)],
    notes: 'Adjacent to the Prairie Island Indian Community, which hosts one of the closest residential populations to any US ISFSI.',
    statusAliases: ['prairie island'],
  },
  {
    id: 'grand-gulf', name: 'Grand Gulf Nuclear Station', category: 'power-reactor', status: 'operating',
    state: 'MS', city: 'Port Gibson', lat: 32.007, lon: -91.047, operator: 'Entergy Mississippi', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000416', 1400, 2044, 1985)],
    notes: 'Largest single US reactor by capacity.',
    statusAliases: ['grand gulf'],
  },
  {
    id: 'callaway', name: 'Callaway Energy Center', category: 'power-reactor', status: 'operating',
    state: 'MO', city: 'Fulton', lat: 38.762, lon: -91.781, operator: 'Ameren Missouri', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000483', 1194, 2044, 1984)],
    statusAliases: ['callaway'],
  },
  {
    id: 'cooper', name: 'Cooper Nuclear Station', category: 'power-reactor', status: 'operating',
    state: 'NE', city: 'Brownville', lat: 40.362, lon: -95.641, operator: 'Nebraska Public Power District', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000298', 769, 2034, 1974)],
    notes: 'Missouri River site; the 2011 and 2019 floods tested external-flooding defenses.',
    statusAliases: ['cooper'],
  },
  {
    id: 'seabrook', name: 'Seabrook Station', category: 'power-reactor', status: 'operating',
    state: 'NH', city: 'Seabrook', lat: 42.899, lon: -70.851, operator: 'NextEra Energy', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000443', 1246, 2050, 1990)],
    notes: 'Alkali-silica reaction (concrete degradation) is a plant-specific aging issue tracked through license renewal.',
    statusAliases: ['seabrook'],
  },
  {
    id: 'hope-creek', name: 'Hope Creek Generating Station', category: 'power-reactor', status: 'operating',
    state: 'NJ', city: 'Hancocks Bridge', lat: 39.468, lon: -75.538, operator: 'PSEG Nuclear', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000354', 1172, 2046, 1986)],
    statusAliases: ['hope creek'],
  },
  {
    id: 'salem', name: 'Salem Nuclear Generating Station', category: 'power-reactor', status: 'operating',
    state: 'NJ', city: 'Hancocks Bridge', lat: 39.463, lon: -75.536, operator: 'PSEG Nuclear', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000272', 1169, 2036, 1977), pwr('Unit 2', '05000311', 1181, 2040, 1981)],
    notes: 'Shares Artificial Island on the Delaware River with Hope Creek; together the largest nuclear site in the Northeast.',
    statusAliases: ['salem'],
  },
  {
    id: 'fitzpatrick', name: 'James A. FitzPatrick Nuclear Power Plant', category: 'power-reactor', status: 'operating',
    state: 'NY', city: 'Scriba', lat: 43.523, lon: -76.398, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000333', 813, 2034, 1975)],
    statusAliases: ['fitzpatrick', 'james a fitzpatrick'],
  },
  {
    id: 'ginna', name: 'R.E. Ginna Nuclear Power Plant', category: 'power-reactor', status: 'operating',
    state: 'NY', city: 'Ontario', lat: 43.278, lon: -77.309, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000244', 576, 2029, 1970)],
    notes: 'One of the oldest operating US reactors (1970).',
    statusAliases: ['ginna', 'r e ginna'],
  },
  {
    id: 'nine-mile-point', name: 'Nine Mile Point Nuclear Station', category: 'power-reactor', status: 'operating',
    state: 'NY', city: 'Scriba', lat: 43.521, lon: -76.410, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000220', 613, 2029, 1969), bwr('Unit 2', '05000410', 1277, 2046, 1988)],
    notes: 'Hosts a DOE-supported on-site hydrogen electrolysis demonstration (2023).',
    statusAliases: ['nine mile point'],
  },
  {
    id: 'brunswick', name: 'Brunswick Steam Electric Plant', category: 'power-reactor', status: 'operating',
    state: 'NC', city: 'Southport', lat: 33.958, lon: -78.010, operator: 'Duke Energy Progress', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000325', 938, 2036, 1977), bwr('Unit 2', '05000324', 932, 2034, 1975)],
    notes: 'Coastal site near Wilmington; Hurricane Florence (2018) isolated the plant by road for days.',
    statusAliases: ['brunswick'],
  },
  {
    id: 'harris', name: 'Shearon Harris Nuclear Plant', category: 'power-reactor', status: 'operating',
    state: 'NC', city: 'New Hill', lat: 35.634, lon: -78.956, operator: 'Duke Energy Progress', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000400', 964, 2046, 1987)],
    notes: 'Spent fuel pools also hold fuel shipped from the retired Robinson and Brunswick pools decades ago.',
    statusAliases: ['harris', 'shearon harris'],
  },
  {
    id: 'mcguire', name: 'McGuire Nuclear Station', category: 'power-reactor', status: 'operating',
    state: 'NC', city: 'Huntersville', lat: 35.432, lon: -80.948, operator: 'Duke Energy Carolinas', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000369', 1158, 2041, 1981), pwr('Unit 2', '05000370', 1158, 2043, 1984)],
    notes: 'On Lake Norman, 17 miles north of Charlotte, one of the largest populations within 50 miles of any US plant.',
    statusAliases: ['mcguire'],
  },
  {
    id: 'davis-besse', name: 'Davis-Besse Nuclear Power Station', category: 'power-reactor', status: 'operating',
    state: 'OH', city: 'Oak Harbor', lat: 41.597, lon: -83.086, operator: 'Vistra (Energy Harbor)', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000346', 894, 2037, 1978)],
    notes: 'The 2002 reactor vessel head corrosion cavity remains a landmark NRC safety-culture case study.',
    statusAliases: ['davis besse', 'davis-besse'],
  },
  {
    id: 'perry', name: 'Perry Nuclear Power Plant', category: 'power-reactor', status: 'operating',
    state: 'OH', city: 'Perry', lat: 41.801, lon: -81.143, operator: 'Vistra (Energy Harbor)', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000440', 1240, 2026, 1987)],
    notes: 'Initial license expires November 2026; the renewal application (to 2046) is under NRC review, so the plant runs under timely-renewal provisions if the review extends past expiry.',
    statusAliases: ['perry'],
  },
  {
    id: 'beaver-valley', name: 'Beaver Valley Power Station', category: 'power-reactor', status: 'operating',
    state: 'PA', city: 'Shippingport', lat: 40.622, lon: -80.434, operator: 'Vistra (Energy Harbor)', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000334', 908, 2036, 1976), pwr('Unit 2', '05000412', 905, 2047, 1987)],
    notes: 'Adjacent to the site of Shippingport, the first full-scale US commercial reactor (1957-1982).',
    statusAliases: ['beaver valley'],
  },
  {
    id: 'limerick', name: 'Limerick Generating Station', category: 'power-reactor', status: 'operating',
    state: 'PA', city: 'Pottstown', lat: 40.227, lon: -75.587, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000352', 1134, 2044, 1986), bwr('Unit 2', '05000353', 1134, 2049, 1990)],
    statusAliases: ['limerick'],
  },
  {
    id: 'peach-bottom', name: 'Peach Bottom Atomic Power Station', category: 'power-reactor', status: 'operating',
    state: 'PA', city: 'Delta', lat: 39.759, lon: -76.269, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [
      { name: 'Unit 1', docket: '05000171', type: 'HTGR', status: 'shutdown', shutdownYear: 1974, commercial: 1967 },
      bwr('Unit 2', '05000277', 1308, 2053, 1974), bwr('Unit 3', '05000278', 1309, 2054, 1974),
    ],
    notes: 'Units 2 and 3 hold subsequent renewed licenses to 2053-54 (reinstated 2024). Unit 1 was an early helium-cooled prototype now in SAFSTOR.',
    statusAliases: ['peach bottom'],
  },
  {
    id: 'susquehanna', name: 'Susquehanna Steam Electric Station', category: 'power-reactor', status: 'operating',
    state: 'PA', city: 'Berwick', lat: 41.092, lon: -76.147, operator: 'Talen Energy (Susquehanna Nuclear)', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 1', '05000387', 1257, 2042, 1983), bwr('Unit 2', '05000388', 1257, 2044, 1985)],
    notes: 'Co-located with the Cumulus data-center campus; its 2024 behind-the-meter power deal with Amazon Web Services drove a FERC precedent on co-located load.',
    statusAliases: ['susquehanna'],
  },
  {
    id: 'catawba', name: 'Catawba Nuclear Station', category: 'power-reactor', status: 'operating',
    state: 'SC', city: 'York', lat: 35.051, lon: -81.070, operator: 'Duke Energy Carolinas', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000413', 1160, 2043, 1985), pwr('Unit 2', '05000414', 1150, 2043, 1986)],
    statusAliases: ['catawba'],
  },
  {
    id: 'oconee', name: 'Oconee Nuclear Station', category: 'power-reactor', status: 'operating',
    state: 'SC', city: 'Seneca', lat: 34.794, lon: -82.899, operator: 'Duke Energy Carolinas', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000269', 847, 2033, 1973), pwr('Unit 2', '05000270', 848, 2033, 1974), pwr('Unit 3', '05000287', 859, 2034, 1974)],
    notes: 'Three-unit B&W design downstream of the Jocassee Dam; dam-failure flooding was the subject of a multi-year NRC review. Subsequent license renewal to 2053-54 is under review.',
    statusAliases: ['oconee'],
  },
  {
    id: 'robinson', name: 'H.B. Robinson Steam Electric Plant', category: 'power-reactor', status: 'operating',
    state: 'SC', city: 'Hartsville', lat: 34.403, lon: -80.159, operator: 'Duke Energy Progress', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 2', '05000261', 741, 2030, 1971)],
    notes: 'Subsequent license renewal (to 2050) under NRC review.',
    statusAliases: ['robinson', 'h b robinson'],
  },
  {
    id: 'vc-summer', name: 'Virgil C. Summer Nuclear Station', category: 'power-reactor', status: 'operating',
    state: 'SC', city: 'Jenkinsville', lat: 34.296, lon: -81.316, operator: 'Dominion Energy South Carolina', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000395', 973, 2042, 1984)],
    notes: 'Units 2 and 3 (AP1000) were abandoned in 2017 at roughly 40% complete; Santee Cooper selected a partner in 2025 to study completing them.',
    statusAliases: ['summer', 'v c summer', 'virgil c summer'],
  },
  {
    id: 'sequoyah', name: 'Sequoyah Nuclear Plant', category: 'power-reactor', status: 'operating',
    state: 'TN', city: 'Soddy-Daisy', lat: 35.227, lon: -85.088, operator: 'Tennessee Valley Authority', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000327', 1152, 2040, 1981), pwr('Unit 2', '05000328', 1139, 2041, 1982)],
    statusAliases: ['sequoyah'],
  },
  {
    id: 'watts-bar', name: 'Watts Bar Nuclear Plant', category: 'power-reactor', status: 'operating',
    state: 'TN', city: 'Spring City', lat: 35.603, lon: -84.789, operator: 'Tennessee Valley Authority', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000390', 1157, 2035, 1996), pwr('Unit 2', '05000391', 1164, 2055, 2016)],
    notes: 'Unit 2 (2016) was the first new US reactor of the 21st century. Both units irradiate tritium-producing burnable absorber rods for the NNSA.',
    statusAliases: ['watts bar'],
  },
  {
    id: 'comanche-peak', name: 'Comanche Peak Nuclear Power Plant', category: 'power-reactor', status: 'operating',
    state: 'TX', city: 'Glen Rose', lat: 32.298, lon: -97.785, operator: 'Vistra', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000445', 1218, 2030, 1990), pwr('Unit 2', '05000446', 1207, 2033, 1993)],
    notes: 'License renewal application (to 2050 and 2053) filed in 2022 and under NRC review.',
    statusAliases: ['comanche peak'],
  },
  {
    id: 'south-texas', name: 'South Texas Project', category: 'power-reactor', status: 'operating',
    state: 'TX', city: 'Bay City', lat: 28.795, lon: -96.049, operator: 'STP Nuclear Operating Co.', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000498', 1280, 2047, 1988), pwr('Unit 2', '05000499', 1280, 2048, 1989)],
    notes: 'Gulf Coast site; Winter Storm Uri (Feb 2021) tripped Unit 1 on a frozen feedwater sensing line, a frequently cited grid-resilience event.',
    statusAliases: ['south texas'],
  },
  {
    id: 'north-anna', name: 'North Anna Power Station', category: 'power-reactor', status: 'operating',
    state: 'VA', city: 'Mineral', lat: 38.061, lon: -77.790, operator: 'Dominion Energy', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000338', 948, 2058, 1978), pwr('Unit 2', '05000339', 944, 2060, 1980)],
    notes: 'The 2011 M5.8 Mineral earthquake exceeded the design-basis ground motion and forced a three-month shutdown; subsequent renewed licenses run to 2058-60.',
    statusAliases: ['north anna'],
  },
  {
    id: 'surry', name: 'Surry Power Station', category: 'power-reactor', status: 'operating',
    state: 'VA', city: 'Surry', lat: 37.166, lon: -76.698, operator: 'Dominion Energy', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000280', 838, 2052, 1972), pwr('Unit 2', '05000281', 838, 2053, 1973)],
    notes: 'Site of the first US dry cask ISFSI (1986).',
    statusAliases: ['surry'],
  },
  {
    id: 'columbia', name: 'Columbia Generating Station', category: 'power-reactor', status: 'operating',
    state: 'WA', city: 'Richland', lat: 46.471, lon: -119.334, operator: 'Energy Northwest', regulator: 'NRC', isfsi: true,
    units: [bwr('Unit 2', '05000397', 1131, 2043, 1984)],
    notes: 'The Pacific Northwest\'s only commercial reactor, on leased land inside the DOE Hanford Site.',
    statusAliases: ['columbia'],
  },
  {
    id: 'point-beach', name: 'Point Beach Nuclear Plant', category: 'power-reactor', status: 'operating',
    state: 'WI', city: 'Two Rivers', lat: 44.281, lon: -87.536, operator: 'NextEra Energy', regulator: 'NRC', isfsi: true,
    units: [pwr('Unit 1', '05000266', 591, 2030, 1970), pwr('Unit 2', '05000301', 591, 2033, 1972)],
    notes: 'Subsequent license renewal (to 2050 and 2053) under NRC review.',
    statusAliases: ['point beach'],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // RESTART PROGRAMS (permanently shut units returning to service)
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'crane-tmi-1', name: 'Crane Clean Energy Center (Three Mile Island Unit 1)', category: 'restart', status: 'restarting',
    state: 'PA', city: 'Londonderry Township', lat: 40.153, lon: -76.725, operator: 'Constellation Energy', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000289', type: 'PWR', netMwe: 835, status: 'restarting', licenseExpires: 2034, commercial: 1974, shutdownYear: 2019 }],
    notes: 'Shut in 2019 for economic reasons; Constellation announced a restart in 2024 backed by a 20-year Microsoft power purchase agreement, targeting return to service in 2027 subject to NRC approval. Unit 2 (1979 accident) is a separate decommissioning licensee next door.',
    statusAliases: ['three mile island', 'crane'],
  },
  {
    id: 'duane-arnold', name: 'Duane Arnold Energy Center', category: 'restart', status: 'restarting',
    state: 'IA', city: 'Palo', lat: 42.101, lon: -91.777, operator: 'NextEra Energy', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000331', type: 'BWR', netMwe: 601, status: 'restarting', licenseExpires: 2034, commercial: 1975, shutdownYear: 2020 }],
    notes: 'Shut in 2020 after derecho damage to cooling towers; NextEra filed with the NRC in 2025 to restore the operating license, with restart targeted around 2028-29.',
    statusAliases: ['duane arnold'],
  },

  // ───────────────────────────────────────────────────────────────────────────
  // NEW BUILD AND ADVANCED REACTOR PROJECTS
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'natrium-kemmerer', name: 'TerraPower Natrium Demonstration Plant', category: 'new-build', status: 'construction',
    state: 'WY', city: 'Kemmerer', lat: 41.792, lon: -110.538, operator: 'TerraPower (US SFR Owner)', regulator: 'NRC', docket: '05000613',
    units: [{ name: 'Unit 1', docket: '05000613', type: 'SFR (Natrium)', netMwe: 345, status: 'construction' }],
    notes: 'Sodium-cooled fast reactor with molten-salt thermal storage (345 MWe, 500 MWe peak) replacing a retiring coal plant; DOE Advanced Reactor Demonstration Program award. Non-nuclear construction began June 2024 while the NRC construction permit review proceeded.',
    url: 'https://www.nrc.gov/facilities-safety/new-reactors/advanced-reactors/who-were-working-with/past-licensing-activities/kemmerer-power-station-unit-1',
  },
  {
    id: 'kairos-hermes', name: 'Kairos Power Hermes Test Reactors', category: 'new-build', status: 'construction',
    state: 'TN', city: 'Oak Ridge', lat: 35.999, lon: -84.323, operator: 'Kairos Power', regulator: 'NRC', docket: '05007513',
    units: [
      { name: 'Hermes', docket: '05007513', type: 'FHR (fluoride-salt-cooled)', thermalMw: 35, status: 'construction' },
      { name: 'Hermes 2', type: 'FHR (two-unit demo)', status: 'construction' },
    ],
    notes: 'First non-light-water reactor construction permit issued by the NRC in decades (Hermes, December 2023; Hermes 2, November 2024). Site is the former K-33 footprint at the East Tennessee Technology Park.',
    url: 'https://www.nrc.gov/facilities-safety/non-power-facilities/new-facility-licensing/hermes-kairos-application',
  },
  {
    id: 'x-energy-long-mott', name: 'Long Mott Generating Station (X-energy / Dow)', category: 'new-build', status: 'licensing',
    state: 'TX', city: 'Seadrift', lat: 28.421, lon: -96.726, operator: 'Long Mott Energy (Dow / X-energy)', regulator: 'NRC',
    units: [{ name: 'Xe-100 (4 modules)', type: 'HTGR (pebble bed)', netMwe: 320, status: 'licensing' }],
    notes: 'Four Xe-100 high-temperature gas reactors to supply process heat and power to Dow\'s Seadrift chemical site; construction permit application accepted by the NRC in 2025 under the Advanced Reactor Demonstration Program.',
    url: 'https://www.nrc.gov/facilities-safety/new-reactors/advanced-reactors/who-were-working-with/advanced-reactor-application-projects/long-mott-energy-llc',
  },
  {
    id: 'acu-msrr', name: 'Abilene Christian University Molten Salt Research Reactor', category: 'new-build', status: 'construction',
    state: 'TX', city: 'Abilene', lat: 32.469, lon: -99.710, operator: 'Abilene Christian University / Natura Resources', regulator: 'NRC',
    units: [{ name: 'MSRR', type: 'MSR (liquid-fuel)', thermalMw: 1, status: 'construction' }],
    notes: 'First liquid-fueled molten salt reactor construction permit in the US (September 2024); a university research reactor intended as a prototype for Natura\'s MSR-100.',
    url: 'https://www.nrc.gov/facilities-safety/non-power-facilities/new-facility-licensing/msrr-abilene-christian-university-application',
  },
  {
    id: 'tva-clinch-river', name: 'Clinch River Nuclear Site (TVA BWRX-300)', category: 'new-build', status: 'licensing',
    state: 'TN', city: 'Oak Ridge', lat: 35.892, lon: -84.384, operator: 'Tennessee Valley Authority', regulator: 'NRC',
    units: [{ name: 'Unit 1', type: 'BWRX-300 (SMR)', netMwe: 300, status: 'licensing' }],
    notes: 'TVA holds an early site permit (2019) and filed a construction permit application for a GE Vernova Hitachi BWRX-300 in 2025, the first US utility application for that design.',
    url: 'https://www.nrc.gov/facilities-safety/new-reactors/advanced-reactors/who-were-working-with/advanced-reactor-application-projects/tva-clinch-river-cpa',
  },
  {
    id: 'holtec-palisades-smr', name: 'Palisades SMR-300 Project', category: 'new-build', status: 'licensing',
    state: 'MI', city: 'Covert', lat: 42.320, lon: -86.318, operator: 'Holtec International', regulator: 'NRC',
    units: [{ name: 'SMR-300 x2', type: 'PWR (SMR-300)', netMwe: 600, status: 'licensing' }],
    notes: 'Two Holtec SMR-300 units planned beside the restarted Palisades plant; pre-application engagement with the NRC and a construction permit application targeted for the mid-2020s.',
  },
  {
    id: 'oklo-aurora-inl', name: 'Oklo Aurora Powerhouse (INL)', category: 'new-build', status: 'licensing',
    state: 'ID', city: 'Idaho Falls', lat: 43.590, lon: -112.650, operator: 'Oklo Inc.', regulator: 'NRC',
    units: [{ name: 'Aurora', type: 'SFR (microreactor)', netMwe: 15, status: 'licensing' }],
    notes: 'DOE site-use permit and HALEU fuel allocation at Idaho National Laboratory; Oklo\'s 2020 combined license application was denied without prejudice in 2022 and the company re-entered pre-application review in 2024-25.',
  },
  {
    id: 'fermi-america-amarillo', name: 'Fermi America HyperGrid (Amarillo)', category: 'new-build', status: 'licensing',
    state: 'TX', city: 'Amarillo', lat: 35.296, lon: -101.627, operator: 'Fermi America', regulator: 'NRC',
    units: [{ name: 'AP1000 x4 (proposed)', type: 'AP1000', netMwe: 4400, status: 'planned' }],
    notes: 'Proposed data-center energy campus next to the Pantex Plant; combined license application for up to four AP1000s docketed by the NRC in 2025. Early-stage and unfunded at the reactor level.',
  },
  {
    id: 'vc-summer-2-3', name: 'V.C. Summer Units 2 & 3 (unfinished AP1000s)', category: 'new-build', status: 'dormant',
    state: 'SC', city: 'Jenkinsville', lat: 34.299, lon: -81.313, operator: 'Santee Cooper', regulator: 'NRC',
    units: [{ name: 'Unit 2', docket: '05200027', type: 'AP1000', netMwe: 1117, status: 'planned' }, { name: 'Unit 3', docket: '05200028', type: 'AP1000', netMwe: 1117, status: 'planned' }],
    notes: 'Construction abandoned in 2017 after roughly $9 billion spent. Santee Cooper solicited completion proposals in 2025; the combined licenses were terminated, so completion would need new NRC authorization.',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // DECOMMISSIONING SITES AND STAND-ALONE SPENT FUEL STORAGE
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'tmi-2', name: 'Three Mile Island Unit 2', category: 'decommissioning', status: 'decommissioning',
    state: 'PA', city: 'Londonderry Township', lat: 40.153, lon: -76.727, operator: 'TMI-2 Solutions (EnergySolutions)', regulator: 'NRC',
    units: [{ name: 'Unit 2', docket: '05000320', type: 'PWR', status: 'shutdown', shutdownYear: 1979, commercial: 1978 }],
    notes: 'Site of the 1979 partial core meltdown, the most serious accident in US commercial nuclear history. Core debris was shipped to Idaho National Laboratory; final decommissioning began in 2020 with completion targeted in the late 2030s.',
  },
  {
    id: 'indian-point', name: 'Indian Point Energy Center', category: 'decommissioning', status: 'decommissioning',
    state: 'NY', city: 'Buchanan', lat: 41.270, lon: -73.953, operator: 'Holtec Decommissioning International', regulator: 'NRC', isfsi: true,
    units: [
      { name: 'Unit 1', docket: '05000003', type: 'PWR', status: 'shutdown', shutdownYear: 1974 },
      { name: 'Unit 2', docket: '05000247', type: 'PWR', status: 'shutdown', shutdownYear: 2020 },
      { name: 'Unit 3', docket: '05000286', type: 'PWR', status: 'shutdown', shutdownYear: 2021 },
    ],
    notes: 'Closed in 2020-21 under a state settlement; 24 miles north of New York City. Plans to discharge treated tritiated water to the Hudson were blocked by a 2023 state law.',
  },
  {
    id: 'pilgrim', name: 'Pilgrim Nuclear Power Station', category: 'decommissioning', status: 'decommissioning',
    state: 'MA', city: 'Plymouth', lat: 41.945, lon: -70.579, operator: 'Holtec Decommissioning International', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000293', type: 'BWR', status: 'shutdown', shutdownYear: 2019, commercial: 1972 }],
    notes: 'Shut 2019; disposal of roughly a million gallons of contaminated water (evaporation versus discharge to Cape Cod Bay) remains contested.',
  },
  {
    id: 'oyster-creek', name: 'Oyster Creek Nuclear Generating Station', category: 'decommissioning', status: 'decommissioning',
    state: 'NJ', city: 'Lacey Township', lat: 39.815, lon: -74.206, operator: 'Holtec Decommissioning International', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000219', type: 'BWR', status: 'shutdown', shutdownYear: 2018, commercial: 1969 }],
    notes: 'Was the oldest operating US reactor when it closed in 2018.',
  },
  {
    id: 'vermont-yankee', name: 'Vermont Yankee Nuclear Power Station', category: 'decommissioning', status: 'decommissioning',
    state: 'VT', city: 'Vernon', lat: 42.779, lon: -72.513, operator: 'NorthStar Vermont Yankee', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000271', type: 'BWR', status: 'shutdown', shutdownYear: 2014, commercial: 1972 }],
    notes: 'First plant transferred to a specialist decommissioning company (NorthStar, 2019) for accelerated dismantlement.',
  },
  {
    id: 'kewaunee', name: 'Kewaunee Power Station', category: 'decommissioning', status: 'decommissioning',
    state: 'WI', city: 'Carlton', lat: 44.343, lon: -87.536, operator: 'EnergySolutions', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000305', type: 'PWR', status: 'shutdown', shutdownYear: 2013, commercial: 1974 }],
  },
  {
    id: 'crystal-river', name: 'Crystal River Unit 3', category: 'decommissioning', status: 'decommissioning',
    state: 'FL', city: 'Crystal River', lat: 28.958, lon: -82.699, operator: 'Accelerated Decommissioning Partners (Duke / NorthStar)', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 3', docket: '05000302', type: 'PWR', status: 'shutdown', shutdownYear: 2013, commercial: 1977 }],
    notes: 'Retired after a containment delamination during a 2009 steam-generator replacement; the site still hosts Duke fossil generation.',
  },
  {
    id: 'san-onofre', name: 'San Onofre Nuclear Generating Station (SONGS)', category: 'decommissioning', status: 'decommissioning',
    state: 'CA', city: 'San Clemente', lat: 33.369, lon: -117.555, operator: 'Southern California Edison', regulator: 'NRC', isfsi: true,
    units: [
      { name: 'Unit 1', docket: '05000206', type: 'PWR', status: 'shutdown', shutdownYear: 1992 },
      { name: 'Unit 2', docket: '05000361', type: 'PWR', status: 'shutdown', shutdownYear: 2013, commercial: 1983 },
      { name: 'Unit 3', docket: '05000362', type: 'PWR', status: 'shutdown', shutdownYear: 2013, commercial: 1984 },
    ],
    notes: 'Retired in 2013 after replacement steam generator tube wear. More than 3.5 million pounds of spent fuel sit in a beachfront ISFSI on Camp Pendleton, the most-cited stranded-fuel case in US policy debates.',
  },
  {
    id: 'fort-calhoun', name: 'Fort Calhoun Station', category: 'decommissioning', status: 'isfsi-only',
    state: 'NE', city: 'Fort Calhoun', lat: 41.520, lon: -96.077, operator: 'Omaha Public Power District', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000285', type: 'PWR', status: 'shutdown', shutdownYear: 2016, commercial: 1973 }],
    notes: 'Surrounded by Missouri River floodwater for months in 2011; closed in 2016 for economic reasons and dismantled by 2024.',
  },
  {
    id: 'zion', name: 'Zion Nuclear Power Station', category: 'decommissioning', status: 'isfsi-only',
    state: 'IL', city: 'Zion', lat: 42.446, lon: -87.802, operator: 'Constellation Energy (ZionSolutions completed D&D)', regulator: 'NRC', isfsi: true,
    units: [
      { name: 'Unit 1', docket: '05000295', type: 'PWR', status: 'shutdown', shutdownYear: 1998 },
      { name: 'Unit 2', docket: '05000304', type: 'PWR', status: 'shutdown', shutdownYear: 1998 },
    ],
    notes: 'Dismantlement completed 2020; only the lakefront ISFSI remains.',
  },
  {
    id: 'maine-yankee', name: 'Maine Yankee', category: 'decommissioning', status: 'isfsi-only',
    state: 'ME', city: 'Wiscasset', lat: 43.951, lon: -69.696, operator: 'Maine Yankee Atomic Power Co.', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000309', type: 'PWR', status: 'shutdown', shutdownYear: 1996, commercial: 1972 }],
  },
  {
    id: 'connecticut-yankee', name: 'Connecticut Yankee (Haddam Neck)', category: 'decommissioning', status: 'isfsi-only',
    state: 'CT', city: 'Haddam', lat: 41.482, lon: -72.497, operator: 'Connecticut Yankee Atomic Power Co.', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000213', type: 'PWR', status: 'shutdown', shutdownYear: 1996, commercial: 1968 }],
  },
  {
    id: 'yankee-rowe', name: 'Yankee Rowe', category: 'decommissioning', status: 'isfsi-only',
    state: 'MA', city: 'Rowe', lat: 42.728, lon: -72.929, operator: 'Yankee Atomic Electric Co.', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000029', type: 'PWR', status: 'shutdown', shutdownYear: 1992, commercial: 1961 }],
  },
  {
    id: 'big-rock-point', name: 'Big Rock Point', category: 'decommissioning', status: 'isfsi-only',
    state: 'MI', city: 'Charlevoix', lat: 45.359, lon: -85.195, operator: 'Consumers Energy', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000155', type: 'BWR', status: 'shutdown', shutdownYear: 1997, commercial: 1963 }],
  },
  {
    id: 'la-crosse', name: 'La Crosse Boiling Water Reactor', category: 'decommissioning', status: 'isfsi-only',
    state: 'WI', city: 'Genoa', lat: 43.561, lon: -91.231, operator: 'Dairyland Power Cooperative', regulator: 'NRC', isfsi: true,
    units: [{ name: 'LACBWR', docket: '05000409', type: 'BWR', status: 'shutdown', shutdownYear: 1987, commercial: 1969 }],
  },
  {
    id: 'rancho-seco', name: 'Rancho Seco Nuclear Generating Station', category: 'decommissioning', status: 'isfsi-only',
    state: 'CA', city: 'Herald', lat: 38.345, lon: -121.120, operator: 'Sacramento Municipal Utility District', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000312', type: 'PWR', status: 'shutdown', shutdownYear: 1989, commercial: 1975 }],
    notes: 'Closed by public referendum in 1989.',
  },
  {
    id: 'humboldt-bay', name: 'Humboldt Bay Power Plant Unit 3', category: 'decommissioning', status: 'isfsi-only',
    state: 'CA', city: 'Eureka', lat: 40.741, lon: -124.211, operator: 'Pacific Gas & Electric', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 3', docket: '05000133', type: 'BWR', status: 'shutdown', shutdownYear: 1976, commercial: 1963 }],
    notes: 'Underground ISFSI vault on the coast; dismantlement completed 2021.',
  },
  {
    id: 'trojan', name: 'Trojan Nuclear Plant', category: 'decommissioning', status: 'isfsi-only',
    state: 'OR', city: 'Rainier', lat: 46.040, lon: -122.885, operator: 'Portland General Electric', regulator: 'NRC', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000344', type: 'PWR', status: 'shutdown', shutdownYear: 1992, commercial: 1976 }],
  },
  {
    id: 'fort-st-vrain', name: 'Fort St. Vrain ISFSI', category: 'decommissioning', status: 'isfsi-only',
    state: 'CO', city: 'Platteville', lat: 40.245, lon: -104.871, operator: 'US Department of Energy (Idaho Operations)', regulator: 'NRC/DOE', isfsi: true,
    units: [{ name: 'Unit 1', docket: '05000267', type: 'HTGR', status: 'shutdown', shutdownYear: 1989, commercial: 1979 }],
    notes: 'The only commercial HTGR to operate in the US; its graphite fuel sits in a DOE-owned modular vault.',
  },
  {
    id: 'ge-morris', name: 'GE-Hitachi Morris Operation', category: 'waste', status: 'operating',
    state: 'IL', city: 'Morris', lat: 41.391, lon: -88.258, operator: 'GE-Hitachi Nuclear Energy', regulator: 'NRC', docket: '07200001', isfsi: true,
    notes: 'The only US wet (pool) away-from-reactor spent fuel storage facility, built as a reprocessing plant that never operated; holds fuel from several Midwest and Northeast plants.',
  },
  {
    id: 'shoreham', name: 'Shoreham Nuclear Power Plant', category: 'decommissioning', status: 'decommissioned',
    state: 'NY', city: 'Shoreham', lat: 40.961, lon: -72.868, operator: 'Long Island Power Authority', regulator: 'NRC',
    units: [{ name: 'Unit 1', docket: '05000322', type: 'BWR', status: 'shutdown', shutdownYear: 1989 }],
    notes: 'Completed but never commercially operated; closed in 1989 after an emergency-planning standoff and fully decommissioned.',
  },
  {
    id: 'hallam', name: 'Hallam Nuclear Power Facility', category: 'decommissioning', status: 'decommissioned',
    state: 'NE', city: 'Hallam', lat: 40.563, lon: -96.780, operator: 'US Department of Energy (Legacy Management)', regulator: 'DOE',
    notes: 'Sodium-graphite demonstration reactor (1963-64) entombed on the site of the Sheldon fossil station.',
  },
  {
    id: 'piqua', name: 'Piqua Nuclear Power Facility', category: 'decommissioning', status: 'decommissioned',
    state: 'OH', city: 'Piqua', lat: 40.133, lon: -84.235, operator: 'US Department of Energy (Legacy Management)', regulator: 'DOE',
    notes: 'Organic-cooled demonstration reactor (1963-66), entombed.',
  },
  {
    id: 'bonus', name: 'BONUS Reactor', category: 'decommissioning', status: 'decommissioned',
    state: 'PR', city: 'Rincón', lat: 18.374, lon: -67.268, operator: 'US Department of Energy (Legacy Management)', regulator: 'DOE',
    notes: 'Boiling nuclear superheater demonstration (1964-68), entombed; now a museum site.',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // DOE / NNSA SITES
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'hanford', name: 'Hanford Site', category: 'doe-site', status: 'legacy',
    state: 'WA', city: 'Richland', lat: 46.550, lon: -119.490, operator: 'DOE Office of Environmental Management', regulator: 'DOE',
    notes: 'Plutonium production complex (1943-1987) and the largest US environmental cleanup: 56 million gallons of high-level tank waste, with the Waste Treatment and Immobilization Plant beginning low-activity vitrification in 2025.',
    url: 'https://www.hanford.gov/',
  },
  {
    id: 'savannah-river', name: 'Savannah River Site', category: 'doe-site', status: 'operating',
    state: 'SC', city: 'Aiken', lat: 33.250, lon: -81.650, operator: 'Savannah River Nuclear Solutions / Savannah River Mission Completion', regulator: 'NNSA',
    notes: 'NNSA tritium extraction and loading, the Savannah River Plutonium Processing Facility (pit production, under construction), the Defense Waste Processing Facility, and the Savannah River National Laboratory.',
    url: 'https://www.srs.gov/',
  },
  {
    id: 'inl', name: 'Idaho National Laboratory', category: 'doe-site', status: 'operating',
    state: 'ID', city: 'Idaho Falls', lat: 43.520, lon: -112.950, operator: 'Battelle Energy Alliance', regulator: 'DOE',
    notes: 'The nation\'s nuclear energy laboratory: Advanced Test Reactor, Transient Reactor Test Facility, Materials and Fuels Complex, the National Reactor Innovation Center test beds (MARVEL, DOME), and the Naval Reactors Facility. Also stores TMI-2 core debris and legacy spent fuel.',
    url: 'https://inl.gov/',
  },
  {
    id: 'ornl', name: 'Oak Ridge National Laboratory', category: 'doe-site', status: 'operating',
    state: 'TN', city: 'Oak Ridge', lat: 35.931, lon: -84.310, operator: 'UT-Battelle', regulator: 'DOE',
    notes: 'High Flux Isotope Reactor (85 MWt) for isotopes and neutron science, Spallation Neutron Source, and the Manhattan Project X-10 Graphite Reactor historic site.',
    url: 'https://www.ornl.gov/',
  },
  {
    id: 'y-12', name: 'Y-12 National Security Complex', category: 'doe-site', status: 'operating',
    state: 'TN', city: 'Oak Ridge', lat: 35.984, lon: -84.254, operator: 'Consolidated Nuclear Security', regulator: 'NNSA',
    notes: 'Processes and stores highly enriched uranium for the weapons stockpile and naval reactors; the Uranium Processing Facility is the NNSA\'s largest construction project.',
    url: 'https://www.y12.doe.gov/',
  },
  {
    id: 'ettp', name: 'East Tennessee Technology Park (former K-25)', category: 'doe-site', status: 'legacy',
    state: 'TN', city: 'Oak Ridge', lat: 35.930, lon: -84.395, operator: 'DOE Office of Environmental Management', regulator: 'DOE',
    notes: 'Former gaseous diffusion enrichment plant, demolished and being transferred for reindustrialization; hosts Kairos Hermes and other advanced nuclear tenants.',
  },
  {
    id: 'los-alamos', name: 'Los Alamos National Laboratory', category: 'doe-site', status: 'operating',
    state: 'NM', city: 'Los Alamos', lat: 35.878, lon: -106.301, operator: 'Triad National Security', regulator: 'NNSA',
    notes: 'Weapons design laboratory and the primary plutonium pit production site (PF-4); transuranic waste is shipped to WIPP.',
    url: 'https://www.lanl.gov/',
  },
  {
    id: 'llnl', name: 'Lawrence Livermore National Laboratory', category: 'doe-site', status: 'operating',
    state: 'CA', city: 'Livermore', lat: 37.688, lon: -121.706, operator: 'Lawrence Livermore National Security', regulator: 'NNSA',
    notes: 'Weapons design laboratory; the National Ignition Facility achieved fusion ignition in December 2022.',
    url: 'https://www.llnl.gov/',
  },
  {
    id: 'sandia', name: 'Sandia National Laboratories', category: 'doe-site', status: 'operating',
    state: 'NM', city: 'Albuquerque', lat: 35.051, lon: -106.534, operator: 'National Technology & Engineering Solutions of Sandia', regulator: 'NNSA',
    notes: 'Non-nuclear weapon components, nuclear safety and security research, and the Annular Core Research Reactor.',
    url: 'https://www.sandia.gov/',
  },
  {
    id: 'pantex', name: 'Pantex Plant', category: 'doe-site', status: 'operating',
    state: 'TX', city: 'Amarillo', lat: 35.317, lon: -101.563, operator: 'Consolidated Nuclear Security', regulator: 'NNSA',
    notes: 'Sole US site for nuclear weapon assembly, disassembly, and plutonium pit interim storage.',
    url: 'https://pantex.energy.gov/',
  },
  {
    id: 'kansas-city-nsc', name: 'Kansas City National Security Campus', category: 'doe-site', status: 'operating',
    state: 'MO', city: 'Kansas City', lat: 38.870, lon: -94.571, operator: 'Honeywell Federal Manufacturing & Technologies', regulator: 'NNSA',
    notes: 'Produces the non-nuclear electrical, mechanical, and engineered components of nuclear weapons.',
  },
  {
    id: 'nnss', name: 'Nevada National Security Site', category: 'doe-site', status: 'operating',
    state: 'NV', city: 'Mercury', lat: 37.117, lon: -116.050, operator: 'Mission Support and Test Services', regulator: 'NNSA',
    notes: 'Former nuclear test site (928 tests, 1951-1992); today subcritical experiments, emergency response training, and low-level radioactive waste disposal.',
    url: 'https://www.nnss.gov/',
  },
  {
    id: 'wipp', name: 'Waste Isolation Pilot Plant', category: 'waste', status: 'operating',
    state: 'NM', city: 'Carlsbad', lat: 32.372, lon: -103.792, operator: 'Salado Isolation Mining Contractors (DOE)', regulator: 'DOE',
    notes: 'The only deep geologic repository operating in the US, disposing of defense transuranic waste 2,150 feet down in bedded salt. A 2014 drum rupture halted operations for three years.',
    url: 'https://wipp.energy.gov/',
  },
  {
    id: 'yucca-mountain', name: 'Yucca Mountain', category: 'waste', status: 'dormant',
    state: 'NV', city: 'Amargosa Valley', lat: 36.851, lon: -116.429, operator: 'US Department of Energy', regulator: 'NRC/DOE',
    notes: 'Congressionally designated spent-fuel repository site; the DOE license application was withdrawn from active review in 2010 and remains dormant, so all US commercial spent fuel stays at reactor sites or ISFSIs.',
  },
  {
    id: 'portsmouth', name: 'Portsmouth Site (former gaseous diffusion plant)', category: 'doe-site', status: 'legacy',
    state: 'OH', city: 'Piketon', lat: 39.011, lon: -83.004, operator: 'DOE Office of Environmental Management', regulator: 'DOE',
    notes: 'Enrichment plant (1954-2001) under decontamination and decommissioning; depleted UF6 conversion continues and Centrus operates the HALEU demonstration cascade on site.',
  },
  {
    id: 'paducah', name: 'Paducah Site (former gaseous diffusion plant)', category: 'doe-site', status: 'legacy',
    state: 'KY', city: 'Paducah', lat: 37.113, lon: -88.806, operator: 'DOE Office of Environmental Management', regulator: 'DOE',
    notes: 'Enrichment plant (1952-2013) in cleanup; depleted UF6 conversion facility on site. Global Laser Enrichment proposes a laser enrichment plant to re-enrich DOE tails here.',
  },
  {
    id: 'west-valley', name: 'West Valley Demonstration Project', category: 'doe-site', status: 'legacy',
    state: 'NY', city: 'West Valley', lat: 42.452, lon: -78.651, operator: 'DOE / New York State Energy Research and Development Authority', regulator: 'NRC/DOE',
    notes: 'The only commercial reprocessing plant to operate in the US (1966-72); high-level waste was vitrified in the 1990s and the main plant was demolished by 2025.',
  },
  {
    id: 'argonne', name: 'Argonne National Laboratory', category: 'doe-site', status: 'operating',
    state: 'IL', city: 'Lemont', lat: 41.717, lon: -87.981, operator: 'UChicago Argonne', regulator: 'DOE',
    notes: 'Birthplace of US reactor development (Chicago Pile successors); today fuel-cycle, fast-reactor, and safety research without an operating reactor.',
  },
  {
    id: 'brookhaven', name: 'Brookhaven National Laboratory', category: 'doe-site', status: 'operating',
    state: 'NY', city: 'Upton', lat: 40.873, lon: -72.872, operator: 'Brookhaven Science Associates', regulator: 'DOE',
    notes: 'Research reactors (BGRR, HFBR) are permanently shut and decommissioned; the lab now hosts the National Nuclear Data Center and the Electron-Ion Collider project.',
  },
  {
    id: 'pnnl', name: 'Pacific Northwest National Laboratory', category: 'doe-site', status: 'operating',
    state: 'WA', city: 'Richland', lat: 46.345, lon: -119.280, operator: 'Battelle', regulator: 'DOE',
    notes: 'Radiochemistry, nonproliferation, and waste-processing science supporting Hanford and the Radiological Processing Laboratory.',
  },
  {
    id: 'bettis', name: 'Bettis Atomic Power Laboratory', category: 'doe-site', status: 'operating',
    state: 'PA', city: 'West Mifflin', lat: 40.334, lon: -79.890, operator: 'Fluor Marine Propulsion (Naval Nuclear Laboratory)', regulator: 'NNSA',
    notes: 'Naval Reactors laboratory designing propulsion plants for submarines and carriers.',
  },
  {
    id: 'kapl', name: 'Knolls Atomic Power Laboratory', category: 'doe-site', status: 'operating',
    state: 'NY', city: 'Niskayuna', lat: 42.818, lon: -73.858, operator: 'Fluor Marine Propulsion (Naval Nuclear Laboratory)', regulator: 'NNSA',
    notes: 'Naval Reactors laboratory; the Kesselring Site at West Milton operates prototype plants for crew training.',
  },
  {
    id: 'rocky-flats', name: 'Rocky Flats (Legacy Management)', category: 'doe-site', status: 'legacy',
    state: 'CO', city: 'Arvada', lat: 39.892, lon: -105.202, operator: 'DOE Office of Legacy Management', regulator: 'DOE',
    notes: 'Former plutonium pit plant (1952-1989) closed after an FBI raid; cleanup finished in 2005 and most of the site is now a national wildlife refuge.',
  },
  {
    id: 'fernald', name: 'Fernald Preserve (Legacy Management)', category: 'doe-site', status: 'legacy',
    state: 'OH', city: 'Fernald', lat: 39.299, lon: -84.690, operator: 'DOE Office of Legacy Management', regulator: 'DOE',
    notes: 'Former uranium metal production plant; remediated into a nature preserve with ongoing groundwater pump-and-treat.',
  },
  {
    id: 'moab', name: 'Moab UMTRA Project', category: 'doe-site', status: 'legacy',
    state: 'UT', city: 'Moab', lat: 38.600, lon: -109.580, operator: 'DOE Office of Environmental Management', regulator: 'DOE',
    notes: 'Relocating 16 million tons of uranium mill tailings away from the Colorado River to an engineered cell at Crescent Junction.',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // FUEL CYCLE FACILITIES
  // ───────────────────────────────────────────────────────────────────────────
  {
    id: 'urenco-usa', name: 'Urenco USA (Louisiana Energy Services)', category: 'fuel-cycle', status: 'operating',
    state: 'NM', city: 'Eunice', lat: 32.437, lon: -103.132, operator: 'Urenco USA', regulator: 'NRC', docket: '07003103',
    notes: 'The only operating commercial enrichment plant in the US (gas centrifuge, ~4.9 million SWU/yr) and expanding by roughly 15% in response to the ban on Russian enriched uranium imports.',
    url: 'https://www.nrc.gov/facilities-safety/facility-finder/fc/urenco-enrichment-fac-nm-lc',
  },
  {
    id: 'centrus-piketon', name: 'Centrus American Centrifuge Plant', category: 'fuel-cycle', status: 'operating',
    state: 'OH', city: 'Piketon', lat: 39.005, lon: -83.000, operator: 'Centrus Energy (American Centrifuge Operating)', regulator: 'NRC', docket: '07007004',
    notes: 'First US production of high-assay low-enriched uranium (HALEU, up to 20% U-235) for advanced reactors, under a DOE demonstration contract since 2023.',
    url: 'https://www.nrc.gov/facilities-safety/fuel-cycle-facilities/new-fuel-cycle-facility-licensing/gas-centrifuge-enrichment-facility-licensing/centrus-energy-corpamerican-centrifuge-operating-llc-formerly-usec-inc-gas-centrifuge-enrichme',
  },
  {
    id: 'honeywell-metropolis', name: 'Honeywell Metropolis Works', category: 'fuel-cycle', status: 'operating',
    state: 'IL', city: 'Metropolis', lat: 37.140, lon: -88.752, operator: 'Honeywell International', regulator: 'NRC', docket: '04003392',
    notes: 'The only US uranium conversion plant (U3O8 to UF6); restarted in 2023 after a five-year idle.',
    url: 'https://www.nrc.gov/facilities-safety/facility-finder/fc/honeywell-works-uranium-conv-il-lc',
  },
  {
    id: 'westinghouse-columbia', name: 'Westinghouse Columbia Fuel Fabrication Facility', category: 'fuel-cycle', status: 'operating',
    state: 'SC', city: 'Hopkins', lat: 33.957, lon: -80.933, operator: 'Westinghouse Electric Co.', regulator: 'NRC', docket: '07001151',
    notes: 'PWR fuel assemblies; license renewed in 2024 for 40 years with groundwater remediation conditions.',
    url: 'https://www.nrc.gov/facilities-safety/facility-finder/fc/westinghouse-fuel-fab-fac-sc-lc',
  },
  {
    id: 'gnf-wilmington', name: 'Global Nuclear Fuel-Americas', category: 'fuel-cycle', status: 'operating',
    state: 'NC', city: 'Wilmington', lat: 34.371, lon: -77.925, operator: 'Global Nuclear Fuel (GE Vernova / Hitachi)', regulator: 'NRC', docket: '07001113',
    notes: 'BWR fuel fabrication; NRC approved HALEU fuel fabrication at the site in 2024 for advanced reactor demonstrations.',
    url: 'https://www.nrc.gov/facilities-safety/facility-finder/fc/global-nuc-fuels-america-fuel-fab-lc',
  },
  {
    id: 'framatome-richland', name: 'Framatome Richland Fuel Fabrication', category: 'fuel-cycle', status: 'operating',
    state: 'WA', city: 'Richland', lat: 46.343, lon: -119.312, operator: 'Framatome Inc.', regulator: 'NRC', docket: '07001257',
    notes: 'PWR and BWR fuel fabrication; licensed in 2024 to handle enrichments up to 8% for accident-tolerant and higher-burnup fuels.',
    url: 'https://www.nrc.gov/facilities-safety/facility-finder/fc/areva-np-lc',
  },
  {
    id: 'bwxt-lynchburg', name: 'BWXT Nuclear Operations Group', category: 'fuel-cycle', status: 'operating',
    state: 'VA', city: 'Lynchburg', lat: 37.427, lon: -79.231, operator: 'BWX Technologies', regulator: 'NRC', docket: '07000027',
    notes: 'Category I facility fabricating naval reactor fuel and down-blending HEU; also the planned TRISO fuel line for microreactors.',
    url: 'https://www.nrc.gov/facilities-safety/facility-finder/fc/bwxt-nuclear-lc',
  },
  {
    id: 'nfs-erwin', name: 'Nuclear Fuel Services', category: 'fuel-cycle', status: 'operating',
    state: 'TN', city: 'Erwin', lat: 36.128, lon: -82.416, operator: 'Nuclear Fuel Services (BWXT)', regulator: 'NRC', docket: '07000143',
    notes: 'Category I facility producing naval reactor fuel and down-blending surplus HEU into commercial LEU.',
    url: 'https://www.nrc.gov/facilities-safety/facility-finder/fc/nuclear-fuel-services',
  },
  {
    id: 'triso-x', name: 'TRISO-X Fuel Fabrication Facility (TX-1)', category: 'fuel-cycle', status: 'licensing',
    state: 'TN', city: 'Oak Ridge', lat: 35.955, lon: -84.370, operator: 'TRISO-X (X-energy)', regulator: 'NRC', docket: '07007027',
    notes: 'First commercial-scale TRISO HALEU fuel plant, under NRC Part 70 licensing review at the Horizon Center industrial park.',
    url: 'https://www.nrc.gov/facilities-safety/facility-finder/fc/triso-x',
  },
  {
    id: 'gle-paducah', name: 'Global Laser Enrichment Paducah Laser Enrichment Facility', category: 'fuel-cycle', status: 'licensing',
    state: 'KY', city: 'Paducah', lat: 37.105, lon: -88.780, operator: 'Global Laser Enrichment (Silex / Cameco)', regulator: 'NRC',
    notes: 'Proposed SILEX laser enrichment plant to re-enrich DOE depleted uranium tails; license application submitted to the NRC in 2025.',
  },

  // ───────────────────────────────────────────────────────────────────────────
  // NRC-LICENSED RESEARCH AND TEST REACTORS
  // ───────────────────────────────────────────────────────────────────────────
  { id: 'mit-reactor', name: 'MIT Nuclear Reactor Laboratory', category: 'research-reactor', status: 'operating', state: 'MA', city: 'Cambridge', lat: 42.361, lon: -71.097, operator: 'Massachusetts Institute of Technology', regulator: 'NRC', docket: '05000020', units: [{ name: 'MITR-II', docket: '05000020', type: 'tank (heavy-water reflected)', thermalMw: 6, status: 'operating' }], notes: 'Second-largest university research reactor; fuel irradiation testing for advanced fuels.' },
  { id: 'murr', name: 'University of Missouri Research Reactor (MURR)', category: 'research-reactor', status: 'operating', state: 'MO', city: 'Columbia', lat: 38.937, lon: -92.331, operator: 'University of Missouri', regulator: 'NRC', docket: '05000186', units: [{ name: 'MURR', docket: '05000186', type: 'pool (flux trap)', thermalMw: 10, status: 'operating' }], notes: 'Most powerful US university reactor and the main domestic source of medical isotopes such as Lu-177 and I-131; a second reactor (NextGen MURR) is planned.' },
  { id: 'nist-ncnr', name: 'NIST Center for Neutron Research', category: 'research-reactor', status: 'operating', state: 'MD', city: 'Gaithersburg', lat: 39.137, lon: -77.218, operator: 'National Institute of Standards and Technology', regulator: 'NRC', docket: '05000184', units: [{ name: 'NBSR', docket: '05000184', type: 'tank (heavy water)', thermalMw: 20, status: 'operating' }], notes: 'National neutron-scattering user facility; a 2021 fuel-element overheating event led to a multi-year NRC enforcement and restart review.' },
  { id: 'penn-state-breazeale', name: 'Penn State Breazeale Reactor', category: 'research-reactor', status: 'operating', state: 'PA', city: 'University Park', lat: 40.805, lon: -77.858, operator: 'Pennsylvania State University', regulator: 'NRC', docket: '05000005', units: [{ name: 'PSBR', docket: '05000005', type: 'TRIGA', thermalMw: 1, status: 'operating' }], notes: 'Longest continuously operating licensed US reactor (1955).' },
  { id: 'oregon-state-triga', name: 'Oregon State University TRIGA Reactor', category: 'research-reactor', status: 'operating', state: 'OR', city: 'Corvallis', lat: 44.564, lon: -123.280, operator: 'Oregon State University', regulator: 'NRC', docket: '05000243', units: [{ name: 'OSTR', docket: '05000243', type: 'TRIGA', thermalMw: 1.1, status: 'operating' }] },
  { id: 'reed-reactor', name: 'Reed Research Reactor', category: 'research-reactor', status: 'operating', state: 'OR', city: 'Portland', lat: 45.481, lon: -122.631, operator: 'Reed College', regulator: 'NRC', docket: '05000288', units: [{ name: 'RRR', docket: '05000288', type: 'TRIGA', thermalMw: 0.25, status: 'operating' }], notes: 'The only reactor at a liberal-arts college, largely operated by licensed undergraduates.' },
  { id: 'texas-am-nsc', name: 'Texas A&M Nuclear Science Center', category: 'research-reactor', status: 'operating', state: 'TX', city: 'College Station', lat: 30.596, lon: -96.349, operator: 'Texas A&M University', regulator: 'NRC', docket: '05000128', units: [{ name: 'NSCR', docket: '05000128', type: 'TRIGA', thermalMw: 1, status: 'operating' }, { name: 'AGN-201M', docket: '05000059', type: 'AGN-201', status: 'operating' }] },
  { id: 'ut-austin-netl', name: 'University of Texas at Austin Nuclear Engineering Teaching Laboratory', category: 'research-reactor', status: 'operating', state: 'TX', city: 'Austin', lat: 30.390, lon: -97.726, operator: 'University of Texas at Austin', regulator: 'NRC', docket: '05000602', units: [{ name: 'NETL TRIGA', docket: '05000602', type: 'TRIGA', thermalMw: 1.1, status: 'operating' }] },
  { id: 'wisconsin-reactor', name: 'University of Wisconsin Nuclear Reactor', category: 'research-reactor', status: 'operating', state: 'WI', city: 'Madison', lat: 43.072, lon: -89.410, operator: 'University of Wisconsin-Madison', regulator: 'NRC', docket: '05000156', units: [{ name: 'UWNR', docket: '05000156', type: 'TRIGA', thermalMw: 1, status: 'operating' }] },
  { id: 'purdue-pur-1', name: 'Purdue University Reactor (PUR-1)', category: 'research-reactor', status: 'operating', state: 'IN', city: 'West Lafayette', lat: 40.429, lon: -86.912, operator: 'Purdue University', regulator: 'NRC', docket: '05000182', units: [{ name: 'PUR-1', docket: '05000182', type: 'pool', thermalMw: 0.012, status: 'operating' }], notes: 'First US reactor licensed with a fully digital instrumentation and control system (2019).' },
  { id: 'ohio-state-reactor', name: 'Ohio State University Research Reactor', category: 'research-reactor', status: 'operating', state: 'OH', city: 'Columbus', lat: 40.004, lon: -83.040, operator: 'Ohio State University', regulator: 'NRC', docket: '05000150', units: [{ name: 'OSURR', docket: '05000150', type: 'pool', thermalMw: 0.5, status: 'operating' }] },
  { id: 'kansas-state-triga', name: 'Kansas State University TRIGA Mark II', category: 'research-reactor', status: 'operating', state: 'KS', city: 'Manhattan', lat: 39.190, lon: -96.583, operator: 'Kansas State University', regulator: 'NRC', docket: '05000188', units: [{ name: 'KSU TRIGA', docket: '05000188', type: 'TRIGA', thermalMw: 1.25, status: 'operating' }] },
  { id: 'washington-state-reactor', name: 'Washington State University Nuclear Science Center', category: 'research-reactor', status: 'operating', state: 'WA', city: 'Pullman', lat: 46.728, lon: -117.165, operator: 'Washington State University', regulator: 'NRC', docket: '05000027', units: [{ name: 'WSUR', docket: '05000027', type: 'TRIGA', thermalMw: 1, status: 'operating' }] },
  { id: 'rhode-island-nsc', name: 'Rhode Island Nuclear Science Center', category: 'research-reactor', status: 'operating', state: 'RI', city: 'Narragansett', lat: 41.492, lon: -71.420, operator: 'Rhode Island Atomic Energy Commission', regulator: 'NRC', docket: '05000193', units: [{ name: 'RINSC', docket: '05000193', type: 'pool', thermalMw: 2, status: 'operating' }] },
  { id: 'nc-state-pulstar', name: 'North Carolina State University PULSTAR Reactor', category: 'research-reactor', status: 'operating', state: 'NC', city: 'Raleigh', lat: 35.784, lon: -78.676, operator: 'North Carolina State University', regulator: 'NRC', docket: '05000297', units: [{ name: 'PULSTAR', docket: '05000297', type: 'pool (PULSTAR)', thermalMw: 1, status: 'operating' }], notes: 'NC State hosted the first university reactor in the world (1953).' },
  { id: 'idaho-state-agn', name: 'Idaho State University AGN-201', category: 'research-reactor', status: 'operating', state: 'ID', city: 'Pocatello', lat: 42.862, lon: -112.429, operator: 'Idaho State University', regulator: 'NRC', docket: '05000284', units: [{ name: 'AGN-201', docket: '05000284', type: 'AGN-201', thermalMw: 0.000005, status: 'operating' }] },
  { id: 'utah-triga', name: 'University of Utah TRIGA Reactor', category: 'research-reactor', status: 'operating', state: 'UT', city: 'Salt Lake City', lat: 40.766, lon: -111.846, operator: 'University of Utah', regulator: 'NRC', docket: '05000407', units: [{ name: 'UUTR', docket: '05000407', type: 'TRIGA', thermalMw: 0.1, status: 'operating' }] },
  { id: 'florida-uftr', name: 'University of Florida Training Reactor', category: 'research-reactor', status: 'operating', state: 'FL', city: 'Gainesville', lat: 29.643, lon: -82.347, operator: 'University of Florida', regulator: 'NRC', docket: '05000083', units: [{ name: 'UFTR', docket: '05000083', type: 'Argonaut', thermalMw: 0.1, status: 'operating' }] },
  { id: 'maryland-mutr', name: 'University of Maryland Training Reactor', category: 'research-reactor', status: 'operating', state: 'MD', city: 'College Park', lat: 38.992, lon: -76.938, operator: 'University of Maryland', regulator: 'NRC', docket: '05000166', units: [{ name: 'MUTR', docket: '05000166', type: 'TRIGA', thermalMw: 0.25, status: 'operating' }] },
  { id: 'umass-lowell', name: 'University of Massachusetts Lowell Research Reactor', category: 'research-reactor', status: 'operating', state: 'MA', city: 'Lowell', lat: 42.655, lon: -71.326, operator: 'University of Massachusetts Lowell', regulator: 'NRC', docket: '05000223', units: [{ name: 'UMLRR', docket: '05000223', type: 'pool', thermalMw: 1, status: 'operating' }] },
  { id: 'rpi-rcf', name: 'Rensselaer Polytechnic Institute Reactor Critical Facility', category: 'research-reactor', status: 'operating', state: 'NY', city: 'Schenectady', lat: 42.800, lon: -73.950, operator: 'Rensselaer Polytechnic Institute', regulator: 'NRC', docket: '05000225', units: [{ name: 'RCF', docket: '05000225', type: 'critical assembly', thermalMw: 0.0001, status: 'operating' }] },
  { id: 'afrri-triga', name: 'Armed Forces Radiobiology Research Institute TRIGA', category: 'research-reactor', status: 'operating', state: 'MD', city: 'Bethesda', lat: 39.002, lon: -77.098, operator: 'Uniformed Services University (Department of Defense)', regulator: 'NRC', docket: '05000170', units: [{ name: 'AFRRI TRIGA', docket: '05000170', type: 'TRIGA', thermalMw: 1, status: 'operating' }] },
  { id: 'dow-triga', name: 'Dow Chemical TRIGA Research Reactor', category: 'research-reactor', status: 'operating', state: 'MI', city: 'Midland', lat: 43.603, lon: -84.224, operator: 'Dow Chemical Co.', regulator: 'NRC', docket: '05000264', units: [{ name: 'Dow TRIGA', docket: '05000264', type: 'TRIGA', thermalMw: 0.3, status: 'operating' }], notes: 'The only industrially owned research reactor in the US.' },
  { id: 'missouri-st', name: 'Missouri University of Science and Technology Reactor', category: 'research-reactor', status: 'operating', state: 'MO', city: 'Rolla', lat: 37.955, lon: -91.773, operator: 'Missouri S&T', regulator: 'NRC', docket: '05000123', units: [{ name: 'MSTR', docket: '05000123', type: 'pool', thermalMw: 0.2, status: 'operating' }] },
  { id: 'uc-irvine-triga', name: 'UC Irvine Nuclear Reactor Facility', category: 'research-reactor', status: 'operating', state: 'CA', city: 'Irvine', lat: 33.643, lon: -117.844, operator: 'University of California, Irvine', regulator: 'NRC', docket: '05000326', units: [{ name: 'UCI TRIGA', docket: '05000326', type: 'TRIGA', thermalMw: 0.25, status: 'operating' }] },
  { id: 'uc-davis-mnrc', name: 'UC Davis McClellan Nuclear Research Center', category: 'research-reactor', status: 'operating', state: 'CA', city: 'Sacramento', lat: 38.667, lon: -121.397, operator: 'University of California, Davis', regulator: 'NRC', docket: '05000607', units: [{ name: 'MNRC', docket: '05000607', type: 'TRIGA', thermalMw: 2, status: 'operating' }], notes: 'Built by the Air Force for neutron radiography of aircraft parts at the former McClellan AFB.' },
  { id: 'unm-agn', name: 'University of New Mexico AGN-201M', category: 'research-reactor', status: 'operating', state: 'NM', city: 'Albuquerque', lat: 35.084, lon: -106.620, operator: 'University of New Mexico', regulator: 'NRC', docket: '05000252', units: [{ name: 'AGN-201M', docket: '05000252', type: 'AGN-201', thermalMw: 0.000005, status: 'operating' }] },
  { id: 'ge-vallecitos', name: 'GE Vallecitos Nuclear Center', category: 'research-reactor', status: 'decommissioning', state: 'CA', city: 'Sunol', lat: 37.606, lon: -121.839, operator: 'GE-Hitachi Nuclear Energy (NorthStar for D&D)', regulator: 'NRC', docket: '05000073', notes: 'Historic test reactor site (VBWR, GETR, ESADA) sold to NorthStar in 2024 for decommissioning.' },
  { id: 'ns-savannah', name: 'NS Savannah', category: 'research-reactor', status: 'decommissioning', state: 'MD', city: 'Baltimore', lat: 39.264, lon: -76.580, operator: 'US Maritime Administration', regulator: 'NRC', docket: '05000238', notes: 'The first nuclear-powered merchant ship (1962-1971); reactor removal completed in 2023 ahead of license termination.' },

  // ───────────────────────────────────────────────────────────────────────────
  // URANIUM RECOVERY (conventional mills and in-situ recovery)
  // ───────────────────────────────────────────────────────────────────────────
  { id: 'white-mesa-mill', name: 'White Mesa Mill', category: 'uranium-recovery', status: 'operating', state: 'UT', city: 'Blanding', lat: 37.546, lon: -109.494, operator: 'Energy Fuels', regulator: 'Agreement State', notes: 'The only operating conventional uranium mill in the US; also processes rare earth and vanadium feedstocks. Licensed by Utah under its NRC agreement.' },
  { id: 'smith-ranch-highland', name: 'Smith Ranch-Highland ISR', category: 'uranium-recovery', status: 'standby', state: 'WY', city: 'Glenrock', lat: 42.954, lon: -105.656, operator: 'Cameco (Power Resources)', regulator: 'NRC', docket: '04008964', notes: 'Largest licensed US in-situ recovery operation, curtailed since 2016 pending market recovery.' },
  { id: 'crow-butte', name: 'Crow Butte ISR', category: 'uranium-recovery', status: 'standby', state: 'NE', city: 'Crawford', lat: 42.601, lon: -103.329, operator: 'Cameco (Crow Butte Resources)', regulator: 'NRC', docket: '04008943' },
  { id: 'lost-creek', name: 'Lost Creek ISR', category: 'uranium-recovery', status: 'operating', state: 'WY', city: 'Bairoil', lat: 42.160, lon: -107.750, operator: 'Ur-Energy', regulator: 'NRC', docket: '04009068', notes: 'Returned to production in 2024 as US utilities re-contracted domestic supply.' },
  { id: 'shirley-basin', name: 'Shirley Basin ISR', category: 'uranium-recovery', status: 'construction', state: 'WY', city: 'Shirley Basin', lat: 42.310, lon: -106.120, operator: 'Ur-Energy', regulator: 'NRC', docket: '04009099', notes: 'Second Ur-Energy project, under construction with first production targeted for 2026.' },
  { id: 'nichols-ranch', name: 'Nichols Ranch ISR', category: 'uranium-recovery', status: 'standby', state: 'WY', city: 'Pumpkin Buttes', lat: 43.730, lon: -105.950, operator: 'Uranium Energy Corp', regulator: 'NRC', docket: '04009067' },
  { id: 'christensen-ranch', name: 'Christensen Ranch / Irigaray (Willow Creek) ISR', category: 'uranium-recovery', status: 'operating', state: 'WY', city: 'Powder River Basin', lat: 43.936, lon: -106.000, operator: 'Uranium Energy Corp', regulator: 'NRC', docket: '04008502', notes: 'Restarted in 2024; central processing at Irigaray.' },
  { id: 'ross-lance', name: 'Ross / Lance Projects ISR', category: 'uranium-recovery', status: 'operating', state: 'WY', city: 'Oshoto', lat: 44.625, lon: -104.630, operator: 'Strata Energy (Peninsula Energy)', regulator: 'NRC', docket: '04009091', notes: 'Converted to low-pH in-situ recovery; production restarted in 2024-25.' },
  { id: 'burke-hollow', name: 'Burke Hollow / Hobson ISR', category: 'uranium-recovery', status: 'construction', state: 'TX', city: 'Bee County', lat: 28.585, lon: -97.980, operator: 'Uranium Energy Corp', regulator: 'Agreement State', notes: 'South Texas ISR hub (Hobson processing plant) licensed by Texas; Burke Hollow wellfields under construction.' },

  // ───────────────────────────────────────────────────────────────────────────
  // WASTE DISPOSAL AND CONSOLIDATED INTERIM STORAGE
  // ───────────────────────────────────────────────────────────────────────────
  { id: 'holtec-hi-store', name: 'Holtec HI-STORE Consolidated Interim Storage Facility', category: 'waste', status: 'licensing', state: 'NM', city: 'Lea County', lat: 32.420, lon: -103.350, operator: 'Holtec International', regulator: 'NRC', docket: '07201051', notes: 'NRC license issued in 2023 for up to 8,680 metric tons of spent fuel. The Supreme Court\'s 2025 decision in NRC v. Texas upheld the companion Texas license against state challenges, but New Mexico law and the lack of a federal repository keep the project unbuilt.' },
  { id: 'isp-wcs-cisf', name: 'Interim Storage Partners CISF (Andrews)', category: 'waste', status: 'licensing', state: 'TX', city: 'Andrews', lat: 32.437, lon: -103.050, operator: 'Interim Storage Partners (Waste Control Specialists / Orano)', regulator: 'NRC', docket: '07201050', notes: 'Licensed in 2021 for 5,000 metric tons of spent fuel; Texas banned high-level waste storage the same year and the dispute reached the Supreme Court in 2025.' },
  { id: 'wcs-llw', name: 'Waste Control Specialists Low-Level Waste Disposal', category: 'waste', status: 'operating', state: 'TX', city: 'Andrews', lat: 32.430, lon: -103.055, operator: 'Waste Control Specialists', regulator: 'Agreement State', notes: 'Compact and federal low-level waste disposal cells plus a byproduct-material cell; accepted greater-than-Class-C and DOE waste streams.' },
  { id: 'energysolutions-clive', name: 'EnergySolutions Clive Disposal Facility', category: 'waste', status: 'operating', state: 'UT', city: 'Clive', lat: 40.717, lon: -113.070, operator: 'EnergySolutions', regulator: 'Agreement State', notes: 'The largest US Class A low-level waste disposal site, receiving reactor decommissioning debris and depleted uranium.' },
  { id: 'barnwell-llw', name: 'Barnwell Low-Level Radioactive Waste Disposal Facility', category: 'waste', status: 'operating', state: 'SC', city: 'Barnwell', lat: 33.283, lon: -81.420, operator: 'EnergySolutions', regulator: 'Agreement State', notes: 'Atlantic Compact disposal site (SC, NJ, CT) adjacent to the Savannah River Site; one of only four US commercial LLW disposal sites.' },
  { id: 'us-ecology-richland', name: 'US Ecology Richland Low-Level Waste Disposal', category: 'waste', status: 'operating', state: 'WA', city: 'Richland', lat: 46.560, lon: -119.520, operator: 'US Ecology (Republic Services)', regulator: 'Agreement State', notes: 'Northwest and Rocky Mountain compact disposal site on leased DOE Hanford land.' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Derived views and lookups
// ─────────────────────────────────────────────────────────────────────────────

const FACILITY_BY_ID = new Map(US_NUCLEAR_FACILITIES.map((f) => [f.id, f]));

export function getUsNuclearFacility(id: string): UsNuclearFacility | undefined {
  return FACILITY_BY_ID.get(id);
}

export function getUsNuclearFacilitiesByCategory(category: UsNuclearFacilityCategory): UsNuclearFacility[] {
  return US_NUCLEAR_FACILITIES.filter((f) => f.category === category);
}

/** Sites with at least one unit that is operating or restarting. */
export function getOperatingPowerReactorSites(): UsNuclearFacility[] {
  return US_NUCLEAR_FACILITIES.filter(
    (f) => (f.category === 'power-reactor' || f.category === 'restart')
      && (f.units ?? []).some((u) => u.status === 'operating' || u.status === 'restarting'),
  );
}

export interface UsNuclearFleetSummary {
  operatingSites: number;
  operatingUnits: number;
  restartingUnits: number;
  netMwe: number;
  pwrUnits: number;
  bwrUnits: number;
  unitsByRegion: Record<1 | 2 | 3 | 4, number>;
  unitsByState: Record<string, number>;
  licenseExpiringBy2030: number;
  newBuildProjects: number;
  decommissioningSites: number;
  researchReactors: number;
  fuelCycleFacilities: number;
  doeSites: number;
  uraniumRecoverySites: number;
  wasteSites: number;
  asOf: string;
}

export function summarizeUsNuclearFleet(facilities: UsNuclearFacility[] = US_NUCLEAR_FACILITIES): UsNuclearFleetSummary {
  const summary: UsNuclearFleetSummary = {
    operatingSites: 0,
    operatingUnits: 0,
    restartingUnits: 0,
    netMwe: 0,
    pwrUnits: 0,
    bwrUnits: 0,
    unitsByRegion: { 1: 0, 2: 0, 3: 0, 4: 0 },
    unitsByState: {},
    licenseExpiringBy2030: 0,
    newBuildProjects: 0,
    decommissioningSites: 0,
    researchReactors: 0,
    fuelCycleFacilities: 0,
    doeSites: 0,
    uraniumRecoverySites: 0,
    wasteSites: 0,
    asOf: US_NUCLEAR_REGISTRY_AS_OF,
  };

  for (const f of facilities) {
    switch (f.category) {
      case 'new-build': summary.newBuildProjects += 1; break;
      case 'decommissioning': summary.decommissioningSites += 1; break;
      case 'research-reactor': summary.researchReactors += 1; break;
      case 'fuel-cycle': summary.fuelCycleFacilities += 1; break;
      case 'doe-site': summary.doeSites += 1; break;
      case 'uranium-recovery': summary.uraniumRecoverySites += 1; break;
      case 'waste': summary.wasteSites += 1; break;
      default: break;
    }
    if (f.category !== 'power-reactor' && f.category !== 'restart') continue;
    const units = (f.units ?? []).filter((u) => u.status === 'operating' || u.status === 'restarting');
    if (units.length === 0) continue;
    if (units.some((u) => u.status === 'operating')) summary.operatingSites += 1;
    const region = getNrcRegion(f.state);
    for (const u of units) {
      if (u.status === 'restarting') {
        summary.restartingUnits += 1;
        continue;
      }
      summary.operatingUnits += 1;
      summary.netMwe += u.netMwe ?? 0;
      if (u.type === 'PWR' || u.type === 'AP1000') summary.pwrUnits += 1;
      if (u.type === 'BWR') summary.bwrUnits += 1;
      if (region) summary.unitsByRegion[region] += 1;
      summary.unitsByState[f.state] = (summary.unitsByState[f.state] ?? 0) + 1;
      if (u.licenseExpires !== undefined && u.licenseExpires <= 2030) summary.licenseExpiringBy2030 += 1;
    }
  }
  return summary;
}

/** Lowercase, punctuation-stripped, whitespace-collapsed form used for NRC unit-name matching. */
export function normalizeReactorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Strip a trailing unit designator ("1", "unit 2", "u3") from a normalized NRC unit name. */
export function stripUnitSuffix(normalized: string): { base: string; unit?: string } {
  const m = normalized.match(/^(.*?)(?:\s+(?:unit\s*)?(\d+))?$/);
  if (!m) return { base: normalized };
  return { base: (m[1] ?? normalized).trim(), unit: m[2] };
}

interface AliasEntry { alias: string; facility: UsNuclearFacility }

let aliasIndex: AliasEntry[] | null = null;

function buildAliasIndex(): AliasEntry[] {
  if (aliasIndex) return aliasIndex;
  const entries: AliasEntry[] = [];
  for (const f of US_NUCLEAR_FACILITIES) {
    if (f.category !== 'power-reactor' && f.category !== 'restart') continue;
    const aliases = new Set<string>((f.statusAliases ?? []).map(normalizeReactorName));
    aliases.add(normalizeReactorName(f.name));
    for (const alias of aliases) {
      if (alias) entries.push({ alias, facility: f });
    }
  }
  // Longest alias first so "nine mile point" wins over any shorter overlap.
  entries.sort((a, b) => b.alias.length - a.alias.length);
  aliasIndex = entries;
  return entries;
}

/**
 * Resolve an NRC power reactor status "Unit" label (e.g. "Browns Ferry 1",
 * "Saint Lucie 2", "Columbia Generating Station") to a registry facility and,
 * when present, the matching unit record.
 */
export function matchNrcUnitName(unitLabel: string): { facility: UsNuclearFacility; unit?: UsReactorUnit } | undefined {
  const normalized = normalizeReactorName(unitLabel);
  if (!normalized) return undefined;
  const { base, unit } = stripUnitSuffix(normalized);
  const candidates = [normalized, base];
  for (const entry of buildAliasIndex()) {
    const hit = candidates.some((c) => c === entry.alias || c.startsWith(`${entry.alias} `));
    if (!hit) continue;
    const unitRecord = unit
      ? (entry.facility.units ?? []).find((u) => normalizeReactorName(u.name).endsWith(` ${unit}`) || normalizeReactorName(u.name) === unit)
      : (entry.facility.units ?? []).find((u) => u.status === 'operating' || u.status === 'restarting');
    return { facility: entry.facility, unit: unitRecord };
  }
  return undefined;
}

// ADAMS Public Search (adams-search.nrc.gov) encodes a saved query as a
// double-URL-encoded JSON object in the path. The property ids are the
// search application's own constants (captured from its advanced-search form).
export const ADAMS_SEARCH_BASE = 'https://adams-search.nrc.gov/results/';
const ADAMS_DOCKET_PROPERTY = '48232224-3128-4397-886a-b16465fb1a41';

interface AdamsPropertyFilter {
  propertyItem: string;
  keywords: string;
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  dateOperator: 'between';
  textOperator: 'equals' | 'contains' | 'starts';
  isDate: boolean;
}

export interface AdamsQuery {
  keywords: string;
  legacyLibFilter: boolean;
  mainLibFilter: boolean;
  any: AdamsPropertyFilter[];
  all: AdamsPropertyFilter[];
}

function adamsFilter(propertyItem: string, keywords: string, textOperator: AdamsPropertyFilter['textOperator']): AdamsPropertyFilter {
  return { propertyItem, keywords, startDate: '', endDate: '', startTime: '', endTime: '', dateOperator: 'between', textOperator, isDate: false };
}

/** Build the ADAMS Public Search URL for a query object. */
export function adamsSearchUrl(query: AdamsQuery): string {
  return ADAMS_SEARCH_BASE + encodeURIComponent(encodeURIComponent(JSON.stringify(query)));
}

/** Reverse of `adamsSearchUrl`; returns undefined for anything that is not one of ours. */
export function parseAdamsSearchUrl(url: string): AdamsQuery | undefined {
  if (!url.startsWith(ADAMS_SEARCH_BASE)) return undefined;
  try {
    return JSON.parse(decodeURIComponent(decodeURIComponent(url.slice(ADAMS_SEARCH_BASE.length)))) as AdamsQuery;
  } catch {
    return undefined;
  }
}

/** ADAMS full-text search for free keywords (a plant name, an accession number). */
export function adamsKeywordUrl(keywords: string): string {
  return adamsSearchUrl({ keywords, legacyLibFilter: true, mainLibFilter: true, any: [], all: [] });
}

/**
 * ADAMS Public Search filtered to one NRC docket (property "Docket Number"
 * equals). The docket number is the stable public key for any licensed
 * facility: every inspection report, LER, license amendment and piece of
 * correspondence carries it.
 */
export function nrcDocketUrl(docket: string): string {
  return adamsSearchUrl({
    keywords: '',
    legacyLibFilter: true,
    mainLibFilter: true,
    any: [],
    all: [adamsFilter(ADAMS_DOCKET_PROPERTY, docket, 'equals')],
  });
}

/**
 * NRC facility-finder page slugs for operating power reactor units, keyed by
 * unit docket. Captured from the "Operating Nuclear Power Reactors (by
 * Location or Name)" list plus the Palisades restart page; the page carries
 * the unit's license, resident inspector, project manager, ROP assessment and
 * emergency plan links. The NRC has not published pages for the AP1000 units
 * Vogtle 3 and 4 (dockets 052-00025/26), so those fall back to ADAMS.
 */
export const NRC_FACILITY_FINDER_SLUGS: Readonly<Record<string, string>> = {
  '05000313': 'ano1', '05000368': 'ano2',
  '05000334': 'bv1', '05000412': 'bv2',
  '05000456': 'brai1', '05000457': 'brai2',
  '05000259': 'bf1', '05000260': 'bf2', '05000296': 'bf3',
  '05000325': 'bru1', '05000324': 'bru2',
  '05000454': 'byro1', '05000455': 'byro2',
  '05000483': 'call',
  '05000317': 'calv1', '05000318': 'calv2',
  '05000413': 'cat1', '05000414': 'cat2',
  '05000461': 'clin',
  '05000397': 'wash2',
  '05000445': 'cp1', '05000446': 'cp2',
  '05000298': 'cns',
  '05000315': 'cook1', '05000316': 'cook2',
  '05000346': 'davi',
  '05000275': 'diab1', '05000323': 'diab2',
  '05000237': 'dres2', '05000249': 'dres3',
  '05000348': 'far1', '05000364': 'far2',
  '05000341': 'ferm2',
  '05000333': 'fitz',
  '05000244': 'ginn',
  '05000416': 'gg1',
  '05000400': 'har1',
  '05000321': 'hat1', '05000366': 'hat2',
  '05000354': 'hope',
  '05000373': 'lasa1', '05000374': 'lasa2',
  '05000352': 'lim1', '05000353': 'lim2',
  '05000369': 'mcg1', '05000370': 'mcg2',
  '05000336': 'mill2', '05000423': 'mill3',
  '05000263': 'mont',
  '05000220': 'nmp1', '05000410': 'nmp2',
  '05000338': 'na1', '05000339': 'na2',
  '05000269': 'oco1', '05000270': 'oco2', '05000287': 'oco3',
  '05000528': 'palo1', '05000529': 'palo2', '05000530': 'palo3',
  '05000277': 'pb2', '05000278': 'pb3',
  '05000255': 'pali',
  '05000440': 'perr1',
  '05000266': 'poin1', '05000301': 'poin2',
  '05000282': 'prai1', '05000306': 'prai2',
  '05000254': 'quad1', '05000265': 'quad2',
  '05000458': 'rbs1',
  '05000261': 'rob2',
  '05000335': 'stl1', '05000389': 'stl2',
  '05000272': 'salm1', '05000311': 'salm2',
  '05000443': 'seab1',
  '05000327': 'seq1', '05000328': 'seq2',
  '05000498': 'stp1', '05000499': 'stp2',
  '05000280': 'sur1', '05000281': 'sur2',
  '05000387': 'susq1', '05000388': 'susq2',
  '05000250': 'tp3', '05000251': 'tp4',
  '05000395': 'sum',
  '05000424': 'vog1', '05000425': 'vog2',
  '05000382': 'wat3',
  '05000390': 'wb1', '05000391': 'wb2',
  '05000482': 'wc',
};

/** The NRC facility-finder page for an operating power reactor unit, when the NRC publishes one. */
export function nrcFacilityPageUrl(docket: string | undefined): string | undefined {
  const slug = docket ? NRC_FACILITY_FINDER_SLUGS[docket] : undefined;
  return slug ? `https://www.nrc.gov/facilities-safety/facility-finder/reactors/${slug}` : undefined;
}

/** Research links for one facility: ADAMS by docket, the NRC facility page, and the INL search tools. */
export function nrcFacilityResearchLinks(facility: UsNuclearFacility): Array<{ label: string; url: string }> {
  const links: Array<{ label: string; url: string }> = [];
  const units = facility.units ?? [];
  const unitPages = units
    .map((u) => ({ unit: u, url: nrcFacilityPageUrl(u.docket) }))
    .filter((x): x is { unit: UsReactorUnit; url: string } => Boolean(x.url));
  for (const { unit, url } of unitPages) {
    links.push({ label: unitPages.length > 1 ? `NRC page · ${unit.name}` : 'NRC facility page', url });
  }
  const dockets = [facility.docket, ...units.map((u) => u.docket)].filter((d): d is string => Boolean(d));
  const seen = new Set<string>();
  for (const docket of dockets) {
    if (seen.has(docket)) continue;
    seen.add(docket);
    links.push({ label: `ADAMS docket ${docket}`, url: nrcDocketUrl(docket) });
  }
  if (!dockets.length) links.push({ label: 'ADAMS search', url: adamsKeywordUrl(facility.name) });
  // LERs and inspection reports exist only for NRC licensees; DOE and NNSA
  // sites report through DOE's own occurrence reporting system instead.
  const nrcLicensed = facility.regulator !== 'DOE' && facility.regulator !== 'NNSA';
  if (!nrcLicensed) return links;
  if (facility.category === 'power-reactor' || facility.category === 'restart' || facility.category === 'decommissioning') {
    links.push({ label: 'Licensee Event Reports', url: NRC_RESEARCH_SOURCES.lerSearch });
    links.push({ label: 'Inspection reports', url: NRC_RESEARCH_SOURCES.inspectionReportSearch });
  } else {
    links.push({ label: 'Event notification search', url: NRC_RESEARCH_SOURCES.eventNotificationSearch });
  }
  return links;
}
