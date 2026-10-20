import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { bindActivationKeys } from '@/utils/activation';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import {
  summarizeUsNuclearFleet,
  US_NUCLEAR_FACILITIES,
  US_NUCLEAR_REGISTRY_AS_OF,
  US_NUCLEAR_REGISTRY_SOURCES,
  US_NUCLEAR_STATUS_LABELS,
  type UsNuclearFacility,
  type UsNuclearFacilityCategory,
} from '@/config/us-nuclear-facilities';
import { nuclearSiteRiskStore, type SiteRiskSnapshot } from '@/services/nuclear-site-risk-store';
import type { SiteRiskSummary } from '@/services/nuclear-site-risk';
import { NUCLEAR_WATCHLIST_CHANGED_EVENT } from '@/services/nuclear-watchlist';
import {
  applyFilterControl,
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
} from './nuclear-site-ui';

type CategoryFilter = UsNuclearFacilityCategory | 'all';

const CATEGORY_ORDER: CategoryFilter[] = [
  'all', 'power-reactor', 'restart', 'new-build', 'decommissioning', 'fuel-cycle', 'doe-site', 'research-reactor', 'uranium-recovery', 'waste',
];

const CATEGORY_SHORT: Record<CategoryFilter, string> = {
  all: 'All',
  'power-reactor': 'Power reactors',
  restart: 'Restarts',
  'new-build': 'New build',
  decommissioning: 'Decommissioning',
  'fuel-cycle': 'Fuel cycle',
  'doe-site': 'DOE / NNSA',
  'research-reactor': 'Research reactors',
  'uranium-recovery': 'Uranium recovery',
  waste: 'Waste & storage',
};

function matchesQuery(f: UsNuclearFacility, q: string): boolean {
  if (!q) return true;
  const hay = [
    f.name, f.state, f.city ?? '', f.operator, f.category, f.status, f.docket ?? '',
    ...(f.units ?? []).flatMap((u) => [u.name, u.docket ?? '', u.type]),
  ].join(' ').toLowerCase();
  return q.split(/\s+/).every((term) => hay.includes(term));
}

function unitsSummary(f: UsNuclearFacility): string {
  const units = f.units ?? [];
  if (units.length === 0) return '';
  const active = units.filter((u) => u.status === 'operating' || u.status === 'restarting' || u.status === 'construction' || u.status === 'licensing');
  const mwe = active.reduce((sum, u) => sum + (u.netMwe ?? 0), 0);
  const types = [...new Set(active.map((u) => u.type))];
  const parts = [`${active.length || units.length} unit${(active.length || units.length) === 1 ? '' : 's'}`];
  if (types.length) parts.push(types.join(' / '));
  if (mwe > 0) parts.push(`${mwe.toLocaleString()} MWe`);
  return parts.join(' · ');
}

/**
 * Searchable directory of every US nuclear facility in the registry with
 * fleet statistics, NRC docket links, and map focus.
 */
export class NuclearFacilityDirectoryPanel extends Panel {
  private query = '';
  private expandedId: string | null = null;
  private onLocationClick?: FacilityLocateHandler;
  private filters: SiteFilters = { category: 'power-reactor', state: '', region: 0, status: 'all', watchlistOnly: false, sort: 'state' };
  private snapshot: SiteRiskSnapshot = nuclearSiteRiskStore.getSnapshot();
  private readonly unsubscribe: () => void;
  private readonly onWatchlistChanged = () => this.render();

