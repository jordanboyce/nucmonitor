// Health classifier — classify + cascade + overall-status regression tests.
//
// Exercises the REAL /api/health classifier surface exported via `__testing__`
// (classifyKey + STATUS_COUNTS) plus the overall-status thresholds the handler
// applies inline. classifyKey resolves cascade coverage PROACTIVELY
// (isCascadeCovered) at classify time — there is no separate downgrade pass —
// so cascade behavior is asserted through classifyKey's returned status.
//
// Uses node:test + node:assert to match the repo's data-test runner
// (`tsx --test tests/*.test.mjs` / `node --test`), the same harness as
// tests/health-content-age.test.mjs. Vitest's describe/it is NOT compatible
// with the bare node test runner used here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { __testing__ } from '../api/health.js';
import { BUNDLE_HEARTBEAT_TTL_SECONDS, bundleHeartbeatKey } from '../scripts/_bundle-runner.mjs';
import { isOnDemandProblem, findOperationalProblems } from '../scripts/check-seed-freshness.mjs';

const {
  classifyKey,
  healthResponseBody,
  STATUS_COUNTS,
  BOOTSTRAP_KEYS,
  STANDALONE_KEYS,
  SEED_META,
  ON_DEMAND_KEYS,
  ZERO_RECORD_DATA_OK_KEYS,
  EMPTY_DATA_OK_KEYS,
  projectChinaCoverageStatus,
  composeChinaDecisionSignalsStatus,
  computeOverallStatus,
  isContainedHealthWarning,
} = __testing__;

const NOW = 1_700_000_000_000;
const ONE_MIN_MS = 60_000;

test('NHC first-failure pending is bounded by its original complete snapshot', () => {
  const name = 'naturalEvents';
  const key = BOOTSTRAP_KEYS[name];
  const meta = {
    fetchedAt: NOW,
    recordCount: 2,
    sourceState: 'degraded',
    errorCode: 'NHC_POINT_REQUEST_FAILED',
    consecutiveSourceFailures: 1,
    lastSourceFailureCode: 'NHC_POINT_REQUEST_FAILED',
    firstSourceFailureAt: NOW,
    lastSourceAttemptAt: NOW,
    lastSourceSuccessAt: NOW - 539 * ONE_MIN_MS,
  };
  const classify = (over = {}, now = NOW) => classifyKey(name, key, { allowOnDemand: false }, {
    ...makeCtx({ strens: { [key]: 1024 }, metaValues: { [SEED_META[name].key]: { ...meta, ...over } } }),
    now,
  });

  const entry = classify();
  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.sourceFailurePendingUntil, new Date(NOW + ONE_MIN_MS).toISOString());
  assert.equal(__testing__.healthStatusBucket(entry, NOW), 'ok');
  for (const over of [
    { consecutiveSourceFailures: 2 },
    { recordCount: 0 },
    { lastSourceSuccessAt: null },
    { lastSourceSuccessAt: NOW + 1 },
    { firstSourceFailureAt: null },
    { errorCode: 'NHC_UNRECOGNIZED_FAILURE', lastSourceFailureCode: 'NHC_UNRECOGNIZED_FAILURE' },
  ]) {
    const failed = classify(over);
    assert.equal(failed.sourceFailurePendingUntil, undefined, JSON.stringify(over));
    assert.notEqual(__testing__.healthStatusBucket(failed, NOW), 'ok', JSON.stringify(over));
  }
});

test('natural events accepts a published complete empty aggregate but not a missing key', () => {
  const name = 'naturalEvents';
  const key = BOOTSTRAP_KEYS[name];
  const metaValues = { [SEED_META[name].key]: { fetchedAt: NOW, recordCount: 0, sourceState: 'ok' } };
  const present = classifyKey(name, key, { allowOnDemand: false }, makeCtx({ strens: { [key]: 100 }, metaValues }));
  const missing = classifyKey(name, key, { allowOnDemand: false }, makeCtx({ strens: { [key]: 0 }, metaValues }));
  assert.equal(present.status, 'OK');
  assert.equal(missing.status, 'EMPTY');
});

// Build the same ctx shape the handler constructs: four Maps + now.
//   strens:     { redisDataKey -> byteLen }
//   errors:     { redisDataKey -> errMsg }
//   metaValues: { seedMetaKey  -> raw JSON string }
//   metaErrors: { seedMetaKey  -> errMsg }
function makeCtx({ strens = {}, errors = {}, metaValues = {}, metaErrors = {}, activationStates = null } = {}) {
  return {
    containmentEvidenceByName: new Map(),
    keyStrens: new Map(Object.entries(strens)),
    keyErrors: new Map(Object.entries(errors)),
    keyMetaValues: new Map(Object.entries(metaValues).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])),
    keyMetaErrors: new Map(Object.entries(metaErrors)),
    // Three-valued, exactly like readExistsFlags: true = marker present,
    // false = marker READ and absent (positive proof of pre-activation),
    // key missing = unknown.
    ...(activationStates ? { activationStates: new Map(Object.entries(activationStates)) } : {}),
    now: NOW,
  };
}

const seedMeta = (over = {}) => JSON.stringify({ fetchedAt: NOW - ONE_MIN_MS, recordCount: 5, ...over });
const classifyNewsInsights = (over = {}) => classifyKey(
  'newsInsights',
  BOOTSTRAP_KEYS.newsInsights,
  { allowOnDemand: false },
  makeCtx({
    strens: { [BOOTSTRAP_KEYS.newsInsights]: 4096 },
    metaValues: { [SEED_META.newsInsights.key]: seedMeta(over) },
  }),
);

// ── STATUS_COUNTS buckets ───────────────────────────────────────────────────

test('STATUS_COUNTS buckets OK/cascade to ok, empty to crit, on-demand/stale to warn', () => {
  assert.equal(STATUS_COUNTS.OK, 'ok');
  assert.equal(STATUS_COUNTS.OK_CASCADE, 'ok');
  assert.equal(STATUS_COUNTS.EMPTY, 'crit');
  assert.equal(STATUS_COUNTS.EMPTY_DATA, 'crit');
  assert.equal(STATUS_COUNTS.EMPTY_ON_DEMAND, 'warn');
  assert.equal(STATUS_COUNTS.STALE_SEED, 'warn');
});

// Deliberately `ok`, not `warn`. Two pillars ship ~6 countries above their
// floors today, so a warn bucket would flip fleet health to WARNING on the
// current healthy cohort and stay lit until coverage grows — the chronically
// red monitor that stops being read. Registration here is load-bearing on its
// own: the summary does `STATUS_COUNTS[status] ?? 'warn'`, so an unregistered
// status silently becomes the warn this exists to avoid.
test('STATUS_COUNTS buckets COVERAGE_MARGIN_LOW to ok so a thin-but-passing cohort never alerts', () => {
  assert.equal(STATUS_COUNTS.COVERAGE_MARGIN_LOW, 'ok');
});

