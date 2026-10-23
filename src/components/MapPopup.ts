import { getNrcRegion, NRC_REGION_NAMES, nrcFacilityResearchLinks, US_NUCLEAR_CATEGORY_LABELS, US_NUCLEAR_STATUS_LABELS, type UsNuclearFacility } from '@/config/us-nuclear-facilities';
import type { NewsItem, NewsLocationMarker, NuclearFacility, GammaIrradiator, Pipeline, UnderseaCable, CableAdvisory, RepairShip, InternetOutage, AIDataCenter, NaturalEvent } from '@/types';
import type { Earthquake } from '@/services/earthquakes';
import type { WeatherAlert } from '@/services/weather';
import type { RadiationObservation } from '@/services/radiation';
import { UNDERSEA_CABLES } from '@/config/geo-map';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { corroborationLabelHtml } from '@/utils/corroboration-flag';
import { isMobileDevice } from '@/utils';
import { t } from '@/services/i18n';
import { getNaturalEventIcon } from '@/services/eonet';
import { getCableHealthRecord } from '@/services/cable-health';
import { overlayHistory, type OverlayCloseOrigin, type OverlayOpenHandle } from '@/utils/overlay-history';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';

/** A news marker's popup: its title and, when known, the cluster's corroboration (#9213). */
type NewsPopupData = Pick<NewsLocationMarker, 'title' | 'corroboration'>;

export type PopupType = 'earthquake' | 'weather' | 'nuclear' | 'usNuclear' | 'irradiator' | 'pipeline' | 'cable' | 'cable-advisory' | 'repair-ship' | 'outage' | 'datacenter' | 'datacenterCluster' | 'natEvent' | 'radiation' | 'news';

interface DatacenterClusterData {
  items: AIDataCenter[];
  region: string;
  country: string;
  count?: number;
  totalChips?: number;
  totalPowerMW?: number;
  existingCount?: number;
  plannedCount?: number;
  sampled?: boolean;
}

interface PopupData {
  type: PopupType;
  data: Earthquake | WeatherAlert | NuclearFacility | UsNuclearFacility | GammaIrradiator | Pipeline | UnderseaCable | CableAdvisory | RepairShip | InternetOutage | AIDataCenter | DatacenterClusterData | NaturalEvent | RadiationObservation | NewsPopupData;
  relatedNews?: NewsItem[];
  x: number;
  y: number;
}

