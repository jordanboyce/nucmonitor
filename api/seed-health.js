import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { validateApiKey } from './_api-key.js';
import { jsonResponse } from './_json-response.js';
import {
  hasPoolCoverageShortfall,
  parsePoolCounts,
} from './_pool-coverage.js';
import { parseRankableRecordCount } from './_rankable-coverage.js';
import { unwrapEnvelope } from './_seed-envelope.js';
import {
  buildContentFreshnessAssessment,
  getActiveContentFreshnessActivationWindow,
  projectContentFreshnessForWire,
} from './_content-freshness.js';
// @ts-expect-error — JS module, no declaration file
import { applyRedisKeyPrefix, readExistsFlags, redisPipeline } from './_upstash-json.js';
import { isAppOwnedRedisKey } from './_redis-key-ownership.js';

export const config = { runtime: 'edge' };

const SEED_DOMAINS = {
  // Phase 1 — Snapshot endpoints
  'seismology:earthquakes':   { key: 'seed-meta:seismology:earthquakes',   intervalMin: 15 },
  'wildfire:fires':           { key: 'seed-meta:wildfire:fires',           intervalMin: 60 },
  'infra:outages':            { key: 'seed-meta:infra:outages',            intervalMin: 15 },
  'climate:anomalies':        { key: 'seed-meta:climate:anomalies',        intervalMin: 120 },
  'climate:disasters':        { key: 'seed-meta:climate:disasters',        intervalMin: 360 },
  'climate:zone-normals':     { key: 'seed-meta:climate:zone-normals',     intervalMin: 44640 },
  'climate:co2-monitoring':   { key: 'seed-meta:climate:co2-monitoring',   intervalMin: 1440 }, // daily cron; health.js maxStaleMin:4320 (3x) is intentionally higher — it's an alarm threshold, not the cron cadence
  'climate:ocean-ice':        { key: 'seed-meta:climate:ocean-ice',        intervalMin: 1440 }, // daily cron; health.js maxStaleMin:2880 (2x) tolerates one missed run
  'climate:news-intelligence': { key: 'seed-meta:climate:news-intelligence', intervalMin: 30 },
  // #4920 completeness measurement — both run in the daily feed-validation
  // GitHub Actions workflow (00:00 UTC), not Railway. 1440-min cadence;
  // classifier stales at intervalMin*2 = one fully missed day.
  // activationKey (#4927 review P1 + re-review): published from GH Actions
  // only when the operator has added the UPSTASH secrets. 'missing' reads
  // as pending-activation (healthy) ONLY while the durable activation
  // marker is absent — publishers SET it with no TTL on first success, so
  // "has ever published" survives the 7d seed-meta TTL and a dead
  // publisher alarms as missing/stale instead of reverting to pending.
  'news:feed-health':         { key: 'seed-meta:news:feed-health',         intervalMin: 1440, activationKey: 'seed-activated:news:feed-health' },
  'market:crypto':            { key: 'seed-meta:market:crypto',            intervalMin: 15 },
  'shared:fx-rates':          { key: 'seed-meta:shared:fx-rates',          intervalMin: 1800 }, // 60h staleness budget in api/health.js
  // Phase 3 — Hybrid endpoints
  'natural:events':           { key: 'seed-meta:natural:events',           intervalMin: 270 },
  'economic:energy-prices':   { key: 'seed-meta:economic:energy-prices',   intervalMin: 75 },
  // Independent hourly producer from scripts/seed-fred-rates.mjs. This
  // operator-only endpoint stays strict; api/health.js owns the bounded
  // deploy-before-provisioning window for public health.
  'economic:fred-rates':      { key: 'seed-meta:economic:fred-rates',      intervalMin: 60, minRecordCount: 24 },
  // Aligned with health.js SEED_META (intervalMin = maxStaleMin / 2)
  'market:stocks':            { key: 'seed-meta:market:stocks',            intervalMin: 15 },
  'market:commodities':       { key: 'seed-meta:market:commodities',       intervalMin: 15 },
  'market:gold-etf-flows':    { key: 'seed-meta:market:gold-etf-flows',    intervalMin: 1440 },
  // maxStaleMin in health.js is 44640 (~31 days; IMF IFS is monthly w/ 2-3mo lag).
  // This endpoint flags stale at intervalMin*2, so keep intervalMin = 22320 to match.
  'market:gold-cb-reserves':  { key: 'seed-meta:market:gold-cb-reserves',  intervalMin: 22320 },
  'market:sectors':           { key: 'seed-meta:market:sectors',           intervalMin: 15 },
  'news:insights':            { key: 'seed-meta:news:insights',            intervalMin: 15 },
  'weather:alerts':           { key: 'seed-meta:weather:alerts',           intervalMin: 15 },
  'weather:imd-cyclone-marine': { key: 'seed-meta:weather:imd-cyclone-marine', intervalMin: 15 },
  'infra:service-statuses':   { key: 'seed-meta:infra:service-statuses',   intervalMin: 60 },
  'cable-health':             { key: 'seed-meta:cable-health',             intervalMin: 30 },
  'infrastructure:submarine-cables': { key: 'seed-meta:infrastructure:submarine-cables', intervalMin: 12600 },
  'economic:worldbank-techreadiness': { key: 'seed-meta:economic:worldbank-techreadiness:v1', intervalMin: 5040 },
  'economic:worldbank-progress':      { key: 'seed-meta:economic:worldbank-progress:v1',     intervalMin: 5040 },
  'economic:worldbank-renewable':     { key: 'seed-meta:economic:worldbank-renewable:v1',    intervalMin: 5040 },
  'economic:bis-extended':    { key: 'seed-meta:economic:bis-extended',    intervalMin: 720 }, // 12h Railway cron; "seeder ran" aggregate — per-dataset freshness lives below
  'economic:bis-dsr':                  { key: 'seed-meta:economic:bis-dsr',                  intervalMin: 720 }, // 12h cron; only written when DSR slice fetched fresh entries
  'economic:bis-property-residential': { key: 'seed-meta:economic:bis-property-residential', intervalMin: 720 }, // 12h cron; only written when SPP slice fetched fresh entries
  'economic:bis-property-commercial':  { key: 'seed-meta:economic:bis-property-commercial',  intervalMin: 720 }, // 12h cron; only written when CPP slice fetched fresh entries
  'economic:cbr-rates':                { key: 'seed-meta:economic:cbr-rates',                intervalMin: 1440, minRecordCount: 31 }, // daily cron (seed-bundle-macro); api/health.js maxStaleMin 4320 = 3x. minRecordCount mirrors MIN_RATE_COUNT (30) + the key rate.
  'economic:boc-valet':                { key: 'seed-meta:economic:boc-valet',                intervalMin: 1440, minRecordCount: 19 }, // daily cron (seed-bundle-macro); api/health.js maxStaleMin 4320 = 3x. minRecordCount = 15 FX + policy + 3 yields.
  'economic:statcan-wds':              { key: 'seed-meta:economic:statcan-wds',              intervalMin: 1440, minRecordCount: 2 }, // daily cron; floor is CPI YoY + LFS unemployment. Empty change-list is valid quiet.
  'radiation:observations':   { key: 'seed-meta:radiation:observations',   intervalMin: 15 },
  'health:air-quality':       { key: 'seed-meta:health:air-quality',       intervalMin: 60 },  // hourly cron (shared seeder writes health + climate keys)
  'economic:owid-energy-mix': { key: 'seed-meta:economic:owid-energy-mix', intervalMin: 25200 }, // monthly cron on 1st; intervalMin = health.js maxStaleMin / 2 (50400 / 2)
  'economic:fao-ffpi':        { key: 'seed-meta:economic:fao-ffpi',        intervalMin: 43200 }, // monthly seed; intervalMin = health.js maxStaleMin / 2 (86400 / 2)
  // plan 2026-04-25-004 Phase 2: financialSystemExposure component seeders.
  // intervalMin = health.js maxStaleMin / 2 (mirrors the IMF-pattern). Bundle: scripts/seed-bundle-macro.mjs.
  'economic:wb-external-debt': { key: 'seed-meta:economic:wb-external-debt', intervalMin: 50400 }, // annual WB IDS publication; intervalMin = health.js maxStaleMin / 2 (100800 / 2)
  'economic:bis-lbs':          { key: 'seed-meta:economic:bis-lbs',          intervalMin: 7200 },  // BIS LBS quarterly; intervalMin = health.js maxStaleMin / 2 (14400 / 2)
  'product-catalog':          { key: 'seed-meta:product-catalog',          intervalMin: 360 }, // relay loop every 6h; intervalMin = health.js maxStaleMin / 3 (1080 / 3)
  'energy:eia-petroleum':   { key: 'seed-meta:energy:eia-petroleum',   intervalMin: 1440 }, // daily bundle cron; intervalMin*3 = health.js maxStaleMin (4320)
  'energy:spine':                 { key: 'seed-meta:energy:spine',                 intervalMin: 1440 }, // daily cron (0 6 * * *); intervalMin = maxStaleMin / 2 (2880 / 2)
  'energy:ember': { key: 'seed-meta:energy:ember', intervalMin: 1440 }, // daily cron (0 8 * * *); intervalMin = maxStaleMin / 2 (2880 / 2)
  'energy:pipelines-gas': { key: 'seed-meta:energy:pipelines-gas', intervalMin: 10080 }, // weekly cron (7d); intervalMin = health.js maxStaleMin / 2 (20160 / 2)
  'energy:pipelines-oil': { key: 'seed-meta:energy:pipelines-oil', intervalMin: 10080 }, // weekly cron; same seeder writes both keys
  'energy:storage-facilities': { key: 'seed-meta:energy:storage-facilities', intervalMin: 10080 }, // weekly cron (7d); intervalMin = health.js maxStaleMin / 2 (20160 / 2)
  'energy:fuel-shortages': { key: 'seed-meta:energy:fuel-shortages', intervalMin: 1440 }, // daily cron; intervalMin = health.js maxStaleMin / 2 (2880 / 2)
  'intel-history:energy:intelligence': {
    key: 'seed-meta:intel-history:energy:intelligence',
    intervalMin: 360,
    activationKey: 'seed-activated:intel-history:energy:intelligence',
  },
};

