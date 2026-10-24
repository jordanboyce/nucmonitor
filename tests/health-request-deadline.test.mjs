/**
 * /api/health refresh owner under a degraded Redis (#8268 follow-up).
 *
 * With every Redis command answering just inside its own timeout, the lease
 * owner's request used to run each timeout back to back (snapshot read, lease,
 * sweep, snapshot write): about 30 s in
 * this fixture and ~55 s in production, past the 25 s edge first-byte limit
 * and the 30 s lease TTL. The owner now works against one per-request
 * deadline and, when it runs out, serves the last published verdict as a
 * stale 200 instead of hanging.
 *
 * Time is simulated: each outgoing request completes at (its own
 * AbortSignal.timeout − 1 ms) on a discrete-event clock, so concurrent
 * requests overlap as they would in production and the test runs instantly.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

process.env.UPSTASH_REDIS_REST_URL = 'https://mock-upstash.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'mock-token';

const { default: handler, __testing__: t } = await import('../api/health.js');

const EDGE_FIRST_BYTE_LIMIT_MS = 25_000;
const realFetch = globalThis.fetch;
const realNow = Date.now;
const realTimeout = AbortSignal.timeout;
const ENV_KEYS = ['VERCEL', 'VERCEL_ENV'];
const savedEnv = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  AbortSignal.timeout = realTimeout;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function degradedRedisFixture() {
  let now = realNow();
  Date.now = () => now;
  let slow = false;
  const timeouts = new WeakMap();
  AbortSignal.timeout = (ms) => {
    const signal = new AbortController().signal;
    timeouts.set(signal, ms);
    return signal;
  };

  // Discrete-event clock: a request completes at start + latency. The pump
  // runs after microtasks drain, so everything issued concurrently is pending
  // before time moves, and time only moves to the earliest completion.
  const pending = [];
  let pumpScheduled = false;
  const pump = () => {
    pumpScheduled = false;
    if (pending.length === 0) return;
    pending.sort((a, b) => a.at - b.at);
    const next = pending.shift();
    now = Math.max(now, next.at);
    next.resolve();
    schedulePump();
  };
  const schedulePump = () => {
    if (pumpScheduled || pending.length === 0) return;
    pumpScheduled = true;
    setImmediate(pump);
  };
  const elapse = (signal) => {
    const latency = slow ? Math.max(0, (timeouts.get(signal) ?? 0) - 1) : 1;
    return new Promise((resolve) => {
      pending.push({ at: now + latency, resolve });
      schedulePump();
    });
  };

  const store = new Map();
  const live = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.until !== null && entry.until <= now) { store.delete(key); return null; }
    return entry.value;
  };
  const set = (key, value, ttlSeconds) => store.set(key, { value, until: ttlSeconds ? now + Number(ttlSeconds) * 1_000 : null });
  const ops = [];

  const run = ([op, key, ...args]) => {
    if (op === 'SET') {
      const nx = args.includes('NX');
      const exIndex = args.indexOf('EX');
      if (nx && live(key) !== null) return { result: null };
      set(key, args[0], exIndex >= 0 ? args[exIndex + 1] : null);
      return { result: 'OK' };
    }
    if (op === 'EVAL') {
      const script = key;
      const count = Number(args[0]);
      const keys = args.slice(1, 1 + count);
      const argv = args.slice(1 + count);
      if (script === t.HEALTH_VERDICT_WRITE_SNAPSHOT_SCRIPT) {
        if (live(keys[0]) !== argv[0]) return { result: null };
        set(keys[1], argv[1], argv[3]);
        set(keys[2], argv[2], argv[3]);
        set(keys[3], argv[1], argv[4]);
        set(keys[4], argv[2], argv[4]);
        return { result: 'OK' };
      }
      if (script === t.HEALTH_VERDICT_RELEASE_LOCK_SCRIPT) {
        if (live(keys[0]) === argv[0]) { store.delete(keys[0]); return { result: 1 }; }
        return { result: 0 };
      }
      if (script === t.HEALTH_VERDICT_MUTATION_SCRIPT) {
        return { result: live(keys[0]) === argv[0] ? 'OK' : null };
      }
      set(keys[0], argv[1], argv[2]);
      return { result: 'OK' };
    }
    if (op === 'GET') {
      const value = live(key);
      if (value !== null) return { result: value };
      if (String(key).startsWith('seed-meta:')) return { result: JSON.stringify({ fetchedAt: now, recordCount: 1 }) };
      return { result: null };
    }
    if (op === 'STRLEN') return { result: 100 };
    if (op === 'LLEN') return { result: 1 };
    if (op === 'EXISTS' || op === 'HEXISTS') return { result: 1 };
    return { result: 'OK' };
  };

  globalThis.fetch = async (input, init = {}) => {
    await elapse(init.signal);
    const commands = JSON.parse(init.body);
    ops.push(commands.length > 1 ? 'SWEEP' : commands[0][0]);
    return Response.json(commands.map(run));
  };

  return {
    get now() { return now; },
    advance: (ms) => { now += ms; },
    degrade: () => { slow = true; },
    get lock() { return live(t.HEALTH_VERDICT_REFRESH_LOCK_KEY); },
    ops,
  };
}

const ctx = () => {
  const waited = [];
  return { waitUntil: (promise) => { waited.push(promise); }, waited };
};
const request = (c) => handler(new Request('https://api.worldmonitor.app/api/health?compact=1'), c);

test('the deadline leaves room for the stale read under the edge first-byte limit and the lease TTL', () => {
  assert.ok(t.HEALTH_REQUEST_DEADLINE_MS <= EDGE_FIRST_BYTE_LIMIT_MS - 3_000, 'guard band under the 25 s first byte');
  assert.ok(t.HEALTH_REQUEST_DEADLINE_MS < t.HEALTH_VERDICT_REFRESH_LOCK_TTL_SECONDS * 1_000, 'the owner answers inside its own lease');
  assert.equal(
    t.HEALTH_REQUEST_WORK_BUDGET_MS + t.HEALTH_VERDICT_LAST_KNOWN_READ_TIMEOUT_MS,
    t.HEALTH_REQUEST_DEADLINE_MS,
    'work stops early enough for the last-known read to fit',
  );
});

test('healthy Redis: the owner sweeps and serves its own fresh verdict', async () => {
  const f = degradedRedisFixture();
  const started = f.now;
  const response = await request(ctx());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stale, undefined);
  assert.ok(f.ops.includes('SWEEP'));
  assert.ok(f.now - started < 1_000);
});

// The owner's critical path (snapshot read, lease, sweep, snapshot write) now
// fits inside the deadline even when every Redis op runs to its timeout, so it
// answers 200 in time either way: a fresh verdict when the sweep completed, or
// the last published one as a stale REFRESH_PENDING 200 if it ran out.
test('every Redis op running to its timeout: the owner still answers 200 before the deadline', async () => {
  const f = degradedRedisFixture();
  const first = await request(ctx());
  assert.equal(first.status, 200);
  const published = await first.json();
  // The 60 s snapshot expires; the 600 s last-known copy does not.
  f.advance(61_000);
  f.degrade();

  const c = ctx();
  const started = f.now;
  const response = await request(c);
  const elapsed = f.now - started;

  assert.ok(elapsed <= t.HEALTH_REQUEST_DEADLINE_MS, `owner answered after ${elapsed} ms`);
  assert.ok(elapsed < EDGE_FIRST_BYTE_LIMIT_MS);
  assert.equal(response.status, 200, 'UptimeRobot and the capture scripts read non-2xx as down');
  const body = await response.json();
  if (body.stale) {
    assert.equal(body.staleReason, 'REFRESH_PENDING');
    assert.equal(body.status, published.status);
    assert.equal(body.checkedAt, published.checkedAt, 'the last published verdict, not a partial sweep');
  } else {
    assert.notEqual(body.checkedAt, published.checkedAt, 'a fresh sweep, not the expired snapshot');
  }
  await Promise.allSettled(c.waited);
});
