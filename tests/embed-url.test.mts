import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEmbedIframeSnippet,
  buildEmbedMapUrl,
  buildEmbedPanelUrl,
  createBlankMapLayers,
  EMBEDDABLE_LAYERS,
  embedLayerIdsFromMapLayers,
  parseEmbedParams,
} from '../src/embed/embed-url';
import { EMBED_LAYER_IDS } from '../shared/embed-panels';

describe('embed URL contract', () => {
  it('maps every layer the shared allowlist names', () => {
    // The edge validates requested layers against EMBED_LAYER_IDS; an id it
    // accepts but this table omits would reach the browser and render nothing.
    assert.deepEqual(
      EMBEDDABLE_LAYERS.map((layer) => layer.id),
      [...EMBED_LAYER_IDS],
    );
  });

  it('defaults to a small public map-layer set', () => {
    const parsed = parseEmbedParams('');
    assert.deepEqual(parsed.layerIds, ['earthquakes', 'weather']);
    assert.equal(parsed.layers.natural, true);
    assert.equal(parsed.layers.weather, true);
    assert.equal(parsed.layers.cables, false);
    assert.equal(parsed.layers.pipelines, false);
    assert.equal(parsed.panel, 'map');
    assert.equal(parsed.variant, 'nuclear');
  });

  it('accepts the map panel and keeps unknown ids from rendering', () => {
    assert.equal(parseEmbedParams('?panel=map').panel, 'map');
    assert.equal(parseEmbedParams('?panel=fear-greed').panel, null);
    assert.equal(parseEmbedParams('?panel=x-feed').panel, null);
  });

  it('never treats a query-string key as an embedding credential', () => {
    const parsed = parseEmbedParams('?panel=map&key=wm_0123456789abcdef0123456789abcdef01234567');
    assert.equal(parsed.panel, 'map');
    assert.equal(Object.hasOwn(parsed, 'key'), false);
  });

  it('accepts live and static map layers while mapping earthquakes to the natural map layer', () => {
    const parsed = parseEmbedParams('?layers=earthquakes,weather,cables,pipelines');
    assert.deepEqual(parsed.layerIds, ['earthquakes', 'weather', 'cables', 'pipelines']);
    assert.equal(parsed.layers.natural, true);
    assert.equal(parsed.layers.weather, true);
    assert.equal(parsed.layers.cables, true);
    assert.equal(parsed.layers.pipelines, true);
  });

  it('keeps aliases as inputs but emits canonical layer ids', () => {
    const parsed = parseEmbedParams('?layers=natural,earthquake,weather');
    assert.deepEqual(parsed.layerIds, ['earthquakes', 'weather']);
  });

  it('drops retired, premium and authenticated layers from public embeds', () => {
    const parsed = parseEmbedParams('?layers=ais,flights,military,conflicts,protests,webcams,nuclear,weather');
    assert.deepEqual(parsed.layerIds, ['weather']);
  });

  it('validates and clamps center, zoom, theme, and variant', () => {
    const parsed = parseEmbedParams('?layers=none&center=140,-240&zoom=99&theme=light&variant=nuclear');
    assert.deepEqual(parsed.layerIds, []);
    assert.deepEqual(parsed.center, { lat: 90, lon: -180 });
    assert.equal(parsed.zoom, 10);
    assert.equal(parsed.theme, 'light');
    assert.equal(parsed.variant, 'nuclear');

    const fallback = parseEmbedParams('?center=not,a-number&zoom=Infinity&theme=system&variant=admin');
    // Deleted site variants are rejected like any other unknown value.
    for (const gone of ['full', 'tech', 'finance', 'commodity', 'energy', 'happy']) {
      assert.equal(parseEmbedParams(`?variant=${gone}`).variant, 'nuclear', `${gone} must fall back to nuclear`);
    }
    assert.deepEqual(fallback.center, { lat: 20, lon: 0 });
    assert.equal(fallback.zoom, 1);
    assert.equal(fallback.theme, 'dark');
    assert.equal(fallback.variant, 'nuclear');
  });

  it('builds a narrow embed URL with no main-app state params', () => {
    const layers = createBlankMapLayers();
    layers.cables = true;
    layers.nuclear = true;
    layers.weather = true;
    const url = buildEmbedMapUrl('https://www.worldmonitor.app/embed?country=US&expanded=true', {
      layers,
      center: { lat: 25.12345, lon: 55.98765 },
      zoom: 4.567,
      theme: 'light',
      variant: 'nuclear',
    });
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/embed');
    assert.equal(parsed.searchParams.get('layers'), 'weather,cables');
    assert.equal(parsed.searchParams.get('center'), '25.123,55.988');
    assert.equal(parsed.searchParams.get('zoom'), '4.57');
    assert.equal(parsed.searchParams.get('theme'), 'light');
    assert.equal(parsed.searchParams.get('variant'), 'nuclear');
    for (const forbidden of ['lat', 'lon', 'view', 'timeRange', 'country', 'expanded']) {
      assert.equal(parsed.searchParams.has(forbidden), false, `${forbidden} must not be in the public embed contract`);
    }
  });

  it('derives only public embed layer ids from a full map layer object', () => {
    const layers = createBlankMapLayers();
    layers.weather = true;
    layers.pipelines = true;
    layers.nuclear = true;
    layers.datacenters = true;
    assert.deepEqual(embedLayerIdsFromMapLayers(layers), ['weather', 'pipelines']);
  });

  it('escapes iframe snippet attributes', () => {
    const snippet = buildEmbedIframeSnippet('https://www.worldmonitor.app/embed?layers=weather&x="><script>');
    assert.ok(snippet.includes('title="NucMonitor live map"'));
    assert.ok(snippet.includes('loading="lazy"'));
    assert.ok(snippet.includes('referrerpolicy="strict-origin-when-cross-origin"'));
    assert.ok(snippet.includes('&quot;&gt;&lt;script&gt;'));
    assert.ok(!snippet.includes('"><script>'));
  });

  it('builds panel URLs without putting any key in the iframe URL', () => {
    const url = buildEmbedPanelUrl('https://www.worldmonitor.app/embed', {
      panel: 'map',
      theme: 'light',
    });
    const parsed = new URL(url);
    // The map is the default panel, so its URL carries no panel parameter.
    assert.equal(parsed.searchParams.has('panel'), false);
    assert.equal(parsed.searchParams.get('theme'), 'light');
    assert.equal(parsed.searchParams.has('key'), false);
  });
});