// ── pool coverage margin (scorecardFiveFactor) ──────────────────────────────

// ── classifyKey core statuses ───────────────────────────────────────────────

test('classifyKey: fresh seed + data → OK', () => {
  const entry = classifyKey('earthquakes', BOOTSTRAP_KEYS.earthquakes, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.earthquakes]: 1234 },
      metaValues: { 'seed-meta:seismology:earthquakes': seedMeta() },
    }));
  assert.equal(entry.status, 'OK');
});

test('classifyKey: present-but-stale seed → STALE_SEED (warn), data still present', () => {
  const entry = classifyKey('earthquakes', BOOTSTRAP_KEYS.earthquakes, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.earthquakes]: 1234 },
      // earthquakes maxStaleMin=30; 200 min exceeds it
      metaValues: { 'seed-meta:seismology:earthquakes': seedMeta({ fetchedAt: NOW - 200 * ONE_MIN_MS }) },
    }));
  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: repeated insights synthesis rejection warns while the LKG remains present', () => {
  const entry = classifyNewsInsights({
    fetchedAt: NOW - 5 * ONE_MIN_MS,
    recordCount: 8,
    lastAttemptAt: NOW - 2 * ONE_MIN_MS,
    lastSuccessAt: NOW - 45 * ONE_MIN_MS,
    servedGeneratedAt: '2026-08-01T06:30:39.268Z',
    consecutiveFailures: 2,
    lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_PARSE',
  });

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.records, 8);
  assert.equal(entry.consecutiveFailures, 2);
  assert.equal(entry.lastSynthesisFailureCode, 'INSIGHTS_SYNTHESIS_PARSE');
  assert.equal(entry.servedGeneratedAt, '2026-08-01T06:30:39.268Z');
  assert.equal(entry.lastSuccessAt, NOW - 45 * ONE_MIN_MS);
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: one recent insights synthesis failure stays OK within the warning bounds', () => {
  const entry = classifyNewsInsights({
    fetchedAt: NOW - 5 * ONE_MIN_MS,
    recordCount: 8,
    lastAttemptAt: NOW - 2 * ONE_MIN_MS,
    lastSuccessAt: NOW - 5 * ONE_MIN_MS,
    servedGeneratedAt: '2026-08-01T08:25:39.268Z',
    consecutiveFailures: 1,
    lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_GATE',
  });

  assert.equal(entry.status, 'OK');
  assert.equal(STATUS_COUNTS[entry.status], 'ok');
  assert.equal(entry.consecutiveFailures, 1);
  assert.equal(entry.lastSynthesisFailureCode, 'INSIGHTS_SYNTHESIS_GATE');
});

test('classifyKey: an old single insights synthesis failure warns by age', () => {
  const entry = classifyNewsInsights({
    fetchedAt: NOW - 5 * ONE_MIN_MS,
    recordCount: 8,
    lastAttemptAt: NOW - 25 * ONE_MIN_MS,
    lastSuccessAt: NOW - 10 * ONE_MIN_MS,
    servedGeneratedAt: '2026-08-01T06:30:39.268Z',
    consecutiveFailures: 1,
    lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_GATE',
  });

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.synthesisFailureAgeMin, 25);
});

test('classifyKey: a fresh successful insights publication clears synthesis warning state', () => {
  const entry = classifyNewsInsights({
    fetchedAt: NOW - ONE_MIN_MS,
    recordCount: 8,
    lastAttemptAt: NOW - ONE_MIN_MS,
    lastSuccessAt: NOW - ONE_MIN_MS,
    servedGeneratedAt: '2026-08-01T08:30:39.268Z',
    consecutiveFailures: 0,
    lastSynthesisFailureCode: null,
  });

  assert.equal(entry.status, 'OK');
  assert.equal(entry.consecutiveFailures, 0);
  assert.equal(entry.servedGeneratedAt, '2026-08-01T08:30:39.268Z');
});

test('classifyKey: no-LKG synthesis failure warns even on the first attempted publication', () => {
  const entry = classifyNewsInsights({
    fetchedAt: NOW - ONE_MIN_MS,
    recordCount: 8,
    lastAttemptAt: NOW - ONE_MIN_MS,
    lastSuccessAt: null,
    servedGeneratedAt: '2026-08-01T08:30:39.268Z',
    consecutiveFailures: 1,
    lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_MISSING_CLUSTER',
  });

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.consecutiveFailures, 1);
  assert.equal(entry.lastSuccessAt, null);
});

test('every synthesisFailure key declares its own failure-code vocabulary', () => {
  // readSeedMeta falls back to the insights pattern when a key omits
  // failureCodePattern, which would silently DROP every code a third producer
  // writes — its streak would still escalate, but the reason would vanish.
  // The fallback stays for safety; this is the guard that stops a new key
  // from depending on it.
  const withContract = Object.entries(SEED_META).filter(([, cfg]) => cfg?.synthesisFailure);
  assert.ok(withContract.length >= 1, 'guard against this passing because the mechanism disappeared');
  for (const [name, cfg] of withContract) {
    assert.ok(
      cfg.synthesisFailure.failureCodePattern instanceof RegExp,
      `${name} must declare its own failureCodePattern, not inherit the insights default`,
    );
    assert.ok(
      !cfg.synthesisFailure.failureCodePattern.global,
      `${name}'s pattern must not be /g — a stateful lastIndex makes .test() alternate between true and false`,
    );
  }
});

