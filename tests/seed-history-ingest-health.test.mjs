/**
 * Issue #5736 — history ingestion needs a durable health signal.
 *
 * `appendSeedHistory` is fail-open by contract: the canonical publish has
 * already committed when the hook runs, so every history failure logs a warning
 * and returns. Before this, nothing outside the log stream could tell that
 * history had stopped accumulating — a missing RELAY_SHARED_SECRET or a
 * systematically rejecting relay produced a healthy-looking seed run forever.
 *
 * These tests pin the halves of the fix that survive:
 *   1. the pure state machine (`describeHistoryAppendOutcome` +
 *      `projectHistoryIngestHealth`) — states, error codes, and which fields
 *      freeze while the relay is down;
 *   2. `recordHistoryIngestHealth` — what it writes, and that it stays
 *      fail-open and read-consistent when Upstash misbehaves;
 *   3. (retired) the end-to-end /api/health and /api/seed-health registration
 *      of the ACLED, cross-strait and energy-intelligence collectors. Those
 *      collectors left both health surfaces with the trim, so no surviving
 *      registration exists to pin.
 *
 * Run: ./node_modules/.bin/tsx --test tests/seed-history-ingest-health.test.mjs
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

const originalFetch = globalThis.fetch;
const originalEnv = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  WORLDMONITOR_VALID_KEYS: process.env.WORLDMONITOR_VALID_KEYS,
};

process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
process.env.WORLDMONITOR_VALID_KEYS = 'test-key';

const {
  appendSeedHistory,
  makeSeedHistoryAfterPublish,
  HISTORY_INGEST_ALARM_AFTER_FAILURES,
  HISTORY_INGEST_RUN_RECEIPT_TTL_SECONDS,
  HISTORY_INGEST_SOURCE_VERSION,
  HISTORY_INGEST_TTL_SECONDS,
  describeHistoryAppendOutcome,
  historyIngestActivationKey,
  historyIngestErrorCode,
  historyIngestHealthKey,
  historyIngestMetaKey,
  historyIngestRunReceiptKey,
  projectHistoryIngestHealth,
  recordHistoryIngestHealth,
} = await import('../scripts/_seed-history.mjs');


after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

const DOMAIN = 'conflict';
const RESOURCE = 'acled-intel';
const AT = Date.UTC(2026, 6, 28, 12, 0, 0);
const MINUTE = 60_000;

/** One successful relay append. */
const SUCCESS = {
  inserted: 7,
  skipped: 3,
  retracted: 0,
  chunks: 1,
  abandoned: 0,
  failedChunks: 0,
  inputRecords: 10,
  normalizedRecords: 10,
  droppedRecords: 0,
};

function project(previous, { result = null, error = null, at = AT, runId = 'run-1' } = {}) {
  return projectHistoryIngestHealth(previous, {
    domain: DOMAIN,
    resource: RESOURCE,
    runId,
    at,
    outcome: describeHistoryAppendOutcome(result, error),
  });
}

function relayRejection(status = 401) {
  const err = new Error(`intel-history relay returned HTTP ${status}: unauthorized`);
  err.name = 'SeedHistoryError';
  err.status = status;
  return err;
}

// ── The pure state machine ────────────────────────────────────────────────────

