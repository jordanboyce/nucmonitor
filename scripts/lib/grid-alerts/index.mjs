// Orchestrator: runs every adapter concurrently, tolerates individual failures
// and assembles the envelope. The seeder (scripts/seed-grid-alerts.mjs) and the
// tests both call `buildGridAlertsEnvelope`.

import { ADAPTERS, createFetchDeps } from './adapters.mjs';
import { assessGrid } from './assess.mjs';

export { GRID_REGIONS } from './regions.mjs';
export * from './adapters.mjs';
export * from './assess.mjs';

/**
 * @param {object} [options]
 * @param {ReturnType<typeof createFetchDeps>} [options.deps]
 * @param {string[]} [options.only] adapter ids to run (tests, dry runs)
 * @param {string} [options.eiaApiKey]
 * @param {(msg: string) => void} [options.log]
 */
export async function buildGridAlertsEnvelope({ deps = createFetchDeps(), only, eiaApiKey = process.env.EIA_API_KEY, log = () => {} } = {}) {
  const ids = Object.keys(ADAPTERS).filter((id) => !only || only.includes(id));
  const results = await Promise.all(ids.map((id) => {
    const run = ADAPTERS[id];
    return (id === 'eia930' ? run(deps, { apiKey: eiaApiKey }) : run(deps)).catch((err) => ({
      source: { id, label: id, url: null, ok: false, fetchedAt: new Date().toISOString(), latencyMs: 0, error: String(err?.message ?? err).slice(0, 200) },
    }));
  }));

  const sources = [];
  const operators = [];
  let eia = null;
  let weatherAlerts = [];
  let weatherAlertTotal;
  let space = null;
  for (const r of results) {
    sources.push(r.source);
    log(`[grid-alerts] ${r.source.id}: ${r.source.ok ? 'ok' : `FAILED ${r.source.error}`} (${r.source.latencyMs}ms)`);
    if (!r.source.ok) continue;
    if (r.eia) eia = r.eia;
    if (r.operator) operators.push(r.operator);
    if (r.weatherAlerts) { weatherAlerts = r.weatherAlerts; weatherAlertTotal = r.weatherAlertTotal; }
    if (r.space) space = r.space;
  }
  if (!sources.some((s) => s.ok)) {
    const err = new Error(`grid-alerts: every source failed (${sources.map((s) => `${s.id}: ${s.error}`).join('; ')})`);
    err.allSourcesFailed = true;
    throw err;
  }
  return assessGrid({ eia, operators, weatherAlerts, weatherAlertTotal, space, sources, nowMs: deps.now() });
}
