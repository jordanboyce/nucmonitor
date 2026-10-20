/**
 * Power Grid Alerts panel: the four views render from one envelope, the
 * alert-kind filter narrows the feed, a map click focuses a region, and an
 * unpublished snapshot shows the not-published state instead of an empty panel.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestI18n, tt } from './helpers/i18n.mts';
import { EMPTY_GRID_ALERTS, type GridAlertsEnvelope, type GridRegion } from '@/services/grid-alerts';

const fetchGridAlerts = vi.fn<() => Promise<GridAlertsEnvelope>>();
vi.mock('@/services/grid-alerts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/grid-alerts')>();
  return { ...actual, fetchGridAlerts: (...args: []) => fetchGridAlerts(...args) };
});

const { GridAlertsPanel, GRID_FOCUS_REGION_EVENT } = await import('@/components/GridAlertsPanel');

function region(partial: Partial<GridRegion> & Pick<GridRegion, 'id' | 'name'>): GridRegion {
  return {
    kind: 'ba', operator: null, interconnection: 'eastern', states: ['TX'], centroid: [-99, 31],
    status: 'unknown', statusText: 'No data', statusUpdatedAt: null,
    metrics: { demandMw: null, demandAt: null, forecastMw: null, peakForecastMw: null, capacityMw: null, netGenerationMw: null, interchangeMw: null, prcMw: null, reservePct: null, demandVsForecastPct: null, demandHistory: [] },
    hazards: { alertCount: 0, categories: {}, topEvent: null },
    space: { gicExposure: 'low', gNow: 0 },
    impact: { score: 0, band: 'low', drivers: [] },
    dataSources: [],
    ...partial,
  };
}

const ENVELOPE: GridAlertsEnvelope = {
  ...EMPTY_GRID_ALERTS,
  generatedAt: new Date(Date.now() - 120_000).toISOString(),
  summary: { ...EMPTY_GRID_ALERTS.summary, overall: 'critical', regionsAssessed: 2, regionsStressed: 1, alertCount: 3, emergencyCount: 1, weatherAlertCount: 1, weatherAlertTotal: 1, worstRegionId: 'ERCO', worstScore: 82, gNow: 3, gForecastMax: 4, kp: 6.7, sourcesOk: 7, sourcesTotal: 8 },
  regions: [
    region({ id: 'ERCO', name: 'ERCOT (Texas)', kind: 'iso', operator: 'ercot', interconnection: 'ercot', status: 'eea1', statusText: 'Energy Emergency Alert 1',
      metrics: { demandMw: 68200, demandAt: '2026-10-20 20:00', forecastMw: 66000, peakForecastMw: 69800, capacityMw: 70100, netGenerationMw: 68250, interchangeMw: 50, prcMw: 2250, reservePct: null, demandVsForecastPct: 103.3, demandHistory: [] },
      hazards: { alertCount: 1, categories: { winter: 32 }, topEvent: 'Ice Storm Warning' },
      impact: { score: 82, band: 'critical', drivers: ['Operator state: Energy Emergency Alert 1', 'Ice Storm Warning (Severe) in footprint'] } }),
    region({ id: 'BPAT', name: 'Bonneville Power Administration', states: ['WA', 'OR'], centroid: [-120.5, 46.3], interconnection: 'western', space: { gicExposure: 'high', gNow: 3 }, impact: { score: 10, band: 'low', drivers: ['G3 geomagnetic storm with high GIC exposure'] } }),
  ],
  alerts: [
    { id: 'op-ERCO-eea1', source: 'erco', kind: 'operator', level: 'emergency', title: 'ERCO: Energy Emergency Alert 1', detail: 'Reserves low', regionIds: ['ERCO'], issuedAt: new Date().toISOString(), expires: null },
    { id: 'nws-1', source: 'nws', kind: 'weather', level: 'warning', title: 'Ice Storm Warning for North Texas', detail: 'Line and tower icing', event: 'Ice Storm Warning', category: 'winter', areaDesc: 'Dallas; Tarrant', regionIds: ['ERCO'], issuedAt: new Date().toISOString(), expires: null, centroid: [-96.5, 32.5], url: 'https://api.weather.gov/alerts/x' },
    { id: 'swpc-g-now-3', source: 'swpc', kind: 'space', level: 'warning', title: 'Geomagnetic storm in progress: G3 (strong)', detail: 'GIC risk', regionIds: ['BPAT'], issuedAt: new Date().toISOString(), expires: null },
  ],
  impacts: [],
  space: { current: { date: '2026-10-20', g: 3, gText: 'strong', s: 0, r: 0, rMinorProb: null, rMajorProb: null }, forecast: [{ date: '2026-10-21', g: 4, gText: 'severe', s: 0, r: 0, rMinorProb: null, rMajorProb: null }], kp: 6.7, kpAt: null, exposure: [{ regionId: 'BPAT', exposure: 'high', points: 25 }, { regionId: 'ERCO', exposure: 'low', points: 3 }] },
  sources: [{ id: 'ercot', label: 'ERCOT', url: null, ok: true, fetchedAt: new Date().toISOString(), latencyMs: 10 }, { id: 'eia930', label: 'EIA', url: null, ok: false, fetchedAt: new Date().toISOString(), latencyMs: 0, error: 'EIA_API_KEY not configured' }],
  attribution: { notice: 'Heuristic scores.', sources: [] },
};

let panel: InstanceType<typeof GridAlertsPanel>;
const CONTENT_DEBOUNCE_MS = 150;
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CONTENT_DEBOUNCE_MS + 1);
}
async function mount(): Promise<void> {
  panel = new GridAlertsPanel();
  document.body.appendChild(panel.getElement());
  // panel-layout calls this after mounting; the constructor's fetch waits for it.
  panel.notifyConnected();
  await flush();
  await flush();
}
const el = (): HTMLElement => panel.getElement();
const text = (selector: string): string[] => Array.from(el().querySelectorAll<HTMLElement>(selector)).map((n) => n.textContent?.trim() ?? '');

beforeAll(async () => {
  await initTestI18n();
  expect(tt('components.gridAlerts.views.hazards')).toBe('Hazard impact');
});

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
  fetchGridAlerts.mockReset();
  fetchGridAlerts.mockResolvedValue(ENVELOPE);
});

afterEach(() => {
  panel?.destroy();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('GridAlertsPanel', () => {
  it('renders the summary strip and the alerts feed by default', async () => {
    await mount();
    expect(fetchGridAlerts).toHaveBeenCalledTimes(1);
    expect(el().querySelector('.ga-chip-critical')?.textContent).toBe('Critical');
    expect(text('.ga-alert .intel-item-title')).toHaveLength(3);
    expect(el().querySelector('.ga-alert a')?.getAttribute('href')).toBe('https://api.weather.gov/alerts/x');
    expect(text('.ga-source.failed')).toEqual(['○ eia930']);
  });

  it('filters the feed by alert kind', async () => {
    await mount();
    el().querySelector<HTMLElement>('.ga-filter[data-kind="space"]')!.click();
    await flush();
    expect(text('.ga-alert .intel-item-title').join(' ')).toContain('Geomagnetic storm in progress');
    expect(text('.ga-alert')).toHaveLength(1);
  });

  it('switches to the regions board and expands drivers on click', async () => {
    await mount();
    el().querySelector<HTMLElement>('.panel-tab[data-view="regions"]')!.click();
    await flush();
    expect(panel.getView()).toBe('regions');
    const rows = text('.ga-region-name strong');
    expect(rows).toEqual(['ERCO', 'BPAT']);
    expect(text('.ga-status')[0]).toBe('EEA 1');
    el().querySelector<HTMLElement>('[data-region-id="ERCO"] .ga-region-row')!.click();
    await flush();
    expect(text('[data-region-id="ERCO"] .ga-drivers li')).toEqual(['Operator state: Energy Emergency Alert 1', 'Ice Storm Warning (Severe) in footprint']);
    expect(text('[data-region-id="ERCO"] .ga-metric-value')).toContain('69.8 GW');
  });

  it('renders the hazard matrix only for regions carrying hazards or stress', async () => {
    await mount();
    panel.setView('hazards');
    await flush();
    expect(text('.ga-matrix-region')).toEqual(['ERCO']);
    expect(text('.ga-matrix-cell')).toEqual(['32']);
    expect(el().querySelector('.ga-matrix-score')?.textContent).toBe('82');
  });

  it('renders the space weather ladder', async () => {
    await mount();
    panel.setView('space');
    await flush();
    expect(text('.ga-space-now .ga-g')).toEqual(['G3']);
    expect(text('.ga-space-day .ga-g')).toEqual(['G4']);
    expect(text('.ga-exposure-regions')).toEqual(['BPAT', '—', 'ERCO']);
  });

  it('focuses a region when the map layer dispatches the focus event', async () => {
    await mount();
    window.dispatchEvent(new CustomEvent(GRID_FOCUS_REGION_EVENT, { detail: { regionId: 'BPAT' } }));
    await flush();
    expect(panel.getView()).toBe('regions');
    const focused = el().querySelector('.ga-region.focused');
    expect(focused?.getAttribute('data-region-id')).toBe('BPAT');
    expect(text('[data-region-id="BPAT"] .ga-drivers li')).toEqual(['G3 geomagnetic storm with high GIC exposure']);
  });

  it('shows the not-published state when the envelope is empty', async () => {
    fetchGridAlerts.mockResolvedValue(EMPTY_GRID_ALERTS);
    await mount();
    expect(el().textContent).toContain(tt('components.gridAlerts.notPublished'));
    expect(el().querySelector('.ga-summary')).toBeNull();
  });
});