function parseJsonValue(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseFiniteRecordCount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}






function evaluateDataProbe(cfg, raw) {
  if (!cfg) return null;
  const requiredFormula = cfg.formula ?? null;
  const requiredEducationState = cfg.educationState ?? null;
  if (!raw) {
    return {
      ok: false,
      status: 'data_missing',
      key: cfg.key,
      requiredMethodology: cfg.methodology ?? null,
      requiredSourceVersion: cfg.sourceVersion ?? null,
      requiredFormula,
      requiredEducationState,
    };
  }

  const parsed = unwrapEnvelope(parseJsonValue(raw)).data;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      status: 'data_invalid',
      key: cfg.key,
      requiredMethodology: cfg.methodology ?? null,
      requiredSourceVersion: cfg.sourceVersion ?? null,
      requiredFormula,
      requiredEducationState,
    };
  }

  const methodology = typeof parsed.methodology === 'string' ? parsed.methodology : null;
  const formula = typeof parsed._formula === 'string' ? parsed._formula : null;
  const educationState = typeof parsed._educationState === 'string' ? parsed._educationState : null;
  if (cfg.kind === 'education_coverage') {
    const rankableRecordCount = parseEducationPayloadRankableRecordCount(parsed);
    const ok = rankableRecordCount != null && rankableRecordCount >= cfg.minRankableRecordCount;
    return {
      ok,
      status: ok ? 'ok' : 'coverage_partial',
      key: cfg.key,
      rankableRecordCount,
      minRankableRecordCount: cfg.minRankableRecordCount,
    };
  }
  if (cfg.methodology && methodology !== cfg.methodology) {
    return {
      ok: false,
      status: 'methodology_mismatch',
      key: cfg.key,
      methodology,
      formula,
      requiredMethodology: cfg.methodology,
      requiredSourceVersion: cfg.sourceVersion ?? null,
      requiredFormula,
      educationState,
      requiredEducationState,
    };
  }

  if (requiredFormula && formula !== requiredFormula) {
    return {
      ok: false,
      status: 'formula_mismatch',
      key: cfg.key,
      formula,
      requiredFormula,
      educationState,
      requiredEducationState,
      methodology,
      requiredMethodology: cfg.methodology ?? null,
      requiredSourceVersion: cfg.sourceVersion ?? null,
    };
  }

  const educationStateMatches = educationState === requiredEducationState;
  if (requiredEducationState && !educationStateMatches) {
    return {
      ok: false,
      status: 'construct_mismatch',
      key: cfg.key,
      formula,
      requiredFormula,
      educationState,
      requiredEducationState,
      methodology,
      requiredMethodology: cfg.methodology ?? null,
      requiredSourceVersion: cfg.sourceVersion ?? null,
    };
  }

  return {
    ok: true,
    status: 'ok',
    key: cfg.key,
    methodology,
    requiredMethodology: cfg.methodology ?? null,
    requiredSourceVersion: cfg.sourceVersion ?? null,
    formula,
    requiredFormula,
    educationState,
    requiredEducationState,
    computedAt: typeof parsed.computedAt === 'string' ? parsed.computedAt : null,
  };
}

