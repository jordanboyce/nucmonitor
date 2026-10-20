import type { Monitor, PanelConfig, MapLayers } from '@/types';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import {
  isStockResearchPath,
  stockResearchSymbolFromPath,
} from '@/features/stock-research/stock-research-route';
import { openStockResearchOverlay } from '@/features/stock-research/stock-research-overlay';
import { openExternalUrl } from '@/services/external-navigation';
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
  isPanelEntitled,
  enforceFreePanelLimit,
  restoreFreeMapPanelAccess,
  restoreProGatedPanels,
  shouldDeferFreeTierEnforcement,
  FREE_MAX_PANELS,
  FREE_MAX_SOURCES,
  countFreePanelCapUsage,
} from '@/config';
import {
  sanitizeLayersForVariant,
  sanitizeLockedLayers,
  sanitizeLockedLayersWithOwnership,
  restoreGateOwnedLockedLayers,
  mapLayerStatesEqual,
  shouldSanitizeLockedLayers,
} from '@/config/map-layer-definitions';
import type { MapVariant } from '@/config/map-layer-definitions';
import { getStoredMapModePreference } from '@/services/map-mode-preference';
import {
  initDB,
  cleanOldSnapshots,
  isOutagesConfigured,
} from '@/services';
import { isProUser, isProTierResolved, loadWidgets } from '@/services/widget-store';
import { mlWorker } from '@/services/ml-worker';
import { getAiFlowSettings, subscribeAiFlowChange, isHeadlineMemoryEnabled } from '@/services/ai-flow-settings';
import {
  isMobileDevice,
  isQuotaError,
  loadFromStorage,
  markStorageQuotaExceeded,
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
import { hasPremiumAccess } from '@/services/panel-gating';
import { BETA_MODE } from '@/config/beta';
import { track, trackEvent, trackDeeplinkOpened, initAuthAnalytics, trackMapViewChange } from '@/services/analytics';
import { preloadCountryGeometry } from '@/services/country-geometry';
import { initI18n, t, I18N_RESOURCES_LOADED_EVENT, type I18nResourcesLoadedDetail } from '@/services/i18n';
import { initDeferredDashboardFonts } from '@/bootstrap/secondary-startup';
import { applyFontScale, FONT_SCALE_STORAGE_KEY } from '@/services/font-scale-settings';

import { computeDefaultDisabledSources, FEEDS } from '@/config/feeds';
import {
  findFullyDisabledCategories,
  inferExactSourceGateOwnership,
  reconcileSourceGateOwnership,
  restoreGateOwnedSources,
  selectSourcesUnderCap,
  stringSetsEqual,
} from '@/services/source-cap';
import {
  applyVariantPanelLayoutTransition,
  persistGateOwnershipTransition,
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
  applyWebMcpOpenAlerts,
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
import {
  FreeTierGate,
  panelGateStateChanged,
  shouldRunCloudLegacyRecovery,
  sweepLegacyDisabledCustomWidgets,
} from '@/app/free-tier-gate';
import { replaceRawI18nKeyPlaceholders } from '@/app/i18n-raw-key-healer';
import { startAccountAuthHandoff } from '@/app/account-auth-handoff';
import { TierPreferenceHandoff } from '@/app/tier-preference-handoff';
import { initialRegionFromCache, resolveUserRegion, resolvePreciseUserCoordinates, type PreciseCoordinates } from '@/utils/user-location';
import { showProBanner } from '@/components/ProBanner';
import { getAuthState, initAuthState, subscribeAuthState } from '@/services/auth-state';
import { installSignUpResume } from '@/services/sign-up-resume';
import { createSignUpResumeOverlay } from '@/components/SignUpResumeOverlay';
import {
  CLOUD_PREFS_APPLIED_EVENT,
  CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT,
  getSyncVersion,
  hasPendingCloudPrefsRetry,
  install as installCloudPrefsSync,
  onSignIn as cloudPrefsSignIn,
  onSignOut as cloudPrefsSignOut,
  type CloudPrefsAppliedDetail,
  type CloudPrefsSignInTerminalDetail,
} from '@/utils/cloud-prefs-sync';
import {
  getConvexClient,
  getConvexApi,
  invalidateConvexAuthForSignOut,
  rebindConvexAuthForWatchHandoff,
  waitForConvexAuthForUser,
} from '@/services/convex-client';
import {
  assertAccountStillCurrent,
  isAccountStillCurrent,
  settleAccountOperation,
} from '@/services/account-operation';
import type { Id } from '../convex/_generated/dataModel';
import {
  beginEntitlementVerification,
  destroyEntitlementSubscription,
  getEntitlementState,
  initEntitlementSubscription,
  markEntitlementVerificationUnavailable,
  onEntitlementChange,
  resetEntitlementState,
  resetEntitlementVerification,
} from '@/services/entitlements';
import { initSubscriptionWatch, destroySubscriptionWatch, openBillingPortal } from '@/services/billing';
import {
  captureBillingPortalIntentFromUrl,
  resumePendingBillingPortal,
} from '@/services/billing-portal-intent';
import {
  FREE_TIER_FOLLOW_LIMIT,
  WM_FOLLOWED_COUNTRIES_CAP_DROP,
  addCountry,
  getFollowed,
  installFollowedCountriesAuthListener,
  isFollowFeatureEnabled,
  isFollowed,
  removeCountry,
  serviceEntitlementState,
} from '@/services/followed-countries';
import {
  capturePendingCheckoutIntentFromUrl,
  initCheckoutWatchers,
  resumePendingCheckout,
} from '@/services/checkout';
import {
  clearStoredAnonIdentity,
  getFreshStoredAnonClaimToken,
  getStoredAnonId,
} from '@/services/anonymous-identity-storage';
import { captureReferralFromUrl } from '@/services/referral-capture';
import { nextPrimeRetryDelayMs } from '@/utils/prime-retry';

/** Look-ahead margin for viewport-gated panel priming and refresh scheduling. */
const DEFAULT_VIEWPORT_MARGIN_PX = 400;
const FREE_MAP_PANEL_ACCESS_KEY = 'worldmonitor-free-map-panel-access-v1';
const CW_PRO_GATE_RECOVERY_KEY = 'worldmonitor-cw-pro-gate-recovery-v1';
const CW_PRO_GATE_CLOUD_RECOVERY_BASELINE_KEY = 'worldmonitor-cw-pro-gate-cloud-recovery-baseline-v1';
const CW_PRO_GATE_CLOUD_RECOVERY_APPLIED_KEY = 'worldmonitor-cw-pro-gate-cloud-recovery-applied-v1';

export class App {
  private state: AppContext;
  private resumeBillingPortal(capturedThisLoad = false): Promise<boolean> {
    return resumePendingBillingPortal({
      getUserId: () => getAuthState().user?.id,
      openAuth: () => this.state.authModal?.open(),
      openPortal: () => openBillingPortal(),
      notify: (message) => showToast(message),
    }, capturedThisLoad);
  }

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
  private unsubFreeTier: (() => void) | null = null;
  private unsubEntitlementPremiumLoaders: (() => void) | null = null;
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
  private followedCountriesCapDropToastTimer: number | null = null;
  private bootstrapHydrationState: BootstrapHydrationState = getBootstrapHydrationState();
  private cachedModeBannerEl: HTMLElement | null = null;
  private pendingCloudRecoverySyncVersion: number | undefined;
  /** Token of the in-flight preference handoff, so the cloud-applied event can release it. */
  private pendingPreferenceHandoffGeneration: number | undefined;
  private readonly tierPreferenceHandoff = new TierPreferenceHandoff();
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
  private readonly handleFollowedCountriesCapDrop = (ev: Event): void => {
    const detail = (ev as CustomEvent<{ kept?: unknown; dropped?: unknown }>).detail;
    const dropped = typeof detail?.dropped === 'number' ? detail.dropped : 0;
    const kept = typeof detail?.kept === 'number' ? detail.kept : FREE_TIER_FOLLOW_LIMIT;
    if (dropped <= 0) return;
    this.showFollowedCountriesCapDropToast(kept, dropped);
  };
  private readonly handleCloudPrefsApplied = (ev: Event): void => {
    const detail = (ev as CustomEvent<CloudPrefsAppliedDetail>).detail;
    this.applyCloudSyncedPrefsToRuntime(detail?.keys ?? [], detail?.syncVersion);
  };
  private readonly getMapLayerRuntimeAvailability = (): MapLayerRuntimeAvailability => ({
    outagesAvailable: isOutagesConfigured() !== false,
  });
  private readonly handleCloudPrefsSignInTerminal = (ev: Event): void => {
    const detail = (ev as CustomEvent<CloudPrefsSignInTerminalDetail>).detail;
    const pendingGeneration = this.pendingPreferenceHandoffGeneration;
    if (
      detail?.origin !== 'sign-in'
      || pendingGeneration === undefined
      || detail.handoffGeneration !== pendingGeneration
    ) {
      return;
    }

    const currentUserId = getAuthState().user?.id ?? null;
    if (this.tierPreferenceHandoff.complete(
      pendingGeneration,
      detail.accountId,
      currentUserId,
    )) {
      this.pendingPreferenceHandoffGeneration = undefined;
      // A terminal sign-in attempt is the only handoff release signal. Run
      // one complete pass even when the cloud blob changed no local keys.
      this.reconcileTierOwnedPreferences();
    }
  };

  private applyCloudSyncedPrefsToRuntime(keys: readonly string[], cloudSyncVersion?: number): void {
    if (keys.length === 0) return;

    const keySet = new Set(keys);
    let freeTierLimitsInvoked = false;
    const tierReconciliationDeferred = this.shouldDeferTierPreferenceReconciliation();
    invalidatePanelStorageCacheForKeys(keys);

    if (keySet.has(FONT_SCALE_STORAGE_KEY)) {
      applyFontScale();
    }

    if (keySet.has(STORAGE_KEYS.panels)) {
      // Cloud can reconcile before Clerk/Convex finishes settling. Preserve
      // the first panel-bearing cloud generation so a later Pro callback can
      // still run the bounded legacy recovery pass.
      if (cloudSyncVersion !== undefined && this.pendingCloudRecoverySyncVersion === undefined) {
        this.pendingCloudRecoverySyncVersion = cloudSyncVersion;
      }
      this.state.panelSettings = loadFromStorage<Record<string, PanelConfig>>(
        STORAGE_KEYS.panels,
        this.state.panelSettings,
      );
      // Reconcile the freshly applied snapshot against the current
      // entitlement: a cloud blob written while the tier was unknown can carry
      // a stale free-tier clamp, and `proGated` markers travel with it, so the
      // targeted restore inside enforceFreeTierLimits puts those panels back.
      // Returns false while the tier is still unresolved — the fallback below
      // then just re-renders the snapshot, which is all this handler did
      // before reconciliation moved here.
      const reconciledPanelSettings = tierReconciliationDeferred
        ? false
        : this.enforceFreeTierLimits(cloudSyncVersion);
      freeTierLimitsInvoked = !tierReconciliationDeferred;
      if (!reconciledPanelSettings) {
        this.panelLayout.applyPanelSettings();
        this.state.unifiedSettings?.refreshPanelToggles();
      }
    }

    const panelOrderKey = this.state.PANEL_ORDER_KEY;
    if (keySet.has(panelOrderKey) || keySet.has(`${panelOrderKey}-bottom-set`)) {
      this.panelLayout.applySavedPanelOrder();
    }

    if (
      (keySet.has(STORAGE_KEYS.mapLayers) || keySet.has(STORAGE_KEYS.mapLayerGateOwnership))
      && !this.state.initialUrlState?.layers
    ) {
      let nextLayers = sanitizeLayersForVariant(
        loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, this.state.mapLayers),
        SITE_VARIANT as MapVariant,
      );
      // #6045 — clear locked premium layers once free-tier is settled.
      // Skip while entitlement is still resolving so Pro users don't lose
      // resilienceScore during the Clerk/Convex boot window.
      if (!tierReconciliationDeferred) {
        nextLayers = this.sanitizeMapLayersForTier(nextLayers);
      }
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

    if (
      keySet.has(STORAGE_KEYS.disabledFeeds)
      || keySet.has(STORAGE_KEYS.sourceGateOwnership)
    ) {
      // A cloud generation can contain only source preferences. Re-run the
      // cap even when no panel snapshot arrived, then reload storage because
      // enforcement may have persisted additional auto-disabled sources.
      if (!tierReconciliationDeferred && !freeTierLimitsInvoked) {
        this.enforceFreeTierLimits(cloudSyncVersion);
      }
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
      // Write an explicit empty set rather than removing the key: cloud sync
      // now tolerates an ABSENT ownership sidecar (a row that predates it must
      // not delete local ownership), so a genuine variant-reset clear only
      // propagates cross-device when it is an explicit value.
      localStorage.setItem(STORAGE_KEYS.mapLayerGateOwnership, '[]');
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
      // #6045 — heal stuck locked layers from pre-gate localStorage once free
      // tier is settled. Do not run while Pro status is still resolving.
      // Persist immediately so dirty storage doesn't reintroduce the layer.
      mapLayers = this.sanitizeMapLayersForTier(mapLayers);

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
      // #6045 — URL layer deep-links also cannot force locked layers on for free users.
      // Ephemeral: the link is a view, so it must not overwrite the stored
      // preference or touch gate ownership in either direction.
      mapLayers = this.sanitizeMapLayersForTier(mapLayers, undefined, { ephemeralSnapshot: true });
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
      openSearch: () => {
        track('search-open', { source: 'pro-onboarding' });
        void this.openSearch();
      },
      loadAllData: () => this.dataLoader.loadAllData(),
      primeVisiblePanelData: () => {
        if (!this.viewportHydrationReady || this.state.isDestroyed) return;
        void this.primeVisiblePanelData();
      },
      updateMonitorResults: () => this.dataLoader.updateMonitorResults(),
      applyMapLayerChange: (layer, enabled, source) => this.eventHandlers.applyMapLayerChange(layer, enabled, source),
      isFreeTierFallbackActive: () => this.freeTierGate.authSettleDeadlineExceeded,
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
      mountLiveNewsIfReady: () => this.panelLayout.mountLiveNewsIfReady(),
      isFreeTierFallbackActive: () => this.freeTierGate.authSettleDeadlineExceeded,
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
          hasPremiumAccess(getAuthState()),
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
        return listWebMcpDashboardPanels(this.state, SITE_VARIANT, query, {
          isPanelAllowed: (panelId, config) => (
            isPanelEntitled(panelId, config, hasPremiumAccess(getAuthState()))
          ),
        });
      },
      openSettings: async (execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return applyWebMcpOpenSettings(this.state, SITE_VARIANT);
      },
      openAlerts: async (execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return applyWebMcpOpenAlerts(this.state, SITE_VARIANT);
      },
      applyDashboardAction: async (action, execution) => {
        return runDashboardActionBinding(this.state, action, {
          waitForUiReady: () => this.waitForDashboardReady(false, execution?.signal),
          waitForMapReady: () => this.waitForDashboardReady(true, execution?.signal),
          getMapAuthorityToken: () => this.state.map?.getViewportAuthorityToken() ?? 0,
          signal: execution?.signal,
          applierOptions: {
            getPanelConfig: (panelId) => getEffectivePanelConfig(panelId, SITE_VARIANT),
            isPanelAllowed: (panelId, config) => (
              isPanelEntitled(panelId, config, hasPremiumAccess(getAuthState()))
            ),
            hasPremiumAccess: () => hasPremiumAccess(getAuthState()),
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
        return listWebMcpMissionPresets(this.state, SITE_VARIANT, query, {
          hasPremium: hasPremiumAccess(getAuthState()),
          isPanelEntitled: (panelId) => {
            const config = this.state.panelSettings[panelId]
              ?? getEffectivePanelConfig(panelId, SITE_VARIANT);
            if (!config) return true;
            return isPanelEntitled(panelId, config, hasPremiumAccess(getAuthState()));
          },
        });
      },
      applyMissionPreset: async (presetId, execution) => {
        await this.waitForDashboardReady(true, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return applyWebMcpMissionPreset(this.state, SITE_VARIANT, presetId, {
          hasPremium: hasPremiumAccess(getAuthState()),
          isPanelEntitled: (panelId) => {
            const config = this.state.panelSettings[panelId]
              ?? getEffectivePanelConfig(panelId, SITE_VARIANT);
            if (!config) return true;
            return isPanelEntitled(panelId, config, hasPremiumAccess(getAuthState()));
          },
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
      listFollowedCountries: async (execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        const access = serviceEntitlementState();
        const countries = getFollowed();
        return {
          ok: true,
          enabled: isFollowFeatureEnabled(),
          countries,
          count: countries.length,
          access,
          limit: access === 'free' ? FREE_TIER_FOLLOW_LIMIT : null,
        };
      },
      setCountryFollowed: async (iso2, followed, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        if (typeof followed !== 'boolean') {
          return {
            ok: false,
            status: 'invalid',
            reason: 'malformed_arguments',
            message: 'followed must be a boolean.',
          };
        }
        const code = typeof iso2 === 'string' ? iso2.trim().toUpperCase() : '';
        const wasFollowed = isFollowed(code);
        const result = await (followed ? addCountry(code) : removeCountry(code));
        throwIfWebMcpAborted(execution?.signal);
        if (result.ok) {
          return {
            ok: true,
            status: wasFollowed === followed ? 'unchanged' : 'accepted',
            iso2: code,
            followed,
            message: wasFollowed === followed
              ? `Country ${code} already has the requested followed state.`
              : `Country ${code} followed state change was accepted.`,
          };
        }
        switch (result.reason) {
          case 'INVALID_INPUT':
            return {
              ok: false,
              status: 'invalid',
              reason: 'invalid_country',
              followed,
              message: 'iso2 must identify a supported country.',
            };
          case 'FREE_CAP':
            return {
              ok: false,
              status: 'denied',
              iso2: code,
              followed,
              reason: 'free_cap',
              limit: result.limit ?? FREE_TIER_FOLLOW_LIMIT,
              message: 'The free followed-country limit is already in use.',
            };
          case 'ENTITLEMENT_LOADING':
            return {
              ok: false,
              status: 'denied',
              iso2: code,
              followed,
              reason: 'entitlement_loading',
              message: 'Account access is still loading. Try again after it settles.',
            };
          case 'HANDOFF_PENDING':
            return {
              ok: false,
              status: 'denied',
              iso2: code,
              followed,
              reason: 'handoff_pending',
              message: 'Followed-country state is still syncing. Try again after it settles.',
            };
          case 'STORAGE_FULL':
            return {
              ok: false,
              status: 'denied',
              iso2: code,
              followed,
              reason: 'storage_full',
              message: 'The browser could not save the followed-country state.',
            };
          case 'DISABLED':
            return {
              ok: false,
              status: 'denied',
              iso2: code,
              followed,
              reason: 'disabled',
              message: 'Followed countries are not available on this dashboard.',
            };
        }
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
          enabledPanelUsed: countFreePanelCapUsage(this.state.panelSettings),
          dashboardTabCount: this.panelLayout.getDashboardTabCount(),
          freeTierFallbackActive: this.freeTierGate.authSettleDeadlineExceeded,
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
    installSignUpResume(createSignUpResumeOverlay());
    installCloudPrefsSync(SITE_VARIANT);
    window.addEventListener(CLOUD_PREFS_APPLIED_EVENT, this.handleCloudPrefsApplied);
    window.addEventListener(
      CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT,
      this.handleCloudPrefsSignInTerminal,
    );
    // Install the followed-countries auth listener once. Drives the
    // anon→signed-in handoff (mergeAnonymousLocal mutation) and sign-out
    // cleanup. Idempotent.
    installFollowedCountriesAuthListener();
    window.addEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, this.handleFollowedCountriesCapDrop);
    this.enforceFreeTierLimits();

    let _prevUserId: string | null = null;
    let _convexWatchHandoffGeneration = 0;
    // Track the last-seen PRO entitlement so we can re-fire PRO-gated loaders
    // on a false→true transition or an account change while still premium.
    // Without this, loaders gated behind hasPremiumAccess() at init time (e.g.
    // loadTradePolicy) would sit empty until the next scheduled refresh — for
    // trade-policy that's a 10-minute wait post-sign-in. See PR #3295 review.
    let _prevHadPremium = hasPremiumAccess();
    // Pro-loader fan-out runs on EITHER Clerk auth changes OR Convex
    // entitlement changes — Pro can come from either signal (Clerk
    // user.role === 'pro' OR Convex tier >= 1 via Dodo). User-reported
    // on commodity.worldmonitor.app: Trade Policy panel stuck at "Loading…"
    // for a Pro Monthly subscriber because the original listener only
    // watched subscribeAuthState (Clerk-only); Convex Free→Pro transitions
    // never re-fired loadTradePolicy. Same root cause as PR #3409 layer-unlock.
    const firePremiumLoaders = (accountTransition = false): void => {
      // Account sign-in replaces anonymous/local preferences asynchronously.
      // Entitlement callbacks may arrive first; defer every ownership mutation
      // until cloud prefs signals success or error for this same account.
      this.reconcileTierOwnedPreferences();
      const hadPremium = _prevHadPremium;
      const nowPremium = hasPremiumAccess();
      if (nowPremium && (!hadPremium || accountTransition)) {
        // Load panels skipped at boot or cleared for an account change.
        // Each loader early-returns if the panel isn't
        // mounted and re-checks hasPremiumAccess() internally, so these
        // calls are safe and idempotent. Without this, panels would sit empty
        // until the next scheduled refresh (10+ min for trade-policy; FOREVER
        // on the full variant for stock-analysis / stock-backtest / daily-
        // market-brief / market-implications because their schedulers are
        // gated to SITE_VARIANT === 'finance'). The audit-locking regression
        // test in tests/premium-loaders-fan-out-coverage.test.mts asserts
        // every premium gate in data-loader.ts
        // has a matching call here.
        void this.dataLoader.loadPhysicalPremiumComparison();
      } else if (!nowPremium && hadPremium) {
        // Pro data must not remain visible or available from the client cache
        // after sign-out, expiry, or downgrade.
        this.dataLoader.clearPhysicalPremiumComparison();
      }
      _prevHadPremium = nowPremium;
    };
    this.unsubEntitlementPremiumLoaders = onEntitlementChange(() => firePremiumLoaders());
    this.unsubFreeTier = subscribeAuthState((session) => {
      const userId = session.user?.id ?? null;
      const accountTransition = (
        (userId !== null && userId !== _prevUserId) ||
        (userId === null && _prevUserId !== null)
      );
      if (accountTransition) {
        // A cloud snapshot and its recovery version belong to the account that
        // was active when they arrived. Do not let a late Pro reconcile for a
        // different account consume that pending recovery opportunity.
        this.pendingCloudRecoverySyncVersion = undefined;
        this.freeTierGate.resetForAuthTransition();
      }

      if (userId !== null && userId !== _prevUserId) {
        const handoffGeneration = ++_convexWatchHandoffGeneration;
        // The token fences a LATE completion from a previous attempt for the
        // same account (sign-in A -> sign-out -> sign-in A): the queue settles
        // that stale attempt before this one runs, and an id-only guard would
        // let it release a handoff it does not own. The expiry callback is the
        // backstop for an attempt that never reaches a terminal outcome.
        const preferenceHandoffGeneration = this.tierPreferenceHandoff.begin(
          userId,
          () => { this.reconcileTierOwnedPreferences(); },
          // A 503 keeps the sign-in legitimately in flight for up to
          // Retry-After, which can outlast one grace window. Waiting beats
          // reconciling against pre-cloud state; the handoff's own ceiling
          // stops that wait from becoming indefinite.
          () => hasPendingCloudPrefsRetry(),
        );
        this.pendingPreferenceHandoffGeneration = preferenceHandoffGeneration;

        // Rebind Convex watches to the real Clerk userId (was bound to anon UUID at init)
        // destroyEntitlementSubscription deliberately PRESERVES the last
        // snapshot so a WebSocket reconnect doesn't flash paying users back to
        // locked. That preservation is wrong across an account change: until
        // the new user's first snapshot lands, getEntitlementState() still
        // describes the previous one. Anything reading it then attributes A's
        // plan to B — e.g. premium-denial's clientBelievesPro would read B's
        // legitimate 403 as A's entitlement desync and retry instead of
        // showing the upgrade CTA. Sign-out already resets for this reason;
        // an account switch carries the same hazard.
        void startAccountAuthHandoff({
          userId,
          isCurrent: () => (
            handoffGeneration === _convexWatchHandoffGeneration &&
            getAuthState().user?.id === userId
          ),
          effects: {
            destroyEntitlementSubscription,
            beginEntitlementVerification,
            resetEntitlementState,
            markEntitlementVerificationUnavailable,
            destroySubscriptionWatch,
            rebindConvexAuthForWatchHandoff,
            initEntitlementSubscription,
            initSubscriptionWatch,
            cloudPrefsSignIn: (nextUserId) => {
              return cloudPrefsSignIn(nextUserId, SITE_VARIANT, {
                handoffGeneration: preferenceHandoffGeneration,
              });
            },
          },
        });

        // Claim any anonymous purchase made before sign-in (anon → real user migration)
        const anonId = getStoredAnonId();
        if (anonId) {
          void (async () => {
            const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
            if (!client || !api) return;
            // Wait for ConvexClient WebSocket auth handshake to complete.
            // Without this, mutations arrive at Convex before the server
            // has the JWT → "Authentication required" errors.
            const ready = await waitForConvexAuthForUser(userId, 10_000);
            if (!ready) {
              console.warn('[billing] claimSubscription skipped — Convex auth not ready');
              return;
            }
            const claimToken = getFreshStoredAnonClaimToken() ?? undefined;
            const result = await settleAccountOperation(
              userId,
              'claiming the anonymous subscription',
              () => client.mutation(api.payments.billing.claimSubscription, {
                anonId,
                ...(claimToken ? { claimToken } : {}),
              }),
            );
            assertAccountStillCurrent(userId, 'claiming the anonymous subscription');
            const claimed = result.claimed;
            const totalClaimed = claimed.subscriptions + claimed.entitlements +
                                 claimed.customers + claimed.payments;
            if (totalClaimed > 0) {
              console.log('[billing] Claimed anon subscription on sign-in:', claimed);
            }
            // Always remove after non-throwing completion — mutation is idempotent.
            // Prevents cold Convex init + mutation on every sign-in for non-purchasers.
            clearStoredAnonIdentity();
          })().catch((err: unknown) => {
            if (!isAccountStillCurrent(userId)) return;
            console.warn('[billing] claimSubscription failed:', err);
            // Non-fatal — anon ID preserved for retry on next page load
          });
        }

        // Accept a Business Pro seat invite carried in the URL (mirror of the
        // anon-claim hook). The invite link is /settings?accept-business-invite=<id>&token=<t>.
        // Runs after sign-in so the invitee's Clerk email is available server-side.
        const businessInviteGrantId = new URLSearchParams(window.location.search).get('accept-business-invite');
        const businessInviteToken = new URLSearchParams(window.location.search).get('token');
        if (businessInviteGrantId && businessInviteToken) {
          void (async () => {
            const [client, api] = await Promise.all([getConvexClient(), getConvexApi()]);
            if (!client || !api) return;
            const ready = await waitForConvexAuthForUser(userId, 10_000);
            if (!ready) {
              console.warn('[business-seats] acceptBusinessInvite skipped — Convex auth not ready');
              return;
            }
            try {
              await settleAccountOperation(
                userId,
                'accepting the Business Pro seat invite',
                () => client.mutation(api.payments.businessSeats.acceptBusinessInvite, {
                  grantId: businessInviteGrantId as Id<'businessProGrants'>,
                  token: businessInviteToken,
                }),
              );
              assertAccountStillCurrent(userId, 'accepting the Business Pro seat invite');
              showToast('Pro seat activated');
            } catch (err) {
              if (!isAccountStillCurrent(userId)) return;
              const msg = err instanceof Error ? err.message : 'Failed to accept invite';
              if (msg.includes('INVITE_EMAIL_MISMATCH')) {
                showToast('This invite is for a different email address');
              } else if (msg.includes('INVITE_EXPIRED')) {
                showToast('This invite has expired');
              } else if (msg.includes('BUSINESS_NOT_ACTIVE')) {
                showToast('The Business plan that sent this invite is no longer active');
              } else if (msg.includes('INVITE_ALREADY_USED')) {
                showToast('This invite has already been used');
              } else {
                showToast('Could not accept invite');
              }
              console.warn('[business-seats] acceptBusinessInvite failed:', err);
            } finally {
              // Clear the invite params from the URL so a refresh does not retry.
              const url = new URL(window.location.href);
              url.searchParams.delete('accept-business-invite');
              url.searchParams.delete('token');
              window.history.replaceState({}, '', url.toString());
            }
          })();
        }
        void resumePendingCheckout({
          openAuth: () => this.state.authModal?.open(),
        });
        void this.resumeBillingPortal();
      } else if (userId === null && _prevUserId !== null) {
        // Clerk's mounted UserButton signs out through the SDK directly, so
        // this observed transition is the authoritative place to invalidate
        // cached/in-flight HTTP tokens and the authenticated Convex socket.
        invalidateConvexAuthForSignOut();
        // Supersede any server-auth wait that was started for the account
        // being signed out before it gets a chance to attach user watches.
        _convexWatchHandoffGeneration++;
        destroyEntitlementSubscription();
        destroySubscriptionWatch();
        cloudPrefsSignOut();
        resetEntitlementState();
        resetEntitlementVerification();
        this.tierPreferenceHandoff.clear();
        this.pendingPreferenceHandoffGeneration = undefined;
      }
      _prevUserId = userId;
      // Run after account handoff/reset so this pass cannot enforce the
      // previous user's entitlement against the new user's panels.
      firePremiumLoaders(accountTransition);
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
    showProBanner(this.state.container);
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
    // Capture any ?ref= / ?wm_referral= from the URL into localStorage
    // and strip from the visible URL. Runs BEFORE the pending-checkout
    // capture so a /dashboard?ref=X&checkoutProduct=Y landing preserves both
    // signals. Pure read of current URL — no-op when neither param is
    // present.
    captureReferralFromUrl();
    // Wire checkout-attempt lifecycle watchers (sign-out clear) before
    // any capture/resume path runs, so a stale session from a prior
    // user can't bleed into the current one.
    initCheckoutWatchers();
    // Stale attempt records are ignored by loadCheckoutAttempt() via
    // the 24h TTL — no separate sweep needed. The attempt record's
    // only consumer (the failure-retry banner) runs handleCheckoutReturn
    // synchronously during panel-layout mount, which is after the
    // captureePendingCheckoutIntentFromUrl repopulates it for any /pro
    // handoff — so no race exists that would want to sweep pre-capture.
    const pendingCheckout = capturePendingCheckoutIntentFromUrl();
    if (pendingCheckout) {
      // Checkout intent from /pro page redirect. Resume immediately if
      // already authenticated, otherwise the auth callback handles it.
      void resumePendingCheckout({
        openAuth: () => this.state.authModal?.open(),
      });
    }
    // Payment-email fallback (/dashboard?billing=portal): open the portal
    // now if signed in, else after the sign-in the auth listener observes.
    if (captureBillingPortalIntentFromUrl()) {
      void this.resumeBillingPortal(true);
    }

    // Phase 4: MapLayerHandlers. SearchManager is lazy-loaded
    // on first CMD+K/search-button open so its modal catalog stays off startup.
    this.eventHandlers.setupMapLayerHandlers();
    // Unblock any WebMCP tool invocations that arrived during startup.
    this.resolveUiReady();
    markLcpDebug('wm:boot:webmcp-ui-ready');

    // Phase 5: Event listeners + URL sync
    this.eventHandlers.init();
    // Capture deep link params BEFORE URL sync overwrites them
    const earlyParams = new URLSearchParams(window.location.search);
    if (earlyParams.get('settings') === 'notifications') {
      void this.state.unifiedSettings?.open('notifications');
    }
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

  private shouldDeferTierPreferenceReconciliation(): boolean {
    return this.tierPreferenceHandoff.shouldDefer(getAuthState().user?.id ?? null);
  }

  /** Reconcile all gate-owned preferences against one settled account view. */
  private reconcileTierOwnedPreferences(): boolean {
    if (this.shouldDeferTierPreferenceReconciliation()) return false;
    this.enforceFreeTierLimits();
    // Stored dashboard-tab snapshots have their own panel copies.
    this.panelLayout.healStoredTabSnapshots();
    this.healLockedMapLayers(this.freeTierGate.authSettleDeadlineExceeded);
    return true;
  }

  private persistJsonStorageValue<T>(key: string, value: T): boolean {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      if (isQuotaError(error)) markStorageQuotaExceeded();
      else console.warn(`Failed to save ${key} to storage:`, error);
      return false;
    }
  }

  /**
   * Grace-timer state for the free-tier gate. Lives in a collaborator so the
   * backstop can be driven by tests; App itself is not importable from the
   * node:test suites.
   */
  private readonly freeTierGate = new FreeTierGate(() => {
    if (this.shouldDeferTierPreferenceReconciliation()) return;
    this.enforceFreeTierLimits();
    this.panelLayout.healStoredTabSnapshots();
    // Clerk can remain pending forever when its script or key is unavailable.
    // The gate's deadline is the explicit free-tier answer in that case, so
    // heal stale locked map-layer state as well as panel/source state.
    this.healLockedMapLayers(true);
  });

  /**
   * Sanitize a map-layer snapshot only after the entitlement answer is safe to
   * treat as free. The fallback argument is deliberately explicit: pending
   * auth is not evidence that a paying user is free, but the bounded gate is.
   */
  private sanitizeMapLayersForTier(
    layers: MapLayers,
    fallbackActive = this.freeTierGate.authSettleDeadlineExceeded,
    options: { ephemeralSnapshot?: boolean } = {},
  ): MapLayers {
    // A `?layers=` deep link is a VIEW, not the user's saved preference:
    // parseMapUrlState rebuilds every LAYER_KEYS entry from the query string.
    // Treating it as durable state let a shared link overwrite the stored
    // (and cloud-synced) preference and seed gate ownership the user never
    // chose, so an ephemeral snapshot is sanitized for display only.
    const ephemeral = options.ephemeralSnapshot ?? false;
    const premium = hasPremiumAccess();
    // A Pro deep link is already entitled. Preserve the exact URL-derived
    // display snapshot and do not even read durable gate ownership: restoring
    // it here would enable layers the shared link deliberately omitted.
    if (premium && ephemeral) return layers;

    const existingOwnership = new Set(
      loadFromStorage<string[]>(STORAGE_KEYS.mapLayerGateOwnership, []),
    );

    if (premium) {
      if (existingOwnership.size === 0) return layers;
      const restored = sanitizeLayersForVariant(
        restoreGateOwnedLockedLayers(layers, existingOwnership),
        SITE_VARIANT as MapVariant,
      );
      // sanitizeLayersForVariant always returns a fresh object, so `restored
      // === layers` is never true — an identity check here silently persisted
      // on every pass. Compare by value.
      const unchanged = mapLayerStatesEqual(layers, restored);
      const persistence = persistGateOwnershipTransition(
        'pro',
        () => unchanged
          || this.persistJsonStorageValue(STORAGE_KEYS.mapLayers, restored),
        () => this.persistJsonStorageValue(STORAGE_KEYS.mapLayerGateOwnership, []),
      );
      return persistence.preferencePersisted ? restored : layers;
    }

    if (!shouldSanitizeLockedLayers(premium, isProTierResolved(), fallbackActive)) {
      return layers;
    }

    // Strip locked layers from the view without recording ownership: a shared
    // link naming a locked layer must not make that layer auto-enable if the
    // user later subscribes.
    if (ephemeral) return sanitizeLockedLayers(layers, false);

    const reconciled = sanitizeLockedLayersWithOwnership(layers, existingOwnership);
    const ownershipChanged = !stringSetsEqual(existingOwnership, reconciled.gateOwned);
    persistGateOwnershipTransition(
      'free',
      () => reconciled.layers === layers
        || this.persistJsonStorageValue(STORAGE_KEYS.mapLayers, reconciled.layers),
      () => !ownershipChanged
        || this.persistJsonStorageValue(
          STORAGE_KEYS.mapLayerGateOwnership,
          [...reconciled.gateOwned],
        ),
    );
    // Entitlement is a live safety boundary: blocked/quota-limited storage
    // must not leave a locked layer rendered. The ordered writes above retain
    // enough durable state to retry without ever persisting the destructive
    // preference before ownership.
    return reconciled.layers;
  }

  /** Heal the live map and persisted state after a downgrade or free fallback. */
  private healLockedMapLayers(
    fallbackActive = this.freeTierGate.authSettleDeadlineExceeded,
  ): void {
    const initialUrlLayers = this.state.initialUrlState?.layers;
    if (initialUrlLayers) {
      const healedUrlLayers = this.sanitizeMapLayersForTier(
        initialUrlLayers,
        fallbackActive,
        { ephemeralSnapshot: true },
      );
      if (healedUrlLayers !== initialUrlLayers && this.state.initialUrlState) {
        this.state.initialUrlState.layers = healedUrlLayers;
      }
    }
    // When the session booted from a `?layers=` link, state.mapLayers IS that
    // URL-derived view (seeded from the same local in the constructor), so this
    // heal must stay ephemeral too. The boot-time ephemeral pass usually
    // no-ops — shouldSanitizeLockedLayers is false while the tier is still
    // unresolved — which makes THIS the call that actually acts, and a
    // non-ephemeral run here would seed gate ownership from the link and write
    // it to the stored preference, undoing the deep-link fix entirely.
    const healed = this.sanitizeMapLayersForTier(
      this.state.mapLayers,
      fallbackActive,
      initialUrlLayers ? { ephemeralSnapshot: true } : {},
    );
    if (healed === this.state.mapLayers) return;
    this.state.mapLayers = healed;
    this.state.map?.setLayers(healed);
    this.dataLoader.syncDataFreshnessWithLayers();
  }

  /**
   * Put back everything the free-tier gate hid, now that we know the user is
   * Pro: the cw-* custom widgets AND the panels the count cap clamped off past
   * FREE_MAX_PANELS. Both now carry `proGated`, so the targeted restore covers
   * both; only the legacy sweep below stays widget-specific.
   *
   * Covers the free→pro upgrade, and heals users whose widgets were disabled
   * by a pre-fix build (see the one-time recovery below — those entries
   * pre-date the `proGated` marker, so they need the sweep).
   */
  private restoreProGatedPanelsForTier(cloudSyncVersion?: number): boolean {
    const panelSettings = loadFromStorage<Record<string, PanelConfig>>(STORAGE_KEYS.panels, {});
    let restored = restoreProGatedPanels(panelSettings);

    // ── One-time recovery for pre-`proGated` damage ───────────────────
    // Strictly once per browser. The sweep cannot tell legacy gate damage from
    // a widget the user hid on purpose (both are `enabled: false` with no
    // marker), so re-running it would silently un-hide deliberate hides. It was
    // previously re-armed on every cloud panels snapshot, which fires on
    // effectively every sign-in for a multi-device user — that re-arm is gone.
    //
    // Each device still heals itself on its first post-fix Pro reconcile, and
    // from then on `proGated` travels with the synced blob, so the targeted
    // restore above covers the cross-device case. A panel-bearing cloud
    // generation received before entitlement settles is retained in memory
    // until that Pro reconcile, so the one bounded second chance is not lost.
    //
    // The marker is burned on the first look, not the first repair: widget
    // specs are device-local (`wm-custom-widgets` is not a cloud-sync key), so
    // `loadWidgets()` is fully hydrated here and "found nothing" is a real
    // answer, not a not-yet-loaded one.
    try {
      let ownedWidgetIds: Set<string> | null = null;
      const sweepLegacy = (): void => {
        ownedWidgetIds ??= new Set(loadWidgets().map((w) => w.id));
        restored = sweepLegacyDisabledCustomWidgets(restored, ownedWidgetIds);
      };
      const recoveryMarker = localStorage.getItem(CW_PRO_GATE_RECOVERY_KEY);
      const baselineRaw = localStorage.getItem(CW_PRO_GATE_CLOUD_RECOVERY_BASELINE_KEY);
      const baselineParsed = baselineRaw === null ? Number.NaN : Number.parseInt(baselineRaw, 10);
      const baselineSyncVersion = Number.isFinite(baselineParsed) ? baselineParsed : null;
      const appliedRaw = localStorage.getItem(CW_PRO_GATE_CLOUD_RECOVERY_APPLIED_KEY);
      const appliedParsed = appliedRaw === null ? Number.NaN : Number.parseInt(appliedRaw, 10);
      const appliedSyncVersion = Number.isFinite(appliedParsed) ? appliedParsed : null;
      const effectiveCloudSyncVersion = cloudSyncVersion ?? this.pendingCloudRecoverySyncVersion;

      if (!recoveryMarker) {
        sweepLegacy();
        localStorage.setItem(CW_PRO_GATE_RECOVERY_KEY, 'done');
        // The current cloud snapshot was swept as part of the first recovery,
        // so mark it consumed when this call came from cloud reconciliation.
        const baseline = effectiveCloudSyncVersion ?? getSyncVersion();
        localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_BASELINE_KEY, String(baseline));
        if (effectiveCloudSyncVersion !== undefined) {
          localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_APPLIED_KEY, String(effectiveCloudSyncVersion));
        }
      } else if (baselineSyncVersion === null && effectiveCloudSyncVersion !== undefined) {
        // A browser may have burned the original marker before this bounded
        // cloud-generation guard shipped. Give its first observed cloud
        // snapshot one recovery pass, then never re-arm for later versions.
        sweepLegacy();
        localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_BASELINE_KEY, String(effectiveCloudSyncVersion));
        localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_APPLIED_KEY, String(effectiveCloudSyncVersion));
      } else if (baselineSyncVersion === null) {
        localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_BASELINE_KEY, String(getSyncVersion()));
      } else if (shouldRunCloudLegacyRecovery(baselineSyncVersion, appliedSyncVersion, effectiveCloudSyncVersion)) {
        // One bounded second chance covers a pre-fix snapshot arriving after
        // the local migration marker was already consumed. Deliberate hides
        // are protected from future cloud replays by the applied marker.
        sweepLegacy();
        localStorage.setItem(CW_PRO_GATE_CLOUD_RECOVERY_APPLIED_KEY, String(effectiveCloudSyncVersion));
      }
    } catch {
      // Persistence-only migration; blocked storage already uses defaults.
    }

    if (!panelGateStateChanged(panelSettings, restored)) return false;

    saveToStorage(STORAGE_KEYS.panels, restored);
    this.state.panelSettings = restored;
    this.panelLayout.applyPanelSettings();
    this.state.unifiedSettings?.refreshPanelToggles();
    console.log('[App] Pro: restored custom widget panels hidden by the free-tier gate');
    return true;
  }

  /** Reconcile or restore the persisted 80-source cap without losing user intent. */
  private reconcileSourceLimitForTier(pro: boolean): boolean {
    let ownershipMetadataExists = false;
    try {
      ownershipMetadataExists = localStorage.getItem(STORAGE_KEYS.sourceGateOwnership) !== null;
    } catch { /* optional persistence */ }
    const persistedDisabled = new Set(
      loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []),
    );
    const persistedGateOwned = new Set(
      loadFromStorage<string[]>(STORAGE_KEYS.sourceGateOwnership, []),
    );
    let gateOwned = new Set(persistedGateOwned);

    // Heal untouched profiles capped before ownership metadata existed. Exact
    // matching preserves every customized denylist.
    if (!ownershipMetadataExists) {
      const defaultUserDisabled = new Set(computeDefaultDisabledSources());
      const expectedGateOwned = selectSourcesUnderCap(
        FEEDS,
        [],
        defaultUserDisabled,
        FREE_MAX_SOURCES,
      ).autoDisabled;
      gateOwned = inferExactSourceGateOwnership(
        persistedDisabled,
        defaultUserDisabled,
        expectedGateOwned,
      ) ?? gateOwned;
    }

    let nextDisabled: Set<string>;
    let nextGateOwned: Set<string>;
    if (pro) {
      nextDisabled = restoreGateOwnedSources(persistedDisabled, gateOwned);
      nextGateOwned = new Set();
    } else {
      const userDisabled = restoreGateOwnedSources(persistedDisabled, gateOwned);
      const nextAutoDisabled = selectSourcesUnderCap(
        FEEDS,
        [],
        userDisabled,
        FREE_MAX_SOURCES,
      ).autoDisabled;
      const reconciled = reconcileSourceGateOwnership(
        userDisabled,
        nextAutoDisabled,
      );
      nextDisabled = reconciled.disabled;
      nextGateOwned = reconciled.gateOwned;
    }

    const disabledChanged = !stringSetsEqual(persistedDisabled, nextDisabled);
    const ownershipChanged = !ownershipMetadataExists
      || !stringSetsEqual(persistedGateOwned, nextGateOwned);
    const persistence = persistGateOwnershipTransition(
      pro ? 'pro' : 'free',
      () => !disabledChanged
        || this.persistJsonStorageValue(STORAGE_KEYS.disabledFeeds, [...nextDisabled]),
      () => !ownershipChanged
        || this.persistJsonStorageValue(
          STORAGE_KEYS.sourceGateOwnership,
          [...nextGateOwned],
        ),
    );
    const disabledPersisted = disabledChanged && persistence.preferencePersisted;
    const ownershipPersisted = ownershipChanged && persistence.ownershipPersisted;
    if (disabledChanged) {
      // The live entitlement boundary must not depend on localStorage health.
      // Durable writes remain ordered/retryable above, but free users stay
      // capped and Pro users unlock immediately even when quota is exhausted.
      this.state.disabledSources = new Set(nextDisabled);
    }
    if (disabledPersisted || ownershipPersisted) {
      console.log(pro
        ? `[App] Pro: restored ${gateOwned.size} source(s) disabled by the free-tier gate`
        : `[App] Free tier: reconciled ${nextGateOwned.size} gate-owned source disable(s)`);
    }
    return disabledPersisted || ownershipPersisted;
  }

  /**
   * Enforce free-tier panel and source limits.
   * Reads current values from storage, trims if necessary, and saves back.
   * Safe to call multiple times (idempotent) — e.g. on auth state changes.
   */
  private enforceFreeTierLimits(cloudSyncVersion?: number): boolean {
    // ── One-time v1 cap-bug recovery ──────────────────────────────────
    // Pre-2026-05-01 the source cap was enforced by Array.sort().slice(),
    // which silently auto-disabled every source past alphabetical position
    // FREE_MAX_SOURCES — catastrophically erasing late-alphabet categories
    // (Layoffs, Semiconductors, IPO, Funding, Product Hunt, …). Storage
    // didn't track auto-disabled vs user-disabled, so a heuristic that runs
    // on every load would silently undo a user who legitimately disabled
    // every source in a category — and re-undo it on every refresh forever.
    //
    // Migration approach: run findFullyDisabledCategories ONCE, gated by
    // disabledFeedsSchema version. After the migration completes, bump
    // schema → 1 so subsequent loads skip recovery entirely. Users who
    // explicitly toggle off every source in a category post-migration
    // keep that preference permanently. Trade-off: a user who BEFORE the
    // migration legitimately disabled every source in a category will lose
    // those preferences once. That's acceptable since v1 victims have been
    // suffering silent breakage and the explicit-full-category-disable
    // pattern is rare (users typically hide the whole panel instead).
    const schemaVersion = loadFromStorage<number>(STORAGE_KEYS.disabledFeedsSchema, 0);
    if (schemaVersion < 1) {
      const disabled = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));
      const recoverable = findFullyDisabledCategories(FEEDS, disabled);
      if (recoverable.length > 0) {
        for (const name of recoverable) disabled.delete(name);
        saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(disabled));
        console.log(`[App] One-time v1-cap-bug migration: re-enabled ${recoverable.length} source(s) from fully-disabled categories. This will not run again.`);
      }
      saveToStorage(STORAGE_KEYS.disabledFeedsSchema, 1);
    }

    if (isProUser()) {
      this.freeTierGate.cancelFallback();
      const panelsChanged = this.restoreProGatedPanelsForTier(cloudSyncVersion);
      this.reconcileSourceLimitForTier(true);
      return panelsChanged;
    }

    // Pro/free is NOT knowable yet on an auth-enabled page load. initAuthState()
    // deliberately does not await Clerk (2.98 MB, loaded on requestIdleCallback
    // with a 4 s timeout) and the Convex entitlement snapshot lands later
    // still, so getAuthState() is `{ user: null, isPending: true }` here — a
    // signed-in Pro user is indistinguishable from an anonymous one at this
    // point. Builds without Clerk settle anonymous synchronously instead.
    //
    // That matters because the clamp below is a PERSISTED write and
    // enforceFreePanelLimit disables every cw-* custom widget on the free
    // tier. Running it against an unresolved session wrote `enabled: false`
    // into STORAGE_KEYS.panels for Pro users' widgets on every single refresh:
    // the specs survived in wm-custom-widgets but the panels never mounted
    // again, so custom widgets appeared to vanish the moment the page
    // reloaded. (The widget e2e suite missed it because it seeds the legacy
    // wm-widget-key, which makes isProUser() true synchronously at boot.)
    //
    // Deferring is free: firePremiumLoaders() re-runs this on the Clerk auth
    // event and on every Convex entitlement snapshot. The fallback timer
    // covers the one case where neither ever arrives — a configured Clerk
    // script fails to load and isPending stays true, so the free-tier caps
    // would otherwise never be enforced.
    //
    // The same blindness recurs after Clerk settles: the auth callback runs
    // firePremiumLoaders() before initEntitlementSubscription() rebinds, so
    // for a signed-in user getEntitlementState() is still null and
    // isEntitled() is deterministically false at that instant — a Convex-only
    // Pro subscriber would be clamped as free on every load. Defer for that
    // window too; the entitlement snapshot re-runs this and the same fallback
    // timer bounds a snapshot that never arrives.
    const session = getAuthState();
    if (
      shouldDeferFreeTierEnforcement(
        session.isPending,
        session.user !== null,
        getEntitlementState() !== null,
        this.freeTierGate.authSettleDeadlineExceeded,
      )
    ) {
      this.freeTierGate.scheduleFallback();
      return false;
    }
    // Tier is known — drop the backstop instead of letting it fire a redundant
    // enforcement pass 8 s into every session.
    this.freeTierGate.cancelFallback();

    // --- Panel limit ---
    // Delegate to the shared enforceFreePanelLimit helper so this boot path and
    // the dashboard-tab add/switch/load paths stay in lockstep (same cw-* and
    // count rules). isPro is false here — the isProUser() early-return above
    // already short-circuited pro users.
    let panelSettings = loadFromStorage<Record<string, PanelConfig>>(STORAGE_KEYS.panels, {});
    let panelsChanged = false;
    try {
      if (!localStorage.getItem(FREE_MAP_PANEL_ACCESS_KEY)) {
        const restoredPanels = restoreFreeMapPanelAccess(panelSettings);
        if (panelSettings.map?.enabled !== restoredPanels.map?.enabled) {
          panelSettings = restoredPanels;
          panelsChanged = true;
        }
        localStorage.setItem(FREE_MAP_PANEL_ACCESS_KEY, 'done');
      }
    } catch {
      // Persistence-only migration; blocked storage already uses defaults.
    }
    const clampedPanels = enforceFreePanelLimit(panelSettings, false);
    for (const key of Object.keys(panelSettings)) {
      if (panelSettings[key]?.enabled !== clampedPanels[key]?.enabled) {
        panelsChanged = true;
        break;
      }
    }
    if (panelsChanged) {
      saveToStorage(STORAGE_KEYS.panels, clampedPanels);
      this.state.panelSettings = clampedPanels;
      // Auth and entitlement callbacks can reach this path after the layout
      // has mounted. Persisting the clamp is not enough in that case: remove
      // now-ineligible panels from the live dashboard immediately as well.
      this.panelLayout.applyPanelSettings();
      this.state.unifiedSettings?.refreshPanelToggles();
      console.log(`[App] Free tier: enforced ${FREE_MAX_PANELS}-panel limit (disabled over-cap / cw-* panels)`);
    }

    this.reconcileSourceLimitForTier(false);
    return panelsChanged;
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
    this.tierPreferenceHandoff.clear();
    this.pendingPreferenceHandoffGeneration = undefined;
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
    window.removeEventListener(WM_FOLLOWED_COUNTRIES_CAP_DROP, this.handleFollowedCountriesCapDrop);
    window.removeEventListener(CLOUD_PREFS_APPLIED_EVENT, this.handleCloudPrefsApplied);
    window.removeEventListener(
      CLOUD_PREFS_SIGN_IN_TERMINAL_EVENT,
      this.handleCloudPrefsSignInTerminal,
    );
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
      this.unsubFreeTier?.();
      this.unsubEntitlementPremiumLoaders?.();
      this.freeTierGate.cancelFallback();
      mlWorker.terminate();
      this.state.breakingBanner?.destroy();
      destroyBreakingNewsAlerts();
      this.cachedModeBannerEl?.remove();
      this.cachedModeBannerEl = null;
      window.removeEventListener(WM_SESSION_DEGRADED_EVENT, this.handleWmSessionDegraded);
      if (this.followedCountriesCapDropToastTimer !== null) {
        window.clearTimeout(this.followedCountriesCapDropToastTimer);
        this.followedCountriesCapDropToastTimer = null;
      }
      this.state.map?.destroy();
    }
  }

  private showFollowedCountriesCapDropToast(kept: number, dropped: number): void {
    if (this.followedCountriesCapDropToastTimer !== null) {
      window.clearTimeout(this.followedCountriesCapDropToastTimer);
      this.followedCountriesCapDropToastTimer = null;
    }
    document.querySelector('.wm-followed-cap-drop-toast')?.remove();

    const toast = document.createElement('div');
    toast.className = 'wm-followed-cap-drop-toast update-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');

    const body = document.createElement('div');
    body.className = 'update-toast-body';

    const title = document.createElement('div');
    title.className = 'update-toast-title';
    title.textContent = 'Follow limit reached';

    const detail = document.createElement('div');
    detail.className = 'update-toast-detail';
    const countryWord = dropped === 1 ? 'country was' : 'countries were';
    detail.textContent = `${kept} kept. ${dropped} ${countryWord} not added because the free plan supports ${FREE_TIER_FOLLOW_LIMIT} followed countries.`;

    body.append(title, detail);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'update-toast-action';
    action.dataset.action = 'upgrade';
    action.textContent = 'Upgrade';

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'update-toast-dismiss';
    dismiss.dataset.action = 'dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.textContent = '\u00d7';

    toast.append(body, action, dismiss);

    this.followedCountriesCapDropToastTimer = window.setTimeout(() => {
      toast.remove();
      this.followedCountriesCapDropToastTimer = null;
    }, 8000);
    toast.addEventListener('click', (e) => {
      const clickedAction = (e.target as HTMLElement)
        .closest<HTMLElement>('[data-action]')
        ?.dataset.action;
      if (clickedAction === 'upgrade') {
        // Absolute + routed: the relative form resolved against
        // tauri://localhost in the desktop WebView (#5911).
        void openExternalUrl(`${WEB_APP_ORIGIN}/pro#pricing`);
        if (this.followedCountriesCapDropToastTimer !== null) {
          window.clearTimeout(this.followedCountriesCapDropToastTimer);
          this.followedCountriesCapDropToastTimer = null;
        }
        toast.remove();
      } else if (clickedAction === 'dismiss') {
        if (this.followedCountriesCapDropToastTimer !== null) {
          window.clearTimeout(this.followedCountriesCapDropToastTimer);
          this.followedCountriesCapDropToastTimer = null;
        }
        toast.remove();
      }
    });

    document.body.appendChild(toast);
    window.requestAnimationFrame(() => toast.classList.add('visible'));
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