describe('projectHistoryIngestHealth', () => {
  it('records a successful append as healthy and advances fetchedAt', () => {
    const { record, meta } = project(null, { result: SUCCESS });

    assert.equal(record.state, 'healthy');
    assert.equal(record.consecutiveFailures, 0);
    assert.equal(record.lastSuccessAt, AT);
    assert.equal(record.lastHealthyAt, AT);
    assert.equal(record.lastInserted, 7);
    assert.equal(record.lastDeduped, 3);
    assert.equal(record.lastInputRecords, 10);
    assert.equal(record.lastNormalizedRecords, 10);
    assert.equal(record.lastDroppedRecords, 0);
    assert.equal(record.lastErrorCode, null);

    assert.equal(meta.fetchedAt, AT);
    assert.equal(meta.recordCount, 10, 'relay-accepted volume is inserted + deduped');
    assert.equal(meta.sourceState, 'ok');
    assert.equal(meta.sourceVersion, HISTORY_INGEST_SOURCE_VERSION);
  });

  it('reports an unconfigured relay as a distinct, non-alarming state', () => {
    const { record, meta } = project(null, {
      result: { skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET', 'OPENROUTER_API_KEY'] },
    });

    assert.equal(record.state, 'unconfigured');
    assert.deepEqual(record.missingConfig, ['RELAY_SHARED_SECRET', 'OPENROUTER_API_KEY']);
    assert.equal(record.lastSuccessAt, null, 'nothing was ever appended');
    // fetchedAt advances so an un-provisioned deployment reads as
    // NOT_CONFIGURED forever instead of decaying into an unclearable stale warn.
    assert.equal(meta.fetchedAt, AT);
    assert.equal(meta.sourceState, 'unavailable');
    assert.equal(meta.consecutiveFailures, 0);
  });

  it('freezes fetchedAt from the first failure and escalates at the alarm threshold', () => {
    const healthy = project(null, { result: SUCCESS }).record;

    const first = project(healthy, { result: null, error: relayRejection(401), at: AT + MINUTE });
    assert.equal(first.record.state, 'failing');
    assert.equal(first.record.consecutiveFailures, 1);
    assert.equal(first.record.lastAttemptAt, AT + MINUTE);
    assert.equal(first.meta.fetchedAt, AT, 'the last HEALTHY append, not the last attempt');
    assert.equal(
      first.meta.sourceState,
      'ok',
      'one failed tick is not yet the prolonged failure worth alarming on',
    );

    const second = project(first.record, {
      result: null,
      error: relayRejection(401),
      at: AT + 2 * MINUTE,
    });
    assert.equal(second.record.consecutiveFailures, 2);
    assert.equal(second.meta.fetchedAt, AT);
    assert.equal(second.meta.sourceState, 'degraded');
    assert.equal(second.meta.lastErrorCode, 'http_401');
    assert.equal(second.record.lastErrorReason, 'intel-history relay returned HTTP 401: unauthorized');

    assert.equal(
      HISTORY_INGEST_ALARM_AFTER_FAILURES,
      2,
      'the escalation point is a pinned contract, not an implementation detail',
    );
  });

  it('holds the last known good volume while the relay is down', () => {
    const healthy = project(null, { result: SUCCESS }).record;
    const failing = project(healthy, { error: relayRejection(500), at: AT + MINUTE });

    assert.equal(
      failing.meta.recordCount,
      10,
      'a down relay must not be reported as a contradictory zero-record run',
    );
    assert.equal(failing.record.lastSuccessAt, AT);
  });

  it('has no healthy timestamp when the very first append fails', () => {
    const { record, meta } = project(null, { error: relayRejection(403) });

    assert.equal(record.lastHealthyAt, null);
    assert.equal(record.lastSuccessAt, null);
    assert.equal(meta.fetchedAt, null, 'never-ingested + failing must classify as stale');
    assert.equal(meta.recordCount, 0);
  });

  it('clears the failure count on recovery but keeps the last error for post-mortem', () => {
    let state = project(null, { error: relayRejection(401) }).record;
    state = project(state, { error: relayRejection(401), at: AT + MINUTE }).record;
    const recovered = project(state, { result: SUCCESS, at: AT + 2 * MINUTE });

    assert.equal(recovered.record.state, 'healthy');
    assert.equal(recovered.record.consecutiveFailures, 0);
    assert.equal(recovered.meta.sourceState, 'ok');
    assert.equal(recovered.meta.fetchedAt, AT + 2 * MINUTE);
    assert.equal(recovered.record.lastErrorCode, 'http_401');
    assert.equal(recovered.record.lastErrorAt, AT + MINUTE);
  });

  it('ignores a corrupt or non-object previous record instead of throwing', () => {
    for (const previous of [null, undefined, 'garbage', 42, []]) {
      const { record } = project(previous, { error: relayRejection(500) });
      assert.equal(record.consecutiveFailures, 1);
    }
  });

  // ── Runs that reached nothing ──────────────────────────────────────────────
  //
  // appendSeedHistory RESOLVES rather than throws when its wall-clock budget
  // dies before a single chunk is POSTed; it only throws on
  // `chunks === 0 && failedChunks > 0`. Treating that as healthy would advance
  // fetchedAt on a run that delivered nothing.

  it('treats a run where no chunk reached the relay as failing, not healthy', () => {
    const healthy = project(null, { result: SUCCESS }).record;
    const budgetDied = {
      inserted: 0, skipped: 0, chunks: 0, abandoned: 12, failedChunks: 0,
    };

    const { record, meta } = project(healthy, { result: budgetDied, at: AT + MINUTE });

    assert.equal(record.state, 'failing');
    assert.equal(record.lastErrorCode, 'budget_exhausted');
    assert.equal(record.consecutiveFailures, 1);
    assert.equal(
      meta.fetchedAt,
      AT,
      'a run that delivered nothing must not advance the healthy clock',
    );
  });

  it('escalates a relay that eats the budget on every run', () => {
    const budgetDied = {
      inserted: 0, skipped: 0, chunks: 0, abandoned: 12, failedChunks: 0,
    };
    let state = project(null, { result: SUCCESS }).record;
    let projected;
    for (let tick = 1; tick <= 2; tick++) {
      projected = project(state, { result: budgetDied, at: AT + tick * MINUTE });
      state = projected.record;
    }
    assert.equal(projected.meta.sourceState, 'degraded');
  });

  it('keeps a run with no candidate records healthy', () => {
    // Nothing was offered, so nothing was lost — distinct from "offered and
    // dropped" above. appendSeedHistory returns this without touching the relay.
    const empty = { inserted: 0, skipped: 0, chunks: 0, abandoned: 0, failedChunks: 0 };
    const { record, meta } = project(null, { result: empty });

    assert.equal(record.state, 'healthy');
    assert.equal(meta.fetchedAt, AT);
    assert.equal(meta.sourceState, 'ok');
  });

  it('escalates a collector that loses chunks on every run', () => {
    const lossy = { inserted: 4, skipped: 0, chunks: 1, abandoned: 0, failedChunks: 2 };

    // Never a hard failure — every run reaches the relay and delivers
    // something, so the total-failure counter alone would sit at zero forever
    // while records are dropped on every tick.
    let state = project(null, { result: SUCCESS }).record;
    let projected;
    for (let tick = 1; tick <= 2; tick++) {
      projected = project(state, { result: lossy, at: AT + tick * MINUTE });
      state = projected.record;
    }

    assert.equal(projected.record.state, 'healthy');
    assert.equal(projected.record.lastFailedChunks, 2);
    assert.equal(
      projected.meta.fetchedAt,
      AT + 2 * MINUTE,
      'the relay is reachable, so this is not staleness',
    );
    assert.equal(projected.meta.sourceState, 'degraded', 'but the loss must surface');
  });

  it('records pre-upload drops without changing the scheduled health policy', () => {
    const droppedBeforeUpload = {
      ...SUCCESS,
      inputRecords: 11,
      normalizedRecords: 10,
      droppedRecords: 1,
    };
    const first = project(null, { result: droppedBeforeUpload });
    const second = project(first.record, {
      result: droppedBeforeUpload,
      at: AT + MINUTE,
    });

    assert.equal(second.record.lastDroppedRecords, 1);
    assert.equal(second.record.consecutiveFailures, 0);
    assert.equal(second.meta.sourceState, 'ok');
  });

  it('lets a clean run clear a lossy streak', () => {
    const lossy = { inserted: 4, skipped: 0, chunks: 1, abandoned: 0, failedChunks: 2 };
    const dropped = project(project(null, { result: SUCCESS }).record, {
      result: lossy,
      at: AT + MINUTE,
    }).record;
    assert.equal(dropped.consecutiveFailures, 1);

    const clean = project(dropped, { result: SUCCESS, at: AT + 2 * MINUTE });
    assert.equal(clean.record.consecutiveFailures, 0);
    assert.equal(clean.meta.sourceState, 'ok');
  });

  // ── Credential removed after a success ────────────────────────────────────

  it('treats a credential removed after a success as a regression, not an opt-out', () => {
    const healthy = project(null, { result: SUCCESS }).record;
    const { record, meta } = project(healthy, {
      result: { skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET'] },
      at: AT + MINUTE,
    });

    assert.equal(record.state, 'unconfigured');
    assert.deepEqual(record.missingConfig, ['RELAY_SHARED_SECRET']);
    assert.equal(record.lastErrorCode, 'config_removed');
    assert.equal(record.consecutiveFailures, 1);
    assert.equal(
      meta.fetchedAt,
      AT,
      'the staleness clock must not reset when a working relay loses its credential',
    );
    assert.equal(
      meta.sourceState,
      'degraded',
      'no threshold: a variable is either configured or it is not',
    );
  });

  it('keeps a never-provisioned deployment silent', () => {
    // The distinguishing fact is lastSuccessAt: absent here, present above.
    let state = project(null, {
      result: { skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET'] },
    }).record;
    assert.equal(state.lastSuccessAt, null);

    for (let tick = 1; tick <= 5; tick++) {
      const next = project(state, {
        result: { skipped: 'unconfigured', missing: ['RELAY_SHARED_SECRET'] },
        at: AT + tick * MINUTE,
      });
      state = next.record;
      assert.equal(next.meta.sourceState, 'unavailable');
      assert.equal(next.meta.fetchedAt, AT + tick * MINUTE);
      assert.equal(next.record.consecutiveFailures, 0);
    }
  });
});

describe('historyIngestErrorCode', () => {
  it('prefers the transport facts an operator acts on', () => {
    assert.equal(historyIngestErrorCode(relayRejection(429)), 'http_429');

    const budget = new Error('intel-history relay budget exhausted');
    budget.budgetExhausted = true;
    budget.name = 'SeedHistoryError';
    assert.equal(historyIngestErrorCode(budget), 'budget_exhausted');
  });

  it('falls back to a stable code derived from the error class', () => {
    const embedder = new Error('embeddings provider returned HTTP 402');
    embedder.name = 'EmbeddingProviderError';
    assert.equal(historyIngestErrorCode(embedder), 'embedding_provider_error');
    assert.equal(historyIngestErrorCode(new Error('boom')), 'error');
    assert.equal(historyIngestErrorCode(null), null);
  });
});

// ── The Redis writer ──────────────────────────────────────────────────────────

/**
 * Upstash stub. `getResult` is the raw string the record GET returns (null =
 * key absent). Captures every pipeline body so key names and TTLs are testable.
 */
function stubUpstash({
  getResult = null,
  getStatus = 200,
  pipelineStatus = 200,
  pipelineBody,
  pipelineBodies,
} = {}) {
  const calls = { gets: [], pipelines: [] };
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/pipeline')) {
      const commands = JSON.parse(init.body);
      calls.pipelines.push(commands);
      return {
        ok: pipelineStatus >= 200 && pipelineStatus < 300,
        status: pipelineStatus,
        json: async () => pipelineBodies?.[calls.pipelines.length - 1]
          ?? pipelineBody
          ?? commands.map(() => ({ result: 'OK' })),
      };
    }
    calls.gets.push(String(url));
    return {
      ok: getStatus >= 200 && getStatus < 300,
      status: getStatus,
      json: async () => ({ result: getResult }),
    };
  };
  return { fetchImpl, calls };
}

async function withCapturedWarn(fn) {
  const warns = [];
  const original = console.warn;
  console.warn = (...args) => warns.push(args.map(String).join(' '));
  try {
    return { value: await fn(), warns };
  } finally {
    console.warn = original;
  }
}

const ENV = {
  UPSTASH_REDIS_REST_URL: 'https://redis.example.test',
  UPSTASH_REDIS_REST_TOKEN: 'token',
};

describe('recordHistoryIngestHealth', () => {
  it('writes the record, the seed-meta projection, and the activation marker', async () => {
    const { fetchImpl, calls } = stubUpstash();

    const record = await recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, runId: 'run-9', result: SUCCESS },
      { env: ENV, fetchImpl, now: () => AT },
    );

    assert.equal(record.state, 'healthy');
    assert.equal(calls.gets.length, 1);
    assert.match(calls.gets[0], /intel-history%3Aingest-health%3Aconflict%3Aacled-intel%3Av1$/);

    assert.equal(calls.pipelines.length, 1);
    assert.equal(calls.pipelines[0].length, 3, 'scheduled runs do not create run receipts');
    const [recordCmd, metaCmd, activationCmd] = calls.pipelines[0];

    assert.deepEqual(recordCmd.slice(0, 2), ['SET', historyIngestHealthKey(DOMAIN, RESOURCE)]);
    assert.deepEqual(recordCmd.slice(3), ['EX', HISTORY_INGEST_TTL_SECONDS]);
    assert.equal(JSON.parse(recordCmd[2]).lastRunId, 'run-9');

    assert.deepEqual(metaCmd.slice(0, 2), ['SET', historyIngestMetaKey(DOMAIN, RESOURCE)]);
    assert.deepEqual(metaCmd.slice(3), ['EX', HISTORY_INGEST_TTL_SECONDS]);
    const meta = JSON.parse(metaCmd[2]);
    assert.equal(meta.fetchedAt, AT);
    assert.equal(meta.sourceState, 'ok');
    assert.equal(
      typeof meta._seed,
      'undefined',
      'seed-meta must stay bare-shape — every reader parses it top-level',
    );

    assert.deepEqual(
      activationCmd,
      ['SET', historyIngestActivationKey(DOMAIN, RESOURCE), '1'],
      'the activation marker carries NO TTL: it must outlive the 7-day record',
    );
  });

  it('writes bounded run-scoped receipts for one-off recovery only', async () => {
    const receipts = [];
    for (const runId of ['run-9', 'run-10']) {
      const { fetchImpl, calls } = stubUpstash();
      await recordHistoryIngestHealth(
        { domain: DOMAIN, resource: RESOURCE, runId, result: SUCCESS },
        { env: { ...ENV, WM_ONE_OFF_HISTORY_RECEIPT: '1' }, fetchImpl, now: () => AT },
      );
      assert.equal(calls.pipelines.length, 2);
      assert.equal(calls.pipelines[0].length, 3, 'shared health must land before the receipt');
      assert.equal(calls.pipelines[1].length, 1, 'the receipt uses a separate confirmed write');
      receipts.push(calls.pipelines[1][0]);
    }

    assert.notEqual(receipts[0][1], receipts[1][1]);
    assert.deepEqual(receipts[0].slice(0, 2), [
      'SET',
      historyIngestRunReceiptKey(DOMAIN, RESOURCE, 'run-9'),
    ]);
    assert.equal(JSON.parse(receipts[0][2]).lastRunId, 'run-9');
    assert.deepEqual(receipts[0].slice(3), ['EX', HISTORY_INGEST_RUN_RECEIPT_TTL_SECONDS]);
  });

  it('does not write a one-off receipt when the shared pipeline partially fails', async () => {
    const { fetchImpl, calls } = stubUpstash({
      pipelineBodies: [[
        { error: 'ERR record rejected' },
        { result: 'OK' },
        { result: 'OK' },
      ]],
    });

    const { value, warns } = await withCapturedWarn(() => recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, runId: 'run-partial', result: SUCCESS },
      { env: { ...ENV, WM_ONE_OFF_HISTORY_RECEIPT: '1' }, fetchImpl, now: () => AT },
    ));

    assert.equal(value, null);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /pipeline command failed/);
    assert.equal(calls.pipelines.length, 1, 'a failed shared write must stop before the receipt request');
    assert.equal(
      calls.pipelines.flat().some((command) => command[1] === historyIngestRunReceiptKey(
        DOMAIN,
        RESOURCE,
        'run-partial',
      )),
      false,
    );
  });

  it('does not write a one-off receipt for malformed or incomplete shared results', async () => {
    for (const pipelineBody of [
      [],
      {},
      [{ result: 'OK' }],
      [null, { result: 'OK' }, { result: 'OK' }],
      [{ result: 'OK' }, {}, { result: 'OK' }],
      [{ result: 'OK' }, { result: 'OK' }, { result: null }],
      [{ result: 'QUEUED' }, { result: 'OK' }, { result: 'OK' }],
    ]) {
      const { fetchImpl, calls } = stubUpstash({ pipelineBody });

      const { value, warns } = await withCapturedWarn(() => recordHistoryIngestHealth(
        { domain: DOMAIN, resource: RESOURCE, runId: 'run-malformed', result: SUCCESS },
        { env: { ...ENV, WM_ONE_OFF_HISTORY_RECEIPT: '1' }, fetchImpl, now: () => AT },
      ));

      assert.equal(value, null);
      assert.equal(warns.length, 1);
      assert.equal(calls.pipelines.length, 1, 'unconfirmed shared writes must stop before the receipt');
      assert.equal(calls.pipelines[0].length, 3);
    }
  });

  it('continues the failure streak from the persisted record', async () => {
    const previous = project(project(null, { result: SUCCESS }).record, {
      error: relayRejection(401),
      at: AT,
    }).record;
    const { fetchImpl, calls } = stubUpstash({ getResult: JSON.stringify(previous) });

    const { value: record } = await withCapturedWarn(() => recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, result: null, error: relayRejection(401) },
      { env: ENV, fetchImpl, now: () => AT + MINUTE },
    ));

    assert.equal(record.consecutiveFailures, 2);
    assert.equal(JSON.parse(calls.pipelines[0][1][2]).sourceState, 'degraded');
  });

  it('skips the write entirely when the previous record cannot be read', async () => {
    const { fetchImpl, calls } = stubUpstash({ getStatus: 500 });

    const { value, warns } = await withCapturedWarn(() => recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, result: SUCCESS },
      { env: ENV, fetchImpl, now: () => AT },
    ));

    assert.equal(value, null);
    assert.deepEqual(
      calls.pipelines,
      [],
      'rebuilding from a lost previous would reset the failure count and drop lastSuccessAt',
    );
    assert.equal(warns.length, 1);
    assert.match(warns[0], /ingest-health write failed \(non-fatal\)/);
  });

  it('treats a corrupt stored record as absent rather than failing the write', async () => {
    const { fetchImpl, calls } = stubUpstash({ getResult: '{not json' });

    const record = await recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, result: SUCCESS },
      { env: ENV, fetchImpl, now: () => AT },
    );

    assert.equal(record.state, 'healthy');
    assert.equal(calls.pipelines.length, 1);
  });

  it('never throws when the pipeline write fails', async () => {
    for (const options of [{ pipelineStatus: 503 }, { pipelineBody: [{ result: 'OK' }, { error: 'ERR wrongtype' }] }]) {
      const { fetchImpl } = stubUpstash(options);
      const { value, warns } = await withCapturedWarn(() => recordHistoryIngestHealth(
        { domain: DOMAIN, resource: RESOURCE, result: SUCCESS },
        { env: ENV, fetchImpl, now: () => AT },
      ));
      assert.equal(value, null);
      assert.equal(warns.length, 1);
    }
  });

  it('a meta write that never lands cannot hide a stalled ingest', async () => {
    // The 3-command pipeline is not transactional, so a per-command failure can
    // land the record while the meta write is skipped. The meta then keeps its
    // PREVIOUS value — and on this path that value can only be an earlier
    // healthy observation, never a newer one. Prove the staleness backstop is
    // therefore untouched: the retained meta ages exactly as it would have.
    const healthy = project(null, { result: SUCCESS });
    const { fetchImpl, calls } = stubUpstash({
      getResult: JSON.stringify(healthy.record),
      pipelineBody: [{ result: 'OK' }, { error: 'ERR backend unavailable' }, { result: 'OK' }],
    });

    const { value, warns } = await withCapturedWarn(() => recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, result: null, error: relayRejection(500) },
      { env: ENV, fetchImpl, now: () => AT + MINUTE },
    ));

    assert.equal(value, null, 'the caller learns the write did not fully land');
    assert.equal(warns.length, 1);

    // The retained meta is the last healthy observation, so whichever health
    // surface reads it still ages it out on the ordinary budget.
    const retained = healthy.meta;
    assert.equal(retained.fetchedAt, AT);
    assert.equal(calls.pipelines.length, 1);
  });

  it('no-ops without Upstash credentials instead of exiting the seeder', async () => {
    const { fetchImpl, calls } = stubUpstash();
    const { value, warns } = await withCapturedWarn(() => recordHistoryIngestHealth(
      { domain: DOMAIN, resource: RESOURCE, result: SUCCESS },
      { env: {}, fetchImpl, now: () => AT },
    ));

    assert.equal(value, null);
    assert.deepEqual(calls.gets, []);
    assert.equal(warns.length, 1);
    assert.match(warns[0], /no Upstash credentials/);
  });
});