async function getSeedBatch(entries) {
  const commands = [];
  const metaSlots = [];
  const probeSlots = [];
  const activationSlots = [];
  const contentFreshnessActivationSlots = [];
  const batchKey = (key) => (isAppOwnedRedisKey(key) ? applyRedisKeyPrefix(key) : key);
  for (const [domain, cfg] of entries) {
    metaSlots.push({ domain, key: cfg.key, index: commands.length });
    commands.push(['GET', batchKey(cfg.key)]);
    if (cfg.dataProbe?.key) {
      probeSlots.push({ domain, index: commands.length });
      commands.push(['GET', batchKey(cfg.dataProbe.key)]);
    }
    if (cfg.activationKey) {
      activationSlots.push({ domain, index: commands.length });
      commands.push(['EXISTS', batchKey(cfg.activationKey)]);
    }
    if (cfg.contentFreshnessActivationKey) {
      contentFreshnessActivationSlots.push({ domain, index: commands.length });
      commands.push(['EXISTS', batchKey(cfg.contentFreshnessActivationKey)]);
    }
  }

  // Most rows are written by the Railway seeder fleet and stay raw. The small
  // route-owned set is finalized above into this deployment's namespace. Send
  // the mixed pipeline verbatim so the Redis helper cannot prefix every key
  // as one ownership class (#7674).
  const data = await redisPipeline(commands, 3000, true);
  if (!data) throw new Error('Redis not configured');

  const metaMap = new Map();
  const probeMap = new Map();
  for (const slot of metaSlots) {
    const raw = data[slot.index]?.result;
    if (raw) {
      const parsed = parseJsonValue(raw);
      if (parsed) metaMap.set(slot.key, parsed);
    }
  }
  for (const slot of probeSlots) {
    probeMap.set(slot.domain, data[slot.index]?.result ?? null);
  }
  // Both maps are THREE-valued (#6095, matching api/health.js and
  // api/mcp/freshness.ts): `readExistsFlags` adds a domain only when the
  // EXISTS entry has an explicit result of 0 or 1. Per-command errors,
  // `{}`, null results, and missing slots remain unknown, so a malformed
  // pipeline body can never be interpreted as clean absence (#6115).
  const activatedMap = readExistsFlags(
    activationSlots.map((slot) => data[slot.index]),
    activationSlots.map((slot) => slot.domain),
  );
  const contentFreshnessActivatedMap = readExistsFlags(
    contentFreshnessActivationSlots.map((slot) => data[slot.index]),
    contentFreshnessActivationSlots.map((slot) => slot.domain),
  );
  return { metaMap, probeMap, activatedMap, contentFreshnessActivatedMap };
}