test('classifyKey: an insights failure streak likewise cannot mask a vanished LKG', () => {
  // Same precedence, asserted on the other key that carries this contract, so
  // the fix is not silently market-implications-only.
  const entry = classifyKey(
    'newsInsights',
    BOOTSTRAP_KEYS.newsInsights,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.newsInsights.key]: seedMeta({
          lastAttemptAt: NOW - 2 * ONE_MIN_MS,
          consecutiveFailures: 2,
          lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_PARSE',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'EMPTY');
});

// ── Producer fault vs. missing data, fleet-wide (#6263) ──────────────────────
// The synthesisFailure arm above learned to yield to the absence verdict. The
// `seedError` and `sourceBlocked` arms sit on the same seam and apply to EVERY
// SEED_META key, so the rule has to be stated once for all of them: a
// producer-fault verdict says WHY the producer is unhappy, the absence verdict
// says WHETHER anything is being served, and when both are true the STRONGER
// one wins.
//
// That is deliberately not the one-word `&& hasData` guard the issue proposed.
// Four key classes resolve an absent data key to something SOFTER than
// SEED_ERROR — EMPTY_DATA_OK_KEYS (OK/STALE_SEED), cascade coverage
// (OK_CASCADE), on-demand (EMPTY_ON_DEMAND) and rollout (ROLLOUT_PENDING) — so
// a bare guard would demote or silence those instead of escalating them. Each
// class gets a lock below.

test('classifyKey: an error seed-meta must not downgrade a vanished panel from EMPTY to a warn', () => {
  // The fleet-wide twin of the synthesisFailure case above (earthquakes is the
  // fixture: any strict, non-EMPTY_DATA_OK key takes this path). seed-meta holds 7
  // days, the canonical key 180min, so a producer that errored once and then
  // stopped leaves a blank homepage panel reporting warn for the rest of the
  // week.
  const entry = classifyKey(
    'earthquakes',
    BOOTSTRAP_KEYS.earthquakes,
    { allowOnDemand: false },
    makeCtx({
      strens: {}, // canonical key expired -> panel is blank
      metaValues: {
        [SEED_META.earthquakes.key]: JSON.stringify({
          fetchedAt: NOW - 190 * ONE_MIN_MS,
          recordCount: 0,
          status: 'error',
          errorReason: 'usgs_feed_failed',
          errorCode: 'USGS_FEED_FAILED',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
  assert.equal(
    entry.errorCode,
    'USGS_FEED_FAILED',
    'escalating the severity must not cost the operator the cause the producer recorded',
  );
});

test('classifyKey: a degraded sourceState likewise cannot mask a vanished panel', () => {
  // seedError has two producers: `status:'error'` (above) and any non-ok
  // `sourceState` (here). The second reaches classifyKey with a FRESH
  // fetchedAt — seedStale stays false — so it is the arm that can hide an
  // absence behind an otherwise healthy-looking meta.
  const entry = classifyKey(
    'earthquakes',
    BOOTSTRAP_KEYS.earthquakes,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.earthquakes.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 5,
          sourceState: 'error',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

test('classifyKey: a blocked source with no data escalates like every other fault', () => {
  // The `sourceBlocked` arm has the same shape: a blocked producer whose
  // payload has vanished reports the absence (EMPTY), not a softer fault.
  const blockedAndAbsent = (name) => classifyKey(
    name,
    BOOTSTRAP_KEYS[name],
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META[name].key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          sourceState: 'blocked',
        }),
      },
    }),
  );

  assert.equal(blockedAndAbsent('earthquakes').status, 'EMPTY');

  // EMPTY alone does not prove the blocked fault still fires at all — a guard
  // that dropped it entirely would produce the same verdict. Pin the other
  // direction on the same key: with data present, the blocked arm yields its
  // fault.
  const blockedWithData = classifyKey(
    'earthquakes',
    BOOTSTRAP_KEYS.earthquakes,
    { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.earthquakes]: 2048 },
      metaValues: {
        [SEED_META.earthquakes.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 4,
          sourceState: 'blocked',
        }),
      },
    }),
  );
  assert.equal(blockedWithData.status, 'SEED_ERROR');
});

test('classifyKey: an EMPTY_DATA_OK key keeps a producer SEED_ERROR when its payload is absent', () => {
  // The rule covers every key in EMPTY_DATA_OK_KEYS, whose absence branch
  // resolves to OK/STALE_SEED — softer than the fault. weatherAlerts is only
  // the fixture (EMPTY_DATA_OK but not MISSING_DATA_IS_FAILURE); the reader
  // path is shared. A bare `&& hasData` guard would demote the error to
  // a generic STALE_SEED and drop the reason.
  const entry = classifyKey(
    'weatherAlerts',
    BOOTSTRAP_KEYS.weatherAlerts,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.weatherAlerts.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          status: 'error',
          errorReason: 'nws_feed_failed',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: a fresh degraded funnel source is not silently OK when its payload is absent', () => {
  // The sharpest edge of the same class: `sourceState` degradation leaves
  // seedStale false, so EMPTY_DATA_OK_KEYS resolves the absence to plain OK. A
  // bare `&& hasData` guard would turn a reported producer fault into a green
  // check — the exact softening #6263 exists to remove.
  const entry = classifyKey(
    'weatherAlerts',
    BOOTSTRAP_KEYS.weatherAlerts,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.weatherAlerts.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          sourceState: 'error',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'SEED_ERROR');
  // The absence verdict this beat, asserted directly: with the fault removed
  // the very same fixture resolves to a green OK, so the fault is doing all the
  // work here and a guard that skipped it would ship a silent pass.
  const withoutFault = classifyKey(
    'weatherAlerts',
    BOOTSTRAP_KEYS.weatherAlerts,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.weatherAlerts.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
        }),
      },
    }),
  );
  assert.equal(withoutFault.status, 'OK');
});

test('classifyKey: a compact projection that must always publish is EMPTY when it errors with no payload', () => {
  // MISSING_DATA_IS_FAILURE_KEYS members publish a canonical payload on every
  // successful cycle, so a vanished payload is a real publish failure. The set
  // is also a subset of EMPTY_DATA_OK_KEYS, whose absence verdict is only
  // STALE_SEED — so if the strict arm is skipped, the fault ties the softer
  // verdict and wins, and the key reports warn.
  //
  // The arm is skipped exactly when `seedStale === true`, and readSeedMeta
  // SYNTHESIZES that on the `status:'error'` return as a fault marker rather
  // than measuring it. Reading a fault marker as "the meta aged out" is what
  // let #6263's own headline case — a `status:'error'` seed-meta over a
  // vanished panel — survive on every one of these keys.
  const entry = classifyKey(
    'wildfiresBootstrap',
    BOOTSTRAP_KEYS.wildfiresBootstrap,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.wildfiresBootstrap.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          status: 'error',
          errorReason: 'publish_failed',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

test('classifyKey: both fault paths agree for one physical state on a strict projection', () => {
  // The parity that finding above turns on. `status:'error'` and a non-ok
  // `sourceState` are two ways to say "the producer is failing", and
  // readSeedMeta treats them differently — the first forces seedStale true, the
  // second measures it. Same key, same absent payload, same fault: the verdict
  // must not depend on which dialect the producer used.
  const classifyWith = (meta) => classifyKey(
    'wildfiresBootstrap',
    BOOTSTRAP_KEYS.wildfiresBootstrap,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.wildfiresBootstrap.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          ...meta,
        }),
      },
    }),
  );

  assert.equal(
    classifyWith({ status: 'error', errorReason: 'publish_failed' }).status,
    classifyWith({ sourceState: 'error' }).status,
    'a producer reporting failure via status:error must classify like one reporting it via sourceState',
  );
});

