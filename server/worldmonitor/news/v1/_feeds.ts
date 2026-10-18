export interface ServerFeed {
  name: string;
  url: string;
  lang?: string;
  strategicDefault?: boolean;
  /**
   * Positive values start earlier in a cold digest build. This is a fetch
   * scheduling hint only; it does not affect ranking, source tier, or UI
   * default selection.
   */
  deadlinePriority?: number;
  /**
   * A deeper feed for the same publisher, fetched with this one in the full
   * variant and cached under its own URL. Only claim search (/verify,
   * verify_claim) reads it; the digest and panels never see its items.
   */
  depthUrl?: string;
}

export function isServerFeedReachableForLanguage(
  feed: Pick<ServerFeed, 'lang' | 'strategicDefault'>,
  language: string,
): boolean {
  return !feed.lang || feed.lang === language || !!feed.strategicDefault;
}

export function orderServerFeedEntries<T extends {
  feed: Pick<ServerFeed, 'deadlinePriority'>;
}>(entries: readonly T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aPriority = Number.isFinite(a.entry.feed.deadlinePriority)
        ? a.entry.feed.deadlinePriority!
        : 0;
      const bPriority = Number.isFinite(b.entry.feed.deadlinePriority)
        ? b.entry.feed.deadlinePriority!
        : 0;
      return bPriority - aPriority || a.index - b.index;
    })
    .map(({ entry }) => entry);
}

