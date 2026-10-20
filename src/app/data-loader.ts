import type { AppContext, AppModule } from '@/app/app-context';
import { enqueuePanelCall, invokePanelMethod } from '@/app/pending-panel-data';
import { markLcpDebug } from '@/utils/lcp-debug';
import { runHydrationTier, type HydrationTask } from '@/app/hydration-scheduler';
import { yieldToMain } from '@/utils/after-paint';
import type { ClusteredEvent, NewsItem, MapLayers } from '@/types';
import type { MarketData } from '@/types';
import type { TimeRange } from '@/components/MapContainer';
import {
  FEEDS,
  CANONICAL_FEEDS,
  COMMODITIES,
  MARKET_SYMBOLS,
  STOCK_CATALOG,
  SITE_VARIANT,
  LAYER_TO_SOURCE,
  STORAGE_KEYS,
} from '@/config';
import { resolveNewsCategories, enabledNewsCategoryKeys, type ResolvedCategory } from '@/config/feed-resolution';
import {
  countRepresentedSources,
  mergeRotatedNewsItems,
  nextRotationCycle,
  selectRotatingFeedWindow,
} from '@/app/news-feed-rotation';
import {
  runNewsLoadPass,
  newsWorkListSignature,
  type NewsCategoryLoadOptions,
} from '@/app/news-loader-sequencing';
import {
  countDigestCategories,
  DigestPersistenceQueue,
  digestCacheKey,
  getScopedDigest,
  retainRicherScopedDigest,
  type ScopedDigest,
} from '@/app/news-digest-acceptance';
import { INTEL_HOTSPOTS, CONFLICT_ZONES } from '@/config/geo';
import { tokenizeForMatch, matchKeyword } from '@/utils/keyword-match';
import { assessCorroboration, evidenceFromCluster } from '@/utils/corroboration-flag';
import {
  fetchEarthquakes,
  fetchWeatherAlerts,
  fetchInternetOutages,
  fetchTrafficAnomalies,
  fetchDdosAttacks,
  isOutagesConfigured,
  fetchCableHealth,
  updateBaseline,
  calculateDeviation,
  fetchNaturalEvents,
  fetchRadiationWatch,
} from '@/services';
import {
  getCatalogSelection,
  getMarketWatchlistEntries,
  resolveEffectiveMarketWatchlist,
} from '@/services/market-watchlist';
import { selectCompleteHydratedMarketQuotes } from '@/services/market-hydration';
import { resolveStockMarketAvailability } from '@/services/market-availability';
import { LatestRequestGuard } from '@/utils/latest-request-guard';
import { checkBatchForBreakingAlerts } from '@/services/breaking-news-alerts';
import { effectivePubDateMs } from '@/services/feed-date';
import { mlWorker } from '@/services/ml-worker';
import { clusterNewsHybrid, clusterNewsWithWorkerFallback } from '@/services/clustering';
import { fetchAllFires, flattenFires, computeRegionStats, toMapFires } from '@/services/wildfires';
import { dataFreshness, type DataSourceId } from '@/services/data-freshness';
import { fetchClimateAnomalies } from '@/services/climate';
import { debounce, loadFromStorage, saveToStorage } from '@/utils';
import { isFeatureEnabled } from '@/services/runtime-config';
import { hasPremiumAccess } from '@/services/panel-gating';
import { isDesktopRuntime, toApiUrl } from '@/services/runtime';
import { filterFeedsByLanguage } from '@/services/feed-language';
import { getAiFlowSettings } from '@/services/ai-flow-settings';
import { t, getCurrentLanguage } from '@/services/i18n';
import { getHydratedData } from '@/services/bootstrap';
import { ensurePipelineRegistriesHydrated } from '@/shared/pipeline-registry-store';
import { publicRpcFetch } from '@/services/public-rpc-fetch';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';
import type { ListMarketQuotesResponse, ListCommodityQuotesResponse } from '@/generated/client/worldmonitor/market/v1/service_client';
import type { CommoditiesPanel, MarketPanel } from '@/components/MarketPanel';
import type { ChinaCorporateDisclosureSnapshot } from '@/components/market-disclosures';
import type { SatelliteFiresPanel } from '@/components/SatelliteFiresPanel';
import { getPersistentCache, setPersistentCache } from '@/services/persistent-cache';
import type { NewsItem as ProtoNewsItem } from '@/generated/client/worldmonitor/news/v1/service_client';
import { fetchDiseaseOutbreaks } from '@/services/disease-outbreaks';
import { protoItemToNewsItem } from '@/services/news-digest-items';

type PhysicalPremiumFetcher = typeof import('@/services/market')['fetchPhysicalPremiums'];
type PhysicalDivergenceFetcher = typeof import('@/services/market')['fetchPhysicalDivergence'];

export async function loadPhysicalPremiumComparison(
  panel: Pick<CommoditiesPanel, 'updatePhysicalPremiums' | 'updatePhysicalDivergence' | 'showPhysicalDivergenceUnavailable'>,
  isCurrent: () => boolean,
  fetchPremiums: PhysicalPremiumFetcher,
  fetchDivergence: PhysicalDivergenceFetcher,
): Promise<void> {
  const [premiumsResult, divergenceResult] = await Promise.allSettled([
    fetchPremiums(),
    fetchDivergence(),
  ]);
  if (!isCurrent()) return;
  if (premiumsResult.status === 'fulfilled') panel.updatePhysicalPremiums(premiumsResult.value);
  if (divergenceResult.status === 'fulfilled') {
    panel.updatePhysicalDivergence(divergenceResult.value);
  } else {
    panel.showPhysicalDivergenceUnavailable();
  }
}

export async function loadPhysicalPremiumComparisonIfNeeded(
  panel: Pick<CommoditiesPanel,
    | 'shouldRefreshPhysicalComparison'
    | 'updatePhysicalPremiums'
    | 'updatePhysicalDivergence'
    | 'showPhysicalDivergenceUnavailable'>,
  isCurrent: () => boolean,
  fetchPremiums: PhysicalPremiumFetcher,
  fetchDivergence: PhysicalDivergenceFetcher,
): Promise<boolean> {
  if (!panel.shouldRefreshPhysicalComparison()) return false;
  await loadPhysicalPremiumComparison(panel, isCurrent, fetchPremiums, fetchDivergence);
  return true;
}


interface SelectedNewsDigest {
  digest: ListFeedDigestResponse;
  servedStale: boolean;
}

type HydrationTier = 1 | 2 | 3 | 4;
type RssModule = Pick<typeof import('@/services/rss'), 'fetchCategoryFeeds' | 'getFeedFailures'>;
type TrendingHeadlineInput = import('@/services/trending-keywords').TrendingHeadlineInput;

let rssModulePromise: Promise<RssModule> | null = null;
let ingestHeadlinesPromise: Promise<(headlines: TrendingHeadlineInput[]) => void> | null = null;

function getRssModule(): Promise<RssModule> {
  rssModulePromise ??= import('@/services/rss').catch((err) => {
    rssModulePromise = null;
    throw err;
  });
  return rssModulePromise;
}

async function ingestTrendingHeadlines(headlines: TrendingHeadlineInput[]): Promise<void> {
  ingestHeadlinesPromise ??= import('@/services/trending-keywords')
    .then(module => module.ingestHeadlines)
    .catch((err) => {
      ingestHeadlinesPromise = null;
      throw err;
    });
  const ingestHeadlines = await ingestHeadlinesPromise;
  ingestHeadlines(headlines);
}

const HYDRATION_TIER_ONE = new Set(['news', 'markets', 'intelligence']);
const HYDRATION_TIER_TWO = new Set([
  'natural',
  'firms',
  'weather',
  'webcams',
  'cableHealth',
  'diseaseOutbreaks',
  'radiation',
]);
const HYDRATION_TIERS: HydrationTier[] = [1, 2, 3, 4];

type NewsClusteringProfilePath = 'hybrid' | 'analysis-worker';

interface NewsClusteringProfileResult {
  generation: number;
  selectedPath: NewsClusteringProfilePath;
  mlAvailableAtSelection: boolean;
  itemCount: number;
  clusterCount: number;
}

interface NewsClusteringProfileHook {
  getState(): {
    mlAvailable: boolean;
    capabilities: typeof mlWorker.mlCapabilities;
    loadedModelIds: string[];
  };
  run(path: NewsClusteringProfilePath, items: ProtoNewsItem[]): Promise<NewsClusteringProfileResult>;
}

type NewsClusteringProfileWindow = Window & {
  __wmNewsClusteringProfile?: NewsClusteringProfileHook;
};

export class DataLoaderManager implements AppModule {
  private ctx: AppContext;

  private mapFlashCache: Map<string, number> = new Map();
  private readonly MAP_FLASH_COOLDOWN_MS = 10 * 60 * 1000;
  private readonly applyTimeRangeFilterToNewsPanelsDebounced = debounce(() => {
    this.applyTimeRangeFilterToNewsPanels();
  }, 120);

  public updateSearchIndex: () => void = () => {};

  private callPanel(key: string, method: string, ...args: unknown[]): void {
    // Panel update methods are async; invokePanelMethod keeps a rejection
    // observable instead of letting it escape to onunhandledrejection
    // (WORLDMONITOR-11N).
    if (invokePanelMethod(this.ctx.panels[key], key, method, args)) return;
    enqueuePanelCall(key, method, args);
  }

  private panelHasRetainedData(key: string): boolean {
    const panel = this.ctx.panels[key] as { hasData?: () => boolean } | undefined;
    return typeof panel?.hasData === 'function' && panel.hasData();
  }

  private showColdLoadError(key: string): void {
    if (this.panelHasRetainedData(key)) return;
    this.callPanel(key, 'showError');
  }

  private boundMarketWatchlistHandler: (() => void) | null = null;
  private readonly marketLoadGuard = new LatestRequestGuard();
  private readonly physicalComparisonLoadGuard = new LatestRequestGuard();
  private loadAllDataPromise: Promise<void> | null = null;
  private loadAllDataRerunRequested = false;
  private loadAllDataQueuedForceAll = false;

