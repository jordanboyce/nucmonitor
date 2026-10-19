import type { AppContext, AppModule } from '@/app/app-context';
import {
  searchMatchIdentity,
  type SearchMatch,
  type SearchResult,
} from '@/components/search-types';
import type { NewsItem, MapLayers } from '@/types';
import type { Command } from '@/config/commands';
import { SearchModal } from '@/components/SearchModal';
import {
  SITE_VARIANT,
  ALL_PANELS,
  FREE_MAX_PANELS,
  countFreePanelCapUsage,
  getEffectivePanelConfig,
  isFreePanelCapCounted,
  isPanelEntitled,
} from '@/config';
import {
  getAllowedLayerKeys,
  isLayerCommandAllowed,
  isLayerExecutable,
  isLayerEntitled,
} from '@/config/map-layer-definitions';
import type { MapVariant, RendererKind } from '@/config/map-layer-definitions';
import { LAYER_PRESETS, LAYER_KEY_MAP } from '@/config/commands';
import { getCountryBbox } from '@/services/country-geometry';
import { UNDERSEA_CABLES, NUCLEAR_FACILITIES } from '@/config/geo-map';
import { PIPELINES } from '@/config/pipelines';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { trackSearchResultSelected } from '@/services/analytics';
import { t } from '@/services/i18n';
import { saveToStorage, setTheme } from '@/utils';
import { withTimeout } from '@/utils/with-timeout';
import { subscribeWidgetAccess } from '@/services/widget-store';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { hasPremiumAccess } from '@/services/panel-gating';
import { onEntitlementChange } from '@/services/entitlements';
import { subscribeRuntimeConfig } from '@/services/runtime-config';
import {
  runWithAgentAnalyticsSuppressed,
  suppressNextAgentPanelView,
} from '@/services/agent-analytics-privacy';
import { SearchSelectionDispatcher } from '@/app/search-selection-dispatcher';
import { WebMcpSearchController } from '@/app/webmcp-search-controller';
import type {
  DashboardSearchOpenResult,
  DashboardSearchResponse,
  DashboardSearchScope,
} from '@/services/webmcp';
const LAYER_PRESET_PRIMARY_LAYERS: Record<string, (keyof MapLayers)[]> = {
  infra: ['cables', 'pipelines', 'datacenters'],
};

export interface SearchManagerCallbacks {
  /** Enables a currently-disabled panel (CMD+K "Add"). Returns false if blocked (unknown / free-tier cap). */
  enablePanel: (panelId: string, options?: { trackDetailedAnalytics?: boolean }) => boolean;
}

export class SearchManager implements AppModule {
  private static readonly SEARCH_INDEX_READY_TIMEOUT_MS = 2_000;

  private ctx: AppContext;
  private callbacks: SearchManagerCallbacks;
  private readonly searchSelection: SearchSelectionDispatcher;
  private readonly webMcpSearch: WebMcpSearchController;
  private destroyed = false;
  private searchIndexReady: Promise<void> = Promise.resolve();

