/**
 * Parser for the NRC Power Reactor Status Report bulk file
 * (PowerReactorStatusForLast365Days.txt). The file is pipe-delimited with a
 * header row; each subsequent row is one unit's reported power level for one
 * report date (the NRC publishes one snapshot per calendar day, typically by
 * mid-morning Eastern). Columns the parser relies on:
 *
 *   ReportDt | Unit | Power | Reason | Change | ...
 *
 * Extra trailing columns are ignored, and column order is taken from the
 * header so a reordering upstream does not silently shift values.
 *
 * Pure module shared by the browser service, the API proxy tests, and node
 * tests. No DOM, no network.
 */

export interface NrcReactorStatusRow {
  /** ISO calendar date (YYYY-MM-DD) of the report. */
  reportDate: string;
  /** NRC unit label, e.g. "Browns Ferry 1". */
  unit: string;
  /** Reported reactor power in percent (0-100). */
  power: number;
  /** Free-text reason for reduced power, when the NRC provides one. */
  reason: string;
  /** Free-text change-since-yesterday note, when the NRC provides one. */
  change: string;
}

export interface NrcReactorStatusSnapshot {
  /** Latest report date present in the file. */
  reportDate: string;
  /** All rows for the latest report date, one per unit. */
  units: NrcReactorStatusRow[];
  /** Rows for the previous report date keyed by unit, for day-over-day deltas. */
  previousByUnit: Map<string, NrcReactorStatusRow>;
  /** Every distinct report date in the file, newest first. */
  reportDates: string[];
}

const REQUIRED_COLUMNS = ['reportdt', 'unit', 'power'] as const;

function normalizeHeader(cell: string): string {
  return cell.trim().toLowerCase().replace(/[^a-z]/g, '');
}

/** Accepts "10/17/2026 12:00:00 AM", "2026-10-17", or "10/17/2026". */
export function normalizeNrcReportDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    const [, m, d, y] = us;
    return `${y}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function parseNrcReactorStatusRows(text: string): NrcReactorStatusRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return [];

  const header = (lines[0] ?? '').split('|').map(normalizeHeader);
  const col = (name: string): number => header.indexOf(name);
  const idx = {
    reportDate: col('reportdt'),
    unit: col('unit'),
    power: col('power'),
    reason: col('reason'),
    change: col('change'),
  };
  for (const required of REQUIRED_COLUMNS) {
    if (col(required) === -1) {
      throw new Error(`NRC reactor status file is missing the "${required}" column`);
    }
  }

  const rows: NrcReactorStatusRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = (lines[i] ?? '').split('|');
    const reportDate = normalizeNrcReportDate(cells[idx.reportDate] ?? '');
    const unit = (cells[idx.unit] ?? '').trim();
    const powerRaw = (cells[idx.power] ?? '').trim();
    if (!reportDate || !unit || powerRaw === '') continue;
    const power = Number(powerRaw);
    if (!Number.isFinite(power)) continue;
    rows.push({
      reportDate,
      unit,
      power: Math.max(0, Math.min(100, power)),
      reason: idx.reason >= 0 ? (cells[idx.reason] ?? '').trim() : '',
      change: idx.change >= 0 ? (cells[idx.change] ?? '').trim() : '',
    });
  }
  return rows;
}

export function buildNrcReactorStatusSnapshot(rows: NrcReactorStatusRow[]): NrcReactorStatusSnapshot | null {
  if (rows.length === 0) return null;
  const reportDates = [...new Set(rows.map((r) => r.reportDate))].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const latest = reportDates[0];
  const previous = reportDates[1];
  if (!latest) return null;

  const units = rows
    .filter((r) => r.reportDate === latest)
    .sort((a, b) => a.unit.localeCompare(b.unit));
  const previousByUnit = new Map<string, NrcReactorStatusRow>();
  if (previous) {
    for (const row of rows) {
      if (row.reportDate === previous) previousByUnit.set(row.unit, row);
    }
  }
  return { reportDate: latest, units, previousByUnit, reportDates };
}

export function parseNrcReactorStatus(text: string): NrcReactorStatusSnapshot | null {
  return buildNrcReactorStatusSnapshot(parseNrcReactorStatusRows(text));
}

export interface NrcFleetPowerSummary {
  reportDate: string;
  unitsReported: number;
  atFullPower: number;
  reducedPower: number;
  offline: number;
  /** Mean of reported power across all units, in percent. */
  averagePower: number;
  /** Units whose power moved by at least 5 points since the previous report. */
  changedSinceYesterday: number;
}

export function summarizeNrcFleetPower(snapshot: NrcReactorStatusSnapshot): NrcFleetPowerSummary {
  let atFullPower = 0;
  let reducedPower = 0;
  let offline = 0;
  let total = 0;
  let changed = 0;
  for (const row of snapshot.units) {
    total += row.power;
    if (row.power >= 100) atFullPower += 1;
    else if (row.power <= 0) offline += 1;
    else reducedPower += 1;
    const prev = snapshot.previousByUnit.get(row.unit);
    if (prev && Math.abs(prev.power - row.power) >= 5) changed += 1;
  }
  const n = snapshot.units.length;
  return {
    reportDate: snapshot.reportDate,
    unitsReported: n,
    atFullPower,
    reducedPower,
    offline,
    averagePower: n > 0 ? Math.round((total / n) * 10) / 10 : 0,
    changedSinceYesterday: changed,
  };
}

/** Build a 365-day power history for one unit, oldest first. */
export function unitPowerHistory(rows: NrcReactorStatusRow[], unit: string): Array<{ date: string; power: number }> {
  return rows
    .filter((r) => r.unit === unit)
    .map((r) => ({ date: r.reportDate, power: r.power }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
