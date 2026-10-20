/**
 * Frozen bootstrap byte ledger and operational volume evaluation (#7288).
 *
 * The checked-in capture is a membership ratchet for CI, not a live production
 * pass/fail. `evaluatePublishedBootstrapVolume()` compares a publisher ledger
 * against the same ceilings and 5% key-growth rule, but it only returns alerts.
 * The publisher logs those alerts; it must not fail a write because Redis
 * contents moved.
 *
 * This module lives under `scripts/` so `Dockerfile.publish-bootstrap-tiers`
 * can import it. Do not move it under `tests/`.
 */

/**
 * The 2026-08-21 capture was taken from the full WorldMonitor registry. The
 * NucMonitor trim retired most of its keys, so the ledger below is RE-DERIVED
 * from that capture: it keeps the frozen per-key byte evidence, unchanged, for
 * exactly the captured keys that are still registered in
 * shared/bootstrap-tier-keys.js (in their captured tier), and `decodedBytes`
 * is the reconstruction of a `{"data":{...},"missing":[]}` body from those rows.
 * The original bodies are kept as provenance (`source*`); the absolute final
 * ceilings and the #7046 net-reduction targets are still measured against
 * them, because that is the baseline those targets were set from.
 */
export const PRODUCTION_CAPTURE = Object.freeze({
  capturedAt: '2026-08-21T14:51:50Z',
  origin: 'https://worldmonitor.app',
  requestShape: 'GET [REDACTED]/api/bootstrap?tier=<tier>&public=1',
  completeness: 'Both responses were HTTP 200, parsed successfully, and declared missing: [].',
  limitation: 'Single complete public capture; not the full daily #7047 U1/RUM baseline.',
  derivation: 'Re-derived for the NucMonitor key set: captured rows for keys no longer registered were dropped; surviving rows are byte-for-byte the capture.',
  tiers: Object.freeze({
    fast: Object.freeze({
      decodedBytes: 528_755,
      sourceDecodedBytes: 921_832,
      sha256: '9723bf77e7a88323e58e747977c64d8ba1bcee77b72b9db06fe5d37c2773d3de',
    }),
    slow: Object.freeze({
      decodedBytes: 1_166_983,
      sourceDecodedBytes: 1_977_154,
      sha256: '0d4caebf63182d1f816ec41bfc47b0f5e30efc378722b0cab785ebd70d85bcdb',
    }),
  }),
});

export const CAPTURED_BASE_TIER_KEYS = Object.freeze({
  fast: Object.freeze([
    'earthquakes', 'outages', 'serviceStatuses', 'ddosAttacks', 'trafficAnomalies',
    'marketQuotes', 'commodityQuotes', 'weatherAlerts',
  ]),
  slow: Object.freeze([
    'bisPolicy', 'bisExchange', 'bisCredit', 'climateAnomalies', 'climateDisasters',
    'co2Monitoring', 'oceanIce', 'climateNews', 'radiationWatch', 'wildfires',
    'techReadiness', 'naturalEvents', 'cryptoQuotes', 'cryptoSectors', 'defiTokens',
    'aiTokens', 'otherTokens', 'nationalDebt', 'euGasStorage', 'eurostatCountryData',
    'crudeInventories', 'natGasStorage', 'ecbFxRates', 'diseaseOutbreaks',
    'oilStocksAnalysis', 'lngVulnerability', 'pipelinesGas', 'pipelinesOil',
    'storageFacilities',
  ]),
});

/** Exact UTF-8 bytes of JSON.stringify(data[key]) from the frozen responses. */
export const CAPTURED_KEY_DECODED_BYTES = Object.freeze({
  earthquakes: 48_361,
  outages: 3_702,
  serviceStatuses: 6_583,
  ddosAttacks: 744,
  trafficAnomalies: 3_045,
  marketQuotes: 296_547,
  commodityQuotes: 116_985,
  weatherAlerts: 52_633,
  bisPolicy: 1_395,
  bisExchange: 1_354,
  bisCredit: 1_310,
  climateAnomalies: 5_031,
  climateDisasters: 21_205,
  co2Monitoring: 822,
  oceanIce: 970,
  climateNews: 51_058,
  radiationWatch: 5_727,
  wildfires: 165_622,
  techReadiness: 45_451,
  naturalEvents: 200_792,
  cryptoQuotes: 9_713,
  cryptoSectors: 414,
  defiTokens: 831,
  aiTokens: 885,
  otherTokens: 848,
  nationalDebt: 45_401,
  euGasStorage: 452,
  eurostatCountryData: 2_197,
  crudeInventories: 558,
  natGasStorage: 519,
  ecbFxRates: 514,
  diseaseOutbreaks: 68_863,
  oilStocksAnalysis: 4_057,
  lngVulnerability: 2_501,
  pipelinesGas: 193_403,
  pipelinesOil: 221_043,
  storageFacilities: 113_540,
});

