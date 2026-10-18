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
  const payload = await breaker.execute(async () => {
    const resp = await fetch(toApiUrl('/api/nrc-reactor-status'), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`NRC reactor status fetch failed: ${resp.status}`);
    const text = await resp.text();
    const rows = parseNrcReactorStatusRows(text);
    if (rows.length === 0) throw new Error('NRC reactor status file contained no rows');
    return { fetchedAt: new Date().toISOString(), rows };
  }, { fetchedAt: '', rows: [] }, { shouldCache: (p) => p.rows.length > 0 });

  if (!payload.rows.length) return latestResult;
  const snapshot = buildNrcReactorStatusSnapshot(payload.rows);
  if (!snapshot) return latestResult;
  const fetchedAt = payload.fetchedAt ? new Date(payload.fetchedAt) : new Date();
  latestResult = enrichNrcSnapshot(snapshot, payload.rows, fetchedAt);
  return latestResult;
}

export function getNrcReactorStatusBreakerStatus(): string {
  return breaker.getStatus();
}
