#!/usr/bin/env node

// Power grid alerts envelope: one snapshot that wraps every public grid-alert
// channel WorldMonitor can reach — ISO/RTO operating conditions (ERCOT, CAISO,
// SPP), real-time load and forecasts (MISO, NYISO, EIA-930 for every major
// balancing authority), grid-relevant National Weather Service hazard alerts
// mapped onto operator footprints, and NOAA SWPC geomagnetic storm state —
// then scores how the live hazards are likely to affect each region.
//
// Railway service config (set up manually via Railway dashboard or `railway service`):
//   - Service name: seed-grid-alerts
//   - Builder: NIXPACKS (root Dockerfile not used for this seed)
//   - rootDirectory: scripts
//   - startCommand: node seed-grid-alerts.mjs
//   - Cron schedule: "*/10 * * * *" (every 10min UTC)
//
// Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN (required);
//      EIA_API_KEY (optional — without it the EIA-930 demand section is marked
//      unavailable and the envelope still publishes from the other sources).
//
// Every adapter is isolated: a failing upstream is recorded in `sources[]`
// and the rest of the envelope still publishes. Only an all-sources failure
// is a fetch failure, and that path preserves the last-good snapshot.

import { loadEnvFile, markPreservableFetchFailure, runSeed } from './_seed-utils.mjs';
import { getOptionalUpstashCreds, upstashCommand } from './_upstash-rest.mjs';
import { buildGridAlertsEnvelope, gridAlertsRecordCount, validateGridAlerts } from './lib/grid-alerts/index.mjs';

loadEnvFile(import.meta.url);

export const GRID_ALERTS_CANONICAL_KEY = 'energy:grid-alerts:v1';
export const GRID_ALERTS_SEED_META_KEY = 'seed-meta:energy:grid-alerts';
export const GRID_ALERTS_ACTIVATION_KEY = 'seed-activated:energy:grid-alerts';
// 10-minute cadence; the TTL outlives three missed ticks so a short Railway
// outage serves last-good rather than an empty panel.
export const GRID_ALERTS_CACHE_TTL_SECONDS = 45 * 60;
export const GRID_ALERTS_MAX_STALE_MIN = 30;

async function markActivated() {
  try {
    const creds = getOptionalUpstashCreds();
    if (!creds) return;
    await upstashCommand(creds, ['SET', GRID_ALERTS_ACTIVATION_KEY, '1']);
  } catch (err) {
    console.warn(`  WARN: grid-alerts activation marker write failed: ${err?.message || err}`);
  }
}

export async function fetchGridAlerts() {
  try {
    return await buildGridAlertsEnvelope({ log: (msg) => console.log(msg) });
  } catch (err) {
    if (err?.allSourcesFailed) markPreservableFetchFailure(err);
    throw err;
  }
}

export const seedOptions = {
  validateFn: validateGridAlerts,
  ttlSeconds: GRID_ALERTS_CACHE_TTL_SECONDS,
  sourceVersion: 'grid-alerts-envelope-v1',
  declareRecords: gridAlertsRecordCount,
  schemaVersion: 1,
  maxStaleMin: GRID_ALERTS_MAX_STALE_MIN,
  emptyDataIsFailure: true,
  allowPreservedFetchFailure: true,
  afterPublish: markActivated,
};

if (process.argv[1]?.endsWith('seed-grid-alerts.mjs')) {
  runSeed('energy', 'grid-alerts', GRID_ALERTS_CANONICAL_KEY, fetchGridAlerts, seedOptions).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