test('classifyKey: a strict projection that has never published keeps its STALE_SEED grace', () => {
  // The other side of the same guard, and the reason it cannot simply be
  // deleted: before the producer's first run the payload is absent with no
  // fault recorded, and EMPTY (crit) would be a false alarm on a key that is
  // merely new. Only a REPORTED fault revokes the grace — absence alone does
  // not.
  const entry = classifyKey(
    'wildfiresBootstrap',
    BOOTSTRAP_KEYS.wildfiresBootstrap,
    { allowOnDemand: false },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.wildfiresBootstrap.key]: JSON.stringify({
          fetchedAt: NOW - 10_000 * ONE_MIN_MS, // long past maxStaleMin
          recordCount: 0,
        }),
      },
    }),
  );

  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: an unconfigured adapter raises no fault and publishes no errorCode', () => {
  // NOT_CONFIGURED means "this deployment never opted into the adapter", so
  // there is nothing to be degraded ABOUT — the fault is skipped entirely
  // rather than merely losing the verdict. Without the `!sourceUnavailable`
  // guard the fault still fires, and a green NOT_CONFIGURED entry ships an
  // errorCode for a producer this deployment does not run.
  //
  // Asserted on `errorCode` only. `lastSynthesisFailureCode` is deliberately
  // ungated upstream — it rides with consecutiveFailures/lastAttemptAt, which
  // publish on every status — so its presence here is correct, not a leak.
  const entry = classifyKey(
    'newsInsights',
    BOOTSTRAP_KEYS.newsInsights,
    { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.newsInsights]: 4096 },
      metaValues: {
        [SEED_META.newsInsights.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 5,
          sourceState: 'unavailable',
          errorCode: 'PRODUCER_FAILED',
          lastAttemptAt: NOW - ONE_MIN_MS,
          lastSuccessAt: NOW - 200 * ONE_MIN_MS,
          consecutiveFailures: 3,
          lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_PARSE',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'NOT_CONFIGURED');
  assert.equal(STATUS_COUNTS[entry.status], 'ok');
  assert.equal(Object.hasOwn(entry, 'errorCode'), false, 'an unconfigured adapter has no fault to explain');
});

test('classifyKey: a fault outranks every served-data verdict it precedes', () => {
  // The refactor hoisted the fault arms out of the status if/else chain into a
  // precomputed `fault`, and only the placement of `else if (fault)` keeps them
  // ahead of the records===0 / staleness / coverage arms. Nothing else pins
  // that ordering, so a reordering would go unnoticed — most visibly as
  // EMPTY_DATA, which is what a mis-ordered fault arm produces for the
  // zero-record case.
  const withData = (over) => classifyKey(
    'earthquakes',
    BOOTSTRAP_KEYS.earthquakes,
    { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.earthquakes]: 4096 },
      metaValues: {
        [SEED_META.earthquakes.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 5,
          ...over,
        }),
      },
    }),
  );

  assert.equal(withData({ status: 'error' }).status, 'SEED_ERROR', 'fault beats a healthy served payload');
  assert.equal(
    withData({ status: 'error', recordCount: 0 }).status,
    'SEED_ERROR',
    'fault beats EMPTY_DATA — a zero-record payload under a reported fault is the fault, not a separate finding',
  );
  assert.equal(
    withData({ sourceState: 'error', fetchedAt: NOW - 10_000 * ONE_MIN_MS }).status,
    'SEED_ERROR',
    'fault beats STALE_SEED',
  );
});

test('classifyKey: an on-demand key with an error seed-meta keeps the error verdict', () => {
  // EMPTY_ON_DEMAND and SEED_ERROR are both warn, so severity alone does not
  // separate them — the tie goes to the fault, which is the only one of the two
  // that carries a cause.
  const entry = classifyKey(
    'macroSignals',
    STANDALONE_KEYS.macroSignals,
    { allowOnDemand: true },
    makeCtx({
      strens: {},
      metaValues: {
        [SEED_META.macroSignals.key]: JSON.stringify({
          fetchedAt: NOW - ONE_MIN_MS,
          recordCount: 0,
          status: 'error',
          errorReason: 'macro_publish_failed',
        }),
      },
    }),
  );

  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(entry.onDemand, true);
});

test('compact health problem projection retains insights synthesis diagnostics', () => {
  const snapshot = {
    status: 'WARNING',
    summary: { total: 1, ok: 0, warn: 1, crit: 0 },
    checkedAt: '2026-08-01T08:31:00.000Z',
    checks: {
      newsInsights: {
        status: 'SEED_ERROR',
        records: 8,
        maxStaleMin: 30,
        consecutiveFailures: 2,
        lastSynthesisFailureCode: 'INSIGHTS_SYNTHESIS_PARSE',
        servedGeneratedAt: '2026-08-01T06:30:39.268Z',
      },
    },
  };

  assert.deepEqual(healthResponseBody(snapshot, true).problems.newsInsights, snapshot.checks.newsInsights);
});

test('classifyKey: sector valuation partial/total loss degrades despite 12 price rows', () => {
  for (const valuationState of [
    { sourceState: 'partial', valuationRecordCount: 3 },
    { sourceState: 'error', valuationRecordCount: 0 },
  ]) {
    const entry = classifyKey('sectors', BOOTSTRAP_KEYS.sectors, { allowOnDemand: false },
      makeCtx({
        strens: { [BOOTSTRAP_KEYS.sectors]: 1234 },
        metaValues: {
          'seed-meta:market:sectors': seedMeta({
            recordCount: 12,
            sectorRecordCount: 12,
            expectedValuationRecordCount: 12,
            ...valuationState,
          }),
        },
      }));

    assert.equal(entry.status, 'SEED_ERROR');
    assert.equal(entry.records, 12, 'price coverage remains visible');
    assert.equal(STATUS_COUNTS[entry.status], 'warn');
  }
});

test('classifyKey: sector valuation recovery returns health to OK', () => {
  const entry = classifyKey('sectors', BOOTSTRAP_KEYS.sectors, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.sectors]: 1234 },
      metaValues: {
        'seed-meta:market:sectors': seedMeta({
          recordCount: 12,
          sectorRecordCount: 12,
          valuationRecordCount: 12,
          expectedValuationRecordCount: 12,
          sourceState: 'ok',
        }),
      },
    }));

  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 12);
});