// Absolute final ceilings are the required reductions applied to the complete
// source capture (`sourceDecodedBytes`), not to a hand-picked subset:
// FAST <= 80%, SLOW <= 75% of base.
export const FINAL_TIER_DECODED_BYTE_CEILINGS = Object.freeze({
  fast: 737_465,
  slow: 1_482_865,
});

export const BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST = Object.freeze({
  version: 1,
  capturedAt: PRODUCTION_CAPTURE.capturedAt,
  tiers: Object.freeze({
    fast: Object.freeze({
      preChangeCeilingBytes: PRODUCTION_CAPTURE.tiers.fast.decodedBytes,
      finalTargetBytes: FINAL_TIER_DECODED_BYTE_CEILINGS.fast,
      minimumCapturedKeyCount: CAPTURED_BASE_TIER_KEYS.fast.length,
      materialGrowthRatio: 0.05,
      materialGrowthFloorBytes: 2_048,
      reviewedExceptions: Object.freeze({}),
    }),
    slow: Object.freeze({
      preChangeCeilingBytes: PRODUCTION_CAPTURE.tiers.slow.decodedBytes,
      finalTargetBytes: FINAL_TIER_DECODED_BYTE_CEILINGS.slow,
      minimumCapturedKeyCount: CAPTURED_BASE_TIER_KEYS.slow.length,
      materialGrowthRatio: 0.05,
      materialGrowthFloorBytes: 2_048,
      reviewedExceptions: Object.freeze({}),
    }),
  }),
});

/**
 * Supported keys that are legal in a published ledger but have no frozen size
 * in the capture (feature-gated producers). None remain after the trim.
 */
export const FEATURE_GATED_UNCAPTURED_KEYS = Object.freeze({});

function isFeatureGatedUncapturedKey(tier, key) {
  return FEATURE_GATED_UNCAPTURED_KEYS[key]?.tier === tier;
}

export function materialGrowthAllowanceBytes(capturedBytes, budget) {
  return Math.max(
    budget.materialGrowthFloorBytes,
    Math.ceil(capturedBytes * budget.materialGrowthRatio),
  );
}

function reviewedExceptionCovers(budget, key, valueBytes) {
  const exception = budget.reviewedExceptions[key];
  return Boolean(
    exception
    && typeof exception.rationale === 'string'
    && exception.rationale.trim().length > 0
    && Number.isInteger(exception.ceilingBytes)
    && valueBytes <= exception.ceilingBytes,
  );
}

/**
 * Compare a published `{ data, missing }` ledger with the frozen capture.
 * Returns alerts for operators; never throws on production volume drift.
 */
export function evaluatePublishedBootstrapVolume(tier, ledger) {
  const budget = BOOTSTRAP_PAYLOAD_BUDGET_MANIFEST.tiers[tier];
  if (!budget) throw new TypeError(`Unknown bootstrap budget tier: ${tier}`);
  if (
    !ledger
    || !Number.isInteger(ledger.totalBytes)
    || !Array.isArray(ledger.keys)
  ) {
    throw new TypeError('Published volume evaluation requires a byte ledger');
  }

  const alerts = [];
  if (ledger.totalBytes > budget.finalTargetBytes) {
    alerts.push({
      kind: 'tier-ceiling',
      tier,
      bytes: ledger.totalBytes,
      limitBytes: budget.finalTargetBytes,
    });
  }

  for (const entry of ledger.keys) {
    const key = entry?.key;
    const valueBytes = entry?.valueBytes;
    if (typeof key !== 'string' || !Number.isInteger(valueBytes)) {
      throw new TypeError('Published volume evaluation requires integer valueBytes per key');
    }

    const capturedBytes = CAPTURED_KEY_DECODED_BYTES[key];
    if (!Number.isInteger(capturedBytes)) {
      if (!isFeatureGatedUncapturedKey(tier, key)) {
        alerts.push({ kind: 'unmeasured-key', tier, key, bytes: valueBytes });
      }
      continue;
    }

    const allowanceBytes = materialGrowthAllowanceBytes(capturedBytes, budget);
    if (valueBytes <= capturedBytes + allowanceBytes) continue;
    if (reviewedExceptionCovers(budget, key, valueBytes)) continue;

    alerts.push({
      kind: 'key-growth',
      tier,
      key,
      bytes: valueBytes,
      capturedBytes,
      allowanceBytes,
    });
  }

  return {
    ceilingBytes: budget.finalTargetBytes,
    alerts,
  };
}
