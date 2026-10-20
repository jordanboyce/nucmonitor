import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { USER_API_KEY_GATEWAY_VALIDATION_ERROR, validateApiKey } from './_api-key.js';
import {
  hasPoolCoverageShortfall,
  parsePoolCounts,
  poolCoverageMargins,
} from './_pool-coverage.js';
import { parseRankableRecordCount } from './_rankable-coverage.js';
// Seed-envelope helper. PR 1 imports it here so PR 2 can wire envelope-aware
// reads at specific call sites without further plumbing. It's a no-op on
// legacy-shape seed-meta values (they have no `_seed` wrapper and pass through
// as `.data`), so importing it is behavior-preserving.
import { unwrapEnvelope } from './_seed-envelope.js';
// @ts-expect-error — JS module, no declaration file
import { redisPipeline, applyRedisKeyPrefix, getRedisCredentials, readExistsFlags } from './_upstash-json.js';
import { isAppOwnedRedisKey } from './_redis-key-ownership.js';
import { BOOTSTRAP_CACHE_KEYS } from './_bootstrap-tier-keys.js';
import {
  projectChinaDecisionGroupDiagnostics,
} from './_china-decision-health.js';
import {
  buildContentFreshnessAssessment,
  CONTENT_FRESHNESS_ROLLOUT_UNTIL_MS,
  getActiveContentFreshnessActivationWindow,
  projectContentFreshnessForWire,
} from './_content-freshness.js';
import { assessContentAge } from './_content-age.js';

export const config = { runtime: 'edge' };

// These tags are written into the ranking and interval seed metadata. Public
// health must verify the metadata against this deployment's active scorer
// state; key presence and a recent fetchedAt alone cannot prove that a cron
// refreshed the cache after a formula or education rollback/activation.
const RESILIENCE_INTERVAL_METHODOLOGY = 'weight-perturbation-sensitivity-v3';

function isEnabledEnv(name, defaultValue) {
  return String(process.env[name] ?? defaultValue).toLowerCase() === 'true';
}

function isResiliencePillarCombineEnabled() {
  // Mirrors server/worldmonitor/resilience/v1/_shared.ts exactly: only an
  // explicit normalized `false` selects the rollback formula. Unset and all
  // other values keep the production-default pillar formula active.
  return process.env.RESILIENCE_PILLAR_COMBINE_ENABLED?.trim().toLowerCase() !== 'false';
}

function currentResilienceCacheFormula() {
  return isResiliencePillarCombineEnabled()
    && isEnabledEnv('RESILIENCE_SCHEMA_V2_ENABLED', 'true')
    ? 'pc'
    : 'd6';
}

function currentResilienceEducationState() {
  return isEnabledEnv('RESILIENCE_EDUCATION_ENABLED', 'true')
    ? 'education-on'
    : 'education-off';
}

function assessResilienceCacheState(meta) {
  const formula = meta?._formula === 'pc' || meta?._formula === 'd6'
    ? meta._formula
    : null;
  const educationState = meta?._educationState === 'education-on'
    || meta?._educationState === 'education-off'
    ? meta._educationState
    : null;
  const intervalMethodology = meta?._intervalMethodology === RESILIENCE_INTERVAL_METHODOLOGY
    ? meta._intervalMethodology
    : null;
  const requiredFormula = currentResilienceCacheFormula();
  const requiredEducationState = currentResilienceEducationState();
  return {
    ok: formula === requiredFormula
      && educationState === requiredEducationState
      && intervalMethodology === RESILIENCE_INTERVAL_METHODOLOGY,
    formula,
    requiredFormula,
    educationState,
    requiredEducationState,
    intervalMethodology,
    requiredIntervalMethodology: RESILIENCE_INTERVAL_METHODOLOGY,
  };
}

const CHINA_DECISION_SIGNAL_STATES = new Set([
  'available',
  'partial',
  'stale',
  'unavailable',
]);
// The one unavailable cause that still counts as operational source coverage:
// the upstream answered and had nothing qualifying to report. Must stay in
// lockstep with CHINA_DECISION_SIGNAL_COVERED_UNAVAILABLE_CAUSE in
// scripts/seed-china-decision-signals.mjs, which computes the record count
// this projection explains.
const CHINA_DECISION_HEALTHY_QUIET_CAUSE = 'healthy_quiet_window';

// HTTP responses stay `no-store`, but the expensive Redis-wide verdict is
// shared briefly at the origin. At the measured browser poll rate this turns
// ~390 Redis commands per request into one GET, plus one sweep per minute.
// v2 invalidates pre-#6111 snapshots because they cannot carry the bounded
// content-freshness activation deadline used to decide whether a cache hit is
// still allowed to soften a missing producer block.
const HEALTH_VERDICT_SNAPSHOT_BASE_KEY = 'health:verdict:v2';
function healthVerdictRedisKey(baseKey, vercelEnv, commitSha) {
  if (!vercelEnv || vercelEnv === 'production') return baseKey;
  return `${vercelEnv}:${commitSha?.slice(0, 8) || 'dev'}:${baseKey}`;
}
// How long a STALE_CONTENT diagnosis stays visible without counting toward
// `warn`. Deliberately source-agnostic: it absorbs boundary jitter for a
// publisher that is merely late, and is short next to the per-source
// `maxContentAgeMin` budgets it defers — those budgets, not this constant, are
// what detect a genuine upstream freeze (issue #3845).
//
// The scheduled monitor enforces its own ceiling on the deadlines this mints
// (MAX_STALE_CONTENT_GRACE_MS in scripts/check-seed-freshness.mjs, which adds
// clock-skew slack on top). tests/seed-freshness-monitor.test.mjs pins the two
// together so neither can drift.
const STALE_CONTENT_GRACE_MS = 3 * 60 * 60 * 1_000;
const STALE_CONTENT_GRACE_STATE_KEY = healthVerdictRedisKey(
  'health:stale-content-grace:v1',
  process.env.VERCEL_ENV,
  process.env.VERCEL_GIT_COMMIT_SHA,
);
const HEALTH_VERDICT_SNAPSHOT_KEY = healthVerdictRedisKey(
  HEALTH_VERDICT_SNAPSHOT_BASE_KEY,
  process.env.VERCEL_ENV,
  process.env.VERCEL_GIT_COMMIT_SHA,
);
// The memoized verdict is stored TWICE, and the difference is the whole point.
// The full snapshot carries the entire `checks` map (~228 entries, ~20 KB). The
// compact snapshot carries what `?compact=1` actually returns — status, summary,
// checkedAt and the handful of problem entries — about 1 KB.
//
// `?compact=1` is the browser poll: every client hits it every 5 minutes (~115k
// times/day). Before this split each of those reads pulled the full 20 KB blob out
// of Redis to render ~1 KB of it, which is ~2.2 GB/day of egress for bytes the
// caller throws away (#5300). One sweep writes both keys, so they can never
// disagree.
const HEALTH_VERDICT_COMPACT_SNAPSHOT_BASE_KEY = 'health:verdict:compact:v2';
const HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY = healthVerdictRedisKey(
  HEALTH_VERDICT_COMPACT_SNAPSHOT_BASE_KEY,
  process.env.VERCEL_ENV,
  process.env.VERCEL_GIT_COMMIT_SHA,
);
const HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS = 60;
const HEALTH_VERDICT_SNAPSHOT_TTL_MS = HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS * 1_000;
const HEALTH_VERDICT_REFRESH_LOCK_KEY = `${HEALTH_VERDICT_SNAPSHOT_KEY}:refresh-lock`;
// Bound abandoned ownership. Snapshot publication and release also verify
// the token, because a paused invocation can outlive any fixed lease.
const HEALTH_VERDICT_REFRESH_LOCK_TTL_SECONDS = 30;
const HEALTH_VERDICT_REFRESH_WAIT_ATTEMPTS = 45;
const HEALTH_VERDICT_REFRESH_WAIT_MS = 3_000;
// The last published verdict outlives the 60s snapshot so a request that loses
// the refresh election answers 200 with that verdict, marked `stale`, instead
// of a 503: UptimeRobot, scripts/capture-seed-recovery.mjs and
// scripts/capture-resilience-energy-v2-acceptance.mjs all read any non-2xx as
// down. Only a waiter with no prior verdict at all gets REFRESH_PENDING.
const HEALTH_VERDICT_LAST_KNOWN_KEY = `${HEALTH_VERDICT_SNAPSHOT_KEY}:last-known`;
const HEALTH_VERDICT_COMPACT_LAST_KNOWN_KEY = `${HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY}:last-known`;
const HEALTH_VERDICT_LAST_KNOWN_TTL_SECONDS = 600;
const HEALTH_VERDICT_LAST_KNOWN_READ_TIMEOUT_MS = 2_000;
// Avoid starting a Redis HTTP request that cannot realistically complete
// inside the remaining contention budget. Contention serves the last-known
// verdict (or REFRESH_PENDING without one); only failed Redis operations
// report REDIS_DOWN.
const HEALTH_VERDICT_MIN_REDIS_TIMEOUT_MS = 100;
// One deadline per request, measured from handler entry. Vercel's edge runtime
// must send the first byte within 25 s; with every Redis command running to its
// own timeout the refresh owner's sequential path (snapshot read, lease, sweep,
// contracts/humanitarian proofs, grace claim, relay-gate cache/lease/probe/
// publish, snapshot write) used to take ~55 s. Each of those operations now
// times out at min(its own timeout, what is left of the work budget), and an
// owner that runs out serves the last published verdict as a stale 200. The
// work budget stops early enough for that last-known read to fit, and the whole
// request stays inside the 30 s refresh lease, so the owner answers before its
// lease can lapse. 3 s guard band under the edge limit.
const HEALTH_REQUEST_DEADLINE_MS = 22_000;
const HEALTH_REQUEST_WORK_BUDGET_MS = HEALTH_REQUEST_DEADLINE_MS - HEALTH_VERDICT_LAST_KNOWN_READ_TIMEOUT_MS;

class HealthBudgetExhaustedError extends Error {
  constructor() {
    super('health request deadline exhausted');
    this.name = 'HealthBudgetExhaustedError';
  }
}

function createHealthRequestBudget(startedAt, workBudgetMs = HEALTH_REQUEST_WORK_BUDGET_MS) {
  const workDeadline = startedAt + workBudgetMs;
  const responseDeadline = workDeadline + HEALTH_VERDICT_LAST_KNOWN_READ_TIMEOUT_MS;
  const remaining = () => workDeadline - Date.now();
  return {
    workDeadline,
    remaining,
    // Too little left to start another Redis request that could complete.
    exhausted: () => remaining() < HEALTH_VERDICT_MIN_REDIS_TIMEOUT_MS,
    // The timeout for one operation: its own ceiling or the remaining budget.
    clamp: (timeoutMs) => Math.max(1, Math.min(timeoutMs, remaining())),
    // The stale fallback read gets what is left before the response deadline.
    fallbackTimeout: () => Math.min(HEALTH_VERDICT_LAST_KNOWN_READ_TIMEOUT_MS, responseDeadline - Date.now()),
  };
}
// #6339 deploy-before-provisioning bridge. A production health sweep claims
// this versioned deadline with SET NX, so the 24h window starts when the reader
// actually reaches production rather than when its PR was authored. The key
// deliberately has no TTL: an unprovisioned producer cannot re-enter grace
// after the deadline by waiting for rollout state to expire.
const RUNTIME_ROLLOUT_PENDING_POLICIES = Object.freeze({
  fredRatesSeeder: Object.freeze({
    deadlineKey: 'health:rollout-deadline:economic:fred-rates:v1',
    durationMs: 24 * 60 * 60 * 1_000,
  }),
});
const FRED_RATES_ROLLOUT_DEADLINE_KEY = RUNTIME_ROLLOUT_PENDING_POLICIES.fredRatesSeeder.deadlineKey;
const FRED_RATES_ROLLOUT_DURATION_MS = RUNTIME_ROLLOUT_PENDING_POLICIES.fredRatesSeeder.durationMs;
const HEALTH_VERDICT_RELEASE_LOCK_SCRIPT = [
  "if redis.call('get', KEYS[1]) == ARGV[1] then",
  "  return redis.call('del', KEYS[1])",
  'end',
  'return 0',
].join('\n');

// Fence publication as well as release: a paused owner can resume after its
// lease expired and a successor already published a newer verdict.
// The same fenced write refreshes the last-known copies (KEYS[4], KEYS[5]),
// so a stale fallback is always a verdict some lease owner published.
const HEALTH_VERDICT_WRITE_SNAPSHOT_SCRIPT = [
  "if redis.call('get', KEYS[1]) ~= ARGV[1] then return nil end",
  "redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[4])",
  "redis.call('set', KEYS[3], ARGV[3], 'EX', ARGV[4])",
  "redis.call('set', KEYS[4], ARGV[2], 'EX', ARGV[5])",
  "redis.call('set', KEYS[5], ARGV[3], 'EX', ARGV[5])",
  "return 'OK'",
].join('\n');

const HEALTH_VERDICT_MUTATION_SCRIPT = [
  "if redis.call('get', KEYS[1]) ~= ARGV[1] then return nil end",
  "return redis.call(ARGV[2], KEYS[2], unpack(ARGV, 3))",
].join('\n');
const HEALTH_REFRESH_MUTATIONS = new Set(['SET', 'DEL', 'HSETNX', 'HDEL', 'PEXPIRE', 'LPUSH', 'LTRIM', 'EXPIRE']);

// All callers provide final keys: seeder-owned rollout state stays raw while
// route-owned grace/history keys carry this deployment's prefix exactly once.
function fenceHealthMutations(commands, token) {
  return commands.map(([op, key, ...args]) => HEALTH_REFRESH_MUTATIONS.has(op)
    ? ['EVAL', HEALTH_VERDICT_MUTATION_SCRIPT, '2', HEALTH_VERDICT_REFRESH_LOCK_KEY, key, token, op, ...args]
    : [op, key, ...args]);
}

const BOOTSTRAP_KEYS = {
  earthquakes:       'seismology:earthquakes:v1',
  outages:           'infra:outages:v1',
  sectors:           'market:sectors:v2',
  climateAnomalies:  'climate:anomalies:v2',
  climateDisasters:  'climate:disasters:v1',
  climateAirQuality: 'climate:air-quality:v1',
  co2Monitoring:     'climate:co2-monitoring:v1',
  oceanIce:          'climate:ocean-ice:v1',
  wildfires:         'wildfire:fires:v1',
  wildfiresBootstrap: 'wildfire:fires-bootstrap:v1',
  marketQuotes:      'market:stocks-bootstrap:v1',
  commodityQuotes:   'market:commodities-bootstrap:v1',
  techReadiness:     'economic:worldbank-techreadiness:v1',
  progressData:      'economic:worldbank-progress:v1',
  renewableEnergy:   'economic:worldbank-renewable:v1',
  naturalEvents:     'natural:events:v1',
  newsInsights:      'news:insights:v1',
  cryptoQuotes:      'market:crypto:v1',
  weatherAlerts:     'weather:alerts:v1',
  radiationWatch:    'radiation:observations:v1',
  faoFoodPriceIndex: 'economic:fao-ffpi:v1',
  nationalDebt:      'economic:national-debt:v1',
  defiTokens:        'market:defi-tokens:v1',
  aiTokens:          'market:ai-tokens:v1',
  otherTokens:       'market:other-tokens:v1',
  fredBatch:         'economic:fred:v1:FEDFUNDS:0',
  ecbEstr:           'economic:fred:v1:ESTR:0',
  ecbEuribor3m:      'economic:fred:v1:EURIBOR3M:0',
  ecbEuribor6m:      'economic:fred:v1:EURIBOR6M:0',
  ecbEuribor1y:      'economic:fred:v1:EURIBOR1Y:0',
  euYieldCurve:      'economic:yield-curve-eu:v1',
  crudeInventories:  'economic:crude-inventories:v1',
  natGasStorage:     'economic:nat-gas-storage:v1',
  spr:               'economic:spr:v1',
  refineryInputs:    'economic:refinery-inputs:v1',
  ecbFxRates:        'economic:ecb-fx-rates:v1',
  eurostatCountryData: 'economic:eurostat-country-data:v1',
  eurostatHousePrices: 'economic:eurostat:house-prices:v1',
  eurostatGovDebtQ:    'economic:eurostat:gov-debt-q:v1',
  eurostatIndProd:     'economic:eurostat:industrial-production:v1',
  euGasStorage:      'economic:eu-gas-storage:v1',
  euFsi:             'economic:fsi-eu:v1',
  diseaseOutbreaks:  'health:disease-outbreaks:v1',
  healthAirQuality:  'health:air-quality:v1',
  vpdTrackerRealtime:   'health:vpd-tracker:realtime:v1',
  vpdTrackerHistorical: 'health:vpd-tracker:historical:v1',
  electricityPrices:    'energy:electricity:v1:index',
  gasStorageCountries: 'energy:gas-storage:v1:_countries',
  cryptoSectors:       'market:crypto-sectors:v1',
  ddosAttacks:         'cf:radar:ddos:v1',
  trafficAnomalies:    'cf:radar:traffic-anomalies:v1',
};

const STANDALONE_KEYS = {
  imdCycloneMarine:   'weather:imd-cyclone-marine:v1',
  // Seeded by seed-live-video-resolved (#8545); read by the live video players
  // through the on-demand bootstrap URL. Strict once activated (SEED_META).
  liveVideoResolved: BOOTSTRAP_CACHE_KEYS.liveVideoResolved,
  // #4920 completeness measurement (daily GH Actions publishers) — ops
  // keys: health-monitored but NOT bootstrap-hydrated into page loads.
  newsFeedHealth:    'news:feed-health:v1',
  serviceStatuses:       'infra:service-statuses:v1',
  macroSignals:          'economic:macro-signals:v1',
  energyPrices:          'economic:energy:v1:all',
  bisPolicy:             'economic:bis:policy:v1',
  bisExchange:           'economic:bis:eer:v1',
  fxYoy:                 'economic:fx:yoy:v1',
  sharedFxRates:          'shared:fx-rates:v1',
  // Operational batch written by seed-fred-rates. The UI and MCP surfaces
  // consume the individual FRED series keys, not this producer envelope.
  fredRatesSeeder:        'economic:fred:batch:v1',
  bisCredit:             'economic:bis:credit:v1',
  bisDsr:                'economic:bis:dsr:v1',
  // Bank of Russia official rates: health-monitored but deliberately NOT a
  // bootstrap key. Its dashboard consumer (the FX panel's RUB tab, #6231)
  // reads it on demand through the credential-less per-key bootstrap URL, so
  // registering it in a tier would add ~6KB to a payload every client
  // downloads and only the opt-in panel consumes.
  cbrRates:              'economic:cbr-rates:v1',
  bocValet:              'economic:boc-valet:v1',
  statcanWds:            'economic:statcan-wds:v1',
  bisPropertyResidential: 'economic:bis:property-residential:v1',
  bisPropertyCommercial:  'economic:bis:property-commercial:v1',
  imfMacro:             'economic:imf:macro:v2',
  // plan 2026-04-25-004 Phase 2: financialSystemExposure data keys.
  wbExternalDebt:       'economic:wb-external-debt:v1',
  bisLbs:               'economic:bis-lbs:v1',
  climateZoneNormals:    'climate:zone-normals:v1',
  cableHealth:           'cable-health-v1',
  submarineCables:       'infrastructure:submarine-cables:v1',
  temporalAnomalies:     'temporal:anomalies:v1',
  // Meta-only probes. The CPI and par-curve documents are sharded, and the
  // canonical curve is large enough to time out a health GET.
  usCpiMonthly:          'seed-meta:economic:us-cpi',
  usTreasuryParYield:    'seed-meta:economic:us-treasury-par-yield',
  usInterestRates:       'seed-meta:economic:us-interest-rates',
  // #8538. One probe per worldwide CPI source. The canonical keys are 115 KB –
  // 1 MB and the read path pipelines four of them, so health reads the
  // seed-meta keys instead of paying for the full payloads.
  worldCpiImf:           'seed-meta:economic:world-cpi-imf',
  worldCpiEurostat:      'seed-meta:economic:world-cpi-eurostat',
  worldCpiEstat:         'seed-meta:economic:world-cpi-estat',
  worldCpiAbs:           'seed-meta:economic:world-cpi-abs',
  // Meta-only probes for the yield-curve bundle. Every market's history is
  // sharded per year; the canonical payloads are too large to probe directly.
  yieldCurveJp:          'seed-meta:economic:yield-curve-jp',
  yieldCurveCa:          'seed-meta:economic:yield-curve-ca',
  yieldCurveDe:          'seed-meta:economic:yield-curve-de',
  yieldCurveGb:          'seed-meta:economic:yield-curve-gb',
  yieldCurveAu:          'seed-meta:economic:yield-curve-au',
  yieldCurveCh:          'seed-meta:economic:yield-curve-ch',
  yieldCurveNo:          'seed-meta:economic:yield-curve-no',
  yieldCurveSe:          'seed-meta:economic:yield-curve-se',
  oecdLtRates:           'seed-meta:economic:oecd-lt-rates',
  forecastFredWalcl:        'economic:fred:v1:WALCL:0',
  forecastFredT10y2y:       'economic:fred:v1:T10Y2Y:0',
  forecastFredUnrate:       'economic:fred:v1:UNRATE:0',
  forecastFredCpiaucsl:     'economic:fred:v1:CPIAUCSL:0',
  forecastFredDgs10:        'economic:fred:v1:DGS10:0',
  forecastFredVixcls:       'economic:fred:v1:VIXCLS:0',
  forecastFredGdp:          'economic:fred:v1:GDP:0',
  forecastFredM2sl:         'economic:fred:v1:M2SL:0',
  forecastFredDcoilwtico:   'economic:fred:v1:DCOILWTICO:0',
  climateNews:              'climate:news-intelligence:v1',
  energySpineCountries:     'energy:spine:v1:_countries',
  energyMixAll:             'energy:mix:v1:_all',
  ieaOilStocks:             'energy:iea-oil-stocks:v1:index',
  oilStocksAnalysis:        'energy:oil-stocks-analysis:v1',
  eiaPetroleum:             'energy:eia-petroleum:v1',
  jodiGas:                  'energy:jodi-gas:v1:_countries',
  lngVulnerability:         'energy:lng-vulnerability:v1',
  jodiOil:                  'energy:jodi-oil:v1:_countries',
  emberElectricity:         'energy:ember:v1:_all',
  pipelinesGas:             'energy:pipelines:gas:v1',
  pipelinesOil:             'energy:pipelines:oil:v1',
  storageFacilities:        'energy:storage-facilities:v1',
  fuelShortages:            'energy:fuel-shortages:v1',
  goldEtfFlows:             'market:gold-etf-flows:v1',
  goldCbReserves:           'market:gold-cb-reserves:v1',
  climateNewsRelayHeartbeat:     'relay:heartbeat:climate-news',
  // Bundle tick heartbeat written by `_bundle-runner.mjs` on every container
  // start, including skip-all ticks. Detects Railway cron-scheduler freeze
  // (#6691) that member seed-meta budgets (17.5d+) cannot see.
  staticRefBundleTick:           'bundle:heartbeat:static-ref',
  digestNotifications:           'digest:last-run',
  webcams:                       'webcam:cameras:active',
};