test('classifyKey: unsafe free-form error codes are not reflected into health', () => {
  const entry = classifyKey('earthquakes', BOOTSTRAP_KEYS.earthquakes, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.earthquakes]: 4096 },
      metaValues: {
        [SEED_META.earthquakes.key]: seedMeta({
          status: 'error',
          errorCode: 'proxy failed at https://user:pass@example.test',
        }),
      },
    }));
  assert.equal(entry.status, 'SEED_ERROR');
  assert.equal(Object.hasOwn(entry, 'errorCode'), false);
});

test('compact health preserves the bounded GDELT failure code', () => {
  const snapshot = {
    status: 'WARNING',
    summary: { ok: 1, warn: 1, crit: 0 },
    checkedAt: '2026-07-29T08:00:00.000Z',
    checks: {
      gdeltIntel: {
        status: 'SEED_ERROR',
        records: 6,
        maxStaleMin: 720,
        errorCode: 'GDELT_SHARED_PROXY_TLS',
      },
    },
  };
  assert.deepEqual(healthResponseBody(snapshot, true).problems.gdeltIntel, {
    status: 'SEED_ERROR',
    records: 6,
    maxStaleMin: 720,
    errorCode: 'GDELT_SHARED_PROXY_TLS',
  });
});

test('classifyKey: degraded source with a non-positive or invalid fetchedAt exposes unknown age', () => {
  const name = 'macroSignals';
  const dataKey = STANDALONE_KEYS[name];
  const metaKey = SEED_META[name].key;

  for (const fetchedAt of [0, -1, 'invalid']) {
    const entry = classifyKey(name, dataKey, { allowOnDemand: true },
      makeCtx({
        strens: { [dataKey]: 396 },
        metaValues: {
          [metaKey]: seedMeta({
            fetchedAt,
            recordCount: 2,
            sourceState: 'error',
            stale: true,
          }),
        },
      }));

    assert.equal(entry.status, 'SEED_ERROR', String(fetchedAt));
    assert.equal(entry.records, 2, String(fetchedAt));
    assert.equal(
      Object.hasOwn(entry, 'seedAgeMin'),
      false,
      `${String(fetchedAt)} must remain unknown instead of fabricating an age`,
    );
  }
});

test('classifyKey: empty bootstrap key (no cascade) → EMPTY (crit)', () => {
  const entry = classifyKey('earthquakes', BOOTSTRAP_KEYS.earthquakes, { allowOnDemand: false },
    makeCtx({ metaValues: { 'seed-meta:seismology:earthquakes': seedMeta() } }));
  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

const ISSUE_5055_HEALTH_REGISTRATIONS = [
  ['energyPrices', 'economic:energy:v1:all', 'seed-meta:economic:energy-prices', 150],
  ['sharedFxRates', 'shared:fx-rates:v1', 'seed-meta:shared:fx-rates', 3600],
  ['submarineCables', 'infrastructure:submarine-cables:v1', 'seed-meta:infrastructure:submarine-cables', 25200],
];

test('issue #5055: validated seed-meta writers are registered in /api/health', () => {
  for (const [name, dataKey, metaKey, maxStaleMin] of ISSUE_5055_HEALTH_REGISTRATIONS) {
    assert.equal(STANDALONE_KEYS[name], dataKey, `${name} data key`);
    assert.equal(SEED_META[name]?.key, metaKey, `${name} seed-meta key`);
    assert.equal(SEED_META[name]?.maxStaleMin, maxStaleMin, `${name} maxStaleMin`);
  }
});

test('classifyKey: issue #5055 strict seeds surface missing metadata instead of reporting OK', () => {
  const entry = classifyKey('energyPrices', STANDALONE_KEYS.energyPrices, { allowOnDemand: true },
    makeCtx({ strens: { [STANDALONE_KEYS.energyPrices]: 2048 } }));

  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(entry.records, 1);
  assert.equal(entry.maxStaleMin, 150);
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: empty on-demand standalone key → EMPTY_ON_DEMAND (warn)', () => {
  // serviceStatuses is in ON_DEMAND_KEYS and has no SEED_META entry.
  assert.ok(ON_DEMAND_KEYS.has('serviceStatuses'));
  assert.equal(SEED_META.serviceStatuses, undefined);
  const entry = classifyKey('serviceStatuses', STANDALONE_KEYS.serviceStatuses, { allowOnDemand: true }, makeCtx({}));
  assert.equal(entry.status, 'EMPTY_ON_DEMAND');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: webcams active pointer is registered with seed-meta freshness', () => {
  const entry = classifyKey('webcams', STANDALONE_KEYS.webcams, { allowOnDemand: true },
    makeCtx({
      strens: { [STANDALONE_KEYS.webcams]: 13 },
      metaValues: { 'seed-meta:webcam:cameras:geo': seedMeta({ recordCount: 65000 }) },
    }));

  assert.equal(STANDALONE_KEYS.webcams, 'webcam:cameras:active');
  assert.equal(entry.status, 'OK');
  assert.equal(entry.records, 65000);
  assert.equal(entry.maxStaleMin, 1440);
});

const BUNDLE_TICKS = [
  ['staticRefBundleTick', 'static-ref', 'scripts/seed-bundle-static-ref.mjs', 6691],
];

test('classifyKey: each bundle tick heartbeat goes EMPTY when the cron never fired and STALE when it freezes', () => {
  for (const [name, label] of BUNDLE_TICKS) {
    const dataKey = STANDALONE_KEYS[name];
    const seedCfg = SEED_META[name];
    assert.equal(dataKey, bundleHeartbeatKey(label), name);

    const missing = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({}));
    assert.equal(missing.status, 'EMPTY', name);
    assert.equal(STATUS_COUNTS[missing.status], 'crit', name);

    const stale = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({
      strens: { [dataKey]: 128 },
      metaValues: { [seedCfg.key]: seedMeta({ fetchedAt: NOW - 2881 * ONE_MIN_MS, recordCount: 1 }) },
    }));
    assert.equal(stale.status, 'STALE_SEED', name);
    assert.equal(stale.maxStaleMin, 2880, name);
    assert.equal(STATUS_COUNTS[stale.status], 'warn', name);

    const fresh = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({
      strens: { [dataKey]: 128 },
      metaValues: { [seedCfg.key]: seedMeta({ recordCount: 1 }) },
    }));
    assert.equal(fresh.status, 'OK', name);
  }
});

