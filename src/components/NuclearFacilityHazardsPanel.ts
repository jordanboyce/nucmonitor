import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { bindActivationKeys } from '@/utils/activation';
import type { Earthquake } from '@/services/earthquakes';
import type { WeatherAlert } from '@/services/weather';
import type { RadiationObservation } from '@/services/radiation';
import type { MapFire } from '@/services/wildfires';
import type { NaturalEvent } from '@/types';
import {
  correlateFacilityHazards,
  summarizeFacilityHazards,
  type FacilityHazardKind,
  type FacilityHazardReport,
  type FacilityHazardSeverity,
} from '@/services/nuclear-facility-hazards';
import { US_NUCLEAR_CATEGORY_LABELS } from '@/config/us-nuclear-facilities';

const KIND_ICON: Record<FacilityHazardKind, string> = {
  earthquake: '🌐',
  weather: '🌩️',
  storm: '🌀',
  flood: '🌊',
  fire: '🔥',
  radiation: '☢️',
  volcano: '🌋',
  other: '⚠️',
};

const SEVERITY_ORDER: FacilityHazardSeverity[] = ['critical', 'high', 'elevated', 'watch'];

/**
 * All-hazards watch for US nuclear facilities. Receives the hazard feeds the
 * dashboard already loads and re-correlates whenever any of them refreshes.
 */
export class NuclearFacilityHazardsPanel extends Panel {
  private earthquakes: Earthquake[] = [];
  private weatherAlerts: WeatherAlert[] = [];
  private fires: MapFire[] = [];
  private radiation: RadiationObservation[] = [];
  private naturalEvents: NaturalEvent[] = [];
  private reports: FacilityHazardReport[] = [];
  private receivedAny = false;
  private expandedId: string | null = null;
  private minSeverity: FacilityHazardSeverity = 'watch';
  private onLocationClick?: (lat: number, lon: number) => void;
  private renderScheduled = false;

