import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildNrcReactorStatusSnapshot,
  normalizeNrcReportDate,
  parseNrcReactorStatus,
  parseNrcReactorStatusRows,
  summarizeNrcFleetPower,
  unitPowerHistory,
} from '../src/shared/nrc-reactor-status.ts';
import { looksLikeReactorStatusFile } from '../api/nrc-reactor-status.js';

// Shape of the NRC bulk file: header row, pipe-delimited, one row per unit
// per calendar day, newest and oldest days interleaved in no particular order.
const FIXTURE = [
  'ReportDt|Unit|Power|Reason|Change|',
  '10/17/2026 12:00:00 AM|Browns Ferry 1|100|||',
  '10/17/2026 12:00:00 AM|Browns Ferry 2|0|Refueling outage|Reduced from 100% to 0% on 10/16/2026|',
  '10/17/2026 12:00:00 AM|Saint Lucie 1|65|Condenser tube leak repair||',
  '10/17/2026 12:00:00 AM|Columbia Generating Station|100|||',
  '10/16/2026 12:00:00 AM|Browns Ferry 1|100|||',
  '10/16/2026 12:00:00 AM|Browns Ferry 2|100|||',
  '10/16/2026 12:00:00 AM|Saint Lucie 1|100|||',
  '10/16/2026 12:00:00 AM|Columbia Generating Station|98|||',
  '10/15/2026 12:00:00 AM|Browns Ferry 2|100|||',
  '',
].join('\r\n');

describe('nrc reactor status parser', () => {
  it('normalizes US and ISO report dates', () => {
    assert.equal(normalizeNrcReportDate('10/7/2026 12:00:00 AM'), '2026-10-07');
    assert.equal(normalizeNrcReportDate('2026-10-07'), '2026-10-07');
    assert.equal(normalizeNrcReportDate(''), null);
    assert.equal(normalizeNrcReportDate('not a date'), null);
  });

  it('parses rows by header name and clamps power to 0..100', () => {
    const rows = parseNrcReactorStatusRows(FIXTURE);
    assert.equal(rows.length, 9);
    const bf2 = rows.find((r) => r.unit === 'Browns Ferry 2' && r.reportDate === '2026-10-17');
    assert.ok(bf2);
    assert.equal(bf2.power, 0);
    assert.equal(bf2.reason, 'Refueling outage');
    assert.match(bf2.change, /Reduced from 100%/);
    const clamped = parseNrcReactorStatusRows('ReportDt|Unit|Power\n2026-01-01|Unit X|140\n2026-01-01|Unit Y|-5\n');
    assert.deepEqual(clamped.map((r) => r.power), [100, 0]);
  });

  it('tolerates reordered columns and ignores unknown ones', () => {
    const rows = parseNrcReactorStatusRows('Extra|Power|Unit|ReportDt\nx|75|Perry 1|2026-02-02\n');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.unit, 'Perry 1');
    assert.equal(rows[0]!.power, 75);
    assert.equal(rows[0]!.reason, '');
  });

  it('rejects a file without the required columns', () => {
    assert.throws(() => parseNrcReactorStatusRows('Date|Name|Level\n1|2|3\n'), /missing the "reportdt" column/);
    assert.equal(looksLikeReactorStatusFile(FIXTURE), true);
    assert.equal(looksLikeReactorStatusFile('<html>blocked</html>'), false);
  });

  it('builds a latest-day snapshot with previous-day lookups', () => {
    const snapshot = parseNrcReactorStatus(FIXTURE);
    assert.ok(snapshot);
    assert.equal(snapshot.reportDate, '2026-10-17');
    assert.deepEqual(snapshot.reportDates, ['2026-10-17', '2026-10-16', '2026-10-15']);
    assert.equal(snapshot.units.length, 4);
    assert.equal(snapshot.previousByUnit.get('Columbia Generating Station')?.power, 98);
    assert.equal(buildNrcReactorStatusSnapshot([]), null);
  });

  it('summarizes fleet power and day-over-day changes', () => {
    const snapshot = parseNrcReactorStatus(FIXTURE)!;
    const summary = summarizeNrcFleetPower(snapshot);
    assert.equal(summary.unitsReported, 4);
    assert.equal(summary.atFullPower, 2);
    assert.equal(summary.reducedPower, 1);
    assert.equal(summary.offline, 1);
    assert.equal(summary.averagePower, 66.3);
    // Browns Ferry 2 (100 -> 0) and Saint Lucie 1 (100 -> 65) moved >= 5 pts; Columbia moved 2.
    assert.equal(summary.changedSinceYesterday, 2);
  });

  it('returns per-unit history oldest first', () => {
    const rows = parseNrcReactorStatusRows(FIXTURE);
    assert.deepEqual(unitPowerHistory(rows, 'Browns Ferry 2'), [
      { date: '2026-10-15', power: 100 },
      { date: '2026-10-16', power: 100 },
      { date: '2026-10-17', power: 0 },
    ]);
  });
});
