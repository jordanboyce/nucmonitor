import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { bindActivationKeys } from '@/utils/activation';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import {
  getNrcRegion,
  NRC_REGION_NAMES,
  nrcDocketUrl,
  summarizeUsNuclearFleet,
  US_NUCLEAR_FACILITIES,
  US_NUCLEAR_REGISTRY_AS_OF,
  US_NUCLEAR_REGISTRY_SOURCES,
  US_NUCLEAR_STATUS_LABELS,
  type UsNuclearFacility,
  type UsNuclearFacilityCategory,
} from '@/config/us-nuclear-facilities';

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
  private category: CategoryFilter = 'power-reactor';
  private query = '';
  private expandedId: string | null = null;
  private onLocationClick?: (lat: number, lon: number) => void;

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
        this.category = chip.dataset.category as CategoryFilter;
        this.expandedId = null;
        this.render();
        return;
      }
      const locate = target.closest<HTMLElement>('.nfd-locate');
      if (locate) {
        e.stopPropagation();
        const lat = Number(locate.dataset.lat);
        const lon = Number(locate.dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) this.onLocationClick?.(lat, lon);
        return;
      }
      if (target.closest('a') || target.closest('input')) return;
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
    bindActivationKeys(this.content, '.nfd-row');
    this.render();
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }

  /** Expand and reveal a facility (used by map popups and command palette deep links). */
  public focusFacility(id: string): void {
    const f = US_NUCLEAR_FACILITIES.find((x) => x.id === id);
    if (!f) return;
    this.category = 'all';
    this.query = '';
    this.expandedId = id;
    this.render();
    this.content.querySelector<HTMLElement>(`.nfd-row[data-facility="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  private visible(): UsNuclearFacility[] {
    return US_NUCLEAR_FACILITIES
      .filter((f) => (this.category === 'all' || f.category === this.category) && matchesQuery(f, this.query))
      .sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
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
    const rows = items.map((f) => {
      const region = getNrcRegion(f.state);
      const expanded = this.expandedId === f.id;
      const units = f.units ?? [];
      const detail = expanded
        ? `<tr class="nfd-detail"><td colspan="3">
            ${f.notes ? `<p class="nfd-notes">${escapeHtml(f.notes)}</p>` : ''}
            <div class="nfd-detail-grid">
              <div><span class="nfd-detail-label">Operator</span><span>${escapeHtml(f.operator)}</span></div>
              <div><span class="nfd-detail-label">Regulator</span><span>${escapeHtml(f.regulator)}${region ? ` · NRC ${escapeHtml(NRC_REGION_NAMES[region])}` : ''}</span></div>
              <div><span class="nfd-detail-label">Status</span><span>${escapeHtml(US_NUCLEAR_STATUS_LABELS[f.status])}</span></div>
              <div><span class="nfd-detail-label">Location</span><span>${escapeHtml(f.city ? `${f.city}, ${f.state}` : f.state)} · ${f.lat.toFixed(3)}, ${f.lon.toFixed(3)}</span></div>
              ${f.docket ? `<div><span class="nfd-detail-label">Docket</span><span><a href="${nrcDocketUrl(f.docket)}" target="_blank" rel="noopener">${escapeHtml(f.docket)}</a></span></div>` : ''}
              ${f.isfsi ? '<div><span class="nfd-detail-label">Spent fuel</span><span>Dry storage (ISFSI) on site</span></div>' : ''}
            </div>
            ${units.length ? `<table class="nfd-units"><thead><tr><th>Unit</th><th>Type</th><th>MWe</th><th>Status</th><th>License</th><th>Docket</th></tr></thead><tbody>
              ${units.map((u) => `<tr>
                <td>${escapeHtml(u.name)}</td>
                <td>${escapeHtml(u.type)}</td>
                <td>${u.netMwe ?? (u.thermalMw !== undefined ? `${u.thermalMw} MWt` : '—')}</td>
                <td><span class="nfd-unit-status nfd-unit-${u.status}">${escapeHtml(u.status)}${u.shutdownYear ? ` ${u.shutdownYear}` : ''}</span></td>
                <td>${u.licenseExpires ?? '—'}</td>
                <td>${u.docket ? `<a href="${nrcDocketUrl(u.docket)}" target="_blank" rel="noopener">${escapeHtml(u.docket)}</a>` : '—'}</td>
              </tr>`).join('')}
            </tbody></table>` : ''}
            <div class="nfd-detail-footer">
              ${f.url ? `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">Reference page</a>` : ''}
              <button type="button" class="nfd-locate" data-lat="${f.lat}" data-lon="${f.lon}">Show on map</button>
            </div>
          </td></tr>`
        : '';
      return `
        <tr class="nfd-row nfd-row-${f.category}${expanded ? ' expanded' : ''}" data-facility="${escapeHtml(f.id)}" tabindex="0" aria-expanded="${expanded}">
          <td class="nfd-name"><div class="nfd-name-main">${escapeHtml(f.name)}</div><div class="nfd-name-meta">${escapeHtml(f.city ? `${f.city}, ${f.state}` : f.state)} · ${escapeHtml(f.operator)}</div></td>
          <td class="nfd-cat-cell"><span class="nfd-cat-badge nfd-cat-${f.category}">${escapeHtml(CATEGORY_SHORT[f.category])}</span><span class="nfd-status">${escapeHtml(US_NUCLEAR_STATUS_LABELS[f.status])}</span></td>
          <td class="nfd-units-cell">${escapeHtml(unitsSummary(f))}</td>
        </tr>${detail}`;
    }).join('');
    return `<table class="nfd-table"><thead><tr><th>Facility</th><th>Category</th><th>Units</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  private render(): void {
    const fleet = summarizeUsNuclearFleet();
    const chips = CATEGORY_ORDER.map((c) => {
      const count = c === 'all' ? US_NUCLEAR_FACILITIES.length : US_NUCLEAR_FACILITIES.filter((f) => f.category === c).length;
      return `<button type="button" class="nfd-cat${this.category === c ? ' active' : ''}" data-category="${c}">${escapeHtml(CATEGORY_SHORT[c])} <span class="nfd-cat-count">${count}</span></button>`;
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
      <div class="nfd-list">${this.listHtml()}</div>
      <div class="nfd-footer">Registry reviewed ${escapeHtml(US_NUCLEAR_REGISTRY_AS_OF)} · <a href="${US_NUCLEAR_REGISTRY_SOURCES.nrcOperatingReactors}" target="_blank" rel="noopener">NRC operating reactors</a> · <a href="${US_NUCLEAR_REGISTRY_SOURCES.nrcFacilityLocator}" target="_blank" rel="noopener">NRC facility locator</a> · <a href="${US_NUCLEAR_REGISTRY_SOURCES.doeSites}" target="_blank" rel="noopener">DOE sites</a> · <a href="${US_NUCLEAR_REGISTRY_SOURCES.iaeaPris}" target="_blank" rel="noopener">IAEA PRIS</a></div>
    `;
    this.setSafeContent(unsafeRawHtml(html, 'NuclearFacilityDirectoryPanel render: all dynamic values escaped'));
    this.setCount(this.visible().length);
  }
}
