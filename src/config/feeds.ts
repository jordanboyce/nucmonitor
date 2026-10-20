import type { Feed } from '@/types';
import { rssProxyUrl } from '@/utils';
import { mergeCanonicalFeeds } from './feed-resolution';
import {
  getSourceProvenanceState,
  type SourceProvenanceState,
} from '../../shared/source-provenance';

const rss = rssProxyUrl;

// Source tier system — canonical definition lives in server/_shared/source-tiers.ts
// so server-side code can import it without pulling in client-only modules.
export { SOURCE_TIERS, declaredSourceTier, getSourceTier } from '../../server/_shared/source-tiers';
export {
  PERSPECTIVE_LABEL_CAVEAT,
  SOURCE_PROPAGANDA_RISK,
  SOURCE_TYPES,
  UNREVIEWED_SOURCE_RISK,
  composeProvenanceSummary,
  describePropagandaBadge,
  getProvenanceFacts,
  getSourcePropagandaRisk,
  getSourceProvenanceState,
  getSourceTierBadgeTitle,
  getSourceType,
  hasDeclaredPropagandaRisk,
  hasDeclaredSourceType,
  hasReviewedPropagandaRisk,
  hasReviewedSourceType,
  isStateAffiliatedSource,
} from '../../shared/source-provenance';
export {
  resolveRegisteredTelegramSourceName,
  resolveTelegramSourceName,
} from '../../shared/telegram-channel-trust';
export { computeCredibilityScore } from '../../shared/news-credibility.js';
export type {
  PropagandaRisk,
  ProvenanceFact,
  SourceProvenanceState,
  SourceRiskProfile,
  SourceType,
} from '../../shared/source-provenance';

let _sourcePanelMap: Map<string, string> | null = null;
export function getSourcePanelId(sourceName: string): string {
  if (!_sourcePanelMap) {
    _sourcePanelMap = new Map();
    // Seed with CANONICAL_FEEDS first so a source belonging to an on-demand
    // panel still resolves; the FEEDS preset pass then wins any collision.
    for (const [category, feeds] of Object.entries(CANONICAL_FEEDS)) {
      for (const feed of feeds) _sourcePanelMap.set(feed.name, category);
    }
    for (const [category, feeds] of Object.entries(FEEDS)) {
      for (const feed of feeds) _sourcePanelMap.set(feed.name, category);
    }
  }
  return _sourcePanelMap.get(sourceName) ?? 'nuclear-headlines';
}