const SEED_META = {
  earthquakes: {
    key: 'seed-meta:seismology:earthquakes', maxStaleMin: 30,
    sourceFailure: {
      warnAfterConsecutive: 2, maxPendingMin: 10,
      successAtField: 'lastSourceSuccessAt',
      failureCodePattern: /^EARTHQUAKE_UPSTREAM_INCOMPLETE$/,
    },
  },
  wildfires:        {
    key: 'seed-meta:wildfire:fires',
    maxStaleMin: 360,
    sourceFailure: [
      { warnAfterConsecutive: 2, failureCodePattern: /^FIRMS_PARTIAL_COVERAGE$/ },
      {
        warnAfterConsecutive: 3, maxPendingMin: 180,
        successAtField: 'lastSourceSuccessAt',
        sources: ['cwfis', 'firms', 'bc'],
        failureCodePattern: /^CWFIS_SOURCE_FAILED$/,
      },
    ],
  }, // FIRMS NRT resets at midnight UTC; new-day data takes 3-6h to accumulate
  wildfiresBootstrap: { key: 'seed-meta:wildfire:fires-bootstrap', maxStaleMin: 360 }, // Compact CDN payload is a distinct publish target; monitor it so canonical fallback cannot hide transform/write failures.
  outages:          { key: 'seed-meta:infra:outages',           maxStaleMin: 30 },
  // seed-live-video-resolved cron `0 */6 * * *` (#8545); 1080 = 3× cadence per
  // project convention. The PR registers the probe before the Railway service
  // exists, so it softens to EMPTY_ON_DEMAND only until the seeder's first
  // publish writes the activation marker; from then on it is strict forever
  // (EMPTY / STALE_SEED). Not in EMPTY_DATA_OK_KEYS: a dead cron must alarm.
  liveVideoResolved: {
    key: 'seed-meta:live-video:resolved',
    maxStaleMin: 1080,
    activationKey: 'seed-activated:live-video:resolved',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8545,
      activationKey: 'seed-activated:live-video:resolved',
    },
  },
  climateAnomalies: { key: 'seed-meta:climate:anomalies',       maxStaleMin: 540 }, // bundled into seed-bundle-climate (cron `0 */3 * * *`, every 3h); 540 = 3× cron cadence per project convention. Prior 240 (1.33× cron) flipped to silent-EMPTY between minute 180 (TTL_DATA expiry) and 240 (alarm trigger) on every routine cron-jitter cycle — see scripts/seed-climate-anomalies.mjs CACHE_TTL comment.
  climateDisasters: { key: 'seed-meta:climate:disasters',       maxStaleMin: 720 }, // runs every 6h; 720min = 2x interval
  climateAirQuality:{ key: 'seed-meta:health:air-quality',      maxStaleMin: 180 }, // hourly cron; 180 = 3x interval — shares meta key with healthAirQuality (same seeder run)
  climateZoneNormals: { key: 'seed-meta:climate:zone-normals',  maxStaleMin: 89280 }, // monthly cron on the 1st; 62d = 2x 31-day cadence
  co2Monitoring:    { key: 'seed-meta:climate:co2-monitoring',  maxStaleMin: 4320 }, // daily cron at 06:00 UTC; 72h tolerates two missed runs
  oceanIce:         { key: 'seed-meta:climate:ocean-ice',       maxStaleMin: 2880 }, // daily cron at 08:00 UTC; 48h = 2× interval, tolerates one missed run
  climateNews:      { key: 'seed-meta:climate:news-intelligence', maxStaleMin: 90 }, // relay loop every 30min; 90 = 3× interval
  cryptoQuotes:     { key: 'seed-meta:market:crypto',           maxStaleMin: 30 },
  stablecoinMarkets:{ key: 'seed-meta:market:stablecoins',      maxStaleMin: 60 },
  naturalEvents:    {
    key: 'seed-meta:natural:events',
    maxStaleMin: 540, // 3h Railway climate bundle; 3x cadence preserves a full missed run.
    sourceFailure: {
      warnAfterConsecutive: 2,
      maxPendingMin: 210,
      successAtField: 'lastSourceSuccessAt',
      failureCodePattern: /^NHC_(POINT_REQUEST_FAILED|POINT_RESPONSE_INVALID)$/,
    },
  },
  newsInsights:     {
    key: 'seed-meta:news:insights',
    maxStaleMin: 30,
    // `fetchedAt` is deliberately held at the served LKG timestamp when a
    // synthesis is rejected. This separate bounded contract warns before the
    // generic 30-minute seed-age gate when repeated attempts keep failing.
    synthesisFailure: {
      warnAfterConsecutive: 2,
      warnAfterAgeMin: 20,
      warnWithoutSuccess: true,
      // Declared explicitly rather than relying on readSeedMeta's fallback:
      // an omitted pattern silently DROPS every code the producer writes, so
      // the contract is only safe if each key names its own vocabulary. A test
      // asserts every synthesisFailure entry declares one.
      //
      // #5947: the LEAD_* codes and COMPOSER_ERROR name WHICH editorial gate
      // rejected the synthesis — GATE stays as the producer's residual bucket.
      // This list is the second source of truth for that vocabulary, and an
      // unmatched code is dropped SILENTLY, so widening the seeder's codes
      // without widening this makes them invisible in health. A test asserts
      // every INSIGHTS_SYNTHESIS_FAILURE_CODES value matches this pattern.
      failureCodePattern:
        /^INSIGHTS_SYNTHESIS_(PARSE|GATE|MISSING_CLUSTER|PROVIDER|COMPOSER_ERROR|LEAD_(EMPTY|UNCITED|PROPER_NOUN|NUMERIC_FACT|STATUS_QUALIFIER|GROUNDING))$/,
    },
  },
  // #4920: daily GH Actions cadence; 2880 = 2x — one fully missed day alarms
  newsFeedHealth:   { key: 'seed-meta:news:feed-health',        maxStaleMin: 2880 },
  marketQuotes:     { key: 'seed-meta:market:stocks',         maxStaleMin: 30 },
  // #6235: the country-index RPC is seeded for every serviceable country in the
  // enum. The seeding pass is deliberately best-effort (one country's provider
  // failure must not cost the others their refresh) and therefore never
  // throws — so without this entry a run where every country failed would leave
  // seed-meta:market:stocks fresh and health green while the country caches
  // expired and the RPC silently reverted to per-request Yahoo fetches.
  // #6240: countries whose Yahoo symbol is dead carry `unavailable` in
  // shared/openapi-filter-param-contracts.json and are not seeded (38 of 45 as
  // of 2026-09-13). 30 leaves headroom for 8 transient failures;
  // tests/country-stock-index-health.test.mjs keeps it below the seedable count.
  countryStockIndexes: { key: 'seed-meta:market:country-indexes', maxStaleMin: 30, minRecordCount: 30 },
  commodityQuotes:  { key: 'seed-meta:market:commodities',    maxStaleMin: 30 },
  goldEtfFlows:     { key: 'seed-meta:market:gold-etf-flows', maxStaleMin: 2880 }, // SPDR publishes daily; 2× = 48h tolerance
  goldCbReserves:   { key: 'seed-meta:market:gold-cb-reserves', maxStaleMin: 44640 }, // IMF IFS is monthly w/ ~2-3mo lag; 31d tolerance
  // RPC/warm-ping keys — seed-meta written by relay loops or handlers
  // serviceStatuses: moved to ON_DEMAND — RPC-populated, no dedicated seed, goes stale when no users visit
  cableHealth:      { key: 'seed-meta:cable-health',              maxStaleMin: 90 }, // ais-relay warm-ping runs every 30min; 90min = 3× interval catches missed pings without false positives
  submarineCables:  { key: 'seed-meta:infrastructure:submarine-cables', maxStaleMin: 25200 },
  macroSignals:     { key: 'seed-meta:economic:macro-signals',    maxStaleMin: 150 }, // seed-economy afterPublish-derived stress/macro key
  energyPrices:     { key: 'seed-meta:economic:energy-prices',    maxStaleMin: 150 }, // seed-economy primary runSeed resource
  bisPolicy:        { key: 'seed-meta:economic:bis',              maxStaleMin: 10080 }, // runSeed('economic','bis',...) writes seed-meta:economic:bis
  // seed-bis-extended.mjs is a child-process section spawned by
  // scripts/seed-bundle-macro.mjs. The bundle's Railway cron fires more
  // often than the per-section `intervalMs: 12 * HOUR` gate (production
  // logs 2026-04-26T08:00:45 show "BIS-Extended Skipped, last seeded
  // 175min ago, interval: 720min" — gate actively load-bearing on every
  // bundle tick). So the EFFECTIVE write cadence is governed by the 12h
  // gate, not the bundle cron. Per-dataset seed-meta is only written when
  // THAT dataset published fresh entries — so a single-dataset BIS outage
  // (e.g. WS_DSR 500s) goes STALE in health without dragging down the
  // healthy ones.
  //
  // The previous 1440 (= 2× the 12h gate, but only 1× the actual rolled-up
  // cadence after typical cron drift) had ZERO grace. All three keys
  // flipped to STALE_SEED synchronously at minute 1442 on 2026-04-27
  // (gate-eligible run delayed by ~24h after one failed intermediate cron).
  // 2160min = 3× the 12h gate covers cron drift + one degraded-to-24h
  // cycle, fires within 36h on a real outage.
  bisDsr:                { key: 'seed-meta:economic:bis-dsr',                  maxStaleMin: 2160 },
  bisPropertyResidential:{ key: 'seed-meta:economic:bis-property-residential', maxStaleMin: 2160 },
  bisPropertyCommercial: { key: 'seed-meta:economic:bis-property-commercial',  maxStaleMin: 2160 },
  imfMacro:         { key: 'seed-meta:economic:imf-macro',        maxStaleMin: 100800 }, // monthly seed; 100800min = 70 days = 2× interval (absorbs one missed run)
  // plan 2026-04-25-004 Phase 2: financialSystemExposure component seeders.
  // Bundle: scripts/seed-bundle-macro.mjs (Codex R1 #5, Option A).
  wbExternalDebt:   { key: 'seed-meta:economic:wb-external-debt', maxStaleMin: 100800 }, // annual WB IDS publication; 70d threshold matches IMF cadence pattern
  bisLbs:           { key: 'seed-meta:economic:bis-lbs',          maxStaleMin: 14400 }, // BIS LBS quarterly publication; 10d threshold = ~1× publish lag tolerance after macro bundle daily refresh
  // minerals + giving: on-demand cachedFetchJson only, no seed-meta writer — freshness checked via TTL
  // bisExchange + bisCredit: extras written by same BIS script via writeExtraKey, no dedicated seed-meta
  fxYoy:            { key: 'seed-meta:economic:fx-yoy',           maxStaleMin: 1500 }, // daily cron; 25h tolerance + 1h drift
  sharedFxRates:    { key: 'seed-meta:shared:fx-rates',           maxStaleMin: 3600 }, // daily seed; 60h tolerance covers a missed 25h cache refresh
  positiveGeoEvents:{ key: 'seed-meta:positive-events:geo',       maxStaleMin: 60 },
  temporalAnomalies:{ key: 'seed-meta:temporal:anomalies',          maxStaleMin: 45 }, // rebuild-stamped ONLY (TEMPORAL_ANOMALIES_REBUILD_AFTER_MS=20min in infrastructure/v1/_shared.ts) — only producer-route traffic can rebuild and refresh this request-driven stamp, so a traffic lull can age it past 45min; 45min leaves ~2.25x margin. Data TTL is 60min so health reaches STALE_SEED before EMPTY. Content freshness is a separate clock: the producer stamps newestItemAt/maxContentAgeMin from all five COUNT_SOURCE_KEYS payloads (news, FIRMS, military flights, theater-posture vessels, AIS gaps — TEMPORAL_ANOMALIES_MAX_CONTENT_AGE_MIN); a frozen-but-200 upstream keeps fetchedAt fresh and reads STALE_CONTENT.
  weatherAlerts: {
    key: 'seed-meta:weather:alerts', maxStaleMin: 45,
    sourceFailure: {
      warnAfterConsecutive: 2, maxPendingMin: 20,
      successAtField: 'lastSourceSuccessAt',
      failureCodePattern: /^WEATHER_ALERT_SOURCE_INCOMPLETE$/,
      sources: ['nws', 'eccc', 'swic'],
    },
  },
  // Public-bulletin seeder (#7005, #7730). This is an activation-marker cutover
  // rather than a 24h expiring acknowledgement.
  // Softening stays on-demand until the durable marker is written.
  imdCycloneMarine: {
    key: 'seed-meta:weather:imd-cyclone-marine',
    maxStaleMin: 45, // 3× the live */15 Railway cron
    activationKey: 'seed-activated:weather:imd-cyclone-marine:v2',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 7005,
      activationKey: 'seed-activated:weather:imd-cyclone-marine:v2',
    },
  },
  digestNotifications: { key: 'seed-meta:digest:last-run',          maxStaleMin: 90 }, // Railway digest-notifications cron runs every 30min; 90 = 3x cadence and detects a dead cron before daily digests are missed.
  sectors:          { key: 'seed-meta:market:sectors',             maxStaleMin: 30 },
  techReadiness:    { key: 'seed-meta:economic:worldbank-techreadiness:v1', maxStaleMin: 10080 },
  progressData:     { key: 'seed-meta:economic:worldbank-progress:v1',     maxStaleMin: 10080 },
  renewableEnergy:  { key: 'seed-meta:economic:worldbank-renewable:v1',    maxStaleMin: 10080 },
  radiationWatch:      { key: 'seed-meta:radiation:observations',             maxStaleMin: 30 },
  faoFoodPriceIndex:   { key: 'seed-meta:economic:fao-ffpi',                  maxStaleMin: 86400 }, // monthly seed; 86400 = 60 days (2x interval)
  nationalDebt:        { key: 'seed-meta:economic:national-debt',              maxStaleMin: 86400 }, // monthly seed (seed-bundle-macro intervalMs: 30 * DAY); 60d = 2x interval absorbs one missed run. Prior 10080 (7d) was narrower than the cron interval so every cron past day 7 alarmed STALE_SEED.
  // defiTokens/aiTokens/otherTokens all share one seed run (seed-token-panels cron, every 30min)
  defiTokens:        { key: 'seed-meta:market:token-panels', maxStaleMin: 90 },
  aiTokens:          { key: 'seed-meta:market:token-panels', maxStaleMin: 90 },
  otherTokens:       { key: 'seed-meta:market:token-panels', maxStaleMin: 90 },
  fredBatch:         { key: 'seed-meta:economic:fred:v1:FEDFUNDS:0', maxStaleMin: 1500 }, // daily cron
  fredRatesSeeder:   { key: 'seed-meta:economic:fred-rates', maxStaleMin: 180, minRecordCount: 24 }, // independent hourly FRED/rates seeder; publication accepts 18/24, but health requires full consumer coverage
  forecastFredWalcl:      { key: 'seed-meta:economic:fred:v1:WALCL:0',      maxStaleMin: 1500 },
  forecastFredT10y2y:     { key: 'seed-meta:economic:fred:v1:T10Y2Y:0',     maxStaleMin: 1500 },
  forecastFredUnrate:     { key: 'seed-meta:economic:fred:v1:UNRATE:0',     maxStaleMin: 1500 },
  forecastFredCpiaucsl:   { key: 'seed-meta:economic:fred:v1:CPIAUCSL:0',   maxStaleMin: 1500 },
  forecastFredDgs10:      { key: 'seed-meta:economic:fred:v1:DGS10:0',      maxStaleMin: 1500 },
  forecastFredVixcls:     { key: 'seed-meta:economic:fred:v1:VIXCLS:0',     maxStaleMin: 1500 },
  forecastFredGdp:        { key: 'seed-meta:economic:fred:v1:GDP:0',        maxStaleMin: 1500 },
  forecastFredM2sl:       { key: 'seed-meta:economic:fred:v1:M2SL:0',       maxStaleMin: 1500 },
  forecastFredDcoilwtico: { key: 'seed-meta:economic:fred:v1:DCOILWTICO:0', maxStaleMin: 1500 },
  ecbEstr:           { key: 'seed-meta:economic:ecb-short-rates',   maxStaleMin: 4320 }, // daily ECB publish; 4320min = 3d = TTL/interval
  ecbEuribor3m:      { key: 'seed-meta:economic:ecb-short-rates',   maxStaleMin: 4320 }, // shared meta key with ecbEstr
  ecbEuribor6m:      { key: 'seed-meta:economic:ecb-short-rates',   maxStaleMin: 4320 }, // shared meta key with ecbEstr
  ecbEuribor1y:      { key: 'seed-meta:economic:ecb-short-rates',   maxStaleMin: 4320 }, // shared meta key with ecbEstr
  crudeInventories:  { key: 'seed-meta:economic:crude-inventories',   maxStaleMin: 20160 }, // weekly EIA data; 20160min = 14 days = 2x weekly cadence
  natGasStorage:     { key: 'seed-meta:economic:nat-gas-storage',     maxStaleMin: 20160 }, // weekly EIA data; 20160min = 14 days = 2x weekly cadence
  spr:               { key: 'seed-meta:economic:spr',                 maxStaleMin: 20160 }, // weekly EIA data; 20160min = 14 days = 2x weekly cadence
  refineryInputs:    { key: 'seed-meta:economic:refinery-inputs',     maxStaleMin: 20160 }, // weekly EIA data; 20160min = 14 days = 2x weekly cadence
  ecbFxRates:        { key: 'seed-meta:economic:ecb-fx-rates',        maxStaleMin: 5760 }, // daily seed (weekdays + holidays); 5760min = 96h = covers Wed→Mon Easter gap
  // daily seed (seed-bundle-macro); 4320min = 72h = 3x interval, and below the 4d
  // canonical TTL so the key outlives its own gate. minRecordCount mirrors
  // MIN_RATE_COUNT in scripts/seed-cbr-rates.mjs (30 currencies + the key rate):
  // a truncated cbr.ru body still parses into a handful of well-formed rows, so
  // a shrunken table must surface as COVERAGE_PARTIAL rather than OK.
  cbrRates:          { key: 'seed-meta:economic:cbr-rates',           maxStaleMin: 4320, minRecordCount: 31 },
  bocValet:          {
    key: 'seed-meta:economic:boc-valet',
    maxStaleMin: 4320,
    minRecordCount: 19,
    cutover: {
      mode: 'expiring-ack',
      fromKey: null,
      issue: 6616,
      status: 'EMPTY',
    },
  }, // daily seed-bundle-macro 08:00 UTC; 4320min = 3x interval. minRecordCount = 15 FX pairs + policy rate + 2y/5y/10y yields.
  statcanWds:        {
    key: 'seed-meta:economic:statcan-wds',
    maxStaleMin: 4320,
    minRecordCount: 2,
    cutover: {
      mode: 'expiring-ack',
      fromKey: null,
      issue: 6676,
      status: 'EMPTY',
    },
  }, // daily seed-bundle-macro 08:00 UTC. Toronto-today 409 "not released yet" is quiet like 404; CPI/LFS still POST. First-publish EMPTY ack #6676 retired after recovery. Floor is the two resilience cubes (CPI YoY + LFS).
  eurostatCountryData: { key: 'seed-meta:economic:eurostat-country-data', maxStaleMin: 4320 }, // daily seed; 4320min = 3 days = 3x interval
  eurostatHousePrices: { key: 'seed-meta:economic:eurostat-house-prices', maxStaleMin: 60 * 24 * 50 }, // weekly cron, annual data; 50d threshold = 35d TTL + 15d buffer
  eurostatGovDebtQ:    { key: 'seed-meta:economic:eurostat-gov-debt-q',   maxStaleMin: 60 * 24 * 14 }, // 2d cron, quarterly data; 14d threshold matches TTL + quarterly release drift
  eurostatIndProd:     { key: 'seed-meta:economic:eurostat-industrial-production', maxStaleMin: 60 * 24 * 5 }, // daily cron, monthly data; 5d threshold matches TTL
  euGasStorage:      { key: 'seed-meta:economic:eu-gas-storage',      maxStaleMin: 2880 }, // daily seed (T+1); 2880min = 48h = 2x interval
  euYieldCurve:      { key: 'seed-meta:economic:yield-curve-eu',      maxStaleMin: 4320 }, // daily seed (weekdays only); 4320min = 72h = covers Fri→Mon gap
  usCpiMonthly: {
    key: 'seed-meta:economic:us-cpi',
    maxStaleMin: 4320, // daily macro-bundle tail; 72h covers one missed tick. CPI content age is separate.
    activationKey: 'seed-activated:economic:us-cpi',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8480,
      activationKey: 'seed-activated:economic:us-cpi',
    },
  },
  usTreasuryParYield: {
    key: 'seed-meta:economic:us-treasury-par-yield',
    maxStaleMin: 4320, // daily macro-bundle tail; 72h covers one missed tick. Curve content age is separate.
    activationKey: 'seed-activated:economic:us-treasury-par-yield',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8480,
      activationKey: 'seed-activated:economic:us-treasury-par-yield',
    },
  },
  usInterestRates: {
    key: 'seed-meta:economic:us-interest-rates',
    maxStaleMin: 4320, // daily macro-bundle tail; 72h covers one missed tick. DFF content age is separate.
    activationKey: 'seed-activated:economic:us-interest-rates',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8485,
      activationKey: 'seed-activated:economic:us-interest-rates',
    },
  },
  // #8538. Worldwide CPI sources. Each is a macro-bundle tail section on a
  // daily interval, so 72h covers one missed tick; content age is the tighter
  // clock and is declared per seeder (IMF 120d, Eurostat 120d,
  // e-Stat 120d, ABS 400d) because their publication lags differ structurally.
  worldCpiImf: {
    key: 'seed-meta:economic:world-cpi-imf',
    maxStaleMin: 4320,
    activationKey: 'seed-activated:economic:world-cpi-imf',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8538,
      activationKey: 'seed-activated:economic:world-cpi-imf',
    },
  },
  worldCpiEurostat: {
    key: 'seed-meta:economic:world-cpi-eurostat',
    maxStaleMin: 4320,
    activationKey: 'seed-activated:economic:world-cpi-eurostat',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8538,
      activationKey: 'seed-activated:economic:world-cpi-eurostat',
    },
  },
  worldCpiEstat: {
    key: 'seed-meta:economic:world-cpi-estat',
    maxStaleMin: 4320,
    activationKey: 'seed-activated:economic:world-cpi-estat',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8538,
      activationKey: 'seed-activated:economic:world-cpi-estat',
    },
  },
  worldCpiAbs: {
    key: 'seed-meta:economic:world-cpi-abs',
    maxStaleMin: 4320,
    activationKey: 'seed-activated:economic:world-cpi-abs',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8538,
      activationKey: 'seed-activated:economic:world-cpi-abs',
    },
  },
  yieldCurveJp: {
    key: 'seed-meta:economic:yield-curve-jp',
    maxStaleMin: 4320, // daily business-day source; 72h covers the Fri→Mon gap. Curve content age is separate.
    activationKey: 'seed-activated:economic:yield-curve-jp',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8522,
      activationKey: 'seed-activated:economic:yield-curve-jp',
    },
  },
  yieldCurveCa: {
    key: 'seed-meta:economic:yield-curve-ca',
    maxStaleMin: 4320,
    activationKey: 'seed-activated:economic:yield-curve-ca',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8522,
      activationKey: 'seed-activated:economic:yield-curve-ca',
    },
  },
  yieldCurveDe: {
    key: 'seed-meta:economic:yield-curve-de',
    maxStaleMin: 4320,
    activationKey: 'seed-activated:economic:yield-curve-de',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8522,
      activationKey: 'seed-activated:economic:yield-curve-de',
    },
  },
  // The GB cold start (39 MB BoE archive) can be budget-deferred behind the
  // 570s bundle budget; 4460min still sits inside the 7d canonical TTL.
  yieldCurveGb: {
    key: 'seed-meta:economic:yield-curve-gb',
    maxStaleMin: 4460,
    activationKey: 'seed-activated:economic:yield-curve-gb',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8522,
      activationKey: 'seed-activated:economic:yield-curve-gb',
    },
  },
  yieldCurveAu: {
    key: 'seed-meta:economic:yield-curve-au',
    maxStaleMin: 4460,
    activationKey: 'seed-activated:economic:yield-curve-au',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8522,
      activationKey: 'seed-activated:economic:yield-curve-au',
    },
  },
  yieldCurveCh: {
    key: 'seed-meta:economic:yield-curve-ch',
    maxStaleMin: 4460,
    activationKey: 'seed-activated:economic:yield-curve-ch',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8522,
      activationKey: 'seed-activated:economic:yield-curve-ch',
    },
  },
  yieldCurveNo: {
    key: 'seed-meta:economic:yield-curve-no',
    maxStaleMin: 4320,
    activationKey: 'seed-activated:economic:yield-curve-no',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8522,
      activationKey: 'seed-activated:economic:yield-curve-no',
    },
  },
  yieldCurveSe: {
    key: 'seed-meta:economic:yield-curve-se',
    maxStaleMin: 4460,
    activationKey: 'seed-activated:economic:yield-curve-se',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8522,
      activationKey: 'seed-activated:economic:yield-curve-se',
    },
  },
  oecdLtRates: {
    key: 'seed-meta:economic:oecd-lt-rates',
    maxStaleMin: 60 * 24 * 21, // weekly section; 21d = 3x interval, matches monthly data cadence
    activationKey: 'seed-activated:economic:oecd-lt-rates',
    cutover: {
      mode: 'activation-marker',
      fromKey: null,
      issue: 8522,
      activationKey: 'seed-activated:economic:oecd-lt-rates',
    },
  },
  euFsi:             { key: 'seed-meta:economic:fsi-eu',               maxStaleMin: 5760 }, // daily seed (weekdays + holidays); 5760min = 96h = covers Wed→Mon Easter gap. Data freshness is tracked separately via content-age (STALE_CONTENT) — see seed-fsi-eu.mjs.
  diseaseOutbreaks:  { key: 'seed-meta:health:disease-outbreaks',      maxStaleMin: 2880 }, // daily seed; 2880 = 48h = 2x interval
  healthAirQuality:  { key: 'seed-meta:health:air-quality',            maxStaleMin: 180 }, // hourly cron; 180 = 3x interval for shared health/climate seed
  vpdTrackerRealtime:   { key: 'seed-meta:health:vpd-tracker',         maxStaleMin: 2880 }, // daily seed (0 2 * * *); 2880min = 48h = 2x interval
  vpdTrackerHistorical: { key: 'seed-meta:health:vpd-tracker',         maxStaleMin: 2880 }, // shares seed-meta key with vpdTrackerRealtime (same run)
  energyMixAll:         { key: 'seed-meta:economic:owid-energy-mix',   maxStaleMin: 50400 }, // same seed run as energyExposure; shares seed-meta key
  energySpineCountries: { key: 'seed-meta:energy:spine',                maxStaleMin: 2880 }, // daily cron (06:00 UTC); 2880min = 48h = 2x interval
  electricityPrices:    { key: 'seed-meta:energy:electricity-prices',   maxStaleMin: 3000 }, // one snapshot per UTC day, tried at 14/17/20/23 UTC; two days + 2h margin
  gasStorageCountries:  { key: 'seed-meta:energy:gas-storage-countries', maxStaleMin: 2880 }, // daily cron at 10:30 UTC; 2880min = 48h = 2x interval
  // `chinaCoverage` opts these three into the producer diagnostic below. An
  // unusable China row no longer withholds the JODI publish (#6395), so the
  // freshness verdict now describes the 51-63 countries that DID publish and
  // the China gap rides alongside it, named, instead of surfacing 40 days
  // later as a generic STALE_SEED. Content age is producer-declared
  // (newestItemAt/maxContentAgeMin in seed-meta) — a frozen upstream file
  // reads STALE_CONTENT rather than passing as fresh.
  jodiOil:              { key: 'seed-meta:energy:jodi-oil',               maxStaleMin: 60 * 24 * 40, chinaRow: true }, // monthly 35d cadence; 40d = cadence + 5d late-publisher grace. Data/meta TTL is 70d (2× cadence) so last-good outlives this gate and one missed monthly publish.
  ieaOilStocks:         { key: 'seed-meta:energy:iea-oil-stocks',        maxStaleMin: 60 * 24 * 40 }, // monthly cron on 15th; 40d threshold = TTL_SECONDS
  oilStocksAnalysis:    { key: 'seed-meta:energy:oil-stocks-analysis',   maxStaleMin: 60 * 24 * 50 }, // afterPublish of ieaOilStocks; 50d = matches seed-meta TTL (exceeds 40d data TTL)
  eiaPetroleum:         { key: 'seed-meta:energy:eia-petroleum',         maxStaleMin: 4320 }, // daily bundle cron (seed-bundle-energy-sources); 72h = 3× interval, well under 7d data TTL
  jodiGas:              { key: 'seed-meta:energy:jodi-gas',               maxStaleMin: 60 * 24 * 40, chinaRow: true }, // 15d bundle interval; 40d allows missed runs. Data/meta TTL is 70d so last-good outlives this gate and several intervals.
  lngVulnerability:     { key: 'seed-meta:energy:jodi-gas',               maxStaleMin: 60 * 24 * 40, chinaRow: true }, // written by jodi-gas seeder afterPublish; shares seed-meta key and the 70d GAS_TTL
  pipelinesGas:         { key: 'seed-meta:energy:pipelines-gas',        maxStaleMin: 20_160 }, // 14d — weekly cron (7d) × 2 headroom
  pipelinesOil:         { key: 'seed-meta:energy:pipelines-oil',        maxStaleMin: 20_160 }, // 14d — same seed-pipelines.mjs publishes both keys
  storageFacilities:    { key: 'seed-meta:energy:storage-facilities',   maxStaleMin: 20_160 }, // 14d — weekly cron (7d) × 2 headroom
  fuelShortages:        { key: 'seed-meta:energy:fuel-shortages',       maxStaleMin: 2880 },   // 2d — daily cron × 2 headroom (classifier-driven post-launch)
  climateNewsRelayHeartbeat:     { key: 'relay:heartbeat:climate-news',     maxStaleMin: 60 },  // 30m loop; 60m alarm
  staticRefBundleTick: {
    key: 'bundle:heartbeat:static-ref',
    maxStaleMin: 2880, // daily cron `0 3 * * *`; 48h = 2× cadence
    cutover: {
      mode: 'expiring-ack',
      fromKey: null,
      issue: 6691,
      status: 'EMPTY',
    },
  },
  emberElectricity:     { key: 'seed-meta:energy:ember',                maxStaleMin: 2880 }, // daily cron (08:00 UTC); 2880min = 48h = 2x interval
  cryptoSectors:        { key: 'seed-meta:market:crypto-sectors',             maxStaleMin: 120 }, // relay loop every ~30min; 120min = 2h = 4x interval
  ddosAttacks:          { key: 'seed-meta:cf:radar:ddos',                    maxStaleMin: 60 }, // seed-internet-outages publishes the payload before advancing this clock; outages cron ~15min; 60 = 4x interval
  trafficAnomalies:     { key: 'seed-meta:cf:radar:traffic-anomalies',       maxStaleMin: 60 }, // seed-internet-outages publishes the payload before advancing this clock; ANOMALIES_TTL is co-pinned to exceed this gate (see the seeder)
  webcams:                 { key: 'seed-meta:webcam:cameras:geo',                   maxStaleMin: 1440 }, // seed-webcams writes 24h geo/meta keys plus a 30h active pointer; stale at 24h before the layer goes blank.
};

// Standalone keys that are populated on-demand by RPC handlers (not seeds).
// Empty = WARN not CRIT since they only exist after first request.
//
// POLICY (2026-05-01): If the seed-meta key feeds a panel that renders on the
// DEFAULT homepage layout (`enabled: true, priority: 1` in src/config/panels.ts
// or per-variant equivalents), it MUST NOT be in this set. ON_DEMAND softens
// EMPTY to WARN, which is correct ONLY when data is genuinely populated lazily
// after a user action (premium RPC caches that warm on click, intermediate
// seed-to-seed pipeline keys, relay heartbeats, click-warmed lookups). For a
// homepage panel, chronic absence is a real outage and deserves CRIT — softening
// it masks production breakage behind an OK summary.
//
// Specific incident that motivated this policy: marketImplications (homepage
// panel, default-enabled in panels.ts:114) sat at age=988 max=120 (8.2× the
// staleness budget) for 16+ hours while the LLM provider returned HTTP 402 on
// every cron run. /api/health stayed onDemandWarn=1 instead of crit, so the
// chronic outage went undetected until a user noticed the panel was stuck on
// "Loading...". Removed marketImplications below.
const ON_DEMAND_KEYS = new Set([
  // Deploy-before-first-tick bridges: each seeder SETs a durable activation
  // marker (ACTIVATION_MARKERS) after its first successful publish, and from
  // then on the key is strict forever.
  'cbrRates',
  'bocValet',
  'statcanWds',
  'liveVideoResolved',
  'usCpiMonthly',
  'usTreasuryParYield',
  'usInterestRates',
  'worldCpiImf',
  'worldCpiEurostat',
  'worldCpiEstat',
  'worldCpiAbs',
  'bisPolicy', 'bisExchange', 'bisCredit',
  'macroSignals',
  'serviceStatuses', // RPC-populated; seed-meta written on fresh fetch only, goes stale between visits
  // Activation-gated on the operator adding UPSTASH_* as GH Actions secrets;
  // softening is revoked once the durable activation marker exists.
  'newsFeedHealth',
  'imdCycloneMarine',
]);

// Legacy broad empty-data exemptions. classifyKey uses this set in both the
// missing-key and zero-record branches, so entries here can be OK while fresh
// even when the data key has strlen=0. For producer-specific cases where the
// payload must exist but recordCount=0 is valid, add to ZERO_RECORD_DATA_OK_KEYS
// only.
// #4927 re-review P1: "has ever published" must survive the 7d seed-meta
// TTL — inferring activation from meta existence meant a publisher that ran
// once and died read as healthy pending-activation again after the meta
// expired. Publishers SET these markers with NO TTL on every successful
// publish; when the marker exists the key leaves ON_DEMAND softening and
// normal EMPTY/STALE_SEED rules apply.
const ACTIVATION_MARKERS = {
  // Written by scripts/seed-cbr-rates.mjs (CBR_ACTIVATION_KEY) in runSeed's
  // afterPublish hook, so it exists only once a real table has been published.
  cbrRates: 'seed-activated:economic:cbr-rates',
  bocValet: 'seed-activated:economic:boc-valet',
  statcanWds: 'seed-activated:economic:statcan-wds',
  // Written by scripts/seed-live-video-resolved.mjs in runSeed's afterPublish hook.
  liveVideoResolved: SEED_META.liveVideoResolved.activationKey,
  usCpiMonthly: SEED_META.usCpiMonthly.activationKey,
  usTreasuryParYield: SEED_META.usTreasuryParYield.activationKey,
  usInterestRates: SEED_META.usInterestRates.activationKey,
  worldCpiImf: SEED_META.worldCpiImf.activationKey,
  worldCpiEurostat: SEED_META.worldCpiEurostat.activationKey,
  worldCpiEstat: SEED_META.worldCpiEstat.activationKey,
  worldCpiAbs: SEED_META.worldCpiAbs.activationKey,
  imdCycloneMarine: SEED_META.imdCycloneMarine.activationKey,
  newsFeedHealth: 'seed-activated:news:feed-health',
  // Written without a TTL by scripts/seed-fred-rates.mjs only after runSeed
  // successfully publishes the version-1 canonical batch. The marker makes
  // first publication one-way: a later disappearance is strict forever.
  fredRatesSeeder: 'seed-activated:economic:fred-rates:v1',
};

// #6182 — the terminal failure class behind a partial market's counts.
//
// The vocabulary is per-producer and CLOSED, like every other code health
// echoes back to operators: anything outside this list is dropped rather than
// relayed. Keep in lockstep with COVERAGE_FAILURE_REASONS in
// consumer-prices-core/src/jobs/scrape-coverage.ts; tests/consumer-prices-
// coverage-contract.test.mjs pins the two together.
export const COVERAGE_FAILURE_REASONS = Object.freeze([
  'provider-cooldown',
  'provider-error',
  'missing-price',
  'price-evidence-missing',
  'quantity-as-price',
  'currency-mismatch',
  'title-mismatch',
  'validator-rejected',
  'parsed-zero-products',
  'pin-validator-rejected',
  'match-admission-persist-failed',
  'unknown-error',
]);

// Counts must be whole and positive: the map is a breakdown of errorsCount, so
// a fractional or negative entry is producer drift, not a diagnostic.
function sanitizeCoverageFailureReasons(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const clean = {};
  for (const reason of COVERAGE_FAILURE_REASONS) {
    const count = Number(raw[reason]);
    if (Number.isSafeInteger(count) && count > 0) clean[reason] = count;
  }
  return clean;
}

function fredRatesRolloutCommands(now, vercelEnv = process.env.VERCEL_ENV) {
  // Preview deployments can run for days before merge and can share the same
  // Redis credentials. Letting one claim the deadline would recreate the fixed
  // pre-merge-date bug under a different clock, so only production may start it.
  if (vercelEnv !== 'production') return [];
  const candidateUntil = now + FRED_RATES_ROLLOUT_DURATION_MS;
  return [
    ['SET', FRED_RATES_ROLLOUT_DEADLINE_KEY, String(candidateUntil), 'NX'],
    ['GET', FRED_RATES_ROLLOUT_DEADLINE_KEY],
  ];
}

function parseFredRatesRolloutUntil(results) {
  if (!Array.isArray(results) || results.length !== 2) return null;
  if (results[0]?.error || results[1]?.error) return null;
  const until = Number(results[1]?.result);
  return Number.isSafeInteger(until) && until > 0 ? until : null;
}

// A PR that bumps a versioned data key (`family:vN:...`) deploys this reader on
// merge, but a cron writer keeps its previous code until its next scheduled
// tick (a Railway deploy does not run the job). #9044 moved resilienceIntervals
// from v11 to v12 at 08:55 UTC on 2026-10-08, and health read EMPTY (crit) for
// three hours beside a fresh seed-meta written by the v11 code. A fresh writer
// whose `sourceVersion` names an older version of the read key's family is that
// state, so the absent key gets the ROLLOUT_PENDING window the FRED rollout
// uses. The window is the key's own staleness budget capped at one day, claimed
// once per data key version in production; a writer that still writes the old
// version after it reads EMPTY again. The cap matters for budgets of weeks or
// months (resilienceStaticIndex: 400 days): the gap is one writer tick, and a
// writer that never moves to the new version must not keep the key at warn.
const KEY_VERSION_ROLLOUT_DEADLINE_PREFIX = 'health:rollout-deadline:key-version:';
const KEY_VERSION_ROLLOUT_MAX_MS = 24 * 60 * 60 * 1_000;

function keyVersionRolloutDurationMs(seedCfg) {
  return Math.min(seedCfg.maxStaleMin * 60_000, KEY_VERSION_ROLLOUT_MAX_MS);
}

function versionedKeyFamily(dataKey) {
  const match = /^(.+?):v(\d+)(?=:|$)/.exec(dataKey);
  return match ? { family: match[1], version: Number(match[2]) } : null;
}