  constructor(ctx: AppContext, callbacks: SearchManagerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
    this.searchSelection = new SearchSelectionDispatcher({
      ctx,
      getVariant: () => SITE_VARIANT,
      hasPremiumAccess: () => hasPremiumAccess(getAuthState()),
      enablePanel: (...args) => this.callbacks.enablePanel(...args),
      trackSearchResultSelected,
      runWithAgentAnalyticsSuppressed,
      suppressNextAgentPanelView,
      resolveExecutableNewsPanel: (link) => this.resolveExecutableNewsPanel(link),
      saveToStorage,
      setTheme,
      // Must stay wrapped, not passed bare: the dispatcher invokes these as
      // `this.bindings.setTimeout(...)` / `this.bindings.clearTimeout(...)`,
      // a method call. The native functions require the receiver to be the
      // global object, so handing over the bare reference makes that call
      // throw `TypeError: Illegal invocation` (WORLDMONITOR-ZT). Wrapping
      // keeps the invocation unqualified, matching every other binding here.
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (timer) => clearTimeout(timer),
    });
    this.webMcpSearch = new WebMcpSearchController({
      waitForIndexReady: () => this.waitForSearchIndexReady(),
      isDestroyed: () => this.destroyed,
      refreshIndex: () => this.updateSearchIndex({ updateVisibleMetrics: false }),
      getModal: () => this.ctx.searchModal,
      hasPremiumAccess: () => hasPremiumAccess(getAuthState()),
      cancelPendingSelection: () => this.searchSelection.cancelPendingProgrammaticSelection(),
      getAuthContext: () => {
        const auth = getAuthState();
        return `${auth.user ? 'signed-in' : 'anonymous'}:${auth.isPending ? 'pending' : 'settled'}:${hasPremiumAccess(auth) ? 'premium' : 'free'}`;
      },
      getVariant: () => SITE_VARIANT,
      isMatchExecutable: (match) => this.isSearchMatchExecutable(match),
      isPanelCurrentlyEnabled: (panelId) => this.ctx.panelSettings[panelId]?.enabled === true,
      selectMatch: (match, signal) => this.searchSelection.selectProgrammaticMatch(
        match,
        () => this.resolveProgrammaticMatchForCommit(match),
        signal,
      ),
      subscribeAuth: subscribeAuthState,
      subscribeEntitlement: onEntitlementChange,
      subscribeRuntimeConfig,
      subscribeWidgetAccess,
      onPremiumAccessChanged: (_premium, premiumRestored) => {
        if (premiumRestored) {
          this.ctx.searchModal?.refreshSearch();
        }
      },
    });
  }

  init(): void {
    this.destroyed = false;
    this.observeSecurityContext();
    this.setupSearchModal();
  }

  public whenSearchIndexReady(): Promise<void> {
    return this.searchIndexReady;
  }

  /** Supersedes only an agent-driven result presentation; palette work remains intact. */
  public cancelPendingProgrammaticSelection(): void {
    this.webMcpSearch.cancelPendingOpen();
  }

  destroy(): void {
    this.destroyed = true;
    this.ctx.searchModal?.cancelPendingWork();
    this.webMcpSearch.destroy();
    this.searchSelection.destroy();
  }

