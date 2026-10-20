#!/usr/bin/env node
import { runBundle, MIN, HOUR, DAY } from './_bundle-runner.mjs';

await runBundle('relay-backup', [
  { label: 'Climate-News', script: 'seed-climate-news.mjs', seedMetaKey: 'climate:news-intelligence', canonicalKey: 'climate:news-intelligence:v1', intervalMs: 30 * MIN, timeoutMs: 240_000 },
  { label: 'WB-Indicators', script: 'seed-wb-indicators.mjs', seedMetaKey: 'economic:worldbank-techreadiness:v1', intervalMs: DAY, timeoutMs: 300_000 },
]);