function writerKeyVersionBehind(dataKey, sourceVersion) {
  const target = versionedKeyFamily(dataKey);
  if (!target || typeof sourceVersion !== 'string') return false;
  const family = target.family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|:)${family}:v(\\d+)(?=:|$)`).exec(sourceVersion);
  return match !== null && Number(match[1]) < target.version;
}

function keyVersionRolloutCandidates(registries, keyStrens, keyErrors, keyMetaValues, keyMetaErrors, now) {
  const candidates = [];
  for (const registry of registries) {
    for (const [name, dataKey] of Object.entries(registry)) {
      const seedCfg = SEED_META[name];
      if (!seedCfg || keyErrors.get(dataKey) || keyHasData(dataKey, keyStrens.get(dataKey) ?? 0)) continue;
      const seedMeta = readSeedMeta(seedCfg, keyMetaValues, keyMetaErrors, now);
      if (!seedMeta.hasMeta || seedMeta.seedError || seedMeta.seedStale !== false) continue;
      const meta = unwrapEnvelope(parseRedisValue(keyMetaValues.get(seedCfg.key))).data;
      if (!writerKeyVersionBehind(dataKey, meta?.sourceVersion)) continue;
      candidates.push({ name, dataKey, durationMs: keyVersionRolloutDurationMs(seedCfg) });
    }
  }
  return candidates;
}

// Production only, SET NX without expiry: the same reasons as
// fredRatesRolloutCommands. The deadline key names the data key version, so the
// next bump opens its own window.
function keyVersionRolloutCommands(candidates, now, vercelEnv = process.env.VERCEL_ENV) {
  if (vercelEnv !== 'production') return [];
  return candidates.flatMap(({ dataKey, durationMs }) => {
    const deadlineKey = `${KEY_VERSION_ROLLOUT_DEADLINE_PREFIX}${dataKey}`;
    return [
      ['SET', deadlineKey, String(now + durationMs), 'NX'],
      ['GET', deadlineKey],
    ];
  });
}

function staleContentGraceEvidence(contentAge, contentFreshness, now) {
  if (!contentAge && !contentFreshness) return null;

  let observedAt;
  let budgetMinutes;
  if (contentAge?.contentStale) {
    observedAt = contentAge.newestItemAt;
    budgetMinutes = contentAge.maxContentAgeMin;
  } else if (contentFreshness?.usable && contentFreshness.contentStale) {
    observedAt = contentFreshness.criticalOldestObservedAt;
    budgetMinutes = contentFreshness.budgetMinutes;
  } else {
    // An unusable required block is COVERAGE_DEGRADED, not proof that content
    // recovered. Preserve any earlier state until a usable fresh check exists.
    if (contentFreshness && !contentFreshness.usable) return null;
    return { contentStale: false, graceEligible: false, boundaryMs: null };
  }

  if (observedAt === null) {
    return { contentStale: true, graceEligible: true, boundaryMs: null };
  }
  if (!Number.isFinite(observedAt) || observedAt > now) {
    return { contentStale: true, graceEligible: false, boundaryMs: null };
  }

  const boundaryMs = observedAt + budgetMinutes * 60_000;
  if (!Number.isSafeInteger(boundaryMs)) {
    return { contentStale: true, graceEligible: false, boundaryMs: null };
  }
  // `boundaryMs` is reported whether or not it has already passed. A per-entity
  // count can go stale BEFORE its oldest timestamp reaches the age boundary; the
  // deadline math below picks the right anchor for either case.
  return { contentStale: true, graceEligible: true, boundaryMs };
}

// The candidate deadline for a source's FIRST stale-content observation.
//
// A past boundary is the honest start of the incident, so grace runs from
// there — that keeps a source that has already been stale for hours from
// buying a full fresh window. Anything else (no usable timestamp, or a
// per-entity count that tripped before its time boundary) has no provable
// start, so the observation itself is the clock.
//
// This value is only ever a CANDIDATE: `HSETNX` pins the first one and every
// later sweep reads that back, which is what makes the window one-shot.
function staleContentGraceCandidateUntil(evidence, now) {
  return evidence.boundaryMs !== null && evidence.boundaryMs <= now
    ? evidence.boundaryMs + STALE_CONTENT_GRACE_MS
    : now + STALE_CONTENT_GRACE_MS;
}

/**
 * Builds the Redis work for one sweep, split by urgency.
 *
 * `claimCommands` must be awaited: their HGET replies decide what deadline (if
 * any) this response publishes. `cleanupCommands` only reap state for sources
 * that have recovered, so nothing in this response depends on them and they are
 * dispatched in the background; the refresh lease is released only after they
 * settle, so their token-fenced writes still see this owner's lease.
 *
 * Claims are gated on the CLASSIFIED status, not on content evidence alone.
 * Several classifier branches (REDIS_PARTIAL, EMPTY, SEED_ERROR, STALE_SEED,
 * coverage failures) outrank STALE_CONTENT, and a key taking one of those still
 * has stale content evidence. Claiming there would burn the source's single
 * anchor during an incident that publishes no grace at all, so it would arrive
 * at its real STALE_CONTENT moment with a partly-elapsed window.
 */
function staleContentGraceStatePlan(graceEvidenceByName, checks, now, stateKey = STALE_CONTENT_GRACE_STATE_KEY) {
  const claimCommands = [];
  const cleanupCommands = [];
  const stateBackedNames = [];
  const recoveredNames = [];

  for (const [name, evidence] of graceEvidenceByName) {
    if (!evidence) continue;
    if (
      evidence.contentStale
      && evidence.graceEligible
      && checks?.[name]?.status === 'STALE_CONTENT'
    ) {
      claimCommands.push(
        ['HSETNX', stateKey, name, String(staleContentGraceCandidateUntil(evidence, now))],
        ['HGET', stateKey, name],
      );
      stateBackedNames.push(name);
    } else if (!evidence.contentStale) {
      recoveredNames.push(name);
    }
  }

  // Refresh the whole hash's lifetime whenever any live claim exists, so a hash
  // holding only leftovers from retired registry names reaps itself. The window
  // is far shorter than the sweep cadence, so an ACTIVE incident's field can
  // never expire underneath it. Appended AFTER the pairs so the reply indices
  // `parseStaleContentGraceUntil` walks stay aligned.
  if (claimCommands.length > 0) {
    claimCommands.push(['PEXPIRE', stateKey, String(STALE_CONTENT_GRACE_MS * 2)]);
  }
  if (recoveredNames.length > 0) cleanupCommands.push(['HDEL', stateKey, ...recoveredNames]);
  return { claimCommands, cleanupCommands, stateBackedNames };
}

function parseStaleContentGraceUntil(results, stateBackedNames) {
  const deadlines = new Map();
  if (!Array.isArray(results)) return deadlines;

  for (let i = 0; i < stateBackedNames.length; i++) {
    const setResult = results[i * 2];
    const getResult = results[i * 2 + 1];
    const claimed = Number(setResult?.result);
    const until = Number(getResult?.result);
    if (
      setResult?.error
      || getResult?.error
      || (claimed !== 0 && claimed !== 1)
      || !Number.isSafeInteger(until)
      || until <= 0
    ) continue;
    deadlines.set(stateBackedNames[i], until);
  }
  return deadlines;
}

/**
 * The stored anchor is the ONLY source of a published deadline. Deriving it
 * again here would let it move whenever the underlying observation moved, which
 * is exactly how a "finite" window turns into a standing budget extension.
 *
 * The upper bound is defence in depth against a corrupt or tampered hash value,
 * mirroring `MAX_STALE_CONTENT_GRACE_MS` in the scheduled monitor: no honest
 * anchor can sit more than one full window ahead of now.
 */
function staleContentGraceUntilMs(evidence, stateBackedUntil, now) {
  if (!evidence?.contentStale || !evidence.graceEligible) return null;
  if (!Number.isSafeInteger(stateBackedUntil)) return null;
  return stateBackedUntil > now && stateBackedUntil <= now + STALE_CONTENT_GRACE_MS
    ? stateBackedUntil
    : null;
}

// Publishes `staleContentGraceUntil` on the entries that earned it. Runs after
// classification so the claim above and this projection agree on which keys are
// actually STALE_CONTENT.
function applyStaleContentGrace(checks, graceEvidenceByName, deadlines, now) {
  for (const [name, entry] of Object.entries(checks)) {
    if (entry?.status !== 'STALE_CONTENT') continue;
    const until = staleContentGraceUntilMs(graceEvidenceByName.get(name), deadlines.get(name), now);
    if (until !== null) entry.staleContentGraceUntil = new Date(until).toISOString();
  }
}

const EMPTY_DATA_OK_KEYS = new Set([
  'weatherAlerts', 'imdCycloneMarine',
  'ddosAttacks', 'trafficAnomalies', // zero events during quiet periods is valid, not critical
  'cableHealth', // `cables: {}` = no active subsea cable disruptions per NGA NAVAREA warnings — all cables implicitly healthy. Also covers NGA-upstream-down windows where get-cable-health writes back the fallback response (empty cables); without this, those would alarm EMPTY_DATA.
  'error', // #5233 funnel guardrail is a new afterPublish side-write; before the first seed-forecasts run ships it the key is absent — tolerate as STALE_SEED (warn), not EMPTY (crit). Its producer never writes status:'error': a collapsed funnel is informational (#8990), so only freshness can degrade this check.
  // Venues closed or not yet reporting: the relay advances seed-meta only when
  // BestTime answers every venue cleanly with no usable live reading, for up to 24h
  // after the last live one. Provider errors, a dead loop, or a longer silence
  // stop the heartbeat, so an absent payload then reads STALE_SEED.
  // Compact projections stay STALE_SEED before their first producer tick or
  // after metadata turns stale. Fresh metadata plus a missing payload is
  // deliberately strict: MISSING_DATA_IS_FAILURE_KEYS reports EMPTY (crit).
  'wildfiresBootstrap',
]);

// These compact projections must leave a payload on every successful publish.
// This is deliberately narrower than EMPTY_DATA_OK_KEYS: weather refreshes
// only its seed metadata during quiet periods, so an absent payload is valid
// for that source. Every entry here must also be in
// EMPTY_DATA_OK_KEYS so a pre-first-publish absence remains STALE_SEED rather
// than a false-critical EMPTY; tests/health-empty-data-ok.test.mjs enforces it.
const MISSING_DATA_IS_FAILURE_KEYS = new Set([
  // These sparse feeds publish an explicit canonical payload on every
  // successful cycle, including valid zero-record cycles. Fresh metadata
  // therefore cannot excuse a vanished data key.
  'cableHealth',
  'ddosAttacks',
  'trafficAnomalies',
  'wildfiresBootstrap',
  // The Canada road seeders publish an explicit {records: []} envelope on every
  // successful tick (zeroIsValid -> contractState OK_ZERO -> canonical written),
  // so they never refresh metadata alone. Without this, an expired or evicted
  // canonical key alongside a still-refreshing seed-meta classified OK: the map
  // layer goes blank and nothing pages. Same reasoning as `outages`.
  // albertaRoads and manitobaRoads are written by the same seeder on the same
  // publish path; torontoRoads is a different seeder under the same publish contract.
  // Same contract, and the highest-stakes member of it: the provincial union
  // writes {alerts: []} when all configured sources are quiet. Reading
  // OK while an EMERGENCY ALERT payload has vanished is the worst failure in this set.
]);

// Keys where a present payload with meta recordCount=0 is valid, but the data
// key itself must still exist. Do not use this set in the missing-key branch.
const ZERO_RECORD_DATA_OK_KEYS = new Set([
  ...EMPTY_DATA_OK_KEYS,
  'naturalEvents',
  // A current List query can validly return no Posts. The relay still writes
  // the canonical snapshot, so a missing xFeed key remains a hard failure.
  // Zero active webhook subscribers is a valid state; the status key is still
  // written every tick, so a missing key stays a hard failure.
  // Both Toronto CAD sources publish an explicit {records:[]} envelope on a
  // quiet tick. Keep zero valid without softening a missing payload after each
  // activation marker exists.
  // The relay publishes the dark-ship envelope with zeroOk — zero dark ships
  // is a legitimate peaceful state, not a failed publish. A MISSING key still
  // reads EMPTY (absence is not peaceful).
  // retailer-spread is SUPPRESSED to an explicit 0 by the aggregate job when a
  // market's retailers share < MIN_SPREAD_ITEMS (4) common basket items —
  // consumer-prices-core/src/jobs/aggregate.ts writes `retailer_spread_pct: 0`
  // ("prevent stale noisy value persisting") and logs "spread suppressed
  // (N/4 common items)". That is a valid data-coverage state, not a pipeline
  // outage: the AE basket's cross-retailer overlap shrank 2/4 → 1/4 → 0/4 over
  // late-May 2026 while the seeder kept running fresh (seedAgeMin well inside
  // maxStaleMin) and the sibling keys (overview/categories/movers/basket-series)
  // published normally. Treat 0 records as OK while fresh; STALE_SEED still
  // fires if the publish job itself stops.
  // CF Radar curated outage annotations (seed-internet-outages, zeroIsValid)
  // are sparse — most 28d windows publish an empty {outages:[]} envelope with
  // recordCount=0 (hasData=true). NARROW set, not EMPTY_DATA_OK_KEYS: the
  // seeder always publishes the array, so a MISSING canonical key is a real
  // publish failure → still EMPTY (crit). ddosAttacks and trafficAnomalies use
  // the same present-payload contract. Their EMPTY_DATA_OK_KEYS membership only
  // preserves pre-first-publish grace.
  'outages',
  // Official disclosure categories are sparse. The canonical snapshot always
  // exists after a successful query, but a quiet 90-day window can validly
  // contain zero owned-category events.
  // #5736 ingest-health records. `recordCount` is the volume the relay accepted
  // on the last successful append, and zero is legitimate — a run whose records
  // were all deduped, or one with no noteworthy records at all. The record key
  // itself must still exist, so this is the NARROW set: a vanished record is a
  // real gap, not a quiet period.
  // A completed surge calculation can legitimately contain no surge events;
  // the canonical snapshot must still exist and remain fresh.
  // TTC GTFS-RT service alerts: a quiet window can validly contain zero
  // disruptions. The seeder always publishes {alerts:[]}, so a missing
  // canonical key is still EMPTY (crit).
]);

// Cascade groups: if any key in the group has data, all empty siblings are OK.
// Theater posture uses live → stale → backup fallback chain.
const CASCADE_GROUPS = {
};


const NEG_SENTINEL = '__WM_NEG__';


function parseRedisValue(raw) {
  if (!raw || raw === NEG_SENTINEL) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

// Real data is always >0 bytes. The negative-cache sentinel is exactly
// NEG_SENTINEL.length bytes (10), so any strlen > 0 that is NOT exactly that
// length counts as data. The previous `> 10` heuristic misclassified
// legitimately small payloads (`{}`, `[]`, `0`) as missing.
function strlenIsData(strlen) {
  return strlen > 0 && strlen !== NEG_SENTINEL.length;
}

// Data keys whose Redis value is a LIST rather than a string. STRLEN against a
// list returns WRONGTYPE, which lands in keyErrors and pins the key at
// REDIS_PARTIAL forever even though its seeder is healthy — measure these with
// LLEN instead. Presence is then simply `len > 0`: the NEG_SENTINEL
// byte-length rule above is a STRING concept, and applying it to a list would
// declare a 10-ELEMENT history empty.
const LIST_DATA_KEYS = new Set([
  STANDALONE_KEYS.forecastBets, // LPUSH/LTRIM — scripts/seed-forecast-bets.mjs
]);

function dataLenCommand(redisKey) {
  return [LIST_DATA_KEYS.has(redisKey) ? 'LLEN' : 'STRLEN', redisKey];
}

function keyHasData(redisKey, len) {
  return LIST_DATA_KEYS.has(redisKey) ? len > 0 : strlenIsData(len);
}



const TRADE_FLOW_DOMINANT_FAILURE_MODES = new Set([
  'run-failed', 'upstream', 'empty', 'incomplete-years', 'mixed', 'none',
]);

const COMPANY_MONITORING_WORKER_STATUSES = new Set(['ok', 'error']);
const COMPANY_MONITORING_CLAIM_FAILURE_KINDS = new Set([
  'timeout', 'network', 'http_transient', 'http_error', 'invalid_response', 'unknown',
]);
const COMPANY_MONITORING_SCAN_OUTCOMES = new Set([
  'starting', 'disabled', 'idle', 'completed', 'non_reassuring', 'fenced',
  'replayed', 'claim_error', 'finalize_error',
]);
const COMPANY_MONITORING_ADMISSION_OUTCOMES = new Set([
  'disabled', 'idle', 'admission_recorded', 'admission_replayed',
  'admission_transport_failure', 'admission_claim_error', 'admission_finalize_error',
]);
const COMPANY_MONITORING_WORKER_OUTCOMES = new Set([
  ...COMPANY_MONITORING_SCAN_OUTCOMES,
  ...COMPANY_MONITORING_ADMISSION_OUTCOMES,
]);
const COMPANY_MONITORING_WORKER_COUNTERS = Object.freeze([
  'loops', 'claims', 'completed', 'nonReassuring', 'fenced', 'replayed',
  'executorErrors', 'claimErrors', 'finalizeErrors',
  'admissionClaims', 'admissionRecorded', 'admissionReplayed',
  'admissionTransportFailures', 'admissionClaimErrors', 'admissionFinalizeErrors',
]);

function projectCompanyMonitoringWorkerSubsystem(raw, outcomes) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || !COMPANY_MONITORING_WORKER_STATUSES.has(raw.status)
    || !outcomes.has(raw.outcome)) return null;
  return { status: raw.status, outcome: raw.outcome };
}

function projectCompanyMonitoringWorkerControl(meta, enabled, now) {
  if (!enabled || !COMPANY_MONITORING_WORKER_STATUSES.has(meta?.status)
    || !COMPANY_MONITORING_WORKER_OUTCOMES.has(meta?.outcome)) return null;
  let subsystems;
  if (meta.subsystems !== undefined) {
    if (!meta.subsystems || typeof meta.subsystems !== 'object'
      || Array.isArray(meta.subsystems)) return null;
    const scan = projectCompanyMonitoringWorkerSubsystem(
      meta.subsystems.scan,
      COMPANY_MONITORING_SCAN_OUTCOMES,
    );
    const admission = projectCompanyMonitoringWorkerSubsystem(
      meta.subsystems.admission,
      COMPANY_MONITORING_ADMISSION_OUTCOMES,
    );
    if (!scan || !admission) return null;
    const failure = meta.subsystems.scan.claimFailure;
    if (scan.outcome === 'claim_error' && COMPANY_MONITORING_CLAIM_FAILURE_KINDS.has(failure?.kind)
      && (failure.httpStatus === null
        || (Number.isInteger(failure.httpStatus) && failure.httpStatus >= 400 && failure.httpStatus <= 599))) {
      scan.claimFailure = {
        kind: failure.kind,
        httpStatus: failure.httpStatus,
        consecutiveFailures: Number.isSafeInteger(failure.consecutiveFailures) && failure.consecutiveFailures > 0
          ? Math.min(failure.consecutiveFailures, 9_999_999_999) : null,
        lastHealthyAt: Number.isSafeInteger(failure.lastHealthyAt) && failure.lastHealthyAt > 0
          && Number.isSafeInteger(meta.observedAt) && meta.observedAt === meta.fetchedAt
          && failure.lastHealthyAt <= meta.observedAt && meta.observedAt <= now
          ? failure.lastHealthyAt : null,
      };
    }
    subsystems = { scan, admission };
  }
  const counters = {};
  for (const name of COMPANY_MONITORING_WORKER_COUNTERS) {
    const value = meta?.counters?.[name];
    counters[name] = Number.isSafeInteger(value) && value >= 0
      ? Math.min(value, 9_999_999_999)
      : 0;
  }
  return {
    status: meta.status,
    outcome: meta.outcome,
    ...(subsystems ? { subsystems } : {}),
    counters,
  };
}

// A JODI producer's China record, projected for the wire. Opt-in per key via
// the SEED_META entry declaring `chinaRow: true` so no other seed-meta reader
// changes. Deliberately NOT named `chinaCoverage`: that is the top-level check
// projecting the hourly China coverage summary, and one country's row inside
// one source is a different, smaller claim.
//
// Purely informational — it never moves a status. China's rows going unusable
// is an upstream fact the operator can neither clear nor retry (the China
// coverage manifest already carries JODI as `blocked` for the same reason), so
// grading it would be an eternal warn. What it must not be is invisible: since
// #6395 the dataset publishes without China, and this block is what says which
// country dropped out and how long ago.
//
// `reason` is a closed vocabulary — health would otherwise relay arbitrary
// producer free-text onto a public endpoint.
const JODI_CHINA_ROW_REASONS = new Set([
  'china-missing',
  'china-invalid-month',
  'china-stale',
  'china-no-measurements',
]);

function projectJodiChinaRow(meta, enabled) {
  if (!enabled) return null;
  const raw = meta?.chinaRow;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const ok = raw.ok === true;
  // Read the raw types rather than coercing: `Number(null)` is 0, which would
  // publish "China's data is 0 months old" for a China record that is absent
  // and has no data month at all.
  const ageMonths = typeof raw.ageMonths === 'number' ? raw.ageMonths : NaN;
  const unavailableSince = typeof raw.unavailableSince === 'number' ? raw.unavailableSince : NaN;
  return {
    ok,
    reason: !ok && typeof raw.reason === 'string' && JODI_CHINA_ROW_REASONS.has(raw.reason)
      ? raw.reason
      : null,
    dataMonth: typeof raw.dataMonth === 'string' && /^\d{4}-\d{2}$/.test(raw.dataMonth)
      ? raw.dataMonth
      : null,
    ageMonths: Number.isSafeInteger(ageMonths) && ageMonths >= 0 ? ageMonths : null,
    unavailableSince: !ok && Number.isFinite(unavailableSince) && unavailableSince > 0
      ? unavailableSince
      : null,
  };
}

function parseFiniteRecordCount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

function projectSourceFailure(meta, policy, now, maxStaleMin) {
  if (Array.isArray(policy)) policy = policy.find(candidate => candidate.failureCodePattern.test(meta?.errorCode));
  if (!policy || meta?.sourceState !== 'degraded') return null;
  let retainedUntil = Infinity;
  if (policy.sources) {
    const failed = meta.failedSources;
    const states = Array.isArray(failed) && failed.length > 0 && failed.length < policy.sources.length
      && new Set(failed).size === failed.length && failed.every((source) => policy.sources.includes(source))
      ? failed.map((source) => meta.sourceHealth?.[source]) : [];
    const valid = states.length > 0 && states.every((state) =>
      Number.isSafeInteger(state?.consecutiveFailures) && state.consecutiveFailures >= 1
      && [state.lastSuccessAt, state.firstFailureAt, state.retainedUntil].every((value) => Number.isSafeInteger(value) && value > 0)
      && state.lastSuccessAt <= state.firstFailureAt && state.firstFailureAt <= meta.lastSourceAttemptAt);
    retainedUntil = valid ? Math.min(...states.map((state) => state.retainedUntil)) : NaN;
    meta = {
      ...meta,
      consecutiveSourceFailures: valid ? Math.max(...states.map((state) => state.consecutiveFailures)) : null,
      firstSourceFailureAt: valid ? Math.min(...states.map((state) => state.firstFailureAt)) : null,
      lastSourceSuccessAt: valid ? Math.min(...states.map((state) => state.lastSuccessAt)) : null,
      lastSourceFailureCode: meta.errorCode,
    };
  }
  const errorCode = typeof meta?.errorCode === 'string'
    && policy.failureCodePattern.test(meta.errorCode)
    ? meta.errorCode
    : null;
  if (!errorCode) return null;
  const lastSourceFailureCode = typeof meta?.lastSourceFailureCode === 'string'
    && policy.failureCodePattern.test(meta.lastSourceFailureCode)
    ? meta.lastSourceFailureCode
    : null;
  const consecutiveSourceFailures = Number.isInteger(meta?.consecutiveSourceFailures)
    && meta.consecutiveSourceFailures >= 1
    ? Math.min(meta.consecutiveSourceFailures, 100)
    : null;
  let pending = lastSourceFailureCode === errorCode
    && consecutiveSourceFailures !== null
    && consecutiveSourceFailures < policy.warnAfterConsecutive;
  let pendingUntil = null;
  if (policy.maxPendingMin != null) {
    const first = meta.firstSourceFailureAt;
    const attempt = meta.lastSourceAttemptAt;
    // A mixed-source publication may be new while one retained provider is older.
    const success = meta[policy.successAtField || 'fetchedAt'];
    const validEpisode = [first, attempt, success].every((value) => Number.isSafeInteger(value) && value > 0)
      && success <= first && first <= attempt && attempt <= now;
    const deadline = validEpisode
      ? Math.min(first + policy.maxPendingMin * 60_000, success + maxStaleMin * 60_000, retainedUntil)
      : NaN;
    pending = pending && parseFiniteRecordCount(meta.count ?? meta.recordCount) > 0
      && Number.isFinite(deadline) && now < deadline;
    if (pending) pendingUntil = new Date(deadline).toISOString();
  }
  return {
    errorCode,
    consecutiveSourceFailures,
    lastSourceFailureCode,
    pending,
    pendingUntil,
  };
}

function readSeedMeta(seedCfg, keyMetaValues, keyMetaErrors, now) {
  if (!seedCfg) {
    return { hasMeta: false, seedAge: null, seedStale: null, seedError: false, sourceUnavailable: false, sourceBlocked: false, metaReadFailed: false, metaCount: null, contentAge: null, coverage: null, sourceFailure: null, synthesisFailure: null, dominantFailureMode: null, chinaRow: null, workerControl: null, resilienceCacheState: null };
  }
  // Per-command Redis errors on the GET seed-meta half of the pipeline must
  // not silently fall through to STALE_SEED — promote to REDIS_PARTIAL.
  if (keyMetaErrors.get(seedCfg.key)) {
    return { hasMeta: false, seedAge: null, seedStale: null, seedError: false, sourceUnavailable: false, sourceBlocked: false, metaReadFailed: true, metaCount: null, contentAge: null, coverage: null, sourceFailure: null, synthesisFailure: null, dominantFailureMode: null, chinaRow: null, workerControl: null, resilienceCacheState: null };
  }
  // Unwrap through the envelope helper. Legacy seed-meta is a bare
  // `{ fetchedAt, recordCount, sourceVersion, status? }` object with no `_seed`
  // wrapper, so `unwrapEnvelope` returns it as `.data` unchanged. PR 2 wires
  // true envelope reads at the canonical-key layer; this import establishes
  // the dependency so behavior stays byte-identical in PR 1.
  const meta = unwrapEnvelope(parseRedisValue(keyMetaValues.get(seedCfg.key))).data;
  const metaCount = parseFiniteRecordCount(meta?.count ?? meta?.recordCount ?? null);
  const failedDatasets = [];
  const seenFailedDatasets = new Set();
  if (seedCfg.projectFailedDatasets && Array.isArray(meta?.failedDatasets)) {
    for (const entry of meta.failedDatasets) {
      if (typeof entry !== 'string' || entry.length === 0 || entry.length > 100 || seenFailedDatasets.has(entry)) continue;
      seenFailedDatasets.add(entry);
      failedDatasets.push(entry);
      if (failedDatasets.length === 50) break;
    }
  }
  const metaRankableCount = parseRankableRecordCount(meta);
  const redistributionPolicyVersion = Number.isInteger(meta?.redistributionPolicyVersion)
    ? meta.redistributionPolicyVersion
    : null;
  const poolCounts = parsePoolCounts(meta?.poolCounts, seedCfg.minPoolCounts);
  // Opt-in per probe: only keys that declare `poolCountMargin` report headroom.
  // Null whenever the counts are unusable, so a malformed cohort reads as
  // "unknown margin" rather than a comfortable one.
  const poolMargins = seedCfg.poolCountMargin != null
    ? poolCoverageMargins(poolCounts, seedCfg.minPoolCounts, seedCfg.poolCountMargin)
    : null;
  const errorCode = typeof meta?.errorCode === 'string'
    && /^[A-Z0-9_]{1,64}$/.test(meta.errorCode)
    ? meta.errorCode
    : null;
  const workerControl = projectCompanyMonitoringWorkerControl(meta, seedCfg.workerControl, now);
  const resilienceCacheState = seedCfg.requireResilienceCacheState
    ? assessResilienceCacheState(meta)
    : null;
  if (meta?.status === 'error') {
    return {
      hasMeta: true,
      seedAge: null,
      seedStale: true,
      seedError: true,
      sourceUnavailable: false,
      sourceBlocked: false,
      metaReadFailed: false,
      metaCount,
      metaRankableCount,
      redistributionPolicyVersion,
      poolCounts,
      poolMargins,
      contentAge: null,
      contentFreshness: null,
      decisionGroups: null,
      coverage: null,
      errorCode,
      sourceFailure: null,
      synthesisFailure: null,
      dominantFailureMode: null,
      // A producer that reported `status: 'error'` never got far enough to
      // assess China this run; relaying the previous run's verdict here would
      // read as current.
      chinaRow: null,
      workerControl,
      resilienceCacheState,
      failedDatasets,
    };
  }
  let seedAge = null;
  let seedStale = true;
  const fetchedAt = Number(meta?.fetchedAt);
  if (Number.isFinite(fetchedAt) && fetchedAt > 0) {
    seedAge = Math.round((now - fetchedAt) / 60_000);
    seedStale = seedAge > seedCfg.maxStaleMin;
  }
  if (resilienceCacheState?.ok === false) seedStale = true;
  // `unavailable` is the one sourceState that means "this deployment never opted
  // into the adapter" (the producer had no credential to try with), as opposed to
  // "the adapter was tried and is broken" (`stale`/`error`). Grading the two the
  // same makes an optional, deliberately-unconfigured source an eternal warn that
  // no amount of operator work can clear — so it is classified separately below.
  const sourceUnavailable = meta?.sourceState === 'unavailable';
  // A current, bounded upstream classification can prove that every admitted
  // transport path is externally blocked. Keep that state visible without
  // treating it as a broken producer that can be repaired by another retry.
  const sourceBlocked = meta?.sourceState === 'blocked';
  const sourceFailure = projectSourceFailure(meta, seedCfg.sourceFailure, now, seedCfg.maxStaleMin);
  // Source-specific producers can preserve usable last-good records while a
  // current upstream attempt is degraded. Surface that state immediately as a
  // warning without discarding the retained record count from health output.
  const inputFreshUntil = Number(meta?.inputFreshUntil);
  const inputFreshnessExpired = seedCfg.enforceInputFreshUntil === true
    && meta?.sourceState === 'ok'
    && (!Number.isFinite(inputFreshUntil) || inputFreshUntil <= now);
  const sourceDegraded = inputFreshnessExpired || (typeof meta?.sourceState === 'string'
    && meta.sourceState !== 'ok'
    && !sourceUnavailable
    && !sourceBlocked
    && sourceFailure?.pending !== true);
  // Content-age trio (2026-05-04 health-readiness plan). Presence of
  // maxContentAgeMin is the opt-in signal — legacy seeders without it
  // get contentAge: null and skip the STALE_CONTENT branch in classifyKey.
  // newestItemAt may be explicit null when seeder's contentMeta returned null
  // (no usable item timestamps); classifier reads that as STALE_CONTENT.
  // Shared assessor (api/_content-age.js) owns the rule so this endpoint and
  // MCP's evaluateFreshness cannot drift on parsing, the future-dated rule, or
  // re-aging — the same reason buildContentFreshnessAssessment is shared below.
  const contentAge = assessContentAge(meta, now);
  // The shared assessment owns validation, fail-closed activation semantics,
  // and exact millisecond re-aging. This endpoint keeps only its status and
  // response-shaping concerns local.
  const contentFreshness = buildContentFreshnessAssessment(
    meta,
    seedCfg.requireContentFreshness,
    now,
  );
  const decisionDiagnostics = seedCfg.decisionGroups
    ? projectChinaDecisionGroupDiagnostics(meta, {
      groupIds: seedCfg.decisionGroups,
      allowedStates: CHINA_DECISION_SIGNAL_STATES,
      healthyQuietCause: CHINA_DECISION_HEALTHY_QUIET_CAUSE,
    })
    : null;
  const decisionGroups = decisionDiagnostics
    ? {
      ...decisionDiagnostics.groupCounts,
      groupStates: decisionDiagnostics.groupStates,
      quietGroups: decisionDiagnostics.quietGroups,
      partialGroups: decisionDiagnostics.partialGroups,
      staleGroups: decisionDiagnostics.staleGroups,
      unavailableGroups: decisionDiagnostics.unavailableGroups,
      ...(decisionDiagnostics.coverageLastSuccessAt
        ? { coverageLastSuccessAt: decisionDiagnostics.coverageLastSuccessAt }
        : {}),
      ...(decisionDiagnostics.coverageFailureInvalidReason
        ? { coverageFailureInvalidReason: decisionDiagnostics.coverageFailureInvalidReason }
        : {}),
    }
    : seedCfg.decisionGroups
      ? { coverageFailureInvalidReason: 'GROUP_DIAGNOSTICS_INVALID' }
      : null;
  // Per-market coverage: optional { status, completedPages, failedPages, completionRatio, rejectedCount, failureReasons, retailers }
  // written by consumer-prices publish.ts and other seeders that track partial completion.
  // null when the seeder didn't write coverage fields.
  const coverageRetailers = Array.isArray(meta?.coverage?.retailers)
    ? meta.coverage.retailers.slice(0, 100).map((retailer) => ({
        slug: typeof retailer?.slug === 'string' ? retailer.slug.slice(0, 80) : null,
        name: typeof retailer?.name === 'string' ? retailer.name.slice(0, 120) : null,
        coverageStatus: typeof retailer?.coverageStatus === 'string' ? retailer.coverageStatus : 'unknown',
        pagesAttempted: Number(retailer?.pagesAttempted) || 0,
        pagesSucceeded: Number(retailer?.pagesSucceeded) || 0,
        failedPages: Number(retailer?.failedPages) || 0,
        rejectedCount: Number(retailer?.rejectedCount) || 0,
        completionRatio: retailer?.completionRatio == null ? null : Number(retailer.completionRatio) || 0,
        failureReasons: sanitizeCoverageFailureReasons(retailer?.failureReasons),
      }))
    : null;
  const finiteCoverageField = (field) => {
    const value = meta?.coverage?.[field];
    return Number.isFinite(value) ? { [field]: value } : {};
  };
  const coverage = meta?.coverage && typeof meta.coverage === 'object'
    ? {
        status: typeof meta.coverage.status === 'string' ? meta.coverage.status : null,
        completedPages: Number(meta.coverage.completedPages) || 0,
        failedPages: Number(meta.coverage.failedPages) || 0,
        completionRatio: meta.coverage.completionRatio == null ? null : Number(meta.coverage.completionRatio) || 0,
        rejectedCount: Number(meta.coverage.rejectedCount) || 0,
        ...finiteCoverageField('countrySpecificImportCountryCount'),
        ...finiteCoverageField('globalProductionCommodityCount'),
        ...finiteCoverageField('completeCountryCount'),
        ...finiteCoverageField('currentCountryCount'),
        ...finiteCoverageField('retainedCountryCount'),
        ...finiteCoverageField('oldestCountryCacheWrittenAt'),
        ...finiteCoverageField('rankableCountryCount'),
        ...finiteCoverageField('rankableRecordCount'),
        ...finiteCoverageField('freshRankableRecordCount'),
        ...finiteCoverageField('reviewedCommodityCount'),
        ...finiteCoverageField('reviewedHs4Count'),
        ...finiteCoverageField('reviewedHs2Count'),
        failureReasons: sanitizeCoverageFailureReasons(meta.coverage.failureReasons),
        retailers: coverageRetailers,
      }
    : null;
  const coverageCompletionRatioUsable = Number.isFinite(meta?.coverage?.completionRatio)
    && meta.coverage.completionRatio >= 0
    && meta.coverage.completionRatio <= 1;

  let synthesisFailure = null;
  if (seedCfg.synthesisFailure) {
    const consecutiveFailures = Number.isInteger(meta?.consecutiveFailures)
      && meta.consecutiveFailures >= 0
      ? Math.min(meta.consecutiveFailures, 100)
      : 0;
    const lastAttemptAt = Number.isFinite(Number(meta?.lastAttemptAt)) && Number(meta.lastAttemptAt) > 0
      ? Number(meta.lastAttemptAt)
      : null;
    const lastSuccessAt = Number.isFinite(Number(meta?.lastSuccessAt)) && Number(meta.lastSuccessAt) > 0
      ? Number(meta.lastSuccessAt)
      : null;
    const synthesisFailureAgeMin = lastAttemptAt == null
      ? null
      : Math.round((now - lastAttemptAt) / 60_000);
    // The code vocabulary is per-producer and closed: health echoes this value
    // back to operators, so anything outside the owning key's pattern is
    // dropped rather than relayed.
    const failureCodePattern = seedCfg.synthesisFailure.failureCodePattern
      ?? /^INSIGHTS_SYNTHESIS_(PARSE|GATE|MISSING_CLUSTER|PROVIDER)$/;
    const lastSynthesisFailureCode = typeof meta?.lastSynthesisFailureCode === 'string'
      && failureCodePattern.test(meta.lastSynthesisFailureCode)
      ? meta.lastSynthesisFailureCode
      : null;
    const servedGeneratedAt = typeof meta?.servedGeneratedAt === 'string'
      && meta.servedGeneratedAt.length <= 64
      ? meta.servedGeneratedAt
      : null;
    const warning = consecutiveFailures > 0 && (
      consecutiveFailures >= seedCfg.synthesisFailure.warnAfterConsecutive
      || (synthesisFailureAgeMin != null
        && synthesisFailureAgeMin >= seedCfg.synthesisFailure.warnAfterAgeMin)
      || (seedCfg.synthesisFailure.warnWithoutSuccess && lastSuccessAt == null)
    );
    synthesisFailure = {
      consecutiveFailures,
      lastAttemptAt,
      lastSuccessAt,
      servedGeneratedAt,
      synthesisFailureAgeMin,
      lastSynthesisFailureCode,
      warning,
    };
  }
  // Coarse trade-flows run diagnostic (#6323). Only the seed-supply-chain-trade
  // seeder writes this today; parsing is opt-in per-key via SEED_META entry
  // declaring `dominantFailureMode: true` so no other seed-meta reader changes.
  // The vocabulary is a closed set (health would otherwise relay arbitrary
  // producer free-text into a public endpoint):
  //   run-failed | upstream | empty | incomplete-years | mixed | none
  let dominantFailureMode = null;
  if (seedCfg?.dominantFailureMode && typeof meta?.dominantFailureMode === 'string'
    && TRADE_FLOW_DOMINANT_FAILURE_MODES.has(meta.dominantFailureMode)) {
    dominantFailureMode = meta.dominantFailureMode;
  }
  const chinaRow = projectJodiChinaRow(meta, seedCfg?.chinaRow);
  return {
    hasMeta: meta != null,
    seedFetchedAt: fetchedAt,
    targetLocationsDegraded: meta?.targetLocationsDegraded === true,
    seedAge,
    seedStale,
    seedError: sourceDegraded || failedDatasets.length > 0,
    sourceUnavailable,
    sourceBlocked,
    metaReadFailed: false,
    metaCount,
    metaRankableCount,
    redistributionPolicyVersion,
    poolCounts,
    poolMargins,
    contentAge,
    contentFreshness,
    decisionGroups,
    coverage,
    coverageCompletionRatioUsable,
    errorCode,
    sourceFailure,
    synthesisFailure,
    dominantFailureMode,
    chinaRow,
    workerControl,
    resilienceCacheState,
    failedDatasets,
  };
}

function isCascadeCovered(name, hasData, keyStrens, keyErrors) {
  const siblings = CASCADE_GROUPS[name];
  if (!siblings || hasData) return false;
  for (const sibling of siblings) {
    if (sibling === name) continue;
    const sibKey = STANDALONE_KEYS[sibling] ?? BOOTSTRAP_KEYS[sibling];
    if (!sibKey) continue;
    if (keyErrors.get(sibKey)) continue;
    if (keyHasData(sibKey, keyStrens.get(sibKey) ?? 0)) return true;
  }
  return false;
}

function classifyKey(name, redisKey, opts, ctx) {
  const { keyStrens, keyErrors, keyMetaValues, keyMetaErrors, now } = ctx;
  const seedCfg = SEED_META[name];
  ctx.containmentEvidenceByName?.delete(name);
  // #6095 audited this grace and DELIBERATELY kept it soft when the marker read
  // failed, unlike the content-freshness grace below. What it gates is why:
  //   1. It downgrades exactly the two "no records" verdicts — EMPTY (key
  //      absent) and EMPTY_DATA (key present, zero records), both crit — to
  //      EMPTY_ON_DEMAND. Resolving unknown to "activated" would manufacture a
  //      crit for a key that may genuinely never have run, which is the
  //      deployment-order noise ON_DEMAND_KEYS exists to remove.
  //   2. It never softens a fault that has DATA behind it. Every fault branch is
  //      decided above these two, so an on-demand key that HAS data and goes
  //      stale or errors still falls through to STALE_SEED/SEED_ERROR (see the
  //      ON_DEMAND_KEYS policy block).
  //   3. It is not free, and the cost is bounded rather than absent. For a key
  //      whose marker is ALREADY present, an unreadable marker re-enters the
  //      softening and downgrades EMPTY (crit — #4927's "ran once and died"
  //      alarm) to EMPTY_ON_DEMAND, which scripts/check-seed-freshness.mjs then
  //      excuses. That lasts only as long as the marker is unreadable, and
  //      `entry.activationUnknown` marks every entry softened on unknown state
  //      so the window is visible instead of silent.
  // The content-freshness grace below has none of those bounds, which is why it
  // takes the opposite policy on the same unknown state.
  const isOnDemand = !!opts.allowOnDemand && ON_DEMAND_KEYS.has(name)
    && ctx.activationStates?.get(name) !== true;
  // Unlike ON_DEMAND, runtime rollout windows need no per-registry opt-in
  // (`allowOnDemand`): each window is bounded by a deployment-relative deadline
  // supplied through ctx.rolloutPendingUntilMs and revoked by a durable marker.
  // Soft on an unreadable marker for the same reasons as ON_DEMAND above, plus
  // the deadline: an unknown state can delay strictness only until
  // `rolloutPendingUntil`, so it can never grant a grace that never expires.
  const rolloutPendingUntil = ctx.rolloutPendingUntilMs?.get(name);
  const isRolloutPending = rolloutPendingUntil != null
    && now < rolloutPendingUntil
    && ctx.activationStates?.get(name) !== true;
  // #6095 review: without this the verdict produced from an UNREADABLE marker is
  // byte-identical to the one produced from evidence, so an operator cannot tell
  // "the EXISTS command failed" from "the producer genuinely never published" —
  // two different remediations. This file already treats a failed read as
  // information ops needs (a data/meta read error becomes REDIS_PARTIAL rather
  // than "key missing"); the marker commands are the one read with no status of
  // their own, so they get a flag instead. Emitted for every status, like
  // `onDemand`, and covers BOTH markers a check can consult: its own, and the
  // separate content-freshness marker its seed config names.
  const activationUnknown = Boolean(ctx.activationStates) && [
    ACTIVATION_MARKERS[name] ? name : null,
    seedCfg?.contentFreshnessActivation ?? null,
  ].some((markerName) => markerName !== null && !ctx.activationStates.has(markerName));

  const meta = readSeedMeta(seedCfg, keyMetaValues, keyMetaErrors, now);

  // Per-command Redis errors (data STRLEN or seed-meta GET) propagate as their
  // own bucket — don't conflate with "key missing", since ops needs to know if
  // the read itself failed.
  if (keyErrors.get(redisKey) || meta.metaReadFailed) {
    const entry = { status: 'REDIS_PARTIAL', records: null };
    if (seedCfg) entry.maxStaleMin = seedCfg.maxStaleMin;
    return entry;
  }

  const strlen = keyStrens.get(redisKey) ?? 0;
  const hasData = keyHasData(redisKey, strlen);
  const {
    hasMeta,
    seedAge,
    seedStale,
    seedError,
    sourceUnavailable,
    sourceBlocked,
    metaCount,
    metaRankableCount,
    redistributionPolicyVersion,
    poolCounts,
    poolMargins,
    contentAge,
    contentFreshness,
    decisionGroups,
    coverage,
    coverageCompletionRatioUsable,
    errorCode,
    sourceFailure,
    synthesisFailure,
    dominantFailureMode,
    chinaRow,
    workerControl,
    resilienceCacheState,
    failedDatasets,
  } = meta;
  // A missing marker can result from a swallowed marker write or Redis
  // restore, so it is not enough to establish pre-activation by itself. Grant
  // the on-demand grace only when the marker was read absent and neither the
  // current payload nor readable seed metadata shows a prior publication.
  const isPreActivationOnDemand = isOnDemand
    && !hasData
    && !hasMeta
    && ctx.activationStates?.get(name) === false;
  const rankableRecordCount = metaRankableCount;

  // Pending activation: the producer has never published a contentFreshness
  // block, so this deployment simply predates the feature. Softened only for
  // ABSENCE — a block that is present is always evaluated, and once the marker
  // exists a disappearing block is a regression that fails closed.
  //
  // Grace requires POSITIVE proof (#6095): the marker was READ and came back
  // absent. An unreadable marker is unknown state, not evidence of a producer
  // that never ran, and earns nothing — the same rule api/mcp/freshness.ts and
  // api/seed-health.js apply, so the three surfaces cannot answer differently
  // for one input class. The opposite policy from the ON_DEMAND grace above,
  // and for a reason: this one suppresses an alarm on a key that HAS data and
  // IS running, and its strict verdict is COVERAGE_DEGRADED — "cannot prove
  // content freshness", which an unread marker makes literally true. A grace
  // granted on the absence of evidence never expires, so an UNREADABLE marker
  // would otherwise disable the alarm for good.
  //
  // The clean-absent arm is separately bounded by CONTENT_FRESHNESS_ROLLOUT.
  // A marker that was evicted, renamed, or restored into an empty Redis can
  // therefore delay strictness only until the compiled deadline (#6111).
  const contentFreshnessActivationWindow = seedCfg?.requireContentFreshness
    && contentFreshness
    && !contentFreshness.fieldPresent
    && seedCfg.contentFreshnessActivation
    ? getActiveContentFreshnessActivationWindow(
      ACTIVATION_MARKERS[seedCfg.contentFreshnessActivation],
      ctx.activationStates?.get(seedCfg.contentFreshnessActivation),
      now,
    )
    : null;
  const contentFreshnessPending = contentFreshnessActivationWindow !== null;

  // When the data key is gone the meta count is meaningless; force records=0
  // so we never display the contradictory "EMPTY records=N>0" pair (item 1).
  const records = hasData ? (metaCount ?? 1) : 0;
  const cascadeCovered = isCascadeCovered(name, hasData, keyStrens, keyErrors);

  // Producer-fault candidates, in precedence order among themselves. Each says
  // WHY the producer (or its upstream) is unhappy; none of them says whether
  // anything is actually being SERVED. Resolved up front rather than as if/else
  // arms so the missing-data branch below can weigh them against the absence
  // verdict instead of being pre-empted by them (#6263).
  //
  // Skipped entirely for an unconfigured adapter, which by the NOT_CONFIGURED
  // rule below has nothing to be degraded ABOUT — so it also publishes no cause.
  let fault = null;
  if (!sourceUnavailable) {
    if (sourceBlocked && name !== 'crossStraitActivityJapanMod') {
      // Keep the fleet-wide escape hatch narrow: only the Japan MOD adapter has
      // a reviewed-data contract and explicit two-path proof for this state.
      fault = 'SEED_ERROR';
    }
    else if (sourceBlocked && hasData && records > 0 && seedStale !== true) fault = 'SOURCE_BLOCKED';
    // A producer-failure warning describes degraded-BUT-SERVING — the LKG is
    // still on the page while generation retries.
    else if (synthesisFailure?.warning) fault = 'SEED_ERROR';
    else if (seedError || (sourceFailure?.pendingUntil && !hasData)) fault = 'SEED_ERROR';
  }

  let status;
  // Precedes every fault branch: an adapter this deployment never configured has
  // nothing to be stale, empty, or degraded ABOUT. The producer still writes the
  // key each run (recordCount 0) so operators can see the adapter is dormant, and
  // the moment the credential lands the next run reports sourceState 'ok' and this
  // flips to OK on its own — no health-config change needed.
  if (sourceUnavailable) status = 'NOT_CONFIGURED';
  else if (!hasData) {
    // The absence verdict, decided on its own merits and independently of any
    // fault above. Note the two live SIDE BY SIDE here: seed-meta outlives its
    // data key (7 days vs. hours), so a producer that failed once and then
    // stopped is simultaneously "faulting" and "serving nothing".
    let absent;
    if (cascadeCovered) absent = 'OK_CASCADE';
    // `seedStale !== true` buys the pre-first-publish grace: before the
    // producer's first run the payload is absent through no fault, and every
    // key in this set is also in EMPTY_DATA_OK_KEYS, so the fallthrough reports
    // STALE_SEED (warn) instead of a false-critical EMPTY.
    //
    // A REPORTED FAULT revokes that grace, because it is proof the producer did
    // run. Without the `|| fault` clause this arm reads a fault as aging and
    // hands the key to the EMPTY_DATA_OK arm, whose STALE_SEED merely TIES the
    // fault — so the tie-break returns SEED_ERROR and the key reports warn.
    // That is #6263's own headline case surviving the fix: readSeedMeta
    // SYNTHESIZES `seedStale: true` on the `status:'error'` return as a fault
    // marker rather than measuring it, so all eight of these keys kept the old
    // warn on that path while the sibling `sourceState` path (where staleness
    // IS measured) correctly reported EMPTY. One physical state, two verdicts.
    // Inside a rollout window the absence is explained (fresh metadata from a
    // writer still on the previous key version), so it reads ROLLOUT_PENDING.
    // Assigned here, not by falling through: every key in this set is also in
    // EMPTY_DATA_OK_KEYS, whose arm would read OK.
    else if (MISSING_DATA_IS_FAILURE_KEYS.has(name) && hasMeta && (seedStale !== true || fault)) {
      absent = isRolloutPending ? 'ROLLOUT_PENDING' : 'EMPTY';
    }
    // Ahead of EMPTY_DATA_OK_KEYS only when no readable publication evidence
    // exists. Marker absence alone never overrides normal data/meta semantics.
    else if (isPreActivationOnDemand) absent = 'EMPTY_ON_DEMAND';
    else if (EMPTY_DATA_OK_KEYS.has(name)) absent = seedStale === true ? 'STALE_SEED' : 'OK';
    else if (isOnDemand) absent = 'EMPTY_ON_DEMAND';
    // Deliberately the ONLY branch rollout softening touches: an absent data
    // key is the one state that "the producer has not run since this schema
    // deployed" actually explains. Once the key exists the producer HAS run,
    // and every downstream verdict (EMPTY_DATA, COVERAGE_DEGRADED,
    // COVERAGE_PARTIAL, STALE_SEED) describes what it produced — softening any
    // of those would hide a real first-run failure behind the rollout window.
    else if (isRolloutPending) absent = 'ROLLOUT_PENDING';
    else absent = 'EMPTY';

    // The stronger of the two verdicts wins; ties go to the fault, which is the
    // only one of the pair that carries a cause (`errorCode`,
    // `lastSynthesisFailureCode`).
    //
    // Both directions matter, which is why this is NOT the one-word `&& hasData`
    // guard the fault arms invite:
    //   - absence is CRIT (plain EMPTY): a warn must never mask a blank panel.
    //     A producer that errored once and then stopped otherwise reports warn
    //     for the seed-meta's full 7-day life.
    //   - absence is SOFTER (OK_CASCADE / OK / STALE_SEED / EMPTY_ON_DEMAND /
    //     ROLLOUT_PENDING): the fault holds. Four key classes land here, and a
    //     bare guard would silence or generify every one of them — most sharply
    //     EMPTY_DATA_OK_KEYS, whose absence resolves to plain OK whenever the
    //     fault arrived via `sourceState` (which leaves seedStale false).
    status = fault && statusSeverityRank(absent) <= statusSeverityRank(fault)
      ? fault
      : absent;
  } else if (fault) status = fault;
  else if (records === 0) {
    // hasData is true in this branch, so cascade can never apply (isCascadeCovered
    // short-circuits when hasData=true). Cascade only shields wholly absent keys.
    if (ZERO_RECORD_DATA_OK_KEYS.has(name)) status = seedStale === true ? 'STALE_SEED' : 'OK';
    else if (isOnDemand) status = 'EMPTY_ON_DEMAND';
    else status = 'EMPTY_DATA';
  } else if (seedStale === true) status = 'STALE_SEED';
  else if (
    seedCfg?.requiredRedistributionPolicyVersion != null
    && redistributionPolicyVersion !== seedCfg.requiredRedistributionPolicyVersion
  ) status = 'POLICY_INCOMPATIBLE';
  else if (
    decisionGroups?.coverageFailureInvalidReason
    || decisionGroups?.staleGroups?.length > 0
  ) status = 'COVERAGE_PARTIAL';
  // Coverage threshold: producers that know their canonical shape size can
  // declare minRecordCount. When the writer reports a count below threshold
  // (e.g., 10/13 chokepoints because portwatch dropped some), this degrades
  // to COVERAGE_PARTIAL (warn) instead of reporting OK. Producer must write
  // seed-meta.recordCount using the *covered* count, not the shape size.
  else if (
    seedCfg?.minRecordCount != null &&
    (metaCount == null || metaCount < seedCfg.minRecordCount)
  ) status = 'COVERAGE_PARTIAL';
  else if (
    seedCfg?.minRankableRecordCount != null &&
    (rankableRecordCount == null || rankableRecordCount < seedCfg.minRankableRecordCount)
  ) status = 'COVERAGE_PARTIAL';
  else if (
    seedCfg?.requireVulnerabilityCoverage
    && (!coverage || Object.entries(seedCfg.requireVulnerabilityCoverage)
      .some(([field, floor]) => (
        !Number.isFinite(coverage[field]) || coverage[field] < floor
      )))
  ) status = 'COVERAGE_PARTIAL';
  // Per-pool coverage is independent of aggregate volume. Missing/malformed
  // diagnostics fail closed: without all configured counts health cannot prove
  // that every category consumer has data.
  else if (hasPoolCoverageShortfall(poolCounts, seedCfg?.minPoolCounts)) status = 'COVERAGE_PARTIAL';
  // Success-rate threshold: when the producer writes coverage.completionRatio
  // (consumer-prices publish.ts etc.), flag COVERAGE_DEGRADED if the ratio
  // falls below minSuccessRate. Fires after COVERAGE_PARTIAL so record-count
  // shortfalls take precedence.
  else if (seedCfg?.requireCoverage && !coverage) status = 'COVERAGE_DEGRADED';
  // Per-entity content freshness (#6060). Fails closed BEFORE the staleness
  // verdict is read: a check that declares requireContentFreshness but whose
  // producer wrote no usable block cannot prove anything about its content,
  // and "cannot prove" must never resolve to OK — that is exactly the
  // fresh-transport/complete-cardinality mask this branch exists to remove.
  else if (seedCfg?.requireContentFreshness && !contentFreshness?.usable && !contentFreshnessPending) status = 'COVERAGE_DEGRADED';
  else if (
    seedCfg?.minSuccessRate != null
    && coverage
    && (coverage.completionRatio < seedCfg.minSuccessRate || coverage.status === 'degraded')
  ) status = 'COVERAGE_DEGRADED';
  else if (
    coverage
    // The producer owns the market completion floor. A failed retailer can be
    // a bounded part of an otherwise healthy market; its diagnostics remain on
    // the wire without overriding that aggregate verdict.
    && coverage.status === 'partial'
  ) status = 'COVERAGE_PARTIAL';
  // Content-age check (opt-in via runSeed contentMeta + maxContentAgeMin).
  // Fires AFTER all earlier failure paths so STALE_SEED, COVERAGE_PARTIAL,
  // EMPTY_*, etc. take precedence — STALE_CONTENT is "the seeder is healthy
  // and the data set is sized correctly, but the content itself is older than
  // the seeder's content-age budget".
  // The opt-in signal is contentAge being non-null in seed-meta (presence of
  // meta.maxContentAgeMin); legacy seeders without it skip this branch.
  // 2026-05-04 health-readiness plan, Sprint 1.
  else if (contentAge && contentAge.contentStale) status = 'STALE_CONTENT';
  // Pre-breach lead time (reader policy, see CONTENT_AGE_PREWARNING_RATIO in
  // api/_content-age.js). Fires only after every hard fault declined and
  // before COVERAGE_MARGIN_LOW, which is informational: an approaching time
  // breach outranks a thin-but-passing cohort. Rides the compact pending lane
  // via the STATUS_COUNTS/healthStatusBucket pattern — visible, non-blocking.
  else if (contentAge && contentAge.preWarning) status = 'CONTENT_AGE_PREWARNING';
  // Shares STALE_CONTENT with the newestItemAt branch above: both mean "the
  // producer is healthy and correctly sized, but the data itself is older than
  // its content budget". Here the stale unit is a country rather than the
  // whole corpus, and the named entities are on the wire so an operator sees
  // the stale source family instead of a generic warning.
  else if (contentFreshness?.contentStale) status = 'STALE_CONTENT';
  // Last in the chain, and only reachable when every fault branch above
  // declined: this says "nothing is wrong, but a pool is close to its floor".
  // Placing it here is what keeps it from masking a real verdict — a stale or
  // shortfalling cohort must never be reported as merely thin.
  else if (poolMargins && Object.values(poolMargins).some((pool) => pool.low)) status = 'COVERAGE_MARGIN_LOW';
  else status = 'OK';

  const entry = { status, records };
  // Target locations are optional; expose their failure without changing status.
  if (name === 'ddosAttacks' && meta.targetLocationsDegraded) entry.targetLocationsDegraded = true;
  // Source-level on-demand marker: "this key is RPC-populated or awaiting its
  // first producer run", NOT "any failure here is acceptable". The status suffix
  // (`EMPTY_ON_DEMAND`) cannot carry that, because it only covers the
  // absent/zero-record branches — an on-demand key that HAS data and goes stale
  // falls through to plain STALE_SEED. Emitted for every status so a consumer
  // can combine source and status; deciding WHICH statuses the marker excuses is
  // the consumer's call, and scripts/check-seed-freshness.mjs deliberately
  // excuses only the empty/absent ones (see ON_DEMAND_SOFT_STATUSES there —
  // softening SEED_ERROR/STALE_SEED is the marketImplications blind spot the
  // ON_DEMAND_KEYS policy block above exists to prevent).
  if (isOnDemand) entry.onDemand = true;
  // See the activationUnknown derivation above. Never softens or hardens
  // anything by itself — it only says which evidence the verdict rests on.
  if (activationUnknown) entry.activationUnknown = true;
  // Publish the deadline with the state so the softening is auditable from the
  // payload alone — an operator (and scripts/check-seed-freshness.mjs) can see
  // exactly when this key stops being excused without reading api/health.js.
  if (status === 'ROLLOUT_PENDING') entry.rolloutPendingUntil = new Date(rolloutPendingUntil).toISOString();
  if (contentFreshnessActivationWindow) {
    entry.contentFreshnessPendingUntil = new Date(contentFreshnessActivationWindow.untilMs).toISOString();
  }
  // Activation is emitted for EVERY status on a rollout-registered key, not just
  // the pending one — `rolloutPendingUntil` exists precisely when the market has
  // NOT activated, so on its own it can never answer "which markets have gone
  // live?". Without this, auditing rollout progress (or telling
  // "activated-then-broke" apart from "never ran") means EXISTS-probing Redis by
  // hand. ctx.activationStates already holds the answer at classify time.
  // Reported as "read AND present", so an unreadable marker publishes `false` —
  // the same soft-on-unknown reading `isRolloutPending` takes above, kept
  // aligned so this flag can never contradict the status it accompanies.
  if (rolloutPendingUntil != null) {
    entry.activated = ctx.activationStates?.get(name) === true;
  }
  if (seedAge !== null) entry.seedAgeMin = seedAge;
  if (seedCfg) entry.maxStaleMin = seedCfg.maxStaleMin;
  if (seedCfg?.minRecordCount != null) entry.minRecordCount = seedCfg.minRecordCount;
  if (seedCfg?.minRankableRecordCount != null) {
    entry.rankableRecordCount = rankableRecordCount;
    entry.minRankableRecordCount = seedCfg.minRankableRecordCount;
  }
  if (seedCfg?.minPoolCounts) entry.minPoolCounts = seedCfg.minPoolCounts;
  if (seedCfg?.requiredRedistributionPolicyVersion != null) {
    entry.redistributionPolicyVersion = redistributionPolicyVersion;
    entry.requiredRedistributionPolicyVersion = seedCfg.requiredRedistributionPolicyVersion;
  }
  if (seedCfg?.requireVulnerabilityCoverage) {
    entry.requiredVulnerabilityCoverage = seedCfg.requireVulnerabilityCoverage;
  }
  if (poolCounts) entry.poolCounts = poolCounts;
  // Emitted for every status, not just COVERAGE_MARGIN_LOW: the headroom on a
  // healthy cohort is the whole point, and a consumer trending it needs the
  // comfortable readings too, not only the thin ones.
  if (poolMargins) entry.poolCoverageMargin = poolMargins;
  if (seedCfg?.poolCountMargin != null) entry.poolCountMargin = seedCfg.poolCountMargin;
  if (coverage || seedCfg?.requireCoverage) entry.coverage = coverage;
  // Emitted whenever the producer recorded a cause, not only when the fault
  // verdict WON. When a missing data key outranks the fault (#6263) the status
  // becomes EMPTY, and gating the code on SEED_ERROR would trade the operator's
  // "why" for the severity bump — leaving a bare crit whose explanation is
  // sitting unread in seed-meta.
  if ((fault === 'SEED_ERROR' || sourceFailure) && errorCode) entry.errorCode = errorCode;
  if (sourceFailure) {
    if (sourceFailure.consecutiveSourceFailures !== null) {
      entry.consecutiveSourceFailures = sourceFailure.consecutiveSourceFailures;
    }
    if (sourceFailure.lastSourceFailureCode) {
      entry.lastSourceFailureCode = sourceFailure.lastSourceFailureCode;
    }
    if (sourceFailure.pendingUntil) {
      if (status === 'OK' && hasData && records > 0 && metaCount > 0 && seedStale === false) {
        entry.status = 'SEED_ERROR';
        entry.sourceFailurePendingUntil = sourceFailure.pendingUntil;
      }
    } else if (sourceFailure.pending) entry.sourceFailurePending = true;
  }
  // Coarse producer-run diagnostic, relayed whenever the producer recorded it —
  // the whole point of #6323 is that a coverage shortfall's dominant cause is
  // visible on /api/health without Railway logs or a raw index read, so gating
  // it on the fault verdict would hide exactly the "healthy-looking partial"
  // case. Mirrors the ungated synthesisFailure emission below.
  if (dominantFailureMode) entry.dominantFailureMode = dominantFailureMode;
  // Ungated for the same reason as dominantFailureMode: the point of #6395 is
  // that "China dropped out of JODI" is legible from /api/health on a dataset
  // that is otherwise publishing normally. Gating it on a fault verdict would
  // hide exactly the healthy-looking-partial case it exists to describe.
  if (chinaRow) entry.chinaRow = chinaRow;
  // Closed, bounded projection from the worker's seed-meta. It contains only
  // control-loop state and counters, never work or customer identifiers.
  if (workerControl) entry.workerControl = workerControl;
  const claimFailure = workerControl?.subsystems?.scan?.claimFailure;
  if (entry.status === 'SEED_ERROR' && hasData && records > 0
    && workerControl?.status === 'error' && workerControl.outcome === 'claim_error'
    && workerControl.subsystems.scan.status === 'error'
    && workerControl.subsystems.admission.status === 'ok'
    && ['disabled', 'idle', 'admission_recorded', 'admission_replayed'].includes(workerControl.subsystems.admission.outcome)
    && claimFailure?.consecutiveFailures >= 1 && claimFailure.consecutiveFailures < 3
    && ((['timeout', 'network'].includes(claimFailure.kind) && claimFailure.httpStatus === null)
      || (claimFailure.kind === 'http_transient' && [408, 429, 500, 502, 503, 504].includes(claimFailure.httpStatus)))
    && claimFailure.lastHealthyAt !== null && claimFailure.lastHealthyAt <= now) {
    const deadline = claimFailure.lastHealthyAt + seedCfg.maxStaleMin * 60_000;
    if (now < deadline) entry.workerControlPendingUntil = new Date(deadline).toISOString();
  }
  if (resilienceCacheState) entry.cacheState = resilienceCacheState;
  if (failedDatasets?.length > 0) entry.failedDatasets = failedDatasets;
  // Surface content-age fields when seeder opted in (presence of
  // meta.maxContentAgeMin). Operators can distinguish "stale content" from
  // "stale seeder run" at a glance.
  if (contentAge) {
    entry.contentAgeMin = contentAge.contentAgeMin;          // null when contentMeta returned null
    entry.maxContentAgeMin = contentAge.maxContentAgeMin;
    if (status === 'CONTENT_AGE_PREWARNING' && contentAge.preWarning) {
      entry.warnAtContentAgeMin = contentAge.preWarning.warnAtContentAgeMin;
      entry.contentAgeRemainingMin = contentAge.preWarning.remainingContentAgeMin;
      if (contentAge.preWarning.breachAt) entry.contentAgeBreachAt = contentAge.preWarning.breachAt;
    }
  }
  // Publish the per-entity block whenever the check requires it — including
  // the unusable case, so "the producer stopped writing this" is diagnosable
  // from the health response rather than only from a bare COVERAGE_DEGRADED.
  if (contentFreshness && !contentFreshnessPending) {
    entry.contentFreshness = projectContentFreshnessForWire(contentFreshness);
  }
  if (decisionGroups) entry.decisionGroups = decisionGroups;
  if (synthesisFailure) {
    entry.consecutiveFailures = synthesisFailure.consecutiveFailures;
    if (synthesisFailure.lastAttemptAt != null) entry.lastAttemptAt = synthesisFailure.lastAttemptAt;
    if (synthesisFailure.lastSuccessAt != null || synthesisFailure.consecutiveFailures > 0) {
      entry.lastSuccessAt = synthesisFailure.lastSuccessAt;
    }
    if (synthesisFailure.servedGeneratedAt != null) entry.servedGeneratedAt = synthesisFailure.servedGeneratedAt;
    if (synthesisFailure.synthesisFailureAgeMin != null && synthesisFailure.consecutiveFailures > 0) {
      entry.synthesisFailureAgeMin = synthesisFailure.synthesisFailureAgeMin;
    }
    // Ungated, unlike `errorCode` above: this one rides with the rest of the
    // synthesis diagnostics, which are all published whenever the producer
    // recorded them regardless of the verdict. Gating only the code while
    // `consecutiveFailures` and `lastAttemptAt` publish freely would be the
    // odd one out — and the whole point of those fields is to describe the run
    // even when the status describes a healthy served payload.
    if (synthesisFailure.lastSynthesisFailureCode) {
      entry.lastSynthesisFailureCode = synthesisFailure.lastSynthesisFailureCode;
    }
  }
  // Diagnostic precedence must not skip a reader requirement: every required
  // proof is checked here, even when an earlier stale/error verdict won. This
  // proves that the current request found a real served payload; freshness is
  // deliberately left to the unchanged diagnostic status.
  ctx.containmentEvidenceByName?.set(name, {
    status,
    records: hasData ? metaCount : null,
    usable: Number.isFinite(seedAge) && seedAge >= 0
      && Number.isFinite(meta.seedFetchedAt) && meta.seedFetchedAt > 0 && meta.seedFetchedAt <= now
      && (!synthesisFailure?.servedGeneratedAt || Date.parse(synthesisFailure.servedGeneratedAt) <= now)
      && (seedCfg?.requiredRedistributionPolicyVersion == null
        || redistributionPolicyVersion === seedCfg.requiredRedistributionPolicyVersion)
      && !decisionGroups?.coverageFailureInvalidReason
      && (seedCfg?.minRankableRecordCount == null || rankableRecordCount != null)
      && (!seedCfg?.requireVulnerabilityCoverage || (coverage
        && Object.keys(seedCfg.requireVulnerabilityCoverage)
          .every((field) => Number.isFinite(coverage[field]))))
      && (!seedCfg?.minPoolCounts || poolCounts !== null)
      && (!seedCfg?.requireCoverage || coverage !== null)
      && (!coverage || seedCfg?.minSuccessRate == null || coverageCompletionRatioUsable)
      && (!seedCfg?.requireContentFreshness || contentFreshness?.usable || contentFreshnessPending)
      && (!contentAge || (Number.isFinite(contentAge.newestItemAt) && contentAge.newestItemAt <= now
        && Number.isFinite(contentAge.contentAgeMin) && contentAge.contentAgeMin >= 0))
      && resilienceCacheState?.ok !== false
      // These records include missing/stale input placeholders. A positive
      // count alone cannot prove that the reader serves a usable index.
      && !seedCfg?.enforceInputFreshUntil,
  });
  return entry;
}

const STATUS_COUNTS = {
  OK: 'ok',
  OK_CASCADE: 'ok',
  // An optional source adapter this deployment never supplied a credential for
  // (producer wrote sourceState:'unavailable'). Buckets to `ok` because there is
  // no fault and no operator action that would clear it other than opting in.
  // Must stay registered here: the summary does `STATUS_COUNTS[status] ?? 'warn'`,
  // so an unlisted status would silently re-become the warn this exists to stop.
  NOT_CONFIGURED: 'ok',
  // The producer ran and classified an external transport refusal with a
  // documented reason. Retained reviewed data remains usable, and retrying the
  // same bounded paths cannot clear it, so this is informational rather than a
  // fleet-health warning.
  SOURCE_BLOCKED: 'ok',
  // Every configured pool is ABOVE its floor, but at least one is within
  // `poolCountMargin` of it. Buckets to `ok` on purpose: for probes whose
  // health minimums equal the producer's publication floors, a passing cohort
  // sitting a few records above the line is the normal steady state, so warning
  // on it would flip fleet health to WARNING indefinitely and train operators
  // to ignore it. The margin is carried as data on the entry
  // (`poolCoverageMargin`) for dashboards and trend queries; an actual breach
  // is still COVERAGE_PARTIAL (warn), and a producer that stops publishing
  // still goes STALE_SEED (warn). Registered here rather than left out because
  // the summary does `STATUS_COUNTS[status] ?? 'warn'` — omitting it would
  // silently produce exactly the warn this status exists to avoid.
  COVERAGE_MARGIN_LOW: 'ok',
  STALE_SEED: 'warn',
  SEED_ERROR: 'warn',
  EMPTY_ON_DEMAND: 'warn',
  REDIS_PARTIAL: 'warn',
  COVERAGE_PARTIAL: 'warn',
  COVERAGE_DEGRADED: 'warn',
  // The stored cohort is present but every current reader rejects it. Treat
  // this like an unavailable schema, not reduced-but-serving coverage.
  POLICY_INCOMPATIBLE: 'crit',
  // Content-age signal — seeder is healthy but upstream stopped publishing.
  // Operator can't fix upstream cadence, so de-rank vs. STALE_SEED in alerting
  // (both bucket to 'warn' — overall status is `degraded`, not `critical`).
  // 2026-05-04 health-readiness plan, Sprint 1.
  STALE_CONTENT: 'warn',
  // Registered as warn (required: unlisted statuses re-become warn) and
  // bucketed ok below, so the pre-warning rides the compact pending lane
  // without flipping fleet health or paging. Same pattern as the bounded
  // STALE_CONTENT grace and relay transport grace.
  CONTENT_AGE_PREWARNING: 'warn',
  // Bounded deploy-before-cron window (#6059): the schema is live but its
  // producer has not reached its first scheduled run yet. Warn — NOT ok — so
  // the interim state is visible and flips `overall` to WARNING; and NOT
  // subtracted from realWarnCount the way EMPTY_ON_DEMAND is, because unlike
  // an unrequested RPC cache this one is on a clock and must be watched.
  ROLLOUT_PENDING: 'warn',
  CHINA_DEGRADED: 'warn',
  CHINA_UNAVAILABLE: 'crit',
  EMPTY: 'crit',
  EMPTY_DATA: 'crit',
  // Tenant-relay gateway gate (probeRelayGatewayGate). Both crit statuses mean
  // notification channels are dead right now:
  // MISCONFIGURED is the Vercel half of #8208 (the build cannot see the
  // secret), REJECTED is the Convex half (the deployed gate does not admit
  // it). UNREACHABLE is a transport verdict, not a credential one, and stays
  // a warning so a single Convex blip inside one 60 s snapshot does not page.
  RELAY_GATE_MISCONFIGURED: 'crit',
  RELAY_GATE_REJECTED: 'crit',
  RELAY_GATE_UNREACHABLE: 'warn',
};

function healthStatusBucket(entry, now) {
  // Content-age pre-warning is advisory lead time, not a fault: pending and
  // visible, but the aggregate verdict stays healthy until the content is
  // actually stale. Must never read or claim stale-content grace state; the
  // post-breach grace belongs to STALE_CONTENT only.
  if (entry?.status === 'CONTENT_AGE_PREWARNING') return 'ok';
  if (['COVERAGE_PARTIAL', 'CHINA_DEGRADED'].includes(entry?.status)
    && typeof entry.chinaCoveragePendingUntil === 'string'
    && !isExpiredDeadline(entry.chinaCoveragePendingUntil, now)) return 'ok';
  if (entry?.status === 'SEED_ERROR'
    && [entry.sourceFailurePendingUntil, entry.workerControlPendingUntil]
      .some(deadline => typeof deadline === 'string' && !isExpiredDeadline(deadline, now))) return 'ok';
  if (
    entry?.status === 'STALE_CONTENT'
    && Object.prototype.hasOwnProperty.call(entry, 'staleContentGraceUntil')
    && !isExpiredDeadline(entry.staleContentGraceUntil, now)
  ) return 'ok';
  // A relay transport blip is pending, not a problem, until its bounded
  // grace passes (RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS).
  if (
    entry?.status === 'RELAY_GATE_UNREACHABLE'
    && typeof entry.transportGraceUntil === 'string'
    && !isExpiredDeadline(entry.transportGraceUntil, now)
  ) return 'ok';
  return STATUS_COUNTS[entry?.status] ?? 'warn';
}

const CONTAINMENT_ELIGIBLE_STATUSES = new Set([
  'STALE_SEED',
  'SEED_ERROR',
  'STALE_CONTENT',
  'COVERAGE_PARTIAL',
  'COVERAGE_DEGRADED',
  'CHINA_DEGRADED',
]);

function isContainedHealthWarning(entry, evidence, now = Date.now()) {
  return healthStatusBucket(entry, now) === 'warn'
    && CONTAINMENT_ELIGIBLE_STATUSES.has(entry?.status)
    && Number.isFinite(entry?.records)
    && (entry.records > 0 || (entry.records === 0 && evidence?.confirmedEmpty === true))
    && evidence?.status === entry.status
    && evidence.records === entry.records
    && evidence.usable === true
    && (entry.containmentUntil === undefined || !isExpiredDeadline(entry.containmentUntil, now))
    && entry.readModelReady !== false;
}



// Orders the buckets above so classifyKey can compare two candidate verdicts
// rather than hard-coding which statuses outrank which. Reading severity from
// STATUS_COUNTS keeps the two in step: a status registered there becomes
// comparable here for free.
const STATUS_SEVERITY_RANK = { ok: 0, warn: 1, crit: 2 };

// Unregistered statuses fall back to 'warn', exactly as the summary does with
// `STATUS_COUNTS[status] ?? 'warn'`. Without the fallback an unregistered
// status would rank `undefined`, which compares false against every other rank
// — so it would silently LOSE every comparison rather than fail closed.
function statusSeverityRank(status) {
  return STATUS_SEVERITY_RANK[STATUS_COUNTS[status] ?? 'warn'];
}






function parseHealthVerdictSnapshot(raw, now, { requireChecks = true, maxAgeMs = HEALTH_VERDICT_SNAPSHOT_TTL_MS } = {}) {
  if (typeof raw !== 'string') return null;
  const snapshot = parseRedisValue(raw);
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (typeof snapshot.status !== 'string' || typeof snapshot.checkedAt !== 'string') return null;
  if (!snapshot.summary || typeof snapshot.summary !== 'object') return null;
  // The compact snapshot deliberately has no `checks` map — that omission IS the
  // 20 KB saving. Only the full snapshot must carry one.
  if (requireChecks && (!snapshot.checks || typeof snapshot.checks !== 'object')) return null;

  const checkedAtMs = Date.parse(snapshot.checkedAt);
  const ageMs = now - checkedAtMs;
  // Redis expiry is the primary bound; this is a defensive guard against a
  // malformed/manual snapshot write or a future TTL regression.
  if (!Number.isFinite(checkedAtMs) || ageMs < 0 || ageMs > maxAgeMs) return null;
  return snapshot;
}

async function releaseHealthVerdictRefreshLock(lockToken) {
  if (!lockToken) return;
  // The lock key is already deployment-prefixed via healthVerdictRedisKey —
  // send the command verbatim (#7674).
  await redisPipeline([[
    'EVAL',
    HEALTH_VERDICT_RELEASE_LOCK_SCRIPT,
    '1',
    HEALTH_VERDICT_REFRESH_LOCK_KEY,
    lockToken,
  ]], 4_000, true).catch(() => null);
}

// Single source of truth for "is this check a problem?", shared by the compact
// `problems` map and the failure log. Derived from STATUS_COUNTS rather than a
// hardcoded status list: any status that buckets to `ok` is by definition not a
// problem, so adding a new ok-bucket status (NOT_CONFIGURED) can never again
// leave one problem surface silently reporting it. An unregistered status is
// treated as a problem, matching the summary's `STATUS_COUNTS[s] ?? 'warn'`.
function isProblemStatus(status) {
  return STATUS_COUNTS[status] !== 'ok';
}

function isPendingHealthEntry(entry, now) {
  return isProblemStatus(entry?.status) && healthStatusBucket(entry, now) === 'ok';
}

/**
 * True when a cached verdict still carries a health softening whose published
 * deadline has passed. Reads both snapshot shapes:
 * the full one keyed by `checks`, the compact one by `problems` and `pending`.
 */
function isExpiredDeadline(raw, now) {
  const until = Date.parse(typeof raw === 'string' ? raw : '');
  // An unparseable deadline is treated as expired: a pending entry that
  // cannot prove it is still inside its window must not be served warm.
  return !Number.isFinite(until) || now >= until;
}

// Every per-entry softening deadline a snapshot can carry, in one place. Both
// readers below walk this table instead of repeating a `hasOwnProperty` +
// `isExpiredDeadline` block per field, so adding another softening is one
// entry here rather than more near-identical branches that can drift apart.
//
// `kind` decides which `hasExpiredActivationGrace` toggle governs the field.
// `status` pins a field to one status where the field alone is not proof:
// `rolloutPendingUntil` only softens a ROLLOUT_PENDING entry, whereas the two
// content deadlines are emitted precisely when they apply.
const ENTRY_SOFTENING_DEADLINES = [
  { field: 'rolloutPendingUntil', kind: 'rollout', status: 'ROLLOUT_PENDING' },
  { field: 'contentFreshnessPendingUntil', kind: 'content', status: null },
  { field: 'staleContentGraceUntil', kind: 'content', status: null },
  { field: 'sourceFailurePendingUntil', kind: 'source', status: 'SEED_ERROR' },
  { field: 'workerControlPendingUntil', kind: 'source', status: 'SEED_ERROR' },
  { field: 'chinaCoveragePendingUntil', kind: 'source', status: null },
  { field: 'containmentUntil', kind: 'source', status: null },
  { field: 'transportGraceUntil', kind: 'source', status: 'RELAY_GATE_UNREACHABLE' },
];

function entryDeadlineRaw(entry, { field, status }) {
  if (status !== null) return entry?.status === status ? entry[field] : undefined;
  return Object.prototype.hasOwnProperty.call(entry ?? {}, field) ? entry[field] : undefined;
}

function snapshotCheckEntries(snapshot) {
  return [snapshot?.checks ?? snapshot?.problems, snapshot?.pending]
    .filter((entries) => entries && typeof entries === 'object')
    .flatMap((entries) => Object.values(entries));
}

function hasExpiredActivationGrace(snapshot, now, { includeRollout = true, includeContent = true } = {}) {
  const included = { rollout: includeRollout, content: includeContent, source: true };
  for (const entry of snapshotCheckEntries(snapshot)) {
    for (const spec of ENTRY_SOFTENING_DEADLINES) {
      if (!included[spec.kind]) continue;
      const raw = entryDeadlineRaw(entry, spec);
      if (raw !== undefined && isExpiredDeadline(raw, now)) return true;
    }
  }
  if (includeContent) {
    const summaryDeadlines = snapshot?.summary?.contentFreshnessPendingUntil;
    if (summaryDeadlines && typeof summaryDeadlines === 'object') {
      for (const deadline of Object.values(summaryDeadlines)) {
        if (isExpiredDeadline(deadline, now)) return true;
      }
    }
  }
  return false;
}

/**
 * The earliest activation deadline this snapshot promises, or Infinity when it
 * promises none. A malformed deadline resolves to `now` — the same fail-closed
 * reading isExpiredDeadline applies — so a corrupt value shortens the TTL
 * instead of pinning a snapshot no reader will accept.
 */
function nearestActivationDeadlineMs(snapshot, now) {
  let nearest = Infinity;
  const consider = (raw) => {
    const parsed = Date.parse(typeof raw === 'string' ? raw : '');
    const deadline = Number.isFinite(parsed) ? parsed : now;
    if (deadline < nearest) nearest = deadline;
  };
  for (const entry of snapshotCheckEntries(snapshot)) {
    for (const spec of ENTRY_SOFTENING_DEADLINES) {
      const raw = entryDeadlineRaw(entry, spec);
      if (raw !== undefined) consider(raw);
    }
  }
  const summaryDeadlines = snapshot?.summary?.contentFreshnessPendingUntil;
  if (summaryDeadlines && typeof summaryDeadlines === 'object') {
    for (const deadline of Object.values(summaryDeadlines)) consider(deadline);
  }
  return nearest;
}

/**
 * Cache lifetime for a verdict snapshot: the normal 60s, SHORTENED so the entry
 * cannot outlive any softening deadline it publishes.
 *
 * Expire at the deadline instead of retaining a softened verdict that every
 * reader must reject through hasExpiredActivationGrace. The next request
 * elects a refresher; concurrent waiters use its result or the retained last-known verdict.
 *
 * Floor, never ceil: the entry must die at or before the deadline, not after.
 * Redis EX has a 1s granularity, so a sub-second overhang remains possible —
 * which is why hasExpiredActivationGrace stays as the read-side backstop rather
 * than being replaced by this.
 */
function snapshotTtlSeconds(snapshot, now) {
  const nearest = nearestActivationDeadlineMs(snapshot, now);
  if (nearest === Infinity) return HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS;
  const secondsUntilDeadline = Math.floor((nearest - now) / 1_000);
  return Math.min(HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS, Math.max(1, secondsUntilDeadline));
}

/**
 * Bucket counts -> the endpoint's overall verdict.
 *
 * Extracted from the handler so it is reachable from tests. It used to be inline
 * arithmetic that only a replica in the test file asserted, which meant the
 * load-bearing severity claims — that EMPTY_ON_DEMAND is excused and that
 * ROLLOUT_PENDING is NOT — were pinned against a copy rather than against this
 * code. Subtracting a new bucket here would have kept every test green.
 *
 * `realWarnCount` preserves the diagnostic warning census by subtracting only
 * on-demand misses. Availability then subtracts the explicit contained subset;
 * those defects stay actionable in `summary.warn` and `problems`.
 * ROLLOUT_PENDING is never contained (#6059): it stays availability-affecting
 * until its deadline promotes a missing payload to critical.
 */
// ── Tenant-relay gateway gate probe (#8208 / #8217) ──────────────────────
//
// #8208 took checkout, the customer portal and notification channels down for
// nine hours while every credential existed in the right store: the Vercel
// build predated CONVEX_TENANT_RELAY_SECRET, so `create-checkout` answered its
// env-missing 503 before reaching Convex, and the Convex deploy predated it
// too, so every `/relay/*` route answered 401. Presence in a store proves
// nothing; only the deployed gate admitting the deployed secret does.
//
// So the sweep sends ONE credentialed, body-less POST to the gateway-role
// route. The relay's own contract makes that safe and decisive
// (convex/http.ts `authorizeTenantRelay` → `parseJsonObjectBody`): a wrong or
// missing bearer is `401 UNAUTHORIZED`; an admitted bearer with `{}` is
// `400 MISSING_FIELDS`, returned before any Convex mutation runs. Anything
// else — network error, timeout, 5xx, an unexpected 200 — is a transport
// verdict (`RELAY_GATE_UNREACHABLE`, warn), never a credential one, so a
// Convex stall cannot read as "credential fine" and a credential fault cannot
// hide behind a stall.
//
// Cost: the probe lives inside the verdict recompute, which the snapshot TTL
// and refresh lock already bound to one run per 60 s regardless of poll
// volume (~115k `?compact=1` reads/day), and it is skipped entirely when the
// gateway env is absent outside production (previews, local, the existing
// test suites). On a production build a missing var is itself the fault.
//
// Counted in `summary.total` whenever it applies, so the endpoint's partition
// invariant (`ok + warn + onDemandWarn + crit == total`) holds; the published
// examples stay pinned to the registry size by the docs-stats gate and the
// docs state that a production build reports one more. Its verdict lands in
// compact `problems`, which is what the 15-minute seed-freshness monitor
// fails on (scripts/check-seed-freshness.mjs findOperationalProblems).
const RELAY_GATEWAY_GATE_CHECK_NAME = 'relayGatewayGate';
const RELAY_GATEWAY_GATE_ROUTE = '/relay/notification-channels';
const RELAY_GATEWAY_GATE_TIMEOUT_MS = 4_000;
const RELAY_GATEWAY_GATE_USER_AGENT = 'worldmonitor-health-relay-gate/1.0';

// The same resolution the gateway uses (api/notification-channels.ts):
// CONVEX_SITE_URL, or
// the `.convex.site` twin of CONVEX_URL. A deployment configured through
// CONVEX_URL alone is a supported shape and must not read as misconfigured.
function resolveRelayGatewaySiteUrl() {
  return process.env.CONVEX_SITE_URL
    ?? (process.env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
}

/** Names of the gateway inputs this deployment lacks, in RELAY_GATEWAY_GATE_ENV terms. */
function relayGatewayGateMissingEnv() {
  const missing = [];
  if (!resolveRelayGatewaySiteUrl()) missing.push('CONVEX_SITE_URL');
  if (!process.env.CONVEX_TENANT_RELAY_SECRET) missing.push('CONVEX_TENANT_RELAY_SECRET');
  return missing;
}
// Last probe verdict, shared by every concurrent sweep. TTL equals the verdict
// snapshot TTL so the gate is re-asked exactly as often as the verdict itself.
// Scoped per deployment exactly like the verdict snapshot keys: preview and
// production share one Upstash, so a preview's verdict or lease must never be
// reused by production, nor a production verdict read by a preview.
// `healthVerdictRedisKey` folds VERCEL_ENV and the commit SHA in, and these
// keys are sent verbatim (no `sweepKey` prefixing), the same as the snapshot.
const RELAY_GATEWAY_GATE_PROBE_KEY = healthVerdictRedisKey(
  'health:relay-gate:v1',
  process.env.VERCEL_ENV,
  process.env.VERCEL_GIT_COMMIT_SHA,
);
const RELAY_GATEWAY_GATE_PROBE_TTL_SECONDS = HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS;
// Transport grace. A single timeout or 5xx from the relay is not yet evidence
// of anything: the first RELAY_GATE_UNREACHABLE verdict carries a
// `transportGraceUntil` deadline during which it buckets as `ok` (compact
// `pending`), and only a stall that is still there when the deadline passes
// becomes an operational problem. Three verdict windows is enough for one
// blip to clear and short enough that a real outage still pages inside the
// monitor's 15-minute cadence. The verdict is kept in Redis for the grace
// PLUS the freshness window (freshness is judged on `evaluatedAt`, not the
// Redis TTL) so the streak survives between windows.
const RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS = 3 * 60 * 1_000;
// The streak must survive at least one operational-monitor interval with NO
// other traffic: `seed-freshness-monitor.yml` polls every 15 minutes, and if
// the previous verdict had already expired by then, every run would see a
// "first sighting", mint a fresh grace and park a dead relay in `pending`
// forever. Retention = freshness window + grace + one monitor interval +
// slack; freshness itself is still judged on `evaluatedAt`.
const SEED_FRESHNESS_MONITOR_INTERVAL_MS = 15 * 60 * 1_000;
const RELAY_GATEWAY_GATE_PROBE_RETENTION_SECONDS =
  RELAY_GATEWAY_GATE_PROBE_TTL_SECONDS
  + (RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS + SEED_FRESHNESS_MONITOR_INTERVAL_MS + 60_000) / 1_000;