  private digestBreaker = { state: 'closed' as 'closed' | 'open' | 'half-open', failures: 0, cooldownUntil: 0 };
  private newsLoadGeneration = 0;
  private readonly digestRequestTimeoutMs = 8000;
  private readonly digestFirstPaintGraceMs = 1500;
  private readonly digestBreakerCooldownMs = 5 * 60 * 1000;
  private readonly persistedDigestMaxAgeMs = 6 * 60 * 60 * 1000;
  private readonly perFeedFallbackCategoryFeedLimit = 3;
  private readonly perFeedFallbackBatchSize = 2;
  /**
   * Ceiling on a custom category's ACCUMULATED item set (#5873).
   *
   * A custom category rotates through its sources `perFeedFallbackCategoryFeedLimit`
   * at a time and merges each cycle into what the panel already shows, so unlike
   * every other path its item set is not one snapshot. 40 is twice the server
   * digest's `MAX_ITEMS_PER_CATEGORY` (20) — enough headroom for a full rotation
   * lap of a ten-source category to stay represented at once, while keeping the
   * panel, `ctx.allNews` and the clustering input the same order of magnitude as
   * a digest-backed category.
   */
  private readonly customCategoryMergedItemLimit = 40;
  /**
   * Reachable source count for custom categories.
   *
   * Coverage is derived when the category is rendered, after the active time
   * range has filtered its items. Keeping only the denominator here prevents a
   * stale pre-filter count from surviving time-range changes.
   */
  private readonly customNewsSourceTotals = new Map<string, number>();
  private lastGoodDigest: ScopedDigest<ListFeedDigestResponse> | null = null;
  private readonly digestPersistenceQueue = new DigestPersistenceQueue<ListFeedDigestResponse>({
    cacheMaxAgeMs: this.persistedDigestMaxAgeMs,
    read: (key) => getPersistentCache<ListFeedDigestResponse>(key),
    write: (key, data) => setPersistentCache(key, data),
    onSkipPersist: (fetchedCategoryCount, cachedCategoryCount) => {
      console.warn(
        `[News] Digest covers ${fetchedCategoryCount} categories, fewer than the ` +
        `${cachedCategoryCount} already cached — keeping the cached last-good digest`,
      );
    },
  });
  /**
   * Work-list signature of the last news load that actually landed data, or
   * `null` if none has. Gates loadAllData()'s `news` task — see
   * `shouldHydrateNews`. Left unset when a load throws or comes back empty with
   * no usable digest, so a failed load stays retryable.
   */
  private loadedNewsSignature: string | null = null;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    if (import.meta.env.VITE_E2E === '1') {
      (window as NewsClusteringProfileWindow).__wmNewsClusteringProfile = {
        getState: () => ({
          mlAvailable: mlWorker.isAvailable,
          capabilities: mlWorker.mlCapabilities,
          loadedModelIds: mlWorker.loadedModelIds,
        }),
        run: (path, items) => this.runNewsClusteringProfile(path, items),
      };
    }
  }

  private getHydrationTier(name: string): HydrationTier {
    if (HYDRATION_TIER_ONE.has(name)) return 1;
    if (HYDRATION_TIER_TWO.has(name)) return 2;
    return 3;
  }

  private markHydration(label: string): void {
    if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
    performance.mark(label);
  }

  private async runHydrationTasks(tasks: HydrationTask[], forceAll: boolean): Promise<void> {
    const prioritized = tasks
      .map((task, order) => ({ ...task, order, tier: this.getHydrationTier(task.name) }))
      .sort((a, b) => a.tier - b.tier || a.order - b.order);

    // On the mobile profile, starting several panel loaders in the same task
    // lets their dynamic-import evaluation and synchronous render work merge
    // into one long task. Keep desktop concurrency, but give the browser a
    // scheduling boundary between every mobile panel in a tier. (#5165)
    const maxConcurrency = this.ctx.isMobile ? 1 : (forceAll ? 6 : 3);
    const failures: Array<{ name: string; reason: unknown }> = [];
    this.markHydration(`wm:hydration:${forceAll ? 'force' : 'viewport'}:start`);

    for (const tier of HYDRATION_TIERS) {
      const tierTasks = prioritized.filter(task => task.tier === tier);
      if (tierTasks.length === 0) continue;

      this.markHydration(`wm:hydration:tier-${tier}:start`);
      await runHydrationTier({
        tasks: tierTasks,
        maxConcurrency,
        yieldToMain,
        onFailure: (name, reason) => failures.push({ name, reason }),
      });
      this.markHydration(`wm:hydration:tier-${tier}:end`);
      if (tier < 4 && prioritized.some(task => task.tier > tier)) await yieldToMain();
    }

    this.markHydration(`wm:hydration:${forceAll ? 'force' : 'viewport'}:end`);
    failures.forEach(({ name, reason }) => {
      console.error(`[App] ${name} load failed:`, reason);
    });
  }

  init(): void {
    this.boundMarketWatchlistHandler = () => {
      void this.loadMarkets();
    };
    window.addEventListener('wm-market-watchlist-changed', this.boundMarketWatchlistHandler as EventListener);
  }

  destroy(): void {
    this.newsLoadGeneration += 1;
    if (import.meta.env.VITE_E2E === '1') {
      const profileWindow = window as NewsClusteringProfileWindow;
      delete profileWindow.__wmNewsClusteringProfile;
    }
    this.applyTimeRangeFilterToNewsPanelsDebounced.cancel();
    if (this.boundMarketWatchlistHandler) {
      window.removeEventListener('wm-market-watchlist-changed', this.boundMarketWatchlistHandler as EventListener);
      this.boundMarketWatchlistHandler = null;
    }
  }

  private async tryFetchDigest(): Promise<SelectedNewsDigest | null> {
    const now = Date.now();
    // Capture request and persistence scope together. Sampling the language again
    // after the response would let an old-language request populate the new
    // language's cache when the user switches languages in flight.
    const requestLanguage = getCurrentLanguage();
    const requestKey = this.digestCacheKey(requestLanguage);

    if (this.digestBreaker.state === 'open') {
      if (now < this.digestBreaker.cooldownUntil) {
        const fallback = this.getRetainedDigest(requestKey) ?? await this.loadPersistedDigest(requestKey);
        this.reportDigestCoverage(fallback, fallback ? 'stale' : 'unavailable');
        return fallback ? { digest: fallback, servedStale: true } : null;
      }
      this.digestBreaker.state = 'half-open';
    }

    try {
      markLcpDebug('wm:data:feed-digest-start');
      const resp = await publicRpcFetch(
        toApiUrl(`/api/news/v1/list-feed-digest?variant=${SITE_VARIANT}&lang=${requestLanguage}`),
        { signal: AbortSignal.timeout(this.digestRequestTimeoutMs) },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as ListFeedDigestResponse;
      const catCount = countDigestCategories(data);
      // A 200 carrying no categories is an outage wearing a success status: every
      // preset category renders empty behind it, because per-feed fallback is off
      // on web. Throwing routes it into the catch below, which is the whole point
      // — the breaker counts it, `lastGoodDigest` keeps the real digest it had, and
      // `digest:last-good` is left alone instead of being poisoned for 6 hours with
      // the empty body the fallback exists to survive (#5877).
      if (catCount === 0) throw new Error('digest returned 0 categories');
      markLcpDebug('wm:data:feed-digest-ready', { categories: catCount });
      console.info(`[News] Digest fetched: ${catCount} categories`);
      // #7084: do NOT reset the client's own six-hour clock with content the
      // server already told us is stale. persistDigest stamps a write clock and
      // loadPersistedDigest expires on that clock, so re-persisting a body that
      // is already up to six hours old would buy it another six — roughly
      // doubling the staleness ceiling the server contract promises. The body
      // is still fine to render now; it just must not become the client's fresh
      // last-good. The in-memory retained digest below is deliberately still
      // updated: it carries no clock, does not survive a reload, and so cannot
      // extend any window.
      if (data.coverage?.servedStale === true) {
        console.info(
          `[News] Digest served stale (${data.coverage.staleReason || 'unknown'}, ` +
            `${data.coverage.staleAgeSeconds ?? 0}s) — rendering without re-persisting`,
        );
      } else {
        this.persistDigest(requestKey, data);
      }
      this.digestBreaker = { state: 'closed', failures: 0, cooldownUntil: 0 };

      const currentKey = this.digestCacheKey();
      if (currentKey !== requestKey) {
        // The response is valid for the scope it requested and may refresh that
        // scope's persistent cache, but it must not become live data or an
        // in-memory fallback for the language now active.
        const fallback = this.getRetainedDigest(currentKey) ?? await this.loadPersistedDigest(currentKey);
        this.reportDigestCoverage(fallback, fallback ? 'stale' : 'unavailable');
        return fallback ? { digest: fallback, servedStale: true } : null;
      }
      this.lastGoodDigest = retainRicherScopedDigest(this.lastGoodDigest, requestKey, data);
      this.reportDigestCoverage(data);
      return { digest: data, servedStale: data.coverage?.servedStale === true };
    } catch (e) {
      markLcpDebug('wm:data:feed-digest-error');
      console.warn('[News] Digest fetch failed, using fallback:', e);
      this.digestBreaker.failures++;
      if (this.digestBreaker.failures >= 2) {
        this.digestBreaker.state = 'open';
        this.digestBreaker.cooldownUntil = now + this.digestBreakerCooldownMs;
      }
      const currentKey = this.digestCacheKey();
      const fallback = this.getRetainedDigest(currentKey) ?? await this.loadPersistedDigest(currentKey);
      this.reportDigestCoverage(fallback, fallback ? 'stale' : 'unavailable');
      return fallback ? { digest: fallback, servedStale: true } : null;
    }
  }

  /**
   * Write the fresh digest to `digest:last-good`, unless that would shrink it.
   *
   * A PARTIAL digest is the second degraded shape (#5877): a 200 that covers
   * some categories but fewer than the entry already cached. The response is
   * real data, so the caller uses it for this load — but overwriting a richer
   * `digest:last-good` with it is a strict loss for the NEXT page load, which is
   * the one that falls back to this entry when the digest is unreachable.
   *
   * Deliberately fire-and-forget and off the fetch path: the comparison needs a
   * persistent-cache READ, and `tryFetchDigest` sits on the news first-paint
   * path, so awaiting an IndexedDB round trip there would buy correctness for
   * the fallback at the cost of the load it is protecting. A read failure is
   * treated as "nothing cached" and the write proceeds — the previous behaviour.
   */
  private persistDigest(key: string, data: ListFeedDigestResponse): void {
    this.digestPersistenceQueue.enqueue(key, data);
  }

  /**
   * Cache key for the last-good digest, scoped exactly like the request that
   * produced it.
   *
   * The digest is fetched per `variant` and `lang`, but the entry used to be
   * stored under one global key — so a variant or language switch compared, and
   * fell back to, a digest built for a different category set entirely. That was
   * survivable while every successful fetch overwrote the entry unconditionally;
   * it is not survivable now that coverage decides whether to overwrite, because
   * a wider digest from the OTHER variant would veto persisting the current
   * one's for up to 6 hours (#5877).
   *
   * Scoping also retires every entry written under the old key, which is the
   * migration path for a cache already poisoned by a degraded digest: those
   * entries simply become unreachable rather than needing to be detected.
   */
  private digestCacheKey(language = getCurrentLanguage()): string {
    return digestCacheKey(SITE_VARIANT, language);
  }

  private getRetainedDigest(key = this.digestCacheKey()): ListFeedDigestResponse | null {
    return getScopedDigest(this.lastGoodDigest, key);
  }

  /**
   * #7085: surface the digest's coverage block on the status panel. Runtime
   * guards throughout — persisted last-good digests from before the coverage
   * rollout carry no coverage field at all.
   */
  private reportDigestCoverage(
    digest: ListFeedDigestResponse | null,
    stateOverride?: 'stale' | 'unavailable',
  ): void {
    const cov = digest?.coverage;
    if (!cov || typeof cov.state !== 'string') {
      const categoryEntries = digest ? Object.entries(digest.categories) : [];
      const items = categoryEntries.flatMap(([, bucket]) => bucket.items);
      this.ctx.statusPanel?.updateDigestCoverage({
        state: stateOverride ?? 'unknown',
        itemsServed: items.length,
        publisherCount: new Set(items.map(item => item.source).filter(Boolean)).size,
        feedsCompleted: 0,
        feedsTotal: 0,
        categoriesCompleted: categoryEntries.filter(([, bucket]) => bucket.items.length > 0).length,
        categoriesTotal: categoryEntries.length,
        missingCategories: categoryEntries
          .filter(([, bucket]) => bucket.items.length === 0)
          .map(([category]) => category),
      });
      return;
    }
    const state = stateOverride ?? (cov.state === 'complete' || cov.state === 'partial' || cov.state === 'stale' || cov.state === 'unavailable'
      ? cov.state
      : 'unknown');
    this.ctx.statusPanel?.updateDigestCoverage({
      state,
      itemsServed: Number(cov.itemsServed) || 0,
      publisherCount: Number(cov.publisherCount) || 0,
      feedsCompleted: Number(cov.feedCompleted) || 0,
      feedsTotal: Number(cov.feedTotal) || 0,
      categoriesCompleted: Number(cov.categoryCompleted) || 0,
      categoriesTotal: Number(cov.categoryTotal) || 0,
      missingCategories: Object.entries(cov.categoryStates ?? {})
        .filter(([, v]) => v === 'missing')
        .map(([k]) => k),
    });
  }

  private async loadPersistedDigest(key = this.digestCacheKey()): Promise<ListFeedDigestResponse | null> {
    try {
      const envelope = await getPersistentCache<ListFeedDigestResponse>(key);
      if (!envelope) return null;
      if (Date.now() - envelope.updatedAt > this.persistedDigestMaxAgeMs) return null;
      // Do not let an IndexedDB read started for a previous language complete
      // into the new language's in-memory fallback.
      if (key !== this.digestCacheKey()) return null;
      this.lastGoodDigest = retainRicherScopedDigest(this.lastGoodDigest, key, envelope.data);
      return envelope.data;
    } catch { return null; }
  }

  private isPerFeedFallbackEnabled(): boolean {
    // Desktop: server digest has fewer categories than client FEEDS config.
    // Enable per-feed RSS fallback so missing categories fetch directly.
    if (isDesktopRuntime()) return true;
    return isFeatureEnabled('newsPerFeedFallback');
  }

  private getStaleNewsItems(category: string): NewsItem[] {
    const staleItems = this.ctx.newsByCategory[category];
    if (!Array.isArray(staleItems) || staleItems.length === 0) return [];
    return [...staleItems].sort((a, b) => effectivePubDateMs(b) - effectivePubDateMs(a));
  }

  private selectLimitedFeeds<T>(feeds: T[], maxFeeds: number): T[] {
    if (feeds.length <= maxFeeds) return feeds;
    return feeds.slice(0, maxFeeds);
  }

  /**
   * Rotation cycle of a custom category's capped per-feed window, persisted so
   * it survives a reload (#5873).
   *
   * In-memory-only state would restart every custom category at window 0 on
   * every page load, which for the common short session is indistinguishable
   * from the fixed prefix this replaced: sources 4..N would still never be
   * fetched. Reads are defensive — a hand-edited or older-schema value must not
   * reach `selectRotatingFeedWindow` as a NaN start.
   */
  private readNewsRotationCycles(): Record<string, number> {
    const stored = loadFromStorage<Record<string, number>>(STORAGE_KEYS.newsFeedRotation, {});
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  }

  private newsRotationCycle(category: string): number {
    const cycle = this.readNewsRotationCycles()[category];
    return typeof cycle === 'number' && Number.isFinite(cycle) && cycle >= 0 ? Math.trunc(cycle) : 0;
  }

  /**
   * Advance and persist a custom category's rotation cycle.
   *
   * Written AFTER the window for this cycle has been selected, and pruned to
   * the custom categories still in the work-list so a panel the user has since
   * removed can't leave its entry behind forever.
   */
  private advanceNewsRotationCycle(category: string, feedCount: number): void {
    const keep = new Set(
      this.resolveEnabledNewsCategories()
        .filter(({ isCustom }) => isCustom)
        .map(({ key }) => key),
    );
    keep.add(category);

    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(this.readNewsRotationCycles())) {
      if (keep.has(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        next[key] = Math.trunc(value);
      }
    }
    next[category] = nextRotationCycle(this.newsRotationCycle(category), feedCount);
    saveToStorage(STORAGE_KEYS.newsFeedRotation, next);
  }

  private isPanelNearViewport(panelId: string, marginPx = 400): boolean {
    const panel = this.ctx.panels[panelId] as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
    return panel?.isNearViewport?.(marginPx) ?? false;
  }

  private isAnyPanelNearViewport(panelIds: string[], marginPx = 400): boolean {
    return panelIds.some((panelId) => this.isPanelNearViewport(panelId, marginPx));
  }

  async loadAllData(forceAll = false): Promise<void> {
    if (this.loadAllDataPromise) {
      this.loadAllDataRerunRequested = true;
      this.loadAllDataQueuedForceAll = this.loadAllDataQueuedForceAll || forceAll;
      return this.loadAllDataPromise;
    }

    this.loadAllDataRerunRequested = true;
    this.loadAllDataQueuedForceAll = forceAll;
    this.loadAllDataPromise = this.drainLoadAllDataQueue();
    return this.loadAllDataPromise;
  }

  private async drainLoadAllDataQueue(): Promise<void> {
    try {
      while (this.loadAllDataRerunRequested && !this.ctx.isDestroyed) {
        const forceAll = this.loadAllDataQueuedForceAll;
        this.loadAllDataRerunRequested = false;
        this.loadAllDataQueuedForceAll = false;
        // Opt-in only (no-op unless __wmLcpDebug is installed), so this costs
        // one property read on the ordinary path. The start/end pair is the
        // only direct witness that a fan-out actually ran and drained: request
        // counters cannot distinguish a repeat pass from a service retry
        // (#7045 U5 review, #7212).
        markLcpDebug('wm:data:load-all-start', { forceAll });
        try {
          await this.runLoadAllData(forceAll);
        } finally {
          markLcpDebug('wm:data:load-all-end', { forceAll });
        }
      }
    } finally {
      this.loadAllDataPromise = null;
      this.loadAllDataRerunRequested = false;
      this.loadAllDataQueuedForceAll = false;
    }
  }

  private async runLoadAllData(forceAll: boolean): Promise<void> {
    const runGuarded = async (name: string, fn: () => Promise<void>): Promise<void> => {
      if (this.ctx.isDestroyed || this.ctx.inFlight.has(name)) return;
      this.ctx.inFlight.add(name);
      try {
        await fn();
      } catch (e) {
        if (!this.ctx.isDestroyed) console.error(`[App] ${name} failed:`, e);
      } finally {
        this.ctx.inFlight.delete(name);
      }
    };

    const shouldLoad = (id: string): boolean => forceAll || this.isPanelNearViewport(id);
    const shouldLoadAny = (ids: string[]): boolean => forceAll || this.isAnyPanelNearViewport(ids);

    const tasks: HydrationTask[] = [];
    if (this.shouldHydrateNews(forceAll)) {
      tasks.push({ name: 'news', task: () => runGuarded('news', () => this.loadNews()) });
    }

    if (shouldLoadAny(['markets', 'commodities'])) {
      tasks.push({ name: 'markets', task: () => runGuarded('markets', () => this.loadMarkets()) });
    }

    // Intelligence signals: run for any variant that shows these panels
    if (shouldLoadAny(['climate', 'population-exposure', 'radiation-watch', 'satellite-fires'])) {
      tasks.push({ name: 'intelligence', task: () => runGuarded('intelligence', () => this.loadIntelligenceSignals()) });
    }

    if (shouldLoad('satellite-fires') || this.ctx.mapLayers.fires) {
      // Lock under the map-layer key ('fires') so a hydration load and a
      // loadDataForLayer('fires') toggle one-flight each other instead of
      // double-fetching (loadFirmsData has no internal guard). `name` stays
      // 'firms' for hydration tiering (#6770).
      tasks.push({ name: 'firms', task: () => runGuarded('fires', () => this.loadFirmsData()) });
    }
    if (this.ctx.mapLayers.natural) tasks.push({ name: 'natural', task: () => runGuarded('natural', () => this.loadNatural()) });
    if (this.ctx.mapLayers.diseaseOutbreaks || shouldLoad('disease-outbreaks')) tasks.push({ name: 'diseaseOutbreaks', task: () => runGuarded('diseaseOutbreaks', () => this.loadDiseaseOutbreaks()) });
    if (this.ctx.mapLayers.weather) tasks.push({ name: 'weather', task: () => runGuarded('weather', () => this.loadWeatherAlerts()) });
    if (this.ctx.mapLayers.pipelines) tasks.push({ name: 'pipelineRegistries', task: () => runGuarded('pipelineRegistries', () => this.loadPipelineRegistries()) });
    if (this.ctx.mapLayers.cables) tasks.push({ name: 'cableHealth', task: () => runGuarded('cableHealth', () => this.loadCableHealth()) });
    if (this.ctx.mapLayers.webcams) tasks.push({ name: 'webcams', task: () => runGuarded('webcams', () => this.loadWebcams()) });
    if ((shouldLoad('radiation-watch') || this.ctx.mapLayers.radiationWatch)) {
      // Lock under the map-layer key ('radiationWatch') so a hydration load and
      // a loadDataForLayer('radiationWatch') toggle one-flight each other
      // (loadRadiationWatch has no internal guard). `name` stays 'radiation' for
      // hydration tiering (#6770).
      tasks.push({ name: 'radiation', task: () => runGuarded('radiationWatch', () => this.loadRadiationWatch()) });
    }

    await this.runHydrationTasks(tasks, forceAll);

    this.updateSearchIndex();
  }

  async loadDataForLayer(layer: keyof MapLayers): Promise<void> {
    if (this.ctx.isDestroyed || this.ctx.inFlight.has(layer)) return;
    this.ctx.inFlight.add(layer);
    this.ctx.map?.setLayerLoading(layer, true);
    try {
      switch (layer) {
        case 'natural':
          await this.loadNatural();
          break;
        case 'fires':
          await this.loadFirmsData();
          break;
        case 'weather':
          await this.loadWeatherAlerts();
          break;
        case 'pipelines':
          await this.loadPipelineRegistries();
          break;
        case 'outages':
          await this.loadOutages();
          break;
        case 'cables':
          await this.loadCableHealth();
          break;
        case 'webcams':
          await this.loadWebcams();
          break;
        case 'radiationWatch':
          await this.loadRadiationWatch();
          break;
        case 'climate':
          await this.loadIntelligenceSignals();
          break;
        case 'diseaseOutbreaks':
          await this.loadDiseaseOutbreaks();
          break;
      }
    } finally {
      this.ctx.inFlight.delete(layer);
      this.ctx.map?.setLayerLoading(layer, false);
    }
  }

  private findFlashLocation(title: string): { lat: number; lon: number } | null {
    const tokens = tokenizeForMatch(title);
    let bestMatch: { lat: number; lon: number; matches: number } | null = null;

    const countKeywordMatches = (keywords: string[] | undefined): number => {
      if (!keywords) return 0;
      let matches = 0;
      for (const keyword of keywords) {
        const cleaned = keyword.trim().toLowerCase();
        if (cleaned.length >= 3 && matchKeyword(tokens, cleaned)) {
          matches++;
        }
      }
      return matches;
    };

    for (const hotspot of INTEL_HOTSPOTS) {
      const matches = countKeywordMatches(hotspot.keywords);
      if (matches > 0 && (!bestMatch || matches > bestMatch.matches)) {
        bestMatch = { lat: hotspot.lat, lon: hotspot.lon, matches };
      }
    }

    for (const conflict of CONFLICT_ZONES) {
      const matches = countKeywordMatches(conflict.keywords);
      if (matches > 0 && (!bestMatch || matches > bestMatch.matches)) {
        bestMatch = { lat: conflict.center[1], lon: conflict.center[0], matches };
      }
    }

    return bestMatch;
  }

  private flashMapForNews(items: NewsItem[]): void {
    if (!this.ctx.map || !this.ctx.initialLoadComplete) return;
    if (!getAiFlowSettings().mapNewsFlash) return;
    const now = Date.now();

    for (const [key, timestamp] of this.mapFlashCache.entries()) {
      if (now - timestamp > this.MAP_FLASH_COOLDOWN_MS) {
        this.mapFlashCache.delete(key);
      }
    }

    for (const item of items) {
      const cacheKey = `${item.source}|${item.link || item.title}`;
      const lastSeen = this.mapFlashCache.get(cacheKey);
      if (lastSeen && now - lastSeen < this.MAP_FLASH_COOLDOWN_MS) {
        continue;
      }

      const location = this.findFlashLocation(item.title);
      if (!location) continue;

      this.ctx.map.flashLocation(location.lat, location.lon);
      this.mapFlashCache.set(cacheKey, now);
    }
  }

  getTimeRangeWindowMs(range: TimeRange): number {
    const ranges: Record<TimeRange, number> = {
      '1h': 60 * 60 * 1000,
      '6h': 6 * 60 * 60 * 1000,
      '24h': 24 * 60 * 60 * 1000,
      '48h': 48 * 60 * 60 * 1000,
      '7d': 7 * 24 * 60 * 60 * 1000,
      'all': Infinity,
    };
    return ranges[range];
  }

  filterItemsByTimeRange(items: NewsItem[], range: TimeRange = this.ctx.currentTimeRange): NewsItem[] {
    if (range === 'all') return items;
    const cutoff = Date.now() - this.getTimeRangeWindowMs(range);
    return items.filter((item) => {
      // effectivePubDateMs returns 0 for items that cannot claim a real
      // freshness rank: pubDateMissing items (the U3 contract) AND items
      // whose pubDate is NaN/Infinity/Invalid Date (the helper's value-
      // sanitization branch). All such items are EXCLUDED from positive-
      // window ranges. Previous behavior wrapped raw pubDate.getTime() in
      // Number.isFinite() and fell through to `true` on non-finite — that
      // included corrupt-stamp items in time-range views, arguably a bug.
      // The current shape treats untrustworthy timestamps uniformly: they
      // never claim freshness and never appear in a "last 24h" view.
      return effectivePubDateMs(item) >= cutoff;
    });
  }

  getTimeRangeLabel(range: TimeRange = this.ctx.currentTimeRange): string {
    const labels: Record<TimeRange, string> = {
      '1h': 'the last hour',
      '6h': 'the last 6 hours',
      '24h': 'the last 24 hours',
      '48h': 'the last 48 hours',
      '7d': 'the last 7 days',
      'all': 'all time',
    };
    return labels[range];
  }

  private newsPanelKey(category: string): string {
    return this.ctx.newsCategoryPanelKeys.get(category) ?? category;
  }

  private clearNewsSourceCoverage(category: string): void {
    this.customNewsSourceTotals.delete(category);
    this.callPanel(this.newsPanelKey(category), 'setSourceCoverage', null);
  }

  private setNewsRefreshDegraded(category: string, degraded: boolean): void {
    this.callPanel(this.newsPanelKey(category), 'setRefreshDegraded', degraded);
  }

  renderNewsForCategory(category: string, items: NewsItem[]): void {
    this.ctx.newsByCategory[category] = items;
    const filteredItems = this.filterItemsByTimeRange(items);
    const sourceTotal = this.customNewsSourceTotals.get(category);
    if (sourceTotal !== undefined) {
      this.callPanel(this.newsPanelKey(category), 'setSourceCoverage', {
        covered: countRepresentedSources(filteredItems),
        total: sourceTotal,
      });
    }

    const panel = this.ctx.newsPanels[category];
    if (!panel) return;
    if (filteredItems.length === 0 && items.length > 0) {
      panel.renderFilteredEmpty(`No items in ${this.getTimeRangeLabel()}`);
      return;
    }
    panel.renderNews(filteredItems);
  }

  applyTimeRangeFilterToNewsPanels(): void {
    Object.entries(this.ctx.newsByCategory).forEach(([category, items]) => {
      this.renderNewsForCategory(category, items);
    });
  }

  applyTimeRangeFilterDebounced(): void {
    this.applyTimeRangeFilterToNewsPanelsDebounced();
  }

  // `isCustom` marks a category from a user-added panel that isn't in the
  // active variant's preset. The per-variant server digest never carries it, so
  // it skips the digest-availability gate and fetches directly client-side —
  // still capped by perFeedFallbackCategoryFeedLimit like any other per-feed
  // fallback, because nothing bounds how many custom categories a session has
  // (#5376). The cost is borne only by users who customize.
  //
  // That cap is a degraded-mode ceiling for a preset category but the STEADY
  // STATE for a custom one, so the two diverge in how they spend it (#5873):
  // a custom category rotates its window across cycles and merges each cycle
  // into what the panel already shows, and reports the resulting source
  // coverage on the panel badge. A preset category keeps the fixed prefix and
  // whole-set replace — it is digest-backed in the normal case, and its
  // fallback lasts only as long as the outage.
  private async loadNewsCategory(
    category: string,
    feeds: typeof FEEDS.politics,
    digestSelection: SelectedNewsDigest | null,
    isCustom = false,
    options: NewsCategoryLoadOptions = { allowDigestPendingFallback: false, recordBaselineSample: true },
    generation = this.newsLoadGeneration,
  ): Promise<NewsItem[]> {
    try {
      const digest = digestSelection?.digest;
      const digestServedStale = digestSelection?.servedStale ?? true;
      const panel = this.ctx.newsPanels[category];

      const enabledFeeds = (feeds ?? []).filter(f => !this.ctx.disabledSources.has(f.name));
      if (enabledFeeds.length === 0) {
        delete this.ctx.newsByCategory[category];
        this.clearNewsSourceCoverage(category);
        if (panel) {
          panel.showError(t('common.allSourcesDisabled'));
        }
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: 0,
        });
        return [];
      }
      const enabledNames = new Set(enabledFeeds.map(f => f.name));

      // The feeds a direct fetch would actually attempt. `fetchCategoryFeeds`
      // drops feeds whose declared `lang` isn't the current UI language, so for
      // a rotating custom category the enabled set is the wrong denominator on
      // both counts: `europe` declares 47 feeds but only 6 are fetchable for an
      // English user, so rotating over all 47 would spend ~7 of every 8
      // twenty-minute cycles fetching nothing, and the coverage badge would sit
      // at "6/47 sources" permanently — a fresh version of the same lie #5873 is
      // about. Preset categories keep the full enabled set: they are
      // digest-backed, and `enabledNames` (which filters digest items by source)
      // must stay language-blind because the server does not language-filter.
      const reachableFeeds = isCustom ? filterFeedsByLanguage(enabledFeeds, getCurrentLanguage()) : enabledFeeds;
      if (isCustom) {
        this.customNewsSourceTotals.set(category, reachableFeeds.length);
      }

      // Digest branch: server already aggregated feeds — map proto items to client types
      if (digest?.categories && category in digest.categories) {
        // The digest carries every enabled source for the category, so there is
        // no partial coverage to disclose — clear any badge a prior custom-path
        // load left behind.
        this.clearNewsSourceCoverage(category);
        this.setNewsRefreshDegraded(category, false);
        const items = (digest.categories[category]?.items ?? [])
          .map(protoItemToNewsItem)
          .filter(i => enabledNames.has(i.source));

        void ingestTrendingHeadlines(items.map(i => ({
          title: i.title,
          pubDate: i.pubDate,
          pubDateMissing: i.pubDateMissing,
          source: i.source,
          link: i.link,
        })))
          .catch((err) => {
            console.warn('[News] ingestTrendingHeadlines failed (chunk load?):', err);
          });

        // Skip client-side AI reclassification for digest items.
        // The server already ran enrichWithAiCache() which checks the same Redis keys
        // that classifyEvent writes to. Re-firing classifyEvent from every client wastes
        // edge requests even when they're Redis cache hits.

        // #7084: a stale digest replay re-delivers items that already had
        // their alert opportunity when they were served fresh. The 15-minute
        // recency gate inside the checker bounds the exposure, but a replay
        // younger than that would re-fire banners for old events — gate on
        // the exact selected body's effective freshness, including browser
        // retained/persisted fallbacks whose stored coverage may say fresh.
        if (this.isCurrentNewsLoad(generation) && !digestServedStale) {
          checkBatchForBreakingAlerts(items);
        }
        this.flashMapForNews(items);
        this.renderNewsForCategory(category, items);

        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: items.length,
        });

        if (panel && options.recordBaselineSample) {
          try {
            const baseline = await updateBaseline(`news:${category}`, items.length);
            const deviation = calculateDeviation(items.length, baseline);
            panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
          } catch (e) { console.warn(`[Baseline] news:${category} write failed:`, e); }
        }

        return items;
      }

      // Preset categories: serve last-known-good while the digest is briefly
      // unavailable. Custom categories are NEVER in the digest, so this branch
      // would fire on every refresh after the first load — getStaleNewsItems
      // reads ctx.newsByCategory, which the prior cycle's direct fetch already
      // populated — and freeze the panel on stale headlines. Skip it for them
      // and fall through to the direct fetch; the panel keeps showing its
      // current batch until fresh data lands (no blank flash).
      const staleItems = this.getStaleNewsItems(category).filter(i => enabledNames.has(i.source));

      // For a custom category that same set is not "stale headlines to freeze
      // on" but the CARRY-OVER this cycle accumulates onto: the rotation window
      // only ever fetches perFeedFallbackCategoryFeedLimit sources, so the
      // sources it did NOT fetch this time live here (#5873). Snapshotted here,
      // before any render — renderNewsForCategory overwrites
      // ctx.newsByCategory, which is what getStaleNewsItems reads, so reading
      // it later would fold each partial render back into itself.
      const carryOver = isCustom ? staleItems : [];

      /**
       * What to actually paint for a given set of freshly fetched items.
       *
       * Identity for a preset category — its fallback replaces wholesale, as
       * before. For a custom one it merges onto the carry-over. Source coverage
       * is published by renderNewsForCategory after time-range filtering, so
       * the badge describes what is actually visible.
       */
      const mergeForRender = (freshItems: NewsItem[]): NewsItem[] => {
        if (!isCustom) return freshItems;
        return mergeRotatedNewsItems(carryOver, freshItems, {
          maxItems: this.customCategoryMergedItemLimit,
          enabledSources: enabledNames,
        });
      };

      // Per-feed fallback: fetch each feed individually (first load or digest unavailable)
      const renderIntervalMs = 100;
      let lastRenderTime = 0;
      let renderTimeout: ReturnType<typeof setTimeout> | null = null;
      let pendingItems: NewsItem[] | null = null;

      const flushPendingRender = () => {
        if (!pendingItems) return;
        this.renderNewsForCategory(category, pendingItems);
        pendingItems = null;
        lastRenderTime = Date.now();
      };

      const scheduleRender = (partialItems: NewsItem[]) => {
        if (!panel) return;
        // Merge BEFORE queueing, not at flush time: rendering the raw partial
        // would blank the carried-over sources for one frame and then bring
        // them back, which is the churn the merge exists to avoid.
        pendingItems = mergeForRender(partialItems);
        const elapsed = Date.now() - lastRenderTime;
        if (elapsed >= renderIntervalMs) {
          if (renderTimeout) {
            clearTimeout(renderTimeout);
            renderTimeout = null;
          }
          flushPendingRender();
          return;
        }

        if (!renderTimeout) {
          renderTimeout = setTimeout(() => {
            renderTimeout = null;
            flushPendingRender();
          }, renderIntervalMs - elapsed);
        }
      };

      if (!isCustom && staleItems.length > 0) {
        console.warn(`[News] Digest missing for "${category}", serving stale headlines (${staleItems.length})`);
        this.renderNewsForCategory(category, staleItems);
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'ok',
          itemCount: staleItems.length,
        });
        return staleItems;
      }

      // The per-feed-fallback flag is the kill switch for the digest-down
      // thundering herd (every preset category fetching at once), so it does NOT
      // apply to custom categories: those are NEVER in the digest by design and
      // direct fetch is their only path — gating them here would leave a
      // customized panel permanently empty rather than degraded. Their blast
      // radius is bounded by the feed cap below instead.
      if (!isCustom && !this.isPerFeedFallbackEnabled() && !options.allowDigestPendingFallback) {
        console.warn(`[News] Digest missing for "${category}", limited per-feed fallback disabled`);
        this.renderNewsForCategory(category, []);
        this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
          status: 'error',
          errorMessage: 'Digest unavailable',
        });
        return [];
      }

      // Every per-feed fallback is capped, custom categories included. They used
      // to fetch their full feed set on the theory that a handful of customized
      // panels carried "no thundering-herd risk" — three of them firing on every
      // load, uncapped, was 19 direct proxy round-trips (#5376). Nothing bounds
      // how many custom categories a session can have, so the cap has to be
      // unconditional.
      //
      // WHICH feeds the cap buys is where the two diverge. A preset category
      // takes the fixed prefix: its fallback is transient, and re-fetching the
      // same feeds is what makes an outage's repeated attempts idempotent. A
      // custom category is the ONLY consumer of its feeds and is never in the
      // digest, so a fixed prefix made the cap PERMANENT — feeds 4..N were
      // unreachable on every load and every refresh (#5873). It rotates
      // instead: same request budget, advanced by the cap each cycle, so every
      // source is reached within ceil(N / cap) cycles.
      const rotationCycle = isCustom ? this.newsRotationCycle(category) : 0;
      const fallbackFeeds = isCustom
        ? selectRotatingFeedWindow(reachableFeeds, this.perFeedFallbackCategoryFeedLimit, rotationCycle)
        : this.selectLimitedFeeds(enabledFeeds, this.perFeedFallbackCategoryFeedLimit);
      if (isCustom) {
        // Advanced as soon as the window is claimed rather than after the fetch
        // resolves, so a cycle that fails outright still moves on instead of
        // retrying the same failing window forever.
        this.advanceNewsRotationCycle(category, reachableFeeds.length);
        console.warn(`[News] Custom category "${category}" (not in variant preset), fetching ${fallbackFeeds.length}/${reachableFeeds.length} feeds directly (rotation cycle ${rotationCycle})`);
      } else if (options.allowDigestPendingFallback) {
        console.warn(`[News] Digest still pending for "${category}", using limited per-feed fallback (${fallbackFeeds.length}/${enabledFeeds.length} feeds)`);
      } else if (fallbackFeeds.length < enabledFeeds.length) {
        console.warn(`[News] Digest missing for "${category}", using limited per-feed fallback (${fallbackFeeds.length}/${enabledFeeds.length} feeds)`);
      } else {
        console.warn(`[News] Digest missing for "${category}", using per-feed fallback (${fallbackFeeds.length} feeds)`);
      }

      const { fetchCategoryFeeds, getFeedFailures } = await getRssModule();
      const fetchedItems = await fetchCategoryFeeds(fallbackFeeds, {
        batchSize: this.perFeedFallbackBatchSize,
        onBatch: (partialItems) => {
          scheduleRender(partialItems);
          // Map flashes and breaking-news alerts fire on the FRESH batch only.
          // Feeding them the merged set would re-flash and re-alert on every
          // rotation cycle for headlines the user has already seen.
          this.flashMapForNews(partialItems);
          if (this.isCurrentNewsLoad(generation)) checkBatchForBreakingAlerts(partialItems);
        },
      });

      // Everything downstream — render, empty-state, baseline, status count and
      // the value that lands in ctx.allNews — reads the MERGED set, because for
      // a custom category that is what the panel actually shows. Using the raw
      // fetch would report this cycle's three sources as the whole category and
      // hand clustering a set the user isn't looking at.
      const items = mergeForRender(fetchedItems);
      const failures = getFeedFailures();
      const failedFeeds = fallbackFeeds.filter(f => failures.has(f.name));
      const windowFailed = fallbackFeeds.length > 0 && failedFeeds.length === fallbackFeeds.length;
      this.setNewsRefreshDegraded(category, windowFailed);
      this.renderNewsForCategory(category, items);
      if (panel) {
        if (renderTimeout) {
          clearTimeout(renderTimeout);
          renderTimeout = null;
          pendingItems = null;
        }

        if (items.length === 0 && failedFeeds.length > 0) {
          const names = failedFeeds.map(f => f.name).join(', ');
          panel.showError(`${t('common.noNewsAvailable')} (${names} failed)`);
        }

        if (options.recordBaselineSample && !windowFailed) {
          try {
            const baseline = await updateBaseline(`news:${category}`, items.length);
            const deviation = calculateDeviation(items.length, baseline);
            panel.setDeviation(deviation.zScore, deviation.percentChange, deviation.level);
          } catch (e) { console.warn(`[Baseline] news:${category} write failed:`, e); }
        }
      }

      const feedLabel = category.charAt(0).toUpperCase() + category.slice(1);
      if (windowFailed) {
        const names = failedFeeds.map(f => f.name).join(', ');
        this.ctx.statusPanel?.updateFeed(feedLabel, {
          status: 'error',
          itemCount: items.length,
          errorMessage: `${names} failed`,
        });
        this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'error' });
      } else {
        this.ctx.statusPanel?.updateFeed(feedLabel, {
          status: 'ok',
          itemCount: items.length,
        });
        this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'ok' });
      }

      return items;
    } catch (error) {
      this.ctx.statusPanel?.updateFeed(category.charAt(0).toUpperCase() + category.slice(1), {
        status: 'error',
        errorMessage: String(error),
      });
      this.ctx.statusPanel?.updateApi('RSS2JSON', { status: 'error' });
      // A preset category drops its items: its next successful load replaces
      // them wholesale from the digest, so holding stale ones only risks
      // presenting them as current.
      //
      // A custom category's stored items are its ACCUMULATED rotation coverage,
      // built one capped window per 20-minute cycle (#5873). Dropping them
      // sends the next cycle back to carry-over-less, so a single transient
      // error — a chunk-load hiccup is enough — silently restarts the hour it
      // takes to cover a ten-source panel. Keep them: the next cycle merges
      // onto them, and the status panel already reports the error.
      if (!isCustom) {
        delete this.ctx.newsByCategory[category];
        return [];
      }

      this.setNewsRefreshDegraded(category, true);
      const enabledNames = new Set(
        (feeds ?? [])
          .filter(feed => !this.ctx.disabledSources.has(feed.name))
          .map(feed => feed.name),
      );
      return this.getStaleNewsItems(category).filter(item => enabledNames.has(item.source));
    }
  }

  /**
   * Panel-driven, not variant-driven: the active variant's preset categories
   * PLUS any extra categories required by enabled news panels the user added
   * beyond the preset (e.g. Tech panels customized into `full`). Custom
   * categories aren't in the per-variant server digest, so they're flagged
   * `isCustom` and fetched directly client-side in loadNewsCategory().
   */
  private resolveEnabledNewsCategories(): ResolvedCategory[] {
    return resolveNewsCategories(
      FEEDS,
      CANONICAL_FEEDS,
      enabledNewsCategoryKeys(this.ctx.newsCategoryPanelKeys, this.ctx.panelSettings),
    );
  }

  /**
   * Whether loadAllData() should (re)run the news load.
   *
   * Unlike every other hydration task, the news load is NOT viewport-gated — it
   * always loaded everything — so an unconditional `news` task meant each of
   * loadAllData()'s many triggers re-fetched the digest. Boot alone fires two
   * (panel-layout's hydration trigger, then App.ts's bootstrap fan-out) and the
   * drain loop turns overlapping calls into a second full run: two
   * `list-feed-digest` requests per page load, plus a second round of per-feed
   * fetches (#5376).
   *
   * The category set is what the load actually keys on, so re-run when it has
   * changed (tab switch, mission preset, panel toggle) and skip when it has not
   * (viewport entry, scroll, playback exit). Periodic refresh stays owned by
   * RefreshScheduler's `news` loop at REFRESH_INTERVALS.feeds, which calls
   * loadNews() directly and is unaffected by this gate.
   */
  private shouldHydrateNews(forceAll: boolean): boolean {
    if (forceAll || this.loadedNewsSignature === null) return true;
    const current = newsWorkListSignature(this.resolveEnabledNewsCategories(), this.ctx.disabledSources);
    return current !== this.loadedNewsSignature;
  }

  /**
   * Drop the record of what the last news load covered, so the next
   * loadAllData() reloads news even though the category set is unchanged.
   *
   * Callers are the paths that take the rendered headlines away without
   * changing the work-list — playback replay puts every news panel back into a
   * loading state and relies on the exit calling loadAllData() to refill them.
   */
  invalidateNewsHydration(): void {
    this.loadedNewsSignature = null;
  }

  private beginNewsLoad(): number {
    this.newsLoadGeneration += 1;
    return this.newsLoadGeneration;
  }

  private isCurrentNewsLoad(generation: number): boolean {
    return generation === this.newsLoadGeneration;
  }

  private async clusterNewsForGeneration(
    items: NewsItem[],
    generation: number,
    forcedPath?: NewsClusteringProfilePath,
  ): Promise<NewsClusteringProfileResult & { clusters: ClusteredEvent[] }> {
    const mlAvailableAtSelection = mlWorker.isAvailable;
    const selectedPath = forcedPath ?? (mlAvailableAtSelection ? 'hybrid' : 'analysis-worker');
    if (selectedPath === 'hybrid' && !mlAvailableAtSelection) {
      throw new Error('Hybrid clustering profile requested before local ML became available');
    }

    const startedAt = import.meta.env.VITE_E2E === '1' ? performance.now() : 0;
    const clusters = selectedPath === 'hybrid'
      ? await clusterNewsHybrid(items, { shouldContinue: () => this.isCurrentNewsLoad(generation) })
      : await clusterNewsWithWorkerFallback(items, {
        shouldContinue: () => this.isCurrentNewsLoad(generation),
      });
    if (import.meta.env.VITE_E2E === '1') {
      performance.measure(`wm:news-clustering:path:${selectedPath}`, {
        start: startedAt,
        end: performance.now(),
        detail: {
          generation,
          selectedPath,
          mlAvailableAtSelection,
          itemCount: items.length,
          clusterCount: clusters.length,
        },
      });
    }

    return {
      generation,
      selectedPath,
      mlAvailableAtSelection,
      itemCount: items.length,
      clusterCount: clusters.length,
      clusters,
    };
  }

  private async runNewsClusteringProfile(
    path: NewsClusteringProfilePath,
    protoItems: ProtoNewsItem[],
  ): Promise<NewsClusteringProfileResult> {
    if (path === 'hybrid' && !mlWorker.isAvailable) {
      throw new Error('Hybrid clustering profile requested before local ML became available');
    }

    const generation = this.beginNewsLoad();
    const items = protoItems.map(protoItemToNewsItem);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!this.isCurrentNewsLoad(generation)) {
      throw new Error('News clustering profile generation was superseded');
    }
    const profiled = await this.clusterNewsForGeneration(items, generation, path);
    if (!this.isCurrentNewsLoad(generation)) {
      throw new Error('News clustering profile generation was superseded');
    }
    return {
      generation: profiled.generation,
      selectedPath: profiled.selectedPath,
      mlAvailableAtSelection: profiled.mlAvailableAtSelection,
      itemCount: profiled.itemCount,
      clusterCount: profiled.clusterCount,
    };
  }

  async loadNews(): Promise<void> {
    const generation = this.beginNewsLoad();

    // Fire digest fetch early, but do not let a slow digest stall the category
    // first paint. Fast digests still take the optimized digest-backed path.
    const digestPromise = this.tryFetchDigest().catch((error) => {
      console.warn('[News] Digest fetch failed before category load:', error);
      return null;
    });
    const fallbackKey = this.digestCacheKey();
    const fallbackDigest = this.getRetainedDigest(fallbackKey) ?? await this.loadPersistedDigest(fallbackKey);
    const fallbackSelection = fallbackDigest
      ? { digest: fallbackDigest, servedStale: true }
      : null;

    const categories = this.resolveEnabledNewsCategories();
    // Snapshot beside the categories: `ctx.disabledSources` is mutated IN PLACE by
    // the settings source toggle, so reading it after the await would record the
    // post-toggle set for a load that used the pre-toggle one.
    const disabledAtLoadStart = new Set(this.ctx.disabledSources);

    const categoryConcurrency = Math.max(1, Math.min(5, categories.length));
    const newsPass = await runNewsLoadPass(
      {
        categories,
        categoryConcurrency,
        digestPromise,
        fallbackDigest: fallbackSelection,
        digestGraceMs: this.digestFirstPaintGraceMs,
        allowPendingPerFeedFallback: this.isPerFeedFallbackEnabled(),
        hasDigestCategory: (selection, key) => Boolean(selection.digest.categories && key in selection.digest.categories),
        loadCategory: ({ key, feeds, isCustom }, selection, options) => (
          this.loadNewsCategory(
            key,
            feeds,
            selection,
            isCustom,
            options,
            generation,
          )
        ),
        onCategoryError: (key, reason) => {
          console.error(`[App] News category ${key ?? 'unknown'} failed:`, reason);
        },
        onDigestRefreshError: (key, reason) => {
          console.error(`[App] Digest refresh for news category ${key ?? 'unknown'} failed:`, reason);
        },
      },
    );
    const { categoryItemsByKey } = newsPass;

    // An older load can finish after a newer request because digest and
    // per-feed fallbacks have independent latency. It must not replace the
    // newer request's data or the notification freshness paired with it.
    if (!this.isCurrentNewsLoad(generation)) return;

    const collectedNews: NewsItem[] = [];
    for (const { key } of categories) {
      const items = categoryItemsByKey.get(key) ?? [];
      collectedNews.push(...items);
    }

    this.ctx.allNews = collectedNews;
    // Record what this run covered — but only when it actually landed something for
    // the gate to protect. A run counts as landed when the digest COVERED at least
    // one preset category (authoritative even where that bucket came back empty),
    // when items arrived by any path, or when there are no categories to retry.
    //
    // A digest outage lands none of those, and it has two shapes. The obvious one
    // is a failed request. The one that bites is a 200 carrying an empty or partial
    // `categories` map — non-null, so a plain null check would call it landed. Both
    // render every preset category empty on web (`newsPerFeedFallback` is off), and
    // recording either would make the gate treat an empty dashboard as "already
    // loaded" and suppress every retry until RefreshScheduler's 20-minute tick.
    // Leaving the signature unset keeps the next trigger a real retry — the recovery
    // the pre-gate double-load provided by accident, now deliberate.
    //
    // Coverage is measured over PRESET categories only: a custom category succeeds
    // on its own direct-fetch path, so counting it would let one customized panel
    // mask an outage for every other category in the work-list.
    //
    // Set here rather than in a `finally` so a load that threw on the way in stays
    // retryable too, and before the post-load intelligence tail so a failure there
    // doesn't force a re-fetch of news that already arrived. The disabled-source set
    // is the one snapshotted at load start, so a source toggled mid-load compares
    // unequal on the next trigger instead of being swallowed.
    const digestCategories = newsPass.finalDigest?.digest.categories ?? {};
    const digestCovered = categories.some(({ key, isCustom }) => !isCustom && key in digestCategories);
    const anyItemsCollected = collectedNews.length > 0;
    const noCategoriesToLoad = categories.length === 0;
    const landed = digestCovered || anyItemsCollected || noCategoriesToLoad;
    if (landed) this.loadedNewsSignature = newsWorkListSignature(categories, disabledAtLoadStart);
    this.ctx.initialLoadComplete = true;

    this.updateMonitorResults();

    try {
      // Snapshot local-ML availability AT this generation's clustering choice
      // (#7779): available takes the hybrid path, unavailable the analysis
      // path. Worker readiness alone must never force a news reload or
      // retroactively regroup committed first-load results — a later normal
      // refresh re-reads availability and may use newly available ML.
      const { clusters } = await this.clusterNewsForGeneration(this.ctx.allNews, generation);
      if (!this.isCurrentNewsLoad(generation)) return;
      this.ctx.latestClusters = clusters;
      // Only now is an empty cluster set a real answer. Set inside the try, after
      // the assignment, so a pass that threw leaves late-mounting hub panels on
      // their loading skeleton instead of asserting "no active hubs".
      this.ctx.clustersSettled = true;

      const geoLocated = this.ctx.latestClusters
        .filter((c): c is typeof c & { lat: number; lon: number } => c.lat != null && c.lon != null)
        .map(c => ({
          lat: c.lat,
          lon: c.lon,
          title: c.primaryTitle,
          threatLevel: c.threat?.level ?? 'info',
          timestamp: c.lastUpdated,
          // #9213: the verdict the News panel shows for this cluster.
          corroboration: assessCorroboration(evidenceFromCluster(c)),
        }));
      if (geoLocated.length > 0 || landed) {
        this.ctx.map?.setNewsLocations(geoLocated);
      }
    } catch (error) {
      console.error('[App] Clustering failed, clusters unchanged:', error);
    }
  }

  async loadMarkets(): Promise<void> {
    const generation = this.marketLoadGuard.begin();
    const isCurrent = () => this.marketLoadGuard.isCurrent(generation);
    // Method-scoped so all of loadMarkets' try blocks (stocks/commodities) see
    // these; market is dynamic-imported off eager main.js (#4571).
    // Guarded: loadMarkets must not reject (the init() watchlist handler calls it
    // unguarded), so a chunk-load failure skips this cycle like the per-block catches do.
    let marketMod: typeof import('@/services/market');
    try {
      marketMod = await import('@/services/market');
    } catch (e) {
      // Persistent failure mode: a stale-deploy chunk 404 would otherwise skip the
      // whole markets/commodities cycle with no signal. Log so it's traceable,
      // and mirror the downstream failure states before returning.
      console.warn('[DataLoader] market chunk load failed', e);
      if (isCurrent()) {
        this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
        (this.ctx.panels['markets'] as MarketPanel | undefined)?.showRetrying(t('common.failedMarketData'));
        (this.ctx.panels['commodities'] as CommoditiesPanel | undefined)?.showRetrying(t('common.failedCommodities'));
      }
      return;
    }
    const {
      fetchMultipleStocks, fetchCommodityQuotes, fetchPhysicalDivergence, fetchPhysicalPremiums, warmCommodityCache,
    } = marketMod;
    try {
      const customEntries = getMarketWatchlistEntries();
      const effectiveSymbols = resolveEffectiveMarketWatchlist(
        STOCK_CATALOG,
        MARKET_SYMBOLS,
        getCatalogSelection(),
        customEntries,
      ).symbols;

      // Hydrate markets from bootstrap (same pattern as sectors) — instant data on page load
      const hydratedMarkets = getHydratedData('marketQuotes') as ListMarketQuotesResponse | undefined;
      let stocksResult: Awaited<ReturnType<typeof fetchMultipleStocks>>;
      const marketsPanel = this.ctx.panels['markets'] as MarketPanel | undefined;
      const hydratedDisclosures = getHydratedData('chinaCorporateDisclosures') as
        ChinaCorporateDisclosureSnapshot | undefined;
      if (hydratedDisclosures !== undefined) {
        marketsPanel?.renderDisclosures(hydratedDisclosures);
      }

      const selectedHydratedQuotes = selectCompleteHydratedMarketQuotes(
        effectiveSymbols,
        hydratedMarkets?.quotes,
      );
      if (selectedHydratedQuotes) {
        const symbolMetaMap = new Map(effectiveSymbols.map((s) => [s.symbol, s]));
        const data = selectedHydratedQuotes.map((q) => ({
          symbol: q.symbol,
          name: symbolMetaMap.get(q.symbol)?.name || q.name,
          display: symbolMetaMap.get(q.symbol)?.display || q.display || q.symbol,
          price: q.price != null ? q.price : null,
          change: q.change ?? null,
          sparkline: q.sparkline?.length > 0 ? q.sparkline : undefined,
        }));
        if (isCurrent()) {
          this.ctx.latestMarkets = data;
          marketsPanel?.renderMarkets(data);
        }
        stocksResult = {
          data,
          skipped: hydratedMarkets?.finnhubSkipped || undefined,
          rateLimited: hydratedMarkets?.rateLimited || undefined,
        };
      } else {
        stocksResult = await fetchMultipleStocks(effectiveSymbols, {
          onBatch: (partialStocks) => {
            if (!isCurrent()) return;
            this.ctx.latestMarkets = partialStocks;
            marketsPanel?.renderMarkets(partialStocks);
          },
        });
        if (isCurrent()) {
          this.ctx.latestMarkets = stocksResult.data;
          marketsPanel?.renderMarkets(stocksResult.data, stocksResult.rateLimited, stocksResult.unavailableSymbols);
        }
      }

      const stockAvailability = resolveStockMarketAvailability({
        stockCount: stocksResult.data.length,
        finnhubSkipped: stocksResult.skipped,
        rateLimited: stocksResult.rateLimited,
      });

      if (!isCurrent()) {
        // A newer selection/load owns all market writes and any premium reload.
      } else if (stockAvailability.rateLimitError) {
        this.ctx.panels['commodities']?.showError(stockAvailability.rateLimitError);
      } else if (stockAvailability.finnhubStatus) {
        this.ctx.statusPanel?.updateApi('Finnhub', { status: stockAvailability.finnhubStatus });
        if (stockAvailability.marketsConfigError) {
          this.ctx.panels['markets']?.showConfigError(stockAvailability.marketsConfigError);
        }
      }

      const commoditiesPanel = this.ctx.panels['commodities'] as CommoditiesPanel | undefined;
      const mapCommodity = (c: MarketData) => ({ symbol: c.symbol, display: c.display, price: c.price, change: c.change, sparkline: c.sparkline });
      // The nuclear hub's "Energy Commodities" panel carries the whole tape,
      // energy contracts included; only the VIX row is not a commodity.
      const filterCommodityTape = (data: MarketData[]) => data.filter((item) => item.symbol !== '^VIX');

      if (commoditiesPanel) {
        // Hydrate commodities from bootstrap (same pattern as sectors/markets)
        const hydratedCommodities = getHydratedData('commodityQuotes') as ListCommodityQuotesResponse | undefined;
        let loaded = stockAvailability.skipCommodityFetch;

        if (!loaded && hydratedCommodities?.quotes?.length) {
          // Warm the circuit-breaker cache so SWR serves stale data if the
          // first scheduled live call fails (bootstrap hydration bypasses the RPC).
          warmCommodityCache(hydratedCommodities);
          const symbolMetaMap = new Map(COMMODITIES.map((s) => [s.symbol, s]));
          const data = hydratedCommodities.quotes.map((q) => ({
            symbol: q.symbol,
            name: symbolMetaMap.get(q.symbol)?.name || q.name,
            display: symbolMetaMap.get(q.symbol)?.display || q.display || q.symbol,
            price: q.price != null ? q.price : null,
            change: q.change ?? null,
            sparkline: q.sparkline?.length > 0 ? q.sparkline : undefined,
          }));
          const commodityMapped = filterCommodityTape(data).map(mapCommodity);
          if (commodityMapped.some(d => d.price !== null)) {
            commoditiesPanel.renderCommodities(commodityMapped);
            loaded = true;
          }
        }

        if (!loaded) {
          const commoditiesResult = await fetchCommodityQuotes(COMMODITIES, {
            onBatch: (partial) => {
              commoditiesPanel.renderCommodities(filterCommodityTape(partial).map(mapCommodity));
            },
          });
          const commodityMapped = filterCommodityTape(commoditiesResult.data).map(mapCommodity);
          if (commodityMapped.some(d => d.price !== null)) {
            commoditiesPanel.renderCommodities(commodityMapped);
            loaded = true;
          }
        }
        if (!loaded) commoditiesPanel.renderCommodities([]);
      }

      // Physical premiums + divergence index are Pro (#6436/#6448). Skipping
      // the fetch leaves _physicalPremiums empty, which is exactly what
      // _buildTabBar reads to decide whether the Physical tab exists — so a
      // free viewer sees the commodity tape unchanged rather than a tab that
      // opens onto a 401.
      if (commoditiesPanel && hasPremiumAccess()) {
        try {
          const physicalGeneration = this.physicalComparisonLoadGuard.begin();
          await loadPhysicalPremiumComparisonIfNeeded(
            commoditiesPanel,
            () => (
              isCurrent()
              && this.physicalComparisonLoadGuard.isCurrent(physicalGeneration)
              && hasPremiumAccess()
            ),
            fetchPhysicalPremiums,
            fetchPhysicalDivergence,
          );
        } catch {
          // The physical comparison is an optional tab; a failure must not
          // downgrade the existing commodity tape or its provider status.
        }
      }

      // Load ECB FX rates for CommoditiesPanel FX tab
      if (commoditiesPanel) {
        try {
          const { getEcbFxRatesData, toEurSpotRows } = await import('@/services/economic');
          const fxResp = await getEcbFxRatesData();
          if (!fxResp.unavailable && fxResp.rates?.length) {
            // Shared with the FX panel (#6199) so the pair list and its display
            // order live in one place. This tab previously kept a private
            // EUR_FX_ORDER literal; the two would have drifted the moment the
            // seeder published an eighth pair.
            commoditiesPanel.updateFxRates(toEurSpotRows(fxResp.rates));
          }
        } catch {
          // FX tab is optional, ignore failures
        }
      }
    } catch {
      if (isCurrent()) this.ctx.statusPanel?.updateApi('Finnhub', { status: 'error' });
    }
  }

  async loadPhysicalPremiumComparison(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    // Pro (#6436/#6448) — mirrors the guard on the bulk market pass above.
    // This is the tab-activation entry point, so without it clicking Physical
    // would re-fire the two gated RPCs for a free user on every open.
    // Free→Pro / Pro→free transitions are handled in App.firePremiumLoaders().
    if (!hasPremiumAccess()) return;
    const panel = this.ctx.panels['commodities'] as CommoditiesPanel | undefined;
    if (!panel) return;
    const generation = this.physicalComparisonLoadGuard.begin();
    const { fetchPhysicalDivergence, fetchPhysicalPremiums } = await import('@/services/market');
    signal?.throwIfAborted();
    await loadPhysicalPremiumComparison(
      panel,
      () => (
        !signal?.aborted
        && this.physicalComparisonLoadGuard.isCurrent(generation)
        && hasPremiumAccess()
      ),
      () => fetchPhysicalPremiums(signal),
      () => fetchPhysicalDivergence(signal),
    );
    signal?.throwIfAborted();
  }

  clearPhysicalPremiumComparison(): void {
    this.physicalComparisonLoadGuard.begin();
    const panel = this.ctx.panels['commodities'] as CommoditiesPanel | undefined;
    panel?.clearPhysicalPremiums();
  }

  async loadNatural(): Promise<void> {
    const [earthquakeResult, eonetResult] = await Promise.allSettled([
      fetchEarthquakes(),
      fetchNaturalEvents(30),
    ]);

    if (earthquakeResult.status === 'fulfilled') {
      this.ctx.intelligenceCache.earthquakes = earthquakeResult.value;
      this.ctx.map?.setEarthquakes(earthquakeResult.value);
      this.callPanel('nuclear-hazards', 'setEarthquakes', earthquakeResult.value);
      this.ctx.statusPanel?.updateApi('USGS', { status: 'ok' });
      dataFreshness.recordUpdate('usgs', earthquakeResult.value.length);
    } else {
      this.ctx.intelligenceCache.earthquakes = [];
      this.ctx.map?.setEarthquakes([]);
      this.ctx.statusPanel?.updateApi('USGS', { status: 'error' });
      dataFreshness.recordError('usgs', String(earthquakeResult.reason));
    }

    if (eonetResult.status === 'fulfilled') {
      this.ctx.map?.setNaturalEvents(eonetResult.value);
      this.callPanel('nuclear-hazards', 'setNaturalEvents', eonetResult.value);
      this.ctx.statusPanel?.updateFeed('EONET', {
        status: 'ok',
        itemCount: eonetResult.value.length,
      });
      this.ctx.statusPanel?.updateApi('NASA EONET', { status: 'ok' });
    } else {
      this.ctx.map?.setNaturalEvents([]);
      this.ctx.statusPanel?.updateFeed('EONET', { status: 'error', errorMessage: String(eonetResult.reason) });
      this.ctx.statusPanel?.updateApi('NASA EONET', { status: 'error' });
    }

    const hasEarthquakes = earthquakeResult.status === 'fulfilled' && earthquakeResult.value.length > 0;
    const hasEonet = eonetResult.status === 'fulfilled' && eonetResult.value.length > 0;
    this.ctx.map?.setLayerReady('natural', hasEarthquakes || hasEonet);
  }

  async loadPipelineRegistries(options: { refresh?: boolean } = {}): Promise<void> {
    try {
      const registries = await ensurePipelineRegistriesHydrated(options);
      const hasData = Boolean(registries.gas || registries.oil);
      this.ctx.map?.setLayerReady('pipelines', hasData);
      this.ctx.map?.render();
    } catch {
      this.ctx.map?.setLayerReady('pipelines', false);
    }
  }

  async loadWeatherAlerts(): Promise<void> {
    try {
      const alerts = await fetchWeatherAlerts();
      this.ctx.map?.setWeatherAlerts(alerts);
      this.callPanel('nuclear-hazards', 'setWeatherAlerts', alerts);
      this.ctx.map?.setLayerReady('weather', alerts.length > 0);
      this.ctx.statusPanel?.updateFeed('Weather', { status: 'ok', itemCount: alerts.length });
      dataFreshness.recordUpdate('weather', alerts.length);
    } catch (error) {
      this.ctx.map?.setLayerReady('weather', false);
      this.ctx.statusPanel?.updateFeed('Weather', { status: 'error' });
      dataFreshness.recordError('weather', String(error));
    }
  }

  async loadIntelligenceSignals(): Promise<void> {
    const tasks: Promise<void>[] = [];

    tasks.push((async () => {
      try {
        const outages = await fetchInternetOutages();
        this.ctx.intelligenceCache.outages = outages;
        dataFreshness.recordUpdate('outages', outages.length);
        if (this.ctx.mapLayers.outages) {
          this.ctx.map?.setOutages(outages);
          this.ctx.map?.setLayerReady('outages', outages.length > 0);
          this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
        }
        fetchTrafficAnomalies().then(r => {
          this.ctx.map?.setTrafficAnomalies(r.anomalies);
        }).catch(() => {});
        fetchDdosAttacks().then(r => {
          this.ctx.map?.setDdosLocations(r.topTargetLocations ?? []);
        }).catch(() => {});
      } catch (error) {
        console.error('[Intelligence] Outages fetch failed:', error);
        dataFreshness.recordError('outages', String(error));
      }
    })());

    tasks.push((async () => {
      try {
        const climateResult = await fetchClimateAnomalies();
        if (!climateResult.ok) {
          dataFreshness.recordError('climate', 'Climate anomalies unavailable (retaining prior climate state)');
          this.showColdLoadError('climate');
          return;
        }
        const anomalies = climateResult.anomalies;
        this.callPanel('climate', 'setAnomalies', anomalies);
        if (this.ctx.mapLayers.climate) {
          this.ctx.map?.setClimateAnomalies(anomalies);
        }
        if (anomalies.length > 0) dataFreshness.recordUpdate('climate', anomalies.length);
      } catch (error) {
        console.error('[Intelligence] Climate anomalies fetch failed:', error);
        this.showColdLoadError('climate');
        dataFreshness.recordError('climate', String(error));
      }
    })());

    await Promise.allSettled(tasks);

    // Population exposure was fed by the protest and UCDP event feeds, which
    // were removed with their domains; with no geolocated events left to
    // enrich, the panel renders its empty state.
    this.callPanel('population-exposure', 'setExposures', []);

    console.log('[Intelligence] All signals loaded');
  }

  async loadOutages(): Promise<void> {
    if (this.ctx.intelligenceCache.outages) {
      const outages = this.ctx.intelligenceCache.outages;
      this.ctx.map?.setOutages(outages);
      this.ctx.map?.setLayerReady('outages', outages.length > 0);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      return;
    }
    try {
      const outages = await fetchInternetOutages();
      this.ctx.intelligenceCache.outages = outages;
      this.ctx.map?.setOutages(outages);
      this.ctx.map?.setLayerReady('outages', outages.length > 0);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'ok', itemCount: outages.length });
      dataFreshness.recordUpdate('outages', outages.length);
      fetchTrafficAnomalies().then(r => {
        this.ctx.map?.setTrafficAnomalies(r.anomalies);
      }).catch(() => {});
      fetchDdosAttacks().then(r => {
        this.ctx.map?.setDdosLocations(r.topTargetLocations ?? []);
      }).catch(() => {});
    } catch (error) {
      this.ctx.map?.setLayerReady('outages', false);
      this.ctx.statusPanel?.updateFeed('NetBlocks', { status: 'error' });
      dataFreshness.recordError('outages', String(error));
    }
  }

  async loadCableHealth(): Promise<void> {
    try {
      const healthData = await fetchCableHealth();
      this.ctx.map?.setCableHealth(healthData.cables);
      const cableIds = Object.keys(healthData.cables);
      const faultCount = cableIds.filter((id) => healthData.cables[id]?.status === 'fault').length;
      const degradedCount = cableIds.filter((id) => healthData.cables[id]?.status === 'degraded').length;
      this.ctx.statusPanel?.updateFeed('CableHealth', { status: 'ok', itemCount: faultCount + degradedCount });
    } catch {
      this.ctx.map?.setCableHealth({});
      this.ctx.statusPanel?.updateFeed('CableHealth', { status: 'error' });
    }
  }

  private lastWebcamBbox: { w: number; s: number; e: number; n: number; zoom: number } | null = null;
  private lastWebcamFetchAt = 0;

  async loadWebcams(): Promise<void> {
    if (!this.ctx.map) return;
    try {
      const map = this.ctx.map;
      const zoom = Math.max(2, map.getState().zoom ?? 3);

      const now = Date.now();
      if (now - this.lastWebcamFetchAt < 1000) return;

      const bboxStr = map.getBbox();
      const parts = bboxStr ? bboxStr.split(',').map(Number) : [-180, -90, 180, 90];
      const w = parts[0] ?? -180;
      const s = parts[1] ?? -90;
      const e = parts[2] ?? 180;
      const n = parts[3] ?? 90;

      if (this.lastWebcamBbox && this.lastWebcamBbox.zoom === zoom) {
        const prev = this.lastWebcamBbox;
        const overlapW = Math.max(0, Math.min(prev.e, e) - Math.max(prev.w, w));
        const overlapH = Math.max(0, Math.min(prev.n, n) - Math.max(prev.s, s));
        const overlapArea = overlapW * overlapH;
        const currentArea = Math.max(0.001, (e - w) * (n - s));
        if (overlapArea / currentArea > 0.8) return;
      }

      this.lastWebcamFetchAt = now;
      this.lastWebcamBbox = { w, s, e, n, zoom };

      const { fetchWebcams } = await import('@/services/webcams');
      const result = await fetchWebcams(zoom, { w, s, e, n });

      const allMarkers = [...result.webcams, ...result.clusters];
      map.setWebcams(allMarkers);
      map.setLayerReady('webcams', allMarkers.length > 0);
    } catch (err) {
      console.warn('[data-loader] webcams failed:', err);
      this.ctx.map?.setLayerReady('webcams', false);
    }
  }

  async loadDiseaseOutbreaks(): Promise<void> {
    try {
      const data = await fetchDiseaseOutbreaks();
      if (Array.isArray(data.outbreaks) && Number.isFinite(data.fetchedAt) && data.fetchedAt > 0) {
        this.ctx.map?.setDiseaseOutbreaks(data.outbreaks);
        this.ctx.map?.setLayerReady('diseaseOutbreaks', true);
      }
    } catch (e) {
      console.error('[App] Disease outbreaks load failed:', e);
    }
  }

  updateMonitorResults(): void {
    // Queued, for the same reason as the cluster fan-out above: the boot call
    // site is inside loadNews, which runs ONCE per work-list signature. Monitors
    // is an opt-in panel, so it is always enabled mid-session and always mounts
    // after that pass — an optional-chained call left its results area blank,
    // which reads as "your keywords matched nothing" rather than as a panel that
    // never got the news. The other two call sites (monitor edited, monitors
    // list changed) run with the panel mounted and take callPanel's direct path.
    this.callPanel('monitors', 'renderResults', this.ctx.allNews);
  }

  async loadFirmsData(): Promise<void> {
    try {
      const fireResult = await fetchAllFires(1);
      if (fireResult.skipped) {
        // en.json carries panels.satelliteFires as a flat title string, so the
        // nested .noData lookup could never resolve — it rendered the raw key.
        this.ctx.panels['satellite-fires']?.showConfigError(t('common.noData'));
        this.ctx.statusPanel?.updateApi('FIRMS', { status: 'error' });
        return;
      }
      const { regions, totalCount } = fireResult;
      if (totalCount > 0) {
        const flat = flattenFires(regions);
        const stats = computeRegionStats(regions);

        const mapFires = toMapFires(flat);
        this.ctx.map?.setFires(mapFires);
        this.callPanel('nuclear-hazards', 'setFires', mapFires);

        (this.ctx.panels['satellite-fires'] as SatelliteFiresPanel)?.update(stats, totalCount);

        dataFreshness.recordUpdate('firms', totalCount);
      } else {
        (this.ctx.panels['satellite-fires'] as SatelliteFiresPanel)?.update([], 0);
      }
      this.ctx.statusPanel?.updateApi('FIRMS', { status: 'ok' });
    } catch (e) {
      console.warn('[App] FIRMS load failed:', e);
      this.callPanel('satellite-fires', 'showError');
      this.ctx.statusPanel?.updateApi('FIRMS', { status: 'error' });
      dataFreshness.recordError('firms', String(e));
    }
  }

  syncDataFreshnessWithLayers(): void {
    for (const [layer, sourceIds] of Object.entries(LAYER_TO_SOURCE)) {
      const enabled = this.ctx.mapLayers[layer as keyof MapLayers] ?? false;
      for (const sourceId of sourceIds) {
        dataFreshness.setEnabled(sourceId as DataSourceId, enabled);
      }
    }

    if (isOutagesConfigured() === false) {
      dataFreshness.setEnabled('outages', false);
    }
  }

  async loadRadiationWatch(): Promise<void> {
    try {
      const result = await fetchRadiationWatch();
      const anomalies = result.observations.filter((observation) => observation.severity !== 'normal');
      this.callPanel('radiation-watch', 'setData', result);
      this.callPanel('nuclear-hazards', 'setRadiation', result.observations);
      this.ctx.intelligenceCache.radiation = result;
      this.ctx.map?.setRadiationObservations(anomalies);
      this.ctx.map?.setLayerReady('radiationWatch', anomalies.length > 0);
      if (result.observations.length > 0) {
        dataFreshness.recordUpdate('radiation', result.observations.length);
      }
    } catch (error) {
      console.error('[App] Radiation watch fetch failed:', error);
      this.callPanel('radiation-watch', 'showError');
      this.ctx.map?.setLayerReady('radiationWatch', false);
      dataFreshness.recordError('radiation', String(error));
    }
  }
}
