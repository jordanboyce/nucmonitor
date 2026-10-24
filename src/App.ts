import type { Monitor, PanelConfig, MapLayers } from '@/types';
import {
  isStockResearchPath,
  stockResearchSymbolFromPath,
} from '@/features/stock-research/stock-research-route';
import { openStockResearchOverlay } from '@/features/stock-research/stock-research-overlay';
import type { AppContext } from '@/app/app-context';
import { applyVisibleMapDimension } from '@/app/map-dimension-control';
import {
  REFRESH_INTERVALS,
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  STORAGE_KEYS,
  SITE_VARIANT,
  ALL_PANELS,
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
  getInitialPanelSettingsForVariant,
} from '@/config';
import {
  sanitizeLayersForVariant,
  mapLayerStatesEqual,
} from '@/config/map-layer-definitions';
import type { MapVariant } from '@/config/map-layer-definitions';
import { getStoredMapModePreference } from '@/services/map-mode-preference';
import {
  initDB,
  cleanOldSnapshots,
  isOutagesConfigured,
} from '@/services';
import { mlWorker } from '@/services/ml-worker';
import { getAiFlowSettings, subscribeAiFlowChange, isHeadlineMemoryEnabled } from '@/services/ai-flow-settings';
import {
  isMobileDevice,
  loadFromStorage,
  parseMapUrlState,
  readDashboardSearchQuery,
  saveToStorage,
  showToast,
} from '@/utils';
import { clearPanelSpans, invalidatePanelStorageCacheForKeys } from '@/utils/panel-storage';
import { overlayHistory, type OverlayId } from '@/utils/overlay-history';
import type { ParsedMapUrlState } from '@/utils';
import { BreakingNewsBanner } from '@/components/BreakingNewsBanner';
import { initBreakingNewsAlerts, destroyBreakingNewsAlerts } from '@/services/breaking-news-alerts';
import { markLcpDebug } from '@/utils/lcp-debug';
import type { MonitorPanel } from '@/components/MonitorPanel';
import type { NuclearReactorStatusPanel } from '@/components/NuclearReactorStatusPanel';
import type { NuclearEventReportsPanel } from '@/components/NuclearEventReportsPanel';
import type { ClimateNewsPanel } from '@/components/ClimateNewsPanel';
import { isDesktopRuntime, waitForSidecarReady } from '@/services/runtime';
import { BETA_MODE } from '@/config/beta';
import { trackEvent, trackDeeplinkOpened, initAuthAnalytics, trackMapViewChange } from '@/services/analytics';
import { preloadCountryGeometry } from '@/services/country-geometry';
import { initI18n, t, I18N_RESOURCES_LOADED_EVENT, type I18nResourcesLoadedDetail } from '@/services/i18n';
import { initDeferredDashboardFonts } from '@/bootstrap/secondary-startup';
import { applyFontScale, FONT_SCALE_STORAGE_KEY } from '@/services/font-scale-settings';

import { FEEDS } from '@/config/feeds';
import { findFullyDisabledCategories } from '@/utils/cloud-prefs-migrations';
import {
  applyVariantPanelLayoutTransition,
  resolveAppliedPanelLayoutVariant,
} from '@/services/variant-panel-ownership';
import {
  cancelBootstrapSlowTier,
  fetchBootstrapData,
  getBootstrapHydrationState,
  markBootstrapAsLive,
  waitForBootstrapSlowTier,
  type BootstrapHydrationState,
} from '@/services/bootstrap';
import { ensureWmSession, installWmSessionFetchInterceptor, WM_SESSION_DEGRADED_EVENT, type WmSessionDegradedDetail } from '@/services/wm-session';
import { describeWmSessionDegradation, WM_SESSION_DEGRADED_FALLBACK_COPY } from '@/services/wm-session-copy';
import { describeFreshness } from '@/services/persistent-cache';
import { DesktopUpdater } from '@/app/desktop-updater';
import {
  DashboardBindingError,
  raceWebMcpAbort,
  throwIfWebMcpAborted,
  type WebMcpAppBindings,
} from '@/services/webmcp';
import {
  applyWebMcpMissionPreset,
  applyWebMcpOpenMissionPicker,
  applyWebMcpOpenSettings,
  getWebMcpDashboardContext,
  getWebMcpMapLayerCatalogSnapshot,
  listWebMcpDashboardPanels,
  listWebMcpMissionPresets,
  WEBMCP_UI_READY_TIMEOUT_MS,
  waitForWebMcpUiReady,
} from '@/app/webmcp-dashboard';
import type { MapLayerRuntimeAvailability } from '@/services/map-layer-runtime-availability';
import { getWebMcpAccessContext, openWebMcpSignIn } from '@/app/webmcp-access';
import { runDashboardActionBinding } from '@/app/dashboard-action-binding';
import { selectWebMcpPanelTab } from '@/app/webmcp-panel-tab-binding';
import { refreshDataFreshnessFromHealth } from '@/services/health-freshness';
import { scheduleAfterFirstPaint } from '@/utils/after-paint';
import type { SearchManager } from '@/app/search-manager';
import { RefreshScheduler } from '@/app/refresh-scheduler';
import { PanelLayoutManager } from '@/app/panel-layout';
import { DataLoaderManager } from '@/app/data-loader';
import { EventHandlerManager } from '@/app/event-handlers';
import { isCatalogPanelLive, waitUntilPanelLive } from '@/app/panel-enablement';
import { replaceRawI18nKeyPlaceholders } from '@/app/i18n-raw-key-healer';
import { initialRegionFromCache, resolveUserRegion, resolvePreciseUserCoordinates, type PreciseCoordinates } from '@/utils/user-location';
import { initAuthState, subscribeAuthState } from '@/services/auth-state';
import {
  CLOUD_PREFS_APPLIED_EVENT,
  install as installCloudPrefsSync,
  onSignIn as cloudPrefsSignIn,
  onSignOut as cloudPrefsSignOut,
  type CloudPrefsAppliedDetail,
} from '@/utils/cloud-prefs-sync';
import { clearClerkTokenCache } from '@/services/clerk';
import { nextPrimeRetryDelayMs } from '@/utils/prime-retry';

/** Look-ahead margin for viewport-gated panel priming and refresh scheduling. */
const DEFAULT_VIEWPORT_MARGIN_PX = 400;

export class App {
  private state: AppContext;
  private pendingDeepLinkSearchQuery: string | null = null;
  private stockDeepLinkTimer: number | null = null;
  // At most one automatic precise mobile recenter per startup (#7778). Set
  // when the late position callback fires; cleared on destroy/re-init so a new
  // App instance gets its own single attempt.
  private autoGeoRecenterApplied = false;

  private panelLayout: PanelLayoutManager;
  private dataLoader: DataLoaderManager;
  private eventHandlers: EventHandlerManager;
  private searchManager: SearchManager | null = null;
  private searchManagerLoad: Promise<SearchManager> | null = null;
  // Monotonic epoch: every openSearch() call supersedes earlier in-flight ones.
  // searchToggleDesiredOpen accumulates the net intent of rapid Cmd+K presses
  // while the lazy chunk loads (XOR: odd → open, even → cancel). (#4403 review)
  private openSearchEpoch = 0;
  private searchToggleDesiredOpen = false;
  private refreshScheduler: RefreshScheduler;
  private desktopUpdater: DesktopUpdater;