  constructor() {
    super({
      id: 'nuclear-facilities',
      title: 'US Nuclear Facility Directory',
      showCount: true,
      defaultRowSpan: 2,
      infoTooltip:
        'Curated registry of US nuclear facilities compiled from the NRC facility locator, the NRC operating reactor list, ' +
        `DOE and NNSA site pages, and operator disclosures (reviewed ${US_NUCLEAR_REGISTRY_AS_OF}). Capacities are net MWe; ` +
        'license years are current NRC license expirations.',
    });

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const chip = target.closest<HTMLElement>('.nfd-cat');
      if (chip?.dataset.category) {
        this.filters.category = chip.dataset.category as CategoryFilter;
        this.expandedId = null;
        this.render();
        return;
      }
      if (applyFilterControl(target, this.filters)) {
        this.render();
        return;
      }
      if (handleSiteAction(target, {
        getSummary: (id) => this.snapshot.byId.get(id),
        getExportRows: () => this.visible().map((f) => this.summaryFor(f)),
        onLocate: (lat, lon, id) => this.onLocationClick?.(lat, lon, id),
      })) {
        e.stopPropagation();
        return;
      }
      if (target.closest('a') || target.closest('input') || target.closest('select')) return;
      const row = target.closest<HTMLElement>('.nfd-row');
      if (row?.dataset.facility) {
        this.expandedId = this.expandedId === row.dataset.facility ? null : row.dataset.facility;
        this.render();
      }
    });
    this.content.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement;
      if (!input.classList.contains('nfd-search')) return;
      this.query = input.value.trim().toLowerCase();
      this.renderList();
    });
    this.content.addEventListener('change', (e) => {
      if (applyFilterControl(e.target as HTMLElement, this.filters)) this.render();
    });
    bindActivationKeys(this.content, '.nfd-row');
    this.unsubscribe = nuclearSiteRiskStore.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.renderList();
    });
    window.addEventListener(NUCLEAR_WATCHLIST_CHANGED_EVENT, this.onWatchlistChanged);
    this.render();
  }

  public setLocationClickHandler(handler: FacilityLocateHandler): void {
    this.onLocationClick = handler;
  }

  public override destroy(): void {
    this.unsubscribe();
    window.removeEventListener(NUCLEAR_WATCHLIST_CHANGED_EVENT, this.onWatchlistChanged);
    super.destroy();
  }

  private summaryFor(f: UsNuclearFacility): SiteRiskSummary {
    // Every registry facility has a summary once the store has computed; the
    // initial snapshot also covers all facilities with a quiet status.
    return this.snapshot.byId.get(f.id)!;
  }

  /** Expand and reveal a facility (used by map popups and command palette deep links). */
  public focusFacility(id: string): void {
    const f = US_NUCLEAR_FACILITIES.find((x) => x.id === id);
    if (!f) return;
    this.filters = { ...this.filters, category: 'all', state: '', region: 0, status: 'all', watchlistOnly: false };
    this.query = '';
    this.expandedId = id;
    this.render();
    this.content.querySelector<HTMLElement>(`.nfd-row[data-facility="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private visible(): UsNuclearFacility[] {
    const watchlist = watchlistSnapshot();
    const items = US_NUCLEAR_FACILITIES
      .filter((f) => matchesQuery(f, this.query) && matchesSiteFilters(f, this.snapshot.byId.get(f.id), this.filters, watchlist))
      .map((f) => ({ facility: f, summary: this.snapshot.byId.get(f.id) }));
    sortSites(items, this.filters.sort);
    return items.map((i) => i.facility);
  }

  private renderList(): void {
    const list = this.content.querySelector<HTMLElement>('.nfd-list');
    if (!list) {
      this.render();
      return;
    }
    setTrustedHtml(list, trustedHtml(this.listHtml(), 'NuclearFacilityDirectoryPanel list render: all dynamic values escaped'));
    this.setCount(this.visible().length);
  }

  private listHtml(): string {
    const items = this.visible();
    if (items.length === 0) return '<div class="panel-empty">No facilities match.</div>';
    const watchlist = watchlistSnapshot();
    const live = this.snapshot.ready;
    const rows = items.map((f) => {
      const expanded = this.expandedId === f.id;
      const summary = this.snapshot.byId.get(f.id);
      const detail = expanded
        ? `<tr class="nfd-detail"><td colspan="5">${renderFacilityDetail(f, summary, watchlist.has(f.id))}</td></tr>`
        : '';
      return `
        <tr class="nfd-row nfd-row-${f.category}${expanded ? ' expanded' : ''}" data-facility="${escapeHtml(f.id)}" tabindex="0" aria-expanded="${expanded}">
          <td class="nsu-star-cell">${renderWatchStar(f.id, watchlist.has(f.id))}</td>
          <td class="nfd-name"><div class="nfd-name-main">${escapeHtml(f.name)}</div><div class="nfd-name-meta">${escapeHtml(f.city ? `${f.city}, ${f.state}` : f.state)} · ${escapeHtml(f.operator)}</div></td>
          <td class="nfd-cat-cell"><span class="nfd-cat-badge nfd-cat-${f.category}">${escapeHtml(CATEGORY_SHORT[f.category])}</span><span class="nfd-status">${escapeHtml(US_NUCLEAR_STATUS_LABELS[f.status])}</span></td>
          <td class="nfd-units-cell">${escapeHtml(unitsSummary(f))}</td>
          <td class="nfd-hazard-cell">${live && summary ? renderStatusBadge(summary.status) : '<span class="nsu-quiet">—</span>'}</td>
        </tr>${detail}`;
    }).join('');
    return `<table class="nfd-table"><thead><tr><th aria-label="My sites"></th><th>Facility</th><th>Category</th><th>Units</th><th>Hazards</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  private render(): void {
    const fleet = summarizeUsNuclearFleet();
    const chips = CATEGORY_ORDER.map((c) => {
      const count = c === 'all' ? US_NUCLEAR_FACILITIES.length : US_NUCLEAR_FACILITIES.filter((f) => f.category === c).length;
      return `<button type="button" class="nfd-cat${this.filters.category === c ? ' active' : ''}" data-category="${c}">${escapeHtml(CATEGORY_SHORT[c])} <span class="nfd-cat-count">${count}</span></button>`;
    }).join('');

    const html = `
      <div class="nfd-fleet">
        <div class="nfd-card"><span class="nfd-card-label">Operating units</span><span class="nfd-card-value">${fleet.operatingUnits}</span><span class="nfd-card-sub">${fleet.operatingSites} sites · ${fleet.restartingUnits} restarting</span></div>
        <div class="nfd-card"><span class="nfd-card-label">Net capacity</span><span class="nfd-card-value">${(fleet.netMwe / 1000).toFixed(1)} GW</span><span class="nfd-card-sub">${fleet.pwrUnits} PWR · ${fleet.bwrUnits} BWR</span></div>
        <div class="nfd-card"><span class="nfd-card-label">By NRC region</span><span class="nfd-card-value nfd-card-regions">I ${fleet.unitsByRegion[1]} · II ${fleet.unitsByRegion[2]} · III ${fleet.unitsByRegion[3]} · IV ${fleet.unitsByRegion[4]}</span><span class="nfd-card-sub">units</span></div>
        <div class="nfd-card"><span class="nfd-card-label">Licenses expiring ≤2030</span><span class="nfd-card-value">${fleet.licenseExpiringBy2030}</span><span class="nfd-card-sub">renewals pending</span></div>
        <div class="nfd-card"><span class="nfd-card-label">New build</span><span class="nfd-card-value">${fleet.newBuildProjects}</span><span class="nfd-card-sub">projects tracked</span></div>
        <div class="nfd-card"><span class="nfd-card-label">Other sites</span><span class="nfd-card-value">${fleet.decommissioningSites + fleet.doeSites + fleet.fuelCycleFacilities + fleet.researchReactors + fleet.uraniumRecoverySites + fleet.wasteSites}</span><span class="nfd-card-sub">DOE · fuel cycle · research · waste</span></div>
      </div>
      <div class="nfd-toolbar">
        <input type="search" class="nfd-search" placeholder="Search name, state, operator, docket…" value="${escapeHtml(this.query)}" aria-label="Search facilities">
      </div>
      <div class="nfd-cats">${chips}</div>
      ${renderSiteFilterToolbar(this.filters, { showCategory: false, watchCount: watchlistSnapshot().size })}
      <div class="nfd-list">${this.listHtml()}</div>
      <div class="nfd-footer">Registry reviewed ${escapeHtml(US_NUCLEAR_REGISTRY_AS_OF)} · <a href="${US_NUCLEAR_REGISTRY_SOURCES.nrcOperatingReactors}" target="_blank" rel="noopener">NRC operating reactors</a> · <a href="${US_NUCLEAR_REGISTRY_SOURCES.nrcFacilityLocator}" target="_blank" rel="noopener">NRC facility locator</a> · <a href="${US_NUCLEAR_REGISTRY_SOURCES.doeSites}" target="_blank" rel="noopener">DOE sites</a> · <a href="${US_NUCLEAR_REGISTRY_SOURCES.iaeaPris}" target="_blank" rel="noopener">IAEA PRIS</a></div>
    `;
    this.setSafeContent(unsafeRawHtml(html, 'NuclearFacilityDirectoryPanel render: all dynamic values escaped'));
    this.setCount(this.visible().length);
  }
}