test('the surviving bundle tick heartbeat stays registered (#6691)', () => {
  for (const [name, label, bundlePath, issue] of BUNDLE_TICKS) {
    assert.equal(STANDALONE_KEYS[name], bundleHeartbeatKey(label));
    assert.equal(SEED_META[name].key, bundleHeartbeatKey(label));
    assert.equal(SEED_META[name].maxStaleMin, 2880, `${name} must use the 48h = 2× daily budget`);
    assert.equal(ON_DEMAND_KEYS.has(name), false, `${name} is a seeded watchdog, not on-demand`);
    assert.equal(SEED_META[name].cutover?.mode, 'expiring-ack');
    assert.equal(SEED_META[name].cutover?.fromKey, null);
    assert.equal(SEED_META[name].cutover?.status, 'EMPTY');
    assert.equal(SEED_META[name].cutover?.issue, issue);
    assert.ok(
      BUNDLE_HEARTBEAT_TTL_SECONDS > SEED_META[name].maxStaleMin * 60,
      `${name}: TTL must outlive maxStaleMin so a late tick is STALE_SEED, not EMPTY`,
    );
    const bundle = readFileSync(new URL(`../${bundlePath}`, import.meta.url), 'utf8');
    assert.match(bundle, new RegExp(`runBundle\\(\\s*'${label}'\\s*,`));
  }
});

test('classifyKey: digestNotifications heartbeat goes stale when the cron stops', () => {
  const entry = classifyKey('digestNotifications', STANDALONE_KEYS.digestNotifications, { allowOnDemand: true },
    makeCtx({
      strens: { [STANDALONE_KEYS.digestNotifications]: 256 },
      metaValues: {
        'seed-meta:digest:last-run': seedMeta({
          fetchedAt: NOW - 120 * ONE_MIN_MS,
          sentCount: 0,
        }),
      },
    }));

  assert.equal(STANDALONE_KEYS.digestNotifications, 'digest:last-run');
  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(entry.maxStaleMin, 90);
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

test('classifyKey: expired transitional producers fail closed when missing or empty', () => {
  const graduatedNames = [
    'fxYoy',
    'climateNewsRelayHeartbeat',
    'eiaPetroleum',
    'digestNotifications',
  ];

  for (const name of graduatedNames) {
    const dataKey = BOOTSTRAP_KEYS[name] ?? STANDALONE_KEYS[name];
    const seedCfg = SEED_META[name];
    assert.ok(dataKey, `${name}: data key remains registered`);
    assert.ok(seedCfg, `${name}: freshness metadata remains registered`);
    assert.equal(ON_DEMAND_KEYS.has(name), false, `${name}: expired softening must be retired`);

    const missing = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({}));
    assert.equal(missing.status, 'EMPTY', `${name}: a vanished producer output is critical`);
    assert.equal(STATUS_COUNTS[missing.status], 'crit');

    const empty = classifyKey(name, dataKey, { allowOnDemand: true }, makeCtx({
      strens: { [dataKey]: 128 },
      metaValues: { [seedCfg.key]: seedMeta({ recordCount: 0 }) },
    }));
    assert.equal(empty.status, 'EMPTY_DATA', `${name}: zero records are critical`);
    assert.equal(STATUS_COUNTS[empty.status], 'crit');
  }
});

// ── CF Radar outages: sparse zeroIsValid feed (seed-internet-outages) ───────

test('classifyKey: outages present key + 0 records while fresh → OK (sparse feed, not EMPTY_DATA)', () => {
  // CF Radar curated outage annotations are sparse; most 28d windows publish an
  // empty {outages:[]} envelope (hasData=true) with recordCount=0. With
  // zeroIsValid the seeder refreshes seed-meta fresh, so this must classify OK,
  // not EMPTY_DATA (crit) and not STALE_SEED.
  const entry = classifyKey('outages', BOOTSTRAP_KEYS.outages, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.outages]: 149 }, // empty {outages:[]} envelope
      metaValues: { 'seed-meta:infra:outages': seedMeta({ recordCount: 0 }) },
    }));
  assert.equal(entry.status, 'OK');
  assert.equal(STATUS_COUNTS[entry.status], 'ok');
});

test('classifyKey: missing outages payload is still EMPTY even with fresh 0-record meta', () => {
  // The zero-record exemption is NARROW: it only applies once Redis proves the
  // payload exists. A missing canonical key means publish died and must alarm
  // EMPTY (crit), not be hidden by the sparse-feed allowance.
  const entry = classifyKey('outages', BOOTSTRAP_KEYS.outages, { allowOnDemand: false },
    makeCtx({
      metaValues: { 'seed-meta:infra:outages': seedMeta({ recordCount: 0 }) },
    }));
  assert.equal(entry.status, 'EMPTY');
  assert.equal(STATUS_COUNTS[entry.status], 'crit');
});

test('classifyKey: outages present + 0 records that goes STALE still warns (cron stopped)', () => {
  // The exemption must NOT mask a genuine cron outage: once seed-meta age
  // exceeds maxStaleMin (30), 0 records degrades to STALE_SEED (warn), not OK.
  const entry = classifyKey('outages', BOOTSTRAP_KEYS.outages, { allowOnDemand: false },
    makeCtx({
      strens: { [BOOTSTRAP_KEYS.outages]: 149 },
      metaValues: { 'seed-meta:infra:outages': seedMeta({ recordCount: 0, fetchedAt: NOW - 200 * ONE_MIN_MS }) },
    }));
  assert.equal(entry.status, 'STALE_SEED');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
});

// ── cascade coverage (proactive, via isCascadeCovered) ──────────────────────

// ── overall status thresholds ───────────────────────────────────────────────

test('overall: 0 crit / 0 warn → HEALTHY', () => {
  assert.equal(computeOverallStatus({ warn: 0, onDemandWarn: 0, containedWarn: 0, crit: 0 }, 150).overall, 'HEALTHY');
});

test('overall: containment allows the full 3% cohort approved by the health contract', () => {
  const counts = { warn: 1, onDemandWarn: 0, containedWarn: 1, crit: 0 };
  assert.equal(computeOverallStatus(counts, 34).overall, 'HEALTHY');
  assert.equal(computeOverallStatus(counts, 34).diagnosticOverall, 'WARNING');
  assert.equal(computeOverallStatus(counts, 33).overall, 'WARNING');
  assert.equal(computeOverallStatus({ ...counts, warn: 3, containedWarn: 3 }, 100).overall, 'HEALTHY');
  assert.equal(computeOverallStatus({ ...counts, warn: 8, containedWarn: 8 }, 292).overall, 'HEALTHY');
  assert.equal(computeOverallStatus({ ...counts, warn: 9, containedWarn: 9 }, 292).overall, 'WARNING');
  assert.equal(computeOverallStatus({ ...counts, warn: 3, containedWarn: 3 }, 292).overall, 'HEALTHY',
    'the current disease, electricity, and PortWatch cohort is below 3%');
});

