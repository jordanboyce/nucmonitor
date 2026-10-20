import { strict as assert } from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
  getLayerExplanation,
  hasCuratedLayerExplanation,
  LAYER_EXPLANATIONS,
  LAYER_REGISTRY,
  V1_LAYER_EXPLANATION_KEYS,
} from '../src/config/map-layer-definitions';
import { renderLayerExplanationCard } from '../src/utils/layer-explanation-card';

const root = resolve(import.meta.dirname, '..');
const relaySource = readFileSync(resolve(root, 'scripts/ais-relay.cjs'), 'utf8');
const healthSource = readFileSync(resolve(root, 'api/health.js'), 'utf8');

function evalNumberExpression(expression: string): number {
  const cleaned = expression.replace(/_/g, '');
  assert.match(cleaned, /^[0-9\s()+*/.-]+$/, `unsafe numeric expression: ${expression}`);
  const value = Function(`"use strict"; return (${cleaned});`)();
  assert.equal(typeof value, 'number', `expression did not evaluate to a number: ${expression}`);
  assert.ok(Number.isFinite(value), `expression did not evaluate to a finite number: ${expression}`);
  return value;
}

function readSource(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function constNumber(path: string, name: string): number {
  const source = readSource(path);
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]+);`));
  assert.ok(match, `${path} must define ${name}`);
  return evalNumberExpression(match[1]);
}

function relayConstMinutes(name: string): number {
  const match = relaySource.match(new RegExp(`const\\s+${name}\\s*=\\s*([^;\\n]+);`));
  assert.ok(match, `scripts/ais-relay.cjs must define ${name}`);
  return evalNumberExpression(match[1]) / 60_000;
}

function maxStaleMin(path: string, seedDomain: string): number {
  const source = readSource(path);
  const match = source.match(new RegExp(`runSeed\\(\\s*['"][^'"]+['"]\\s*,\\s*['"]${seedDomain}['"][\\s\\S]*?maxStaleMin:\\s*([^,\\n}]+)`));
  assert.ok(match, `${path} must pass maxStaleMin for ${seedDomain}`);
  return evalNumberExpression(match[1]);
}

function healthMaxStale(entry: string): number {
  const match = healthSource.match(new RegExp(`${entry}:\\s*\\{[^}]*maxStaleMin:\\s*([^,}\\n]+)`));
  assert.ok(match, `api/health.js must declare SEED_META.${entry}.maxStaleMin`);
  return evalNumberExpression(match[1]);
}

function renderedFreshnessText(layerKey: keyof typeof LAYER_REGISTRY): string {
  const html = renderLayerExplanationCard('Layer', getLayerExplanation(layerKey));
  const match = html.match(/<span>Freshness<\/span>\s*<p>([\s\S]*?)<\/p>/);
  assert.ok(match, `${layerKey} card must render a Freshness section`);
  return match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function durationMinutes(text: string, pattern: RegExp): number {
  const match = text.match(pattern);
  assert.ok(match, `duration pattern ${pattern} did not match: ${text}`);
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('second')) return amount / 60;
  if (unit.startsWith('minute')) return amount;
  if (unit.startsWith('hour')) return amount * 60;
  if (unit.startsWith('day')) return amount * 24 * 60;
  throw new Error(`Unsupported duration unit: ${unit}`);
}

function assertDuration(text: string, pattern: RegExp, expectedMinutes: number, label: string): void {
  assert.equal(
    durationMinutes(text, pattern),
    expectedMinutes,
    `${label} must match authoritative freshness/cadence source`,
  );
}

describe('layer explanation metadata', () => {
  test('v1 high-adoption layers have curated structured cards', () => {
    const expected = new Set([
      'natural',
      'weather',
      'usNuclearFacilities',
    ]);

    assert.deepEqual(new Set(V1_LAYER_EXPLANATION_KEYS), expected);

    for (const key of V1_LAYER_EXPLANATION_KEYS) {
      assert.ok(LAYER_REGISTRY[key], `${key} must be a registered layer`);
      assert.equal(hasCuratedLayerExplanation(key), true, `${key} must have curated metadata`);

      const explanation = getLayerExplanation(key);
      assert.equal(explanation.coverage, 'curated', `${key} must not use fallback metadata`);
      assert.equal(explanation.key, key);
      assert.ok(explanation.category.trim(), `${key} category is required`);
      assert.ok(explanation.purpose.trim(), `${key} purpose is required`);
      assert.ok(explanation.source.trim(), `${key} source/provider text is required`);
      assert.ok(explanation.freshness.trim(), `${key} freshness text is required`);
      assert.ok(explanation.confidence.trim(), `${key} confidence text is required`);
      assert.ok(explanation.limitations.length > 0, `${key} limitations are required`);
      assert.ok(explanation.related.length > 0, `${key} related panels/actions are required`);
      assert.ok(explanation.evidence.length > 0, `${key} evidence paths are required`);

      for (const evidencePath of explanation.evidence) {
        assert.equal(
          existsSync(resolve(root, evidencePath)),
          true,
          `${key} evidence path does not exist: ${evidencePath}`,
        );
      }
    }
  });

  test('unsupported layers degrade to fallback metadata without fabricating freshness', () => {
    const explanation = getLayerExplanation('dayNight');

    assert.equal(explanation.coverage, 'fallback');
    assert.equal(explanation.key, 'dayNight');
    assert.equal(hasCuratedLayerExplanation('dayNight'), false);
    assert.match(explanation.source, /Not curated/i);
    assert.match(explanation.freshness, /No layer-level freshness contract/i);
    assert.match(explanation.confidence, /Unknown/i);
    assert.deepEqual(explanation.evidence, []);
  });

  test('curated freshness text is a data contract against seeder and runtime cadence sources', () => {
    const naturalCadenceMin = maxStaleMin('scripts/seed-natural-events.mjs', 'events') / 3;
    const naturalTtlMin = constNumber('scripts/seed-natural-events.mjs', 'CACHE_TTL') / 60;
    assert.equal(naturalTtlMin, naturalCadenceMin * 6, 'natural TTL must keep the documented 6x cadence buffer');
    assertDuration(renderedFreshnessText('natural'), /every\s+([0-9]+)\s+(hour)s?/i, naturalCadenceMin, 'natural event seed cadence');

    assertDuration(renderedFreshnessText('weather'), /every\s+([0-9]+)\s+(minute)s?/i, relayConstMinutes('WEATHER_SEED_INTERVAL_MS'), 'weather relay seed cadence');
    assertDuration(renderedFreshnessText('weather'), /([0-9]+)-\s*(minute)\s+freshness budget/i, healthMaxStale('weatherAlerts'), 'weather health freshness budget');


    // The facility registry is static: its card must say so rather than claim a
    // live seed cadence the registry does not have.
    const facilities = renderedFreshnessText('usNuclearFacilities');
    assert.match(facilities, /Static registry/i);
    assert.doesNotMatch(facilities, /every\s+[0-9]+\s+(second|minute|hour)/i);
  });

  test('freshness contract assertions fail on stale copied cadence values', () => {
    const staleNaturalText = renderedFreshnessText('natural').replace('3 hours', '12 hours');

    assert.throws(
      () => assertDuration(staleNaturalText, /every\s+([0-9]+)\s+(hour)s?/i, maxStaleMin('scripts/seed-natural-events.mjs', 'events') / 3, 'natural event seed cadence'),
      /natural event seed cadence must match authoritative freshness\/cadence source/,
    );
  });


  test('weather explanation discloses NWS, ECCC, and WMO SWIC coverage', () => {
    const weather = getLayerExplanation('weather');

    assert.equal(LAYER_REGISTRY.weather.fallbackLabel, 'Severe Weather Alerts (NWS, ECCC, WMO SWIC)');
    assert.match(weather.source, /National Weather Service \(NWS\)/i);
    assert.match(weather.source, /Environment and Climate Change Canada \(ECCC\)/i);
    assert.match(weather.source, /WMO Severe Weather Information Centre \(SWIC\)/i);
    assert.ok(
      weather.limitations.some(limitation => /country-level points/i.test(limitation)),
      'weather limitations must say SWIC geocoded alerts render as country-level points',
    );
    assert.ok(
      !weather.limitations.some(limitation => /outside the United States and Canada/i.test(limitation)),
      'weather limitations must not still claim coverage is US + Canada only',
    );
    for (const path of ['scripts/ais-relay.cjs', 'scripts/_weather-alert-select.mjs', 'api/health.js', 'src/services/weather.ts']) {
      assert.ok(weather.evidence.includes(path), `weather evidence must cite ${path}`);
    }
  });

  test('curated explanations are not accidentally added outside the declared v1 set', () => {
    const declared = new Set<string>(V1_LAYER_EXPLANATION_KEYS);
    const curated = Object.entries(LAYER_EXPLANATIONS)
      .filter(([, explanation]) => explanation?.coverage === 'curated')
      .map(([key]) => key);

    assert.deepEqual(new Set(curated), declared);
  });
});

describe('map layer explanation control wiring', () => {
  const componentSources = new Map([
    ['SVG map', readFileSync(resolve(root, 'src/components/Map.ts'), 'utf8')],
    ['DeckGL map', readFileSync(resolve(root, 'src/components/DeckGLMap.ts'), 'utf8')],
    ['Globe map', readFileSync(resolve(root, 'src/components/GlobeMap.ts'), 'utf8')],
  ]);
  const rendererSource = readFileSync(resolve(root, 'src/utils/layer-explanation-card.ts'), 'utf8');

  test('layer pickers render an explanation button for each layer row', () => {
    for (const [name, source] of componentSources) {
      assert.match(source, /layer-toggle-row/, `${name} must keep the layer and explanation controls grouped`);
      assert.match(source, /layer-explain-btn/, `${name} must render explanation buttons`);
      assert.match(source, /aria-label/, `${name} explanation buttons must be screen-reader labeled`);
      assert.match(source, /hasCuratedLayerExplanation/, `${name} must distinguish curated coverage`);
    }
  });

  test('info button opens the structured explanation card without toggling the layer', () => {
    for (const [name, source] of componentSources) {
      assert.match(source, /event\.preventDefault\(\)/, `${name} must not submit or trigger parent controls`);
      assert.match(source, /event\.stopPropagation\(\)/, `${name} must not toggle the layer when opening help`);
      assert.match(source, /this\.showLayerExplanation\(layer\)/, `${name} must open the explanation card`);
      assert.match(source, /getLayerExplanation\(layer\)/, `${name} must use the shared explanation catalog`);
      assert.match(source, /renderLayerExplanationCard/, `${name} must use the shared explanation renderer`);
    }
  });

  test('explanation card exposes source, freshness, confidence, limitations, and related sections', () => {
    for (const label of ['Source', 'Freshness', 'Confidence', 'Limitations', 'Related']) {
      assert.match(rendererSource, new RegExp(`>${label}<`), `missing shared card section: ${label}`);
    }
  });

  test('DeckGL help and explanation popups dismiss each other', () => {
    const source = componentSources.get('DeckGL map');
    assert.ok(source);
    assert.match(source, /querySelector\('\.layer-help-popup'\)\?\.remove\(\)/);
    assert.match(source, /querySelector\('\.layer-explanation-popup'\)\?\.remove\(\)/);
  });

  test('SVG map clears stale outside-click listeners when explanation popups close or switch', () => {
    const source = componentSources.get('SVG map');
    assert.ok(source);
    assert.match(source, /layerExplanationOutsideClickHandler/);
    assert.match(source, /clearLayerExplanationOutsideClickHandler\(\)/);
    assert.match(source, /document\.removeEventListener\('click', this\.layerExplanationOutsideClickHandler\)/);
  });

});