/** The previous verdict regardless of freshness, for streak continuity. */
function parsePreviousRelayGatewayGate(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && typeof parsed.status === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function withTransportGrace(fresh, previous, now) {
  if (fresh.status !== 'RELAY_GATE_UNREACHABLE') return fresh;
  // The streak anchor survives its own deadline: after the grace lapses it
  // rides in `transportGraceExpiredAt`, so an unbroken run of unreachable
  // verdicts reads as one continuous outage for as long as the predecessor is
  // retained (RELAY_GATEWAY_GATE_PROBE_RETENTION_SECONDS); a gap longer than
  // that evicts it and the next sighting is a first one.
  // Only an unreachable predecessor is carried — any other verdict in between
  // (including OK) clears the anchor, and the next failure is a first
  // sighting that earns a fresh grace.
  const carried = previous?.status === 'RELAY_GATE_UNREACHABLE'
    ? [previous.transportGraceUntil, previous.transportGraceExpiredAt]
      .find((raw) => typeof raw === 'string' && Number.isFinite(Date.parse(raw))) ?? null
    : null;
  const deadline = carried ?? new Date(now + RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS).toISOString();
  // Publish it as a softening deadline ONLY while it is still in force.
  // `transportGraceUntil` is registered in ENTRY_SOFTENING_DEADLINES, so an
  // expired one makes hasExpiredActivationGrace reject every snapshot that
  // carries it and snapshotTtlSeconds clip the TTL to a second — turning a
  // persistent relay outage into a full Redis sweep on every single health
  // poll instead of one warm read (#8282 review). The relay itself is not
  // re-probed at that rate: readOrProbeRelayGatewayGate reuses a cached
  // verdict inside its own freshness window before it ever takes the lease.
  // That holds whenever a reusable verdict is in the cache — so not when the
  // stored record is an unprobed follower fallback, and not when a probe's
  // own publish failed. Both leave the next sweep to probe again.
  return isExpiredDeadline(deadline, now)
    ? { ...fresh, transportGraceExpiredAt: deadline }
    : { ...fresh, transportGraceUntil: deadline };
}

function parseCachedRelayGatewayGate(raw, now) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.status !== 'string') return null;
  // A persisted follower fallback is a predecessor for the grace streak,
  // never a verdict to serve warm: nobody probed, so the next sweep must.
  if (parsed.probed === false) return null;
  const evaluatedAt = Date.parse(parsed.evaluatedAt ?? '');
  if (!Number.isFinite(evaluatedAt) || evaluatedAt > now) return null;
  if (now - evaluatedAt >= RELAY_GATEWAY_GATE_PROBE_TTL_SECONDS * 1_000) return null;
  return parsed;
}

