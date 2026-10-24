import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EMBED_PANEL_ID,
  EMBED_LAYER_IDS,
  EMBED_PANEL_IDS,
  EMBED_REFRESH_MS,
  getEmbedPanelPolicy,
  isEmbedLayerId,
  listEmbeddablePanels,
  parseEmbedPanelId,
} from '../shared/embed-panels';

describe('embed panel allowlist', () => {
  it('offers exactly the live map', () => {
    assert.deepEqual([...EMBED_PANEL_IDS], ['map']);
    assert.equal(DEFAULT_EMBED_PANEL_ID, 'map');
  });

  it('serves every layer to every embed at one ten-minute cadence', () => {
    const policy = getEmbedPanelPolicy('map');
    assert.deepEqual([...policy.layers], [...EMBED_LAYER_IDS]);
    assert.equal(policy.refreshMs, EMBED_REFRESH_MS);
    assert.equal(EMBED_REFRESH_MS, 10 * 60 * 1000);
  });

  it('draws every policy layer from the shared layer allowlist', () => {
    for (const panel of listEmbeddablePanels()) {
      for (const layer of getEmbedPanelPolicy(panel.id).layers) {
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
