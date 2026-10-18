import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { bindActivationKeys } from '@/utils/activation';
import {
  fetchNrcReactorStatus,
  NRC_REACTOR_STATUS_PAGE,
  type NrcReactorStatusResult,
  type NrcUnitStatus,
} from '@/services/nrc-reactor-status';
import { getNrcRegion, NRC_REGION_NAMES } from '@/config/us-nuclear-facilities';
import { unitPowerHistory } from '@/shared/nrc-reactor-status';

type StatusFilter = 'all' | 'reduced' | 'offline' | 'changed';

const FILTER_LABELS: Record<StatusFilter, string> = {
  all: 'All units',
  reduced: 'Reduced power',
  offline: 'Offline',
  changed: 'Changed today',
};

function powerClass(power: number): string {
  if (power >= 100) return 'nrs-power-full';
  if (power <= 0) return 'nrs-power-off';
  if (power < 50) return 'nrs-power-low';
  return 'nrs-power-reduced';
}

function formatDelta(delta: number | undefined): string {
  if (delta === undefined || delta === 0) return '';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta}`;
}

function sparkline(points: Array<{ date: string; power: number }>): string {
  const recent = points.slice(-30);
  if (recent.length < 2) return '';
  const w = 90;
  const h = 18;
  const step = w / (recent.length - 1);
  const path = recent
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - (p.power / 100) * (h - 2) - 1).toFixed(1)}`)
    .join(' ');
  return `<svg class="nrs-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

export class NuclearReactorStatusPanel extends Panel {
  private data: NrcReactorStatusResult | null = null;
  private filter: StatusFilter = 'reduced';
  private expandedUnit: string | null = null;
  private onLocationClick?: (lat: number, lon: number) => void;

  constructor() {
    super({
      id: 'nuclear-reactor-status',
      title: 'NRC Reactor Power Status',
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
      infoTooltip:
        'Daily power level of every operating US commercial reactor as reported to the NRC Operations Center ' +
        '(Power Reactor Status Report). Reasons and change notes are the NRC\'s own text. ' +
        'Updated once per calendar day; the report date is shown in the footer.',
    });
    this.showLoading('Loading NRC power reactor status…');

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const chip = target.closest<HTMLElement>('.nrs-filter');
      if (chip?.dataset.filter) {
        this.filter = chip.dataset.filter as StatusFilter;
        this.render();
        return;
      }
      const locate = target.closest<HTMLElement>('.nrs-locate');
      if (locate) {
        e.stopPropagation();
        const lat = Number(locate.dataset.lat);
        const lon = Number(locate.dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) this.onLocationClick?.(lat, lon);
        return;
      }
      const row = target.closest<HTMLElement>('.nrs-row');
      if (row?.dataset.unit) {
        this.expandedUnit = this.expandedUnit === row.dataset.unit ? null : row.dataset.unit;
        this.render();
      }
    });
    bindActivationKeys(this.content, '.nrs-row');
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }

  public async fetchData(): Promise<void> {
    try {
      const result = await fetchNrcReactorStatus();
      if (!result) {
        this.showError('NRC reactor status unavailable', () => void this.fetchData());
        return;
      }
      this.data = result;
      this.setCount(result.units.length);
      this.render();
    } catch (error) {
      console.warn('[NuclearReactorStatusPanel] fetch failed', error);
      if (!this.data) this.showError('NRC reactor status unavailable', () => void this.fetchData());
    }
  }

  private filteredUnits(): NrcUnitStatus[] {
    if (!this.data) return [];
    const units = this.data.units;
    switch (this.filter) {
      case 'reduced': return units.filter((u) => u.power < 100);
      case 'offline': return units.filter((u) => u.power <= 0);
      case 'changed': return units.filter((u) => (u.delta ?? 0) !== 0 || u.change.length > 0);
      default: return units;
    }
  }

  private render(): void {
    if (!this.data) return;
    const { summary } = this.data;
    const units = this.filteredUnits().sort((a, b) => a.power - b.power || a.unit.localeCompare(b.unit));

    const chips = (Object.keys(FILTER_LABELS) as StatusFilter[]).map((key) => {
      const count = key === 'all' ? this.data!.units.length
        : key === 'reduced' ? summary.reducedPower + summary.offline
          : key === 'offline' ? summary.offline
            : this.data!.units.filter((u) => (u.delta ?? 0) !== 0 || u.change.length > 0).length;
      return `<button type="button" class="nrs-filter${this.filter === key ? ' active' : ''}" data-filter="${key}">${escapeHtml(FILTER_LABELS[key])} <span class="nrs-filter-count">${count}</span></button>`;
    }).join('');

    const rows = units.map((u) => {
      const facility = u.facility;
      const region = facility ? getNrcRegion(facility.state) : undefined;
      const expanded = this.expandedUnit === u.unit;
      const delta = formatDelta(u.delta);
      const meta = facility
        ? `${escapeHtml(facility.state)}${region ? ` · ${escapeHtml(NRC_REGION_NAMES[region])}` : ''}${u.unitRecord?.type ? ` · ${escapeHtml(u.unitRecord.type)}` : ''}${u.unitRecord?.netMwe ? ` · ${u.unitRecord.netMwe} MWe` : ''}`
        : 'Unmatched to registry';
      const detail = expanded
        ? `<tr class="nrs-detail"><td colspan="4">
              <div class="nrs-detail-grid">
                <div><span class="nrs-detail-label">Reason</span><span>${escapeHtml(u.reason || '—')}</span></div>
                <div><span class="nrs-detail-label">Change</span><span>${escapeHtml(u.change || '—')}</span></div>
                <div><span class="nrs-detail-label">Yesterday</span><span>${u.previousPower === undefined ? '—' : `${u.previousPower}%`}</span></div>
                <div><span class="nrs-detail-label">Operator</span><span>${escapeHtml(facility?.operator ?? '—')}</span></div>
                <div><span class="nrs-detail-label">Docket</span><span>${escapeHtml(u.unitRecord?.docket ?? '—')}</span></div>
                <div><span class="nrs-detail-label">License</span><span>${u.unitRecord?.licenseExpires ? `expires ${u.unitRecord.licenseExpires}` : '—'}</span></div>
              </div>
              <div class="nrs-detail-spark">30-day power ${sparkline(unitPowerHistory(this.data!.history, u.unit))}</div>
              ${facility ? `<button type="button" class="nrs-locate" data-lat="${facility.lat}" data-lon="${facility.lon}">Show on map</button>` : ''}
            </td></tr>`
        : '';
      return `
        <tr class="nrs-row${expanded ? ' expanded' : ''}" data-unit="${escapeHtml(u.unit)}" tabindex="0" aria-expanded="${expanded}">
          <td class="nrs-unit"><div class="nrs-unit-name">${escapeHtml(u.unit)}</div><div class="nrs-unit-meta">${meta}</div></td>
          <td class="nrs-power"><span class="nrs-power-pill ${powerClass(u.power)}">${u.power}%</span></td>
          <td class="nrs-delta ${u.delta && u.delta < 0 ? 'down' : u.delta && u.delta > 0 ? 'up' : ''}">${escapeHtml(delta)}</td>
          <td class="nrs-reason">${escapeHtml(u.reason || u.change || '')}</td>
        </tr>${detail}`;
    }).join('');

    const empty = units.length === 0
      ? `<div class="panel-empty">${this.filter === 'all' ? 'No units reported.' : 'Every reported unit is at full power.'}</div>`
      : '';

    const html = `
      <div class="nrs-summary">
        <div class="nrs-card"><span class="nrs-card-label">Units reported</span><span class="nrs-card-value">${summary.unitsReported}</span></div>
        <div class="nrs-card nrs-card-full"><span class="nrs-card-label">At 100%</span><span class="nrs-card-value">${summary.atFullPower}</span></div>
        <div class="nrs-card nrs-card-reduced"><span class="nrs-card-label">Reduced</span><span class="nrs-card-value">${summary.reducedPower}</span></div>
        <div class="nrs-card nrs-card-off"><span class="nrs-card-label">Offline</span><span class="nrs-card-value">${summary.offline}</span></div>
        <div class="nrs-card"><span class="nrs-card-label">Fleet avg</span><span class="nrs-card-value">${summary.averagePower}%</span></div>
        <div class="nrs-card"><span class="nrs-card-label">Changed ≥5 pts</span><span class="nrs-card-value">${summary.changedSinceYesterday}</span></div>
      </div>
      <div class="nrs-filters">${chips}</div>
      ${units.length ? `<table class="nrs-table"><thead><tr><th>Unit</th><th>Power</th><th>Δ</th><th>NRC note</th></tr></thead><tbody>${rows}</tbody></table>` : empty}
      <div class="nrs-footer">
        Report date ${escapeHtml(summary.reportDate)} · Source: <a href="${NRC_REACTOR_STATUS_PAGE}" target="_blank" rel="noopener">NRC Power Reactor Status Reports</a>
        ${this.data.unmatchedUnits.length ? ` · ${this.data.unmatchedUnits.length} unit label${this.data.unmatchedUnits.length === 1 ? '' : 's'} not matched to the registry` : ''}
      </div>
    `;
    this.setSafeContent(unsafeRawHtml(html, 'NuclearReactorStatusPanel render: all dynamic values escaped'));
  }
}