describe('makeSeedHistoryAfterPublish', () => {
  it('records a projection failure as an ingest failure without appending', async () => {
    // buildRecords runs inside the same try as append, so a payload the
    // projection cannot handle throws before the relay is ever contacted. That
    // is still an ingest failure and must reach the health record rather than
    // vanishing into a log line.
    const observations = [];
    let appendCalls = 0;
    const hook = makeSeedHistoryAfterPublish({
      domain: DOMAIN,
      resource: RESOURCE,
      buildRecords: () => {
        throw new TypeError('cannot read properties of undefined');
      },
    });

    const { warns } = await withCapturedWarn(() => hook({}, { runId: 'run-7' }, {
      append: async () => {
        appendCalls++;
        return SUCCESS;
      },
      recordHealth: async (observation) => {
        observations.push(observation);
        return null;
      },
    }));

    assert.equal(appendCalls, 0, 'nothing can be appended when the projection failed');
    assert.equal(observations.length, 1);
    assert.equal(observations[0].result, null);
    assert.equal(observations[0].error.name, 'TypeError');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /append failed \(non-fatal\)/);

    // ...and it lands as a failing outcome, not a silent healthy one.
    const { record, meta } = projectHistoryIngestHealth(null, {
      domain: DOMAIN,
      resource: RESOURCE,
      runId: 'run-7',
      at: AT,
      outcome: describeHistoryAppendOutcome(observations[0].result, observations[0].error),
    });
    assert.equal(record.state, 'failing');
    assert.equal(record.lastErrorCode, 'type_error');
    assert.equal(meta.fetchedAt, null);
  });
});

