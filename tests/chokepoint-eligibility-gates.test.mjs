import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectTrafficAnomaly } from '../shared/chokepoint-traffic-anomaly.js';
import { computeFlowEstimate } from '../scripts/seed-chokepoint-flows.mjs';

// The chokepoint methodology docs, scoring module, status handler and scenario
// engine were removed in the NucMonitor trim. The flow seeder and the shared
// traffic-anomaly detector still ship, so their eligibility gates stay pinned.
describe('chokepoint live-flow and transit-anomaly eligibility gates', () => {
  it('enforces the live-flow and transit-anomaly eligibility gates', () => {
    // Prove the gates by running the real functions rather than grepping for
    // the comparison literals, so a moved or renamed constant cannot break
    // this check without changing behaviour.
    const days = (count, total, startOffset = 0) =>
      Array.from({ length: count }, (_, i) => ({
        date: new Date(Date.now() - (startOffset + i) * 86_400_000).toISOString().slice(0, 10),
        tanker: total,
        capTanker: 0,
        total,
      }));

    // Flow seeder: 40 total days, 20 baseline days, and a thin-baseline floor.
    assert.equal(computeFlowEstimate(days(39, 60), 21), null, '39 days must miss the 40-day gate');
    assert.ok(computeFlowEstimate(days(40, 60), 21), '40 days must clear the gate');
    assert.equal(computeFlowEstimate(days(97, 0), 21), null, 'a zero baseline must miss the thin-baseline floor');

    // Traffic anomaly: 37 days of history and a 14-transit weekly baseline.
    assert.equal(detectTrafficAnomaly(days(36, 100), 'war_zone').signal, false, '36 days must miss the 37-day gate');
    assert.equal(detectTrafficAnomaly(days(37, 1), 'war_zone').dropPct, 0, 'a sub-14 weekly baseline must report no drop');
    assert.ok(detectTrafficAnomaly([...days(7, 0), ...days(30, 100, 7)], 'war_zone').signal, '37 days above the floor must score');
  });
});