test('overall: any uncontained warning remains WARNING and on-demand misses stay excused', () => {
  assert.equal(computeOverallStatus({ warn: 2, onDemandWarn: 0, containedWarn: 1, crit: 0 }, 150).overall, 'WARNING');
  assert.equal(computeOverallStatus({ warn: 40, onDemandWarn: 0, containedWarn: 0, crit: 0 }, 150).overall, 'WARNING');
  assert.equal(computeOverallStatus({ warn: 2, onDemandWarn: 1, containedWarn: 1, crit: 0 }, 150).overall, 'HEALTHY');
});

test('overall: crit within ~3% of total → DEGRADED', () => {
  assert.equal(computeOverallStatus({ warn: 0, onDemandWarn: 0, containedWarn: 0, crit: 3 }, 100).overall, 'DEGRADED');
  assert.equal(computeOverallStatus({ warn: 5, onDemandWarn: 0, containedWarn: 5, crit: 1 }, 150).overall, 'DEGRADED');
});

test('overall: crit above ~3% of total → UNHEALTHY', () => {
  assert.equal(computeOverallStatus({ warn: 0, onDemandWarn: 0, containedWarn: 0, crit: 4 }, 100).overall, 'UNHEALTHY');
  assert.equal(computeOverallStatus({ warn: 2, onDemandWarn: 0, containedWarn: 2, crit: 20 }, 150).overall, 'UNHEALTHY');
});

function classifyContainment(name, meta, now = NOW) {
  const key = BOOTSTRAP_KEYS[name] ?? STANDALONE_KEYS[name];
  const ctx = { ...makeCtx({
    strens: { [key]: 2048 },
    metaValues: { [SEED_META[name].key]: seedMeta(meta) },
  }), now };
  const entry = classifyKey(name, key, { allowOnDemand: false }, ctx);
  return { entry, evidence: ctx.containmentEvidenceByName.get(name), ctx };
}

test('containment evaluates real classifier results with request-local proof', () => {
  for (const [expected, meta, contained] of [
    ['SEED_ERROR', { sourceState: 'degraded' }, true],
    ['STALE_SEED', { fetchedAt: NOW - (SEED_META.earthquakes.maxStaleMin + 1) * ONE_MIN_MS }, true],
    ['STALE_CONTENT', { newestItemAt: NOW - 180 * ONE_MIN_MS, maxContentAgeMin: 60 }, true],
  ]) {
    const { entry, evidence } = classifyContainment('earthquakes', meta);
    assert.equal(entry.status, expected);
    assert.equal(isContainedHealthWarning(entry, evidence, NOW), contained, expected);
    assert.equal(Object.getOwnPropertySymbols(entry).length, 0);
    assert.equal(JSON.stringify(entry).includes('usable'), false);
    assert.equal(isContainedHealthWarning(JSON.parse(JSON.stringify(entry)), undefined, NOW), false);
  }
  for (const status of Object.keys(STATUS_COUNTS).concat('UNKNOWN_FUTURE_STATUS')) {
    assert.equal(isContainedHealthWarning({ status, records: 5 }, undefined, NOW), false, status);
  }
  const { entry, evidence, ctx } = classifyContainment('earthquakes', { sourceState: 'degraded' });
  assert.equal(isContainedHealthWarning({ ...entry, status: 'COVERAGE_PARTIAL' }, evidence, NOW), false,
    'a final verdict change invalidates earlier evidence');
  assert.equal(isContainedHealthWarning(entry, makeCtx().containmentEvidenceByName.get('earthquakes'), NOW), false);
  entry.sourceFailurePendingUntil = new Date(NOW + ONE_MIN_MS).toISOString();
  assert.equal(isContainedHealthWarning(entry, evidence, NOW), false);
  ctx.keyErrors.set(BOOTSTRAP_KEYS.earthquakes, 'redis failure');
  classifyKey('earthquakes', BOOTSTRAP_KEYS.earthquakes, { allowOnDemand: false }, ctx);
  assert.equal(ctx.containmentEvidenceByName.has('earthquakes'), false,
    'an early failure clears proof if a name is evaluated again');
});

test('containment follows current served-data proof after freshness budgets expire', () => {
  for (const [kind, meta] of [
    ['seed', { fetchedAt: NOW - SEED_META.earthquakes.maxStaleMin * ONE_MIN_MS }],
    ['content', { newestItemAt: NOW - 60 * ONE_MIN_MS, maxContentAgeMin: 60 }],
  ]) {
    for (const offset of [-1, 0, 1]) {
      const now = NOW + offset;
      const { entry, evidence } = classifyContainment('earthquakes', { ...meta, sourceState: 'degraded' }, now);
      assert.equal(entry.status, 'SEED_ERROR');
      assert.equal(isContainedHealthWarning(entry, evidence, now), true, `${kind}: ${offset}`);
    }
  }
});

test('containment validates per-entity and served synthesis evidence without reclassifying age', () => {
  // Per-entity content-freshness containment is exercised against a fixture
  // registration in tests/health-content-freshness.test.mjs: no surviving
  // check declares that contract.
  for (const [name, meta] of [
    ['newsInsights', { consecutiveFailures: 2, lastAttemptAt: NOW - ONE_MIN_MS,
      lastSuccessAt: NOW - ONE_MIN_MS,
      servedGeneratedAt: new Date(NOW - SEED_META.newsInsights.maxStaleMin * ONE_MIN_MS).toISOString() }],
  ]) {
    for (const offset of [-1, 0, 1]) {
      const { entry, evidence } = classifyContainment(name, meta, NOW + offset);
      assert.equal(isContainedHealthWarning(entry, evidence, NOW + offset), true, `${name}: ${offset}`);
    }
  }
  for (const meta of [{ fetchedAt: NOW + 1 }, { newestItemAt: NOW + 1, maxContentAgeMin: 60 }]) {
    const { entry, evidence } = classifyContainment('earthquakes', { ...meta, sourceState: 'degraded' });
    assert.equal(isContainedHealthWarning(entry, evidence, NOW), false, 'future timestamps cannot prove freshness');
  }
});

test('containment has no source-specific denylist', () => {
  for (const name of ['wildfires', 'naturalEvents', 'radiationWatch',
    'diseaseOutbreaks', 'climateDisasters']) {
    const { entry, evidence } = classifyContainment(name, {
      sourceState: 'degraded', recordCount: 1000,
    });
    assert.equal(entry.status, 'SEED_ERROR', name);
    assert.equal(entry.records, 1000, name);
    assert.equal(isContainedHealthWarning(entry, evidence, NOW), true, name);
  }
});

