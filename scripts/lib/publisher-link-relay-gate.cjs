'use strict';

// Publisher-link gate for relay-emitted RSS events (#8398).
//
// An attacker-controlled RSS item reaches every subscribed user's
// notifications with no account: the platform ingests the item's link
// verbatim, a Railway cron scans it, and the relay fans matching items out
// to every user's rule. Validating at /api/notify does not cover this path
// (relay-emitted events never pass through that endpoint), so the gate also
// lives at each relay-emission site.
//
// Policy: a story link must resolve to the publisher the item claims. The
// link's registrable host must equal the item's feed-label family domain(s)
// or a subdomain of one. The feed URL host (the strongest signal — the
// publisher domain as registered) is composed by the digest-side caller
// (server/worldmonitor/news/v1/list-feed-digest.ts, which knows the feed);
// the relay only ever sees item-scoped fields, so it gates on the curated
// family table alone and fails closed (blank link) when the family names no
// domains.
//
// Self-contained on purpose: ais-relay.cjs boots on require, so anything it
// needs must be a dependency-free CJS module importable without side
// effects (same reason digest-stale-gate.cjs lives here). Pure logic is in
// shared/publisher-link-gate.js; this file only wires the curated domain
// table. The family table itself is duplicated from
// shared/publisher-families.js PUBLISHER_FAMILY_DOMAINS — that module is ESM
// (`export`), which the relay's CJS `requireShared` cannot load. The subset
// below covers the families whose feeds emit relay alerts; an unlisted
// family fails closed (blank link, title still alerts).
//
// Keep in sync with PUBLISHER_FAMILY_DOMAINS in shared/publisher-families.js
// (guarded by tests/publisher-link-relay-gate.test.mjs).

const PUBLISHER_LINK_DOMAINS = {
  // #8398: Dow Jones delivery host (feeds.content.dowjones.io) serves the
  // domain-only 'wsj' family in shared/publisher-families.js.
  // feed, but item links point at the publisher apex (wsj.com). Mirrors the
  'a16z': ['a16z.com'],
  'ap-news': ['apnews.com'],
  'bbc': ['bbc.com', 'bbc.co.uk'],
  'brookings': ['brookings.edu'],
  'chatham-house': ['chathamhouse.org'],
  'csis': ['csis.org'],
  'doe': ['energy.gov'],
  'dw': ['dw.com'],
  'eia': ['eia.gov'],
  'fao': ['fao.org'],
  'fema': ['fema.gov'],
  'france-24': ['france24.com'],
  'good-news-network': ['goodnewsnetwork.org'],
  'guardian': ['theguardian.com'],
  'hromadske': ['hromadske.ua'],
  'iaea': ['iaea.org'],
  'interfax': ['interfax.com', 'interfax.ru'],
  'miit': ['miit.gov.cn'],
  'ndtv': ['ndtv.com'],
  'new-york-times': ['nytimes.com'],
  'nikkei': ['nikkei.com'],
  'nrc': ['nrc.gov'],
  'politico': ['politico.com', 'politico.eu'],
  'reuters': ['reuters.com'],
  'rt': ['rt.com', 'rt-english.com'],
  'sightline-media': ['defensenews.com', 'militarytimes.com'],
  'the-verge': ['theverge.com'],
  'white-house': ['whitehouse.gov'],
  'wsj': ['wsj.com'],

};

function normalizeLinkHostname(hostname) {
  if (typeof hostname !== 'string') return '';
  const cleaned = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (cleaned.length === 0 || !cleaned.includes('.')) return '';
  return cleaned.replace(/^www\./, '');
}

function linkHostname(link) {
  if (typeof link !== 'string') return '';
  const value = link.trim();
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    return normalizeLinkHostname(new URL(value).hostname);
  } catch {
    return '';
  }
}

function isPublisherLink(link, expectedHosts) {
  const host = linkHostname(link);
  if (!host) return false;
  if (expectedHosts == null || typeof expectedHosts[Symbol.iterator] !== 'function') return false;
  for (const raw of expectedHosts) {
    const expected = normalizeLinkHostname(raw);
    if (!expected) continue;
    if (host === expected || host.endsWith(`.${expected}`)) return true;
  }
  return false;
}