export class MapPopup {
  private container: HTMLElement;
  private popup: HTMLElement | null = null;
  private onClose?: () => void;
  private cableAdvisories: CableAdvisory[] = [];
  private repairShips: RepairShip[] = [];
  private isMobileSheet = false;
  private sheetTouchStartY: number | null = null;
  private sheetCurrentOffset = 0;
  private readonly mobileDismissThreshold = 96;
  private outsideListenerTimeoutId: number | null = null;
  private mapPopupHistoryOpen: OverlayOpenHandle | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public show(data: PopupData): void {
    this.hide('replacement');

    this.isMobileSheet = isMobileDevice();
    this.popup = document.createElement('div');
    this.popup.className = this.isMobileSheet ? 'map-popup map-popup-sheet' : 'map-popup';

    const content = this.renderContent(data);
    setTrustedHtml(this.popup, trustedHtml(this.isMobileSheet
      ? `<button class="map-popup-sheet-handle" aria-label="${t('common.close')}"></button>${content}`
      : content, "legacy direct innerHTML migration"));

    // Get container's viewport position for absolute positioning
    const containerRect = this.container.getBoundingClientRect();

    if (this.isMobileSheet) {
      this.popup.style.left = '';
      this.popup.style.top = '';
      this.popup.style.transform = '';
    } else {
      this.positionDesktopPopup(data, containerRect);
    }

    // Append to body to avoid container overflow clipping
    document.body.appendChild(this.popup);

    // Reconcile the cached height against reality AFTER the frame has painted.
    // rAF alone is not enough: rAF callbacks run before that frame's paint, and
    // INP measures input→next paint, so an offsetHeight read there is still
    // inside the interaction window. rAF + setTimeout(0) lands after it.
    // The element is captured so a popup opened in the meantime (show() builds a
    // fresh node) cannot be measured and filed under this popup's type.
    if (!this.isMobileSheet) {
      const popupType = data.type;
      const openedPopup = this.popup;
      // Captured now: positionDesktopPopup has already run, so this is the height
      // THIS popup was placed with.
      const positionedWith = this.lastPositionedHeight;
      requestAnimationFrame(() => {
        setTimeout(() => {
          if (this.popup !== openedPopup) return;
          this.refreshHeightCache(popupType, data, containerRect, positionedWith);
        }, 0);
      });
    }

    // Close button handler via event delegation on the popup element.
    // This avoids re-querying and re-attaching listeners after innerHTML.
    this.popup.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.popup-close') || target.closest('.map-popup-sheet-handle')) {
        this.hide();
        return;
      }
      const toggle = target.closest('.cluster-toggle') as HTMLButtonElement | null;
      if (toggle) {
        const hidden = toggle.previousElementSibling as HTMLElement | null;
        if (!hidden) return;
        const expanded = hidden.style.display !== 'none';
        hidden.style.display = expanded ? 'none' : '';
        toggle.textContent = expanded ? (toggle.dataset.more ?? '') : (toggle.dataset.less ?? '');
      }
    });

    if (this.isMobileSheet) {
      this.mapPopupHistoryOpen = overlayHistory.openCancelable('map-popup', (origin) => this.hide(origin));
      this.popup.addEventListener('touchstart', this.handleSheetTouchStart, { passive: true });
      this.popup.addEventListener('touchmove', this.handleSheetTouchMove, { passive: false });
      this.popup.addEventListener('touchend', this.handleSheetTouchEnd);
      this.popup.addEventListener('touchcancel', this.handleSheetTouchEnd);
      const popup = this.popup;
      requestAnimationFrame(() => {
        if (this.popup !== popup) return;
        popup.classList.add('open');
        // Remove will-change after slide-in transition to free GPU memory
        popup.addEventListener('transitionend', () => {
          if (this.popup === popup) popup.style.willChange = 'auto';
        }, { once: true });
      });
    }

    // Click outside to close
    if (this.outsideListenerTimeoutId !== null) {
      window.clearTimeout(this.outsideListenerTimeoutId);
    }
    this.outsideListenerTimeoutId = window.setTimeout(() => {
      document.addEventListener('click', this.handleOutsideClick);
      document.addEventListener('touchstart', this.handleOutsideClick);
      document.addEventListener('keydown', this.handleEscapeKey);
      this.outsideListenerTimeoutId = null;
    }, 0);
  }

  /**
   * Measured desktop popup height, keyed by popup type (#4487 INP).
   *
   * Reading `offsetHeight` forces a synchronous layout of the whole document,
   * and this ran inside the click handler of every marker across all three map
   * renderers — the append/measure/remove dance below was a full layout flush on
   * the very task INP measures. Heights are near-constant per popup type, so the
   * first popup of a type pays the measurement and every later one reuses it.
   *
   * Static so the cache survives the per-open `MapPopup` churn. A stale entry is
   * self-correcting in the direction that matters: an under-estimate is pulled
   * back by `clampPopupToViewport`, and `refreshHeightCache` re-measures after
   * paint — off the interaction critical path — so the entry converges.
   */
  private static readonly heightByType = new Map<string, number>();

  /** Height delta worth a visible reposition after the post-paint re-measure. */
  private static readonly HEIGHT_DRIFT_PX = 12;

  /** Height `applyDesktopPosition` last used, so the re-measure can detect drift. */
  private lastPositionedHeight: number | null = null;

  private positionDesktopPopup(data: PopupData, containerRect: DOMRect): void {
    if (!this.popup) return;

    const cached = MapPopup.heightByType.get(data.type);
    if (cached !== undefined) {
      this.applyDesktopPosition(data, containerRect, cached);
      return;
    }

    // First popup of this type: measure off-screen, then remember it.
    this.popup.style.visibility = 'hidden';
    this.popup.style.top = '0';
    this.popup.style.left = '-9999px';
    document.body.appendChild(this.popup);
    const popupHeight = this.popup.offsetHeight;
    document.body.removeChild(this.popup);
    this.popup.style.visibility = '';
    MapPopup.heightByType.set(data.type, popupHeight);

    this.applyDesktopPosition(data, containerRect, popupHeight);
  }

  /**
   * Re-measure the open popup, update the type cache, and correct the position
   * if the height we positioned with was materially wrong.
   *
   * Repositioning matters because the cache key is the popup TYPE, and some
   * types are not one layout (a cable popup with or without advisories, a
   * natural event with or without agency rows), so height varies within the key. Clamping alone only rescues downward overflow; an over-estimate would
   * otherwise leave the popup flipped above the click for no reason.
   */
  private refreshHeightCache(
    type: string,
    data: PopupData,
    containerRect: DOMRect,
    positionedWith: number | null,
  ): void {
    if (!this.popup || this.isMobileSheet) return;
    const measured = this.popup.offsetHeight;
    if (measured <= 0) return;
    MapPopup.heightByType.set(type, measured);

    // Sub-pixel and single-line differences are not worth a visible move.
    if (positionedWith !== null && Math.abs(measured - positionedWith) > MapPopup.HEIGHT_DRIFT_PX) {
      this.applyDesktopPosition(data, containerRect, measured);
      return;
    }
    this.clampPopupToViewport();
  }

  private applyDesktopPosition(data: PopupData, containerRect: DOMRect, popupHeight: number): void {
    if (!this.popup) return;
    this.lastPositionedHeight = popupHeight;

    const popupWidth = 380;
    const bottomBuffer = 50; // Buffer from viewport bottom
    const topBuffer = 60; // Header height

    // Convert container-relative coords to viewport coords
    const viewportX = containerRect.left + data.x;
    const viewportY = containerRect.top + data.y;

    // Horizontal positioning (viewport-relative)
    const maxX = window.innerWidth - popupWidth - 20;
    let left = viewportX + 20;
    if (left > maxX) {
      // Position to the left of click if it would overflow right
      left = Math.max(10, viewportX - popupWidth - 20);
    }

    // Vertical positioning - prefer below click, but flip above if needed
    const availableBelow = window.innerHeight - viewportY - bottomBuffer;
    const availableAbove = viewportY - topBuffer;

    let top: number;
    if (availableBelow >= popupHeight) {
      // Enough space below - position below click
      top = viewportY + 10;
    } else if (availableAbove >= popupHeight) {
      // Not enough below, but enough above - position above click
      top = viewportY - popupHeight - 10;
    } else {
      // Limited space both ways - position at top buffer
      top = topBuffer;
    }

    // CRITICAL: Ensure popup stays within viewport vertically
    top = Math.max(topBuffer, top);
    const maxTop = window.innerHeight - popupHeight - bottomBuffer;
    if (maxTop > topBuffer) {
      top = Math.min(top, maxTop);
    }

    this.popup.style.left = `${left}px`;
    this.popup.style.top = `${top}px`;
  }

  // Called when the popup ends up taller than the height it was positioned with.
  // Nudges the popup upward so it never extends below the viewport.
  private clampPopupToViewport(): void {
    if (!this.popup || this.isMobileSheet) return;
    const rect = this.popup.getBoundingClientRect();
    const bottomBuffer = 20;
    const topBuffer = 60;
    const overflow = rect.bottom - (window.innerHeight - bottomBuffer);
    if (overflow > 0) {
      const currentTop = Number.parseFloat(this.popup.style.top) || 0;
      this.popup.style.top = `${Math.max(topBuffer, currentTop - overflow)}px`;
    }
  }

  private handleOutsideClick = (e: Event) => {
    if (this.popup && !this.popup.contains(e.target as Node)) {
      this.hide();
    }
  };

  private handleEscapeKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      this.hide();
    }
  };

  private handleSheetTouchStart = (e: TouchEvent): void => {
    if (!this.popup || !this.isMobileSheet || e.touches.length !== 1) return;

    const target = e.target as HTMLElement | null;
    const popupBody = this.popup.querySelector('.popup-body');
    if (target?.closest('.popup-body') && popupBody && popupBody.scrollTop > 0) {
      this.sheetTouchStartY = null;
      return;
    }

    this.sheetTouchStartY = e.touches[0]?.clientY ?? null;
    this.sheetCurrentOffset = 0;
    this.popup.classList.add('dragging');
  };

  private handleSheetTouchMove = (e: TouchEvent): void => {
    if (!this.popup || !this.isMobileSheet || this.sheetTouchStartY === null) return;

    const currentY = e.touches[0]?.clientY;
    if (currentY == null) return;

    const delta = Math.max(0, currentY - this.sheetTouchStartY);
    if (delta <= 0) return;

    this.sheetCurrentOffset = delta;
    this.popup.style.transform = `translate3d(0, ${delta}px, 0)`;
    e.preventDefault();
  };

  private handleSheetTouchEnd = (): void => {
    if (!this.popup || !this.isMobileSheet || this.sheetTouchStartY === null) return;

    const shouldDismiss = this.sheetCurrentOffset >= this.mobileDismissThreshold;
    this.popup.classList.remove('dragging');
    this.sheetTouchStartY = null;

    if (shouldDismiss) {
      this.hide();
      return;
    }

    this.sheetCurrentOffset = 0;
    this.popup.style.transform = '';
    this.popup.classList.add('open');
  };

  public hide(origin: OverlayCloseOrigin = 'control'): void {
    this.mapPopupHistoryOpen?.cancel();
    this.mapPopupHistoryOpen = null;

    if (this.outsideListenerTimeoutId !== null) {
      window.clearTimeout(this.outsideListenerTimeoutId);
      this.outsideListenerTimeoutId = null;
    }

    if (this.popup) {
      if (this.isMobileSheet && origin === 'control') overlayHistory.close('map-popup');
      this.popup.removeEventListener('touchstart', this.handleSheetTouchStart);
      this.popup.removeEventListener('touchmove', this.handleSheetTouchMove);
      this.popup.removeEventListener('touchend', this.handleSheetTouchEnd);
      this.popup.removeEventListener('touchcancel', this.handleSheetTouchEnd);
      this.popup.remove();
      this.popup = null;
      this.isMobileSheet = false;
      this.sheetTouchStartY = null;
      this.sheetCurrentOffset = 0;
      document.removeEventListener('click', this.handleOutsideClick);
      document.removeEventListener('touchstart', this.handleOutsideClick);
      document.removeEventListener('keydown', this.handleEscapeKey);
      this.onClose?.();
    }
  }

  public setOnClose(callback: () => void): void {
    this.onClose = callback;
  }

  public setCableActivity(advisories: CableAdvisory[], repairShips: RepairShip[]): void {
    this.cableAdvisories = advisories;
    this.repairShips = repairShips;
  }

  private renderContent(data: PopupData): string {
    switch (data.type) {
      case 'earthquake':
        return this.renderEarthquakePopup(data.data as Earthquake);
      case 'weather':
        return this.renderWeatherPopup(data.data as WeatherAlert);
      case 'nuclear':
        return this.renderNuclearPopup(data.data as NuclearFacility);
      case 'usNuclear':
        return this.renderUsNuclearPopup(data.data as UsNuclearFacility);
      case 'irradiator':
        return this.renderIrradiatorPopup(data.data as GammaIrradiator);
      case 'pipeline':
        return this.renderPipelinePopup(data.data as Pipeline);
      case 'cable':
        return this.renderCablePopup(data.data as UnderseaCable);
      case 'cable-advisory':
        return this.renderCableAdvisoryPopup(data.data as CableAdvisory);
      case 'repair-ship':
        return this.renderRepairShipPopup(data.data as RepairShip);
      case 'outage':
        return this.renderOutagePopup(data.data as InternetOutage);
      case 'datacenter':
        return this.renderDatacenterPopup(data.data as AIDataCenter);
      case 'datacenterCluster':
        return this.renderDatacenterClusterPopup(data.data as DatacenterClusterData);
      case 'natEvent':
        return this.renderNaturalEventPopup(data.data as NaturalEvent);
      case 'news':
        return this.renderNewsPopup(data.data as NewsPopupData);
      case 'radiation':
        return this.renderRadiationPopup(data.data as RadiationObservation);
      default:
        return '';
    }
  }

  private renderNewsPopup(news: NewsPopupData): string {
    const coverage = corroborationLabelHtml(news.corroboration);
    return `
      <div class="popup-header">
        <span class="popup-title">${t('components.deckgl.tooltip.news')}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body"><p>${escapeHtml(news.title)}</p>${coverage ? `<p>${coverage}</p>` : ''}</div>
    `;
  }

  private renderRadiationPopup(observation: RadiationObservation): string {
    const severityClass = observation.severity === 'spike' ? 'high' : 'medium';
    const delta = `${observation.delta >= 0 ? '+' : ''}${observation.delta.toFixed(1)} ${escapeHtml(observation.unit)}`;
    const provenance = formatRadiationSources(observation);
    const confidence = formatRadiationConfidence(observation.confidence);
    const flags = [
      observation.corroborated ? 'Confirmed' : '',
      observation.conflictingSources ? 'Conflicting sources' : '',
      observation.convertedFromCpm ? 'CPM-derived component' : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="popup-header outage">
        <span class="popup-title">☢ ${escapeHtml(observation.location.toUpperCase())}</span>
        <span class="popup-badge ${severityClass}">${escapeHtml(observation.severity.toUpperCase())}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">Reading</span>
            <span class="stat-value">${observation.value.toFixed(1)} ${escapeHtml(observation.unit)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">Baseline</span>
            <span class="stat-value">${observation.baselineValue.toFixed(1)} ${escapeHtml(observation.unit)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">Delta</span>
            <span class="stat-value">${delta}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">Confidence</span>
            <span class="stat-value">${escapeHtml(confidence)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">Sources</span>
            <span class="stat-value">${escapeHtml(provenance)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">Source count</span>
            <span class="stat-value">${observation.sourceCount}</span>
          </div>
        </div>
        <p class="popup-description">${escapeHtml(observation.country)} · z-score ${observation.zScore.toFixed(2)} · ${escapeHtml(observation.freshness)}${flags ? ` · ${escapeHtml(flags)}` : ''}</p>
      </div>
    `;
  }


  private renderEarthquakePopup(earthquake: Earthquake): string {
    const severity = earthquake.magnitude >= 6 ? 'high' : earthquake.magnitude >= 5 ? 'medium' : 'low';
    const severityLabel = earthquake.magnitude >= 6 ? t('popups.earthquake.levels.major') : earthquake.magnitude >= 5 ? t('popups.earthquake.levels.moderate') : t('popups.earthquake.levels.minor');

    const timeAgo = this.getTimeAgo(new Date(earthquake.occurredAt));
    const isNrcan = earthquake.source === 'nrcan';
    const sourceName = isNrcan ? 'Earthquakes Canada' : 'USGS';
    const sourceLinkLabel = isNrcan ? t('popups.viewNRCan') : t('popups.viewUSGS');

    return `
      <div class="popup-header earthquake">
        <span class="popup-title magnitude">M${earthquake.magnitude.toFixed(1)}</span>
        <span class="popup-badge ${severity}">${severityLabel}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <p class="popup-location">${escapeHtml(earthquake.place)}</p>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.depth')}</span>
            <span class="stat-value">${earthquake.depthKm.toFixed(1)} km</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${(earthquake.location?.latitude ?? 0).toFixed(2)}°, ${(earthquake.location?.longitude ?? 0).toFixed(2)}°</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.time')}</span>
            <span class="stat-value">${timeAgo}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.source')}</span>
            <span class="stat-value">${sourceName}</span>
          </div>
        </div>
        <a href="${sanitizeUrl(earthquake.sourceUrl)}" target="_blank" class="popup-link">${sourceLinkLabel} →</a>
      </div>
    `;
  }

  private getTimeAgo(date: Date): string {
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return t('popups.timeAgo.s', { count: seconds });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('popups.timeAgo.m', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('popups.timeAgo.h', { count: hours });
    const days = Math.floor(hours / 24);
    return t('popups.timeAgo.d', { count: days });
  }

  private renderWeatherPopup(alert: WeatherAlert): string {
    const severityClass = escapeHtml(alert.severity.toLowerCase());
    const expiresIn = this.getTimeUntil(alert.expires);

    return `
      <div class="popup-header weather ${severityClass}">
        <span class="popup-title">${escapeHtml(alert.event.toUpperCase())}</span>
        <span class="popup-badge ${severityClass}">${escapeHtml(alert.severity.toUpperCase())}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <p class="popup-headline">${escapeHtml(alert.headline)}</p>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.area')}</span>
            <span class="stat-value">${escapeHtml(alert.areaDesc)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.expires')}</span>
            <span class="stat-value">${expiresIn}</span>
          </div>
        </div>
        <p class="popup-description">${escapeHtml(alert.description.slice(0, 300))}${alert.description.length > 300 ? '...' : ''}</p>
      </div>
    `;
  }

  private getTimeUntil(date: Date | string): string {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return '—';
    const ms = d.getTime() - Date.now();
    if (ms <= 0) return t('popups.expired');
    const hours = Math.floor(ms / (1000 * 60 * 60));
    if (hours < 1) return `${Math.floor(ms / (1000 * 60))}${t('popups.timeUnits.m')}`;
    if (hours < 24) return `${hours}${t('popups.timeUnits.h')}`;
    return `${Math.floor(hours / 24)}${t('popups.timeUnits.d')}`;
  }

  private renderUsNuclearPopup(facility: UsNuclearFacility): string {
    const region = getNrcRegion(facility.state);
    const units = (facility.units ?? []).filter((u) => u.status === 'operating' || u.status === 'restarting' || u.status === 'construction' || u.status === 'licensing');
    const netMwe = units.reduce((sum, u) => sum + (u.netMwe ?? 0), 0);
    const statusBadge: Record<string, string> = {
      operating: 'elevated',
      restarting: 'elevated',
      construction: 'elevated',
      licensing: 'low',
      decommissioning: 'low',
      'isfsi-only': 'low',
      decommissioned: 'low',
      legacy: 'low',
      dormant: 'low',
      standby: 'low',
    };
    const unitRows = (facility.units ?? []).slice(0, 6).map((u) => `
            <tr>
              <td>${escapeHtml(u.name)}</td>
              <td>${escapeHtml(u.type)}</td>
              <td>${u.netMwe ?? (u.thermalMw !== undefined ? `${u.thermalMw} MWt` : '—')}</td>
              <td>${escapeHtml(u.status)}${u.licenseExpires ? ` · lic. ${u.licenseExpires}` : ''}${u.shutdownYear ? ` · ${u.shutdownYear}` : ''}</td>
            </tr>`).join('');

    return `
      <div class="popup-header nuclear">
        <span class="popup-title">${escapeHtml(facility.name.toUpperCase())}</span>
        <span class="popup-badge ${statusBadge[facility.status] || 'low'}">${escapeHtml(US_NUCLEAR_STATUS_LABELS[facility.status].toUpperCase())}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.type')}</span>
            <span class="stat-value">${escapeHtml(US_NUCLEAR_CATEGORY_LABELS[facility.category])}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">Operator</span>
            <span class="stat-value">${escapeHtml(facility.operator)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">Regulator</span>
            <span class="stat-value">${escapeHtml(facility.regulator)}${region ? ` · ${escapeHtml(NRC_REGION_NAMES[region])}` : ''}</span>
          </div>
          ${units.length ? `<div class="popup-stat">
            <span class="stat-label">Units</span>
            <span class="stat-value">${units.length}${netMwe ? ` · ${netMwe.toLocaleString()} MWe` : ''}</span>
          </div>` : ''}
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${escapeHtml(facility.city ? `${facility.city}, ${facility.state}` : facility.state)} · ${facility.lat.toFixed(2)}°, ${facility.lon.toFixed(2)}°</span>
          </div>
        </div>
        ${facility.notes ? `<p class="popup-description">${escapeHtml(facility.notes)}</p>` : ''}
        ${unitRows ? `<div class="popup-section"><table class="popup-table us-nuclear-units"><thead><tr><th>Unit</th><th>Type</th><th>MWe</th><th>Status</th></tr></thead><tbody>${unitRows}</tbody></table></div>` : ''}
        <div class="popup-section popup-links">
          ${facility.url ? `<a href="${escapeHtml(facility.url)}" target="_blank" rel="noopener">Reference page</a>` : ''}
          ${nrcFacilityResearchLinks(facility).slice(0, 3).map((l) => `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`).join('')}
          ${facility.isfsi ? '<span class="popup-tag">Spent fuel stored on site (ISFSI)</span>' : ''}
        </div>
      </div>
    `;
  }

  private renderNuclearPopup(facility: NuclearFacility): string {
    const typeLabels: Record<string, string> = {
      'plant': t('popups.nuclear.types.plant'),
      'enrichment': t('popups.nuclear.types.enrichment'),
      'weapons': t('popups.nuclear.types.weapons'),
      'research': t('popups.nuclear.types.research'),
      'reprocessing': t('popups.nuclear.types.reprocessing'),
      'test-site': t('popups.nuclear.types.testSite'),
    };
    const statusColors: Record<string, string> = {
      'active': 'elevated',
      'contested': 'high',
      'decommissioned': 'low',
    };

    return `
      <div class="popup-header nuclear">
        <span class="popup-title">${escapeHtml(facility.name.toUpperCase())}</span>
        <span class="popup-badge ${statusColors[facility.status] || 'low'}">${escapeHtml(facility.status.toUpperCase())}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.type')}</span>
            <span class="stat-value">${escapeHtml(typeLabels[facility.type] || facility.type.toUpperCase())}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.status')}</span>
            <span class="stat-value">${escapeHtml(facility.status.toUpperCase())}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${facility.lat.toFixed(2)}°, ${facility.lon.toFixed(2)}°</span>
          </div>
        </div>
        <p class="popup-description">${t('popups.nuclear.description')}</p>
        ${(facility.operationalSince || facility.treaties?.length || facility.iaeaStatus || facility.keyEvents?.length) ? `
        <div class="popup-section">
          <details>
            <summary>📜 HISTORICAL PROFILE</summary>
            <div class="popup-section-content">
              ${facility.operationalSince ? `
              <div class="popup-stat">
                <span class="stat-label">OPERATIONAL SINCE</span>
                <span class="stat-value">${escapeHtml(facility.operationalSince)}</span>
              </div>` : ''}
              ${facility.treaties?.length ? `
              <div class="popup-stat">
                <span class="stat-label">TREATIES</span>
                <span class="stat-value">${facility.treaties.map(escapeHtml).join(', ')}</span>
              </div>` : ''}
              ${facility.iaeaStatus ? `
              <div class="popup-stat">
                <span class="stat-label">IAEA STATUS</span>
                <span class="stat-value">${escapeHtml(facility.iaeaStatus)}</span>
              </div>` : ''}
              ${facility.keyEvents?.length ? `
              <div class="popup-stat">
                <span class="stat-label">KEY EVENTS</span>
                <span class="stat-value">${facility.keyEvents.map(escapeHtml).join('<br>')}</span>
              </div>` : ''}
            </div>
          </details>
        </div>` : ''}
      </div>
    `;
  }

  private renderIrradiatorPopup(irradiator: GammaIrradiator): string {
    return `
      <div class="popup-header irradiator">
        <span class="popup-title">☢ ${escapeHtml(irradiator.city.toUpperCase())}</span>
        <span class="popup-badge elevated">${t('popups.gamma')}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${t('popups.irradiator.subtitle')}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.country')}</span>
            <span class="stat-value">${escapeHtml(irradiator.country)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.city')}</span>
            <span class="stat-value">${escapeHtml(irradiator.city)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${irradiator.lat.toFixed(2)}°, ${irradiator.lon.toFixed(2)}°</span>
          </div>
        </div>
        <p class="popup-description">${t('popups.irradiator.description')}</p>
      </div>
    `;
  }


  private renderPipelinePopup(pipeline: Pipeline): string {
    const typeLabels: Record<string, string> = {
      'oil': t('popups.pipeline.types.oil'),
      'gas': t('popups.pipeline.types.gas'),
      'products': t('popups.pipeline.types.products'),
    };
    const typeColors: Record<string, string> = {
      'oil': 'high',
      'gas': 'elevated',
      'products': 'low',
    };
    const statusLabels: Record<string, string> = {
      'operating': t('popups.pipeline.status.operating'),
      'construction': t('popups.pipeline.status.construction'),
    };
    const typeIcon = pipeline.type === 'oil' ? '🛢' : pipeline.type === 'gas' ? '🔥' : '⛽';

    return `
      <div class="popup-header pipeline ${pipeline.type}">
        <span class="popup-title">${typeIcon} ${escapeHtml(pipeline.name.toUpperCase())}</span>
        <span class="popup-badge ${typeColors[pipeline.type] || 'low'}">${escapeHtml(pipeline.type.toUpperCase())}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${typeLabels[pipeline.type] || t('popups.pipeline.title')}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.status')}</span>
            <span class="stat-value">${escapeHtml(statusLabels[pipeline.status] || pipeline.status.toUpperCase())}</span>
          </div>
          ${pipeline.capacity ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.capacity')}</span>
            <span class="stat-value">${escapeHtml(pipeline.capacity)}</span>
          </div>
          ` : ''}
          ${pipeline.length ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.length')}</span>
            <span class="stat-value">${escapeHtml(pipeline.length)}</span>
          </div>
          ` : ''}
          ${pipeline.operator ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.operator')}</span>
            <span class="stat-value">${escapeHtml(pipeline.operator)}</span>
          </div>
          ` : ''}
        </div>
        ${pipeline.countries && pipeline.countries.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.countries')}</span>
            <div class="popup-tags">
              ${pipeline.countries.map(c => `<span class="popup-tag">${escapeHtml(c)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        <p class="popup-description">${t('popups.pipeline.description', { type: pipeline.type, status: pipeline.status === 'operating' ? t('popups.pipelineStatusDesc.operating') : t('popups.pipelineStatusDesc.construction') })}</p>
      </div>
    `;
  }


  private renderCablePopup(cable: UnderseaCable): string {
    const advisory = this.getLatestCableAdvisory(cable.id);
    const repairShip = this.getPriorityRepairShip(cable.id);
    const healthRecord = getCableHealthRecord(cable.id);

    // Health data takes priority over advisory for status display
    let statusLabel: string;
    let statusBadge: string;
    if (healthRecord?.status === 'fault') {
      statusLabel = t('popups.cable.fault');
      statusBadge = 'high';
    } else if (healthRecord?.status === 'degraded') {
      statusLabel = t('popups.cable.degraded');
      statusBadge = 'elevated';
    } else if (advisory) {
      statusLabel = advisory.severity === 'fault' ? t('popups.cable.fault') : t('popups.cable.degraded');
      statusBadge = advisory.severity === 'fault' ? 'high' : 'elevated';
    } else if (healthRecord?.status === 'ok') {
      statusLabel = t('popups.cable.active');
      statusBadge = 'low';
    } else {
      statusLabel = t('popups.unknown');
      statusBadge = 'info';
    }
    const repairEta = repairShip?.eta || advisory?.repairEta;
    const cableName = escapeHtml(cable.name.toUpperCase());
    const safeStatusLabel = escapeHtml(statusLabel);
    const safeRepairEta = repairEta ? escapeHtml(repairEta) : '';
    const advisoryTitle = advisory ? escapeHtml(advisory.title) : '';
    const advisoryImpact = advisory ? escapeHtml(advisory.impact) : '';
    const advisoryDescription = advisory ? escapeHtml(advisory.description) : '';
    const repairShipName = repairShip ? escapeHtml(repairShip.name) : '';
    const repairShipNote = repairShip ? escapeHtml(repairShip.note || t('popups.repairShip.note')) : '';

    return `
      <div class="popup-header cable">
        <span class="popup-title">🌐 ${cableName}</span>
        <span class="popup-badge ${statusBadge}">${cable.major ? t('popups.cable.major') : t('popups.cable.cable')}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${t('popups.cable.subtitle')}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.type')}</span>
            <span class="stat-value">${t('popups.cable.type')}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.waypoints')}</span>
            <span class="stat-value">${cable.points.length}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.status')}</span>
            <span class="stat-value">${safeStatusLabel}</span>
          </div>
          ${repairEta ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.repairEta')}</span>
            <span class="stat-value">${safeRepairEta}</span>
          </div>
          ` : ''}
        </div>
        ${advisory ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.cable.advisory')}</span>
            <div class="popup-tags">
              <span class="popup-tag">${advisoryTitle}</span>
              <span class="popup-tag">${advisoryImpact}</span>
            </div>
            <p class="popup-description">${advisoryDescription}</p>
          </div>
        ` : ''}
        ${repairShip ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.cable.repairDeployment')}</span>
            <div class="popup-tags">
              <span class="popup-tag">${repairShipName}</span>
              <span class="popup-tag">${repairShip.status === 'on-station' ? t('popups.cable.repairStatus.onStation') : t('popups.cable.repairStatus.enRoute')}</span>
            </div>
            <p class="popup-description">${repairShipNote}</p>
          </div>
        ` : ''}
        ${healthRecord?.evidence?.length ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.cable.health.evidence')}</span>
            <ul class="evidence-list">
              ${healthRecord.evidence.map((e) => `<li class="evidence-item"><strong>${escapeHtml(e.source)}</strong>: ${escapeHtml(e.summary)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        <p class="popup-description">${t('popups.cable.description')}</p>
      </div>
    `;
  }

  private renderCableAdvisoryPopup(advisory: CableAdvisory): string {
    const cable = UNDERSEA_CABLES.find((item) => item.id === advisory.cableId);
    const timeAgo = this.getTimeAgo(advisory.reported);
    const statusLabel = advisory.severity === 'fault' ? t('popups.cable.fault') : t('popups.cable.degraded');
    const cableName = escapeHtml(cable?.name.toUpperCase() || advisory.cableId.toUpperCase());
    const advisoryTitle = escapeHtml(advisory.title);
    const advisoryImpact = escapeHtml(advisory.impact);
    const advisoryEta = advisory.repairEta ? escapeHtml(advisory.repairEta) : '';
    const advisoryDescription = escapeHtml(advisory.description);

    return `
      <div class="popup-header cable">
        <span class="popup-title">🚨 ${cableName}</span>
        <span class="popup-badge ${advisory.severity === 'fault' ? 'high' : 'elevated'}">${statusLabel}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${advisoryTitle}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.cableAdvisory.reported')}</span>
            <span class="stat-value">${timeAgo}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.cableAdvisory.impact')}</span>
            <span class="stat-value">${advisoryImpact}</span>
          </div>
          ${advisory.repairEta ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.cableAdvisory.eta')}</span>
            <span class="stat-value">${advisoryEta}</span>
          </div>
          ` : ''}
        </div>
        <p class="popup-description">${advisoryDescription}</p>
      </div>
    `;
  }

  private renderRepairShipPopup(ship: RepairShip): string {
    const cable = UNDERSEA_CABLES.find((item) => item.id === ship.cableId);
    const shipName = escapeHtml(ship.name.toUpperCase());
    const cableLabel = escapeHtml(cable?.name || ship.cableId);
    const shipEta = escapeHtml(ship.eta);
    const shipOperator = ship.operator ? escapeHtml(ship.operator) : '';
    const shipNote = escapeHtml(ship.note || t('popups.repairShip.description'));

    return `
      <div class="popup-header cable">
        <span class="popup-title">🚢 ${shipName}</span>
        <span class="popup-badge elevated">${t('popups.repairShip.badge')}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${cableLabel}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.status')}</span>
            <span class="stat-value">${ship.status === 'on-station' ? t('popups.repairShip.status.onStation') : t('popups.repairShip.status.enRoute')}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.cableAdvisory.eta')}</span>
            <span class="stat-value">${shipEta}</span>
          </div>
          ${ship.operator ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.operator')}</span>
            <span class="stat-value">${shipOperator}</span>
          </div>
          ` : ''}
        </div>
        <p class="popup-description">${shipNote}</p>
      </div>
    `;
  }

  private getLatestCableAdvisory(cableId: string): CableAdvisory | undefined {
    const advisories = this.cableAdvisories.filter((item) => item.cableId === cableId);
    return advisories.reduce<CableAdvisory | undefined>((latest, advisory) => {
      if (!latest) return advisory;
      return advisory.reported.getTime() > latest.reported.getTime() ? advisory : latest;
    }, undefined);
  }

  private getPriorityRepairShip(cableId: string): RepairShip | undefined {
    const ships = this.repairShips.filter((item) => item.cableId === cableId);
    if (ships.length === 0) return undefined;
    const onStation = ships.find((ship) => ship.status === 'on-station');
    return onStation || ships[0];
  }

  private renderOutagePopup(outage: InternetOutage): string {
    const severityColors: Record<string, string> = {
      'total': 'high',
      'major': 'elevated',
      'partial': 'low',
    };
    const severityLabels: Record<string, string> = {
      'total': t('popups.outage.levels.total'),
      'major': t('popups.outage.levels.major'),
      'partial': t('popups.outage.levels.partial'),
    };
    const timeAgo = this.getTimeAgo(outage.pubDate);
    const severityClass = escapeHtml(outage.severity);

    return `
      <div class="popup-header outage ${severityClass}">
        <span class="popup-title">📡 ${escapeHtml(outage.country.toUpperCase())}</span>
        <span class="popup-badge ${severityColors[outage.severity] || 'low'}">${severityLabels[outage.severity] || t('popups.outage.levels.disruption')}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(outage.title)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.severity')}</span>
            <span class="stat-value">${escapeHtml(outage.severity.toUpperCase())}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.outage.reported')}</span>
            <span class="stat-value">${timeAgo}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${outage.lat.toFixed(2)}°, ${outage.lon.toFixed(2)}°</span>
          </div>
        </div>
        ${outage.categories && outage.categories.length > 0 ? `
          <div class="popup-section">
            <span class="section-label">${t('popups.outage.categories')}</span>
            <div class="popup-tags">
              ${outage.categories.slice(0, 5).map(c => `<span class="popup-tag">${escapeHtml(c)}</span>`).join('')}
            </div>
          </div>
        ` : ''}
        ${outage.description ? `<p class="popup-description">${escapeHtml(outage.description.slice(0, 250))}${outage.description.length > 250 ? '...' : ''}</p>` : ''}
        <a href="${sanitizeUrl(outage.link)}" target="_blank" class="popup-link">${t('popups.outage.readReport')} →</a>
      </div>
    `;
  }

  private renderDatacenterPopup(dc: AIDataCenter): string {
    const statusColors: Record<string, string> = {
      'existing': 'normal',
      'planned': 'elevated',
      'decommissioned': 'low',
    };
    const statusLabels: Record<string, string> = {
      'existing': t('popups.datacenter.status.existing'),
      'planned': t('popups.datacenter.status.planned'),
      'decommissioned': t('popups.datacenter.status.decommissioned'),
    };

    const formatNumber = (n: number) => {
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
      return n.toString();
    };

    return `
      <div class="popup-header datacenter ${dc.status}">
        <span class="popup-title">🖥️ ${escapeHtml(dc.name)}</span>
        <span class="popup-badge ${statusColors[dc.status] || 'normal'}">${statusLabels[dc.status] || t('popups.datacenter.status.unknown')}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(dc.owner)} • ${escapeHtml(dc.country)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.gpuChipCount')}</span>
            <span class="stat-value">${formatNumber(dc.chipCount)}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.chipType')}</span>
            <span class="stat-value">${escapeHtml(dc.chipType || t('popups.unknown'))}</span>
          </div>
          ${dc.powerMW ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.power')}</span>
            <span class="stat-value">${dc.powerMW.toFixed(0)} MW</span>
          </div>
          ` : ''}
          ${dc.sector ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.sector')}</span>
            <span class="stat-value">${escapeHtml(dc.sector)}</span>
          </div>
          ` : ''}
        </div>
        ${dc.note ? `<p class="popup-description">${escapeHtml(dc.note)}</p>` : ''}
        <div class="popup-attribution">${t('popups.datacenter.attribution')}</div>
      </div>
    `;
  }

  private renderDatacenterClusterPopup(data: DatacenterClusterData): string {
    const totalCount = data.count ?? data.items.length;
    const totalChips = data.totalChips ?? data.items.reduce((sum, dc) => sum + dc.chipCount, 0);
    const totalPower = data.totalPowerMW ?? data.items.reduce((sum, dc) => sum + (dc.powerMW || 0), 0);
    const existingCount = data.existingCount ?? data.items.filter(dc => dc.status === 'existing').length;
    const plannedCount = data.plannedCount ?? data.items.filter(dc => dc.status === 'planned').length;

    const formatNumber = (n: number) => {
      if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
      if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
      return n.toString();
    };

    const dcListHtml = data.items.slice(0, 8).map(dc => `
      <div class="cluster-item">
        <span class="cluster-item-icon">${dc.status === 'planned' ? '🔨' : '🖥️'}</span>
        <div class="cluster-item-info">
          <span class="cluster-item-name">${escapeHtml(dc.name.slice(0, 40))}${dc.name.length > 40 ? '...' : ''}</span>
          <span class="cluster-item-detail">${escapeHtml(dc.owner)} • ${formatNumber(dc.chipCount)} ${t('popups.datacenter.chips')}</span>
        </div>
      </div>
    `).join('');

    return `
      <div class="popup-header datacenter cluster">
        <span class="popup-title">🖥️ ${t('popups.datacenter.cluster.title', { count: String(totalCount) })}</span>
        <span class="popup-badge elevated">${escapeHtml(data.region)}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(data.country)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.cluster.totalChips')}</span>
            <span class="stat-value">${formatNumber(totalChips)}</span>
          </div>
          ${totalPower > 0 ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.cluster.totalPower')}</span>
            <span class="stat-value">${totalPower.toFixed(0)} MW</span>
          </div>
          ` : ''}
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.cluster.operational')}</span>
            <span class="stat-value">${existingCount}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.datacenter.cluster.planned')}</span>
            <span class="stat-value">${plannedCount}</span>
          </div>
        </div>
        <div class="cluster-list">
          ${dcListHtml}
        </div>
        ${totalCount > 8 ? `<p class="popup-more">${t('popups.datacenter.cluster.moreDataCenters', { count: String(Math.max(0, totalCount - 8)) })}</p>` : ''}
        ${data.sampled ? `<p class="popup-more">${t('popups.datacenter.cluster.sampledSites', { count: String(data.items.length) })}</p>` : ''}
        <div class="popup-attribution">${t('popups.datacenter.attribution')}</div>
      </div>
    `;
  }

  private sanitizeClassToken(value: string | undefined, fallback = 'unknown'): string {
    const token = String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '').replace(/^[^A-Za-z_]/, '');
    return token || fallback;
  }

  private renderNaturalEventPopup(event: NaturalEvent): string {
    const categoryColors: Record<string, string> = {
      severeStorms: 'high',
      wildfires: 'high',
      volcanoes: 'high',
      earthquakes: 'elevated',
      floods: 'elevated',
      landslides: 'elevated',
      drought: 'medium',
      dustHaze: 'low',
      snow: 'low',
      tempExtremes: 'elevated',
      seaLakeIce: 'low',
      waterColor: 'low',
      manmade: 'elevated',
    };
    const icon = getNaturalEventIcon(event.category);
    const severityClass = categoryColors[event.category] || 'low';
    const categoryClass = this.sanitizeClassToken(event.category, 'manmade');
    const timeAgo = this.getTimeAgo(event.date);

    return `
      <div class="popup-header nat-event ${categoryClass}">
        <span class="popup-icon">${icon}</span>
        <span class="popup-title">${escapeHtml(event.categoryTitle.toUpperCase())}</span>
        <span class="popup-badge ${severityClass}">${event.closed ? t('popups.naturalEvent.closed') : t('popups.naturalEvent.active')}</span>
        <button class="popup-close" aria-label="Close">×</button>
      </div>
      <div class="popup-body">
        <div class="popup-subtitle">${escapeHtml(event.title)}</div>
        <div class="popup-stats">
          <div class="popup-stat">
            <span class="stat-label">${t('popups.naturalEvent.reported')}</span>
            <span class="stat-value">${timeAgo}</span>
          </div>
          <div class="popup-stat">
            <span class="stat-label">${t('popups.coordinates')}</span>
            <span class="stat-value">${event.lat.toFixed(2)}°, ${event.lon.toFixed(2)}°</span>
          </div>
          ${event.magnitude ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.magnitude')}</span>
            <span class="stat-value">${event.magnitude}${event.magnitudeUnit ? ` ${escapeHtml(event.magnitudeUnit)}` : ''}</span>
          </div>
          ` : ''}
          ${event.sourceName ? `
          <div class="popup-stat">
            <span class="stat-label">${t('popups.source')}</span>
            <span class="stat-value">${escapeHtml(event.sourceName)}</span>
          </div>
          ` : ''}
        </div>
        ${event.stormName || event.windKt || event.agencyObservations?.length ? this.renderTcDetails(event) : ''}
        ${event.description && !event.windKt ? `<p class="popup-description">${escapeHtml(event.description)}</p>` : ''}
        ${event.sourceUrl ? `<a href="${sanitizeUrl(event.sourceUrl)}" target="_blank" class="popup-link">${t('popups.naturalEvent.viewOnSource', { source: escapeHtml(event.sourceName || t('popups.source')) })} →</a>` : ''}
        <div class="popup-attribution">${t('popups.naturalEvent.attribution')}</div>
      </div>
    `;
  }

  private renderTcDetails(event: NaturalEvent): string {
    const TC_COLORS: Record<number, string> = {
      0: '#5ebaff', 1: '#00faf4', 2: '#ffffcc', 3: '#ffe775', 4: '#ffc140', 5: '#ff6060',
    };
    const cat = event.stormCategory ?? 0;
    const color = TC_COLORS[cat] || TC_COLORS[0];
    const catLabel = event.classification || (cat > 0 ? `Category ${cat}` : t('popups.naturalEvent.tropicalSystem'));
    const agencyObservations = event.agencyObservations ?? [];
    const agencyObservationRows = agencyObservations.map((observation) => {
      const wind = observation.windKt != null
        ? `${observation.windKt} kt${observation.windAveragingPeriodMinutes ? ` (${observation.windAveragingPeriodMinutes}-minute mean)` : ''}`
        : 'Wind not reported';
      const name = observation.sourceName || observation.agency;
      const agencyId = observation.agencyId ? ` · ${observation.agencyId}` : '';
      const status = observation.status ? ` · ${observation.status}` : '';
      return `<div class="popup-stat" style="grid-column: 1 / -1"><span class="stat-label">${escapeHtml(name)}${escapeHtml(agencyId)}</span><span class="stat-value">${escapeHtml(wind + status)}</span></div>`;
    }).join('');

    return `
      <div class="popup-stats">
        ${event.stormName ? `
        <div class="popup-stat" style="grid-column: 1 / -1">
          <span class="stat-label">${t('popups.naturalEvent.storm')}</span>
          <span class="stat-value">${escapeHtml(event.stormName)}</span>
        </div>` : ''}
        <div class="popup-stat">
          <span class="stat-label">${t('popups.naturalEvent.classification')}</span>
          <span class="stat-value" style="color: ${color}">${escapeHtml(catLabel)}</span>
        </div>
        ${event.windKt != null ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.naturalEvent.maxWind')}</span>
          <span class="stat-value">${event.windKt} kt (${Math.round(event.windKt * 1.15078)} mph)</span>
        </div>` : ''}
        ${event.windAveragingPeriodMinutes != null ? `
        <div class="popup-stat">
          <span class="stat-label">Wind average</span>
          <span class="stat-value">${event.windAveragingPeriodMinutes}-minute mean</span>
        </div>` : ''}
        ${event.canonicalId ? `
        <div class="popup-stat">
          <span class="stat-label">Canonical match</span>
          <span class="stat-value">${escapeHtml(event.matchingConfidence || 'Agency identifier')}</span>
        </div>` : ''}
        ${event.pressureMb != null ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.naturalEvent.pressure')}</span>
          <span class="stat-value">${event.pressureMb} mb</span>
        </div>` : ''}
        ${event.movementSpeedKt != null ? `
        <div class="popup-stat">
          <span class="stat-label">${t('popups.naturalEvent.movement')}</span>
          <span class="stat-value">${event.movementDir != null ? event.movementDir + '° at ' : ''}${event.movementSpeedKt} kt</span>
        </div>` : ''}
        ${agencyObservations.length > 0 ? `
        <div class="popup-stat" style="grid-column: 1 / -1">
          <span class="stat-label">Agency observations</span>
          <span class="stat-value">${agencyObservations.length}</span>
        </div>
        ${agencyObservationRows}` : ''}
      </div>
    `;
  }

}

function formatRadiationSources(observation: RadiationObservation): string {
  const uniqueSources = [...new Set(observation.contributingSources)];
  return uniqueSources.length > 0 ? uniqueSources.join(' + ') : observation.source;
}

function formatRadiationConfidence(confidence: RadiationObservation['confidence']): string {
  switch (confidence) {
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    default:
      return 'Low';
  }
}
