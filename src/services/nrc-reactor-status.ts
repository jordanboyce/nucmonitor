import { createCircuitBreaker } from '@/utils/circuit-breaker';
import { toApiUrl } from '@/services/runtime';
import {
  buildNrcReactorStatusSnapshot,
  parseNrcReactorStatusRows,
  summarizeNrcFleetPower,
  type NrcFleetPowerSummary,
  type NrcReactorStatusRow,
  type NrcReactorStatusSnapshot,
} from '@/shared/nrc-reactor-status';
import { matchNrcUnitName, type UsNuclearFacility, type UsReactorUnit } from '@/config/us-nuclear-facilities';
import { applyShowcaseStatusOverrides, getShowcaseScenario } from '@/services/showcase-scenario';

export type { NrcFleetPowerSummary, NrcReactorStatusRow, NrcReactorStatusSnapshot };

export const NRC_REACTOR_STATUS_PAGE = 'https://www.nrc.gov/reading-rm/doc-collections/event-status/reactor-status/';
export const NRC_EVENT_REPORTS_PAGE = 'https://www.nrc.gov/reading-rm/doc-collections/event-status/event/';

export interface NrcUnitStatus extends NrcReactorStatusRow {
  /** Registry facility the NRC unit label resolved to, when matched. */
  facility?: UsNuclearFacility;
  unitRecord?: UsReactorUnit;
  /** Power reported on the previous report date, if present. */
  previousPower?: number;
  /** Day-over-day change in percentage points. */
  delta?: number;
}

export interface NrcReactorStatusResult {
  fetchedAt: Date;
  reportDate: string;
  units: NrcUnitStatus[];
  summary: NrcFleetPowerSummary;
  /** Full 365-day row set for sparklines and history views. */
  history: NrcReactorStatusRow[];
  /** Unit labels in the NRC file that did not resolve to a registry facility. */
  unmatchedUnits: string[];
  /** Showcase builds: 'overrides' when sample rows were laid over the live file, 'fallback' when the whole file is sample data. */
  sample?: 'overrides' | 'fallback';
}

interface CachedPayload {
  fetchedAt: string;
  rows: NrcReactorStatusRow[];
}

const REQUEST_TIMEOUT_MS = 20_000;

const breaker = createCircuitBreaker<CachedPayload>({
  name: 'NRC Reactor Status',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});

let latestResult: NrcReactorStatusResult | null = null;

export function getLatestNrcReactorStatus(): NrcReactorStatusResult | null {
  return latestResult;
}

export function enrichNrcSnapshot(snapshot: NrcReactorStatusSnapshot, rows: NrcReactorStatusRow[], fetchedAt: Date): NrcReactorStatusResult {
  const unmatched: string[] = [];
  const units: NrcUnitStatus[] = snapshot.units.map((row) => {
    const match = matchNrcUnitName(row.unit);
    if (!match) unmatched.push(row.unit);
    const prev = snapshot.previousByUnit.get(row.unit);
    return {
      ...row,
      facility: match?.facility,
      unitRecord: match?.unit,
      previousPower: prev?.power,
      delta: prev ? Math.round((row.power - prev.power) * 10) / 10 : undefined,
    };
  });
  return {
    fetchedAt,
    reportDate: snapshot.reportDate,
    units,
    summary: summarizeNrcFleetPower(snapshot),
    history: rows,
    unmatchedUnits: unmatched,
  };
}

export async function fetchNrcReactorStatus(): Promise<NrcReactorStatusResult | null> {
  const showcase = getShowcaseScenario();
  let payload: CachedPayload;
  try {
    payload = await breaker.execute(async () => {
      const resp = await fetch(toApiUrl('/api/nrc-reactor-status'), {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`NRC reactor status fetch failed: ${resp.status}`);
      const text = await resp.text();
      const rows = parseNrcReactorStatusRows(text);
      if (rows.length === 0) throw new Error('NRC reactor status file contained no rows');
      return { fetchedAt: new Date().toISOString(), rows };
    }, { fetchedAt: '', rows: [] }, { shouldCache: (p) => p.rows.length > 0 });
  } catch (error) {
    if (!showcase) throw error;
    payload = { fetchedAt: '', rows: [] };
  }

  // Showcase builds lay the scenario's unit rows over the live file, and fall
  // back to a complete sample file when nrc.gov cannot be reached.
  const rows = showcase ? applyShowcaseStatusOverrides(payload.rows, showcase) : payload.rows;
  if (!rows.length) return latestResult;
  const snapshot = buildNrcReactorStatusSnapshot(rows);
  if (!snapshot) return latestResult;
  const fetchedAt = payload.fetchedAt ? new Date(payload.fetchedAt) : new Date();
  latestResult = enrichNrcSnapshot(snapshot, rows, fetchedAt);
  if (showcase) latestResult.sample = payload.rows.length ? 'overrides' : 'fallback';
  return latestResult;
}

export function getNrcReactorStatusBreakerStatus(): string {
  return breaker.getStatus();
}