// Curated label -> family id, mirrored from the ESM-only
// shared/publisher-families.js PUBLISHER_FAMILY_DATA (same sync rule as the
// domain table above — guarded by tests/publisher-link-relay-gate.test.mjs).
// Labels are matched exact then case-insensitive; anything else resolves to
// the `label:<name>` singleton namespace, which names no domains and
// therefore blanks at the gate (fail-closed).
const PUBLISHER_LINK_LABELS = {
  // #8398: publisher-name index for the domain-only 'wsj' family (mirrors
  // singleton — only the publisher NAME resolves here.
  // the #6430 publisher-name indexing in shared/publisher-families.js).
  // The bare feed label "Wall Street Journal" intentionally stays a
  "a16z blog": "a16z",
  "a16z insights": "a16z",
  "a16z podcast": "a16z",
  "acquired episodes": "acquired",
  "acquired podcast": "acquired",
  "acquired": "acquired",
  "andreessen horowitz": "a16z",
  "ap news": "ap-news",
  "ap nuclear": "ap-news",
  "associated press": "ap-news",
  "bbc africa": "bbc",
  "bbc asia": "bbc",
  "bbc hindi": "bbc",
  "bbc latin america": "bbc",
  "bbc middle east": "bbc",
  "bbc mundo": "bbc",
  "bbc northern ireland": "bbc",
  "bbc persian": "bbc",
  "bbc russian": "bbc",
  "bbc science": "bbc",
  "bbc turkce": "bbc",
  "bbc uk": "bbc",
  "bbc world": "bbc",
  "bbc": "bbc",
  "brookings institution": "brookings",
  "brookings tech": "brookings",
  "brookings": "brookings",
  "chatham house tech": "chatham-house",
  "chatham house": "chatham-house",
  "csis tech": "csis",
  "csis": "csis",
  "decoder (verge)": "the-verge",
  "defense news": "sightline-media",
  "deutsche welle": "dw",
  "doe environmental management": "doe",
  "doe nuclear energy": "doe",
  "dw news": "dw",
  "dw turkish": "dw",
  "eia nuclear": "eia",
  "eia press room": "eia",
  "eia reports": "eia",
  "fao giews": "fao",
  "fao news": "fao",
  "fema & emergency management": "fema",
  "fema": "fema",
  "france 24 africa": "france-24",
  "france 24 asia pacific": "france-24",
  "france 24 latam": "france-24",
  "france 24": "france-24",
  "gnn animals": "good-news-network",
  "gnn earth": "good-news-network",
  "gnn health": "good-news-network",
  "gnn heroes spotlight": "good-news-network",
  "gnn heroes": "good-news-network",
  "gnn science": "good-news-network",
  "good news network": "good-news-network",
  "guardian africa": "guardian",
  "guardian americas": "guardian",
  "guardian australia": "guardian",
  "guardian caribbean": "guardian",
  "guardian me": "guardian",
  "guardian pacific": "guardian",
  "guardian science": "guardian",
  "guardian world": "guardian",
  "hacker news": "hacker-news",
  "hard fork (nyt)": "new-york-times",
  "hromadske en": "hromadske",
  "hromadske": "hromadske",
  "iaea news": "iaea",
  "iaea": "iaea",
  "interfax en": "interfax",
  "interfax ru": "interfax",
  "interfax": "interfax",
  "miit (china)": "miit",
  "military times": "sightline-media",
  "ndtv india": "ndtv",
  "ndtv": "ndtv",
  "new york times world": "new-york-times",
  "nikkei asia": "nikkei",
  "nikkei tech": "nikkei",
  "nikkei": "nikkei",
  "nnsa": "doe",
  "nrc event reports": "nrc",
  "nrc news": "nrc",
  "pivot (vox media)": "pivot",
  "pivot (vox)": "pivot",
  "pivot podcast": "pivot",
  "politico tech": "politico",
  "politico": "politico",
  "reuters asia": "reuters",
  "reuters business": "reuters",
  "reuters commodities": "reuters",
  "reuters crypto": "reuters",
  "reuters energy": "reuters",
  "reuters india": "reuters",
  "reuters markets": "reuters",
  "reuters nasdaq futures": "reuters",
  "reuters nuclear": "reuters",
  "reuters science": "reuters",
  "reuters us": "reuters",
  "reuters world": "reuters",
  "reuters": "reuters",
  "rt russia": "rt",
  "rt": "rt",
  "show hn": "hacker-news",
  "sightline media": "sightline-media",
  "the guardian": "guardian",
  "the new york times": "new-york-times",
  "the verge ai": "the-verge",
  "the verge": "the-verge",
  "the vergecast": "the-verge",
  "the white house": "white-house",
  "un food and agriculture organization": "fao",
  "us energy information administration": "eia",
  "verge shows": "the-verge",
  "wall street journal": "wsj",
  "white house actions": "white-house",
  "white house": "white-house",
  "y combinator blog": "y-combinator",
  "y combinator": "y-combinator",
  "yahoo finance commodities": "yahoo-finance",
  "yahoo finance": "yahoo-finance",
  "yc launches": "y-combinator",
  "yc news": "hacker-news",

};

/**
 * Resolve a feed label (or family id, or publisher name) to a curated
 * family id, mirroring publisherFamilyFor's fail-closed contract: exact,
 * then case-insensitive, else the `label:<name>` singleton (which names no
 * domains). A curated family id passes through unchanged.
 *
 * @param {unknown} label
 * @returns {string} '' for blank/non-string input
 */
function familyForLabel(label) {
  if (typeof label !== 'string') return '';
  const trimmed = label.trim();
  if (trimmed.length === 0) return '';
  if (Object.hasOwn(PUBLISHER_LINK_DOMAINS, trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  return PUBLISHER_LINK_LABELS[lower] ?? `label:${lower}`;
}

/**
 * Gate a relay-emitted story link to the item's publisher family domains.
 * Returns the link unchanged when it belongs to the publisher, '' otherwise
 * (fail-closed: the title still alerts, but no hostile link rides along).
 * Unlisted families and empty links both yield '' — an unmapped label is
 * never silently folded into an existing publisher (same fail-closed
 * direction as publisherFamilyFor).
 *
 * `familyId` accepts the curated family id, a feed LABEL (resolved through
 * the label map — the relay only ever sees labels, not family ids), or a
 * `label:` singleton. Unknown labels resolve to their singleton namespace,
 * which names no domains, so they blank — fail-closed.
 *
 * @param {unknown} link the story's article URL
 * @param {unknown} familyOrLabel curated family id or feed label
 * @returns {string}
 */
function gateRelayStoryLink(link, familyOrLabel) {
  if (typeof link !== 'string' || link.length === 0) return '';
  const family = familyForLabel(familyOrLabel);
  if (!family) return '';
  const domains = PUBLISHER_LINK_DOMAINS[family];
  if (!Array.isArray(domains) || domains.length === 0) return '';
  return isPublisherLink(link, domains) ? link : '';
}

module.exports = {
  gateRelayStoryLink,
  familyForLabel,
  PUBLISHER_LINK_DOMAINS,
  PUBLISHER_LINK_LABELS,
  // Exposed for unit tests (contract parity with shared/publisher-link-gate.js).
  normalizeLinkHostname,
  linkHostname,
  isPublisherLink,
};