  private modules: { destroy(): void }[] = [];
  private unsubAiFlow: (() => void) | null = null;
  private unsubAuth: (() => void) | null = null;
  /**
   * Boot epoch for optional local-AI continuations (#7779). destroy() bumps
   * it first so a stale detached continuation from a torn-down App can never
   * download a model or restart the shared worker a fresh same-document App
   * reuses. Continuations also check state.isDestroyed directly.
   */
  private localAiInitEpoch = 0;
  // Resolves once Phase-4 UI modules have initialised so WebMCP bindings can
  // await readiness before dispatching into UI managers. Avoids the startup
  // race where an agent discovers a tool via early registerTool and invokes it
  // before the manager that owns its target is ready.
  private uiReady!: Promise<void>;
  private resolveUiReady!: () => void;
  private appDestroyed!: Promise<void>;
  private resolveAppDestroyed!: () => void;
  // Returned by registerWebMcpTools in browser runtimes — aborting it removes
  // late-provider listeners and unregisters every accepted tool. destroy()
  // triggers it so test harnesses / same-document re-inits don't accumulate
  // duplicate registrations.
  private webMcpController: AbortController | null = null;
  // Cancels App-owned waits that have already entered a callback. Distinct from
  // the tool-invocation caller signal, and from webMcpController which only
  // unregisters tools — aborting registration does not stop an in-flight waiter.
  private readonly lifecycleController = new AbortController();
  private visiblePanelPrimed = new Set<string>();
  /**
   * Per-pass viewport results, or null outside a pass. See
   * {@link primeViewportNearCache}.
   */
  private viewportNearCache: Map<string, boolean> | null = null;
  /** Consecutive prime failures per key, for the retry backoff. */
  private visiblePanelPrimeFailures = new Map<string, number>();
  /** Earliest `Date.now()` at which a failed prime key may be retried. */
  private visiblePanelPrimeRetryAt = new Map<string, number>();
  private visiblePanelPrimeRaf: number | null = null;
  private viewportHydrationReady = false;
  private viewportHydrationReadyAt = 0;
  private slowTierWaitTimedOut = false;
  /** Scroll/resize register at readiness; marks/primes arm only after fan-out. */
  private viewportTriggersArmed = false;
  private bootstrapHydrationState: BootstrapHydrationState = getBootstrapHydrationState();
  private cachedModeBannerEl: HTMLElement | null = null;
  private readonly handleWmSessionDegraded = (event?: Event): void => {
    if (!this.state.isDestroyed) {
      // Pre-#5674 bundles in long-lived tabs can still dispatch a plain Event
      // with no detail; fall back to the cookie wording those users used to get.
      const reason = (event as CustomEvent<WmSessionDegradedDetail> | undefined)?.detail?.reason;
      showToast(
        reason
          ? describeWmSessionDegradation(reason)
          : WM_SESSION_DEGRADED_FALLBACK_COPY,
      );
    }
  };
  private readonly handleViewportPrime = (event?: Event): void => {
    if (!this.viewportHydrationReady || this.state.isDestroyed) return;
    // The catch-up scan after fan-out covers early viewport changes without
    // replaying their scroll events as viewport-trigger marks. (#5876)
    if (!this.viewportTriggersArmed) return;
    if (
      event &&
      this.viewportHydrationReadyAt > 0 &&
      event.timeStamp < this.viewportHydrationReadyAt
    ) {
      return;
    }
    if (
      event?.type === 'scroll' &&
      event.target instanceof Element &&
      !event.target.matches('.main-content, .panels-grid')
    ) {
      return;
    }
    if (this.visiblePanelPrimeRaf !== null) return;
    this.visiblePanelPrimeRaf = window.requestAnimationFrame(() => {
      this.visiblePanelPrimeRaf = null;
      markLcpDebug('wm:hydration:viewport-trigger');
      void this.primeVisiblePanelData();
      // loadAllData covers panels primeVisiblePanelData does not (news,
      // markets, intelligence, fred, …). Now that bootstrap runs with
      // forceAll=false, below-fold panels need this re-trigger on scroll
      // so their data lands when they enter the viewport. Both are
      // viewport-gated and inflight-guarded — repeat invocations are
      // cheap.
      void this.dataLoader.loadAllData();
    });
  };
  private readonly handleConnectivityChange = (): void => {
    this.updateConnectivityUi();
  };
  private readonly handleI18nResourcesLoaded = (ev: Event): void => {
    const language = (ev as CustomEvent<I18nResourcesLoadedDetail>).detail?.language;
    if (language !== 'en') return;
    // Scope this to the app container: body-level modals are user-opened after
    // startup, by which point the full English bundle should already be loaded.
    replaceRawI18nKeyPlaceholders(this.state.container, t);
  };
  private readonly handleCloudPrefsApplied = (ev: Event): void => {
    const detail = (ev as CustomEvent<CloudPrefsAppliedDetail>).detail;
    this.applyCloudSyncedPrefsToRuntime(detail?.keys ?? []);
  };
  private readonly getMapLayerRuntimeAvailability = (): MapLayerRuntimeAvailability => ({
    outagesAvailable: isOutagesConfigured() !== false,
  });
  private applyCloudSyncedPrefsToRuntime(keys: readonly string[]): void {
    if (keys.length === 0) return;

    const keySet = new Set(keys);
    invalidatePanelStorageCacheForKeys(keys);

    if (keySet.has(FONT_SCALE_STORAGE_KEY)) {
      applyFontScale();
    }

    if (keySet.has(STORAGE_KEYS.panels)) {
      this.state.panelSettings = loadFromStorage<Record<string, PanelConfig>>(
        STORAGE_KEYS.panels,
        this.state.panelSettings,
      );
      this.panelLayout.applyPanelSettings();
      this.state.unifiedSettings?.refreshPanelToggles();
    }

    const panelOrderKey = this.state.PANEL_ORDER_KEY;
    if (keySet.has(panelOrderKey) || keySet.has(`${panelOrderKey}-bottom-set`)) {
      this.panelLayout.applySavedPanelOrder();
    }

    if (keySet.has(STORAGE_KEYS.mapLayers) && !this.state.initialUrlState?.layers) {
      const nextLayers = sanitizeLayersForVariant(
        loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, this.state.mapLayers),
        SITE_VARIANT as MapVariant,
      );
      if (!mapLayerStatesEqual(this.state.mapLayers, nextLayers)) {
        this.state.mapLayers = nextLayers;
        this.state.map?.setLayers(nextLayers);
        this.dataLoader.syncDataFreshnessWithLayers();
      }
    }

    if (keySet.has(STORAGE_KEYS.mapMode)) {
      const mode = getStoredMapModePreference();
      if (this.state.map) {
        void applyVisibleMapDimension(this.state, mode === 'globe' ? '3d' : '2d');
      }
    }

