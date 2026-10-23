import { NUCLEAR_WATCHLIST_CHANGED_EVENT } from '@/services/nuclear-watchlist';
import { Panel } from './Panel';
import { escapeHtml, unsafeRawHtml } from '@/utils/sanitize';
import { bindActivationKeys } from '@/utils/activation';
import { NRC_REGION_NAMES } from '@/config/us-nuclear-facilities';

type NrcRegion = keyof typeof NRC_REGION_NAMES;
import {
  fetchNrcEventReports,
  getLastSeenEventNumber,
  getWatchedFacilityIds,
  markEventsSeen,
  NRC_EVENT_REPORTS_INDEX,
  toggleWatchedFacility,
  type NrcEventReportsResult,
  type NrcEventWithFacility,
} from '@/services/nrc-event-reports';
import {
  NRC_EMERGENCY_CLASS_LABELS,
  NRC_EMERGENCY_CLASS_RANK,
  NRC_EVENT_CATEGORY_LABELS,
  type NrcEmergencyClass,
} from '../../shared/nrc-event-reports';
import {
  fetchNrcSafetyReports,
  NRC_PART21_INDEX,
  NRC_PRELIMINARY_NOTIFICATIONS_INDEX,
  type NrcSafetyReportsResult,
} from '@/services/nrc-safety-reports';

const PART21_ROWS = 6;
const PN_ROWS = 4;

type CategoryFilter = 'all' | 'power-reactor' | 'fuel-cycle' | 'non-power-reactor' | 'materials';
type ClassFilter = 'all' | 'declared';

const CATEGORY_FILTERS: Array<{ key: CategoryFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'power-reactor', label: 'Power reactors' },
  { key: 'fuel-cycle', label: 'Fuel cycle' },
  { key: 'non-power-reactor', label: 'Research reactors' },
  { key: 'materials', label: 'Materials & Agreement State' },
];

function matchesCategory(e: NrcEventWithFacility, filter: CategoryFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'materials') return e.category === 'materials' || e.category === 'agreement-state' || e.category === 'hospital';
  return e.category === filter;
}

/** An emergency classification was declared (Unusual Event or higher). */
function isDeclared(cls: NrcEmergencyClass): boolean {
  return NRC_EMERGENCY_CLASS_RANK[cls] >= NRC_EMERGENCY_CLASS_RANK['unusual-event'];
}

function isScram(e: NrcEventWithFacility): boolean {
  return e.unitStatus.some((u) => u.scramCode !== undefined && !/^n$/i.test(u.scramCode))
    || e.cfrSections.some((c) => /rps actuation/i.test(c.description));
}