  constructor() {
    super({
      id: 'nuclear-hazards',
      title: 'Facility All-Hazards Watch',
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
      infoTooltip:
        'Joins live hazard feeds (USGS earthquakes, NWS alerts, NASA FIRMS fire detections, EPA RadNet / Safecast ' +
        'radiation, NHC and EONET storms) to every US nuclear facility in the registry. A listing means a public hazard ' +
        'signal is near a site, not that the site is affected — check the linked source and NRC event reports.',
    });
    this.showLoading('Waiting for hazard feeds…');

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const chip = target.closest<HTMLElement>('.nfh-sev-filter');
      if (chip?.dataset.severity) {
        this.minSeverity = chip.dataset.severity as FacilityHazardSeverity;
        this.render();
        return;
      }
      const locate = target.closest<HTMLElement>('.nfh-locate');
      if (locate) {
        e.stopPropagation();
        const lat = Number(locate.dataset.lat);
        const lon = Number(locate.dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) this.onLocationClick?.(lat, lon);
        return;
      }
      if (target.closest('a')) return;
      const row = target.closest<HTMLElement>('.nfh-row');
      if (row?.dataset.facility) {
        this.expandedId = this.expandedId === row.dataset.facility ? null : row.dataset.facility;
        this.render();
      }
    });
    bindActivationKeys(this.content, '.nfh-row');
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }

  public setEarthquakes(earthquakes: Earthquake[]): void {
    this.earthquakes = earthquakes;
    this.scheduleRecompute();
  }

  public setWeatherAlerts(alerts: WeatherAlert[]): void {
    this.weatherAlerts = alerts;
    this.scheduleRecompute();
  }

  public setFires(fires: MapFire[]): void {
    this.fires = fires;
    this.scheduleRecompute();
  }

  public setRadiation(observations: RadiationObservation[]): void {
    this.radiation = observations;
    this.scheduleRecompute();
  }

  public setNaturalEvents(events: NaturalEvent[]): void {
    this.naturalEvents = events;
    this.scheduleRecompute();
  }

  public getReports(): FacilityHazardReport[] {
    return this.reports;
  }

  private scheduleRecompute(): void {
    this.receivedAny = true;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    // Several feeds land within the same tick on first load; coalesce them.
    const run = () => {
      this.renderScheduled = false;
      this.recompute();
    };
    if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else run();
  }

  private recompute(): void {
    this.reports = correlateFacilityHazards({
      earthquakes: this.earthquakes,
      weatherAlerts: this.weatherAlerts,
      fires: this.fires,
      radiation: this.radiation,
      naturalEvents: this.naturalEvents,
    });
    this.setCount(this.reports.length);
    const worst = this.reports[0]?.severity;
    this.setSeverity(worst === 'critical' ? 'critical' : worst === 'high' ? 'high' : worst === 'elevated' ? 'medium' : worst ? 'low' : 'none');
    this.render();
  }

  private visibleReports(): FacilityHazardReport[] {
    const threshold = SEVERITY_ORDER.indexOf(this.minSeverity);
    return this.reports.filter((r) => SEVERITY_ORDER.indexOf(r.severity) <= threshold);
  }

  private render(): void {
    if (!this.receivedAny) return;
    const totals = summarizeFacilityHazards(this.reports);
    const visible = this.visibleReports();

    const chips = SEVERITY_ORDER.map((sev) => {
      const count = this.reports.filter((r) => SEVERITY_ORDER.indexOf(r.severity) <= SEVERITY_ORDER.indexOf(sev)).length;
      return `<button type="button" class="nfh-sev-filter nfh-sev-${sev}${this.minSeverity === sev ? ' active' : ''}" data-severity="${sev}">${sev === 'watch' ? 'All' : `${sev[0]!.toUpperCase()}${sev.slice(1)}+`} <span class="nfh-chip-count">${count}</span></button>`;
    }).join('');

    const kindTotals = (Object.keys(totals.byKind) as FacilityHazardKind[])
      .filter((k) => totals.byKind[k] > 0)
      .map((k) => `<span class="nfh-kind">${KIND_ICON[k]} ${escapeHtml(k)} <b>${totals.byKind[k]}</b></span>`)
      .join('');

    const rows = visible.map((r) => {
      const f = r.facility;
      const expanded = this.expandedId === f.id;
      const top = r.signals[0]!;
      const detail = expanded
        ? `<tr class="nfh-detail"><td colspan="3">
            <ul class="nfh-signals">
              ${r.signals.map((s) => `<li class="nfh-signal nfh-signal-${s.severity}">
                <span class="nfh-signal-icon">${KIND_ICON[s.kind]}</span>
                <span class="nfh-signal-text">${escapeHtml(s.summary)}</span>
                <span class="nfh-signal-meta">${escapeHtml(s.source)}${s.at ? ` · ${escapeHtml(s.at.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}` : ''}${s.sourceUrl ? ` · <a href="${escapeHtml(s.sourceUrl)}" target="_blank" rel="noopener">source</a>` : ''}</span>
              </li>`).join('')}
            </ul>
            <div class="nfh-detail-footer">
              <span>${escapeHtml(US_NUCLEAR_CATEGORY_LABELS[f.category])} · ${escapeHtml(f.operator)}${f.notes ? ` · ${escapeHtml(f.notes)}` : ''}</span>
              <button type="button" class="nfh-locate" data-lat="${f.lat}" data-lon="${f.lon}">Show on map</button>
            </div>
          </td></tr>`
        : '';
      return `
        <tr class="nfh-row nfh-row-${r.severity}${expanded ? ' expanded' : ''}" data-facility="${escapeHtml(f.id)}" tabindex="0" aria-expanded="${expanded}">
          <td class="nfh-facility"><div class="nfh-facility-name">${escapeHtml(f.name)}</div><div class="nfh-facility-meta">${escapeHtml(f.state)} · ${escapeHtml(US_NUCLEAR_CATEGORY_LABELS[f.category])}</div></td>
          <td class="nfh-severity"><span class="nfh-badge nfh-badge-${r.severity}">${escapeHtml(r.severity)}</span><span class="nfh-signal-count">${r.signals.length} signal${r.signals.length === 1 ? '' : 's'}</span></td>
          <td class="nfh-top">${KIND_ICON[top.kind]} ${escapeHtml(top.summary)}</td>
        </tr>${detail}`;
    }).join('');

    const body = visible.length
      ? `<table class="nfh-table"><thead><tr><th>Facility</th><th>Level</th><th>Leading signal</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<div class="panel-empty">${this.reports.length ? 'No facilities at the selected level.' : 'No public hazard signals near any registered US nuclear facility right now.'}</div>`;

    const html = `
      <div class="nfh-summary">
        <div class="nfh-card"><span class="nfh-card-label">Facilities flagged</span><span class="nfh-card-value">${totals.facilitiesWithSignals}</span></div>
        <div class="nfh-card nfh-card-critical"><span class="nfh-card-label">Critical</span><span class="nfh-card-value">${totals.critical}</span></div>
        <div class="nfh-card nfh-card-high"><span class="nfh-card-label">High</span><span class="nfh-card-value">${totals.high}</span></div>
        <div class="nfh-card nfh-card-elevated"><span class="nfh-card-label">Elevated</span><span class="nfh-card-value">${totals.elevated}</span></div>
      </div>
      <div class="nfh-kinds">${kindTotals || '<span class="nfh-kind nfh-kind-none">No active signals</span>'}</div>
      <div class="nfh-filters">${chips}</div>
      ${body}
      <div class="nfh-footer">Feeds: USGS · NWS · NASA FIRMS · EPA RadNet / Safecast · NHC / EONET. Proximity only — confirm with <a href="https://www.nrc.gov/reading-rm/doc-collections/event-status/event/" target="_blank" rel="noopener">NRC Event Notification Reports</a>.</div>
    `;
    this.setSafeContent(unsafeRawHtml(html, 'NuclearFacilityHazardsPanel render: all dynamic values escaped'));
  }
}
