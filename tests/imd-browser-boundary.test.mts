import assert from 'node:assert/strict';
import { afterEach, before, beforeEach, test } from 'node:test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { IMD_BULLETIN_PRODUCT_IDS, IMD_PRODUCTS, assembleImdSnapshot, parseImdBulletinHtml } from '../scripts/lib/imd-cyclone-marine.mjs';

let source: string;
let app: typeof import('../src/services/imd-cyclone-marine') & { bootstrap: typeof import('../src/services/bootstrap').__testing__ };
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let now = Date.parse('2026-09-15T12:00:00Z');
const event = { id: 'imd-test', title: 'Storm', category: 'severeStorms', categoryTitle: 'Cyclone', lat: 15, lon: 80, date: now, closed: false };
const alert = { id: 'port-test', event: 'IMD Port Warning', severity: 'Severe', headline: 'Port warning', description: 'Warning', areaDesc: 'Port', onset: now, expires: now + 3600000, coordinates: [[80, 15]], source: 'IMD' };
const snapshot = () => ({ generatedAt: now, coverageState: 'ok', cycloneEvents: [event], portAlerts: [alert], marineBulletins: [], sourceName: 'IMD', sourceUrl: 'https://rsmcnewdelhi.imd.gov.in' });
before(async () => {
  const result = await build({ stdin: { contents: "export * from './src/services/imd-cyclone-marine.ts'; export { __testing__ as bootstrap } from './src/services/bootstrap.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', define: { 'import.meta.env': '{"DEV":false}' } });
  source = result.outputFiles[0].text;
});
beforeEach(async () => {
  app = await import(`data:text/javascript;base64,${Buffer.from(source + `\n// ${Math.random()}`).toString('base64')}`);
  now = Date.parse('2026-09-15T12:00:00Z');
  Date.now = () => now;
});
afterEach(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });
