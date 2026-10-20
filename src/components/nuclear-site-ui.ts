/**
 * Shared UI pieces for the nuclear hub's facility panels: the filter toolbar,
 * the facility detail drawer, and the actions behind them (watchlist, show on
 * map with EPZ rings, CSV export, printable site brief).
 *
 * Every renderer returns an HTML string whose dynamic values are escaped;
 * callers write it through the panel's sanctioned content setters.
 */

import { escapeHtml } from '@/utils/sanitize';
import {
  getNrcRegion,
  NRC_REGION_NAMES,
  nrcDocketUrl,
  US_NUCLEAR_CATEGORY_LABELS,
  US_NUCLEAR_FACILITIES,
  US_NUCLEAR_REGISTRY_SOURCES,
  US_NUCLEAR_STATUS_LABELS,
  type UsNuclearFacility,
  type UsNuclearFacilityCategory,
} from '@/config/us-nuclear-facilities';
import type { FacilityHazardKind } from '@/services/nuclear-facility-hazards';
import {
  buildSiteRiskCsv,
  formatMiles,
  groupReactorPowerByFacility,
  INGESTION_EPZ_MILES,
  PLUME_EPZ_MILES,
  SITE_RISK_STATUS_LABELS,
  type SiteReactorPower,
  type SiteRiskStatus,
  type SiteRiskSummary,
  type SiteRiskZone,
} from '@/services/nuclear-site-risk';
import { buildSiteBriefDocument } from '@/services/nuclear-site-brief';
import { getLatestNrcReactorStatus } from '@/services/nrc-reactor-status';
import { getNuclearWatchlist, toggleNuclearWatchlist } from '@/services/nuclear-watchlist';
import { printReportDocument } from '@/utils/export-report';
import { showToast } from '@/utils/toast';

export const HAZARD_KIND_ICON: Record<FacilityHazardKind, string> = {
  earthquake: '🌐',
  weather: '🌩️',
  storm: '🌀',
  flood: '🌊',
  fire: '🔥',
  radiation: '☢️',
  volcano: '🌋',
  outage: '🔌',
  other: '⚠️',
};

const ZONE_LABEL: Record<SiteRiskZone, string> = {
  plume: `≤${PLUME_EPZ_MILES} mi`,
  ingestion: `≤${INGESTION_EPZ_MILES} mi`,
  regional: 'regional',
};

// ── filters ────────────────────────────────────────────────────────────────

export type SiteStatusFilter = 'all' | 'flagged' | SiteRiskStatus;
export type SiteSort = 'status' | 'name' | 'nearest' | 'state';

export interface SiteFilters {
  category: UsNuclearFacilityCategory | 'all';
  state: string;
  region: 0 | 1 | 2 | 3 | 4;
  status: SiteStatusFilter;
  watchlistOnly: boolean;
  sort: SiteSort;
}

const STATES = [...new Set(US_NUCLEAR_FACILITIES.map((f) => f.state))].sort();
const CATEGORIES = Object.keys(US_NUCLEAR_CATEGORY_LABELS) as UsNuclearFacilityCategory[];

export function matchesSiteFilters(f: UsNuclearFacility, summary: SiteRiskSummary | undefined, filters: SiteFilters, watchlist: Set<string>): boolean {
  if (filters.category !== 'all' && f.category !== filters.category) return false;
  if (filters.state && f.state !== filters.state) return false;
  if (filters.region && getNrcRegion(f.state) !== filters.region) return false;
  if (filters.watchlistOnly && !watchlist.has(f.id)) return false;
  const status = summary?.status ?? 'normal';
  if (filters.status === 'flagged' && status === 'normal') return false;
  if (filters.status !== 'all' && filters.status !== 'flagged' && status !== filters.status) return false;
  return true;
}

const STATUS_RANK: Record<SiteRiskStatus, number> = { normal: 0, watch: 1, warning: 2 };