// The owner's publish is guarded by its lease token (KEYS[1] = lease,
// KEYS[2] = verdict): an owner paused past its 10 s lease resumes to find a
// successor that already probed and published, and an unconditional SET here
// would let its OLDER verdict overwrite the newer one — an old OK masking a
// new rejection, or an old failure replacing a recovery. Losing the lease
// means losing the right to publish; the sweep still reports what it saw.
const RELAY_GATEWAY_GATE_OWNER_PUBLISH_SCRIPT = [
  "if redis.call('get', KEYS[1]) == ARGV[1] then",
  "  return redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])",
  'end',
  'return 0',
].join('\n');

// Compare-and-set for the follower fallback: publish only if the key still
// holds what the follower last read (ARGV[1], '' for absent), so a verdict
// the owner landed between the last poll and this write is never clobbered.
const RELAY_GATEWAY_GATE_FALLBACK_PUBLISH_SCRIPT = [
  "local current = redis.call('get', KEYS[1])",
  "if current == false then current = '' end",
  'if current == ARGV[1] then',
  "  return redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])",
  'end',
  'return 0',
].join('\n');

// Single-flight population. When no verdict is cached, exactly one sweep may
// probe: it takes a short `SET NX` lease, probes, publishes the verdict and
// releases. Every other sweep that finds the lease taken polls for the
// published verdict for as long as the probe itself may run; if none appears
// in that budget it reports the gate as unclassified (`RELAY_GATE_UNREACHABLE`,
// warn) rather than either probing itself or vouching for a credential it
// never checked. The lease outlives the probe budget so a crashed owner
// cannot wedge the gate for longer than one snapshot.
const RELAY_GATEWAY_GATE_LEASE_KEY = `${RELAY_GATEWAY_GATE_PROBE_KEY}:lease`;
const RELAY_GATEWAY_GATE_LEASE_TTL_SECONDS = 10;
const RELAY_GATEWAY_GATE_FOLLOWER_POLL_MS = 250;
// Redis budget for the cache read, the lease and the verdict publish.
const RELAY_GATEWAY_GATE_REDIS_TIMEOUT_MS = 2_000;
// A follower must outwait the owner's WHOLE critical path — the relay probe,
// then the verdict publish (its own Redis timeout), plus polling slack —
// otherwise a follower that happens to be the 15-minute monitor request
// gives up a moment before the verdict lands and pages a false
// RELAY_GATE_UNREACHABLE. The lease TTL below stays longer than this wait.
const RELAY_GATEWAY_GATE_FOLLOWER_WAIT_MS =
  RELAY_GATEWAY_GATE_TIMEOUT_MS + RELAY_GATEWAY_GATE_REDIS_TIMEOUT_MS + 1_000;

