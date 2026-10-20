import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EMBED_PANEL_ID,
  EMBED_FREE_REFRESH_MS,
  EMBED_KEYED_REFRESH_MS,
  EMBED_KEY_RPC_PATHS,
  EMBED_LAYER_IDS,
  EMBED_PANEL_IDS,
  getEmbedPanelAccess,
  getEmbedPanelFreeTier,
  isEmbedLayerId,
  listEmbeddablePanels,
  parseEmbedPanelId,
} from '../shared/embed-panels';

describe('embed panel allowlist', () => {
  it('offers exactly the live map', () => {
    assert.deepEqual([...EMBED_PANEL_IDS], ['map']);
    assert.equal(DEFAULT_EMBED_PANEL_ID, 'map');
  });

  it('gives the map a free tier', () => {
    assert.equal(getEmbedPanelAccess('map').kind, 'tiered');
  });

  it('derives the gateway embed-key surface from the paid panels themselves', () => {
    // EMBED_KEY_RPC_PATHS is what server/gateway.ts will accept a wme_ key on.
    // Deriving it from the registry means the surface cannot grow without a
    // panel owning the path; asserting the exact set means it cannot grow
    // silently either.
    assert.deepEqual([...EMBED_KEY_RPC_PATHS].sort(), []);

    // A tiered panel declares none: it polls the composed /api/embed/map-frame,
    // which authenticates a wmg_ grant rather than a key.
    for (const panel of listEmbeddablePanels()) {
      if (panel.access.kind !== 'paid-only') continue;
      assert.ok(panel.access.rpcPaths.length > 0, `${panel.id} must declare its RPC paths`);
      for (const path of panel.access.rpcPaths) {
        assert.ok(path.startsWith('/api/'), `${path} is not an API path`);
        assert.ok(EMBED_KEY_RPC_PATHS.has(path));
      }
    }
  });

  it("publishes the map's free tier as two layers refreshed hourly", () => {
    const free = getEmbedPanelFreeTier('map');
    assert.ok(free, 'map must expose a free tier');
    assert.deepEqual([...free.layers], ['earthquakes', 'weather']);
    assert.equal(free.refreshMs, EMBED_FREE_REFRESH_MS);
    assert.equal(EMBED_FREE_REFRESH_MS, 60 * 60 * 1000);
    assert.equal(EMBED_KEYED_REFRESH_MS, 10 * 60 * 1000);
  });

  it('draws every free-tier layer from the shared layer allowlist', () => {
    for (const panel of listEmbeddablePanels()) {
      const free = getEmbedPanelFreeTier(panel.id);
      if (!free) continue;
      for (const layer of free.layers) {
        assert.ok(isEmbedLayerId(layer), `${layer} is not an embeddable layer`);
      }
    }
  });

  it('allowlists exactly the four embeddable layers', () => {
    assert.deepEqual([...EMBED_LAYER_IDS], ['earthquakes', 'weather', 'cables', 'pipelines']);
    assert.equal(isEmbedLayerId('cables'), true);
    assert.equal(isEmbedLayerId('conflicts'), false);
    assert.equal(isEmbedLayerId('nuclear'), false);
    assert.equal(isEmbedLayerId('__proto__'), false);
  });

  it('parses canonical ids and aliases, and rejects unknown panels', () => {
    assert.equal(parseEmbedPanelId(null), 'map');
    assert.equal(parseEmbedPanelId(''), 'map');
    assert.equal(parseEmbedPanelId('live-map'), 'map');
    assert.equal(parseEmbedPanelId('Chokepoints'), null);
    assert.equal(parseEmbedPanelId('fear_greed'), null);
    assert.equal(parseEmbedPanelId('x-feed'), null);
    assert.equal(parseEmbedPanelId('intel'), null);
  });

  it('does not allowlist an X / tweet-body panel', () => {
    const ids = listEmbeddablePanels().map((panel) => panel.id);
    assert.equal(ids.some((id) => /x-|twitter|tweet/.test(id)), false);
  });
});