  private setupSearchModal(): void {
    const searchOptions = { placeholder: t('modals.search.placeholder') };
    this.ctx.searchModal = new SearchModal(this.ctx.container, searchOptions);

    this.ctx.searchModal.registerSource('pipeline', PIPELINES.map(p => ({
      id: p.id,
      title: p.name,
      subtitle: `${p.type} ${p.operator || ''} ${p.countries?.join(' ') || ''}`.trim(),
      data: p,
    })));

    this.ctx.searchModal.registerSource('cable', UNDERSEA_CABLES.map(c => ({
      id: c.id,
      title: c.name,
      subtitle: c.major ? 'Major cable' : '',
      data: c,
    })));

    this.ctx.searchModal.registerSource('datacenter', AI_DATA_CENTERS.map(d => ({
      id: d.id,
      title: d.name,
      subtitle: `${d.owner} ${d.chipType || ''}`.trim(),
      data: d,
    })));

    this.ctx.searchModal.registerSource('nuclear', NUCLEAR_FACILITIES.map(n => ({
      id: n.id,
      title: n.name,
      subtitle: `${n.type} ${n.operator || ''}`.trim(),
      data: n,
    })));

    this.ctx.searchModal.registerSource('irradiator', GAMMA_IRRADIATORS.map(g => ({
      id: g.id,
      title: `${g.city}, ${g.country}`,
      subtitle: g.organization || '',
      data: g,
    })));

    this.syncPanelSearchIndex();
    // Filter CMD+K layer commands by (a) variant-allowed, (b) renderer-kind
    // compatibility (a deck-only layer can't run on the SVG fallback or the
    // globe), (c) premium entitlement for locked layers. Without (a)–(b), layer
    // commands surface where they'd silently fail the variant/renderer guard
    // (e.g. `layer:storageFacilities` on tech/finance/commodity/happy, or globe
    // / SVG-mobile). Without (c), free users could enable locked layers like
    // resilienceScore, leaving a checked+disabled checkbox (#6045).
    // Currently-on locked layers stay visible so free users can turn them off
    // if stuck state survived from an older session.
    this.ctx.searchModal.setLayerExecutableFn((layerKey) => {
      const key = (LAYER_KEY_MAP[layerKey] || layerKey) as keyof MapLayers;
      if (!(key in this.ctx.mapLayers)) return false;
      const variantAllowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
      if (!variantAllowed.has(key)) return false;
      const kind = this.ctx.map?.isGlobeMode?.()
        ? 'globe'
        : (this.ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
      return isLayerCommandAllowed(
        key,
        this.ctx.mapLayers[key],
        kind,
        hasPremiumAccess(getAuthState()),
      );
    });
    this.ctx.searchModal.setCommandVisibleFn((command) => this.isModalCommandVisible(command));
    this.ctx.searchModal.setResultVisibleFn((result) => this.isSearchResultVisible(result));
    this.ctx.searchModal.setOnHumanInteraction(() => this.cancelPendingProgrammaticSelection());
    this.ctx.searchModal.setOnSelect((result) => this.searchSelection.handleSearchResult(result));
    this.ctx.searchModal.setOnCommand((cmd) => this.searchSelection.handleCommand(cmd));
  }

  private static async waitWithTimeout(
    promise: Promise<unknown>,
    timeoutMs: number,
    label: string,
  ): Promise<boolean> {
    try {
      await withTimeout(promise, timeoutMs, label);
      return true;
    } catch {
      // Optional search enrichment must not block the dashboard search path.
      return false;
    }
  }

  private async waitForSearchIndexReady(): Promise<void> {
    await SearchManager.waitWithTimeout(
      this.searchIndexReady,
      SearchManager.SEARCH_INDEX_READY_TIMEOUT_MS,
      'search-index-ready',
    );
  }

  public async searchDashboard(
    query: string,
    scope: DashboardSearchScope,
    limit: number,
    signal?: AbortSignal,
  ): Promise<DashboardSearchResponse> {
    return this.webMcpSearch.search(query, scope, limit, signal);
  }

  public async openSearchResult(
    resultKey: string,
    waitForMapReady?: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<DashboardSearchOpenResult> {
    return this.webMcpSearch.open(resultKey, waitForMapReady, signal);
  }

  private observeSecurityContext(): void {
    this.webMcpSearch.observeSecurityContext();
  }

  private isSearchMatchExecutable(match: SearchMatch): boolean {
    if (match.kind === 'command') return this.isCommandExecutable(match.command);
    return this.isSearchResultExecutable(match.result);
  }

  private resolveProgrammaticMatchForCommit(match: SearchMatch): SearchMatch | undefined {
    const liveMatch = this.ctx.searchModal?.resolveMatchByIdentity(searchMatchIdentity(match));
    if (!liveMatch) return undefined;
    if (liveMatch.kind === 'command') {
      return this.isCommandExecutable(liveMatch.command, true) ? liveMatch : undefined;
    }
    return this.isSearchResultExecutable(liveMatch.result) ? liveMatch : undefined;
  }

  /** Human CMD+K keeps its complete command deck; agent issuance is narrower. */
  private isModalCommandVisible(command: Command): boolean {
    const [category = '', action = ''] = command.id.split(':', 2);
    if (category === 'panel') {
      const panelId = action.split('@')[0];
      if (!panelId) return false;
      const effective = ALL_PANELS[panelId]
        ? getEffectivePanelConfig(panelId, SITE_VARIANT)
        : undefined;
      return !!effective && isPanelEntitled(
        panelId,
        effective,
        hasPremiumAccess(getAuthState()),
      );
    }
    if (category === 'layer') return this.isLayerCommandExecutable(action);
    if (category === 'layers') return this.hasVisibleLayerPreset(action);
    if (category === 'country-map') return getCountryBbox(action) !== null;
    return ['nav', 'country', 'time', 'view'].includes(category);
  }

  private isCommandExecutable(
    command: Command,
    allowPendingPanelTarget = false,
  ): boolean {
    const [category, action = ''] = command.id.split(':', 2);
    switch (category) {
      case 'panel': {
        const panelId = action.split('@')[0];
        if (!panelId) return false;
        const config = this.ctx.panelSettings[panelId];
        if (!config) return false;
        const effective = ALL_PANELS[panelId]
          ? getEffectivePanelConfig(panelId, SITE_VARIANT)
          : undefined;
        const premium = hasPremiumAccess(getAuthState());
        if (!effective || !isPanelEntitled(panelId, effective, premium)) return false;
        if (config.enabled) {
          return allowPendingPanelTarget || this.hasLivePanelTarget(panelId);
        }
        if (premium) return true;
        return !isFreePanelCapCounted(panelId)
          || countFreePanelCapUsage(this.ctx.panelSettings) < FREE_MAX_PANELS;
      }
      case 'layer':
        return this.isLayerCommandExecutable(action);
      case 'layers':
        return this.hasExecutableLayerPreset(action);
      case 'nav':
        return true;
      case 'time':
        return !(this.ctx.map?.isGlobeMode?.() ?? false);
      case 'country-map':
        return getCountryBbox(action) !== null;
      case 'view':
        // Settings emit their own content-bearing or account-
        // tier analytics, refresh tears down the capability response, and
        // fullscreen requires a transient user activation WebMCP cannot grant.
        // Keep those visible in CMD+K but out of agent-issued descriptors.
        return ['dark', 'light'].includes(action);
      default:
        return false;
    }
  }

  private hasLivePanelTarget(panelId: string): boolean {
    const panel = this.ctx.panels[panelId];
    if (panel?.getElement().isConnected) return true;
    // Deferred shells are live navigation targets: scrolling them into the
    // IntersectionObserver margin is what mounts the real panel in place.
    return [...document.querySelectorAll<HTMLElement>('[data-panel]')]
      .some((element) => element.dataset.panel === panelId);
  }

  private resolveExecutableNewsPanel(
    link: string,
  ): [string, AppContext['newsPanels'][string]] | null {
    for (const [panelId, panel] of Object.entries(this.ctx.newsPanels)) {
      if (
        this.ctx.panelSettings[panelId]?.enabled === true
        && this.hasLivePanelTarget(panelId)
        && panel.hasNewsItem(link)
      ) {
        return [panelId, panel];
      }
    }
    return null;
  }

  private isLayerCommandExecutable(layerKey: string): boolean {
    const key = (LAYER_KEY_MAP[layerKey] || layerKey) as keyof MapLayers;
    if (!(key in this.ctx.mapLayers)) return false;
    const allowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
    if (!allowed.has(key)) return false;
    const renderer: RendererKind = this.ctx.map?.isGlobeMode?.()
      ? 'globe'
      : (this.ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
    return isLayerCommandAllowed(
      key,
      this.ctx.mapLayers[key],
      renderer,
      hasPremiumAccess(getAuthState()),
    );
  }

  private hasExecutableLayerPreset(action: string): boolean {
    if (action === 'none') return true;
    if (action === 'all') {
      return Object.keys(this.ctx.mapLayers).some((key) => this.isLayerCommandExecutable(key));
    }
    const primaryLayers = LAYER_PRESET_PRIMARY_LAYERS[action];
    if (!primaryLayers) return false;
    return primaryLayers.some((key) => this.isLayerCommandExecutable(key));
  }

  private hasVisibleLayerPreset(action: string): boolean {
    if (action === 'none') return true;
    if (action === 'all') {
      return Object.keys(this.ctx.mapLayers).some((key) => this.isLayerCommandExecutable(key));
    }
    return (LAYER_PRESETS[action] ?? []).some((key) => this.isLayerCommandExecutable(key));
  }

  private isSearchResultExecutable(result: SearchResult): boolean {
    if (!this.isSearchResultVisible(result)) return false;
    const requiredLayer = this.resultRequiredLayer(result);
    if (requiredLayer && !this.isEntityLayerExecutable(requiredLayer)) return false;
    if (
      this.ctx.map?.isGlobeMode?.()
      && ['pipeline', 'cable', 'datacenter', 'nuclear', 'irradiator'].includes(result.type)
    ) return false;
    switch (result.type) {
      case 'news':
        return this.resolveExecutableNewsPanel((result.data as NewsItem).link) !== null;
      case 'market':
        return this.ctx.panelSettings.markets?.enabled === true
          && this.hasLivePanelTarget('markets');
      default:
        return true;
    }
  }

  private isSearchResultVisible(result: SearchResult): boolean {
    const requiredLayer = this.resultRequiredLayer(result);
    if (!requiredLayer) return true;
    return getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant).has(requiredLayer);
  }

  private isEntityLayerExecutable(layer: keyof MapLayers): boolean {
    const allowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
    if (!allowed.has(layer)) return false;
    const renderer: RendererKind = this.ctx.map?.isGlobeMode?.()
      ? 'globe'
      : (this.ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
    return isLayerExecutable(
      layer,
      renderer,
    ) && isLayerEntitled(layer, hasPremiumAccess(getAuthState()));
  }

  private resultRequiredLayer(result: SearchResult): keyof MapLayers | null {
    switch (result.type) {
      case 'pipeline': return 'pipelines';
      case 'cable': return 'cables';
      case 'datacenter': return 'datacenters';
      case 'nuclear': return 'nuclear';
      case 'irradiator': return 'irradiators';
      case 'earthquake': return 'natural';
      case 'outage': return 'outages';
      default: return null;
    }
  }

  updateSearchIndex(options?: { updateVisibleMetrics?: boolean }): void {
    if (!this.ctx.searchModal) return;

    const sourceOptions = { updateVisibleMetrics: options?.updateVisibleMetrics !== false };
    this.syncPanelSearchIndex(sourceOptions);

    const newsItems = this.ctx.allNews.slice(0, 500).map(n => ({
      id: n.link,
      title: n.title,
      subtitle: n.source,
      data: n,
    }));
    console.log(`[Search] Indexing ${newsItems.length} news items (allNews total: ${this.ctx.allNews.length})`);
    this.ctx.searchModal.registerSource('news', newsItems, sourceOptions);

    this.ctx.searchModal.registerSource('market', this.ctx.latestMarkets.map(m => ({
      id: m.symbol,
      title: `${m.symbol} - ${m.name}`,
      subtitle: `$${m.price?.toFixed(2) || 'N/A'}`,
      data: m,
    })), sourceOptions);
  }

  /**
   * Feeds CMD+K two panel sets: `active` (currently enabled) and `available`
   * (every entitled panel the user could cross-enable on this variant — all
   * of ALL_PANELS merge into panelSettings per App.ts). The modal surfaces
   * available-but-disabled panels with an "Add" affordance; selecting one
   * routes through enablePanel(). Without the available set, search could
   * only jump to panels already on screen — the core discoverability gap.
   */
  private syncPanelSearchIndex(options?: { updateVisibleMetrics?: boolean }): void {
    if (!this.ctx.searchModal) return;
    const hasPremium = hasPremiumAccess(getAuthState());
    this.ctx.searchModal.setActivePanels(
      Object.entries(this.ctx.panelSettings).filter(([, v]) => v.enabled).map(([k]) => k),
      options,
    );
    this.ctx.searchModal.setAvailablePanels(
      Object.keys(this.ctx.panelSettings).filter((k) => {
        // Keep unregistered/dynamic keys out of search; the resolver would
        // otherwise return a disabled synthetic fallback for unknown keys.
        const cfg = ALL_PANELS[k] ? getEffectivePanelConfig(k, SITE_VARIANT) : undefined;
        return cfg ? isPanelEntitled(k, cfg, hasPremium) : false;
      }),
      options,
    );
  }
}