async function readOrProbeRelayGatewayGate({
  now,
  // Cache validation reads the live clock, not the sweep's fixed `now`: a
  // follower polls for a verdict the lease owner publishes AFTER this sweep
  // began, and that verdict's `evaluatedAt` is later than `now`. Validating
  // against `now` would reject it as future-dated and persist a false
  // RELAY_GATE_UNREACHABLE in both snapshots. `now` still stamps any verdict
  // this sweep creates itself.
  clock = Date.now,
  key,
  leaseKey,
  ctx,
  fetchImpl,
  followerWaitMs = RELAY_GATEWAY_GATE_FOLLOWER_WAIT_MS,
  followerPollMs = RELAY_GATEWAY_GATE_FOLLOWER_POLL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // The caller's per-request budget (createHealthRequestBudget). Every Redis
  // call and the probe time out at min(own timeout, remaining budget); when
  // it runs out this throws HealthBudgetExhaustedError rather than publish an
  // observation the deadline, not the gate, produced.
  budget = null,
} = {}) {
  // A deployment that would not report the gate at all (no gateway env
  // outside a production build) touches neither the cache nor the lease.
  if (!probeRelayGatewayGateApplies()) return null;
  const timeoutMs = (ms) => (budget ? budget.clamp(ms) : ms);
  const checkBudget = () => {
    if (budget?.exhausted()) throw new HealthBudgetExhaustedError();
  };
  let lastRaw = null;
  const readCached = async () => {
    checkBudget();
    const cached = await redisPipeline([['GET', key]], timeoutMs(RELAY_GATEWAY_GATE_REDIS_TIMEOUT_MS), true).catch(() => null);
    lastRaw = cached?.[0]?.result ?? null;
    return parseCachedRelayGatewayGate(lastRaw, clock());
  };
  const reused = await readCached();
  if (reused) return reused;
  // Whatever was cached, fresh or not, is the previous verdict for the
  // transport-grace streak (see withTransportGrace).
  const previous = parsePreviousRelayGatewayGate(lastRaw);

  // The lease carries a per-sweep token and is released with the same
  // compare-and-delete script as the verdict refresh lock: if the TTL lapses
  // mid-probe and another sweep takes the lease, an unconditional DEL here
  // would free the successor's lease and let a third sweep overlap it.
  const leaseToken = `${now}:${crypto.randomUUID()}`;
  checkBudget();
  const lease = await redisPipeline(
    [['SET', leaseKey, leaseToken, 'EX', String(RELAY_GATEWAY_GATE_LEASE_TTL_SECONDS), 'NX']],
    timeoutMs(RELAY_GATEWAY_GATE_REDIS_TIMEOUT_MS),
    true,
  ).catch(() => null);
  const ownsLease = lease?.[0]?.result === 'OK';

  // The follower path: wait for whoever holds the lease to publish, then
  // adopt that verdict; if none lands in the probe budget, report the gate
  // unclassified with transport grace. Taken by a sweep that lost the lease
  // race AND by an owner that lost its lease mid-probe (below).
  // `own` is set by an owner whose publish result was indeterminate: it did
  // probe, so if no newer verdict appears its own observation stands rather
  // than an unclassified fallback it would have to invent.
  const follow = async (own = null) => {
    const deadline = Math.min(Date.now() + followerWaitMs, budget ? budget.workDeadline : Infinity);
    while (Date.now() < deadline) {
      await sleep(followerPollMs);
      const published = await readCached();
      if (published) return published;
    }
    // A wait the request deadline cut short proves nothing about the owner.
    checkBudget();
    if (own) return own;
    if (!probeRelayGatewayGateApplies()) return null;
    // Same grace as a directly probed unreachable verdict: one slow or crashed
    // owner is a single observation, not yet a problem. `lastRaw` is the last
    // cached verdict the polls saw, so a carried deadline still carries.
    const fallback = withTransportGrace({
      role: 'gateway',
      route: RELAY_GATEWAY_GATE_ROUTE,
      evaluatedAt: new Date(now).toISOString(),
      status: 'RELAY_GATE_UNREACHABLE',
      error: 'another sweep holds the probe lease and published no verdict within the probe budget',
      hint: 'This sweep did not probe the gate itself (single-flight). Persistent across sweeps = the probing sweep keeps timing out against Convex.',
    }, parsePreviousRelayGatewayGate(lastRaw), now);
    // Persist the deadline, not just the snapshot: if the owner died without
    // publishing and nothing else sweeps, the next monitor run (one interval
    // later, after the snapshot expired) would otherwise find no predecessor
    // and mint a fresh grace — one more interval before a dead relay pages.
    // `probed: false` keeps it a predecessor only (see parseCachedRelayGatewayGate).
    const published = await redisPipeline([[
      'EVAL',
      RELAY_GATEWAY_GATE_FALLBACK_PUBLISH_SCRIPT,
      '1',
      key,
      typeof lastRaw === 'string' ? lastRaw : '',
      JSON.stringify({ ...fallback, probed: false }),
      String(RELAY_GATEWAY_GATE_PROBE_RETENTION_SECONDS),
    ]], timeoutMs(RELAY_GATEWAY_GATE_REDIS_TIMEOUT_MS), true).catch(() => null);
    // Anything but an explicit 'OK' means a verdict may have landed between
    // this sweep's last poll and the CAS. Returning the fabricated fallback
    // then lets handleHealth write it over the owner's real answer, hiding a
    // fresh rejection as pending for a whole monitor run (#8282 review).
    if (published?.[0]?.result !== 'OK') {
      const winner = await readCached();
      if (winner) return winner;
    }
    return fallback;
  };

  if (!ownsLease) return follow();

  try {
    checkBudget();
    const probed = await probeRelayGatewayGate({ now, fetchImpl, timeoutMs: timeoutMs(RELAY_GATEWAY_GATE_TIMEOUT_MS) });
    // A probe the deadline cut short is not a verdict on the gate. Nothing is
    // published; the finally releases the lease for the next sweep.
    checkBudget();
    if (!probed) return null;
    const fresh = withTransportGrace(probed, previous, now);
    // Publish before releasing so a follower never sees a free lease and an
    // empty cache in the same instant, and only while the lease still holds
    // this sweep's token (see RELAY_GATEWAY_GATE_OWNER_PUBLISH_SCRIPT).
    // Retained past the freshness window so the next sweep can still see
    // this verdict as its predecessor.
    const published = await redisPipeline([[
      'EVAL',
      RELAY_GATEWAY_GATE_OWNER_PUBLISH_SCRIPT,
      '2',
      leaseKey,
      key,
      leaseToken,
      JSON.stringify(fresh),
      String(RELAY_GATEWAY_GATE_PROBE_RETENTION_SECONDS),
    ]], timeoutMs(RELAY_GATEWAY_GATE_REDIS_TIMEOUT_MS), true).catch(() => null);
    // Only an explicit 'OK' proves this verdict landed while the lease was
    // still ours. A refusal (0) means the lease lapsed mid-probe and a
    // successor owns the gate; an indeterminate result (timeout, error,
    // malformed reply) may hide the same thing. Either way this sweep's
    // verdict may be the older one, and handleHealth would write it into the
    // health snapshot for the snapshot TTL — so follow the current owner. On
    // an indeterminate result the own verdict stands if nothing newer lands.
    const result = published?.[0]?.result;
    if (result === 'OK') return fresh;
    return follow(result === 0 ? null : fresh);
  } finally {
    const release = redisPipeline([[
      'EVAL',
      HEALTH_VERDICT_RELEASE_LOCK_SCRIPT,
      '1',
      leaseKey,
      leaseToken,
    ]], RELAY_GATEWAY_GATE_REDIS_TIMEOUT_MS, true).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(release);
    else await release;
  }
}

/** True when this deployment would report the gate at all (see probeRelayGatewayGate's omit rule). */
function probeRelayGatewayGateApplies() {
  const configured = relayGatewayGateMissingEnv().length === 0;
  const isProductionBuild = process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production';
  return configured || isProductionBuild;
}