export function sortSites(items: Array<{ facility: UsNuclearFacility; summary?: SiteRiskSummary }>, sort: SiteSort): void {
  const byName = (a: UsNuclearFacility, b: UsNuclearFacility) => a.name.localeCompare(b.name);
  items.sort((a, b) => {
    switch (sort) {
      case 'name':
        return byName(a.facility, b.facility);
      case 'state':
        return a.facility.state.localeCompare(b.facility.state) || byName(a.facility, b.facility);
      case 'nearest': {
        const da = a.summary?.nearestMi ?? Number.POSITIVE_INFINITY;
        const db = b.summary?.nearestMi ?? Number.POSITIVE_INFINITY;
        return da - db || byName(a.facility, b.facility);
      }
      default:
        return STATUS_RANK[b.summary?.status ?? 'normal'] - STATUS_RANK[a.summary?.status ?? 'normal']
          || (b.summary?.score ?? 0) - (a.summary?.score ?? 0)
          || byName(a.facility, b.facility);
    }
  });
}

function option(value: string, label: string, selected: boolean): string {
  return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

/** Toolbar of selects + toggles; `data-filter` names the field each control drives. */
export function renderSiteFilterToolbar(filters: SiteFilters, opts: { showCategory?: boolean; watchCount: number }): string {
  const category = opts.showCategory === false ? '' : `<select class="nsu-filter" data-filter="category" aria-label="Category">
      ${option('all', 'All categories', filters.category === 'all')}
      ${CATEGORIES.map((c) => option(c, US_NUCLEAR_CATEGORY_LABELS[c], filters.category === c)).join('')}
    </select>`;
  return `<div class="nsu-toolbar">
    ${category}
    <select class="nsu-filter" data-filter="state" aria-label="State">
      ${option('', 'All states', !filters.state)}
      ${STATES.map((s) => option(s, s, filters.state === s)).join('')}
    </select>
    <select class="nsu-filter" data-filter="region" aria-label="NRC region">
      ${option('0', 'All NRC regions', !filters.region)}
      ${([1, 2, 3, 4] as const).map((r) => option(String(r), NRC_REGION_NAMES[r], filters.region === r)).join('')}
    </select>
    <select class="nsu-filter" data-filter="sort" aria-label="Sort">
      ${option('status', 'Sort: hazard status', filters.sort === 'status')}
      ${option('nearest', 'Sort: nearest hazard', filters.sort === 'nearest')}
      ${option('name', 'Sort: name', filters.sort === 'name')}
      ${option('state', 'Sort: state', filters.sort === 'state')}
    </select>
    <button type="button" class="nsu-toggle${filters.watchlistOnly ? ' active' : ''}" data-filter-toggle="watchlistOnly" aria-pressed="${filters.watchlistOnly}">★ My sites <span class="nsu-count">${opts.watchCount}</span></button>
    <button type="button" class="nsu-action nsu-export" data-action="export-csv" title="Download the filtered facility table with hazard status as CSV">⬇ CSV</button>
  </div>`;
}

/**
 * Apply a change event / click from the toolbar to `filters`. Returns true
 * when the filters changed.
 */
export function applyFilterControl(target: HTMLElement, filters: SiteFilters): boolean {
  const toggle = target.closest<HTMLElement>('[data-filter-toggle]');
  if (toggle?.dataset.filterToggle === 'watchlistOnly') {
    filters.watchlistOnly = !filters.watchlistOnly;
    return true;
  }
  if (!(target instanceof HTMLSelectElement) || !target.dataset.filter) return false;
  const value = target.value;
  switch (target.dataset.filter) {
    case 'category': filters.category = value as SiteFilters['category']; return true;
    case 'state': filters.state = value; return true;
    case 'region': filters.region = Number(value) as SiteFilters['region']; return true;
    case 'sort': filters.sort = value as SiteSort; return true;
    default: return false;
  }
}

// ── badges + detail drawer ─────────────────────────────────────────────────

export function renderStatusBadge(status: SiteRiskStatus): string {
  return `<span class="nsu-status nsu-status-${status}">${escapeHtml(SITE_RISK_STATUS_LABELS[status])}</span>`;
}

export function renderWatchStar(id: string, watched: boolean): string {
  return `<button type="button" class="nsu-action nsu-star${watched ? ' active' : ''}" data-action="watch" data-facility="${escapeHtml(id)}" aria-pressed="${watched}" title="${watched ? 'Remove from my sites' : 'Add to my sites'}">${watched ? '★' : '☆'}</button>`;
}

export function getFacilityPower(id: string): SiteReactorPower[] {
  return groupReactorPowerByFacility(getLatestNrcReactorStatus()).get(id) ?? [];
}

function powerClass(power: number): string {
  if (power >= 95) return 'nrs-power-full';
  if (power >= 50) return 'nrs-power-reduced';
  if (power > 0) return 'nrs-power-low';
  return 'nrs-power-off';
}

export function renderFacilityDetail(f: UsNuclearFacility, summary: SiteRiskSummary | undefined, watched: boolean): string {
  const region = getNrcRegion(f.state);
  const units = f.units ?? [];
  const power = getFacilityPower(f.id);
  const unitPower = (name: string) => power.find((p) => p.registryUnit === name);
  const reportDate = power[0]?.reportDate;

  const unitsTable = units.length
    ? `<table class="nfd-units"><thead><tr><th>Unit</th><th>Type</th><th>MWe</th><th>Status</th><th>License</th><th>NRC power${reportDate ? ` (${escapeHtml(reportDate)})` : ''}</th></tr></thead><tbody>
        ${units.map((u) => {
          const p = unitPower(u.name);
          return `<tr>
            <td>${escapeHtml(u.name)}${u.docket ? ` · <a href="${nrcDocketUrl(u.docket)}" target="_blank" rel="noopener">${escapeHtml(u.docket)}</a>` : ''}</td>
            <td>${escapeHtml(u.type)}</td>
            <td>${u.netMwe ?? (u.thermalMw !== undefined ? `${u.thermalMw} MWt` : '—')}</td>
            <td><span class="nfd-unit-status nfd-unit-${escapeHtml(u.status)}">${escapeHtml(u.status)}${u.shutdownYear ? ` ${u.shutdownYear}` : ''}</span></td>
            <td>${u.licenseExpires ?? '—'}</td>
            <td>${p ? `<span class="nrs-power-pill ${powerClass(p.power)}">${p.power}%</span>` : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody></table>`
    : '';

  const signals = summary?.signals ?? [];
  const hazards = signals.length
    ? `<ul class="nfh-signals">${signals.map((s) => `<li class="nfh-signal nfh-signal-${s.severity}">
        <span class="nfh-signal-icon">${HAZARD_KIND_ICON[s.kind]}</span>
        <span class="nfh-signal-text"><span class="nsu-zone nsu-zone-${s.zone}">${escapeHtml(ZONE_LABEL[s.zone])}</span> ${escapeHtml(s.summary)}</span>
        <span class="nfh-signal-meta">${escapeHtml(s.severity)} · ${escapeHtml(s.source)}${s.at ? ` · ${escapeHtml(s.at.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}` : ''}${s.sourceUrl ? ` · <a href="${escapeHtml(s.sourceUrl)}" target="_blank" rel="noopener">source</a>` : ''}</span>
      </li>`).join('')}</ul>`
    : '<p class="nsu-quiet">No public hazard signals near this site right now.</p>';

  const status = summary?.status ?? 'normal';
  return `<div class="nsu-detail">
    <div class="nsu-detail-head">
      ${renderStatusBadge(status)}
      <span class="nsu-reasons">${summary?.reasons.length ? escapeHtml(summary.reasons.join('; ')) : 'Nothing inside the emergency planning zones.'}</span>
    </div>
    ${f.notes ? `<p class="nfd-notes">${escapeHtml(f.notes)}</p>` : ''}
    <div class="nfd-detail-grid">
      <div><span class="nfd-detail-label">Category</span><span>${escapeHtml(US_NUCLEAR_CATEGORY_LABELS[f.category])}</span></div>
      <div><span class="nfd-detail-label">Status</span><span>${escapeHtml(US_NUCLEAR_STATUS_LABELS[f.status])}</span></div>
      <div><span class="nfd-detail-label">Operator</span><span>${escapeHtml(f.operator)}</span></div>
      <div><span class="nfd-detail-label">Regulator</span><span>${escapeHtml(f.regulator)}${region ? ` · NRC ${escapeHtml(NRC_REGION_NAMES[region])}` : ''}</span></div>
      <div><span class="nfd-detail-label">Location</span><span>${escapeHtml(f.city ? `${f.city}, ${f.state}` : f.state)} · ${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}</span></div>
      ${f.docket ? `<div><span class="nfd-detail-label">Docket</span><span><a href="${nrcDocketUrl(f.docket)}" target="_blank" rel="noopener">${escapeHtml(f.docket)}</a></span></div>` : ''}
      ${f.isfsi ? '<div><span class="nfd-detail-label">Spent fuel</span><span>Dry storage (ISFSI) on site</span></div>' : ''}
    </div>
    ${unitsTable}
    <div class="nsu-epz">
      <span><b>${summary?.plume.total ?? 0}</b> within ${PLUME_EPZ_MILES} mi</span>
      <span><b>${(summary?.plume.total ?? 0) + (summary?.ingestion.total ?? 0)}</b> within ${INGESTION_EPZ_MILES} mi</span>
      <span><b>${summary?.regional.total ?? 0}</b> regional</span>
      <span>nearest ${escapeHtml(formatMiles(summary?.nearestMi ?? null))}</span>
    </div>
    ${hazards}
    <div class="nsu-detail-actions">
      <span class="nsu-links">
        ${f.url ? `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">Reference page</a> · ` : ''}<a href="${US_NUCLEAR_REGISTRY_SOURCES.nrcEventReports}" target="_blank" rel="noopener">NRC event reports</a> · <a href="${US_NUCLEAR_REGISTRY_SOURCES.nrcReactorStatus}" target="_blank" rel="noopener">NRC reactor status</a>
      </span>
      <span class="nsu-buttons">
        ${renderWatchStar(f.id, watched)}
        <button type="button" class="nsu-action nfd-locate" data-action="locate" data-facility="${escapeHtml(f.id)}">Show on map + EPZ</button>
        <button type="button" class="nsu-action nfd-locate" data-action="brief" data-facility="${escapeHtml(f.id)}">Print site brief</button>
      </span>
    </div>
  </div>`;
}

// ── actions ────────────────────────────────────────────────────────────────

export type FacilityLocateHandler = (lat: number, lon: number, facilityId?: string) => void;

function downloadText(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportSitesCsv(summaries: SiteRiskSummary[]): void {
  const status = getLatestNrcReactorStatus();
  const csv = buildSiteRiskCsv(summaries, { power: groupReactorPowerByFacility(status) });
  downloadText(csv, `nucmonitor-facilities-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
}

export function printSiteBrief(summary: SiteRiskSummary): void {
  const html = buildSiteBriefDocument(summary, { power: getFacilityPower(summary.facility.id) });
  printReportDocument(html).catch((err) => {
    console.error('[nuclear-site-brief] print failed', err);
    showToast('Could not open the print dialog for this site brief.');
  });
}

export interface SiteActionContext {
  getSummary: (id: string) => SiteRiskSummary | undefined;
  getExportRows: () => SiteRiskSummary[];
  onLocate?: FacilityLocateHandler;
}

/**
 * Handle a click on any `[data-action]` control rendered by this module.
 * Returns true when the click was consumed.
 */
export function handleSiteAction(target: HTMLElement, ctx: SiteActionContext): boolean {
  const el = target.closest<HTMLElement>('[data-action]');
  if (!el) return false;
  const id = el.dataset.facility ?? '';
  switch (el.dataset.action) {
    case 'watch':
      if (id) toggleNuclearWatchlist(id);
      return true;
    case 'locate': {
      const f = US_NUCLEAR_FACILITIES.find((x) => x.id === id);
      if (f) ctx.onLocate?.(f.lat, f.lon, f.id);
      return true;
    }
    case 'brief': {
      const summary = ctx.getSummary(id);
      if (summary) printSiteBrief(summary);
      return true;
    }
    case 'export-csv':
      exportSitesCsv(ctx.getExportRows());
      return true;
    default:
      return false;
  }
}

export function watchlistSnapshot(): Set<string> {
  return getNuclearWatchlist();
}