export async function handleSeedHealth(req, options = {}) {
  const hasInjectedClock = Object.hasOwn(options, 'now');
  const now = hasInjectedClock ? options.now : Date.now();
  if (isDisallowedOrigin(req))
    return new Response('Forbidden', { status: 403 });

  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS')
    return new Response(null, { status: 204, headers: cors });

  const apiKeyResult = await validateApiKey(req, { forceKey: true });
  if (!apiKeyResult.valid || apiKeyResult.kind !== 'enterprise')
    return jsonResponse({ error: 'Operator API key required' }, 401, cors);

  const entries = Object.entries(SEED_DOMAINS);

  let metaMap;
  let activatedMap = new Map();
  let contentFreshnessActivatedMap = new Map();
  let probeMap;
  try {
    ({ metaMap, probeMap, activatedMap, contentFreshnessActivatedMap } = await getSeedBatch(entries));
  } catch {
    return jsonResponse({ error: 'Redis unavailable' }, 503, cors);
  }

  // Content-freshness activation deadlines are evaluated against the clock at
  // which the Redis batch finished. A production request that crosses the
  // deadline while awaiting Redis must not preserve its request-start grace;
  // injected clocks stay fixed so unit tests remain deterministic.
  const evaluationNow = hasInjectedClock ? now : Date.now();

  const seeds = {};
  let staleCount = 0;
  let missingCount = 0;
  let criticalCount = 0;

  for (const [domain, cfg] of entries) {
    const meta = metaMap.get(cfg.key);
    const maxStalenessMs = cfg.intervalMin * 2 * 60 * 1000;
    // #6095 review: mirrors api/health.js's `activationUnknown`. A verdict
    // reached from an UNREADABLE marker is otherwise byte-identical to one
    // reached from evidence, so an operator cannot tell "the EXISTS command
    // failed" from "the producer genuinely never published" — different
    // remediations. Reports which evidence the verdict rests on; softens and
    // hardens nothing on its own.
    const activationUnknown = (cfg.activationKey && !activatedMap.has(domain))
      || (cfg.contentFreshnessActivationKey && !contentFreshnessActivatedMap.has(domain));

    if (!meta) {
      if (cfg.activationKey && activatedMap.get(domain) !== true) {
        // Never seeded (durable marker absent) AND operator-activation-
        // gated: healthy pending state, not an alarm (#4927 review P1).
        // Once the marker exists, missing meta falls through to
        // 'missing' — a publisher that ran once and died must alarm
        // (#4927 re-review P1).
        // #6095 audited this grace and kept it soft on an UNREADABLE marker,
        // unlike the content-freshness grace below, and mirrors the same call
        // api/health.js makes for ON_DEMAND: the strict verdict here is
        // 'missing' (which drives `overall: degraded` and HTTP 503), so
        // resolving unknown to "activated" would turn a marker blip into a
        // hard-down page for a domain that may genuinely never have run.
        // There is no meta to be wrong about — absence is the whole input.
        seeds[domain] = { status: 'pending-activation', fetchedAt: null, recordCount: null, stale: false };
        if (activationUnknown) seeds[domain].activationUnknown = true;
        continue;
      }
      seeds[domain] = { status: 'missing', fetchedAt: null, recordCount: null, stale: true };
      if (cfg.minRecordCount != null) seeds[domain].minRecordCount = cfg.minRecordCount;
      if (cfg.minRankableRecordCount != null) seeds[domain].minRankableRecordCount = cfg.minRankableRecordCount;
      if (cfg.minPoolCounts) seeds[domain].minPoolCounts = cfg.minPoolCounts;
      missingCount++;
      continue;
    }

    const ageMs = evaluationNow - (meta.fetchedAt || 0);
    const recordCount = parseFiniteRecordCount(meta.recordCount);
    const rankableRecordCount = parseRankableRecordCount(meta);
    const redistributionPolicyVersion = Number.isInteger(meta.redistributionPolicyVersion)
      ? meta.redistributionPolicyVersion
      : null;
    const poolCounts = parsePoolCounts(meta.poolCounts, cfg.minPoolCounts);
    const recordCoveragePartial = cfg.minRecordCount != null
      && (recordCount == null || recordCount < cfg.minRecordCount);
    const rankableCoveragePartial = cfg.minRankableRecordCount != null
      && (rankableRecordCount == null || rankableRecordCount < cfg.minRankableRecordCount);
    const poolCoveragePartial = hasPoolCoverageShortfall(poolCounts, cfg.minPoolCounts);
    const redistributionPolicyPartial = cfg.requiredRedistributionPolicyVersion != null
      && redistributionPolicyVersion !== cfg.requiredRedistributionPolicyVersion;
    const coveragePartial = recordCoveragePartial
      || rankableCoveragePartial
      || poolCoveragePartial;
    // Source-specific seed projections retain their last-good records while
    // reporting a current upstream failure through sourceState. Treat that as
    // an immediate operator error instead of waiting for the freshness window.
    // `unavailable` means an optional adapter was never configured, matching
    // api/health.js's NOT_CONFIGURED treatment rather than a broken source.
    const sourceUnavailable = meta.sourceState === 'unavailable';
    const inputFreshUntil = Number(meta.inputFreshUntil);
    const inputFreshnessExpired = cfg.enforceInputFreshUntil === true
      && meta.sourceState === 'ok'
      && (!Number.isFinite(inputFreshUntil) || inputFreshUntil <= evaluationNow);
    const sourceError = inputFreshnessExpired || (typeof meta.sourceState === 'string'
      && meta.sourceState !== 'ok'
      && !sourceUnavailable);
    const isError = meta.status === 'error' || sourceError;
    const probe = evaluateDataProbe(cfg.dataProbe, probeMap.get(domain));
    const sourceMismatch = Boolean(
      cfg.dataProbe?.sourceVersion &&
      typeof meta.sourceVersion === 'string' &&
      meta.sourceVersion !== '' &&
      meta.sourceVersion !== cfg.dataProbe.sourceVersion
    );
    const contentFreshness = buildContentFreshnessAssessment(
      meta,
      cfg.requireContentFreshness,
      evaluationNow,
    );
    // Grace requires POSITIVE proof (#6095): the marker was READ and came back
    // absent. An unreadable marker is unknown state, not evidence of a producer
    // that never ran — the same rule api/health.js and api/mcp/freshness.ts
    // apply, so the three surfaces cannot answer differently for one input
    // class. The clean-absent arm is also bounded by the shared rollout window
    // (#6111), so marker eviction or an empty Redis restore cannot excuse the
    // missing block forever.
    const contentFreshnessActivationWindow = contentFreshness
      && !contentFreshness.fieldPresent
      && cfg.contentFreshnessActivationKey
      ? getActiveContentFreshnessActivationWindow(
        cfg.contentFreshnessActivationKey,
        contentFreshnessActivatedMap.get(domain),
        evaluationNow,
      )
      : null;
    const contentFreshnessPending = contentFreshnessActivationWindow !== null;
    const contentFreshnessInvalid = Boolean(
      cfg.requireContentFreshness
      && contentFreshness
      && !contentFreshness.usable
      && !contentFreshnessPending,
    );
    const contentFreshnessStale = Boolean(
      contentFreshness
      && contentFreshness.usable
      && contentFreshness.contentStale
      && !contentFreshnessPending,
    );
    // Keep the new pool-coverage verdict distinct from freshness. The legacy
    // scalar minRecordCount path still contributes to `stale` for wire
    // compatibility, but an empty pool is fresh data with partial coverage.
    const freshnessStale = ageMs > maxStalenessMs;
    const stale = freshnessStale
      || recordCoveragePartial
      || rankableCoveragePartial
      || redistributionPolicyPartial
      || isError
      || sourceMismatch
      || probe?.ok === false
      || contentFreshnessInvalid
      || contentFreshnessStale;
    if (stale || coveragePartial) staleCount++;
    // A policy mismatch is an operator error only once the producer has
    // actually activated. Before the first publish the field is legitimately
    // absent, so escalating then would drive `overall: degraded` (HTTP 503) for
    // the WHOLE endpoint on any ordinary API-before-seeder deploy — and, because
    // the check keys off every configured domain rather than the offending one,
    // it takes every unrelated seed down with it. The domain still reports
    // `policy_incompatible` and still counts toward `stale`/warning either way.
    const policyEnforced = !cfg.activationKey || activatedMap.get(domain) === true;
    if (redistributionPolicyPartial && policyEnforced) criticalCount++;

    seeds[domain] = {
      status: redistributionPolicyPartial
        ? 'policy_incompatible'
        : sourceUnavailable
        ? 'not_configured'
        : isError
        ? 'error'
        : sourceMismatch
          ? 'source_version_mismatch'
          : probe?.ok === false
            ? probe.status
            : freshnessStale
              ? 'stale'
              : coveragePartial
                ? 'coverage_partial'
                : contentFreshnessInvalid
                  ? 'coverage_degraded'
                  : contentFreshnessStale
                    ? 'stale_content'
                    : 'ok',
      fetchedAt: meta.fetchedAt,
      recordCount: recordCount ?? meta.recordCount ?? null,
      sourceVersion: meta.sourceVersion || null,
      ageMinutes: Math.round(ageMs / 60000),
      stale,
    };
    if (cfg.minRecordCount != null) seeds[domain].minRecordCount = cfg.minRecordCount;
    if (cfg.minRankableRecordCount != null) {
      seeds[domain].rankableRecordCount = rankableRecordCount;
      seeds[domain].minRankableRecordCount = cfg.minRankableRecordCount;
    }
    if (cfg.minPoolCounts) seeds[domain].minPoolCounts = cfg.minPoolCounts;
    if (cfg.requiredRedistributionPolicyVersion != null) {
      seeds[domain].redistributionPolicyVersion = redistributionPolicyVersion;
      seeds[domain].requiredRedistributionPolicyVersion = cfg.requiredRedistributionPolicyVersion;
    }
    if (activationUnknown) seeds[domain].activationUnknown = true;
    if (poolCounts) seeds[domain].poolCounts = poolCounts;
    if (contentFreshnessActivationWindow) {
      seeds[domain].contentFreshnessPendingUntil = new Date(
        contentFreshnessActivationWindow.untilMs,
      ).toISOString();
    }
    if (contentFreshness && !contentFreshnessPending) {
      seeds[domain].contentFreshness = projectContentFreshnessForWire(contentFreshness);
    }
    // Explicit coverage flag so consumers that only inspect `stale` still see
    // pool/aggregate shortfalls (pool shortfall keeps stale:false by design).
    if (coveragePartial) seeds[domain].coveragePartial = true;
    if (probe) seeds[domain].dataProbe = probe;
    // #5736: without this, `status: "error"` names no cause and an operator has
    // to read raw Redis to learn WHY — which is the log-diving the issue exists
    // to end. Bounded, producer-controlled vocabulary only (`http_401`,
    // `budget_exhausted`, `config_removed`, a clamped error-class name); the
    // free-text `lastErrorReason` carries a relay-controlled body snippet and
    // is deliberately NOT echoed. Emitted only when present, so every existing
    // seed entry keeps its exact shape.
    if (typeof meta.lastErrorCode === 'string' && meta.lastErrorCode) {
      seeds[domain].lastErrorCode = meta.lastErrorCode;
    }
  }

  const overall = missingCount > 0 || criticalCount > 0
    ? 'degraded'
    : staleCount > 0
      ? 'warning'
      : 'healthy';

  const httpStatus = overall === 'healthy' ? 200 : overall === 'warning' ? 200 : 503;

  return jsonResponse({ overall, seeds, checkedAt: evaluationNow }, httpStatus, {
    ...cors,
    'Cache-Control': 'no-cache',
  });
}

export default async function handler(req) {
  return handleSeedHealth(req);
}