// NucMonitor feeds.
// Keys are matched against panel IDs in src/config/panels.ts NUCLEAR_PANELS.
// The server mirror lives in server/worldmonitor/news/v1/_feeds.ts
// (VARIANT_FEEDS.nuclear); tests/news-feed-key-parity.test.mts keeps them aligned.
const NUCLEAR_FEEDS: Record<string, Feed[]> = {
  'nuclear-headlines': [
    { name: 'World Nuclear News',    url: rss('https://news.google.com/rss/search?q=site:world-nuclear-news.org+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'ANS Nuclear Newswire',  url: rss('https://news.google.com/rss/search?q=site:ans.org+nuclear+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'NRC News',              url: rss('https://news.google.com/rss/search?q=site:nrc.gov+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Reuters Nuclear',       url: rss('https://news.google.com/rss/search?q=site:reuters.com+(nuclear+OR+reactor+OR+uranium+OR+NRC)+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'AP Nuclear',            url: rss('https://news.google.com/rss/search?q=site:apnews.com+(nuclear+plant+OR+reactor+OR+"nuclear+regulatory")+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'US Nuclear Plants',     url: rss('https://news.google.com/rss/search?q=("nuclear+plant"+OR+"nuclear+power+plant"+OR+"nuclear+station")+(outage+OR+refueling+OR+restart+OR+shutdown+OR+NRC+OR+license)+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Utility Dive Nuclear',  url: rss('https://news.google.com/rss/search?q=site:utilitydive.com+nuclear+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'POWER Magazine Nuclear', url: rss('https://news.google.com/rss/search?q=site:powermag.com+nuclear+when:3d&hl=en-US&gl=US&ceid=US:en') },
  ],
  'nuclear-regulatory': [
    { name: 'NRC News',              url: rss('https://news.google.com/rss/search?q=site:nrc.gov+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'NRC Event Reports',     url: rss('https://news.google.com/rss/search?q=site:nrc.gov+("event+notification"+OR+"event+report"+OR+"inspection+report"+OR+"confirmatory+action")+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'DOE Nuclear Energy',    url: rss('https://news.google.com/rss/search?q=site:energy.gov+(nuclear+OR+reactor+OR+uranium+OR+HALEU)+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'NNSA',                  url: rss('https://news.google.com/rss/search?q=site:energy.gov/nnsa+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'DOE Environmental Management', url: rss('https://news.google.com/rss/search?q=site:energy.gov/em+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'EIA Nuclear',           url: rss('https://news.google.com/rss/search?q=site:eia.gov+nuclear+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'IAEA News',             url: rss('https://news.google.com/rss/search?q=site:iaea.org+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'EPA RadNet',            url: rss('https://news.google.com/rss/search?q=site:epa.gov+(radnet+OR+radiation+OR+radiological)+when:14d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'FEMA & Emergency Management', url: rss('https://news.google.com/rss/search?q=site:fema.gov+(nuclear+OR+radiological)+when:14d&hl=en-US&gl=US&ceid=US:en') },
  ],
  'nuclear-industry': [
    { name: 'World Nuclear News',    url: rss('https://news.google.com/rss/search?q=site:world-nuclear-news.org+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'ANS Nuclear Newswire',  url: rss('https://news.google.com/rss/search?q=site:ans.org+nuclear+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'NEI',                   url: rss('https://news.google.com/rss/search?q=site:nei.org+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Exchange Monitor',      url: rss('https://news.google.com/rss/search?q=site:exchangemonitor.com+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Nuclear Engineering International', url: rss('https://news.google.com/rss/search?q=site:neimagazine.com+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'SMR & Advanced Reactors', url: rss('https://news.google.com/rss/search?q=("small+modular+reactor"+OR+SMR+OR+"advanced+reactor"+OR+microreactor+OR+TerraPower+OR+"X-energy"+OR+NuScale+OR+Kairos+OR+Oklo)+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Uranium & Fuel Cycle',  url: rss('https://news.google.com/rss/search?q=(uranium+OR+enrichment+OR+HALEU+OR+Centrus+OR+Urenco+OR+"fuel+fabrication"+OR+"spent+fuel")+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Nuclear & Data Centers', url: rss('https://news.google.com/rss/search?q=(nuclear+AND+("data+center"+OR+hyperscaler+OR+Microsoft+OR+Amazon+OR+Google+OR+Meta)+AND+(power+OR+reactor+OR+PPA))+when:3d&hl=en-US&gl=US&ceid=US:en') },
  ],
  'nuclear-policy': [
    { name: 'Nuclear Policy',        url: rss('https://news.google.com/rss/search?q=("nuclear+energy"+OR+"nuclear+power")+(Congress+OR+Senate+OR+"White+House"+OR+"executive+order"+OR+legislation+OR+ADVANCE+Act)+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Spent Fuel & Waste',    url: rss('https://news.google.com/rss/search?q=("spent+nuclear+fuel"+OR+"nuclear+waste"+OR+"Yucca+Mountain"+OR+"interim+storage"+OR+WIPP+OR+ISFSI)+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Nuclear Security & Nonproliferation', url: rss('https://news.google.com/rss/search?q=(nonproliferation+OR+"nuclear+security"+OR+"nuclear+safeguards"+OR+"nuclear+material")+when:3d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Bulletin of Atomic Scientists',    url: rss('https://news.google.com/rss/search?q=site:thebulletin.org+when:7d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Union of Concerned Scientists', url: rss('https://news.google.com/rss/search?q=site:ucs.org+nuclear+when:14d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'State Radiation Programs', url: rss('https://news.google.com/rss/search?q=("radiation+control"+OR+"radiological+emergency"+OR+"emergency+planning+zone"+OR+"potassium+iodide")+nuclear+when:7d&hl=en-US&gl=US&ceid=US:en') },
  ],
  energy: [
    { name: 'EIA Press Room',        url: rss('https://www.eia.gov/rss/press_room.xml') },
    { name: 'Natural Gas & LNG',     url: rss('https://news.google.com/rss/search?q=("natural+gas"+OR+LNG+OR+"gas+price"+OR+"Henry+Hub")+when:1d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'US Grid & Reliability', url: rss('https://news.google.com/rss/search?q=(NERC+OR+PJM+OR+ERCOT+OR+MISO+OR+"grid+reliability"+OR+"capacity+auction")+when:2d&hl=en-US&gl=US&ceid=US:en') },
    { name: 'Energy Intel',          url: rss('https://news.google.com/rss/search?q=(energy+commodities+OR+"energy+market"+OR+"energy+prices"+OR+"energy+security")+when:2d&hl=en-US&gl=US&ceid=US:en') },
  ],
};

export const FEEDS = NUCLEAR_FEEDS;

// Canonical category→feeds map. Users can enable any catalog panel, so every
// news panel resolves its feeds here (see src/config/feed-resolution.ts):
//  • data-loader `loadNews()` — loads preset categories + custom enabled panels
//  • panel-layout — creates a NewsPanel for any enabled category
// On-demand categories are in the canonical registry so an enabled matching
// panel can resolve feeds, but they are NOT part of the FEEDS preset.
export const ON_DEMAND_FEEDS: Record<string, Feed[]> = {};

export const CANONICAL_FEEDS: Record<string, Feed[]> = mergeCanonicalFeeds([
  NUCLEAR_FEEDS,
  ON_DEMAND_FEEDS,
]);

/** Groups the Settings → Sources pills; keys are CANONICAL_FEEDS categories. */
export const SOURCE_REGION_MAP: Record<string, { labelKey: string; feedKeys: string[] }> = {
  nuclearNews: { labelKey: 'header.panelCatNuclearNews', feedKeys: ['nuclear-headlines', 'nuclear-regulatory', 'nuclear-industry', 'nuclear-policy'] },
  energy: { labelKey: 'header.sourceRegionTopical', feedKeys: ['energy'] },
};

/** Unique configured feed names across the feed catalog. */
export function listConfiguredFeedNames(): string[] {
  const names = new Set<string>();
  for (const feeds of Object.values(CANONICAL_FEEDS)) {
    for (const feed of feeds) names.add(feed.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Provenance state for a configured feed.
 * `reviewed` = present in SOURCE_PROPAGANDA_RISK (any risk including explicit low).
 * `unknown` = not yet reviewed — API still returns a definite profile via getSourcePropagandaRisk.
 */
export function getFeedProvenanceState(sourceName: string): SourceProvenanceState {
  return getSourceProvenanceState(sourceName);
}

/** Every catalog source is enabled on first boot; users opt out in Settings. */
export function computeDefaultDisabledSources(): string[] {
  return [];
}

export function getTotalFeedCount(): number {
  return listConfiguredFeedNames().length;
}

// Keywords that trigger alert status - must be specific to avoid false positives
export const ALERT_KEYWORDS = [
  'war', 'invasion', 'military', 'nuclear', 'sanctions', 'missile',
  'airstrike', 'drone strike', 'troops deployed', 'armed conflict', 'bombing', 'casualties',
  'ceasefire', 'peace treaty', 'nato', 'coup', 'martial law',
  'assassination', 'terrorist', 'terror attack', 'cyber attack', 'hostage', 'evacuation order',
];

// Patterns that indicate non-alert content (lifestyle, entertainment, etc.)
export const ALERT_EXCLUSIONS = [
  'protein', 'couples', 'relationship', 'dating', 'diet', 'fitness',
  'recipe', 'cooking', 'shopping', 'fashion', 'celebrity', 'movie',
  'tv show', 'sports', 'game', 'concert', 'festival', 'wedding',
  'vacation', 'travel tips', 'life hack', 'self-care', 'wellness',
];