test('containment rejects missing proof even when an earlier diagnostic wins', () => {
  const cases = [
    ['earthquakes', { fetchedAt: undefined }, 'STALE_SEED'],
    ['earthquakes', { status: 'error' }, 'SEED_ERROR'],
    ['earthquakes', { fetchedAt: 'invalid' }, 'STALE_SEED'],
    ['wildfires', { status: 'error' }, 'SEED_ERROR'],
  ];
  for (const [name, meta, expected] of cases) {
    const { entry, evidence } = classifyContainment(name, meta);
    assert.equal(entry.status, expected, name);
    assert.equal(isContainedHealthWarning(entry, evidence, NOW), false, name);
    assert.equal(computeOverallStatus({ warn: 1, onDemandWarn: 0,
      containedWarn: Number(isContainedHealthWarning(entry, evidence, NOW)), crit: 0 }, 292).overall, 'WARNING');
  }
});

test('overall rejects invalid containment counts', () => {
  for (const containedWarn of [undefined, null, -1, 0.5, 2, NaN, Infinity, '1']) {
    assert.equal(computeOverallStatus({ warn: 1, onDemandWarn: 0, containedWarn, crit: 0 }, 100).overall, 'WARNING');
  }
});

test('containment fails closed for invalid or synthetic record counts', () => {
  const { entry, evidence } = classifyContainment('earthquakes', { sourceState: 'degraded', recordCount: 5 });
  assert.equal(isContainedHealthWarning(entry, evidence, NOW), true);
  for (const records of [0, null, undefined, -1, Infinity, NaN, '5', 6]) {
    assert.equal(isContainedHealthWarning({ ...entry, records }, evidence, NOW), false, String(records));
  }
  const { entry: synthetic, evidence: syntheticEvidence } = classifyContainment('earthquakes',
    { recordCount: undefined, sourceState: 'degraded' });
  assert.equal(synthetic.records, 1, 'documents the legacy payload-presence fallback');
  assert.equal(isContainedHealthWarning(synthetic, syntheticEvidence, NOW), false);
});

// ── fully unobserved on-demand adapters are dormant (imdCycloneMarine) ──────
// imdCycloneMarine sits in BOTH ON_DEMAND_KEYS and EMPTY_DATA_OK_KEYS. The
// EMPTY_DATA_OK arm is tested first and resolves to
// `seedStale === true ? 'STALE_SEED' : 'OK'`; readSeedMeta initialises
// seedStale=true and only overwrites it from a real fetchedAt. The narrow
// pre-activation grace applies only when data and readable metadata are both
// absent; marker absence alone can result from a failed marker write or a
// restore and cannot override publication evidence.

const IMD_MARKER_ABSENT = { imdCycloneMarine: false };

test('classifyKey: an unobserved on-demand adapter reads EMPTY_ON_DEMAND, not STALE_SEED', () => {
  const entry = classifyKey(
    'imdCycloneMarine',
    STANDALONE_KEYS.imdCycloneMarine,
    { allowOnDemand: true },
    makeCtx({ activationStates: IMD_MARKER_ABSENT }), // no data key, no seed-meta
  );
  assert.equal(entry.status, 'EMPTY_ON_DEMAND');
  assert.equal(STATUS_COUNTS[entry.status], 'warn');
  assert.ok(isOnDemandProblem({ status: entry.status, onDemand: true }),
    'the freshness monitor must excuse it — that is the point of the change');
});

test('classifyKey: marker absence does not excuse an absent payload with stale seed metadata', () => {
  const entry = classifyKey(
    'imdCycloneMarine',
    STANDALONE_KEYS.imdCycloneMarine,
    { allowOnDemand: true },
    makeCtx({
      metaValues: {
        [SEED_META.imdCycloneMarine.key]: seedMeta({ fetchedAt: NOW - 46 * ONE_MIN_MS, recordCount: 0 }),
      },
      activationStates: IMD_MARKER_ABSENT,
    }),
  );
  assert.equal(entry.status, 'STALE_SEED');
  assert.ok(!isOnDemandProblem({ status: entry.status, onDemand: true }));
});

test('classifyKey: marker absence preserves normal fresh and stale zero-record outcomes', () => {
  const classifyZeroRecord = (fetchedAt) => classifyKey(
    'imdCycloneMarine',
    STANDALONE_KEYS.imdCycloneMarine,
    { allowOnDemand: true },
    makeCtx({
      strens: { [STANDALONE_KEYS.imdCycloneMarine]: 64 },
      metaValues: { [SEED_META.imdCycloneMarine.key]: seedMeta({ fetchedAt, recordCount: 0 }) },
      activationStates: IMD_MARKER_ABSENT,
    }),
  );

  assert.equal(classifyZeroRecord(NOW - ONE_MIN_MS).status, 'OK');
  assert.equal(classifyZeroRecord(NOW - 46 * ONE_MIN_MS).status, 'STALE_SEED');
});

test('classifyKey: once ACTIVATED, the same adapter is strict again', () => {
  // The regression this guards: softening a key that HAS published and then
  // died would hide a real outage behind a dormancy excuse.
  const entry = classifyKey(
    'imdCycloneMarine',
    STANDALONE_KEYS.imdCycloneMarine,
    { allowOnDemand: true },
    makeCtx({ activationStates: { imdCycloneMarine: true } }),
  );
  assert.equal(entry.status, 'STALE_SEED', 'an activated adapter that goes absent is stale, as before');
  assert.ok(
    !isOnDemandProblem({ status: entry.status, onDemand: true }),
    'and the freshness monitor must NOT excuse it — that is the outage this change must not hide',
  );
});

test('classifyKey: an UNREADABLE activation marker earns nothing (fails closed)', () => {
  // readExistsFlags leaves unknown entries OUT of the map, so `get()` is
  // undefined — never false. Grace requires positive proof (#6095).
  const entry = classifyKey(
    'imdCycloneMarine',
    STANDALONE_KEYS.imdCycloneMarine,
    { allowOnDemand: true },
    makeCtx({ activationStates: {} }),
  );
  assert.equal(entry.status, 'STALE_SEED', 'unknown activation state keeps the pre-fix verdict');
});

test('classifyKey: a key with no activation marker is untouched by the change', () => {
  // weatherAlerts is in EMPTY_DATA_OK_KEYS too, but configures no marker — so
  // it is permanently `unknown` and MUST keep EMPTY_DATA_OK_KEYS' behaviour. This is
  // what stops the reorder from silencing producers that run and then stop.
  const entry = classifyKey(
    'weatherAlerts',
    BOOTSTRAP_KEYS.weatherAlerts,
    { allowOnDemand: true },
    makeCtx({ activationStates: IMD_MARKER_ABSENT }),
  );
  assert.equal(entry.status, 'STALE_SEED');
});

