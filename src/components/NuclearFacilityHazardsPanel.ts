import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { bindActivationKeys } from '@/utils/activation';
import { US_NUCLEAR_CATEGORY_LABELS } from '@/config/us-nuclear-facilities';
import { summarizeFacilityHazards, type FacilityHazardKind } from '@/services/nuclear-facility-hazards';
import {
  INGESTION_EPZ_MILES,
  PLUME_EPZ_MILES,
  summarizeSiteRisk,
  type SiteRiskSummary,
} from '@/services/nuclear-site-risk';
import { nuclearSiteRiskStore, type SiteRiskSnapshot } from '@/services/nuclear-site-risk-store';
import { NUCLEAR_WATCHLIST_CHANGED_EVENT } from '@/services/nuclear-watchlist';
import {
  applyFilterControl,
  HAZARD_KIND_ICON,
  handleSiteAction,
  matchesSiteFilters,
  renderFacilityDetail,
  renderSiteFilterToolbar,
  renderStatusBadge,
  renderWatchStar,
  sortSites,
  watchlistSnapshot,
  type FacilityLocateHandler,
  type SiteFilters,
  type SiteStatusFilter,
} from './nuclear-site-ui';

const STATUS_CHIPS: Array<{ value: SiteStatusFilter; label: string }> = [
  { value: 'flagged', label: 'Flagged' },
  { value: 'warning', label: 'Warning' },
  { value: 'watch', label: 'Watch' },
  { value: 'all', label: 'All sites' },
];

/**
 * All-hazards watch for US nuclear facilities. Reads the shared site-risk
 * store (fed by data-loader from USGS, NWS, NASA FIRMS, EPA RadNet / Safecast,
 * NHC / EONET and internet-outage feeds) and shows each facility's status by
 * emergency planning zone, with a detail drawer, watchlist, CSV export and a
 * printable site brief.
 */
export class NuclearFacilityHazardsPanel extends Panel {
  private snapshot: SiteRiskSnapshot = nuclearSiteRiskStore.getSnapshot();
  private filters: SiteFilters = { category: 'all', state: '', region: 0, status: 'flagged', watchlistOnly: false, sort: 'status' };
  private expandedId: string | null = null;
  private onLocationClick?: FacilityLocateHandler;
  private readonly unsubscribe: () => void;
  private readonly onWatchlistChanged = () => this.render();

