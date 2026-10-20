/**
 * Canonical bootstrap cache-key registry.
 *
 * This module is the authored source for the server, the bootstrap-tier
 * publisher, and the generated Edge-safe mirror in api/. Keep the object in
 * response insertion order: the publisher and /api/bootstrap must assemble
 * byte-equivalent payloads for identical Redis contents.
 */

export const BOOTSTRAP_CACHE_KEYS = Object.freeze({
  earthquakes: 'seismology:earthquakes:v1',
  outages: 'infra:outages:v1',
  serviceStatuses: 'infra:service-statuses:v1',
  ddosAttacks: 'cf:radar:ddos:v1',
  trafficAnomalies: 'cf:radar:traffic-anomalies:v1',
  marketQuotes: 'market:stocks-bootstrap:v1',
  commodityQuotes: 'market:commodities-bootstrap:v1',
  bisPolicy: 'economic:bis:policy:v1',
  bisExchange: 'economic:bis:eer:v1',
  bisCredit: 'economic:bis:credit:v1',
  climateAnomalies: 'climate:anomalies:v2',
  climateDisasters: 'climate:disasters:v1',
  co2Monitoring: 'climate:co2-monitoring:v1',
  oceanIce: 'climate:ocean-ice:v1',
  climateNews: 'climate:news-intelligence:v1',
  radiationWatch: 'radiation:observations:v1',
  wildfires: 'wildfire:fires-bootstrap:v1',
  techReadiness: 'economic:worldbank-techreadiness:v1',
  naturalEvents: 'natural:events:v1',
  cryptoQuotes: 'market:crypto:v1',
  cryptoSectors: 'market:crypto-sectors:v1',
  defiTokens: 'market:defi-tokens:v1',
  aiTokens: 'market:ai-tokens:v1',
  otherTokens: 'market:other-tokens:v1',
  weatherAlerts: 'weather:alerts:v1',
  imdCycloneMarine: 'weather:imd-cyclone-marine:v1',
  liveVideoResolved: 'live-video:resolved:v1',
  // Power grid alerts envelope (scripts/seed-grid-alerts.mjs): ISO/RTO
  // conditions, EIA-930 demand, NWS hazard alerts mapped to grid regions and
  // SWPC geomagnetic state. Opt-in panel + map layer read it on demand.
  gridAlerts: 'energy:grid-alerts:v1',
  nationalDebt: 'economic:national-debt:v1',
  euGasStorage: 'economic:eu-gas-storage:v1',
  eurostatCountryData: 'economic:eurostat-country-data:v1',
  crudeInventories: 'economic:crude-inventories:v1',
  natGasStorage: 'economic:nat-gas-storage:v1',
  ecbFxRates: 'economic:ecb-fx-rates:v1',
  cbrRates: 'economic:cbr-rates:v1',
  fxYoy: 'economic:fx:yoy:v1',
  sharedFxRates: 'shared:fx-rates:v1',
  diseaseOutbreaks: 'health:disease-outbreaks:v1',
  oilStocksAnalysis: 'energy:oil-stocks-analysis:v1',
  lngVulnerability: 'energy:lng-vulnerability:v1',
  pipelinesGas: 'energy:pipelines:gas:v1',
  pipelinesOil: 'energy:pipelines:oil:v1',
  storageFacilities: 'energy:storage-facilities:v1',
});

const SLOW_KEY_NAMES = new Set([
  'bisPolicy', 'bisExchange', 'bisCredit',
  'wildfires', 'climateAnomalies', 'climateDisasters', 'co2Monitoring', 'oceanIce', 'climateNews',
  'radiationWatch',
  'techReadiness',
  'naturalEvents',
  'cryptoQuotes', 'cryptoSectors', 'defiTokens', 'aiTokens', 'otherTokens',
  'nationalDebt',
  'euGasStorage',
  'eurostatCountryData',
  'crudeInventories',
  'natGasStorage',
  'ecbFxRates',
  'diseaseOutbreaks',
  'oilStocksAnalysis',
  'lngVulnerability',
]);

