import { Panel } from './Panel';
import { t } from '@/services/i18n';
import {
  fetchGridAlerts,
  formatMw,
  formatRelativeAge,
  gridBandCssVar,
  GRID_HAZARD_LABELS,
  GRID_HAZARD_ORDER,
  GRID_STATUS_LABELS,
  type GridAlert,
  type GridAlertKind,
  type GridAlertsEnvelope,
  type GridRegion,
} from '@/services/grid-alerts';
import { h } from '@/utils/dom-utils';
import { sanitizeUrl } from '@/utils/sanitize';

export type GridAlertsView = 'alerts' | 'regions' | 'hazards' | 'space';

const VIEWS: GridAlertsView[] = ['alerts', 'regions', 'hazards', 'space'];
const KIND_FILTERS: Array<GridAlertKind | 'all'> = ['all', 'operator', 'weather', 'space'];
const KIND_ICON: Record<GridAlertKind, string> = { operator: '⚡', weather: '\u{1F327}️', space: '☀️' };
const LEVEL_CLASS: Record<GridAlert['level'], string> = { emergency: 'critical', warning: 'high', advisory: 'medium', info: 'low' };
const STATUS_CLASS: Record<GridRegion['status'], string> = {
  eea3: 'critical', eea2: 'critical', eea1: 'high', conservative: 'medium', advisory: 'medium', watch: 'low', normal: 'ok', unknown: 'none',
};

/** Map click → panel focus. Dispatched by the DeckGL grid layer. */
export const GRID_FOCUS_REGION_EVENT = 'grid:focus-region';
const NARROW_WIDTH_PX = 520;

export class GridAlertsPanel extends Panel {
  private view: GridAlertsView = 'alerts';
  private kindFilter: GridAlertKind | 'all' = 'all';
  private data: GridAlertsEnvelope | null = null;
  private loading = true;
  private error: string | null = null;
  private focusedRegionId: string | null = null;
  private expandedRegions = new Set<string>();
  private narrow = false;
  private resizeObserver: ResizeObserver | null = null;

  private readonly focusHandler = (event: Event): void => {
    const regionId = (event as CustomEvent<{ regionId?: string }>).detail?.regionId;
    if (!regionId) return;
    this.focusedRegionId = regionId;
    this.expandedRegions.add(regionId);
    this.view = 'regions';
    this.render();
    this.element.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
  };

