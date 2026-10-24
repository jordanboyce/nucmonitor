import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('embed entry boundary', () => {
  it('never waits for an embedding credential', () => {
    const source = readFileSync(resolve(root, 'src/embed-main.ts'), 'utf-8');
    assert.ok(!source.includes('waitForEmbeddingApiKey'), 'embeds are keyless');
    assert.ok(source.includes('await initI18n()'), 'boot must await initI18n()');
  });

  it('reaches the network only through the single composed map-frame endpoint', () => {
    const loaderSource = readFileSync(resolve(root, 'src/embed/embed-data-loader.ts'), 'utf-8');
    assert.ok(loaderSource.includes('fetchEmbedMapFrame'), 'embed loader should read the composed map frame');
    assert.ok(loaderSource.includes('this.map.setEarthquakes'), 'the earthquakes layer should push events into the map');
    assert.ok(loaderSource.includes('this.map.setWeatherAlerts'), 'the weather layer should push alerts into the map');

    // The composed endpoint is the embed's ONE network path. A per-layer fetch
    // reintroduced here would reopen the anonymous RPC surface.
    for (const forbidden of [
      'ConflictServiceClient',
      'listAcledEvents',
      'fetchEarthquakes',
      'fetchNaturalEvents',
      'fetchProtestEvents',
      'fetchWeatherAlerts',
      '/api/bootstrap',
      'globalThis.fetch',
    ]) {
      assert.ok(
        !loaderSource.includes(forbidden),
        `embed loader must not fetch layers directly (found ${forbidden})`,
      );
    }
    assert.ok(!loaderSource.includes('@/services/conflict'), 'embed loader must not import the full conflict service because it pulls runtime app helpers');
  });

  it('renders the attribution link before the data loader starts', () => {
    const mapPanel = readFileSync(resolve(root, 'src/embed/panels/map.ts'), 'utf-8');
    const attributionIdx = mapPanel.indexOf('buildWorldMonitorAttributionUrl');
    const loaderIdx = mapPanel.indexOf('new EmbedDataLoader');
    assert.ok(attributionIdx !== -1, 'the map panel must render an attribution link');
    assert.ok(attributionIdx < loaderIdx, 'attribution is appended before the first data poll');
  });

  it('sends no credential on a data poll', () => {
    const fetchSource = readFileSync(resolve(root, 'src/embed/embed-fetch.ts'), 'utf-8');
    const frameFn = fetchSource.slice(fetchSource.indexOf('export async function fetchEmbedMapFrame'));
    assert.ok(!frameFn.includes('X-WorldMonitor-Grant'), 'map-frame polls carry no grant');
    assert.ok(!frameFn.includes('X-WorldMonitor-Key'), 'map-frame polls carry no key');
    assert.ok(frameFn.includes("credentials: 'omit'"), 'map-frame polls omit cookies');
  });

  it('keeps the shared SVG map independent of runtime/auth imports used by the app shell', () => {
    const source = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');
    assert.ok(!source.includes("@/services/runtime"), 'Map.ts must not import services/runtime because the public embed imports Map.ts');
    assert.ok(!source.includes("@/services/auth-state"), 'Map.ts must not import auth-state because the public embed imports Map.ts');
    assert.ok(!source.includes("@/services/clerk"), 'Map.ts must not import Clerk because the public embed imports Map.ts');
  });
});