  constructor() {
    super({
      id: 'nuclear-hazards',
      title: 'Facility All-Hazards Watch',
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
      infoTooltip:
        'Joins live hazard feeds (USGS earthquakes, NWS alerts, NASA FIRMS fire detections, EPA RadNet / Safecast ' +
        'radiation, NHC and EONET storms, internet outages) to every US nuclear facility and buckets them by the ' +
        `${PLUME_EPZ_MILES}-mile plume and ${INGESTION_EPZ_MILES}-mile ingestion emergency planning zones. ` +
        `Warning: a high/critical signal within ${PLUME_EPZ_MILES} mi, a critical one within ${INGESTION_EPZ_MILES} mi, or ` +
        `elevated radiation within ${INGESTION_EPZ_MILES} mi. Watch: an elevated signal within ${INGESTION_EPZ_MILES} mi, a critical ` +
        `signal regionally, or 3+ signals within ${PLUME_EPZ_MILES} mi. A status is a proximity screen, not a statement ` +
        'about plant condition — confirm with NRC event reports.',
    });
    this.showLoading('Waiting for hazard feeds…');

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const chip = target.closest<HTMLElement>('.nfh-sev-filter');
      if (chip?.dataset.status) {
        this.filters.status = chip.dataset.status as SiteStatusFilter;
        this.render();
        return;
      }
      if (applyFilterControl(target, this.filters)) {
        this.render();
        return;
      }
      if (handleSiteAction(target, {
        getSummary: (id) => this.snapshot.byId.get(id),
        getExportRows: () => this.visible(),
        onLocate: (lat, lon, id) => this.onLocationClick?.(lat, lon, id),
      })) {
        e.stopPropagation();
        return;
      }
      if (target.closest('a') || target.closest('select')) return;
      const row = target.closest<HTMLElement>('.nfh-row');
      if (row?.dataset.facility) {
        this.expandedId = this.expandedId === row.dataset.facility ? null : row.dataset.facility;
        this.render();
      }
    });
    this.content.addEventListener('change', (e) => {
      if (applyFilterControl(e.target as HTMLElement, this.filters)) this.render();
    });
    bindActivationKeys(this.content, '.nfh-row');

    this.unsubscribe = nuclearSiteRiskStore.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.render();
    });
    window.addEventListener(NUCLEAR_WATCHLIST_CHANGED_EVENT, this.onWatchlistChanged);
    if (this.snapshot.ready) this.render();
  }

  public setLocationClickHandler(handler: FacilityLocateHandler): void {
    this.onLocationClick = handler;
  }

  /** Current per-site summaries (all facilities, ranked). */
  public getSummaries(): SiteRiskSummary[] {
    return this.snapshot.summaries;
  }

  public override destroy(): void {
    this.unsubscribe();
    window.removeEventListener(NUCLEAR_WATCHLIST_CHANGED_EVENT, this.onWatchlistChanged);
    super.destroy();
  }

  private visible(): SiteRiskSummary[] {
    const watchlist = watchlistSnapshot();
    const items = this.snapshot.summaries
      .filter((s) => matchesSiteFilters(s.facility, s, this.filters, watchlist))
      .map((s) => ({ facility: s.facility, summary: s }));
    sortSites(items, this.filters.sort);
    return items.map((i) => i.summary);
  }

  private render(): void {
    if (!this.snapshot.ready) return;
    const { summaries, reports } = this.snapshot;
    const totals = summarizeSiteRisk(summaries);
    const kinds = summarizeFacilityHazards(reports).byKind;
    const watchlist = watchlistSnapshot();
    const watchedFlagged = summaries.filter((s) => watchlist.has(s.facility.id) && s.status !== 'normal').length;
    const visible = this.visible();

    this.setCount(totals.warning + totals.watch);
    this.setSeverity(totals.warning ? 'high' : totals.watch ? 'medium' : 'none');

    const chipCount = (value: SiteStatusFilter) => summaries.filter((s) =>
      matchesSiteFilters(s.facility, s, { ...this.filters, status: value }, watchlist)).length;
    const chips = STATUS_CHIPS.map((c) =>
      `<button type="button" class="nfh-sev-filter nfh-sev-${c.value}${this.filters.status === c.value ? ' active' : ''}" data-status="${c.value}">${escapeHtml(c.label)} <span class="nfh-chip-count">${chipCount(c.value)}</span></button>`,
    ).join('');

    const kindTotals = (Object.keys(kinds) as FacilityHazardKind[])
      .filter((k) => kinds[k] > 0)
      .map((k) => `<span class="nfh-kind">${HAZARD_KIND_ICON[k]} ${escapeHtml(k)} <b>${kinds[k]}</b></span>`)
      .join('');

    const rows = visible.map((s) => {
      const f = s.facility;
      const expanded = this.expandedId === f.id;
      const top = s.signals[0];
      const within50 = s.plume.total + s.ingestion.total;
      const detail = expanded
        ? `<tr class="nfh-detail"><td colspan="5">${renderFacilityDetail(f, s, watchlist.has(f.id))}</td></tr>`
        : '';
      return `
        <tr class="nfh-row nfh-row-${s.status}${expanded ? ' expanded' : ''}" data-facility="${escapeHtml(f.id)}" tabindex="0" aria-expanded="${expanded}">
          <td class="nsu-star-cell">${renderWatchStar(f.id, watchlist.has(f.id))}</td>
          <td class="nfh-facility"><div class="nfh-facility-name">${escapeHtml(f.name)}</div><div class="nfh-facility-meta">${escapeHtml(f.state)} · ${escapeHtml(US_NUCLEAR_CATEGORY_LABELS[f.category])}</div></td>
          <td class="nfh-severity">${renderStatusBadge(s.status)}</td>
          <td class="nsu-epz-cell" title="Signals within ${PLUME_EPZ_MILES} mi / within ${INGESTION_EPZ_MILES} mi"><b>${s.plume.total}</b> / ${within50}</td>
          <td class="nfh-top">${top ? `${HAZARD_KIND_ICON[top.kind]} ${escapeHtml(top.summary)}` : '<span class="nsu-quiet">—</span>'}</td>
        </tr>${detail}`;
    }).join('');

    const emptyText = this.filters.watchlistOnly && watchlist.size === 0
      ? 'Your site list is empty — star facilities to add them.'
      : this.filters.status === 'flagged'
        ? 'No facility has a hazard signal at Watch or Warning level right now.'
        : 'No facilities match these filters.';
    const body = visible.length
      ? `<table class="nfh-table"><thead><tr><th aria-label="My sites"></th><th>Facility</th><th>Status</th><th title="Signals within ${PLUME_EPZ_MILES} mi / ${INGESTION_EPZ_MILES} mi">${PLUME_EPZ_MILES} / ${INGESTION_EPZ_MILES} mi</th><th>Leading signal</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="panel-empty">${escapeHtml(emptyText)}</div>`;

    const html = `
      <div class="nfh-summary">
        <div class="nfh-card nfh-card-critical"><span class="nfh-card-label">Warning</span><span class="nfh-card-value">${totals.warning}</span></div>
        <div class="nfh-card nfh-card-high"><span class="nfh-card-label">Watch</span><span class="nfh-card-value">${totals.watch}</span></div>
        <div class="nfh-card"><span class="nfh-card-label">Sites with signals</span><span class="nfh-card-value">${totals.withSignals}</span></div>
        <div class="nfh-card"><span class="nfh-card-label">My sites flagged</span><span class="nfh-card-value">${watchedFlagged}<span class="nsu-of"> / ${watchlist.size}</span></span></div>
      </div>
      <div class="nfh-kinds">${kindTotals || '<span class="nfh-kind nfh-kind-none">No active signals</span>'}</div>
      <div class="nfh-filters">${chips}</div>
      ${renderSiteFilterToolbar(this.filters, { watchCount: watchlist.size })}
      ${body}
      <div class="nfh-footer">Feeds: USGS · NWS · NASA FIRMS · EPA RadNet / Safecast · NHC / EONET · internet outage monitors${this.snapshot.computedAt ? ` · updated ${escapeHtml(this.snapshot.computedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}` : ''}. Proximity only — confirm with <a href="https://www.nrc.gov/reading-rm/doc-collections/event-status/event/" target="_blank" rel="noopener">NRC Event Notification Reports</a>.</div>
    `;
    this.setSafeContent(unsafeRawHtml(html, 'NuclearFacilityHazardsPanel render: all dynamic values escaped'));
  }
}
