import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cacheControlForEmbedFrame,
  composeEmbedMapFrame,
  parseRequestedLayers,
  type EmbedMapFrameSources,
} from '../server/_shared/embed-map-frame';
import {
  buildPublicEmbedFrameSearch,
  canonicalizeEmbedLayers,
  classifyPublicEmbedFrameRequest,
  EMBED_MAP_FRAME_PATH,
} from '../shared/embed-map-frame';
import { EMBED_LAYER_IDS, EMBED_REFRESH_MS } from '../shared/embed-panels';
import {
  handleEmbedMapFrame,
  type EmbedMapFrameHandlerDeps,
} from '../api/embed/map-frame';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOW = 1_700_000_000_000;

function sources(overrides: Partial<EmbedMapFrameSources> = {}): EmbedMapFrameSources {
  return {
    listEarthquakes: async () => [{ id: 'q1' }],
    listNaturalEvents: async () => [{ id: 'n1' }],
    listWeatherAlerts: async () => [{ id: 'w1' }],
    ...overrides,
  };
}

/** Counts calls so a test can prove an upstream was never touched. */
function countingSources(overrides: Partial<EmbedMapFrameSources> = {}) {
  const calls: string[] = [];
  const base = sources();
  const wrapped = Object.fromEntries(
    (Object.keys(base) as (keyof EmbedMapFrameSources)[]).map((key) => [
      key,
      async () => {
        calls.push(key);
        return (overrides[key] ?? base[key])();
      },
    ]),
  ) as EmbedMapFrameSources;
  return { calls, sources: wrapped };
}

function deps(overrides: Partial<EmbedMapFrameHandlerDeps> = {}): EmbedMapFrameHandlerDeps {
  return {
    getCorsHeaders: () => ({}),
    checkRateLimit: async () => null,
    composeFrame: async (layers) => composeEmbedMapFrame(layers, sources(), NOW),
    isPartnerMode: () => false,
    ...overrides,
  };
}