    if (keySet.has(STORAGE_KEYS.disabledFeeds)) {
      this.state.disabledSources = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));
    }

    if (keySet.has(STORAGE_KEYS.monitors)) {
      this.state.monitors = loadFromStorage<Monitor[]>(STORAGE_KEYS.monitors, []);
      const monitorPanel = this.state.panels['monitors'] as MonitorPanel | undefined;
      monitorPanel?.setMonitors(this.state.monitors);
      this.dataLoader.updateMonitorResults();
    }
  }

  private isPanelNearViewport(panelId: string, marginPx = DEFAULT_VIEWPORT_MARGIN_PX): boolean {
    if (marginPx === DEFAULT_VIEWPORT_MARGIN_PX && this.viewportNearCache) {
      const cached = this.viewportNearCache.get(panelId);
      if (cached !== undefined) return cached;
    }
    const panel = this.state.panels[panelId] as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
    return panel?.isNearViewport?.(marginPx) ?? false;
  }

  /**
   * Read every mounted panel's viewport state in one uninterrupted pass (#4487).
   *
   * `Panel.isNearViewport` calls `getComputedStyle` AND `getBoundingClientRect`,
   * both of which force style/layout. `primeVisiblePanelData` gates ~48 panels,
   * and a passing gate synchronously enters the panel's loader, several of which
   * write DOM before their first await (`showLoading` / `renderPanel`). That made
   * the pass read → write → read → write, so each read re-flushed a layout the
   * previous write had just invalidated — up to 48 forced layouts in one task,
   * dispatched from a scroll handler's rAF.
   *
   * Reading everything first means one flush, then writes only. The results are
   * valid for the whole synchronous pass: nothing scrolls or resizes mid-task.
   */
  private primeViewportNearCache(): void {
    const cache = new Map<string, boolean>();
    for (const [id, panel] of Object.entries(this.state.panels)) {
      const near = panel as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
      cache.set(id, near?.isNearViewport?.(DEFAULT_VIEWPORT_MARGIN_PX) ?? false);
    }
    this.viewportNearCache = cache;
  }

  private isAnyPanelNearViewport(panelIds: string[], marginPx = DEFAULT_VIEWPORT_MARGIN_PX): boolean {
    return panelIds.some((panelId) => this.isPanelNearViewport(panelId, marginPx));
  }

  private shouldRefreshFirms(): boolean {
    return this.isPanelNearViewport('satellite-fires');
  }

  private getCachedBootstrapUpdatedAt(): number | null {
    const cachedTierTimestamps = Object.values(this.bootstrapHydrationState.tiers)
      .filter((tier) => tier.source === 'cached')
      .map((tier) => tier.updatedAt)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    if (cachedTierTimestamps.length === 0) return null;
    return Math.min(...cachedTierTimestamps);
  }

  private updateConnectivityUi(): void {
    const statusIndicator = this.state.container.querySelector('.status-indicator');
    const statusLabel = statusIndicator?.querySelector('span:last-child');
    const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    // Only treat a complete cache fallback (no live data at all) as "cached" for UI purposes.
    // 'mixed' means live data was partially fetched — showing "Live data unavailable" would be misleading.
    const usingCachedBootstrap = this.bootstrapHydrationState.source === 'cached';
    const cachedUpdatedAt = this.getCachedBootstrapUpdatedAt();

    let statusMode: 'live' | 'cached' | 'unavailable' = 'live';
    let bannerMessage: string | null = null;

    if (!online) {
      // Offline: show banner regardless of mixed/cached (any cached data is better than nothing)
      const hasAnyCached = this.bootstrapHydrationState.source === 'cached' || this.bootstrapHydrationState.source === 'mixed';
      if (hasAnyCached) {
        statusMode = 'cached';
        const offlineCachedAt = this.bootstrapHydrationState.tiers
          ? Math.min(...Object.values(this.bootstrapHydrationState.tiers)
              .filter((tier) => tier.source === 'cached' || tier.source === 'mixed')
              .map((tier) => tier.updatedAt)
              .filter((v): v is number => typeof v === 'number' && Number.isFinite(v)))
          : NaN;
        const freshness = Number.isFinite(offlineCachedAt) ? describeFreshness(offlineCachedAt) : t('common.cached').toLowerCase();
        bannerMessage = t('connectivity.offlineCached', { freshness });
      } else {
        statusMode = 'unavailable';
        bannerMessage = t('connectivity.offlineUnavailable');
      }
    } else if (usingCachedBootstrap) {
      statusMode = 'cached';
      const freshness = cachedUpdatedAt ? describeFreshness(cachedUpdatedAt) : t('common.cached').toLowerCase();
      bannerMessage = t('connectivity.cachedFallback', { freshness });
    }

    if (statusIndicator && statusLabel) {
      statusIndicator.classList.toggle('status-indicator--cached', statusMode === 'cached');
      statusIndicator.classList.toggle('status-indicator--unavailable', statusMode === 'unavailable');
      statusLabel.textContent = statusMode === 'live'
        ? t('header.live')
        : statusMode === 'cached'
          ? t('header.cached')
          : t('header.unavailable');
    }

    if (bannerMessage) {
      if (!this.cachedModeBannerEl) {
        this.cachedModeBannerEl = document.createElement('div');
        // CSS disables pointer events on this status-only container. Keep its descendants
        // non-interactive unless the banner interaction model is updated with it.
        this.cachedModeBannerEl.className = 'cached-mode-banner';
        this.cachedModeBannerEl.setAttribute('role', 'status');
        this.cachedModeBannerEl.setAttribute('aria-live', 'polite');

        const badge = document.createElement('span');
        badge.className = 'cached-mode-banner__badge';
        const text = document.createElement('span');
        text.className = 'cached-mode-banner__text';
        this.cachedModeBannerEl.append(badge, text);

        const header = this.state.container.querySelector('.header');
        if (header?.parentElement) {
          header.insertAdjacentElement('afterend', this.cachedModeBannerEl);
        } else {
          this.state.container.prepend(this.cachedModeBannerEl);
        }
      }

      this.cachedModeBannerEl.classList.toggle('cached-mode-banner--unavailable', statusMode === 'unavailable');
      const badge = this.cachedModeBannerEl.querySelector('.cached-mode-banner__badge')!;
      const text = this.cachedModeBannerEl.querySelector('.cached-mode-banner__text')!;
      badge.textContent = statusMode === 'cached' ? t('header.cached') : t('header.unavailable');
      text.textContent = bannerMessage;
      return;
    }

    this.cachedModeBannerEl?.remove();
    this.cachedModeBannerEl = null;
  }

  private async primeVisiblePanelData(forceAll = false): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    const now = Date.now();
    const primeTask = (key: string, task: () => Promise<unknown>): void => {
      if (this.visiblePanelPrimed.has(key) || this.state.inFlight.has(key)) return;
      // A failed prime is never recorded as primed, so without this a fast-failing
      // endpoint re-enters on every scroll frame forever (#4487).
      const retryAt = this.visiblePanelPrimeRetryAt.get(key);
      if (retryAt !== undefined && now < retryAt) return;
      const wrapped = (async () => {
        this.state.inFlight.add(key);
        try {
          await task();
          this.visiblePanelPrimed.add(key);
          this.visiblePanelPrimeFailures.delete(key);
          this.visiblePanelPrimeRetryAt.delete(key);
        } catch (err) {
          const failures = (this.visiblePanelPrimeFailures.get(key) ?? 0) + 1;
          this.visiblePanelPrimeFailures.set(key, failures);
          this.visiblePanelPrimeRetryAt.set(key, Date.now() + nextPrimeRetryDelayMs(failures));
          throw err;
        } finally {
          this.state.inFlight.delete(key);
        }
      })();
      tasks.push(wrapped);
    };

    const shouldPrime = (id: string): boolean => forceAll || this.isPanelNearViewport(id);
    const shouldPrimeAny = (ids: string[]): boolean => forceAll || this.isAnyPanelNearViewport(ids);

    // Every layout read for this pass happens here, before any gate can enter a
    // loader that writes DOM. `forceAll` skips the gates entirely, so it needs no
    // reads at all.
    if (!forceAll) this.primeViewportNearCache();

    if (shouldPrimeAny(['markets', 'commodities'])) {
      primeTask('markets', () => this.dataLoader.loadMarkets());
    }
    // NucMonitor — NRC reactor status self-fetches through the edge proxy.
    if (shouldPrime('nuclear-reactor-status')) {
      const panel = this.state.panels['nuclear-reactor-status'] as NuclearReactorStatusPanel | undefined;
      if (panel) primeTask('nuclear-reactor-status', () => panel.fetchData());
    }
    if (shouldPrime('nuclear-events')) {
      const panel = this.state.panels['nuclear-events'] as NuclearEventReportsPanel | undefined;
      if (panel) primeTask('nuclear-events', () => panel.fetchData());
    }
    if (shouldPrime('climate-news')) {
      const panel = this.state.panels['climate-news'] as ClimateNewsPanel | undefined;
      if (panel) primeTask('climate-news', () => panel.fetchData());
    }

    // Gates are done; the cached geometry must not outlive the synchronous pass
    // or a later scroll would be gated on a stale rect.
    this.viewportNearCache = null;

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container ${containerId} not found`);

    this.uiReady = new Promise<void>((resolve) => {
      this.resolveUiReady = resolve;
    });
    this.appDestroyed = new Promise<void>((resolve) => {
      this.resolveAppDestroyed = resolve;
    });

    const PANEL_ORDER_KEY = 'panel-order';
    const PANEL_SPANS_KEY = 'worldmonitor-panel-spans';
    const PANEL_ORDER_MIGRATION_KEY = 'worldmonitor-panel-order-v1.9';
    const LAYOUT_RESET_MIGRATION_KEY = 'worldmonitor-layout-reset-v2.5';

    const isMobile = isMobileDevice();
    const isDesktopApp = isDesktopRuntime();
    const monitors = loadFromStorage<Monitor[]>(STORAGE_KEYS.monitors, []);

    // Use mobile-specific defaults on first load (no saved layers)
    const defaultLayers = isMobile ? MOBILE_DEFAULT_MAP_LAYERS : DEFAULT_MAP_LAYERS;

    let mapLayers: MapLayers;
    let panelSettings: Record<string, PanelConfig>;

    // Panels that must survive variant switches: desktop config, user-created widgets, MCP panels.
    const isDynamicPanel = (k: string) => !ALL_PANELS[k] && (k === 'runtime-config' || k.startsWith('cw-') || k.startsWith('mcp-'));

    const currentVariant = SITE_VARIANT;
    let appliedPanelLayoutVariant: string | null = null;
    let storageAvailable = true;
    try {
      appliedPanelLayoutVariant = resolveAppliedPanelLayoutVariant({
        appliedVariant: localStorage.getItem(STORAGE_KEYS.panelLayoutVariant),
        legacyVariant: localStorage.getItem(STORAGE_KEYS.variant),
        currentVariant,
        validVariants: new Set(Object.keys(VARIANT_DEFAULTS)),
        persistAppliedVariant: (variant) => {
          localStorage.setItem(STORAGE_KEYS.panelLayoutVariant, variant);
          return true;
        },
      });
      const probeKey = 'wm-storage-capability-probe';
      localStorage.setItem(probeKey, '1');
      localStorage.removeItem(probeKey);
    } catch {
      storageAvailable = false;
    }

    // Blocked storage is a supported no-persistence mode. Seed the same
    // defaults as a first visit and skip migrations that only mutate storage.
    if (!storageAvailable) {
      mapLayers = sanitizeLayersForVariant({ ...defaultLayers }, currentVariant as MapVariant);
      panelSettings = getInitialPanelSettingsForVariant(currentVariant);
    } else if (appliedPanelLayoutVariant !== currentVariant) {
      // Variant changed - reset all settings to variant defaults.
      console.log(`[App] Variant check: applied="${appliedPanelLayoutVariant}", current="${currentVariant}"`);
      // Variant changed — seed new variant's panels, disable panels not in the new variant
      console.log('[App] Variant changed - seeding new defaults, disabling cross-variant panels');
      // Reset map layers for the new variant (map layers are not user-personalized the same way)
      localStorage.removeItem(STORAGE_KEYS.mapLayers);
      mapLayers = sanitizeLayersForVariant({ ...defaultLayers }, currentVariant as MapVariant);
      // Load existing panel prefs (if any), disable panels not belonging to the new variant
      const newVariantKeys = new Set(VARIANT_DEFAULTS[currentVariant] ?? []);
      const hadLegacyPanelLayoutState = localStorage.getItem(PANEL_ORDER_KEY) !== null
        || localStorage.getItem(PANEL_SPANS_KEY) !== null;
      panelSettings = applyVariantPanelLayoutTransition({
        currentVariant,
        panelSettings: loadFromStorage<Record<string, PanelConfig>>(STORAGE_KEYS.panels, {}),
        variantPanelKeys: newVariantKeys,
        isDynamicPanel,
        getDefaultPanel: (key) => getEffectivePanelConfig(key, currentVariant),
        // Use the throwing primitive here so the transition helper advances
        // the applied-layout marker only after the panel blob is durable.
        persistPanels: (next) => localStorage.setItem(STORAGE_KEYS.panels, JSON.stringify(next)),
        persistAppliedVariant: (variant) => {
          // Both markers advance HERE, inside the helper's success path, and
          // never after a failed panel write. Advancing the legacy key
          // unconditionally used to erase the retry: on the next boot
          // resolveAppliedPanelLayoutVariant would see a null applied marker
          // beside a legacy key already equal to the current variant, take its
          // SEEDING branch, and silently record the failed reset as applied.
          //
          // Order is load-bearing: the legacy key (read by bootstrap/theme and
          // by SITE_VARIANT on desktop) goes first, and the applied-layout
          // marker — the "this layout is durable" flag — goes last.
          localStorage.setItem(STORAGE_KEYS.variant, variant);
          localStorage.setItem(STORAGE_KEYS.panelLayoutVariant, variant);
        },
      });
      if (
        !hadLegacyPanelLayoutState
        && localStorage.getItem(STORAGE_KEYS.panelLayoutVariant) === currentVariant
      ) {
        try {
          localStorage.setItem(PANEL_ORDER_MIGRATION_KEY, 'done');
          localStorage.setItem(LAYOUT_RESET_MIGRATION_KEY, 'done');
        } catch {
          // Blocked storage leaves the legacy migrations eligible for a later retry.
        }
      }
    } else {
      mapLayers = sanitizeLayersForVariant(
        loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, defaultLayers),
        currentVariant as MapVariant,
      );

      panelSettings = loadFromStorage<Record<string, PanelConfig>>(
        STORAGE_KEYS.panels,
        DEFAULT_PANELS
      );

      // One-time migration: preserve user preferences across panel key renames.
      const PANEL_KEY_RENAMES_MIGRATION_KEY = 'worldmonitor-panel-key-renames-v2.6.8';
      if (!localStorage.getItem(PANEL_KEY_RENAMES_MIGRATION_KEY)) {
        let migrated = false;
        const keyRenames: Array<[string, string]> = [
          ['live-youtube', 'live-webcams'],
          ['pinned-webcams', 'windy-webcams'],
        ];
        // 'regulation' was dead config (no feeds). Just prune it.
        if (panelSettings['regulation']) {
          delete panelSettings['regulation'];
          migrated = true;
        }
        for (const [legacyKey, nextKey] of keyRenames) {
          if (!panelSettings[legacyKey] || panelSettings[nextKey]) continue;
          panelSettings[nextKey] = {
            ...DEFAULT_PANELS[nextKey],
            ...panelSettings[legacyKey],
            name: DEFAULT_PANELS[nextKey]?.name ?? panelSettings[legacyKey].name,
          };
          delete panelSettings[legacyKey];
          migrated = true;
        }
        // Also migrate saved panel order/bottom-set entries for renamed keys
        for (const [legacyKey, nextKey] of keyRenames) {
          for (const orderKey of [PANEL_ORDER_KEY, PANEL_ORDER_KEY + '-bottom-set', PANEL_ORDER_KEY + '-bottom']) {
            try {
              const raw = localStorage.getItem(orderKey);
              if (!raw) continue;
              const arr = JSON.parse(raw);
              if (!Array.isArray(arr)) continue;
              const idx = arr.indexOf(legacyKey);
              if (idx !== -1) { arr[idx] = nextKey; localStorage.setItem(orderKey, JSON.stringify(arr)); migrated = true; }
            } catch { /* corrupt storage, skip */ }
          }
        }
        if (migrated) saveToStorage(STORAGE_KEYS.panels, panelSettings);
        localStorage.setItem(PANEL_KEY_RENAMES_MIGRATION_KEY, 'done');
      }

      // Merge in any panels from ALL_PANELS that didn't exist when settings were saved
      for (const key of Object.keys(ALL_PANELS)) {
        if (!(key in panelSettings)) {
          const config = getEffectivePanelConfig(key, SITE_VARIANT);
          const isInVariant = (VARIANT_DEFAULTS[SITE_VARIANT] ?? []).includes(key);
          panelSettings[key] = { ...config, enabled: isInVariant && config.enabled };
        }
      }

      // One-time migration: expose all panels to existing users (previously variant-gated)
      const UNIFIED_MIGRATION_KEY = 'worldmonitor-unified-panels-v1';
      if (!localStorage.getItem(UNIFIED_MIGRATION_KEY)) {
        const variantDefaults = new Set(VARIANT_DEFAULTS[SITE_VARIANT] ?? []);
        for (const key of Object.keys(ALL_PANELS)) {
          if (!(key in panelSettings)) {
            const config = getEffectivePanelConfig(key, SITE_VARIANT);
            panelSettings[key] = { ...config, enabled: variantDefaults.has(key) && config.enabled };
          }
        }
        saveToStorage(STORAGE_KEYS.panels, panelSettings);
        localStorage.setItem(UNIFIED_MIGRATION_KEY, 'done');
      }

      console.log('[App] Loaded panel settings from storage:', Object.entries(panelSettings).filter(([_, v]) => !v.enabled).map(([k]) => k));

      // One-time migration: reorder panels for existing users (v1.9 panel layout)
      if (!localStorage.getItem(PANEL_ORDER_MIGRATION_KEY)) {
        const savedOrder = localStorage.getItem(PANEL_ORDER_KEY);
        if (savedOrder) {
          try {
            const order: string[] = JSON.parse(savedOrder);
            const priorityPanels = ['insights', 'strategic-posture', 'cii', 'strategic-risk'];
            const filtered = order.filter(k => !priorityPanels.includes(k) && k !== 'live-news');
            const liveNewsIdx = order.indexOf('live-news');
            const newOrder = liveNewsIdx !== -1 ? ['live-news'] : [];
            newOrder.push(...priorityPanels.filter(p => order.includes(p)));
            newOrder.push(...filtered);
            localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(newOrder));
            console.log('[App] Migrated panel order to v1.9 layout');
          } catch {
            // Invalid saved order, will use defaults
          }
        }
        localStorage.setItem(PANEL_ORDER_MIGRATION_KEY, 'done');
      }
    }

    if (storageAvailable) {
      // One-time migration: prune removed panel keys from stored settings and order
      const PANEL_PRUNE_KEY = 'worldmonitor-panel-prune-v1';
      if (!localStorage.getItem(PANEL_PRUNE_KEY)) {
        const validKeys = new Set(Object.keys(ALL_PANELS));
        let pruned = false;
        for (const key of Object.keys(panelSettings)) {
          if (!validKeys.has(key) && key !== 'runtime-config') {
            delete panelSettings[key];
            pruned = true;
          }
        }
        if (pruned) saveToStorage(STORAGE_KEYS.panels, panelSettings);
        for (const orderKey of [PANEL_ORDER_KEY, PANEL_ORDER_KEY + '-bottom-set', PANEL_ORDER_KEY + '-bottom']) {
          try {
            const raw = localStorage.getItem(orderKey);
            if (!raw) continue;
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) continue;
            const filtered = arr.filter((k: string) => validKeys.has(k));
            if (filtered.length !== arr.length) localStorage.setItem(orderKey, JSON.stringify(filtered));
          } catch { localStorage.removeItem(orderKey); }
        }
        localStorage.setItem(PANEL_PRUNE_KEY, 'done');
      }

      // One-time migration: clear stale panel ordering and sizing state
      if (!localStorage.getItem(LAYOUT_RESET_MIGRATION_KEY)) {
        const hadSavedOrder = !!localStorage.getItem(PANEL_ORDER_KEY);
        const hadSavedSpans = !!localStorage.getItem(PANEL_SPANS_KEY);
        if (hadSavedOrder || hadSavedSpans) {
          localStorage.removeItem(PANEL_ORDER_KEY);
          localStorage.removeItem(PANEL_ORDER_KEY + '-bottom');
          localStorage.removeItem(PANEL_ORDER_KEY + '-bottom-set');
          clearPanelSpans();
          console.log('[App] Applied layout reset migration (v2.5): cleared panel order/spans');
        }
        localStorage.setItem(LAYOUT_RESET_MIGRATION_KEY, 'done');
      }
    }

    // Desktop key management panel must always remain accessible in Tauri.
    if (isDesktopApp) {
      if (!panelSettings['runtime-config'] || !panelSettings['runtime-config'].enabled) {
        panelSettings['runtime-config'] = {
          ...panelSettings['runtime-config'],
          name: panelSettings['runtime-config']?.name ?? 'Desktop Configuration',
          enabled: true,
          priority: panelSettings['runtime-config']?.priority ?? 2,
        };
        saveToStorage(STORAGE_KEYS.panels, panelSettings);
      }
    }

    const initialUrlState: ParsedMapUrlState | null = parseMapUrlState(window.location.search, mapLayers);
    if (initialUrlState.layers) {
      mapLayers = sanitizeLayersForVariant(initialUrlState.layers, currentVariant as MapVariant);
      initialUrlState.layers = mapLayers;
    }
    const disabledSources = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));

    // Build shared state object
    this.state = {
      map: null,
      isMobile,
      isDesktopApp,
      container: el,
      panels: {},
      newsPanels: {},
      newsCategoryPanelKeys: new Map(),
      panelSettings,
      mapLayers,
      allNews: [],
      newsByCategory: {},
      latestMarkets: [],
      latestClusters: [],
      intelligenceCache: {},
      disabledSources,
      currentTimeRange: '7d',
      inFlight: new Set(),
      seenGeoAlerts: new Set(),
      monitors,
      statusPanel: null,
      searchModal: null,
      breakingBanner: null,
      playbackControl: null,
      exportPanel: null,
      unifiedSettings: null,
      llmStatusIndicator: null,
      authModal: null,
      authHeaderWidget: null,
      isDestroyed: false,
      isPlaybackMode: false,
      isIdle: false,
      initialLoadComplete: false,
      clustersSettled: false,
      resolvedLocation: 'global',
      initialUrlState,
      PANEL_ORDER_KEY,
      PANEL_SPANS_KEY,
    };

    // Instantiate modules (callbacks wired after all modules exist)
    this.refreshScheduler = new RefreshScheduler(this.state);
    this.desktopUpdater = new DesktopUpdater(this.state);

    this.dataLoader = new DataLoaderManager(this.state);

    this.panelLayout = new PanelLayoutManager(this.state, {
      loadAllData: () => this.dataLoader.loadAllData(),
      primeVisiblePanelData: () => {
        if (!this.viewportHydrationReady || this.state.isDestroyed) return;
        void this.primeVisiblePanelData();
      },
      updateMonitorResults: () => this.dataLoader.updateMonitorResults(),
      applyMapLayerChange: (layer, enabled, source) => this.eventHandlers.applyMapLayerChange(layer, enabled, source),
    });

    this.eventHandlers = new EventHandlerManager(this.state, {
      openSearch: (options) => { void this.openSearch(options); },
      updateSearchIndex: () => this.updateSearchIndexIfReady(),
      loadAllData: () => this.dataLoader.loadAllData(),
      invalidateNewsHydration: () => this.dataLoader.invalidateNewsHydration(),
      flushStaleRefreshes: () => this.refreshScheduler.flushStaleRefreshes(),
      setHiddenSince: (ts) => this.refreshScheduler.setHiddenSince(ts),
      loadDataForLayer: (layer) => { void this.dataLoader.loadDataForLayer(layer as keyof MapLayers); },
      syncDataFreshnessWithLayers: () => this.dataLoader.syncDataFreshnessWithLayers(),
      applyPanelSettings: () => this.panelLayout.applyPanelSettings(),
      applySavedPanelOrder: (panelOrder?: string[]) => this.panelLayout.applySavedPanelOrder(panelOrder),
    });

    // Wire cross-module callback: DataLoader → SearchManager
    this.dataLoader.updateSearchIndex = () => this.updateSearchIndexIfReady();

    // Track destroy order (reverse of init)
    this.modules = [
      this.desktopUpdater,
      this.panelLayout,
      this.dataLoader,
      this.refreshScheduler,
      this.eventHandlers,
    ];
  }

  private ensureSearchManager(): Promise<SearchManager> {
    if (this.searchManager) return Promise.resolve(this.searchManager);
    if (this.searchManagerLoad) return this.searchManagerLoad;

    this.searchManagerLoad = import('@/app/search-manager')
      .then(async ({ SearchManager }) => {
        if (this.state.isDestroyed) {
          throw new Error('App destroyed before search manager loaded');
        }

        const manager = new SearchManager(this.state, {
          enablePanel: (panelId, options) => this.eventHandlers.enablePanelById(panelId, {
            trackAnalytics: options?.trackDetailedAnalytics !== false,
          }),
        });
        manager.init();
        if (this.state.isDestroyed) {
          manager.destroy();
          throw new Error('App destroyed while search manager loaded');
        }
        this.searchManager = manager;
        this.modules.push(manager);
        return manager;
      })
      .finally(() => {
        this.searchManagerLoad = null;
      });

    return this.searchManagerLoad;
  }

  private updateSearchIndexIfReady(): void {
    this.searchManager?.updateSearchIndex();
  }

  private async openSearch(options: {
    toggle?: boolean;
    throwOnFailure?: boolean;
    replaceOverlayId?: OverlayId;
    historyPending?: boolean;
    signal?: AbortSignal;
    initialQuery?: string;
  } = {}): Promise<boolean> {
    // Concurrency model: each press registers its intent, then claims a
    // monotonic epoch. After the lazy load resolves, only the latest epoch acts
    // — superseded presses bail. This yields one deterministic modal.open() for
    // any Cmd+K / button interleaving during the first load (replacing the prior
    // two-field pending-toggle bookkeeping), while preserving net-toggle parity:
    // the XOR flip happens BEFORE the epoch claim so every rapid Cmd+K still
    // counts (odd → open, even → cancel), even the ones that get superseded.
    let epoch = this.openSearchEpoch;
    const pendingId: OverlayId = 'search-pending';
    const pendingGate = options.historyPending
      ? overlayHistory.beginPending(pendingId, options.replaceOverlayId, () => {
          this.searchToggleDesiredOpen = false;
        })
      : null;
    try {
      await this.waitForUiReady(options.signal);
      throwIfWebMcpAborted(options.signal);
      // A fresh palette intent (human Cmd+K/button or agent open_search)
      // supersedes any older open_search_result presentation before we decide
      // whether to toggle, lazy-load, or open the modal. This cancellation is
      // intentionally limited to agent selection work; it does not clear the
      // palette's query/debounce state or unrelated human actions.
      this.searchManager?.cancelPendingProgrammaticSelection();
      if (pendingGate && !pendingGate.isCurrent()) return false;

      const existingModal = this.state.searchModal;
      if (options.toggle && existingModal?.isOpen()) {
        existingModal.close();
        return false;
      }

      const togglingBeforeLoad = Boolean(options.toggle) && !this.searchManager;
      if (togglingBeforeLoad) {
        this.searchToggleDesiredOpen = !this.searchToggleDesiredOpen;
      }

      epoch = ++this.openSearchEpoch;
      const manager = await raceWebMcpAbort(this.ensureSearchManager(), options.signal);
      throwIfWebMcpAborted(options.signal);
      if (this.openSearchEpoch !== epoch) return false;
      if (pendingGate && !pendingGate.isCurrent()) return false;

      const wantOpen = togglingBeforeLoad ? this.searchToggleDesiredOpen : true;
      if (!wantOpen) return false;

      manager.updateSearchIndex();
      const modal = this.state.searchModal;
      if (!modal) throw new Error('Search modal is not initialised');
      throwIfWebMcpAborted(options.signal);
      modal.open(pendingGate ? pendingId : options.replaceOverlayId);
      if (options.initialQuery) modal.applyQuery(options.initialQuery);
      return modal.isOpen();
    } catch (error) {
      const actionWasCancelled = pendingGate !== null && !pendingGate.isCurrent();
      const invocationWasCancelled = options.signal?.aborted === true;
      if (!this.state.isDestroyed && !actionWasCancelled && !invocationWasCancelled) {
        console.warn('[search] Failed to load search manager:', error);
        if (!options.throwOnFailure) showToast('Search failed to load. Please try again.');
      }
      pendingGate?.cancel();
      if (options.throwOnFailure || options.signal?.aborted) throw error;
      return false;
    } finally {
      // Reset the toggle accumulator once the latest press settles.
      if (this.openSearchEpoch === epoch) this.searchToggleDesiredOpen = false;
    }
  }

  private async waitForSlowBootstrapCheckpoint(): Promise<boolean> {
    markLcpDebug('wm:data:slow-tier-wait-start');
    try {
      const settled = await waitForBootstrapSlowTier(isDesktopRuntime() ? 8_500 : 3_500);
      markLcpDebug('wm:data:slow-tier-wait-end', { settled });
      if (this.state.isDestroyed) return settled;
      this.bootstrapHydrationState = getBootstrapHydrationState();
      this.updateConnectivityUi();
      return settled;
    } catch {
      markLcpDebug('wm:data:slow-tier-wait-error');
      return false;
    }
  }

  private completePendingSlowTierFanout(): void {
    if (!this.slowTierWaitTimedOut || this.state.isDestroyed) return;
    this.slowTierWaitTimedOut = false;
    void this.runVisibleDataFanout();
  }

  private async runVisibleDataFanout(): Promise<void> {
    if (this.viewportHydrationReady || this.state.isDestroyed) return;
    this.viewportHydrationReady = true;
    window.addEventListener('scroll', this.handleViewportPrime, {
      passive: true,
      capture: true,
    });
    window.addEventListener('resize', this.handleViewportPrime);
    markLcpDebug('wm:data:initial-fanout-start');
    await Promise.all([
      this.dataLoader.loadAllData(),
      this.primeVisiblePanelData(),
    ]);
    markLcpDebug('wm:data:initial-fanout-complete');
    if (this.state.isDestroyed) return;
    this.viewportHydrationReadyAt = typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    this.viewportTriggersArmed = true;
    void this.primeVisiblePanelData();
    if (import.meta.env.VITE_E2E === '1') {
      document.documentElement.dataset.wmInitialDataReady = 'true';
    }
  }

  private async preloadCountryGeometryForPostLcpWork(): Promise<void> {
    markLcpDebug('wm:data:country-geometry-start');
    try {
      await preloadCountryGeometry();
      markLcpDebug('wm:data:country-geometry-ready');
    } catch {
      markLcpDebug('wm:data:country-geometry-error');
    }
  }

  public getWebMcpBindings(): WebMcpAppBindings {
    return {
      openSearch: async (execution) => {
        // openSearch() awaits UI readiness internally and throws on failure when
        // throwOnFailure is set, so the agent receives a real success/failure.
        // (Re-checking searchModal here would spuriously throw if a concurrent
        // Cmd+K closed it between open and the check — #4403 review ADV-4.)
        return this.openSearch({ throwOnFailure: true, signal: execution?.signal });
      },
      getDashboardContext: async (execution) => {
        await this.waitForDashboardReady(true, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return getWebMcpDashboardContext(this.state, SITE_VARIANT);
      },
      listMapLayerCatalog: async (execution) => {
        await this.waitForDashboardReady(true, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return getWebMcpMapLayerCatalogSnapshot(
          this.state,
          SITE_VARIANT,
          t,
          this.getMapLayerRuntimeAvailability(),
        );
      },
      listDashboardPanels: async (query, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return listWebMcpDashboardPanels(this.state, SITE_VARIANT, query);
      },
      openSettings: async (execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return applyWebMcpOpenSettings(this.state, SITE_VARIANT);
      },
      applyDashboardAction: async (action, execution) => {
        return runDashboardActionBinding(this.state, action, {
          waitForUiReady: () => this.waitForDashboardReady(false, execution?.signal),
          waitForMapReady: () => this.waitForDashboardReady(true, execution?.signal),
          getMapAuthorityToken: () => this.state.map?.getViewportAuthorityToken() ?? 0,
          signal: execution?.signal,
          applierOptions: {
            getPanelConfig: (panelId) => getEffectivePanelConfig(panelId, SITE_VARIANT),
            applyViewChange: (viewAction) => {
              if (viewAction.view) trackMapViewChange(viewAction.view);
            },
            getMapLayerRuntimeAvailability: this.getMapLayerRuntimeAvailability,
            applyLayerChange: (layer, enabled, source) => (
              this.eventHandlers.applyMapLayerChange(layer, enabled, source)
            ),
            requireMapModePersistence: true,
          },
          syncUrlStateNow: () => this.eventHandlers.syncUrlStateNow(),
        });
      },
      selectPanelTab: async (panelId, tab, execution) => {
        return selectWebMcpPanelTab(this.state.panels, panelId, tab, {
          waitForUiReady: () => this.waitForDashboardReady(false, execution?.signal),
          prepareTab: (_selectedPanelId, selectedTab, signal) => (
            selectedTab === 'physical'
              ? this.dataLoader.loadPhysicalPremiumComparison(signal)
              : undefined
          ),
          signal: execution?.signal,
        });
      },
      searchDashboard: async (query, scope, limit, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        let manager: SearchManager;
        try {
          manager = await raceWebMcpAbort(
            this.ensureSearchManager(),
            execution?.signal,
          );
          throwIfWebMcpAborted(execution?.signal);
        } catch (error) {
          if (this.state.isDestroyed) {
            throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
          }
          throw error;
        }
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        const result = await manager.searchDashboard(
          query,
          scope,
          limit,
          execution?.signal,
        );
        throwIfWebMcpAborted(execution?.signal);
        return result;
      },
      openSearchResult: async (resultKey, execution) => {
        // A capability can only exist after search_dashboard initialized the
        // manager. Deny fabricated first-use keys without loading the lazy
        // search chunk or demanding a map renderer.
        const manager = this.searchManager;
        if (!manager) {
          return { ok: false, status: 'denied', reason: 'invalid_or_expired_key' } as const;
        }
        await this.waitForUiReady(execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return manager.openSearchResult(
          resultKey,
          () => this.waitForDashboardReady(true, execution?.signal),
          execution?.signal,
        );
      },
      applyDashboardTabAction: async (action, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return this.panelLayout.applyWebMcpTabAction(action);
      },
      setPanelEnabled: async (panelId, enabled, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        const result = this.eventHandlers.setPanelEnabledById(panelId, enabled);
        // Map uses #mapSection, not ctx.panels / [data-panel]. After persist,
        // do not abort on the caller signal: cancellation-required only gates a
        // missing signal. The App lifecycle signal still cancels this waiter
        // when destroy() runs, so a same-document re-init cannot wake the
        // MutationObserver on replacement DOM.
        if (
          result.ok
          && result.changed
          && result.effectiveEnabled
          && typeof panelId === 'string'
          && panelId !== 'map'
        ) {
          try {
            await waitUntilPanelLive({
              isLive: () => isCatalogPanelLive(panelId, this.state.panels),
              signal: this.lifecycleController.signal,
            });
          } catch (error) {
            if (this.state.isDestroyed || this.lifecycleController.signal.aborted) {
              throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
            }
            throw error;
          }
        }
        return result;
      },
      listMissionPresets: async (query, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return listWebMcpMissionPresets(this.state, SITE_VARIANT, query);
      },
      applyMissionPreset: async (presetId, execution) => {
        await this.waitForDashboardReady(true, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return applyWebMcpMissionPreset(this.state, SITE_VARIANT, presetId, {
          apply: (id) => this.eventHandlers.applyMissionPresetForWebMcp(id),
        });
      },
      openMissionPicker: async (execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return applyWebMcpOpenMissionPicker(
          this.state,
          SITE_VARIANT,
          () => this.eventHandlers.openMissionPresetPickerForWebMcp(),
        );
      },
      getPanelLayout: async (execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return this.panelLayout.getPanelLayoutSnapshot();
      },
      setPanelCollapsed: async (panelId, collapsed, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return this.panelLayout.applyWebMcpSetPanelCollapsed(panelId, collapsed);
      },
      movePanel: async (panelId, region, index, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return this.panelLayout.applyWebMcpMovePanel(panelId, region, index);
      },
      setPanelFullscreen: async (panelId, fullscreen, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return this.panelLayout.applyWebMcpSetPanelFullscreen(panelId, fullscreen);
      },
      getAccessContext: async (execution) => {
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return getWebMcpAccessContext({
          enabledPanelUsed: Object.entries(this.state.panelSettings)
            .filter(([key, panel]) => panel.enabled && key !== 'map').length,
          dashboardTabCount: this.panelLayout.getDashboardTabCount(),
        });
      },
      openSignIn: async (execution) => {
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return openWebMcpSignIn(execution?.signal);
      },
    };
  }

  public async init(webMcpController: AbortController | null): Promise<void> {
    const initStart = performance.now();
    markLcpDebug('wm:boot:app-init-start');

    // src/main.ts registers WebMCP before loading App. Own its controller before
    // the first await so a failed init unregisters those tools through destroy().
    this.webMcpController = webMcpController;

    window.addEventListener(I18N_RESOURCES_LOADED_EVENT, this.handleI18nResourcesLoaded);

    await initDB();
    await initI18n();
    markLcpDebug('wm:boot:i18n-ready');
    initDeferredDashboardFonts();
    // Localize the static index.html shell — <title>, meta description, and
    // the accessible <h1> are baked in English before the app boots; once i18n
    // is ready we swap them to the user's locale.
    // The <title> comes from VARIANT_META via meta-tags.ts.
    const setMeta = (sel: string, val: string) => {
      const el = document.querySelector(sel);
      if (el) el.setAttribute('content', val);
    };
    setMeta('meta[name="description"]', t('shell.metaDescription'));
    setMeta('meta[property="og:title"]', t('shell.documentTitle'));
    setMeta('meta[property="og:description"]', t('shell.metaDescription'));
    setMeta('meta[name="twitter:title"]', t('shell.documentTitle'));
    setMeta('meta[name="twitter:description"]', t('shell.metaDescription'));
    // Mirror of OG_LOCALE in pro-test/src/i18n.ts. The two packages have
    // separate Vite roots and bundlers and can't share an import — keep the
    // tables aligned by hand when adding a locale here OR there.
    const ogLocaleMap: Record<string, string> = {
      en: 'en_US', bg: 'bg_BG', cs: 'cs_CZ', fr: 'fr_FR', de: 'de_DE', el: 'el_GR',
      es: 'es_ES', hr: 'hr_HR', hu: 'hu_HU', it: 'it_IT', pl: 'pl_PL', pt: 'pt_BR',
      nl: 'nl_NL', sv: 'sv_SE', ru: 'ru_RU', uk: 'uk_UA', ar: 'ar_SA', fa: 'fa_IR', zh: 'zh_CN',
      'zh-TW': 'zh_TW',
      ja: 'ja_JP', ko: 'ko_KR', ro: 'ro_RO', tr: 'tr_TR', th: 'th_TH', vi: 'vi_VN',
      hi: 'hi_IN', sw: 'sw_TZ',
    };
    // Look the full tag up first: a region-bearing locale (zh-TW) has its own
    // entry above that a region-stripped key would never reach.
    const docLang = document.documentElement.lang || 'en';
    const baseLang = docLang.split('-')[0] || 'en';
    setMeta('meta[property="og:locale"]', ogLocaleMap[docLang] || ogLocaleMap[baseLang] || `${baseLang}_${baseLang.toUpperCase()}`);
    const srH1 = document.querySelector('body > h1');
    if (srH1) srH1.textContent = t('shell.documentTitle');
    const aiFlow = getAiFlowSettings();
    // Optional local AI initializes independently of the dashboard critical
    // path (#7779): boot proceeds to layout, event handlers and basic panels
    // immediately; the worker settles in the background. The epoch guards
    // detached continuations: disable/destroy during capability detection,
    // worker startup or model restoration resolves late continuations as false
    // instead of downloading models or restarting for a dead app generation.
    // destroy() bumps the epoch first, so a stale continuation from a
    // torn-down App can never load a model into the shared worker a fresh
    // same-document App reuses. The failed/unavailable path leaves the
    // dashboard usable; explicit AI operations fail visibly through the
    // manager's readiness promises instead.
    const localAiEpoch = this.localAiInitEpoch;
    // Same authority as before: browserModel on web, unconditional on desktop.
    // Headline Memory needs no extra disjunct — on web its effective gate
    // already requires browserModel, on desktop the runtime check covers it.
    if (aiFlow.browserModel || isDesktopRuntime()) {
      void (async () => {
        try {
          const ready = await mlWorker.init();
          if (this.localAiInitEpoch !== localAiEpoch || this.state.isDestroyed) return;
          if (!ready) return;
          if (!getAiFlowSettings().browserModel && !isDesktopRuntime()) return;
          if (BETA_MODE) mlWorker.loadModel('summarization-beta').catch(() => { });
        } catch {
          // Worker failure must not break boot; explicit AI operations fail
          // visibly through the manager's readiness promises instead.
        }
      })();
    }

    // Headline Memory requires Browser Local Model to be ON — `isHeadlineMemoryEnabled()`
    // ANDs both flags. Without this gate, leaving Headline Memory on while turning
    // Browser Local Model off would silently download/run an embeddings model the user
    // opted out of via the parent toggle. Joins the detached boot continuation
    // above (shared in-flight init, no duplicate worker): on slow workers this
    // waits without blocking layout or panels.
    if (isHeadlineMemoryEnabled()) {
      void mlWorker.whenReady('app-boot:headline-memory').then((ready) => {
        if (!ready) return;
        if (this.localAiInitEpoch !== localAiEpoch || this.state.isDestroyed) return;
        if (!isHeadlineMemoryEnabled()) return;
        mlWorker.loadModel('embeddings').catch(() => { });
      }).catch(() => { });
    }

    this.unsubAiFlow = subscribeAiFlowChange((key) => {
      // Detached continuations re-read current settings and the app lifetime
      // before requesting a model: a toggle that went away while the worker
      // was starting must not leave a model downloading (#7779).
      if (key === 'browserModel') {
        const s = getAiFlowSettings();
        if (s.browserModel) {
          // init(), not whenReady(): cold-boot with the toggle off leaves the
          // manager disabled, and whenReady() on a disabled manager resolves
          // false without starting anything — the enable path must START the
          // worker (#7796 review P1). init() is idempotent over an already
          // running worker, so a racing boot continuation cannot duplicate it.
          const epoch = this.localAiInitEpoch;
          void mlWorker.init().then((ready) => {
            if (!ready) return;
            if (this.localAiInitEpoch !== epoch || this.state.isDestroyed) return;
            // Re-honor Headline Memory's persisted value on parent re-enable.
            if (isHeadlineMemoryEnabled()) {
              mlWorker.loadModel('embeddings').catch(() => { });
            }
          }).catch(() => { });
        } else if (!isDesktopRuntime()) {
          // Browser Local Model is the parent toggle for ALL local-model use,
          // including Headline Memory. Terminate unconditionally on web —
          // any persisted Headline Memory value is now non-effective.
          mlWorker.terminate();
        }
      }
      if (key === 'headlineMemory') {
        if (isHeadlineMemoryEnabled()) {
          // init(), not whenReady(): Headline Memory can be toggled on while
          // the manager was never started (web boot with browserModel off) —
          // waiting would resolve false without starting anything, and its
          // effective gate already implies the parent toggle (#7796 review P1).
          const epoch = this.localAiInitEpoch;
          void mlWorker.init().then((ready) => {
            if (!ready) return;
            if (this.localAiInitEpoch !== epoch || this.state.isDestroyed) return;
            if (!isHeadlineMemoryEnabled()) return;
            mlWorker.loadModel('embeddings').catch(() => { });
          }).catch(() => { });
        } else {
          mlWorker.unloadModel('embeddings').catch(() => { });
          const s = getAiFlowSettings();
          if (!s.browserModel && !isDesktopRuntime()) {
            mlWorker.terminate();
          }
        }
      }
    });

    // Wait for sidecar readiness on desktop so bootstrap hits a live server.
    // Consume the result: a sidecar that never answered its own health probe
    // should leave a signal rather than being silently treated as ready (#6779).
    if (isDesktopRuntime()) {
      const sidecarReady = await waitForSidecarReady(3000);
      markLcpDebug(sidecarReady ? 'wm:boot:sidecar-ready' : 'wm:boot:sidecar-not-ready');
      if (!sidecarReady) {
        console.warn('[boot] Local sidecar did not report ready within 3s; bootstrap may fall back to cloud.');
      }
    }

    // Anonymous browser session token (issue #3541). Server's validateApiKey
    // no longer trusts header-only signals (Origin / Referer / Sec-Fetch-Site
    // are all forgeable). Install a fetch interceptor ONCE, then mint a
    // wms_-prefixed HMAC token before the first API call. Desktop has its own
    // API key path and doesn't need this; Clerk-authenticated users will pass
    // their JWT in a Bearer header and the interceptor steps aside.
    if (!isDesktopRuntime()) {
      window.addEventListener(WM_SESSION_DEGRADED_EVENT, this.handleWmSessionDegraded);
      installWmSessionFetchInterceptor();
      // Guarded like every other call site (the interceptor's own, and both
      // periodic-refresh handlers). ensureWmSession() genuinely rejects on the
      // old WebView / Smart-TV engines this module targets — `new
      // AbortController()` and the timeout setTimeout sit outside mintSession's
      // try — and init() has no try/catch, so a bare await would abort boot
      // here: no bootstrap hydration, no auth, no UI. main.ts catches that with
      // `.catch(console.error)`, so it would not even reach Sentry. Session
      // establishment is best-effort at this point; the refresh-on-401 layer is
      // the safety net.
      await ensureWmSession().catch(() => false);
      markLcpDebug('wm:boot:session-ready');
    }

    // Hydrate in-memory cache from bootstrap endpoint. Awaits only the fast tier; the slow
    // tier loads in the background (off the first-paint critical path, #4488) and calls back
    // when it lands so the connectivity indicator re-snapshots (no reactive emitter exists).
    await fetchBootstrapData(() => {
      if (this.state.isDestroyed) return;
      this.bootstrapHydrationState = getBootstrapHydrationState();
      this.updateConnectivityUi();
      this.completePendingSlowTierFanout();
    });
    markLcpDebug('wm:boot:fast-bootstrap-ready');
    this.bootstrapHydrationState = getBootstrapHydrationState();

    // Verify OAuth OTT and hydrate auth session BEFORE any UI subscribes to auth state
    await initAuthState();
    initAuthAnalytics();
    installCloudPrefsSync(SITE_VARIANT);
    window.addEventListener(CLOUD_PREFS_APPLIED_EVENT, this.handleCloudPrefsApplied);
    this.migrateDisabledFeedsSchema();

    let _prevUserId: string | null = null;
    this.unsubAuth = subscribeAuthState((session) => {
      const userId = session.user?.id ?? null;
      if (userId !== null && userId !== _prevUserId) {
        // A new account must never reuse the previous account's cached token.
        clearClerkTokenCache();
        void cloudPrefsSignIn(userId, SITE_VARIANT);
      } else if (userId === null && _prevUserId !== null) {
        clearClerkTokenCache();
        cloudPrefsSignOut();
      }
      _prevUserId = userId;
    });

    const geoCoordsPromise: Promise<PreciseCoordinates | null> =
      this.state.isMobile && this.state.initialUrlState?.lat === undefined && this.state.initialUrlState?.lon === undefined
        ? resolvePreciseUserCoordinates(5000)
        : Promise.resolve(null);

    // Readiness must not wait for permission/position work (#7778): seed the
    // initial region synchronously from usable cached region/coordinates, else
    // timezone, else global (desktop map startup stays global because layout
    // reads this value before the background refinement below can land), then
    // let the shared in-flight lookup refine it in the background without
    // gating layout or event-handler setup. Desktop keeps its prior
    // region-ranked predictions via the same background path; only the map
    // view and the precise recenter stay mobile-only.
    this.state.resolvedLocation = initialRegionFromCache(this.state.isMobile);
    void resolveUserRegion().then(
      (region) => {
        if (this.state.isDestroyed) return;
        this.applyLateGeoRegion(region);
      },
      () => { /* failed location keeps the synchronous fallback usable */ },
    );

    // Phase 1: Layout (creates map + panels — they'll find hydrated data).
    // init() is async so the dynamic MapContainer import can resolve before
    // downstream code (e.g. mobileGeoCoords→state.map.setCenter) reads ctx.map.
    markLcpDebug('wm:layout:init-start');
    await this.panelLayout.init();
    markLcpDebug('wm:layout:init-complete');
    this.eventHandlers.setupSearchControls();
    this.updateConnectivityUi();
    window.addEventListener('online', this.handleConnectivityChange);
    window.addEventListener('offline', this.handleConnectivityChange);

    // The single automatic precise recenter for this startup (mobile only,
    // never desktop) runs as background work so a slow position lookup never
    // blocks layout, event-handler, or data readiness (#7778). It fires only
    // while the app is alive and no explicit URL view/coordinates or
    // user/programmatic navigation has claimed the camera since layout: the
    // authority snapshot below is taken after map construction, and any later
    // pan/zoom (humanViewportInteractionToken), preset, search, or country
    // navigation supersedes it.
    const recenterAuthorityToken = this.state.map?.getViewportAuthorityToken() ?? 0;
    const urlClaimedCamera = this.state.initialUrlState != null && (
      this.state.initialUrlState.view !== undefined ||
      (this.state.initialUrlState.lat !== undefined && this.state.initialUrlState.lon !== undefined)
    );
    void geoCoordsPromise.then((mobileGeoCoords) => {
      if (!mobileGeoCoords || this.state.isDestroyed) return;
      if (!this.state.isMobile || this.autoGeoRecenterApplied || urlClaimedCamera) return;
      const map = this.state.map;
      if (!map || map.getViewportAuthorityToken() !== recenterAuthorityToken) return;
      this.autoGeoRecenterApplied = true;
      map.setCenter(mobileGeoCoords.lat, mobileGeoCoords.lon, 6);
    });

    // Phase 2: Shared UI components
    initBreakingNewsAlerts();
    this.state.breakingBanner = new BreakingNewsBanner();

    // Phase 3: UI setup methods
    this.eventHandlers.startHeaderClock();
    this.eventHandlers.setupPlaybackControl();
    this.eventHandlers.setupStatusPanel();
    this.eventHandlers.setupLlmStatusIndicator();
    this.eventHandlers.setupExportPanel();
    this.eventHandlers.setupSearchControls();

    // Correlation engine is constructed lazily at its post-loadAllData run site
    // (Phase 6 below) so its bytes + adapters stay off the eager boot graph (#4486).
    this.eventHandlers.setupUnifiedSettings();
    this.eventHandlers.setupAuthWidget();
    // Phase 4: MapLayerHandlers. SearchManager is lazy-loaded
    // on first CMD+K/search-button open so its modal catalog stays off startup.
    this.eventHandlers.setupMapLayerHandlers();
    // Unblock any WebMCP tool invocations that arrived during startup.
    this.resolveUiReady();
    markLcpDebug('wm:boot:webmcp-ui-ready');

    // Phase 5: Event listeners + URL sync
    this.eventHandlers.init();
    // Capture deep link params BEFORE URL sync overwrites them
    this.pendingDeepLinkSearchQuery = readDashboardSearchQuery(window.location.search);
    this.eventHandlers.setupUrlStateSync();
    if (import.meta.env.VITE_E2E === '1') {
      document.documentElement.dataset.wmEventHandlersReady = 'true';
    }

    // Start deep link handling early — its retry loop polls hasSufficientData()
    // independently, so it must not be gated behind loadAllData() which can hang.
    this.handleDeepLinks();

    // Phase 6: Data loading
    this.dataLoader.syncDataFreshnessWithLayers();
    const slowTierReady = this.waitForSlowBootstrapCheckpoint();
    if (this.state.isDestroyed) return;
    // forceAll=false at bootstrap: data-loader's existing per-panel
    // viewport gate (shouldLoad(id) = forceAll || isPanelNearViewport(id))
    // now actually fires, cutting the ~80-request fan-out down to the
    // panels currently above the fold. IntersectionObserver wiring in
    // panel-layout.ts plus handleViewportPrime above re-trigger
    // loadAllData() as below-fold panels enter the viewport. (#3990)
    // Slow-tier hydration keys are consume-once (getHydratedData deletes on
    // read) and the visible-data consumers in loadAllData read them at task
    // start. If the fan-out runs before the slow tier settles, those reads miss
    // and fall back to per-panel RPCs that never re-read the late payload —
    // wasting the ~500 KB slow-tier bootstrap. The shell LCP element already
    // painted back in panelLayout.init() (Phase 1), so awaiting here is OFF the
    // LCP critical path; it stays bounded by waitForBootstrapSlowTier's timeout
    // (3.5 s browser / 8.5 s desktop). (#4512)
    const settled = await slowTierReady;
    if (this.state.isDestroyed) return;
    if (!settled) {
      this.slowTierWaitTimedOut = true;
      // No fan-out mark here: the deferred runVisibleDataFanout() emits the paired
      // start/complete, and a second start would read as a phantom fan-out.
      await this.dataLoader.loadAllData();
    } else {
      await this.runVisibleDataFanout();
    }
    void this.preloadCountryGeometryForPostLcpWork();

    // If bootstrap was served from cache but live data just loaded, promote the status indicator
    markBootstrapAsLive();
    this.bootstrapHydrationState = getBootstrapHydrationState();
    this.updateConnectivityUi();

    // Hide unconfigured layers after first data load
    if (isOutagesConfigured() === false) {
      this.state.map?.hideLayerToggle('outages');
    }

    // Phase 7: Refresh scheduling
    this.setupRefreshIntervals();
    this.eventHandlers.setupSnapshotSaving();
    cleanOldSnapshots().catch((e) => console.warn('[Storage] Snapshot cleanup failed:', e));

    // Phase 8: Update checks
    this.desktopUpdater.init();

    // Analytics
    trackEvent('wm_app_loaded', {
      load_time_ms: Math.round(performance.now() - initStart),
      panel_count: Object.keys(this.state.panels).length,
    });
    this.eventHandlers.setupPanelViewTracking();
  }

  /**
   * Apply a late-arriving geolocation region without another network request
   * solely for geolocation (#7778). Updates prediction prioritization from the
   * kept candidate set using the same regional match rules; the failed-location
   * path keeps the synchronous fallback usable without a map jump. Never
   * late-recenters desktop. Guarded on isDestroyed so callbacks from a
   * destroyed (re-initialized) App cannot move the new map or its panels.
   */
  private applyLateGeoRegion(region: string): void {
    if (this.state.isDestroyed) return;
    if (!region || region === 'global') return;
    if (region === this.state.resolvedLocation) return;
    this.state.resolvedLocation = region as AppContext['resolvedLocation'];
  }

  /**
   * One-time recovery for the pre-2026-05-01 alphabetical source-cap bug,
   * which left whole categories fully disabled. Gated by disabledFeedsSchema
   * so a category the user deliberately disables afterwards stays disabled.
   */
  private migrateDisabledFeedsSchema(): void {
    const schemaVersion = loadFromStorage<number>(STORAGE_KEYS.disabledFeedsSchema, 0);
    if (schemaVersion >= 1) return;
    const disabled = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));
    const recoverable = findFullyDisabledCategories(FEEDS, disabled);
    if (recoverable.length > 0) {
      for (const name of recoverable) disabled.delete(name);
      saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(disabled));
      console.log(`[App] One-time v1-cap-bug migration: re-enabled ${recoverable.length} source(s) from fully-disabled categories. This will not run again.`);
    }
    saveToStorage(STORAGE_KEYS.disabledFeedsSchema, 1);
  }

  public destroy(): void {
    // Invalidate optional local-AI continuations FIRST: any detached
    // mlWorker.whenReady() callback captured below terminates instead of
    // downloading models or restarting for a destroyed app (#7779).
    this.localAiInitEpoch += 1;
    this.state.isDestroyed = true;
    this.autoGeoRecenterApplied = false;
    this.resolveAppDestroyed();
    // Cancel in-flight App-owned waits before DOM teardown can mutate the
    // document and wake a waiter that still closes over this instance.
    this.lifecycleController.abort();
    // Unregister agent entry points before the rest of teardown. In particular,
    // init-failure cleanup may run on a partially initialised App; even if a
    // later module cleanup throws, no WebMCP tool may retain this dead instance.
    this.webMcpController?.abort();
    this.webMcpController = null;
    this.viewportHydrationReady = false;
    this.viewportHydrationReadyAt = 0;
    this.viewportTriggersArmed = false;
    this.slowTierWaitTimedOut = false;
    cancelBootstrapSlowTier();
    window.removeEventListener('scroll', this.handleViewportPrime, { capture: true });
    window.removeEventListener('resize', this.handleViewportPrime);
    window.removeEventListener('online', this.handleConnectivityChange);
    window.removeEventListener('offline', this.handleConnectivityChange);
    window.removeEventListener(I18N_RESOURCES_LOADED_EVENT, this.handleI18nResourcesLoaded);
    window.removeEventListener(CLOUD_PREFS_APPLIED_EVENT, this.handleCloudPrefsApplied);
    if (this.visiblePanelPrimeRaf !== null) {
      window.cancelAnimationFrame(this.visiblePanelPrimeRaf);
      this.visiblePanelPrimeRaf = null;
    }
    if (this.stockDeepLinkTimer !== null) {
      window.clearTimeout(this.stockDeepLinkTimer);
      this.stockDeepLinkTimer = null;
    }

    try {
      // Destroy all modules in reverse order. A single destructor must not skip
      // remaining modules or the map/AIS tail cleanup.
      for (let i = this.modules.length - 1; i >= 0; i--) {
        try {
          this.modules[i]!.destroy();
        } catch {
          // Continue tearing down the rest of the dashboard.
        }
      }
    } finally {
      // Clean up subscriptions, map, AIS, and breaking news
      this.unsubAiFlow?.();
      this.unsubAuth?.();
      mlWorker.terminate();
      this.state.breakingBanner?.destroy();
      destroyBreakingNewsAlerts();
      this.cachedModeBannerEl?.remove();
      this.cachedModeBannerEl = null;
      window.removeEventListener(WM_SESSION_DEGRADED_EVENT, this.handleWmSessionDegraded);
      this.state.map?.destroy();
    }
  }

  // Waits for Phase-4 UI modules to finish initialising. WebMCP bindings call
  // this before touching nullable UI
  // state so a tool invoked during startup waits rather than throwing;
  // the timeout guards against a genuinely broken init path hanging the
  // agent forever.
  private async waitForUiReady(
    signal?: AbortSignal,
    timeoutMs = WEBMCP_UI_READY_TIMEOUT_MS,
  ): Promise<void> {
    await waitForWebMcpUiReady(this.uiReady, this.appDestroyed, timeoutMs, 'UI', signal);
  }

  private async waitForDashboardReady(
    requireMapRenderer = true,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.waitForUiReady(signal);
      if (!requireMapRenderer) return;
      const map = this.state.map;
      if (map) {
        await waitForWebMcpUiReady(
          map.whenRendererReady(),
          this.appDestroyed,
          15_000,
          'Map renderer',
          signal,
        );
      }
    } catch (error) {
      throwIfWebMcpAborted(signal);
      // A dashboard binding that loses the readiness/destroy race must reach
      // the narrow context/applier seam so it can return its closed
      // app_destroyed reason. Genuine readiness timeouts still reject.
      if (!this.state.isDestroyed) throw error;
    }
  }

  private handleDeepLinks(): void {
    const url = new URL(window.location.href);
    const DEEP_LINK_INITIAL_DELAY_MS = 1500;

    // SearchAction lands on /dashboard?q=… after URL sync has already rewritten
    // the address bar. Consume the captured term through the same lazy path as
    // Cmd+K so the modal is created only when a query is actually present.
    const searchQuery = this.pendingDeepLinkSearchQuery;
    this.pendingDeepLinkSearchQuery = null;
    if (
      searchQuery
      && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')
    ) {
      void this.openSearch({ initialQuery: searchQuery });
      return;
    }

    if (isStockResearchPath(url.pathname)) {
      const stockSymbol = stockResearchSymbolFromPath(url.pathname);
      if (stockSymbol) {
        trackDeeplinkOpened('stock', stockSymbol);
        this.stockDeepLinkTimer = window.setTimeout(() => {
          this.stockDeepLinkTimer = null;
          if (this.state.isDestroyed) return;
          void openStockResearchOverlay(stockSymbol);
        }, DEEP_LINK_INITIAL_DELAY_MS);
      }
    }
  }

  private setupRefreshIntervals(): void {
    // Always refresh news for all variants
    this.refreshScheduler.scheduleRefresh('news', () => this.dataLoader.loadNews(), REFRESH_INTERVALS.feeds);
    // Registration (and its immediate first hydration) is deferred to
    // post-paint idle: freshness badges are below-the-fold decoration, so the
    // fetch must not compete with the LCP-window requests (#4907, #4890).
    scheduleAfterFirstPaint(() => {
      this.refreshScheduler.scheduleRefresh(
        'health-freshness',
        async () => { await refreshDataFreshnessFromHealth(); },
        REFRESH_INTERVALS.healthFreshness,
        undefined,
        { runImmediately: true },
      );
    });

    this.refreshScheduler.registerAll([
      {
        name: 'markets',
        fn: () => this.dataLoader.loadMarkets(),
        intervalMs: REFRESH_INTERVALS.markets,
        condition: () => this.isAnyPanelNearViewport(['markets', 'commodities']),
      },
      { name: 'natural', fn: () => this.dataLoader.loadNatural(), intervalMs: REFRESH_INTERVALS.natural, condition: () => this.state.mapLayers.natural },
      { name: 'weather', fn: () => this.dataLoader.loadWeatherAlerts(), intervalMs: REFRESH_INTERVALS.weather, condition: () => this.state.mapLayers.weather },
      { name: 'pipelineRegistries', fn: () => this.dataLoader.loadPipelineRegistries({ refresh: true }), intervalMs: REFRESH_INTERVALS.pipelineStatus, condition: () => !!this.state.mapLayers.pipelines },
      // inFlight key 'fires' matches the hydration loader and loadDataForLayer
      // (the map-layer key), like every other layer refresh here — so all three
      // firms call sites one-flight the guard-less loadFirmsData (#6770).
      { name: 'fires', fn: () => this.dataLoader.loadFirmsData(), intervalMs: REFRESH_INTERVALS.firms, condition: () => this.shouldRefreshFirms() },
      { name: 'cableHealth', fn: () => this.dataLoader.loadCableHealth(), intervalMs: REFRESH_INTERVALS.cableHealth, condition: () => this.state.mapLayers.cables },
    ]);

    // Panel-level refreshes (moved from panel constructors into scheduler for hidden-tab awareness + jitter)
    this.refreshScheduler.scheduleRefresh(
      'nuclear-reactor-status',
      () => (this.state.panels['nuclear-reactor-status'] as NuclearReactorStatusPanel).fetchData(),
      REFRESH_INTERVALS.nrcReactorStatus,
      () => this.isPanelNearViewport('nuclear-reactor-status')
    );
    this.refreshScheduler.scheduleRefresh(
      'nuclear-events',
      () => (this.state.panels['nuclear-events'] as NuclearEventReportsPanel).fetchData(),
      REFRESH_INTERVALS.nrcEventReports,
      () => this.isPanelNearViewport('nuclear-events')
    );

    this.refreshScheduler.scheduleRefresh(
      'climate-news',
      () => (this.state.panels['climate-news'] as ClimateNewsPanel).fetchData(),
      REFRESH_INTERVALS.climateNews,
      () => this.isPanelNearViewport('climate-news')
    );
  }
}
