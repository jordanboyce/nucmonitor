import type { InternetOutage, PanelConfig, MapLayers, NewsItem, MarketData, ClusteredEvent, Monitor } from '@/types';
import type { OverlayId } from '@/utils/overlay-history';
import type { RadiationWatchResult } from '@/services/radiation';
import type { Earthquake } from '@/services/earthquakes';

import type { UnifiedSettingsTabId } from '@/components/settings-types';
export type { UnifiedSettingsTabId };

export interface UnifiedSettingsController {
  open(
    tab?: UnifiedSettingsTabId,
    replaceOverlayId?: OverlayId,
    historyPending?: boolean,
  ): void | Promise<boolean>;
  close(): void;
  hasPendingChanges(): boolean;
  refreshPanelToggles(): void;
  getButton(): HTMLButtonElement;
  destroy(): void;
}

export interface IntelligenceCache {
  outages?: InternetOutage[];
  earthquakes?: Earthquake[];
  radiation?: RadiationWatchResult;
}

export interface AppContext {
  map: import('@/components').MapContainer | null;
  readonly isMobile: boolean;
  readonly isDesktopApp: boolean;
  readonly container: HTMLElement;

  panels: Record<string, import('@/components').Panel>;
  newsPanels: Record<string, import('@/components').NewsPanel>;
  /**
   * `feed category key → the panel key its NewsPanel registered under`, filled
   * by panel-layout as it registers news panels. A category whose key was
   * already claimed by a non-news panel never lands here, which is what stops
   * the data layer resolving it as a news category (#5376). See
   * `enabledNewsCategoryKeys` in src/config/feed-resolution.ts.
   */
  newsCategoryPanelKeys: Map<string, string>;
  panelSettings: Record<string, PanelConfig>;

  mapLayers: MapLayers;

  allNews: NewsItem[];
  newsByCategory: Record<string, NewsItem[]>;
  latestMarkets: MarketData[];
  latestClusters: ClusteredEvent[];
  intelligenceCache: IntelligenceCache;

  disabledSources: Set<string>;
  currentTimeRange: import('@/components').TimeRange;

  inFlight: Set<string>;
  seenGeoAlerts: Set<string>;
  monitors: Monitor[];

  statusPanel: import('@/components').StatusPanel | null;
  searchModal: import('@/components').SearchModal | null;
  breakingBanner: import('@/components/BreakingNewsBanner').BreakingNewsBanner | null;
  playbackControl: import('@/components').PlaybackControl | null;
  exportPanel: import('@/utils/export').ExportPanel | null;
  unifiedSettings: UnifiedSettingsController | null;
  llmStatusIndicator: import('@/components').LlmStatusIndicator | null;
  authModal: { open(): void; close(): void; destroy(): void } | null;
  authHeaderWidget: import('@/components/AuthHeaderWidget').AuthHeaderWidget | null;
  isDestroyed: boolean;
  isPlaybackMode: boolean;
  isIdle: boolean;
  initialLoadComplete: boolean;
  /**
   * A clustering pass has completed successfully at least once, so `latestClusters`
   * is an answer rather than "not computed yet". Distinct from `initialLoadComplete`,
   * which is set before the clustering pass begins. Never reset: once a pass has
   * settled, a later in-flight pass still leaves the previous clusters on screen.
   */
  clustersSettled: boolean;
  resolvedLocation: 'global' | 'america' | 'mena' | 'eu' | 'asia' | 'latam' | 'africa' | 'oceania';

  initialUrlState: import('@/utils').ParsedMapUrlState | null;
  readonly PANEL_ORDER_KEY: string;
  readonly PANEL_SPANS_KEY: string;
}

export interface AppModule {
  init(): void | Promise<void>;
  destroy(): void;
}