function formatDate(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function narrativeHtml(text: string): string {
  if (!text) return '<p class="ner-narrative-empty">No event text published.</p>';
  return text.split(/\n{2,}/).map((p) => {
    const marker = /^\*\s*\*\s*\*/.test(p.trim());
    return `<p${marker ? ' class="ner-marker"' : ''}>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

/**
 * NRC Event Notification Reports: every event licensees reported to the NRC
 * Operations Center in the trailing two weeks, linked to registry sites.
 */
export class NuclearEventReportsPanel extends Panel {
  private data: NrcEventReportsResult | null = null;
  /** Part 21 defect reports and Preliminary Notifications; loaded beside the ENRs, rendered below them. */
  private safety: NrcSafetyReportsResult | null = null;
  private safetyFailed = false;
  private category: CategoryFilter = 'all';
  private classFilter: ClassFilter = 'all';
  private region: NrcRegion | 0 = 0;
  private mySitesOnly = false;
  private expanded: string | null = null;
  private watched = getWatchedFacilityIds();
  /** Snapshot at load so "new" survives this session's own mark-as-seen. */
  private readonly lastSeen = getLastSeenEventNumber();
  private onLocationClick?: (lat: number, lon: number) => void;

  constructor() {
    super({
      id: 'nuclear-events',
      title: 'NRC Event Notifications',
      showCount: true,
      trackActivity: true,
      defaultRowSpan: 2,
      infoTooltip:
        'Event Notification Reports published daily by the NRC Operations Center for the last 14 days: ' +
        'reactor trips, emergency declarations, safety-system actuations, fuel-cycle and materials events. ' +
        'Text is the licensee\'s own report as published by the NRC; updates and retractions are flagged. ' +
        'Informational only — not an official NRC notification channel.',
    });
    this.showLoading('Loading NRC event notifications…');
    window.addEventListener(NUCLEAR_WATCHLIST_CHANGED_EVENT, this.onWatchlistChanged);

    this.content.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const chip = target.closest<HTMLElement>('.ner-cat');
      if (chip?.dataset.category) {
        this.category = chip.dataset.category as CategoryFilter;
        this.render();
        return;
      }
      const toggle = target.closest<HTMLElement>('[data-toggle]');
      if (toggle?.dataset.toggle === 'declared') {
        this.classFilter = this.classFilter === 'declared' ? 'all' : 'declared';
        this.render();
        return;
      }
      if (toggle?.dataset.toggle === 'my-sites') {
        this.mySitesOnly = !this.mySitesOnly;
        this.render();
        return;
      }
      const watch = target.closest<HTMLElement>('.ner-watch');
      if (watch?.dataset.facility) {
        e.stopPropagation();
        this.watched = toggleWatchedFacility(watch.dataset.facility);
        this.render();
        return;
      }
      const locate = target.closest<HTMLElement>('.ner-locate');
      if (locate) {
        e.stopPropagation();
        const lat = Number(locate.dataset.lat);
        const lon = Number(locate.dataset.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) this.onLocationClick?.(lat, lon);
        return;
      }
      if (target.closest('a')) return;
      const row = target.closest<HTMLElement>('.ner-row');
      if (row?.dataset.event) {
        this.expanded = this.expanded === row.dataset.event ? null : row.dataset.event;
        this.render();
      }
    });
    this.content.addEventListener('change', (e) => {
      const select = (e.target as HTMLElement).closest<HTMLSelectElement>('.ner-region');
      if (!select) return;
      const value = Number(select.value);
      this.region = value >= 1 && value <= 4 ? (value as NrcRegion) : 0;
      this.render();
    });
    bindActivationKeys(this.content, '.ner-row');
  }

  public setLocationClickHandler(handler: (lat: number, lon: number) => void): void {
    this.onLocationClick = handler;
  }

  public async fetchData(): Promise<void> {
    void this.fetchSafetyReports();
    try {
      const result = await fetchNrcEventReports();
      if (!result) {
        if (!this.data) this.showError('NRC event notifications unavailable', () => void this.fetchData());
        return;
      }
      this.data = result;
      this.setCount(result.events.length);
      this.render();
      markEventsSeen(result.events);
    } catch (error) {
      console.warn('[NuclearEventReportsPanel] fetch failed', error);
      if (!this.data) this.showError('NRC event notifications unavailable', () => void this.fetchData());
    }
  }

  /** The Part 21 / PN tables are a secondary source: their failure never hides the ENRs. */
  private async fetchSafetyReports(): Promise<void> {
    try {
      const result = await fetchNrcSafetyReports();
      this.safetyFailed = !result;
      if (result) this.safety = result;
    } catch (error) {
      console.warn('[NuclearEventReportsPanel] Part 21 / PN fetch failed', error);
      this.safetyFailed = true;
    }
    if (this.data) this.render();
  }

  private renderSafetyReports(): string {
    const safety = this.safety;
    if (!safety) {
      return `<div class="ner-more">
        <div class="ner-more-head"><span class="ner-more-title">Part 21 defect reports &amp; Preliminary Notifications</span>
        <span class="nrs-unit-meta">${this.safetyFailed ? 'Unavailable right now' : 'Loading…'} · <a href="${NRC_PART21_INDEX}" target="_blank" rel="noopener">Part 21</a> · <a href="${NRC_PRELIMINARY_NOTIFICATIONS_INDEX}" target="_blank" rel="noopener">PNs</a></span></div>
      </div>`;
    }
    const mine = (facilityId: string | undefined) => Boolean(facilityId && this.watched.has(facilityId));
    const part21 = safety.part21.filter((r) => !this.mySitesOnly || mine(r.facilityMatch?.id)).slice(0, PART21_ROWS);
    const pns = safety.preliminaryNotifications.filter((p) => !this.mySitesOnly || mine(p.facilityMatch?.id)).slice(0, PN_ROWS);
    const siteTag = (facility: { id: string; name: string } | undefined) =>
      facility ? `<span class="ner-flag${this.watched.has(facility.id) ? ' ner-flag-watched' : ''}">${this.watched.has(facility.id) ? '★ ' : ''}${escapeHtml(facility.name)}</span>` : '';
    const part21Rows = part21.map((r) => `
      <tr class="nrs-row">
        <td class="ner-date">${escapeHtml(formatDate(r.reportDate))}<div class="nrs-unit-meta">${r.url ? `<a href="${escapeHtml(r.url)}" target="_blank" rel="noopener">${escapeHtml(r.logNumber)}</a>` : escapeHtml(r.logNumber)}</div></td>
        <td class="ner-main"><div class="ner-title">${escapeHtml(r.description)}</div><div class="nrs-unit-meta">${escapeHtml(r.notifier)}${r.accession ? ` · ${escapeHtml(r.accession)}` : ''} ${siteTag(r.facilityMatch)}</div></td>
      </tr>`).join('');
    const pnRows = pns.map((p) => `
      <tr class="nrs-row">
        <td class="ner-date">${escapeHtml(formatDate(p.date))}<div class="nrs-unit-meta">${p.url ? `<a href="${escapeHtml(p.url)}" target="_blank" rel="noopener">${escapeHtml(p.number)}</a>` : escapeHtml(p.number)}</div></td>
        <td class="ner-main"><div class="ner-title">${escapeHtml(p.description)}</div><div class="nrs-unit-meta">${p.region ? `Region ${escapeHtml(p.region)} ` : ''}${siteTag(p.facilityMatch)}</div></td>
      </tr>`).join('');
    const empty = (what: string) => `<div class="panel-empty">${escapeHtml(this.mySitesOnly ? `No ${what} name a watched site.` : `No ${what} published yet this year.`)}</div>`;
    return `<div class="ner-more">
      <div class="ner-more-head">
        <span class="ner-more-title">Part 21 defect reports</span>
        <span class="nrs-unit-meta">10 CFR Part 21 vendor and licensee notifications · <a href="${NRC_PART21_INDEX}" target="_blank" rel="noopener">all reports</a></span>
      </div>
      ${part21Rows ? `<table class="nrs-table ner-table ner-more-table"><tbody>${part21Rows}</tbody></table>` : empty('Part 21 reports')}
      <div class="ner-more-head">
        <span class="ner-more-title">Preliminary Notifications</span>
        <span class="nrs-unit-meta">NRC regional early notices of significant events · <a href="${NRC_PRELIMINARY_NOTIFICATIONS_INDEX}" target="_blank" rel="noopener">all PNs</a></span>
      </div>
      ${pnRows ? `<table class="nrs-table ner-table ner-more-table"><tbody>${pnRows}</tbody></table>` : empty('Preliminary Notifications')}
    </div>`;
  }

  private filtered(): NrcEventWithFacility[] {
    if (!this.data) return [];
    return this.data.events.filter((e) =>
      matchesCategory(e, this.category)
      && (this.classFilter === 'all' || isDeclared(e.emergencyClass))
      && (this.region === 0 || e.region === this.region)
      && (!this.mySitesOnly || (e.facilityMatch !== undefined && this.watched.has(e.facilityMatch.id))));
  }

  private renderDetail(e: NrcEventWithFacility): string {
    const site = e.facilityMatch;
    const units = e.unitStatus.length
      ? `<table class="ner-units"><thead><tr><th>Unit</th><th>Scram</th><th>Initial</th><th>Current</th></tr></thead><tbody>${e.unitStatus.map((u) => `
          <tr><td>${escapeHtml(u.unit)}</td><td>${escapeHtml(u.scramCode ?? '—')}</td>
          <td>${u.initialPower ?? '—'}% ${escapeHtml(u.initialMode ?? '')}</td>
          <td>${u.currentPower ?? '—'}% ${escapeHtml(u.currentMode ?? '')}</td></tr>`).join('')}</tbody></table>`
      : '';
    const cfr = e.cfrSections.length
      ? `<ul class="ner-cfr">${e.cfrSections.map((c) => `<li><code>${escapeHtml(c.code)}</code>${c.description ? ` ${escapeHtml(c.description)}` : ''}</li>`).join('')}</ul>`
      : '';
    const facts = [
      ['Notified', `${formatDate(e.notificationDate)} ${e.notificationTime ?? ''}`],
      ['Event', `${formatDate(e.eventDate)} ${e.eventTime ?? ''}`],
      ['Last update', formatDate(e.lastUpdateDate)],
      ['Emergency class', e.emergencyClassLabel ?? NRC_EMERGENCY_CLASS_LABELS[e.emergencyClass]],
      ['Category', e.categoryLabel],
      ['Reported by', e.reportingOrg ?? '—'],
    ].map(([k, v]) => `<div><span class="nrs-detail-label">${escapeHtml(k!)}</span><span>${escapeHtml(v!.trim() || '—')}</span></div>`).join('');
    const watching = site ? this.watched.has(site.id) : false;
    return `<tr class="nrs-detail ner-detail"><td colspan="3">
        <div class="nrs-detail-grid">${facts}</div>
        ${units}${cfr}
        <div class="ner-narrative">${narrativeHtml(e.narrative)}</div>
        <div class="ner-actions">
          ${site ? `<button type="button" class="nrs-locate ner-locate" data-lat="${site.lat}" data-lon="${site.lon}">Show ${escapeHtml(site.name)} on map</button>
          <button type="button" class="nrs-locate ner-watch${watching ? ' active' : ''}" data-facility="${escapeHtml(site.id)}" aria-pressed="${watching}">${watching ? '★ Watching site' : '☆ Watch site'}</button>` : ''}
          <a class="ner-source" href="${escapeHtml(e.sourceUrl)}" target="_blank" rel="noopener">NRC report ${escapeHtml(e.eventNumber)} ↗</a>
        </div>
      </td></tr>`;
  }

  private readonly onWatchlistChanged = (): void => {
    this.watched = getWatchedFacilityIds();
    this.render();
  };

  public override destroy(): void {
    window.removeEventListener(NUCLEAR_WATCHLIST_CHANGED_EVENT, this.onWatchlistChanged);
    super.destroy();
  }

  private render(): void {
    if (!this.data) return;
    const all = this.data.events;
    const events = this.filtered();

    const chips = CATEGORY_FILTERS.map(({ key, label }) => {
      const count = all.filter((e) => matchesCategory(e, key)).length;
      return `<button type="button" class="nrs-filter ner-cat${this.category === key ? ' active' : ''}" data-category="${key}">${escapeHtml(label)} <span class="nrs-filter-count">${count}</span></button>`;
    }).join('');
    const regionOptions = ([0, 1, 2, 3, 4] as const).map((r) =>
      `<option value="${r}"${this.region === r ? ' selected' : ''}>${r === 0 ? 'All regions' : escapeHtml(NRC_REGION_NAMES[r])}</option>`).join('');

    const rows = events.map((e) => {
      const expanded = this.expanded === e.eventNumber;
      const isNew = this.lastSeen > 0 && Number(e.eventNumber) > this.lastSeen;
      const site = e.facilityMatch;
      const where = [
        site?.name ?? e.facility,
        e.state,
        e.region ? `Region ${e.region}` : '',
        e.units.length ? `Unit${e.units.length > 1 ? 's' : ''} ${e.units.join(', ')}` : '',
      ].filter(Boolean).map((p) => escapeHtml(p!)).join(' · ');
      const flags = [
        e.sample ? '<span class="ner-flag ner-flag-sample" title="Simulated for demonstration; this event did not occur">Sample</span>' : '',
        isNew ? '<span class="ner-flag ner-flag-new">New</span>' : '',
        e.retracted ? '<span class="ner-flag ner-flag-retracted">Retracted</span>' : '',
        !e.retracted && e.updated ? '<span class="ner-flag ner-flag-updated">Updated</span>' : '',
        isScram(e) ? '<span class="ner-flag ner-flag-scram">Reactor trip</span>' : '',
        site && this.watched.has(site.id) ? '<span class="ner-flag ner-flag-watched">★ My site</span>' : '',
      ].join('');
      return `
        <tr class="nrs-row ner-row${expanded ? ' expanded' : ''}${e.retracted ? ' ner-retracted' : ''}" data-event="${escapeHtml(e.eventNumber)}" tabindex="0" aria-expanded="${expanded}">
          <td class="ner-class"><span class="ner-badge ner-badge-${e.emergencyClass}">${escapeHtml(NRC_EMERGENCY_CLASS_LABELS[e.emergencyClass])}</span></td>
          <td class="ner-main">
            <div class="ner-title">${escapeHtml(e.title)}</div>
            <div class="nrs-unit-meta">${where}</div>
            <div class="ner-flags">${flags}<span class="ner-cat-label">${escapeHtml(NRC_EVENT_CATEGORY_LABELS[e.category])}</span></div>
          </td>
          <td class="ner-date">${escapeHtml(formatDate(e.notificationDate ?? e.reportDate))}<div class="nrs-unit-meta">#${escapeHtml(e.eventNumber)}</div></td>
        </tr>${expanded ? this.renderDetail(e) : ''}`;
    }).join('');

    const declared = all.filter((e) => !e.retracted && isDeclared(e.emergencyClass)).length;
    const scrams = all.filter((e) => !e.retracted && isScram(e)).length;
    const powerReactor = all.filter((e) => e.category === 'power-reactor').length;
    const atMySites = all.filter((e) => e.facilityMatch && this.watched.has(e.facilityMatch.id)).length;
    const newCount = this.lastSeen > 0 ? all.filter((e) => Number(e.eventNumber) > this.lastSeen).length : 0;

    const emptyText = this.mySitesOnly && this.watched.size === 0
      ? 'You are not watching any sites yet. Open an event at a registry site and choose “Watch site”.'
      : 'No events match these filters.';
    const { daysCovered, daysMissing, daysFailed } = this.data;

    const html = `
      <div class="nrs-summary">
        <div class="nrs-card"><span class="nrs-card-label">Events (14 d)</span><span class="nrs-card-value">${all.length}</span></div>
        <div class="nrs-card"><span class="nrs-card-label">Power reactor</span><span class="nrs-card-value">${powerReactor}</span></div>
        <div class="nrs-card nrs-card-reduced"><span class="nrs-card-label">Reactor trips</span><span class="nrs-card-value">${scrams}</span></div>
        <div class="nrs-card nrs-card-off"><span class="nrs-card-label">Emergency declared</span><span class="nrs-card-value">${declared}</span></div>
        <div class="nrs-card"><span class="nrs-card-label">At my sites</span><span class="nrs-card-value">${atMySites}</span></div>
        <div class="nrs-card"><span class="nrs-card-label">New since last visit</span><span class="nrs-card-value">${newCount}</span></div>
      </div>
      <div class="nrs-filters">${chips}</div>
      <div class="nrs-filters ner-toolbar">
        <button type="button" class="nrs-filter${this.classFilter === 'declared' ? ' active' : ''}" data-toggle="declared" aria-pressed="${this.classFilter === 'declared'}">Unusual Event or higher</button>
        <button type="button" class="nrs-filter${this.mySitesOnly ? ' active' : ''}" data-toggle="my-sites" aria-pressed="${this.mySitesOnly}">★ My sites <span class="nrs-filter-count">${this.watched.size}</span></button>
        <select class="ner-region" aria-label="NRC region">${regionOptions}</select>
      </div>
      ${events.length
        ? `<table class="nrs-table ner-table"><thead><tr><th>Class</th><th>Event</th><th>Notified</th></tr></thead><tbody>${rows}</tbody></table>`
        : `<div class="panel-empty">${escapeHtml(emptyText)}</div>`}
      ${this.renderSafetyReports()}
      <div class="nrs-footer">
        Source: <a href="${NRC_EVENT_REPORTS_INDEX}" target="_blank" rel="noopener">NRC Event Notification Reports</a>
        · ${daysCovered} daily report${daysCovered === 1 ? '' : 's'}${daysMissing ? `, ${daysMissing} day${daysMissing === 1 ? '' : 's'} without a report` : ''}${daysFailed ? `, ${daysFailed} failed to load` : ''}
        ${this.data.sampleCount ? ` · ${this.data.sampleCount} simulated sample event${this.data.sampleCount === 1 ? '' : 's'} shown for demonstration` : ''}
        · Informational only; confirm against the NRC record.
      </div>
    `;
    this.setSafeContent(unsafeRawHtml(html, 'NuclearEventReportsPanel render: all dynamic values escaped'));
  }
}