// The default forwards through a wrapper rather than capturing `globalThis.fetch`
// itself: on Edge runtimes the native implementation requires its global
// receiver, and a detached call throws — which would have read here as
// RELAY_GATE_UNREACHABLE on every sweep. AGENTS.md bans `fetch.bind` for the
// stale-reference reason; the arrow keeps both the receiver and the current
// (possibly wrapped) global.
async function probeRelayGatewayGate({
  now = Date.now(),
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = RELAY_GATEWAY_GATE_TIMEOUT_MS,
} = {}) {
  const missing = relayGatewayGateMissingEnv();
  const base = {
    role: 'gateway',
    route: RELAY_GATEWAY_GATE_ROUTE,
    evaluatedAt: new Date(now).toISOString(),
  };
  if (missing.length > 0) {
    // "Production build" means a build Vercel is actually running (`VERCEL=1`
    // is the platform's own system variable, present at runtime), in the
    // production environment. Suites that set VERCEL_ENV=production on a
    // laptop to model rollout semantics carry no tenant secret and must keep
    // reading as they did; a missing var only becomes the fault on the build
    // that serves paying customers.
    const isProductionBuild = process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production';
    if (!isProductionBuild) return null;
    return {
      ...base,
      status: 'RELAY_GATE_MISCONFIGURED',
      missing,
      hint: `This production build cannot see ${missing.map((name) => (name === 'CONVEX_SITE_URL' ? 'CONVEX_SITE_URL (or CONVEX_URL)' : name)).join(', ')}; the gateways answer 503 before reaching Convex. Set the value, then push a NEW commit — a same-commit redeploy is cancelled by scripts/vercel-ignore.sh (#8216).`,
    };
  }
  // The bearer is the tenant secret, so it never leaves over anything but
  // TLS: a malformed or `http:` CONVEX_SITE_URL is a misconfiguration, not a
  // transport failure, and is reported without a request being made.
  // The target is built exactly as the gateways build theirs — the configured
  // string with the route appended (api/notification-channels.ts) — so a value
  // carrying a path or a trailing slash is probed at the same endpoint the
  // paying path would hit, not at a normalised origin that may be healthy
  // while the real one is not. Parsing is for the https check only.
  let target;
  try {
    const configured = resolveRelayGatewaySiteUrl();
    const site = new URL(configured);
    if (site.protocol !== 'https:') throw new Error(`protocol ${site.protocol}`);
    target = `${configured}${RELAY_GATEWAY_GATE_ROUTE}`;
  } catch (error) {
    const isProductionBuild = process.env.VERCEL === '1' && process.env.VERCEL_ENV === 'production';
    if (!isProductionBuild) return null;
    return {
      ...base,
      status: 'RELAY_GATE_MISCONFIGURED',
      invalid: ['CONVEX_SITE_URL'],
      error: String(error?.message ?? error),
      hint: 'CONVEX_SITE_URL must be an https: origin; the gateway credential is never sent over plaintext, so no probe was made.',
    };
  }
  const startedAt = Date.now();
  let response;
  try {
    response = await fetchImpl(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CONVEX_TENANT_RELAY_SECRET}`,
        'User-Agent': RELAY_GATEWAY_GATE_USER_AGENT,
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ...base,
      status: 'RELAY_GATE_UNREACHABLE',
      latencyMs: Date.now() - startedAt,
      error: String(error?.message ?? error),
      hint: 'The Convex relay did not answer the gate probe; a credential verdict needs a reachable gate. Persistent over several sweeps = Convex outage or a wrong CONVEX_SITE_URL.',
    };
  }
  const latencyMs = Date.now() - startedAt;
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON is classified by status alone */ }
  if (response.status === 401) {
    return {
      ...base,
      status: 'RELAY_GATE_REJECTED',
      httpStatus: 401,
      latencyMs,
      hint: 'The deployed Convex gate does not admit this build\'s CONVEX_TENANT_RELAY_SECRET. Either side can be stale: a value written after the last `convex deploy` reads as undefined inside deployed functions until the next push (#8217). Redeploy Convex, then confirm this check returns OK.',
    };
  }
  // `{}` carries no userId: an admitted bearer gets 400 MISSING_USER_ID before
  // any Convex work runs. MISSING_FIELDS is the retired checkout route's answer.
  if (response.status === 400 && (body?.error === 'MISSING_USER_ID' || body?.error === 'MISSING_FIELDS')) {
    return { ...base, status: 'OK', httpStatus: 400, latencyMs };
  }
  return {
    ...base,
    status: 'RELAY_GATE_UNREACHABLE',
    httpStatus: response.status,
    latencyMs,
    error: typeof body?.error === 'string' ? body.error : `unexpected HTTP ${response.status}`,
    hint: 'The gate answered something other than 401 or 400 MISSING_FIELDS, so this sweep cannot classify the credential. Persistent over several sweeps = relay contract drift or a Convex fault.',
  };
}

function computeOverallStatus(counts, totalChecks) {
  const realWarnCount = counts.warn - counts.onDemandWarn;
  const containedWarnCount = Number.isInteger(counts.containedWarn)
    && counts.containedWarn >= 0
    && counts.containedWarn <= realWarnCount
    ? counts.containedWarn
    : 0;
  const availabilityWarnCount = realWarnCount - containedWarnCount;
  const critCount = counts.crit;

  if (critCount > 0) {
    // Critical severity is shared by both verdicts. The threshold scales with
    // registry size so adding keys does not silently raise the page-out bar.
    const overall = critCount / totalChecks <= 0.03 ? 'DEGRADED' : 'UNHEALTHY';
    return {
      overall,
      diagnosticOverall: overall,
      realWarnCount,
      critCount,
    };
  }

  const diagnosticOverall = realWarnCount > 0 ? 'WARNING' : 'HEALTHY';
  const overall = availabilityWarnCount === 0
    && containedWarnCount / totalChecks <= 0.03
    ? 'HEALTHY'
    : 'WARNING';

  return {
    overall,
    diagnosticOverall,
    realWarnCount,
    critCount,
  };
}

// Failure-log / ?history=1 problem set. Distinct from the compact `problems` map
// because EMPTY_ON_DEMAND and active stale-content grace are not active faults.
// Both remain visible in diagnostics without polluting the incident signature.
function collectFailureLogProblems(checks, now = Date.now()) {
  const entries = Object.entries(checks)
    .filter(([, c]) => (
      isProblemStatus(c.status)
      && healthStatusBucket(c, now) !== 'ok'
      && c.status !== 'EMPTY_ON_DEMAND'
    ));
  return {
    problemKeys: entries.map(([k, c]) => `${k}:${c.status}${c.seedAgeMin != null ? `(${c.seedAgeMin}min)` : ''}`),
    // The dedupe signature uses only key:status (no age) so a long STALE_SEED
    // window doesn't produce a new log entry on every poll.
    sigKeys: entries.map(([k, c]) => `${k}:${c.status}`).sort(),
  };
}

function buildFailureLogPersistencePlan({
  verdict,
  diagnostics,
  containedWarnCount,
  previousSignature,
  now,
}) {
  const {
    overall: availabilityOverall,
    diagnosticOverall,
    critCount,
    realWarnCount: warnCount,
  } = verdict;
  const { problemKeys, sigKeys } = diagnostics;

  if (problemKeys.length === 0) {
    // A later recurrence of the same problem set is a new incident only after
    // a diagnostic recovery, independent of the public availability verdict.
    return {
      action: 'clear',
      commands: [['DEL', 'health:failure-log-sig']],
    };
  }

  const entry = {
    at: new Date(now).toISOString(),
    status: diagnosticOverall,
    ...(diagnosticOverall !== availabilityOverall
      ? { availabilityStatus: availabilityOverall, containedWarnCount }
      : {}),
    critCount,
    warnCount,
    problems: problemKeys,
  };
  const signature = `${diagnosticOverall}|${sigKeys.join(',')}`;
  const appendIncident = signature !== previousSignature;
  const commands = [
    ['SET', 'health:last-failure', JSON.stringify(entry), 'EX', 86400],
  ];

  if (appendIncident) {
    commands.push(
      ['LPUSH', 'health:failure-log', JSON.stringify(entry)],
      ['LTRIM', 'health:failure-log', 0, 49],
    );
  }

  // Refresh history and its signature together while an incident is active:
  // neither duplicate it after 24h nor lose its only history entry after 7d.
  commands.push(
    ['EXPIRE', 'health:failure-log', 86400 * 7],
    ['SET', 'health:failure-log-sig', signature, 'EX', 86400],
  );

  return {
    action: 'persist',
    appendIncident,
    entry,
    signature,
    commands,
  };
}

function healthResponseBody(snapshot, compact) {
  const body = {
    status: snapshot.status,
    summary: snapshot.summary,
    checkedAt: snapshot.checkedAt,
  };

  if (!compact) {
    body.checks = snapshot.checks;
    return body;
  }

  const entries = snapshot.checks
    ? Object.entries(snapshot.checks).filter(
      ([name, check]) => (
        isProblemStatus(check.status)
        || (
          name === 'chinaCoverage'
          && typeof check.chinaStatus === 'string'
          && check.chinaStatus !== 'healthy'
        )
      ),
    )
    : Object.entries({ ...(snapshot.pending ?? {}), ...(snapshot.problems ?? {}) });
  const evaluatedAt = Date.parse(snapshot.checkedAt);
  const problems = Object.fromEntries(entries.filter(([, check]) => !isPendingHealthEntry(check, evaluatedAt)));
  const pending = Object.fromEntries(entries.filter(([, check]) => isPendingHealthEntry(check, evaluatedAt)));
  // Older compact snapshots may predate the operator-only China health
  // projection. Reduce it to the public verdict again at the response boundary
  // so a cached value cannot leak source freshness details to anonymous status
  // readers while its warning still reconciles with summary.warn.
  // Same rule, applied per field rather than per check (#6060): a check's
  // STATUS is public, but its named entities are operator-only. `staleCountries`
  // and the decision-group breakdown identify WHICH source is degraded, which
  // is exactly what the per-entry chinaDecisionSignals projection below exists to
  // withhold. `chinaRow` (#6395) names a country and says which part of a JODI
  // source is unusable, so it falls under the same rule. Runs on both shapes so
  // a cached compact snapshot written before this rule is scrubbed on the way
  // out too.
  for (const collection of [problems, pending]) {
    for (const [name, check] of Object.entries(collection)) {
      if (name === 'chinaDecisionSignals') {
        collection[name] = { status: check?.status };
        for (const { field } of ENTRY_SOFTENING_DEADLINES) {
          if (Object.prototype.hasOwnProperty.call(check ?? {}, field)) {
            collection[name][field] = check[field];
          }
        }
        continue;
      }
      if (check?.contentFreshness === undefined
        && check?.decisionGroups === undefined
        && check?.chinaRow === undefined) continue;
      const {
        contentFreshness: _detail,
        decisionGroups: _groups,
        chinaRow: _chinaRow,
        ...publicFields
      } = check;
      collection[name] = publicFields;
    }
  }
  if (Object.keys(problems).length > 0) body.problems = problems;
  if (Object.keys(pending).length > 0) body.pending = pending;
  return body;
}

/**
 * The compact snapshot stored in Redis is byte-for-byte the body a `?compact=1`
 * request returns. Deriving it from the same function that renders the response
 * means the cached form can never drift from the live form.
 */
function buildCompactVerdictSnapshot(snapshot) {
  return healthResponseBody(snapshot, true);
}

function healthResponse(snapshot, compact, headers, { stale = false } = {}) {
  let responseHeaders = headers;
  if (compact) {
    const { 'CF-Cache-Status': _bypassMarker, ...base } = headers;
    responseHeaders = {
      ...base,
      'Cache-Control': 'no-store, max-age=0',
      'CDN-Cache-Control': 'no-store',
    };
  }

  const body = healthResponseBody(snapshot, compact);
  // `status` stays the verdict so keyword monitors keep matching; `stale`
  // tells a reader that `checkedAt` predates this response's refresh window.
  if (stale) Object.assign(body, { stale: true, staleReason: 'REFRESH_PENDING' });
  return new Response(JSON.stringify(body, null, compact ? 0 : 2), {
    status: 200,
    headers: responseHeaders,
  });
}

function healthRefreshPendingResponse(headers) {
  return jsonResponse({
    status: 'REFRESH_PENDING',
    error: 'Health refresh is pending. Retry shortly.',
    retryAfterSeconds: 3,
  }, 503, { ...headers, 'Retry-After': '3' });
}

// A request that does not own the refresh lease never sweeps. It serves the
// last published verdict as stale; only without one does it answer 503. A
// last-known verdict past an activation deadline is refused for the same
// reason a fresh snapshot is (hasExpiredActivationGrace).
async function lastKnownOrRefreshPendingResponse(compact, headers, snapshotNow, timeoutMs = HEALTH_VERDICT_LAST_KNOWN_READ_TIMEOUT_MS) {
  if (timeoutMs < HEALTH_VERDICT_MIN_REDIS_TIMEOUT_MS) return healthRefreshPendingResponse(headers);
  const key = compact ? HEALTH_VERDICT_COMPACT_LAST_KNOWN_KEY : HEALTH_VERDICT_LAST_KNOWN_KEY;
  const result = await redisPipeline([['GET', key]], timeoutMs, true).catch(() => null);
  const snapshot = result?.[0]?.error ? null : parseHealthVerdictSnapshot(result?.[0]?.result, snapshotNow(), {
    requireChecks: !compact,
    maxAgeMs: HEALTH_VERDICT_LAST_KNOWN_TTL_SECONDS * 1_000,
  });
  if (!snapshot || hasExpiredActivationGrace(snapshot, snapshotNow())) return healthRefreshPendingResponse(headers);
  return healthResponse(snapshot, compact, headers, { stale: true });
}

export async function handleHealth(req, ctx, options = {}) {
  // `workBudgetMs` is a test seam, like `now`: lease-fencing suites model an
  // owner paused past its 30 s lease, which the default budget would cut short.
  const budget = createHealthRequestBudget(Date.now(), options.workBudgetMs);
  const hasInjectedClock = Object.prototype.hasOwnProperty.call(options, 'now');
  const now = hasInjectedClock ? options.now : Date.now();
  // The explicit clock is a deterministic test seam. Production callers keep
  // sampling wall time after Redis I/O so a snapshot that expires in flight is
  // not served as fresh merely because the request started before its TTL.
  const snapshotNow = () => (hasInjectedClock ? now : Date.now());
  if (isDisallowedOrigin(req)) {
    return new Response('Forbidden', { status: 403 });
  }

  const cors = getCorsHeaders(req, 'GET, OPTIONS');
  const headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'private, no-store, max-age=0',
    'CDN-Cache-Control': 'no-store',
    'CF-Cache-Status': 'BYPASS',
    ...cors,
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  const url = new URL(req.url);
  const compact = url.searchParams.get('compact') === '1';
  const wantsHistory = url.searchParams.get('history') === '1';
  // The owner ran out of request budget: serve the last published verdict as
  // stale rather than hang past the edge first-byte limit. The refresh lease
  // is left to lapse on its TTL (every write this owner may still have in
  // flight is token-fenced), which also keeps a degraded Redis from being hit
  // by back-to-back full sweeps.
  const deadlineFallback = () => {
    console.warn('[health] request deadline exhausted; serving the last-known verdict');
    return lastKnownOrRefreshPendingResponse(compact, headers, snapshotNow, budget.fallbackTimeout());
  };

  if (!compact || wantsHistory) {
    const keyCheck = await validateApiKey(req, { forceKey: true });
    if (keyCheck.required && !keyCheck.valid) {
      const error = keyCheck.error === USER_API_KEY_GATEWAY_VALIDATION_ERROR
        ? 'Invalid API key'
        : keyCheck.error;
      // RFC 7235 §3.1 requires WWW-Authenticate on every 401. The challenge
      // must reflect what this gate actually accepts: validateApiKey reads the
      // X-WorldMonitor-Key / X-Api-Key headers (or tester cookies) — never
      // Authorization: Bearer — so advertising a Bearer/OAuth challenge here
      // sent agents down a flow that cannot succeed (post-#4867 review). The
      // hint exists because this URL is what old copies of the api-catalog
      // linkset advertised as the public status endpoint (#4856) — a keyless
      // caller landing here should learn the public form, not dead-end.
      return jsonResponse(
        {
          error,
          hint: 'Detailed health requires an operator/enterprise API key. Public status: /api/health?compact=1',
        },
        401,
        {
          ...headers,
          'WWW-Authenticate': 'ApiKey realm="worldmonitor-health", header="X-WorldMonitor-Key"',
        }
      );
    }
  }

  // ?history=1 — fast read of the failure-log persisted by previous /api/health
  // probes. Skips the full freshness check (which is expensive — fetches every
  // bootstrap key) and returns only the last-failure snapshot + the deduped
  // incident log. Use to answer "what's been flipping?" without needing
  // Upstash creds. The classifier writes these keys on every non-OK probe:
  //   health:last-failure   — single most recent unhealthy snapshot (24h TTL)
  //   health:failure-log    — last 50 deduped incidents (7-day TTL)
  // See WM 2026-05-10 — added after a night of UptimeRobot flips that needed
  // direct Upstash inspection to diagnose.
  if (wantsHistory) {
    // App-owned incident log (#7674): health.js is the only writer of these
    // keys, so the read below and the persist/clear pipelines after the sweep
    // all ride the deployment-prefixed helper default — a preview
    // deployment's failure history stays inside its own namespace, and
    // production keeps the bare historical shape.
    const results = await redisPipeline(
      [
        ['GET', 'health:last-failure'],
        ['LRANGE', 'health:failure-log', '0', '-1'],
      ],
      4_000,
    );
    const parseJson = (raw) => {
      if (typeof raw !== 'string') return null;
      try { return JSON.parse(raw); } catch { return null; }
    };
    const lastFailureRaw = results?.[0]?.result;
    const failureLogRaw = results?.[1]?.result;
    const body = {
      lastFailure: parseJson(lastFailureRaw),
      failureLog: Array.isArray(failureLogRaw)
        ? failureLogRaw.map(parseJson).filter((e) => e !== null)
        : [],
      checkedAt: new Date().toISOString(),
    };
    return new Response(JSON.stringify(body, null, 2), { status: 200, headers });
  }

  // A snapshot hit is one Redis command instead of the ~390-command registry
  // sweep below. A failed snapshot read is a real Redis outage, not a cache
  // miss: returning 503 preserves UptimeRobot's hard-down signal.
  let refreshLockToken = null;
  let ownsSnapshotRefreshLock = false;
  let refreshLeaseStartedAt = 0;
  try {
    if (!getRedisCredentials()) throw new Error('Redis not configured');
    // Read the snapshot this request will actually render. `?compact=1` — the
    // browser poll, ~115k/day — reads the ~1 KB compact key instead of dragging the
    // full ~20 KB check map out of Redis to show a tenth of it (#5300).
    const snapshotKey = compact ? HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY : HEALTH_VERDICT_SNAPSHOT_KEY;
    // Snapshot/lock keys are already deployment-prefixed via
    // healthVerdictRedisKey — read and write them verbatim (#7674).
    const snapshotResult = await redisPipeline([['GET', snapshotKey]], budget.clamp(4_000), true);
    if (!snapshotResult) throw new Error('Redis request failed');
    if (snapshotResult[0]?.error) throw new Error('Redis snapshot read failed');
    const cachedSnapshot = parseHealthVerdictSnapshot(snapshotResult[0]?.result, snapshotNow(), { requireChecks: !compact });
    // Activation deadlines are exact to the second, so the 60s verdict cache
    // must not outlive either rollout grace. A snapshot written just before a
    // deadline would otherwise keep serving a softened verdict for up to a
    // minute after strictness was supposed to begin. Sweep fresh instead.
    if (cachedSnapshot && !hasExpiredActivationGrace(cachedSnapshot, snapshotNow())) {
      return healthResponse(cachedSnapshot, compact, headers);
    }

    refreshLockToken = `${now}:${crypto.randomUUID()}`;
    refreshLeaseStartedAt = Date.now();
    if (budget.exhausted()) throw new HealthBudgetExhaustedError();
    let lockResult = await redisPipeline([[
      'SET',
      HEALTH_VERDICT_REFRESH_LOCK_KEY,
      refreshLockToken,
      'EX',
      String(HEALTH_VERDICT_REFRESH_LOCK_TTL_SECONDS),
      'NX',
    ]], budget.clamp(4_000), true);
    if (!lockResult || lockResult.length !== 1 || lockResult[0]?.error
      || !['OK', null].includes(lockResult[0]?.result)) throw new Error('Redis snapshot lock failed');
    ownsSnapshotRefreshLock = lockResult[0]?.result === 'OK';

    if (!ownsSnapshotRefreshLock) {
      // Another edge invocation is already refreshing. Wait briefly for its
      // snapshot instead of multiplying the ~390-command sweep during a cold
      // burst. If the holder dies, retry SET NX until its lease expires; only
      // a lock owner may proceed to the sweep.
      const waitDeadline = Date.now() + HEALTH_VERDICT_REFRESH_WAIT_MS;
      for (
        let attempt = 0;
        attempt < HEALTH_VERDICT_REFRESH_WAIT_ATTEMPTS && Date.now() < waitDeadline;
        attempt++
      ) {
        const backoffMs = Math.min(100 * (2 ** attempt), 1_000);
        const jitterMs = Math.floor(Math.random() * 50);
        const sleepMs = Math.min(backoffMs + jitterMs, Math.max(0, waitDeadline - Date.now()));
        await new Promise((resolve) => setTimeout(resolve, sleepMs));
        const remainingMs = waitDeadline - Date.now();
        if (remainingMs < HEALTH_VERDICT_MIN_REDIS_TIMEOUT_MS || budget.exhausted()) break;
        const redisTimeoutMs = budget.clamp(Math.min(4_000, remainingMs));
        const refreshedResult = await redisPipeline([['GET', snapshotKey]], redisTimeoutMs, true);
        if (!refreshedResult || refreshedResult[0]?.error) throw new Error('Redis snapshot wait failed');
        const refreshedSnapshot = parseHealthVerdictSnapshot(refreshedResult[0]?.result, snapshotNow(), { requireChecks: !compact });
        if (
          refreshedSnapshot
          && !hasExpiredActivationGrace(refreshedSnapshot, snapshotNow())
        ) {
          return healthResponse(refreshedSnapshot, compact, headers);
        }

        const retryRemainingMs = waitDeadline - Date.now();
        if (retryRemainingMs < HEALTH_VERDICT_MIN_REDIS_TIMEOUT_MS || budget.exhausted()) break;
        refreshLeaseStartedAt = Date.now();
        lockResult = await redisPipeline([[
          'SET',
          HEALTH_VERDICT_REFRESH_LOCK_KEY,
          refreshLockToken,
          'EX',
          String(HEALTH_VERDICT_REFRESH_LOCK_TTL_SECONDS),
          'NX',
        ]], budget.clamp(Math.min(4_000, retryRemainingMs)), true);
        if (!lockResult || lockResult.length !== 1 || lockResult[0]?.error
          || !['OK', null].includes(lockResult[0]?.result)) throw new Error('Redis snapshot lock retry failed');
        ownsSnapshotRefreshLock = lockResult[0]?.result === 'OK';
        if (ownsSnapshotRefreshLock) break;
      }
      if (!ownsSnapshotRefreshLock) {
        return await lastKnownOrRefreshPendingResponse(compact, headers, snapshotNow, budget.fallbackTimeout());
      }
    }
  } catch (err) {
    // A read cut short by the request deadline is not a Redis outage.
    if (budget.exhausted()) return deadlineFallback();
    if (ownsSnapshotRefreshLock) await releaseHealthVerdictRefreshLock(refreshLockToken);
    // sentry-coverage-ok Redis read failures return HTTP 503 for health monitors.
    console.error('[health] Redis read failed:', err?.message ?? err);
    return jsonResponse({
      status: 'REDIS_DOWN',
      error: 'Redis unavailable',
      checkedAt: new Date(now).toISOString(),
    }, 503, headers);
  }

  // Count from before SET, so network delay cannot extend our local lease.
  if (Date.now() - refreshLeaseStartedAt >= HEALTH_VERDICT_REFRESH_LOCK_TTL_SECONDS * 1_000) {
    await releaseHealthVerdictRefreshLock(refreshLockToken);
    return lastKnownOrRefreshPendingResponse(compact, headers, snapshotNow, budget.fallbackTimeout());
  }

  const allDataKeys = [
    ...Object.values(BOOTSTRAP_KEYS),
    ...Object.values(STANDALONE_KEYS),
  ];
  const allMetaKeys = Object.values(SEED_META).map(s => s.key);
  const activationEntries = Object.entries(ACTIVATION_MARKERS);
  const fredRolloutCommands = fredRatesRolloutCommands(now);

  // STRLEN for data keys avoids loading large blobs into memory (OOM prevention).
  // NEG_SENTINEL ('__WM_NEG__') is 10 bytes — strlenIsData() rejects exactly
  // that length while accepting any other non-zero strlen as data. List-typed
  // keys (LIST_DATA_KEYS) take LLEN instead; STRLEN would WRONGTYPE on them.
  // Mixed-ownership sweep (#7674): registry data keys, seed-meta, and
  // activation markers are written by the Railway seeder fleet and are read
  // RAW (the fleet does not know the deployment prefix scheme). The two
  // route-owned temporal keys are stamped by the prefix-aware
  // list-temporal-anomalies route, so they must be read from this
  // deployment's own namespace — otherwise preview health classifies the
  // producer against the production stamp. Each key is finalized here and
  // the pipeline below is sent verbatim.
  const sweepKey = (key) => (isAppOwnedRedisKey(key) ? applyRedisKeyPrefix(key) : key);
  let results;
  try {
    const commands = [
      ...allDataKeys.map((k) => dataLenCommand(sweepKey(k))),
      ...allMetaKeys.map(k => ['GET', sweepKey(k)]),
      ...activationEntries.map(([, marker]) => ['EXISTS', sweepKey(marker)]),
      ...fredRolloutCommands,
    ];
    if (!getRedisCredentials()) throw new Error('Redis not configured');
    if (budget.exhausted()) return deadlineFallback();
    results = await redisPipeline(fenceHealthMutations(commands, refreshLockToken), budget.clamp(8_000), true);
    if (!results) throw new Error('Redis request failed');
  } catch (err) {
    if (budget.exhausted()) return deadlineFallback();
    if (ownsSnapshotRefreshLock) await releaseHealthVerdictRefreshLock(refreshLockToken);
    // REDIS_DOWN is a failed health read (distinct from REFRESH_PENDING): with Redis
    // unreachable the endpoint can assess nothing, so a plain HTTP-status
    // monitor (UptimeRobot, k8s probe, LB) must see a failure. DEGRADED/
    // UNHEALTHY/WARNING stay 200 (verdict in body) so warn-level seed jitter
    // doesn't flap HTTP monitors — see #2699 and the always-200 main response.
    // sentry-coverage-ok Redis read failures return HTTP 503 for health monitors.
    console.error('[health] Redis read failed:', err?.message ?? err);
    return jsonResponse({
      status: 'REDIS_DOWN',
      error: 'Redis unavailable',
      checkedAt: new Date(now).toISOString(),
    }, 503, headers);
  }

  // Content-age deadlines are evaluated against the clock at which the full
  // sweep finished, so a request that spends time awaiting Redis cannot keep a
  // grace it has already outlived. Injected clocks stay fixed so unit tests
  // remain deterministic.
  const evaluationNow = snapshotNow();

  // keyStrens: byte length per data key (0 = missing/empty/sentinel)
  // keyErrors: per-command Redis errors so we can surface REDIS_PARTIAL
  const keyStrens = new Map();
  const keyErrors = new Map();
  for (let i = 0; i < allDataKeys.length; i++) {
    const r = results[i];
    if (r?.error) keyErrors.set(allDataKeys[i], r.error);
    keyStrens.set(allDataKeys[i], r?.result ?? 0);
  }
  // keyMetaValues: parsed seed-meta objects (GET, small payloads)
  // keyMetaErrors: per-command errors so a single GET failure surfaces as
  // REDIS_PARTIAL instead of silently degrading to STALE_SEED.
  const keyMetaValues = new Map();
  const keyMetaErrors = new Map();
  for (let i = 0; i < allMetaKeys.length; i++) {
    const r = results[allDataKeys.length + i];
    if (r?.error) keyMetaErrors.set(allMetaKeys[i], r.error);
    keyMetaValues.set(allMetaKeys[i], r?.result ?? null);
  }
  // Stale-content evidence for every registered source, read once off the same
  // seed-meta the classifier will use. The Redis claim that turns this into a
  // published deadline happens AFTER classification (see below), so it can be
  // gated on the status a key actually ended up with.
  const graceEvidenceByName = new Map();
  for (const [name, seedCfg] of Object.entries(SEED_META)) {
    const seedMeta = readSeedMeta(seedCfg, keyMetaValues, keyMetaErrors, evaluationNow);
    graceEvidenceByName.set(name, staleContentGraceEvidence(
      seedMeta.contentAge,
      seedMeta.contentFreshness,
      evaluationNow,
    ));
  }
  // activationStates: health name -> whether its durable activation marker
  // exists. `readExistsFlags` is the one shared three-valued parser for all
  // three consumers (#6115): only an entry with an explicit result of 0 or 1
  // enters the map. Missing, malformed, null-result, and errored entries stay
  // unknown, so no surface can turn an absent response slot into proof of
  // pre-activation.
  const activationOffset = allDataKeys.length + allMetaKeys.length;
  const activationStates = readExistsFlags(
    results.slice(activationOffset, activationOffset + activationEntries.length),
    activationEntries.map(([name]) => name),
  );
  const fredRolloutOffset = allDataKeys.length + allMetaKeys.length + activationEntries.length;
  const fredRatesRolloutUntil = parseFredRatesRolloutUntil(
    results.slice(fredRolloutOffset, fredRolloutOffset + fredRolloutCommands.length),
  );
  const rolloutPendingUntilMs = new Map();
  if (fredRatesRolloutUntil !== null) {
    rolloutPendingUntilMs.set('fredRatesSeeder', fredRatesRolloutUntil);
  }
  // Rare second round trip: only while a writer lags a key-version bump.
  const keyVersionRollouts = keyVersionRolloutCandidates(
    [BOOTSTRAP_KEYS, STANDALONE_KEYS], keyStrens, keyErrors, keyMetaValues, keyMetaErrors, evaluationNow,
  );
  const keyVersionCommands = keyVersionRolloutCommands(keyVersionRollouts, evaluationNow);
  if (keyVersionCommands.length > 0) {
    if (budget.exhausted()) return deadlineFallback();
    const deadlineResults = await redisPipeline(
      fenceHealthMutations(keyVersionCommands, refreshLockToken), budget.clamp(4_000), true,
    ).catch(() => null);
    if (budget.exhausted()) return deadlineFallback();
    // A failed claim or read grants no window: the key keeps its strict verdict.
    keyVersionRollouts.forEach(({ name }, index) => {
      const until = parseFredRatesRolloutUntil(deadlineResults?.slice(index * 2, index * 2 + 2));
      if (until !== null) rolloutPendingUntilMs.set(name, until);
    });
  }

  const containmentEvidenceByName = new Map();
  const classifyCtx = {
    containmentEvidenceByName,
    keyStrens,
    keyErrors,
    keyMetaValues,
    keyMetaErrors,
    activationStates,
    rolloutPendingUntilMs,
    now: evaluationNow,
  };
  const checks = {};
  const contentFreshnessPendingUntil = {};
  const counts = {
    ok: 0,
    warn: 0,
    containedWarn: 0,
    onDemandWarn: 0,
    staleContent: 0,
    rolloutPending: 0,
    pending: 0,
    crit: 0,
  };
  let totalChecks = 0;

  const sources = [
    [BOOTSTRAP_KEYS, { allowOnDemand: false }],
    [STANDALONE_KEYS, { allowOnDemand: true }],
  ];
  for (const [registry, opts] of sources) {
    for (const [name, redisKey] of Object.entries(registry)) {
      totalChecks++;
      const entry = classifyKey(name, redisKey, opts, classifyCtx);
      checks[name] = entry;
      if (typeof entry.contentFreshnessPendingUntil === 'string') {
        contentFreshnessPendingUntil[name] = entry.contentFreshnessPendingUntil;
      }
    }
  }

  // Now that every key has a status, claim (or read back) the one durable
  // deadline per STALE_CONTENT source and publish it. Only the claim half is
  // used to classify this response. Cleanup and the failure log run in the
  // background (nothing in this response depends on them); the lease is
  // released only after they settle, and a token check at each mutation
  // rejects an expired owner.
  const ownedBackgroundWrites = [];
  const graceStatePlan = staleContentGraceStatePlan(graceEvidenceByName, checks, evaluationNow);
  if (graceStatePlan.claimCommands.length > 0) {
    // `redisPipeline` resolves null rather than throwing on every failure shape
    // (missing creds, non-2xx, timeout, length mismatch), and
    // `parseStaleContentGraceUntil` returns an empty map for anything that is
    // not a well-formed reply array. Both roads lead to "no grace, keep the
    // warning", which is the fail-closed direction.
    // The grace state hash key is deployment-prefixed via
    // healthVerdictRedisKey — send the plan verbatim (#7674).
    if (budget.exhausted()) return deadlineFallback();
    const graceResults = await redisPipeline(fenceHealthMutations(graceStatePlan.claimCommands, refreshLockToken), budget.clamp(4_000), true).catch(() => null);
    if (!graceResults && budget.exhausted()) return deadlineFallback();
    applyStaleContentGrace(
      checks,
      graceEvidenceByName,
      parseStaleContentGraceUntil(graceResults, graceStatePlan.stateBackedNames),
      evaluationNow,
    );
  }
  if (graceStatePlan.cleanupCommands.length > 0) {
    ownedBackgroundWrites.push(
      redisPipeline(fenceHealthMutations(graceStatePlan.cleanupCommands, refreshLockToken), 4_000, true).catch(() => {}),
    );
  }

  // Liveness of the paying path's credential, not a data key: see
  // probeRelayGatewayGate. Added after the registry loop and counted in
  // `totalChecks` when it applies, so `ok + warn + onDemandWarn + crit` still
  // partitions `summary.total` (the invariant scripts/docs-stats.mjs pins on
  // the published examples). On a production build `total` is therefore the
  // registry size plus one; the docs say so.
  //
  // "One probe per 60 s" is enforced here, not inferred from the snapshot
  // lock: a caller that loses the lock waits HEALTH_VERDICT_REFRESH_WAIT_MS
  // (3 s) and then runs its own sweep, and the probe's own budget is longer
  // than that wait, so a cold burst during the very outage this check exists
  // for could otherwise fan out one relay call per caller. The last verdict
  // is kept in Redis for the snapshot TTL and every sweep inside that window
  // reuses it; only a sweep that finds it missing or expired touches Convex.
  let relayGatewayGate;
  try {
    relayGatewayGate = await readOrProbeRelayGatewayGate({
      now: evaluationNow,
      key: RELAY_GATEWAY_GATE_PROBE_KEY,
      leaseKey: RELAY_GATEWAY_GATE_LEASE_KEY,
      ctx,
      budget,
    });
  } catch (err) {
    if (err instanceof HealthBudgetExhaustedError) return deadlineFallback();
    throw err;
  }
  if (relayGatewayGate) {
    checks[RELAY_GATEWAY_GATE_CHECK_NAME] = relayGatewayGate;
    totalChecks++;
  }

  for (const [name, entry] of Object.entries(checks)) {
    const bucket = healthStatusBucket(entry, evaluationNow);
    counts[bucket]++;
    const evidence = containmentEvidenceByName.get(name);
    if (isContainedHealthWarning(entry, evidence, evaluationNow)) {
      counts.containedWarn++;
    }
    if (isPendingHealthEntry(entry, evaluationNow)) counts.pending++;
    if (entry.status === 'EMPTY_ON_DEMAND') counts.onDemandWarn++;
    // STALE_CONTENT = "seeder is fresh but the upstream DATA stopped advancing"
    // (a frozen feed — see issue #3845). This sub-count stays a plain census of
    // that diagnosis, including entries whose severity bucket is temporarily
    // `ok` under a bounded grace, so a frozen feed is never invisible here.
    if (entry.status === 'STALE_CONTENT') counts.staleContent++;
    // Also a SUBSET of `warn` (it stays inside realWarnCount). Surfaced so an
    // operator can tell "eight keys awaiting their first producer tick" from
    // eight independently broken seeders without walking every check entry.
    if (entry.status === 'ROLLOUT_PENDING') counts.rolloutPending++;
  }

  const {
    overall,
    diagnosticOverall,
    realWarnCount,
    critCount,
  } = computeOverallStatus(counts, totalChecks);

  // Incident history follows actionable diagnostics, not the public
  // availability verdict. A contained defect may intentionally leave uptime
  // HEALTHY, but it must remain visible to operators and strict monitors.
  const diagnostics = collectFailureLogProblems(checks, evaluationNow);
  const { problemKeys } = diagnostics;
  if (problemKeys.length > 0) {
    console.log('[health] %s problems=[%s]', diagnosticOverall, problemKeys.join(', '));
  }
  const persistFailureLog = async () => {
    let previousSignature = '';
    if (problemKeys.length > 0) {
      const result = await redisPipeline([['GET', 'health:failure-log-sig']], 4_000).catch(() => null);
      previousSignature = result?.[0]?.result ?? '';
    }
    const persistencePlan = buildFailureLogPersistencePlan({
      verdict: { overall, diagnosticOverall, realWarnCount, critCount },
      diagnostics,
      containedWarnCount: counts.containedWarn,
      previousSignature,
      now: evaluationNow,
    });
    const commands = persistencePlan.commands.map(([op, key, ...args]) => [op, applyRedisKeyPrefix(key), ...args]);
    await redisPipeline(fenceHealthMutations(commands, refreshLockToken), 4_000, true).catch(() => {});
  };
  ownedBackgroundWrites.push(persistFailureLog().catch(() => {}));

  const verdictSnapshot = {
    status: overall,
    summary: {
      total: totalChecks,
      ok: counts.ok,
      // `warn` excludes on-demand-empty (cosmetic warns); `onDemandWarn` is
      // surfaced separately so readers can reconcile against `overall`.
      warn: realWarnCount,
      // Subset of `warn`: actionable source defects that still prove a usable
      // metadata-backed payload. These remain in `problems` even when the
      // small-cohort availability verdict stays HEALTHY.
      containedWarn: counts.containedWarn,
      onDemandWarn: counts.onDemandWarn,
      // `staleContent` counts every STALE_CONTENT diagnosis (fresh seeder,
      // frozen upstream data — issue #3845), so a frozen feed is visible
      // without walking every check entry. It is NOT a subset of `warn`: an
      // entry inside its bounded `staleContentGraceUntil` window is counted
      // here while its severity bucket is `ok`, so this can exceed `warn`.
      staleContent: counts.staleContent,
      ...(counts.pending > 0 ? { pending: counts.pending } : {}),
      // `rolloutPending` is a SUBSET of `warn` (#6059) — a newly deployed
      // schema whose producer has not reached its first scheduled run yet.
      // Bounded: each entry carries a `rolloutPendingUntil` deadline, after
      // which it becomes EMPTY (crit).
      rolloutPending: counts.rolloutPending,
      ...(Object.keys(contentFreshnessPendingUntil).length > 0
        ? { contentFreshnessPendingUntil }
        : {}),
      crit: critCount,
    },
    checkedAt: new Date(evaluationNow).toISOString(),
    checks,
  };

  // Await the write so the next request cannot race an unstarted background
  // SET and repeat the full sweep. A write failure does not invalidate the
  // live verdict just computed; the next request will retry by sweeping.
  // Both snapshots are written by the SAME sweep, in one atomic script, so the compact
  // form can never disagree with the full one or outlive it.
  // Both keys share one TTL for the same reason they share one sweep: they
  // carry the same deadlines, so they must stop being servable together.
  const snapshotTtl = String(snapshotTtlSeconds(verdictSnapshot, snapshotNow()));
  // Both snapshot keys are deployment-prefixed via healthVerdictRedisKey —
  // write them verbatim (#7674).
  // The verdict is complete: serve it even when no budget is left to publish
  // it (the next request re-sweeps, exactly as after a failed write).
  const snapshotWriteResult = budget.exhausted() ? null : await redisPipeline([[
    'EVAL',
    HEALTH_VERDICT_WRITE_SNAPSHOT_SCRIPT,
    '5',
    HEALTH_VERDICT_REFRESH_LOCK_KEY,
    HEALTH_VERDICT_SNAPSHOT_KEY,
    HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY,
    HEALTH_VERDICT_LAST_KNOWN_KEY,
    HEALTH_VERDICT_COMPACT_LAST_KNOWN_KEY,
    refreshLockToken,
    JSON.stringify(verdictSnapshot),
    JSON.stringify(buildCompactVerdictSnapshot(verdictSnapshot)),
    snapshotTtl,
    String(HEALTH_VERDICT_LAST_KNOWN_TTL_SECONDS),
  ]], budget.clamp(4_000), true).catch(() => null);
  const snapshotWriteFailed = !snapshotWriteResult
    || snapshotWriteResult.length !== 1
    || snapshotWriteResult[0]?.error
    || snapshotWriteResult[0]?.result !== 'OK';
  // A failed cache write does not invalidate the live verdict. Releasing only
  // this request's token lets the next caller retry without ever deleting a
  // successor's lock after a slow sweep outlives its lease. Release waits for
  // the background writes so their fences still match this owner's token.
  const releaseAfterBackgroundWrites = Promise.allSettled(ownedBackgroundWrites)
    .then(() => releaseHealthVerdictRefreshLock(refreshLockToken));
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(releaseAfterBackgroundWrites);
  else await releaseAfterBackgroundWrites;
  if (snapshotWriteFailed) console.warn('[health] verdict snapshot write failed');

  // Compact is the public keyless form polled by external uptime MONITORS, so it
  // must NEVER be edge-cached: the prior `s-maxage=60` (#4907, to collapse
  // dashboard-tab polling) let a shared CDN entry pin a stale WARNING that kept
  // UptimeRobot reading "down" long AFTER the seed recovered (2026-07-07 — the
  // literal `?cb=*cachebuster*` was a constant, so it never busted the entry).
  // no-store guarantees that Redis reachability is checked on every request;
  // only the verdict payload is reused, for at most 60 seconds. All other
  // responses already carry the no-store defaults from `headers` (a cached
  // 401 pins an auth failure; a cached 503 masks outage or refresh recovery).
  return healthResponse(verdictSnapshot, compact, headers);
}

export default async function handler(req, ctx) {
  return handleHealth(req, ctx);
}

// Test-only exports. Not part of the public edge handler surface — Vercel's
// runtime invokes only `default export`. These let scoped unit tests exercise
// the classifier without standing up the full bootstrap-keys + Redis pipeline.
// 2026-05-04 health-readiness plan, Sprint 1 test plan (Codex round 2 P1).
export const __testing__ = {
  readSeedMeta,
  classifyKey,
  healthResponseBody,
  collectFailureLogProblems,
  buildFailureLogPersistencePlan,
  ACTIVATION_MARKERS,
  CONTENT_FRESHNESS_ROLLOUT_UNTIL_MS,
  RUNTIME_ROLLOUT_PENDING_POLICIES,
  FRED_RATES_ROLLOUT_DEADLINE_KEY,
  FRED_RATES_ROLLOUT_DURATION_MS,
  KEY_VERSION_ROLLOUT_DEADLINE_PREFIX,
  KEY_VERSION_ROLLOUT_MAX_MS,
  keyVersionRolloutDurationMs,
  writerKeyVersionBehind,
  keyVersionRolloutCommands,
  fredRatesRolloutCommands,
  parseFredRatesRolloutUntil,
  STALE_CONTENT_GRACE_MS,
  STALE_CONTENT_GRACE_STATE_KEY,
  staleContentGraceEvidence,
  staleContentGraceCandidateUntil,
  staleContentGraceStatePlan,
  parseStaleContentGraceUntil,
  staleContentGraceUntilMs,
  applyStaleContentGrace,
  healthStatusBucket,
  isContainedHealthWarning,
  computeOverallStatus,
  hasExpiredActivationGrace,
  snapshotTtlSeconds,
  STATUS_COUNTS,
  // List-typed data keys + the command builder that measures them with LLEN
  // instead of STRLEN (tests/health-list-data-keys.test.mjs).
  LIST_DATA_KEYS,
  dataLenCommand,
  HEALTH_VERDICT_SNAPSHOT_KEY,
  HEALTH_VERDICT_COMPACT_SNAPSHOT_KEY,
  RELAY_GATEWAY_GATE_CHECK_NAME,
  RELAY_GATEWAY_GATE_ROUTE,
  RELAY_GATEWAY_GATE_TIMEOUT_MS,
  RELAY_GATEWAY_GATE_PROBE_KEY,
  RELAY_GATEWAY_GATE_PROBE_TTL_SECONDS,
  RELAY_GATEWAY_GATE_LEASE_KEY,
  RELAY_GATEWAY_GATE_LEASE_TTL_SECONDS,
  RELAY_GATEWAY_GATE_REDIS_TIMEOUT_MS,
  RELAY_GATEWAY_GATE_FOLLOWER_WAIT_MS,
  RELAY_GATEWAY_GATE_TRANSPORT_GRACE_MS,
  RELAY_GATEWAY_GATE_PROBE_RETENTION_SECONDS,
  SEED_FRESHNESS_MONITOR_INTERVAL_MS,
  withTransportGrace,
  probeRelayGatewayGate,
  parseCachedRelayGatewayGate,
  readOrProbeRelayGatewayGate,
  buildCompactVerdictSnapshot,
  HEALTH_VERDICT_SNAPSHOT_TTL_SECONDS,
  HEALTH_VERDICT_REFRESH_LOCK_KEY,
  HEALTH_VERDICT_REFRESH_LOCK_TTL_SECONDS,
  HEALTH_VERDICT_REFRESH_WAIT_MS,
  HEALTH_VERDICT_LAST_KNOWN_READ_TIMEOUT_MS,
  HEALTH_REQUEST_DEADLINE_MS,
  HEALTH_REQUEST_WORK_BUDGET_MS,
  HealthBudgetExhaustedError,
  createHealthRequestBudget,
  HEALTH_VERDICT_WRITE_SNAPSHOT_SCRIPT,
  HEALTH_VERDICT_LAST_KNOWN_KEY,
  HEALTH_VERDICT_COMPACT_LAST_KNOWN_KEY,
  HEALTH_VERDICT_LAST_KNOWN_TTL_SECONDS,
  HEALTH_VERDICT_MUTATION_SCRIPT,
  HEALTH_VERDICT_RELEASE_LOCK_SCRIPT,
  fenceHealthMutations,
  healthVerdictRedisKey,
  parseHealthVerdictSnapshot,
  // U7 (Tier 3 parity test): exposed for tests/mcp-bootstrap-parity.test.mjs
  // to walk the canonical seeded-data inventory. Both consts are unexported
  // at module scope by design — this is the test-only escape hatch.
  BOOTSTRAP_KEYS,
  STANDALONE_KEYS,
  SEED_META,
  EMPTY_DATA_OK_KEYS,
  MISSING_DATA_IS_FAILURE_KEYS,
  ZERO_RECORD_DATA_OK_KEYS,
  // Exposed so a registration test can prove a key's deployment-order softening
  // is actually wired — membership here is what keeps a not-yet-published key
  // out of CRIT, and nothing could assert it before (#5736).
  ON_DEMAND_KEYS,
};