describe('embed map frame', () => {
  describe('requested layers', () => {
    it('accepts the allowlist and drops everything else', () => {
      assert.deepEqual(
        parseRequestedLayers('weather,cables,pipelines'),
        ['weather', 'cables', 'pipelines'],
      );
      assert.deepEqual(parseRequestedLayers('weather,nuclear,military,conflicts'), ['weather']);
      assert.deepEqual(parseRequestedLayers('__proto__,constructor'), []);
    });

    it('normalises duplicates and whitespace so the cache key does not fragment', () => {
      assert.deepEqual(
        parseRequestedLayers(' cables , cables,  weather '),
        ['cables', 'weather'],
      );
    });

    it('falls back to every layer when the parameter is absent or blank', () => {
      assert.deepEqual(parseRequestedLayers(null), [...EMBED_LAYER_IDS]);
      assert.deepEqual(parseRequestedLayers(''), [...EMBED_LAYER_IDS]);
      assert.deepEqual(parseRequestedLayers('   '), [...EMBED_LAYER_IDS]);
    });
  });

  describe('composition', () => {
    it('serves every requested layer to any caller at the one cadence', async () => {
      const frame = await composeEmbedMapFrame([...EMBED_LAYER_IDS], sources(), NOW);
      assert.equal(frame.refreshMs, EMBED_REFRESH_MS);
      assert.equal(frame.generatedAt, NOW);
      for (const id of EMBED_LAYER_IDS) {
        assert.equal(frame.layers[id], 'ok', `${id} should be served`);
      }
      assert.deepEqual(frame.data.earthquakes, [{ id: 'q1' }]);
      assert.deepEqual(frame.data.naturalEvents, [{ id: 'n1' }]);
      assert.deepEqual(frame.data.weatherAlerts, [{ id: 'w1' }]);
      assert.equal('tier' in frame, false, 'the frame carries no tier');
    });

    it('reads only the upstreams the requested live layers need', async () => {
      const { calls, sources: counting } = countingSources();
      await composeEmbedMapFrame(['weather', 'cables'], counting, NOW);
      assert.deepEqual(calls, ['listWeatherAlerts']);
    });

    it('answers static layers without an upstream read', async () => {
      const { sources: counting, calls } = countingSources();
      const frame = await composeEmbedMapFrame(['cables', 'pipelines'], counting, NOW);
      assert.deepEqual(frame.layers, { cables: 'ok', pipelines: 'ok' });
      assert.deepEqual(calls, []);
      assert.deepEqual(frame.data, {});
    });
  });

  describe('partial upstream failure', () => {
    it('ships one failed layer as state rather than failing the frame', async () => {
      const frame = await composeEmbedMapFrame(
        ['earthquakes', 'weather'],
        sources({ listWeatherAlerts: async () => { throw new Error('redis down'); } }),
        NOW,
      );
      assert.equal(frame.layers.earthquakes, 'ok');
      assert.equal(frame.layers.weather, 'unavailable');
      assert.deepEqual(frame.data.earthquakes, [{ id: 'q1' }]);
      assert.equal(frame.data.weatherAlerts, undefined);
    });

    it('reports a two-source layer as partial when only one upstream answers', async () => {
      const frame = await composeEmbedMapFrame(
        ['earthquakes'],
        sources({ listNaturalEvents: async () => { throw new Error('seed missing'); } }),
        NOW,
      );
      assert.equal(frame.layers.earthquakes, 'partial');
      assert.deepEqual(frame.data.earthquakes, [{ id: 'q1' }]);
      assert.equal(frame.data.naturalEvents, undefined);
    });

    it('reports a two-source layer as unavailable only when both upstreams fail', async () => {
      const frame = await composeEmbedMapFrame(
        ['earthquakes'],
        sources({
          listEarthquakes: async () => { throw new Error('down'); },
          listNaturalEvents: async () => { throw new Error('down'); },
        }),
        NOW,
      );
      assert.equal(frame.layers.earthquakes, 'unavailable');
      assert.deepEqual(frame.data, {});
    });

    it('still returns a well-formed frame when every upstream fails', async () => {
      const boom = async () => { throw new Error('everything is down'); };
      const frame = await composeEmbedMapFrame(
        ['earthquakes', 'weather'],
        sources({
          listEarthquakes: boom,
          listNaturalEvents: boom,
          listWeatherAlerts: boom,
        }),
        NOW,
      );
      assert.equal(frame.refreshMs, EMBED_REFRESH_MS);
      assert.deepEqual(frame.layers, {
        earthquakes: 'unavailable',
        weather: 'unavailable',
      });
      assert.deepEqual(frame.data, {});
    });
  });

  describe('shared-cache contract', () => {
    const url = (search: string) => `https://www.worldmonitor.app${EMBED_MAP_FRAME_PATH}${search}`;

    it('accepts canonical shapes over any layer and returns their layers', () => {
      assert.deepEqual(
        classifyPublicEmbedFrameRequest(url('?layers=earthquakes,weather&public=1')),
        ['earthquakes', 'weather'],
      );
      assert.deepEqual(
        classifyPublicEmbedFrameRequest(url('?layers=cables,pipelines&public=1')),
        ['cables', 'pipelines'],
      );
    });

    it('bounds the shared key space to the canonical non-empty layer subsets', () => {
      const accepted = new Set<string>();
      const all = [...EMBED_LAYER_IDS];
      for (let mask = 1; mask < (1 << all.length); mask++) {
        const subset = all.filter((_, i) => (mask >> i) & 1);
        const search = buildPublicEmbedFrameSearch(subset);
        assert.ok(classifyPublicEmbedFrameRequest(url(`?${search}`)), `${search} must be cacheable`);
        accepted.add(search);
      }
      assert.equal(accepted.size, (1 << all.length) - 1);
    });

    it('rejects every near-miss rather than widening the key space', () => {
      const rejected = [
        // Reordered — a second spelling of the same set would double the entries.
        '?layers=weather,earthquakes&public=1',
        // Parameter order swapped.
        '?public=1&layers=weather',
        // Percent-encoded separator: a re-serialised URLSearchParams compare
        // would normalise this into the accepted form.
        '?layers=earthquakes%2Cweather&public=1',
        // Duplicated ids and duplicated params.
        '?layers=weather,weather&public=1',
        '?layers=earthquakes&layers=weather&public=1',
        '?layers=weather&public=1&public=1',
        // Unknown layer ids never reach a shared entry.
        '?layers=weather,nuclear&public=1',
        // Extra, empty, and wrong-valued parameters.
        '?layers=weather&public=1&bbox=1,2,3,4',
        '?layers=&public=1',
        '?layers=weather&public=true',
        '?public=1',
        '?layers=weather',
        '',
        // The Vercel filesystem router's `?rpc=` echo does not reach this
        // static route, and if it ever did it must fail toward no-store.
        '?layers=weather&public=1&rpc=map-frame',
      ];
      for (const search of rejected) {
        assert.equal(
          classifyPublicEmbedFrameRequest(url(search)),
          null,
          `${search || '(no query)'} must not be shared-cacheable`,
        );
      }
    });

    it('refuses a non-GET method and a foreign path', () => {
      const good = '?layers=weather&public=1';
      assert.ok(classifyPublicEmbedFrameRequest(url(good), 'HEAD'));
      assert.equal(classifyPublicEmbedFrameRequest(url(good), 'POST'), null);
      assert.equal(
        classifyPublicEmbedFrameRequest(`https://www.worldmonitor.app/api/bootstrap${good}`),
        null,
      );
    });

    it('builds only URLs it will itself accept', () => {
      // Builder and validator are the pairing that keeps an emitted URL and a
      // cacheable URL from drifting apart.
      const search = buildPublicEmbedFrameSearch(['weather', 'earthquakes']);
      assert.equal(search, 'layers=earthquakes,weather&public=1');
      assert.deepEqual(classifyPublicEmbedFrameRequest(url(`?${search}`)), ['earthquakes', 'weather']);
      assert.throws(() => buildPublicEmbedFrameSearch([]));
    });

    it('canonicalises to registry order and drops duplicates', () => {
      assert.deepEqual(
        canonicalizeEmbedLayers(['pipelines', 'weather', 'cables', 'weather', 'earthquakes']),
        ['earthquakes', 'weather', 'cables', 'pipelines'],
      );
    });

    it('never lets a non-public response carry a shared-cacheable directive', () => {
      const uncached = cacheControlForEmbedFrame(false);
      assert.equal(uncached, 'private, no-store');
      for (const directive of ['public', 's-maxage', 'stale-while-revalidate', 'max-age=']) {
        assert.equal(
          uncached.includes(directive),
          false,
          `uncached Cache-Control must not contain ${directive}`,
        );
      }
    });

    it('gives the exact public shape a real shared lifetime', () => {
      const shared = cacheControlForEmbedFrame(true);
      assert.match(shared, /(^|[\s,])public([\s,]|$)/);
      assert.match(shared, new RegExp(`s-maxage=${Math.floor(EMBED_REFRESH_MS / 1000)}\\b`));
      assert.match(shared, /stale-while-revalidate=\d+/);
    });
  });

  describe('edge handler', () => {
    const source = readFileSync(resolve(__dirname, '../api/embed/map-frame.ts'), 'utf-8');

    it('derives Cache-Control from the shared classification alone', () => {
      assert.match(source, /cacheControlForEmbedFrame\(sharedLayers !== null\)/);
      assert.equal(source.includes('s-maxage'), false, 'the literal belongs in the shared helper');
    });

    it('accepts no knob other than layers', () => {
      for (const forbidden of ['sw_lat', 'ne_lat', 'bbox', 'page_size', 'pageSize:', 'start:', 'cursor:']) {
        const uses = source.split('\n').filter(
          (line) => line.includes(forbidden) && line.includes('searchParams'),
        );
        assert.deepEqual(uses, [], `${forbidden} must not be read from the request`);
      }
      // `public` is not read here at all — the shared classifier owns it, so
      // the handler's only direct query read is the layer list.
      const reads = [...source.matchAll(/searchParams\.get\('([^']+)'\)/g)].map((m) => m[1]);
      assert.deepEqual([...new Set(reads)].sort(), ['layers']);
    });

    it('reads no credential at all', () => {
      for (const needle of ['X-WorldMonitor-Grant', 'X-WorldMonitor-Key', 'getCookie', "headers.get('cookie')", 'validateUserApiKey', 'verifyGrant']) {
        assert.equal(source.includes(needle), false, `${needle} must not appear in the embed frame handler`);
      }
    });

    it('serves every layer to a keyless caller, rate limited by IP before any source read', async () => {
      const calls: string[] = [];
      let options: unknown = 'unset';
      const response = await handleEmbedMapFrame(
        new Request('https://www.worldmonitor.app/api/embed/map-frame?layers=earthquakes,weather,cables,pipelines'),
        deps({
          checkRateLimit: async (_req, _path, _cors, opts) => {
            calls.push('limit');
            options = opts;
            return null;
          },
          composeFrame: async (layers) => {
            calls.push('compose');
            return composeEmbedMapFrame(layers, sources(), NOW);
          },
        }),
      );

      assert.equal(response.status, 200);
      assert.deepEqual(calls, ['limit', 'compose']);
      assert.equal(options, undefined);
      const body = await response.json();
      for (const id of EMBED_LAYER_IDS) assert.equal(body.layers[id], 'ok');
      assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    });

    it('shared-caches the canonical public shape', async () => {
      const response = await handleEmbedMapFrame(
        new Request('https://www.worldmonitor.app/api/embed/map-frame?layers=earthquakes,weather,cables,pipelines&public=1'),
        deps(),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('Cache-Control'), cacheControlForEmbedFrame(true));
    });

    it('a rate-limit refusal is returned before any source read', async () => {
      const calls: string[] = [];
      const response = await handleEmbedMapFrame(
        new Request('https://www.worldmonitor.app/api/embed/map-frame?layers=weather&public=1'),
        deps({
          checkRateLimit: async () => {
            calls.push('limit');
            return new Response('', { status: 429 });
          },
          composeFrame: async (layers) => {
            calls.push('compose');
            return composeEmbedMapFrame(layers, sources(), NOW);
          },
        }),
      );
      assert.equal(response.status, 429);
      assert.deepEqual(calls, ['limit']);
    });

    it('refuses the frame in partner mode, where no anonymous read is served', async () => {
      const calls: string[] = [];
      const response = await handleEmbedMapFrame(
        new Request('https://www.worldmonitor.app/api/embed/map-frame?layers=weather&public=1'),
        deps({
          isPartnerMode: () => true,
          checkRateLimit: async () => {
            calls.push('limit');
            return null;
          },
        }),
      );
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'partner_access_required' });
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.deepEqual(calls, []);
    });
  });
});

it('does not publicly cache partial or unavailable requested map layers', async () => {
  for (const state of ['partial', 'unavailable'] as const) {
    const response = await handleEmbedMapFrame(new Request('https://www.worldmonitor.app/api/embed/map-frame?layers=weather&public=1'), deps({
      composeFrame: async () => ({ refreshMs: EMBED_REFRESH_MS, generatedAt: NOW, layers: { weather: state }, data: {} }),
    }));
    assert.match(response.headers.get('Cache-Control') ?? '', /no-store/);
  }
});