// ── Real producer -> real projection ─────────────────────────────────────────
//
// Everything above pins the projection against a hand-written result literal.
// That leaves one seam unguarded: if `appendSeedHistory`'s own return contract
// drifts — a renamed counter, a path that starts resolving where it used to
// throw — the projection keeps reading a shape the producer no longer emits and
// the alarm goes quiet with every test still green. These drive the REAL
// producer, with only the network stubbed, into the REAL reducer.

describe('appendSeedHistory outcomes reach the projection intact', () => {
  const RELAY_ENV = {
    CONVEX_SITE_URL: 'https://example.convex.site',
    RELAY_SHARED_SECRET: 'test-secret',
    OPENROUTER_API_KEY: 'sk-test',
  };

  const candidates = Array.from({ length: 3 }, (_, i) => ({
    dedupeKey: `conflict:acled-intel:evt-${i}`,
    title: `Event ${i}`,
    occurredAt: AT + i * 1000,
  }));

  const stubEmbed = async (texts) => texts.map(() => new Array(512).fill(0.1));

  async function runProducerThenProject(deps) {
    let result = null;
    let error = null;
    try {
      result = await appendSeedHistory(
        { domain: DOMAIN, resource: RESOURCE, runId: 'run-1', records: candidates },
        { env: RELAY_ENV, embed: stubEmbed, ...deps },
      );
    } catch (err) {
      error = err;
    }
    return projectHistoryIngestHealth(null, {
      domain: DOMAIN,
      resource: RESOURCE,
      runId: 'run-1',
      at: AT,
      outcome: describeHistoryAppendOutcome(result, error),
    });
  }

  it('a relay rejecting every chunk lands as failing with the HTTP code', async () => {
    const { record, meta } = await withCapturedWarn(() => runProducerThenProject({
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
        json: async () => ({}),
      }),
      sleep: async () => {},
    })).then((r) => r.value);

    assert.equal(record.state, 'failing');
    assert.equal(record.lastErrorCode, 'http_401');
    assert.equal(meta.fetchedAt, null);
    assert.equal(meta.sourceState, 'ok', 'one failed run is below the alarm threshold');
  });

  it('a budget that dies before the first POST lands as failing, not healthy', async () => {
    // The producer RESOLVES here rather than throwing — the exact shape that
    // used to be folded into `healthy` and kept the alarm green forever.
    let calls = 0;
    const { value: projected, warns } = await withCapturedWarn(() => runProducerThenProject({
      // Clock jumps past the deadline during embedding, so the chunk loop never
      // sends anything and the run is reported as fully abandoned.
      now: () => (calls++ === 0 ? AT : AT + 10 * MINUTE),
      budgetMs: 1_000,
      fetchImpl: async () => {
        throw new Error('the relay must never be contacted in this scenario');
      },
    }));

    assert.equal(projected.record.state, 'failing');
    assert.equal(projected.record.lastErrorCode, 'budget_exhausted');
    assert.equal(projected.meta.fetchedAt, null, 'nothing was delivered');
    assert.match(warns.join(' '), /budget exhausted/);
  });

  it('a fully accepted run lands as healthy with the relay-accepted volume', async () => {
    const { record, meta } = await runProducerThenProject({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ inserted: 2, skipped: 1 }),
      }),
    });

    assert.equal(record.state, 'healthy');
    assert.equal(meta.fetchedAt, AT);
    assert.equal(meta.recordCount, 3, 'inserted + deduped, straight from the relay');
    assert.equal(meta.sourceState, 'ok');
  });

  it('carries every counter the relay reports into the record', () => {
    // The producer's return shape and this reducer are edited by different
    // changes at different times (`retracted` arrived with #5743 while this
    // record was in review). Pin that a counter the producer emits reaches the
    // durable record, so the next addition cannot land silently half-wired.
    const producerShape = {
      inserted: 2, skipped: 1, retracted: 4, chunks: 1, abandoned: 0, failedChunks: 0,
    };
    const { record, meta } = project(null, { result: producerShape });

    assert.equal(record.lastInserted, 2);
    assert.equal(record.lastDeduped, 1);
    assert.equal(record.lastRetracted, 4);
    assert.equal(record.lastChunks, 1);
    assert.equal(
      meta.recordCount,
      3,
      'a retraction removes a row rather than accepting one, so it stays out of the volume',
    );
  });

  it('an unconfigured relay lands as unconfigured and names the missing variable', async () => {
    const { value: projected } = await withCapturedWarn(() => runProducerThenProject({
      env: {},
      fetchImpl: async () => {
        throw new Error('no network when unconfigured');
      },
    }));

    assert.equal(projected.record.state, 'unconfigured');
    assert.deepEqual(projected.record.missingConfig, [
      'CONVEX_SITE_URL (or CONVEX_URL)',
      'RELAY_SHARED_SECRET',
      'OPENROUTER_API_KEY',
    ]);
    assert.equal(projected.meta.sourceState, 'unavailable');
  });
});