const gn = (q: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

// Locale-aware Google News URL — for feeds tied to a non-English content
// language whose result quality depends on Google News serving the
// matching regional edition. Use this when the bare gn() defaults
// (en-US/US/US:en) would return materially fewer or less relevant items
// for the queried site than the locale-tuned edition.
const gnLocale = (q: string, hl: string, gl: string, ceid: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;

export const VARIANT_FEEDS: Record<string, Record<string, ServerFeed[]>> = {
  full: {
    politics: [
      { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
      { name: 'Guardian World', url: 'https://www.theguardian.com/world/rss' },
      { name: 'AP News', url: gn('site:apnews.com when:1d') },
      { name: 'Reuters World', url: gn('site:reuters.com world when:1d') },
      { name: 'CNN World', url: gn('site:cnn.com world news when:1d') },
      { name: 'Trump - Truth Social', url: 'https://trumpstruth.org/feed' },
      // Major publishers Google News World leads with and no feed carried
      // (2026-10-16 audit). Google News site: queries, like AP and Reuters.
      { name: 'New York Times World', url: gn('site:nytimes.com world when:1d') },
      { name: 'Washington Post World', url: gn('site:washingtonpost.com world when:1d') },
      { name: 'The Economist', url: gn('site:economist.com when:1d') },
      { name: 'The Independent', url: gn('site:independent.co.uk world when:1d') },
    ],
    us: [
      { name: 'Reuters US', url: gn('site:reuters.com US when:1d') },
      { name: 'NPR News', url: 'https://feeds.npr.org/1001/rss.xml' },
      { name: 'PBS NewsHour', url: 'https://www.pbs.org/newshour/feeds/rss/headlines' },
      { name: 'ABC News', url: 'https://feeds.abcnews.com/abcnews/topstories' },
      { name: 'CBS News', url: 'https://www.cbsnews.com/latest/rss/main' },
      { name: 'NBC News', url: 'https://feeds.nbcnews.com/nbcnews/public/news' },
      { name: 'Wall Street Journal', url: 'https://feeds.content.dowjones.io/public/rss/RSSUSnews' },
      { name: 'Politico', url: 'https://rss.politico.com/politics-news.xml' },
      { name: 'The Hill', url: 'https://thehill.com/news/feed' },
      { name: 'Axios', url: 'https://api.axios.com/feed/' },
    { name: 'Fox News', url: 'https://moxie.foxnews.com/google-publisher/us.xml' },
      // Canada + North America key-country pack (#5960)
      { name: 'CBC News', url: 'https://www.cbc.ca/webfeed/rss/rss-world' },
      { name: 'Globe and Mail', url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/canada/?outputType=xml' },
      { name: 'Global News', url: 'https://globalnews.ca/feed/' },
      // Canada depth pack (#6604/#6605). FR sources keep lang:'fr'.
      { name: 'Toronto Star', url: 'https://www.thestar.com/search/?f=rss&t=article&c=news/canada' },
      { name: 'National Post', url: 'https://nationalpost.com/feed/' },
      { name: 'Financial Post', url: 'https://financialpost.com/feed/' },
      { name: 'iPolitics', url: 'https://www.ipolitics.ca/feed' },
      { name: 'The Narwhal', url: 'https://thenarwhal.ca/feed/' },
      { name: 'The Tyee', url: 'https://thetyee.ca/rss2.xml' },
      { name: 'Radio-Canada', url: 'https://ici.radio-canada.ca/info/rss/info/en-continu', lang: 'fr' },
      { name: 'La Presse', url: 'https://www.lapresse.ca/actualites/rss', lang: 'fr' },
      { name: 'Le Devoir', url: 'https://www.ledevoir.com/rss/manchettes.xml', lang: 'fr' },
      { name: 'TVA Nouvelles', url: 'https://www.tvanouvelles.ca/rss.xml', lang: 'fr' },
      { name: 'Vancouver Sun', url: 'https://vancouversun.com/feed/' },
      { name: 'Calgary Herald', url: 'https://calgaryherald.com/feed/' },
      { name: 'Winnipeg Free Press', url: 'https://www.winnipegfreepress.com/feed' },
      { name: 'Ottawa Citizen', url: 'https://ottawacitizen.com/feed/' },
      { name: 'Edmonton Journal', url: 'https://edmontonjournal.com/feed/' },
      { name: "Maclean's", url: 'https://macleans.ca/feed/' },
      { name: 'The Province', url: 'https://theprovince.com/feed/' },
      { name: 'CTV News', url: gnLocale('site:ctvnews.ca when:1d', 'en-CA', 'CA', 'CA:en') },
      { name: 'CP24', url: gnLocale('site:cp24.com when:1d', 'en-CA', 'CA', 'CA:en') },
      { name: 'Montreal Gazette', url: gnLocale('site:montrealgazette.com when:1d', 'en-CA', 'CA', 'CA:en') },
    ],

    europe: [
      { name: 'France 24', url: 'https://www.france24.com/en/rss' },
      { name: 'EuroNews', url: 'https://www.euronews.com/rss?format=xml' },
      { name: 'Le Monde', url: 'https://www.lemonde.fr/en/rss/une.xml' },
      { name: 'DW News', url: 'https://rss.dw.com/xml/rss-en-all' },
      { name: 'Telegraph', url: 'https://www.telegraph.co.uk/rss.xml' },
      { name: 'Interfax EN', url: gn('site:interfax.com when:7d') },
      { name: 'Tagesschau', url: 'https://www.tagesschau.de/xml/rss2/', lang: 'de' },
      { name: 'Handelsblatt', url: 'https://www.handelsblatt.com/contentexport/feed/schlagzeilen', lang: 'de' },
      { name: 'Welt', url: 'https://www.welt.de/feeds/latest.rss', lang: 'de' },
      { name: 'Interfax RU', url: 'https://www.interfax.ru/rss.asp', lang: 'ru' },
      { name: 'ANSA', url: 'https://www.ansa.it/sito/ansait_rss.xml', lang: 'it' },
      { name: 'NOS Nieuws', url: 'https://feeds.nos.nl/nosnieuwsalgemeen', lang: 'nl' },
      { name: 'SVT Nyheter', url: 'https://www.svt.se/nyheter/rss.xml', lang: 'sv' },
      // Arctic / Nordic security pack (#5960). Unscoped so EN digests can include
      // them when enabled (no/da/fi are not UI locales). Yle + Arctic Today are EN.
      { name: 'Yle News', url: 'https://yle.fi/rss/news' },
      { name: 'NRK', url: 'https://www.nrk.no/nyheter/siste.rss' },
      { name: 'Aftenposten', url: 'https://www.aftenposten.no/rss' },
      { name: 'DR Nyheder', url: 'https://www.dr.dk/nyheder/service/feeds/allenyheder' },
      { name: 'Arctic Today', url: gn('site:arctictoday.com when:14d') },
      // Hungarian (HU) — V4 / CEE coverage. Mirrors src/config/feeds.ts europe block.
      { name: 'Telex', url: 'https://telex.hu/rss', lang: 'hu' },
      { name: 'Index.hu', url: 'https://index.hu/24ora/rss', lang: 'hu' },
      { name: 'HVG', url: 'https://hvg.hu/rss', lang: 'hu' },
      { name: '444.hu', url: 'https://444.hu/feed', lang: 'hu' },
      { name: '24.hu', url: 'https://24.hu/feed/', lang: 'hu' },
      { name: 'Híradó', url: gnLocale('site:hirado.hu when:2d', 'hu', 'HU', 'HU:hu'), lang: 'hu' },
      { name: 'Portfolio.hu', url: 'https://portfolio.hu/rss/all.xml', lang: 'hu' },
      { name: 'ATV', url: 'https://www.atv.hu/rss', lang: 'hu' },
      // Czech (CS) — V4 balance with Hungary (#5952). Locale-boosted for cs users.
      { name: 'Seznam Zprávy', url: 'https://www.seznamzpravy.cz/rss', lang: 'cs' },
      // Croatian (HR) — mainstream + investigative; Balkan Insight is English-language (no lang tag)
      { name: 'N1 Croatia', url: 'https://n1info.hr/feed/', lang: 'hr' },
      { name: 'Index.hr', url: 'https://www.index.hr/rss', lang: 'hr' },
      { name: 'Jutarnji list', url: 'https://www.jutarnji.hr/feed', lang: 'hr' },
      { name: 'Balkan Insight', url: 'https://balkaninsight.com/feed/' },
      // Romanian (RO) — Eastern flank (#5952). Locale-boosted for ro users.
      { name: 'Digi24', url: 'https://www.digi24.ro/rss', lang: 'ro' },
      { name: 'HotNews', url: 'https://www.hotnews.ro/rss', lang: 'ro' },
      { name: 'G4Media', url: 'https://www.g4media.ro/feed/', lang: 'ro' },
      // Bulgarian (BG) — Black Sea flank (#5952). Locale-boosted for bg users.
      { name: 'Dnevnik', url: 'https://www.dnevnik.bg/rss/', lang: 'bg' },
      // Ukraine war frontline for EN digests (#5949). Names must match client
      // DEFAULT_ENABLED_SOURCES.europe. Ordinary non-en `lang` tags are filtered
      // from EN digests; strategic defaults explicitly bypass that filter.
      { name: 'Kyiv Independent', url: gn('site:kyivindependent.com when:3d') },
      // Ukraine depth pack (#5951) — local institutional + independent sources
      // (server keeps EN URLs; client multi-URL adds uk variants for UI locale).
      { name: 'Ukrinform', url: gn('site:ukrinform.net when:3d') },
      { name: 'Suspilne', url: gn('site:suspilne.media when:2d') },
      { name: 'Ukrainska Pravda EN', url: gn('site:euromaidanpress.com when:2d') },
      { name: 'NV EN', url: gn('site:english.nv.ua when:2d') },
      { name: 'Hromadske EN', url: gn('site:hromadske.ua when:3d') },
      // Ukrainian (uk) native pack for uk digests (#5959)
      { name: 'Ukrainska Pravda', url: gnLocale('site:pravda.com.ua when:2d', 'uk', 'UA', 'UA:uk'), lang: 'uk' },
      { name: 'Hromadske', url: gnLocale('site:hromadske.ua when:3d', 'uk', 'UA', 'UA:uk'), lang: 'uk' },
      { name: 'Bihus.Info', url: gnLocale('site:bihus.info when:7d', 'uk', 'UA', 'UA:uk'), lang: 'uk' },
      { name: 'Slidstvo.Info', url: gnLocale('site:slidstvo.info when:7d', 'uk', 'UA', 'UA:uk'), lang: 'uk' },
      { name: 'ZN.UA', url: gnLocale('site:zn.ua when:3d', 'uk', 'UA', 'UA:uk'), lang: 'uk' },
      // Google News returned HTTP 200 with no items for these site queries;
      // use the outlets' live native RSS feeds for the EN digest path too.
      { name: 'TVN24', url: 'https://tvn24.pl/swiat.xml' },
      { name: 'Rzeczpospolita', url: 'https://www.rp.pl/rss_main' },
      { name: 'Meduza', url: 'https://meduza.io/rss/en/all' },
      { name: 'Moscow Times', url: 'https://www.themoscowtimes.com/rss/news' },
      // Caucasus (#5953) — secondary Russian periphery / BRI hinterland
      { name: 'Civil.ge', url: 'https://civil.ge/feed/' },
      { name: 'OC Media', url: 'https://oc-media.org/feed/' },
      { name: 'JAMnews', url: 'https://jam-news.net/feed/' },
      // Risk-tagged state wires
      { name: 'Azertag', url: gn('site:azertag.az when:3d') },
      { name: 'Armenpress', url: gn('site:armenpress.am when:3d') },
      // Belarus / Moldova (#5953)
      { name: 'Zerkalo', url: gn('site:zerkalo.io when:2d') },
      // NewsMaker removed its English feed; retain the live Russian feed only
      // for Russian-language digests instead of serving a 404 to EN.
      { name: 'NewsMaker', url: 'https://newsmaker.md/feed', lang: 'ru' },
      { name: 'Ziarul de Gardă', url: 'https://www.zdg.md/feed/', lang: 'ro' },
      // Baltic states — Eastern flank (#5952). English-language, no lang tag,
      // so EN digests include them.
      { name: 'ERR News', url: 'https://news.err.ee/rss' },
      { name: 'LRT English', url: 'https://www.lrt.lt/en/news-in-english?rss' },
      { name: 'LSM English', url: 'https://eng.lsm.lv/rss/' },
      // Daily Sabah (EN) — Turkey EN path improvement (#5952).
      { name: 'Daily Sabah', url: 'https://www.dailysabah.com/rss/home-page' },
      // Strategic local-depth sources (#6000) — reachable in every digest
      // language and protected from client-side source filtering.
      { name: 'Hurriyet', url: 'https://www.hurriyet.com.tr/rss/anasayfa', lang: 'tr', strategicDefault: true },
      { name: 'Polsat News', url: 'https://www.polsatnews.pl/rss/wszystkie.xml', lang: 'pl', strategicDefault: true },
      // Polish depth — catalog opt-in, locale-boosted for `pl`. PAP/Onet native
      // RSS is gone; OKO.press still has a live publisher feed.
      { name: 'PAP', url: gnLocale('site:pap.pl when:2d', 'pl', 'PL', 'PL:pl'), lang: 'pl' },
      { name: 'Gazeta Wyborcza', url: gnLocale('site:wyborcza.pl when:2d', 'pl', 'PL', 'PL:pl'), lang: 'pl' },
      { name: 'Polityka', url: gnLocale('site:polityka.pl when:2d', 'pl', 'PL', 'PL:pl'), lang: 'pl' },
      { name: 'Onet', url: gnLocale('site:wiadomosci.onet.pl when:2d', 'pl', 'PL', 'PL:pl'), lang: 'pl' },
      { name: 'OKO.press', url: 'https://oko.press/feed', lang: 'pl' },
      { name: 'TVP Info', url: gnLocale('site:tvp.info when:2d', 'pl', 'PL', 'PL:pl'), lang: 'pl' },
      { name: 'Kathimerini', url: gnLocale('site:kathimerini.gr when:2d', 'el', 'GR', 'GR:el'), lang: 'el', strategicDefault: true },
      { name: 'Naftemporiki', url: 'https://www.naftemporiki.gr/feed/', lang: 'el' },
      { name: 'in.gr', url: 'https://www.in.gr/feed/', lang: 'el' },
      { name: 'iefimerida', url: 'https://www.iefimerida.gr/rss.xml', lang: 'el' },
      { name: 'Proto Thema', url: gnLocale('site:protothema.gr when:2d', 'el', 'GR', 'GR:el'), lang: 'el' },
      { name: 'ERT', url: gnLocale('site:ert.gr when:2d', 'el', 'GR', 'GR:el'), lang: 'el' },
      { name: 'AMNA', url: gnLocale('site:amna.gr when:2d', 'el', 'GR', 'GR:el'), lang: 'el' },
      { name: 'Ta Nea', url: 'https://www.tanea.gr/feed/', lang: 'el' },
      { name: 'Liberal GR', url: gnLocale('site:liberal.gr when:2d', 'el', 'GR', 'GR:el'), lang: 'el' },
      { name: 'CNN Greece', url: gnLocale('site:cnn.gr when:2d', 'el', 'GR', 'GR:el'), lang: 'el' },
      { name: 'Sky News', url: gn('site:news.sky.com when:1d') },
      // UK domestic and Northern Ireland desks (2026-10-17 audit): stories Google
      // News World carried that BBC World leaves out.
      { name: 'BBC UK', url: 'https://feeds.bbci.co.uk/news/uk/rss.xml' },
      { name: 'BBC Northern Ireland', url: 'https://feeds.bbci.co.uk/news/northern_ireland/rss.xml' },
    ],
    middleeast: [
      { name: 'BBC Middle East', url: 'https://feeds.bbci.co.uk/news/world/middle_east/rss.xml' },
      // The native feed holds 25 entries, about ten hours; the Google News
      // search holds 100 over two days (2026-10-17 /verify audit).
      { name: 'Al Jazeera',
        url: 'https://www.aljazeera.com/xml/rss/all.xml',
        depthUrl: gn('site:aljazeera.com when:2d') },
      // Theater coverage preset (#5956) - English regional sources.
      { name: 'Al Arabiya', url: gn('site:english.alarabiya.net when:2d') },
      { name: 'Guardian ME', url: 'https://www.theguardian.com/world/middleeast/rss' },
      { name: 'BBC Persian', url: 'https://feeds.bbci.co.uk/persian/rss.xml', lang: 'fa' },
      { name: 'Iran International', url: gn('site:iranintl.com when:2d') },
      { name: 'Haaretz', url: gn('site:haaretz.com when:7d') },
      { name: 'Jerusalem Post', url: 'https://www.jpost.com/rss/rssfeedsheadlines.aspx' },
      { name: 'Ynetnews', url: 'https://www.ynetnews.com/Integration/StoryRss3089.xml' },
      { name: 'Arab News', url: gn('site:arabnews.com when:7d') },
      { name: 'The National', url: 'https://www.thenationalnews.com/arc/outboundfeeds/rss/?outputType=xml' },
      { name: 'Oman Observer', url: 'https://www.omanobserver.om/rssFeed/1' },
      { name: 'Asharq Business', url: 'https://asharqbusiness.com/rss.xml' },
      { name: 'Rudaw', url: gn('site:rudaw.net when:7d') },
      { name: 'Yemen Online', url: gn('site:yemenonline.info when:14d') },
      { name: "Sana'a Center", url: 'https://sanaacenter.org/feed/' },
      { name: 'Syria Direct', url: 'https://syriadirect.org/feed/' },
      { name: 'Enab Baladi English', url: gn('site:english.enabbaladi.net when:14d') },
      { name: '+972 Magazine', url: 'https://www.972mag.com/feed/' },
      { name: 'WAFA English', url: gn('site:english.wafa.ps when:7d') },
      { name: 'Naharnet Lebanon', url: 'https://www.naharnet.com/tags/lebanon/en/feed.atom' },
      { name: "L'Orient Today", url: gn('site:lorientlejour.com Lebanon when:7d') },
      { name: 'Annahar', url: gnLocale('site:annahar.com/lebanon when:7d', 'ar', 'LB', 'LB:ar'), lang: 'ar', strategicDefault: true },
      { name: 'Libya Herald', url: 'https://libyaherald.com/rss.xml' },
      { name: 'Egypt Independent', url: 'https://www.egyptindependent.com/feed/' },
      { name: 'Mada Masr', url: gn('site:madamasr.com when:30d') },
      // Direct Times of Israel RSS returns 403 to cloud IPs; Google News does not.
      { name: 'Times of Israel', url: gn('site:timesofisrael.com when:1d') },
      { name: 'Middle East Eye', url: gn('site:middleeasteye.net when:1d') },
    ],
    tech: [
      { name: 'Hacker News', url: 'https://hnrss.org/frontpage' },
      { name: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/technology-lab' },
      { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
      { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/feed/' },
      { name: 'Wired', url: 'https://www.wired.com/feed/rss' },
    ],
    ai: [
      { name: 'AI News', url: gn('(OpenAI OR Anthropic OR Google AI OR "large language model" OR ChatGPT) when:2d') },
      { name: 'VentureBeat AI', url: 'https://venturebeat.com/category/ai/feed/' },
      { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
      { name: 'MIT Tech Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed' },
      { name: 'ArXiv AI', url: 'https://export.arxiv.org/rss/cs.AI' },
    ],
    finance: [
      { name: 'CNBC', url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
      { name: 'MarketWatch', url: gn('site:marketwatch.com markets when:1d') },
      { name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex' },
      { name: 'Financial Times', url: 'https://www.ft.com/rss/home' },
      { name: 'Reuters Business', url: gn('site:reuters.com business markets when:1d') },
      { name: 'Fox Business', url: 'https://moxie.foxbusiness.com/google-publisher/latest.xml' },
      { name: 'Business Insider', url: 'https://www.businessinsider.com/rss' },
      { name: 'GlobeNewswire', url: 'https://www.globenewswire.com/RssFeed/subjectcode/22/feedTitle/GlobeNewswire' },
      { name: 'Business Wire', url: 'https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeGVtRWA==' },
      { name: 'PR Newswire', url: gn('site:prnewswire.com when:1d') },
      { name: 'Chainwire', url: 'https://chainwire.org/feed/' },
      { name: 'Coinbase Blog', url: gn('site:coinbase.com/blog when:7d') },
      { name: 'Binance Announcements', url: gn('site:binance.com/en/support/announcement when:3d') },
      { name: 'Jin10', url: gnLocale('site:jin10.com when:1d', 'zh-CN', 'CN', 'CN:zh-Hans'), lang: 'zh' },
    ],
    gov: [
      // White House: two direct WordPress RSS feeds. Replaces
      // gn('site:whitehouse.gov ...') so the publisher's pubDate is
      // authoritative and old re-indexed pages can't slip through.
      // briefings-statements covers daily press releases; presidential-actions
      // covers EOs / proclamations / nominations.
      { name: 'White House', url: 'https://www.whitehouse.gov/briefings-statements/feed/' },
      { name: 'White House Actions', url: 'https://www.whitehouse.gov/presidential-actions/feed/' },
      // State Dept, Treasury, DOJ: no working public RSS feed at any
      // verified path (probed 2026-04-26). Federal Register fallback is
      // bot-blocked. Stuck on Google News until a per-agency HTML scraper
      // or destination-pubDate cross-check ships. The READ-time freshness
      // floor in seed-digest-notifications.mjs::buildDigest mitigates the
      // residue gap; PR-3417's when:1d gates new ingests by Google's
      // honest-relayed source pubDate. See:
      //   skill: ingest-gate-tightening-leaves-residue-in-read-path
      { name: 'State Dept', url: gn('(site:state.gov OR "State Department") when:1d') },
      // Pentagon: direct war.gov RSS (post-rebrand). Replaces
      // gn('(site:defense.gov OR Pentagon) when:1d') for the same reason
      // as White House — the publisher's pubDate is authoritative, no
      // re-indexing surprises.
      { name: 'Pentagon', url: 'https://www.war.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945' },
      { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
      { name: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss' },
      { name: 'U.S. Trade Representative', url: 'https://ustr.gov/rss.xml' },
      { name: 'UN News', url: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml' },
      { name: 'CISA', url: 'https://www.cisa.gov/cybersecurity-advisories/all.xml' },
      { name: 'Treasury', url: gn('site:treasury.gov when:1d') },
      { name: 'DOJ', url: gn('site:justice.gov when:1d') },
    ],
    africa: [
      { name: 'BBC Africa', url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml' },
      // Keep regional desks early in the category-fair fetch schedule (#7748).
      { name: 'Guardian Africa', url: 'https://www.theguardian.com/world/africa/rss' },
      { name: 'France 24 Africa', url: 'https://www.france24.com/en/africa/rss' },
      // Theater coverage preset (#5956) - Sahel and West Africa sources.
      { name: 'Africa News', url: gn('(Africa OR Nigeria OR Kenya OR "South Africa" OR Ethiopia) when:2d') },
      { name: 'Sahel Crisis', url: gn('(Sahel OR Mali OR Niger OR "Burkina Faso" OR Wagner) when:3d') },
      { name: 'News24', url: 'https://feeds.news24.com/articles/news24/TopStories/rss' },
      { name: 'Africanews', url: 'https://www.africanews.com/feed/' },
      { name: 'Jeune Afrique', url: 'https://www.jeuneafrique.com/feed/', lang: 'fr', strategicDefault: true },
      { name: 'Premium Times', url: 'https://www.premiumtimesng.com/feed' },
      { name: 'Vanguard Nigeria', url: 'https://www.vanguardngr.com/feed/' },
      { name: 'Channels TV', url: 'https://www.channelstv.com/feed/' },
      { name: 'Daily Trust', url: 'https://dailytrust.com/feed/' },
      { name: 'ThisDay', url: 'https://www.thisdaylive.com/feed' },
      // Horn of Africa
      { name: 'Radio Tamazuj', url: 'https://www.radiotamazuj.org/en/feed' },
      { name: 'The Reporter Ethiopia', url: 'https://www.thereporterethiopia.com/feed/' },
      { name: 'Ethiopia Insight', url: 'https://www.ethiopia-insight.com/feed/' },
      { name: 'Dabanga Sudan', url: 'https://www.dabangasudan.org/en/feed' },
      { name: 'Hiiraan Online', url: gn('site:hiiraan.com when:7d') },
      // DRC / Great Lakes
      { name: 'Actualite.cd', url: 'https://actualite.cd/feed', lang: 'fr' },
      { name: 'Radio Okapi', url: 'https://www.radiookapi.net/rss.xml', lang: 'fr' },
      // West Africa beyond Nigeria
      { name: 'MyJoyOnline', url: 'https://www.myjoyonline.com/feed/' },
      { name: 'Citi Newsroom', url: gn('site:citinewsroom.com when:7d') },
      { name: 'Le Quotidien', url: 'https://lequotidien.sn/feed/', lang: 'fr' },
      // Pan-African
      { name: 'RFI Afrique', url: 'https://www.rfi.fr/en/africa/rss' },
      { name: 'Studio Tamani', url: 'https://www.studiotamani.org/feed/', lang: 'fr', strategicDefault: true },
      { name: 'leFaso.net', url: 'https://lefaso.net/spip.php?page=backend', lang: 'fr', strategicDefault: true },
      { name: 'ActuNiger', url: gnLocale('site:actuniger.com Niger when:7d', 'fr', 'FR', 'FR:fr'), lang: 'fr', strategicDefault: true },
      { name: 'Aïr Info', url: 'https://airinfoagadez.com/feed/', lang: 'fr' },
      { name: 'Daily Nation', url: 'https://nation.africa/kenya/rss.xml' },
      { name: 'The Guardian Post', url: gn('site:theguardianpostcameroon.com when:30d') },
      { name: 'Tchadinfos', url: 'https://tchadinfos.com/feed/', lang: 'fr' },
      { name: 'Alwihda Info', url: 'https://www.alwihdainfo.com/rss/', lang: 'fr' },
      { name: 'Radio Ndeke Luka', url: 'https://www.radiondekeluka.org/feed/', lang: 'fr' },
    ],
    latam: [
      { name: 'BBC Latin America', url: 'https://feeds.bbci.co.uk/news/world/latin_america/rss.xml' },
      { name: 'Guardian Americas', url: 'https://www.theguardian.com/world/americas/rss' },
      { name: 'Guardian Caribbean', url: 'https://www.theguardian.com/world/caribbean/rss' },
      { name: 'France 24 LatAm', url: 'https://www.france24.com/en/americas/rss' },
      { name: 'Mexico News Daily', url: 'https://mexiconewsdaily.com/feed/' },
      { name: 'Primicias', url: 'https://www.primicias.ec/feed/', lang: 'es' },
      { name: 'Infobae Americas', url: 'https://www.infobae.com/arc/outboundfeeds/rss/', lang: 'es' },
      { name: 'El Universo', url: 'https://www.eluniverso.com/arc/outboundfeeds/rss/category/noticias/?outputType=xml', lang: 'es' },
      { name: 'Clarín', url: 'https://www.clarin.com/rss/lo-ultimo/', lang: 'es' },
      { name: 'InSight Crime', url: 'https://insightcrime.org/feed/' },
      { name: 'HaitiLibre English', url: 'https://www.haitilibre.com/rss-flash-en.php' },
      { name: 'AyiboPost', url: gnLocale('site:ayibopost.com Haiti when:14d', 'fr', 'FR', 'FR:fr'), lang: 'fr' },
      { name: 'Caracas Chronicles', url: 'https://www.caracaschronicles.com/feed/' },
      { name: 'Efecto Cocuyo', url: 'https://efectococuyo.com/feed/', lang: 'es' },
      { name: 'Havana Times', url: 'https://havanatimes.org/feed/' },
      { name: '14ymedio', url: 'https://www.14ymedio.com/rss/', lang: 'es' },
    ],
    asia: [
      { name: 'BBC Asia', url: 'https://feeds.bbci.co.uk/news/world/asia/rss.xml' },
      { name: 'Guardian Pacific', url: 'https://www.theguardian.com/world/pacific-islands/rss' },
      { name: 'France 24 Asia Pacific', url: 'https://www.france24.com/en/asia-pacific/rss' },
      { name: 'The Diplomat', url: 'https://thediplomat.com/feed/' },
      // Theater coverage preset (#5956) - Indo-Pacific sources.
      { name: 'Reuters Asia', url: gn('site:reuters.com (China OR Japan OR Taiwan OR Korea) when:3d') },
      { name: 'Reuters India', url: gn('site:reuters.com India when:3d') },
      { name: 'Japan Today', url: 'https://japantoday.com/feed/atom' },
      { name: 'Nikkei Asia', url: gn('site:asia.nikkei.com when:3d') },
      { name: 'CNA', url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml' },
      { name: 'NDTV', url: 'https://feeds.feedburner.com/ndtvnews-top-stories' },
      { name: 'South China Morning Post', url: gn('site:scmp.com when:2d') },
      { name: 'The Hindu', url: 'https://www.thehindu.com/feeder/default.rss' },
      { name: 'Asia News', url: gn('site:asianews.it when:3d') },
      // China coverage feeds must start before the full digest's later
      // batches. Otherwise a slow cold build can report timeout for an
      // otherwise healthy source while the seed transport remains fresh.
      { name: 'Xinhua', url: gn('site:xinhuanet.com OR Xinhua when:1d'), deadlinePriority: 100 },
      { name: 'Asahi Shimbun', url: 'https://www.asahi.com/rss/asahi/newsheadlines.rdf', lang: 'ja', strategicDefault: true },
      { name: 'MIIT (China)', url: 'https://api.worldmonitor.app/api/miit-news', lang: 'zh', strategicDefault: true, deadlinePriority: 100 },
      { name: 'MOFCOM (China)', url: gnLocale('site:mofcom.gov.cn when:7d', 'zh-CN', 'CN', 'CN:zh-Hans'), lang: 'zh', strategicDefault: true, deadlinePriority: 100 },
      { name: 'Bangkok Post', url: gn('site:bangkokpost.com when:1d'), lang: 'th', strategicDefault: true },
      { name: 'VnExpress', url: 'https://vnexpress.net/rss/tin-moi-nhat.rss', lang: 'vi', strategicDefault: true },
      { name: 'Yonhap News', url: 'https://www.yonhapnewstv.co.kr/browse/feed/', lang: 'ko', strategicDefault: true },
      // Hindi (HI) — mainstream national coverage boosted for Hindi locale users
      { name: 'BBC Hindi', url: 'https://feeds.bbci.co.uk/hindi/rss.xml', lang: 'hi' },
      { name: 'Aaj Tak', url: 'https://www.aajtak.in/rssfeeds/?id=home', lang: 'hi' },
      { name: 'NDTV India', url: 'https://feeds.feedburner.com/ndtvkhabar-latest', lang: 'hi' },
      { name: 'Amar Ujala', url: 'https://www.amarujala.com/rss/national.xml', lang: 'hi' },
// Central Asia (#5953) — Russia rear area, China BRI, sanctions leakage
      { name: 'Eurasianet', url: 'https://eurasianet.org/rss' },
      { name: 'RFE/RL Central Asia', url: gn('site:rferl.org Central+Asia when:3d') },
      { name: 'The Astana Times', url: 'https://astanatimes.com/feed/' },
      { name: 'The Times of Central Asia', url: 'https://timesca.com/feed/' },
      // Taiwan (#5954)
      { name: 'Focus Taiwan', url: gn('site:focustaiwan.tw when:3d') },
      { name: 'Taipei Times', url: gn('site:taipeitimes.com when:3d') },
      { name: 'Taiwan News', url: gn('site:taiwannews.com.tw when:3d') },
      // Pakistan (#5954)
      { name: 'Dawn', url: 'https://www.dawn.com/feeds/home/' },
      { name: 'Geo News', url: gn('site:geo.tv when:2d') },
      // SE Asia security (#5954)
      { name: 'Jakarta Post', url: gn('site:thejakartapost.com when:3d') },
      { name: 'Rappler', url: 'https://www.rappler.com/feed/' },
      { name: 'The Star (Malaysia)', url: gn('site:thestar.com.my when:3d') },
      { name: 'Irrawaddy', url: 'https://www.irrawaddy.com/feed/' },
      { name: 'Island Times (Palau)', url: 'https://islandtimes.org/feed/' },
      { name: 'Amu TV', url: 'https://amu.tv/feed/' },
      { name: 'Pajhwok Afghan News', url: gn('site:pajhwok.com Afghanistan when:7d') },
      { name: 'The Daily Star', url: gn('site:thedailystar.net when:14d') },
      { name: 'Dhaka Tribune', url: gn('site:dhakatribune.com when:14d') },
      { name: 'Times of India', url: 'https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms', lang: 'en' },
      { name: 'Japan Times', url: gn('site:japantimes.co.jp when:1d') },
    ],
    energy: [
      { name: 'Oil & Gas', url: gn('(oil price OR OPEC OR "natural gas" OR pipeline OR LNG) when:2d') },
      { name: 'Reuters Energy', url: gn('site:reuters.com energy when:2d') },
      { name: 'Nuclear Energy', url: gn('("nuclear energy" OR "nuclear power" OR "nuclear reactor") when:3d') },
    ],
    thinktanks: [
      { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/' },
      { name: 'Atlantic Council', url: 'https://www.atlanticcouncil.org/feed/' },
      { name: 'Foreign Affairs', url: 'https://www.foreignaffairs.com/rss.xml' },
      { name: 'War on the Rocks', url: 'https://warontherocks.com/feed/' },
      { name: 'CSIS', url: 'https://www.csis.org/rss.xml' },
      // ISW — Institute for the Study of War, daily Ukraine frontline operational assessments
      { name: 'ISW', url: gn('site:understandingwar.org when:2d') },
    ],
    crisis: [
      { name: 'CrisisWatch', url: 'https://www.crisisgroup.org/rss' },
      { name: 'IAEA', url: 'https://www.iaea.org/feeds/topnews' },
      { name: 'WHO', url: 'https://www.who.int/rss-feeds/news-english.xml' },
    ],
    layoffs: [
      { name: 'Layoffs.fyi', url: gn('tech+company+layoffs+announced when:3d') },
      { name: 'TechCrunch Layoffs', url: 'https://techcrunch.com/tag/layoffs/feed/' },
      { name: 'Layoffs News', url: gn('(layoffs OR "job cuts" OR "workforce reduction") when:3d') },
    ],
    // Science panel (2026-10-17 Google News World audit).
    science: [
      { name: 'Reuters Science', url: gn('site:reuters.com science when:2d') },
      { name: 'Nature News', url: 'https://www.nature.com/nature.rss' },
      { name: 'BBC Science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml' },
      { name: 'Guardian Science', url: 'https://www.theguardian.com/science/rss' },
      { name: 'ScienceDaily', url: 'https://www.sciencedaily.com/rss/all.xml' },
    ],
  },


  // NucMonitor — mirrors NUCLEAR_FEEDS in src/config/feeds.ts (guarded by
  // tests/news-feed-key-parity.test.mts).
  nuclear: {
    'live-news': [
      // Faster-churn copies of the regulatory/industry feeds (distinct URLs:
      // the parsed RSS cache is keyed by variant + URL and retains names).
      { name: 'World Nuclear News', url: gn('site:world-nuclear-news.org when:1d') },
      { name: 'ANS Nuclear Newswire', url: gn('site:ans.org nuclear when:1d') },
      { name: 'NRC News', url: gn('site:nrc.gov when:2d') },
      { name: 'Reuters Nuclear', url: gn('site:reuters.com (nuclear OR reactor OR uranium OR NRC) when:1d') },
      { name: 'AP Nuclear', url: gn('site:apnews.com (nuclear plant OR reactor OR "nuclear regulatory") when:2d') },
      { name: 'US Nuclear Plants', url: gn('("nuclear plant" OR "nuclear power plant" OR "nuclear station") (outage OR refueling OR restart OR shutdown OR NRC OR license) when:1d') },
      { name: 'Utility Dive Nuclear', url: gn('site:utilitydive.com nuclear when:3d') },
      { name: 'POWER Magazine Nuclear', url: gn('site:powermag.com nuclear when:3d') },
    ],
    'nuclear-regulatory': [
      { name: 'NRC News', url: gn('site:nrc.gov when:7d') },
      { name: 'NRC Event Reports', url: gn('site:nrc.gov ("event notification" OR "event report" OR "inspection report" OR "confirmatory action") when:7d') },
      { name: 'DOE Nuclear Energy', url: gn('site:energy.gov (nuclear OR reactor OR uranium OR HALEU) when:7d') },
      { name: 'NNSA', url: gn('site:energy.gov/nnsa when:7d') },
      { name: 'DOE Environmental Management', url: gn('site:energy.gov/em when:7d') },
      { name: 'EIA Nuclear', url: gn('site:eia.gov nuclear when:7d') },
      { name: 'IAEA News', url: gn('site:iaea.org when:3d') },
      { name: 'EPA RadNet', url: gn('site:epa.gov (radnet OR radiation OR radiological) when:14d') },
      { name: 'FEMA & Emergency Management', url: gn('site:fema.gov (nuclear OR radiological) when:14d') },
    ],
    'nuclear-industry': [
      { name: 'World Nuclear News', url: gn('site:world-nuclear-news.org when:2d') },
      { name: 'ANS Nuclear Newswire', url: gn('site:ans.org nuclear when:3d') },
      { name: 'NEI', url: gn('site:nei.org when:7d') },
      { name: 'Exchange Monitor', url: gn('site:exchangemonitor.com when:3d') },
      { name: 'Nuclear Engineering International', url: gn('site:neimagazine.com when:3d') },
      { name: 'SMR & Advanced Reactors', url: gn('("small modular reactor" OR SMR OR "advanced reactor" OR microreactor OR TerraPower OR "X-energy" OR NuScale OR Kairos OR Oklo) when:2d') },
      { name: 'Uranium & Fuel Cycle', url: gn('(uranium OR enrichment OR HALEU OR Centrus OR Urenco OR "fuel fabrication" OR "spent fuel") when:2d') },
      { name: 'Nuclear & Data Centers', url: gn('(nuclear AND ("data center" OR hyperscaler OR Microsoft OR Amazon OR Google OR Meta) AND (power OR reactor OR PPA)) when:3d') },
    ],
    'nuclear-policy': [
      { name: 'Nuclear Policy', url: gn('("nuclear energy" OR "nuclear power") (Congress OR Senate OR "White House" OR "executive order" OR legislation OR ADVANCE Act) when:3d') },
      { name: 'Spent Fuel & Waste', url: gn('("spent nuclear fuel" OR "nuclear waste" OR "Yucca Mountain" OR "interim storage" OR WIPP OR ISFSI) when:7d') },
      { name: 'Nuclear Security & Nonproliferation', url: gn('(nonproliferation OR "nuclear security" OR "nuclear safeguards" OR "nuclear material") when:3d') },
      { name: 'Bulletin of Atomic Scientists', url: gn('site:thebulletin.org when:7d') },
      { name: 'Union of Concerned Scientists', url: gn('site:ucs.org nuclear when:14d') },
      { name: 'State Radiation Programs', url: gn('("radiation control" OR "radiological emergency" OR "emergency planning zone" OR "potassium iodide") nuclear when:7d') },
    ],
    energy: [
      { name: 'EIA Press Room', url: 'https://www.eia.gov/rss/press_room.xml' },
      { name: 'Natural Gas & LNG', url: gn('("natural gas" OR LNG OR "gas price" OR "Henry Hub") when:1d') },
      { name: 'US Grid & Reliability', url: gn('(NERC OR PJM OR ERCOT OR MISO OR "grid reliability" OR "capacity auction") when:2d') },
      { name: 'Energy Intel', url: gn('(energy commodities OR "energy market" OR "energy prices" OR "energy security") when:2d') },
    ],
  },
};

export const INTEL_SOURCES: ServerFeed[] = [
  { name: 'Defense One', url: 'https://www.defenseone.com/rss/all/' },
  { name: 'The War Zone', url: 'https://www.twz.com/feed' },
  { name: 'Defense News', url: 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'Breaking Defense', url: 'https://breakingdefense.com/feed/' },
  { name: 'Military Times', url: 'https://www.militarytimes.com/arc/outboundfeeds/rss/?outputType=xml' },
  { name: 'Task & Purpose', url: 'https://taskandpurpose.com/feed/' },
  { name: 'USNI News', url: 'https://news.google.com/rss/search?q=site:news.usni.org+when:3d&hl=en-US&gl=US&ceid=US:en' },
  { name: 'gCaptain', url: 'https://gcaptain.com/feed/' },
  { name: 'Oryx OSINT', url: 'https://www.oryxspioenkop.com/feeds/posts/default?alt=rss' },
  { name: 'Foreign Policy', url: 'https://foreignpolicy.com/feed/' },
  { name: 'Foreign Affairs', url: 'https://www.foreignaffairs.com/rss.xml' },
  { name: 'Atlantic Council', url: 'https://www.atlanticcouncil.org/feed/' },
  { name: 'Bellingcat', url: gn('site:bellingcat.com when:7d') },
  { name: 'Krebs Security', url: 'https://krebsonsecurity.com/feed/' },
  { name: 'Arms Control Assn', url: gn('site:armscontrol.org when:7d') },
  { name: 'Bulletin of Atomic Scientists', url: gn('site:thebulletin.org when:7d') },
  { name: 'FAO News', url: 'https://www.fao.org/feeds/fao-newsroom-rss' },
  { name: 'OCCRP', url: 'https://www.occrp.org/en/feed' },
  { name: 'DFRLab', url: 'https://dfrlab.org/feed/' },
  { name: 'Lighthouse Reports', url: 'https://www.lighthousereports.com/feed/' },
  { name: 'The Sentry', url: 'https://thesentry.org/feed/' },
  { name: 'GITOC', url: 'https://globalinitiative.net/feed/' },
  { name: 'VSquare', url: 'https://vsquare.org/feed/' },
  { name: 'Correctiv', url: 'https://correctiv.org/feed/' },
];