const FAST_KEY_NAMES = new Set([
  'earthquakes', 'outages', 'serviceStatuses', 'ddosAttacks', 'trafficAnomalies',
  'marketQuotes', 'commodityQuotes',
  'weatherAlerts',
]);

const ON_DEMAND_KEY_NAMES = new Set([
  // One row of this feeds the Central Banks tab's policy-rate list, which BIS
  // cannot supply for Russia. On-demand rather than tiered: the tab fetches it
  // through the credential-less per-key URL when it renders, so the ~8KB never
  // rides a payload every visitor downloads.
  'cbrRates',
  // Oil/gas pipeline and storage registries. Previously slow-tier freight:
  // every visitor downloaded ~528 KB decoded even when the map layers were
  // off and the panels were below the fold. Demand comes from an enabled
  // layer or a near-viewport energy panel (#7046).
  'pipelinesGas',
  'pipelinesOil',
  'storageFacilities',
  // Both back the opt-in FX panel (#6199). On-demand rather than tiered
  // because that panel ships disabled by default: neither payload should ride
  // a tier every visitor downloads to render a surface almost nobody has on.
  // NOTE: no apostrophes in this block. scripts/docs-stats.mjs scans these
  // Sets with a bare quote matcher, so one apostrophe in prose opens a phantom
  // string and gets registered as a duplicate key.
  'fxYoy', 'sharedFxRates',
  // IMD cyclone/port/coastal/marine products (#7005). On-demand: the weather
  // and natural layers fetch this key only when those layers are on, so it
  // never rides a payload every visitor downloads.
  'imdCycloneMarine',
  // The video each catalog YouTube channel has live now (#8545), fetched by the
  // live video players at play intent and only for slots that list a channel.
  // The get-bootstrap-data RPC also serves any registered key by name, so the
  // payload stays minimal: channel id to video id and timestamps, no titles,
  // enforced by validateResolvedPayload in scripts/seed-live-video-resolved.mjs.
  'liveVideoResolved',
  // Opt-in Power Grid Alerts panel and map layer: never on a default homepage.
  'gridAlerts',
]);

/**
 * The one tiered key that ALSO has its own credential-less public URL,
 * `?keys=weatherAlerts&public=1` (#5386).
 *
 * Every other single-key public URL is drawn from the on-demand tier, so
 * `bootstrapTierKeyNames('on-demand')` is the shared allowlist. weatherAlerts is
 * the exception: it rides the fast tier, but the map embed fetches it directly
 * (src/services/weather.ts) and that read needs a CDN entry of its own so the
 * BARE `?keys=weatherAlerts` URL — which credentialed callers also use — can
 * stay no-store. Exported so the handler's allowlist (api/bootstrap.js) and the
 * client's credential-less-read guard (src/services/wm-session.ts) name the same
 * key instead of hardcoding it twice.
 */
export const PUBLIC_WEATHER_BOOTSTRAP_KEY = 'weatherAlerts';

function tierForKey(name) {
  if (FAST_KEY_NAMES.has(name)) return 'fast';
  if (SLOW_KEY_NAMES.has(name)) return 'slow';
  if (ON_DEMAND_KEY_NAMES.has(name)) return 'on-demand';
  throw new Error(`Bootstrap cache key "${name}" has no tier assignment`);
}

export const BOOTSTRAP_TIERS = Object.freeze(Object.fromEntries(
  Object.keys(BOOTSTRAP_CACHE_KEYS).map((name) => [name, tierForKey(name)]),
));

/** Return registered logical names in canonical response insertion order. */
export function bootstrapTierKeyNames(tier) {
  if (tier !== 'fast' && tier !== 'slow' && tier !== 'on-demand') {
    throw new TypeError(`Unknown bootstrap tier: ${tier}`);
  }
  return Object.keys(BOOTSTRAP_CACHE_KEYS).filter((name) => BOOTSTRAP_TIERS[name] === tier);
}