  constructor() {
    super({
      id: 'grid-alerts',
      title: t('panels.gridAlerts'),
      showCount: true,
      // Two columns wide and two rows tall: the regions board and hazard matrix
      // are tabular and unreadable in a single grid cell. Mirrored in
      // DEFERRED_PANEL_NATURAL_FOOTPRINTS (src/app/panel-layout.ts).
      className: 'panel-wide',
      defaultRowSpan: 2,
      // English literal on purpose: the first-paint shell catalogue is byte-budgeted
      // and a localized infoTooltip would have to ride it (tests/i18n-english-shell).
      // Same precedent as TorontoSafetyPanel; the coverage catalog carries the
      // written description in scripts/data/coverage-panel-descriptions.json.
      infoTooltip: 'ISO/RTO operating conditions, EIA-930 demand, grid-relevant NWS hazard alerts mapped to operator footprints and NOAA SWPC geomagnetic state, scored into a per-region impact with named drivers. Scores are WorldMonitor heuristics, not operator declarations.',
    });
    if (typeof window !== 'undefined') window.addEventListener(GRID_FOCUS_REGION_EVENT, this.focusHandler);
    // The regions board and hazard matrix are tabular. Below ~520px (mobile,
    // or a single grid cell) they stack into two lines via `.ga-narrow`.
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width ?? 0;
        const narrow = width > 0 && width < NARROW_WIDTH_PX;
        if (narrow !== this.narrow) { this.narrow = narrow; if (this.data) this.render(); }
      });
      this.resizeObserver.observe(this.content);
    }
    this.showLoading(t('components.gridAlerts.loading'));
    void this.fetchData();
  }

  public destroy(): void {
    if (typeof window !== 'undefined') window.removeEventListener(GRID_FOCUS_REGION_EVENT, this.focusHandler);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    super.destroy();
  }

  public async fetchData(): Promise<void> {
    if (!this.element.isConnected) {
      this.runWhenConnected(() => { void this.fetchData(); });
      return;
    }
    this.error = null;
    try {
      const envelope = await fetchGridAlerts();
      if (!this.element.isConnected) return;
      this.data = envelope.regions.length > 0 ? envelope : null;
      if (!this.data) this.error = t('components.gridAlerts.notPublished');
    } catch (error) {
      if (this.isAbortError(error) || !this.element.isConnected) return;
      this.error = t('components.gridAlerts.unavailable');
      console.error('[GridAlerts] Fetch error:', error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  public refresh(): void {
    void this.fetchData();
  }

  /** Switch the visible view (also used by tests and command dispatch). */
  public setView(view: GridAlertsView): void {
    if (!VIEWS.includes(view)) return;
    this.view = view;
    this.render();
  }

  public getView(): GridAlertsView {
    return this.view;
  }

  protected render(): void {
    if (this.loading) {
      this.setContentNodes(h('div', { className: 'empty-state' }, t('components.gridAlerts.loading')));
      return;
    }
    if (this.error || !this.data) {
      this.showError(this.error ?? t('components.gridAlerts.unavailable'), () => this.refresh());
      return;
    }
    const data = this.data;
    this.setCount(data.alerts.length);
    this.setContentNodes(
      h('div', { className: `grid-alerts${this.narrow ? ' ga-narrow' : ''}` },
        this.renderSummary(data),
        h('div', { className: 'panel-tabs', role: 'tablist', 'aria-label': t('panels.gridAlerts') },
          ...VIEWS.map((view) => h('button', {
            className: `panel-tab ${this.view === view ? 'active' : ''}`,
            role: 'tab',
            'aria-selected': this.view === view ? 'true' : 'false',
            'data-view': view,
            onClick: () => this.setView(view),
          }, t(`components.gridAlerts.views.${view}`))),
        ),
        this.view === 'alerts' ? this.renderAlerts(data)
          : this.view === 'regions' ? this.renderRegions(data)
            : this.view === 'hazards' ? this.renderHazards(data)
              : this.renderSpace(data),
        this.renderSources(data),
      ),
    );
  }

  // ─── Summary strip ────────────────────────────────────────────────────────

  private renderSummary(data: GridAlertsEnvelope): HTMLElement {
    const s = data.summary;
    const worst = data.regions.find((r) => r.id === s.worstRegionId);
    return h('div', { className: 'ga-summary' },
      h('span', { className: `ga-chip ga-chip-${s.overall}` }, t(`components.gridAlerts.overall.${s.overall}`)),
      h('span', { className: 'ga-summary-item' }, `${s.regionsStressed}/${s.regionsAssessed} ${t('components.gridAlerts.summary.regionsStressed')}`),
      h('span', { className: 'ga-summary-item' }, `${s.emergencyCount} ${t('components.gridAlerts.summary.emergencies')}`),
      s.gNow > 0 ? h('span', { className: 'ga-summary-item ga-summary-space' }, `G${s.gNow}${s.gForecastMax > s.gNow ? ` → G${s.gForecastMax}` : ''}`) : false,
      worst ? h('span', { className: 'ga-summary-item' }, `${t('components.gridAlerts.summary.worst')}: ${worst.name} (${worst.impact.score})`) : false,
      h('span', { className: 'ga-summary-age', title: data.generatedAt }, formatRelativeAge(data.generatedAt)),
    );
  }

  // ─── Alerts view ──────────────────────────────────────────────────────────

  private renderAlerts(data: GridAlertsEnvelope): HTMLElement {
    const alerts = data.alerts.filter((a) => this.kindFilter === 'all' || a.kind === this.kindFilter);
    return h('div', { className: 'ga-view ga-view-alerts' },
      h('div', { className: 'ga-filters', role: 'group' },
        ...KIND_FILTERS.map((kind) => h('button', {
          className: `ga-filter ${this.kindFilter === kind ? 'active' : ''}`,
          'data-kind': kind,
          onClick: () => { this.kindFilter = kind; this.render(); },
        }, kind === 'all' ? t('components.gridAlerts.filters.all') : `${KIND_ICON[kind]} ${t(`components.gridAlerts.kinds.${kind}`)}`)),
      ),
      alerts.length === 0
        ? h('div', { className: 'empty-state' }, t('components.gridAlerts.noAlerts'))
        : h('div', { className: 'ga-alert-list' }, ...alerts.slice(0, 80).map((a) => this.alertRow(a, data))),
      data.summary.weatherAlertTotal > data.summary.weatherAlertCount
        ? h('div', { className: 'ga-note' }, t('components.gridAlerts.truncated', { shown: data.summary.weatherAlertCount, total: data.summary.weatherAlertTotal }))
        : false,
    );
  }

  private alertRow(a: GridAlert, data: GridAlertsEnvelope): HTMLElement {
    const regionNames = a.regionIds.slice(0, 4).map((id) => data.regions.find((r) => r.id === id)?.id ?? id);
    const more = a.regionIds.length > 4 ? ` +${a.regionIds.length - 4}` : '';
    const url = a.url ? sanitizeUrl(a.url) : '';
    return h('div', { className: `intel-item ga-alert ga-alert-${a.kind}`, 'data-alert-id': a.id },
      h('div', { className: 'intel-item-title' },
        h('span', { className: `ga-level ga-level-${LEVEL_CLASS[a.level]}` }, t(`components.gridAlerts.levels.${a.level}`)),
        h('span', { className: 'ga-kind-icon', 'aria-hidden': 'true' }, KIND_ICON[a.kind]),
        url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, a.title) : h('span', null, a.title),
      ),
      h('div', { className: 'intel-item-meta' },
        regionNames.length ? `${regionNames.join(', ')}${more}` : t('components.gridAlerts.allRegions'),
        a.areaDesc ? ` · ${a.areaDesc.slice(0, 120)}` : '',
        a.issuedAt ? ` · ${formatRelativeAge(a.issuedAt)}` : '',
      ),
      a.detail ? h('div', { className: 'intel-item-summary' }, a.detail) : false,
    );
  }

  // ─── Regions view ─────────────────────────────────────────────────────────

  private renderRegions(data: GridAlertsEnvelope): HTMLElement {
    return h('div', { className: 'ga-view ga-view-regions' },
      h('div', { className: 'ga-region-head' },
        h('span', null, t('components.gridAlerts.regions.region')),
        h('span', null, t('components.gridAlerts.regions.status')),
        h('span', null, t('components.gridAlerts.regions.demand')),
        h('span', null, t('components.gridAlerts.regions.impact')),
      ),
      ...data.regions.map((r) => this.regionRow(r)),
    );
  }

  private regionRow(r: GridRegion): HTMLElement {
    const expanded = this.expandedRegions.has(r.id);
    const focused = this.focusedRegionId === r.id;
    const demand = formatMw(r.metrics.demandMw);
    const vsForecast = r.metrics.demandVsForecastPct !== null ? ` (${r.metrics.demandVsForecastPct}% ${t('components.gridAlerts.regions.ofForecast')})` : '';
    const toggle = (): void => {
      if (expanded) this.expandedRegions.delete(r.id); else this.expandedRegions.add(r.id);
      this.focusedRegionId = r.id;
      this.render();
    };
    return h('div', { className: `ga-region ${focused ? 'focused' : ''} ${expanded ? 'expanded' : ''}`, 'data-region-id': r.id },
      h('button', { className: 'ga-region-row', onClick: toggle, 'aria-expanded': expanded ? 'true' : 'false' },
        h('span', { className: 'ga-region-name' },
          h('strong', null, r.id),
          h('span', { className: 'ga-region-full' }, ` ${r.name}`),
        ),
        h('span', { className: `ga-status ga-status-${STATUS_CLASS[r.status]}`, title: r.statusText }, GRID_STATUS_LABELS[r.status]),
        h('span', { className: 'ga-region-demand', title: r.metrics.demandAt ?? '' }, `${demand}${vsForecast}`),
        h('span', { className: 'ga-impact' },
          h('span', { className: 'ga-impact-bar' },
            h('span', { className: 'ga-impact-fill', style: `width:${r.impact.score}%;background:${gridBandCssVar(r.impact.band)}` }),
          ),
          h('span', { className: `ga-impact-score ga-band-${r.impact.band}` }, String(r.impact.score)),
        ),
      ),
      expanded ? h('div', { className: 'ga-region-detail' },
        h('div', { className: 'ga-region-status-text' }, r.statusText, r.statusUpdatedAt ? ` · ${formatRelativeAge(r.statusUpdatedAt)}` : ''),
        h('div', { className: 'ga-metrics' },
          this.metric(t('components.gridAlerts.metrics.forecastPeak'), formatMw(r.metrics.peakForecastMw)),
          this.metric(t('components.gridAlerts.metrics.capacity'), formatMw(r.metrics.capacityMw)),
          this.metric(t('components.gridAlerts.metrics.netGeneration'), formatMw(r.metrics.netGenerationMw)),
          this.metric(t('components.gridAlerts.metrics.interchange'), formatMw(r.metrics.interchangeMw)),
          r.metrics.prcMw !== null ? this.metric('PRC', formatMw(r.metrics.prcMw)) : false,
          r.metrics.reservePct !== null ? this.metric(t('components.gridAlerts.metrics.reserve'), `${r.metrics.reservePct}%`) : false,
          this.metric(t('components.gridAlerts.metrics.gic'), t(`components.gridAlerts.exposure.${r.space.gicExposure}`)),
        ),
        r.impact.drivers.length
          ? h('ul', { className: 'ga-drivers' }, ...r.impact.drivers.map((d) => h('li', null, d)))
          : h('div', { className: 'ga-note' }, t('components.gridAlerts.regions.noDrivers')),
        h('div', { className: 'ga-note' }, `${t('components.gridAlerts.regions.footprint')}: ${r.states.join(', ')}`),
      ) : false,
    );
  }

  private metric(label: string, value: string): HTMLElement {
    return h('span', { className: 'ga-metric' }, h('span', { className: 'ga-metric-label' }, label), h('span', { className: 'ga-metric-value' }, value));
  }

  // ─── Hazard → grid matrix ─────────────────────────────────────────────────

  private renderHazards(data: GridAlertsEnvelope): HTMLElement {
    const categories = GRID_HAZARD_ORDER.filter((c) => data.regions.some((r) => (r.hazards.categories[c] ?? 0) > 0));
    const rows = data.regions.filter((r) => r.hazards.alertCount > 0 || r.impact.score >= 20);
    if (rows.length === 0 || categories.length === 0) {
      return h('div', { className: 'ga-view ga-view-hazards' },
        h('div', { className: 'empty-state' }, t('components.gridAlerts.hazards.none')),
        this.hazardLegend(),
      );
    }
    return h('div', { className: 'ga-view ga-view-hazards' },
      h('div', { className: 'ga-matrix', style: `grid-template-columns: minmax(90px, 1.4fr) repeat(${categories.length}, minmax(44px, 1fr)) 52px` },
        h('span', { className: 'ga-matrix-head' }, t('components.gridAlerts.regions.region')),
        ...categories.map((c) => h('span', { className: 'ga-matrix-head', title: GRID_HAZARD_LABELS[c] }, GRID_HAZARD_LABELS[c])),
        h('span', { className: 'ga-matrix-head' }, t('components.gridAlerts.regions.impact')),
        ...rows.flatMap((r) => [
          h('span', { className: 'ga-matrix-region', title: r.name }, r.id),
          ...categories.map((c) => this.hazardCell(r.hazards.categories[c] ?? 0)),
          h('span', { className: `ga-matrix-score ga-band-${r.impact.band}` }, String(r.impact.score)),
        ]),
      ),
      this.hazardLegend(),
    );
  }

  private hazardCell(weight: number): HTMLElement {
    const intensity = weight >= 30 ? 'critical' : weight >= 20 ? 'high' : weight >= 10 ? 'medium' : weight > 0 ? 'low' : 'none';
    return h('span', { className: `ga-matrix-cell ga-cell-${intensity}`, title: weight > 0 ? `${t('components.gridAlerts.hazards.weight')} ${weight}` : '' }, weight > 0 ? String(Math.round(weight)) : '');
  }

  private hazardLegend(): HTMLElement {
    return h('div', { className: 'ga-note ga-legend' },
      t('components.gridAlerts.hazards.legend'),
    );
  }

  // ─── Space weather view ───────────────────────────────────────────────────

  private renderSpace(data: GridAlertsEnvelope): HTMLElement {
    const space = data.space;
    if (!space) {
      return h('div', { className: 'ga-view ga-view-space' }, h('div', { className: 'empty-state' }, t('components.gridAlerts.space.unavailable')));
    }
    const gClass = (g: number): string => (g >= 4 ? 'critical' : g >= 3 ? 'high' : g >= 1 ? 'medium' : 'ok');
    const byExposure: Record<string, string[]> = { high: [], moderate: [], low: [] };
    for (const e of space.exposure) (byExposure[e.exposure] ??= []).push(e.regionId);
    const spaceAlerts = data.alerts.filter((a) => a.kind === 'space');
    return h('div', { className: 'ga-view ga-view-space' },
      h('div', { className: 'ga-space-now' },
        h('span', { className: `ga-g ga-g-${gClass(space.current.g)}` }, `G${space.current.g}`),
        h('span', { className: 'ga-space-text' }, `${t('components.gridAlerts.space.now')} · ${space.current.gText}`),
        space.kp !== null ? h('span', { className: 'ga-space-kp', title: space.kpAt ?? '' }, `Kp ${space.kp.toFixed(1)}`) : false,
      ),
      h('div', { className: 'ga-space-forecast' },
        ...space.forecast.map((d) => h('span', { className: 'ga-space-day' },
          h('span', { className: `ga-g ga-g-${gClass(d.g)}` }, `G${d.g}`),
          h('span', { className: 'ga-space-date' }, d.date ?? ''),
        )),
      ),
      h('div', { className: 'ga-exposure' },
        ...(['high', 'moderate', 'low'] as const).map((level) => h('div', { className: 'ga-exposure-row' },
          h('span', { className: `ga-exposure-label ga-exposure-${level}` }, t(`components.gridAlerts.exposure.${level}`)),
          h('span', { className: 'ga-exposure-regions' }, byExposure[level]?.join(', ') || '—'),
        )),
      ),
      spaceAlerts.length
        ? h('div', { className: 'ga-alert-list' }, ...spaceAlerts.map((a) => this.alertRow(a, data)))
        : h('div', { className: 'ga-note' }, t('components.gridAlerts.space.noProducts')),
      h('div', { className: 'ga-note' }, t('components.gridAlerts.space.mechanism')),
    );
  }

  // ─── Sources footer ───────────────────────────────────────────────────────

  private renderSources(data: GridAlertsEnvelope): HTMLElement {
    return h('div', { className: 'panel-source ga-sources' },
      h('div', { className: 'ga-source-list' },
        ...data.sources.map((s) => h('span', { className: `ga-source ${s.ok ? 'ok' : 'failed'}`, title: s.ok ? `${s.label} · ${formatRelativeAge(s.fetchedAt)}` : `${s.label}: ${s.error ?? 'failed'}` }, `${s.ok ? '●' : '○'} ${s.id}`)),
      ),
      h('div', null, data.attribution.notice),
    );
  }
}
