import '@/styles/custom-feeds.css';
import { Panel } from './Panel';
import { t } from '@/services/i18n';
import { joinSafeHtml, safeHtml, safeUrlAttr, type SafeHtml } from '@/utils/sanitize';
import {
  fetchCustomFeedPanelItems,
  getCustomFeedPanel,
  onCustomFeedPanelsChanged,
  type CustomFeedPanelSpec,
} from '@/services/custom-feeds';
import type { NewsItem } from '@/types';

const REFRESH_INTERVAL_MS = 10 * 60_000;

function formatTimeAgo(item: NewsItem): string {
  if (item.pubDateMissing) return '';
  const minutes = Math.floor((Date.now() - item.pubDate.getTime()) / 60_000);
  if (minutes < 1) return t('components.customFeeds.justNow');
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function renderItem(item: NewsItem): SafeHtml {
  const href = safeUrlAttr(item.link);
  const title = href.toString()
    ? safeHtml`<a class="item-title" href="${href}" target="_blank" rel="noopener noreferrer">${item.title}</a>`
    : safeHtml`<span class="item-title">${item.title}</span>`;
  return safeHtml`<div class="item custom-feed-item">
      <div class="item-source"><span class="item-source-name">${item.source}</span></div>
      ${title}
      <div class="item-time">${formatTimeAgo(item)}</div>
    </div>`;
}

/**
 * A viewer-defined panel showing the newest items from its own RSS/Atom
 * sources (src/services/custom-feeds.ts). It refreshes itself, so it needs no
 * App-level scheduler entry, and it follows edits made in Settings.
 */
export class CustomFeedPanel extends Panel {
  private spec: CustomFeedPanelSpec;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight: AbortController | null = null;
  private readonly unsubscribe: () => void;

  constructor(spec: CustomFeedPanelSpec) {
    super({
      id: spec.id,
      title: spec.title,
      showCount: true,
      className: 'custom-feed-panel',
      infoTooltip: t('components.customFeeds.panelTooltip'),
      defaultRowSpan: 2,
    });
    this.spec = spec;
    this.unsubscribe = onCustomFeedPanelsChanged(() => this.onSpecChanged());
    this.showLoading();
    void this.fetchData();
    this.refreshTimer = setInterval(() => {
      if (this.element.isConnected && this.isNearViewport()) void this.fetchData();
    }, REFRESH_INTERVAL_MS);
  }

  public getSpec(): CustomFeedPanelSpec {
    return this.spec;
  }

  private onSpecChanged(): void {
    const next = getCustomFeedPanel(this.spec.id);
    // Deletion is handled by the layout, which destroys this panel.
    if (!next) return;
    const sourcesChanged = JSON.stringify(next.sources) !== JSON.stringify(this.spec.sources);
    if (next.title !== this.spec.title) {
      const titleEl = this.header.querySelector('.panel-title');
      if (titleEl) titleEl.textContent = next.title;
    }
    this.spec = next;
    if (sourcesChanged) void this.fetchData();
  }

  public async fetchData(): Promise<void> {
    if (this.spec.sources.length === 0) {
      this.setCount(0);
      this.setSafeContent(safeHtml`<div class="custom-feed-empty">
          <p>${t('components.customFeeds.noSources')}</p>
          <button type="button" class="custom-feed-empty-btn" data-custom-feed-open-settings>${t('components.customFeeds.addSource')}</button>
        </div>`, () => {
        this.content.querySelector('[data-custom-feed-open-settings]')?.addEventListener('click', () => {
          window.dispatchEvent(new CustomEvent('nucmonitor:open-settings', { detail: { tab: 'custom' } }));
        });
      });
      return;
    }
    this.inFlight?.abort();
    const controller = new AbortController();
    this.inFlight = controller;
    try {
      const { items, failed } = await fetchCustomFeedPanelItems(this.spec, controller.signal);
      if (controller.signal.aborted) return;
      if (items.length === 0) {
        this.showError(
          failed.length > 0 ? t('components.customFeeds.loadError') : t('components.customFeeds.noItems'),
          () => void this.fetchData(),
        );
        return;
      }
      this.setCount(items.length);
      const warning = failed.length > 0
        ? safeHtml`<div class="custom-feed-warning">${t('components.customFeeds.someFailed', { sources: failed.map((s) => s.name).join(', ') })}</div>`
        : '';
      this.setSafeContent(safeHtml`${warning}<div class="custom-feed-list">${joinSafeHtml(items.map(renderItem))}</div>`);
    } catch (err) {
      if (this.isAbortError(err) || controller.signal.aborted) return;
      this.showError(t('components.customFeeds.loadError'), () => void this.fetchData());
    } finally {
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  public override destroy(): void {
    this.unsubscribe();
    this.inFlight?.abort();
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    super.destroy();
  }
}
