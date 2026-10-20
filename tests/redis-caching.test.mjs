import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTempDir, removeTempDir } from './helpers/temp-dir.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const REDIS_MODULE_URL = pathToFileURL(resolve(root, 'server/_shared/redis.ts')).href;

function jsonResponse(payload, ok = true) {
  return {
    ok,
    async json() {
      return payload;
    },
  };
}

function withEnv(overrides) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function importRedisFresh() {
  return import(`${REDIS_MODULE_URL}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function resolveRelativeTsModule(fromDir, specifier) {
  const candidates = [
    resolve(fromDir, specifier),
    resolve(fromDir, `${specifier}.ts`),
    resolve(fromDir, `${specifier}.js`),
    resolve(fromDir, `${specifier}.mjs`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

async function importPatchedTsModule(relPath, replacements) {
  const sourcePath = resolve(root, relPath);
  const sourceDir = dirname(sourcePath);
  let source = readFileSync(sourcePath, 'utf-8');

  for (const [specifier, targetPath] of Object.entries(replacements)) {
    source = source.replaceAll(`'${specifier}'`, `'${pathToFileURL(targetPath).href}'`);
  }

  // The patched file is imported from /tmp. Remaining relative specifiers
  // (e.g. `./_bounds` after a same-directory extract) still resolve against
  // that temp dir unless they are rewritten to the original sibling path.
  source = source.replaceAll(/from '((?:\.\.?\/)[^']+)'/g, (match, specifier) => {
    const targetPath = resolveRelativeTsModule(sourceDir, specifier);
    return targetPath ? `from '${pathToFileURL(targetPath).href}'` : match;
  });

  const tempDir = createTempDir('wm-ts-module-');
  const tempPath = join(tempDir, basename(sourcePath));
  writeFileSync(tempPath, source);

  const module = await import(`${pathToFileURL(tempPath).href}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return {
    module,
    cleanup() {
      removeTempDir(tempDir);
    },
  };
}

// Match the body-mode shape `setCachedJson` emits: `POST /` with body
// ['SET', key, value, 'EX', ttl]. The previous URL-path form
// (`POST /set/{key}/{value}/EX/{ttl}`) is no longer produced by any caller,
// so we don't bother matching it.
function isSetRequest(_url, init) {
  try {
    const body = JSON.parse(String(init?.body ?? 'null'));
    return Array.isArray(body) && body[0] === 'SET';
  } catch {
    return false;
  }
}

function parseSetRequest(_url, init) {
  const body = JSON.parse(String(init.body));
  return {
    key: body[1],
    value: body[2],
    ttlSeconds: Number(body[4]),
    nx: body.includes('NX'),
  };
}

function applySetToStore(store, url, init) {
  const { key, value, nx } = parseSetRequest(url, init);
  if (nx && store.has(key)) return jsonResponse({ result: null });
  store.set(key, value);
  return jsonResponse({ result: 'OK' });
}

describe('redis caching behavior', { concurrency: 1 }, () => {
  it('keeps followers coalesced until the caller-owned positive commit finishes', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes('/get/')) return jsonResponse({ result: undefined });
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    };
    let fetcherCalls = 0;
    let releaseCommit;
    const commitStarted = Promise.withResolvers();
    const commitRelease = new Promise((resolvePromise) => { releaseCommit = resolvePromise; });
    const opts = {
      cachePositiveResult: false,
      onPositiveResult: async () => {
        commitStarted.resolve();
        await commitRelease;
      },
    };
    try {
      const fetcher = async () => {
        fetcherCalls += 1;
        return { value: 42 };
      };
      const leader = redis.cachedFetchJsonWithMeta('commit:test:key', 60, fetcher, 120, opts);
      await commitStarted.promise;
      const follower = redis.cachedFetchJsonWithMeta('commit:test:key', 60, fetcher, 120, opts);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
      assert.equal(fetcherCalls, 1);
      releaseCommit();
      const [leaderResult, followerResult] = await Promise.all([leader, follower]);
      assert.equal(leaderResult.leader, true);
      assert.equal(followerResult.leader, false);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('reports an oversized sidecar cache write as rejected', async () => {
    const restoreEnv = withEnv({ LOCAL_API_MODE: 'tauri-sidecar' });
    const redis = await importRedisFresh();
    try {
      assert.equal(await redis.setCachedJson('oversized:test:key', 'x'.repeat(1_048_577), 60), false);
    } finally {
      restoreEnv();
    }
  });

  it('coalesces concurrent misses into one upstream fetcher execution', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let getCalls = 0;
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        getCalls += 1;
        return jsonResponse({ result: undefined });
      }
      if (isSetRequest(url, init)) {
        setCalls += 1;
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        return { value: 42 };
      };

      const [a, b, c] = await Promise.all([
        redis.cachedFetchJson('military:test:key', 60, fetcher),
        redis.cachedFetchJson('military:test:key', 60, fetcher),
        redis.cachedFetchJson('military:test:key', 60, fetcher),
      ]);

      assert.equal(fetcherCalls, 1, 'concurrent callers should share a single miss fetch');
      assert.deepEqual(a, { value: 42 });
      assert.deepEqual(b, { value: 42 });
      assert.deepEqual(c, { value: 42 });
      assert.equal(getCalls, 3, 'each caller should still attempt one cache read');
      assert.ok(setCalls >= 1, 'at least one cache write should happen after coalesced fetch (data + optional seed-meta)');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('coalesces concurrent misses after asynchronous admission', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    };

    try {
      let fetcherCalls = 0;
      let admissionCalls = 0;
      const admissionReached = Promise.withResolvers();
      const admission = Promise.withResolvers();
      const shouldFetch = async () => {
        admissionCalls += 1;
        if (admissionCalls === 3) admissionReached.resolve();
        return admission.promise;
      };
      const fetcher = async () => {
        fetcherCalls += 1;
        return { value: 42 };
      };

      const results = [
        redis.cachedFetchJsonWithMeta('webcam:test:admission', 60, fetcher, 120, { shouldFetch }),
        redis.cachedFetchJsonWithMeta('webcam:test:admission', 60, fetcher, 120, { shouldFetch }),
        redis.cachedFetchJsonWithMeta('webcam:test:admission', 60, fetcher, 120, { shouldFetch }),
      ];
      await admissionReached.promise;
      admission.resolve(true);

      const [a, b, c] = await Promise.all(results);
      assert.equal(fetcherCalls, 1, 'admitted callers should share one upstream fetch');
      assert.equal(a.leader, true);
      assert.equal(b.leader, false);
      assert.equal(c.leader, false);
      assert.deepEqual(a.data, { value: 42 });
      assert.deepEqual(b.data, { value: 42 });
      assert.deepEqual(c.data, { value: 42 });
      assert.equal(a.source, 'fresh');
      assert.equal(b.source, 'fresh');
      assert.equal(c.source, 'fresh');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('does not positive-cache no-store fallback payloads', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const setValues = [];
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) {
        const parsed = parseSetRequest(url, init);
        setValues.push(parsed);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const fallback = { items: [], degraded: true, error: 'upstream_unavailable' };
      const result = await redis.cachedFetchJson('meta:test:no-store', 60, async () => fallback);

      assert.deepEqual(result, fallback);
      assert.equal(setValues.length, 1);
      assert.equal(JSON.parse(setValues[0].value), '__WM_NEG__');
      assert.equal(setValues[0].ttlSeconds, 120);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('positive-caches only upstreamUnavailable-only payloads when explicitly enabled', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const setValues = [];

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) {
        const parsed = parseSetRequest(url, init);
        setValues.push(parsed);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const partial = { items: [{ id: 'covered' }], upstreamUnavailable: true };
      assert.deepEqual(
        await redis.cachedFetchJson(
          'meta:test:upstream-only',
          60,
          async () => partial,
          120,
          { cacheUpstreamUnavailablePayloads: true },
        ),
        partial,
      );
      assert.deepEqual(JSON.parse(setValues.at(-1).value), partial);
      assert.equal(setValues.at(-1).ttlSeconds, 60);

      const mixedMarkers = [
        { unavailable: true },
        { dataAvailable: false },
        { degraded: true },
        { error: 'upstream failed' },
      ];
      for (const [index, marker] of mixedMarkers.entries()) {
        const mixed = { ...partial, ...marker };
        assert.deepEqual(
          await redis.cachedFetchJson(
            `meta:test:upstream-mixed:${index}`,
            60,
            async () => mixed,
            120,
            { cacheUpstreamUnavailablePayloads: true },
          ),
          mixed,
        );
        assert.equal(JSON.parse(setValues.at(-1).value), '__WM_NEG__');
        assert.equal(setValues.at(-1).ttlSeconds, 120);
      }
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('parses pipeline results and skips malformed entries', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let pipelineCalls = 0;
    globalThis.fetch = async (_url, init = {}) => {
      pipelineCalls += 1;
      const pipeline = JSON.parse(String(init.body));
      assert.equal(pipeline.length, 3);
      assert.deepEqual(pipeline.map((cmd) => cmd[0]), ['GET', 'GET', 'GET']);
      return jsonResponse([
        { result: JSON.stringify({ details: { id: 'a1' } }) },
        { result: '{ malformed json' },
        { result: JSON.stringify({ details: { id: 'c3' } }) },
      ]);
    };

    try {
      const map = await redis.getCachedJsonBatch(['k1', 'k2', 'k3']);
      assert.equal(pipelineCalls, 1, 'batch lookup should use one pipeline round-trip');
      assert.deepEqual(map.get('k1'), { details: { id: 'a1' } });
      assert.equal(map.has('k2'), false, 'malformed JSON entry should be skipped');
      assert.deepEqual(map.get('k3'), { details: { id: 'c3' } });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('cachedFetchJsonWithMeta source labeling', { concurrency: 1 }, () => {
  it('reports source=cache on Redis hit', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        return jsonResponse({ result: JSON.stringify({ value: 'cached-data' }) });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalled = false;
      const { data, source } = await redis.cachedFetchJsonWithMeta('meta:test:hit', 60, async () => {
        fetcherCalled = true;
        return { value: 'fresh-data' };
      });

      assert.equal(source, 'cache', 'should report source=cache on Redis hit');
      assert.deepEqual(data, { value: 'cached-data' });
      assert.equal(fetcherCalled, false, 'fetcher should not run on cache hit');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('awaits a gated cache miss without hiding positive cache hits or writing a sentinel', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const store = new Map([
      ['meta:test:gated-hit', JSON.stringify({ value: 'cached-data' })],
    ]);
    let setCalls = 0;
    let fetcherCalls = 0;

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        return jsonResponse({ result: store.get(key) });
      }
      if (isSetRequest(url, init)) {
        setCalls += 1;
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    const fetcher = async () => {
      fetcherCalls += 1;
      return { value: 'fresh-data' };
    };

    try {
      const hit = await redis.cachedFetchJsonWithMeta(
        'meta:test:gated-hit',
        60,
        fetcher,
        120,
        { shouldFetch: async () => false },
      );
      assert.deepEqual(hit, {
        data: { value: 'cached-data' },
        source: 'cache',
        leader: false,
      });

      const skipped = await redis.cachedFetchJsonWithMeta(
        'meta:test:gated-miss',
        60,
        fetcher,
        120,
        { shouldFetch: async () => false },
      );
      assert.deepEqual(skipped, { data: null, source: 'skipped', leader: false });
      assert.equal(fetcherCalls, 0, 'the provider-local fetcher must remain gated');
      assert.equal(setCalls, 0, 'a gated miss must not become a shared negative sentinel');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('can defer a positive write to a caller-owned atomic publication gate', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    let setCalls = 0;

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) {
        setCalls += 1;
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const result = await redis.cachedFetchJsonWithMeta(
        'meta:test:deferred-positive-write',
        60,
        async () => ({ value: 'fresh-data' }),
        120,
        { cachePositiveResult: false },
      );
      assert.deepEqual(result, { data: { value: 'fresh-data' }, source: 'fresh', leader: true });
      assert.equal(setCalls, 0, 'the caller-owned publication must be the only positive write');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('does not bridge a deferred positive result after a cache read error', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    let fetcherCalls = 0;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ error: 'temporary read failure' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const fetcher = async () => {
        fetcherCalls += 1;
        return { value: 'fresh-data' };
      };
      await redis.cachedFetchJsonWithMeta(
        'meta:test:deferred-positive-read-error',
        60,
        fetcher,
        120,
        { cachePositiveResult: false },
      );
      await redis.cachedFetchJsonWithMeta(
        'meta:test:deferred-positive-read-error',
        60,
        fetcher,
        120,
        { cachePositiveResult: false },
      );
      assert.equal(fetcherCalls, 2, 'a deferred result must not bypass the next acceptance decision');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('joins an existing fetch before applying a caller-local gate', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    let resolveLeader;
    const leaderResult = new Promise((resolve) => {
      resolveLeader = resolve;
    });

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const leader = redis.cachedFetchJsonWithMeta(
        'meta:test:gated-inflight',
        60,
        async () => leaderResult,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      let followerFetcherCalled = false;
      const follower = redis.cachedFetchJsonWithMeta(
        'meta:test:gated-inflight',
        60,
        async () => {
          followerFetcherCalled = true;
          return { value: 'wrong' };
        },
        120,
        { shouldFetch: () => false },
      );

      resolveLeader({ value: 'coalesced' });
      assert.deepEqual(await leader, {
        data: { value: 'coalesced' },
        source: 'fresh',
        leader: true,
      });
      assert.deepEqual(await follower, {
        data: { value: 'coalesced' },
        source: 'fresh',
        leader: false,
      });
      assert.equal(followerFetcherCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('isolates in-flight providers while sharing their positive cache key', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    let resolvePrimary;
    const primaryResult = new Promise((resolve) => {
      resolvePrimary = resolve;
    });
    let setCalls = 0;

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) {
        setCalls += 1;
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const primary = redis.cachedFetchJsonWithMeta(
        'meta:test:provider-shared',
        60,
        async () => primaryResult,
        120,
        { cacheFailures: false, inflightKey: 'provider:primary' },
      );
      await new Promise((resolve) => setTimeout(resolve, 0));

      const fallback = await redis.cachedFetchJsonWithMeta(
        'meta:test:provider-shared',
        60,
        async () => ({ value: 'fallback-success' }),
        120,
        { cacheFailures: false, inflightKey: 'provider:fallback' },
      );
      assert.deepEqual(fallback, {
        data: { value: 'fallback-success' },
        source: 'fresh',
        leader: true,
      });

      resolvePrimary(null);
      assert.deepEqual(await primary, { data: null, source: 'fresh', leader: true });

      let recoveryCalls = 0;
      const recovered = await redis.cachedFetchJsonWithMeta(
        'meta:test:provider-shared',
        60,
        async () => {
          recoveryCalls += 1;
          return { value: 'primary-recovered' };
        },
        120,
        { cacheFailures: false, inflightKey: 'provider:primary' },
      );
      assert.deepEqual(recovered.data, { value: 'primary-recovered' });
      assert.equal(recoveryCalls, 1, 'a settled custom in-flight key must be reusable');
      assert.equal(setCalls, 2, 'only the two positive results should be cached');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('does not negative-cache a no-store payload when failure caching is disabled', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    let setCalls = 0;

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) {
        setCalls += 1;
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const unavailable = await redis.cachedFetchJsonWithMeta(
        'meta:test:no-store-positive-only',
        60,
        async () => ({ upstreamUnavailable: true }),
        120,
        { cacheFailures: false },
      );
      assert.deepEqual(unavailable.data, { upstreamUnavailable: true });
      assert.equal(setCalls, 0, 'the no-store payload must not write a sentinel');

      const recovered = await redis.cachedFetchJsonWithMeta(
        'meta:test:no-store-positive-only',
        60,
        async () => ({ value: 'recovered' }),
        120,
        { cacheFailures: false },
      );
      assert.deepEqual(recovered.data, { value: 'recovered' });
      assert.equal(setCalls, 1, 'the later positive result remains cacheable');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('reports source=fresh on cache miss', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const { data, source, leader } = await redis.cachedFetchJsonWithMeta('meta:test:miss', 60, async () => {
        return { value: 'fresh-data' };
      });

      assert.equal(source, 'fresh', 'should report source=fresh on cache miss');
      assert.equal(leader, true, 'cache miss caller that runs the fetcher should be marked leader');
      assert.deepEqual(data, { value: 'fresh-data' });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('reports source=fresh for all coalesced callers but marks only the fetch leader', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return { value: 'coalesced' };
      };

      const [a, b, c] = await Promise.all([
        redis.cachedFetchJsonWithMeta('meta:test:coalesce', 60, fetcher),
        redis.cachedFetchJsonWithMeta('meta:test:coalesce', 60, fetcher),
        redis.cachedFetchJsonWithMeta('meta:test:coalesce', 60, fetcher),
      ]);

      assert.equal(fetcherCalls, 1, 'only one fetcher should run');
      assert.equal(a.source, 'fresh', 'leader should report fresh');
      assert.equal(b.source, 'fresh', 'follower 1 should report fresh (not cache)');
      assert.equal(c.source, 'fresh', 'follower 2 should report fresh (not cache)');
      assert.equal([a, b, c].filter((r) => r.leader).length, 1, 'only one coalesced caller should be the write leader');
      assert.deepEqual(a.data, { value: 'coalesced' });
      assert.deepEqual(b.data, { value: 'coalesced' });
      assert.deepEqual(c.data, { value: 'coalesced' });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('TOCTOU: reports cache when Redis is populated between concurrent reads', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    // First call: cache miss. Second call (from a "different instance"): cache hit.
    let getCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        getCalls += 1;
        if (getCalls === 1) return jsonResponse({ result: undefined });
        // Simulate another instance populating cache between calls
        return jsonResponse({ result: JSON.stringify({ value: 'from-other-instance' }) });
      }
      if (isSetRequest(url, init)) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      // First call: miss → fetcher runs → fresh
      const first = await redis.cachedFetchJsonWithMeta('meta:test:toctou', 60, async () => {
        return { value: 'fetched' };
      });
      assert.equal(first.source, 'fresh');
      assert.deepEqual(first.data, { value: 'fetched' });

      // Second call (fresh module import to clear inflight map): cache hit from other instance
      const redis2 = await importRedisFresh();
      const second = await redis2.cachedFetchJsonWithMeta('meta:test:toctou', 60, async () => {
        throw new Error('fetcher should not run on cache hit');
      });
      assert.equal(second.source, 'cache', 'should report cache when Redis has data');
      assert.deepEqual(second.data, { value: 'from-other-instance' });
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('uses an in-process positive fallback after Redis read errors even when the write succeeds', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let getCalls = 0;
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        getCalls += 1;
        throw new Error('Redis GET failed');
      }
      if (isSetRequest(url, init)) {
        setCalls += 1;
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        return { value: 'fresh-during-read-outage' };
      };

      const first = await redis.cachedFetchJsonWithMeta('meta:test:local-positive-read-error', 300, fetcher);
      assert.equal(first.source, 'fresh');
      assert.deepEqual(first.data, { value: 'fresh-during-read-outage' });

      const second = await redis.cachedFetchJsonWithMeta('meta:test:local-positive-read-error', 300, fetcher);
      assert.equal(second.source, 'cache', 'local fallback should report cache semantics');
      assert.deepEqual(second.data, { value: 'fresh-during-read-outage' });
      assert.equal(fetcherCalls, 1, 'read-error path must not refetch while local positive fallback is live');
      assert.equal(getCalls, 2, 'each call may still probe Redis before using the local fallback');
      assert.equal(setCalls, 1, 'only the fresh leader should write Redis');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('negative-result caching', { concurrency: 1 }, () => {
  it('caches sentinel on null fetcher result and suppresses subsequent upstream calls', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const store = new Map();
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        const val = store.get(key);
        return jsonResponse({ result: val ?? undefined });
      }
      if (isSetRequest(raw, init)) {
        const { key, value } = parseSetRequest(raw, init);
        store.set(key, value);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        return null;
      };

      const first = await redis.cachedFetchJson('neg:test:suppress', 300, fetcher);
      assert.equal(first, null, 'first call should return null');
      assert.equal(fetcherCalls, 1, 'fetcher should run on first call');

      const redis2 = await importRedisFresh();
      const second = await redis2.cachedFetchJson('neg:test:suppress', 300, fetcher);
      assert.equal(second, null, 'second call should return null from sentinel');
      assert.equal(fetcherCalls, 1, 'fetcher should NOT run again — sentinel suppresses');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('cachedFetchJsonWithMeta returns data:null source:cache on sentinel hit', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const store = new Map();
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        const val = store.get(key);
        return jsonResponse({ result: val ?? undefined });
      }
      if (isSetRequest(raw, init)) {
        const { key, value } = parseSetRequest(raw, init);
        store.set(key, value);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      const first = await redis.cachedFetchJsonWithMeta('neg:meta:sentinel', 300, async () => null);
      assert.equal(first.data, null);
      assert.equal(first.source, 'fresh', 'first null result is fresh');

      const redis2 = await importRedisFresh();
      const second = await redis2.cachedFetchJsonWithMeta('neg:meta:sentinel', 300, async () => {
        throw new Error('fetcher should not run on sentinel hit');
      });
      assert.equal(second.data, null, 'sentinel should resolve to null data, not the sentinel string');
      assert.equal(second.source, 'cache', 'sentinel hit should report source=cache');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('caches a short sentinel when fetcher throws, while preserving the leader rejection', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const store = new Map();
    const ttls = new Map();
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        return jsonResponse({ result: store.get(key) ?? undefined });
      }
      if (isSetRequest(url, init)) {
        const { key, value, ttlSeconds } = parseSetRequest(url, init);
        setCalls += 1;
        store.set(key, value);
        ttls.set(key, ttlSeconds);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const throwingFetcher = async () => {
        fetcherCalls += 1;
        throw new Error('upstream ETIMEDOUT');
      };

      await assert.rejects(() => redis.cachedFetchJson('neg:test:throw', 300, throwingFetcher));
      assert.equal(fetcherCalls, 1);
      assert.equal(setCalls, 1, 'throw path should write a cooldown sentinel');
      assert.equal(JSON.parse(store.get('neg:test:throw')), '__WM_NEG__');
      assert.equal(ttls.get('neg:test:throw'), 30, 'throw path should use a short error cooldown TTL');

      const redis2 = await importRedisFresh();
      const second = await redis2.cachedFetchJson('neg:test:throw', 300, throwingFetcher);
      assert.equal(second, null, 'subsequent call should resolve from the cooldown sentinel');
      assert.equal(fetcherCalls, 1, 'fetcher should NOT run again while the sentinel is live');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('cachedFetchJson ignores WithMeta-only fields on a superset options object', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      USAGE_TELEMETRY: undefined,
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;

    const writes = [];
    const warnings = [];
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) {
        writes.push(parseSetRequest(url, init));
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };
    console.warn = (...args) => { warnings.push(args); };

    let shouldFetchCalls = 0;
    let callerLocalChecks = 0;
    let usageWaits = 0;
    const supersetOpts = {
      timeoutMs: 500,
      cacheFetcherErrors: true,
      shouldFetch: () => {
        shouldFetchCalls += 1;
        return true;
      },
      cacheFailures: false,
      inflightKey: 'plain:test:shared-inflight-key',
      isCallerLocalError: () => {
        callerLocalChecks += 1;
        return true;
      },
      usage: {
        provider: 'plain-helper-regression',
        ctx: {
          waitUntil() {
            usageWaits += 1;
          },
        },
      },
    };

    try {
      let releaseFetchers;
      const fetcherGate = new Promise((resolvePromise) => {
        releaseFetchers = resolvePromise;
      });
      const first = redis.cachedFetchJson(
        'plain:test:first',
        300,
        async () => {
          await fetcherGate;
          return { value: 'first' };
        },
        60,
        supersetOpts,
      );
      const second = redis.cachedFetchJson(
        'plain:test:second',
        300,
        async () => {
          await fetcherGate;
          return { value: 'second' };
        },
        60,
        supersetOpts,
      );

      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      releaseFetchers();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      assert.deepEqual(firstResult, { value: 'first' });
      assert.deepEqual(
        secondResult,
        { value: 'second' },
        'plain calls with distinct keys must not share a WithMeta inflightKey',
      );

      const nullResult = await redis.cachedFetchJson(
        'plain:test:null',
        300,
        async () => null,
        60,
        supersetOpts,
      );
      assert.equal(nullResult, null);

      const rejection = new Error('plain superset rejection');
      await assert.rejects(
        () => redis.cachedFetchJson(
          'plain:test:rejection',
          300,
          async () => {
            throw rejection;
          },
          60,
          supersetOpts,
        ),
        (error) => {
          assert.strictEqual(error, rejection, 'plain helper must propagate the original fetcher error');
          return true;
        },
      );

      const writesByKey = new Map(writes.map((write) => [write.key, write]));
      const nullWrite = writesByKey.get('plain:test:null');
      const rejectionWrite = writesByKey.get('plain:test:rejection');
      assert.ok(nullWrite, 'plain null results must keep legacy negative caching');
      assert.ok(rejectionWrite, 'plain fetcher errors must keep legacy negative caching');
      assert.equal(JSON.parse(nullWrite.value), '__WM_NEG__');
      assert.equal(JSON.parse(rejectionWrite.value), '__WM_NEG__');
      assert.equal(shouldFetchCalls, 0, 'plain helper must not evaluate WithMeta shouldFetch');
      assert.equal(callerLocalChecks, 0, 'plain helper must not evaluate WithMeta isCallerLocalError');
      assert.equal(usageWaits, 0, 'plain helper must not emit WithMeta usage telemetry');
      assert.deepEqual(warnings, [[
        '[redis] cachedFetchJson fetcher failed for "plain:test:rejection":',
        'plain superset rejection',
      ]]);
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      restoreEnv();
    }
  });

  it('keeps rejected-fetcher warnings attributed to each public cache helper', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings = [];

    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (isSetRequest(url, init)) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };
    console.warn = (...args) => { warnings.push(args); };

    try {
      const plainError = new Error('plain helper rejected');
      await assert.rejects(
        () => redis.cachedFetchJson(
          'warn:test:plain',
          300,
          async () => {
            throw plainError;
          },
        ),
        (error) => {
          assert.strictEqual(error, plainError);
          return true;
        },
      );

      const metaError = new Error('meta helper rejected');
      await assert.rejects(
        () => redis.cachedFetchJsonWithMeta(
          'warn:test:meta',
          300,
          async () => {
            throw metaError;
          },
        ),
        (error) => {
          assert.strictEqual(error, metaError);
          return true;
        },
      );

      assert.deepEqual(warnings, [
        ['[redis] cachedFetchJson fetcher failed for "warn:test:plain":', 'plain helper rejected'],
        ['[redis] cachedFetchJsonWithMeta fetcher failed for "warn:test:meta":', 'meta helper rejected'],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      restoreEnv();
    }
  });

  it('retries fetcher errors when error negative caching is disabled', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const store = new Map();
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        return jsonResponse({ result: store.get(key) ?? undefined });
      }
      if (isSetRequest(url, init)) {
        const { key, value } = parseSetRequest(url, init);
        setCalls += 1;
        store.set(key, value);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        if (fetcherCalls === 1) throw new Error('upstream unavailable');
        return { value: 'recovered' };
      };

      await assert.rejects(() => redis.cachedFetchJson(
        'neg:test:no-error-cache',
        300,
        fetcher,
        60,
        { cacheFetcherErrors: false },
      ));
      assert.equal(setCalls, 0, 'fetcher errors must not write a negative sentinel');

      // Short isolate-local unavailable backoff suppresses re-fan-out.
      await assert.rejects(
        () => redis.cachedFetchJson(
          'neg:test:no-error-cache',
          300,
          fetcher,
          60,
          { cacheFetcherErrors: false },
        ),
        /unavailable backoff/,
      );
      assert.equal(fetcherCalls, 1, 'backoff must not re-hit the fetcher');

      redis.__clearLocalUnavailableBackoffForTests();
      const recovered = await redis.cachedFetchJson(
        'neg:test:no-error-cache',
        300,
        fetcher,
        60,
        { cacheFetcherErrors: false },
      );
      assert.deepEqual(recovered, { value: 'recovered' });
      assert.equal(fetcherCalls, 2, 'after backoff clear the next call should retry the fetcher');
      assert.equal(setCalls, 1, 'only the recovered positive result should be cached');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('honors cacheFetcherErrors:false on cachedFetchJsonWithMeta without writing NEG_SENTINEL', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const store = new Map();
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        const key = decodeURIComponent(raw.split('/get/').pop() || '');
        return jsonResponse({ result: store.get(key) ?? undefined });
      }
      if (isSetRequest(url, init)) {
        const { key, value } = parseSetRequest(url, init);
        setCalls += 1;
        store.set(key, value);
        return jsonResponse({ result: 'OK' });
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        if (fetcherCalls === 1) throw new Error('upstream unavailable');
        return { value: 'meta-recovered' };
      };

      await assert.rejects(() => redis.cachedFetchJsonWithMeta(
        'neg:test:no-error-cache-meta',
        300,
        fetcher,
        60,
        { cacheFetcherErrors: false },
      ));
      assert.equal(setCalls, 0, 'WithMeta must not write a negative sentinel when errors are not cached');

      redis.__clearLocalUnavailableBackoffForTests();
      const recovered = await redis.cachedFetchJsonWithMeta(
        'neg:test:no-error-cache-meta',
        300,
        fetcher,
        60,
        { cacheFetcherErrors: false },
      );
      assert.deepEqual(recovered.data, { value: 'meta-recovered' });
      assert.equal(recovered.source, 'fresh');
      assert.equal(fetcherCalls, 2);
      assert.equal(setCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('uses in-process cooldown on Redis read errors instead of treating them as plain misses', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let readMode = 'miss';
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        if (readMode === 'throw') throw new Error('Redis ECONNRESET');
        return jsonResponse({ result: undefined });
      }
      if (isSetRequest(url, init)) {
        throw new Error('Redis SET failed');
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const throwingFetcher = async () => {
        fetcherCalls += 1;
        throw new Error('upstream ETIMEDOUT');
      };

      await assert.rejects(() => redis.cachedFetchJson('neg:test:redis-read-error', 300, throwingFetcher));
      assert.equal(fetcherCalls, 1, 'first miss should run the fetcher and preserve its rejection');

      readMode = 'throw';
      const second = await redis.cachedFetchJson('neg:test:redis-read-error', 300, throwingFetcher);
      assert.equal(second, null, 'Redis read error should use the local cooldown sentinel');
      assert.equal(fetcherCalls, 1, 'read-error path must not stampede upstream while cooldown is active');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('uses an in-process positive fallback when Redis write fails after a successful fetch', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let getCalls = 0;
    let setCalls = 0;
    globalThis.fetch = async (url, init) => {
      const raw = String(url);
      if (raw.includes('/get/')) {
        getCalls += 1;
        return jsonResponse({ result: undefined });
      }
      if (isSetRequest(url, init)) {
        setCalls += 1;
        return jsonResponse({ error: 'Redis SET failed' }, false);
      }
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      let fetcherCalls = 0;
      const fetcher = async () => {
        fetcherCalls += 1;
        return { value: 'fresh-during-write-outage' };
      };

      const first = await redis.cachedFetchJson('pos:test:local-positive-write-error', 300, fetcher);
      assert.deepEqual(first, { value: 'fresh-during-write-outage' });

      const second = await redis.cachedFetchJson('pos:test:local-positive-write-error', 300, fetcher);
      assert.deepEqual(second, { value: 'fresh-during-write-outage' });
      assert.equal(fetcherCalls, 1, 'write-failure path must not refetch while local positive fallback is live');
      assert.equal(getCalls, 2, 'each call may still probe Redis before using the local fallback');
      assert.equal(setCalls, 1, 'only the fresh leader should attempt the failed write');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('cachedFetchJson inflight timeout (#3539)', { concurrency: 1 }, () => {
  it('rejects a hung fetcher and releases the inflight slot so subsequent callers re-fetch', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (raw.includes('/set/')) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      redis.__setFetcherTimeoutForTests(50);

      let hungCalls = 0;
      // Fetcher that NEVER settles — simulates an upstream that hangs forever
      // with no internal timeout and no AbortController.
      const hungFetcher = () => {
        hungCalls += 1;
        return new Promise(() => {});
      };

      // Concurrent callers should all share the same hung promise (coalescing
      // still works on the way in) and all reject with the timeout error.
      const [r1, r2, r3] = await Promise.allSettled([
        redis.cachedFetchJson('hang:test:key', 60, hungFetcher),
        redis.cachedFetchJson('hang:test:key', 60, hungFetcher),
        redis.cachedFetchJson('hang:test:key', 60, hungFetcher),
      ]);

      assert.equal(hungCalls, 1, 'fetcher should still be coalesced — one execution shared by all callers');
      assert.equal(r1.status, 'rejected');
      assert.equal(r2.status, 'rejected');
      assert.equal(r3.status, 'rejected');
      assert.ok(r1.reason instanceof redis.CachedFetchTimeoutError);
      assert.equal(r1.reason.name, 'CachedFetchTimeoutError');
      assert.match(r1.reason.message, /^cachedFetchJson timeout after 50ms for "hang:test:key"$/);

      // Critical assertion: a follow-up call after the timeout must trigger a
      // fresh fetcher execution. Pre-fix the inflight Map kept the unresolved
      // promise forever, handing every subsequent caller the same dead handle.
      let recovered = false;
      const recoveredValue = await redis.cachedFetchJson('hang:test:key', 60, async () => {
        recovered = true;
        return { value: 'recovered' };
      });
      assert.equal(recovered, true, 'inflight slot must be released so a new fetcher can run');
      assert.deepEqual(recoveredValue, { value: 'recovered' });
    } finally {
      redis.__resetFetcherTimeoutForTests();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('does NOT fire the timeout when the fetcher settles promptly', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (raw.includes('/set/')) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      redis.__setFetcherTimeoutForTests(50);

      const result = await redis.cachedFetchJson('happy:test:key', 60, async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { value: 'fast' };
      });
      assert.deepEqual(result, { value: 'fast' });

      // Wait past the timeout window — if the timer wasn't cleared we'd see
      // an unhandled rejection. Node's test runner surfaces those as failures.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      redis.__resetFetcherTimeoutForTests();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('per-call opts.timeoutMs overrides the default ceiling', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (raw.includes('/set/')) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      // Default ceiling deliberately tiny; caller passes a much higher per-call
      // budget, so a fetcher that runs 80ms should succeed. Without the
      // override it would reject at 20ms.
      redis.__setFetcherTimeoutForTests(20);

      const result = await redis.cachedFetchJson(
        'override:test:long',
        60,
        async () => {
          await new Promise((r) => setTimeout(r, 80));
          return { value: 'long-fetcher-allowed' };
        },
        undefined,
        { timeoutMs: 500 },
      );
      assert.deepEqual(result, { value: 'long-fetcher-allowed' });

      // Same shape for cachedFetchJsonWithMeta — opts.timeoutMs lives next to opts.usage.
      const meta = await redis.cachedFetchJsonWithMeta(
        'override:meta:long',
        60,
        async () => {
          await new Promise((r) => setTimeout(r, 80));
          return { value: 'meta-long-allowed' };
        },
        undefined,
        { timeoutMs: 500 },
      );
      assert.equal(meta.source, 'fresh');
      assert.deepEqual(meta.data, { value: 'meta-long-allowed' });
    } finally {
      redis.__resetFetcherTimeoutForTests();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('cachedFetchJsonWithMeta also enforces the inflight timeout', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url) => {
      const raw = String(url);
      if (raw.includes('/get/')) return jsonResponse({ result: undefined });
      if (raw.includes('/set/')) return jsonResponse({ result: 'OK' });
      throw new Error(`Unexpected fetch URL: ${raw}`);
    };

    try {
      redis.__setFetcherTimeoutForTests(50);

      await assert.rejects(
        () => redis.cachedFetchJsonWithMeta('meta:hang:key', 60, () => new Promise(() => {})),
        (err) => {
          assert.ok(err instanceof redis.CachedFetchTimeoutError);
          assert.match(err.message, /^cachedFetchJsonWithMeta timeout after 50ms for "meta:hang:key"$/);
          return true;
        },
      );

      // Subsequent call must succeed against a healthy fetcher — proves the
      // inflight slot was released even on the timeout path.
      const { data, source } = await redis.cachedFetchJsonWithMeta('meta:hang:key', 60, async () => ({ value: 'recovered' }));
      assert.equal(source, 'fresh');
      assert.deepEqual(data, { value: 'recovered' });
    } finally {
      redis.__resetFetcherTimeoutForTests();
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('setCachedJson wire shape and failure reporting', { concurrency: 1 }, () => {
  it('emits POST / with body ["SET", key, value, "EX", String(ttl)]', async () => {
    // Pins the body-mode wire shape so a future "simplification" back to
    // URL-path encoding (`POST /set/{key}/{value}/EX/{ttl}`) fails loudly.
    // That regression silently broke large-payload writes (e.g. news:digest:v1
    // at ~126KB) because the self-hosted redis-rest-proxy runs Node's
    // http.createServer, which rejects URLs >~16KB with ECONNRESET.
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    const captured = [];
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init });
      return jsonResponse({ result: 'OK' });
    };

    try {
      const key = 'news:digest:v1';
      const value = { items: [{ id: 'a' }, { id: 'b' }] };
      const ttl = 600;
      const ok = await redis.setCachedJson(key, value, ttl);

      assert.equal(ok, true, 'setCachedJson should return true on success');
      assert.equal(captured.length, 1, 'exactly one Redis write should be issued');
      const [req] = captured;
      assert.equal(req.init.method, 'POST');
      assert.equal(req.url, 'https://redis.test/', 'POST goes to base URL (not /set/...)');
      assert.equal(
        req.init.headers['Content-Type'],
        'application/json',
        'body-mode requires JSON Content-Type',
      );
      assert.deepEqual(
        JSON.parse(String(req.init.body)),
        ['SET', key, JSON.stringify(value), 'EX', String(ttl)],
        'body must carry the SET command + args verbatim',
      );
      assert.ok(
        !req.url.includes('/set/'),
        'URL must NOT carry payload in path — that was the original bug',
      );
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('returns false and warns when Upstash returns an error in the body', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args); };

    globalThis.fetch = async () => jsonResponse({ error: 'WRONGTYPE' });

    try {
      const ok = await redis.setCachedJson('k', { v: 1 }, 30);
      assert.equal(ok, false, 'Upstash error must surface as false');
      assert.equal(warnings.length, 1, 'should warn exactly once');
      const [msg, detail] = warnings[0];
      assert.match(String(msg), /setCachedJson failed/);
      assert.equal(detail, 'WRONGTYPE', 'warn payload should be the Upstash error string');
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      restoreEnv();
    }
  });

  it('returns false and warns on non-2xx HTTP responses', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args); };

    globalThis.fetch = async () => ({
      ok: false,
      status: 503,
      async json() { return null; },
    });

    try {
      const ok = await redis.setCachedJson('k', { v: 1 }, 30);
      assert.equal(ok, false, 'HTTP failure must surface as false');
      assert.equal(warnings.length, 1, 'should warn exactly once');
      const [msg, detail] = warnings[0];
      assert.match(String(msg), /setCachedJson failed/);
      assert.equal(detail, 'HTTP 503', 'warn payload should name the HTTP status');
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      restoreEnv();
    }
  });

  it('emits POST / with body ["SET", key, value, "EX", String(ttl), "NX"]', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const captured = [];
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init });
      return jsonResponse({ result: 'OK' });
    };

    try {
      const key = 'military:flights:stable-live:v1';
      const value = { flights: [{ id: 'a' }], coverage: 'global' };
      const ttl = 600;
      const created = await redis.setCachedJsonIfAbsent(key, value, ttl);

      assert.equal(created, true, 'SET NX should report creation when Redis returns OK');
      assert.equal(captured.length, 1, 'exactly one Redis write should be issued');
      assert.deepEqual(
        JSON.parse(String(captured[0].init.body)),
        ['SET', key, JSON.stringify(value), 'EX', String(ttl), 'NX'],
        'body must carry SET NX EX verbatim',
      );
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('returns false without warning when SET NX loses to an existing key', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => { warnings.push(args); };
    globalThis.fetch = async () => jsonResponse({ result: null });

    try {
      const created = await redis.setCachedJsonIfAbsent('k', { v: 1 }, 30);
      assert.equal(created, false, 'an existing key must not look like a successful create');
      assert.equal(warnings.length, 0, 'losing SET NX is expected and must not warn');
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      restoreEnv();
    }
  });

  it('passes first-writer transport exceptions to the caller error reporter', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
    });
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    const reported = [];
    globalThis.fetch = async () => { throw new Error('redis transport down'); };
    console.warn = () => {};

    try {
      const created = await redis.setCachedJsonIfAbsent(
        'k',
        { v: 1 },
        30,
        false,
        (error) => { reported.push(error); },
      );

      assert.equal(created, false, 'transport failure must remain fail-closed');
      assert.equal(reported.length, 1, 'transport exception must reach the caller reporter');
      assert.equal(reported[0]?.message, 'redis transport down');
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
      restoreEnv();
    }
  });
});

describe('bounded JSON-list history storage', { concurrency: 1 }, () => {
  it('uses an allowlisted transaction to deduplicate, prepend, trim, and expire', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const captured = [];
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init });
      return jsonResponse([
        { result: 0 },
        { result: 2 },
        { result: 'OK' },
        { result: 1 },
      ]);
    };

    try {
      const next = { generatedAt: 'current' };
      assert.equal(
        await redis.prependCachedJsonList('history:key', next, 16, 600),
        true,
      );

      assert.equal(captured.length, 1);
      const commands = JSON.parse(String(captured[0].init.body));
      assert.equal(captured[0].url, 'https://redis.test/multi-exec');
      assert.deepEqual(commands, [
        ['LREM', 'history:key', '0', JSON.stringify(next)],
        ['LPUSH', 'history:key', JSON.stringify(next)],
        ['LTRIM', 'history:key', '0', '15'],
        ['EXPIRE', 'history:key', '600'],
      ]);
      const proxy = readFileSync(resolve(root, 'docker/redis-rest-proxy.mjs'), 'utf8');
      assert.match(proxy, /'LREM'/);
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });

  it('reads and decodes the bounded list without collapsing a Redis error into a miss', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;
    const captured = [];
    let malformed = false;
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init });
      return jsonResponse(malformed
        ? { result: 'not-a-list' }
        : { result: [JSON.stringify({ generatedAt: 'current' })] });
    };

    try {
      assert.deepEqual(await redis.readCachedJsonList('history:key', 16), {
        status: 'hit',
        value: [{ generatedAt: 'current' }],
      });
      assert.equal(captured[0].url, 'https://redis.test/');
      assert.deepEqual(JSON.parse(String(captured[0].init.body)), [
        'LRANGE',
        'history:key',
        '0',
        '15',
      ]);
      malformed = true;
      assert.equal(
        (await redis.readCachedJsonList('history:key', 16)).status,
        'error',
      );
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('allowlisted Redis transactions', { concurrency: 1 }, () => {
  it('uses /multi-exec and preserves preview key prefixes', async () => {
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: 'preview',
      VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890',
    });
    const originalFetch = globalThis.fetch;
    const captured = [];
    globalThis.fetch = async (url, init) => {
      captured.push({ url: String(url), init });
      return jsonResponse([{ result: 'OK' }, { result: 0 }]);
    };

    try {
      const results = await redis.runRedisTransaction([
        ['SET', 'generation:data', '{}', 'EX', 600],
        ['DEL', 'generation:old'],
      ]);

      assert.deepEqual(results, [{ result: 'OK' }, { result: 0 }]);
      assert.equal(captured[0].url, 'https://redis.test/multi-exec');
      assert.deepEqual(JSON.parse(String(captured[0].init.body)), [
        ['SET', 'preview:abcdef12:generation:data', '{}', 'EX', 600],
        ['DEL', 'preview:abcdef12:generation:old'],
      ]);
      const proxy = readFileSync(resolve(root, 'docker/redis-rest-proxy.mjs'), 'utf8');
      assert.match(proxy, /req\.url === '\/multi-exec'/);
      const allowlist = proxy.match(/const ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? '';
      const commands = new Set([...allowlist.matchAll(/'([A-Z]+)'/g)].map((match) => match[1]));
      for (const command of ['GET', 'GETDEL', 'SET', 'DEL']) {
        assert.ok(commands.has(command), `${command} must be allowed by the Redis proxy`);
      }
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});

describe('getHashFieldsBatch empty-string handling (#3530)', { concurrency: 1 }, () => {
  it('preserves empty-string values, omits null/missing, and retains real strings', async () => {
    // Regression: getHashFieldsBatch used a truthy check (`if (values[i])`) that
    // dropped valid empty-string hash values. Real Redis hash values are
    // allowed to be the empty string, so a caller that round-trips "" will
    // silently lose it. The fix switches to a null/undefined check so "" is
    // preserved.
    const redis = await importRedisFresh();
    const restoreEnv = withEnv({
      UPSTASH_REDIS_REST_URL: 'https://redis.test',
      UPSTASH_REDIS_REST_TOKEN: 'token',
      VERCEL_ENV: undefined,
      VERCEL_GIT_COMMIT_SHA: undefined,
    });
    const originalFetch = globalThis.fetch;

    let pipelineCalls = 0;
    globalThis.fetch = async (_url, init = {}) => {
      pipelineCalls += 1;
      const pipeline = JSON.parse(String(init.body));
      assert.equal(pipeline.length, 1);
      assert.equal(pipeline[0][0], 'HMGET');
      assert.deepEqual(pipeline[0].slice(2), ['name', 'empty', 'missing', 'real']);
      // Upstash HMGET returns an array of (string | null) in field order:
      //   - real value  -> "alice"
      //   - valid ""    -> ""
      //   - missing key -> null
      //   - real value  -> "ok"
      return jsonResponse([{ result: ['alice', '', null, 'ok'] }]);
    };

    try {
      const map = await redis.getHashFieldsBatch('user:42', ['name', 'empty', 'missing', 'real']);
      assert.equal(pipelineCalls, 1, 'should batch into one HMGET pipeline call');
      assert.equal(map.get('name'), 'alice', 'non-empty value is kept');
      assert.equal(map.get('empty'), '', 'empty-string value must be preserved (this is the bug)');
      assert.equal(map.has('missing'), false, 'null entries are omitted');
      assert.equal(map.get('real'), 'ok', 'non-empty value is kept');
      assert.equal(map.size, 3, 'map should contain only the three resolvable fields');
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnv();
    }
  });
});
