import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import {
  SECOND_ATOMIC_AGE,
  SECOND_ATOMIC_AGE_KIND_LABELS,
  SECOND_ATOMIC_AGE_TOOLS,
  type SecondAtomicAgeToolKind,
} from '@/config/second-atomic-age';
import {
  US_NUCLEAR_FACILITIES,
  US_NUCLEAR_STATUS_LABELS,
  type UsNuclearFacility,
} from '@/config/us-nuclear-facilities';

type KindFilter = 'all' | SecondAtomicAgeToolKind;

const KIND_FILTERS: Array<{ key: KindFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'tracker', label: 'Trackers' },
  { key: 'explorer', label: 'Explorers' },
  { key: 'reference', label: 'Reference' },
  { key: 'calculator', label: 'Calculator' },
];

/** Registry sites that belong to the buildout story: advanced-reactor projects and restarts. */
function buildoutFacilities(): UsNuclearFacility[] {
  return US_NUCLEAR_FACILITIES.filter((f) => f.category === 'new-build' || f.category === 'restart');
}

function unitsLabel(f: UsNuclearFacility): string {
  const units = f.units ?? [];
  if (!units.length) return '';
  const types = [...new Set(units.map((u) => u.type))];
  const mwe = units.reduce((sum, u) => sum + (u.netMwe ?? 0), 0);
  const mwt = units.reduce((sum, u) => sum + (u.thermalMw ?? 0), 0);
  const parts = [types.join(' / ')];
  if (mwe > 0) parts.push(`${mwe.toLocaleString()} MWe`);
  else if (mwt > 0) parts.push(`${mwt.toLocaleString()} MWt`);
  return parts.join(' · ');
}

/**
 * Curated index of The Second Atomic Age's advanced-nuclear trackers, with the
 * registry's own new-build and restart sites beside it. The site's terms
 * allow linking with attribution but not republishing its dataset, so this
 * panel is deep links and NucMonitor's own registry rows, never their data.
 */
export class AdvancedNuclearBuildoutPanel extends Panel {
  private kind: KindFilter = 'all';
  private onLocationClick?: (lat: number, lon: number, facilityId?: string) => void;

  constructor() {
    super({
      id: 'nuclear-buildout',
      title: 'Advanced Nuclear Buildout',
      showCount: true,
      defaultRowSpan: 2,
      infoTooltip:
        'An index of The Second Atomic Age (thesecondatomicage.com), an independent, non-commercial set of trackers ' +
        'following the US advanced-reactor buildout: the DOE pilot program race to criticality, commercialization, ' +
        'the Janus military microreactor program, sited projects, the order book and the fuel-cycle supply chain. ' +
        'Links open their tools; NucMonitor does not republish their dataset. Below the index: the advanced-reactor ' +
        'projects and restarts in the NucMonitor registry, with map focus.',
    });

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const chip = target.closest<HTMLElement>('.anb-kind-filter');
      if (chip?.dataset.kind) {
        this.kind = chip.dataset.kind as KindFilter;
        this.render();
        return;
      }
      const locate = target.closest<HTMLElement>('.anb-locate');
      if (locate?.dataset.facility) {
        e.stopPropagation();
        const f = US_NUCLEAR_FACILITIES.find((x) => x.id === locate.dataset.facility);
        if (f) this.onLocationClick?.(f.lat, f.lon, f.id);
      }
    });
    this.render();
  }

  public setLocationClickHandler(handler: (lat: number, lon: number, facilityId?: string) => void): void {
    this.onLocationClick = handler;
  }

  private render(): void {
    const tools = SECOND_ATOMIC_AGE_TOOLS.filter((t) => this.kind === 'all' || t.kind === this.kind);
    const chips = KIND_FILTERS.map(({ key, label }) => {
      const count = key === 'all' ? SECOND_ATOMIC_AGE_TOOLS.length : SECOND_ATOMIC_AGE_TOOLS.filter((t) => t.kind === key).length;
      return `<button type="button" class="nrs-filter anb-kind-filter${this.kind === key ? ' active' : ''}" data-kind="${key}">${escapeHtml(label)} <span class="nrs-filter-count">${count}</span></button>`;
    }).join('');

    const cards = tools.map((t) => `
      <a class="anb-tool anb-tool-${t.kind}" href="${escapeHtml(t.url)}" target="_blank" rel="noopener" title="${escapeHtml(`${t.title} — ${SECOND_ATOMIC_AGE.name}`)}">
        <span class="anb-tool-kind">${escapeHtml(SECOND_ATOMIC_AGE_KIND_LABELS[t.kind])}</span>
        <span class="anb-tool-title">${escapeHtml(t.title)}</span>
        <span class="anb-tool-summary">${escapeHtml(t.summary)}</span>
      </a>`).join('');

    const sites = buildoutFacilities();
    const siteRows = sites.map((f) => `
      <tr class="nrs-row anb-site">
        <td class="anb-site-main">
          <div class="anb-site-name">${escapeHtml(f.name)}</div>
          <div class="nrs-unit-meta">${escapeHtml(f.city ? `${f.city}, ${f.state}` : f.state)} · ${escapeHtml(f.operator)}${unitsLabel(f) ? ` · ${escapeHtml(unitsLabel(f))}` : ''}</div>
        </td>
        <td class="anb-site-status"><span class="nfd-unit-status nfd-unit-${escapeHtml(f.status)}">${escapeHtml(US_NUCLEAR_STATUS_LABELS[f.status])}</span></td>
        <td class="anb-site-actions">
          ${f.url ? `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener">Reference</a> · ` : ''}<button type="button" class="nsu-action anb-locate" data-facility="${escapeHtml(f.id)}">Map</button>
        </td>
      </tr>`).join('');

    const html = `
      <p class="anb-intro">
        <a href="${SECOND_ATOMIC_AGE.home}" target="_blank" rel="noopener"><b>${escapeHtml(SECOND_ATOMIC_AGE.name)}</b></a>
        is an independent, non-commercial index of the US advanced-reactor buildout: who is building what, how far along it is, where, and who has agreed to buy the power.
        Each card opens one of its tools; a dated <a href="${SECOND_ATOMIC_AGE.updates}" target="_blank" rel="noopener">changelog of recent events</a> is on its home page.
      </p>
      <div class="nrs-filters">${chips}</div>
      <div class="anb-tools">${cards}</div>
      <div class="ner-more-head">
        <span class="ner-more-title">In the NucMonitor registry</span>
        <span class="nrs-unit-meta">${sites.length} advanced-reactor projects and restarts · see the Facility Directory for licensing details</span>
      </div>
      <table class="nrs-table anb-sites"><tbody>${siteRows}</tbody></table>
      <div class="nrs-footer">
        Index of <a href="${SECOND_ATOMIC_AGE.home}" target="_blank" rel="noopener">${escapeHtml(SECOND_ATOMIC_AGE.name)}</a>
        (<a href="${SECOND_ATOMIC_AGE.about}" target="_blank" rel="noopener">about &amp; methodology</a>), reviewed ${escapeHtml(SECOND_ATOMIC_AGE.reviewed)}.
        Figures quoted from its tools should cite the tool, its URL and the access date. Their dataset is not republished here.
      </div>
    `;
    this.setSafeContent(unsafeRawHtml(html, 'AdvancedNuclearBuildoutPanel render: all dynamic values escaped'));
    this.setCount(tools.length);
  }
}
